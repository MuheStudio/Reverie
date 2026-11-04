#pragma once

#include <QMutex>
#include <QMutexLocker>
#include <QVariantList>
#include <QVariantMap>
#include <algorithm>
#include <array>
#include <atomic>
#include <chrono>
#include <memory>
#include <thread>
#include <utility>
#include <vector>

// Numeric observations only. This collector neither drives a window nor
// changes the header-open readiness/latch. Public notifications are points;
// they are never converted to spans for the private work which preceded them.
namespace HeaderOpenTiming {
inline constexpr int EventCapacity = 4096;
inline constexpr int WindowCapacity = 2;
inline constexpr qint64 PreRollNs = 500000000;
inline constexpr qint64 TimerIntervalNs = 20000000;

enum class Feature : int { None, Memory, Settings };
enum class Kind : int {
    BeforeSync, AfterSync, BeforeRender, AfterRender, FrameSwapped, AfterAnimating,
    Timer, Click, AvatarCounters, AvatarRendered, Progress, ComponentReady,
    BridgeChanged, BridgeMessages, BridgeDraft, BridgePanel, BridgeAvatar, BridgeGame,
    BridgeCommandResult, BridgeShutdown, BridgeReady, BridgeRestore, BridgeSettings,
    BridgeResponse, BridgeRequestFailed, Count
};
enum class Sample : int { Initial, Click, StatisticsNotify, RenderedNotify, Timer, AfterAnimating };
enum class Transition : int { Unknown, Closed, Opening, Open, Closing, Dragging };
enum class Command : int { None, Memory, Settings, Persona, Worldbook, Backup, Chat, Budget, Other };
enum class Outcome : int { Running, StepComplete, CheckFailed, SourceDestroyed, RunnerDestroyed };

inline const char *featureName(Feature value) {
    switch (value) {
    case Feature::Memory: return "memory";
    case Feature::Settings: return "settings";
    default: return "none";
    }
}
inline const char *kindName(Kind value) {
    switch (value) {
    case Kind::BeforeSync: return "before-sync";
    case Kind::AfterSync: return "after-sync";
    case Kind::BeforeRender: return "before-render";
    case Kind::AfterRender: return "after-render";
    case Kind::FrameSwapped: return "frame-swapped";
    case Kind::AfterAnimating: return "after-animating";
    case Kind::Timer: return "timer";
    case Kind::Click: return "click-call";
    case Kind::AvatarCounters: return "avatar-counter-observation";
    case Kind::AvatarRendered: return "avatar-rendered-notification";
    case Kind::Progress: return "progress-notification";
    case Kind::ComponentReady: return "component-ready-observation";
    case Kind::BridgeChanged: return "bridge-changed-notification";
    case Kind::BridgeMessages: return "bridge-messages-notification";
    case Kind::BridgeDraft: return "bridge-draft-notification";
    case Kind::BridgePanel: return "bridge-panel-notification";
    case Kind::BridgeAvatar: return "bridge-avatar-notification";
    case Kind::BridgeGame: return "bridge-game-notification";
    case Kind::BridgeCommandResult: return "bridge-command-result-notification";
    case Kind::BridgeShutdown: return "bridge-shutdown-notification";
    case Kind::BridgeReady: return "bridge-ready-notification";
    case Kind::BridgeRestore: return "bridge-restore-notification";
    case Kind::BridgeSettings: return "bridge-settings-notification";
    case Kind::BridgeResponse: return "bridge-response-notification";
    case Kind::BridgeRequestFailed: return "bridge-request-failed-notification";
    default: return "unknown";
    }
}
inline const char *sampleName(Sample value) {
    switch (value) {
    case Sample::Initial: return "initial";
    case Sample::Click: return "click";
    case Sample::StatisticsNotify: return "statistics-notification";
    case Sample::RenderedNotify: return "rendered-notification";
    case Sample::Timer: return "timer-observation";
    case Sample::AfterAnimating: return "after-animating-observation";
    }
    return "unknown";
}
inline const char *transitionName(Transition value) {
    switch (value) {
    case Transition::Closed: return "closed";
    case Transition::Opening: return "opening";
    case Transition::Open: return "open";
    case Transition::Closing: return "closing";
    case Transition::Dragging: return "dragging";
    default: return "unknown";
    }
}
inline const char *commandName(Command value) {
    switch (value) {
    case Command::Memory: return "memory";
    case Command::Settings: return "settings";
    case Command::Persona: return "persona";
    case Command::Worldbook: return "worldbook";
    case Command::Backup: return "backup";
    case Command::Chat: return "chat";
    case Command::Budget: return "budget";
    case Command::Other: return "other";
    default: return "none";
    }
}
inline const char *outcomeName(Outcome value) {
    switch (value) {
    case Outcome::StepComplete: return "step-complete";
    case Outcome::CheckFailed: return "check-failed";
    case Outcome::SourceDestroyed: return "source-destroyed";
    case Outcome::RunnerDestroyed: return "runner-destroyed";
    default: return "running";
    }
}
struct Counters {
    bool available = false;
    qint64 atNs = 0, loads = 0, releases = 0, frames = 0;
};
struct Event {
    qint64 atNs = -1, a = 0, b = 0, c = 0;
    quint64 seq = 0, kindOrdinal = 0;
    Kind kind = Kind::BeforeSync;
    Feature feature = Feature::None;
    int detail = 0, threadToken = 0;
    double value = 0;
    bool threadIsGui = false, flag = false;
};
struct WindowMeta {
    Feature feature = Feature::None;
    int stepIndex = -1, count = 0;
    qint64 preparedNs = 0, clickNs = 0, endNs = 0, firstDroppedNs = 0, lastDroppedNs = 0;
    quint64 dropped = 0;
    bool clicked = false, ended = false, preRollCapacityTruncated = false, inFlightTruncated = false;
    unsigned inFlightCallbacksAtShutdown = 0;
    Outcome outcome = Outcome::Running;
    Counters avatarAtClick;
    bool loadAverageAvailable = false;
    double loadAverage1m = 0;
};
struct Window : WindowMeta { std::array<Event, EventCapacity> events; };
struct State {
    QMutex mutex;
    const std::chrono::steady_clock::time_point epoch = std::chrono::steady_clock::now();
    const std::thread::id guiThread = std::this_thread::get_id();
    std::atomic<bool> accepting{true};
    std::atomic<unsigned> inFlight{0};
    std::array<std::thread::id, 8> threads{guiThread};
    int threadCount = 1;
    quint64 threadTokenOverflow = 0;
    bool installed = false;
    Outcome stopOutcome = Outcome::Running;
    qint64 coverageStartNs = 0, stoppedNs = 0, latestNs = 0;
    quint64 nextSeq = 0, rollingCapacityEvictions = 0, windowStartsDropped = 0;
    qint64 firstRollingEvictionNs = 0, lastRollingEvictionNs = 0;
    std::array<quint64, int(Kind::Count)> kindOrdinals{};
    std::array<Event, EventCapacity> rolling;
    int head = 0, count = 0, windowCount = 0, current = -1;
    std::array<Window, WindowCapacity> windows;
};
using SharedState = std::shared_ptr<State>;

inline qint64 nowNs(const SharedState &state) noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now() - state->epoch).count();
}
inline void windowAppend(Window &window, const Event &event) noexcept {
    if (window.count < EventCapacity) window.events[window.count++] = event;
    else {
        if (!window.dropped) window.firstDroppedNs = window.lastDroppedNs = event.atNs;
        else {
            window.firstDroppedNs = std::min(window.firstDroppedNs, event.atNs);
            window.lastDroppedNs = std::max(window.lastDroppedNs, event.atNs);
        }
        ++window.dropped;
    }
}
inline void appendLocked(State &state, Event event) noexcept {
    event.seq = ++state.nextSeq;
    event.kindOrdinal = ++state.kindOrdinals[int(event.kind)];
    state.latestNs = std::max(state.latestNs, event.atNs);
    const qint64 cutoff = state.latestNs - PreRollNs;
    while (state.count && state.rolling[state.head].atNs < cutoff) {
        state.head = (state.head + 1) % EventCapacity;
        --state.count;
    }
    if (state.count == EventCapacity) {
        const auto evicted = state.rolling[state.head].atNs;
        if (!state.rollingCapacityEvictions) state.firstRollingEvictionNs = evicted;
        else state.firstRollingEvictionNs = std::min(state.firstRollingEvictionNs, evicted);
        state.lastRollingEvictionNs = std::max(state.lastRollingEvictionNs, evicted);
        ++state.rollingCapacityEvictions;
        state.head = (state.head + 1) % EventCapacity;
        --state.count;
    }
    state.rolling[(state.head + state.count++) % EventCapacity] = event;
    for (int i = 0; i < state.windowCount; ++i) {
        auto &window = state.windows[i];
        const qint64 anchor = window.clicked ? window.clickNs : window.preparedNs;
        if (event.atNs >= anchor - PreRollNs && (!window.ended || event.atNs <= window.endNs))
            windowAppend(window, event);
    }
}
// Render callbacks capture only this shared state and a fixed Kind. No QObject
// property, allocation, QVariant or serialization is used in this function.
inline void point(const SharedState &state, Event event) noexcept {
    if (!state->accepting.load(std::memory_order_acquire)) return;
    state->inFlight.fetch_add(1, std::memory_order_acq_rel);
    if (event.atNs < 0) event.atNs = nowNs(state);
    const auto thread = std::this_thread::get_id();
    event.threadIsGui = thread == state->guiThread;
    QMutexLocker lock(&state->mutex);
    if (state->accepting.load(std::memory_order_acquire)) {
        for (int i = 0; i < state->threadCount; ++i)
            if (state->threads[i] == thread) { event.threadToken = i + 1; break; }
        if (!event.threadToken) {
            if (state->threadCount < int(state->threads.size())) {
                state->threads[state->threadCount++] = thread; event.threadToken = state->threadCount;
            } else ++state->threadTokenOverflow;
        }
        appendLocked(*state, event);
    }
    state->inFlight.fetch_sub(1, std::memory_order_acq_rel);
}
inline void point(const SharedState &state, Kind kind) noexcept {
    Event event; event.kind = kind; point(state, event);
}
inline QVariantMap countersMap(const Counters &value) {
    QVariantMap result{{"available", value.available}};
    if (value.available) {
        result["atNs"] = value.atNs; result["loads"] = value.loads;
        result["releases"] = value.releases; result["frames"] = value.frames;
    }
    return result;
}
inline QVariantMap eventMap(const Event &event, const WindowMeta &window) {
    QVariantMap result{{"seq", qulonglong(event.seq)}, {"kindOrdinal", qulonglong(event.kindOrdinal)},
        {"atNs", event.atNs}, {"kind", kindName(event.kind)},
        {"threadIsGui", event.threadIsGui}, {"threadToken", event.threadToken}, {"feature", featureName(event.feature)}};
    if (window.clicked) result["relativeToClickNs"] = event.atNs - window.clickNs;
    switch (event.kind) {
    case Kind::Timer:
        result["expectedNs"] = event.a; result["actualNs"] = event.atNs;
        result["delayNs"] = event.atNs - event.a;
        result["missedNominalIntervals"] = std::max(qint64(0), event.atNs - event.a) / TimerIntervalNs;
        break;
    case Kind::AvatarCounters:
        result["loads"] = event.a; result["releases"] = event.b; result["frames"] = event.c;
        result["observation"] = sampleName(Sample(event.detail));
        break;
    case Kind::AvatarRendered: result["ok"] = event.flag; break;
    case Kind::Progress:
        result["progress"] = event.value; result["transitionState"] = transitionName(Transition(event.detail));
        break;
    case Kind::ComponentReady:
        result["ready"] = event.flag; result["initial"] = event.detail != 0;
        break;
    case Kind::BridgeResponse:
    case Kind::BridgeCommandResult: result["commandCategory"] = commandName(Command(event.detail)); break;
    default: break;
    }
    return result;
}

class Recorder final {
public:
    SharedState state = std::make_shared<State>();
    void installed(QVariantMap availability, Counters initial) {
        m_availability = std::move(availability);
        m_initial = initial;
        QMutexLocker lock(&state->mutex);
        state->coverageStartNs = nowNs(state);
        state->installed = true;
    }
    void prepare(Feature feature, int stepIndex) {
        QMutexLocker lock(&state->mutex);
        if (!state->accepting.load(std::memory_order_acquire)) return;
        if (state->current >= 0 || state->windowCount >= WindowCapacity) { ++state->windowStartsDropped; return; }
        auto &window = state->windows[state->windowCount];
        window.feature = feature; window.stepIndex = stepIndex; window.preparedNs = nowNs(state);
        const auto cutoff = window.preparedNs - PreRollNs;
        for (int i = 0; i < state->count; ++i) {
            const auto &event = state->rolling[(state->head + i) % EventCapacity];
            if (event.atNs >= cutoff && event.atNs <= window.preparedNs) windowAppend(window, event);
        }
        state->current = state->windowCount++;
    }
    bool awaitingClick(Feature feature) const {
        QMutexLocker lock(&state->mutex);
        return state->current >= 0 && !state->windows[state->current].clicked &&
            state->windows[state->current].feature == feature;
    }
    void click(Counters avatar, bool loadAvailable, double load) {
        QMutexLocker lock(&state->mutex);
        if (state->current < 0) return;
        auto &window = state->windows[state->current];
        if (window.clicked) return;
        window.avatarAtClick = avatar;
        window.loadAverageAvailable = loadAvailable; window.loadAverage1m = load;
        window.clickNs = nowNs(state); window.clicked = true;
        window.preRollCapacityTruncated = state->rollingCapacityEvictions &&
            state->lastRollingEvictionNs >= window.clickNs - PreRollNs &&
            state->firstRollingEvictionNs <= window.clickNs;
        Event event; event.kind = Kind::Click; event.feature = window.feature;
        event.atNs = window.clickNs; event.threadIsGui = true; event.threadToken = 1;
        appendLocked(*state, event);
    }
    void endStep(int stepIndex) {
        QMutexLocker lock(&state->mutex);
        if (state->current < 0 || state->windows[state->current].stepIndex != stepIndex) return;
        endLocked(Outcome::StepComplete);
    }
    void stop(Outcome outcome) noexcept {
        QMutexLocker lock(&state->mutex);
        if (!state->accepting.exchange(false, std::memory_order_acq_rel)) return;
        if (state->current >= 0) endLocked(outcome);
        state->stopOutcome = outcome;
        state->stoppedNs = nowNs(state);
        // A callback which entered before shutdown may still be waiting for
        // this lock. Preserve honest incompleteness instead of calling its
        // missing point a complete stream; no wait on the render thread.
        const auto pending = state->inFlight.load(std::memory_order_acquire);
        if (pending)
            for (int i = 0; i < state->windowCount; ++i) {
                state->windows[i].inFlightTruncated = true;
                state->windows[i].inFlightCallbacksAtShutdown = pending;
            }
    }
    QVariantMap snapshot() const {
        struct Copy { WindowMeta meta; std::vector<Event> events; };
        // Allocate/copy metadata storage before locking. QVariant/JSON building
        // below happens only after the numeric stream has been copied out.
        auto copies = std::make_unique<std::array<Copy, WindowCapacity>>();
        for (auto &copy : *copies) copy.events.reserve(EventCapacity);
        int count; bool installed; qint64 coverage, stopped; quint64 evictions, threadOverflow, windowDrops; Outcome stopOutcome;
        {
            QMutexLocker lock(&state->mutex);
            count = state->windowCount; installed = state->installed;
            coverage = state->coverageStartNs; stopped = state->stoppedNs;
            stopOutcome = state->stopOutcome;
            evictions = state->rollingCapacityEvictions;
            windowDrops = state->windowStartsDropped;
            threadOverflow = state->threadTokenOverflow;
            for (int i = 0; i < count; ++i) {
                auto &copy = (*copies)[i]; const auto &window = state->windows[i];
                copy.meta = static_cast<const WindowMeta &>(window);
                copy.events.assign(window.events.begin(), window.events.begin() + window.count);
            }
        }
        QVariantList windows;
        for (int i = 0; i < count; ++i) {
            const auto &copy = (*copies)[i]; const auto &window = copy.meta;
            const qint64 anchor = window.clicked ? window.clickNs : window.preparedNs;
            const qint64 covered = std::clamp(anchor - coverage, qint64(0), PreRollNs);
            QVariantMap result{{"feature", featureName(window.feature)}, {"stepIndex", window.stepIndex},
                {"preparedNs", window.preparedNs}, {"clickObserved", window.clicked},
                {"ended", window.ended}, {"endNs", window.endNs}, {"outcome", outcomeName(window.outcome)},
                {"requestedPreRollNs", PreRollNs}, {"actualPreRollNs", covered},
                {"preRollTruncated", !installed || covered < PreRollNs},
                {"preRollCapacityTruncated", window.preRollCapacityTruncated},
                {"recordTruncated", bool(window.dropped || window.preRollCapacityTruncated || window.inFlightTruncated)},
                {"droppedEvents", qulonglong(window.dropped)}, {"inFlightAtShutdown", window.inFlightTruncated},
                {"droppedEventsScope", "window-buffer-capacity-only"},
                {"preRollDroppedCountKnown", !window.preRollCapacityTruncated},
                {"inFlightCallbacksAtShutdown", window.inFlightCallbacksAtShutdown},
                {"dropRangeKnown", !window.preRollCapacityTruncated && !window.inFlightTruncated},
                {"avatarAtClick", countersMap(window.avatarAtClick)}};
            if (window.clicked) result["clickNs"] = window.clickNs;
            if (window.dropped) {
                result["firstDroppedNs"] = window.firstDroppedNs;
                result["lastDroppedNs"] = window.lastDroppedNs;
            }
            QVariantMap load{{"available", window.loadAverageAvailable}};
            if (window.loadAverageAvailable) load["value"] = window.loadAverage1m;
            result["loadAverage1m"] = load;
            QVariantList events;
            for (const auto &event : copy.events)
                if (event.atNs >= anchor - PreRollNs && (!window.ended || event.atNs <= window.endNs))
                    events.append(eventMap(event, window));
            result["eventCount"] = events.size(); result["events"] = events;
            windows.append(result);
        }
        return {{"schema", "reverie.qt.header-open-diagnostics.v1"}, {"clock", "steady-clock"},
            {"unit", "ns-relative-to-observer-start"}, {"installed", installed},
            {"coverageStartNs", coverage}, {"stoppedNs", stopped}, {"availability", m_availability},
            {"coverageScope", "subscription-time-coverage-not-proof-of-lossless-event-stream"},
            {"observerStopReason", outcomeName(stopOutcome)},
            {"avatarAtObserverStart", countersMap(m_initial)},
            {"limits", QVariantMap{{"rollingEvents", EventCapacity}, {"eventsPerWindow", EventCapacity},
                {"windows", WindowCapacity}, {"timerIntervalNs", TimerIntervalNs}, {"preRollNs", PreRollNs}}},
            {"rollingCapacityEvictions", qulonglong(evictions)}, {"windows", windows},
            {"windowStartsDropped", qulonglong(windowDrops)}, {"windowCapacityTruncated", bool(windowDrops)},
            {"threadTokenCapacity", 8}, {"threadTokenOverflow", qulonglong(threadOverflow)},
            {"threadTokenScope", "observer-local-identities-gui-is-one-zero-is-unavailable"},
            {"privateWorkSpans", "unobservable"}, {"mainScreenshotSpans", "unobservable"},
            {"notificationScope", "public-notification-or-counter-observation-point-only"},
            {"shutdownInFlightScope", "pending-callback-time-unresolved-all-windows-conservatively-incomplete"},
            {"frameScope", "Qt-signal-callback-entry-not-GPU-duration-or-physical-presentation"},
            {"sequenceScope", "insertion-order-timestamps-may-interleave-between-threads"}};
    }
private:
    QVariantMap m_availability;
    Counters m_initial;
    void endLocked(Outcome outcome) noexcept {
        auto &window = state->windows[state->current];
        window.endNs = nowNs(state); window.ended = true; window.outcome = outcome;
        state->current = -1;
    }
};
} // namespace HeaderOpenTiming
