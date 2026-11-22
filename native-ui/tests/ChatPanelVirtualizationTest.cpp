#include <QElapsedTimer>
#include <QColor>
#include <QGuiApplication>
#include <QJsonDocument>
#include <QJSValue>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QTest>
#include <algorithm>
#include <memory>
#include <stdexcept>
#include <utility>
#include "ReadingSelectionProbe.h"

// Stands in for the RuntimeBridge properties ChatPanel reads. Like the bridge,
// every message update replaces the whole QVariantList.
class FixtureSession final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList messages READ messages NOTIFY messagesChanged)
    Q_PROPERTY(QVariantMap state READ state NOTIFY changed)
    Q_PROPERTY(QVariantMap chatFeedback READ chatFeedback NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(bool connected READ connected NOTIFY changed)
    Q_PROPERTY(QString draft READ draft WRITE setDraft NOTIFY changed)
    Q_PROPERTY(bool reducedMotion READ reducedMotion CONSTANT)
    Q_PROPERTY(bool reducedTransparency READ reducedTransparency CONSTANT)
public:
    QVariantList messages() const { return m_messages; }
    void setMessages(QVariantList messages) {
        m_messages = std::move(messages);
        emit messagesChanged();
    }
    QVariantMap state() const { return m_state; }
    void setOffline(bool value) { m_state["offline"] = value; emit changed(); }
    QVariantMap chatFeedback() const { return m_chatFeedback; }
    void setChatFeedback(const QVariantMap &feedback) {
        m_chatFeedback = feedback;
        emit changed();
    }
    bool busy() const { return m_busy; }
    void setBusy(bool value) { m_busy = value; emit changed(); }
    bool connected() const { return true; }
    QString draft() const { return m_draft; }
    void setDraft(const QString &draft) {
        if (draft == m_draft) return;
        m_draft = draft;
        emit changed();
    }
    bool reducedMotion() const { return false; }
    bool reducedTransparency() const { return false; }
    Q_INVOKABLE void sendChat() {}
    Q_INVOKABLE void cancelChat() {}
signals:
    void messagesChanged();
    void changed();

private:
    QVariantList m_messages;
    QString m_draft;
    QVariantMap m_chatFeedback;
    QVariantMap m_state;
    bool m_busy = false;
};

class ChatPanelVirtualizationTest final : public QObject {
    Q_OBJECT
    // Rows a companion view may hold: the latest exchange, a few hidden rows in
    // the view's cache, and replacement rows not yet released.
    static constexpr int kRowBudget = 12;
    std::unique_ptr<FixtureSession> m_session;
    std::unique_ptr<QQmlEngine> m_engine;
    std::unique_ptr<QQuickWindow> m_window;
    std::unique_ptr<QQuickItem> m_root;
    QQuickItem *m_chat = nullptr;
    QQuickItem *m_history = nullptr;
    QObject *m_director = nullptr;

    static QVariantMap message(int index, const QString &role) {
        QString content;
        if (role == "user") {
            content = QString("第 %1 条：今晚的月光很安静，想和你聊聊。").arg(index);
        } else {
            for (int paragraph = 0; paragraph < 6; ++paragraph)
                content += QString("第 %1 条回复第 %2 段。窗外的云慢慢移过湖面，灯光在玻璃上留下柔和的边缘。\n")
                               .arg(index)
                               .arg(paragraph);
        }
        return {{"id", QString("m-%1").arg(index)}, {"role", role}, {"content", content}};
    }
    static QVariantList conversation(int count) {
        QVariantList messages;
        for (int index = 0; index < count; ++index)
            messages.append(message(index, index % 2 ? "assistant" : "user"));
        return messages;
    }
    static void flushDeletes() { QCoreApplication::sendPostedEvents(nullptr, QEvent::DeferredDelete); }
    QQuickItem *contentItem() const { return m_history->property("contentItem").value<QQuickItem *>(); }
    QList<QQuickItem *> rows() const {
        flushDeletes();
        QList<QQuickItem *> found;
        for (auto *item : contentItem()->childItems())
            if (item->objectName().startsWith("chatMessageRow-")) found.append(item);
        return found;
    }
    QQuickItem *row(int index) const {
        for (auto *item : rows())
            if (item->objectName() == QString("chatMessageRow-m-%1").arg(index)) return item;
        return nullptr;
    }
    QQuickItem *messageText(int index) const {
        auto *item = row(index);
        return item ? item->findChild<QQuickItem *>(QString("chatMessage-m-%1").arg(index)) : nullptr;
    }
    double top(QQuickItem *item) const { return item->mapToItem(m_history, QPointF()).y(); }
    QStringList visibleRows() const {
        QStringList names;
        for (auto *item : rows()) {
            const double y = top(item);
            if (item->isVisible() && item->height() > 0 && y < m_history->height() && y + item->height() > 0)
                names.append(item->objectName());
        }
        names.sort();
        return names;
    }
    void setDirector(std::initializer_list<std::pair<const char *, QVariant>> values) {
        for (const auto &[name, value] : values) m_director->setProperty(name, value);
    }
    // Mirrors SceneDirector: the reading body has faded out when the chat
    // layout flips at the middle of the read blend.
    void transition(bool reading) {
        setDirector({{"chatInputReady", false}, {"readBodyOpacity", 0.}, {"readBlend", .5},
                     {"mode", reading ? "reading" : "companion"}});
        m_director->setProperty("chatLayoutReading", reading);
        QTest::qWait(60);
        setDirector({{"readBlend", reading ? 1. : 0.}, {"readBodyOpacity", 1.}, {"chatInputReady", true}});
    }
    void settle() {
        QTRY_VERIFY(!m_chat->property("layoutRestorePending").toBool());
        QTest::qWait(150);
        QVERIFY(!m_chat->property("layoutRestorePending").toBool());
    }
    void markRows(const char *marker) {
        for (auto *item : rows()) item->setProperty(marker, true);
    }
    int unmarkedRows(const char *marker) const {
        int count = 0;
        for (auto *item : rows())
            if (!item->property(marker).toBool()) ++count;
        return count;
    }
    void verifyCompanionExchange(int user, int assistant) {
        auto *userRow = row(user);
        auto *assistantRow = row(assistant);
        QVERIFY(userRow && assistantRow);
        QCOMPARE(visibleRows(), QStringList({userRow->objectName(), assistantRow->objectName()}));
        QVERIFY2(qAbs(top(userRow)) < .5, qPrintable(QString::number(top(userRow))));
        QVERIFY(qAbs(top(assistantRow) - top(userRow) - userRow->height()) < .5);
    }
    void prepareProbeMessages(const QStringList &texts, qreal readingHeight = 640) {
        QVariantList messages;
        for (int i = 0; i < texts.size(); ++i)
            messages.append(QVariantMap{{"id", QString("m-%1").arg(i)}, {"role", "assistant"},
                                        {"content", texts.at(i)}});
        m_session->setMessages(messages);
        const int windowHeight = qMax(900, int(readingHeight + 120));
        m_window->resize(1380, windowHeight);
        m_root->setSize(QSizeF(1380, windowHeight));
        setDirector({{"readingRect", QRectF(420, 40, 640, readingHeight)}});
        transition(true);
        settle();
        QVERIFY(m_chat->property("inputReady").toBool());
    }
    ReadingSelectionProbe::ProbeResult readingProbe(bool ready = true) const {
        return ReadingSelectionProbe::probe(m_history, m_window.get(),
            ready && m_chat->property("inputReady").toBool(), [] { return qint64(0); }, 1000);
    }
    static QVariantMap probeRecord(const ReadingSelectionProbe::ProbeResult &result,
                                   const QString &name) {
        for (const auto &value : result.diagnostic.value("items").toList()) {
            const auto record = value.toMap();
            if (record.value("name").toString() == name) return record;
        }
        return {};
    }
    static QByteArray probeJson(const ReadingSelectionProbe::ProbeResult &result) {
        return QJsonDocument::fromVariant(result.diagnostic).toJson(QJsonDocument::Compact);
    }
    QVariantMap probeObservedState(QQuickItem *text) const {
        return {{"contentY", m_history->property("contentY")},
                {"cursorPosition", text->property("cursorPosition")},
                {"selectionStart", text->property("selectionStart")},
                {"selectionEnd", text->property("selectionEnd")},
                {"readingPointerActive", m_chat->property("readingPointerActive")}};
    }

private slots:
    void initTestCase() {
        QQuickStyle::setStyle("Basic");
        // The offscreen platform has no OpenGL; layout and polish are unchanged.
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }
    void init() {
        m_session = std::make_unique<FixtureSession>();
        m_session->setMessages(conversation(300));
        m_engine = std::make_unique<QQmlEngine>();
        m_engine->rootContext()->setContextProperty("session", m_session.get());
        QQmlComponent component(m_engine.get(), QUrl("qrc:/chat-virtualization/ChatPanelVirtualizationFixture.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        m_window = std::make_unique<QQuickWindow>();
        m_window->resize(1380, 900);
        m_root.reset(qobject_cast<QQuickItem *>(component.create()));
        QVERIFY2(m_root, qPrintable(component.errorString()));
        m_root->setParentItem(m_window->contentItem());
        m_chat = m_root->findChild<QQuickItem *>("fixtureChat");
        m_history = m_root->findChild<QQuickItem *>("chatHistory");
        m_director = m_root->findChild<QObject *>("fixtureDirector");
        QVERIFY(m_chat && m_history && m_director);
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
        settle();
    }
    void cleanup() {
        m_root.reset();
        m_window.reset();
        m_engine.reset();
        m_session.reset();
    }

    void providerFailureReasonIsVisibleAndUsesExistingErrorStyle() {
        const QString text = "服务拒绝了密钥，请检查 API Key。（HTTP 401）";
        auto *label = m_root->findChild<QQuickItem *>("chatFeedbackText");
        QVERIFY(label);
        for (const QString &status : QStringList{"failed", "failed_uncertain"}) {
            m_session->setChatFeedback({{"status", status}, {"text", text}, {"requestId", "provider-failure-fixture"}});
            QTRY_COMPARE(label->property("text").toString(), text);
            settle();
            QVERIFY(label->isVisible());
            QVERIFY(m_chat->property("feedbackIsError").toBool());
            QCOMPARE(label->property("color").value<QColor>(), QColor("#e6b4a4"));
            QVERIFY(label->width() > 0 && label->height() > 0);
            QVERIFY(!label->property("truncated").toBool());
        }
    }
    void terminalFeedbackVisibleWithoutBusyAndSurvivesReadingSwitch() {
        const QString text = "回复结果尚未确认，未自动重试。你可以继续阅读已有消息。";
        m_session->setDraft("保留下一条草稿");
        m_session->setChatFeedback({{"status", "failed_uncertain"}, {"text", text}, {"requestId", "fixture-request"}});
        auto *label = m_root->findChild<QQuickItem *>("chatFeedbackText");
        QVERIFY(label);
        QTRY_COMPARE(label->property("text").toString(), text);
        QVERIFY(label->isVisible());
        QVERIFY(!m_session->busy());
        transition(true);
        settle();
        QCOMPARE(label->property("text").toString(), text);
        m_window->resize(760, 650);
        m_root->setSize(QSizeF(760, 650));
        setDirector({{"readingRect", QRectF(230, 80, 510, 450)}});
        settle();
        QVERIFY(label->isVisible());
        QVERIFY(label->width() > 100);
        QVERIFY(!label->property("truncated").toBool());
        QCOMPARE(m_session->draft(), QString("保留下一条草稿"));
        m_session->setChatFeedback({{"status", "cancelled"}, {"text", "本次回复已停止"}});
        QTRY_COMPARE(label->property("text").toString(), QString("本次回复已停止"));
        m_session->setChatFeedback({});
        QTRY_VERIFY(!label->isVisible());
    }

    void cancellationFeedbackSurvivesProgressAndTerminalWins() {
        m_session->setBusy(true);
        m_session->setDraft("下一条尚未发送的草稿");
        const QString pending = "正在请求停止，等待结束确认…";
        const QString unknown = "停止结果尚未确认，未自动重试。";
        m_session->setChatFeedback({{"status", "generating"}, {"text", "正在生成回复…"},
            {"cancel", QVariantMap{{"status", "pending"}, {"text", pending}}}});
        auto *label = m_root->findChild<QQuickItem *>("chatFeedbackText");
        auto *send = m_root->findChild<QQuickItem *>("sendChat");
        auto *compact = m_root->findChild<QQuickItem *>("compactStop");
        QVERIFY(label && send && compact);
        QTRY_COMPARE(label->property("text").toString(), pending);
        QVERIFY(!send->isEnabled());
        QCOMPARE(compact->property("text").toString(), QString("正在停止…"));
        m_session->setChatFeedback({{"status", "delivering"}, {"text", "正在送达回复…"},
            {"cancel", QVariantMap{{"status", "unknown"}, {"text", unknown}}}});
        QTRY_COMPARE(label->property("text").toString(), unknown);
        QTRY_VERIFY(send->isEnabled());
        transition(true);
        settle();
        QCOMPARE(label->property("text").toString(), unknown);
        m_session->setBusy(false);
        m_session->setChatFeedback({{"status", "done"}, {"text", "已回复"},
            {"cancel", QVariantMap{{"status", "unknown"}, {"text", unknown}}}});
        QTRY_COMPARE(label->property("text").toString(), QString("已回复"));
        QCOMPARE(m_session->draft(), QString("下一条尚未发送的草稿"));
    }

    void transientAndConditionalFeedbackClear() {
        auto *label = m_root->findChild<QQuickItem *>("chatFeedbackText");
        auto *compact = m_root->findChild<QQuickItem *>("companionChatFeedback");
        QVERIFY(label && compact);
        m_chat->setProperty("doneNoticeMs", 150);
        m_session->setChatFeedback({{"status", "done"}, {"text", "已回复"}, {"requestId", "fixture-done"}});
        QTRY_COMPARE(label->property("text").toString(), QString("已回复"));
        // Unrelated bridge updates re-emit the same feedback; the cue must still end.
        m_session->setChatFeedback({{"status", "done"}, {"text", "已回复"}, {"requestId", "fixture-done"}});
        QTRY_VERIFY(!label->isVisible());
        QVERIFY(!compact->property("text").toString().contains("已回复"));
        m_session->setOffline(true);
        m_session->setChatFeedback({{"status", "paused"}, {"text", "模型网络调用已暂停，输入已保留。"}});
        QTRY_COMPARE(label->property("text").toString(), QString("模型网络调用已暂停，输入已保留。"));
        m_session->setOffline(false);
        QTRY_VERIFY(!label->isVisible());
        m_session->setChatFeedback({{"status", "cancelled"}, {"text", "本次回复已停止"}});
        QTRY_COMPARE(label->property("text").toString(), QString("本次回复已停止"));
        QTest::qWait(300);
        QVERIFY(label->isVisible());
    }

    void companionHoldsOnlyTheLatestExchange() {
        const int held = rows().size();
        qInfo("companion rows held for 300 messages: %d", held);
        QVERIFY2(held <= kRowBudget, qPrintable(QString::number(held)));
        verifyCompanionExchange(298, 299);
        const double expected = std::max(170., row(298)->height() + row(299)->height() + 78);
        QCOMPARE(m_chat->property("companionHistoryHeight").toDouble(), expected);
        // Estimated extents of uncreated rows must not keep re-arming restores.
        const int requests = m_chat->property("restoreRequestCount").toInt();
        QTest::qWait(400);
        QCOMPARE(m_chat->property("restoreRequestCount").toInt(), requests);
    }

    void assistantOnlyHistoryShowsTheLatestReply() {
        QVariantList messages;
        for (int index = 0; index < 300; ++index) messages.append(message(index, "assistant"));
        m_session->setMessages(messages);
        settle();
        QVERIFY(rows().size() <= kRowBudget);
        QCOMPARE(visibleRows(), QStringList({row(299)->objectName()}));
        QVERIFY(qAbs(top(row(299))) < .5);
    }

    void readingCloseCreatesOnlyTheExchange() {
        transition(true);
        settle();
        // Leave the reading view at an older row with a selected passage.
        QVERIFY(QMetaObject::invokeMethod(m_history, "positionViewAtIndex", Q_ARG(int, 150), Q_ARG(int, 0)));
        m_history->setProperty("contentY", m_history->property("contentY").toDouble() + 23);
        m_chat->setProperty("followLatest", false);
        QVERIFY(QMetaObject::invokeMethod(m_chat, "captureReadingAnchor"));
        auto anchorValue = m_chat->property("readingAnchor");
        if (anchorValue.metaType() == QMetaType::fromType<QJSValue>())
            anchorValue = anchorValue.value<QJSValue>().toVariant();
        const auto anchor = anchorValue.toMap();
        QCOMPARE(anchor.value("messageId").toString(), QString("m-150"));
        auto *selected = messageText(150);
        QVERIFY(selected);
        QVERIFY(QMetaObject::invokeMethod(selected, "select", Q_ARG(int, 5), Q_ARG(int, 20)));
        const double anchorTop = top(row(150));

        markRows("beforeClose");
        QElapsedTimer closing;
        closing.start();
        transition(false);
        settle();
        const int created = unmarkedRows("beforeClose");
        qInfo("reading close: rows created %d, rows held %d, settle %lld ms (offscreen software, informative)",
              created, int(rows().size()), closing.elapsed());
        QVERIFY2(created <= kRowBudget, qPrintable(QString::number(created)));
        QVERIFY2(rows().size() <= kRowBudget, qPrintable(QString::number(rows().size())));
        verifyCompanionExchange(298, 299);

        transition(true);
        settle();
        QVERIFY(row(150));
        QVERIFY2(qAbs(top(row(150)) - anchorTop) < 2,
                 qPrintable(QString("%1 vs %2").arg(top(row(150))).arg(anchorTop)));
        selected = messageText(150);
        QVERIFY(selected);
        QCOMPARE(selected->property("selectionStart").toInt(), 5);
        QCOMPARE(selected->property("selectionEnd").toInt(), 20);
    }

    void identicalListReplacementTemporarilyBlocksMessageRows() {
        QVERIFY(m_chat->property("inputReady").toBool());
        auto *target = row(299);
        QVERIFY(target && target->isVisible() && target->isEnabled());
        const auto messages = m_session->messages();

        m_session->setMessages(messages);

        // Observe the same turn, before the restore timer can run.
        QVERIFY(!m_chat->property("inputReady").toBool());
        auto *blockedTarget = row(299);
        QVERIFY(!blockedTarget || !blockedTarget->isVisible() || !blockedTarget->isEnabled());
        QCOMPARE(m_session->messages(), messages);

        QTRY_VERIFY(m_chat->property("inputReady").toBool());
        const auto targetUsable = [this] {
            auto *restored = row(299);
            return restored && restored->isVisible() && restored->isEnabled();
        };
        QTRY_VERIFY(targetUsable());
    }

    void replacedListKeepsTheExchangeInPlace() {
        markRows("beforeSend");
        auto messages = m_session->messages();
        messages.append(message(300, "user"));
        m_session->setMessages(messages);
        // No event processing: the next frame must already show the new turn.
        const int created = unmarkedRows("beforeSend");
        qInfo("list replacement: rows created %d", created);
        QVERIFY2(created <= kRowBudget, qPrintable(QString::number(created)));
        QVERIFY(row(300));
        QCOMPARE(visibleRows(), QStringList({row(300)->objectName()}));
        QVERIFY2(qAbs(top(row(300))) < .5, qPrintable(QString::number(top(row(300)))));

        messages.append(message(301, "assistant"));
        m_session->setMessages(messages);
        verifyCompanionExchange(300, 301);
        settle();
        verifyCompanionExchange(300, 301);
        QVERIFY(rows().size() <= kRowBudget);
    }

    void tallExchangeShowsItsEnd() {
        m_director->setProperty("companionHeightLimit", 170);
        settle();
        auto *assistantRow = row(299);
        QVERIFY(assistantRow && assistantRow->isVisible());
        const double bottom = top(assistantRow) + assistantRow->height();
        QVERIFY2(qAbs(bottom - m_history->height()) < .5,
                 qPrintable(QString("%1 vs %2").arg(bottom).arg(m_history->height())));
        QVERIFY(rows().size() <= kRowBudget);
    }

    void readingProbeAcceptsCompleteShortLines_data() {
        QTest::addColumn<QString>("text");
        QTest::newRow("one-line") << QString(40, QLatin1Char('a'));
        QTest::newRow("two-lines") << (QString(36, QLatin1Char('a')) + '\n' +
                                      QString(36, QLatin1Char('b')));
    }
    void readingProbeAcceptsCompleteShortLines() {
        QFETCH(QString, text);
        prepareProbeMessages({text});
        auto *item = messageText(0);
        QVERIFY(item);
        QVERIFY(item->height() < 50);
        const auto before = probeObservedState(item);
        const auto focus = QPointer<QQuickItem>(m_window->activeFocusItem());
        const auto result = readingProbe();
        QVERIFY2(result.hasCandidate(), probeJson(result).constData());
        const auto record = probeRecord(result, item->objectName());
        QVERIFY(!record.value("oldHeightGate").toBool());
        QVERIFY(record.value("oldTextLengthGate").toBool());
        QVERIFY(record.value("oldWidthGate").toBool());
        QVERIFY(result.candidate.trimmedLength >= 4);
        QVERIFY(result.candidate.lastPosition > result.candidate.firstPosition);
        QCOMPARE(result.candidate.start.y(), result.candidate.end.y());
        QCOMPARE(probeObservedState(item), before);
        QCOMPARE(QPointer<QQuickItem>(m_window->activeFocusItem()), focus);
    }

    void readingProbeRetainsLengthAndWidthGates_data() {
        QTest::addColumn<int>("length");
        QTest::addColumn<qreal>("width");
        QTest::addColumn<bool>("accepted");
        QTest::newRow("length-32-rejected") << 32 << qreal(500) << false;
        QTest::newRow("length-33-accepted") << 33 << qreal(500) << true;
        QTest::newRow("width-180-rejected") << 40 << qreal(180) << false;
        QTest::newRow("width-181-accepted") << 40 << qreal(181) << true;
    }
    void readingProbeRetainsLengthAndWidthGates() {
        QFETCH(int, length);
        QFETCH(qreal, width);
        QFETCH(bool, accepted);
        prepareProbeMessages({QString(length, QLatin1Char('a'))});
        auto *item = messageText(0);
        QVERIFY(item);
        item->setWidth(width);
        settle();
        const auto result = readingProbe();
        QCOMPARE(result.hasCandidate(), accepted);
        const auto record = probeRecord(result, item->objectName());
        QCOMPARE(record.value("oldTextLengthGate").toBool(), length > 32);
        QCOMPARE(record.value("oldWidthGate").toBool(), width > 180);
    }

    void readingProbeRejectsPartialLineAndUsesNextCompleteLine_data() {
        QTest::addColumn<bool>("secondLine");
        QTest::newRow("partial-only") << false;
        QTest::newRow("partial-then-complete") << true;
    }
    void readingProbeRejectsPartialLineAndUsesNextCompleteLine() {
        QFETCH(bool, secondLine);
        const QString line(40, QLatin1Char('a'));
        prepareProbeMessages({secondLine ? line + '\n' + line : line});
        auto *item = messageText(0);
        QVERIFY(item && item->parentItem());
        QRectF caret;
        QVERIFY(QMetaObject::invokeMethod(item, "positionToRectangle", Q_RETURN_ARG(QRectF, caret),
                                          Q_ARG(int, 0)));
        QVERIFY(caret.height() > 0);
        item->parentItem()->setClip(true);
        item->setY(-caret.height() / 2);
        item->parentItem()->setHeight(caret.height() * (secondLine ? 1.5 : .5));
        const auto result = readingProbe();
        QCOMPARE(result.hasCandidate(), secondLine);
        if (secondLine) QVERIFY(result.candidate.firstPosition >= line.size() + 1);
        else QVERIFY(probeRecord(result, item->objectName()).value("reasons").toStringList()
                         .contains("no-complete-visible-line-span"));
    }

    void readingProbeHonorsEffectiveInputGates_data() {
        QTest::addColumn<QString>("gate");
        for (const auto *gate : {"hidden-item", "hidden-parent", "disabled-item", "disabled-parent",
                                 "opacity-item", "opacity-product", "not-ready"})
            QTest::newRow(gate) << QString::fromLatin1(gate);
    }
    void readingProbeHonorsEffectiveInputGates() {
        QFETCH(QString, gate);
        prepareProbeMessages({QString(40, QLatin1Char('a'))});
        auto *item = messageText(0);
        QVERIFY(item && item->parentItem());
        if (gate == "hidden-item") item->setVisible(false);
        if (gate == "hidden-parent") item->parentItem()->setVisible(false);
        if (gate == "disabled-item") item->setEnabled(false);
        if (gate == "disabled-parent") item->parentItem()->setEnabled(false);
        if (gate == "opacity-item") item->setOpacity(.05);
        if (gate == "opacity-product") { item->setOpacity(.2); item->parentItem()->setOpacity(.2); }
        const auto result = readingProbe(gate != "not-ready");
        QVERIFY(!result.hasCandidate());
        QVERIFY(!probeRecord(result, item->objectName()).value("reasons").toStringList().isEmpty());
        if (gate == "not-ready") {
            const auto ready = readingProbe();
            QVERIFY2(ready.hasCandidate(), probeJson(ready).constData());
        }
    }

    void readingProbeContinuesAfterAnUnusableFirstCandidate() {
        prepareProbeMessages({QString(48, QLatin1Char(' ')), QString(40, QLatin1Char('a'))});
        const auto result = readingProbe();
        QVERIFY2(result.hasCandidate(), probeJson(result).constData());
        QCOMPARE(result.candidate.messageId, QString("m-1"));
        const auto records = result.diagnostic.value("items").toList();
        QVERIFY(records.size() >= 2);
        QCOMPARE(records.first().toMap().value("name").toString(), QString("chatMessage-m-0"));
        QVERIFY(records.first().toMap().value("reasons").toStringList()
                    .contains("no-complete-visible-line-span"));
    }

    void readingProbeUsesValidUtf16AtExactIntegerPoints() {
        const QString text = QString::fromUtf8("中文🙂 English mixed 🙂文本 ABCDEFGHIJKLMNOPQRSTUVWXYZ 0123456789");
        prepareProbeMessages({text});
        const auto result = readingProbe();
        QVERIFY2(result.hasCandidate(), probeJson(result).constData());
        const auto candidate = result.candidate;
        QVERIFY(ReadingSelectionProbe::detail::validUtf16Span(text, candidate.firstPosition,
                                                             candidate.lastPosition));
        QVERIFY(text.mid(candidate.firstPosition, candidate.lastPosition - candidate.firstPosition)
                    .contains(QString::fromUtf8("🙂")));
        auto *item = candidate.item.data();
        QVERIFY(item);
        for (const auto &endpoint : {std::make_pair(candidate.start, candidate.firstPosition),
                                     std::make_pair(candidate.end, candidate.lastPosition)}) {
            const auto local = item->mapFromScene(endpoint.first);
            int hit = -1;
            QVERIFY(QMetaObject::invokeMethod(item, "positionAt", Q_RETURN_ARG(int, hit),
                                              Q_ARG(qreal, local.x()), Q_ARG(qreal, local.y())));
            QCOMPARE(hit, endpoint.second);
        }
        const auto diagnostic = probeJson(result);
        QVERIFY(!diagnostic.contains(text.toUtf8()));
        QVERIFY(!diagnostic.contains("English mixed"));
        // A boundary or span containing half an emoji is never eligible.
        const QString emoji = QString::fromUtf8("🙂");
        QVERIFY(!ReadingSelectionProbe::detail::validUtf16Span(emoji, 0, 1));
        QVERIFY(!ReadingSelectionProbe::detail::validUtf16Span(emoji, 1, 2));
    }

    void readingProbeRevalidatesDelayedAndMovedTarget() {
        prepareProbeMessages({QString(40, QLatin1Char('a'))});
        const auto result = readingProbe();
        QVERIFY(result.hasCandidate());
        qint64 now = 0;
        const ReadingSelectionProbe::Clock clock = [&] { return now; };
        ReadingSelectionProbe::Candidate live;
        QTest::qWait(25);
        QVERIFY(ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                  clock, 100, &live));
        QCOMPARE(live.item, result.candidate.item);
        QCOMPARE(live.start, result.candidate.start);
        QCOMPARE(live.end, result.candidate.end);
        QVERIFY(ReadingSelectionProbe::revalidate(live, m_history, m_window.get(), true,
                                                  clock, 100, &live));
        QCOMPARE(live.messageId, result.candidate.messageId);
        QCOMPARE(live.start, result.candidate.start);
        QCOMPARE(live.end, result.candidate.end);
        auto *item = live.item.data();
        QVERIFY(item);
        const qreal x = item->x();
        item->setX(x + 80);
        QVERIFY(!ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                   clock, 100));
        item->setX(x);
        now = 100;
        QVERIFY(!ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                   clock, 100));
    }

    void readingProbeRejectsDeletedOrReplacedTarget_data() {
        QTest::addColumn<bool>("replace");
        QTest::newRow("deleted-during-live-clock") << false;
        QTest::newRow("same-id-new-delegate") << true;
    }
    void readingProbeRejectsDeletedOrReplacedTarget() {
        QFETCH(bool, replace);
        prepareProbeMessages({QString(40, QLatin1Char('a'))});
        const auto result = readingProbe();
        QVERIFY(result.hasCandidate());
        QPointer<QQuickItem> original = result.candidate.item;
        if (replace) {
            m_session->setMessages({QVariantMap{{"id", "m-0"}, {"role", "assistant"},
                                               {"content", QString(40, QLatin1Char('b'))}}});
            settle();
            QTRY_VERIFY(original.isNull());
            QVERIFY(!ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                       [] { return qint64(0); }, 100));
            const auto replacement = readingProbe();
            QVERIFY2(replacement.hasCandidate(), probeJson(replacement).constData());
            QCOMPARE(replacement.candidate.messageId, result.candidate.messageId);
        } else {
            bool deleted = false;
            const ReadingSelectionProbe::Clock clock = [&] {
                if (!deleted) { deleted = true; delete original.data(); }
                return qint64(0);
            };
            QVERIFY(!ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                       clock, 100));
            QVERIFY(deleted);
            QVERIFY(original.isNull());
        }
    }

    void readingProbeDeadlineAndRepeatedDiscoveryDoNotMutate() {
        prepareProbeMessages({QString(40, QLatin1Char('a'))});
        auto *item = messageText(0);
        QVERIFY(item);
        const auto before = probeObservedState(item);
        const auto focus = QPointer<QQuickItem>(m_window->activeFocusItem());
        for (int attempt = 0; attempt < 3; ++attempt) {
            const auto result = readingProbe();
            QVERIFY(result.hasCandidate());
            QVERIFY(ReadingSelectionProbe::revalidate(result.candidate, m_history, m_window.get(), true,
                                                       [] { return qint64(0); }, 100));
        }
        int ticks = 0;
        const auto expired = ReadingSelectionProbe::probe(m_history, m_window.get(), true,
            [&] { return qint64(++ticks); }, 8);
        QVERIFY(!expired.hasCandidate());
        QVERIFY(expired.diagnostic.value("deadlineReached").toBool());
        QVERIFY(ticks >= 8);
        QCOMPARE(probeObservedState(item), before);
        QCOMPARE(QPointer<QQuickItem>(m_window->activeFocusItem()), focus);
    }

    void readingProbeReportsItemAndLineCapsAndEmptyHistory() {
        QStringList shortMessages;
        for (int i = 0; i < 70; ++i) shortMessages.append("short");
        prepareProbeMessages(shortMessages, 4200);
        QTRY_VERIFY(rows().size() >= 70);
        const auto cappedItems = readingProbe();
        QVERIFY(!cappedItems.hasCandidate());
        QVERIFY(cappedItems.diagnostic.value("candidateCount").toInt() >= 70);
        QVERIFY(cappedItems.diagnostic.value("candidateCountComplete").toBool());
        QVERIFY(cappedItems.diagnostic.value("candidatesTruncated").toBool());
        QCOMPARE(cappedItems.diagnostic.value("items").toList().size(), ReadingSelectionProbe::CandidateLimit);

        prepareProbeMessages({QString(35, QLatin1Char('\n')) + QString(40, QLatin1Char('a'))}, 1000);
        const auto cappedLines = readingProbe();
        QVERIFY(!cappedLines.hasCandidate());
        QVERIFY(cappedLines.diagnostic.value("anyLinesTruncated").toBool());
        const auto record = probeRecord(cappedLines, "chatMessage-m-0");
        QCOMPARE(record.value("lineProbeCount").toInt(), ReadingSelectionProbe::LineLimit);
        QVERIFY(record.value("linesTruncated").toBool());

        prepareProbeMessages({});
        const auto empty = readingProbe();
        QVERIFY(!empty.hasCandidate());
        QCOMPARE(empty.diagnostic.value("candidateCount").toInt(), 0);
        QVERIFY(empty.diagnostic.value("items").toList().isEmpty());
    }

    void readingSelectionGestureGateBlocksPollingAndReentry() {
        ReadingSelectionProbe::OnceGesture gate;
        int calls = 0;
        bool clockReentry = true, actionReentry = true;
        const ReadingSelectionProbe::Clock clock = [&] {
            clockReentry = gate.run([] { return qint64(0); }, 100, [&] { calls += 100; });
            return qint64(0);
        };
        QVERIFY(gate.run(clock, 100, [&] {
            ++calls;
            actionReentry = gate.run(clock, 100, [&] { calls += 100; });
        }));
        QVERIFY(!clockReentry);
        QVERIFY(!actionReentry);
        for (int tick = 0; tick < 3; ++tick)
            QVERIFY(!gate.run(clock, 100, [&] { ++calls; }));
        QCOMPARE(calls, 1);
        QVERIFY(gate.attempted());
        QVERIFY(gate.completed());
        QVERIFY(!gate.failed());
    }

    void readingSelectionGestureGateLatchesExpiryAndFailure() {
        ReadingSelectionProbe::OnceGesture gate;
        int calls = 0;
        QVERIFY(!gate.run([] { return qint64(100); }, 100, [&] { ++calls; }));
        QVERIFY(gate.attempted() && gate.failed() && !gate.completed());
        QVERIFY(!gate.run([] { return qint64(0); }, 100, [&] { ++calls; }));
        QCOMPARE(calls, 0);

        gate = {};
        QVERIFY_EXCEPTION_THROWN(gate.run([] { return qint64(0); }, 100, [&] {
            ++calls;
            throw std::runtime_error("gesture fixture failure");
        }), std::runtime_error);
        QVERIFY(gate.attempted() && gate.failed() && !gate.completed());
        QVERIFY(!gate.run([] { return qint64(0); }, 100, [&] { ++calls; }));
        QCOMPARE(calls, 1);
    }

private:
    static QString selectionRowText(int lines = 4) {
        QStringList text;
        for (int index = 0; index < lines; ++index)
            text.append(QString(44, QLatin1Char('a' + index % 20)));
        return text.join('\n');
    }

    bool selectionFixtureReady() const {
        return m_chat->property("inputReady").toBool() && m_chat->property("geometryReady").toBool() &&
            !m_chat->property("restoringReading").toBool() && !m_chat->property("layoutRestorePending").toBool() &&
            !m_history->property("moving").toBool() && !m_history->property("dragging").toBool() &&
            !m_history->property("flicking").toBool();
    }

    bool selectionRowAt(int index, QQuickItem *&item) const {
        item = nullptr;
        return QMetaObject::invokeMethod(m_history, "itemAtIndex", Q_RETURN_ARG(QQuickItem *, item), Q_ARG(int, index));
    }

    bool selectionRowsMeet() const {
        QQuickItem *previous = nullptr, *target = nullptr, *next = nullptr;
        if (!selectionRowAt(0, previous) || !selectionRowAt(1, target) || !selectionRowAt(2, next) ||
            !previous || !target || !next) return false;
        const qreal spacing = m_history->property("spacing").toDouble();
        return qAbs(previous->y() + previous->height() + spacing - target->y()) < .5 &&
            qAbs(target->y() + target->height() + spacing - next->y()) < .5;
    }

    void prepareAdjacentSelectionRows() {
        prepareProbeMessages({"previous", selectionRowText(), "next"});
        if (QTest::currentTestFailed()) return;
        QVERIFY(m_history->setProperty("spacing", 7.0));
        settle();
        if (QTest::currentTestFailed()) return;
        QTRY_VERIFY_WITH_TIMEOUT(selectionRowsMeet(), 1500);
        QVERIFY(selectionFixtureReady());
    }

    void proveLegacySelectionGates(ReadingSelectionProbe::Candidate &candidate) const {
        QVERIFY(selectionFixtureReady());
        const auto legacy = readingProbe();
        QVERIFY2(legacy.hasCandidate(), probeJson(legacy).constData());
        QCOMPARE(legacy.candidate.messageId, QString("m-1"));
        QCOMPARE(legacy.candidate.item.data(), messageText(1));
        const auto record = probeRecord(legacy, legacy.candidate.name);
        QVERIFY(record.value("oldWidthGate").toBool());
        QVERIFY(record.value("oldHeightGate").toBool());
        QVERIFY(record.value("oldTextLengthGate").toBool());
        QVERIFY(record.value("visible").toBool() && record.value("enabled").toBool());
        QVERIFY(record.value("effectiveOpacity").toDouble() > .05);
        QVERIFY(record.value("reasons").toStringList().isEmpty());
        QVERIFY(!record.value("bestSpan").toMap().isEmpty());
        QVERIFY(ReadingSelectionProbe::revalidate(legacy.candidate, m_history, m_window.get(), selectionFixtureReady(),
                                                   [] { return qint64(0); }, 4000));
        candidate = legacy.candidate;
    }

    ReadingSelectionProbe::ProbeResult selectionBeforePress(const ReadingSelectionProbe::Clock &clock) const {
        return ReadingSelectionProbe::probeBeforePress(m_history, m_window.get(), selectionFixtureReady(), clock, 4000);
    }

    bool trySelectionDrag(const ReadingSelectionProbe::ProbeResult &result, const ReadingSelectionProbe::Clock &clock,
                          ReadingSelectionProbe::OnceGesture &gesture, int &pressCount) {
        ReadingSelectionProbe::Candidate live;
        if (!result.hasCandidate() || !ReadingSelectionProbe::revalidateBeforePress(result.candidate, m_history,
                m_window.get(), selectionFixtureReady(), clock, 4000, &live)) return false;
        return gesture.run(clock, 4000, [&] {
            QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, live.start, 0);
            ++pressCount;
            const QPointF start = live.start, end = live.end;
            for (int move = 1; move <= 5; ++move)
                QTest::mouseMove(m_window.get(), (start + (end - start) * (move / 5.)).toPoint(), 0);
            QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, live.end, 0);
        });
    }

    void verifyReadingSelection(const ReadingSelectionProbe::Candidate &candidate) const {
        QVERIFY(candidate.item);
        QVERIFY(candidate.item->property("selectionEnd").toInt() > candidate.item->property("selectionStart").toInt());
        QVERIFY(candidate.item->property("selectedText").toString().trimmed().size() >= 4);
    }

private slots:
    void readingSelectionAcceptsConsistentAdjacentRows() {
        prepareAdjacentSelectionRows();
        if (QTest::currentTestFailed()) return;
        ReadingSelectionProbe::Candidate legacy;
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        const ReadingSelectionProbe::Clock clock = [] { return qint64(0); };
        const auto eligible = selectionBeforePress(clock);
        QVERIFY2(eligible.hasCandidate(), probeJson(eligible).constData());
        QCOMPARE(eligible.candidate.item, legacy.item);
        const auto adjacency = eligible.diagnostic.value("rowAdjacency").toMap();
        QCOMPARE(adjacency.value("status").toString(), QString("consistent"));
        QCOMPARE(adjacency.value("spacing").toDouble(), 7.0);
        QCOMPARE(adjacency.value("previous").toMap().value("index").toInt(), 0);
        QCOMPARE(adjacency.value("target").toMap().value("index").toInt(), 1);
        QCOMPARE(adjacency.value("next").toMap().value("index").toInt(), 2);
        ReadingSelectionProbe::OnceGesture gesture;
        int presses = 0;
        QVERIFY(trySelectionDrag(eligible, clock, gesture, presses));
        QCOMPARE(presses, 1);
        verifyReadingSelection(eligible.candidate);
    }

    void readingSelectionBlocksStaleRowBeforePress() {
        prepareAdjacentSelectionRows();
        if (QTest::currentTestFailed()) return;
        auto *target = row(1);
        QVERIFY(target);
        target->setY(target->y() + 16);
        ReadingSelectionProbe::Candidate legacy;
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        const auto state = probeObservedState(legacy.item.data());
        const ReadingSelectionProbe::Clock clock = [] { return qint64(0); };
        const auto blocked = selectionBeforePress(clock);
        QVERIFY(!blocked.hasCandidate());
        QCOMPARE(blocked.diagnostic.value("reason").toString(), QString("row-position-inconsistent"));
        const auto adjacency = blocked.diagnostic.value("rowAdjacency").toMap();
        QCOMPARE(adjacency.value("status").toString(), QString("inconsistent"));
        const auto previous = adjacency.value("previous").toMap();
        const auto current = adjacency.value("target").toMap();
        QVERIFY(previous.value("instantiated").toBool() && current.value("instantiated").toBool());
        QCOMPARE(current.value("y").toDouble(), target->y());
        const qreal gap = current.value("y").toDouble() - previous.value("y").toDouble() -
            previous.value("height").toDouble() - adjacency.value("spacing").toDouble();
        QVERIFY(qAbs(gap - 16) < .5);
        QVariantMap revalidated;
        QVERIFY(!ReadingSelectionProbe::revalidateBeforePress(legacy, m_history, m_window.get(), true, clock, 4000,
                                                               nullptr, &revalidated));
        QCOMPARE(revalidated.value("reason").toString(), QString("row-position-inconsistent"));
        ReadingSelectionProbe::OnceGesture gesture;
        int presses = 0;
        QVERIFY(!trySelectionDrag(blocked, clock, gesture, presses));
        QVERIFY(!gesture.attempted());
        QCOMPARE(presses, 0);
        QCOMPARE(probeObservedState(legacy.item.data()), state);
    }

    void readingSelectionRetriesAfterListLayoutCorrection() {
        prepareAdjacentSelectionRows();
        if (QTest::currentTestFailed()) return;
        auto *target = row(1);
        QVERIFY(target);
        target->setY(target->y() + 16);
        ReadingSelectionProbe::Candidate legacy;
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        qint64 elapsed = 0;
        const ReadingSelectionProbe::Clock clock = [&] { return elapsed; };
        const auto stale = selectionBeforePress(clock);
        QCOMPARE(stale.diagnostic.value("reason").toString(), QString("row-position-inconsistent"));
        ReadingSelectionProbe::OnceGesture gesture;
        int presses = 0;
        QVERIFY(!trySelectionDrag(stale, clock, gesture, presses));
        QCOMPARE(presses, 0);

        // A fixture spacing change asks the real ListView to position its rows.
        // The discovery and revalidation calls themselves never run layout.
        QVERIFY(m_history->setProperty("spacing", 11.0));
        QVERIFY(QMetaObject::invokeMethod(m_history, "forceLayout"));
        QTRY_VERIFY_WITH_TIMEOUT(selectionRowsMeet() && selectionFixtureReady(), 1500);
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        elapsed = 100;
        const auto corrected = selectionBeforePress(clock);
        QVERIFY2(corrected.hasCandidate(), probeJson(corrected).constData());
        QCOMPARE(corrected.diagnostic.value("rowAdjacency").toMap().value("status").toString(), QString("consistent"));
        QCOMPARE(corrected.candidate.item, legacy.item);
        QVERIFY(trySelectionDrag(corrected, clock, gesture, presses));
        QCOMPARE(presses, 1);
        verifyReadingSelection(corrected.candidate);
    }

    void readingSelectionAllowsUninstantiatedAdjacentRows() {
        prepareProbeMessages({"previous", selectionRowText(90), "next"}, 340);
        if (QTest::currentTestFailed()) return;
        QCOMPARE(m_history->property("count").toInt(), 3);
        QVERIFY(m_history->setProperty("cacheBuffer", 0));
        QVERIFY(m_history->setProperty("currentIndex", 1));
        QVERIFY(QMetaObject::invokeMethod(m_history, "positionViewAtIndex", Q_ARG(int, 1), Q_ARG(int, 0)));
        QQuickItem *target = nullptr;
        QTRY_VERIFY_WITH_TIMEOUT(selectionRowAt(1, target) && target, 1500);
        QVERIFY(target->height() > m_history->height() + 200);
        QVERIFY(m_chat->setProperty("followLatest", false));
        QVERIFY(m_history->setProperty("contentY", target->y() + (target->height() - m_history->height()) / 2));
        QVERIFY(QMetaObject::invokeMethod(m_chat, "captureReadingAnchor"));
        QQuickItem *previous = nullptr, *next = nullptr;
        QTRY_VERIFY_WITH_TIMEOUT(selectionFixtureReady() && selectionRowAt(0, previous) && !previous &&
            selectionRowAt(2, next) && !next, 1500);
        ReadingSelectionProbe::Candidate legacy;
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        const ReadingSelectionProbe::Clock clock = [] { return qint64(0); };
        const auto eligible = selectionBeforePress(clock);
        QVERIFY2(eligible.hasCandidate(), probeJson(eligible).constData());
        QCOMPARE(eligible.candidate.item, legacy.item);
        const auto adjacency = eligible.diagnostic.value("rowAdjacency").toMap();
        QCOMPARE(adjacency.value("status").toString(), QString("unavailable"));
        const auto upper = adjacency.value("previous").toMap();
        const auto lower = adjacency.value("next").toMap();
        QVERIFY(upper.contains("instantiated") && lower.contains("instantiated"));
        QCOMPARE(upper.value("index").toInt(), 0);
        QCOMPARE(lower.value("index").toInt(), 2);
        QVERIFY(!upper.value("instantiated").toBool() && !lower.value("instantiated").toBool());
        ReadingSelectionProbe::OnceGesture gesture;
        int presses = 0;
        QVERIFY(trySelectionDrag(eligible, clock, gesture, presses));
        QCOMPARE(presses, 1);
        verifyReadingSelection(eligible.candidate);
    }

    void readingSelectionReportsStaleRowAtDeadline() {
        prepareAdjacentSelectionRows();
        if (QTest::currentTestFailed()) return;
        auto *target = row(1);
        QVERIFY(target);
        target->setY(target->y() + 16);
        ReadingSelectionProbe::Candidate legacy;
        proveLegacySelectionGates(legacy);
        if (QTest::currentTestFailed()) return;
        qint64 elapsed = 3999;
        const ReadingSelectionProbe::Clock clock = [&] { return elapsed; };
        const auto last = selectionBeforePress(clock);
        QCOMPARE(last.diagnostic.value("reason").toString(), QString("row-position-inconsistent"));
        QVERIFY(!last.diagnostic.value("deadlineReached").toBool());
        ReadingSelectionProbe::OnceGesture gesture;
        int presses = 0;
        QVERIFY(!trySelectionDrag(last, clock, gesture, presses));

        elapsed = 4000;
        const auto expired = selectionBeforePress(clock);
        QVERIFY(expired.diagnostic.value("deadlineReached").toBool());
        QVERIFY(!trySelectionDrag(expired, clock, gesture, presses));
        QVERIFY(!gesture.attempted());
        QCOMPARE(presses, 0);
        QVERIFY(legacy.item->property("selectedText").toString().isEmpty());
        const QString ordinaryTimeout = "MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT";
        QCOMPARE(ReadingSelectionProbe::acquisitionTimeoutCode(last.diagnostic, ordinaryTimeout),
                 QString("MOONROOM_READING_SELECTION_LAYOUT_INCONSISTENT"));
        QCOMPARE(ReadingSelectionProbe::acquisitionTimeoutCode(expired.diagnostic, ordinaryTimeout), ordinaryTimeout);
    }

private:
    static QVariantMap proactiveBubble(int rowIndex, int bubbleIndex) {
        auto row = message(rowIndex, "assistant");
        row["content"] = QString("主动消息气泡 %1").arg(bubbleIndex);
        row["source"] = "proactive";
        row["proactive_id"] = "proactive_0123456789abcdef0123456789abcdef";
        row["bubble_index"] = bubbleIndex;
        return row;
    }

    QQuickItem *proactiveSourceLabel(int index) const {
        auto *item = row(index);
        return item ? item->findChild<QQuickItem *>(QString("proactiveSource-m-%1").arg(index)) : nullptr;
    }

private slots:
    void proactiveHistoryShowsOnePlainSourceInBothPresentations() {
        m_session->setMessages({message(0, "user"), message(1, "assistant"), proactiveBubble(2, 0), proactiveBubble(3, 1)});
        settle();
        QTRY_VERIFY(row(2) && row(3) && row(2)->isVisible() && row(3)->isVisible());
        QTRY_VERIFY(proactiveSourceLabel(2) && proactiveSourceLabel(2)->isVisible());
        QVERIFY(proactiveSourceLabel(3) && !proactiveSourceLabel(3)->isVisible());
        QCOMPARE(proactiveSourceLabel(2)->property("text").toString(), QString("她主动发来"));
        QCOMPARE(proactiveSourceLabel(2)->property("textFormat").toInt(), int(Qt::PlainText));
        transition(true);
        settle();
        QTRY_VERIFY(proactiveSourceLabel(2) && proactiveSourceLabel(2)->isVisible());
        QVERIFY(proactiveSourceLabel(3) && !proactiveSourceLabel(3)->isVisible());
        QVERIFY(messageText(2)->mapToItem(row(2), QPointF()).y() > proactiveSourceLabel(2)->y());
    }

    void proactiveHistoryPageDoesNotRelabelLaterBubble() {
        m_session->setMessages({proactiveBubble(0, 1), proactiveBubble(1, 2)});
        settle();
        QTRY_VERIFY(row(0) && row(1) && row(0)->isVisible() && row(1)->isVisible());
        QVERIFY(proactiveSourceLabel(0) && !proactiveSourceLabel(0)->isVisible());
        QVERIFY(proactiveSourceLabel(1) && !proactiveSourceLabel(1)->isVisible());
        transition(true);
        settle();
        QTRY_VERIFY(row(0) && row(1));
        QVERIFY(proactiveSourceLabel(0) && !proactiveSourceLabel(0)->isVisible());
        QVERIFY(proactiveSourceLabel(1) && !proactiveSourceLabel(1)->isVisible());
    }

    void proactiveHistoryUsesUnreadReplyCueBehindTask() {
        m_session->setMessages({message(0, "user"), message(1, "assistant")});
        settle();
        QCOMPARE(m_chat->property("unreadReplyCount").toInt(), 0);
        setDirector({{"mode", "task"}, {"taskBlend", 1.}, {"chatInputReady", false}});
        const QPointer<QQuickItem> focus = m_window->activeFocusItem();
        const QVariantList history{message(0, "user"), message(1, "assistant"), proactiveBubble(2, 0), proactiveBubble(3, 1)};
        m_session->setMessages(history);
        QTRY_COMPARE(m_chat->property("unreadReplyCount").toInt(), 1);
        QCOMPARE(m_chat->property("companionStatusText").toString(), QString("有新回复"));
        QCOMPARE(m_director->property("mode").toString(), QString("task"));
        QCOMPARE(QPointer<QQuickItem>(m_window->activeFocusItem()), focus);
        m_session->setMessages(history);
        QCOMPARE(m_chat->property("unreadReplyCount").toInt(), 1);
    }
};
QTEST_MAIN(ChatPanelVirtualizationTest)
#include "ChatPanelVirtualizationTest.moc"
