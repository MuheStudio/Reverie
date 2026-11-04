#include "../src/RuntimeBridge.h"
#include "../src/ArchiveEditor.h"
#include "../src/PersonaCardReader.h"
#include "../src/Keychain.h"
#include <QCryptographicHash>
#include <QDate>
#include <QFile>
#include <QUrl>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QtEndian>
#include <QtTest>
#include <cmath>
#include <memory>
#include <optional>

// Exercise the production event dispatcher without starting its process, avatar
// helper, application window or Keychain path. Every constructor read is confined
// to a fresh temporary directory; pending entries stand in for dispatched frames.
class RuntimeBridgeTest : public QObject {
    Q_OBJECT

    static void activeChat(RuntimeBridge &bridge) {
        bridge.m_frameWriter = [](const QByteArray &frame) { return frame.size(); };
        bridge.m_connected = true;
        bridge.m_runtimeWritable = true;
        bridge.m_recoveryState = "clean";
        bridge.m_generation = 7;
        bridge.m_chatId = "chat-current";
        bridge.m_chatGeneration = bridge.m_generation;
        bridge.m_chatPersona = bridge.m_persona;
        bridge.m_busy = true;
        bridge.m_notice = "正在倾听…";
        pending(bridge, bridge.m_chatId, "chat:send", bridge.m_generation);
    }
    static void online(RuntimeBridge &bridge) {
        bridge.m_frameWriter = [](const QByteArray &frame) { return frame.size(); };
        bridge.m_connected = true;
        bridge.m_runtimeWritable = true;
        bridge.m_recoveryState = "clean";
        bridge.m_generation = 7;
        bridge.m_persona = {{"persona_id", "persona-current"}, {"epoch", 3},
                            {"fingerprint", "fingerprint-current"}};
        bridge.m_networkFeedback = {{"status", "allowed"}, {"known", true}, {"active", false}};
    }
    static QString controlId(const RuntimeBridge &bridge, const QString &command) {
        for (auto it = bridge.m_pending.cbegin(); it != bridge.m_pending.cend(); ++it)
            if (it->command == command)
                return it.key();
        return {};
    }
    static int pendingCount(const RuntimeBridge &bridge, const QString &command) {
        int count = 0;
        for (const auto &p : bridge.m_pending)
            count += p.command == command;
        return count;
    }
    static QString currentPermissionId(const RuntimeBridge &bridge) {
        for (auto it = bridge.m_pending.cbegin(); it != bridge.m_pending.cend(); ++it)
            if (it->command == "ai_usage:get" &&
                it->permissionContextEpoch == bridge.m_permissionContextEpoch &&
                it->permissionSequence == bridge.m_permissionSequence)
                return it.key();
        return {};
    }
    static QJsonObject permissions(const QString &origin, bool allowed = false,
                                   const QString &digest = "digest-current") {
        const auto endpoint = origin.startsWith("http") ? origin : "https://" + origin + ".test";
        return {{"schema", "reverie.ai-usage-consent.v2"}, {"default", "denied"},
                {"features", QJsonObject{{"summary", QJsonObject{{"enabled", allowed},
                     {"effective", allowed}, {"api_cost_acknowledged", allowed},
                     {"description", "Controlled optional AI feature"},
                     {"current_provider", "ollama"}, {"current_origin", endpoint},
                     {"provider", allowed ? QString("ollama") : QString()},
                     {"origin", allowed ? endpoint : QString()}, {"consent_digest", digest}}}}}};
    }
    static QJsonObject provider(const QString &model) {
        return {{"provider", "ollama"}, {"model", model},
                {"base_url", "http://127.0.0.1:11434"}};
    }
    static void knownPermissions(RuntimeBridge &bridge, const QJsonObject &snapshot) {
        const auto id = bridge.request("ai_usage:get");
        bridge.event(frame("ai_usage:result", id, snapshot));
        QVERIFY(bridge.permissionsKnown());
    }
    static QJsonObject controlResult(const QString &id, const QString &command,
                                     QJsonObject fields = {}) {
        fields["kind"] = "control_result";
        fields["schema"] = "reverie.bridge.stdio.control.v4";
        fields["requestId"] = id;
        fields["type"] = command;
        return fields;
    }
    static void pending(RuntimeBridge &bridge, const QString &id, const QString &command,
                        int generation) {
        bridge.m_pending.insert(id, {command, generation, {}});
    }
    static QVariantMap memoryReceipt(const RuntimeBridge &bridge, const QString &key) {
        return bridge.memoryFeedback().value(key).toMap();
    }
    static QVariantMap settingsReceipt(const RuntimeBridge &bridge, const QString &key) {
        return bridge.settingsFeedback().value(key).toMap();
    }
    static QJsonObject summaryDirectoryRow(char token = 'a', int first = 1) {
        return {{"summary_id", "summary_" + QString(32, QLatin1Char(token))},
            {"sourceDigest", QString(64, QLatin1Char(token))}, {"firstSequence", first},
            {"lastSequence", first + 1}, {"messageIds", QJsonArray{
                QString("summary-source-%1-user").arg(QLatin1Char(token)),
                QString("summary-source-%1-assistant").arg(QLatin1Char(token))}},
            {"contractVersion", "reverie.conversation-summary.v1"}};
    }
    static QJsonObject summaryDirectoryPayload(const RuntimeBridge &bridge,
                                               const QJsonArray &rows) {
        auto payload = personaScope(bridge);
        const QJsonObject fields{{"ok", true}, {"operation", "status"}, {"conversation_id", "dream-room"},
            {"status", "ready"}, {"enabled", true}, {"summaries", rows},
            {"summaryTotal", int(rows.size())}, {"hasMore", false}, {"activeCount", int(rows.size())}};
        for (auto it = fields.begin(); it != fields.end(); ++it)
            payload[it.key()] = it.value();
        return payload;
    }
    static void knownSummaryDirectory(RuntimeBridge &bridge,
                                       const QJsonArray &rows = QJsonArray{summaryDirectoryRow()}) {
        bridge.refreshSummaryDirectory();
        const auto id = bridge.m_summaryStatusReadId;
        QVERIFY(!id.isEmpty());
        bridge.event(frame("summary:result", id, summaryDirectoryPayload(bridge, rows)));
        QVERIFY(bridge.state().value("summary").toMap().value("directoryReady").toBool());
    }
    static QJsonObject summaryDetailPayload(const RuntimeBridge &bridge,
                                            QJsonObject row = summaryDirectoryRow(),
                                            const QString &text = "一段尚未核实的 AI 摘要。") {
        row["text"] = text;
        auto payload = personaScope(bridge);
        const QJsonObject fields{{"ok", true}, {"operation", "detail"}, {"conversation_id", "dream-room"},
            {"summary", row}};
        for (auto it = fields.begin(); it != fields.end(); ++it)
            payload[it.key()] = it.value();
        return payload;
    }
    static QString summaryDetailStatus(const RuntimeBridge &bridge) {
        return bridge.summaryDetailState().value("status").toString();
    }
    // The backend's to_dict always carries every UI field; age is null when unset.
    static QJsonObject userProfileSnapshot(char token = 'a', bool cleared = false,
                                           const QJsonObject &overrides = {}) {
        QJsonObject profile{{"name", "原名"}, {"nickname", cleared ? "" : "小星"},
            {"birthday", ""}, {"identity", ""}, {"schedule", ""},
            {"interests", cleared ? QJsonArray{} : QJsonArray{"观星", "摄影"}},
            {"hobbies", QJsonArray{}}, {"favorite_topics", QJsonArray{}},
            {"favorite_games", QJsonArray{}}, {"favorite_anime", QJsonArray{}},
            {"age", QJsonValue(QJsonValue::Null)},
            {"important_dates", QJsonObject{{"纪念日", "01-01"}}}};
        for (auto it = overrides.begin(); it != overrides.end(); ++it)
            profile[it.key()] = it.value();
        return {{"ok", true}, {"profile_snapshot", QString(64, QLatin1Char(token))},
            {"profile", profile}, {"emotional_memories", QJsonArray{"独立的情绪记忆"}}};
    }
    static void knownProfile(RuntimeBridge &bridge, const QJsonObject &snapshot = userProfileSnapshot()) {
        bridge.event(frame("user:profile:result", bridge.request("user:profile:get"), snapshot));
        QVERIFY(bridge.profileSnapshotKnown());
    }
    static QString profileClearStatus(const RuntimeBridge &bridge) {
        return bridge.profileClearState().value("status").toString();
    }
    static QString beginProfileClear(RuntimeBridge &bridge, const QStringList &fields = {"nickname", "interests"}) {
        bridge.proposeProfileClear();
        const auto proposal = bridge.profileClearState();
        bridge.confirmProfileClear(fields, proposal.value("scopeKey").toString(),
                                   proposal.value("profileSnapshot").toString());
        return bridge.profileClearState().value("requestId").toString();
    }
    static QJsonObject profileClearReceipt() {
        auto result = userProfileSnapshot('b', true);
        result["operation"] = "clear";
        result["cleared_fields"] = QJsonArray{"nickname", "interests"};
        return result;
    }
    static QJsonObject settingsSnapshot(int retention = 730, bool split = false) {
        return {{"ok", true},
                {"chat", QJsonObject{{"split_messages", split}, {"allow_environment_description", false}}},
                {"memory", QJsonObject{{"retention_days", retention}, {"forgetting_enabled", true},
                                       {"long_term_forgetting_enabled", true},
                                       {"short_term_forgetting_enabled", true}}},
                {"features", QJsonObject{{"personality_flaws_enabled", true},
                                         {"personality_flaws_disclaimer_acknowledged", false},
                                         {"user_selected_flaws", "路痴"}}}};
    }
    static void knownSettings(RuntimeBridge &bridge, const QJsonObject &snapshot = settingsSnapshot()) {
        bridge.event(frame("settings:get:result", bridge.request("settings:get"), snapshot));
        QVERIFY(bridge.settingsKnown());
    }
    static QJsonObject budgetRuntime(bool tracking = true, bool enforced = true,
                                      int requests = 60, int tokens = 30000) {
        return {{"tracking_enabled", tracking}, {"background_enforced", enforced},
            {"request_budget", requests}, {"token_budget", tokens}};
    }
    static QJsonObject budgetSettingsSnapshot(bool tracking = true, bool enforced = true,
                                               int requests = 60, int tokens = 30000) {
        auto snapshot = settingsSnapshot();
        auto features = snapshot["features"].toObject();
        features["api_budget_tracking_enabled"] = tracking;
        features["api_background_budget_enforced"] = enforced;
        features["api_background_daily_request_budget"] = requests;
        features["api_background_daily_token_budget"] = tokens;
        snapshot["features"] = features;
        snapshot["budgetRuntime"] = budgetRuntime(tracking, enforced, requests, tokens);
        return snapshot;
    }
    static QJsonObject budgetSnapshot(const RuntimeBridge &bridge, int requests = 2, int tokens = 900,
                                      int requestBudget = 60, int tokenBudget = 30000,
                                      bool tracking = true, bool enforced = true) {
        auto snapshot = personaScope(bridge);
        const QJsonObject fields{{"local_day", QDate::currentDate().toString(Qt::ISODate)},
            {"tracking_enabled", tracking}, {"background_enforced", enforced},
            {"requests", requests}, {"succeeded", requests}, {"failed", 0},
            {"prompt_tokens", 400}, {"completion_tokens", 100}, {"estimated_unreported_tokens", 400},
            {"background", QJsonObject{{"requests", requests}, {"tokens", tokens},
                {"request_budget", requestBudget}, {"token_budget", tokenBudget}}},
            {"by_purpose", QJsonArray{QJsonObject{{"purpose", "summary"}, {"requests", requests},
                {"measured_tokens", 500}}}}, {"currency_estimate", QJsonValue(QJsonValue::Null)},
            {"currency_note", "只报告请求数与 Token。"}};
        for (auto it = fields.begin(); it != fields.end(); ++it)
            snapshot[it.key()] = it.value();
        return snapshot;
    }
    static void knownBudget(RuntimeBridge &bridge) {
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge)));
        QVERIFY(bridge.budgetState().value("live").toBool());
    }
    static QJsonObject frame(const QString &type, const QString &id, const QJsonObject &payload) {
        return {{"type", type}, {"request_id", id}, {"payload", payload}};
    }
    static QJsonObject personaScope(const RuntimeBridge &bridge) {
        return {{"persona_id", bridge.m_persona["persona_id"]},
                {"persona_epoch", bridge.m_persona["epoch"]},
                {"persona_fingerprint", bridge.m_persona["fingerprint"]}};
    }
    static void personaList(RuntimeBridge &bridge, const QString &activeId) {
        const auto profile = [&](const QString &id, const QString &name, const QString &format) {
            return QJsonObject{{"id", id}, {"name", name}, {"source_format", format},
                               {"active", id == activeId}};
        };
        auto payload = personaScope(bridge);
        payload["ok"] = true;
        payload["active_id"] = activeId;
        payload["profiles"] = QJsonArray{profile("default", "星野幻月", "builtin"),
                                         profile("st_a", "测试角色", "chara_card_v2")};
        bridge.event(frame("persona:list:result", bridge.request("persona:list"), payload));
    }
    static QString personaStatus(const RuntimeBridge &bridge) {
        return bridge.personaFeedback().value("status").toString();
    }
    static QJsonObject nextIdentity(int epoch, bool restartRequired = false) {
        return {{"persona_id", QString("persona-%1").arg(epoch)}, {"persona_epoch", epoch},
                {"persona_fingerprint", QString("fingerprint-%1").arg(epoch)},
                {"restart_required", restartRequired}};
    }
    static QByteArray cardJson() {
        return R"({"name":"Local card","description":"A local untrusted card"})";
    }
    static QByteArray pngChunk(const QByteArray &type, const QByteArray &data) {
        QByteArray chunk(4, 0);
        qToBigEndian<quint32>(data.size(), chunk.data());
        chunk += type + data;
        quint32 crc = 0xffffffff;
        for (const auto byte : type + data) {
            crc ^= quint8(byte);
            for (int bit = 0; bit < 8; ++bit)
                crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
        }
        QByteArray checksum(4, 0);
        qToBigEndian<quint32>(crc ^ 0xffffffff, checksum.data());
        return chunk + checksum;
    }
    static QByteArray pngCard(const QByteArray &raw = cardJson(), const QByteArray &keyword = "chara",
                              bool direct = false) {
        return QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", keyword + '\0' + (direct ? raw : raw.toBase64())) + pngChunk("IEND", {});
    }
    static bool writeLocal(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size();
    }
    static QJsonObject importedScope(const RuntimeBridge &bridge) {
        return {{"persona_id", bridge.m_personaImport.value("targetId").toString()},
                {"persona_epoch", objForTest(bridge.m_personaImport.value("sourceProof").toMap())["epoch"].toInt() + 1},
                {"persona_fingerprint", "fingerprint-imported"},
                {"persona", QJsonObject{{"name", "Local card"}}}};
    }
    static QJsonObject objForTest(const QVariantMap &value) {
        return QJsonObject::fromVariantMap(value);
    }
    static QJsonObject importReceipt(const QJsonObject &scope) {
        auto receipt = scope;
        const QJsonObject fields{{"ok", true}, {"saved", true}, {"activated", true},
                        {"runtime_ready", true}, {"partial_write", false},
                        {"card_id", scope["persona_id"]}, {"name", "Local card"},
                        {"world_book_imported", true}, {"world_book_entry_count", 1},
                        {"ignored_fields", QJsonArray{"system_prompt"}},
                        {"warnings", QJsonArray{"卡作者提示词已隔离保存，默认不启用"}}};
        for (auto it = fields.begin(); it != fields.end(); ++it)
            receipt.insert(it.key(), it.value());
        return receipt;
    }
    static QJsonObject snapshot() {
        return {{"ok", true},
                {"exists", true},
                {"revision", 1},
                {"archive", QJsonObject{{"characters", QJsonArray{}},
                                        {"activeCharacterIds", QJsonArray{}},
                                        {"worldBooks", QJsonArray{}}}}};
    }
    static void checkResponse(const QSignalSpy &spy, const QString &id, const QString &command,
                              const QJsonObject &payload, int generation) {
        QCOMPARE(spy.count(), 1);
        const auto response = spy.at(0);
        QCOMPARE(response.at(0).toString(), id);
        QCOMPARE(response.at(1).toString(), command);
        QCOMPARE(response.at(2).toMap(), payload.toVariantMap());
        QCOMPARE(response.at(3).toInt(), generation);
    }

    // ---- Reply-service key: an in-memory store stands in for the Keychain.
    struct KeyStoreState {
        std::optional<StoredProviderKey> key;
        bool failRead = false, failWrite = false, failClear = false;
        // The delete takes effect but still reports a failure.
        bool clearReportsFailureAfterDeleting = false, failReadAfterClear = false;
        int writes = 0;
    };
    class FakeKeyStore final : public ProviderKeyStore {
      public:
        explicit FakeKeyStore(std::shared_ptr<KeyStoreState> state) : m_state(std::move(state)) {}
        std::optional<StoredProviderKey> read() override {
            if (m_state->failRead)
                throw std::runtime_error("read");
            return m_state->key;
        }
        void write(const StoredProviderKey &key) override {
            if (m_state->failWrite)
                throw std::runtime_error("write");
            m_state->key = key;
            ++m_state->writes;
        }
        void clear() override {
            if (m_state->failClear)
                throw std::runtime_error("clear");
            m_state->key.reset();
            if (m_state->clearReportsFailureAfterDeleting) {
                m_state->failRead = m_state->failReadAfterClear;
                throw std::runtime_error("clear");
            }
        }
        QString account() const override { return "fake-account"; }

      private:
        std::shared_ptr<KeyStoreState> m_state;
    };
    static std::shared_ptr<KeyStoreState> keyStore(RuntimeBridge &bridge,
                                                   std::optional<StoredProviderKey> saved = std::nullopt) {
        auto state = std::make_shared<KeyStoreState>();
        state->key = std::move(saved);
        bridge.setProviderKeyStore(std::make_unique<FakeKeyStore>(state));
        return state;
    }
    // The frames this bridge wrote, decoded; the test reads what a control actually carried.
    static std::shared_ptr<QList<QJsonObject>> sentFrames(RuntimeBridge &bridge) {
        auto frames = std::make_shared<QList<QJsonObject>>();
        bridge.m_frameWriter = [frames](const QByteArray &frame) {
            frames->append(QJsonDocument::fromJson(frame.mid(4)).object());
            return frame.size();
        };
        return frames;
    }
    static QJsonObject lastControl(const QList<QJsonObject> &frames, const QString &type) {
        for (auto it = frames.crbegin(); it != frames.crend(); ++it)
            if (it->value("kind") == "control" && it->value("type") == type)
                return *it;
        return {};
    }
    // Ordinary commands leave as renderer_command frames: the arguments are the
    // envelope's payload; "requestId" carries the envelope's request ID.
    static QJsonObject lastCommand(const QList<QJsonObject> &frames, const QString &command) {
        for (auto it = frames.crbegin(); it != frames.crend(); ++it) {
            const auto envelope = it->value("envelope").toObject();
            if (it->value("kind") == "renderer_command" && envelope.value("command") == command) {
                auto payload = envelope.value("payload").toObject();
                payload["requestId"] = envelope.value("request_id");
                return payload;
            }
        }
        return {};
    }
    static int commandCount(const QList<QJsonObject> &frames, const QString &command) {
        int count = 0;
        for (const auto &frame : frames)
            count += frame.value("kind") == "renderer_command" &&
                     frame.value("envelope").toObject().value("command") == command;
        return count;
    }
    static int controlCount(const QList<QJsonObject> &frames, const QString &type) {
        int count = 0;
        for (const auto &frame : frames)
            count += frame.value("kind") == "control" && frame.value("type") == type;
        return count;
    }
    static QJsonObject destination(const QString &url) {
        return {{"provider", "ollama"}, {"model", "tested"}, {"base_url", url}, {"has_api_key", false}};
    }
    static StoredProviderKey savedFor(const QString &url, const QString &key = "sk-saved-key") {
        return {providerKeyBinding("ollama", url), key, "write-1"};
    }
    // The connection's own provider read, answered as the service would.
    static void readProvider(RuntimeBridge &bridge, const QList<QJsonObject> &frames, const QString &url,
                             bool ok = true) {
        bridge.refresh();
        bridge.acceptFrame(controlResult(lastControl(frames, "provider:get")["requestId"].toString(), "provider:get",
                                         ok ? QJsonObject{{"ok", true}, {"llm", destination(url)}}
                                            : QJsonObject{{"ok", false}}));
    }
    // A saved, applied key for `url`, then a delete; the stop is the last credentials:set.
    static std::shared_ptr<KeyStoreState> deleteAppliedKey(RuntimeBridge &bridge, const QList<QJsonObject> &frames,
                                                           const QString &url) {
        auto store = keyStore(bridge, savedFor(url));
        readProvider(bridge, frames, url);
        ackKey(bridge, frames);
        bridge.clearProviderKey();
        return store;
    }
    static QJsonObject heldDestination(const QString &url) {
        auto value = destination(url);
        value["has_api_key"] = true;
        return value;
    }
    static void ackKey(RuntimeBridge &bridge, const QList<QJsonObject> &frames, bool applied = true) {
        bridge.acceptFrame(controlResult(lastControl(frames, "credentials:set")["requestId"].toString(), "credentials:set",
                                         {{"ok", applied}, {"applied", QJsonObject{{"llm", applied}}}}));
    }
  private slots:
    void prioritySaveUsesCurrentTransportIdentityAndReturnedValue_data() {
        QTest::addColumn<QString>("mode");
        QTest::newRow("matched-save") << "matched";
        QTest::newRow("wrong-priority") << "wrong";
        QTest::newRow("late-old-persona") << "late";
    }
    void prioritySaveUsesCurrentTransportIdentityAndReturnedValue() {
        QFETCH(QString, mode);
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QList<QPair<QString, QVariantMap>> sent;
        QString lastId;
        ArchiveEditor editor([&](const QString &command, const QVariantMap &payload) {
            sent.append({command, payload});
            lastId = bridge.request(command, payload);
            return lastId;
        });
        connect(&bridge, &RuntimeBridge::changed, &editor, [&] {
            editor.setSession(bridge.connected(), bridge.generation(), bridge.scopeKey(),
                              bridge.runtimeWritable(), bridge.personaChanging());
        });
        connect(&bridge, &RuntimeBridge::responseReceived, &editor, &ArchiveEditor::receive);
        connect(&bridge, &RuntimeBridge::requestFailed, &editor, &ArchiveEditor::failed);
        editor.setSession(bridge.connected(), bridge.generation(), bridge.scopeKey(), bridge.runtimeWritable());
        auto first = snapshot();
        auto archive = first["archive"].toObject();
        archive["worldBooks"] = QJsonArray{QJsonObject{{"id", "priority-book"}, {"name", "Priority"},
            {"entries", QJsonArray{QJsonObject{{"id", "priority-entry"}, {"content", "kept"},
                {"keywords", QJsonArray{}}, {"priority", 0}, {"useRegex", true}}}}}};
        first["archive"] = archive;
        bridge.event(frame("archive:result", lastId, first));
        QVERIFY(editor.initialized());
        editor.selectBook(editor.bookRows().first().toMap().value("key").toString());
        editor.selectEntry(editor.entryRows().first().toMap().value("key").toString());
        editor.setPriority(2);
        QVERIFY(editor.dirty());
        editor.save();
        const auto saveId = lastId;
        QCOMPARE(sent.last().first, QString("archive:put"));
        QCOMPARE(sent.last().second.value("expected_revision").toInt(), 1);
        const auto pendingGeneration = bridge.m_pending.value(saveId).generation;
        QCOMPARE(pendingGeneration, bridge.generation());
        auto saved = first;
        saved["revision"] = 2;
        auto returnedArchive = QJsonObject::fromVariantMap(sent.last().second.value("archive").toMap());
        auto books = returnedArchive["worldBooks"].toArray();
        auto book = books[0].toObject();
        auto entries = book["entries"].toArray();
        auto entry = entries[0].toObject();
        QVERIFY(!entry.contains("scanDepth") && !entry.contains("tokenBudget"));
        // The successful store response adds explicit nulls. Apply the original
        // wrong-priority mutation only after its other receipt fields are valid.
        entry["scanDepth"] = QJsonValue(QJsonValue::Null);
        entry["tokenBudget"] = QJsonValue(QJsonValue::Null);
        if (mode == "wrong") entry["priority"] = 0;
        entries[0] = entry; book["entries"] = entries; books[0] = book;
        returnedArchive["worldBooks"] = books;
        saved["archive"] = returnedArchive;
        if (mode == "late") {
            bridge.event(frame("persona:data", "", nextIdentity(4)));
            QVERIFY(!bridge.m_pending.contains(saveId));
            const auto currentScope = editor.archiveScope();
            const auto currentRevision = editor.revision();
            bridge.event(frame("archive:result", saveId, saved));
            QCOMPARE(editor.archiveScope(), currentScope);
            QCOMPARE(editor.revision(), currentRevision);
            QVERIFY(!editor.initialized());
            QVERIFY(editor.status() != "saved");
        } else {
            bridge.event(frame("archive:result", saveId, saved));
            QCOMPARE(editor.status(), mode == "matched" ? QString("saved") : QString("error"));
            QCOMPARE(editor.dirty(), mode != "matched");
            QCOMPARE(editor.priority().toInt(), 2);
            QCOMPARE(editor.revision(), mode == "matched" ? 2 : 1);
        }
        int writes = 0;
        for (const auto &request : sent) writes += request.first == "archive:put";
        QCOMPARE(writes, 1);
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }
    void archiveErrorsDuringChatRetainBusyAndReachEditor_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::newRow("generic-ledger-error")
            << "error"
            << QJsonObject{{"message", "The command result could not be committed safely"},
                           {"code", "storage_unavailable"}};
        QTest::newRow("ordinary-archive-rejection")
            << "archive:result"
            << QJsonObject{
                   {"ok", false}, {"error", "Archive write rejected"}, {"code", "module_degraded"}};
    }
    void archiveErrorsDuringChatRetainBusyAndReachEditor() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        int requests = 0;
        QString lastId;
        ArchiveEditor editor([&](const QString &command, const QVariantMap &) {
            lastId = QString("archive-request-%1").arg(++requests);
            pending(bridge, lastId, command, bridge.generation());
            return lastId;
        });
        QObject::connect(&bridge, &RuntimeBridge::responseReceived, &editor,
                         &ArchiveEditor::receive);
        QObject::connect(&bridge, &RuntimeBridge::requestFailed, &editor, &ArchiveEditor::failed);
        editor.setSession(true, bridge.generation(), "persona-test");
        const QJsonObject savedEntry{{"id", "entry-existing"},
                                     {"content", "Saved archive content"},
                                     {"keywords", QJsonArray{}}};
        const QJsonObject savedBook{{"id", "book-existing"},
                                    {"name", "Existing book"},
                                    {"entries", QJsonArray{savedEntry}}};
        auto savedSnapshot = snapshot();
        auto archive = savedSnapshot["archive"].toObject();
        archive["worldBooks"] = QJsonArray{savedBook};
        savedSnapshot["archive"] = archive;
        bridge.event(frame("archive:result", lastId, savedSnapshot));
        QVERIFY(editor.initialized());
        QCOMPARE(editor.revision(), 1);
        editor.setTitle("Draft title");
        editor.setContent("Unsaved archive draft");
        editor.save();
        const auto saveId = lastId;
        QCOMPARE(editor.status(), QString("saving"));

        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        QSignalSpy failures(&bridge, &RuntimeBridge::requestFailed);
        bridge.event(frame(eventType, saveId, payload));

        QVERIFY(bridge.busy());
        QVERIFY(bridge.m_pending.contains(bridge.m_chatId));
        QVERIFY(!bridge.m_pending.contains(saveId));
        QCOMPARE(editor.status(), QString("error"));
        QVERIFY(editor.dirty());
        QVERIFY(!editor.diagnostics().value("saving").toBool());
        QCOMPARE(editor.content(), QString("Unsaved archive draft"));
        QCOMPARE(editor.revision(), 1);
        checkResponse(responses, saveId, "archive:put", payload, 7);
        QCOMPARE(failures.count(), 0);
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }

    // Wired as in main.cpp, the archive editor reloads when it sees a new
    // identity. That read leaves while the bridge announces the identity and
    // must outlive the reset of the previous identity's requests.
    void identityChangeKeepsTheArchiveEditorsNewRead() {
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QStringList editorRequests;
        ArchiveEditor editor([&](const QString &command, const QVariantMap &payload) {
            const auto id = bridge.request(command, payload);
            editorRequests << id;
            return id;
        });
        QObject::connect(&bridge, &RuntimeBridge::changed, &editor, [&] {
            editor.setSession(bridge.connected(), bridge.generation(), bridge.scopeKey(), bridge.runtimeWritable(),
                              bridge.personaChanging());
        });
        QObject::connect(&bridge, &RuntimeBridge::responseReceived, &editor, &ArchiveEditor::receive);
        QObject::connect(&bridge, &RuntimeBridge::requestFailed, &editor, &ArchiveEditor::failed);
        editor.setSession(bridge.connected(), bridge.generation(), bridge.scopeKey(), bridge.runtimeWritable());
        QCOMPARE(editorRequests.size(), 1);
        bridge.event(frame("archive:result", editorRequests.last(), snapshot()));
        QVERIFY(editor.initialized());
        QCOMPARE(editor.revision(), 1);

        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(bridge.scopeKey(), QString("persona-4:4:fingerprint-4"));
        QCOMPARE(editorRequests.size(), 2);
        const auto editorRead = editorRequests.last();
        QVERIFY(bridge.m_pending.contains(editorRead));
        QCOMPARE(bridge.m_pending.value(editorRead).generation, bridge.generation());
        // The bridge's own refresh reads the archive too.
        QCOMPARE(pendingCount(bridge, "archive:get"), 2);
        QVERIFY(!editor.initialized());
        QVERIFY(editor.diagnostics().value("loading").toBool());

        auto next = snapshot();
        next["revision"] = 2;
        next["author_prompts"] = QJsonObject{
            {"card_id", "persona-4"},
            {"system", QJsonObject{{"text", "以安静简洁的语气回应。"}, {"flags", QJsonArray{}},
                                   {"enabled", false}, {"effective", false}}},
            {"post_history", QJsonObject{{"text", ""}, {"flags", QJsonArray{}},
                                         {"enabled", false}, {"effective", false}}}};
        bridge.event(frame("archive:result", editorRead, next));
        QVERIFY(editor.initialized());
        QCOMPARE(editor.revision(), 2);
        QCOMPARE(editor.status(), QString("clean"));
        QCOMPARE(editor.authorPrompts().value("system").toMap().value("text").toString(),
                 QString("以安静简洁的语气回应。"));
        QCOMPARE(editor.authorPromptBlocker(), QString());
    }

    void currentChatErrorsClearBusy_data() {
        QTest::addColumn<QString>("eventType");
        QTest::newRow("generic-error") << "error";
        QTest::newRow("chat-error") << "chat:error";
    }
    void currentChatErrorsClearBusy() {
        QFETCH(QString, eventType);
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        const QJsonObject payload{{"message", "Current chat failed"}, {"code", "chat_failure"}};
        const auto subject = bridge.m_chatId;
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);

        bridge.event(frame(eventType, subject, payload));

        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.notice(), QString("Current chat failed"));
        QVERIFY(!bridge.m_pending.contains(subject));
        QVERIFY(bridge.m_chatId.isEmpty());
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("failed"));
        QVERIFY(!bridge.chatFeedback().value("text").toString().contains("Current chat failed"));
        checkResponse(responses, subject, "chat:send", payload, 7);
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }

    void genericErrorFromAnotherChatRequestDoesNotEndCurrentChat() {
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        const QString previousId = "chat-previous";
        pending(bridge, previousId, "chat:send", bridge.generation());
        const QJsonObject payload{{"message", "Earlier chat failed"}};
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);

        bridge.event(frame("error", previousId, payload));

        QVERIFY(bridge.busy());
        QVERIFY(bridge.m_pending.contains(bridge.m_chatId));
        checkResponse(responses, previousId, "chat:send", payload, 7);
    }

    void unknownAndOldGenerationErrorsAreRejected_data() {
        QTest::addColumn<bool>("oldGeneration");
        QTest::newRow("unknown-request") << false;
        QTest::newRow("old-generation-current-chat-id") << true;
    }
    void v4CancellationEndsOnlyItsSubjectAndRejectsLateReply() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        bridge.m_pending.insert("cancel-current", {"chat:cancel", 7, {}, -1, subject});
        bridge.m_pending.insert("cancel-other", {"chat:cancel", 7, {}, -1, "another-chat"});
        bridge.event(
            frame("chat:state", subject, {{"request_id", subject}, {"state", "cancelled"}}));
        QVERIFY(!bridge.busy());
        QVERIFY(bridge.m_chatId.isEmpty());
        QVERIFY(!bridge.m_pending.contains("cancel-current"));
        QVERIFY(bridge.m_pending.contains("cancel-other"));
        QCOMPARE(bridge.notice(), QString("本次回复已停止"));
        const int count = bridge.messages().size();
        bridge.event(frame("chat:bubble", subject,
                           {{"request_id", subject}, {"text", "Late cancelled reply"}}));
        QCOMPARE(bridge.messages().size(), count);
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }
    void v4CancellationForAnotherSubjectDoesNotEndCurrentChat() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        pending(bridge, "another-chat", "chat:send", 7);
        bridge.event(frame("chat:state", "another-chat",
                           {{"request_id", "another-chat"}, {"state", "cancelled"}}));
        QVERIFY(bridge.busy());
        QCOMPARE(bridge.m_chatId, QString("chat-current"));
    }
    void cancelRejectionIsLocalAndAllowsManualRetry_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::newRow("generic-error") << "error" << QJsonObject{{"message", "raw cancel rejection"}};
        QTest::newRow("cancel-result-error") << "chat_cancel_result"
            << QJsonObject{{"error", "raw cancel rejection"}};
        QTest::newRow("cancel-result-not-ok") << "chat_cancel_result" << QJsonObject{{"ok", false}};
        QTest::newRow("stop-result-not-ok") << "chat:stop:result" << QJsonObject{{"ok", false}};
    }
    void cancelRejectionIsLocalAndAllowsManualRetry() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        bridge.event(frame("chat:state", subject, {{"state", "generating"}}));
        bridge.setDraft("next draft retained");
        bridge.cancelChat();
        const auto cancelId = controlId(bridge, "chat:cancel");
        QVERIFY(!cancelId.isEmpty());
        const int commands = bridge.m_commands;
        bridge.cancelChat();
        QCOMPARE(bridge.m_commands, commands);
        QCOMPARE(pendingCount(bridge, "chat:cancel"), 1);
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        bridge.event(frame(eventType, cancelId, payload));
        QVERIFY(bridge.busy());
        QCOMPARE(bridge.m_chatId, subject);
        QCOMPARE(bridge.draft(), QString("next draft retained"));
        QVERIFY(bridge.m_pending.contains(subject));
        QVERIFY(!bridge.m_pending.contains(cancelId));
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("generating"));
        const auto cancel = bridge.chatFeedback().value("cancel").toMap();
        QCOMPARE(cancel.value("status").toString(), QString("error"));
        QCOMPARE(cancel.value("requestId").toString(), cancelId);
        QCOMPARE(cancel.value("subjectRequestId").toString(), subject);
        QVERIFY(!cancel.value("text").toString().contains("raw cancel"));
        checkResponse(responses, cancelId, "chat:cancel", payload, 7);
        const auto feedback = bridge.chatFeedback();
        bridge.event(frame("chat_cancel_result", cancelId, {{"ok", true}}));
        QCOMPARE(bridge.chatFeedback(), feedback);
        bridge.cancelChat();
        const auto retryId = controlId(bridge, "chat:cancel");
        QVERIFY(!retryId.isEmpty());
        QVERIFY(retryId != cancelId);
        QCOMPARE(bridge.m_commands, commands + 1);
        QCOMPARE(bridge.chatFeedback().value("cancel").toMap().value("status").toString(), QString("pending"));
    }
    void cancelTimeoutPreservesChatAndOnlyTerminalClearsFeedback() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        bridge.cancelChat();
        const auto cancelId = controlId(bridge, "chat:cancel");
        bridge.m_pending.insert("another-cancel", {"chat:cancel", 7, {}, -1, "another-chat"});
        bridge.setDraft("draft while cancellation pending");
        const int commands = bridge.m_commands;
        bridge.expirePending(cancelId);
        QCOMPARE(bridge.m_commands, commands);
        QVERIFY(bridge.busy());
        QCOMPARE(bridge.m_chatId, subject);
        QCOMPARE(bridge.draft(), QString("draft while cancellation pending"));
        QVERIFY(bridge.m_pending.contains(subject));
        QVERIFY(bridge.m_pending.contains("another-cancel"));
        QVERIFY(!bridge.m_pending.contains(cancelId));
        const auto cancel = bridge.chatFeedback().value("cancel").toMap();
        QCOMPARE(cancel.value("status").toString(), QString("unknown"));
        QVERIFY(cancel.value("text").toString().contains("未自动重试"));
        QVERIFY(!cancel.value("text").toString().contains("仍在处理中"));
        const auto unknownFeedback = bridge.chatFeedback();
        bridge.event(frame("chat:stop:result", cancelId, {{"ok", true}, {"request_id", subject}}));
        QCOMPARE(bridge.chatFeedback(), unknownFeedback);
        for (const auto &state : {"queued", "generating", "delivering"}) {
            bridge.event(frame("chat:state", subject, {{"state", state}}));
            QCOMPARE(bridge.chatFeedback().value("cancel").toMap(), cancel);
            QVERIFY(bridge.busy());
        }
        bridge.cancelChat();
        const auto retry = bridge.chatFeedback().value("cancel").toMap().value("requestId").toString();
        QVERIFY(retry != cancelId);
        bridge.event(frame("chat:state", subject, {{"state", "done"}}));
        QVERIFY(!bridge.busy());
        QVERIFY(bridge.m_chatId.isEmpty());
        QVERIFY(!bridge.chatFeedback().contains("cancel"));
        QVERIFY(!bridge.m_pending.contains(retry));
        QVERIFY(bridge.m_pending.contains("another-cancel"));
        const auto terminal = bridge.chatFeedback();
        bridge.event(frame("error", retry, {{"message", "late cancellation rejection"}}));
        bridge.expirePending(retry);
        QCOMPARE(bridge.chatFeedback(), terminal);
    }
    void progressCannotDropPendingCancellationOrDeduplication() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        bridge.cancelChat();
        const auto cancel = bridge.chatFeedback().value("cancel").toMap();
        const auto cancelId = cancel.value("requestId").toString();
        const int commands = bridge.m_commands;
        bridge.event(frame("chat:state", subject, {{"state", "generating"}}));
        bridge.event(frame("chat:state", cancelId, {{"state", "delivering"}, {"request_id", subject}}));
        bridge.event(frame("chat_cancel_result", cancelId, {{"ok", true}}));
        bridge.cancelChat();
        QCOMPARE(bridge.m_commands, commands);
        QCOMPARE(bridge.chatFeedback().value("cancel").toMap(), cancel);
        QVERIFY(bridge.m_pending.contains(cancelId));
        QVERIFY(bridge.m_pending.contains(subject));
        QVERIFY(bridge.busy());
    }
    void staleCancelCallbacksCannotChangeActiveChat_data() {
        QTest::addColumn<QString>("mismatch");
        for (const auto &mismatch : {"id", "generation", "pending-subject", "payload-subject", "persona"})
            QTest::newRow(mismatch) << QString(mismatch);
    }
    void staleCancelCallbacksCannotChangeActiveChat() {
        QFETCH(QString, mismatch);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        bridge.cancelChat();
        auto id = controlId(bridge, "chat:cancel");
        QJsonObject payload{{"error", "late wrong cancellation"}};
        if (mismatch == "id") id = "unknown-cancel";
        if (mismatch == "generation") bridge.m_pending[id].generation = 6;
        if (mismatch == "pending-subject") {
            bridge.m_pending[id].subjectRequestId = "old-chat";
            payload["request_id"] = bridge.m_chatId;
        }
        if (mismatch == "payload-subject") payload["request_id"] = "old-chat";
        if (mismatch == "persona") payload["persona_id"] = "old-persona";
        const auto feedback = bridge.chatFeedback();
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        bridge.event(frame("chat_cancel_result", id, payload));
        QVERIFY(bridge.busy());
        QCOMPARE(bridge.m_chatId, QString("chat-current"));
        QCOMPARE(bridge.chatFeedback(), feedback);
        QCOMPARE(responses.count(), 0);
    }
    void authoritativeChatTerminalWinsOverCancellationError() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        bridge.cancelChat();
        const auto id = controlId(bridge, "chat:cancel");
        bridge.event(frame("chat:state", id, {{"request_id", bridge.m_chatId}, {"state", "failed_uncertain"},
                           {"error", "raw terminal detail"}}));
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("failed_uncertain"));
        QVERIFY(!bridge.chatFeedback().contains("cancel"));
        QVERIFY(!bridge.chatFeedback().value("text").toString().contains("raw terminal"));
    }
    void terminalChatStatesSettleOnlyCurrentRequest_data() {
        QTest::addColumn<QString>("status");
        for (const auto &status : {"failed", "failed_uncertain", "done", "cancelled"})
            QTest::newRow(status) << QString(status);
    }
    void terminalChatStatesSettleOnlyCurrentRequest() {
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        bridge.m_pending.insert("cancel-current", {"chat:cancel", 7, {}, -1, subject});
        bridge.m_pending.insert("reveal-current", {"chat:reveal", 7, {}, -1, subject});
        bridge.event(frame("chat:state", subject, {{"request_id", subject}, {"state", status},
                                                   {"error", "raw backend stack and provider details"}}));
        QVERIFY(!bridge.busy());
        QVERIFY(bridge.m_chatId.isEmpty());
        QVERIFY(!bridge.m_pending.contains(subject));
        QVERIFY(!bridge.m_pending.contains("cancel-current"));
        QVERIFY(!bridge.m_pending.contains("reveal-current"));
        QCOMPARE(bridge.chatFeedback().value("status").toString(), status);
        QCOMPARE(bridge.chatFeedback().value("requestId").toString(), subject);
        QVERIFY(!bridge.chatFeedback().value("text").toString().contains("raw backend"));
        const auto before = bridge.messages();
        const auto feedbackBefore = bridge.chatFeedback();
        const int commandsBefore = bridge.m_commands;
        bridge.event(frame("chat:state", subject, {{"request_id", subject}, {"state", "generating"}}));
        bridge.event(frame("chat:bubble", subject, {{"text", "late reply"}}));
        QCOMPARE(bridge.messages(), before);
        QCOMPARE(bridge.chatFeedback(), feedbackBefore);
        QCOMPARE(bridge.m_commands, commandsBefore);
    }
    void progressStatesKeepCorrelationAndTimerDoesNotRetry() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        const auto subject = bridge.m_chatId;
        for (const auto &status : {"queued", "generating", "delivering"}) {
            bridge.event(frame("chat:state", subject, {{"request_id", subject}, {"state", status}}));
            QVERIFY(bridge.busy());
            QVERIFY(bridge.m_pending.contains(subject));
            QCOMPARE(bridge.chatFeedback().value("status").toString(), QString(status));
        }
        const int before = bridge.m_commands;
        bridge.expirePending(subject);
        QVERIFY(bridge.busy());
        QVERIFY(bridge.m_pending.contains(subject));
        QCOMPARE(bridge.m_commands, before);
        bridge.event(frame("chat:state", subject, {{"state", "failed_uncertain"}}));
        QVERIFY(!bridge.busy());
        const auto settledCommands = bridge.m_commands;
        bridge.expirePending(subject);
        QCOMPARE(bridge.m_commands, settledCommands);
    }
    void staleChatStatesCannotChangeCurrentRequest_data() {
        QTest::addColumn<QString>("mismatch");
        QTest::newRow("unknown-id") << "id";
        QTest::newRow("old-generation") << "generation";
        QTest::newRow("old-persona") << "persona";
        QTest::newRow("old-epoch") << "epoch";
        QTest::newRow("old-fingerprint") << "fingerprint";
        QTest::newRow("different-payload-subject") << "subject";
    }
    void staleChatStatesCannotChangeCurrentRequest() {
        QFETCH(QString, mismatch);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        auto id = bridge.m_chatId;
        QJsonObject payload{{"request_id", id}, {"state", "failed_uncertain"}};
        if (mismatch == "id") { id = "unknown-chat"; payload["request_id"] = id; }
        if (mismatch == "generation") pending(bridge, id, "chat:send", 6);
        if (mismatch == "persona") payload["persona_id"] = "persona-old";
        if (mismatch == "epoch") payload["persona_epoch"] = 2;
        if (mismatch == "fingerprint") payload["persona_fingerprint"] = "fingerprint-old";
        if (mismatch == "subject") payload["request_id"] = "another-chat";
        const auto feedback = bridge.chatFeedback();
        QSignalSpy changes(&bridge, &RuntimeBridge::changed);
        bridge.event(frame("chat:state", id, payload));
        QVERIFY(bridge.busy());
        QCOMPARE(bridge.m_chatId, QString("chat-current"));
        QCOMPARE(bridge.chatFeedback(), feedback);
        QCOMPARE(changes.count(), 0);
    }
    void pausedOrUnconfirmedGatePreservesDraft_data() {
        QTest::addColumn<QString>("status");
        QTest::newRow("paused") << "paused";
        QTest::newRow("pending") << "pending";
        QTest::newRow("unknown") << "unknown";
    }
    void newerPersonaScopeIsAcceptedAndPreviousScopeCannotReturn() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        activeChat(bridge);
        bridge.setDraft("old persona draft");
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 4},
                                                  {"fingerprint", "fingerprint-next"}}));
        QCOMPARE(bridge.generation(), 8);
        QCOMPARE(bridge.scopeKey(), QString("persona-next:4:fingerprint-next"));
        QVERIFY(!bridge.busy());
        QVERIFY(bridge.m_chatId.isEmpty());
        QVERIFY(bridge.draft().isEmpty());
        QVERIFY(!bridge.m_pending.contains("chat-current"));
        const int commandsBefore = bridge.m_commands;
        const auto feedbackBefore = bridge.chatFeedback();
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-current"}, {"epoch", 3},
                                                  {"fingerprint", "fingerprint-current"}}));
        bridge.event(frame("chat:state", "chat-current", {{"state", "failed"},
                                                          {"persona_id", "persona-current"},
                                                          {"persona_epoch", 3}}));
        QCOMPARE(bridge.generation(), 8);
        QCOMPARE(bridge.scopeKey(), QString("persona-next:4:fingerprint-next"));
        QCOMPARE(bridge.m_commands, commandsBefore);
        QCOMPARE(bridge.chatFeedback(), feedbackBefore);
    }
    void pausedOrUnconfirmedGatePreservesDraft() {
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_offline = status == "paused";
        bridge.m_networkFeedback = {{"status", status}, {"known", status == "paused"}};
        bridge.setDraft("draft must remain verbatim ");
        bridge.sendChat();
        QCOMPARE(bridge.draft(), QString("draft must remain verbatim "));
        QVERIFY(bridge.messages().isEmpty());
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.m_commands, 0);
        QCOMPARE(bridge.chatFeedback().value("status").toString(),
                 status == "paused" ? status : "gate_" + status);
    }
    void networkFailureUsesAuthoritativeSnapshotAndKeepsOtherFeedback() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_providerFeedback = {{"status", "error"}, {"text", "provider feedback retained"}};
        bridge.setOffline(true);
        const auto id = bridge.m_networkRequestId;
        bridge.acceptFrame(controlResult(id, "local_mode:set", {{"ok", false}, {"active", false},
                          {"epoch", 0}, {"error", "raw service detail"}}));
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.networkFeedback().value("known").toBool());
        QVERIFY(!bridge.state().value("offline").toBool());
        QVERIFY(!bridge.networkFeedback().value("text").toString().contains("raw service"));
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("provider feedback retained"));
        QVERIFY(!bridge.m_pending.contains(id));
    }
    void networkIgnoresOldIdEpochTypeAndGeneration() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setOffline(true);
        const auto oldId = bridge.m_networkRequestId;
        const int oldEpoch = bridge.m_localModeEpoch;
        bridge.setOffline(false);
        const auto currentId = bridge.m_networkRequestId;
        const int currentEpoch = bridge.m_localModeEpoch;
        bridge.acceptFrame(controlResult(oldId, "local_mode:set", {{"ok", true}, {"active", true}, {"epoch", oldEpoch}}));
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("pending"));
        bridge.acceptFrame(controlResult(currentId, "local_mode:set", {{"ok", true}, {"active", false}, {"epoch", oldEpoch}}));
        QVERIFY(bridge.m_pending.contains(currentId));
        bridge.acceptFrame(controlResult(currentId, "provider:test", {{"ok", true}, {"active", false}, {"epoch", currentEpoch}}));
        QVERIFY(bridge.m_pending.contains(currentId));
        bridge.m_pending[currentId].generation = 6;
        bridge.acceptFrame(controlResult(currentId, "local_mode:set", {{"ok", true}, {"active", false}, {"epoch", currentEpoch}}));
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("pending"));
        bridge.m_pending[currentId].generation = 7;
        bridge.acceptFrame(controlResult(currentId, "local_mode:set", {{"ok", true}, {"active", false}, {"epoch", currentEpoch}}));
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("allowed"));
        QVERIFY(bridge.networkFeedback().value("known").toBool());
    }
    void networkMissingAcknowledgementIsUnknownAndBlocksSend() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setOffline(false);
        const auto id = bridge.m_networkRequestId;
        bridge.expirePending(id);
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(!bridge.networkFeedback().value("known").toBool());
        bridge.setDraft("retained after unknown gate");
        bridge.sendChat();
        QVERIFY(bridge.messages().isEmpty());
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.draft(), QString("retained after unknown gate"));
        bridge.acceptFrame(controlResult(id, "local_mode:set", {{"ok", true}, {"active", false}, {"epoch", 1}}));
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("unknown"));
    }
    void providerRetestClearsReadinessAndEditsRejectOldTest() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_providerTest = {{"model", "previous"}};
        bridge.m_state["providerTestReady"] = true;
        bridge.testProvider("http://127.0.0.1:11434", "current");
        const auto id = controlId(bridge, "provider:test");
        QVERIFY(!id.isEmpty());
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("testing"));
        bridge.providerDraftChanged();
        bridge.acceptFrame(controlResult(id, "provider:test", {{"ok", true}, {"success", true}}));
        QVERIFY(bridge.m_providerTest.isEmpty());
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("stale"));
    }
    void providerSavePreservesEditsMadeWhileSaving() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_providerTest = {{"provider", "ollama"}, {"model", "tested"}};
        bridge.m_state["providerTestReady"] = true;
        bridge.saveProvider();
        const auto id = bridge.m_providerSaveId;
        QVERIFY(!id.isEmpty());
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        QVERIFY(bridge.providerFeedback().value("saving").toBool());
        bridge.saveProvider();
        QCOMPARE(bridge.m_providerSaveId, id);
        bridge.providerDraftChanged();
        bridge.acceptFrame(controlResult(id, "provider:configure", {{"ok", true},
                          {"llm", provider("tested")}}));
        QCOMPARE(bridge.state().value("provider").toMap().value("model").toString(), QString("tested"));
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("saved"));
        QVERIFY(!bridge.providerFeedback().value("currentDraft").toBool());
        QVERIFY(!bridge.providerFeedback().value("saving").toBool());
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        QVERIFY(bridge.providerFeedback().value("text").toString().contains("当前编辑尚未保存"));
    }
    void providerTestSuccessAndFailureRemainLocal() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_chatFeedback = {{"status", "generating"}, {"text", "chat feedback retained"}};
        bridge.testProvider("http://127.0.0.1:11434", "tested");
        const auto passed = controlId(bridge, "provider:test");
        bridge.acceptFrame(controlResult(passed, "provider:test", {{"ok", true}, {"success", true}}));
        QVERIFY(bridge.state().value("providerTestReady").toBool());
        QCOMPARE(bridge.m_providerTest.value("model").toString(), QString("tested"));
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("ready"));
        bridge.testProvider("http://127.0.0.1:11434", "invalid");
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        const auto failed = controlId(bridge, "provider:test");
        bridge.acceptFrame(controlResult(failed, "provider:test", {{"ok", false},
                           {"error", "raw provider response body"}}));
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.m_providerTest.isEmpty());
        QVERIFY(!bridge.providerFeedback().value("text").toString().contains("raw provider"));
        QCOMPARE(bridge.chatFeedback().value("text").toString(), QString("chat feedback retained"));
    }
    void typedProviderKeyIsSavedAfterConfigureAndSentToItsDestination() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        auto store = keyStore(bridge);
        const QString url = "http://127.0.0.1:11434/v1", typed = "sk-typed-secret-0001";
        bridge.testProviderConfig("ollama", url, "tested", typed);
        const auto test = lastControl(*frames, "provider:test");
        QCOMPARE(test["credential"].toObject()["apiKey"].toString(), typed);
        bridge.acceptFrame(controlResult(test["requestId"].toString(), "provider:test", {{"ok", true}, {"success", true}}));
        // A test alone stores nothing.
        QVERIFY(!store->key);
        bridge.saveProvider();
        QVERIFY(bridge.m_providerTestKey.isEmpty());
        const auto configure = lastControl(*frames, "provider:configure");
        QVERIFY(!configure["llm"].toObject().contains("apiKey"));
        QVERIFY(!QJsonDocument(configure).toJson().contains(typed.toUtf8()));
        QCOMPARE(controlCount(*frames, "credentials:set"), 0);
        bridge.acceptFrame(controlResult(configure["requestId"].toString(), "provider:configure",
                                         {{"ok", true}, {"llm", destination(url)}}));
        QVERIFY(store->key);
        QCOMPARE(store->key->apiKey, typed);
        QCOMPARE(store->key->binding, providerKeyBinding("ollama", url));
        const auto send = lastControl(*frames, "credentials:set");
        QCOMPARE(send["credentials"].toObject()["llm"].toObject()["apiKey"].toString(), typed);
        QVERIFY(bridge.state().value("providerKey").toMap().value("pending").toBool());
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 0ULL);
        bridge.acceptFrame(controlResult(send["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        const auto key = bridge.state().value("providerKey").toMap();
        QVERIFY(key.value("stored").toBool() && key.value("matches").toBool() && key.value("applied").toBool());
        QCOMPARE(key.value("reason").toString(), QString("save"));
        QCOMPARE(key.value("deliveryCount").toULongLong(), 1ULL);
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 QString("回复服务已保存并应用；密钥已存入本机钥匙串。"));
        // The key never appears in the state or diagnostics the UI and reports read.
        const auto visible = QJsonDocument(QJsonObject::fromVariantMap(bridge.state())).toJson() +
                             QJsonDocument(QJsonObject::fromVariantMap(bridge.diagnostics())).toJson();
        QVERIFY(!visible.contains(typed.toUtf8()));
    }
    void savedProviderKeyIsNeitherTestedNorSentForAnotherDestination() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString first = "http://127.0.0.1:11434/v1", second = "http://127.0.0.1:11435/v1";
        auto store = keyStore(bridge, savedFor(first));
        bridge.m_state["provider"] = destination(first).toVariantMap();
        // Same destination, nothing typed: the test uses the saved key.
        bridge.testProviderConfig("ollama", first + "/", "tested", {});
        QCOMPARE(lastControl(*frames, "provider:test")["credential"].toObject()["apiKey"].toString(),
                 QString("sk-saved-key"));
        // Another destination, nothing typed: the saved key stays out of the test.
        bridge.testProviderConfig("ollama", second, "tested", {});
        const auto test = lastControl(*frames, "provider:test");
        QVERIFY(test["credential"].toObject().isEmpty());
        bridge.acceptFrame(controlResult(test["requestId"].toString(), "provider:test", {{"ok", true}, {"success", true}}));
        bridge.saveProvider();
        const auto configure = lastControl(*frames, "provider:configure");
        bridge.acceptFrame(controlResult(configure["requestId"].toString(), "provider:configure",
                                         {{"ok", true}, {"llm", destination(second)}}));
        QCOMPARE(controlCount(*frames, "credentials:set"), 0);
        QCOMPARE(store->writes, 0);
        const auto key = bridge.state().value("providerKey").toMap();
        QVERIFY(key.value("stored").toBool() && !key.value("matches").toBool() && !key.value("applied").toBool());
        // Back on its own destination the saved key is sent again.
        bridge.applyProviderKey(destination(first), "refresh");
        QCOMPARE(lastControl(*frames, "credentials:set")["credentials"].toObject()["llm"].toObject()["apiKey"].toString(),
                 QString("sk-saved-key"));
    }
    void providerKeyWriteFailureRestoresThePreviousService() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString first = "http://127.0.0.1:11434/v1", second = "http://127.0.0.1:11435/v1";
        auto store = keyStore(bridge, savedFor(first));
        store->failWrite = true;
        bridge.m_state["provider"] = destination(first).toVariantMap();
        bridge.testProviderConfig("ollama", second, "tested", "sk-typed-secret-0002");
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:test")["requestId"].toString(), "provider:test",
                                         {{"ok", true}, {"success", true}}));
        bridge.saveProvider();
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:configure")["requestId"].toString(),
                                         "provider:configure", {{"ok", true}, {"llm", destination(second)}}));
        // The earlier service is configured again; the typed key is never sent.
        const auto rollback = lastControl(*frames, "provider:configure");
        QCOMPARE(controlCount(*frames, "provider:configure"), 2);
        QCOMPARE(rollback["llm"].toObject()["base_url"].toString(), first);
        QCOMPARE(controlCount(*frames, "credentials:set"), 0);
        bridge.acceptFrame(controlResult(rollback["requestId"].toString(), "provider:configure",
                                         {{"ok", true}, {"llm", destination(first)}}));
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("error"));
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 QString("密钥未能存入本机钥匙串；已恢复原服务配置，原有密钥未改动。"));
        QCOMPARE(store->key->apiKey, QString("sk-saved-key"));
        // The restored service gets its own saved key back.
        QCOMPARE(lastControl(*frames, "credentials:set")["credentials"].toObject()["llm"].toObject()["apiKey"].toString(),
                 QString("sk-saved-key"));
        for (const auto &frame : *frames)
            QVERIFY(!QJsonDocument(frame).toJson().contains("sk-typed-secret-0002") ||
                    frame.value("type") == "provider:test");
    }
    void refreshSendsTheSavedKeyAndRecoversADroppedSend() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        keyStore(bridge, savedFor(url));
        bridge.refresh();
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", true}, {"llm", destination(url)}}));
        const auto send = lastControl(*frames, "credentials:set");
        QVERIFY(!send.isEmpty());
        // An identity reset drops the send without its callback; the next refresh sends again.
        bridge.m_pending.clear();
        bridge.refresh();
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", true}, {"llm", destination(url)}}));
        const auto resend = lastControl(*frames, "credentials:set");
        QVERIFY(resend["requestId"] != send["requestId"]);
        // A dropped request's late acknowledgement cannot count as a resend.
        bridge.acceptFrame(controlResult(send["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 0ULL);
        bridge.acceptFrame(controlResult(resend["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QVERIFY(bridge.state().value("providerKey").toMap().value("applied").toBool());
        QCOMPARE(bridge.state().value("providerKey").toMap().value("reason").toString(), QString("startup"));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 1ULL);
        bridge.acceptFrame(controlResult(resend["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 1ULL);
        // Another refresh resends but keeps the reason the key was first sent for.
        bridge.refresh();
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", true}, {"llm", destination(url)}}));
        bridge.acceptFrame(controlResult(lastControl(*frames, "credentials:set")["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("reason").toString(), QString("startup"));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 2ULL);
    }
    void providerKeyDeliveryCountWaitsForConfirmation_data() {
        QTest::addColumn<QString>("outcome");
        QTest::newRow("rejected") << "rejected";
        QTest::newRow("not-applied") << "not-applied";
        QTest::newRow("timeout") << "timeout";
    }
    void providerKeyDeliveryCountWaitsForConfirmation() {
        QFETCH(QString, outcome);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        keyStore(bridge, savedFor(url));
        bridge.applyProviderKey(destination(url), "refresh");
        const auto id = lastControl(*frames, "credentials:set")["requestId"].toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 0ULL);
        if (outcome == "timeout")
            bridge.expirePending(id);
        else
            bridge.acceptFrame(controlResult(id, "credentials:set",
                {{"ok", outcome != "rejected"}, {"applied", QJsonObject{{"llm", false}}}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 0ULL);
        QVERIFY(!bridge.state().value("providerKey").toMap().value("applied").toBool());
        bridge.acceptFrame(controlResult(id, "credentials:set",
            {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("deliveryCount").toULongLong(), 0ULL);
    }
    void clearingTheProviderKeyDeletesItBeforeTellingTheService() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        auto store = keyStore(bridge, savedFor("http://127.0.0.1:11434/v1"));
        bridge.clearProviderKey();
        QVERIFY(!store->key);
        const auto clear = lastControl(*frames, "credentials:set");
        QVERIFY(clear["credentials"].toObject()["llm"].isNull());
        QVERIFY(bridge.state().value("providerKey").toMap().value("pending").toBool());
        bridge.acceptFrame(controlResult(clear["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("已删除保存的密钥，本地服务也已停用它。"));
        const auto key = bridge.state().value("providerKey").toMap();
        QVERIFY(!key.value("stored").toBool() && !key.value("applied").toBool() && !key.value("pending").toBool());
        QCOMPARE(key.value("deliveryCount").toULongLong(), 0ULL);
    }
    void chatSendWaitsForTheReplyServiceAndItsKey_data() {
        QTest::addColumn<QString>("situation");
        QTest::addColumn<QString>("status");
        QTest::newRow("provider-unread") << "provider-unread" << "provider_pending";
        QTest::newRow("provider-read-failed") << "provider-read-failed" << "provider_pending";
        QTest::newRow("provider-from-earlier-connection") << "provider-from-earlier-connection" << "provider_pending";
        QTest::newRow("provider-saving") << "provider-saving" << "provider_saving";
        QTest::newRow("key-pending") << "key-pending" << "key_pending";
        QTest::newRow("key-rejected") << "key-rejected" << "key_unconfirmed";
        QTest::newRow("key-timeout") << "key-timeout" << "key_unconfirmed";
        QTest::newRow("key-clearing") << "key-clearing" << "key_clearing";
    }
    void chatSendWaitsForTheReplyServiceAndItsKey() {
        QFETCH(QString, situation);
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        const bool keyed = situation.startsWith("key-");
        if (keyed)
            keyStore(bridge, savedFor(url));
        if (situation == "provider-unread") {
            bridge.refresh();
        } else if (situation == "provider-read-failed") {
            readProvider(bridge, *frames, url, false);
        } else {
            readProvider(bridge, *frames, url);
            if (situation == "provider-from-earlier-connection") {
                ++bridge.m_handshakes;
            } else if (situation == "provider-saving") {
                bridge.testProviderConfig("ollama", url, "tested", {});
                bridge.acceptFrame(controlResult(lastControl(*frames, "provider:test")["requestId"].toString(),
                                                 "provider:test", {{"ok", true}, {"success", true}}));
                bridge.saveProvider();
                QVERIFY(!bridge.m_providerSaveId.isEmpty());
            } else if (situation == "key-rejected") {
                ackKey(bridge, *frames, false);
            } else if (situation == "key-timeout") {
                bridge.expirePending(lastControl(*frames, "credentials:set")["requestId"].toString());
            } else if (situation == "key-clearing") {
                ackKey(bridge, *frames);
                QVERIFY(bridge.chatSendGate().isEmpty());
                bridge.clearProviderKey();
            }
        }
        QCOMPARE(bridge.chatSendGate().value("status").toString(), status);
        const int reads = controlCount(*frames, "provider:get");
        bridge.setDraft("服务确认前的草稿 ");
        bridge.sendChat();
        QCOMPARE(pendingCount(bridge, "chat:send"), 0);
        QVERIFY(bridge.messages().isEmpty());
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.draft(), QString("服务确认前的草稿 "));
        QCOMPARE(bridge.chatFeedback().value("status").toString(), status);
        QCOMPARE(bridge.chatFeedback().value("text").toString(), bridge.chatSendGate().value("text").toString());
        // An unconfirmed provider with nothing in flight gets one read from this send; never a chat.
        const bool asksForRead = situation == "provider-read-failed" || situation == "provider-from-earlier-connection";
        QCOMPARE(controlCount(*frames, "provider:get"), reads + (asksForRead ? 1 : 0));
        // The generic request path is held back by the same gate.
        QVERIFY(bridge.request("chat:send", {{"text", "直接请求"}, {"conversation_id", "dream-room"}}).isEmpty());
        QCOMPARE(pendingCount(bridge, "chat:send"), 0);
    }
    void chatSendIsNotHeldForAKeyItCannotUse_data() {
        QTest::addColumn<QString>("situation");
        QTest::newRow("no-store") << "no-store";
        QTest::newRow("no-key") << "no-key";
        QTest::newRow("key-for-another-destination") << "key-for-another-destination";
        QTest::newRow("key-applied") << "key-applied";
        QTest::newRow("store-unreadable") << "store-unreadable";
    }
    void chatSendIsNotHeldForAKeyItCannotUse() {
        QFETCH(QString, situation);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        std::shared_ptr<KeyStoreState> store;
        if (situation == "no-key")
            store = keyStore(bridge);
        else if (situation == "key-for-another-destination")
            store = keyStore(bridge, savedFor("http://127.0.0.1:11435/v1"));
        else if (situation != "no-store")
            store = keyStore(bridge, savedFor(url));
        if (situation == "store-unreadable")
            store->failRead = true;
        readProvider(bridge, *frames, url);
        if (situation == "key-applied")
            ackKey(bridge, *frames);
        else
            QCOMPARE(controlCount(*frames, "credentials:set"), 0);
        QVERIFY(bridge.chatSendGate().isEmpty());
        bridge.setDraft("可以发送的草稿");
        bridge.sendChat();
        QCOMPARE(pendingCount(bridge, "chat:send"), 1);
        QVERIFY(bridge.busy());
        QVERIFY(bridge.draft().isEmpty());
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("queued"));
    }
    void chatSendWaitsForAReplyServiceToBeChosen_data() {
        QTest::addColumn<QString>("situation");
        QTest::addColumn<QString>("status");
        QTest::newRow("startup-read") << "startup-read" << "provider_unconfigured";
        QTest::newRow("permission-read") << "permission-read" << "provider_unconfigured";
        QTest::newRow("from-earlier-connection") << "from-earlier-connection" << "provider_pending";
    }
    // A fresh install reads a destination without a model; that is a known state, not a pending one.
    void chatSendWaitsForAReplyServiceToBeChosen() {
        QFETCH(QString, situation);
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        auto fresh = destination(url);
        fresh["model"] = "";
        if (situation == "permission-read")
            bridge.readProviderForPermissions(false);
        else
            bridge.refresh();
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", true}, {"llm", fresh}}));
        QVERIFY(!bridge.providerControlPending());
        // An empty model is never taken as the current service.
        QVERIFY(!bridge.state().contains("provider"));
        if (situation == "from-earlier-connection")
            ++bridge.m_handshakes;
        QCOMPARE(bridge.chatSendGate().value("status").toString(), status);
        const int reads = controlCount(*frames, "provider:get");
        bridge.setDraft("还没选服务时的草稿");
        bridge.sendChat();
        QCOMPARE(pendingCount(bridge, "chat:send"), 0);
        QCOMPARE(bridge.draft(), QString("还没选服务时的草稿"));
        QCOMPARE(bridge.chatFeedback().value("status").toString(), status);
        QCOMPARE(bridge.chatFeedback().value("text").toString(), bridge.chatSendGate().value("text").toString());
        // Only saving a service ends the unconfigured state, so the send reads nothing.
        QCOMPARE(controlCount(*frames, "provider:get"), reads + (status == "provider_pending" ? 1 : 0));
        QVERIFY(bridge.request("chat:send", {{"text", "直接请求"}, {"conversation_id", "dream-room"}}).isEmpty());
        if (status != "provider_unconfigured")
            return;
        QCOMPARE(bridge.chatSendGate().value("text").toString(),
                 QString("还没有配置回复服务，输入已保留。请先在设置里选择服务。"));
        bridge.testProviderConfig("ollama", url, "tested", {});
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:test")["requestId"].toString(),
                                         "provider:test", {{"ok", true}, {"success", true}}));
        bridge.saveProvider();
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("provider_saving"));
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:configure")["requestId"].toString(),
                                         "provider:configure", {{"ok", true}, {"llm", destination(url)}}));
        QVERIFY(bridge.chatSendGate().isEmpty());
        bridge.sendChat();
        QCOMPARE(pendingCount(bridge, "chat:send"), 1);
        QVERIFY(bridge.draft().isEmpty());
    }
    void deletingTheKeyVoidsAnEarlierProviderTest_data() {
        QTest::addColumn<QString>("situation");
        QTest::newRow("saved-key-test") << "saved-key-test";
        QTest::newRow("typed-key-test") << "typed-key-test";
        QTest::newRow("test-in-flight") << "test-in-flight";
        QTest::newRow("delete-failed") << "delete-failed";
    }
    void deletingTheKeyVoidsAnEarlierProviderTest() {
        QFETCH(QString, situation);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        auto store = keyStore(bridge, savedFor(url));
        store->failClear = situation == "delete-failed";
        readProvider(bridge, *frames, url);
        ackKey(bridge, *frames);
        bridge.testProviderConfig("ollama", url, "tested",
                                  situation == "typed-key-test" ? QString("sk-typed-secret-0003") : QString());
        const auto test = lastControl(*frames, "provider:test");
        if (situation != "typed-key-test")
            QCOMPARE(test["credential"].toObject()["apiKey"].toString(), QString("sk-saved-key"));
        const QJsonObject passed{{"ok", true}, {"success", true}};
        if (situation != "test-in-flight") {
            bridge.acceptFrame(controlResult(test["requestId"].toString(), "provider:test", passed));
            QVERIFY(bridge.state().value("providerTestReady").toBool());
        }
        bridge.clearProviderKey();
        if (situation == "delete-failed") {
            // Nothing changed, so the test still stands and can be saved.
            QVERIFY(store->key);
            QCOMPARE(controlCount(*frames, "credentials:set"), 1);
            QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("无法从本机钥匙串删除密钥，没有任何改动。"));
            QVERIFY(bridge.state().value("providerTestReady").toBool());
            bridge.saveProvider();
            QCOMPARE(controlCount(*frames, "provider:configure"), 1);
            return;
        }
        QVERIFY(!store->key);
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        QVERIFY(bridge.m_providerTest.isEmpty() && bridge.m_providerTestKey.isEmpty() && !bridge.m_providerTestReplacesKey);
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("stale"));
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("之前的连接测试已作废，请重新测试后保存。"));
        // A late pass of the voided test cannot make it savable again.
        if (situation == "test-in-flight")
            bridge.acceptFrame(controlResult(test["requestId"].toString(), "provider:test", passed));
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
        ackKey(bridge, *frames);
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 QString("已删除保存的密钥，本地服务也已停用它；之前的连接测试已作废，请重新测试后保存。"));
        bridge.saveProvider();
        QCOMPARE(controlCount(*frames, "provider:configure"), 0);
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("请先测试当前地址和模型。"));
        QCOMPARE(store->writes, 0);
    }
    void unconfirmedKeyStopIsVerifiedByARead_data() {
        QTest::addColumn<QString>("outcome");
        QTest::newRow("rejected") << "rejected";
        QTest::newRow("not-applied") << "not-applied";
        QTest::newRow("timeout") << "timeout";
        QTest::newRow("not-sent") << "not-sent";
        QTest::newRow("dropped") << "dropped";
    }
    void unconfirmedKeyStopIsVerifiedByARead() {
        QFETCH(QString, outcome);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        if (outcome == "not-sent") {
            // Only the stop fails to reach the service; the verifying read still goes out.
            bridge.m_frameWriter = [frames](const QByteArray &frame) -> qint64 {
                const auto value = QJsonDocument::fromJson(frame.mid(4)).object();
                if (value.value("type") == "credentials:set" &&
                    value.value("credentials").toObject().value("llm").isNull())
                    return -1;
                frames->append(value);
                return frame.size();
            };
        }
        auto store = deleteAppliedKey(bridge, *frames, url);
        QVERIFY(!store->key);
        const auto stop = lastControl(*frames, "credentials:set");
        if (outcome == "rejected" || outcome == "not-applied") {
            QVERIFY(stop["credentials"].toObject()["llm"].isNull());
            bridge.acceptFrame(controlResult(stop["requestId"].toString(), "credentials:set",
                {{"ok", outcome == "not-applied"}, {"applied", QJsonObject{{"llm", false}}}}));
        } else if (outcome == "timeout") {
            bridge.expirePending(stop["requestId"].toString());
        } else if (outcome == "dropped") {
            QVERIFY(stop["credentials"].toObject()["llm"].isNull());
            bridge.m_pending.clear();
            QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("key_clear_unconfirmed"));
            bridge.settleDroppedProviderKeyRequests();
        }
        const auto key = [&bridge] { return bridge.state().value("providerKey").toMap(); };
        QCOMPARE(key().value("clearState").toString(), QString("verifying"));
        // The connection's own read plus exactly one verifying read.
        QCOMPARE(controlCount(*frames, "provider:get"), 2);
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 QString("钥匙串里的密钥已删除；本地服务是否已停用未确认，正在核对…"));
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("key_clear_unconfirmed"));
        bridge.setDraft("停用确认前的草稿");
        bridge.sendChat();
        QCOMPARE(pendingCount(bridge, "chat:send"), 0);
        QCOMPARE(bridge.draft(), QString("停用确认前的草稿"));
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("key_clear_unconfirmed"));
        if (outcome == "timeout") {
            // A late acknowledgement of the timed-out stop settles nothing; only the read does.
            bridge.acceptFrame(controlResult(stop["requestId"].toString(), "credentials:set",
                                             {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
            QCOMPARE(key().value("clearState").toString(), QString("verifying"));
        }
        // The stop is never repeated by itself, and the Keychain is not touched again.
        QCOMPARE(controlCount(*frames, "credentials:set"), outcome == "not-sent" ? 1 : 2);
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", true}, {"llm", destination(url)}}));
        QVERIFY(key().value("clearState").toString().isEmpty());
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("已删除保存的密钥；已核对本地服务不再使用它。"));
        QVERIFY(bridge.chatSendGate().isEmpty());
        QVERIFY(!store->key);
        QCOMPARE(store->writes, 0);
    }
    void heldKeyAfterDeleteCanOnlyBeStoppedAgainByTheUser_data() {
        QTest::addColumn<QString>("verification");
        QTest::newRow("service-still-holds") << "held";
        QTest::newRow("read-failed") << "unconfirmed";
    }
    void heldKeyAfterDeleteCanOnlyBeStoppedAgainByTheUser() {
        QFETCH(QString, verification);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        auto store = deleteAppliedKey(bridge, *frames, url);
        bridge.acceptFrame(controlResult(lastControl(*frames, "credentials:set")["requestId"].toString(), "credentials:set",
                                         {{"ok", false}}));
        const auto read = lastControl(*frames, "provider:get")["requestId"].toString();
        bridge.acceptFrame(controlResult(read, "provider:get",
            verification == "held" ? QJsonObject{{"ok", true}, {"llm", heldDestination(url)}} : QJsonObject{{"ok", false}}));
        const auto key = [&bridge] { return bridge.state().value("providerKey").toMap(); };
        QCOMPARE(key().value("clearState").toString(), verification);
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 verification == "held" ? QString("钥匙串里的密钥已删除，但本地服务仍在使用它。可再次停用，或重新启动应用。")
                                        : QString("钥匙串里的密钥已删除；本地服务是否已停用无法核对。可再次停用，或重新启动应用。"));
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("key_clear_unconfirmed"));
        QCOMPARE(bridge.chatSendGate().value("text").toString(),
                 verification == "held" ? QString("本地服务仍在使用已删除的密钥，输入已保留。请再次停用，或重新启动应用。")
                                        : QString("删除的密钥是否已从本地服务停用尚未确认，输入已保留。"));
        // Nothing is resent until the user asks; then only the stop, never a Keychain change.
        QCOMPARE(controlCount(*frames, "credentials:set"), 2);
        bridge.retryProviderKeyClear();
        QCOMPARE(controlCount(*frames, "credentials:set"), 3);
        const auto retry = lastControl(*frames, "credentials:set");
        QVERIFY(retry["credentials"].toObject()["llm"].isNull());
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("key_clearing"));
        bridge.retryProviderKeyClear();
        QCOMPARE(controlCount(*frames, "credentials:set"), 3);
        bridge.acceptFrame(controlResult(retry["requestId"].toString(), "credentials:set",
                                         {{"ok", true}, {"applied", QJsonObject{{"llm", true}}}}));
        QVERIFY(key().value("clearState").toString().isEmpty());
        QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("已删除保存的密钥，本地服务也已停用它。"));
        QVERIFY(bridge.chatSendGate().isEmpty());
        QVERIFY(!store->key);
        QCOMPARE(store->writes, 0);
        // With nothing unconfirmed a retry sends nothing.
        bridge.retryProviderKeyClear();
        QCOMPARE(controlCount(*frames, "credentials:set"), 3);
    }
    void unconfirmedKeyStopEndsWithTheServiceSnapshot_data() {
        QTest::addColumn<QString>("change");
        QTest::addColumn<QString>("clearState");
        QTest::newRow("typed-key-saved") << "typed-key-saved" << "";
        QTest::newRow("other-destination-saved") << "other-destination-saved" << "";
        QTest::newRow("same-destination-still-held") << "same-destination-still-held" << "held";
        QTest::newRow("refresh-shows-no-key") << "refresh-shows-no-key" << "";
    }
    void unconfirmedKeyStopEndsWithTheServiceSnapshot() {
        QFETCH(QString, change);
        QFETCH(QString, clearState);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1", other = "http://127.0.0.1:11435/v1";
        auto store = deleteAppliedKey(bridge, *frames, url);
        bridge.acceptFrame(controlResult(lastControl(*frames, "credentials:set")["requestId"].toString(), "credentials:set",
                                         {{"ok", false}}));
        bridge.acceptFrame(controlResult(lastControl(*frames, "provider:get")["requestId"].toString(), "provider:get",
                                         {{"ok", false}}));
        QCOMPARE(bridge.state().value("providerKey").toMap().value("clearState").toString(), QString("unconfirmed"));
        if (change == "refresh-shows-no-key") {
            readProvider(bridge, *frames, url);
        } else {
            const QString target = change == "other-destination-saved" ? other : url;
            bridge.testProviderConfig("ollama", target, "tested",
                                      change == "typed-key-saved" ? QString("sk-typed-secret-0004") : QString());
            bridge.acceptFrame(controlResult(lastControl(*frames, "provider:test")["requestId"].toString(), "provider:test",
                                             {{"ok", true}, {"success", true}}));
            bridge.saveProvider();
            bridge.acceptFrame(controlResult(lastControl(*frames, "provider:configure")["requestId"].toString(),
                "provider:configure", {{"ok", true},
                {"llm", change == "same-destination-still-held" ? heldDestination(url) : destination(target)}}));
        }
        QCOMPARE(bridge.state().value("providerKey").toMap().value("clearState").toString(), clearState);
        if (change == "typed-key-saved")
            QCOMPARE(store->key->apiKey, QString("sk-typed-secret-0004"));
        else
            QVERIFY(!store->key);
        QCOMPARE(bridge.chatSendGate().value("status").toString(),
                 clearState.isEmpty() ? (change == "typed-key-saved" ? QString("key_pending") : QString())
                                      : QString("key_clear_unconfirmed"));
    }
    void keychainDeleteFailureIsReadBack_data() {
        QTest::addColumn<QString>("failure");
        QTest::newRow("record-remains") << "record-remains";
        QTest::newRow("record-gone") << "record-gone";
        QTest::newRow("unreadable") << "unreadable";
    }
    void keychainDeleteFailureIsReadBack() {
        QFETCH(QString, failure);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QString url = "http://127.0.0.1:11434/v1";
        auto store = keyStore(bridge, savedFor(url));
        readProvider(bridge, *frames, url);
        ackKey(bridge, *frames);
        store->failClear = failure == "record-remains";
        store->clearReportsFailureAfterDeleting = failure != "record-remains";
        store->failReadAfterClear = failure == "unreadable";
        bridge.clearProviderKey();
        if (failure == "record-gone") {
            // The record is gone, so the service is told to stop as after a clean delete.
            QVERIFY(!store->key);
            QVERIFY(lastControl(*frames, "credentials:set")["credentials"].toObject()["llm"].isNull());
            QCOMPARE(controlCount(*frames, "credentials:set"), 2);
            ackKey(bridge, *frames);
            QCOMPARE(bridge.providerFeedback().value("text").toString(), QString("已删除保存的密钥，本地服务也已停用它。"));
            QVERIFY(!bridge.state().value("providerKey").toMap().value("stored").toBool());
            return;
        }
        // Nothing is sent: the service keeps the key it was given.
        QCOMPARE(controlCount(*frames, "credentials:set"), 1);
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("error"));
        QCOMPARE(bridge.providerFeedback().value("text").toString(),
                 failure == "record-remains" ? QString("无法从本机钥匙串删除密钥，没有任何改动。")
                                             : QString("钥匙串删除失败且无法读回，本地服务仍在使用原密钥；请稍后重试。"));
        QVERIFY(bridge.state().value("providerKey").toMap().value("clearState").toString().isEmpty());
        if (failure == "record-remains")
            QVERIFY(store->key && bridge.state().value("providerKey").toMap().value("applied").toBool());
    }
    void providerTestFailureNamesItsReason_data() {
        QTest::addColumn<QString>("code");
        QTest::addColumn<QString>("text");
        QTest::newRow("unauthorized") << "PROVIDER_UNAUTHORIZED" << "服务拒绝了密钥，请检查 API Key。";
        QTest::newRow("unreachable") << "PROVIDER_UNREACHABLE" << "无法连接到服务或连接超时；未自动重试。";
        QTest::newRow("rejected-address") << "REVERIE_CONTROL_REJECTED"
            << "配置未被接受：云端服务的地址由服务商固定，自定义服务须为 HTTPS 公网地址，本机服务须在本机。";
        QTest::newRow("other") << "PROVIDER_FAILURE" << "连接测试失败，请检查当前地址和模型。";
    }
    void providerTestFailureNamesItsReason() {
        QFETCH(QString, code);
        QFETCH(QString, text);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.testProviderConfig("openai", "https://ignored.example/v1", "gpt-test", "sk-typed");
        const auto test = lastControl(*frames, "provider:test");
        // A named cloud service is tested on its pinned endpoint, never a typed address.
        QCOMPARE(test["llm"].toObject()["base_url"].toString(), QString());
        bridge.acceptFrame(controlResult(test["requestId"].toString(), "provider:test", {{"ok", false}, {"code", code}}));
        QCOMPARE(bridge.providerFeedback().value("text").toString(), text);
        QVERIFY(!bridge.state().value("providerTestReady").toBool());
    }
    void providerSaveWithoutAckIsUnknownAndCannotClaimNoWrite() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_providerTest = {{"model", "tested"}};
        bridge.saveProvider();
        const auto id = bridge.m_providerSaveId;
        bridge.expirePending(id);
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(bridge.providerFeedback().value("text").toString().contains("保存结果未知"));
        QVERIFY(!bridge.providerFeedback().value("text").toString().contains("未能保存"));
        QVERIFY(!bridge.providerFeedback().value("saving").toBool());
        const int pendingBefore = bridge.m_pending.size();
        bridge.saveProvider();
        QCOMPARE(bridge.m_pending.size(), pendingBefore);
        QVERIFY(bridge.m_providerSaveId.isEmpty());
    }
    void sameAvatarPathFollowsActualRenderOutcome() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        const auto same = data.filePath("same/model.model3.json");
        bridge.rememberAvatar({{"entryPath", same}});
        QCOMPARE(bridge.avatarState(), QString("正在载入形象…"));
        // Still waiting for the surface: reselecting neither reloads nor claims a result.
        bridge.rememberAvatar({{"entryPath", same}});
        QCOMPARE(bridge.avatarReloadToken(), 0);
        QCOMPARE(bridge.avatarState(), QString("正在载入形象…"));
        bridge.modelRendered(true, "", same);
        QCOMPARE(bridge.avatarState(), QString("形象已就绪"));
        // A ready model stays loaded; a stale job message is replaced by the real state.
        bridge.m_avatarState = "模型操作未完成。";
        bridge.rememberAvatar({{"entryPath", same}});
        QCOMPARE(bridge.avatarReloadToken(), 0);
        QCOMPARE(bridge.avatarState(), QString("形象已就绪"));

        const auto next = data.filePath("new/model.model3.json");
        bridge.rememberAvatar({{"entryPath", next}});
        QCOMPARE(bridge.avatarPath(), next);
        QCOMPARE(bridge.avatarState(), QString("正在载入形象…"));
        bridge.modelRendered(true, "", same);
        QCOMPARE(bridge.avatarState(), QString("正在载入形象…"));
        bridge.modelRendered(false, "new render error", next);
        QCOMPARE(bridge.avatarState(), QString("new render error"));
        // Reselecting a failed path asks the surface to load it again, once.
        bridge.rememberAvatar({{"entryPath", next}});
        QCOMPARE(bridge.avatarReloadToken(), 1);
        QCOMPARE(bridge.avatarState(), QString("正在载入形象…"));
        bridge.rememberAvatar({{"entryPath", next}});
        QCOMPARE(bridge.avatarReloadToken(), 1);
        bridge.modelRendered(true, "", next);
        QCOMPARE(bridge.avatarState(), QString("形象已就绪"));
    }
    void memoryReceiptsKeepTheLastConfirmedList() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        bridge.refreshMemories();
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "memory:list"), 0);
        online(bridge);
        bridge.refreshMemories();
        const auto first = controlId(bridge, "memory:list");
        QVERIFY(!first.isEmpty());
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("pending"));
        bridge.refreshMemories();
        QCOMPARE(pendingCount(bridge, "memory:list"), 1);
        const QJsonArray memories{QJsonObject{{"id", "memory-1"}, {"text", "喜欢在窗边看月亮"},
                                              {"pinned", false}}};
        bridge.event(frame("memory:result", first, {{"ok", true}, {"memories", memories}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("success"));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("共 1 条已确认的记忆。"));
        QCOMPARE(bridge.state().value("memory").toMap().value("memories").toList().size(), 1);

        // Neither a generic error nor an ok:false reply may empty the shown list.
        bridge.refreshMemories();
        const auto rejected = controlId(bridge, "memory:list");
        bridge.event(frame("error", rejected, {{"message", "authenticated controller required"}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));
        bridge.refreshMemories();
        const auto unavailable = controlId(bridge, "memory:list");
        bridge.event(frame("memory:result", unavailable,
                           {{"ok", false}, {"error", "Memory system is not initialized"},
                            {"memories", QJsonArray{}}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));
        QCOMPARE(bridge.state().value("memory").toMap().value("memories").toList().size(), 1);

        bridge.refreshMemories();
        const auto lost = controlId(bridge, "memory:list");
        bridge.expirePending(lost);
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("unknown"));
    }
    void memoryActionsReportAndReadBothListsBack() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        bridge.setMemoryPinned("memory-1", true);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        online(bridge);
        // Only pinning is exposed; other lifecycle adjustments are refused locally.
        QVERIFY(bridge.request("memory:reinforce", {{"memory_id", "memory-1"}, {"op", "strengthen"}}).isEmpty());
        bridge.editMemory("memory-1", "   ");
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "memory:edit"), 0);

        bridge.refreshMemories();
        const QJsonArray shown{QJsonObject{{"id", "memory-1"}, {"text", "用户喜欢：星空"}, {"pinned", false}}};
        bridge.event(frame("memory:result", controlId(bridge, "memory:list"), {{"ok", true}, {"memories", shown}}));
        const QJsonArray pending{QJsonObject{{"id", "mc_" + QString(32, 'a')}, {"proposed_text", "用户喜欢：月亮"}, {"created_at", 10.0}, {"status", "pending"}}};
        bridge.event(frame("memory:candidates:result", controlId(bridge, "memory:candidates:list"),
                           {{"ok", true}, {"status", "pending"}, {"candidates", pending},
                            {"has_more", false}, {"next_cursor", QJsonValue::Null}}));
        QCOMPARE(bridge.state().value("candidates").toMap().value("candidates").toList().size(), 1);

        bridge.setMemoryPinned("memory-1", true);
        bridge.setMemoryPinned("memory-1", true);
        QCOMPARE(pendingCount(bridge, "memory:reinforce"), 1);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("pending"));
        bridge.event(frame("memory:result", controlId(bridge, "memory:reinforce"),
                           {{"ok", true}, {"op", "pin"}, {"memory_id", "memory-1"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(), QString("已固定这条记忆。"));
        QCOMPARE(memoryReceipt(bridge, "action").value("subjectId").toString(), QString("memory-1"));
        // The pin receipt shares memory:result but must not replace the list.
        QCOMPARE(bridge.state().value("memory").toMap().value("memories").toList().size(), 1);
        QCOMPARE(pendingCount(bridge, "memory:list"), 1);
        QCOMPARE(pendingCount(bridge, "memory:candidates:list"), 1);
        bridge.event(frame("memory:result", controlId(bridge, "memory:list"), {{"ok", true}, {"memories", shown}}));
        bridge.event(frame("memory:candidates:result", controlId(bridge, "memory:candidates:list"),
                           {{"ok", true}, {"status", "pending"}, {"candidates", pending},
                            {"has_more", false}, {"next_cursor", QJsonValue::Null}}));

        bridge.setMemoryPinned("memory-1", true);
        bridge.event(frame("memory:result", controlId(bridge, "memory:reinforce"),
                           {{"ok", false}, {"op", "pin"}, {"error", "最多固定 20 条记忆"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(), QString("最多固定 20 条记忆，这条未固定。"));
        QCOMPARE(pendingCount(bridge, "memory:list"), 0);

        bridge.deleteMemory("memory-1");
        bridge.event(frame("memory:result", controlId(bridge, "memory:delete"),
                           {{"ok", true}, {"memory_id", "memory-1"}, {"deleted", false}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "memory:list"), 0);

        bridge.decideMemoryCandidate("mc_" + QString(32, 'a'), true);
        bridge.event(frame("memory:candidates:result", controlId(bridge, "memory:candidates:confirm"),
                           {{"ok", true}, {"id", "memory-2"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(), QString("已记住这条。"));
        QCOMPARE(bridge.state().value("candidates").toMap().value("candidates").toList().size(), 1);
        QCOMPARE(pendingCount(bridge, "memory:candidates:list"), 1);

        bridge.editMemory("memory-1", "用户喜欢：月亮");
        bridge.event(frame("error", controlId(bridge, "memory:edit"), {{"message", "内部错误"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(),
                 QString("修改记忆未完成，记忆没有改动；可刷新后核对。"));
    }
    static QJsonArray memoryRows(int first, int count) {
        QJsonArray rows;
        for (int n = first; n < first + count; ++n)
            rows.append(QJsonObject{{"id", QString("memory-%1").arg(n)}, {"text", QString("记忆 %1").arg(n)},
                                    {"pinned", false}});
        return rows;
    }
    static QJsonObject memoryPage(const QJsonArray &rows, bool hasMore, const QString &cursor = {},
                                  const QString &query = {}) {
        QJsonObject page{{"ok", true}, {"memories", rows}, {"has_more", hasMore}, {"query", query}};
        page["next_cursor"] = hasMore ? QJsonValue(cursor) : QJsonValue();
        return page;
    }
    static int shownMemories(const RuntimeBridge &bridge) {
        return bridge.state().value("memory").toMap().value("memories").toList().size();
    }
    static QString candidateId(int n) {
        return "mc_" + QString("%1").arg(n, 32, 16, QLatin1Char('0'));
    }
    static QJsonArray candidateRows(int first, int count) {
        QJsonArray rows;
        for (int n = first; n < first + count; ++n)
            rows.append(QJsonObject{{"id", candidateId(n)}, {"created_at", 100000.0 - n},
                {"proposed_text", QString("候选 %1").arg(n)}, {"source_text", "用户原话"}, {"status", "pending"}});
        return rows;
    }
    static QJsonObject candidatePage(const QJsonArray &rows, bool more = false,
                                     const QString &cursor = {}) {
        return {{"ok", true}, {"status", "pending"}, {"candidates", rows}, {"has_more", more},
                {"next_cursor", more ? QJsonValue(cursor) : QJsonValue(QJsonValue::Null)}};
    }
    static QVariantList shownCandidates(const RuntimeBridge &bridge) {
        return bridge.state().value("candidates").toMap().value("candidates").toList();
    }
    static void deliverCandidate(RuntimeBridge &bridge, const QList<QJsonObject> &frames,
                                 const QJsonObject &payload) {
        bridge.event(frame("memory:candidates:result",
            lastCommand(frames, "memory:candidates:list")["requestId"].toString(), payload));
    }
    static void knownBatchMemories(RuntimeBridge &bridge, const QJsonArray &rows = memoryRows(1, 3),
                                    bool hasMore = false) {
        const auto id = bridge.startMemoryList();
        bridge.event(frame("memory:result", id,
            memoryPage(rows, hasMore, hasMore ? QString("v1.batch-next") : QString(), bridge.memoryQuery())));
        QCOMPARE(shownMemories(bridge), rows.size());
    }
    static QString batchPinStatus(const RuntimeBridge &bridge) {
        return bridge.memoryBatchPin().value("status").toString();
    }
    static QJsonObject pinSnapshot(const QVariantList &ids, bool pinned, int total,
                                   const QVariantList &stale = {}) {
        QJsonArray states;
        for (const auto &id : ids)
            if (!stale.contains(id))
                states.append(QJsonObject{{"memory_id", id.toString()}, {"pinned", pinned}});
        return {{"ok", true}, {"memory_ids", QJsonArray::fromVariantList(ids)},
            {"states", states}, {"stale_ids", QJsonArray::fromVariantList(stale)},
            {"pinned_total", total}, {"pin_limit", 20}};
    }
    static QJsonObject pinReceipt(const QVariantList &ids, bool pinned, int before,
                                  const QVariantList &unchanged = {}) {
        QJsonArray changed;
        for (const auto &id : ids)
            if (!unchanged.contains(id))
                changed.append(id.toString());
        return {{"ok", true}, {"memory_ids", QJsonArray::fromVariantList(ids)}, {"pinned", pinned},
            {"changed_ids", changed}, {"unchanged_ids", QJsonArray::fromVariantList(unchanged)},
            {"pinned_total_before", before},
            {"pinned_total_after", before + (pinned ? int(changed.size()) : -int(changed.size()))},
            {"pin_limit", 20}};
    }
    static void knownPinPreview(RuntimeBridge &bridge, const QVariantList &ids,
                                 bool pinned = true, int total = 0) {
        bridge.previewMemoryPins(ids, pinned);
        QCOMPARE(batchPinStatus(bridge), QString("previewing"));
        const auto id = bridge.memoryBatchPin().value("previewRequestId").toString();
        QVERIFY(!id.isEmpty());
        bridge.event(frame("memory:result", id, pinSnapshot(ids, !pinned, total)));
        QCOMPARE(batchPinStatus(bridge), QString("ready"));
    }
    static QJsonArray pinnedMemoryRows(int first, int count, const QVariantList &pinned) {
        auto rows = memoryRows(first, count);
        for (qsizetype i = 0; i < rows.size(); ++i) {
            auto row = rows[i].toObject();
            row["pinned"] = pinned.contains(QVariant(row["id"].toString()));
            rows[i] = row;
        }
        return rows;
    }
    void memoryBatchPinPrechecks_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"disconnected", "readonly", "restoring", "persona-changing",
                 "empty", "too-many", "duplicate", "missing", "not-string", "invalid-id", "ambiguous-id",
                 "not-live", "query-changed", "list-pending", "more-pending", "single-write", "raw-write", "batch-delete",
                 "candidate-pending", "candidate-unknown"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void memoryBatchPinPrechecks() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        QVariantList selected{QString("memory-1"), QString("memory-2")};
        if (condition == "disconnected") bridge.m_connected = false;
        if (condition == "readonly") bridge.m_runtimeWritable = false;
        if (condition == "restoring") bridge.m_backupRestoring = true;
        if (condition == "persona-changing") bridge.m_personaSwitch = {{"requestId", "switch-pending"}};
        if (condition == "empty") selected.clear();
        if (condition == "too-many") {
            selected.clear();
            for (int i = 1; i <= 101; ++i) selected << QString("memory-%1").arg(i);
        }
        if (condition == "duplicate") selected = {QString("memory-1"), QString("memory-1")};
        if (condition == "missing") selected = {QString("not-shown")};
        if (condition == "not-string") selected = {1};
        if (condition == "invalid-id") {
            selected = {QString("memory/1")};
            bridge.m_state["memory"] = QVariantMap{{"memories", QVariantList{QVariantMap{{"id", "memory/1"}}}}};
        }
        if (condition == "ambiguous-id")
            bridge.m_state["memory"] = QVariantMap{{"memories", QVariantList{
                QVariantMap{{"id", "memory-1"}}, QVariantMap{{"id", "memory-1"}}}}};
        if (condition == "not-live") bridge.m_memoryListLive = false;
        if (condition == "query-changed") bridge.m_memoryQuery = "new-filter-with-old-rows";
        if (condition == "list-pending") bridge.startMemoryList();
        if (condition == "more-pending") {
            bridge.m_memoryMoreId = "more-pending";
            pending(bridge, "more-pending", "memory:list", bridge.generation());
        }
        if (condition == "single-write") bridge.setMemoryPinned("memory-1", true);
        if (condition == "raw-write") bridge.request("memory:edit", {{"memory_id", "memory-1"}, {"text", "draft"}});
        if (condition == "batch-delete") bridge.deleteMemories(selected);
        if (condition.startsWith("candidate-"))
            bridge.m_candidateDecision = {{"status", condition.section('-', 1)}, {"requestId", "candidate-write"}};
        const auto before = frames->size();
        const auto action = memoryReceipt(bridge, "action");
        bridge.previewMemoryPins(selected, true);
        bridge.confirmMemoryPins();
        QCOMPARE(frames->size(), before);
        QCOMPARE(commandCount(*frames, "memory:pin_status"), 0);
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
        QVERIFY(!bridge.memoryBatchPin().value("confirmationReady").toBool());
        QCOMPARE(memoryReceipt(bridge, "action"), action);
    }
    void memoryBatchPinRequestRejectsUnboundAndCoercedPayloads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        QVERIFY(bridge.request("memory:pin_status", {{"memory_ids", ids}}).isEmpty());
        QVERIFY(bridge.request("memory:pin_many", {{"memory_ids", ids}, {"pinned", true}}).isEmpty());
        knownPinPreview(bridge, ids);
        const auto context = bridge.m_memoryBatchPin;
        bridge.m_memoryBatchPin["status"] = "sending";
        for (const auto &payload : QList<QVariantMap>{{}, {{"memory_ids", ids}},
                 {{"memory_ids", ids}, {"pinned", 1}}, {{"memory_ids", ids}, {"pinned", "true"}},
                 {{"memory_ids", ids}, {"pinned", false}},
                 {{"memory_ids", QVariantList{QString("memory-2"), QString("memory-1")}}, {"pinned", true}},
                 {{"memory_ids", QStringList{"memory-1", "memory-2"}}, {"pinned", true}},
                 {{"memory_ids", ids}, {"pinned", true}, {"extra", false}}})
            QVERIFY(bridge.request("memory:pin_many", payload).isEmpty());
        bridge.m_memoryBatchPin["listRevision"] = bridge.memoryListRevision() - 1;
        QVERIFY(bridge.request("memory:pin_many", {{"memory_ids", ids}, {"pinned", true}}).isEmpty());
        bridge.m_memoryBatchPin = context;
        bridge.m_memoryBatchPin["status"] = "sending";
        bridge.m_memoryBatchPin["generation"] = bridge.generation() - 1;
        QVERIFY(bridge.request("memory:pin_many", {{"memory_ids", ids}, {"pinned", true}}).isEmpty());
        bridge.m_memoryBatchPin = context;
        bridge.m_memoryBatchPin["status"] = "sending";
        bridge.m_memoryBatchPin["scopeKey"] = "wrong-scope";
        QVERIFY(bridge.request("memory:pin_many", {{"memory_ids", ids}, {"pinned", true}}).isEmpty());
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
        QCOMPARE(commandCount(*frames, "memory:pin_status"), 1);
    }
    void memoryBatchPinPreviewRejectsMalformedSnapshots_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        const auto valid = pinSnapshot(ids, false, 18);
        const auto row = [&](const char *name, const QString &key, const QJsonValue &value) {
            auto payload = valid;
            payload[key] = value;
            QTest::newRow(name) << QString("memory:result") << payload;
        };
        row("numeric-ok", "ok", 1);
        row("missing-echo", "memory_ids", QJsonValue(QJsonValue::Undefined));
        row("wrong-id", "memory_ids", QJsonArray{"memory-1", "memory-3"});
        row("reordered-ids", "memory_ids", QJsonArray{"memory-2", "memory-1"});
        row("missing-state", "states", QJsonArray{QJsonObject{{"memory_id", "memory-1"}, {"pinned", false}}});
        row("duplicate-state", "states", QJsonArray{
            QJsonObject{{"memory_id", "memory-1"}, {"pinned", false}},
            QJsonObject{{"memory_id", "memory-1"}, {"pinned", false}}});
        row("coerced-state", "states", QJsonArray{
            QJsonObject{{"memory_id", "memory-1"}, {"pinned", 0}},
            QJsonObject{{"memory_id", "memory-2"}, {"pinned", false}}});
        row("foreign-state", "states", QJsonArray{
            QJsonObject{{"memory_id", "memory-1"}, {"pinned", false}},
            QJsonObject{{"memory_id", "memory-3"}, {"pinned", false}}});
        row("overlapping-stale", "stale_ids", QJsonArray{"memory-2"});
        row("foreign-stale", "stale_ids", QJsonArray{"foreign-id"});
        row("duplicate-stale", "stale_ids", QJsonArray{"memory-2", "memory-2"});
        row("missing-stale-array", "stale_ids", QJsonValue(QJsonValue::Undefined));
        row("total-string", "pinned_total", "18");
        row("total-negative", "pinned_total", -1);
        row("total-fraction", "pinned_total", 1.5);
        auto understated = pinSnapshot(ids, true, 1);
        QTest::newRow("total-below-selected-pins") << QString("memory:result") << understated;
        row("wrong-limit", "pin_limit", 21);
        row("error-on-success", "error", "unconfirmed");
        row("code-on-success", "error_code", "internal_error");
        QTest::newRow("wrong-event-type") << QString("runtime:activity") << valid;
        QTest::newRow("stale-selection") << QString("memory:result")
            << pinSnapshot(ids, false, 18, {QString("memory-2")});
    }
    void memoryBatchPinPreviewRejectsMalformedSnapshots() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const auto original = bridge.state();
        bridge.previewMemoryPins({QString("memory-1"), QString("memory-2")}, true);
        const auto id = bridge.memoryBatchPin().value("previewRequestId").toString();
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(batchPinStatus(bridge), QString("preview_error"));
        QVERIFY(!bridge.memoryBatchPin().value("confirmationReady").toBool());
        QVERIFY(!bridge.memoryBatchPin().value("blocked").toBool());
        bridge.confirmMemoryPins();
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
        QCOMPARE(bridge.state(), original);
        QVERIFY(!bridge.m_pending.contains(id));
    }
    void memoryBatchPinPreviewUsesCurrentGlobalCapacityAndNoop_data() {
        QTest::addColumn<bool>("pinned");
        QTest::addColumn<bool>("current");
        QTest::addColumn<int>("total");
        QTest::addColumn<int>("expectedChanged");
        QTest::addColumn<bool>("canConfirm");
        QTest::newRow("exact-global-capacity") << true << false << 18 << 2 << true;
        QTest::newRow("hidden-global-capacity-full") << true << false << 19 << 2 << false;
        QTest::newRow("legacy-over-capacity") << true << false << 24 << 2 << false;
        QTest::newRow("noop-at-capacity") << true << true << 20 << 0 << false;
        QTest::newRow("noop-above-capacity") << true << true << 24 << 0 << false;
        QTest::newRow("unpin-above-capacity") << false << true << 24 << 2 << true;
        QTest::newRow("unpin-noop") << false << false << 0 << 0 << false;
    }
    void memoryBatchPinPreviewUsesCurrentGlobalCapacityAndNoop() {
        QFETCH(bool, pinned); QFETCH(bool, current); QFETCH(int, total);
        QFETCH(int, expectedChanged); QFETCH(bool, canConfirm);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge); // All shown rows are unpinned; the fresh full-catalog read decides.
        const QVariantList ids{QString("memory-2"), QString("memory-1")};
        bridge.previewMemoryPins(ids, pinned);
        bridge.event(frame("memory:result", bridge.memoryBatchPin().value("previewRequestId").toString(),
                           pinSnapshot(ids, current, total)));
        const auto preview = bridge.memoryBatchPin();
        QCOMPARE(preview.value("ids").toList(), ids);
        QCOMPARE(preview.value("selectedCount").toInt(), 2);
        QCOMPARE(preview.value("expectedChangedCount").toInt(), expectedChanged);
        QCOMPARE(preview.value("unchangedCount").toInt(), 2 - expectedChanged);
        QCOMPARE(preview.value("pinnedTotal").toInt(), total);
        QCOMPARE(preview.value("pinLimit").toInt(), 20);
        QCOMPARE(preview.value("confirmationReady").toBool(), canConfirm);
        bridge.confirmMemoryPins();
        bridge.confirmMemoryPins();
        QCOMPARE(commandCount(*frames, "memory:pin_many"), canConfirm ? 1 : 0);
        if (canConfirm) {
            const auto write = lastCommand(*frames, "memory:pin_many");
            QCOMPARE(write["memory_ids"].toArray(), QJsonArray::fromVariantList(ids));
            QVERIFY(write["pinned"].isBool());
            QCOMPARE(write["pinned"].toBool(), pinned);
        } else {
            QCOMPARE(batchPinStatus(bridge), QString("ready"));
        }
    }
    void memoryBatchPinReceipts_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        const auto valid = pinReceipt(ids, true, 17);
        QTest::newRow("success") << QString("memory:result") << valid << QString("reading");
        QTest::newRow("actual-differs-from-preview") << QString("memory:result")
            << pinReceipt(ids, true, 18, {QString("memory-2")}) << QString("reading");
        const auto bad = [&](const char *name, const QString &key, const QJsonValue &value) {
            auto payload = valid;
            payload[key] = value;
            QTest::newRow(name) << QString("memory:result") << payload << QString("unknown");
        };
        bad("numeric-ok", "ok", 1);
        bad("missing-echo", "memory_ids", QJsonValue(QJsonValue::Undefined));
        bad("old-ids", "memory_ids", QJsonArray{"memory-1", "memory-3"});
        bad("reordered-ids", "memory_ids", QJsonArray{"memory-2", "memory-1"});
        bad("numeric-pinned", "pinned", 1);
        bad("wrong-direction", "pinned", false);
        bad("duplicate-changed", "changed_ids", QJsonArray{"memory-1", "memory-1"});
        bad("missing-target", "changed_ids", QJsonArray{"memory-1"});
        bad("foreign-target", "changed_ids", QJsonArray{"memory-1", "memory-3"});
        bad("overlapping-partition", "unchanged_ids", QJsonArray{"memory-1"});
        bad("reordered-changed", "changed_ids", QJsonArray{"memory-2", "memory-1"});
        bad("string-total", "pinned_total_before", "17");
        bad("negative-total", "pinned_total_before", -1);
        bad("fractional-total", "pinned_total_after", 19.5);
        bad("invalid-arithmetic", "pinned_total_after", 18);
        auto overCap = valid;
        overCap["pinned_total_before"] = 20;
        overCap["pinned_total_after"] = 22;
        QTest::newRow("new-pin-over-cap") << QString("memory:result") << overCap << QString("unknown");
        bad("missing-limit", "pin_limit", QJsonValue(QJsonValue::Undefined));
        bad("wrong-limit", "pin_limit", 21);
        bad("internal-on-success", "error_code", "internal_error");
        QTest::newRow("wrong-event-type") << QString("runtime:activity") << valid << QString("unknown");
        for (const auto &code : QStringList{"stale_selection", "pin_limit_exceeded", "memory_unavailable",
                                            "internal_error", "invalid_payload", "stale_persona"})
            QTest::newRow(qPrintable(code)) << QString("memory:result")
                << QJsonObject{{"ok", false}, {"error_code", code}, {"error", "refused"}}
                << (QStringList{"stale_selection", "pin_limit_exceeded", "memory_unavailable"}.contains(code)
                    ? QString("rejected") : QString("unknown"));
        QTest::newRow("rejection-with-write-evidence") << QString("memory:result")
            << QJsonObject{{"ok", false}, {"error_code", "stale_selection"}, {"changed_ids", QJsonArray{}}}
            << QString("unknown");
    }
    void memoryBatchPinReceipts() {
        QFETCH(QString, eventType); QFETCH(QJsonObject, payload); QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        knownPinPreview(bridge, ids, true, 17);
        const auto originalRows = bridge.state().value("memory");
        const auto originalScope = bridge.scopeKey();
        bridge.confirmMemoryPins();
        const auto id = bridge.memoryBatchPin().value("requestId").toString();
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(batchPinStatus(bridge), status);
        QCOMPARE(bridge.state().value("memory"), originalRows); // A receipt never edits rows.
        QCOMPARE(bridge.scopeKey(), originalScope);
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
        QCOMPARE(commandCount(*frames, "memory:pin_status"), status == "reading" ? 2 : 1);
        QCOMPARE(commandCount(*frames, "memory:list"), status == "reading" ? 2 : 1);
        QVERIFY(!bridge.memoryBatchPin().value("confirmationReady").toBool());
        const auto settled = bridge.memoryBatchPin();
        bridge.event(frame("memory:result", id, pinReceipt(ids, true, 17)));
        QCOMPARE(bridge.memoryBatchPin(), settled);
        bridge.confirmMemoryPins();
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
    }
    void memoryBatchPinReadBarrierCoversOffscreenTargets_data() {
        QTest::addColumn<bool>("listFirst");
        QTest::addColumn<bool>("pinned");
        QTest::newRow("pin-status-first") << false << true;
        QTest::newRow("pin-list-first") << true << true;
        QTest::newRow("unpin-status-first") << false << false;
        QTest::newRow("unpin-list-first") << true << false;
    }
    void memoryBatchPinReadBarrierCoversOffscreenTargets() {
        QFETCH(bool, listFirst); QFETCH(bool, pinned);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.m_memoryQuery = "记忆";
        knownBatchMemories(bridge, memoryRows(1, 100), true);
        bridge.loadMoreMemories();
        bridge.event(frame("memory:result", bridge.m_memoryMoreId,
                           memoryPage(memoryRows(101, 100), false, {}, "记忆")));
        QCOMPARE(shownMemories(bridge), 200);
        const QVariantList ids{QString("memory-147"), QString("memory-3")};
        const int before = pinned ? 18 : 24;
        knownPinPreview(bridge, ids, pinned, before);
        const auto oldRevision = bridge.memoryListRevision();
        bool observedOwnedRevision = false;
        connect(&bridge, &RuntimeBridge::changed, this, [&] {
            if (bridge.memoryListRevision() == oldRevision + 1) {
                const auto pin = bridge.memoryBatchPin();
                if (pin.value("status").toString() == "reading") {
                    observedOwnedRevision = true;
                    QVERIFY(pin.value("preserveSelection").toBool());
                    QCOMPARE(pin.value("listRevision").toInt(), bridge.memoryListRevision());
                    QVERIFY(!pin.value("listReadId").toString().isEmpty());
                }
            }
        });
        bridge.confirmMemoryPins();
        const auto write = bridge.memoryBatchPin().value("requestId").toString();
        bridge.event(frame("memory:result", write, pinReceipt(ids, pinned, before)));
        QVERIFY(observedOwnedRevision);
        QCOMPARE(batchPinStatus(bridge), QString("reading"));
        const auto state = bridge.memoryBatchPin();
        const auto statusId = state.value("statusReadId").toString(), listId = state.value("listReadId").toString();
        QCOMPARE(lastCommand(*frames, "memory:pin_status")["memory_ids"].toArray(), QJsonArray::fromVariantList(ids));
        const auto list = lastCommand(*frames, "memory:list");
        QCOMPARE(list["limit"].toInt(), 100);
        QCOMPARE(list["query"].toString(), QString("记忆"));
        QVERIFY(!list.contains("cursor"));
        const int after = before + (pinned ? 2 : -2);
        const auto deliverStatus = [&] { bridge.event(frame("memory:result", statusId, pinSnapshot(ids, pinned, after))); };
        const auto deliverList = [&] {
            bridge.event(frame("memory:result", listId, memoryPage(pinnedMemoryRows(1, 100,
                pinned ? ids : QVariantList{}), true, "v1.after-pin", "记忆")));
        };
        if (listFirst) deliverList(); else deliverStatus();
        QCOMPARE(batchPinStatus(bridge), QString("reading"));
        QVERIFY(bridge.memoryBatchPin().value("blocked").toBool());
        if (listFirst) deliverStatus(); else deliverList();
        QCOMPARE(batchPinStatus(bridge), QString("success"));
        QCOMPARE(bridge.memoryBatchPin().value("actualChangedCount").toInt(), 2);
        QCOMPARE(bridge.memoryBatchPin().value("pinnedTotal").toInt(), after);
        QVERIFY(!bridge.memoryBatchPin().value("preserveSelection").toBool());
        QVERIFY(!bridge.memoryBatchPin().value("blocked").toBool());
        QCOMPARE(shownMemories(bridge), 100); // Target147 was verified by the full-ID read.
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 0);
    }
    void memoryBatchPinReadFailuresKeepUnknown_data() {
        QTest::addColumn<QString>("failure");
        for (const auto &name : QStringList{"status-timeout", "list-timeout", "status-error", "list-error",
                 "missing-offscreen-state", "wrong-target-state", "stale-target", "visible-disagrees",
                 "visible-pinned-number", "status-wrong-type", "list-wrong-type", "list-missing-ok",
                 "status-fails-after-list", "list-fails-after-status"})
            QTest::newRow(qPrintable(name)) << name;
    }
    void memoryBatchPinReadFailuresKeepUnknown() {
        QFETCH(QString, failure);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        knownPinPreview(bridge, ids);
        bridge.confirmMemoryPins();
        bridge.event(frame("memory:result", bridge.memoryBatchPin().value("requestId").toString(), pinReceipt(ids, true, 0)));
        const auto read = bridge.memoryBatchPin();
        const auto statusId = read.value("statusReadId").toString(), listId = read.value("listReadId").toString();
        auto status = pinSnapshot(ids, true, 2);
        auto rows = pinnedMemoryRows(1, 1, ids); // ID2 is outside the filtered first page.
        if (failure == "status-timeout") bridge.expirePending(statusId);
        else if (failure == "list-timeout") bridge.expirePending(listId);
        else if (failure == "status-error") bridge.event(frame("error", statusId, {{"error", "unavailable"}}));
        else if (failure == "list-error") bridge.event(frame("error", listId, {{"error", "unavailable"}}));
        else if (failure == "status-fails-after-list") {
            bridge.event(frame("memory:result", listId, memoryPage(rows, false)));
            bridge.event(frame("error", statusId, {{"error", "unavailable"}}));
        } else if (failure == "list-fails-after-status") {
            bridge.event(frame("memory:result", statusId, status));
            bridge.event(frame("error", listId, {{"error", "unavailable"}}));
        } else {
            if (failure == "missing-offscreen-state")
                status["states"] = QJsonArray{QJsonObject{{"memory_id", "memory-1"}, {"pinned", true}}};
            if (failure == "wrong-target-state") status = pinSnapshot(ids, false, 0);
            if (failure == "stale-target") status = pinSnapshot(ids, true, 1, {QString("memory-2")});
            if (failure == "visible-disagrees" || failure == "visible-pinned-number") {
                auto row = rows[0].toObject();
                row["pinned"] = failure == "visible-disagrees" ? QJsonValue(false) : QJsonValue(1);
                rows[0] = row;
            }
            bridge.event(frame(failure == "status-wrong-type" ? "runtime:activity" : "memory:result", statusId, status));
            auto page = memoryPage(rows, false);
            if (failure == "list-missing-ok") page.remove("ok");
            bridge.event(frame(failure == "list-wrong-type" ? "persona:scope" : "memory:result", listId, page));
        }
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryBatchPin().value("blocked").toBool());
        QVERIFY(!bridge.memoryBatchPin().value("busy").toBool());
        QVERIFY(!bridge.m_pending.contains(statusId));
        QVERIFY(!bridge.m_pending.contains(listId));
        QVERIFY(memoryReceipt(bridge, "list").value("status").toString() != "pending");
        const auto terminal = bridge.memoryBatchPin();
        bridge.event(frame("memory:result", statusId, pinSnapshot(ids, true, 2)));
        bridge.event(frame("memory:result", listId, memoryPage(pinnedMemoryRows(1, 2, ids), false)));
        QCOMPARE(bridge.memoryBatchPin(), terminal);
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
    }
    void memoryBatchPinUnknownRequiresFreshManualBothReadsAfterReconnect() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        knownPinPreview(bridge, ids);
        bridge.confirmMemoryPins();
        const auto write = bridge.memoryBatchPin().value("requestId").toString();
        bridge.expirePending(write);
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        bridge.event(frame("memory:result", write, pinReceipt(ids, true, 0)));
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        bridge.m_process.finished(1, QProcess::CrashExit);
        const int statusCount = commandCount(*frames, "memory:pin_status"), listCount = commandCount(*frames, "memory:list");
        bridge.refreshMemories();
        QCOMPARE(commandCount(*frames, "memory:pin_status"), statusCount);
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", "persona-current"}, {"personaEpoch", 3}, {"personaFingerprint", "fingerprint-current"},
            {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
        QVERIFY(bridge.connected());
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        QCOMPARE(commandCount(*frames, "memory:pin_status"), statusCount);
        QCOMPARE(commandCount(*frames, "memory:list"), listCount);
        bridge.refreshMemories();
        const auto first = bridge.memoryBatchPin();
        QCOMPARE(first.value("generation").toInt(), bridge.generation());
        const auto firstStatus = first.value("statusReadId").toString(), firstList = first.value("listReadId").toString();
        bridge.expirePending(firstStatus);
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        bridge.refreshMemories();
        const auto second = bridge.memoryBatchPin();
        const auto secondStatus = second.value("statusReadId").toString(), secondList = second.value("listReadId").toString();
        QVERIFY(firstStatus != secondStatus && firstList != secondList);
        bridge.event(frame("memory:result", firstStatus, pinSnapshot(ids, true, 2)));
        bridge.event(frame("memory:result", firstList, memoryPage(pinnedMemoryRows(1, 2, ids), false)));
        QCOMPARE(batchPinStatus(bridge), QString("reading"));
        const int sent = frames->size();
        bridge.refreshMemories();
        QCOMPARE(frames->size(), sent);
        // A deleted target and a remaining unpinned target form a valid current
        // state. They cannot prove the earlier mutation succeeded.
        bridge.event(frame("memory:result", secondStatus, pinSnapshot(ids, false, 0, {QString("memory-2")})));
        QCOMPARE(batchPinStatus(bridge), QString("reading"));
        bridge.event(frame("memory:result", secondList, memoryPage(memoryRows(1, 1), false)));
        QCOMPARE(batchPinStatus(bridge), QString("refreshed"));
        QVERIFY(!bridge.memoryBatchPin().value("blocked").toBool());
        QVERIFY(!bridge.memoryBatchPin().value("confirmationReady").toBool());
        QVERIFY(bridge.memoryBatchPin().value("text").toString().contains("未确认为成功"));
        bridge.event(frame("memory:result", write, pinReceipt(ids, true, 0)));
        QCOMPARE(batchPinStatus(bridge), QString("refreshed"));
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
    }
    void memoryBatchPinLocksOtherMemoryRoutesAndKeepsTheirReceipts_data() {
        QTest::addColumn<QString>("phase");
        for (const auto &phase : QStringList{"previewing", "ready", "pending", "reading", "unknown"})
            QTest::newRow(qPrintable(phase)) << phase;
    }
    void memoryBatchPinLocksOtherMemoryRoutesAndKeepsTheirReceipts() {
        QFETCH(QString, phase);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge, memoryRows(1, 3), true);
        const QVariantList ids{QString("memory-1"), QString("memory-2")};
        bridge.previewMemoryPins(ids, true);
        if (phase != "previewing")
            bridge.event(frame("memory:result", bridge.memoryBatchPin().value("previewRequestId").toString(), pinSnapshot(ids, false, 0)));
        if (QStringList{"pending", "reading", "unknown"}.contains(phase)) bridge.confirmMemoryPins();
        if (phase == "reading")
            bridge.event(frame("memory:result", bridge.memoryBatchPin().value("requestId").toString(), pinReceipt(ids, true, 0)));
        if (phase == "unknown") bridge.expirePending(bridge.memoryBatchPin().value("requestId").toString());
        const auto action = memoryReceipt(bridge, "action");
        const auto current = bridge.memoryBatchPin();
        const auto revision = bridge.memoryListRevision();
        const auto count = frames->size();
        bridge.setMemoryPinned("memory-1", false);
        bridge.editMemory("memory-1", "new draft");
        bridge.deleteMemory("memory-1");
        bridge.deleteMemories(ids);
        bridge.decideMemoryCandidate(candidateId(1), true);
        bridge.decideMemoryCandidate(candidateId(1), false);
        bridge.loadMoreMemories();
        bridge.loadNextMemoryCandidates();
        bridge.firstMemoryCandidates();
        bridge.filterMemories("new query");
        for (const auto &command : QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                 "memory:candidates:confirm", "memory:candidates:reject", "memory:candidates:list", "memory:list"})
            QVERIFY(bridge.request(command).isEmpty());
        QCOMPARE(frames->size(), count);
        QCOMPARE(bridge.memoryListRevision(), revision);
        QCOMPARE(memoryReceipt(bridge, "action"), action);
        QCOMPARE(bridge.memoryBatchPin(), current);
        if (QStringList{"pending", "reading", "unknown"}.contains(phase)) {
            bridge.cancelMemoryPinPreview();
            QCOMPARE(bridge.memoryBatchPin(), current);
        }
    }
    void memoryBatchPinPreviewCancellationOldIdsAndScopeNeverAuthorizeWrite() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList oldIds{QString("memory-1")}, newIds{QString("memory-2")};
        bridge.previewMemoryPins(oldIds, true);
        const auto old = bridge.memoryBatchPin().value("previewRequestId").toString();
        bridge.cancelMemoryPinPreview();
        QCOMPARE(batchPinStatus(bridge), QString("idle"));
        bridge.previewMemoryPins(newIds, true);
        const auto fresh = bridge.memoryBatchPin().value("previewRequestId").toString();
        bridge.event(frame("memory:result", old, pinSnapshot(oldIds, false, 0)));
        QCOMPARE(batchPinStatus(bridge), QString("previewing"));
        auto foreign = pinSnapshot(newIds, false, 0);
        foreign["persona_id"] = "other-persona";
        bridge.event(frame("memory:result", fresh, foreign));
        QVERIFY(bridge.m_pending.contains(fresh));
        QCOMPARE(batchPinStatus(bridge), QString("previewing"));
        bridge.event(frame("memory:result", fresh, pinSnapshot(newIds, false, 0)));
        ++bridge.m_memoryListRevision;
        bridge.confirmMemoryPins();
        QCOMPARE(batchPinStatus(bridge), QString("preview_error"));
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
        bridge.previewMemoryPins(newIds, true);
        bridge.event(frame("persona:scope", "", {{"persona_id", "new-persona"}, {"epoch", 4},
                                                   {"fingerprint", "new-fingerprint"}}));
        QCOMPARE(batchPinStatus(bridge), QString("idle"));
        bridge.event(frame("memory:result", fresh, pinSnapshot(newIds, false, 0)));
        QCOMPARE(batchPinStatus(bridge), QString("idle"));
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
    }
    void memoryBatchPinTransportFailureAndPreviewTimeoutNeverClaimSuccess() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1")};
        bridge.previewMemoryPins(ids, true);
        bridge.expirePending(bridge.memoryBatchPin().value("previewRequestId").toString());
        QCOMPARE(batchPinStatus(bridge), QString("preview_error"));
        knownPinPreview(bridge, ids);
        bridge.m_frameWriter = [](const QByteArray &) -> qint64 { return -1; };
        bridge.confirmMemoryPins();
        QCOMPARE(batchPinStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryBatchPin().value("blocked").toBool());
        QVERIFY(!bridge.memoryBatchPin().value("requestId").toString().isEmpty());
        QCOMPARE(bridge.memoryBatchPin().value("dispatchCount").toULongLong(), 0ULL);
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 0);
    }
    void memoryBatchPinUnpinsHundredLoadedTargetsAboveLegacyLimit() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        QVariantList ids;
        for (int i = 100; i > 0; --i) ids << QString("memory-%1").arg(i);
        knownBatchMemories(bridge, pinnedMemoryRows(1, 100, ids));
        knownPinPreview(bridge, ids, false, 130);
        QVERIFY(bridge.memoryBatchPin().value("confirmationReady").toBool());
        QCOMPARE(bridge.memoryBatchPin().value("expectedChangedCount").toInt(), 100);
        bridge.confirmMemoryPins();
        const auto write = bridge.memoryBatchPin().value("requestId").toString();
        QCOMPARE(lastCommand(*frames, "memory:pin_many")["memory_ids"].toArray(), QJsonArray::fromVariantList(ids));
        bridge.event(frame("memory:result", write, pinReceipt(ids, false, 130)));
        const auto read = bridge.memoryBatchPin();
        bridge.event(frame("memory:result", read.value("statusReadId").toString(), pinSnapshot(ids, false, 30)));
        bridge.event(frame("memory:result", read.value("listReadId").toString(), memoryPage(memoryRows(1, 100), false)));
        QCOMPARE(batchPinStatus(bridge), QString("success"));
        QCOMPARE(bridge.memoryBatchPin().value("actualChangedCount").toInt(), 100);
        QCOMPARE(bridge.memoryBatchPin().value("pinnedTotal").toInt(), 30);
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
    }
    void memoryBatchPinScopeChangeDropsWriteAndReadOwnership_data() {
        QTest::addColumn<QString>("phase");
        QTest::newRow("pending") << QString("pending");
        QTest::newRow("reading") << QString("reading");
        QTest::newRow("unknown") << QString("unknown");
    }
    void memoryBatchPinScopeChangeDropsWriteAndReadOwnership() {
        QFETCH(QString, phase);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantList ids{QString("memory-1")};
        knownPinPreview(bridge, ids);
        bridge.confirmMemoryPins();
        const auto write = bridge.memoryBatchPin().value("requestId").toString();
        if (phase == "reading") bridge.event(frame("memory:result", write, pinReceipt(ids, true, 0)));
        if (phase == "unknown") bridge.expirePending(write);
        const auto previous = bridge.memoryBatchPin();
        bridge.event(frame("persona:scope", "", {{"persona_id", "new-persona"}, {"epoch", 4},
                                                   {"fingerprint", "new-fingerprint"}}));
        QCOMPARE(batchPinStatus(bridge), QString("idle"));
        QVERIFY(!bridge.memoryBatchPin().value("blocked").toBool());
        const auto current = bridge.memoryBatchPin();
        bridge.event(frame("memory:result", write, pinReceipt(ids, true, 0)));
        bridge.event(frame("memory:result", previous.value("statusReadId").toString(), pinSnapshot(ids, true, 1)));
        bridge.event(frame("memory:result", previous.value("listReadId").toString(), memoryPage(memoryRows(1, 1), false)));
        QCOMPARE(bridge.memoryBatchPin(), current);
        QVERIFY(!bridge.state().contains("memory"));
        QCOMPARE(commandCount(*frames, "memory:pin_many"), 1);
    }
    void memoryBatchDeletePrechecks_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"disconnected", "readonly", "restoring", "empty",
                 "too-many", "duplicate", "missing", "not-string", "invalid-id", "ambiguous-id",
                 "action-pending", "raw-action-pending", "candidate-pending", "candidate-unknown"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void memoryBatchDeletePrechecks() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        QVariantList selected{QString("memory-1"), QString("memory-2")};
        if (condition == "disconnected") bridge.m_connected = false;
        if (condition == "readonly") bridge.m_runtimeWritable = false;
        if (condition == "restoring") bridge.m_backupRestoring = true;
        if (condition == "empty") selected.clear();
        if (condition == "too-many") {
            selected.clear();
            for (int n = 1; n <= 101; ++n) selected.append(QString("memory-%1").arg(n));
        }
        if (condition == "duplicate") selected = {QString("memory-1"), QString("memory-1")};
        if (condition == "missing") selected = {QString("memory-outside")};
        if (condition == "not-string") selected = {1};
        if (condition == "invalid-id") {
            selected = {QString("memory/invalid")};
            bridge.m_state["memory"] = QVariantMap{{"memories", QVariantList{
                QVariantMap{{"id", "memory/invalid"}}}}};
        }
        if (condition == "ambiguous-id")
            bridge.m_state["memory"] = QVariantMap{{"memories", QVariantList{
                QVariantMap{{"id", "memory-1"}}, QVariantMap{{"id", "memory-1"}}}}};
        if (condition == "action-pending") bridge.deleteMemory("memory-1");
        if (condition == "raw-action-pending") bridge.request("memory:delete", {{"memory_id", "memory-1"}});
        if (condition.startsWith("candidate-"))
            bridge.m_candidateDecision = {{"status", condition.section('-', 1)}, {"requestId", "candidate-action"}};
        const auto action = memoryReceipt(bridge, "action");
        const auto before = frames->size();
        bridge.deleteMemories(selected);
        bridge.deleteMemories(selected);
        QCOMPARE(frames->size(), before);
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 0);
        QVERIFY(!bridge.memoryBatchDelete().value("blocked").toBool());
        QCOMPARE(bridge.diagnostics().value("memoryBatchDelete").toMap().value("dispatchCount").toULongLong(), 0ULL);
        if (condition == "action-pending" || condition == "raw-action-pending") {
            QCOMPARE(memoryReceipt(bridge, "action"), action);
            QCOMPARE(pendingCount(bridge, "memory:delete"), 1);
            if (condition == "action-pending") QVERIFY(bridge.memoryRequestPending("action"));
        } else if (condition.startsWith("candidate-")) {
            QVERIFY(bridge.memoryCandidatePage().value("decisionLocked").toBool());
        } else {
            QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        }
    }
    void memoryBatchDeleteSendsOnlyItsBoundIdsAndOneRequest() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge, memoryRows(1, 100));
        const QVariantList selected{QString("memory-3"), QString("memory-1"), QString("memory-2")};
        // request() cannot bypass the explicit batch entry point.
        QVERIFY(bridge.request("memory:delete_many", {{"memory_ids", selected}}).isEmpty());
        bridge.deleteMemories(selected);
        bridge.deleteMemories(selected);
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 1);
        const auto batch = lastCommand(*frames, "memory:delete_many");
        auto body = batch;
        const auto requestId = body.take("requestId").toString();
        QCOMPARE(body, (QJsonObject{{"memory_ids", QJsonArray::fromVariantList(selected)}}));
        QVERIFY(!requestId.isEmpty());
        QCOMPARE(bridge.memoryBatchDelete().value("requestId").toString(), requestId);
        QCOMPARE(bridge.memoryBatchDelete().value("scopeKey").toString(), bridge.scopeKey());
        QCOMPARE(bridge.memoryBatchDelete().value("generation").toInt(), bridge.generation());
        QVERIFY(bridge.memoryBatchDelete().value("busy").toBool());
        QVERIFY(bridge.memoryBatchDelete().value("blocked").toBool());
        QCOMPARE(bridge.m_memoryBatchDelete.value("memoryIds").toList(), selected);
        const auto diagnostic = bridge.diagnostics().value("memoryBatchDelete").toMap();
        QCOMPARE(diagnostic.value("ids").toList(), selected);
        QCOMPARE(diagnostic.value("count").toInt(), 3);
        QCOMPARE(diagnostic.value("dispatchCount").toULongLong(), 1ULL);
        QVERIFY(!QJsonDocument::fromVariant(diagnostic).toJson().contains("记忆 1"));
        // The upper boundary is accepted too, in the caller's original order.
        bridge.expirePending(requestId);
        bridge.refreshMemories();
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(1, 100), false)));
        QVariantList hundred;
        for (int n = 100; n > 0; --n) hundred.append(QString("memory-%1").arg(n));
        bridge.deleteMemories(hundred);
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 2);
        QCOMPARE(lastCommand(*frames, "memory:delete_many")["memory_ids"].toArray(),
                 QJsonArray::fromVariantList(hundred));
    }
    void memoryBatchDeleteRequestRejectsUnboundPayloads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const QVariantList ids{QString("memory-1")};
        const auto context = QVariantMap{{"status", "sending"}, {"memoryIds", ids},
            {"scopeKey", bridge.scopeKey()}, {"generation", bridge.generation()}};
        bridge.m_memoryBatchDelete = context;
        for (const auto &payload : QList<QVariantMap>{{}, {{"memory_ids", QVariantList{}}},
                 {{"memory_ids", QVariantList{QString("memory-2")}}},
                 {{"memory_ids", ids}, {"extra", true}}, {{"memory_ids", QStringList{"memory-1"}}}})
            QVERIFY(bridge.request("memory:delete_many", payload).isEmpty());
        bridge.m_memoryBatchDelete["scopeKey"] = "different-scope";
        QVERIFY(bridge.request("memory:delete_many", {{"memory_ids", ids}}).isEmpty());
        bridge.m_memoryBatchDelete = context;
        bridge.m_memoryBatchDelete["generation"] = bridge.generation() - 1;
        QVERIFY(bridge.request("memory:delete_many", {{"memory_ids", ids}}).isEmpty());
        bridge.m_memoryBatchDelete = context;
        bridge.m_runtimeWritable = false;
        QVERIFY(bridge.request("memory:delete_many", {{"memory_ids", ids}}).isEmpty());
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 0);
    }
    void memoryBatchDeleteReceipts_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        QTest::addColumn<QString>("expectedText");
        const QString successText("已删除2条记忆。");
        const QString staleSelectionText("所选记忆已有变化，没有删除任何一条；已刷新列表。");
        const QString rejectionText("批量删除未执行，没有删除任何一条；已刷新列表。");
        const QString unknownText("批量删除结果未知，请手动刷新核对；未自动重试。");
        const QJsonArray ids{"memory-2", "memory-1"};
        const auto success = QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"purged_revisions", 3}};
        QTest::newRow("success") << "memory:result" << success << "success" << successText;
        QTest::newRow("stale-selection") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "stale_selection"}, {"stale_ids", QJsonArray{"memory-1"}}}
            << "rejected" << staleSelectionText;
        QTest::newRow("memory-unavailable") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "memory_unavailable"}} << "rejected" << rejectionText;
        QTest::newRow("explicit-rejection") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "BACKUP_RECOVERY_REQUIRED"}} << "rejected" << rejectionText;
        QTest::newRow("stale-persona-error-code") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "stale_persona"}} << "rejected" << rejectionText;
        for (const auto &code : QStringList{"BACKUP_RECOVERY_REQUIRED", "stale_persona",
                 "runtime_capability_unavailable", "persona_restart_required"})
            QTest::newRow(qPrintable("prewrite-code-" + code)) << "memory:result"
                << QJsonObject{{"ok", false}, {"code", code}, {"retryable", false}} << "rejected" << rejectionText;
        QTest::newRow("stale-persona-with-new-backend-proof") << "memory:result"
            << QJsonObject{{"ok", false}, {"code", "stale_persona"}, {"retryable", false},
                 {"persona_id", "new-persona"}, {"persona_epoch", 4}, {"persona_fingerprint", "new-proof"}}
            << "rejected" << rejectionText;
        QTest::newRow("wrong-type") << "memory:candidates:result" << success << "unknown" << unknownText;
        QTest::newRow("wrong-global-activity-type") << "runtime:activity" << success << "unknown" << unknownText;
        QTest::newRow("wrong-identity-type") << "persona:scope" << success << "unknown" << unknownText;
        QTest::newRow("generic-error") << "error"
            << QJsonObject{{"ok", false}, {"error_code", "stale_selection"}} << "unknown" << unknownText;
        QTest::newRow("internal-error") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "internal_error"}} << "unknown" << unknownText;
        QTest::newRow("missing-ok") << "memory:result" << QJsonObject{{"deleted_ids", ids}} << "unknown" << unknownText;
        QTest::newRow("nonboolean-ok") << "memory:result"
            << QJsonObject{{"ok", 1}, {"deleted_ids", ids}} << "unknown" << unknownText;
        QTest::newRow("missing-deleted-ids") << "memory:result" << QJsonObject{{"ok", true}} << "unknown" << unknownText;
        QTest::newRow("reordered-ids") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray{"memory-1", "memory-2"}}} << "unknown" << unknownText;
        QTest::newRow("duplicate-ids") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray{"memory-2", "memory-2"}}} << "unknown" << unknownText;
        QTest::newRow("extra-id") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray{"memory-2", "memory-1", "memory-3"}}} << "unknown" << unknownText;
        QTest::newRow("wrong-id-type") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray{2, "memory-1"}}} << "unknown" << unknownText;
        QTest::newRow("contradictory-success") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"error", "private error"}} << "unknown" << unknownText;
        QTest::newRow("success-with-internal-code") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"code", "internal_error"}} << "unknown" << unknownText;
        QTest::newRow("success-with-error-code") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"error_code", "stale_selection"}} << "unknown" << unknownText;
        QTest::newRow("success-with-prewrite-code") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"code", "stale_persona"}} << "unknown" << unknownText;
        QTest::newRow("invalid-purged-count") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"purged_revisions", -1}} << "unknown" << unknownText;
        QTest::newRow("purged-count-smaller-than-selection") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"purged_revisions", 1}} << "unknown" << unknownText;
        QTest::newRow("noninteger-purged-count") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"purged_revisions", 1.5}} << "unknown" << unknownText;
        QTest::newRow("nonnumeric-purged-count") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"purged_revisions", "2"}} << "unknown" << unknownText;
        QTest::newRow("payload-request-mismatch") << "memory:result"
            << QJsonObject{{"ok", true}, {"deleted_ids", ids}, {"request_id", "other-request"}} << "unknown" << unknownText;
        QTest::newRow("prewrite-request-mismatch") << "memory:result"
            << QJsonObject{{"ok", false}, {"code", "BACKUP_RECOVERY_REQUIRED"}, {"request_id", "other-request"}} << "unknown" << unknownText;
        QTest::newRow("prewrite-with-deletion-result") << "memory:result"
            << QJsonObject{{"ok", false}, {"code", "BACKUP_RECOVERY_REQUIRED"}, {"deleted_ids", ids}} << "unknown" << unknownText;
        QTest::newRow("prewrite-with-conflicting-error-code") << "memory:result"
            << QJsonObject{{"ok", false}, {"code", "BACKUP_RECOVERY_REQUIRED"}, {"error_code", "internal_error"}} << "unknown" << unknownText;
        QTest::newRow("prewrite-with-malformed-retryable") << "memory:result"
            << QJsonObject{{"ok", false}, {"code", "BACKUP_RECOVERY_REQUIRED"}, {"retryable", "false"}} << "unknown" << unknownText;
        QTest::newRow("rejection-with-contradictory-deletion-result") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", "stale_selection"}, {"deleted_ids", ids}} << "unknown" << unknownText;
        for (const auto &code : QStringList{"command_terminal", "storage_unavailable", "idempotency_conflict"})
            QTest::newRow(qPrintable("uncertain-code-" + code)) << "memory:result"
                << QJsonObject{{"ok", false}, {"code", code}} << "unknown" << unknownText;
        QTest::newRow("prewrite-code-on-generic-error") << "error"
            << QJsonObject{{"ok", false}, {"code", "BACKUP_RECOVERY_REQUIRED"}} << "unknown" << unknownText;
        QTest::newRow("rejection-without-code") << "memory:result" << QJsonObject{{"ok", false}} << "unknown" << unknownText;
        QTest::newRow("rejection-with-nonstring-code") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", 1}} << "unknown" << unknownText;
        QTest::newRow("rejection-with-blank-code") << "memory:result"
            << QJsonObject{{"ok", false}, {"error_code", " "}} << "unknown" << unknownText;
    }
    void memoryBatchDeleteReceipts() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QFETCH(QString, status);
        QFETCH(QString, expectedText);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const auto rows = bridge.state().value("memory");
        bridge.deleteMemories({QString("memory-2"), QString("memory-1")});
        const auto id = controlId(bridge, "memory:delete_many");
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(bridge.memoryBatchDelete().value("status").toString(), status);
        QCOMPARE(bridge.memoryBatchDelete().value("blocked").toBool(), status == "unknown");
        QVERIFY(!bridge.memoryBatchDelete().value("busy").toBool());
        QCOMPARE(bridge.state().value("memory"), rows); // Never optimistically remove rows.
        QCOMPARE(pendingCount(bridge, "memory:delete_many"), 0);
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 1);
        QCOMPARE(commandCount(*frames, "memory:list"), status == "unknown" ? 1 : 2);
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), status == "unknown" ? 0 : 1);
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(), expectedText);
        const auto diagnostic = bridge.diagnostics().value("memoryBatchDelete").toMap();
        if (status != "unknown") {
            const auto read = lastCommand(*frames, "memory:list")["requestId"].toString();
            QCOMPARE(diagnostic.value("readRequestId").toString(), read);
            const auto result = status == "success" ? memoryRows(3, 1) : memoryRows(1, 3);
            bridge.event(frame("memory:result", read, memoryPage(result, false)));
            QCOMPARE(shownMemories(bridge), result.size());
            QCOMPARE(bridge.diagnostics().value("memoryBatchDelete").toMap().value("readRequestId").toString(), read);
        }
        const auto count = frames->size();
        bridge.event(frame(eventType, id, payload));
        bridge.expirePending(id);
        QCOMPARE(frames->size(), count);
        QCOMPARE(bridge.memoryBatchDelete().value("status").toString(), status);
    }
    void memoryBatchDeleteUnknownNeedsASuccessfulExplicitRefresh() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge, memoryRows(1, 3), true);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.next"));
        bridge.deleteMemories({QString("memory-1")});
        const auto id = controlId(bridge, "memory:delete_many");
        const auto beforePending = frames->size();
        bridge.refreshMemories();
        bridge.filterMemories("blocked");
        bridge.loadMoreMemories();
        QCOMPARE(frames->size(), beforePending);
        bridge.expirePending(id);
        QVERIFY(bridge.memoryBatchDelete().value("unknown").toBool());
        const auto before = frames->size();
        bridge.deleteMemories({QString("memory-2")});
        bridge.deleteMemory("memory-2");
        bridge.editMemory("memory-2", "changed");
        bridge.editMemory("memory-2", " ");
        bridge.setMemoryPinned("memory-2", true);
        bridge.decideMemoryCandidate(candidateId(1), true);
        bridge.decideMemoryCandidate(candidateId(1), false);
        bridge.filterMemories("blocked");
        bridge.loadMoreMemories();
        bridge.loadNextMemoryCandidates();
        bridge.firstMemoryCandidates();
        for (const auto &command : QStringList{"memory:edit", "memory:delete", "memory:reinforce",
                 "memory:candidates:confirm", "memory:candidates:reject"})
            QVERIFY(bridge.request(command, {{"memory_id", "memory-2"}, {"op", "pin"}}).isEmpty());
        QCOMPARE(frames->size(), before);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
        QCOMPARE(bridge.memoryQuery(), QString());
        // Read-only related recall remains available, and automatic reads cannot unlock.
        bridge.queryRelatedMemories("夜空");
        QCOMPARE(commandCount(*frames, "memory:query"), 1);
        bridge.readMemories(true);
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(1, 3), false)));
        QVERIFY(bridge.memoryBatchDelete().value("unknown").toBool());
        bridge.event(frame("memory:result", id,
            {{"ok", true}, {"deleted_ids", QJsonArray{"memory-1"}}, {"purged_revisions", 1}}));
        QVERIFY(bridge.memoryBatchDelete().value("unknown").toBool());
        bridge.refreshMemories();
        const auto failed = bridge.m_memoryListId;
        const auto refreshCount = commandCount(*frames, "memory:list");
        bridge.refreshMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), refreshCount);
        bridge.event(frame("memory:result", failed, {{"ok", false}, {"memories", QJsonArray{}}}));
        QVERIFY(bridge.memoryBatchDelete().value("blocked").toBool());
        bridge.refreshMemories();
        bridge.expirePending(bridge.m_memoryListId);
        QVERIFY(bridge.memoryBatchDelete().value("blocked").toBool());
        bridge.refreshMemories();
        auto malformed = memoryPage(memoryRows(1, 3), false);
        malformed.remove("ok");
        bridge.event(frame("memory:result", bridge.m_memoryListId, malformed));
        QVERIFY(bridge.memoryBatchDelete().value("blocked").toBool());
        bridge.refreshMemories();
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(2, 2), false)));
        QCOMPARE(bridge.memoryBatchDelete().value("status").toString(), QString("refreshed"));
        QVERIFY(!bridge.memoryBatchDelete().value("blocked").toBool());
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 1);
        bridge.deleteMemory("memory-2");
        QCOMPARE(commandCount(*frames, "memory:delete"), 1);
    }
    void memoryBatchDeleteDisconnectAndTransportFailureStayUnknown() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBatchMemories(bridge);
        bridge.deleteMemories({QString("memory-1")});
        const auto id = controlId(bridge, "memory:delete_many");
        const auto revision = bridge.memoryListRevision();
        QSignalSpy failures(&bridge, &RuntimeBridge::requestFailed);
        QVERIFY(QMetaObject::invokeMethod(&bridge.m_process, "finished", Qt::DirectConnection,
            Q_ARG(int, 1), Q_ARG(QProcess::ExitStatus, QProcess::NormalExit)));
        QVERIFY(bridge.memoryListRevision() > revision);
        QVERIFY(bridge.memoryBatchDelete().value("unknown").toBool());
        QCOMPARE(failures.count(), 1);
        QCOMPARE(failures.first().at(0).toString(), id);
        QCOMPARE(failures.first().at(1).toString(), QString("disconnected"));
        // Reconnection reads may update rows, but never settle the old write.
        online(bridge);
        ++bridge.m_generation;
        knownBatchMemories(bridge);
        QVERIFY(bridge.memoryBatchDelete().value("blocked").toBool());
        bridge.refreshMemories();
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(1, 3), false)));
        QVERIFY(!bridge.memoryBatchDelete().value("blocked").toBool());
        bridge.m_frameWriter = [](const QByteArray &) -> qint64 { return -1; };
        bridge.deleteMemories({QString("memory-2")});
        QVERIFY(bridge.memoryBatchDelete().value("unknown").toBool());
        QCOMPARE(pendingCount(bridge, "memory:delete_many"), 0);
        QCOMPARE(bridge.diagnostics().value("memoryBatchDelete").toMap().value("dispatchCount").toULongLong(), 1ULL);
    }
    void memoryBatchDeleteIgnoresForeignAndOldIdentityReceipts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        bridge.deleteMemories({QString("memory-1")});
        const auto id = controlId(bridge, "memory:delete_many");
        const auto result = QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray{"memory-1"}},
            {"purged_revisions", 1}};
        auto foreign = result;
        foreign["persona_id"] = "other-persona";
        bridge.event(frame("memory:result", id, foreign));
        QVERIFY(bridge.m_pending.contains(id));
        QCOMPARE(bridge.memoryBatchDelete().value("status").toString(), QString("pending"));
        const auto revision = bridge.memoryListRevision();
        bridge.event(frame("persona:scope", {}, {{"persona_id", "next"}, {"epoch", 4}, {"fingerprint", "next-proof"}}));
        QVERIFY(bridge.memoryListRevision() > revision);
        QCOMPARE(bridge.memoryBatchDelete().value("status").toString(), QString("idle"));
        const auto before = frames->size();
        bridge.event(frame("memory:result", id, result));
        QCOMPARE(frames->size(), before);
        knownBatchMemories(bridge, memoryRows(10, 2));
        bridge.deleteMemories({QString("memory-10")});
        const auto current = bridge.memoryBatchDelete();
        bridge.event(frame("memory:result", id, result));
        QCOMPARE(bridge.memoryBatchDelete(), current);
        const auto freshId = controlId(bridge, "memory:delete_many");
        ++bridge.m_generation;
        bridge.event(frame("memory:result", freshId,
            {{"ok", true}, {"deleted_ids", QJsonArray{"memory-10"}}, {"purged_revisions", 1}}));
        QCOMPARE(bridge.memoryBatchDelete(), current);
    }
    void memoryListRevisionChangesOnReplacementAndKeepsAppendSelections() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const auto initial = bridge.memoryListRevision();
        knownBatchMemories(bridge, memoryRows(1, 2), true);
        const auto first = bridge.memoryListRevision();
        QVERIFY(first > initial);
        bridge.loadMoreMemories();
        QCOMPARE(bridge.memoryListRevision(), first);
        bridge.event(frame("memory:result", bridge.m_memoryMoreId, memoryPage(memoryRows(3, 2), false)));
        QCOMPARE(bridge.memoryListRevision(), first);
        bridge.filterMemories("月亮");
        const auto filtered = bridge.memoryListRevision();
        QVERIFY(filtered > first);
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(1, 1), false, {}, "月亮")));
        QCOMPARE(bridge.memoryListRevision(), filtered);
        bridge.filterMemories("");
        QVERIFY(bridge.memoryListRevision() > filtered);
        bridge.event(frame("memory:result", bridge.m_memoryListId, memoryPage(memoryRows(1, 2), false)));
        const auto cleared = bridge.memoryListRevision();
        bridge.refreshMemories();
        QVERIFY(bridge.memoryListRevision() > cleared);
        QCOMPARE(commandCount(*frames, "memory:delete_many"), 0);
    }
    static QString candidateBatchStatus(const RuntimeBridge &bridge) {
        return bridge.memoryCandidateBatch().value("status").toString();
    }
    // Every outcome list follows selection order, as the backend writes them.
    static QJsonObject candidateSnapshot(const QVariantList &ids, const QString &status = "pending",
                                         const QVariantList &replace = {}, const QVariantList &same = {},
                                         const QVariantList &pinned = {}, const QJsonArray &conflicts = {}) {
        QJsonArray states, pendingIds, stale, fresh, replaced, sameIds, pinnedIds;
        for (const auto &value : ids) {
            const auto id = value.toString();
            states.append(QJsonObject{{"candidate_id", id}, {"status", status}});
            if (status != "pending") {
                stale.append(id);
                continue;
            }
            pendingIds.append(id);
            (replace.contains(value) ? replaced : same.contains(value) ? sameIds : fresh).append(id);
            if (pinned.contains(value))
                pinnedIds.append(id);
        }
        return {{"ok", true}, {"candidate_ids", QJsonArray::fromVariantList(ids)}, {"states", states},
            {"pending_ids", pendingIds}, {"stale_ids", stale}, {"new_ids", fresh}, {"replace_ids", replaced},
            {"same_ids", sameIds}, {"replaced_pinned_ids", pinnedIds}, {"conflict_groups", conflicts}};
    }
    static QString batchMemoryId(const QString &candidate) { return "fact_" + candidate.mid(3); }
    static QJsonObject candidateReceipt(const QVariantList &ids, bool confirm, const QVariantList &replace = {},
                                        const QVariantList &same = {}) {
        QJsonObject result{{"ok", true}, {"candidate_ids", QJsonArray::fromVariantList(ids)},
                           {"decision", confirm ? "confirm" : "reject"}};
        if (!confirm) {
            result["rejected_ids"] = QJsonArray::fromVariantList(ids);
            return result;
        }
        QJsonArray confirmed, fresh, replaced, sameIds;
        for (const auto &value : ids) {
            const auto id = value.toString();
            const bool isSame = same.contains(value), isReplace = replace.contains(value);
            confirmed.append(QJsonObject{{"candidate_id", id},
                {"memory_id", isSame ? QString("memory-1") : batchMemoryId(id)},
                {"replaced_memory_id", isReplace ? QString("memory-2") : QString()}, {"idempotent", isSame}});
            (isSame ? sameIds : isReplace ? replaced : fresh).append(id);
        }
        result.insert("confirmed", confirmed);
        result.insert("new_ids", fresh);
        result.insert("replace_ids", replaced);
        result.insert("same_ids", sameIds);
        result.insert("replaced_pinned_ids", QJsonArray{});
        return result;
    }
    static QVariantList batchCandidates(int count) {
        QVariantList ids;
        for (int n = 1; n <= count; ++n)
            ids << candidateId(n);
        return ids;
    }
    static void knownCandidates(RuntimeBridge &bridge, const QList<QJsonObject> &frames, int count = 3) {
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, frames, candidatePage(candidateRows(1, count)));
        QCOMPARE(shownCandidates(bridge).size(), count);
    }
    static void knownCandidatePreview(RuntimeBridge &bridge, const QVariantList &ids, bool confirm,
                                      const QJsonObject &snapshot) {
        bridge.previewCandidateDecisions(ids, confirm);
        QCOMPARE(candidateBatchStatus(bridge), QString("previewing"));
        const auto id = bridge.memoryCandidateBatch().value("previewRequestId").toString();
        QVERIFY(!id.isEmpty());
        bridge.event(frame("memory:candidates:result", id, snapshot));
        QCOMPARE(candidateBatchStatus(bridge), QString("ready"));
    }
    // The memory page after a confirmation: new revisions first, then older rows.
    static QJsonObject confirmedMemoryPage(const QVariantList &ids, const QVariantList &skip = {}) {
        QJsonArray rows;
        for (const auto &value : ids)
            if (!skip.contains(value))
                rows.append(QJsonObject{{"id", batchMemoryId(value.toString())}, {"text", "新记忆"}, {"pinned", false}});
        rows.append(QJsonObject{{"id", "memory-1"}, {"text", "记忆 1"}, {"pinned", false}});
        return memoryPage(rows, false);
    }
    void candidateBatchPrechecks_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"disconnected", "readonly", "persona-changing", "empty", "too-many",
                 "duplicate", "missing", "not-string", "memory-id", "not-live", "needs-refresh", "read-pending",
                 "single-decision", "batch-pin", "batch-delete", "memory-action"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void candidateBatchPrechecks() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        auto selected = batchCandidates(2);
        if (condition == "disconnected") bridge.m_connected = false;
        if (condition == "readonly") bridge.m_runtimeWritable = false;
        if (condition == "persona-changing") bridge.m_personaSwitch = {{"requestId", "switch-pending"}};
        if (condition == "empty") selected.clear();
        if (condition == "too-many") {
            selected.clear();
            for (int n = 1; n <= 101; ++n) selected << candidateId(n);
        }
        if (condition == "duplicate") selected = {candidateId(1), candidateId(1)};
        if (condition == "missing") selected = {candidateId(9)};
        if (condition == "not-string") selected = {1};
        if (condition == "memory-id") selected = {QString("memory-1")};
        if (condition == "not-live") bridge.m_candidateLive = false;
        if (condition == "needs-refresh") bridge.m_candidateNeedsRefresh = true;
        if (condition == "read-pending") {
            bridge.m_candidateReadId = "read-pending";
            pending(bridge, "read-pending", "memory:candidates:list", bridge.generation());
        }
        if (condition == "single-decision") bridge.m_candidateDecision = {{"status", "pending"}, {"requestId", "single"}};
        if (condition == "batch-pin") bridge.m_memoryBatchPin = {{"status", "ready"}};
        if (condition == "batch-delete") bridge.m_memoryBatchDelete = {{"status", "pending"}};
        if (condition == "memory-action") bridge.setMemoryPinned("memory-1", true);
        const auto before = frames->size();
        bridge.previewCandidateDecisions(selected, true);
        bridge.confirmCandidateDecisions();
        QCOMPARE(frames->size(), before);
        QCOMPARE(commandCount(*frames, "memory:candidates:status"), 0);
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 0);
        QVERIFY(!bridge.memoryCandidateBatch().value("confirmationReady").toBool());
    }
    void candidateBatchRequestRejectsUnboundPayloads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        QVERIFY(bridge.request("memory:candidates:status", {{"candidate_ids", ids}}).isEmpty());
        QVERIFY(bridge.request("memory:candidates:decide_many", {{"candidate_ids", ids}, {"decision", "confirm"}}).isEmpty());
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        const auto context = bridge.m_candidateBatch;
        bridge.m_candidateBatch["status"] = "sending";
        for (const auto &payload : QList<QVariantMap>{{}, {{"candidate_ids", ids}},
                 {{"candidate_ids", ids}, {"decision", "Confirm"}}, {{"candidate_ids", ids}, {"decision", true}},
                 {{"candidate_ids", ids}, {"decision", "reject"}},
                 {{"candidate_ids", QVariantList{candidateId(2), candidateId(1)}}, {"decision", "confirm"}},
                 {{"candidate_ids", QStringList{candidateId(1), candidateId(2)}}, {"decision", "confirm"}},
                 {{"candidate_ids", ids}, {"decision", "confirm"}, {"extra", false}}})
            QVERIFY(bridge.request("memory:candidates:decide_many", payload).isEmpty());
        for (const auto &[key, value] : QList<QPair<QString, QVariant>>{
                 {"candidateRevision", bridge.m_candidateRevision - 1}, {"generation", bridge.generation() - 1},
                 {"scopeKey", QString("wrong-scope")}}) {
            bridge.m_candidateBatch = context;
            bridge.m_candidateBatch["status"] = "sending";
            bridge.m_candidateBatch[key] = value;
            QVERIFY(bridge.request("memory:candidates:decide_many",
                                   {{"candidate_ids", ids}, {"decision", "confirm"}}).isEmpty());
        }
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 0);
        QCOMPARE(commandCount(*frames, "memory:candidates:status"), 1);
    }
    void candidateBatchPreviewRejectsMalformedSnapshots_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        const auto ids = batchCandidates(2);
        const auto first = candidateId(1), second = candidateId(2);
        const auto valid = candidateSnapshot(ids);
        const auto row = [&](const char *name, const QString &key, const QJsonValue &value) {
            auto payload = valid;
            payload[key] = value;
            QTest::newRow(name) << QString("memory:candidates:result") << payload;
        };
        row("numeric-ok", "ok", 1);
        row("missing-echo", "candidate_ids", QJsonValue(QJsonValue::Undefined));
        row("reordered-echo", "candidate_ids", QJsonArray{second, first});
        row("missing-state", "states", QJsonArray{QJsonObject{{"candidate_id", first}, {"status", "pending"}}});
        row("duplicate-state", "states", QJsonArray{QJsonObject{{"candidate_id", first}, {"status", "pending"}},
                                                    QJsonObject{{"candidate_id", first}, {"status", "pending"}}});
        row("unknown-status", "states", QJsonArray{QJsonObject{{"candidate_id", first}, {"status", "deleted"}},
                                                   QJsonObject{{"candidate_id", second}, {"status", "pending"}}});
        row("pending-also-stale", "stale_ids", QJsonArray{second});
        row("outcome-gap", "new_ids", QJsonArray{first});
        row("outcome-overlap", "same_ids", QJsonArray{first});
        row("reordered-outcome", "new_ids", QJsonArray{second, first});
        row("pinned-outside-replace", "replaced_pinned_ids", QJsonArray{first});
        row("foreign-conflict", "conflict_groups", QJsonArray{QJsonArray{first, candidateId(9)}});
        row("single-member-conflict", "conflict_groups", QJsonArray{QJsonArray{first}});
        row("error-on-success", "error", "unconfirmed");
        row("code-on-success", "error_code", "internal_error");
        QTest::newRow("wrong-event-type") << QString("memory:result") << valid;
        QTest::newRow("stale-selection") << QString("memory:candidates:result") << candidateSnapshot(ids, "confirmed");
    }
    void candidateBatchPreviewRejectsMalformedSnapshots() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto original = bridge.state();
        bridge.previewCandidateDecisions(batchCandidates(2), true);
        const auto id = bridge.memoryCandidateBatch().value("previewRequestId").toString();
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(candidateBatchStatus(bridge), QString("preview_error"));
        QVERIFY(!bridge.memoryCandidateBatch().value("confirmationReady").toBool());
        QVERIFY(!bridge.memoryCandidateBatch().value("blocked").toBool());
        bridge.confirmCandidateDecisions();
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 0);
        QCOMPARE(bridge.state(), original);
        QVERIFY(!bridge.m_pending.contains(id));
    }
    void candidateBatchPreviewCountsReplacementsAndConflicts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(3);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids, "pending", {candidateId(2)},
                                                                   {candidateId(3)}, {candidateId(2)}));
        auto preview = bridge.memoryCandidateBatch();
        QCOMPARE(preview.value("selectedCount").toInt(), 3);
        QCOMPARE(preview.value("newCount").toInt(), 1);
        QCOMPARE(preview.value("replaceCount").toInt(), 1);
        QCOMPARE(preview.value("sameCount").toInt(), 1);
        QCOMPARE(preview.value("replacedPinnedCount").toInt(), 1);
        QCOMPARE(preview.value("conflictCount").toInt(), 0);
        QVERIFY(preview.value("confirmationReady").toBool());
        QVERIFY(preview.value("text").toString().isEmpty());
        bridge.cancelCandidateBatchPreview();
        QCOMPARE(candidateBatchStatus(bridge), QString("idle"));
        const QJsonArray conflict{QJsonArray{candidateId(1), candidateId(2)}};
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids, "pending", {}, {}, {}, conflict));
        preview = bridge.memoryCandidateBatch();
        QCOMPARE(preview.value("conflictCount").toInt(), 2);
        QVERIFY(!preview.value("confirmationReady").toBool());
        QVERIFY(preview.value("text").toString().contains("同一事实"));
        bridge.confirmCandidateDecisions();
        QCOMPARE(candidateBatchStatus(bridge), QString("ready"));
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 0);
        bridge.cancelCandidateBatchPreview();
        // Rejection never revises a fact, so a shared fact does not block it.
        knownCandidatePreview(bridge, ids, false, candidateSnapshot(ids, "pending", {}, {}, {}, conflict));
        QCOMPARE(bridge.memoryCandidateBatch().value("conflictCount").toInt(), 0);
        QVERIFY(bridge.memoryCandidateBatch().value("confirmationReady").toBool());
        bridge.confirmCandidateDecisions();
        bridge.confirmCandidateDecisions();
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
        const auto write = lastCommand(*frames, "memory:candidates:decide_many");
        QCOMPARE(write["candidate_ids"].toArray(), QJsonArray::fromVariantList(ids));
        QCOMPARE(write["decision"].toString(), QString("reject"));
    }
    void candidateBatchReceipts_data() {
        QTest::addColumn<bool>("confirm");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        const auto ids = batchCandidates(2);
        const auto first = candidateId(1), second = candidateId(2);
        const auto valid = candidateReceipt(ids, true);
        QTest::newRow("confirm-success") << true << valid << QString("reading");
        QTest::newRow("confirm-mixed-outcomes") << true << candidateReceipt(ids, true, {second}, {first})
                                                << QString("reading");
        QTest::newRow("reject-success") << false << candidateReceipt(ids, false) << QString("reading");
        const auto bad = [&](const char *name, const QString &key, const QJsonValue &value) {
            auto payload = valid;
            payload[key] = value;
            QTest::newRow(name) << true << payload << QString("unknown");
        };
        bad("numeric-ok", "ok", 1);
        bad("missing-echo", "candidate_ids", QJsonValue(QJsonValue::Undefined));
        bad("reordered-echo", "candidate_ids", QJsonArray{second, first});
        bad("wrong-decision", "decision", "reject");
        bad("short-confirmed", "confirmed", QJsonArray{valid["confirmed"].toArray().first()});
        bad("reordered-confirmed", "confirmed", QJsonArray{valid["confirmed"].toArray()[1], valid["confirmed"].toArray()[0]});
        bad("outcome-gap", "new_ids", QJsonArray{first});
        auto unlistedSame = valid;
        auto entries = unlistedSame["confirmed"].toArray();
        auto sameEntry = entries[0].toObject();
        sameEntry["idempotent"] = true;
        entries[0] = sameEntry;
        unlistedSame["confirmed"] = entries;
        QTest::newRow("idempotent-not-listed-same") << true << unlistedSame << QString("unknown");
        bad("rejected-ids-on-confirm", "rejected_ids", QJsonArray::fromVariantList(ids));
        bad("internal-on-success", "error_code", "internal_error");
        auto badMemory = valid;
        auto confirmed = badMemory["confirmed"].toArray();
        auto entry = confirmed[0].toObject();
        entry["memory_id"] = "bad id";
        confirmed[0] = entry;
        badMemory["confirmed"] = confirmed;
        QTest::newRow("bad-memory-id") << true << badMemory << QString("unknown");
        auto rejectWithConfirmed = candidateReceipt(ids, false);
        rejectWithConfirmed["confirmed"] = QJsonArray{};
        QTest::newRow("reject-with-confirmed") << false << rejectWithConfirmed << QString("unknown");
        for (const auto &code : QStringList{"stale_selection", "fact_conflict", "memory_unavailable", "internal_error"})
            QTest::newRow(qPrintable("refusal-" + code)) << true
                << QJsonObject{{"ok", false}, {"error_code", code}, {"error", "refused"}}
                << (code == "internal_error" ? QString("unknown") : QString("rejected"));
        QTest::newRow("refusal-with-write-evidence") << true
            << QJsonObject{{"ok", false}, {"error_code", "stale_selection"}, {"confirmed", QJsonArray{}}}
            << QString("unknown");
        QTest::newRow("prewrite-stale-persona") << true
            << QJsonObject{{"ok", false}, {"code", "stale_persona"}, {"error", "persona changed"}}
            << QString("rejected");
    }
    void candidateBatchReceipts() {
        QFETCH(bool, confirm); QFETCH(QJsonObject, payload); QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        knownCandidatePreview(bridge, ids, confirm, candidateSnapshot(ids));
        const auto rows = bridge.state().value("candidates");
        bridge.confirmCandidateDecisions();
        const auto id = bridge.memoryCandidateBatch().value("requestId").toString();
        bridge.event(frame("memory:candidates:result", id, payload));
        QCOMPARE(candidateBatchStatus(bridge), status);
        QCOMPARE(bridge.state().value("candidates"), rows); // A receipt never edits rows.
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
        QCOMPARE(commandCount(*frames, "memory:candidates:status"), status == "reading" ? 2 : 1);
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), status == "reading" ? 2 : 1);
        QCOMPARE(commandCount(*frames, "memory:list"), status == "reading" ? 1 : 0);
        QVERIFY(!bridge.memoryCandidateBatch().value("confirmationReady").toBool());
        const auto settled = bridge.memoryCandidateBatch();
        bridge.event(frame("memory:candidates:result", id, candidateReceipt(ids, confirm)));
        QCOMPARE(bridge.memoryCandidateBatch(), settled);
        bridge.confirmCandidateDecisions();
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchReadsSettleAfterAllThreeReads_data() {
        QTest::addColumn<QString>("order");
        QTest::addColumn<bool>("confirm");
        for (const auto &order : QStringList{"status-candidates-list", "list-candidates-status", "candidates-list-status"})
            for (const bool confirm : {true, false})
                QTest::newRow(qPrintable(order + (confirm ? "-confirm" : "-reject"))) << order << confirm;
    }
    void candidateBatchReadsSettleAfterAllThreeReads() {
        QFETCH(QString, order); QFETCH(bool, confirm);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        knownCandidatePreview(bridge, ids, confirm, candidateSnapshot(ids, "pending", {candidateId(2)}));
        bridge.confirmCandidateDecisions();
        bridge.event(frame("memory:candidates:result", bridge.memoryCandidateBatch().value("requestId").toString(),
                           candidateReceipt(ids, confirm, {candidateId(2)})));
        const auto read = bridge.memoryCandidateBatch();
        QCOMPARE(read.value("status").toString(), QString("reading"));
        QVERIFY(read.value("preserveSelection").toBool());
        QCOMPARE(lastCommand(*frames, "memory:candidates:status")["candidate_ids"].toArray(), QJsonArray::fromVariantList(ids));
        QVERIFY(!lastCommand(*frames, "memory:candidates:list").contains("cursor"));
        QVERIFY(!lastCommand(*frames, "memory:list").contains("cursor"));
        const QHash<QString, std::function<void()>> deliver{
            {"status", [&] { bridge.event(frame("memory:candidates:result", read.value("statusReadId").toString(),
                candidateSnapshot(ids, confirm ? "confirmed" : "rejected"))); }},
            {"candidates", [&] { bridge.event(frame("memory:candidates:result", read.value("candidateReadId").toString(),
                candidatePage(candidateRows(3, 1)))); }},
            {"list", [&] { bridge.event(frame("memory:result", read.value("listReadId").toString(),
                confirm ? confirmedMemoryPage(ids) : memoryPage(memoryRows(1, 1), false))); }}};
        const auto steps = order.split('-');
        deliver.value(steps[0])();
        deliver.value(steps[1])();
        QCOMPARE(candidateBatchStatus(bridge), QString("reading"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        deliver.value(steps[2])();
        const auto done = bridge.memoryCandidateBatch();
        QCOMPARE(done.value("status").toString(), QString("success"));
        QVERIFY(!done.value("blocked").toBool());
        QVERIFY(!done.value("preserveSelection").toBool());
        QCOMPARE(done.value("dispatchCount").toULongLong(), 1ULL);
        QCOMPARE(done.value("statusReadDispatchCount").toULongLong(), 2ULL);
        QCOMPARE(done.value("text").toString(), confirm
            ? QString("已记住 2 条：新增 1 条，替换已有记忆 1 条，0 条与现有记忆相同未新增。")
            : QString("已不记 2 条，这些候选不会成为记忆。"));
        QCOMPARE(shownCandidates(bridge).size(), 1);
        QVERIFY(!bridge.memoryCandidatePage().value("blocked").toBool());
    }
    void candidateBatchReadMismatchesStayUnknown_data() {
        QTest::addColumn<QString>("failure");
        for (const auto &name : QStringList{"status-timeout", "candidates-timeout", "list-timeout", "status-error",
                 "candidates-error", "list-error", "still-pending", "decided-still-listed", "new-memory-missing",
                 "replaced-still-listed", "status-wrong-type"})
            QTest::newRow(qPrintable(name)) << name;
    }
    void candidateBatchReadMismatchesStayUnknown() {
        QFETCH(QString, failure);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        const QVariantList replace{candidateId(2)};
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids, "pending", replace));
        bridge.confirmCandidateDecisions();
        bridge.event(frame("memory:candidates:result", bridge.memoryCandidateBatch().value("requestId").toString(),
                           candidateReceipt(ids, true, replace)));
        const auto read = bridge.memoryCandidateBatch();
        const auto statusId = read.value("statusReadId").toString(), candidatesId = read.value("candidateReadId").toString(),
                   listId = read.value("listReadId").toString();
        auto status = candidateSnapshot(ids, "confirmed");
        auto page = candidatePage(candidateRows(3, 1));
        auto list = confirmedMemoryPage(ids);
        if (failure == "status-timeout") bridge.expirePending(statusId);
        else if (failure == "candidates-timeout") bridge.expirePending(candidatesId);
        else if (failure == "list-timeout") bridge.expirePending(listId);
        else if (failure == "status-error") bridge.event(frame("error", statusId, {{"error", "unavailable"}}));
        else if (failure == "candidates-error") bridge.event(frame("error", candidatesId, {{"error", "unavailable"}}));
        else if (failure == "list-error") bridge.event(frame("error", listId, {{"error", "unavailable"}}));
        else {
            if (failure == "still-pending") status = candidateSnapshot(ids);
            if (failure == "decided-still-listed") page = candidatePage(candidateRows(1, 3));
            if (failure == "new-memory-missing") list = confirmedMemoryPage(ids, {candidateId(1)});
            if (failure == "replaced-still-listed") {
                auto rows = list["memories"].toArray();
                rows.append(QJsonObject{{"id", "memory-2"}, {"text", "旧内容"}, {"pinned", false}});
                list["memories"] = rows;
            }
            bridge.event(frame(failure == "status-wrong-type" ? "memory:result" : "memory:candidates:result",
                               statusId, status));
            bridge.event(frame("memory:candidates:result", candidatesId, page));
            bridge.event(frame("memory:result", listId, list));
        }
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        QVERIFY(!bridge.memoryCandidateBatch().value("busy").toBool());
        QVERIFY(bridge.memoryCandidatePage().value("needsRefresh").toBool());
        for (const auto &id : {statusId, candidatesId, listId})
            QVERIFY(!bridge.m_pending.contains(id));
        const auto terminal = bridge.memoryCandidateBatch();
        bridge.event(frame("memory:candidates:result", statusId, candidateSnapshot(ids, "confirmed")));
        bridge.event(frame("memory:candidates:result", candidatesId, candidatePage(candidateRows(3, 1))));
        bridge.event(frame("memory:result", listId, confirmedMemoryPage(ids)));
        QCOMPARE(bridge.memoryCandidateBatch(), terminal);
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchUnknownNeedsManualReadsAndIgnoresLateReceipts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.confirmCandidateDecisions();
        const auto write = bridge.memoryCandidateBatch().value("requestId").toString();
        bridge.expirePending(write);
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        const int statusCount = commandCount(*frames, "memory:candidates:status");
        bridge.loadNextMemoryCandidates();
        bridge.decideMemoryCandidate(candidateId(3), true);
        QCOMPARE(commandCount(*frames, "memory:candidates:status"), statusCount);
        bridge.firstMemoryCandidates();
        const auto read = bridge.memoryCandidateBatch();
        QCOMPARE(read.value("status").toString(), QString("reading"));
        QVERIFY(read.value("manual").toBool());
        QCOMPARE(commandCount(*frames, "memory:candidates:status"), statusCount + 1);
        // A manual read accepts the current state; it cannot prove the write.
        bridge.event(frame("memory:candidates:result", read.value("statusReadId").toString(),
                           candidateSnapshot(ids, "pending")));
        bridge.event(frame("memory:candidates:result", read.value("candidateReadId").toString(),
                           candidatePage(candidateRows(1, 3))));
        QCOMPARE(candidateBatchStatus(bridge), QString("reading"));
        const int sent = frames->size();
        bridge.refreshMemories();
        QCOMPARE(frames->size(), sent);
        bridge.event(frame("memory:result", read.value("listReadId").toString(), memoryPage(memoryRows(1, 1), false)));
        QCOMPARE(candidateBatchStatus(bridge), QString("refreshed"));
        QVERIFY(!bridge.memoryCandidateBatch().value("blocked").toBool());
        QVERIFY(bridge.memoryCandidateBatch().value("text").toString().contains("未确认为成功"));
        QVERIFY(!bridge.memoryCandidatePage().value("needsRefresh").toBool());
        bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        QCOMPARE(candidateBatchStatus(bridge), QString("refreshed"));
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchListRepliesHaveExclusiveOwnership_data() {
        QTest::addColumn<bool>("candidateList");
        QTest::addColumn<QString>("failure");
        QTest::addColumn<bool>("ignored");
        for (const bool candidates : {true, false}) {
            const auto prefix = candidates ? QString("candidates-") : QString("memory-");
            for (const auto &failure : QStringList{"identity-event", "activity-event", "unrelated-event",
                     "swapped-result-type", "missing-ok", "numeric-ok", "error-on-success",
                     "error-code-on-success", "code-on-success"})
                QTest::newRow(qPrintable(prefix + failure)) << candidates << failure << false;
            for (const auto &failure : QStringList{"payload-request-id", "payload-request-id-type", "frame-request-id",
                     "frame-request-id-type", "persona-id", "persona-epoch", "persona-fingerprint"})
                QTest::newRow(qPrintable(prefix + failure)) << candidates << failure << true;
        }
    }
    void candidateBatchListRepliesHaveExclusiveOwnership() {
        QFETCH(bool, candidateList); QFETCH(QString, failure); QFETCH(bool, ignored);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.confirmCandidateDecisions();
        bridge.event(frame("memory:candidates:result", bridge.memoryCandidateBatch().value("requestId").toString(),
                           candidateReceipt(ids, true)));
        const auto read = bridge.memoryCandidateBatch();
        const auto id = read.value(candidateList ? "candidateReadId" : "listReadId").toString();
        QVERIFY(!id.isEmpty());
        auto payload = candidateList ? candidatePage(candidateRows(3, 1)) : confirmedMemoryPage(ids);
        auto type = candidateList ? QString("memory:candidates:result") : QString("memory:result");
        if (failure == "identity-event") {
            type = "persona:scope";
            payload["persona_id"] = bridge.m_persona["persona_id"];
            payload["epoch"] = bridge.m_persona["epoch"].toInt() + 1;
            payload["fingerprint"] = "forged-list-identity";
        }
        if (failure == "activity-event") {
            type = "runtime:activity";
            payload["recovery_state"] = "recovery_required";
            payload["writes_blocked"] = true;
            payload["runtime_writable"] = false;
        }
        if (failure == "unrelated-event") {
            type = "chat:history:result";
            payload["items"] = QJsonArray{QJsonObject{{"content", "unrelated-list-result"}}};
        }
        if (failure == "swapped-result-type")
            type = candidateList ? QString("memory:result") : QString("memory:candidates:result");
        if (failure == "missing-ok") payload.remove("ok");
        if (failure == "numeric-ok") payload["ok"] = 1;
        if (failure == "error-on-success") payload["error"] = "unconfirmed";
        if (failure == "error-code-on-success") payload["error_code"] = "internal_error";
        if (failure == "code-on-success") payload["code"] = "internal_error";
        if (failure == "payload-request-id") payload["request_id"] = "another-list-request";
        if (failure == "payload-request-id-type") payload["request_id"] = 7;
        if (failure == "persona-id") payload["persona_id"] = "foreign-persona";
        if (failure == "persona-epoch") payload["persona_epoch"] = bridge.m_persona["epoch"].toInt() + 1;
        if (failure == "persona-fingerprint") payload["persona_fingerprint"] = "foreign-fingerprint";
        auto reply = frame(type, id, payload);
        if (failure == "frame-request-id") reply["request_id"] = "another-list-request";
        if (failure == "frame-request-id-type") {
            payload["request_id"] = id;
            reply["payload"] = payload;
            reply["request_id"] = 7;
        }
        const auto state = bridge.state();
        const auto messages = bridge.messages();
        const auto scope = bridge.scopeKey(), recovery = bridge.m_recoveryState;
        const int generation = bridge.generation(), sent = frames->size();
        const bool writable = bridge.runtimeWritable();
        bridge.event(reply);
        QCOMPARE(bridge.scopeKey(), scope);
        QCOMPARE(bridge.generation(), generation);
        QCOMPARE(bridge.state(), state);
        QCOMPARE(bridge.messages(), messages);
        QCOMPARE(bridge.m_recoveryState, recovery);
        QCOMPARE(bridge.runtimeWritable(), writable);
        QCOMPARE(frames->size(), sent);
        if (ignored) {
            QCOMPARE(bridge.memoryCandidateBatch(), read);
            QVERIFY(bridge.m_pending.contains(id));
            // A foreign or mismatched envelope cannot consume this read.
            bridge.expirePending(id);
        }
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        const auto terminal = bridge.memoryCandidateBatch();
        bridge.event(frame("memory:candidates:result", read.value("statusReadId").toString(),
                           candidateSnapshot(ids, "confirmed")));
        bridge.event(frame("memory:candidates:result", read.value("candidateReadId").toString(),
                           candidatePage(candidateRows(3, 1))));
        bridge.event(frame("memory:result", read.value("listReadId").toString(), confirmedMemoryPage(ids)));
        QCOMPARE(bridge.memoryCandidateBatch(), terminal);
        QCOMPARE(bridge.state(), state);
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchReconnectRequiresThreeNewManualReads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(2);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.confirmCandidateDecisions();
        const auto write = bridge.memoryCandidateBatch().value("requestId").toString();
        bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        const auto old = bridge.memoryCandidateBatch();
        const auto generation = bridge.generation();
        bridge.m_process.finished(1, QProcess::CrashExit);
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", "persona-current"}, {"personaEpoch", 3}, {"personaFingerprint", "fingerprint-current"},
            {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
        QVERIFY(bridge.connected());
        QVERIFY(bridge.generation() > generation);
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        const auto state = bridge.state();
        bridge.firstMemoryCandidates();
        const auto read = bridge.memoryCandidateBatch();
        QCOMPARE(read.value("status").toString(), QString("reading"));
        QCOMPARE(read.value("generation").toInt(), bridge.generation());
        QVERIFY(read.value("manual").toBool());
        for (const auto &key : QStringList{"statusReadId", "candidateReadId", "listReadId"})
            QVERIFY(!read.value(key).toString().isEmpty() && read.value(key) != old.value(key));
        bridge.event(frame("memory:candidates:result", old.value("statusReadId").toString(),
                           candidateSnapshot(ids, "confirmed")));
        bridge.event(frame("memory:candidates:result", old.value("candidateReadId").toString(),
                           candidatePage(candidateRows(3, 1))));
        bridge.event(frame("memory:result", old.value("listReadId").toString(), confirmedMemoryPage(ids)));
        bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        QCOMPARE(bridge.memoryCandidateBatch(), read);
        QCOMPARE(bridge.state(), state);
        bridge.event(frame("memory:candidates:result", read.value("statusReadId").toString(), candidateSnapshot(ids)));
        bridge.event(frame("memory:candidates:result", read.value("candidateReadId").toString(),
                           candidatePage(candidateRows(1, 3))));
        QCOMPARE(candidateBatchStatus(bridge), QString("reading"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        bridge.event(frame("memory:result", read.value("listReadId").toString(), memoryPage(memoryRows(1, 3), false)));
        QCOMPARE(candidateBatchStatus(bridge), QString("refreshed"));
        QVERIFY(!bridge.memoryCandidateBatch().value("blocked").toBool());
        QVERIFY(bridge.memoryCandidateBatch().value("text").toString().contains("未确认为成功"));
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchLocksOtherMemoryRoutes_data() {
        QTest::addColumn<QString>("phase");
        for (const auto &phase : QStringList{"previewing", "ready", "pending", "reading", "unknown"})
            QTest::newRow(qPrintable(phase)) << phase;
    }
    void candidateBatchLocksOtherMemoryRoutes() {
        QFETCH(QString, phase);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge, memoryRows(1, 3), true);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 3), true, "mc1.next"));
        const auto ids = batchCandidates(2);
        bridge.previewCandidateDecisions(ids, true);
        if (phase != "previewing")
            bridge.event(frame("memory:candidates:result", bridge.memoryCandidateBatch().value("previewRequestId").toString(),
                               candidateSnapshot(ids)));
        if (QStringList{"pending", "reading", "unknown"}.contains(phase)) bridge.confirmCandidateDecisions();
        if (phase == "reading")
            bridge.event(frame("memory:candidates:result", bridge.memoryCandidateBatch().value("requestId").toString(),
                               candidateReceipt(ids, true)));
        if (phase == "unknown") bridge.expirePending(bridge.memoryCandidateBatch().value("requestId").toString());
        const auto action = memoryReceipt(bridge, "action");
        const auto current = bridge.memoryCandidateBatch();
        const auto count = frames->size();
        bridge.setMemoryPinned("memory-1", false);
        bridge.editMemory("memory-1", "new draft");
        bridge.deleteMemory("memory-1");
        bridge.deleteMemories({QString("memory-1")});
        bridge.previewMemoryPins({QString("memory-1")}, true);
        bridge.decideMemoryCandidate(candidateId(3), true);
        bridge.loadMoreMemories();
        bridge.loadNextMemoryCandidates();
        bridge.filterMemories("new query");
        if (phase != "unknown")
            bridge.firstMemoryCandidates();
        for (const auto &command : QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                 "memory:pin_status", "memory:pin_many", "memory:candidates:confirm", "memory:candidates:reject",
                 "memory:candidates:list", "memory:list"})
            QVERIFY(bridge.request(command).isEmpty());
        QCOMPARE(frames->size(), count);
        QCOMPARE(memoryReceipt(bridge, "action"), action);
        QCOMPARE(bridge.memoryCandidateBatch(), current);
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        if (QStringList{"pending", "reading", "unknown"}.contains(phase)) {
            bridge.cancelCandidateBatchPreview();
            QCOMPARE(bridge.memoryCandidateBatch(), current);
        }
    }
    void candidateBatchScopeChangeAndDisconnectDropOwnership_data() {
        QTest::addColumn<QString>("phase");
        for (const auto &phase : QStringList{"pending", "reading", "unknown"})
            QTest::newRow(qPrintable(phase)) << phase;
    }
    void candidateBatchScopeChangeAndDisconnectDropOwnership() {
        QFETCH(QString, phase);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(1);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.confirmCandidateDecisions();
        const auto write = bridge.memoryCandidateBatch().value("requestId").toString();
        if (phase == "reading")
            bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        if (phase == "unknown") bridge.expirePending(write);
        const auto previous = bridge.memoryCandidateBatch();
        bridge.event(frame("persona:scope", "", {{"persona_id", "new-persona"}, {"epoch", 4},
                                                   {"fingerprint", "new-fingerprint"}}));
        QCOMPARE(candidateBatchStatus(bridge), QString("idle"));
        QVERIFY(!bridge.memoryCandidateBatch().value("blocked").toBool());
        const auto current = bridge.memoryCandidateBatch();
        bridge.event(frame("memory:candidates:result", write, candidateReceipt(ids, true)));
        bridge.event(frame("memory:candidates:result", previous.value("statusReadId").toString(),
                           candidateSnapshot(ids, "confirmed")));
        QCOMPARE(bridge.memoryCandidateBatch(), current);
        QVERIFY(shownCandidates(bridge).isEmpty());
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchDisconnectKeepsAnInFlightWriteUnknown() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(1);
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.confirmCandidateDecisions();
        const auto write = bridge.memoryCandidateBatch().value("requestId").toString();
        bridge.m_process.finished(1, QProcess::CrashExit);
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        QVERIFY(!bridge.m_pending.contains(write));
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 1);
    }
    void candidateBatchTransportFailureAndPreviewTimeout() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownCandidates(bridge, *frames);
        const auto ids = batchCandidates(1);
        bridge.previewCandidateDecisions(ids, true);
        bridge.expirePending(bridge.memoryCandidateBatch().value("previewRequestId").toString());
        QCOMPARE(candidateBatchStatus(bridge), QString("preview_error"));
        QVERIFY(!bridge.memoryCandidateBatch().value("blocked").toBool());
        knownCandidatePreview(bridge, ids, true, candidateSnapshot(ids));
        bridge.m_frameWriter = [](const QByteArray &) -> qint64 { return -1; };
        bridge.confirmCandidateDecisions();
        QCOMPARE(candidateBatchStatus(bridge), QString("unknown"));
        QVERIFY(bridge.memoryCandidateBatch().value("blocked").toBool());
        QCOMPARE(bridge.memoryCandidateBatch().value("dispatchCount").toULongLong(), 0ULL);
        QCOMPARE(commandCount(*frames, "memory:candidates:decide_many"), 0);
    }
    void clearBatchSuccessFeedbackKeepsUnfinishedOutcomes() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setMemoryFeedback("action", "success", "已删除3条记忆。", "delete-1", {{"verb", "批量删除记忆"}});
        bridge.m_memoryBatchPin = {{"status", "success"}, {"requestId", "pin-1"}};
        bridge.m_candidateBatch = {{"status", "success"}, {"requestId", "batch-1"}};
        bridge.clearBatchSuccessFeedback();
        QVERIFY(memoryReceipt(bridge, "action").isEmpty());
        QCOMPARE(bridge.memoryBatchPin().value("status").toString(), QString("idle"));
        QCOMPARE(candidateBatchStatus(bridge), QString("idle"));
        bridge.setMemoryFeedback("action", "error", "批量删除未执行。", "delete-2", {{"verb", "批量删除记忆"}});
        bridge.m_memoryBatchPin = {{"status", "unknown"}};
        bridge.m_candidateBatch = {{"status", "refreshed"}};
        bridge.clearBatchSuccessFeedback();
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        QCOMPARE(bridge.memoryBatchPin().value("status").toString(), QString("unknown"));
        QCOMPARE(candidateBatchStatus(bridge), QString("refreshed"));
        bridge.setMemoryFeedback("action", "success", "已固定这条记忆。", "pin-single", {{"verb", "固定记忆"}});
        bridge.clearBatchSuccessFeedback();
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("success"));
    }
    void candidatePagesReplaceAndReadFailuresKeepTheBatch() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.refreshMemories();
        const auto first = lastCommand(*frames, "memory:candidates:list");
        QCOMPARE(first["limit"].toInt(), 100);
        QCOMPARE(first["status"].toString(), QString("pending"));
        QVERIFY(!first.contains("cursor"));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.first"));
        QCOMPARE(shownCandidates(bridge).size(), 2);
        QVERIFY(bridge.m_candidateReadId.isEmpty());
        QCOMPARE(bridge.m_candidateReadGeneration, -1);
        QVERIFY(bridge.m_candidateReadPersona.isEmpty());
        bridge.loadNextMemoryCandidates();
        bridge.loadNextMemoryCandidates();
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 2);
        QCOMPARE(lastCommand(*frames, "memory:candidates:list")["cursor"].toString(), QString("mc1.first"));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(3, 2), true, "mc1.second"));
        QCOMPARE(shownCandidates(bridge).size(), 2);
        QCOMPARE(shownCandidates(bridge).first().toMap().value("id").toString(), candidateId(3));
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 2);
        const auto rows = shownCandidates(bridge);
        const auto start = bridge.m_candidateStartCursor;
        bridge.loadNextMemoryCandidates();
        const auto failed = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        bridge.event(frame("error", failed, {{"message", "read failure"}}));
        QCOMPARE(shownCandidates(bridge), rows);
        QCOMPARE(bridge.m_candidateStartCursor, start);
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 2);
        QVERIFY(!bridge.memoryCandidatePage().value("needsRefresh").toBool());
        bridge.loadNextMemoryCandidates();
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 4);
        bridge.event(frame("memory:candidates:result",
            lastCommand(*frames, "memory:candidates:list")["requestId"].toString(),
            {{"ok", false}, {"error_code", "invalid_cursor"}, {"error", "invalid cursor"}}));
        QVERIFY(bridge.memoryCandidatePage().value("needsRefresh").toBool());
        bridge.loadNextMemoryCandidates();
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 4);
        QCOMPARE(shownCandidates(bridge), rows);
        bridge.firstMemoryCandidates();
        QVERIFY(!lastCommand(*frames, "memory:candidates:list").contains("cursor"));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 1)));
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 1);
        QVERIFY(!bridge.memoryCandidatePage().value("needsRefresh").toBool());
        const auto raw = QJsonDocument::fromVariant(bridge.diagnostics()).toJson(QJsonDocument::Compact);
        QVERIFY(!raw.contains("mc1.first") && !raw.contains("mc1.second"));
    }
    void candidateDecisionsRereadTheSameBatch_data() {
        QTest::addColumn<bool>("confirm");
        QTest::addColumn<bool>("empty");
        QTest::newRow("confirm-backfill") << true << false;
        QTest::newRow("reject-backfill") << false << false;
        QTest::newRow("confirm-empty-tail") << true << true;
        QTest::newRow("reject-empty-tail") << false << true;
    }
    void candidateDecisionsRereadTheSameBatch() {
        QFETCH(bool, confirm);
        QFETCH(bool, empty);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.filterMemories("原筛选");
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage(memoryRows(1, 1), false, {}, "原筛选")));
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.batch2"));
        bridge.loadNextMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(3, 2), !empty, empty ? QString() : "mc1.batch3"));
        const auto shown = shownCandidates(bridge);
        const auto startDigest = bridge.diagnostics().value("candidatePaging").toMap().value("currentStartCursorDigest");
        const auto command = confirm ? QString("memory:candidates:confirm") : QString("memory:candidates:reject");
        bridge.decideMemoryCandidate(candidateId(4), confirm);
        const auto actionId = lastCommand(*frames, command)["requestId"].toString();
        QVERIFY(!actionId.isEmpty());
        QCOMPARE(bridge.m_candidateDecision.value("ordinal").toInt(), 1);
        QCOMPARE(bridge.m_candidateDecision.value("startCursor").toString(), QString("mc1.batch2"));
        QCOMPARE(bridge.m_candidateDecision.value("generation").toInt(), bridge.generation());
        QCOMPARE(bridge.m_candidateDecision.value("scopeKey").toString(), bridge.scopeKey());
        const int before = frames->size();
        bridge.decideMemoryCandidate(candidateId(3), !confirm);
        bridge.loadNextMemoryCandidates();
        bridge.firstMemoryCandidates();
        bridge.refreshMemories();
        QCOMPARE(frames->size(), before);
        bridge.event(frame("memory:candidates:result", actionId, {{"ok", true}, {"id", "memory-new"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("success"));
        QVERIFY(bridge.memoryCandidatePage().value("busy").toBool());
        QCOMPARE(shownCandidates(bridge), shown);
        const auto read = lastCommand(*frames, "memory:candidates:list");
        QCOMPARE(read["cursor"].toString(), QString("mc1.batch2"));
        QCOMPARE(bridge.diagnostics().value("candidatePaging").toMap().value("readStartCursorDigest"), startDigest);
        const auto confirmed = lastCommand(*frames, "memory:list");
        QCOMPARE(confirmed["limit"].toInt(), 100);
        QCOMPARE(confirmed["query"].toString(), QString("原筛选"));
        QVERIFY(!confirmed.contains("cursor"));
        const int during = frames->size();
        bridge.decideMemoryCandidate(candidateId(3), true);
        bridge.loadNextMemoryCandidates();
        QCOMPARE(frames->size(), during);
        deliverCandidate(bridge, *frames, candidatePage(empty ? QJsonArray{} : candidateRows(3, 1)));
        QVERIFY(bridge.memoryCandidatePage().value("busy").toBool());
        bridge.event(frame("memory:result", confirmed["requestId"].toString(),
                           memoryPage(memoryRows(1, 2), false, {}, "原筛选")));
        QVERIFY(!bridge.memoryCandidatePage().value("busy").toBool());
        QVERIFY(!bridge.memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 2);
        QCOMPARE(shownCandidates(bridge).size(), empty ? 0 : 1);
        if (empty)
            QVERIFY(memoryReceipt(bridge, "candidates").value("text").toString().contains("这一批已处理完"));
        QCOMPARE(frames->size(), during);
    }
    void candidateMalformedPagesStopWithoutReplacingRows_data() {
        QTest::addColumn<QString>("defect");
        for (const auto &defect : {"bytes", "page-limit", "duplicate", "order", "boundary-order",
                                  "empty-more", "bad-cursor", "cursor-newline", "id-newline", "missing-metadata", "wrong-row-status"})
            QTest::newRow(defect) << QString::fromLatin1(defect);
    }
    void candidateMalformedPagesStopWithoutReplacingRows() {
        QFETCH(QString, defect);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.next"));
        const auto rows = shownCandidates(bridge);
        bridge.loadNextMemoryCandidates();
        auto offered = candidateRows(3, 2);
        auto payload = candidatePage(offered);
        if (defect == "bytes") {
            auto row = offered[0].toObject();
            row["proposed_text"] = QString(300001, QChar(u'月'));
            offered[0] = row;
            payload["candidates"] = offered;
            QVERIFY(QJsonDocument(payload).toJson(QJsonDocument::Compact).size() > 900000);
        } else if (defect == "page-limit") {
            payload["candidates"] = candidateRows(3, 101);
        } else if (defect == "duplicate") {
            offered[1] = offered[0];
            payload["candidates"] = offered;
        } else if (defect == "order") {
            offered = QJsonArray{offered[1], offered[0]};
            payload["candidates"] = offered;
        } else if (defect == "boundary-order") {
            auto row = offered[0].toObject();
            row["created_at"] = 100000.0;
            offered[0] = row;
            payload["candidates"] = offered;
        } else if (defect == "empty-more") {
            payload = candidatePage({}, true, "mc1.older");
        } else if (defect == "bad-cursor") {
            payload = candidatePage(offered, true, "v1.wrongkind");
        } else if (defect == "cursor-newline") {
            payload = candidatePage(offered, true, "mc1.valid\n");
        } else if (defect == "id-newline") {
            auto row = offered[0].toObject();
            row["id"] = row["id"].toString() + "\n";
            offered[0] = row;
            payload["candidates"] = offered;
        } else if (defect == "wrong-row-status") {
            auto row = offered[0].toObject();
            row["status"] = "rejected";
            offered[0] = row;
            payload["candidates"] = offered;
        } else {
            payload.remove("has_more");
        }
        deliverCandidate(bridge, *frames, payload);
        QCOMPARE(shownCandidates(bridge), rows);
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 1);
        QVERIFY(bridge.memoryCandidatePage().value("needsRefresh").toBool());
        QVERIFY(memoryReceipt(bridge, "candidates").value("text").toString().contains("请刷新"));
        const int writes = frames->size();
        bridge.loadNextMemoryCandidates();
        bridge.decideMemoryCandidate(candidateId(1), true);
        QCOMPARE(frames->size(), writes);
    }
    void candidateUnknownDecisionNeedsTwoFreshManualReads_data() {
        QTest::addColumn<QString>("loss");
        QTest::newRow("decision-timeout") << QString("timeout");
        QTest::newRow("readback-timeout") << QString("readback");
        QTest::newRow("confirmed-readback-timeout-first") << QString("readback-list");
        QTest::newRow("disconnect-new-connection") << QString("connection");
        QTest::newRow("readonly-recovery-lock") << QString("readonly");
    }
    void candidateUnknownDecisionNeedsTwoFreshManualReads() {
        QFETCH(QString, loss);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.old"));
        bridge.decideMemoryCandidate(candidateId(1), true);
        const auto action = lastCommand(*frames, "memory:candidates:confirm")["requestId"].toString();
        const auto originalRows = shownCandidates(bridge);
        QString oldRead;
        if (loss.startsWith("readback")) {
            bridge.event(frame("memory:candidates:result", action, {{"ok", true}}));
            oldRead = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
            bridge.expirePending(loss == "readback-list"
                ? lastCommand(*frames, "memory:list")["requestId"].toString() : oldRead);
        } else if (loss == "connection") {
            bridge.m_process.finished(1, QProcess::CrashExit);
            const auto persona = bridge.m_persona;
            bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
                {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
                {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                    bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
                {"personaId", persona["persona_id"]}, {"personaEpoch", persona["epoch"]},
                {"personaFingerprint", persona["fingerprint"]},
                {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
            QVERIFY(bridge.connected());
        } else {
            bridge.expirePending(action);
            if (loss == "readonly") {
                bridge.applyRecoverySnapshot({{"recovery_state", "recovery_required"},
                    {"writes_blocked", true}, {"runtime_writable", false}});
                bridge.applyRecoverySnapshot({{"recovery_state", "clean"},
                    {"writes_blocked", false}, {"runtime_writable", true}}, false, true);
                QVERIFY(bridge.runtimeWritable());
            }
        }
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        QVERIFY(!memoryReceipt(bridge, "action").value("text").toString().contains("没有改动"));
        const int actions = commandCount(*frames, "memory:candidates:confirm");
        bridge.decideMemoryCandidate(candidateId(2), true);
        bridge.loadNextMemoryCandidates();
        QCOMPARE(commandCount(*frames, "memory:candidates:confirm"), actions);
        bridge.event(frame("memory:candidates:result", action, {{"ok", true}, {"candidates", QJsonArray{}}}));
        if (!oldRead.isEmpty())
            bridge.event(frame("memory:candidates:result", oldRead, candidatePage({})));
        QCOMPARE(shownCandidates(bridge), originalRows);
        bridge.refreshMemories();
        const auto candidateRead = lastCommand(*frames, "memory:candidates:list");
        const auto memoryRead = lastCommand(*frames, "memory:list");
        QVERIFY(!candidateRead.contains("cursor"));
        QVERIFY(bridge.memoryCandidatePage().value("busy").toBool());
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(2, 1)));
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        bridge.event(frame("memory:result", memoryRead["requestId"].toString(), memoryPage({}, false)));
        QVERIFY(!bridge.memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(commandCount(*frames, "memory:candidates:confirm"), actions);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("refreshed"));
    }
    void candidateRereadMustStayBelowItsStartBoundary() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.page2"));
        bridge.loadNextMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(3, 2)));
        const auto original = shownCandidates(bridge);
        bridge.decideMemoryCandidate(candidateId(4), false);
        bridge.event(frame("memory:candidates:result",
            lastCommand(*frames, "memory:candidates:reject")["requestId"].toString(), {{"ok", true}}));
        // It is sorted by itself but lies above page two's original start.
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 1)));
        QCOMPARE(shownCandidates(bridge), original);
        QVERIFY(bridge.memoryCandidatePage().value("needsRefresh").toBool());
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
    }
    void candidateExplicitRefreshSupersedesAnOrdinaryNextRead() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.refreshMemories();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage({}, false)));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.page2"));
        bridge.loadNextMemoryCandidates();
        const auto old = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        bridge.refreshMemories();
        const auto fresh = lastCommand(*frames, "memory:candidates:list");
        QVERIFY(fresh["requestId"].toString() != old);
        QVERIFY(!fresh.contains("cursor"));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(8, 1)));
        bridge.event(frame("memory:candidates:result", old, candidatePage(candidateRows(3, 2))));
        QCOMPARE(shownCandidates(bridge).first().toMap().value("id").toString(), candidateId(8));
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 1);
    }
    // Opening the page starts a first-page read; a refresh while it is still in
    // flight reuses it, and only a refresh after it settles sends a new read.
    void candidateRefreshDuringAnInFlightFirstReadReusesIt() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.refreshMemories();
        const auto opening = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage({}, false)));
        bridge.refreshMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), 2);
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 1);
        QCOMPARE(bridge.memoryFeedback().value("candidates").toMap().value("requestId").toString(), opening);
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        const auto settled = bridge.memoryFeedback().value("candidates").toMap();
        QCOMPARE(settled.value("status").toString(), QString("success"));
        QCOMPARE(settled.value("requestId").toString(), opening);
        QCOMPARE(bridge.memoryCandidatePage().value("readRequestId").toString(), opening);
        bridge.refreshMemories();
        const auto fresh = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 2);
        QVERIFY(fresh != opening);
        QCOMPARE(bridge.memoryFeedback().value("candidates").toMap().value("requestId").toString(), fresh);
        QCOMPARE(bridge.memoryCandidatePage().value("readRequestId").toString(), fresh);
    }
    void candidateKnownRefusalKeepsItsBatchAndCannotReplayTheReceipt() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        const auto original = shownCandidates(bridge);
        bridge.decideMemoryCandidate(candidateId(1), false);
        const auto action = lastCommand(*frames, "memory:candidates:reject")["requestId"].toString();
        bridge.event(frame("memory:candidates:result", action,
                           {{"ok", false}, {"error_code", "candidate_not_pending"}, {"error", "refused"}}));
        QCOMPARE(shownCandidates(bridge), original);
        QVERIFY(!bridge.memoryCandidatePage().value("busy").toBool());
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        bridge.event(frame("memory:candidates:result", action, {{"ok", true}}));
        QCOMPARE(shownCandidates(bridge), original);
        QCOMPARE(commandCount(*frames, "memory:candidates:list"), 1);
        QVERIFY(bridge.request("memory:candidates:confirm", {{"candidate_id", candidateId(2)}}).isEmpty());
    }
    void candidateReadbackCannotReuseAPredecisionListAfterWriteFailure() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.refreshMemories();
        const auto oldList = lastCommand(*frames, "memory:list")["requestId"].toString();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        bridge.decideMemoryCandidate(candidateId(1), true);
        const auto action = lastCommand(*frames, "memory:candidates:confirm")["requestId"].toString();
        bridge.m_frameWriter = [frames](const QByteArray &bytes) -> qint64 {
            const auto frame = QJsonDocument::fromJson(bytes.mid(4)).object();
            if (frame["envelope"].toObject()["command"].toString() == "memory:list")
                return -1;
            frames->append(frame);
            return bytes.size();
        };
        bridge.event(frame("memory:candidates:result", action, {{"ok", true}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
        QVERIFY(bridge.m_candidateDecision.value("listReadId").toString().isEmpty());
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(2, 1)));
        bridge.event(frame("memory:result", oldList, memoryPage({}, false)));
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
    }
    void candidateSuccessfulReceiptWithStillPendingSubjectStaysLocked() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        bridge.decideMemoryCandidate(candidateId(1), true);
        bridge.event(frame("memory:candidates:result",
            lastCommand(*frames, "memory:candidates:confirm")["requestId"].toString(), {{"ok", true}}));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(2, 1)));
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("unknown"));
        QVERIFY(bridge.m_candidateReadId.isEmpty());
        QCOMPARE(bridge.m_candidateReadGeneration, -1);
        QVERIFY(bridge.m_candidateReadPersona.isEmpty());
    }
    void candidateReconciliationPreservesANewerOrdinaryActionReceipt() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.interleaved"));
        bridge.loadNextMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(3, 2)));
        bridge.decideMemoryCandidate(candidateId(4), true);
        const auto decision = lastCommand(*frames, "memory:candidates:confirm")["requestId"].toString();
        bridge.event(frame("memory:candidates:result", decision, {{"ok", true}}));
        bridge.setMemoryPinned("memory-1", true);
        const auto newer = lastCommand(*frames, "memory:reinforce")["requestId"].toString();
        const auto readback = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        bridge.event(frame("error", readback, {{"message", "readback failed"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("requestId").toString(), newer);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("pending"));
        QVERIFY(bridge.memoryCandidatePage().value("blocked").toBool());
        bridge.refreshMemories();
        const auto manualList = lastCommand(*frames, "memory:list")["requestId"].toString();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2)));
        bridge.event(frame("memory:result", manualList, memoryPage({}, false)));
        QVERIFY(!bridge.memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(memoryReceipt(bridge, "action").value("requestId").toString(), newer);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("pending"));
        bridge.event(frame("memory:result", newer, {{"ok", true}, {"op", "pin"}, {"memory_id", "memory-1"}}));
        QCOMPARE(memoryReceipt(bridge, "action").value("requestId").toString(), newer);
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("success"));
        QVERIFY(!lastCommand(*frames, "memory:candidates:list").contains("cursor"));
        QCOMPARE(commandCount(*frames, "memory:candidates:confirm"), 1);
    }
    void candidateNewConnectionWithNewPersonaClearsTheOldBatch() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 2), true, "mc1.oldPersona"));
        bridge.decideMemoryCandidate(candidateId(1), true);
        const auto action = lastCommand(*frames, "memory:candidates:confirm")["requestId"].toString();
        bridge.m_process.finished(1, QProcess::CrashExit);
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", "persona-new"}, {"personaEpoch", 4}, {"personaFingerprint", "new-fingerprint"},
            {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
        QVERIFY(bridge.connected());
        QVERIFY(shownCandidates(bridge).isEmpty());
        QVERIFY(bridge.m_candidateDecision.isEmpty());
        QVERIFY(bridge.m_candidateStartCursor.isEmpty() && bridge.m_candidateNextCursor.isEmpty());
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 1);
        bridge.event(frame("memory:candidates:result", action, {{"ok", true}}));
        QVERIFY(shownCandidates(bridge).isEmpty());
        bridge.openPanel("memory");
        QVERIFY(!lastCommand(*frames, "memory:candidates:list").contains("cursor"));
    }
    void candidateStaleReadsAndScopeCannotReplaceTheCurrentBatch() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.firstMemoryCandidates();
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(1, 1), true, "mc1.next"));
        bridge.loadNextMemoryCandidates();
        const auto stale = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        bridge.readMemories(true);
        const auto current = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        QVERIFY(current != stale);
        bridge.event(frame("memory:candidates:result", stale, candidatePage(candidateRows(2, 1))));
        QCOMPARE(shownCandidates(bridge).first().toMap().value("id").toString(), candidateId(1));
        deliverCandidate(bridge, *frames, candidatePage(candidateRows(3, 1)));
        bridge.decideMemoryCandidate(candidateId(3), false);
        const auto oldAction = lastCommand(*frames, "memory:candidates:reject")["requestId"].toString();
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 9},
                                                  {"fingerprint", "fingerprint-next"}}));
        QVERIFY(shownCandidates(bridge).isEmpty());
        QVERIFY(bridge.m_candidateDecision.isEmpty());
        bridge.event(frame("memory:candidates:result", oldAction, {{"ok", true}}));
        QVERIFY(shownCandidates(bridge).isEmpty());
        QCOMPARE(bridge.memoryCandidatePage().value("pageNumber").toInt(), 1);
        bridge.firstMemoryCandidates();
        const auto fresh = lastCommand(*frames, "memory:candidates:list")["requestId"].toString();
        auto foreign = candidatePage(candidateRows(8, 1));
        foreign["persona_id"] = "persona-current";
        bridge.event(frame("memory:candidates:result", fresh, foreign));
        QVERIFY(shownCandidates(bridge).isEmpty());
        deliverCandidate(bridge, *frames, candidatePage({}));
        const int before = frames->size();
        bridge.loadNextMemoryCandidates();
        bridge.decideMemoryCandidate(candidateId(8), true);
        QCOMPARE(frames->size(), before);
        QVERIFY(memoryReceipt(bridge, "candidates").value("text").toString().contains("没有待确认"));
    }
    void memoryPagesAppendOnlyForTheShownList() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.refreshMemories();
        auto first = lastCommand(*frames, "memory:list");
        QCOMPARE(first["limit"].toInt(), 100);
        QVERIFY(!first.contains("cursor") && !first.contains("query"));
        bridge.event(frame("memory:result", first["requestId"].toString(), memoryPage(memoryRows(1, 2), true, "v1.first")));
        QCOMPARE(shownMemories(bridge), 2);
        QVERIFY(bridge.state().value("memory").toMap().value("hasMore").toBool());
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("已显示 2 条已确认的记忆，可以加载更多。"));

        // One load-more at a time, with the shown list's cursor.
        bridge.loadMoreMemories();
        bridge.loadMoreMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), 2);
        const auto stale = lastCommand(*frames, "memory:list");
        QCOMPARE(stale["cursor"].toString(), QString("v1.first"));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("正在加载更多记忆…"));
        // A refresh starts a new list; the earlier load-more no longer counts.
        bridge.refreshMemories();
        const auto fresh = lastCommand(*frames, "memory:list")["requestId"].toString();
        QVERIFY(fresh != stale["requestId"].toString());
        bridge.event(frame("memory:result", stale["requestId"].toString(), memoryPage(memoryRows(3, 2), false)));
        QCOMPARE(shownMemories(bridge), 2);
        QCOMPARE(memoryReceipt(bridge, "list").value("requestId").toString(), fresh);
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("pending"));
        bridge.event(frame("memory:result", fresh, memoryPage(memoryRows(1, 2), true, "v1.second")));

        // A failed load-more keeps the list and its cursor for a retry.
        bridge.loadMoreMemories();
        bridge.event(frame("error", lastCommand(*frames, "memory:list")["requestId"].toString(), {{"message", "内部错误"}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("加载更多失败，已显示的记忆不变；可以重试。"));
        QCOMPARE(shownMemories(bridge), 2);
        bridge.loadMoreMemories();
        auto retry = lastCommand(*frames, "memory:list");
        QCOMPARE(retry["cursor"].toString(), QString("v1.second"));
        // A page that repeats a shown row means the list changed: stop until a refresh.
        bridge.event(frame("memory:result", retry["requestId"].toString(), memoryPage(memoryRows(2, 2), true, "v1.third")));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("记忆列表已变化，已停止加载；请刷新。"));
        QCOMPARE(shownMemories(bridge), 2);
        QVERIFY(!bridge.state().value("memory").toMap().value("hasMore").toBool());
        const int sent = commandCount(*frames, "memory:list");
        bridge.loadMoreMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), sent);

        // So does a cursor the service no longer accepts.
        bridge.refreshMemories();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage(memoryRows(1, 2), true, "v1.fourth")));
        bridge.loadMoreMemories();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           {{"ok", false}, {"error_code", "invalid_cursor"}, {"memories", QJsonArray{}}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("记忆列表已变化，已停止加载；请刷新。"));
        QVERIFY(!bridge.state().value("memory").toMap().value("hasMore").toBool());

        // A lost load-more is unknown; the list stays and the same page can be asked for again.
        bridge.refreshMemories();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage(memoryRows(1, 2), true, "v1.fifth")));
        bridge.loadMoreMemories();
        bridge.expirePending(lastCommand(*frames, "memory:list")["requestId"].toString());
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("unknown"));
        QCOMPARE(shownMemories(bridge), 2);
        bridge.loadMoreMemories();
        retry = lastCommand(*frames, "memory:list");
        QCOMPARE(retry["cursor"].toString(), QString("v1.fifth"));
        bridge.event(frame("memory:result", retry["requestId"].toString(), memoryPage(memoryRows(3, 1), false)));
        QCOMPARE(shownMemories(bridge), 3);
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("共 3 条已确认的记忆。"));
        QVERIFY(!bridge.state().value("memory").toMap().value("hasMore").toBool());

        // A page claiming more without a cursor is not a page.
        bridge.refreshMemories();
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           QJsonObject{{"ok", true}, {"memories", memoryRows(1, 2)}, {"has_more", true}}));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));
        QCOMPARE(shownMemories(bridge), 3);
    }
    void memoryFilterStartsANewListAndCapsTheShownRows() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.filterMemories("  星图 ");
        QCOMPARE(bridge.memoryQuery(), QString("星图"));
        auto read = lastCommand(*frames, "memory:list");
        QCOMPARE(read["query"].toString(), QString("星图"));
        QVERIFY(!read.contains("cursor"));
        bridge.event(frame("memory:result", read["requestId"].toString(), memoryPage(memoryRows(1, 1), false, {}, "星图")));
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("找到 1 条包含“星图”的记忆。"));
        QCOMPARE(bridge.state().value("memory").toMap().value("query").toString(), QString("星图"));

        // Refused locally: nothing is sent and the filter stays.
        const int sent = commandCount(*frames, "memory:list");
        bridge.filterMemories("星\n图");
        bridge.filterMemories(QString(101, QChar(0x661f)));
        QCOMPARE(commandCount(*frames, "memory:list"), sent);
        QCOMPARE(bridge.memoryQuery(), QString("星图"));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));

        // A change reads the first page of the same filter back.
        bridge.setMemoryPinned("memory-1", true);
        bridge.event(frame("memory:result", controlId(bridge, "memory:reinforce"),
                           {{"ok", true}, {"op", "pin"}, {"memory_id", "memory-1"}}));
        read = lastCommand(*frames, "memory:list");
        QCOMPARE(read["query"].toString(), QString("星图"));
        QVERIFY(!read.contains("cursor"));
        bridge.event(frame("memory:result", read["requestId"].toString(), memoryPage(memoryRows(1, 1), false, {}, "星图")));

        // A result for another query than the one asked is not shown.
        bridge.filterMemories("月");
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage(memoryRows(5, 3), false, {}, "星")));
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("error"));
        QCOMPARE(bridge.state().value("memory").toMap().value("query").toString(), QString("星图"));
        // The shown list no longer matches the filter, so it cannot be extended.
        QVERIFY(!bridge.state().value("memory").toMap().value("hasMore").toBool());

        // Clearing the filter, then at most 500 rows in pages of 100.
        bridge.filterMemories("");
        QCOMPARE(bridge.memoryQuery(), QString());
        read = lastCommand(*frames, "memory:list");
        QVERIFY(!read.contains("query"));
        bridge.event(frame("memory:result", read["requestId"].toString(), memoryPage(memoryRows(1, 100), true, "v1.page1")));
        for (int page = 2; page <= 5; ++page) {
            bridge.loadMoreMemories();
            read = lastCommand(*frames, "memory:list");
            QCOMPARE(read["limit"].toInt(), 100);
            QCOMPARE(read["cursor"].toString(), QString("v1.page%1").arg(page - 1));
            bridge.event(frame("memory:result", read["requestId"].toString(),
                               memoryPage(memoryRows((page - 1) * 100 + 1, 100), true, QString("v1.page%1").arg(page))));
        }
        const auto list = bridge.state().value("memory").toMap();
        QCOMPARE(shownMemories(bridge), 500);
        QVERIFY(list.value("capped").toBool() && !list.value("hasMore").toBool());
        QCOMPARE(memoryReceipt(bridge, "list").value("text").toString(), QString("已显示 500 条，请用筛选缩小范围。"));
        const int capped = commandCount(*frames, "memory:list");
        bridge.loadMoreMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), capped);
    }
    void memoryListBelongsToItsConnectionAndIdentity() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.filterMemories("星图");
        bridge.event(frame("memory:result", lastCommand(*frames, "memory:list")["requestId"].toString(),
                           memoryPage(memoryRows(1, 2), true, "v1.old", "星图")));
        QVERIFY(bridge.state().value("memory").toMap().value("hasMore").toBool());

        // A new service process: the cursor is gone, the shown rows stay until the next first page.
        const auto persona = bridge.m_persona;
        bridge.m_process.finished(1, QProcess::CrashExit);
        QVERIFY(!bridge.connected());
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", persona["persona_id"]}, {"personaEpoch", persona["epoch"]},
            {"personaFingerprint", persona["fingerprint"]},
            {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
        QVERIFY(bridge.connected());
        QCOMPARE(shownMemories(bridge), 2);
        QVERIFY(!bridge.state().value("memory").toMap().value("hasMore").toBool());
        const int sent = commandCount(*frames, "memory:list");
        bridge.loadMoreMemories();
        QCOMPARE(commandCount(*frames, "memory:list"), sent);
        bridge.refreshMemories();
        const auto read = lastCommand(*frames, "memory:list");
        QCOMPARE(read["query"].toString(), QString("星图"));
        bridge.event(frame("memory:result", read["requestId"].toString(), memoryPage(memoryRows(1, 2), true, "v1.new", "星图")));
        bridge.loadMoreMemories();
        QCOMPARE(lastCommand(*frames, "memory:list")["cursor"].toString(), QString("v1.new"));

        // Another identity: the list, its filter and its cursor go with the old one.
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 9},
                                                  {"fingerprint", "fingerprint-next"}}));
        QVERIFY(!bridge.state().contains("memory"));
        QCOMPARE(bridge.memoryQuery(), QString());
        bridge.refreshMemories();
        QVERIFY(!lastCommand(*frames, "memory:list").contains("query"));
    }
    void memoryQueryResultsAndPanelReadsNeverBypassTheList() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        // Opening the page is a tracked first-page read with a receipt.
        bridge.openPanel("memory");
        QCOMPARE(pendingCount(bridge, "memory:list"), 1);
        QCOMPARE(memoryReceipt(bridge, "list").value("status").toString(), QString("pending"));
        bridge.event(frame("memory:result", controlId(bridge, "memory:list"), memoryPage(memoryRows(1, 2), false)));
        QCOMPARE(shownMemories(bridge), 2);
        // A semantic query returns texts without IDs; it never replaces the managed list.
        const auto query = bridge.request("memory:query", {{"query", "星空"}});
        QVERIFY(!query.isEmpty());
        bridge.event(frame("memory:query:result", query, {{"memories", QJsonArray{"只有文字的结果"}}}));
        QCOMPARE(shownMemories(bridge), 2);
        QCOMPARE(bridge.state().value("memory").toMap().value("memories").toList().first().toMap().value("id").toString(),
                 QString("memory-1"));
        // Nor does a list result nobody is waiting for.
        bridge.event(frame("memory:result", "unknown-request", memoryPage(memoryRows(7, 1), false)));
        QCOMPARE(shownMemories(bridge), 2);
    }
    void relatedMemoryInputUsesUnicodeCodePoints_data() {
        QTest::addColumn<QString>("query");
        QTest::addColumn<bool>("valid");
        const auto emoji = QString::fromUtf8("🌙");
        QTest::newRow("empty-after-trim") << QString(" \n\t ") << false;
        QTest::newRow("trimmed-sentence") << QString("  想起一起看月亮  ") << true;
        QTest::newRow("2000-bmp") << QString(2000, QChar(u'月')) << true;
        QTest::newRow("2001-bmp") << QString(2001, QChar(u'月')) << false;
        QTest::newRow("2000-emoji") << emoji.repeated(2000) << true;
        QTest::newRow("2001-emoji") << emoji.repeated(2001) << false;
    }
    void relatedMemoryInputUsesUnicodeCodePoints() {
        QFETCH(QString, query);
        QFETCH(bool, valid);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.queryRelatedMemories(query);
        QCOMPARE(commandCount(*frames, "memory:query"), valid ? 1 : 0);
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), valid ? QString("pending") : QString("error"));
        QCOMPARE(bridge.memoryRecallState().value("results").toStringList(), QStringList{});
        if (valid) {
            const auto read = lastCommand(*frames, "memory:query");
            QCOMPARE(read["query"].toString(), query.trimmed());
            QCOMPARE(read["top_k"].toInt(), 10);
            QCOMPARE(bridge.memoryRecallState().value("submittedQuery").toString(), query.trimmed());
        }
    }
    void relatedMemoryReadKeepsOtherStateAndAllowsOnlyOnePendingQuery() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.m_state = {{"memory", QVariantMap{{"memories", memoryRows(1, 2).toVariantList()},
            {"hasMore", true}, {"query", "月亮"}}}, {"worldbookEdit", QVariantMap{{"draft", "世界书草稿"}}}};
        bridge.m_memoryQuery = "月亮";
        bridge.m_memoryCursor = "v1.untouched";
        bridge.m_memoryListId = "list-untouched";
        bridge.m_memoryMoreId = "more-untouched";
        bridge.m_memoryListLive = true;
        bridge.m_memoryFeedback = {{"list", QVariantMap{{"status", "success"}, {"requestId", "list-untouched"}}},
                                   {"action", QVariantMap{{"status", "success"}, {"requestId", "action-untouched"}}}};
        bridge.m_draft = "聊天草稿";
        bridge.m_messages = {QVariantMap{{"content", "已有对话"}}};
        bridge.m_archive = {{"draft", "世界书草稿"}};
        const auto state = bridge.state(), feedback = bridge.memoryFeedback(), archive = bridge.m_archive;
        const auto messages = bridge.messages();
        // Network pause and recovery's write lock do not gate this local read.
        bridge.m_offline = true;
        bridge.m_runtimeWritable = false;
        bridge.m_recoveryState = "recovery_required";
        bridge.m_networkFeedback = {{"known", true}, {"active", true}, {"status", "paused"}};
        bridge.queryRelatedMemories("  看月亮  ");
        const auto id = lastCommand(*frames, "memory:query")["requestId"].toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(bridge.memoryRecallState().value("scopeKey").toString(), bridge.scopeKey());
        QCOMPARE(bridge.memoryRecallState().value("generation").toInt(), bridge.generation());
        bridge.queryRelatedMemories("另一个草稿");
        QCOMPARE(commandCount(*frames, "memory:query"), 1);
        QCOMPARE(bridge.memoryRecallState().value("submittedQuery").toString(), QString("看月亮"));
        auto result = personaScope(bridge);
        result["memories"] = QJsonArray{"永久身份事实", "仍生效的观察"};
        result["retrieval"] = QJsonObject{{"mode", "hybrid"}, {"reason", "vector_search_completed"}, {"indexPending", 3}};
        bridge.event(frame("memory:result", id, result));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("success"));
        QCOMPARE(bridge.memoryRecallState().value("results").toStringList(), (QStringList{"永久身份事实", "仍生效的观察"}));
        QCOMPARE(bridge.memoryRecallState().value("mode").toString(), QString("hybrid"));
        QCOMPARE(bridge.memoryRecallState().value("indexPending").toLongLong(), 3);
        QCOMPARE(bridge.state(), state);
        QCOMPARE(bridge.memoryFeedback(), feedback);
        QCOMPARE(bridge.m_archive, archive);
        QCOMPARE(bridge.messages(), messages);
        QCOMPARE(bridge.draft(), QString("聊天草稿"));
        QCOMPARE(bridge.memoryQuery(), QString("月亮"));
        QCOMPARE(bridge.m_memoryCursor, QString("v1.untouched"));
        QCOMPARE(bridge.m_memoryListId, QString("list-untouched"));
        QCOMPARE(bridge.m_memoryMoreId, QString("more-untouched"));
        QVERIFY(bridge.m_memoryListLive);
        bridge.queryRelatedMemories("下一次");
        QCOMPARE(commandCount(*frames, "memory:query"), 2);
        QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
        QCOMPARE(bridge.memoryRecallState().value("mode").toString(), QString("unknown"));
    }
    void relatedMemoryResponseRejectsMalformedContent_data() {
        QTest::addColumn<QString>("type");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        const auto emoji = QString::fromUtf8("🌙");
        QTest::newRow("valid-without-ok") << QString("memory:result") << QJsonObject{{"memories", QJsonArray{"回忆"}}} << QString("success");
        QTest::newRow("empty-without-ok") << QString("memory:result") << QJsonObject{{"memories", QJsonArray{}}} << QString("empty");
        QTest::newRow("event-error") << QString("error") << QJsonObject{{"memories", QJsonArray{}}, {"message", "read denied"}} << QString("error");
        QTest::newRow("explicit-failure") << QString("memory:result") << QJsonObject{{"ok", false}, {"memories", QJsonArray{}}} << QString("error");
        QTest::newRow("error-field") << QString("memory:result") << QJsonObject{{"error", "degraded"}, {"memories", QJsonArray{}}} << QString("error");
        QTest::newRow("wrong-type") << QString("memory:query:result") << QJsonObject{{"memories", QJsonArray{"回忆"}}} << QString("error");
        QTest::newRow("missing-array") << QString("memory:result") << QJsonObject{} << QString("error");
        QTest::newRow("non-array") << QString("memory:result") << QJsonObject{{"memories", "回忆"}} << QString("error");
        QTest::newRow("non-string") << QString("memory:result") << QJsonObject{{"memories", QJsonArray{QJsonObject{{"id", "canonical-id"}}}}} << QString("error");
        QJsonArray twenty, twentyOne;
        for (int i = 0; i < 21; ++i) {
            twentyOne.append("回忆");
            if (i < 20)
                twenty.append("回忆");
        }
        QTest::newRow("20-strings") << QString("memory:result") << QJsonObject{{"memories", twenty}} << QString("success");
        QTest::newRow("21-strings") << QString("memory:result") << QJsonObject{{"memories", twentyOne}} << QString("error");
        QTest::newRow("5400-emoji") << QString("memory:result") << QJsonObject{{"memories", QJsonArray{emoji.repeated(5400)}}} << QString("success");
        QTest::newRow("5401-emoji") << QString("memory:result") << QJsonObject{{"memories", QJsonArray{emoji.repeated(2700), emoji.repeated(2701)}}} << QString("error");
    }
    void relatedMemoryResponseRejectsMalformedContent() {
        QFETCH(QString, type);
        QFETCH(QJsonObject, payload);
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.queryRelatedMemories("查询草稿保留");
        const auto id = bridge.memoryRecallState().value("requestId").toString();
        bridge.event(frame(type, id, payload));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), status);
        QCOMPARE(bridge.memoryRecallState().value("submittedQuery").toString(), QString("查询草稿保留"));
        QCOMPARE(commandCount(*frames, "memory:query"), 1);
        QCOMPARE(pendingCount(bridge, "memory:query"), 0);
        if (status == "error")
            QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
        else
            QCOMPARE(bridge.memoryRecallState().value("results").toStringList().size(), payload["memories"].toArray().size());
    }
    void relatedMemoryMetadataIsAdvisoryAndConservative_data() {
        QTest::addColumn<QJsonValue>("retrieval");
        QTest::addColumn<QString>("mode");
        QTest::addColumn<QString>("reason");
        QTest::addColumn<qint64>("pending");
        const auto metadata = [](const QString &mode, const QString &reason, const QJsonValue &pending) {
            return QJsonValue(QJsonObject{{"mode", mode}, {"reason", reason}, {"indexPending", pending}});
        };
        QTest::newRow("hybrid-empty-vector-can-succeed") << metadata("hybrid", "vector_search_completed", 0) << QString("hybrid") << QString("vector_search_completed") << qint64(0);
        QTest::newRow("hybrid-pending-index") << metadata("hybrid", "vector_search_completed", 7) << QString("hybrid") << QString("vector_search_completed") << qint64(7);
        QTest::newRow("fallback-model") << metadata("lexical_fallback", "model_unavailable", QJsonValue::Null) << QString("lexical_fallback") << QString("model_unavailable") << qint64(-1);
        QTest::newRow("fallback-index") << metadata("lexical_fallback", "index_unavailable", 2) << QString("lexical_fallback") << QString("index_unavailable") << qint64(2);
        QTest::newRow("unknown-vector-failed") << metadata("unknown", "vector_search_failed", QJsonValue::Null) << QString("unknown") << QString("vector_search_failed") << qint64(-1);
        QTest::newRow("unknown-unverified") << metadata("unknown", "retrieval_path_unverified", QJsonValue::Null) << QString("unknown") << QString("retrieval_path_unverified") << qint64(-1);
        QTest::newRow("missing") << QJsonValue(QJsonValue::Undefined) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("non-object") << QJsonValue("hybrid") << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("unknown-mode") << metadata("semantic", "vector_search_completed", 0) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("unlisted-reason") << metadata("hybrid", "raw backend error", 0) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("mismatched-pair") << metadata("hybrid", "model_unavailable", 0) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("negative-pending") << metadata("hybrid", "vector_search_completed", -1) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("boolean-pending") << metadata("hybrid", "vector_search_completed", true) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("fractional-pending") << metadata("hybrid", "vector_search_completed", 0.5) << QString("unknown") << QString() << qint64(-1);
        QTest::newRow("missing-pending") << QJsonValue(QJsonObject{{"mode", "hybrid"}, {"reason", "vector_search_completed"}}) << QString("unknown") << QString() << qint64(-1);
    }
    void relatedMemoryMetadataIsAdvisoryAndConservative() {
        QFETCH(QJsonValue, retrieval);
        QFETCH(QString, mode);
        QFETCH(QString, reason);
        QFETCH(qint64, pending);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.queryRelatedMemories("查询");
        QJsonObject payload{{"memories", QJsonArray{}}};
        if (!retrieval.isUndefined())
            payload["retrieval"] = retrieval;
        bridge.event(frame("memory:result", bridge.memoryRecallState().value("requestId").toString(), payload));
        const auto result = bridge.memoryRecallState();
        QCOMPARE(result.value("status").toString(), QString("empty"));
        QCOMPARE(result.value("mode").toString(), mode);
        QCOMPARE(result.value("reason").toString(), reason);
        if (pending < 0)
            QVERIFY(result.value("indexPending").isNull());
        else
            QCOMPARE(result.value("indexPending").toLongLong(), pending);
    }
    void relatedMemoryIgnoresOldScopeOutOfOrderRepeatedAndClearedRequests() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.queryRelatedMemories("第一次");
        const auto first = bridge.memoryRecallState().value("requestId").toString();
        auto result = personaScope(bridge);
        result["memories"] = QJsonArray{"第一条"};
        auto foreign = result;
        foreign["persona_id"] = "other-persona";
        bridge.event(frame("memory:result", first, foreign));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("pending"));
        foreign = result;
        foreign["persona_epoch"] = 2;
        bridge.event(frame("memory:result", first, foreign));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("pending"));
        foreign = result;
        foreign["persona_fingerprint"] = "other-fingerprint";
        bridge.event(frame("memory:result", first, foreign));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("pending"));
        bridge.m_pending[first].generation--;
        bridge.event(frame("memory:result", first, result));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("pending"));
        bridge.m_pending[first].generation++;
        bridge.clearMemoryRecall();
        bridge.queryRelatedMemories("第二次");
        const auto second = bridge.memoryRecallState().value("requestId").toString();
        bridge.event(frame("memory:result", first, result));
        bridge.event(frame("memory:result", "unassociated", result));
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("pending"));
        result["memories"] = QJsonArray{"第二条"};
        bridge.event(frame("memory:result", second, result));
        const auto settled = bridge.memoryRecallState();
        result["memories"] = QJsonArray{"重复结果"};
        bridge.event(frame("memory:result", second, result));
        QCOMPARE(bridge.memoryRecallState(), settled);
        bridge.clearMemoryRecall();
        const auto cleared = bridge.memoryRecallState();
        bridge.event(frame("memory:result", second, result));
        QCOMPARE(bridge.memoryRecallState(), cleared);
        QVERIFY(cleared.value("requestId").toString().isEmpty());
        QVERIFY(cleared.value("submittedQuery").toString().isEmpty());
        QCOMPARE(commandCount(*frames, "memory:query"), 2);
        bridge.queryRelatedMemories("超时");
        bridge.expirePending(bridge.memoryRecallState().value("requestId").toString());
        QCOMPARE(bridge.memoryRecallState().value("status").toString(), QString("error"));
        QCOMPARE(commandCount(*frames, "memory:query"), 3);
    }
    void relatedMemoryDisconnectHandshakeAndIdentityInvalidateOnlyItsState() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.m_draft = "聊天草稿";
        bridge.queryRelatedMemories("查询草稿");
        const auto id = bridge.memoryRecallState().value("requestId").toString();
        bridge.event(frame("memory:result", id, {{"memories", QJsonArray{"已显示"}}}));
        const int epoch = bridge.memoryRecallState().value("inputEpoch").toInt();
        const auto persona = bridge.m_persona;
        bridge.m_process.finished(1, QProcess::CrashExit);
        QVERIFY(!bridge.connected());
        QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
        QCOMPARE(bridge.memoryRecallState().value("inputEpoch").toInt(), epoch);
        const auto ready = [&](const QJsonObject &identity) {
            return QJsonObject{{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
                {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
                {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                    bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
                {"personaId", identity["persona_id"]}, {"personaEpoch", identity["epoch"]},
                {"personaFingerprint", identity["fingerprint"]}, {"recoveryState", "clean"},
                {"writesBlocked", false}, {"runtimeWritable", true}};
        };
        bridge.acceptFrame(ready(persona));
        QCOMPARE(bridge.memoryRecallState().value("inputEpoch").toInt(), epoch);
        bridge.event(frame("memory:result", id, {{"memories", QJsonArray{"旧连接"}}}));
        QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
        bridge.queryRelatedMemories("待握手");
        const auto beforeHandshake = bridge.memoryRecallState().value("requestId").toString();
        bridge.m_connected = false;
        bridge.acceptFrame(ready(persona));
        QCOMPARE(bridge.memoryRecallState().value("inputEpoch").toInt(), epoch);
        QVERIFY(bridge.memoryRecallState().value("requestId").toString().isEmpty());
        bridge.event(frame("memory:result", beforeHandshake, {{"memories", QJsonArray{"旧握手"}}}));
        QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
        bridge.queryRelatedMemories("待切换");
        const auto beforeIdentity = bridge.memoryRecallState().value("requestId").toString();
        bridge.event(frame("persona:scope", "", {{"persona_id", "next"}, {"epoch", 9}, {"fingerprint", "next-fingerprint"}}));
        QVERIFY(bridge.memoryRecallState().value("requestId").toString().isEmpty());
        QVERIFY(bridge.memoryRecallState().value("inputEpoch").toInt() > epoch);
        const auto changed = bridge.memoryRecallState();
        bridge.event(frame("memory:result", beforeIdentity, {{"memories", QJsonArray{"旧人格"}}}));
        QCOMPARE(bridge.memoryRecallState(), changed);
        QVERIFY(bridge.memoryRecallState().value("results").toStringList().isEmpty());
    }
    void profileSaveUsesTheContractShapeAndReportsReceipts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        bridge.saveProfile({{"nickname", "小星"}});
        QCOMPARE(memoryReceipt(bridge, "profile").value("status").toString(), QString("error"));
        online(bridge);
        bridge.saveProfile({{"nickname", "  "}, {"interests", " ，、 "}});
        QCOMPARE(memoryReceipt(bridge, "profile").value("text").toString(), QString("没有填写可保存的内容。"));
        bridge.saveProfile({{"birthday", "2000/1/31"}});
        QVERIFY(memoryReceipt(bridge, "profile").value("text").toString().startsWith("生日请写成"));
        bridge.saveProfile({{"nickname", QString(81, 'x')}});
        QCOMPARE(memoryReceipt(bridge, "profile").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);

        QString error;
        const auto body = RuntimeBridge::profileUpdate(
            {{"nickname", " 小星 "}, {"birthday", "2000-01-31"}, {"interests", "观星，摄影、 散步"},
             {"name", ""}, {"bio", "not a profile field"}},
            &error);
        // The contract nests fields under "profile"; blanks and unknown keys are not sent.
        const auto profile = body.value("profile").toMap();
        QCOMPARE(body.keys(), QStringList{"profile"});
        QCOMPARE(profile.keys(), (QStringList{"birthday", "interests", "nickname"}));
        QCOMPARE(profile.value("nickname").toString(), QString("小星"));
        QCOMPARE(profile.value("interests").toStringList(), (QStringList{"观星", "摄影", "散步"}));
        bridge.saveProfile({{"nickname", " 小星 "}, {"birthday", "2000-01-31"},
                            {"interests", "观星，摄影、 散步"}, {"name", ""}});
        bridge.saveProfile({{"nickname", "重复点击"}});
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 1);
        const auto id = controlId(bridge, "user:profile:update");
        QCOMPARE(memoryReceipt(bridge, "profile").value("status").toString(), QString("pending"));
        bridge.event(frame("user:profile:result", id,
                           {{"profile", QJsonObject{{"nickname", "小星"}}}, {"error", "validation failed"}}));
        QCOMPARE(memoryReceipt(bridge, "profile").value("text").toString(),
                 QString("资料未能保存，原资料保留；编辑内容仍在。"));
        bridge.saveProfile({{"nickname", "小星"}});
        bridge.event(frame("user:profile:result", controlId(bridge, "user:profile:update"),
                           {{"profile", QJsonObject{{"nickname", "小星"}}}, {"emotional_memories", QJsonArray{}}}));
        QCOMPARE(memoryReceipt(bridge, "profile").value("text").toString(), QString("资料已保存。"));
        QCOMPARE(bridge.state().value("profile").toMap().value("profile").toMap().value("nickname").toString(),
                 QString("小星"));
    }
    void profileSaveBoundsAgeAndSplitsTheNewLists_data() {
        QTest::addColumn<QString>("age");
        QTest::addColumn<bool>("accepted");
        QTest::addColumn<int>("expected");
        QTest::newRow("minimum") << QString("18") << true << 18;
        QTest::newRow("maximum") << QString("120") << true << 120;
        QTest::newRow("padded") << QString(" 45 ") << true << 45;
        QTest::newRow("blank-is-unchanged") << QString("  ") << true << -1;
        QTest::newRow("below") << QString("17") << false << 0;
        QTest::newRow("above") << QString("121") << false << 0;
        QTest::newRow("text") << QString("三十") << false << 0;
        QTest::newRow("fraction") << QString("30.5") << false << 0;
        QTest::newRow("negative") << QString("-20") << false << 0;
    }
    void profileSaveBoundsAgeAndSplitsTheNewLists() {
        QFETCH(QString, age); QFETCH(bool, accepted); QFETCH(int, expected);
        QString error;
        const auto body = RuntimeBridge::profileUpdate(
            {{"favorite_games", "游戏甲，游戏乙、 游戏丙"}, {"favorite_anime", "动漫丁"}, {"age", age}}, &error);
        if (!accepted) {
            QVERIFY(body.isEmpty());
            QCOMPARE(error, QString("年龄请填写 18 到 120 之间的整数，资料没有保存。"));
            return;
        }
        QVERIFY2(error.isEmpty(), qPrintable(error));
        const auto profile = body.value("profile").toMap();
        QCOMPARE(profile.value("favorite_games").toStringList(), (QStringList{"游戏甲", "游戏乙", "游戏丙"}));
        QCOMPARE(profile.value("favorite_anime").toStringList(), QStringList{"动漫丁"});
        QCOMPARE(profile.contains("age"), expected >= 0);
        if (expected >= 0) {
            QCOMPARE(profile.value("age").metaType().id(), int(QMetaType::Int));
            QCOMPARE(profile.value("age").toInt(), expected);
        }
        const auto json = QJsonObject::fromVariantMap(body)["profile"].toObject();
        QVERIFY(expected < 0 || json["age"].isDouble());
    }
    void profileSnapshotRequiresTheNewFieldShapes_data() {
        QTest::addColumn<QString>("field");
        QTest::addColumn<QJsonValue>("value");
        QTest::addColumn<bool>("known");
        QTest::newRow("age-null") << QString("age") << QJsonValue(QJsonValue::Null) << true;
        QTest::newRow("age-whole") << QString("age") << QJsonValue(30) << true;
        QTest::newRow("age-text") << QString("age") << QJsonValue("30") << false;
        QTest::newRow("age-fraction") << QString("age") << QJsonValue(30.5) << false;
        QTest::newRow("age-missing") << QString("age") << QJsonValue(QJsonValue::Undefined) << false;
        QTest::newRow("games-text") << QString("favorite_games") << QJsonValue("游戏") << false;
        QTest::newRow("games-missing") << QString("favorite_games") << QJsonValue(QJsonValue::Undefined) << false;
        QTest::newRow("anime-non-string-item") << QString("favorite_anime") << QJsonValue(QJsonArray{1}) << false;
    }
    void profileSnapshotRequiresTheNewFieldShapes() {
        QFETCH(QString, field); QFETCH(QJsonValue, value); QFETCH(bool, known);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto snapshot = userProfileSnapshot();
        auto profile = snapshot["profile"].toObject();
        if (value.isUndefined())
            profile.remove(field);
        else
            profile[field] = value;
        snapshot["profile"] = profile;
        bridge.event(frame("user:profile:result", bridge.request("user:profile:get"), snapshot));
        QCOMPARE(bridge.profileSnapshotKnown(), known);
    }
    void profileClearAcceptsTheNewFieldsAndConfirmsTheirEmptyReadback() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const QJsonObject filled{{"favorite_games", QJsonArray{"游戏甲"}}, {"favorite_anime", QJsonArray{"动漫乙"}},
                                 {"age", 30}};
        knownProfile(bridge, userProfileSnapshot('a', false, filled));
        QList<QJsonObject> frames;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            frames << QJsonDocument::fromJson(bytes.mid(4)).object();
            return bytes.size();
        };
        bridge.proposeProfileClear();
        QCOMPARE(bridge.profileClearState().value("availableFields").toStringList(),
                 (QStringList{"name", "nickname", "interests", "favorite_games", "favorite_anime", "age"}));
        const auto id = beginProfileClear(bridge, {"favorite_games", "age"});
        QVERIFY(!id.isEmpty());
        QCOMPARE(frames.size(), 1);
        const auto body = frames.first()["envelope"].toObject()["payload"].toObject();
        QCOMPARE(body["clear_fields"].toArray(), (QJsonArray{"favorite_games", "age"}));
        const QJsonObject cleared{{"favorite_games", QJsonArray{}}, {"favorite_anime", QJsonArray{"动漫乙"}},
                                  {"age", QJsonValue(QJsonValue::Null)}};
        auto receipt = userProfileSnapshot('b', false, cleared);
        receipt["operation"] = "clear";
        receipt["cleared_fields"] = QJsonArray{"favorite_games", "age"};
        bridge.event(frame("user:profile:result", id, receipt));
        QCOMPARE(profileClearStatus(bridge), QString("pending"));
        bridge.event(frame("user:profile:result", bridge.m_profileReadId, userProfileSnapshot('b', false, cleared)));
        QCOMPARE(profileClearStatus(bridge), QString("success"));
        QVERIFY(bridge.profileClearState().value("text").toString().contains("喜欢的游戏、年龄"));
        // A receipt that leaves a selected field filled cannot be reported as cleared.
        knownProfile(bridge, userProfileSnapshot('c', false, filled));
        const auto second = beginProfileClear(bridge, {"age"});
        auto unchanged = userProfileSnapshot('d', false, filled);
        unchanged["operation"] = "clear";
        unchanged["cleared_fields"] = QJsonArray{"age"};
        bridge.event(frame("user:profile:result", second, unchanged));
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
    }
    void profileClearRequiresAReadSnapshotAndCannotUseTheGenericRequest() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_state["profile"] = userProfileSnapshot().toVariantMap();
        bridge.proposeProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
        auto malformed = userProfileSnapshot();
        malformed["profile_snapshot"] = QString(64, 'a') + '\n';
        bridge.event(frame("user:profile:result", bridge.request("user:profile:get"), malformed));
        QVERIFY(!bridge.profileSnapshotKnown());
        bridge.proposeProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        knownProfile(bridge);
        const auto before = bridge.m_commands;
        QVERIFY(bridge.request("user:profile:update", {{"clear_fields", QStringList{"nickname"}},
            {"expected_profile_snapshot", QString(64, 'a')}}).isEmpty());
        QCOMPARE(bridge.m_commands, before);
        bridge.proposeProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("confirmation"));
        QCOMPARE(bridge.profileClearState().value("availableFields").toStringList(),
                 (QStringList{"name", "nickname", "interests"}));
        QVERIFY(bridge.profileClearState().value("selectedFields").toStringList().isEmpty());
    }
    void profileClearCancelAndDirtyDraftSendNoMutation() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        bridge.setDraft("聊天草稿保留");
        const auto before = bridge.m_commands;
        bridge.proposeProfileClear(true);
        QCOMPARE(profileClearStatus(bridge), QString("error"));
        bridge.proposeProfileClear();
        bridge.cancelProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("cancelled"));
        bridge.confirmProfileClear({"nickname"}, bridge.scopeKey(), QString(64, 'a'));
        QCOMPARE(bridge.m_commands, before);
        QCOMPARE(bridge.draft(), QString("聊天草稿保留"));
        bridge.proposeProfileClear();
        bridge.confirmProfileClear({"nickname"}, bridge.scopeKey(), QString(64, 'a'), true);
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        QCOMPARE(bridge.m_commands, before);
    }
    void profileClearRejectsInvalidSelections_data() {
        QTest::addColumn<QStringList>("fields");
        QTest::newRow("empty") << QStringList{};
        QTest::newRow("duplicate") << QStringList{"nickname", "nickname"};
        QTest::newRow("outside-eight") << QStringList{"important_dates"};
        QTest::newRow("already-empty") << QStringList{"birthday"};
    }
    void profileClearRejectsInvalidSelections() {
        QFETCH(QStringList, fields);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        bridge.proposeProfileClear();
        const auto before = bridge.m_commands;
        bridge.confirmProfileClear(fields, bridge.scopeKey(), QString(64, 'a'));
        QCOMPARE(profileClearStatus(bridge), QString("error"));
        QCOMPARE(bridge.m_commands, before);
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
    }
    void profileClearBindsScopeAndSnapshot_data() {
        QTest::addColumn<bool>("wrongScope");
        QTest::newRow("wrong-scope") << true;
        QTest::newRow("wrong-snapshot") << false;
    }
    void profileClearBindsScopeAndSnapshot() {
        QFETCH(bool, wrongScope);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        bridge.proposeProfileClear();
        const auto before = bridge.m_commands;
        bridge.confirmProfileClear({"nickname"}, wrongScope ? "other:1:scope" : bridge.scopeKey(),
                                   QString(64, wrongScope ? 'a' : 'b'));
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        QCOMPARE(bridge.m_commands, before);
    }
    void profileClearOldReadsAndNewSnapshotsCannotReviveAProposal() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto oldRead = bridge.request("user:profile:get");
        knownProfile(bridge);
        bridge.event(frame("user:profile:result", oldRead, userProfileSnapshot('c', true)));
        QCOMPARE(bridge.state().value("profile").toMap().value("profile_snapshot").toString(), QString(64, 'a'));
        bridge.proposeProfileClear();
        knownProfile(bridge, userProfileSnapshot('b'));
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        bridge.confirmProfileClear({"nickname"}, bridge.scopeKey(), QString(64, 'a'));
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
        bridge.proposeProfileClear();
        const auto failedRead = bridge.request("user:profile:get");
        bridge.expirePending(failedRead);
        QCOMPARE(profileClearStatus(bridge), QString("stale"));
        QVERIFY(!bridge.profileSnapshotKnown());
    }
    void profileClearPendingSendsExactlyOneBoundMutation() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        QList<QJsonObject> frames;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            frames << QJsonDocument::fromJson(bytes.mid(4)).object();
            return bytes.size();
        };
        const auto id = beginProfileClear(bridge);
        QVERIFY(!id.isEmpty());
        const auto body = frames.first()["envelope"].toObject()["payload"].toObject();
        QCOMPARE(body.keys(), (QStringList{"clear_fields", "expected_profile_snapshot"}));
        QCOMPARE(body["clear_fields"].toArray(), (QJsonArray{"nickname", "interests"}));
        QCOMPARE(body["expected_profile_snapshot"].toString(), QString(64, 'a'));
        bridge.confirmProfileClear({"name"}, bridge.scopeKey(), QString(64, 'a'));
        bridge.proposeProfileClear();
        bridge.saveProfile({{"nickname", "重复保存"}});
        bridge.refreshProfile();
        bridge.cancelProfileClear();
        QCOMPARE(frames.size(), 1);
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 1);
        QCOMPARE(profileClearStatus(bridge), QString("pending"));
        QCOMPARE(bridge.profileClearState().value("requestId").toString(), id);
    }
    void profileClearKnownRejectionsReadWithoutReplacingTheFullProfile_data() {
        QTest::addColumn<QString>("code");
        QTest::newRow("stale-snapshot") << QString("PROFILE_SNAPSHOT_CHANGED");
        QTest::newRow("invalid-clear") << QString("PROFILE_CLEAR_INVALID");
        QTest::newRow("unavailable-before-mutation") << QString("PROFILE_CLEAR_UNAVAILABLE");
    }
    void profileClearKnownRejectionsReadWithoutReplacingTheFullProfile() {
        QFETCH(QString, code);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto saved = bridge.state().value("profile");
        const auto id = beginProfileClear(bridge);
        bridge.event(frame("user:profile:result", id, {{"ok", false}, {"operation", "clear"},
            {"error_code", code}, {"profile", QJsonObject{{"nickname", "其他内容"}}},
            {"profile_snapshot", QString(64, 'c')}, {"error", "fixed error"}}));
        QCOMPARE(profileClearStatus(bridge), QString("error"));
        QCOMPARE(bridge.state().value("profile"), saved);
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 1);
        bridge.event(frame("user:profile:result", bridge.m_profileReadId, userProfileSnapshot('c')));
        QCOMPARE(profileClearStatus(bridge), QString("error"));
        QVERIFY(bridge.profileSnapshotKnown());
        bridge.proposeProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("confirmation"));
        const auto rejectedAgain = beginProfileClear(bridge);
        bridge.event(frame("user:profile:result", rejectedAgain, {{"ok", false}, {"operation", "clear"},
            {"error_code", code}, {"error", "fixed error"}}));
        bridge.event(frame("user:profile:result", bridge.m_profileReadId, {{"ok", false}, {"error", "read failed"}}));
        QCOMPARE(profileClearStatus(bridge), QString("error"));
        QVERIFY(bridge.profileClearState().value("text").toString().contains("本次清空未执行"));
        QVERIFY(bridge.profileClearState().value("text").toString().contains("读取也未获确认"));
        QVERIFY(!bridge.profileSnapshotKnown());
    }
    void profileClearUnknownTimeoutReconcilesOnceAndNeedsManualRefresh() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto id = beginProfileClear(bridge);
        const auto beforeTimeout = bridge.m_commands;
        bridge.expirePending(id);
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(bridge.m_commands, beforeTimeout + 1);
        const auto read = bridge.m_profileReadId;
        bridge.expirePending(id);
        bridge.event(frame("user:profile:result", id, profileClearReceipt()));
        bridge.event(frame("user:profile:result", read, userProfileSnapshot('b', true)));
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(bridge.m_commands, beforeTimeout + 1);
        QCOMPARE(bridge.state().value("profile").toMap().value("profile").toMap().value("nickname").toString(), QString());
        bridge.proposeProfileClear();
        bridge.saveProfile({{"nickname", "不得重发"}});
        QCOMPARE(bridge.m_commands, beforeTimeout + 1);
        bridge.refreshProfile();
        const auto manualRead = bridge.m_profileReadId;
        QVERIFY(manualRead != read);
        bridge.event(frame("user:profile:result", manualRead, userProfileSnapshot('b', true)));
        QCOMPARE(profileClearStatus(bridge), QString("refreshed"));
        QVERIFY(bridge.profileClearState().value("text").toString().contains("先前清空结果仍未知"));
        bridge.proposeProfileClear();
        QCOMPARE(profileClearStatus(bridge), QString("confirmation"));
        QCOMPARE(bridge.profileClearState().value("availableFields").toStringList(), QStringList{"name"});
    }
    void profileClearUnknownReadFailureDoesNotLoopOrPromiseUnchanged() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto id = beginProfileClear(bridge);
        bridge.event(frame("user:profile:result", id, {{"ok", false}, {"operation", "clear"},
            {"error_code", "PROFILE_CLEAR_UNCONFIRMED"}, {"error", "fixed failure"}}));
        const auto count = bridge.m_commands;
        const auto read = bridge.m_profileReadId;
        bridge.expirePending(read);
        bridge.expirePending(read);
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(bridge.m_commands, count);
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 0);
        QVERIFY(!bridge.profileClearState().value("text").toString().contains("原资料保留"));
        QVERIFY(!bridge.profileClearState().value("text").toString().contains("没有改动"));
    }
    void profileClearMalformedReceiptsReconcileWithoutSuccess_data() {
        QTest::addColumn<QString>("failure");
        for (const auto &name : {"operation", "fields", "duplicate-fields", "snapshot", "not-empty", "other-field"})
            QTest::newRow(name) << QString::fromLatin1(name);
    }
    void profileClearMalformedReceiptsReconcileWithoutSuccess() {
        QFETCH(QString, failure);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto id = beginProfileClear(bridge);
        auto result = profileClearReceipt();
        if (failure == "operation") result["operation"] = "update";
        if (failure == "fields") result["cleared_fields"] = QJsonArray{"nickname"};
        if (failure == "duplicate-fields") result["cleared_fields"] = QJsonArray{"nickname", "nickname", "interests"};
        if (failure == "snapshot") result["profile_snapshot"] = QString(64, 'a');
        auto profile = result["profile"].toObject();
        if (failure == "not-empty") profile["nickname"] = "仍有内容";
        if (failure == "other-field") profile["name"] = "未选择的字段被改动";
        result["profile"] = profile;
        bridge.event(frame("user:profile:result", id, result));
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 1);
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
    }
    void profileClearSuccessRequiresItsFreshReceiptAndAuthoritativeRead() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        bridge.setDraft("当前聊天编辑");
        const auto saved = bridge.state().value("profile");
        const auto id = beginProfileClear(bridge);
        for (const auto &field : {"persona_id", "persona_epoch", "persona_fingerprint"}) {
            auto foreign = profileClearReceipt();
            foreign[QString::fromLatin1(field)] = QString::fromLatin1(field) == "persona_epoch"
                ? QJsonValue(2) : QJsonValue("old-scope");
            bridge.event(frame("user:profile:result", id, foreign));
        }
        QCOMPARE(profileClearStatus(bridge), QString("pending"));
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 1);
        bridge.event(frame("user:profile:result", "unrelated-request", profileClearReceipt()));
        QCOMPARE(bridge.state().value("profile"), saved);
        bridge.event(frame("user:profile:result", id, profileClearReceipt()));
        QCOMPARE(profileClearStatus(bridge), QString("pending"));
        QCOMPARE(bridge.state().value("profile"), saved);
        const auto read = bridge.m_profileReadId;
        QCOMPARE(bridge.request("user:profile:get"), read);
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 1);
        bridge.event(frame("user:profile:result", read, userProfileSnapshot('b', true)));
        QCOMPARE(profileClearStatus(bridge), QString("success"));
        QVERIFY(bridge.profileClearState().value("text").toString().contains("称呼、兴趣"));
        QCOMPARE(bridge.draft(), QString("当前聊天编辑"));
        QVERIFY(memoryReceipt(bridge, "profile").isEmpty());
        QCOMPARE(bridge.state().value("profile").toMap().value("emotional_memories").toList(),
                 (QVariantList{QString("独立的情绪记忆")}));
    }
    void profileClearReadbackMismatchStaysUnknown_data() {
        QTest::addColumn<bool>("timeout");
        QTest::newRow("changed-since-receipt") << false;
        QTest::newRow("read-timeout") << true;
    }
    void profileClearReadbackMismatchStaysUnknown() {
        QFETCH(bool, timeout);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto id = beginProfileClear(bridge);
        bridge.event(frame("user:profile:result", id, profileClearReceipt()));
        const auto count = bridge.m_commands;
        if (timeout)
            bridge.expirePending(bridge.m_profileReadId);
        else
            bridge.event(frame("user:profile:result", bridge.m_profileReadId, userProfileSnapshot('c')));
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(bridge.m_commands, count);
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 0);
    }
    void profileClearDisconnectAndPersonaChangeCannotSettleOldRequests() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownProfile(bridge);
        const auto id = beginProfileClear(bridge);
        bridge.m_connected = false;
        bridge.expirePending(id);
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        QCOMPARE(pendingCount(bridge, "user:profile:get"), 0);
        bridge.m_connected = true;
        const auto read = bridge.request("user:profile:get");
        QCOMPARE(bridge.profileClearState().value("readId").toString(), read);
        bridge.event(frame("user:profile:result", read, userProfileSnapshot('b', true)));
        QCOMPARE(profileClearStatus(bridge), QString("unknown"));
        bridge.event(frame("persona:scope", {}, {{"persona_id", "next"}, {"epoch", 4}, {"fingerprint", "next-proof"}}));
        QVERIFY(bridge.profileClearState().isEmpty());
        bridge.event(frame("user:profile:result", id, profileClearReceipt()));
        QVERIFY(bridge.profileClearState().isEmpty());
        QVERIFY(!bridge.state().contains("profile"));
        QCOMPARE(pendingCount(bridge, "user:profile:update"), 0);
    }
    void personaListIsKeptOnlyFromSuccessfulReadsInTheCurrentScope() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        personaList(bridge, "default");
        QCOMPARE(bridge.state().value("personas").toMap().value("profiles").toList().size(), 2);
        auto refused = personaScope(bridge);
        refused["ok"] = false;
        refused["code"] = "persona_registry_unavailable";
        bridge.event(frame("persona:list:result", bridge.request("persona:list"), refused));
        QCOMPARE(bridge.state().value("personas").toMap().value("profiles").toList().size(), 2);
        const auto foreign = QJsonObject{{"ok", true}, {"profiles", QJsonArray{}},
                                         {"persona_id", "persona-old"}, {"persona_epoch", 2},
                                         {"persona_fingerprint", "fingerprint-old"}};
        bridge.event(frame("persona:list:result", bridge.request("persona:list"), foreign));
        QCOMPARE(bridge.state().value("personas").toMap().value("profiles").toList().size(), 2);
    }
    void personaCardParserKeepsOriginalJsonAndStrictlyReadsPng() {
        const QByteArray json = " {\"name\":\"first\",\"name\":\"second\",\"description\":\"raw\"}\n";
        const auto plain = PersonaCardReader::parseBytes(json, "raw.json");
        QVERIFY(plain.valid());
        // Backend duplicate-key validation must receive the original text.
        QCOMPARE(plain.json.toUtf8(), json);
        QCOMPARE(plain.targetId, "st_" + QString::fromLatin1(QCryptographicHash::hash(json, QCryptographicHash::Sha256).toHex().left(20)));
        const auto chara = PersonaCardReader::parseBytes(pngCard(), "chara.png");
        QVERIFY(chara.valid());
        QCOMPARE(chara.json.toUtf8(), cardJson());
        const auto direct = PersonaCardReader::parseBytes(pngCard(cardJson(), "chara", true), "direct.png");
        QVERIFY(direct.valid());
        QCOMPARE(direct.json, chara.json);
        const QByteArray v3 = R"({"spec":"chara_card_v3","data":{"name":"preferred"}})";
        const auto both = QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", QByteArray("chara\0", 6) + cardJson().toBase64()) +
            pngChunk("tEXt", QByteArray("ccv3\0", 5) + v3.toBase64()) + pngChunk("IEND", {});
        const auto preferred = PersonaCardReader::parseBytes(both, "both.png");
        QVERIFY(preferred.valid());
        QCOMPARE(preferred.json.toUtf8(), v3);
        QCOMPARE(preferred.name, QString("preferred"));
    }
    void personaCardParserRejectsBrokenAndOversizedPng_data() {
        QTest::addColumn<QByteArray>("bytes");
        auto crc = pngCard();
        crc[crc.size() - 1] = char(crc.back() ^ 1);
        QTest::newRow("bad-crc") << crc;
        auto truncated = pngCard();
        truncated.chop(12);
        QTest::newRow("missing-iend") << truncated;
        QTest::newRow("ordinary-png") << QByteArray::fromHex("89504e470d0a1a0a") + pngChunk("IEND", {});
        QTest::newRow("not-png") << QByteArray("not a PNG");
        const auto duplicate = QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", QByteArray("chara\0", 6) + cardJson().toBase64()) +
            pngChunk("tEXt", QByteArray("chara\0", 6) + cardJson().toBase64()) + pngChunk("IEND", {});
        QTest::newRow("duplicate-chara") << duplicate;
        const auto invalidBase64 = QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", QByteArray("chara\0!invalid!", 15)) + pngChunk("IEND", {});
        QTest::newRow("invalid-base64") << invalidBase64;
        const auto missingPadding = QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", QByteArray("chara\0", 6) + QByteArray("{\"name\":\"xx\"}").toBase64().chopped(1)) + pngChunk("IEND", {});
        QTest::newRow("noncanonical-base64") << missingPadding;
        const auto invalidUtf8 = QByteArray("{\"name\":\"") + char(0xff) + "\"}";
        QTest::newRow("invalid-decoded-utf8") << pngCard(invalidUtf8);
        QTest::newRow("invalid-direct-utf8") << pngCard(invalidUtf8, "chara", true);
        QTest::newRow("too-large-text") << QByteArray::fromHex("89504e470d0a1a0a") +
            pngChunk("tEXt", QByteArray(3 * 1024 * 1024 + 1, 'x')) + pngChunk("IEND", {});
        auto many = QByteArray::fromHex("89504e470d0a1a0a");
        for (int i = 0; i < 10000; ++i)
            many += pngChunk("vpAg", {});
        many += pngChunk("IEND", {});
        QTest::newRow("too-many-chunks") << many;
        QTest::newRow("too-large-png") << QByteArray(16 * 1024 * 1024 + 1, 'x');
    }
    void personaCardParserRejectsBrokenAndOversizedPng() {
        QFETCH(QByteArray, bytes);
        const auto card = PersonaCardReader::parseBytes(bytes, "invalid.png");
        QVERIFY(!card.valid());
        QVERIFY(!card.error.isEmpty());
        QVERIFY(card.json.isEmpty());
    }
    void personaCardSelectionIsReadOnlyAndRequiresAnIdleWritableRuntime() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        const auto source = data.filePath("local.json");
        QVERIFY(writeLocal(source, cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        online(bridge);
        bridge.m_runtimeWritable = false;
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        bridge.m_runtimeWritable = true;
        bridge.m_busy = true;
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        bridge.m_busy = false;
        bridge.m_personaSwitch = {{"requestId", "another-switch"}};
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        bridge.m_personaSwitch.clear();
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("confirmation"));
        QCOMPARE(bridge.personaCardCandidate().value("filename").toString(), QString("local.json"));
        QCOMPARE(bridge.m_personaCardJson.toUtf8(), cardJson());
        QCOMPARE(pendingCount(bridge, "persona:import"), 0);
        QFile original(source);
        QVERIFY(original.open(QIODevice::ReadOnly));
        QCOMPARE(original.readAll(), cardJson());
        QCOMPARE(QDir(data.path()).entryList(QDir::Files), QStringList{"local.json"});
        bridge.cancelPersonaCard();
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        bridge.sendChat();
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
        QVERIFY(QFile::link(source, data.filePath("linked.json")));
        QVERIFY(!PersonaCardReader::readFile(data.filePath("linked.json")).valid());
        QVERIFY(!PersonaCardReader::parseBytes(QByteArray(1048577, 'x'), "large.json").valid());
        QVERIFY(!PersonaCardReader::parseBytes(QByteArray("{\"name\":\"") + char(0xff) + "\"}", "invalid.json").valid());
    }
    void personaCardImportFrameIsExactAndOverflowsLeaveNoPendingRequest() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QJsonObject sent;
        int writes = 0;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            ++writes;
            sent = QJsonDocument::fromJson(bytes.mid(4)).object();
            return bytes.size();
        };
        const auto source = data.filePath("local.json");
        QVERIFY(writeLocal(source, cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QCOMPARE(writes, 0);
        bridge.importPersonaCard();
        QCOMPARE(writes, 1);
        const auto envelope = sent["envelope"].toObject();
        QCOMPARE(sent["schema"].toString(), QString("reverie.command.v4"));
        QCOMPARE(envelope["command"].toString(), QString("persona:import"));
        QCOMPARE(envelope["persona"].toObject(), bridge.m_persona);
        const auto payload = envelope["payload"].toObject();
        QCOMPARE(payload["json"].toString().toUtf8(), cardJson());
        QCOMPARE(payload["filename"].toString(), QString("local.json"));
        QVERIFY(payload["identity_change_confirmed"].toBool());
        QCOMPARE(payload["actor"].toString(), QString("owner"));
        QVERIFY(!payload["reason"].toString().isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        const auto id = envelope["request_id"].toString();
        QCOMPARE(bridge.personaCardFeedback().value("requestId").toString(), id);
        bridge.importPersonaCard();
        QCOMPARE(writes, 1);
        bridge.expirePending(id);
        QVERIFY(bridge.m_pending.contains(id));
        const auto pendingBefore = bridge.m_pending.size();
        QVERIFY(bridge.request("archive:put", {{"text", QString(600000, '\n')}}).isEmpty());
        QCOMPARE(bridge.m_pending.size(), pendingBefore);
        QCOMPARE(writes, 1);
        bool callbackCalled = false;
        QVERIFY(bridge.control("test:oversized", {{"text", QString(600000, '\n')}},
            [&](QJsonObject result) { callbackCalled = true; QVERIFY(result["not_sent"].toBool()); }).isEmpty());
        QVERIFY(callbackCalled);
        QCOMPARE(bridge.m_pending.size(), pendingBefore);
        bridge.forgetPersonaCardImport("test clears operation");
        // Source bytes fit, but doubled escapes and envelope do not.
        // Use raw backslashes (valid JSON) with escaping amplification.
        const auto raw = QByteArray("{\"name\":\"Large\",\"description\":\"") + QByteArray(500000, '\\').replace("\\", "\\\\") + "\"}";
        QVERIFY(raw.size() < 1048576);
        QVERIFY(writeLocal(source, raw));
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.personaCardCandidate().isEmpty());
        QCOMPARE(pendingCount(bridge, "persona:import"), 0);
    }
    void personaCardImportNeedsItsOriginalScopedReceiptAfterIdentityReset() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.png"), pngCard()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.png")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto scope = importedScope(bridge);
        const auto receipt = importReceipt(scope);
        bridge.event(frame("persona:data", "", scope));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("pending"));
        QVERIFY(!bridge.m_pending.contains(id));
        QCOMPARE(bridge.m_personaImport.value("requestId").toString(), id);
        bridge.event(frame("persona:import:result", "unrelated-id", receipt));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("pending"));
        auto foreign = receipt;
        foreign["persona_fingerprint"] = "foreign-fingerprint";
        bridge.event(frame("persona:import:result", id, foreign));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("pending"));
        bridge.event(frame("persona:import:result", id, receipt));
        const auto feedback = bridge.personaCardFeedback();
        QCOMPARE(feedback.value("status").toString(), QString("success"));
        QCOMPARE(feedback.value("requestId").toString(), id);
        QCOMPARE(feedback.value("quarantinedFields").toInt(), 1);
        QCOMPARE(feedback.value("worldBookEntries").toInt(), 1);
        QCOMPARE(feedback.value("warnings").toList().size(), 1);
        QCOMPARE(feedback.value("text").toString(),
                 QString("已导入并切换为「Local card」。卡内世界书 1 条已写入这个人格的资料；"
                         "卡作者的系统提示已隔离保存，默认不启用，可在本页下方开启。"));
        QVERIFY(bridge.m_personaImport.isEmpty());
        bridge.event(frame("persona:import:result", id, foreign));
        QCOMPARE(bridge.personaCardFeedback(), feedback);
    }
    void personaCardReceiptTextNamesOnlyWhatTheReceiptConfirms_data() {
        QTest::addColumn<QJsonObject>("changes");
        QTest::addColumn<QString>("status");
        QTest::addColumn<QString>("text");
        QTest::newRow("book-written-prompt-quarantined")
            << QJsonObject{} << QString("success")
            << QString("已导入并切换为「Local card」。卡内世界书 1 条已写入这个人格的资料；"
                       "卡作者的系统提示已隔离保存，默认不启用，可在本页下方开启。");
        // The importer suffixes each quarantined prompt with its screening result.
        QTest::newRow("both-prompts-stored")
            << QJsonObject{{"ignored_fields", QJsonArray{"system_prompt:stored_untrusted",
                                                         "post_history_instructions:stored_untrusted"}}}
            << QString("success")
            << QString("已导入并切换为「Local card」。卡内世界书 1 条已写入这个人格的资料；"
                       "卡作者的系统提示和对话后指令已隔离保存，默认不启用，可在本页下方开启。");
        QTest::newRow("flagged-prompt-cannot-be-enabled")
            << QJsonObject{{"ignored_fields", QJsonArray{"system_prompt:stored_untrusted",
                                                         "post_history_instructions:untrusted_injection"}}}
            << QString("success")
            << QString("已导入并切换为「Local card」。卡内世界书 1 条已写入这个人格的资料；"
                       "卡作者的系统提示已隔离保存，默认不启用，可在本页下方开启；"
                       "卡作者的对话后指令含可疑指令，已隔离，不能启用。");
        QTest::newRow("both-prompts-flagged-without-a-book")
            << QJsonObject{{"world_book_imported", false}, {"world_book_entry_count", 0},
                           {"ignored_fields", QJsonArray{"system_prompt:untrusted_injection",
                                                         "post_history_instructions:untrusted_injection"}}}
            << QString("success")
            << QString("已导入并切换为「Local card」。卡作者的系统提示和对话后指令含可疑指令，已隔离，不能启用。");
        QTest::newRow("book-not-written")
            << QJsonObject{{"world_book_imported", false},
                           {"archive_warning", "档案版本已变化，卡内世界书未写入，角色卡本身已导入"}}
            << QString("partial")
            << QString("已导入并切换为「Local card」。卡内世界书 1 条没有写入；"
                       "卡作者的系统提示已隔离保存，默认不启用。"
                       "资料写入提示：档案版本已变化，卡内世界书未写入，角色卡本身已导入。");
        QTest::newRow("nothing-to-report")
            << QJsonObject{{"world_book_imported", false}, {"world_book_entry_count", 0},
                           {"ignored_fields", QJsonArray{}}}
            << QString("success") << QString("已导入并切换为「Local card」。");
        QTest::newRow("removed-and-ignored-parts")
            << QJsonObject{{"world_book_entry_count", 2},
                           {"ignored_fields", QJsonArray{"extensions", "first_mes:unsafe",
                                                         "character_book:entry_unsafe"}}}
            << QString("success")
            << QString("已导入并切换为「Local card」。卡内世界书 2 条已写入这个人格的资料；"
                       "问候语或示例对话中的可疑指令已移除；卡内世界书有条目没有导入；"
                       "扩展、资源等附加数据已忽略，不会执行或加载。");
    }
    void personaCardReceiptTextNamesOnlyWhatTheReceiptConfirms() {
        QFETCH(QJsonObject, changes);
        QFETCH(QString, status);
        QFETCH(QString, text);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.png"), pngCard()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.png")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto scope = importedScope(bridge);
        bridge.event(frame("persona:data", "", scope));
        auto receipt = importReceipt(scope);
        // The importer's own lines: one names an editor this window does not
        // have, the other reports a book whether or not it was written.
        receipt["warnings"] = QJsonArray{"卡作者提示词已隔离保存，默认不启用；可在角色卡编辑器中选择性开启",
                                         "卡内世界书已安全导入（1 条设定）"};
        for (auto it = changes.constBegin(); it != changes.constEnd(); ++it)
            receipt[it.key()] = it.value();
        bridge.event(frame("persona:import:result", id, receipt));
        const auto feedback = bridge.personaCardFeedback();
        QCOMPARE(feedback.value("status").toString(), status);
        QCOMPARE(feedback.value("text").toString(), text);
        // Kept for diagnostics only.
        QCOMPARE(feedback.value("warnings").toList().size(), 2);
    }
    void personaCardImportRejectsUnrelatedIdentityAndLateDisconnectedResults() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto source = data.filePath("local.json");
        QVERIFY(writeLocal(source, cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto receipt = importReceipt(importedScope(bridge));
        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(bridge.m_personaImport.isEmpty());
        const auto unrelated = bridge.personaCardFeedback();
        bridge.event(frame("persona:import:result", id, receipt));
        QCOMPARE(bridge.personaCardFeedback(), unrelated);
        bridge.choosePersonaCard(QUrl::fromLocalFile(source));
        bridge.importPersonaCard();
        const auto nextId = bridge.personaCardFeedback().value("requestId").toString();
        const auto nextReceipt = importReceipt(importedScope(bridge));
        bridge.m_connected = false;
        bridge.forgetPersonaCardImport("connection lost");
        const auto disconnected = bridge.personaCardFeedback();
        bridge.event(frame("persona:import:result", nextId, nextReceipt));
        QCOMPARE(bridge.personaCardFeedback(), disconnected);
        bridge.m_connected = true;
        bridge.event(frame("persona:import:result", nextId, nextReceipt));
        QCOMPARE(bridge.personaCardFeedback(), disconnected);
    }
    void personaCardImportSeparatesSavedPartialDuplicateAndUnreadyResults_data() {
        QTest::addColumn<QJsonObject>("result");
        QTest::addColumn<QString>("status");
        QTest::newRow("saved-only") << QJsonObject{{"ok", true}, {"saved", true}, {"activated", false},
            {"runtime_ready", false}, {"partial_write", false}, {"world_book_imported", false}} << QString("saved");
        QTest::newRow("saved-with-book") << QJsonObject{{"ok", true}, {"saved", true}, {"activated", false},
            {"runtime_ready", false}, {"partial_write", false}, {"world_book_imported", false},
            {"world_book_entry_count", 2}} << QString("saved");
        QTest::newRow("duplicate") << QJsonObject{{"ok", false}, {"code", "already_imported"},
            {"saved", false}, {"activated", false}, {"runtime_ready", false}, {"partial_write", false}} << QString("error");
        QTest::newRow("partial-write") << QJsonObject{{"ok", false}, {"code", "import_save_incomplete"},
            {"saved", false}, {"activated", false}, {"runtime_ready", false}, {"partial_write", true}} << QString("partial");
        QTest::newRow("orphan-files") << QJsonObject{{"ok", false}, {"code", "local_profile_conflict"},
            {"saved", false}, {"activated", false}, {"runtime_ready", false}, {"partial_write", true}} << QString("partial");
        QTest::newRow("validation") << QJsonObject{{"ok", false}, {"code", "invalid_card"},
            {"error", "角色名称无效"}, {"saved", false}, {"activated", false}, {"runtime_ready", false}, {"partial_write", false}} << QString("error");
        QTest::newRow("unknown-storage") << QJsonObject{{"ok", false}, {"code", "internal_error"},
            {"error", "private implementation path"}} << QString("unknown");
    }
    void personaCardImportSeparatesSavedPartialDuplicateAndUnreadyResults() {
        QFETCH(QJsonObject, result);
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        bridge.event(frame("persona:import:result", id, result));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), status);
        QCOMPARE(bridge.personaCardFeedback().value("requestId").toString(), id);
        QVERIFY(bridge.m_personaImport.isEmpty());
        QVERIFY(!bridge.personaCardFeedback().value("text").toString().contains("private implementation"));
        QVERIFY(!bridge.personaCardFeedback().value("text").toString().contains("未写入任何档案"));
        if (result["code"].toString() == "already_imported")
            QCOMPARE(bridge.personaCardFeedback().value("code").toString(), QString("already_imported"));
        if (result["code"].toString() == "local_profile_conflict")
            QVERIFY(bridge.personaCardFeedback().value("text").toString().contains("保留且未覆盖"));
        // A saved, unswitched card mentions its world book only when it has one.
        if (status == "saved")
            QCOMPARE(bridge.personaCardFeedback().value("text").toString().contains("世界书"),
                     result["world_book_entry_count"].toInt() > 0);
    }
    void personaCardActivationWithoutWritableRuntimeIsNotFullImportSuccess() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto scope = importedScope(bridge);
        bridge.event(frame("persona:data", "", scope));
        bridge.m_runtimeWritable = false;
        auto receipt = importReceipt(scope);
        receipt["runtime_ready"] = false;
        bridge.event(frame("persona:import:result", id, receipt));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(bridge.personaCardFeedback().value("saved").toBool());
        QVERIFY(bridge.personaCardFeedback().value("activated").toBool());
        QVERIFY(!bridge.personaCardFeedback().value("runtimeReady").toBool());
    }
    void savedCardWithAnUncertainActivationReadsIdentityWithoutRetry_data() {
        QTest::addColumn<QJsonObject>("result");
        QTest::addColumn<bool>("observedTarget");
        QTest::addColumn<bool>("targetProof");
        QTest::newRow("saved-top-level-internal") << QJsonObject{{"ok", false}, {"saved", true},
            {"activated", false}, {"partial_write", false}, {"code", "internal_error"}} << false << false;
        QTest::newRow("saved-explicit-activation-unknown") << QJsonObject{{"ok", true}, {"saved", true},
            {"activated", false}, {"partial_write", false}, {"activation_unknown", true},
            {"activation", QJsonObject{{"ok", false}, {"code", "outcome_unknown"}}}} << false << false;
        QTest::newRow("saved-nested-internal") << QJsonObject{{"ok", true}, {"saved", true},
            {"activated", false}, {"partial_write", false},
            {"activation", QJsonObject{{"ok", false}, {"code", "internal_error"}}}} << false << false;
        QTest::newRow("saved-possible-commit-target-proof") << QJsonObject{{"ok", true}, {"saved", true},
            {"activated", false}, {"partial_write", false},
            {"activation", QJsonObject{{"ok", false}, {"code", "internal_error"}}}} << false << true;
        QTest::newRow("observed-target-with-false-activation") << QJsonObject{{"ok", true}, {"saved", true},
            {"activated", false}, {"partial_write", false}} << true << true;
    }
    void savedCardWithAnUncertainActivationReadsIdentityWithoutRetry() {
        QFETCH(QJsonObject, result);
        QFETCH(bool, observedTarget);
        QFETCH(bool, targetProof);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        int importWrites = 0;
        int activationWrites = 0;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            const auto envelope = QJsonDocument::fromJson(bytes.mid(4)).object()["envelope"].toObject();
            importWrites += envelope["command"].toString() == "persona:import";
            activationWrites += envelope["command"].toString() == "persona:activate";
            return bytes.size();
        };
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto source = personaScope(bridge);
        const auto scope = importedScope(bridge);
        if (observedTarget)
            bridge.event(frame("persona:data", "", scope));
        // Ignore the normal refresh's read; the uncertain result must issue a
        // fresh read of the current identity instead of redoing the mutation.
        const auto readsBefore = pendingCount(bridge, "persona:get");
        const auto proof = targetProof ? scope : source;
        for (const auto &key : {"persona_id", "persona_epoch", "persona_fingerprint"})
            result[key] = proof[key];
        bridge.event(frame("persona:import:result", id, result));
        const auto feedback = bridge.personaCardFeedback();
        QCOMPARE(feedback.value("status").toString(), QString("unknown"));
        QVERIFY(feedback.value("saved").toBool());
        QVERIFY(feedback.value("activationUnknown").toBool());
        QCOMPARE(feedback.value("requestId").toString(), id);
        QVERIFY(!feedback.value("text").toString().contains("未切换"));
        QVERIFY(!feedback.value("text").toString().contains("未写入"));
        QCOMPARE(pendingCount(bridge, "persona:get"), readsBefore + 1);
        QCOMPARE(importWrites, 1);
        QCOMPARE(activationWrites, 0);
        QVERIFY(bridge.m_personaImport.isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
    }
    void personaCardCompletedReceiptStillNeedsTheLiveIdentityRead() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto scope = importedScope(bridge);
        bridge.event(frame("persona:import:result", id, importReceipt(scope)));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("pending"));
        const auto verify = bridge.m_personaImport.value("verifyId").toString();
        QVERIFY(!verify.isEmpty());
        bridge.event(frame("persona:data", verify, scope));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("success"));
        QVERIFY(bridge.m_personaImport.isEmpty());
    }
    void personaCardScopeBroadcastStillRequiresTheOriginalImportResult() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        const auto scope = importedScope(bridge);
        bridge.event(frame("persona:scope", "", {{"persona_id", scope["persona_id"]},
            {"epoch", scope["persona_epoch"]}, {"fingerprint", scope["persona_fingerprint"]}}));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("pending"));
        QVERIFY(!bridge.m_pending.contains(id));
        bridge.event(frame("persona:import:result", id, importReceipt(scope)));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("success"));
    }
    void aCardIdentityEpochJumpCannotReuseAnEarlierImportOperation() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        const auto id = bridge.personaCardFeedback().value("requestId").toString();
        auto scope = importedScope(bridge);
        scope["persona_epoch"] = scope["persona_epoch"].toInt() + 1;
        bridge.event(frame("persona:data", "", scope));
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(bridge.m_personaImport.isEmpty());
        const auto feedback = bridge.personaCardFeedback();
        bridge.event(frame("persona:import:result", id, importReceipt(scope)));
        QCOMPARE(bridge.personaCardFeedback(), feedback);
    }
    void failedFrameEnqueueDoesNotLeaveControlsOrImportsWaiting() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_frameWriter = [](const QByteArray &) -> qint64 { return -1; };
        QVERIFY(writeLocal(data.filePath("local.json"), cardJson()));
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("local.json")));
        bridge.importPersonaCard();
        QCOMPARE(bridge.personaCardFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.m_personaImport.isEmpty());
        QVERIFY(bridge.m_personaCardJson.isEmpty());
        QVERIFY(bridge.m_pending.isEmpty());
        bridge.m_providerTest = provider("tested-model");
        bridge.saveProvider();
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.m_providerSaveId.isEmpty());
        QVERIFY(bridge.m_pending.isEmpty());
        bridge.setOffline(true);
        QCOMPARE(bridge.networkFeedback().value("status").toString(), QString("error"));
        QVERIFY(bridge.m_networkRequestId.isEmpty());
        QVERIFY(bridge.m_pending.isEmpty());
        bridge.exportBackup(QUrl::fromLocalFile(data.filePath("export.json")));
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("error"));
        QVERIFY(!QFile::exists(data.filePath("export.json")));
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(data.filePath("local.json")));
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("error"));
        QVERIFY(bridge.m_backupStaged.isEmpty());
        QVERIFY(bridge.m_pending.isEmpty());
        const auto staged = data.filePath("staged.json");
        QVERIFY(writeLocal(staged, cardJson()));
        QString error;
        bridge.m_backupSource = data.filePath("local.json");
        bridge.m_backupSourceBinding = RuntimeBridge::backupFileBinding(bridge.m_backupSource, &error);
        const auto stagedBinding = RuntimeBridge::backupFileBinding(staged, &error);
        bridge.m_backupStaged = staged;
        bridge.m_backupInspection = {{"sha256", stagedBinding["sha256"]}, {"file_bytes", stagedBinding["file_bytes"]}};
        QSignalSpy reconciled(&bridge, &RuntimeBridge::backupRestoreReconciled);
        bridge.confirmBackupRestore();
        QVERIFY(!bridge.backupRestoring());
        QVERIFY(bridge.runtimeWritable());
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("error"));
        QCOMPARE(reconciled.count(), 0);
        QVERIFY(bridge.m_pending.isEmpty());
    }
    void personaSwitchNeedsAListedInactiveProfileAndAnIdleWritableRuntime() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        personaList(bridge, "default");
        bridge.selectPersona("st_missing");
        QCOMPARE(personaStatus(bridge), QString("error"));
        bridge.m_personaFeedback.clear();
        bridge.selectPersona("default");
        QVERIFY(bridge.personaFeedback().isEmpty());
        bridge.m_busy = true;
        bridge.selectPersona("st_a");
        QVERIFY(bridge.personaFeedback().value("text").toString().startsWith("回复进行中"));
        bridge.m_busy = false;
        bridge.m_runtimeWritable = false;
        bridge.selectPersona("st_a");
        QCOMPARE(bridge.personaFeedback().value("text").toString(), QString("写入已锁定，没有切换人格。"));
        QCOMPARE(pendingCount(bridge, "persona:activate"), 0);

        bridge.m_runtimeWritable = true;
        bridge.selectPersona("st_a");
        bridge.selectPersona("st_a");
        QCOMPARE(pendingCount(bridge, "persona:activate"), 1);
        QCOMPARE(personaStatus(bridge), QString("pending"));
        // The identity transaction is settled by its reply, the identity change
        // or a lost connection, never by the ordinary request timer.
        const auto id = controlId(bridge, "persona:activate");
        bridge.expirePending(id);
        QCOMPARE(pendingCount(bridge, "persona:activate"), 1);
        QCOMPARE(personaStatus(bridge), QString("pending"));
        bridge.m_connected = false;
        bridge.expirePending(id);
        QCOMPARE(pendingCount(bridge, "persona:activate"), 0);
        QCOMPARE(personaStatus(bridge), QString("unknown"));
        QVERIFY(bridge.m_personaSwitch.isEmpty());
    }
    void personaSwitchSettlesFromTheIdentityChangeAndKeepsRefusalsLocal() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setDraft("old persona draft");
        personaList(bridge, "default");
        bridge.selectPersona("st_a");
        const auto first = controlId(bridge, "persona:activate");
        const int generation = bridge.generation();
        // The live broadcast precedes the reply and resets the scope.
        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(bridge.scopeKey(), QString("persona-4:4:fingerprint-4"));
        QCOMPARE(bridge.generation(), generation + 1);
        QVERIFY(bridge.draft().isEmpty());
        QCOMPARE(personaStatus(bridge), QString("success"));
        QVERIFY(bridge.personaFeedback().value("text").toString().startsWith("已切换为「测试角色」"));
        QVERIFY(bridge.state().value("personas").toMap().isEmpty());
        auto late = nextIdentity(4);
        late["ok"] = true;
        late["activated"] = true;
        bridge.event(frame("persona:import:result", first, late));
        QCOMPARE(personaStatus(bridge), QString("success"));

        personaList(bridge, "st_a");
        bridge.selectPersona("default");
        auto conflict = nextIdentity(9);
        conflict["ok"] = false;
        conflict["code"] = "identity_conflict";
        conflict["conflict"] = true;
        bridge.event(frame("persona:import:result", controlId(bridge, "persona:activate"), conflict));
        QCOMPARE(bridge.scopeKey(), QString("persona-4:4:fingerprint-4"));
        QCOMPARE(personaStatus(bridge), QString("error"));
        QVERIFY(bridge.m_personaSwitch.isEmpty());

        // A transport failure leaves the outcome open until the live identity is read back.
        personaList(bridge, "st_a");
        bridge.selectPersona("default");
        bridge.event(frame("error", controlId(bridge, "persona:activate"),
                           {{"message", "The command result could not be committed safely"},
                            {"code", "storage_unavailable"}}));
        QCOMPARE(personaStatus(bridge), QString("unknown"));
        const auto verify = bridge.m_personaSwitch.value("verifyId").toString();
        QVERIFY(bridge.m_pending.contains(verify));
        auto unchanged = nextIdentity(4);
        unchanged["persona"] = QJsonObject{{"name", "测试角色"}};
        bridge.event(frame("persona:data", verify, unchanged));
        QCOMPARE(personaStatus(bridge), QString("error"));
        QVERIFY(bridge.personaFeedback().value("text").toString().startsWith("切换没有生效"));

        personaList(bridge, "st_a");
        bridge.selectPersona("default");
        bridge.event(frame("persona:data", "", nextIdentity(5, true)));
        QCOMPARE(personaStatus(bridge), QString("unknown"));
        QVERIFY(bridge.personaFeedback().value("text").toString().startsWith("已写入新身份"));
    }
    void personaSwitchIntoALockedRuntimeIsNotReportedAsSuccess() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        personaList(bridge, "default");
        bridge.selectPersona("st_a");
        // The backend reports writability before the identity broadcast.
        bridge.event({{"type", "runtime:activity"},
                      {"payload", QJsonObject{{"recovery_state", "recovery_required"},
                                              {"writes_blocked", true}, {"runtime_writable", false}}}});
        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(bridge.scopeKey(), QString("persona-4:4:fingerprint-4"));
        QVERIFY(!bridge.runtimeWritable());
        QCOMPARE(personaStatus(bridge), QString("unknown"));
        QVERIFY(bridge.personaFeedback().value("text").toString().startsWith("已切换为「测试角色」，但本地数据随后被锁定"));
    }
    void identityResetKeepsTheAppWideAvatarList() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const QVariantMap avatars{{"activeId", "avatar-a"},
                                  {"records", QVariantList{QVariantMap{{"id", "avatar-a"}, {"name", "测试形象"}}}}};
        bridge.m_state["avatars"] = avatars;
        bridge.m_state["profile"] = QVariantMap{{"profile", QVariantMap{{"nickname", "旧人格的资料"}}}};
        bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(bridge.state().value("avatars").toMap(), avatars);
        QVERIFY(!bridge.state().contains("profile"));
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-5"}, {"epoch", 5},
                                                  {"fingerprint", "fingerprint-5"}}));
        QCOMPARE(bridge.scopeKey(), QString("persona-5:5:fingerprint-5"));
        QCOMPARE(bridge.state().value("avatars").toMap(), avatars);
    }
    void backupStagingKeepsTheDesktopHostChecks() {
        QTemporaryDir data;
        const QDir root(data.path());
        const auto staging = data.filePath("staging");
        QString error;
        QVERIFY(RuntimeBridge::stageBackupFile("relative.json", staging, &error).isEmpty());
        QVERIFY(RuntimeBridge::stageBackupFile(data.filePath("backup.zip"), staging, &error).isEmpty());
        QVERIFY(root.mkpath("folder.json"));
        QVERIFY(RuntimeBridge::stageBackupFile(data.filePath("folder.json"), staging, &error).isEmpty());
        QFile empty(data.filePath("empty.json"));
        QVERIFY(empty.open(QIODevice::WriteOnly));
        empty.close();
        QVERIFY(RuntimeBridge::stageBackupFile(empty.fileName(), staging, &error).isEmpty());
        QFile real(data.filePath("real.json"));
        QVERIFY(real.open(QIODevice::WriteOnly));
        const QByteArray content = R"({"schema":"reverie.backup","user":{"nickname":"小星"}})";
        real.write(content);
        real.close();
        QVERIFY(QFile::link(real.fileName(), data.filePath("link.json")));
        QVERIFY(RuntimeBridge::stageBackupFile(data.filePath("link.json"), staging, &error).isEmpty());
        QCOMPARE(QDir(staging).entryList(QDir::Files | QDir::Hidden).size(), 0);
        // A linked folder on the way is ordinary (macOS /var and /tmp are links).
        QVERIFY(root.mkpath("real-folder"));
        QVERIFY(QFile::copy(real.fileName(), data.filePath("real-folder/inner.json")));
        QVERIFY(QFile::link(data.filePath("real-folder"), data.filePath("linked-folder")));
        const auto throughLink =
            RuntimeBridge::stageBackupFile(data.filePath("linked-folder/inner.json"), staging, &error);
        QVERIFY2(!throughLink.isEmpty(), qPrintable(error));
        QFile::remove(throughLink);

        const auto staged = RuntimeBridge::stageBackupFile(real.fileName(), staging, &error);
        QVERIFY2(!staged.isEmpty(), qPrintable(error));
        QVERIFY(QFileInfo(staged).fileName().startsWith(".reverie-import-"));
        QFile copy(staged);
        QVERIFY(copy.open(QIODevice::ReadOnly));
        QCOMPARE(copy.readAll(), content);
        QCOMPARE(copy.permissions() & (QFileDevice::ReadGroup | QFileDevice::ReadOther), QFileDevice::Permissions{});
    }
  private:
    static QString backupFile(QTemporaryDir &data, const QByteArray &bytes = "{\"schema\":\"reverie.full_local_backup.v3\"}") {
        const auto path = data.filePath("backup.json");
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size()) return {};
        return path;
    }
    static void inspectReply(RuntimeBridge &bridge, const QString &path, const QJsonObject &extra = {}) {
        QString error;
        const auto binding = RuntimeBridge::backupFileBinding(path, &error);
        QJsonObject receipt{{"ok", true}, {"schema_version", 3}, {"memory_count", 1},
            {"sha256", binding["sha256"].toString()}, {"file_bytes", binding["file_bytes"].toLongLong()}};
        for (auto it = extra.begin(); it != extra.end(); ++it) receipt[it.key()] = it.value();
        bridge.acceptFrame(controlResult(controlId(bridge, "backup:file:inspect"), "backup:file:inspect", receipt));
    }
    static QJsonObject recovery(const QString &state, bool writable) {
        return {{"recovery_state", state}, {"writes_blocked", !writable}, {"runtime_writable", writable}};
    }
  private slots:
    void realPythonInspectionFramePreservesEnvelopeAndCompletesPendingRequest() {
        // The paired Python unit batch streams the real compatibility file
        // through _handle_control and encode_frame. No response fields here
        // recreate that producer: consume its exact emitted bytes.
        const auto directory = qEnvironmentVariable("REVERIE_P1_CONTROL_RECEIPT_DIR");
        if (directory.isEmpty())
            QSKIP("Requires the paired Python control-receipt batch; no synthetic substitute");
        QFile receiptFile(directory + "/receipt.bin");
        QFile sourceFile(directory + "/source.json");
        QVERIFY(receiptFile.open(QIODevice::ReadOnly));
        QVERIFY(sourceFile.open(QIODevice::ReadOnly));
        const auto wire = receiptFile.readAll();
        const auto source = sourceFile.readAll();
        QVERIFY(wire.size() > 4);
        QCOMPARE(qFromBigEndian<quint32>(wire.constData()), quint32(wire.size() - 4));
        const auto receipt = QJsonDocument::fromJson(wire.mid(4)).object();
        QCOMPARE(receipt["schema"].toString(), QString("reverie.bridge.stdio.control.v4"));
        QCOMPARE(receipt["backup_schema"].toString(), QString("reverie.full_local_backup.v3"));
        QCOMPARE(receipt["type"].toString(), QString("backup:file:inspect"));
        QVERIFY(receipt["ok"].toBool());

        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto path = backupFile(data, source);
        QVERIFY(!path.isEmpty());
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        const auto generatedId = controlId(bridge, "backup:file:inspect");
        const auto capturedId = receipt["requestId"].toString();
        QVERIFY(!generatedId.isEmpty() && !capturedId.isEmpty());
        // Bind the test consumer to the producer's recorded request identity;
        // never rewrite the captured response or bypass the production parser.
        const auto pending = bridge.m_pending.take(generatedId);
        bridge.m_pending.insert(capturedId, pending);
        auto feedback = bridge.m_memoryFeedback["backup"].toMap();
        feedback["requestId"] = capturedId;
        bridge.m_memoryFeedback["backup"] = feedback;

        auto oldCollision = receipt;
        oldCollision["schema"] = receipt["backup_schema"];
        bridge.acceptFrame(oldCollision);
        QVERIFY(bridge.memoryRequestPending("backup"));
        QVERIFY(bridge.m_backupStaged.isEmpty());
        auto wrongSubject = receipt;
        wrongSubject["requestId"] = "unrelated_inspection_001";
        bridge.acceptFrame(wrongSubject);
        QVERIFY(bridge.memoryRequestPending("backup"));

        bridge.m_buffer = wire;
        bridge.readFrames();
        QVERIFY(bridge.m_buffer.isEmpty());
        QVERIFY(!bridge.m_pending.contains(capturedId));
        QCOMPARE(memoryReceipt(bridge, "backup")["status"].toString(), QString("confirmation"));
        QVERIFY(!bridge.m_backupStaged.isEmpty());
        QFile staged(bridge.m_backupStaged);
        QVERIFY(staged.open(QIODevice::ReadOnly));
        QCOMPARE(staged.readAll(), source);
        QVERIFY(bridge.runtimeWritable());
        QCOMPARE(pendingCount(bridge, "backup:file:import"), 0);
        bridge.cancelBackupRestore();
        QVERIFY(bridge.m_backupStaged.isEmpty());
    }
    void backupInspectionRejectsUnconfirmedBeforeAnyStage() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setDraft("尚未发送的输入");
        bridge.m_state["profile"] = QVariantMap{{"profile", QVariantMap{{"nickname", "原资料"}}}};
        const auto state = bridge.state();
        const auto path = backupFile(data);
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        QVERIFY(!controlId(bridge, "backup:file:inspect").isEmpty());
        QVERIFY(!QFileInfo::exists(data.filePath("backup-staging")));
        inspectReply(bridge, path, {{"ok", false}, {"code", "BACKUP_UNCONFIRMED_EXPORT"}});
        QCOMPARE(memoryReceipt(bridge, "backup")["code"].toString(), QString("BACKUP_UNCONFIRMED_EXPORT"));
        QVERIFY(bridge.m_backupStaged.isEmpty());
        QVERIFY(!QFileInfo::exists(data.filePath("backup-staging")));
        QCOMPARE(bridge.state(), state);
        QCOMPARE(bridge.draft(), QString("尚未发送的输入"));
        QVERIFY(bridge.request("backup:import", {{"backup", QVariantMap{}}}).isEmpty());
        QVERIFY(bridge.request("backup:file:import", {{"path", path}}).isEmpty());
        QCOMPARE(pendingCount(bridge, "backup:file:import"), 0);
    }
    void backupStageBindsInspectedBytesAndRechecksSourceAtConfirmation() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto path = backupFile(data);
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        inspectReply(bridge, path);
        QCOMPARE(memoryReceipt(bridge, "backup")["status"].toString(), QString("confirmation"));
        QVERIFY(!bridge.m_backupStaged.isEmpty());
        QVERIFY(QFileInfo::exists(bridge.m_backupStaged));
        const auto stage = bridge.m_backupStaged;
        QFile changed(path);
        QVERIFY(changed.open(QIODevice::WriteOnly));
        changed.write("{\"changed\":true}");
        changed.close();
        bridge.confirmBackupRestore();
        QCOMPARE(pendingCount(bridge, "backup:file:import"), 0);
        QVERIFY(!QFileInfo::exists(stage));
        QVERIFY(bridge.m_backupStaged.isEmpty());
        QVERIFY(bridge.runtimeWritable());
    }
    void backupImportNeverTimeUnlocksAndUnconfirmedReceiptPreservesDraftAndScope() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setDraft("锁定时的聊天草稿");
        const auto scope = bridge.scopeKey();
        const auto generation = bridge.generation();
        const auto path = backupFile(data);
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        inspectReply(bridge, path);
        bridge.confirmBackupRestore();
        const auto id = controlId(bridge, "backup:file:import");
        QVERIFY(!id.isEmpty());
        const auto stage = bridge.m_backupStaged;
        QVERIFY(bridge.backupRestoring());
        QVERIFY(!bridge.runtimeWritable());
        bridge.expirePending(id);
        QVERIFY(bridge.m_pending.contains(id));
        QVERIFY(bridge.backupRestoring());
        bridge.sendChat();
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.draft(), QString("锁定时的聊天草稿"));
        auto result = recovery("recovery_required", false);
        result["ok"] = false;
        result["outcome"] = "unconfirmed";
        bridge.acceptFrame(controlResult(id, "backup:file:import", result));
        QVERIFY(!bridge.backupRestoring());
        QVERIFY(!bridge.runtimeWritable());
        QCOMPARE(bridge.recoveryState(), QString("recovery_required"));
        QVERIFY(!QFileInfo::exists(stage));
        QVERIFY(bridge.request("archive:put", {}).isEmpty());
        QVERIFY(bridge.request("settings:update", {}).isEmpty());
        QVERIFY(bridge.request("persona:activate", {}).isEmpty());
        QVERIFY(!bridge.request("archive:get").isEmpty());
        QCOMPARE(bridge.scopeKey(), scope);
        QCOMPARE(bridge.generation(), generation);
        QVERIFY(bridge.suggestedBackupFile().fileName().startsWith("reverie-unconfirmed-"));
        QVERIFY(bridge.recoveryWarning().contains("当前状态可能不一致，仅供留存"));
        bridge.event(frame("runtime:activity", {}, recovery("clean", true)));
        QVERIFY(!bridge.runtimeWritable());
        QCOMPARE(bridge.recoveryState(), QString("recovery_required"));
    }
    void rescueNeedsSeparateKnownGoodConfirmationAndOnlyAuthoritativeCleanReceiptUnlocks() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.applyRecoverySnapshot(recovery("recovery_required", false));
        const auto path = backupFile(data);
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        QCOMPARE(pendingCount(bridge, "backup:file:inspect"), 0);
        bridge.chooseBackupForRescue(QUrl::fromLocalFile(path));
        inspectReply(bridge, path);
        QCOMPARE(bridge.state()["backupRestore"].toMap()["mode"].toString(), QString("rescue"));
        bridge.confirmBackupRestore();
        QCOMPARE(pendingCount(bridge, "backup:file:import"), 0);
        bridge.confirmBackupRestore(true);
        const auto id = controlId(bridge, "backup:file:import");
        QVERIFY(!id.isEmpty());
        QSignalSpy reconciled(&bridge, &RuntimeBridge::backupRestoreReconciled);
        auto receipt = recovery("clean", true);
        receipt["ok"] = true;
        receipt["outcome"] = "committed";
        bridge.acceptFrame(controlResult(id, "backup:file:import", receipt));
        QVERIFY(bridge.runtimeWritable());
        QCOMPARE(reconciled.count(), 1);
        QCOMPARE(memoryReceipt(bridge, "backup")["status"].toString(), QString("success"));
    }
    void cleanValidationRefusalKeepsWritesAndUnknownSuccessCannotUnlock() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto path = backupFile(data);
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        inspectReply(bridge, path);
        bridge.confirmBackupRestore();
        auto receipt = recovery("clean", true);
        receipt["ok"] = false;
        receipt["code"] = "BACKUP_FILE_CHANGED";
        bridge.acceptFrame(controlResult(controlId(bridge, "backup:file:import"), "backup:file:import", receipt));
        QVERIFY(bridge.runtimeWritable());
        QCOMPARE(memoryReceipt(bridge, "backup")["status"].toString(), QString("error"));
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        inspectReply(bridge, path);
        bridge.confirmBackupRestore();
        receipt["ok"] = true;
        receipt.remove("code");
        bridge.acceptFrame(controlResult(controlId(bridge, "backup:file:import"), "backup:file:import", receipt));
        QVERIFY(!bridge.runtimeWritable());
        QCOMPARE(memoryReceipt(bridge, "backup")["status"].toString(), QString("unknown"));
    }
    void lockedExportReceiptSaysRetainedAndCannotClearRecoveryLock() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.applyRecoverySnapshot(recovery("recovery_required", false));
        const auto path = data.filePath("reverie-unconfirmed-test.json");
        bridge.exportBackup(QUrl::fromLocalFile(path));
        const auto id = controlId(bridge, "backup:file:export");
        QVERIFY(!id.isEmpty());
        QFile file(path);
        QVERIFY(file.open(QIODevice::WriteOnly));
        file.write("{}"); file.close();
        auto receipt = recovery("clean", true); // A stale read cannot release a terminal lock.
        receipt["ok"] = true; receipt["operation"] = "export";
        receipt["export_consistency"] = "unconfirmed";
        bridge.acceptFrame(controlResult(id, "backup:file:export", receipt));
        QVERIFY(!bridge.runtimeWritable());
        QVERIFY(memoryReceipt(bridge, "backup")["text"].toString().contains("已留存（状态未确认，不能用于恢复）"));
    }
    void backupCrashCleanupOnlyRemovesOwnedPrivateStagingCopies() {
        QTemporaryDir data;
        const auto staging = data.filePath("backup-staging");
        QVERIFY(QDir().mkpath(staging));
        const auto copy = staging + "/.reverie-import-12345678-1234-1234-1234-123456789abc.json";
        const auto unrelated = staging + "/keep.json";
        for (const auto &path : {copy, unrelated}) {
            QFile file(path);
            QVERIFY(file.open(QIODevice::WriteOnly));
            file.write("{}");
        }
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        QVERIFY(!QFileInfo::exists(copy));
        QVERIFY(QFileInfo::exists(unrelated));
    }
    void incompleteReadinessCannotUnlock() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QVERIFY(!bridge.applyRecoverySnapshot({{"recovery_state", "clean"}, {"runtime_writable", true}}));
        QVERIFY(!bridge.runtimeWritable());
        QVERIFY(!bridge.applyRecoverySnapshot(recovery("recovering", true)));
        QVERIFY(!bridge.runtimeWritable());
    }
    void backupExportStillReportsPendingAndSuccessfulFileReceipts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        const auto path = data.filePath("export.json");
        bridge.exportBackup(QUrl::fromLocalFile(path));
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "backup:file:export"), 0);
        online(bridge);
        bridge.exportBackup(QUrl::fromLocalFile(data.filePath("invalid.zip")));
        QCOMPARE(pendingCount(bridge, "backup:file:export"), 0);
        bridge.exportBackup(QUrl::fromLocalFile(path));
        const auto id = controlId(bridge, "backup:file:export");
        QVERIFY(!id.isEmpty());
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("pending"));
        QCOMPARE(memoryReceipt(bridge, "backup").value("requestId").toString(), id);
        const auto receipt = memoryReceipt(bridge, "backup");
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(path));
        bridge.confirmBackupRestore();
        bridge.cancelBackupRestore();
        QCOMPARE(memoryReceipt(bridge, "backup"), receipt);
        bridge.exportBackup(QUrl::fromLocalFile(path));
        QCOMPARE(pendingCount(bridge, "backup:file:export"), 1);
        QCOMPARE(pendingCount(bridge, "backup:file:import"), 0);
        QFile exported(path);
        QVERIFY(exported.open(QIODevice::WriteOnly));
        const QByteArray content = R"({"schema":"reverie.backup"})";
        QCOMPARE(exported.write(content), qint64(content.size()));
        exported.close();
        bridge.acceptFrame(controlResult(id, "backup:file:export", {{"ok", true}, {"operation", "export"}, {"export_consistency", "confirmed"}}));
        QCOMPARE(pendingCount(bridge, "backup:file:export"), 0);
        QCOMPARE(memoryReceipt(bridge, "backup").value("status").toString(), QString("success"));
        QCOMPARE(memoryReceipt(bridge, "backup").value("text").toString(),
                 QString("已导出到 export.json。备份是明文，请妥善保管。"));
        QVERIFY(exported.open(QIODevice::ReadOnly));
        QCOMPARE(exported.readAll(), content);
    }
    void summaryDirectoryAndDetailAreExplicitReadOnlyRequests() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        bridge.setDraft("读取摘要时保留的聊天草稿");
        bridge.m_messages = {QVariantMap{{"id", "kept-message"}, {"content", "原消息"}}};
        const auto messages = bridge.messages();
        QCOMPARE(summaryDetailStatus(bridge), QString("idle"));
        bridge.refreshSummaryDirectory();
        const auto statusId = bridge.m_summaryStatusReadId;
        QVERIFY(!statusId.isEmpty());
        bridge.refreshSummaryDirectory();
        QCOMPARE(commandCount(*frames, "summary:status"), 1);
        QCOMPARE(commandCount(*frames, "summary:get"), 0);
        QCOMPARE(lastCommand(*frames, "summary:status").value("conversation_id").toString(), QString("dream-room"));
        const auto row = summaryDirectoryRow();
        bridge.event(frame("summary:result", statusId, summaryDirectoryPayload(bridge, {row})));
        const auto directory = bridge.state().value("summary").toMap();
        QVERIFY(directory.value("directoryReady").toBool());
        QCOMPARE(directory.value("conversation_id").toString(), QString("dream-room"));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        bridge.readSummaryDetail(row["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(summaryDetailStatus(bridge), QString("pending"));
        QCOMPARE(bridge.summaryDetailState().value("summaryId").toString(), row["summary_id"].toString());
        QCOMPARE(bridge.summaryDetailState().value("conversationId").toString(), QString("dream-room"));
        const auto sent = lastCommand(*frames, "summary:get");
        QCOMPARE(sent.keys(), (QStringList{"conversation_id", "requestId", "summary_id"}));
        QCOMPARE(sent.value("requestId").toString(), id);
        bridge.readSummaryDetail(row["summary_id"].toString());
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
        const QString body = "<b>这段 AI 摘要包含未核实的内容。</b>";
        auto receipt = summaryDetailPayload(bridge, row, body);
        receipt["enabled"] = false;
        receipt["status"] = "disabled";
        bridge.event(frame("summary:result", id, receipt));
        QCOMPARE(summaryDetailStatus(bridge), QString("success"));
        QCOMPARE(bridge.summaryDetailState().value("text").toString(), body);
        QCOMPARE(bridge.summaryDetailState().value("sourceDigest").toString(), row["sourceDigest"].toString());
        QCOMPARE(bridge.summaryDetailState().value("messageIds").toList(), row["messageIds"].toArray().toVariantList());
        QCOMPARE(bridge.state().value("summary").toMap(), directory);
        QVERIFY(!bridge.state().value("summary").toMap().contains("summary"));
        QCOMPARE(bridge.draft(), QString("读取摘要时保留的聊天草稿"));
        QCOMPARE(bridge.messages(), messages);
        QVERIFY(!bridge.busy());
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(frames->size(), 2);
        for (const auto &command : {"settings:update", "chat:send", "ai_usage:grant", "summary:legacy:import"})
            QCOMPARE(commandCount(*frames, command), 0);
    }
    void summaryDetailReadsRemainAvailableWithoutWriteOrGenerationPermission_data() {
        QTest::addColumn<bool>("paused");
        QTest::addColumn<bool>("writeLocked");
        QTest::addColumn<bool>("restoring");
        QTest::newRow("ordinary-read") << false << false << false;
        QTest::newRow("local-pause-generation-disabled") << true << false << false;
        QTest::newRow("recovery-write-lock") << false << true << false;
        QTest::newRow("restore-write-lock-and-local-pause") << true << true << true;
    }
    void summaryDetailReadsRemainAvailableWithoutWriteOrGenerationPermission() {
        QFETCH(bool, paused);
        QFETCH(bool, writeLocked);
        QFETCH(bool, restoring);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        bridge.m_offline = paused;
        bridge.m_networkFeedback = {{"known", true}, {"active", paused}};
        bridge.m_runtimeWritable = !writeLocked;
        bridge.m_recoveryState = writeLocked ? "recovery_required" : "clean";
        bridge.m_backupRestoring = restoring;
        bridge.refreshSummaryDirectory();
        auto status = summaryDirectoryPayload(bridge, {summaryDirectoryRow()});
        status["enabled"] = false;
        status["status"] = "disabled";
        status["authorized"] = false;
        bridge.event(frame("summary:result", bridge.m_summaryStatusReadId, status));
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(summaryDetailStatus(bridge), QString("pending"));
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge)));
        QCOMPARE(summaryDetailStatus(bridge), QString("success"));
        QCOMPARE(commandCount(*frames, "summary:status"), 1);
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
        QCOMPARE(frames->size(), 2);
        QVERIFY(!bridge.state().value("summary").toMap().value("enabled").toBool());
        QCOMPARE(bridge.m_offline, paused);
        QCOMPARE(bridge.m_backupRestoring, restoring);
    }
    void summarySelectionClearAndPageSwitchesRejectOldBodies() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        const auto a = summaryDirectoryRow('a'), b = summaryDirectoryRow('b', 3);
        knownSummaryDirectory(bridge, {a, b});
        bridge.readSummaryDetail(a["summary_id"].toString());
        const auto oldId = bridge.summaryDetailState().value("requestId").toString();
        bridge.readSummaryDetail(b["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QVERIFY(id != oldId);
        QVERIFY(!bridge.m_pending.contains(oldId));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        const auto pendingSelection = bridge.summaryDetailState();
        bridge.event(frame("summary:result", oldId, summaryDetailPayload(bridge, a, "旧选择的正文")));
        QCOMPARE(bridge.summaryDetailState(), pendingSelection);
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge, b, "当前选择的正文")));
        QCOMPARE(bridge.summaryDetailState().value("text").toString(), QString("当前选择的正文"));
        const auto shown = bridge.summaryDetailState();
        for (const auto &panel : {"chat", "settings", "about", ""})
            bridge.openPanel(panel);
        QCOMPARE(bridge.summaryDetailState(), shown);
        QCOMPARE(commandCount(*frames, "summary:get"), 2);
        bridge.clearSummaryDetail();
        QCOMPARE(summaryDetailStatus(bridge), QString("idle"));
        QVERIFY(bridge.summaryDetailState().value("summaryId").toString().isEmpty());
        QVERIFY(bridge.summaryDetailState().value("requestId").toString().isEmpty());
        const auto cleared = bridge.summaryDetailState();
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge, b, "迟到的正文")));
        QCOMPARE(bridge.summaryDetailState(), cleared);
        bridge.readSummaryDetail(a["summary_id"].toString());
        const auto clearedPending = bridge.summaryDetailState().value("requestId").toString();
        bridge.clearSummaryDetail();
        QVERIFY(!bridge.m_pending.contains(clearedPending));
        bridge.event(frame("summary:result", clearedPending, summaryDetailPayload(bridge, a)));
        QCOMPARE(summaryDetailStatus(bridge), QString("idle"));
        QCOMPARE(commandCount(*frames, "summary:get"), 3);
    }
    void summaryDetailRequiresStrictIdsFromTheCurrentCatalog_data() {
        QTest::addColumn<QString>("id");
        int index = 0;
        for (const auto &id : QStringList{"", "summary_a", "summary_" + QString(32, 'A'),
                 "summary_" + QString(31, 'a'), "summary_" + QString(33, 'a'),
                 "summary_" + QString(32, 'a') + "\n", "../summary_" + QString(32, 'a'),
                 "legacy_" + QString(64, 'a'), "summary_" + QString(32, 'f')})
            QTest::newRow(qPrintable(QString("invalid-or-unlisted-%1").arg(index++))) << id;
    }
    void summaryDetailRequiresStrictIdsFromTheCurrentCatalog() {
        QFETCH(QString, id);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(id);
        QCOMPARE(summaryDetailStatus(bridge), QString("error"));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        QVERIFY(bridge.summaryDetailState().value("summaryId").toString().isEmpty());
        QCOMPARE(commandCount(*frames, "summary:get"), 0);
        QVERIFY(bridge.request("summary:get", {{"conversation_id", "dream-room"},
            {"summary_id", summaryDirectoryRow()["summary_id"].toString()}}).isEmpty());
        QCOMPARE(commandCount(*frames, "summary:get"), 0);
        QCOMPARE(frames->size(), 1);
    }
    void summaryDetailRejectsMalformedBodiesAndSourceMetadata_data() {
        QTest::addColumn<QString>("fault");
        for (const auto &fault : {"generic-error", "false-ok", "missing-ok", "string-ok", "wrong-operation",
                 "missing-conversation", "missing-persona-id", "missing-persona-epoch", "missing-persona-fingerprint",
                 "summary-array", "missing-text", "number-text", "blank-text", "wrong-summary-id",
                 "digest-uppercase", "digest-newline", "digest-too-short", "missing-source-digest", "unknown-contract",
                 "first-zero", "first-fraction", "last-before-first", "sequence-overflow", "inconsistent-sequence-range",
                 "no-source-ids", "too-many-source-ids", "duplicate-source-id", "empty-source-id", "long-source-id",
                 "non-string-source-id", "surrogate-source-id", "extra-source-field"})
            QTest::newRow(fault) << QString(fault);
    }
    void summaryDetailRejectsMalformedBodiesAndSourceMetadata() {
        QFETCH(QString, fault);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSummaryDirectory(bridge);
        const auto directory = bridge.state().value("summary").toMap();
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        auto payload = summaryDetailPayload(bridge);
        auto summary = payload["summary"].toObject();
        QString type = "summary:result";
        if (fault == "generic-error") {
            type = "error";
            payload["message"] = "private backend exception detail";
        } else if (fault == "false-ok") payload["ok"] = false;
        else if (fault == "missing-ok") payload.remove("ok");
        else if (fault == "string-ok") payload["ok"] = "true";
        else if (fault == "wrong-operation") payload["operation"] = "status";
        else if (fault == "missing-conversation") payload.remove("conversation_id");
        else if (fault == "missing-persona-id") payload.remove("persona_id");
        else if (fault == "missing-persona-epoch") payload.remove("persona_epoch");
        else if (fault == "missing-persona-fingerprint") payload.remove("persona_fingerprint");
        else if (fault == "missing-text") summary.remove("text");
        else if (fault == "number-text") summary["text"] = 42;
        else if (fault == "blank-text") summary["text"] = " \n\t ";
        else if (fault == "wrong-summary-id") summary["summary_id"] = summaryDirectoryRow('b')["summary_id"];
        else if (fault == "digest-uppercase") summary["sourceDigest"] = QString(64, 'A');
        else if (fault == "digest-newline") summary["sourceDigest"] = QString(64, 'a') + "\n";
        else if (fault == "digest-too-short") summary["sourceDigest"] = QString(63, 'a');
        else if (fault == "missing-source-digest") summary.remove("sourceDigest");
        else if (fault == "unknown-contract") summary["contractVersion"] = "reverie.conversation-summary.v99";
        else if (fault == "first-zero") summary["firstSequence"] = 0;
        else if (fault == "first-fraction") summary["firstSequence"] = 1.5;
        else if (fault == "last-before-first") summary["lastSequence"] = 0;
        else if (fault == "sequence-overflow") summary["lastSequence"] = 9007199254740992.0;
        else if (fault == "inconsistent-sequence-range") summary["lastSequence"] = 1;
        else if (fault == "no-source-ids") summary["messageIds"] = QJsonArray{};
        else if (fault == "too-many-source-ids") {
            QJsonArray ids;
            for (int index = 0; index < 41; ++index)
                ids.append(QString("message-%1").arg(index));
            summary["messageIds"] = ids;
            summary["lastSequence"] = 41;
        } else if (fault == "duplicate-source-id") summary["messageIds"] = QJsonArray{"same", "same"};
        else if (fault == "empty-source-id") summary["messageIds"] = QJsonArray{"", "valid"};
        else if (fault == "long-source-id") summary["messageIds"] = QJsonArray{QString(513, 'a'), "valid"};
        else if (fault == "non-string-source-id") summary["messageIds"] = QJsonArray{1, "valid"};
        else if (fault == "surrogate-source-id") summary["messageIds"] = QJsonArray{QString(QChar(0xd800)), "valid"};
        else if (fault == "extra-source-field") summary["provider_api_key"] = "unexpected private field";
        else if (fault != "summary-array") QFAIL("Unknown malformed-summary fixture");
        payload["summary"] = fault == "summary-array" ? QJsonValue(QJsonArray{summary}) : QJsonValue(summary);
        bridge.event(frame(type, id, payload));
        QCOMPARE(summaryDetailStatus(bridge), QString("error"));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        QVERIFY(!bridge.summaryDetailState().value("feedback").toString().contains("private"));
        QVERIFY(!bridge.m_pending.contains(id));
        QCOMPARE(bridge.state().value("summary").toMap(), directory);
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
        const auto failed = bridge.summaryDetailState();
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge)));
        QCOMPARE(bridge.summaryDetailState(), failed);
    }
    void summaryDetailIgnoresForeignPersonaAndConversationReceipts_data() {
        QTest::addColumn<QString>("field");
        for (const auto &field : {"persona_id", "persona_epoch", "persona_fingerprint", "conversation_id"})
            QTest::newRow(field) << QString(field);
    }
    void summaryDetailIgnoresForeignPersonaAndConversationReceipts() {
        QFETCH(QString, field);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        const auto selected = bridge.summaryDetailState();
        auto foreign = summaryDetailPayload(bridge);
        foreign[field] = field == "persona_epoch" ? QJsonValue(4) : QJsonValue("other-scope");
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        bridge.event(frame("summary:result", id, foreign));
        QCOMPARE(bridge.summaryDetailState(), selected);
        QVERIFY(bridge.m_pending.contains(id));
        QCOMPARE(responses.count(), 0);
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge)));
        QCOMPARE(summaryDetailStatus(bridge), QString("success"));
        QCOMPARE(responses.count(), 1);
    }
    void summaryDetailLimitsUnicodeCodePointsInsteadOfUtf16Units_data() {
        QTest::addColumn<QString>("body");
        QTest::addColumn<bool>("accepted");
        const auto moon = QString::fromUtf8("🌙");
        QTest::newRow("1000-ascii") << QString(1000, 'a') << true;
        QTest::newRow("1001-ascii") << QString(1001, 'a') << false;
        QTest::newRow("1000-astral") << moon.repeated(1000) << true;
        QTest::newRow("1001-astral") << moon.repeated(1001) << false;
        QTest::newRow("1000-mixed") << moon.repeated(500) + QString(500, QChar(0x6708)) << true;
        QTest::newRow("lone-high-surrogate") << QString(QChar(0xd800)) << false;
        QTest::newRow("lone-low-surrogate") << QString(QChar(0xdc00)) << false;
    }
    void summaryDetailLimitsUnicodeCodePointsInsteadOfUtf16Units() {
        QFETCH(QString, body);
        QFETCH(bool, accepted);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        bridge.event(frame("summary:result", id, summaryDetailPayload(bridge, summaryDirectoryRow(), body)));
        QCOMPARE(summaryDetailStatus(bridge), accepted ? QString("success") : QString("error"));
        QCOMPARE(bridge.summaryDetailState().value("text").toString(), accepted ? body : QString());
    }
    void summaryDirectoryRefreshInvalidatesOnlyChangedSelection_data() {
        QTest::addColumn<QString>("change");
        QTest::addColumn<bool>("pendingRead");
        for (const auto &change : {"removed", "source-changed", "malformed", "unchanged", "top-status-changed", "other-row-changed"})
            for (const bool pendingRead : {false, true})
                QTest::newRow(qPrintable(QString("%1-%2").arg(change).arg(pendingRead ? "pending" : "shown")))
                    << QString(change) << pendingRead;
    }
    void summaryDirectoryRefreshInvalidatesOnlyChangedSelection() {
        QFETCH(QString, change);
        QFETCH(bool, pendingRead);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        auto a = summaryDirectoryRow('a'), b = summaryDirectoryRow('b', 3);
        knownSummaryDirectory(bridge, {a, b});
        bridge.readSummaryDetail(a["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        const auto original = summaryDetailPayload(bridge, a, "只属于选择 A 的正文");
        if (!pendingRead)
            bridge.event(frame("summary:result", id, original));
        const auto selected = bridge.summaryDetailState();
        bridge.refreshSummaryDirectory();
        QJsonArray rows{a, b};
        if (change == "removed") rows = {b};
        else if (change == "source-changed") { a["sourceDigest"] = QString(64, 'c'); rows = {a, b}; }
        else if (change == "malformed") rows = {a, a};
        else if (change == "other-row-changed") { b["sourceDigest"] = QString(64, 'd'); rows = {a, b}; }
        auto status = summaryDirectoryPayload(bridge, rows);
        if (change == "top-status-changed") { status["enabled"] = false; status["status"] = "disabled"; }
        bridge.event(frame("summary:result", bridge.m_summaryStatusReadId, status));
        const bool invalidated = change == "removed" || change == "source-changed" || change == "malformed";
        if (invalidated) {
            QCOMPARE(summaryDetailStatus(bridge), QString("error"));
            QVERIFY(bridge.summaryDetailState().value("summaryId").toString().isEmpty());
            QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
            QVERIFY(!bridge.m_pending.contains(id));
            const auto cleared = bridge.summaryDetailState();
            bridge.event(frame("summary:result", id, original));
            QCOMPARE(bridge.summaryDetailState(), cleared);
        } else {
            QCOMPARE(bridge.summaryDetailState(), selected);
            if (pendingRead) {
                bridge.event(frame("summary:result", id, original));
                QCOMPARE(bridge.summaryDetailState().value("text").toString(), QString("只属于选择 A 的正文"));
            }
        }
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
        QCOMPARE(commandCount(*frames, "summary:status"), 2);
    }
    void summaryDetailTimeoutDisconnectAndTransportFailureRejectLateBodies_data() {
        QTest::addColumn<QString>("failure");
        for (const auto &failure : {"timeout", "disconnect", "transport"})
            QTest::newRow(failure) << QString(failure);
    }
    void summaryDetailTimeoutDisconnectAndTransportFailureRejectLateBodies() {
        QFETCH(QString, failure);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        bridge.event(frame("summary:result", bridge.summaryDetailState().value("requestId").toString(),
                           summaryDetailPayload(bridge, summaryDirectoryRow(), "已有正文")));
        QCOMPARE(summaryDetailStatus(bridge), QString("success"));
        if (failure == "transport")
            bridge.m_frameWriter = [](const QByteArray &) { return qint64(0); };
        QSignalSpy failures(&bridge, &RuntimeBridge::requestFailed);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        const auto late = summaryDetailPayload(bridge, summaryDirectoryRow(), "迟到的正文不能恢复");
        if (failure == "timeout") bridge.expirePending(id);
        else if (failure == "disconnect") bridge.m_process.finished(1, QProcess::CrashExit);
        QCOMPARE(summaryDetailStatus(bridge), QString("error"));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        QVERIFY(!bridge.m_pending.contains(id));
        const auto failed = bridge.summaryDetailState();
        const int commands = bridge.m_commands;
        bridge.event(frame("summary:result", id, late));
        QCOMPARE(bridge.summaryDetailState(), failed);
        QCOMPARE(bridge.m_commands, commands);
        if (failure != "disconnect") {
            QCOMPARE(failures.count(), 1);
            QCOMPARE(failures.at(0).at(1).toString(), failure == "timeout" ? QString("timeout") : QString("transport_failed"));
        } else {
            QVERIFY(!bridge.connected());
            QVERIFY(!bridge.state().value("summary").toMap().value("directoryReady").toBool());
        }
    }
    void summaryDetailNewHandshakeClearsSamePersonaBodiesAndAssociations_data() {
        QTest::addColumn<bool>("disconnectSignal");
        QTest::addColumn<bool>("pendingRead");
        QTest::newRow("finished-pending") << true << true;
        QTest::newRow("finished-shown") << true << false;
        QTest::newRow("new-ready-pending") << false << true;
        QTest::newRow("new-ready-shown") << false << false;
    }
    void summaryDetailNewHandshakeClearsSamePersonaBodiesAndAssociations() {
        QFETCH(bool, disconnectSignal);
        QFETCH(bool, pendingRead);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto oldId = bridge.summaryDetailState().value("requestId").toString();
        const auto oldPayload = summaryDetailPayload(bridge, summaryDirectoryRow(), "上次连接的正文");
        if (!pendingRead) bridge.event(frame("summary:result", oldId, oldPayload));
        const auto persona = bridge.m_persona;
        const auto generation = bridge.generation();
        if (disconnectSignal) bridge.m_process.finished(1, QProcess::CrashExit);
        else bridge.m_connected = false;
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", persona["persona_id"]}, {"personaEpoch", persona["epoch"]},
            {"personaFingerprint", persona["fingerprint"]}, {"recoveryState", "clean"},
            {"writesBlocked", false}, {"runtimeWritable", true}});
        QVERIFY(bridge.connected());
        QCOMPARE(bridge.generation(), generation + 1);
        QCOMPARE(summaryDetailStatus(bridge), QString("idle"));
        QVERIFY(bridge.summaryDetailState().value("summaryId").toString().isEmpty());
        QVERIFY(!bridge.m_pending.contains(oldId));
        const auto cleared = bridge.summaryDetailState();
        bridge.event(frame("summary:result", oldId, oldPayload));
        QCOMPARE(bridge.summaryDetailState(), cleared);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        QCOMPARE(summaryDetailStatus(bridge), QString("error"));
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
        bridge.event(frame("summary:result", bridge.m_summaryStatusReadId,
                           summaryDirectoryPayload(bridge, {summaryDirectoryRow()})));
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto newId = bridge.summaryDetailState().value("requestId").toString();
        QVERIFY(!newId.isEmpty());
        QVERIFY(newId != oldId);
        bridge.event(frame("summary:result", oldId, oldPayload));
        QCOMPARE(summaryDetailStatus(bridge), QString("pending"));
        bridge.event(frame("summary:result", newId, summaryDetailPayload(bridge)));
        QCOMPARE(summaryDetailStatus(bridge), QString("success"));
    }
    void summaryDetailPersonaChangeDropsShownAndPendingBodies_data() {
        QTest::addColumn<bool>("scopeEvent");
        QTest::addColumn<bool>("pendingRead");
        QTest::newRow("persona-data-pending") << false << true;
        QTest::newRow("persona-data-shown") << false << false;
        QTest::newRow("scope-event-pending") << true << true;
        QTest::newRow("scope-event-shown") << true << false;
    }
    void summaryDetailPersonaChangeDropsShownAndPendingBodies() {
        QFETCH(bool, scopeEvent);
        QFETCH(bool, pendingRead);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSummaryDirectory(bridge);
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        const auto old = summaryDetailPayload(bridge);
        if (!pendingRead) bridge.event(frame("summary:result", id, old));
        if (scopeEvent)
            bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 4},
                {"fingerprint", "next-fingerprint"}}));
        else bridge.event(frame("persona:data", "", nextIdentity(4)));
        QCOMPARE(summaryDetailStatus(bridge), QString("idle"));
        QVERIFY(bridge.summaryDetailState().value("text").toString().isEmpty());
        QVERIFY(bridge.summaryDetailState().value("summaryId").toString().isEmpty());
        QVERIFY(!bridge.m_pending.contains(id));
        const auto cleared = bridge.summaryDetailState();
        bridge.event(frame("summary:result", id, old));
        QCOMPARE(bridge.summaryDetailState(), cleared);
        QCOMPARE(commandCount(*frames, "summary:get"), 1);
    }
    void chatHistoryResultKeepsBridgeReplyOrder() {
        // One reply's bubbles share a timestamp and carry ids that sort
        // backwards; the GUI must keep the bridge's ledger order verbatim.
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QJsonArray items;
        QStringList expected;
        for (int index = 0; index < 16; ++index) {
            const auto id = QString("%1").arg(99 - index, 32, 10, QChar('0'));
            expected << id;
            items.append(QJsonObject{{"id", id}, {"role", "assistant"}, {"request_id", "request-order"},
                                     {"bubble_index", index}, {"created_at_utc", "2026-10-20T00:00:00+00:00"}});
        }
        bridge.event(frame("chat:history:result", bridge.request("chat:history"), {{"items", items}}));
        QStringList actual;
        for (const auto &message : bridge.messages())
            actual << message.toMap().value("id").toString();
        QCOMPARE(actual, expected);
    }
    void summaryDetailReplyCannotBecomeAnotherControllersEvent_data() {
        QTest::addColumn<QString>("eventType");
        for (const auto &eventType : {"settings:get:result", "runtime:activity", "chat:history:result", "persona:data", "game_state:result"})
            QTest::newRow(eventType) << QString(eventType);
    }
    void summaryDetailReplyCannotBecomeAnotherControllersEvent() {
        QFETCH(QString, eventType);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSummaryDirectory(bridge);
        bridge.setDraft("保留草稿");
        bridge.m_messages = {QVariantMap{{"content", "保留消息"}}};
        bridge.readSummaryDetail(summaryDirectoryRow()["summary_id"].toString());
        const auto id = bridge.summaryDetailState().value("requestId").toString();
        const auto state = bridge.state();
        const auto messages = bridge.messages();
        const auto scope = bridge.scopeKey();
        auto payload = summaryDetailPayload(bridge);
        payload["items"] = QJsonArray{QJsonObject{{"content", "不能进入聊天"}}};
        payload["runtime_writable"] = false;
        payload["writes_blocked"] = true;
        payload["recovery_state"] = "recovery_required";
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(summaryDetailStatus(bridge), QString("error"));
        QCOMPARE(bridge.state(), state);
        QCOMPARE(bridge.messages(), messages);
        QCOMPARE(bridge.scopeKey(), scope);
        QCOMPARE(bridge.draft(), QString("保留草稿"));
        QVERIFY(bridge.runtimeWritable());
        QVERIFY(!bridge.busy());
    }
    void summaryStatusIsReplacedOnlyByStatusReads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto status = bridge.request("summary:status");
        bridge.event(frame("summary:result", status,
                           {{"ok", true}, {"operation", "status"}, {"enabled", true},
                            {"status", "ready"}, {"activeCount", 2}}));
        QCOMPARE(bridge.state().value("summary").toMap().value("status").toString(), QString("ready"));

        QFile legacy(data.filePath("legacy-summary.json"));
        QVERIFY(legacy.open(QIODevice::WriteOnly));
        legacy.write(R"({"summaries":[]})");
        legacy.close();
        bridge.chooseSummaryFile(QUrl::fromLocalFile(legacy.fileName()));
        const auto preview = controlId(bridge, "summary:legacy:preview");
        QCOMPARE(memoryReceipt(bridge, "legacy").value("status").toString(), QString("pending"));
        bridge.event(frame("summary:result", preview,
                           {{"ok", true}, {"operation", "preview"}, {"sha256", QString(64, 'a')},
                            {"total", 3}, {"linked", 0}, {"unattributed", 3}, {"active", 0}}));
        // The preview shares summary:result but must not drive the summary switch.
        QCOMPARE(bridge.state().value("summary").toMap().value("status").toString(), QString("ready"));
        QVERIFY(bridge.state().value("summary").toMap().value("enabled").toBool());
        QVERIFY(bridge.state().contains("importPreview"));
        QCOMPARE(memoryReceipt(bridge, "legacy").value("status").toString(), QString("preview"));

        // A rejected preview leaves nothing to confirm and sends no import.
        bridge.chooseSummaryFile(QUrl::fromLocalFile(legacy.fileName()));
        QVERIFY(!bridge.state().contains("importPreview"));
        const auto malformed = controlId(bridge, "summary:legacy:preview");
        bridge.event(frame("error", malformed, {{"message", "Legacy summary document is invalid"}}));
        QCOMPARE(memoryReceipt(bridge, "legacy").value("status").toString(), QString("error"));
        bridge.confirmSummaryImport();
        QCOMPARE(pendingCount(bridge, "summary:legacy:import"), 0);

        const auto failed = bridge.request("summary:status");
        bridge.event(frame("error", failed, {{"message", "Conversation summary service is unavailable"}}));
        QCOMPARE(bridge.state().value("summary").toMap().value("status").toString(), QString("unavailable"));
        QVERIFY(!bridge.state().value("summary").toMap().value("ok").toBool());
    }
    void summaryToggleReceiptsReadTheRuntimeBack_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        QTest::newRow("saved") << "settings:update:result"
                               << QJsonObject{{"ok", true}, {"features", QJsonObject{}}}
                               << "success";
        QTest::newRow("rejected") << "settings:update:result"
                                  << QJsonObject{{"ok", false}, {"error", "Settings are not initialized"}}
                                  << "error";
        QTest::newRow("generic-error") << "error" << QJsonObject{{"message", "内部错误"}} << "error";
        QTest::newRow("cleanup-unconfirmed")
            << "settings:update:result"
            << QJsonObject{{"ok", false}, {"code", "summary_cleanup_unconfirmed"},
                           {"error", "Summary is disabled; background cleanup is not confirmed"}}
            << "unknown";
    }
    void summaryToggleReceiptsReadTheRuntimeBack() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QFETCH(QString, status);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        bridge.setSummaryEnabled(true);
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);
        online(bridge);
        bridge.setSummaryEnabled(false);
        bridge.setSummaryEnabled(false);
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        const auto id = controlId(bridge, "settings:update");
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), QString("pending"));
        QCOMPARE(pendingCount(bridge, "summary:status"), 0);
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), status);
        QCOMPARE(pendingCount(bridge, "summary:status"), 1);
    }
    void permissionReceiptsArePerFeatureAndCancellationSendsNothing() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.grantFeature("summary", "digest", false);
        QCOMPARE(bridge.m_commands, 0);
        QCOMPARE(bridge.permissionFeedback().value("summary").toMap().value("status").toString(), QString("cancelled"));
        const auto refreshId = bridge.request("ai_usage:get");
        const auto revokeId = bridge.request("ai_usage:revoke", {{"feature", "summary"}});
        bridge.event(frame("error", revokeId, {{"message", "raw permission rejection"}}));
        QCOMPARE(bridge.permissionFeedback().value("summary").toMap().value("status").toString(), QString("error"));
        QVERIFY(!bridge.permissionFeedback().value("summary").toMap().value("text").toString().contains("raw permission"));
        QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("pending"));
        const auto snapshot = permissions("origin-current");
        bridge.event(frame("ai_usage:result", refreshId, snapshot));
        QVERIFY(!bridge.permissionsKnown());
        const auto currentRefreshId = bridge.request("ai_usage:get");
        bridge.event(frame("ai_usage:result", currentRefreshId, snapshot));
        QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("success"));
        QCOMPARE(bridge.state().value("permissions").toMap(), snapshot.toVariantMap());
        bridge.grantFeature("summary", "digest-current", true, bridge.permissionContextEpoch());
        const auto grantId = controlId(bridge, "ai_usage:grant");
        QVERIFY(!grantId.isEmpty());
        bridge.expirePending(grantId);
        QCOMPARE(bridge.permissionFeedback().value("summary").toMap().value("status").toString(), QString("unknown"));
    }
    void configureInvalidatesCachedPermissionsAndRejectsOldCallbacks() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto oldSnapshot = permissions("origin-a", true, "digest-a");
        knownPermissions(bridge, oldSnapshot);
        bridge.m_state["provider"] = QVariantMap{{"model", "provider-a"}};
        const auto oldPermissionId = bridge.request("ai_usage:get");
        bridge.refresh();
        const auto oldProviderId = controlId(bridge, "provider:get");
        QVERIFY(!oldProviderId.isEmpty());
        const int oldEpoch = bridge.permissionContextEpoch();
        bridge.m_providerTest = {{"model", "provider-b"}};
        bridge.saveProvider();
        const auto saveId = bridge.m_providerSaveId;
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.permissionContextEpoch(), oldEpoch + 1);
        QCOMPARE(bridge.state().value("permissions").toMap(), oldSnapshot.toVariantMap());
        const int commandsBeforeGrant = bridge.m_commands;
        bridge.grantFeature("summary", "digest-a", true, oldEpoch);
        QCOMPARE(bridge.m_commands, commandsBeforeGrant);
        bridge.providerDraftChanged();
        bridge.event(frame("ai_usage:result", oldPermissionId, oldSnapshot));
        QVERIFY(!bridge.permissionsKnown());
        const int readsBeforeSaveAck = pendingCount(bridge, "ai_usage:get");
        bridge.acceptFrame(controlResult(saveId, "provider:configure", {{"ok", true},
                           {"llm", provider("provider-b")}}));
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), readsBeforeSaveAck + 1);
        QVERIFY(!bridge.providerFeedback().value("currentDraft").toBool());
        QCOMPARE(bridge.state().value("provider").toMap().value("model").toString(), QString("provider-b"));
        bridge.acceptFrame(controlResult(oldProviderId, "provider:get", {{"ok", true},
                           {"llm", provider("stale-provider-a")}}));
        QCOMPARE(bridge.state().value("provider").toMap().value("model").toString(), QString("provider-b"));
        const auto currentId = currentPermissionId(bridge);
        QVERIFY(!currentId.isEmpty());
        const auto newSnapshot = permissions("origin-b", false, "digest-b");
        bridge.event(frame("ai_usage:result", currentId, newSnapshot));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.state().value("permissions").toMap(), newSnapshot.toVariantMap());
        const auto currentFeedback = bridge.permissionFeedback();
        bridge.event(frame("ai_usage:result", oldPermissionId, oldSnapshot));
        QCOMPARE(bridge.state().value("permissions").toMap(), newSnapshot.toVariantMap());
        QCOMPARE(bridge.permissionFeedback(), currentFeedback);
    }
    void olderPermissionSnapshotsCannotUndoRevokeOrNewerRefresh() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownPermissions(bridge, permissions("origin-a"));
        const auto oldGet = bridge.request("ai_usage:get");
        bridge.grantFeature("summary", "digest-current", true, bridge.permissionContextEpoch());
        const auto grantId = controlId(bridge, "ai_usage:grant");
        QVERIFY(!grantId.isEmpty());
        QVERIFY(!bridge.permissionsKnown());
        // Revocation remains possible even while a grant result is unknown.
        const auto revokeId = bridge.request("ai_usage:revoke", {{"feature", "summary"}});
        QVERIFY(!revokeId.isEmpty());
        const auto revoked = permissions("origin-a", false);
        bridge.event(frame("ai_usage:result", revokeId, revoked));
        QVERIFY(bridge.permissionsKnown());
        const auto feedback = bridge.permissionFeedback();
        bridge.event(frame("ai_usage:result", grantId, permissions("origin-a", true)));
        bridge.event(frame("ai_usage:result", oldGet, permissions("origin-a", true)));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.state().value("permissions").toMap(), revoked.toVariantMap());
        QCOMPARE(bridge.permissionFeedback().value("summary"), feedback.value("summary"));
        const auto earlierRefresh = bridge.request("ai_usage:get");
        const auto laterRefresh = bridge.request("ai_usage:get");
        const auto fresh = permissions("origin-fresh", false, "digest-fresh");
        bridge.event(frame("ai_usage:result", laterRefresh, fresh));
        bridge.expirePending(earlierRefresh);
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.state().value("permissions").toMap(), fresh.toVariantMap());
    }
    void consentConfirmationRequiresCapturedEpochAndCurrentDigest() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownPermissions(bridge, permissions("origin-a", false, "digest-a"));
        const int capturedEpoch = bridge.permissionContextEpoch();
        bridge.invalidatePermissions();
        knownPermissions(bridge, permissions("origin-b", false, "digest-b"));
        const int before = bridge.m_commands;
        bridge.grantFeature("summary", "digest-b", true, capturedEpoch);
        bridge.grantFeature("summary", "digest-a", true, bridge.permissionContextEpoch());
        bridge.grantFeature("summary", "digest-b", false, capturedEpoch);
        QCOMPARE(bridge.m_commands, before);
        QCOMPARE(pendingCount(bridge, "ai_usage:grant"), 0);
        QVERIFY(bridge.permissionsKnown());
        bridge.grantFeature("summary", "digest-b", true, bridge.permissionContextEpoch());
        QCOMPARE(bridge.m_commands, before + 1);
        QCOMPARE(pendingCount(bridge, "ai_usage:grant"), 1);
    }
    void unknownSaveReadsCurrentProviderThenPermissionsExactlyOnce() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto oldSnapshot = permissions("origin-a", true, "digest-a");
        knownPermissions(bridge, oldSnapshot);
        bridge.m_providerTest = {{"model", "provider-b"}};
        bridge.saveProvider();
        const auto saveId = bridge.m_providerSaveId;
        bridge.providerDraftChanged();
        QSignalSpy configureResults(&bridge, &RuntimeBridge::commandResult);
        bridge.expirePending(saveId);
        QVERIFY(bridge.m_providerSaveId.isEmpty());
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(!bridge.providerFeedback().value("currentDraft").toBool());
        QCOMPARE(pendingCount(bridge, "provider:configure"), 0);
        QCOMPARE(pendingCount(bridge, "provider:get"), 1);
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 0);
        bridge.expirePending(saveId);
        bridge.refreshPermissions();
        QCOMPARE(pendingCount(bridge, "provider:get"), 1);
        QCOMPARE(configureResults.count(), 1);
        bridge.acceptFrame(controlResult(saveId, "provider:configure", {{"ok", true},
                           {"llm", provider("late-wrong-provider")}}));
        const auto providerReadId = bridge.m_permissionProviderReadId;
        bridge.acceptFrame(controlResult(providerReadId, "provider:get", {{"ok", true},
                           {"llm", provider("provider-b")}}));
        QCOMPARE(bridge.state().value("provider").toMap().value("model").toString(), QString("provider-b"));
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 1);
        const auto snapshot = permissions("origin-b", false, "digest-b");
        bridge.event(frame("ai_usage:result", currentPermissionId(bridge), snapshot));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QVERIFY(bridge.providerFeedback().value("text").toString().contains("原保存结果未知"));
        QVERIFY(!bridge.providerFeedback().value("text").toString().contains("已保存"));
        QCOMPARE(bridge.state().value("permissions").toMap(), snapshot.toVariantMap());
        QCOMPARE(pendingCount(bridge, "provider:configure"), 0);
        QCOMPARE(pendingCount(bridge, "provider:get"), 0);
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 0);
    }
    void failedSaveReconciliationStaysUnknownUntilManualRefresh() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownPermissions(bridge, permissions("origin-a", true));
        bridge.m_providerTest = {{"model", "provider-b"}};
        bridge.saveProvider();
        bridge.expirePending(bridge.m_providerSaveId);
        const auto firstRead = bridge.m_permissionProviderReadId;
        bridge.acceptFrame(controlResult(firstRead, "provider:get", {{"ok", false},
                           {"error", "raw read error"}}));
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("unknown"));
        QCOMPARE(pendingCount(bridge, "provider:get"), 0);
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 0);
        bridge.refreshPermissions();
        const auto manualRead = bridge.m_permissionProviderReadId;
        QVERIFY(!manualRead.isEmpty());
        QVERIFY(manualRead != firstRead);
        bridge.acceptFrame(controlResult(manualRead, "provider:get", {{"ok", true},
                           {"llm", provider("provider-b")}}));
        const auto failedPermissionRead = currentPermissionId(bridge);
        bridge.expirePending(failedPermissionRead);
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 0);
        bridge.refreshPermissions();
        const auto finalRead = currentPermissionId(bridge);
        QVERIFY(!finalRead.isEmpty());
        QCOMPARE(pendingCount(bridge, "provider:get"), 0);
        bridge.event(frame("ai_usage:result", finalRead, permissions("origin-b")));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QCOMPARE(pendingCount(bridge, "provider:configure"), 0);
    }
    void malformedPermissionSnapshotStaysUnknownAndRetainsDescriptionCache_data() {
        QTest::addColumn<QJsonObject>("invalid");
        QTest::newRow("empty-features") << QJsonObject{{"schema", "reverie.ai-usage-consent.v2"},
                                                     {"features", QJsonObject{}}};
        QTest::newRow("non-object-feature") << QJsonObject{{"schema", "reverie.ai-usage-consent.v2"},
                                       {"features", QJsonObject{{"summary", true}}}};
        for (const auto &field : {"enabled", "effective", "api_cost_acknowledged", "description",
                                 "current_provider", "current_origin", "provider", "origin", "consent_digest"}) {
            auto invalid = permissions("origin-a");
            auto features = invalid["features"].toObject();
            auto feature = features["summary"].toObject();
            feature.remove(field);
            features["summary"] = feature;
            invalid["features"] = features;
            QTest::newRow(qPrintable(QString("missing-%1").arg(field))) << invalid;
            feature[field] = QJsonArray{};
            features["summary"] = feature;
            invalid["features"] = features;
            QTest::newRow(qPrintable(QString("invalid-type-%1").arg(field))) << invalid;
        }
        for (const auto &field : {"current_provider", "current_origin", "description", "consent_digest"}) {
            auto invalid = permissions("origin-a");
            auto features = invalid["features"].toObject();
            auto feature = features["summary"].toObject();
            feature[field] = "";
            features["summary"] = feature;
            invalid["features"] = features;
            QTest::newRow(qPrintable(QString("empty-%1").arg(field))) << invalid;
        }
    }
    void malformedPermissionSnapshotStaysUnknownAndRetainsDescriptionCache() {
        QFETCH(QJsonObject, invalid);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto cached = permissions("origin-a", true);
        knownPermissions(bridge, cached);
        const auto refreshId = bridge.request("ai_usage:get");
        bridge.event(frame("ai_usage:result", refreshId, invalid));
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.state().value("permissions").toMap(), cached.toVariantMap());
        QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("unknown"));
        const int commands = bridge.m_commands;
        bridge.grantFeature("summary", "digest-current", true, bridge.permissionContextEpoch());
        QCOMPARE(bridge.m_commands, commands);
    }
    void malformedProviderReadCannotReconcileUnknownSave_data() {
        QTest::addColumn<QJsonObject>("invalid");
        QTest::newRow("empty-provider") << QJsonObject{};
        for (const auto &field : {"provider", "model", "base_url"}) {
            auto missing = provider("provider-b");
            missing.remove(field);
            QTest::newRow(qPrintable(QString("missing-%1").arg(field))) << missing;
            auto empty = provider("provider-b");
            empty[field] = "";
            QTest::newRow(qPrintable(QString("empty-%1").arg(field))) << empty;
            auto wrong = provider("provider-b");
            wrong[field] = true;
            QTest::newRow(qPrintable(QString("invalid-type-%1").arg(field))) << wrong;
        }
        auto invalidEndpoint = provider("provider-b");
        invalidEndpoint["base_url"] = "not-an-http-endpoint";
        QTest::newRow("invalid-endpoint") << invalidEndpoint;
    }
    void malformedProviderReadCannotReconcileUnknownSave() {
        QFETCH(QJsonObject, invalid);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownPermissions(bridge, permissions("origin-a", true));
        bridge.m_state["provider"] = provider("provider-a").toVariantMap();
        bridge.m_providerTest = provider("provider-b");
        bridge.saveProvider();
        bridge.expirePending(bridge.m_providerSaveId);
        const auto readId = bridge.m_permissionProviderReadId;
        bridge.acceptFrame(controlResult(readId, "provider:get", {{"ok", true}, {"llm", invalid}}));
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.state().value("provider").toMap(), provider("provider-a").toVariantMap());
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 0);
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("unknown"));
        bridge.refreshPermissions();
        QVERIFY(!bridge.m_permissionProviderReadId.isEmpty());
        QCOMPARE(pendingCount(bridge, "provider:get"), 1);
    }
    void unconfirmedSaveNeedsAnExplicitReadBeforeUnconfigured_data() {
        QTest::addColumn<bool>("disconnectDuringSave");
        QTest::newRow("save-timeout-then-manual-refresh") << false;
        QTest::newRow("save-disconnect-then-send-read") << true;
    }
    void unconfirmedSaveNeedsAnExplicitReadBeforeUnconfigured() {
        QFETCH(bool, disconnectDuringSave);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const auto rendererCount = [&frames](const QString &command) {
            int count = 0;
            for (const auto &sent : *frames)
                count += sent.value("kind") == "renderer_command" &&
                         sent.value("envelope").toObject().value("command") == command;
            return count;
        };
        knownPermissions(bridge, permissions("http://127.0.0.1:11434"));
        const auto previous = provider("previous-model").toVariantMap();
        bridge.m_state["provider"] = previous;
        bridge.m_providerConfirmedHandshake = bridge.m_handshakes;
        bridge.setDraft("保存未确认时保留的草稿");
        const auto draft = bridge.draft();
        const auto messages = bridge.messages();
        bridge.m_providerTest = provider("tested-model");
        bridge.saveProvider();
        const auto saveId = bridge.m_providerSaveId;
        QVERIFY(!saveId.isEmpty());
        QCOMPARE(controlCount(*frames, "provider:configure"), 1);
        const auto emptyModel = provider("");
        int permissionsBefore = rendererCount("ai_usage:get");
        QString firstRead;
        if (!disconnectDuringSave) {
            bridge.expirePending(saveId);
            firstRead = bridge.m_permissionProviderReadId;
            QVERIFY(!firstRead.isEmpty());
        } else {
            // Exercise the bound disconnect handler without starting a process.
            const auto persona = bridge.m_persona;
            bridge.m_process.finished(1, QProcess::CrashExit);
            QVERIFY(!bridge.connected());
            QVERIFY(bridge.m_providerContextUnknown);
            QCOMPARE(controlCount(*frames, "provider:get"), 0);
            // Synthetic ready/control frames exercise the real handshake and
            // refresh callbacks; this is not OS-process or authentication acceptance.
            bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
                {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
                {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                    bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
                {"personaId", persona["persona_id"]}, {"personaEpoch", persona["epoch"]},
                {"personaFingerprint", persona["fingerprint"]},
                {"recoveryState", "clean"}, {"writesBlocked", false}, {"runtimeWritable", true}});
            QVERIFY(bridge.connected());
            QVERIFY(bridge.runtimeWritable());
            bridge.acceptFrame(controlResult(bridge.m_networkRequestId, "local_mode:set",
                {{"ok", true}, {"active", false}, {"epoch", bridge.m_localModeEpoch}}));
            QVERIFY(bridge.networkFeedback().value("known").toBool());
            firstRead = lastControl(*frames, "provider:get")["requestId"].toString();
            QVERIFY(!firstRead.isEmpty());
            // refresh() has its own ordinary permission read. The provider
            // reply must not add another or resolve the unknown save.
            permissionsBefore = rendererCount("ai_usage:get");
        }
        QCOMPARE(controlCount(*frames, "provider:get"), 1);
        bridge.acceptFrame(controlResult(firstRead, "provider:get", {{"ok", true}, {"llm", emptyModel}}));
        QCOMPARE(rendererCount("ai_usage:get"), permissionsBefore);
        QVERIFY(!bridge.permissionsKnown());
        QVERIFY(bridge.m_providerContextUnknown);
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QCOMPARE(bridge.state().value("provider").toMap(), previous);
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("provider_pending"));
        if (!disconnectDuringSave)
            QCOMPARE(bridge.permissionFeedback().value("refresh").toMap().value("status").toString(), QString("unknown"));
        QCOMPARE(bridge.draft(), draft);
        QCOMPARE(bridge.messages(), messages);
        const int readsBefore = controlCount(*frames, "provider:get");
        if (disconnectDuringSave)
            bridge.sendChat();
        else
            bridge.refreshPermissions();
        QCOMPARE(controlCount(*frames, "provider:get"), readsBefore + 1);
        QCOMPARE(pendingCount(bridge, "provider:get"), 1);
        const auto explicitRead = bridge.m_permissionProviderReadId;
        QVERIFY(!explicitRead.isEmpty());
        QVERIFY(explicitRead != firstRead);
        QCOMPARE(rendererCount("ai_usage:get"), permissionsBefore);
        bridge.acceptFrame(controlResult(explicitRead, "provider:get", {{"ok", true}, {"llm", emptyModel}}));
        QCOMPARE(rendererCount("ai_usage:get"), permissionsBefore + 1);
        QVERIFY(!bridge.m_providerContextUnknown);
        QCOMPARE(bridge.chatSendGate().value("status").toString(), QString("provider_unconfigured"));
        QCOMPARE(bridge.state().value("provider").toMap(), previous);
        // A successful permission read only confirms that current fact; it
        // must not turn the original unknown save into a successful save.
        bridge.event(frame("ai_usage:result", currentPermissionId(bridge),
                           permissions("http://127.0.0.1:11434")));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        bridge.sendChat();
        QCOMPARE(bridge.chatFeedback().value("status").toString(), QString("provider_unconfigured"));
        QCOMPARE(controlCount(*frames, "provider:get"), readsBefore + 1);
        QCOMPARE(controlCount(*frames, "provider:configure"), 1);
        QCOMPARE(rendererCount("chat:send"), 0);
        QCOMPARE(bridge.draft(), draft);
        QCOMPARE(bridge.messages(), messages);
        QVERIFY(!bridge.busy());
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }
    void malformedConfigureAckUsesUnknownReconciliationAndCannotClaimSaved() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_providerTest = provider("provider-b");
        bridge.saveProvider();
        const auto saveId = bridge.m_providerSaveId;
        QSignalSpy results(&bridge, &RuntimeBridge::commandResult);
        bridge.acceptFrame(controlResult(saveId, "provider:configure", {{"ok", true}, {"llm", QJsonObject{}}}));
        QVERIFY(!bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("unknown"));
        QCOMPARE(pendingCount(bridge, "provider:get"), 1);
        QCOMPARE(results.count(), 1);
        const auto result = results.at(0).at(1).toMap();
        QVERIFY(!result.value("ok").toBool());
        QVERIFY(result.value("unknown").toBool());
    }
    void oldUnknownSaveReadCannotRollBackANewerConfiguration() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownPermissions(bridge, permissions("origin-a", true, "digest-a"));
        bridge.m_providerTest = provider("provider-b");
        bridge.saveProvider();
        bridge.expirePending(bridge.m_providerSaveId);
        const auto oldRead = bridge.m_permissionProviderReadId;
        QVERIFY(!oldRead.isEmpty());
        const int oldEpoch = bridge.permissionContextEpoch();
        bridge.m_providerTest = provider("provider-c");
        bridge.saveProvider();
        const auto newSave = bridge.m_providerSaveId;
        QCOMPARE(bridge.permissionContextEpoch(), oldEpoch + 1);
        bridge.acceptFrame(controlResult(newSave, "provider:configure", {{"ok", true},
                           {"llm", provider("provider-c")}}));
        const auto newPermission = currentPermissionId(bridge);
        bridge.acceptFrame(controlResult(oldRead, "provider:get", {{"ok", true},
                           {"llm", provider("provider-b")}}));
        QCOMPARE(bridge.state().value("provider").toMap(), provider("provider-c").toVariantMap());
        QCOMPARE(pendingCount(bridge, "ai_usage:get"), 1);
        bridge.event(frame("ai_usage:result", newPermission, permissions("origin-c", false, "digest-c")));
        QVERIFY(bridge.permissionsKnown());
        QCOMPARE(bridge.providerFeedback().value("status").toString(), QString("saved"));
    }
    void unknownAndOldGenerationErrorsAreRejected() {
        QFETCH(bool, oldGeneration);
        QTemporaryDir data;
        QVERIFY(data.isValid());
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        activeChat(bridge);
        const QString id = oldGeneration ? bridge.m_chatId : QString("unknown-request");
        if (oldGeneration)
            pending(bridge, id, "chat:send", bridge.generation() - 1);
        const auto noticeBefore = bridge.notice();
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        QSignalSpy changes(&bridge, &RuntimeBridge::changed);

        bridge.event(frame("error", id, {{"message", "Must not be accepted"}}));

        QVERIFY(bridge.busy());
        QCOMPARE(bridge.notice(), noticeBefore);
        QCOMPARE(responses.count(), 0);
        QCOMPARE(changes.count(), 0);
        QCOMPARE(bridge.m_process.state(), QProcess::NotRunning);
    }
    void settingsUpdateOffersOnlyDeliveredFields() {
        QString error;
        const auto chat = RuntimeBridge::settingsUpdate("chat", {{"split_messages", true}}, &error);
        QCOMPARE(chat, (QVariantMap{{"section", "chat"}, {"split_messages", true}}));
        QVERIFY(error.isEmpty());
        // Fields whose effect the native chat path bypasses, and other sections, are not offered.
        for (const auto &[section, fields] : QList<QPair<QString, QVariantMap>>{
                 {"chat", {{"reply_delay_min", 3}}},
                 {"chat", {{"typing_indicator", true}}},
                 {"chat", {{"status", "sleeping"}}},
                 {"chat", {{"split_messages", "true"}}},
                 {"chat", {{"split_messages", 1}}},
                 {"chat", {}},
                 {"memory", {{"retention_days", 400}}},
                 {"memory", {{"retention_days", "365"}}},
                 {"memory", {{"autonomous_memory_enabled", false}}},
                 {"memory", {{"decay_lambda", 0.01}}},
                 {"personality", {{"emotion_system_enabled", 0}}},
                 {"personality", {{"personality_flaws_disclaimer_acknowledged", false}}},
                 {"personality", {{"user_selected_flaws", "怕黑"}, {"personality_flaws_disclaimer_acknowledged", true}}},
                 {"personality", {{"user_selected_flaws", "   "}, {"personality_flaws_enabled", true},
                                  {"personality_flaws_disclaimer_acknowledged", true}}},
                 {"personality", {{"user_selected_flaws", QString(401, QChar(0x6015))}, {"personality_flaws_enabled", true},
                                  {"personality_flaws_disclaimer_acknowledged", true}}},
                 {"features", {{"hypa_compression_enabled", true}}},
                 {"immersion", {{"immersion_location_enabled", true}}}}) {
            QVERIFY2(RuntimeBridge::settingsUpdate(section, fields, &error).isEmpty(), qPrintable(section));
            QCOMPARE(error, QString("设置内容无效，没有发送。"));
        }
        QCOMPARE(RuntimeBridge::settingsUpdate("memory", {{"retention_days", 365.0}, {"forgetting_enabled", false}}, &error),
                 (QVariantMap{{"section", "memory"}, {"retention_days", 365}, {"forgetting_enabled", false}}));
        QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"personality_flaws_enabled", false}}, &error),
                 (QVariantMap{{"section", "personality"}, {"personality_flaws_enabled", false}}));
        // Whatever makes flaws active needs the acknowledgement in the same request.
        QVERIFY(RuntimeBridge::settingsUpdate("personality", {{"personality_flaws_enabled", true}}, &error).isEmpty());
        QCOMPARE(error, QString("需要先勾选知悉说明，设置没有改动。"));
        const auto flaws = RuntimeBridge::settingsUpdate(
            "personality", {{"user_selected_flaws", " 怕黑 "}, {"personality_flaws_enabled", true},
                            {"personality_flaws_disclaimer_acknowledged", true}}, &error);
        QCOMPARE(flaws, (QVariantMap{{"section", "personality"}, {"user_selected_flaws", "怕黑"},
                                     {"personality_flaws_enabled", true},
                                     {"personality_flaws_disclaimer_acknowledged", true}}));
        QVERIFY(!RuntimeBridge::settingsUpdate(
                     "personality", {{"user_selected_flaws", QString(400, QChar(0x6015))}, {"personality_flaws_enabled", true},
                                     {"personality_flaws_disclaimer_acknowledged", true}}, &error).isEmpty());
    }
    void onboardingOnlyFinishesAndEndsWithTheReadBack() {
        QString error;
        QCOMPARE(RuntimeBridge::settingsUpdate("onboarding", {{"completed", true}}, &error),
                 (QVariantMap{{"section", "onboarding"}, {"completed", true}}));
        QVERIFY(error.isEmpty());
        // The sheet never reopens setup, records progress or changes the mode.
        for (const auto &fields : QList<QVariantMap>{{{"completed", false}},
                                                     {{"completed", "true"}},
                                                     {{"completed", 1}},
                                                     {{"completed", true}, {"onboarding_state", "in_progress"}},
                                                     {{"onboarding_state", "complete"}},
                                                     {{"experience_mode", "full"}},
                                                     {}}) {
            QVERIFY(RuntimeBridge::settingsUpdate("onboarding", fields, &error).isEmpty());
            QCOMPARE(error, QString("设置内容无效，没有发送。"));
        }
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        QVERIFY(!bridge.firstRunPending());
        online(bridge);
        QVERIFY(!bridge.firstRunPending());
        // A snapshot without the ui section cannot tell; the sheet stays away.
        knownSettings(bridge);
        QVERIFY(!bridge.firstRunPending());
        auto fresh = settingsSnapshot();
        fresh["ui"] = QJsonObject{{"onboarding_completed", false}, {"onboarding_state", "not_started"}};
        knownSettings(bridge, fresh);
        QVERIFY(bridge.firstRunPending());
        bridge.saveSettings("onboarding", {{"completed", false}});
        QCOMPARE(settingsReceipt(bridge, "onboarding").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);
        bridge.saveSettings("onboarding", {{"completed", true}});
        const auto id = controlId(bridge, "settings:update");
        QVERIFY(!id.isEmpty());
        QCOMPARE(settingsReceipt(bridge, "onboarding").value("status").toString(), QString("pending"));
        bridge.event(frame("settings:update:result", id,
                           {{"ok", true}, {"ui", QJsonObject{{"onboarding_completed", true}}}}));
        // The receipt alone does not end the sheet; the read-back does.
        QVERIFY(bridge.firstRunPending());
        QCOMPARE(settingsReceipt(bridge, "onboarding").value("status").toString(), QString("pending"));
        auto done = settingsSnapshot();
        done["ui"] = QJsonObject{{"onboarding_completed", true}, {"onboarding_state", "complete"}};
        bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), done));
        QCOMPARE(settingsReceipt(bridge, "onboarding").value("status").toString(), QString("success"));
        QCOMPARE(settingsReceipt(bridge, "onboarding").value("text").toString(), QString("首次设置已完成。"));
        QVERIFY(!bridge.firstRunPending());
        // A failed read leaves the state unknown, which never shows the sheet.
        knownSettings(bridge, fresh);
        QVERIFY(bridge.firstRunPending());
        bridge.expirePending(bridge.request("settings:get"));
        QVERIFY(!bridge.firstRunPending());
    }
    void settingsSaveNeedsAKnownWritableSessionAndSendsTheExactBody() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        bridge.saveSettings("chat", {{"split_messages", true}});
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(), QString("本地服务尚未连接，设置没有改动。"));
        online(bridge);
        bridge.saveSettings("chat", {{"split_messages", true}});
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(),
                 QString("当前设置尚未读取，暂不能保存；请稍后重试。"));
        knownSettings(bridge);
        bridge.m_runtimeWritable = false;
        bridge.saveSettings("chat", {{"split_messages", true}});
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(), QString("当前为只读状态，设置没有改动。"));
        bridge.m_runtimeWritable = true;
        bridge.m_personaSwitch = {{"requestId", "switch-pending"}};
        bridge.saveSettings("chat", {{"split_messages", true}});
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(), QString("人格操作仍在核对中，设置没有改动。"));
        bridge.m_personaSwitch.clear();
        bridge.saveSettings("chat", {{"typing_indicator", true}});
        QCOMPARE(settingsReceipt(bridge, "chat").value("status").toString(), QString("error"));
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);

        QJsonObject sent;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            sent = QJsonDocument::fromJson(bytes.mid(4)).object();
            return bytes.size();
        };
        bridge.saveSettings("chat", {{"split_messages", true}, {"allow_environment_description", true}});
        const auto envelope = sent["envelope"].toObject();
        QCOMPARE(envelope["command"].toString(), QString("settings:update"));
        QCOMPARE(envelope["payload"].toObject(), (QJsonObject{{"section", "chat"}, {"split_messages", true},
                                                             {"allow_environment_description", true}}));
        const auto id = envelope["request_id"].toString();
        QCOMPARE(controlId(bridge, "settings:update"), id);
        const auto receipt = settingsReceipt(bridge, "chat");
        QCOMPARE(receipt.value("status").toString(), QString("pending"));
        QCOMPARE(receipt.value("requestId").toString(), id);
        QCOMPARE(receipt.value("fields").toMap(),
                 (QVariantMap{{"split_messages", true}, {"allow_environment_description", true}}));
        // One save per section at a time; another section is independent.
        bridge.saveSettings("chat", {{"split_messages", false}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        bridge.saveSettings("memory", {{"forgetting_enabled", false}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 2);
        QCOMPARE(settingsReceipt(bridge, "chat").value("requestId").toString(), id);
    }
    void settingsReceiptsReadTheRuntimeBack_data() {
        QTest::addColumn<QString>("eventType");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("status");
        QTest::addColumn<QString>("text");
        QTest::newRow("saved") << "settings:update:result"
                               << QJsonObject{{"ok", true}, {"features", QJsonObject{}}}
                               << "success" << "性格设置已保存。";
        QTest::newRow("rejected") << "settings:update:result"
                                  << QJsonObject{{"ok", false}, {"error", "Settings are not initialized"}}
                                  << "error" << "设置未能保存，原设置保留。";
        QTest::newRow("validation-error") << "error" << QJsonObject{{"message", "personality:value_error"}}
                                          << "error" << "设置未能保存，原设置保留。";
        QTest::newRow("runtime-unconfirmed")
            << "settings:update:result"
            << QJsonObject{{"ok", false}, {"code", "settings_runtime_unconfirmed"},
                           {"error", "Settings were saved, but applying them is not confirmed"},
                           {"features", QJsonObject{}}}
            << "unknown" << "设置已写入，但运行中是否生效尚未确认；已重新读取当前设置。";
    }
    void settingsReceiptsReadTheRuntimeBack() {
        QFETCH(QString, eventType);
        QFETCH(QJsonObject, payload);
        QFETCH(QString, status);
        QFETCH(QString, text);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge);
        bridge.saveSettings("personality", {{"personality_flaws_enabled", false}});
        const auto id = controlId(bridge, "settings:update");
        QCOMPARE(pendingCount(bridge, "settings:get"), 0);
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);
        QCOMPARE(pendingCount(bridge, "settings:get"), 1);
        const auto readId = controlId(bridge, "settings:get");
        if (status == "success") {
            // A confirmed save stays pending, showing the requested value, until its read-back.
            QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("pending"));
            QCOMPARE(settingsReceipt(bridge, "personality").value("readId").toString(), readId);
            bridge.event(frame("settings:get:result", readId, settingsSnapshot()));
        }
        const auto receipt = settingsReceipt(bridge, "personality");
        QCOMPARE(receipt.value("status").toString(), status);
        QCOMPARE(receipt.value("text").toString(), text);
        QCOMPARE(receipt.value("requestId").toString(), id);
        // A late duplicate of the same receipt changes nothing.
        bridge.event(frame(eventType, id, payload));
        QCOMPARE(pendingCount(bridge, "settings:get"), status == "success" ? 0 : 1);
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), status);
    }
    void confirmedSaveSettlesWhenItsReadIsLost() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge);
        bridge.saveSettings("chat", {{"split_messages", true}});
        bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"), {{"ok", true}}));
        bridge.expirePending(controlId(bridge, "settings:get"));
        QCOMPARE(settingsReceipt(bridge, "chat").value("status").toString(), QString("success"));
        QCOMPARE(settingsReceipt(bridge, "read").value("status").toString(), QString("error"));
        QVERIFY(!bridge.settingsKnown());

        knownSettings(bridge);
        bridge.saveSettings("memory", {{"forgetting_enabled", false}});
        bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"), {{"ok", true}}));
        QCOMPARE(settingsReceipt(bridge, "memory").value("status").toString(), QString("pending"));
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 4},
                                                  {"fingerprint", "fingerprint-next"}}));
        QCOMPARE(settingsReceipt(bridge, "memory").value("status").toString(), QString("success"));
        QCOMPARE(settingsReceipt(bridge, "memory").value("text").toString(), QString("记忆设置已保存。"));
    }
    void settingsReadFailureKeepsTheLastSnapshotAndBlocksSaves() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        QSignalSpy reads(&bridge, &RuntimeBridge::settingsRead);
        knownSettings(bridge, settingsSnapshot(730, true));
        QCOMPARE(reads.count(), 1);
        const auto confirmed = bridge.state().value("settings");
        bridge.event(frame("settings:get:result", bridge.request("settings:get"),
                           {{"ok", false}, {"error", "Settings are not initialized"}}));
        auto partial = settingsSnapshot(365, false);
        partial.remove("features");
        bridge.event(frame("settings:get:result", bridge.request("settings:get"), partial));
        QCOMPARE(reads.count(), 1);
        QCOMPARE(bridge.state().value("settings"), confirmed);
        QCOMPARE(settingsReceipt(bridge, "read").value("status").toString(), QString("error"));
        QVERIFY(!bridge.settingsKnown());
        bridge.saveSettings("chat", {{"split_messages", false}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(),
                 QString("当前设置尚未读取，暂不能保存；请稍后重试。"));
        knownSettings(bridge, settingsSnapshot(365, false));
        QCOMPARE(reads.count(), 2);
        QVERIFY(!bridge.settingsFeedback().contains("read"));
        bridge.saveSettings("chat", {{"split_messages", true}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
    }
    void shorterRetentionIsSentOnlyWhenConfirmed() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge, settingsSnapshot(730));
        bridge.saveSettings("memory", {{"retention_days", 365}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 0);
        QCOMPARE(settingsReceipt(bridge, "memory").value("text").toString(),
                 QString("缩短保留期需要先确认，设置没有改动。"));
        bridge.saveSettings("memory", {{"retention_days", 1095}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"),
                           {{"ok", true}, {"settings", QJsonObject{{"retention_days", 1095}}}}));
        bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), settingsSnapshot(1095)));
        QCOMPARE(settingsReceipt(bridge, "memory").value("status").toString(), QString("success"));
        bridge.saveSettings("memory", {{"retention_days", 365}}, true);
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        QCOMPARE(settingsReceipt(bridge, "memory").value("fields").toMap(), (QVariantMap{{"retention_days", 365}}));
    }
    void forgettingAndMisrememberingOfferOnlyThePagePresets() {
        QString error;
        const auto presets = RuntimeBridge::settingsUpdate(
            "memory", {{"long_term_forget_days", 180}, {"short_term_forget_days", 14.0},
                       {"long_term_forget_probability", 0.1}, {"short_term_forget_probability", 0.03},
                       {"long_term_misremember_probability", 0.05}, {"short_term_misremember_probability", 0.01},
                       {"misremembering_enabled", false}, {"long_term_misremembering_enabled", true},
                       {"short_term_misremembering_enabled", false}}, &error);
        QCOMPARE(presets, (QVariantMap{{"section", "memory"}, {"long_term_forget_days", 180},
                                       {"short_term_forget_days", 14}, {"long_term_forget_probability", 0.1},
                                       {"short_term_forget_probability", 0.03},
                                       {"long_term_misremember_probability", 0.05},
                                       {"short_term_misremember_probability", 0.01},
                                       {"misremembering_enabled", false}, {"long_term_misremembering_enabled", true},
                                       {"short_term_misremembering_enabled", false}}));
        QVERIFY(error.isEmpty());
        // A value off the page, a misread type or an unoffered field never leaves.
        for (const auto &fields : QList<QVariantMap>{{{"long_term_forget_days", 45}},
                                                     {{"long_term_forget_days", 7}},
                                                     {{"short_term_forget_days", 90}},
                                                     {{"short_term_forget_days", 7.5}},
                                                     {{"short_term_forget_days", std::nan("")}},
                                                     {{"short_term_forget_days", "7"}},
                                                     {{"short_term_forget_days", true}},
                                                     {{"long_term_forget_probability", 0.02}},
                                                     {{"long_term_forget_probability", 0.5}},
                                                     {{"long_term_forget_probability", 5}},
                                                     {{"long_term_forget_probability", "0.05"}},
                                                     {{"short_term_misremember_probability", 0.0}},
                                                     {{"short_term_misremember_probability", std::nan("")}},
                                                     {{"misremembering_enabled", 1}},
                                                     {{"misremember_probability", 0.05}},
                                                     {{"forget_probability", 0.05}}}) {
            QVERIFY2(RuntimeBridge::settingsUpdate("memory", fields, &error).isEmpty(),
                     qPrintable(fields.firstKey()));
            QCOMPARE(error, QString("设置内容无效，没有发送。"));
        }
    }
    void misrememberingIsTurnedOnOnlyWhenConfirmed() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownSettings(bridge);
        const auto settle = [&] {
            bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"), {{"ok", true}}));
            bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), settingsSnapshot()));
            QCOMPARE(settingsReceipt(bridge, "memory").value("status").toString(), QString("success"));
        };
        for (const auto &fields : QList<QVariantMap>{{{"misremembering_enabled", true}},
                                                     {{"misremembering_enabled", true},
                                                      {"long_term_misremember_probability", 0.03}}}) {
            bridge.saveSettings("memory", fields);
            QCOMPARE(pendingCount(bridge, "settings:update"), 0);
            QCOMPARE(settingsReceipt(bridge, "memory").value("text").toString(),
                     QString("开启记错需要先确认，设置没有改动。"));
        }
        QCOMPARE(commandCount(*frames, "settings:update"), 0);
        bridge.saveSettings("memory", {{"misremembering_enabled", true}}, true);
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        auto sent = lastCommand(*frames, "settings:update");
        QCOMPARE(sent.value("section").toString(), QString("memory"));
        QCOMPARE(sent.value("misremembering_enabled"), QJsonValue(true));
        settle();
        // Its parts and turning it off follow the ordinary save.
        bridge.saveSettings("memory", {{"short_term_misremembering_enabled", false},
                                       {"long_term_misremember_probability", 0.03}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        sent = lastCommand(*frames, "settings:update");
        QCOMPARE(sent.value("short_term_misremembering_enabled"), QJsonValue(false));
        QCOMPARE(sent.value("long_term_misremember_probability"), QJsonValue(0.03));
        settle();
        bridge.saveSettings("memory", {{"misremembering_enabled", false}});
        QCOMPARE(pendingCount(bridge, "settings:update"), 1);
        QCOMPARE(lastCommand(*frames, "settings:update").value("misremembering_enabled"), QJsonValue(false));
        QCOMPARE(commandCount(*frames, "settings:update"), 3);
    }
    void emotionSettingsOfferOnlyThePagePresets() {
        QString error;
        QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"emotion_system_enabled", false},
                                                               {"emotion_carryover_days", 5.0},
                                                               {"emotion_inertia_factor", 0.3}}, &error),
                 (QVariantMap{{"section", "personality"}, {"emotion_system_enabled", false},
                              {"emotion_carryover_days", 5}, {"emotion_inertia_factor", 0.3}}));
        QVERIFY(error.isEmpty());
        for (const auto &[days, ratio] : QList<QPair<int, double>>{{1, 0.05}, {3, 0.1}, {7, 0.15}})
            QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"emotion_carryover_days", days},
                                                                   {"emotion_inertia_factor", ratio}}, &error),
                     (QVariantMap{{"section", "personality"}, {"emotion_carryover_days", days},
                                  {"emotion_inertia_factor", ratio}}));
        // A value off the page, a misread type or another section never leaves.
        for (const auto &[section, fields] : QList<QPair<QString, QVariantMap>>{
                 {"personality", {{"emotion_carryover_days", 2}}},
                 {"personality", {{"emotion_carryover_days", 3.5}}},
                 {"personality", {{"emotion_carryover_days", "3"}}},
                 {"personality", {{"emotion_carryover_days", std::nan("")}}},
                 {"personality", {{"emotion_inertia_factor", 0.2}}},
                 {"personality", {{"emotion_inertia_factor", 0.6}}},
                 {"personality", {{"emotion_inertia_factor", 15}}},
                 {"personality", {{"emotion_inertia_factor", "0.15"}}},
                 {"personality", {{"emotion_inertia_factor", std::nan("")}}},
                 {"personality", {{"emotion_system_enabled", "false"}}},
                 {"personality", {{"emotion_paused_since", "2026-10-21T00:00:00"}}},
                 {"personality", {{"emotion_pause_intervals", QVariantList{}}}},
                 {"memory", {{"emotion_carryover_days", 3}}},
                 {"chat", {{"emotion_system_enabled", true}}}}) {
            QVERIFY2(RuntimeBridge::settingsUpdate(section, fields, &error).isEmpty(), qPrintable(fields.firstKey()));
            QCOMPARE(error, QString("设置内容无效，没有发送。"));
        }
    }
    void emotionSavesAreConfirmedOnlyByTheRunningEmotion() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        const auto snapshot = [](bool enabled, int days, double ratio, const QJsonValue &runtime) {
            auto value = settingsSnapshot();
            auto features = value["features"].toObject();
            features["emotion_system_enabled"] = enabled;
            features["emotion_carryover_days"] = days;
            features["emotion_inertia_factor"] = ratio;
            value["features"] = features;
            if (!runtime.isUndefined())
                value["emotionRuntime"] = runtime;
            return value;
        };
        const auto running = [](bool enabled, int days, double ratio) {
            return QJsonObject{{"enabled", enabled}, {"carryover_days", days}, {"inertia_factor", ratio}};
        };
        knownSettings(bridge, snapshot(true, 3, 0.15, running(true, 3, 0.15)));
        // Each save is sent, acknowledged and then waits for its read; the
        // status while waiting is kept to check after the read arrives.
        QStringList awaitingReads;
        const auto save = [&](const QVariantMap &fields, const QJsonObject &read) {
            const int sent = commandCount(*frames, "settings:update");
            bridge.saveSettings("personality", fields);
            awaitingReads << (commandCount(*frames, "settings:update") == sent + 1 ? QString("sent") : QString("unsent"));
            bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"), {{"ok", true}}));
            awaitingReads << settingsReceipt(bridge, "personality").value("status").toString();
            bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), read));
            return settingsReceipt(bridge, "personality");
        };
        auto receipt = save({{"emotion_carryover_days", 5}}, snapshot(true, 5, 0.15, running(true, 5, 0.15)));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QCOMPARE(receipt.value("text").toString(), QString("情绪设置已保存。"));
        QCOMPARE(lastCommand(*frames, "settings:update").value("emotion_carryover_days"), QJsonValue(5));
        // Saved but still running the old value, or not reported at all: not confirmed.
        for (const auto &runtime : QList<QJsonValue>{running(true, 5, 0.15), running(false, 5, 0.15),
                                                     QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Undefined)}) {
            receipt = save({{"emotion_inertia_factor", 0.3}}, snapshot(true, 5, 0.3, runtime));
            QCOMPARE(receipt.value("status").toString(), QString("unknown"));
            QCOMPARE(receipt.value("text").toString(),
                     QString("设置已写入，但运行中的情绪尚未确认同步；已重新读取当前设置。"));
        }
        receipt = save({{"emotion_system_enabled", false}}, snapshot(false, 5, 0.3, running(false, 5, 0.3)));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QCOMPARE(lastCommand(*frames, "settings:update").value("emotion_system_enabled"), QJsonValue(false));
        // A trait save is confirmed by its read alone, as before.
        receipt = save({{"personality_flaws_enabled", false}}, snapshot(true, 3, 0.15, QJsonValue(QJsonValue::Null)));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QCOMPARE(receipt.value("text").toString(), QString("性格设置已保存。"));
        QCOMPARE(lastCommand(*frames, "settings:update").value("section").toString(), QString("personality"));
        QCOMPARE(awaitingReads.size(), 14);
        for (int index = 0; index < awaitingReads.size(); index += 2)
            QCOMPARE(awaitingReads.mid(index, 2), (QStringList{"sent", "pending"}));
    }
    void budgetSettingsOfferOnlyThePagePresetsAndNeverTracking() {
        QString error;
        QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"api_background_budget_enforced", false}}, &error),
                 (QVariantMap{{"section", "personality"}, {"api_background_budget_enforced", false}}));
        for (const int requests : {30, 60, 120, 240}) {
            QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"api_background_daily_request_budget", double(requests)}}, &error),
                     (QVariantMap{{"section", "personality"}, {"api_background_daily_request_budget", requests}}));
            QVERIFY(error.isEmpty());
        }
        for (const int tokens : {10000, 30000, 100000, 300000}) {
            QCOMPARE(RuntimeBridge::settingsUpdate("personality", {{"api_background_daily_token_budget", tokens}}, &error),
                     (QVariantMap{{"section", "personality"}, {"api_background_daily_token_budget", tokens}}));
            QVERIFY(error.isEmpty());
        }
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        for (const auto &[section, fields] : QList<QPair<QString, QVariantMap>>{
                 {"personality", {{"api_budget_tracking_enabled", false}}},
                 {"personality", {{"api_budget_tracking_enabled", true}, {"api_background_budget_enforced", true}}},
                 {"personality", {{"api_background_budget_enforced", "true"}}},
                 {"personality", {{"api_background_budget_enforced", 1}}},
                 {"personality", {{"api_background_daily_request_budget", "60"}}},
                 {"personality", {{"api_background_daily_request_budget", true}}},
                 {"personality", {{"api_background_daily_request_budget", 90}}},
                 {"personality", {{"api_background_daily_request_budget", 30.5}}},
                 {"personality", {{"api_background_daily_request_budget", std::nan("")}}},
                 {"personality", {{"api_background_daily_token_budget", "30000"}}},
                 {"personality", {{"api_background_daily_token_budget", 1000}}},
                 {"personality", {{"api_background_daily_token_budget", 300000.5}}},
                 {"personality", {{"api_background_daily_token_budget", 1e100}}},
                 {"memory", {{"api_background_daily_request_budget", 60}}},
                 {"chat", {{"api_background_budget_enforced", true}}}}) {
            QVERIFY2(RuntimeBridge::settingsUpdate(section, fields, &error).isEmpty(), qPrintable(fields.firstKey()));
            QCOMPARE(error, QString("设置内容无效，没有发送。"));
            bridge.saveSettings(section, fields);
            QCOMPARE(settingsReceipt(bridge, section).value("status").toString(), QString("error"));
        }
        QCOMPARE(commandCount(*frames, "settings:update"), 0);
    }
    void budgetSavesRequireTheSubmittedValuesAndAllFourRuntimeFields() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        QStringList awaiting;
        const auto save = [&](const QVariantMap &fields, const QJsonObject &snapshot) {
            bridge.saveSettings("personality", fields);
            const auto id = settingsReceipt(bridge, "personality").value("requestId").toString();
            bridge.event(frame("settings:update:result", id, {{"ok", true}}));
            awaiting << settingsReceipt(bridge, "personality").value("status").toString();
            const auto readId = settingsReceipt(bridge, "personality").value("readId").toString();
            bridge.event(frame("settings:get:result", readId, snapshot));
            return settingsReceipt(bridge, "personality");
        };
        auto receipt = save({{"api_background_daily_request_budget", 120}}, budgetSettingsSnapshot(true, true, 120));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QCOMPARE(receipt.value("text").toString(), QString("用量上限已保存。"));
        receipt = save({{"api_background_daily_token_budget", 100000}}, budgetSettingsSnapshot(true, true, 120, 100000));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        receipt = save({{"api_background_budget_enforced", false}}, budgetSettingsSnapshot(true, false, 120, 100000));
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QCOMPARE(lastCommand(*frames, "settings:update").value("api_background_budget_enforced"), QJsonValue(false));

        QList<QJsonObject> unconfirmed;
        // Even a mutually consistent old config/runtime cannot confirm request=240.
        unconfirmed << budgetSettingsSnapshot(true, true, 120, 100000);
        for (const auto &runtime : QList<QJsonValue>{
                 budgetRuntime(true, true, 120, 100000), budgetRuntime(false, true, 240, 100000),
                 budgetRuntime(true, false, 240, 100000), budgetRuntime(true, true, 240, 30000),
                 QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Undefined),
                 QJsonObject{{"tracking_enabled", true}, {"background_enforced", true},
                     {"request_budget", "240"}, {"token_budget", 100000}},
                 QJsonObject{{"tracking_enabled", true}, {"background_enforced", true},
                     {"request_budget", 240}, {"token_budget", true}},
                 QJsonObject{{"tracking_enabled", 1}, {"background_enforced", true},
                     {"request_budget", 240}, {"token_budget", 100000}}}) {
            auto snapshot = budgetSettingsSnapshot(true, true, 240, 100000);
            snapshot.remove("budgetRuntime");
            if (!runtime.isUndefined())
                snapshot["budgetRuntime"] = runtime;
            unconfirmed << snapshot;
        }
        auto missingConfig = budgetSettingsSnapshot(true, true, 240, 100000);
        auto features = missingConfig["features"].toObject();
        features.remove("api_budget_tracking_enabled");
        missingConfig["features"] = features;
        unconfirmed << missingConfig;
        auto stringConfig = budgetSettingsSnapshot(true, true, 240, 100000);
        features = stringConfig["features"].toObject();
        features["api_background_daily_token_budget"] = "100000";
        stringConfig["features"] = features;
        unconfirmed << stringConfig;
        for (const auto &snapshot : unconfirmed) {
            receipt = save({{"api_background_daily_request_budget", 240}}, snapshot);
            QCOMPARE(receipt.value("status").toString(), QString("unknown"));
            QCOMPARE(receipt.value("text").toString(),
                     QString("设置已写入，但运行中的用量上限尚未确认同步；已重新读取当前设置。"));
        }
        QCOMPARE(commandCount(*frames, "settings:update"), 3 + unconfirmed.size());
        QCOMPARE(commandCount(*frames, "api:budget:get"), 3 + unconfirmed.size());
        for (const auto &status : awaiting)
            QCOMPARE(status, QString("pending"));
    }
    void budgetSaveWithTrackingDisabledConfirmsOnlySavedValues() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge, budgetSettingsSnapshot(false));
        bridge.saveSettings("personality", {{"api_background_daily_request_budget", 120}});
        const auto id = settingsReceipt(bridge, "personality").value("requestId").toString();
        QVERIFY(bridge.m_pending.contains(id));
        bridge.event(frame("settings:update:result", id, {{"ok", true}}));
        const auto readId = settingsReceipt(bridge, "personality").value("readId").toString();
        bridge.event(frame("settings:get:result", readId, budgetSettingsSnapshot(false, true, 120)));
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("success"));
        QCOMPARE(settingsReceipt(bridge, "personality").value("text").toString(), QString("用量上限已保存。"));
        const auto budgetId = bridge.budgetState().value("requestId").toString();
        bridge.event(frame("api:budget:result", budgetId, budgetSnapshot(bridge, 2, 900, 120, 30000, false)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        QVERIFY(!bridge.budgetState().value("snapshot").toMap().value("tracking_enabled").toBool());
    }
    void budgetSaveFailureKeepsSettingsAndRefreshesTheLedger() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        knownBudget(bridge);
        const auto before = bridge.state().value("settings");
        bridge.saveSettings("personality", {{"api_background_daily_token_budget", 100000}});
        QVERIFY(!bridge.budgetState().value("live").toBool());
        const auto id = settingsReceipt(bridge, "personality").value("requestId").toString();
        bridge.event(frame("settings:update:result", id, {{"ok", false}, {"error", "private write failure"}}));
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("error"));
        QCOMPARE(bridge.state().value("settings"), before);
        QCOMPARE(commandCount(*frames, "api:budget:get"), 2);
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("pending"));
        QVERIFY(!settingsReceipt(bridge, "personality").value("text").toString().contains("private"));
        bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), budgetSettingsSnapshot()));
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("error"));
    }
    void budgetSaveReadFailureCannotConfirmTheCachedRuntime() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        for (const auto &failure : {"error", "partial", "timeout", "runtime-unconfirmed"}) {
            knownSettings(bridge, budgetSettingsSnapshot(true, true, 120));
            const auto before = bridge.state().value("settings");
            bridge.saveSettings("personality", {{"api_background_daily_request_budget", 120}});
            const auto id = settingsReceipt(bridge, "personality").value("requestId").toString();
            if (QString(failure) == "runtime-unconfirmed") {
                bridge.event(frame("settings:update:result", id,
                    {{"ok", false}, {"code", "settings_runtime_unconfirmed"}}));
                QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("unknown"));
                bridge.event(frame("settings:get:result", controlId(bridge, "settings:get"), budgetSettingsSnapshot(true, true, 120)));
            } else {
                bridge.event(frame("settings:update:result", id, {{"ok", true}}));
                const auto readId = settingsReceipt(bridge, "personality").value("readId").toString();
                QVERIFY(!readId.isEmpty());
                if (QString(failure) == "timeout")
                    bridge.expirePending(readId);
                else
                    bridge.event(frame(QString(failure) == "error" ? "error" : "settings:get:result", readId,
                        {{"ok", false}, {"error", "private read failure"}}));
                QCOMPARE(bridge.state().value("settings"), before);
            }
            QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("unknown"));
            QCOMPARE(settingsReceipt(bridge, "personality").value("text").toString(),
                     QString("设置已写入，但运行中的用量上限尚未确认同步；已重新读取当前设置。"));
        }
    }
    void budgetSaveDisconnectWhileAwaitingReadStaysUnconfirmed() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        bridge.saveSettings("personality", {{"api_background_daily_request_budget", 120}});
        const auto id = settingsReceipt(bridge, "personality").value("requestId").toString();
        bridge.event(frame("settings:update:result", id, {{"ok", true}}));
        const auto readId = settingsReceipt(bridge, "personality").value("readId").toString();
        QVERIFY(!readId.isEmpty());
        bridge.m_process.finished(1, QProcess::CrashExit);
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("unknown"));
        QVERIFY(settingsReceipt(bridge, "personality").value("text").toString().contains("尚未确认同步"));
        const auto receipt = settingsReceipt(bridge, "personality");
        bridge.event(frame("settings:get:result", readId, budgetSettingsSnapshot(true, true, 120)));
        QCOMPARE(settingsReceipt(bridge, "personality"), receipt);
        QVERIFY(!bridge.budgetState().value("live").toBool());
    }
    void budgetUsageAcceptsOnlyACompleteCurrentReadWithoutRequiringOk() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        QVERIFY(!bridge.budgetState().value("live").toBool());
        QVERIFY(bridge.budgetState().value("snapshot").toMap().isEmpty());
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 0);
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("pending"));
        QCOMPARE(bridge.budgetState().value("generation").toInt(), bridge.generation());
        QCOMPARE(bridge.budgetState().value("scopeKey").toString(), bridge.scopeKey());
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 1);
        auto payload = budgetSnapshot(bridge, 5, 1700, 120, 100000);
        QVERIFY(!payload.contains("ok"));
        QSignalSpy responses(&bridge, &RuntimeBridge::responseReceived);
        bridge.acceptFrame({{"kind", "event"}, {"frame", frame("api:budget:result", id, payload)}});
        const auto receipt = bridge.budgetState();
        QCOMPARE(receipt.value("status").toString(), QString("success"));
        QVERIFY(receipt.value("live").toBool());
        QVERIFY(!receipt.value("stale").toBool());
        QCOMPARE(receipt.value("snapshot").toMap(), payload.toVariantMap());
        QCOMPARE(bridge.state().value("budget").toMap(), payload.toVariantMap());
        QVERIFY(!bridge.m_pending.contains(id));
        QCOMPARE(responses.count(), 1);
        QCOMPARE(responses.at(0).at(0).toString(), id);
        QCOMPARE(responses.at(0).at(1).toString(), QString("api:budget:get"));
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 99)));
        QCOMPARE(bridge.budgetState(), receipt);
        QCOMPARE(responses.count(), 1);
        QCOMPARE(commandCount(*frames, "api:budget:get"), 1);
    }
    void budgetUsageRejectsAnOlderPendingReadInTheSameGeneration() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        bridge.refreshBudget();
        const auto oldId = bridge.budgetState().value("requestId").toString();
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(oldId != id);
        QVERIFY(!bridge.m_pending.contains(oldId));
        QVERIFY(bridge.m_pending.contains(id));
        const auto waiting = bridge.budgetState();
        const auto oldBudget = bridge.state().value("budget");
        bridge.event(frame("api:budget:result", oldId, budgetSnapshot(bridge, 11)));
        QCOMPARE(bridge.budgetState(), waiting);
        QCOMPARE(bridge.state().value("budget"), oldBudget);
        QVERIFY(!bridge.m_pending.contains(oldId));
        bridge.expirePending(oldId);
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 12)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        QCOMPARE(bridge.budgetState().value("snapshot").toMap().value("background").toMap().value("requests").toInt(), 12);
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 3);
    }
    void budgetUsageRejectsMissingIdsWrongCommandsAndForeignScopes() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        const auto payload = budgetSnapshot(bridge);
        const auto waiting = bridge.budgetState();
        bridge.event(frame("api:budget:result", "", payload));
        bridge.event(frame("api:budget:result", "unrelated-request", payload));
        const auto unrelated = bridge.request("relationship:get");
        bridge.event(frame("api:budget:result", unrelated, payload));
        QVERIFY(bridge.m_pending.contains(unrelated));
        QCOMPARE(bridge.budgetState(), waiting);
        for (const auto &[key, value] : QList<QPair<QString, QJsonValue>>{
                 {"persona_id", "persona-other"}, {"persona_epoch", 2},
                 {"persona_fingerprint", "fingerprint-other"}, {"request_id", "another-request"}}) {
            auto foreign = payload;
            foreign[key] = value;
            bridge.event(frame("api:budget:result", id, foreign));
            QCOMPARE(bridge.budgetState(), waiting);
            QVERIFY(bridge.m_pending.contains(id));
        }
        auto duplicateId = payload;
        duplicateId["request_id"] = id;
        bridge.event({{"type", "api:budget:result"}, {"request_id", 7}, {"payload", duplicateId}});
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.m_pending[id].generation = bridge.generation() - 1;
        bridge.event(frame("api:budget:result", id, payload));
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.m_pending[id].generation = bridge.generation();
        bridge.event(frame("api:budget:result", id, payload));
        QVERIFY(bridge.budgetState().value("live").toBool());
    }
    void budgetReadWrongFramesCannotBecomeAnotherControllersEvents() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        knownBudget(bridge);
        const auto settings = bridge.state().value("settings");
        const auto snapshot = bridge.budgetState().value("snapshot");
        const auto persona = bridge.m_persona;
        const int generation = bridge.generation();
        for (const auto &type : {"runtime:activity", "persona:scope", "settings:get:result", "diary:result", "error"}) {
            bridge.refreshBudget();
            const auto id = bridge.budgetState().value("requestId").toString();
            auto payload = budgetSnapshot(bridge);
            payload["epoch"] = 99;
            payload["fingerprint"] = "must-not-switch";
            payload["runtimeWritable"] = false;
            payload["writesBlocked"] = true;
            payload["ok"] = true;
            bridge.event(frame(type, id, payload));
            QCOMPARE(bridge.budgetState().value("status").toString(), QString("error"));
            QVERIFY(!bridge.budgetState().value("live").toBool());
            QCOMPARE(bridge.budgetState().value("snapshot"), snapshot);
            QCOMPARE(bridge.state().value("settings"), settings);
            QVERIFY(!bridge.state().contains("diary"));
            QCOMPARE(bridge.m_persona, persona);
            QCOMPARE(bridge.generation(), generation);
            QVERIFY(bridge.runtimeWritable());
            QVERIFY(!bridge.m_pending.contains(id));
        }
        bridge.refreshBudget();
        const auto superseded = bridge.budgetState().value("requestId").toString();
        bridge.refreshBudget();
        const auto current = bridge.budgetState();
        QVERIFY(!bridge.m_pending.contains(superseded));
        bridge.event(frame("runtime:activity", superseded, recovery("unknown", false)));
        QCOMPARE(bridge.budgetState(), current);
        QCOMPARE(bridge.state().value("settings"), settings);
        QCOMPARE(bridge.m_persona, persona);
        QCOMPARE(bridge.generation(), generation);
        QVERIFY(bridge.runtimeWritable());
        QVERIFY(bridge.m_pending.contains(current.value("requestId").toString()));
    }
    void budgetUsageRequiresStrictTypesWholeCountsLimitsAndDate() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        const auto saved = bridge.budgetState().value("snapshot");
        QList<QJsonObject> invalid;
        const auto valid = budgetSnapshot(bridge);
        for (const auto &[key, value] : QList<QPair<QString, QJsonValue>>{
                 {"ok", false}, {"ok", "true"}, {"error", "private ledger failure"},
                 {"error_code", "storage_failed"}, {"success", false}, {"unknown", true},
                 {"tracking_enabled", 0}, {"background_enforced", "false"},
                 {"requests", -1}, {"succeeded", 1.5}, {"failed", true},
                 {"prompt_tokens", "400"}, {"completion_tokens", QJsonValue(QJsonValue::Null)},
                 {"estimated_unreported_tokens", 9007199254740992.0},
                 {"local_day", "2026-02-30"}, {"local_day", "2026-1-2"}, {"local_day", 20261021},
                 {"by_purpose", QJsonObject{}}, {"background", QJsonValue(QJsonValue::Null)}}) {
            auto valueToReject = valid;
            valueToReject[key] = value;
            invalid << valueToReject;
        }
        for (const auto &[key, value] : QList<QPair<QString, QJsonValue>>{
                 {"requests", -1}, {"tokens", 10.5}, {"request_budget", 0},
                 {"request_budget", 10001}, {"request_budget", "60"},
                 {"token_budget", 999}, {"token_budget", 10000001}, {"token_budget", true}}) {
            auto valueToReject = valid;
            auto background = valid["background"].toObject();
            background[key] = value;
            valueToReject["background"] = background;
            invalid << valueToReject;
        }
        for (const auto &field : {"requests", "tracking_enabled", "local_day", "background", "by_purpose"}) {
            auto valueToReject = valid;
            valueToReject.remove(field);
            invalid << valueToReject;
        }
        auto invalidPurpose = valid;
        invalidPurpose["by_purpose"] = QJsonArray{QJsonObject{{"purpose", "summary"}, {"requests", "2"}, {"measured_tokens", 500}}};
        invalid << invalidPurpose;
        for (const auto &payload : invalid) {
            bridge.refreshBudget();
            const auto id = bridge.budgetState().value("requestId").toString();
            bridge.event(frame("api:budget:result", id, payload));
            QCOMPARE(bridge.budgetState().value("status").toString(), QString("error"));
            QVERIFY(bridge.budgetState().value("stale").toBool());
            QVERIFY(!bridge.budgetState().value("live").toBool());
            QCOMPARE(bridge.budgetState().value("snapshot"), saved);
            QCOMPARE(bridge.state().value("budget"), saved);
            QVERIFY(!bridge.budgetState().value("text").toString().contains("private"));
        }
        bridge.refreshBudget();
        auto explicitOk = valid;
        explicitOk["ok"] = true;
        bridge.event(frame("api:budget:result", bridge.budgetState().value("requestId").toString(), explicitOk));
        QVERIFY(bridge.budgetState().value("live").toBool());
    }
    void budgetUsageTimeoutKeepsTheOldSnapshotStaleAndRejectsLateData() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        const auto saved = bridge.budgetState().value("snapshot");
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(!bridge.budgetState().value("live").toBool());
        QCOMPARE(bridge.budgetState().value("snapshot"), saved);
        QSignalSpy failures(&bridge, &RuntimeBridge::requestFailed);
        bridge.expirePending(id);
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("error"));
        QVERIFY(bridge.budgetState().value("stale").toBool());
        QCOMPARE(bridge.budgetState().value("snapshot"), saved);
        QCOMPARE(failures.count(), 1);
        QCOMPARE(failures.at(0).at(1).toString(), QString("timeout"));
        const auto failed = bridge.budgetState();
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 0, 0)));
        QCOMPARE(bridge.budgetState(), failed);
        QCOMPARE(bridge.state().value("budget"), saved);
    }
    void budgetUsageTransportFailureAndDisconnectInvalidateReads() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        const auto saved = bridge.budgetState().value("snapshot");
        bridge.m_frameWriter = [](const QByteArray &) { return qint64(0); };
        bridge.refreshBudget();
        const auto unsent = bridge.budgetState().value("requestId").toString();
        QVERIFY(!unsent.isEmpty());
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("error"));
        QCOMPARE(bridge.budgetState().value("snapshot"), saved);
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 1);
        QVERIFY(!bridge.m_pending.contains(unsent));
        bridge.m_frameWriter = [](const QByteArray &bytes) { return bytes.size(); };
        bridge.refreshBudget();
        const auto interrupted = bridge.budgetState().value("requestId").toString();
        bridge.m_process.finished(1, QProcess::CrashExit);
        QVERIFY(!bridge.connected());
        QVERIFY(!bridge.budgetState().value("live").toBool());
        QVERIFY(bridge.budgetState().value("stale").toBool());
        QCOMPARE(bridge.budgetState().value("snapshot"), saved);
        QVERIFY(!bridge.m_pending.contains(interrupted));
        const auto disconnected = bridge.budgetState();
        bridge.event(frame("api:budget:result", interrupted, budgetSnapshot(bridge, 8)));
        bridge.event(frame("api:budget:result", unsent, budgetSnapshot(bridge, 9)));
        QCOMPARE(bridge.budgetState(), disconnected);
        bridge.refreshBudget();
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 2);
        QVERIFY(!bridge.budgetState().value("live").toBool());
    }
    void budgetUsageSamePersonaHandshakeRequiresANewLedgerRead() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        const auto saved = bridge.budgetState().value("snapshot");
        bridge.refreshBudget();
        const auto oldId = bridge.budgetState().value("requestId").toString();
        const auto oldPayload = budgetSnapshot(bridge, 14);
        const auto persona = bridge.m_persona;
        const int generation = bridge.generation();
        // Exercise a replacement ready frame even without the finished signal.
        bridge.m_connected = false;
        bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
            {"protocolVersion", 4}, {"pid", QJsonValue(bridge.m_process.processId())},
            {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(
                bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
            {"personaId", persona["persona_id"]}, {"personaEpoch", persona["epoch"]},
            {"personaFingerprint", persona["fingerprint"]}, {"recoveryState", "clean"},
            {"writesBlocked", false}, {"runtimeWritable", true}});
        QCOMPARE(bridge.generation(), generation + 1);
        QCOMPARE(bridge.m_persona, persona);
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QVERIFY(id != oldId);
        QVERIFY(!bridge.m_pending.contains(oldId));
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), 1);
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("pending"));
        QCOMPARE(bridge.budgetState().value("snapshot"), saved);
        const auto waiting = bridge.budgetState();
        bridge.event(frame("api:budget:result", oldId, oldPayload));
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 15)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        QCOMPARE(bridge.budgetState().value("snapshot").toMap().value("background").toMap().value("requests").toInt(), 15);
    }
    void budgetUsagePersonaChangeDropsTheOldScopeAndPendingRead() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBudget(bridge);
        bridge.refreshBudget();
        const auto oldId = bridge.budgetState().value("requestId").toString();
        const auto oldPayload = budgetSnapshot(bridge, 17);
        const auto oldScope = bridge.scopeKey();
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 4},
            {"fingerprint", "fingerprint-next"}}));
        QVERIFY(bridge.scopeKey() != oldScope);
        QVERIFY(!bridge.m_pending.contains(oldId));
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("pending"));
        QVERIFY(!bridge.budgetState().value("live").toBool());
        const auto id = bridge.budgetState().value("requestId").toString();
        const auto waiting = bridge.budgetState();
        bridge.event(frame("api:budget:result", oldId, oldPayload));
        bridge.event(frame("api:budget:result", id, oldPayload));
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 18)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        QCOMPARE(bridge.budgetState().value("scopeKey").toString(), bridge.scopeKey());
    }
    void budgetReadsRemainAvailableDuringModelPauseAndRecoveryReadOnly() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        bridge.m_networkFeedback = {{"status", "paused"}, {"known", true}, {"active", true}};
        bridge.m_offline = true;
        bridge.m_state["modelPause"] = true;
        bridge.m_runtimeWritable = false;
        bridge.m_recoveryState = "rescue_required";
        bridge.m_backupRestoring = true;
        bridge.refreshBudget();
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        QCOMPARE(commandCount(*frames, "api:budget:get"), 1);
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        QVERIFY(!bridge.runtimeWritable());
        bridge.m_personaSwitch = {{"requestId", "switch-pending"}};
        bridge.refreshBudget();
        QCOMPARE(commandCount(*frames, "api:budget:get"), 1);
        QVERIFY(!bridge.budgetState().value("live").toBool());
        QCOMPARE(bridge.budgetState().value("status").toString(), QString("error"));
    }
    void budgetSavingInvalidatesOldReadsAndRefreshesExactlyOnce() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        knownSettings(bridge, budgetSettingsSnapshot());
        knownBudget(bridge);
        bridge.refreshBudget();
        const auto oldId = bridge.budgetState().value("requestId").toString();
        const auto oldPayload = budgetSnapshot(bridge);
        const int before = commandCount(*frames, "api:budget:get");
        bridge.saveSettings("personality", {{"api_background_daily_request_budget", 120}});
        const auto saveId = settingsReceipt(bridge, "personality").value("requestId").toString();
        QVERIFY(!bridge.m_pending.contains(oldId));
        QVERIFY(!bridge.budgetState().value("live").toBool());
        bridge.event(frame("settings:update:result", saveId, {{"ok", true}}));
        QCOMPARE(commandCount(*frames, "api:budget:get"), before + 1);
        const auto id = bridge.budgetState().value("requestId").toString();
        QVERIFY(id != oldId);
        const auto waiting = bridge.budgetState();
        bridge.event(frame("api:budget:result", oldId, oldPayload));
        QCOMPARE(bridge.budgetState(), waiting);
        bridge.event(frame("api:budget:result", id, budgetSnapshot(bridge, 2, 900, 120)));
        QVERIFY(bridge.budgetState().value("live").toBool());
        bridge.event(frame("settings:get:result", settingsReceipt(bridge, "personality").value("readId").toString(),
            budgetSettingsSnapshot(true, true, 120)));
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("success"));
        QCOMPARE(commandCount(*frames, "api:budget:get"), before + 1);
        QCOMPARE(bridge.budgetState().value("readDispatchCount").toInt(), before + 1);
    }
    void lostSettingsReceiptsBecomeUnknownAndAreReadBack() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownSettings(bridge);
        bridge.saveSettings("chat", {{"split_messages", true}});
        bridge.expirePending(controlId(bridge, "settings:update"));
        QCOMPARE(settingsReceipt(bridge, "chat").value("status").toString(), QString("unknown"));
        QCOMPARE(settingsReceipt(bridge, "chat").value("text").toString(), QString("保存结果未确认，已重新读取当前设置。"));
        QCOMPARE(pendingCount(bridge, "settings:get"), 1);

        knownSettings(bridge);
        bridge.saveSettings("memory", {{"forgetting_enabled", false}});
        const auto memoryId = controlId(bridge, "settings:update");
        bridge.event(frame("persona:scope", "", {{"persona_id", "persona-next"}, {"epoch", 4},
                                                  {"fingerprint", "fingerprint-next"}}));
        QCOMPARE(settingsReceipt(bridge, "memory").value("status").toString(), QString("unknown"));
        QCOMPARE(settingsReceipt(bridge, "memory").value("text").toString(),
                 QString("人格已切换，设置保存结果未确认；已重新读取当前设置。"));
        QCOMPARE(settingsReceipt(bridge, "memory").value("requestId").toString(), memoryId);
        QVERIFY(!bridge.m_pending.contains(memoryId));
        QVERIFY(!bridge.settingsKnown());
        QCOMPARE(pendingCount(bridge, "settings:get"), 1);

        knownSettings(bridge);
        bridge.saveSettings("personality", {{"personality_flaws_enabled", false}});
        const auto lostId = controlId(bridge, "settings:update");
        const int readsBefore = pendingCount(bridge, "settings:get");
        bridge.m_connected = false;
        bridge.expirePending(lostId);
        QCOMPARE(settingsReceipt(bridge, "personality").value("status").toString(), QString("unknown"));
        QCOMPARE(settingsReceipt(bridge, "personality").value("text").toString(),
                 QString("连接中断，保存结果未确认；重新连接后会重新读取当前设置。"));
        QCOMPARE(pendingCount(bridge, "settings:get"), readsBefore);
    }
    void summaryPendingCarriesTheRequestedValue() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.setSummaryEnabled(true);
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), QString("pending"));
        QCOMPARE(memoryReceipt(bridge, "summary").value("enabled"), QVariant(true));
        // A saved value is still shown until the status read that follows it returns.
        bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"), {{"ok", true}}));
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), QString("success"));
        QCOMPARE(memoryReceipt(bridge, "summary").value("enabled"), QVariant(true));
        bridge.event(frame("summary:result", controlId(bridge, "summary:status"),
                           {{"ok", true}, {"status", "idle"}, {"enabled", true}}));
        QVERIFY(!memoryReceipt(bridge, "summary").contains("enabled"));
        QVERIFY(bridge.state().value("summary").toMap().value("enabled").toBool());
        // A rejected save drops the requested value at once.
        bridge.setSummaryEnabled(false);
        bridge.event(frame("settings:update:result", controlId(bridge, "settings:update"),
                           {{"ok", false}, {"error", "Settings are not initialized"}}));
        QCOMPARE(memoryReceipt(bridge, "summary").value("status").toString(), QString("error"));
        QVERIFY(!memoryReceipt(bridge, "summary").contains("enabled"));
    }
    void memoryAdjustmentDedicatedMethodUsesExactPayload_data() {
        QTest::addColumn<QString>("op");
        for (const auto &op : QStringList{"strengthen", "weaken", "reactivate"})
            QTest::newRow(qPrintable(op)) << op;
    }
    void memoryAdjustmentDedicatedMethodUsesExactPayload() {
        QFETCH(QString, op);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const QVariantMap payload{{"memory_id", "memory-1"}, {"op", op}};
        const int before = frames->size();
        QVERIFY(bridge.request("memory:reinforce", payload).isEmpty());
        auto forged = payload;
        forged.insert("adjustment_authorized", true);
        QVERIFY(bridge.request("memory:reinforce", forged).isEmpty());
        QCOMPARE(frames->size(), before);
        bool reentrantDenied = false;
        const auto writer = bridge.m_frameWriter;
        bridge.m_frameWriter = [&](const QByteArray &bytes) {
            reentrantDenied = bridge.m_memoryAdjustDispatch.isEmpty();
            if (reentrantDenied)
                reentrantDenied = bridge.request("memory:reinforce", payload).isEmpty();
            return writer(bytes);
        };
        bridge.adjustMemory("memory-1", op);
        bridge.m_frameWriter = writer;
        QCOMPARE(frames->size(), before + 1);
        QVERIFY(reentrantDenied);
        auto sent = lastCommand(*frames, "memory:reinforce");
        QVERIFY(!sent.take("requestId").toString().isEmpty());
        QCOMPARE(sent, QJsonObject::fromVariantMap(payload));
        QVERIFY(bridge.m_memoryAdjustDispatch.isEmpty());
        const auto receipt = memoryReceipt(bridge, "action");
        QCOMPARE(receipt.value("status").toString(), QString("pending"));
        QCOMPARE(receipt.value("subjectId").toString(), QString("memory-1"));
        QCOMPARE(receipt.value("op").toString(), op);
        QCOMPARE(receipt.value("generation").toInt(), bridge.generation());
        QCOMPARE(receipt.value("scopeKey").toString(), bridge.scopeKey());
        QVERIFY(bridge.request("memory:reinforce", payload).isEmpty());
        QCOMPARE(frames->size(), before + 1);
    }
    void memoryAdjustmentReadinessRejectsWithoutDispatch_data() {
        QTest::addColumn<QString>("blocker");
        for (const auto &blocker : QStringList{"disconnected", "readonly", "missing-id", "duplicate-id",
                 "invalid-id", "invalid-op", "action", "direct-single", "candidate-decision", "persona", "stopping"})
            QTest::newRow(qPrintable(blocker)) << blocker;
        for (const auto &kind : QStringList{"delete", "pin", "candidate"})
            for (const auto &phase : QStringList{"sending", "pending", "unknown"})
                QTest::newRow(qPrintable(kind + "-" + phase)) << kind + ":" + phase;
        for (const auto &kind : QStringList{"pin", "candidate"})
            for (const auto &phase : QStringList{"previewing", "ready", "reading"})
                QTest::newRow(qPrintable(kind + "-" + phase)) << kind + ":" + phase;
    }
    void memoryAdjustmentReadinessRejectsWithoutDispatch() {
        QFETCH(QString, blocker);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        QString id = "memory-1", op = "strengthen";
        if (blocker == "disconnected") bridge.m_connected = false;
        else if (blocker == "readonly") bridge.m_runtimeWritable = false;
        else if (blocker == "missing-id") id = "not-shown";
        else if (blocker == "invalid-id") id = "../memory-1";
        else if (blocker == "invalid-op") op = "pin";
        else if (blocker == "duplicate-id") {
            auto memory = bridge.m_state.value("memory").toMap();
            auto rows = memory.value("memories").toList();
            rows.append(rows.first());
            memory["memories"] = rows;
            bridge.m_state["memory"] = memory;
        } else if (blocker == "action")
            bridge.setMemoryPinned(id, true);
        else if (blocker == "direct-single")
            QVERIFY(!bridge.request("memory:edit", {{"memory_id", id}, {"text", "another write"}}).isEmpty());
        else if (blocker == "candidate-decision") bridge.m_candidateDecision = {{"status", "reading"}};
        else if (blocker == "persona") bridge.m_personaSwitch = {{"requestId", "switch-pending"}};
        else if (blocker == "stopping") bridge.m_stopping = true;
        else if (blocker.startsWith("delete:")) bridge.m_memoryBatchDelete = {{"status", blocker.section(':', 1)}};
        else if (blocker.startsWith("pin:")) bridge.m_memoryBatchPin = {{"status", blocker.section(':', 1)}};
        else if (blocker.startsWith("candidate:")) bridge.m_candidateBatch = {{"status", blocker.section(':', 1)}};
        const int before = frames->size();
        const auto action = memoryReceipt(bridge, "action");
        bridge.adjustMemory(id, op);
        QCOMPARE(frames->size(), before);
        QVERIFY(bridge.m_memoryAdjustDispatch.isEmpty());
        if (!action.isEmpty()) QCOMPARE(memoryReceipt(bridge, "action"), action);
    }
    void memoryAdjustmentDispatchCapabilityBindsEveryField_data() {
        QTest::addColumn<QString>("mismatch");
        for (const auto &field : QStringList{"memoryId", "op", "generation", "scopeKey", "extra-payload"})
            QTest::newRow(qPrintable(field)) << field;
    }
    void memoryAdjustmentDispatchCapabilityBindsEveryField() {
        QFETCH(QString, mismatch);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.m_memoryAdjustDispatch = {{"memoryId", "memory-1"}, {"op", "strengthen"},
            {"generation", bridge.generation()}, {"scopeKey", bridge.scopeKey()}};
        QVariantMap payload{{"memory_id", "memory-1"}, {"op", "strengthen"}};
        if (mismatch == "generation") bridge.m_memoryAdjustDispatch[mismatch] = bridge.generation() - 1;
        else if (mismatch == "extra-payload") payload["amount"] = 0.1;
        else bridge.m_memoryAdjustDispatch[mismatch] = "different";
        QVERIFY(bridge.request("memory:reinforce", payload).isEmpty());
        QVERIFY(frames->isEmpty());
    }
    void memoryAdjustmentReceiptsDescribeChangesAndReadBothLists_data() {
        QTest::addColumn<QString>("op");
        QTest::addColumn<QJsonObject>("payload");
        QTest::addColumn<QString>("text");
        QTest::addColumn<bool>("success");
        const auto receipt = [](const QString &op, double before, double after, bool changed) {
            return QJsonObject{{"ok", true}, {"memory_id", "memory-1"}, {"op", op}, {"changed", changed},
                {"importance_before", before}, {"importance_after", after}};
        };
        QTest::newRow("strengthen") << QString("strengthen") << receipt("strengthen", .5, .6, true)
            << QString("已强化：重要度 0.5 → 0.6。") << true;
        QTest::newRow("rounded-display") << QString("strengthen") << receipt("strengthen", .125, .225, true)
            << QString("已强化：重要度 0.13 → 0.23。") << true;
        QTest::newRow("weaken") << QString("weaken") << receipt("weaken", .1, 0, true)
            << QString("已弱化：重要度 0.1 → 0。") << true;
        QTest::newRow("highest") << QString("strengthen") << receipt("strengthen", 1, 1, false)
            << QString("已是最高，未改动。") << true;
        QTest::newRow("lowest") << QString("weaken") << receipt("weaken", 0, 0, false)
            << QString("已是最低，未改动。") << true;
        QTest::newRow("reactivate") << QString("reactivate") << receipt("reactivate", .5, .65, true)
            << QString("已重温：按刚回想处理，重要度 0.5 → 0.65。") << true;
        QTest::newRow("reactivate-at-cap") << QString("reactivate") << receipt("reactivate", 1, 1, true)
            << QString("已重温：按刚回想处理，重要度 1 → 1。") << true;
        QTest::newRow("not-adjustable") << QString("strengthen")
            << QJsonObject{{"ok", false}, {"error_code", "memory_not_adjustable"}, {"error", "unavailable"}}
            << QString("这条记忆当前不能调整，记忆没有改动；可刷新列表后核对。") << false;
        for (const auto &op : QStringList{"strengthen", "weaken", "reactivate"}) {
            const auto verb = op == "strengthen" ? QString("强化") : op == "weaken" ? QString("弱化") : QString("重温");
            QTest::newRow(qPrintable("error-" + op)) << op << QJsonObject{{"ok", false}, {"error", "internal"}}
                << verb + "未完成，记忆没有改动；可刷新后核对。" << false;
        }
    }
    void memoryAdjustmentReceiptsDescribeChangesAndReadBothLists() {
        QFETCH(QString, op); QFETCH(QJsonObject, payload); QFETCH(QString, text); QFETCH(bool, success);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        const auto shown = bridge.state().value("memory");
        bridge.adjustMemory("memory-1", op);
        const auto id = controlId(bridge, "memory:reinforce");
        QVERIFY(!id.isEmpty());
        bridge.event(frame("memory:result", id, payload));
        const auto action = memoryReceipt(bridge, "action");
        QCOMPARE(action.value("status").toString(), success ? QString("success") : QString("error"));
        QCOMPARE(action.value("text").toString(), text);
        QCOMPARE(action.value("subjectId").toString(), QString("memory-1"));
        QCOMPARE(action.value("op").toString(), op);
        QCOMPARE(bridge.state().value("memory"), shown);
        QCOMPARE(pendingCount(bridge, "memory:list"), success ? 1 : 0);
        QCOMPARE(pendingCount(bridge, "memory:candidates:list"), success ? 1 : 0);
        if (success) {
            QCOMPARE(action.value("changed").toBool(), payload["changed"].toBool());
            QCOMPARE(action.value("importanceBefore").toDouble(), payload["importance_before"].toDouble());
            QCOMPARE(action.value("importanceAfter").toDouble(), payload["importance_after"].toDouble());
        } else {
            QVERIFY(!action.contains("importanceBefore"));
            QVERIFY(!action.contains("importanceAfter"));
        }
        const int before = frames->size();
        bridge.event(frame("memory:result", id, payload));
        QCOMPARE(frames->size(), before);
        QCOMPARE(memoryReceipt(bridge, "action"), action);
    }
    void memoryAdjustmentMalformedReceiptsNeverSucceed_data() {
        QTest::addColumn<QString>("fault");
        for (const auto &field : QStringList{"ok", "memory_id", "op", "changed", "importance_before", "importance_after"})
            QTest::newRow(qPrintable("missing-" + field)) << "missing:" + field;
        for (const auto &fault : QStringList{"wrong-id", "wrong-op", "string-before", "bool-after", "before-low",
                 "before-high", "after-low", "after-high", "null-before", "nan-before", "infinite-after", "string-changed", "string-ok",
                 "error-code", "code", "wrong-direction", "false-change", "wrong-type"})
            QTest::newRow(qPrintable(fault)) << fault;
    }
    void memoryAdjustmentMalformedReceiptsNeverSucceed() {
        QFETCH(QString, fault);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        knownBatchMemories(bridge);
        bridge.adjustMemory("memory-1", "strengthen");
        QJsonObject payload{{"ok", true}, {"memory_id", "memory-1"}, {"op", "strengthen"},
            {"changed", true}, {"importance_before", .5}, {"importance_after", .6}};
        if (fault.startsWith("missing:")) payload.remove(fault.section(':', 1));
        else if (fault == "wrong-id") payload["memory_id"] = "memory-2";
        else if (fault == "wrong-op") payload["op"] = "weaken";
        else if (fault == "string-before") payload["importance_before"] = "0.5";
        else if (fault == "bool-after") payload["importance_after"] = true;
        else if (fault == "before-low") payload["importance_before"] = -.01;
        else if (fault == "before-high") payload["importance_before"] = 1.01;
        else if (fault == "after-low") payload["importance_after"] = -.01;
        else if (fault == "after-high") payload["importance_after"] = 1.01;
        else if (fault == "null-before") payload["importance_before"] = QJsonValue::Null;
        else if (fault == "nan-before") payload["importance_before"] = std::nan("");
        else if (fault == "infinite-after") payload["importance_after"] = HUGE_VAL;
        else if (fault == "string-changed") payload["changed"] = "true";
        else if (fault == "string-ok") payload["ok"] = "true";
        else if (fault == "error-code") payload["error_code"] = "unexpected";
        else if (fault == "code") payload["code"] = "unexpected";
        else if (fault == "wrong-direction") payload["importance_after"] = .4;
        else if (fault == "false-change") payload["changed"] = false;
        bridge.event(frame(fault == "wrong-type" ? "memory:candidates:result" : "memory:result",
            controlId(bridge, "memory:reinforce"), payload));
        QCOMPARE(memoryReceipt(bridge, "action").value("status").toString(), QString("error"));
        QCOMPARE(memoryReceipt(bridge, "action").value("text").toString(),
            QString("强化未完成，记忆没有改动；可刷新后核对。"));
        QCOMPARE(pendingCount(bridge, "memory:list"), 0);
        QCOMPARE(pendingCount(bridge, "memory:candidates:list"), 0);
    }
    void memoryAdjustmentUnknownAndStaleReceiptsNeverRetry_data() {
        QTest::addColumn<QString>("cause");
        for (const auto &cause : QStringList{"timeout", "disconnect", "generation", "scope", "foreign-payload"})
            QTest::newRow(qPrintable(cause)) << cause;
    }
    void memoryAdjustmentUnknownAndStaleReceiptsNeverRetry() {
        QFETCH(QString, cause);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        bridge.adjustMemory("memory-1", "reactivate");
        const auto id = controlId(bridge, "memory:reinforce");
        QJsonObject payload{{"ok", true}, {"memory_id", "memory-1"}, {"op", "reactivate"},
            {"changed", true}, {"importance_before", .5}, {"importance_after", .65}};
        if (cause == "timeout") bridge.expirePending(id);
        else if (cause == "disconnect") bridge.m_process.finished(1, QProcess::CrashExit);
        else if (cause == "generation") ++bridge.m_generation;
        else if (cause == "scope") bridge.m_persona["fingerprint"] = "changed-fingerprint";
        else payload["persona_fingerprint"] = "foreign-fingerprint";
        const auto action = memoryReceipt(bridge, "action");
        const auto state = bridge.state();
        const int before = frames->size();
        bridge.event(frame("memory:result", id, payload));
        QCOMPARE(memoryReceipt(bridge, "action"), action);
        QCOMPARE(bridge.state(), state);
        QCOMPARE(frames->size(), before);
        QCOMPARE(commandCount(*frames, "memory:reinforce"), 1);
        QCOMPARE(pendingCount(bridge, "memory:list"), 0);
        QCOMPARE(pendingCount(bridge, "memory:candidates:list"), 0);
        if (cause == "timeout" || cause == "disconnect") {
            QCOMPARE(action.value("status").toString(), QString("unknown"));
            QCOMPARE(action.value("text").toString(), QString("操作未收到确认；结果未知，请刷新后核对。"));
        }
    }
    void memoryAdjustmentLocksEveryOtherMemoryWrite() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        knownBatchMemories(bridge);
        bridge.adjustMemory("memory-1", "strengthen");
        const auto action = memoryReceipt(bridge, "action");
        const int before = frames->size();
        bridge.adjustMemory("memory-2", "weaken");
        bridge.setMemoryPinned("memory-1", true);
        bridge.editMemory("memory-1", "another draft");
        bridge.editMemory("memory-1", "   ");
        bridge.deleteMemory("memory-1");
        bridge.deleteMemories({QString("memory-1")});
        bridge.previewMemoryPins({QString("memory-1")}, true);
        bridge.decideMemoryCandidate(candidateId(1), true);
        bridge.previewCandidateDecisions({candidateId(1)}, true);
        for (const auto &command : QStringList{"memory:edit", "memory:delete", "memory:delete_many", "memory:pin_many",
                 "memory:reinforce", "memory:candidates:confirm", "memory:candidates:reject", "memory:candidates:decide_many"})
            QVERIFY(bridge.request(command, {{"memory_id", "memory-1"}, {"op", "pin"}}).isEmpty());
        QCOMPARE(frames->size(), before);
        QCOMPARE(memoryReceipt(bridge, "action"), action);
    }
    void cardExportDispatchAndReceipt_data() {
        QTest::addColumn<QString>("outcome");
        for (const auto &outcome : QStringList{"book", "none", "rejected", "card_not_importable",
                 "missing_file_name", "missing_bytes", "missing_sha256", "missing_world_book_id",
                 "missing_world_book_name", "missing_entry_count", "missing_persona_id", "invalid_ok",
                 "wrong_persona", "wrong_book", "wrong_name", "wrong_count", "no_file", "size", "hash",
                 "symlink", "timeout", "disconnect", "generation", "scope", "not_sent"})
            QTest::newRow(qPrintable(outcome)) << outcome;
    }
    void cardExportDispatchAndReceipt() {
        QFETCH(QString, outcome);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_persona["persona_id"] = "st_a";
        auto frames = sentFrames(bridge);
        personaList(bridge, "st_a");
        auto archive = personaScope(bridge);
        archive.insert("ok", true); archive.insert("revision", 4);
        archive.insert("archive", QJsonObject{{"worldBooks", QJsonArray{QJsonObject{
            {"id", "book-main"}, {"name", "测试角色的世界书"}, {"entries", QJsonArray{QJsonObject{{"id", "entry-1"}}}}}}}});
        bridge.event(frame("archive:result", bridge.request("archive:get"), archive));
        QVERIFY(bridge.personaCardExportAvailable());
        const auto path = data.filePath("export.json");
        const bool noBook = outcome == "none";
        if (outcome == "not_sent")
            bridge.m_frameWriter = [](const QByteArray &) { return qint64(-1); };
        bridge.exportPersonaCard(QUrl::fromLocalFile(path), noBook ? QString() : "book-main");
        if (outcome == "not_sent") {
            QCOMPARE(bridge.personaCardExportState().value("status").toString(), QString("error"));
            QVERIFY(bridge.personaCardExportState().value("text").toString().contains("没有写出文件"));
            QVERIFY(!QFile::exists(path));
            return;
        }
        const auto sent = lastControl(*frames, "persona:card:export");
        QVERIFY(!sent.isEmpty());
        const auto id = sent["requestId"].toString();
        auto fields = sent;
        for (const auto &key : {"kind", "schema", "requestId", "type"}) fields.remove(key);
        QCOMPARE(fields, (QJsonObject{{"path", path},
            {"world_book_id", noBook ? QJsonValue(QJsonValue::Null) : QJsonValue("book-main")},
            {"persona_id", "st_a"}, {"persona_epoch", 3}, {"persona_fingerprint", "fingerprint-current"},
            {"archive_revision", 4}}));
        QCOMPARE(controlCount(*frames, "persona:card:export"), 1);
        QCOMPARE(commandCount(*frames, "persona:card:export"), 0);
        QVERIFY(bridge.request("persona:card:export", fields.toVariantMap()).isEmpty());
        const QByteArray contents("isolated card receipt fixture\n");
        if (!QStringList{"rejected", "card_not_importable", "no_file"}.contains(outcome)) {
            QFile file(path); QVERIFY(file.open(QIODevice::WriteOnly));
            QCOMPARE(file.write(contents), contents.size()); file.close();
        }
        QJsonObject receipt{{"ok", true}, {"file_name", "export.json"}, {"bytes", contents.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(contents, QCryptographicHash::Sha256).toHex())},
            {"world_book_id", noBook ? QJsonValue(QJsonValue::Null) : QJsonValue("book-main")},
            {"world_book_name", noBook ? "" : "测试角色的世界书"},
            {"entry_count", noBook ? 0 : 1}, {"persona_id", "st_a"}};
        if (outcome == "rejected" || outcome == "card_not_importable")
            receipt = {{"ok", false}, {"code", outcome == "rejected" ? "archive_changed" : "card_not_importable"},
                {"import_code", "unsafe_instruction"}, {"error", "导入规则的具体说明"}};
        else if (outcome.startsWith("missing_")) receipt.remove(outcome.mid(8));
        else if (outcome == "invalid_ok") receipt["ok"] = "true";
        else if (outcome == "wrong_persona") receipt["persona_id"] = "st_other";
        else if (outcome == "wrong_book") receipt["world_book_id"] = QJsonValue::Null;
        else if (outcome == "wrong_name") receipt["world_book_name"] = "另一世界书";
        else if (outcome == "wrong_count") receipt["entry_count"] = 2;
        else if (outcome == "size") receipt["bytes"] = contents.size() + 1;
        else if (outcome == "hash") receipt["sha256"] = QString(64, '0');
        else if (outcome == "symlink") {
            QVERIFY(QFile::rename(path, data.filePath("real.json")));
            QVERIFY(QFile::link(data.filePath("real.json"), path));
        } else if (outcome == "timeout" || outcome == "disconnect") {
            if (outcome == "disconnect") bridge.m_connected = false;
            bridge.expirePending(id);
        } else if (outcome == "generation") ++bridge.m_generation;
        else if (outcome == "scope")
            bridge.event(frame("persona:scope", {}, {{"persona_id", "st_other"}, {"epoch", 4}, {"fingerprint", "other"}}));
        const int beforeReceipt = frames->size();
        bridge.acceptFrame(controlResult(id, "persona:card:export", receipt));
        const auto state = bridge.personaCardExportState();
        const bool success = outcome == "book" || noBook;
        const bool rejected = outcome == "rejected" || outcome == "card_not_importable";
        QCOMPARE(state.value("status").toString(), success ? QString("success") : rejected ? QString("error") : QString("unknown"));
        if (success) {
            QCOMPARE(state.value("requestId").toString(), id);
            QCOMPARE(state.value("sha256").toString(), receipt["sha256"].toString());
            QCOMPARE(state.value("bytes").toLongLong(), qint64(contents.size()));
            QVERIFY(state.value("text").toString().contains(noBook ? "未嵌入世界书" : "含世界书《测试角色的世界书》1 条"));
        } else if (rejected) {
            QVERIFY(state.value("text").toString().contains("没有写出文件"));
            QVERIFY(state.value("text").toString().contains("导入规则的具体说明"));
            if (outcome == "card_not_importable")
                QVERIFY(state.value("text").toString().contains("按现有导入规则不能读回"));
            QVERIFY(!QFile::exists(path));
        } else QCOMPARE(state.value("text").toString(), QString("导出结果未知，请检查目标文件。"));
        bridge.acceptFrame(controlResult(id, "persona:card:export", receipt));
        QCOMPARE(bridge.personaCardExportState(), state);
        QCOMPARE(frames->size(), beforeReceipt);
        QCOMPARE(controlCount(*frames, "persona:card:export"), 1);
    }
    void cardExportAvailabilityDefaultsAndFilename_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"ready", "builtin", "disconnected", "readonly", "busy",
                 "import", "switch", "restore", "export", "old-archive", "old-profiles", "no-default", "bad-path", "bad-book",
                 "backup-inspect", "backup-export"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void cardExportAvailabilityDefaultsAndFilename() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_persona["persona_id"] = condition == "builtin" ? "default" : "st_a";
        auto frames = sentFrames(bridge);
        personaList(bridge, bridge.m_persona["persona_id"].toString());
        auto archive = personaScope(bridge);
        archive.insert("ok", true); archive.insert("revision", 4);
        archive.insert("archive", QJsonObject{{"worldBooks", QJsonArray{
            QJsonObject{{"id", "other"}, {"name", "其他书"}, {"entries", QJsonArray{}}},
            QJsonObject{{"id", "main"}, {"name", condition == "no-default" ? "不匹配" : "测试角色的世界书"}, {"entries", QJsonArray{}}}}}});
        bridge.event(frame("archive:result", bridge.request("archive:get"), archive));
        QCOMPARE(bridge.personaCardExportBooks().first().toMap().value("name").toString(), QString("不嵌入"));
        QCOMPARE(bridge.personaCardExportDefaultBookId(), condition == "no-default" || condition == "builtin" ? QString() : QString("main"));
        if (condition == "builtin") QVERIFY(bridge.personaCardExportBuiltin());
        if (condition == "disconnected") bridge.m_connected = false;
        else if (condition == "readonly") bridge.m_runtimeWritable = false;
        else if (condition == "busy") bridge.m_busy = true;
        else if (condition == "import") bridge.m_personaImport = {{"requestId", "import-locked"}};
        else if (condition == "switch") bridge.m_personaSwitch = {{"requestId", "switch-locked"}};
        else if (condition == "restore") bridge.m_backupRestoring = true;
        else if (condition == "export") bridge.m_personaCardExportState = {{"status", "pending"}, {"requestId", "export-locked"}};
        else if (condition == "old-archive") --bridge.m_personaCardExportArchiveGeneration;
        else if (condition == "old-profiles") --bridge.m_personaCardExportProfilesGeneration;
        else if (condition == "backup-inspect" || condition == "backup-export")
            bridge.setMemoryFeedback("backup", "pending", "独立备份操作正在等待回执", condition);
        const bool available = QStringList{"ready", "busy", "no-default", "bad-path", "bad-book", "backup-inspect", "backup-export"}.contains(condition);
        QCOMPARE(bridge.personaCardExportAvailable(), available);
        const auto target = condition == "bad-path" ? QUrl::fromLocalFile(data.filePath("card.txt")) : QUrl::fromLocalFile(data.filePath("card.json"));
        bridge.exportPersonaCard(target, condition == "bad-book" ? "missing" : "");
        QCOMPARE(controlCount(*frames, "persona:card:export"), (QStringList{"ready", "busy", "no-default", "backup-inspect", "backup-export"}.contains(condition) ? 1 : 0));
        auto list = bridge.m_state.value("personas").toMap();
        auto profiles = list.value("profiles").toList();
        for (auto &value : profiles) {
            auto profile = value.toMap();
            if (profile.value("active").toBool()) profile["name"] = "a/b:c\\d?*<>|\"";
            value = profile;
        }
        list["profiles"] = profiles; bridge.m_state["personas"] = list;
        bridge.m_personaCardExportProfilesGeneration = bridge.m_generation;
        const auto suggested = QFileInfo(bridge.suggestedPersonaCardFile().toLocalFile()).fileName();
        QCOMPARE(suggested, QString("a_b_c_d______-SillyTavern角色卡.json"));
    }
    void cardExportPendingBlocksImportSwitchAndRestore() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        personaList(bridge, "default");
        bridge.m_personaCardExportState = {{"status", "pending"}, {"requestId", "export-locked"}};
        bridge.m_personaCardJson = QString::fromUtf8(cardJson());
        bridge.m_personaCardCandidate = {{"filename", "card.json"}, {"scopeKey", bridge.scopeKey()}};
        const auto candidate = bridge.personaCardCandidate();
        const auto before = frames->size();
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("missing.json")));
        bridge.importPersonaCard();
        bridge.selectPersona("st_a");
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(data.filePath("missing.json")));
        bridge.chooseBackupForRescue(QUrl::fromLocalFile(data.filePath("missing.json")));
        bridge.confirmBackupRestore();
        QVERIFY(bridge.request("persona:activate", {{"profile_id", "st_a"}}).isEmpty());
        QVERIFY(bridge.request("persona:import", {{"json", bridge.m_personaCardJson}, {"filename", "card.json"},
            {"identity_change_confirmed", true}, {"actor", "owner"}}).isEmpty());
        QCOMPARE(frames->size(), before);
        QCOMPARE(bridge.personaCardCandidate(), candidate);
        QVERIFY(!bridge.backupRestoring());
    }
    void cardExportPendingAllowsBackupInspectionAndBackupExport() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        auto frames = sentFrames(bridge);
        bridge.m_personaCardExportState = {{"status", "pending"}, {"requestId", "export-locked"}};
        const auto source = data.filePath("inspect.json");
        QFile file(source); QVERIFY(file.open(QIODevice::WriteOnly));
        QCOMPARE(file.write("{}\n"), qint64(3)); file.close();
        bridge.chooseBackupForRestore(QUrl::fromLocalFile(source));
        QCOMPARE(controlCount(*frames, "backup:file:inspect"), 1);
        const auto inspection = lastControl(*frames, "backup:file:inspect")["requestId"].toString();
        bridge.acceptFrame(controlResult(inspection, "backup:file:inspect", {{"ok", false}, {"code", "fixture_rejection"}}));
        bridge.exportBackup(QUrl::fromLocalFile(data.filePath("backup.json")));
        QCOMPARE(controlCount(*frames, "backup:file:export"), 1);
        QCOMPARE(bridge.personaCardExportState().value("status").toString(), QString("pending"));
        QVERIFY(!bridge.backupRestoring());
    }
    void cardExportBuiltinAliasRequiresConfirmedScope_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"canonical-builtin", "canonical-builtin-legacy", "imported",
                 "missing-scope", "wrong-id", "wrong-epoch", "wrong-fingerprint", "stale-generation",
                 "rejected", "inactive", "invalid-active", "wrong-active-id", "duplicate-active", "imported-alias", "scope-changed"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void cardExportBuiltinAliasRequiresConfirmedScope() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const bool imported = condition == "imported" || condition == "imported-alias";
        bridge.m_persona["persona_id"] = imported ? "st_a" : "builtin_hoshino_yumetsuki";
        const auto profileId = imported ? (condition == "imported-alias" ? "st_other" : "st_a") : "default";
        QJsonObject profile{{"id", profileId}, {"name", "已确认的当前人格"}, {"active", true},
            {"source_format", imported ? "chara_card_v2" : condition == "canonical-builtin-legacy" ? "builtin_legacy" : "builtin"}};
        if (condition == "inactive") profile["active"] = false;
        if (condition == "invalid-active") profile["active"] = "true";
        auto snapshot = personaScope(bridge);
        snapshot["ok"] = condition != "rejected";
        snapshot["active_id"] = condition == "wrong-active-id" ? "missing" : profileId;
        snapshot["profiles"] = condition == "duplicate-active" ? QJsonArray{profile, profile} : QJsonArray{profile};
        if (condition == "missing-scope") snapshot.remove("persona_id");
        if (condition == "wrong-id") snapshot["persona_id"] = "builtin_other";
        if (condition == "wrong-epoch") snapshot["persona_epoch"] = 2;
        if (condition == "wrong-fingerprint") snapshot["persona_fingerprint"] = "previous-fingerprint";
        bridge.event(frame("persona:list:result", bridge.request("persona:list"), snapshot));
        if (condition == "stale-generation") ++bridge.m_generation;
        if (condition == "scope-changed") bridge.m_persona["epoch"] = 4;
        const bool confirmed = condition == "canonical-builtin" || condition == "canonical-builtin-legacy" || condition == "imported";
        QCOMPARE(!bridge.personaCardExportProfile().isEmpty(), confirmed);
        QCOMPARE(bridge.personaCardExportBuiltin(), confirmed && !imported);
        if (confirmed) {
            QCOMPARE(bridge.personaCardExportProfile().value("id").toString(), QString::fromLatin1(profileId));
            QCOMPARE(bridge.personaCardExportProfile().value("name").toString(), QString("已确认的当前人格"));
        }
        if (!imported) QVERIFY(!bridge.personaCardExportAvailable());
        const auto before = bridge.m_pending.size();
        bridge.exportPersonaCard(QUrl::fromLocalFile(data.filePath("card.json")), "");
        QCOMPARE(bridge.m_pending.size(), before);
        QVERIFY(!QFile::exists(data.filePath("card.json")));
    }
    void cardExportConfirmedEmptyArchive_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"authoritative-empty", "missing-archive", "positive-revision",
                 "exists-true", "missing-exists", "invalid-exists", "failed", "stale-generation", "stale-scope", "foreign-response"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void cardExportConfirmedEmptyArchive() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        bridge.m_persona["persona_id"] = "st_a";
        auto frames = sentFrames(bridge);
        personaList(bridge, "st_a");
        auto snapshot = personaScope(bridge);
        snapshot["ok"] = condition != "failed";
        snapshot["exists"] = false;
        snapshot["revision"] = 0;
        snapshot["archive"] = QJsonValue::Null;
        if (condition == "missing-archive") snapshot.remove("archive");
        if (condition == "positive-revision") snapshot["revision"] = 1;
        if (condition == "exists-true") snapshot["exists"] = true;
        if (condition == "missing-exists") snapshot.remove("exists");
        if (condition == "invalid-exists") snapshot["exists"] = "false";
        if (condition == "foreign-response") snapshot["persona_fingerprint"] = "other";
        bridge.event(frame("archive:result", bridge.request("archive:get"), snapshot));
        if (condition == "stale-generation") ++bridge.m_generation;
        if (condition == "stale-scope") bridge.m_persona["fingerprint"] = "later";
        const bool confirmed = condition == "authoritative-empty";
        QCOMPARE(bridge.personaCardExportArchiveKnown(), confirmed);
        QCOMPARE(bridge.personaCardExportAvailable(), confirmed);
        QCOMPARE(bridge.personaCardExportBooks(), (QVariantList{QVariantMap{{"id", ""}, {"name", "不嵌入"}}}));
        QCOMPARE(bridge.personaCardExportDefaultBookId(), QString());
        const auto path = data.filePath("empty-card.json");
        bridge.exportPersonaCard(QUrl::fromLocalFile(path), "");
        QCOMPARE(controlCount(*frames, "persona:card:export"), confirmed ? 1 : 0);
        if (confirmed) {
            const auto sent = lastControl(*frames, "persona:card:export");
            QCOMPARE(sent["archive_revision"], QJsonValue(0));
            QVERIFY(sent.contains("world_book_id") && sent["world_book_id"].isNull());
            QCOMPARE(sent["persona_id"], QJsonValue("st_a"));
            QCOMPARE(sent["persona_epoch"], QJsonValue(3));
            QCOMPARE(sent["persona_fingerprint"], QJsonValue("fingerprint-current"));
            QCOMPARE(bridge.personaCardExportState().value("status").toString(), QString("pending"));
        }
        QVERIFY(!QFile::exists(path));
    }
  private:
    static QJsonObject editableCardFields() {
        return {{"description", "档案正文"}, {"personality_traits", QJsonArray{"耐心细致", "喜欢观星"}},
            {"tone", "温和清晰"}, {"first_message", "你好"}, {"alternate_greetings", QJsonArray{"晚上好"}},
            {"message_example", "用户：你好\n角色：你好"}};
    }
    static QJsonObject editableCardSnapshot(int version = 1, char fingerprint = 'a', bool active = false) {
        return {{"ok", true}, {"profile_id", "st_a"}, {"identity_version", version},
            {"identity_fingerprint", QString(64, QLatin1Char(fingerprint))}, {"active", active},
            {"source_format", "chara_card_v2"}, {"fields", editableCardFields()}};
    }
    static void readEditableCard(RuntimeBridge &bridge, bool active = false) {
        personaList(bridge, active ? "st_a" : "default");
        bridge.loadPersonaProfile("st_a");
        const auto id = bridge.personaProfileState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        bridge.event(frame("persona:profile:get:result", id, editableCardSnapshot(1, 'a', active)));
        QVERIFY(bridge.personaProfileState().value("open").toBool());
    }
  private slots:
    void personaProfileReadAndSaveUseCanonicalReceipts() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python"));
        online(bridge);
        const auto frames = sentFrames(bridge);
        readEditableCard(bridge);
        QCOMPARE(bridge.personaProfileState().value("fields").toMap(), editableCardFields().toVariantMap());
        const int generation = bridge.generation();
        const auto scope = bridge.m_persona;
        bridge.savePersonaProfile({{"tone", " 新语气 "}}, false);
        QCOMPARE(commandCount(*frames, "persona:profile:update"), 0);
        bridge.savePersonaProfile({{"tone", " 新语气 "}}, true);
        const auto sent = lastCommand(*frames, "persona:profile:update");
        QCOMPARE(sent["profile_id"].toString(), QString("st_a"));
        QCOMPARE(sent["expected_identity_version"].toInt(), 1);
        QCOMPARE(sent["expected_identity_fingerprint"].toString(), QString(64, 'a'));
        QCOMPARE(frames->last()["envelope"].toObject()["persona"].toObject(), scope);
        QVERIFY(!sent.contains("expected_persona_id") && !sent.contains("expected_persona_epoch") &&
                !sent.contains("expected_persona_fingerprint"));
        QCOMPARE(sent["confirmed_profile_id"].toString(), QString("st_a"));
        QCOMPARE(sent["identity_change_confirmed"], QJsonValue(true));
        QCOMPARE(sent["actor"].toString(), QString("owner"));
        QVERIFY(sent["reason"].toString().size() >= 3);
        QCOMPARE(sent["fields"].toObject(), (QJsonObject{{"tone", " 新语气 "}}));
        QVERIFY(bridge.personaProfilePending());
        auto receipt = editableCardSnapshot(2, 'b');
        auto fields = editableCardFields(); fields["tone"] = "新语气";
        receipt["fields"] = fields; receipt.remove("source_format");
        bridge.event(frame("persona:profile:update:result", sent["requestId"].toString(), receipt));
        QCOMPARE(bridge.personaProfileState().value("status").toString(), QString("success"));
        QCOMPARE(bridge.personaProfileState().value("text").toString(), QString("已保存为第 2 版，切换到这个人格后生效。"));
        QCOMPARE(bridge.personaProfileState().value("fields").toMap(), fields.toVariantMap());
        QCOMPARE(bridge.m_persona, scope); QCOMPARE(bridge.generation(), generation);
        QVERIFY(!bridge.personaProfileState().contains("persona_epoch"));
        bridge.savePersonaProfile({{"description", "第二次编辑"}}, true);
        const auto second = lastCommand(*frames, "persona:profile:update");
        QCOMPARE(second["expected_identity_version"].toInt(), 2);
        QCOMPARE(second["expected_identity_fingerprint"].toString(), QString(64, 'b'));
    }
    void personaProfileReadRequiresCompleteTypedProof_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &value : QStringList{"target", "version", "fingerprint", "fields", "type", "active", "path", "format"})
            QTest::newRow(qPrintable(value)) << value;
    }
    void personaProfileReadRequiresCompleteTypedProof() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python")); online(bridge);
        personaList(bridge, "default"); bridge.loadPersonaProfile("st_a");
        const auto id = bridge.personaProfileState().value("requestId").toString();
        auto receipt = editableCardSnapshot();
        if (condition == "target") receipt["profile_id"] = "other";
        if (condition == "version") receipt["identity_version"] = 1.5;
        if (condition == "fingerprint") receipt["identity_fingerprint"] = "short";
        if (condition == "fields") receipt["fields"] = QJsonObject{{"tone", "only one"}};
        if (condition == "active") receipt["active"] = "false";
        if (condition == "path") receipt["path"] = "/not/a/profile/path";
        if (condition == "format") receipt["source_format"] = "builtin";
        bridge.event(frame(condition == "type" ? "persona:result" : "persona:profile:get:result", id, receipt));
        QCOMPARE(bridge.personaProfileState().value("status").toString(), QString("error"));
        QVERIFY(!bridge.personaProfileState().value("open").toBool());
    }
    void personaProfileSaveRejectionsKeepTheReadVersion_data() {
        QTest::addColumn<QString>("code");
        for (const auto &code : QStringList{"field_too_long", "field_invalid", "unsafe_profile_instructions", "no_change", "restore_pending", "persona_active", "identity_conflict"})
            QTest::newRow(qPrintable(code)) << code;
    }
    void personaProfileSaveRejectionsKeepTheReadVersion() {
        QFETCH(QString, code);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python")); online(bridge);
        readEditableCard(bridge);
        bridge.savePersonaProfile({{"tone", "新语气"}}, true);
        const auto id = bridge.personaProfileState().value("requestId").toString();
        bridge.event(frame("persona:profile:update:result", id,
            {{"ok", false}, {"code", code}, {"error", "后端拒绝"}, {"field", "tone"}}));
        QCOMPARE(bridge.personaProfileState().value("status").toString(), code == "identity_conflict" ? QString("conflict") : QString("error"));
        QVERIFY(bridge.personaProfileState().value("text").toString().contains("没有保存"));
        if (code == "identity_conflict") QVERIFY(bridge.personaProfileState().value("text").toString().contains("这个人格已在别处更改，请重新打开编辑。"));
        QVERIFY(bridge.personaProfileState().value("open").toBool());
        QCOMPARE(bridge.personaProfileState().value("identity_version").toInt(), 1);
        QCOMPARE(bridge.personaProfileState().value("fields").toMap(), editableCardFields().toVariantMap());
    }
    void personaProfileSaveCannotAcceptMalformedOrLateSuccess_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &value : QStringList{"active", "version", "fingerprint", "epoch", "fields", "timeout", "scope", "disconnect", "generation", "shutdown"})
            QTest::newRow(qPrintable(value)) << value;
    }
    void personaProfileSaveCannotAcceptMalformedOrLateSuccess() {
        QFETCH(QString, condition);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python")); online(bridge);
        const auto frames = sentFrames(bridge); readEditableCard(bridge);
        bridge.savePersonaProfile({{"tone", "新语气"}}, true);
        const auto id = bridge.personaProfileState().value("requestId").toString();
        auto receipt = editableCardSnapshot(2, 'b'); receipt.remove("source_format");
        if (condition == "active") receipt["active"] = true;
        if (condition == "version") receipt["identity_version"] = 3;
        if (condition == "fingerprint") receipt["identity_fingerprint"] = QString(64, 'a');
        if (condition == "epoch") receipt["persona_epoch"] = 3;
        if (condition == "fields") receipt["fields"] = QJsonObject{{"tone", "新语气"}};
        if (condition == "timeout") bridge.expirePending(id);
        if (condition == "scope") bridge.event(frame("persona:scope", "", {{"persona_id", "st_a"}, {"epoch", 4}, {"fingerprint", "next"}}));
        if (condition == "disconnect") {
            QVERIFY(QMetaObject::invokeMethod(&bridge.m_process, "finished", Qt::DirectConnection,
                Q_ARG(int, 1), Q_ARG(QProcess::ExitStatus, QProcess::NormalExit)));
        }
        if (condition == "generation") {
            bridge.m_connected = false;
            bridge.acceptFrame({{"kind", "ready"}, {"schema", "reverie.bridge.stdio.ready.v4"},
                {"protocolVersion", 4}, {"pid", 0},
                {"secretSha256", QString::fromLatin1(QCryptographicHash::hash(bridge.m_secret.toUtf8(), QCryptographicHash::Sha256).toHex())},
                {"personaId", bridge.m_persona["persona_id"]}, {"personaEpoch", bridge.m_persona["epoch"]},
                {"personaFingerprint", bridge.m_persona["fingerprint"]}, {"writesBlocked", false},
                {"runtimeWritable", true}, {"recoveryState", "clean"}});
        }
        if (condition == "shutdown") bridge.shutdown();
        bridge.event(frame("persona:profile:update:result", id, receipt));
        QCOMPARE(bridge.personaProfileState().value("status").toString(), QString("unknown"));
        QCOMPARE(bridge.personaProfileState().value("text").toString(), QString("保存结果未知，请重新打开查看。"));
        QVERIFY(!bridge.personaProfileState().value("open").toBool());
        bridge.savePersonaProfile({{"tone", "不能重发"}}, true);
        QCOMPARE(commandCount(*frames, "persona:profile:update"), 1);
    }
    void personaProfileOperationsAreMutuallyExclusiveAndCurrentSaveIsBlocked() {
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python")); online(bridge);
        const auto frames = sentFrames(bridge); personaList(bridge, "default");
        bridge.loadPersonaProfile("default");
        QCOMPARE(commandCount(*frames, "persona:profile:get"), 0);
        bridge.loadPersonaProfile("st_a");
        const auto readId = bridge.personaProfileState().value("requestId").toString();
        bridge.loadPersonaProfile("st_a"); bridge.selectPersona("st_a");
        bridge.choosePersonaCard(QUrl::fromLocalFile(data.filePath("card.json")));
        bridge.exportPersonaCard(QUrl::fromLocalFile(data.filePath("card-out.json")), "");
        bridge.confirmBackupRestore();
        QCOMPARE(commandCount(*frames, "persona:profile:get"), 1);
        QCOMPARE(commandCount(*frames, "persona:activate"), 0);
        QCOMPARE(commandCount(*frames, "persona:import"), 0);
        QCOMPARE(controlCount(*frames, "persona:card:export"), 0);
        bridge.event(frame("persona:profile:get:result", readId, editableCardSnapshot(1, 'a', true)));
        bridge.savePersonaProfile({{"tone", "不能保存当前人格"}}, true);
        QCOMPARE(commandCount(*frames, "persona:profile:update"), 0);
        QVERIFY(bridge.personaProfileState().value("text").toString().contains("使用中的人格不能编辑"));
        bridge.closePersonaProfile();
        bridge.m_backupRestoring = true; bridge.loadPersonaProfile("st_a");
        QCOMPARE(commandCount(*frames, "persona:profile:get"), 1);
        bridge.m_backupRestoring = false;
        bridge.m_personaImport = {{"requestId", "import-pending"}};
        bridge.loadPersonaProfile("st_a");
        QCOMPARE(commandCount(*frames, "persona:profile:get"), 1);
    }
    void personaProfileFieldLimitsRejectBeforeDispatch_data() {
        QTest::addColumn<QString>("field"); QTest::addColumn<QVariant>("value");
        QTest::newRow("description") << QString("description") << QVariant(QString(24001, 'x'));
        QTest::newRow("tone") << QString("tone") << QVariant(QString(2001, 'x'));
        QTest::newRow("first-message") << QString("first_message") << QVariant(QString(4001, 'x'));
        QTest::newRow("example") << QString("message_example") << QVariant(QString(8001, 'x'));
        QVariantList tooManyTraits, tooManyGreetings;
        for (int index = 0; index < 25; ++index) tooManyTraits.append(QString("特征%1").arg(index));
        for (int index = 0; index < 21; ++index) tooManyGreetings.append(QString("问候%1").arg(index));
        QTest::newRow("traits-count") << QString("personality_traits") << QVariant(tooManyTraits);
        QTest::newRow("greetings-count") << QString("alternate_greetings") << QVariant(tooManyGreetings);
        QTest::newRow("traits-empty") << QString("personality_traits") << QVariant(QVariantList{});
        QTest::newRow("trait-short") << QString("personality_traits") << QVariant(QVariantList{QString("短")});
        QTest::newRow("greeting-long") << QString("alternate_greetings") << QVariant(QVariantList{QString(4001, 'x')});
        QTest::newRow("greeting-empty") << QString("alternate_greetings") << QVariant(QVariantList{QString(" ")});
        QTest::newRow("forbidden-field") << QString("name") << QVariant(QString("不可改名"));
    }
    void personaProfileFieldLimitsRejectBeforeDispatch() {
        QFETCH(QString, field); QFETCH(QVariant, value);
        QTemporaryDir data;
        RuntimeBridge bridge(data.path(), data.path(), data.filePath("unused-python")); online(bridge);
        const auto frames = sentFrames(bridge); readEditableCard(bridge);
        bridge.savePersonaProfile({{field, value}}, true);
        QCOMPARE(commandCount(*frames, "persona:profile:update"), 0);
        QCOMPARE(bridge.personaProfileState().value("status").toString(), QString("error"));
    }
};

QTEST_GUILESS_MAIN(RuntimeBridgeTest)
#include "RuntimeBridgeTest.moc"
