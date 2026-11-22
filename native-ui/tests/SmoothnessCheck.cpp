#include "SmoothnessCheck.h"
#include "SmoothnessReading.h"
#include "SmoothnessTargets.h"
#include "SmoothnessVariant.h"
#include "SmoothnessEnvironment.h"
#include "HeaderFrameLocalCheck.h"
#include "HeaderFramePositiveControl.h"
#include "HeaderFrameThermal.h"
#include "../src/TimingTrace.h"
#include "../src/ArchiveEditor.h"
#include <QAbstractEventDispatcher>
#include <QBuffer>
#include <QImage>
#include <QPointer>
#include <QDateTime>
#include <QCryptographicHash>
#include <QFile>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QMutex>
#include <QMutexLocker>
#include <QSaveFile>
#include <QScreen>
#include <QThread>
#include <QtTest/qtestwheel.h>
#include <array>
#include <memory>

namespace SmoothnessCheck {
namespace {
constexpr int FrameCapacity = 60000;
constexpr int EventCapacity = 16384;
using Completion = std::function<void(QVariantMap)>;
qint64 now() { return TimingTrace::nowNs(); }
void need(bool valid, const char *reason) {
    if (!valid) throw std::runtime_error(reason);
}
QQuickItem *find(QQuickItem *root, const QString &name, bool usable = false) {
    return SmoothnessTargets::find(root, name, usable);
}
QJsonObject object(const QString &file) { return HeaderFrameLocalCheck::readObject(file); }
void save(const QString &file, const QVariantMap &value) {
    QSaveFile output(file);
    need(output.open(QIODevice::WriteOnly), "SMOOTHNESS_OUTPUT_OPEN");
    need(output.write(QJsonDocument::fromVariant(value).toJson()) >= 0 && output.commit(),
         "SMOOTHNESS_OUTPUT_WRITE");
}
QJsonObject context() {
    const auto document = object(HeaderFrameLocalCheck::argument("--context"));
    const auto selected = document["smoothness"].toObject();
    need(document["schema"] == "reverie.qt.isolation.v1" &&
         selected["schema"] == "reverie.qt.smoothness.context.v1" &&
         selected["package"] == "smoothness-20261115", "SMOOTHNESS_CONTEXT");
    const auto build = selected["buildDirectory"].toString();
    const auto record = object(build + "/build.json");
    QFile manifest(build + "/build.json");
    need(manifest.open(QIODevice::ReadOnly) &&
         QString::fromLatin1(QCryptographicHash::hash(manifest.readAll(), QCryptographicHash::Sha256).toHex()) ==
         selected["buildManifestSha256"].toString(), "SMOOTHNESS_BUILD_BINDING");
    need(QFileInfo(selected["outputDirectory"].toString()).isDir(), "SMOOTHNESS_OUTPUT_DIRECTORY");
    const auto diagnostics = record["diagnostics"].toObject();
    need(diagnostics["timingProbesEnabled"].toBool() || diagnostics["qmlProfilerEnabled"].toBool(),
         "SMOOTHNESS_DIAGNOSTIC_BUILD_REQUIRED");
    need(QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath() ==
         QFileInfo(build + "/Reverie Scene.app/Contents/MacOS/Reverie Scene").canonicalFilePath(),
         "SMOOTHNESS_EXECUTABLE_IDENTITY");
    need(QStringList{"control", "S1", "S2", "S3", "S4"}.contains(selected["scenario"].toString()),
         "SMOOTHNESS_SCENARIO");
    return selected;
}
void click(QQuickWindow *window, const QString &name) {
    auto *item = find(window->contentItem(), name, true);
    need(item && item->isVisible() && item->isEnabled(), "SMOOTHNESS_CONTROL_UNAVAILABLE");
    const auto rect = item->mapRectToScene(item->boundingRect());
    need(rect.width() > 0 && rect.height() > 0 &&
         QRectF(0, 0, window->width(), window->height()).contains(rect.center()), "SMOOTHNESS_CONTROL_CLIPPED");
    QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, rect.center().toPoint(), 0);
}
bool ready(QQuickWindow *window, const QString &name) {
    auto *item = find(window->contentItem(), name);
    return item && item->property("inputReady").toBool();
}
class Bootstrap final : public QObject {
    QQuickWindow *window;
    RuntimeBridge *session;
    QString model, endpoint;
    int rows, step = 0;
    qint64 lastWheelAt = -1000;
    QVariantList observations;
    bool ticking = false;
    QElapsedTimer clock;
    QTimer timer;
    QJsonObject selected;
    std::function<void(bool, QVariantMap)> done;
    void finish(bool success, const QString &error = {}) {
        timer.stop();
        auto callback = std::move(done);
        callback(success, {{"passed", success}, {"error", error}, {"elapsedMs", clock.elapsed()},
            {"scope", "W20 isolated provider and optional authorized model; no memory preopen"},
            {"coreFree", selected["coreFree"].toBool()}, {"historyRows", rows},
            {"step", step}, {"controlObservations", observations}});
        deleteLater();
    }
    bool expose(const QString &name) {
        auto *item = find(window->contentItem(), name, true);
        if (!item) return false;
        const auto rect = item->mapRectToScene(item->boundingRect());
        QRectF visible(0, 0, window->width(), window->height());
        QQuickItem *scroll = nullptr;
        for (auto *parent = item->parentItem(); parent; parent = parent->parentItem()) {
            if (parent->clip()) visible = visible.intersected(parent->mapRectToScene(parent->boundingRect()));
            if (parent->objectName() == "memoryPageScroll") scroll = parent;
        }
        const bool whole = rect.width() > 0 && rect.height() > 0 && visible.contains(rect);
        if (observations.size() < 128) observations.append(QVariantMap{{"control", name}, {"step", step},
            {"atMs", clock.elapsed()}, {"x", rect.x()}, {"y", rect.y()}, {"width", rect.width()},
            {"height", rect.height()}, {"visibleTop", visible.top()}, {"visibleBottom", visible.bottom()},
            {"whole", whole}});
        if (!whole && scroll && clock.elapsed() - lastWheelAt >= 150) {
            const auto point = scroll->mapToScene(QPointF(scroll->width()/2, scroll->height()/2));
            QTest::wheelEvent(window, point, QPoint(0, rect.bottom() > visible.bottom() ? -120 : 120));
            lastWheelAt = clock.elapsed();
        }
        return whole;
    }
    void tick() {
        if (ticking) return;
        ticking = true;
        try {
            need(clock.elapsed() < 90000, "SMOOTHNESS_BOOTSTRAP_TIMEOUT");
            if (step == 0 && session->connected() && session->messages().size() == rows && !session->avatarBusy()) {
                session->testProvider(endpoint, "reverie-perf-test");
                step = 1;
            } else if (step == 1 && session->state()["providerTestReady"].toBool()) {
                session->saveProvider();
                if (selected["coreFree"].toBool()) { click(window, "nav-chat"); step = 5; }
                else { click(window, "nav-character"); step = 2; }
            } else if (step == 2 && ready(window, "taskSurface") && !session->avatarBusy()) {
                session->importModel(QUrl::fromLocalFile(model));
                step = 3;
            } else if (step == 3 && session->avatarCandidate()["previewReady"].toBool() &&
                       !session->avatarBusy() && ready(window, "taskSurface")) {
                if (expose("modelRights")) { click(window, "modelRights"); step = 30; }
            } else if (step == 30) {
                if (session->avatarCandidate()["warnings"].toList().isEmpty()) step = 31;
                else if (expose("modelWarnings")) { click(window, "modelWarnings"); step = 31; }
            } else if (step == 31 && expose("confirmModel")) {
                click(window, "confirmModel"); step = 4;
            } else if (step == 4 && session->avatarCandidate().isEmpty() &&
                       session->avatarState().contains(QStringLiteral("就绪")) && !session->avatarBusy()) {
                click(window, "nav-chat");
                step = 5;
            } else if (step == 5 && ready(window, "persistentChat")) {
                finish(true); return;
            }
        } catch (const std::exception &error) { finish(false, QString::fromUtf8(error.what())); return; }
        ticking = false;
    }
public:
    Bootstrap(QQuickWindow *w, RuntimeBridge *s, QString path, QString url, int count,
              std::function<void(bool, QVariantMap)> callback)
        : QObject(w), window(w), session(s), model(std::move(path)), endpoint(std::move(url)),
          rows(count), selected(context()), done(std::move(callback)) {
        clock.start();
        timer.setInterval(25);
        connect(&timer, &QTimer::timeout, this, [this] { tick(); });
        window->requestActivate();
        timer.start();
    }
};
struct Frame {
    qint64 begin = -1, beforeSync = -1, afterSync = -1, beforeRender = -1, afterRender = -1, swap = -1;
    quintptr thread = 0;
    int textureWidth = -1, textureHeight = -1;
    bool textureOnGui = false;
};
struct FrameStore {
    QMutex mutex;
    std::unique_ptr<std::array<Frame, FrameCapacity>> rows = std::make_unique<std::array<Frame, FrameCapacity>>();
    int count = 0;
    quint64 dropped = 0;
    bool active = true;
    void record(int stage, const QSize &texture = {}, bool textureOnGui = false) {
        const qint64 timestamp = now();
        QMutexLocker lock(&mutex);
        if (!active) return;
        if (stage == 0) {
            if (count == FrameCapacity) { ++dropped; return; }
            auto &frame = (*rows)[count++];
            frame.begin = timestamp;
            frame.thread = reinterpret_cast<quintptr>(QThread::currentThreadId());
        }
        if (!count || dropped) return;
        auto &frame = (*rows)[count - 1];
        switch (stage) {
        case 1: frame.beforeSync = timestamp; break;
        case 2: frame.afterSync = timestamp; break;
        case 3: frame.beforeRender = timestamp; break;
        case 4: frame.afterRender = timestamp; break;
        case 5: frame.swap = timestamp;
            if (texture.isValid()) {
                frame.textureWidth = texture.width(); frame.textureHeight = texture.height();
                frame.textureOnGui = textureOnGui;
            }
            break;
        }
    }
    void freeze() { QMutexLocker lock(&mutex); active = false; }
    bool stopped() { QMutexLocker lock(&mutex); return !active; }
    int size() { QMutexLocker lock(&mutex); return count; }
    QVariantMap snapshot() {
        QMutexLocker lock(&mutex);
        active = false;
        QVariantList frames;
        for (int i = 0; i < count; ++i) {
            const auto &row = (*rows)[i];
            QVariantMap item{{"frameId", i + 1}, {"beginNs", row.begin},
                {"beforeSyncNs", row.beforeSync}, {"afterSyncNs", row.afterSync},
                {"beforeRenderNs", row.beforeRender}, {"afterRenderNs", row.afterRender},
                {"swapNs", row.swap}, {"renderThreadId", QString::number(row.thread)}};
            if (row.textureWidth >= 0) item.insert({{"textureWidth", row.textureWidth},
                {"textureHeight", row.textureHeight}, {"textureReadOnGui", row.textureOnGui}});
            frames.append(item);
        }
        return {{"frames", frames}, {"dropped", qulonglong(dropped)}};
    }
};
class Runner final : public QObject {
    QQuickWindow *window;
    RuntimeBridge *session;
    ArchiveEditor *editor;
    QJsonObject selected;
    QString output, scenario, variant;
    Completion done;
    QTimer timer;
    QElapsedTimer elapsed;
    std::shared_ptr<FrameStore> frames;
    std::unique_ptr<HeaderFrameTiming::Observer> gpu;
    std::unique_ptr<SmoothnessReading::Observer> reading;
    std::vector<QMetaObject::Connection> connections;
    QVariantList events, operations;
    QVariantMap thermal, variantReadback;
    QQuickItem *compositor = nullptr;
    QPointer<QQuickItem> environmentTarget;
    QVariantMap environmentReadback, collectorStop, screenshot, frozenFrames;
    QJsonObject frozenTrace;
    SmoothnessEnvironment::ScreenshotGate screenshotGate;
    QMetaObject::Connection screenshotConnection;
    bool eventsStopped = false, screenshotArmed = false;
    qint64 screenshotWaitStart = -1, idleStart = -1;
    QVariantMap idleReadback;
    qint64 origin = 0, measurementStart = -1, measurementEnd = -1, actionStart = 0, settledAt = -1;
    int phase = 0, index = 0, turns = 0, wheels = 0, beforeMessages = 0;
    bool ticking = false, finished = false;
    QQuickItem *chat = nullptr, *history = nullptr;
    QObject *navigation = nullptr;
    double refreshRate = 0;
    qint64 relativeNow() const { return now() - origin; }
    void event(const QString &kind, const QVariantMap &details = {}) {
        if (eventsStopped || events.size() == EventCapacity) return;
        auto record = details;
        record["kind"] = kind;
        record["atNs"] = relativeNow();
        events.append(record);
    }
    bool endpoint(const QString &feature, bool open) const {
        auto *surface = find(window->contentItem(), "drawer-" + feature);
        return surface && !surface->property("dragging").toBool() &&
            surface->property("transitionState").toString() == (open ? "open" : "closed") &&
            std::abs(surface->property("progress").toDouble() - (open ? 1. : 0.)) < .001 &&
            (!open || surface->property("inputReady").toBool());
    }
    void navigate(const QString &feature, const QString &subentry) {
        event("navigation", {{"feature", feature}, {"subentry", subentry}});
        need(QMetaObject::invokeMethod(navigation, "open", Q_ARG(QVariant, QVariant(feature)),
             Q_ARG(QVariant, QVariant(subentry)), Q_ARG(QVariant, QVariant())), "SMOOTHNESS_NAVIGATION_CALL");
        actionStart = relativeNow();
        settledAt = -1;
    }
    bool navigationReady(const QString &feature, const QString &subentry) {
        if (navigation->property("currentFeature").toString() != feature ||
            navigation->property("currentSubentry").toString() != subentry) return false;
        if (feature == "chat") return chat->property("inputReady").toBool();
        const QString name = feature == "character" ? "taskSurface" : "drawer-" + feature;
        return ready(window, name);
    }
    void initialize() {
        need(window->width() == 1380 && window->height() == 900 && session->connected() && !session->busy(),
             "SMOOTHNESS_BASELINE_STATE");
        chat = find(window->contentItem(), "persistentChat");
        history = find(window->contentItem(), "chatHistory");
        navigation = window->findChild<QObject *>("sceneNavigation");
        need(chat && history && navigation, "SMOOTHNESS_SCENE_OBJECTS");
        if (selected["environmentCheck"].toBool()) {
            need(HeaderFrameLocalCheck::argument("--perf-mode") == "visual" && !selected["gpuEnabled"].toBool(),
                 "ENVIRONMENT_LEGACY_RECORDER_MUST_BE_DISABLED");
            const auto requested = selected["screenshot"].toString();
            need(requested == "none" || (requested == "companion" && scenario == "S1" &&
                (variant == "baseline" || variant == "environment-half")), "ENVIRONMENT_SCREENSHOT_SELECTION");
            screenshot = {{"requested", requested}, {"performed", false}};
            environmentTarget = find(window->contentItem(), "moonroomEnvironmentShader");
            try {
                if (selected["phase2"].toBool()) {
                    const auto observed = SmoothnessEnvironment::read(environmentTarget);
                    need(observed["smooth"].toBool(), "PHASE2_SMOOTH_REQUIRED");
                    environmentReadback = {{"variant", variant}, {"before", observed},
                        {"applied", observed}, {"writes", QStringList{}}};
                } else environmentReadback = SmoothnessEnvironment::apply(environmentTarget, variant);
            }
            catch (...) {
                if (environmentTarget) {
                    try { environmentReadback["failedReadback"] = SmoothnessEnvironment::read(environmentTarget); } catch (...) {}
                }
                throw;
            }
        } else if (selected["supplement"].toBool()) {
            compositor = find(window->contentItem(), "layerCompositor");
            const auto before = SmoothnessVariant::readback(compositor, session->reducedTransparency());
            need(before["surfaceCount"].toInt() == 3 && before["effectsActive"].toBool() &&
                !before["reducedTransparency"].toBool(), "SMOOTHNESS_SUPPLEMENT_BASELINE_REQUIRED");
            if (variant == "reduced-transparency") session->setReducedTransparency(true);
            else if (variant == "drawer-background-off") SmoothnessVariant::disableDrawerBackground(compositor);
            const auto applied = SmoothnessVariant::readback(compositor, session->reducedTransparency());
            need(applied["surfaceCount"].toInt() == (variant == "drawer-background-off" ? 0 : 3) &&
                 applied["effectsActive"].toBool() == (variant != "reduced-transparency") &&
                 applied["reducedTransparency"].toBool() == (variant == "reduced-transparency") &&
                 applied["pixelRatio"] == before["pixelRatio"], "SMOOTHNESS_SUPPLEMENT_VARIANT_READBACK");
            variantReadback = {{"variant", variant}, {"before", before}, {"applied", applied},
                {"scope", "W4 surfaces=[] diagnostic write only; base/lower capture and blur and drawer own glass remain. Source fallback and orderOf also change."}};
        } else if (variant == "reduced-transparency") session->setReducedTransparency(true);
        thermal = HeaderFrameThermal::snapshot();
        refreshRate = window->screen() ? window->screen()->refreshRate() : 0;
        origin = now();
        frames = std::make_shared<FrameStore>();
        auto record = [state = frames](int stage) { state->record(stage); };
        connections.push_back(connect(window, &QQuickWindow::beforeFrameBegin, window, [record] { record(0); }, Qt::DirectConnection));
        connections.push_back(connect(window, &QQuickWindow::beforeSynchronizing, window, [record] { record(1); }, Qt::DirectConnection));
        connections.push_back(connect(window, &QQuickWindow::afterSynchronizing, window, [record] { record(2); }, Qt::DirectConnection));
        connections.push_back(connect(window, &QQuickWindow::beforeRendering, window, [record] { record(3); }, Qt::DirectConnection));
        connections.push_back(connect(window, &QQuickWindow::afterRendering, window, [record] { record(4); }, Qt::DirectConnection));
        connections.push_back(connect(window, &QQuickWindow::frameSwapped, window, [this, record] {
            if (!selected["phase2"].toBool()) { record(5); return; }
            const bool onGui = QThread::currentThread() == window->thread();
            // Read only on the GUI thread. A threaded loop remains an explicit
            // missing observation, rejected by the host, never a cross-thread read.
            const auto size = onGui && environmentTarget
                ? QQmlProperty(environmentTarget, "layer.textureSize").read().toSize() : QSize();
            frames->record(5, size, onGui);
        }, Qt::DirectConnection));
        if (scenario == "S3" || scenario == "S4") {
            reading = std::make_unique<SmoothnessReading::Observer>(chat, history);
            connections.push_back(connect(window, &QQuickWindow::beforeRendering, window,
                [this] { reading->sample(); }, Qt::DirectConnection));
        }
        if (selected["gpuEnabled"].toBool())
            gpu = std::make_unique<HeaderFrameTiming::Observer>(window, [] { return now(); }, HeaderFrameTiming::Options{true, false});
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        TimingTrace::setObservedWindow(window);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::Window, window);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::RuntimeBridge, session);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ChatPanel, chat);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ChatHistory, history);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ArchiveEditor, editor);
        TimingTrace::observeReadingRestoreCounters(chat, this);
        connect(session, &RuntimeBridge::messagesChanged, this, [this] { event("messages-changed", {{"rows", session->messages().size()}}); });
        connect(session, &RuntimeBridge::responseReceived, this,
            [this](const QString &, const QString &command, const QVariantMap &, int generation) {
                event("backend-receipt", {{"command", command}, {"generation", generation}});
            });
        save(output + "/scene-ready.json", {{"ready", true}});
        phase = 1;
        actionStart = relativeNow();
    }
    void beginScene() {
        measurementStart = relativeNow();
        if (reading) reading->setEnabled(true);
        event("scene-start", {{"scenario", scenario}});
        phase = 2;
        index = 0;
        actionStart = relativeNow();
        if (scenario == "S2") {
            for (const auto &page : selected["pages"].toArray())
                for (int repeat = 0; repeat < selected["pageRepeats"].toInt(); ++repeat) {
                    auto row = page.toObject().toVariantMap();
                    row["repeat"] = repeat;
                    operations.append(row);
                }
        } else if (scenario == "S3") {
            navigate("chat", "reading");
        } else if (scenario == "S4") {
            navigate("chat", "companion");
        }
    }
    void finishMeasurement() {
        measurementEnd = relativeNow();
        if (reading) reading->setEnabled(false);
        event("scene-end");
        if (compositor) {
            const auto readback = SmoothnessVariant::readback(compositor, session->reducedTransparency());
            variantReadback["finished"] = readback;
            need(variant != "drawer-background-off" || readback["surfaceCount"].toInt() == 0,
                 "SMOOTHNESS_DRAWER_VARIANT_NOT_RETAINED");
        }
        if (environmentTarget) {
            const auto readback = SmoothnessEnvironment::read(environmentTarget);
            environmentReadback["finished"] = readback;
            if (!selected["phase2"].toBool())
                SmoothnessEnvironment::validate(environmentReadback["before"].toMap(), readback, variant);
        }
        TimingTrace::stop();
        if (gpu) gpu->stop();
        for (const auto &connection : connections) disconnect(connection);
        if (selected["environmentCheck"].toBool()) {
            eventsStopped = true;
            frames->freeze();
            collectorStop = {{"allStopped", !TimingTrace::enabled() && frames->stopped() && !gpu},
                {"atNs", relativeNow()}, {"timingTraceEnabled", TimingTrace::enabled()},
                {"frameStoreStopped", frames->stopped()}, {"eventsStopped", eventsStopped}};
            frozenFrames = frames->snapshot();
            frozenTrace = TimingTrace::snapshot();
            collectorStop["frameRecords"] = frames->size();
            collectorStop["eventRecords"] = events.size();
            collectorStop["traceRecords"] = frozenTrace["recordCount"].toInt();
            collectorStop["snapshotsReadyNs"] = relativeNow();
        }
        phase = 9;
        save(output + "/scene-complete.json", {{"complete", true}});
        actionStart = relativeNow();
        if (selected["phase2"].toBool()) {
            phase = 11;
            screenshotWaitStart = relativeNow();
        } else if (selected["environmentCheck"].toBool() && selected["screenshot"] == "companion") {
            phase = 10;
            screenshotWaitStart = relativeNow();
        }
    }
    bool companionStable() const {
        return navigation && navigation->property("currentFeature") == "chat" &&
            navigation->property("currentSubentry") == "companion" && chat && chat->property("inputReady").toBool() &&
            endpoint("memory", false) && endpoint("settings", false);
    }
    bool recordsStopped() const {
        return eventsStopped && frames && frames->stopped() && !TimingTrace::enabled() && !gpu &&
            frames->size() == collectorStop.value("frameRecords").toInt() &&
            events.size() == collectorStop.value("eventRecords").toInt();
    }
    void tickIdleReadback() {
        need(relativeNow() - screenshotWaitStart <= 4000000000LL, "PHASE2_IDLE_TIMEOUT");
        need(recordsStopped(), "PHASE2_IDLE_RECORDING_ACTIVE");
        if (!companionStable()) { idleStart = -1; return; }
        if (idleStart < 0) idleStart = relativeNow();
        if (relativeNow() - idleStart < 1000000000LL) return;
        const auto observed = SmoothnessEnvironment::read(environmentTarget);
        idleReadback = {{"idleStartNs", idleStart}, {"readAtNs", relativeNow()},
            {"quietMs", double(relativeNow() - idleStart) / 1e6}, {"observed", observed}};
        need(observed["textureWidth"].toInt() == 2760 && observed["textureHeight"].toInt() == 1800 &&
             observed["smooth"].toBool() && observed["visible"].toBool(), "PHASE2_IDLE_NOT_FULL_RESOLUTION");
        if (selected["screenshot"] == "companion") {
            phase = 10; screenshotWaitStart = relativeNow();
        } else finish();
    }
    void tickScreenshot() {
        need(screenshotWaitStart >= 0 && relativeNow() - screenshotWaitStart <= 4000000000LL,
             "ENVIRONMENT_SCREENSHOT_TIMEOUT");
        need(recordsStopped() && measurementEnd >= 0, "ENVIRONMENT_SCREENSHOT_RECORDING_ACTIVE");
        need(window->width() == 1380 && window->height() == 900 && window->isVisible(), "ENVIRONMENT_SCREENSHOT_WINDOW_CHANGED");
        if (!companionStable()) {
            need(!screenshotArmed, "ENVIRONMENT_SCREENSHOT_LEFT_COMPANION");
            return;
        }
        if (!screenshotArmed) {
            screenshotGate.arm(collectorStop["atNs"].toLongLong(), relativeNow(), recordsStopped());
            screenshotConnection = connect(window, &QQuickWindow::frameSwapped, this,
                [this] { screenshotGate.swapped(relativeNow()); });
            screenshotArmed = true;
            return;
        }
        if (!screenshotGate.ready()) return;
        const auto begin = relativeNow();
        auto proof = screenshotGate.consume(begin, recordsStopped());
        disconnect(screenshotConnection); // grabWindow-generated work cannot count as a natural swap.
        const QImage image = window->grabWindow();
        const auto end = relativeNow();
        need(!image.isNull() && image.width() > 0 && image.height() > 0, "ENVIRONMENT_SCREENSHOT_EMPTY");
        QByteArray bytes;
        QBuffer buffer(&bytes);
        need(buffer.open(QIODevice::WriteOnly) && image.save(&buffer, "PNG"), "ENVIRONMENT_SCREENSHOT_ENCODING");
        buffer.close();
        const QString filename = output + "/environment.companion.png";
        QFile file(filename);
        need(file.open(QIODevice::WriteOnly | QIODevice::NewOnly), "ENVIRONMENT_SCREENSHOT_FILE_EXISTS_OR_UNWRITABLE");
        need(file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner) &&
            file.write(bytes) == bytes.size() && file.flush(), "ENVIRONMENT_SCREENSHOT_WRITE");
        file.close();
        need(recordsStopped() && companionStable(), "ENVIRONMENT_SCREENSHOT_STATE_CHANGED");
        screenshot.insert(proof);
        screenshot.insert({{"performed", true}, {"path", filename}, {"view", "companion"}, {"grabEndNs", end},
            {"pixelWidth", image.width()}, {"pixelHeight", image.height()},
            {"logicalWidth", window->width()}, {"logicalHeight", window->height()},
            {"devicePixelRatio", window->effectiveDevicePixelRatio()}, {"bytes", bytes.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())},
            {"frameRecordsAfterCapture", frames->size()}, {"eventRecordsAfterCapture", events.size()},
            {"naturalAnimations", true}, {"appearanceOrPoseOverrides", false}, {"pixelIdentityGuaranteed", false}});
        finish();
    }
    void finish(const QString &error = {}) {
        if (finished) return;
        finished = true;
        timer.stop();
        disconnect(screenshotConnection);
        for (const auto &connection : connections) disconnect(connection);
        TimingTrace::stop();
        if (gpu) gpu->stop();
        QVariantMap report{{"schema", "reverie.qt.smoothness.scene.v1"}, {"package", "smoothness-20261115"},
            {"scenario", scenario}, {"variant", variant}, {"passed", error.isEmpty()}, {"completed", error.isEmpty()},
            {"error", error}, {"diagnostic", true}, {"acceptanceEligible", false},
            {"originNs", QString::number(origin)}, {"measurementStartNs", measurementStart},
            {"measurementEndNs", measurementEnd}, {"screenRefreshRateHz", refreshRate},
            {"thermalAtStart", thermal}, {"events", events}, {"eventCapacity", EventCapacity},
            {"eventsIncomplete", events.size() == EventCapacity}, {"operations", operations},
            {"frameTiming", !frozenFrames.isEmpty() ? frozenFrames : frames ? frames->snapshot() : QVariantMap{}},
            {"timingTrace", (!frozenTrace.isEmpty() ? frozenTrace : TimingTrace::snapshot()).toVariantMap()},
            {"gpu", gpu ? gpu->snapshot() : QVariantMap{{"collected", false}}},
            {"gpuValidated", selected["gpuEnabled"].toBool()},
            {"readingAdjacency", reading ? reading->snapshot() : QVariantMap{{"collected", false}}},
            {"windowDevicePixelRatio", window->effectiveDevicePixelRatio()},
            {"guiThreadId", QString::number(reinterpret_cast<quintptr>(QThread::currentThreadId()))},
            {"unobservable", QStringList{"backend JSON parse start/end", "individual binding durations outside QML profiler", "physical scanout"}}};
        if (!variantReadback.isEmpty()) report["variantReadback"] = variantReadback;
        if (selected["phase2"].toBool()) report["phase2Idle"] = idleReadback;
        if (selected["environmentCheck"].toBool()) {
            report["environmentReadback"] = environmentReadback;
            report["collectorStop"] = collectorStop;
            report["screenshot"] = screenshot;
            report["legacyEntryMode"] = HeaderFrameLocalCheck::argument("--perf-mode");
        }
        auto callback = std::move(done);
        callback(report);
        deleteLater();
    }
    void tickScene() {
        const auto time = relativeNow();
        if (scenario == "S1") {
            need(time - actionStart < 4000000000LL, "SMOOTHNESS_DRAWER_TIMEOUT");
            const auto feature = index < 20 ? QString("memory") : QString("settings");
            if (phase == 2) {
                if (!endpoint("memory", false) || !endpoint("settings", false)) return;
                event("drawer-open", {{"feature", feature}, {"cycle", index % 20 + 1}});
                click(window, "portal-" + feature);
                actionStart = relativeNow(); settledAt = -1; phase = 3;
            } else if (phase == 3 || phase == 4) {
                const bool open = phase == 3;
                if (!endpoint(feature, open)) { settledAt = -1; return; }
                if (settledAt < 0) settledAt = time;
                if (time - settledAt < 33000000LL || time - actionStart < 200000000LL) return;
                event(open ? "drawer-open-complete" : "drawer-close-complete", {{"feature", feature}, {"cycle", index % 20 + 1}});
                if (open) {
                    event("drawer-close", {{"feature", feature}, {"cycle", index % 20 + 1}});
                    click(window, feature + "-close");
                    actionStart = relativeNow(); settledAt = -1; phase = 4;
                } else {
                    ++index;
                    if (index == 40) { finishMeasurement(); return; }
                    phase = 2; actionStart = time;
                }
            }
        } else if (scenario == "S2") {
            need(time - actionStart < 10000000000LL, "SMOOTHNESS_PAGE_TIMEOUT");
            if (index == operations.size()) { finishMeasurement(); return; }
            const auto op = operations[index].toMap();
            const auto feature = op["feature"].toString(), subentry = op["subentry"].toString();
            if (phase == 2) { navigate(feature, subentry); phase = 3; }
            else if (phase == 3 && navigationReady(feature, subentry)) {
                if (settledAt < 0) settledAt = time;
                if (time - settledAt < 250000000LL) return;
                event("page-ready", {{"index", index}, {"feature", feature}, {"subentry", subentry}});
                navigate("chat", "companion"); phase = 4;
            } else if (phase == 4 && navigationReady("chat", "companion") && time - actionStart > 250000000LL) {
                ++index; phase = 2; actionStart = time;
            }
        } else if (scenario == "S3") {
            if (phase == 2) {
                need(time - actionStart < 10000000000LL, "SMOOTHNESS_READING_OPEN_TIMEOUT");
                if (navigationReady("chat", "reading")) { phase = 3; actionStart = time; event("scroll-start"); }
            } else if (phase == 3) {
                const int desired = int((time - actionStart) / 100000000LL);
                if (wheels < selected["wheelEvents"].toInt() && desired >= wheels) {
                    const auto point = history->mapToScene(QPointF(history->width() / 2, history->height() / 2));
                    const bool older = wheels < 285 && (wheels / 15) % 2 == 0;
                    QTest::wheelEvent(window, point, QPoint(0, older ? 240 : -240), QPoint(),
                                      Qt::NoModifier, Qt::NoScrollPhase);
                    event("wheel", {{"index", wheels}, {"older", older}});
                    ++wheels;
                } else if (wheels == selected["wheelEvents"].toInt() && time - actionStart >= 32000000000LL) finishMeasurement();
            }
        } else if (scenario == "S4") {
            const auto presentation = turns < 2 ? QString("companion") : QString("reading");
            need(time - actionStart < 60000000000LL, "SMOOTHNESS_REPLY_TIMEOUT");
            if (phase == 2 && navigationReady("chat", presentation) && !session->busy()) {
                click(window, "chatComposer");
                QTest::keyClick(window, Qt::Key_A, Qt::ControlModifier, 0);
                QInputMethodEvent input;
                input.setCommitString(QStringLiteral("性能短回复"));
                QCoreApplication::sendEvent(window, &input);
                beforeMessages = session->messages().size();
                event("reply-send", {{"turn", turns}, {"presentation", presentation}, {"fixture", "short"}});
                click(window, "sendChat");
                phase = 3; actionStart = relativeNow();
            } else if (phase == 3) {
                if (!session->busy() && session->messages().size() > beforeMessages) {
                    const auto message = session->messages().last().toMap();
                    if (message["role"] != "assistant") return;
                    event("reply-complete", {{"turn", turns}, {"rows", session->messages().size()}});
                    ++turns;
                    if (turns == 4) { finishMeasurement(); return; }
                    navigate("chat", turns < 2 ? "companion" : "reading"); phase = 2;
                }
            }
        }
    }
    void tick() {
        if (ticking || finished) return;
        ticking = true;
        try {
            need(elapsed.elapsed() < selected["nativeTimeoutMs"].toInt(300000) + (phase == 10 || phase == 11 ? 8000 : 0), "SMOOTHNESS_SCENE_TIMEOUT");
            need(session->connected(), "SMOOTHNESS_BACKEND_DISCONNECTED");
            if (phase == 0) initialize();
            else if (phase == 1) {
                if (relativeNow() - actionStart >= 2000000000LL &&
                    (!selected["profiler"].toBool() || QFileInfo::exists(output + "/profiler-ready.json"))) beginScene();
            }
            else if (phase == 11) tickIdleReadback();
            else if (phase == 10) tickScreenshot();
            else if (phase == 9) {
                if (!selected["profiler"].toBool() || QFileInfo::exists(output + "/profiler-flushed.json")) finish();
                else need(relativeNow() - actionStart < 30000000000LL, "SMOOTHNESS_PROFILER_FLUSH_TIMEOUT");
            } else tickScene();
        } catch (const std::exception &error) { finish(QString::fromUtf8(error.what())); }
        ticking = false;
    }
public:
    Runner(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *a, Completion callback)
        : QObject(w), window(w), session(s), editor(a), selected(context()),
          output(selected["outputDirectory"].toString()), scenario(selected["scenario"].toString()),
          variant(selected["variant"].toString()), done(std::move(callback)) {
        elapsed.start();
        timer.setInterval(16);
        timer.setTimerType(Qt::PreciseTimer);
        connect(&timer, &QTimer::timeout, this, [this] { tick(); });
        timer.start();
    }
};
}
bool requested() { return qEnvironmentVariable("REVERIE_SMOOTHNESS_DIAGNOSTIC") == "1"; }
void bootstrap(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *, const QString &model,
               const QString &endpoint, int rows, std::function<void(bool, QVariantMap)> callback) {
    new Bootstrap(window, session, model, endpoint, rows, std::move(callback));
}
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, Completion callback) {
    const auto selected = context();
    if (selected["scenario"] == "control") {
        HeaderFramePositiveControl::run(window, session, selected["outputDirectory"].toString(),
            selected.toVariantMap(), [callback = std::move(callback)](QVariantMap report) mutable {
                const bool valid = report.value("measurementValid").toBool();
                callback({{"schema", "reverie.qt.smoothness.control.v1"}, {"package", "smoothness-20261115"},
                    {"passed", true}, {"completed", true}, {"measurementValid", valid}, {"rawControl", report}});
            });
    } else new Runner(window, session, editor, std::move(callback));
}
}
