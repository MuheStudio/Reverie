#include "../src/WindowInputState.h"
// Design preview: renders the companion composition with the application's
// QML components and shaders through QQuickRenderControl into an OpenGL
// framebuffer, then writes a PNG. No window is shown, no backend or data
// directory is started, and the Live2D actor is not loaded.
#include <QCommandLineParser>
#include <QEventLoop>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMouseEvent>
#include <QOffscreenSurface>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QColor>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickGraphicsDevice>
#include <QQuickItem>
#include <QQuickRenderControl>
#include <QQuickRenderTarget>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSurfaceFormat>
#include <QTimer>
#include <cstdio>
#include <memory>

void previewProhibitActivation();

namespace {
void wait(int milliseconds) {
    QEventLoop loop;
    QTimer::singleShot(milliseconds, &loop, &QEventLoop::quit);
    loop.exec();
}

int fail(const QString &reason) {
    std::fprintf(stderr, "%s\n", qPrintable(reason));
    return 1;
}

QQuickItem *findItem(QQuickItem *root, const QString &name) {
    if (!root)
        return nullptr;
    if (root->objectName() == name)
        return root;
    for (auto *child : root->childItems())
        if (auto *found = findItem(child, name))
            return found;
    return nullptr;
}

int shaderErrors(QQuickItem *root) {
    int errors = 0;
    if (root->inherits("QQuickShaderEffect") && root->property("status").toInt() == 2)
        ++errors;
    for (auto *child : root->childItems())
        errors += shaderErrors(child);
    return errors;
}
} // namespace

int main(int argc, char **argv) {
    // Same graphics setup as native-ui/src/main.cpp.
    QCoreApplication::setAttribute(Qt::AA_DisableShaderDiskCache);
    QSurfaceFormat format;
    format.setVersion(2, 1);
    format.setProfile(QSurfaceFormat::NoProfile);
    format.setDepthBufferSize(24);
    format.setStencilBufferSize(8);
    QSurfaceFormat::setDefaultFormat(format);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    QGuiApplication app(argc, argv);
    previewProhibitActivation();
    QQuickStyle::setStyle("Basic");

    QCommandLineParser parser;
    parser.addHelpOption();
    parser.addOptions({{"out", "PNG path to write.", "path"},
                       {"width", "Logical width.", "pixels", "1380"},
                       {"height", "Logical height.", "pixels", "900"},
                       {"dpr", "Device pixel ratio.", "ratio", "2"},
                       {"open", "View to open after settling: memory, memory:reload, settings or chat:reading.", "target"},
                       {"settle-ms", "Time for layout and motions to settle.", "ms", "2500"},
                       {"hover", "Object name of an item to hover once the view has opened.", "name"},
                       {"focus", "Object name of an item to focus once the view has opened.", "name"}});
    parser.process(app);
    const QString out = parser.value("out");
    const int width = parser.value("width").toInt();
    const int height = parser.value("height").toInt();
    const qreal dpr = parser.value("dpr").toDouble();
    const int settleMs = parser.value("settle-ms").toInt();
    const QString openTarget = parser.value("open");
    const QString hoverName = parser.value("hover");
    const QString focusName = parser.value("focus");
    if (out.isEmpty() || width < 320 || height < 240 || dpr < 1 ||
        settleMs < 200 ||
        !(openTarget.isEmpty() || openTarget == "memory" || openTarget == "memory:reload" || openTarget == "settings" ||
          openTarget == "chat:reading"))
        return fail("Usage: ScenePreview --out PATH [--width --height --dpr --settle-ms --open]");

    QOpenGLContext context;
    context.setFormat(format);
    if (!context.create())
        return fail("OPENGL_CONTEXT_UNAVAILABLE");
    QOffscreenSurface surface;
    surface.setFormat(context.format());
    surface.create();
    if (!context.makeCurrent(&surface))
        return fail("OPENGL_CONTEXT_NOT_CURRENT");

    QQuickRenderControl control;
    auto window = std::make_unique<QQuickWindow>(&control);
    window->setGraphicsDevice(QQuickGraphicsDevice::fromOpenGLContext(&context));
    window->setColor(QColor("#15262f"));
    window->setGeometry(0, 0, width, height);
    if (!control.initialize())
        return fail("RENDER_CONTROL_INITIALIZATION_FAILED");
    QOpenGLFramebufferObject framebuffer(QSize(qRound(width * dpr), qRound(height * dpr)),
                                         QOpenGLFramebufferObject::CombinedDepthStencil);
    auto target = QQuickRenderTarget::fromOpenGLTexture(framebuffer.texture(), framebuffer.size());
    target.setDevicePixelRatio(dpr);
    window->setRenderTarget(target);

    registerArchiveInteractionTypes();
    QQmlEngine engine;
    QQmlComponent sessionComponent(&engine, QUrl("qrc:/preview/PreviewSession.qml"));
    std::unique_ptr<QObject> session(sessionComponent.create());
    if (!session)
        return fail(sessionComponent.errorString());
    engine.rootContext()->setContextProperty("session", session.get());
    QQmlComponent archiveComponent(&engine, QUrl("qrc:/preview/PreviewArchiveEditor.qml"));
    std::unique_ptr<QObject> archive(archiveComponent.create());
    if (!archive)
        return fail(archiveComponent.errorString());
    engine.rootContext()->setContextProperty("archiveEditor", archive.get());
    QQmlComponent component(&engine, QUrl("qrc:/preview/ScenePreviewFixture.qml"));
    std::unique_ptr<QQuickItem> root(qobject_cast<QQuickItem *>(component.createWithInitialProperties(
        {{"width", width}, {"height", height}, {"pixelRatio", dpr}, {"openTarget", openTarget}})));
    if (!root)
        return fail(component.errorString());
    window->contentItem()->setSize(QSizeF(width, height));
    root->setParentItem(window->contentItem());

    const auto render = [&] {
        context.makeCurrent(&surface);
        control.polishItems();
        control.beginFrame();
        control.sync();
        control.render();
        control.endFrame();
    };
    // The application screenshot shows the draft field focused; match it so
    // the focus treatment of the composer surface is part of the comparison.
    // An opened view instead starts once the companion has settled and keeps
    // the rest of the time to finish its transition.
    // Requested hover and focus states start late, after any opened view has
    // finished moving, so the pointer lands on the settled control.
    bool focused = false;
    bool statesApplied = hoverName.isEmpty() && focusName.isEmpty();
    int statesFound = 0;
    const qint64 openAt = settleMs / 3;
    bool opened = openTarget.isEmpty();
    QElapsedTimer clock;
    clock.start();
    while (clock.elapsed() < settleMs) {
        render();
        wait(16);
        if (!opened && clock.elapsed() > openAt) {
            QMetaObject::invokeMethod(root.get(), "openRequested");
            opened = true;
        }
        if (!statesApplied && clock.elapsed() > settleMs * 4 / 5) {
            if (auto *item = findItem(root.get(), focusName); item && !focusName.isEmpty()) {
                item->forceActiveFocus(Qt::TabFocusReason);
                ++statesFound;
            }
            if (auto *item = findItem(root.get(), hoverName); item && !hoverName.isEmpty()) {
                const QPointF scenePoint = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
                QMouseEvent move(QEvent::MouseMove, scenePoint, scenePoint, scenePoint, Qt::NoButton, Qt::NoButton,
                                 Qt::NoModifier);
                QCoreApplication::sendEvent(window.get(), &move);
                ++statesFound;
            }
            statesApplied = true;
        }
        if (openTarget.isEmpty() && hoverName.isEmpty() && focusName.isEmpty() && !focused &&
            clock.elapsed() > settleMs / 2) {
            if (auto *composer = findItem(root.get(), "chatComposer"))
                composer->forceActiveFocus(Qt::OtherFocusReason);
            focused = true;
        }
    }
    render();
    const QImage image = framebuffer.toImage();
    const int errors = shaderErrors(root.get());
    const QJsonObject report{{"open", openTarget},
                             {"statesApplied", statesFound},
                             {"out", out},
                             {"pixelWidth", image.width()},
                             {"pixelHeight", image.height()},
                             {"devicePixelRatio", dpr},
                             {"shaderErrors", errors}};
    context.makeCurrent(&surface);
    root.reset();
    window.reset();
    if (errors)
        return fail("SHADER_COMPILATION_FAILED:" + QString::number(errors));
    if (!image.save(out))
        return fail("PNG_WRITE_FAILED");
    std::printf("%s\n", QJsonDocument(report).toJson(QJsonDocument::Compact).constData());
    return 0;
}
