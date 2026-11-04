#pragma once
#include "ControlReadiness.h"
#include "CheckContract.h"
#include <QTest>

// Test input preparation only. The caller supplies the original step clock;
// this gate never restarts it or owns any model/archive state.
namespace NativeArchiveControlReadiness {
enum class Region { WholeItem = 0, BodyPoint = 1, BodyFirstLine = 2, BodyWheel = 3 };
struct Request {
    Region region = Region::WholeItem;
    QString control;
    std::function<QQuickItem *()> target;
    std::function<QVariantMap()> context;
    std::function<qint64()> currentFrame;
};
struct Prepared {
    QPointer<QQuickItem> target, viewport, inner, outer;
    QPoint start, end;
    QVariantMap evidence;
    std::function<void()> verify;
    std::function<void()> verifyIdentity;
};
inline QQuickItem *named(QQuickItem *root, const QString &name, int &count) {
    if (!root) return nullptr;
    QQuickItem *result = nullptr;
    if (root->objectName() == name) { result = root; ++count; }
    for (auto *child : root->childItems()) {
        auto *found = named(child, name, count);
        if (found) result = found;
    }
    return result;
}
inline QQuickItem *flickableAncestor(QQuickItem *item) {
    for (auto *p = item ? item->parentItem() : nullptr; p; p = p->parentItem())
        if (p->inherits("QQuickFlickable")) return p;
    return nullptr;
}
inline QRectF rect(QQuickItem *item) {
    return item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
}
inline void addRect(QVariantMap &out, const QString &prefix, const QRectF &value) {
    out[prefix + "X"] = value.x(); out[prefix + "Y"] = value.y();
    out[prefix + "Width"] = value.width(); out[prefix + "Height"] = value.height();
}
inline QVariantMap scrollSnapshot(QQuickItem *item) {
    QVariantMap out{{"found", item != nullptr}};
    if (!item) return out;
    bool valid = true;
    auto number = [&](const char *key) {
        bool ok = false; const auto value = item->property(key).toDouble(&ok);
        valid = valid && ok && std::isfinite(value); return value;
    };
    const qreal y = number("contentY"), contentHeight = number("contentHeight");
    const qreal minimum = number("originY") - number("topMargin");
    const qreal maximum = std::max(minimum, item->property("originY").toDouble() +
        contentHeight - item->height() + number("bottomMargin"));
    valid = valid && std::isfinite(item->height()) && item->height() > 0 && contentHeight >= 0 &&
        y >= minimum - .5 && y <= maximum + .5;
    out.insert({{"valid", valid}, {"y", y}, {"minimumY", minimum}, {"maximumY", maximum},
                {"height", item->height()}, {"contentHeight", contentHeight}});
    return out;
}
inline void mouseClick(QQuickWindow *window, const Prepared &prepared,
                       const NativeControlReadiness::ElapsedClock &elapsed, int deadline) {
    if (!window || elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
    QPointer<QQuickWindow> guardedWindow(window);
    bool pressed = false;
    try {
        if (prepared.verify) prepared.verify();
        pressed = true;
        QTest::mousePress(window, Qt::LeftButton, Qt::NoModifier, prepared.start);
        if (prepared.verify) prepared.verify();
        else if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
        QTest::mouseRelease(window, Qt::LeftButton, Qt::NoModifier, prepared.start);
        pressed = false;
    } catch (...) {
        if (pressed && guardedWindow) QTest::mouseRelease(guardedWindow, Qt::LeftButton, Qt::NoModifier, prepared.start);
        throw;
    }
}
inline void mouseSelect(QQuickWindow *window, const Prepared &prepared,
                        const NativeControlReadiness::ElapsedClock &elapsed, int deadline) {
    if (!window || elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
    QPointer<QQuickWindow> guardedWindow(window);
    bool pressed = false;
    // Cleanup releases where the pointer was last actually sent: releasing at an
    // unvisited endpoint would carry its own move into the aborted gesture.
    QPoint dispatched = prepared.start;
    try {
        if (prepared.verify) prepared.verify();
        pressed = true;
        QTest::mousePress(window, Qt::LeftButton, Qt::NoModifier, prepared.start);
        if (prepared.verify) prepared.verify();
        else if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
        QTest::mouseMove(window, prepared.end);
        dispatched = prepared.end;
        if (prepared.verify) prepared.verify();
        else if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
        QTest::mouseRelease(window, Qt::LeftButton, Qt::NoModifier, prepared.end);
        pressed = false;
    } catch (...) {
        if (pressed && guardedWindow) QTest::mouseRelease(guardedWindow, Qt::LeftButton, Qt::NoModifier, dispatched);
        throw;
    }
}
class Gate {
public:
    enum Result { Waiting, Performed, Expired, Failed };
    Result poll(QQuickWindow *window, const Request &request,
                const NativeControlReadiness::ElapsedClock &elapsed, int deadline, qint64 frame,
                const std::function<void(const Prepared &)> &perform) {
        if (m_busy) return Waiting;
        if (m_failed) return Failed;
        if (m_expired) return Expired;
        // No reads or reveal after the action: wheel/focus observations belong
        // to the caller and must never include another programmatic scroll.
        if (m_performed) return Performed;
        m_busy = true;
        struct Guard { bool &busy; ~Guard() { busy = false; } } guard{m_busy};
        try {
            ++m_polls;
            const auto now = elapsed();
            m_deadline = deadline;
            if (now >= deadline) return expire();
            if (!window || !request.target || request.control.isEmpty() || int(request.region) < 0 || int(request.region) > 3)
                throw std::runtime_error("ARCHIVE_INPUT_REQUEST_INVALID");
            const auto context = request.context ? request.context() : QVariantMap{};
            if (elapsed() >= deadline) return expire();
            QPointer<QQuickItem> target = request.target();
            if (elapsed() >= deadline) return expire();
            if (!target && !m_bound) {
                m_control = request.control; m_region = request.region;
                m_last = {{"found", false}, {"ready", false}, {"frame", frame}, {"elapsedMs", elapsed()}};
                if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(m_last);
                if (elapsed() >= deadline) return expire();
                window->update(); return Waiting;
            }
            if (!m_bound) {
                m_bound = true; m_window = window; m_target = target; m_context = context;
                m_control = request.control; m_region = request.region;
            }
            const bool identity = target && m_target == target && m_window == window &&
                target->window() == window && m_control == request.control && m_region == request.region;
            if (!identity || context != m_context) {
                m_last = {{"identityMatched", identity}, {"contextMatched", context == m_context},
                          {"frame", frame}, {"elapsedMs", elapsed()}, {"ready", false}};
                throw std::runtime_error("ARCHIVE_INPUT_IDENTITY_CHANGED");
            }
            int count = 0; const auto *unique = named(window->contentItem(), request.control, count);
            if (count != 1 || unique != target) throw std::runtime_error("ARCHIVE_INPUT_TARGET_NOT_UNIQUE");
            Prepared prepared; prepared.target = target;
            const bool body = request.region != Region::WholeItem;
            if (body) {
                int viewportCount = 0;
                // The two pattern editors keep the same bounded text-input
                // contract as the body, with their own real clipped viewport.
                const QString viewportName = request.control == "worldbookRegexKeywords"
                    ? QStringLiteral("worldbook-regex-keywords-scroll")
                    : request.control == "worldbookRegexSecondaryKeywords"
                        ? QStringLiteral("worldbook-regex-secondary-scroll")
                        : QStringLiteral("worldbook-content-scroll");
                prepared.viewport = named(window->contentItem(), viewportName, viewportCount);
                if (viewportCount != 1 || !prepared.viewport || !prepared.viewport->isAncestorOf(target))
                    throw std::runtime_error("ARCHIVE_INPUT_BODY_VIEWPORT_INVALID");
                prepared.inner = flickableAncestor(target);
                prepared.outer = flickableAncestor(prepared.viewport);
                if (!prepared.inner || !prepared.viewport->isAncestorOf(prepared.inner))
                    throw std::runtime_error("ARCHIVE_INPUT_BODY_FLICKABLE_INVALID");
            } else {
                prepared.viewport = target;
                prepared.outer = flickableAncestor(target);
            }
            if (!m_viewport) { m_viewport = prepared.viewport; m_inner = prepared.inner; m_outer = prepared.outer; }
            if (m_viewport != prepared.viewport || m_inner != prepared.inner || m_outer != prepared.outer)
                throw std::runtime_error("ARCHIVE_INPUT_ANCESTOR_CHANGED");
            const auto reveal = NativeControlReadiness::revealWholeItem(prepared.viewport, elapsed, deadline);
            m_lastReveal = reveal;
            if (reveal.value("expired").toBool() || elapsed() >= deadline) return expire();
            if (!target || !prepared.viewport) throw std::runtime_error("ARCHIVE_INPUT_TARGET_DESTROYED");
            if (request.region == Region::BodyFirstLine) {
                // Select the existing first-line band, not the TextArea's
                // center. A long TextArea is intentionally taller than its viewport.
                // Include the first line's top padding/caret height. Revealing
                // only y=19..25 at the viewport edge would let the press itself
                // scroll the caret, invalidating the already bound drag points.
                const QRectF band(0, 0, target->width(), std::min(qreal(36), target->height()));
                const auto local = target->mapRectToItem(prepared.inner, band);
                const auto bounds = scrollSnapshot(prepared.inner);
                if (!bounds.value("valid").toBool()) {
                    m_signature.clear(); m_stableAt = -1; m_stableFrame = -1;
                    m_last = {{"ready", false}, {"inner", bounds}, {"frame", frame}, {"elapsedMs", elapsed()}};
                    if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(m_last);
                    if (elapsed() >= deadline) return expire();
                    window->update(); return Waiting;
                }
                qreal next = bounds.value("y").toDouble();
                if (local.top() < 0) next += local.top();
                else if (local.bottom() > prepared.inner->height()) next += local.bottom() - prepared.inner->height();
                next = std::clamp(next, bounds.value("minimumY").toDouble(), bounds.value("maximumY").toDouble());
                if (elapsed() >= deadline) return expire();
                if (next != bounds.value("y").toDouble()) prepared.inner->setProperty("contentY", next);
                if (elapsed() >= deadline) return expire();
            }
            if (!target || !prepared.viewport || (body && !prepared.inner))
                throw std::runtime_error("ARCHIVE_INPUT_TARGET_DESTROYED");
            prepared.evidence = inspect(window, request, prepared, frame, elapsed());
            auto state = prepared.evidence;
            state["identityMatched"] = true; state["contextMatched"] = true;
            state["contextBound"] = bool(request.context); state["uniqueTarget"] = true;
            const auto observedAt = elapsed();
            state["elapsedMs"] = observedAt;
            const bool candidate = state.value("ready").toBool();
            QVariantMap signature = state;
            signature.remove("frame"); signature.remove("elapsedMs");
            if (!candidate || signature != m_signature) {
                m_signature = signature; m_stableAt = observedAt; m_stableFrame = frame; m_stableContext = context; m_stableBaseline = state;
            }
            state["targetToken"] = 1; state["windowToken"] = 1;
            state["stableAtMs"] = m_stableAt;
            state["stableMs"] = observedAt - m_stableAt;
            state["stableFrame"] = m_stableFrame;
            state["stable"] = candidate && frame > m_stableFrame && observedAt - m_stableAt >= 40;
            state["ready"] = candidate && state.value("stable").toBool();
            m_last = state;
            if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(state);
            if (elapsed() >= deadline) return expire();
            if (!state.value("ready").toBool()) { window->update(); return Waiting; }
            // Bind identity and geometry immediately before the one allowed
            // dispatch; callbacks and synchronous QML signals cannot revive it.
            const auto fresh = inspect(window, request, prepared, frame, elapsed());
            auto comparison = fresh; comparison.remove("frame"); comparison.remove("elapsedMs");
            for (const auto *key : {"identityMatched", "contextMatched", "contextBound", "uniqueTarget"})
                comparison[key] = state.value(key);
            if (request.target() != target || (request.context && request.context() != m_context) || comparison != m_signature)
                throw std::runtime_error("ARCHIVE_INPUT_BEFORE_DISPATCH_CHANGED");
            const auto actionAt = elapsed();
            if (actionAt >= deadline) return expire();
            m_attemptCount = 1; m_actionElapsed = actionAt; m_actionFrame = frame; m_actionContext = context;
            prepared.evidence = state;
            prepared.verifyIdentity = [&, target, viewport = prepared.viewport, inner = prepared.inner, outer = prepared.outer] {
                if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
                if (!m_window || !target || !viewport || request.target() != target || target->window() != m_window ||
                    (request.context && request.context() != m_context) || viewport != m_viewport ||
                    inner != m_inner || outer != m_outer)
                    throw std::runtime_error("ARCHIVE_INPUT_EVENT_IDENTITY_CHANGED");
                if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
                int freshCount = 0;
                if (named(m_window->contentItem(), request.control, freshCount) != target || freshCount != 1)
                    throw std::runtime_error("ARCHIVE_INPUT_EVENT_TARGET_NOT_UNIQUE");
                if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
            };
            prepared.verify = [&] {
                prepared.verifyIdentity();
                auto current = inspect(window, request, prepared, request.currentFrame ? request.currentFrame() : frame, elapsed());
                current.remove("frame"); current.remove("elapsedMs");
                for (const auto *key : {"identityMatched", "contextMatched", "contextBound", "uniqueTarget"})
                    current[key] = state.value(key);
                if (current != m_signature) throw std::runtime_error("ARCHIVE_INPUT_EVENT_GEOMETRY_CHANGED");
                if (elapsed() >= deadline) throw std::runtime_error("ARCHIVE_INPUT_EXPIRED");
            };
            prepared.verify();
            perform(prepared);
            m_afterElapsed = elapsed();
            if (m_afterElapsed >= deadline) { m_performed = true; return expire(); }
            if (!m_window || !target || request.target() != target || target->window() != m_window ||
                (request.context && request.context() != m_context))
                throw std::runtime_error("ARCHIVE_INPUT_AFTER_IDENTITY_CHANGED");
            m_performed = true;
            m_afterElapsed = elapsed(); m_afterFrame = request.currentFrame ? request.currentFrame() : frame;
            if (m_afterElapsed >= deadline) return expire();
            return Performed;
        } catch (...) { m_failed = true; throw; }
    }
    bool attempted() const { return m_attemptCount > 0; }
    bool performed() const { return m_performed; }
    qint64 actionElapsedMs() const { return m_actionElapsed; }
    QVariantMap metadata() const {
        return {{"schema", "archive-control-readiness.v1"}, {"control", m_control},
                {"region", int(m_region)}, {"deadlineMs", m_deadline}, {"polls", m_polls},
                {"attemptCount", m_attemptCount}, {"performed", m_performed}, {"failed", m_failed},
                {"expired", m_expired}, {"actionElapsedMs", m_actionElapsed}, {"performedAtMs", m_actionElapsed},
                {"afterElapsedMs", m_afterElapsed}, {"actionFrame", m_actionFrame}, {"afterFrame", m_afterFrame},
                {"context", m_context}, {"stableContext", m_stableContext}, {"actionContext", m_actionContext},
                {"sampleLimit", NativeControlReadiness::ObservationLimit}, {"samples", m_samples},
                {"last", m_last}, {"stableBaseline", m_stableBaseline}, {"reveal", m_lastReveal}};
    }
    void resetForNextStep() { if (!m_busy) *this = {}; }
private:
    Result expire() { m_expired = true; return Expired; }
    static QVariantMap inspect(QQuickWindow *window, const Request &request, Prepared &p, qint64 frame, qint64 elapsed) {
        const auto whole = rect(p.target), view = rect(p.viewport);
        const auto viewClip = NativeControlReadiness::visibleRect(p.viewport, window);
        const auto targetClip = NativeControlReadiness::visibleRect(p.target, window).intersected(viewClip);
        const bool body = request.region != Region::WholeItem;
        if (request.region == Region::BodyFirstLine) {
            p.start = p.target->mapToScene(QPointF(18, 22)).toPoint();
            p.end = p.target->mapToScene(QPointF(std::min(p.target->width() - 18, qreal(230)), 22)).toPoint();
        } else {
            p.start = (body ? targetClip.center() : whole.center()).toPoint(); p.end = p.start;
        }
        const bool wholeViewport = view.width() > 1 && view.height() > 1 && viewClip.contains(view.adjusted(.5, .5, -.5, -.5));
        const bool inside = targetClip.contains(p.start) && targetClip.contains(p.end);
        const bool hit = inside && NativeCheck::hitTest(window, p.start, p.target).accepted() &&
            NativeCheck::hitTest(window, p.end, p.target).accepted();
        const bool visible = p.target->isVisible() && p.viewport->isVisible() &&
            NativeControlReadiness::effectiveOpacity(p.target) >= .05;
        const bool enabled = p.target->isEnabled();
        const bool scrollValid = (!p.inner || scrollSnapshot(p.inner).value("valid").toBool()) &&
            (!p.outer || scrollSnapshot(p.outer).value("valid").toBool());
        QVariantMap out{{"frame", frame}, {"elapsedMs", elapsed},
            {"windowWidth", window->width()}, {"windowHeight", window->height()},
            {"visible", visible}, {"enabled", enabled},
            {"wholeViewport", wholeViewport}, {"pointsInsideClip", inside}, {"hitTarget", hit},
            {"startX", p.start.x()}, {"startY", p.start.y()}, {"endX", p.end.x()}, {"endY", p.end.y()},
            {"inner", scrollSnapshot(p.inner)}, {"outer", scrollSnapshot(p.outer)},
            {"ready", wholeViewport && inside && hit && visible && enabled && scrollValid}};
        addRect(out, "target", whole); addRect(out, "viewport", view); addRect(out, "clip", viewClip); addRect(out, "targetClip", targetClip);
        return out;
    }
    QPointer<QQuickWindow> m_window;
    QPointer<QQuickItem> m_target, m_viewport, m_inner, m_outer;
    QString m_control;
    Region m_region = Region::WholeItem;
    QVariantMap m_context, m_stableContext, m_actionContext, m_stableBaseline, m_signature, m_last, m_lastReveal;
    QVariantList m_samples;
    qint64 m_stableAt = -1, m_stableFrame = -1, m_actionElapsed = -1, m_actionFrame = -1, m_afterElapsed = -1, m_afterFrame = -1;
    int m_deadline = 0, m_polls = 0, m_attemptCount = 0;
    bool m_bound = false, m_busy = false, m_failed = false, m_performed = false, m_expired = false;
};
} // namespace NativeArchiveControlReadiness
