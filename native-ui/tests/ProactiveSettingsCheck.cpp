#include "ProactiveSettingsCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"

#include <QDateTime>
#include <QElapsedTimer>
#include <QHash>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <utility>

namespace {
constexpr int DeadlineMs = 20000;
constexpr int EnabledLimitMs = 60000;
const QString Save = "settings:update";
const QString Read = "settings:get";
const QString Grant = "ai_usage:grant";
const QString Permission = "ai_usage:get";
const QString Feature = "proactive_chat";
const QString Toggle = "settingsProactiveEnabled";
const QString OffText = "未开启";
const QString NeedsGrantText = "已开启，还需要授权费用";
const QString AuthorizedText = "已开启并已授权";
const QStringList FirstCommands{Save, Read, Permission, Grant, Save, Read,
                                Save, Read, Save, Read, Permission};
const QStringList RestartCommands{Read, Permission};
const QVariantMap TurnOn{{"section", "features"}, {"proactive_chat_enabled", true}};
const QVariantMap GrantFields{{"feature", Feature}, {"api_cost_acknowledged", true}, {"user_confirmed", true}};
const QVariantMap ChangeDaily{{"section", "features"}, {"proactive_daily_limit", 3}};
const QVariantMap ChangeInterval{{"section", "features"}, {"proactive_min_interval_minutes", 240}};
const QVariantMap TurnOff{{"section", "features"}, {"proactive_chat_enabled", false}};

bool boolean(const QVariant &value, bool expected) {
    return value.metaType().id() == QMetaType::Bool && value.toBool() == expected;
}

QVariantMap settings(const QVariantMap &payload) {
    const auto features = payload.value("features").toMap();
    return {{"enabled", features.value("proactive_chat_enabled")},
            {"dailyLimit", features.value("proactive_daily_limit")},
            {"intervalMinutes", features.value("proactive_min_interval_minutes")}};
}

QVariantMap permission(const QVariantMap &payload) {
    const auto feature = payload.value("features").toMap().value(Feature).toMap();
    return {{"granted", feature.value("enabled")}, {"effective", feature.value("effective")},
            {"costAcknowledged", feature.value("api_cost_acknowledged")}};
}

QVariantMap expectedSettings(bool enabled, int daily, int interval) {
    return {{"enabled", enabled}, {"dailyLimit", daily}, {"intervalMinutes", interval}};
}

QVariantMap expectedPermission(bool granted, bool effective) {
    return {{"granted", granted}, {"effective", effective}, {"costAcknowledged", granted}};
}

bool matches(const QVariantMap &actual, const QVariantMap &expected) {
    if (actual.keys() != expected.keys()) return false;
    for (auto it = expected.cbegin(); it != expected.cend(); ++it) {
        const auto value = actual.value(it.key());
        if (it.value().metaType().id() == QMetaType::Bool && !boolean(value, it.value().toBool()))
            return false;
        if (value != it.value()) return false;
    }
    return true;
}

class Check final : public QObject {
    enum Phase { Open, Chat, Initial, RestartRead, RestartVerify, Enable, NeedsGrant, Authorize,
                 Confirm, Authorized, Daily, DailySaved, Interval, IntervalSaved, Disable, Off };

    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    const QString scope;
    const int generation;
    std::function<void(QVariantMap)> completion;
    QTimer timer;
    QElapsedTimer clock;
    Phase phase = Open;
    qint64 startedEpochMs = 0, enabledAt = -1, disabledAt = -1;
    quint64 frame = 0;
    bool polling = false, finished = false, failedRequest = false, overflow = false;
    QVariantList inputs, commands, receipts;
    QVariantMap views, observation;
    QHash<QString, QVariantMap> dispatchedFields;
    SummaryInteractionProbe::StableGate inputReady;

    QQuickItem *item(const QString &name, QQuickItem *root = nullptr) const {
        return NativeCheck::findVisual(root ? root : window->contentItem(), name, true).item;
    }

    void require(bool valid, const QString &reason) const {
        NativeCheck::require(valid, "PROACTIVE_SETTINGS_" + reason,
                             {{"phase", int(phase)}, {"elapsedMs", clock.elapsed()},
                              {"commands", commands.size()}, {"receipts", receipts.size()}});
    }

    void next(Phase nextPhase) {
        phase = nextPhase;
        inputReady.reset();
    }

    bool reveal(QQuickItem *target) {
        const auto result = NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, DeadlineMs);
        const auto visibility = NativeControlReadiness::wholeVisibility(target, window);
        observation["visibility"] = visibility;
        return !result.value("expired").toBool() && visibility.value("fullyVisible").toBool();
    }

    bool click(const QString &name, QQuickItem *target, const char *signal = SIGNAL(clicked()),
               qint64 *dispatchAt = nullptr) {
        observation["control"] = name;
        const bool shown = reveal(target);
        auto sample = SummaryInteractionProbe::inspect(target, window, true, scope);
        observation["geometry"] = sample.state;
        sample.eligible = sample.eligible && shown;
        const auto layout = inputReady.observe(sample, clock.elapsed(), frame);
        observation["layoutReady"] = layout.value("ready");
        if (!layout.value("ready").toBool()) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        observation["hitAccepted"] = hit.accepted();
        require(hit.accepted(), "INPUT_HIT");
        QSignalSpy spy(target, signal);
        require(spy.isValid(), "INPUT_SIGNAL");
        const auto at = clock.elapsed();
        require(at < DeadlineMs, "DEADLINE");
        if (dispatchAt) *dispatchAt = at;
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        inputs.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
                                  {"signals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }

    void checkTraffic() const {
        require(!failedRequest, "REQUEST_FAILED");
        const auto &expected = restart ? RestartCommands : FirstCommands;
        require(!overflow && commands.size() <= expected.size() && receipts.size() <= commands.size(), "TRAFFIC");
        for (qsizetype index = 0; index < commands.size(); ++index) {
            const auto row = commands.at(index).toMap();
            require(row.value("command") == expected.at(index) && row.value("scope") == scope &&
                    row.value("generation") == generation, "COMMAND_ORDER");
        }
    }

    bool receipt(int index, const QVariantMap &fields, const QVariantMap &expected) const {
        if (commands.size() <= index) return false;
        const auto command = commands.at(index).toMap();
        const auto id = command.value("id").toString();
        require(!id.isEmpty() && matches(dispatchedFields.value(id), fields), "COMMAND_FIELDS");
        for (const auto &value : receipts) {
            const auto response = value.toMap();
            if (response.value("id") != id) continue;
            require(response.value("command") == command.value("command") && response.value("scope") == scope &&
                    response.value("generation") == generation && boolean(response.value("ok"), true) &&
                    matches(response.value("state").toMap(), expected), "RECEIPT");
            return true;
        }
        return false;
    }

    bool saveRead(int index, const QVariantMap &fields, const QVariantMap &expected) const {
        return receipt(index, fields, expected) && receipt(index + 1, {}, expected);
    }

    int selectedPreset(QQuickItem *root, const QString &prefix, const QList<int> &options) const {
        int selected = 0;
        for (const auto option : options) {
            const auto *control = item(prefix + QString::number(option), root);
            if (!control) return 0;
            const auto accented = control->property("accented");
            if (!boolean(accented, false)) {
                if (!boolean(accented, true) || selected) return 0;
                selected = option;
            }
        }
        return selected;
    }

    bool observe(const QString &key, QQuickItem *root, const QString &text, bool enabled,
                 bool granted, bool effective, int daily, int interval) {
        const auto state = session->state();
        const auto featureState = settings(state.value("settings").toMap());
        const auto grantState = permission(state.value("permissions").toMap());
        const auto feedback = session->settingsFeedback();
        const auto saveStatus = feedback.value("features").toMap().value("status").toString();
        require(saveStatus != "error" && saveStatus != "unknown", "SETTINGS_FEEDBACK");
        if (!session->permissionsKnown() || feedback.contains("read") || saveStatus == "pending") return false;
        const auto *toggle = item(Toggle, root);
        auto *status = item("settingsProactiveStatus", root);
        if (!toggle || !status || !reveal(status)) return false;
        const auto statusText = status->property("text").toString();
        const auto dailySelection = selectedPreset(root, "settingsProactiveDailyLimit-", {1, 2, 3, 5});
        const auto intervalSelection = selectedPreset(root, "settingsProactiveMinInterval-", {60, 120, 240, 480});
        const auto *authorize = item("settingsProactiveAuthorize", root);
        require(matches(featureState, expectedSettings(enabled, daily, interval)) &&
                matches(grantState, expectedPermission(granted, effective)), "STATE");
        require(boolean(toggle->property("checked"), enabled) && statusText == text &&
                dailySelection == daily && intervalSelection == interval &&
                (authorize != nullptr) == (enabled && !effective), "DISPLAY");
        views[key] = QVariantMap{{"atMs", clock.elapsed()}, {"text", statusText},
                                {"checked", toggle->property("checked")}, {"settings", featureState},
                                {"permission", grantState}, {"dailySelected", dailySelection},
                                {"intervalSelected", intervalSelection}, {"authorizeVisible", authorize != nullptr}};
        return true;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        const auto elapsed = clock.elapsed();
        const auto endedEpochMs = QDateTime::currentMSecsSinceEpoch();
        const auto enabledMs = enabledAt < 0 ? 0 : (disabledAt < 0 ? elapsed : disabledAt) - enabledAt;
        const auto expectedCount = restart ? RestartCommands.size() : FirstCommands.size();
        if (error.isEmpty() && (commands.size() != expectedCount || receipts.size() != expectedCount))
            error = "PROACTIVE_SETTINGS_TRAFFIC";
        if (error.isEmpty() && elapsed >= DeadlineMs) error = "PROACTIVE_SETTINGS_DEADLINE";
        if (error.isEmpty() && enabledMs > EnabledLimitMs) error = "PROACTIVE_SETTINGS_ENABLED_LIMIT";
        for (auto &value : commands) {
            auto command = value.toMap();
            command["fields"] = dispatchedFields.value(command.value("id").toString());
            value = command;
        }
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1},
              {"deadlineMs", DeadlineMs}, {"elapsedMs", elapsed},
              {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", endedEpochMs},
              {"scopeBefore", scope}, {"scopeAfter", session->scopeKey()},
              {"generationBefore", generation}, {"generationAfter", session->generation()},
              {"enabledAtMs", enabledAt}, {"disabledAtMs", disabledAt}, {"enabledDurationMs", enabledMs},
              {"inputs", inputs}, {"commands", commands}, {"receipts", receipts}, {"views", views},
              {"lastObservation", observation}});
        deleteLater();
    }

    void tick() {
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        observation = {{"phase", int(phase)}};
        require(enabledAt < 0 || disabledAt >= 0 || clock.elapsed() - enabledAt <= EnabledLimitMs, "ENABLED_LIMIT");
        require(session->connected() && session->runtimeWritable() && !session->busy() &&
                session->scopeKey() == scope && session->generation() == generation, "SCOPE");
        checkTraffic();
        if (phase == Open) {
            if (click("nav-settings", item("nav-settings"))) next(Chat);
            return;
        }
        auto *root = item("drawer-settings");
        if (!root || !root->property("inputReady").toBool()) {
            observation["drawerFound"] = root != nullptr;
            observation["drawerReady"] = false;
            return;
        }
        switch (phase) {
        case Open:
            return;
        case Chat:
            if (click("settingsTab-chat", item("settingsTab-chat", root))) next(restart ? RestartRead : Initial);
            return;
        case Initial:
            if (observe("initial", root, OffText, false, false, false, 2, 120)) next(Enable);
            return;
        case RestartRead:
            require(!session->request(Read).isEmpty(), "RESTART_READ");
            session->refreshPermissions();
            next(RestartVerify);
            return;
        case RestartVerify:
            if (receipt(0, {}, expectedSettings(false, 3, 240)) &&
                receipt(1, {}, expectedPermission(true, false)) &&
                observe("restart", root, OffText, false, true, false, 3, 240)) finish({});
            return;
        case Enable:
            if (click(Toggle, item(Toggle, root), SIGNAL(toggled()), &enabledAt)) next(NeedsGrant);
            return;
        case NeedsGrant:
            if (saveRead(0, TurnOn, expectedSettings(true, 2, 120)) &&
                receipt(2, {}, expectedPermission(false, false)) &&
                observe("needsGrant", root, NeedsGrantText, true, false, false, 2, 120)) next(Authorize);
            return;
        case Authorize:
            if (click("settingsProactiveAuthorize", item("settingsProactiveAuthorize", root))) next(Confirm);
            return;
        case Confirm:
            if (click("settingsCostConsentConfirm", item("settingsCostConsentConfirm"))) next(Authorized);
            return;
        case Authorized: {
            auto *panel = item("terminalTasks", root);
            if (panel && !panel->property("modalOpen").toBool() &&
                receipt(3, GrantFields, expectedPermission(true, true)) &&
                observe("authorized", root, AuthorizedText, true, true, true, 2, 120)) next(Daily);
            return;
        }
        case Daily:
            if (click("settingsProactiveDailyLimit-3", item("settingsProactiveDailyLimit-3", root))) next(DailySaved);
            return;
        case DailySaved:
            if (saveRead(4, ChangeDaily, expectedSettings(true, 3, 120)) &&
                observe("daily", root, AuthorizedText, true, true, true, 3, 120)) next(Interval);
            return;
        case Interval:
            if (click("settingsProactiveMinInterval-240", item("settingsProactiveMinInterval-240", root))) next(IntervalSaved);
            return;
        case IntervalSaved:
            if (saveRead(6, ChangeInterval, expectedSettings(true, 3, 240)) &&
                observe("interval", root, AuthorizedText, true, true, true, 3, 240)) next(Disable);
            return;
        case Disable:
            if (click(Toggle, item(Toggle, root), SIGNAL(toggled()))) next(Off);
            return;
        case Off:
            if (saveRead(8, TurnOff, expectedSettings(false, 3, 240)) &&
                receipt(10, {}, expectedPermission(true, false)) &&
                observe("off", root, OffText, false, true, false, 3, 240)) {
                disabledAt = views.value("off").toMap().value("atMs").toLongLong();
                finish({});
            }
            return;
        }
    }

  public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool second, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), restart(second), scope(s->scopeKey()), generation(s->generation()),
          completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this,
            [this](const QString &id, const QString &command, const QString &requestScope, int gen) {
                if (finished) return;
                if (commands.size() >= FirstCommands.size()) {
                    overflow = true;
                    return;
                }
                commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", requestScope},
                                            {"generation", gen}, {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::proactiveSettingsDispatched, this,
            [this](const QString &id, const QVariantMap &fields) {
                if (!finished && dispatchedFields.size() < FirstCommands.size()) dispatchedFields.insert(id, fields);
            });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (finished || (command != Save && command != Read && command != Grant && command != Permission)) return;
                if (receipts.size() >= FirstCommands.size()) {
                    overflow = true;
                    return;
                }
                const bool isSettings = command == Save || command == Read;
                const bool ok = !payload.contains("error") && (isSettings ? boolean(payload.value("ok"), true)
                    : payload.value("schema") == "reverie.ai-usage-consent.v2" &&
                      (!payload.contains("ok") || boolean(payload.value("ok"), true)));
                receipts.append(QVariantMap{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                    {"generation", gen}, {"atMs", clock.elapsed()}, {"ok", ok},
                    {"state", isSettings ? settings(payload) : permission(payload)}});
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &, const QString &, int gen) {
            if (!finished && gen == generation) failedRequest = true;
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
            polling = true;
            try {
                tick();
            } catch (const std::exception &error) {
                finish(QString::fromUtf8(error.what()));
            }
            polling = false;
        });
        timer.start(40);
    }
};
}

void ProactiveSettingsCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                                 std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
