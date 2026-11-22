#include "RuntimeBridge.h"

#include <QJsonArray>
#include <QRegularExpression>
#include <QSet>
#include <QTimer>
#include <algorithm>

namespace {
const QString CollectFailed = QStringLiteral("没有收藏成功");
const QString ReadFailed = QStringLiteral("收藏暂时读不到");

QVariantMap keepsakeRow(const QJsonValue &value) {
    const auto row = value.toObject();
    if (row["id"].toString().isEmpty() || row["message_id"].toString().isEmpty() ||
        !QStringList{"user", "assistant"}.contains(row["role"].toString()) ||
        !row["content"].isString() || !row["original_message_at_utc"].isString() ||
        !row["created_at_utc"].isString() || !row["media_ids"].isArray() ||
        !row["content_offset"].isDouble() || !row["content_total_chars"].isDouble())
        return {};
    static const QRegularExpression mediaId("\\A[0-9a-fA-F]{64}\\z");
    for (const auto &id : row["media_ids"].toArray())
        if (!id.isString() || !mediaId.match(id.toString()).hasMatch()) return {};
    const auto offset = row["content_offset"].toInteger(-1);
    const auto total = row["content_total_chars"].toInteger(-1);
    const auto length = row["content"].toString().toUcs4().size();
    const auto next = row["content_next_offset"];
    if (offset < 0 || total < offset + length || length > 4000 ||
        (next.isNull() ? total != offset + length :
            (!next.isDouble() || next.toInteger(-1) != offset + length || next.toInteger() >= total || length == 0)))
        return {};
    auto result = row.toVariantMap();
    result["expanded"] = false;
    result["contentLoading"] = false;
    return result;
}
}

bool RuntimeBridge::keepsakeWriteAvailable() const {
    return runtimeWritable() && !m_stopping && !personaChanging() &&
        m_keepsakeCollectId.isEmpty() && m_keepsakeRemoveId.isEmpty() &&
        m_keepsakePageId.isEmpty() && m_keepsakeContentId.isEmpty();
}

QVariantMap RuntimeBridge::keepsakeView() const {
    return {{"entries", m_keepsakeEntries}, {"listStatus", m_keepsakeListStatus},
            {"notice", m_keepsakeNotice}, {"hasMore", m_keepsakeHasMore},
            {"nextOffset", m_keepsakeNextOffset}, {"removal", m_keepsakeRemoval},
            {"writeAvailable", keepsakeWriteAvailable()},
            {"collectingMessageId", m_keepsakeCollectId.isEmpty() ? QString() : m_keepsakeMessageId},
            {"messageId", m_keepsakeMessageId}};
}

QString RuntimeBridge::sendKeepsake(const QString &command, const QVariantMap &fields) {
    if (!m_connected || m_stopping || personaChanging() || m_persona.isEmpty()) return {};
    m_keepsakeSending = true;
    const auto id = request(command, fields);
    m_keepsakeSending = false;
    if (!id.isEmpty()) {
        m_keepsakeRequests[id] = {{"command", command}, {"fields", fields},
                                 {"scope", scopeKey()}, {"generation", m_generation}};
        emit keepsakeRequestDispatched(id, fields);
    }
    return id;
}

void RuntimeBridge::collectKeepsake(const QString &messageId) {
    if (!keepsakeWriteAvailable() || messageId.isEmpty() || m_keepsakeMessageIds.contains(messageId)) return;
    const auto found = std::any_of(m_messages.cbegin(), m_messages.cend(), [&](const QVariant &message) {
        return message.toMap().value("id").toString() == messageId;
    });
    if (!found) return;
    m_keepsakeMessageId = messageId;
    m_keepsakeNotice.clear();
    m_keepsakeCollectId = sendKeepsake("keepsake:collect", {{"message_id", messageId}});
    if (m_keepsakeCollectId.isEmpty()) m_keepsakeNotice = CollectFailed;
    emit changed();
}

void RuntimeBridge::refreshKeepsakes() {
    if (m_panel != "keepsake" || !m_keepsakePageId.isEmpty() || !m_keepsakeCollectId.isEmpty() ||
        !m_keepsakeRemoveId.isEmpty() || !m_keepsakeContentId.isEmpty()) return;
    m_keepsakeNotice.clear();
    m_keepsakePageId = sendKeepsake("keepsake:page", {{"offset", 0}});
    m_keepsakeListStatus = m_keepsakePageId.isEmpty() ? "error" : "loading";
    emit changed();
}

void RuntimeBridge::loadMoreKeepsakes() {
    if (m_panel != "keepsake" || !m_keepsakeHasMore || !m_keepsakePageId.isEmpty() ||
        !m_keepsakeCollectId.isEmpty() || !m_keepsakeRemoveId.isEmpty()) return;
    m_keepsakePageId = sendKeepsake("keepsake:page", {{"offset", m_keepsakeNextOffset}});
    m_keepsakeListStatus = m_keepsakePageId.isEmpty() ? "error" : "loading";
    emit changed();
}

void RuntimeBridge::toggleKeepsakeExpanded(const QString &id) {
    for (auto &value : m_keepsakeEntries) {
        auto row = value.toMap();
        if (row.value("id") != id) continue;
        row["expanded"] = !row.value("expanded").toBool();
        value = row;
        if (row.value("expanded").toBool()) {
            row["contentError"] = false;
            value = row;
            readNextKeepsakeContent();
        }
        emit changed();
        return;
    }
}

void RuntimeBridge::readKeepsakeContent(const QString &id) {
    if (m_panel != "keepsake" || !m_keepsakeContentId.isEmpty()) return;
    for (auto &value : m_keepsakeEntries) {
        auto row = value.toMap();
        if (row.value("id") != id || row.value("content_next_offset").isNull()) continue;
        m_keepsakeContentId = sendKeepsake("keepsake:page", {{"keepsake_id", id},
            {"content_offset", row.value("content_next_offset")}});
        row["contentLoading"] = !m_keepsakeContentId.isEmpty();
        value = row;
        return;
    }
}

void RuntimeBridge::readNextKeepsakeContent() {
    if (!m_keepsakeContentId.isEmpty()) return;
    for (const auto &value : m_keepsakeEntries) {
        const auto row = value.toMap();
        if (row.value("expanded").toBool() && !row.value("contentError").toBool() &&
            !row.value("content_next_offset").isNull()) {
            readKeepsakeContent(row.value("id").toString());
            return;
        }
    }
}

void RuntimeBridge::requestKeepsakeRemoval(const QString &id) {
    if (m_panel != "keepsake" || !keepsakeWriteAvailable()) return;
    for (const auto &value : m_keepsakeEntries) {
        const auto row = value.toMap();
        if (row.value("id") != id) continue;
        m_keepsakeRemoval = {{"id", id}, {"messageId", row.value("message_id")},
                            {"scope", scopeKey()}, {"generation", m_generation}};
        emit changed();
        return;
    }
}

void RuntimeBridge::cancelKeepsakeRemoval() {
    m_keepsakeRemoval.clear();
    emit changed();
}

void RuntimeBridge::confirmKeepsakeRemoval() {
    if (m_panel != "keepsake" || !keepsakeWriteAvailable() || m_keepsakeRemoval.isEmpty() ||
        m_keepsakeRemoval.value("scope") != scopeKey() ||
        m_keepsakeRemoval.value("generation").toInt() != m_generation) return;
    m_keepsakeNotice.clear();
    m_keepsakeRemoveId = sendKeepsake("keepsake:remove", {{"keepsake_id", m_keepsakeRemoval.value("id")}});
    m_keepsakeRemoval.clear();
    if (m_keepsakeRemoveId.isEmpty()) m_keepsakeNotice = "没有移除成功";
    emit changed();
}

void RuntimeBridge::applyKeepsakeMessageIds(const QJsonValue &value) {
    QVariantMap ids;
    if (value.isArray() && value.toArray().size() <= 200) {
        for (const auto &entry : value.toArray()) {
            const auto id = entry.toString();
            if (id.isEmpty() || id.size() > 160 || ids.contains(id)) return;
            ids[id] = true;
        }
    } else if (!value.isUndefined()) {
        return;
    }
    if (m_keepsakeMessageIds == ids) return;
    m_keepsakeMessageIds = ids;
    emit keepsakesChanged();
}

void RuntimeBridge::clearKeepsakes() {
    for (auto it = m_keepsakeRequests.cbegin(); it != m_keepsakeRequests.cend(); ++it) m_pending.remove(it.key());
    m_keepsakeRequests.clear();
    m_keepsakePageId.clear();
    m_keepsakeCollectId.clear();
    m_keepsakeRemoveId.clear();
    m_keepsakeContentId.clear();
    m_keepsakeEntries.clear();
    m_keepsakeRemoval.clear();
    m_keepsakeMessageIds.clear();
    m_keepsakeListStatus.clear();
    m_keepsakeNotice.clear();
    m_keepsakeMessageId.clear();
    m_keepsakeHasMore = false;
    m_keepsakeNextOffset = 0;
    ++m_keepsakeRevision;
    emit keepsakesChanged();
}

bool RuntimeBridge::expireKeepsake(const QString &id) {
    if (!m_keepsakeRequests.contains(id)) return false;
    m_keepsakeRequests.remove(id);
    if (id == m_keepsakePageId) {
        m_keepsakePageId.clear();
        m_keepsakeListStatus = "error";
        m_keepsakeNotice = ReadFailed;
    } else if (id == m_keepsakeCollectId) {
        m_keepsakeCollectId.clear();
        m_keepsakeNotice = CollectFailed;
    } else if (id == m_keepsakeRemoveId) {
        m_keepsakeRemoveId.clear();
        m_keepsakeNotice = "没有移除成功";
    } else if (id == m_keepsakeContentId) {
        m_keepsakeContentId.clear();
        m_keepsakeNotice = ReadFailed;
        for (auto &value : m_keepsakeEntries) {
            auto row = value.toMap(); row["contentLoading"] = false; value = row;
        }
    }
    emit changed();
    return true;
}

void RuntimeBridge::discoverKeepsakeThumbnails() {
    bool discovered = false;
    for (const auto &value : m_keepsakeEntries) {
        for (const auto &media : value.toMap().value("media_ids").toList()) {
            const auto id = media.toString();
            if (m_chatImageThumbnails.contains(id)) continue;
            m_chatImageThumbnails[id] = QVariantMap{{"status", "loading"}};
            m_chatImageReads.append(id);
            discovered = true;
        }
    }
    if (discovered) emit chatImagesChanged();
    readNextChatImageThumbnail();
}

bool RuntimeBridge::acceptKeepsakeResponse(const QString &id, const QString &type, const QJsonObject &payload) {
    if (!m_keepsakeRequests.contains(id)) return type == "keepsake:preview:result";
    const auto request = m_keepsakeRequests.value(id);
    if (!m_connected || m_stopping || personaChanging() || !m_pending.contains(id) ||
        m_pending.value(id).generation != m_generation || request.value("scope") != scopeKey() ||
        request.value("generation").toInt() != m_generation ||
        (type != "keepsake:preview:result" && type != "error") ||
        (payload.contains("request_id") && payload["request_id"] != id) ||
        (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
        (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
        (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
        return true;
    const auto command = request.value("command").toString();
    const auto fields = request.value("fields").toMap();
    bool ok = type == "keepsake:preview:result" && payload["ok"] == true &&
        payload["operation"].toString() == command.section(':', 1) && !payload.contains("error");
    m_pending.remove(id);
    m_keepsakeRequests.remove(id);
    bool contentFinished = false;
    if (id == m_keepsakeCollectId) {
        m_keepsakeCollectId.clear();
        const auto row = keepsakeRow(payload["item"]);
        ok = ok && row.value("message_id") == fields.value("message_id") && !row.isEmpty();
        if (ok) {
            ++m_keepsakeRevision;
            applyKeepsakeMessageIds(payload["preview_keepsake_message_ids"]);
            m_keepsakeNotice.clear();
        } else m_keepsakeNotice = payload["code"] == "KEEPSAKE_FULL" ? "收藏已满，请先移除一些" : CollectFailed;
    } else if (id == m_keepsakeRemoveId) {
        m_keepsakeRemoveId.clear();
        ok = ok && payload["removed"] == true && payload["keepsake_id"].toString() == fields.value("keepsake_id").toString();
        if (ok) {
            ++m_keepsakeRevision;
            applyKeepsakeMessageIds(payload["preview_keepsake_message_ids"]);
            m_keepsakeEntries.erase(std::remove_if(m_keepsakeEntries.begin(), m_keepsakeEntries.end(), [&](const QVariant &row) {
                return row.toMap().value("id") == fields.value("keepsake_id");
            }), m_keepsakeEntries.end());
            m_keepsakeNotice.clear();
            m_keepsakeNextOffset = m_keepsakeEntries.size();
        } else m_keepsakeNotice = "没有移除成功";
    } else if (id == m_keepsakePageId) {
        m_keepsakePageId.clear();
        ok = ok && payload["mode"] == "list" && payload["items"].isArray() && payload["items"].toArray().size() <= 20 &&
            payload["offset"].toInt(-1) == fields.value("offset").toInt() && payload["has_more"].isBool();
        QVariantList rows = fields.value("offset").toInt() == 0 ? QVariantList{} : m_keepsakeEntries;
        QSet<QString> ids;
        for (const auto &value : rows) ids.insert(value.toMap().value("id").toString());
        for (const auto &value : payload["items"].toArray()) {
            const auto row = keepsakeRow(value);
            if (row.isEmpty() || ids.contains(row.value("id").toString()) || row.value("content_offset").toInt() != 0) {
                ok = false; break;
            }
            ids.insert(row.value("id").toString());
            rows.append(row);
        }
        ok = ok && rows.size() <= 200 && (!payload["has_more"].toBool() ||
            (payload["next_offset"].isDouble() && payload["next_offset"].toInt() == rows.size()));
        m_keepsakeListStatus = ok ? "ready" : "error";
        if (ok) {
            m_keepsakeEntries = rows;
            m_keepsakeHasMore = payload["has_more"].toBool();
            m_keepsakeNextOffset = payload["next_offset"].toInt(rows.size());
            applyKeepsakeMessageIds(payload["preview_keepsake_message_ids"]);
            discoverKeepsakeThumbnails();
        } else m_keepsakeNotice = ReadFailed;
    } else if (id == m_keepsakeContentId) {
        m_keepsakeContentId.clear();
        contentFinished = true;
        const auto chunk = keepsakeRow(payload["item"]);
        ok = ok && payload["mode"] == "content" && !chunk.isEmpty() &&
            chunk.value("id") == fields.value("keepsake_id") &&
            chunk.value("content_offset") == fields.value("content_offset");
        for (auto &value : m_keepsakeEntries) {
            auto row = value.toMap();
            if (row.value("id") != fields.value("keepsake_id")) continue;
            ok = ok && row.value("message_id") == chunk.value("message_id") &&
                row.value("content_next_offset") == chunk.value("content_offset") &&
                row.value("content_total_chars") == chunk.value("content_total_chars");
            row["contentLoading"] = false;
            if (ok) {
                row["content"] = row.value("content").toString() + chunk.value("content").toString();
                row["content_next_offset"] = chunk.value("content_next_offset");
                row["contentError"] = false;
            }
            if (!ok) row["contentError"] = true;
            value = row;
            break;
        }
        if (!ok) m_keepsakeNotice = ReadFailed;
    }
    emit changed();
    // Keep the full body in the page state, while bounded command receipts remain available to diagnostics.
    auto receipt = payload.toVariantMap();
    receipt["ok"] = ok;
    emit responseReceived(id, command, receipt, m_generation);
    emit commandResult(command, receipt);
    if (contentFinished) QTimer::singleShot(0, this, [this] { readNextKeepsakeContent(); });
    return true;
}
