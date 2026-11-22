#include <QQmlComponent>
#include <QQmlEngine>
#include <QScopedPointer>
#include <QtTest>
#include "HeaderOpenObservation.h"
#include "LayerCompositorScaleCases.h"
#include "EnvironmentResolutionCases.h"
#include "RoomQualityCases.h"
#include <QJSValue>
#include <QVector>
#include <algorithm>
#include <cmath>

class SceneDirectorTest : public QObject {
    Q_OBJECT

    static QObject *createNavigation(QQmlEngine &engine) {
        QQmlComponent component(&engine);
        component.setData(
            "import QtQuick\nQtObject { property string currentFeature: 'chat'; "
            "property string currentSubentry: 'companion'; property string chatReturnSubentry: "
            "'companion'; property bool surfaceOpen: false; property bool paletteOpen: false; "
            "property int transitionRevision: 0 }",
            QUrl());
        return component.create();
    }
    static QObject *createDirector(QQmlEngine &engine, QObject *navigation, int width = 1380,
                                   int height = 900, bool reducedMotion = true) {
        QQmlComponent component(&engine, QUrl("qrc:/pose/SceneDirector.qml"));
        auto *item = component.createWithInitialProperties(
            {{"navigation", QVariant::fromValue(navigation)}, {"viewportWidth", width},
             {"viewportHeight", height}, {"reducedMotion", reducedMotion}});
        if (!item)
            qWarning().noquote() << component.errorString();
        return item;
    }
    static QObject *createMotion(QQmlEngine &engine) {
        QQmlComponent component(&engine, QUrl("qrc:/pose/RetargetMotion.qml"));
        auto *motion = component.create();
        if (!motion)
            qWarning().noquote() << component.errorString();
        return motion;
    }
    static bool observe(QObject *item, const QString &feature, double progress,
                        bool dragging = false) {
        return QMetaObject::invokeMethod(item, "observePortal", Q_ARG(QVariant, feature),
                                         Q_ARG(QVariant, progress), Q_ARG(QVariant, dragging));
    }
    static bool observeMotion(QObject *item, const QString &feature, double progress,
                              bool geometrySettled) {
        return QMetaObject::invokeMethod(item, "observePortalMotion", Q_ARG(QVariant, feature),
                                         Q_ARG(QVariant, progress), Q_ARG(QVariant, false),
                                         Q_ARG(QVariant, 0.), Q_ARG(QVariant, geometrySettled),
                                         Q_ARG(QVariant, 0));
    }
    static QRectF portalRect(QObject *item, const QString &feature, double progress) {
        const auto anchor = feature == "memory" ? "archiveAnchor" : feature == "settings"
                                                                        ? "terminalAnchor"
                                                                        : "characterAnchor";
        QVariant result;
        if (!QMetaObject::invokeMethod(item, "portalRectFor", Q_RETURN_ARG(QVariant, result),
                                       Q_ARG(QVariant, feature), Q_ARG(QVariant, progress),
                                       Q_ARG(QVariant, item->property(anchor))))
            return {};
        return result.toRectF();
    }
    static void requestTask(QObject *navigation, const QString &feature) {
        navigation->setProperty("currentFeature", feature);
        navigation->setProperty("surfaceOpen", feature != "chat");
    }

  private slots:
    void reducedMotionAfterCompletionDoesNotNotifyTwice() {
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        motion->setProperty("reducedMotion", true);
        QSignalSpy settled(motion.data(), SIGNAL(settled(int)));
        QVERIFY(settled.isValid());
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 1.)));
        QCOMPARE(settled.size(), 1);
        const int revision = motion->property("revision").toInt();
        motion->setProperty("reducedMotion", false);
        motion->setProperty("reducedMotion", true);
        QCOMPARE(settled.size(), 1);
        QCOMPARE(motion->property("completedRevision").toInt(), revision);
        QCOMPARE(motion->property("revision").toInt(), revision);
        QVERIFY(!motion->property("running").toBool());
    }
    void reducingActiveMotionCompletesItsRevisionOnce_data() {
        QTest::addColumn<double>("from");
        QTest::addColumn<double>("destination");
        QTest::newRow("opening") << 0. << 1.;
        QTest::newRow("closing") << 1. << 0.;
        QTest::newRow("reversing-partial") << .43 << 0.;
    }
    void reducingActiveMotionCompletesItsRevisionOnce() {
        QFETCH(double, from);
        QFETCH(double, destination);
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        motion->setProperty("value", from);
        QSignalSpy settled(motion.data(), SIGNAL(settled(int)));
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, destination)));
        QCOMPARE(settled.size(), 0);
        QVERIFY(!motion->property("geometrySettled").toBool());
        const int revision = motion->property("revision").toInt();
        motion->setProperty("reducedMotion", true);
        QCOMPARE(settled.size(), 1);
        QCOMPARE(settled.at(0).at(0).toInt(), revision);
        QCOMPARE(motion->property("value").toDouble(), destination);
        QVERIFY(motion->property("geometrySettled").toBool());
        motion->setProperty("reducedMotion", false);
        motion->setProperty("reducedMotion", true);
        QCOMPARE(settled.size(), 1);
        QCOMPARE(motion->property("revision").toInt(), revision);
    }
    void explicitSettleAfterHeldGestureHasNewCompletion_data() {
        QTest::addColumn<double>("position");
        QTest::newRow("held-at-open") << 1.;
        QTest::newRow("held-mid-drag") << .48;
    }
    void explicitSettleAfterHeldGestureHasNewCompletion() {
        QFETCH(double, position);
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        motion->setProperty("reducedMotion", true);
        QSignalSpy settled(motion.data(), SIGNAL(settled(int)));
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 1.)));
        const int oldRevision = motion->property("revision").toInt();
        QCOMPARE(settled.size(), 1);
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "hold", Q_ARG(QVariant, position)));
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "follow", Q_ARG(QVariant, position), Q_ARG(QVariant, 0.)));
        motion->setProperty("reducedMotion", false);
        motion->setProperty("reducedMotion", true);
        QCOMPARE(settled.size(), 1);
        QCOMPARE(motion->property("value").toDouble(), position);
        QVERIFY(motion->property("held").toBool());
        // Canceling the pointer is a distinct settle intent even at the same
        // target: the new revision is allowed exactly one completion.
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 1.)));
        QCOMPARE(settled.size(), 2);
        QCOMPARE(motion->property("revision").toInt(), oldRevision + 1);
        QCOMPARE(settled.at(1).at(0).toInt(), oldRevision + 1);
        QVERIFY(!motion->property("held").toBool());
    }
    void obsoleteMotionTickDoesNotRepeatNewCompletion() {
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        QSignalSpy settled(motion.data(), SIGNAL(settled(int)));
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 1.)));
        const int oldRevision = motion->property("revision").toInt();
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 0.)));
        QCOMPARE(settled.size(), 1);
        QCOMPARE(settled.at(0).at(0).toInt(), oldRevision + 1);
        const double lastTick = motion->property("lastTick").toDouble();
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "step", Q_ARG(QVariant, lastTick + 250.)));
        QCOMPARE(settled.size(), 1);
        QCOMPARE(motion->property("completedRevision").toInt(), oldRevision + 1);
    }
    void poses_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("wide") << 1380 << 900;
        QTest::newRow("narrow") << 950 << 760;
        QTest::newRow("minimum") << 760 << 650;
    }
    void poses() {
        QFETCH(int, width);
        QFETCH(int, height);
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data(), width, height));
        QVERIFY(item);
        const auto rect = [&](const char *name) { return item->property(name).toRectF(); };
        const QRectF viewport(0, 0, width, height);
        const auto actor = rect("avatarReserveRect");
        QCOMPARE(item->property("mode").toString(), QString("companion"));
        // The model's base stands on the astrolabe centre, which keeps its
        // floor position 3px above the former bottom of the actor viewport.
        const auto stage = item->property("stageCenter").toPointF();
        QCOMPARE(stage.x(), actor.center().x());
        QCOMPARE(stage.y(), actor.y() + actor.height() * .965);
        QCOMPARE(stage.y(), 79. + actor.height());
        // Wide companion docks the closed portal faces; compact never does.
        QCOMPARE(item->property("portalDocked").toDouble(), width >= 1180 ? 1. : 0.);
        QVERIFY(rect("readingRect").contains(rect("recentRect")));
        QVERIFY(!rect("recentRect").intersects(rect("terminalAnchor")));
        QVERIFY(!rect("composerRect").intersects(rect("terminalAnchor")));
        QVERIFY(!actor.intersects(rect("recentRect")));
        QVERIFY(!actor.intersects(rect("composerRect")));
        // The name plate sits below the astrolabe's front ring and clear of
        // the conversation and the closed portals.
        const auto plate = rect("nameplateRect");
        QVERIFY(plate.top() > item->property("stageFrontY").toDouble());
        const double horizon = item->property("horizonY").toDouble();
        QVERIFY(plate.bottom() <= horizon - 16 || plate.top() >= horizon + 4);
        QVERIFY(viewport.contains(plate));
        for (const char *name : {"recentRect", "composerRect", "archiveAnchor", "terminalAnchor"})
            QVERIFY2(!plate.intersects(rect(name)), name);
        if (width >= 1180) {
            // One conversation column on the composer; the terminal hangs on
            // the wall above it.
            QCOMPARE(rect("recentRect").bottom(), rect("composerRect").top() - 18);
            QVERIFY(rect("terminalAnchor").bottom() < rect("recentRect").top());
            QVERIFY(rect("terminalAnchor").right() <= width - 32);
        }
        nav->setProperty("currentSubentry", "reading");
        QTRY_COMPARE(item->property("readBlend").toDouble(), 1.);
        QCOMPARE(item->property("mode").toString(), QString("reading"));
        QCOMPARE(item->property("portalDocked").toDouble(), 0.);
        QCOMPARE(rect("avatarReserveRect"), actor);
        QCOMPARE(rect("historyRect"), rect("readingRect"));
        QVERIFY(!actor.intersects(rect("readingRect")));
        nav->setProperty("chatReturnSubentry", "reading");
        requestTask(nav.data(), "memory");
        QVERIFY(observe(item.data(), "memory", 1));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        QCOMPARE(item->property("readBlend").toDouble(), 1.);
        QVERIFY(viewport.contains(rect("taskRect")));
        if (width < 1180)
            QCOMPARE(item->property("avatarVisibility").toDouble(), 0.);
        else {
            QVERIFY(!actor.intersects(rect("taskRect")));
            QCOMPARE(item->property("avatarVisibility").toDouble(), 1.);
        }
        const auto before = rect("taskRect");
        requestTask(nav.data(), "settings");
        QVERIFY(observe(item.data(), "memory", .6));
        QVERIFY(observe(item.data(), "settings", .4));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        QCOMPARE(rect("taskRect"), before);
        QVERIFY(observe(item.data(), "memory", 0));
        QVERIFY(observe(item.data(), "settings", 1));
        requestTask(nav.data(), "chat");
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        QVERIFY(observe(item.data(), "settings", 0));
        QCOMPARE(item->property("taskBlend").toDouble(), 0.);
        QCOMPARE(item->property("mode").toString(), QString("reading"));
        QCOMPARE(item->property("avatarVisibility").toDouble(), 1.);
        QCOMPARE(rect("avatarReserveRect"), actor);
    }
    void dragPreviewAndHandoffDoNotCollapseExistingTask() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        requestTask(nav.data(), "settings");
        QVERIFY(observe(item.data(), "settings", 1));
        QVERIFY(observe(item.data(), "memory", .24, true));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        requestTask(nav.data(), "chat");
        QVERIFY(observe(item.data(), "settings", 0));
        QVERIFY(observe(item.data(), "memory", .4, true));
        QCOMPARE(item->property("taskBlend").toDouble(), .4);
        QCOMPARE(item->property("mode").toString(), QString("task"));
        QVERIFY(observe(item.data(), "memory", .4, false));
        // Releasing the pointer does not start a separate director animation.
        QCOMPARE(item->property("taskBlend").toDouble(), .4);
        QVERIFY(observe(item.data(), "memory", .2));
        QCOMPARE(item->property("taskBlend").toDouble(), .2);
        QVERIFY(observe(item.data(), "memory", 0));
        QCOMPARE(item->property("taskBlend").toDouble(), 0.);
    }
    void denseGeometry_data() {
        poses_data();
        QTest::newRow("below-breakpoint") << 1179 << 650;
        QTest::newRow("at-breakpoint") << 1180 << 650;
        QTest::newRow("large") << 1920 << 1080;
    }
    void denseGeometry() {
        QFETCH(int, width);
        QFETCH(int, height);
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data(), width, height));
        QVERIFY(item);
        auto *motion = item->findChild<QObject *>("sceneReadMotion");
        QVERIFY(motion);
        const auto rect = [&](const char *name) { return item->property(name).toRectF(); };
        const auto actor = rect("avatarReserveRect");
        const QRectF viewport(0, 0, width, height);
        for (const double composerHeight : {68., 144.}) {
            item->setProperty("composerRequestedHeight", composerHeight);
            QCOMPARE(rect("composerRect").height(), composerHeight);
            for (int sample = 0; sample <= 200; ++sample) {
                motion->setProperty("value", sample / 200.);
                QCOMPARE(rect("avatarReserveRect"), actor);
                QVERIFY(viewport.contains(rect("historyRect")));
                QVERIFY(rect("readingRect").contains(rect("historyRect")));
                QVERIFY(!actor.intersects(rect("historyRect")));
                QVERIFY(!actor.intersects(rect("composerRect")));
                QVERIFY(!rect("historyRect").intersects(rect("composerRect")));
                QVERIFY(!actor.intersects(rect("companionBarRect")));
                QVERIFY(!rect("recentRect").intersects(rect("terminalAnchor")));
                QVERIFY(!rect("composerRect").intersects(rect("terminalAnchor")));
            }
        }
        for (const QString feature : {"memory", "settings", "character"}) {
            requestTask(nav.data(), feature);
            for (int sample = 0; sample <= 200; ++sample) {
                const double progress = sample / 200.;
                QVERIFY(observe(item.data(), feature, progress, true));
                const auto physical = portalRect(item.data(), feature, progress);
                QVERIFY(!physical.isEmpty());
                QVERIFY(viewport.contains(physical));
                if (item->property("avatarVisibility").toDouble() > .001)
                    QVERIFY2(!actor.intersects(physical), qPrintable(feature + ":" + QString::number(progress)));
                QCOMPARE(rect("avatarReserveRect"), actor);
            }
            QCOMPARE(portalRect(item.data(), feature, 1), rect("taskRect"));
            QVERIFY(observe(item.data(), feature, 0));
        }
    }
    void handoffBodyReflowsOnlyWhileHidden() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        auto *motion = item->findChild<QObject *>("sceneReadMotion");
        QVERIFY(motion);
        motion->setProperty("value", .499);
        const auto first = item->property("historyRect").toRectF();
        const auto bodyBefore = item->property("historyBodyWidth").toDouble();
        QCOMPARE(item->property("chatBodyOpacity").toDouble(), 0.);
        motion->setProperty("value", .5);
        const auto second = item->property("historyRect").toRectF();
        QVERIFY(std::abs(first.width() - second.width()) < 1);
        QVERIFY(std::abs(first.x() - second.x()) < 1);
        QVERIFY(bodyBefore != item->property("historyBodyWidth").toDouble());
        QCOMPARE(item->property("chatBodyOpacity").toDouble(), 0.);
        QVERIFY(item->property("chatLayoutReading").toBool());
        motion->setProperty("value", .499);
        QCOMPARE(item->property("historyBodyWidth").toDouble(), bodyBefore);
        QCOMPARE(item->property("chatBodyOpacity").toDouble(), 0.);
        QVERIFY(!item->property("chatLayoutReading").toBool());
    }
    void syntheticR1FormulaDetectsCrossing() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        // This is the labelled r1 formula, not a rebuilt or modified r1 candidate.
        const QRectF oldRecent(1380 * .055, 900 * .27, 356, 900 * .34);
        const QRectF oldReading(1380 * .46, 86, 1380 - 1380 * .46 - 32, 900 - 258);
        const QRectF oldMiddle((oldRecent.x() + oldReading.x()) / 2,
                               (oldRecent.y() + oldReading.y()) / 2,
                               (oldRecent.width() + oldReading.width()) / 2,
                               (oldRecent.height() + oldReading.height()) / 2);
        const auto intersection = item->property("avatarReserveRect").toRectF().intersected(oldMiddle);
        QVERIFY(intersection.width() * intersection.height() > 1);
    }
    void reversalAndBreakpointResizePreserveMotion() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data(), 1180, 650, false));
        QVERIFY(item);
        auto *motion = item->findChild<QObject *>("sceneReadMotion");
        QVERIFY(motion);
        QVERIFY(QMetaObject::invokeMethod(motion, "hold", Q_ARG(QVariant, .37)));
        motion->setProperty("velocity", .73);
        QVERIFY(QMetaObject::invokeMethod(motion, "retarget", Q_ARG(QVariant, 1)));
        const auto progress = item->property("readBlend").toDouble();
        const auto velocity = item->property("readVelocity").toDouble();
        QVERIFY(QMetaObject::invokeMethod(motion, "retarget", Q_ARG(QVariant, 0)));
        QCOMPARE(item->property("readBlend").toDouble(), progress);
        QCOMPARE(item->property("readVelocity").toDouble(), velocity);
        const auto revision = motion->property("revision").toInt();
        item->setProperty("viewportWidth", 1179);
        QCOMPARE(item->property("readBlend").toDouble(), progress);
        QCOMPARE(item->property("readVelocity").toDouble(), velocity);
        QCOMPARE(motion->property("revision").toInt(), revision);
        QVERIFY(item->property("compact").toBool());
        QVERIFY(!item->property("avatarReserveRect").toRectF().intersects(item->property("historyRect").toRectF()));
        item->setProperty("viewportWidth", 1180);
        QCOMPARE(item->property("readBlend").toDouble(), progress);
        QCOMPARE(item->property("readVelocity").toDouble(), velocity);
        QCOMPARE(motion->property("revision").toInt(), revision);
        QVERIFY(!item->property("compact").toBool());
        // Interrupting with a drawer preserves the partially expanded chat pose.
        requestTask(nav.data(), "memory");
        QVERIFY(observe(item.data(), "memory", .28));
        QCOMPARE(item->property("readBlend").toDouble(), progress);
        QCOMPARE(item->property("readVelocity").toDouble(), velocity);
        QCOMPARE(item->property("taskBlend").toDouble(), .28);
    }
    void selectedDrawerDragAndCompactCharacterHandoff() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data(), 760, 650));
        QVERIFY(item);
        requestTask(nav.data(), "memory");
        QVERIFY(observe(item.data(), "memory", 1));
        QVERIFY(observe(item.data(), "memory", .42, true));
        QCOMPARE(item->property("taskBlend").toDouble(), .42);
        QVERIFY(observe(item.data(), "memory", .42, false));
        QCOMPARE(item->property("taskBlend").toDouble(), .42);
        QVERIFY(observe(item.data(), "memory", 1));
        requestTask(nav.data(), "character");
        QVERIFY(observe(item.data(), "memory", .6));
        QVERIFY(observe(item.data(), "character", .4));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        QCOMPARE(item->property("avatarVisibility").toDouble(), 0.);
        QVERIFY(observe(item.data(), "memory", 0));
        QVERIFY(observe(item.data(), "character", 1));
        QCOMPARE(item->property("avatarVisibility").toDouble(), 1.);
        QVERIFY(!item->property("avatarReserveRect").toRectF().intersects(item->property("taskRect").toRectF()));
        requestTask(nav.data(), "chat");
        QVERIFY(observe(item.data(), "character", .7));
        QCOMPARE(item->property("avatarVisibility").toDouble(), 1.);
    }
    void reopeningClosingDrawerPreservesCurrentPosture() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        requestTask(nav.data(), "memory");
        QVERIFY(observe(item.data(), "memory", 1));
        requestTask(nav.data(), "chat");
        QVERIFY(observe(item.data(), "memory", .38));
        QCOMPARE(item->property("taskBlend").toDouble(), .38);
        requestTask(nav.data(), "memory");
        QCOMPARE(item->property("taskBlend").toDouble(), .38);
        QVERIFY(observe(item.data(), "memory", .61));
        QCOMPARE(item->property("taskBlend").toDouble(), .61);
        QVERIFY(observe(item.data(), "memory", 1));
        requestTask(nav.data(), "settings");
        QVERIFY(observe(item.data(), "memory", .61));
        QVERIFY(observe(item.data(), "settings", .38));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
    }
    void partialDragTaskHandoffPreservesProgress_data() {
        QTest::addColumn<double>("partial");
        QTest::newRow("partial-40") << .4;
        QTest::newRow("partial-18") << .18;
    }
    void partialDragTaskHandoffPreservesProgress() {
        QFETCH(double, partial);
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        requestTask(nav.data(), "memory");
        QVERIFY(observe(item.data(), "memory", 1));
        QVERIFY(observe(item.data(), "memory", partial, true));
        QVERIFY(observe(item.data(), "memory", partial, false));
        QCOMPARE(item->property("taskBlend").toDouble(), partial);
        requestTask(nav.data(), "settings");
        QCOMPARE(item->property("taskBlend").toDouble(), partial);
        QCOMPARE(item->property("taskHandoffFloor").toDouble(), partial);
        QCOMPARE(item->property("taskHandoffOwner").toString(), QString("settings"));
        QVERIFY(observe(item.data(), "memory", partial / 2));
        QVERIFY(observe(item.data(), "settings", partial / 4));
        QCOMPARE(item->property("taskBlend").toDouble(), partial);
        const double raised = partial + .1;
        QVERIFY(observe(item.data(), "settings", raised));
        QCOMPARE(item->property("taskBlend").toDouble(), raised);
        QVERIFY(observe(item.data(), "memory", 0));
        QVERIFY(observe(item.data(), "settings", partial / 3));
        QCOMPARE(item->property("taskBlend").toDouble(), raised);
        QVERIFY(observe(item.data(), "settings", 1));
        QCOMPARE(item->property("taskBlend").toDouble(), 1.);
        QCOMPARE(item->property("taskHandoffOwner").toString(), QString());

        // A new selected drag takes ownership, rather than inheriting the floor.
        QVERIFY(observe(item.data(), "settings", .12, true));
        QCOMPARE(item->property("taskBlend").toDouble(), .12);
        QCOMPARE(item->property("taskHandoffFloor").toDouble(), 0.);
        QVERIFY(observe(item.data(), "settings", .12, false));
        requestTask(nav.data(), "memory");
        QCOMPARE(item->property("taskBlend").toDouble(), .12);
        QVERIFY(observe(item.data(), "settings", .06));
        QVERIFY(observe(item.data(), "memory", .03));
        QCOMPARE(item->property("taskBlend").toDouble(), .12);
        requestTask(nav.data(), "chat");
        QCOMPARE(item->property("taskHandoffFloor").toDouble(), 0.);
        QCOMPARE(item->property("taskHandoffOwner").toString(), QString());
        QCOMPARE(item->property("taskBlend").toDouble(), .06);
    }
    void returningChatWaitsForEveryClosingPortalToSettle() {
        QQmlEngine engine;
        QScopedPointer<QObject> nav(createNavigation(engine));
        QVERIFY(nav);
        QScopedPointer<QObject> item(createDirector(engine, nav.data()));
        QVERIFY(item);
        QTRY_VERIFY(item->property("chatInputReady").toBool());
        QVERIFY(observeMotion(item.data(), "memory", .0005, false));
        QVERIFY(item->property("taskBlend").toDouble() < .001);
        QVERIFY(!item->property("chatGeometryReady").toBool());
        QVERIFY(!item->property("chatInputReady").toBool());
        QVERIFY(observeMotion(item.data(), "memory", 0, false));
        QCOMPARE(item->property("taskBlend").toDouble(), 0.);
        QVERIFY(!item->property("chatGeometryReady").toBool());
        QVERIFY(observeMotion(item.data(), "settings", 0, false));
        QVERIFY(observeMotion(item.data(), "memory", 0, true));
        // The selected feature is chat; every outgoing drawer still matters.
        QVERIFY(!item->property("chatGeometryReady").toBool());
        QVERIFY(observeMotion(item.data(), "settings", 0, true));
        QVERIFY(item->property("chatGeometryReady").toBool());
        QVERIFY(item->property("chatInputReady").toBool());
    }

  private:
    // W4 cases are additive. Both limits receive exactly this wall-clock input:
    // 0/16/32ms, one specified inter-tick gap, then ordinary 16ms ticks.
    // 32ms is the last point on that normal grid below progress .23; an old
    // 130ms gap from 0 or 16ms would still notify inside the original interval.
    static QVector<qint64> headerStepTimes(int gapMs) {
        QVector<qint64> times{0, 16, 32};
        for (int index = 0; index <= 80; ++index)
            times.append(32 + gapMs + index * 16);
        return times;
    }
    static void addHeaderStepRows(bool includeFeature) {
        if (includeFeature)
            QTest::addColumn<QString>("feature");
        QTest::addColumn<int>("gapMs");
        QTest::addColumn<bool>("legacyLimit");
        QTest::addColumn<bool>("expectInterval");
        const QStringList features = includeFeature ? QStringList{"memory", "settings"} : QStringList{QString()};
        for (const auto &feature : features) {
            for (const bool legacy : {false, true}) {
                for (const int gap : {16, 60, 93, 130, 250}) {
                    const QString name = (feature.isEmpty() ? QString() : feature + "-")
                        + (legacy ? "legacy-250ms-" : "default-50ms-")
                        + (gap == 16 ? QString("normal-16ms") : QString("gap-%1ms").arg(gap));
                    const auto tag = name.toUtf8();
                    auto &row = QTest::newRow(tag.constData());
                    if (includeFeature)
                        row << feature;
                    row << gap << legacy << !(legacy && (gap == 130 || gap == 250));
                }
            }
        }
    }
    static QObject *headerObject(const QVariant &value) {
        return value.metaType() == QMetaType::fromType<QJSValue>()
            ? value.value<QJSValue>().toQObject() : value.value<QObject *>();
    }
    static bool stopHeaderTicker(QObject *motion) {
        auto *ticker = motion ? headerObject(motion->property("ticker")) : nullptr;
        // Stopping only Timer preserves the real retarget's held/value/velocity.
        // hold() is deliberately not used to emulate a scheduler pause.
        return ticker && ticker->setProperty("running", false)
            && !ticker->property("running").toBool() && !motion->property("running").toBool()
            && !motion->property("held").toBool() && !motion->property("geometrySettled").toBool()
            && motion->setProperty("lastTick", 0.);
    }
    static bool stepHeaderMotion(QObject *motion, qint64 nowMs) {
        return QMetaObject::invokeMethod(motion, "step", Q_ARG(QVariant, double(nowMs)));
    }
    static QObject *createHeaderNavigation(QQmlEngine &engine) {
        QQmlComponent component(&engine);
        component.setData(
            "import QtQuick\nQtObject { "
            "property string currentFeature: 'chat'; "
            "readonly property bool surfaceOpen: currentFeature !== 'chat'; "
            "property bool paletteOpen: false; property bool transitionCommitting: false; "
            "property int transitionRevision: 0; property var focusWindow: null; "
            "property string focusScopeKey: 'w4-header-fixture'; property int focusGeneration: 0; "
            "property int focusActivityRevision: 0; signal cancelInteraction(); "
            "function restoreFocus(revision) {} }", QUrl());
        auto *navigation = component.create();
        if (!navigation)
            qWarning().noquote() << component.errorString();
        return navigation;
    }
    static QObject *createHeaderPortal(QQmlEngine &engine, QObject *navigation, const QString &feature) {
        QQmlComponent component(&engine, QUrl("qrc:/pose/ScenePortal.qml"));
        auto *portal = component.createWithInitialProperties(
            {{"navigation", QVariant::fromValue(navigation)}, {"destination", feature}, {"text", feature}});
        if (!portal)
            qWarning().noquote() << component.errorString();
        return portal;
    }
    static QObject *headerPortalMotion(QObject *portal) {
        QObject *found = nullptr;
        for (auto *child : portal->findChildren<QObject *>()) {
            const auto *meta = child->metaObject();
            if (meta->indexOfProperty("ticker") >= 0 && meta->indexOfProperty("velocity") >= 0
                    && meta->indexOfProperty("value") >= 0 && meta->indexOfProperty("target") >= 0
                    && meta->indexOfProperty("geometrySettled") >= 0 && meta->indexOfProperty("lastTick") >= 0) {
                if (found)
                    return nullptr;
                found = child;
            }
        }
        return found;
    }

  private slots:
    void retargetMotionDefaultStepLimitIsFiftyMilliseconds() {
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        QVERIFY(motion->metaObject()->indexOfProperty("maxStepSeconds") >= 0);
        QCOMPARE(motion->property("maxStepSeconds").toDouble(), .05);
    }
    void boundedSpringKeepsGivenPauseNotifications_data() {
        addHeaderStepRows(false);
    }
    void boundedSpringKeepsGivenPauseNotifications() {
        QFETCH(int, gapMs);
        QFETCH(bool, legacyLimit);
        QFETCH(bool, expectInterval);
        QQmlEngine engine;
        QScopedPointer<QObject> motion(createMotion(engine));
        QVERIFY(motion);
        QVERIFY(motion->metaObject()->indexOfProperty("maxStepSeconds") >= 0);
        QCOMPARE(motion->property("maxStepSeconds").toDouble(), .05);
        if (legacyLimit)
            QVERIFY(motion->setProperty("maxStepSeconds", .25));
        QCOMPARE(motion->property("maxStepSeconds").toDouble(), legacyLimit ? .25 : .05);
        QVERIFY(QMetaObject::invokeMethod(motion.data(), "retarget", Q_ARG(QVariant, 1.)));
        QVERIFY(stopHeaderTicker(motion.data()));
        QCOMPARE(motion->property("target").toDouble(), 1.);
        bool visitedInterval = false, crossedUpper = false;
        double previous = 0;
        for (const auto nowMs : headerStepTimes(gapMs)) {
            QVERIFY(stepHeaderMotion(motion.data(), nowMs));
            const double value = motion->property("value").toDouble();
            QVERIFY(std::isfinite(value));
            if (!crossedUpper) {
                QVERIFY2(value >= previous,
                    qPrintable(QString("Spring regressed before .96 at %1ms").arg(nowMs)));
                crossedUpper = value >= .96;
            }
            visitedInterval |= value > .23 && value < .96;
            previous = value;
        }
        QCOMPARE(visitedInterval, expectInterval);
        QVERIFY(crossedUpper);
        QVERIFY(motion->property("geometrySettled").toBool());
        QCOMPARE(motion->property("value").toDouble(), 1.);
        QVERIFY(!motion->property("running").toBool());
    }
    void realPortalHeaderLatchUsesBoundedSpring_data() {
        addHeaderStepRows(true);
    }
    void realPortalHeaderLatchUsesBoundedSpring() {
        QFETCH(QString, feature);
        QFETCH(int, gapMs);
        QFETCH(bool, legacyLimit);
        QFETCH(bool, expectInterval);
        QQmlEngine engine;
        QScopedPointer<QObject> navigation(createHeaderNavigation(engine));
        QVERIFY(navigation);
        QScopedPointer<QObject> portal(createHeaderPortal(engine, navigation.data(), feature));
        // No substitute portal or product restructuring is permitted on failure.
        QVERIFY2(portal, "Real ScenePortal could not be independently created; stop local verification and report");
        QVERIFY(portal->property("componentReady").toBool());
        QCOMPARE(portal->property("transitionState").toString(), QString("closed"));
        QCOMPARE(portal->property("progress").toDouble(), 0.);
        auto *motion = headerPortalMotion(portal.data());
        QVERIFY2(motion, "Expected exactly one real RetargetMotion child of ScenePortal");
        QVERIFY(motion->metaObject()->indexOfProperty("maxStepSeconds") >= 0);
        QCOMPARE(motion->property("maxStepSeconds").toDouble(), .05);
        if (legacyLimit)
            QVERIFY(motion->setProperty("maxStepSeconds", .25));
        QCOMPARE(motion->property("maxStepSeconds").toDouble(), legacyLimit ? .25 : .05);
        qint64 manualElapsedMs = 0;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(portal.data(), [&manualElapsedMs] { return manualElapsedMs; }));
        QSignalSpy progressNotifications(portal.data(), SIGNAL(progressChanged()));
        QVERIFY(progressNotifications.isValid());
        QVERIFY(navigation->setProperty("currentFeature", feature));
        QVERIFY(portal->property("desiredOpen").toBool());
        QCOMPARE(portal->property("transitionState").toString(), QString("opening"));
        QVERIFY(stopHeaderTicker(motion));
        bool crossedUpper = false, visitedInterval = false, readyObserved = false;
        double previous = 0;
        for (const auto nowMs : headerStepTimes(gapMs)) {
            manualElapsedMs = nowMs;
            QVERIFY(stepHeaderMotion(motion, nowMs));
            const double progress = portal->property("progress").toDouble();
            QVERIFY(std::isfinite(progress));
            QVERIFY(progress >= 0 && progress <= 1);
            if (!crossedUpper) {
                QVERIFY2(progress >= previous,
                    qPrintable(QString("Portal regressed before .96 at %1ms").arg(nowMs)));
                crossedUpper = progress >= .96;
            }
            visitedInterval |= progress > .23 && progress < .96;
            readyObserved |= observation.poll(progress, portal->property("transitionState").toString());
            previous = progress;
        }
        QCOMPARE(visitedInterval, expectInterval);
        QCOMPARE(readyObserved, expectInterval);
        QVERIFY(progressNotifications.size() > 0);
        QVERIFY(crossedUpper);
        QVERIFY(motion->property("geometrySettled").toBool());
        QCOMPARE(portal->property("progress").toDouble(), 1.);
        QCOMPARE(portal->property("transitionState").toString(), QString("open"));
        const auto evidence = observation.snapshot(true);
        QVERIFY(evidence.value("notificationCount").toLongLong() > 0);
        if (expectInterval) {
            QCOMPARE(observation.latchedState(), QString("opening"));
            const auto latch = evidence.value("latched").toMap();
            QVERIFY(latch.value("progress").toDouble() > .23 && latch.value("progress").toDouble() < .96);
            QVERIFY(evidence.value("readyPoll").toMap().value("originalConstraintSatisfied").toBool());
        } else {
            QVERIFY(observation.latchedState().isEmpty());
            QVERIFY(evidence.value("latched").isNull());
            QVERIFY(evidence.value("lastBelowLower").toMap().value("progress").toDouble() < .23);
            QVERIFY(evidence.value("firstAtOrAboveUpper").toMap().value("progress").toDouble() >= .96);
        }
        observation.end();
    }
    void layerCompositorUsesActualScreenScale_data() {
        LayerCompositorScaleCases::addData();
    }
    void layerCompositorUsesActualScreenScale() {
        LayerCompositorScaleCases::runCase();
    }
    void environmentInputsReduceResolution() {
        EnvironmentResolutionCases::runCase("inputs", 2);
    }
    void environmentChangesRestartQuietWindow() {
        EnvironmentResolutionCases::runCase("restart", 2);
    }
    void environmentQuietRestoresFullResolution() {
        EnvironmentResolutionCases::runCase("quiet", 2);
    }
    void environmentOneDprKeepsNativeResolution() {
        EnvironmentResolutionCases::runCase("one-dpr", 1);
    }
    void roomQualityResolution_data() {
        QTest::addColumn<QString>("quality");
        QTest::addColumn<int>("dpr");
        for (const auto &quality : {"clear", "balanced", "smooth", "unrecognized"}) {
            for (const int dpr : {2, 1}) {
                const auto name = QString("%1-dpr%2").arg(quality).arg(dpr);
                QTest::newRow(qPrintable(name)) << QString(quality) << dpr;
            }
        }
    }
    void roomQualityResolution() {
        QFETCH(QString, quality);
        QFETCH(int, dpr);
        RoomQualityCases::run(quality, dpr);
    }
};
QTEST_MAIN(SceneDirectorTest)
#include "SceneDirectorTest.moc"
