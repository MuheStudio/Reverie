#include "ProfileClearCheck.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include "CheckContract.h"
#include "ControlReadiness.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QSet>
#include <QTest>
#include <QTimer>
#include <cmath>

namespace {
// These fixed synthetic values are shared by value with the isolated HTTP
// fixture. Neither chat contains them, so prompt sections own marker evidence.
const QString nickname = "隔离称呼·霜铃739";
const QString interest = "隔离兴趣·浮岛826";
const QString retainedIdentity = "隔离身份·星台保留915";
const QString retainedChatDraft = "资料清空保留草稿731";
const QString refilledNickname = "再填称呼";
const QString refilledInterest = "再填兴趣";
// Profile fields r1: the three added fields, entered through their own
// controls and cleared together with nickname and interests.
const QString favoriteGame = "隔离游戏·星轨413";
const QString favoriteAnime = "隔离动漫·潮汐562";
const int age = 31;
const QString refilledGame = "再填游戏";
const QString refilledAnime = "再填动漫";
const int refilledAge = 28;
const QString firstChat = "资料清空记录一：请认真核对用户的昵称、兴趣和身份";
const QString secondChat = "资料清空记录二：请认真核对用户的昵称、兴趣和身份";
const QStringList fieldNames{"name", "nickname", "birthday", "identity", "schedule", "interests", "hobbies", "favorite_topics",
                             "favorite_games", "favorite_anime", "age"};
const QStringList listFields{"interests", "hobbies", "favorite_topics", "favorite_games", "favorite_anime"};
// Selection order is click order, which is also the receipt's field order.
const QStringList clearedFields{"nickname", "interests", "favorite_games", "favorite_anime", "age"};

QQuickItem *find(QQuickItem *root, const QString &name) {
    if (root->objectName() == name && root->isVisible()) return root;
    for (auto *child : root->childItems())
        if (auto *found = find(child, name)) return found;
    return nullptr;
}
QQuickItem *named(QQuickItem *root, const QString &name) {
    if (auto *visible = find(root, name)) return visible;
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems())
        if (auto *found = named(child, name)) return found;
    return nullptr;
}
bool snapshotValid(const QString &value) {
    return value.size() == 64 && QRegularExpression("^[0-9a-f]{64}$").match(value).hasMatch();
}
bool successfulProfileResult(const QVariantMap &result, bool clearOperation = false) {
    const auto payload = QJsonObject::fromVariantMap(result);
    if (!payload.value("profile").isObject() || payload.contains("error") ||
        (payload.contains("ok") && !payload.value("ok").toBool()) ||
        !snapshotValid(payload.value("profile_snapshot").toString()) ||
        (clearOperation && (payload.value("ok") != true || payload.value("operation") != "clear"))) return false;
    const auto saved = payload.value("profile").toObject();
    for (const auto &field : fieldNames) {
        const auto value = saved.value(field);
        if (listFields.contains(field)) {
            if (!value.isArray()) return false;
            for (const auto &entry : value.toArray())
                if (!entry.isString()) return false;
        } else if (field == "age") {
            if (!value.isNull() && (!value.isDouble() || value.toDouble() != std::floor(value.toDouble()))) return false;
        } else if (!value.isString()) return false;
    }
    return true;
}
class Check final : public QObject {
  public:
    using Action = NativeControlReadiness::SequentialGate::Action;
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart;
    QString capturePrefix, scope, archiveContent, initialSnapshot, saveRequest, clearRequest, clearRead, chatRequest;
    QString lastGetId, lastGetSnapshot, profileReadRequest;
    QVariantMap lastGetProfile, beforeClearProfile;
    int initialArchiveRevision = 0, step = 0, updatesBeforeCancel = 0, commandsBeforeCancel = 0;
    int readsBeforeSave = 0, getResponses = 0;
    bool initialArchiveDirty = false, executing = false, inputStarted = false;
    QTimer timer;
    QElapsedTimer clock, inputClock;
    qint64 at = 0;
    QVariantList cases, inputs, writes, reads, chats, extendedCases, extendedHits;
    QVariantMap observed;
    QSet<QString> ownedRequests, recordedCases, recordedExtendedCases;
    std::function<void(QVariantMap)> done;
    NativeControlReadiness::SequentialGate gate;

    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify, QString prefix,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), e(editor), restart(verify), capturePrefix(std::move(prefix)),
          scope(session->scopeKey()), archiveContent(editor->content()), initialArchiveRevision(editor->revision()),
          initialArchiveDirty(editor->dirty()), done(std::move(callback)) {
        clock.start();
        connect(s, &RuntimeBridge::responseReceived, this,
                [this](const QString &id, const QString &command, const QVariantMap &result, int generation) {
                    if (generation != s->generation()) return;
                    if (command == "user:profile:get") {
                        ++getResponses;
                        lastGetId = id;
                        lastGetSnapshot = result.value("profile_snapshot").toString();
                        lastGetProfile = result.value("profile").toMap();
                        reads.append(QVariantMap{{"requestId", id}, {"scopeKey", s->scopeKey()},
                            {"snapshotLength", lastGetSnapshot.size()}, {"snapshotValid", snapshotValid(lastGetSnapshot)},
                            {"ok", successfulProfileResult(result)}});
                    } else if (command == "user:profile:update") {
                        writes.append(QVariantMap{{"requestId", id}, {"scopeKey", s->scopeKey()},
                            {"clear", result.value("operation") == "clear"}, {"ok", successfulProfileResult(result, id == clearRequest)}});
                    }
                });
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing) return;
            executing = true;
            try { tick(); }
            catch (const std::exception &error) { finish(false, error.what()); }
            executing = false;
        });
        timer.start();
    }
    void require(bool value, const QString &error) const {
        if (!value) throw std::runtime_error(error.toStdString());
    }
    void next(int target) { step = target; at = clock.elapsed(); inputStarted = false; gate.resetForNextStep(); }
    QVariantMap profile() const { return s->state().value("profile").toMap().value("profile").toMap(); }
    QString snapshot() const { return s->state().value("profile").toMap().value("profile_snapshot").toString(); }
    QVariantMap receipt() const { return s->memoryFeedback().value("profile").toMap(); }
    QVariantMap clear() const { return s->profileClearState(); }
    bool awaiting(const QString &command) const {
        for (const auto &value : s->diagnostics().value("pendingCommands").toList())
            if (value.toMap().value("command") == command) return true;
        return false;
    }
    bool profileSettled() const {
        return !awaiting("user:profile:get") && !awaiting("user:profile:update") &&
               receipt().value("status") != "pending" && snapshotValid(snapshot());
    }
    bool memoryReady() const {
        const auto *item = find(w->contentItem(), "drawer-memory");
        return item && item->property("inputReady").toBool();
    }
    bool surfacesClosed() const {
        for (const auto *name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            const auto *item = named(w->contentItem(), name);
            if (item && item->property("progress").toDouble() > 0) return false;
        }
        return true;
    }
    QString text(const QString &name) const {
        const auto *item = find(w->contentItem(), name);
        return item ? item->property("text").toString() : QString();
    }
    void click(QQuickItem *item) {
        require(item && item->isEnabled(), "PROFILE_CLEAR_CONTROL_UNAVAILABLE");
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier,
                          item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint(), 0);
    }
    void type(QQuickItem *item, const QString &value) {
        click(item);
        require(QMetaObject::invokeMethod(item, "selectAll"), "PROFILE_CLEAR_SELECT_ALL_UNAVAILABLE");
        QInputMethodEvent commit;
        commit.setCommitString(value);
        QCoreApplication::sendEvent(w, &commit);
        require(item->property("text").toString() == value, "PROFILE_CLEAR_INPUT_NOT_COMMITTED:" + item->objectName());
    }
    // Inputs added for the extended fields follow the check conventions: the
    // gate has revealed the control; the press must also land on it or a
    // child before it is sent. The original inputs above are unchanged.
    void verifiedClick(QQuickItem *item, const QString &code) {
        require(item && item->isEnabled(), "PROFILE_CLEAR_CONTROL_UNAVAILABLE");
        const auto point = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
        const auto hit = NativeCheck::hitTest(w, point, item);
        if (extendedHits.size() < 16)
            extendedHits.append(QVariantMap{{"control", item->objectName().left(80)}, {"hitResult", hit.result},
                                            {"passiveObserverCount", hit.passiveObserverCount}});
        require(hit.accepted(), NativeCheck::describe(code, hit.metadata()));
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, point.toPoint(), 0);
    }
    void typeVerified(QQuickItem *item, const QString &value) {
        verifiedClick(item, "PROFILE_EXTENDED_INPUT_HIT");
        require(QMetaObject::invokeMethod(item, "selectAll"), "PROFILE_CLEAR_SELECT_ALL_UNAVAILABLE");
        QInputMethodEvent commit;
        commit.setCommitString(value);
        QCoreApplication::sendEvent(w, &commit);
        require(item->property("text").toString() == value, "PROFILE_EXTENDED_INPUT_NOT_COMMITTED:" + item->objectName());
    }
    static bool ageIs(const QVariantMap &saved, int expected) {
        const auto value = saved.value("age");
        return !value.isNull() && value.canConvert<double>() && value.toDouble() == expected;
    }
    static bool extendedEmpty(const QVariantMap &saved) {
        return saved.value("favorite_games").toList().isEmpty() && saved.value("favorite_anime").toList().isEmpty() &&
               saved.contains("age") && saved.value("age").isNull();
    }
    Action action(const QString &name, const std::function<bool()> &surface,
                  const std::function<void(QQuickItem *)> &perform) {
        return {name, [this, name] { return named(w->contentItem(), name); },
                [this, surface](QQuickItem *item) { return NativeControlReadiness::snapshot(item, w, surface()); }, perform};
    }
    Action press(const QString &name, const std::function<bool()> &surface) {
        return action(name, surface, [this](QQuickItem *item) { click(item); });
    }
    bool input(const std::vector<Action> &actions) {
        if (!inputStarted) { inputStarted = true; inputClock.start(); }
        const auto result = gate.poll([this] { return inputClock.elapsed(); }, 4000, actions);
        require(result != NativeControlReadiness::SequentialGate::Expired, "PROFILE_CLEAR_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "PROFILE_CLEAR_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) return false;
        inputs.append(QVariantMap{{"step", step}, {"deadlineMs", 4000}, {"gate", gate.metadata()}});
        return true;
    }
    bool press(const QString &name, bool memory = false) {
        return input({press(name, [this, memory] { return memory ? memoryReady() : surfacesClosed(); })});
    }
    void ownRequest(const QString &id, const QString &error) {
        require(!id.isEmpty() && !ownedRequests.contains(id), error);
        ownedRequests.insert(id);
    }
    bool readReady(const QString &code) const {
        require(clock.elapsed() - at < 10000, code + "_READ_DEADLINE");
        return clock.elapsed() - at > 80 && profileSettled();
    }
    void requireCleared(const QString &code) const {
        const auto saved = profile();
        require(saved.value("nickname").toString().isEmpty() && saved.value("interests").toList().isEmpty() &&
                saved.value("identity") == retainedIdentity, code);
        require(extendedEmpty(saved), "PROFILE_EXTENDED_FIELDS_NOT_EMPTY:" + code);
    }
    void requireFields(bool cleared, bool refilled = false) const {
        require(find(w->contentItem(), "profileNickname") && find(w->contentItem(), "profileInterests") &&
                find(w->contentItem(), "profileIdentity"), "PROFILE_CLEAR_FIELDS_MISSING");
        require(text("profileNickname") == (refilled ? refilledNickname : cleared ? QString() : nickname) &&
                text("profileInterests") == (refilled ? refilledInterest : cleared ? QString() : interest) &&
                text("profileIdentity") == retainedIdentity && !find(w->contentItem(), "profileDirtyHint"),
                "PROFILE_CLEAR_FIELDS_NOT_FROM_SAVED_PROFILE");
        require(find(w->contentItem(), "profileFavoriteGames") && find(w->contentItem(), "profileFavoriteAnime") &&
                find(w->contentItem(), "profileAge"), "PROFILE_EXTENDED_FIELDS_MISSING");
        require(text("profileFavoriteGames") == (refilled ? refilledGame : cleared ? QString() : favoriteGame) &&
                text("profileFavoriteAnime") == (refilled ? refilledAnime : cleared ? QString() : favoriteAnime) &&
                text("profileAge") == (refilled ? QString::number(refilledAge) : cleared ? QString() : QString::number(age)),
                "PROFILE_EXTENDED_FIELDS_NOT_FROM_SAVED_PROFILE");
    }
    void requireDrafts() const {
        require(s->draft() == retainedChatDraft, "PROFILE_CLEAR_CHAT_DRAFT_CHANGED");
        require(e->content() == archiveContent && e->dirty() == initialArchiveDirty &&
                e->revision() == initialArchiveRevision, "PROFILE_CLEAR_WORLDBOOK_DRAFT_CHANGED");
    }
    void readProfile(QQuickItem *item) {
        readsBeforeSave = getResponses;
        click(item);
        profileReadRequest = clear().value("readId").toString();
        ownRequest(profileReadRequest, "PROFILE_EXPLICIT_READ_REQUEST_REUSED_OR_MISSING");
        require(clear().value("status") == "refreshing" && clear().value("manualRefreshing").toBool(),
                "PROFILE_EXPLICIT_READ_NOT_SENT");
    }
    void requireDialog(bool selected) const {
        require(clear().value("status") == "confirmation" &&
                clear().value("scopeKey") == scope && clear().value("profileSnapshot") == snapshot(),
                "PROFILE_CLEAR_CONFIRMATION_SCOPE_OR_SNAPSHOT");
        require(find(w->contentItem(), "profileClearCancel") && find(w->contentItem(), "profileClearConfirm") &&
                !text("profileClearExplanation").isEmpty(), "PROFILE_CLEAR_CONFIRMATION_NOT_SHOWN");
        const auto explanation = text("profileClearExplanation");
        for (const auto *part : {"所有人格共用的资料", "仅清空你选中的已保存字段", "更新当前人格中由这些字段生成的资料事实",
                                "其他人格已有的资料派生记忆不保证立即同步", "聊天历史", "情绪记忆", "独立确认的记忆", "日记", "世界书",
                                "默认不选", "不会自动重试"})
            require(explanation.contains(part), "PROFILE_CLEAR_SCOPE_EXPLANATION_INCOMPLETE");
        for (const auto &field : fieldNames) {
            const auto *item = find(w->contentItem(), "profileClearField-" + field);
            require(item && item->property("checked").toBool() == (selected && clearedFields.contains(field)),
                    "PROFILE_CLEAR_FIELD_SELECTION_UNEXPECTED:" + field);
        }
        const auto *confirm = find(w->contentItem(), "profileClearConfirm");
        require(confirm->isEnabled() == selected, "PROFILE_CLEAR_CONFIRM_BUTTON_UNEXPECTED");
    }
    // Every choice label, saved or empty, must read on the rendered glass.
    // Measured once, on the confirmation's first frame, before any click.
    void requireLabelContrast(const QImage &capture) {
        if (observed.contains("clearLabelContrast")) return;
        QVariantList labels;
        for (const auto &field : fieldNames) {
            const auto *choice = find(w->contentItem(), "profileClearField-" + field);
            const auto *label = find(w->contentItem(), "profileClearFieldLabel-" + field);
            require(choice && label && choice->property("contentItem").value<QQuickItem *>() == label &&
                    !label->property("text").toString().isEmpty() &&
                    label->property("text") == choice->property("text") && !label->property("truncated").toBool(),
                    "PROFILE_CLEAR_LABEL_MISSING:" + field);
            auto measured = NativeCheck::renderedTextContrast(capture, label);
            measured.insert({{"field", field}, {"enabled", choice->isEnabled()}});
            require(measured.value("contrast").toDouble() >= 4.5,
                    NativeCheck::describe("PROFILE_CLEAR_LABEL_CONTRAST_LOW:" + field, measured));
            labels.append(measured);
        }
        observed["clearLabelContrast"] = labels;
    }
    void record(const QString &name, const QVariantMap &metadata = {}) {
        if (recordedCases.contains(name)) return;
        recordedCases.insert(name);
        auto value = metadata;
        value.insert({{"name", name}, {"passed", true}});
        cases.append(value);
    }
    // The extended assertions are counted apart from the original seven/three.
    void recordExtended(const QString &name, const QVariantMap &metadata = {}) {
        if (recordedExtendedCases.contains(name)) return;
        recordedExtendedCases.insert(name);
        auto value = metadata;
        value.insert({{"name", name}, {"passed", true}});
        extendedCases.append(value);
    }
    void sendChat(QQuickItem *item) {
        click(item);
        chatRequest = s->chatFeedback().value("requestId").toString();
        ownRequest(chatRequest, "PROFILE_CLEAR_CHAT_REQUEST_REUSED_OR_MISSING");
        require(s->chatFeedback().value("status") == "queued" && s->chatSendGate().isEmpty(),
                "PROFILE_CLEAR_CHAT_NOT_QUEUED");
    }
    bool chatDone(const QString &message, int stage) {
        require(clock.elapsed() - at < 10000, "PROFILE_CLEAR_CHAT_DEADLINE");
        if (s->busy() || awaiting("chat:send") || awaiting("chat:history")) return false;
        require(s->chatFeedback().value("requestId") == chatRequest && s->chatFeedback().value("status") == "done" &&
                s->diagnostics().value("chatRequestId").toString().isEmpty(), "PROFILE_CLEAR_CHAT_TERMINAL_UNCONFIRMED");
        int users = 0, replies = 0, characters = 0;
        QSet<QString> messageIds;
        for (const auto &value : s->messages()) {
            const auto row = value.toMap();
            if (row.value("request_id") != chatRequest) continue;
            const auto id = row.value("id").toString();
            require(!id.isEmpty() && !messageIds.contains(id), "PROFILE_CLEAR_CHAT_MESSAGE_ID_REUSED");
            messageIds.insert(id);
            if (row.value("role") == "user") {
                ++users;
                require(row.value("content") == message, "PROFILE_CLEAR_CHAT_USER_HISTORY_MISMATCH");
            } else if (row.value("role") == "assistant") {
                ++replies;
                const auto reply = row.value("content").toString();
                characters += reply.size();
                // MessageScheduler normalizes the fixture's trailing 。 away.
                require(reply == (stage == 1 ? "资料确认回复一" : "资料确认回复二"),
                        "PROFILE_CLEAR_CHAT_REPLY_MARKER_MISMATCH");
            }
        }
        require(users == 1 && replies == 1, "PROFILE_CLEAR_CHAT_HISTORY_INCOMPLETE");
        chats.append(QVariantMap{{"stage", stage}, {"requestId", chatRequest}, {"scopeKey", scope},
            {"terminal", "done"}, {"userMatches", true}, {"replyMatches", true},
            {"userCount", users}, {"replyCount", replies}, {"replyCharacters", characters}});
        return true;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        auto callback = std::move(done);
        observed["scopeKey"] = scope;
        observed["finalNicknameCharacters"] = profile().value("nickname").toString().size();
        observed["finalInterestCount"] = profile().value("interests").toList().size();
        observed["finalRetainedIdentityMatches"] = profile().value("identity") == retainedIdentity;
        observed["finalGamesCount"] = profile().value("favorite_games").toList().size();
        observed["finalAnimeCount"] = profile().value("favorite_anime").toList().size();
        observed["finalAgeEmpty"] = profile().value("age").isNull();
        observed["finalAge"] = profile().value("age").isNull() ? QVariant() : QVariant(qRound(profile().value("age").toDouble()));
        observed["extendedHits"] = extendedHits;
        observed["snapshotLength"] = snapshot().size();
        observed["writes"] = writes;
        observed["reads"] = reads;
        observed["chats"] = chats;
        if (callback) callback({{"passed", passed}, {"error", error},
            {"mode", restart ? "restart-readback-and-refill" : "save-cancel-clear-and-chat"},
            {"step", step}, {"elapsedMs", clock.elapsed()}, {"checks", cases}, {"extendedChecks", extendedCases},
            {"observed", observed},
            {"inputs", inputs}, {"inputCurrent", gate.metadata()}, {"contentCollected", false},
            {"inputMethodScope", "synthetic QInputMethodEvent commits, not physical OS IME acceptance"}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < (restart ? 30000 : 60000), "PROFILE_CLEAR_SCENARIO_DEADLINE");
        require(s->scopeKey() == scope && s->runtimeWritable(), "PROFILE_CLEAR_SCOPE_OR_WRITABILITY_CHANGED");
        if (restart) { restartFlow(); return; }
        const auto memory = [this] { return memoryReady(); };
        const auto closed = [this] { return surfacesClosed(); };
        const auto dialog = [this] { return clear().value("status") == "confirmation"; };
        if (step == 0) { if (press("nav-memory")) next(1); return; }
        if (step == 1) { if (press("archive-open-memories", true)) next(2); return; }
        if (step == 2) {
            if (!readReady("PROFILE_INITIAL")) return;
            if (press("memoryTab-profile", true)) next(3);
            return;
        }
        if (step == 3) {
            // Six inputs fill one gate; the save keeps its own step and deadline.
            if (input({action("profileNickname", memory, [this](QQuickItem *item) { type(item, nickname); }),
                       action("profileInterests", memory, [this](QQuickItem *item) { type(item, interest); }),
                       action("profileIdentity", memory, [this](QQuickItem *item) { type(item, retainedIdentity); }),
                       action("profileFavoriteGames", memory, [this](QQuickItem *item) { typeVerified(item, favoriteGame); }),
                       action("profileFavoriteAnime", memory, [this](QQuickItem *item) { typeVerified(item, favoriteAnime); }),
                       action("profileAge", memory, [this](QQuickItem *item) { typeVerified(item, QString::number(age)); })})) next(30);
            return;
        }
        if (step == 30) {
            if (input({action("profileSave", memory, [this](QQuickItem *item) {
                           require(find(w->contentItem(), "profileDirtyHint"), "PROFILE_CLEAR_EDIT_NOT_DIRTY");
                           readsBeforeSave = getResponses;
                           click(item);
                           saveRequest = receipt().value("requestId").toString();
                           ownRequest(saveRequest, "PROFILE_CLEAR_SAVE_REQUEST_MISSING");
                           require(receipt().value("status") == "pending", "PROFILE_CLEAR_SAVE_NOT_SENT");
                       })})) next(4);
            return;
        }
        if (step == 4) {
            if (!readReady("PROFILE_SAVE")) return;
            require(receipt().value("status") == "success" && receipt().value("requestId") == saveRequest,
                    "PROFILE_CLEAR_SAVE_UNCONFIRMED");
            if (input({action("profileClearRefresh", memory, [this](QQuickItem *item) { readProfile(item); })})) next(40);
            return;
        }
        if (step == 40) {
            if (!readReady("PROFILE_SAVE_READBACK")) return;
            require(getResponses > readsBeforeSave && lastGetId == profileReadRequest && lastGetProfile == profile() &&
                    lastGetSnapshot == snapshot() && clear().value("status") == "refreshed", "PROFILE_CLEAR_SAVE_READBACK_UNCONFIRMED");
            require(profile().value("nickname") == nickname && profile().value("interests").toStringList() == QStringList{interest} &&
                    profile().value("identity") == retainedIdentity, "PROFILE_CLEAR_SYNTHETIC_FIELDS_NOT_SAVED");
            require(profile().value("favorite_games").toStringList() == QStringList{favoriteGame} &&
                    profile().value("favorite_anime").toStringList() == QStringList{favoriteAnime} && ageIs(profile(), age),
                    "PROFILE_EXTENDED_FIELDS_NOT_SAVED");
            requireFields(false);
            beforeClearProfile = profile();
            initialSnapshot = snapshot();
            observed["saveRequestId"] = saveRequest;
            observed["saveReadId"] = lastGetId;
            record("profile-fields-save-and-read-back", {{"nicknameCharacters", nickname.size()}, {"interestCount", 1},
                {"retainedIdentityCharacters", retainedIdentity.size()}, {"snapshotLength", snapshot().size()}});
            recordExtended("extended-fields-save-and-read-back", {{"gamesCount", 1}, {"animeCount", 1}, {"ageMatches", true},
                {"saveRequestId", saveRequest}, {"readId", lastGetId}});
            if (press("memory-close", true)) next(5);
            return;
        }
        if (step == 5) { if (press("nav-chat")) next(6); return; }
        if (step == 6) {
            if (input({action("chatComposer", closed, [this](QQuickItem *item) { type(item, firstChat); }),
                       action("sendChat", closed, [this](QQuickItem *item) { sendChat(item); })})) next(7);
            return;
        }
        if (step == 7) {
            if (!chatDone(firstChat, 1)) return;
            record("profile-before-clear-chat-completes", {{"requestId", chatRequest}, {"terminal", "done"}});
            next(8); return;
        }
        if (step == 8) {
            if (input({action("chatComposer", closed, [this](QQuickItem *item) { type(item, retainedChatDraft); }),
                       press("nav-memory", closed)})) next(9);
            return;
        }
        if (step == 9) { if (press("archive-open-memories", true)) next(10); return; }
        if (step == 10) {
            if (!readReady("PROFILE_BEFORE_CANCEL")) return;
            if (press("memoryTab-profile", true)) next(11);
            return;
        }
        if (step == 11) {
            requireFields(false); requireDrafts();
            if (input({action("profileClear", memory, [this](QQuickItem *item) {
                           updatesBeforeCancel = writes.size();
                           commandsBeforeCancel = s->diagnostics().value("commands").toInt();
                           click(item);
                       })})) next(12);
            return;
        }
        if (step == 12 || step == 16) {
            if (gate.metadata().value("actionIndex").toInt() == 0) requireDialog(false);
            const auto choose = [this, dialog](const QString &name) {
                return action(name, dialog, [this](QQuickItem *item) { verifiedClick(item, "PROFILE_EXTENDED_CLEAR_CHOICE_HIT"); });
            };
            if (input({press("profileClearField-nickname", dialog), press("profileClearField-interests", dialog),
                       choose("profileClearField-favorite_games"), choose("profileClearField-favorite_anime"),
                       choose("profileClearField-age")}))
                next(step == 12 ? 13 : 17);
            return;
        }
        if (step == 13) {
            requireDialog(true);
            w->grabWindow().save(capturePrefix + ".profile-clear-cancel.png");
            if (input({press("profileClearCancel", dialog)})) next(14);
            return;
        }
        if (step == 14) {
            if (find(w->contentItem(), "profileClearCancel")) return;
            require(clear().value("status") == "cancelled" && writes.size() == updatesBeforeCancel &&
                    !awaiting("user:profile:update") && s->diagnostics().value("commands").toInt() == commandsBeforeCancel &&
                    profile() == beforeClearProfile && snapshot() == initialSnapshot, "PROFILE_CLEAR_CANCEL_CHANGED_STATE_OR_SENT_COMMAND");
            requireFields(false); requireDrafts();
            observed["cancelClearWrites"] = 0;
            observed["cancelCommands"] = 0;
            record("cancel-clear-sends-no-write", {{"clearWrites", 0}, {"profileMatches", true}, {"draftsMatch", true}});
            next(15); return;
        }
        if (step == 15) { if (press("profileClear", true)) next(16); return; }
        if (step == 17) {
            requireDialog(true);
            const auto capture = w->grabWindow();
            capture.save(capturePrefix + ".profile-clear-confirmation.png");
            requireLabelContrast(capture);
            if (input({action("profileClearConfirm", dialog, [this](QQuickItem *item) {
                           click(item);
                           clearRequest = clear().value("requestId").toString();
                           ownRequest(clearRequest, "PROFILE_CLEAR_CONFIRM_REQUEST_REUSED_OR_MISSING");
                           require(clear().value("status") == "pending", "PROFILE_CLEAR_CONFIRM_NOT_SENT");
                       })})) next(18);
            return;
        }
        if (step == 18) {
            if (!readReady("PROFILE_CLEAR")) return;
            const auto feedback = clear();
            if (feedback.value("status") == "pending") return;
            clearRead = feedback.value("readId").toString();
            require(feedback.value("status") == "success" && feedback.value("requestId") == clearRequest &&
                    feedback.value("scopeKey") == scope && feedback.value("selectedFields").toStringList() == clearedFields &&
                    !clearRead.isEmpty() && clearRead == lastGetId && lastGetProfile == profile() && lastGetSnapshot == snapshot() &&
                    snapshot() != initialSnapshot && feedback.value("receiptConfirmed").toBool(), "PROFILE_CLEAR_READBACK_UNCONFIRMED");
            ownRequest(clearRead, "PROFILE_CLEAR_READ_REQUEST_REUSED");
            requireCleared("PROFILE_CLEAR_FIELDS_NOT_EMPTY");
            for (const auto &field : fieldNames)
                if (!clearedFields.contains(field))
                    require(profile().value(field) == beforeClearProfile.value(field), "PROFILE_CLEAR_UNSELECTED_FIELD_CHANGED:" + field);
            requireFields(true); requireDrafts();
            observed["clearRequestId"] = clearRequest;
            observed["clearReadId"] = clearRead;
            observed["snapshotChanged"] = true;
            next(180); return;
        }
        if (step == 180) {
            if (!input({action("profileClearFeedback", memory, [this](QQuickItem *item) {
                    const auto feedback = clear();
                    const auto shown = item->property("text").toString();
                    const auto rect = NativeControlReadiness::visibleRect(item, w);
                    require(feedback.value("status") == "success" && feedback.value("requestId") == clearRequest &&
                            feedback.value("readId") == clearRead && feedback.value("scopeKey") == scope &&
                            shown == "已清空：称呼、兴趣、喜欢的游戏、喜欢的动漫、年龄；当前资料已核对。" && shown == feedback.value("text").toString(),
                            "PROFILE_CLEAR_MATCHING_FEEDBACK_NOT_SHOWN");
                    require(rect.width() >= item->width() - 1 && rect.height() >= item->height() - 1,
                            "PROFILE_CLEAR_FEEDBACK_CLIPPED");
                    observed["clearFeedbackRequestId"] = clearRequest;
                    observed["clearFeedbackReadId"] = clearRead;
                    observed["clearFeedbackCharacters"] = shown.size();
                    observed["clearFeedbackVisibleMatches"] = true;
                })})) return;
            record("clear-only-selected-fields-with-read-back", {{"requestId", clearRequest}, {"readId", clearRead},
                {"clearedFieldCount", clearedFields.size()}, {"nicknameCharacters", 0}, {"interestCount", 0}, {"scopeMatches", true}});
            record("clear-preserves-drafts-and-unselected-fields", {{"unselectedFields", fieldNames.size() - clearedFields.size()},
                {"chatDraftCharacters", retainedChatDraft.size()},
                {"worldbookDraftCharacters", archiveContent.size()}, {"draftsMatch", true}});
            recordExtended("extended-fields-clear-with-read-back", {{"requestId", clearRequest}, {"readId", clearRead},
                {"clearedExtendedFieldCount", 3}, {"gamesCount", 0}, {"animeCount", 0}, {"ageEmpty", true}});
            w->grabWindow().save(capturePrefix + ".profile-cleared.png");
            next(181); return;
        }
        if (step == 181) {
            if (press("memory-close", true)) next(19);
            return;
        }
        if (step == 19) { if (press("nav-memory")) next(20); return; }
        if (step == 20) { if (press("archive-open-memories", true)) next(21); return; }
        if (step == 21) { if (press("memoryTab-profile", true)) next(22); return; }
        if (step == 22) {
            if (!readReady("PROFILE_REOPEN")) return;
            requireCleared("PROFILE_CLEAR_REOPEN_RESTORED_CLEARED_FIELDS"); requireFields(true); requireDrafts();
            record("closed-profile-page-reopens-cleared-fields", {{"nicknameCharacters", 0}, {"interestCount", 0}, {"retainedIdentityMatches", true}});
            recordExtended("closed-profile-page-reopens-extended-fields-cleared", {{"gamesCount", 0}, {"animeCount", 0}, {"ageEmpty", true}});
            if (press("memory-close", true)) next(23);
            return;
        }
        if (step == 23) { if (press("nav-chat")) next(24); return; }
        if (step == 24) {
            if (input({action("chatComposer", closed, [this](QQuickItem *item) {
                           require(s->draft() == retainedChatDraft && item->property("text") == retainedChatDraft,
                                   "PROFILE_CLEAR_RETURN_LOST_CHAT_DRAFT");
                           type(item, secondChat);
                       }), action("sendChat", closed, [this](QQuickItem *item) { sendChat(item); })})) next(25);
            return;
        }
        if (step == 25) {
            if (!chatDone(secondChat, 2)) return;
            requireCleared("PROFILE_CLEAR_NEXT_CHAT_RESTORED_CLEARED_FIELDS");
            require(writes.size() == 2 && writes[0].toMap().value("requestId") == saveRequest &&
                    !writes[0].toMap().value("clear").toBool() && writes[1].toMap().value("requestId") == clearRequest &&
                    writes[1].toMap().value("clear").toBool(), "PROFILE_CLEAR_WRITE_COUNT_OR_KIND_CHANGED");
            record("profile-after-clear-chat-completes", {{"requestId", chatRequest}, {"terminal", "done"}});
            finish(true);
        }
    }
    void restartFlow() {
        const auto memory = [this] { return memoryReady(); };
        if (step == 0) {
            if (!readReady("PROFILE_RESTART_INITIAL")) return;
            requireCleared("PROFILE_RESTART_CLEARED_FIELDS_NOT_ON_DISK");
            observed["beforeAnyProfileInput"] = true;
            observed["restartReadbackNicknameEmpty"] = true;
            observed["restartReadbackInterestsEmpty"] = true;
            observed["restartRetainedIdentityMatches"] = true;
            record("restart-reads-cleared-profile-before-input", {{"nicknameCharacters", 0}, {"interestCount", 0},
                {"retainedIdentityMatches", true}, {"profileInputsPerformed", false}, {"snapshotLength", snapshot().size()}});
            observed["restartReadbackExtendedEmpty"] = true;
            recordExtended("restart-reads-extended-fields-cleared-before-input", {{"gamesCount", 0}, {"animeCount", 0},
                {"ageEmpty", true}, {"profileInputsPerformed", false}});
            next(1); return;
        }
        if (step == 1) { if (press("nav-memory")) next(2); return; }
        if (step == 2) { if (press("archive-open-memories", true)) next(3); return; }
        if (step == 3) { if (press("memoryTab-profile", true)) next(4); return; }
        if (step == 4) {
            if (gate.metadata().value("actionIndex").toInt() == 0) requireFields(true);
            if (input({action("profileNickname", memory, [this](QQuickItem *item) { type(item, refilledNickname); }),
                       action("profileInterests", memory, [this](QQuickItem *item) { type(item, refilledInterest); }),
                       action("profileFavoriteGames", memory, [this](QQuickItem *item) { typeVerified(item, refilledGame); }),
                       action("profileFavoriteAnime", memory, [this](QQuickItem *item) { typeVerified(item, refilledAnime); }),
                       action("profileAge", memory, [this](QQuickItem *item) { typeVerified(item, QString::number(refilledAge)); }),
                       action("profileSave", memory, [this](QQuickItem *item) {
                           readsBeforeSave = getResponses;
                           click(item);
                           saveRequest = receipt().value("requestId").toString();
                           ownRequest(saveRequest, "PROFILE_RESTART_REFILL_REQUEST_MISSING");
                           require(receipt().value("status") == "pending", "PROFILE_RESTART_REFILL_NOT_SENT");
                       })})) next(5);
            return;
        }
        if (step == 5) {
            if (!readReady("PROFILE_RESTART_REFILL")) return;
            require(receipt().value("status") == "success" && receipt().value("requestId") == saveRequest,
                    "PROFILE_RESTART_REFILL_SAVE_UNCONFIRMED");
            if (input({action("profileClearRefresh", memory, [this](QQuickItem *item) { readProfile(item); })})) next(50);
            return;
        }
        if (step == 50) {
            if (!readReady("PROFILE_RESTART_REFILL_READBACK")) return;
            require(getResponses > readsBeforeSave && lastGetId == profileReadRequest && lastGetProfile == profile() && lastGetSnapshot == snapshot() &&
                    clear().value("status") == "refreshed" &&
                    profile().value("nickname") == refilledNickname && profile().value("interests").toStringList() == QStringList{refilledInterest} &&
                    profile().value("identity") == retainedIdentity, "PROFILE_RESTART_REFILL_NOT_READ_BACK");
            require(profile().value("favorite_games").toStringList() == QStringList{refilledGame} &&
                    profile().value("favorite_anime").toStringList() == QStringList{refilledAnime} && ageIs(profile(), refilledAge),
                    "PROFILE_RESTART_EXTENDED_REFILL_NOT_READ_BACK");
            requireFields(false, true);
            observed["refillRequestId"] = saveRequest;
            observed["refillReadId"] = lastGetId;
            record("restart-refill-saves-and-reads-back", {{"requestId", saveRequest}, {"readId", lastGetId},
                {"nicknameCharacters", refilledNickname.size()}, {"interestCount", 1}, {"retainedIdentityMatches", true}});
            recordExtended("restart-extended-refill-saves-and-reads-back", {{"requestId", saveRequest}, {"readId", lastGetId},
                {"gamesCount", 1}, {"animeCount", 1}, {"ageMatches", true}});
            w->grabWindow().save(capturePrefix + ".profile-refilled.png");
            if (press("memory-close", true)) next(6);
            return;
        }
        if (step == 6) { if (press("nav-memory")) next(7); return; }
        if (step == 7) { if (press("archive-open-memories", true)) next(8); return; }
        if (step == 8) { if (press("memoryTab-profile", true)) next(9); return; }
        if (step == 9) {
            if (!readReady("PROFILE_RESTART_REOPEN")) return;
            requireFields(false, true);
            record("restart-refill-survives-page-reopen", {{"nicknameMatches", true}, {"interestsMatch", true},
                {"retainedIdentityMatches", true}, {"modelRequests", 0}});
            recordExtended("restart-extended-refill-survives-page-reopen", {{"gamesMatch", true}, {"animeMatch", true},
                {"ageMatches", true}});
            if (press("memory-close", true)) next(10);
            return;
        }
        if (step == 10 && surfacesClosed()) {
            require(writes.size() == 1 && writes[0].toMap().value("requestId") == saveRequest &&
                    !writes[0].toMap().value("clear").toBool() && chats.isEmpty(), "PROFILE_RESTART_EXTRA_WRITE_OR_CHAT");
            finish(true);
        }
    }
};
}
void ProfileClearCheck::run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool restart,
                            const QString &capturePrefix, std::function<void(QVariantMap)> completion) {
    new Check(window, session, editor, restart, capturePrefix, std::move(completion));
}
