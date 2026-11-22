#include "RuntimeBridge.h"
#include "PreviewStartupPolicy.h"
#include "Keychain.h"
#include "StorageKeyChannel.h"
#include "PersonaCardReader.h"
#include <QCoreApplication>
#include <algorithm>
#include <cmath>
#include <cstdio>
#include <limits>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSaveFile>
#include <QScopeGuard>
#include <QSet>
#include <QStandardPaths>
#include <QUrl>
#include <QUuid>
#include <QtEndian>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>
static QString uid() { return "qt_" + QUuid::createUuid().toString(QUuid::Id128); }
static QJsonObject obj(const QVariantMap &v) { return QJsonObject::fromVariantMap(v); }
static bool pinCount(const QJsonValue &value) {
    return value.isDouble() && std::isfinite(value.toDouble()) && value.toDouble() >= 0 &&
        value.toDouble() <= std::numeric_limits<int>::max() &&
        value.toDouble() == std::floor(value.toDouble());
}
static QVariantMap relationshipDisplay(const QJsonObject &snapshot, const QString &id) {
    const auto intimacy = snapshot["intimacy"].toInteger(-1);
    const auto number = snapshot["stage_number"].toInteger(-1);
    const auto stage = snapshot["stage"].toString();
    const auto key = snapshot["stage_key"].toString();
    const auto detail = snapshot["stage_detail"];
    const auto thresholds = snapshot["thresholds"].toArray();
    if (intimacy < 0 || snapshot["interaction_count"].toInteger(-1) < 0 ||
        number <= 0 || number > thresholds.size() || stage.isEmpty() || key.isEmpty() ||
        !detail.isString())
        return {};

    QSet<QString> keys;
    qint64 previousMax = -1;
    for (qsizetype i = 0; i < thresholds.size(); ++i) {
        const auto threshold = thresholds[i].toObject();
        const auto minimum = threshold["min"].toInteger(-1);
        const auto maximum = threshold["max"];
        const bool last = i + 1 == thresholds.size();
        const auto thresholdKey = threshold["key"].toString();
        if (thresholdKey.isEmpty() || keys.contains(thresholdKey) ||
            threshold["label"].toString().isEmpty() || minimum < 0 || minimum - 1 != previousMax ||
            (last ? !maximum.isNull() : maximum.toInteger(-1) < minimum))
            return {};
        keys.insert(thresholdKey);
        previousMax = maximum.toInteger(-1);
    }

    // The service supplies the stage. Its own row must describe the snapshot;
    // the next row supplies the distance only.
    const auto current = thresholds[number - 1].toObject();
    if (current["key"] != key || current["label"] != stage ||
        intimacy < current["min"].toInteger() ||
        (!current["max"].isNull() && intimacy > current["max"].toInteger()))
        return {};
    auto intimacyText = QString("亲密度 %1").arg(intimacy);
    if (number < thresholds.size()) {
        const auto next = thresholds[number].toObject();
        intimacyText += QString("，到「%1」还差 %2")
                            .arg(next["label"].toString()).arg(next["min"].toInteger() - intimacy);
    }
    return {{"status", "ready"}, {"requestId", id}, {"stage", "关系：" + stage},
            {"detail", detail.toString()}, {"intimacy", intimacyText},
            {"note", "随聊天慢慢变化，离开多久都不会减少。"}};
}

QVariantMap RuntimeBridge::relationshipStatus() const {
    if (personaChanging())
        return {{"status", "loading"}, {"message", "正在读取…"}};
    if (!m_relationshipDisplay.isEmpty())
        return m_relationshipDisplay;
    if (!m_relationshipReadId.isEmpty())
        return {{"status", "loading"}, {"message", "正在读取…"}};
    return {{"status", "unavailable"}, {"message", "关系状态暂时读不到"}};
}

QVariantMap RuntimeBridge::moodDisplay(const QJsonObject &snapshot, const QString &id) {
    static const QHash<QString, QString> emotions{{"joy", "喜悦"}, {"calm", "平静"},
        {"excitement", "兴奋"}, {"sadness", "难过"}, {"anger", "生气"}, {"anxiety", "焦虑"},
        {"grievance", "委屈"}, {"touched", "感动"}};
    const auto label = moodLabel(snapshot["mood"].toString());
    const auto values = snapshot["emotions"].toObject();
    const auto dominant = snapshot["dominant"].toArray();
    const auto validNumber = [](const QJsonValue &value, double maximum) {
        return value.isDouble() && std::isfinite(value.toDouble()) &&
            value.toDouble() >= 0 && value.toDouble() <= maximum;
    };
    if (label.isEmpty() || values.size() != emotions.size() || dominant.size() < 2 ||
        dominant.size() > emotions.size() || !validNumber(snapshot["intensity"], 1))
        return {};
    for (auto it = values.constBegin(); it != values.constEnd(); ++it) {
        if (!emotions.contains(it.key()) || !validNumber(it.value(), 100))
            return {};
    }
    QSet<QString> names;
    QStringList lines;
    double previousScore = 100;
    for (const auto &value : dominant) {
        const auto row = value.toObject();
        const auto name = row["name"].toString();
        const auto score = row["value"];
        if (!emotions.contains(name) || names.contains(name) || !validNumber(score, previousScore) ||
            score != values.value(name))
            return {};
        names.insert(name);
        previousScore = score.toDouble();
        if (lines.size() < 2)
            lines.append(QString("%1 %2").arg(emotions.value(name)).arg(qRound(score.toDouble())));
    }
    return {{"status", "ready"}, {"requestId", id}, {"label", "心情：" + label},
            {"dominant", "现在最明显的是" + lines.join("、")}};
}

bool RuntimeBridge::moodDisabled() const {
    return m_moodEnabled.isBool() && !m_moodEnabled.toBool();
}

QVariantMap RuntimeBridge::moodStatus() const {
    if (moodDisabled())
        return {{"status", "disabled"}, {"message", "情绪变化已关闭"}};
    if (personaChanging())
        return {{"status", "loading"}, {"message", "正在读取…"}};
    if (!m_moodDisplay.isEmpty())
        return m_moodDisplay;
    if (!m_moodReadId.isEmpty())
        return {{"status", "loading"}, {"message", "正在读取…"}};
    return {{"status", "unavailable"}, {"message", "心情暂时读不到"}};
}

void RuntimeBridge::setRelationshipPageVisible(bool visible) {
    if (visible == m_relationshipPageVisible)
        return;
    m_relationshipPageVisible = visible;
    refreshVisiblePersonaStatus();
}

void RuntimeBridge::refreshVisiblePersonaStatus() {
    if (m_relationshipPageVisible && m_connected && !m_stopping && !personaChanging()) {
        request("relationship:get");
        request("emotion:get");
    }
}

void RuntimeBridge::cancelRelationshipRead() {
    m_pending.remove(m_relationshipReadId);
    m_relationshipReadId.clear();
    m_relationshipReadPersona = {};
}

void RuntimeBridge::failRelationshipRead() {
    cancelRelationshipRead();
    m_relationshipDisplay = m_lastRelationshipDisplay;
    if (!m_relationshipDisplay.isEmpty())
        m_relationshipDisplay["refreshNote"] = "没能更新，显示的是上一次读到的";
    emit changed();
}

void RuntimeBridge::cancelMoodRead() {
    m_pending.remove(m_moodReadId);
    m_moodReadId.clear();
    m_moodReadPersona = {};
}

void RuntimeBridge::failMoodRead() {
    cancelMoodRead();
    m_moodDisplay = m_lastMoodDisplay;
    if (!m_moodDisplay.isEmpty())
        m_moodDisplay["refreshNote"] = "没能更新，显示的是上一次读到的";
    emit changed();
}
static int profileTextLength(const QString &text) { return text.toUcs4().size(); }
static QString personaProfileFieldName(const QString &key) {
    static const QHash<QString, QString> names{{"description", "档案正文"},
        {"personality_traits", "性格特征"}, {"tone", "说话语气"}, {"first_message", "开场白"},
        {"alternate_greetings", "备选问候"}, {"message_example", "对话示例"}};
    return names.value(key, key);
}
// A profile snapshot is accepted only with all six typed, bounded values. The
// backend owns normalization; the editor always adopts its canonical receipt.
static bool validPersonaProfileFields(const QJsonObject &fields, bool complete, QString *bad = nullptr) {
    static const QHash<QString, int> textLimits{{"description", 24000}, {"tone", 2000},
        {"first_message", 4000}, {"message_example", 8000}};
    static const QSet<QString> keys{"description", "tone", "first_message", "message_example",
        "personality_traits", "alternate_greetings"};
    if (fields.isEmpty() || (complete && fields.size() != keys.size())) return false;
    for (auto it = fields.begin(); it != fields.end(); ++it) {
        if (bad) *bad = it.key();
        if (!keys.contains(it.key())) return false;
        if (textLimits.contains(it.key())) {
            if (!it->isString() || profileTextLength(it->toString()) > textLimits.value(it.key())) return false;
        } else {
            const bool traits = it.key() == "personality_traits";
            if (!it->isArray()) return false;
            const auto values = it->toArray();
            if ((traits && values.isEmpty()) || values.size() > (traits ? 24 : 20)) return false;
            for (const auto &value : values) {
                if (!value.isString()) return false;
                const int size = profileTextLength(value.toString().trimmed());
                if (size < (traits ? 2 : 1) || size > (traits ? 160 : 4000)) return false;
            }
        }
    }
    return true;
}
static bool memoryImportance(const QJsonValue &value) {
    return value.isDouble() && std::isfinite(value.toDouble()) &&
        value.toDouble() >= 0 && value.toDouble() <= 1;
}
static QString memoryImportanceText(double value) {
    if (value == 0)
        return "0";
    auto text = QString::number(std::round(value * 100) / 100, 'f', 2);
    while (text.endsWith('0'))
        text.chop(1);
    if (text.endsWith('.'))
        text.chop(1);
    return text;
}
static bool pinIdArray(const QJsonValue &value, const QVariantList &ids, QSet<QString> *found,
                       bool ordered = false) {
    if (!value.isArray())
        return false;
    int previous = -1;
    for (const auto &entry : value.toArray()) {
        if (!entry.isString())
            return false;
        const auto id = entry.toString();
        const int index = ids.indexOf(QVariant(id));
        if (index < 0 || found->contains(id) || (ordered && index <= previous))
            return false;
        previous = index;
        found->insert(id);
    }
    return true;
}
static bool pinStatusSnapshot(const QString &type, const QJsonObject &payload,
                              const QVariantList &ids, QVariantMap *states, int *total,
                              QSet<QString> *stale) {
    if (type != "memory:result" || !payload["ok"].isBool() || !payload["ok"].toBool() ||
        payload.contains("error") || payload.contains("error_code") || payload.contains("code") ||
        !payload["memory_ids"].isArray() || payload["memory_ids"].toArray() != QJsonArray::fromVariantList(ids) ||
        !payload["states"].isArray() || !pinCount(payload["pinned_total"]) ||
        !pinCount(payload["pin_limit"]) || payload["pin_limit"].toInt() != 20 ||
        !pinIdArray(payload["stale_ids"], ids, stale))
        return false;
    int pinned = 0;
    for (const auto &entry : payload["states"].toArray()) {
        const auto row = entry.toObject();
        if (!entry.isObject() || !row["memory_id"].isString() || !row["pinned"].isBool())
            return false;
        const auto id = row["memory_id"].toString();
        if (!ids.contains(QVariant(id)) || states->contains(id) || stale->contains(id))
            return false;
        states->insert(id, row["pinned"].toBool());
        pinned += row["pinned"].toBool();
    }
    *total = payload["pinned_total"].toInt();
    return states->size() + stale->size() == ids.size() && pinned <= *total;
}
struct CandidateBatchSnapshot {
    QSet<QString> pending, stale, fresh, replace, same, replacedPinned;
    QHash<QString, QString> states;
    int conflicts = 0;
};
// The backend lists every outcome in selection order; any gap, overlap or
// unknown status means the preview or read-back is not a complete snapshot.
static bool candidateBatchSnapshot(const QString &type, const QJsonObject &payload,
                                   const QVariantList &ids, CandidateBatchSnapshot *out) {
    if (type != "memory:candidates:result" || !payload["ok"].isBool() || !payload["ok"].toBool() ||
        payload.contains("error") || payload.contains("error_code") || payload.contains("code") ||
        !payload["candidate_ids"].isArray() ||
        payload["candidate_ids"].toArray() != QJsonArray::fromVariantList(ids) ||
        !payload["states"].isArray() || !payload["conflict_groups"].isArray() ||
        !pinIdArray(payload["pending_ids"], ids, &out->pending, true) ||
        !pinIdArray(payload["stale_ids"], ids, &out->stale, true) ||
        !pinIdArray(payload["new_ids"], ids, &out->fresh, true) ||
        !pinIdArray(payload["replace_ids"], ids, &out->replace, true) ||
        !pinIdArray(payload["same_ids"], ids, &out->same, true) ||
        !pinIdArray(payload["replaced_pinned_ids"], ids, &out->replacedPinned, true) ||
        out->pending.size() + out->stale.size() != ids.size() ||
        out->fresh.size() + out->replace.size() + out->same.size() != out->pending.size())
        return false;
    for (const auto &id : out->pending)
        if (out->stale.contains(id) ||
            int(out->fresh.contains(id)) + int(out->replace.contains(id)) + int(out->same.contains(id)) != 1)
            return false;
    for (const auto &id : out->replacedPinned)
        if (!out->replace.contains(id))
            return false;
    static const QStringList statuses{"pending", "confirmed", "rejected"};
    for (const auto &entry : payload["states"].toArray()) {
        const auto row = entry.toObject();
        const auto id = row["candidate_id"].toString();
        if (!entry.isObject() || !row["candidate_id"].isString() || !row["status"].isString() ||
            !ids.contains(QVariant(id)) || out->states.contains(id) ||
            !statuses.contains(row["status"].toString()) ||
            (row["status"].toString() == "pending") != out->pending.contains(id))
            return false;
        out->states.insert(id, row["status"].toString());
    }
    for (const auto &id : out->pending)
        if (!out->states.contains(id))
            return false;
    QSet<QString> grouped;
    for (const auto &value : payload["conflict_groups"].toArray()) {
        if (!value.isArray() || value.toArray().size() < 2)
            return false;
        for (const auto &member : value.toArray()) {
            if (!member.isString() || !out->pending.contains(member.toString()) || grouped.contains(member.toString()))
                return false;
            grouped.insert(member.toString());
        }
    }
    out->conflicts = grouped.size();
    return true;
}
static bool memoryBatchPrewriteRejection(const QString &type, const QJsonObject &payload) {
    // These dispatch/preflight branches return before the memory handler can
    // commit. Storage, ledger and generic failures may follow a commit.
    static const QStringList codes{"BACKUP_RECOVERY_REQUIRED", "stale_persona",
                                   "runtime_capability_unavailable", "persona_restart_required"};
    return type == "memory:result" && payload["ok"].isBool() && !payload["ok"].toBool() &&
        payload["code"].isString() && codes.contains(payload["code"].toString()) &&
        (!payload.contains("error_code") || payload["error_code"] == payload["code"]) &&
        (!payload.contains("error") || payload["error"].isString()) &&
        (!payload.contains("retryable") || (payload["retryable"].isBool() && !payload["retryable"].toBool())) &&
        !payload.contains("deleted_ids") && !payload.contains("purged_revisions");
}
static const QStringList profileBasicFields{
    "name", "nickname", "birthday", "identity", "schedule", "interests", "hobbies", "favorite_topics",
    "favorite_games", "favorite_anime", "age"};
static const QStringList profileListFields{"interests", "hobbies", "favorite_topics", "favorite_games",
                                           "favorite_anime"};
// Age is the one numeric field: a whole number, or null when not set.
static bool profileAgeValue(const QJsonValue &value) {
    return value.isNull() || (value.isDouble() && std::isfinite(value.toDouble()) &&
                              value.toDouble() == std::floor(value.toDouble()));
}
static bool validProfileSnapshot(const QJsonObject &payload) {
    static const QRegularExpression digest("^[a-f0-9]{64}$");
    if (!payload["profile"].isObject() || payload.contains("error") ||
        (payload.contains("ok") && !payload["ok"].toBool()) ||
        payload["profile_snapshot"].toString().size() != 64 ||
        !digest.match(payload["profile_snapshot"].toString()).hasMatch())
        return false;
    const auto profile = payload["profile"].toObject();
    for (const auto &field : profileBasicFields) {
        const auto value = profile[field];
        if (field == "age") {
            if (!profileAgeValue(value))
                return false;
        } else if (!profileListFields.contains(field)) {
            if (!value.isString())
                return false;
        } else {
            if (!value.isArray())
                return false;
            for (const auto &item : value.toArray())
                if (!item.isString())
                    return false;
        }
    }
    return true;
}
static bool profileFieldEmpty(const QJsonObject &profile, const QString &field) {
    if (field == "age")
        return profile[field].isNull();
    return profileListFields.contains(field) ? profile[field].toArray().isEmpty()
                                             : profile[field].toString().isEmpty();
}
static QString profileFieldNames(const QStringList &fields) {
    static const QHash<QString, QString> names{{"name", "名字"}, {"nickname", "称呼"},
        {"birthday", "生日"}, {"identity", "身份或近况"}, {"schedule", "作息"},
        {"interests", "兴趣"}, {"hobbies", "爱好"}, {"favorite_topics", "喜欢聊的话题"},
        {"favorite_games", "喜欢的游戏"}, {"favorite_anime", "喜欢的动漫"}, {"age", "年龄"}};
    QStringList labels;
    for (const auto &field : fields)
        labels << names.value(field);
    return labels.join("、");
}
static QJsonObject rendererFrame(const QString &command, QJsonObject payload, const QString &id,
                                const QJsonObject &persona) {
    if (command == "chat:send")
        payload["request_id"] = id;
    return {{"kind", "renderer_command"}, {"schema", "reverie.command.v4"},
            {"envelope", QJsonObject{{"protocol_version", 4}, {"request_id", id},
                {"idempotency_key", id}, {"command", command}, {"persona", persona},
                {"payload", payload},
                {"created_at_utc", QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}}}};
}
// Names only what the import receipt's fields confirm. The importer's
// free-text warnings stay in the details: they can point at editors this
// window does not have, or restate a world book that was not written.
// The switch location is named only when the archive attachment reported
// no warning, so the card record that holds the switch exists.
static QString cardImportNotes(const QJsonObject &payload, bool switchesStored) {
    QStringList notes;
    const int entries = payload["world_book_entry_count"].toInt();
    if (payload["world_book_imported"].toBool())
        notes << QString("卡内世界书 %1 条已写入这个人格的资料").arg(entries);
    else if (entries > 0)
        notes << QString("卡内世界书 %1 条没有写入").arg(entries);
    bool unsafeText = false, skippedEntries = false, extras = false;
    QStringList storedPrompts, flaggedPrompts;
    for (const auto &value : payload["ignored_fields"].toArray()) {
        const auto field = value.toString();
        const auto base = field.section(':', 0, 0);
        if (base == "system_prompt" || base == "post_history_instructions") {
            auto &names = field.endsWith(":untrusted_injection") ? flaggedPrompts : storedPrompts;
            const auto name = base == "system_prompt" ? "系统提示" : "对话后指令";
            if (!names.contains(name))
                names << name;
        } else if (base == "character_book")
            skippedEntries = true;
        else if (field.endsWith(":unsafe"))
            unsafeText = true;
        else if (!field.isEmpty())
            extras = true;
    }
    if (!storedPrompts.isEmpty())
        notes << "卡作者的" + storedPrompts.join("和") + "已隔离保存，默认不启用" +
                     (switchesStored ? "，可在本页下方开启" : "");
    if (!flaggedPrompts.isEmpty())
        notes << "卡作者的" + flaggedPrompts.join("和") + "含可疑指令，已隔离，不能启用";
    if (unsafeText)
        notes << "问候语或示例对话中的可疑指令已移除";
    if (skippedEntries)
        notes << "卡内世界书有条目没有导入";
    if (extras)
        notes << "扩展、资源等附加数据已忽略，不会执行或加载";
    return notes.isEmpty() ? QString() : notes.join("；") + "。";
}
static bool validEndpoint(const QJsonValue &value, bool allowEmpty = false) {
    if (!value.isString())
        return false;
    const auto text = value.toString();
    if (text.isEmpty())
        return allowEmpty;
    const QUrl url(text);
    return url.isValid() && (url.scheme() == "http" || url.scheme() == "https") &&
           !url.host().isEmpty();
}
static bool validProviderSnapshot(const QJsonValue &value) {
    const auto provider = value.toObject();
    return value.isObject() && provider["provider"].isString() &&
           !provider["provider"].toString().trimmed().isEmpty() && provider["model"].isString() &&
           !provider["model"].toString().trimmed().isEmpty() && validEndpoint(provider["base_url"]);
}
// A fresh install: a destination is set but no model has been chosen yet.
static bool unconfiguredProviderSnapshot(const QJsonValue &value) {
    const auto provider = value.toObject();
    return value.isObject() && provider["provider"].isString() &&
           !provider["provider"].toString().trimmed().isEmpty() && provider["model"].isString() &&
           provider["model"].toString().trimmed().isEmpty() && validEndpoint(provider["base_url"]);
}
static bool validPermissionSnapshot(const QJsonObject &snapshot) {
    if (snapshot["schema"].toString() != "reverie.ai-usage-consent.v2" ||
        !snapshot["features"].isObject() || snapshot["features"].toObject().isEmpty())
        return false;
    const auto features = snapshot["features"].toObject();
    for (auto it = features.begin(); it != features.end(); ++it) {
        if (!it.value().isObject())
            return false;
        const auto feature = it.value().toObject();
        if (!feature["enabled"].isBool() || !feature["effective"].isBool() ||
            !feature["api_cost_acknowledged"].isBool() || !feature["description"].isString() ||
            feature["description"].toString().trimmed().isEmpty() ||
            !feature["consent_digest"].isString() || feature["consent_digest"].toString().isEmpty() ||
            !feature["current_provider"].isString() ||
            feature["current_provider"].toString().trimmed().isEmpty() ||
            !validEndpoint(feature["current_origin"]) || !feature["provider"].isString() ||
            !validEndpoint(feature["origin"], true))
            return false;
    }
    return true;
}
// The settings pages read only these three sections.
static bool validSettingsSnapshot(const QJsonObject &payload) {
    return payload["ok"].toBool() && payload["chat"].isObject() && payload["memory"].isObject() &&
           payload["features"].isObject();
}
static bool summaryIdValid(const QString &value) {
    static const QRegularExpression pattern("\\Asummary_[0-9a-f]{32}\\z");
    return value.size() == 40 && pattern.match(value).hasMatch();
}
static bool summarySequenceValid(const QJsonValue &value, bool allowZero = false) {
    // These values are also exposed to QML, whose exact integer range is 53 bits.
    return value.isDouble() && std::isfinite(value.toDouble()) &&
        value.toDouble() >= (allowZero ? 0 : 1) && value.toDouble() <= 9007199254740991.0 &&
        value.toDouble() == std::floor(value.toDouble());
}
static QJsonObject summaryMetadata(const QJsonObject &offered, bool detail = false) {
    auto metadata = offered;
    if (detail)
        metadata.remove("text");
    static const QStringList fields{"contractVersion", "firstSequence", "lastSequence", "messageIds",
                                     "sourceDigest", "summary_id"};
    static const QRegularExpression digest("\\A[0-9a-f]{64}\\z");
    if (metadata.keys() != fields || !metadata["summary_id"].isString() ||
        !summaryIdValid(metadata["summary_id"].toString()) ||
        !metadata["sourceDigest"].isString() || metadata["sourceDigest"].toString().size() != 64 ||
        !digest.match(metadata["sourceDigest"].toString()).hasMatch() ||
        metadata["contractVersion"] != "reverie.conversation-summary.v1" ||
        !summarySequenceValid(metadata["firstSequence"]) ||
        !summarySequenceValid(metadata["lastSequence"]) || !metadata["messageIds"].isArray())
        return {};
    const auto ids = metadata["messageIds"].toArray();
    const auto first = metadata["firstSequence"].toInteger();
    const auto last = metadata["lastSequence"].toInteger();
    if (ids.isEmpty() || ids.size() > 40 || last < first || last - first + 1 < ids.size())
        return {};
    QSet<QString> unique;
    for (const auto &value : ids) {
        if (!value.isString())
            return {};
        const auto id = value.toString();
        if (id.isEmpty() || !id.isValidUtf16() || id.trimmed() != id || id.contains(QChar(0)) ||
            id.toUcs4().size() > 512 || unique.contains(id))
            return {};
        unique.insert(id);
    }
    return metadata;
}
static const QStringList emotionSettingKeys{"emotion_system_enabled", "emotion_carryover_days",
                                            "emotion_inertia_factor"};
static const QString ProactiveEnabled = "proactive_chat_enabled";
static const QHash<QString, QList<double>> proactivePresets{
    {"proactive_daily_limit", {1, 2, 3, 5}}, {"proactive_min_interval_minutes", {60, 120, 240, 480}}};
static bool proactiveSettingsPayload(const QVariantMap &payload) {
    if (payload.value("section") != QVariant(QString("features")) || payload.size() < 2)
        return false;
    for (auto it = payload.cbegin(); it != payload.cend(); ++it)
        if (it.key() != "section" && it.key() != ProactiveEnabled && !proactivePresets.contains(it.key()))
            return false;
    return true;
}

static bool proactiveSettingsMatch(const QVariantMap &snapshot, const QVariantMap &fields) {
    const auto features = obj(snapshot)["features"].toObject();
    for (auto it = fields.cbegin(); it != fields.cend(); ++it)
        if (features.value(it.key()) != QJsonValue::fromVariant(it.value())) return false;
    return true;
}

static bool touchesEmotion(const QVariantMap &fields) {
    for (const auto &key : emotionSettingKeys)
        if (fields.contains(key))
            return true;
    return false;
}
static const QStringList budgetSettingKeys{"api_background_budget_enforced",
    "api_background_daily_request_budget", "api_background_daily_token_budget"};
static bool touchesBudget(const QVariantMap &fields) {
    for (const auto &key : budgetSettingKeys)
        if (fields.contains(key))
            return true;
    return false;
}
static bool budgetInteger(const QJsonValue &value, double minimum = 0,
                           double maximum = 9007199254740991.0) {
    return value.isDouble() && std::isfinite(value.toDouble()) &&
        value.toDouble() >= minimum && value.toDouble() <= maximum &&
        value.toDouble() == std::floor(value.toDouble());
}
static bool budgetRuntimeMatches(const QVariantMap &snapshot, const QVariantMap &requested) {
    const auto json = obj(snapshot);
    if (!json["ok"].isBool() || !json["ok"].toBool() || json.contains("error") ||
        !json["features"].isObject() || !json["budgetRuntime"].isObject())
        return false;
    const auto features = json["features"].toObject();
    const auto running = json["budgetRuntime"].toObject();
    if (!features["api_budget_tracking_enabled"].isBool() ||
        !features["api_background_budget_enforced"].isBool() ||
        !budgetInteger(features["api_background_daily_request_budget"], 1, 10000) ||
        !budgetInteger(features["api_background_daily_token_budget"], 1000, 10000000) ||
        !running["tracking_enabled"].isBool() || !running["background_enforced"].isBool() ||
        !budgetInteger(running["request_budget"], 1, 10000) ||
        !budgetInteger(running["token_budget"], 1000, 10000000) ||
        running["tracking_enabled"] != features["api_budget_tracking_enabled"] ||
        running["background_enforced"] != features["api_background_budget_enforced"] ||
        running["request_budget"] != features["api_background_daily_request_budget"] ||
        running["token_budget"] != features["api_background_daily_token_budget"])
        return false;
    // Agreement between an old config and old runtime is not this save's receipt.
    const auto sent = obj(requested);
    for (const auto &key : budgetSettingKeys)
        if (sent.contains(key) && sent[key] != features[key])
            return false;
    return true;
}
static bool validBudgetSnapshot(const QJsonObject &payload) {
    const auto day = payload["local_day"].toString();
    const auto date = QDate::fromString(day, Qt::ISODate);
    if (payload.contains("error") || payload.contains("error_code") || payload.contains("code") ||
        (payload.contains("ok") && (!payload["ok"].isBool() || !payload["ok"].toBool())) ||
        (payload.contains("success") && (!payload["success"].isBool() || !payload["success"].toBool())) ||
        (payload.contains("unknown") && (!payload["unknown"].isBool() || payload["unknown"].toBool())) ||
        QStringList{"error", "failed", "unavailable", "denied"}.contains(payload["status"].toString()) ||
        !payload["local_day"].isString() || !date.isValid() || date.toString(Qt::ISODate) != day ||
        !payload["tracking_enabled"].isBool() || !payload["background_enforced"].isBool() ||
        !payload["background"].isObject() || !payload["by_purpose"].isArray())
        return false;
    for (const auto &key : {"requests", "succeeded", "failed", "prompt_tokens", "completion_tokens",
                            "estimated_unreported_tokens"})
        if (!budgetInteger(payload[key]))
            return false;
    const auto background = payload["background"].toObject();
    if (!budgetInteger(background["requests"]) || !budgetInteger(background["tokens"]) ||
        !budgetInteger(background["request_budget"], 1, 10000) ||
        !budgetInteger(background["token_budget"], 1000, 10000000))
        return false;
    const auto purposes = payload["by_purpose"].toArray();
    if (purposes.size() > 20)
        return false;
    for (const auto &value : purposes) {
        const auto purpose = value.toObject();
        if (!value.isObject() || !purpose["purpose"].isString() ||
            !budgetInteger(purpose["requests"]) || !budgetInteger(purpose["measured_tokens"]))
            return false;
    }
    return true;
}
static const QString budgetUnconfirmedText =
    "设置已写入，但运行中的用量上限尚未确认同步；已重新读取当前设置。";
static QString settingsSavedText(const QString &section, const QVariantMap &fields = {}) {
    return section == "chat"         ? "聊天设置已保存。"
           : section == "memory"     ? "记忆设置已保存。"
           : section == "onboarding" ? "首次设置已完成。"
           : section == "features"   ? "主动消息设置已保存。"
           : touchesBudget(fields)   ? "用量上限已保存。"
           : touchesEmotion(fields)  ? "情绪设置已保存。"
                                     : "性格设置已保存。";
}
// The running emotion system reports the parameters it actually uses. A save
// that changes them is confirmed only once that report matches the saved values.
static bool emotionRuntimeMatches(const QVariantMap &snapshot) {
    const auto features = snapshot.value("features").toMap();
    const auto runtime = snapshot.value("emotionRuntime");
    if (runtime.metaType().id() != QMetaType::QVariantMap)
        return false;
    const auto running = runtime.toMap();
    const auto enabled = running.value("enabled");
    const auto days = running.value("carryover_days");
    const auto ratio = running.value("inertia_factor");
    const auto savedEnabled = features.value("emotion_system_enabled");
    return enabled.metaType().id() == QMetaType::Bool && savedEnabled.metaType().id() == QMetaType::Bool &&
           enabled.toBool() == savedEnabled.toBool() && days.isValid() && ratio.isValid() &&
           days.toDouble() == features.value("emotion_carryover_days").toDouble() &&
           std::abs(ratio.toDouble() - features.value("emotion_inertia_factor").toDouble()) < 1e-9;
}
static void atomicJson(const QString &p, const QJsonObject &v) {
    QSaveFile f(p);
    if (!f.open(QIODevice::WriteOnly) || f.write(QJsonDocument(v).toJson()) < 0 || !f.commit())
        throw std::runtime_error("LOCAL_WRITE_FAILED");
}
static QJsonObject readJson(const QString &p) {
    QFile f(p);
    if (!f.exists())
        return {};
    if (!f.open(QIODevice::ReadOnly) || f.size() > 1048576)
        throw std::runtime_error("LOCAL_STATE_INVALID");
    QJsonParseError e;
    auto d = QJsonDocument::fromJson(f.readAll(), &e);
    if (e.error != QJsonParseError::NoError || !d.isObject())
        throw std::runtime_error("LOCAL_STATE_INVALID");
    return d.object();
}
RuntimeBridge::RuntimeBridge(QString root, QString data, QString python, QObject *parent,
                             bool supplementaryFixture, bool previewMode)
    : QObject(parent), m_root(root), m_data(data), m_python(python),
      m_supplementaryFixture(supplementaryFixture), m_previewMode(previewMode) {
    QFile rules(":/logic/rules.js");
    if (rules.open(QIODevice::ReadOnly))
        m_xiangqi = m_rules.evaluate(QString::fromUtf8(rules.readAll()));
    QFile gomokuRules(":/logic/gomoku-rules.js");
    if (gomokuRules.open(QIODevice::ReadOnly))
        m_gomoku = m_rules.evaluate(QString::fromUtf8(gomokuRules.readAll()));
    QFile chessRules(":/logic/chess-rules.js");
    if (chessRules.open(QIODevice::ReadOnly))
        m_chess = m_rules.evaluate(QString::fromUtf8(chessRules.readAll()));
    QFile goRules(":/logic/go-rules.js");
    if (goRules.open(QIODevice::ReadOnly))
        m_go = m_rules.evaluate(QString::fromUtf8(goRules.readAll()));
    auto appearance = readJson(m_data + "/qt-appearance.json");
    m_reducedMotion = appearance["reducedMotion"].toBool();
    m_reducedTransparency = appearance["reducedTransparency"].toBool();
    m_offline = appearance["offline"].toBool();
    const auto roomQuality = appearance.value("roomQuality").toString();
    if (roomQuality == "clear" || roomQuality == "balanced" || roomQuality == "smooth")
        m_roomQuality = roomQuality;
    m_state["offline"] = m_offline;
    // Only owned private copies from an interrupted native selection are cleaned.
    const QString staging = m_data + "/backup-staging";
    struct stat stagingStat{};
    if (::lstat(QFile::encodeName(staging).constData(), &stagingStat) == 0 &&
        S_ISDIR(stagingStat.st_mode) && stagingStat.st_uid == getuid()) {
        const QRegularExpression stagedName("^\\.reverie-import-[0-9a-f-]{36}\\.json$");
        for (const auto &name : QDir(staging).entryList(QDir::Files | QDir::Hidden)) {
            struct stat fileStat{};
            const auto path = staging + "/" + name;
            if (stagedName.match(name).hasMatch() &&
                ::lstat(QFile::encodeName(path).constData(), &fileStat) == 0 &&
                S_ISREG(fileStat.st_mode) && fileStat.st_uid == getuid())
                QFile::remove(path);
        }
    }
    connect(&m_process, &QProcess::readyReadStandardOutput, this, &RuntimeBridge::readFrames);
    connect(&m_process, &QProcess::readyReadStandardError, this, [this] {
        auto data = m_process.readAllStandardError();
        if (m_previewMode) {
            // The preview launcher owns bounded logs under workspace/logs.
            std::fwrite(data.constData(), 1, size_t(data.size()), stderr);
            std::fflush(stderr);
            return;
        }
        QFile log(m_data + "/backend.log");
        if (log.open(QIODevice::Append) && log.size() < 2 * 1024 * 1024)
            log.write(data);
    });
    connect(&m_process, &QProcess::finished, this, [this](int code, QProcess::ExitStatus) {
        if (m_previewMode) emit previewEvent("backend_exit", "OK", code);
        m_connected = false;
        clearDiary();
        clearKeepsakes();
        clearProactiveHistory();
        resetChatImages(false);
        if (m_opponentPending)
            cancelOpponent();
        invalidatePersonaProfile();
        invalidateMemoryPinConnection(false);
        invalidateCandidateBatchConnection(false);
        ++m_memoryListRevision;
        invalidateCandidatePaging(false);
        invalidateMemoryRecall(false, "disconnected", "连接已中断，关联回忆结果已清除；输入已保留。");
        invalidateSummaryDirectory();
        invalidateSummaryDetail("error", "连接已中断，摘要正文已清除；重新连接后请刷新目录再读取。");
        invalidateBudget("连接已中断，用量暂时读不到；重新连接后请刷新。");
        m_profileSnapshotGeneration = -1;
        if (m_profileClearState.value("status").toString() == "confirmation")
            setProfileClearState("stale", "连接已中断，请刷新当前资料后重新选择清空字段。");
        clearPersonaCardCandidate();
        forgetPersonaCardImport("连接中断，角色卡导入结果未确认；重新连接后请核对当前人格和列表。");
        unknownPersonaCardExport();
        unknownWorldbookFile();
        m_runtimeWritable = false;
        m_recoveryState = "unknown";
        invalidatePermissions();
        if (!m_providerSaveId.isEmpty()) {
            m_providerSaveId.clear();
            m_providerContextUnknown = true;
            setProviderFeedback("unknown", "服务已断开，保存结果未知；当前编辑已保留。", false);
        }
        m_readyTimer.stop();
        m_keyAppliedHandshake = -1;
        const auto pendingIds = m_pending.keys();
        for (const auto &id : pendingIds)
            expirePending(id);
        if (m_busy)
            finishChat("failed_uncertain");
        m_pending.clear();
        if (m_gamePhase == GamePhase::Ready)
            m_gamePhase = GamePhase::ReadFailed;
        emit gameChanged();
        m_networkRequestId.clear();
        m_networkFeedback = {{"status", "unknown"}, {"known", false},
                             {"text", "本地服务已断开，网络调用状态未知。"}};
        if (!m_stopping)
            setNotice(QString("本地服务已退出（%1），请关闭并重新启动。").arg(code));
        emit changed();
        if (m_stopping)
            emit shutdownComplete();
    });
    connect(&m_process, &QProcess::errorOccurred, this, [this](QProcess::ProcessError) {
        setNotice("无法启动项目本地服务；请检查固定运行环境。");
    });
    m_readyTimer.setSingleShot(true);
    connect(&m_readyTimer, &QTimer::timeout, this, [this] {
        setNotice("本地服务握手超时，启动已停止。");
        shutdown();
    });
}
RuntimeBridge::~RuntimeBridge() {
    shutdown();
    if (m_process.state() != QProcess::NotRunning) {
        m_process.waitForFinished(3000);
        if (m_process.state() != QProcess::NotRunning) {
            m_process.kill();
            m_process.waitForFinished(2000);
        }
    }
    discardStagedBackup();
}
void RuntimeBridge::setNotice(QString s) {
    m_notice = s;
    emit changed();
}
void RuntimeBridge::setChatFeedback(const QString &status, const QString &text) {
    const auto cancel = m_chatFeedback.value("cancel");
    m_chatFeedback = {{"status", status}, {"text", text}, {"requestId", m_chatId}};
    if (cancel.isValid())
        m_chatFeedback["cancel"] = cancel;
    setNotice(text);
}
void RuntimeBridge::setCancelFeedback(const QString &status, const QString &text,
                                      const QString &requestId, const QString &subjectRequestId) {
    m_chatFeedback["cancel"] = QVariantMap{{"status", status}, {"text", text},
                                          {"requestId", requestId},
                                          {"subjectRequestId", subjectRequestId}};
    emit changed();
}
void RuntimeBridge::setProviderFeedback(const QString &status, const QString &text,
                                        bool currentDraft) {
    m_providerFeedback = {{"status", status}, {"text", text},
                          {"pending", status == "testing" || !m_providerSaveId.isEmpty()},
                          {"saving", !m_providerSaveId.isEmpty()}, {"currentDraft", currentDraft}};
    setNotice(text);
}
void RuntimeBridge::setPermissionFeedback(const QString &key, const QString &status,
                                          const QString &text, const QString &action,
                                          const QString &requestId) {
    m_permissionFeedback[key] = QVariantMap{{"status", status}, {"text", text},
                                            {"action", action}, {"requestId", requestId}};
    emit changed();
}
void RuntimeBridge::setMemoryFeedback(const QString &key, const QString &status,
                                      const QString &text, const QString &requestId,
                                      const QVariantMap &extra) {
    auto feedback = extra;
    feedback.insert({{"status", status}, {"text", text}, {"requestId", requestId}});
    m_memoryFeedback[key] = feedback;
    emit changed();
}
void RuntimeBridge::setSettingsFeedback(const QString &key, const QString &status,
                                        const QString &text, const QString &requestId,
                                        const QVariantMap &fields) {
    m_settingsFeedback[key] = QVariantMap{{"status", status}, {"text", text},
                                          {"requestId", requestId}, {"fields", fields}};
    emit changed();
}
QVariantMap RuntimeBridge::budgetState() const {
    auto state = m_budgetState;
    const bool live = state.value("status").toString() == "success" && m_connected && !m_stopping &&
        !personaChanging() && m_budgetReadGeneration == m_generation && m_budgetReadPersona == m_persona;
    state["live"] = live;
    state["stale"] = !live;
    state["readDispatchCount"] = m_budgetDispatchGeneration == m_generation ? m_budgetReadDispatchCount : 0;
    return state;
}
void RuntimeBridge::invalidateBudget(const QString &text) {
    // A retained ledger snapshot is display history, never proof for a new scope/read.
    for (auto it = m_pending.begin(); it != m_pending.end();)
        if (it->command == "api:budget:get")
            it = m_pending.erase(it);
        else
            ++it;
    m_budgetReadId.clear();
    m_budgetReadPersona = {};
    m_budgetReadGeneration = -1;
    m_budgetState.insert({{"status", "error"}, {"text", text}, {"live", false}, {"stale", true}});
}
void RuntimeBridge::refreshBudget() { request("api:budget:get"); }
void RuntimeBridge::applyBudgetRead(const QString &type, const QJsonObject &payload,
                                     const QString &requestId) {
    if (requestId.isEmpty() || requestId != m_budgetReadId || m_budgetReadGeneration != m_generation ||
        m_budgetReadPersona != m_persona)
        return;
    if (type != "api:budget:result" || !validBudgetSnapshot(payload)) {
        invalidateBudget("用量暂时读不到，请刷新后重试。");
        return;
    }
    const auto snapshot = payload.toVariantMap();
    m_state["budget"] = snapshot;
    m_budgetState.insert({{"status", "success"}, {"text", "今日后台用量已刷新。"},
        {"live", true}, {"stale", false}, {"snapshot", snapshot}});
}
void RuntimeBridge::resetPersonaState() {
    unknownWorldbookFile();
    invalidatePersonaProfile();
    // Avatars are app-wide and re-listed only by avatar actions; the avatar
    // does not change with the persona, so a new identity keeps the list.
    const auto avatars = m_state.value("avatars");
    m_state.clear();
    clearDiary();
    clearKeepsakes();
    clearProactiveHistory();
    resetChatImages(true);
    cancelRelationshipRead();
    m_relationshipDisplay.clear();
    m_lastRelationshipDisplay.clear();
    cancelMoodRead();
    m_moodDisplay.clear();
    m_lastMoodDisplay.clear();
    m_profileClearState.clear();
    m_profileClearProfile = {};
    m_profileClearReceipt = {};
    m_profileReadId.clear();
    m_profileSnapshotScope.clear();
    m_profileSnapshotGeneration = -1;
    // The memory list, its filter and its cursor belong to the previous identity.
    m_memoryQuery.clear();
    m_memoryListId.clear();
    m_memoryListQuery.clear();
    m_memoryMoreId.clear();
    m_memoryCursor.clear();
    m_memoryListLive = false;
    m_memoryBatchDelete.clear();
    invalidateMemoryPinConnection(true);
    invalidateCandidateBatchConnection(true);
    ++m_memoryListRevision;
    invalidateCandidatePaging(true);
    invalidateMemoryRecall(true);
    invalidateSummaryDirectory();
    invalidateSummaryDetail();
    invalidateBudget("人格已切换，用量需要重新读取。");
    m_state["offline"] = m_offline;
    if (avatars.isValid())
        m_state["avatars"] = avatars;
    clearGame();
    if (gamePanelOpen())
        gameRead();
}
void RuntimeBridge::setPersonaFeedback(const QString &status, const QString &text,
                                       const QString &requestId) {
    m_personaFeedback = {{"status", status}, {"text", text}, {"requestId", requestId}};
    emit changed();
}
void RuntimeBridge::setPersonaCardFeedback(const QString &status, const QString &text,
                                         const QString &requestId, const QVariantMap &extra) {
    m_personaCardFeedback = extra;
    m_personaCardFeedback.insert({{"status", status}, {"text", text}, {"requestId", requestId}});
    emit changed();
}
void RuntimeBridge::clearPersonaCardCandidate() {
    m_personaCardJson.clear();
    m_personaCardCandidate.clear();
    if (QStringList{"preview", "confirmation"}.contains(m_personaCardFeedback.value("status").toString()))
        m_personaCardFeedback.clear();
    emit changed();
}
void RuntimeBridge::forgetPersonaCardImport(const QString &text) {
    if (m_personaImport.isEmpty())
        return;
    const auto id = m_personaImport.value("requestId").toString();
    auto details = m_personaCardFeedback;
    details.remove("status");
    details.remove("text");
    details.remove("requestId");
    m_pending.remove(id);
    m_pending.remove(m_personaImport.value("verifyId").toString());
    m_personaImport.clear();
    m_personaImportReceipt = {};
    setPersonaCardFeedback("unknown", text, id, details);
}
bool RuntimeBridge::personaCardActionAllowed() {
    if (!m_personaImport.isEmpty() || !m_personaSwitch.isEmpty() || personaCardExportPending() || personaProfilePending() || worldbookFileBusy())
        return false;
    if (!m_connected) {
        setPersonaCardFeedback("error", "本地服务尚未连接，角色卡操作未能发送。");
        return false;
    }
    if (!runtimeWritable()) {
        setPersonaCardFeedback("error", "写入已锁定，角色卡操作未能发送。");
        return false;
    }
    if (m_busy) {
        setPersonaCardFeedback("error", "回复进行中；请等它完成或停止后再导入角色卡。");
        return false;
    }
    return true;
}
void RuntimeBridge::observePersonaCardIdentity(const QJsonObject &proof, const QJsonObject &payload) {
    unknownPersonaCardExport();
    unknownWorldbookFile();
    clearPersonaCardCandidate();
    if (m_personaImport.isEmpty())
        return;
    const auto source = obj(m_personaImport.value("sourceProof").toMap());
    const auto observed = obj(m_personaImport.value("observedProof").toMap());
    // Bind this one operation to its exact target. A later identity can never
    // reuse the old request's result, even if the same card is selected again.
    if (observed.isEmpty() && m_persona == source &&
        proof["persona_id"].toString() == m_personaImport.value("targetId").toString() &&
        proof["epoch"].toInt() == source["epoch"].toInt() + 1 &&
        !proof["fingerprint"].toString().isEmpty()) {
        m_personaImport["observedProof"] = proof.toVariantMap();
        m_personaImport["restartRequired"] = payload["restart_required"].toBool();
        const auto name = payload["persona"].toObject()["name"].toString(payload["name"].toString());
        if (!name.isEmpty())
            m_personaImport["targetName"] = name;
        setPersonaCardFeedback("pending", "已观察到新身份，正在等待角色卡导入的完成回执…",
                               m_personaImport.value("requestId").toString());
    } else if (observed != proof) {
        forgetPersonaCardImport("人格在导入期间发生了其他变化，导入结果未确认；请核对当前人格和列表。");
    }
}
void RuntimeBridge::settlePersonaCardReceipt() {
    if (m_personaImport.isEmpty() || m_personaImportReceipt.isEmpty())
        return;
    const auto payload = m_personaImportReceipt;
    const auto id = m_personaImport.value("requestId").toString();
    const auto target = m_personaImport.value("targetId").toString();
    const bool saved = payload["saved"].toBool();
    const bool activated = payload["activated"].toBool();
    const bool ready = payload["runtime_ready"].toBool();
    const bool partial = payload["partial_write"].toBool();
    QVariantMap details{{"saved", saved}, {"activated", activated}, {"runtimeReady", ready},
                        {"partialWrite", partial}, {"cardId", payload["card_id"].toString()},
                        {"warnings", payload["warnings"].toArray().toVariantList()},
                        {"quarantinedFields", payload["ignored_fields"].toArray().size()},
                        {"ignoredFields", payload["ignored_fields"].toArray().toVariantList()},
                        {"code", payload["code"].toString()},
                        {"worldBookEntries", payload["world_book_entry_count"].toInt()},
                        {"worldBookImported", payload["world_book_imported"].toBool()},
                        {"archiveWarning", payload["archive_warning"].toString(payload["world_book_warning"].toString())}};
    auto clearOperation = [this, id] {
        m_pending.remove(id);
        m_pending.remove(m_personaImport.value("verifyId").toString());
        m_personaImport.clear();
        m_personaImportReceipt = {};
    };
    const auto code = payload["code"].toString();
    const auto observed = obj(m_personaImport.value("observedProof").toMap());
    const bool internalError = code == "internal_error" ||
        payload["activation"].toObject()["code"].toString() == "internal_error";
    // An activation error can happen after the durable commit. Its false
    // acknowledgement cannot prove a non-switch, especially once the target
    // identity has already been observed.
    if (payload["activation_unknown"].toBool() || internalError || (!observed.isEmpty() && !activated)) {
        if (internalError)
            details["code"] = "internal_error";
        details["activationUnknown"] = true;
        clearOperation();
        setPersonaCardFeedback("unknown", saved
            ? "角色卡已保存，但身份切换或导入完成情况未确认；正在核对当前人格，未自动重试。"
            : "角色卡导入与身份切换结果未确认；正在核对当前人格，未自动重试。", id, details);
        request("persona:get");
        refreshPersonas();
        return;
    }
    if (partial) {
        clearOperation();
        setPersonaCardFeedback("partial", code == "local_profile_conflict"
            ? "本地已有同一卡片的残留文件，已保留且未覆盖；没有确认保存或切换，请核对本地数据。"
            : "角色卡保存未完整提交，可能已留下部分文件；没有确认切换。请核对本地数据。", id, details);
        refreshPersonas();
        return;
    }
    if (code == "already_imported") {
        clearOperation();
        setPersonaCardFeedback("error", "这张角色卡已在本地列表中；请从列表选择并切换。", id, details);
        refreshPersonas();
        refreshVisiblePersonaStatus();
        return;
    }
    if (saved && !activated) {
        clearOperation();
        setPersonaCardFeedback("saved", payload["world_book_entry_count"].toInt() > 0
            ? "角色卡已保存，但未切换为当前人格；卡内世界书没有写入。请核对列表后选择切换。"
            : "角色卡已保存，但未切换为当前人格。请核对列表后选择切换。", id, details);
        refreshPersonas();
        return;
    }
    if (!payload["ok"].toBool() && code != "internal_error" &&
        (payload["saved"].isBool() && payload["partial_write"].isBool())) {
        const auto reason = payload["error"].toString(payload["message"].toString("后端核验未通过。"));
        clearOperation();
        setPersonaCardFeedback("error", "角色卡导入被拒绝：" + reason, id, details);
        if (code == "identity_conflict")
            refresh(m_relationshipPageVisible);
        else
            refreshVisiblePersonaStatus();
        return;
    }
    const QJsonObject receiptProof{{"persona_id", payload["persona_id"]},
                                    {"epoch", payload["persona_epoch"]},
                                    {"fingerprint", payload["persona_fingerprint"]}};
    if (payload["ok"].toBool() && saved && activated && ready &&
        receiptProof["persona_id"].toString() == target && receiptProof == observed &&
        observed == m_persona && runtimeWritable() &&
        !m_personaImport.value("restartRequired").toBool()) {
        const auto name = payload["name"].toString(m_personaImport.value("targetName").toString());
        // The archive warning is the backend's account of this attachment
        // step itself, so it is the one free-text line kept.
        const auto archiveWarning = details.value("archiveWarning").toString();
        QString text = QString("已导入并切换为「%1」。").arg(name) + cardImportNotes(payload, archiveWarning.isEmpty());
        if (!archiveWarning.isEmpty())
            text += "资料写入提示：" + archiveWarning + "。";
        const bool archiveIncomplete = !archiveWarning.isEmpty() ||
            (payload["world_book_entry_count"].toInt() > 0 && !payload["world_book_imported"].toBool());
        clearOperation();
        setPersonaCardFeedback(archiveIncomplete ? "partial" : "success", text, id, details);
        return;
    }
    // The acknowledgement can precede an identity read. Keep it sealed to this
    // operation while reading the live identity; a broadcast alone never wins.
    if (payload["ok"].toBool() && saved && activated && ready && observed.isEmpty() &&
        receiptProof["persona_id"].toString() == target &&
        receiptProof["epoch"].toInt() == obj(m_personaImport.value("sourceProof").toMap())["epoch"].toInt() + 1 &&
        !receiptProof["fingerprint"].toString().isEmpty()) {
        setPersonaCardFeedback("pending", "已收到导入完成回执，正在核对新身份…", id, details);
        if (m_personaImport.value("verifyId").toString().isEmpty())
            m_personaImport["verifyId"] = request("persona:get");
        return;
    }
    clearOperation();
    QString text = saved && activated ? "角色卡已保存且身份已提交，但运行状态或档案导入未确认；请核对当前人格。"
                                     : "角色卡导入结果未确认；请核对当前人格和列表，未自动重试。";
    setPersonaCardFeedback("unknown", text, id, details);
    request("persona:get");
    refreshPersonas();
}
void RuntimeBridge::finishPersonaCardImport(const QString &type, const QJsonObject &payload,
                                          const QString &id) {
    if (!m_connected || m_personaImport.value("requestId").toString() != id)
        return;
    const auto source = obj(m_personaImport.value("sourceProof").toMap());
    const auto observed = obj(m_personaImport.value("observedProof").toMap());
    if ((observed.isEmpty() && m_persona != source) || (!observed.isEmpty() && m_persona != observed))
        return;
    if (payload.contains("card_id") && payload["card_id"].toString() != m_personaImport.value("targetId").toString())
        return;
    if (payload["activated"].toBool()) {
        const QJsonObject proof{{"persona_id", payload["persona_id"]}, {"epoch", payload["persona_epoch"]},
                                {"fingerprint", payload["persona_fingerprint"]}};
        if (proof["persona_id"].toString() != m_personaImport.value("targetId").toString() ||
            proof["epoch"].toInt() != source["epoch"].toInt() + 1 || proof["fingerprint"].toString().isEmpty() ||
            (!observed.isEmpty() && proof != observed))
            return;
    } else if (payload.contains("persona_id")) {
        const QJsonObject proof{{"persona_id", payload["persona_id"]}, {"epoch", payload["persona_epoch"]},
                                {"fingerprint", payload["persona_fingerprint"]}};
        const bool uncertainCommit = payload["activation_unknown"].toBool() ||
            payload["code"].toString() == "internal_error" ||
            payload["activation"].toObject()["code"].toString() == "internal_error";
        const bool possibleTarget = observed.isEmpty() && uncertainCommit &&
            proof["persona_id"].toString() == m_personaImport.value("targetId").toString() &&
            proof["epoch"].toInt() == source["epoch"].toInt() + 1 &&
            !proof["fingerprint"].toString().isEmpty();
        if (proof != source && (observed.isEmpty() || proof != observed) && !possibleTarget)
            return;
    }
    m_pending.remove(id);
    m_personaImportReceipt = payload;
    if (type == "error")
        m_personaImportReceipt["code"] = "internal_error";
    settlePersonaCardReceipt();
    emit responseReceived(id, "persona:import", payload.toVariantMap(), m_generation);
    emit commandResult("persona:import", payload.toVariantMap());
}
void RuntimeBridge::settlePersonaSwitch(bool restartRequired) {
    if (m_personaSwitch.isEmpty()) {
        m_personaFeedback.clear();
        return;
    }
    const auto name = m_personaSwitch.value("targetName").toString();
    const auto id = m_personaSwitch.value("requestId").toString();
    m_personaSwitch.clear();
    if (restartRequired)
        setPersonaFeedback("unknown", "已写入新身份，但运行时未能热切换；请完全退出后重新打开。", id);
    // The backend reports writability before the identity it settles on; a
    // switch that left writes locked is not a completed switch.
    else if (!runtimeWritable())
        setPersonaFeedback("unknown", QString("已切换为「%1」，但本地数据随后被锁定为只读；请按页面上的恢复提示处理。").arg(name), id);
    else
        setPersonaFeedback("success", QString("已切换为「%1」。记忆、聊天和日记按这个人格分开保存。").arg(name), id);
}
void RuntimeBridge::finishPersonaActivation(const QString &type, const QJsonObject &payload,
                                            const QString &id) {
    if (m_personaSwitch.value("requestId").toString() != id)
        return;
    const auto code = payload["code"].toString();
    if (type == "persona:import:result" && payload["ok"].toBool() && payload["activated"].toBool()) {
        // The live broadcast normally resets the scope before this reply;
        // read the identity back if it did not.
        setPersonaFeedback("pending", "已切换，正在读取新身份…", id);
        m_personaSwitch["verifyId"] = request("persona:get");
        return;
    }
    if (type == "persona:import:result" && payload["ok"].isBool() && !payload["ok"].toBool() &&
        code != "internal_error") {
        // A refusal is decided before the identity commit.
        m_personaSwitch.clear();
        if (code == "identity_conflict") {
            setPersonaFeedback("error", "人格已在别处变化；状态已刷新，没有切换。", id);
            refresh();
        } else if (code == "BACKUP_RECOVERY_REQUIRED") {
            setPersonaFeedback("error", "写入已锁定，没有切换人格。", id);
        } else {
            setPersonaFeedback("error", "切换未完成，当前人格没有改变；这个人格档案可能已损坏或已移除。", id);
            request("persona:list");
        }
        return;
    }
    // Storage or transport failures leave the outcome open; the live identity decides.
    setPersonaFeedback("unknown", "切换结果未确认，正在核对当前人格…", id);
    m_personaSwitch["verifyId"] = request("persona:get");
}
bool RuntimeBridge::memoryRequestPending(const QString &key) const {
    const auto feedback = m_memoryFeedback.value(key).toMap();
    return feedback.value("status").toString() == "pending" &&
           m_pending.contains(feedback.value("requestId").toString());
}
bool RuntimeBridge::memoryBatchDeleteBlocked() const {
    return QStringList{"sending", "pending", "unknown"}.contains(
        m_memoryBatchDelete.value("status").toString());
}
QVariantMap RuntimeBridge::memoryBatchDelete() const {
    const auto status = m_memoryBatchDelete.value("status", "idle").toString();
    return {{"status", status}, {"busy", status == "sending" || status == "pending"},
        {"unknown", status == "unknown"}, {"blocked", memoryBatchDeleteBlocked()},
        {"requestId", m_memoryBatchDelete.value("requestId")},
        {"scopeKey", m_memoryBatchDelete.value("scopeKey")},
        {"generation", m_memoryBatchDelete.value("generation", -1)}};
}
void RuntimeBridge::unknownMemoryBatchDelete() {
    if (!QStringList{"sending", "pending", "unknown"}.contains(
            m_memoryBatchDelete.value("status").toString()))
        return;
    // Late acknowledgements cannot replace the explicit read needed to unlock.
    m_pending.remove(m_memoryBatchDelete.value("requestId").toString());
    m_memoryBatchDelete["status"] = "unknown";
    m_memoryBatchDelete.remove("manualReadId");
    m_memoryBatchDelete.remove("readScope");
    m_memoryBatchDelete.remove("readGeneration");
    setMemoryFeedback("action", "unknown", "批量删除结果未知，请手动刷新核对；未自动重试。",
        m_memoryBatchDelete.value("requestId").toString(), {{"verb", "批量删除记忆"}});
}
void RuntimeBridge::finishMemoryBatchDelete(const QString &type, const QJsonObject &payload,
                                           const QString &requestId) {
    if (requestId != m_memoryBatchDelete.value("requestId").toString() ||
        m_memoryBatchDelete.value("generation").toInt() != m_generation ||
        m_memoryBatchDelete.value("scopeKey").toString() != scopeKey() ||
        m_memoryBatchDelete.value("status").toString() != "pending")
        return;
    const auto ids = m_memoryBatchDelete.value("memoryIds").toList();
    const auto errorCode = payload["error_code"].toString();
    const bool internalError = errorCode == "internal_error" || payload["code"] == "internal_error";
    const bool valid = type == "memory:result" && payload["ok"].isBool() && !internalError &&
        (!payload.contains("request_id") ||
         (payload["request_id"].isString() && payload["request_id"].toString() == requestId));
    const auto purged = payload["purged_revisions"];
    const bool validPurged = !payload.contains("purged_revisions") ||
        (purged.isDouble() && std::isfinite(purged.toDouble()) && purged.toDouble() >= ids.size() &&
         purged.toDouble() == std::floor(purged.toDouble()));
    const bool success = valid && payload["ok"].toBool() && validPurged &&
        !payload.contains("error") && !payload.contains("error_code") && !payload.contains("code") &&
        payload["deleted_ids"].isArray() &&
        payload["deleted_ids"].toArray() == QJsonArray::fromVariantList(ids);
    const bool rejected = valid && !payload["ok"].toBool() &&
        !payload.contains("deleted_ids") && !payload.contains("purged_revisions") &&
        ((payload["error_code"].isString() && !errorCode.isEmpty() && errorCode == errorCode.trimmed() &&
          (!payload.contains("code") || payload["code"] == payload["error_code"])) ||
         memoryBatchPrewriteRejection(type, payload));
    if (!success && !rejected) {
        unknownMemoryBatchDelete();
        return;
    }
    m_memoryBatchDelete["status"] = success ? "success" : "rejected";
    setMemoryFeedback("action", success ? "success" : "error", success
        ? QString("已删除%1条记忆。").arg(ids.size())
        : errorCode == "stale_selection"
        ? QString("所选记忆已有变化，没有删除任何一条；已刷新列表。")
        : QString("批量删除未执行，没有删除任何一条；已刷新列表。"), requestId,
        {{"verb", "批量删除记忆"}});
    readMemories(true);
    m_memoryBatchDelete["readRequestId"] = m_memoryListId;
    emit changed();
}
void RuntimeBridge::settleMemoryBatchDeleteRead(const QString &requestId, bool success) {
    if (m_memoryBatchDelete.value("status").toString() != "unknown" ||
        m_memoryBatchDelete.value("manualReadId").toString() != requestId ||
        m_memoryBatchDelete.value("readGeneration").toInt() != m_generation ||
        m_memoryBatchDelete.value("readScope").toString() != scopeKey())
        return;
    m_memoryBatchDelete.remove("manualReadId");
    if (!success) {
        unknownMemoryBatchDelete();
        return;
    }
    m_memoryBatchDelete["status"] = "refreshed";
    setMemoryFeedback("action", "refreshed", "记忆列表已刷新；请按当前内容核对先前的批量删除结果。",
        m_memoryBatchDelete.value("requestId").toString(), {{"verb", "批量删除记忆"}});
}
bool RuntimeBridge::memoryBatchPinBlocked() const {
    return QStringList{"previewing", "ready", "sending", "pending", "reading", "unknown"}.contains(
        m_memoryBatchPin.value("status").toString());
}
bool RuntimeBridge::memoryPinOtherWritePending() const {
    if (memoryRequestPending("action") || memoryBatchDeleteBlocked() || candidateDecisionLocked() ||
        candidateBatchBlocked())
        return true;
    for (const auto &pending : m_pending)
        if (pending.generation == m_generation &&
            QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                        "memory:pin_many", "memory:candidates:confirm", "memory:candidates:reject",
                        "memory:candidates:decide_many"}.contains(pending.command))
            return true;
    return false;
}
QVariantMap RuntimeBridge::memoryBatchPin() const {
    auto result = m_memoryBatchPin;
    const auto status = result.value("status", "idle").toString();
    const bool current = result.value("scopeKey").toString() == scopeKey() &&
        result.value("generation", -1).toInt() == m_generation &&
        result.value("listRevision", -1).toInt() == m_memoryListRevision;
    result.insert({{"status", status}, {"ids", result.value("ids", QVariantList{})},
        {"pinned", result.value("pinned", false)}, {"scopeKey", result.value("scopeKey", "")},
        {"generation", result.value("generation", -1)}, {"listRevision", result.value("listRevision", -1)},
        {"previewRequestId", result.value("previewRequestId", "")}, {"requestId", result.value("requestId", "")},
        {"statusReadId", result.value("statusReadId", "")}, {"listReadId", result.value("listReadId", "")},
        {"selectedCount", result.value("ids").toList().size()},
        {"expectedChangedCount", result.value("expectedChangedCount", 0)},
        {"unchangedCount", result.value("unchangedCount", 0)},
        {"pinnedTotal", result.value("pinnedTotal", -1)}, {"pinLimit", 20},
        {"actualChangedCount", result.value("actualChangedCount", 0)},
        {"text", result.value("text", "")},
        {"busy", QStringList{"previewing", "sending", "pending", "reading"}.contains(status)},
        {"blocked", memoryBatchPinBlocked()},
        {"confirmationReady", status == "ready" && current && runtimeWritable() && !personaChanging() &&
            m_memoryListLive && result.value("expectedChangedCount").toInt() > 0 && !memoryPinOtherWritePending() &&
            (!result.value("pinned").toBool() || qint64(result.value("pinnedTotal").toInt()) +
                result.value("expectedChangedCount").toInt() <= 20)},
        {"preserveSelection", result.value("preserveSelection").toBool() && current &&
            !result.value("listReadId").toString().isEmpty() &&
            QStringList{"reading", "unknown"}.contains(status)},
        {"dispatchCount", QVariant::fromValue(m_memoryBatchPinDispatchCount)},
        {"statusReadDispatchCount", QVariant::fromValue(m_memoryPinStatusDispatchCount)}});
    return result;
}
void RuntimeBridge::failMemoryPinPreview(const QString &text) {
    m_pending.remove(m_memoryBatchPin.value("previewRequestId").toString());
    m_memoryBatchPin["status"] = "preview_error";
    m_memoryBatchPin["text"] = text;
    m_memoryBatchPin["preserveSelection"] = false;
    emit changed();
}
void RuntimeBridge::cancelMemoryPinPreview() {
    if (!QStringList{"previewing", "ready", "preview_error", "rejected"}.contains(
            m_memoryBatchPin.value("status").toString()))
        return;
    m_pending.remove(m_memoryBatchPin.value("previewRequestId").toString());
    m_memoryBatchPin.clear();
    m_memoryPinReadStates.clear();
    emit changed();
}
void RuntimeBridge::previewMemoryPins(const QVariantList &ids, bool pinned) {
    if (memoryBatchPinBlocked())
        return;
    if (memoryPinOtherWritePending()) {
        setNotice("另一个记忆操作仍在核对中，请完成后再预览批量固定。");
        return;
    }
    m_memoryBatchPin = {{"status", "previewing"}, {"ids", ids}, {"pinned", pinned},
        {"scopeKey", scopeKey()}, {"generation", m_generation}, {"listRevision", m_memoryListRevision},
        {"text", "正在核对所选记忆的固定状态…"}};
    m_memoryPinReadStates.clear();
    if (!runtimeWritable() || personaChanging())
        return failMemoryPinPreview("当前暂不能写入记忆，请核对连接和人格后重新预览。");
    if (!m_memoryListLive || m_pending.contains(m_memoryListId) || m_pending.contains(m_memoryMoreId) ||
        m_state.value("memory").toMap().value("query").toString() != m_memoryQuery)
        return failMemoryPinPreview("当前记忆列表尚未完整读取，请等待或刷新后重新预览。");
    if (ids.isEmpty() || ids.size() > 100)
        return failMemoryPinPreview("每次请选择 1–100 条记忆；记忆没有改动。");
    QHash<QString, int> shown;
    for (const auto &value : m_state.value("memory").toMap().value("memories").toList())
        ++shown[value.toMap().value("id").toString()];
    static const QRegularExpression pattern("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
    QSet<QString> unique;
    for (const auto &value : ids) {
        const auto id = value.toString();
        if (value.metaType().id() != QMetaType::QString || !pattern.match(id).hasMatch() ||
            unique.contains(id) || shown.value(id) != 1)
            return failMemoryPinPreview("所选记忆无效或不在当前列表中，请刷新后重新选择。");
        unique.insert(id);
    }
    m_memoryPinStatusSending = true;
    const auto id = request("memory:pin_status", {{"memory_ids", ids}});
    m_memoryPinStatusSending = false;
    if (id.isEmpty())
        return failMemoryPinPreview("固定状态请求未能发送，请核对连接后重新预览。");
    emit changed();
}
void RuntimeBridge::confirmMemoryPins() {
    if (m_memoryBatchPin.value("status").toString() != "ready")
        return;
    if (!memoryBatchPin().value("confirmationReady").toBool()) {
        if (m_memoryBatchPin.value("scopeKey").toString() == scopeKey() &&
            m_memoryBatchPin.value("generation").toInt() == m_generation &&
            m_memoryBatchPin.value("listRevision").toInt() == m_memoryListRevision &&
            (m_memoryBatchPin.value("expectedChangedCount").toInt() == 0 ||
             (m_memoryBatchPin.value("pinned").toBool() &&
              qint64(m_memoryBatchPin.value("pinnedTotal").toInt()) +
                m_memoryBatchPin.value("expectedChangedCount").toInt() > 20)))
            return;
        return failMemoryPinPreview("所选记忆或列表已变化，请重新预览后确认。");
    }
    m_memoryBatchPin["status"] = "sending";
    m_memoryBatchPin["text"] = "正在提交批量固定操作…";
    const auto id = request("memory:pin_many", {{"memory_ids", m_memoryBatchPin.value("ids")},
                                                {"pinned", m_memoryBatchPin.value("pinned")}});
    if (id.isEmpty()) {
        if (m_memoryBatchPin.value("status").toString() != "unknown")
            failMemoryPinPreview("批量固定请求未能发送，请重新预览后确认。");
        return;
    }
    emit changed();
}
void RuntimeBridge::unknownMemoryBatchPin() {
    if (!QStringList{"sending", "pending", "reading", "unknown"}.contains(
            m_memoryBatchPin.value("status").toString()))
        return;
    const auto listId = m_memoryBatchPin.value("listReadId").toString();
    const auto listReceipt = m_memoryFeedback.value("list").toMap();
    for (const auto &field : QStringList{"requestId", "statusReadId", "listReadId"})
        m_pending.remove(m_memoryBatchPin.value(field).toString());
    m_memoryBatchPin["status"] = "unknown";
    m_memoryBatchPin["text"] = "批量固定结果未知，请手动刷新核对；未自动重试。";
    m_memoryBatchPin["statusFresh"] = false;
    m_memoryBatchPin["listFresh"] = false;
    m_memoryPinReadStates.clear();
    if (!listId.isEmpty() && m_memoryListId == listId)
        m_memoryListId.clear();
    if (!listId.isEmpty() && listReceipt.value("requestId").toString() == listId &&
        listReceipt.value("status").toString() == "pending")
        setMemoryFeedback("list", "unknown", "当前记忆尚未完整读回，请手动刷新核对。", listId);
    emit changed();
}
void RuntimeBridge::invalidateMemoryPinConnection(bool scopeChanged) {
    if (scopeChanged) {
        for (const auto &field : QStringList{"previewRequestId", "requestId", "statusReadId", "listReadId"})
            m_pending.remove(m_memoryBatchPin.value(field).toString());
        m_memoryBatchPin.clear();
        m_memoryPinReadStates.clear();
    } else if (QStringList{"previewing", "ready"}.contains(m_memoryBatchPin.value("status").toString())) {
        failMemoryPinPreview("连接已变化，请刷新列表后重新预览固定状态。");
    } else {
        unknownMemoryBatchPin();
    }
}
void RuntimeBridge::applyMemoryPinStatus(const QString &type, const QJsonObject &payload, const QString &id) {
    const bool preview = m_memoryBatchPin.value("status").toString() == "previewing" &&
        id == m_memoryBatchPin.value("previewRequestId").toString();
    const bool reading = m_memoryBatchPin.value("status").toString() == "reading" &&
        id == m_memoryBatchPin.value("statusReadId").toString();
    if ((!preview && !reading) || m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
        m_memoryBatchPin.value("generation").toInt() != m_generation)
        return;
    if (reading && m_memoryBatchPin.value("listRevision").toInt() != m_memoryListRevision)
        return unknownMemoryBatchPin();
    QVariantMap states;
    int total = 0;
    QSet<QString> stale;
    const auto ids = m_memoryBatchPin.value("ids").toList();
    if (!pinStatusSnapshot(type, payload, ids, &states, &total, &stale)) {
        if (preview)
            failMemoryPinPreview("所选记忆的固定状态未获完整确认，请重新预览。");
        else
            unknownMemoryBatchPin();
        return;
    }
    const bool pinned = m_memoryBatchPin.value("pinned").toBool();
    if (preview) {
        if (m_memoryBatchPin.value("listRevision").toInt() != m_memoryListRevision || !m_memoryListLive)
            return failMemoryPinPreview("记忆列表已变化，请重新预览后确认。");
        if (!stale.isEmpty())
            return failMemoryPinPreview("所选记忆已有变化，请刷新列表后重新选择。");
        int changedCount = 0;
        for (const auto &value : states)
            changedCount += value.toBool() != pinned;
        m_memoryBatchPin.insert({{"expectedChangedCount", changedCount}, {"unchangedCount", ids.size() - changedCount},
            {"pinnedTotal", total}});
        m_memoryBatchPin["status"] = "ready";
        m_memoryBatchPin["text"] = pinned && changedCount > 0 && qint64(total) + changedCount > 20
            ? QString("固定总数将超过 20 条，请减少选择或先取消固定。")
            : changedCount == 0 ? QString("所选记忆均已处于目标状态，无需修改。")
            : QString("已核对 %1 条，将%2 %3 条，%4 条无需修改；当前共固定 %5 / 20 条。")
                .arg(ids.size()).arg(pinned ? QString("固定") : QString("取消固定"))
                .arg(changedCount).arg(ids.size() - changedCount).arg(total);
        emit changed();
        return;
    }
    if (!m_memoryBatchPin.value("manual").toBool()) {
        if (!stale.isEmpty())
            return unknownMemoryBatchPin();
        for (const auto &value : states)
            if (value.toBool() != pinned)
                return unknownMemoryBatchPin();
    }
    m_memoryPinReadStates = states;
    m_memoryBatchPin["pinnedTotal"] = total;
    m_memoryBatchPin["statusFresh"] = true;
    settleMemoryBatchPinReads();
}
void RuntimeBridge::finishMemoryBatchPin(const QString &type, const QJsonObject &payload, const QString &id) {
    if (m_memoryBatchPin.value("status").toString() != "pending" ||
        m_memoryBatchPin.value("requestId").toString() != id ||
        m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
        m_memoryBatchPin.value("generation").toInt() != m_generation)
        return;
    const auto ids = m_memoryBatchPin.value("ids").toList();
    const bool pinned = m_memoryBatchPin.value("pinned").toBool();
    const bool envelope = type == "memory:result" && payload["ok"].isBool() &&
        (!payload.contains("request_id") || payload["request_id"] == id);
    const auto code = payload["error_code"].toString();
    const bool rejected = envelope && !payload["ok"].toBool() &&
        QStringList{"stale_selection", "pin_limit_exceeded", "memory_unavailable"}.contains(code) &&
        (!payload.contains("code") || payload["code"] == payload["error_code"]) &&
        (!payload.contains("error") || payload["error"].isString()) &&
        (!payload.contains("memory_ids") || (payload["memory_ids"].isArray() &&
            payload["memory_ids"].toArray() == QJsonArray::fromVariantList(ids))) &&
        (!payload.contains("pinned") || (payload["pinned"].isBool() && payload["pinned"].toBool() == pinned)) &&
        (!payload.contains("pin_limit") || (pinCount(payload["pin_limit"]) && payload["pin_limit"].toInt() == 20)) &&
        !payload.contains("changed_ids") && !payload.contains("unchanged_ids") &&
        !payload.contains("pinned_total_before") && !payload.contains("pinned_total_after");
    if (rejected) {
        m_memoryBatchPin["status"] = "rejected";
        m_memoryBatchPin["preserveSelection"] = false;
        m_memoryBatchPin["text"] = code == "pin_limit_exceeded"
            ? "固定总数已变化并超过上限，本次未修改；请重新预览。"
            : "所选记忆暂不能修改，本次未修改；请刷新或重新预览。";
        emit changed();
        return;
    }
    QSet<QString> changed, unchanged;
    bool success = envelope && payload["ok"].toBool() && !payload.contains("error") &&
        !payload.contains("error_code") && !payload.contains("code") &&
        payload["memory_ids"].isArray() && payload["memory_ids"].toArray() == QJsonArray::fromVariantList(ids) &&
        payload["pinned"].isBool() && payload["pinned"].toBool() == pinned &&
        pinCount(payload["pin_limit"]) && payload["pin_limit"].toInt() == 20 &&
        pinCount(payload["pinned_total_before"]) && pinCount(payload["pinned_total_after"]) &&
        pinIdArray(payload["changed_ids"], ids, &changed, true) &&
        pinIdArray(payload["unchanged_ids"], ids, &unchanged, true) &&
        changed.size() + unchanged.size() == ids.size();
    for (const auto &entry : changed)
        success = success && !unchanged.contains(entry);
    const qint64 before = payload["pinned_total_before"].toInt(), after = payload["pinned_total_after"].toInt();
    success = success && after == before + (pinned ? qint64(changed.size()) : -qint64(changed.size()));
    // Pinning may be idempotent above the cap, but a new pin cannot cross it.
    success = success && (!pinned || changed.isEmpty() || after <= 20);
    if (!success)
        return unknownMemoryBatchPin();
    m_memoryBatchPin["actualChangedCount"] = changed.size();
    m_memoryBatchPin["unchangedCount"] = unchanged.size();
    m_memoryBatchPin["pinnedTotal"] = after;
    readMemoryBatchPin(false);
}
void RuntimeBridge::readMemoryBatchPin(bool manual) {
    const auto status = m_memoryBatchPin.value("status").toString();
    if (!m_connected || m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
        (manual ? status != "unknown" : status != "pending"))
        return;
    m_pending.remove(m_memoryBatchPin.value("statusReadId").toString());
    m_pending.remove(m_memoryBatchPin.value("listReadId").toString());
    m_memoryBatchPin.insert({{"status", "reading"}, {"manual", manual}, {"generation", m_generation},
        {"preserveSelection", true}, {"statusFresh", false}, {"listFresh", false},
        {"statusReadId", ""}, {"listReadId", ""},
        {"text", manual ? "正在读取当前固定状态和记忆列表…" : "已收到回执，正在完整核对固定状态和记忆列表…"}});
    m_memoryPinReadStates.clear();
    m_memoryPinStatusSending = true;
    const auto statusId = request("memory:pin_status", {{"memory_ids", m_memoryBatchPin.value("ids")}});
    m_memoryPinStatusSending = false;
    m_memoryPinListSending = true;
    const auto listId = startMemoryList();
    m_memoryPinListSending = false;
    if (statusId.isEmpty() || listId.isEmpty())
        unknownMemoryBatchPin();
    emit changed();
}
void RuntimeBridge::settleMemoryBatchPinList(const QString &type, const QJsonObject &payload,
                                           const QString &id, bool success) {
    if (m_memoryBatchPin.value("status").toString() != "reading" ||
        m_memoryBatchPin.value("listReadId").toString() != id ||
        m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
        m_memoryBatchPin.value("generation").toInt() != m_generation)
        return;
    if (m_memoryBatchPin.value("listRevision").toInt() != m_memoryListRevision)
        return unknownMemoryBatchPin();
    if (!success || type != "memory:result" || !payload["ok"].isBool() || !payload["ok"].toBool() ||
        payload.contains("error") || payload.contains("error_code") || payload.contains("code"))
        return unknownMemoryBatchPin();
    m_memoryBatchPin["listFresh"] = true;
    settleMemoryBatchPinReads();
}
void RuntimeBridge::settleMemoryBatchPinReads() {
    if (m_memoryBatchPin.value("status").toString() != "reading" ||
        !m_memoryBatchPin.value("statusFresh").toBool() || !m_memoryBatchPin.value("listFresh").toBool())
        return;
    if (m_memoryBatchPin.value("generation").toInt() != m_generation ||
        m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
        m_memoryBatchPin.value("listRevision").toInt() != m_memoryListRevision)
        return unknownMemoryBatchPin();
    const auto ids = m_memoryBatchPin.value("ids").toList();
    for (const auto &entry : m_state.value("memory").toMap().value("memories").toList()) {
        const auto row = entry.toMap();
        const auto id = row.value("id").toString();
        if (!ids.contains(QVariant(id)))
            continue;
        if (!m_memoryPinReadStates.contains(id) || row.value("pinned").metaType().id() != QMetaType::Bool ||
            row.value("pinned") != m_memoryPinReadStates.value(id))
            return unknownMemoryBatchPin();
    }
    const bool manual = m_memoryBatchPin.value("manual").toBool();
    m_memoryBatchPin["status"] = manual ? "refreshed" : "success";
    m_memoryBatchPin["preserveSelection"] = false;
    m_memoryBatchPin["text"] = manual ? QString("当前固定状态和记忆列表已刷新；先前批量操作的结果仍未确认为成功。")
        : QString("已%1 %2 条记忆，%3 条无需修改；当前共固定 %4 / 20 条。")
            .arg(m_memoryBatchPin.value("pinned").toBool() ? QString("固定") : QString("取消固定"))
            .arg(m_memoryBatchPin.value("actualChangedCount").toInt())
            .arg(m_memoryBatchPin.value("unchangedCount").toInt()).arg(m_memoryBatchPin.value("pinnedTotal").toInt());
    emit changed();
}
bool RuntimeBridge::candidateBatchBlocked() const {
    return QStringList{"previewing", "ready", "sending", "pending", "reading", "unknown"}.contains(
        m_candidateBatch.value("status").toString());
}
bool RuntimeBridge::candidateBatchOtherWritePending() const {
    if (memoryRequestPending("action") || memoryBatchDeleteBlocked() || memoryBatchPinBlocked() ||
        candidateDecisionLocked())
        return true;
    for (const auto &pending : m_pending)
        if (pending.generation == m_generation &&
            QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                        "memory:pin_many", "memory:candidates:confirm", "memory:candidates:reject",
                        "memory:candidates:decide_many"}.contains(pending.command))
            return true;
    return false;
}
QVariantMap RuntimeBridge::memoryCandidateBatch() const {
    auto result = m_candidateBatch;
    const auto status = result.value("status", "idle").toString();
    const bool owned = result.value("scopeKey").toString() == scopeKey() &&
        result.value("generation", -1).toInt() == m_generation;
    const bool current = owned && result.value("candidateRevision", -1).toInt() == m_candidateRevision;
    const bool live = m_candidateLive && m_candidateGeneration == m_generation &&
        m_candidateScope == scopeKey() && !m_candidateNeedsRefresh && !m_pending.contains(m_candidateReadId);
    result.insert({{"status", status}, {"ids", result.value("ids", QVariantList{})},
        {"decision", result.value("decision", "")}, {"confirm", result.value("decision").toString() == "confirm"},
        {"scopeKey", result.value("scopeKey", "")}, {"generation", result.value("generation", -1)},
        {"candidateRevision", result.value("candidateRevision", -1)},
        {"previewRequestId", result.value("previewRequestId", "")}, {"requestId", result.value("requestId", "")},
        {"statusReadId", result.value("statusReadId", "")}, {"candidateReadId", result.value("candidateReadId", "")},
        {"listReadId", result.value("listReadId", "")},
        {"selectedCount", result.value("ids").toList().size()},
        {"newCount", result.value("newCount", 0)}, {"replaceCount", result.value("replaceCount", 0)},
        {"sameCount", result.value("sameCount", 0)}, {"replacedPinnedCount", result.value("replacedPinnedCount", 0)},
        {"conflictCount", result.value("conflictCount", 0)},
        {"actualNewCount", result.value("actualNewCount", 0)},
        {"actualReplaceCount", result.value("actualReplaceCount", 0)},
        {"actualSameCount", result.value("actualSameCount", 0)},
        {"text", result.value("text", "")},
        {"busy", QStringList{"previewing", "sending", "pending", "reading"}.contains(status)},
        {"blocked", candidateBatchBlocked()},
        {"confirmationReady", status == "ready" && current && live && runtimeWritable() && !personaChanging() &&
            result.value("ids").toList().size() > 0 && result.value("conflictCount").toInt() == 0 &&
            !candidateBatchOtherWritePending()},
        {"preserveSelection", owned && QStringList{"reading", "unknown"}.contains(status)},
        {"dispatchCount", QVariant::fromValue(m_candidateBatchDispatchCount)},
        {"statusReadDispatchCount", QVariant::fromValue(m_candidateStatusDispatchCount)}});
    return result;
}
void RuntimeBridge::failCandidateBatchPreview(const QString &text) {
    m_pending.remove(m_candidateBatch.value("previewRequestId").toString());
    m_candidateBatch["status"] = "preview_error";
    m_candidateBatch["text"] = text;
    emit changed();
}
void RuntimeBridge::cancelCandidateBatchPreview() {
    if (!QStringList{"previewing", "ready", "preview_error", "rejected"}.contains(
            m_candidateBatch.value("status").toString()))
        return;
    m_pending.remove(m_candidateBatch.value("previewRequestId").toString());
    m_candidateBatch.clear();
    emit changed();
}
void RuntimeBridge::previewCandidateDecisions(const QVariantList &ids, bool confirm) {
    if (candidateBatchBlocked())
        return;
    if (candidateBatchOtherWritePending()) {
        setNotice("另一个记忆操作仍在核对中，请完成后再处理所选候选。");
        return;
    }
    m_candidateBatch = {{"status", "previewing"}, {"ids", ids}, {"decision", confirm ? "confirm" : "reject"},
        {"scopeKey", scopeKey()}, {"generation", m_generation}, {"candidateRevision", m_candidateRevision},
        {"text", "正在核对所选候选…"}};
    if (!runtimeWritable() || personaChanging())
        return failCandidateBatchPreview("当前暂不能写入记忆，请核对连接和人格后重新打开。");
    if (!m_candidateLive || m_candidateGeneration != m_generation || m_candidateScope != scopeKey() ||
        m_candidateNeedsRefresh || m_pending.contains(m_candidateReadId))
        return failCandidateBatchPreview("待确认列表尚未完整读取，请刷新后重新选择。");
    if (ids.isEmpty() || ids.size() > 100)
        return failCandidateBatchPreview("每次请选择 1–100 条候选；没有决定任何一条。");
    QHash<QString, int> shown;
    for (const auto &value : m_state.value("candidates").toMap().value("candidates").toList())
        ++shown[value.toMap().value("id").toString()];
    static const QRegularExpression pattern("\\Amc_[a-f0-9]{32}\\z");
    QSet<QString> unique;
    for (const auto &value : ids) {
        const auto id = value.toString();
        if (value.metaType().id() != QMetaType::QString || !pattern.match(id).hasMatch() ||
            unique.contains(id) || shown.value(id) != 1)
            return failCandidateBatchPreview("所选候选无效或不在当前批次中，请刷新后重新选择。");
        unique.insert(id);
    }
    m_candidateStatusSending = true;
    const auto id = request("memory:candidates:status", {{"candidate_ids", ids}});
    m_candidateStatusSending = false;
    if (id.isEmpty())
        return failCandidateBatchPreview("候选状态请求未能发送，请核对连接后重新打开。");
    emit changed();
}
void RuntimeBridge::confirmCandidateDecisions() {
    if (m_candidateBatch.value("status").toString() != "ready")
        return;
    if (!memoryCandidateBatch().value("confirmationReady").toBool()) {
        // A same-fact selection stays open and disabled until the user changes it.
        if (m_candidateBatch.value("scopeKey").toString() == scopeKey() &&
            m_candidateBatch.value("generation").toInt() == m_generation &&
            m_candidateBatch.value("candidateRevision").toInt() == m_candidateRevision &&
            m_candidateBatch.value("conflictCount").toInt() > 0)
            return;
        return failCandidateBatchPreview("所选候选或当前批次已变化，请重新打开后确认。");
    }
    const bool confirm = m_candidateBatch.value("decision").toString() == "confirm";
    m_candidateBatch["status"] = "sending";
    m_candidateBatch["text"] = confirm ? "正在记住所选候选…" : "正在放弃所选候选…";
    const auto id = request("memory:candidates:decide_many", {{"candidate_ids", m_candidateBatch.value("ids")},
                                                             {"decision", m_candidateBatch.value("decision")}});
    if (id.isEmpty()) {
        if (m_candidateBatch.value("status").toString() != "unknown")
            failCandidateBatchPreview("批量决定请求未能发送，请重新打开后确认；没有决定任何一条。");
        return;
    }
    emit changed();
}
void RuntimeBridge::unknownCandidateBatch() {
    if (!QStringList{"sending", "pending", "reading", "unknown"}.contains(
            m_candidateBatch.value("status").toString()))
        return;
    // Only a manual read may settle this; a late receipt cannot authorize a resend.
    const auto listId = m_candidateBatch.value("listReadId").toString();
    const auto candidateId = m_candidateBatch.value("candidateReadId").toString();
    const auto listReceipt = m_memoryFeedback.value("list").toMap();
    for (const auto &field : QStringList{"requestId", "statusReadId", "candidateReadId", "listReadId"})
        m_pending.remove(m_candidateBatch.value(field).toString());
    m_candidateBatch["status"] = "unknown";
    m_candidateBatch["text"] = "批量决定结果未知，请手动刷新核对；未自动重试。";
    m_candidateBatch["statusFresh"] = false;
    m_candidateBatch["candidatesFresh"] = false;
    m_candidateBatch["listFresh"] = false;
    if (!listId.isEmpty() && m_memoryListId == listId)
        m_memoryListId.clear();
    if (!listId.isEmpty() && listReceipt.value("requestId").toString() == listId &&
        listReceipt.value("status").toString() == "pending")
        setMemoryFeedback("list", "unknown", "当前记忆尚未完整读回，请手动刷新核对。", listId);
    if (!candidateId.isEmpty() && m_candidateReadId == candidateId) {
        m_candidateReadId.clear();
        m_candidateReadGeneration = -1;
        m_candidateReadPersona = {};
        m_candidateReadBoundary.clear();
        setMemoryFeedback("candidates", "unknown", "本批尚未完整读回；已显示的批次保留，请手动刷新核对。", candidateId);
    }
    m_candidateNeedsRefresh = true;
    emit changed();
}
void RuntimeBridge::invalidateCandidateBatchConnection(bool scopeChanged) {
    if (scopeChanged) {
        for (const auto &field : QStringList{"previewRequestId", "requestId", "statusReadId",
                                             "candidateReadId", "listReadId"})
            m_pending.remove(m_candidateBatch.value(field).toString());
        m_candidateBatch.clear();
    } else if (QStringList{"previewing", "ready"}.contains(m_candidateBatch.value("status").toString())) {
        failCandidateBatchPreview("连接已变化，请刷新待确认列表后重新选择。");
    } else {
        unknownCandidateBatch();
    }
}
void RuntimeBridge::applyCandidateBatchStatus(const QString &type, const QJsonObject &payload, const QString &id) {
    const auto status = m_candidateBatch.value("status").toString();
    const bool preview = status == "previewing" && id == m_candidateBatch.value("previewRequestId").toString();
    const bool reading = status == "reading" && id == m_candidateBatch.value("statusReadId").toString();
    if ((!preview && !reading) || m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
        m_candidateBatch.value("generation").toInt() != m_generation)
        return;
    CandidateBatchSnapshot snapshot;
    const auto ids = m_candidateBatch.value("ids").toList();
    if (!candidateBatchSnapshot(type, payload, ids, &snapshot)) {
        if (preview)
            failCandidateBatchPreview("所选候选的状态未获完整确认，请重新打开。");
        else
            unknownCandidateBatch();
        return;
    }
    const bool confirm = m_candidateBatch.value("decision").toString() == "confirm";
    if (preview) {
        if (m_candidateBatch.value("candidateRevision").toInt() != m_candidateRevision || !m_candidateLive)
            return failCandidateBatchPreview("待确认列表已变化，请重新选择后确认。");
        if (!snapshot.stale.isEmpty())
            return failCandidateBatchPreview("所选候选已有变化，请刷新后重新选择。");
        const int conflicts = confirm ? snapshot.conflicts : 0;
        m_candidateBatch.insert({{"newCount", snapshot.fresh.size()}, {"replaceCount", snapshot.replace.size()},
            {"sameCount", snapshot.same.size()}, {"replacedPinnedCount", snapshot.replacedPinned.size()},
            {"conflictCount", conflicts}, {"status", "ready"},
            {"text", conflicts > 0
                ? QString("所选候选中有 %1 条属于同一事实，确认后会互相替换；请分开处理。").arg(conflicts)
                : QString()}});
        emit changed();
        return;
    }
    if (!m_candidateBatch.value("manual").toBool()) {
        const auto expected = confirm ? QString("confirmed") : QString("rejected");
        if (snapshot.stale.size() != ids.size())
            return unknownCandidateBatch();
        for (const auto &value : ids)
            if (snapshot.states.value(value.toString()) != expected)
                return unknownCandidateBatch();
    }
    m_candidateBatch["statusFresh"] = true;
    settleCandidateBatchReads();
}
void RuntimeBridge::finishCandidateBatch(const QString &type, const QJsonObject &payload, const QString &id) {
    if (m_candidateBatch.value("status").toString() != "pending" ||
        m_candidateBatch.value("requestId").toString() != id ||
        m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
        m_candidateBatch.value("generation").toInt() != m_generation)
        return;
    const auto ids = m_candidateBatch.value("ids").toList();
    const auto decision = m_candidateBatch.value("decision").toString();
    const bool envelope = type == "memory:candidates:result" && payload["ok"].isBool() &&
        (!payload.contains("request_id") || payload["request_id"] == id);
    const auto code = payload["error_code"].toString();
    static const QStringList successFields{"candidate_ids", "decision", "confirmed", "rejected_ids", "new_ids",
                                           "replace_ids", "same_ids", "replaced_pinned_ids"};
    bool noSuccessFields = true;
    for (const auto &field : successFields)
        noSuccessFields = noSuccessFields && !payload.contains(field);
    const bool rejected = envelope && !payload["ok"].toBool() && noSuccessFields &&
        (((QStringList{"stale_selection", "fact_conflict", "memory_unavailable"}.contains(code)) &&
          (!payload.contains("code") || payload["code"] == payload["error_code"]) &&
          (!payload.contains("error") || payload["error"].isString())) ||
         memoryBatchPrewriteRejection("memory:result", payload));
    if (rejected) {
        m_candidateBatch["status"] = "rejected";
        m_candidateBatch["text"] = code == "stale_selection"
            ? "所选候选已有变化，本次没有决定任何一条；请刷新后重新选择。"
            : code == "fact_conflict" ? "所选候选中有属于同一事实的内容，本次没有决定任何一条；请分开处理。"
            : "所选候选暂不能处理，本次没有决定任何一条；请稍后重新打开。";
        emit changed();
        return;
    }
    bool success = envelope && payload["ok"].toBool() && !payload.contains("error") &&
        !payload.contains("error_code") && !payload.contains("code") &&
        payload["candidate_ids"].isArray() && payload["candidate_ids"].toArray() == QJsonArray::fromVariantList(ids) &&
        payload["decision"].isString() && payload["decision"].toString() == decision;
    QSet<QString> fresh, replace, same, replacedPinned;
    QVariantList memoryIds, replacedIds;
    if (success && decision == "reject") {
        success = payload["rejected_ids"].isArray() &&
            payload["rejected_ids"].toArray() == QJsonArray::fromVariantList(ids) && !payload.contains("confirmed");
    } else if (success) {
        static const QRegularExpression memoryPattern("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
        const auto confirmed = payload["confirmed"].toArray();
        success = payload["confirmed"].isArray() && confirmed.size() == ids.size() &&
            !payload.contains("rejected_ids") &&
            pinIdArray(payload["new_ids"], ids, &fresh, true) && pinIdArray(payload["replace_ids"], ids, &replace, true) &&
            pinIdArray(payload["same_ids"], ids, &same, true) &&
            pinIdArray(payload["replaced_pinned_ids"], ids, &replacedPinned, true) &&
            fresh.size() + replace.size() + same.size() == ids.size();
        for (int index = 0; success && index < confirmed.size(); ++index) {
            const auto entry = confirmed[index].toObject();
            const auto candidateId = ids[index].toString();
            const auto memoryId = entry["memory_id"].toString();
            const auto replaced = entry["replaced_memory_id"].toString();
            success = confirmed[index].isObject() && entry["candidate_id"].toString() == candidateId &&
                entry["memory_id"].isString() && memoryPattern.match(memoryId).hasMatch() &&
                entry["replaced_memory_id"].isString() &&
                (replaced.isEmpty() || memoryPattern.match(replaced).hasMatch()) &&
                entry["idempotent"].isBool() &&
                (entry["idempotent"].toBool() ? same.contains(candidateId) && replaced.isEmpty()
                 : replaced.isEmpty() ? fresh.contains(candidateId) : replace.contains(candidateId)) &&
                (!replacedPinned.contains(candidateId) || replace.contains(candidateId));
            if (success && !entry["idempotent"].toBool())
                memoryIds.append(memoryId);
            if (success && !replaced.isEmpty())
                replacedIds.append(replaced);
        }
    }
    if (!success)
        return unknownCandidateBatch();
    m_candidateBatch.insert({{"actualNewCount", fresh.size()}, {"actualReplaceCount", replace.size()},
        {"actualSameCount", same.size()}, {"replacedPinnedCount", replacedPinned.size()},
        {"memoryIds", memoryIds}, {"replacedIds", replacedIds}});
    readCandidateBatch(false);
}
void RuntimeBridge::readCandidateBatch(bool manual) {
    const auto status = m_candidateBatch.value("status").toString();
    if (!m_connected || m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
        (manual ? status != "unknown" : status != "pending"))
        return;
    for (const auto &field : QStringList{"statusReadId", "candidateReadId", "listReadId"})
        m_pending.remove(m_candidateBatch.value(field).toString());
    m_candidateBatch.insert({{"status", "reading"}, {"manual", manual}, {"generation", m_generation},
        {"statusFresh", false}, {"candidatesFresh", false}, {"listFresh", false},
        {"statusReadId", ""}, {"candidateReadId", ""}, {"listReadId", ""},
        {"text", manual ? "正在读取所选候选、待确认列表和记忆列表…" : "已收到回执，正在完整核对候选和记忆…"}});
    m_candidateStatusSending = true;
    const auto statusId = request("memory:candidates:status", {{"candidate_ids", m_candidateBatch.value("ids")}});
    m_candidateStatusSending = false;
    // The batch owns these replacements; an older page read no longer counts.
    m_pending.remove(m_candidateReadId);
    m_candidateBatchReading = true;
    const auto candidateId = startCandidatePage("first", {}, 1);
    const auto listId = startMemoryList();
    m_candidateBatchReading = false;
    m_candidateBatch["candidateReadId"] = candidateId;
    m_candidateBatch["listReadId"] = listId;
    if (statusId.isEmpty() || candidateId.isEmpty() || listId.isEmpty())
        unknownCandidateBatch();
    emit changed();
}
void RuntimeBridge::settleCandidateBatchRead(const QString &id, bool success) {
    if (id.isEmpty() || m_candidateBatch.value("status").toString() != "reading" ||
        m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
        m_candidateBatch.value("generation").toInt() != m_generation)
        return;
    const bool list = id == m_candidateBatch.value("listReadId").toString();
    const bool candidates = id == m_candidateBatch.value("candidateReadId").toString();
    if (!list && !candidates)
        return;
    if (!success)
        return unknownCandidateBatch();
    if (!m_candidateBatch.value("manual").toBool()) {
        const auto ids = m_candidateBatch.value("ids").toList();
        if (candidates) {
            // Decided candidates can no longer be pending on the first batch.
            for (const auto &row : m_state.value("candidates").toMap().value("candidates").toList())
                if (ids.contains(row.toMap().value("id")))
                    return unknownCandidateBatch();
        } else if (m_memoryQuery.isEmpty()) {
            // New revisions are the newest confirmed rows; replaced ones are gone.
            QSet<QString> shown;
            for (const auto &row : m_state.value("memory").toMap().value("memories").toList())
                shown.insert(row.toMap().value("id").toString());
            for (const auto &memoryId : m_candidateBatch.value("memoryIds").toList())
                if (!shown.contains(memoryId.toString()))
                    return unknownCandidateBatch();
            for (const auto &memoryId : m_candidateBatch.value("replacedIds").toList())
                if (shown.contains(memoryId.toString()))
                    return unknownCandidateBatch();
        }
    }
    m_candidateBatch[list ? "listFresh" : "candidatesFresh"] = true;
    settleCandidateBatchReads();
}
void RuntimeBridge::settleCandidateBatchReads() {
    if (m_candidateBatch.value("status").toString() != "reading" ||
        !m_candidateBatch.value("statusFresh").toBool() || !m_candidateBatch.value("candidatesFresh").toBool() ||
        !m_candidateBatch.value("listFresh").toBool())
        return;
    if (m_candidateBatch.value("generation").toInt() != m_generation ||
        m_candidateBatch.value("scopeKey").toString() != scopeKey())
        return unknownCandidateBatch();
    const bool manual = m_candidateBatch.value("manual").toBool();
    const bool confirm = m_candidateBatch.value("decision").toString() == "confirm";
    const int selected = m_candidateBatch.value("ids").toList().size();
    m_candidateBatch["status"] = manual ? "refreshed" : "success";
    m_candidateNeedsRefresh = false;
    m_candidateBatch["text"] = manual
        ? QString("当前候选和记忆已刷新；先前批量决定的结果仍未确认为成功，请按当前内容继续。")
        : confirm ? QString("已记住 %1 条：新增 %2 条，替换已有记忆 %3 条，%4 条与现有记忆相同未新增。")
                      .arg(selected).arg(m_candidateBatch.value("actualNewCount").toInt())
                      .arg(m_candidateBatch.value("actualReplaceCount").toInt())
                      .arg(m_candidateBatch.value("actualSameCount").toInt())
        : QString("已不记 %1 条，这些候选不会成为记忆。").arg(selected);
    emit changed();
}
void RuntimeBridge::clearBatchSuccessFeedback() {
    const auto action = m_memoryFeedback.value("action").toMap();
    bool cleared = false;
    if (action.value("status").toString() == "success" && action.value("verb").toString() == "批量删除记忆" &&
        !memoryBatchDeleteBlocked()) {
        m_memoryFeedback.remove("action");
        cleared = true;
    }
    if (m_memoryBatchPin.value("status").toString() == "success") {
        m_memoryBatchPin.clear();
        m_memoryPinReadStates.clear();
        cleared = true;
    }
    if (m_candidateBatch.value("status").toString() == "success") {
        m_candidateBatch.clear();
        cleared = true;
    }
    if (cleared)
        emit changed();
}
bool RuntimeBridge::candidateDecisionLocked() const { return !m_candidateDecision.isEmpty(); }
QVariantMap RuntimeBridge::memoryCandidatePage() const {
    const bool reading = m_pending.contains(m_candidateReadId);
    const auto status = m_candidateDecision.value("status").toString();
    const bool live = m_candidateLive && m_candidateGeneration == m_generation &&
                      m_candidateScope == scopeKey();
    return {{"pageNumber", m_candidatePageNumber},
        {"count", m_state.value("candidates").toMap().value("candidates").toList().size()},
        {"hasMore", m_candidateHasMore}, {"live", live},
        {"busy", reading || (!status.isEmpty() && status != "unknown")},
        {"decisionBusy", !status.isEmpty() && status != "unknown"},
        {"decisionLocked", candidateDecisionLocked()},
        {"blocked", !live || m_candidateNeedsRefresh || candidateDecisionLocked() || memoryBatchPinBlocked() ||
            candidateBatchBlocked()},
        {"needsRefresh", m_candidateNeedsRefresh}, {"revision", m_candidateRevision},
        {"readRequestId", m_candidateLastReadId}};
}
void RuntimeBridge::invalidateCandidatePaging(bool clearRows) {
    const auto interruptedRead = m_pending.contains(m_candidateReadId) ? m_candidateReadId : QString();
    m_pending.remove(m_candidateReadId);
    m_candidateReadId.clear();
    m_candidateLastReadId.clear();
    m_candidateReadGeneration = -1;
    m_candidateReadPersona = {};
    m_candidateReadBoundary.clear();
    m_candidateLive = false;
    if (clearRows) {
        m_candidateStartCursor.clear();
        m_candidateStartBoundary.clear();
        m_candidateNextCursor.clear();
        m_candidateReadStartCursor.clear();
        m_candidateReadKind.clear();
        m_candidateScope.clear();
        m_candidateGeneration = -1;
        m_candidatePageNumber = m_candidateReadPageNumber = 1;
        m_candidateHasMore = m_candidateNeedsRefresh = false;
        m_candidateDecision.clear();
        m_state.remove("candidates");
        m_memoryFeedback.remove("candidates");
        if (m_memoryFeedback.value("action").toMap().value("subjectId").toString().startsWith("mc_"))
            m_memoryFeedback.remove("action");
    } else if (candidateDecisionLocked()) {
        unknownCandidateDecision("连接已中断，候选决定结果尚未完整核对；请手动刷新核对，未自动重试。");
    }
    if (!clearRows && !interruptedRead.isEmpty())
        setMemoryFeedback("candidates", "unknown", "连接已中断，本批读取未获确认；已显示的批次保留，请刷新核对。", interruptedRead);
}
bool RuntimeBridge::firstRunPending() const {
    const auto ui = m_state.value("settings").toMap().value("ui");
    return settingsKnown() && ui.metaType().id() == QMetaType::QVariantMap &&
           ui.toMap().value("onboarding_completed") != QVariant(true);
}
bool RuntimeBridge::settingsKnown() const {
    return m_state.value("settings").toMap().value("ok").toBool() && !m_settingsFeedback.contains("read");
}
void RuntimeBridge::unsettleSettingsSaves(const QString &text) {
    for (const auto &key : m_settingsFeedback.keys()) {
        const auto feedback = m_settingsFeedback.value(key).toMap();
        if (feedback.value("status").toString() != "pending")
            continue;
        // A confirmed save that only awaited its read-back stays confirmed.
        if (feedback.contains("readId") && key == "features")
            setSettingsFeedback(key, "unknown", "主动消息设置已写入，但读回未获确认。",
                                feedback.value("requestId").toString(), feedback.value("fields").toMap());
        else if (feedback.contains("readId") && touchesBudget(feedback.value("fields").toMap()))
            setSettingsFeedback(key, "unknown", "设置已写入，但运行中的用量上限尚未确认同步；请重新读取当前设置。",
                                feedback.value("requestId").toString(), feedback.value("fields").toMap());
        else if (feedback.contains("readId"))
            setSettingsFeedback(key, "success", settingsSavedText(key, feedback.value("fields").toMap()),
                                feedback.value("requestId").toString(), feedback.value("fields").toMap());
        else
            setSettingsFeedback(key, "unknown", text, feedback.value("requestId").toString(),
                                feedback.value("fields").toMap());
    }
}
void RuntimeBridge::settleSettingsRead(const QString &readId) {
    for (const auto &key : m_settingsFeedback.keys()) {
        const auto feedback = m_settingsFeedback.value(key).toMap();
        if (feedback.value("status").toString() != "pending" || readId.isEmpty() ||
            feedback.value("readId").toString() != readId)
            continue;
        const auto fields = feedback.value("fields").toMap();
        if (key == "features" && (!settingsKnown() || !proactiveSettingsMatch(m_state.value("settings").toMap(), fields)))
            setSettingsFeedback(key, "unknown", "主动消息设置未能核对，显示的是后端读回的值。",
                                feedback.value("requestId").toString(), fields);
        else if (touchesBudget(fields) &&
            (!settingsKnown() || !budgetRuntimeMatches(m_state.value("settings").toMap(), fields)))
            setSettingsFeedback(key, "unknown", budgetUnconfirmedText,
                                feedback.value("requestId").toString(), fields);
        else if (touchesEmotion(fields) && !emotionRuntimeMatches(m_state.value("settings").toMap()))
            setSettingsFeedback(key, "unknown", "设置已写入，但运行中的情绪尚未确认同步；已重新读取当前设置。",
                                feedback.value("requestId").toString(), fields);
        else
            setSettingsFeedback(key, "success", settingsSavedText(key, fields), feedback.value("requestId").toString(),
                                fields);
    }
}
static QString chatFailureCode(const QJsonObject &payload) {
    const auto value = payload.value("failure_code");
    static const QRegularExpression format("\\APROVIDER_[A-Z_]{1,48}\\z");
    if (!value.isString() || !format.match(value.toString()).hasMatch()) return {};
    return value.toString();
}
static QString chatFailureText(const QJsonObject &payload, const QString &fallback) {
    const auto code = chatFailureCode(payload);
    const auto value = payload.value("http_status");
    const double number = value.toDouble();
    const bool hasHttp = value.isDouble() && number >= 100 && number <= 599 && number == int(number);
    static const QHash<QString, QString> labels{
        {"PROVIDER_UNAUTHORIZED", "服务拒绝了密钥，请检查 API Key。"},
        {"PROVIDER_AUTH_FAILED", "服务拒绝了密钥，请检查 API Key。"},
        {"PROVIDER_RATE_LIMITED", "服务暂时限流；未自动重试。"},
        {"PROVIDER_TIMEOUT", "无法连接到服务或连接超时；结果未知，未自动重试。"},
        {"PROVIDER_UNREACHABLE", "无法连接到服务或连接超时；结果未知，未自动重试。"},
        {"PROVIDER_CONNECTION_FAILED", "无法连接到服务或连接超时；结果未知，未自动重试。"},
        {"PROVIDER_INVALID_RESPONSE", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_INVALID_RESPONSE_SCHEMA", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_EMPTY_RESPONSE", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_REASONING_ONLY_RESPONSE", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_TOOL_ONLY_RESPONSE", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_OUTPUT_TRUNCATED", "服务返回的内容无法显示；未自动重试。"},
        {"PROVIDER_CONTENT_FILTERED", "服务返回的内容无法显示；未自动重试。"}};
    QString text = labels.value(code, fallback);
    if (code == "PROVIDER_REJECTED" && hasHttp)
        text = number < 500 ? "服务拒绝了这次请求；未自动重试。" : "服务出错；结果未知，未自动重试。";
    if (hasHttp) text += QString("（HTTP %1）").arg(int(number));
    return text;
}
void RuntimeBridge::finishChat(const QString &status, const QJsonObject &failure) {
    const auto completed = m_chatId;
    m_pending.remove(completed);
    for (auto it = m_pending.begin(); it != m_pending.end();) {
        if (it->generation == m_generation &&
            (it->command == "chat:cancel" || it->command == "chat:reveal") &&
            it->subjectRequestId == completed)
            it = m_pending.erase(it);
        else
            ++it;
    }
    m_busy = false;
    m_chatImageInFlight = false;
    m_chatImageSentDraft.clear();
    m_chatFeedback.remove("cancel");
    const QHash<QString, QString> labels{{"done", "已回复"},
                                         {"cancelled", "本次回复已停止"},
                                         {"failed", "本次回复失败，可检查回复服务后重新发送。"},
                                         {"failed_uncertain", "回复结果未知；未自动重试。"}};
    setChatFeedback(status, chatFailureText(failure, labels.value(status, "本次回复已结束。")));
    m_chatId.clear();
    m_chatGeneration = -1;
    m_chatPersona = {};
}

void RuntimeBridge::observeProactiveMessage(const QJsonObject &frame, const QJsonObject &payload) {
    static const QRegularExpression stableId("\\Aproactive_[0-9a-f]{32}\\z");
    const auto id = payload["proactive_id"].toString();
    const auto time = QDateTime::fromString(payload["created_at_utc"].toString(), Qt::ISODateWithMs);
    if (!m_connected || m_stopping || personaChanging() || frame.contains("request_id") || payload.contains("request_id") ||
        m_persona["persona_id"].toString().isEmpty() || payload["conversation_id"] != "dream-room" ||
        payload["persona_id"] != m_persona["persona_id"] || payload["persona_epoch"] != m_persona["epoch"] ||
        payload["persona_fingerprint"] != m_persona["fingerprint"] || !stableId.match(id).hasMatch() ||
        !time.isValid() || time.timeSpec() == Qt::LocalTime || time.offsetFromUtc() != 0 ||
        payload["trigger"].toString().isEmpty() || !payload["emotion_changes"].isObject() ||
        !payload["metadata"].isObject() || !payload["notify"].isBool() || !payload["native_notification"].isBool() ||
        !payload["notification_title"].isString() || m_proactiveAnnouncements.contains(id))
        return;
    QStringList bubbles;
    for (const auto &value : payload["messages"].toArray()) {
        if (value.toString().trimmed().isEmpty()) return;
        bubbles.append(value.toString());
    }
    if (bubbles.isEmpty() || payload["text"] != bubbles.join('\n'))
        return;
    m_proactiveAnnouncements.insert(id);
    m_proactiveHistoryQueued.insert(id);
    m_proactiveHistoryDirty = true;
    readProactiveHistory();
}

void RuntimeBridge::readProactiveHistory() {
    if (m_proactiveHistoryDirty && m_proactiveHistoryId.isEmpty() && m_connected && !m_stopping &&
        !personaChanging() && !m_busy)
        request("chat:history");
}

void RuntimeBridge::clearProactiveHistory() {
    m_proactiveAnnouncements.clear();
    m_proactiveHistoryQueued.clear();
    m_proactiveHistoryBatch.clear();
    m_proactiveHistoryDirty = false;
    m_proactiveHistoryId.clear();
    m_chatHistoryApplied = 0;
}

void RuntimeBridge::expirePending(const QString &id) {
    if (!m_pending.contains(id))
        return;
    const auto p = m_pending.value(id);
    // A chat is settled only by an authoritative result or a lost connection.
    // A timer must never drop its correlation record or allow a second send.
    if (p.command == "chat:send" ||
        ((p.command == "backup:file:import" || p.command == "persona:activate" ||
          p.command == "persona:import") && m_connected))
        return;
    m_pending.remove(id);
    if (p.command == "chat:media") {
        if (id == m_chatImageReadId)
            settleChatImageThumbnail();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "persona:profile:get" || p.command == "persona:profile:update") {
        if (id == m_personaProfileState.value("requestId").toString()) {
            if (p.command == "persona:profile:update")
                invalidatePersonaProfile();
            else {
                m_personaProfileState["open"] = false;
                setPersonaProfileStatus("error", "人格内容读取未获确认，请重新打开编辑。");
            }
        }
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command.startsWith("worldbook:file:")) {
        unknownWorldbookFile();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "persona:card:export") {
        unknownPersonaCardExport();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.generation != m_generation)
        return;
    if (p.command == "chat:history" && id == m_proactiveHistoryId) {
        m_proactiveHistoryId.clear();
        for (const auto &announcement : m_proactiveHistoryBatch)
            m_proactiveAnnouncements.remove(announcement);
        m_proactiveHistoryBatch.clear();
        m_proactiveHistoryDirty = true;
    }
    if (expireKeepsake(id)) {
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (expireDiary(id)) {
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "relationship:get") {
        if (id == m_relationshipReadId && m_relationshipReadPersona == m_persona) {
            failRelationshipRead();
            emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        }
        return;
    }
    if (p.command == "emotion:get") {
        if (id == m_moodReadId && m_moodReadPersona == m_persona) {
            failMoodRead();
            emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        }
        return;
    }
    if (!id.isEmpty() && (id == m_gameReadId || id == m_gameSaveId || id == m_gameMoveId)) {
        if (p.gameEpoch == m_gameGeneration)
            failGameRequest(p.command);
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "api:budget:get") {
        if (id != m_budgetReadId)
            return;
        invalidateBudget(m_connected ? "用量读取超时，请刷新后重试。"
                                     : "连接已中断，用量暂时读不到；重新连接后请刷新。");
        emit changed();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:delete_many" &&
        m_memoryBatchDelete.value("requestId").toString() == id) {
        unknownMemoryBatchDelete();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:pin_many" && m_memoryBatchPin.value("requestId").toString() == id) {
        unknownMemoryBatchPin();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:pin_status") {
        if (m_memoryBatchPin.value("previewRequestId").toString() == id &&
            m_memoryBatchPin.value("status").toString() == "previewing")
            failMemoryPinPreview("固定状态读取超时，请重新预览；记忆没有改动。");
        else if (m_memoryBatchPin.value("statusReadId").toString() == id)
            unknownMemoryBatchPin();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:list" && m_memoryBatchPin.value("listReadId").toString() == id)
        unknownMemoryBatchPin();
    if (p.command == "memory:candidates:decide_many" && m_candidateBatch.value("requestId").toString() == id) {
        unknownCandidateBatch();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:candidates:status") {
        if (m_candidateBatch.value("previewRequestId").toString() == id &&
            m_candidateBatch.value("status").toString() == "previewing")
            failCandidateBatchPreview("候选状态读取超时，请重新打开；没有决定任何一条。");
        else if (m_candidateBatch.value("statusReadId").toString() == id)
            unknownCandidateBatch();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if ((p.command == "memory:list" || p.command == "memory:candidates:list") &&
        (m_candidateBatch.value("listReadId").toString() == id ||
         m_candidateBatch.value("candidateReadId").toString() == id))
        unknownCandidateBatch();
    if (p.command == "memory:list" &&
        m_memoryBatchDelete.value("manualReadId").toString() == id)
        settleMemoryBatchDeleteRead(id, false);
    if (p.command.startsWith("memory:candidates:") &&
        m_candidateDecision.value("requestId").toString() == id) {
        unknownCandidateDecision(m_connected
            ? "候选决定未收到确认，结果未知；请手动刷新核对，未自动重试。"
            : "连接已中断，候选决定结果未知；请手动刷新核对，未自动重试。");
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:candidates:list" && id == m_candidateReadId) {
        m_candidateReadId.clear();
        m_candidateReadGeneration = -1;
        m_candidateReadPersona = {};
        m_candidateReadBoundary.clear();
        setMemoryFeedback("candidates", "unknown", "本批读取未收到确认；已显示的批次和位置保留，请刷新核对。", id);
        candidateReadSettled(id, false);
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "memory:list" && m_candidateDecision.value("listReadId").toString() == id)
        candidateReadSettled(id, false);
    if (p.command == "memory:query" && id == m_memoryRecallId) {
        m_memoryRecallId.clear();
        m_memoryRecallGeneration = -1;
        m_memoryRecallPersona = {};
        m_memoryRecallState["status"] = "error";
        m_memoryRecallState["text"] = "关联回忆未收到确认，输入已保留；未自动重试。";
        emit changed();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "summary:get" && id == m_summaryDetailId) {
        failSummaryDetail(m_connected ? "摘要正文读取超时；未自动重试，可重新读取这段摘要。"
                                      : "连接已中断，摘要正文已清除；请重新连接后刷新目录。");
        emit changed();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "summary:status") {
        if (id != m_summaryStatusReadId)
            return;
        m_summaryStatusReadId.clear();
        m_state["summary"] = summaryStatusSnapshot({{"ok", false}, {"status", "unavailable"}});
        emit changed();
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "user:profile:update" &&
        m_profileClearState.value("requestId").toString() == id) {
        unknownProfileClear(m_connected ? "清空未收到确认，结果未知；正在只读核对当前资料，未自动重试。"
                                        : "连接中断，清空结果未知；重新连接后请核对当前资料。");
        emit requestFailed(id, m_connected ? "timeout" : "disconnected", p.generation);
        return;
    }
    if (p.command == "user:profile:get" && id == m_profileReadId) {
        m_profileSnapshotGeneration = -1;
        if (m_profileClearState.value("status").toString() == "confirmation")
            setProfileClearState("stale", "当前资料读取未获确认，请刷新后重新选择清空字段。");
        if (m_profileClearState.value("readId").toString() == id) {
            m_profileClearState["manualRefreshing"] = false;
            if (QStringList{"pending", "unknown"}.contains(m_profileClearState.value("status").toString()))
                unknownProfileClear("当前资料读取未获确认，清空结果仍未知；请手动刷新核对，未自动重试。");
            else
                setProfileClearState("error", "当前资料读取未获确认，请手动刷新核对；编辑内容已保留。");
        }
    }
    if (p.command == "chat:cancel") {
        if (m_busy && p.subjectRequestId == m_chatId && m_chatGeneration == m_generation &&
            m_chatPersona == m_persona &&
            m_chatFeedback.value("cancel").toMap().value("requestId").toString() == id) {
            setCancelFeedback("unknown", "停止结果尚未确认，未自动重试；可再次手动停止。",
                              id, p.subjectRequestId);
            emit requestFailed(id, "timeout", p.generation);
        }
        return;
    }
    if ((p.command.startsWith("ai_usage:") || p.command == "provider:get" ||
         p.command == "provider:configure") &&
        p.permissionContextEpoch != m_permissionContextEpoch)
        return;
    if (p.command == "persona:activate" && m_personaSwitch.value("requestId").toString() == id) {
        m_personaSwitch.clear();
        setPersonaFeedback("unknown", "连接中断，切换结果未确认；重新连接后请核对当前人格。", id);
        emit requestFailed(id, "timeout", p.generation);
        return;
    }
    if (p.command == "persona:import" && m_personaImport.value("requestId").toString() == id) {
        clearPersonaCardCandidate();
        forgetPersonaCardImport("连接中断，角色卡导入结果未确认；重新连接后请核对当前人格和列表。");
        emit requestFailed(id, "disconnected", p.generation);
        return;
    }
    if (p.command == "persona:get" && m_personaImport.value("verifyId").toString() == id) {
        forgetPersonaCardImport("当前人格读取未获确认，角色卡导入结果仍未知；请核对当前人格和列表。");
        emit requestFailed(id, "timeout", p.generation);
        return;
    }
    if (p.callback) {
        p.callback({{"requestId", id}, {"type", p.command}, {"ok", false}, {"unknown", true}});
    } else {
        if (p.command.startsWith("ai_usage:")) {
            if (p.permissionSequence == m_permissionSequence)
                m_permissionsKnown = false;
            const auto key = p.command == "ai_usage:get" ? QString("refresh") : p.feature;
            const auto current = m_permissionFeedback.value(key).toMap();
            if (current.value("requestId").toString() == id)
                setPermissionFeedback(key, "unknown", "操作未收到确认；当前授权状态需要刷新核对。",
                                      p.command.section(':', 1), id);
        }
        for (const auto &key : m_memoryFeedback.keys())
            if (m_memoryFeedback.value(key).toMap().value("requestId").toString() == id)
                setMemoryFeedback(key, "unknown", "操作未收到确认；结果未知，请刷新后核对。", id);
        if (p.command == "settings:update") {
            bool budgetSave = false;
            for (const auto &key : m_settingsFeedback.keys()) {
                const auto feedback = m_settingsFeedback.value(key).toMap();
                if (feedback.value("requestId").toString() == id &&
                    feedback.value("status").toString() == "pending" && !feedback.contains("readId")) {
                    budgetSave |= touchesBudget(feedback.value("fields").toMap());
                    setSettingsFeedback(key, "unknown",
                                        m_connected ? "保存结果未确认，已重新读取当前设置。"
                                                    : "连接中断，保存结果未确认；重新连接后会重新读取当前设置。",
                                        id, feedback.value("fields").toMap());
                }
            }
            if (m_connected)
                request("settings:get");
            if (budgetSave && m_connected)
                refreshBudget();
        }
        if (p.command == "settings:get") {
            setSettingsFeedback("read", "error", "当前设置读取失败，显示的是上次确认的值；暂不能修改。", id);
            settleSettingsRead(id);
        }
        setNotice("操作尚未收到确认；结果未知，请先核对当前状态。");
        emit requestFailed(id, "timeout", p.generation);
    }
}
void RuntimeBridge::setDraft(const QString &s) {
    if (s == m_draft)
        return;
    m_draft = s.left(20000);
    emit draftChanged();
}
void RuntimeBridge::persistAppearance() {
    try {
        atomicJson(m_data + "/qt-appearance.json", {{"reducedMotion", m_reducedMotion},
                                                    {"reducedTransparency", m_reducedTransparency},
                                                    {"offline", m_offline},
                                                    {"roomQuality", m_roomQuality}});
    } catch (...) {
        setNotice("外观偏好未能保存。");
    }
}
void RuntimeBridge::setReducedMotion(bool v) {
    m_reducedMotion = v;
    persistAppearance();
    emit changed();
}
void RuntimeBridge::setRoomQuality(const QString &value) {
    if (value != "clear" && value != "balanced" && value != "smooth")
        return;
    if (value == m_roomQuality)
        return;
    m_roomQuality = value;
    persistAppearance();
    emit changed();
}
void RuntimeBridge::setReducedTransparency(bool v) {
    m_reducedTransparency = v;
    persistAppearance();
    emit changed();
}
void RuntimeBridge::setSupplementaryFixtureArguments(const QString &context,
                                                     const QString &endpoint, int cycle,
                                                     bool p0Tail, const QString &endpointB) {
    if (m_supplementaryFixture && m_process.state() == QProcess::NotRunning) {
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
        m_fixtureP0Tail = p0Tail;
        m_fixtureEndpointB = endpointB;
    }
}
void RuntimeBridge::setRestoreFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_profileFixture) {
        m_restoreFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setPersonaFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_restoreFixture && !m_profileFixture) {
        m_personaFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setMemoryFixtureArguments(const QString &context, const QString &endpoint, int cycle,
                                             bool candidatePaging) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_profileFixture) {
        m_memoryFixture = true;
        m_fixtureCandidatePaging = candidatePaging;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setProfileFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_memoryFixture) {
        m_profileFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setSettingsFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_memoryFixture && !m_profileFixture) {
        m_settingsFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setWorldbookEntryFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_worldbookRegexFixture && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_memoryFixture && !m_profileFixture && !m_settingsFixture) {
        m_worldbookEntryFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setWorldbookRegexFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_worldbookInjectionFixture && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_memoryFixture && !m_profileFixture && !m_settingsFixture && !m_worldbookEntryFixture) {
        m_worldbookRegexFixture = true;
        m_fixtureContext = context;
        m_fixtureEndpoint = endpoint;
        m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::setWorldbookInjectionFixtureArguments(const QString &context, const QString &endpoint, int cycle) {
    if (m_process.state() == QProcess::NotRunning && !m_supplementaryFixture && !m_restoreFixture &&
        !m_personaFixture && !m_memoryFixture && !m_profileFixture && !m_settingsFixture &&
        !m_worldbookEntryFixture && !m_worldbookRegexFixture) {
        m_worldbookInjectionFixture = true;
        m_fixtureContext = context; m_fixtureEndpoint = endpoint; m_fixtureCycle = cycle;
    }
}
void RuntimeBridge::start() {
    if (m_process.state() != QProcess::NotRunning)
        return;
    try {
        QFileInfo info(m_data);
        struct stat st{};
        if (!info.isDir() || info.isSymLink() || info.canonicalFilePath() != m_data ||
            lstat(m_data.toUtf8(), &st) || st.st_uid != getuid())
            throw std::runtime_error("ISOLATION_DIRECTORY_INVALID");
        QFileInfo py(m_python);
        if (!py.isExecutable() || !py.canonicalFilePath().startsWith(m_root + "/.tools/python/"))
            throw std::runtime_error("PROJECT_PYTHON_INVALID");
        if ((m_supplementaryFixture || m_restoreFixture || m_personaFixture || m_memoryFixture || m_profileFixture ||
             m_settingsFixture || m_worldbookEntryFixture || m_worldbookRegexFixture || m_worldbookInjectionFixture) &&
            (m_fixtureContext.isEmpty() || m_fixtureEndpoint.isEmpty() ||
                                      (m_fixtureCycle != 1 && m_fixtureCycle != 2) ||
                                      (m_fixtureP0Tail && m_fixtureEndpointB.isEmpty())))
            throw std::runtime_error("SUPPLEMENTARY_FIXTURE_CONTEXT_REQUIRED");
        if (m_previewMode && (m_supplementaryFixture || m_restoreFixture || m_personaFixture || m_memoryFixture ||
            m_profileFixture || m_settingsFixture || m_worldbookEntryFixture || m_worldbookRegexFixture || m_worldbookInjectionFixture))
            throw std::runtime_error("PREVIEW_TEST_BOOTSTRAP_FORBIDDEN");
        if (m_previewMode) emit previewEvent("keychain_read_started", "OK", 0);
        QByteArray key = storageKeyFor(m_data, m_previewMode ? KeychainDomain::Preview : KeychainDomain::Local);
        if (m_previewMode) emit previewEvent("keychain_ready", "OK", 0);
        StorageKeyChannel keyChannel("PRIVATE_PIPE_FAILED");
        QByteArray random(32, 0);
        for (int i = 0; i < 32; i++)
            random[i] = char(QRandomGenerator::system()->generate() & 255);
        m_secret = random.toHex();
        random.fill(0);
        QProcessEnvironment env;
        for (const auto &name : {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"})
            if (qEnvironmentVariableIsSet(name))
                env.insert(name, qEnvironmentVariable(name));
        env.insert("PYTHONNOUSERSITE", "1");
        env.insert("PYTHONDONTWRITEBYTECODE", "1");
        env.insert("PYTHON_DOTENV_DISABLED", "1");
        env.insert("PYTHONUNBUFFERED", "1");
        env.insert("REVERIE_BRIDGE_MODE", "1");
        env.insert("REVERIE_BRIDGE_PROTOCOL_VERSION", "4");
        env.insert("REVERIE_BRIDGE_SECRET", m_secret);
        env.insert("REVERIE_PARENT_PID", QString::number(QCoreApplication::applicationPid()));
        env.insert("REVERIE_DATA_DIR", m_data + "/data");
        env.insert("REVERIE_LOCAL_MODE", m_offline ? "1" : "0");
        env.insert("REVERIE_LOCAL_MODE_EPOCH", "0");
        env.insert("REVERIE_REQUIRE_ENCRYPTED_STORAGE", "1");
        env.insert("REVERIE_STORAGE_KEY_FD", "3");
        env.insert("HF_HUB_OFFLINE", "1");
        env.insert("TRANSFORMERS_OFFLINE", "1");
        if (m_previewMode) {
            const QString cache = m_data + "/data/cache";
            env.insert("XDG_CACHE_HOME", cache);
            env.insert("HF_HOME", cache + "/huggingface");
            env.insert("HF_HUB_CACHE", cache + "/huggingface/hub");
            env.insert("HUGGINGFACE_HUB_CACHE", cache + "/huggingface/hub");
            env.insert("TRANSFORMERS_CACHE", cache + "/huggingface/transformers");
            env.insert("TORCH_HOME", cache + "/torch");
            env.insert("MPLCONFIGDIR", cache + "/matplotlib");
        }
        // Qt's host is the sole pipe owner. The key is never an argv/env value.
        keyChannel.configureChild(m_process);
        m_process.setProcessEnvironment(env);
        m_process.setWorkingDirectory(m_root);
        QStringList arguments{m_root + "/src/main.py", "--stdio-bridge"};
        if (m_supplementaryFixture) {
            arguments = {m_root + "/native-ui/tests/p0_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p0-planner.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
            if (m_fixtureP0Tail)
                arguments << "--p0-tail" << "--endpoint-b" << m_fixtureEndpointB;
        }
        if (m_restoreFixture) {
            arguments = {m_root + "/native-ui/tests/p1_restore_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-restore-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_personaFixture) {
            arguments = {m_root + "/native-ui/tests/p1_persona_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-persona-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_memoryFixture) {
            arguments = {m_root + "/native-ui/tests/p1_memory_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-memory-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
            if (m_fixtureCandidatePaging)
                arguments << "--candidate-paging";
        }
        if (m_profileFixture) {
            arguments = {m_root + "/native-ui/tests/p1_profile_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-profile-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_settingsFixture) {
            arguments = {m_root + "/native-ui/tests/p1_settings_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-settings-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_worldbookEntryFixture) {
            arguments = {m_root + "/native-ui/tests/p1_worldbook_entry_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-worldbook-entry-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_worldbookRegexFixture) {
            arguments = {m_root + "/native-ui/tests/p1_worldbook_regex_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-worldbook-regex-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        if (m_worldbookInjectionFixture) {
            arguments = {m_root + "/native-ui/tests/p1_worldbook_injection_backend_bootstrap.py", "--stdio-bridge",
                         "--context", m_fixtureContext, "--data-dir", m_data,
                         "--endpoint", m_fixtureEndpoint, "--evidence", m_data + "/p1-worldbook-injection-metadata.jsonl",
                         "--cycle", QString::number(m_fixtureCycle)};
        }
        // A fresh service process cannot inherit a lookup or its input from the old one.
        invalidateMemoryRecall(true);
        invalidateSummaryDirectory();
        invalidateSummaryDetail();
        invalidateBudget("本地服务正在重新连接，用量需要重新读取。");
        if (m_previewMode) emit previewEvent("backend_starting", "OK", 0);
        m_process.start(m_python, arguments);
        const auto count = keyChannel.sendAndClose(key);
        key.fill(0);
        if (count != 32)
            throw std::runtime_error("PRIVATE_KEY_TRANSFER_FAILED");
        m_readyTimer.start(20000);
        setNotice("正在连接你的本地空间…");
        avatarJob({{"action", "list"}}, [this](QJsonObject result) { rememberAvatar(result); });
    } catch (const std::exception &e) {
        const QString code = QString::fromUtf8(e.what());
        if (m_previewMode) emit previewEvent("startup_failed", code, 0);
        setNotice(PreviewStartupPolicy::notice(m_previewMode, code));
    }
}
bool RuntimeBridge::write(const QJsonObject &value) {
    auto bytes = QJsonDocument(value).toJson(QJsonDocument::Compact);
    if (bytes.size() < 2 || bytes.size() > 1048576) {
        setNotice("请求超过传输限额。");
        return false;
    }
    QByteArray header(4, 0);
    qToBigEndian<quint32>(bytes.size(), header.data());
    const auto frame = header + bytes;
    const auto count = m_frameWriter ? m_frameWriter(frame) : m_process.write(frame);
    if (count != frame.size()) {
        setNotice("请求未能完整交给本地服务，请核对连接状态。");
        if (count > 0)
            shutdown();
        return false;
    }
    return true;
}
void RuntimeBridge::readFrames() {
    m_buffer += m_process.readAllStandardOutput();
    if (m_buffer.size() > 2097160) {
        setNotice("后端帧超过限额。");
        shutdown();
        return;
    }
    while (m_buffer.size() >= 4) {
        quint32 n = qFromBigEndian<quint32>(m_buffer.constData());
        if (n < 2 || n > 1048576) {
            setNotice("后端帧格式无效。");
            shutdown();
            return;
        }
        if (m_buffer.size() < n + 4)
            return;
        auto raw = m_buffer.mid(4, n);
        m_buffer.remove(0, n + 4);
        QJsonParseError e;
        auto d = QJsonDocument::fromJson(raw, &e);
        if (e.error != QJsonParseError::NoError || !d.isObject()) {
            setNotice("后端帧不是有效对象。");
            shutdown();
            return;
        }
        acceptFrame(d.object());
    }
}
void RuntimeBridge::acceptFrame(const QJsonObject &f) {
    const auto kind = f["kind"].toString();
    if (!m_connected) {
        auto digest =
            QCryptographicHash::hash(m_secret.toUtf8(), QCryptographicHash::Sha256).toHex();
        if (kind != "ready" || f["schema"] != "reverie.bridge.stdio.ready.v4" ||
            f["protocolVersion"].toInt() != 4 || f["pid"].toInteger() != m_process.processId() ||
            f["secretSha256"].toString().toUtf8() != digest) {
            setNotice("私有后端身份核验失败。");
            shutdown();
            return;
        }
        const QJsonObject persona{{"persona_id", f["personaId"]},
                                 {"epoch", f["personaEpoch"]},
                                 {"fingerprint", f["personaFingerprint"]}};
        const bool personaChanged = persona != m_persona;
        invalidateMemoryPinConnection(personaChanged);
        invalidateCandidateBatchConnection(personaChanged);
        invalidateMemoryRecall(personaChanged);
        // Even an unchanged persona is a new service connection. Cached bodies
        // and the previous connection's selectable IDs must be read again.
        invalidateSummaryDirectory();
        invalidateSummaryDetail();
        invalidateBudget("本地连接已更新，用量需要重新读取。");
        if (personaChanged)
            m_memoryBatchDelete.clear();
        m_persona = persona;
        clearDiary();
        clearKeepsakes();
        clearProactiveHistory();
        resetChatImages(personaChanged);
        cancelRelationshipRead();
        m_relationshipDisplay.clear();
        m_state.remove("relationship");
        if (personaChanged)
            m_lastRelationshipDisplay.clear();
        cancelMoodRead();
        m_moodDisplay.clear();
        m_moodEnabled = {};
        if (personaChanged)
            m_lastMoodDisplay.clear();
        unknownPersonaCardExport();
        unknownWorldbookFile();
        invalidatePersonaProfile();
        m_generation++;
        ++m_memoryListRevision;
        m_handshakes++;
        m_connected = true;
        // A cursor from the previous service process does not carry over; the
        // shown list stays until its first page is read again.
        m_memoryListLive = false;
        invalidateCandidatePaging(personaChanged);
        if (m_state.contains("memory")) {
            auto list = m_state.value("memory").toMap();
            list["hasMore"] = false;
            m_state["memory"] = list;
        }
        // A new service process holds no key from the previous one.
        m_keyClearVerifyId.clear();
        if (!m_keyClearState.isEmpty()) {
            m_keyClearState.clear();
            updateProviderKeyState();
        }
        const bool recoveryValid = applyRecoverySnapshot(f, true);
        m_readyTimer.stop();
        m_localModeEpoch = qMax(m_localModeEpoch, f["localModeEpoch"].toInt());
        setNotice("本地空间已连接");
        if (runtimeWritable())
            setOffline(m_offline);
        refresh();
        clearGame();
        if (gamePanelOpen())
            gameRead();
        if (m_previewMode && recoveryValid)
            emit validatedReady({{"backendPid", m_process.processId()},
                                 {"recoveryState", m_recoveryState}, {"runtimeWritable", runtimeWritable()}});
        return;
    }
    if (kind == "event")
        event(f["frame"].toObject());
    if (kind == "control_result") {
        auto id = f["requestId"].toString();
        if (!m_pending.contains(id))
            return;
        auto p = m_pending.value(id);
        if ((p.command == "persona:card:export" || p.command.startsWith("worldbook:file:")) && p.generation != m_generation) {
            m_pending.remove(id);
            if (p.command.startsWith("worldbook:file:")) unknownWorldbookFile();
            else unknownPersonaCardExport();
            return;
        }
        if (p.generation != m_generation)
            return;
        if (f["schema"] != "reverie.bridge.stdio.control.v4" || f["type"] != p.command)
            return;
        if ((p.command == "provider:get" || p.command == "provider:configure") &&
            p.permissionContextEpoch != m_permissionContextEpoch) {
            m_pending.remove(id);
            return;
        }
        if (p.command == "local_mode:set" && id == m_networkRequestId && f["ok"].toBool() &&
            f["epoch"].toInt(-1) != m_localModeEpoch)
            return;
        m_pending.remove(id);
        if (!f["ok"].toBool())
            qWarning() << "Qt control rejected" << p.command << f["code"].toString();
        if (p.command.startsWith("backup:file:") &&
            (f.contains("recovery_state") || p.command == "backup:file:import"))
            applyRecoverySnapshot(f, false, p.command == "backup:file:import" &&
                ((f["ok"].toBool() && f["outcome"].toString() == "committed") || f["outcome"].toString() == "rolled_back"));
        if (p.callback)
            p.callback(f);
    }
}
QString RuntimeBridge::request(const QString &command, const QVariantMap &payload) {
    if (command == "emotion:get" && moodDisabled())
        return {};
    if (command == "backup:import" || command == "backup:file:import" || command == "backup:file:inspect") {
        rejectBackupRestore();
        return {};
    }
    if (command == "api:budget:get") {
        if (!payload.isEmpty())
            return {};
        if (!m_connected || m_stopping || personaChanging()) {
            invalidateBudget(personaChanging() ? "人格操作仍在核对中，请稍后刷新用量。"
                                               : "本地服务尚未连接，用量暂时读不到。");
            emit changed();
            return {};
        }
    }
    if (!m_connected) {
        if (command.startsWith("ai_usage:"))
            setPermissionFeedback(command == "ai_usage:get" ? QString("refresh")
                                                             : payload.value("feature").toString(),
                                  "error", "本地服务尚未连接，授权操作未能发送。",
                                  command.section(':', 1));
        setNotice("本地服务尚未连接。");
        return {};
    }
    if (command == "user:profile:get" && m_profileClearState.value("status").toString() == "pending" &&
        m_profileClearState.value("receiptConfirmed").toBool() &&
        m_pending.contains(m_profileClearState.value("readId").toString()))
        return m_profileClearState.value("readId").toString();
    static const QStringList mutations = {
        "chat:send", "persona:activate", "persona:import", "persona:profile:update", "archive:put", "memory:edit", "memory:delete",
        "memory:delete_many", "memory:pin_many",
        "memory:reinforce", "memory:candidates:confirm", "memory:candidates:reject",
        "memory:candidates:decide_many",
        "settings:update", "summary:legacy:import", "ai_usage:grant", "ai_usage:revoke",
        "user:profile:update", "game_state:put", "game:move", "diary:write", "keepsake:collect", "keepsake:remove"};
    if (mutations.contains(command) && !runtimeWritable()) {
        setNotice(recoveryWarning());
        return {};
    }
    static const QStringList allowed = {"chat:send",
                                        "chat:cancel",
                                        "chat:reveal",
                                        "chat:history",
                                        "chat:media",
                                        "persona:get",
                                        "persona:list",
                                        "persona:activate",
                                        "persona:import",
                                        "persona:profile:get",
                                        "persona:profile:update",
                                        "archive:get",
                                        "archive:put",
                                        "memory:list",
                                        "memory:query",
                                        "memory:edit",
                                        "memory:delete",
                                        "memory:delete_many",
                                        "memory:pin_status",
                                        "memory:pin_many",
                                        "memory:reinforce",
                                        "memory:candidates:list",
                                        "memory:candidates:confirm",
                                        "memory:candidates:reject",
                                        "memory:candidates:status",
                                        "memory:candidates:decide_many",
                                        "memory:settings:get",
                                        "summary:status",
                                        "summary:get",
                                        "summary:legacy:preview",
                                        "summary:legacy:import",
                                        "settings:get",
                                        "settings:update",
                                        "ai_usage:get",
                                        "ai_usage:grant",
                                        "ai_usage:revoke",
                                        "user:profile:get",
                                        "user:profile:update",
                                        "relationship:get",
                                        "emotion:get",
                                        "diary:request",
                                        "diary:write",
                                        "timeline:request",
                                        "api:budget:get",
                                        "module:list",
                                        "game_state:get",
                                        "game_state:put",
                                        "game:move",
                                        "keepsake:list",
                                        "keepsake:collect", "keepsake:page", "keepsake:remove",
                                        "backup:export"};
    if (!allowed.contains(command)) {
        setNotice("该操作还未接入原生控制器。");
        return {};
    }
    if (command == "chat:media" &&
        (m_chatImageReadMedia.isEmpty() || !m_chatImageReadId.isEmpty() || personaChanging() ||
         payload.size() != 2 || payload.value("media_id") != m_chatImageReadMedia ||
         payload.value("thumbnail").metaType().id() != QMetaType::Bool || !payload.value("thumbnail").toBool()))
        return {};
    if (QStringList{"keepsake:collect", "keepsake:page", "keepsake:remove"}.contains(command) && !m_keepsakeSending)
        return {};
    if (command == "diary:write" &&
        (m_diarySending != DiaryOperation::Write || !payload.isEmpty() || !diaryWriteBlocker().isEmpty()))
        return {};
    if (command == "diary:request" &&
        m_diarySending != DiaryOperation::List && m_diarySending != DiaryOperation::Read)
        return {};
    if (command == "summary:status" && !payload.isEmpty() &&
        (payload.keys() != QStringList{"conversation_id"} ||
         payload.value("conversation_id").metaType().id() != QMetaType::QString ||
         payload.value("conversation_id").toString() != "dream-room"))
        return {};
    if (command == "summary:get" &&
        (!m_summaryDetailSending || personaChanging() || !summaryDirectoryCurrent() ||
         payload.keys() != QStringList{"conversation_id", "summary_id"} ||
         payload.value("conversation_id").metaType().id() != QMetaType::QString ||
         payload.value("conversation_id").toString() != "dream-room" ||
         payload.value("summary_id").metaType().id() != QMetaType::QString ||
         payload.value("summary_id").toString() != m_summaryDetailState.value("summaryId").toString() ||
         !summaryIdValid(payload.value("summary_id").toString()) ||
         m_summaryDirectory.value(payload.value("summary_id").toString()).toObject() != m_summaryDetailMetadata))
        return {};
    if (memoryBatchPinBlocked() &&
        (QStringList{"memory:edit", "memory:delete", "memory:delete_many", "memory:reinforce",
                     "memory:candidates:confirm", "memory:candidates:reject", "memory:candidates:list"}.contains(command) ||
         (command == "memory:list" && !m_memoryPinListSending)))
        return {};
    if (command == "memory:pin_status" &&
        (!m_memoryPinStatusSending || personaChanging() ||
         !QStringList{"previewing", "reading"}.contains(m_memoryBatchPin.value("status").toString()) ||
         m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
         m_memoryBatchPin.value("generation").toInt() != m_generation ||
         payload.keys() != QStringList{"memory_ids"} ||
         payload.value("memory_ids").metaType().id() != QMetaType::QVariantList ||
         payload.value("memory_ids").toList() != m_memoryBatchPin.value("ids").toList()))
        return {};
    if (command == "memory:pin_many" &&
        (m_memoryBatchPin.value("status").toString() != "sending" || personaChanging() ||
         m_memoryBatchPin.value("generation").toInt() != m_generation ||
         m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
         m_memoryBatchPin.value("listRevision").toInt() != m_memoryListRevision ||
         !m_memoryListLive || memoryPinOtherWritePending() ||
         payload.keys() != QStringList{"memory_ids", "pinned"} ||
         payload.value("memory_ids").metaType().id() != QMetaType::QVariantList ||
         payload.value("memory_ids").toList() != m_memoryBatchPin.value("ids").toList() ||
         payload.value("pinned").metaType().id() != QMetaType::Bool ||
         payload.value("pinned") != m_memoryBatchPin.value("pinned")))
        return {};
    if (candidateBatchBlocked() &&
        (QStringList{"memory:edit", "memory:delete", "memory:delete_many", "memory:reinforce", "memory:pin_status",
                     "memory:pin_many", "memory:candidates:confirm", "memory:candidates:reject"}.contains(command) ||
         ((command == "memory:list" || command == "memory:candidates:list") && !m_candidateBatchReading)))
        return {};
    if (command == "memory:candidates:status" &&
        (!m_candidateStatusSending || personaChanging() ||
         !QStringList{"previewing", "reading"}.contains(m_candidateBatch.value("status").toString()) ||
         m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
         m_candidateBatch.value("generation").toInt() != m_generation ||
         payload.keys() != QStringList{"candidate_ids"} ||
         payload.value("candidate_ids").metaType().id() != QMetaType::QVariantList ||
         payload.value("candidate_ids").toList() != m_candidateBatch.value("ids").toList()))
        return {};
    if (command == "memory:candidates:decide_many" &&
        (m_candidateBatch.value("status").toString() != "sending" || personaChanging() ||
         m_candidateBatch.value("generation").toInt() != m_generation ||
         m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
         m_candidateBatch.value("candidateRevision").toInt() != m_candidateRevision ||
         candidateBatchOtherWritePending() ||
         payload.keys() != QStringList{"candidate_ids", "decision"} ||
         payload.value("candidate_ids").metaType().id() != QMetaType::QVariantList ||
         payload.value("candidate_ids").toList() != m_candidateBatch.value("ids").toList() ||
         payload.value("decision").metaType().id() != QMetaType::QString ||
         payload.value("decision") != m_candidateBatch.value("decision")))
        return {};
    if (memoryBatchDeleteBlocked() &&
        QStringList{"memory:edit", "memory:delete", "memory:reinforce",
                    "memory:pin_many",
                    "memory:candidates:confirm", "memory:candidates:reject"}.contains(command)) {
        setNotice(m_memoryBatchDelete.value("status").toString() == "unknown"
            ? "批量删除结果未知，请手动刷新核对；未自动重试。" : "批量删除正在进行，请等待确认。");
        return {};
    }
    if (command == "memory:delete_many" &&
        (m_memoryBatchDelete.value("status").toString() != "sending" ||
         m_memoryBatchDelete.value("generation").toInt() != m_generation ||
         m_memoryBatchDelete.value("scopeKey").toString() != scopeKey() ||
         payload.keys() != QStringList{"memory_ids"} ||
         payload.value("memory_ids").metaType().id() != QMetaType::QVariantList ||
         payload.value("memory_ids").toList() != m_memoryBatchDelete.value("memoryIds").toList()))
        return {};
    if (command == "persona:import" &&
        (m_personaCardJson.isEmpty() || payload.value("json").toString() != m_personaCardJson ||
         payload.value("filename").toString() != m_personaCardCandidate.value("filename").toString() ||
         payload.value("identity_change_confirmed") != QVariant(true) ||
         payload.value("actor").toString() != "owner" || !personaCardActionAllowed()))
        return {};
    if ((command == "persona:profile:get" || command == "persona:profile:update") && !m_personaProfileSending)
        return {};
    if (command == "persona:activate" && (!m_personaImport.isEmpty() || personaCardExportPending() || personaProfilePending() || worldbookFileBusy()))
        return {};
    if (command == "chat:send" && (!m_personaImport.isEmpty() || !m_personaSwitch.isEmpty())) {
        setNotice("人格操作仍在核对中，请等待确认后再发送。");
        return {};
    }
    if (command == "chat:send") {
        if (const auto gate = chatSendGate(); !gate.isEmpty()) {
            setNotice(gate.value("text").toString());
            return {};
        }
    }
    if (command == "settings:update" &&
        (payload.contains(ProactiveEnabled) || payload.contains("proactive_daily_limit") ||
         payload.contains("proactive_min_interval_minutes"))) {
        auto fields = payload;
        fields.remove("section");
        QString error;
        if (!proactiveSettingsPayload(payload) || settingsUpdate("features", fields, &error).isEmpty())
            return {};
    }
    if (command == "ai_usage:grant") {
        const auto feature = payload.value("feature").toString();
        const auto digest = payload.value("consent_digest").toString();
        const auto features = m_state.value("permissions").toMap().value("features").toMap();
        if (!m_permissionsKnown || digest.isEmpty() ||
            features.value(feature).toMap().value("consent_digest").toString() != digest ||
            !payload.value("api_cost_acknowledged").toBool() ||
            !payload.value("user_confirmed").toBool()) {
            setPermissionFeedback(feature, "stale", "授权说明已变化或尚未核对，请刷新后重新确认。", "grant");
            return {};
        }
    }
    // A pending adjustment owns the single-write slot, including direct calls.
    if (memoryAdjustmentPending() &&
        QStringList{"memory:edit", "memory:delete", "memory:delete_many", "memory:pin_many",
                    "memory:reinforce", "memory:candidates:confirm", "memory:candidates:reject",
                    "memory:candidates:decide_many"}.contains(command))
        return {};
    // Only the dedicated method can authorize these exact two payload fields.
    // The dispatch capability never comes from a public payload or persists
    // beyond this request, so another caller cannot reuse it.
    const bool memoryAdjustment = command == "memory:reinforce" &&
        payload.value("op") != "pin" && payload.value("op") != "unpin";
    if (memoryAdjustment) {
        const auto op = payload.value("op").toString();
        if (!QStringList{"strengthen", "weaken", "reactivate"}.contains(op) ||
            m_memoryAdjustDispatch.isEmpty() || personaChanging() ||
            payload.keys() != QStringList{"memory_id", "op"} ||
            payload.value("memory_id").metaType().id() != QMetaType::QString ||
            payload.value("op").metaType().id() != QMetaType::QString ||
            payload.value("memory_id") != m_memoryAdjustDispatch.value("memoryId") ||
            payload.value("op") != m_memoryAdjustDispatch.value("op") ||
            m_memoryAdjustDispatch.value("generation").toInt() != m_generation ||
            m_memoryAdjustDispatch.value("scopeKey").toString() != scopeKey())
            return {};
        m_memoryAdjustDispatch.clear();
    }
    if (command == "memory:candidates:confirm" || command == "memory:candidates:reject") {
        if (m_candidateDecision.value("status").toString() != "sending" ||
            m_candidateDecision.value("command").toString() != command ||
            m_candidateDecision.value("subjectId") != payload.value("candidate_id") ||
            payload.size() != 1 || m_candidateDecision.value("generation").toInt() != m_generation ||
            m_candidateDecision.value("scopeKey").toString() != scopeKey())
            return {};
    }
    if (command == "chat:cancel") {
        const auto subject = payload.value("request_id").toString();
        if (!m_busy || subject != m_chatId || m_chatGeneration != m_generation ||
            m_chatPersona != m_persona)
            return {};
        for (auto it = m_pending.cbegin(); it != m_pending.cend(); ++it)
            if (it->command == command && it->generation == m_generation &&
                it->subjectRequestId == subject)
                return it.key();
    }
    if (command == "user:profile:update") {
        const bool clearing = payload.contains("clear_fields");
        if ((clearing && (!m_profileClearSending ||
                          payload.keys() != QStringList{"clear_fields", "expected_profile_snapshot"} ||
                          payload.value("clear_fields").toStringList() !=
                              m_profileClearState.value("selectedFields").toStringList() ||
                          payload.value("expected_profile_snapshot") != m_profileClearState.value("profileSnapshot"))) ||
            (!clearing && profileClearBlocksWrite()))
            return {};
        // A read dispatched before this mutation cannot later revive its old
        // profile or authorize a proposal for the old snapshot.
        m_profileReadId.clear();
        m_profileSnapshotGeneration = -1;
        if (!clearing && m_profileClearState.value("status").toString() == "confirmation")
            setProfileClearState("stale", "资料保存已开始，请在保存完成后重新选择清空字段。");
    }
    // A newer usage read supersedes the old local observation. Do not leave
    // obsolete requests waiting for timeout after their replies are ignored.
    if (command == "api:budget:get" && !m_budgetReadId.isEmpty())
        m_pending.remove(m_budgetReadId);
    if (command == "relationship:get")
        cancelRelationshipRead();
    if (command == "emotion:get")
        cancelMoodRead();
    auto id = uid();
    m_pending.insert(
        id, {command, m_generation, {}, m_gameGeneration, payload.value("request_id").toString(),
             payload.value("feature").toString()});
    m_pending[id].memoryAdjustment = memoryAdjustment;
    if (command == "chat:history") {
        m_pending[id].chatHistorySequence = ++m_chatHistorySequence;
        m_pending[id].keepsakeRevision = m_keepsakeRevision;
    }
    if (command == "relationship:get") {
        m_relationshipReadId = id;
        m_relationshipReadPersona = m_persona;
    }
    if (command == "emotion:get") {
        m_moodReadId = id;
        m_moodReadPersona = m_persona;
    }
    if (command == "api:budget:get") {
        m_budgetReadId = id;
        m_budgetReadGeneration = m_generation;
        m_budgetReadPersona = m_persona;
        m_budgetState.insert({{"status", "pending"}, {"text", "正在读取今日后台用量…"},
            {"requestId", id}, {"live", false}, {"stale", true},
            {"scopeKey", scopeKey()}, {"generation", m_generation}});
        emit changed();
    }
    if (command == "persona:activate" || command == "persona:import")
        invalidateBudget("人格操作仍在核对中，用量需要重新读取。");
    if (command == "summary:status")
        m_summaryStatusReadId = id;
    if (command == "summary:get") {
        m_summaryDetailId = id;
        m_summaryDetailState["requestId"] = id;
    }
    if (command == "memory:delete_many") {
        m_memoryBatchDelete["requestId"] = id;
        m_memoryBatchDelete["status"] = "pending";
    }
    if (command == "memory:pin_status")
        m_memoryBatchPin[m_memoryBatchPin.value("status").toString() == "previewing"
            ? "previewRequestId" : "statusReadId"] = id;
    if (command == "memory:pin_many") {
        m_memoryBatchPin["requestId"] = id;
        m_memoryBatchPin["status"] = "pending";
    }
    if (command == "memory:candidates:status")
        m_candidateBatch[m_candidateBatch.value("status").toString() == "previewing"
            ? "previewRequestId" : "statusReadId"] = id;
    if (command == "memory:candidates:decide_many") {
        m_candidateBatch["requestId"] = id;
        m_candidateBatch["status"] = "pending";
    }
    if (command == "user:profile:get") {
        m_profileReadId = id;
        if (m_profileClearState.value("status").toString() == "unknown" &&
            !m_profileClearState.value("reconcileAttempted").toBool() &&
            m_profileClearState.value("scopeKey").toString() == scopeKey()) {
            m_profileClearState["reconcileAttempted"] = true;
            m_profileClearState["readId"] = id;
        }
    }
    if (command.startsWith("ai_usage:")) {
        m_pending[id].permissionContextEpoch = m_permissionContextEpoch;
        m_pending[id].permissionSequence = ++m_permissionSequence;
        if (command != "ai_usage:get")
            m_permissionsKnown = false;
        const auto key = command == "ai_usage:get" ? QString("refresh")
                                                   : payload.value("feature").toString();
        setPermissionFeedback(key, "pending", command == "ai_usage:get" ? "正在刷新授权状态…"
                                                                      : "正在等待授权操作确认…",
                              command.section(':', 1), id);
    }
    if (command == "chat:cancel")
        setCancelFeedback("pending", "正在请求停止本次回复…", id,
                          payload.value("request_id").toString());
    if (!write(rendererFrame(command, obj(payload), id, m_persona))) {
        m_pending.remove(id);
        if (command == "relationship:get")
            failRelationshipRead();
        if (command == "emotion:get")
            failMoodRead();
        if (command == "api:budget:get" && m_budgetReadId == id) {
            invalidateBudget("用量请求未能发送，请核对连接后刷新。");
            emit changed();
        }
        if (command == "summary:status" && m_summaryStatusReadId == id) {
            m_summaryStatusReadId.clear();
            m_state["summary"] = summaryStatusSnapshot({{"ok", false}, {"status", "unavailable"}});
            emit changed();
        }
        if (command == "memory:delete_many")
            unknownMemoryBatchDelete();
        if (command == "memory:pin_many")
            unknownMemoryBatchPin();
        if (command == "memory:candidates:decide_many")
            unknownCandidateBatch();
        if (command == "user:profile:get" && m_profileReadId == id) {
            m_profileReadId.clear();
            m_profileSnapshotGeneration = -1;
        }
        if (command.startsWith("ai_usage:"))
            setPermissionFeedback(command == "ai_usage:get" ? QString("refresh")
                : payload.value("feature").toString(), "error", "请求未能发送，请核对连接后重试。",
                command.section(':', 1), id);
        if (command == "chat:cancel")
            setCancelFeedback("error", "停止请求未能发送，正在等待本次回复的结束状态。", id,
                              payload.value("request_id").toString());
        emit requestFailed(id, "transport_failed", m_generation);
        return {};
    }
    m_commands++;
    if (command == "chat:history" && m_proactiveHistoryDirty && !m_busy && m_proactiveHistoryId.isEmpty()) {
        m_proactiveHistoryDirty = false;
        m_proactiveHistoryId = id;
        m_proactiveHistoryBatch.swap(m_proactiveHistoryQueued);
    }
    if (command == "persona:activate" || command == "persona:import") {
        cancelRelationshipRead();
        cancelMoodRead();
        clearDiary();
        clearKeepsakes();
    }
    emit commandSent(id, command, scopeKey(), m_generation);
    if (command == "relationship:get" || command == "emotion:get")
        emit changed();
    if (command == "game_state:get" || command == "game_state:put" || command == "game:move")
        emit gameCommandSent(id, command);
    if (command == "game_state:get" || command == "game_state:put")
        emit gameStateDispatched(id, payload);
    if (command == "settings:update" && proactiveSettingsPayload(payload))
        emit proactiveSettingsDispatched(id, payload);
    if (command == "ai_usage:grant" && payload.value("feature") == "proactive_chat") {
        emit proactiveSettingsDispatched(id, {{"feature", "proactive_chat"},
            {"api_cost_acknowledged", payload.value("api_cost_acknowledged").toBool()},
            {"user_confirmed", payload.value("user_confirmed").toBool()}});
    }
    if (command == "api:budget:get") {
        if (m_budgetDispatchGeneration != m_generation) {
            m_budgetDispatchGeneration = m_generation;
            m_budgetReadDispatchCount = 0;
        }
        ++m_budgetReadDispatchCount;
        emit changed();
    }
    if (command == "memory:delete_many")
        ++m_memoryBatchDeleteDispatchCount;
    if (command == "memory:pin_many")
        ++m_memoryBatchPinDispatchCount;
    if (command == "memory:pin_status")
        ++m_memoryPinStatusDispatchCount;
    if (command == "memory:candidates:decide_many")
        ++m_candidateBatchDispatchCount;
    if (command == "memory:candidates:status")
        ++m_candidateStatusDispatchCount;
    if (command == "chat:send")
        clearPersonaCardCandidate();
    if (command != "chat:send" && command != "persona:import" && command != "persona:activate")
        QTimer::singleShot(command == "diary:write" ? DiaryWriteTimeoutMs : command == "summary:get" ? 10000 : 30000, this,
                           [this, id] { expirePending(id); });
    return id;
}
QString RuntimeBridge::control(const QString &type, QJsonObject fields,
                               std::function<void(QJsonObject)> callback, int timeoutMs) {
    auto id = uid();
    fields["kind"] = "control";
    fields["schema"] = "reverie.bridge.stdio.control.v4";
    fields["requestId"] = id;
    fields["type"] = type;
    m_pending.insert(id, {type, m_generation, std::move(callback)});
    if (type == "provider:get" || type == "provider:configure")
        m_pending[id].permissionContextEpoch = m_permissionContextEpoch;
    if (!write(fields)) {
        const auto p = m_pending.take(id);
        if (p.callback)
            p.callback({{"requestId", id}, {"type", type}, {"ok", false},
                        {"not_sent", true}, {"code", "transport_failed"}});
        emit requestFailed(id, "transport_failed", m_generation);
        return {};
    }
    if (timeoutMs > 0)
        QTimer::singleShot(timeoutMs, this, [this, id] { expirePending(id); });
    emit commandSent(id, type, scopeKey(), m_generation);
    return id;
}
void RuntimeBridge::refresh(bool readPersonaStatus) {
    for (const QString c :
         {"persona:get", "persona:list", "settings:get", "chat:history", "relationship:get", "emotion:get",
          "archive:get", "summary:status", "ai_usage:get", "api:budget:get", "user:profile:get", "module:list"}) {
        if (readPersonaStatus || (c != "relationship:get" && c != "emotion:get"))
            request(c);
    }
    const int epoch = m_permissionContextEpoch;
    control("provider:get", {}, [this, epoch](QJsonObject r) {
        if (epoch != m_permissionContextEpoch)
            return;
        if (r["ok"].toBool() && validProviderSnapshot(r["llm"])) {
            m_state["provider"] = r["llm"].toObject().toVariantMap();
            m_providerConfirmedHandshake = m_handshakes;
            // Every handshake, identity reset and restore ends in this read.
            applyProviderKey(r["llm"].toObject(), m_keyAppliedHandshake == m_handshakes ? "refresh" : "startup");
            observeProviderKeyClear(r["llm"].toObject(), false);
        } else if (r["ok"].toBool() && unconfiguredProviderSnapshot(r["llm"])) {
            markProviderUnconfigured();
        }
        emit changed();
    });
    if (m_panel == "diary")
        refreshDiary();
}
void RuntimeBridge::invalidatePermissions() {
    ++m_permissionContextEpoch;
    m_permissionSequence = 0;
    m_permissionsKnown = false;
    m_permissionProviderReadId.clear();
    m_permissionFeedback.clear();
    // Retain descriptions as a display cache. Only a fresh scoped snapshot may
    // make this cache authoritative again.
    setPermissionFeedback("refresh", "unknown", "当前服务的授权状态尚未核对。", "get");
}
void RuntimeBridge::refreshPermissions() {
    if (!m_connected) {
        m_permissionsKnown = false;
        request("ai_usage:get");
        return;
    }
    // A lost configure acknowledgement leaves the active provider uncertain.
    // Read it first; never repeat the mutation to recover an acknowledgement.
    if (m_providerContextUnknown)
        readProviderForPermissions(false);
    else if (m_providerSaveId.isEmpty())
        request("ai_usage:get");
}
void RuntimeBridge::readProviderForPermissions(bool reconcileSave) {
    if (!m_connected || !m_providerSaveId.isEmpty() || !m_permissionProviderReadId.isEmpty())
        return;
    const int epoch = m_permissionContextEpoch;
    setPermissionFeedback("refresh", "pending", "正在核对当前回复服务及授权状态…", "get");
    m_permissionProviderReadId = control("provider:get", {}, [this, epoch, reconcileSave](QJsonObject r) {
        if (epoch != m_permissionContextEpoch)
            return;
        m_permissionProviderReadId.clear();
        const bool success = !r["unknown"].toBool() && r["ok"].toBool() &&
                             validProviderSnapshot(r["llm"]);
        if (!reconcileSave && !success && !r["unknown"].toBool() && r["ok"].toBool() && unconfiguredProviderSnapshot(r["llm"])) {
            // The current service is known: none is chosen yet. No key belongs to it.
            m_providerContextUnknown = false;
            markProviderUnconfigured();
            request("ai_usage:get");
            emit changed();
            return;
        }
        if (!success) {
            m_permissionsKnown = false;
            setPermissionFeedback("refresh", "unknown",
                                  "当前服务未能核对，授权状态未知；可手动刷新重试。", "get");
            return;
        }
        m_state["provider"] = r["llm"].toObject().toVariantMap();
        m_providerContextUnknown = false;
        m_providerConfirmedHandshake = m_handshakes;
        // An unconfirmed save may have changed the destination and cleared the service's key.
        m_keyAppliedHandshake = -1;
        applyProviderKey(r["llm"].toObject(), "reconcile");
        observeProviderKeyClear(r["llm"].toObject(), false);
        if (reconcileSave && m_providerFeedback.value("status").toString() == "unknown")
            setProviderFeedback("unknown", "原保存结果未知；已读取当前服务，正在核对授权。",
                                m_providerFeedback.value("currentDraft").toBool());
        request("ai_usage:get");
        emit changed();
    });
}
void RuntimeBridge::markProviderUnconfigured() {
    m_providerUnconfiguredHandshake = m_handshakes;
    m_providerConfirmedHandshake = -1;
}
void RuntimeBridge::event(const QJsonObject &f) {
    const auto type = f["type"].toString();
    const auto payload = f["payload"].toObject();
    if (type == "proactive:message") {
        observeProactiveMessage(f, payload);
        return;
    }
    auto id = f["request_id"].toString();
    if (id.isEmpty())
        id = payload["request_id"].toString();
    if (acceptChatImageThumbnail(f, payload, id))
        return;
    if (diaryOperation(id) != DiaryOperation::None && f.contains("request_id") && f["request_id"] != id)
        return;
    if (acceptKeepsakeResponse(id, type, payload))
        return;
    if (acceptDiaryResponse(id, type, payload))
        return;
    if (m_pending.value(id).command == "relationship:get") {
        if (!m_connected || id != m_relationshipReadId ||
            m_pending.value(id).generation != m_generation || m_relationshipReadPersona != m_persona ||
            (type != "relationship:data" && type != "error") ||
            (f.contains("request_id") && f["request_id"] != id) ||
            (payload.contains("request_id") && payload["request_id"] != id) ||
            (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
            (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
            (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
            return;
        if (type == "error" || payload.contains("error") || payload["ok"] == false) {
            failRelationshipRead();
        } else {
            cancelRelationshipRead();
            m_relationshipDisplay = relationshipDisplay(payload, id);
            if (m_relationshipDisplay.isEmpty()) {
                m_state.remove("relationship");
            } else {
                m_lastRelationshipDisplay = m_relationshipDisplay;
                m_state["relationship"] = payload.toVariantMap();
            }
            emit changed();
        }
        emit responseReceived(id, "relationship:get", payload.toVariantMap(), m_generation);
        emit commandResult("relationship:get", payload.toVariantMap());
        return;
    }
    if (type == "relationship:data")
        return;
    if (m_pending.value(id).command == "emotion:get") {
        if (!m_connected || moodDisabled() || id != m_moodReadId ||
            m_pending.value(id).generation != m_generation || m_moodReadPersona != m_persona ||
            (type != "emotion:update" && type != "error") ||
            (f.contains("request_id") && f["request_id"] != id) ||
            (payload.contains("request_id") && payload["request_id"] != id) ||
            (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
            (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
            (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
            return;
        if (type == "error" || payload.contains("error") || payload["ok"] == false) {
            failMoodRead();
        } else {
            cancelMoodRead();
            m_moodDisplay = moodDisplay(payload, id);
            if (!m_moodDisplay.isEmpty())
                m_lastMoodDisplay = m_moodDisplay;
            emit changed();
        }
        emit responseReceived(id, "emotion:get", payload.toVariantMap(), m_generation);
        emit commandResult("emotion:get", payload.toVariantMap());
        return;
    }
    if (type == "emotion:update")
        return;
    const auto pinCommand = m_pending.value(id).command;
    const bool pinList = pinCommand == "memory:list" &&
        id == m_memoryBatchPin.value("listReadId").toString() &&
        m_memoryBatchPin.value("status").toString() == "reading";
    if (m_pending.contains(id) && (pinCommand == "memory:pin_status" || pinCommand == "memory:pin_many" || pinList)) {
        // These IDs own only their pin receipt/read. A reply cannot masquerade
        // as an identity, recovery, activity or unrelated controller event.
        if (!m_connected || m_pending.value(id).generation != m_generation ||
            m_memoryBatchPin.value("generation").toInt() != m_generation ||
            m_memoryBatchPin.value("scopeKey").toString() != scopeKey() ||
            (f.contains("request_id") && (!f["request_id"].isString() || f["request_id"].toString() != id)) ||
            (payload.contains("request_id") && payload["request_id"] != id) ||
            (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
            (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
            (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
            return;
        m_pending.remove(id);
        if (pinCommand == "memory:pin_status")
            applyMemoryPinStatus(type, payload, id);
        else if (pinCommand == "memory:pin_many")
            finishMemoryBatchPin(type, payload, id);
        else {
            applyMemoryPage(true, type, payload, payload.contains("ok") && !payload["ok"].toBool(), id);
            const auto receipt = m_memoryFeedback.value("list").toMap();
            settleMemoryBatchPinList(type, payload, id, receipt.value("requestId").toString() == id &&
                receipt.value("status").toString() == "success");
        }
        emit responseReceived(id, pinCommand, payload.toVariantMap(), m_generation);
        emit commandResult(pinCommand, payload.toVariantMap());
        emit changed();
        return;
    }
    const auto batchCommand = m_pending.value(id).command;
    const bool batchCandidateList = batchCommand == "memory:candidates:list" &&
        id == m_candidateBatch.value("candidateReadId").toString() &&
        m_candidateBatch.value("status").toString() == "reading";
    const bool batchMemoryList = batchCommand == "memory:list" &&
        id == m_candidateBatch.value("listReadId").toString() &&
        m_candidateBatch.value("status").toString() == "reading";
    if (m_pending.contains(id) &&
        (batchCommand == "memory:candidates:status" || batchCommand == "memory:candidates:decide_many" ||
         batchCandidateList || batchMemoryList)) {
        // Every batch request owns only its preview, receipt or one fresh read.
        // A list reply cannot masquerade as an identity or activity broadcast.
        if (!m_connected || m_pending.value(id).generation != m_generation ||
            m_candidateBatch.value("generation").toInt() != m_generation ||
            m_candidateBatch.value("scopeKey").toString() != scopeKey() ||
            (f.contains("request_id") && (!f["request_id"].isString() || f["request_id"].toString() != id)) ||
            (payload.contains("request_id") && payload["request_id"] != id) ||
            (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
            (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
            (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
            return;
        m_pending.remove(id);
        if (batchCommand == "memory:candidates:status")
            applyCandidateBatchStatus(type, payload, id);
        else if (batchCommand == "memory:candidates:decide_many")
            finishCandidateBatch(type, payload, id);
        else {
            const bool positive = type == (batchCandidateList ? "memory:candidates:result" : "memory:result") &&
                payload["ok"].isBool() && payload["ok"].toBool() && !payload.contains("error") &&
                !payload.contains("error_code") && !payload.contains("code");
            bool applied = false;
            if (positive && batchCandidateList)
                applied = applyCandidatePage(type, payload, false, id);
            else if (positive) {
                applyMemoryPage(true, type, payload, false, id);
                const auto receipt = m_memoryFeedback.value("list").toMap();
                applied = receipt.value("requestId").toString() == id &&
                    receipt.value("status").toString() == "success";
            }
            settleCandidateBatchRead(id, applied);
        }
        emit responseReceived(id, batchCommand, payload.toVariantMap(), m_generation);
        emit commandResult(batchCommand, payload.toVariantMap());
        emit changed();
        return;
    }
    if (m_pending.contains(id) && m_pending.value(id).command == "api:budget:get") {
        // Budget reads own no identity, activity, settings or other controller events.
        // An older read may still be pending in this generation, but cannot be current.
        if (!m_connected || m_stopping || m_pending.value(id).generation != m_generation ||
            id != m_budgetReadId || m_budgetReadGeneration != m_generation ||
            m_budgetReadPersona != m_persona ||
            m_budgetState.value("requestId").toString() != id ||
            (f.contains("request_id") && (!f["request_id"].isString() || f["request_id"].toString().isEmpty())) ||
            (payload.contains("request_id") && payload["request_id"] != id) ||
            (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
            (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
            (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
            return;
        m_pending.remove(id);
        applyBudgetRead(type, payload, id);
        emit responseReceived(id, "api:budget:get", payload.toVariantMap(), m_generation);
        emit commandResult("api:budget:get", payload.toVariantMap());
        emit changed();
        return;
    }
    // Unsolicited frames and another command's request ID cannot update the ledger.
    if (type == "api:budget:result")
        return;
    if (m_pending.contains(id) && m_pending.value(id).command == "summary:get") {
        // This read owns no global state transition. A malformed reply must
        // never masquerade as a settings, activity, identity or chat event.
        if (!m_connected || m_pending.value(id).generation != m_generation ||
            id != m_summaryDetailId || m_summaryDetailGeneration != m_generation ||
            m_summaryDetailPersona != m_persona ||
            m_summaryDetailState.value("requestId").toString() != id ||
            ((payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
             (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
             (payload.contains("persona_fingerprint") &&
              payload["persona_fingerprint"] != m_persona["fingerprint"])) ||
            (payload.contains("conversation_id") && payload["conversation_id"] != "dream-room"))
            return;
        m_pending.remove(id);
        applySummaryDetail(type, payload, id);
        emit responseReceived(id, "summary:get", payload.toVariantMap(), m_generation);
        emit commandResult("summary:get", payload.toVariantMap());
        return;
    }
    if (m_pending.contains(id) && m_pending.value(id).command == "memory:delete_many") {
        // stale_persona is a definitive prewrite refusal that intentionally
        // includes the backend's newer proof. The local operation association
        // must still be current; an actual local identity change drops it.
        const bool stalePersonaRefusal = memoryBatchPrewriteRejection(type, payload) &&
            payload["code"] == "stale_persona";
        if (m_pending.value(id).generation != m_generation ||
            m_memoryBatchDelete.value("generation").toInt() != m_generation ||
            m_memoryBatchDelete.value("scopeKey").toString() != scopeKey() ||
            (!stalePersonaRefusal &&
             ((payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
              (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
              (payload.contains("persona_fingerprint") &&
               payload["persona_fingerprint"] != m_persona["fingerprint"]))))
            return;
        // A correlated malformed receipt cannot masquerade as a global
        // activity/identity event and escape the unknown-outcome lock.
        m_pending.remove(id);
        finishMemoryBatchDelete(type, payload, id);
        emit responseReceived(id, "memory:delete_many", payload.toVariantMap(), m_generation);
        emit commandResult("memory:delete_many", payload.toVariantMap());
        return;
    }
    if (type == "runtime:activity") {
        // Activity broadcasts have no ID. A late reply for an invalidated
        // read must obey the same correlation gate as other result frames.
        if ((!id.isEmpty() && !m_pending.contains(id) && id != m_chatId) ||
            (m_pending.contains(id) && m_pending.value(id).generation != m_generation))
            return;
        const bool wasWritable = runtimeWritable();
        const bool startupReplay = m_recoveryState == "recovering" && !m_backupRestoring;
        applyRecoverySnapshot(payload);
        if (wasWritable && !runtimeWritable() && m_opponentPending)
            cancelOpponent();
        if (!wasWritable && runtimeWritable() && gamePanelOpen() &&
            m_gamePhase == GamePhase::Ready) {
            if (m_gameRevision == 0)
                gameRead();
            else
                scheduleOpponent();
        }
        if (!wasWritable && runtimeWritable() && !m_networkFeedback.value("known").toBool() &&
            m_networkFeedback.value("status").toString() != "pending")
            setOffline(m_offline);
        if (startupReplay && m_recoveryState != "recovering" && m_recoveryState != "unknown") {
            refresh();
            readMemories(true);
            emit backupRestoreReconciled();
        }
        emit changed();
        emit gameChanged();
        return;
    }
    // The backend commits/broadcasts the identity before this original result.
    // Its private association deliberately outlives the ordinary pending map.
    if (!id.isEmpty() && id == m_personaImport.value("requestId").toString() &&
        (type == "persona:import:result" || type == "error")) {
        finishPersonaCardImport(type, payload, id);
        return;
    }
    if (type == "diary:result")
        return;
    const bool hasPending = m_pending.contains(id);
    const auto pending = m_pending.value(id);
    if (hasPending && pending.generation != m_generation)
        return;
    if (!id.isEmpty() && !hasPending && id != m_chatId)
        return;
    if (type == "persona:data" && payload.contains("persona_fingerprint")) {
        QJsonObject proof{{"persona_id", payload["persona_id"]},
                          {"epoch", payload["persona_epoch"]},
                          {"fingerprint", payload["persona_fingerprint"]}};
        if (proof != m_persona) {
            // A late old persona snapshot cannot revive a previous generation.
            if (proof["epoch"].toInt() <= m_persona["epoch"].toInt())
                return;
            observePersonaCardIdentity(proof, payload);
            m_persona = proof;
            m_generation++;
            // End the previous identity's requests before anything announces the
            // new one: a listener that reloads on that announcement, such as the
            // archive editor, keeps its read for the new identity.
            m_pending.clear();
            m_providerGeneration++;
            m_providerTest = {};
            m_providerSaveId.clear();
            m_providerContextUnknown = false;
            invalidatePermissions();
            // Settings are app-wide and re-read below; a save in flight has lost its receipt.
            unsettleSettingsSaves("人格已切换，设置保存结果未确认；已重新读取当前设置。");
            m_busy = false;
            m_chatId.clear();
            m_chatGeneration = -1;
            m_chatPersona = {};
            m_chatFeedback = {{"status", "idle"}, {"text", ""}};
            m_memoryFeedback.clear();
            m_backupRestoring = false;
            discardStagedBackup();
            m_providerFeedback = {{"status", "stale"}, {"text", "人格已切换，请重新测试当前服务。"},
                                  {"pending", false}, {"saving", false}};
            m_messages.clear();
            resetPersonaState();
            m_archive.clear();
            m_legacyContent.clear();
            m_legacySha.clear();
            setDraft("");
            emit messagesChanged();
            setOffline(m_offline);
            refresh();
            settlePersonaSwitch(payload["restart_required"].toBool());
            settlePersonaCardReceipt();
            emit changed();
            return;
        }
    }
    if (type == "bridge:persona_scope" || type == "persona:scope") {
        if (payload["epoch"].toInt() <= m_persona["epoch"].toInt())
            return;
        observePersonaCardIdentity({{"persona_id", payload["persona_id"]},
                                   {"epoch", payload["epoch"]},
                                   {"fingerprint", payload["fingerprint"]}}, payload);
        m_generation++;
        // As above: the previous identity's requests end before any announcement.
        m_pending.clear();
        m_providerGeneration++;
        unsettleSettingsSaves("人格已切换，设置保存结果未确认；已重新读取当前设置。");
        m_busy = false;
        m_chatId.clear();
        m_chatGeneration = -1;
        m_chatPersona = {};
        m_providerTest = {};
        m_providerSaveId.clear();
        m_providerContextUnknown = false;
        invalidatePermissions();
        m_chatFeedback = {{"status", "idle"}, {"text", ""}};
        m_memoryFeedback.clear();
        m_backupRestoring = false;
        discardStagedBackup();
        m_providerFeedback = {{"status", "stale"}, {"text", "人格已切换，请重新测试当前服务。"},
                              {"pending", false}, {"saving", false}};
        m_messages.clear();
        setDraft("");
        m_persona = {{"persona_id", payload["persona_id"]},
                     {"epoch", payload["epoch"]},
                     {"fingerprint", payload["fingerprint"]}};
        resetPersonaState();
        m_archive.clear();
        emit messagesChanged();
        setOffline(m_offline);
        refresh();
        settlePersonaSwitch(false);
        settlePersonaCardReceipt();
        emit changed();
        return;
    }
    // The activation reply carries the new identity, so it is settled before
    // the scope filter below would drop it as foreign.
    if (hasPending && pending.command == "persona:activate" &&
        (type == "persona:import:result" || type == "error")) {
        m_pending.remove(id);
        finishPersonaActivation(type, payload, id);
        return;
    }
    if (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"])
        return;
    if (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"])
        return;
    if (payload.contains("persona_fingerprint") &&
        payload["persona_fingerprint"] != m_persona["fingerprint"])
        return;
    QString command = hasPending ? pending.command : QString();
    if (command == "persona:profile:get" || command == "persona:profile:update") {
        if (m_personaProfileGeneration != m_generation || m_personaProfileProof != m_persona ||
            id != m_personaProfileState.value("requestId").toString())
            return;
        m_pending.remove(id);
        finishPersonaProfile(type, payload, id);
        emit responseReceived(id, command, payload.toVariantMap(), m_generation);
        emit commandResult(command, payload.toVariantMap());
        return;
    }
    if (command == "memory:reinforce") {
        const auto action = m_memoryFeedback.value("action").toMap();
        if (action.value("requestId").toString() == id && action.contains("adjustmentOp") &&
            (action.value("generation").toInt() != m_generation ||
             action.value("scopeKey").toString() != scopeKey()))
            return;
    }
    if (command == "summary:status" && id != m_summaryStatusReadId) {
        m_pending.remove(id);
        return;
    }
    if (command == "memory:query" && id == m_memoryRecallId) {
        if (m_memoryRecallGeneration != m_generation || m_memoryRecallPersona != m_persona)
            return;
        m_pending.remove(id);
        applyMemoryRecall(type, payload, id);
        emit responseReceived(id, command, payload.toVariantMap(), m_generation);
        emit commandResult(command, payload.toVariantMap());
        return;
    }
    if (command.startsWith("ai_usage:") &&
        pending.permissionContextEpoch != m_permissionContextEpoch) {
        m_pending.remove(id);
        return;
    }
    if (!id.isEmpty() && (id == m_gameReadId || id == m_gameSaveId || id == m_gameMoveId)) {
        m_pending.remove(id);
        if (pending.gameEpoch != m_gameGeneration)
            return;
        finishGameRequest(command, type, payload);
        emit responseReceived(id, command, payload.toVariantMap(), m_generation);
        emit commandResult(command, payload.toVariantMap());
        return;
    }
    const bool chatEvent = type.startsWith("chat:") && type != "chat:history:result";
    const auto subject = payload["request_id"].toString(
        pending.subjectRequestId.isEmpty() ? id : pending.subjectRequestId);
    const bool currentChat = !m_chatId.isEmpty() && subject == m_chatId &&
                             m_chatGeneration == m_generation && m_chatPersona == m_persona;
    if (chatEvent && !currentChat) {
        // A known old request may acknowledge its own error, but cannot mutate
        // the active chat, deliver bubbles or trigger a reveal/history refresh.
        if (type != "chat:error")
            return;
    }
    const auto chatState = payload["state"].toString(payload["status"].toString());
    const bool terminalState = QStringList{"done", "cancelled", "failed", "failed_uncertain", "error"}
                                   .contains(chatState);
    if (command == "chat:cancel") {
        if (!currentChat || pending.subjectRequestId != m_chatId)
            return;
        const bool authoritativeTerminal = (type == "chat:state" || type == "chat:status") &&
                                           terminalState;
        const bool failed = type == "error" || type == "chat:error" ||
                            type == "chat_cancel_result.error" ||
                            !payload["error"].toString().isEmpty() ||
                            (payload["ok"].isBool() && !payload["ok"].toBool());
        if (failed && !authoritativeTerminal) {
            m_pending.remove(id);
            setCancelFeedback("error", "停止请求未获确认，等待本次回复结束状态；可再次手动停止。",
                              id, pending.subjectRequestId);
            emit responseReceived(id, command, payload.toVariantMap(), m_generation);
            emit commandResult(command, payload.toVariantMap());
            return;
        }
    }
    const bool chatProgress = command == "chat:send" && chatEvent &&
                              type != "chat:error" && type != "chat:done" &&
                              type != "chat:cancelled" && type != "chat:stop:result" &&
                              !terminalState;
    const bool cancelProgress = command == "chat:cancel" && !terminalState &&
                                type != "chat:cancelled" && type != "chat:stop:result";
    if (hasPending && !chatProgress && !cancelProgress)
        m_pending.remove(id);
    if (type == "chat:error" || type == "error") {
        if (currentChat && id == m_chatId && type == "error" &&
            f["request_id"] == id && (!payload.contains("request_id") || payload["request_id"] == id) &&
            rejectSentChatImage(payload))
            return;
        if (m_previewMode && currentChat) {
            const auto provider = m_state.value("provider").toMap().value("provider").toString();
            const QStringList providers{"openai", "anthropic", "gemini", "grok", "deepseek", "kimi", "glm", "ollama", "custom"};
            emit previewEvent("service_failure", payload["code"].toString(), providers.indexOf(provider) + 1);
        }
        if (currentChat && id == m_chatId) {
            finishChat(payload["provider_outcome_unknown"].toBool() ? "failed_uncertain" : "failed");
            readProactiveHistory();
            // Legacy notice remains available to existing diagnostics. The
            // panel feedback above deliberately excludes raw backend errors.
            setNotice(payload["error"].toString(payload["message"].toString("操作被服务拒绝。")));
        } else
            setNotice(payload["error"].toString(payload["message"].toString("操作被服务拒绝。")));
    }
    if (currentChat && m_chatImageInFlight &&
        (type == "chat:bubble" || type == "chat:done" ||
         ((type == "chat:status" || type == "chat:state") &&
          QStringList{"queued", "generating", "ready_waiting", "delivering", "done"}.contains(chatState)))) {
        if (m_draft == m_chatImageSentDraft)
            setDraft("");
        m_chatImageInFlight = false;
        m_chatImageSentDraft.clear();
    }
    if ((type == "chat:status" || type == "chat:state") && currentChat) {
        if (terminalState) {
            const bool hasFailure = type == "chat:state" && (chatState == "failed" || chatState == "failed_uncertain");
            const auto failureCode = hasFailure ? chatFailureCode(payload) : QString();
            if (m_previewMode && !failureCode.isEmpty()) {
                const auto provider = m_state.value("provider").toMap().value("provider").toString();
                const QStringList providers{"openai", "anthropic", "gemini", "grok", "deepseek", "kimi", "glm", "ollama", "custom"};
                emit previewEvent("service_failure", failureCode, providers.indexOf(provider) + 1);
            }
            finishChat(chatState == "error" ? "failed" : chatState, hasFailure ? payload : QJsonObject{});
            request("chat:history");
            if (chatState == "done") {
                request("summary:status");
                refreshVisiblePersonaStatus();
            }
        } else {
            const QHash<QString, QString> labels{{"queued", "已收到，正在等待回复…"},
                                                 {"generating", "正在生成回复…"},
                                                 {"ready_waiting", "回复已准备好，正在读取…"},
                                                 {"delivering", "正在送达回复…"}};
            if (labels.contains(chatState))
                setChatFeedback(chatState, labels.value(chatState));
            if (chatState == "ready_waiting") {
                bool revealing = false;
                for (const auto &p : m_pending)
                    revealing |= p.generation == m_generation && p.command == "chat:reveal" &&
                                 p.subjectRequestId == m_chatId;
                if (!revealing)
                    request("chat:reveal", {{"request_id", m_chatId}});
            }
        }
    }
    if (type == "chat:bubble" && currentChat) {
        const auto text = payload["text"].toString();
        if (!text.isEmpty()) {
            m_messages.append(QVariantMap{{"id", payload["delivery_id"].toString()},
                                          {"role", "assistant"}, {"content", text}});
            emit messagesChanged();
        }
    }
    if (type == "chat:done" && currentChat) {
        finishChat("done");
        request("chat:history");
        request("summary:status");
        refreshVisiblePersonaStatus();
    }
    if ((type == "chat:cancelled" || type == "chat:stop:result") && currentChat &&
        payload["ok"].toBool(true)) {
        finishChat("cancelled");
        request("chat:history");
    }
    const bool proactiveRead = !id.isEmpty() && id == m_proactiveHistoryId && command == "chat:history";
    const bool validHistory = type == "chat:history:result" && payload["items"].isArray() &&
        (!proactiveRead || (!payload.contains("error") && payload["ok"].toBool(true)));
    if (proactiveRead) {
        m_proactiveHistoryId.clear();
        if (!validHistory) {
            for (const auto &announcement : m_proactiveHistoryBatch)
                m_proactiveAnnouncements.remove(announcement);
        }
        m_proactiveHistoryBatch.clear();
        m_proactiveHistoryDirty |= m_busy || !validHistory;
    }
    const bool freshHistory = !m_chatHistoryApplied || !pending.chatHistorySequence ||
        pending.chatHistorySequence >= m_chatHistoryApplied;
    if (validHistory && freshHistory &&
        !(m_busy && (proactiveRead || m_proactiveHistoryDirty || !m_proactiveHistoryId.isEmpty()))) {
        if (proactiveRead || m_chatHistoryApplied || !m_proactiveHistoryId.isEmpty())
            m_chatHistoryApplied = pending.chatHistorySequence;
        m_messages = payload["items"].toArray().toVariantList();
        if (pending.keepsakeRevision == m_keepsakeRevision)
            applyKeepsakeMessageIds(payload["preview_keepsake_message_ids"]);
        discoverChatImageThumbnails();
        emit messagesChanged();
    }
    if (proactiveRead && validHistory)
        readProactiveHistory();
    static const QHash<QString, QString> keys = {{"persona:data", "persona"},
                                                 {"persona:list:result", "personas"},
                                                 {"settings:get:result", "settings"},
                                                 {"settings:update:result", "settingsSave"},
                                                 {"archive:result", "archive"},
                                                 {"summary:result", "summary"},
                                                 {"timeline:result", "timeline"},
                                                 {"module:result", "modules"},
                                                 {"game_state:result", "game"}};
    const bool failedResult = payload.contains("ok") && !payload["ok"].toBool();
    const bool summaryStatusSuccess = type == "summary:result" && payload["ok"].isBool() &&
        payload["ok"].toBool() && !payload.contains("error") &&
        (!payload.contains("operation") || payload["operation"] == "status") &&
        (!payload.contains("conversation_id") || payload["conversation_id"] == "dream-room");
    if (command == "user:profile:get" || command == "user:profile:update")
        observeProfileResult(command, type, payload, id);
    // Preview, import and detail replies share summary:result with the status read;
    // only a successful status read may drive the summary switch. The memory
    // list is built page by page below, never from a raw memory:result; a
    // semantic memory:query result has no IDs and never reaches it. Candidate
    // decisions share candidates' result type; only a successful list read may
    // replace a shown list.
    // A failed or partial settings read keeps the last complete snapshot.
    const bool skipResult = (type == "persona:list:result" && failedResult) ||
                            (type == "settings:get:result" && !validSettingsSnapshot(payload)) ||
                            (type == "summary:result" && (command != "summary:status" || !summaryStatusSuccess));
    if (keys.contains(type) && !skipResult) {
        m_state[keys[type]] = type == "summary:result" ? summaryStatusSnapshot(payload)
                                                       : payload.toVariantMap();
        if (type == "archive:result" && payload["ok"].toBool()) {
            m_archive = payload.toVariantMap();
            m_personaCardExportArchiveGeneration = m_generation;
            m_personaCardExportArchivePersona = m_persona;
            if (!m_state.contains("worldbookEdit") || command == "archive:put")
                m_state["worldbookEdit"] = m_archive;
        }
        if (type == "persona:list:result" && payload["ok"].isBool() && payload["ok"].toBool() &&
            command == "persona:list")
            m_personaCardExportProfilesGeneration = m_generation;
        emit changed();
    }
    if (command.startsWith("ai_usage:")) {
        const bool success = type == "ai_usage:result" && validPermissionSnapshot(payload) &&
                             payload["ok"].toBool(true) && !payload.contains("error");
        const bool currentSnapshot = pending.permissionSequence == m_permissionSequence &&
                                     !m_providerContextUnknown && m_providerSaveId.isEmpty();
        if (currentSnapshot) {
            m_permissionsKnown = success;
            if (success)
                m_state["permissions"] = payload.toVariantMap();
            if (success && command == "ai_usage:get" &&
                m_providerFeedback.value("status").toString() == "unknown" &&
                m_providerFeedback.value("text").toString().startsWith("原保存结果未知"))
                setProviderFeedback("unknown", "原保存结果未知；当前服务与授权状态已重新核对。",
                                    m_providerFeedback.value("currentDraft").toBool());
        }
        const auto key = command == "ai_usage:get" ? QString("refresh") : pending.feature;
        if (m_permissionFeedback.value(key).toMap().value("requestId").toString() == id) {
            const auto action = command.section(':', 1);
            const bool confirmed = success && (action != "get" || currentSnapshot);
            setPermissionFeedback(key, confirmed ? "success" :
                                  (action == "get" || success ? "unknown" : "error"),
                                  confirmed ? (action == "get" ? "授权状态已刷新。"
                                             : action == "grant" ? "当前服务的费用授权已确认。"
                                                                 : "费用授权已撤销。")
                                          : "授权状态尚未有效确认，请刷新状态后检查。",
                                  action, id);
        }
    }
    if (command == "persona:get" && !m_personaSwitch.isEmpty() &&
        m_personaSwitch.value("verifyId").toString() == id) {
        // An identity change would have reset the scope before this point.
        m_personaSwitch.clear();
        setPersonaFeedback("error", "切换没有生效，当前人格没有改变；可刷新列表后重试。", id);
    }
    if (command == "persona:get" && !m_personaImport.isEmpty() &&
        m_personaImport.value("verifyId").toString() == id) {
        // A changed identity settles above. An unchanged read cannot confirm
        // the new card's completed import, regardless of an earlier receipt.
        forgetPersonaCardImport("已收到导入回执，但当前运行身份未对应新角色卡；导入结果未完整确认，请核对列表。");
    }
    const bool clearProfileRequest = command == "user:profile:update" &&
                                     m_profileClearState.value("requestId").toString() == id;
    if (command == "archive:put" || command == "settings:update" ||
        (command == "user:profile:update" && !clearProfileRequest)) {
        setNotice(payload["ok"].toBool() ? "已保存" : "保存未获确认，请核对当前状态；编辑内容已保留。");
    }
    const auto receiptFor = [&](const QString &key) {
        return m_memoryFeedback.value(key).toMap().value("requestId").toString() == id;
    };
    // Only the shown list's own reads count; a superseded first page or a
    // load-more of an earlier list leaves both the list and its receipt alone.
    if (command == "memory:list" && !id.isEmpty() && (id == m_memoryListId || id == m_memoryMoreId)) {
        applyMemoryPage(id == m_memoryListId, type, payload, failedResult, id);
        const bool listSuccess = receiptFor("list") &&
            m_memoryFeedback.value("list").toMap().value("status").toString() == "success";
        candidateReadSettled(id, listSuccess);
        // Normal list reads keep their established acceptance rules. Unlocking
        // an unknown write additionally requires an explicit positive receipt.
        settleMemoryBatchDeleteRead(id, listSuccess && type == "memory:result" &&
            payload["ok"].isBool() && payload["ok"].toBool() && !payload.contains("error"));
        settleCandidateBatchRead(id, listSuccess && type == "memory:result" &&
            payload["ok"].isBool() && payload["ok"].toBool() && !payload.contains("error"));
    }
    if (command == "memory:candidates:list" && id == m_candidateReadId) {
        const bool applied = applyCandidatePage(type, payload, failedResult, id);
        candidateReadSettled(id, applied);
        settleCandidateBatchRead(id, applied);
    }
    if ((command == "memory:candidates:confirm" || command == "memory:candidates:reject") &&
        id == m_candidateDecision.value("requestId").toString() &&
        m_candidateDecision.value("generation").toInt() == m_generation &&
        m_candidateDecision.value("scopeKey").toString() == scopeKey() &&
        m_candidateDecision.value("status").toString() == "pending") {
        const bool ok = type == "memory:candidates:result" && payload["ok"].isBool() &&
                        payload["ok"].toBool() && !payload.contains("error");
        const auto verb = m_candidateDecision.value("verb").toString();
        const auto subjectId = m_candidateDecision.value("subjectId").toString();
        if (ok) {
            m_candidateDecision["status"] = "reading";
            m_candidateDecision["receiptConfirmed"] = true;
            // Keep the established action notification before the fresh reads.
            // Candidate controls have their own lock until both reads settle.
            setMemoryFeedback("action", "success", command.endsWith(":confirm")
                ? "已记住这条。" : "已放弃这条，不会记住。", id,
                {{"verb", verb}, {"subjectId", subjectId}});
            reconcileCandidateDecision(false);
        } else if (type == "memory:candidates:result" && payload["ok"].isBool() &&
                   !payload["ok"].toBool() &&
                   !QStringList{"", "internal_error"}.contains(payload["error_code"].toString(
                       payload["code"].toString()))) {
            m_candidateDecision.clear();
            setMemoryFeedback("action", "error", "候选决定被拒绝；当前批次已保留，可刷新后核对。", id,
                              {{"verb", verb}, {"subjectId", subjectId}});
        } else {
            unknownCandidateDecision("候选决定未获完整确认，结果未知；请手动刷新核对，未自动重试。");
        }
    }
    if (receiptFor("action") &&
        QStringList{"memory:edit", "memory:delete", "memory:reinforce"}.contains(command)) {
        const auto expectedType = QString("memory:result");
        bool ok = type == expectedType && !failedResult && !payload.contains("error");
        if (command == "memory:delete")
            ok = ok && payload["deleted"].toBool();
        const auto action = m_memoryFeedback.value("action").toMap();
        const auto verb = action.value("verb").toString();
        const auto adjustmentOp = action.value("adjustmentOp").toString();
        if (!adjustmentOp.isEmpty()) {
            const auto before = payload["importance_before"], after = payload["importance_after"];
            ok = ok && payload["ok"].isBool() && payload["ok"].toBool() &&
                !payload.contains("error_code") && !payload.contains("code") &&
                action.value("generation").toInt() == m_generation &&
                action.value("scopeKey").toString() == scopeKey() &&
                payload["memory_id"].isString() &&
                payload["memory_id"].toString() == action.value("subjectId").toString() &&
                payload["op"].isString() && payload["op"].toString() == adjustmentOp &&
                payload["changed"].isBool() && memoryImportance(before) && memoryImportance(after);
            const bool changed = payload["changed"].toBool();
            if (ok) {
                if (adjustmentOp == "reactivate")
                    ok = changed && after.toDouble() >= before.toDouble();
                else if (changed)
                    ok = adjustmentOp == "strengthen" ? after.toDouble() > before.toDouble()
                                                      : after.toDouble() < before.toDouble();
                else
                    ok = before == after && before.toDouble() == (adjustmentOp == "strengthen" ? 1 : 0);
            }
            QString text;
            if (ok && adjustmentOp == "reactivate")
                text = "已重温：按刚回想处理，重要度 " + memoryImportanceText(before.toDouble()) +
                    " → " + memoryImportanceText(after.toDouble()) + "。";
            else if (ok && !changed)
                text = adjustmentOp == "strengthen" ? "已是最高，未改动。" : "已是最低，未改动。";
            else if (ok)
                text = "已" + verb + "：重要度 " + memoryImportanceText(before.toDouble()) +
                    " → " + memoryImportanceText(after.toDouble()) + "。";
            else if (type == "memory:result" && payload["ok"].isBool() && !payload["ok"].toBool() &&
                     payload["error_code"].toString() == "memory_not_adjustable")
                text = "这条记忆当前不能调整，记忆没有改动；可刷新列表后核对。";
            else
                text = verb + "未完成，记忆没有改动；可刷新后核对。";
            QVariantMap extra{{"verb", verb}, {"subjectId", action.value("subjectId")},
                {"memoryId", action.value("subjectId")}, {"op", adjustmentOp},
                {"adjustmentOp", adjustmentOp}, {"generation", action.value("generation")},
                {"scopeKey", action.value("scopeKey")}};
            if (ok)
                extra.insert({{"changed", changed}, {"importanceBefore", before.toDouble()},
                              {"importanceAfter", after.toDouble()}});
            setMemoryFeedback("action", ok ? "success" : "error", text, id, extra);
            if (ok)
                readMemories(true);
        } else {
            static const QHash<QString, QString> done{{"修改记忆", "已保存修改。"},
                                                      {"删除记忆", "已删除这条记忆。"},
                                                      {"固定记忆", "已固定这条记忆。"},
                                                      {"取消固定", "已取消固定。"},
                                                      {"记住这条", "已记住这条。"},
                                                      {"不记这条", "已放弃这条，不会记住。"}};
            // The pin cap is the one backend refusal written for people.
            const auto error = payload["error"].toString();
            const auto text = ok ? done.value(verb, "操作已完成。")
                              : error.startsWith("最多固定") ? error + "，这条未固定。"
                                                              : verb + "未完成，记忆没有改动；可刷新后核对。";
            setMemoryFeedback("action", ok ? "success" : "error", text, id,
                              {{"verb", verb}, {"subjectId", action.value("subjectId")}});
            // Read both lists back so the page shows the committed state.
            if (ok)
                readMemories(true);
        }
    }
    if (command == "user:profile:update" && !clearProfileRequest && receiptFor("profile")) {
        const bool ok = type == "user:profile:result" && !payload.contains("error") &&
                        payload["profile"].isObject();
        setMemoryFeedback("profile", ok ? "success" : "error",
                          ok ? "资料已保存。" : "资料未能保存，原资料保留；编辑内容仍在。", id);
    }
    if (command == "summary:status" && !summaryStatusSuccess) {
        m_state["summary"] = summaryStatusSnapshot({{"ok", false}, {"status", "unavailable"}});
        emit changed();
    }
    // A saved switch value is shown until the runtime status is read again.
    if (command == "summary:status") {
        auto summary = m_memoryFeedback.value("summary").toMap();
        if (summary.value("status").toString() != "pending" && summary.remove("enabled"))
            m_memoryFeedback["summary"] = summary;
    }
    if (command == "settings:update" && receiptFor("summary")) {
        const bool ok = type == "settings:update:result" && !failedResult && !payload.contains("error");
        // Turning summaries off is saved before background cleanup; only the
        // cleanup acknowledgement can be missing.
        const bool cleanupUnconfirmed = payload["code"].toString() == "summary_cleanup_unconfirmed";
        const auto requested = m_memoryFeedback.value("summary").toMap().value("enabled");
        setMemoryFeedback("summary", ok ? "success" : cleanupUnconfirmed ? "unknown" : "error",
                          ok                   ? "摘要设置已保存。"
                          : cleanupUnconfirmed ? "摘要已关闭，但后台整理的清理尚未确认。"
                                               : "摘要设置未能保存，原设置保留。",
                          id, ok && requested.isValid() ? QVariantMap{{"enabled", requested}} : QVariantMap{});
        // Read the switch back from the runtime either way.
        request("summary:status");
    }
    if (command == "settings:update") {
        for (const auto &section : m_settingsFeedback.keys()) {
            const auto feedback = m_settingsFeedback.value(section).toMap();
            if (feedback.value("status").toString() != "pending" ||
                feedback.value("requestId").toString() != id || feedback.contains("readId"))
                continue;
            const bool budgetSave = touchesBudget(feedback.value("fields").toMap());
            const bool proactiveSave = section == "features";
            const bool ok = type == "settings:update:result" && !failedResult && !payload.contains("error") &&
                (!(budgetSave || proactiveSave) || (payload["ok"].isBool() && payload["ok"].toBool()));
            if (proactiveSave && !ok) {
                const auto reason = payload["error"].toString().simplified().left(240);
                setSettingsFeedback(section, "error", reason.isEmpty() ? "主动消息设置未能保存，原设置保留。"
                                    : "主动消息设置未能保存：" + reason,
                                    id, feedback.value("fields").toMap());
                continue;
            }
            // The pages show only what the runtime reports back. A confirmed save
            // stays pending until that read arrives, so its controls never fall
            // back to the snapshot taken before the save.
            const auto readId = request("settings:get");
            if (budgetSave)
                refreshBudget();
            if (ok && !readId.isEmpty()) {
                auto awaiting = feedback;
                awaiting["readId"] = readId;
                m_settingsFeedback[section] = awaiting;
                continue;
            }
            // The values are on disk; only their effect on the running session is unconfirmed.
            const bool unconfirmed = payload["code"].toString() == "settings_runtime_unconfirmed";
            const bool budgetUnconfirmed = budgetSave && (ok || unconfirmed);
            setSettingsFeedback(section, budgetUnconfirmed ? "unknown" : ok ? "success" : unconfirmed ? "unknown" : "error",
                                budgetUnconfirmed ? budgetUnconfirmedText
                                : ok          ? settingsSavedText(section, feedback.value("fields").toMap())
                                : unconfirmed ? "设置已写入，但运行中是否生效尚未确认；已重新读取当前设置。"
                                              : "设置未能保存，原设置保留。",
                                id, feedback.value("fields").toMap());
        }
    }
    if (command == "settings:get") {
        const bool valid = type == "settings:get:result" && validSettingsSnapshot(payload);
        const auto proactive = m_settingsFeedback.value("features").toMap();
        if (valid) {
            m_settingsFeedback.remove("read");
            const auto enabled = payload["features"].toObject().value("emotion_system_enabled");
            const bool wasDisabled = moodDisabled();
            m_moodEnabled = enabled.isBool() ? enabled : QJsonValue();
            if (moodDisabled()) {
                cancelMoodRead();
                m_moodDisplay.clear();
                m_lastMoodDisplay.clear();
            } else if (wasDisabled && enabled.toBool() && m_relationshipPageVisible) {
                request("emotion:get");
            }
        } else {
            setSettingsFeedback("read", "error", "当前设置读取失败，显示的是上次确认的值；暂不能修改。", id);
        }
        settleSettingsRead(id);
        if (valid && proactive.value("status") == QVariant(QString("pending")) &&
            proactive.value("readId").toString() == id &&
            proactive.value("fields").toMap().contains(ProactiveEnabled) &&
            proactiveSettingsMatch(m_state.value("settings").toMap(), proactive.value("fields").toMap()))
            refreshPermissions();
        if (valid)
            emit settingsRead();
    }
    const bool currentLegacyReceipt = receiptFor("legacy");
    if (command == "summary:legacy:preview" && currentLegacyReceipt) {
        static const QRegularExpression digest("^[a-f0-9]{64}$");
        const bool ok = type == "summary:result" && !failedResult &&
                        payload["operation"].toString() == "preview" &&
                        digest.match(payload["sha256"].toString()).hasMatch();
        if (ok) {
            m_legacySha = payload["sha256"].toString();
            m_state["importPreview"] = payload.toVariantMap();
            setMemoryFeedback("legacy", "preview",
                              QString("共 %1 条旧摘要；确认后加密隔离保存，全部保持未启用。")
                                  .arg(payload["total"].toInt()),
                              id);
        } else {
            m_legacyContent.clear();
            m_legacySha.clear();
            m_state.remove("importPreview");
            setMemoryFeedback("legacy", "error", "无法识别这个旧摘要文件，没有保存任何内容。", id);
        }
    }
    if (command == "summary:legacy:import" && currentLegacyReceipt) {
        const bool ok = type == "summary:result" && !failedResult &&
                        payload["operation"].toString() == "import";
        setNotice(ok ? "已加密隔离保存；全部旧摘要仍未启用。" : "导入未完成，请重新选择文件核对。");
        setMemoryFeedback("legacy", ok ? "success" : "error",
                          ok ? QString("已加密隔离保存 %1 条旧摘要，全部保持未启用。")
                                   .arg(payload["total"].toInt())
                             : "导入未获确认，请重新选择文件核对。",
                          id);
        m_legacyContent.clear();
        m_legacySha.clear();
        m_state.remove("importPreview");
        request("summary:status");
    }
    if (!command.isEmpty()) {
        emit responseReceived(id, command, payload.toVariantMap(), m_generation);
        emit commandResult(command, payload.toVariantMap());
    }
    emit changed();
}
void RuntimeBridge::openPanel(const QString &s) {
    if (!QStringList{"", "chat", "character", "memory", "activities", "gomoku", "chess", "go", "diary", "settings", "about",
                     "palette", "keepsake"}
             .contains(s))
        return;
    if (m_panel == "keepsake" && s != "keepsake") cancelKeepsakeRemoval();
    const bool leavingGame = m_panel == "activities" && s != "activities";
    const auto nextGame = gameIdForPanel(s);
    const bool changingGame = gomokuGame() != (s == "gomoku") ||
        chessGame() != (s == "chess") || goGame() != (s == "go");
    m_panel = s;
    if (changingGame) {
        clearGame();
    } else if (leavingGame && m_opponentPending) {
        cancelOpponent();
        emit gameChanged();
    }
    emit panelChanged();
    if (!m_connected)
        return;
    if (s == "memory") {
        request("archive:get");
        readMemories(false);
        request("summary:status");
        refreshPermissions();
    }
    if (!nextGame.isEmpty())
        gameRead();
    if (s == "diary")
        refreshDiary();
    if (s == "keepsake")
        refreshKeepsakes();
}
void RuntimeBridge::sendChat() {
    clearPersonaCardCandidate();
    const bool hasImage = !m_chatImagePreview.isEmpty();
    if ((!hasImage && m_draft.trimmed().isEmpty()) || m_busy)
        return;
    if (!m_connected) {
        setChatFeedback("disconnected", "本地服务尚未连接，输入已保留。");
        return;
    }
    if (!runtimeWritable()) {
        setChatFeedback("restoring", recoveryWarning() + "输入已保留。");
        return;
    }
    const auto gateStatus = m_networkFeedback.value("status").toString();
    if (!m_networkFeedback.value("known").toBool() || gateStatus == "pending") {
        setChatFeedback(gateStatus == "pending" ? "gate_pending" : "gate_unknown",
                        gateStatus == "pending" ? "正在确认网络调用状态，输入已保留。"
                                                : "网络调用状态未知，输入已保留。请先确认网络设置。");
        return;
    }
    if (m_offline) {
        setChatFeedback("paused", "模型网络调用已暂停，输入已保留。");
        return;
    }
    if (const auto gate = chatSendGate(); !gate.isEmpty()) {
        setChatFeedback(gate.value("status").toString(), gate.value("text").toString());
        // A failed or timed-out read is not repeated by itself; this send asks for one read.
        if (gate.value("status") == "provider_pending" && !providerControlPending())
            readProviderForPermissions(false);
        emit changed();
        return;
    }
    if (hasImage && !chatImageCanSend())
        return;
    const auto trimmed = m_draft.trimmed();
    const auto text = trimmed.isEmpty() && hasImage ? QString("[图片]") : trimmed;
    QVariantMap fields{{"text", text}, {"conversation_id", "dream-room"}};
    appendChatImageFields(fields);
    m_chatId = request("chat:send", fields);
    if (m_chatId.isEmpty())
        return;
    m_chatGeneration = m_generation;
    m_chatPersona = m_persona;
    m_busy = true;
    m_chatFeedback.remove("cancel");
    QVariantMap user{{"id", m_chatId}, {"role", "user"}, {"content", text}};
    if (hasImage) {
        m_chatImageInFlight = true;
        m_chatImageSentDraft = m_draft;
        user["pending_chat_image"] = m_chatId;
        m_chatImageThumbnails[m_chatId] = QVariantMap{{"status", "ready"}, {"source", m_chatImagePreview}};
        removeChatImage();
    }
    m_messages.append(user);
    if (!hasImage)
        setDraft("");
    setChatFeedback("queued", "正在倾听…");
    emit messagesChanged();
}
void RuntimeBridge::cancelChat() {
    if (m_busy && !m_chatId.isEmpty())
        request("chat:cancel", {{"request_id", m_chatId}});
}
// Named cloud services use their published endpoint; only these two take an address.
static bool providerTakesAddress(const QString &provider) { return provider == "ollama" || provider == "custom"; }
static QString withoutTrailingSlash(QString url) {
    url = url.trimmed();
    while (url.endsWith('/'))
        url.chop(1);
    return url;
}
static QString providerTestFailureText(const QString &code) {
    if (code == "PROVIDER_UNAUTHORIZED" || code == "PROVIDER_AUTH_FAILED")
        return "服务拒绝了密钥，请检查 API Key。";
    if (code == "PROVIDER_TIMEOUT" || code == "PROVIDER_UNREACHABLE" || code == "PROVIDER_CONNECTION_FAILED")
        return "无法连接到服务或连接超时；未自动重试。";
    if (code == "PROVIDER_RATE_LIMITED")
        return "服务暂时限流；未自动重试。";
    if (code == "REVERIE_CONTROL_REJECTED")
        return "配置未被接受：云端服务的地址由服务商固定，自定义服务须为 HTTPS 公网地址，本机服务须在本机。";
    return "连接测试失败，请检查当前地址和模型。";
}
void RuntimeBridge::testProvider(const QString &url, const QString &model) {
    testProviderConfig("ollama", url, model, {});
}
void RuntimeBridge::testProviderConfig(const QString &provider, const QString &url, const QString &model,
                                       const QString &apiKey) {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    settleDroppedProviderKeyRequests();
    if (!m_providerSaveId.isEmpty() || !m_keyClearId.isEmpty())
        return;
    static const QStringList providers{"ollama", "custom", "openai", "anthropic", "gemini",
                                       "grok", "deepseek", "kimi", "glm"};
    m_providerTest = {};
    m_providerTestKey.clear();
    m_providerTestReplacesKey = false;
    m_state["providerTestReady"] = false;
    const int generation = ++m_providerGeneration;
    if (!providers.contains(provider) || apiKey.size() > 16384 || apiKey.contains('\n') ||
        apiKey.contains('\r') || apiKey.contains(QChar(0))) {
        setProviderFeedback("error", "服务或密钥格式无效，没有发送。");
        emit changed();
        return;
    }
    const QJsonObject llm{{"provider", provider},
                          {"base_url", providerTakesAddress(provider) ? url.trimmed() : QString()},
                          {"model", model.trimmed()}};
    // Without a typed key, only the destination a saved key belongs to may use it.
    QString key = apiKey;
    const auto current = m_state["provider"].toMap();
    if (key.isEmpty() && m_keyStore && current.value("provider").toString() == provider &&
        (!providerTakesAddress(provider) ||
         withoutTrailingSlash(url) == withoutTrailingSlash(current.value("base_url").toString()))) {
        try {
            if (const auto saved = m_keyStore->read();
                saved && saved->binding == providerKeyBinding(provider, current.value("base_url").toString()))
                key = saved->apiKey;
        } catch (const std::exception &) {
            // An unreadable store tests without a key; the key state reports the failure.
        }
    }
    setProviderFeedback("testing", "正在测试当前回复服务…");
    const QJsonObject credential = key.isEmpty() ? QJsonObject{} : QJsonObject{{"apiKey", key}};
    key.fill(QChar(0));
    control("provider:test", {{"llm", llm}, {"credential", credential}},
            [this, llm, generation, apiKey](QJsonObject result) {
                if (generation != m_providerGeneration)
                    return;
                if (result["unknown"].toBool()) {
                    setProviderFeedback("unknown", "连接测试未收到确认，请核对服务后重新测试。");
                } else if (result["ok"].toBool() && result["success"].toBool(true)) {
                    m_providerTest = llm;
                    m_providerTestKey = apiKey;
                    m_providerTestReplacesKey = !apiKey.isEmpty();
                    m_state["providerTestReady"] = true;
                    setProviderFeedback("ready", "连接测试通过，可以保存。");
                } else {
                    m_state["providerTestReady"] = false;
                    if (m_previewMode) {
                        const QStringList providers{"openai", "anthropic", "gemini", "grok", "deepseek", "kimi", "glm", "ollama", "custom"};
                        emit previewEvent("service_failure", result["code"].toString(), providers.indexOf(llm["provider"].toString()) + 1);
                    }
                    setProviderFeedback("error", providerTestFailureText(result["code"].toString()));
                }
                emit changed();
            });
}
void RuntimeBridge::providerDraftChanged() {
    ++m_providerGeneration;
    m_providerTest = {};
    m_providerTestKey.fill(QChar(0));
    m_providerTestKey.clear();
    m_providerTestReplacesKey = false;
    m_state["providerTestReady"] = false;
    setProviderFeedback(m_providerSaveId.isEmpty() ? "stale" : "saving",
                        m_providerSaveId.isEmpty() ? "服务配置已编辑，请重新测试后保存。"
                                                  : "正在保存已测试配置；当前编辑尚未保存。",
                        false);
}
void RuntimeBridge::setOffline(bool active) {
    if (m_connected && !runtimeWritable()) {
        setNotice(recoveryWarning());
        return;
    }
    if (!m_connected) {
        m_networkFeedback = {{"status", "unknown"}, {"known", false}, {"active", m_offline},
                             {"desiredActive", active},
                             {"text", "本地服务尚未连接，网络设置尚未确认。"}};
        emit changed();
        return;
    }
    const int epoch = ++m_localModeEpoch;
    m_networkFeedback = {{"status", "pending"}, {"known", false}, {"active", m_offline},
                         {"desiredActive", active}, {"epoch", epoch},
                         {"text", active ? "正在确认暂停网络模型调用…" : "正在确认允许网络模型调用…"}};
    emit changed();
    m_networkRequestId = control(
        "local_mode:set", {{"active", active}, {"epoch", epoch}, {"sessionId", QString()}},
        [this, epoch, active](QJsonObject r) {
            if (epoch != m_localModeEpoch || r["requestId"].toString() != m_networkRequestId)
                return;
            const auto id = m_networkRequestId;
            const bool success = r["ok"].toBool();
            const bool validSnapshot = r["active"].isBool() && r["epoch"].isDouble() &&
                                       r["epoch"].toInt(-1) >= 0 &&
                                       (!success || (r["epoch"].toInt() == epoch &&
                                                     r["active"].toBool() == active));
            if (r["unknown"].toBool() || !validSnapshot) {
                m_networkFeedback = {{"status", "unknown"}, {"known", false},
                                     {"active", m_offline}, {"desiredActive", active},
                                     {"epoch", epoch}, {"requestId", id},
                                     {"text", "网络设置未收到有效确认；发送已暂停，请重新核对。"}};
            } else {
                m_offline = r["active"].toBool();
                m_localModeEpoch = qMax(m_localModeEpoch, r["epoch"].toInt());
                m_state["offline"] = m_offline;
                persistAppearance();
                m_networkFeedback = {{"status", success ? (m_offline ? "paused" : "allowed") : "error"},
                                     {"known", true}, {"active", m_offline}, {"desiredActive", active},
                                     {"epoch", r["epoch"].toInt()}, {"requestId", id},
                                     {"text", success ? (m_offline ? "已暂停所有模型网络调用。"
                                                      : "已允许配置的回复服务连接；费用许可仍独立生效。")
                                             : (m_offline ? "网络设置未能应用；当前仍为暂停调用。"
                                                          : "网络设置未能应用；当前仍为允许调用。")}};
            }
            m_networkRequestId.clear();
            setNotice(m_networkFeedback.value("text").toString());
        });
    m_networkFeedback["requestId"] = m_networkRequestId;
    if (m_networkRequestId.isEmpty()) {
        m_networkFeedback["status"] = "error";
        m_networkFeedback["known"] = false;
        m_networkFeedback["text"] = "网络设置请求未能发送；请核对连接状态。";
    }
    emit changed();
}
void RuntimeBridge::grantFeature(const QString &feature, const QString &digest, bool confirmed,
                                 int expectedEpoch) {
    if (!confirmed) {
        setPermissionFeedback(feature, "cancelled", "已取消授权，未更改许可。", "grant");
        return;
    }
    const auto features = m_state.value("permissions").toMap().value("features").toMap();
    const auto currentDigest = features.value(feature).toMap().value("consent_digest").toString();
    if (!m_permissionsKnown || (expectedEpoch >= 0 && expectedEpoch != m_permissionContextEpoch) ||
        digest.isEmpty() || currentDigest != digest) {
        setPermissionFeedback(feature, "stale", "授权说明已变化或尚未核对，请刷新后重新确认。", "grant");
        return;
    }
    request("ai_usage:grant", {{"feature", feature}, {"consent_digest", digest},
                               {"api_cost_acknowledged", true}, {"user_confirmed", true}});
}
void RuntimeBridge::reloadWorldbook() {
    m_state.remove("worldbookEdit");
    request("archive:get");
}
void RuntimeBridge::saveProvider() {
    if (!runtimeWritable()) {
        setNotice(recoveryWarning());
        return;
    }
    if (!m_providerSaveId.isEmpty())
        return;
    if (m_providerTest.isEmpty()) {
        setProviderFeedback("stale", "请先测试当前地址和模型。");
        return;
    }
    settleDroppedProviderKeyRequests();
    if (!m_keyClearId.isEmpty())
        return;
    if (m_providerTestReplacesKey && !m_keyStore) {
        setProviderFeedback("error", "本机安全存储不可用，密钥无法保存；没有改动配置。");
        return;
    }
    const auto tested = m_providerTest;
    const int generation = m_providerGeneration;
    // The typed key leaves memory once this save settles.
    auto typedKey = std::make_shared<QString>(m_providerTestReplacesKey ? m_providerTestKey : QString());
    const auto previous = QJsonObject::fromVariantMap(m_state["provider"].toMap());
    m_providerTest = {};
    m_providerTestKey.fill(QChar(0));
    m_providerTestKey.clear();
    m_providerTestReplacesKey = false;
    m_state["providerTestReady"] = false;
    invalidatePermissions();
    m_providerContextUnknown = true;
    const int epoch = m_permissionContextEpoch;
    m_providerSaveId = control("provider:configure", {{"llm", tested}},
                              [this, generation, epoch, typedKey, previous](QJsonObject r) {
        const auto wipe = qScopeGuard([typedKey] { typedKey->fill(QChar(0)); typedKey->clear(); });
        if (epoch != m_permissionContextEpoch)
            return;
        m_providerSaveId.clear();
        if (r["ok"].toBool() && !validProviderSnapshot(r["llm"])) {
            r["ok"] = false;
            r["unknown"] = true;
        }
        const bool currentDraft = generation == m_providerGeneration;
        if (r["unknown"].toBool()) {
            setProviderFeedback("unknown", "保存结果未知，请先核对当前服务；当前编辑已保留。", currentDraft);
        } else if (r["ok"].toBool() && validProviderSnapshot(r["llm"])) {
            const auto snapshot = r["llm"].toObject();
            m_state["provider"] = snapshot.toVariantMap();
            m_providerContextUnknown = false;
            m_providerConfirmedHandshake = m_handshakes;
            // A destination change clears the service's key; nothing counts as applied until resent.
            m_keyAppliedHandshake = -1;
            if (!typedKey->isEmpty()) {
                try {
                    m_keyStore->write({providerKeyBinding(snapshot["provider"].toString(),
                                                          snapshot["base_url"].toString()),
                                       *typedKey, QUuid::createUuid().toString(QUuid::WithoutBraces)});
                } catch (const std::exception &) {
                    // The form keeps its edits; the earlier configuration is restored.
                    rollBackProviderAfterKeyFailure(previous);
                    return;
                }
            }
            setProviderFeedback("saved",
                                currentDraft ? (typedKey->isEmpty() ? "回复服务已保存并应用。"
                                                                    : "回复服务已保存并应用；密钥已存入本机钥匙串。")
                                             : "已测试配置已保存；当前编辑尚未保存。",
                                currentDraft);
            // A newly saved key is the user's own; it ends the stop check before its state is published.
            if (!typedKey->isEmpty())
                m_keyClearState.clear();
            applyProviderKey(snapshot, "save");
            if (typedKey->isEmpty())
                observeProviderKeyClear(snapshot, false);
        } else {
            setProviderFeedback("error", "回复服务保存未获确认，请核对当前服务。", currentDraft);
        }
        emit commandResult("provider:configure", r.toVariantMap());
        emit changed();
        if (r["unknown"].toBool())
            readProviderForPermissions(true);
        else if (!m_providerContextUnknown)
            request("ai_usage:get");
    });
    if (!m_providerSaveId.isEmpty())
        setProviderFeedback("saving", "正在保存并应用已测试配置…");
}
void RuntimeBridge::setProviderKeyStore(std::unique_ptr<ProviderKeyStore> store) {
    m_keyStore = std::move(store);
    updateProviderKeyState();
}
void RuntimeBridge::settleDroppedProviderKeyRequests() {
    if (!m_keyApplyId.isEmpty() && !m_pending.contains(m_keyApplyId)) {
        // Its outcome is unknown, so the key counts as not sent and is sent again.
        m_keyApplyId.clear();
        m_keyAppliedHandshake = -1;
        m_keyReapply = false;
    }
    if (!m_keyClearId.isEmpty() && !m_pending.contains(m_keyClearId)) {
        m_keyClearId.clear();
        verifyProviderKeyCleared();
    }
}
bool RuntimeBridge::providerControlPending() const {
    for (const auto &p : m_pending)
        if (p.command == "provider:get" || p.command == "provider:configure")
            return true;
    return false;
}
// Only the reply service and its saved key; connection, recovery, network and
// persona gates are checked before this. No key, a key saved for another
// destination or an unreadable store does not hold a chat back.
QVariantMap RuntimeBridge::chatSendGate() const {
    const auto gate = [](const QString &status, const QString &text) {
        return QVariantMap{{"status", status}, {"text", text}};
    };
    if (!m_connected)
        return {};
    if (!m_providerSaveId.isEmpty())
        return gate("provider_saving", "回复服务正在保存，输入已保留。");
    if (!m_keyClearId.isEmpty() && m_pending.contains(m_keyClearId))
        return gate("key_clearing", "正在删除密钥，输入已保留。");
    // The service may still hold the deleted key; a dropped stop counts as unconfirmed.
    if (m_keyClearState == "held")
        return gate("key_clear_unconfirmed", "本地服务仍在使用已删除的密钥，输入已保留。请再次停用，或重新启动应用。");
    if (!m_keyClearState.isEmpty() || !m_keyClearId.isEmpty())
        return gate("key_clear_unconfirmed", "删除的密钥是否已从本地服务停用尚未确认，输入已保留。");
    // No model is chosen yet; only saving a service ends this, so a send does not read again.
    if (!providerControlPending() && !m_providerContextUnknown && m_providerConfirmedHandshake != m_handshakes &&
        m_providerUnconfiguredHandshake == m_handshakes)
        return gate("provider_unconfigured", "还没有配置回复服务，输入已保留。请先在设置里选择服务。");
    // A snapshot from an earlier connection does not count for this one.
    if (providerControlPending() || m_providerContextUnknown || m_providerConfirmedHandshake != m_handshakes)
        return gate("provider_pending", "正在确认回复服务，输入已保留。");
    const bool matches = m_keyStored && !m_keyBinding.isEmpty() && m_keyStoredBinding == m_keyBinding;
    const bool applied = m_keyAppliedHandshake == m_handshakes && m_keyAppliedBinding == m_keyBinding &&
                         m_keyAppliedWriteId == m_keyStoredWriteId;
    if (!matches || applied)
        return {};
    if (m_keyApplyId.isEmpty() && !m_keyReapply && m_keyApplyFailedHandshake == m_handshakes)
        return gate("key_unconfirmed",
                    "已保存的密钥未能确认交给本地服务，输入已保留。请重新测试并保存，或删除密钥。");
    return gate("key_pending", "正在把已保存的密钥交给本地服务，输入已保留。");
}
void RuntimeBridge::updateProviderKeyState() {
    settleDroppedProviderKeyRequests();
    m_keyStoreError.clear();
    m_keyStored = false;
    m_keyStoredBinding.clear();
    m_keyStoredWriteId.clear();
    if (m_keyStore) {
        try {
            if (auto saved = m_keyStore->read()) {
                m_keyStored = true;
                m_keyStoredBinding = saved->binding;
                m_keyStoredWriteId = saved->writeId;
                saved->apiKey.fill(QChar(0));
            }
        } catch (const std::exception &) {
            m_keyStoreError = "无法读取本机钥匙串中的密钥。";
        }
    }
    const bool matches = m_keyStored && !m_keyBinding.isEmpty() && m_keyStoredBinding == m_keyBinding;
    m_state["providerKey"] = QVariantMap{
        {"available", m_keyStore != nullptr && m_keyStoreError.isEmpty()},
        {"stored", m_keyStored},
        {"matches", matches},
        {"applied", matches && m_connected && m_keyAppliedHandshake == m_handshakes &&
                        m_keyAppliedBinding == m_keyBinding && m_keyAppliedWriteId == m_keyStoredWriteId},
        {"pending", !m_keyApplyId.isEmpty() || !m_keyClearId.isEmpty()},
        {"deliveryCount", m_keyDeliveryCount},
        {"clearState", m_keyClearState},
        {"reason", m_keyApplyReason},
        {"error", m_keyStoreError}};
    emit changed();
}
void RuntimeBridge::applyProviderKey(const QJsonObject &snapshot, const QString &reason) {
    m_keyBinding = providerKeyBinding(snapshot["provider"].toString(), snapshot["base_url"].toString());
    settleDroppedProviderKeyRequests();
    if (!m_keyStore || !m_connected) {
        updateProviderKeyState();
        return;
    }
    // One send at a time; a newer snapshot is applied when it settles.
    if (!m_keyApplyId.isEmpty()) {
        m_keyReapply = true;
        updateProviderKeyState();
        return;
    }
    std::optional<StoredProviderKey> saved;
    try {
        saved = m_keyStore->read();
    } catch (const std::exception &) {
        updateProviderKeyState();
        return;
    }
    // A key is sent only to the destination it was saved for.
    if (!saved || saved->binding != m_keyBinding) {
        if (saved)
            saved->apiKey.fill(QChar(0));
        updateProviderKeyState();
        return;
    }
    const int handshake = m_handshakes;
    const auto binding = saved->binding, writeId = saved->writeId;
    const QJsonObject credentials{{"llm", QJsonObject{{"apiKey", saved->apiKey}}}};
    saved->apiKey.fill(QChar(0));
    m_keyApplyId = control("credentials:set", {{"credentials", credentials}},
                           [this, handshake, binding, writeId, reason](QJsonObject r) {
        m_keyApplyId.clear();
        if (r["ok"].toBool() && r["applied"].toObject()["llm"].toBool()) {
            ++m_keyDeliveryCount;
            m_keyApplyFailedHandshake = -1;
            // A resend of the same key keeps the reason it was first sent for.
            if (m_keyAppliedHandshake != handshake || m_keyAppliedBinding != binding ||
                m_keyAppliedWriteId != writeId)
                m_keyApplyReason = reason;
            m_keyAppliedHandshake = handshake;
            m_keyAppliedBinding = binding;
            m_keyAppliedWriteId = writeId;
        } else if (handshake == m_handshakes) {
            m_keyAppliedHandshake = -1;
            m_keyApplyFailedHandshake = handshake;
            setProviderFeedback(r["unknown"].toBool() ? "unknown" : "error",
                                "已保存的密钥未能确认交给本地服务；重新连接后会再次尝试。", false);
        }
        if (m_keyReapply && m_connected) {
            m_keyReapply = false;
            applyProviderKey(QJsonObject::fromVariantMap(m_state["provider"].toMap()), reason);
            return;
        }
        m_keyReapply = false;
        updateProviderKeyState();
    });
    updateProviderKeyState();
}
void RuntimeBridge::rollBackProviderAfterKeyFailure(const QJsonObject &previous) {
    if (!validProviderSnapshot(previous)) {
        m_providerContextUnknown = true;
        setProviderFeedback("unknown", "密钥未能存入本机钥匙串，原服务配置无法恢复；请核对当前服务。", false);
        readProviderForPermissions(true);
        emit changed();
        return;
    }
    setProviderFeedback("saving", "密钥未能存入本机钥匙串，正在恢复原服务配置…", false);
    const int epoch = m_permissionContextEpoch;
    const QJsonObject llm{{"provider", previous["provider"]}, {"base_url", previous["base_url"]},
                          {"model", previous["model"]}};
    m_providerSaveId = control("provider:configure", {{"llm", llm}}, [this, epoch](QJsonObject r) {
        if (epoch != m_permissionContextEpoch)
            return;
        m_providerSaveId.clear();
        if (!r["unknown"].toBool() && r["ok"].toBool() && validProviderSnapshot(r["llm"])) {
            m_state["provider"] = r["llm"].toObject().toVariantMap();
            m_providerConfirmedHandshake = m_handshakes;
            m_keyAppliedHandshake = -1;
            setProviderFeedback("error", "密钥未能存入本机钥匙串；已恢复原服务配置，原有密钥未改动。", false);
            applyProviderKey(r["llm"].toObject(), "rollback");
            observeProviderKeyClear(r["llm"].toObject(), false);
            request("ai_usage:get");
        } else {
            m_providerContextUnknown = true;
            setProviderFeedback("unknown", "密钥未能存入本机钥匙串，恢复原服务配置也未确认；请核对当前服务。", false);
            readProviderForPermissions(true);
        }
        emit changed();
    });
    if (m_providerSaveId.isEmpty())
        setProviderFeedback("unknown", "密钥未能存入本机钥匙串，恢复原服务配置未能发送；请核对当前服务。", false);
}
void RuntimeBridge::clearProviderKey() {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    settleDroppedProviderKeyRequests();
    if (!m_keyStore || !m_providerSaveId.isEmpty() || !m_keyClearId.isEmpty())
        return;
    try {
        m_keyStore->clear();
    } catch (const std::exception &) {
        // A reported failure is read back: a record already gone continues as deleted.
        bool readable = true, remains = false;
        try {
            if (auto saved = m_keyStore->read()) {
                remains = true;
                saved->apiKey.fill(QChar(0));
            }
        } catch (const std::exception &) {
            readable = false;
        }
        if (!readable || remains) {
            setProviderFeedback("error", readable ? QString("无法从本机钥匙串删除密钥，没有任何改动。")
                                                  : QString("钥匙串删除失败且无法读回，本地服务仍在使用原密钥；请稍后重试。"),
                                false);
            updateProviderKeyState();
            return;
        }
    }
    // The store is cleared first: whatever the service answers, the key is never sent again.
    m_keyAppliedHandshake = -1;
    // A test passed, or still running, before the delete cannot be saved after it.
    const QString voided = !m_providerTest.isEmpty() || m_providerFeedback.value("status") == "testing"
                               ? QString("之前的连接测试已作废，请重新测试后保存。")
                               : QString();
    ++m_providerGeneration;
    m_providerTest = {};
    m_providerTestKey.fill(QChar(0));
    m_providerTestKey.clear();
    m_providerTestReplacesKey = false;
    m_state["providerTestReady"] = false;
    if (!voided.isEmpty())
        setProviderFeedback("stale", voided, false);
    sendProviderKeyClear(voided);
}
void RuntimeBridge::retryProviderKeyClear() {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    settleDroppedProviderKeyRequests();
    if (m_keyClearState != "held" && m_keyClearState != "unconfirmed")
        return;
    if (!m_providerSaveId.isEmpty() || !m_keyClearId.isEmpty() || !m_keyApplyId.isEmpty())
        return;
    sendProviderKeyClear({});
}
void RuntimeBridge::sendProviderKeyClear(const QString &voided) {
    m_keyClearVoided = voided;
    const int handshake = m_handshakes;
    m_keyClearId = control("credentials:set", {{"credentials", QJsonObject{{"llm", QJsonValue::Null}}}},
                           [this, voided, handshake](QJsonObject r) {
        m_keyClearId.clear();
        if (r["ok"].toBool() && r["applied"].toObject()["llm"].toBool()) {
            m_keyClearState.clear();
            setProviderFeedback("saved", voided.isEmpty() ? QString("已删除保存的密钥，本地服务也已停用它。")
                                                          : "已删除保存的密钥，本地服务也已停用它；" + voided,
                                false);
        } else if (handshake == m_handshakes) {
            // A late acknowledgement is ignored; only a read of the service settles this.
            verifyProviderKeyCleared();
        }
        updateProviderKeyState();
    });
    updateProviderKeyState();
}
void RuntimeBridge::verifyProviderKeyCleared() {
    if (!m_connected) {
        // The service's in-memory key ends with its process.
        m_keyClearState = "unconfirmed";
        setProviderFeedback("unknown", "钥匙串里的密钥已删除；本地服务是否已停用未确认，重新连接后不会再使用它。" +
                                           m_keyClearVoided, false);
        updateProviderKeyState();
        return;
    }
    m_keyClearState = "verifying";
    setProviderFeedback("unknown", "钥匙串里的密钥已删除；本地服务是否已停用未确认，正在核对…" + m_keyClearVoided, false);
    // Every caller sees the new state, including those that publish nothing afterwards.
    const auto publish = qScopeGuard([this] { updateProviderKeyState(); });
    if (!m_keyClearVerifyId.isEmpty() && m_pending.contains(m_keyClearVerifyId))
        return;
    const int handshake = m_handshakes;
    m_keyClearVerifyId = control("provider:get", {}, [this, handshake](QJsonObject r) {
        m_keyClearVerifyId.clear();
        if (handshake != m_handshakes || m_keyClearState.isEmpty())
            return;
        if (r["ok"].toBool() && validProviderSnapshot(r["llm"]))
            observeProviderKeyClear(r["llm"].toObject(), true);
        else {
            m_keyClearState = "unconfirmed";
            setProviderFeedback("unknown", "钥匙串里的密钥已删除；本地服务是否已停用无法核对。可再次停用，或重新启动应用。" +
                                               m_keyClearVoided, false);
        }
        updateProviderKeyState();
    });
}
void RuntimeBridge::observeProviderKeyClear(const QJsonObject &snapshot, bool verifying) {
    if (m_keyClearState.isEmpty())
        return;
    const auto held = snapshot["has_api_key"];
    if (!held.isBool()) {
        if (verifying) {
            m_keyClearState = "unconfirmed";
            setProviderFeedback("unknown", "钥匙串里的密钥已删除；本地服务是否已停用无法核对。可再次停用，或重新启动应用。" +
                                               m_keyClearVoided, false);
        }
        return;
    }
    if (!held.toBool()) {
        m_keyClearState.clear();
        setProviderFeedback("saved", "已删除保存的密钥；已核对本地服务不再使用它。" + m_keyClearVoided, false);
    } else {
        // Nothing is stored, so the key the service holds is the deleted one.
        m_keyClearState = "held";
        setProviderFeedback("error", "钥匙串里的密钥已删除，但本地服务仍在使用它。可再次停用，或重新启动应用。", false);
    }
    updateProviderKeyState();
}
void RuntimeBridge::saveWorldbook(const QString &title, const QString &keys, const QString &body,
                                  bool enabled) {
    auto edited = m_state["worldbookEdit"].toMap();
    if (edited.isEmpty()) {
        setNotice("请先读取当前人格的档案。");
        return;
    }
    auto archive = edited["archive"].toMap();
    auto books = archive["worldBooks"].toList();
    QVariantMap book;
    if (!books.isEmpty())
        book = books.first().toMap();
    if (book.isEmpty())
        book = {{"id", uid()},
                {"name", title},
                {"scanDepth", 20},
                {"tokenBudget", 500},
                {"recursiveScanning", true}};
    auto entries = book["entries"].toList();
    auto entry = entries.isEmpty() ? QVariantMap{{"id", uid()}} : entries.first().toMap();
    entry["comment"] = title;
    entry["content"] = body;
    entry["keywords"] = keys.split(',', Qt::SkipEmptyParts);
    entry["enabled"] = enabled;
    entry["alwaysActive"] = keys.trimmed().isEmpty();
    book["name"] = title;
    if (entries.isEmpty())
        entries.append(entry);
    else
        entries[0] = entry;
    book["entries"] = entries;
    if (books.isEmpty())
        books.append(book);
    else
        books[0] = book;
    archive["worldBooks"] = books;
    if (!archive.contains("characters"))
        archive["characters"] = QVariantList{};
    if (!archive.contains("activeCharacterIds"))
        archive["activeCharacterIds"] = QVariantList{};
    request("archive:put",
            {{"archive", archive}, {"expected_revision", edited["revision"].toInt()}});
}
void RuntimeBridge::saveProfile(const QVariantMap &fields) {
    if (!m_connected) {
        setMemoryFeedback("profile", "error", "本地服务尚未连接，资料没有保存。");
        return;
    }
    if (profileUpdatePending() || profileClearBlocksWrite())
        return;
    QString error;
    const auto body = profileUpdate(fields, &error);
    if (body.isEmpty()) {
        setMemoryFeedback("profile", "error", error);
        return;
    }
    const auto id = request("user:profile:update", body);
    if (!id.isEmpty())
        setMemoryFeedback("profile", "pending", "正在保存你的资料…", id);
}
bool RuntimeBridge::profileSnapshotKnown() const {
    return m_connected && m_profileSnapshotGeneration == m_generation &&
           m_profileSnapshotScope == scopeKey() &&
           validProfileSnapshot(obj(m_state.value("profile").toMap()));
}
bool RuntimeBridge::profileUpdatePending() const {
    for (const auto &pending : m_pending)
        if (pending.generation == m_generation && pending.command == "user:profile:update")
            return true;
    return false;
}
bool RuntimeBridge::profileClearBlocksWrite() const {
    return QStringList{"pending", "unknown"}.contains(m_profileClearState.value("status").toString()) ||
           m_profileClearState.value("manualRefreshing").toBool();
}
void RuntimeBridge::setProfileClearState(const QString &status, const QString &text) {
    m_profileClearState["status"] = status;
    m_profileClearState["text"] = text;
    emit changed();
}
void RuntimeBridge::proposeProfileClear(bool draftDirty) {
    if (profileClearBlocksWrite() || profileUpdatePending())
        return;
    m_profileClearState.clear();
    m_profileClearProfile = {};
    m_profileClearReceipt = {};
    if (draftDirty) {
        setProfileClearState("error", "请先保存资料编辑，再选择要清空的字段；当前编辑已保留。");
        return;
    }
    if (!runtimeWritable() || personaChanging() || !profileSnapshotKnown()) {
        setProfileClearState("stale", "当前资料尚未核对，请连接本地服务并刷新资料后重新选择。");
        return;
    }
    const auto saved = m_state.value("profile").toMap();
    m_profileClearProfile = obj(saved.value("profile").toMap());
    QStringList available;
    for (const auto &field : profileBasicFields)
        if (!profileFieldEmpty(m_profileClearProfile, field))
            available << field;
    m_profileClearState = {{"scopeKey", scopeKey()},
        {"profileSnapshot", saved.value("profile_snapshot")}, {"availableFields", available},
        {"selectedFields", QStringList{}}, {"reconcileAttempted", false}};
    setProfileClearState("confirmation", "请选择要清空的已保存字段，再确认清空。");
}
void RuntimeBridge::confirmProfileClear(const QStringList &fields, const QString &expectedScope,
                                        const QString &expectedSnapshot, bool draftDirty) {
    if (profileClearBlocksWrite() || profileUpdatePending())
        return;
    if (m_profileClearState.value("status").toString() != "confirmation")
        return;
    if (draftDirty) {
        setProfileClearState("stale", "资料已有未保存编辑，请先保存后重新选择；当前编辑已保留。");
        return;
    }
    if (!runtimeWritable() || personaChanging() || !profileSnapshotKnown() ||
        expectedScope != scopeKey() || expectedScope != m_profileClearState.value("scopeKey").toString() ||
        expectedSnapshot != m_state.value("profile").toMap().value("profile_snapshot").toString() ||
        expectedSnapshot != m_profileClearState.value("profileSnapshot").toString()) {
        setProfileClearState("stale", "当前人格或资料已变化，请刷新后重新选择清空字段。");
        return;
    }
    QSet<QString> selected;
    const auto available = m_profileClearState.value("availableFields").toStringList();
    for (const auto &field : fields) {
        if (!profileBasicFields.contains(field) || !available.contains(field) || selected.contains(field)) {
            setProfileClearState("error", "请选择不重复且已有内容的资料字段，再重新打开确认。");
            return;
        }
        selected.insert(field);
    }
    if (fields.isEmpty()) {
        setProfileClearState("error", "请至少选择一个已有内容的资料字段，再重新打开确认。");
        return;
    }
    // Keep the exact field names, snapshot and scope that were confirmed. The
    // generic command entry cannot create an explicit clear on its own.
    m_profileClearState["selectedFields"] = fields;
    m_profileClearSending = true;
    const auto restoreSending = qScopeGuard([this] { m_profileClearSending = false; });
    const auto id = request("user:profile:update", {{"clear_fields", fields},
                                                   {"expected_profile_snapshot", expectedSnapshot}});
    m_profileClearState["requestId"] = id;
    if (id.isEmpty()) {
        unknownProfileClear("清空请求未获有效发送确认，结果未知；正在只读核对当前资料，未自动重试。");
        return;
    }
    setProfileClearState("pending", "正在清空所选资料字段…");
}
void RuntimeBridge::cancelProfileClear() {
    if (m_profileClearState.value("status").toString() != "confirmation")
        return;
    m_profileClearState.clear();
    m_profileClearProfile = {};
    m_profileClearReceipt = {};
    setProfileClearState("cancelled", "已取消清空；当前编辑已保留。");
}
void RuntimeBridge::reconcileProfileClear() {
    if (!m_connected || m_profileClearState.value("reconcileAttempted").toBool() ||
        m_profileClearState.value("scopeKey").toString() != scopeKey())
        return;
    // Set this before dispatch so repeated failures cannot schedule another read.
    m_profileClearState["reconcileAttempted"] = true;
    m_profileClearState["readId"] = request("user:profile:get");
    emit changed();
}
void RuntimeBridge::unknownProfileClear(const QString &text) {
    m_profileSnapshotGeneration = -1;
    setProfileClearState("unknown", text);
    reconcileProfileClear();
}
void RuntimeBridge::refreshProfile() {
    if (m_profileClearState.value("status").toString() == "pending" ||
        m_profileClearState.value("manualRefreshing").toBool() || profileUpdatePending())
        return;
    if (!m_connected) {
        m_profileSnapshotGeneration = -1;
        setProfileClearState(m_profileClearState.value("status").toString() == "unknown" ? "unknown" : "error",
                             "本地服务尚未连接，当前资料无法刷新；编辑内容已保留。");
        return;
    }
    m_profileClearState["manualRefreshing"] = true;
    m_profileClearState["scopeKey"] = scopeKey();
    m_profileClearState["readId"] = request("user:profile:get");
    m_profileSnapshotGeneration = -1;
    if (m_profileClearState.value("readId").toString().isEmpty()) {
        m_profileClearState["manualRefreshing"] = false;
        setProfileClearState(m_profileClearState.value("requestId").toString().isEmpty() ? "error" : "unknown",
                             "当前资料刷新未获确认，请核对连接后重试；编辑内容已保留。");
        return;
    }
    setProfileClearState(m_profileClearState.value("status").toString() == "unknown" ? "unknown" : "refreshing",
                         "正在只读刷新当前资料…");
}
void RuntimeBridge::observeProfileResult(const QString &command, const QString &type,
                                         const QJsonObject &payload, const QString &id) {
    const bool result = type == "user:profile:result";
    const bool valid = result && validProfileSnapshot(payload);
    const bool clearing = command == "user:profile:update" &&
                          m_profileClearState.value("requestId").toString() == id;
    if (clearing) {
        const auto code = payload["error_code"].toString(payload["code"].toString());
        const bool knownReject = result && payload["operation"].toString() == "clear" &&
            payload["ok"].isBool() && !payload["ok"].toBool() &&
            QStringList{"PROFILE_SNAPSHOT_CHANGED", "PROFILE_CLEAR_INVALID", "PROFILE_CLEAR_UNAVAILABLE"}.contains(code);
        if (knownReject) {
            m_profileSnapshotGeneration = -1;
            m_profileClearState["knownRejection"] = true;
            m_profileClearState["errorCode"] = code;
            setProfileClearState("error", code == "PROFILE_SNAPSHOT_CHANGED"
                ? "资料已在别处变化，本次没有清空；正在读取当前资料，请重新选择。"
                : code == "PROFILE_CLEAR_UNAVAILABLE"
                    ? "当前服务无法清空资料，本次没有清空；正在只读刷新当前资料。"
                    : "清空请求被拒绝，本次没有清空；请刷新资料后重新选择。");
            // Failure payloads contain only basic fields. A get preserves the
            // saved profile's remaining metadata and emotional-memory display.
            m_profileClearState["readId"] = request("user:profile:get");
            return;
        }
        const auto fields = m_profileClearState.value("selectedFields").toStringList();
        QStringList acknowledged;
        bool matching = valid && payload["ok"].isBool() && payload["ok"].toBool() &&
                        payload["operation"].toString() == "clear" && payload["cleared_fields"].isArray();
        for (const auto &value : payload["cleared_fields"].toArray()) {
            const auto field = value.toString();
            matching = matching && value.isString() && !acknowledged.contains(field);
            acknowledged << field;
        }
        auto expected = fields;
        std::sort(expected.begin(), expected.end());
        std::sort(acknowledged.begin(), acknowledged.end());
        matching = matching && expected == acknowledged &&
                   payload["profile_snapshot"].toString() != m_profileClearState.value("profileSnapshot").toString();
        const auto current = payload["profile"].toObject();
        for (const auto &field : profileBasicFields)
            matching = matching && (fields.contains(field) ? profileFieldEmpty(current, field)
                                                           : current[field] == m_profileClearProfile[field]);
        if (!matching) {
            unknownProfileClear("清空未获完整确认，结果未知；正在只读核对当前资料，未自动重试。");
            return;
        }
        m_profileClearReceipt = payload;
        m_profileClearState["receiptConfirmed"] = true;
        m_profileClearState["reconcileAttempted"] = true;
        m_profileClearState["readId"] = request("user:profile:get");
        if (m_profileClearState.value("readId").toString().isEmpty())
            unknownProfileClear("已收到清空回执，但当前资料读取未获确认；结果仍未知，请手动刷新核对。");
        else
            setProfileClearState("pending", "已收到清空回执，正在核对当前资料…");
        return;
    }
    if (command == "user:profile:get" && id != m_profileReadId)
        return;
    // Keep the ordinary save's established display/receipt behavior; only a
    // complete snapshot token may authorize a future explicit clear.
    const bool ordinarySnapshot = command == "user:profile:update" && result;
    if (valid || ordinarySnapshot || (result && command == "user:profile:get" &&
                                    payload["profile"].isObject() && !payload.contains("error") &&
                                    (!payload.contains("ok") || payload["ok"].toBool())))
        m_state["profile"] = payload.toVariantMap();
    m_profileSnapshotGeneration = valid ? m_generation : -1;
    if (valid)
        m_profileSnapshotScope = scopeKey();
    const bool matchingRead = command == "user:profile:get" &&
                              m_profileClearState.value("readId").toString() == id;
    if (matchingRead) {
        const bool manual = m_profileClearState.value("manualRefreshing").toBool();
        m_profileClearState["manualRefreshing"] = false;
        if (valid) {
            m_profileClearState["currentProfileSnapshot"] = payload["profile_snapshot"].toString();
            m_profileClearState["currentProfileReadId"] = id;
        }
        const auto status = m_profileClearState.value("status").toString();
        if (manual && valid) {
            setProfileClearState("refreshed", status == "unknown"
                ? "当前资料已刷新；先前清空结果仍未知，请按当前内容重新选择。"
                : "当前资料已刷新；未保存的编辑仍保留。");
        } else if (status == "pending" && m_profileClearState.value("receiptConfirmed").toBool()) {
            bool matchesReceipt = valid && payload["profile_snapshot"] == m_profileClearReceipt["profile_snapshot"];
            for (const auto &field : profileBasicFields)
                matchesReceipt = matchesReceipt && payload["profile"].toObject()[field] ==
                                                   m_profileClearReceipt["profile"].toObject()[field];
            if (matchesReceipt)
                setProfileClearState("success", "已清空：" +
                    profileFieldNames(m_profileClearState.value("selectedFields").toStringList()) + "；当前资料已核对。");
            else
                unknownProfileClear("已收到清空回执，但当前资料未与回执完整对应；结果仍未知，请手动刷新核对。");
        } else if (status == "unknown") {
            setProfileClearState("unknown", valid
                ? "清空结果仍未知；已只读核对当前资料，未自动重试。请刷新资料后按当前内容重新选择。"
                : "清空结果仍未知，当前资料也未有效读取；请手动刷新核对，未自动重试。");
        } else if (status == "error" && m_profileClearState.value("knownRejection").toBool()) {
            setProfileClearState("error", valid
                ? "本次清空未执行；已读取当前资料，请重新选择要清空的字段。"
                : "本次清空未执行；当前资料读取也未获确认，请刷新后重新选择。");
        } else if (manual) {
            setProfileClearState("error", "当前资料未有效读取，请核对连接后刷新；编辑内容已保留。");
        }
    }
    if (m_profileClearState.value("status").toString() == "confirmation" &&
        (!valid || payload["profile_snapshot"].toString() != m_profileClearState.value("profileSnapshot").toString()))
        setProfileClearState("stale", "当前资料已变化或读取未获确认，请刷新后重新选择清空字段。");
    emit changed();
}
QString RuntimeBridge::stageBackupFile(const QString &source, const QString &stagingDir,
                                       QString *error) {
    constexpr qint64 limit = 1024LL * 1024 * 1024;
    const QFileInfo info(source);
    if (!info.isAbsolute() || info.suffix().toLower() != "json") {
        *error = "请选择以 .json 结尾的备份文件。";
        return {};
    }
    const auto native = QFile::encodeName(info.absoluteFilePath());
    struct stat before {};
    if (::lstat(native.constData(), &before) != 0 || !S_ISREG(before.st_mode)) {
        *error = "备份必须是普通文件，不能是文件夹、替身或链接。";
        return {};
    }
    if (before.st_size < 1 || before.st_size > limit) {
        *error = "备份文件为空或超过 1 GB。";
        return {};
    }
    // Only the chosen file itself may not be a link (lstat above, O_NOFOLLOW
    // below). Linked ancestors such as macOS /var and /tmp are ordinary.
    const auto same = [](const struct stat &a, const struct stat &b) {
        return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
               a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
               a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec;
    };
    const int in = ::open(native.constData(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    struct stat opened {};
    if (in < 0 || ::fstat(in, &opened) != 0 || !same(before, opened)) {
        if (in >= 0)
            ::close(in);
        *error = "备份文件无法读取，或在选择后发生了变化。";
        return {};
    }
    struct stat directory {};
    if (!QDir().mkpath(stagingDir) || ::lstat(QFile::encodeName(stagingDir).constData(), &directory) ||
        !S_ISDIR(directory.st_mode) || directory.st_uid != getuid() ||
        ::chmod(QFile::encodeName(stagingDir).constData(), 0700)) {
        ::close(in);
        *error = "备份暂存目录不可用，没有改动数据。";
        return {};
    }
    const auto target = stagingDir + "/.reverie-import-" +
                        QUuid::createUuid().toString(QUuid::WithoutBraces) + ".json";
    const auto targetNative = QFile::encodeName(target);
    const int out = ::open(targetNative.constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    bool copied = out >= 0;
    qint64 total = 0;
    QByteArray buffer(1024 * 1024, Qt::Uninitialized);
    while (copied) {
        const auto count = ::read(in, buffer.data(), buffer.size());
        if (count == 0)
            break;
        if (count < 0) {
            copied = false;
            break;
        }
        for (qint64 written = 0; copied && written < count;) {
            const auto step = ::write(out, buffer.constData() + written, count - written);
            copied = step > 0;
            written += step > 0 ? step : 0;
        }
        total += count;
        if (total > limit) copied = false;
    }
    copied = copied && ::fsync(out) == 0;
    if (out >= 0)
        ::close(out);
    ::close(in);
    struct stat after {};
    if (!copied || total != before.st_size || ::lstat(native.constData(), &after) != 0 ||
        !same(before, after)) {
        ::unlink(targetNative.constData());
        *error = "备份文件在暂存时发生变化或无法完整复制，没有改动数据。";
        return {};
    }
    return target;
}
void RuntimeBridge::discardStagedBackup() {
    if (!m_backupStaged.isEmpty())
        QFile::remove(m_backupStaged);
    m_backupStaged.clear();
    m_backupSource.clear();
    m_backupInspection.clear();
    m_backupSourceBinding.clear();
    m_state.remove("backupRestore");
}
QUrl RuntimeBridge::suggestedBackupFile() const {
    const auto folder = QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation);
    return QUrl::fromLocalFile(folder + (runtimeWritable() ? "/reverie-backup-" : "/reverie-unconfirmed-") +
                               QDate::currentDate().toString("yyyyMMdd") + ".json");
}
void RuntimeBridge::exportBackup(const QUrl &target) {
    if (!m_connected) {
        setMemoryFeedback("backup", "error", "本地服务尚未连接，没有导出备份。");
        return;
    }
    if (m_backupRestoring || memoryRequestPending("backup"))
        return;
    const auto path = target.toLocalFile();
    const QFileInfo info(path);
    if (!target.isLocalFile() || !info.isAbsolute() || info.suffix().toLower() != "json" ||
        !QFileInfo(info.absolutePath()).isDir()) {
        setMemoryFeedback("backup", "error", "请选择一个以 .json 结尾的保存位置。");
        return;
    }
    const auto id = control(
        "backup:file:export", {{"path", info.absoluteFilePath()}},
        [this, path = info.absoluteFilePath(), retained = !runtimeWritable()](QJsonObject r) {
            const QFileInfo written(path);
            if (r["unknown"].toBool())
                setMemoryFeedback("backup", "unknown", "导出结果未知，请检查目标文件。");
            else if (r["ok"].toBool() && r["operation"] == "export" && written.isFile() && written.size() > 0) {
                if (r["export_consistency"].toString() == "unconfirmed")
                    setMemoryFeedback("backup", "success", "已留存（状态未确认，不能用于恢复）。文件：" + written.fileName() + "。备份是明文，请妥善保管。");
                else if (r["export_consistency"].toString() == "confirmed" && !retained)
                    setMemoryFeedback("backup", "success", "已导出到 " + written.fileName() + "。备份是明文，请妥善保管。");
                else
                    setMemoryFeedback("backup", "unknown", "导出文件的状态尚未有效确认，不能作为恢复备份；请检查目标文件。");
            }
            else
                setMemoryFeedback("backup", "error", "导出未完成，没有写出备份文件。");
        },
        15 * 60 * 1000);
    if (!id.isEmpty())
        setMemoryFeedback("backup", "pending", "正在导出备份…", id);
}
QString RuntimeBridge::recoveryWarning() const {
    if (m_backupRestoring || m_recoveryState == "recovering")
        return QStringLiteral("正在恢复备份，写入暂停；等待服务确认结果，未自动重试。");
    if (m_recoveryState == "recovery_required")
        return QStringLiteral("恢复结果未确认，写入已锁定。当前状态可能不一致，仅供留存。请用已知完好的备份恢复解困。");
    if (!runtimeWritable())
        return QStringLiteral("本地数据的可写状态尚未确认，写入暂停；草稿已保留。");
    return {};
}
bool RuntimeBridge::applyRecoverySnapshot(const QJsonObject &snapshot, bool ready, bool allowUnlock) {
    const auto state = snapshot[ready ? "recoveryState" : "recovery_state"];
    const auto blocked = snapshot[ready ? "writesBlocked" : "writes_blocked"];
    const auto writable = snapshot[ready ? "runtimeWritable" : "runtime_writable"];
    const bool valid = state.isString() &&
        QStringList{"clean", "recovering", "recovery_required"}.contains(state.toString()) &&
        blocked.isBool() && writable.isBool() &&
        writable.toBool() == (state.toString() == "clean" && !blocked.toBool());
    if (ready)
        m_recoveryLocked = valid && state.toString() == "recovery_required";
    else if (!valid || state.toString() == "recovery_required")
        m_recoveryLocked = true;
    if (valid && writable.toBool() && (ready || allowUnlock))
        m_recoveryLocked = false;
    m_recoveryState = valid ? (m_recoveryLocked && writable.toBool() ? QString("recovery_required") : state.toString()) : QString("unknown");
    m_runtimeWritable = valid && writable.toBool() && !m_recoveryLocked;
    m_state["recovery"] = QVariantMap{{"state", m_recoveryState}, {"writesBlocked", !m_runtimeWritable}};
    emit changed();
    emit gameChanged();
    return valid;
}
void RuntimeBridge::rejectBackupRestore() {
    const auto reason = QStringLiteral("整包导入请求不可用。请选择备份文件，检查后明确确认恢复。");
    setNotice(reason);
    if (!memoryRequestPending("backup"))
        setMemoryFeedback("backup", "error", reason);
}
QVariantMap RuntimeBridge::backupFileBinding(const QString &path, QString *error) {
    constexpr qint64 limit = 1024LL * 1024 * 1024;
    const QFileInfo info(path);
    const auto native = QFile::encodeName(path);
    struct stat before{}, opened{}, after{};
    if (!info.isAbsolute() || info.suffix().toLower() != "json" ||
        ::lstat(native.constData(), &before) || !S_ISREG(before.st_mode) ||
        before.st_size < 1 || before.st_size > limit) {
        *error = "请选择普通的 .json 备份文件，大小须在 1 GB 内，不能是链接。";
        return {};
    }
    const int fd = ::open(native.constData(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    const auto same = [](const struct stat &a, const struct stat &b) {
        return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
            a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec && a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec;
    };
    bool valid = fd >= 0 && ::fstat(fd, &opened) == 0 && same(before, opened);
    QCryptographicHash hash(QCryptographicHash::Sha256);
    QByteArray bytes(1024 * 1024, Qt::Uninitialized);
    qint64 total = 0;
    while (valid) {
        const auto count = ::read(fd, bytes.data(), bytes.size());
        if (!count) break;
        if (count < 0 || total + count > limit) { valid = false; break; }
        hash.addData(QByteArrayView(bytes.constData(), count));
        total += count;
    }
    if (fd >= 0) ::close(fd);
    valid = valid && total == before.st_size && ::lstat(native.constData(), &after) == 0 && same(before, after);
    if (!valid) { *error = "备份文件在读取时发生变化或未能完整读取，未改动数据。"; return {}; }
    return {{"sha256", QString::fromLatin1(hash.result().toHex())}, {"file_bytes", total},
        {"device", QString::number(before.st_dev)}, {"inode", QString::number(before.st_ino)},
        {"mtime", QString::number(before.st_mtimespec.tv_sec)}, {"mtimeNs", QString::number(before.st_mtimespec.tv_nsec)}};
}
void RuntimeBridge::chooseBackupForRestore(const QUrl &source) { chooseBackup(source, false); }
void RuntimeBridge::chooseBackupForRescue(const QUrl &source) { chooseBackup(source, true); }
void RuntimeBridge::chooseBackup(const QUrl &source, bool rescue) {
    if (m_backupRestoring || memoryRequestPending("backup")) return;
    if (!m_connected || (!rescue && !runtimeWritable()) || (rescue && m_recoveryState != "recovery_required")) {
        setMemoryFeedback("backup", "error", recoveryWarning().isEmpty() ? "本地服务尚未连接。" : recoveryWarning());
        return;
    }
    discardStagedBackup();
    QString error;
    const auto path = source.toLocalFile();
    const auto binding = source.isLocalFile() ? backupFileBinding(path, &error) : QVariantMap{};
    if (binding.isEmpty()) { setMemoryFeedback("backup", "error", error.isEmpty() ? "请选择本地备份文件。" : error); return; }
    m_backupSource = path;
    m_backupSourceBinding = binding;
    m_backupRescue = rescue;
    const int generation = m_generation;
    const auto id = control("backup:file:inspect", {{"path", path}}, [this, path, binding, rescue, generation](QJsonObject r) {
        if (generation != m_generation || m_backupSource != path) return;
        const auto bytes = r["file_bytes"].toInteger(-1);
        const bool inspected = r["ok"].toBool() && r["sha256"].isString() &&
            QRegularExpression("^[0-9a-f]{64}$").match(r["sha256"].toString()).hasMatch() &&
            r["file_bytes"].isDouble() && r["file_bytes"].toDouble() == double(bytes) &&
            bytes >= 1 && bytes <= 1024LL * 1024 * 1024 &&
            r["sha256"].toString() == binding["sha256"].toString() && bytes == binding["file_bytes"].toLongLong() &&
            r["schema_version"].toInt() >= 1 && r["schema_version"].toInt() <= 3;
        if (!inspected) {
            const auto code = r["code"].toString();
            discardStagedBackup();
            setMemoryFeedback("backup", "error", code == "BACKUP_UNCONFIRMED_EXPORT"
                ? "该文件标记为未确认状态，只能留存，不能用于恢复或解困。"
                : "备份检查未通过或文件已变化，没有暂存或改动数据。", {}, {{"code", code}});
            return;
        }
        QString error;
        const auto current = backupFileBinding(path, &error);
        if (current != binding) { discardStagedBackup(); setMemoryFeedback("backup", "error", "备份在检查后发生变化，请重新选择。"); return; }
        const auto staged = stageBackupFile(path, m_data + "/backup-staging", &error);
        const auto stagedBinding = staged.isEmpty() ? QVariantMap{} : backupFileBinding(staged, &error);
        if (staged.isEmpty() || stagedBinding["sha256"] != binding["sha256"] || stagedBinding["file_bytes"] != binding["file_bytes"]) {
            if (!staged.isEmpty()) QFile::remove(staged);
            discardStagedBackup(); setMemoryFeedback("backup", "error", error.isEmpty() ? "备份暂存不完整，请重新选择。" : error); return;
        }
        m_backupStaged = staged;
        m_backupInspection = r.toVariantMap();
        m_state["backupRestore"] = QVariantMap{{"fileName", QFileInfo(path).fileName()}, {"fileBytes", bytes},
            {"schemaVersion", r["schema_version"].toInt()}, {"memoryCount", r["memory_count"].toInt()},
            {"mode", rescue ? "rescue" : "normal"}};
        setMemoryFeedback("backup", "confirmation", rescue ? "备份检查通过。请明确确认这是已知完好的备份，再恢复解困。" : "备份检查通过。请确认替换当前人格的数据。", {}, {{"mode", rescue ? "rescue" : "normal"}});
    }, 0);
    if (!id.isEmpty())
        setMemoryFeedback("backup", "pending", "正在只读检查备份文件…", id);
}
void RuntimeBridge::cancelBackupRestore() {
    if (m_backupRestoring || memoryRequestPending("backup")) return;
    discardStagedBackup();
    setMemoryFeedback("backup", "cancelled", "已取消恢复，未改动数据。");
}
void RuntimeBridge::confirmBackupRestore(bool knownGood) {
    if (m_backupRestoring || memoryRequestPending("backup") || personaCardExportPending() || personaProfilePending() || worldbookFileBusy() || m_backupStaged.isEmpty() || m_backupInspection.isEmpty()) return;
    if (!m_connected || (!m_backupRescue && !runtimeWritable()) || (m_backupRescue && (m_recoveryState != "recovery_required" || !knownGood))) return;
    QString error;
    const auto source = backupFileBinding(m_backupSource, &error);
    const auto staged = backupFileBinding(m_backupStaged, &error);
    if (source != m_backupSourceBinding || staged["sha256"] != m_backupInspection["sha256"] ||
        staged["file_bytes"].toLongLong() != m_backupInspection["file_bytes"].toLongLong()) {
        discardStagedBackup();
        setMemoryFeedback("backup", "error", "备份文件在确认前发生变化，请重新选择；未改动数据。");
        return;
    }
    m_backupRestoring = true;
    emit changed();
    emit gameChanged();
    const auto id = control("backup:file:import", {{"path", m_backupStaged},
        {"mode", m_backupRescue ? "rescue" : "normal"}, {"known_good_confirmed", m_backupRescue && knownGood}, {"sha256", m_backupInspection["sha256"].toString()},
        {"file_bytes", m_backupInspection["file_bytes"].toLongLong()}}, [this](QJsonObject r) {
        m_backupRestoring = false;
        discardStagedBackup();
        if (r["not_sent"].toBool()) {
            setMemoryFeedback("backup", "error", "恢复请求未能发送，未启动恢复；草稿已保留。", {},
                              {{"code", r["code"].toString()}});
            emit gameChanged();
            return;
        }
        if (r["unknown"].toBool()) {
            m_runtimeWritable = false; m_recoveryState = "unknown"; m_recoveryLocked = true;
            m_state["recovery"] = QVariantMap{{"state", m_recoveryState}, {"writesBlocked", true}};
        }
        const auto outcome = r["outcome"].toString();
        if ((r["ok"].toBool() && outcome != "committed") ||
            (outcome == "unconfirmed" && m_runtimeWritable)) {
            m_runtimeWritable = false;
            m_recoveryState = "unknown";
            m_recoveryLocked = true;
            m_state["recovery"] = QVariantMap{{"state", m_recoveryState}, {"writesBlocked", true}};
        }
        const bool settled = m_runtimeWritable && m_recoveryState == "clean";
        if (r["ok"].toBool() && settled && outcome == "committed")
            setMemoryFeedback("backup", "success", "恢复已确认完成；正在重新读取当前资料，未保存草稿已保留。");
        else if (settled && outcome == "rolled_back")
            setMemoryFeedback("backup", "rolled_back", "恢复未完成，已确认回到恢复前的数据；草稿已保留。");
        else if (settled && !r["ok"].toBool())
            setMemoryFeedback("backup", "error", "恢复请求被拒绝；服务已确认当前数据可写，草稿已保留。", {}, {{"code", r["code"].toString()}});
        else
            setMemoryFeedback("backup", "unknown", "恢复终态尚未确认，写入继续锁定；未自动重试。可查看、留存导出，或选择已知完好的备份恢复解困。", {}, {{"code", r["code"].toString()}});
        emit changed();
        emit gameChanged();
        if (settled) {
            if (!m_networkFeedback.value("known").toBool() && m_networkFeedback.value("status").toString() != "pending") setOffline(m_offline);
            refresh(); readMemories(true); emit backupRestoreReconciled();
        }
    }, 0);
    if (!id.isEmpty())
        setMemoryFeedback("backup", "pending", "正在恢复备份，等待服务确认终态；未自动重试。", id);
}
QVariantMap RuntimeBridge::profileUpdate(const QVariantMap &fields, QString *error) {
    // Limits mirror the backend's UserProfileData so a refusal is explained
    // here instead of arriving as an opaque validation error.
    static const QList<QPair<QString, int>> scalars{
        {"name", 80}, {"nickname", 80}, {"birthday", 10}, {"identity", 500}, {"schedule", 200}};
    static const QStringList lists{"interests", "hobbies", "favorite_topics", "favorite_games", "favorite_anime"};
    static const QRegularExpression separators("[，,、;；\\n]");
    static const QRegularExpression date("^\\d{4}-\\d{2}-\\d{2}$");
    static const QRegularExpression wholeNumber("^\\d{1,3}$");
    QVariantMap profile;
    for (const auto &[key, limit] : scalars) {
        const auto value = fields.value(key).toString().trimmed();
        if (value.isEmpty())
            continue;
        if (value.size() > limit) {
            *error = QString("有一项超过 %1 字，资料没有保存。").arg(limit);
            return {};
        }
        if (key == "birthday" && !date.match(value).hasMatch()) {
            *error = "生日请写成 2000-01-31 这样的格式，资料没有保存。";
            return {};
        }
        profile[key] = value;
    }
    // Same range as the backend; blank means unchanged, like every field here.
    const auto age = fields.value("age").toString().trimmed();
    if (!age.isEmpty()) {
        const int years = wholeNumber.match(age).hasMatch() ? age.toInt() : 0;
        if (years < 18 || years > 120) {
            *error = "年龄请填写 18 到 120 之间的整数，资料没有保存。";
            return {};
        }
        profile["age"] = years;
    }
    for (const auto &key : lists) {
        QStringList items;
        for (const auto &part : fields.value(key).toString().split(separators))
            if (!part.trimmed().isEmpty())
                items << part.trimmed();
        if (items.isEmpty())
            continue;
        if (items.size() > 50 || std::any_of(items.cbegin(), items.cend(),
                                             [](const QString &item) { return item.size() > 160; })) {
            *error = "每类最多 50 项、每项不超过 160 字，资料没有保存。";
            return {};
        }
        profile[key] = items;
    }
    if (profile.isEmpty()) {
        *error = "没有填写可保存的内容。";
        return {};
    }
    return {{"profile", profile}};
}
bool RuntimeBridge::personaProfilePending() const {
    return QStringList{"loading", "saving"}.contains(m_personaProfileState.value("status").toString());
}
void RuntimeBridge::setPersonaProfileStatus(const QString &status, const QString &text) {
    m_personaProfileState.insert({{"status", status}, {"text", text}});
    emit changed();
}
void RuntimeBridge::invalidatePersonaProfile() {
    if (m_personaProfileState.isEmpty()) return;
    const bool saving = m_personaProfileState.value("status").toString() == "saving";
    const bool open = m_personaProfileState.value("open").toBool() || personaProfilePending();
    m_pending.remove(m_personaProfileState.value("requestId").toString());
    m_personaProfileState["open"] = false;
    m_personaProfileState.remove("fields");
    m_personaProfileProof = {};
    m_personaProfileGeneration = -1;
    if (open) setPersonaProfileStatus(saving ? "unknown" : "stale", saving
        ? "保存结果未知，请重新打开查看。" : "人格已变化，未保存的编辑已丢弃。");
}
void RuntimeBridge::closePersonaProfile() {
    if (personaProfilePending()) return;
    m_personaProfileState["open"] = false;
    m_personaProfileState.remove("fields");
    emit changed();
}
void RuntimeBridge::loadPersonaProfile(const QString &profileId) {
    if (personaProfilePending() || personaChanging() || personaCardExportPending() || worldbookFileBusy() ||
        !m_connected || !runtimeWritable() || m_stopping) return;
    QVariantMap row;
    for (const auto &value : m_state.value("personas").toMap().value("profiles").toList())
        if (value.toMap().value("id").toString() == profileId) row = value.toMap();
    if (row.isEmpty() || !QStringList{"chara_card_v2", "chara_card_v3", "tavern_card_v1"}
            .contains(row.value("source_format").toString())) {
        m_personaProfileState = {{"open", false}};
        setPersonaProfileStatus("error", row.isEmpty() ? "这个人格不在本地列表中，请刷新后重新打开编辑。没有保存。"
                                                       : "内置人格不能编辑。没有保存。");
        return;
    }
    m_personaProfileProof = m_persona;
    m_personaProfileGeneration = m_generation;
    m_personaProfileState = {{"status", "loading"}, {"text", "正在读取人格内容…"},
        {"open", false}, {"profile_id", profileId}, {"name", row.value("name")},
        {"scopeKey", scopeKey()}, {"generation", m_generation}};
    m_personaProfileSending = true;
    const auto id = request("persona:profile:get", {{"profile_id", profileId}});
    m_personaProfileSending = false;
    m_personaProfileState["requestId"] = id;
    if (id.isEmpty()) setPersonaProfileStatus("error", "人格内容读取请求没有发出，请重新打开编辑。");
    else emit changed();
}
void RuntimeBridge::savePersonaProfile(const QVariantMap &fields, bool confirmed) {
    if (!confirmed || personaProfilePending() || !m_personaProfileState.value("open").toBool() ||
        !m_connected || !runtimeWritable() || m_stopping || personaChanging() || personaCardExportPending() || worldbookFileBusy()) return;
    if (m_personaProfileGeneration != m_generation || m_personaProfileProof != m_persona) {
        invalidatePersonaProfile(); return;
    }
    const auto profileId = m_personaProfileState.value("profile_id").toString();
    for (const auto &value : m_state.value("personas").toMap().value("profiles").toList())
        if (value.toMap().value("id").toString() == profileId && value.toMap().value("active").toBool()) {
            setPersonaProfileStatus("error", "使用中的人格不能编辑，请先切换到其他人格。没有保存。"); return;
        }
    if (m_personaProfileState.value("active").toBool()) {
        setPersonaProfileStatus("error", "使用中的人格不能编辑，请先切换到其他人格。没有保存。"); return;
    }
    QString bad;
    if (!validPersonaProfileFields(obj(fields), false, &bad)) {
        setPersonaProfileStatus("error", personaProfileFieldName(bad) + "的格式、字数或条数不符合限制。没有保存。"); return;
    }
    QVariantMap changes;
    const auto base = m_personaProfileState.value("fields").toMap();
    for (auto it = fields.begin(); it != fields.end(); ++it)
        if (it.value() != base.value(it.key())) changes[it.key()] = it.value();
    if (changes.isEmpty()) { setPersonaProfileStatus("error", "内容没有变化。没有保存。"); return; }
    const QVariantMap payload{{"profile_id", profileId},
        {"expected_identity_version", m_personaProfileState.value("identity_version")},
        {"expected_identity_fingerprint", m_personaProfileState.value("identity_fingerprint")},
        // V4 carries this exact load-time proof in envelope.persona. The
        // private bridge supplies the handler's expected_persona_* fields.
        {"fields", changes},
        {"identity_change_confirmed", true}, {"confirmed_profile_id", profileId},
        {"actor", "owner"}, {"reason", "用户通过原生角色面板确认编辑并升版"}};
    m_personaProfileState.insert({{"status", "saving"}, {"text", "正在保存人格新版本…"}});
    m_personaProfileSending = true;
    const auto id = request("persona:profile:update", payload);
    m_personaProfileSending = false;
    m_personaProfileState["requestId"] = id;
    if (id.isEmpty()) invalidatePersonaProfile();
    else emit changed();
}
void RuntimeBridge::finishPersonaProfile(const QString &type, const QJsonObject &payload, const QString &) {
    const bool saving = m_personaProfileState.value("status").toString() == "saving";
    const QString expectedType = saving ? "persona:profile:update:result" : "persona:profile:get:result";
    if ((type == expectedType || type == "error") && payload["ok"].isBool() && !payload["ok"].toBool() &&
        payload["code"].isString() && !payload["code"].toString().isEmpty() && payload["error"].isString()) {
        const auto code = payload["code"].toString();
        const QHash<QString, QString> reasons{{"persona_active", "使用中的人格不能编辑，请先切换到其他人格"},
            {"persona_not_editable", "内置人格不能编辑"}, {"restore_pending", "这个人格有待完成的恢复"},
            {"field_not_editable", "包含不可编辑的字段"}, {"field_too_long", "内容超过字数上限"},
            {"field_invalid", "内容的格式或条数不符合限制"}, {"unsafe_profile_instructions", "内容包含可疑元指令"},
            {"profile_not_found", "这个人格已不在本地列表中"}, {"no_change", "规整后的内容没有变化"},
            {"identity_confirmation_required", "保存确认不完整"}, {"identity_authorization_required", "保存授权不完整"},
            {"persona_restart_required", "本地服务需要重启"}};
        m_personaProfileState["code"] = code;
        m_personaProfileState["field"] = payload["field"].toVariant();
        QString reason = code == "identity_conflict" ? "这个人格已在别处更改，请重新打开编辑。"
            : reasons.value(code, payload["error"].toString().isEmpty() ? QString("人格内容操作被拒绝")
                                                                     : payload["error"].toString()) +
                (payload["field"].isString() ? "（" + personaProfileFieldName(payload["field"].toString()) + "）" : "") + "。";
        if (!saving) m_personaProfileState["open"] = false;
        setPersonaProfileStatus(code == "identity_conflict" ? "conflict" : "error", reason + "没有保存。");
        return;
    }
    static const QRegularExpression fingerprint("^[a-f0-9]{64}$");
    const int version = payload["identity_version"].toInt(-1);
    const bool valid = type == expectedType && payload["ok"].isBool() && payload["ok"].toBool() &&
        payload["profile_id"].isString() && payload["profile_id"].toString() == m_personaProfileState.value("profile_id").toString() &&
        pinCount(payload["identity_version"]) && version > 0 && payload["identity_fingerprint"].isString() &&
        fingerprint.match(payload["identity_fingerprint"].toString()).hasMatch() && payload["active"].isBool() &&
        payload["fields"].isObject() && validPersonaProfileFields(payload["fields"].toObject(), true) &&
        !payload.contains("code") && !payload.contains("error") && !payload.contains("path") && !payload.contains("persona_epoch") &&
        (saving ? (!payload["active"].toBool() && qint64(version) == m_personaProfileState.value("identity_version").toLongLong() + 1 &&
            payload["identity_fingerprint"].toString() != m_personaProfileState.value("identity_fingerprint").toString())
            : payload["source_format"].isString() && QStringList{"chara_card_v2", "chara_card_v3", "tavern_card_v1"}.contains(payload["source_format"].toString()));
    if (!valid) {
        if (saving) invalidatePersonaProfile();
        else { m_personaProfileState["open"] = false; setPersonaProfileStatus("error", "人格内容读取未获确认，请重新打开编辑。"); }
        return;
    }
    for (const auto &key : {"identity_version", "identity_fingerprint", "active", "fields"})
        m_personaProfileState[key] = payload[key].toVariant();
    if (!saving) m_personaProfileState["source_format"] = payload["source_format"].toVariant();
    m_personaProfileState["open"] = true;
    m_personaProfileState.remove("code"); m_personaProfileState.remove("field");
    setPersonaProfileStatus(saving ? "success" : "ready", saving
        ? QString("已保存为第 %1 版，切换到这个人格后生效。").arg(version) : "");
    if (saving) refreshPersonas();
}
void RuntimeBridge::selectPersona(const QString &id) {
    if (!m_personaSwitch.isEmpty() || !m_personaImport.isEmpty() || personaCardExportPending() || personaProfilePending() || worldbookFileBusy())
        return;
    QVariantMap target;
    for (const auto &value : m_state.value("personas").toMap().value("profiles").toList())
        if (value.toMap().value("id").toString() == id)
            target = value.toMap();
    if (id.isEmpty() || target.isEmpty()) {
        setPersonaFeedback("error", "这个人格不在本地列表中；请刷新列表后再选。");
        return;
    }
    if (target.value("active").toBool())
        return;
    if (!m_connected) {
        setPersonaFeedback("error", "本地服务尚未连接，没有切换。");
        return;
    }
    if (!runtimeWritable()) {
        setPersonaFeedback("error", "写入已锁定，没有切换人格。");
        return;
    }
    if (m_busy) {
        setPersonaFeedback("error", "回复进行中；请等它完成或停止后再切换。");
        return;
    }
    const auto name = target.value("name").toString();
    const auto requestId = request("persona:activate", {{"profile_id", id},
                                                        {"confirmed_profile_id", id},
                                                        {"identity_change_confirmed", true},
                                                        {"actor", "owner"},
                                                        {"reason", "用户通过原生角色面板确认切换"}});
    if (requestId.isEmpty()) {
        setPersonaFeedback("error", "切换请求没有发出，当前人格没有改变。");
        return;
    }
    m_personaSwitch = {{"requestId", requestId}, {"targetId", id}, {"targetName", name}};
    setPersonaFeedback("pending", QString("正在切换为「%1」…").arg(name), requestId);
}
void RuntimeBridge::refreshPersonas() {
    if (m_connected)
        request("persona:list");
}
void RuntimeBridge::choosePersonaCard(const QUrl &source) {
    if (!personaCardActionAllowed())
        return;
    clearPersonaCardCandidate();
    if (!source.isLocalFile()) {
        setPersonaCardFeedback("error", "请选择本地 JSON 或 PNG 角色卡。");
        return;
    }
    const auto card = PersonaCardReader::readFile(source.toLocalFile());
    if (!card.valid()) {
        setPersonaCardFeedback("error", card.error);
        return;
    }
    const QVariantMap payload{{"json", card.json}, {"filename", card.filename},
        {"identity_change_confirmed", true}, {"actor", "owner"},
        {"reason", "用户通过原生角色面板确认导入并切换"}};
    // The actual UTF-8 frame includes JSON escaping and the V4 identity
    // envelope. Checking only source bytes would admit an unsendable card.
    if (QJsonDocument(rendererFrame("persona:import", obj(payload), uid(), m_persona))
            .toJson(QJsonDocument::Compact).size() > 1048576) {
        setPersonaCardFeedback("error", "角色卡加上传输信封与转义后超过 1 MiB，导入请求无法发送。请使用较小的卡片。");
        return;
    }
    m_personaCardJson = card.json;
    m_personaCardCandidate = {{"filename", card.filename}, {"name", card.name},
        {"sourceFormat", card.sourceFormat}, {"bytes", card.json.toUtf8().size()},
        {"targetId", card.targetId}, {"scopeKey", scopeKey()}};
    setPersonaCardFeedback("confirmation", "角色卡已在内存中读取；确认后导入并立即切换。");
}
void RuntimeBridge::cancelPersonaCard() {
    clearPersonaCardCandidate();
}
QVariantMap RuntimeBridge::personaCardExportProfile() const {
    if (m_personaCardExportProfilesGeneration != m_generation)
        return {};
    const auto list = m_state.value("personas").toMap();
    const auto snapshot = obj(list);
    const auto current = m_persona["persona_id"].toString();
    const auto active = snapshot["active_id"].toString();
    if (current.isEmpty() || active.isEmpty() || !snapshot["ok"].isBool() || !snapshot["ok"].toBool() ||
        !snapshot["persona_id"].isString() || snapshot["persona_id"] != m_persona["persona_id"] ||
        !pinCount(snapshot["persona_epoch"]) || snapshot["persona_epoch"] != m_persona["epoch"] ||
        !snapshot["persona_fingerprint"].isString() || snapshot["persona_fingerprint"].toString().isEmpty() ||
        snapshot["persona_fingerprint"] != m_persona["fingerprint"] || !snapshot["profiles"].isArray())
        return {};
    QVariantMap selected;
    for (const auto &value : list.value("profiles").toList()) {
        const auto profile = value.toMap();
        const auto record = obj(profile);
        if (!record["id"].isString() || record["id"].toString() != active ||
            !record["active"].isBool() || !record["active"].toBool())
            continue;
        if (!selected.isEmpty())
            return {};
        selected = profile;
    }
    // The built-in registry row is named "default"; its sealed scope has the
    // canonical persona ID. Imported rows use that canonical ID directly.
    const bool builtinAlias = active == "default" &&
        QStringList{"builtin", "builtin_legacy"}.contains(selected.value("source_format").toString());
    return active == current || builtinAlias ? selected : QVariantMap{};
}
bool RuntimeBridge::personaCardExportArchiveKnown() const {
    const auto snapshot = obj(m_archive);
    const auto revision = snapshot["revision"];
    const bool empty = snapshot["exists"].isBool() && !snapshot["exists"].toBool() &&
        revision.isDouble() && revision.toDouble() == 0 && snapshot["archive"].isNull();
    return m_personaCardExportArchiveGeneration == m_generation &&
        m_personaCardExportArchivePersona == m_persona &&
        m_archive.value("ok") == QVariant(true) && (snapshot["archive"].isObject() || empty) &&
        pinCount(revision);
}
bool RuntimeBridge::personaCardExportPending() const {
    return m_personaCardExportState.value("status").toString() == "pending";
}
bool RuntimeBridge::personaCardExportBuiltin() const {
    return QStringList{"builtin", "builtin_legacy"}.contains(
        personaCardExportProfile().value("source_format").toString());
}
bool RuntimeBridge::personaCardExportAvailable() const {
    const auto format = personaCardExportProfile().value("source_format").toString();
    return m_connected && !m_stopping && runtimeWritable() &&
        !personaChanging() && !personaCardExportPending() && !personaProfilePending() && !worldbookFileBusy() &&
        personaCardExportArchiveKnown() &&
        QStringList{"tavern_card_v1", "chara_card_v2", "chara_card_v3"}.contains(format);
}
QVariantList RuntimeBridge::personaCardExportBooks() const {
    QVariantList books{QVariantMap{{"id", ""}, {"name", "不嵌入"}}};
    if (!personaCardExportArchiveKnown())
        return books;
    for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList()) {
        const auto book = value.toMap();
        if (!book.value("id").toString().isEmpty() && book.value("name").metaType().id() == QMetaType::QString)
            books.append(QVariantMap{{"id", book.value("id")}, {"name", book.value("name")}});
    }
    return books;
}
QString RuntimeBridge::personaCardExportDefaultBookId() const {
    const auto name = personaCardExportProfile().value("name").toString() + "的世界书";
    for (const auto &value : personaCardExportBooks()) {
        const auto book = value.toMap();
        if (!book.value("id").toString().isEmpty() && book.value("name").toString() == name)
            return book.value("id").toString();
    }
    return {};
}
QUrl RuntimeBridge::suggestedPersonaCardFile() const {
    auto name = personaCardExportProfile().value("name").toString();
    name.replace(QRegularExpression("[\\x00-\\x1f\\x7f<>:\"/\\\\|?*]"), "_");
    if (name.isEmpty())
        name = "角色";
    return QUrl::fromLocalFile(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) +
        "/" + name + "-SillyTavern角色卡.json");
}
void RuntimeBridge::setPersonaCardExportState(const QString &status, const QString &text,
                                              const QVariantMap &details) {
    m_personaCardExportState = details;
    m_personaCardExportState.insert({{"status", status}, {"text", text}});
    emit changed();
}
void RuntimeBridge::unknownPersonaCardExport() {
    if (!personaCardExportPending())
        return;
    const auto details = m_personaCardExportState;
    m_pending.remove(details.value("requestId").toString());
    setPersonaCardExportState("unknown", "导出结果未知，请检查目标文件。", details);
}
void RuntimeBridge::exportPersonaCard(const QUrl &target, const QString &worldBookId) {
    if (personaCardExportPending())
        return;
    if (!personaCardExportAvailable()) {
        setPersonaCardExportState("error", personaCardExportBuiltin()
            ? "内置人格不能导出角色卡，没有写出文件。"
            : "当前人格、档案或连接尚未可供导出，请等待当前操作完成并重新读取。没有写出文件。");
        return;
    }
    const QFileInfo info(target.toLocalFile());
    if (!target.isLocalFile() || !info.isAbsolute() || info.suffix().toLower() != "json" ||
        !QFileInfo(info.absolutePath()).isDir() || info.isDir() || info.isSymLink()) {
        setPersonaCardExportState("error", "请选择一个以 .json 结尾的本地保存位置。没有写出文件。");
        return;
    }
    QString bookName;
    int entryCount = 0;
    bool found = worldBookId.isEmpty();
    for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList()) {
        const auto book = value.toMap();
        if (!worldBookId.isEmpty() && book.value("id").toString() == worldBookId) {
            found = true;
            bookName = book.value("name").toString();
            entryCount = book.value("entries").toList().size();
            break;
        }
    }
    if (!found) {
        setPersonaCardExportState("error", "所选世界书已不在当前档案中，请重新选择。没有写出文件。",
                                  {{"code", "world_book_not_found"}});
        return;
    }
    const auto proof = m_persona;
    const int generation = m_generation;
    const QJsonValue revision = obj(m_archive).value("revision");
    const auto path = info.absoluteFilePath();
    const auto bookId = worldBookId.isEmpty() ? QJsonValue(QJsonValue::Null) : QJsonValue(worldBookId);
    QVariantMap details{{"requestId", ""}, {"scopeKey", scopeKey()}, {"generation", generation},
        {"archiveRevision", revision.toVariant()}, {"world_book_id", bookId.toVariant()}};
    setPersonaCardExportState("pending", "正在导出角色卡…", details);
    if (!personaCardExportPending() || generation != m_generation || proof != m_persona) {
        unknownPersonaCardExport();
        return;
    }
    const auto id = control("persona:card:export", {{"path", path}, {"world_book_id", bookId},
        {"persona_id", proof["persona_id"]}, {"persona_epoch", proof["epoch"]},
        {"persona_fingerprint", proof["fingerprint"]}, {"archive_revision", revision}},
        [this, path, proof, generation, bookId, bookName, entryCount](QJsonObject r) {
            auto details = m_personaCardExportState;
            details["requestId"] = r["requestId"].toString();
            if (generation != m_generation || proof != m_persona || !m_connected || m_stopping ||
                r["unknown"].toBool()) {
                setPersonaCardExportState("unknown", "导出结果未知，请检查目标文件。", details);
                return;
            }
            if (r["not_sent"].toBool()) {
                setPersonaCardExportState("error", "导出请求未能发送，没有写出文件。", details);
                return;
            }
            if (r["ok"].isBool() && !r["ok"].toBool() && r["code"].isString() &&
                !r["code"].toString().isEmpty() && r["error"].isString() &&
                (r["code"] != "card_not_importable" ||
                 (r["import_code"].isString() && !r["import_code"].toString().isEmpty()))) {
                const QHash<QString, QString> reasons{{"persona_changed", "当前人格已变化"},
                    {"persona_not_exportable", "当前人格不是由角色卡导入的"},
                    {"archive_changed", "已保存的档案已变化，请重新读取"},
                    {"world_book_not_found", "所选世界书已不存在"},
                    {"card_too_large", "角色卡超过 2 MiB 上限"},
                    {"invalid_path", "保存位置无效"},
                    {"card_not_importable", "按现有导入规则不能读回"}};
                const auto code = r["code"].toString();
                auto reason = reasons.value(code, "角色卡导出被拒绝");
                const auto explanation = r["error"].toString();
                if (!explanation.isEmpty())
                    reason = explanation.startsWith(reason) ? explanation : reason + "：" + explanation;
                details["code"] = code;
                if (r["import_code"].isString()) details["import_code"] = r["import_code"].toString();
                setPersonaCardExportState("error", reason + "。没有写出文件。", details);
                return;
            }
            const auto bytes = r["bytes"].toInteger(-1);
            bool valid = r["ok"].isBool() && r["ok"].toBool() &&
                r["file_name"].isString() && r["file_name"].toString() == QFileInfo(path).fileName() &&
                r["persona_id"].isString() && r["persona_id"] == proof["persona_id"] &&
                r.contains("world_book_id") && r["world_book_id"] == bookId &&
                r["world_book_name"].isString() && r["world_book_name"].toString() == bookName &&
                pinCount(r["entry_count"]) && r["entry_count"].toInt() == entryCount &&
                r["bytes"].isDouble() && r["bytes"].toDouble() == double(bytes) &&
                bytes > 0 && bytes <= 2 * 1024 * 1024 && r["sha256"].isString() &&
                QRegularExpression("^[0-9a-f]{64}$").match(r["sha256"].toString()).hasMatch() &&
                !r.contains("code") && !r.contains("error");
            // Read at most the acknowledged card size through a no-follow descriptor.
            const auto native = QFile::encodeName(path);
            const int fd = valid ? ::open(native.constData(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC) : -1;
            struct stat before{}, after{}, named{};
            valid = valid && fd >= 0 && ::fstat(fd, &before) == 0 && S_ISREG(before.st_mode) &&
                before.st_size == bytes;
            QByteArray content;
            if (valid) {
                content.resize(bytes);
                qint64 read = 0;
                while (valid && read < bytes) {
                    const auto count = ::read(fd, content.data() + read, bytes - read);
                    valid = count > 0;
                    if (count > 0) read += count;
                }
                valid = valid && ::fstat(fd, &after) == 0 && ::lstat(native.constData(), &named) == 0 &&
                    S_ISREG(named.st_mode) && before.st_dev == named.st_dev && before.st_ino == named.st_ino &&
                    before.st_size == after.st_size && before.st_mtimespec.tv_sec == after.st_mtimespec.tv_sec &&
                    before.st_mtimespec.tv_nsec == after.st_mtimespec.tv_nsec &&
                    QCryptographicHash::hash(content, QCryptographicHash::Sha256).toHex() == r["sha256"].toString().toLatin1();
            }
            if (fd >= 0) ::close(fd);
            if (!valid) {
                setPersonaCardExportState("unknown", "导出结果未知，请检查目标文件。", details);
                return;
            }
            for (const auto &key : {"file_name", "bytes", "sha256", "world_book_id", "world_book_name", "entry_count", "persona_id"})
                details[key] = r[key].toVariant();
            setPersonaCardExportState("success", bookId.isNull()
                ? QString("已导出到 %1，未嵌入世界书。").arg(r["file_name"].toString())
                : QString("已导出到 %1，含世界书《%2》%3 条。").arg(r["file_name"].toString(), bookName).arg(entryCount), details);
        });
    if (!id.isEmpty() && personaCardExportPending()) {
        m_personaCardExportState["requestId"] = id;
        emit changed();
    }
}
bool RuntimeBridge::worldbookFileBusy() const {
    return QStringList{"inspecting", "confirmation", "importing", "imported", "exporting"}
        .contains(m_worldbookFileState.value("status").toString());
}
bool RuntimeBridge::worldbookFileContextMatches(int revision) const {
    return m_connected && !m_stopping && runtimeWritable() && !personaChanging() &&
        !personaCardExportPending() && !personaProfilePending() &&
        personaCardExportArchiveKnown() && revision >= 0 && m_archive.value("revision").toInt() == revision;
}
bool RuntimeBridge::worldbookFileAvailable() const {
    return !worldbookFileBusy() && worldbookFileContextMatches(m_archive.value("revision", -1).toInt());
}
void RuntimeBridge::setWorldbookFileState(const QString &status, const QString &text, const QVariantMap &details) {
    m_worldbookFileState = details;
    if (!m_worldbookFileState.contains("scopeKey")) m_worldbookFileState["scopeKey"] = scopeKey();
    if (!m_worldbookFileState.contains("generation")) m_worldbookFileState["generation"] = m_generation;
    m_worldbookFileState.insert({{"status", status}, {"text", text}});
    emit changed();
}
void RuntimeBridge::unknownWorldbookFile() {
    if (!worldbookFileBusy()) return;
    auto details = m_worldbookFileState;
    m_pending.remove(details.value("requestId").toString());
    ++m_worldbookFileSerial;
    m_worldbookFilePath.clear();
    setWorldbookFileState("unknown", "文件操作结果未确认，请重新读取世界书或检查目标文件；未自动重试。", details);
}
QUrl RuntimeBridge::suggestedWorldbookFile(const QString &worldBookId) const {
    QString name = "世界书";
    for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList())
        if (value.toMap().value("id").toString() == worldBookId) name = value.toMap().value("name").toString();
    name.replace(QRegularExpression("[\\x00-\\x1f\\x7f<>:\"/\\\\|?*]"), "_");
    if (name.isEmpty()) name = "世界书";
    return QUrl::fromLocalFile(QStandardPaths::writableLocation(QStandardPaths::DocumentsLocation) + "/" + name + ".json");
}
void RuntimeBridge::inspectWorldbookFile(const QUrl &source, int revision) {
    if (worldbookFileBusy()) return;
    if (!worldbookFileContextMatches(revision)) {
        setWorldbookFileState("error", "当前人格或已保存的档案尚未确认，请先重新读取。");
        return;
    }
    const QFileInfo info(source.toLocalFile());
    if (!source.isLocalFile() || !info.isAbsolute() || info.suffix().toLower() != "json" ||
        !info.isFile() || info.isSymLink()) {
        setWorldbookFileState("error", "请选择一个本地 JSON 世界书文件。", {{"code", "invalid_path"}});
        return;
    }
    runWorldbookFileControl("inspect", info.absoluteFilePath(), {}, revision);
}
void RuntimeBridge::confirmWorldbookFileImport(int revision) {
    if (m_worldbookFileState.value("status") != "confirmation") return;
    if (!worldbookFileContextMatches(revision) || m_worldbookFilePersona != m_persona ||
        m_worldbookFileState.value("generation").toInt() != m_generation ||
        m_worldbookFileState.value("scopeKey").toString() != scopeKey() ||
        m_worldbookFileState.value("archiveRevision").toInt() != revision) {
        const auto details = m_worldbookFileState;
        ++m_worldbookFileSerial;
        m_worldbookFilePath.clear();
        setWorldbookFileState("error", "人格或档案已变化，请重新选择文件并预览；没有发送导入。", details);
        return;
    }
    runWorldbookFileControl("import", m_worldbookFilePath, {}, revision);
}
void RuntimeBridge::cancelWorldbookFileImport() {
    if (m_worldbookFileState.value("status") != "confirmation") return;
    ++m_worldbookFileSerial;
    m_worldbookFilePath.clear();
    setWorldbookFileState("idle", "");
}
void RuntimeBridge::exportWorldbookFile(const QUrl &target, const QString &bookId, int revision) {
    if (worldbookFileBusy()) return;
    if (!worldbookFileContextMatches(revision)) {
        setWorldbookFileState("error", "当前人格或已保存的档案尚未确认，请先重新读取。");
        return;
    }
    QVariantMap selected;
    for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList())
        if (value.toMap().value("id").toString() == bookId) selected = value.toMap();
    if (bookId.isEmpty() || selected.isEmpty() || selected.value("entries").toList().isEmpty()) {
        setWorldbookFileState("error", selected.isEmpty() ? "请先选择一本已保存的世界书。" : "这本书还没有条目，没有写出文件。",
                             {{"code", selected.isEmpty() ? "world_book_not_found" : "empty_book"}});
        return;
    }
    const QFileInfo info(target.toLocalFile());
    if (!target.isLocalFile() || !info.isAbsolute() || info.suffix().toLower() != "json" ||
        !QFileInfo(info.absolutePath()).isDir() || info.isDir() || info.isSymLink()) {
        setWorldbookFileState("error", "请选择一个以 .json 结尾的本地保存位置。", {{"code", "invalid_path"}});
        return;
    }
    runWorldbookFileControl("export", info.absoluteFilePath(), bookId, revision);
}
void RuntimeBridge::runWorldbookFileControl(const QString &operation, const QString &path,
                                           const QString &bookId, int revision) {
    const auto proof = m_persona;
    const int generation = m_generation;
    const quint64 serial = ++m_worldbookFileSerial;
    const auto previous = m_worldbookFileState;
    QVariantMap exportedBook;
    if (operation == "export")
        for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList())
            if (value.toMap().value("id").toString() == bookId) exportedBook = value.toMap();
    m_worldbookFilePersona = proof;
    m_worldbookFilePath = path;
    QVariantMap details{{"operation", operation}, {"requestId", ""}, {"scopeKey", scopeKey()},
                        {"generation", generation}, {"archiveRevision", revision}};
    if (operation == "import")
        for (const auto *key : {"sha256", "file_bytes", "book_name", "importable_entry_count"})
            details[key] = previous.value(key);
    if (operation == "export") details["world_book_id"] = bookId;
    const auto status = operation == "inspect" ? "inspecting" : operation == "import" ? "importing" : "exporting";
    setWorldbookFileState(status, operation == "inspect" ? "正在检查世界书文件…" :
        operation == "import" ? "正在导入世界书…" : "正在导出世界书…", details);
    if (serial != m_worldbookFileSerial || generation != m_generation || proof != m_persona) return;
    QJsonObject fields{{"path", path}, {"persona_id", proof["persona_id"]}, {"persona_epoch", proof["epoch"]},
                       {"persona_fingerprint", proof["fingerprint"]}, {"archive_revision", revision}};
    if (operation == "import") {
        fields["sha256"] = QJsonValue::fromVariant(previous.value("sha256"));
        fields["file_bytes"] = QJsonValue::fromVariant(previous.value("file_bytes"));
    }
    if (operation == "export") fields["world_book_id"] = bookId;
    const auto id = control("worldbook:file:" + operation, fields,
        [this, operation, path, bookId, revision, proof, generation, serial, exportedBook](const QJsonObject &r) {
            if (serial != m_worldbookFileSerial) return;
            if (generation != m_generation || proof != m_persona || !m_connected || m_stopping) {
                unknownWorldbookFile();
                return;
            }
            if (operation != "import" && !worldbookFileContextMatches(revision)) {
                unknownWorldbookFile();
                return;
            }
            auto details = m_worldbookFileState;
            details["requestId"] = r["requestId"].toString();
            if (r["not_sent"].toBool() && !r.contains("kind")) {
                m_worldbookFilePath.clear();
                setWorldbookFileState("error", "文件操作请求未能发送，没有执行；请重新选择。", details);
                return;
            }
            const auto exactKeys = [&r](QStringList keys) {
                keys += QStringList{"kind", "schema", "type", "requestId", "ok"};
                keys.sort();
                return r.keys() == keys;
            };
            const auto count = [](const QJsonValue &v, qint64 maximum = 10000) {
                return v.isDouble() && v.toDouble() >= 0 && v.toDouble() <= maximum &&
                    v.toDouble() == double(v.toInteger(-1));
            };
            const auto digest = [](const QJsonValue &v) {
                return v.isString() && QRegularExpression("^[0-9a-f]{64}$").match(v.toString()).hasMatch();
            };
            static const QHash<QString, QString> errors{
                {"invalid_request", "文件操作参数无效"}, {"invalid_path", "文件位置无效"},
                {"file_too_large", "世界书文件超过 5 MiB"}, {"invalid_encoding", "文件不是 UTF-8"},
                {"invalid_json", "JSON 文件无效"}, {"unsupported_format", "不支持这个世界书格式"},
                {"too_many_entries", "条目超过 10,000 条"}, {"no_importable_entries", "没有可以导入的条目"},
                {"archive_too_large", "导入后档案超过大小上限"}, {"file_changed", "文件已变化，请重新预览"},
                {"persona_changed", "当前人格已变化"}, {"archive_changed", "档案已变化，请重新读取"},
                {"world_book_not_found", "所选世界书已不存在"}, {"empty_book", "这本书还没有条目"},
                {"write_failed", "文件写入失败"}, {"archive_unavailable", "档案当前不可用"}};
            if (exactKeys({"code", "error"}) && r["ok"].isBool() && !r["ok"].toBool() &&
                r["code"].isString() && errors.contains(r["code"].toString()) && r["error"].isString()) {
                details["code"] = r["code"].toString();
                if (operation == "import" && r["code"] == "archive_unavailable") {
                    m_worldbookFileState["code"] = r["code"].toString();
                    unknownWorldbookFile();
                    return;
                }
                m_worldbookFilePath.clear();
                setWorldbookFileState("error", errors.value(r["code"].toString()) + "。", details);
                return;
            }
            bool valid = r["ok"].isBool() && r["ok"].toBool();
            if (operation == "inspect") {
                valid = valid && exactKeys({"book_name", "importable_entry_count", "skipped", "dropped_fields",
                    "disabled_regex_entry_count", "cleaned_entry_count", "sha256", "file_bytes"}) &&
                    r["book_name"].isString() && count(r["importable_entry_count"]) &&
                    r["importable_entry_count"].toInt() > 0 && count(r["disabled_regex_entry_count"]) &&
                    count(r["cleaned_entry_count"]) && digest(r["sha256"]) &&
                    count(r["file_bytes"], 5 * 1024 * 1024) && r["file_bytes"].toInt() > 0 &&
                    r["skipped"].isObject() && r["dropped_fields"].isObject();
                const QStringList droppedFields{"vectorized", "ignoreBudget", "excludeRecursion", "preventRecursion",
                    "groupOverride", "matchPersonaDescription", "matchCharacterDescription", "matchCharacterPersonality",
                    "matchCharacterDepthPrompt", "matchScenario", "matchCreatorNotes", "delayUntilRecursion",
                    "probability", "groupWeight", "useProbability", "outletName", "group", "automationId",
                    "matchWholeWords", "useGroupScoring", "sticky", "cooldown", "delay", "triggers",
                    "characterFilter", "characterFilterNames", "characterFilterTags", "characterFilterExclude",
                    "position", "selectiveLogic", "keysecondary"};
                const auto skipped = r["skipped"].toObject(), dropped = r["dropped_fields"].toObject();
                for (auto it = skipped.begin(); it != skipped.end(); ++it)
                    valid = valid && QStringList{"invalid", "empty", "unsafe", "oversized"}.contains(it.key()) && count(it.value());
                for (auto it = dropped.begin(); it != dropped.end(); ++it)
                    valid = valid && droppedFields.contains(it.key()) && count(it.value());
            } else if (operation == "import") {
                valid = valid && exactKeys({"revision", "world_book_id", "book_name", "imported_entry_count"}) &&
                    count(r["revision"], 2147483647) && r["revision"].toInt() == revision + 1 &&
                    r["world_book_id"].isString() && !r["world_book_id"].toString().isEmpty() &&
                    r["book_name"].isString() && r["book_name"].toString() == details.value("book_name").toString() &&
                    count(r["imported_entry_count"]) && r["imported_entry_count"].toInt() == details.value("importable_entry_count").toInt();
            } else {
                valid = valid && exactKeys({"world_book_id", "book_name", "entry_count", "file_name", "bytes", "sha256"}) &&
                    r["world_book_id"] == bookId && r["book_name"].isString() &&
                    r["book_name"].toString() == exportedBook.value("name").toString() &&
                    count(r["entry_count"]) && r["entry_count"].toInt() > 0 &&
                    r["entry_count"].toInt() == exportedBook.value("entries").toList().size() &&
                    r["file_name"].isString() && r["file_name"].toString() == QFileInfo(path).fileName() &&
                    count(r["bytes"], 5 * 1024 * 1024) && r["bytes"].toInt() > 0 && digest(r["sha256"]);
            }
            if (!valid) { unknownWorldbookFile(); return; }
            for (auto it = r.begin(); it != r.end(); ++it)
                if (!QStringList{"kind", "schema", "type", "requestId", "ok"}.contains(it.key()))
                    details[it.key()] = it.value().toVariant();
            if (operation == "inspect")
                setWorldbookFileState("confirmation", "请确认导入内容。", details);
            else if (operation == "import") {
                m_worldbookFilePath.clear();
                setWorldbookFileState("imported", "世界书已导入，正在重新读取并选择新书…", details);
            } else {
                m_worldbookFilePath.clear();
                setWorldbookFileState("success", QString("已导出到 %1，共 %2 条，%3 字节。")
                    .arg(r["file_name"].toString()).arg(r["entry_count"].toInt()).arg(r["bytes"].toInt()), details);
            }
        }, 30000);
    if (serial == m_worldbookFileSerial && !id.isEmpty() && m_worldbookFileState.value("status") == status) {
        m_worldbookFileState["requestId"] = id;
        emit changed();
    }
}
void RuntimeBridge::acknowledgeWorldbookFileImportReadback(const QString &bookId, int revision, bool confirmed) {
    if (m_worldbookFileState.value("status") != "imported") return;
    bool found = false;
    for (const auto &value : m_archive.value("archive").toMap().value("worldBooks").toList())
        found = found || value.toMap().value("id").toString() == bookId;
    const bool valid = confirmed && found && worldbookFileContextMatches(revision) &&
        m_worldbookFilePersona == m_persona && m_worldbookFileState.value("generation").toInt() == m_generation &&
        m_worldbookFileState.value("world_book_id").toString() == bookId &&
        m_worldbookFileState.value("revision").toInt() == revision;
    if (!valid) { unknownWorldbookFile(); return; }
    auto details = m_worldbookFileState;
    details["readbackRevision"] = revision;
    details["selectedWorldBookId"] = bookId;
    setWorldbookFileState("success", "世界书已导入并重新读取，当前已选中新书。", details);
}
void RuntimeBridge::importPersonaCard() {
    if (!personaCardActionAllowed())
        return;
    if (m_personaCardJson.isEmpty() || m_personaCardCandidate.value("scopeKey").toString() != scopeKey()) {
        clearPersonaCardCandidate();
        setPersonaCardFeedback("error", "角色卡预览已失效，请重新选择文件。");
        return;
    }
    const auto candidate = m_personaCardCandidate;
    const auto id = request("persona:import", {{"json", m_personaCardJson},
        {"filename", candidate.value("filename")}, {"identity_change_confirmed", true},
        {"actor", "owner"}, {"reason", "用户通过原生角色面板确认导入并切换"}});
    clearPersonaCardCandidate();
    if (id.isEmpty()) {
        setPersonaCardFeedback("error", "角色卡导入请求未能发送；请重新选择文件后核对连接。");
        return;
    }
    m_personaImport = {{"requestId", id}, {"targetId", candidate.value("targetId")},
                      {"targetName", candidate.value("name")},
                      {"sourceProof", m_persona.toVariantMap()}, {"generation", m_generation}};
    m_personaImportReceipt = {};
    setPersonaCardFeedback("pending", "正在导入角色卡并切换身份…", id);
}
void RuntimeBridge::chooseSummaryFile(const QUrl &url) {
    m_legacyContent.clear();
    m_legacySha.clear();
    m_state.remove("importPreview");
    QFile f(url.toLocalFile());
    if (!f.open(QIODevice::ReadOnly) || f.size() > 131072) {
        setNotice("请选择不超过 128 KiB 的 UTF-8 摘要文件。");
        setMemoryFeedback("legacy", "error", "请选择不超过 128 KiB 的 UTF-8 摘要文件。");
        return;
    }
    auto b = f.readAll();
    if (b.isEmpty() || QString::fromUtf8(b).toUtf8() != b) {
        setNotice("摘要文件不是有效 UTF-8。");
        setMemoryFeedback("legacy", "error", "摘要文件为空或不是有效 UTF-8，没有读取任何内容。");
        return;
    }
    m_legacyContent = QString::fromUtf8(b);
    m_legacyGeneration = m_generation;
    const auto id = request("summary:legacy:preview", {{"content", m_legacyContent}});
    setMemoryFeedback("legacy", id.isEmpty() ? "error" : "pending",
                      id.isEmpty() ? "本地服务尚未连接，没有读取旧摘要。" : "正在核对旧摘要文件…", id);
}
void RuntimeBridge::confirmSummaryImport() {
    if (m_legacySha.isEmpty() || m_legacyGeneration != m_generation || memoryRequestPending("legacy"))
        return;
    const auto id = request("summary:legacy:import", {{"content", m_legacyContent},
                                                      {"expected_sha256", m_legacySha},
                                                      {"confirmed", true}});
    if (!id.isEmpty())
        setMemoryFeedback("legacy", "pending", "正在加密隔离保存旧摘要…", id);
}
void RuntimeBridge::invalidateMemoryRecall(bool clearInput, const QString &status,
                                            const QString &text) {
    // Forgetting this request is local only. The service may still finish it;
    // without this association its late result cannot repopulate the page.
    if (!m_memoryRecallId.isEmpty())
        m_pending.remove(m_memoryRecallId);
    m_memoryRecallId.clear();
    m_memoryRecallGeneration = -1;
    m_memoryRecallPersona = {};
    const int inputEpoch = m_memoryRecallState.value("inputEpoch").toInt() + (clearInput ? 1 : 0);
    m_memoryRecallState = {{"status", status}, {"text", text}, {"requestId", ""},
        {"submittedQuery", ""}, {"results", QStringList{}}, {"mode", "unknown"},
        {"reason", ""}, {"indexPending", QVariant()}, {"inputEpoch", inputEpoch},
        {"scopeKey", ""}, {"generation", -1}};
}
void RuntimeBridge::clearMemoryRecall() {
    invalidateMemoryRecall(true);
    emit changed();
}
void RuntimeBridge::invalidateSummaryDetail(const QString &status, const QString &feedback) {
    // Removing the local association does not cancel or create backend work.
    // A late reply can no longer fill this page, even after another selection.
    m_pending.remove(m_summaryDetailId);
    m_summaryDetailId.clear();
    m_summaryDetailPersona = {};
    m_summaryDetailMetadata = {};
    m_summaryDetailGeneration = -1;
    m_summaryDetailState = {{"status", status}, {"summaryId", ""}, {"text", ""},
        {"requestId", ""}, {"conversationId", "dream-room"}, {"feedback", feedback}};
}
void RuntimeBridge::failSummaryDetail(const QString &feedback) {
    m_pending.remove(m_summaryDetailId);
    m_summaryDetailId.clear();
    m_summaryDetailState["status"] = "error";
    m_summaryDetailState["text"] = "";
    m_summaryDetailState["feedback"] = feedback;
    for (const auto &field : {"sourceDigest", "firstSequence", "lastSequence", "messageIds", "contractVersion"})
        m_summaryDetailState.remove(field);
}
void RuntimeBridge::invalidateSummaryDirectory() {
    m_summaryStatusReadId.clear();
    m_summaryDirectory = {};
    m_summaryDirectoryPersona = {};
    m_summaryDirectoryGeneration = -1;
    if (m_state.contains("summary")) {
        auto summary = m_state.value("summary").toMap();
        summary.insert({{"summaries", QVariantList{}}, {"summaryTotal", 0}, {"hasMore", false},
            {"conversation_id", "dream-room"}, {"directoryReady", false},
            {"directoryFeedback", "摘要目录尚未读取，请刷新目录。"}});
        m_state["summary"] = summary;
    }
}
bool RuntimeBridge::summaryDirectoryCurrent() const {
    return m_connected && !m_stopping && m_summaryDirectoryGeneration == m_generation &&
        m_summaryDirectoryPersona == m_persona;
}
QVariantMap RuntimeBridge::summaryStatusSnapshot(const QJsonObject &payload) {
    // Preserve the existing status/switch contract, while admitting only bounded
    // metadata to its directory. No body can enter this shared status map.
    QVariantMap snapshot;
    for (const auto &field : {"ok", "operation", "status", "enabled", "consent_effective", "authorized",
             "running", "cleanup_confirmed", "cleanup_error", "errorCode", "attempts", "lastAttempt",
             "activeCount", "legacyInactiveCount", "cooldownSeconds", "sourceDiagnostics",
             "cooldownRemainingSeconds", "pendingBudget", "persona_id", "persona_epoch", "persona_fingerprint"})
        if (payload.contains(field))
            snapshot[field] = payload[field].toVariant();
    const auto rows = payload["summaries"].toArray();
    const auto total = payload["summaryTotal"];
    bool valid = payload["ok"].isBool() && payload["ok"].toBool() && !payload.contains("error") &&
        payload["operation"] == "status" && payload["summaries"].isArray() && rows.size() <= 100 &&
        summarySequenceValid(total, true) && payload["hasMore"].isBool() &&
        rows.size() == qMin<qint64>(100, total.toInteger()) &&
        payload["hasMore"].toBool() == (total.toInteger() > 100) &&
        (!payload.contains("conversation_id") || payload["conversation_id"] == "dream-room");
    QJsonObject directory;
    QJsonArray bounded;
    if (valid) {
        for (const auto &row : rows) {
            const auto metadata = row.isObject() ? summaryMetadata(row.toObject()) : QJsonObject{};
            const auto id = metadata["summary_id"].toString();
            if (metadata.isEmpty() || directory.contains(id)) {
                valid = false;
                break;
            }
            directory[id] = metadata;
            bounded.append(metadata);
        }
    }
    m_summaryDirectory = valid ? directory : QJsonObject{};
    m_summaryDirectoryPersona = valid ? m_persona : QJsonObject{};
    m_summaryDirectoryGeneration = valid ? m_generation : -1;
    snapshot.insert({{"summaries", valid ? bounded.toVariantList() : QVariantList{}},
        {"summaryTotal", valid ? QVariant::fromValue(total.toInteger()) : QVariant(0)},
        {"hasMore", valid && payload["hasMore"].toBool()}, {"conversation_id", "dream-room"},
        {"directoryReady", valid},
        {"directoryFeedback", valid ? QString() : QString("摘要目录读取失败，请刷新后重试。")}});
    const auto selected = m_summaryDetailState.value("summaryId").toString();
    if (!selected.isEmpty() && (!valid || m_summaryDetailGeneration != m_generation ||
        m_summaryDetailPersona != m_persona ||
        m_summaryDirectory.value(selected).toObject() != m_summaryDetailMetadata))
        invalidateSummaryDetail("error", "所选摘要已不在当前目录或来源已变化，正文已清除；请重新选择。");
    return snapshot;
}
void RuntimeBridge::clearSummaryDetail() {
    invalidateSummaryDetail();
    emit changed();
}
void RuntimeBridge::refreshSummaryDirectory() {
    if (!m_connected || m_stopping) {
        invalidateSummaryDirectory();
        invalidateSummaryDetail("error", "本地服务尚未连接，请重新连接后刷新摘要目录。");
        emit changed();
        return;
    }
    if (personaChanging() || m_pending.contains(m_summaryStatusReadId))
        return;
    request("summary:status", {{"conversation_id", "dream-room"}});
}
void RuntimeBridge::readSummaryDetail(const QString &summaryId) {
    if (summaryId == m_summaryDetailState.value("summaryId").toString() &&
        m_summaryDetailState.value("status").toString() == "pending" &&
        m_pending.contains(m_summaryDetailId) && m_summaryDetailGeneration == m_generation &&
        m_summaryDetailPersona == m_persona)
        return;
    invalidateSummaryDetail();
    if (!summaryIdValid(summaryId)) {
        m_summaryDetailState["status"] = "error";
        m_summaryDetailState["feedback"] = "摘要编号无效，请从当前目录选择一段摘要。";
    } else if (!m_connected || m_stopping || personaChanging()) {
        m_summaryDetailState["status"] = "error";
        m_summaryDetailState["feedback"] = personaChanging()
            ? "人格操作仍在核对中，请等待确认后再读取摘要。"
            : "本地服务尚未连接，请重新连接后刷新摘要目录。";
    } else if (!summaryDirectoryCurrent() || !m_summaryDirectory.contains(summaryId)) {
        m_summaryDetailState["status"] = "error";
        m_summaryDetailState["feedback"] = "这段摘要不在当前目录，请刷新目录后重新选择。";
    } else {
        m_summaryDetailGeneration = m_generation;
        m_summaryDetailPersona = m_persona;
        m_summaryDetailMetadata = m_summaryDirectory.value(summaryId).toObject();
        m_summaryDetailState.insert({{"status", "pending"}, {"summaryId", summaryId},
            {"feedback", "正在读取本地摘要正文…"}});
        // Only this explicit selection may dispatch a summary:get. It is a read
        // even while writes, network calls or new summary generation are paused.
        m_summaryDetailSending = true;
        const auto id = request("summary:get", {{"conversation_id", "dream-room"}, {"summary_id", summaryId}});
        m_summaryDetailSending = false;
        if (id.isEmpty())
            failSummaryDetail("摘要正文请求未能发送；未自动重试，请核对连接后重新读取。");
    }
    emit changed();
}
void RuntimeBridge::applySummaryDetail(const QString &type, const QJsonObject &payload,
                                       const QString &requestId) {
    if (requestId != m_summaryDetailId || m_summaryDetailGeneration != m_generation ||
        m_summaryDetailPersona != m_persona || !summaryDirectoryCurrent())
        return;
    const auto summary = payload["summary"].toObject();
    const auto metadata = summaryMetadata(summary, true);
    const auto selected = m_summaryDetailState.value("summaryId").toString();
    const auto text = summary["text"].toString();
    const bool valid = type == "summary:result" && payload["ok"].isBool() && payload["ok"].toBool() &&
        !payload.contains("error") && payload["operation"] == "detail" &&
        payload["conversation_id"] == "dream-room" && payload.contains("persona_id") &&
        payload.contains("persona_epoch") && payload.contains("persona_fingerprint") &&
        payload["persona_id"] == m_persona["persona_id"] &&
        payload["persona_epoch"] == m_persona["epoch"] &&
        payload["persona_fingerprint"] == m_persona["fingerprint"] && payload["summary"].isObject() &&
        !metadata.isEmpty() && metadata["summary_id"].toString() == selected &&
        metadata == m_summaryDetailMetadata && m_summaryDirectory.value(selected).toObject() == metadata &&
        summary["text"].isString() && text.isValidUtf16() && !text.trimmed().isEmpty() &&
        text.toUcs4().size() <= 1000;
    if (!valid) {
        failSummaryDetail("摘要正文读取失败或内容已变化；请刷新目录后重新读取，未自动重试。");
    } else {
        m_summaryDetailId.clear();
        m_summaryDetailState.insert({{"status", "success"}, {"text", text}, {"feedback", "摘要正文已读取。"}});
        for (auto it = metadata.begin(); it != metadata.end(); ++it)
            if (it.key() != "summary_id")
                m_summaryDetailState[it.key()] = it.value().toVariant();
    }
    emit changed();
}
QString RuntimeBridge::memoryPagingFingerprint() const {
    const auto list = m_state.value("memory").toMap();
    QJsonArray ids;
    for (const auto &value : list.value("memories").toList())
        ids.append(value.toMap().value("id").toString());
    const QJsonObject paging{{"ids", ids}, {"query", m_memoryQuery},
        {"shownQuery", list.value("query").toString()}, {"listQuery", m_memoryListQuery},
        {"hasMore", list.value("hasMore").toBool()}, {"cursor", m_memoryCursor},
        {"listId", m_memoryListId}, {"moreId", m_memoryMoreId},
        {"receiptId", m_memoryFeedback.value("list").toMap().value("requestId").toString()},
        {"live", m_memoryListLive}, {"scopeKey", scopeKey()}, {"generation", m_generation}};
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(paging).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
QString RuntimeBridge::candidatePagingFingerprint() const {
    QJsonArray ids;
    for (const auto &row : m_state.value("candidates").toMap().value("candidates").toList())
        ids.append(row.toMap().value("id").toString());
    const QJsonObject paging{{"ids", ids}, {"start", m_candidateStartCursor},
        {"next", m_candidateNextCursor}, {"readStart", m_candidateReadStartCursor},
        {"readId", m_candidateReadId}, {"lastReadId", m_candidateLastReadId}, {"readKind", m_candidateReadKind},
        {"page", m_candidatePageNumber}, {"readPage", m_candidateReadPageNumber},
        {"hasMore", m_candidateHasMore}, {"live", m_candidateLive},
        {"needsRefresh", m_candidateNeedsRefresh}, {"revision", m_candidateRevision},
        {"scope", m_candidateScope}, {"generation", m_candidateGeneration}};
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(paging).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
void RuntimeBridge::queryRelatedMemories(const QString &text) {
    if (!m_memoryRecallId.isEmpty())
        return;
    const auto query = text.trimmed();
    // QString::size counts UTF-16 units; astral characters such as emoji are
    // one Unicode code point in the backend's 2,000-character contract.
    const auto length = query.toUcs4().size();
    invalidateMemoryRecall(false);
    if (length < 1 || length > 2000) {
        m_memoryRecallState["status"] = "error";
        m_memoryRecallState["text"] = "请输入 1–2000 个字符的内容后查询关联回忆。";
        emit changed();
        return;
    }
    if (!m_connected || personaChanging()) {
        m_memoryRecallState["status"] = "error";
        m_memoryRecallState["text"] = !m_connected ? "本地服务尚未连接，关联回忆未能发送；输入已保留。"
                                                   : "人格操作仍在核对中，请等待确认后再查询关联回忆。";
        emit changed();
        return;
    }
    // This read remains available while network calls or recovery writes are
    // paused. A degraded service reports its own explicit read failure.
    const auto id = request("memory:query", {{"query", query}, {"top_k", 10}});
    if (id.isEmpty()) {
        m_memoryRecallState["status"] = "error";
        m_memoryRecallState["text"] = "关联回忆请求未能发送，输入已保留；未自动重试。";
        emit changed();
        return;
    }
    m_memoryRecallId = id;
    m_memoryRecallGeneration = m_generation;
    m_memoryRecallPersona = m_persona;
    m_memoryRecallState.insert({{"status", "pending"}, {"text", "正在查询本地关联回忆…"},
        {"requestId", id}, {"submittedQuery", query}, {"scopeKey", scopeKey()},
        {"generation", m_generation}});
    emit changed();
}
void RuntimeBridge::applyMemoryRecall(const QString &type, const QJsonObject &payload,
                                       const QString &requestId) {
    if (requestId != m_memoryRecallId || m_memoryRecallGeneration != m_generation ||
        m_memoryRecallPersona != m_persona)
        return;
    m_memoryRecallId.clear();
    m_memoryRecallGeneration = -1;
    m_memoryRecallPersona = {};
    const auto fail = [this] {
        m_memoryRecallState["status"] = "error";
        m_memoryRecallState["text"] = "关联回忆读取失败，输入已保留；未自动重试。";
        emit changed();
    };
    if (type != "memory:result" || payload.contains("error") ||
        (payload.contains("ok") && (!payload["ok"].isBool() || !payload["ok"].toBool())) ||
        !payload["memories"].isArray()) {
        fail();
        return;
    }
    const auto memories = payload["memories"].toArray();
    QStringList results;
    qsizetype total = 0;
    if (memories.size() > 20) {
        fail();
        return;
    }
    for (const auto &value : memories) {
        if (!value.isString()) {
            fail();
            return;
        }
        const auto result = value.toString();
        total += result.toUcs4().size();
        if (total > 5400) {
            fail();
            return;
        }
        results.append(result);
    }
    // Metadata is advisory and independently validated. Missing or mismatched
    // metadata never upgrades a successful read to a claimed retrieval path.
    QString mode = "unknown", reason;
    QVariant indexPending;
    const auto retrieval = payload["retrieval"].toObject();
    const auto offeredMode = retrieval["mode"].toString();
    const auto offeredReason = retrieval["reason"].toString();
    const auto pending = retrieval["indexPending"];
    const bool validPending = pending.isNull() ||
        (pending.isDouble() && pending.toDouble() >= 0 && pending.toInteger(-1) >= 0 &&
         double(pending.toInteger(-1)) == pending.toDouble());
    const bool validPair = (offeredMode == "hybrid" && offeredReason == "vector_search_completed") ||
        (offeredMode == "lexical_fallback" &&
         QStringList{"model_unavailable", "index_unavailable"}.contains(offeredReason)) ||
        (offeredMode == "unknown" &&
         QStringList{"vector_search_failed", "retrieval_path_unverified"}.contains(offeredReason));
    if (payload["retrieval"].isObject() && validPair && validPending) {
        mode = offeredMode;
        reason = offeredReason;
        if (!pending.isNull())
            indexPending = pending.toInteger();
    }
    m_memoryRecallState.insert({{"status", results.isEmpty() ? "empty" : "success"},
        {"text", results.isEmpty() ? "本次查询没有返回关联回忆。"
                                   : QString("本次查询返回 %1 条关联回忆。").arg(results.size())},
        {"results", results}, {"mode", mode}, {"reason", reason}, {"indexPending", indexPending}});
    emit changed();
}
void RuntimeBridge::refreshMemories() {
    const auto pinStatus = m_memoryBatchPin.value("status").toString();
    if (pinStatus == "unknown") {
        readMemoryBatchPin(true);
        return;
    }
    if (m_candidateBatch.value("status").toString() == "unknown") {
        readCandidateBatch(true);
        return;
    }
    if (memoryBatchPinBlocked() || candidateBatchBlocked())
        return;
    const auto status = m_memoryBatchDelete.value("status").toString();
    if (status == "sending" || status == "pending")
        return;
    if (status == "unknown" && m_connected) {
        if (m_pending.contains(m_memoryBatchDelete.value("manualReadId").toString()))
            return;
        // Never reuse a read dispatched before the explicit manual refresh.
        m_memoryBatchDelete["readScope"] = scopeKey();
        m_memoryBatchDelete["readGeneration"] = m_generation;
        m_memoryBatchDelete["manualReadId"] = startMemoryList();
    }
    readMemories(false);
}
void RuntimeBridge::readMemories(bool afterChange) {
    if (memoryBatchPinBlocked() || candidateBatchBlocked())
        return;
    if (!m_connected) {
        setMemoryFeedback("list", "error", "本地服务尚未连接，暂时无法读取记忆。");
        return;
    }
    if (QStringList{"sending", "pending"}.contains(m_memoryBatchDelete.value("status").toString()))
        return;
    if (candidateDecisionLocked() && !afterChange) {
        if (m_candidateDecision.value("status").toString() == "unknown")
            reconcileCandidateDecision(true);
        return;
    }
    if (afterChange && candidateDecisionLocked())
        unknownCandidateDecision("数据已变化，候选决定尚未完整核对；请手动刷新核对，未自动重试。");
    // A read already in flight may predate the change, so a post-change read
    // is always sent; its newer receipt supersedes the older one. A change or a
    // refresh starts again from the first page of the current filter.
    if (afterChange || !m_pending.contains(m_memoryListId))
        startMemoryList();
    if (afterChange || !m_pending.contains(m_candidateReadId) || m_candidateReadKind == "next") {
        if (afterChange || m_candidateReadKind == "next")
            m_pending.remove(m_candidateReadId);
        startCandidatePage("first", {}, 1);
    }
}
namespace {
constexpr int memoryPageSize = 100;
// Rows past this are reached through the filter; the page has no list virtualization.
constexpr int memoryListCap = 500;
constexpr int candidatePageSize = 100;
constexpr int candidatePayloadBytes = 900000;
QString cursorDigest(const QString &cursor) {
    return QString::fromLatin1(QCryptographicHash::hash(cursor.toUtf8(), QCryptographicHash::Sha256).toHex());
}
bool validCandidateCursor(const QString &cursor) {
    static const QRegularExpression pattern("\\Amc1\\.[A-Za-z0-9_-]+\\z");
    return cursor.size() >= 5 && cursor.size() <= 512 && pattern.match(cursor).hasMatch();
}
bool candidateBefore(const QVariantMap &newer, const QVariantMap &older) {
    const double a = newer.value("created_at").toDouble();
    const double b = older.value("created_at").toDouble();
    return a > b || (a == b && newer.value("id").toString() > older.value("id").toString());
}
bool visibleMemoryQuery(const QString &text) {
    for (const auto ch : text)
        if (ch.unicode() < 32 || ch.unicode() == 127)
            return false;
    return text.size() <= 100;
}
QString memoryListText(int count, bool hasMore, bool capped, const QString &query) {
    if (capped)
        return QString("已显示 %1 条，请用筛选缩小范围。").arg(count);
    if (query.isEmpty())
        return count == 0 ? QString("还没有已确认的记忆。")
               : hasMore  ? QString("已显示 %1 条已确认的记忆，可以加载更多。").arg(count)
                          : QString("共 %1 条已确认的记忆。").arg(count);
    return count == 0 ? QString("没有包含“%1”的记忆。").arg(query)
           : hasMore  ? QString("已显示 %1 条包含“%2”的记忆，可以加载更多。").arg(count).arg(query)
                      : QString("找到 %1 条包含“%2”的记忆。").arg(count).arg(query);
}
} // namespace
QString RuntimeBridge::startCandidatePage(const QString &kind, const QString &startCursor, int pageNumber) {
    if (!m_connected || m_pending.contains(m_candidateReadId))
        return {};
    m_candidateReadId.clear();
    m_candidateReadGeneration = -1;
    m_candidateReadPersona = {};
    m_candidateReadBoundary.clear();
    QVariantMap payload{{"status", "pending"}, {"limit", candidatePageSize}};
    if (!startCursor.isEmpty())
        payload["cursor"] = startCursor;
    const auto id = request("memory:candidates:list", payload);
    if (id.isEmpty())
        return {};
    m_candidateReadId = id;
    m_candidateLastReadId = id;
    m_candidateReadStartCursor = startCursor;
    m_candidateReadKind = kind;
    m_candidateReadPageNumber = pageNumber;
    m_candidateReadGeneration = m_generation;
    m_candidateReadPersona = m_persona;
    m_candidateReadBoundary.clear();
    const auto rows = m_state.value("candidates").toMap().value("candidates").toList();
    if (kind == "next" && !rows.isEmpty()) {
        const auto last = rows.last().toMap();
        m_candidateReadBoundary = {{"id", last.value("id")}, {"created_at", last.value("created_at")}};
    } else if (kind == "reread") {
        m_candidateReadBoundary = m_candidateStartBoundary;
    }
    setMemoryFeedback("candidates", "pending", kind == "next" ? "正在读取下一批待确认内容…"
        : kind == "reread" ? "正在核对本批待确认内容…" : "正在读取待确认内容…", id);
    return id;
}
void RuntimeBridge::loadNextMemoryCandidates() {
    const auto page = memoryCandidatePage();
    if (memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked() || !m_connected ||
        page.value("busy").toBool() || page.value("blocked").toBool() ||
        !m_candidateHasMore || !validCandidateCursor(m_candidateNextCursor))
        return;
    startCandidatePage("next", m_candidateNextCursor, m_candidatePageNumber + 1);
}
void RuntimeBridge::firstMemoryCandidates() {
    if (m_candidateBatch.value("status").toString() == "unknown") {
        readCandidateBatch(true);
        return;
    }
    if (memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked() || !m_connected ||
        memoryCandidatePage().value("decisionBusy").toBool())
        return;
    if (candidateDecisionLocked()) {
        if (m_candidateDecision.value("status").toString() == "unknown")
            reconcileCandidateDecision(true);
        return;
    }
    if (m_pending.contains(m_candidateReadId)) {
        if (m_candidateReadKind == "first")
            return;
        m_pending.remove(m_candidateReadId);
    }
    startCandidatePage("first", {}, 1);
}
bool RuntimeBridge::applyCandidatePage(const QString &type, const QJsonObject &payload,
                                      bool failed, const QString &requestId) {
    if (requestId != m_candidateReadId || m_candidateReadGeneration != m_generation ||
        m_candidateReadPersona != m_persona)
        return false;
    const auto settle = qScopeGuard([this] {
        m_candidateReadId.clear();
        m_candidateReadGeneration = -1;
        m_candidateReadPersona = {};
        m_candidateReadBoundary.clear();
    });
    const auto fail = [this, &requestId](bool stop) {
        if (stop)
            m_candidateNeedsRefresh = true;
        setMemoryFeedback("candidates", "error", stop
            ? "待确认列表已变化，已停止翻页；请刷新。"
            : "本批读取失败；已显示的批次和位置保留，请稍后刷新核对。", requestId);
        return false;
    };
    if (type != "memory:candidates:result" || failed || payload.contains("error"))
        return fail(payload["error_code"].toString() == "invalid_cursor");
    if (!payload["ok"].isBool() || !payload["ok"].toBool() ||
        payload["status"].toString() != "pending" || !payload["candidates"].isArray() ||
        !payload["has_more"].isBool() ||
        QJsonDocument(payload).toJson(QJsonDocument::Compact).size() > candidatePayloadBytes)
        return fail(true);
    const auto offered = payload["candidates"].toArray();
    const bool hasMore = payload["has_more"].toBool();
    const auto next = payload["next_cursor"];
    if (offered.size() > candidatePageSize || (offered.isEmpty() && hasMore) ||
        (hasMore && (!next.isString() || !validCandidateCursor(next.toString()) ||
                     next.toString() == m_candidateReadStartCursor)) ||
        (!hasMore && !next.isNull()))
        return fail(true);
    QSet<QString> ids;
    if (m_candidateReadKind == "next")
        for (const auto &row : m_state.value("candidates").toMap().value("candidates").toList())
            ids.insert(row.toMap().value("id").toString());
    QVariantList rows;
    auto previous = m_candidateReadBoundary;
    static const QRegularExpression candidateId("\\Amc_[a-f0-9]{32}\\z");
    for (const auto &value : offered) {
        const auto row = value.toObject();
        const auto id = row["id"].toString();
        if (!value.isObject() || !candidateId.match(id).hasMatch() || ids.contains(id) ||
            !row["created_at"].isDouble() || !std::isfinite(row["created_at"].toDouble()) ||
            row["status"].toString() != "pending" ||
            !row["proposed_text"].isString() ||
            (row.contains("source_text") && !row["source_text"].isString()))
            return fail(true);
        const auto item = row.toVariantMap();
        if (!previous.isEmpty() && !candidateBefore(previous, item))
            return fail(true);
        ids.insert(id);
        rows.append(item);
        previous = item;
    }
    if (m_candidateReadKind == "reread" &&
        m_candidateDecision.value("status").toString() == "reading")
        for (const auto &row : rows)
            if (row.toMap().value("id") == m_candidateDecision.value("subjectId"))
                return fail(true);
    // Commit only a complete, correlated page. The old batch is never extended.
    m_candidateStartCursor = m_candidateReadStartCursor;
    m_candidateStartBoundary = m_candidateReadBoundary;
    m_candidateNextCursor = hasMore ? next.toString() : QString();
    m_candidatePageNumber = m_candidateReadPageNumber;
    m_candidateGeneration = m_generation;
    m_candidateScope = scopeKey();
    m_candidateHasMore = hasMore;
    m_candidateLive = true;
    m_candidateNeedsRefresh = m_candidateDecision.value("status").toString() == "unknown";
    ++m_candidateRevision;
    m_state["candidates"] = QVariantMap{{"ok", true}, {"status", "pending"}, {"candidates", rows}};
    QString text;
    if (rows.isEmpty())
        text = m_candidatePageNumber > 1 ? "这一批已处理完，没有更早的候选" : "没有待确认的候选";
    else if (!hasMore)
        text = "没有更早的候选";
    if (m_candidateDecision.value("status").toString() == "unknown")
        text = "候选决定尚未完整核对；请手动刷新核对后继续。";
    setMemoryFeedback("candidates", "success", text, requestId);
    return true;
}
void RuntimeBridge::unknownCandidateDecision(const QString &text) {
    if (!candidateDecisionLocked())
        return;
    // The user must reconcile by reading. A later receipt/timer of this
    // mutation cannot replace that reconciliation or authorize a resend.
    m_pending.remove(m_candidateDecision.value("requestId").toString());
    const auto listReadId = m_candidateDecision.value("listReadId").toString();
    if (!listReadId.isEmpty() && m_pending.remove(listReadId)) {
        if (m_memoryListId == listReadId)
            m_memoryListId.clear();
        setMemoryFeedback("list", "unknown", "当前记忆尚未完整读回；请手动刷新核对。", listReadId);
    }
    const auto candidateReadId = m_candidateDecision.value("candidateReadId").toString();
    if (!candidateReadId.isEmpty() && m_pending.remove(candidateReadId)) {
        if (m_candidateReadId == candidateReadId) {
            m_candidateReadId.clear();
            m_candidateReadGeneration = -1;
            m_candidateReadPersona = {};
            m_candidateReadBoundary.clear();
        }
        setMemoryFeedback("candidates", "unknown", "本批尚未完整读回；已显示的批次保留，请手动刷新核对。", candidateReadId);
    }
    m_candidateDecision["status"] = "unknown";
    m_candidateDecision["listFresh"] = false;
    m_candidateDecision["candidatesFresh"] = false;
    m_candidateNeedsRefresh = true;
    const auto decisionId = m_candidateDecision.value("requestId").toString();
    if (m_memoryFeedback.value("action").toMap().value("requestId").toString() == decisionId)
        setMemoryFeedback("action", "unknown", text, decisionId,
            {{"verb", m_candidateDecision.value("verb")}, {"subjectId", m_candidateDecision.value("subjectId")}});
    else
        setMemoryFeedback("candidates", "unknown", text, m_candidateLastReadId);
}
void RuntimeBridge::reconcileCandidateDecision(bool manual) {
    if (!candidateDecisionLocked() || !m_connected ||
        (!manual && m_candidateDecision.value("status").toString() != "reading") ||
        (manual && m_candidateDecision.value("status").toString() != "unknown"))
        return;
    m_pending.remove(m_candidateReadId);
    m_candidateDecision["status"] = manual ? "reconciling" : "reading";
    m_candidateDecision["readGeneration"] = m_generation;
    m_candidateDecision["readScope"] = scopeKey();
    m_candidateDecision["manual"] = manual;
    m_candidateDecision["listFresh"] = false;
    m_candidateDecision["candidatesFresh"] = false;
    const auto listReadId = startMemoryList();
    m_candidateDecision["listReadId"] = listReadId;
    const auto candidateReadId = startCandidatePage(manual ? "first" : "reread", manual ? QString()
        : m_candidateDecision.value("startCursor").toString(), manual ? 1
        : m_candidateDecision.value("pageNumber").toInt());
    m_candidateDecision["candidateReadId"] = candidateReadId;
    if (listReadId.isEmpty() || candidateReadId.isEmpty())
        unknownCandidateDecision("候选决定的当前状态未能读取；请手动刷新核对，未自动重试。");
    emit changed();
}
void RuntimeBridge::candidateReadSettled(const QString &requestId, bool success) {
    const auto status = m_candidateDecision.value("status").toString();
    if (!QStringList{"reading", "reconciling"}.contains(status) ||
        m_candidateDecision.value("readGeneration").toInt() != m_generation ||
        m_candidateDecision.value("readScope").toString() != scopeKey())
        return;
    const bool list = requestId == m_candidateDecision.value("listReadId").toString();
    const bool candidates = requestId == m_candidateDecision.value("candidateReadId").toString();
    if (!list && !candidates)
        return;
    if (!success) {
        unknownCandidateDecision("候选决定尚未完整核对，当前批次已保留；请手动刷新核对，未自动重试。");
        return;
    }
    m_candidateDecision[list ? "listFresh" : "candidatesFresh"] = true;
    if (m_candidateDecision.value("listFresh").toBool() &&
        m_candidateDecision.value("candidatesFresh").toBool()) {
        const bool manual = m_candidateDecision.value("manual").toBool();
        const auto id = m_candidateDecision.value("requestId").toString();
        const auto verb = m_candidateDecision.value("verb");
        const auto subject = m_candidateDecision.value("subjectId");
        const bool receiptConfirmed = m_candidateDecision.value("receiptConfirmed").toBool();
        m_candidateDecision.clear();
        m_candidateNeedsRefresh = false;
        if (manual && m_memoryFeedback.value("action").toMap().value("requestId").toString() == id)
            setMemoryFeedback("action", "refreshed", receiptConfirmed
                ? "当前记忆和候选已刷新；先前决定的回执已收到，请按当前内容继续。"
                : "当前记忆和候选已刷新；先前决定的回执仍未知，请按当前内容继续。",
                              id, {{"verb", verb}, {"subjectId", subject}});
        else if (manual)
            setMemoryFeedback("candidates", "success", "当前记忆和候选已刷新；请按当前内容继续。", m_candidateLastReadId);
        emit changed();
    }
}
QString RuntimeBridge::startMemoryList() {
    QVariantMap payload{{"limit", memoryPageSize}};
    if (!m_memoryQuery.isEmpty())
        payload["query"] = m_memoryQuery;
    const auto id = request("memory:list", payload);
    if (id.isEmpty())
        return {};
    // A load-more of the list being replaced no longer counts.
    m_memoryListId = id;
    m_memoryListQuery = m_memoryQuery;
    m_memoryMoreId.clear();
    if (m_memoryPinListSending) {
        // QML observes the revision synchronously in setMemoryFeedback below.
        // Bind this replacement before it can clear the submitting selection.
        m_memoryBatchPin["listReadId"] = id;
        m_memoryBatchPin["listRevision"] = m_memoryListRevision + 1;
    }
    ++m_memoryListRevision;
    setMemoryFeedback("list", "pending", "正在读取记忆…", id);
    return id;
}
void RuntimeBridge::loadMoreMemories() {
    const auto list = m_state.value("memory").toMap();
    const int loaded = list.value("memories").toList().size();
    if (memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked() || !m_connected || !m_memoryListLive || !list.value("hasMore").toBool() || m_memoryCursor.isEmpty() ||
        m_pending.contains(m_memoryListId) || m_pending.contains(m_memoryMoreId) ||
        list.value("query").toString() != m_memoryQuery || loaded >= memoryListCap)
        return;
    QVariantMap payload{{"limit", qMin(memoryPageSize, memoryListCap - loaded)}, {"cursor", m_memoryCursor}};
    if (!m_memoryQuery.isEmpty())
        payload["query"] = m_memoryQuery;
    const auto id = request("memory:list", payload);
    if (id.isEmpty())
        return;
    m_memoryMoreId = id;
    setMemoryFeedback("list", "pending", "正在加载更多记忆…", id);
}
void RuntimeBridge::filterMemories(const QString &text) {
    if (memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked())
        return;
    if (candidateDecisionLocked() && m_candidateDecision.value("status").toString() != "unknown")
        return;
    const auto query = text.trimmed();
    if (!visibleMemoryQuery(query)) {
        setMemoryFeedback("list", "error", "筛选词不超过 100 字，且不能换行；记忆列表没有改动。");
        return;
    }
    if (!m_connected) {
        setMemoryFeedback("list", "error", "本地服务尚未连接，暂时无法读取记忆。");
        return;
    }
    m_memoryQuery = query;
    startMemoryList();
    emit changed();
}
void RuntimeBridge::applyMemoryPage(bool firstPage, const QString &type, const QJsonObject &payload,
                                    bool failed, const QString &requestId) {
    auto list = m_state.value("memory").toMap();
    QVariantList shown = firstPage ? QVariantList{} : list.value("memories").toList();
    const auto query = firstPage ? m_memoryListQuery : list.value("query").toString();
    if (firstPage)
        m_memoryListId.clear();
    else
        m_memoryMoreId.clear();
    const auto failText = firstPage ? QString("记忆读取失败，未改动任何记忆；可稍后刷新重试。")
                                    : QString("加载更多失败，已显示的记忆不变；可以重试。");
    // A cursor the service no longer accepts, or a page that repeats a shown
    // row, means the list changed underneath: stop instead of guessing.
    const auto stopLoading = [&] {
        list["hasMore"] = false;
        m_state["memory"] = list;
        m_memoryCursor.clear();
        setMemoryFeedback("list", "error", "记忆列表已变化，已停止加载；请刷新。", requestId);
    };
    if (type != "memory:result" || failed || !payload["memories"].isArray()) {
        if (!firstPage && payload["error_code"].toString() == "invalid_cursor")
            return stopLoading();
        setMemoryFeedback("list", "error", failText, requestId);
        return;
    }
    QSet<QString> ids;
    for (const auto &value : shown)
        ids.insert(value.toMap().value("id").toString());
    QVariantList page;
    bool valid = (!payload.contains("has_more") || payload["has_more"].isBool()) &&
                 (!payload.contains("query") || payload["query"].toString() == query);
    bool repeated = false;
    for (const auto &value : payload["memories"].toArray()) {
        const auto id = value.toObject().value("id").toString();
        if (!value.isObject() || id.isEmpty()) {
            valid = false;
            break;
        }
        repeated = repeated || ids.contains(id);
        ids.insert(id);
        page.append(value.toObject().toVariantMap());
    }
    const bool hasMore = payload["has_more"].toBool(false);
    const auto cursor = payload["next_cursor"].toString();
    if (hasMore && (!cursor.startsWith("v1.") || cursor.size() > 512))
        valid = false;
    if (!valid) {
        setMemoryFeedback("list", "error", failText, requestId);
        return;
    }
    if (repeated && !firstPage)
        return stopLoading();
    if (repeated) {
        setMemoryFeedback("list", "error", failText, requestId);
        return;
    }
    shown.append(page);
    const bool capped = hasMore && shown.size() >= memoryListCap;
    m_memoryCursor = hasMore && !capped ? cursor : QString();
    m_memoryListLive = true;
    m_state["memory"] = QVariantMap{{"ok", true},
                                    {"memories", shown},
                                    {"hasMore", hasMore && !capped},
                                    {"capped", capped},
                                    {"query", query},
                                    {"loaded", shown.size()}};
    setMemoryFeedback("list", "success", memoryListText(shown.size(), hasMore && !capped, capped, query), requestId);
}
bool RuntimeBridge::memoryAdjustmentPending() const {
    for (const auto &pending : m_pending)
        if (pending.generation == m_generation && pending.command == "memory:reinforce" &&
            pending.memoryAdjustment)
            return true;
    return false;
}
void RuntimeBridge::memoryAction(const QString &command, const QVariantMap &payload,
                                 const QString &verb, const QString &subjectId) {
    if (memoryAdjustmentPending() || memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked())
        return;
    if (!m_connected) {
        setMemoryFeedback("action", "error", "本地服务尚未连接，记忆没有改动。");
        return;
    }
    if (memoryRequestPending("action") || subjectId.isEmpty())
        return;
    const auto id = request(command, payload);
    if (id.isEmpty())
        return;
    setMemoryFeedback("action", "pending", "正在" + verb + "…", id,
                      {{"verb", verb}, {"subjectId", subjectId}});
}
void RuntimeBridge::editMemory(const QString &memoryId, const QString &text) {
    if (memoryAdjustmentPending() || memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked())
        return;
    const auto cleaned = text.trimmed();
    if (cleaned.isEmpty() || cleaned.size() > 2000) {
        setMemoryFeedback("action", "error", "修改内容不能为空，且不超过 2000 字；记忆没有改动。");
        return;
    }
    memoryAction("memory:edit", {{"memory_id", memoryId}, {"text", cleaned}}, "修改记忆", memoryId);
}
void RuntimeBridge::deleteMemory(const QString &memoryId) {
    memoryAction("memory:delete", {{"memory_id", memoryId}}, "删除记忆", memoryId);
}
void RuntimeBridge::deleteMemories(const QVariantList &memoryIds) {
    if (memoryBatchPinBlocked() || candidateBatchBlocked())
        return;
    if (memoryBatchDeleteBlocked()) {
        setNotice(m_memoryBatchDelete.value("status").toString() == "unknown"
            ? "批量删除结果未知，请手动刷新核对；未自动重试。" : "批量删除正在进行，请等待确认。");
        return;
    }
    const auto reject = [&](const QString &text) {
        setMemoryFeedback("action", "error", text);
    };
    // Keep the other operation's original receipt association intact.
    bool actionPending = memoryRequestPending("action");
    for (const auto &pending : m_pending)
        actionPending |= pending.generation == m_generation &&
            QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                        "memory:candidates:confirm", "memory:candidates:reject"}.contains(pending.command);
    if (actionPending) {
        setNotice("另一个记忆操作仍在进行，请等待确认后再批量删除。");
        return;
    }
    if (candidateDecisionLocked()) {
        setNotice("候选决定仍在核对中，请完成核对后再批量删除。");
        return;
    }
    if (!m_connected)
        return reject("本地服务尚未连接，记忆没有改动。");
    if (!runtimeWritable())
        return reject("当前为只读状态，记忆没有改动。");
    if (memoryIds.isEmpty() || memoryIds.size() > 100)
        return reject("每次请选择 1–100 条记忆；记忆没有改动。");
    QHash<QString, int> shown;
    for (const auto &value : m_state.value("memory").toMap().value("memories").toList())
        ++shown[value.toMap().value("id").toString()];
    static const QRegularExpression idPattern("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
    QSet<QString> ids;
    for (const auto &value : memoryIds) {
        const auto id = value.toString();
        if (value.metaType().id() != QMetaType::QString || !idPattern.match(id).hasMatch() ||
            ids.contains(id) || shown.value(id) != 1)
            return reject("所选记忆无效或不在当前列表中，请刷新后重新选择；记忆没有改动。");
        ids.insert(id);
    }
    m_memoryBatchDelete = {{"status", "sending"}, {"memoryIds", memoryIds},
        {"scopeKey", scopeKey()}, {"generation", m_generation}};
    const auto requestId = request("memory:delete_many", {{"memory_ids", memoryIds}});
    if (requestId.isEmpty()) {
        if (m_memoryBatchDelete.value("status").toString() != "unknown") {
            m_memoryBatchDelete.clear();
            reject("批量删除请求未能发送；记忆没有改动。");
        }
        return;
    }
    setMemoryFeedback("action", "pending", "正在批量删除记忆…", requestId,
        {{"verb", "批量删除记忆"}});
}
void RuntimeBridge::setMemoryPinned(const QString &memoryId, bool pinned) {
    memoryAction("memory:reinforce", {{"memory_id", memoryId}, {"op", pinned ? "pin" : "unpin"}},
                 pinned ? "固定记忆" : "取消固定", memoryId);
}
void RuntimeBridge::adjustMemory(const QString &memoryId, const QString &op) {
    if (!QStringList{"strengthen", "weaken", "reactivate"}.contains(op) ||
        memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked() ||
        candidateDecisionLocked() || memoryRequestPending("action") || personaChanging() || m_stopping)
        return;
    for (const auto &pending : m_pending)
        if (pending.generation == m_generation &&
            QStringList{"memory:edit", "memory:delete", "memory:reinforce", "memory:delete_many",
                        "memory:pin_many", "memory:candidates:confirm", "memory:candidates:reject",
                        "memory:candidates:decide_many"}.contains(pending.command))
            return;
    if (!m_connected) {
        setMemoryFeedback("action", "error", "本地服务尚未连接，记忆没有改动。");
        return;
    }
    if (!runtimeWritable()) {
        setMemoryFeedback("action", "error", "当前为只读状态，记忆没有改动。");
        return;
    }
    static const QRegularExpression idPattern("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
    int matches = 0;
    for (const auto &value : m_state.value("memory").toMap().value("memories").toList())
        matches += value.toMap().value("id").toString() == memoryId;
    if (!idPattern.match(memoryId).hasMatch() || matches != 1) {
        setMemoryFeedback("action", "error", "所选记忆无效或不在当前列表中，请刷新后重新选择；记忆没有改动。");
        return;
    }
    const auto verb = op == "strengthen" ? QString("强化") : op == "weaken" ? QString("弱化") : QString("重温");
    m_memoryAdjustDispatch = {{"memoryId", memoryId}, {"op", op},
        {"generation", m_generation}, {"scopeKey", scopeKey()}};
    const auto clearDispatch = qScopeGuard([this] { m_memoryAdjustDispatch.clear(); });
    const auto id = request("memory:reinforce", {{"memory_id", memoryId}, {"op", op}});
    if (id.isEmpty())
        return;
    setMemoryFeedback("action", "pending", "正在" + verb + "…", id,
        {{"verb", verb}, {"subjectId", memoryId}, {"memoryId", memoryId}, {"op", op},
         {"adjustmentOp", op}, {"generation", m_generation}, {"scopeKey", scopeKey()}});
}
void RuntimeBridge::decideMemoryCandidate(const QString &candidateId, bool confirm) {
    const auto page = memoryCandidatePage();
    if (memoryBatchPinBlocked() || candidateBatchBlocked() || memoryBatchDeleteBlocked() || page.value("busy").toBool() ||
        candidateDecisionLocked() || memoryRequestPending("action"))
        return;
    if (!m_connected || !runtimeWritable() || page.value("blocked").toBool()) {
        setMemoryFeedback("action", "error", "候选决定暂不能发送；请核对连接和当前批次后重试。");
        return;
    }
    const auto rows = m_state.value("candidates").toMap().value("candidates").toList();
    int ordinal = -1;
    for (int index = 0; index < rows.size(); ++index)
        if (rows[index].toMap().value("id").toString() == candidateId) {
            if (ordinal >= 0)
                return;
            ordinal = index;
        }
    if (ordinal < 0)
        return;
    const auto command = confirm ? QString("memory:candidates:confirm") : QString("memory:candidates:reject");
    const auto verb = confirm ? QString("记住这条") : QString("不记这条");
    m_candidateDecision = {{"command", command}, {"subjectId", candidateId}, {"verb", verb},
        {"scopeKey", scopeKey()}, {"generation", m_generation}, {"ordinal", ordinal},
        {"startCursor", m_candidateStartCursor}, {"pageNumber", m_candidatePageNumber},
        {"status", "sending"}};
    const auto id = request(command, {{"candidate_id", candidateId}});
    if (id.isEmpty()) {
        m_candidateDecision.clear();
        return;
    }
    m_candidateDecision["requestId"] = id;
    m_candidateDecision["status"] = "pending";
    setMemoryFeedback("action", "pending", "正在" + verb + "…", id,
                      {{"verb", verb}, {"subjectId", candidateId}});
}
void RuntimeBridge::setSummaryEnabled(bool enabled) {
    if (!m_connected) {
        setMemoryFeedback("summary", "error", "本地服务尚未连接，摘要设置没有改动。");
        return;
    }
    if (memoryRequestPending("summary"))
        return;
    const auto id = request("settings:update",
                            {{"section", "features"}, {"hypa_compression_enabled", enabled}});
    // The switch shows the requested value only while this receipt is pending.
    if (!id.isEmpty())
        setMemoryFeedback("summary", "pending", enabled ? "正在开启对话摘要…" : "正在关闭对话摘要…", id,
                          {{"enabled", enabled}});
}
QVariantMap RuntimeBridge::settingsUpdate(const QString &section, const QVariantMap &fields,
                                          QString *error) {
    // Only settings whose effect the native runtime delivers are offered.
    static const QHash<QString, QStringList> switches{
        {"chat", {"split_messages", "allow_environment_description"}},
        {"features", {ProactiveEnabled}},
        {"memory", {"forgetting_enabled", "long_term_forgetting_enabled", "short_term_forgetting_enabled",
                    "misremembering_enabled", "long_term_misremembering_enabled",
                    "short_term_misremembering_enabled"}},
        {"personality", {"personality_flaws_enabled", "personality_flaws_disclaimer_acknowledged",
                         "emotion_system_enabled", "api_background_budget_enforced"}}};
    // The memory page offers these presets only; anything else stays local.
    static const QHash<QString, QList<int>> dayPresets{{"long_term_forget_days", {60, 90, 180, 365}},
                                                       {"short_term_forget_days", {3, 7, 14, 30}}};
    static const QStringList chances{"long_term_forget_probability", "short_term_forget_probability",
                                     "long_term_misremember_probability", "short_term_misremember_probability"};
    static const QList<int> chancePercents{1, 3, 5, 10};
    // The emotion page offers these presets only.
    static const QList<int> emotionDays{1, 3, 5, 7};
    static const QList<int> emotionPercents{5, 10, 15, 30};
    static const QHash<QString, QList<int>> budgetPresets{
        {"api_background_daily_request_budget", {30, 60, 120, 240}},
        {"api_background_daily_token_budget", {10000, 30000, 100000, 300000}}};
    const QList<int> numeric{QMetaType::Int, QMetaType::LongLong, QMetaType::Double};
    *error = "设置内容无效，没有发送。";
    // The first-run sheet only finishes; it never reopens or records progress.
    if (section == "onboarding") {
        const auto completed = fields.value("completed");
        if (fields.size() != 1 || completed.metaType().id() != QMetaType::Bool || !completed.toBool())
            return {};
        error->clear();
        return {{"section", section}, {"completed", true}};
    }
    if (!switches.contains(section) || fields.isEmpty())
        return {};
    QVariantMap body{{"section", section}};
    for (auto it = fields.cbegin(); it != fields.cend(); ++it) {
        const auto type = it.value().metaType().id();
        if (switches.value(section).contains(it.key())) {
            if (type != QMetaType::Bool)
                return {};
            body[it.key()] = it.value().toBool();
        } else if (section == "features" && proactivePresets.contains(it.key())) {
            const double value = it.value().toDouble();
            if (!numeric.contains(type) || !proactivePresets.value(it.key()).contains(value))
                return {};
            body[it.key()] = int(value);
        } else if (section == "memory" && it.key() == "retention_days") {
            const double days = it.value().toDouble();
            if (!numeric.contains(type) || !QList<double>{365, 730, 1095}.contains(days))
                return {};
            body[it.key()] = int(days);
        } else if (section == "memory" && dayPresets.contains(it.key())) {
            const double days = it.value().toDouble();
            if (!numeric.contains(type) || !std::isfinite(days) || days != std::floor(days) ||
                !dayPresets.value(it.key()).contains(int(days)))
                return {};
            body[it.key()] = int(days);
        } else if (section == "memory" && chances.contains(it.key())) {
            // Compared as whole percents, then sent as the canonical fraction.
            const double percent = it.value().toDouble() * 100;
            if (type != QMetaType::Double || !std::isfinite(percent) || percent < 0 || percent > 100)
                return {};
            const int whole = int(std::lround(percent));
            if (std::abs(percent - whole) > 1e-6 || !chancePercents.contains(whole))
                return {};
            body[it.key()] = whole / 100.0;
        } else if (section == "personality" && it.key() == "emotion_carryover_days") {
            const double days = it.value().toDouble();
            if (!numeric.contains(type) || !std::isfinite(days) || days != std::floor(days) ||
                !emotionDays.contains(int(days)))
                return {};
            body[it.key()] = int(days);
        } else if (section == "personality" && it.key() == "emotion_inertia_factor") {
            const double percent = it.value().toDouble() * 100;
            if (type != QMetaType::Double || !std::isfinite(percent) || percent < 0 || percent > 100)
                return {};
            const int whole = int(std::lround(percent));
            if (std::abs(percent - whole) > 1e-6 || !emotionPercents.contains(whole))
                return {};
            body[it.key()] = whole / 100.0;
        } else if (section == "personality" && budgetPresets.contains(it.key())) {
            const double value = it.value().toDouble();
            if (!numeric.contains(type) || !std::isfinite(value) || value != std::floor(value) ||
                value < 0 || value > 300000 || !budgetPresets.value(it.key()).contains(int(value)))
                return {};
            body[it.key()] = int(value);
        } else if (section == "personality" && it.key() == "user_selected_flaws") {
            const auto text = it.value().toString().trimmed();
            if (type != QMetaType::QString || text.isEmpty() || text.size() > 400)
                return {};
            body[it.key()] = text;
        } else
            return {};
    }
    // The acknowledgement is never withdrawn here, and whatever makes flaws
    // active carries it in the same request. Custom text always enables them.
    const auto acknowledged = body.value("personality_flaws_disclaimer_acknowledged");
    if ((acknowledged.isValid() && !acknowledged.toBool()) ||
        (body.contains("user_selected_flaws") && body.value("personality_flaws_enabled") != QVariant(true)))
        return {};
    if ((body.value("personality_flaws_enabled").toBool() || body.contains("user_selected_flaws")) &&
        !acknowledged.toBool()) {
        *error = "需要先勾选知悉说明，设置没有改动。";
        return {};
    }
    error->clear();
    return body;
}
void RuntimeBridge::saveSettings(const QString &section, const QVariantMap &fields, bool confirmed) {
    if (!QStringList{"chat", "memory", "personality", "onboarding", "features"}.contains(section) ||
        m_settingsFeedback.value(section).toMap().value("status").toString() == "pending")
        return;
    QString error;
    const auto body = settingsUpdate(section, fields, &error);
    if (body.isEmpty()) {
        setSettingsFeedback(section, "error", error);
        return;
    }
    if (!m_connected) {
        setSettingsFeedback(section, "error", "本地服务尚未连接，设置没有改动。");
        return;
    }
    if (!runtimeWritable()) {
        setSettingsFeedback(section, "error", "当前为只读状态，设置没有改动。");
        return;
    }
    if (personaChanging()) {
        setSettingsFeedback(section, "error", "人格操作仍在核对中，设置没有改动。");
        return;
    }
    if (!settingsKnown()) {
        setSettingsFeedback(section, "error", "当前设置尚未读取，暂不能保存；请稍后重试。");
        return;
    }
    // A shorter period lets older memories expire at the next daily pass.
    const int retention = m_state.value("settings").toMap().value("memory").toMap().value("retention_days").toInt();
    if (body.contains("retention_days") && body.value("retention_days").toInt() < retention && !confirmed) {
        setSettingsFeedback(section, "error", "缩短保留期需要先确认，设置没有改动。");
        return;
    }
    // Turning misremembering on always follows its own confirmation.
    if (body.value("misremembering_enabled") == QVariant(true) && !confirmed) {
        setSettingsFeedback(section, "error", "开启记错需要先确认，设置没有改动。");
        return;
    }
    if (touchesBudget(body)) {
        invalidateBudget("用量上限正在保存，今日用量需要重新读取。");
        emit changed();
    }
    const auto id = request("settings:update", body);
    if (id.isEmpty()) {
        setSettingsFeedback(section, "error", "设置未能发送，没有改动。");
        return;
    }
    auto requested = body;
    requested.remove("section");
    setSettingsFeedback(section, "pending", "正在保存…", id, requested);
}
void RuntimeBridge::avatarJob(const QJsonObject &job, std::function<void(QJsonObject)> done,
                              std::function<void()> failed) {
    if (m_avatarBusy) {
        setNotice("请等待当前模型操作完成。");
        return;
    }
    const auto safeAvatarId = [](const QString &value) {
        return QRegularExpression("^[0-9a-f]{8}-[0-9a-f-]{27}$", QRegularExpression::CaseInsensitiveOption)
            .match(value).hasMatch() ? value : QString();
    };
    const auto safeImportId = [](const QString &value) {
        return QRegularExpression("^[A-Za-z0-9_-]{1,128}$").match(value).hasMatch() ? value : QString();
    };
    const auto action = job["action"].toString();
    const qulonglong serial = ++m_avatarJobDispatched;
    if (m_avatarJobRecords.size() < 64)
        m_avatarJobRecords.append(QVariantMap{{"serial", serial}, {"action", action},
            {"id", safeAvatarId(job["id"].toString())}, {"importId", safeImportId(job["importId"].toString())},
            {"status", "dispatched"}, {"started", false}, {"exitCode", QVariant::fromValue(nullptr)},
            {"ok", QVariant::fromValue(nullptr)}, {"activeId", ""}, {"recordIds", QStringList{}}});
    else
        m_avatarJobTraceTruncated = true;
    const auto completeDiagnostic = [this, serial, safeAvatarId, safeImportId](const QJsonObject &result,
                                                                              const QVariant &exitCode, const QString &status) {
        ++m_avatarJobCompleted;
        for (auto &value : m_avatarJobRecords) {
            auto record = value.toMap();
            if (record.value("serial").toULongLong() != serial) continue;
            record["status"] = status; record["exitCode"] = exitCode;
            record["ok"] = status == "completed" && exitCode.toInt() == 0 && result["ok"].toBool();
            if (record.value("importId").toString().isEmpty())
                record["importId"] = safeImportId(result["candidate"].toObject()["importId"].toString());
            const auto list = result["list"].toObject();
            record["activeId"] = safeAvatarId(list["activeId"].toString());
            QStringList ids;
            for (const auto &row : list["records"].toArray()) {
                const auto id = safeAvatarId(row.toObject()["id"].toString());
                if (!id.isEmpty()) ids.append(id);
            }
            record["recordIds"] = ids;
            value = record;
            break;
        }
    };
    m_avatarBusy = true;
    if ((action != "select" && action != "scan") || !dismissAvatarRemovalSuccess())
        emit avatarChanged();
    auto *p = new QProcess(this);
    p->setWorkingDirectory(m_root);
    auto env = QProcessEnvironment::systemEnvironment();
    env.remove("NODE_OPTIONS");
    env.remove("PYTHONPATH");
    if (m_previewMode) {
        env.remove("NODE_PATH");
        env.remove("NODE_COMPILE_CACHE");
        env.remove("PYTHONHOME");
        env.insert("PYTHONNOUSERSITE", "1");
        env.insert("PYTHONDONTWRITEBYTECODE", "1");
    }
    env.insert("PYTHON_DOTENV_DISABLED", "1");
    p->setProcessEnvironment(env);
    const auto settled = std::make_shared<bool>(false);
    connect(p, &QProcess::started, this, [this, serial] {
        ++m_avatarJobStarted;
        for (auto &value : m_avatarJobRecords) {
            auto record = value.toMap();
            if (record.value("serial").toULongLong() != serial) continue;
            record["started"] = true;
            value = record;
            break;
        }
    });
    connect(p, &QProcess::finished, this, [this, p, done, failed, settled, completeDiagnostic](int code, QProcess::ExitStatus) {
        if (*settled) return;
        *settled = true;
        m_avatarBusy = false;
        emit avatarChanged();
        auto result = QJsonDocument::fromJson(p->readAllStandardOutput()).object();
        if (code != 0 || !result["ok"].toBool()) {
            if (failed)
                failed();
            else {
                m_avatarState = result["error"].toString("模型操作未完成。");
                emit avatarChanged();
            }
        } else
            done(result);
        completeDiagnostic(result, code, "completed");
        p->deleteLater();
    });
    if (failed)
        connect(p, &QProcess::errorOccurred, this, [this, p, failed, settled, completeDiagnostic](QProcess::ProcessError error) {
            if (error != QProcess::FailedToStart || *settled) return;
            *settled = true;
            m_avatarBusy = false;
            emit avatarChanged();
            failed();
            completeDiagnostic({}, QVariant::fromValue(nullptr), "failed-to-start");
            p->deleteLater();
        });
    p->start(m_root + "/.tools/node/bin/node", {m_root + "/native-ui/avatar-host.cjs"});
    if (*settled) return;
    QJsonObject config = job;
    config["storageDir"] = m_data + "/avatars";
    config["python"] = m_python;
#ifdef REVERIE_LOCAL_CUBISM
    config["runtimeAvailable"] = true;
#else
    config["runtimeAvailable"] = false;
#endif
    p->write(QJsonDocument(config).toJson(QJsonDocument::Compact));
    p->closeWriteChannel();
    QTimer::singleShot(120000, p, [p] {
        if (p->state() != QProcess::NotRunning)
            p->kill();
    });
}
bool RuntimeBridge::retargetAvatar(const QString &entry) {
    if (entry != m_avatarPath)
        m_avatarPath = entry;
    else if (m_avatarRender == AvatarRender::Failed)
        // The surface keeps a failed path as current; only a new token retries it.
        ++m_avatarReloadToken;
    else
        return false;
    m_avatarRender = AvatarRender::Pending;
    return true;
}
void RuntimeBridge::rememberAvatar(const QJsonObject &r) {
    m_state["avatars"] = r["list"].toObject().toVariantMap();
    const auto entry = r["entryPath"].toString();
    if (!entry.isEmpty()) {
        if (retargetAvatar(entry))
            m_avatarState = "正在载入形象…";
        else if (m_avatarRender == AvatarRender::Ready)
            m_avatarState = "形象已就绪";
    }
    emit avatarChanged();
    emit changed();
}
void RuntimeBridge::importModel(const QUrl &url) {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    if (m_avatarBusy)
        return;
    if (!url.isLocalFile() || !QFileInfo(url.toLocalFile()).isDir() ||
        QFileInfo(url.toLocalFile()).isSymLink()) {
        setNotice("请选择可读的本地模型目录。");
        return;
    }
    m_modelConfirmed = false;
    m_avatarState = "正在扫描、准备独立预览…";
    emit avatarChanged();
    avatarJob({{"action", "scan"}, {"path", url.toLocalFile()}}, [this](QJsonObject r) {
        m_candidate = r["candidate"].toObject().toVariantMap();
        retargetAvatar(r["entryPath"].toString());
        m_avatarState = "正在验证模型绘制…";
        emit avatarChanged();
    });
}
void RuntimeBridge::modelRendered(bool ok, const QString &message, const QString &path) {
    if (path != m_avatarPath)
        return;
    m_avatarRender = ok ? AvatarRender::Ready : AvatarRender::Failed;
    m_avatarState = ok ? "形象已就绪" : message;
    if (ok && !m_candidate.isEmpty() && !m_modelConfirmed) {
        m_modelConfirmed = true;
        avatarJob({{"action", "preview"}, {"importId", m_candidate["importId"].toString()}},
                  [this](QJsonObject) {
                      m_candidate["previewReady"] = true;
                      emit avatarChanged();
                  });
    }
    emit avatarChanged();
}
void RuntimeBridge::confirmModel(bool rights, bool warnings) {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    if (!rights || !m_candidate["previewReady"].toBool() ||
        (!m_candidate["warnings"].toList().isEmpty() && !warnings))
        return;
    avatarJob({{"action", "commit"},
               {"importId", m_candidate["importId"].toString()},
               {"rightsConfirmed", rights},
               {"warningAccepted", warnings}},
              [this](QJsonObject r) {
                  m_candidate.clear();
                  rememberAvatar(r);
              });
}
void RuntimeBridge::selectModel(const QString &id) {
    if (!runtimeWritable()) { setNotice(recoveryWarning()); return; }
    avatarJob({{"action", "select"}, {"id", id}}, [this](QJsonObject r) {
        m_candidate.clear();
        rememberAvatar(r);
    });
}
bool RuntimeBridge::dismissAvatarRemovalSuccess() {
    // Leaving the page also dismisses a successful result still in flight.
    m_avatarRemovalSuccessDismissed = true;
    if (m_avatarRemovalFeedback.value("status").toString() != "success")
        return false;
    m_avatarRemovalFeedback.clear();
    emit avatarChanged();
    return true;
}
QString RuntimeBridge::modelRemovalBlocker(const QString &id) const {
    if (!QRegularExpression("^[0-9a-f]{8}-[0-9a-f-]{27}$", QRegularExpression::CaseInsensitiveOption).match(id).hasMatch())
        return "这个形象不在当前列表中。";
    const auto avatars = m_state.value("avatars").toMap();
    QVariantMap selected;
    int matches = 0;
    for (const auto &value : avatars.value("records").toList())
        if (value.toMap().value("id").toString() == id) {
            selected = value.toMap();
            ++matches;
        }
    if (matches != 1)
        return "这个形象不在当前列表中。";
    if (avatars.value("activeId").toString() == id)
        return "先切换到其他形象，再删除。";
    if (selected.value("status").toString() != "ready")
        return "这个形象的记录已损坏，暂时不能删除。";
    if (m_avatarBusy || !m_candidate.isEmpty() || !runtimeWritable() || m_stopping ||
        QStringList{"pending", "refreshing"}.contains(m_avatarRemovalFeedback.value("status").toString()))
        return "请等待当前操作完成。";
    return {};
}
void RuntimeBridge::removeModel(const QString &id) {
    const auto blocker = modelRemovalBlocker(id);
    if (!blocker.isEmpty()) {
        if (!QStringList{"pending", "refreshing"}.contains(m_avatarRemovalFeedback.value("status").toString())) {
            m_avatarRemovalFeedback = {{"status", "blocked"}, {"text", blocker}, {"id", id}, {"listReloaded", false}};
            emit avatarChanged();
        }
        return;
    }
    QString name;
    for (const auto &value : m_state.value("avatars").toMap().value("records").toList())
        if (value.toMap().value("id").toString() == id) name = value.toMap().value("name").toString();
    if (name.isEmpty()) name = "未命名形象";
    // avatarJob publishes this receipt together with its busy flag, so a
    // reentrant click cannot send a second removal before that flag is set.
    m_avatarRemovalSuccessDismissed = false;
    m_avatarRemovalFeedback = {{"status", "pending"}, {"text", "正在删除形象…"}, {"id", id},
                              {"name", name}, {"listReloaded", false}};
    avatarJob({{"action", "remove"}, {"id", id}}, [this, id, name](QJsonObject result) {
        rememberAvatar(result);
        if (m_avatarRemovalSuccessDismissed)
            m_avatarRemovalFeedback.clear();
        else
            m_avatarRemovalFeedback = {{"status", "success"}, {"text", QString("已删除「%1」。").arg(name)},
                                      {"id", id}, {"name", name}, {"listReloaded", true}};
        emit avatarChanged();
    }, [this, id, name] {
        m_avatarRemovalFeedback = {{"status", "refreshing"}, {"text", "形象删除未确认，正在重新读取列表；未自动重试。"},
                                  {"id", id}, {"name", name}, {"listReloaded", false}};
        avatarJob({{"action", "list"}}, [this, id, name](QJsonObject result) {
            rememberAvatar(result);
            m_avatarRemovalFeedback = {{"status", "error"}, {"text", "形象没有删除，列表已重新读取。"},
                                      {"id", id}, {"name", name}, {"listReloaded", true}};
            emit avatarChanged();
        }, [this, id, name] {
            m_avatarRemovalFeedback = {{"status", "error"}, {"text", "形象删除未确认，列表重新读取失败；请重新打开核对。"},
                                      {"id", id}, {"name", name}, {"listReloaded", false}};
            emit avatarChanged();
        });
    });
}
QVariantMap RuntimeBridge::diagnostics() const {
    QVariantList pendingCommands;
    for (auto it = m_pending.cbegin(); it != m_pending.cend(); ++it)
        pendingCommands.append(QVariantMap{{"id", it.key()}, {"command", it->command},
                                           {"generation", it->generation},
                                           {"subjectRequestId", it->subjectRequestId},
                                           {"permissionContextEpoch", it->permissionContextEpoch},
                                           {"permissionSequence", it->permissionSequence}});
    auto candidatePaging = memoryCandidatePage();
    candidatePaging.insert({{"readKind", m_candidateReadKind}, {"readRevision", m_candidateRevision},
        {"readPageNumber", m_candidateReadPageNumber},
        {"currentStartCursorDigest", cursorDigest(m_candidateStartCursor)},
        {"readStartCursorDigest", cursorDigest(m_candidateReadStartCursor)},
        {"nextCursorDigest", cursorDigest(m_candidateNextCursor)},
        {"decisionStatus", m_candidateDecision.value("status")},
        {"decisionRequestId", m_candidateDecision.value("requestId")},
        {"decisionOrdinal", m_candidateDecision.value("ordinal")},
        {"decisionPageNumber", m_candidateDecision.value("pageNumber")}});
    auto batchDelete = memoryBatchDelete();
    const auto batchIds = m_memoryBatchDelete.value("memoryIds").toList();
    batchDelete.insert({{"ids", batchIds}, {"count", batchIds.size()},
        {"readRequestId", m_memoryBatchDelete.value("readRequestId")},
        {"dispatchCount", QVariant::fromValue(m_memoryBatchDeleteDispatchCount)}});
    return {{"connected", m_connected},
            {"handshakes", m_handshakes},
            {"commands", m_commands},
            {"busy", m_busy},
            {"runtimeWritable", runtimeWritable()}, {"recoveryState", m_recoveryState},
            {"backupRestoring", m_backupRestoring},
            {"chatRequestId", m_chatId},
            {"chatState", m_chatFeedback.value("status")},
            {"permissionsKnown", m_permissionsKnown},
            {"permissionContextEpoch", m_permissionContextEpoch},
            {"pendingCommands", pendingCommands},
            {"candidatePaging", candidatePaging},
            {"memoryBatchDelete", batchDelete},
            {"memoryBatchPin", memoryBatchPin()},
            {"messageCount", m_messages.size()},
            {"backendPid", m_process.processId()},
            {"avatarPath", m_avatarPath},
            {"avatarState", m_avatarState},
            {"avatarJobs", QVariantMap{{"dispatched", m_avatarJobDispatched}, {"started", m_avatarJobStarted},
                {"completed", m_avatarJobCompleted}, {"truncated", m_avatarJobTraceTruncated},
                {"records", m_avatarJobRecords}}},
            // Non-secret: whether a key is saved, sent and for which record.
            {"providerKey", m_state.value("providerKey")},
            {"providerKeyAccount", m_keyStore ? m_keyStore->account() : QString()}};
}
void RuntimeBridge::shutdown() {
    if (m_stopping)
        return;
    m_stopping = true;
    invalidatePersonaProfile();
    invalidateSummaryDirectory();
    invalidateSummaryDetail();
    invalidateBudget("本地服务正在关闭，用量暂时读不到。");
    emit changed();
    clearPersonaCardCandidate();
    forgetPersonaCardImport("本地服务正在关闭，角色卡导入结果未确认；重新打开后请核对当前人格和列表。");
    unknownPersonaCardExport();
    unknownWorldbookFile();
    m_readyTimer.stop();
    if (m_process.state() == QProcess::NotRunning) {
        emit shutdownComplete();
        return;
    }
    if (m_busy)
        cancelChat();
    m_process.closeWriteChannel();
    QTimer::singleShot(5000, this, [this] {
        if (m_process.state() != QProcess::NotRunning)
            m_process.terminate();
    });
}
void RuntimeBridge::quit() { shutdown(); }
static constexpr int GomokuSide = 15;
static constexpr int GomokuSquares = GomokuSide * GomokuSide;
static constexpr int GoSide = 9;
static constexpr int GoPoints = GoSide * GoSide;

QString RuntimeBridge::gameIdForPanel(const QString &panel) {
    if (panel == "activities")
        return "xiangqi";
    return panel == "gomoku" || panel == "chess" || panel == "go" ? panel : QString();
}

bool RuntimeBridge::gameCompanion() const {
    if (goGame())
        return m_goCompanion;
    if (chessGame())
        return m_chessCompanion;
    return gomokuGame() ? m_gomokuCompanion : m_companion;
}

bool &RuntimeBridge::gameCompanionMode() {
    if (goGame())
        return m_goCompanion;
    if (chessGame())
        return m_chessCompanion;
    return gomokuGame() ? m_gomokuCompanion : m_companion;
}

static QString chessSquareName(int square) {
    return QString(QLatin1Char(char('a' + square % 8))) + QString::number(8 - square / 8);
}

static bool isWhiteChessPiece(const QString &piece) {
    return !piece.isEmpty() && piece.front().isUpper();
}

static bool legalGoMove(const QJSValue &rules, const QJSValue &position, const QJSValue &point) {
    const auto next = rules.property("playGo").call({position, point});
    return next.isObject() && !next.isError() && !next.strictlyEquals(position);
}

QString RuntimeBridge::gamePersonaName() const {
    const auto persona = m_state.value("persona").toMap();
    return persona.value("name", persona.value("persona").toMap().value("name", "当前人格")).toString();
}

QString RuntimeBridge::gameStatus() const {
    switch (m_gamePhase) {
    case GamePhase::Unloaded:
    case GamePhase::Reading:
        return "正在读取棋局…";
    case GamePhase::InvalidRecord:
        return "棋谱无法完整重放；原记录保留。可以选择重新开始。";
    case GamePhase::ReadFailed:
        return "棋局读取失败，原记录没有改动。";
    case GamePhase::Saving:
        return "正在保存…";
    case GamePhase::SaveUnknown:
        return "这一步的保存结果未确认，没有自动重复提交。请重新读取。";
    case GamePhase::Ready:
        break;
    }
    if (!runtimeWritable())
        return recoveryWarning();
    if (chessGame()) {
        if (m_gameOutcome.isObject()) {
            static const QHash<QString, QString> reasons{
                {"checkmate", "将死"}, {"stalemate", "逼和"}, {"material", "子力不足"},
                {"repetition", "三次重复"}, {"fifty-move", "五十回合"}};
            const auto winner = m_gameOutcome.property("winner");
            const QString result = winner.isNull() ? "和棋" : winner.toString() == "w" ? "你赢了" : "你输了";
            return "本局结束：" + result + "（" + reasons.value(m_gameOutcome.property("reason").toString()) + "）";
        }
        if (gameOpponentTurn())
            return gameCompanion() ? "「" + gamePersonaName() + "」正在想…" : "陪练思考中…";
        return m_chess.property("chessInCheck").call({m_position}).toBool() ? "将军，轮到你" : "轮到你执白走棋";
    }
    if (goGame()) {
        if (m_gameOutcome.isObject()) {
            const auto winner = m_gameOutcome.property("winner").toInt() == 1 ? "黑" : "白";
            return QString("本局结束：%1胜 %2 目（数子法，白贴 6.5，未判死子）")
                .arg(winner, QString::number(m_gameOutcome.property("margin").toNumber()));
        }
        if (gameOpponentTurn())
            return gameCompanion() ? "「" + gamePersonaName() + "」正在想…" : "陪练思考中…";
        return QString("轮到你执黑落子 · 提子 黑 %1：白 %2")
            .arg(m_position.property("blackCaptures").toInt()).arg(m_position.property("whiteCaptures").toInt());
    }
    if (gomokuGame()) {
        if (m_gameOutcome.isObject()) {
            const int winner = m_gameOutcome.property("winner").toInt();
            if (winner == 0)
                return "本局结束：和棋（棋盘已满）";
            return winner == 1 ? "本局结束：你赢了（五子连珠）" : "本局结束：你输了（五子连珠）";
        }
        if (gameOpponentTurn())
            return gameCompanion() ? "「" + gamePersonaName() + "」正在想…" : "陪练思考中…";
        return "轮到你执黑落子";
    }
    if (m_gameOutcome.isObject()) {
        static const QHash<QString, QString> reasons{
            {"checkmate", "将死"}, {"stalemate", "困毙"}, {"king-missing", "将帅被吃"},
            {"quiet-limit", "50 个半回合没有吃子，判和"}, {"material", "双方都无法取胜，判和"},
        };
        const auto winner = m_gameOutcome.property("winner");
        const QString result = winner.isNull() ? "和棋" : winner.toString() == "red" ? "你赢了" : "你输了";
        return "本局结束：" + result + "（" + reasons.value(m_gameOutcome.property("reason").toString()) + "）";
    }
    if (m_position.property("turn").toString() == "black")
        return m_companion ? "「" + gamePersonaName() + "」正在想…" : "陪练思考中…";
    const bool inCheck = m_xiangqi.property("xiangqiInCheck").call({m_position}).toBool();
    return inCheck ? "将军，轮到你执红落子" : "轮到你执红落子";
}

bool RuntimeBridge::gameReady() const {
    return m_gamePhase == GamePhase::Ready && runtimeWritable() && m_gameOutcome.isNull() &&
        gameUserTurn();
}

bool RuntimeBridge::gameCanEnd() const {
    return goGame() && m_gamePhase == GamePhase::Ready && runtimeWritable() && m_gameOutcome.isNull();
}

bool RuntimeBridge::gameLastPass() const {
    return goGame() && !m_moves.isEmpty() && m_moves.size() % 2 == 0 && m_moves.last().isNull();
}

bool RuntimeBridge::gameUserTurn() const {
    const auto turn = m_position.property("turn");
    if (chessGame())
        return turn.toString() == "w";
    if (goGame())
        return turn.toInt() == 1;
    return gomokuGame() ? turn.toInt() == 1 : turn.toString() == "red";
}

bool RuntimeBridge::gameOpponentTurn() const {
    const auto turn = m_position.property("turn");
    if (chessGame())
        return turn.toString() == "b";
    if (goGame())
        return turn.toInt() == -1;
    return gomokuGame() ? turn.toInt() == 2 : turn.toString() == "black";
}

bool RuntimeBridge::gameCanUndo() const {
    return m_gamePhase == GamePhase::Ready && runtimeWritable() && !m_moves.isEmpty();
}

bool RuntimeBridge::gameCanReset() const {
    return runtimeWritable() && (m_gamePhase == GamePhase::Ready || m_gamePhase == GamePhase::InvalidRecord);
}

bool RuntimeBridge::gameCanRead() const {
    return m_connected && (m_gamePhase == GamePhase::ReadFailed || m_gamePhase == GamePhase::SaveUnknown);
}

void RuntimeBridge::cancelOpponent() {
    ++m_gameGeneration;
    if (!m_gameMoveId.isEmpty())
        m_pending.remove(m_gameMoveId);
    m_gameMoveId.clear();
    m_opponentPending = false;
    m_opponentRetried = false;
}

void RuntimeBridge::clearGame() {
    cancelOpponent();
    if (!m_gameReadId.isEmpty())
        m_pending.remove(m_gameReadId);
    if (!m_gameSaveId.isEmpty())
        m_pending.remove(m_gameSaveId);
    m_gameReadId.clear();
    m_gameSaveId.clear();
    m_moves.clear();
    m_gameBoard.clear();
    m_position = {};
    m_gameOutcome = {};
    m_gameRevision = 0;
    m_goEnded = false;
    m_confirmedGameRecord = emptyGameRecord();
    m_gameFeedback.clear();
    m_selection = -1;
    m_gamePhase = GamePhase::Unloaded;
    emit gameChanged();
}

void RuntimeBridge::gameRead() {
    if (!m_connected || !gamePanelOpen() ||
        m_gamePhase == GamePhase::Reading || m_gamePhase == GamePhase::Saving)
        return;
    cancelOpponent();
    m_gamePhase = GamePhase::Reading;
    m_gameFeedback.clear();
    m_gameReadId = request("game_state:get", {{"game_id", gameId()}});
    if (m_gameReadId.isEmpty())
        failGameRequest("game_state:get");
    else
        emit gameChanged();
}

bool RuntimeBridge::replayGomoku(const QJsonArray &moves) {
    if (moves.size() > GomokuSquares)
        return false;
    auto position = m_gomoku.property("newGomokuState").call();
    const auto board = position.property("board");
    if (!board.isArray() || board.property("length").toInt() != GomokuSquares)
        return false;
    const auto play = m_gomoku.property("playGomoku");
    for (const auto &move : moves) {
        const auto index = move.toInteger(-1);
        if (index < 0 || index >= GomokuSquares)
            return false;
        auto next = play.call({position, QJSValue(int(index))});
        // The shared rule engine returns the same state for an occupied
        // square or an attempt to move after the game has ended.
        if (!next.isObject() || next.isError() || next.strictlyEquals(position))
            return false;
        position = next;
    }
    m_position = position;
    m_gameOutcome = QJSValue(QJSValue::NullValue);
    const int winner = position.property("winner").toInt();
    if (winner || position.property("draw").toBool()) {
        m_gameOutcome = m_rules.newObject();
        m_gameOutcome.setProperty("winner", winner);
    }
    return true;
}

bool RuntimeBridge::replayGo(const QJsonObject &record) {
    const auto moves = record.value("moves");
    const auto ended = record.value("ended");
    if (record.size() != 2 || !moves.isArray() || !ended.isBool())
        return false;
    auto position = m_go.property("createGo").call();
    const auto board = position.property("board");
    if (!board.isArray() || board.property("length").toInt() != GoPoints)
        return false;
    const auto play = m_go.property("playGo");
    for (const auto &move : moves.toArray()) {
        const auto index = move.toInteger(-1);
        if (!move.isNull() && (index < 0 || index >= GoPoints))
            return false;
        const auto point = move.isNull() ? QJSValue(QJSValue::NullValue) : QJSValue(int(index));
        const auto next = play.call({position, point});
        if (!next.isObject() || next.isError() || next.strictlyEquals(position))
            return false;
        position = next;
    }
    if (ended.toBool())
        position = m_go.property("endGo").call({position});
    const auto outcome = m_go.property("goOutcome").call({position, m_gomoku.property("scoreChineseArea")});
    if (!outcome.isObject() && !outcome.isNull())
        return false;
    if (outcome.isError())
        return false;
    m_position = position;
    m_gameOutcome = outcome;
    return true;
}

QJsonValue RuntimeBridge::emptyGameRecord() const {
    if (goGame())
        return QJsonObject{{"moves", QJsonArray{}}, {"ended", false}};
    return QJsonArray{};
}

QJsonValue RuntimeBridge::gameRecord() const {
    const auto moves = QJsonArray::fromVariantList(m_moves);
    if (goGame())
        return QJsonObject{{"moves", moves}, {"ended", m_goEnded}};
    return moves;
}

void RuntimeBridge::showGameRecord(const QJsonValue &record) {
    bool valid = false;
    if (goGame()) {
        valid = record.isObject() && replayGo(record.toObject());
    } else if (record.isArray() && chessGame()) {
        const auto replay = m_chess.property("replayChess").call({m_rules.toScriptValue(record.toArray())});
        valid = replay.isObject() && !replay.isError();
        if (valid) {
            m_position = replay;
            m_gameOutcome = m_chess.property("chessOutcome").call({m_position});
        }
    } else if (record.isArray() && gomokuGame()) {
        valid = replayGomoku(record.toArray());
    } else if (record.isArray()) {
        const auto json = QString::fromUtf8(QJsonDocument(record.toArray()).toJson(QJsonDocument::Compact));
        const auto moves = m_rules.globalObject().property("JSON").property("parse").call({json});
        const auto replay = m_xiangqi.property("replayXiangqi").call({moves});
        valid = replay.property("valid").toBool();
        if (valid) {
            m_position = replay.property("position");
            m_gameOutcome = m_xiangqi.property("xiangqiOutcome").call({m_position});
        }
    }
    m_selection = -1;
    if (!valid) {
        m_goEnded = false;
        m_moves.clear();
        m_gameBoard.clear();
        m_position = {};
        m_gameOutcome = {};
        m_gamePhase = GamePhase::InvalidRecord;
        return;
    }
    m_goEnded = goGame() && record.toObject().value("ended").toBool();
    m_moves = (goGame() ? record.toObject().value("moves").toArray() : record.toArray()).toVariantList();
    m_gamePhase = GamePhase::Ready;
    rebuildGameBoard();
}

void RuntimeBridge::rebuildGameBoard() {
    if (goGame()) {
        const auto board = m_position.property("board");
        const auto last = m_position.property("last");
        m_gameBoard.clear();
        for (int i = 0; i < GoPoints; ++i) {
            const int stone = board.property(i).toInt();
            const QString color = stone == 1 ? "black" : stone == -1 ? "white" : "";
            const QString label = stone == 1 ? "黑子" : stone == -1 ? "白子" : "";
            m_gameBoard.append(QVariantMap{{"color", color}, {"label", label}, {"last", last.isNumber() && i == last.toInt()}});
        }
        return;
    }
    if (chessGame()) {
        const auto board = m_position.property("board");
        const auto origin = m_selection < 0 ? QString() : chessSquareName(m_selection);
        const auto last = m_moves.isEmpty() ? QString() : m_moves.last().toString();
        const bool check = m_chess.property("chessInCheck").call({m_position}).toBool();
        const QString king = gameUserTurn() ? "K" : "k";
        static const QHash<QString, QString> names{
            {"k", "王"}, {"q", "后"}, {"r", "车"}, {"b", "象"}, {"n", "马"}, {"p", "兵"}};
        static const QHash<QString, QString> glyphs{
            {"K", "♔"}, {"Q", "♕"}, {"R", "♖"}, {"B", "♗"}, {"N", "♘"}, {"P", "♙"},
            {"k", "♚"}, {"q", "♛"}, {"r", "♜"}, {"b", "♝"}, {"n", "♞"}, {"p", "♟︎"}};
        QSet<QString> destinations;
        if (!origin.isEmpty()) {
            const auto legal = m_chess.property("chessMoves").call({m_position}).toVariant().toList();
            for (const auto &value : legal) {
                const auto move = value.toMap();
                if (move.value("from").toString() == origin)
                    destinations.insert(move.value("to").toString());
            }
        }
        m_gameBoard.clear();
        for (int i = 0; i < 64; ++i) {
            const auto square = chessSquareName(i);
            const auto piece = board.property(i).toString();
            const bool white = isWhiteChessPiece(piece);
            const QString color = piece.isEmpty() ? "" : white ? "white" : "black";
            const QString label = piece.isEmpty() ? "" : (white ? QString("白") : QString("黑")) + names.value(piece.toLower());
            m_gameBoard.append(QVariantMap{{"square", square}, {"color", color}, {"label", label},
                {"glyph", glyphs.value(piece)}, {"selected", i == m_selection}, {"destination", destinations.contains(square)},
                {"last", square == last.left(2) || square == last.mid(2, 2)}, {"check", check && piece == king}});
        }
        return;
    }
    if (gomokuGame()) {
        const auto board = m_position.property("board");
        const int last = m_moves.isEmpty() ? -1 : m_moves.last().toInt();
        m_gameBoard.clear();
        for (int i = 0; i < GomokuSquares; ++i) {
            const int stone = board.property(i).toInt();
            const QString color = stone == 1 ? "black" : stone == 2 ? "white" : "";
            const QString label = stone == 1 ? "黑子" : stone == 2 ? "白子" : "";
            m_gameBoard.append(QVariantMap{{"color", color}, {"label", label}, {"last", i == last}});
        }
        return;
    }
    static const QHash<QString, QString> red{{"king", "帅"}, {"advisor", "仕"}, {"elephant", "相"},
        {"horse", "马"}, {"chariot", "车"}, {"cannon", "炮"}, {"pawn", "兵"}};
    static const QHash<QString, QString> black{{"king", "将"}, {"advisor", "士"}, {"elephant", "象"},
        {"horse", "马"}, {"chariot", "车"}, {"cannon", "炮"}, {"pawn", "卒"}};
    QSet<int> destinations;
    if (m_selection >= 0) {
        const auto legal = m_xiangqi.property("xiangqiLegalMoves").call({m_position}).toVariant().toList();
        for (const auto &value : legal) {
            const auto move = value.toMap();
            if (move.value("from").toInt() == m_selection)
                destinations.insert(move.value("to").toInt());
        }
    }
    const auto board = m_position.property("board");
    m_gameBoard.clear();
    for (int i = 0; i < 90; ++i) {
        const auto piece = board.property(i);
        const auto color = piece.isNull() ? QString() : piece.property("color").toString();
        const auto label = color.isEmpty() ? QString() : (color == "red" ? red : black).value(piece.property("role").toString());
        m_gameBoard.append(QVariantMap{{"label", label}, {"color", color},
            {"selected", i == m_selection}, {"destination", destinations.contains(i)}});
    }
}

void RuntimeBridge::saveGame() {
    m_gamePhase = GamePhase::Saving;
    m_gameSaveId = request("game_state:put",
        {{"game_id", gameId()}, {"state", gameRecord().toVariant()}, {"expected_revision", m_gameRevision}});
    if (m_gameSaveId.isEmpty())
        failGameRequest("game_state:put");
    else
        emit gameChanged();
}

void RuntimeBridge::failGameRequest(const QString &command) {
    if (command == "game:move") {
        m_gameMoveId.clear();
        fallbackOpponent(false);
        return;
    }
    m_gameFeedback.clear();
    if (command == "game_state:put") {
        m_gameSaveId.clear();
        showGameRecord(m_confirmedGameRecord);
        m_gamePhase = GamePhase::SaveUnknown;
    } else {
        m_gameReadId.clear();
        m_gamePhase = GamePhase::ReadFailed;
    }
    emit gameChanged();
}

void RuntimeBridge::finishGameRequest(const QString &command, const QString &type, const QJsonObject &payload) {
    const bool ok = payload["ok"] == QJsonValue(true) && !payload.contains("error");
    if (command == "game:move") {
        m_gameMoveId.clear();
        if (!m_opponentPending || !runtimeWritable() || !gamePanelOpen())
            return;
        if (type != "game:move:result" || !ok) {
            fallbackOpponent(false);
            return;
        }
        QVariant move;
        QString retryNote;
        if (goGame()) {
            const auto text = payload["move"].toString().trimmed();
            static const QRegularExpression coordinates(R"(\A([0-8])(?:\s*[,，]\s*| +)([0-8])\z)");
            const auto match = coordinates.match(text);
            if (text.compare("pass", Qt::CaseInsensitive) == 0 || text == "停一手") {
                move = QJsonValue(QJsonValue::Null).toVariant();
            } else if (!match.hasMatch()) {
                retryNote = "走法需要 列,行 两个 0–8 的整数，或 pass";
            } else {
                const int point = match.captured(1).toInt() + GoSide * match.captured(2).toInt();
                if (legalGoMove(m_go, m_position, point))
                    move = point;
                else
                    retryNote = "这步棋因打劫、自杀或已有棋子而不合法";
            }
        } else if (chessGame()) {
            const auto choice = m_chess.property("parseChessMove").call({m_position, payload["move"].toString()});
            if (choice.isString())
                move = choice.toString();
            else
                retryNote = "这不是当前局面的合法走法，请用 SAN，例如 Nf6";
        } else if (gomokuGame()) {
            static const QRegularExpression decimal("^[0-9]+$");
            const auto text = payload["move"].toString().trimmed();
            bool parsed = false;
            const int index = text.toInt(&parsed);
            if (!parsed || !decimal.match(text).hasMatch() || index < 0 || index >= GomokuSquares)
                retryNote = "格子编号要是 0–224 的整数";
            else if (m_position.property("board").property(index).toInt() != 0)
                retryNote = "那个位置已经有棋子";
            else
                move = index;
        } else {
            const auto parsed = m_xiangqi.property("parseXiangqiMove").call({payload["move"].toString(), m_position});
            const auto candidate = parsed.property("move").toVariant().toMap();
            if (candidate.isEmpty())
                retryNote = parsed.property("error").toString();
            else
                move = candidate;
        }
        if (!move.isValid()) {
            if (m_opponentRetried)
                fallbackOpponent(true);
            else {
                m_opponentRetried = true;
                requestOpponent(retryNote);
            }
            return;
        }
        const auto comment = payload["comment"].toString().trimmed();
        m_gameFeedback = comment.isEmpty() ? QString() : gamePersonaName() + "：" + comment;
        applyGameMove(move);
        return;
    }
    const bool saving = command == "game_state:put";
    const bool conflict = saving && payload["ok"] == QJsonValue(false) && payload["code"] == "conflict";
    const auto exists = payload["exists"];
    const auto revision = payload["revision"].toInteger(-1);
    const auto record = payload["state"];
    if (type != "game_state:result" || (!ok && !conflict) || !exists.isBool() ||
        (exists.toBool() ? revision < 1 || record.isUndefined() : revision != 0 || !record.isNull()) ||
        (saving && !conflict && (!exists.toBool() || revision <= m_gameRevision ||
                                  record != gameRecord()))) {
        failGameRequest(command);
        return;
    }
    m_gameReadId.clear();
    m_gameSaveId.clear();
    m_gameRevision = revision;
    m_confirmedGameRecord = exists.toBool() ? record : emptyGameRecord();
    showGameRecord(m_confirmedGameRecord);
    if (conflict)
        m_gameFeedback = "棋局已在别处改动，已读取当前棋局。";
    if (!saving && !exists.toBool() && runtimeWritable()) {
        saveGame();
        return;
    }
    scheduleOpponent();
    emit gameChanged();
}

void RuntimeBridge::applyMove(const QVariantMap &move) {
    applyGameMove(move);
}

void RuntimeBridge::applyGameMove(const QVariant &move) {
    cancelOpponent();
    m_moves.append(move);
    showGameRecord(gameRecord());
    if (m_gamePhase != GamePhase::Ready) {
        showGameRecord(m_confirmedGameRecord);
        m_gameFeedback = "这一步无法重放，原棋谱保留。";
        emit gameChanged();
        return;
    }
    saveGame();
}

void RuntimeBridge::gameClick(int square) {
    if (goGame()) {
        if (gameReady() && square >= 0 && square < GoPoints && legalGoMove(m_go, m_position, square)) {
            m_gameFeedback.clear();
            applyGameMove(square);
        }
        return;
    }
    if (chessGame()) {
        if (!gameReady() || square < 0 || square >= 64)
            return;
        if (m_selection >= 0) {
            const auto origin = chessSquareName(m_selection);
            const auto destination = chessSquareName(square);
            const auto legal = m_chess.property("chessMoves").call({m_position}).toVariant().toList();
            for (const auto &value : legal) {
                const auto move = value.toMap();
                const auto coordinate = move.value("coordinate").toString();
                if (move.value("from").toString() == origin && move.value("to").toString() == destination &&
                    (coordinate.size() == 4 || coordinate.endsWith('q'))) {
                    m_gameFeedback.clear();
                    applyGameMove(coordinate);
                    return;
                }
            }
        }
        const auto piece = m_position.property("board").property(square).toString();
        m_selection = isWhiteChessPiece(piece) ? square : -1;
        rebuildGameBoard();
        emit gameChanged();
        return;
    }
    if (gomokuGame()) {
        if (!gameReady() || square < 0 || square >= GomokuSquares ||
            m_position.property("board").property(square).toInt() != 0)
            return;
        m_gameFeedback.clear();
        applyGameMove(square);
        return;
    }
    if (!gameReady() || square < 0 || square >= 90)
        return;
    if (m_selection >= 0) {
        const QVariantMap move{{"from", m_selection}, {"to", square}};
        if (m_xiangqi.property("xiangqiIsLegal").call({m_position, m_rules.toScriptValue(move)}).toBool()) {
            m_gameFeedback.clear();
            applyMove(move);
            return;
        }
    }
    const auto piece = m_position.property("board").property(square);
    m_selection = piece.property("color").toString() == "red" ? square : -1;
    rebuildGameBoard();
    emit gameChanged();
}

void RuntimeBridge::gamePass() {
    if (!goGame() || !gameReady())
        return;
    m_gameFeedback.clear();
    applyGameMove(QJsonValue(QJsonValue::Null).toVariant());
}

void RuntimeBridge::gameEnd() {
    if (!gameCanEnd())
        return;
    cancelOpponent();
    m_gameFeedback.clear();
    m_goEnded = true;
    showGameRecord(gameRecord());
    saveGame();
}

void RuntimeBridge::gameUndo() {
    if (!gameCanUndo())
        return;
    cancelOpponent();
    const bool userTurn = gameUserTurn();
    m_moves.removeLast();
    if (userTurn && !m_moves.isEmpty())
        m_moves.removeLast();
    m_gameFeedback.clear();
    m_goEnded = false;
    showGameRecord(gameRecord());
    saveGame();
}

void RuntimeBridge::gameReset() {
    if (!gameCanReset())
        return;
    cancelOpponent();
    m_gameFeedback.clear();
    showGameRecord(emptyGameRecord());
    saveGame();
}

void RuntimeBridge::gameModeChanged(bool companion) {
    auto &mode = gameCompanionMode();
    if (!runtimeWritable() || mode == companion)
        return;
    // A mode change during a save can apply only after its receipt.
    if (m_opponentPending)
        cancelOpponent();
    mode = companion;
    m_gameFeedback.clear();
    scheduleOpponent();
    emit gameChanged();
}

void RuntimeBridge::scheduleOpponent() {
    if (!gamePanelOpen() || m_gamePhase != GamePhase::Ready || !runtimeWritable() ||
        m_opponentPending || !m_gameOutcome.isNull() || !gameOpponentTurn())
        return;
    m_opponentPending = true;
    const int epoch = m_gameGeneration;
    QTimer::singleShot(300, this, [this, epoch] {
        if (epoch != m_gameGeneration)
            return;
        if (!runtimeWritable() || !gamePanelOpen()) {
            cancelOpponent();
            emit gameChanged();
            return;
        }
        if (gameCompanion())
            requestOpponent();
        else
            practiceMove();
    });
}

QString RuntimeBridge::gameBoardText() const {
    if (chessGame())
        return m_chess.property("chessBoardText").call({m_position}).toString();
    if (goGame()) {
        QStringList lines{
            "坐标：列 0–8 从左到右，行 0–8 从上到下；回复「列,行」，或 pass 表示停一手。",
            "△ 为用户的黑子，▲ 为你的白子，· 为空格。",
            "列 0 1 2 3 4 5 6 7 8"};
        const auto board = m_position.property("board");
        for (int row = 0; row < GoSide; ++row) {
            QStringList cells;
            for (int column = 0; column < GoSide; ++column) {
                const int stone = board.property(row * GoSide + column).toInt();
                cells.append(stone == 1 ? "△" : stone == -1 ? "▲" : "·");
            }
            lines.append(QString("行%1 ").arg(row) + cells.join(" "));
        }
        return lines.join("\n");
    }
    if (gomokuGame()) {
        QStringList lines{
            "坐标：行 0–14 从上到下，列 0–14 从左到右，格子编号 = 行 × 15 + 列。",
            "△ 为用户的黑子，▲ 为你的白子，· 为空格。",
            "列 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14"};
        const auto board = m_position.property("board");
        for (int row = 0; row < GomokuSide; ++row) {
            QStringList cells;
            for (int column = 0; column < GomokuSide; ++column) {
                const int stone = board.property(row * GomokuSide + column).toInt();
                cells.append(stone == 1 ? "△" : stone == 2 ? "▲" : "·");
            }
            lines.append(QString("行%1 ").arg(row) + cells.join(" "));
        }
        return lines.join("\n");
    }
    static const QHash<QString, QString> names{{"king", "将帅"}, {"advisor", "士"}, {"elephant", "象"},
        {"horse", "马"}, {"chariot", "车"}, {"cannon", "炮"}, {"pawn", "兵卒"}};
    QStringList lines{"坐标：x=0…8从左到右，y=0为红方底线，y=9为黑方底线。",
        "每格显示颜色和棋种，·为空格。", "x  0 1 2 3 4 5 6 7 8"};
    const auto board = m_position.property("board");
    for (int y = 9; y >= 0; --y) {
        QStringList cells;
        for (int x = 0; x < 9; ++x) {
            const auto piece = board.property(9 * y + x);
            cells.append(piece.isNull() ? QString("·")
                : (piece.property("color").toString() == "red" ? QString("红") : QString("黑")) +
                    names.value(piece.property("role").toString()));
        }
        lines.append(QString("y=%1 ").arg(y) + cells.join(" "));
    }
    return lines.join("\n");
}

void RuntimeBridge::requestOpponent(const QString &retryNote) {
    auto history = QString("%1 手").arg(m_moves.size());
    if (chessGame()) {
        history = m_chess.property("chessHistoryText").call({m_position}).toString();
    } else if (goGame()) {
        history = QString("共 %1 手；黑提子 %2，白提子 %3").arg(m_moves.size())
            .arg(m_position.property("blackCaptures").toInt()).arg(m_position.property("whiteCaptures").toInt());
        if (!m_moves.isEmpty() && m_moves.last().isNull())
            history += "；用户上一手停一手";
    }
    QVariantMap payload{{"game", gameId()},
        {"state", QVariantMap{{"board_text", gameBoardText()}, {"side", gomokuGame() || goGame() ? "白棋" : "黑棋"},
                              {"history_text", history}}}};
    if (!retryNote.isEmpty())
        payload["retry_note"] = retryNote;
    m_gameMoveId = request("game:move", payload);
    if (m_gameMoveId.isEmpty())
        fallbackOpponent(false);
}

void RuntimeBridge::practiceMove() {
    if (goGame()) {
        const auto choice = m_go.property("chooseGoMove").call({m_position});
        if (choice.isNumber())
            applyGameMove(choice.toInt());
        else if (choice.isNull())
            applyGameMove(QJsonValue(QJsonValue::Null).toVariant());
        else {
            cancelOpponent();
            emit gameChanged();
        }
        return;
    }
    if (chessGame()) {
        const auto choice = m_chess.property("chooseChessMove").call({m_position});
        if (choice.isString())
            applyGameMove(choice.toString());
        else {
            cancelOpponent();
            emit gameChanged();
        }
        return;
    }
    if (gomokuGame()) {
        const auto choice = m_gomoku.property("chooseGomokuMove").call({m_position});
        if (choice.isNumber()) {
            applyGameMove(choice.toInt());
        } else {
            cancelOpponent();
            emit gameChanged();
        }
        return;
    }
    const auto move = m_xiangqi.property("chooseXiangqiPracticeMove").call({m_position}).toVariant().toMap();
    if (!move.isEmpty())
        applyMove(move);
    else {
        cancelOpponent();
        emit gameChanged();
    }
}

void RuntimeBridge::fallbackOpponent(bool invalidMove) {
    if (!m_opponentPending || !runtimeWritable() || !gamePanelOpen()) {
        cancelOpponent();
        emit gameChanged();
        return;
    }
    m_gameFeedback = "「" + gamePersonaName() + "」" + (invalidMove ? "这步没走成，由陪练代走。"
                                                            : "暂时不能走子，由陪练代走。");
    practiceMove();
}
