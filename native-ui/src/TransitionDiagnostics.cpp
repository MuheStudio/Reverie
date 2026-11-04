#include "TransitionDiagnostics.h"

#ifdef REVERIE_TIMING_DIAGNOSTICS
#include "TimingTrace.h"
#include <QCoreApplication>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QMutex>
#include <QMutexLocker>
#include <QObject>
#include <QPointer>
#include <QQuickWindow>
#include <QSet>
#include <QThread>
#include <QVector>
#include <algorithm>
#include <array>
#include <atomic>
#include <exception>
#include <cstring>
#include <limits>

namespace {
constexpr const char *events[] = {
    "surface-attached", "notification-unavailable", "progress-notification",
    "transition-notification", "transition-identity-notification", "input-eligibility-notification",
    "frame-swapped-boundary", "helper-enter", "helper-exit", "scene-surface-start",
    "tick-rejected", "tick-enter", "step-enter", "ready-poll", "step-complete", "tick-exit",
    "scene-surface-terminal", "capture-begin", "capture-end", "record-frame-appended",
    "recording-terminal", "unknown-event", "stale-observer-notification"
};
enum Event : quint8 {
    SurfaceAttached, NotificationUnavailable, ProgressNotification, TransitionNotification,
    IdentityNotification, EligibilityNotification, FrameBoundary, HelperEnter, HelperExit,
    SurfaceStart, TickRejected, TickEnter, StepEnter, ReadyPoll, StepComplete, TickExit,
    SurfaceTerminal, CaptureBegin, CaptureEnd, FrameAppended, RecordingTerminal, UnknownEvent,
    StaleObserver
};
constexpr const char *propertyNames[] = {"progress", "transitionState", "transitionRevision",
    "pendingMotionRevision", "desiredOpen", "dragging", "inputReady"};
constexpr const char *detailNames[] = {"timeoutMs", "minimumMs", "minimumElapsed",
    "predicateEvaluated", "ready", "elapsedMs", "finished", "inTick", "passed",
    "exceptionUnwinding", "attempt", "slot", "timestampNs", "frame", "sourceValid"};
constexpr int DetailCount = int(std::size(detailNames));
struct SurfaceState {
    quint64 objectIdentity = 0;
    double progress = 0;
    qint64 transitionRevision = 0, pendingMotionRevision = 0;
    quint8 knownMask = 0, state = 0;
    bool objectKnown = false, desiredOpen = false, dragging = false, inputReady = false;
};
struct Surface {
    QPointer<QObject> object;
    std::array<QMetaProperty, std::size(propertyNames)> properties;
    quint64 identity = 0, epoch = 0;
    int featureToken = -1;
};
// Hot paths append only fixed numerical fields into a preallocated vector.
// All map/string serialization happens in snapshot(), after capture has stopped.
struct Record {
    std::array<SurfaceState, 2> surfaces;
    std::array<qint64, DetailCount> details{};
    qint64 timestampNs = 0;
    quint64 sequence = 0, helperId = 0;
    quintptr thread = 0;
    quint32 detailsMask = 0;
    int step = -1, helperDepth = 0;
    int helperToken = -1, controlToken = -1, errorToken = -1, featureToken = -1, propertyToken = -1;
    Event event = UnknownEvent;
    quint8 surfaceCount = 0;
};
struct Collector {
    QMutex mutex;
    QVector<Record> records;
    std::array<Surface, 2> surfaces;
    QVector<QString> tokens, stepNames;
    std::atomic_bool active{false};
    std::size_t capacity = TransitionDiagnostics::RecordCapacity;
    quint64 dropped = 0, nextId = 0, nextHelperId = 0, nextSurfaceId = 0, epoch = 0;
    qint64 startedNs = 0;
    int step = -1;
    quint8 surfaceCount = 0;
    bool recording = false;
};
Collector collector;
thread_local int helperDepth = 0;

bool onGuiThread() {
    const auto *app = QCoreApplication::instance();
    return app && QThread::currentThread() == app->thread();
}
int tokenLocked(const QString &value) {
    if (value.isEmpty())
        return -1;
    const QString limited = value.left(128);
    const int found = collector.tokens.indexOf(limited);
    if (found >= 0)
        return found;
    if (collector.tokens.size() >= 256) {
        ++collector.dropped;
        return -1;
    }
    collector.tokens.append(limited);
    return collector.tokens.size() - 1;
}
int tokenLocked(const char *value) {
    if (!value || !*value)
        return -1;
    for (qsizetype index = 0; index < collector.tokens.size(); ++index)
        if (collector.tokens[index] == QLatin1String(value))
            return int(index);
    return tokenLocked(QString::fromLatin1(value));
}
quint8 stateNumber(const QString &state) {
    for (const auto &entry : {std::pair{"closed", quint8(1)}, {"opening", quint8(2)},
                             {"open", quint8(3)}, {"closing", quint8(4)}, {"dragging", quint8(5)}})
        if (state == QLatin1String(entry.first))
            return entry.second;
    return 0;
}
SurfaceState stateOf(const Surface &surface) {
    SurfaceState state;
    state.objectIdentity = surface.identity;
    state.objectKnown = surface.object && onGuiThread();
    if (!state.objectKnown)
        return state;
    for (std::size_t index = 0; index < surface.properties.size(); ++index) {
        const auto &property = surface.properties[index];
        if (!property.isValid())
            continue;
        const QVariant value = property.read(surface.object);
        if (!value.isValid())
            continue;
        bool known = true;
        switch (index) {
        case 0: state.progress = value.toDouble(&known); break;
        case 1: state.state = stateNumber(value.toString()); known = state.state != 0; break;
        case 2: state.transitionRevision = value.toLongLong(&known); break;
        case 3: state.pendingMotionRevision = value.toLongLong(&known); break;
        case 4: state.desiredOpen = value.toBool(); break;
        case 5: state.dragging = value.toBool(); break;
        case 6: state.inputReady = value.toBool(); break;
        }
        if (known)
            state.knownMask |= quint8(1U << index);
    }
    return state;
}
Record makeRecord(Event event, bool includeState) {
    Record row;
    row.event = event;
    row.timestampNs = TimingTrace::nowNs();
    row.thread = reinterpret_cast<quintptr>(QThread::currentThreadId());
    row.helperDepth = helperDepth;
    // Registry is installed once on the GUI thread before any helper runs.
    // Render-thread records never read GUI objects or the registry.
    if (includeState && onGuiThread()) {
        row.surfaceCount = collector.surfaceCount;
        for (quint8 index = 0; index < row.surfaceCount; ++index)
            row.surfaces[index] = stateOf(collector.surfaces[index]);
    }
    return row;
}
void append(Record row) noexcept {
    if (!collector.active.load(std::memory_order_acquire))
        return;
    QMutexLocker lock(&collector.mutex);
    if (!collector.active.load(std::memory_order_relaxed))
        return;
    row.sequence = ++collector.nextId;
    row.step = collector.step;
    if (static_cast<std::size_t>(collector.records.size()) < collector.capacity)
        collector.records.append(row);
    else
        ++collector.dropped;
}
void numeric(Record &row, int index, qint64 value) {
    row.details[std::size_t(index)] = value;
    row.detailsMask |= quint32(1U << index);
}
void hotPoint(Event event, qint64 attempt, qint64 timestamp, qint64 extra) noexcept {
    if (!collector.active.load(std::memory_order_acquire))
        return;
    try {
        auto row = makeRecord(event, true);
        numeric(row, 10, attempt);
        if (event == CaptureBegin)
            numeric(row, 11, extra);
        else {
            numeric(row, 12, timestamp);
            numeric(row, event == CaptureEnd ? 14 : 13, extra);
        }
        append(row);
    } catch (...) {
        QMutexLocker lock(&collector.mutex);
        ++collector.dropped;
    }
}

class SurfaceObserver final : public QObject {
    Q_OBJECT
  public:
    SurfaceObserver(Surface surface, QObject *owner) : QObject(owner), m_surface(std::move(surface)) {}
    void attach() {
        constexpr const char *slotNames[] = {"progressNotification()", "transitionNotification()",
            "identityNotification()", "identityNotification()", "eligibilityNotification()",
            "eligibilityNotification()", "eligibilityNotification()"};
        for (std::size_t index = 0; index < m_surface.properties.size(); ++index) {
            const auto &property = m_surface.properties[index];
            if (!property.isValid() || !property.hasNotifySignal()) {
                auto row = makeRecord(NotificationUnavailable, false);
                row.featureToken = m_surface.featureToken;
                {
                    QMutexLocker lock(&collector.mutex);
                    row.propertyToken = tokenLocked(QString::fromLatin1(propertyNames[index]));
                }
                append(row);
                continue;
            }
            const int slot = metaObject()->indexOfSlot(slotNames[index]);
            QObject::connect(m_surface.object, property.notifySignal(), this,
                             metaObject()->method(slot), Qt::DirectConnection);
        }
    }
  private slots:
    void progressNotification() noexcept { notification(ProgressNotification); }
    void transitionNotification() noexcept { notification(TransitionNotification); }
    void identityNotification() noexcept { notification(IdentityNotification); }
    void eligibilityNotification() noexcept { notification(EligibilityNotification); }
  private:
    Surface m_surface;
    void notification(Event event) noexcept {
        if (!collector.active.load(std::memory_order_acquire))
            return;
        if (!onGuiThread()) {
            QMutexLocker lock(&collector.mutex);
            ++collector.dropped;
            return;
        }
        try {
            auto row = makeRecord(m_surface.epoch == collector.epoch ? event : StaleObserver, true);
            row.featureToken = m_surface.featureToken;
            append(row);
        } catch (...) {
            QMutexLocker lock(&collector.mutex);
            ++collector.dropped;
        }
    }
};
QVariantMap serializedState(const SurfaceState &state) {
    constexpr const char *states[] = {"unknown", "closed", "opening", "open", "closing", "dragging"};
    QVariantMap result{{"objectIdentity", state.objectIdentity}, {"known", state.objectKnown},
                      {"transitionIdentityKnown", (state.knownMask & 12) == 12}};
    const QVariant values[] = {state.progress, states[state.state], state.transitionRevision,
        state.pendingMotionRevision, state.desiredOpen, state.dragging, state.inputReady};
    for (std::size_t index = 0; index < std::size(propertyNames); ++index)
        if (state.knownMask & (1U << index))
            result[propertyNames[index]] = values[index];
        else
            result[QString::fromLatin1(propertyNames[index]) + "Known"] = false;
    return result;
}
} // namespace

bool TransitionDiagnostics::enabled() noexcept {
    return collector.active.load(std::memory_order_acquire);
}
void TransitionDiagnostics::start(bool recording, std::size_t capacity) {
    QMutexLocker lock(&collector.mutex);
    collector.active.store(false, std::memory_order_release);
    collector.records.clear();
    collector.capacity = std::min(capacity, RecordCapacity);
    collector.records.reserve(qsizetype(collector.capacity));
    collector.tokens.clear();
    collector.tokens.reserve(256);
    collector.stepNames.clear();
    collector.stepNames.reserve(256);
    collector.surfaces = {};
    collector.surfaceCount = 0;
    collector.dropped = collector.nextId = collector.nextHelperId = collector.nextSurfaceId = 0;
    ++collector.epoch;
    collector.startedNs = TimingTrace::nowNs();
    collector.step = -1;
    collector.recording = recording;
    collector.active.store(true, std::memory_order_release);
}
void TransitionDiagnostics::stop() noexcept { collector.active.store(false, std::memory_order_release); }
void TransitionDiagnostics::attachSurface(const QString &feature, QObject *object, QObject *owner) {
    if (!enabled() || !onGuiThread() || !object || !owner)
        return;
    Surface surface;
    surface.object = object;
    const auto *meta = object->metaObject();
    for (std::size_t index = 0; index < std::size(propertyNames); ++index) {
        const int propertyIndex = meta->indexOfProperty(propertyNames[index]);
        if (propertyIndex >= 0)
            surface.properties[index] = meta->property(propertyIndex);
    }
    {
        QMutexLocker lock(&collector.mutex);
        if (collector.surfaceCount >= 2) {
            ++collector.dropped;
            return;
        }
        surface.identity = ++collector.nextSurfaceId;
        surface.epoch = collector.epoch;
        surface.featureToken = tokenLocked(feature);
        collector.surfaces[collector.surfaceCount++] = surface;
    }
    auto *observer = new SurfaceObserver(surface, owner);
    observer->attach();
    auto row = makeRecord(SurfaceAttached, true);
    row.featureToken = surface.featureToken;
    append(row);
}
void TransitionDiagnostics::attachWindow(QQuickWindow *window, QObject *owner) {
    if (!enabled() || !window || !owner)
        return;
    QObject::connect(window, &QQuickWindow::frameSwapped, owner, [] {
        // Emission records a render boundary; it cannot prove movie pixel content.
        if (collector.active.load(std::memory_order_acquire))
            append(makeRecord(FrameBoundary, false));
    }, Qt::DirectConnection);
}
void TransitionDiagnostics::setStep(int index, const QString &name) {
    if (!enabled())
        return;
    QMutexLocker lock(&collector.mutex);
    if (index < 0 || index >= 256) {
        ++collector.dropped;
        return;
    }
    while (collector.stepNames.size() <= index)
        collector.stepNames.append(QString{});
    collector.stepNames[index] = name.left(128);
    collector.step = index;
}
void TransitionDiagnostics::point(const char *event, QVariantMap details, bool includeState) noexcept {
    if (!enabled())
        return;
    try {
        auto row = makeRecord(UnknownEvent, includeState);
        for (std::size_t index = 0; index < std::size(events); ++index)
            if (std::strcmp(event, events[index]) == 0) {
                row.event = Event(index);
                break;
            }
        if (!details.isEmpty()) {
            for (int index = 0; index < DetailCount; ++index)
                if (details.contains(QLatin1String(detailNames[index])))
                    numeric(row, index, details.value(QLatin1String(detailNames[index])).toLongLong());
            QMutexLocker lock(&collector.mutex);
            row.controlToken = tokenLocked(details.value("control").toString());
            row.errorToken = tokenLocked(details.value("error").toString());
            row.featureToken = tokenLocked(details.value("feature").toString());
        }
        append(row);
    } catch (...) {
        QMutexLocker lock(&collector.mutex);
        ++collector.dropped;
    }
}
void TransitionDiagnostics::readyPoll(bool minimumElapsed, bool evaluated, bool ready, qint64 elapsedMs) noexcept {
    if (!enabled())
        return;
    try {
        auto row = makeRecord(ReadyPoll, true);
        numeric(row, 2, minimumElapsed);
        numeric(row, 3, evaluated);
        numeric(row, 4, ready);
        numeric(row, 5, elapsedMs);
        append(row);
    } catch (...) {
        QMutexLocker lock(&collector.mutex);
        ++collector.dropped;
    }
}
void TransitionDiagnostics::captureBegin(quint64 attempt, qint64 slot) noexcept {
    hotPoint(CaptureBegin, qint64(attempt), 0, slot);
}
void TransitionDiagnostics::captureEnd(quint64 attempt, qint64 timestamp, bool valid) noexcept {
    hotPoint(CaptureEnd, qint64(attempt), timestamp, valid);
}
void TransitionDiagnostics::frameAppended(quint64 attempt, quint64 frame, qint64 timestamp) noexcept {
    hotPoint(FrameAppended, qint64(attempt), timestamp, qint64(frame));
}
QVariantMap TransitionDiagnostics::snapshot() {
    QMutexLocker lock(&collector.mutex);
    QVariantList records;
    records.reserve(collector.records.size());
    QSet<quint64> openHelpers;
    QSet<qint64> openCaptures;
    quint64 unmatchedEnds = 0;
    bool surfaceTerminal = false, recordingTerminal = !collector.recording;
    const auto token = [](int value) {
        return value >= 0 && value < collector.tokens.size() ? collector.tokens[value] : QString();
    };
    for (const auto &row : collector.records) {
        if (row.event == HelperEnter)
            openHelpers.insert(row.helperId);
        else if (row.event == HelperExit && !openHelpers.remove(row.helperId))
            ++unmatchedEnds;
        else if (row.event == CaptureBegin)
            openCaptures.insert(row.details[10]);
        else if (row.event == CaptureEnd && !openCaptures.remove(row.details[10]))
            ++unmatchedEnds;
        surfaceTerminal |= row.event == SurfaceTerminal;
        recordingTerminal |= row.event == RecordingTerminal;
        QVariantMap details;
        for (int index = 0; index < DetailCount; ++index)
            if (row.detailsMask & (1U << index))
                details[detailNames[index]] = row.details[std::size_t(index)];
        if (row.helperId)
            details["helperId"] = row.helperId;
        for (const auto &entry : {std::pair{"helper", row.helperToken}, {"control", row.controlToken},
                                 {"error", row.errorToken}, {"feature", row.featureToken},
                                 {"property", row.propertyToken}})
            if (entry.second >= 0)
                details[entry.first] = token(entry.second);
        QVariantMap states;
        for (quint8 index = 0; index < row.surfaceCount; ++index)
            states[token(collector.surfaces[index].featureToken)] = serializedState(row.surfaces[index]);
        records.append(QVariantMap{{"event", events[row.event]}, {"timestampNs", row.timestampNs},
            {"thread", QString::number(row.thread, 16)}, {"helperDepth", row.helperDepth},
            {"sequence", row.sequence}, {"stepIndex", row.step},
            {"step", row.step >= 0 && row.step < collector.stepNames.size() ? collector.stepNames[row.step] : QString()},
            {"surfaces", states}, {"details", details}});
    }
    return {{"schema", "reverie.qt.transition-diagnostics.v1"}, {"compiled", true},
            {"enabled", collector.active.load()}, {"recording", collector.recording},
            {"clock", "std::chrono::steady_clock nanoseconds since epoch; shared with TimingTrace"},
            {"startedNs", collector.startedNs}, {"capacity", quint64(collector.capacity)},
            {"droppedRecords", collector.dropped},
            {"complete", collector.dropped == 0 && openHelpers.isEmpty() && openCaptures.isEmpty() &&
                         unmatchedEnds == 0 && surfaceTerminal && recordingTerminal},
            {"openHelpers", openHelpers.size()}, {"openCaptures", openCaptures.size()},
            {"unmatchedEnds", unmatchedEnds}, {"surfaceTerminalObserved", surfaceTerminal},
            {"recordingTerminalObserved", recordingTerminal},
            {"midProgressInterval", QVariantMap{{"lowerExclusive", .23}, {"upperExclusive", .96}}},
            {"stepTimeoutMs", 2500}, {"notificationsDriveInput", false},
            {"renderBoundaryProvesRecordedState", false}, {"records", records}};
}
TransitionDiagnostics::HelperScope::HelperScope(const char *helper, QVariantMap details) noexcept
    : m_uncaught(std::uncaught_exceptions()) {
    if (!enabled())
        return;
    try {
        auto row = makeRecord(HelperEnter, true);
        {
            QMutexLocker lock(&collector.mutex);
            row.helperToken = m_helperToken = tokenLocked(helper);
            if (!details.isEmpty()) {
                row.controlToken = tokenLocked(details.value("control").toString());
                row.featureToken = tokenLocked(details.value("feature").toString());
            }
            m_epoch = collector.epoch;
            m_id = ++collector.nextHelperId;
        }
        ++helperDepth;
        row.helperDepth = helperDepth;
        row.helperId = m_id;
        append(row);
    } catch (...) {
        QMutexLocker lock(&collector.mutex);
        ++collector.dropped;
    }
}
TransitionDiagnostics::HelperScope::~HelperScope() noexcept {
    if (!m_id)
        return;
    try {
        auto row = makeRecord(HelperExit, true);
        row.helperId = m_id;
        numeric(row, 9, std::uncaught_exceptions() > m_uncaught);
        row.helperToken = m_helperToken;
        if (m_epoch != collector.epoch)
            row.event = StaleObserver;
        append(row);
    } catch (...) {
        QMutexLocker lock(&collector.mutex);
        ++collector.dropped;
    }
    --helperDepth;
}
#include "TransitionDiagnostics.moc"
#endif
