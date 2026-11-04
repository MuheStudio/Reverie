#pragma once
#include "ControlReadiness.h"
#include <QJSValue>
#include <QStringList>
#include <array>

// Test-only, read-only row discovery and action evidence. The caller supplies
// the actual memoryPage, one step clock, and queued frameSwapped sequence.
// Input and any reveal remain owned by NativeControlReadiness::SequentialGate.
namespace MemoryActionProbe {
struct Context {
    QString scope, listId, listStatus, candidateReadId, candidateStatus, editingId, deletingId;
    bool surfaceReady = true;
};
struct Row {
    QPointer<QQuickItem> item;
    QString id;
    int index = -1;
    bool valid() const { return item && !id.isEmpty() && index >= 0; }
};
namespace detail {
inline QString receiptStatus(const QString &value) {
    if (value == "none" || value == "pending" || value == "success" || value == "error" || value == "invalid")
        return value;
    if (value == "failed" || value == "timeout" || value == "unknown") return "error";
    return "invalid";
}
inline QVariantMap dataMap(QVariant value) {
    if (value.metaType() == QMetaType::fromType<QJSValue>())
        value = value.value<QJSValue>().toVariant();
    return value.toMap();
}
inline Row identity(QQuickItem *item) {
    if (!item) return {};
    const auto data = dataMap(item->property("modelData"));
    const auto value = item->property("index");
    bool ok = false;
    const int index = value.toInt(&ok);
    bool numeric = false;
    const double exact = value.toDouble(&numeric);
    const auto id = data.value("id").toString();
    if (!ok || !numeric || !std::isfinite(exact) || exact != index || index < 0 || id.isEmpty()) return {};
    return {item, id, index};
}
inline bool finite(const QRectF &r) {
    return std::isfinite(r.x()) && std::isfinite(r.y()) &&
           std::isfinite(r.width()) && std::isfinite(r.height());
}
inline bool near(qreal a, qreal b) { return std::isfinite(a) && std::isfinite(b) && qAbs(a - b) <= .5; }
inline bool near(const QRectF &a, const QRectF &b) {
    return near(a.x(), b.x()) && near(a.y(), b.y()) && near(a.width(), b.width()) && near(a.height(), b.height());
}
inline QRectF rect(QQuickItem *item) {
    return item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
}
inline void putRect(QVariantMap &out, const QString &prefix, const QRectF &r) {
    if (!finite(r)) return;
    out[prefix + "X"] = r.x(); out[prefix + "Y"] = r.y();
    out[prefix + "Width"] = r.width(); out[prefix + "Height"] = r.height();
}
inline bool same(const Context &a, const Context &b) {
    return a.scope == b.scope && a.listId == b.listId && a.listStatus == b.listStatus &&
           a.candidateReadId == b.candidateReadId && a.candidateStatus == b.candidateStatus &&
           a.editingId == b.editingId && a.deletingId == b.deletingId && a.surfaceReady == b.surfaceReady;
}
} // namespace detail

// Repeater delegates expose required modelData/index properties. Never choose
// an arbitrary one if the actual page temporarily contains duplicate IDs.
inline Row findRow(QQuickItem *memoryPage, const QString &id) {
    Row found;
    int matches = 0;
    QList<QPointer<QQuickItem>> pending{memoryPage};
    while (!pending.isEmpty()) {
        const auto item = pending.takeLast();
        if (!item) continue;
        const auto row = detail::identity(item);
        if (row.valid() && row.id == id) { found = row; ++matches; }
        for (auto *child : item->childItems()) pending.append(child);
    }
    return matches == 1 ? found : Row{};
}
inline QQuickItem *rowControl(const Row &row, const QString &baseName) {
    if (!row.valid()) return nullptr;
    const auto current = detail::identity(row.item);
    if (!current.valid() || current.id != row.id || current.index != row.index) return nullptr;
    QPointer<QQuickItem> found;
    int matches = 0;
    QList<QPointer<QQuickItem>> pending{row.item};
    const auto indexedName = baseName + QString::number(row.index);
    while (!pending.isEmpty()) {
        const auto item = pending.takeLast();
        if (!item) continue;
        if (item->objectName() == baseName || item->objectName() == indexedName) { found = item; ++matches; }
        for (auto *child : item->childItems()) pending.append(child);
    }
    return matches == 1 ? found.data() : nullptr;
}

struct ClipSnapshot { QPointer<QQuickItem> item; QRectF scene; };
struct ScrollSnapshot {
    QPointer<QQuickItem> item;
    QRectF scene;
    std::array<qreal, 8> values{};
};
struct Observation {
    Row row;
    QPointer<QQuickItem> control;
    QPoint center;
    QVariantMap state;
    Context context;
    QRectF rowRect, sceneRect, clipRect;
    QList<ClipSnapshot> clips;
    QList<ScrollSnapshot> scrolls;
    bool eligible = false;
};

inline Observation inspect(QQuickItem *memoryPage, QQuickWindow *window, const QString &id,
                           const QString &baseName, const Context &context) {
    Observation out;
    out.context = context;
    out.row = findRow(memoryPage, id);
    out.control = rowControl(out.row, baseName);
    out.state = NativeControlReadiness::snapshot(out.control, window, context.surfaceReady);
    out.state["effectiveOpacity"] = out.control ? NativeControlReadiness::effectiveOpacity(out.control) : 0;
    out.state.insert({{"scope", context.scope}, {"rowId", out.row.id}, {"rowIndex", out.row.index},
        {"control", baseName.left(80)}, {"listId", context.listId}, {"listStatus", context.listStatus},
        {"candidateReadId", context.candidateReadId}, {"candidateStatus", context.candidateStatus},
        {"editingId", context.editingId}, {"deletingId", context.deletingId}});
    QString reason;
    if (!out.row.valid() || !out.control || !window) reason = "row-or-control-unavailable";
    else if (context.scope.isEmpty() || context.listId.isEmpty() || context.candidateReadId.isEmpty() ||
             context.listStatus != "success" || context.candidateStatus != "success") reason = "reads-not-successful";
    const bool editingMatches = (baseName != "memoryEditField" && baseName != "memoryEditSave") || context.editingId == id;
    const bool deletingMatches = baseName != "memoryDeleteConfirm" || context.deletingId == id;
    out.state["editingIdMatches"] = editingMatches;
    out.state["deletingIdMatches"] = deletingMatches;
    if (reason.isEmpty() && !editingMatches) reason = "editing-id-mismatch";
    if (reason.isEmpty() && !deletingMatches) reason = "deleting-id-mismatch";
    bool geometryValid = out.row.valid() && out.control && window;
    if (geometryValid) {
        out.rowRect = detail::rect(out.row.item);
        out.sceneRect = detail::rect(out.control);
        out.clipRect = NativeControlReadiness::visibleRect(out.control, window);
        const auto floatingCenter = out.control->mapToScene(QPointF(out.control->width() / 2, out.control->height() / 2));
        geometryValid = detail::finite(out.rowRect) && detail::finite(out.sceneRect) && detail::finite(out.clipRect) &&
                        NativeControlReadiness::finiteGeometry(floatingCenter);
        if (geometryValid) out.center = floatingCenter.toPoint();
        for (auto item = out.control; item && geometryValid; item = item->parentItem()) {
            if (item->clip()) {
                const auto clipped = detail::rect(item);
                const auto local = item->mapFromScene(out.center);
                geometryValid = detail::finite(clipped) && QRectF(QPointF(), item->size()).contains(local);
                out.clips.append({item, clipped});
            }
            if (item->inherits("QQuickFlickable") || item->property("contentY").isValid()) {
                ScrollSnapshot scroll{item, detail::rect(item), {}};
                const std::array<const char *, 8> keys{"contentX", "contentY", "contentWidth", "contentHeight",
                                                       "originX", "originY", "topMargin", "bottomMargin"};
                for (size_t i = 0; i < keys.size(); ++i) {
                    const auto value = item->property(keys[i]);
                    bool ok = true;
                    scroll.values[i] = value.isValid() ? value.toDouble(&ok) : 0;
                    geometryValid = geometryValid && ok && std::isfinite(scroll.values[i]);
                }
                geometryValid = geometryValid && detail::finite(scroll.scene) && scroll.values[3] >= 0;
                out.scrolls.append(scroll);
            }
        }
        geometryValid = geometryValid && out.clipRect.contains(out.center) && out.sceneRect.contains(out.center);
    }
    if (reason.isEmpty() && !geometryValid) reason = "geometry-invalid";
    if (reason.isEmpty() && !out.state.value("ready").toBool()) reason = "control-not-ready";
    out.eligible = reason.isEmpty();
    out.state["ready"] = out.eligible;
    out.state["geometryValid"] = geometryValid;
    out.state["integerCenterInsideClip"] = geometryValid && out.clipRect.contains(out.center);
    out.state["centerX"] = out.center.x(); out.state["centerY"] = out.center.y();
    out.state["reason"] = reason;
    detail::putRect(out.state, "row", out.rowRect);
    detail::putRect(out.state, "scene", out.sceneRect);
    detail::putRect(out.state, "clip", out.clipRect);
    QVariantList scrolls;
    for (const auto &scroll : out.scrolls) {
        if (scrolls.size() == NativeControlReadiness::ObservationLimit) break;
        QVariantMap record{{"contentY", scroll.values[1]}, {"contentHeight", scroll.values[3]}};
        detail::putRect(record, "scene", scroll.scene);
        scrolls.append(record);
    }
    out.state["scrolls"] = scrolls;
    out.state["scrollCount"] = out.scrolls.size();
    out.state["clipCount"] = out.clips.size();
    return out;
}

class LayoutGate {
public:
    QVariantMap observe(const Observation &current, qint64 elapsedMs, quint64 frameSerial) {
        ++m_polls;
        m_last = current.state;
        m_last["elapsedMs"] = elapsedMs; m_last["frameSerial"] = frameSerial;
        if (!current.eligible || !current.row.valid() || !current.control) {
            clearAnchor();
        } else if (!m_anchored || !equivalent(m_anchor, current) || elapsedMs < m_at || frameSerial < m_frame) {
            m_anchor = current; m_at = elapsedMs; m_frame = frameSerial;
            m_anchored = true; m_ready = false; ++m_resets;
        } else {
            m_ready = elapsedMs - m_at >= 40 && frameSerial > m_frame;
            if (m_ready) m_accepted = current;
        }
        m_last["ready"] = m_ready;
        m_last["layoutStable"] = m_ready;
        m_last["stableSinceMs"] = m_anchored ? m_at : -1;
        m_last["stableFrameSerial"] = m_anchored ? QVariant::fromValue(m_frame) : QVariant{};
        return m_last;
    }
    bool matches(const Observation &current) const {
        return m_ready && current.eligible && current.row.valid() && current.control &&
               equivalent(m_anchor, current) && equivalent(m_accepted, current);
    }
    QVariantMap metadata() const {
        return {{"ready", m_ready}, {"polls", m_polls}, {"resets", m_resets},
                {"minimumStableMs", 40}, {"last", m_last}};
    }
    void reset() { *this = {}; }
private:
    static bool equivalent(const Observation &a, const Observation &b) {
        if (!detail::same(a.context, b.context) || a.row.item != b.row.item || a.row.id != b.row.id ||
            a.row.index != b.row.index || a.control != b.control || a.center != b.center ||
            !detail::near(a.rowRect, b.rowRect) || !detail::near(a.sceneRect, b.sceneRect) ||
            !detail::near(a.clipRect, b.clipRect) || a.scrolls.size() != b.scrolls.size() ||
            a.clips.size() != b.clips.size()) return false;
        for (qsizetype i = 0; i < a.clips.size(); ++i)
            if (!a.clips[i].item || a.clips[i].item != b.clips[i].item ||
                !detail::near(a.clips[i].scene, b.clips[i].scene)) return false;
        for (qsizetype i = 0; i < a.scrolls.size(); ++i) {
            if (!a.scrolls[i].item || a.scrolls[i].item != b.scrolls[i].item ||
                !detail::near(a.scrolls[i].scene, b.scrolls[i].scene)) return false;
            for (size_t j = 0; j < a.scrolls[i].values.size(); ++j)
                if (!detail::near(a.scrolls[i].values[j], b.scrolls[i].values[j])) return false;
        }
        return true;
    }
    void clearAnchor() { m_anchor = {}; m_accepted = {}; m_anchored = false; m_ready = false; ++m_resets; }
    Observation m_anchor, m_accepted;
    QVariantMap m_last;
    qint64 m_at = 0;
    quint64 m_frame = 0;
    int m_polls = 0, m_resets = 0;
    bool m_anchored = false, m_ready = false;
};

class ReceiptTracker {
public:
    enum State { WaitingForAction, WaitingForReadback, Complete, Failed };
    bool arm(const QString &scope, const QString &verb, const QString &subject, const QString &oldActionId,
             const QString &listId, const QString &candidateReadId) {
        if (m_armed) { fail("tracker-already-armed"); return false; }
        m_armed = true;
        m_scope = scope; m_verb = verb; m_subject = subject; m_oldAction = oldActionId;
        m_armList = listId; m_armCandidates = candidateReadId;
        if (scope.isEmpty() || verb.isEmpty() || subject.isEmpty() || listId.isEmpty() || candidateReadId.isEmpty()) {
            fail("invalid-action-baseline"); return false;
        }
        return true;
    }
    State observe(const QString &scope, const QVariantMap &action, const QVariantMap &list,
                  const QVariantMap &candidates) {
        if (!m_armed || m_state == Failed) return m_state;
        ++m_observations;
        if (scope != m_scope) return fail("action-scope-changed");
        const auto id = action.value("requestId").toString();
        if (id.isEmpty() || id == m_oldAction) {
            if (m_success) return fail("action-receipt-regressed");
            return m_state;
        }
        if (!m_request.isEmpty() && id != m_request) {
            m_distinctIds = 2;
            return fail("multiple-new-action-requests");
        }
        m_request = id; m_distinctIds = 1;
        const auto status = action.value("status").toString();
        m_status = detail::receiptStatus(status);
        if (action.value("verb").toString() != m_verb || action.value("subjectId").toString() != m_subject)
            return fail("action-subject-or-verb-mismatch");
        if (status != "pending" && status != "success") return fail("action-not-successful");
        if (m_success && status != "success") return fail("action-receipt-regressed");
        if (status == "pending") return m_state;
        if (!m_success) {
            m_success = true; m_state = WaitingForReadback;
            // The changed observer sees success before readMemories(true).
            // A new read already visible at this barrier cannot count.
            m_barrierList = list.value("requestId").toString();
            m_barrierCandidates = candidates.value("requestId").toString();
            return m_state;
        }
        if (!readback(list, m_armList, m_barrierList, m_listRead, m_listSuccess) ||
            !readback(candidates, m_armCandidates, m_barrierCandidates, m_candidateRead, m_candidateSuccess))
            return m_state;
        if (m_listSuccess && m_candidateSuccess) m_state = Complete;
        return m_state;
    }
    bool matchesComplete(const QString &scope, const QVariantMap &action, const QVariantMap &list,
                         const QVariantMap &candidates) const {
        return complete() && scope == m_scope && action.value("requestId").toString() == m_request &&
            action.value("status") == "success" && action.value("verb").toString() == m_verb &&
            action.value("subjectId").toString() == m_subject && list.value("requestId").toString() == m_listRead &&
            candidates.value("requestId").toString() == m_candidateRead && list.value("status") == "success" &&
            candidates.value("status") == "success";
    }
    bool armed() const { return m_armed; }
    bool complete() const { return m_state == Complete; }
    bool failed() const { return m_state == Failed; }
    QString requestId() const { return m_request; }
    QString failureReason() const { return m_reason; }
    QVariantMap metadata() const {
        return {{"armed", m_armed}, {"state", int(m_state)}, {"status", m_status}, {"scope", m_scope}, {"verb", m_verb},
            {"subjectId", m_subject}, {"oldActionId", m_oldAction}, {"requestId", m_request},
            {"armedListId", m_armList}, {"armedCandidateReadId", m_armCandidates},
            {"successListId", m_barrierList}, {"successCandidateReadId", m_barrierCandidates},
            {"newActionCount", m_distinctIds}, {"actionSuccess", m_success}, {"listId", m_listRead},
            {"candidateReadId", m_candidateRead}, {"listSuccess", m_listSuccess},
            {"candidateSuccess", m_candidateSuccess}, {"observations", m_observations},
            {"complete", complete()}, {"failed", failed()}, {"reason", m_reason}};
    }
    void reset() { *this = {}; }
private:
    State fail(const QString &reason) { m_state = Failed; m_reason = reason; return m_state; }
    bool readback(const QVariantMap &value, const QString &baseline, const QString &barrier,
                  QString &captured, bool &successful) {
        const auto id = value.value("requestId").toString();
        if (captured.isEmpty()) {
            if (id.isEmpty() || id == baseline || id == barrier) return true;
            captured = id;
        } else if (id != captured) { fail("readback-request-changed"); return false; }
        const auto status = value.value("status").toString();
        if ((status != "pending" && status != "success") || (successful && status != "success")) {
            fail("readback-not-successful"); return false;
        }
        successful = status == "success";
        return true;
    }
    QString m_scope, m_verb, m_subject, m_oldAction, m_request, m_armList, m_armCandidates;
    QString m_barrierList, m_barrierCandidates, m_listRead, m_candidateRead, m_reason;
    QString m_status = "none";
    State m_state = WaitingForAction;
    int m_distinctIds = 0, m_observations = 0;
    bool m_armed = false, m_success = false, m_listSuccess = false, m_candidateSuccess = false;
};

// One instance belongs to one action. Its first feedback/business validation
// may depend on a visible control that the next action's reveal will clip.
// Keep checking the completed receipt identities on every later entry, while
// never reopening that first validation or retrying a failed callback.
class CompletionGate {
public:
    bool verified() const { return m_verified && !m_failed; }
    template <typename IdentityStillMatches, typename FirstValidation>
    bool verify(IdentityStillMatches &&identityStillMatches, FirstValidation &&firstValidation) {
        if (m_failed) return false;
        if (m_busy) { m_failed = true; return false; }
        m_busy = true;
        struct BusyGuard {
            bool &value;
            ~BusyGuard() { value = false; }
        } guard{m_busy};
        try {
            if (!identityStillMatches() || m_failed) { m_failed = true; return false; }
            if (m_verified) return true;
            if (!firstValidation() || m_failed) { m_failed = true; return false; }
            m_verified = true;
            return true;
        } catch (...) {
            m_failed = true;
            throw;
        }
    }
private:
    bool m_verified = false, m_failed = false, m_busy = false;
};

// Close the diagnostic shape at the test boundary, including nested metadata
// supplied by callers. Never copy text/source/error payloads from QML or IPC.
class BoundedDiagnostic {
public:
    void observe(const QVariantMap &state) {
        ++m_observations;
        if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(bounded(state));
    }
    void terminal(const QVariantMap &state) { if (!m_terminalSet) { m_terminal = bounded(state); m_terminalSet = true; } }
    QVariantMap metadata() const {
        return {{"samples", m_samples}, {"terminal", m_terminal}, {"terminalCount", m_terminalSet ? 1 : 0},
                {"sampleLimit", NativeControlReadiness::ObservationLimit}, {"observations", m_observations}};
    }
    void reset() { *this = {}; }
private:
    static QVariantMap bounded(const QVariantMap &state, int depth = 0) {
        QVariantMap out;
        if (depth > 5) return out;
        static const QStringList strings{"scope", "rowId", "control", "listId", "listStatus", "candidateReadId",
            "candidateStatus", "editingId", "deletingId", "reason", "verb", "subjectId", "oldActionId", "requestId", "name",
            "armedListId", "armedCandidateReadId", "successListId", "successCandidateReadId", "status", "phase"};
        static const QStringList booleans{"found", "enabled", "visible", "inputPointInsideClip", "surfaceClosed", "ready",
            "geometryValid", "integerCenterInsideClip", "editingIdMatches", "deletingIdMatches", "layoutStable", "armed",
            "actionSuccess", "listSuccess", "candidateSuccess", "complete", "failed", "attempted", "performed", "expired",
            "busy", "scrolled", "afterObserved", "textMatches", "fullyVisible", "validated"};
        static const QStringList numbers{"rowIndex", "centerX", "centerY", "rowX", "rowY", "rowWidth", "rowHeight",
            "sceneX", "sceneY", "sceneWidth", "sceneHeight", "clipX", "clipY", "clipWidth", "clipHeight", "visibleWidth", "effectiveOpacity",
            "visibleHeight", "scrollCount", "clipCount", "elapsedMs", "frameSerial", "stableSinceMs", "stableFrameSerial",
            "polls", "resets", "minimumStableMs", "state", "newActionCount", "observations", "contentY", "contentHeight",
            "actionIndex", "index", "actionElapsedMs", "sampleLimit", "scrollLimit", "actionLimit", "pollIntervalMs",
            "beforeY", "afterY", "minimumY", "maximumY", "requestedY", "viewportHeight", "centerYBefore", "ancestorCount",
            "textLength", "expectedLength"};
        for (const auto &key : strings) if (state.contains(key)) {
            const auto value = state.value(key).toString();
            out[key] = key == "status" ? detail::receiptStatus(value)
                : key == "phase" ? (value == "first-validation" ? "first-validation" : "invalid")
                : value.left(180);
        }
        for (const auto &key : booleans) if (state.contains(key)) out[key] = state.value(key).toBool();
        for (const auto &key : numbers) if (state.contains(key)) {
            bool ok = false;
            const double value = state.value(key).toDouble(&ok);
            if (ok && std::isfinite(value)) out[key] = value;
        }
        for (const auto *key : {"layout", "receipt", "sequence", "last", "state", "reveal", "geometry", "feedbackValidation"})
            if (state.value(key).metaType() == QMetaType::fromType<QVariantMap>())
                out[key] = bounded(state.value(key).toMap(), depth + 1);
        // The six process records belong to this collector. Do not multiply
        // them by copying another gate's nested process-sample history.
        for (const auto *key : {"scrolls", "actions"}) if (state.contains(key)) {
            QVariantList values;
            for (const auto &entry : state.value(key).toList()) {
                if (values.size() == NativeControlReadiness::ObservationLimit) break;
                values.append(bounded(entry.toMap(), depth + 1));
            }
            out[key] = values;
        }
        return out;
    }
    QVariantList m_samples;
    QVariantMap m_terminal;
    int m_observations = 0;
    bool m_terminalSet = false;
};
} // namespace MemoryActionProbe
