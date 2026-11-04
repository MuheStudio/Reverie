#pragma once

#include <QCoreApplication>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJsonObject>
#include <QJSValue>
#include <QProcess>
#include <QProcessEnvironment>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QSGRendererInterface>
#include <QTest>
#include <QVector2D>
#include <memory>

// Added cases use the real product component and Qt's screen scaling. Each
// scale gets a fresh QGuiApplication in a child running only this added row;
// existing test cases and their process-wide settings are left intact.
namespace LayerCompositorScaleCases {
inline constexpr char ChildMarker[] = "REVERIE_W4_LAYER_SCALE_CHILD";
inline constexpr char EvidencePrefix[] = "W4_LAYER_SCALE_EVIDENCE ";

inline QObject *objectProperty(QObject *object, const char *name) {
    const auto value = object->property(name);
    return value.metaType() == QMetaType::fromType<QJSValue>()
        ? value.value<QJSValue>().toQObject() : value.value<QObject *>();
}

inline void addData() {
    QTest::addColumn<int>("screenDpr");
    QTest::newRow("screen-1x") << 1;
    QTest::newRow("screen-2x") << 2;
}

inline void verifyInChild(int screenDpr) {
    QCOMPARE(QGuiApplication::platformName(), QStringLiteral("offscreen"));
    QCOMPARE(qEnvironmentVariable("QT_SCALE_FACTOR"), QString::number(screenDpr));
    auto *screen = QGuiApplication::primaryScreen();
    QVERIFY2(screen, "The isolated offscreen process must expose a real Qt QScreen");
    QCOMPARE(screen->devicePixelRatio(), qreal(screenDpr));

    // Existing native tests use this backend for offscreen layout checks.
    // The added fixture checks screen bindings and requested texture sizes.
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    QQuickWindow window;
    window.setScreen(screen);
    window.resize(320, 180);
    QQmlEngine engine;
    QQmlComponent component(&engine);
    component.setData(R"QML(
import QtQuick
import QtQuick.Window
import "qrc:/pose" as Product
Item {
    width: 320
    height: 180
    readonly property real observedScreenDpr: Screen.devicePixelRatio
    Item { id: base; anchors.fill: parent }
    Item { id: dialogue; anchors.fill: parent }
    Product.LayerCompositor {
        id: compositor
        objectName: "scale-test-compositor"
        anchors.fill: parent
        baseItem: base
        lowerItem: dialogue
        effectsActive: false
        readonly property real observedScreenDpr: Screen.devicePixelRatio
    }
}
)QML", QUrl("qrc:/w4-scale-fixture.qml"));
    QVERIFY2(!component.isError(), qPrintable(component.errorString()));
    std::unique_ptr<QObject> root(component.beginCreate(engine.rootContext()));
    QVERIFY2(root, qPrintable(component.errorString()));
    auto *rootItem = qobject_cast<QQuickItem *>(root.get());
    QVERIFY(rootItem);
    rootItem->setParentItem(window.contentItem());
    component.completeCreate();
    QVERIFY2(!component.isError(), qPrintable(component.errorString()));
    auto *compositor = root->findChild<QQuickItem *>("scale-test-compositor");
    QVERIFY2(compositor, "The actual LayerCompositor.qml must have been instantiated");
    QCOMPARE(compositor->window(), &window);

    window.show();
    QTRY_VERIFY_WITH_TIMEOUT(window.isExposed(), 3000);
    QCOMPARE(window.screen(), screen);
    QCOMPARE(screen->devicePixelRatio(), qreal(screenDpr));
    QCOMPARE(window.devicePixelRatio(), qreal(screenDpr));
    QTRY_COMPARE_WITH_TIMEOUT(rootItem->property("observedScreenDpr").toDouble(), double(screenDpr), 3000);
    QTRY_COMPARE_WITH_TIMEOUT(compositor->property("observedScreenDpr").toDouble(), double(screenDpr), 3000);

    // Neither fixture nor C++ assigns pixelRatio. The expectation is the
    // required output, not another implementation of the product expression.
    QCOMPARE(compositor->width(), qreal(320));
    QCOMPARE(compositor->height(), qreal(180));
    QCOMPARE(compositor->property("pixelRatio").toDouble(), 1.);
    auto *baseCapture = objectProperty(compositor, "baseTexture");
    auto *dialogueCapture = objectProperty(compositor, "dialogueTexture");
    auto *baseBlurCapture = qobject_cast<QQuickItem *>(objectProperty(compositor, "baseBlur"));
    auto *dialogueBlurCapture = qobject_cast<QQuickItem *>(objectProperty(compositor, "dialogueBlur"));
    QVERIFY(baseCapture && dialogueCapture && baseBlurCapture && dialogueBlurCapture);
    QCOMPARE(baseCapture->property("textureSize").toSize(), QSize(320, 180));
    QCOMPARE(dialogueCapture->property("textureSize").toSize(), QSize(320, 180));
    QCOMPARE(baseBlurCapture->property("textureSize").toSize(), QSize(320, 180));
    QCOMPARE(dialogueBlurCapture->property("textureSize").toSize(), QSize(320, 180));
    auto *baseBlur = baseBlurCapture->parentItem();
    auto *dialogueBlur = dialogueBlurCapture->parentItem();
    QVERIFY(baseBlur && dialogueBlur);
    QCOMPARE(baseBlur->property("pixelRatio").toDouble(), 1.);
    QCOMPARE(dialogueBlur->property("pixelRatio").toDouble(), 1.);
    QCOMPARE(baseBlur->property("sourceSize").value<QVector2D>(), QVector2D(320, 180));
    QCOMPARE(dialogueBlur->property("sourceSize").value<QVector2D>(), QVector2D(320, 180));

    const QJsonObject evidence{{"schema", "reverie.w4.layer-compositor-scale.v1"}, {"inputDpr", screenDpr},
        {"screenDpr", screen->devicePixelRatio()}, {"windowDpr", window.devicePixelRatio()},
        {"qmlScreenDpr", compositor->property("observedScreenDpr").toDouble()},
        {"compositorPixelRatio", compositor->property("pixelRatio").toDouble()},
        {"captureWidth", baseCapture->property("textureSize").toSize().width()},
        {"captureHeight", baseCapture->property("textureSize").toSize().height()},
        {"blurWidth", baseBlurCapture->property("textureSize").toSize().width()},
        {"blurHeight", baseBlurCapture->property("textureSize").toSize().height()},
        {"scope", "Real product QML screen binding and requested capture/blur dimensions; software/offscreen, no GPU allocation claim"}};
    qInfo().noquote() << EvidencePrefix << QString::fromUtf8(QJsonDocument(evidence).toJson(QJsonDocument::Compact));
}

inline void runCase() {
    QFETCH(int, screenDpr);
    const QString selector = QString::fromLatin1(QTest::currentTestFunction()) + ':'
        + QString::fromLatin1(QTest::currentDataTag());
    const auto marker = qEnvironmentVariable(ChildMarker);
    if (!marker.isEmpty()) {
        QCOMPARE(marker, selector);
        verifyInChild(screenDpr);
        return;
    }

    auto environment = QProcessEnvironment::systemEnvironment();
    // Only this child receives scale controls; QGuiApplication sees them at
    // construction. Remove inherited controls that could multiply the input.
    for (const char *name : {"QT_SCREEN_SCALE_FACTORS", "QT_AUTO_SCREEN_SCALE_FACTOR", "QT_DEVICE_PIXEL_RATIO",
                            "QT_FONT_DPI", "QT_USE_PHYSICAL_DPI"})
        environment.remove(QString::fromLatin1(name));
    environment.insert(QString::fromLatin1(ChildMarker), selector);
    environment.insert("QT_QPA_PLATFORM", "offscreen");
    environment.insert("QT_ENABLE_HIGHDPI_SCALING", "1");
    environment.insert("QT_SCALE_FACTOR", QString::number(screenDpr));
    environment.insert("QT_SCALE_FACTOR_ROUNDING_POLICY", "PassThrough");
    environment.insert("QML_DISABLE_DISK_CACHE", "1");
    QProcess process;
    process.setProcessEnvironment(environment);
    process.setProcessChannelMode(QProcess::MergedChannels);
    process.start(QCoreApplication::applicationFilePath(), {selector, "-o", "-,txt"});
    QVERIFY2(process.waitForStarted(3000), qPrintable(process.errorString()));
    if (!process.waitForFinished(10000)) {
        process.kill();
        process.waitForFinished(1000);
        QFAIL("The isolated compositor scale row exceeded its bounded child lifetime");
    }
    const auto output = process.readAllStandardOutput();
    QVERIFY2(process.exitStatus() == QProcess::NormalExit && process.exitCode() == 0,
        qPrintable(QString::fromUtf8(output.left(8192))));
    QByteArray evidenceJson;
    int evidenceCount = 0;
    for (const auto &line : output.split('\n')) {
        const int position = line.indexOf(EvidencePrefix);
        if (position < 0) continue;
        ++evidenceCount;
        evidenceJson = line.mid(position + int(sizeof(EvidencePrefix) - 1)).trimmed();
    }
    QCOMPARE(evidenceCount, 1);
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(evidenceJson, &error);
    QVERIFY2(error.error == QJsonParseError::NoError && document.isObject(), qPrintable(error.errorString()));
    const auto evidence = document.object();
    QCOMPARE(evidence.value("schema").toString(), QStringLiteral("reverie.w4.layer-compositor-scale.v1"));
    QCOMPARE(evidence.value("inputDpr").toInt(), screenDpr);
    for (const char *name : {"screenDpr", "windowDpr", "qmlScreenDpr"})
        QCOMPARE(evidence.value(QString::fromLatin1(name)).toDouble(), double(screenDpr));
    QCOMPARE(evidence.value("compositorPixelRatio").toDouble(), 1.);
    QCOMPARE(evidence.value("captureWidth").toInt(), 320);
    QCOMPARE(evidence.value("captureHeight").toInt(), 180);
    QCOMPARE(evidence.value("blurWidth").toInt(), 320);
    QCOMPARE(evidence.value("blurHeight").toInt(), 180);
    qInfo().noquote() << "W4_LAYER_SCALE_CHILD_VERIFIED" << QString::fromUtf8(evidenceJson);
}
}
