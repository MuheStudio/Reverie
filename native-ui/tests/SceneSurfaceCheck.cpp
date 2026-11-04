#include "SceneSurfaceCheck.h"
#include "SceneOcclusionProbe.h"
#include "ShortcutHandoff.h"
#include "HeaderOpenObservation.h"
#include "HeaderOpenTiming.h"
#include "HeaderFrameTiming.h"
#include "HeaderFrameThermal.h"
#include "ArchiveControlReadiness.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include "../src/TransitionDiagnostics.h"
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QHash>
#include <QJSValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QMutex>
#include <QMutexLocker>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QQmlContext>
#include <QQmlEngine>
#include <QTest>
#include <QThread>
#include <QTimer>
#include <QVector2D>
#include <QWheelEvent>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdlib>
#include <memory>
#include <stdexcept>
#include <utility>

namespace {
using Action = std::function<void()>;
using Predicate = std::function<bool()>;
struct Step {
    QString name;
    Action enter;
    Predicate ready;
    Action validate;
    int minimumMs = 0;
    int timeoutMs = 2500;
};
struct FrameSample {
    double milliseconds;
    QString phase;
};
struct TimingState {
    QMutex mutex;
    QString phase;
    std::chrono::steady_clock::time_point previous;
    bool havePrevious = false;
    QVector<FrameSample> frames;
    int droppedSamples = 0;
};

void require(bool condition, const QString &reason) {
    if (!condition)
        throw std::runtime_error(reason.toStdString());
}
QPointF pointFromMap(const QVariant &value) {
    const auto map = value.toMap();
    return {map.value("x").toDouble(), map.value("y").toDouble()};
}
QQuickItem *itemProperty(QObject *object, const char *name) {
    return qobject_cast<QQuickItem *>(object->property(name).value<QObject *>());
}
QQuickItem *visualFind(QQuickItem *root, const QString &name, bool usable) {
    if (!root)
        return nullptr;
    if (root->objectName() == name && (!usable || (root->isVisible() && root->isEnabled())))
        return root;
    for (auto *child : root->childItems())
        if (auto *found = visualFind(child, name, usable))
            return found;
    return nullptr;
}
bool isWithin(QQuickItem *item, QQuickItem *ancestor) {
    for (auto *current = item; current; current = current->parentItem())
        if (current == ancestor)
            return true;
    return false;
}
double effectiveOpacity(QQuickItem *item) {
    double opacity = 1;
    for (auto *current = item; current; current = current->parentItem())
        opacity *= current->opacity();
    return opacity;
}
QRectF sceneRect(QQuickItem *item) {
    return item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
}

class HeaderOpenTimingObserver final : public QObject {
    Q_OBJECT
public:
    ~HeaderOpenTimingObserver() override { stop(HeaderOpenTiming::Outcome::RunnerDestroyed); }

    void install(QQuickWindow *window, NativeAvatar *avatar) {
        using namespace HeaderOpenTiming;
        m_avatar = avatar;
        const auto state = m_recorder.state;
        QVariantMap availability;
        const auto renderSignal = [&](auto signal, Kind kind, const char *key) {
            availability[key] = watch(connect(window, signal, this,
                [state, kind] { point(state, kind); }, Qt::DirectConnection));
        };
        renderSignal(&QQuickWindow::beforeSynchronizing, Kind::BeforeSync, "beforeSync");
        renderSignal(&QQuickWindow::afterSynchronizing, Kind::AfterSync, "afterSync");
        renderSignal(&QQuickWindow::beforeRendering, Kind::BeforeRender, "beforeRender");
        renderSignal(&QQuickWindow::afterRendering, Kind::AfterRender, "afterRender");
        renderSignal(&QQuickWindow::frameSwapped, Kind::FrameSwapped, "frameSwapped");
        availability["afterAnimating"] = watch(connect(window, &QQuickWindow::afterAnimating, this,
            [this, state] {
                point(state, Kind::AfterAnimating);
                sampleAvatar(Sample::AfterAnimating);
            }, Qt::DirectConnection));
        watch(connect(window, &QObject::destroyed, this,
            [this] { stop(Outcome::SourceDestroyed); }, Qt::DirectConnection));
        const bool avatarReadable = avatar && avatar->thread() == thread();
        availability["avatarCounters"] = avatarReadable;
        if (avatarReadable) {
            availability["avatarStatisticsNotify"] = watch(connect(avatar, &NativeAvatar::statisticsChanged,
                this, [this] { sampleAvatar(Sample::StatisticsNotify); }, Qt::DirectConnection));
            availability["avatarRenderedNotify"] = watch(connect(avatar, &NativeAvatar::rendered, this,
                [this, state](bool ok, const QString &, const QString &) {
                    Event event; event.kind = Kind::AvatarRendered; event.flag = ok;
                    point(state, event);
                    sampleAvatar(Sample::RenderedNotify);
                }, Qt::DirectConnection));
            watch(connect(avatar, &QObject::destroyed, this,
                [this] { stop(Outcome::SourceDestroyed); }, Qt::DirectConnection));
        }
        auto *context = QQmlEngine::contextForObject(window);
        QObject *session = nullptr;
        if (context) {
            const auto value = context->contextProperty("session");
            session = value.metaType() == QMetaType::fromType<QJSValue>()
                ? value.value<QJSValue>().toQObject() : value.value<QObject *>();
        }
        auto *bridge = qobject_cast<RuntimeBridge *>(session);
        availability["bridgePublicNotifications"] = bridge && bridge->thread() == thread();
        if (bridge && bridge->thread() == thread()) {
            const auto bridgeSignal = [&](auto signal, Kind kind) {
                return watch(connect(bridge, signal, this,
                    [state, kind] { point(state, kind); }, Qt::DirectConnection));
            };
            QVariantMap notifications;
            notifications["changed"] = bridgeSignal(&RuntimeBridge::changed, Kind::BridgeChanged);
            notifications["messagesChanged"] = bridgeSignal(&RuntimeBridge::messagesChanged, Kind::BridgeMessages);
            notifications["draftChanged"] = bridgeSignal(&RuntimeBridge::draftChanged, Kind::BridgeDraft);
            notifications["panelChanged"] = bridgeSignal(&RuntimeBridge::panelChanged, Kind::BridgePanel);
            notifications["avatarChanged"] = bridgeSignal(&RuntimeBridge::avatarChanged, Kind::BridgeAvatar);
            notifications["gameChanged"] = bridgeSignal(&RuntimeBridge::gameChanged, Kind::BridgeGame);
            notifications["shutdownComplete"] = bridgeSignal(&RuntimeBridge::shutdownComplete, Kind::BridgeShutdown);
            notifications["validatedReady"] = bridgeSignal(&RuntimeBridge::validatedReady, Kind::BridgeReady);
            notifications["backupRestoreReconciled"] = bridgeSignal(&RuntimeBridge::backupRestoreReconciled, Kind::BridgeRestore);
            notifications["settingsRead"] = bridgeSignal(&RuntimeBridge::settingsRead, Kind::BridgeSettings);
            notifications["requestFailed"] = bridgeSignal(&RuntimeBridge::requestFailed, Kind::BridgeRequestFailed);
            notifications["responseReceived"] = watch(connect(bridge, &RuntimeBridge::responseReceived, this,
                [state](const QString &, const QString &command, const QVariantMap &, int) {
                    Event event; event.kind = Kind::BridgeResponse; event.detail = int(commandCategory(command));
                    point(state, event);
                }, Qt::DirectConnection));
            notifications["commandResult"] = watch(connect(bridge, &RuntimeBridge::commandResult, this,
                [state](const QString &command, const QVariantMap &) {
                    Event event; event.kind = Kind::BridgeCommandResult; event.detail = int(commandCategory(command));
                    point(state, event);
                }, Qt::DirectConnection));
            availability["bridgeSignals"] = notifications;
            watch(connect(bridge, &QObject::destroyed, this,
                [this] { stop(Outcome::SourceDestroyed); }, Qt::DirectConnection));
        }
        QVariantMap surfaces, initialComponents;
        for (int i = 0; i < 2; ++i) {
            const auto feature = i == 0 ? Feature::Memory : Feature::Settings;
            auto *surface = visualFind(window->contentItem(), "drawer-" + QString::fromLatin1(featureName(feature)), false);
            m_surfaces[i] = surface;
            QVariantMap source;
            bool initialAvailable = false, initialValue = false;
            if (surface && surface->thread() == thread()) {
                const auto *meta = surface->metaObject();
                m_progress[i] = property(meta, "progress");
                m_transition[i] = property(meta, "transitionState");
                m_component[i] = property(meta, "componentReady");
                const auto bind = [&](const QMetaProperty &value, const char *slot) {
                    const int index = metaObject()->indexOfSlot(slot);
                    return value.isReadable() && value.hasNotifySignal() && index >= 0 && watch(
                        QObject::connect(surface, value.notifySignal(), this, metaObject()->method(index), Qt::DirectConnection));
                };
                source["progressNotify"] = m_transition[i].isReadable() && bind(m_progress[i],
                    i == 0 ? "memoryProgress()" : "settingsProgress()");
                source["componentReadyNotify"] = bind(m_component[i],
                    i == 0 ? "memoryComponent()" : "settingsComponent()");
                initialAvailable = m_component[i].isReadable();
                if (initialAvailable) {
                    initialValue = m_component[i].read(surface).toBool();
                    observeComponent(i, true);
                }
                watch(connect(surface, &QObject::destroyed, this,
                    [this] { stop(Outcome::SourceDestroyed); }, Qt::DirectConnection));
            } else {
                source["progressNotify"] = false; source["componentReadyNotify"] = false;
            }
            surfaces[featureName(feature)] = source;
            QVariantMap initial{{"available", initialAvailable}};
            if (initialAvailable) initial["ready"] = initialValue;
            initialComponents[featureName(feature)] = initial;
        }
        availability["surfaces"] = surfaces;
        availability["componentReadyAtInstall"] = initialComponents;
        availability["backendProcessingSpan"] = "unobservable";
        availability["avatarLoadSpan"] = "unobservable";
        availability["avatarTextureUploadSpan"] = "unobservable";
        availability["avatarFirstFrameReadbackSpan"] = "unobservable";
        availability["componentCreationSpan"] = "unobservable";
        availability["checkerScreenshotSpan"] = "not-observed-in-checker-window";
        availability["mainScreenshotSpan"] = "unobservable";
        availability["guiWorkSpans"] = "not-instrumented";
        availability["connectionCapacity"] = int(m_connections.size());
        availability["connectionsDropped"] = m_connectionsDropped;
        availability["connectionsInstalled"] = m_connectionCount;
        m_delayTimer.setInterval(int(TimerIntervalNs / 1000000));
        m_delayTimer.setTimerType(Qt::PreciseTimer);
        m_nextTimerNs = nowNs(state) + TimerIntervalNs;
        connect(&m_delayTimer, &QTimer::timeout, this, [this, state] {
            const auto actual = nowNs(state);
            Event event; event.kind = Kind::Timer; event.atNs = actual; event.a = m_nextTimerNs;
            point(state, event);
            const auto lateIntervals = std::max(qint64(0), actual - m_nextTimerNs) / TimerIntervalNs;
            m_nextTimerNs += (lateIntervals + 1) * TimerIntervalNs;
            sampleAvatar(Sample::Timer);
        });
        m_delayTimer.start();
        availability["timer"] = m_delayTimer.isActive();
        const auto initial = sampleAvatar(Sample::Initial, true);
        m_recorder.installed(std::move(availability), initial);
        m_thermalAtObserverStart = thermalSnapshot();
        // Ordinary checks keep CPU/thermal evidence; GPU stays uncollected
        // until a replacement method passes positive control and review.
        m_gpuTiming = std::make_unique<HeaderFrameTiming::Observer>(window,
            [state] { return HeaderOpenTiming::nowNs(state); }, HeaderFrameTiming::Options{});
    }
    void prepare(const QString &feature, int stepIndex) {
        if (m_stopped) return;
        m_pending = feature == "memory" ? HeaderOpenTiming::Feature::Memory : HeaderOpenTiming::Feature::Settings;
        m_recorder.prepare(m_pending, stepIndex);
    }
    void beforeClick(const QString &name) {
        using namespace HeaderOpenTiming;
        if (m_stopped || m_pending == Feature::None ||
            name != "portal-" + QString::fromLatin1(featureName(m_pending)) || !m_recorder.awaitingClick(m_pending)) return;
        const auto counters = sampleAvatar(Sample::Click, true);
        double load = 0;
        const bool loadAvailable = ::getloadavg(&load, 1) == 1 && std::isfinite(load) && load >= 0;
        m_recorder.click(counters, loadAvailable, load);
        m_thermalAtClick[m_pending == Feature::Memory ? 0 : 1] = thermalSnapshot();
        m_pending = Feature::None;
    }
    void stepComplete(int stepIndex) { m_recorder.endStep(stepIndex); }
    void stop(HeaderOpenTiming::Outcome reason) {
        if (m_stopped) return;
        m_stopped = true;
        m_recorder.stop(reason);
        m_delayTimer.stop();
        if (m_gpuTiming) m_gpuTiming->stop();
        for (int i = 0; i < m_connectionCount; ++i) QObject::disconnect(m_connections[i]);
    }
    QVariantMap snapshot() const {
        auto result = m_recorder.snapshot();
        if (m_gpuTiming) result["gpu"] = m_gpuTiming->snapshot();
        result["thermalAtObserverStart"] = m_thermalAtObserverStart;
        auto windows = result.value("windows").toList();
        for (auto &entry : windows) {
            auto window = entry.toMap();
            const int index = window.value("feature").toString() == "memory" ? 0 : 1;
            if (window.value("clickObserved").toBool() && !m_thermalAtClick[index].isEmpty())
                window["thermalAtClick"] = m_thermalAtClick[index];
            entry = window;
        }
        result["windows"] = windows;
        return result;
    }
private slots:
    void memoryProgress() { observeProgress(0); }
    void settingsProgress() { observeProgress(1); }
    void memoryComponent() { observeComponent(0, false); }
    void settingsComponent() { observeComponent(1, false); }
private:
    HeaderOpenTiming::Recorder m_recorder;
    std::unique_ptr<HeaderFrameTiming::Observer> m_gpuTiming;
    QVariantMap m_thermalAtObserverStart;
    std::array<QVariantMap, 2> m_thermalAtClick;
    QPointer<NativeAvatar> m_avatar;
    std::array<QPointer<QObject>, 2> m_surfaces;
    std::array<QMetaProperty, 2> m_progress, m_transition, m_component;
    std::array<QMetaObject::Connection, 48> m_connections;
    int m_connectionCount = 0, m_connectionsDropped = 0;
    QTimer m_delayTimer;
    qint64 m_nextTimerNs = 0;
    bool m_stopped = false;
    HeaderOpenTiming::Counters m_lastCounters;
    HeaderOpenTiming::Feature m_pending = HeaderOpenTiming::Feature::None;
    QVariantMap thermalSnapshot() const {
        auto result = HeaderFrameThermal::snapshot();
        result["atNs"] = HeaderOpenTiming::nowNs(m_recorder.state);
        return result;
    }
    bool watch(QMetaObject::Connection connection) {
        if (!connection) return false;
        if (m_connectionCount >= int(m_connections.size())) {
            ++m_connectionsDropped; QObject::disconnect(connection); return false;
        }
        m_connections[m_connectionCount++] = connection;
        return true;
    }
    static QMetaProperty property(const QMetaObject *meta, const char *name) {
        const int index = meta->indexOfProperty(name);
        return index < 0 ? QMetaProperty() : meta->property(index);
    }
    static HeaderOpenTiming::Command commandCategory(const QString &command) {
        using HeaderOpenTiming::Command;
        if (command.startsWith("memory:")) return Command::Memory;
        if (command.startsWith("settings:") || command.startsWith("api:settings")) return Command::Settings;
        if (command.startsWith("persona:")) return Command::Persona;
        if (command.startsWith("worldbook:") || command.startsWith("archive:")) return Command::Worldbook;
        if (command.startsWith("backup:")) return Command::Backup;
        if (command.startsWith("chat:")) return Command::Chat;
        if (command.startsWith("api:budget")) return Command::Budget;
        return Command::Other;
    }
    HeaderOpenTiming::Counters sampleAvatar(HeaderOpenTiming::Sample reason, bool force = false) {
        using namespace HeaderOpenTiming;
        Counters counters;
        if (QThread::currentThread() != thread() || m_stopped || !m_avatar || m_avatar->thread() != thread()) return counters;
        counters.available = true; counters.atNs = nowNs(m_recorder.state);
        // Three public integer getters only; no diagnostics map, model path,
        // model capability strings or render-thread item access.
        counters.loads = m_avatar->loads(); counters.releases = m_avatar->releases(); counters.frames = m_avatar->frames();
        if (force || !m_lastCounters.available || counters.loads != m_lastCounters.loads ||
            counters.releases != m_lastCounters.releases || counters.frames != m_lastCounters.frames) {
            Event event; event.atNs = counters.atNs; event.kind = Kind::AvatarCounters;
            event.a = counters.loads; event.b = counters.releases; event.c = counters.frames; event.detail = int(reason);
            point(m_recorder.state, event);
            m_lastCounters = counters;
        }
        return counters;
    }
    void observeProgress(int index) {
        using namespace HeaderOpenTiming;
        if (QThread::currentThread() != thread()) return;
        auto *surface = m_surfaces[index].data();
        if (m_stopped || !surface || surface->thread() != thread()) return;
        bool ok = false;
        const auto value = m_progress[index].read(surface).toDouble(&ok);
        if (!ok || !std::isfinite(value)) return;
        const auto state = m_transition[index].read(surface).toString();
        Transition transition = Transition::Unknown;
        if (state == "closed") transition = Transition::Closed;
        else if (state == "opening") transition = Transition::Opening;
        else if (state == "open") transition = Transition::Open;
        else if (state == "closing") transition = Transition::Closing;
        else if (state == "dragging") transition = Transition::Dragging;
        Event event; event.kind = Kind::Progress; event.value = value; event.detail = int(transition);
        event.feature = index == 0 ? Feature::Memory : Feature::Settings;
        point(m_recorder.state, event);
    }
    void observeComponent(int index, bool initial) {
        using namespace HeaderOpenTiming;
        if (QThread::currentThread() != thread()) return;
        auto *surface = m_surfaces[index].data();
        if (m_stopped || !surface || surface->thread() != thread()) return;
        Event event; event.kind = Kind::ComponentReady; event.flag = m_component[index].read(surface).toBool();
        event.detail = initial; event.feature = index == 0 ? Feature::Memory : Feature::Settings;
        point(m_recorder.state, event);
    }
};

class SurfaceRunner final : public QObject {
  public:
    SurfaceRunner(QQuickWindow *window, NativeAvatar *avatar,
                  SceneSurfaceCheck::Completion completion, bool measureTiming,
                  bool transitionDiagnostics, std::function<QVariantMap()> archiveContext)
        : QObject(window), m_window(window), m_avatar(avatar), m_completion(std::move(completion)),
          m_measureTiming(measureTiming), m_archiveContext(std::move(archiveContext)) {
        m_headerTiming.install(window, avatar);
        if (transitionDiagnostics && TransitionDiagnostics::enabled()) {
            for (const auto &feature : {QString("memory"), QString("settings")})
                TransitionDiagnostics::attachSurface(
                    feature, visualFind(window->contentItem(), "drawer-" + feature, false), this);
            TransitionDiagnostics::attachWindow(window, this);
            REVERIE_TRANSITION_POINT("scene-surface-start");
        }
        m_timer.setInterval(16);
        connect(&m_timer, &QTimer::timeout, this, [this] { tick(); });
        connect(window, &QQuickWindow::afterAnimating, this, [this] { ++m_inputFrame; m_occlusion.sample(m_window); });
        // The timestamp recorder can run on the render thread. Its shared
        // state survives an already dispatched callback during runner cleanup.
        if (m_measureTiming)
            m_frameConnection = connect(
                window, &QQuickWindow::frameSwapped, this,
                [state = m_timing] { frameSwapped(state); }, Qt::DirectConnection);
        connect(window, &QObject::destroyed, this,
                [this] { finish(false, "WINDOW_DESTROYED_DURING_CHECK"); });
        buildSteps();
        QTimer::singleShot(0, this, [this] {
            m_total.start();
            m_timer.start();
            tick();
        });
    }

    ~SurfaceRunner() override { m_headerTiming.stop(HeaderOpenTiming::Outcome::RunnerDestroyed); m_headerOpenObservation.end(); }

  private:
    QPointer<QQuickWindow> m_window;
    QPointer<NativeAvatar> m_avatar;
    SceneSurfaceCheck::Completion m_completion;
    bool m_measureTiming = true;
    QTimer m_timer;
    QElapsedTimer m_total, m_stepClock;
    QVector<Step> m_steps;
    int m_step = 0;
    int m_protectedLayoutSamples = 0;
    SceneOcclusionProbe m_occlusion;
    bool m_watchHandoff = false;
    double m_handoffFloor = 0;
    QVariantMap m_shortcutActivation;
    QString m_shortcutGap;
    double m_maxProtectedOverlap = 0;
    bool m_entered = false, m_inTick = false, m_finished = false, m_mousePressed = false;
    QPointF m_dragStart, m_dragEnd;
    QSize m_originalSize, m_testSize;
    QVariantMap m_avatarBefore, m_motionBefore;
    QVariantMap m_result{
        {"schema", "reverie.qt.scene-surface-input.v1"},
        {"passed", false},
        {"inputMethod", "QTest mouse/key events delivered to the existing QQuickWindow"},
        {"reducedMotionUiTestPerformed", false},
        {"reducedMotionUiTestNote", "Appearance switch coverage is supplied by the caller"}};
    QVariantList m_checks, m_mappingChecks;
    QVariantMap m_draftBefore;
    int m_interactionTarget = 0;
    double m_reverseProgress = 0;
    HeaderOpenObservation m_headerOpenObservation;
    HeaderOpenTimingObserver m_headerTiming;
    QString m_headerOpenFeature;
    double m_scrollBefore = 0;
    QPointer<QQuickItem> m_scrollContent;
    std::function<QVariantMap()> m_archiveContext;
    NativeArchiveControlReadiness::Gate m_archiveInput;
    QVariantList m_archiveInputEvidence;
    QVariantMap m_numericDraftBefore, m_scrollStateBefore;
    qint64 m_inputFrame = 0;
    std::shared_ptr<TimingState> m_timing = std::make_shared<TimingState>();
    QMetaObject::Connection m_frameConnection;
    mutable QHash<QString, QPair<int, qint64>> m_settleObserved;

    QQuickItem *find(const QString &name, bool usable = true) const {
        auto *item = visualFind(m_window ? m_window->contentItem() : nullptr, name, usable);
        require(item, "CONTROL_UNAVAILABLE:" + name);
        return item;
    }
    QPointF inputPoint(QQuickItem *item) const {
        QRectF visible =
            sceneRect(item).intersected(QRectF(0, 0, m_window->width(), m_window->height()));
        for (auto *ancestor = item->parentItem(); ancestor; ancestor = ancestor->parentItem())
            if (ancestor->clip())
                visible = visible.intersected(sceneRect(ancestor));
        require(!visible.isEmpty() && effectiveOpacity(item) > .05,
                "CONTROL_CLIPPED:" + item->objectName());
        return visible.center();
    }
    void click(const QString &name) {
        const auto point = inputPoint(find(name));
        REVERIE_TRANSITION_SCOPE("QTest::mouseClick", {{"control", name}});
        m_headerTiming.beforeClick(name);
        QTest::mouseClick(m_window, Qt::LeftButton, Qt::NoModifier, point.toPoint());
    }
    QQuickItem *drawer(const QString &feature) const { return find("drawer-" + feature, false); }
    static QString applicationStateName() {
        switch (QGuiApplication::applicationState()) {
        case Qt::ApplicationActive:
            return "active";
        case Qt::ApplicationInactive:
            return "inactive";
        case Qt::ApplicationHidden:
            return "hidden";
        case Qt::ApplicationSuspended:
            return "suspended";
        }
        return "unknown";
    }
    // Observation only: activation, shortcut eligibility and navigation as the
    // original key helper sees them.
    QVariantMap shortcutState() const {
        auto *focus = QGuiApplication::focusWindow();
        QVariantMap state{{"windowActive", m_window->isActive()},
                          {"focusWindowIsScene", focus == m_window.data()},
                          {"focusWindowPresent", focus != nullptr},
                          {"applicationState", applicationStateName()},
                          {"activeFocusItem", m_window->activeFocusItem()
                                                  ? m_window->activeFocusItem()->objectName()
                                                  : QString()}};
        if (auto *shortcut = m_window->findChild<QObject *>("shortcut-settings")) {
            state["shortcutEnabled"] = shortcut->property("enabled");
            state["shortcutContext"] = shortcut->property("context");
        }
        if (auto *navigation = m_window->findChild<QObject *>("sceneNavigation")) {
            state["currentFeature"] = navigation->property("currentFeature");
            state["transitionRevision"] = navigation->property("transitionRevision");
            auto input = navigation->property("inputContext");
            if (input.metaType() == QMetaType::fromType<QJSValue>())
                input = QVariant::fromValue(input.value<QJSValue>().toQObject());
            if (auto *context = input.value<QObject *>())
                state["composing"] = context->property("composing");
        }
        return state;
    }
    // A switch navigation never accepted is reported as such, not as a handoff
    // posture fault; the original failure is kept beside it.
    QString failureReason(const QString &error) {
        if (m_shortcutGap.isEmpty() || !m_watchHandoff)
            return error;
        m_shortcutActivation["subsequentError"] = error;
        return m_shortcutGap;
    }
    QQuickItem *body(const QString &feature) const {
        return find(feature == "memory" ? "archiveDrawer" : "terminalTasks", false);
    }
    double progress(const QString &feature) const {
        return drawer(feature)->property("progress").toDouble();
    }
    QString transition(const QString &feature) const {
        return drawer(feature)->property("transitionState").toString();
    }
    QVariantMap headerOpenEvidence(bool failure = false) const {
        auto evidence = m_headerOpenObservation.snapshot(failure);
        evidence["feature"] = m_headerOpenFeature;
        return evidence;
    }
    bool atEndpoint(const QString &feature, bool open) const {
        auto *surface = drawer(feature);
        return !surface->property("dragging").toBool() &&
               surface->property("transitionState").toString() == (open ? "open" : "closed") &&
               std::abs(progress(feature) - (open ? 1 : 0)) < .001;
    }
    bool settled(const QString &feature, bool open) const {
        const bool ready = atEndpoint(feature, open);
        const QString key = feature + (open ? "-open" : "-closed");
        if (!ready) {
            m_settleObserved.remove(key);
            return false;
        }
        const auto observed = m_settleObserved.value(key, {-1, 0});
        if (observed.first != m_step) {
            m_settleObserved[key] = {m_step, m_total.elapsed()};
            return false;
        }
        // Allow another GUI/render turn for bindings, focus restoration, and
        // ancestor-based glass mapping after the final animation assignment.
        return m_total.elapsed() - observed.second >= 33;
    }
    void checkBody(const QString &feature, bool open) {
        auto *surface = drawer(feature);
        auto *content = body(feature);
        if (open) {
            require(surface->property("inputReady").toBool(), "OPEN_INPUT_NOT_READY:" + feature);
            require(content->isVisible() && content->isEnabled() && effectiveOpacity(content) > .95,
                    "OPEN_BODY_STUCK_TRANSPARENT_OR_DISABLED:" + feature);
        } else
            require(!surface->property("inputReady").toBool() && !content->isEnabled(),
                    "CLOSING_OR_CLOSED_BODY_ACCEPTS_INPUT:" + feature);
    }
    void checkFocus(const QString &entrance) {
        auto *item = find(entrance);
        require(isWithin(m_window->activeFocusItem(), item),
                "FOCUS_NOT_RETURNED_TO_ENTRANCE:" + entrance);
    }
    void record(const QString &name, QVariantMap evidence = {}) {
        evidence["name"] = name;
        evidence["passed"] = true;
        QVariantMap states;
        for (const auto &feature : {QString("memory"), QString("settings")}) {
            auto *surface = drawer(feature);
            auto *content = body(feature);
            states[feature] = QVariantMap{{"progress", progress(feature)},
                                          {"transitionState", transition(feature)},
                                          {"inputReady", surface->property("inputReady")},
                                          {"dragging", surface->property("dragging")},
                                          {"desiredOpen", surface->property("desiredOpen")},
                                          {"bodyVisible", content->isVisible()},
                                          {"bodyEnabled", content->isEnabled()},
                                          {"bodyEffectiveOpacity", effectiveOpacity(content)}};
        }
        evidence["surfaceStates"] = states;
        evidence["activeFocusItem"] =
            m_window->activeFocusItem() ? m_window->activeFocusItem()->objectName() : QString();
        m_checks.append(evidence);
    }
    void add(QString name, Action action, Predicate ready = {}, Action validate = {},
             int minimumMs = 0, int timeoutMs = 2500) {
        m_steps.append({std::move(name), std::move(action), std::move(ready), std::move(validate),
                        minimumMs, timeoutMs});
    }
    void samplePhase(const QString &phase) {
        QMutexLocker locker(&m_timing->mutex);
        m_timing->phase = phase;
        m_timing->havePrevious = false;
    }
    static void frameSwapped(const std::shared_ptr<TimingState> &state) {
        const auto now = std::chrono::steady_clock::now();
        QMutexLocker locker(&state->mutex);
        if (state->phase.isEmpty())
            return;
        if (state->havePrevious) {
            const double ms =
                std::chrono::duration<double, std::milli>(now - state->previous).count();
            if (state->frames.size() < 480)
                state->frames.append({ms, state->phase});
            else
                ++state->droppedSamples;
        }
        state->previous = now;
        state->havePrevious = true;
    }
    static QVariantMap timingSummary(const QVector<FrameSample> &samples,
                                     const QString &phase = {}) {
        QVector<double> values;
        for (const auto &sample : samples)
            if (phase.isEmpty() || sample.phase == phase)
                values.append(sample.milliseconds);
        std::sort(values.begin(), values.end());
        const auto percentile = [&values](double fraction) {
            if (values.isEmpty())
                return 0.;
            return values[std::min(values.size() - 1,
                                   qsizetype(std::ceil(fraction * values.size()) - 1))];
        };
        QVariantMap result{{"sampleCount", values.size()},
                           {"p50Ms", percentile(.5)},
                           {"p95Ms", percentile(.95)},
                           {"maxMs", values.isEmpty() ? 0 : values.last()},
                           {"over33Ms", std::count_if(values.begin(), values.end(),
                                                      [](double ms) { return ms > 33; })},
                           {"over50Ms", std::count_if(values.begin(), values.end(),
                                                      [](double ms) { return ms > 50; })}};
        if (!phase.isEmpty())
            result["phase"] = phase;
        return result;
    }
    void compareAvatar(const QVariantMap &before, const QString &phase) {
        const auto after = m_avatar->diagnostics();
        require(before.value("loads") == after.value("loads") &&
                    before.value("releases") == after.value("releases"),
                "AVATAR_RELOADED_OR_RELEASED:" + phase);
        require(before.value("layoutRevision") == after.value("layoutRevision") &&
                    before.value("baselineBounds") == after.value("baselineBounds") &&
                    before.value("modelAnchor") == after.value("modelAnchor"),
                "AVATAR_BASELINE_CHANGED:" + phase);
        auto *director = m_window->findChild<QObject *>("sceneDirector");
        if (director) {
            const QRectF expected = director->property("avatarRect").toRectF();
            require(std::abs(m_avatar->x() - expected.x()) < .1 &&
                        std::abs(m_avatar->y() - expected.y()) < .1 &&
                        std::abs(m_avatar->width() - expected.width()) < .1 &&
                        std::abs(m_avatar->height() - expected.height()) < .1,
                    "AVATAR_VIEW_DOES_NOT_FOLLOW_SCENE_POSE:" + phase);
            const auto modelAnchor = pointFromMap(after.value("modelAnchor"));
            const auto foot = m_avatar->itemToWindow(m_avatar->modelToItem(modelAnchor));
            const auto offset = m_avatar->viewOffset();
            require(QLineF(foot, QPointF(expected.x() + expected.width() / 2 + offset.x(),
                                         expected.y() + expected.height() * .965 + offset.y()))
                            .length() < .1,
                    "AVATAR_WINDOW_ANCHOR_DISAGREES_WITH_POSE:" + phase);
        } else {
            require(QLineF(pointFromMap(before.value("itemAnchor")),
                           pointFromMap(after.value("itemAnchor")))
                            .length() < .1,
                    "AVATAR_ITEM_ANCHOR_CHANGED_AT_SAME_SIZE:" + phase);
        }
        record("avatar-stability-" + phase, {{"before", before}, {"after", after}});
    }
    void checkAvatarMapping() {
        const auto diagnostic = m_avatar->diagnostics();
        const QPointF model = pointFromMap(diagnostic.value("interactionProbeModel"));
        require(diagnostic.contains("interactionProbeModel"), "AVATAR_MESH_PROBE_UNAVAILABLE");
        const auto local = m_avatar->modelToItem(model);
        const auto roundTrip = m_avatar->itemToModel(local);
        const auto window = m_avatar->itemToWindow(local);
        const auto back = m_avatar->windowToItem(window);
        require(QLineF(model, roundTrip).length() < 1e-5 && QLineF(local, back).length() < 1e-5,
                "AVATAR_MODEL_ITEM_WINDOW_MAPPING_FAILED");
        record("avatar-coordinate-roundtrip",
               {{"modelPoint", model},
                {"itemPoint", local},
                {"windowPoint", window},
                {"framebufferScale", diagnostic.value("framebufferScale")}});
    }
    void checkGlassMappings(const QString &phase) {
        int count = 0;
        double maxError = 0;
        std::function<void(QQuickItem *)> walk = [&](QQuickItem *item) {
            if (!item)
                return;
            if (item->isVisible() && item->isEnabled() && effectiveOpacity(item) > .2 &&
                item->metaObject()->indexOfProperty("sampleMappingValid") >= 0) {
                auto *root = itemProperty(item, "sceneRoot");
                auto *material = itemProperty(item, "background");
                if (!material)
                    material = visualFind(item, "glassMaterial", false);
                if (root && material && material->width() > 0 && material->height() > 0) {
                    require(item->property("sampleMappingValid").toBool(),
                            "GLASS_MAPPING_INVALID:" + phase);
                    const auto origin = item->property("sampleOrigin").value<QVector2D>();
                    const auto axisX = item->property("sampleAxisX").value<QVector2D>();
                    const auto axisY = item->property("sampleAxisY").value<QVector2D>();
                    const auto sample = item->property("sceneSampleRect").toRectF();
                    for (const auto unit :
                         {QPointF(0, 0), QPointF(1, 0), QPointF(0, 1), QPointF(1, 1)}) {
                        const QPointF mapped = material->mapToItem(
                            root, {unit.x() * material->width(), unit.y() * material->height()});
                        const QPointF reconstructed(
                            sample.x() +
                                (origin.x() + unit.x() * axisX.x() + unit.y() * axisY.x()) *
                                    sample.width(),
                            sample.y() +
                                (origin.y() + unit.x() * axisX.y() + unit.y() * axisY.y()) *
                                    sample.height());
                        const double error = QLineF(mapped, reconstructed).length();
                        maxError = std::max(maxError, error);
                        require(error <= .1, "GLASS_MAPPING_CORNER_ERROR:" + phase + ":" +
                                                 QString::number(error));
                    }
                    ++count;
                }
            }
            for (auto *child : item->childItems())
                walk(child);
        };
        walk(m_window->contentItem());
        require(count >= 2, "INSUFFICIENT_VISIBLE_GLASS_MAPPINGS:" + phase);
        m_mappingChecks.append(
            QVariantMap{{"phase", phase},
                        {"panes", count},
                        {"maxErrorLogicalPixels", maxError},
                        {"toleranceLogicalPixels", .1},
                        {"method", "sample UV basis reconstructed at four material corners versus "
                                   "mapToItem(sceneRoot)"}});
    }
    void pressHandle(const QString &feature, double direction) {
        auto *surface = drawer(feature);
        auto *handle = find(feature + "-drag-handle");
        m_dragStart = inputPoint(handle);
        const QPointF axis = surface->property("gestureDirection").toPointF();
        require(QLineF(QPointF(), axis).length() > .9, "DRAG_DIRECTION_UNAVAILABLE:" + feature);
        m_dragEnd = m_dragStart + axis * surface->property("gestureSpan").toDouble() * direction;
        require(QRectF(1, 1, m_window->width() - 2, m_window->height() - 2).contains(m_dragEnd),
                "DRAG_ENDPOINT_OUTSIDE_WINDOW:" + feature);
        m_mousePressed = true;
        REVERIE_TRANSITION_SCOPE("QTest::mousePress", {{"feature", feature}});
        QTest::mousePress(m_window, Qt::LeftButton, Qt::NoModifier, m_dragStart.toPoint());
    }
    void moveDrag(double fraction) {
        REVERIE_TRANSITION_SCOPE("QTest::mouseMove");
        QTest::mouseMove(m_window, (m_dragStart + (m_dragEnd - m_dragStart) * fraction).toPoint());
    }
    void releaseDrag() {
        REVERIE_TRANSITION_SCOPE("QTest::mouseRelease");
        QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_dragEnd.toPoint());
        m_mousePressed = false;
    }
    void addDrag(const QString &feature, bool open) {
        const QString prefix = feature + (open ? "-drag-open" : "-drag-close");
        add(prefix + "-press", [this, feature, open] { pressHandle(feature, open ? .72 : -.72); });
        add(prefix + "-move-1", [this] { moveDrag(.3); });
        add(prefix + "-move-2", [this] { moveDrag(.65); });
        add(
            prefix + "-move-3", [this] { moveDrag(1); },
            [this, feature] { return drawer(feature)->property("dragging").toBool(); },
            [this, feature, open] {
                require(std::abs(progress(feature) - (open ? .72 : .28)) < .09,
                        "DRAG_PROGRESS_NOT_CONTINUOUS:" + feature);
                checkBody(feature, false);
            });
        add(
            prefix + "-release", [this] { releaseDrag(); },
            [this, feature, open] { return settled(feature, open); },
            [this, feature, open, prefix] {
                checkBody(feature, open);
                checkGlassMappings(prefix);
                record(prefix);
                if (feature == "memory" && open) {
                    compareAvatar(m_motionBefore, "motion-and-drag");
                    require(m_avatar->diagnostics().value("userAnimationSeconds").toDouble() >
                                m_motionBefore.value("userAnimationSeconds").toDouble() + .05,
                            "USER_ANIMATION_DID_NOT_ADVANCE");
                }
            });
    }
    void addDrawerChecks(const QString &feature) {
        add(
            feature + "-header-open",
            [this, feature] {
                m_headerTiming.prepare(feature, m_step);
                samplePhase("transition");
                m_headerOpenFeature = feature;
                m_headerOpenObservation.begin(drawer(feature),
                                              [this] { return m_stepClock.elapsed(); });
                auto inClickHelper = m_headerOpenObservation.clickScope();
                click("portal-" + feature);
            },
            [this, feature] {
                return m_headerOpenObservation.poll(progress(feature), transition(feature));
            },
            [this, feature] {
                m_headerOpenObservation.end();
                require(m_headerOpenObservation.latchedState() == "opening",
                        "DRAWER_NOT_OPENING:" + feature);
            });
        add(
            feature + "-reverse-with-close",
            [this, feature] {
                m_headerOpenObservation.recordReverse(progress(feature), transition(feature));
                click(feature + "-close");
            },
            [this, feature] { return transition(feature) == "closing" && progress(feature) > .03; },
            [this, feature] {
                checkBody(feature, false);
                m_reverseProgress = progress(feature);
                record(feature + "-closing-body-disabled");
            });
        add(
            feature + "-reverse-with-header",
            [this, feature] {
                const double before = progress(feature);
                click("portal-" + feature);
                require(std::abs(progress(feature) - before) < .15,
                        "REVERSAL_JUMPED_PROGRESS:" + feature);
            },
            [this, feature] { return settled(feature, true); },
            [this, feature] {
                checkBody(feature, true);
                checkGlassMappings(feature + "-reversed-open");
                record(feature + "-mid-progress-reversal",
                       {{"reverseProgress", m_reverseProgress},
                        {"headerOpenObservation", headerOpenEvidence()}});
            });
        add(
            feature + "-close-return-header-focus", [this, feature] { click(feature + "-close"); },
            [this, feature] { return settled(feature, false); },
            [this, feature] {
                checkBody(feature, false);
                checkFocus("portal-" + feature);
                record(feature + "-header-focus-return");
            });
        add(
            feature + "-nav-open", [this, feature] { click("nav-" + feature); },
            [this, feature] { return settled(feature, true); },
            [this, feature] { checkBody(feature, true); });
        add(
            feature + "-nav-close-focus", [this, feature] { click(feature + "-close"); },
            [this, feature] { return settled(feature, false); },
            [this, feature] {
                checkFocus("nav-" + feature);
                record(feature + "-navigation-focus-return");
            });
        for (int toggle = 0; toggle < 3; ++toggle)
            add(feature + "-rapid-toggle-" + QString::number(toggle),
                [this, feature] { click("portal-" + feature); });
        add(
            feature + "-rapid-toggle-settle", {},
            [this, feature] { return settled(feature, true); },
            [this, feature] {
                checkBody(feature, true);
                record(feature + "-rapid-toggles-settle");
            });
        add(
            feature + "-rapid-close", [this, feature] { click("portal-" + feature); },
            [this, feature] { return settled(feature, false); },
            [this, feature] { checkBody(feature, false); });
        if (feature == "memory") {
            add(
                "avatar-keyboard-capability",
                [this] {
                    m_motionBefore = m_avatar->diagnostics();
                    m_interactionTarget = m_avatar->successfulInteractions() + 1;
                    samplePhase("drag+motion");
                    m_avatar->forceActiveFocus(Qt::OtherFocusReason);
                    REVERIE_TRANSITION_SCOPE("QTest::keyClick-return");
                    QTest::keyClick(m_window, Qt::Key_Return);
                },
                [this] { return m_avatar->successfulInteractions() >= m_interactionTarget; },
                [this] {
                    require(m_avatar->diagnostics()
                                .value("lastInteraction")
                                .toMap()
                                .value("ok")
                                .toBool(),
                            "AVATAR_KEYBOARD_ACTION_FAILED");
                    record("avatar-real-keyboard-capability",
                           {{"interaction", m_avatar->diagnostics().value("lastInteraction")}});
                });
        }
        addDrag(feature, true);
        addDrag(feature, false);
        add(feature + "-escape-drag-press", [this, feature] { pressHandle(feature, .32); });
        add(
            feature + "-escape-drag-move", [this] { moveDrag(1); },
            [this, feature] { return drawer(feature)->property("dragging").toBool(); });
        add(
            feature + "-escape-drag-cancel",
            [this] {
                REVERIE_TRANSITION_OBSERVE("QTest::keyClick-escape", [this] {
                    QTest::keyClick(m_window, Qt::Key_Escape);
                });
                releaseDrag();
            },
            [this, feature] { return settled(feature, false); },
            [this, feature] {
                checkBody(feature, false);
                record(feature + "-escape-cancels-drag");
            });
        add(feature + "-resize-drag-press", [this, feature] { pressHandle(feature, .32); });
        add(
            feature + "-resize-drag-move", [this] { moveDrag(1); },
            [this, feature] { return drawer(feature)->property("dragging").toBool(); });
        add(
            feature + "-resize-drag-cancel",
            [this] {
                m_window->resize(m_testSize);
                releaseDrag();
            },
            [this, feature] { return settled(feature, false); },
            [this, feature] {
                checkBody(feature, false);
                record(feature + "-resize-cancels-drag");
            });
        add(
            feature + "-restore-window", [this] { m_window->resize(m_originalSize); },
            [this] { return m_window->size() == m_originalSize; },
            [this, feature] {
                compareAvatar(m_avatarBefore, feature + "-after-resize-restore");
                checkGlassMappings(feature + "-restored");
            },
            80);
        if (feature == "memory")
            addEditorChecks();
    }
    void addEditorChecks() {
        add(
            "memory-editor-open", [this] { click("nav-memory"); },
            [this] { return settled("memory", true); },
            [this] {
                for (const auto &name : {"worldbookName", "worldbookKeys", "worldbookContent"})
                    m_draftBefore[name] = find(name)->property("text");
                for (const auto *name : {"worldbookInsertionOrder", "worldbookPriority",
                                         "worldbookEntryScanDepth", "worldbookEntryTokenBudget"})
                    m_numericDraftBefore[QString(name) + ":value"] = find(name, false)->property("value");
                for (const auto *name : {"worldbookEntryScanDepthInherit", "worldbookEntryTokenBudgetInherit"})
                    m_numericDraftBefore[QString(name) + ":checked"] = find(name, false)->property("checked");
                require(!m_draftBefore.value("worldbookContent").toString().isEmpty(),
                        "TEXT_SELECTION_PRECONDITION_EMPTY_CONTENT");
            });
        add(
            "memory-editor-text-selection",
            [this] { m_archiveInput.resetForNextStep(); },
            [this] {
                const auto result = m_archiveInput.poll(m_window,
                    {NativeArchiveControlReadiness::Region::BodyFirstLine, "worldbookContent",
                     [this] { return visualFind(m_window ? m_window->contentItem() : nullptr, "worldbookContent", false); }, m_archiveContext, [this] { return m_inputFrame; }},
                    [this] { return m_stepClock.elapsed(); }, 2500, m_inputFrame,
                    [this](const NativeArchiveControlReadiness::Prepared &prepared) {
                        REVERIE_TRANSITION_SCOPE("QTest::mouse-selection");
                        NativeArchiveControlReadiness::mouseSelect(m_window, prepared,
                            [this] { return m_stepClock.elapsed(); }, 2500);
                    });
                require(result != NativeArchiveControlReadiness::Gate::Expired &&
                        result != NativeArchiveControlReadiness::Gate::Failed,
                        "ARCHIVE_SELECTION_INPUT_EXPIRED_OR_FAILED");
                return result == NativeArchiveControlReadiness::Gate::Performed &&
                       m_stepClock.elapsed() - m_archiveInput.actionElapsedMs() >= 32;
            },
            [this] {
                require(!find("worldbookContent")->property("selectedText").toString().isEmpty(),
                        "TEXT_SELECTION_NOT_ESTABLISHED");
                require(atEndpoint("memory", true), "TEXT_SELECTION_DRAGGED_SURFACE");
                auto evidence = m_archiveInput.metadata();
                evidence["id"] = "scene-body-selection";
                evidence["step"] = "memory-editor-text-selection";
                evidence["observedAtMs"] = m_stepClock.elapsed();
                evidence["observedFrame"] = m_inputFrame;
                m_archiveInputEvidence.append(evidence);
                record("memory-editor-text-selection-does-not-drag",
                       {{"selectionLength",
                         find("worldbookContent")->property("selectedText").toString().size()}});
            },
            32);
        add(
            "memory-editor-wheel-input",
            [this] { m_archiveInput.resetForNextStep(); },
            [this] {
                const auto result = m_archiveInput.poll(m_window,
                    {NativeArchiveControlReadiness::Region::BodyWheel, "worldbookContent",
                     [this] { return visualFind(m_window ? m_window->contentItem() : nullptr, "worldbookContent", false); }, m_archiveContext, [this] { return m_inputFrame; }},
                    [this] { return m_stepClock.elapsed(); }, 2500, m_inputFrame,
                    [this](const NativeArchiveControlReadiness::Prepared &prepared) {
                        // The real body Flickable owns this point. Its baseline
                        // starts after reveal; no subsequent gate poll scrolls.
                        m_scrollContent = prepared.inner;
                        m_scrollStateBefore = NativeArchiveControlReadiness::scrollSnapshot(m_scrollContent);
                        m_scrollBefore = m_scrollStateBefore.value("y").toDouble();
                        const QPointF point(prepared.start);
                        QWheelEvent wheel(point, m_window->mapToGlobal(prepared.start), {}, {0, -120},
                                          Qt::NoButton, Qt::NoModifier, Qt::ScrollUpdate, false);
                        prepared.verify();
                        REVERIE_TRANSITION_OBSERVE("sendEvent-editor-wheel", [this, &wheel] {
                            return QCoreApplication::sendEvent(m_window, &wheel);
                        });
                        m_result["editorWheelEventAccepted"] = wheel.isAccepted();
                    });
                require(result != NativeArchiveControlReadiness::Gate::Expired &&
                        result != NativeArchiveControlReadiness::Gate::Failed,
                        "ARCHIVE_WHEEL_INPUT_EXPIRED_OR_FAILED");
                return result == NativeArchiveControlReadiness::Gate::Performed &&
                       m_stepClock.elapsed() - m_archiveInput.actionElapsedMs() >= 100;
            },
            [this] {
                require(atEndpoint("memory", true), "EDITOR_SCROLL_DRAGGED_SURFACE");
                for (auto it = m_draftBefore.begin(); it != m_draftBefore.end(); ++it)
                    require(find(it.key())->property("text") == it.value(),
                            "INPUT_TEST_MUTATED_DRAFT:" + it.key());
                for (auto it = m_numericDraftBefore.begin(); it != m_numericDraftBefore.end(); ++it) {
                    const auto names = it.key().split(':');
                    require(find(names[0], false)->property(names[1].toUtf8().constData()) == it.value(),
                            "INPUT_TEST_MUTATED_DRAFT:" + names[0]);
                }
                require(m_scrollContent, "EDITOR_SCROLL_TARGET_DESTROYED");
                const auto afterState = NativeArchiveControlReadiness::scrollSnapshot(m_scrollContent);
                require(afterState.value("valid").toBool(), "EDITOR_SCROLL_SNAPSHOT_INVALID");
                const double after = afterState.value("y").toDouble();
                const bool overflow = afterState.value("contentHeight").toDouble() > m_scrollContent->height() + 2;
                auto evidence = m_archiveInput.metadata();
                evidence["id"] = "scene-body-wheel";
                evidence["step"] = "memory-editor-wheel-input";
                evidence["observedAtMs"] = m_stepClock.elapsed();
                evidence["observedFrame"] = m_inputFrame;
                evidence["scrollBefore"] = m_scrollStateBefore;
                evidence["scrollAfter"] = afterState;
                evidence["wheelAngleY"] = -120;
                evidence["businessDraftUnchanged"] = true;
                m_archiveInputEvidence.append(evidence);
                record("memory-editor-scroll-does-not-drag", {{"contentYBefore", m_scrollBefore},
                                                              {"contentYAfter", after},
                                                              {"overflowAvailable", overflow},
                                                              {"businessDraftUnchanged", true}});
            },
            100);
        add(
            "memory-editor-close", [this] { click("memory-close"); },
            [this] { return settled("memory", false); },
            [this] {
                checkBody("memory", false);
                samplePhase({});
            });
    }
    void buildSteps() {
        add(
            "prepare-scene",
            [this] {
                require(m_window && m_avatar && m_window->isVisible(),
                        "VISIBLE_WINDOW_AND_AVATAR_REQUIRED");
                require(!m_avatar->reducedMotion(),
                        "ANIMATED_TRANSITION_PRECONDITION_REDUCED_MOTION");
                m_originalSize = m_window->size();
                require(m_originalSize.width() >= 1240,
                        "DESKTOP_PORTAL_TEST_REQUIRES_WIDTH_AT_LEAST_1240");
                m_testSize = {m_originalSize.width() - 60, m_originalSize.height() - 30};
                m_window->requestActivate();
                click("nav-chat");
            },
            [this] { return settled("memory", false) && settled("settings", false); });
        add(
            "capture-avatar-baseline", {},
            [this] {
                return m_avatar->loads() > 0 &&
                       m_avatar->diagnostics().value("layoutValid").toBool();
            },
            [this] {
                m_avatarBefore = m_avatar->diagnostics();
                m_result["avatarBefore"] = m_avatarBefore;
                require(!m_avatar->motionNames().isEmpty() ||
                            !m_avatar->expressionNames().isEmpty(),
                        "MODEL_HAS_NO_SUPPORTED_CAPABILITY");
                checkAvatarMapping();
                checkGlassMappings("baseline");
            });
        addDrawerChecks("memory");
        addDrawerChecks("settings");
        add("partial-task-open", [this] { samplePhase({}); click("nav-memory"); },
            [this] { return settled("memory", true); });
        add("partial-task-press", [this] { pressHandle("memory", -.60); });
        add("partial-task-move", [this] { moveDrag(1); },
            [this] { return drawer("memory")->property("dragging").toBool(); }, [this] {
                m_handoffFloor = progress("memory");
                require(m_handoffFloor > .3 && m_handoffFloor < .5, "PARTIAL_HANDOFF_PROGRESS_NOT_EXERCISED");
            });
        add("partial-task-keyboard-switch", [this] {
            m_watchHandoff = true;
            const auto before = shortcutState();
            REVERIE_TRANSITION_OBSERVE("QTest::keyClick-task-switch", [this] {
                QTest::keyClick(m_window, Qt::Key_3, Qt::ControlModifier);
            });
            const auto after = shortcutState();
            m_shortcutGap = ShortcutHandoff::gap(before, after);
            m_shortcutActivation = {{"beforeKey", before},
                                    {"afterKey", after},
                                    {"handoffEntered", m_shortcutGap.isEmpty()}};
            releaseDrag();
        }, [this] { return settled("settings", true) && settled("memory", false); }, [this] {
            m_watchHandoff = false;
            require(effectiveOpacity(find("chatReadingSurface", false)) <= .001,
                    "PARTIAL_HANDOFF_REVEALED_CHAT");
            record("selected-partial-drag-keyboard-switch-keeps-posture", {{"progressFloor", m_handoffFloor}});
        });
        add(
            "finish-scene",
            [this] {
                click("nav-chat");
                samplePhase({});
            },
            [this] { return settled("memory", false) && settled("settings", false); },
            [this] {
                compareAvatar(m_avatarBefore, "final");
                checkAvatarMapping();
                checkGlassMappings("final");
                m_result["avatarAfter"] = m_avatar->diagnostics();
            });
    }
    void tick() {
        if (m_finished || m_inTick) {
            REVERIE_TRANSITION_POINT("tick-rejected", {{"finished", m_finished},
                                                          {"inTick", m_inTick}});
            return;
        }
        m_inTick = true;
        REVERIE_TRANSITION_POINT("tick-enter");
        try {
            require(m_window && m_avatar, "WINDOW_OR_AVATAR_DESTROYED");
            require(m_occlusion.error.isEmpty(), m_occlusion.error);
            if (m_watchHandoff) {
                auto *director = m_window->findChild<QObject *>("sceneDirector");
                require(director && director->property("taskBlend").toDouble() >= m_handoffFloor - .001,
                        "PARTIAL_TASK_HANDOFF_RETURNED_TOWARD_CHAT");
            }
            require(m_total.elapsed() < 45000, "SCENE_SURFACE_CHECK_TOTAL_TIMEOUT");
            if (auto *director = m_window->findChild<QObject *>("sceneDirector");
                director && !director->property("compact").toBool()) {
                const auto protectedRect = director->property("avatarProtectedRect").toRectF();
                for (const QString feature : {"memory", "settings"}) {
                    auto *surface = drawer(feature);
                    if (surface->property("progress").toDouble() <= .002)
                        continue;
                    const auto overlap = sceneRect(surface).intersected(protectedRect);
                    const double area =
                        std::max(0., overlap.width()) * std::max(0., overlap.height());
                    m_maxProtectedOverlap = std::max(m_maxProtectedOverlap, area);
                    ++m_protectedLayoutSamples;
                    require(area <= .25, "SCENE_TRANSIT_COVERS_AVATAR_PROTECTED_RECT:" + feature +
                                             ":" + QString::number(area));
                }
            }
            if (m_step >= m_steps.size()) {
                m_inTick = false;
                finish(true);
                return;
            }
            auto &step = m_steps[m_step];
            TransitionDiagnostics::setStep(m_step, step.name);
            if (!m_entered) {
                m_entered = true;
                m_stepClock.restart();
                REVERIE_TRANSITION_POINT("step-enter", {{"timeoutMs", step.timeoutMs},
                                                            {"minimumMs", step.minimumMs}});
                if (step.enter)
                    step.enter();
            }
            if (m_stepClock.elapsed() > step.timeoutMs)
                throw std::runtime_error(("STEP_TIMEOUT:" + step.name).toStdString());
            const bool eligible = m_stepClock.elapsed() >= step.minimumMs;
            const bool ready = eligible && (!step.ready || step.ready());
#ifdef REVERIE_TIMING_DIAGNOSTICS
            TransitionDiagnostics::readyPoll(eligible, eligible && bool(step.ready), ready,
                                             m_stepClock.elapsed());
#endif
            if (ready) {
                if (step.validate)
                    step.validate();
                m_headerTiming.stepComplete(m_step);
                REVERIE_TRANSITION_POINT("step-complete");
                ++m_step;
                m_entered = false;
            }
        } catch (const std::exception &error) {
            m_inTick = false;
            finish(false, failureReason(QString::fromUtf8(error.what())));
            return;
        }
        m_inTick = false;
        REVERIE_TRANSITION_POINT("tick-exit");
    }
    void finish(bool passed, const QString &error = {}) {
        if (m_finished)
            return;
        m_finished = true;
        m_headerTiming.stop(passed ? HeaderOpenTiming::Outcome::StepComplete : HeaderOpenTiming::Outcome::CheckFailed);
        m_timer.stop();
        m_headerOpenObservation.end();
        REVERIE_TRANSITION_POINT("scene-surface-terminal", {{"passed", passed}, {"error", error}});
        samplePhase({});
        disconnect(m_frameConnection);
        if (m_window && m_mousePressed) {
            REVERIE_TRANSITION_OBSERVE("QTest::mouseRelease-cleanup", [this] {
                QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_dragEnd.toPoint());
            });
            m_mousePressed = false;
            REVERIE_TRANSITION_OBSERVE("QTest::keyClick-escape-cleanup", [this] {
                QTest::keyClick(m_window, Qt::Key_Escape);
            });
        }
        if (m_window && !m_originalSize.isEmpty() && m_window->size() != m_originalSize)
            m_window->resize(m_originalSize);
        QVector<FrameSample> frames;
        int dropped = 0;
        {
            QMutexLocker locker(&m_timing->mutex);
            frames = m_timing->frames;
            dropped = m_timing->droppedSamples;
        }
        auto timing = timingSummary(frames);
        timing["method"] = "steady_clock intervals captured at QQuickWindow::frameSwapped signal "
                           "emission; signal cadence, not GPU duration or physical display latency";
        timing["maximumStoredSamples"] = 480;
        timing["droppedSamples"] = dropped;
        timing["phases"] =
            QVariantList{timingSummary(frames, "transition"), timingSummary(frames, "drag+motion")};
        QVariantList raw;
        for (const auto &frame : frames)
            raw.append(QVariantMap{{"ms", frame.milliseconds}, {"phase", frame.phase}});
        timing["samples"] = raw;
        m_result["passed"] = passed;
        m_result["error"] = error;
        m_result["step"] = m_step < m_steps.size() ? m_steps[m_step].name : "complete";
        m_result["elapsedMs"] = m_total.isValid() ? m_total.elapsed() : 0;
        m_result["checks"] = m_checks;
        m_result["headerOpenDiagnostics"] = m_headerTiming.snapshot();
        if (!passed && !m_headerOpenFeature.isEmpty() && m_step < m_steps.size() &&
            m_steps[m_step].name == m_headerOpenFeature + "-header-open")
            m_result["headerOpenObservation"] = headerOpenEvidence(true);
        m_result["archiveControlReadiness"] = m_archiveInputEvidence;
        if (!passed) m_result["archiveControlReadinessCurrent"] = m_archiveInput.metadata();
        m_result["glassMappingChecks"] = m_mappingChecks;
        m_result["protectedLayoutSamples"] = m_protectedLayoutSamples;
        m_result["allForegroundOcclusion"] = m_occlusion.report();
        m_result["maxProtectedOverlapLogicalSquarePixels"] = m_maxProtectedOverlap;
        if (!m_shortcutActivation.isEmpty())
            m_result["shortcutActivation"] = m_shortcutActivation;
        timing["measured"] = m_measureTiming;
        m_result["frameTiming"] =
            m_measureTiming
                ? timing
                : QVariantMap{{"measured", false},
                              {"reason", "Window recording run; performance sampling disabled"}};
        if (m_avatar)
            m_result["avatarAfter"] = m_avatar->diagnostics();
        auto completion = std::move(m_completion);
        if (completion)
            completion(m_result);
        deleteLater();
    }
};
} // namespace

void SceneSurfaceCheck::run(QQuickWindow *window, NativeAvatar *avatar, Completion completion,
                            bool measureTiming, bool transitionDiagnostics,
                            std::function<QVariantMap()> archiveContext) {
    if (!window || !avatar) {
        QTimer::singleShot(0, [completion = std::move(completion)] {
            if (completion)
                completion({{"passed", false}, {"error", "WINDOW_AND_AVATAR_REQUIRED"}});
        });
        return;
    }
    new SurfaceRunner(window, avatar, std::move(completion), measureTiming, transitionDiagnostics, std::move(archiveContext));
}
#include "SceneSurfaceCheck.moc"
