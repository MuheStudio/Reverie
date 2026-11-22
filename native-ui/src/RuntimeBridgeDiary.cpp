#include "RuntimeBridge.h"

#include <QDate>
#include <QJsonArray>
#include <QSet>
#include <algorithm>

namespace {
const QString ReadFailed = "日记暂时读不到";
const QString WriteFailed = "没写成，没有保存任何内容。可以稍后再试。";
const QString NotAuthorized = "还需要授权这项费用";
const QString AlreadyWritten = "今天已经写过了";
const QString BusyWriting = "她正在写，稍后再看";

bool validDate(const QString &date) {
    const auto parsed = QDate::fromString(date, Qt::ISODate);
    return parsed.isValid() && parsed.toString(Qt::ISODate) == date;
}

QVariantMap diaryEntry(const QJsonValue &value) {
    const auto entry = value.toObject();
    const auto date = entry["date"].toString();
    if (!validDate(date) || !entry["title"].isString() || !entry["content"].isString() ||
        !entry["created_at"].isString())
        return {};
    return {{"date", date}, {"title", entry["title"].toString()}, {"content", entry["content"].toString()},
            {"createdAt", entry["created_at"].toString()},
            {"groundedFallback", entry["consistency_status"] == "grounded_fallback"}};
}
}

QString RuntimeBridge::moodLabel(const QString &key) {
    static const QHash<QString, QString> moods{
        {"happy", "开心"}, {"peaceful", "平静"}, {"excited", "兴奋"}, {"sad", "难过"},
        {"angry", "生气"}, {"anxious", "焦虑"}, {"upset", "委屈"}, {"moved", "感动"},
        {"low-energy", "没精神"}};
    return moods.value(key);
}

QVariantList RuntimeBridge::diaryRows(const QJsonArray &entries, bool *valid) {
    QVariantList rows;
    QSet<QString> dates;
    for (const auto &value : entries) {
        const auto row = value.toObject();
        const auto date = row["date"].toString();
        if (!validDate(date) || dates.contains(date) || !row["mood"].isString()) {
            *valid = false;
            return {};
        }
        dates.insert(date);
        const auto mood = row["mood"].toString();
        const auto label = moodLabel(mood);
        rows.append(QVariantMap{{"date", date}, {"mood", mood},
                               {"label", label.isEmpty() ? date : date + " · " + label}});
    }
    std::sort(rows.begin(), rows.end(), [](const QVariant &left, const QVariant &right) {
        return left.toMap().value("date").toString() > right.toMap().value("date").toString();
    });
    *valid = true;
    return rows;
}

bool RuntimeBridge::diaryAuthorized() const {
    if (!m_permissionsKnown)
        return false;
    const auto permission = m_state.value("permissions").toMap().value("features").toMap()
        .value("diary_generation").toMap();
    const auto currentOrigin = permission.value("current_origin").toString();
    // The permission snapshot's effective flag also depends on the switch
    // value when it was read. Check the current destination grant separately.
    return permission.value("enabled") == QVariant(true) &&
        permission.value("api_cost_acknowledged") == QVariant(true) &&
        !currentOrigin.isEmpty() && permission.value("origin") == currentOrigin &&
        permission.value("provider") == permission.value("current_provider");
}

QString RuntimeBridge::diaryWriteBlocker() const {
    if (!m_connected || m_stopping) return "本地服务未连接";
    if (personaChanging()) return "正在读取…";
    if (!runtimeWritable()) return "当前为只读状态";
    if (!settingsKnown() || !m_diarySaveId.isEmpty()) return "等待设置确认";
    if (m_state.value("settings").toMap().value("features").toMap().value("diary_enabled") != QVariant(true))
        return "请先打开日记开关";
    if (!diaryAuthorized()) return NotAuthorized;
    if (!m_diaryWriteId.isEmpty()) return "正在写…";
    if (m_diaryListStatus != "ready" || !m_diaryListId.isEmpty() ||
        m_diaryToday != QDate::currentDate().toString(Qt::ISODate))
        return "请先刷新日记列表";
    for (const auto &row : m_diaryEntries)
        if (row.toMap().value("date") == m_diaryToday)
            return AlreadyWritten;
    return m_diaryBackendWriting ? BusyWriting : QString();
}

QVariantMap RuntimeBridge::diaryView() const {
    const auto enabled = m_state.value("settings").toMap().value("features").toMap().value("diary_enabled");
    const bool switching = personaChanging();
    return {{"enabled", enabled == QVariant(true)}, {"authorized", diaryAuthorized()},
            {"switchPending", !m_diarySaveId.isEmpty()},
            {"switchAvailable", settingsKnown() && enabled.metaType().id() == QMetaType::Bool &&
                runtimeWritable() && !switching && !m_stopping && m_diarySaveId.isEmpty()},
            {"listStatus", switching ? QString("loading") : m_diaryListStatus},
            {"listRequestId", m_diaryListReceiptId}, {"entries", switching ? QVariantList{} : m_diaryEntries},
            {"entry", switching ? QVariantMap{} : m_diaryEntry},
            {"readNotice", m_diaryReadNotice}, {"saveNotice", m_diarySaveNotice},
            {"writeNotice", m_diaryWriteNotice}, {"writeBlocker", diaryWriteBlocker()},
            {"writing", !m_diaryWriteId.isEmpty()}};
}

QString RuntimeBridge::sendDiary(DiaryOperation operation, const QString &command, const QVariantMap &fields) {
    if (m_panel != "diary" || !m_connected || m_stopping || m_persona.isEmpty())
        return {};
    m_diarySending = operation;
    const auto id = request(command, fields);
    m_diarySending = DiaryOperation::None;
    if (!id.isEmpty()) {
        m_diaryScope = m_persona;
        if (operation == DiaryOperation::List || operation == DiaryOperation::Save)
            emit diaryRequestDispatched(id, fields);
    }
    return id;
}

void RuntimeBridge::refreshDiary() {
    if (m_panel != "diary" || !m_diaryListId.isEmpty())
        return;
    m_diaryListReceiptId.clear();
    m_diaryListId = sendDiary(DiaryOperation::List, "diary:request", {{"action", "list"}});
    m_diaryListStatus = m_diaryListId.isEmpty() ? "error" : "loading";
    emit changed();
}

void RuntimeBridge::readDiary(const QString &date) {
    if (!validDate(date) || personaChanging())
        return;
    const auto found = std::any_of(m_diaryEntries.begin(), m_diaryEntries.end(), [&](const QVariant &row) {
        return row.toMap().value("date") == date;
    });
    if (!found)
        return;
    m_pending.remove(m_diaryReadId);
    m_diaryReadDate = date;
    m_diaryEntry.clear();
    m_diaryReadId = sendDiary(DiaryOperation::Read, "diary:request", {{"action", "read"}, {"date", date}});
    m_diaryReadNotice = m_diaryReadId.isEmpty() ? ReadFailed : QString("正在读取…");
    emit changed();
}

void RuntimeBridge::setDiaryEnabled(bool enabled) {
    const auto current = diaryView();
    if (!current.value("switchAvailable").toBool() || current.value("enabled").toBool() == enabled)
        return;
    m_diaryRequestedEnabled = enabled;
    m_diarySaveId = sendDiary(DiaryOperation::Save, "settings:update",
                              {{"section", "features"}, {"diary_enabled", enabled}});
    m_diarySaveNotice = m_diarySaveId.isEmpty() ? "没能保存" : "正在保存…";
    emit changed();
}

void RuntimeBridge::writeDiary() {
    if (!diaryWriteBlocker().isEmpty())
        return;
    m_diaryWriteId = sendDiary(DiaryOperation::Write, "diary:write");
    m_diaryWriteNotice = m_diaryWriteId.isEmpty() ? WriteFailed : QString("正在写…");
    emit changed();
}

RuntimeBridge::DiaryOperation RuntimeBridge::diaryOperation(const QString &id) const {
    if (id.isEmpty()) return DiaryOperation::None;
    if (id == m_diaryListId) return DiaryOperation::List;
    if (id == m_diaryReadId) return DiaryOperation::Read;
    if (id == m_diarySaveId) return DiaryOperation::Save;
    if (id == m_diaryWriteId) return DiaryOperation::Write;
    return DiaryOperation::None;
}

void RuntimeBridge::clearDiary() {
    for (const auto &id : {m_diaryListId, m_diaryReadId, m_diarySaveId, m_diaryWriteId})
        m_pending.remove(id);
    m_diaryScope = {};
    m_diaryListId.clear();
    m_diaryReadId.clear();
    m_diaryReadDate.clear();
    m_diarySaveId.clear();
    m_diaryWriteId.clear();
    m_diaryListReceiptId.clear();
    m_diaryToday.clear();
    m_diaryEntries.clear();
    m_diaryEntry.clear();
    m_diaryListStatus.clear();
    m_diaryReadNotice.clear();
    m_diarySaveNotice.clear();
    m_diaryWriteNotice.clear();
    m_diaryBackendWriting = false;
}

bool RuntimeBridge::expireDiary(const QString &id) {
    switch (diaryOperation(id)) {
    case DiaryOperation::None: return false;
    case DiaryOperation::List:
        m_diaryListId.clear();
        m_diaryListStatus = "error";
        break;
    case DiaryOperation::Read:
        m_diaryReadId.clear();
        m_diaryReadNotice = ReadFailed;
        break;
    case DiaryOperation::Save:
        m_diarySaveId.clear();
        m_diarySaveNotice = "没能保存";
        break;
    case DiaryOperation::Write:
        m_diaryWriteId.clear();
        m_diaryWriteNotice = "还没收到结果，稍后回来看看。";
        refreshDiary();
        break;
    }
    emit changed();
    return true;
}

bool RuntimeBridge::acceptDiaryResponse(const QString &id, const QString &type, const QJsonObject &payload) {
    const auto operation = diaryOperation(id);
    if (operation == DiaryOperation::None)
        return false;
    const auto expected = operation == DiaryOperation::Save ? "settings:update:result" : "diary:result";
    if (!m_connected || m_diaryScope != m_persona || !m_pending.contains(id) ||
        m_pending.value(id).generation != m_generation || (type != expected && type != "error") ||
        (payload.contains("request_id") && payload["request_id"] != id) ||
        (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
        (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
        (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]))
        return true;
    m_pending.remove(id);
    const bool ok = type != "error" && payload["ok"] == true && !payload.contains("error");
    switch (operation) {
    case DiaryOperation::List: {
        m_diaryListId.clear();
        bool valid = false;
        const auto today = payload["today"].toString();
        const auto entries = payload["entries"];
        const auto writing = payload["writing"];
        QVariantList rows;
        if (type == expected && !payload.contains("error") &&
            (!payload.contains("ok") || payload["ok"] == true) &&
            entries.isArray() && validDate(today) && writing.isBool())
            rows = diaryRows(entries.toArray(), &valid);
        m_diaryListStatus = valid ? "ready" : "error";
        if (valid) {
            m_diaryListReceiptId = id;
            m_diaryToday = today;
            m_diaryEntries = rows;
            m_diaryBackendWriting = writing.toBool();
        }
        // A list receipt is metadata only. Do not forward arbitrary payload fields.
        QVariantList metadata;
        for (const auto &value : rows) {
            const auto row = value.toMap();
            metadata.append(QVariantMap{{"date", row.value("date")}, {"mood", row.value("mood")}});
        }
        emit changed();
        emit responseReceived(id, "diary:request",
                              {{"ok", valid}, {"today", valid ? today : QString()},
                               {"writing", valid && m_diaryBackendWriting}, {"entries", metadata}}, m_generation);
        return true;
    }
    case DiaryOperation::Read: {
        m_diaryReadId.clear();
        const auto entry = ok ? diaryEntry(payload["entry"]) : QVariantMap{};
        const bool valid = !entry.isEmpty() && entry.value("date") == m_diaryReadDate;
        m_diaryEntry = valid ? entry : QVariantMap{};
        m_diaryReadNotice = valid ? QString() : ReadFailed;
        break;
    }
    case DiaryOperation::Save: {
        m_diarySaveId.clear();
        const auto receivedFeatures = payload.value("features").toObject();
        const auto enabled = receivedFeatures.value("diary_enabled");
        const bool valid = ok && enabled.isBool() && enabled.toBool() == m_diaryRequestedEnabled;
        if (valid) {
            auto settings = m_state.value("settings").toMap();
            auto features = settings.value("features").toMap();
            features["diary_enabled"] = enabled.toBool();
            settings["features"] = features;
            m_state["settings"] = settings;
        }
        m_diarySaveNotice = valid ? QString() : QString("没能保存");
        emit changed();
        emit responseReceived(id, "settings:update",
                              valid ? QVariantMap{{"ok", true}, {"features", QVariantMap{{"diary_enabled", enabled.toBool()}}}}
                                    : QVariantMap{{"ok", false}}, m_generation);
        return true;
    }
    case DiaryOperation::Write: {
        m_diaryWriteId.clear();
        const auto entry = ok ? diaryEntry(payload["entry"]) : QVariantMap{};
        const auto code = payload["code"].toString();
        if (!entry.isEmpty()) {
            m_pending.remove(m_diaryReadId);
            m_diaryReadId.clear();
            m_diaryEntry = entry;
            m_diaryReadNotice.clear();
            m_diaryWriteNotice.clear();
            refreshDiary();
        } else if (code == "diary_already_exists") {
            m_diaryWriteNotice = AlreadyWritten;
            refreshDiary();
        } else if (code == "diary_writing") {
            m_diaryWriteNotice = BusyWriting;
            m_diaryBackendWriting = true;
        } else {
            m_diaryWriteNotice = code == "diary_not_allowed" ? QString("日记开关或费用授权尚未生效") : WriteFailed;
        }
        break;
    }
    case DiaryOperation::None: break;
    }
    // Body-bearing read/write receipts remain private to diaryView.
    emit changed();
    return true;
}
