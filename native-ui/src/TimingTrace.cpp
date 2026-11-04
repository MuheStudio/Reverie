#include "TimingTrace.h"

#ifdef REVERIE_TIMING_DIAGNOSTICS
#include <QAbstractEventDispatcher>
#include <QCoreApplication>
#include <QDateTime>
#include <QEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMetaEnum>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QPointer>
#include <QSocketNotifier>
#include <QThread>
#include <algorithm>
#include <array>
#include <atomic>
#include <cerrno>
#include <exception>
#include <fcntl.h>
#include <memory>
#include <sys/socket.h>
#include <sys/stat.h>
#include <thread>
#include <unistd.h>

class TimingReadingCounterObserver final : public QObject {
    Q_OBJECT
public:
    TimingReadingCounterObserver(QObject *source, QObject *owner) : QObject(owner), m_source(source) {}
    void record(int index) noexcept {
        if (!TimingTrace::metaCallContextEnabled() || !TimingTrace::enabled()) return;
        static constexpr std::array<const char *, 3> names{
            "restoreRequestCount", "restoreExecutionCount", "forceLayoutCount"};
        bool readable = false;
        const auto value = m_source ? m_source->property(names[index]) : QVariant();
        const auto count = value.toLongLong(&readable);
        TimingTrace::point(TimingTrace::Kind::ReadingRestoreCounter, index,
            value.isValid() && !value.isNull() && readable && count >= 0 ? count : -1);
    }
private slots:
    void requestChanged() { record(0); }
    void executionChanged() { record(1); }
    void layoutChanged() { record(2); }
private:
    QPointer<QObject> m_source;
};

namespace TimingTrace {
namespace {
constexpr std::size_t Capacity = RecordCapacity;
constexpr int StackCapacity = 64;
constexpr int ReceiverNodeCapacity = 5;
constexpr int ClassNameCapacity = 80;
struct ReceiverNode {
    std::array<char, ClassNameCapacity> className{};
    ReceiverRole role = ReceiverRole::Unknown;
    bool classKnown = false, classTruncated = false;
};
struct ReceiverContext {
    qint64 ns = 0;
    quint64 span = 0, thread = 0;
    int phase = -1, input = -1, nodes = 0;
    bool parentChainTruncated = false, metadataError = false;
    std::array<ReceiverNode, ReceiverNodeCapacity> chain{};
};
// Only the GUI thread writes these entries. No QObject survives in a captured row.
struct ReceiverContexts {
    bool requested = false;
    std::size_t limit = MetaCallContextCapacity, count = 0;
    quint64 dropped = 0;
    std::array<ReceiverContext, MetaCallContextCapacity> entries{};
    std::array<QPointer<QObject>, std::size_t(ReceiverRole::Count)> roles{};
};
ReceiverContexts &receiverContexts() { static ReceiverContexts value; return value; }
constexpr std::array<const char *, std::size_t(ReceiverRole::Count)> RoleNames{
    "unknown", "window", "sceneDirector", "chatPanel", "chatHistory", "chatComposer",
    "runtimeBridge", "archiveEditor", "nativeAvatar"};
constexpr std::array<const char *, 3> RestoreProperties{
    "restoreRequestCount", "restoreExecutionCount", "forceLayoutCount"};
bool guiThread() noexcept {
    auto *application = QCoreApplication::instance();
    return application && QThread::currentThread() == application->thread();
}
void copyClassName(ReceiverNode &node, const char *name) noexcept {
    if (!name || !name[0]) return;
    for (int i = 0; i < ClassNameCapacity; ++i) {
        const auto c = static_cast<unsigned char>(name[i]);
        if (!c) { node.classKnown = true; return; }
        if (!((c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z')
                || (c >= '0' && c <= '9') || c == '_' || c == ':')) {
            node.className = {}; return;
        }
        if (i == ClassNameCapacity - 1) {
            node.classKnown = true; node.classTruncated = true; return;
        }
        node.className[i] = char(c);
    }
}
enum class Edge : quint8 { Point, Begin, End };
struct Record {
    qint64 ns = 0, a = 0, b = 0;
    quint64 span = 0, parent = 0, thread = 0;
    int phase = -1, input = -1;
    Kind kind = Kind::NotifyEvent;
    Edge edge = Edge::Point;
    bool error = false;
    bool isGui = false;
};
struct Slot { Record record; std::atomic<bool> published{false}; };
struct State {
    std::array<Slot, Capacity> entries{};
    std::atomic<bool> running{false};
    std::atomic<quint64> epoch{0}, next{0}, nextSpan{1}, nextThread{1}, context{~quint64(0)};
    std::atomic<quint64> dropped{0}, stackOverflows{0}, orderErrors{0}, errors{0};
    std::atomic<quint64> omittedPoints{0}, omittedStarts{0}, omittedEnds{0}, stoppedEnds{0};
    std::atomic<quint64> writers{0};
    std::atomic<quint64> guiThreadId{0};
    std::atomic<qint64> started{0}, stopped{0}, cutoff{0};
    std::size_t limit = Capacity;
};
State &state() { static State value; return value; }
struct ThreadState {
    quint64 epoch = 0, id = 0;
    int depth = 0;
    std::array<quint64, StackCapacity> stack{};
};
thread_local ThreadState local;
void prepareThread(State &s) noexcept {
    const auto epoch = s.epoch.load(std::memory_order_acquire);
    if (local.epoch != epoch) {
        local = {};
        local.epoch = epoch;
        local.id = s.nextThread.fetch_add(1, std::memory_order_relaxed);
        if (auto *application = QCoreApplication::instance(); application && QThread::currentThread() == application->thread())
            s.guiThreadId.store(local.id, std::memory_order_release);
    }
}
bool afterCutoff(State &s, qint64 now) noexcept {
    const auto cutoff = s.cutoff.load(std::memory_order_relaxed);
    return cutoff > 0 && now > cutoff;
}
bool append(Record record) noexcept {
    auto &s = state();
    if (!s.running.load(std::memory_order_acquire))
        return false;
    s.writers.fetch_add(1, std::memory_order_acq_rel);
    if (!s.running.load(std::memory_order_acquire)) {
        s.writers.fetch_sub(1, std::memory_order_release);
        return false;
    }
    const auto index = s.next.fetch_add(1, std::memory_order_relaxed);
    if (index < s.limit) {
        const auto context = s.context.load(std::memory_order_relaxed);
        record.phase = qint32(context >> 32);
        record.input = qint32(context & 0xffffffffu);
        record.isGui = record.thread == s.guiThreadId.load(std::memory_order_acquire);
        s.entries[index].record = record;
        s.entries[index].published.store(true, std::memory_order_release);
    } else {
        s.dropped.fetch_add(1, std::memory_order_relaxed);
    }
    s.writers.fetch_sub(1, std::memory_order_release);
    return index < s.limit;
}
constexpr std::array<const char *, std::size_t(Kind::Count)> KindNames{
    "TimeoutArrival", "TimeoutRejected", "WorkTick", "MouseMove", "WheelEvent",
    "PhaseClose", "CadenceStop", "PhasePropertyClear", "SetPhaseLockWait", "SetPhaseAssignment",
    "BeforeSync", "AfterSync", "BeforeRender", "AfterRender", "FrameSwapped",
    "NotifyEvent", "DispatcherAwake", "DispatcherAboutToBlock", "PhaseReady", "ControlAck",
    "PhaseStarted", "TargetPhaseDone", "PhaseEnded", "InputDispatch", "ClockAnchor", "Finished",
    "ReadingRestoreCounter"};

class Control final {
public:
    QPointer<QSocketNotifier> notifier;
    int fd = -1, phase = -1;
    QString diagnosticCase, protocol, error;
    int rows = 0;
    bool readySent = false, acknowledged = false, targetDone = false, flushed = false;
    qint64 readyNs = 0, flushWaitNs = 0;
    std::array<char, 4096> buffer{};
    std::size_t used = 0;
    ~Control() { if (fd >= 0) ::close(fd); }
    void reject(const QString &reason) {
        if (error.isEmpty()) error = reason;
        if (notifier) notifier->setEnabled(false);
    }
    bool send(const char *type, int selectedPhase, qint64 unixMs, bool passed = false) {
        if (fd < 0) return true;
        QJsonObject value{{"type", type}, {"case", diagnosticCase}, {"protocol", protocol},
            {"rows", rows}, {"phase", selectedPhase}, {"absoluteNs", QString::number(nowNs())},
            {"unixMs", double(unixMs)}};
        if (QByteArray(type) == "phase-ended" || QByteArray(type) == "target-phase-done")
            value["passed"] = passed;
        if (QByteArray(type) == "target-phase-done") value["postrollLimitMs"] = 2000;
        const auto bytes = QJsonDocument(value).toJson(QJsonDocument::Compact) + '\n';
        ssize_t sent;
        do { sent = ::write(fd, bytes.constData(), std::size_t(bytes.size())); } while (sent < 0 && errno == EINTR);
        if (sent != bytes.size()) { reject("TIMING_CONTROL_WRITE_FAILED"); return false; }
        return true;
    }
    void receive() {
        for (;;) {
            if (used == buffer.size()) { reject("TIMING_CONTROL_LINE_TOO_LONG"); return; }
            const auto count = ::read(fd, buffer.data() + used, buffer.size() - used);
            if (count < 0 && errno == EINTR) continue;
            if (count < 0 && (errno == EAGAIN || errno == EWOULDBLOCK)) return;
            if (count <= 0) { reject("TIMING_CONTROL_EOF_OR_READ_FAILED"); return; }
            used += std::size_t(count);
            auto newline = std::find(buffer.begin(), buffer.begin() + used, '\n');
            while (newline != buffer.begin() + used) {
                const auto length = std::size_t(newline - buffer.begin());
                QJsonParseError parse;
                const auto document = QJsonDocument::fromJson(QByteArray(buffer.data(), qsizetype(length)), &parse);
                const auto value = document.object();
                const auto type = value.value("type").toString();
                if (parse.error != QJsonParseError::NoError || !document.isObject() || value.size() != 3
                        || value.value("case").toString() != diagnosticCase
                        || !value.value("phase").isDouble() || value.value("phase").toDouble() != phase) {
                    reject("TIMING_CONTROL_INVALID_ACK"); return;
                }
                if (type == "phase-go" && readySent && !acknowledged && !targetDone) {
                    acknowledged = true;
                    point(Kind::ControlAck, phase, 1);
                } else if (type == "phase-flushed" && targetDone && !flushed) {
                    flushed = true;
                    point(Kind::ControlAck, phase, 2);
                } else {
                    reject("TIMING_CONTROL_UNEXPECTED_OR_REPLAYED_ACK"); return;
                }
                const auto remaining = used - length - 1;
                std::move(buffer.begin() + length + 1, buffer.begin() + used, buffer.begin());
                used = remaining;
                newline = std::find(buffer.begin(), buffer.begin() + used, '\n');
            }
        }
    }
};
std::unique_ptr<Control> control;
QPointer<QObject> observedWindow;
} // namespace

bool enabled() noexcept { return state().running.load(std::memory_order_acquire); }
void start(std::size_t recordLimit) {
    auto &s = state();
    stop();
    while (s.writers.load(std::memory_order_acquire)) std::this_thread::yield();
    s.limit = std::min(recordLimit, Capacity);
    for (auto &slot : s.entries) slot.published.store(false, std::memory_order_relaxed);
    s.next = 0; s.nextSpan = 1; s.nextThread = 1; s.guiThreadId = 0;
    s.dropped = 0; s.stackOverflows = 0; s.orderErrors = 0; s.errors = 0;
    s.omittedPoints = 0; s.omittedStarts = 0; s.omittedEnds = 0; s.stoppedEnds = 0;
    s.cutoff = 0; s.stopped = 0; s.started = nowNs();
    auto &contexts = receiverContexts();
    contexts.count = 0; contexts.dropped = 0;
    for (auto &role : contexts.roles) role.clear();
    s.epoch.fetch_add(1, std::memory_order_acq_rel);
    s.running.store(true, std::memory_order_release);
}
void stop() noexcept {
    auto &s = state();
    if (s.running.exchange(false, std::memory_order_acq_rel)) s.stopped = nowNs();
}
void setCutoffNs(qint64 cutoff) noexcept { state().cutoff.store(cutoff, std::memory_order_release); }
void setContext(int phase, int input) noexcept {
    state().context.store((quint64(quint32(phase)) << 32) | quint32(input), std::memory_order_release);
}
void setMetaCallContextEnabled(bool requested, std::size_t limit) noexcept {
    auto &contexts = receiverContexts();
    contexts.requested = requested;
    contexts.limit = std::min(limit, MetaCallContextCapacity);
}
bool metaCallContextEnabled() noexcept { return receiverContexts().requested; }
bool metaCallContextComplete() noexcept { return receiverContexts().dropped == 0; }
void setReceiverRole(ReceiverRole role, QObject *receiver) {
    const auto index = std::size_t(role);
    if (!metaCallContextEnabled() || !guiThread() || index == 0 || index >= RoleNames.size()) return;
    receiverContexts().roles[index] = receiver;
}
quint8 observeReadingRestoreCounters(QObject *chat, QObject *owner) {
    if (!chat || !owner || !metaCallContextEnabled() || !guiThread()) return 0;
    auto *observer = new TimingReadingCounterObserver(chat, owner);
    constexpr std::array<const char *, 3> slotNames{"requestChanged()", "executionChanged()", "layoutChanged()"};
    quint8 connected = 0;
    const auto *meta = chat->metaObject();
    for (int index = 0; index < int(RestoreProperties.size()); ++index) {
        const auto propertyIndex = meta ? meta->indexOfProperty(RestoreProperties[index]) : -1;
        if (propertyIndex >= 0) {
            const auto property = meta->property(propertyIndex);
            if (property.hasNotifySignal() && QObject::connect(chat, property.notifySignal(), observer,
                    observer->metaObject()->method(observer->metaObject()->indexOfSlot(slotNames[index])), Qt::DirectConnection))
                connected |= quint8(1u << index);
        }
        observer->record(index);
    }
    return connected;
}
void Scope::captureMetaCallReceiver(QObject *receiver) noexcept {
    if (!m_beginRecorded || m_kind != Kind::NotifyEvent || m_a != int(QEvent::MetaCall)
            || !metaCallContextEnabled() || !guiThread()) return;
    auto &contexts = receiverContexts();
    if (contexts.count == contexts.limit) { ++contexts.dropped; return; }
    ReceiverContext context;
    context.ns = nowNs(); context.span = m_span; context.thread = local.id;
    const auto active = state().context.load(std::memory_order_relaxed);
    context.phase = qint32(active >> 32); context.input = qint32(active & 0xffffffffu);
    try {
        auto *current = receiver;
        while (current && context.nodes < ReceiverNodeCapacity) {
            auto &node = context.chain[context.nodes++];
            if (const auto *meta = current->metaObject()) copyClassName(node, meta->className());
            for (std::size_t role = 1; role < contexts.roles.size(); ++role)
                if (contexts.roles[role] == current) { node.role = ReceiverRole(role); break; }
            current = current->parent();
        }
        context.parentChainTruncated = current != nullptr;
    } catch (...) {
        // Metadata observation must never alter delivery's return or exception.
        context.metadataError = true;
    }
    contexts.entries[contexts.count++] = context;
}
void point(Kind kind, qint64 a, qint64 b) noexcept {
    auto &s = state();
    if (!s.running.load(std::memory_order_acquire)) return;
    const auto now = nowNs();
    if (afterCutoff(s, now)) { ++s.omittedPoints; return; }
    prepareThread(s);
    append({now, a, b, 0, local.depth ? local.stack[local.depth - 1] : 0,
            local.id, -1, -1, kind, Edge::Point, false});
}
Scope::Scope(Kind kind, qint64 a, qint64 b) noexcept {
    auto &s = state();
    if (!s.running.load(std::memory_order_acquire)) return;
    const auto now = nowNs();
    if (afterCutoff(s, now)) { ++s.omittedStarts; return; }
    prepareThread(s);
    if (local.depth == StackCapacity) { ++s.stackOverflows; return; }
    m_epoch = local.epoch; m_kind = kind; m_a = a; m_b = b;
    m_parent = local.depth ? local.stack[local.depth - 1] : 0;
    m_span = s.nextSpan.fetch_add(1, std::memory_order_relaxed);
    m_depth = local.depth;
    m_uncaught = std::uncaught_exceptions();
    local.stack[local.depth++] = m_span;
    m_beginRecorded = append({now, a, b, m_span, m_parent, local.id, -1, -1, kind, Edge::Begin, false});
}
Scope::~Scope() noexcept {
    if (!m_span) return;
    auto &s = state();
    if (local.epoch != m_epoch || s.epoch.load(std::memory_order_acquire) != m_epoch) return;
    if (local.depth != m_depth + 1 || local.stack[m_depth] != m_span) ++s.orderErrors;
    local.stack[m_depth] = 0;
    while (local.depth && !local.stack[local.depth - 1]) --local.depth;
    if (!m_beginRecorded) return;
    const auto now = nowNs();
    if (afterCutoff(s, now)) { ++s.omittedEnds; return; }
    if (!s.running.load(std::memory_order_acquire)) { ++s.stoppedEnds; return; }
    const bool error = m_failed || std::uncaught_exceptions() > m_uncaught;
    if (append({now, m_a, m_b, m_span, m_parent, local.id, -1, -1, m_kind, Edge::End, error}) && error)
        ++s.errors;
}
QJsonObject snapshot() {
    auto &s = state();
    QJsonArray records, names;
    QJsonObject eventTypes;
    const auto eventEnum = QMetaEnum::fromType<QEvent::Type>();
    quint64 begins = 0, ends = 0, unpublished = 0;
    const auto count = std::min<quint64>(s.next.load(std::memory_order_acquire), s.limit);
    const auto started = s.started.load(std::memory_order_acquire);
    for (quint64 index = 0; index < count; ++index) {
        if (!s.entries[index].published.load(std::memory_order_acquire)) { ++unpublished; continue; }
        const auto &r = s.entries[index].record;
        begins += r.edge == Edge::Begin; ends += r.edge == Edge::End;
        if (r.kind == Kind::NotifyEvent) {
            const auto *name = eventEnum.valueToKey(int(r.a));
            eventTypes[QString::number(r.a)] = name ? QString::fromLatin1(name) : QStringLiteral("UnknownEventType");
        }
        records.append(QJsonObject{{"elapsedNs", double(r.ns - started)}, {"kind", int(r.kind)},
            {"edge", int(r.edge)}, {"spanId", double(r.span)}, {"parentSpanId", double(r.parent)},
            {"threadId", double(r.thread)}, {"isGui", r.isGui}, {"phase", r.phase}, {"input", r.input},
            {"a", double(r.a)}, {"b", double(r.b)}, {"error", r.error}});
    }
    for (const auto *name : KindNames) names.append(QString::fromLatin1(name));
    const auto number = [](const auto &value) { return double(value.load(std::memory_order_acquire)); };
    const bool essentialFailure = s.dropped || s.stackOverflows || s.orderErrors || unpublished;
    QJsonObject result{{"schema", "reverie.qt.timing-trace.v1"}, {"compiled", true}, {"enabled", enabled()},
        {"clockOrigin", "absolute-steady-clock"}, {"startedNs", QString::number(started)},
        {"stoppedNs", QString::number(s.stopped.load())}, {"cutoffNs", QString::number(s.cutoff.load())},
        {"recordCapacity", double(s.limit)}, {"recordCount", records.size()}, {"claimedRecords", double(count)},
        {"guiThreadId", number(s.guiThreadId)}, {"observedWindowConfigured", bool(observedWindow)},
        {"droppedRecords", number(s.dropped)}, {"stackOverflows", number(s.stackOverflows)},
        {"spanOrderErrors", number(s.orderErrors)}, {"errorSpans", number(s.errors)},
        {"observedExceptionSpans", number(s.errors)},
        {"incompleteSpans", double(begins - ends)}, {"unpublishedRecords", double(unpublished)},
        {"cutoffOmittedPoints", number(s.omittedPoints)}, {"cutoffOmittedSpanStarts", number(s.omittedStarts)},
        {"cutoffOmittedSpanEnds", number(s.omittedEnds)}, {"stoppedOmittedSpanEnds", number(s.stoppedEnds)},
        {"essentialFailure", essentialFailure}, {"kindNames", names}, {"eventTypeNames", eventTypes},
        {"notifyEventFields", QJsonObject{{"a", "QEvent::Type enum code; eventTypeNames maps observed codes"},
            {"b", "1 only for the observed QQuickWindow receiver; 0 otherwise"},
            {"thread", "GUI thread only; guiThreadId and records.isGui identify it"}}},
        {"exceptionScope", "errorSpans/observedExceptionSpans count failed code scopes, including caught constraint exceptions or explicit fail(), not unique exceptions or collector corruption. Case collectionComplete determines whether a known contract failure was successfully observed"},
        {"records", records},
        {"scope", "Numeric bounded observations of existing code; no QtTest implementation copy, key codes, event text or credentials. Missing ends after cutoff/stop remain unknown, never synthesized. Recorder overhead is diagnostic-only"}};
    const auto &contexts = receiverContexts();
    if (contexts.requested) {
        QJsonArray rows;
        for (std::size_t i = 0; i < contexts.count; ++i) {
            const auto &context = contexts.entries[i];
            QJsonArray chain;
            for (int j = 0; j < context.nodes; ++j) {
                const auto &node = context.chain[j];
                chain.append(QJsonObject{{"className", node.classKnown ? QJsonValue(QString::fromLatin1(node.className.data())) : QJsonValue(QJsonValue::Null)},
                    {"classNameTruncated", node.classTruncated}, {"role", RoleNames[std::size_t(node.role)]},
                    {"roleKnown", node.role != ReceiverRole::Unknown}});
            }
            rows.append(QJsonObject{{"spanId", double(context.span)}, {"threadId", double(context.thread)},
                {"phase", context.phase}, {"input", context.input}, {"elapsedNs", double(context.ns - started)},
                {"chain", chain}, {"parentChainTruncated", context.parentChainTruncated},
                {"metadataError", context.metadataError}});
        }
        result["metaCallContext"] = QJsonObject{{"schema", "reverie.qt.metacall-context.v1"}, {"requested", true},
            {"complete", metaCallContextComplete()},
            {"capacity", double(contexts.limit)}, {"recordCount", rows.size()}, {"droppedContexts", double(contexts.dropped)},
            {"parentNodeLimit", ReceiverNodeCapacity - 1}, {"classNameByteLimit", ClassNameCapacity - 1},
            {"records", rows}, {"scope", "GUI MetaCall receiver and at most four QObject parents copied before notify forwarding using public metaObject/parent interfaces. Roles use a fixed identity whitelist, never objectName or sender. No private MetaCall payload or post-delivery receiver access. Unknown roles, truncated chains, absent metadata and buffer overflow remain unknown; no callback identity or native source stack is inferred."}};
    }
    return result;
}
bool configureControl(QObject *owner, int fd, const QString &diagnosticCase, const QString &protocol, int rows) {
    if (control) return false;
    auto value = std::make_unique<Control>();
    value->diagnosticCase = diagnosticCase; value->protocol = protocol; value->rows = rows;
    if (fd >= 0) {
        struct stat info{}; int type = 0; socklen_t size = sizeof(type);
        sockaddr_storage address{}; socklen_t addressSize = sizeof(address);
        if (!owner || fd != 4 || ::fstat(fd, &info) || !S_ISSOCK(info.st_mode) || info.st_uid != ::geteuid()
                || ::getsockopt(fd, SOL_SOCKET, SO_TYPE, &type, &size) || type != SOCK_STREAM
                || ::getsockname(fd, reinterpret_cast<sockaddr *>(&address), &addressSize) || address.ss_family != AF_UNIX)
            return false;
        const auto flags = ::fcntl(fd, F_GETFL);
        const auto descriptorFlags = ::fcntl(fd, F_GETFD);
        // Keep the inherited observer channel out of subsequently exec'd
        // backend children; the owning GUI process retains this same socket.
        if (flags < 0 || descriptorFlags < 0 || ::fcntl(fd, F_SETFL, flags | O_NONBLOCK) < 0
                || ::fcntl(fd, F_SETFD, descriptorFlags | FD_CLOEXEC) < 0) return false;
        value->fd = fd;
        value->notifier = new QSocketNotifier(fd, QSocketNotifier::Read, owner);
        QObject::connect(value->notifier, &QSocketNotifier::activated, owner, [channel = value.get()] { channel->receive(); });
    }
    control = std::move(value);
    return true;
}
void setObservedWindow(QObject *window) {
    observedWindow = window && window->inherits("QQuickWindow") ? window : nullptr;
}
bool controlReady(int phase) {
    if (!control || control->fd < 0) return true;
    if (!control->error.isEmpty()) return false;
    if (control->phase != phase || !control->readySent) return false;
    if (!control->acknowledged && nowNs() - control->readyNs > 15000000000LL)
        control->reject("TIMING_CONTROL_GO_TIMEOUT");
    return control->acknowledged && control->error.isEmpty();
}
bool phaseReady(int phase) {
    if (!control) return true;
    if (!control->error.isEmpty()) return false;
    if (!control->readySent) {
        control->phase = phase; control->readyNs = nowNs(); control->readySent = true;
        point(Kind::PhaseReady, phase);
        control->send("phase-ready", phase, QDateTime::currentMSecsSinceEpoch());
    }
    return controlReady(phase);
}
bool finishReady(int phase) {
    if (!control || control->fd < 0) return true;
    if (!control->error.isEmpty() || control->phase != phase || !control->targetDone) return false;
    if (!control->flushWaitNs) control->flushWaitNs = nowNs();
    if (!control->flushed && nowNs() - control->flushWaitNs > 15000000000LL)
        control->reject("TIMING_CONTROL_FLUSH_TIMEOUT");
    return control->flushed && control->error.isEmpty();
}
QString controlError() { return control ? control->error : QString(); }
void phaseStarted(int phase, qint64 unixMs) {
    point(Kind::PhaseStarted, phase);
    if (control) control->send("phase-started", phase, unixMs);
}
void targetPhaseDone(int phase, qint64 unixMs, bool passed) {
    point(Kind::TargetPhaseDone, phase, passed);
    if (control) { control->targetDone = true; control->send("target-phase-done", phase, unixMs, passed); }
}
void phaseEnded(int phase, qint64 unixMs, bool passed) {
    point(Kind::PhaseEnded, phase, passed);
    if (control) control->send("phase-ended", phase, unixMs, passed);
}
} // namespace TimingTrace

TimingGuiApplication::TimingGuiApplication(int &argc, char **argv) : QGuiApplication(argc, argv) {
    if (auto *dispatcher = QAbstractEventDispatcher::instance(thread())) {
        QObject::connect(dispatcher, &QAbstractEventDispatcher::awake, this,
            [] { TimingTrace::point(TimingTrace::Kind::DispatcherAwake); }, Qt::DirectConnection);
        QObject::connect(dispatcher, &QAbstractEventDispatcher::aboutToBlock, this,
            [] { TimingTrace::point(TimingTrace::Kind::DispatcherAboutToBlock); }, Qt::DirectConnection);
    }
}
bool TimingGuiApplication::notify(QObject *receiver, QEvent *event) {
    if (QThread::currentThread() != thread())
        return QGuiApplication::notify(receiver, event);
    return TimingTrace::observeNotification(receiver, event ? int(event->type()) : -1,
        receiver == TimingTrace::observedWindow, [this, receiver, event] {
            return QGuiApplication::notify(receiver, event);
        });
}
#include "TimingTrace.moc"
#endif
