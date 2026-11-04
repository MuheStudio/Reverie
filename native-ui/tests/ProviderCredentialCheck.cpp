#include "ProviderCredentialCheck.h"
#include "../src/RuntimeBridge.h"
#include "ControlReadiness.h"
#include <QElapsedTimer>
#include <QFile>
#include <QInputMethodEvent>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QTest>
#include <QTimer>
#include <QUrl>
#include <algorithm>
#include <stdexcept>

namespace {
// The mock model marks these requests and reports only whether each carried the key.
const QString chatSaved = "密钥记录一：今晚想聊聊窗外的风";
const QString chatOtherEndpoint = "密钥记录二：换一个地方再聊聊";
const QString chatBack = "密钥记录三：回到原来的地方聊聊";
const QString chatAfterRestart = "密钥记录四：重新打开以后还在吗";
const QString chatDeleted = "密钥记录五：删除以后再说一句";
const QString chatRestored = "密钥记录六：恢复备份以后还在吗";
const QString chatImported = "密钥记录七：新人格里再聊聊窗外的风";
const QString model = "reverie-qt-test";
const QString cardName = "测试人格·钥";

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
bool loopbackEndpoint(const QUrl &url) {
    return url.isValid() && url.scheme() == "http" && url.host() == "127.0.0.1" && url.port() >= 1024 &&
           url.path() == "/v1" && url.userInfo().isEmpty() && !url.hasQuery() && !url.hasFragment();
}
class Check final : public QObject {
  public:
    QQuickWindow *w;
    RuntimeBridge *s;
    bool restart;
    ProviderCredentialCheck::Fixture fixture;
    QString capturePrefix;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock;
    int step = 0;
    qint64 at = 0;
    int commandsBefore = -1;
    bool executing = false;
    QVariantList cases, readiness;
    QVariantMap observed;
    QString defaultScope, defaultPersonaId, defaultFingerprint, importedScope, importedPersona, importRequest, returnRequest;
    int restoreGeneration = 0;
    qulonglong deliveryBefore = 0;
    QVariantList defaultMessageIds, resends;
    NativeControlReadiness::OnceGate gate;
    Check(QQuickWindow *window, RuntimeBridge *session, bool restartCycle, ProviderCredentialCheck::Fixture f,
          QString prefix, std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), restart(restartCycle), fixture(std::move(f)),
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
        require(i && i->isEnabled(), "PROVIDER_CONTROL_UNAVAILABLE:" + name);
        auto p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint(), 0);
    }
    void type(const QString &name, const QString &text) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "PROVIDER_EDITOR_UNAVAILABLE:" + name);
        i->forceActiveFocus();
        QMetaObject::invokeMethod(i, "selectAll");
        QInputMethodEvent commit;
        commit.setCommitString(text);
        QCoreApplication::sendEvent(w, &commit);
        require(i->property("text").toString() == text, "PROVIDER_INPUT_NOT_COMMITTED:" + name);
    }
    // A closed combo box changes its selection, and reports it as the user's, on arrow keys.
    void arrow(const QString &name, Qt::Key key, int times) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "PROVIDER_CONTROL_UNAVAILABLE:" + name);
        i->forceActiveFocus();
        for (int n = 0; n < times; ++n)
            QTest::keyClick(w, key);
    }
    QString text(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i ? i->property("text").toString() : QString();
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
    bool surfaceOpen(const QString &name) const {
        auto *i = named(w->contentItem(), name);
        return i && i->property("inputReady").toBool();
    }
    // The existing character check uses this positioning for controls inside
    // its scrolled page; input still passes the ordinary 4 s eligibility gate.
    void reveal(QQuickItem *item) const {
        for (auto *p = item ? item->parentItem() : nullptr; p; p = p->parentItem()) {
            if (!p->inherits("QQuickFlickable"))
                continue;
            auto *content = p->property("contentItem").value<QQuickItem *>();
            if (!content)
                continue;
            const qreal y = item->mapToItem(content, QPointF(0, 0)).y();
            const qreal maximum = std::max<qreal>(0, p->property("contentHeight").toReal() - p->height());
            const qreal top = p->property("contentY").toReal();
            if (y < top || y + item->height() > top + p->height())
                p->setProperty("contentY", std::clamp<qreal>(y - p->height() * .3, 0, maximum));
        }
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
    bool whenReady(const QString &name, bool surface, const std::function<void()> &action) {
        const auto result = gate.poll(clock.elapsed() - at, 4000, [&] {
            auto state = NativeControlReadiness::snapshot(named(w->contentItem(), name), w, surface);
            state["control"] = name;
            state["step"] = step;
            return state;
        }, action);
        require(result != NativeControlReadiness::OnceGate::Expired, "PROVIDER_READINESS_DEADLINE:" + name);
        if (result != NativeControlReadiness::OnceGate::Performed)
            return false;
        readiness.append(QVariantMap{{"step", step}, {"control", name}, {"gate", gate.metadata()}});
        gate.resetForNextStep();
        return true;
    }
    QVariantMap key() const { return s->state().value("providerKey").toMap(); }
    QVariantMap provider() const { return s->state().value("provider").toMap(); }
    QString feedbackStatus() const { return s->providerFeedback().value("status").toString(); }
    bool keySettled() const {
        return !key().value("pending").toBool() && !s->providerFeedback().value("pending").toBool() &&
               !awaiting("credentials:set") && !awaiting("provider:configure") && !awaiting("provider:get");
    }
    bool readsSettled() const {
        for (const auto &command : {"persona:get", "persona:list", "provider:get", "chat:history", "archive:get"})
            if (awaiting(command))
                return false;
        return s->state().contains("persona") && s->state().contains("personas") &&
               s->state().contains("archive") && !s->personaChanging() && !s->busy();
    }
    QVariantList profiles() const { return s->state().value("personas").toMap().value("profiles").toList(); }
    QString activePersona() const {
        for (const auto &value : profiles())
            if (value.toMap().value("active").toBool())
                return value.toMap().value("id").toString();
        return {};
    }
    QVariantList messageIds() const {
        QVariantList ids;
        for (const auto &message : s->messages())
            ids.append(message.toMap().value("id"));
        return ids;
    }
    QVariantMap backup() const { return s->memoryFeedback().value("backup").toMap(); }
    qulonglong deliveryCount() {
        bool valid = false;
        const auto count = key().value("deliveryCount").toULongLong(&valid);
        require(key().contains("deliveryCount") && valid, "PROVIDER_DELIVERY_COUNT_MISSING");
        return count;
    }
    void requireCurrentKey(const QString &persona, const QString &code) {
        const auto identity = s->state().value("persona").toMap();
        const auto expectedId = persona == "default" ? defaultPersonaId : persona;
        require(readsSettled() && keySettled() && s->runtimeWritable() && s->recoveryState() == "clean" &&
                    activePersona() == persona && !expectedId.isEmpty() && identity.value("persona_id") == expectedId &&
                    (persona != "default" || identity.value("persona_fingerprint") == defaultFingerprint) &&
                    provider().value("provider") == "ollama" && provider().value("base_url") == fixture.endpointA &&
                    provider().value("model") == model && key().value("stored").toBool() &&
                    key().value("matches").toBool() && key().value("applied").toBool() && key().value("reason") == "save",
                code);
    }
    void recordResend(const QString &stage) {
        const auto after = deliveryCount();
        require(after > deliveryBefore, "PROVIDER_KEY_NOT_REDELIVERED:" + stage);
        resends.append(QVariantMap{{"stage", stage}, {"before", deliveryBefore}, {"after", after},
                                  {"profileId", activePersona()},
                                  {"personaId", s->state().value("persona").toMap().value("persona_id")}});
        observed["resends"] = resends;
    }
    // Key state as metadata only: the key itself never enters a report.
    QVariantMap keyMetadata() const {
        const auto k = key();
        return {{"stored", k.value("stored")}, {"matches", k.value("matches")}, {"applied", k.value("applied")},
                {"reason", k.value("reason")}, {"deliveryCount", k.value("deliveryCount")}};
    }
    bool delivered(const QString &chat) {
        require(clock.elapsed() - at < 60000, "PROVIDER_CHAT_TIMEOUT");
        if (s->busy() || awaiting("chat:history") || awaiting("chat:send"))
            return false;
        QString request;
        for (const auto &value : s->messages())
            if (value.toMap().value("role") == "user" && value.toMap().value("content") == chat)
                request = value.toMap().value("request_id").toString();
        if (request.isEmpty())
            return false;
        for (const auto &value : s->messages())
            if (value.toMap().value("role") == "assistant" && value.toMap().value("request_id") == request)
                return true;
        return false;
    }
    void requireFeedback(const QString &status, const QString &expected, const QString &code) {
        require(feedbackStatus() == status && s->providerFeedback().value("text").toString() == expected,
                code + ":" + s->providerFeedback().value("text").toString());
        require(text("providerFeedbackText") == expected && fullyInView("providerFeedbackText"),
                code + "_NOT_VISIBLE");
    }
    void requireKeyStatus(const QString &expected, const QString &code) {
        require(text("providerKeyStatus") == expected && fullyInView("providerKeyStatus"), code + ":" + text("providerKeyStatus"));
    }
    void record(const QString &name) {
        cases.append(QVariantMap{{"name", name}, {"passed", true}, {"key", keyMetadata()}});
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        observed["account"] = s->diagnostics().value("providerKeyAccount");
        auto callback = std::move(done);
        if (callback)
            callback({{"passed", passed},
                      {"error", error},
                      {"mode", restart ? "restart-use-and-delete" : "save-move-and-return"},
                      {"step", step},
                      {"elapsedMs", clock.elapsed()},
                      {"checks", cases},
                      {"observed", observed},
                      {"readiness", readiness},
                      {"readinessCurrent", gate.metadata()},
                      {"readinessPollIntervalMs", timer.interval()},
                      {"inputMethodScope", "synthetic QInputMethodEvent commits, not physical OS IME acceptance"}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < (restart ? 60000 : 120000), "PROVIDER_CREDENTIAL_TIMEOUT");
        if (restart)
            useAndDelete();
        else
            saveMoveAndReturn();
    }
    // Opens the service page, then runs `action` once its endpoint field can take input.
    bool openService(int from) {
        if (step == from) {
            click("nav-settings");
            next(from + 1);
            return false;
        }
        if (step == from + 1 && settingsOpen() &&
            whenReady("settingsTab-service", settingsOpen(), [this] { click("settingsTab-service"); })) {
            next(from + 2);
            return false;
        }
        return step == from + 2;
    }
    // Tests the typed endpoint (and key), then saves once the test passed.
    bool testAndSave(int from, const QString &endpoint, const QString &apiKey) {
        if (step == from && whenReady("providerEndpoint", settingsOpen(), [this, endpoint, apiKey] {
                type("providerEndpoint", endpoint);
                type("providerModel", model);
                if (!apiKey.isEmpty()) {
                    type("providerApiKey", apiKey);
                    auto *field = find(w->contentItem(), "providerApiKey");
                    const auto shown = field->property("displayText").toString();
                    require(field->property("echoMode").toInt() == 2 && shown.size() == apiKey.size() &&
                                !shown.contains(apiKey.right(8)),
                            "PROVIDER_KEY_FIELD_NOT_MASKED");
                } else {
                    require(text("providerApiKey").isEmpty(), "PROVIDER_KEY_FIELD_NOT_EMPTY");
                }
                click("testProvider");
            })) {
            next(from + 1);
            return false;
        }
        if (step == from + 1 && feedbackStatus() != "testing") {
            require(feedbackStatus() == "ready" && s->state().value("providerTestReady").toBool(),
                    "PROVIDER_TEST_NOT_PASSED:" + s->providerFeedback().value("text").toString());
            next(from + 2);
            return false;
        }
        if (step == from + 2 && whenReady("saveProvider", settingsOpen(), [this] { click("saveProvider"); })) {
            next(from + 3);
            return false;
        }
        return step == from + 3 && keySettled() && feedbackStatus() != "saving";
    }
    // Closes the active surface, sends one chat and waits for its reply in history.
    bool chat(int from, const QString &message, const QString &closeControl = "settings-close") {
        if (step == from) {
            click(closeControl);
            next(from + 1);
            return false;
        }
        if (step == from + 1 && surfacesClosed()) {
            click("nav-chat");
            next(from + 2);
            return false;
        }
        if (step == from + 2 && whenReady("chatComposer", surfacesClosed(), [this, message] {
                type("chatComposer", message);
                click("sendChat");
                // A settled service and key never hold an ordinary chat back.
                require(s->chatFeedback().value("status") == "queued" && s->chatSendGate().isEmpty(),
                        "PROVIDER_CHAT_HELD_BY_SEND_GATE:" + s->chatFeedback().value("status").toString());
            })) {
            next(from + 3);
            return false;
        }
        return step == from + 3 && delivered(message);
    }
    void saveMoveAndReturn() {
        if (openService(0)) {
            if (!whenReady("providerKind", settingsOpen(), [this] {
                    require(provider().value("provider") == "ollama" && provider().value("base_url") == fixture.endpointA,
                            "PROVIDER_STARTING_CONFIGURATION_UNEXPECTED");
                    require(key().value("available").toBool() && !key().value("stored").toBool(),
                            "PROVIDER_KEY_STORE_NOT_EMPTY_AT_START");
                    requireKeyStatus("没有保存的密钥。", "PROVIDER_KEY_STATUS_AT_START");
                    require(!find(w->contentItem(), "clearProviderKey"), "PROVIDER_CLEAR_SHOWN_WITHOUT_KEY");
                    // A cloud service shows its fixed-address state; nothing is tested or sent.
                    commandsBefore = commands();
                    arrow("providerKind", Qt::Key_Down, 2);
                }))
                return;
            next(3);
            return;
        }
        if (step == 3 && clock.elapsed() - at > 150) {
            auto *kind = find(w->contentItem(), "providerKind");
            require(kind && kind->property("currentValue").toString() == "openai" &&
                        !find(w->contentItem(), "providerEndpoint") &&
                        text("providerCloudNotice").startsWith("地址由服务商固定。") &&
                        find(w->contentItem(), "providerApiKey")->property("placeholderText").toString() == "API Key" &&
                        !s->state().value("providerTestReady").toBool() && commands() == commandsBefore,
                    "PROVIDER_CLOUD_SELECTION_NOT_SHOWN_OR_SENT");
            record("cloud-service-shows-fixed-address-and-sends-nothing");
            w->grabWindow().save(capturePrefix + ".provider-cloud.png");
            arrow("providerKind", Qt::Key_Up, 2);
            next(4);
            return;
        }
        if (step == 4 && clock.elapsed() - at > 150) {
            auto *kind = find(w->contentItem(), "providerKind");
            require(kind && kind->property("currentValue").toString() == "ollama" &&
                        find(w->contentItem(), "providerEndpoint") && !find(w->contentItem(), "providerCloudNotice") &&
                        commands() == commandsBefore,
                    "PROVIDER_LOCAL_SELECTION_NOT_RESTORED");
            next(5);
            return;
        }
        if (testAndSave(5, fixture.endpointA, fixture.apiKey)) {
            requireFeedback("saved", "回复服务已保存并应用；密钥已存入本机钥匙串。", "PROVIDER_KEY_NOT_SAVED");
            require(key().value("stored").toBool() && key().value("matches").toBool() &&
                        key().value("applied").toBool() && key().value("reason") == "save" &&
                        provider().value("base_url") == fixture.endpointA && text("providerApiKey").isEmpty() &&
                        find(w->contentItem(), "clearProviderKey"),
                    "PROVIDER_KEY_NOT_STORED_AND_SENT");
            requireKeyStatus("密钥已保存在本机钥匙串，当前服务正在使用。", "PROVIDER_KEY_STATUS_AFTER_SAVE");
            record("tested-key-saved-to-keychain-and-sent");
            w->grabWindow().save(capturePrefix + ".provider-key-saved.png");
            next(10);
            return;
        }
        if (chat(10, chatSaved)) {
            record("chat-with-saved-key-delivered");
            next(20);
            return;
        }
        if (openService(20)) {
            require(find(w->contentItem(), "providerApiKey")->property("placeholderText").toString() ==
                        "已保存密钥；留空则继续使用",
                    "PROVIDER_SAVED_KEY_HINT_MISSING");
            next(23);
            return;
        }
        // Another endpoint: the saved key belongs to the first one and is never sent here.
        if (testAndSave(23, fixture.endpointB, {})) {
            requireFeedback("saved", "回复服务已保存并应用。", "PROVIDER_OTHER_ENDPOINT_NOT_SAVED");
            require(provider().value("base_url") == fixture.endpointB && key().value("stored").toBool() &&
                        !key().value("matches").toBool() && !key().value("applied").toBool(),
                    "PROVIDER_KEY_FOLLOWED_ANOTHER_ENDPOINT");
            requireKeyStatus("已保存的密钥属于其他服务或地址，当前服务不会使用它；需要时请重新输入。",
                             "PROVIDER_KEY_STATUS_OTHER_ENDPOINT");
            record("key-not-used-for-another-endpoint");
            w->grabWindow().save(capturePrefix + ".provider-key-other-endpoint.png");
            next(30);
            return;
        }
        if (chat(30, chatOtherEndpoint)) {
            record("chat-on-other-endpoint-delivered");
            next(40);
            return;
        }
        if (openService(40)) {
            next(43);
            return;
        }
        // Back to the first endpoint without typing: its own key is sent again after the save.
        if (testAndSave(43, fixture.endpointA, {})) {
            requireFeedback("saved", "回复服务已保存并应用。", "PROVIDER_RETURN_NOT_SAVED");
            require(provider().value("base_url") == fixture.endpointA && key().value("matches").toBool() &&
                        key().value("applied").toBool() && key().value("reason") == "save",
                    "PROVIDER_KEY_NOT_SENT_ON_RETURN");
            requireKeyStatus("密钥已保存在本机钥匙串，当前服务正在使用。", "PROVIDER_KEY_STATUS_ON_RETURN");
            record("key-sent-again-on-return-to-its-endpoint");
            next(50);
            return;
        }
        if (chat(50, chatBack)) {
            record("chat-after-return-delivered");
            next(60);
            return;
        }
        restoreImportAndReturn();
    }
    void restoreImportAndReturn() {
        if (step == 60) {
            click("nav-memory");
            next(61);
            return;
        }
        if (step == 61) {
            if (find(w->contentItem(), "memoryPage")) {
                next(62);
                return;
            }
            if (whenReady("archive-open-memories", surfaceOpen("drawer-memory"),
                          [this] { click("archive-open-memories"); }))
                next(62);
            return;
        }
        if (step == 62) {
            if (whenReady("memoryTab-backup", surfaceOpen("drawer-memory"), [this] { click("memoryTab-backup"); }))
                next(63);
            return;
        }
        if (step == 63) {
            if (whenReady("backupExport", surfaceOpen("drawer-memory") && readsSettled() && keySettled(), [this] {
                    const auto identity = s->state().value("persona").toMap();
                    defaultPersonaId = identity.value("persona_id").toString();
                    defaultFingerprint = identity.value("persona_fingerprint").toString();
                    require(!defaultPersonaId.isEmpty() &&
                                QRegularExpression("^[0-9a-f]{64}$").match(defaultFingerprint).hasMatch(),
                            "PROVIDER_DEFAULT_IDENTITY_UNAVAILABLE");
                    observed["defaultPersonaId"] = defaultPersonaId;
                    requireCurrentKey("default", "PROVIDER_RESTORE_BASELINE_INVALID");
                    require(profiles().size() == 1, "PROVIDER_INITIAL_PERSONAS_UNEXPECTED");
                    defaultScope = s->scopeKey();
                    restoreGeneration = s->generation();
                    defaultMessageIds = messageIds();
                    // Only the file chooser is replaced with the registered path.
                    s->exportBackup(QUrl::fromLocalFile(s->dataRoot() + "/" + fixture.backupFile));
                    require(backup().value("status") == "pending", "PROVIDER_BACKUP_EXPORT_NOT_SENT");
                }))
                next(64);
            return;
        }
        if (step == 64 && backup().value("status") != "pending") {
            require(backup().value("status") == "success", "PROVIDER_BACKUP_EXPORT_FAILED");
            QFile file(s->dataRoot() + "/" + fixture.backupFile);
            require(file.open(QIODevice::ReadOnly) && file.size() > 0 && file.size() <= 64 * 1024 * 1024,
                    "PROVIDER_BACKUP_EXPORT_FILE_MISSING_OR_TOO_LARGE");
            const auto document = QJsonDocument::fromJson(file.readAll());
            const auto identity = document.object().value("persona_identity").toObject();
            require(document.isObject() && document.object().value("schema") == "reverie.full_local_backup.v3" &&
                        identity.value("persona_id") == defaultPersonaId && identity.value("fingerprint") == defaultFingerprint,
                    "PROVIDER_BACKUP_EXPORT_IDENTITY_INVALID");
            observed["backupFile"] = fixture.backupFile;
            record("backup-exported-for-key-resend-check");
            next(65);
            return;
        }
        if (step == 65) {
            if (whenReady("backupChoose", surfaceOpen("drawer-memory") && readsSettled() && keySettled(), [this] {
                    requireCurrentKey("default", "PROVIDER_BEFORE_RESTORE_KEY_INVALID");
                    deliveryBefore = deliveryCount();
                    s->chooseBackupForRestore(QUrl::fromLocalFile(s->dataRoot() + "/" + fixture.backupFile));
                    require(backup().value("status") == "pending" && !s->state().contains("backupRestore"),
                            "PROVIDER_BACKUP_INSPECTION_NOT_SENT");
                }))
                next(66);
            return;
        }
        if (step == 66 && backup().value("status") != "pending") {
            require(backup().value("status") == "confirmation", "PROVIDER_BACKUP_INSPECTION_NOT_CONFIRMED");
            next(67);
            return;
        }
        if (step == 67) {
            if (whenReady("backupRestoreConfirm", readsSettled() && keySettled(), [this] {
                    require(find(w->contentItem(), "backupRestoreConfirmation") && s->scopeKey() == defaultScope &&
                                s->generation() == restoreGeneration && deliveryCount() == deliveryBefore &&
                                s->state().value("backupRestore").toMap().value("fileName") == fixture.backupFile &&
                                s->state().value("backupRestore").toMap().value("mode") == "normal",
                            "PROVIDER_RESTORE_CHANGED_BEFORE_CONFIRMATION");
                    w->grabWindow().save(capturePrefix + ".provider-restore-confirm.png");
                    click("backupRestoreConfirm");
                    require(s->backupRestoring() && !s->runtimeWritable(), "PROVIDER_RESTORE_CONFIRM_NOT_SENT");
                }))
                next(68);
            return;
        }
        if (step == 68 && backup().value("status") != "pending" && !s->backupRestoring() && readsSettled() && keySettled()) {
            require(backup().value("status") == "success", "PROVIDER_RESTORE_NOT_CONFIRMED");
            requireCurrentKey("default", "PROVIDER_KEY_INVALID_AFTER_RESTORE");
            require(s->scopeKey() == defaultScope && s->generation() == restoreGeneration && messageIds() == defaultMessageIds,
                    "PROVIDER_RESTORE_IDENTITY_OR_HISTORY_CHANGED");
            recordResend("restore");
            record("key-sent-again-after-confirmed-restore");
            w->grabWindow().save(capturePrefix + ".provider-restored.png");
            next(70);
            return;
        }
        if (chat(70, chatRestored, "memory-close")) {
            record("chat-after-restore-delivered");
            defaultMessageIds = messageIds();
            next(80);
            return;
        }
        if (step == 80) {
            click("nav-character");
            next(81);
            return;
        }
        if (step == 81) {
            reveal(named(w->contentItem(), "personaImportCard"));
            if (whenReady("personaImportCard", surfaceOpen("taskSurface") && readsSettled() && keySettled(), [this] {
                    requireCurrentKey("default", "PROVIDER_BEFORE_IMPORT_KEY_INVALID");
                    require(messageIds() == defaultMessageIds, "PROVIDER_DEFAULT_HISTORY_CHANGED_BEFORE_IMPORT");
                    deliveryBefore = deliveryCount();
                    s->choosePersonaCard(QUrl::fromLocalFile(s->dataRoot() + "/" + fixture.cardFile));
                }))
                next(82);
            return;
        }
        if (step == 82) {
            require(s->personaCardFeedback().value("status") == "confirmation", "PROVIDER_CARD_PREVIEW_FAILED");
            next(83);
            return;
        }
        if (step == 83) {
            if (whenReady("personaImportConfirm", readsSettled() && keySettled(), [this] {
                    const auto candidate = s->personaCardCandidate();
                    importedPersona = candidate.value("targetId").toString();
                    require(find(w->contentItem(), "personaImportConfirmationContent") &&
                                text("personaImportFilename") == fixture.cardFile && candidate.value("name") == cardName &&
                                candidate.value("sourceFormat") == "json" && !importedPersona.isEmpty() &&
                                s->scopeKey() == defaultScope && activePersona() == "default" &&
                                deliveryCount() == deliveryBefore,
                            "PROVIDER_CARD_PREVIEW_OR_CONFIRMATION_INVALID");
                    w->grabWindow().save(capturePrefix + ".provider-import-confirm.png");
                    click("personaImportConfirm");
                    importRequest = s->personaCardFeedback().value("requestId").toString();
                    require(s->personaCardFeedback().value("status") == "pending" && !importRequest.isEmpty(),
                            "PROVIDER_CARD_IMPORT_CONFIRM_NOT_SENT");
                }))
                next(84);
            return;
        }
        if (step == 84 && s->personaCardFeedback().value("status") != "pending") {
            require(s->personaCardFeedback().value("status") == "success" &&
                        s->personaCardFeedback().value("requestId") == importRequest && s->scopeKey() != defaultScope,
                    "PROVIDER_CARD_IMPORT_NOT_CONFIRMED");
            importedScope = s->scopeKey();
            next(85);
            return;
        }
        if (step == 85 && readsSettled() && keySettled()) {
            requireCurrentKey(importedPersona, "PROVIDER_KEY_INVALID_AFTER_IMPORT");
            require(profiles().size() == 2 && s->scopeKey() == importedScope &&
                        s->state().value("archive").toMap().value("persona_id") == importedPersona &&
                        find(w->contentItem(), "personaActive-" + importedPersona),
                    "PROVIDER_IMPORTED_PERSONA_NOT_READ_BACK");
            for (const auto &id : messageIds())
                require(!defaultMessageIds.contains(id), "PROVIDER_IMPORT_RETAINED_DEFAULT_HISTORY");
            recordResend("card-import");
            observed["cardImport"] = QVariantMap{{"fileName", fixture.cardFile}, {"sourceFormat", "json"},
                                                 {"requestId", importRequest}, {"personaId", importedPersona},
                                                 {"profiles", profiles().size()}, {"systemFilePickerCovered", false}};
            record("key-sent-again-after-confirmed-card-import");
            w->grabWindow().save(capturePrefix + ".provider-imported.png");
            next(90);
            return;
        }
        if (chat(90, chatImported, "character-close")) {
            record("chat-on-imported-persona-delivered");
            next(100);
            return;
        }
        if (step == 100) {
            click("nav-character");
            next(101);
            return;
        }
        if (step == 101) {
            reveal(named(w->contentItem(), "personaSwitch-default"));
            if (whenReady("personaSwitch-default", surfaceOpen("taskSurface") && readsSettled() && keySettled(), [this] {
                    requireCurrentKey(importedPersona, "PROVIDER_BEFORE_PERSONA_RETURN_KEY_INVALID");
                    deliveryBefore = deliveryCount();
                    click("personaSwitch-default");
                }))
                next(102);
            return;
        }
        if (step == 102) {
            if (whenReady("personaSwitchConfirm", readsSettled() && keySettled(), [this] {
                    require(find(w->contentItem(), "personaSwitchConfirmation") && s->scopeKey() == importedScope &&
                                activePersona() == importedPersona && deliveryCount() == deliveryBefore,
                            "PROVIDER_PERSONA_CHANGED_BEFORE_CONFIRMATION");
                    w->grabWindow().save(capturePrefix + ".provider-return-confirm.png");
                    click("personaSwitchConfirm");
                    returnRequest = s->personaFeedback().value("requestId").toString();
                    require(s->personaFeedback().value("status") == "pending" && !returnRequest.isEmpty(),
                            "PROVIDER_PERSONA_RETURN_CONFIRM_NOT_SENT");
                }))
                next(103);
            return;
        }
        if (step == 103 && s->personaFeedback().value("status") != "pending") {
            require(s->personaFeedback().value("status") == "success" &&
                        s->personaFeedback().value("requestId") == returnRequest && s->scopeKey() != importedScope,
                    "PROVIDER_PERSONA_RETURN_NOT_CONFIRMED");
            next(104);
            return;
        }
        if (step == 104 && readsSettled() && keySettled()) {
            requireCurrentKey("default", "PROVIDER_KEY_INVALID_AFTER_PERSONA_RETURN");
            require(profiles().size() == 2 && messageIds() == defaultMessageIds &&
                        find(w->contentItem(), "personaActive-default"),
                    "PROVIDER_PERSONA_RETURN_CHANGED_DEFAULT_HISTORY");
            recordResend("persona-return");
            observed["returnedToDefault"] = true;
            record("key-sent-again-after-confirmed-persona-return");
            w->grabWindow().save(capturePrefix + ".provider-returned.png");
            next(105);
            return;
        }
        if (step == 105 && whenReady("character-close", surfaceOpen("taskSurface"), [this] { click("character-close"); }))
            next(106);
        if (step == 106 && surfacesClosed())
            finish(true);
    }
    void useAndDelete() {
        if (step == 0) {
            if (!keySettled())
                return;
            // Nothing in this process tested or saved a service before this point.
            require(provider().value("provider") == "ollama" && provider().value("base_url") == fixture.endpointA &&
                        key().value("stored").toBool() && key().value("matches").toBool() &&
                        key().value("applied").toBool() && key().value("reason") == "startup",
                    "PROVIDER_KEY_NOT_SENT_AT_STARTUP");
            // The history this restart starts from; the driver compares it with the first cycle's.
            QVariantList ids;
            for (const auto &message : s->messages())
                ids.append(message.toMap().value("id"));
            observed["startupMessageIds"] = ids;
            record("saved-key-sent-at-startup");
            next(1);
            return;
        }
        if (openService(1)) {
            if (!whenReady("providerKeyStatus", settingsOpen(), [this] {
                    requireKeyStatus("密钥已保存在本机钥匙串，当前服务正在使用。", "PROVIDER_KEY_STATUS_AFTER_RESTART");
                    require(text("providerApiKey").isEmpty() &&
                                find(w->contentItem(), "providerApiKey")->property("placeholderText").toString() ==
                                    "已保存密钥；留空则继续使用",
                            "PROVIDER_KEY_FIELD_AFTER_RESTART");
                    w->grabWindow().save(capturePrefix + ".provider-key-after-restart.png");
                }))
                return;
            next(4);
            return;
        }
        if (chat(4, chatAfterRestart)) {
            record("chat-with-key-from-keychain-delivered");
            next(10);
            return;
        }
        if (openService(10)) {
            next(13);
            return;
        }
        // Its own endpoint without typing a key: the test uses the saved key and passes.
        if (step == 13 && whenReady("testProvider", settingsOpen() && keySettled(), [this] {
                type("providerEndpoint", fixture.endpointA);
                type("providerModel", model);
                require(text("providerApiKey").isEmpty(), "PROVIDER_KEY_FIELD_NOT_EMPTY");
                click("testProvider");
            })) {
            next(14);
            return;
        }
        if (step == 14 && feedbackStatus() != "testing") {
            require(feedbackStatus() == "ready" && s->state().value("providerTestReady").toBool() &&
                        find(w->contentItem(), "saveProvider") && find(w->contentItem(), "saveProvider")->isEnabled(),
                    "PROVIDER_SAVED_KEY_TEST_NOT_PASSED:" + s->providerFeedback().value("text").toString());
            record("saved-key-test-passed-before-delete");
            next(15);
            return;
        }
        if (step == 15 && whenReady("clearProviderKey", settingsOpen(), [this] { click("clearProviderKey"); })) {
            next(16);
            return;
        }
        if (step == 16 && keySettled()) {
            requireFeedback("saved", "已删除保存的密钥，本地服务也已停用它；之前的连接测试已作废，请重新测试后保存。",
                            "PROVIDER_KEY_NOT_DELETED");
            require(!key().value("stored").toBool() && !key().value("applied").toBool() &&
                        !find(w->contentItem(), "clearProviderKey"),
                    "PROVIDER_KEY_STILL_STORED");
            // A confirmed stop leaves nothing to verify and no retry control.
            require(key().contains("clearState") && key().value("clearState").toString().isEmpty() &&
                        !find(w->contentItem(), "providerKeyRetryClear"),
                    "PROVIDER_KEY_STOP_NOT_SETTLED");
            observed["clearStateAfterDelete"] = key().value("clearState");
            requireKeyStatus("没有保存的密钥。", "PROVIDER_KEY_STATUS_AFTER_DELETE");
            record("key-deleted-from-keychain-and-service");
            w->grabWindow().save(capturePrefix + ".provider-key-deleted.png");
            next(17);
            return;
        }
        // The voided test leaves the save control unavailable; a pointer press on it sends nothing.
        if (step == 17) {
            auto *save = find(w->contentItem(), "saveProvider");
            require(save && fullyInView("saveProvider") && !save->isEnabled() &&
                        !s->state().value("providerTestReady").toBool(),
                    "PROVIDER_SAVE_AVAILABLE_AFTER_DELETE");
            const auto before = s->providerFeedback();
            const auto service = provider();
            const auto p = save->mapToScene(QPointF(save->width() / 2, save->height() / 2));
            QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint(), 0);
            // A configure would be pending at once: saveProvider sends synchronously.
            require(!awaiting("provider:configure") && s->providerFeedback() == before && provider() == service,
                    "PROVIDER_SAVE_SENT_AFTER_DELETE");
            observed["voidedTestSave"] = QVariantMap{{"saveEnabled", false}, {"configureSent", false},
                                                    {"testReady", false}};
            record("delete-voided-earlier-test-and-save-sends-nothing");
            next(20);
            return;
        }
        if (chat(20, chatDeleted)) {
            record("chat-after-delete-delivered");
            finish(true);
        }
    }
};
} // namespace
ProviderCredentialCheck::Fixture ProviderCredentialCheck::readFixture(const QString &context,
                                                                      const QString &endpointA) {
    QFile file(context);
    if (!file.open(QIODevice::ReadOnly) || file.size() > 16384)
        throw std::runtime_error("PROVIDER_FIXTURE_CONTEXT_UNAVAILABLE");
    const auto value = QJsonDocument::fromJson(file.readAll()).object().value("p1_provider").toObject();
    Fixture fixture{value.value("apiKey").toString(), value.value("endpointA").toString(),
                    value.value("endpointB").toString(), value.value("backupFile").toString(),
                    value.value("cardFile").toString()};
    static const QRegularExpression syntheticKey("^sk-reverie-test-[0-9a-f]{48}$");
    if (value.keys() != QStringList{"apiKey", "backupFile", "cardFile", "endpointA", "endpointB"} ||
        !syntheticKey.match(fixture.apiKey).hasMatch() || fixture.endpointA != endpointA ||
        !loopbackEndpoint(QUrl(fixture.endpointA)) || !loopbackEndpoint(QUrl(fixture.endpointB)) ||
        fixture.endpointA == fixture.endpointB || fixture.backupFile != "p1-provider-backup.json" ||
        fixture.cardFile != "p1-provider-card.json")
        throw std::runtime_error("PROVIDER_FIXTURE_NOT_REGISTERED");
    return fixture;
}
void ProviderCredentialCheck::run(QQuickWindow *w, RuntimeBridge *s, bool restart, const Fixture &fixture,
                                  const QString &capturePrefix, std::function<void(QVariantMap)> done) {
    new Check(w, s, restart, fixture, capturePrefix, std::move(done));
}
