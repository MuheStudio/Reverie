#if defined(REVERIE_TIMING_DIAGNOSTICS) || defined(REVERIE_QML_PROFILER)
#include "SmoothnessCheck.h"
#endif
#include "PerfScenarioCheck.h"
#include "HeaderFrameLocalCheck.h"
#include "../src/ArchiveEditor.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include "../src/TimingTrace.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJSValue>
#include <QLineF>
#include <QMutex>
#include <QMutexLocker>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QTest>
#include <QTimer>
#include <QVector2D>
#include <QtTest/qtestwheel.h>
#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>
#include <memory>
#include <stdexcept>
#include <sys/resource.h>
#include <utility>

namespace {
constexpr int ActiveMs = 30000;
constexpr int IdleMs = 10000;
constexpr int MinimumActiveIntervals = 300;
constexpr int SampleCapacity = 65536;
constexpr int InputCapacity = 4096;
constexpr int TotalDeadlineMs = 420000;
constexpr int TransactionDeadlineMs = 15000;
constexpr int SupplementalPhaseDeadlineMs = 600000;
constexpr int SupplementalTotalDeadlineMs = 1800000;
constexpr int BoundaryCapacity = 262144;
constexpr int HumanPauseMs = 150;
using Action = std::function<void()>;
using Predicate = std::function<bool()>;
const std::array<QString, 3> ReplyPrompts{QStringLiteral("性能短回复"),
    QStringLiteral("性能长回复"), QStringLiteral("性能延迟回复")};
const std::array<const char *, 3> RestoreCounterNames{
    "restoreRequestCount", "restoreExecutionCount", "forceLayoutCount"};

// Durable row evidence is scoped to the request, because the history page keeps
// its existing 300-row cap and may evict older fixture rows after a new reply.
QVariantMap committedReplyEvidence(const QVariantList &messages, const QString &prompt,
                                    const QString &requestId) {
    int promptUsers = 0, requestUsers = 0, requestAssistants = 0, assistantCharacters = 0;
    bool acceptedUser = true, persistedAssistants = true, exactUserText = true;
    QString userMessageId;
    QStringList assistantMessageIds;
    for (const auto &value : messages) {
        const auto row = value.toMap();
        const auto role = row.value("role").toString();
        const auto content = row.value("content").toString();
        if (role == "user" && content == prompt)
            ++promptUsers;
        if (requestId.isEmpty() || row.value("request_id").toString() != requestId)
            continue;
        const auto id = row.value("id").toString();
        if (role == "user") {
            ++requestUsers;
            userMessageId = id;
            exactUserText &= content == prompt;
            acceptedUser &= row.value("delivery_state").toString() == "accepted"
                && !id.isEmpty() && id != requestId && !id.startsWith("pending_user_");
        } else if (role == "assistant") {
            ++requestAssistants;
            assistantMessageIds.append(id);
            assistantCharacters += content.size();
            persistedAssistants &= row.value("delivery_state").toString() == "ready_waiting"
                && !id.isEmpty() && id != requestId && !content.isEmpty();
        }
    }
    const bool complete = !requestId.isEmpty() && promptUsers == 1 && requestUsers == 1
        && requestAssistants == 1 && exactUserText && acceptedUser && persistedAssistants
        && assistantCharacters > 0 && assistantMessageIds.first() != userMessageId;
    return {{"prompt", prompt}, {"requestId", requestId}, {"exactPromptUserRows", promptUsers},
        {"requestUserRows", requestUsers}, {"requestAssistantRows", requestAssistants},
        {"userMessageId", userMessageId}, {"assistantMessageIds", assistantMessageIds},
        {"userAccepted", acceptedUser && requestUsers > 0},
        {"assistantPersisted", persistedAssistants && requestAssistants > 0},
        {"assistantCharacters", assistantCharacters}, {"complete", complete}};
}

void require(bool condition, const QString &reason) {
    if (!condition)
        throw std::runtime_error(reason.toStdString());
}
QVariantMap mapValue(const QVariant &value) {
    return value.metaType() == QMetaType::fromType<QJSValue>()
               ? value.value<QJSValue>().toVariant().toMap() : value.toMap();
}
QQuickItem *visualFind(QQuickItem *root, const QString &name, bool usable = true) {
    if (!root)
        return nullptr;
    if (root->objectName() == name && (!usable || (root->isVisible() && root->isEnabled())))
        return root;
    for (auto *child : root->childItems())
        if (auto *found = visualFind(child, name, usable))
            return found;
    return nullptr;
}
bool within(QQuickItem *item, QQuickItem *ancestor) {
    for (auto *current = item; current; current = current->parentItem())
        if (current == ancestor)
            return true;
    return false;
}
QRectF sceneRect(QQuickItem *item) {
    return item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
}
double processCpuMs() {
    rusage usage{};
    if (getrusage(RUSAGE_SELF, &usage))
        return -1;
    return (usage.ru_utime.tv_sec + usage.ru_stime.tv_sec) * 1000.
           + (usage.ru_utime.tv_usec + usage.ru_stime.tv_usec) / 1000.;
}
QVariantMap distribution(QVector<double> values) {
    if (values.isEmpty())
        return {{"measured", false}, {"sampleCount", 0}, {"p50Ms", QVariant()},
                {"p95Ms", QVariant()}, {"maxMs", QVariant()},
                {"over33Ms", 0}, {"over50Ms", 0}};
    std::sort(values.begin(), values.end());
    const auto percentile = [&](double p) {
        return values[std::min(values.size() - 1,
            qsizetype(std::ceil(p * values.size()) - 1))];
    };
    return {{"measured", true}, {"sampleCount", values.size()}, {"p50Ms", percentile(.5)},
            {"p95Ms", percentile(.95)}, {"maxMs", values.last()},
            {"over33Ms", std::count_if(values.begin(), values.end(), [](double v) { return v > 33; })},
            {"over50Ms", std::count_if(values.begin(), values.end(), [](double v) { return v > 50; })}};
}

// A signal handler writes numbers into memory allocated before measurement.
// Phase labels and QVariant/JSON conversion are confined to phase edges/reporting.
class Cadence final {
  public:
    struct Sample { qint64 endNs = 0, intervalNs = 0; int phase = -1, segment = -1, boundaryKind = 0; };
    struct State {
        QMutex mutex;
        std::array<Sample, SampleCapacity> samples{};
        std::array<Sample, InputCapacity> crossings{};
        int count = 0, dropped = 0, phase = -1;
        int segment = -1, crossingCount = 0;
        quint64 frameCount = 0;
        qint64 lastFrameNs = 0;
        qint64 lastFramePhaseOriginNs = 0;
        int lastFramePhase = -1, lastFrameSegment = -1;
        bool segmentMode = false;
        qint64 phaseStartNs = 0, previousNs = 0;
        bool previousValid = false;
    };
    std::shared_ptr<State> state = std::make_shared<State>();
    QMetaObject::Connection connection;
    bool enabled = false;
    ~Cadence() { QObject::disconnect(connection); }
    static qint64 nowNs() {
        return std::chrono::duration_cast<std::chrono::nanoseconds>(
            std::chrono::steady_clock::now().time_since_epoch()).count();
    }
    void start(QQuickWindow *window, QObject *owner, bool collect, bool segments = false) {
        enabled = collect;
        state->segmentMode = segments;
        if (!enabled && !segments)
            return;
        connection = QObject::connect(window, &QQuickWindow::frameSwapped, owner,
            [s = state, collect] {
                const qint64 now = nowNs();
                QMutexLocker lock(&s->mutex);
                qint64 priorFrame = 0;
                if (s->segmentMode) {
                    ++s->frameCount;
                    priorFrame = std::exchange(s->lastFrameNs, now);
                    if (collect && priorFrame > 0 && s->lastFramePhase >= 0 && s->lastFrameSegment >= 0
                            && (s->phase != s->lastFramePhase || s->segment != s->lastFrameSegment)) {
                        if (s->crossingCount < InputCapacity)
                            s->crossings[s->crossingCount++] = {now - s->lastFramePhaseOriginNs,
                                now - priorFrame, s->lastFramePhase, s->lastFrameSegment, 2};
                        else
                            ++s->dropped;
                    }
                    s->lastFramePhase = s->phase;
                    s->lastFrameSegment = s->segment;
                    s->lastFramePhaseOriginNs = s->phaseStartNs;
                }
                if (s->phase < 0 || !collect)
                    return;
                if (s->previousValid) {
                    if (s->count < SampleCapacity)
                        s->samples[s->count++] = {now - s->phaseStartNs,
                                                 now - s->previousNs, s->phase, s->segment};
                    else
                        ++s->dropped;
                } else if (s->segmentMode && s->segment >= 0 && priorFrame > 0) {
                    if (s->crossingCount < InputCapacity)
                        s->crossings[s->crossingCount++] = {now - s->phaseStartNs,
                            now - priorFrame, s->phase, s->segment, 1};
                    else
                        ++s->dropped;
                }
                s->previousNs = now;
                s->previousValid = true;
            }, Qt::DirectConnection);
    }
    void phase(int phase) {
        QMutexLocker lock(&state->mutex);
        state->phase = phase;
        if (state->segmentMode)
            state->segment = -1;
        state->phaseStartNs = nowNs();
        state->previousValid = false;
    }
    void segment(int phase, int segment, qint64 phaseOriginNs) {
        QMutexLocker lock(&state->mutex);
        state->phase = phase;
        state->segment = segment;
        state->phaseStartNs = phaseOriginNs;
        state->previousValid = false;
    }
    quint64 frames() const {
        QMutexLocker lock(&state->mutex);
        return state->frameCount;
    }
    int countFor(int phase) const {
        QMutexLocker lock(&state->mutex);
        int count = 0;
        for (int index = 0; index < state->count; ++index)
            if (state->samples[index].phase == phase)
                ++count;
        return count;
    }
    void stop() { phase(-1); QObject::disconnect(connection); }
};

struct Input {
    int dueMs = 0;
    QString name;
    Action execute;
    Predicate ready;
};
struct Transaction {
    QString name;
    Predicate gate, ready;
    QVector<Input> inputs;
    int minimumMs = 0;
    bool backendGate = false;
};
struct Phase {
    QString name;
    bool active = true;
    int durationMs = ActiveMs;
    Action prepare;
    Predicate ready;
    Action validate;
    QVector<Input> inputs;
    QVector<Transaction> transactions;
};
struct InputSample {
    int phase = -1, action = -1;
    qint64 plannedMs = 0, actualMs = 0, completedMs = 0;
    int transaction = -1;
};
enum class BoundaryKind { TickEntry, ReadinessWaitBegin, ReadinessWaitEnd,
    DispatchBegin, DispatchEnd, CadenceStopBegin, CadenceStopEnd,
    PhasePropertyClearBegin, PhasePropertyClearEnd, PhaseEndObservation };
struct DriverBoundary {
    qint64 elapsedNs = 0;
    int phase = -1, transaction = -1, kind = 0, detail = 0;
};
struct SegmentSample {
    int phase = -1, transaction = -1;
    qint64 startMs = 0, endMs = 0;
    double cpuStartMs = -1, cpuEndMs = -1;
    quint64 framesAfterReady = 0;
    bool complete = false;
};
struct PhaseSample {
    qint64 startMs = 0, endMs = 0, startUnixMs = 0, endUnixMs = 0;
    qint64 cadencePhaseClockOffsetNs = 0;
    double cpuStartMs = 0, cpuEndMs = 0;
    int plannedInputs = 0, dispatchedInputs = 0, qtEvents = 0;
    qint64 navigationBarrierMs = 0;
    quint64 navigationBarrierFrames = 0;
    double activeMs = 0, activeCpuMs = 0, pauseMs = 0, backendWaitMs = 0, gateWaitMs = 0;
    double tailSettleMs = 0;
    QVariantMap windowStart, windowEnd, restoreStart, restoreEnd;
    bool complete = false;
};

class Runner final : public QObject {
  public:
    Runner(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor,
           QString mode, int rows, QString prefix, PerfScenarioCheck::Completion completion, QString protocol,
           QString diagnosticCase)
        : QObject(window), m_window(window), m_session(session), m_editor(editor),
          m_completion(std::move(completion)), m_mode(std::move(mode)),
          m_prefix(std::move(prefix)), m_rows(rows), m_protocol(std::move(protocol)),
          m_diagnosticCase(std::move(diagnosticCase)) {
        m_timer.setInterval(8);
        m_timer.setTimerType(Qt::PreciseTimer);
        connect(&m_timer, &QTimer::timeout, this, [this] {
            TimingTrace::point(TimingTrace::Kind::TimeoutArrival, m_inTick, m_finished);
            tick();
        });
        connect(session, &RuntimeBridge::messagesChanged, this, [this] {
            // Three reply deliveries per run, rather than a frame-frequency
            // probe. Preserve the ordinary RuntimeBridge/model refresh path.
            if (m_phase == 5 && m_measuring && m_delayedArrivalMs < 0
                    && replyEvidence(2).value("complete").toBool()) {
                m_delayedArrivalMs = m_phaseClock.elapsed();
                m_delayedArrivedBehindTask = m_director->property("mode").toString() == "task";
            }
        });
        buildPhases();
        if (supplemental())
            buildSupplementalTransactions();
        if (m_diagnosticCase == "reading-close") m_selectedPhases = {0};
        else if (m_diagnosticCase == "scroll-tail") m_selectedPhases = {2};
        else if (m_diagnosticCase == "scroll-tail-with-prefix") m_selectedPhases = {0, 1, 2};
        m_phaseSamples.resize(m_phases.size());
        m_cadence.start(window, this, m_mode != "visual", supplemental());
        QTimer::singleShot(0, this, [this] {
            m_startUnixMs = QDateTime::currentMSecsSinceEpoch();
            m_total.start();
            m_timer.start();
            tick();
        });
    }

  private:
    QPointer<QQuickWindow> m_window;
    QPointer<RuntimeBridge> m_session;
    QPointer<ArchiveEditor> m_editor;
    QPointer<QQuickItem> m_director, m_chat;
    QPointer<NativeAvatar> m_avatar;
    PerfScenarioCheck::Completion m_completion;
    QString m_mode, m_prefix, m_originalDraft, m_selectedName;
    QString m_pendingNavigation;
    QSize m_pendingNavigationSize;
    quint64 m_preparationAnimationGeneration = 0, m_navigationAfterGeneration = 0;
    QMetaObject::Connection m_preparationAnimationConnection;
    int m_rows = 0, m_loads = 0, m_releases = 0, m_phase = -1, m_input = 0;
    int m_inputCount = 0, m_droppedInputs = 0, m_qtEvents = 0;
    int m_avatarActions = 0, m_avatarInteractionsBefore = 0, m_dragMoves = 0;
    int m_replyHistoryRowsBefore = 0, m_sendClicks = 0;
    std::array<QString, 3> m_replyRequestIds;
    int m_heldPointerObservations = 0;
    qint64 m_delayedArrivalMs = -1;
    bool m_delayedArrivedBehindTask = false;
    bool m_prepared = false, m_measuring = false, m_finished = false, m_inTick = false;
    bool m_pointerHeld = false, m_selectionHeld = false;
    QSize m_originalSize;
    QPointF m_pointerStart, m_pointerEnd;
    double m_scrollLow = 0, m_scrollHigh = 0;
    QVariantMap m_resizeComposer, m_archiveBefore, m_replyAnchor, m_replySelection;
    const QString m_replyDraft = "延迟回复到达时保留的草稿。\n返回阅读后仍保持这两行。";
    QVariantList m_captures, m_mappingChecks;
    QTimer m_timer;
    QElapsedTimer m_total, m_prepareClock, m_phaseClock;
    qint64 m_startUnixMs = 0;
    QVector<Phase> m_phases;
    QVector<PhaseSample> m_phaseSamples;
    std::array<InputSample, InputCapacity> m_inputs{};
    Cadence m_cadence;
    QString m_protocol;
    QString m_diagnosticCase;
    quint8 m_restoreNotifyMask = 0;
    QVector<int> m_selectedPhases;
    int m_selectionCursor = 0;
    bool m_controlRequested = false, m_targetStarted = false;
    QElapsedTimer m_controlClock;
    qint64 m_targetStartAbsoluteNs = 0, m_targetEndAbsoluteNs = 0;
    qint64 m_postrollBeginNs = 0;
    int m_transaction = 0, m_transactionInput = 0, m_segmentCount = 0;
    int m_boundaryCount = 0, m_boundaryDropped = 0, m_waitKind = 0;
    qint64 m_phaseOriginNs = 0, m_transactionStartMs = 0, m_pauseUntilMs = 0;
    qint64 m_waitStartMs = 0, m_delayedSendMs = -1;
    quint64 m_readyFrames = 0;
    bool m_transactionActive = false, m_readyObserved = false, m_waiting = false;
    bool m_activeSegment = false;
    std::array<SegmentSample, InputCapacity> m_segments{};
    std::array<DriverBoundary, BoundaryCapacity> m_boundaries{};

    bool supplemental() const { return m_protocol == "companion-transactions-v1"; }
    bool diagnosticCase() const { return !m_diagnosticCase.isEmpty(); }
    int targetPhase() const { return m_diagnosticCase == "reading-close" ? 0 : 2; }
    int caseDeadlineMs() const { return m_diagnosticCase == "scroll-tail-with-prefix" ? 900000 : 120000; }
    bool expectedDiagnosticTimingError(const QString &error) const {
        return diagnosticCase() && (error == "PERF_SCROLL_INPUT_PAST_30S"
            || error == "PERF_SCROLL_INPUT_COMPLETED_PAST_30S"
            || error == "PERF_SCROLL_STOP_OBSERVATION_AFTER_100MS_TOLERANCE"
            || error.startsWith("PERF_FIXED_WINDOW_UNDISPATCHED_INPUTS:"));
    }
    QString replyPrompt(int index) const {
        return ReplyPrompts[index] + (supplemental() && index > 0
            ? QStringLiteral("，请认真给我完整说明") : QString());
    }
    void boundary(BoundaryKind kind, int detail = 0) {
        if (!supplemental() && !diagnosticCase())
            return;
        if (m_boundaryCount < BoundaryCapacity)
            m_boundaries[m_boundaryCount++] = {m_total.nsecsElapsed(), m_phase,
                m_transaction, int(kind), detail};
        else
            ++m_boundaryDropped;
    }

    QQuickItem *find(const QString &name, bool usable = true) const {
        auto *item = visualFind(m_window ? m_window->contentItem() : nullptr, name, usable);
        require(item, "PERF_CONTROL_UNAVAILABLE:" + name);
        return item;
    }
    QRectF visibleRect(QQuickItem *item) const {
        QRectF rect = sceneRect(item).intersected(QRectF(0, 0, m_window->width(), m_window->height()));
        for (auto *parent = item->parentItem(); parent; parent = parent->parentItem())
            if (parent->clip())
                rect = rect.intersected(sceneRect(parent));
        return rect;
    }
    QPointF inputPoint(QQuickItem *item) const {
        double opacity = 1;
        for (auto *parent = item; parent; parent = parent->parentItem())
            opacity *= parent->opacity();
        const auto rect = visibleRect(item);
        require(item->isVisible() && item->isEnabled() && opacity > .05 && !rect.isEmpty(),
                "PERF_CONTROL_CLIPPED_OR_DISABLED:" + item->objectName());
        return rect.center();
    }
    void click(const QString &name) {
        QTest::mouseClick(m_window, Qt::LeftButton, Qt::NoModifier,
                          inputPoint(find(name)).toPoint(), 0);
        m_qtEvents += 2;
    }
    void key(Qt::Key key, Qt::KeyboardModifiers modifiers = Qt::NoModifier) {
        QTest::keyClick(m_window, key, modifiers, 0);
        m_qtEvents += 2;
    }
    void type(const QString &text) {
        auto *composer = find("chatComposer");
        click("chatComposer");
        require(within(m_window->activeFocusItem(), composer), "PERF_COMPOSER_CLICK_DID_NOT_FOCUS");
        key(Qt::Key_A, Qt::ControlModifier);
        require(composer->property("selectionEnd").toInt() - composer->property("selectionStart").toInt()
                    == composer->property("text").toString().size(), "PERF_COMPOSER_SELECT_ALL_FAILED");
        if (text.isEmpty())
            key(Qt::Key_Backspace);
        else {
            QInputMethodEvent commit;
            commit.setCommitString(text);
            QCoreApplication::sendEvent(m_window, &commit);
            ++m_qtEvents;
        }
        require(composer->property("text").toString() == text && m_session->draft() == text,
                "PERF_COMPOSER_INPUT_NOT_COMMITTED");
    }
    double blend(const char *name) const { return m_director->property(name).toDouble(); }
    bool chatReady(const QString &mode) const {
        return m_director->property("mode").toString() == mode && blend("taskBlend") < .001
               && std::abs(blend("readBlend") - (mode == "reading" ? 1 : 0)) < .001
               && m_chat->property("inputReady").toBool();
    }
    bool taskReady(const QString &feature) const {
        auto *portal = find(feature == "character" ? "taskSurface" : "drawer-" + feature, false);
        return m_director->property("mode").toString() == "task" && blend("taskBlend") > .999
               && portal->property("inputReady").toBool()
               && portal->property("transitionState").toString() == "open";
    }
    bool companionReady() const { return chatReady("companion"); }
    bool readingReady() const {
        return chatReady("reading") && !m_chat->property("restoringReading").toBool();
    }
    void checkIdentity() const {
        require(m_avatar && m_avatar == find("nativeAvatar", false), "PERF_NATIVE_AVATAR_REPLACED");
        require(m_avatar->loads() == m_loads && m_avatar->releases() == m_releases,
                "PERF_MODEL_RELOADED_OR_RELEASED");
    }
    QVariantMap archiveFields() const {
        return {{"title", m_editor->title()}, {"keywords", m_editor->keywords()},
                {"content", m_editor->content()}, {"entryEnabled", m_editor->entryEnabled()},
                {"dirty", m_editor->dirty()}, {"revision", m_editor->revision()}};
    }
    void avatarAction() {
        require(companionReady() && m_avatar->isEnabled() && m_avatar->running(),
                "PERF_AVATAR_ACTION_INPUT_GATE_CLOSED");
        m_avatar->forceActiveFocus(Qt::OtherFocusReason);
        require(m_window->activeFocusItem() == m_avatar, "PERF_AVATAR_KEYBOARD_FOCUS_MISSING");
        key(Qt::Key_Return);
        ++m_avatarActions;
    }
    void pressHandle(bool open) {
        auto *surface = find("drawer-memory", false);
        require(open ? companionReady() : taskReady("memory"), "PERF_DRAG_STARTED_BEFORE_INPUT_READY");
        m_pointerStart = inputPoint(find("memory-drag-handle"));
        const auto axis = surface->property("gestureDirection").toPointF();
        require(QLineF(QPointF(), axis).length() > .9, "PERF_DRAG_DIRECTION_UNAVAILABLE");
        m_pointerEnd = m_pointerStart + axis * surface->property("gestureSpan").toDouble() * (open ? .72 : -.72);
        require(QRectF(1, 1, m_window->width() - 2, m_window->height() - 2).contains(m_pointerEnd),
                "PERF_DRAG_ENDPOINT_OUTSIDE_WINDOW");
        m_pointerHeld = true;
        QTest::mousePress(m_window, Qt::LeftButton, Qt::NoModifier, m_pointerStart.toPoint(), 0);
        ++m_qtEvents;
    }
    void movePointer(double fraction) {
        require(m_pointerHeld, "PERF_POINTER_MOVE_WITHOUT_PRESS");
        QTest::mouseMove(m_window, (m_pointerStart + (m_pointerEnd - m_pointerStart) * fraction).toPoint(), 0);
        ++m_qtEvents;
        if (m_selectionHeld) {
            require(m_chat->property("readingPointerActive").toBool()
                        && m_chat->property("inputReady").toBool(), "PERF_HELD_SELECTION_INPUT_GATE_CLOSED");
            ++m_heldPointerObservations;
        } else {
            require(find("drawer-memory", false)->property("dragging").toBool(), "PERF_REAL_HANDLE_DID_NOT_DRAG");
            ++m_dragMoves;
        }
    }
    void releasePointer() {
        require(m_pointerHeld, "PERF_POINTER_RELEASE_WITHOUT_PRESS");
        QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_pointerEnd.toPoint(), 0);
        ++m_qtEvents;
        m_pointerHeld = false;
        if (m_selectionHeld) {
            m_selectionHeld = false;
            auto *text = find(m_selectedName, false);
            require(text->property("selectionEnd").toInt() > text->property("selectionStart").toInt(),
                    "PERF_REAL_READING_SELECTION_MISSING");
            m_replySelection = {{"start", text->property("selectionStart")},
                                {"end", text->property("selectionEnd")}};
        }
    }
    void wheel(int direction) {
        auto *history = find("chatHistory");
        require(readingReady(), "PERF_WHEEL_INPUT_GATE_CLOSED");
        const double y = history->property("contentY").toDouble();
        m_scrollLow = std::min(m_scrollLow, y);
        m_scrollHigh = std::max(m_scrollHigh, y);
        const auto point = inputPoint(history);
        {
            TimingTrace::Scope span(TimingTrace::Kind::MouseMove, m_input, direction);
            QTest::mouseMove(m_window, point.toPoint(), 0);
        }
        {
            TimingTrace::Scope span(TimingTrace::Kind::WheelEvent, m_input, direction);
            QTest::wheelEvent(m_window, point, QPoint(0, 240 * direction));
        }
        m_qtEvents += 2;
    }
    void selectText(QQuickItem *root) {
        if (!m_selectedName.isEmpty())
            return;
        if (root->objectName().startsWith("chatMessage-") && root->isVisible() && root->isEnabled()
                && root->property("text").toString().size() > 32) {
            const auto rect = visibleRect(root);
            if (rect.width() > 180 && rect.height() > 50) {
                for (double y = rect.top() + 16; y < rect.bottom() - 10; y += 12) {
                    const QPointF first(rect.left() + 8, y);
                    const QPointF last(rect.left() + std::min(165., rect.width() * .45), y);
                    const auto localFirst = root->mapFromScene(first);
                    const auto localLast = root->mapFromScene(last);
                    int a = -1, b = -1;
                    const bool firstHit = QMetaObject::invokeMethod(root, "positionAt", Q_RETURN_ARG(int, a),
                        Q_ARG(qreal, localFirst.x()), Q_ARG(qreal, localFirst.y()));
                    const bool lastHit = QMetaObject::invokeMethod(root, "positionAt", Q_RETURN_ARG(int, b),
                        Q_ARG(qreal, localLast.x()), Q_ARG(qreal, localLast.y()));
                    require(firstHit && lastHit, "PERF_TEXT_HIT_INTERFACE_MISSING");
                    if (a >= 0 && b > a + 3 && root->property("text").toString().mid(a, b - a).trimmed().size() > 3) {
                        m_selectedName = root->objectName();
                        m_pointerStart = first;
                        m_pointerEnd = last;
                        return;
                    }
                }
            }
        }
        for (auto *child : root->childItems())
            selectText(child);
    }
    void pressReadingSelection() {
        require(readingReady(), "PERF_READING_SELECTION_INPUT_GATE_CLOSED");
        m_selectedName.clear();
        selectText(find("chatHistory"));
        require(!m_selectedName.isEmpty(), "PERF_VISIBLE_READING_TEXT_UNAVAILABLE");
        m_pointerHeld = m_selectionHeld = true;
        QTest::mousePress(m_window, Qt::LeftButton, Qt::NoModifier, m_pointerStart.toPoint(), 0);
        ++m_qtEvents;
        require(m_chat->property("readingPointerActive").toBool(), "PERF_READING_POINTER_NOT_OBSERVED");
        ++m_heldPointerObservations;
    }
    int messageCount(const QString &role, const QString &exact = {}) const {
        int count = 0;
        for (const auto &value : m_session->messages()) {
            const auto message = value.toMap();
            if (message.value("role").toString() == role
                    && (exact.isEmpty() || message.value("content").toString() == exact))
                ++count;
        }
        return count;
    }
    void send() {
        require(!m_session->busy(), "PERF_REPLY_REQUEST_ALREADY_BUSY");
        require(m_sendClicks < int(ReplyPrompts.size()), "PERF_EXTRA_REPLY_UI_SEND");
        const QString prompt = m_session->draft();
        require(prompt == replyPrompt(m_sendClicks) && messageCount("user", prompt) == 0,
                "PERF_REPLY_PROMPT_ALREADY_SENT_OR_OUT_OF_ORDER");
        click("sendChat");
        QString requestId;
        int matchingUsers = 0;
        for (const auto &value : m_session->messages()) {
            const auto row = value.toMap();
            if (row.value("role").toString() == "user" && row.value("content").toString() == prompt) {
                ++matchingUsers;
                // RuntimeBridge's immediate user row uses its request ID as
                // id; the subsequent canonical history row has request_id.
                requestId = row.value("request_id").toString();
                if (requestId.isEmpty())
                    requestId = row.value("id").toString();
            }
        }
        require(matchingUsers == 1 && !requestId.isEmpty(), "PERF_UI_SEND_REQUEST_ID_NOT_OBSERVED");
        for (int index = 0; index < m_sendClicks; ++index)
            require(m_replyRequestIds[index] != requestId, "PERF_REPLY_UI_REQUEST_ID_REUSED");
        m_replyRequestIds[m_sendClicks] = requestId;
        ++m_sendClicks;
    }
    QVariantMap replyEvidence(int index) const {
        return committedReplyEvidence(m_session->messages(), replyPrompt(index), m_replyRequestIds[index]);
    }
    void addInput(Phase &phase, int dueMs, QString name, Action execute, Predicate ready = {}) {
        phase.inputs.append({dueMs, std::move(name), std::move(execute), std::move(ready)});
    }
    Phase &addPhase(QString name, Action prepare, Predicate ready, Action validate = {}, bool active = true) {
        m_phases.append({std::move(name), active, active ? ActiveMs : IdleMs,
                         std::move(prepare), std::move(ready), std::move(validate), {}});
        return m_phases.last();
    }
    void prepareNavigation(const QString &control, QSize size) {
        require(m_pendingNavigation.isEmpty(), "PERF_PREPARATION_NAVIGATION_ALREADY_PENDING");
        m_pendingNavigation = control;
        m_pendingNavigationSize = size;
        m_navigationAfterGeneration = m_preparationAnimationGeneration + 1;
        m_preparationAnimationConnection = connect(m_window, &QQuickWindow::afterAnimating,
            this, [this] { ++m_preparationAnimationGeneration; });
        m_window->resize(size);
        m_window->update();
    }
    bool processPreparationNavigation() {
        if (m_pendingNavigation.isEmpty())
            return true;
        if (m_window->size() != m_pendingNavigationSize
                || m_preparationAnimationGeneration < m_navigationAfterGeneration)
            return false;
        auto *control = visualFind(m_window->contentItem(), m_pendingNavigation);
        if (!control)
            return false;
        double opacity = 1;
        for (auto *parent = control; parent; parent = parent->parentItem())
            opacity *= parent->opacity();
        const auto whole = sceneRect(control);
        const auto exposed = visibleRect(control);
        if (opacity <= .05 || whole.isEmpty() || exposed.isEmpty()
                || exposed.width() < whole.width() - 1 || exposed.height() < whole.height() - 1)
            return false;
        auto &sample = m_phaseSamples[m_phase];
        sample.navigationBarrierMs = m_prepareClock.elapsed();
        sample.navigationBarrierFrames = m_preparationAnimationGeneration - m_navigationAfterGeneration + 1;
        const QString name = std::exchange(m_pendingNavigation, {});
        QObject::disconnect(m_preparationAnimationConnection);
        click(name);
        return true;
    }
    void prepareChat(const QString &state, QSize size = {1380, 900}) {
        prepareNavigation(state == "reading" ? "nav-reading" : "nav-chat", size);
    }
    void buildPhases() {
        auto &transition = addPhase("reading-open-reverse-task-sequence", [this] { prepareChat("companion"); },
            [this] { return companionReady(); });
        for (int cycle = 0; cycle < 5; ++cycle) {
            const int due = cycle * 6000;
            addInput(transition, due, cycle == 0 ? "cold-first-reading-open" : "warm-reading-open",
                     [this] { click("nav-reading"); });
            addInput(transition, due + 150, "reading-reverse", [this] { click("nav-chat"); });
            addInput(transition, due + 1000, "reading-open-full", [this] { click("nav-reading"); });
            addInput(transition, due + 2000, "task-memory", [this] { click("nav-memory"); }, [this] { return readingReady(); });
            addInput(transition, due + 3000, "task-settings", [this] { click("nav-settings"); }, [this] { return taskReady("memory"); });
            addInput(transition, due + 4000, "task-character", [this] { click("nav-character"); }, [this] { return taskReady("settings"); });
            addInput(transition, due + 5000, "task-return-reading", [this] { click("continueChat"); }, [this] { return taskReady("character"); });
            addInput(transition, due + 5800, "reading-close", [this] { click("closeHistory"); }, [this] { return readingReady(); });
        }

        auto &drag = addPhase("handle-drag-with-native-avatar-action", [this] {
            prepareChat("companion");
            m_avatarInteractionsBefore = m_avatar->successfulInteractions();
        }, [this] { return companionReady(); }, [this] {
            require(companionReady() && m_dragMoves == (supplemental() ? 72 : 36)
                    && m_avatarActions == (supplemental() ? 12 : 6),
                    "PERF_DRAG_SEQUENCE_OR_FINAL_STATE_MISMATCH");
            require(m_avatar->successfulInteractions() >= m_avatarInteractionsBefore + m_avatarActions,
                    "PERF_NATIVE_AVATAR_ACTION_NOT_PROCESSED");
        });
        for (int cycle = 0; cycle < 6; ++cycle) {
            const int due = cycle * 5000;
            addInput(drag, due, "native-avatar-return", [this] { avatarAction(); }, [this] { return companionReady(); });
            for (int open = 1; open >= 0; --open) {
                const int start = due + (open ? 200 : 2200);
                addInput(drag, start, open ? "handle-open-press" : "handle-close-press", [this, open] { pressHandle(open); },
                    [this, open] { return open ? companionReady() : taskReady("memory"); });
                for (int move = 1; move <= 3; ++move)
                    addInput(drag, start + move * 100, "handle-move", [this, move] { movePointer(move / 3.); });
                addInput(drag, start + 500, "handle-release", [this] { releasePointer(); });
            }
        }

        auto &scroll = addPhase("sustained-history-scroll", [this] { prepareChat("reading"); },
            [this] { return readingReady(); }, [this] {
                require(m_scrollHigh - m_scrollLow > 20, "PERF_WHEEL_DID_NOT_SCROLL_HISTORY");
                require(!m_chat->property("followLatest").toBool(), "PERF_SCROLL_DID_NOT_ESTABLISH_READING_ANCHOR");
            });
        for (int due = 0; due < ActiveMs; due += 90) {
            // Finish on older text, rather than at the latest-message boundary
            // where followLatest becoming true is valid. Keep all due times.
            const bool older = due >= ActiveMs - 1500 || (due / 1500) % 2 == 0;
            addInput(scroll, due, older ? "history-wheel-older" : "history-wheel-latest",
                     [this, older] { wheel(older ? 1 : -1); },
                     [this] { return readingReady(); });
        }

        auto &composer = addPhase("composer-one-to-six-lines-grow-delete", [this] { prepareChat("reading"); },
            [this] { return readingReady(); }, [this] {
                require(m_session->draft().isEmpty(), "PERF_COMPOSER_DELETE_DID_NOT_EMPTY_DRAFT");
            });
        const std::array<int, 12> lineCounts{1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0};
        for (int index = 0; index < 60; ++index) {
            QStringList lines;
            for (int line = 0; line < lineCounts[index % lineCounts.size()]; ++line)
                lines.append(QString("性能草稿第 %1 行：窗边月光下保持阅读位置。").arg(line + 1));
            addInput(composer, index * 500, "composer-grow-delete", [this, text = lines.join('\n')] { type(text); },
                     [this] { return readingReady(); });
        }

        auto &resize = addPhase("resize-950-760-1180", [this] { prepareChat("reading"); },
            [this] { return readingReady(); }, [this] {
                auto *composer = find("chatComposer");
                require(m_session->draft() == m_resizeComposer.value("text").toString()
                        && composer->property("cursorPosition") == m_resizeComposer.value("cursor")
                        && composer->property("selectionStart") == m_resizeComposer.value("start")
                        && composer->property("selectionEnd") == m_resizeComposer.value("end"),
                        "PERF_RESIZE_LOST_COMPOSER_TEXT_CURSOR_OR_SELECTION");
            });
        const std::array<QSize, 4> sizes{QSize(950, 760), QSize(760, 760), QSize(1180, 760), QSize(1380, 900)};
        for (int index = 0; index < 30; ++index)
            addInput(resize, index * 1000, "window-resize", [this, size = sizes[index % sizes.size()]] {
                m_window->resize(size); ++m_qtEvents;
            }, [this] { return readingReady(); });

        auto &replies = addPhase("short-long-delayed-reply-behind-task", [this] { prepareChat("reading"); },
            [this] { return readingReady() && !m_session->busy(); }, [this] {
                require(!m_session->busy() && m_sendClicks == 3,
                        "PERF_REPLY_DISPATCH_OR_COMPLETION_COUNT_MISMATCH");
                for (int index = 0; index < int(ReplyPrompts.size()); ++index)
                    require(replyEvidence(index).value("complete").toBool(),
                            "PERF_REPLY_DURABLE_REQUEST_EVIDENCE_MISMATCH:" + ReplyPrompts[index]);
                require(m_heldPointerObservations >= 4, "PERF_HELD_SELECTION_SCENARIO_NOT_OBSERVED");
                require(m_delayedArrivalMs >= 0 && m_delayedArrivedBehindTask,
                        "PERF_DELAYED_REPLY_DID_NOT_ARRIVE_BEHIND_TASK");
            });
        const std::array<int, 3> sends{0, 4000, 10000};
        for (int index = 0; index < 3; ++index) {
            addInput(replies, sends[index], "reply-compose", [this, prompt = ReplyPrompts[index]] { type(prompt); },
                     [this] { return readingReady() && !m_session->busy(); });
            addInput(replies, sends[index] + 100, "reply-send", [this] { send(); },
                     [this] { return readingReady() && !m_session->busy(); });
        }
        addInput(replies, 10500, "preserved-reply-draft", [this] { type(m_replyDraft); }, [this] { return readingReady(); });
        addInput(replies, 11000, "held-selection-press", [this] { pressReadingSelection(); }, [this] { return readingReady(); });
        addInput(replies, 11200, "held-selection-move", [this] { movePointer(.3); });
        addInput(replies, 11400, "held-selection-move", [this] { movePointer(.6); });
        addInput(replies, 11600, "held-selection-move", [this] { movePointer(1); });
        addInput(replies, 11800, "held-selection-release", [this] { releasePointer(); });
        addInput(replies, 12000, "reply-task-memory", [this] {
            require(m_session->busy(), "PERF_DELAYED_REPLY_ARRIVED_BEFORE_TASK_HANDOFF");
            click("nav-memory");
            m_replyAnchor = mapValue(m_chat->property("readingAnchor"));
        }, [this] { return readingReady(); });
        addInput(replies, 14000, "reply-task-settings", [this] { click("nav-settings"); }, [this] { return taskReady("memory"); });
        addInput(replies, 16000, "reply-return-reading", [this] { click("continueChat"); }, [this] { return taskReady("settings"); });
        addInput(replies, 18000, "validate-preserved-reading-then-restore-draft", [this] {
            const auto anchor = mapValue(m_chat->property("readingAnchor"));
            require(anchor.value("messageId") == m_replyAnchor.value("messageId")
                    && anchor.value("index") == m_replyAnchor.value("index")
                    && std::abs(anchor.value("offset").toDouble() - m_replyAnchor.value("offset").toDouble()) < 2
                    && !m_chat->property("followLatest").toBool(), "PERF_REPLY_TASK_LOST_READING_ANCHOR");
            auto *selected = find(m_selectedName, false);
            require(selected->property("selectionStart") == m_replySelection.value("start")
                    && selected->property("selectionEnd") == m_replySelection.value("end"),
                    "PERF_REPLY_TASK_LOST_READING_SELECTION");
            require(m_session->draft() == m_replyDraft, "PERF_REPLY_TASK_LOST_DRAFT");
            type(m_originalDraft);
        }, [this] { return readingReady() && !m_session->busy(); });

        // Inputs are declared by scenario, then ordered once before measurement.
        std::stable_sort(replies.inputs.begin(), replies.inputs.end(),
                         [](const Input &a, const Input &b) { return a.dueMs < b.dueMs; });

        for (const auto &state : {"companion", "reading", "memory", "settings", "character"})
            addIdle(QString(state), QSize(1380, 900));
        for (const auto &state : {"memory", "settings", "character"})
            addIdle(QString(state), QSize(950, 760));
    }
    void addIdle(const QString &state, QSize size) {
        const QString suffix = size.width() < 1180 ? "compact" : "wide";
        addPhase("idle-" + state + "-" + suffix, [this, state, size] {
            prepareNavigation(state == "companion" ? "nav-chat" : state == "reading" ? "nav-reading" : "nav-" + state, size);
        }, [this, state, size] {
            return m_window->size() == size && (state == "companion" || state == "reading" ? chatReady(state) : taskReady(state));
        }, [this, state, size] {
            require(m_avatar->running(), "PERF_IDLE_AVATAR_STOPPED");
            if (size.width() < 1180 && state != "character")
                require(!m_avatar->isEnabled() && blend("avatarVisibility") < .001, "PERF_COMPACT_IDLE_AVATAR_INPUT_NOT_HIDDEN");
        }, false);
    }
    Transaction &transaction(int phaseIndex, QString name, Predicate gate, Predicate ready,
                             int minimumMs = 0, bool backendGate = false) {
        auto &phase = m_phases[phaseIndex];
        phase.transactions.append({std::move(name), std::move(gate), std::move(ready), {},
                                   minimumMs, backendGate});
        return phase.transactions.last();
    }
    void transactionInput(int phaseIndex, Transaction &tx, int dueMs, QString name,
                          Action action, Predicate ready = {}) {
        Input input{dueMs, std::move(name), std::move(action), std::move(ready)};
        tx.inputs.append(input);
        m_phases[phaseIndex].inputs.append(std::move(input));
    }
    void navigationTransaction(int phaseIndex, const QString &name, const QString &control,
                               Predicate gate, Predicate ready, Action extra = {}) {
        auto &tx = transaction(phaseIndex, name, std::move(gate), std::move(ready));
        transactionInput(phaseIndex, tx, 0, name, [this, control, extra] {
            if (extra)
                extra();
            click(control);
        });
    }
    void validatePreservedReply() {
        const auto anchor = mapValue(m_chat->property("readingAnchor"));
        require(anchor.value("messageId") == m_replyAnchor.value("messageId")
                && anchor.value("index") == m_replyAnchor.value("index")
                && std::abs(anchor.value("offset").toDouble() - m_replyAnchor.value("offset").toDouble()) < 2
                && !m_chat->property("followLatest").toBool(), "PERF_REPLY_TASK_LOST_READING_ANCHOR");
        auto *selected = find(m_selectedName, false);
        require(selected->property("selectionStart") == m_replySelection.value("start")
                && selected->property("selectionEnd") == m_replySelection.value("end"),
                "PERF_REPLY_TASK_LOST_READING_SELECTION");
        require(m_session->draft() == m_replyDraft, "PERF_REPLY_TASK_LOST_DRAFT");
    }
    void buildSupplementalTransactions() {
        // The work contract is registered once, before the first GUI action.
        // These are operations a user completes before beginning the next one.
        for (int index = 0; index < 6; ++index) {
            m_phases[index].inputs.clear();
            m_phases[index].durationMs = 0;
        }
        for (int cycle = 0; cycle < 26; ++cycle) {
            auto &reverse = transaction(0, "reading-open-reverse", [this] { return companionReady(); },
                                        [this] { return companionReady(); }, 150);
            transactionInput(0, reverse, 0, cycle ? "warm-reading-open" : "cold-first-reading-open",
                             [this] { click("nav-reading"); });
            transactionInput(0, reverse, 150, "reading-reverse", [this] { click("nav-chat"); });
            navigationTransaction(0, "reading-open-full", "nav-reading", [this] { return companionReady(); },
                                  [this] { return readingReady(); });
            navigationTransaction(0, "task-memory", "nav-memory", [this] { return readingReady(); },
                                  [this] { return taskReady("memory"); });
            navigationTransaction(0, "task-settings", "nav-settings", [this] { return taskReady("memory"); },
                                  [this] { return taskReady("settings"); });
            navigationTransaction(0, "task-return-reading", "continueChat", [this] { return taskReady("settings"); },
                                  [this] { return readingReady(); });
            navigationTransaction(0, "reading-close", "closeHistory", [this] { return readingReady(); },
                                  [this] { return companionReady(); });
        }
        for (int cycle = 0; cycle < 12; ++cycle) {
            auto &avatar = transaction(1, "native-avatar-action", [this] { return companionReady(); }, [this] {
                return companionReady() && m_avatar->successfulInteractions()
                    >= m_avatarInteractionsBefore + m_avatarActions;
            });
            transactionInput(1, avatar, 0, "native-avatar-return", [this] { avatarAction(); });
            for (int open = 1; open >= 0; --open) {
                auto &drag = transaction(1, open ? "handle-open" : "handle-close", [this, open] {
                    return open ? companionReady() : taskReady("memory");
                }, [this, open] { return open ? taskReady("memory") : companionReady(); });
                transactionInput(1, drag, 0, open ? "handle-open-press" : "handle-close-press",
                                 [this, open] { pressHandle(open); });
                for (int move = 1; move <= 3; ++move)
                    transactionInput(1, drag, move * 100, "handle-move", [this, move] { movePointer(move / 3.); });
                transactionInput(1, drag, 500, "handle-release", [this] { releasePointer(); });
            }
        }
        auto &scroll = transaction(2, "continuous-history-wheel-30s", [this] { return readingReady(); },
                                   [this] { return readingReady(); }, ActiveMs);
        for (int index = 0; index < 300; ++index) {
            const bool older = index >= 285 || (index / 15) % 2 == 0;
            transactionInput(2, scroll, index * 100, older ? "history-wheel-older" : "history-wheel-latest",
                             [this, older] { wheel(older ? 1 : -1); }, [this] { return readingReady(); });
        }
        const std::array<int, 12> lineCounts{1, 2, 3, 4, 5, 6, 5, 4, 3, 2, 1, 0};
        for (int index = 0; index < 180; ++index) {
            QStringList lines;
            for (int line = 0; line < lineCounts[index % lineCounts.size()]; ++line)
                lines.append(QString("性能草稿第 %1 行：窗边月光下保持阅读位置。").arg(line + 1));
            auto &tx = transaction(3, "composer-grow-delete", [this] { return readingReady(); },
                                   [this] { return readingReady(); });
            transactionInput(3, tx, 0, "composer-grow-delete", [this, text = lines.join('\n')] { type(text); });
        }
        const std::array<QSize, 4> sizes{QSize(950, 760), QSize(760, 650), QSize(1180, 760), QSize(1380, 900)};
        for (int index = 0; index < 160; ++index) {
            const auto size = sizes[index % sizes.size()];
            auto &tx = transaction(4, "window-resize", [this] { return readingReady(); },
                                   [this, size] { return m_window->size() == size && readingReady(); });
            transactionInput(4, tx, 0, "window-resize", [this, size] { m_window->resize(size); ++m_qtEvents; });
        }
        for (int index = 0; index < 3; ++index) {
            auto &compose = transaction(5, "reply-compose", [this] { return readingReady() && !m_session->busy(); },
                                       [this] { return readingReady(); });
            transactionInput(5, compose, 0, "reply-compose", [this, index] { type(replyPrompt(index)); });
            auto &sendTx = transaction(5, "reply-send", [this] { return readingReady() && !m_session->busy(); },
                                      [this] { return readingReady(); });
            transactionInput(5, sendTx, 0, "reply-send", [this, index] {
                send();
                if (index == 2)
                    m_delayedSendMs = m_phaseClock.elapsed();
            });
            if (index < 2) {
                auto &reply = transaction(5, "reply-completion", [this, index] {
                    return !m_session->busy() && replyEvidence(index).value("complete").toBool();
                }, [this] { return readingReady(); }, 0, true);
                transactionInput(5, reply, 0, "reply-observe-canonical-completion", [] {});
            }
        }
        auto &draft = transaction(5, "preserved-reply-draft", [this] { return readingReady(); },
                                 [this] { return readingReady(); });
        transactionInput(5, draft, 0, "preserved-reply-draft", [this] { type(m_replyDraft); });
        auto &selection = transaction(5, "held-reading-selection", [this] { return readingReady(); },
                                     [this] { return readingReady() && !m_pointerHeld; });
        transactionInput(5, selection, 0, "held-selection-press", [this] { pressReadingSelection(); });
        for (int move = 1; move <= 3; ++move)
            transactionInput(5, selection, move * 200, "held-selection-move", [this, move] { movePointer(move / 3.); });
        transactionInput(5, selection, 800, "held-selection-release", [this] { releasePointer(); });
        auto &handoff = transaction(5, "reply-task-memory", [this] {
            return readingReady() && m_phaseClock.elapsed() >= m_delayedSendMs + 1500;
        }, [this] { return taskReady("memory"); });
        transactionInput(5, handoff, 0, "reply-task-memory", [this] {
            require(m_session->busy(), "PERF_DELAYED_REPLY_ARRIVED_BEFORE_TASK_HANDOFF");
            click("nav-memory");
            m_replyAnchor = mapValue(m_chat->property("readingAnchor"));
        });
        for (int index = 0; index < 8; ++index) {
            const bool settings = index % 2 == 0;
            navigationTransaction(5, settings ? "reply-task-settings" : "reply-task-memory-active",
                settings ? "nav-settings" : "nav-memory",
                [this, settings] { return taskReady(settings ? "memory" : "settings"); },
                [this, settings] { return taskReady(settings ? "settings" : "memory"); });
        }
        auto &delivered = transaction(5, "delayed-reply-completion-behind-task", [this] {
            return !m_session->busy() && replyEvidence(2).value("complete").toBool();
        }, [this] { return taskReady("memory"); }, 0, true);
        transactionInput(5, delivered, 0, "reply-observe-canonical-completion", [] {});
        navigationTransaction(5, "reply-return-reading", "continueChat", [this] { return taskReady("memory"); },
                              [this] { return readingReady(); });
        auto &preserved = transaction(5, "validate-preserved-reading", [this] { return readingReady(); },
                                     [this] { return readingReady(); });
        transactionInput(5, preserved, 0, "validate-preserved-reading-then-restore-draft", [this] {
            validatePreservedReply(); type(m_originalDraft);
        });
        for (int cycle = 0; cycle < 12; ++cycle) {
            navigationTransaction(5, "post-reply-memory", "nav-memory", [this] { return readingReady(); },
                                  [this] { return taskReady("memory"); });
            navigationTransaction(5, "post-reply-settings", "nav-settings", [this] { return taskReady("memory"); },
                                  [this] { return taskReady("settings"); });
            navigationTransaction(5, "post-reply-return-reading", "continueChat", [this] { return taskReady("settings"); },
                                  [this] { return readingReady(); });
        }
    }
    void initialize() {
        require(m_mode == "perf" || m_mode == "diagnostic" || m_mode == "visual", "PERF_MODE_INVALID");
        require(m_rows == 9 || m_rows == 100 || m_rows == 300, "PERF_FIXTURE_ROWS_INVALID");
        require(m_session->connected() && m_editor->initialized() && !m_session->busy(), "PERF_BOOTSTRAP_SESSION_OR_ARCHIVE_NOT_READY");
        require(m_session->messages().size() == m_rows, "PERF_DURABLE_HISTORY_ROWS_MISMATCH");
        m_director = find("sceneDirector", false);
        m_chat = find("persistentChat", false);
        m_avatar = qobject_cast<NativeAvatar *>(find("nativeAvatar", false));
        require(m_avatar && !m_avatar->modelPath().isEmpty() && m_avatar->loads() > 0 && m_avatar->running(), "PERF_IMPORTED_NATIVE_MODEL_NOT_READY");
        require(!m_window->property("reverieRecording").toBool(), "PERF_RECORDING_NOT_ALLOWED");
        m_loads = m_avatar->loads();
        m_releases = m_avatar->releases();
        m_originalSize = m_window->size();
        m_originalDraft = m_session->draft();
        m_archiveBefore = archiveFields();
        if (diagnosticCase()) {
            require(m_mode == "diagnostic" && !m_selectedPhases.isEmpty() && TimingTrace::enabled(),
                    "TIMING_DIAGNOSTIC_BUILD_AND_CASE_REQUIRED");
            require((m_diagnosticCase == "reading-close" && !supplemental() && (m_rows == 100 || m_rows == 300))
                    || (m_diagnosticCase != "reading-close" && supplemental() && m_rows == 300),
                    "TIMING_DIAGNOSTIC_PROTOCOL_OR_ROWS_MISMATCH");
            m_phase = m_selectedPhases.first();
            require(!TimingTrace::metaCallContextEnabled() || m_diagnosticCase == "reading-close",
                    "TIMING_METACALL_CONTEXT_REQUIRES_READING_CLOSE");
            if (TimingTrace::metaCallContextEnabled()) {
                // Reuse identities already resolved by the ordinary preparation.
                // No extra object-tree traversal or per-receiver lifecycle hook.
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::Window, m_window);
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::SceneDirector, m_director);
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ChatPanel, m_chat);
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::RuntimeBridge, m_session);
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ArchiveEditor, m_editor);
                TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::NativeAvatar, m_avatar);
                m_restoreNotifyMask = TimingTrace::observeReadingRestoreCounters(m_chat, this);
            }
            if (m_diagnosticCase == "scroll-tail-with-prefix") TimingTrace::stop();
        } else m_phase = 0;
    }
    void beginPhase() {
        if (diagnosticCase() && m_phase == targetPhase() && !m_targetStarted) {
            if (!m_controlRequested) {
                if (m_diagnosticCase == "scroll-tail-with-prefix") TimingTrace::start();
                TimingTrace::setContext(m_phase, -1);
                m_controlRequested = true;
                m_controlClock.start();
            }
            require(TimingTrace::controlError().isEmpty(), "TIMING_DIAGNOSTIC_CONTROL_FAILED");
            require(m_controlClock.elapsed() < 15000, "TIMING_DIAGNOSTIC_CONTROL_TIMEOUT");
            if (!TimingTrace::phaseReady(m_phase)) return;
        }
        auto &phase = m_phases[m_phase];
        if (phase.name == "sustained-history-scroll") {
            auto *history = find("chatHistory");
            require(history->property("contentHeight").toDouble() > history->height() + 20, "PERF_HISTORY_FIXTURE_NOT_SCROLLABLE");
            m_scrollLow = m_scrollHigh = history->property("contentY").toDouble();
        }
        if (phase.name == "resize-950-760-1180") {
            type("缩放草稿第一行。\n第二行仍保持光标。\n第三行不发送。\n第四行保留选区。");
            for (int index = 0; index < 6; ++index)
                key(Qt::Key_Left, Qt::ShiftModifier);
            auto *composer = find("chatComposer");
            m_resizeComposer = {{"text", composer->property("text")}, {"cursor", composer->property("cursorPosition")},
                                {"start", composer->property("selectionStart")}, {"end", composer->property("selectionEnd")}};
            // Draft growth changes the reading viewport. Finish that ordinary
            // restoration before starting the fixed resize window.
            m_prepared = false;
            m_phases[m_phase].prepare = [] {};
            return;
        }
        startMeasurement();
    }
    void startMeasurement() {
        TimingTrace::setContext(m_phase, -1);
        auto &phase = m_phases[m_phase];
        if (phase.name == "short-long-delayed-reply-behind-task") {
            m_replyHistoryRowsBefore = m_session->messages().size();
        }
        if (m_mode == "visual")
            capture(phase.name + "-start");
        auto &sample = m_phaseSamples[m_phase];
        sample.restoreStart = readRestoreCounters();
        sample.windowStart = windowState();
        sample.startMs = m_total.elapsed();
        sample.startUnixMs = QDateTime::currentMSecsSinceEpoch();
        sample.cpuStartMs = m_mode == "visual" ? -1 : processCpuMs();
        sample.plannedInputs = phase.inputs.size();
        m_input = 0;
        m_qtEvents = 0;
        m_phaseClock.restart();
        TimingTrace::point(TimingTrace::Kind::ClockAnchor, m_total.nsecsElapsed(), m_phaseClock.nsecsElapsed());
        m_measuring = true;
        if (diagnosticCase() && m_phase == targetPhase()) {
            m_targetStarted = true;
            m_targetStartAbsoluteNs = TimingTrace::nowNs();
            TimingTrace::phaseStarted(m_phase, QDateTime::currentMSecsSinceEpoch());
        }
        m_window->setProperty("reveriePerfPhase", phase.name);
        if (supplemental() && phase.active) {
            m_transaction = m_transactionInput = 0;
            m_transactionActive = m_activeSegment = m_readyObserved = m_waiting = false;
            m_pauseUntilMs = 0;
            m_phaseOriginNs = Cadence::nowNs() - m_phaseClock.nsecsElapsed();
            m_cadence.phase(-1);
        } else {
            m_cadence.phase(m_phase);
        }
        // The cadence origin follows phase-property notification. Record its
        // offset once so post-hoc input boundaries use the phase input clock.
        sample.cadencePhaseClockOffsetNs = m_phaseClock.nsecsElapsed();
    }
    void completePhase() {
        TimingTrace::setContext(m_phase, m_input);
        TimingTrace::Scope phaseClose(TimingTrace::Kind::PhaseClose, m_phase, m_input);
        boundary(BoundaryKind::CadenceStopBegin);
        { TimingTrace::Scope stop(TimingTrace::Kind::CadenceStop); m_cadence.phase(-1); }
        boundary(BoundaryKind::CadenceStopEnd);
        boundary(BoundaryKind::PhasePropertyClearBegin);
        { TimingTrace::Scope clear(TimingTrace::Kind::PhasePropertyClear);
          m_window->setProperty("reveriePerfPhase", QString()); }
        boundary(BoundaryKind::PhasePropertyClearEnd);
        auto &phase = m_phases[m_phase];
        auto &sample = m_phaseSamples[m_phase];
        sample.endMs = m_total.elapsed();
        sample.endUnixMs = QDateTime::currentMSecsSinceEpoch();
        sample.cpuEndMs = m_mode == "visual" ? -1 : processCpuMs();
        sample.restoreEnd = readRestoreCounters();
        sample.windowEnd = windowState();
        sample.qtEvents = m_qtEvents;
        sample.dispatchedInputs = m_input;
        boundary(BoundaryKind::PhaseEndObservation);
        require(m_input == phase.inputs.size(), "PERF_FIXED_WINDOW_UNDISPATCHED_INPUTS:" + phase.name);
        if (!supplemental() || !phase.active)
            require(m_phaseClock.elapsed() >= phase.durationMs, "PERF_FIXED_WINDOW_FINISHED_EARLY");
        else
            require(m_transaction == phase.transactions.size(), "PERF_FIXED_TRANSACTIONS_INCOMPLETE:" + phase.name);
        if (supplemental() && phase.active)
            require(sample.endMs - sample.startMs < SupplementalPhaseDeadlineMs,
                    "PERF_TRANSACTION_PHASE_DEADLINE_EXCEEDED:" + phase.name);
        if (phase.active && m_mode != "visual" && !diagnosticCase())
            require(m_cadence.countFor(m_phase) >= MinimumActiveIntervals, "PERF_ACTIVE_PHASE_INSUFFICIENT_INTERVALS:" + phase.name);
        if (phase.validate)
            phase.validate();
        checkIdentity();
        require(archiveFields() == m_archiveBefore, "PERF_SCENARIO_CHANGED_ARCHIVE_DRAFT");
        sample.complete = true;
        if (m_mode == "visual")
            capture(phase.name + "-end");
        if (diagnosticCase()) {
            if (m_phase == targetPhase()) {
                m_targetEndAbsoluteNs = TimingTrace::nowNs();
            }
            ++m_selectionCursor;
            m_phase = m_selectionCursor < m_selectedPhases.size()
                ? m_selectedPhases[m_selectionCursor] : int(m_phases.size());
        } else ++m_phase;
        m_prepared = m_measuring = false;
    }
    void beginWait(int kind) {
        if (m_waiting && m_waitKind == kind)
            return;
        endWait();
        m_waiting = true;
        m_waitKind = kind;
        m_waitStartMs = m_phaseClock.elapsed();
        boundary(BoundaryKind::ReadinessWaitBegin, kind);
    }
    void endWait() {
        if (!m_waiting)
            return;
        const double elapsed = m_phaseClock.elapsed() - m_waitStartMs;
        auto &sample = m_phaseSamples[m_phase];
        if (m_waitKind == 1) sample.gateWaitMs += elapsed;
        if (m_waitKind == 2) sample.backendWaitMs += elapsed;
        if (m_waitKind == 5) sample.pauseMs += elapsed;
        if (m_waitKind == 6) sample.tailSettleMs += elapsed;
        boundary(BoundaryKind::ReadinessWaitEnd, m_waitKind);
        m_waiting = false;
    }
    void closeActiveSegment() {
        if (!m_activeSegment)
            return;
        boundary(BoundaryKind::CadenceStopBegin);
        m_cadence.phase(-1);
        boundary(BoundaryKind::CadenceStopEnd);
        auto &segment = m_segments[m_segmentCount - 1];
        segment.endMs = m_phaseClock.elapsed();
        segment.cpuEndMs = m_mode == "visual" ? -1 : processCpuMs();
        auto &phase = m_phaseSamples[m_phase];
        phase.activeMs += segment.endMs - segment.startMs;
        if (segment.cpuStartMs >= 0 && segment.cpuEndMs >= 0)
            phase.activeCpuMs += segment.cpuEndMs - segment.cpuStartMs;
        m_activeSegment = false;
    }
    void tickTransactions() {
        auto &phase = m_phases[m_phase];
        require(m_phaseClock.elapsed() < SupplementalPhaseDeadlineMs,
                "PERF_TRANSACTION_PHASE_DEADLINE_EXCEEDED:" + phase.name);
        if (m_transaction >= phase.transactions.size()) {
            endWait();
            completePhase();
            return;
        }
        auto &tx = phase.transactions[m_transaction];
        if (!m_transactionActive) {
            if (m_phaseClock.elapsed() < m_pauseUntilMs) {
                beginWait(5);
                return;
            }
            if (m_waiting && m_waitKind == 5)
                endWait();
            if (tx.gate && !tx.gate()) {
                beginWait(tx.backendGate ? 2 : 1);
                require(m_phaseClock.elapsed() - m_waitStartMs < TransactionDeadlineMs,
                        "PERF_TRANSACTION_GATE_TIMEOUT:" + tx.name);
                return;
            }
            endWait();
            require(m_segmentCount < InputCapacity, "PERF_TRANSACTION_SEGMENT_CAPACITY_EXCEEDED");
            m_transactionActive = m_activeSegment = true;
            m_readyObserved = false;
            m_transactionInput = 0;
            m_transactionStartMs = m_phaseClock.elapsed();
            auto &segment = m_segments[m_segmentCount];
            segment = {m_phase, m_transaction, m_transactionStartMs, 0,
                       m_mode == "visual" ? -1 : processCpuMs(), -1, 0, false};
            m_cadence.segment(m_phase, m_segmentCount++, m_phaseOriginNs);
        }
        const auto txElapsed = m_phaseClock.elapsed() - m_transactionStartMs;
        require(txElapsed < (m_phase == 2 ? ActiveMs + TransactionDeadlineMs : TransactionDeadlineMs),
                "PERF_TRANSACTION_TIMEOUT:" + tx.name);
        while (m_transactionInput < tx.inputs.size()
                && tx.inputs[m_transactionInput].dueMs <= m_phaseClock.elapsed() - m_transactionStartMs) {
            const auto &input = tx.inputs[m_transactionInput];
            if (input.ready && !input.ready()) {
                beginWait(3);
                return;
            }
            endWait();
            const auto actual = m_phaseClock.elapsed();
            if (m_phase == 2)
                require(actual - m_transactionStartMs <= ActiveMs, "PERF_SCROLL_INPUT_PAST_30S");
            TimingTrace::setContext(m_phase, m_input);
            boundary(BoundaryKind::DispatchBegin, m_input);
            { TimingTrace::Scope dispatch(TimingTrace::Kind::InputDispatch, m_input,
                                         m_transactionStartMs + input.dueMs);
              input.execute(); }
            boundary(BoundaryKind::DispatchEnd, m_input);
            const auto completed = m_phaseClock.elapsed();
            if (m_inputCount < InputCapacity)
                m_inputs[m_inputCount++] = {m_phase, m_input, m_transactionStartMs + input.dueMs,
                    actual, completed, m_transaction};
            else
                ++m_droppedInputs;
            ++m_input;
            ++m_transactionInput;
            if (m_phase == 2)
                require(completed - m_transactionStartMs <= ActiveMs, "PERF_SCROLL_INPUT_COMPLETED_PAST_30S");
        }
        if (m_transactionInput < tx.inputs.size() || txElapsed < tx.minimumMs)
            return;
        // The scroll gesture's fixed 30s active segment closes before its
        // presentation tail. A late timer observation is retained in wall time.
        if (m_phase == 2 && m_activeSegment) {
            require(m_phaseClock.elapsed() - m_transactionStartMs <= ActiveMs + 100,
                    "PERF_SCROLL_STOP_OBSERVATION_AFTER_100MS_TOLERANCE");
            closeActiveSegment();
            beginWait(6);
        }
        if (tx.ready && !tx.ready()) {
            m_readyObserved = false;
            if (m_phase != 2)
                beginWait(3);
            return;
        }
        if (!m_readyObserved) {
            if (m_phase != 2) endWait();
            m_readyObserved = true;
            m_readyFrames = m_cadence.frames();
            if (m_phase != 2) beginWait(4);
            return;
        }
        const auto frames = m_cadence.frames() - m_readyFrames;
        if (frames < 3)
            return;
        endWait();
        closeActiveSegment();
        auto &segment = m_segments[m_segmentCount - 1];
        segment.framesAfterReady = frames;
        segment.complete = true;
        if (m_mode == "visual" && m_phase == 4 && m_transaction < 4)
            capture(QString("resize-%1x%2-ready").arg(m_window->width()).arg(m_window->height()));
        m_transactionActive = m_readyObserved = false;
        ++m_transaction;
        m_pauseUntilMs = m_phaseClock.elapsed() + HumanPauseMs;
        if (m_transaction < phase.transactions.size())
            beginWait(5);
    }
    void checkVisualMappings(const QString &name) {
        double maxError = 0, maxBlurError = 0;
        int count = 0, blurCount = 0;
        std::function<void(QQuickItem *)> walk = [&](QQuickItem *item) {
            double opacity = 1;
            for (auto *parent = item; parent; parent = parent->parentItem())
                opacity *= parent->opacity();
            if (item->isVisible() && item->isEnabled() && opacity > .2
                    && item->metaObject()->indexOfProperty("sampleMappingValid") >= 0) {
                auto *sceneRoot = qobject_cast<QQuickItem *>(item->property("sceneRoot").value<QObject *>());
                auto *material = qobject_cast<QQuickItem *>(item->property("background").value<QObject *>());
                if (!material)
                    material = visualFind(item, "glassMaterial", false);
                if (sceneRoot && material && material->width() > 0 && material->height() > 0) {
                    require(item->property("sampleMappingValid").toBool(), "PERF_VISUAL_MAPPING_INVALID:" + name);
                    const auto origin = item->property("sampleOrigin").value<QVector2D>();
                    const auto axisX = item->property("sampleAxisX").value<QVector2D>();
                    const auto axisY = item->property("sampleAxisY").value<QVector2D>();
                    const auto sample = item->property("sceneSampleRect").toRectF();
                    for (const auto &corner : {QPointF(0, 0), QPointF(1, 0), QPointF(0, 1), QPointF(1, 1)}) {
                        const auto mapped = material->mapToItem(sceneRoot,
                            QPointF(material->width() * corner.x(), material->height() * corner.y()));
                        const auto reconstructed = QPointF(
                            sample.x() + (origin.x() + corner.x() * axisX.x() + corner.y() * axisY.x()) * sample.width(),
                            sample.y() + (origin.y() + corner.x() * axisX.y() + corner.y() * axisY.y()) * sample.height());
                        maxError = std::max(maxError, QLineF(mapped, reconstructed).length());
                    }
                    const std::array<const char *, 4> blurProperties{
                        "blurSampleOrigin", "blurSampleAxisX", "blurSampleAxisY", "blurSampleRect"};
                    const int blurPropertiesPresent = std::count_if(blurProperties.begin(), blurProperties.end(),
                        [item](const char *property) { return item->metaObject()->indexOfProperty(property) >= 0; });
                    if (blurPropertiesPresent) {
                        require(blurPropertiesPresent == int(blurProperties.size()),
                                "PERF_VISUAL_BLUR_BASIS_INCOMPLETE:" + name);
                        const auto blurOrigin = item->property("blurSampleOrigin").value<QVector2D>();
                        const auto blurAxisX = item->property("blurSampleAxisX").value<QVector2D>();
                        const auto blurAxisY = item->property("blurSampleAxisY").value<QVector2D>();
                        const auto blurSample = item->property("blurSampleRect").toRectF();
                        require(blurSample.width() > 0 && blurSample.height() > 0,
                                "PERF_VISUAL_BLUR_SAMPLE_RECT_INVALID:" + name);
                        for (const auto &corner : {QPointF(0, 0), QPointF(1, 0), QPointF(0, 1), QPointF(1, 1)}) {
                            const auto mapped = material->mapToItem(sceneRoot,
                                QPointF(material->width() * corner.x(), material->height() * corner.y()));
                            const auto reconstructed = QPointF(
                                blurSample.x() + (blurOrigin.x() + corner.x() * blurAxisX.x() + corner.y() * blurAxisY.x()) * blurSample.width(),
                                blurSample.y() + (blurOrigin.y() + corner.x() * blurAxisX.y() + corner.y() * blurAxisY.y()) * blurSample.height());
                            const double error = QLineF(mapped, reconstructed).length();
                            require(std::isfinite(error) && error <= .1,
                                    "PERF_VISUAL_BLUR_UV_MAPPING_FAILED:" + name);
                            maxBlurError = std::max(maxBlurError, error);
                        }
                        ++blurCount;
                    }
                    ++count;
                }
            }
            for (auto *child : item->childItems())
                walk(child);
        };
        walk(m_window->contentItem());
        require(count >= 2 && maxError <= .1, "PERF_VISUAL_UV_MAPPING_FAILED:" + name);
        m_mappingChecks.append(QVariantMap{{"name", name}, {"panes", count},
            {"maxErrorLogicalPixels", maxError}, {"toleranceLogicalPixels", .1},
            {"blurBasisPanes", blurCount}, {"blurBasisMaxErrorLogicalPixels", blurCount ? QVariant(maxBlurError) : QVariant()},
            {"blurBasisMode", blurCount ? "independent-blur-basis" : "sharp-basis-fallback"}});
    }
    QVariantMap windowState() const {
        QVariantMap state{{"observedUnixMs", QDateTime::currentMSecsSinceEpoch()},
            {"registered", bool(m_window)}, {"isActive", m_window && m_window->isActive()},
            {"isExposed", m_window && m_window->isExposed()}, {"isVisible", m_window && m_window->isVisible()}};
        if (!m_window)
            return state;
        state["width"] = m_window->width();
        state["height"] = m_window->height();
        state["devicePixelRatio"] = m_window->devicePixelRatio();
        auto *screen = m_window->screen();
        state["screenAvailable"] = bool(screen);
        state["screenName"] = screen ? screen->name() : QString();
        state["screenRefreshRateHz"] = screen && screen->refreshRate() > 0 ? QVariant(screen->refreshRate()) : QVariant();
        state["refreshRateScope"] = "QScreen reported rate, not measured presentation cadence";
        return state;
    }
    QVariantMap readRestoreCounters() const {
        QVariantMap counters;
        for (const auto *name : RestoreCounterNames) {
            const auto value = m_chat ? m_chat->property(name) : QVariant();
            bool readable = false;
            const auto count = value.toLongLong(&readable);
            counters[QString::fromLatin1(name)] = value.isValid() && !value.isNull()
                && readable && count >= 0 ? QVariant(count) : QVariant();
        }
        return counters;
    }
    QVariantMap restoreCounterReport(const PhaseSample &sample) const {
        QVariantMap delta;
        bool measured = true;
        for (const auto *name : RestoreCounterNames) {
            const QString key = QString::fromLatin1(name);
            const auto first = sample.restoreStart.value(key), last = sample.restoreEnd.value(key);
            const bool known = first.isValid() && !first.isNull() && last.isValid() && !last.isNull()
                && last.toLongLong() >= first.toLongLong();
            measured &= known;
            delta[key] = known ? QVariant(last.toLongLong() - first.toLongLong()) : QVariant();
        }
        return {{"measured", measured},
            {"start", sample.restoreStart.isEmpty() ? QVariant() : QVariant(sample.restoreStart)},
            {"end", sample.restoreEnd.isEmpty() ? QVariant() : QVariant(sample.restoreEnd)},
            {"delta", delta}};
    }
    QVariantMap environmentFlags() const {
        bool registered = true, active = true, exposed = true, visible = true, positiveSize = true;
        bool dprKnown = true, dprStable = true, refreshKnown = true, refreshStable = true;
        bool screenKnown = true, screenStable = true, allComplete = true;
        double referenceDpr = -1, referenceRefresh = -1;
        QString referenceScreen;
        int observedEdges = 0;
        for (const auto &phase : m_phaseSamples) {
            allComplete &= phase.complete;
            for (const auto &edge : {phase.windowStart, phase.windowEnd}) {
                if (edge.isEmpty()) {
                    registered = false;
                    continue;
                }
                ++observedEdges;
                registered &= edge.value("registered").toBool();
                active &= edge.value("isActive").toBool();
                exposed &= edge.value("isExposed").toBool();
                visible &= edge.value("isVisible").toBool();
                positiveSize &= edge.value("width").toInt() > 0 && edge.value("height").toInt() > 0;
                const double dpr = edge.value("devicePixelRatio").toDouble();
                const bool knownDpr = std::isfinite(dpr) && dpr > 0;
                dprKnown &= knownDpr;
                if (knownDpr) {
                    if (referenceDpr < 0) referenceDpr = dpr;
                    else dprStable &= std::abs(dpr - referenceDpr) < .001;
                }
                const double refresh = edge.value("screenRefreshRateHz").toDouble();
                const bool knownRefresh = !edge.value("screenRefreshRateHz").isNull() && std::isfinite(refresh) && refresh > 0;
                refreshKnown &= knownRefresh;
                if (knownRefresh) {
                    if (referenceRefresh < 0) referenceRefresh = refresh;
                    else refreshStable &= std::abs(refresh - referenceRefresh) < .01;
                }
                const QString screen = edge.value("screenName").toString();
                screenKnown &= edge.value("screenAvailable").toBool() && !screen.isEmpty();
                if (referenceScreen.isEmpty()) referenceScreen = screen;
                else screenStable &= screen == referenceScreen;
            }
        }
        const bool recordingDisabled = m_window && !m_window->property("reverieRecording").toBool();
        const bool noDroppedRecords = !m_cadence.state->dropped && !m_droppedInputs;
        const bool comparable = registered && observedEdges == m_phases.size() * 2 && allComplete
            && active && exposed && visible && positiveSize && dprKnown && dprStable
            && refreshKnown && refreshStable && screenKnown && screenStable && recordingDisabled && noDroppedRecords;
        return {{"observedPhaseEdges", observedEdges}, {"expectedPhaseEdges", m_phases.size() * 2},
            {"windowRegisteredAtAllEdges", registered}, {"windowActiveAtAllEdges", active},
            {"windowExposedAtAllEdges", exposed}, {"windowVisibleAtAllEdges", visible},
            {"windowSizePositiveAtAllEdges", positiveSize}, {"devicePixelRatioKnown", dprKnown},
            {"devicePixelRatioStable", dprStable}, {"screenKnown", screenKnown}, {"screenStable", screenStable},
            {"screenRefreshRateKnown", refreshKnown}, {"screenRefreshRateStable", refreshStable},
            {"allPhasesComplete", allComplete}, {"recordingDisabled", recordingDisabled},
            {"noDroppedRecords", noDroppedRecords}, {"comparable", comparable},
            {"scope", "Phase-edge observations only; A/B matching must compare the recorded screen, DPR, refresh rate and phase viewport sizes. Does not establish absence of transient focus/occlusion changes or identical thermal state."}};
    }
    void capture(const QString &name) {
        require(m_mode == "visual", "PERF_CAPTURE_OUTSIDE_VISUAL_MODE");
        checkVisualMappings(name);
        const QString path = m_prefix + "." + name + ".png";
        const auto snapshot = m_window->grabWindow();
        require(!snapshot.isNull() && snapshot.save(path), "PERF_VISUAL_CAPTURE_FAILED:" + name);
        m_captures.append(QVariantMap{{"name", name}, {"path", path}});
    }
    void tick() {
        if (m_finished || m_inTick) {
            TimingTrace::point(TimingTrace::Kind::TimeoutRejected, m_inTick, m_finished);
            return;
        }
        TimingTrace::setContext(m_phase, m_input);
        TimingTrace::Scope work(TimingTrace::Kind::WorkTick, m_phase, m_input);
        m_inTick = true;
        boundary(BoundaryKind::TickEntry);
        try {
            require(m_window && m_session && m_editor, "PERF_WINDOW_SESSION_OR_EDITOR_DESTROYED");
            require(m_total.elapsed() < (diagnosticCase() ? caseDeadlineMs()
                    : supplemental() ? SupplementalTotalDeadlineMs : TotalDeadlineMs),
                    "PERF_TOTAL_DEADLINE_EXCEEDED");
            if (m_phase < 0)
                initialize();
            if (m_phase >= m_phases.size()) {
                m_inTick = false;
                finish(true);
                return;
            }
            auto &phase = m_phases[m_phase];
            if (!m_measuring) {
                if (!m_prepared) {
                    m_prepared = true;
                    m_prepareClock.restart();
                    if (phase.prepare)
                        phase.prepare();
                }
                require((m_controlRequested && !m_targetStarted) || m_prepareClock.elapsed() < 15000,
                        "PERF_PHASE_READINESS_TIMEOUT:" + phase.name);
                if (!processPreparationNavigation()) {
                    m_inTick = false;
                    return;
                }
                if (!phase.ready || phase.ready()) {
                    if (phase.name == "resize-950-760-1180" && !m_resizeComposer.isEmpty())
                        startMeasurement();
                    else
                        beginPhase();
                }
            } else {
                if (supplemental() && phase.active) {
                    tickTransactions();
                    m_inTick = false;
                    return;
                }
                const auto elapsed = m_phaseClock.elapsed();
                while (m_input < phase.inputs.size() && phase.inputs[m_input].dueMs <= elapsed) {
                    const auto &input = phase.inputs[m_input];
                    if (input.ready && !input.ready())
                        break;
                    const qint64 actual = m_phaseClock.elapsed();
                    TimingTrace::setContext(m_phase, m_input);
                    { TimingTrace::Scope dispatch(TimingTrace::Kind::InputDispatch, m_input, input.dueMs);
                      input.execute(); }
                    if (m_inputCount < InputCapacity)
                        m_inputs[m_inputCount++] = {m_phase, m_input, input.dueMs, actual, m_phaseClock.elapsed()};
                    else
                        ++m_droppedInputs;
                    ++m_input;
                }
                if (m_phaseClock.elapsed() >= phase.durationMs)
                    completePhase();
            }
        } catch (const std::exception &error) {
            work.fail();
            m_inTick = false;
            finish(false, QString::fromUtf8(error.what()));
            return;
        }
        m_inTick = false;
    }
    QVariantMap report(bool passed, const QString &error) {
        QVariantList phases, rawCadence, inputs, replies;
        qint64 coldFirstCycleEndMs = -1;
        for (int entry = 0; entry < m_inputCount; ++entry) {
            const auto &input = m_inputs[entry];
            if (input.phase == 0 && m_phases[0].inputs[input.action].name == "warm-reading-open") {
                coldFirstCycleEndMs = input.actualMs;
                break;
            }
        }
        {
            QMutexLocker lock(&m_cadence.state->mutex);
            for (int index = 0; index < m_cadence.state->count; ++index) {
                const auto &sample = m_cadence.state->samples[index];
                QVariantMap frame{{"phaseIndex", sample.phase}, {"endMs", sample.endNs / 1000000.},
                    {"phaseElapsedEndMs", (sample.endNs + m_phaseSamples[sample.phase].cadencePhaseClockOffsetNs) / 1000000.},
                    {"intervalMs", sample.intervalNs / 1000000.}};
                if (supplemental()) {
                    if (sample.segment >= 0)
                        frame["activeSegmentIndex"] = sample.segment;
                    else
                        frame["cadenceScope"] = "idle-phase";
                    frame["phaseElapsedEndMs"] = sample.endNs / 1000000.;
                }
                rawCadence.append(frame);
            }
            for (int index = 0; index < m_phases.size(); ++index) {
                const auto &phase = m_phases[index];
                const auto &sample = m_phaseSamples[index];
                QVector<double> cadence, cold, warm, dispatchDelay;
                for (int entry = 0; entry < m_cadence.state->count; ++entry) {
                    const auto &frame = m_cadence.state->samples[entry];
                    if (frame.phase != index)
                        continue;
                    const double ms = frame.intervalNs / 1000000.;
                    cadence.append(ms);
                    // A long interval beginning in the first cycle remains
                    // cold even if it ends after the warm-cycle dispatch.
                    if (index == 0 && (coldFirstCycleEndMs < 0
                            || frame.endNs - frame.intervalNs + (supplemental() ? 0 : sample.cadencePhaseClockOffsetNs)
                                < coldFirstCycleEndMs * 1000000))
                        cold.append(ms);
                    else
                        warm.append(ms);
                }
                for (int entry = 0; entry < m_inputCount; ++entry)
                    if (m_inputs[entry].phase == index)
                        dispatchDelay.append(m_inputs[entry].actualMs - m_inputs[entry].plannedMs);
                const double wall = sample.endMs - sample.startMs;
                const double cpu = sample.cpuEndMs - sample.cpuStartMs;
                const auto mainCadence = distribution(cadence);
                phases.append(QVariantMap{{"index", index}, {"name", phase.name}, {"active", phase.active},
                    {"plannedDurationMs", phase.durationMs}, {"minimumIntervals", phase.active ? MinimumActiveIntervals : 0},
                    {"startElapsedMs", sample.startMs}, {"endElapsedMs", sample.endMs}, {"durationMs", wall},
                    {"startUnixMs", sample.startUnixMs}, {"endUnixMs", sample.endUnixMs}, {"complete", sample.complete},
                    {"cadencePhaseClockOffsetMs", m_mode == "visual" ? QVariant() : QVariant(sample.cadencePhaseClockOffsetNs / 1000000.)},
                    {"plannedInputs", sample.plannedInputs}, {"dispatchedInputs", sample.dispatchedInputs}, {"qtEvents", sample.qtEvents},
                    {"setupNavigationBarrierMs", sample.navigationBarrierMs},
                    {"setupAfterAnimatingPasses", sample.navigationBarrierFrames},
                    {"windowStateStart", sample.windowStart}, {"windowStateEnd", sample.windowEnd},
                    {"readingRestoreCounters", restoreCounterReport(sample)},
                    {"cadence", mainCadence}, {"mainCadence", mainCadence},
                    {"coldFirstCycleEndMs", index == 0 && coldFirstCycleEndMs >= 0 ? QVariant(coldFirstCycleEndMs) : QVariant()},
                    {"coldFirstCadence", distribution(cold)}, {"warmCadence", distribution(warm)},
                    {"inputDispatchLateness", distribution(dispatchDelay)},
                    {"processCpuMs", m_mode == "visual" || sample.cpuStartMs < 0 || sample.cpuEndMs < 0 ? QVariant() : QVariant(cpu)},
                    {"processCpuPercentOneCore", m_mode == "visual" || sample.cpuStartMs < 0 || sample.cpuEndMs < 0 || wall <= 0
                        ? QVariant() : QVariant(cpu * 100. / wall)}});
            }
        }
        for (int index = 0; index < m_inputCount; ++index) {
            const auto &input = m_inputs[index];
            QVariantMap entry{{"phaseIndex", input.phase}, {"actionIndex", input.action},
                {"name", m_phases[input.phase].inputs[input.action].name}, {"plannedDueMs", input.plannedMs},
                {"actualDispatchMs", input.actualMs}, {"completedMs", input.completedMs}, {"latenessMs", input.actualMs - input.plannedMs}};
            if (supplemental()) entry["transactionIndex"] = input.transaction;
            inputs.append(entry);
        }
        if (m_session)
            for (int index = 0; index < int(ReplyPrompts.size()); ++index) {
                auto evidence = replyEvidence(index);
                if (supplemental()) {
                    evidence["assistantUtf8Bytes"] = QVariant();
                    evidence["assistantTextSha256"] = QVariant();
                    if (!m_replyRequestIds[index].isEmpty() && evidence.value("complete").toBool()) {
                        QByteArray text;
                        for (const auto &value : m_session->messages()) {
                            const auto row = value.toMap();
                            if (row.value("role") == "assistant" && row.value("request_id") == m_replyRequestIds[index])
                                text.append(row.value("content").toString().toUtf8());
                        }
                        evidence["assistantUtf8Bytes"] = text.size();
                        evidence["assistantTextSha256"] = QString::fromLatin1(QCryptographicHash::hash(text,
                            QCryptographicHash::Sha256).toHex());
                    }
                }
                replies.append(evidence);
            }
        const auto flags = environmentFlags();
        QVariantMap result{{"schema", "reverie.qt.performance-scenarios.v1"}, {"passed", passed}, {"error", error},
            {"protocol", m_protocol},
            {"mode", m_mode}, {"fixtureRows", m_rows}, {"runStartUnixMs", m_startUnixMs},
            {"elapsedMs", m_total.isValid() ? m_total.elapsed() : 0}, {"phase", m_phase < m_phases.size() && m_phase >= 0 ? m_phases[m_phase].name : "complete"},
            {"performanceComparable", passed && m_mode == "perf" && flags.value("comparable").toBool()},
            {"environmentFlags", flags}, {"cadenceMeasured", m_mode != "visual"},
            {"processCpuMeasured", m_mode != "visual"},
            {"action", m_phase >= 0 && m_phase < m_phases.size() && m_input < m_phases[m_phase].inputs.size()
                ? m_phases[m_phase].inputs[m_input].name : QString()},
            {"cadenceMethod", "steady_clock frameSwapped intervals; frame presentation cadence, not GPU duration or input-to-display latency"},
            {"scheduleVersion", "moonroom-fixed-controls-v1"},
            {"formalCadenceField", "phases[].mainCadence (cadence is an identical compatibility alias)"},
            {"coldFirstCycleEndMs", coldFirstCycleEndMs >= 0 ? QVariant(coldFirstCycleEndMs) : QVariant()},
            {"qtShaderDiskCacheDisabled", QCoreApplication::testAttribute(Qt::AA_DisableShaderDiskCache)},
            {"coldWarmScope", "Cold-first is the complete first scripted reading-open/reverse/task cycle of phase 0 (nominal 0..6 seconds after bootstrap), ending at the first warm-reading-open actual dispatch. Intervals starting before that edge remain cold, including intervals crossing it. Missing that input leaves warm unknown/empty. This is first-use workload in a fresh process, not cold application launch or cleared OS/driver/disk cache. Qt shader disk cache state is reported separately. All later phases are warmed by preceding real-control work; cold/warm subsets have no 300-interval guarantee and are separate from the formal mainCadence P95 gate."},
            {"readingRestoreInstrumentationVersion", "persistent-chat-restore-counters-v1"},
            {"readingRestoreCounterScope", "Persistent ChatPanel lifetime counters read once per phase start/end, with edge differences: scheduleReadingRestore entry requests; real restore execution after held-pointer early return; each actual history.forceLayout invocation. Missing, unreadable or decreasing counters are unknown/null. Counts are work evidence, not latency or GPU timing; A/B counter semantics and source placement require the same reviewed instrumentation."},
            {"cpuScope", "Phase-edge getrusage RUSAGE_SELF user+system CPU; excludes runtime child. Idle CPU is supplemental; display-synchronized cadence alone cannot show GPU improvement."},
            {"inputScope", "Real QTest mouse/wheel/key events on the existing window; synthetic QInputMethodEvent text commits; no physical OS IME acceptance claim"},
            {"schedulerScope", "8ms precise timer; identical planned due times; blocked real input gates defer dispatch and are reported as lateness; no early phase completion"},
            {"setupReadinessScope", "Resize before navigation waits for a subsequent QQuickWindow afterAnimating generation and a fully exposed enabled destination control; setup barrier is outside measurement windows, without fixed sleeps"},
            {"measurementExclusions", "No recording, synchronous window grabs, geometry-tree walks, per-frame QVariant conversion, file writes or diagnostics snapshots in perf windows"},
            {"cadenceCapacity", SampleCapacity}, {"cadenceDropped", m_cadence.state->dropped},
            {"inputCapacity", InputCapacity}, {"inputDropped", m_droppedInputs}, {"phases", phases},
            {"cadenceSamples", rawCadence}, {"inputs", inputs}, {"captures", m_captures}, {"visualMappingChecks", m_mappingChecks},
            {"nativeAvatarActions", m_avatarActions}, {"observedDragMoves", m_dragMoves},
            {"heldSelectionObservations", m_heldPointerObservations}, {"replySendClicks", m_sendClicks},
            {"committedReplies", replies}, {"replyHistoryRowsBefore", m_replyHistoryRowsBefore},
            {"replyHistoryRowsAfter", m_session ? m_session->messages().size() : -1},
            {"replyCompletionScope", "Each of the three exact UI prompts has one accepted user row and one persisted assistant row with its captured request_id; total history growth is not asserted because the ordinary 300-row page cap remains active"},
            {"delayedReplyArrivalMs", m_delayedArrivalMs}, {"delayedReplyArrivedBehindTask", m_delayedArrivedBehindTask},
            {"delayedReplyArrivalScope", "First canonical history refresh containing the delayed request's persisted user+assistant rows; not earliest network or frame presentation time"},
            {"heldSelectionScope", "Real reading press/move/release before task handoff; no claim of retaining a held gesture across a message-model replacement. Existing passive-restore functional checks remain separate."},
            {"scrollContentYMinimum", m_scrollLow}, {"scrollContentYMaximum", m_scrollHigh},
            {"avatarLoadsBefore", m_loads}, {"avatarLoadsAfter", m_avatar ? m_avatar->loads() : -1}};
        if (supplemental())
            supplementalReport(result, phases);
        if (diagnosticCase()) diagnosticReport(result, passed, error);
        return result;
    }
    void diagnosticReport(QVariantMap &result, bool passed, const QString &error) const {
        QVariantList selected, outcomes, violations;
        for (int phaseIndex : m_selectedPhases) {
            selected.append(phaseIndex);
            const auto &phase = m_phases[phaseIndex];
            const auto &sample = m_phaseSamples[phaseIndex];
            if (!sample.startUnixMs) {
                violations.append(QString("PHASE_NOT_EXECUTED:%1").arg(phaseIndex));
                continue;
            }
            const SegmentSample *segment = nullptr;
            if (supplemental() && phaseIndex == 2)
                for (int i = 0; i < m_segmentCount; ++i)
                    if (m_segments[i].phase == 2) { segment = &m_segments[i]; break; }
            const qint64 inputOrigin = segment ? segment->startMs : 0;
            QVariantList late;
            int actual = 0;
            for (int i = 0; i < m_inputCount; ++i) {
                const auto &input = m_inputs[i];
                if (input.phase != phaseIndex) continue;
                ++actual;
                if ((!supplemental() || phaseIndex == 2)
                        && (input.actualMs - inputOrigin > ActiveMs || input.completedMs - inputOrigin > ActiveMs))
                    late.append(QVariantMap{{"actionIndex", input.action},
                        {"plannedRelativeMs", input.plannedMs - inputOrigin},
                        {"dispatchRelativeMs", input.actualMs - inputOrigin},
                        {"completionRelativeMs", input.completedMs - inputOrigin}});
            }
            const qint64 endMs = segment ? segment->endMs - segment->startMs : sample.endMs - sample.startMs;
            const bool fixedWindow = !supplemental() || phaseIndex == 2;
            const int intervalCount = m_cadence.countFor(phaseIndex);
            const bool phasePassed = sample.complete && actual == phase.inputs.size() && late.isEmpty()
                && (!fixedWindow || (endMs >= ActiveMs && endMs <= ActiveMs + 100))
                && intervalCount >= MinimumActiveIntervals;
            outcomes.append(QVariantMap{{"phaseIndex", phaseIndex}, {"name", phase.name}, {"passed", phasePassed},
                {"phaseExecutionComplete", sample.complete}, {"plannedInputs", phase.inputs.size()},
                {"dispatchedInputs", actual}, {"lateInputs", late}, {"activeIntervals", intervalCount},
                {"fixed30SecondWindow", fixedWindow}, {"observedEndRelativeMs", endMs},
                {"endObservationLimitMs", fixedWindow ? QVariant(ActiveMs + 100) : QVariant()}});
            if (!phasePassed) violations.append(QString("SELECTED_PHASE_CONSTRAINT_FAILED:%1").arg(phaseIndex));
        }
        const bool expectedTimingFailure = expectedDiagnosticTimingError(error);
        result["schema"] = "reverie.qt.diagnostic-case.v1";
        result["diagnosticCase"] = m_diagnosticCase;
        result["metaCallContextRequested"] = TimingTrace::metaCallContextEnabled();
        if (TimingTrace::metaCallContextEnabled())
            result["readingRestoreNotificationObservation"] = QVariantMap{{"connectedMask", m_restoreNotifyMask},
                {"expectedMask", 7}, {"scope", "Three existing numeric ChatPanel property notifications observed directly without changing QML; initial snapshots and changed values share the TimingTrace clock, thread, phase and enclosing span. Missing notifications or unreadable values stay unknown. No callback source identity is inferred."}};
        result["performanceComparable"] = false;
        result["collectionComplete"] = m_targetStarted && (passed || expectedTimingFailure)
            && !m_cadence.state->dropped && !m_droppedInputs && !m_boundaryDropped
            && (!TimingTrace::metaCallContextEnabled() || TimingTrace::metaCallContextComplete());
        result["selectedPhaseIndexes"] = selected;
        result["selectedConstraintOutcome"] = QVariantMap{{"passed", violations.isEmpty() && passed},
            {"error", error}, {"violations", violations}, {"phases", outcomes},
            {"scope", "Selected original phases only; never full-protocol or performance acceptance"}};
        result["diagnosticTiming"] = QVariantMap{{"caseLimitMs", caseDeadlineMs()},
            {"targetPhase", targetPhase()}, {"targetStarted", m_targetStarted},
            {"targetStartAbsoluteNs", QString::number(m_targetStartAbsoluteNs)},
            {"targetEndAbsoluteNs", QString::number(m_targetEndAbsoluteNs)},
            {"postrollBeginAbsoluteNs", QString::number(m_postrollBeginNs)}, {"postrollLimitMs", 2000},
            {"captureCutoffAbsoluteNs", m_postrollBeginNs ? QVariant(QString::number(m_postrollBeginNs + 2000000000LL)) : QVariant()},
            {"scope", "Shared steady_clock absolute timestamps; legacy ClockAnchor records total and phase clock samples, not identical-origin assumptions"}};
        result["diagnosticInitialStateScope"] = m_diagnosticCase == "scroll-tail-with-prefix"
            ? "Original companion navigation and drag prefix retained; target phase only is traced"
            : "Standalone selected phase after ordinary isolated bootstrap; cache/model state is not asserted equal to a complete protocol prefix";
        result["diagnosticSelectedWorkloadModelRequestsExpected"] = 0;
        result["diagnosticBootstrapProviderProbesExpected"] = 1;
    }
    void supplementalReport(QVariantMap &result, QVariantList phases) const {
        QVariantList segments, boundaries, crossings, planned;
        QVector<double> crossingIntervals;
        for (int index = 0; index < m_segmentCount; ++index) {
            const auto &segment = m_segments[index];
            segments.append(QVariantMap{{"index", index}, {"phaseIndex", segment.phase},
                {"transactionIndex", segment.transaction},
                {"name", m_phases[segment.phase].transactions[segment.transaction].name},
                {"startMs", segment.startMs}, {"endMs", segment.endMs},
                {"durationMs", segment.endMs - segment.startMs},
                {"processCpuMs", segment.cpuStartMs >= 0 && segment.cpuEndMs >= 0
                    ? QVariant(segment.cpuEndMs - segment.cpuStartMs) : QVariant()},
                {"framesAfterReady", qulonglong(segment.framesAfterReady)}, {"complete", segment.complete}});
        }
        for (int index = 0; index < m_boundaryCount; ++index) {
            const auto &entry = m_boundaries[index];
            boundaries.append(QVariantMap{{"elapsedNs", entry.elapsedNs}, {"phaseIndex", entry.phase},
                {"transactionIndex", entry.transaction}, {"kind", entry.kind}, {"detail", entry.detail}});
        }
        {
            QMutexLocker lock(&m_cadence.state->mutex);
            for (int index = 0; index < m_cadence.state->crossingCount; ++index) {
                const auto &entry = m_cadence.state->crossings[index];
                const double duration = entry.intervalNs / 1000000.;
                crossingIntervals.append(duration);
                crossings.append(QVariantMap{{"phaseIndex", entry.phase}, {"activeSegmentIndex", entry.segment},
                    {"phaseElapsedEndMs", entry.endNs / 1000000.}, {"intervalMs", duration},
                    {"boundaryKind", entry.boundaryKind == 1 ? "enter-active" : "leave-active"}});
            }
        }
        for (int index = 0; index < 6; ++index) {
            const auto &phase = m_phases[index];
            const auto &sample = m_phaseSamples[index];
            auto phaseReport = phases[index].toMap();
            phaseReport["plannedTransactions"] = phase.transactions.size();
            int completed = 0;
            for (int segmentIndex = 0; segmentIndex < m_segmentCount; ++segmentIndex)
                if (m_segments[segmentIndex].phase == index && m_segments[segmentIndex].complete)
                    ++completed;
            phaseReport["completedTransactions"] = completed;
            phaseReport["activeDurationMs"] = sample.activeMs;
            phaseReport["activeProcessCpuMs"] = m_mode == "visual" ? QVariant() : QVariant(sample.activeCpuMs);
            phaseReport["phaseWallProcessCpuMs"] = phaseReport.value("processCpuMs");
            phaseReport["phaseWallProcessCpuPercentOneCore"] = phaseReport.value("processCpuPercentOneCore");
            phaseReport["processCpuMs"] = m_mode == "visual" ? QVariant() : QVariant(sample.activeCpuMs);
            phaseReport["processCpuPercentOneCore"] = m_mode == "visual" || sample.activeMs <= 0
                ? QVariant() : QVariant(sample.activeCpuMs * 100. / sample.activeMs);
            phaseReport["pauseMs"] = sample.pauseMs;
            phaseReport["backendWaitMs"] = sample.backendWaitMs;
            phaseReport["gateWaitMs"] = sample.gateWaitMs;
            phaseReport["tailSettleMs"] = sample.tailSettleMs;
            phases[index] = phaseReport;
            QVariantList transactions;
            for (int txIndex = 0; txIndex < phase.transactions.size(); ++txIndex) {
                const auto &tx = phase.transactions[txIndex];
                QVariantList inputs;
                for (const auto &input : tx.inputs)
                    inputs.append(QVariantMap{{"name", input.name}, {"dueMs", input.dueMs}});
                transactions.append(QVariantMap{{"index", txIndex}, {"name", tx.name},
                    {"minimumMs", tx.minimumMs}, {"backendGate", tx.backendGate}, {"inputs", inputs}});
            }
            planned.append(QVariantMap{{"phaseIndex", index}, {"name", phase.name},
                {"transactionCount", phase.transactions.size()}, {"inputCount", phase.inputs.size()},
                {"transactions", transactions}});
        }
        result["schema"] = "reverie.qt.companion-transactions.v1";
        result["scheduleVersion"] = "moonroom-companion-transactions-v1";
        result["phases"] = phases;
        result["activeSegments"] = segments;
        result["driverBoundaries"] = boundaries;
        result["driverBoundaryKinds"] = QVariantList{"tick-entry", "readiness-wait-begin", "readiness-wait-end",
            "dispatch-begin", "dispatch-end", "cadence-stop-begin", "cadence-stop-end",
            "phase-property-clear-begin", "phase-property-clear-end", "phase-end-observation"};
        result["readinessWaitDetails"] = QVariantMap{{"1", "input-gate-outside-active"},
            {"2", "backend-completion-outside-active"}, {"3", "semantic-readiness-inside-active"},
            {"4", "actual-presentation-after-ready-inside-active"},
            {"5", "human-pause-outside-active"}, {"6", "scroll-presentation-tail-outside-active"}};
        result["driverBoundaryCapacity"] = BoundaryCapacity;
        result["driverBoundaryDropped"] = m_boundaryDropped;
        result["boundaryCrossingCadence"] = distribution(crossingIntervals);
        result["boundaryCrossingSamples"] = crossings;
        result["boundaryCrossingScope"] = "Full physical frameSwapped interval at active entry/exit, retained separately from within-segment cadence. One physical interval can carry both an exit and an entry tag if no frame was observed in between. No presentation after final probe disconnection is observed";
        result["plannedTransactionContract"] = QVariantMap{
            {"version", "companion-transactions-v1"},
            {"scenario", "A user completes each navigation, drag, edit or resize before beginning the next operation; continuous scrolling and chat task handoff are separately fixed workloads"},
            {"navigationCycles", 26}, {"dragCycles", 12}, {"composerChanges", 180}, {"resizeSteps", 160},
            {"driverTransactions", 591}, {"driverActions", 1016}, {"controlRelatedDispatches", 1013},
            {"driverOnlyCompletionObservations", 3},
            {"scrollWheelEvents", 300}, {"scrollEventPeriodMs", 100}, {"scrollGestureMs", ActiveMs},
            {"scrollStopObservationToleranceMs", 100}, {"scrollInputDeadlineMs", ActiveMs},
            {"replyRequests", 3}, {"delayedReplyMockMs", 8000}, {"delayedTaskHandoffEarliestAfterSendMs", 1500},
            {"whileWaitingTaskTransitions", 8}, {"postReplyMemorySettingsReadingCycles", 12},
            {"humanPauseMs", HumanPauseMs}, {"actualFramesAfterSemanticReady", 3},
            {"minimumActiveIntervalsPerPhase", MinimumActiveIntervals},
            {"transactionTimeoutMs", TransactionDeadlineMs},
            {"preDispatchGateTimeoutMs", TransactionDeadlineMs},
            {"activeTransactionTimeoutMs", TransactionDeadlineMs},
            {"scrollActiveAndTailTimeoutMs", ActiveMs + TransactionDeadlineMs},
            {"continuousScrollTransactionTimeoutMs", ActiveMs + TransactionDeadlineMs},
            {"phaseTimeoutMs", SupplementalPhaseDeadlineMs}, {"historyTimeoutMs", SupplementalTotalDeadlineMs},
            {"deadlineScope", "Pre-dispatch gate and active transaction have separate 15s deadlines; transactionTimeoutMs is the compatible active deadline. Continuous scroll active gesture plus presentation tail has a 45s deadline. Total phase 600s includes all gates, active work and human pauses; history 1800s includes preparation and idle phases"},
            {"resizeViewports", QVariantList{QVariantList{950, 760}, QVariantList{760, 650},
                QVariantList{1180, 760}, QVariantList{1380, 900}}},
            {"fixedBeforeGui", true}, {"appendRepetitionsToPass", false}, {"phasePlan", planned}};
        result["cadenceMethod"] = "Actual steady_clock frameSwapped intervals contained in one active transaction segment; long intervals retained. Segment-crossing intervals are excluded from mainCadence and fully reported in boundaryCrossingSamples, never converted to short intervals";
        result["cpuScope"] = "Active segment getrusage RUSAGE_SELF user+system CPU sums over active durations; phaseWallProcessCpuMs and wall duration retain total phase cost. Human pause, pre-dispatch gates, explicit backend completion wait and scroll tail are excluded from active CPU/cadence. Runtime child CPU is excluded";
        result["schedulerScope"] = "Fixed work counts; dispatch each transaction after prior semantic readiness and 3 actual frameSwapped observations. Human 150ms pauses excluded. Scroll has exactly 300 due events at 100ms over 30s with separate presentation tail. Insufficient 300 active intervals fails without extending counts";
        result["coldWarmScope"] = "First fixed navigation cycle until the second cycle's warm-reading-open actual dispatch; only within-active-segment intervals enter cold/warm subsets. Segment-crossing intervals are reported separately. Main phase gate remains at least 300 actual active intervals";
        result["assistantTextHashScope"] = "For complete nonempty captured request_id only, concatenate UTF-8 assistant content in canonical history order without separators; complete evidence requires exactly one row; lowercase SHA256. Missing/incomplete evidence has null hash and byte count";
        result["driverActionScope"] = "The fixed contract separately counts control-related dispatches and no-op canonical reply completion observations. qtEvents records actual QTest mouse/wheel/key and synthetic text-commit event counts; driver actions are not QTest-event counts";
    }
    void finish(bool passed, const QString &error = {}) {
        if (m_finished)
            return;
        m_finished = true;
        m_timer.stop();
        if (supplemental() && m_measuring && m_phase >= 0 && m_phase < m_phases.size()) {
            endWait();
            closeActiveSegment();
        }
        QObject::disconnect(m_preparationAnimationConnection);
        m_cadence.stop();
        if (m_window)
            m_window->setProperty("reveriePerfPhase", QString());
        if (m_pointerHeld && m_window) {
            QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_pointerEnd.toPoint(), 0);
            m_pointerHeld = m_selectionHeld = false;
        }
        // Report conversion occurs after all probes have stopped. Restore only
        // the owned viewport; the disposable caller handles process/data cleanup.
        if (m_measuring && m_phase >= 0 && m_phase < m_phaseSamples.size()) {
            auto &sample = m_phaseSamples[m_phase];
            if (!sample.endMs) {
                sample.endMs = m_total.elapsed();
                sample.endUnixMs = QDateTime::currentMSecsSinceEpoch();
                sample.cpuEndMs = m_mode == "visual" ? -1 : processCpuMs();
                sample.restoreEnd = readRestoreCounters();
                sample.windowEnd = windowState();
                sample.dispatchedInputs = m_input;
                sample.qtEvents = m_qtEvents;
            }
        }
        QString finalError = error;
        if (passed && (m_cadence.state->dropped || m_droppedInputs || m_boundaryDropped)) {
            passed = false;
            finalError = "PERF_BOUNDED_SAMPLE_BUFFER_DROPPED_RECORDS";
        }
        if (diagnosticCase() && m_targetStarted) {
            if (!m_targetEndAbsoluteNs) m_targetEndAbsoluteNs = TimingTrace::nowNs();
            m_postrollBeginNs = TimingTrace::nowNs();
            TimingTrace::setCutoffNs(m_postrollBeginNs + 2000000000LL);
            TimingTrace::targetPhaseDone(targetPhase(), QDateTime::currentMSecsSinceEpoch(), passed);
            QTimer::singleShot(2000, this, [this, passed, finalError] {
                finishAfterControl(passed, finalError);
            });
            return;
        }
        emitReport(passed, finalError);
    }
    void finishAfterControl(bool passed, QString error) {
        const auto controlError = TimingTrace::controlError();
        if (!controlError.isEmpty()) {
            passed = false;
            error = "TIMING_DIAGNOSTIC_CONTROL_FAILED";
        } else if (!TimingTrace::finishReady(targetPhase())) {
            if (TimingTrace::nowNs() - m_postrollBeginNs < 17000000000LL) {
                QTimer::singleShot(50, this, [this, passed, error] { finishAfterControl(passed, error); });
                return;
            }
            passed = false;
            error = "TIMING_DIAGNOSTIC_FLUSH_ACK_TIMEOUT";
        }
        emitReport(passed, error);
    }
    void emitReport(bool passed, const QString &finalError) {
        TimingTrace::point(TimingTrace::Kind::Finished, passed, m_phase);
        if (diagnosticCase() && m_targetStarted)
            TimingTrace::phaseEnded(targetPhase(), QDateTime::currentMSecsSinceEpoch(), passed);
        const auto result = report(passed, finalError);
        if (m_window && !m_originalSize.isEmpty())
            m_window->resize(m_originalSize);
        auto completion = std::move(m_completion);
        if (completion)
            completion(result);
        deleteLater();
    }
};
} // namespace

void PerfScenarioCheck::run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor,
                            const QString &mode, int fixtureRows, const QString &reportPrefix,
                            Completion completion, const QString &protocol, const QString &diagnosticCase) {
#if defined(REVERIE_TIMING_DIAGNOSTICS) || defined(REVERIE_QML_PROFILER)
    if (SmoothnessCheck::requested()) {
        SmoothnessCheck::run(window, session, editor, std::move(completion));
        return;
    }
#endif
    if (HeaderFrameLocalCheck::requested()) {
        HeaderFrameLocalCheck::run(window, session, mode, fixtureRows, reportPrefix,
                                  std::move(completion), protocol, diagnosticCase);
        return;
    }
    if (!window || !session || !editor) {
        QTimer::singleShot(0, [completion = std::move(completion)] {
            if (completion)
                completion({{"passed", false}, {"error", "PERF_WINDOW_SESSION_AND_EDITOR_REQUIRED"}});
        });
        return;
    }
    new Runner(window, session, editor, mode, fixtureRows, reportPrefix, std::move(completion), protocol, diagnosticCase);
}
