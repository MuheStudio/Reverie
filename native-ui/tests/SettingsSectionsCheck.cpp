#include "SettingsSectionsCheck.h"
#include "../src/RuntimeBridge.h"
#include "ControlReadiness.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QTest>
#include <QTimer>
#include <cmath>

namespace {
// The mock model reports whether these reach the next prompt; both chat texts
// ask for a careful answer, so the reply keeps its full length.
const QString flawsText = "设置检查缺点：总把猎户座认成北斗";
const QString firstChat = "设置记录一：请认真分几句说说明天的安排";
const QString secondChat = "设置记录二：请认真分几句说说明天的安排";

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
    QString capturePrefix;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock;
    int step = 0;
    qint64 at = 0;
    int commandsBeforeCancel = -1;
    QVariantMap receiptBeforeCancel;
    bool executing = false;
    QVariantList cases, readiness;
    QVariantMap observed;
    QString budgetBeforeReceipt, budgetBeforeRead;
    int budgetReadBaseline = 0;
    QVariantList budgetActions;
    NativeControlReadiness::OnceGate gate;
    Check(QQuickWindow *window, RuntimeBridge *session, bool verify, QString prefix,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), verifyOnly(verify), capturePrefix(std::move(prefix)),
          done(std::move(callback)) {
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
        require(i && i->isEnabled(), "SETTINGS_CONTROL_UNAVAILABLE:" + name);
        auto p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint(), 0);
    }
    void type(const QString &name, const QString &text) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "SETTINGS_EDITOR_UNAVAILABLE:" + name);
        i->forceActiveFocus();
        QMetaObject::invokeMethod(i, "selectAll");
        QInputMethodEvent commit;
        commit.setCommitString(text);
        QCoreApplication::sendEvent(w, &commit);
        require(i->property("text").toString() == text, "SETTINGS_INPUT_NOT_COMMITTED:" + name);
    }
    bool awaiting(const QString &command) const {
        for (const auto &value : s->diagnostics()["pendingCommands"].toList())
            if (value.toMap().value("command") == command)
                return true;
        return false;
    }
    int commands() const { return s->diagnostics()["commands"].toInt(); }
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
    bool fullyInView(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        if (!i || i->height() < 1)
            return false;
        const auto rect = NativeControlReadiness::visibleRect(i, w);
        return rect.width() >= 2 && rect.height() >= i->height() - 1;
    }
    // Same input-eligibility gate as the archive check: the step's own 4 s,
    // measured from the step start, and the action runs at most once. The
    // forgetting and misremembering pages first reveal the whole control in
    // the settings scroll area, on the same step clock.
    bool whenReady(const QString &name, bool surface, const std::function<void()> &action, bool reveal = false) {
        const auto result = gate.poll(clock.elapsed() - at, 4000, [&] {
            auto *item = named(w->contentItem(), name);
            QVariantMap revealed;
            if (reveal && item)
                revealed = NativeControlReadiness::revealWholeItem(item, [this] { return clock.elapsed() - at; }, 4000);
            auto state = NativeControlReadiness::snapshot(item, w, surface);
            state["control"] = name;
            state["step"] = step;
            if (reveal)
                state["revealSummary"] = NativeControlReadiness::revealSummary(revealed);
            return state;
        }, action);
        require(result != NativeControlReadiness::OnceGate::Expired, "SETTINGS_READINESS_DEADLINE:" + name);
        if (result != NativeControlReadiness::OnceGate::Performed)
            return false;
        readiness.append(QVariantMap{{"step", step}, {"control", name}, {"gate", gate.metadata()}});
        gate.resetForNextStep();
        return true;
    }
    QVariant value(const QString &section, const QString &key) const {
        const auto snapshot = s->state().value("settings").toMap();
        return snapshot.value(section == "personality" ? QString("features") : section).toMap().value(key);
    }
    bool is(const QString &section, const QString &key, bool expected) const {
        const auto v = value(section, key);
        return v.metaType().id() == QMetaType::Bool && v.toBool() == expected;
    }
    int retention() const { return value("memory", "retention_days").toInt(); }
    bool number(const QString &key, double expected, const QString &section = "memory") const {
        const auto v = value(section, key);
        const auto type = v.metaType().id();
        return (type == QMetaType::Double || type == QMetaType::Int || type == QMetaType::LongLong) &&
               std::abs(v.toDouble() - expected) < 1e-9;
    }
    // The page's own presets, read back from the snapshot and the segments.
    bool onlyAccented(const QString &prefix, const QList<int> &presets, int chosen) const {
        for (const int preset : presets)
            if (accented(prefix + "-" + QString::number(preset)) != (preset == chosen))
                return false;
        return true;
    }
    // The parameters the running emotion system reports, beside the saved ones.
    bool emotionRuns(bool enabled, int days, double ratio) const {
        const auto runtime = s->state().value("settings").toMap().value("emotionRuntime").toMap();
        return runtime.value("enabled").metaType().id() == QMetaType::Bool &&
               runtime.value("enabled").toBool() == enabled && runtime.value("carryover_days").toDouble() == days &&
               std::abs(runtime.value("inertia_factor").toDouble() - ratio) < 1e-9 &&
               is("personality", "emotion_system_enabled", enabled) &&
               number("emotion_carryover_days", days, "personality") &&
               number("emotion_inertia_factor", ratio, "personality");
    }
    QVariantMap budgetRuntime() const {
        return s->state().value("settings").toMap().value("budgetRuntime").toMap();
    }
    bool budgetRuns(bool enforced, int requests, int tokens) const {
        const auto runtime = budgetRuntime();
        const auto exactNumber = [](const QVariant &v, int expected) {
            const auto type = v.metaType().id();
            return (type == QMetaType::Int || type == QMetaType::LongLong || type == QMetaType::Double) &&
                   v.toDouble() == expected;
        };
        return runtime.value("tracking_enabled").metaType().id() == QMetaType::Bool &&
               runtime.value("tracking_enabled").toBool() &&
               runtime.value("background_enforced").metaType().id() == QMetaType::Bool &&
               runtime.value("background_enforced").toBool() == enforced &&
               exactNumber(runtime.value("request_budget"), requests) &&
               exactNumber(runtime.value("token_budget"), tokens) &&
               is("personality", "api_budget_tracking_enabled", true) &&
               is("personality", "api_background_budget_enforced", enforced) &&
               number("api_background_daily_request_budget", requests, "personality") &&
               number("api_background_daily_token_budget", tokens, "personality");
    }
    // Only scalar ledger metadata, never prompts, purpose text or a whole state dump.
    void observeBudget(const QString &phase) {
        const auto state = s->budgetState();
        const auto snapshot = state.value("snapshot").toMap();
        const auto background = snapshot.value("background").toMap();
        const auto runtime = budgetRuntime();
        observed["budgetAcquisition"] = QVariantMap{
            {"phase", phase}, {"step", step}, {"elapsedMs", clock.elapsed() - at},
            {"status", state.value("status")}, {"live", state.value("live")}, {"stale", state.value("stale")},
            {"requestId", state.value("requestId")}, {"generation", state.value("generation")},
            {"readDispatchCount", state.value("readDispatchCount")},
            {"tracking", runtime.value("tracking_enabled")}, {"enforced", runtime.value("background_enforced")},
            {"requestBudget", runtime.value("request_budget")}, {"tokenBudget", runtime.value("token_budget")},
            {"requests", background.value("requests")}, {"tokens", background.value("tokens")}};
    }
    void armBudgetSave() {
        budgetBeforeReceipt = receipt("personality").value("requestId").toString();
        budgetBeforeRead = s->budgetState().value("requestId").toString();
    }
    bool budgetReadReady(const QString &phase) {
        observeBudget(phase);
        const auto state = s->budgetState();
        require(clock.elapsed() - at < 10000, "BUDGET_USAGE_READ_DEADLINE");
        // Starting a save invalidates the old usage immediately; its replacement
        // is requested only after the save receipt, so that is not a read error.
        if (!readSettled())
            return false;
        require(state.value("status") != "error", "BUDGET_USAGE_READ_FAILED");
        return state.value("status") == "success" && state.value("live").toBool() &&
               !state.value("stale").toBool() && !awaiting("api:budget:get");
    }
    void requireBudgetSave(bool enforced, int requests, int tokens, const QString &code) {
        requireSaved("personality", "settingsBudgetFeedback", code);
        const auto feedback = receipt("personality");
        const auto read = s->budgetState();
        const QString id = feedback.value("requestId").toString();
        const QString readId = read.value("requestId").toString();
        require(!id.isEmpty() && id != budgetBeforeReceipt && !readId.isEmpty() && readId != budgetBeforeRead &&
                    budgetRuns(enforced, requests, tokens), code + "_NOT_THIS_SAVE_AND_READ");
        budgetActions.append(QVariantMap{{"saveRequestId", id}, {"readRequestId", readId},
                                         {"enforced", enforced}, {"requestBudget", requests}, {"tokenBudget", tokens}});
        observed["budgetActions"] = budgetActions;
    }
    bool budgetUsageVisible() {
        QPointer<QQuickItem> requests = find(w->contentItem(), "settingsBudgetUsageRequests");
        QPointer<QQuickItem> tokens = find(w->contentItem(), "settingsBudgetUsageTokens");
        observed["budgetUsageGeometry"] = QVariantMap{
            {"requests", NativeControlReadiness::wholeVisibility(requests, w)},
            {"tokens", NativeControlReadiness::wholeVisibility(tokens, w)},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"stepElapsedMs", clock.elapsed() - at}};
        if (!requests || !tokens)
            return false;
        const auto revealed = NativeControlReadiness::revealWholeItem(tokens, [this] { return clock.elapsed() - at; }, 4000);
        observed["budgetUsageReveal"] = NativeControlReadiness::revealSummary(revealed);
        observed["budgetUsageGeometry"] = QVariantMap{
            {"requests", NativeControlReadiness::wholeVisibility(requests, w)},
            {"tokens", NativeControlReadiness::wholeVisibility(tokens, w)},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"stepElapsedMs", clock.elapsed() - at}};
        require(!revealed.value("expired").toBool() && clock.elapsed() - at < 4000,
                "BUDGET_USAGE_VISIBILITY_DEADLINE");
        return fullyInView("settingsBudgetUsageRequests") && fullyInView("settingsBudgetUsageTokens");
    }
    void requireBudgetUsage(int expectedReads) {
        const auto state = s->budgetState();
        const auto snapshot = state.value("snapshot").toMap();
        const auto background = snapshot.value("background").toMap();
        const auto count = background.value("requests").toLongLong();
        const auto tokens = background.value("tokens").toLongLong();
        require(budgetRuns(false, 120, 100000) && snapshot.value("tracking_enabled").toBool() &&
                    !snapshot.value("background_enforced").toBool() &&
                    background.value("request_budget").toInt() == 120 && background.value("token_budget").toInt() == 100000,
                "BUDGET_USAGE_LIMITS_NOT_THE_SAVED_RUNTIME");
        require(fieldText("settingsBudgetUsageRequests") == QString("今日后台请求 %1／120 次").arg(count) &&
                    fieldText("settingsBudgetUsageTokens") == QString("今日后台 Token 约 %1／100000").arg(tokens) &&
                    fieldText("settingsBudgetUsageDate") == "统计日期：" + snapshot.value("local_day").toString() + "（本机日期）",
                "BUDGET_USAGE_TEXT_NOT_THE_CORRELATED_SNAPSHOT");
        const int delta = state.value("readDispatchCount").toInt() - budgetReadBaseline;
        require(delta == expectedReads, "BUDGET_LOCAL_READ_COUNT_CHANGED");
        observed["budgetUsage"] = QVariantMap{{"requestId", state.value("requestId")},
            {"generation", state.value("generation")}, {"localDay", snapshot.value("local_day")},
            {"requests", count}, {"tokens", tokens}, {"requestBudget", 120}, {"tokenBudget", 100000},
            {"tracking", true}, {"enforced", false}, {"live", true}, {"visible", true},
            {"readDispatchDelta", delta}, {"runtimeMatches", true}};
    }
    bool allDisabled(const QString &prefix, const QList<int> &presets = {1, 3, 5, 10}) const {
        for (const int preset : presets) {
            auto *i = find(w->contentItem(), prefix + "-" + QString::number(preset));
            if (!i || i->isEnabled())
                return false;
        }
        return true;
    }
    bool enabled(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i && i->isEnabled();
    }
    // Settled once no settings save or read is in flight and the last read was complete.
    bool readSettled() const {
        return s->state().value("settings").toMap().value("ok").toBool() &&
               !s->settingsFeedback().contains("read") && !awaiting("settings:get") &&
               !awaiting("settings:update");
    }
    QVariantMap receipt(const QString &section) const { return s->settingsFeedback().value(section).toMap(); }
    bool settled(const QString &section) const {
        return receipt(section).value("status").toString() != "pending" && readSettled();
    }
    bool checked(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i && i->property("checked").toBool();
    }
    bool accented(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i && i->property("accented").toBool();
    }
    QString fieldText(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i ? i->property("text").toString() : QString();
    }
    void requireSaved(const QString &section, const QString &feedbackName, const QString &code) {
        const auto text = receipt(section).value("text").toString();
        require(receipt(section).value("status") == "success", code + ":" + text);
        auto *shown = find(w->contentItem(), feedbackName);
        require(shown && shown->property("text").toString() == text && fullyInView(feedbackName),
                code + "_RECEIPT_NOT_VISIBLE");
    }
    // The committed history carries each delivered bubble with its request id.
    QString chatRequest(const QString &text) const {
        for (const auto &value : s->messages()) {
            const auto message = value.toMap();
            if (message.value("role") == "user" && message.value("content") == text)
                return message.value("request_id").toString();
        }
        return {};
    }
    int assistantBubbles(const QString &request) const {
        int count = 0;
        for (const auto &value : s->messages()) {
            const auto message = value.toMap();
            count += message.value("role") == "assistant" && message.value("request_id") == request;
        }
        return count;
    }
    // A reply is counted only after its history read; -1 while it is still on its way.
    int deliveredBubbles(const QString &text) {
        require(clock.elapsed() - at < 60000, "SETTINGS_CHAT_TIMEOUT");
        if (s->busy() || awaiting("chat:history") || awaiting("chat:send"))
            return -1;
        const auto request = chatRequest(text);
        if (request.isEmpty())
            return -1;
        const int bubbles = assistantBubbles(request);
        return bubbles > 0 ? bubbles : -1;
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
                      {"mode", verifyOnly ? "restart-readback" : "change-and-effect"},
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
        require(clock.elapsed() < (verifyOnly ? 30000 : 120000), "SETTINGS_SECTIONS_TIMEOUT");
        if (verifyOnly)
            verify();
        else
            change();
    }
    void change() {
        if (step == 0) {
            click("nav-settings");
            next(1);
            return;
        }
        if (step == 1) {
            if (!settingsOpen() || !readSettled())
                return;
            // The ordinary check and the fixture configuration leave these values.
            require(is("chat", "split_messages", false) && is("chat", "allow_environment_description", false) &&
                        retention() == 730 && is("memory", "forgetting_enabled", true) &&
                        is("memory", "long_term_forgetting_enabled", true) &&
                        is("memory", "short_term_forgetting_enabled", true) &&
                        is("personality", "personality_flaws_enabled", true) &&
                        is("personality", "personality_flaws_disclaimer_acknowledged", false) &&
                        value("personality", "user_selected_flaws").toString() != flawsText &&
                        number("long_term_forget_days", 90) && number("short_term_forget_days", 7) &&
                        number("long_term_forget_probability", 0.05) &&
                        number("short_term_forget_probability", 0.05) &&
                        is("memory", "misremembering_enabled", false) &&
                        is("memory", "long_term_misremembering_enabled", true) &&
                        is("memory", "short_term_misremembering_enabled", true) &&
                        number("long_term_misremember_probability", 0.05) &&
                        number("short_term_misremember_probability", 0.05) && emotionRuns(true, 3, 0.15),
                    "SETTINGS_STARTING_VALUES_UNEXPECTED");
            observeBudget("initial");
            require(budgetRuns(true, 60, 30000), "BUDGET_STARTING_VALUES_UNEXPECTED");
            next(2);
            return;
        }
        if (step == 2 && whenReady("settingsTab-chat", settingsOpen(), [this] { click("settingsTab-chat"); })) {
            next(3);
            return;
        }
        if (step == 3 && whenReady("settingsSplitMessages", settingsOpen(), [this] {
                require(!checked("settingsSplitMessages"), "SETTINGS_SWITCH_NOT_FROM_READ:split");
                click("settingsSplitMessages");
            })) {
            next(4);
            return;
        }
        if (step == 4 && settled("chat")) {
            requireSaved("chat", "settingsChatFeedback", "CHAT_SPLIT_NOT_SAVED");
            require(is("chat", "split_messages", true) && checked("settingsSplitMessages"),
                    "CHAT_SPLIT_NOT_READ_BACK");
            record("split-switch-saves-and-reads-back");
            next(5);
            return;
        }
        if (step == 5 && whenReady("settingsEnvironmentDescription", settingsOpen(), [this] {
                require(!checked("settingsEnvironmentDescription"), "SETTINGS_SWITCH_NOT_FROM_READ:environment");
                click("settingsEnvironmentDescription");
            })) {
            next(6);
            return;
        }
        if (step == 6 && settled("chat")) {
            requireSaved("chat", "settingsChatFeedback", "CHAT_ENVIRONMENT_NOT_SAVED");
            require(is("chat", "allow_environment_description", true) && checked("settingsEnvironmentDescription") &&
                        is("chat", "split_messages", true),
                    "CHAT_ENVIRONMENT_NOT_READ_BACK");
            record("environment-switch-saves-and-reads-back");
            w->grabWindow().save(capturePrefix + ".settings-chat.png");
            next(7);
            return;
        }
        if (step == 7 && whenReady("settingsTab-traits", settingsOpen(), [this] { click("settingsTab-traits"); })) {
            next(8);
            return;
        }
        if (step == 8 && whenReady("settingsFlawsText", settingsOpen(), [this] {
                require(checked("settingsFlawsEnabled") &&
                            fieldText("settingsFlawsText") == value("personality", "user_selected_flaws").toString(),
                        "FLAWS_CONTROLS_NOT_FROM_READ");
                type("settingsFlawsText", flawsText);
            })) {
            next(9);
            return;
        }
        if (step == 9 && whenReady("settingsFlawsAcknowledged", settingsOpen(), [this] {
                auto *save = find(w->contentItem(), "settingsFlawsSave");
                require(find(w->contentItem(), "settingsFlawsDirtyHint") && save && !save->isEnabled() &&
                            !checked("settingsFlawsAcknowledged"),
                        "FLAWS_SAVE_OFFERED_WITHOUT_ACKNOWLEDGEMENT");
                click("settingsFlawsAcknowledged");
            })) {
            next(10);
            return;
        }
        if (step == 10 && whenReady("settingsFlawsSave", settingsOpen(), [this] {
                click("settingsFlawsSave");
                require(receipt("personality").value("status") == "pending", "FLAWS_SAVE_NOT_SENT");
            })) {
            next(11);
            return;
        }
        if (step == 11 && settled("personality")) {
            requireSaved("personality", "settingsTraitsFeedback", "FLAWS_NOT_SAVED");
            require(value("personality", "user_selected_flaws").toString() == flawsText &&
                        is("personality", "personality_flaws_enabled", true) &&
                        is("personality", "personality_flaws_disclaimer_acknowledged", true) &&
                        checked("settingsFlawsEnabled") && fieldText("settingsFlawsText") == flawsText &&
                        !find(w->contentItem(), "settingsFlawsDirtyHint"),
                    "FLAWS_NOT_READ_BACK");
            record("custom-flaws-need-acknowledgement-and-read-back");
            w->grabWindow().save(capturePrefix + ".settings-traits.png");
            click("settings-close");
            next(12);
            return;
        }
        if (step == 12 && surfacesClosed()) {
            click("nav-chat");
            next(13);
            return;
        }
        if (step == 13 && whenReady("chatComposer", surfacesClosed(), [this] {
                type("chatComposer", firstChat);
                click("sendChat");
            })) {
            next(14);
            return;
        }
        if (step == 14) {
            const int bubbles = deliveredBubbles(firstChat);
            if (bubbles < 0)
                return;
            observed["firstReplyBubbles"] = bubbles;
            require(bubbles >= 2, "SPLIT_SETTING_NOT_APPLIED");
            record("split-setting-splits-the-next-reply", {{"bubbles", bubbles}});
            click("nav-settings");
            next(15);
            return;
        }
        if (step == 15 && settingsOpen()) {
            next(16);
            return;
        }
        if (step == 16 && whenReady("settingsTab-chat", settingsOpen(), [this] { click("settingsTab-chat"); })) {
            next(17);
            return;
        }
        if (step == 17 && whenReady("settingsSplitMessages", settingsOpen(), [this] {
                require(checked("settingsSplitMessages"), "SETTINGS_SWITCH_NOT_FROM_READ:split-on");
                click("settingsSplitMessages");
            })) {
            next(18);
            return;
        }
        if (step == 18 && settled("chat")) {
            requireSaved("chat", "settingsChatFeedback", "CHAT_SPLIT_OFF_NOT_SAVED");
            require(is("chat", "split_messages", false) && !checked("settingsSplitMessages"),
                    "CHAT_SPLIT_OFF_NOT_READ_BACK");
            next(19);
            return;
        }
        if (step == 19 && whenReady("settingsEnvironmentDescription", settingsOpen(), [this] {
                require(checked("settingsEnvironmentDescription"), "SETTINGS_SWITCH_NOT_FROM_READ:environment-on");
                click("settingsEnvironmentDescription");
            })) {
            next(20);
            return;
        }
        if (step == 20 && settled("chat")) {
            requireSaved("chat", "settingsChatFeedback", "CHAT_ENVIRONMENT_OFF_NOT_SAVED");
            require(is("chat", "allow_environment_description", false) &&
                        !checked("settingsEnvironmentDescription"),
                    "CHAT_ENVIRONMENT_OFF_NOT_READ_BACK");
            record("chat-switches-turn-off-and-read-back");
            next(21);
            return;
        }
        if (step == 21 && whenReady("settingsTab-traits", settingsOpen(), [this] { click("settingsTab-traits"); })) {
            next(22);
            return;
        }
        if (step == 22 && whenReady("settingsFlawsEnabled", settingsOpen(), [this] {
                require(checked("settingsFlawsEnabled"), "SETTINGS_SWITCH_NOT_FROM_READ:flaws");
                click("settingsFlawsEnabled");
            })) {
            next(23);
            return;
        }
        if (step == 23 && settled("personality")) {
            requireSaved("personality", "settingsTraitsFeedback", "FLAWS_OFF_NOT_SAVED");
            require(is("personality", "personality_flaws_enabled", false) && !checked("settingsFlawsEnabled") &&
                        value("personality", "user_selected_flaws").toString() == flawsText &&
                        fieldText("settingsFlawsText") == flawsText &&
                        is("personality", "personality_flaws_disclaimer_acknowledged", true),
                    "FLAWS_OFF_NOT_READ_BACK");
            record("flaws-switch-turns-off-and-keeps-the-text");
            next(24);
            return;
        }
        if (step == 24 && whenReady("settingsTab-memory", settingsOpen(), [this] { click("settingsTab-memory"); })) {
            next(25);
            return;
        }
        if (step == 25 && whenReady("settingsRetention-365", settingsOpen(), [this] {
                require(accented("settingsRetention-730") && !accented("settingsRetention-365"),
                        "RETENTION_NOT_FROM_READ");
                commandsBeforeCancel = commands();
                click("settingsRetention-365");
            })) {
            next(26);
            return;
        }
        if (step == 26 && whenReady("settingsRetentionCancel", true, [this] {
                w->grabWindow().save(capturePrefix + ".settings-retention-confirm.png");
                click("settingsRetentionCancel");
            })) {
            next(27);
            return;
        }
        if (step == 27 && !find(w->contentItem(), "settingsRetentionConfirmation")) {
            require(commands() == commandsBeforeCancel && receipt("memory").isEmpty() && retention() == 730 &&
                        accented("settingsRetention-730"),
                    "RETENTION_CANCEL_SENT_OR_CHANGED");
            record("shorter-retention-cancel-sends-nothing");
            next(28);
            return;
        }
        if (step == 28 && whenReady("settingsRetention-365", settingsOpen(), [this] { click("settingsRetention-365"); })) {
            next(29);
            return;
        }
        if (step == 29 && whenReady("settingsRetentionConfirm", true, [this] { click("settingsRetentionConfirm"); })) {
            next(30);
            return;
        }
        if (step == 30 && settled("memory")) {
            requireSaved("memory", "settingsMemoryFeedback", "RETENTION_NOT_SAVED");
            require(retention() == 365 && accented("settingsRetention-365") && !accented("settingsRetention-730"),
                    "RETENTION_NOT_READ_BACK");
            record("shorter-retention-confirmed-and-read-back");
            w->grabWindow().save(capturePrefix + ".settings-memory.png");
            next(31);
            return;
        }
        // Forgetting moved to its own page; its controls start from the read.
        if (step == 31 && whenReady("settingsTab-forgetting", settingsOpen(), [this] { click("settingsTab-forgetting"); })) {
            next(32);
            return;
        }
        if (step == 32 && whenReady("settingsShortTermForgetting", settingsOpen(), [this] {
                require(checked("settingsShortTermForgetting") && checked("settingsForgetting") &&
                            checked("settingsLongTermForgetting") &&
                            onlyAccented("settingsLongForgetDays", {60, 90, 180, 365}, 90) &&
                            onlyAccented("settingsShortForgetDays", {3, 7, 14, 30}, 7) &&
                            onlyAccented("settingsLongForgetChance", {1, 3, 5, 10}, 5) &&
                            onlyAccented("settingsShortForgetChance", {1, 3, 5, 10}, 5),
                        "SETTINGS_SWITCH_NOT_FROM_READ:forgetting");
                click("settingsShortTermForgetting");
            }, true)) {
            next(33);
            return;
        }
        if (step == 33 && settled("memory")) {
            requireSaved("memory", "settingsForgettingFeedback", "SHORT_FORGETTING_NOT_SAVED");
            require(is("memory", "short_term_forgetting_enabled", false) && !checked("settingsShortTermForgetting") &&
                        is("memory", "forgetting_enabled", true) && is("memory", "long_term_forgetting_enabled", true) &&
                        retention() == 365,
                    "SHORT_FORGETTING_NOT_READ_BACK");
            record("short-term-forgetting-saves-and-reads-back");
            next(34);
            return;
        }
        if (step == 34 && whenReady("settingsLongForgetDays-180", settingsOpen(), [this] {
                click("settingsLongForgetDays-180");
            }, true)) {
            next(35);
            return;
        }
        if (step == 35 && settled("memory")) {
            requireSaved("memory", "settingsForgettingFeedback", "LONG_FORGET_DAYS_NOT_SAVED");
            require(number("long_term_forget_days", 180) &&
                        onlyAccented("settingsLongForgetDays", {60, 90, 180, 365}, 180) &&
                        number("short_term_forget_days", 7),
                    "LONG_FORGET_DAYS_NOT_READ_BACK");
            record("long-forget-days-saves-and-reads-back");
            next(36);
            return;
        }
        if (step == 36 && whenReady("settingsLongForgetChance-10", settingsOpen(), [this] {
                click("settingsLongForgetChance-10");
            }, true)) {
            next(37);
            return;
        }
        if (step == 37 && settled("memory")) {
            requireSaved("memory", "settingsForgettingFeedback", "LONG_FORGET_CHANCE_NOT_SAVED");
            require(number("long_term_forget_probability", 0.10) &&
                        onlyAccented("settingsLongForgetChance", {1, 3, 5, 10}, 10) &&
                        number("short_term_forget_probability", 0.05),
                    "LONG_FORGET_CHANCE_NOT_READ_BACK");
            record("long-forget-chance-saves-and-reads-back");
            next(38);
            return;
        }
        // Short-term forgetting is off: its chance waits, its days still count.
        if (step == 38 && whenReady("settingsShortForgetDays-14", settingsOpen(), [this] {
                require(allDisabled("settingsShortForgetChance") && enabled("settingsLongForgetChance-1"),
                        "SHORT_FORGET_CHANCE_OFFERED_WHILE_OFF");
                click("settingsShortForgetDays-14");
            }, true)) {
            next(39);
            return;
        }
        if (step == 39 && settled("memory")) {
            requireSaved("memory", "settingsForgettingFeedback", "SHORT_FORGET_DAYS_NOT_SAVED");
            require(number("short_term_forget_days", 14) &&
                        onlyAccented("settingsShortForgetDays", {3, 7, 14, 30}, 14) &&
                        allDisabled("settingsShortForgetChance"),
                    "SHORT_FORGET_DAYS_NOT_READ_BACK");
            record("short-forget-days-saves-while-its-chance-is-disabled");
            w->grabWindow().save(capturePrefix + ".settings-forgetting.png");
            next(40);
            return;
        }
        if (step == 40 && whenReady("settingsTab-misremember", settingsOpen(), [this] { click("settingsTab-misremember"); })) {
            next(41);
            return;
        }
        if (step == 41 && whenReady("settingsMisremembering", settingsOpen(), [this] {
                require(!checked("settingsMisremembering") && checked("settingsLongTermMisremembering") &&
                            checked("settingsShortTermMisremembering") &&
                            !enabled("settingsLongTermMisremembering") && !enabled("settingsShortTermMisremembering") &&
                            allDisabled("settingsLongMisrememberChance") &&
                            allDisabled("settingsShortMisrememberChance") &&
                            onlyAccented("settingsLongMisrememberChance", {1, 3, 5, 10}, 5),
                        "MISREMEMBER_CONTROLS_NOT_FROM_READ");
                commandsBeforeCancel = commands();
                receiptBeforeCancel = receipt("memory");
                click("settingsMisremembering");
            }, true)) {
            next(42);
            return;
        }
        if (step == 42 && whenReady("settingsMisrememberCancel", true, [this] {
                w->grabWindow().save(capturePrefix + ".settings-misremember-confirm.png");
                click("settingsMisrememberCancel");
            })) {
            next(43);
            return;
        }
        if (step == 43 && !find(w->contentItem(), "settingsMisrememberConfirmation")) {
            require(commands() == commandsBeforeCancel && receipt("memory") == receiptBeforeCancel &&
                        is("memory", "misremembering_enabled", false) && !checked("settingsMisremembering"),
                    "MISREMEMBER_CANCEL_SENT_OR_CHANGED");
            record("misremembering-cancel-sends-nothing");
            next(44);
            return;
        }
        if (step == 44 && whenReady("settingsMisremembering", settingsOpen(), [this] {
                click("settingsMisremembering");
            }, true)) {
            next(45);
            return;
        }
        if (step == 45 && whenReady("settingsMisrememberConfirm", true, [this] { click("settingsMisrememberConfirm"); })) {
            next(46);
            return;
        }
        if (step == 46 && settled("memory")) {
            requireSaved("memory", "settingsMisrememberFeedback", "MISREMEMBERING_NOT_SAVED");
            require(is("memory", "misremembering_enabled", true) && checked("settingsMisremembering") &&
                        enabled("settingsLongTermMisremembering") && enabled("settingsShortTermMisremembering") &&
                        enabled("settingsLongMisrememberChance-3") && enabled("settingsShortMisrememberChance-3"),
                    "MISREMEMBERING_NOT_READ_BACK");
            record("misremembering-confirmed-and-read-back");
            next(47);
            return;
        }
        if (step == 47 && whenReady("settingsLongMisrememberChance-3", settingsOpen(), [this] {
                click("settingsLongMisrememberChance-3");
            }, true)) {
            next(48);
            return;
        }
        if (step == 48 && settled("memory")) {
            requireSaved("memory", "settingsMisrememberFeedback", "LONG_MISREMEMBER_CHANCE_NOT_SAVED");
            require(number("long_term_misremember_probability", 0.03) &&
                        onlyAccented("settingsLongMisrememberChance", {1, 3, 5, 10}, 3) &&
                        number("short_term_misremember_probability", 0.05),
                    "LONG_MISREMEMBER_CHANCE_NOT_READ_BACK");
            record("long-misremember-chance-saves-and-reads-back");
            next(49);
            return;
        }
        if (step == 49 && whenReady("settingsShortTermMisremembering", settingsOpen(), [this] {
                click("settingsShortTermMisremembering");
            }, true)) {
            next(50);
            return;
        }
        if (step == 50 && settled("memory")) {
            requireSaved("memory", "settingsMisrememberFeedback", "SHORT_MISREMEMBERING_NOT_SAVED");
            require(is("memory", "short_term_misremembering_enabled", false) &&
                        !checked("settingsShortTermMisremembering") && allDisabled("settingsShortMisrememberChance") &&
                        is("memory", "misremembering_enabled", true) &&
                        is("memory", "long_term_misremembering_enabled", true),
                    "SHORT_MISREMEMBERING_NOT_READ_BACK");
            record("short-misremembering-saves-and-reads-back");
            w->grabWindow().save(capturePrefix + ".settings-misremember.png");
            next(60);
            return;
        }
        // The emotion page (steps 60-66) runs before the second chat, so that
        // chat's request shows the kept emotion still reaching the prompt.
        if (step == 60 && whenReady("settingsTab-emotion", settingsOpen(), [this] { click("settingsTab-emotion"); })) {
            next(61);
            return;
        }
        if (step == 61 && whenReady("settingsEmotionCarryoverDays-5", settingsOpen(), [this] {
                require(checked("settingsEmotionEnabled") &&
                            onlyAccented("settingsEmotionCarryoverDays", {1, 3, 5, 7}, 3) &&
                            onlyAccented("settingsEmotionInertia", {5, 10, 15, 30}, 15) && emotionRuns(true, 3, 0.15),
                        "EMOTION_CONTROLS_NOT_FROM_READ");
                click("settingsEmotionCarryoverDays-5");
            }, true)) {
            next(62);
            return;
        }
        if (step == 62 && settled("personality")) {
            requireSaved("personality", "settingsEmotionFeedback", "EMOTION_DAYS_NOT_SAVED");
            require(emotionRuns(true, 5, 0.15) && onlyAccented("settingsEmotionCarryoverDays", {1, 3, 5, 7}, 5),
                    "EMOTION_DAYS_NOT_READ_BACK_FROM_THE_RUNTIME");
            record("emotion-carryover-days-reach-the-running-emotion");
            next(63);
            return;
        }
        if (step == 63 && whenReady("settingsEmotionInertia-30", settingsOpen(), [this] {
                click("settingsEmotionInertia-30");
            }, true)) {
            next(64);
            return;
        }
        if (step == 64 && settled("personality")) {
            requireSaved("personality", "settingsEmotionFeedback", "EMOTION_RATIO_NOT_SAVED");
            require(emotionRuns(true, 5, 0.30) && onlyAccented("settingsEmotionInertia", {5, 10, 15, 30}, 30),
                    "EMOTION_RATIO_NOT_READ_BACK_FROM_THE_RUNTIME");
            record("emotion-ratio-reaches-the-running-emotion");
            next(65);
            return;
        }
        if (step == 65 && whenReady("settingsEmotionEnabled", settingsOpen(), [this] {
                click("settingsEmotionEnabled");
            }, true)) {
            next(66);
            return;
        }
        if (step == 66 && settled("personality")) {
            requireSaved("personality", "settingsEmotionFeedback", "EMOTION_OFF_NOT_SAVED");
            require(emotionRuns(false, 5, 0.30) && !checked("settingsEmotionEnabled") &&
                        onlyAccented("settingsEmotionCarryoverDays", {1, 3, 5, 7}, 5) &&
                        onlyAccented("settingsEmotionInertia", {5, 10, 15, 30}, 30) &&
                        allDisabled("settingsEmotionCarryoverDays", {1, 3, 5, 7}) &&
                        allDisabled("settingsEmotionInertia", {5, 10, 15, 30}),
                    "EMOTION_OFF_NOT_READ_BACK_FROM_THE_RUNTIME");
            record("emotion-turns-off-and-keeps-its-presets");
            w->grabWindow().save(capturePrefix + ".settings-emotion.png");
            next(70);
            return;
        }
        // One page-open read and one fresh ledger read for each of three saves.
        // These local RPCs add no model HTTP calls and do not test interception.
        if (step == 70 && whenReady("settingsTab-budget", settingsOpen(), [this] {
                budgetReadBaseline = s->budgetState().value("readDispatchCount").toInt();
                click("settingsTab-budget");
            })) {
            next(71);
            return;
        }
        if (step == 71 && whenReady("settingsBudgetRequests-120", settingsOpen(), [this] {
                require(budgetRuns(true, 60, 30000) && checked("settingsBudgetEnforced") &&
                            onlyAccented("settingsBudgetRequests", {30, 60, 120, 240}, 60) &&
                            onlyAccented("settingsBudgetTokens", {10000, 30000, 100000, 300000}, 30000),
                        "BUDGET_CONTROLS_NOT_FROM_READ");
                armBudgetSave();
                click("settingsBudgetRequests-120");
            }, true)) {
            next(72);
            return;
        }
        if (step == 72) {
            if (!budgetReadReady("request-save") || !settled("personality"))
                return;
            requireBudgetSave(true, 120, 30000, "BUDGET_REQUESTS_NOT_SAVED");
            require(onlyAccented("settingsBudgetRequests", {30, 60, 120, 240}, 120), "BUDGET_REQUESTS_NOT_READ_BACK");
            record("budget-requests-reach-the-running-ledger");
            next(73);
            return;
        }
        if (step == 73 && whenReady("settingsBudgetTokens-100000", settingsOpen(), [this] {
                armBudgetSave();
                click("settingsBudgetTokens-100000");
            }, true)) {
            next(74);
            return;
        }
        if (step == 74) {
            if (!budgetReadReady("token-save") || !settled("personality"))
                return;
            requireBudgetSave(true, 120, 100000, "BUDGET_TOKENS_NOT_SAVED");
            require(onlyAccented("settingsBudgetTokens", {10000, 30000, 100000, 300000}, 100000), "BUDGET_TOKENS_NOT_READ_BACK");
            record("budget-tokens-reach-the-running-ledger");
            next(75);
            return;
        }
        if (step == 75 && whenReady("settingsBudgetEnforced", settingsOpen(), [this] {
                armBudgetSave();
                click("settingsBudgetEnforced");
            }, true)) {
            next(76);
            return;
        }
        if (step == 76) {
            if (!budgetReadReady("limit-off") || !settled("personality"))
                return;
            requireBudgetSave(false, 120, 100000, "BUDGET_OFF_NOT_SAVED");
            require(!checked("settingsBudgetEnforced") &&
                        onlyAccented("settingsBudgetRequests", {30, 60, 120, 240}, 120) &&
                        onlyAccented("settingsBudgetTokens", {10000, 30000, 100000, 300000}, 100000) &&
                        allDisabled("settingsBudgetRequests", {30, 60, 120, 240}) &&
                        allDisabled("settingsBudgetTokens", {10000, 30000, 100000, 300000}),
                    "BUDGET_OFF_CONTROLS_NOT_FROM_READ");
            record("budget-turns-off-and-keeps-its-presets");
            next(77);
            return;
        }
        if (step == 77) {
            observeBudget("usage-visible");
            require(clock.elapsed() - at < 4000, "BUDGET_USAGE_VISIBILITY_DEADLINE");
            if (!budgetUsageVisible())
                return;
            requireBudgetUsage(4);
            record("budget-usage-matches-the-ledger");
            w->grabWindow().save(capturePrefix + ".settings-budget.png");
            next(78);
            return;
        }
        if (step == 78 && whenReady("settings-close", settingsOpen(), [this] { click("settings-close"); }, true)) {
            next(51);
            return;
        }
        if (step == 51 && surfacesClosed()) {
            click("nav-chat");
            next(52);
            return;
        }
        if (step == 52 && whenReady("chatComposer", surfacesClosed(), [this] {
                type("chatComposer", secondChat);
                click("sendChat");
            })) {
            next(53);
            return;
        }
        if (step == 53) {
            const int bubbles = deliveredBubbles(secondChat);
            if (bubbles < 0)
                return;
            observed["secondReplyBubbles"] = bubbles;
            require(bubbles == 1, "SPLIT_OFF_STILL_SPLITS");
            record("split-off-restores-a-single-reply", {{"bubbles", bubbles}});
            click("nav-settings");
            next(54);
            return;
        }
        if (step == 54 && settingsOpen()) {
            next(55);
            return;
        }
        // Leave the terminal on its first page and closed, as the ordinary flow expects.
        if (step == 55 && whenReady("settingsTab-service", settingsOpen(), [this] { click("settingsTab-service"); })) {
            next(56);
            return;
        }
        if (step == 56 && whenReady("settings-close", settingsOpen(), [this] { click("settings-close"); })) {
            next(57);
            return;
        }
        if (step == 57 && surfacesClosed()) {
            observed["saved"] = QVariantMap{{"splitMessages", value("chat", "split_messages")},
                                            {"environmentDescription", value("chat", "allow_environment_description")},
                                            {"retentionDays", retention()},
                                            {"shortTermForgetting", value("memory", "short_term_forgetting_enabled")},
                                            {"longTermForgetDays", value("memory", "long_term_forget_days")},
                                            {"shortTermForgetDays", value("memory", "short_term_forget_days")},
                                            {"longTermForgetProbability", value("memory", "long_term_forget_probability")},
                                            {"misremembering", value("memory", "misremembering_enabled")},
                                            {"shortTermMisremembering", value("memory", "short_term_misremembering_enabled")},
                                            {"longTermMisrememberProbability",
                                             value("memory", "long_term_misremember_probability")},
                                            {"flawsEnabled", value("personality", "personality_flaws_enabled")},
                                            {"emotionEnabled", value("personality", "emotion_system_enabled")},
                                            {"emotionCarryoverDays", value("personality", "emotion_carryover_days")},
                                            {"emotionInertia", value("personality", "emotion_inertia_factor")},
                                            {"budgetTracking", value("personality", "api_budget_tracking_enabled")},
                                            {"budgetEnforced", value("personality", "api_background_budget_enforced")},
                                            {"budgetRequests", value("personality", "api_background_daily_request_budget")},
                                            {"budgetTokens", value("personality", "api_background_daily_token_budget")},
                                            {"flawsTextIsMarker", value("personality", "user_selected_flaws").toString() == flawsText}};
            finish(true);
        }
    }
    // The restart reads every value back; nothing is written.
    void verify() {
        if (step == 0) {
            if (!s->connected() || !readSettled())
                return;
            require(is("chat", "split_messages", false) && is("chat", "allow_environment_description", false) &&
                        retention() == 365 && is("memory", "forgetting_enabled", true) &&
                        is("memory", "long_term_forgetting_enabled", true) &&
                        is("memory", "short_term_forgetting_enabled", false) &&
                        is("personality", "personality_flaws_enabled", false) &&
                        is("personality", "personality_flaws_disclaimer_acknowledged", true) &&
                        value("personality", "user_selected_flaws").toString() == flawsText &&
                        number("long_term_forget_days", 180) && number("short_term_forget_days", 14) &&
                        number("long_term_forget_probability", 0.10) &&
                        number("short_term_forget_probability", 0.05) &&
                        is("memory", "misremembering_enabled", true) &&
                        is("memory", "long_term_misremembering_enabled", true) &&
                        is("memory", "short_term_misremembering_enabled", false) &&
                        number("long_term_misremember_probability", 0.03) &&
                        number("short_term_misremember_probability", 0.05),
                    "RESTART_SETTINGS_NOT_READ_BACK");
            // The persona snapshot was last written before these changes; the
            // running emotion must still follow the global settings.
            require(emotionRuns(false, 5, 0.30), "RESTART_EMOTION_RUNTIME_NOT_THE_SAVED_SETTINGS");
            observeBudget("restart-initial");
            require(budgetRuns(false, 120, 100000), "RESTART_BUDGET_RUNTIME_NOT_THE_SAVED_SETTINGS");
            observed["budgetRestartRuntime"] = budgetRuntime();
            record("restart-reads-saved-settings");
            click("nav-settings");
            next(1);
            return;
        }
        if (step == 1 && settingsOpen()) {
            next(2);
            return;
        }
        if (step == 2 && whenReady("settingsTab-chat", settingsOpen(), [this] { click("settingsTab-chat"); })) {
            next(3);
            return;
        }
        if (step == 3 && whenReady("settingsSplitMessages", settingsOpen(), [this] {
                require(!checked("settingsSplitMessages") && !checked("settingsEnvironmentDescription"),
                        "RESTART_CHAT_CONTROLS_NOT_FROM_READ");
            })) {
            next(4);
            return;
        }
        if (step == 4 && whenReady("settingsTab-memory", settingsOpen(), [this] { click("settingsTab-memory"); })) {
            next(5);
            return;
        }
        if (step == 5 && whenReady("settingsRetention-365", settingsOpen(), [this] {
                require(accented("settingsRetention-365") && !accented("settingsRetention-730"),
                        "RESTART_MEMORY_CONTROLS_NOT_FROM_READ");
            })) {
            next(6);
            return;
        }
        if (step == 6 && whenReady("settingsTab-forgetting", settingsOpen(), [this] { click("settingsTab-forgetting"); })) {
            next(7);
            return;
        }
        if (step == 7 && whenReady("settingsShortTermForgetting", settingsOpen(), [this] {
                require(checked("settingsForgetting") && checked("settingsLongTermForgetting") &&
                            !checked("settingsShortTermForgetting") &&
                            onlyAccented("settingsLongForgetDays", {60, 90, 180, 365}, 180) &&
                            onlyAccented("settingsShortForgetDays", {3, 7, 14, 30}, 14) &&
                            onlyAccented("settingsLongForgetChance", {1, 3, 5, 10}, 10) &&
                            onlyAccented("settingsShortForgetChance", {1, 3, 5, 10}, 5) &&
                            allDisabled("settingsShortForgetChance"),
                        "RESTART_FORGETTING_CONTROLS_NOT_FROM_READ");
            }, true)) {
            next(8);
            return;
        }
        if (step == 8 && whenReady("settingsTab-misremember", settingsOpen(), [this] { click("settingsTab-misremember"); })) {
            next(9);
            return;
        }
        if (step == 9 && whenReady("settingsMisremembering", settingsOpen(), [this] {
                require(checked("settingsMisremembering") && checked("settingsLongTermMisremembering") &&
                            !checked("settingsShortTermMisremembering") &&
                            onlyAccented("settingsLongMisrememberChance", {1, 3, 5, 10}, 3) &&
                            onlyAccented("settingsShortMisrememberChance", {1, 3, 5, 10}, 5) &&
                            allDisabled("settingsShortMisrememberChance"),
                        "RESTART_MISREMEMBER_CONTROLS_NOT_FROM_READ");
            }, true)) {
            next(10);
            return;
        }
        if (step == 10 && whenReady("settingsTab-traits", settingsOpen(), [this] { click("settingsTab-traits"); })) {
            next(11);
            return;
        }
        if (step == 11 && whenReady("settingsFlawsEnabled", settingsOpen(), [this] {
                require(!checked("settingsFlawsEnabled") && fieldText("settingsFlawsText") == flawsText &&
                            !find(w->contentItem(), "settingsFlawsDirtyHint"),
                        "RESTART_TRAIT_CONTROLS_NOT_FROM_READ");
                w->grabWindow().save(capturePrefix + ".settings-restart.png");
            })) {
            next(20);
            return;
        }
        if (step == 20 && whenReady("settingsTab-emotion", settingsOpen(), [this] { click("settingsTab-emotion"); })) {
            next(21);
            return;
        }
        if (step == 21 && whenReady("settingsEmotionEnabled", settingsOpen(), [this] {
                require(!checked("settingsEmotionEnabled") &&
                            onlyAccented("settingsEmotionCarryoverDays", {1, 3, 5, 7}, 5) &&
                            onlyAccented("settingsEmotionInertia", {5, 10, 15, 30}, 30) &&
                            allDisabled("settingsEmotionCarryoverDays", {1, 3, 5, 7}) &&
                            allDisabled("settingsEmotionInertia", {5, 10, 15, 30}) && emotionRuns(false, 5, 0.30),
                        "RESTART_EMOTION_CONTROLS_NOT_FROM_READ");
            }, true)) {
            next(22);
            return;
        }
        if (step == 22 && whenReady("settingsTab-budget", settingsOpen(), [this] {
                budgetReadBaseline = s->budgetState().value("readDispatchCount").toInt();
                click("settingsTab-budget");
            })) {
            next(23);
            return;
        }
        if (step == 23) {
            if (!budgetReadReady("restart-usage"))
                return;
            require(!checked("settingsBudgetEnforced") && budgetRuns(false, 120, 100000) &&
                        onlyAccented("settingsBudgetRequests", {30, 60, 120, 240}, 120) &&
                        onlyAccented("settingsBudgetTokens", {10000, 30000, 100000, 300000}, 100000) &&
                        allDisabled("settingsBudgetRequests", {30, 60, 120, 240}) &&
                        allDisabled("settingsBudgetTokens", {10000, 30000, 100000, 300000}),
                    "RESTART_BUDGET_CONTROLS_NOT_FROM_READ");
            next(24);
            return;
        }
        if (step == 24) {
            observeBudget("restart-usage-visible");
            require(clock.elapsed() - at < 4000, "RESTART_BUDGET_USAGE_VISIBILITY_DEADLINE");
            if (!budgetUsageVisible())
                return;
            requireBudgetUsage(1);
            w->grabWindow().save(capturePrefix + ".settings-budget-restart.png");
            next(12);
            return;
        }
        if (step == 12 && whenReady("settingsTab-service", settingsOpen(), [this] { click("settingsTab-service"); }, true)) {
            next(13);
            return;
        }
        if (step == 13 && whenReady("settings-close", settingsOpen(), [this] { click("settings-close"); })) {
            next(14);
            return;
        }
        if (step == 14 && surfacesClosed()) {
            const auto feedback = s->settingsFeedback();
            require(!feedback.contains("chat") && !feedback.contains("memory") && !feedback.contains("personality") &&
                        !awaiting("settings:update"),
                    "RESTART_CHECK_WROTE_SETTINGS");
            record("restart-controls-show-saved-settings");
            finish(true);
        }
    }
};
} // namespace

namespace SettingsSectionsCheck {
void run(QQuickWindow *w, RuntimeBridge *s, bool verifyOnly, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion) {
    new Check(w, s, verifyOnly, capturePrefix, std::move(completion));
}
} // namespace SettingsSectionsCheck
