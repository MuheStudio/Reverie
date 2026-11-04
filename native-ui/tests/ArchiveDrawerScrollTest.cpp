#include "ArchiveControlReadiness.h"
#include "ArchiveFocusProbe.h"
#include "../src/WindowInputState.h"
#include <QElapsedTimer>
#include <QGuiApplication>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QSet>
#include <QTest>
#include <cmath>
#include <initializer_list>
#include <memory>

// The archive drawer's world book form scrolls, and its content editor follows
// the form's viewport height. An opening transition grows that viewport frame
// by frame. These cases step the body height the way those frames do.
class ArchiveDrawerScrollTest final : public QObject {
    Q_OBJECT
    // The full 1380x900 body, and a shorter body whose content editor is still
    // above its 100 px floor, so the content keeps following the viewport.
    static constexpr double kFullBody = 626;
    static constexpr double kShortBody = 546;
    std::unique_ptr<QQmlEngine> m_engine;
    std::unique_ptr<QQuickWindow> m_window;
    std::unique_ptr<QQuickItem> m_root;
    QQuickItem *m_drawer = nullptr;
    QQuickItem *m_form = nullptr;
    QQuickItem *m_formView = nullptr;
    qint64 m_presentedFrame = 0;
    QElapsedTimer m_inputClock;

    QQuickItem *named(const char *name) const { return m_drawer->findChild<QQuickItem *>(name); }
    double contentY() const { return m_formView->property("contentY").toDouble(); }
    double maximumY() const {
        return m_formView->property("contentHeight").toDouble() - m_formView->height();
    }
    // One frame: the body takes its new height, then layout and polish settle.
    void body(double height) {
        m_root->setProperty("bodyHeight", height);
        QTest::qWait(60);
    }
    // The name field lies wholly inside the form's viewport.
    bool nameExposed() const {
        auto *name = named("worldbookName");
        const QRectF rect = name->mapRectToItem(m_formView, QRectF(0, 0, name->width(), name->height()));
        return rect.top() >= -.5 && rect.bottom() <= m_formView->height() + .5;
    }
    // Scrolls the full form to its end, then shortens the body without
    // closing it. Shortening never pulls the offset back.
    double scrollToEndThenShorten() {
        body(kFullBody);
        const double end = maximumY();
        if (end <= 60) return -1;
        m_formView->setProperty("contentY", end);
        QTest::qWait(60);
        body(kShortBody);
        if (named("worldbook-content-scroll")->height() <= 100 || std::abs(contentY() - end) > 1)
            return -1;
        return end;
    }
    double growThrough(std::initializer_list<double> heights) {
        for (const double height : heights) body(height);
        return contentY();
    }

private slots:
    void initTestCase() {
        registerArchiveInteractionTypes();
        QQuickStyle::setStyle("Basic");
        // The offscreen platform has no OpenGL; layout and polish are unchanged.
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }
    void init() {
        m_engine = std::make_unique<QQmlEngine>();
        QQmlComponent component(m_engine.get(), QUrl("qrc:/archive-drawer-scroll/ArchiveDrawerScrollFixture.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        m_window = std::make_unique<QQuickWindow>();
        m_presentedFrame = 0;
        connect(m_window.get(), &QQuickWindow::afterAnimating, this, [this] { ++m_presentedFrame; });
        m_window->resize(640, 700);
        m_root.reset(qobject_cast<QQuickItem *>(component.create()));
        QVERIFY2(m_root, qPrintable(component.errorString()));
        m_root->setParentItem(m_window->contentItem());
        m_engine->rootContext()->setContextProperty("archiveEditor", m_root->property("editorStub").value<QObject *>());
        m_engine->rootContext()->setContextProperty("session", m_root->property("sessionStub").value<QObject *>());
        // An untyped QML function returns QVariant.
        QVariant created;
        QVERIFY(QMetaObject::invokeMethod(m_root.get(), "createDrawer", Q_RETURN_ARG(QVariant, created)));
        QVERIFY(created.toBool());
        m_drawer = m_root->property("drawer").value<QQuickItem *>();
        QVERIFY(m_drawer);
        m_form = named("worldbook-form-scroll");
        QVERIFY(m_form && named("worldbookName") && named("worldbook-content-scroll"));
        m_formView = m_form->property("contentItem").value<QQuickItem *>();
        QVERIFY(m_formView);
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
        QTest::qWait(60);
    }
    void cleanup() {
        m_root.reset();
        m_window.reset();
        m_engine.reset();
    }

private:
    void productViewport(int drawerWidth, int drawerHeight) {
        // SceneDirector::taskRectFor and ScenePortal::contentHost determine
        // these three registered product sizes. Compact means the task body
        // grows horizontally; it is not a 360 px single-column stress form.
        const QSize windowSize = drawerWidth == 862 ? QSize(950, 760)
            : drawerWidth == 672 ? QSize(760, 650) : QSize(1380, 900);
        m_window->resize(windowSize);
        m_root->setSize(QSizeF(windowSize));
        m_root->setProperty("drawerWidth", drawerWidth);
        body(drawerHeight);
    }
    QObject *editor() const { return m_root->property("editorStub").value<QObject *>(); }
    QVariantMap editorState() const {
        QVariantMap state;
        for (const auto *key : {"revision", "content", "title", "comment", "keywords", "secondaryKeywords", "useRegex", "dirty", "entryScanDepth", "entryTokenBudget", "saveCalls", "reloadCalls"})
            state[key] = editor()->property(key);
        return state;
    }
    bool prepareControl(const char *name, NativeArchiveControlReadiness::Region region,
                        const std::function<void(const NativeArchiveControlReadiness::Prepared &)> &action) {
        NativeArchiveControlReadiness::Gate gate;
        m_inputClock.start();
        NativeArchiveControlReadiness::Request request{region, QString::fromLatin1(name),
            [&, name] { return named(name); }, [this] {
                return QVariantMap{{"scope", "fixture-scope"}, {"generation", 1},
                                   {"revision", editor()->property("revision")}};
            }, [this] { return m_presentedFrame; }};
        NativeArchiveControlReadiness::Gate::Result result = NativeArchiveControlReadiness::Gate::Waiting;
        while (result == NativeArchiveControlReadiness::Gate::Waiting && m_inputClock.elapsed() < 4000) {
            result = gate.poll(m_window.get(), request, [&] { return m_inputClock.elapsed(); }, 4000, m_presentedFrame, action);
            if (result == NativeArchiveControlReadiness::Gate::Waiting) QTest::qWait(20);
        }
        return result == NativeArchiveControlReadiness::Gate::Performed;
    }

private slots:
    // Each taller viewport clamps the offset against content not yet relaid,
    // so a kept offset ends where the steps fell: one larger step pulls it
    // back further than two smaller ones, and neither returns to the top.
    void growingViewportKeepsAnOffsetThatDependsOnTheSteps() {
        const double end = scrollToEndThenShorten();
        QVERIFY2(end > 0, "the full form must scroll and the shorter body must keep its offset");
        const double oneStep = growThrough({kFullBody});
        QVERIFY(std::abs(maximumY() - end) <= 1);
        QVERIFY(!nameExposed());
        QVERIFY(scrollToEndThenShorten() > 0);
        const double twoSteps = growThrough({(kShortBody + kFullBody) / 2, kFullBody});
        qInfo("form end %.1f; after one step %.1f; after two steps %.1f", end, oneStep, twoSteps);
        QVERIFY(oneStep > 0);
        QVERIFY(oneStep < twoSteps);
        QVERIFY(twoSteps < end);
    }
    // Entering the drawer from closed starts the form at its top, whatever the
    // steps of the transition, and the name field is then fully shown.
    void enteringShowsTheFormStart() {
        for (const bool twoSteps : {false, true}) {
            QVERIFY(scrollToEndThenShorten() > 0);
            QMetaObject::invokeMethod(m_drawer, "showFormStart");
            const double after = twoSteps ? growThrough({(kShortBody + kFullBody) / 2, kFullBody})
                                          : growThrough({kFullBody});
            QCOMPARE(after, 0.);
            QVERIFY(nameExposed());
        }
        // From a nearly closed body as well.
        body(kFullBody);
        m_formView->setProperty("contentY", maximumY());
        QTest::qWait(60);
        body(120);
        QMetaObject::invokeMethod(m_drawer, "showFormStart");
        QCOMPARE(growThrough({300, 480, kFullBody}), 0.);
        QVERIFY(nameExposed());
    }
    void entryFormBodyReadiness_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height");
        QTest::addColumn<bool>("custom"); QTest::addColumn<int>("outerPosition");
        QTest::addColumn<bool>("longText"); QTest::addColumn<bool>("innerAtEnd");
        QTest::newRow("wide-inherit-top-short") << 591 << 626 << false << 0 << false << false;
        QTest::newRow("wide-custom-middle-long") << 591 << 626 << true << 1 << true << false;
        QTest::newRow("wide-inherit-bottom-inner-end") << 591 << 626 << false << 2 << true << true;
        QTest::newRow("compact-custom-top-short") << 862 << 474 << true << 0 << false << false;
        QTest::newRow("compact-inherit-middle-long") << 862 << 474 << false << 1 << true << false;
        QTest::newRow("compact-custom-bottom-inner-end") << 862 << 474 << true << 2 << true << true;
        QTest::newRow("narrow-inherit-top-short") << 672 << 364 << false << 0 << false << false;
        QTest::newRow("narrow-custom-middle-long") << 672 << 364 << true << 1 << true << false;
        QTest::newRow("narrow-inherit-bottom-inner-end") << 672 << 364 << false << 2 << true << true;
    }
    void entryFormBodyReadiness() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, custom); QFETCH(int, outerPosition);
        QFETCH(bool, longText); QFETCH(bool, innerAtEnd);
        editor()->setProperty("entryScanDepth", custom ? QVariant(5) : QVariant::fromValue(nullptr));
        editor()->setProperty("entryTokenBudget", custom ? QVariant(50) : QVariant::fromValue(nullptr));
        if (longText) editor()->setProperty("content", QString("First line selection text.\n").repeated(100));
        productViewport(width, height);
        m_formView->setProperty("contentY", maximumY() * outerPosition / 2.);
        auto *inner = named("worldbook-content-scroll")->property("contentItem").value<QQuickItem *>();
        QVERIFY(inner);
        if (innerAtEnd) inner->setProperty("contentY", std::max(0., inner->property("contentHeight").toDouble() - inner->height()));
        QTest::qWait(60);
        const auto before = editorState();
        int dispatches = 0;
        QVERIFY(prepareControl("worldbookContent", NativeArchiveControlReadiness::Region::BodyFirstLine,
            [&](const auto &prepared) {
                ++dispatches;
                const auto clip = NativeControlReadiness::visibleRect(prepared.target, m_window.get());
                QVERIFY(clip.contains(prepared.start)); QVERIFY(clip.contains(prepared.end));
                QVERIFY(prepared.start.y() <= prepared.target->mapToScene(QPointF(0, 24)).y());
                NativeArchiveControlReadiness::mouseSelect(m_window.get(), prepared,
                    [this] { return m_inputClock.elapsed(); }, 4000);
            }));
        QCOMPARE(dispatches, 1);
        QVERIFY(named("worldbookContent")->property("selectionEnd").toInt() > named("worldbookContent")->property("selectionStart").toInt());
        QCOMPARE(editorState(), before);
    }
    void bodyTitleBodyPreservesDraft_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height"); QTest::addColumn<bool>("longText");
        QTest::newRow("wide-short") << 591 << 626 << false;
        QTest::newRow("wide-long") << 591 << 626 << true;
        QTest::newRow("compact-long") << 862 << 474 << true;
        QTest::newRow("narrow-long") << 672 << 364 << true;
    }
    void bodyTitleBodyPreservesDraft() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, longText);
        if (longText) editor()->setProperty("content", QString("Preserved long archive draft.\n").repeated(100));
        productViewport(width, height);
        const auto before = editorState();
        for (const auto *name : {"worldbookContent", "worldbookName", "worldbookContent"}) {
            const auto region = QByteArray(name) == "worldbookName" ? NativeArchiveControlReadiness::Region::WholeItem : NativeArchiveControlReadiness::Region::BodyPoint;
            QVERIFY(prepareControl(name, region, [&](const auto &prepared) {
                NativeArchiveControlReadiness::mouseClick(m_window.get(), prepared,
                    [this] { return m_inputClock.elapsed(); }, 4000);
            }));
            QVERIFY(named(name)->hasActiveFocus());
        }
        QCOMPARE(editorState(), before);
        productViewport(591, int(kShortBody));
        QMetaObject::invokeMethod(m_drawer, "showFormStart");
        body(kFullBody);
        QCOMPARE(contentY(), 0.);
        QVERIFY(nameExposed());
        QCOMPARE(editorState(), before);
    }
    void regexPatternViewportHasIndependentSelectionAndScroll_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height"); QTest::addColumn<bool>("secondary");
        QTest::newRow("wide-primary-inner-end") << 591 << 626 << false;
        QTest::newRow("wide-secondary-inner-end") << 591 << 626 << true;
        QTest::newRow("compact-primary-inner-end") << 862 << 474 << false;
        QTest::newRow("compact-secondary-inner-end") << 862 << 474 << true;
        QTest::newRow("narrow-primary-inner-end") << 672 << 364 << false;
        QTest::newRow("narrow-secondary-inner-end") << 672 << 364 << true;
    }
    void regexPatternViewportHasIndependentSelectionAndScroll() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, secondary);
        editor()->setProperty("useRegex", true);
        editor()->setProperty(secondary ? "secondaryKeywords" : "keywords", QString("ID-(?:\\d{1,3})\n").repeated(80));
        productViewport(width, height);
        const char *name = secondary ? "worldbookRegexSecondaryKeywords" : "worldbookRegexKeywords";
        auto *field = named(name);
        auto *viewport = named(secondary ? "worldbook-regex-secondary-scroll" : "worldbook-regex-keywords-scroll");
        QVERIFY(field && viewport && field->isVisible());
        QVERIFY(viewport->height() > 0 && viewport->height() <= 120);
        auto *inner = viewport->property("contentItem").value<QQuickItem *>(); QVERIFY(inner);
        QVERIFY(inner->property("contentHeight").toDouble() > inner->height());
        inner->setProperty("contentY", inner->property("contentHeight").toDouble() - inner->height());
        m_formView->setProperty("contentY", maximumY()); QTest::qWait(60);
        const auto before = editorState(); int dispatched = 0;
        QVERIFY(prepareControl(name, NativeArchiveControlReadiness::Region::BodyFirstLine, [&](const auto &prepared) {
            QCOMPARE(prepared.target.data(), field); QCOMPARE(prepared.viewport.data(), viewport);
            QVERIFY(prepared.inner == inner && prepared.outer == m_formView);
            QVERIFY(NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool());
            ++dispatched;
            NativeArchiveControlReadiness::mouseSelect(m_window.get(), prepared,
                [this] { return m_inputClock.elapsed(); }, 4000);
        }));
        QCOMPARE(dispatched, 1); QVERIFY(field->hasActiveFocus());
        QVERIFY(field->property("selectionEnd").toInt() > field->property("selectionStart").toInt());
        QCOMPARE(field->property("textFormat").toInt(), int(Qt::PlainText));
        const auto text = field->property("text");
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        QTest::keyClick(m_window.get(), Qt::Key_Tab);
        QVERIFY(m_window->activeFocusItem() != field);
        QCOMPARE(field->property("text"), text);
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QCOMPARE(editorState(), before);
    }

    void insertionControlsUseWholeItemReadiness_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height"); QTest::addColumn<QString>("control");
        for (const auto &size : {QSize(591, 626), QSize(862, 474), QSize(672, 364)})
            for (const auto *control : {"worldbookInsertionPosition", "worldbookInsertionDepth", "worldbookInsertionRole"})
                QTest::newRow((QByteArray::number(size.width()) + "-" + control).constData()) << size.width() << size.height() << QString(control);
    }
    void insertionControlsUseWholeItemReadiness() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(QString, control);
        editor()->setProperty("insertionPosition", "at_depth"); productViewport(width, height);
        m_formView->setProperty("contentY", maximumY()); QTest::qWait(60);
        const auto before = editorState(); const auto position = editor()->property("insertionPosition");
        const auto depth = editor()->property("insertionDepth"), role = editor()->property("insertionRole");
        int dispatches = 0;
        QVERIFY(prepareControl(control.toUtf8().constData(), NativeArchiveControlReadiness::Region::WholeItem, [&](const auto &prepared) {
            ++dispatches; QVERIFY(NativeControlReadiness::wholeVisibility(prepared.target, m_window.get()).value("fullyVisible").toBool());
            NativeArchiveControlReadiness::mouseClick(m_window.get(), prepared, [this] { return m_inputClock.elapsed(); }, 4000);
        }));
        QCOMPARE(dispatches, 1); QTest::keyClick(m_window.get(), Qt::Key_Escape);
        auto *focused = m_window->activeFocusItem(); auto *target = named(control.toUtf8().constData());
        QVERIFY(focused && (focused == target || target->isAncestorOf(focused)));
        QCOMPARE(editorState(), before); QCOMPARE(editor()->property("insertionPosition"), position);
        QCOMPARE(editor()->property("insertionDepth"), depth); QCOMPARE(editor()->property("insertionRole"), role);
    }
    void insertionTabRevealsWithoutTestPositioning_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height");
        QTest::newRow("wide-injection-tab") << 591 << 626;
        QTest::newRow("compact-injection-tab") << 862 << 474;
        QTest::newRow("narrow-injection-tab") << 672 << 364;
    }
    void insertionTabRevealsWithoutTestPositioning() {
        QFETCH(int, width); QFETCH(int, height); editor()->setProperty("insertionPosition", "at_depth"); productViewport(width, height);
        QVERIFY(prepareControl("worldbookInsertionPosition", NativeArchiveControlReadiness::Region::WholeItem, [&](const auto &prepared) {
            prepared.target->forceActiveFocus(Qt::TabFocusReason);
        }));
        const auto before = editorState(); const auto positioning = NativeControlReadiness::testRevealCallCount;
        for (const auto *name : {"worldbookInsertionDepth", "worldbookInsertionRole"}) {
            QTest::keyClick(m_window.get(), Qt::Key_Tab);
            auto *target = named(name); auto *leaf = m_window->activeFocusItem();
            QVERIFY(target && leaf && (target == leaf || target->isAncestorOf(leaf)));
            QVERIFY(NativeControlReadiness::wholeVisibility(target, m_window.get()).value("fullyVisible").toBool());
            QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        }
        QCOMPARE(editorState(), before);
    }

    void realTabTraversalDoesNotUseReadinessScrolling_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height");
        QTest::newRow("wide") << 591 << 626;
        QTest::newRow("compact") << 862 << 474;
        QTest::newRow("narrow") << 672 << 364;
    }
    void realTabTraversalDoesNotUseReadinessScrolling() {
        QFETCH(int, width); QFETCH(int, height);
        productViewport(width, height);
        const auto before = editorState();
        QVERIFY(prepareControl("worldbookName", NativeArchiveControlReadiness::Region::WholeItem, [&](const auto &prepared) {
            NativeArchiveControlReadiness::mouseClick(m_window.get(), prepared,
                    [this] { return m_inputClock.elapsed(); }, 4000);
        }));
        QSet<QQuickItem *> visited;
        ArchiveFocusProbe probe;
        QVariantList records;
        QVariantMap trace{{"schema", "reverie.qt.archive-focus-traversal.v2"}, {"windowToken", "window-1"}, {"scope", "fixture-scope"},
            {"generation", 1}, {"deadlineMs", 4000}, {"startElapsedMs", m_inputClock.elapsed()},
            {"phase", "tab-visible-controls"}, {"step", 28},
            {"initialPositioningCount", qint64(NativeControlReadiness::testRevealCallCount)}};
        for (int index = 0; index < 24; ++index) {
            auto *focused = m_window->activeFocusItem();
            const bool bodyFocused = focused && (focused == named("worldbookContent") || named("worldbookContent")->isAncestorOf(focused));
            const auto key = bodyFocused || index >= 12 ? Qt::Key_Backtab : Qt::Key_Tab;
            QVariantMap row{{"index", index}, {"step", 28}, {"direction", key == Qt::Key_Tab ? "Tab" : "Backtab"},
                {"scope", "fixture-scope"}, {"generation", 1}, {"bodyFocused", bodyFocused},
                {"inputCount", 0}, {"immediate", true}, {"before", probe.snapshot(m_window.get(), m_drawer)},
                {"positioningBefore", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameBefore", m_presentedFrame}, {"elapsedBeforeMs", m_inputClock.elapsed()}};
            // No positioning or event wait follows the key. Preserve the actual
            // immediate leaf rectangle, including the first failing observation.
            ArchiveFocusProbe::beginObservation(m_drawer);
            int dispatchCount = 0;
            ++dispatchCount;
            QTest::keyClick(m_window.get(), key);
            row["inputCount"] = dispatchCount;
            row["causal"] = ArchiveFocusProbe::causalSnapshot(m_drawer);
            focused = m_window->activeFocusItem();
            row.insert({{"after", probe.snapshot(m_window.get(), m_drawer)},
                {"positioningAfter", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameAfter", m_presentedFrame}, {"elapsedAfterMs", m_inputClock.elapsed()}});
            records.append(row); trace["records"] = records; trace["endElapsedMs"] = row["elapsedAfterMs"];
            qInfo().noquote() << "ARCHIVE_FOCUS_TRACE" << ArchiveFocusProbe::json(trace);
            const auto reason = ArchiveFocusProbe::context(row).toUtf8();
            QVERIFY2(focused && focused->isVisible() && focused->isEnabled(), reason.constData());
            QVERIFY2(!NativeControlReadiness::visibleRect(focused, m_window.get()).isEmpty(), reason.constData());
            QCOMPARE(row["positioningBefore"], row["positioningAfter"]);
            QVERIFY2(!row["causal"].toMap()["overflow"].toBool(), "[ARCHIVE_FOCUS_CAUSAL] bounded observation overflow");
            QVERIFY(m_inputClock.elapsed() < 4000);
            visited.insert(focused);
        }
        QVERIFY(visited.size() >= 3);
        QCOMPARE(editorState(), before);
    }

};

QTEST_MAIN(ArchiveDrawerScrollTest)
#include "ArchiveDrawerScrollTest.moc"
