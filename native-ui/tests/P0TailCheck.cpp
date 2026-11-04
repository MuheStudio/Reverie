#include "P0TailCheck.h"
#include "ControlReadiness.h"
#include "../src/RuntimeBridge.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QTest>
#include <QTimer>
#include <QUrl>
#include <algorithm>
#include <memory>
#include <stdexcept>

namespace {
constexpr auto kModel = "reverie-qt-p0-tail";
constexpr auto kFeature = "emotion_analysis";
constexpr auto kPause = "暂停网络模型调用";
QVariantMap at(const QVariantMap &map, const QString &key) { return map.value(key).toMap(); }
void collect(QQuickItem *item, const std::function<bool(QQuickItem *)> &match, QList<QQuickItem *> &items) {
    if (!item || !item->isVisible()) return;
    if (match(item)) items.append(item);
    for (auto *child : item->childItems()) collect(child, match, items);
}
struct Step { QString name; int timeoutMs; std::function<bool()> poll; };
struct Case { QString id; QStringList dependencies; QList<Step> steps; int timeoutMs = 0; };
struct Chat { QString marker, text, requestId; int assistants = 0, messages = 0; };

class Check final : public QObject {
  public:
    QQuickWindow *w;
    RuntimeBridge *s;
    int cycle;
    QString endpointA, endpointB, capturePrefix, scope;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock, stepClock, caseClock;
    NativeControlReadiness::OnceGate action;
    QList<Case> cases;
    QVariantMap results, observations, captures;
    QVariantList stepLog;
    int caseIndex = 0, stepIndex = 0;
    bool executing = false, caseStarted = false, safetyStopped = false;
    struct Response { QString id, command; int generation; QVariantMap payload; };
    QList<Response> responses;
    int responseMark = 0, permissionEpochBefore = -1;

    Check(QQuickWindow *window, RuntimeBridge *session, int c, QString a, QString b, QString prefix,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), cycle(c), endpointA(std::move(a)), endpointB(std::move(b)),
          capturePrefix(std::move(prefix)), done(std::move(callback)) {
        connect(s, &RuntimeBridge::responseReceived, this,
                [this](const QString &id, const QString &command, const QVariantMap &payload, int generation) {
                    responses.append({id, command, generation, payload});
                });
        cases = cycle == 1 ? firstCycle() : secondCycle();
        clock.start();
        timer.setInterval(100);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing) return;
            executing = true;
            tick();
            executing = false;
        });
        timer.start();
    }
    static void require(bool value, const QString &error) {
        if (!value) throw std::runtime_error(error.toStdString());
    }
    QQuickItem *named(const QString &name) const {
        QList<QQuickItem *> found;
        collect(w->contentItem(), [&name](QQuickItem *i) { return i->objectName() == name; }, found);
        return found.isEmpty() ? nullptr : found.first();
    }
    QQuickItem *button(const QString &text, QQuickItem *root = nullptr) const {
        QList<QQuickItem *> found;
        collect(root ? root : w->contentItem(), [&text](QQuickItem *i) {
            return i->inherits("QQuickAbstractButton") && i->property("text").toString() == text;
        }, found);
        return found.isEmpty() ? nullptr : found.first();
    }
    QQuickItem *permissionRow() const {
        QList<QQuickItem *> found;
        collect(w->contentItem(), [](QQuickItem *i) {
            return i->property("modelData").toString() == kFeature && i->property("permission").isValid();
        }, found);
        return found.isEmpty() ? nullptr : found.first();
    }
    void reveal(QQuickItem *item) const {
        if (!item) return;
        for (auto *p = item->parentItem(); p; p = p->parentItem()) {
            if (!p->inherits("QQuickFlickable")) continue;
            auto *content = p->property("contentItem").value<QQuickItem *>();
            if (!content) return;
            const auto y = item->mapToItem(content, QPointF()).y();
            const auto maxY = std::max<qreal>(0, p->property("contentHeight").toReal() - p->height());
            const auto top = p->property("contentY").toReal();
            if (y < top || y + item->height() > top + p->height())
                p->setProperty("contentY", std::clamp<qreal>(y - p->height() * .3, 0, maxY));
            return;
        }
    }
    QVariantMap readiness(QQuickItem *item, bool closed = true) const {
        reveal(item);
        return NativeControlReadiness::snapshot(item, w, closed);
    }
    bool shown(QQuickItem *item) const { return NativeControlReadiness::snapshot(item, w)["visible"].toBool(); }
    void click(QQuickItem *item) const {
        require(readiness(item)["ready"].toBool(), "CONTROL_NOT_READY");
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier,
                          item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint());
    }
    void type(QQuickItem *item, const QString &text) const {
        require(readiness(item)["ready"].toBool(), "EDITOR_NOT_READY");
        item->forceActiveFocus();
        QMetaObject::invokeMethod(item, "selectAll");
        QInputMethodEvent event;
        event.setCommitString(text);
        QCoreApplication::sendEvent(w, &event);
        require(item->property("text").toString() == text, "INPUT_NOT_COMMITTED");
    }
    bool once(const std::function<QVariantMap()> &inspect, const std::function<void()> &perform) {
        const auto result = action.poll(stepClock.elapsed(), cases[caseIndex].steps[stepIndex].timeoutMs, inspect, perform);
        require(result != NativeControlReadiness::OnceGate::Expired, "READINESS_DEADLINE");
        return result == NativeControlReadiness::OnceGate::Performed;
    }
    bool closed() const {
        for (const auto &name : {"drawer-settings", "drawer-memory", "taskSurface"}) {
            auto *item = named(name);
            if (item && item->property("progress").toDouble() > 0) return false;
        }
        return true;
    }
    bool settingsReady() const {
        auto *item = named("drawer-settings");
        return item && item->property("inputReady").toBool();
    }
    QVariantMap provider() const { return at(s->state(), "provider"); }
    QVariantMap feedback(const QString &key) const { return s->property(key.toUtf8().constData()).toMap(); }
    QVariantMap permission() const { return at(at(at(s->state(), "permissions"), "features"), kFeature); }
    QVariantMap permissionSafe() const {
        const auto data = permission();
        QVariantMap safe;
        for (const auto &key : {"enabled", "effective", "provider", "origin", "current_provider", "current_origin", "api_cost_acknowledged"})
            if (data.contains(key)) safe[key] = data[key];
        safe["known"] = s->permissionsKnown();
        safe["contextEpoch"] = s->permissionContextEpoch();
        return safe;
    }
    QVariantMap metadata() const {
        const auto diagnostics = s->diagnostics();
        QVariantMap data{{"busy", s->busy()}, {"connected", s->connected()}, {"generation", s->generation()},
                         {"chatRequestId", diagnostics["chatRequestId"]}, {"chatState", diagnostics["chatState"]},
                         {"pendingCommands", diagnostics["pendingCommands"]}, {"messageCount", s->messages().size()},
                         {"draftCharacters", s->draft().size()}, {"permissionsKnown", s->permissionsKnown()},
                         {"permissionContextEpoch", s->permissionContextEpoch()}};
        for (const auto &name : {"chatFeedback", "providerFeedback", "networkFeedback"}) {
            const auto value = feedback(name);
            QVariantMap fields;
            for (const auto &key : {"status", "requestId", "pending", "currentDraft", "known", "active", "desiredActive", "epoch"})
                if (value.contains(key)) fields[key] = value[key];
            if (QString(name) == "chatFeedback") {
                const auto cancel = at(value, "cancel");
                QVariantMap safe;
                for (const auto &key : {"status", "requestId", "subjectRequestId"})
                    if (cancel.contains(key)) safe[key] = cancel[key];
                fields["cancel"] = safe;
            }
            data[name] = fields;
        }
        return data;
    }
    bool feedbackShown(const QString &feedbackName, const QString &control, bool cancel = false) const {
        auto value = feedback(feedbackName);
        if (cancel) value = at(value, "cancel");
        auto *label = named(control);
        reveal(label);
        return !value["text"].toString().isEmpty() && shown(label) &&
               label->property("text").toString().contains(value["text"].toString());
    }
    bool chatFeedbackShown(bool cancel = false) const {
        return feedbackShown("chatFeedback", "chatFeedbackText", cancel) ||
               feedbackShown("chatFeedback", "companionChatFeedback", cancel);
    }
    bool permissionStatusShown(bool granted) const {
        auto *label = named("permissionStatus-emotion_analysis");
        reveal(label);
        return shown(label) && label->property("text").toString().startsWith(granted ? "已授权" : "未授权");
    }
    bool permissionFeedbackShown() const {
        const auto value = at(feedback("permissionFeedback"), kFeature);
        auto *label = named("permissionFeedback-emotion_analysis");
        reveal(label);
        return !value["text"].toString().isEmpty() && shown(label) && label->property("text") == value["text"];
    }
    const Response *response(const QString &command) const {
        for (int i = responseMark; i < responses.size(); ++i)
            if (responses[i].command == command && responses[i].generation == s->generation()) return &responses[i];
        return nullptr;
    }
    int assistants() const {
        int count = 0;
        for (const auto &m : s->messages()) if (m.toMap()["role"] != "user") ++count;
        return count;
    }
    void observe(const QString &name, const QVariant &value) { observations[name] = value; }
    void capture(const QString &name) {
        if (captures.contains(name)) return;
        const auto path = capturePrefix + "." + name + ".png";
        require(w->grabWindow().save(path), "P0_TAIL_CAPTURE_FAILED");
        captures[name] = path;
    }
    Step openSettings() {
        return {"open-settings", 8000, [this] {
            if (settingsReady()) return true;
            once([this] { return readiness(named("nav-settings")); }, [this] { click(named("nav-settings")); });
            return false;
        }};
    }
    Step closeSettings() {
        return {"close-settings", 8000, [this] {
            if (closed()) return true;
            once([this] { return readiness(named("settings-close")); }, [this] { click(named("settings-close")); });
            return false;
        }};
    }
    Step togglePause(bool pause) {
        return {pause ? "pause" : "resume", 10000, [this, pause] {
            const auto value = feedback("networkFeedback");
            if (s->state()["offline"].toBool() == pause && value["known"].toBool() &&
                value["active"].toBool() == pause && value["status"] == (pause ? "paused" : "allowed")) {
                require(feedbackShown("networkFeedback", "networkFeedbackText"), "NETWORK_FEEDBACK_NOT_VISIBLE");
                return true;
            }
            once([this] { return readiness(button(kPause)); }, [this, pause] {
                auto *toggle = button(kPause);
                require(toggle->property("checked").toBool() != pause, "NETWORK_GATE_NOT_CONFIRMED");
                click(toggle);
            });
            return false;
        }};
    }
    QList<Step> grant(const QString &label) {
        return {{"grant-" + label, 6000, [this] {
                    return once([this] { return readiness(button("授权当前服务", permissionRow())); }, [this] {
                        require(s->permissionsKnown() && !permission()["enabled"].toBool(), "GRANT_REQUIRES_CONFIRMED_DENIED_SNAPSHOT");
                        responseMark = responses.size();
                        click(button("授权当前服务", permissionRow()));
                    });
                }},
                {"confirm-" + label, 6000, [this] {
                    QQuickItem *ok = nullptr;
                    for (const auto &text : {"OK", "&OK", "确定"}) if (auto *item = button(text); shown(item)) { ok = item; break; }
                    return once([this, ok] { return readiness(ok); }, [this, ok] { click(ok); });
                }},
                {"grant-receipt-" + label, 10000, [this, label] {
                    const auto *receipt = response("ai_usage:grant");
                    if (!receipt || !s->permissionsKnown()) return false;
                    require(at(at(receipt->payload, "features"), kFeature)["enabled"].toBool() &&
                            permission()["enabled"].toBool(), "GRANT_NOT_CONFIRMED");
                    require(at(feedback("permissionFeedback"), kFeature)["status"] == "success" &&
                            permissionStatusShown(true) && permissionFeedbackShown(), "GRANT_FEEDBACK_NOT_VISIBLE");
                    observe("permission.grant-" + label, permissionSafe());
                    observe("permission.grant-request-" + label, receipt->id);
                    return true;
                }}};
    }
    QList<Step> saveEndpoint(const QString &destination, const QString &label) {
        return {{"edit-and-test-" + label, 4000, [this, destination] {
                    return once([this] {
                        auto value = readiness(named("providerEndpoint"));
                        value["ready"] = value["ready"].toBool() && readiness(named("providerModel"))["ready"].toBool() &&
                                         readiness(named("testProvider"))["ready"].toBool();
                        return value;
                    }, [this, destination] {
                        permissionEpochBefore = s->permissionContextEpoch();
                        type(named("providerEndpoint"), destination);
                        type(named("providerModel"), kModel);
                        click(named("testProvider"));
                    });
                }},
                {"test-and-save-" + label, 20000, [this] {
                    if (!s->state()["providerTestReady"].toBool()) return false;
                    return once([this] { return readiness(named("saveProvider")); }, [this] {
                        require(feedback("providerFeedback")["status"] == "ready" &&
                                feedbackShown("providerFeedback", "providerFeedbackText"), "PROVIDER_TEST_FEEDBACK_NOT_VISIBLE");
                        responseMark = responses.size();
                        click(named("saveProvider"));
                    });
                }},
                {"saved-and-auto-refreshed-" + label, 15000, [this, destination, label] {
                    if (provider()["base_url"] != destination || provider()["model"] != kModel ||
                        feedback("providerFeedback")["status"] != "saved" || !s->permissionsKnown()) return false;
                    const auto *refresh = response("ai_usage:get");
                    if (!refresh || s->permissionContextEpoch() <= permissionEpochBefore) return false;
                    require(!permission()["enabled"].toBool() && !at(at(refresh->payload, "features"), kFeature)["enabled"].toBool(),
                            "OLD_DESTINATION_PERMISSION_REVIVED");
                    require(feedbackShown("providerFeedback", "providerFeedbackText") && permissionStatusShown(false),
                            "DESTINATION_CHANGE_FEEDBACK_NOT_VISIBLE");
                    observe("provider.saved-" + label, QVariantMap{{"model", provider()["model"]}, {"base_url", provider()["base_url"]}});
                    observe("permission.after-" + label, permissionSafe());
                    observe("permission.auto-refresh-" + label, QVariantMap{{"requestId", refresh->id}, {"generation", refresh->generation},
                                                                           {"contextEpochBefore", permissionEpochBefore}, {"contextEpochAfter", s->permissionContextEpoch()}});
                    if (cycle == 1 && label == "b") capture("endpoint-b-revoked");
                    return true;
                }}};
    }
    std::shared_ptr<Chat> chat(const QString &marker) const {
        return std::make_shared<Chat>(Chat{marker, marker + "：本机隔离检查"});
    }
    QList<Step> send(const std::shared_ptr<Chat> &run) {
        return {{"compose", 4000, [this, run] {
                    return once([this] { return readiness(named("chatComposer"), closed()); }, [this, run] {
                        require(!s->busy(), "PREVIOUS_CHAT_STILL_ACTIVE");
                        run->assistants = assistants(); run->messages = s->messages().size();
                        type(named("chatComposer"), run->text);
                    });
                }},
                {"send-once", 3000, [this, run] {
                    return once([this] { return readiness(named("sendChat"), closed()); }, [this, run] {
                        click(named("sendChat"));
                        run->requestId = s->diagnostics()["chatRequestId"].toString();
                        observe("chat." + run->marker, QVariantMap{{"requestId", run->requestId}, {"assistantBefore", run->assistants},
                                                                  {"messagesBefore", run->messages}, {"sentMetadata", metadata()}});
                    });
                }}};
    }
    Step completed(const std::shared_ptr<Chat> &run, int timeoutMs = 20000) {
        return {"original-chat-done", timeoutMs, [this, run] {
            if (s->busy() || stepClock.elapsed() < 600) return false;
            require(!run->requestId.isEmpty() && feedback("chatFeedback")["status"] == "done" &&
                    assistants() == run->assistants + 1, "ORIGINAL_CHAT_DID_NOT_COMPLETE");
            require(chatFeedbackShown(), "CHAT_DONE_FEEDBACK_NOT_VISIBLE");
            require(at(feedback("chatFeedback"), "cancel").isEmpty(), "TERMINAL_LEFT_CANCEL_ERROR");
            observe("chat.done." + run->marker, QVariantMap{{"requestId", run->requestId}, {"metadata", metadata()}});
            return true;
        }};
    }
    Step generating(const std::shared_ptr<Chat> &run, bool queued = false) {
        return {queued ? "original-chat-queued" : "original-chat-generating", 6000, [this, run, queued] {
            if (!s->busy() || feedback("chatFeedback")["status"] != (queued ? "queued" : "generating") ||
                stepClock.elapsed() < (queued ? 300 : 1200)) return false;
            require(s->diagnostics()["chatRequestId"] == run->requestId, "CHAT_CORRELATION_CHANGED");
            observe("chat.in-flight." + run->marker, QVariantMap{{"requestId", run->requestId}, {"metadata", metadata()}});
            return true;
        }};
    }
    Step stop(const std::shared_ptr<Chat> &run) {
        return {"stop-once", 3000, [this, run] {
            return once([this] { return readiness(named("sendChat"), closed()); }, [this, run] {
                require(s->busy() && s->diagnostics()["chatRequestId"] == run->requestId, "STOP_SUBJECT_CHANGED");
                require(named("sendChat")->property("text").toString().contains("停止"), "STOP_CONTROL_NOT_VISIBLE");
                click(named("sendChat"));
                const auto cancel = at(feedback("chatFeedback"), "cancel");
                observe("chat.stop." + run->marker, QVariantMap{{"requestId", cancel["requestId"]},
                                                                {"subjectRequestId", run->requestId}, {"metadata", metadata()}});
            });
        }};
    }
    Step cancelled(const std::shared_ptr<Chat> &run, bool pause) {
        return {"authoritative-chat-cancelled", 10000, [this, run, pause] {
            if (s->busy()) return false;
            require(feedback("chatFeedback")["status"] == "cancelled" && assistants() == run->assistants,
                    "CHAT_CANCEL_NOT_AUTHORITATIVE");
            require(feedback("networkFeedback")["status"] == (pause ? "paused" : "allowed") &&
                    s->state()["offline"].toBool() == pause, "STOP_AND_NETWORK_GATE_CONFLATED");
            require(feedback("chatFeedback")["text"] != feedback("networkFeedback")["text"], "STOP_AND_PAUSE_REUSED_TEXT");
            if (pause) require(feedbackShown("networkFeedback", "networkFeedbackText") && chatFeedbackShown(), "PAUSE_AND_CHAT_FEEDBACK_NOT_VISIBLE");
            else require(chatFeedbackShown(), "STOP_FEEDBACK_NOT_VISIBLE");
            observe("chat.cancelled." + run->marker, QVariantMap{{"requestId", run->requestId}, {"metadata", metadata()}});
            if (pause) capture("chat-cancelled-network-paused");
            return true;
        }};
    }
    Step noLateReply(const std::shared_ptr<Chat> &run) {
        return {"late-reply-not-displayed", 12000, [this, run] {
            if (stepClock.elapsed() < 10000) return false;
            require(!s->busy() && assistants() == run->assistants, "CANCELLED_REPLY_RETURNED");
            observe("chat.no-late-reply." + run->marker, true);
            return true;
        }};
    }
    Step failedCancel(const std::shared_ptr<Chat> &run, bool timeout) {
        return {timeout ? "cancel-30s-timeout-original-retained" : "cancel-rejected-original-retained", timeout ? 35000 : 6000,
                [this, run, timeout] {
                    const auto value = at(feedback("chatFeedback"), "cancel");
                    if (value["status"] != (timeout ? "unknown" : "error")) return false;
                    require(s->busy() && s->diagnostics()["chatRequestId"] == run->requestId &&
                            value["subjectRequestId"] == run->requestId && !value["requestId"].toString().isEmpty(), "CANCEL_ERROR_LOST_ORIGINAL_CHAT");
                    require(assistants() == run->assistants && chatFeedbackShown(true), "CANCEL_ERROR_FEEDBACK_NOT_VISIBLE");
                    require(named("sendChat") && named("sendChat")->property("text").toString().contains("停止"), "CANCEL_ERROR_ALLOWED_SECOND_SEND");
                    if (timeout) require(stepClock.elapsed() >= 29000 && caseClock.elapsed() < 40000, "CANCEL_TIMEOUT_WINDOW_CHANGED");
                    observe("cancel." + run->marker, QVariantMap{{"requestId", value["requestId"]}, {"subjectRequestId", run->requestId},
                                                                {"status", value["status"]}, {"caseElapsedMs", caseClock.elapsed()},
                                                                {"stepElapsedMs", stepClock.elapsed()}, {"metadata", metadata()}});
                    capture(timeout ? "cancel-timeout-original-active" : "cancel-rejected-original-active");
                    return true;
                }};
    }
    Step connected() {
        return {"connected", 40000, [this] {
            if (!s->connected() || provider().isEmpty() || !s->permissionsKnown() ||
                !feedback("networkFeedback")["known"].toBool() || stepClock.elapsed() < 1500) return false;
            require(provider()["base_url"] == (cycle == 1 ? endpointA : endpointB) && provider()["model"] == kModel,
                    "STARTUP_DESTINATION_NOT_EXACT");
            scope = s->scopeKey();
            observe("setup.provider", QVariantMap{{"base_url", provider()["base_url"]}, {"model", provider()["model"]}});
            return true;
        }};
    }
    QList<Case> firstCycle() {
        QList<Case> plan;
        plan.append({"setup.connected", {}, {connected()}});
        Case a{"permissions.grant-a", {"setup.connected"}, {openSettings()}};
        a.steps += grant("a"); plan.append(a);
        Case b{"provider.switch-b-revokes-a", {a.id}, {}};
        b.steps += saveEndpoint(endpointB, "b"); plan.append(b);
        Case permissions{"permissions.grant-b-revoke-b", {b.id}, {}};
        permissions.steps += grant("b");
        permissions.steps += QList<Step>{{"revoke-b-once", 6000, [this] {
            return once([this] { return readiness(button("撤销", permissionRow())); }, [this] {
                responseMark = responses.size(); click(button("撤销", permissionRow()));
            });
        }}, {"revoke-b-receipt", 10000, [this] {
            const auto *receipt = response("ai_usage:revoke");
            if (!receipt || !s->permissionsKnown()) return false;
            require(!permission()["enabled"].toBool() && !at(at(receipt->payload, "features"), kFeature)["enabled"].toBool(), "B_PERMISSION_NOT_REVOKED");
            require(permissionStatusShown(false) && permissionFeedbackShown(), "REVOKE_FEEDBACK_NOT_VISIBLE");
            observe("permission.revoked-b", permissionSafe()); observe("permission.revoke-request-b", receipt->id);
            return true;
        }}}; plan.append(permissions);
        const auto serviceB = chat("补充-尾部服务B");
        Case useB{"provider.chat-only-b", {permissions.id}, {closeSettings()}};
        useB.steps += send(serviceB); useB.steps.append(completed(serviceB)); plan.append(useB);
        const auto delayed = chat("补充-尾部受控延迟");
        Case pause{"network.controlled-pause", {useB.id}, {}};
        pause.steps += send(delayed);
        pause.steps += QList<Step>{generating(delayed), openSettings(), togglePause(true), cancelled(delayed, true), noLateReply(delayed), closeSettings(),
            {"chat-cancel-feedback-after-close", 4000, [this] { return chatFeedbackShown(); }}};
        plan.append(pause);
        const auto recovered = chat("补充-尾部受控恢复");
        Case restore{"network.restore-once", {pause.id}, {openSettings(), togglePause(false), closeSettings()}};
        restore.steps += send(recovered); restore.steps.append(completed(recovered)); plan.append(restore);
        plan.append({"restart.prepare-b-paused", {restore.id}, {openSettings(), togglePause(true),
            {"persisted-b-paused-denied", 4000, [this] {
                require(provider()["base_url"] == endpointB && provider()["model"] == kModel && s->permissionsKnown() &&
                        !permission()["enabled"].toBool() && s->state()["offline"].toBool(), "RESTART_PREPARATION_CHANGED");
                observe("restart.preparedProvider", QVariantMap{{"base_url", provider()["base_url"]}, {"model", provider()["model"]}});
                observe("restart.preparedPermission", permissionSafe()); observe("restart.preparedPaused", true);
                return true;
            }}, closeSettings()}});
        return plan;
    }
    QList<Case> secondCycle() {
        QList<Case> plan;
        plan.append({"setup.connected", {}, {connected()}});
        plan.append({"restart.b-paused-permission", {"setup.connected"}, {openSettings(),
            {"restored-b-paused-denied", 4000, [this] {
                auto *toggle = button(kPause);
                require(provider()["base_url"] == endpointB && provider()["model"] == kModel && s->permissionsKnown() &&
                        !permission()["enabled"].toBool() && permissionStatusShown(false) &&
                        s->state()["offline"].toBool() && toggle && toggle->property("checked").toBool(), "B_PAUSE_OR_PERMISSION_NOT_RESTORED");
                observe("restart.provider", QVariantMap{{"base_url", provider()["base_url"]}, {"model", provider()["model"]}});
                observe("restart.permission", permissionSafe()); observe("restart.paused", true);
                return true;
            }}, closeSettings()}});
        const auto draft = chat("补充-尾部重启暂停");
        Case paused{"restart.paused-draft-no-calls", {"restart.b-paused-permission"}, {}};
        paused.steps += send(draft);
        paused.steps.append({"paused-draft-preserved", 4000, [this, draft] {
            if (stepClock.elapsed() < 600) return false;
            require(!s->busy() && s->messages().size() == draft->messages && assistants() == draft->assistants &&
                    s->draft() == draft->text && named("chatComposer") && named("chatComposer")->property("text") == draft->text,
                    "PAUSED_DRAFT_OR_HISTORY_CHANGED");
            require(feedback("chatFeedback")["status"] == "paused" && chatFeedbackShown(), "PAUSED_FEEDBACK_NOT_VISIBLE");
            observe("restart.pausedDraftPreserved", true); observe("restart.pausedDraftMetadata", metadata());
            return true;
        }}); plan.append(paused);
        const auto recovered = chat("补充-尾部受控恢复");
        Case resume{"restart.resume-controlled-b", {paused.id}, {openSettings(), togglePause(false), closeSettings()}};
        resume.steps += send(recovered); resume.steps.append(completed(recovered)); plan.append(resume);
        const auto serviceA = chat("补充-尾部服务A");
        Case back{"provider.return-a-no-resurrection", {resume.id}, {openSettings()}};
        back.steps += saveEndpoint(endpointA, "a-returned"); back.steps.append(closeSettings());
        back.steps += send(serviceA); back.steps.append(completed(serviceA)); plan.append(back);
        const auto rejected = chat("补充-取消拒绝");
        Case reject{"cancel.rejected-original-done", {back.id}, {}};
        reject.steps += send(rejected);
        reject.steps += QList<Step>{generating(rejected), stop(rejected), failedCancel(rejected, false), completed(rejected)};
        plan.append(reject);
        const auto timed = chat("补充-取消超时");
        Case timeout{"cancel.timeout-original-done", {reject.id}, {}, 55000};
        timeout.steps += send(timed);
        timeout.steps += QList<Step>{generating(timed, true), stop(timed), failedCancel(timed, true), completed(timed, 55000)};
        plan.append(timeout);
        const auto stopped = chat("补充-尾部受控停止");
        Case normal{"cancel.normal-stop-after-injections", {timeout.id}, {}};
        normal.steps += send(stopped);
        normal.steps += QList<Step>{generating(stopped), stop(stopped), cancelled(stopped, false), noLateReply(stopped)};
        plan.append(normal);
        return plan;
    }
    void tick() {
        if (!scope.isEmpty() && (!s->connected() || s->scopeKey() != scope ||
            (provider()["base_url"] != endpointA && provider()["base_url"] != endpointB))) {
            safetyStopped = true;
            finishCase("failed", "SAFETY_STOP:session-or-exact-destination-changed");
            for (int i = caseIndex; i < cases.size(); ++i) results[cases[i].id] = QVariantMap{{"status", "not-executed"}, {"reason", "safety-stop"}};
            return finish();
        }
        if (clock.elapsed() >= 205000) {
            finishCase("failed", "P0_TAIL_DEADLINE");
            for (int i = caseIndex; i < cases.size(); ++i) results[cases[i].id] = QVariantMap{{"status", "not-executed"}, {"reason", "deadline"}};
            return finish();
        }
        if (caseIndex >= cases.size()) return finish();
        auto &current = cases[caseIndex];
        if (!caseStarted) {
            for (const auto &dependency : current.dependencies) {
                if (results.value(dependency).toMap()["status"] != "passed") {
                    results[current.id] = QVariantMap{{"status", "blocked"}, {"blockedBy", dependency}, {"cycle", cycle}};
                    ++caseIndex; return;
                }
            }
            caseStarted = true; stepIndex = 0; stepLog.clear(); caseClock.start(); stepClock.start(); action.resetForNextStep();
        }
        const auto &step = current.steps[stepIndex];
        // No polling, focus change or native event is allowed after either
        // deadline. Waiting never restarts either elapsed clock.
        if ((current.timeoutMs && caseClock.elapsed() >= current.timeoutMs) || stepClock.elapsed() >= step.timeoutMs)
            return finishCase("failed", "TIMEOUT:" + step.name);
        bool complete;
        try { complete = step.poll(); }
        catch (const std::exception &error) { return finishCase("failed", step.name + ":" + error.what()); }
        if (!complete) return;
        stepLog.append(QVariantMap{{"step", step.name}, {"ms", stepClock.elapsed()}, {"timeoutMs", step.timeoutMs},
                                  {"readiness", action.metadata()}, {"metadata", metadata()}});
        stepClock.restart(); action.resetForNextStep();
        if (++stepIndex >= current.steps.size()) finishCase("passed");
    }
    void finishCase(const QString &status, const QString &error = {}) {
        if (caseIndex >= cases.size()) return;
        results[cases[caseIndex].id] = QVariantMap{{"status", status}, {"error", error}, {"cycle", cycle}, {"steps", stepLog},
                                                 {"caseDeadlineMs", cases[caseIndex].timeoutMs}, {"elapsedMs", caseClock.elapsed()},
                                                 {"lastReadiness", action.metadata()}, {"finalMetadata", metadata()}};
        ++caseIndex; caseStarted = false;
    }
    void finish() {
        timer.stop();
        QStringList order; for (const auto &c : cases) order.append(c.id);
        auto callback = std::move(done);
        if (callback) callback({{"cases", results}, {"order", order}, {"observations", observations}, {"captures", captures},
                                {"safetyStopped", safetyStopped}, {"elapsedMs", clock.elapsed()}, {"cycleDeadlineMs", 205000},
                                {"inputScope", "Synthetic native clicks and one input-method commit per compose; clipped settings controls use contentY positioning"}});
        deleteLater();
    }
};
} // namespace
namespace P0TailCheck {
void run(QQuickWindow *window, RuntimeBridge *session, int cycle, const QString &a, const QString &b,
         const QString &prefix, std::function<void(QVariantMap)> completion) {
    new Check(window, session, cycle, a, b, prefix, std::move(completion));
}
} // namespace P0TailCheck
