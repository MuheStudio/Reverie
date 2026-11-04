#pragma once

// W4 local diagnostics only. This runner does not execute, replace, or relax
// SceneSurfaceCheck or the performance scenario contracts.
#include "HeaderFrameTiming.h"
#include "HeaderFrameThermal.h"
#include "HeaderFramePositiveControl.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include <QCoreApplication>
#include <QBuffer>
#include <QCryptographicHash>
#include <QDir>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJSValue>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJsonValue>
#include <QImage>
#include <QPointer>
#include <QProcessEnvironment>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickWindow>
#include <QStringList>
#include <QTest>
#include <QTimer>
#include <QVariantMap>
#include <QVector2D>
#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <iterator>
#include <memory>
#include <stdexcept>
#include <vector>

namespace HeaderFrameLocalCheck {
using Completion = std::function<void(QVariantMap)>;
inline const QString Package = QStringLiteral("preview-header-frame-20261102");
inline const QString Prefix = QStringLiteral("REVERIE_HEADER_FRAME_");
inline constexpr int WindowCapacity = 40;
inline constexpr int ProgressCapacity = 512;
inline constexpr qint64 ActionTimeoutNs = 4000000000LL;
inline constexpr qint64 ScenarioTimeoutNs = 240000000000LL;
inline constexpr qint64 ClickCoverageNs = 200000000LL;

inline bool requested() {
    const auto environment = QProcessEnvironment::systemEnvironment();
    for (const auto &name : environment.keys())
        if (name.startsWith(Prefix)) return true;
    return false;
}
inline void require(bool condition, const char *message) {
    if (!condition) throw std::runtime_error(message);
}
inline QVariant normalized(const QVariant &value) {
    return value.metaType() == QMetaType::fromType<QJSValue>()
        ? value.value<QJSValue>().toVariant() : value;
}
inline QJsonObject readObject(const QString &path, QString *sha256 = nullptr) {
    const QFileInfo info(path);
    require(info.isFile() && !info.isSymLink(), "W4_LOCAL_EVIDENCE_NOT_REGULAR_FILE");
    QFile file(path);
    require(file.open(QIODevice::ReadOnly) && file.size() <= 1024 * 1024,
            "W4_LOCAL_EVIDENCE_UNREADABLE");
    QJsonParseError error;
    const auto payload = file.readAll();
    if (sha256) *sha256 = QString::fromLatin1(QCryptographicHash::hash(payload, QCryptographicHash::Sha256).toHex());
    const auto document = QJsonDocument::fromJson(payload, &error);
    require(error.error == QJsonParseError::NoError && document.isObject(),
            "W4_LOCAL_EVIDENCE_INVALID_JSON");
    return document.object();
}
inline QString canonicalDirectory(const QString &path) {
    require(QDir::isAbsolutePath(path) && QFileInfo(path).isDir()
            && QFileInfo(path).canonicalFilePath() == QDir::cleanPath(path),
            "W4_LOCAL_DIRECTORY_NOT_CANONICAL");
    return QDir::cleanPath(path);
}
inline QString argument(const QString &name) {
    const auto arguments = QCoreApplication::arguments();
    QString value;
    bool found = false;
    for (int i = 1; i < arguments.size(); ++i) {
        if (arguments[i] == name || arguments[i].startsWith(name + "=")) {
            require(!found, "W4_DUPLICATE_CONTEXT_ARGUMENT");
            found = true;
            if (arguments[i] == name) {
                require(i + 1 < arguments.size(), "W4_CONTEXT_ARGUMENT_MISSING_VALUE");
                value = arguments[++i];
            } else value = arguments[i].mid(name.size() + 1);
        }
    }
    require(found && !value.isEmpty(), "W4_CONTEXT_ARGUMENT_REQUIRED");
    return value;
}
struct Selection {
    QString variant, outputDirectory, screenshot;
    QVariantMap evidence;
};
inline Selection validateSelection(const QString &mode, int rows, const QString &reportPrefix,
                                   const QString &protocol, const QString &diagnosticCase) {
    const auto environment = QProcessEnvironment::systemEnvironment();
    const QStringList allowed{Prefix + "LOCAL", Prefix + "VARIANT", Prefix + "SIZE",
                              Prefix + "OUTPUT", Prefix + "PACKAGE", Prefix + "SCREENSHOT"};
    for (const auto &name : environment.keys())
        require(!name.startsWith(Prefix) || allowed.contains(name), "W4_UNKNOWN_ENVIRONMENT_FIELD");
    for (const auto &name : allowed)
        require(environment.contains(name) && !environment.value(name).isEmpty(), "W4_ENVIRONMENT_FIELD_REQUIRED");
    require(environment.value(Prefix + "LOCAL") == "1"
            && environment.value(Prefix + "PACKAGE") == Package
            && environment.value(Prefix + "SIZE") == "wide", "W4_LOCAL_SELECTION_INVALID");
    const QString variant = environment.value(Prefix + "VARIANT");
    require(QStringList{"baseline", "reduced-transparency", "half-resolution", "drawer-background-off",
                         "blur-half-resolution", "gpu-positive-control"}.contains(variant),
            "W4_VARIANT_UNSUPPORTED");
    const QString screenshot = environment.value(Prefix + "SCREENSHOT");
    require(screenshot == "none" || (screenshot == "memory-open"
            && QStringList{"baseline", "half-resolution", "blur-half-resolution"}.contains(variant)),
            "W4_SCREENSHOT_SELECTION_INVALID");
    require(mode == "perf" && rows == 9 && protocol == "stress-v1" && diagnosticCase.isEmpty(),
            "W4_BOOTSTRAP_ARGUMENTS_INVALID");
    const auto output = canonicalDirectory(environment.value(Prefix + "OUTPUT"));
    require(QDir::cleanPath(reportPrefix) == output + "/header-frame.scene.json",
            "W4_REPORT_PATH_MISMATCH");
    const auto context = readObject(argument("--context"));
    require(context.value("schema") == "reverie.qt.isolation.v1", "W4_ISOLATION_CONTEXT_REQUIRED");
    const auto description = context.value("w4").toObject();
    require(description.value("schema") == "reverie.qt.header-frame-local-context.v2"
            && description.value("kind") == "local" && description.value("diagnostic").isBool()
            && description.value("diagnostic").toBool() && description.value("package") == Package
            && description.value("variant") == variant && description.value("windowSize") == "wide"
            && description.value("screenshot") == screenshot
            && description.value("outputDirectory") == output, "W4_LOCAL_CONTEXT_MISMATCH");
    const auto build = canonicalDirectory(description.value("buildDirectory").toString());
    const auto project = QFileInfo(build + "/../../..").canonicalFilePath();
    require(!project.isEmpty() && build == project + "/.tools/qt-builds/local-" + Package
            && output.startsWith(project + "/.tools/local/" + Package + "/runs/"),
            "W4_LOCAL_PACKAGE_PATH_MISMATCH");
    const QString activePath = project + "/.tools/registered-run/active-local.json";
    require(description.value("activeLocalPath") == activePath, "W4_ACTIVE_LOCAL_PATH_MISMATCH");
    const auto active = readObject(activePath);
    const auto metadata = active.value("metadata").toObject();
    require(active.value("schema") == "reverie.active-local-run.v1"
            && !description.value("activeRunId").toString().isEmpty()
            && active.value("runId") == description.value("activeRunId")
            && metadata.value("package") == Package && metadata.value("outputDirectory") == output,
            "W4_ACTIVE_LOCAL_CONTEXT_MISMATCH");
    QString buildSha256;
    const auto record = readObject(build + "/build.json", &buildSha256);
    const auto local = record.value("localIteration").toObject();
    const auto diagnostics = record.value("diagnostics").toObject();
    require(record.value("schema") == "reverie.qt.local-build.v2" && record.value("candidate").isNull()
            && local.value("package") == Package && local.value("acceptanceEligible").isBool()
            && !local.value("acceptanceEligible").toBool()
            && diagnostics.value("ordinaryLauncherAllowed").toBool()
            && !diagnostics.value("qmlProfilerEnabled").toBool()
            && !diagnostics.value("timingProbesEnabled").toBool(), "W4_LOCAL_BUILD_EVIDENCE_INVALID");
    require(QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath()
                == build + "/Reverie Scene.app/Contents/MacOS/Reverie Scene",
            "W4_LOCAL_EXECUTABLE_MISMATCH");
    QVariantMap positiveEvidence;
    if (variant != "gpu-positive-control") {
        const auto proof = description.value("positiveControlEvidence").toObject();
        require(proof.value("measurementValid").isBool() && proof.value("measurementValid").toBool()
                && proof.value("independentRawValidation").isBool() && proof.value("independentRawValidation").toBool()
                && proof.value("buildManifestSha256") == buildSha256
                && proof.value("sequence").isDouble() && proof.value("sequence").toInt() > 0
                && proof.value("sequence").toInt() < metadata.value("sequence").toInt(),
                "W4_VALID_POSITIVE_CONTROL_EVIDENCE_REQUIRED");
        for (const auto &name : {QStringLiteral("summary"), QStringLiteral("scene")}) {
            const auto artifact = proof.value(name).toObject();
            const auto path = artifact.value("path").toString();
            const auto hash = artifact.value("sha256").toString();
            require(path.startsWith(project + "/.tools/local/" + Package + "/runs/")
                    && !path.startsWith(output + "/") && hash.size() == 64
                    && std::all_of(hash.cbegin(), hash.cend(), [](QChar value) {
                        return (value >= QChar('0') && value <= QChar('9')) || (value >= QChar('a') && value <= QChar('f'));
                    }) && artifact.value("bytes").isDouble() && artifact.value("bytes").toDouble() > 0,
                    "W4_POSITIVE_CONTROL_ARTIFACT_DESCRIPTOR_INVALID");
        }
        positiveEvidence = proof.toVariantMap();
    }
    return {variant, output, screenshot, {{"contextSchema", description.value("schema").toString()},
        {"activeRunId", active.value("runId").toString()}, {"package", Package},
        {"outputDirectory", output}, {"buildDirectory", build}, {"screenshot", screenshot},
        {"variant", variant}, {"buildManifestSha256", buildSha256}, {"positiveControlEvidence", positiveEvidence},
        {"scope", "Read-only local context, active-local marker and build record checks; local driver independently verifies prior positive-control raw artifacts; ordinary isolation and driver source/signature checks remain separate"}}};
}
inline QQuickItem *findItem(QQuickItem *root, const QString &name) {
    if (!root) return nullptr;
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems())
        if (auto *found = findItem(child, name)) return found;
    return nullptr;
}
inline QVariant nullable(qint64 value) {
    return value < 0 ? QJsonValue(QJsonValue::Null).toVariant() : QVariant::fromValue(value);
}
struct ProgressSample {
    qint64 atNs = 0;
    double progress = 0;
    int phase = 0; // 1 opening; 2 closing
    int transition = 0; // 0 unknown; 1 closed; 2 opening; 3 open; 4 closing; 5 dragging
};
struct Window {
    QString feature;
    int cycle = 0, progressCount = 0, droppedProgress = 0;
    qint64 openClickNs = -1, openMotionStartNs = -1, openMotionEndNs = -1, openCompleteNs = -1;
    qint64 closeClickNs = -1, closeMotionStartNs = -1, closeMotionEndNs = -1, closeCompleteNs = -1;
    QVariantMap thermal;
    std::array<ProgressSample, ProgressCapacity> progress;
};

class Runner final : public QObject {
public:
    Runner(QQuickWindow *window, RuntimeBridge *session, Selection selection, Completion completion)
        : QObject(window), m_window(window), m_session(session), m_selection(std::move(selection)),
          m_completion(std::move(completion)) {
        m_clock.start();
        m_timer.setInterval(16);
        m_timer.setTimerType(Qt::PreciseTimer);
        connect(&m_timer, &QTimer::timeout, this, [this] { tick(); });
        if (window) {
            connect(window, &QQuickWindow::frameSwapped, this, [this] { ++m_naturalSwaps; });
            connect(window, &QObject::destroyed, this, [this] { finish(false, "W4_WINDOW_DESTROYED"); });
        }
        QTimer::singleShot(0, this, [this] { m_timer.start(); tick(); });
    }
    ~Runner() override { if (m_observer) m_observer->stop(); }
private:
    QPointer<QQuickWindow> m_window;
    QPointer<RuntimeBridge> m_session;
    QPointer<QQuickItem> m_compositor;
    Selection m_selection;
    Completion m_completion;
    QElapsedTimer m_clock;
    QTimer m_timer;
    std::unique_ptr<HeaderFrameTiming::Observer> m_observer;
    std::array<Window, WindowCapacity> m_windows;
    QVariantMap m_initialThermal, m_variantReadback, m_timingSnapshot, m_screenshot;
    qint64 m_measurementStoppedNs = -1;
    quint64 m_naturalSwaps = 0, m_screenshotSwapGoal = 0;
    struct BlurTarget {
        QString path;
        QPointer<QQuickItem> root, horizontalCapture, verticalCapture;
        QPointer<QObject> source;
    };
    struct CaptureTarget {
        QString path;
        QPointer<QQuickItem> capture, owner;
        QPointer<QObject> originalSourceItem;
        QSize originalSize;
        bool surfaceCapture = false;
    };
    std::vector<BlurTarget> m_blurTargets;
    std::vector<CaptureTarget> m_captureTargets;
    std::array<QPointer<QQuickItem>, 3> m_blurStages;
    int m_completed = 0, m_windowCount = 0;
    enum class Phase { Initialize, Capability, Closed, Opening, Closing, ScreenshotOpening, ScreenshotStable };
    Phase m_phase = Phase::Initialize;
    qint64 m_actionBeginNs = 0, m_endpointObservedNs = -1;
    bool m_inTick = false, m_finished = false;

    qint64 now() const { return m_clock.nsecsElapsed(); }
    QQuickItem *item(const QString &name) const {
        auto *found = findItem(m_window ? m_window->contentItem() : nullptr, name);
        require(found, "W4_CONTROL_UNAVAILABLE");
        return found;
    }
    QQuickItem *drawer(const QString &feature) const { return item("drawer-" + feature); }
    bool endpoint(const QString &feature, bool open) const {
        auto *surface = drawer(feature);
        const double progress = surface->property("progress").toDouble();
        return !surface->property("dragging").toBool()
            && surface->property("transitionState").toString() == (open ? "open" : "closed")
            && std::abs(progress - (open ? 1. : 0.)) < .001
            && (!open || surface->property("inputReady").toBool());
    }
    void click(const QString &name) {
        auto *control = item(name);
        double opacity = 1;
        QRectF exposed = control->mapRectToScene(QRectF(0, 0, control->width(), control->height()))
            .intersected(QRectF(0, 0, m_window->width(), m_window->height()));
        for (auto *ancestor = control; ancestor; ancestor = ancestor->parentItem()) {
            opacity *= ancestor->opacity();
            if (ancestor != control && ancestor->clip())
                exposed = exposed.intersected(ancestor->mapRectToScene(QRectF(0, 0, ancestor->width(), ancestor->height())));
        }
        require(control->isVisible() && control->isEnabled() && opacity > .05 && !exposed.isEmpty(),
                "W4_CONTROL_CLIPPED_OR_DISABLED");
        QTest::mouseClick(m_window, Qt::LeftButton, Qt::NoModifier, exposed.center().toPoint(), 0);
    }
    static bool has(QObject *object, const char *name) {
        return object && object->metaObject()->indexOfProperty(name) >= 0;
    }
    static QObject *objectProperty(QObject *object, const char *name) {
        const auto value = object->property(name);
        return value.metaType() == QMetaType::fromType<QJSValue>()
            ? value.value<QJSValue>().toQObject() : value.value<QObject *>();
    }
    static QString identity(QObject *object) {
        return object ? "0x" + QString::number(reinterpret_cast<quintptr>(object), 16) : QStringLiteral("null");
    }
    static bool isBlur(QQuickItem *object) {
        return has(object, "source") && has(object, "active") && has(object, "pixelRatio")
            && has(object, "sourceSize") && has(object, "texture");
    }
    static QVariantMap sizeMap(QSize size) { return {{"width", size.width()}, {"height", size.height()}}; }
    void rememberBlur(QQuickItem *root, const QString &path) {
        require(isBlur(root), "W4_BLUR_ONLY_SHARED_BLUR_SHAPE_MISMATCH");
        auto *vertical = qobject_cast<QQuickItem *>(objectProperty(root, "texture"));
        require(vertical && vertical->parentItem() == root && has(vertical, "sourceItem")
                && has(vertical, "textureSize"), "W4_BLUR_ONLY_TEXTURE_ALIAS_MISMATCH");
        QQuickItem *horizontal = nullptr;
        for (auto *child : root->childItems()) {
            if (child != vertical && has(child, "sourceItem") && has(child, "textureSize")) {
                require(!horizontal, "W4_BLUR_ONLY_AMBIGUOUS_HORIZONTAL_CAPTURE");
                horizontal = child;
            }
        }
        auto *source = objectProperty(root, "source");
        require(horizontal && source && std::abs(root->property("pixelRatio").toDouble() - 2.) < 1e-6,
                "W4_BLUR_ONLY_INITIAL_ROOT_INVALID");
        for (const auto &target : m_blurTargets) require(target.root != root, "W4_BLUR_ONLY_DUPLICATE_ROOT");
        m_blurTargets.push_back({path, root, horizontal, vertical, source});
    }
    void rememberCapture(QQuickItem *capture, QQuickItem *owner, const QString &path, bool surface = false) {
        require(capture && owner && capture->parentItem() == owner && has(capture, "sourceItem")
                && has(capture, "textureSize"), "W4_BLUR_ONLY_CAPTURE_SHAPE_MISMATCH");
        for (const auto &target : m_captureTargets) require(target.capture != capture, "W4_BLUR_ONLY_DUPLICATE_CAPTURE");
        m_captureTargets.push_back({path, capture, owner, objectProperty(capture, "sourceItem"),
            capture->property("textureSize").toSize(), surface});
    }
    QVariantMap blurOnlyProof(bool unchangedGeometry) const {
        require(m_compositor && std::abs(m_compositor->property("pixelRatio").toDouble() - 2.) < 1e-6
                && m_blurTargets.size() == 5 && m_captureTargets.size() == 8,
                "W4_BLUR_ONLY_ROOT_OR_CAPTURE_COUNT_CHANGED");
        QVariantList stages, blurs, captures;
        for (int index = 0; index < 3; ++index) {
            auto *stage = m_blurStages[size_t(index)].data();
            require(stage && stage->property("index").toInt() == index
                    && std::abs(stage->property("pixelRatio").toDouble() - 2.) < 1e-6,
                    "W4_BLUR_ONLY_STAGE_RATIO_CHANGED");
            stages.append(QVariantMap{{"index", index}, {"identity", identity(stage)}, {"pixelRatio", 2.}});
        }
        for (const auto &target : m_blurTargets) {
            auto *root = target.root.data();
            require(root && target.horizontalCapture && target.verticalCapture
                    && target.horizontalCapture->parentItem() == root && target.verticalCapture->parentItem() == root
                    && objectProperty(root, "texture") == target.verticalCapture.data()
                    && objectProperty(root, "source") == target.source.data()
                    && std::abs(root->property("pixelRatio").toDouble() - 1.) < 1e-6,
                    "W4_BLUR_ONLY_TARGET_IDENTITY_OR_RATIO_CHANGED");
            const auto sourceSize = root->property("sourceSize").value<QVector2D>();
            const QSize expected(qRound(root->width()), qRound(root->height()));
            require(std::abs(sourceSize.x() - root->width()) < .01
                    && std::abs(sourceSize.y() - root->height()) < .01
                    && target.horizontalCapture->property("textureSize").toSize() == expected
                    && target.verticalCapture->property("textureSize").toSize() == expected,
                    "W4_BLUR_ONLY_TARGET_SIZE_READBACK_FAILED");
            blurs.append(QVariantMap{{"path", target.path}, {"identity", identity(root)},
                {"pixelRatio", root->property("pixelRatio")}, {"sourceIdentityBefore", identity(target.source)},
                {"sourceIdentityAfter", identity(objectProperty(root, "source"))},
                {"sourceUnchanged", true}, {"sourceSize", QVariantMap{{"width", sourceSize.x()}, {"height", sourceSize.y()}}},
                {"horizontalCaptureIdentity", identity(target.horizontalCapture)},
                {"verticalCaptureIdentity", identity(target.verticalCapture)},
                {"horizontalTextureSize", sizeMap(target.horizontalCapture->property("textureSize").toSize())},
                {"verticalTextureSize", sizeMap(target.verticalCapture->property("textureSize").toSize())}});
        }
        for (const auto &target : m_captureTargets) {
            require(target.capture && target.owner, "W4_BLUR_ONLY_CAPTURE_DESTROYED");
            const auto actual = target.capture->property("textureSize").toSize();
            QSize expected(qRound(target.owner->width() * 2), qRound(target.owner->height() * 2));
            if (target.surfaceCapture) {
                const auto rect = target.capture->property("sourceRect").toRectF();
                expected = QSize(std::max(1, qRound(rect.width() * 2)), std::max(1, qRound(rect.height() * 2)));
            }
            require(actual == expected, "W4_BLUR_ONLY_SOURCE_CAPTURE_NOT_FULL_RESOLUTION");
            if (unchangedGeometry) require(actual == target.originalSize
                && objectProperty(target.capture, "sourceItem") == target.originalSourceItem.data(),
                "W4_BLUR_ONLY_SOURCE_CAPTURE_CHANGED_DURING_APPLY");
            captures.append(QVariantMap{{"path", target.path}, {"identity", identity(target.capture)},
                {"textureSizeBefore", sizeMap(target.originalSize)}, {"textureSizeAfter", sizeMap(actual)},
                {"expectedFullResolutionSize", sizeMap(expected)}, {"matchesFullResolution", true},
                {"sourceItemBefore", identity(target.originalSourceItem)},
                {"sourceItemAfter", identity(objectProperty(target.capture, "sourceItem"))},
                {"sameGeometryComparison", unchangedGeometry}});
        }
        return {{"performed", true}, {"blurCount", 5}, {"sourceCaptureCount", 8}, {"compositorPixelRatio", 2.},
            {"stages", stages}, {"blurs", blurs}, {"sourceCaptures", captures},
            {"scope", "Only five existing SharedBlur.pixelRatio properties written; source identities retained. Existing base/lower/surface/combined captures and stage pixelRatio stay full resolution. Sizes are requested property readbacks, not measured GPU allocation. Logical paths are checker labels, not added product objectNames."}};
    }
    void applyBlurOnly() {
        require(std::abs(m_compositor->property("pixelRatio").toDouble() - 2.) < 1e-6,
                "W4_BLUR_ONLY_REQUIRES_INITIAL_RATIO_TWO");
        auto *baseTexture = qobject_cast<QQuickItem *>(objectProperty(m_compositor, "baseTexture"));
        auto *dialogueTexture = qobject_cast<QQuickItem *>(objectProperty(m_compositor, "dialogueTexture"));
        auto *baseBlur = qobject_cast<QQuickItem *>(objectProperty(m_compositor, "baseBlur"));
        auto *dialogueBlur = qobject_cast<QQuickItem *>(objectProperty(m_compositor, "dialogueBlur"));
        require(baseBlur && dialogueBlur, "W4_BLUR_ONLY_NAMED_COMPOSITOR_ALIASES_REQUIRED");
        rememberBlur(baseBlur->parentItem(), "layerCompositor.baseBlur.parentItem");
        rememberBlur(dialogueBlur->parentItem(), "layerCompositor.dialogueBlur.parentItem");
        rememberCapture(baseTexture, m_compositor, "layerCompositor.baseTexture");
        rememberCapture(dialogueTexture, m_compositor, "layerCompositor.dialogueTexture");
        for (auto *child : m_compositor->childItems()) {
            if (!has(child, "index") || !has(child, "surface") || !has(child, "capturePadding")
                    || !has(child, "coordinateRoot") || !has(child, "previousSource") || !has(child, "previousBlur")) continue;
            const int index = child->property("index").toInt();
            require(index >= 0 && index < 3 && !m_blurStages[size_t(index)]
                    && std::abs(child->property("pixelRatio").toDouble() - 2.) < 1e-6,
                    "W4_BLUR_ONLY_STAGE_STRUCTURE_MISMATCH");
            m_blurStages[size_t(index)] = child;
            int blurCount = 0, captureCount = 0;
            for (auto *nested : child->childItems()) {
                const QString path = QString("layerCompositor.stage[%1]").arg(index);
                if (isBlur(nested)) { rememberBlur(nested, path + ".SharedBlur"); ++blurCount; }
                else if (has(nested, "sourceItem") && has(nested, "textureSize")) {
                    const bool surface = !nested->property("hideSource").toBool();
                    rememberCapture(nested, child, path + (surface ? ".surfaceCapture" : ".combinedCapture"), surface);
                    ++captureCount;
                }
            }
            require(blurCount == 1 && captureCount == 2, "W4_BLUR_ONLY_STAGE_CHILDREN_MISMATCH");
        }
        require(m_blurTargets.size() == 5 && m_captureTargets.size() == 8, "W4_BLUR_ONLY_EXPECTED_FIVE_INSTANCES_MISSING");
        for (const auto &target : m_blurTargets)
            require(QQmlProperty(target.root, "pixelRatio").write(1.), "W4_BLUR_ONLY_PROPERTY_WRITE_FAILED");
        m_variantReadback["blurOnlyProof"] = blurOnlyProof(true);
    }
    void initialize() {
        require(m_window && m_session && m_window->isVisible() && m_window->width() == 1380
                && m_window->height() == 900, "W4_WIDE_OWNED_WINDOW_REQUIRED");
        require(m_session->connected() && !m_session->busy() && !m_session->reducedMotion()
                && !m_session->reducedTransparency(), "W4_ANIMATED_BOOTSTRAP_REQUIRED");
        auto *avatar = qobject_cast<NativeAvatar *>(item("nativeAvatar"));
        require(avatar && avatar->running() && !avatar->modelPath().isEmpty() && avatar->loads() > 0,
                "W4_NATIVE_MODEL_BOOTSTRAP_REQUIRED");
        m_compositor = item("layerCompositor");
        require(m_compositor->property("effectsActive").toBool(), "W4_BASELINE_EFFECTS_REQUIRED");
        const double originalRatio = m_compositor->property("pixelRatio").toDouble();
        require(std::isfinite(originalRatio) && originalRatio > 0, "W4_PIXEL_RATIO_INVALID");
        m_initialThermal = HeaderFrameThermal::snapshot();
        if (m_selection.variant == "reduced-transparency") m_session->setReducedTransparency(true);
        else if (m_selection.variant == "half-resolution") {
            require(m_compositor->setProperty("pixelRatio", originalRatio / 2.), "W4_PIXEL_RATIO_WRITE_FAILED");
        } else if (m_selection.variant == "drawer-background-off") {
            auto *context = QQmlEngine::contextForObject(m_compositor);
            require(context && context->engine(), "W4_COMPOSITOR_QML_CONTEXT_REQUIRED");
            require(m_compositor->setProperty("surfaces", QVariant::fromValue(context->engine()->newArray(0))),
                    "W4_COMPOSITOR_SURFACES_WRITE_FAILED");
        } else if (m_selection.variant == "blur-half-resolution") applyBlurOnly();
        const double ratio = m_compositor->property("pixelRatio").toDouble();
        const bool effects = m_compositor->property("effectsActive").toBool();
        const bool reduced = m_session->reducedTransparency();
        const int surfaceCount = normalized(m_compositor->property("surfaces")).toList().size();
        require(reduced == (m_selection.variant == "reduced-transparency")
                && effects == !reduced
                && std::abs(ratio - originalRatio * (m_selection.variant == "half-resolution" ? .5 : 1.)) < 1e-6
                && surfaceCount == (m_selection.variant == "drawer-background-off" ? 0 : 3),
                "W4_VARIANT_READBACK_FAILED");
        const auto blurProof = m_variantReadback.value("blurOnlyProof");
        m_variantReadback = {{"objectName", "layerCompositor"}, {"originalPixelRatio", originalRatio},
            {"pixelRatio", ratio}, {"effectsActive", effects}, {"sessionReducedTransparency", reduced},
            {"surfaceCount", surfaceCount}, {"captureDiagnostics", normalized(m_compositor->property("captureDiagnostics"))},
            {"scope", m_selection.variant == "drawer-background-off"
                ? "All drawer backdrop-composition stages disabled; base/lower capture and blur retained; drawer own glass retained; compositor source fallback and orderOf change"
                : m_selection.variant == "half-resolution"
                    ? "Compositor capture/blur width and height halved; excludes avatar FBO/capture and other Qt item layers"
                    : m_selection.variant == "blur-half-resolution"
                        ? "Five existing SharedBlur roots use pixelRatio=1; compositor and all base/lower/surface/combined source captures retain ratio=2; no product objectNames or properties added"
                    : m_selection.variant == "reduced-transparency"
                        ? "Existing reduced-transparency appearance; shadows/environment/avatar remain; isolated appearance file may be persisted"
                        : "Unmodified isolated UI baseline"}};
        if (m_selection.variant == "blur-half-resolution") m_variantReadback["blurOnlyProof"] = blurProof;
        m_screenshot = {{"requested", m_selection.screenshot}, {"performed", false}, {"timingStopped", false}};
        m_observer = std::make_unique<HeaderFrameTiming::Observer>(m_window, [this] { return now(); },
            HeaderFrameTiming::Options{true, false});
        m_phase = Phase::Capability;
        m_actionBeginNs = now();
    }
    static int transition(const QString &name) {
        return name == "closed" ? 1 : name == "opening" ? 2 : name == "open" ? 3
            : name == "closing" ? 4 : name == "dragging" ? 5 : 0;
    }
    static const char *transitionName(int value) {
        return value == 1 ? "closed" : value == 2 ? "opening" : value == 3 ? "open"
            : value == 4 ? "closing" : value == 5 ? "dragging" : "unknown";
    }
    void sample() {
        if (!m_windowCount || (m_phase != Phase::Opening && m_phase != Phase::Closing)) return;
        auto &window = m_windows[m_windowCount - 1];
        auto *surface = drawer(window.feature);
        const double progress = surface->property("progress").toDouble();
        require(std::isfinite(progress), "W4_PROGRESS_UNREADABLE");
        if (window.progressCount == ProgressCapacity) {
            ++window.droppedProgress;
            throw std::runtime_error("W4_PROGRESS_CAPACITY_EXCEEDED");
        }
        window.progress[window.progressCount++] = {now(), progress,
            m_phase == Phase::Opening ? 1 : 2, transition(surface->property("transitionState").toString())};
        if (m_phase == Phase::Opening && progress > .001 && window.openMotionStartNs < 0)
            window.openMotionStartNs = now();
        if (m_phase == Phase::Closing && progress < .999 && window.closeMotionStartNs < 0)
            window.closeMotionStartNs = now();
    }
    void beginWindow() {
        require(m_windowCount < WindowCapacity, "W4_WINDOW_CAPACITY_EXCEEDED");
        auto &window = m_windows[m_windowCount++];
        window.feature = m_windowCount <= 20 ? "memory" : "settings";
        window.cycle = (m_windowCount - 1) % 20 + 1;
        window.thermal = HeaderFrameThermal::snapshot();
        m_endpointObservedNs = -1;
        m_phase = Phase::Opening;
        window.openClickNs = m_actionBeginNs = now();
        click("portal-" + window.feature);
        sample();
    }
    bool settled(bool open) {
        auto &window = m_windows[m_windowCount - 1];
        if (!endpoint(window.feature, open)) { m_endpointObservedNs = -1; return false; }
        if (m_endpointObservedNs < 0) {
            m_endpointObservedNs = now();
            (open ? window.openMotionEndNs : window.closeMotionEndNs) = m_endpointObservedNs;
        }
        return now() - m_endpointObservedNs >= 33000000LL && now() - m_actionBeginNs >= ClickCoverageNs;
    }
    void stopMeasurement() {
        if (m_measurementStoppedNs >= 0) return;
        if (m_observer) { m_observer->stop(); m_timingSnapshot = m_observer->snapshot(); }
        m_measurementStoppedNs = now();
        m_screenshot["requested"] = m_selection.screenshot;
        m_screenshot["performed"] = false;
        m_screenshot["timingStopped"] = true;
        m_screenshot["measurementStoppedNs"] = m_measurementStoppedNs;
    }
    void measurementComplete() {
        stopMeasurement();
        if (m_selection.variant == "blur-half-resolution")
            m_variantReadback["blurOnlyProofAfterMeasurement"] = blurOnlyProof(false);
        if (m_selection.screenshot == "none") { finish(true); return; }
        require(m_selection.screenshot == "memory-open" && m_measurementStoppedNs >= 0,
                "W4_SCREENSHOT_TIMING_NOT_STOPPED");
        m_phase = Phase::ScreenshotOpening;
        m_endpointObservedNs = -1;
        m_actionBeginNs = now();
        m_screenshot["openClickNs"] = m_actionBeginNs;
        m_screenshot["scope"] = "Additional real memory header open after all forty timed windows and collector stop; not a forty-first timing window; same fixture content/layout, naturally animated pixels may differ";
        click("portal-memory");
    }
    void captureScreenshot() {
        require(m_measurementStoppedNs >= 0 && m_completed == WindowCapacity && endpoint("memory", true)
                && drawer("memory")->property("page").toString() == "worldbook",
                "W4_SCREENSHOT_OPEN_MEMORY_PRECONDITION_FAILED");
        // Revalidate local evidence before the only check-side image write.
        const auto selection = validateSelection("perf", 9, m_selection.outputDirectory + "/header-frame.scene.json",
                                                  "stress-v1", {});
        require(selection.outputDirectory == m_selection.outputDirectory && selection.screenshot == "memory-open",
                "W4_SCREENSHOT_LOCAL_CONTEXT_CHANGED");
        if (m_selection.variant == "blur-half-resolution")
            m_variantReadback["blurOnlyProofAtScreenshot"] = blurOnlyProof(false);
        const auto begin = now();
        const QImage image = m_window->grabWindow();
        const auto end = now();
        require(!image.isNull() && image.width() > 0 && image.height() > 0, "W4_SCREENSHOT_EMPTY_IMAGE");
        QByteArray bytes;
        QBuffer buffer(&bytes);
        require(buffer.open(QIODevice::WriteOnly) && image.save(&buffer, "PNG"), "W4_SCREENSHOT_PNG_ENCODING_FAILED");
        buffer.close();
        const QString path = m_selection.outputDirectory + "/header-frame.memory-open.png";
        QFile file(path);
        require(file.open(QIODevice::WriteOnly | QIODevice::NewOnly), "W4_SCREENSHOT_PATH_ALREADY_EXISTS_OR_UNWRITABLE");
        require(file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner)
                && file.write(bytes) == bytes.size() && file.flush(), "W4_SCREENSHOT_WRITE_FAILED");
        file.close();
        m_screenshot["performed"] = true;
        m_screenshot["path"] = path;
        m_screenshot["pixelWidth"] = image.width();
        m_screenshot["pixelHeight"] = image.height();
        m_screenshot["logicalWidth"] = m_window->width();
        m_screenshot["logicalHeight"] = m_window->height();
        m_screenshot["devicePixelRatio"] = m_window->effectiveDevicePixelRatio();
        m_screenshot["grabBeginNs"] = begin;
        m_screenshot["grabEndNs"] = end;
        m_screenshot["naturalFramesAfterStable"] = m_naturalSwaps - (m_screenshotSwapGoal - 2);
        m_screenshot["bytes"] = bytes.size();
        m_screenshot["sha256"] = QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
        m_screenshot["naturalAnimations"] = true;
        m_screenshot["pixelIdentityGuaranteed"] = false;
        m_screenshot["appearanceOrPoseOverrides"] = false;
        finish(true);
    }
    void tickScreenshot() {
        require(m_measurementStoppedNs >= 0 && now() - m_actionBeginNs <= ActionTimeoutNs,
                "W4_SCREENSHOT_ACTION_TIMEOUT");
        if (!endpoint("memory", true)) {
            require(m_phase == Phase::ScreenshotOpening, "W4_SCREENSHOT_MEMORY_LEFT_OPEN_ENDPOINT");
            m_endpointObservedNs = -1;
            return;
        }
        if (m_phase == Phase::ScreenshotOpening) {
            if (m_endpointObservedNs < 0) m_endpointObservedNs = now();
            if (now() - m_endpointObservedNs >= 33000000LL) {
                m_screenshot["stableOpenObservedNs"] = now();
                m_screenshotSwapGoal = m_naturalSwaps + 2;
                m_phase = Phase::ScreenshotStable;
            }
        } else if (m_naturalSwaps >= m_screenshotSwapGoal) captureScreenshot();
    }
    void tick() {
        if (m_finished || m_inTick) return;
        m_inTick = true;
        try {
            require(m_window && m_session, "W4_OWNED_OBJECT_DESTROYED");
            const bool screenshotPhase = m_phase == Phase::ScreenshotOpening || m_phase == Phase::ScreenshotStable;
            require(now() <= ScenarioTimeoutNs + (screenshotPhase ? ActionTimeoutNs : 0), "W4_SCENARIO_TIMEOUT");
            require(m_window->width() == 1380 && m_window->height() == 900 && m_window->isVisible(),
                    "W4_WINDOW_CHANGED_DURING_DIAGNOSTIC");
            if (screenshotPhase) tickScreenshot();
            else if (m_phase == Phase::Initialize) initialize();
            else if (m_phase == Phase::Capability) {
                require(now() - m_actionBeginNs <= ActionTimeoutNs, "W4_GPU_CAPABILITY_TIMEOUT");
                if (m_observer->capabilityResolved()) {
                    require(m_observer->queriesAvailable(), "W4_GPU_TIMING_UNAVAILABLE");
                    m_phase = Phase::Closed;
                    m_actionBeginNs = now();
                }
            } else {
                require(m_observer->queriesAvailable(), "W4_GPU_TIMING_BECAME_UNAVAILABLE");
                require(now() - m_actionBeginNs <= ActionTimeoutNs, "W4_ACTION_TIMEOUT");
                if (m_phase == Phase::Closed) {
                    if (endpoint("memory", false) && endpoint("settings", false)) beginWindow();
                } else {
                    sample();
                    if (m_phase == Phase::Opening && settled(true)) {
                        auto &window = m_windows[m_windowCount - 1];
                        window.openCompleteNs = now();
                        m_endpointObservedNs = -1;
                        m_phase = Phase::Closing;
                        window.closeClickNs = m_actionBeginNs = now();
                        click(window.feature + "-close");
                        sample();
                    } else if (m_phase == Phase::Closing && settled(false)) {
                        m_windows[m_windowCount - 1].closeCompleteNs = now();
                        ++m_completed;
                        if (m_completed == WindowCapacity) {
                            m_inTick = false;
                            measurementComplete();
                            return;
                        }
                        m_phase = Phase::Closed;
                        m_actionBeginNs = now();
                    }
                }
            }
        } catch (const std::exception &error) {
            m_inTick = false;
            finish(false, QString::fromUtf8(error.what()));
            return;
        }
        m_inTick = false;
    }
    struct FramePoint { qint64 atNs, id; };
    static std::vector<FramePoint> indexFrames(const QVariantList &frames) {
        std::vector<FramePoint> result;
        result.reserve(frames.size());
        for (const auto &value : frames) {
            const auto frame = value.toMap();
            if (!frame.value("beforeRenderNs").isNull() && !frame.value("frameId").isNull())
                result.push_back({frame.value("beforeRenderNs").toLongLong(), frame.value("frameId").toLongLong()});
        }
        std::stable_sort(result.begin(), result.end(), [](const FramePoint &a, const FramePoint &b) { return a.atNs < b.atNs; });
        return result;
    }
    static QVariant frameAt(const std::vector<FramePoint> &frames, qint64 atNs) {
        if (atNs < 0) return nullable(-1);
        const auto next = std::upper_bound(frames.begin(), frames.end(), atNs,
            [](qint64 time, const FramePoint &frame) { return time < frame.atNs; });
        return next == frames.begin() ? nullable(-1) : QVariant::fromValue(std::prev(next)->id);
    }
    static QVariantList frameIds(const std::vector<FramePoint> &frames, qint64 begin, qint64 end) {
        QVariantList result;
        if (begin < 0 || end < begin) return result;
        auto frame = std::lower_bound(frames.begin(), frames.end(), begin,
            [](const FramePoint &point, qint64 time) { return point.atNs < time; });
        while (frame != frames.end() && frame->atNs <= end) result.append(frame++->id);
        return result;
    }
    void finish(bool completed, QString error = {}) {
        if (m_finished) return;
        m_finished = true;
        m_timer.stop();
        stopMeasurement();
        const auto timing = m_timingSnapshot;
        const auto frames = indexFrames(timing.value("frames").toList());
        if (completed && timing.value("droppedFrames").toULongLong()) {
            completed = false;
            error = "W4_GPU_FRAME_CAPACITY_EXCEEDED";
        }
        if (completed && (!timing.value("queriesAvailable").toBool()
                || timing.value("glCallOverflow").toULongLong())) {
            completed = false;
            error = "W4_GPU_COLLECTOR_INVALID";
        }
        QVariantList windows;
        for (int index = 0; index < m_windowCount; ++index) {
            const auto &window = m_windows[index];
            QVariantList progress;
            for (int i = 0; i < window.progressCount; ++i) {
                const auto &sample = window.progress[i];
                progress.append(QVariantMap{{"atNs", sample.atNs}, {"progress", sample.progress},
                    {"phase", sample.phase == 1 ? "opening" : "closing"},
                    {"transitionState", transitionName(sample.transition)}, {"frameAtOrBefore", frameAt(frames, sample.atNs)}});
            }
            windows.append(QVariantMap{{"feature", window.feature}, {"cycle", window.cycle},
                {"completed", window.closeCompleteNs >= 0}, {"clickNs", nullable(window.openClickNs)},
                {"openClickNs", nullable(window.openClickNs)},
                {"openCompleteNs", nullable(window.openCompleteNs)}, {"closeClickNs", nullable(window.closeClickNs)},
                {"closeCompleteNs", nullable(window.closeCompleteNs)}, {"openMotionStartNs", nullable(window.openMotionStartNs)},
                {"openMotionEndNs", nullable(window.openMotionEndNs)}, {"closeMotionStartNs", nullable(window.closeMotionStartNs)},
                {"closeMotionEndNs", nullable(window.closeMotionEndNs)}, {"thermalBeforeOpen", window.thermal},
                {"openClickFrameAtOrBefore", frameAt(frames, window.openClickNs)},
                {"openCompleteFrameAtOrBefore", frameAt(frames, window.openCompleteNs)},
                {"closeClickFrameAtOrBefore", frameAt(frames, window.closeClickNs)},
                {"closeCompleteFrameAtOrBefore", frameAt(frames, window.closeCompleteNs)},
                {"openingFrameIds", frameIds(frames, window.openClickNs, window.openCompleteNs)},
                {"closingFrameIds", frameIds(frames, window.closeClickNs, window.closeCompleteNs)},
                {"progressSamples", progress}, {"progressDropped", window.droppedProgress}});
        }
        QVariantMap report{{"schema", "reverie.qt.header-frame-local.v2"}, {"scenario", "drawer-cycles"}, {"package", Package},
            {"variant", m_selection.variant}, {"windowSize", "wide"}, {"windowWidth", m_window ? m_window->width() : 0},
            {"windowHeight", m_window ? m_window->height() : 0}, {"acceptanceEligible", false},
            {"performanceComparable", false}, {"passed", completed && m_completed == WindowCapacity},
            {"completed", completed && m_completed == WindowCapacity}, {"error", error},
            {"elapsedNs", now()}, {"measurementStoppedNs", m_measurementStoppedNs},
            {"windowCount", m_windowCount}, {"completedWindowCount", m_completed},
            {"windows", windows}, {"headerFrameTiming", timing}, {"thermalAtStart", m_initialThermal},
            {"variantReadback", m_variantReadback}, {"localEvidence", m_selection.evidence}, {"screenshot", m_screenshot},
            {"constraints", QVariantMap{{"windowCapacity", WindowCapacity}, {"progressSamplesPerWindow", ProgressCapacity},
                {"cyclesPerFeature", 20}, {"actionTimeoutNs", ActionTimeoutNs}, {"scenarioTimeoutNs", ScenarioTimeoutNs},
                {"minimumCoverageAfterEachClickNs", ClickCoverageNs}, {"originalHeaderLatchExecuted", false},
                {"screenshotTimeoutNs", ActionTimeoutNs},
                {"scope", "Execution completeness only; no GPU/cadence/latency acceptance threshold; original SceneSurfaceCheck and HeaderOpenObservation are not executed or changed"}}},
            {"inputMethod", "QTest mouse events on visible enabled product portal-memory/portal-settings and memory-close/settings-close controls"},
            {"clock", "Caller QElapsedTimer nanoseconds from local runner start; shared with GPU observer"},
            {"motionBoundaryScope", "16ms GUI timer observation points; motion start is first sampled changed progress; motion end is first sampled endpoint; completion adds endpoint binding turn and 200ms click coverage"},
            {"frameIndexScope", "Frame IDs come from beforeRenderNs, never GPU-result availability; frameAtOrBefore is an observation association, not presentation causality"},
            {"notPerformed", QVariantList{QStringLiteral("Pure Live2D draw gate: no existing property isolates draw without model lifecycle changes"),
                QStringLiteral("Narrow/minimum closed-title scene: product hides closed titles; no navigation or model-unload substitution")}}};
        if (m_observer && !m_observer->queriesAvailable()) report["gpuUnavailableReason"] = m_observer->unavailableReason();
        if (!completed && m_selection.variant == "blur-half-resolution" && error.startsWith("W4_BLUR_ONLY")) {
            auto notPerformed = report.value("notPerformed").toList();
            notPerformed.append("Blur-only half-resolution was not completed: " + error);
            report["notPerformed"] = notPerformed;
        }
        auto completion = std::move(m_completion);
        if (completion) completion(report);
        deleteLater();
    }
};

inline void run(QQuickWindow *window, RuntimeBridge *session, const QString &mode, int rows,
                const QString &reportPrefix, Completion completion, const QString &protocol,
                const QString &diagnosticCase) {
    try {
        auto selection = validateSelection(mode, rows, reportPrefix, protocol, diagnosticCase);
        require(window && session, "W4_WINDOW_AND_SESSION_REQUIRED");
        if (selection.variant == "gpu-positive-control")
            HeaderFramePositiveControl::run(window, session, selection.outputDirectory, selection.evidence, std::move(completion));
        else new Runner(window, session, std::move(selection), std::move(completion));
    } catch (const std::exception &error) {
        const QString reason = QString::fromUtf8(error.what());
        QTimer::singleShot(0, [completion = std::move(completion), reason] {
            const auto variant = qEnvironmentVariable("REVERIE_HEADER_FRAME_VARIANT");
            const bool positive = variant == "gpu-positive-control";
            if (completion) completion({{"schema", positive ? "reverie.qt.header-frame-positive-control.v1" : "reverie.qt.header-frame-local.v2"},
                {"scenario", positive ? "gpu-positive-control" : "drawer-cycles"}, {"package", Package},
                {"variant", variant}, {"windowSize", "wide"},
                {"acceptanceEligible", false}, {"performanceComparable", false}, {"passed", false},
                {"completed", false}, {"error", reason}, {"windows", QVariantList{}},
                {"screenshot", QVariantMap{{"requested", qEnvironmentVariable("REVERIE_HEADER_FRAME_SCREENSHOT")},
                    {"performed", false}, {"timingStopped", true}}},
                {"constraints", QVariantMap{{"scope", "Invalid local diagnostic context is rejected; no fallback to performance stress runner"}}}});
        });
    }
}
} // namespace HeaderFrameLocalCheck
