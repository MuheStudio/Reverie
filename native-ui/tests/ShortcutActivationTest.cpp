#include "ShortcutHandoff.h"
#include <QGuiApplication>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QTest>
#include <memory>
#include <qpa/qwindowsysteminterface.h>

class ShortcutActivationTest final : public QObject {
    Q_OBJECT
    static void setFocusWindow(QWindow *window) {
        QWindowSystemInterface::handleFocusWindowChanged<QWindowSystemInterface::SynchronousDelivery>(
            window, Qt::ActiveWindowFocusReason);
    }
private slots:
    void initTestCase() {
        QQuickStyle::setStyle("Basic");
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }

    // The partial-task check's earlier Escape steps pass through the focused
    // handle's Keys handler; only Ctrl+3 needs the shortcut map, which ignores
    // a window that is not active even though QTest delivers the key to it.
    void inactiveApplicationKeepsKeysButNotWindowShortcuts() {
        QQmlEngine engine;
        QQmlComponent component(&engine, QUrl("qrc:/shortcut-activation/ShortcutActivationFixture.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        std::unique_ptr<QQuickItem> stage(qobject_cast<QQuickItem *>(component.create()));
        QVERIFY2(stage, qPrintable(component.errorString()));
        QQuickWindow window;
        window.resize(320, 240);
        stage->setParentItem(window.contentItem());
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        auto *handle = stage->findChild<QQuickItem *>("fixtureHandle");
        QVERIFY(handle);

        setFocusWindow(nullptr);
        QVERIFY(!QGuiApplication::focusWindow());
        QVERIFY(!window.isActive());
        handle->forceActiveFocus(Qt::MouseFocusReason);
        QVERIFY(handle->hasActiveFocus());
        QTest::keyClick(&window, Qt::Key_3, Qt::ControlModifier);
        QCOMPARE(stage->property("settingsActivations").toInt(), 0);
        QTest::keyClick(&window, Qt::Key_Escape);
        QCOMPARE(stage->property("handleEscapes").toInt(), 1);

        setFocusWindow(&window);
        QVERIFY(window.isActive());
        QTest::keyClick(&window, Qt::Key_3, Qt::ControlModifier);
        QCOMPARE(stage->property("settingsActivations").toInt(), 1);
        stage.reset();
    }

    void classifiesOnlyASwitchNavigationNeverEntered() {
        const QVariantMap memory{{"currentFeature", "memory"}, {"transitionRevision", 7}, {"windowActive", true}};
        const QVariantMap settings{{"currentFeature", "settings"}, {"transitionRevision", 8}};
        QVERIFY(ShortcutHandoff::entered(memory, settings));
        QCOMPARE(ShortcutHandoff::gap(memory, settings), QString());
        QCOMPARE(ShortcutHandoff::gap(memory, memory), QString("PARTIAL_TASK_SHORTCUT_NOT_ACCEPTED"));
        auto inactive = memory;
        inactive["windowActive"] = false;
        QCOMPARE(ShortcutHandoff::gap(inactive, inactive), QString("PARTIAL_TASK_SHORTCUT_WINDOW_INACTIVE"));
        // Entered even from an inactive window: no gap is invented.
        QCOMPARE(ShortcutHandoff::gap(inactive, settings), QString());
        // Settings already current with no new revision is not a new handoff.
        QVERIFY(!ShortcutHandoff::entered(settings, settings));
        // Unobservable navigation is left unclassified.
        const QVariantMap unobserved{{"windowActive", false}};
        QCOMPARE(ShortcutHandoff::gap(unobserved, unobserved), QString());
    }
};
QTEST_MAIN(ShortcutActivationTest)
#include "ShortcutActivationTest.moc"
