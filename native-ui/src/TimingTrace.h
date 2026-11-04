#pragma once

#include <QJsonObject>
#include <QString>
#include <QtGlobal>
#include <chrono>
#include <cstddef>
#include <utility>

class QObject;

namespace TimingTrace {
inline constexpr std::size_t RecordCapacity = 524288;
inline constexpr std::size_t MetaCallContextCapacity = 32768;
enum class ReceiverRole : quint8 {
    Unknown, Window, SceneDirector, ChatPanel, ChatHistory, ChatComposer,
    RuntimeBridge, ArchiveEditor, NativeAvatar, Count
};
enum class Kind : quint16 {
    TimeoutArrival, TimeoutRejected, WorkTick, MouseMove, WheelEvent,
    PhaseClose, CadenceStop, PhasePropertyClear, SetPhaseLockWait, SetPhaseAssignment,
    BeforeSync, AfterSync, BeforeRender, AfterRender, FrameSwapped,
    NotifyEvent, DispatcherAwake, DispatcherAboutToBlock, PhaseReady, ControlAck,
    PhaseStarted, TargetPhaseDone, PhaseEnded, InputDispatch, ClockAnchor, Finished,
    ReadingRestoreCounter, Count
};
inline qint64 nowNs() noexcept {
    return std::chrono::duration_cast<std::chrono::nanoseconds>(
        std::chrono::steady_clock::now().time_since_epoch()).count();
}

#ifdef REVERIE_TIMING_DIAGNOSTICS
bool enabled() noexcept;
void start(std::size_t recordLimit = RecordCapacity);
void stop() noexcept;
void setCutoffNs(qint64 absoluteSteadyNs) noexcept;
void point(Kind kind, qint64 a = 0, qint64 b = 0) noexcept;
void setContext(int phase, int input) noexcept;
QJsonObject snapshot();
// Opt-in before start(); only the diagnostic reading-close entry may enable it.
void setMetaCallContextEnabled(bool enabled, std::size_t limit = MetaCallContextCapacity) noexcept;
bool metaCallContextEnabled() noexcept;
bool metaCallContextComplete() noexcept;
void setReceiverRole(ReceiverRole role, QObject *receiver);
// One observer for the three existing numeric ChatPanel property notifications.
// Bit i reports whether property i was connected; unavailable values stay unknown.
quint8 observeReadingRestoreCounters(QObject *chat, QObject *owner);

class Scope final {
public:
    explicit Scope(Kind kind, qint64 a = 0, qint64 b = 0) noexcept;
    ~Scope() noexcept;
    Scope(const Scope &) = delete;
    Scope &operator=(const Scope &) = delete;
    void fail() noexcept { m_failed = true; }
    void captureMetaCallReceiver(QObject *receiver) noexcept;
private:
    quint64 m_span = 0, m_parent = 0, m_epoch = 0;
    qint64 m_a = 0, m_b = 0;
    int m_uncaught = 0, m_depth = -1;
    Kind m_kind = Kind::NotifyEvent;
    bool m_failed = false, m_beginRecorded = false;
};

// Optional inherited private fd4; no socket listener or diagnostic service.
// start/stop never destroy this channel or its acknowledgement state.
bool configureControl(QObject *owner, int fd, const QString &diagnosticCase,
                      const QString &protocol, int rows);
void setObservedWindow(QObject *window);
bool phaseReady(int phase);
bool controlReady(int phase);
bool finishReady(int phase);
QString controlError();
void phaseStarted(int phase, qint64 unixMs);
void targetPhaseDone(int phase, qint64 unixMs, bool passed);
void phaseEnded(int phase, qint64 unixMs, bool passed);
#else
inline bool enabled() noexcept { return false; }
inline void start(std::size_t = RecordCapacity) {}
inline void stop() noexcept {}
inline void setCutoffNs(qint64) noexcept {}
inline void point(Kind, qint64 = 0, qint64 = 0) noexcept {}
inline void setContext(int, int) noexcept {}
inline QJsonObject snapshot() { return {{"compiled", false}, {"enabled", false}}; }
inline void setMetaCallContextEnabled(bool, std::size_t = MetaCallContextCapacity) noexcept {}
inline bool metaCallContextEnabled() noexcept { return false; }
inline bool metaCallContextComplete() noexcept { return true; }
inline void setReceiverRole(ReceiverRole, QObject *) {}
inline quint8 observeReadingRestoreCounters(QObject *, QObject *) { return 0; }
class Scope final {
public:
    explicit Scope(Kind, qint64 = 0, qint64 = 0) noexcept {}
    void fail() noexcept {}
    void captureMetaCallReceiver(QObject *) noexcept {}
};
inline bool configureControl(QObject *, int, const QString &, const QString &, int) { return false; }
inline void setObservedWindow(QObject *) {}
inline bool phaseReady(int) { return true; }
inline bool controlReady(int) { return true; }
inline bool finishReady(int) { return true; }
inline QString controlError() { return {}; }
inline void phaseStarted(int, qint64) {}
inline void targetPhaseDone(int, qint64, bool) {}
inline void phaseEnded(int, qint64, bool) {}
#endif
template<class Delivery>
bool observeNotification(int eventType, bool isObservedWindow, Delivery &&delivery) {
    Scope span(Kind::NotifyEvent, eventType, isObservedWindow);
    return std::forward<Delivery>(delivery)();
}
template<class Delivery>
bool observeNotification(QObject *receiver, int eventType, bool isObservedWindow, Delivery &&delivery) {
    Scope span(Kind::NotifyEvent, eventType, isObservedWindow);
    span.captureMetaCallReceiver(receiver);
    return std::forward<Delivery>(delivery)();
}
} // namespace TimingTrace

#ifdef REVERIE_TIMING_DIAGNOSTICS
#include <QGuiApplication>
class TimingGuiApplication final : public QGuiApplication {
public:
    TimingGuiApplication(int &argc, char **argv);
    bool notify(QObject *receiver, QEvent *event) override;
};
#endif
