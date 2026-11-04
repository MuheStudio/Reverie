#pragma once
#include "ControlReadiness.h"
#include <QMetaMethod>
#include <QMetaType>
#include <QSignalSpy>
#include <QStringList>
#include <array>
#include <memory>

// Test-side observations only. SequentialGate owns reveal/input and the caller
// owns the original input/read deadlines. No QML property or bridge state is set.
namespace SummaryInteractionProbe {
struct ClipSnapshot { QPointer<QQuickItem> item; QRectF scene; };
struct ScrollSnapshot {
    QPointer<QQuickItem> item;
    QRectF scene;
    std::array<qreal, 8> values{};
};
struct ControlObservation {
    QPointer<QQuickItem> item;
    QPointer<QQuickWindow> window;
    QString scope;
    QPoint point;
    QRectF scene, clip;
    QList<ClipSnapshot> clips;
    QList<ScrollSnapshot> scrolls;
    QVariantMap state;
    bool eligible = false;
};
namespace detail {
inline bool finite(const QRectF &r) {
    return std::isfinite(r.x()) && std::isfinite(r.y()) &&
           std::isfinite(r.width()) && std::isfinite(r.height());
}
inline bool near(qreal a, qreal b) { return std::isfinite(a) && std::isfinite(b) && std::abs(a - b) <= .5; }
inline bool near(const QRectF &a, const QRectF &b) {
    return near(a.x(), b.x()) && near(a.y(), b.y()) && near(a.width(), b.width()) && near(a.height(), b.height());
}
inline void rect(QVariantMap &out, const QString &prefix, const QRectF &r) {
    if (!finite(r)) return;
    out[prefix + "X"] = r.x(); out[prefix + "Y"] = r.y();
    out[prefix + "Width"] = r.width(); out[prefix + "Height"] = r.height();
}
inline bool boolean(const QVariantMap &map, const QString &key, bool expected) {
    const auto value = map.value(key);
    return value.metaType().id() == QMetaType::Bool && value.toBool() == expected;
}
inline bool summaryMatches(const QVariantMap &summary, bool expected) {
    const auto status = summary.value("status").toString();
    // This is a snapshot of the summary service's state. An operational
    // "failed"/"outcome_unknown" status is distinct from this read failing.
    return (!summary.contains("ok") || boolean(summary, "ok", true)) &&
           !status.isEmpty() && boolean(summary, "enabled", expected);
}
}

struct InputCounts {
    int mouseDispatchCount = 0;
    bool observerValid = false;
    QVariant clickedSignals, toggledSignals, canceledSignals, pressedSignals, releasedSignals;
    QVariant checkedChangedSignals, enabledChangedSignals;
};

// A missing observation is not a measured zero. The only accepted integer
// representations here are Qt's integer counter types, never bool or string.
inline bool measuredCount(const QVariant &value, qint64 &count) {
    const auto type = value.metaType().id();
    if (type != QMetaType::Int && type != QMetaType::UInt &&
        type != QMetaType::LongLong && type != QMetaType::ULongLong) return false;
    bool ok = false;
    count = value.toLongLong(&ok);
    return ok && count >= 0;
}
inline QString inputFailure(const QString &control, const InputCounts &counts) {
    if (!counts.observerValid) return "signal-observer-unavailable";
    if (counts.mouseDispatchCount != 1) return "mouse-dispatch-count";
    qint64 clicked = -1, toggled = -1;
    if (!measuredCount(counts.clickedSignals, clicked)) return "clicked-signal-count";
    if (control == "memoryTab-summary") return clicked == 1 ? QString() : QString("clicked-signal-count");
    if (control != "summaryEnabled") return "unknown-input-control";
    if (clicked > 1) return "clicked-signal-count";
    if (!measuredCount(counts.toggledSignals, toggled) || toggled != 1) return "toggled-signal-count";
    return {};
}
inline bool inputContract(const QString &control, const InputCounts &counts) {
    return inputFailure(control, counts).isEmpty();
}

// This probe only observes signals and caller-reported mouse invocations. It
// never sends input, writes checked/enabled, retries, or asserts a save result.
// Save/transport evidence must be collected independently before the caller
// applies inputContract(). A caller-owned scope guard can seal this probe on
// every early return while the spies and their target are still alive.
class SignalProbe {
public:
    bool arm(QQuickItem *target) {
        if (m_armAttempted) { m_rearmRejected = true; fail("signal-probe-rearmed"); return false; }
        m_armAttempted = true;
        m_target = target;
        if (!target) { fail("signal-target-unavailable"); return false; }
        m_checkedBefore = checked(target);
        m_enabledBefore = target->isEnabled();
        const std::array<const char *, 7> signatures{"clicked()", "toggled()", "canceled()", "pressed()", "released()",
                                                    "checkedChanged()", "enabledChanged()"};
        for (size_t i = 0; i < signatures.size(); ++i) {
            const auto index = target->metaObject()->indexOfSignal(signatures[i]);
            if (index >= 0) m_spies[i] = std::make_unique<QSignalSpy>(target, target->metaObject()->method(index));
        }
        m_armed = allValid();
        if (!m_armed) fail("signal-observer-unavailable");
        return m_armed;
    }
    void recordMouseDispatch() {
        ++m_mouseDispatchCount;
        if (!m_armed || !m_target) fail("signal-probe-not-armed");
        if (m_terminalSet) fail("signal-probe-already-terminal");
    }
    InputCounts counts() const {
        InputCounts result;
        result.mouseDispatchCount = m_mouseDispatchCount;
        result.observerValid = m_armed && !m_failed && m_target && allValid();
        result.clickedSignals = count(0); result.toggledSignals = count(1); result.canceledSignals = count(2);
        result.pressedSignals = count(3); result.releasedSignals = count(4);
        result.checkedChangedSignals = count(5); result.enabledChangedSignals = count(6);
        return result;
    }
    void observe(const QString &phase) {
        if (m_terminalSet) return;
        m_phase = boundedPhase(phase);
        ++m_observations;
        if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(snapshot(m_phase));
    }
    void terminal(const QString &phase = "terminal") {
        if (m_terminalSet) return;
        m_phase = boundedPhase(phase);
        m_terminal = snapshot(m_phase);
        m_terminalSet = true;
    }
    QVariantMap metadata() const {
        auto result = snapshot(m_phase);
        result.insert({{"samples", m_samples}, {"terminal", m_terminal}, {"terminalCount", m_terminalSet ? 1 : 0},
                       {"sampleLimit", NativeControlReadiness::ObservationLimit}, {"observations", m_observations}});
        return result;
    }
private:
    static QVariant checked(const QQuickItem *target) {
        const auto value = target ? target->property("checked") : QVariant{};
        return value.metaType().id() == QMetaType::Bool ? value : QVariant{};
    }
    static QString boundedPhase(const QString &phase) {
        return phase.isEmpty() || phase == "before-input" || phase == "after-input" ||
               phase == "save-readback" || phase == "terminal" ? phase : QString("invalid");
    }
    bool valid(size_t index) const { return m_target && m_spies[index] && m_spies[index]->isValid(); }
    bool allValid() const {
        for (size_t i = 0; i < m_spies.size(); ++i) if (!valid(i)) return false;
        return true;
    }
    QVariant count(size_t index) const { return valid(index) ? QVariant::fromValue(qint64(m_spies[index]->count())) : QVariant{}; }
    void fail(const QString &reason) { if (!m_failed) m_failure = reason; m_failed = true; }
    QVariantMap snapshot(const QString &phase) const {
        const auto actual = counts();
        return {{"phase", phase}, {"armAttempted", m_armAttempted}, {"armed", m_armed}, {"targetAlive", !m_target.isNull()},
                {"rearmRejected", m_rearmRejected}, {"observerValid", actual.observerValid}, {"inputFailure", m_failure},
                {"clickedObserverValid", valid(0)}, {"toggledObserverValid", valid(1)}, {"canceledObserverValid", valid(2)},
                {"pressedObserverValid", valid(3)}, {"releasedObserverValid", valid(4)},
                {"checkedChangedObserverValid", valid(5)}, {"enabledChangedObserverValid", valid(6)},
                {"checkedBefore", m_checkedBefore}, {"enabledBefore", m_enabledBefore},
                {"checkedAfter", m_mouseDispatchCount > 0 ? checked(m_target) : QVariant{}},
                {"enabledAfter", m_mouseDispatchCount > 0 && m_target ? QVariant(m_target->isEnabled()) : QVariant{}},
                {"mouseDispatchCount", m_armed ? QVariant(m_mouseDispatchCount) : QVariant{}},
                {"clickedSignals", actual.clickedSignals}, {"toggledSignals", actual.toggledSignals},
                {"canceledSignals", actual.canceledSignals}, {"pressedSignals", actual.pressedSignals},
                {"releasedSignals", actual.releasedSignals}, {"checkedChangedSignals", actual.checkedChangedSignals},
                {"enabledChangedSignals", actual.enabledChangedSignals}};
    }
    QPointer<QQuickItem> m_target;
    std::array<std::unique_ptr<QSignalSpy>, 7> m_spies;
    QVariant m_checkedBefore, m_enabledBefore;
    QVariantList m_samples;
    QVariantMap m_terminal;
    QString m_phase, m_failure;
    int m_mouseDispatchCount = 0, m_observations = 0;
    bool m_armAttempted = false, m_armed = false, m_failed = false, m_rearmRejected = false, m_terminalSet = false;
};

inline ControlObservation inspect(QQuickItem *target, QQuickWindow *window,
                                  bool surfaceReady, const QString &scope) {
    ControlObservation out;
    out.item = target; out.window = window; out.scope = scope;
    out.state = NativeControlReadiness::snapshot(target, window, surfaceReady);
    const bool bound = target && window && target->window() == window &&
        (target == window->contentItem() || window->contentItem()->isAncestorOf(target));
    bool geometry = bound && !NativeControlReadiness::itemGeometry(target).isEmpty();
    if (geometry) {
        out.scene = target->mapRectToScene(QRectF(QPointF(), target->size()));
        out.clip = NativeControlReadiness::visibleRect(target, window);
        const auto center = target->mapToScene(QPointF(target->width() / 2, target->height() / 2));
        geometry = detail::finite(out.scene) && detail::finite(out.clip) &&
                   NativeControlReadiness::finiteGeometry(center);
        if (geometry) out.point = center.toPoint();
        for (auto *item = target; item && geometry; item = item->parentItem()) {
            const auto scene = item->mapRectToScene(QRectF(QPointF(), item->size()));
            if (item->clip()) {
                geometry = detail::finite(scene) && scene.contains(out.point) &&
                    item->contains(item->mapFromScene(out.point));
                out.clips.append({item, scene});
            }
            if (item->inherits("QQuickFlickable") || item->property("contentY").isValid()) {
                ScrollSnapshot scroll{item, scene, {}};
                const std::array<const char *, 8> keys{"contentX", "contentY", "contentWidth", "contentHeight",
                                                       "originX", "originY", "topMargin", "bottomMargin"};
                for (size_t i = 0; i < keys.size(); ++i) {
                    const auto value = item->property(keys[i]);
                    bool ok = true;
                    scroll.values[i] = value.isValid() ? value.toDouble(&ok) : 0;
                    geometry = geometry && ok && std::isfinite(scroll.values[i]);
                }
                geometry = geometry && detail::finite(scene) && scroll.values[3] >= 0;
                out.scrolls.append(scroll);
            }
        }
    }
    const bool integerInside = geometry && out.scene.contains(out.point) && out.clip.contains(out.point) &&
        QRect(QPoint(), window->size()).contains(out.point) && target->contains(target->mapFromScene(out.point));
    out.eligible = !scope.isEmpty() && geometry && integerInside && out.state.value("ready").toBool();
    out.state.insert({{"scope", scope}, {"bound", bound}, {"geometryValid", geometry},
        {"integerPointInsideClip", integerInside}, {"pointX", out.point.x()}, {"pointY", out.point.y()},
        {"clipCount", out.clips.size()}, {"scrollCount", out.scrolls.size()}, {"ready", out.eligible}});
    out.state["reason"] = scope.isEmpty() ? "scope-unavailable" : !bound ? "target-unbound"
        : !geometry ? "geometry-invalid" : !integerInside ? "integer-point-clipped"
        : !out.eligible ? "control-not-ready" : "ready";
    detail::rect(out.state, "scene", out.scene); detail::rect(out.state, "clip", out.clip);
    QVariantList scrolls;
    for (const auto &scroll : out.scrolls) {
        if (scrolls.size() == NativeControlReadiness::ObservationLimit) break;
        QVariantMap state{{"contentY", scroll.values[1]}, {"contentHeight", scroll.values[3]}};
        detail::rect(state, "scene", scroll.scene); scrolls.append(state);
    }
    out.state["scrolls"] = scrolls;
    return out;
}

class StableGate {
public:
    QVariantMap observe(const ControlObservation &current, qint64 elapsedMs, quint64 frameSerial) {
        ++m_polls;
        m_last = current.state;
        m_last["elapsedMs"] = elapsedMs; m_last["frameSerial"] = frameSerial;
        if (!current.eligible || !current.item || !current.window) {
            m_anchored = false; m_ready = false; ++m_resets;
        } else if (!m_anchored || !equivalent(m_anchor, current) || elapsedMs < m_at || frameSerial < m_frame) {
            m_anchor = current; m_at = elapsedMs; m_frame = frameSerial;
            m_anchored = true; m_ready = false; ++m_resets;
        } else {
            m_ready = elapsedMs - m_at >= 40 && frameSerial > m_frame;
            if (m_ready) m_accepted = current;
        }
        m_last["ready"] = m_ready; m_last["layoutStable"] = m_ready;
        m_last["stableSinceMs"] = m_anchored ? m_at : -1;
        m_last["stableFrameSerial"] = m_anchored ? QVariant::fromValue(m_frame) : QVariant{};
        return m_last;
    }
    bool matches(const ControlObservation &current) const {
        return m_ready && current.eligible && current.item && current.window &&
            equivalent(m_anchor, current) && equivalent(m_accepted, current);
    }
    QVariantMap metadata() const {
        return {{"ready", m_ready}, {"polls", m_polls}, {"resets", m_resets},
                {"minimumStableMs", 40}, {"last", m_last}};
    }
    void reset() { *this = {}; }
private:
    static bool equivalent(const ControlObservation &a, const ControlObservation &b) {
        if (a.item != b.item || a.window != b.window || a.scope != b.scope || a.point != b.point ||
            !detail::near(a.scene, b.scene) || !detail::near(a.clip, b.clip) ||
            a.clips.size() != b.clips.size() || a.scrolls.size() != b.scrolls.size()) return false;
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
    ControlObservation m_anchor, m_accepted;
    QVariantMap m_last;
    qint64 m_at = 0;
    quint64 m_frame = 0;
    int m_polls = 0, m_resets = 0;
    bool m_anchored = false, m_ready = false;
};

class ReceiptTracker {
public:
    enum State { WaitingForSave, WaitingForReadback, Complete, Failed };
    bool arm(const QString &scope, qint64 generation, bool expected,
             const QString &oldSaveId, const QString &oldReadId) {
        if (m_armed) { fail("tracker-already-armed"); return false; }
        m_armed = true; m_scope = scope; m_generation = generation; m_expected = expected;
        m_oldSave = oldSaveId; m_oldRead = oldReadId;
        if (scope.isEmpty() || generation < 0) { fail("invalid-baseline"); return false; }
        return true;
    }
    State observe(const QString &scope, qint64 generation, const QVariantMap &save,
                  const QVariantMap &read, const QVariantMap &summary) {
        if (!m_armed || m_state == Failed) return m_state;
        ++m_observations;
        if (scope != m_scope || generation != m_generation) return fail("scope-or-generation-changed");
        const auto saveId = save.value("requestId").toString();
        if (saveId.isEmpty() || saveId == m_oldSave)
            return m_save.isEmpty() ? m_state : fail("save-receipt-regressed");
        if (!m_save.isEmpty() && saveId != m_save) { m_saveCount = 2; return fail("multiple-save-requests"); }
        m_save = saveId; m_saveCount = 1;
        const auto saveStatus = save.value("status").toString();
        if (saveStatus == "pending") {
            if (m_saveSuccess) return fail("save-status-regressed");
            if (save.contains("enabled") && !detail::boolean(save, "enabled", m_expected))
                return fail("saved-value-mismatch");
            return m_state;
        }
        if (saveStatus != "success") return fail("save-not-successful");
        // RuntimeBridge removes feedback.enabled when the following status read
        // completes. Lock the strict ACK value first; subsequent omission is OK.
        if ((!m_saveSuccess || save.contains("enabled")) && !detail::boolean(save, "enabled", m_expected))
            return fail("saved-value-mismatch");
        m_saveSuccess = true;
        const auto readId = read.value("requestId").toString();
        if (readId.isEmpty() || readId == m_oldRead) {
            if (!m_read.isEmpty()) return fail("read-receipt-regressed");
            m_state = WaitingForReadback; return m_state;
        }
        if (readId == m_save || read.value("sourceSaveId").toString() != m_save ||
            (read.contains("command") && read.value("command").toString() != "summary:status"))
            return fail("read-save-binding-mismatch");
        if (!m_read.isEmpty() && readId != m_read) { m_readCount = 2; return fail("multiple-status-reads"); }
        m_read = readId; m_readCount = 1;
        const auto readStatus = read.value("status").toString();
        if (readStatus == "pending") {
            if (m_readSuccess) return fail("read-status-regressed");
            m_state = WaitingForReadback; return m_state;
        }
        if (readStatus != "success") return fail("status-read-not-successful");
        if (!detail::summaryMatches(summary, m_expected)) return fail("readback-value-mismatch");
        m_readSuccess = true; m_state = Complete; return m_state;
    }
    bool matchesComplete(const QString &scope, qint64 generation, const QVariantMap &save,
                         const QVariantMap &read, const QVariantMap &summary) const {
        return complete() && scope == m_scope && generation == m_generation &&
            save.value("requestId").toString() == m_save && save.value("status") == "success" &&
            (!save.contains("enabled") || detail::boolean(save, "enabled", m_expected)) &&
            read.value("requestId").toString() == m_read && read.value("status") == "success" &&
            read.value("sourceSaveId").toString() == m_save &&
            (!read.contains("command") || read.value("command").toString() == "summary:status") &&
            detail::summaryMatches(summary, m_expected);
    }
    bool armed() const { return m_armed; }
    bool complete() const { return m_state == Complete; }
    bool failed() const { return m_state == Failed; }
    QString failureReason() const { return m_reason; }
    QVariantMap metadata() const {
        return {{"armed", m_armed}, {"scope", m_scope.left(160)}, {"generation", m_generation},
                {"expected", m_expected}, {"oldSaveId", m_oldSave.left(160)}, {"oldReadId", m_oldRead.left(160)},
                {"saveId", m_save.left(160)}, {"readId", m_read.left(160)}, {"newSaveCount", m_saveCount},
                {"newReadCount", m_readCount}, {"saveSuccess", m_saveSuccess}, {"readSuccess", m_readSuccess},
                {"complete", complete()}, {"failed", failed()}, {"failureReason", m_reason},
                {"status", m_state == Complete ? "complete" : m_state == Failed ? "failed"
                    : m_state == WaitingForReadback ? "waiting-readback" : "waiting-save"},
                {"observations", m_observations}};
    }
    void reset() { *this = {}; }
private:
    State fail(const QString &reason) { m_reason = reason; m_state = Failed; return m_state; }
    QString m_scope, m_oldSave, m_oldRead, m_save, m_read, m_reason;
    qint64 m_generation = -1;
    bool m_armed = false, m_expected = false, m_saveSuccess = false, m_readSuccess = false;
    int m_observations = 0, m_saveCount = 0, m_readCount = 0;
    State m_state = WaitingForSave;
};

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
        static const QStringList ids{"scope", "control", "requestId", "sourceSaveId", "saveId", "readId", "oldSaveId", "oldReadId", "name",
            "saveRequestId", "readRequestId"};
        static const QStringList tags{"reason", "failureReason", "inputFailure", "status", "phase", "stateStatus", "feedbackStatus"};
        static const QStringList allowedTags{"", "ready", "scope-unavailable", "target-unbound", "geometry-invalid", "integer-point-clipped",
            "control-not-ready", "waiting-save", "waiting-readback", "complete", "failed", "pending", "success", "error", "unknown",
            "tracker-already-armed", "invalid-baseline", "scope-or-generation-changed", "save-receipt-regressed", "multiple-save-requests",
            "save-status-regressed", "saved-value-mismatch", "save-not-successful", "read-receipt-regressed", "read-save-binding-mismatch",
            "multiple-status-reads", "read-status-regressed", "status-read-not-successful", "readback-value-mismatch",
            "tab-input", "tab-selected", "switch-input", "save-readback", "terminal", "first-validation",
            "none", "disabled", "unauthorized", "running", "cooldown", "below_threshold", "outcome_unknown", "no_source", "idle", "unavailable",
            "before-input", "after-input", "signal-probe-rearmed", "signal-target-unavailable", "signal-observer-unavailable",
            "signal-probe-not-armed", "signal-probe-already-terminal", "mouse-dispatch-count", "clicked-signal-count",
            "toggled-signal-count", "unknown-input-control"};
        static const QStringList flags{"found", "enabled", "visible", "inputPointInsideClip", "surfaceClosed", "ready", "bound",
            "geometryValid", "integerPointInsideClip", "layoutStable", "expected", "saveSuccess", "readSuccess", "complete", "failed",
            "armed", "attempted", "performed", "expired", "busy", "selected", "accented", "checkedMatches", "validated",
            "scrolled", "afterObserved", "textMatches", "fullyVisible", "checked", "stateEnabled", "feedbackEnabled", "shownValue",
            "stateEnabledKnown", "feedbackEnabledKnown", "stateOk", "tabClicked", "armAttempted", "targetAlive", "rearmRejected", "observerValid",
            "clickedObserverValid", "toggledObserverValid", "canceledObserverValid", "pressedObserverValid", "releasedObserverValid",
            "checkedChangedObserverValid", "enabledChangedObserverValid", "checkedBefore", "enabledBefore", "checkedAfter", "enabledAfter",
            "observerArmed", "saveIdentityMatches", "payloadMatches", "savePending"};
        static const QStringList numbers{"pointX", "pointY", "centerX", "centerY", "sceneX", "sceneY", "sceneWidth", "sceneHeight",
            "clipX", "clipY", "clipWidth", "clipHeight", "visibleWidth", "visibleHeight", "clipCount", "scrollCount", "contentY",
            "contentHeight", "elapsedMs", "frameSerial", "stableSinceMs", "stableFrameSerial", "polls", "resets", "minimumStableMs",
            "generation", "newSaveCount", "newReadCount", "observations", "step", "index", "currentIndex", "expectedIndex", "clickCount",
            "clickedSignals", "actionIndex", "actionElapsedMs", "sampleLimit", "scrollLimit", "actionLimit", "pollIntervalMs",
            "beforeY", "afterY", "minimumY", "maximumY", "requestedY", "viewportHeight", "centerYBefore", "ancestorCount",
            "readAt", "clickAt", "terminalElapsedMs", "stepAt", "requestCountDelta", "readFrameSerial", "lastResponseFrame",
            "mouseDispatchCount", "toggledSignals", "canceledSignals", "pressedSignals", "releasedSignals", "checkedChangedSignals",
            "enabledChangedSignals", "terminalCount", "observedSaveRequestCount", "observedReadRequestCount", "rendererSettingsDelta",
            "rendererReadDelta", "saveResponses", "readResponses"};
        static const QStringList nullableCounters{"mouseDispatchCount", "clickedSignals", "toggledSignals", "canceledSignals", "pressedSignals",
            "releasedSignals", "checkedChangedSignals", "enabledChangedSignals", "observedSaveRequestCount", "observedReadRequestCount",
            "rendererSettingsDelta", "rendererReadDelta", "saveResponses", "readResponses"};
        for (const auto &key : ids) if (state.contains(key)) out[key] = state.value(key).toString().left(160);
        const auto source = state.value("source").toString();
        if (source == "feedback-and-response-identities" || source == "renderer-command-delta") out["source"] = source;
        for (const auto &key : tags) if (state.contains(key)) {
            const auto raw = state.value(key);
            if (!raw.isValid() || raw.isNull()) { out[key] = QVariant{}; continue; }
            const auto value = raw.toString();
            out[key] = allowedTags.contains(value) ? value : "invalid";
        }
        for (const auto &key : flags) if (state.contains(key)) {
            const auto value = state.value(key);
            out[key] = value.metaType().id() == QMetaType::Bool ? value : QVariant{};
        }
        for (const auto &key : numbers) if (state.contains(key)) {
            if (nullableCounters.contains(key) && (!state.value(key).isValid() || state.value(key).isNull())) {
                out[key] = QVariant{}; continue;
            }
            bool ok = false; const auto value = state.value(key).toDouble(&ok);
            if (ok && std::isfinite(value)) out[key] = state.value(key);
        }
        for (const auto *key : {"state", "reveal", "layout", "last", "receipt", "sequence", "feedbackValidation", "signalProbe", "requestObservation", "terminal"})
            if (state.contains(key)) out[key] = bounded(state.value(key).toMap(), depth + 1);
        for (const auto *key : {"samples", "actions", "scrolls"}) if (state.contains(key)) {
            QVariantList values;
            for (const auto &value : state.value(key).toList()) {
                if (values.size() == NativeControlReadiness::ObservationLimit) break;
                values.append(bounded(value.toMap(), depth + 1));
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
} // namespace SummaryInteractionProbe
