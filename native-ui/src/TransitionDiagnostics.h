#pragma once

#include <QVariantMap>
#include <QString>
#include <QtGlobal>
#include <cstddef>
#include <utility>

class QObject;
class QQuickWindow;

// Independent, opt-in evidence for the unchanged native input scenario.
// Notifications never schedule input or supply a cached ready result.
namespace TransitionDiagnostics {
inline constexpr std::size_t RecordCapacity = 32768;
#ifdef REVERIE_TIMING_DIAGNOSTICS
bool enabled() noexcept;
void start(bool recording, std::size_t capacity = RecordCapacity);
void stop() noexcept;
void attachSurface(const QString &feature, QObject *surface, QObject *owner);
void attachWindow(QQuickWindow *window, QObject *owner);
void setStep(int index, const QString &name);
void point(const char *event, QVariantMap details = {}, bool includeSurfaceState = true) noexcept;
void readyPoll(bool minimumElapsed, bool predicateEvaluated, bool ready, qint64 elapsedMs) noexcept;
void captureBegin(quint64 attempt, qint64 slot) noexcept;
void captureEnd(quint64 attempt, qint64 mediaTimestampNs, bool sourceValid) noexcept;
void frameAppended(quint64 attempt, quint64 frame, qint64 mediaTimestampNs) noexcept;
QVariantMap snapshot();
class HelperScope final {
  public:
    explicit HelperScope(const char *helper, QVariantMap details = {}) noexcept;
    ~HelperScope() noexcept;
    HelperScope(const HelperScope &) = delete;
    HelperScope &operator=(const HelperScope &) = delete;
  private:
    quint64 m_id = 0;
    quint64 m_epoch = 0;
    int m_helperToken = -1;
    int m_uncaught = 0;
};
#else
inline bool enabled() noexcept { return false; }
inline void start(bool, std::size_t = RecordCapacity) {}
inline void stop() noexcept {}
inline void attachSurface(const QString &, QObject *, QObject *) {}
inline void attachWindow(QQuickWindow *, QObject *) {}
inline void setStep(int, const QString &) {}
inline void point(const char *, QVariantMap = {}, bool = true) noexcept {}
inline void readyPoll(bool, bool, bool, qint64) noexcept {}
inline void captureBegin(quint64, qint64) noexcept {}
inline void captureEnd(quint64, qint64, bool) noexcept {}
inline void frameAppended(quint64, quint64, qint64) noexcept {}
inline QVariantMap snapshot() { return {{"compiled", false}, {"enabled", false}}; }
class HelperScope final {
  public:
    explicit HelperScope(const char *, QVariantMap = {}) noexcept {}
};
#endif
template <class Delivery>
decltype(auto) observeHelper(const char *helper, Delivery &&delivery, QVariantMap details = {}) {
    HelperScope scope(helper, std::move(details));
    return std::forward<Delivery>(delivery)();
}
} // namespace TransitionDiagnostics

// Remove instrumentation argument construction from ordinary candidates.
#ifdef REVERIE_TIMING_DIAGNOSTICS
#define REVERIE_TRANSITION_POINT(...) TransitionDiagnostics::point(__VA_ARGS__)
#define REVERIE_TRANSITION_SCOPE(...) TransitionDiagnostics::HelperScope transitionHelperScope(__VA_ARGS__)
#define REVERIE_TRANSITION_OBSERVE(...) TransitionDiagnostics::observeHelper(__VA_ARGS__)
#else
#define REVERIE_TRANSITION_POINT(...) ((void)0)
#define REVERIE_TRANSITION_SCOPE(...) ((void)0)
#define REVERIE_TRANSITION_OBSERVE(helper, ...) (__VA_ARGS__)()
#endif
