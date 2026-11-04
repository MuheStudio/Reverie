#include "CheckContract.h"
#include "ControlReadiness.h"
#include "ArchiveControlReadiness.h"
#include "MemoryActionProbe.h"
#include "SummaryInteractionProbe.h"
#include <QAccessible>
#include <QDeadlineTimer>
#include <QDebug>
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMouseEvent>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QSGRendererInterface>
#include <QSignalSpy>
#include <QTest>
#include <QtCore/qscopeguard.h>
#include <QtCore/qtestsupport_core.h>
#include <qpa/qwindowsysteminterface.h>
#include <limits>
#include <memory>
#include <utility>

class ReadinessExpiryProbe final : public QObject {
    Q_OBJECT
  public:
    qint64 *now = nullptr;
    int calls = 0;
  public slots:
    void expire() {
        ++calls;
        *now = 4000;
    }
};

class ArchivePressBoundaryProbe final : public QObject {
  public:
    std::function<void()> onPress, onMove;
    int presses = 0, releases = 0, movesAfterPress = 0;
    // Bounded order and window position of each press, held move and release,
    // so a cleanup failure names the event that carried an extra move.
    QStringList sequence;
    bool sequenceOverflow = false;
    static QString step(const char *kind, const QPoint &point) {
        return QStringLiteral("%1@%2,%3").arg(QLatin1String(kind)).arg(point.x()).arg(point.y());
    }
    QString describe() const { return sequence.join(' ') + (sequenceOverflow ? QStringLiteral(" +overflow") : QString()); }
  protected:
    bool eventFilter(QObject *, QEvent *event) override {
        if (event->type() == QEvent::MouseButtonPress) { ++presses; record("press", event); if (onPress) onPress(); }
        else if (event->type() == QEvent::MouseButtonRelease) { ++releases; record("release", event); }
        else if (event->type() == QEvent::MouseMove && presses > releases) {
            ++movesAfterPress; record("move", event);
            if (onMove && movesAfterPress == 1) onMove();
        }
        return false;
    }
  private:
    void record(const char *kind, QEvent *event) {
        if (sequence.size() >= 8) { sequenceOverflow = true; return; }
        sequence << step(kind, static_cast<QMouseEvent *>(event)->position().toPoint());
    }
};

static QByteArray summarySignalsFixture() {
    return R"QML(
        import QtQuick
        Item {
            width: 80; height: 30
            property bool checked: false
            property string text: "PRIVATE_SIGNAL_TEXT"
            signal clicked()
            signal toggled()
            signal canceled()
            signal pressed()
            signal released()
        }
    )QML";
}

// Shared check conventions (CheckContract.h). Each fixture is the smallest
// scene that reproduces one measurement a past batch stopped on.
static QByteArray hitFixture() {
    return R"QML(
        import QtQuick
        Item {
            width: 300; height: 200
            Item { objectName: "wrapped"; x: 10; y: 10; width: 80; height: 30
                MouseArea { objectName: "wrappedArea"; anchors.fill: parent } }
            MouseArea { objectName: "plain"; x: 110; y: 10; width: 80; height: 30
                property int clicks: 0
                onClicked: clicks++ }
            Item { objectName: "overlay"; x: 100; y: 0; width: 120; height: 60; z: 5 }
            MouseArea { objectName: "blocker"; x: 10; y: 60; width: 80; height: 30; z: 5 }
            MouseArea { objectName: "covered"; x: 10; y: 60; width: 80; height: 30 }
            Item { objectName: "clipper"; x: 200; y: 100; width: 40; height: 40; clip: true
                MouseArea { objectName: "clipped"; x: 30; y: 0; width: 40; height: 40 } }
            // MouseArea's own switch, which leaves Item.enabled true.
            MouseArea { objectName: "disabled"; x: 110; y: 100; width: 80; height: 30; enabled: false }
            // Item-level disabling, inherited by the area inside.
            Item { objectName: "disabledParent"; x: 110; y: 150; width: 80; height: 30; enabled: false
                MouseArea { objectName: "itemDisabled"; anchors.fill: parent } }
            MouseArea { objectName: "parentArea"; x: 10; y: 150; width: 80; height: 30
                Item { objectName: "label"; anchors.fill: parent } }
        }
    )QML";
}
// A full-window layer above a MouseArea, like TaskPanel's pointer
// observation layer. Only the handler type differs between the two rows.
static QByteArray observerFixture(const QByteArray &handler) {
    return R"QML(
        import QtQuick
        Item {
            width: 300; height: 200
            MouseArea { objectName: "under"; x: 20; y: 20; width: 120; height: 60
                property int clicks: 0
                onClicked: clicks++ }
            Item { objectName: "observerLayer"; x: 0; y: 0; width: 300; height: 200; z: 1000000
                )QML" + handler + R"QML( }
        }
    )QML";
}
static QByteArray treeFixture() {
    return R"QML(
        import QtQuick
        Item {
            width: 300; height: 200
            Repeater { model: 3
                Item { objectName: "row" + index; width: 10; height: 10
                    Item { objectName: "check"; width: 5; height: 5 } } }
            Item { objectName: "hiddenOnly"; visible: false }
            QtObject { objectName: "dataOnly" }
            Text { objectName: "feedback"; text: "PRIVATE_FEEDBACK_TEXT"
                Accessible.role: Accessible.StaticText; Accessible.name: "PRIVATE_ACCESSIBLE_NAME" }
            function created() { return true }
            function add(a, b) { return a + b }
        }
    )QML";
}
static QByteArray focusFixture() {
    return R"QML(
        import QtQuick
        Item {
            width: 300; height: 200
            Repeater { model: 8
                TextInput { objectName: "field" + index; y: index * 22; width: 120; height: 20 } }
        }
    )QML";
}
static QByteArray controlsFixture() {
    return R"QML(
        import QtQuick
        import QtQuick.Controls
        Item {
            width: 300; height: 200
            Button { objectName: "button"; x: 10; y: 10; width: 90; height: 32; text: "B" }
            Switch { objectName: "plainSwitch"; x: 10; y: 60; width: 90; height: 32 }
            // The product's summary switch saves in onToggled and the pending
            // save disables it before Qt triggers the click.
            Switch { objectName: "savingSwitch"; x: 10; y: 110; width: 90; height: 32
                onToggled: enabled = false }
        }
    )QML";
}

class ControlReadinessTest final : public QObject {
    Q_OBJECT
    using Sequence = NativeControlReadiness::SequentialGate;
    static QByteArray archiveBodyForm() {
        return R"QML(
            import QtQuick
            import QtQuick.Controls
            Item {
                width: 300; height: 240
                Flickable {
                    objectName: "archive-outer"
                    width: 300; height: 240; contentWidth: width; contentHeight: 1200; clip: true
                    TextField { objectName: "worldbookName"; x: 8; y: 12; width: 200; height: 32; text: "Unchanged title" }
                    ScrollView {
                        objectName: "worldbook-content-scroll"
                        x: 8; y: 650; width: 260; height: 120; clip: true
                        contentWidth: availableWidth
                        TextArea {
                            objectName: "worldbookContent"
                            width: parent.width; height: 900
                            text: "First line readiness selection.\n".repeat(60)
                            selectByMouse: true; wrapMode: TextArea.Wrap; padding: 12
                            font.pixelSize: 14
                        }
                    }
                }
            }
        )QML";
    }
    static QByteArray insertionForm() {
        return R"QML(
            import QtQuick
            import QtQuick.Controls
            Item {
                width: 300; height: 240
                Flickable {
                    objectName: "insertion-outer"; width: 300; height: 240
                    contentWidth: width; contentHeight: 1100; clip: true
                    ComboBox {
                        objectName: "worldbookInsertionPosition"; x: 8; y: 580; width: 260; height: 32
                        model: ["系统提示 · 身份段之后", "系统提示 · 角色状态之后", "对话中 · 按深度插入"]
                        property int edits: 0
                        onActivated: ++edits
                        Accessible.name: "插入位置"
                    }
                    SpinBox {
                        objectName: "worldbookInsertionDepth"; x: 8; y: 660; width: 260; height: 32
                        from: 0; to: 200; value: 5; editable: true
                        property int edits: 0
                        onValueModified: ++edits
                        Accessible.name: "插入深度，0 到 200 条历史消息"
                    }
                    ComboBox {
                        objectName: "worldbookInsertionRole"; x: 8; y: 740; width: 260; height: 32
                        model: ["系统", "用户", "助手"]
                        property int edits: 0
                        onActivated: ++edits
                        Accessible.name: "消息角色"
                    }
                }
            }
        )QML";
    }
    static QByteArray nestedForm() {
        return R"QML(
            import QtQuick
            Flickable {
                objectName: "outer"
                width: 180; height: 160; contentWidth: width; contentHeight: 1500; clip: true
                Item { objectName: "name"; x: 8; y: 20; width: 100; height: 30 }
                Item { objectName: "keys"; x: 8; y: 280; width: 100; height: 30 }
                Flickable {
                    objectName: "inner"
                    x: 20; y: 620; width: 120; height: 120
                    contentWidth: width; contentHeight: 1200; clip: true
                    Item { objectName: "body"; x: 8; y: 260; width: 80; height: 700 }
                }
                Item { objectName: "save"; x: 8; y: 1380; width: 100; height: 35 }
            }
        )QML";
    }
    static QByteArray wholeItemForm() {
        return R"QML(
            import QtQuick
            Flickable {
                objectName: "whole-scroll"
                width: 180; height: 120; contentWidth: width; contentHeight: 600; clip: true
                property bool deadlineExpired: false
                property int lateScrolls: 0
                onContentYChanged: if (deadlineExpired) ++lateScrolls
                Item {
                    objectName: "whole-target"
                    x: 8; y: 240; width: 80; height: 30
                    property string text: "WHOLE_ITEM_PRIVATE_TEXT"
                }
            }
        )QML";
    }
    static std::unique_ptr<QObject> createFixture(QQmlEngine &engine, QQuickWindow &window,
                                                 const QByteArray &source, QString &error) {
        QQmlComponent component(&engine);
        QElapsedTimer elapsed;
        elapsed.start();
        // This bounds loading and admission to create(), not synchronous Qt
        // execution. It is unrelated to the tests' controlled 4000ms clocks.
        QDeadlineTimer admission(1000, Qt::PreciseTimer);
        component.setData(source, QUrl());
        const auto initialStatus = component.status();
        bool waitAttempted = false, waitSucceeded = false;
        if (initialStatus == QQmlComponent::Loading && !admission.hasExpired()) {
            waitAttempted = true;
            waitSucceeded = QTest::qWaitFor(
                [&] { return component.status() != QQmlComponent::Loading; }, admission);
        }
        const auto statusBeforeCreate = component.status();
        // qWaitFor has a last-chance predicate. Its return value alone cannot
        // admit creation after the original deadline has expired.
        const bool admissionExpired = admission.hasExpired();
        bool createAttempted = false;
        std::unique_ptr<QObject> root;
        if ((!waitAttempted || waitSucceeded) && statusBeforeCreate == QQmlComponent::Ready &&
            !admissionExpired) {
            createAttempted = true;
            root.reset(component.create());
        }
        if (auto *item = qobject_cast<QQuickItem *>(root.get()))
            item->setParentItem(window.contentItem());
        const auto finalStatus = component.status();
        const auto statusName = [](QQmlComponent::Status status) -> QString {
            switch (status) {
            case QQmlComponent::Null: return "Null";
            case QQmlComponent::Ready: return "Ready";
            case QQmlComponent::Loading: return "Loading";
            case QQmlComponent::Error: return "Error";
            }
            return "Unknown";
        };
        const auto errors = component.errors();
        QJsonArray boundedErrors;
        for (const auto &qmlError : errors) {
            if (boundedErrors.size() == 4) break;
            const auto description = qmlError.description();
            boundedErrors.append(QJsonObject{{"description", description.left(256)},
                                             {"line", qmlError.line()}, {"column", qmlError.column()},
                                             {"descriptionTruncated", description.size() > 256}});
        }
        const QString outcome = createAttempted ? (root ? "created" : "create-failed")
            : admissionExpired ? "admission-timeout"
            : finalStatus == QQmlComponent::Error ? "component-error"
            : finalStatus == QQmlComponent::Loading ? "component-loading" : "component-null";
        const QJsonObject diagnostic{
            {"outcome", outcome}, {"initialStatus", statusName(initialStatus)},
            {"initialStatusValue", int(initialStatus)}, {"finalStatus", statusName(finalStatus)},
            {"finalStatusValue", int(finalStatus)}, {"statusBeforeCreate", statusName(statusBeforeCreate)},
            {"waitAttempted", waitAttempted},
            {"waitSucceeded", waitAttempted ? QJsonValue(waitSucceeded) : QJsonValue(QJsonValue::Null)},
            {"admissionDeadlineMs", 1000}, {"admissionExpired", admissionExpired},
            {"deadlineExpiredAtReturn", admission.hasExpired()}, {"elapsedMs", elapsed.elapsed()},
            {"createAttempted", createAttempted}, {"rootReturned", bool(root)},
            {"errorCount", int(errors.size())}, {"errors", boundedErrors},
            {"errorsTruncated", errors.size() > 4}};
        // No QML source or error URL is emitted; this same bounded diagnostic
        // remains available at every existing QVERIFY2(root, ...) assertion.
        error = QString::fromUtf8(QJsonDocument(diagnostic).toJson(QJsonDocument::Compact));
        qInfo().noquote() << "CONTROL_READINESS_FIXTURE" << error;
        return root;
    }
    static Sequence::Action action(const QString &name, QQuickItem *target, QQuickWindow &window,
                                   const std::function<void(QQuickItem *)> &perform) {
        return {name, [target] { return target; },
                [&window](QQuickItem *item) { return NativeControlReadiness::snapshot(item, &window); }, perform};
    }
    struct MemoryForm {
        QQuickItem page, otherRow, row, otherControl, control;
        explicit MemoryForm(QQuickWindow &window)
            : page(window.contentItem()), otherRow(&page), row(&page),
              otherControl(&otherRow), control(&row) {
            page.setObjectName("memoryPage"); page.setSize({250, 210}); page.setClip(true);
            page.setProperty("contentY", 0.); page.setProperty("contentHeight", 500.);
            otherRow.setSize({180, 60}); otherRow.setPosition({10, 100});
            row.setSize({180, 60}); row.setPosition({10, 20});
            otherRow.setProperty("modelData", QVariantMap{{"id", "other"}, {"text", "PRIVATE_MEMORY_SOURCE"}});
            otherRow.setProperty("index", 0);
            row.setProperty("modelData", QVariantMap{{"id", "wanted"}, {"text", "PRIVATE_MEMORY_SOURCE"}});
            row.setProperty("index", 1);
            for (auto *field : {&otherControl, &control}) {
                field->setObjectName("memoryEditField"); field->setPosition({5, 5}); field->setSize({80, 30});
            }
        }
    };
    static MemoryActionProbe::Context memoryContext() {
        return {"persona:1:fingerprint", "list-before", "success", "candidates-before", "success", "wanted", "", true};
    }
    static QVariantMap memoryReceipt(const QString &id, const QString &status = "success") {
        return {{"requestId", id}, {"status", status}};
    }
    static QVariantMap memoryActionReceipt(const QString &id, const QString &verb = "修改记忆",
                                           const QString &subject = "wanted", const QString &status = "success") {
        auto result = memoryReceipt(id, status);
        result["verb"] = verb; result["subjectId"] = subject;
        return result;
    }
    struct CompletionTransition {
        const char *name;
        int step;
        QString verb, nextControl;
    };
    static std::array<CompletionTransition, 3> completionTransitions() {
        return {{{"211-confirm-to-pin", 211, "记住这条", "memoryPin"},
                 {"212-pin-to-unpin", 212, "固定记忆", "memoryPin"},
                 {"213-unpin-to-edit", 213, "取消固定", "memoryEdit"}}};
    }
    struct CompletionReceipts {
        MemoryActionProbe::ReceiptTracker tracker;
        QString scope = memoryContext().scope;
        QVariantMap action, list, candidates;
        bool established = false;
        explicit CompletionReceipts(const QString &verb, const QString &suffix = "current") {
            list = memoryReceipt("list-before-" + suffix);
            candidates = memoryReceipt("candidates-before-" + suffix);
            action = memoryActionReceipt("action-" + suffix, verb);
            if (!tracker.arm(scope, verb, "wanted", "old-action-" + suffix,
                             list.value("requestId").toString(), candidates.value("requestId").toString()))
                return;
            if (tracker.observe(scope, action, list, candidates) != MemoryActionProbe::ReceiptTracker::WaitingForReadback)
                return;
            list = memoryReceipt("list-after-" + suffix);
            candidates = memoryReceipt("candidates-after-" + suffix);
            established = tracker.observe(scope, action, list, candidates) == MemoryActionProbe::ReceiptTracker::Complete;
        }
        bool matches() const { return tracker.matchesComplete(scope, action, list, candidates); }
    };
    // This drives the actual shared gates. Revealing the next control moves
    // the old feedback outside its Flickable, just as the 211/212/213 handoffs
    // do. There is no test-side sealed branch or replacement completion logic.
    struct CompletionScenario {
        QQuickWindow window;
        QQmlEngine engine;
        QString error;
        std::unique_ptr<QObject> root;
        QPointer<QQuickItem> scroll, feedback, next;
        CompletionReceipts receipts;
        MemoryActionProbe::CompletionGate completion;
        Sequence sequence;
        qint64 now = 0;
        bool inputReady = false, businessMatches = true;
        int identityChecks = 0, validationCalls = 0, feedbackInspections = 0;
        int targetLookups = 0, inspections = 0, clicks = 0;
        QString nextControl;
        std::function<bool()> identityStillMatches, firstValidation;
        explicit CompletionScenario(const QString &verb, const QString &control)
            : receipts(verb), nextControl(control) {
            window.resize(300, 240);
            root = createFixture(engine, window, R"QML(
                import QtQuick
                Flickable {
                    objectName: "completion-scroll"
                    width: 180; height: 120; contentWidth: width; contentHeight: 600; clip: true
                    Item {
                        objectName: "completion-feedback"
                        x: 8; y: 12; width: 140; height: 30
                        property string text: "FIXTURE_COMPLETION_SUCCESS"
                    }
                    Item { objectName: "completion-next"; x: 8; y: 430; width: 100; height: 30 }
                }
            )QML", error);
            scroll = qobject_cast<QQuickItem *>(root.get());
            if (root) {
                feedback = root->findChild<QQuickItem *>("completion-feedback");
                next = root->findChild<QQuickItem *>("completion-next");
            }
            identityStillMatches = [this] { return receipts.matches(); };
            firstValidation = [this] { return validateFeedback(); };
        }
        bool validateFeedback() {
            ++feedbackInspections;
            const auto clip = NativeControlReadiness::visibleRect(feedback, &window);
            // Match ArchiveInteractionCheck::shownWith/fullyInView exactly;
            // do not introduce a stricter width or input-readiness contract.
            return feedback && feedback->isVisible() && feedback->height() >= 1 &&
                   clip.width() >= 2 && clip.height() >= feedback->height() - 1 &&
                   feedback->property("text").toString() == "FIXTURE_COMPLETION_SUCCESS" && businessMatches;
        }
        Sequence::Result poll(MemoryActionProbe::CompletionGate &gate, CompletionReceipts &current) {
            if (!gate.verify([&] { ++identityChecks; return current.matches(); },
                             [&] { ++validationCalls; return firstValidation(); }))
                return Sequence::Failed;
            return pollSequence();
        }
        Sequence::Result poll() {
            if (!completion.verify([&] { ++identityChecks; return identityStillMatches(); },
                                   [&] { ++validationCalls; return firstValidation(); }))
                return Sequence::Failed;
            return pollSequence();
        }
        Sequence::Result pollSequence() {
            const std::vector<Sequence::Action> actions{{nextControl,
                [&] { ++targetLookups; return next.data(); },
                [&](QQuickItem *item) {
                    ++inspections;
                    auto state = NativeControlReadiness::snapshot(item, &window);
                    state["ready"] = state.value("ready").toBool() && inputReady;
                    return state;
                }, [&](QQuickItem *) { ++clicks; }}};
            return sequence.poll([&] { return now; }, 4000, actions);
        }
    };
  private slots:
    void initTestCase() {
        // Only the real-controls case imports QtQuick.Controls; pin its style
        // before the first import so the platform style cannot vary results.
        qputenv("QT_QUICK_CONTROLS_STYLE", "Basic");
        // Two cases show a window. The offscreen platform has no OpenGL; the
        // other cases never render, so their behavior is unchanged.
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }
    void malformedFixtureFailsClosed() {
        QQuickWindow window;
        QQmlEngine engine;
        QString error;
        const auto root = createFixture(engine, window, "import QtQuick\nItem {", error);
        QVERIFY(!root);
        const auto document = QJsonDocument::fromJson(error.toUtf8());
        QVERIFY(document.isObject());
        const auto diagnostic = document.object();
        QCOMPARE(diagnostic.value("finalStatus").toString(), QString("Error"));
        QCOMPARE(diagnostic.value("finalStatusValue").toInt(), int(QQmlComponent::Error));
        QVERIFY(diagnostic.value("createAttempted").isBool());
        QVERIFY(!diagnostic.value("createAttempted").toBool());
        QVERIFY(!diagnostic.value("rootReturned").toBool());
        QVERIFY(diagnostic.value("errorCount").toInt() > 0);
        const auto errors = diagnostic.value("errors").toArray();
        QVERIFY(!errors.isEmpty());
        QVERIFY(errors.size() <= 4);
        for (const auto &value : errors) {
            const auto item = value.toObject();
            QVERIFY(!item.value("description").toString().isEmpty());
            QVERIFY(item.value("description").toString().size() <= 256);
            QVERIFY(item.value("descriptionTruncated").isBool());
        }
    }
    void disabledAndClippedControlsWait() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem viewport(window.contentItem());
        viewport.setSize({100, 100});
        viewport.setClip(true);
        QQuickItem editor(&viewport);
        editor.setSize({80, 30});
        editor.setPosition({10, 20});
        QVERIFY(NativeControlReadiness::snapshot(&editor, &window)["ready"].toBool());
        viewport.setEnabled(false);
        QVERIFY(!NativeControlReadiness::snapshot(&editor, &window)["enabled"].toBool());
        viewport.setEnabled(true);
        editor.setPosition({85, 20});
        const auto clipped = NativeControlReadiness::snapshot(&editor, &window);
        QVERIFY(clipped["visible"].toBool());
        QVERIFY(!clipped["inputPointInsideClip"].toBool());
        QVERIFY(!clipped["ready"].toBool());
        editor.setPosition({10, 20});
        viewport.setOpacity(.01);
        QVERIFY(!NativeControlReadiness::snapshot(&editor, &window)["visible"].toBool());
        viewport.setOpacity(1);
        QVERIFY(!NativeControlReadiness::snapshot(&editor, &window, false)["ready"].toBool());
    }
    void deadlinePrecedesInspectionAndCommit() {
        NativeControlReadiness::OnceGate gate;
        int inspections = 0, commits = 0;
        const auto inspect = [&] { ++inspections; return QVariantMap{{"ready", true}}; };
        QCOMPARE(gate.poll(4000, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Expired);
        QCOMPARE(inspections, 0);
        QCOMPARE(commits, 0);
    }
    void waitingKeepsDeadlineAndCommitsOnce() {
        NativeControlReadiness::OnceGate gate;
        bool ready = false;
        int commits = 0;
        const auto inspect = [&] { return QVariantMap{{"ready", ready}}; };
        QCOMPARE(gate.poll(0, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Waiting);
        QCOMPARE(gate.poll(3900, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Waiting);
        ready = true;
        QCOMPARE(gate.poll(3999, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Performed);
        QCOMPARE(gate.poll(3999, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Performed);
        QCOMPARE(commits, 1);
        QCOMPARE(gate.poll(4000, 4000, inspect, [&] { ++commits; }), NativeControlReadiness::OnceGate::Expired);
        QCOMPARE(commits, 1);
    }
    void observationsAreBounded() {
        NativeControlReadiness::OnceGate gate;
        for (int i = 0; i < 35; ++i)
            QCOMPARE(gate.poll(i * 100, 4000, [i] { return QVariantMap{{"ready", false}, {"found", i % 2 == 0}}; }, [] {}),
                     NativeControlReadiness::OnceGate::Waiting);
        QCOMPARE(gate.metadata()["polls"].toInt(), 35);
        QCOMPARE(gate.metadata()["samples"].toList().size(), 6);
        QCOMPARE(gate.metadata()["last"].toMap()["elapsedMs"].toInt(), 3400);
    }
    void nestedFlickablesRevealTheWholeItemCenter() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *outer = qobject_cast<QQuickItem *>(root.get());
        auto *inner = root->findChild<QQuickItem *>("inner");
        auto *body = root->findChild<QQuickItem *>("body");
        QVERIFY(outer && inner && body);
        QVERIFY(!NativeControlReadiness::snapshot(body, &window)["ready"].toBool());
        qint64 now = 50;
        const auto reveal = NativeControlReadiness::revealCenter(body, [&] { return now; }, 4000);
        QVERIFY(!reveal["expired"].toBool());
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 2);
        // The 700px body is taller than both viewports. Revealing its top or
        // merely finding a visible fragment would leave its center clipped.
        QCOMPARE(inner->property("contentY").toDouble(), 550.0);
        QCOMPARE(outer->property("contentY").toDouble(), 600.0);
        const auto ready = NativeControlReadiness::snapshot(body, &window);
        QVERIFY(ready["ready"].toBool());
        QVERIFY(ready["inputPointInsideClip"].toBool());
        QCOMPARE(ready["visibleHeight"].toDouble(), 120.0);
        const auto scrolls = reveal["scrolls"].toList();
        QCOMPARE(scrolls.size(), 2);
        QCOMPARE(scrolls[0].toMap()["afterY"].toDouble(), 550.0);
        QCOMPARE(scrolls[1].toMap()["afterY"].toDouble(), 600.0);
    }
    void wholeItemSecondCycleGeometryScrollsWhenCenterAlreadyFits() {
        QQuickWindow window;
        window.resize(300, 700);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        scroll->setHeight(626);
        QVERIFY(scroll->setProperty("contentHeight", 680.));
        target->setY(592);
        target->setHeight(49);
        const auto center = NativeControlReadiness::revealCenter(target, [] { return qint64(0); }, 4000);
        QVERIFY(center["geometryValid"].toBool());
        QCOMPARE(center["scrollCount"].toInt(), 0);
        QCOMPARE(scroll->property("contentY").toDouble(), 0.0);
        auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        QVERIFY(!NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));

        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
        QVERIFY(!reveal["expired"].toBool());
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 1);
        QCOMPARE(reveal["ancestorCount"].toInt(), 1);
        QCOMPARE(scroll->property("contentY").toDouble(), 54.0);
        const auto records = reveal["scrolls"].toList();
        QCOMPARE(records.size(), 1);
        const auto record = records[0].toMap();
        QCOMPARE(record["beforeY"].toDouble(), 0.0);
        QCOMPARE(record["afterY"].toDouble(), 54.0);
        QCOMPARE(record["centerYBefore"].toDouble(), 616.5);
        QCOMPARE(record["topYBefore"].toDouble(), 592.0);
        QCOMPARE(record["bottomYBefore"].toDouble(), 641.0);
        QCOMPARE(record["requestedY"].toDouble(), 303.5);
        QCOMPARE(record["maximumY"].toDouble(), 54.0);
        QVERIFY(record["fitsViewport"].toBool());
        scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        QCOMPARE(scene.top(), 538.0);
        QCOMPARE(scene.bottom(), 587.0);
        QVERIFY(NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));
    }
    void wholeItemClippedTopScrollsUp() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        target->setY(180);
        target->setHeight(40);
        QVERIFY(scroll->setProperty("contentY", 200.));
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 1);
        QCOMPARE(scroll->property("contentY").toDouble(), 140.0);
        const auto record = reveal["scrolls"].toList()[0].toMap();
        QCOMPARE(record["topYBefore"].toDouble(), -20.0);
        QCOMPARE(record["bottomYBefore"].toDouble(), 20.0);
        QCOMPARE(record["centerYBefore"].toDouble(), 0.0);
        QVERIFY(record["fitsViewport"].toBool());
        const auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        QCOMPARE(scene.top(), 40.0);
        QCOMPARE(scene.bottom(), 80.0);
        QVERIFY(NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));
    }
    void wholeItemAlreadyVisibleDoesNotScrollIncludingTolerance() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        QVERIFY(scroll->setProperty("contentWidth", 600.));
        QVERIFY(scroll->setProperty("contentX", 70.));
        target->setX(100);
        target->setHeight(40);
        for (const qreal y : {30., -.5, 80.5}) {
            target->setY(y);
            const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
            QVERIFY(!reveal["expired"].toBool());
            QVERIFY(reveal["geometryValid"].toBool());
            QCOMPARE(reveal["scrollCount"].toInt(), 0);
            QCOMPARE(scroll->property("contentY").toDouble(), 0.0);
            QCOMPARE(scroll->property("contentX").toDouble(), 70.0);
            const auto record = reveal["scrolls"].toList()[0].toMap();
            QCOMPARE(record["topYBefore"].toDouble(), y);
            QCOMPARE(record["bottomYBefore"].toDouble(), y + 40);
            QVERIFY(record["fitsViewport"].toBool());
            QVERIFY(!record["scrolled"].toBool());
            QVERIFY(record["afterObserved"].toBool());
            const auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
            QVERIFY(NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));
            const auto json = QJsonDocument::fromVariant(reveal).toJson(QJsonDocument::Compact);
            QVERIFY(!json.contains("WHOLE_ITEM_PRIVATE_TEXT"));
            QVERIFY(!json.contains("\"text\""));
        }
    }
    void wholeItemClampsAtContentEndAndRemainsVisible() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        QVERIFY(scroll->setProperty("contentHeight", 200.));
        QVERIFY(scroll->setProperty("topMargin", 32.));
        QVERIFY(scroll->setProperty("bottomMargin", 48.));
        QVERIFY(scroll->setProperty("contentY", 0.));
        target->setY(180);
        target->setHeight(60);
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
        QVERIFY(!reveal["expired"].toBool());
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 1);
        QCOMPARE(scroll->property("contentY").toDouble(), 128.0);
        const auto record = reveal["scrolls"].toList()[0].toMap();
        QCOMPARE(record["minimumY"].toDouble(), -32.0);
        QCOMPARE(record["maximumY"].toDouble(), 128.0);
        QCOMPARE(record["requestedY"].toDouble(), 150.0);
        QCOMPARE(record["afterY"].toDouble(), 128.0);
        QVERIFY(record["fitsViewport"].toBool());
        const auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        QCOMPARE(scene.top(), 52.0);
        QCOMPARE(scene.bottom(), 112.0);
        QVERIFY(NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));
    }
    void wholeItemTallerThanViewportCannotBeFullyVisible() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        target->setHeight(180);
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
        QVERIFY(!reveal["expired"].toBool());
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 1);
        QCOMPARE(scroll->property("contentY").toDouble(), 270.0);
        const auto record = reveal["scrolls"].toList()[0].toMap();
        QVERIFY(!record["fitsViewport"].toBool());
        QCOMPARE(record["topYBefore"].toDouble(), 240.0);
        QCOMPARE(record["bottomYBefore"].toDouble(), 420.0);
        const auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        const auto clip = NativeControlReadiness::visibleRect(target, &window);
        QCOMPARE(scene.height(), 180.0);
        QCOMPARE(clip.height(), 120.0);
        QVERIFY(!clip.contains(scene.adjusted(.5, .5, -.5, -.5)));
    }
    void wholeItemNestedScrollsRemapInnerBeforeOuterAndBoundRecords() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *outer = qobject_cast<QQuickItem *>(root.get());
        auto *inner = root->findChild<QQuickItem *>("inner");
        auto *target = root->findChild<QQuickItem *>("body");
        QVERIFY(outer && inner && target);
        target->setHeight(30);
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(0); }, 4000);
        QVERIFY(reveal["geometryValid"].toBool());
        QCOMPARE(reveal["ancestorCount"].toInt(), 2);
        QCOMPARE(reveal["scrollCount"].toInt(), 2);
        QCOMPARE(inner->property("contentY").toDouble(), 215.0);
        QCOMPARE(outer->property("contentY").toDouble(), 600.0);
        const auto records = reveal["scrolls"].toList();
        QCOMPARE(records.size(), 2);
        QCOMPARE(records[0].toMap()["topYBefore"].toDouble(), 260.0);
        QCOMPARE(records[0].toMap()["bottomYBefore"].toDouble(), 290.0);
        QCOMPARE(records[1].toMap()["topYBefore"].toDouble(), 665.0);
        QCOMPARE(records[1].toMap()["bottomYBefore"].toDouble(), 695.0);
        QVERIFY(records[0].toMap()["fitsViewport"].toBool());
        QVERIFY(records[1].toMap()["fitsViewport"].toBool());
        const auto scene = target->mapRectToScene(QRectF(0, 0, target->width(), target->height()));
        QVERIFY(NativeControlReadiness::visibleRect(target, &window).contains(scene.adjusted(.5, .5, -.5, -.5)));

        QByteArray qml("import QtQuick\n");
        for (int i = 0; i < 8; ++i) {
            qml += "Flickable { width: 120; height: 100; contentWidth: width; contentHeight: 1000; clip: true;";
            if (i) qml += " y: 600;";
        }
        qml += "Item { objectName: 'whole-target'; x: 8; y: 600; width: 80; height: 30 }";
        for (int i = 0; i < 8; ++i) qml += '}';
        auto deepRoot = createFixture(engine, window, qml, error);
        QVERIFY2(deepRoot, qPrintable(error));
        auto *deepTarget = deepRoot->findChild<QQuickItem *>("whole-target");
        QVERIFY(deepTarget);
        const auto bounded = NativeControlReadiness::revealWholeItem(deepTarget, [] { return qint64(0); }, 4000);
        QVERIFY(bounded["geometryValid"].toBool());
        QCOMPARE(bounded["ancestorCount"].toInt(), 8);
        QCOMPARE(bounded["scrollCount"].toInt(), 8);
        QCOMPARE(bounded["scrollLimit"].toInt(), 6);
        QCOMPARE(bounded["scrolls"].toList().size(), 6);
        const auto deepScene = deepTarget->mapRectToScene(QRectF(0, 0, deepTarget->width(), deepTarget->height()));
        QVERIFY(NativeControlReadiness::visibleRect(deepTarget, &window).contains(deepScene.adjusted(.5, .5, -.5, -.5)));
    }
    void wholeVisibilityReportsBoundedGeometryForEveryOutcome() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(target);
        const auto missing = NativeControlReadiness::wholeVisibility(nullptr, &window);
        QVERIFY(!missing["found"].toBool() && !missing["fullyVisible"].toBool() && !missing.contains("sceneY"));
        target->setY(30);
        auto inside = NativeControlReadiness::wholeVisibility(target, &window);
        QVERIFY(inside["found"].toBool() && inside["visible"].toBool() && inside["fullyVisible"].toBool());
        QCOMPARE(inside["sceneY"].toDouble(), 30.0);
        QCOMPARE(inside["clipHeight"].toDouble(), 30.0);
        // Center inside the 120px viewport while the bottom edge is clipped.
        target->setY(100);
        const auto clipped = NativeControlReadiness::wholeVisibility(target, &window);
        QVERIFY(clipped["visible"].toBool() && !clipped["fullyVisible"].toBool());
        QCOMPARE(clipped["clipHeight"].toDouble(), 20.0);
        target->setY(30);
        target->setVisible(false);
        QVERIFY(!NativeControlReadiness::wholeVisibility(target, &window)["fullyVisible"].toBool());
        for (const auto &value : {missing, inside, clipped})
            for (auto it = value.cbegin(); it != value.cend(); ++it)
                QVERIFY(it.value().typeId() == QMetaType::Bool || it.value().typeId() == QMetaType::Double);
    }
    void revealSummaryKeepsOnlyFixedMetadata() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(target);
        const auto empty = NativeControlReadiness::revealSummary({});
        QVERIFY(!empty["present"].toBool() && !empty["expired"].toBool() && !empty.contains("lastAfterY"));
        target->setY(240);
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [] { return qint64(5); }, 4000);
        const auto summary = NativeControlReadiness::revealSummary(reveal);
        QVERIFY(summary["present"].toBool() && summary["geometryValid"].toBool() && summary["fitsViewport"].toBool());
        QCOMPARE(summary["scrollCount"].toInt(), 1);
        QCOMPARE(summary["ancestorCount"].toInt(), 1);
        QCOMPARE(summary["elapsedMs"].toLongLong(), qint64(5));
        QVERIFY(summary.contains("lastAfterY"));
        QVERIFY(!summary.contains("scrolls") && !summary.contains("geometry"));
        const auto expired = NativeControlReadiness::revealSummary(
            NativeControlReadiness::revealWholeItem(target, [] { return qint64(4000); }, 4000));
        QVERIFY(expired["expired"].toBool());
        const auto json = QJsonDocument::fromVariant(summary).toJson(QJsonDocument::Compact);
        QVERIFY(!json.contains("WHOLE_ITEM_PRIVATE_TEXT"));
    }
    void wholeItemDeadlineNeverAllowsLateScrollOrOuterReadback() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, wholeItemForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *scroll = qobject_cast<QQuickItem *>(root.get());
        auto *target = root->findChild<QQuickItem *>("whole-target");
        QVERIFY(scroll && target);
        qint64 now = 4000;
        const auto atDeadline = NativeControlReadiness::revealWholeItem(target, [&] { return now; }, 4000);
        QVERIFY(atDeadline["expired"].toBool());
        QVERIFY(!atDeadline["geometryValid"].toBool());
        QCOMPARE(atDeadline["ancestorCount"].toInt(), 0);
        QCOMPARE(atDeadline["scrollCount"].toInt(), 0);
        QCOMPARE(scroll->property("contentY").toDouble(), 0.0);

        // Advance the same controlled clock at successive read/write checks.
        // The fixture counts any contentY change after that clock expired;
        // this does not depend on the helper retaining a fixed check count.
        for (int expireAt = 1; expireAt <= 64; ++expireAt) {
            QVERIFY(scroll->setProperty("deadlineExpired", false));
            QVERIFY(scroll->setProperty("contentY", 0.));
            QVERIFY(scroll->setProperty("lateScrolls", 0));
            now = 3999;
            int clockChecks = 0;
            bool markedExpired = false;
            const auto reveal = NativeControlReadiness::revealWholeItem(target, [&] {
                if (++clockChecks >= expireAt) {
                    now = 4000;
                    if (!markedExpired) {
                        markedExpired = true;
                        scroll->setProperty("deadlineExpired", true);
                    }
                }
                return now;
            }, 4000);
            QCOMPARE(reveal["expired"].toBool(), clockChecks >= expireAt);
            QCOMPARE(scroll->property("lateScrolls").toInt(), 0);
            const auto contentY = scroll->property("contentY").toDouble();
            QVERIFY(contentY == 0.0 || contentY == 195.0);
            QCOMPARE(reveal["scrollCount"].toInt(), contentY == 0.0 ? 0 : 1);
        }
        QVERIFY(scroll->setProperty("deadlineExpired", false));
        QVERIFY(scroll->setProperty("contentY", 0.));
        now = 4001;
        const auto afterDeadline = NativeControlReadiness::revealWholeItem(target, [&] { return now; }, 4000);
        QVERIFY(afterDeadline["expired"].toBool());
        QCOMPARE(afterDeadline["scrollCount"].toInt(), 0);
        QCOMPARE(scroll->property("contentY").toDouble(), 0.0);

        auto nestedRoot = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(nestedRoot, qPrintable(error));
        auto *outer = qobject_cast<QQuickItem *>(nestedRoot.get());
        auto *inner = nestedRoot->findChild<QQuickItem *>("inner");
        auto *nestedTarget = nestedRoot->findChild<QQuickItem *>("body");
        QVERIFY(outer && inner && nestedTarget);
        nestedTarget->setHeight(30);
        now = 3999;
        ReadinessExpiryProbe expiry;
        expiry.now = &now;
        QVERIFY(QObject::connect(inner, SIGNAL(contentYChanged()), &expiry, SLOT(expire())));
        const auto stopped = NativeControlReadiness::revealWholeItem(nestedTarget, [&] { return now; }, 4000);
        QVERIFY(stopped["expired"].toBool());
        QCOMPARE(now, 4000);
        QCOMPARE(expiry.calls, 1);
        QCOMPARE(stopped["ancestorCount"].toInt(), 1);
        QCOMPARE(stopped["scrollCount"].toInt(), 1);
        QCOMPARE(inner->property("contentY").toDouble(), 215.0);
        QCOMPARE(outer->property("contentY").toDouble(), 0.0);
        const auto records = stopped["scrolls"].toList();
        QCOMPARE(records.size(), 1);
        const auto record = records[0].toMap();
        QVERIFY(!record["afterObserved"].toBool());
        QVERIFY(!record.contains("afterY"));
        const auto stillExpired = NativeControlReadiness::revealWholeItem(nestedTarget, [&] { return now; }, 4000);
        QVERIFY(stillExpired["expired"].toBool());
        QCOMPARE(stillExpired["ancestorCount"].toInt(), 0);
        QCOMPARE(stillExpired["scrollCount"].toInt(), 0);
        QCOMPARE(expiry.calls, 1);
        QCOMPARE(outer->property("contentY").toDouble(), 0.0);
    }
    void sequenceRevealsEachActionOnceIncludingSave() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *name = root->findChild<QQuickItem *>("name");
        auto *keys = root->findChild<QQuickItem *>("keys");
        auto *body = root->findChild<QQuickItem *>("body");
        auto *save = root->findChild<QQuickItem *>("save");
        QVERIFY(name && keys && body && save);
        Sequence gate;
        qint64 now = 0;
        QStringList performed;
        std::vector<Sequence::Action> actions;
        for (const auto &entry : std::vector<std::pair<QString, QQuickItem *>>{
                 {"name", name}, {"keys", keys}, {"content", body}, {"save", save}})
            actions.push_back(action(entry.first, entry.second, window, [&, label = entry.first](QQuickItem *item) {
                QVERIFY(NativeControlReadiness::snapshot(item, &window)["ready"].toBool());
                performed.append(label);
            }));
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(performed, QStringList{"name"});
        now = 100;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(performed, (QStringList{"name", "keys"}));
        QVERIFY(!NativeControlReadiness::snapshot(name, &window)["ready"].toBool());
        now = 200;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(performed, (QStringList{"name", "keys", "content"}));
        QVERIFY(!NativeControlReadiness::snapshot(keys, &window)["ready"].toBool());
        now = 300;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Performed);
        QCOMPARE(performed, (QStringList{"name", "keys", "content", "save"}));
        QVERIFY(!NativeControlReadiness::snapshot(body, &window)["ready"].toBool());
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Performed);
        QCOMPARE(performed.size(), 4);
        const auto metadata = gate.metadata()["actions"].toList();
        QCOMPARE(metadata.size(), 4);
        for (int i = 0; i < metadata.size(); ++i) {
            const auto record = metadata[i].toMap();
            QCOMPARE(record["index"].toInt(), i);
            QCOMPARE(record["polls"].toInt(), 1);
            QVERIFY(record["attempted"].toBool());
            QVERIFY(record["performed"].toBool());
            QCOMPARE(record["actionElapsedMs"].toLongLong(), i * 100);
        }
    }
    void allActionsShareTheOriginalDeadline() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        Sequence gate;
        qint64 now = 0;
        QStringList performed;
        int lookups = 0;
        std::vector<Sequence::Action> actions;
        for (const auto &name : {QString("name"), QString("keys"), QString("content"), QString("save")}) {
            auto step = action(name, &field, window, [&, name](QQuickItem *) { performed.append(name); });
            step.target = [&] { ++lookups; return &field; };
            actions.push_back(step);
        }
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        now = 2000;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        now = 3999;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        now = 4000;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(performed, (QStringList{"name", "keys", "content"}));
        QCOMPARE(lookups, 3);
        const auto records = gate.metadata()["actions"].toList();
        QCOMPARE(records[2].toMap()["actionElapsedMs"].toLongLong(), 3999);
        QVERIFY(!records[3].toMap()["attempted"].toBool());
        QVERIFY(gate.metadata()["expired"].toBool());
    }
    void deadlineDuringInnerScrollStopsOuterScrollAndInspection() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *outer = qobject_cast<QQuickItem *>(root.get());
        auto *inner = root->findChild<QQuickItem *>("inner");
        auto *body = root->findChild<QQuickItem *>("body");
        QVERIFY(outer && inner && body);
        qint64 now = 3999;
        ReadinessExpiryProbe probe;
        probe.now = &now;
        QVERIFY(QObject::connect(inner, SIGNAL(contentYChanged()), &probe, SLOT(expire())));
        int inspections = 0, inputs = 0;
        Sequence gate;
        const std::vector<Sequence::Action> actions{{"content", [body] { return body; },
            [&](QQuickItem *item) { ++inspections; return NativeControlReadiness::snapshot(item, &window); },
            [&](QQuickItem *) { ++inputs; }}};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(now, 4000);
        QCOMPARE(probe.calls, 1);
        QCOMPARE(inner->property("contentY").toDouble(), 550.0);
        QCOMPARE(outer->property("contentY").toDouble(), 0.0);
        QCOMPARE(inspections, 0);
        QCOMPARE(inputs, 0);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(probe.calls, 1);
        const auto reveal = gate.metadata()["actions"].toList()[0].toMap()["last"].toMap()["reveal"].toMap();
        QVERIFY(reveal["expired"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 1);
        const auto scroll = reveal["scrolls"].toList()[0].toMap();
        QVERIFY(!scroll["afterObserved"].toBool());
        QVERIFY(!scroll.contains("afterY"));
    }
    void deadlineDuringInspectionStopsInput() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        Sequence gate;
        qint64 now = 3999;
        int inspections = 0, inputs = 0;
        const std::vector<Sequence::Action> actions{{"name", [&] { return &field; },
            [&](QQuickItem *item) {
                ++inspections;
                const auto state = NativeControlReadiness::snapshot(item, &window);
                now = 4000;
                return state;
            }, [&](QQuickItem *) { ++inputs; }}};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(inspections, 1);
        QCOMPARE(inputs, 0);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(inspections, 1);
        QCOMPARE(inputs, 0);
    }
    void freshClockImmediatelyBeforeInputStopsDeadlineCrossing() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        Sequence gate;
        bool inspected = false;
        int checksAfterInspection = 0, inputs = 0;
        const NativeControlReadiness::ElapsedClock clock = [&] {
            return inspected && ++checksAfterInspection >= 2 ? qint64(4000) : qint64(3999);
        };
        const std::vector<Sequence::Action> actions{{"save", [&] { return &field; },
            [&](QQuickItem *item) {
                auto state = NativeControlReadiness::snapshot(item, &window);
                inspected = true;
                return state;
            }, [&](QQuickItem *) { ++inputs; }}};
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(checksAfterInspection, 2);
        QCOMPARE(inputs, 0);
        QVERIFY(!gate.metadata()["actions"].toList()[0].toMap()["attempted"].toBool());
    }
    void scrollClampsToPublicMarginsAndCannotUseAPartlyVisiblePoint() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, R"QML(
            import QtQuick
            Flickable {
                width: 180; height: 160; contentWidth: width; contentHeight: 200; clip: true
                topMargin: 32; bottomMargin: 48; contentY: 0
                Item { objectName: "body"; x: 8; y: 180; width: 80; height: 160 }
            }
        )QML", error);
        QVERIFY2(root, qPrintable(error));
        auto *outer = qobject_cast<QQuickItem *>(root.get());
        auto *body = root->findChild<QQuickItem *>("body");
        QVERIFY(outer && body);
        Sequence gate;
        qint64 now = 0;
        int inputs = 0;
        const std::vector<Sequence::Action> actions{action("content", body, window, [&](QQuickItem *) { ++inputs; })};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(outer->property("contentY").toDouble(), 88.0);
        const auto scroll = gate.metadata()["actions"].toList()[0].toMap()["last"].toMap()
                                ["reveal"].toMap()["scrolls"].toList()[0].toMap();
        QCOMPARE(scroll["minimumY"].toDouble(), -32.0);
        QCOMPARE(scroll["maximumY"].toDouble(), 88.0);
        const auto clipped = NativeControlReadiness::snapshot(body, &window);
        QVERIFY(clipped["visible"].toBool());
        QVERIFY(!clipped["inputPointInsideClip"].toBool());
        QCOMPARE(inputs, 0);
        now = 3999;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        now = 4000;
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(inputs, 0);
    }
    void nonfiniteBoundsCannotScrollOrAuthorizeInput() {
        QQuickWindow window;
        window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *inner = root->findChild<QQuickItem *>("inner");
        auto *body = root->findChild<QQuickItem *>("body");
        QVERIFY(inner && body);
        const auto before = inner->property("contentY").toDouble();
        QVERIFY(inner->setProperty("contentHeight", std::numeric_limits<qreal>::infinity()));
        Sequence gate;
        int inputs = 0;
        const std::vector<Sequence::Action> actions{{"content", [body] { return body; },
            [](QQuickItem *) { return QVariantMap{{"ready", true}}; },
            [&](QQuickItem *) { ++inputs; }}};
        QCOMPARE(gate.poll([] { return qint64(0); }, 4000, actions), Sequence::Waiting);
        QCOMPARE(inner->property("contentY").toDouble(), before);
        QCOMPARE(inputs, 0);
        const auto reveal = gate.metadata()["actions"].toList()[0].toMap()["last"].toMap()["reveal"].toMap();
        QVERIFY(!reveal["geometryValid"].toBool());
        QCOMPARE(reveal["scrollCount"].toInt(), 0);
    }
    void reentrantPollCannotDuplicateAnyAction() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        Sequence gate;
        qint64 now = 0;
        int inputs = 0, nestedPolls = 0;
        std::vector<Sequence::Action> actions;
        NativeControlReadiness::ElapsedClock clock;
        bool clockReentered = false;
        Sequence::Result clockReentryResult = Sequence::Failed;
        clock = [&] {
            if (!clockReentered) {
                clockReentered = true;
                clockReentryResult = gate.poll(clock, 4000, actions);
            }
            return now;
        };
        auto reenter = [&] {
            ++nestedPolls;
            QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        };
        actions.push_back({"name", [&] { reenter(); return &field; },
            [&](QQuickItem *item) { reenter(); return NativeControlReadiness::snapshot(item, &window); },
            [&](QQuickItem *) { reenter(); ++inputs; }});
        actions.push_back(action("save", &field, window, [&](QQuickItem *) { reenter(); ++inputs; }));
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QVERIFY(clockReentered);
        QCOMPARE(clockReentryResult, Sequence::Waiting);
        QCOMPARE(inputs, 1);
        QCOMPARE(nestedPolls, 3);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Performed);
        QCOMPARE(inputs, 2);
        QCOMPARE(nestedPolls, 4);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Performed);
        QCOMPARE(inputs, 2);
    }
    void anActionThatThrowsCannotBeAutomaticallyRetried() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        Sequence gate;
        qint64 now = 0;
        int inputs = 0;
        const std::vector<Sequence::Action> actions{action("save", &field, window, [&](QQuickItem *) {
            ++inputs;
            throw std::runtime_error("simulated dispatch failure");
        })};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QVERIFY_EXCEPTION_THROWN(gate.poll(clock, 4000, actions), std::runtime_error);
        QCOMPARE(inputs, 1);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Failed);
        QCOMPARE(inputs, 1);
        const auto record = gate.metadata()["actions"].toList()[0].toMap();
        QVERIFY(record["attempted"].toBool());
        QVERIFY(record["failed"].toBool());
        QVERIFY(!record["performed"].toBool());
    }
    void neverReadyKeepsBoundedMetadataWithoutText() {
        QQuickWindow window;
        window.resize(300, 200);
        QQuickItem field(window.contentItem());
        field.setSize({80, 30});
        field.setEnabled(false);
        Sequence gate;
        qint64 now = 0;
        int inspections = 0, inputs = 0;
        const std::vector<Sequence::Action> actions{{"name", [&] { return &field; },
            [&](QQuickItem *item) {
                ++inspections;
                auto state = NativeControlReadiness::snapshot(item, &window);
                state["text"] = QString(10000, QChar('x'));
                state["unexpectedSensitiveValue"] = "DO_NOT_RETAIN";
                return state;
            }, [&](QQuickItem *) { ++inputs; }}};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        for (now = 0; now < 4000; now += 100)
            QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(gate.poll(clock, 4000, actions), Sequence::Expired);
        QCOMPARE(inspections, 40);
        QCOMPARE(inputs, 0);
        const auto metadata = gate.metadata();
        const auto record = metadata["actions"].toList()[0].toMap();
        QCOMPARE(record["samples"].toList().size(), 6);
        QCOMPARE(record["last"].toMap()["elapsedMs"].toLongLong(), 3900);
        const auto json = QJsonDocument::fromVariant(metadata).toJson(QJsonDocument::Compact);
        QVERIFY(!json.contains("DO_NOT_RETAIN"));
        QVERIFY(!json.contains("unexpectedSensitiveValue"));
        QVERIFY(!json.contains("\"text\""));
        QVERIFY(json.size() < 12000);
    }
    void scrollObservationsAreBoundedAcrossManyAncestors() {
        QQuickWindow window;
        window.resize(300, 200);
        QQmlEngine engine;
        QByteArray qml("import QtQuick\n");
        for (int i = 0; i < 8; ++i) {
            qml += "Flickable { width: 120; height: 100; contentWidth: width; contentHeight: 1000; clip: true;";
            if (i) qml += " y: 600;";
        }
        qml += "Item { objectName: 'target'; x: 8; y: 600; width: 80; height: 30 }";
        for (int i = 0; i < 8; ++i) qml += '}';
        QString error;
        auto root = createFixture(engine, window, qml, error);
        QVERIFY2(root, qPrintable(error));
        auto *target = root->findChild<QQuickItem *>("target");
        QVERIFY(target);
        const auto reveal = NativeControlReadiness::revealCenter(target, [] { return qint64(0); }, 4000);
        QCOMPARE(reveal["ancestorCount"].toInt(), 8);
        QCOMPARE(reveal["scrollCount"].toInt(), 8);
        QCOMPARE(reveal["scrolls"].toList().size(), 6);
        QVERIFY(NativeControlReadiness::snapshot(target, &window)["ready"].toBool());
    }
    void memoryOldUnpinSuccessCannotCompleteEdit() {
        using Tracker = MemoryActionProbe::ReceiptTracker;
        Tracker tracker;
        const auto context = memoryContext();
        QVERIFY(tracker.arm(context.scope, "修改记忆", "wanted", "old-unpin", context.listId, context.candidateReadId));
        const auto old = memoryActionReceipt("old-unpin", "取消固定");
        const auto list = memoryReceipt(context.listId), candidates = memoryReceipt(context.candidateReadId);
        for (int poll = 0; poll < 3; ++poll)
            QCOMPARE(tracker.observe(context.scope, old, list, candidates), Tracker::WaitingForAction);
        QVERIFY(!tracker.complete());
        QVERIFY(tracker.requestId().isEmpty());
        const auto edited = memoryActionReceipt("new-edit");
        QCOMPARE(tracker.observe(context.scope, edited, list, candidates), Tracker::WaitingForReadback);
        QVERIFY(!tracker.matchesComplete(context.scope, edited, list, candidates));
        QCOMPARE(tracker.observe(context.scope, edited, memoryReceipt("list-after"), memoryReceipt("candidates-after")),
                 Tracker::Complete);
        QVERIFY(tracker.matchesComplete(context.scope, edited, memoryReceipt("list-after"), memoryReceipt("candidates-after")));
    }
    void memoryInputWaitsForTheCorrectVisibleStableRow_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"same-name-other-row", "clipped", "transparent", "disabled",
                                     "layout-moving", "same-frame", "under-40ms", "scroll-changing",
                                     "content-height-changing", "rounded-center-changing", "within-tolerance",
                                     "scope-changing", "list-receipt-changing", "candidate-receipt-changing", "clip-changing"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void memoryInputWaitsForTheCorrectVisibleStableRow() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 240);
        MemoryForm form(window);
        auto context = memoryContext();
        MemoryActionProbe::LayoutGate layout;
        Sequence sequence;
        qint64 now = 0; quint64 frame = 1;
        int inputs = 0;
        bool wrongTarget = false;
        const auto inspect = [&] { return MemoryActionProbe::inspect(&form.page, &window, "wanted", "memoryEditField", context); };
        const std::vector<Sequence::Action> actions{{"input", [&] {
            return MemoryActionProbe::rowControl(MemoryActionProbe::findRow(&form.page, "wanted"), "memoryEditField");
        }, [&](QQuickItem *item) {
            auto observation = inspect();
            wrongTarget = wrongTarget || item != &form.control || observation.control != item;
            return layout.observe(observation, now, frame);
        }, [&](QQuickItem *item) {
            const auto fresh = inspect();
            wrongTarget = wrongTarget || item != fresh.control || !layout.matches(fresh);
            ++inputs;
        }}};
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(inputs, 0);
        now = condition == "under-40ms" ? 39 : 40;
        frame = condition == "same-frame" ? 1 : 2;
        if (condition == "clipped") form.control.setX(250);
        if (condition == "transparent") form.control.setOpacity(.01);
        if (condition == "disabled") form.control.setEnabled(false);
        if (condition == "layout-moving") form.control.setY(15);
        if (condition == "scroll-changing") form.page.setProperty("contentY", 1.);
        if (condition == "content-height-changing") form.page.setProperty("contentHeight", 501.);
        if (condition == "scope-changing") context.scope = "persona:2:other";
        if (condition == "list-receipt-changing") context.listId = "replacement-list";
        if (condition == "candidate-receipt-changing") context.candidateReadId = "replacement-candidates";
        if (condition == "clip-changing") form.page.setWidth(249);
        // A sub-half-pixel move still resets when it changes the actual QTest point.
        if (condition == "rounded-center-changing") form.control.setX(5.5);
        if (condition == "within-tolerance") form.control.setX(5.4);
        const bool ready = condition == "same-name-other-row" || condition == "within-tolerance";
        QCOMPARE(sequence.poll(clock, 4000, actions), ready ? Sequence::Performed : Sequence::Waiting);
        QCOMPARE(inputs, ready ? 1 : 0);
        QVERIFY(!wrongTarget);
        if (condition == "same-frame" || condition == "under-40ms" || condition == "layout-moving") {
            now = 80; frame = 3;
            QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Performed);
            QCOMPARE(inputs, 1);
        }
    }
    void memoryRowsAreReacquiredAfterReorderReplacementAndDestruction() {
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, R"QML(
            import QtQuick
            Item {
                id: page
                width: 250; height: 210; clip: true
                property var rows: [{id: "wanted"}, {id: "other"}]
                Repeater {
                    model: page.rows
                    Item {
                        required property var modelData
                        required property int index
                        x: 10; y: 10 + index * 70; width: 180; height: 60
                        Item { objectName: "memoryEdit" + parent.index; x: 5; y: 5; width: 80; height: 30 }
                        Item { objectName: "memoryEditField"; x: 90; y: 5; width: 80; height: 30 }
                    }
                }
            }
        )QML", error);
        QVERIFY2(root, qPrintable(error));
        auto *page = qobject_cast<QQuickItem *>(root.get());
        QVERIFY(page);
        const auto first = MemoryActionProbe::findRow(page, "wanted");
        QVERIFY(first.valid()); QCOMPARE(first.index, 0);
        QVERIFY(MemoryActionProbe::rowControl(first, "memoryEdit"));
        QVERIFY(MemoryActionProbe::rowControl(first, "memoryEditField"));
        MemoryActionProbe::LayoutGate layout;
        const auto context = memoryContext();
        QVERIFY(!layout.observe(MemoryActionProbe::inspect(page, &window, "wanted", "memoryEditField", context), 0, 1)["ready"].toBool());
        QVERIFY(layout.observe(MemoryActionProbe::inspect(page, &window, "wanted", "memoryEditField", context), 40, 2)["ready"].toBool());
        page->setProperty("rows", QVariantList{QVariantMap{{"id", "other"}}, QVariantMap{{"id", "wanted"}}});
        QTRY_COMPARE(MemoryActionProbe::findRow(page, "wanted").index, 1);
        QTRY_VERIFY(first.item.isNull());
        QVERIFY(!MemoryActionProbe::rowControl(first, "memoryEditField"));
        const auto reordered = MemoryActionProbe::inspect(page, &window, "wanted", "memoryEditField", context);
        QVERIFY(!layout.matches(reordered));
        QVERIFY(!layout.observe(reordered, 80, 3)["ready"].toBool());
        QVERIFY(layout.observe(reordered, 120, 4)["ready"].toBool());
        const auto replaced = reordered.row;
        page->setProperty("rows", QVariantList{QVariantMap{{"id", "wanted"}}});
        QTRY_COMPARE(MemoryActionProbe::findRow(page, "wanted").index, 0);
        QTRY_VERIFY(replaced.item.isNull());
        auto live = MemoryActionProbe::findRow(page, "wanted");
        QVERIFY(live.valid());
        // Also exercise direct QVariantMap and QJSValue property reads.
        live.item->setProperty("modelData", QVariantMap{{"id", "wanted"}});
        QVERIFY(MemoryActionProbe::findRow(page, "wanted").valid());
        live.item->setProperty("modelData", QVariant::fromValue(engine.toScriptValue(QVariantMap{{"id", "wanted"}})));
        QVERIFY(MemoryActionProbe::findRow(page, "wanted").valid());
        QQuickItem duplicateControl(live.item);
        duplicateControl.setObjectName("memoryEditField"); duplicateControl.setSize({20, 20});
        QVERIFY(!MemoryActionProbe::rowControl(live, "memoryEditField"));
        duplicateControl.setParentItem(nullptr);
        duplicateControl.setParent(nullptr);
        page->setProperty("rows", QVariantList{QVariantMap{{"id", "wanted"}}, QVariantMap{{"id", "wanted"}}});
        QTRY_VERIFY(!MemoryActionProbe::findRow(page, "wanted").valid());
        page->setProperty("rows", QVariantList{});
        QTRY_VERIFY(!MemoryActionProbe::findRow(page, "wanted").valid());
        QTRY_VERIFY(live.item.isNull());
        QVERIFY(!layout.observe(MemoryActionProbe::inspect(page, &window, "wanted", "memoryEditField", context), 160, 5)["ready"].toBool());
    }
    void memoryWrongEditingIdentityCannotInputOrSave_data() {
        QTest::addColumn<QString>("controlName");
        QTest::newRow("wrong-edit-field") << QString("memoryEditField");
        QTest::newRow("wrong-edit-save") << QString("memoryEditSave");
        QTest::newRow("wrong-delete-confirm") << QString("memoryDeleteConfirm");
    }
    void memoryWrongEditingIdentityCannotInputOrSave() {
        QFETCH(QString, controlName);
        QQuickWindow window; window.resize(300, 240);
        MemoryForm form(window); form.control.setObjectName(controlName);
        auto context = memoryContext(); context.editingId = "other"; context.deletingId = "other";
        MemoryActionProbe::LayoutGate layout;
        Sequence sequence;
        qint64 now = 0; quint64 frame = 1;
        int inputs = 0;
        const std::vector<Sequence::Action> actions{{"identity-checked-input", [&] {
            return MemoryActionProbe::rowControl(MemoryActionProbe::findRow(&form.page, "wanted"), controlName);
        }, [&](QQuickItem *) {
            return layout.observe(MemoryActionProbe::inspect(&form.page, &window, "wanted", controlName, context), now, frame);
        }, [&](QQuickItem *) { ++inputs; }}};
        for (; now < 4000; now += 40, ++frame)
            QCOMPARE(sequence.poll([&] { return now; }, 4000, actions), Sequence::Waiting);
        QCOMPARE(sequence.poll([&] { return now; }, 4000, actions), Sequence::Expired);
        QCOMPARE(inputs, 0);
    }
    void memoryReceiptsRequireTheNewMatchingActionAndFollowingReads_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"wrong-subject", "wrong-verb", "wrong-scope", "two-new-actions",
                                     "reads-before-success", "fast-terminal", "late-old-action",
                                     "readback-id-changed", "readback-success-regressed"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void memoryReceiptsRequireTheNewMatchingActionAndFollowingReads() {
        QFETCH(QString, condition);
        using Tracker = MemoryActionProbe::ReceiptTracker;
        Tracker tracker;
        const auto context = memoryContext();
        QVERIFY(tracker.arm(context.scope, "修改记忆", "wanted", "old-unpin", context.listId, context.candidateReadId));
        auto action = memoryActionReceipt("edit-current", "修改记忆", "wanted", "pending");
        auto list = memoryReceipt(context.listId), candidates = memoryReceipt(context.candidateReadId);
        QString scope = context.scope;
        if (condition == "wrong-subject") action["subjectId"] = "other";
        if (condition == "wrong-verb") action["verb"] = "取消固定";
        if (condition == "wrong-scope") scope = "persona:2:other";
        if (condition.startsWith("wrong-")) {
            QCOMPARE(tracker.observe(scope, action, list, candidates), Tracker::Failed);
            QVERIFY(!tracker.complete()); return;
        }
        // A synchronous changed observer must retain all transitions even if
        // pending, success and both reads happen within the same timer tick.
        QObject notifier;
        int notices = 0;
        connect(&notifier, &QObject::objectNameChanged, &notifier, [&] {
            ++notices; tracker.observe(scope, action, list, candidates);
        });
        int serial = 0;
        const auto notify = [&] { notifier.setObjectName(QString::number(++serial)); };
        if (condition != "fast-terminal") notify();
        if (condition == "two-new-actions") {
            action["requestId"] = "second-edit"; notify();
            QVERIFY(tracker.failed()); QCOMPARE(tracker.metadata()["newActionCount"].toInt(), 2); return;
        }
        if (condition == "late-old-action") {
            action = memoryActionReceipt("old-unpin", "取消固定"); notify();
            QVERIFY(!tracker.complete());
            action = memoryActionReceipt("edit-current");
        }
        if (condition == "reads-before-success") {
            list = memoryReceipt("premature-list"); candidates = memoryReceipt("premature-candidates"); notify();
        }
        action["status"] = "success"; notify();
        QCOMPARE(tracker.observe(scope, action, list, candidates), Tracker::WaitingForReadback);
        list = memoryReceipt("list-after", "pending"); notify();
        candidates = memoryReceipt("candidates-after"); notify();
        QVERIFY(!tracker.complete());
        list["status"] = "success"; notify();
        QVERIFY(notices >= 4);
        QVERIFY(tracker.matchesComplete(scope, action, list, candidates));
        if (condition == "readback-id-changed") {
            list["requestId"] = "unrelated-list"; notify(); QVERIFY(tracker.failed());
        } else if (condition == "readback-success-regressed") {
            candidates["status"] = "pending"; notify(); QVERIFY(tracker.failed());
        } else if (condition == "late-old-action") {
            action = memoryActionReceipt("old-unpin", "取消固定"); notify(); QVERIFY(tracker.failed());
        } else {
            QVERIFY(tracker.complete());
        }
    }
    void memoryInputAndSaveRunOnceWithReentryOrFailure_data() {
        QTest::addColumn<bool>("throws");
        QTest::newRow("complete-once") << false;
        QTest::newRow("input-throws-no-retry") << true;
    }
    void memoryInputAndSaveRunOnceWithReentryOrFailure() {
        QFETCH(bool, throws);
        QQuickWindow window; window.resize(300, 240);
        MemoryForm form(window);
        QQuickItem save(&form.row); save.setObjectName("memoryEditSave"); save.setSize({70, 30}); save.setPosition({95, 5});
        const auto context = memoryContext();
        MemoryActionProbe::LayoutGate inputLayout, saveLayout;
        Sequence sequence;
        qint64 now = 0; quint64 frame = 1;
        int commits = 0, saves = 0, nestedCalls = 0;
        std::vector<Sequence::Action> actions;
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        const auto make = [&](const QString &control, MemoryActionProbe::LayoutGate &layout, bool input) {
            auto *layoutPointer = &layout;
            return Sequence::Action{control, [&, control] {
                return MemoryActionProbe::rowControl(MemoryActionProbe::findRow(&form.page, "wanted"), control);
            }, [&, control, layoutPointer](QQuickItem *) {
                return layoutPointer->observe(MemoryActionProbe::inspect(&form.page, &window, "wanted", control, context), now, frame);
            }, [&, control, layoutPointer, input](QQuickItem *item) {
                const auto fresh = MemoryActionProbe::inspect(&form.page, &window, "wanted", control, context);
                if (!layoutPointer->matches(fresh) || item != fresh.control) throw std::runtime_error("stale test target");
                ++nestedCalls;
                if (sequence.poll(clock, 4000, actions) != Sequence::Waiting) throw std::runtime_error("reentrant input");
                if (input) { ++commits; if (throws) throw std::runtime_error("fixture input failure"); }
                else ++saves;
            }};
        };
        actions.push_back(make("memoryEditField", inputLayout, true));
        actions.push_back(make("memoryEditSave", saveLayout, false));
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
        now = 40; frame = 2;
        if (throws) {
            QVERIFY_EXCEPTION_THROWN(sequence.poll(clock, 4000, actions), std::runtime_error);
            for (int poll = 0; poll < 3; ++poll) QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Failed);
            QCOMPARE(commits, 1); QCOMPARE(saves, 0); QCOMPARE(nestedCalls, 1); return;
        }
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
        now = 80; frame = 3;
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Performed);
        for (int poll = 0; poll < 3; ++poll) QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Performed);
        QCOMPARE(commits, 1); QCOMPARE(saves, 1); QCOMPARE(nestedCalls, 2);
    }
    void memoryInputUsesTheOriginalFourSecondDeadline_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"at-deadline", "inspection-crosses-deadline", "before-deadline", "scroll-exhausts-deadline"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void memoryInputUsesTheOriginalFourSecondDeadline() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 240);
        MemoryForm form(window);
        const auto context = memoryContext();
        MemoryActionProbe::LayoutGate layout;
        Sequence sequence;
        qint64 now = condition == "at-deadline" ? 4000 : 3999;
        int inputs = 0, inspections = 0;
        QQmlEngine engine;
        std::unique_ptr<QObject> scrollingRoot;
        QPointer<QQuickItem> target = &form.control;
        ReadinessExpiryProbe expiry; expiry.now = &now;
        if (condition == "scroll-exhausts-deadline") {
            QString error;
            scrollingRoot = createFixture(engine, window, nestedForm(), error);
            QVERIFY2(scrollingRoot, qPrintable(error));
            auto *inner = scrollingRoot->findChild<QQuickItem *>("inner");
            target = scrollingRoot->findChild<QQuickItem *>("body");
            QVERIFY(inner && target);
            QVERIFY(connect(inner, SIGNAL(contentYChanged()), &expiry, SLOT(expire())));
        }
        const auto observation = MemoryActionProbe::inspect(&form.page, &window, "wanted", "memoryEditField", context);
        layout.observe(observation, 0, 1); layout.observe(observation, 40, 2);
        const std::vector<Sequence::Action> actions{{"deadline-input", [&] { return target.data(); },
            [&](QQuickItem *) {
                ++inspections;
                auto state = layout.observe(MemoryActionProbe::inspect(&form.page, &window, "wanted", "memoryEditField", context), now, 3);
                if (condition == "inspection-crosses-deadline") now = 4000;
                return state;
            }, [&](QQuickItem *) { ++inputs; }}};
        const auto result = sequence.poll([&] { return now; }, 4000, actions);
        QCOMPARE(result, condition == "before-deadline" ? Sequence::Performed : Sequence::Expired);
        QCOMPARE(inputs, condition == "before-deadline" ? 1 : 0);
        if (condition == "at-deadline" || condition == "scroll-exhausts-deadline") QCOMPARE(inspections, 0);
        if (condition == "scroll-exhausts-deadline") QCOMPARE(expiry.calls, 1);
    }
    void memoryCompletionSurvivesFollowingControlReveal_data() {
        QTest::addColumn<QString>("verb");
        QTest::addColumn<QString>("nextControl");
        for (const auto &transition : completionTransitions())
            QTest::newRow(transition.name) << transition.verb << transition.nextControl;
    }
    void memoryCompletionSurvivesFollowingControlReveal() {
        QFETCH(QString, verb);
        QFETCH(QString, nextControl);
        CompletionScenario scenario(verb, nextControl);
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        QVERIFY(NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["ready"].toBool());
        QVERIFY(!scenario.completion.verified());
        QCOMPARE(scenario.poll(), Sequence::Waiting);
        QVERIFY(scenario.completion.verified());
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QCOMPARE(scenario.clicks, 0);
        QVERIFY(scenario.scroll->property("contentY").toDouble() > 0);
        QVERIFY(!NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["visible"].toBool());
        QVERIFY(NativeControlReadiness::snapshot(scenario.next, &scenario.window)["ready"].toBool());
        // The following control may also change the business state. The first
        // accepted snapshot is retained while receipt identity stays current.
        scenario.businessMatches = false;
        scenario.now = 40;
        scenario.inputReady = true;
        QCOMPARE(scenario.poll(), Sequence::Performed);
        scenario.now = 80;
        QCOMPARE(scenario.poll(), Sequence::Performed);
        QCOMPARE(scenario.identityChecks, 3);
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QCOMPARE(scenario.clicks, 1);
        const auto records = scenario.sequence.metadata()["actions"].toList();
        QCOMPARE(records.size(), 1);
        QCOMPARE(records[0].toMap()["name"].toString(), nextControl);
        QCOMPARE(records[0].toMap()["actionElapsedMs"].toLongLong(), 40);
    }
    void memoryCompletionRejectsFirstFeedbackFailure_data() {
        QTest::addColumn<QString>("verb");
        QTest::addColumn<QString>("nextControl");
        QTest::addColumn<QString>("condition");
        for (const auto &transition : completionTransitions())
            for (const auto *condition : {"clipped", "missing", "text-mismatch"}) {
                const auto name = QByteArray(transition.name) + '-' + condition;
                QTest::newRow(name.constData()) << transition.verb << transition.nextControl
                                               << QString::fromLatin1(condition);
            }
    }
    void memoryCompletionRejectsFirstFeedbackFailure() {
        QFETCH(QString, verb);
        QFETCH(QString, nextControl);
        QFETCH(QString, condition);
        CompletionScenario scenario(verb, nextControl);
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        if (condition == "clipped") {
            scenario.feedback->setY(100);
            // Its center still passes snapshot(); first acceptance must also
            // reject partial clipping of the receipt's full feedback bounds.
            QVERIFY(NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["ready"].toBool());
        } else if (condition == "missing") {
            delete scenario.feedback.data();
            QVERIFY(scenario.feedback.isNull());
        } else {
            scenario.feedback->setProperty("text", "UNRELATED_FIXTURE_FEEDBACK");
        }
        scenario.inputReady = true;
        QCOMPARE(scenario.poll(), Sequence::Failed);
        QVERIFY(!scenario.completion.verified());
        if (!scenario.feedback) {
            scenario.feedback = new QQuickItem(scenario.scroll);
            scenario.feedback->setSize({140, 30});
        }
        scenario.feedback->setPosition({8, 12});
        scenario.feedback->setProperty("text", "FIXTURE_COMPLETION_SUCCESS");
        QVERIFY(NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["ready"].toBool());
        for (int poll = 0; poll < 3; ++poll) QCOMPARE(scenario.poll(), Sequence::Failed);
        QCOMPARE(scenario.identityChecks, 1);
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QCOMPARE(scenario.targetLookups, 0);
        QCOMPARE(scenario.clicks, 0);
        QVERIFY(!scenario.completion.verified());
    }
    void memoryCompletionRejectsChangedReceiptAfterVerification_data() {
        QTest::addColumn<QString>("verb");
        QTest::addColumn<QString>("nextControl");
        QTest::addColumn<QString>("condition");
        for (const auto &transition : completionTransitions())
            for (const auto *condition : {"scope", "action-id", "action-status", "action-verb", "action-subject",
                                         "list-id", "list-status", "candidate-id", "candidate-status"}) {
                const auto name = QByteArray(transition.name) + '-' + condition;
                QTest::newRow(name.constData()) << transition.verb << transition.nextControl
                                               << QString::fromLatin1(condition);
            }
    }
    void memoryCompletionRejectsChangedReceiptAfterVerification() {
        QFETCH(QString, verb);
        QFETCH(QString, nextControl);
        QFETCH(QString, condition);
        CompletionScenario scenario(verb, nextControl);
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        QCOMPARE(scenario.poll(), Sequence::Waiting);
        QVERIFY(scenario.completion.verified());
        const auto scope = scenario.receipts.scope;
        const auto action = scenario.receipts.action, list = scenario.receipts.list, candidates = scenario.receipts.candidates;
        if (condition == "scope") scenario.receipts.scope = "unrelated-scope";
        if (condition == "action-id") scenario.receipts.action["requestId"] = "unrelated-action";
        if (condition == "action-status") scenario.receipts.action["status"] = "pending";
        if (condition == "action-verb") scenario.receipts.action["verb"] = "unrelated-verb";
        if (condition == "action-subject") scenario.receipts.action["subjectId"] = "unrelated-subject";
        if (condition == "list-id") scenario.receipts.list["requestId"] = "unrelated-list";
        if (condition == "list-status") scenario.receipts.list["status"] = "pending";
        if (condition == "candidate-id") scenario.receipts.candidates["requestId"] = "unrelated-candidates";
        if (condition == "candidate-status") scenario.receipts.candidates["status"] = "pending";
        QVERIFY(!scenario.receipts.matches());
        scenario.now = 40;
        scenario.inputReady = true;
        QCOMPARE(scenario.poll(), Sequence::Failed);
        QVERIFY(!scenario.completion.verified());
        scenario.receipts.scope = scope;
        scenario.receipts.action = action;
        scenario.receipts.list = list;
        scenario.receipts.candidates = candidates;
        QVERIFY(scenario.receipts.matches());
        QCOMPARE(scenario.poll(), Sequence::Failed);
        QCOMPARE(scenario.identityChecks, 2);
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QCOMPARE(scenario.targetLookups, 1);
        QCOMPARE(scenario.sequence.metadata()["polls"].toInt(), 1);
        QCOMPARE(scenario.clicks, 0);
    }
    void memoryNewActionCannotInheritPreviousCompletion() {
        CompletionScenario scenario("固定记忆", "memoryPin");
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        QCOMPARE(scenario.poll(), Sequence::Waiting);
        QVERIFY(scenario.completion.verified());
        QVERIFY(!NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["visible"].toBool());
        CompletionReceipts nextReceipts("取消固定", "next-action");
        MemoryActionProbe::CompletionGate nextCompletion;
        QVERIFY(nextReceipts.established && nextReceipts.matches());
        QVERIFY(nextReceipts.action["requestId"] != scenario.receipts.action["requestId"]);
        QVERIFY(!nextCompletion.verified());
        scenario.inputReady = true;
        QCOMPARE(scenario.poll(nextCompletion, nextReceipts), Sequence::Failed);
        QVERIFY(!nextCompletion.verified());
        QVERIFY(scenario.completion.verified());
        scenario.scroll->setProperty("contentY", 0.);
        QVERIFY(NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["ready"].toBool());
        QCOMPARE(scenario.poll(nextCompletion, nextReceipts), Sequence::Failed);
        QCOMPARE(scenario.validationCalls, 2);
        QCOMPARE(scenario.feedbackInspections, 2);
        QCOMPARE(scenario.clicks, 0);
    }
    void memoryCompletionExceptionAndReentryCannotRetry_data() {
        QTest::addColumn<QString>("fault");
        QTest::addColumn<bool>("verifiedFirst");
        QTest::newRow("identity-throws") << QString("identity-throws") << false;
        QTest::newRow("validation-throws") << QString("validation-throws") << false;
        QTest::newRow("identity-reentry") << QString("identity-reentry") << false;
        QTest::newRow("validation-reentry") << QString("validation-reentry") << false;
        QTest::newRow("verified-identity-throws") << QString("identity-throws") << true;
        QTest::newRow("verified-identity-reentry") << QString("identity-reentry") << true;
    }
    void memoryCompletionExceptionAndReentryCannotRetry() {
        QFETCH(QString, fault);
        QFETCH(bool, verifiedFirst);
        CompletionScenario scenario("固定记忆", "memoryPin");
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        if (verifiedFirst) {
            QCOMPARE(scenario.poll(), Sequence::Waiting);
            QVERIFY(scenario.completion.verified());
        }
        bool nestedResult = true;
        int nestedCallbacks = 0;
        const auto reenter = [&] {
            nestedResult = scenario.completion.verify(
                [&] { ++nestedCallbacks; return true; }, [&] { ++nestedCallbacks; return true; });
            return true; // Even an outer callback ignoring the rejection cannot seal.
        };
        const auto throwing = []() -> bool { throw std::runtime_error("fixture completion failure"); };
        if (fault.startsWith("identity")) {
            if (fault.endsWith("throws")) scenario.identityStillMatches = throwing;
            else scenario.identityStillMatches = reenter;
        } else {
            if (fault.endsWith("throws")) scenario.firstValidation = throwing;
            else scenario.firstValidation = reenter;
        }
        if (fault.endsWith("throws")) {
            QVERIFY_EXCEPTION_THROWN(scenario.poll(), std::runtime_error);
        } else {
            QCOMPARE(scenario.poll(), Sequence::Failed);
            QVERIFY(!nestedResult);
            QCOMPARE(nestedCallbacks, 0);
        }
        QVERIFY(!scenario.completion.verified());
        QCOMPARE(scenario.validationCalls, verifiedFirst || fault.startsWith("validation") ? 1 : 0);
        const int identityChecks = scenario.identityChecks, validationCalls = scenario.validationCalls;
        for (int poll = 0; poll < 3; ++poll) QCOMPARE(scenario.poll(), Sequence::Failed);
        QCOMPARE(scenario.identityChecks, identityChecks);
        QCOMPARE(scenario.validationCalls, validationCalls);
        QCOMPARE(scenario.clicks, 0);
    }
    void memoryCompletionKeepsTheOriginalFourSecondDeadline_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"at-deadline", "validation-crosses-deadline",
                                     "waiting-crosses-deadline", "scroll-crosses-deadline"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void memoryCompletionKeepsTheOriginalFourSecondDeadline() {
        QFETCH(QString, condition);
        CompletionScenario scenario("取消固定", "memoryEdit");
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.scroll);
        QVERIFY(scenario.receipts.established && scenario.receipts.matches());
        scenario.now = condition == "at-deadline" ? 4000 : 3999;
        ReadinessExpiryProbe expiry;
        expiry.now = &scenario.now;
        if (condition == "validation-crosses-deadline") {
            scenario.firstValidation = [&] {
                const bool valid = scenario.validateFeedback();
                scenario.now = 4000;
                return valid;
            };
        }
        if (condition == "scroll-crosses-deadline")
            QVERIFY(connect(scenario.scroll, SIGNAL(contentYChanged()), &expiry, SLOT(expire())));
        if (condition == "waiting-crosses-deadline") {
            QCOMPARE(scenario.poll(), Sequence::Waiting);
            QVERIFY(!NativeControlReadiness::snapshot(scenario.feedback, &scenario.window)["visible"].toBool());
            scenario.now = 4000;
        }
        scenario.inputReady = true;
        QCOMPARE(scenario.poll(), Sequence::Expired);
        QCOMPARE(scenario.now, 4000);
        QVERIFY(scenario.completion.verified());
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QCOMPARE(scenario.clicks, 0);
        if (condition == "at-deadline" || condition == "validation-crosses-deadline")
            QCOMPARE(scenario.targetLookups, 0);
        if (condition == "scroll-crosses-deadline") {
            QCOMPARE(expiry.calls, 1);
            QCOMPARE(scenario.inspections, 0);
        }
        const auto records = scenario.sequence.metadata()["actions"].toList();
        for (const auto &record : records) {
            QVERIFY(!record.toMap()["attempted"].toBool());
            QCOMPARE(record.toMap()["actionElapsedMs"].toLongLong(), -1);
        }
        const int lookups = scenario.targetLookups, inspections = scenario.inspections;
        scenario.now = 8000;
        QCOMPARE(scenario.poll(), Sequence::Expired);
        QCOMPARE(scenario.targetLookups, lookups);
        QCOMPARE(scenario.inspections, inspections);
        QCOMPARE(scenario.validationCalls, 1);
        QCOMPARE(scenario.clicks, 0);
        QVERIFY(scenario.sequence.metadata()["expired"].toBool());
    }
    void memoryDiagnosticsKeepSixProcessSamplesAndOneTextFreeTerminal() {
        QQuickWindow window; window.resize(300, 240);
        MemoryForm form(window);
        MemoryActionProbe::LayoutGate layout;
        MemoryActionProbe::BoundedDiagnostic diagnostic;
        const auto context = memoryContext();
        MemoryActionProbe::ReceiptTracker tracker;
        QVERIFY(tracker.arm(context.scope, "修改记忆", "wanted", "old", context.listId, context.candidateReadId));
        const auto invalidAction = memoryActionReceipt("new", "修改记忆", "wanted", "PRIVATE_UNKNOWN_STATUS");
        QCOMPARE(tracker.observe(context.scope, invalidAction, memoryReceipt(context.listId), memoryReceipt(context.candidateReadId)),
                 MemoryActionProbe::ReceiptTracker::Failed);
        QCOMPARE(tracker.metadata()["status"].toString(), QString("invalid"));
        for (int poll = 0; poll < 40; ++poll) {
            auto state = layout.observe(MemoryActionProbe::inspect(&form.page, &window, "wanted", "memoryEditField", context), poll * 40, poll + 1);
            state["text"] = "PRIVATE_MEMORY_BODY";
            state["source"] = "PRIVATE_MEMORY_SOURCE";
            state["status"] = "PRIVATE_TOP_STATUS";
            state["clipX"] = std::numeric_limits<double>::infinity();
            auto receipt = tracker.metadata(); receipt["text"] = "PRIVATE_RECEIPT_BODY";
            state["receipt"] = receipt;
            state["layout"] = layout.metadata();
            state["sequence"] = QVariantMap{{"performed", false}, {"samples", QVariantList{QVariantMap{{"text", "PRIVATE_NESTED_BODY"}}}}};
            state["feedbackValidation"] = QVariantMap{{"phase", "first-validation"},
                {"requestId", "new"}, {"scope", context.scope}, {"found", true}, {"visible", true},
                {"enabled", true}, {"textMatches", true}, {"fullyVisible", true}, {"validated", true},
                {"sceneX", 10}, {"sceneY", 20}, {"sceneWidth", 80}, {"sceneHeight", 30},
                {"clipX", 10}, {"clipY", 20}, {"clipWidth", 80}, {"clipHeight", 30},
                {"textLength", 24}, {"expectedLength", 24}, {"elapsedMs", poll * 40}, {"frameSerial", poll + 1},
                {"text", "PRIVATE_FEEDBACK_TEXT"}, {"source", "PRIVATE_FEEDBACK_SOURCE"},
                {"unexpected", "PRIVATE_FEEDBACK_EXTRA"}};
            diagnostic.observe(state);
            if (poll == 39) diagnostic.terminal(state);
        }
        diagnostic.terminal({{"rowId", "must-not-overwrite-terminal"}});
        const auto metadata = diagnostic.metadata();
        QCOMPARE(metadata["samples"].toList().size(), 6);
        QCOMPARE(metadata["observations"].toInt(), 40);
        QCOMPARE(metadata["terminalCount"].toInt(), 1);
        QCOMPARE(metadata["terminal"].toMap()["rowId"].toString(), QString("wanted"));
        const auto feedback = metadata["terminal"].toMap()["feedbackValidation"].toMap();
        QCOMPARE(feedback["phase"].toString(), QString("first-validation"));
        QCOMPARE(feedback["requestId"].toString(), QString("new"));
        QCOMPARE(feedback["scope"].toString(), context.scope);
        for (const auto *key : {"found", "visible", "enabled", "textMatches", "fullyVisible", "validated"})
            QVERIFY(feedback.value(key).toBool());
        for (const auto *key : {"sceneX", "sceneY", "sceneWidth", "sceneHeight", "clipX", "clipY", "clipWidth", "clipHeight"})
            QVERIFY(feedback.contains(key));
        QCOMPARE(feedback["textLength"].toInt(), 24);
        QCOMPARE(feedback["expectedLength"].toInt(), 24);
        QCOMPARE(feedback["elapsedMs"].toInt(), 1560);
        QCOMPARE(feedback["frameSerial"].toInt(), 40);
        const auto json = QJsonDocument::fromVariant(metadata).toJson(QJsonDocument::Compact);
        QVERIFY(!json.contains("PRIVATE_"));
        QVERIFY(!json.contains("\"text\""));
        QVERIFY(!json.contains("\"source\""));
        QVERIFY(!json.contains("must-not-overwrite-terminal"));
        QVERIFY(json.size() < 30000);
        MemoryActionProbe::BoundedDiagnostic invalidPhase;
        invalidPhase.terminal({{"feedbackValidation", QVariantMap{{"phase", "PRIVATE_FEEDBACK_PHASE"}}}});
        QCOMPARE(invalidPhase.metadata()["terminal"].toMap()["feedbackValidation"].toMap()["phase"].toString(),
                 QString("invalid"));
        QVERIFY(!QJsonDocument::fromVariant(invalidPhase.metadata()).toJson().contains("PRIVATE_"));
    }
    void summaryControlEligibility_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"ready", "missing", "hidden", "disabled", "opacity", "surface",
                                     "center-clipped", "integer-clipped", "foreign-window", "empty-scope", "zero-size"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryControlEligibility() {
        QFETCH(QString, condition);
        QQuickWindow window, otherWindow;
        window.resize(300, 200); otherWindow.resize(300, 200);
        QQuickItem panel(window.contentItem()), control(&panel);
        panel.setSize({180, 120}); panel.setClip(true);
        control.setPosition({10, 20}); control.setSize({80, 30});
        QQuickItem *target = &control;
        QString scope = "persona:summary";
        bool surface = true;
        if (condition == "missing") target = nullptr;
        if (condition == "hidden") control.setVisible(false);
        if (condition == "disabled") control.setEnabled(false);
        if (condition == "opacity") panel.setOpacity(.01);
        if (condition == "surface") surface = false;
        if (condition == "center-clipped") control.setY(110);
        if (condition == "integer-clipped") {
            panel.setHeight(119.8); control.setY(104.6);
            QVERIFY(NativeControlReadiness::snapshot(&control, &window)["inputPointInsideClip"].toBool());
        }
        if (condition == "foreign-window") control.setParentItem(otherWindow.contentItem());
        if (condition == "empty-scope") scope.clear();
        if (condition == "zero-size") control.setWidth(0);
        const auto observation = SummaryInteractionProbe::inspect(target, &window, surface, scope);
        QCOMPARE(observation.eligible, condition == "ready");
        QCOMPARE(observation.state.value("ready").toBool(), condition == "ready");
        SummaryInteractionProbe::StableGate stable;
        stable.observe(observation, 0, 1);
        QCOMPARE(stable.observe(observation, 40, 2).value("ready").toBool(), condition == "ready");
        QCOMPARE(stable.matches(observation), condition == "ready");
    }
    void summaryControlNeedsTimeAndAPresentedFrame_data() {
        QTest::addColumn<int>("elapsed");
        QTest::addColumn<quint64>("frame");
        QTest::addColumn<bool>("ready");
        QTest::newRow("same-frame") << 40 << quint64(1) << false;
        QTest::newRow("under-forty-ms") << 39 << quint64(2) << false;
        QTest::newRow("new-frame-after-forty-ms") << 40 << quint64(2) << true;
    }
    void summaryControlNeedsTimeAndAPresentedFrame() {
        QFETCH(int, elapsed); QFETCH(quint64, frame); QFETCH(bool, ready);
        QQuickWindow window; window.resize(300, 200);
        QQuickItem control(window.contentItem()); control.setSize({80, 30});
        const auto observation = SummaryInteractionProbe::inspect(&control, &window, true, "persona:summary");
        QVERIFY(observation.eligible);
        SummaryInteractionProbe::StableGate stable;
        QVERIFY(!stable.observe(observation, 0, 1).value("ready").toBool());
        QCOMPARE(stable.observe(observation, elapsed, frame).value("ready").toBool(), ready);
        QCOMPARE(stable.matches(observation), ready);
    }
    void summaryControlRejectsChangedFreshTarget_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"scope", "object", "scene", "clip", "scroll", "integer-point", "destroyed"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryControlRejectsChangedFreshTarget() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 200);
        QQuickItem panel(window.contentItem()), replacement(&panel);
        panel.setSize({180, 120}); panel.setClip(true);
        panel.setProperty("contentY", 0.); panel.setProperty("contentHeight", 600.);
        auto control = std::make_unique<QQuickItem>(&panel);
        control->setPosition({10.2, 20}); control->setSize({80, 30});
        replacement.setPosition(control->position()); replacement.setSize(control->size());
        QQuickItem *target = control.get();
        QString scope = "persona:summary";
        const auto initial = SummaryInteractionProbe::inspect(target, &window, true, scope);
        QVERIFY(initial.eligible);
        SummaryInteractionProbe::StableGate stable;
        stable.observe(initial, 0, 1);
        QVERIFY(stable.observe(initial, 40, 2).value("ready").toBool());
        QVERIFY(stable.matches(initial));
        if (condition == "scope") scope = "other-persona:summary";
        if (condition == "object") target = &replacement;
        if (condition == "scene") control->setY(22);
        if (condition == "clip") panel.setWidth(70);
        if (condition == "scroll") panel.setProperty("contentY", 1.);
        if (condition == "integer-point") control->setX(10.6);
        if (condition == "destroyed") { control.reset(); target = nullptr; }
        const auto fresh = SummaryInteractionProbe::inspect(target, &window, true, scope);
        QVERIFY(!stable.matches(fresh));
        QVERIFY(!stable.observe(fresh, 80, 3).value("ready").toBool());
    }
    void summaryControlAllowsOnlySubpixelToleranceAndResetsOnClockRegression_data() {
        QTest::addColumn<QString>("condition");
        QTest::newRow("subpixel-with-same-integer-point") << QString("subpixel");
        QTest::newRow("elapsed-regression") << QString("elapsed");
        QTest::newRow("frame-regression") << QString("frame");
    }
    void summaryControlAllowsOnlySubpixelToleranceAndResetsOnClockRegression() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 200);
        QQuickItem control(window.contentItem()); control.setPosition({10.2, 20}); control.setSize({80, 30});
        SummaryInteractionProbe::StableGate stable;
        const auto initial = SummaryInteractionProbe::inspect(&control, &window, true, "persona:summary");
        stable.observe(initial, 0, 1);
        QVERIFY(stable.observe(initial, 40, 2).value("ready").toBool());
        if (condition == "subpixel") {
            control.setX(10.4);
            const auto fresh = SummaryInteractionProbe::inspect(&control, &window, true, "persona:summary");
            QCOMPARE(fresh.point, initial.point);
            QVERIFY(stable.matches(fresh));
        } else {
            const auto elapsed = condition == "elapsed" ? -1 : 80;
            const auto frame = condition == "frame" ? quint64(0) : quint64(3);
            QVERIFY(!stable.observe(initial, elapsed, frame).value("ready").toBool());
            QVERIFY(!stable.matches(initial));
            QVERIFY(stable.observe(initial, 120, 4).value("ready").toBool());
        }
    }
    void summaryStableInputRetainsSequenceReentryAndFailureLatches_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"ordinary", "reentry", "throw-after-input"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryStableInputRetainsSequenceReentryAndFailureLatches() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 200);
        QQuickItem control(window.contentItem()); control.setSize({80, 30});
        Sequence sequence;
        SummaryInteractionProbe::StableGate stable;
        qint64 now = 0;
        quint64 frame = 1;
        int inputs = 0, nestedCallbacks = 0;
        std::vector<Sequence::Action> actions;
        const NativeControlReadiness::ElapsedClock clock = [&] { return now; };
        actions.push_back({"summary-tab",
            [&] { return &control; },
            [&](QQuickItem *target) {
                return stable.observe(SummaryInteractionProbe::inspect(target, &window, true, "persona:summary"), now, frame);
            }, [&](QQuickItem *target) {
                QVERIFY(stable.matches(SummaryInteractionProbe::inspect(target, &window, true, "persona:summary")));
                ++inputs;
                if (condition == "reentry") {
                    ++nestedCallbacks;
                    QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
                }
                if (condition == "throw-after-input") throw std::runtime_error("fixture summary dispatch failure");
            }});
        QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Waiting);
        QCOMPARE(inputs, 0);
        now = 40; frame = 2;
        if (condition == "throw-after-input") {
            QVERIFY_EXCEPTION_THROWN(sequence.poll(clock, 4000, actions), std::runtime_error);
            QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Failed);
        } else {
            QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Performed);
            now = 80; frame = 3;
            QCOMPARE(sequence.poll(clock, 4000, actions), Sequence::Performed);
        }
        QCOMPARE(inputs, 1);
        QCOMPARE(nestedCallbacks, condition == "reentry" ? 1 : 0);
    }
    void summaryStableInputUsesTheOriginalAbsoluteDeadline_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"at-deadline", "inspection-crosses-deadline", "scroll-crosses-deadline"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryStableInputUsesTheOriginalAbsoluteDeadline() {
        QFETCH(QString, condition);
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, nestedForm(), error);
        QVERIFY2(root, qPrintable(error));
        auto *inner = root->findChild<QQuickItem *>("inner");
        auto *target = root->findChild<QQuickItem *>("body");
        QVERIFY(inner && target);
        qint64 now = 0;
        NativeControlReadiness::revealCenter(target, [&] { return now; }, 4000);
        SummaryInteractionProbe::StableGate stable;
        const auto initial = SummaryInteractionProbe::inspect(target, &window, true, "persona:summary");
        QVERIFY(initial.eligible);
        stable.observe(initial, 0, 1);
        ReadinessExpiryProbe expiry; expiry.now = &now;
        if (condition == "scroll-crosses-deadline") {
            inner->setProperty("contentY", 0.);
            QVERIFY(connect(inner, SIGNAL(contentYChanged()), &expiry, SLOT(expire())));
        }
        now = condition == "at-deadline" ? 4000 : 3999;
        int inspections = 0, inputs = 0;
        Sequence sequence;
        const std::vector<Sequence::Action> actions{{"summary-tab", [&] { return target; },
            [&](QQuickItem *item) {
                ++inspections;
                auto state = stable.observe(SummaryInteractionProbe::inspect(item, &window, true, "persona:summary"), now, 2);
                if (condition == "inspection-crosses-deadline") now = 4000;
                return state;
            }, [&](QQuickItem *) { ++inputs; }}};
        QCOMPARE(sequence.poll([&] { return now; }, 4000, actions), Sequence::Expired);
        QCOMPARE(inputs, 0);
        QCOMPARE(inspections, condition == "inspection-crosses-deadline" ? 1 : 0);
        if (condition == "scroll-crosses-deadline") QCOMPARE(expiry.calls, 1);
        const auto metadata = sequence.metadata();
        for (const auto &value : metadata.value("actions").toList())
            QVERIFY(!value.toMap().value("attempted").toBool());
        now = 8000;
        QCOMPARE(sequence.poll([&] { return now; }, 4000, actions), Sequence::Expired);
        QCOMPARE(inputs, 0);
    }
    void summaryReceiptAcceptsOnlyItsSaveAndFollowingRead_data() {
        QTest::addColumn<bool>("expected");
        QTest::addColumn<bool>("fast");
        QTest::addColumn<bool>("emptyBaseline");
        for (bool expected : {false, true})
            for (bool fast : {false, true})
                for (bool empty : {false, true}) {
                    const auto name = QString("%1-%2-%3").arg(expected ? "enabled" : "disabled",
                        fast ? "fast-terminal" : "pending-observed", empty ? "first-save" : "existing-baseline").toLatin1();
                    QTest::newRow(name.constData()) << expected << fast << empty;
                }
    }
    void summaryReceiptAcceptsOnlyItsSaveAndFollowingRead() {
        QFETCH(bool, expected); QFETCH(bool, fast); QFETCH(bool, emptyBaseline);
        using Tracker = SummaryInteractionProbe::ReceiptTracker;
        Tracker tracker;
        const QString scope = "persona:summary", oldSave = emptyBaseline ? QString() : QString("old-save"),
                      oldRead = emptyBaseline ? QString() : QString("old-read");
        QVERIFY(tracker.arm(scope, 7, expected, oldSave, oldRead));
        QVariantMap save{{"requestId", oldSave}, {"status", "success"}, {"enabled", expected}};
        QVariantMap read{{"requestId", oldRead}, {"status", "success"}, {"sourceSaveId", oldSave}, {"command", "summary:status"}};
        const QVariantMap summary{{"ok", true}, {"status", expected ? "ready" : "disabled"}, {"enabled", expected}};
        QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::WaitingForSave);
        QVERIFY(!tracker.complete());
        save = {{"requestId", "current-save"}, {"status", fast ? "success" : "pending"}, {"enabled", expected}};
        if (!fast) {
            QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::WaitingForSave);
            save["status"] = "success";
            QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::WaitingForReadback);
        }
        read = {{"requestId", "current-read"}, {"status", fast ? "success" : "pending"},
                {"sourceSaveId", "current-save"}, {"command", "summary:status"}};
        if (!fast) {
            QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::WaitingForReadback);
            QVERIFY(!tracker.complete());
            read["status"] = "success";
        }
        QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::Complete);
        QVERIFY(tracker.matchesComplete(scope, 7, save, read, summary));
        // This is the bridge's normal cleanup of the saved feedback projection.
        save.remove("enabled");
        QVERIFY(tracker.matchesComplete(scope, 7, save, read, summary));
        QCOMPARE(tracker.observe(scope, 7, save, read, summary), Tracker::Complete);
        QCOMPARE(tracker.metadata().value("newSaveCount").toInt(), 1);
        QCOMPARE(tracker.metadata().value("newReadCount").toInt(), 1);
    }
    void summaryReceiptRejectsUnrelatedFailedOrInconsistentEvidence_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"save-error", "save-unknown", "saved-string", "saved-opposite", "read-error", "read-unknown",
                                     "read-binding", "read-command", "read-string", "read-opposite", "summary-error", "missing-status",
                                     "summary-ok-string", "scope", "generation", "new-save", "new-read", "old-save", "old-read",
                                     "read-same-as-save", "missing-source-save", "save-regressed-pending", "read-regressed-pending"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryReceiptRejectsUnrelatedFailedOrInconsistentEvidence() {
        QFETCH(QString, condition);
        using Tracker = SummaryInteractionProbe::ReceiptTracker;
        Tracker tracker;
        QString scope = "persona:summary"; qint64 generation = 7;
        QVERIFY(tracker.arm(scope, generation, true, "old-save", "old-read"));
        QVariantMap save{{"requestId", "current-save"}, {"status", "success"}, {"enabled", true}};
        QVariantMap read{{"requestId", "current-read"}, {"status", "pending"},
                         {"sourceSaveId", "current-save"}, {"command", "summary:status"}};
        QVariantMap summary{{"ok", true}, {"status", "ready"}, {"enabled", true}};
        QCOMPARE(tracker.observe(scope, generation, save, read, summary), Tracker::WaitingForReadback);
        read["status"] = "success";
        if (condition == "save-regressed-pending" || condition == "read-regressed-pending")
            QCOMPARE(tracker.observe(scope, generation, save, read, summary), Tracker::Complete);
        if (condition == "save-error") save["status"] = "error";
        if (condition == "save-unknown") save["status"] = "unknown";
        if (condition == "saved-string") save["enabled"] = "true";
        if (condition == "saved-opposite") save["enabled"] = false;
        if (condition == "read-error") read["status"] = "error";
        if (condition == "read-unknown") read["status"] = "unknown";
        if (condition == "read-binding") read["sourceSaveId"] = "unrelated-save";
        if (condition == "read-command") read["command"] = "memory:list";
        if (condition == "read-string") summary["enabled"] = "true";
        if (condition == "read-opposite") summary["enabled"] = false;
        if (condition == "summary-error") summary["ok"] = false;
        if (condition == "missing-status") summary.remove("status");
        if (condition == "summary-ok-string") summary["ok"] = "true";
        if (condition == "scope") scope = "other-persona:summary";
        if (condition == "generation") ++generation;
        if (condition == "new-save") save["requestId"] = "unrelated-save";
        if (condition == "new-read") read["requestId"] = "unrelated-read";
        if (condition == "old-save") save["requestId"] = "old-save";
        if (condition == "old-read") read["requestId"] = "old-read";
        if (condition == "read-same-as-save") read["requestId"] = "current-save";
        if (condition == "missing-source-save") read.remove("sourceSaveId");
        if (condition == "save-regressed-pending") save["status"] = "pending";
        if (condition == "read-regressed-pending") read["status"] = "pending";
        QCOMPARE(tracker.observe(scope, generation, save, read, summary), Tracker::Failed);
        QVERIFY(tracker.failed()); QVERIFY(!tracker.complete()); QVERIFY(!tracker.failureReason().isEmpty());
        save = {{"requestId", "current-save"}, {"status", "success"}, {"enabled", true}};
        read = {{"requestId", "current-read"}, {"status", "success"},
                {"sourceSaveId", "current-save"}, {"command", "summary:status"}};
        summary = {{"ok", true}, {"status", "ready"}, {"enabled", true}};
        QCOMPARE(tracker.observe("persona:summary", 7, save, read, summary), Tracker::Failed);
        QVERIFY(!tracker.matchesComplete("persona:summary", 7, save, read, summary));
    }
    void summaryReadFailureIsDistinctFromTheServicesOperationalStatus_data() {
        QTest::addColumn<QString>("status");
        QTest::newRow("background-failed") << QString("failed");
        QTest::newRow("background-outcome-unknown") << QString("outcome_unknown");
    }
    void summaryReadFailureIsDistinctFromTheServicesOperationalStatus() {
        QFETCH(QString, status);
        using Tracker = SummaryInteractionProbe::ReceiptTracker;
        Tracker tracker;
        QVERIFY(tracker.arm("persona:summary", 7, true, {}, {}));
        const QVariantMap save{{"requestId", "current-save"}, {"status", "success"}, {"enabled", true}},
            read{{"requestId", "current-read"}, {"status", "success"}, {"sourceSaveId", "current-save"}, {"command", "summary:status"}},
            summary{{"ok", true}, {"status", status}, {"enabled", true}};
        QCOMPARE(tracker.observe("persona:summary", 7, save, read, summary), Tracker::Complete);
        QVERIFY(tracker.matchesComplete("persona:summary", 7, save, read, summary));
    }
    void summaryReceiptCannotArmAnInvalidOrRepeatedOperation_data() {
        QTest::addColumn<QString>("condition");
        for (const auto *condition : {"empty-scope", "negative-generation", "rearm"})
            QTest::newRow(condition) << QString::fromLatin1(condition);
    }
    void summaryReceiptCannotArmAnInvalidOrRepeatedOperation() {
        QFETCH(QString, condition);
        SummaryInteractionProbe::ReceiptTracker tracker;
        if (condition == "rearm") QVERIFY(tracker.arm("persona:summary", 7, true, {}, {}));
        QVERIFY(!tracker.arm(condition == "empty-scope" ? QString() : QString("persona:summary"),
                             condition == "negative-generation" ? -1 : 7, true, {}, {}));
        QVERIFY(tracker.failed()); QVERIFY(!tracker.complete());
    }
    void summaryRevealDoesNotRevalidateSealedMemoryFeedback() {
        CompletionScenario scenario("删除记忆", "memoryTab-summary");
        QVERIFY2(scenario.root, qPrintable(scenario.error));
        QVERIFY(scenario.feedback && scenario.next && scenario.receipts.established);
        QVERIFY(scenario.completion.verify([&] { return scenario.receipts.matches(); }, [&] { return scenario.validateFeedback(); }));
        QCOMPARE(scenario.feedbackInspections, 1);
        SummaryInteractionProbe::StableGate stable;
        Sequence sequence;
        quint64 frame = 1;
        const std::vector<Sequence::Action> actions{{"summary-tab", [&] { return scenario.next.data(); },
            [&](QQuickItem *item) {
                return stable.observe(SummaryInteractionProbe::inspect(item, &scenario.window, true, scenario.receipts.scope), scenario.now, frame);
            }, [&](QQuickItem *item) {
                QVERIFY(stable.matches(SummaryInteractionProbe::inspect(item, &scenario.window, true, scenario.receipts.scope)));
                ++scenario.clicks;
            }}};
        QCOMPARE(sequence.poll([&] { return scenario.now; }, 4000, actions), Sequence::Waiting);
        QVERIFY(!NativeControlReadiness::snapshot(scenario.feedback, &scenario.window).value("visible").toBool());
        scenario.now = 40; frame = 2;
        QVERIFY(scenario.completion.verify([&] { return scenario.receipts.matches(); }, [&] { return scenario.validateFeedback(); }));
        QCOMPARE(sequence.poll([&] { return scenario.now; }, 4000, actions), Sequence::Performed);
        QCOMPARE(sequence.poll([&] { return scenario.now; }, 4000, actions), Sequence::Performed);
        QCOMPARE(scenario.clicks, 1);
        QCOMPARE(scenario.feedbackInspections, 1);
        QVERIFY(scenario.completion.verified());
    }
    void summaryDiagnosticsKeepBoundedTextFreeSelectionAndReceiptEvidence() {
        SummaryInteractionProbe::BoundedDiagnostic diagnostic;
        for (int i = 0; i < 40; ++i) {
            const QVariantMap state{{"scope", "persona:summary"}, {"control", "summaryEnabled"}, {"phase", "save-readback"},
                {"currentIndex", 1}, {"expectedIndex", 1}, {"accented", true}, {"selected", true}, {"clickCount", 1},
                {"checked", QVariant{}}, {"stateEnabled", QVariant{}}, {"feedbackEnabled", QVariant{}}, {"shownValue", QVariant{}},
                {"stateEnabledKnown", false}, {"feedbackEnabledKnown", false}, {"stateOk", QVariant{}}, {"tabClicked", true},
                {"stateStatus", "failed"}, {"feedbackStatus", "none"}, {"readAt", 80}, {"clickAt", 40},
                {"terminalElapsedMs", i * 40}, {"stepAt", 20}, {"requestCountDelta", 1}, {"readFrameSerial", 2}, {"lastResponseFrame", 3},
                {"elapsedMs", i * 40}, {"frameSerial", i + 1}, {"sceneX", std::numeric_limits<double>::infinity()},
                {"text", "PRIVATE_SUMMARY_TEXT"}, {"source", "PRIVATE_SOURCE"},
                {"receipt", QVariantMap{{"saveId", "current-save"}, {"readId", "current-read"}, {"expected", true},
                    {"complete", true}, {"text", "PRIVATE_RECEIPT_TEXT"}, {"status", "PRIVATE_UNKNOWN_STATUS"}}},
                {"sequence", QVariantMap{{"performed", true}, {"actions", QVariantList{QVariantMap{
                    {"name", "summary-tab"}, {"attempted", true}, {"performed", true}, {"actionElapsedMs", 40},
                    {"text", "PRIVATE_ACTION_TEXT"}}}}}}};
            diagnostic.observe(state);
            if (i == 39) diagnostic.terminal(state);
        }
        diagnostic.terminal({{"control", "must-not-replace-terminal"}});
        const auto metadata = diagnostic.metadata();
        QCOMPARE(metadata.value("samples").toList().size(), 6);
        QCOMPARE(metadata.value("observations").toInt(), 40);
        QCOMPARE(metadata.value("terminalCount").toInt(), 1);
        const auto terminal = metadata.value("terminal").toMap();
        QCOMPARE(terminal.value("currentIndex").toInt(), 1);
        QCOMPARE(terminal.value("expectedIndex").toInt(), 1);
        QCOMPARE(terminal.value("clickCount").toInt(), 1);
        QVERIFY(terminal.value("selected").toBool() && terminal.value("accented").toBool());
        for (const auto *key : {"checked", "stateEnabled", "feedbackEnabled", "shownValue", "stateOk"}) {
            QVERIFY(terminal.contains(key)); QVERIFY(terminal.value(key).isNull());
        }
        QVERIFY(terminal.value("tabClicked").toBool());
        QVERIFY(!terminal.value("stateEnabledKnown").toBool() && !terminal.value("feedbackEnabledKnown").toBool());
        QCOMPARE(terminal.value("stateStatus").toString(), QString("failed"));
        QCOMPARE(terminal.value("feedbackStatus").toString(), QString("none"));
        for (const auto *key : {"readAt", "clickAt", "terminalElapsedMs", "stepAt", "requestCountDelta", "readFrameSerial", "lastResponseFrame"})
            QVERIFY(terminal.contains(key));
        QVERIFY(!terminal.contains("sceneX"));
        QCOMPARE(terminal.value("receipt").toMap().value("saveId").toString(), QString("current-save"));
        QCOMPARE(terminal.value("receipt").toMap().value("readId").toString(), QString("current-read"));
        QCOMPARE(terminal.value("receipt").toMap().value("status").toString(), QString("invalid"));
        const auto json = QJsonDocument::fromVariant(metadata).toJson(QJsonDocument::Compact);
        QVERIFY(!json.contains("PRIVATE_")); QVERIFY(!json.contains("\"text\"")); QVERIFY(!json.contains("\"source\""));
        QVERIFY(!json.contains("must-not-replace-terminal"));
        QVERIFY(json.size() < 30000);
    }
    void summaryInputContractDistinguishesMouseClickedAndToggled_data() {
        QTest::addColumn<QString>("control");
        QTest::addColumn<int>("mouse");
        QTest::addColumn<int>("clicked");
        QTest::addColumn<int>("toggled");
        QTest::addColumn<bool>("accepted");
        QTest::newRow("tab-one-clicked") << QString("memoryTab-summary") << 1 << 1 << 0 << true;
        QTest::newRow("tab-no-clicked") << QString("memoryTab-summary") << 1 << 0 << 0 << false;
        QTest::newRow("switch-toggled-without-clicked") << QString("summaryEnabled") << 1 << 0 << 1 << true;
        QTest::newRow("switch-toggled-and-clicked") << QString("summaryEnabled") << 1 << 1 << 1 << true;
        QTest::newRow("switch-duplicate-clicked") << QString("summaryEnabled") << 1 << 2 << 1 << false;
        QTest::newRow("switch-clicked-without-toggled") << QString("summaryEnabled") << 1 << 1 << 0 << false;
        QTest::newRow("switch-duplicate-toggled") << QString("summaryEnabled") << 1 << 0 << 2 << false;
        QTest::newRow("second-mouse-dispatch") << QString("summaryEnabled") << 2 << 1 << 1 << false;
    }
    void summaryInputContractDistinguishesMouseClickedAndToggled() {
        QFETCH(QString, control); QFETCH(int, mouse); QFETCH(int, clicked); QFETCH(int, toggled); QFETCH(bool, accepted);
        SummaryInteractionProbe::InputCounts counts;
        counts.observerValid = true; counts.mouseDispatchCount = mouse;
        counts.clickedSignals = clicked; counts.toggledSignals = toggled;
        QCOMPARE(SummaryInteractionProbe::inputContract(control, counts), accepted);
        QCOMPARE(SummaryInteractionProbe::inputFailure(control, counts).isEmpty(), accepted);
    }
    void summarySignalProbeRecordsActualZerosAndAllSignalsWithoutDrivingState() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, summarySignalsFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = qobject_cast<QQuickItem *>(root.get()); QVERIFY(target);
        SummaryInteractionProbe::SignalProbe probe;
        auto metadata = probe.metadata();
        QVERIFY(metadata.contains("mouseDispatchCount") && metadata.value("mouseDispatchCount").isNull());
        QVERIFY(metadata.value("clickedSignals").isNull() && metadata.value("toggledSignals").isNull());
        QVERIFY(probe.arm(target));
        metadata = probe.metadata();
        for (const auto *key : {"mouseDispatchCount", "clickedSignals", "toggledSignals", "canceledSignals", "pressedSignals",
                                "releasedSignals", "checkedChangedSignals", "enabledChangedSignals"}) {
            QVERIFY(!metadata.value(key).isNull()); QCOMPARE(metadata.value(key).toLongLong(), qint64(0));
        }
        QCOMPARE(metadata.value("checkedBefore"), QVariant(false));
        QCOMPARE(metadata.value("enabledBefore"), QVariant(true));
        QVERIFY(metadata.value("checkedAfter").isNull() && metadata.value("enabledAfter").isNull());
        probe.recordMouseDispatch();
        QVERIFY(!target->property("checked").toBool() && target->isEnabled());
        // Fixture signals test observation only; this is not mouse delivery.
        for (const auto *name : {"pressed", "toggled", "released", "clicked", "canceled"})
            QVERIFY(QMetaObject::invokeMethod(target, name));
        QVERIFY(!target->property("checked").toBool() && target->isEnabled());
        QVERIFY(target->setProperty("checked", true)); target->setEnabled(false);
        metadata = probe.metadata();
        for (const auto *key : {"mouseDispatchCount", "clickedSignals", "toggledSignals", "canceledSignals", "pressedSignals",
                                "releasedSignals", "checkedChangedSignals", "enabledChangedSignals"})
            QCOMPARE(metadata.value(key).toLongLong(), qint64(1));
        QCOMPARE(metadata.value("checkedAfter"), QVariant(true));
        QCOMPARE(metadata.value("enabledAfter"), QVariant(false));
        QVERIFY(SummaryInteractionProbe::inputContract("summaryEnabled", probe.counts()));
    }
    void summarySignalProbeCannotRecoverByRearmingOrInventDestroyedTargetCounts() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, summarySignalsFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = qobject_cast<QQuickItem *>(root.get()); QVERIFY(target);
        SummaryInteractionProbe::SignalProbe missing;
        QVERIFY(!missing.arm(nullptr)); QVERIFY(!missing.arm(target));
        QVERIFY(!SummaryInteractionProbe::inputContract("summaryEnabled", missing.counts()));
        QVERIFY(missing.metadata().value("mouseDispatchCount").isNull());
        QQuickItem incomplete(window.contentItem());
        SummaryInteractionProbe::SignalProbe invalid;
        QVERIFY(!invalid.arm(&incomplete));
        QVERIFY(invalid.metadata().value("clickedSignals").isNull());
        QVERIFY(!invalid.counts().observerValid);
        SummaryInteractionProbe::SignalProbe probe;
        QVERIFY(probe.arm(target)); probe.recordMouseDispatch();
        QVERIFY(QMetaObject::invokeMethod(target, "toggled"));
        probe.observe("after-input");
        QVERIFY(SummaryInteractionProbe::inputContract("summaryEnabled", probe.counts()));
        QVERIFY(!probe.arm(target));
        QVERIFY(!SummaryInteractionProbe::inputContract("summaryEnabled", probe.counts()));
        QCOMPARE(probe.counts().toggledSignals.toLongLong(), qint64(1));
        QVERIFY(probe.metadata().value("rearmRejected").toBool());
        QCOMPARE(probe.metadata().value("inputFailure").toString(), QString("signal-probe-rearmed"));
        root.reset();
        QVERIFY(!probe.metadata().value("targetAlive").toBool());
        QVERIFY(probe.counts().clickedSignals.isNull() && probe.counts().toggledSignals.isNull());
        QCOMPARE(probe.metadata().value("mouseDispatchCount").toInt(), 1);
        const auto retained = probe.metadata().value("samples").toList();
        QCOMPARE(retained.size(), 1);
        QCOMPARE(retained.first().toMap().value("toggledSignals").toLongLong(), qint64(1));
    }
    void summarySignalProbeScopeExitKeepsTheActualInputBeforeAssertions_data() {
        QTest::addColumn<bool>("throwAfterInput");
        QTest::newRow("early-return") << false;
        QTest::newRow("exception-after-input") << true;
    }
    void summarySignalProbeScopeExitKeepsTheActualInputBeforeAssertions() {
        QFETCH(bool, throwAfterInput);
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, summarySignalsFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = qobject_cast<QQuickItem *>(root.get()); QVERIFY(target);
        QVariantMap retained;
        bool threw = false;
        try {
            [&] {
                SummaryInteractionProbe::SignalProbe probe;
                // Last declared, first destroyed: the probe/spies remain alive.
                const auto seal = qScopeGuard([&] { probe.terminal(); retained = probe.metadata(); });
                if (!probe.arm(target)) throw std::runtime_error("fixture signal arm failed");
                probe.observe("before-input"); probe.recordMouseDispatch();
                if (!QMetaObject::invokeMethod(target, "toggled")) throw std::runtime_error("fixture signal missing");
                probe.observe("after-input");
                if (throwAfterInput) throw std::runtime_error("fixture failure after input");
                return;
            }();
        } catch (const std::runtime_error &) { threw = true; }
        QCOMPARE(threw, throwAfterInput);
        QCOMPARE(retained.value("terminalCount").toInt(), 1);
        const auto terminal = retained.value("terminal").toMap();
        QCOMPARE(terminal.value("mouseDispatchCount").toInt(), 1);
        QCOMPARE(terminal.value("clickedSignals").toLongLong(), qint64(0));
        QCOMPARE(terminal.value("toggledSignals").toLongLong(), qint64(1));
        QVERIFY(terminal.value("observerValid").toBool());
    }
    void summarySignalProbeDiagnosticsKeepSixSamplesOneTerminalAndNullableRequests() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, summarySignalsFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *target = qobject_cast<QQuickItem *>(root.get()); QVERIFY(target);
        SummaryInteractionProbe::SignalProbe probe;
        SummaryInteractionProbe::BoundedDiagnostic diagnostic;
        diagnostic.observe({{"signalProbe", probe.metadata()}});
        QVERIFY(probe.arm(target)); probe.recordMouseDispatch();
        for (int i = 0; i < 40; ++i) probe.observe(i == 39 ? "PRIVATE_PHASE" : "after-input");
        probe.terminal(); probe.terminal("PRIVATE_SECOND_TERMINAL");
        const auto metadata = probe.metadata();
        QCOMPARE(metadata.value("samples").toList().size(), 6);
        QCOMPARE(metadata.value("observations").toInt(), 40);
        QCOMPARE(metadata.value("terminalCount").toInt(), 1);
        const QVariantMap request{{"source", "feedback-and-response-identities"}, {"observerArmed", true},
            {"observedSaveRequestCount", 1}, {"observedReadRequestCount", 0}, {"rendererSettingsDelta", QVariant{}},
            {"rendererReadDelta", QVariant{}}, {"saveRequestId", "current-save"}, {"readRequestId", ""},
            {"sourceSaveId", "current-save"}, {"saveResponses", 0}, {"readResponses", 0}, {"scope", "persona:summary"},
            {"generation", 7}, {"expected", true}, {"saveIdentityMatches", true}, {"payloadMatches", QVariant{}},
            {"savePending", true}, {"payload", QVariantMap{{"text", "PRIVATE_PAYLOAD"}}}};
        diagnostic.terminal({{"signalProbe", metadata}, {"requestObservation", request},
            {"inputFailure", "toggled-signal-count"}, {"text", "PRIVATE_TEXT"}, {"source", "PRIVATE_SOURCE"}});
        const auto projected = diagnostic.metadata();
        const auto unarmed = projected.value("samples").toList().first().toMap().value("signalProbe").toMap();
        QVERIFY(unarmed.contains("mouseDispatchCount") && unarmed.value("mouseDispatchCount").isNull());
        QVERIFY(unarmed.contains("clickedSignals") && unarmed.value("clickedSignals").isNull());
        const auto terminal = projected.value("terminal").toMap();
        const auto signal = terminal.value("signalProbe").toMap();
        QCOMPARE(signal.value("clickedSignals").toLongLong(), qint64(0));
        QCOMPARE(signal.value("terminalCount").toInt(), 1);
        QCOMPARE(signal.value("terminal").toMap().value("mouseDispatchCount").toInt(), 1);
        const auto observed = terminal.value("requestObservation").toMap();
        QCOMPARE(observed.value("source").toString(), QString("feedback-and-response-identities"));
        QVERIFY(observed.contains("rendererSettingsDelta") && observed.value("rendererSettingsDelta").isNull());
        QVERIFY(observed.contains("payloadMatches") && observed.value("payloadMatches").isNull());
        QVERIFY(!observed.contains("payload"));
        const auto json = QJsonDocument::fromVariant(projected).toJson(QJsonDocument::Compact);
        QVERIFY(!json.contains("PRIVATE_")); QVERIFY(!json.contains("\"text\"")); QVERIFY(!json.contains("\"payload\""));
        QVERIFY(json.size() < 40000);
    }
    void checkFailureCarriesValuesWithoutText() {
        const QVariantMap observed{{"requestId", "qt_abc"}, {"status", "pending"}, {"text", "PRIVATE_BODY"},
            {"count", 2}, {"ok", false}, {"missing", QVariant{}}, {"rows", QVariantList{1, 2, 3}},
            {"nested", QVariantMap{{"saveId", "s1"}, {"payload", "PRIVATE_PAYLOAD"}}}};
        const auto message = NativeCheck::describe("MEMORY_EDITOR_STILL_OPEN", observed);
        QVERIFY2(message.startsWith("MEMORY_EDITOR_STILL_OPEN {"), qPrintable(message));
        for (const auto *part : {"requestId=qt_abc", "status=pending", "count=2", "ok=false", "missing=null",
                                 "rows=[3 items]", "text=<text:12>", "saveId=s1", "payload=<text:15>"})
            QVERIFY2(message.contains(QLatin1String(part)), qPrintable(message));
        QVERIFY(!message.contains("PRIVATE"));
        bool thrown = false;
        try {
            NativeCheck::require(false, "MEMORY_EDITOR_STILL_OPEN", observed);
        } catch (const std::runtime_error &error) {
            thrown = true;
            QCOMPARE(QString::fromStdString(error.what()), message);
        }
        QVERIFY(thrown);
        NativeCheck::require(true, "UNUSED", observed);
        QVariantMap wide;
        for (int i = 0; i < 40; ++i) wide[QString("key%1Id").arg(i, 2, 10, QChar('0'))] = QString(200, 'x');
        const auto bounded = NativeCheck::describe("WIDE", wide);
        QVERIFY(bounded.size() <= 4 + 900);
        QVERIFY(bounded.contains(QStringLiteral("…")));
    }
    void checkHitTestFollowsPaintOrderClipAndEnabled() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, hitFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        const auto center = [&](const char *name) {
            auto *target = NativeCheck::findVisual(item, name).item.data();
            return target ? target->mapToScene(QPointF(target->width() / 2, target->height() / 2)) : QPointF();
        };
        const auto hit = [&](const char *name) {
            return NativeCheck::hitTest(&window, center(name), NativeCheck::findVisual(item, name).item);
        };
        QCOMPARE(hit("wrapped").result, QString("descendant"));
        QCOMPARE(hit("wrapped").acceptor->objectName(), QString("wrappedArea"));
        // A visible overlay that accepts no button does not take the press.
        QCOMPARE(hit("plain").result, QString("target"));
        QVERIFY(hit("plain").accepted());
        // Declared first, but its higher z paints and receives on top.
        const auto covered = hit("covered");
        QCOMPARE(covered.result, QString("other"));
        QCOMPARE(covered.metadata().value("acceptorName").toString(), QString("blocker"));
        QVERIFY(!covered.accepted());
        QCOMPARE(hit("clipped").result, QString("none"));
        QCOMPARE(hit("disabled").result, QString("none"));
        QCOMPARE(hit("itemDisabled").result, QString("none"));
        QCOMPARE(hit("label").result, QString("ancestor"));
        const auto plain = hit("plain").metadata();
        QVERIFY(plain.value("containingCount").toInt() >= 1);
        QVERIFY(plain.value("containing").toList().size() <= NativeCheck::ObservationLimit);
        QCOMPARE(NativeCheck::hitTest(nullptr, QPointF(1, 1), item).result, QString("unavailable"));
        QCOMPARE(NativeCheck::hitTest(&window, QPointF(qQNaN(), 1), item).result, QString("unavailable"));
    }
    void checkHitTestSkipsOnlyPassivePointObservers_data() {
        QTest::addColumn<QByteArray>("handler");
        QTest::addColumn<bool>("passive");
        QTest::newRow("point-handler-observer")
            << QByteArray("PointHandler { objectName: \"observer\"; target: null; acceptedButtons: Qt.AllButtons; "
                          "grabPermissions: PointerHandler.ApprovesTakeOverByAnything }") << true;
        QTest::newRow("tap-handler-layer")
            << QByteArray("TapHandler { objectName: \"tapper\"; gesturePolicy: TapHandler.WithinBounds }") << false;
    }
    void checkHitTestSkipsOnlyPassivePointObservers() {
        QFETCH(QByteArray, handler); QFETCH(bool, passive);
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, observerFixture(handler), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        auto *under = NativeCheck::findVisual(item, "under").item.data();
        QVERIFY(under);
        const auto point = under->mapToScene(QPointF(under->width() / 2, under->height() / 2));
        const auto hit = NativeCheck::hitTest(&window, point, under);
        const auto observed = hit.metadata();
        QTest::mouseClick(&window, Qt::LeftButton, Qt::NoModifier, point.toPoint());
        QCoreApplication::processEvents();
        const int clicks = under->property("clicks").toInt();
        // Qt's own delivery is evidence for both rows; only the passive row
        // asserts it, because the walk models no other handler type.
        qInfo().noquote() << NativeCheck::describe("CHECK_CONTRACT_POINTER_OBSERVER",
            {{"passive", passive}, {"hit", observed}, {"underClicks", clicks}});
        if (passive) {
            QVERIFY2(hit.result == "target", qPrintable(NativeCheck::describe("PASSIVE_OBSERVER_TOOK_PRESS", observed)));
            QCOMPARE(hit.passiveObserverCount, 1);
            QCOMPARE(hit.passiveObservers.value(0).toMap().value("objectName").toString(), QString("observerLayer"));
            QCOMPARE(clicks, 1);
        } else {
            QVERIFY2(hit.result == "other", qPrintable(NativeCheck::describe("HANDLER_LAYER_NOT_REPORTED", observed)));
            QCOMPARE(observed.value("acceptorName").toString(), QString("observerLayer"));
            QCOMPARE(hit.passiveObserverCount, 0);
        }
    }
    void checkFocusTraceRecordsOwnersAndBoundsChanges() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, focusFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        // Same offscreen window-system activation as ShortcutActivationTest.
        QWindowSystemInterface::handleFocusWindowChanged<QWindowSystemInterface::SynchronousDelivery>(
            &window, Qt::ActiveWindowFocusReason);
        QVERIFY(QGuiApplication::focusWindow() == &window && window.isActive());
        QVariantMap retained;
        {
            NativeCheck::FocusTrace trace(&window);
            QVERIFY(trace.armed());
            for (int i = 0; i < 8; ++i) {
                auto *field = NativeCheck::findVisual(item, QString("field%1").arg(i)).item.data();
                QVERIFY(field);
                field->forceActiveFocus();
                QVERIFY(field->hasActiveFocus());
            }
            retained = trace.metadata();
            QVERIFY(trace.count() >= 8);
        }
        const auto changes = retained.value("changes").toList();
        QCOMPARE(changes.size(), NativeCheck::ObservationLimit);
        QCOMPARE(retained.value("overflow").toInt(), retained.value("count").toInt() - NativeCheck::ObservationLimit);
        QCOMPARE(retained.value("current").toMap().value("objectName").toString(), QString("field7"));
        QStringList owners;
        int ordinal = 0;
        for (const auto &change : changes) {
            const auto entry = change.toMap();
            QVERIFY(entry.value("ordinal").toInt() > ordinal);
            ordinal = entry.value("ordinal").toInt();
            owners.append(entry.value("objectName").toString());
        }
        QVERIFY2(owners.contains("field0"), qPrintable(owners.join(',')));
    }
    void checkVisualFindCountsRepeaterMatches() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, treeFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        const auto checks = NativeCheck::findVisual(item, "check");
        QCOMPARE(checks.matches, 3);
        QVERIFY(!checks.item);
        QVERIFY(!checks.metadata().value("unique").toBool());
        const auto row = NativeCheck::findVisual(item, "row1");
        QCOMPARE(row.matches, 1);
        QVERIFY(row.item);
        QCOMPARE(row.item->objectName(), QString("row1"));
        QCOMPARE(NativeCheck::findVisual(item, "dataOnly").matches, 0);
        QCOMPARE(NativeCheck::findVisual(item, "hiddenOnly").matches, 1);
        QCOMPARE(NativeCheck::findVisual(item, "hiddenOnly", true).matches, 0);
        QCOMPARE(NativeCheck::findVisual(nullptr, "row1").matches, 0);
    }
    void checkInvokeQmlReturnsVariant() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, treeFixture(), error);
        QVERIFY2(root, qPrintable(error));
        const auto created = NativeCheck::invokeQml(root.get(), "created");
        QVERIFY(created.invoked);
        QVERIFY(created.value.toBool());
        const auto added = NativeCheck::invokeQml(root.get(), "add", {2, 3});
        QVERIFY(added.invoked);
        QCOMPARE(added.value.toInt(), 5);
        QCOMPARE(NativeCheck::invokeQml(nullptr, "created").reason, QString("object-unavailable"));
        QCOMPARE(NativeCheck::invokeQml(root.get(), "add", {1, 2, 3, 4}).reason, QString("too-many-arguments"));
        QVERIFY(created.metadata().value("valueValid").toBool());
    }
    void checkAttachedAccessibleReadNeedsItsContext() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, treeFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *feedback = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), "feedback").item.data();
        QVERIFY(feedback);
        const auto role = NativeCheck::readAttached(feedback, "Accessible.role");
        QVERIFY2(role.contextValid && role.propertyValid && role.valueValid,
                 qPrintable(NativeCheck::describe("ROLE", role.metadata())));
        QVERIFY(role.integer().has_value());
        QCOMPARE(*role.integer(), int(QAccessible::StaticText));
        const auto name = NativeCheck::readAttached(feedback, "Accessible.name");
        QVERIFY(name.valueValid);
        QCOMPARE(name.metadata().value("textLength").toInt(), int(QString("PRIVATE_ACCESSIBLE_NAME").size()));
        QVERIFY(!QJsonDocument::fromVariant(name.metadata()).toJson().contains("PRIVATE"));
        // An item without a QML context cannot resolve an attached property;
        // that is reported as unread, never as a measured zero.
        QQuickItem bare(window.contentItem());
        const auto unread = NativeCheck::readAttached(&bare, "Accessible.role");
        QVERIFY(!unread.contextValid && !unread.valueValid && !unread.integer().has_value());
        QVERIFY(!NativeCheck::readAttached(nullptr, "Accessible.role").contextValid);
    }
    void checkInputContractTable_data() {
        QTest::addColumn<int>("kind");
        QTest::addColumn<bool>("observerValid");
        QTest::addColumn<int>("mouse");
        QTest::addColumn<int>("clicked");
        QTest::addColumn<int>("toggled");
        QTest::addColumn<QString>("reason");
        const int button = int(NativeCheck::ControlKind::Button), tab = int(NativeCheck::ControlKind::Tab),
                  toggle = int(NativeCheck::ControlKind::Switch);
        // -1 is an unmeasured count, never a zero.
        QTest::newRow("button-one-click") << button << true << 1 << 1 << 0 << QString();
        QTest::newRow("button-no-click") << button << true << 1 << 0 << 0 << QString("clicked-signal-count");
        QTest::newRow("button-two-clicks") << button << true << 1 << 2 << 0 << QString("clicked-signal-count");
        QTest::newRow("button-unmeasured") << button << true << 1 << -1 << 0 << QString("clicked-signal-count");
        QTest::newRow("tab-one-click") << tab << true << 1 << 1 << 0 << QString();
        QTest::newRow("switch-clicked-and-toggled") << toggle << true << 1 << 1 << 1 << QString();
        QTest::newRow("switch-disabled-before-trigger") << toggle << true << 1 << 0 << 1 << QString();
        QTest::newRow("switch-two-clicks") << toggle << true << 1 << 2 << 1 << QString("clicked-signal-count");
        QTest::newRow("switch-not-toggled") << toggle << true << 1 << 1 << 0 << QString("toggled-signal-count");
        QTest::newRow("two-dispatches") << button << true << 2 << 1 << 0 << QString("mouse-dispatch-count");
        QTest::newRow("observer-unavailable") << toggle << false << 1 << 1 << 1 << QString("signal-observer-unavailable");
    }
    void checkInputContractTable() {
        QFETCH(int, kind); QFETCH(bool, observerValid); QFETCH(int, mouse); QFETCH(int, clicked);
        QFETCH(int, toggled); QFETCH(QString, reason);
        NativeCheck::InputSignals counts;
        counts.observerValid = observerValid;
        counts.mouseDispatchCount = mouse;
        if (clicked >= 0) counts.clicked = clicked;
        if (toggled >= 0) counts.toggled = toggled;
        const auto controlKind = static_cast<NativeCheck::ControlKind>(kind);
        QCOMPARE(NativeCheck::inputContractFailure(controlKind, counts), reason);
        const auto described = NativeCheck::describeSignals(controlKind, counts);
        QCOMPARE(described.value("contractReason").toString(), reason);
        QCOMPARE(described.value("clickedSignals").isNull(), clicked < 0);
    }
    void checkRealControlsSatisfyTheirContracts() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, controlsFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        const auto press = [&](const char *name, NativeCheck::ControlKind kind) {
            auto *control = NativeCheck::findVisual(item, name).item.data();
            if (!control) return QVariantMap{{"found", false}};
            QSignalSpy clicked(control, SIGNAL(clicked()));
            QSignalSpy toggled(control, SIGNAL(toggled()));
            const auto point = control->mapToScene(QPointF(control->width() / 2, control->height() / 2));
            const auto hit = NativeCheck::hitTest(&window, point, control);
            QTest::mouseClick(&window, Qt::LeftButton, Qt::NoModifier, point.toPoint());
            NativeCheck::InputSignals counts;
            counts.observerValid = clicked.isValid() && toggled.isValid();
            counts.mouseDispatchCount = 1;
            if (clicked.isValid()) counts.clicked = clicked.count();
            if (toggled.isValid()) counts.toggled = toggled.count();
            auto out = NativeCheck::describeSignals(kind, counts);
            const auto hitData = hit.metadata();
            out.insert({{"found", true}, {"hitResult", hit.result}, {"hitAccepted", hit.accepted()},
                        {"acceptorName", hitData.value("acceptorName")}, {"acceptorClass", hitData.value("acceptorClass")},
                        {"checked", control->property("checked")}, {"enabledAfter", control->isEnabled()}});
            return out;
        };
        const auto button = press("button", NativeCheck::ControlKind::Button);
        const auto plain = press("plainSwitch", NativeCheck::ControlKind::Switch);
        const auto saving = press("savingSwitch", NativeCheck::ControlKind::Switch);
        // Measured values are evidence; the contract decides.
        qInfo().noquote() << NativeCheck::describe("CHECK_CONTRACT_REAL_CONTROLS",
            {{"button", button}, {"plainSwitch", plain}, {"savingSwitch", saving}});
        for (const auto &observed : {button, plain, saving}) {
            QVERIFY2(observed.value("found").toBool(), qPrintable(NativeCheck::describe("CONTROL", observed)));
            QVERIFY2(observed.value("contractReason").toString().isEmpty(),
                     qPrintable(NativeCheck::describe("CONTRACT", observed)));
            // The input primitive admits the control itself or one of its
            // children; Qt then delivers to the control if the child ignores.
            QVERIFY2(observed.value("hitAccepted").toBool(), qPrintable(NativeCheck::describe("HIT", observed)));
        }
        QVERIFY(plain.value("checked").toBool());
        QVERIFY(saving.value("checked").toBool());
        QVERIFY(!saving.value("enabledAfter").toBool());
    }
    void checkLegacyClickLogKeepsFirstSuspectWithoutSendingInput() {
        QQuickWindow window; window.resize(300, 200);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, hitFixture(), error);
        QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        const auto center = [](QQuickItem *target) {
            return target->mapToScene(QPointF(target->width() / 2, target->height() / 2));
        };
        auto *plain = NativeCheck::findVisual(item, "plain").item.data();
        auto *covered = NativeCheck::findVisual(item, "covered").item.data();
        QVERIFY(plain && covered);
        NativeCheck::LegacyClickLog log;
        log.record("plain", plain, &window, center(plain));
        log.record("covered", covered, &window, center(covered));
        for (int i = 0; i < 7; ++i) log.record("plain", plain, &window, center(plain));
        log.record("missing", nullptr, &window, QPointF());
        const auto metadata = log.metadata();
        QCOMPARE(log.total(), 10);
        QCOMPARE(log.suspects(), 2);
        QCOMPARE(metadata.value("recent").toList().size(), NativeCheck::ObservationLimit);
        const auto first = metadata.value("firstSuspect").toMap();
        QCOMPARE(first.value("control").toString(), QString("covered"));
        QCOMPARE(first.value("ordinal").toInt(), 2);
        QCOMPARE(first.value("hit").toMap().value("hitResult").toString(), QString("other"));
        QCOMPARE(first.value("hit").toMap().value("acceptorName").toString(), QString("blocker"));
        const auto last = metadata.value("recent").toList().last().toMap();
        QVERIFY(!last.value("found").toBool() && last.value("suspect").toBool());
        const auto clean = metadata.value("recent").toList().first().toMap();
        QVERIFY(!clean.value("suspect").toBool());
        QVERIFY(clean.value("pointInsideClip").toBool());
        // Recording never presses anything.
        QCOMPARE(plain->property("clicks").toInt(), 0);
        const auto json = QJsonDocument::fromVariant(metadata).toJson(QJsonDocument::Compact);
        QVERIFY(json.size() < 20000);
    }
    void insertionReadinessRevealsAndDispatchesOneKeyboardEdit_data() {
        QTest::addColumn<QString>("control"); QTest::addColumn<int>("offset");
        for (const auto *control : {"worldbookInsertionPosition", "worldbookInsertionDepth", "worldbookInsertionRole"})
            for (const int offset : {0, 850})
                QTest::newRow((QByteArray(control) + "-" + QByteArray::number(offset)).constData()) << QString(control) << offset;
    }
    void insertionReadinessRevealsAndDispatchesOneKeyboardEdit() {
        QFETCH(QString, control); QFETCH(int, offset);
        QQuickWindow window; window.resize(300, 240); QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, insertionForm(), error); QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        auto *target = NativeCheck::findVisual(item, control).item.data();
        auto *outer = NativeCheck::findVisual(item, "insertion-outer").item.data(); QVERIFY(target && outer);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); outer->setProperty("contentY", offset); QTest::qWait(40);
        NativeArchiveControlReadiness::Gate gate; qint64 now = 0, frame = 0; int actions = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::WholeItem, control,
            [=] { return target; }, [] { return QVariantMap{{"scope", "insertion-fixture"}, {"revision", 2}, {"generation", 1}}; }};
        auto status = NativeArchiveControlReadiness::Gate::Waiting;
        for (; now < 4000 && status == NativeArchiveControlReadiness::Gate::Waiting; now += 20) {
            status = gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &prepared) {
                ++actions; QVERIFY(NativeControlReadiness::wholeVisibility(target, &window).value("fullyVisible").toBool());
                prepared.target->forceActiveFocus(Qt::TabFocusReason);
                QTest::keyClick(&window, control == "worldbookInsertionDepth" ? Qt::Key_Up : Qt::Key_Down);
            });
            QTest::qWait(1);
        }
        QCOMPARE(status, NativeArchiveControlReadiness::Gate::Performed); QCOMPARE(actions, 1);
        QCOMPARE(target->property("edits").toInt(), 1);
        QCOMPARE(target->property(control == "worldbookInsertionDepth" ? "value" : "currentIndex").toInt(), control == "worldbookInsertionDepth" ? 6 : 1);
        QCOMPARE(gate.metadata().value("attemptCount").toInt(), 1);
        QVERIFY(gate.metadata().value("actionElapsedMs").toLongLong() < 4000);
        const auto after = outer->property("contentY"); now = 5000;
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }), NativeArchiveControlReadiness::Gate::Performed);
        QCOMPARE(actions, 1); QCOMPARE(target->property("edits").toInt(), 1); QCOMPARE(outer->property("contentY"), after);
    }
    void insertionReadinessRejectsInactiveControls_data() {
        QTest::addColumn<QString>("control");
        QTest::newRow("inactive-depth") << "worldbookInsertionDepth";
        QTest::newRow("inactive-role") << "worldbookInsertionRole";
    }
    void insertionReadinessRejectsInactiveControls() {
        QFETCH(QString, control); QQuickWindow window; window.resize(300, 240); QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, insertionForm(), error); QVERIFY2(root, qPrintable(error));
        auto *target = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), control).item.data(); QVERIFY(target);
        target->setEnabled(false); window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window));
        NativeArchiveControlReadiness::Gate gate; qint64 now = 0; int actions = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::WholeItem, control,
            [=] { return target; }, [] { return QVariantMap{{"revision", 2}}; }};
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, 1, [&](const auto &) { ++actions; }), NativeArchiveControlReadiness::Gate::Waiting);
        now = 4000;
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, 2, [&](const auto &) { ++actions; }), NativeArchiveControlReadiness::Gate::Expired);
        QCOMPARE(actions, 0); QCOMPARE(target->property("edits").toInt(), 0);
    }

    void archiveReadinessUsesOneClockAndOneAction_data() {
        QTest::addColumn<int>("region"); QTest::addColumn<int>("outerOffset"); QTest::addColumn<bool>("innerScrolled");
        QTest::newRow("first-line-outer-top") << 2 << 0 << false;
        QTest::newRow("first-line-outer-middle") << 2 << 400 << false;
        QTest::newRow("first-line-outer-bottom-inner-end") << 2 << 960 << true;
        QTest::newRow("body-point-keeps-inner-offset") << 1 << 0 << true;
        QTest::newRow("body-wheel-keeps-inner-offset") << 3 << 0 << true;
        QTest::newRow("title-after-body") << 0 << 650 << false;
    }
    void archiveReadinessUsesOneClockAndOneAction() {
        QFETCH(int, region); QFETCH(int, outerOffset); QFETCH(bool, innerScrolled);
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        auto *body = NativeCheck::findVisual(item, "worldbookContent").item.data();
        auto *outer = NativeCheck::findVisual(item, "archive-outer").item.data();
        auto *title = NativeCheck::findVisual(item, "worldbookName").item.data();
        QVERIFY(body && outer && title);
        auto *inner = NativeArchiveControlReadiness::flickableAncestor(body); QVERIFY(inner);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        outer->setProperty("contentY", outerOffset);
        if (innerScrolled) inner->setProperty("contentY", 300.);
        QTest::qWait(40);
        const QString bodyBefore = body->property("text").toString();
        const auto innerBefore = inner->property("contentY").toDouble();
        NativeArchiveControlReadiness::Gate gate;
        qint64 now = 0, frame = 0; int actions = 0;
        const bool whole = region == 0;
        const NativeArchiveControlReadiness::Request request{static_cast<NativeArchiveControlReadiness::Region>(region),
            whole ? "worldbookName" : "worldbookContent", [=] { return whole ? title : body; },
            [] { return QVariantMap{{"scope", "fixture-scope"}, {"generation", 1}, {"revision", 2}}; }};
        auto result = NativeArchiveControlReadiness::Gate::Waiting;
        for (; now < 4000 && result == NativeArchiveControlReadiness::Gate::Waiting; now += 20) {
            result = gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &prepared) {
                ++actions;
                QVERIFY(NativeControlReadiness::visibleRect(prepared.target, &window).contains(prepared.start));
                QVERIFY(NativeControlReadiness::visibleRect(prepared.target, &window).contains(prepared.end));
            });
            QTest::qWait(1);
        }
        QCOMPARE(result, NativeArchiveControlReadiness::Gate::Performed); QCOMPARE(actions, 1);
        const auto metadata = gate.metadata();
        QCOMPARE(metadata.value("attemptCount").toInt(), 1);
        QVERIFY(metadata.value("last").toMap().value("stableMs").toInt() >= 40);
        QVERIFY(metadata.value("actionElapsedMs").toLongLong() < 4000);
        if (region == 1 || region == 3) QCOMPARE(inner->property("contentY").toDouble(), innerBefore);
        const auto outerAfter = outer->property("contentY");
        // Once dispatched, even a moved viewport and expired clock cannot
        // trigger programmatic positioning or another action.
        inner->setProperty("contentY", 175.); const auto innerAfter = inner->property("contentY");
        now = 5000;
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Performed);
        QCOMPARE(actions, 1); QCOMPARE(inner->property("contentY"), innerAfter);
        QCOMPARE(outer->property("contentY"), outerAfter); QCOMPARE(body->property("text").toString(), bodyBefore);
    }
    void archiveReadinessInvalidatesBoundIdentity_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("replacement-target") << "target";
        QTest::newRow("replacement-window") << "window";
        QTest::newRow("changed-revision") << "revision";
        QTest::newRow("changed-generation") << "generation";
        QTest::newRow("changed-scope") << "scope";
        QTest::newRow("changed-entry") << "entry";
    }
    void archiveReadinessInvalidatesBoundIdentity() {
        QFETCH(QString, change);
        QQuickWindow window, otherWindow; window.resize(300, 240); otherWindow.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        QQuickItem *target = NativeCheck::findVisual(item, "worldbookContent").item.data(); QVERIFY(target);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        QQuickWindow *currentWindow = &window;
        QVariantMap context{{"scope", "scope-one"}, {"generation", 1}, {"revision", 2}, {"entry", "entry-one"}};
        NativeArchiveControlReadiness::Gate gate; qint64 now = 0; int actions = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyPoint,
            "worldbookContent", [&] { return target; }, [&] { return context; }};
        QCOMPARE(gate.poll(currentWindow, request, [&] { return now; }, 4000, 1, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Waiting);
        QQuickItem replacement(window.contentItem()); replacement.setObjectName("replacement");
        if (change == "target") target = &replacement;
        else if (change == "window") currentWindow = &otherWindow;
        else if (change == "scope" || change == "entry") context[change] = "changed";
        else context[change] = 3;
        now = 100;
        QVERIFY_THROWS_EXCEPTION(std::runtime_error,
            gate.poll(currentWindow, request, [&] { return now; }, 4000, 2,
                [&](const auto &) { ++actions; }));
        QCOMPARE(actions, 0); QVERIFY(gate.metadata().value("failed").toBool());
        QCOMPARE(gate.poll(currentWindow, request, [&] { return now; }, 4000, 3, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Failed);
        QCOMPARE(actions, 0);
    }
    void archiveReadinessDeadlineHasNoLateSideEffects_data() {
        QTest::addColumn<QString>("expiry");
        QTest::newRow("expired-before-lookup") << "before";
        QTest::newRow("expires-in-context-read") << "context";
        QTest::newRow("expires-during-action") << "action";
    }
    void archiveReadinessDeadlineHasNoLateSideEffects() {
        QFETCH(QString, expiry);
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *item = qobject_cast<QQuickItem *>(root.get()); QVERIFY(item);
        auto *target = NativeCheck::findVisual(item, "worldbookContent").item.data();
        auto *outer = NativeCheck::findVisual(item, "archive-outer").item.data(); QVERIFY(target && outer);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        const auto before = outer->property("contentY");
        NativeArchiveControlReadiness::Gate gate; qint64 now = expiry == "before" ? 4000 : 0;
        qint64 frame = 0; int actions = 0, lookups = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyPoint,
            "worldbookContent", [&] { ++lookups; return target; }, [&] {
                if (expiry == "context") now = 4000;
                return QVariantMap{{"revision", 2}};
            }};
        auto result = NativeArchiveControlReadiness::Gate::Waiting;
        while (result == NativeArchiveControlReadiness::Gate::Waiting) {
            result = gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; now = 4000; });
            if (result == NativeArchiveControlReadiness::Gate::Waiting) { now += 50; QTest::qWait(1); }
        }
        QCOMPARE(result, NativeArchiveControlReadiness::Gate::Expired);
        QCOMPARE(actions, expiry == "action" ? 1 : 0);
        if (expiry == "before") QCOMPARE(lookups, 0);
        if (expiry != "action") QCOMPARE(outer->property("contentY"), before);
        const auto after = outer->property("contentY");
        now = 0; // A caller clock rollback cannot revive an expired gate.
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Expired);
        QCOMPARE(outer->property("contentY"), after); QCOMPARE(actions, expiry == "action" ? 1 : 0);
    }
    void archiveReadinessRejectedActionCannotRetry() {
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *target = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), "worldbookContent").item.data(); QVERIFY(target);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        NativeArchiveControlReadiness::Gate gate; qint64 now = 0, frame = 0; int actions = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyPoint,
            "worldbookContent", [=] { return target; }, {}};
        bool caught = false;
        while (now < 4000 && !caught) {
            try { gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) {
                ++actions; throw std::runtime_error("registered-action-failure");
            }); } catch (const std::runtime_error &failure) { caught = QByteArray(failure.what()) == "registered-action-failure"; }
            now += 50; QTest::qWait(1);
        }
        QVERIFY(caught); QCOMPARE(actions, 1);
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Failed);
        QCOMPARE(actions, 1);
    }

    void archiveReadinessWaitsForInitialTargetWithoutRestartingClock() {
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *body = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), "worldbookContent").item.data(); QVERIFY(body);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        QQuickItem *target = nullptr; qint64 now = 3900, frame = 1; int actions = 0;
        NativeArchiveControlReadiness::Gate gate;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyPoint,
            "worldbookContent", [&] { return target; }, {}};
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Waiting);
        target = body; now = 3990;
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Waiting);
        now = 4000;
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Expired);
        QCOMPARE(actions, 0);
    }
    void archiveRegexPatternInputUsesItsOwnViewport_data() {
        QTest::addColumn<QString>("control"); QTest::addColumn<QString>("viewportName");
        QTest::newRow("primary-pattern-view") << "worldbookRegexKeywords" << "worldbook-regex-keywords-scroll";
        QTest::newRow("secondary-pattern-view") << "worldbookRegexSecondaryKeywords" << "worldbook-regex-secondary-scroll";
    }
    void archiveRegexPatternInputUsesItsOwnViewport() {
        QFETCH(QString, control); QFETCH(QString, viewportName);
        auto qml = archiveBodyForm(); qml.replace("worldbookContent", control.toUtf8());
        qml.replace("worldbook-content-scroll", viewportName.toUtf8());
        qml.replace("selectByMouse: true;", "textFormat: TextEdit.PlainText; selectByMouse: true;");
        QQuickWindow window; window.resize(300, 240); QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, qml, error); QVERIFY2(root, qPrintable(error));
        auto *item = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), control).item.data();
        auto *viewport = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), viewportName).item.data();
        QVERIFY(item && viewport && viewport->isAncestorOf(item));
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        NativeArchiveControlReadiness::Gate gate; QElapsedTimer clock; clock.start(); qint64 frame = 0;
        const auto framed = connect(&window, &QQuickWindow::afterAnimating, this, [&] { ++frame; });
        const auto disconnectFrame = qScopeGuard([&] { disconnect(framed); });
        const auto initial = item->property("text"); int actions = 0;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyFirstLine,
            control, [=] { return item; }, [] { return QVariantMap{{"revision", 1}}; }, [&] { return frame; }};
        auto status = NativeArchiveControlReadiness::Gate::Waiting;
        while (status == NativeArchiveControlReadiness::Gate::Waiting && clock.elapsed() < 4000) {
            status = gate.poll(&window, request, [&] { return clock.elapsed(); }, 4000, frame, [&](const auto &prepared) {
                ++actions; QCOMPARE(prepared.viewport.data(), viewport);
                QVERIFY(prepared.inner && viewport->isAncestorOf(prepared.inner));
                QVERIFY(NativeControlReadiness::wholeVisibility(viewport, &window).value("fullyVisible").toBool());
                NativeArchiveControlReadiness::mouseSelect(&window, prepared, [&] { return clock.elapsed(); }, 4000);
            });
            if (status == NativeArchiveControlReadiness::Gate::Waiting) QTest::qWait(20);
        }
        QCOMPARE(status, NativeArchiveControlReadiness::Gate::Performed); QCOMPARE(actions, 1);
        QVERIFY(item->property("selectionEnd").toInt() > item->property("selectionStart").toInt());
        QCOMPARE(item->property("text"), initial);
    }
    void archiveRegexPatternRejectsUnrelatedViewport_data() {
        QTest::addColumn<QString>("control"); QTest::addColumn<QString>("viewportName");
        QTest::newRow("primary-unrelated-view-rejected") << "worldbookRegexKeywords" << "worldbook-regex-keywords-scroll";
        QTest::newRow("secondary-unrelated-view-rejected") << "worldbookRegexSecondaryKeywords" << "worldbook-regex-secondary-scroll";
    }
    void archiveRegexPatternRejectsUnrelatedViewport() {
        QFETCH(QString, control); QFETCH(QString, viewportName);
        auto qml = archiveBodyForm(); qml.replace("worldbookContent", control.toUtf8());
        qml.replace("worldbook-content-scroll", viewportName.toUtf8());
        QQuickWindow window; window.resize(300, 240); QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, qml, error); QVERIFY2(root, qPrintable(error));
        auto *item = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), control).item.data();
        auto *viewport = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), viewportName).item.data();
        QVERIFY(item && viewport && viewport->isAncestorOf(item));
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyPoint,
            control, [=] { return item; }, {}};
        NativeArchiveControlReadiness::Gate baseline; qint64 now = 0, frame = 0; int actions = 0;
        auto status = NativeArchiveControlReadiness::Gate::Waiting;
        while (status == NativeArchiveControlReadiness::Gate::Waiting && now < 4000) {
            status = baseline.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; });
            now += 50; QTest::qWait(1);
        }
        QCOMPARE(status, NativeArchiveControlReadiness::Gate::Performed); QCOMPARE(actions, 1);
        // Mutate only after a fresh valid baseline, outside the refusal catch.
        viewport->setObjectName("regex-real-view-renamed");
        QQuickItem unrelated(window.contentItem()); unrelated.setObjectName(viewportName); unrelated.setSize(QSizeF(30, 30));
        NativeArchiveControlReadiness::Gate invalid; QString reason; int rejectedActions = 0;
        try { invalid.poll(&window, request, [] { return qint64(0); }, 4000, 1, [&](const auto &) { ++rejectedActions; }); }
        catch (const std::runtime_error &error) { reason = QString::fromUtf8(error.what()); }
        QCOMPARE(reason, QString("ARCHIVE_INPUT_BODY_VIEWPORT_INVALID")); QCOMPARE(rejectedActions, 0);
    }

    void archiveSelectionReleasesPointerOnMidGestureInvalidation_data() {
        QTest::addColumn<bool>("expire");
        QTest::newRow("deadline-after-press") << true;
        QTest::newRow("revision-after-press") << false;
    }
    void archiveSelectionReleasesPointerOnMidGestureInvalidation() {
        QFETCH(bool, expire);
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *body = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), "worldbookContent").item.data(); QVERIFY(body);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        qint64 now = 0, frame = 0; int revision = 2, actions = 0;
        ArchivePressBoundaryProbe probe;
        probe.onPress = [&] { if (expire) now = 4000; else ++revision; };
        window.installEventFilter(&probe);
        NativeArchiveControlReadiness::Gate gate;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyFirstLine,
            "worldbookContent", [=] { return body; }, [&] { return QVariantMap{{"revision", revision}}; }};
        bool caught = false; QString reason; QPoint start, end;
        for (; now < 4000 && !caught; now += 50) {
            try { gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &prepared) {
                ++actions; start = prepared.start; end = prepared.end;
                NativeArchiveControlReadiness::mouseSelect(&window, prepared, [&] { return now; }, 4000);
            }); } catch (const std::runtime_error &error) { caught = true; reason = QString::fromUtf8(error.what()); }
            QTest::qWait(1);
        }
        qInfo().noquote() << "ARCHIVE_POINTER_CLEANUP" << reason << probe.describe();
        QVERIFY(caught); QCOMPARE(actions, 1); QCOMPARE(probe.presses, 1); QCOMPARE(probe.releases, 1);
        QCOMPARE(probe.movesAfterPress, 0);
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Failed);
        QCOMPARE(actions, 1); QCOMPARE(probe.presses, 1); QCOMPARE(probe.releases, 1);
        // Exact refusal, and the only release lands where the press did.
        QCOMPARE(reason, QString(expire ? "ARCHIVE_INPUT_EXPIRED" : "ARCHIVE_INPUT_EVENT_IDENTITY_CHANGED"));
        QVERIFY(start != end); QVERIFY(!probe.sequenceOverflow);
        QCOMPARE(probe.sequence, (QStringList{ArchivePressBoundaryProbe::step("press", start),
                                              ArchivePressBoundaryProbe::step("release", start)}));
    }
    void archiveSelectionReleasesPointerAfterExplicitMoveInvalidation_data() {
        QTest::addColumn<bool>("expire");
        QTest::newRow("deadline-after-move") << true;
        QTest::newRow("revision-after-move") << false;
    }
    void archiveSelectionReleasesPointerAfterExplicitMoveInvalidation() {
        QFETCH(bool, expire);
        QQuickWindow window; window.resize(300, 240);
        QQmlEngine engine; QString error;
        auto root = createFixture(engine, window, archiveBodyForm(), error); QVERIFY2(root, qPrintable(error));
        auto *body = NativeCheck::findVisual(qobject_cast<QQuickItem *>(root.get()), "worldbookContent").item.data(); QVERIFY(body);
        window.show(); QVERIFY(QTest::qWaitForWindowExposed(&window)); QTest::qWait(60);
        qint64 now = 0, frame = 0; int revision = 2, actions = 0;
        ArchivePressBoundaryProbe probe;
        probe.onMove = [&] { if (expire) now = 4000; else ++revision; };
        window.installEventFilter(&probe);
        NativeArchiveControlReadiness::Gate gate;
        const NativeArchiveControlReadiness::Request request{NativeArchiveControlReadiness::Region::BodyFirstLine,
            "worldbookContent", [=] { return body; }, [&] { return QVariantMap{{"revision", revision}}; }};
        bool caught = false; QString reason; QPoint start, end;
        for (; now < 4000 && !caught; now += 50) {
            try { gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &prepared) {
                ++actions; start = prepared.start; end = prepared.end;
                NativeArchiveControlReadiness::mouseSelect(&window, prepared, [&] { return now; }, 4000);
            }); } catch (const std::runtime_error &error) { caught = true; reason = QString::fromUtf8(error.what()); }
            QTest::qWait(1);
        }
        qInfo().noquote() << "ARCHIVE_POINTER_CLEANUP" << reason << probe.describe();
        QVERIFY(caught); QCOMPARE(actions, 1); QCOMPARE(probe.presses, 1); QCOMPARE(probe.releases, 1);
        // The explicit move was sent before invalidation; cleanup adds no other.
        QCOMPARE(probe.movesAfterPress, 1);
        QCOMPARE(reason, QString(expire ? "ARCHIVE_INPUT_EXPIRED" : "ARCHIVE_INPUT_EVENT_IDENTITY_CHANGED"));
        QVERIFY(start != end); QVERIFY(!probe.sequenceOverflow);
        QCOMPARE(probe.sequence, (QStringList{ArchivePressBoundaryProbe::step("press", start),
                                              ArchivePressBoundaryProbe::step("move", end),
                                              ArchivePressBoundaryProbe::step("release", end)}));
        QCOMPARE(gate.poll(&window, request, [&] { return now; }, 4000, ++frame, [&](const auto &) { ++actions; }),
                 NativeArchiveControlReadiness::Gate::Failed);
        QCOMPARE(actions, 1); QCOMPARE(probe.presses, 1); QCOMPARE(probe.releases, 1);
    }

    void initialWindowCommitRespectsParentEnabled_data() {
        QTest::addColumn<bool>("parentEnabled");
        QTest::newRow("disabled-parent-keeps-selected-draft") << false;
        QTest::newRow("enabled-parent-commits-replacement") << true;
    }
    void initialWindowCommitRespectsParentEnabled() {
        QFETCH(bool, parentEnabled);
        QQuickWindow window;
        window.resize(300, 200);
        QQmlEngine engine;
        QString error;
        auto root = createFixture(engine, window, R"QML(
            import QtQuick
            import QtQuick.Controls
            Item {
                width: 300; height: 200
                Item {
                    objectName: "composerSurface"; anchors.fill: parent
                    TextArea {
                        objectName: "chatComposer"; width: 280; height: 100
                        persistentSelection: true
                        text: "原生场景中的合成草稿"
                    }
                }
            }
        )QML", error);
        QVERIFY2(root, qPrintable(error));
        auto *surface = root->findChild<QQuickItem *>("composerSurface");
        auto *editor = root->findChild<QQuickItem *>("chatComposer");
        QVERIFY(surface); QVERIFY(editor);
        surface->setEnabled(parentEnabled);
        window.show();
        QVERIFY(QTest::qWaitForWindowExposed(&window));
        QVERIFY(editor->isVisible());
        QCOMPARE(editor->isEnabled(), parentEnabled);
        QVERIFY(editor->property("persistentSelection").toBool());
        const QString draft = QStringLiteral("原生场景中的合成草稿");
        const QString replacement = QStringLiteral("你好，我喜欢和你一起看星空。");
        QCOMPARE(editor->property("text").toString(), draft);
        QString rejection;
        // Keep the exact main.cpp type() order, without a readiness guard or
        // a wait between focus, selection and the window-level IME event.
        try {
            if (!editor->isVisible())
                throw std::runtime_error("EDITOR_UNAVAILABLE");
            editor->forceActiveFocus();
            QTest::keyClick(&window, Qt::Key_A, Qt::ControlModifier);
            QMetaObject::invokeMethod(editor, "selectAll");
            QInputMethodEvent commit;
            commit.setCommitString(replacement);
            QCoreApplication::sendEvent(&window, &commit);
            if (editor->property("text").toString() != replacement)
                throw std::runtime_error("INPUT_NOT_COMMITTED:chatComposer");
        } catch (const std::runtime_error &caught) {
            rejection = QString::fromUtf8(caught.what());
        }
        if (parentEnabled) {
            QVERIFY(rejection.isEmpty());
            QCOMPARE(editor->property("text").toString(), replacement);
        } else {
            QCOMPARE(rejection, QStringLiteral("INPUT_NOT_COMMITTED:chatComposer"));
            QCOMPARE(editor->property("text").toString(), draft);
            QCOMPARE(editor->property("selectionStart").toInt(), 0);
            QCOMPARE(editor->property("selectionEnd").toInt(), draft.size());
            QCOMPARE(editor->property("selectedText").toString(), draft);
        }
    }
};
QTEST_MAIN(ControlReadinessTest)
#include "ControlReadinessTest.moc"
