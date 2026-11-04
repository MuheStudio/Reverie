#pragma once
#include <QSet>
#include <QString>
#include <QVariantMap>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>

// Small test-side contracts shared by the real driver and controlled cases.
// No timer, input, transport, or product state is owned here.
namespace ArchiveInputProbe {
inline bool keyboardFocusMatches(QQuickItem *target, QQuickWindow *window, bool selector = false) {
    QPointer<QQuickItem> qualified = target;
    QPointer<QQuickItem> focus = window ? window->activeFocusItem() : nullptr;
    if (!qualified || !focus) return false;
    if (focus == qualified || qualified->isAncestorOf(focus)) return true;
    if (!selector) return false;
    QPointer<QObject> popup = qualified->property("popup").value<QObject *>();
    QPointer<QQuickItem> content = popup ? popup->property("contentItem").value<QQuickItem *>() : nullptr;
    return popup && popup->property("visible").toBool() && content &&
        (content == focus || content->isAncestorOf(focus));
}
inline bool switchInputMatches(int mouseCount, int clickedCount, int toggledCount) {
    return mouseCount == 1 && toggledCount == 1 && (clickedCount == 0 || clickedCount == 1);
}
class PhaseClock {
public:
    void enter(qint64 stepAt, bool awaitsRead = false) {
        m_readAt = stepAt; m_inputAt = awaitsRead ? -1 : stepAt;
    }
    bool beginInput(qint64 now) {
        if (now < m_readAt || (m_inputAt >= 0 && now < m_inputAt)) return false;
        if (m_inputAt < 0) m_inputAt = now;
        return true;
    }
    qint64 inputAt() const { return m_inputAt; }
    qint64 elapsed(qint64 now) const { return m_inputAt < 0 || now < m_inputAt ? -1 : now - m_inputAt; }
    qint64 readElapsed(qint64 now) const { return now - m_readAt; }
private:
    qint64 m_readAt = 0, m_inputAt = -1;
};

class SaveBinding {
public:
    enum Result { Waiting, Matched, Failed };
    bool arm(const QString &scope, int generation, const QVariantList &pending, const QVariantList &receipts) {
        if (m_armed) return false;
        m_armed = true; m_scope = scope; m_generation = generation;
        if (scope.isEmpty() || generation < 0) { fail("invalid-baseline"); return false; }
        for (const auto &entry : pending) {
            const auto row = entry.toMap();
            if (row.value("command") == "archive:put") {
                if (!identity(row.value("id"))) { fail("invalid-pending-baseline"); return false; }
                m_old.insert(row.value("id").toString());
            }
        }
        for (const auto &entry : receipts) {
            const auto row = entry.toMap();
            if (row.value("command") == "archive:put") {
                if (!identity(row.value("requestId"))) { fail("invalid-receipt-baseline"); return false; }
                m_old.insert(row.value("requestId").toString());
            }
        }
        return true;
    }
    Result observe(const QString &scope, int generation, const QVariantList &pending, const QVariantList &receipts) {
        if (m_result == Failed) return Failed;
        if (!m_armed || scope != m_scope || generation != m_generation) return fail("scope-or-generation-changed");
        QSet<QString> fresh;
        for (const auto &entry : pending) {
            const auto row = entry.toMap(); if (row.value("command") != "archive:put") continue;
            const auto id = row.value("id").toString(); if (m_old.contains(id)) continue;
            if (!identity(row.value("id")) || !generationMatches(row.value("generation"))) return fail("pending-identity-invalid");
            fresh.insert(id);
        }
        for (const auto &entry : receipts) {
            const auto row = entry.toMap(); if (row.value("command") != "archive:put") continue;
            const auto id = row.value("requestId").toString(); if (m_old.contains(id)) continue;
            if (!identity(row.value("requestId")) || !generationMatches(row.value("generation")) || row.value("scope") != m_scope)
                return fail("receipt-identity-invalid");
            fresh.insert(id);
        }
        if (fresh.size() > 1) return fail("multiple-new-writes");
        if (fresh.isEmpty()) return m_result;
        const auto id = *fresh.cbegin();
        if (!m_id.isEmpty() && m_id != id) return fail("write-identity-changed");
        m_id = id; m_result = Matched; return m_result;
    }
    QString requestId() const { return m_id; }
    QString failureReason() const { return m_failure; }
    QVariantMap metadata() const { return {{"scope", m_scope}, {"generation", m_generation}, {"armed", m_armed},
        {"requestId", m_id}, {"status", m_result == Matched ? "matched" : m_result == Failed ? "failed" : "waiting"},
        {"failureReason", m_failure}, {"baselineCount", m_old.size()}}; }
private:
    static bool identity(const QVariant &value) {
        return value.metaType().id() == QMetaType::QString && !value.toString().isEmpty();
    }
    bool generationMatches(const QVariant &value) const {
        const auto type = value.metaType().id();
        if (type != QMetaType::Int && type != QMetaType::LongLong && type != QMetaType::Double) return false;
        bool ok = false; const auto number = value.toDouble(&ok);
        return ok && number == m_generation;
    }
    Result fail(const QString &reason) { m_result = Failed; m_failure = reason; return m_result; }
    QString m_scope, m_id, m_failure;
    int m_generation = -1;
    QSet<QString> m_old;
    bool m_armed = false;
    Result m_result = Waiting;
};
} // namespace ArchiveInputProbe
