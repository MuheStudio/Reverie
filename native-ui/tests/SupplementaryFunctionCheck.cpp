#include "SupplementaryFunctionCheck.h"
#include "ControlReadiness.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QQuickItem>
#include <QQuickWindow>
#include <QTest>
#include <QTimer>
#include <QUrl>
#include <algorithm>
#include <stdexcept>

namespace {
constexpr auto kSavedModel = "reverie-qt-supplement";
constexpr auto kFailingModel = "reverie-qt-fail";
constexpr auto kSlowModel = "reverie-qt-slow";
constexpr auto kPauseLabel = "暂停网络模型调用";
constexpr auto kPermissionFeature = "emotion_analysis";

qreal effectiveOpacity(const QQuickItem *item) {
    qreal opacity = 1;
    for (auto *i = item; i; i = i->parentItem())
        opacity *= i->opacity();
    return opacity;
}
void collect(QQuickItem *root, const std::function<bool(QQuickItem *)> &match,
             QList<QQuickItem *> &out) {
    if (!root || !root->isVisible())
        return;
    if (match(root))
        out.append(root);
    for (auto *child : root->childItems())
        collect(child, match, out);
}
QVariantMap mapAt(const QVariantMap &map, const QString &key) { return map.value(key).toMap(); }

struct Step {
    QString name;
    int timeoutMs;
    std::function<bool()> poll;
};
struct Case {
    QString id;
    QStringList dependsOn;
    QList<Step> steps;
};

class Check final : public QObject {
  public:
    QQuickWindow *w;
    RuntimeBridge *s;
    int cycle;
    QString endpoint, model, capturePrefix;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock, stepClock;
    QList<Case> plan;
    int caseIndex = 0, stepIndex = 0;
    bool executing = false, caseStarted = false;
    QVariantMap results, observations;
    QStringList gaps;
    QVariantList stepLog;
    qint64 lastAction = -1;
    struct Response {
        QString id, command;
        int generation;
        QVariantMap payload;
    };
    QList<Response> responses;
    int responseMark = 0;
    double animationBefore = 0;
    int loadsBefore = 0;
    QString scopeBefore;
    bool safetyStopped = false;
    QVariantMap captures;

    Check(QQuickWindow *window, RuntimeBridge *session, int c, QString url, QString modelPath,
          QString prefix, std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), cycle(c), endpoint(std::move(url)),
          model(std::move(modelPath)), capturePrefix(std::move(prefix)), done(std::move(callback)) {
        connect(s, &RuntimeBridge::responseReceived, this,
                [this](const QString &id, const QString &command, const QVariantMap &payload, int generation) {
                    responses.append({id, command, generation, payload});
                });
        plan = cycle == 1 ? firstCycle() : secondCycle();
        clock.start();
        timer.setInterval(100);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing)
                return;
            executing = true;
            tick();
            executing = false;
        });
        timer.start();
    }

    // Controls ------------------------------------------------------------
    QQuickItem *named(const QString &name) const {
        QList<QQuickItem *> found;
        collect(w->contentItem(), [&](QQuickItem *i) { return i->objectName() == name; }, found);
        return found.isEmpty() ? nullptr : found.first();
    }
    // The part of an item inside the window and every clipping ancestor, such
    // as a scrolled page's viewport.
    QRectF visibleRect(QQuickItem *i) const {
        QRectF r = i->mapRectToScene(QRectF(0, 0, i->width(), i->height()));
        r &= QRectF(0, 0, w->width(), w->height());
        for (auto *p = i->parentItem(); p && !r.isEmpty(); p = p->parentItem())
            if (p->clip())
                r &= p->mapRectToScene(QRectF(0, 0, p->width(), p->height()));
        return r;
    }
    bool shown(QQuickItem *i) const {
        if (!i || !i->isVisible() || effectiveOpacity(i) < .05 || i->width() < 1 || i->height() < 1)
            return false;
        const auto r = visibleRect(i);
        return r.width() >= 2 && r.height() >= 2;
    }
    QList<QQuickItem *> buttons(QQuickItem *root, const std::function<bool(const QString &)> &text) const {
        QList<QQuickItem *> found;
        collect(root ? root : w->contentItem(), [&](QQuickItem *i) {
            return i->inherits("QQuickAbstractButton") && text(i->property("text").toString());
        }, found);
        return found;
    }
    QQuickItem *button(const QString &text, QQuickItem *root = nullptr) const {
        const auto found = buttons(root, [&](const QString &t) { return t == text; });
        return found.isEmpty() ? nullptr : found.first();
    }
    bool visibleText(const QString &needle) const {
        QList<QQuickItem *> found;
        collect(w->contentItem(), [&](QQuickItem *i) {
            return (i->inherits("QQuickText") || i->inherits("QQuickLabel")) &&
                   i->property("text").toString().contains(needle);
        }, found);
        for (auto *i : found)
            if (shown(i))
                return true;
        return false;
    }
    void require(bool value, const QString &message) const {
        if (!value)
            throw std::runtime_error(message.toStdString());
    }
    // Brings an item inside a scrolled page into its viewport, as scrolling would.
    void reveal(QQuickItem *item) const {
        for (auto *p = item->parentItem(); p; p = p->parentItem()) {
            if (!p->inherits("QQuickFlickable"))
                continue;
            auto *content = p->property("contentItem").value<QQuickItem *>();
            if (!content)
                return;
            const qreal y = item->mapToItem(content, QPointF(0, 0)).y();
            const qreal maxY = std::max<qreal>(0, p->property("contentHeight").toReal() - p->height());
            const qreal top = p->property("contentY").toReal();
            if (y < top || y + item->height() > top + p->height())
                p->setProperty("contentY", std::clamp<qreal>(y - p->height() * .3, 0, maxY));
            return;
        }
    }
    void click(QQuickItem *i, const QString &label) const {
        require(i && i->isVisible() && i->isEnabled(), "CONTROL_UNAVAILABLE:" + label);
        reveal(i);
        const auto p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
        require(visibleRect(i).contains(p), "CONTROL_CLIPPED:" + label);
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint());
    }
    void click(const QString &name) const { click(named(name), name); }
    void type(const QString &name, const QString &text) const {
        auto *i = named(name);
        require(i && i->isEnabled(), "EDITOR_UNAVAILABLE:" + name);
        reveal(i);
        i->forceActiveFocus();
        QMetaObject::invokeMethod(i, "selectAll");
        QInputMethodEvent commit;
        commit.setCommitString(text);
        QCoreApplication::sendEvent(w, &commit);
        require(i->property("text").toString() == text, "INPUT_NOT_COMMITTED:" + name);
    }
    // Main.qml names the drawers after their feature; the character surface
    // keeps its older generic name.
    static QString surfaceName(const QString &feature) {
        return feature == "character" ? QStringLiteral("taskSurface") : "drawer-" + feature;
    }
    bool surfaceReady(const QString &feature) const {
        auto *i = named(surfaceName(feature));
        return i && i->property("inputReady").toBool();
    }
    bool surfaceClosed() const {
        for (const auto &feature : {"memory", "settings", "character"}) {
            QList<QQuickItem *> found;
            collect(w->contentItem(), [&](QQuickItem *i) { return i->objectName() == surfaceName(feature); }, found);
            for (auto *i : found)
                if (i->property("progress").toDouble() > 0)
                    return false;
        }
        return true;
    }
    NativeAvatar *avatar() const { return w->findChild<NativeAvatar *>("nativeAvatar"); }
    // Identity of the active saved model, for comparison across restart.
    QVariantMap activeAvatar() const {
        const auto avatars = mapAt(s->state(), "avatars");
        for (const auto &r : avatars["records"].toList()) {
            const auto record = r.toMap();
            if (record["id"] == avatars["activeId"]) {
                const auto detected = mapAt(record, "detected");
                return {{"id", record["id"]}, {"name", record["name"]},
                        {"modelPath", avatar() ? avatar()->diagnostics()["modelPath"] : QVariant()},
                        {"motions", detected["animationClips"].toStringList().size()},
                        {"expressions", detected["expressions"].toStringList().size()}};
            }
        }
        return {};
    }
    QVariantMap provider() const { return mapAt(s->state(), "provider"); }
    QVariantMap feedback(const QString &name) const { return s->property(name.toUtf8().constData()).toMap(); }
    bool feedbackShown(const QString &name, const QString &control) const {
        const auto value = feedback(name);
        auto *label = named(control);
        if (label) reveal(label);
        return !value["text"].toString().isEmpty() && shown(label) &&
               label->property("text").toString().startsWith(value["text"].toString());
    }
    bool chatFeedbackShown() const {
        return feedbackShown("chatFeedback", "chatFeedbackText") ||
               feedbackShown("chatFeedback", "companionChatFeedback");
    }
    QVariantMap permissionFeedback(const QString &feature = kPermissionFeature) const {
        return mapAt(feedback("permissionFeedback"), feature);
    }
    bool permissionFeedbackShown(const QString &feature = kPermissionFeature) const {
        const auto value = permissionFeedback(feature);
        auto *label = named(feature == "refresh" ? "permissionRefreshFeedback" : "permissionFeedback-" + feature);
        if (label) reveal(label);
        return !value["text"].toString().isEmpty() && shown(label) &&
               label->property("text").toString() == value["text"].toString();
    }
    QVariantMap currentMetadata() const {
        const auto d = s->diagnostics();
        QVariantMap result{{"busy", s->busy()}, {"connected", s->connected()}, {"generation", s->generation()},
                           {"chatRequestId", d["chatRequestId"]}, {"chatState", d["chatState"]},
                           {"pendingCommands", d["pendingCommands"]}, {"messageCount", s->messages().size()},
                           {"draftCharacters", s->draft().size()}};
        for (const auto &name : {"chatFeedback", "providerFeedback", "networkFeedback"}) {
            const auto f = feedback(name);
            QVariantMap fields;
            for (const auto &key : {"status", "requestId", "pending", "saving", "currentDraft", "known", "active", "desiredActive", "epoch"})
                if (f.contains(key)) fields[key] = f[key];
            result[name] = fields;
        }
        return result;
    }
    QVariantMap permission() const {
        return mapAt(mapAt(mapAt(s->state(), "permissions"), "features"), kPermissionFeature);
    }
    // The first response to `command` after the mark, from the current
    // persona generation; its payload must carry the feature snapshot.
    const Response *responseSinceMark(const QString &command) const {
        for (int i = responseMark; i < responses.size(); ++i)
            if (responses[i].command == command && responses[i].generation == s->generation())
                return &responses[i];
        return nullptr;
    }
    static QVariantMap featureIn(const QVariantMap &payload) {
        return mapAt(mapAt(payload, "features"), kPermissionFeature);
    }
    void markResponses() { responseMark = responses.size(); }
    QQuickItem *pauseSwitch() const {
        const auto found = buttons(nullptr, [](const QString &t) { return t == kPauseLabel; });
        return found.isEmpty() ? nullptr : found.first();
    }
    // The permission row for one feature: the Repeater delegate whose
    // required modelData names it.
    QQuickItem *permissionRow() const {
        QList<QQuickItem *> found;
        collect(w->contentItem(), [](QQuickItem *i) {
            return i->property("modelData").toString() == kPermissionFeature && i->property("permission").isValid();
        }, found);
        return found.isEmpty() ? nullptr : found.first();
    }
    QQuickItem *dialogButton(const QStringList &texts) const {
        const auto found = buttons(nullptr, [&](const QString &t) { return texts.contains(t); });
        for (auto *b : found)
            if (shown(b))
                return b;
        return nullptr;
    }
    bool hasAssistantReplyContaining(const QString &needle) const {
        for (const auto &m : s->messages()) {
            const auto map = m.toMap();
            if (map["role"] != "user" && map["content"].toString().contains(needle))
                return true;
        }
        return false;
    }
    int assistantCount() const {
        int count = 0;
        for (const auto &m : s->messages())
            if (m.toMap()["role"] != "user")
                ++count;
        return count;
    }
    void observe(const QString &key, const QVariant &value) { observations[key] = value; }
    void capture(const QString &label) {
        if (captures.contains(label)) return;
        const auto file = capturePrefix + "." + label + ".png";
        require(w->grabWindow().save(file), "SUPPLEMENTARY_CAPTURE_FAILED");
        captures[label] = file;
    }
    void gap(const QString &text) { gaps.append(text); }
    bool elapsed(int ms) const { return stepClock.elapsed() >= ms; }
    // True at most once per interval within a step, for retried user actions.
    bool due(int intervalMs) {
        if (lastAction >= 0 && stepClock.elapsed() - lastAction < intervalMs)
            return false;
        lastAction = stepClock.elapsed();
        return true;
    }
    bool noticeShown() const { return !s->notice().isEmpty() && visibleText(s->notice()); }

    // Steps shared by both cycles -----------------------------------------
    Step openSurface(const QString &feature, const QString &nav) {
        return {"open-" + feature, 8000, [this, feature, nav] {
                    if (surfaceReady(feature))
                        return true;
                    if (due(2500))
                        click(nav);
                    return false;
                }};
    }
    Step closeSurfaces() {
        return {"close-surfaces", 8000, [this] {
                    if (surfaceClosed())
                        return true;
                    if (due(2500))
                        for (const auto &feature : {"memory", "settings", "character"})
                            if (surfaceReady(feature))
                                click(QString(feature) + "-close");
                    return false;
                }};
    }
    QList<Step> sendChat(const QString &text, int replyTimeout, bool expectReply) {
        const auto marker = text.section(QChar(0xff1a), 0, 0);
        return {{"compose", 4000, [this, text] {
                     if (!NativeControlReadiness::snapshot(named("chatComposer"), w, surfaceClosed())["ready"].toBool())
                         return false;
                     observe("chat.assistantBefore", assistantCount());
                     observe("chat.messagesBefore", s->messages().size());
                     type("chatComposer", text);
                     return true;
                 }},
                {"send", 3000, [this, text] {
                     click("sendChat");
                     return true;
                 }},
                {"settle", replyTimeout, [this, text, marker, expectReply] {
                     if (s->busy() || !elapsed(600))
                         return false;
                     const int before = observations.value("chat.assistantBefore").toInt();
                     const bool replied = assistantCount() > before;
                     observe("replied:" + marker, replied);
                     observe("chat.result:" + marker, currentMetadata());
                     require(replied == expectReply, expectReply ? "NO_REPLY" : "UNEXPECTED_REPLY");
                     if (!expectReply) {
                         const bool preserved = s->draft() == text && named("chatComposer") &&
                             named("chatComposer")->property("text").toString() == text;
                         observe("draftPreserved:" + marker, preserved);
                         require(preserved, "PAUSED_DRAFT_LOST");
                         require(s->messages().size() == observations["chat.messagesBefore"].toInt(), "PAUSED_SEND_APPENDED_MESSAGE");
                         require(feedback("chatFeedback")["status"] == "paused" && chatFeedbackShown(), "PAUSED_SEND_FEEDBACK_NOT_VISIBLE");
                         if (cycle == 1 && marker == "补充-暂停中") capture("paused-draft-preserved");
                     }
                     return true;
                 }}};
    }
    Step togglePause(bool active) {
        return {active ? "pause-on" : "pause-off", 10000, [this, active] {
                    const auto f = feedback("networkFeedback");
                    if (s->state()["offline"].toBool() == active && f["known"].toBool() &&
                        f["active"].toBool() == active && f["status"] == (active ? "paused" : "allowed")) {
                        require(feedbackShown("networkFeedback", "networkFeedbackText"), "NETWORK_FEEDBACK_NOT_VISIBLE");
                        return true;
                    }
                    if (due(3000)) {
                        auto *toggle = pauseSwitch();
                        require(toggle, "PAUSE_SWITCH_UNAVAILABLE");
                        if (toggle->property("checked").toBool() != active)
                            click(toggle, kPauseLabel);
                    }
                    return false;
                }};
    }
    Step settlePreviousChat() {
        return {"stop-pending-chat-after-original-verdict", 12000, [this] {
            if (!s->busy()) return true;
            if (due(4000)) {
                observe("controlled.cleanupOfPreviousChat", currentMetadata());
                // Only reached after the original case has recorded its verdict.
                // This action cannot change that original result or deadline.
                click("sendChat");
            }
            return false;
        }};
    }

    // Cycle 1 ------------------------------------------------------------
    QList<Case> firstCycle() {
        QList<Case> cases;
        cases.append({"setup.connected", {}, {connected()}});
        cases.append({"service.test-and-save", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"edit-and-test", 4000, [this] {
                            type("providerEndpoint", endpoint);
                            type("providerModel", kSavedModel);
                            click("testProvider");
                            return true;
                        }},
                       {"test-receipt", 20000, [this] {
                            if (!s->state()["providerTestReady"].toBool())
                                return false;
                            auto *save = named("saveProvider");
                            observe("service.saveEnabledAfterTest", save && save->isEnabled());
                            const bool visible = feedback("providerFeedback")["status"] == "ready" &&
                                feedbackShown("providerFeedback", "providerFeedbackText");
                            observe("service.testFeedbackVisible", visible);
                            require(visible, "PROVIDER_TEST_FEEDBACK_NOT_VISIBLE");
                            require(save && save->isEnabled(), "SAVE_NOT_ENABLED_AFTER_TEST");
                            click("saveProvider");
                            return true;
                        }},
                       {"save-receipt", 15000, [this] {
                            if (provider()["model"] != kSavedModel)
                                return false;
                            observe("service.savedProvider", provider());
                            const bool visible = feedback("providerFeedback")["status"] == "saved" &&
                                feedbackShown("providerFeedback", "providerFeedbackText");
                            observe("service.saveFeedbackVisible", visible);
                            require(visible, "PROVIDER_SAVE_FEEDBACK_NOT_VISIBLE");
                            return true;
                        }}}});
        cases.append({"service.failure-keeps-config", {"service.test-and-save"},
                      {{"edit-and-test", 4000, [this] {
                            type("providerModel", kFailingModel);
                            click("testProvider");
                            return true;
                        }},
                       {"failure-receipt", 25000, [this] {
                            if (feedback("providerFeedback")["status"] != "error")
                                return false;
                            auto *save = named("saveProvider");
                            observe("service.saveEnabledAfterFailure", save && save->isEnabled());
                            observe("service.providerAfterFailure", provider());
                            const bool visible = feedbackShown("providerFeedback", "providerFeedbackText");
                            observe("service.failureFeedbackVisible", visible);
                            require(!(save && save->isEnabled()), "SAVE_ENABLED_AFTER_FAILED_TEST");
                            require(provider()["model"] == kSavedModel, "FAILED_TEST_CHANGED_PROVIDER");
                            require(visible, "PROVIDER_FAILURE_FEEDBACK_NOT_VISIBLE");
                            capture("provider-failure-feedback");
                            return true;
                        }}}});
        cases.append({"service.stale-receipt", {"service.test-and-save"},
                      {{"slow-test", 4000, [this] {
                            type("providerModel", kSlowModel);
                            click("testProvider");
                            return true;
                        }},
                       {"edit-draft", 3000, [this] {
                            if (!elapsed(800))
                                return false;
                            type("providerModel", kSavedModel);
                            return true;
                        }},
                       {"old-receipt", 9000, [this] {
                            if (!elapsed(6000))
                                return false;
                            auto *save = named("saveProvider");
                            observe("service.readyAfterStaleReceipt", s->state()["providerTestReady"].toBool());
                            observe("service.saveEnabledAfterStaleReceipt", save && save->isEnabled());
                            require(!s->state()["providerTestReady"].toBool() && !(save && save->isEnabled()),
                                    "STALE_RECEIPT_ENABLED_SAVE");
                            require(provider()["model"] == kSavedModel, "STALE_RECEIPT_CHANGED_PROVIDER");
                            const bool visible = feedback("providerFeedback")["status"] == "stale" &&
                                feedbackShown("providerFeedback", "providerFeedbackText");
                            observe("service.staleFeedbackVisible", visible);
                            require(visible, "STALE_RECEIPT_FEEDBACK_NOT_VISIBLE");
                            return true;
                        }},
                       closeSurfaces()}});
        Case uses{"service.chat-uses-saved-config", {"service.test-and-save"}, {closeSurfaces()}};
        uses.steps += sendChat("补充-配置：今晚一起看星空吗", 20000, true);
        cases.append(uses);
        cases.append({"network.pause-during-reply", {"setup.connected"},
                      {closeSurfaces(), settlePreviousChat(),
                       {"compose", 4000, [this] {
                            if (!NativeControlReadiness::snapshot(named("chatComposer"), w, surfaceClosed())["ready"].toBool()) return false;
                            observe("network.assistantBeforePause", assistantCount());
                            type("chatComposer", "补充-延迟：请慢慢回答");
                            click("sendChat");
                            return true;
                        }},
                       {"in-flight", 6000, [this] { return s->busy() && elapsed(3000); }},
                       openSurface("settings", "nav-settings"),
                       togglePause(true),
                       {"cancelled", 12000, [this] {
                            if (s->busy())
                                return false;
                            const bool visible = feedback("networkFeedback")["status"] == "paused" &&
                                feedbackShown("networkFeedback", "networkFeedbackText");
                            observe("network.pauseFeedbackVisible", visible);
                            observe("network.metadataAfterPause", currentMetadata());
                            require(visible, "PAUSE_FEEDBACK_NOT_VISIBLE");
                            return true;
                        }},
                       {"late-reply-rejected", 14000, [this] {
                            // The mock holds this reply for 8 s after receipt.
                            if (!elapsed(10000))
                                return false;
                            const bool late = hasAssistantReplyContaining("迟到的旧回复");
                            observe("network.lateReplyShown", late);
                            require(!late, "LATE_REPLY_ACCEPTED_AFTER_PAUSE");
                            return true;
                        }},
                       closeSurfaces()}});
        Case paused{"network.no-calls-while-paused", {"network.pause-during-reply"}, {closeSurfaces()}};
        paused.steps += sendChat("补充-暂停中：这条不应发出", 15000, false);
        paused.steps.append({"feedback", 1000, [this] {
                                 const bool visible = feedback("chatFeedback")["status"] == "paused" && chatFeedbackShown();
                                 observe("network.pausedSendFeedbackVisible", visible);
                                 require(visible, "PAUSED_SEND_FEEDBACK_NOT_VISIBLE");
                                 return true;
                             }});
        cases.append(paused);
        Case resume{"network.resume", {"setup.connected"},
                     {openSurface("settings", "nav-settings"), togglePause(false), closeSurfaces()}};
        resume.steps += sendChat("补充-恢复：现在可以了", 20000, true);
        cases.append(resume);
        cases.append({"network.controlled-pause-during-reply", {"setup.connected"},
                      {closeSurfaces(), settlePreviousChat(),
                       openSurface("settings", "nav-settings"), togglePause(false), closeSurfaces(),
                       {"compose-controlled-delay", 4000, [this] {
                            if (!NativeControlReadiness::snapshot(named("chatComposer"), w, surfaceClosed())["ready"].toBool()) return false;
                            observe("network.controlledAssistantBeforePause", assistantCount());
                            type("chatComposer", "补充-受控延迟：请慢慢回答");
                            click("sendChat");
                            return true;
                        }},
                       {"provider-in-flight", 6000, [this] {
                            if (!s->busy() || feedback("chatFeedback")["status"] != "generating" || !elapsed(1200)) return false;
                            observe("network.controlledInFlight", currentMetadata());
                            return true;
                        }},
                       openSurface("settings", "nav-settings"), togglePause(true),
                       {"pause-receipt", 10000, [this] {
                            if (s->busy()) return false;
                            const auto f = feedback("chatFeedback");
                            observe("network.controlledPauseResult", currentMetadata());
                            require(f["status"] == "cancelled" && feedback("networkFeedback")["status"] == "paused",
                                    "PAUSE_DID_NOT_STOP_CURRENT_REPLY_AND_PAUSE_NETWORK");
                            require(feedback("networkFeedback")["text"] != f["text"], "PAUSE_REUSED_STOP_FEEDBACK");
                            require(feedbackShown("networkFeedback", "networkFeedbackText"), "PAUSE_FEEDBACK_NOT_VISIBLE");
                            return true;
                        }},
                       {"late-response-not-displayed", 14000, [this] {
                            if (!elapsed(10000)) return false;
                            const bool late = assistantCount() > observations["network.controlledAssistantBeforePause"].toInt();
                            observe("network.controlledLateReplyShown", late);
                            require(!late && assistantCount() == observations["network.controlledAssistantBeforePause"].toInt(), "LATE_REPLY_ACCEPTED_AFTER_PAUSE");
                            return true;
                        }}, closeSurfaces()}});
        Case controlledResume{"network.controlled-resume", {"setup.connected"},
                              {closeSurfaces(), settlePreviousChat(), openSurface("settings", "nav-settings"),
                               togglePause(false), closeSurfaces()}};
        controlledResume.steps += sendChat("补充-受控恢复：现在可以了", 20000, true);
        cases.append(controlledResume);
        cases.append({"network.stop-during-reply", {"setup.connected"},
                      {closeSurfaces(), settlePreviousChat(),
                       openSurface("settings", "nav-settings"), togglePause(false), closeSurfaces(),
                       {"compose-controlled-stop", 4000, [this] {
                            if (!NativeControlReadiness::snapshot(named("chatComposer"), w, surfaceClosed())["ready"].toBool()) return false;
                            observe("network.assistantBeforeStop", assistantCount());
                            type("chatComposer", "补充-受控停止：请慢慢回答");
                            click("sendChat");
                            return true;
                        }},
                       {"provider-in-flight", 6000, [this] {
                            if (!s->busy() || feedback("chatFeedback")["status"] != "generating" || !elapsed(1200)) return false;
                            observe("network.stopInFlight", currentMetadata());
                            click("sendChat");
                            return true;
                        }},
                       {"stop-receipt", 10000, [this] {
                            if (s->busy()) return false;
                            const bool visible = feedback("chatFeedback")["status"] == "cancelled" && chatFeedbackShown();
                            observe("network.stopFeedbackVisible", visible);
                            observe("network.stopResult", currentMetadata());
                            require(visible, "STOP_FEEDBACK_NOT_VISIBLE");
                            require(!s->state()["offline"].toBool() && feedback("networkFeedback")["status"] == "allowed", "STOP_PAUSED_NETWORK");
                            return true;
                        }},
                       {"late-response-not-displayed", 14000, [this] {
                            if (!elapsed(10000)) return false;
                            require(assistantCount() == observations["network.assistantBeforeStop"].toInt(), "LATE_REPLY_ACCEPTED_AFTER_STOP");
                            observe("network.stopLateReplyShown", false);
                            return true;
                        }}}});
        cases.append({"permissions.cancel-grant-refresh-revoke", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"rows", 10000, [this] {
                            if (!permissionRow())
                                return false;
                            observe("permissions.initial", permission());
                            require(!permission()["enabled"].toBool(), "PERMISSION_ALREADY_GRANTED");
                            markResponses();
                            click(button("授权当前服务", permissionRow()), "grant");
                            return true;
                        }},
                       {"cancel-dialog", 5000, [this] {
                            auto *cancel = dialogButton({"Cancel", "&Cancel", "取消"});
                            if (!cancel)
                                return false;
                            observe("permissions.dialogShown", visibleText("确认后台模型费用"));
                            click(cancel, "consent-cancel");
                            return true;
                        }},
                       {"still-denied", 4000, [this] {
                            if (!elapsed(1500))
                                return false;
                            require(!responseSinceMark("ai_usage:grant"), "CANCEL_SENT_GRANT");
                            require(!permission()["enabled"].toBool(), "CANCEL_GRANTED_PERMISSION");
                            observe("permissions.cancelSentGrant", false);
                            require(permissionFeedback()["status"] == "cancelled" && permissionFeedbackShown(), "CONSENT_CANCEL_FEEDBACK_NOT_VISIBLE");
                            markResponses();
                            click(button("授权当前服务", permissionRow()), "grant");
                            return true;
                        }},
                       {"confirm-dialog", 5000, [this] {
                            auto *ok = dialogButton({"OK", "&OK", "确定"});
                            if (!ok)
                                return false;
                            click(ok, "consent-ok");
                            return true;
                        }},
                       {"granted", 10000, [this] {
                            const auto *grant = responseSinceMark("ai_usage:grant");
                            if (!grant)
                                return false;
                            observe("permissions.grantResponse", featureIn(grant->payload));
                            require(featureIn(grant->payload)["enabled"].toBool(), "GRANT_RESPONSE_NOT_ENABLED");
                            require(permission()["enabled"].toBool(), "GRANT_NOT_IN_STATE");
                            observe("permissions.granted", permission());
                            auto *status = named("permissionStatus-emotion_analysis");
                            if (status) reveal(status);
                            const bool visible = shown(status) && status->property("text").toString().contains("已授权") &&
                                permissionFeedback()["status"] == "success" && permissionFeedbackShown();
                            observe("permissions.grantFeedbackVisible", visible);
                            require(visible, "PERMISSION_GRANTED_STATUS_NOT_VISIBLE");
                            capture("permission-granted-status");
                            markResponses();
                            click(button("刷新授权状态"), "refresh");
                            return true;
                        }},
                       {"refreshed", 8000, [this] {
                            const auto *refresh = responseSinceMark("ai_usage:get");
                            if (!refresh)
                                return false;
                            observe("permissions.refreshResponse", featureIn(refresh->payload));
                            require(featureIn(refresh->payload)["enabled"].toBool(), "REFRESH_LOST_GRANT");
                            require(permissionFeedback("refresh")["status"] == "success" && permissionFeedbackShown("refresh"), "PERMISSION_REFRESH_FEEDBACK_NOT_VISIBLE");
                            markResponses();
                            click(button("撤销", permissionRow()), "revoke");
                            return true;
                        }},
                       {"revoked", 10000, [this] {
                            const auto *revoke = responseSinceMark("ai_usage:revoke");
                            if (!revoke)
                                return false;
                            observe("permissions.revokeResponse", featureIn(revoke->payload));
                            require(!featureIn(revoke->payload)["enabled"].toBool(), "REVOKE_RESPONSE_STILL_ENABLED");
                            require(!permission()["enabled"].toBool(), "REVOKE_NOT_IN_STATE");
                            observe("permissions.revoked", permission());
                            auto *status = named("permissionStatus-emotion_analysis");
                            if (status) reveal(status);
                            require(shown(status) && !status->property("text").toString().contains("已授权") &&
                                permissionFeedback()["status"] == "success" && permissionFeedbackShown(), "PERMISSION_REVOKED_STATUS_NOT_VISIBLE");
                            return true;
                        }},
                       closeSurfaces()}});
        cases.append({"model.confirm-preview", {"setup.connected"},
                      {openSurface("character", "nav-character"),
                       {"import", 20000, [this] {
                            // Startup lists saved avatars first; an import during
                            // that job would be ignored.
                            if (s->avatarBusy())
                                return false;
                            // The folder picker is a system dialog; the selected
                            // directory is handed to the same method it calls.
                            s->importModel(QUrl::fromLocalFile(model));
                            return true;
                        }},
                       {"preview", 90000, [this] {
                            if (!s->avatarCandidate()["previewReady"].toBool() || s->avatarBusy())
                                return false;
                            click("modelRights");
                            if (auto *warnings = named("modelWarnings"))
                                click(warnings, "modelWarnings");
                            click("confirmModel");
                            return true;
                        }},
                       {"saved", 60000, [this] {
                            if (!s->avatarCandidate().isEmpty() || s->avatarBusy() ||
                                !s->avatarState().contains("就绪"))
                                return false;
                            observe("model.avatars", mapAt(s->state(), "avatars"));
                            observe("model.avatarPath", s->avatarPath());
                            return true;
                        }}}});
        cases.append({"model.select-saved", {"model.confirm-preview"},
                      {{"select", 5000, [this] {
                            const auto found = buttons(nullptr, [](const QString &t) { return t.endsWith(" · 当前"); });
                            require(!found.isEmpty(), "SAVED_AVATAR_BUTTON_MISSING");
                            loadsBefore = avatar()->loads();
                            observe("model.pathBeforeSelect", s->avatarPath());
                            observe("model.idBeforeSelect", mapAt(s->state(), "avatars")["activeId"]);
                            require(s->avatarState().contains("就绪"), "MODEL_NOT_READY_BEFORE_RESELECT");
                            click(found.first(), "saved-avatar");
                            require(s->avatarState().contains("就绪"), "MODEL_READY_STATE_LOST_DURING_RESELECT");
                            return true;
                        }},
                       {"selected", 15000, [this] {
                            require(s->avatarState().contains("就绪"), "MODEL_READY_STATE_LOST_DURING_RESELECT");
                            require(avatar()->loads() == loadsBefore && s->avatarPath() == observations["model.pathBeforeSelect"], "MODEL_RELOADED_DURING_RESELECT");
                            if (!elapsed(1500) || s->avatarBusy()) return false;
                            observe("model.activeIdAfterSelect", mapAt(s->state(), "avatars")["activeId"]);
                            observe("model.loadsAroundSelect", QVariantList{loadsBefore, avatar()->loads()});
                            require(mapAt(s->state(), "avatars")["activeId"] == observations["model.idBeforeSelect"], "ACTIVE_MODEL_CHANGED_DURING_RESELECT");
                            observe("model.readyStableAfterReselect", true);
                            capture("same-model-reselect-ready");
                            return true;
                        }}}});
        cases.append({"model.motion-and-expression", {"model.confirm-preview"},
                      {{"motion", 5000, [this] {
                            const auto records = mapAt(s->state(), "avatars")["records"].toList();
                            const auto active = mapAt(s->state(), "avatars")["activeId"];
                            QStringList clips, expressions;
                            for (const auto &r : records) {
                                const auto record = r.toMap();
                                if (record["id"] == active) {
                                    clips = mapAt(record, "detected")["animationClips"].toStringList();
                                    expressions = mapAt(record, "detected")["expressions"].toStringList();
                                }
                            }
                            observe("model.detectedClips", clips);
                            observe("model.detectedExpressions", expressions.size());
                            require(!clips.isEmpty(), "NO_DETECTED_MOTIONS");
                            animationBefore = avatar()->diagnostics()["userAnimationSeconds"].toDouble();
                            click(button(clips.first()), "motion:" + clips.first());
                            return true;
                        }},
                       {"motion-played", 6000, [this] {
                            const auto d = avatar()->diagnostics();
                            if (!d["motionActive"].toBool() && d["userAnimationSeconds"].toDouble() <= animationBefore + .2)
                                return false;
                            observe("model.motionPlayed", true);
                            return true;
                        }},
                       {"expression", 5000, [this] {
                            QList<QQuickItem *> combos;
                            collect(w->contentItem(), [](QQuickItem *i) { return i->inherits("QQuickComboBox"); }, combos);
                            QQuickItem *combo = nullptr;
                            for (auto *c : combos)
                                if (shown(c) && c->property("count").toInt() > 0)
                                    combo = c;
                            require(combo, "EXPRESSION_SELECTOR_MISSING");
                            reveal(combo);
                            combo->forceActiveFocus(Qt::TabFocusReason);
                            QTest::keyClick(w, Qt::Key_Down);
                            observe("model.expressionSelected", combo->property("currentText"));
                            return true;
                        }},
                       {"expression-active", 6000, [this] {
                            if (!avatar()->diagnostics()["expressionActive"].toBool())
                                return false;
                            observe("model.expressionActive", true);
                            return true;
                        }},
                       closeSurfaces()}});
        cases.append({"model.instance-across-pages", {"model.confirm-preview"},
                      {{"baseline", 2000, [this] {
                            loadsBefore = avatar()->loads();
                            observe("model.pathBeforePages", s->avatarPath());
                            return true;
                        }},
                       openSurface("memory", "nav-memory"), closeSurfaces(),
                       openSurface("settings", "nav-settings"), closeSurfaces(),
                       openSurface("character", "nav-character"), closeSurfaces(),
                       {"same-instance", 2000, [this] {
                            observe("model.loadsAcrossPages", QVariantList{loadsBefore, avatar()->loads()});
                            require(avatar()->loads() == loadsBefore && s->avatarPath() == observations["model.pathBeforePages"],
                                    "MODEL_RELOADED_ACROSS_PAGES");
                            return true;
                        }}}});
        cases.append({"restart.prepare", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"preferences-on", 6000, [this] {
                            if (s->reducedMotion() && s->reducedTransparency())
                                return true;
                            if (due(2500)) {
                                if (!s->reducedMotion())
                                    click("reduceMotion");
                                if (!s->reducedTransparency())
                                    click("reduceTransparency");
                            }
                            return false;
                        }},
                       togglePause(true), closeSurfaces(),
                       {"record", 1000, [this] {
                            observe("restart.preparedAvatarPath", s->avatarPath());
                            observe("restart.preparedActive", activeAvatar());
                            observe("restart.preparedProvider", provider());
                            return true;
                        }}}});
        return cases;
    }

    // Cycle 2 ------------------------------------------------------------
    QList<Case> secondCycle() {
        QList<Case> cases;
        cases.append({"setup.connected", {}, {connected()}});
        cases.append({"restart.service-persisted", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"provider", 10000, [this] {
                            if (provider().isEmpty())
                                return false;
                            auto *field = named("providerModel");
                            observe("restart.provider", provider());
                            observe("restart.providerField", field ? field->property("text") : QVariant());
                            require(provider()["model"] == kSavedModel, "SAVED_PROVIDER_NOT_RESTORED");
                            require(field && field->property("text") == kSavedModel, "PROVIDER_FIELD_NOT_RESTORED");
                            return true;
                        }}}});
        cases.append({"restart.preferences-restored", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"restored", 3000, [this] {
                            auto *motion = named("reduceMotion");
                            auto *transparency = named("reduceTransparency");
                            observe("restart.reducedMotion", s->reducedMotion());
                            observe("restart.reducedTransparency", s->reducedTransparency());
                            require(s->reducedMotion() && s->reducedTransparency(), "PREFERENCES_NOT_RESTORED");
                            require(motion && transparency && motion->property("checked").toBool() &&
                                        transparency->property("checked").toBool(),
                                    "PREFERENCE_SWITCHES_NOT_RESTORED");
                            click("reduceMotion");
                            click("reduceTransparency");
                            return true;
                        }},
                       {"cleared", 5000, [this] { return !s->reducedMotion() && !s->reducedTransparency(); }}}});
        cases.append({"restart.model-selection-restored", {"setup.connected"},
                      {{"ready", 60000, [this] {
                            if (!s->avatarState().contains("就绪"))
                                return false;
                            observe("restart.avatarPath", s->avatarPath());
                            observe("restart.active", activeAvatar());
                            return true;
                        }}}});
        cases.append({"restart.pause-restored", {"setup.connected"},
                      {openSurface("settings", "nav-settings"),
                       {"restored", 3000, [this] {
                            auto *toggle = pauseSwitch();
                            observe("restart.offlineState", s->state()["offline"]);
                            observe("restart.pauseSwitchChecked", toggle ? toggle->property("checked") : QVariant());
                            require(s->state()["offline"].toBool() && toggle && toggle->property("checked").toBool(),
                                    "PAUSE_NOT_RESTORED");
                            return true;
                        }},
                       closeSurfaces()}});
        Case paused{"restart.no-calls-while-paused", {"restart.pause-restored"}, {}};
        paused.steps += sendChat("补充-重启暂停：这条也不应发出", 15000, false);
        cases.append(paused);
        Case resumed{"restart.resume-uses-saved-config", {"restart.pause-restored"},
                     {openSurface("settings", "nav-settings"), togglePause(false), closeSurfaces()}};
        resumed.steps += sendChat("补充-重启恢复：继续聊聊吧", 20000, true);
        cases.append(resumed);
        Case controlled{"restart.controlled-resume-uses-saved-config", {"setup.connected"},
                        {closeSurfaces(), settlePreviousChat(), openSurface("settings", "nav-settings"),
                         togglePause(false), closeSurfaces()}};
        controlled.steps += sendChat("补充-受控恢复：继续聊聊吧", 20000, true);
        cases.append(controlled);
        return cases;
    }
    Step connected() {
        return {"connected", 40000, [this] {
            if (!s->connected() || provider().isEmpty() || !elapsed(1500)) return false;
            scopeBefore = s->scopeKey();
            return true;
        }};
    }

    // Engine -------------------------------------------------------------
    void tick() {
        if (!scopeBefore.isEmpty()) {
            const QUrl destination(provider()["base_url"].toString());
            if (!s->connected() || s->scopeKey() != scopeBefore || destination.scheme() != "http" ||
                destination.host() != "127.0.0.1" || destination.port() != QUrl(endpoint).port()) {
                safetyStopped = true;
                finishCase("failed", "SAFETY_STOP:session-or-isolated-destination-changed");
                for (int i = caseIndex; i < plan.size(); ++i)
                    results[plan[i].id] = QVariantMap{{"status", "not-executed"}, {"reason", "safety-stop"}};
                return finish();
            }
        }
        if (clock.elapsed() > 205000) {
            finishCase("failed", "SUPPLEMENTARY_DEADLINE");
            for (int i = caseIndex; i < plan.size(); ++i)
                if (!results.contains(plan[i].id))
                    results[plan[i].id] = QVariantMap{{"status", "not-executed"}, {"reason", "deadline"}};
            return finish();
        }
        if (caseIndex >= plan.size())
            return finish();
        auto &current = plan[caseIndex];
        if (!caseStarted) {
            for (const auto &dependency : current.dependsOn) {
                const auto status = results.value(dependency).toMap()["status"].toString();
                if (status != "passed" && status != "partial") {
                    results[current.id] = QVariantMap{{"status", "blocked"}, {"blockedBy", dependency},
                                                      {"cycle", cycle}};
                    ++caseIndex;
                    return;
                }
            }
            caseStarted = true;
            stepIndex = 0;
            gaps.clear();
            stepLog.clear();
            stepClock.start();
            lastAction = -1;
        }
        const auto &step = current.steps[stepIndex];
        if (stepClock.elapsed() >= step.timeoutMs)
            return finishCase("failed", "TIMEOUT:" + step.name);
        bool complete = false;
        try {
            complete = step.poll();
        } catch (const std::exception &e) {
            return finishCase("failed", QString("%1:%2").arg(step.name, e.what()));
        }
        if (!complete) {
            if (stepClock.elapsed() > step.timeoutMs)
                finishCase("failed", "TIMEOUT:" + step.name);
            return;
        }
        stepLog.append(QVariantMap{{"step", step.name}, {"ms", stepClock.elapsed()},
                                  {"timeoutMs", step.timeoutMs}, {"metadata", currentMetadata()}});
        stepClock.restart();
        lastAction = -1;
        if (++stepIndex >= current.steps.size())
            finishCase(gaps.isEmpty() ? "passed" : "partial");
    }
    void finishCase(const QString &status, const QString &error = {}) {
        if (caseIndex >= plan.size())
            return;
        const auto &current = plan[caseIndex];
        results[current.id] = QVariantMap{{"status", status}, {"error", error}, {"gaps", gaps},
                                          {"steps", stepLog}, {"cycle", cycle},
                                          {"finalMetadata", currentMetadata()}};
        if (!error.isEmpty())
            w->grabWindow().save(capturePrefix + "." + current.id + ".failure.png");
        // A failed setup leaves nothing for the remaining cases to observe.
        if (current.id == "setup.connected" && status != "passed") {
            for (int i = caseIndex + 1; i < plan.size(); ++i)
                results[plan[i].id] = QVariantMap{{"status", "blocked"}, {"blockedBy", current.id}};
            caseIndex = plan.size();
        } else
            ++caseIndex;
        caseStarted = false;
    }
    void finish() {
        timer.stop();
        auto callback = std::move(done);
        if (callback)
            callback({{"cases", results},
                      {"observations", observations},
                      {"captures", captures},
                      {"safetyStopped", safetyStopped},
                      {"limitations", QStringList{"One authorized model; reselect does not establish switching between different models",
                                                  "Server writes cannot acknowledge receipt by the application"}},
                      {"order", [this] {
                           QStringList ids;
                           for (const auto &c : plan)
                               ids.append(c.id);
                           return ids;
                       }()},
                      {"elapsedMs", clock.elapsed()},
                      {"inputScope", "Native controls clicked with synthetic mouse and key events; text via "
                                     "synthetic input-method commits; controls inside scrolled pages are "
                                     "brought into view by setting the page's contentY (test positioning, not "
                                     "a wheel or drag path); the model folder picker is a system dialog and its "
                                     "selected path is passed to the same import method"}});
        deleteLater();
    }
};
} // namespace

namespace SupplementaryFunctionCheck {
void run(QQuickWindow *window, RuntimeBridge *session, int cycle, const QString &endpoint,
         const QString &model, const QString &capturePrefix, std::function<void(QVariantMap)> completion) {
    new Check(window, session, cycle, endpoint, model, capturePrefix, std::move(completion));
}
} // namespace SupplementaryFunctionCheck
