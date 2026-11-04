#pragma once

#include <QJsonValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QObject>
#include <QPointer>
#include <QThread>
#include <QVariantMap>
#include <functional>
#include <utility>

// Observes only progress notifications from one header-open step. Readiness is
// consumed by the runner's existing poll; no notification can dispatch input.
class HeaderOpenObservation final : public QObject {
    Q_OBJECT
public:
    explicit HeaderOpenObservation(QObject *parent = nullptr) : QObject(parent) {}
    ~HeaderOpenObservation() override { end(); }

    class ClickScope final {
    public:
        explicit ClickScope(HeaderOpenObservation *observation)
            : m_observation(observation), m_generation(observation->m_generation),
              m_previous(observation->m_inClickHelper) {
            if (observation->m_active)
                observation->m_inClickHelper = true;
        }
        ClickScope(const ClickScope &) = delete;
        ClickScope &operator=(const ClickScope &) = delete;
        ~ClickScope() {
            if (m_observation && m_observation->m_generation == m_generation)
                m_observation->m_inClickHelper = m_previous;
        }
    private:
        QPointer<HeaderOpenObservation> m_observation;
        quint64 m_generation;
        bool m_previous;
    };

    bool begin(QObject *surface, std::function<qint64()> stepElapsed) {
        end();
        m_notificationCount = 0;
        m_latched.clear();
        m_readyPoll.clear();
        m_beforeReverseClick.clear();
        m_lastBelowLower.clear();
        m_firstAtOrAboveUpper.clear();
        if (!surface || !stepElapsed || QThread::currentThread() != thread() ||
            surface->thread() != thread())
            return false;
        const auto *meta = surface->metaObject();
        const int progressIndex = meta->indexOfProperty("progress");
        const int stateIndex = meta->indexOfProperty("transitionState");
        if (progressIndex < 0 || stateIndex < 0)
            return false;
        m_progress = meta->property(progressIndex);
        m_state = meta->property(stateIndex);
        if (!m_progress.isReadable() || !m_progress.hasNotifySignal() || !m_state.isReadable())
            return false;
        m_surface = surface;
        m_stepElapsed = std::move(stepElapsed);
        const int slot = metaObject()->indexOfSlot("observeProgress()");
        m_progressConnection = QObject::connect(surface, m_progress.notifySignal(), this,
            metaObject()->method(slot), Qt::DirectConnection);
        if (!m_progressConnection) {
            end();
            return false;
        }
        m_destroyConnection = QObject::connect(surface, &QObject::destroyed, this,
            [this] { end(); }, Qt::DirectConnection);
        m_active = true;
        return true;
    }

    // Retain observations for later reversal evidence and failure reporting.
    void end() {
        m_active = false;
        m_inClickHelper = false;
        ++m_generation;
        QObject::disconnect(m_progressConnection);
        QObject::disconnect(m_destroyConnection);
        m_progressConnection = {};
        m_destroyConnection = {};
        m_surface.clear();
        m_stepElapsed = {};
    }

    [[nodiscard]] ClickScope clickScope() { return ClickScope(this); }

    bool poll(double progress, const QString &state) {
        if (m_latched.isEmpty())
            return false;
        if (m_active && m_readyPoll.isEmpty())
            m_readyPoll = {{"progress", progress}, {"state", state},
                {"elapsedMs", elapsed()},
                {"originalConstraintSatisfied", inInterval(progress) && state == "opening"}};
        return true;
    }

    QString latchedState() const { return m_latched.value("state").toString(); }

    void recordReverse(double progress, const QString &state) {
        if (m_beforeReverseClick.isEmpty())
            m_beforeReverseClick = {{"progress", progress}, {"state", state}};
    }

    QVariantMap snapshot(bool failure = false) const {
        QVariantMap result{{"latched", observedOrNull(m_latched)},
            {"notificationCount", m_notificationCount},
            {"readyPoll", observedOrNull(m_readyPoll)},
            {"beforeReverseClick", observedOrNull(m_beforeReverseClick)}};
        if (failure) {
            result["lastBelowLower"] = observedOrNull(m_lastBelowLower);
            result["firstAtOrAboveUpper"] = observedOrNull(m_firstAtOrAboveUpper);
        }
        return result;
    }

private slots:
    void observeProgress() {
        if (!m_active || !m_surface || QThread::currentThread() != thread())
            return;
        ++m_notificationCount;
        // Once latched, later notifications only contribute to the count.
        if (!m_latched.isEmpty())
            return;
        bool numeric = false;
        const double progress = m_progress.read(m_surface).toDouble(&numeric);
        if (!numeric)
            return;
        QVariantMap sample{{"progress", progress}, {"state", m_state.read(m_surface).toString()},
            {"elapsedMs", elapsed()}, {"inClickHelper", m_inClickHelper},
            {"notificationOrdinal", m_notificationCount}};
        if (progress < Lower)
            m_lastBelowLower = sample;
        if (progress >= Upper && m_firstAtOrAboveUpper.isEmpty())
            m_firstAtOrAboveUpper = sample;
        if (inInterval(progress))
            m_latched = std::move(sample);
    }

private:
    static constexpr double Lower = .23;
    static constexpr double Upper = .96;
    static bool inInterval(double progress) { return progress > Lower && progress < Upper; }
    static QVariant observedOrNull(const QVariantMap &value) {
        return value.isEmpty() ? QJsonValue(QJsonValue::Null).toVariant() : QVariant(value);
    }
    qint64 elapsed() const { return m_stepElapsed ? m_stepElapsed() : 0; }

    QPointer<QObject> m_surface;
    QMetaProperty m_progress, m_state;
    QMetaObject::Connection m_progressConnection, m_destroyConnection;
    std::function<qint64()> m_stepElapsed;
    bool m_active = false, m_inClickHelper = false;
    quint64 m_generation = 0;
    qint64 m_notificationCount = 0;
    QVariantMap m_latched, m_readyPoll, m_beforeReverseClick;
    QVariantMap m_lastBelowLower, m_firstAtOrAboveUpper;
};
