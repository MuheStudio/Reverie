#include "OnboardingCheck.h"
#include "../src/RuntimeBridge.h"
#include "ControlReadiness.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QQuickItem>
#include <QQuickWindow>
#include <QTest>
#include <QTimer>

namespace {
const QString nickname = "引导测试称呼";
// The ordinary profile save and backup restore checks subsequently confirm
// this value; restart must retain that final fixture, not the earlier nickname.
const QString restartExpectedNickname = "小星";
// The mock model reports whether this text ever reaches a request; it must not.
const QString heldChat = "首次引导记录：还没选服务时发送";
const QString unconfiguredText = "还没有配置回复服务，输入已保留。请先在设置里选择服务。";

QQuickItem *find(QQuickItem *root, const QString &name) {
    if (root->objectName() == name && root->isVisible())
        return root;
    for (auto *c : root->childItems())
        if (auto *f = find(c, name))
            return f;
    return nullptr;
}
QQuickItem *named(QQuickItem *root, const QString &name) {
    if (auto *visible = find(root, name))
        return visible;
    if (root->objectName() == name)
        return root;
    for (auto *c : root->childItems())
        if (auto *f = named(c, name))
            return f;
    return nullptr;
}
class Check final : public QObject {
  public:
    QQuickWindow *w;
    RuntimeBridge *s;
    bool verifyOnly;
    QString endpoint, capturePrefix;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock;
    int step = 0;
    qint64 at = 0;
    int messagesBeforeHeldChat = -1;
    bool executing = false;
    QVariantList cases, readiness;
    QVariantMap observed;
    NativeControlReadiness::OnceGate gate;
    Check(QQuickWindow *window, RuntimeBridge *session, bool verify, QString url, QString prefix,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), verifyOnly(verify), endpoint(std::move(url)),
          capturePrefix(std::move(prefix)), done(std::move(callback)) {
        clock.start();
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing)
                return;
            executing = true;
            try {
                tick();
            } catch (const std::exception &ex) {
                finish(false, ex.what());
            }
            executing = false;
        });
        timer.start();
    }
    void next(int target) {
        step = target;
        at = clock.elapsed();
    }
    void require(bool value, const QString &message) {
        if (!value)
            throw std::runtime_error(message.toStdString());
    }
    void click(const QString &name) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "ONBOARDING_CONTROL_UNAVAILABLE:" + name);
        auto p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint(), 0);
    }
    void type(const QString &name, const QString &text) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "ONBOARDING_EDITOR_UNAVAILABLE:" + name);
        i->forceActiveFocus();
        QMetaObject::invokeMethod(i, "selectAll");
        QInputMethodEvent commit;
        commit.setCommitString(text);
        QCoreApplication::sendEvent(w, &commit);
        require(i->property("text").toString() == text, "ONBOARDING_INPUT_NOT_COMMITTED:" + name);
    }
    bool awaiting(const QString &command) const {
        for (const auto &value : s->diagnostics()["pendingCommands"].toList())
            if (value.toMap().value("command") == command)
                return true;
        return false;
    }
    bool settingsOpen() const {
        auto *i = named(w->contentItem(), "drawer-settings");
        return i && i->property("inputReady").toBool();
    }
    bool surfacesClosed() const {
        for (const auto &name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            auto *i = named(w->contentItem(), name);
            if (i && i->property("progress").toDouble() > 0)
                return false;
        }
        return true;
    }
    QQuickItem *sheet() const { return named(w->contentItem(), "firstRunSheet"); }
    bool sheetShown() const { return sheet() && sheet()->isVisible(); }
    // The sheet's controls take input only while it is up and no surface is open.
    bool sheetReady() const { return sheetShown() && surfacesClosed(); }
    int sheetStep() const { return sheet() ? sheet()->property("step").toInt() : -1; }
    QString text(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i ? i->property("text").toString() : QString();
    }
    bool fullyInView(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        if (!i || i->height() < 1)
            return false;
        const auto rect = NativeControlReadiness::visibleRect(i, w);
        return rect.width() >= 2 && rect.height() >= i->height() - 1;
    }
    QString gateStatus() const { return s->chatSendGate().value("status").toString(); }
    QVariantMap ui() const { return s->state().value("settings").toMap().value("ui").toMap(); }
    QString savedNickname() const {
        return s->state().value("profile").toMap().value("profile").toMap().value("nickname").toString();
    }
    // Same input-eligibility gate as the other checks: the step's own 4 s, measured
    // from the step start, and the action runs at most once.
    bool whenReady(const QString &name, bool surface, const std::function<void()> &action) {
        const auto result = gate.poll(clock.elapsed() - at, 4000, [&] {
            auto state = NativeControlReadiness::snapshot(named(w->contentItem(), name), w, surface);
            state["control"] = name;
            state["step"] = step;
            return state;
        }, action);
        require(result != NativeControlReadiness::OnceGate::Expired, "ONBOARDING_READINESS_DEADLINE:" + name);
        if (result != NativeControlReadiness::OnceGate::Performed)
            return false;
        readiness.append(QVariantMap{{"step", step}, {"control", name}, {"gate", gate.metadata()}});
        gate.resetForNextStep();
        return true;
    }
    void record(const QString &name, const QVariantMap &extra = {}) {
        auto entry = extra;
        entry.insert({{"name", name}, {"passed", true}});
        cases.append(entry);
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        auto callback = std::move(done);
        if (callback)
            callback({{"passed", passed},
                      {"error", error},
                      {"mode", verifyOnly ? "restart-readback" : "first-run-walk"},
                      {"step", step},
                      {"checks", cases},
                      {"observed", observed},
                      {"readiness", readiness},
                      {"readinessCurrent", gate.metadata()},
                      {"readinessPollIntervalMs", timer.interval()},
                      {"inputMethodScope", "synthetic QInputMethodEvent commits, not physical OS IME acceptance"}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < (verifyOnly ? 30000 : 90000), "ONBOARDING_TIMEOUT");
        if (verifyOnly)
            verify();
        else
            walk();
    }
    // Startup reads have settled: settings, profile and the reply service.
    bool startupRead() const {
        return s->state().value("settings").toMap().value("ok").toBool() && !awaiting("settings:get") &&
               !awaiting("user:profile:get") && !awaiting("provider:get");
    }
    void walk() {
        if (step == 0) {
            if (!startupRead() || gateStatus() != "provider_unconfigured")
                return;
            require(s->firstRunPending() && ui().value("onboarding_completed") == QVariant(false),
                    "ONBOARDING_NOT_PENDING_ON_FRESH_INSTALL");
            require(!s->state().contains("provider") && s->messages().isEmpty(), "ONBOARDING_FRESH_STATE_UNEXPECTED");
            next(1);
            return;
        }
        if (step == 1 && whenReady("firstRunStart", sheetReady(), [this] {
                require(sheetShown() && sheetStep() == 0 && fullyInView("firstRunCard"), "ONBOARDING_SHEET_NOT_SHOWN");
                w->grabWindow().save(capturePrefix + ".onboarding-welcome.png");
                record("sheet-shown-on-fresh-install", {{"gate", gateStatus()}});
                click("firstRunStart");
            })) {
            next(2);
            return;
        }
        if (step == 2 && whenReady("firstRunOpenService", sheetReady(), [this] {
                require(sheetStep() == 1 && text("firstRunServiceStatus") == "还没有配置回复服务。" &&
                            find(w->contentItem(), "firstRunSkipService") &&
                            !find(w->contentItem(), "firstRunServiceNext"),
                        "ONBOARDING_SERVICE_STEP_NOT_UNCONFIGURED");
                click("firstRunOpenService");
            })) {
            next(3);
            return;
        }
        // The hand-off opens the one service page; the sheet stays away while it is open.
        if (step == 3 && whenReady("settings-close", settingsOpen(), [this] {
                require(!sheetShown() && find(w->contentItem(), "settingsServicePage") &&
                            find(w->contentItem(), "providerEndpoint"),
                        "ONBOARDING_HANDOFF_NOT_ON_SERVICE_PAGE");
                w->grabWindow().save(capturePrefix + ".onboarding-handoff.png");
                record("service-handoff-opens-the-service-page");
                click("settings-close");
            })) {
            next(4);
            return;
        }
        if (step == 4) {
            require(clock.elapsed() - at < 10000, "ONBOARDING_SHEET_DID_NOT_RETURN");
            if (!surfacesClosed() || !sheetShown())
                return;
            require(sheetStep() == 1 && text("firstRunServiceStatus") == "还没有配置回复服务。" &&
                        gateStatus() == "provider_unconfigured" && !s->state().contains("provider") &&
                        !awaiting("provider:configure"),
                    "ONBOARDING_RETURN_CHANGED_THE_SERVICE");
            record("service-handoff-returns-without-saving");
            next(5);
            return;
        }
        if (step == 5 && whenReady("firstRunSkipService", sheetReady(), [this] { click("firstRunSkipService"); })) {
            next(6);
            return;
        }
        if (step == 6 && whenReady("firstRunNickname", sheetReady(), [this] {
                require(sheetStep() == 2, "ONBOARDING_NICKNAME_STEP_MISSING");
                type("firstRunNickname", nickname);
                click("firstRunSaveNickname");
            })) {
            next(7);
            return;
        }
        if (step == 7) {
            require(clock.elapsed() - at < 10000, "ONBOARDING_NICKNAME_SAVE_TIMEOUT");
            const auto receipt = s->memoryFeedback().value("profile").toMap();
            require(receipt.value("status") != "error", "ONBOARDING_NICKNAME_SAVE_FAILED:" + receipt.value("text").toString());
            if (sheetStep() != 3)
                return;
            const auto actualNickname = savedNickname();
            observed["nicknameReadback"] = QVariantMap{{"phase", "first-run"},
                                                        {"expectedNickname", nickname},
                                                        {"actualNickname", actualNickname},
                                                        {"match", actualNickname == nickname}};
            require(receipt.value("status") == "success" && actualNickname == nickname,
                    "ONBOARDING_NICKNAME_RECEIPT_MISSING");
            record("nickname-saved-with-receipt");
            next(8);
            return;
        }
        if (step == 8 && whenReady("firstRunFinish", sheetReady(), [this] {
                w->grabWindow().save(capturePrefix + ".onboarding-finish.png");
                click("firstRunFinish");
            })) {
            next(9);
            return;
        }
        // Only the runtime's read-back of the flag ends the sheet.
        if (step == 9) {
            require(clock.elapsed() - at < 10000, "ONBOARDING_FINISH_TIMEOUT");
            const auto receipt = s->settingsFeedback().value("onboarding").toMap();
            require(receipt.value("status") != "error" && receipt.value("status") != "unknown",
                    "ONBOARDING_FINISH_NOT_CONFIRMED:" + receipt.value("text").toString());
            if (receipt.value("status") != "success" || s->firstRunPending() || sheetShown())
                return;
            require(ui().value("onboarding_completed") == QVariant(true) && ui().value("onboarding_state") == "complete",
                    "ONBOARDING_FLAG_NOT_READ_BACK");
            record("finish-read-back-hides-sheet", {{"receipt", receipt.value("text")}});
            next(10);
            return;
        }
        // A chat before any service is chosen is held with its draft; nothing is read or sent.
        // The network gate is settled first, so only the reply-service gate can hold this chat.
        if (step == 10 && whenReady("chatComposer", surfacesClosed() && s->networkFeedback().value("known").toBool() &&
                                                        s->networkFeedback().value("status") != "pending", [this] {
                messagesBeforeHeldChat = int(s->messages().size());
                type("chatComposer", heldChat);
                click("sendChat");
            })) {
            next(11);
            return;
        }
        if (step == 11 && clock.elapsed() - at > 400) {
            require(!awaiting("chat:send") && !awaiting("provider:get") && !s->busy() &&
                        int(s->messages().size()) == messagesBeforeHeldChat && s->draft() == heldChat &&
                        text("chatComposer") == heldChat,
                    "ONBOARDING_HELD_CHAT_WAS_SENT_OR_LOST");
            require(s->chatFeedback().value("status") == "provider_unconfigured" &&
                        text("chatFeedbackText") == unconfiguredText && fullyInView("chatFeedbackText"),
                    "ONBOARDING_UNCONFIGURED_TEXT_NOT_SHOWN:" + text("chatFeedbackText"));
            w->grabWindow().save(capturePrefix + ".onboarding-held-chat.png");
            observed["heldChatText"] = text("chatFeedbackText");
            record("chat-held-until-a-service-is-chosen");
            finish(true);
        }
    }
    void verify() {
        if (step == 0) {
            if (!startupRead() || !s->state().contains("provider") || !s->state().contains("profile"))
                return;
            const auto provider = s->state().value("provider").toMap();
            require(!s->firstRunPending() && !sheetShown(), "RESTART_SHEET_SHOWN_AGAIN");
            require(ui().value("onboarding_completed") == QVariant(true), "RESTART_FLAG_NOT_READ_BACK");
            const auto actualNickname = savedNickname();
            observed["nicknameReadback"] = QVariantMap{{"phase", "restart"},
                                                        {"expectedNickname", restartExpectedNickname},
                                                        {"actualNickname", actualNickname},
                                                        {"match", actualNickname == restartExpectedNickname}};
            require(actualNickname == restartExpectedNickname, "RESTART_NICKNAME_NOT_READ_BACK");
            require(provider.value("model") == "reverie-qt-test" && provider.value("base_url") == endpoint &&
                        gateStatus() != "provider_unconfigured",
                    "RESTART_SERVICE_NOT_READ_BACK");
            require(!s->settingsFeedback().contains("onboarding") && !awaiting("settings:update"),
                    "RESTART_CHECK_WROTE_SETTINGS");
            record("restart-sheet-absent-and-read-back");
            finish(true);
        }
    }
};
} // namespace

namespace OnboardingCheck {
void run(QQuickWindow *w, RuntimeBridge *s, bool verifyOnly, const QString &endpoint, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion) {
    new Check(w, s, verifyOnly, endpoint, capturePrefix, std::move(completion));
}
} // namespace OnboardingCheck
