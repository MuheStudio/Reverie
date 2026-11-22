#pragma once

#include "EnvironmentResolutionCases.h"

namespace RoomQualityCases {
inline constexpr char ChildMarker[] = "REVERIE_ROOM_QUALITY_CHILD";

inline void verify(const QString &quality, int dpr) {
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
    std::unique_ptr<QObject> root(component.createWithInitialProperties(
        {{"width", 320}, {"height", 180}, {"roomQuality", quality}}));
    QVERIFY2(root, qPrintable(component.errorString()));
    auto *room = qobject_cast<QQuickItem *>(root.get());
    auto *environment = root->findChild<QQuickItem *>("moonroomEnvironmentShader");
    QVERIFY(room && environment);
    room->setParentItem(window.contentItem());
    window.show();
    QTRY_VERIFY_WITH_TIMEOUT(window.isExposed(), 3000);
    QCOMPARE(window.devicePixelRatio(), qreal(dpr));
    const auto texture = [&] { return EnvironmentResolutionCases::texture(environment); };
    const auto expected = [&](bool moving) {
        const qreal scale = quality == "clear" ? dpr
            : quality == "smooth" || moving ? qMax(1., dpr / 2.) : dpr;
        return QSize(qRound(room->width() * scale), qRound(room->height() * scale));
    };
    QTRY_VERIFY_WITH_TIMEOUT(!environment->property("changing").toBool(), 1000);
    QCOMPARE(texture(), expected(false));
    const QList<QPair<const char *, QVariant>> inputs{
        {"viewportSize", QVariant::fromValue(QVector2D(321, 181))},
        {"apertureRect", QVariant::fromValue(QVector4D(1, 2, 3, 4))},
        {"archiveAnchor", QVariant::fromValue(QVector4D(2, 3, 4, 5))},
        {"terminalAnchor", QVariant::fromValue(QVector4D(3, 4, 5, 6))},
        {"avatarRect", QVariant::fromValue(QVector4D(4, 5, 6, 7))},
        {"stageCenter", QVariant::fromValue(QVector2D(42, 48))},
        {"horizonY", 100.}, {"taskBlend", .2}, {"readBlend", .3},
        {"avatarVisibility", .4}, {"archiveOpen", .5}, {"terminalOpen", .6},
        {"portalDocked", .7}, {"lightDirection", QVariant::fromValue(QVector2D(.1, -.2))}};
    for (const auto &input : inputs) {
        QVERIFY2(environment->property(input.first) != input.second, input.first);
        QVERIFY(environment->setProperty(input.first, input.second));
        QVERIFY(environment->property("changing").toBool());
        QCOMPARE(texture(), expected(true));
        QTRY_VERIFY_WITH_TIMEOUT(!environment->property("changing").toBool(), 1000);
        QCOMPARE(texture(), expected(false));
    }
    room->setWidth(322);
    QCOMPARE(texture(), expected(true));
    QTRY_VERIFY_WITH_TIMEOUT(!environment->property("changing").toBool(), 1000);
    QCOMPARE(texture(), expected(false));
    room->setHeight(182);
    QCOMPARE(texture(), expected(true));
    QTRY_VERIFY_WITH_TIMEOUT(!environment->property("changing").toBool(), 1000);
    QCOMPARE(texture(), expected(false));
    QVERIFY(environment->setProperty("taskBlend", .8));
    QTest::qWait(150);
    QVERIFY(environment->setProperty("readBlend", .9));
    QTest::qWait(150);
    QVERIFY(environment->property("changing").toBool());
    QCOMPARE(texture(), expected(true));
    QTest::qWait(1000);
    QVERIFY(!environment->property("changing").toBool());
    QCOMPARE(texture(), expected(false));
    QVERIFY(QQmlProperty(environment, "layer.smooth").read().toBool());

    // These assignments exercise the actual QML binding while the input
    // tracker is quiet, so a delayed timer cannot make a switch appear immediate.
    QVERIFY(room->setProperty("roomQuality", "smooth"));
    QCOMPARE(texture(), QSize(322, 182));
    QVERIFY(room->setProperty("roomQuality", "balanced"));
    QCOMPARE(texture(), QSize(322 * dpr, 182 * dpr));
    QVERIFY(room->setProperty("roomQuality", "smooth"));
    QCOMPARE(texture(), QSize(322, 182));
    QVERIFY(room->setProperty("roomQuality", "clear"));
    QCOMPARE(texture(), QSize(322 * dpr, 182 * dpr));
    QVERIFY(room->setProperty("roomQuality", "unrecognized"));
    QCOMPARE(texture(), QSize(322 * dpr, 182 * dpr));
    qInfo() << "ROOM_QUALITY_CHILD_VERIFIED" << quality << dpr;
}

inline void run(const QString &quality, int dpr) {
    const QString selector = QString::fromLatin1(QTest::currentTestFunction()) + ":" + QTest::currentDataTag();
    if (!qEnvironmentVariable(ChildMarker).isEmpty()) {
        QCOMPARE(qEnvironmentVariable(ChildMarker), selector);
        verify(quality, dpr);
        return;
    }
    auto env = QProcessEnvironment::systemEnvironment();
    for (const auto *key : {"QT_SCREEN_SCALE_FACTORS", "QT_AUTO_SCREEN_SCALE_FACTOR", "QT_DEVICE_PIXEL_RATIO",
                           "QT_FONT_DPI", "QT_USE_PHYSICAL_DPI"})
        env.remove(key);
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
    child.waitForFinished(-1);
    const auto output = child.readAllStandardOutput();
    QVERIFY2(child.exitStatus() == QProcess::NormalExit && child.exitCode() == 0,
             qPrintable(QString::fromUtf8(output.left(16000))));
    QCOMPARE(output.count("ROOM_QUALITY_CHILD_VERIFIED"), 1);
    qInfo() << "ROOM_QUALITY_SUBPROCESS_VERIFIED" << quality << dpr;
}
}
