// Included inside the upgrade check's private namespace, after Backend and
// canonical record helpers. No production hooks or alternate storage writes.
const QString MemoryConversation = QStringLiteral("w5-memory-seed");
const QStringList MemoryInputs{
    QStringLiteral("记住：W5 isolated durable memory marker"),
    QStringLiteral("我喜欢 W5 isolated candidate confirmed tea"),
    QStringLiteral("我喜欢 W5 isolated candidate pending river")};
QStringList productMemoryFields() {
    return {"kind", "state", "textSha256", "textBytes", "sourceHash", "sourceUri", "lifecycle"};
}
QJsonObject memoryRecord(const QJsonObject &row, bool pending) {
    const auto text = row[pending ? "proposed_text" : "text"].toString().toUtf8();
    need(!row["id"].toString().isEmpty() && !text.trimmed().isEmpty(), "PREVIEW_UPGRADE_MEMORY_RECORD_EMPTY");
    need(pending ? row["status"] == "pending" : row["confirmation_state"] == "confirmed" && row["lifecycle_state"] == "active",
         "PREVIEW_UPGRADE_MEMORY_RECORD_STATE");
    return {{"id", row["id"]}, {"kind", pending ? "pending" : "confirmed"},
        {"state", row[pending ? "status" : "confirmation_state"]}, {"lifecycle", pending ? QString() : row["lifecycle_state"].toString()},
        {"textSha256", digest(text)}, {"textBytes", text.size()}, {"sourceHash", row["source_hash"]}, {"sourceUri", row["source_uri"]}};
}
QJsonObject memoryHistory(Backend &backend) {
    const auto result = backend.call("chat:history", {{"conversation_id", MemoryConversation}, {"limit", 300}});
    need(result["has_more"] != true, "PREVIEW_UPGRADE_MEMORY_HISTORY_LIMIT");
    return result;
}
QJsonObject memoryChat(Backend &backend, const QString &input) {
    const auto before = memoryHistory(backend)["items"].toArray();
    QSet<QString> earlier;
    for (const auto &value : before) earlier.insert(value.toObject()["id"].toString());
    QString request;
    backend.call("chat:send", {{"text", input}, {"conversation_id", MemoryConversation}}, false, &request);
    QJsonObject user, assistant; QElapsedTimer clock; clock.start();
    while (clock.elapsed() < 60000) {
        const auto history = memoryHistory(backend)["items"].toArray();
        for (const auto &value : history) {
            const auto row = value.toObject();
            if (earlier.contains(row["id"].toString()) || row["request_id"] != request || row["conversation_id"] != MemoryConversation ||
                row["persona_id"] != backend.persona["persona_id"] || row["bubble_index"].toInt(-1) != 0) continue;
            if (row["role"] == "user" && row["content"] == input) user = chatRecord(row);
            if (!backend.doneSummary.isEmpty() && row["role"] == "assistant" && row["content"] == backend.cleanChatText) assistant = chatRecord(row);
        }
        if (!user.isEmpty() && !assistant.isEmpty()) break;
        backend.process.waitForReadyRead(250);
    }
    need(!user.isEmpty() && !assistant.isEmpty() && user["id"] != assistant["id"], "PREVIEW_UPGRADE_MEMORY_CHAT_CORRELATION");
    need(!backend.doneSummary.isEmpty() && backend.lastReceiptSequence > quint64(backend.doneSummary["sequence"].toInteger()),
         "PREVIEW_UPGRADE_MEMORY_CHAT_DELIVERY_ORDER");
    QJsonArray beforeIds; auto sorted = earlier.values(); sorted.sort(); for (const auto &value : sorted) beforeIds.append(value);
    const QJsonObject delivery{{"scope", backend.chatScope}, {"ownerPersona", backend.persona}, {"ownerModel", backend.ownerModel},
        {"bubble", backend.bubbleSummary}, {"done", backend.doneSummary}, {"beforeMessageIds", beforeIds},
        {"history", QJsonObject{{"requestId", backend.lastReceiptId}, {"responseSha256", backend.lastReceiptSha}, {"sequence", qint64(backend.lastReceiptSequence)}}},
        {"marker", QJsonObject{{"sha256", digest(QByteArrayLiteral("W5"))}, {"bytes", 2}, {"unique", false}, {"inUser", true}, {"inMock", true}}}};
    const QJsonObject result{{"requestId", request}, {"user", user}, {"assistant", assistant}, {"delivery", delivery}};
    backend.activeChat.clear(); backend.activeConversation = QStringLiteral("dream-room");
    backend.chatScope = {}; backend.bubbleSummary = {}; backend.doneSummary = {};
    backend.cleanChatText.clear(); backend.displayChatText.clear();
    return result;
}
QJsonObject collectProductMemory(Backend &backend) {
    const auto confirmed = backend.call("memory:list", {{"limit", 200}});
    const auto confirmedRequest = backend.lastReceiptId;
    const auto pending = backend.call("memory:candidates:list", {{"status", "pending"}, {"limit", 200}});
    const auto pendingRequest = backend.lastReceiptId;
    need(confirmed["has_more"] != true && pending["has_more"] != true && pending["status"] == "pending",
         "PREVIEW_UPGRADE_MEMORY_PAGE_LIMIT");
    const auto history = memoryHistory(backend)["items"].toArray();
    const auto historyRequest = backend.lastReceiptId;
    QJsonArray records, historyRows;
    for (const auto &row : confirmed["memories"].toArray()) records.append(memoryRecord(row.toObject(), false));
    for (const auto &row : pending["candidates"].toArray()) records.append(memoryRecord(row.toObject(), true));
    for (const auto &row : history) historyRows.append(chatRecord(row.toObject()));
    const auto persisted = category(historyRows, {"role", "contentSha256", "contentBytes", "request_id", "persona_id", "bubble_index"});
    need(historyRows.size() == 6, "PREVIEW_UPGRADE_MEMORY_HISTORY_COUNT");
    const auto bytes = json(persisted);
    records.append(QJsonObject{{"id", "memory-history:w5-memory-seed"}, {"kind", "history"}, {"state", "persisted"}, {"lifecycle", ""},
        {"textSha256", digest(bytes)}, {"textBytes", bytes.size()}, {"sourceHash", digest(bytes)}, {"sourceUri", "reverie-chat://conversation/w5-memory-seed"}});
    return {{"records", records}, {"history", persisted}, {"confirmedRequestId", confirmedRequest},
        {"pendingRequestId", pendingRequest}, {"historyRequestId", historyRequest}};
}
QJsonObject seedProductMemory(Backend &backend) {
    const auto settings = backend.call("memory:settings:get")["settings"].toObject();
    // The production gate is bypassed when autonomous_enabled=false. Capture
    // remains on; candidate extraction precedes probabilistic layer storage.
    need(settings["interaction_capture_enabled"] == true && settings["autonomous_memory_enabled"] == false &&
         settings["autonomous_memory_llm_enabled"] == false, "PREVIEW_UPGRADE_MEMORY_GATE_UNCONFIRMED");
    QJsonArray chats;
    for (const auto &input : MemoryInputs) chats.append(memoryChat(backend, input));
    const auto candidates = backend.call("memory:candidates:list", {{"status", "pending"}, {"limit", 200}});
    need(candidates["has_more"] != true, "PREVIEW_UPGRADE_MEMORY_PAGE_LIMIT");
    QJsonObject chosen, retained;
    for (const auto &value : candidates["candidates"].toArray()) {
        const auto row = value.toObject();
        if (row["source_hash"] == digest(MemoryInputs[1].toUtf8())) chosen = row;
        if (row["source_hash"] == digest(MemoryInputs[2].toUtf8())) retained = row;
    }
    need(!chosen.isEmpty() && !retained.isEmpty() && chosen["id"] != retained["id"], "PREVIEW_UPGRADE_MEMORY_CANDIDATES_NOT_CREATED");
    const auto receipt = backend.call("memory:candidates:confirm", {{"candidate_id", chosen["id"]}});
    const QJsonObject confirmation{{"requestId", backend.lastReceiptId}, {"responseSha256", backend.lastReceiptSha},
        {"candidateId", chosen["id"]}, {"memoryId", receipt["memory"].toObject()["id"]}};
    need(receipt["candidate"].toObject()["id"] == chosen["id"] && receipt["candidate"].toObject()["status"] == "confirmed" &&
         !confirmation["memoryId"].toString().isEmpty(), "PREVIEW_UPGRADE_MEMORY_CONFIRM_RECEIPT");
    const auto collected = collectProductMemory(backend);
    QJsonArray confirmed, pending;
    for (const auto &value : collected["records"].toArray()) {
        const auto row = value.toObject();
        if (row["kind"] == "confirmed") confirmed.append(row);
        if (row["kind"] == "pending") pending.append(row);
    }
    need(confirmed.size() == 2 && pending.size() == 1 && pending[0].toObject()["id"] == retained["id"], "PREVIEW_UPGRADE_MEMORY_SEED_COUNTS");
    return {{"contract", "product-chat-v1"}, {"conversationId", MemoryConversation},
        {"gate", QJsonObject{{"autonomousEnabled", settings["autonomous_memory_enabled"]}, {"autonomousLlmEnabled", settings["autonomous_memory_llm_enabled"]},
                           {"interactionCaptureEnabled", settings["interaction_capture_enabled"]}}},
        {"chats", chats}, {"confirmed", confirmed}, {"pending", pending}, {"confirmation", confirmation},
        {"history", collected["history"]}, {"reads", QJsonObject{{"confirmedRequestId", collected["confirmedRequestId"]},
            {"pendingRequestId", collected["pendingRequestId"]}, {"historyRequestId", collected["historyRequestId"]}}}};
}
