#pragma once

#include <QProcess>
#include <QProcessEnvironment>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickWindow>
#include <QScreen>
#include <QSGRendererInterface>
#include <QTest>
#include <QVector2D>
#include <QVector4D>
#include <memory>

namespace EnvironmentResolutionCases {
inline constexpr char ChildMarker[] = "REVERIE_W20_ENVIRONMENT_RESOLUTION_CHILD";

inline QSize texture(QQuickItem *item) {
    return QQmlProperty(item, "layer.textureSize").read().toSize();
}

inline void verify(const QString &kind, int dpr) {
    QCOMPARE(QGuiApplication::platformName(), QString("offscreen"));
    auto *screen = QGuiApplication::primaryScreen();
    QVERIFY(screen);
    QCOMPARE(screen->devicePixelRatio(), qreal(dpr));
    QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    QQuickWindow window;
    window.setScreen(screen);
    window.resize(320, 180);
    QQmlEngine engine;
    QQmlComponent component(&engine, QUrl("qrc:/pose/SceneBackdrop.qml"));
    std::unique_ptr<QObject> root(component.createWithInitialProperties({{"width", 320}, {"height", 180}}));
    QVERIFY2(root, qPrintable(component.errorString()));
    auto *room = qobject_cast<QQuickItem *>(root.get());
    QVERIFY(room);
    room->setParentItem(window.contentItem());
    auto *environment = root->findChild<QQuickItem *>("moonroomEnvironmentShader");
    QVERIFY(environment);
    window.show();
    QTRY_VERIFY_WITH_TIMEOUT(window.isExposed(), 3000);
    QCOMPARE(window.devicePixelRatio(), qreal(dpr));
    const QSize full = dpr == 2 ? QSize(640, 360) : QSize(320, 180);
    QTRY_COMPARE_WITH_TIMEOUT(texture(environment), full, 1000);
    QVERIFY(QQmlProperty(environment, "layer.smooth").read().toBool());

    if (kind == "inputs") {
        // Change each actual shader uniform independently. No replacement
        // timer or model of the product's resolution expression is used.
        const QList<QPair<const char *, QVariant>> inputs{
            {"viewportSize", QVariant::fromValue(QVector2D(321, 181))},
            {"apertureRect", QVariant::fromValue(QVector4D(1, 2, 3, 4))},
            {"archiveAnchor", QVariant::fromValue(QVector4D(2, 3, 4, 5))},
            {"terminalAnchor", QVariant::fromValue(QVector4D(3, 4, 5, 6))},
            {"avatarRect", QVariant::fromValue(QVector4D(4, 5, 6, 7))},
            {"stageCenter", QVariant::fromValue(QVector2D(42, 48))},
            {"horizonY", 100.}, {"taskBlend", .2}, {"readBlend", .3},
            {"avatarVisibility", .4}, {"archiveOpen", .5},
            {"terminalOpen", .6}, {"portalDocked", .7},
            {"lightDirection", QVariant::fromValue(QVector2D(.1, -.2))}};
        for (const auto &input : inputs) {
            QVERIFY2(environment->property(input.first) != input.second, input.first);
            QVERIFY(environment->setProperty(input.first, input.second));
            QCOMPARE(texture(environment), QSize(320, 180));
            QTRY_COMPARE_WITH_TIMEOUT(texture(environment), full, 1000);
        }
        room->setWidth(322);
        QCOMPARE(texture(environment), QSize(322, 180));
        QTRY_COMPARE_WITH_TIMEOUT(texture(environment), QSize(644, 360), 1000);
        room->setHeight(182);
        QCOMPARE(texture(environment), QSize(322, 182));
        QTRY_COMPARE_WITH_TIMEOUT(texture(environment), QSize(644, 364), 1000);
    } else {
        QVERIFY(environment->setProperty("taskBlend", .25));
        QCOMPARE(texture(environment), QSize(320, 180));
        if (kind == "restart") {
            QTest::qWait(150);
            QVERIFY(environment->setProperty("readBlend", .5));
            QTest::qWait(150);
            QCOMPARE(texture(environment), QSize(320, 180));
        } else {
            QTest::qWait(180);
            QCOMPARE(texture(environment), QSize(320, 180));
        }
        QTRY_COMPARE_WITH_TIMEOUT(texture(environment), full, 1000);
        QTest::qWait(80);
        QCOMPARE(texture(environment), full);
    }
    QVERIFY(QQmlProperty(environment, "layer.smooth").read().toBool());
    qInfo() << "W20_ENVIRONMENT_RESOLUTION_VERIFIED" << kind << dpr;
}

inline void runCase(const QString &kind, int dpr) {
    const QString selector = QString::fromLatin1(QTest::currentTestFunction());
    if (!qEnvironmentVariable(ChildMarker).isEmpty()) {
        QCOMPARE(qEnvironmentVariable(ChildMarker), selector);
        verify(kind, dpr);
        return;
    }
    auto env = QProcessEnvironment::systemEnvironment();
    for (const auto *name : {"QT_SCREEN_SCALE_FACTORS", "QT_AUTO_SCREEN_SCALE_FACTOR", "QT_DEVICE_PIXEL_RATIO",
                             "QT_FONT_DPI", "QT_USE_PHYSICAL_DPI"})
        env.remove(name);
    env.insert(ChildMarker, selector);
    env.insert("QT_QPA_PLATFORM", "offscreen");
    env.insert("QT_ENABLE_HIGHDPI_SCALING", "1");
    env.insert("QT_SCALE_FACTOR", QString::number(dpr));
    env.insert("QT_SCALE_FACTOR_ROUNDING_POLICY", "PassThrough");
    env.insert("QML_DISABLE_DISK_CACHE", "1");
    QProcess child;
    child.setProcessEnvironment(env);
    child.setProcessChannelMode(QProcess::MergedChannels);
    child.start(QCoreApplication::applicationFilePath(), {selector, "-o", "-,txt"});
    QVERIFY2(child.waitForStarted(3000), qPrintable(child.errorString()));
    // The test owns this finite child. Let it finish naturally; the enclosing
    // registered native stage keeps its unchanged overall deadline.
    child.waitForFinished(-1);
    const auto output = child.readAllStandardOutput();
    QVERIFY2(child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0,
             qPrintable(QString::fromUtf8(output.left(12000))));
    QCOMPARE(output.count("W20_ENVIRONMENT_RESOLUTION_VERIFIED"), 1);
    qInfo() << "W20_ENVIRONMENT_RESOLUTION_CHILD_VERIFIED" << kind << dpr;
}
}
