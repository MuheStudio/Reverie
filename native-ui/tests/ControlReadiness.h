#pragma once
#include <QQuickItem>
#include <QQuickWindow>
#include <QPointer>
#include <QVariantMap>
#include <algorithm>
#include <cmath>
#include <functional>
#include <stdexcept>
#include <vector>

// The same gate is used by native acceptance input and its Qt test. It does
// not change SceneDirector's readiness policy, restart a deadline, or retry an
// input-method commit. Only bounded geometry and boolean metadata are retained.
namespace NativeControlReadiness {
// Observer-only count: product focus scrolling never enters these test helpers.
inline quint64 testRevealCallCount = 0;
inline qreal effectiveOpacity(const QQuickItem *item) {
    qreal value = 1;
    for (auto *i = item; i; i = i->parentItem()) value *= i->opacity();
    return value;
}
inline QRectF visibleRect(const QQuickItem *item, const QQuickWindow *window) {
    if (!item || !window) return {};
    auto rect = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
    rect &= QRectF(0, 0, window->width(), window->height());
    for (auto *p = item->parentItem(); p && !rect.isEmpty(); p = p->parentItem())
        if (p->clip()) rect &= p->mapRectToScene(QRectF(0, 0, p->width(), p->height()));
    return rect;
}
inline QVariantMap snapshot(const QQuickItem *item, const QQuickWindow *window, bool surfaceClosed = true) {
    const auto rect = visibleRect(item, window);
    const auto point = item ? item->mapToScene(QPointF(item->width() / 2, item->height() / 2)) : QPointF();
    const bool visible = item && item->isVisible() && effectiveOpacity(item) >= .05 &&
                         item->width() >= 1 && item->height() >= 1 && rect.width() >= 2 && rect.height() >= 2;
    const bool enabled = item && item->isEnabled();
    const bool pointInside = item && rect.contains(point);
    return {{"found", item != nullptr}, {"enabled", enabled}, {"visible", visible},
            {"inputPointInsideClip", pointInside}, {"surfaceClosed", surfaceClosed},
            {"ready", surfaceClosed && enabled && visible && pointInside},
            {"visibleWidth", rect.width()}, {"visibleHeight", rect.height()}};
}
// Whole-item visibility for checks that need both edges on screen: the same
// half-pixel inset as their own assertions. Numbers and booleans only, so a
// step deadline can report why the item never fit without copying any text.
inline QVariantMap wholeVisibility(const QQuickItem *item, const QQuickWindow *window) {
    QVariantMap result{{"found", item != nullptr}, {"visible", false}, {"fullyVisible", false}};
    if (!item || !window) return result;
    const auto whole = item->mapRectToScene(QRectF(QPointF(), item->size()));
    const auto clip = visibleRect(item, window);
    const bool shown = item->isVisible() && effectiveOpacity(item) >= .05;
    result["visible"] = shown;
    result["sceneX"] = whole.x();
    result["sceneY"] = whole.y();
    result["sceneWidth"] = whole.width();
    result["sceneHeight"] = whole.height();
    result["clipX"] = clip.x();
    result["clipY"] = clip.y();
    result["clipWidth"] = clip.width();
    result["clipHeight"] = clip.height();
    result["fullyVisible"] = shown && whole.width() > 1 && whole.height() > 1 &&
                             clip.contains(whole.adjusted(.5, .5, -.5, -.5));
    return result;
}
class OnceGate {
  public:
    enum Result { Waiting, Performed, Expired };
    Result poll(qint64 elapsedMs, int deadlineMs, const std::function<QVariantMap()> &inspect,
                const std::function<void()> &action) {
        // Check before reading controls or acting. A ready control on the
        // deadline cannot revive the step or trigger a late submission.
        if (elapsedMs >= deadlineMs) return Expired;
        if (performed) return Performed;
        const auto state = inspect();
        ++polls;
        auto sample = state;
        sample["elapsedMs"] = elapsedMs;
        if (samples.size() < 6 && (samples.isEmpty() || state != lastState)) samples.append(sample);
        lastState = state;
        last = sample;
        if (!state.value("ready").toBool()) return Waiting;
        action();
        performed = true;
        return Performed;
    }
    QVariantMap metadata() const {
        return {{"polls", polls}, {"performed", performed}, {"samples", samples}, {"last", last},
                {"sampleLimit", 6}, {"pollIntervalMs", 100}};
    }
    void resetForNextStep() { *this = {}; }
  private:
    bool performed = false;
    int polls = 0;
    QVariantList samples;
    QVariantMap lastState, last;
};

using ElapsedClock = std::function<qint64()>;
inline constexpr int ObservationLimit = 6;

inline bool finiteGeometry(const QPointF &point) {
    return std::isfinite(point.x()) && std::isfinite(point.y());
}
inline QVariantMap itemGeometry(const QQuickItem *item) {
    if (!item || !std::isfinite(item->width()) || !std::isfinite(item->height()) ||
        item->width() < 1 || item->height() < 1)
        return {};
    const auto center = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
    const auto rect = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
    if (!finiteGeometry(center) || !finiteGeometry(rect.topLeft()) ||
        !std::isfinite(rect.width()) || !std::isfinite(rect.height()))
        return {};
    return {{"sceneX", rect.x()}, {"sceneY", rect.y()}, {"width", rect.width()},
            {"height", rect.height()}, {"centerX", center.x()}, {"centerY", center.y()}};
}

// QQuickFlickable is a private C++ type. Its public QML properties are enough
// here: map the whole item's center again after every inner scroll, then clamp
// contentY to the origin/margin-aware bounds of the next enclosing Flickable.
// A partly visible point never substitutes for snapshot()'s original center.
inline QVariantMap revealCenter(QQuickItem *item, const ElapsedClock &elapsedMs, int deadlineMs) {
    ++testRevealCallCount;
    QVariantMap result{{"expired", false}, {"geometryValid", false}, {"scrollCount", 0},
                       {"ancestorCount", 0}, {"scrollLimit", ObservationLimit}};
    QVariantList scrolls;
    auto expired = [&] {
        const auto now = elapsedMs();
        result["elapsedMs"] = now;
        if (now < deadlineMs) return false;
        result["expired"] = true;
        return true;
    };
    auto finish = [&] {
        result["scrolls"] = scrolls;
        return result;
    };
    if (expired()) return finish();
    QPointer<QQuickItem> target(item);
    const auto initialGeometry = itemGeometry(target);
    if (initialGeometry.isEmpty()) return finish();
    result["geometry"] = initialGeometry;
    result["geometryValid"] = true;

    // Retain guarded pointers because setting contentY can synchronously run
    // QML signal handlers. Check the same clock before each ancestor read.
    std::vector<QPointer<QQuickItem>> ancestors;
    QPointer<QQuickItem> current = target;
    while (current) {
        if (expired()) return finish();
        current = current->parentItem();
        if (!current) break;
        if (expired()) return finish();
        if (current->inherits("QQuickFlickable")) ancestors.push_back(current);
    }
    auto finiteProperty = [](const QQuickItem *object, const char *name, qreal &value) {
        bool ok = false;
        value = object->property(name).toDouble(&ok);
        return ok && std::isfinite(value);
    };
    for (const auto &ancestor : ancestors) {
        if (expired()) return finish();
        if (!target || !ancestor) {
            result["geometryValid"] = false;
            return finish();
        }
        qreal before = 0, contentHeight = 0, origin = 0, topMargin = 0, bottomMargin = 0;
        const auto viewportHeight = ancestor->height();
        if (!std::isfinite(viewportHeight) || viewportHeight < 1 ||
            !finiteProperty(ancestor, "contentY", before) ||
            !finiteProperty(ancestor, "contentHeight", contentHeight) || contentHeight < 0 ||
            !finiteProperty(ancestor, "originY", origin) ||
            !finiteProperty(ancestor, "topMargin", topMargin) ||
            !finiteProperty(ancestor, "bottomMargin", bottomMargin)) {
            result["geometryValid"] = false;
            return finish();
        }
        const auto point = target->mapToItem(ancestor, QPointF(target->width() / 2, target->height() / 2));
        const qreal minimum = origin - topMargin;
        const qreal maximum = std::max(minimum, origin + contentHeight - viewportHeight + bottomMargin);
        const qreal requested = before + point.y() - viewportHeight / 2;
        if (!finiteGeometry(point) || !std::isfinite(minimum) || !std::isfinite(maximum) ||
            !std::isfinite(requested)) {
            result["geometryValid"] = false;
            return finish();
        }
        const qreal after = point.y() >= 0 && point.y() <= viewportHeight
                                ? std::clamp(before, minimum, maximum) : std::clamp(requested, minimum, maximum);
        QVariantMap scroll{{"index", result["ancestorCount"]}, {"beforeY", before},
                           {"minimumY", minimum}, {"maximumY", maximum},
                           {"requestedY", requested}, {"viewportHeight", viewportHeight},
                           {"contentHeight", contentHeight}, {"centerYBefore", point.y()},
                           {"scrolled", false}};
        result["ancestorCount"] = result["ancestorCount"].toInt() + 1;
        if (after != before) {
            // Property reads and mapToItem may take time. A fresh check belongs
            // immediately before every scroll mutation, including outer ones.
            if (expired()) return finish();
            scroll["elapsedMs"] = result["elapsedMs"];
            const bool written = ancestor->setProperty("contentY", after);
            scroll["scrolled"] = written;
            scroll["appliedY"] = after;
            if (written) result["scrollCount"] = result["scrollCount"].toInt() + 1;
            // Do not even inspect the next ancestor (or actual after value) if
            // a synchronous contentYChanged handler consumed the deadline.
            if (expired()) {
                scroll["afterObserved"] = false;
                if (scrolls.size() < ObservationLimit) scrolls.append(scroll);
                return finish();
            }
            if (!target || !ancestor) {
                result["geometryValid"] = false;
                if (scrolls.size() < ObservationLimit) scrolls.append(scroll);
                return finish();
            }
        } else if (expired()) {
            return finish();
        }
        qreal actualAfter = 0;
        if (!finiteProperty(ancestor, "contentY", actualAfter) || actualAfter < minimum || actualAfter > maximum) {
            result["geometryValid"] = false;
            return finish();
        }
        scroll["afterY"] = actualAfter;
        scroll["afterObserved"] = true;
        if (scrolls.size() < ObservationLimit) scrolls.append(scroll);
    }
    if (expired()) return finish();
    const auto finalGeometry = itemGeometry(target);
    result["geometryValid"] = !finalGeometry.isEmpty();
    result["geometry"] = finalGeometry;
    return finish();
}

// Whole-item admission uses the same caller-owned clock and vertical scroll
// bounds as revealCenter. Remap the current rectangle after each inner scroll;
// a center already inside a viewport does not prove that both edges fit.
inline QVariantMap revealWholeItem(QQuickItem *item, const ElapsedClock &elapsedMs, int deadlineMs) {
    ++testRevealCallCount;
    QVariantMap result{{"expired", false}, {"geometryValid", false}, {"scrollCount", 0},
                       {"ancestorCount", 0}, {"scrollLimit", ObservationLimit}};
    QVariantList scrolls;
    QPointer<QQuickItem> target(item);
    auto expired = [&] {
        const auto now = elapsedMs();
        result["elapsedMs"] = now;
        if (now < deadlineMs) return false;
        result["expired"] = true;
        return true;
    };
    auto finish = [&] {
        result["scrolls"] = scrolls;
        return result;
    };
    auto canRead = [&](const QPointer<QQuickItem> &object) {
        if (expired()) return false;
        if (target && object) return true;
        result["geometryValid"] = false;
        return false;
    };
    if (!canRead(target)) return finish();
    const auto initialGeometry = itemGeometry(target);
    if (initialGeometry.isEmpty()) return finish();
    result["geometry"] = initialGeometry;
    result["geometryValid"] = true;

    std::vector<QPointer<QQuickItem>> ancestors;
    QPointer<QQuickItem> current = target;
    while (current) {
        if (!canRead(current)) return finish();
        current = current->parentItem();
        if (!current) break;
        if (!canRead(current)) return finish();
        if (current->inherits("QQuickFlickable")) ancestors.push_back(current);
    }
    auto finiteProperty = [&](const QPointer<QQuickItem> &object, const char *name, qreal &value) {
        if (!canRead(object)) return false;
        bool ok = false;
        value = object->property(name).toDouble(&ok);
        if (ok && std::isfinite(value)) return true;
        result["geometryValid"] = false;
        return false;
    };
    for (const auto &ancestor : ancestors) {
        if (!canRead(ancestor)) return finish();
        const auto viewportHeight = ancestor->height();
        if (!std::isfinite(viewportHeight) || viewportHeight < 1) {
            result["geometryValid"] = false;
            return finish();
        }
        qreal before = 0, contentHeight = 0, origin = 0, topMargin = 0, bottomMargin = 0;
        if (!finiteProperty(ancestor, "contentY", before) ||
            !finiteProperty(ancestor, "contentHeight", contentHeight) ||
            !finiteProperty(ancestor, "originY", origin) ||
            !finiteProperty(ancestor, "topMargin", topMargin) ||
            !finiteProperty(ancestor, "bottomMargin", bottomMargin))
            return finish();
        if (contentHeight < 0) {
            result["geometryValid"] = false;
            return finish();
        }
        if (!canRead(target)) return finish();
        const auto width = target->width();
        if (!canRead(target)) return finish();
        const auto height = target->height();
        if (!std::isfinite(width) || !std::isfinite(height) || width < 1 || height < 1) {
            result["geometryValid"] = false;
            return finish();
        }
        if (!canRead(ancestor)) return finish();
        const auto rect = target->mapRectToItem(ancestor, QRectF(0, 0, width, height));
        if (!canRead(ancestor)) return finish();
        const auto point = target->mapToItem(ancestor, QPointF(width / 2, height / 2));
        const qreal minimum = origin - topMargin;
        const qreal maximum = std::max(minimum, origin + contentHeight - viewportHeight + bottomMargin);
        const qreal requested = before + point.y() - viewportHeight / 2;
        if (!finiteGeometry(point) || !finiteGeometry(rect.topLeft()) ||
            !std::isfinite(rect.width()) || !std::isfinite(rect.height()) ||
            !std::isfinite(rect.bottom()) || !std::isfinite(minimum) || !std::isfinite(maximum) ||
            !std::isfinite(requested)) {
            result["geometryValid"] = false;
            return finish();
        }
        // Match inspect()'s half-pixel inset of the target rectangle. Keep
        // fitsViewport strict: a taller target never becomes a whole item.
        const bool withinViewport = rect.top() >= -.5 && rect.bottom() <= viewportHeight + .5;
        const qreal after = withinViewport ? before : std::clamp(requested, minimum, maximum);
        QVariantMap scroll{{"index", result["ancestorCount"]}, {"beforeY", before},
                           {"minimumY", minimum}, {"maximumY", maximum},
                           {"requestedY", requested}, {"viewportHeight", viewportHeight},
                           {"contentHeight", contentHeight}, {"centerYBefore", point.y()},
                           {"topYBefore", rect.top()}, {"bottomYBefore", rect.bottom()},
                           {"fitsViewport", rect.height() <= viewportHeight}, {"scrolled", false}};
        result["ancestorCount"] = result["ancestorCount"].toInt() + 1;
        if (after != before) {
            if (!canRead(ancestor)) return finish();
            scroll["elapsedMs"] = result["elapsedMs"];
            const bool written = ancestor->setProperty("contentY", after);
            scroll["scrolled"] = written;
            scroll["appliedY"] = after;
            if (written) result["scrollCount"] = result["scrollCount"].toInt() + 1;
            // Signal handlers may delete either item or consume the deadline.
            // Do not read even the actual after value if that happened.
            if (!canRead(ancestor)) {
                scroll["afterObserved"] = false;
                if (scrolls.size() < ObservationLimit) scrolls.append(scroll);
                return finish();
            }
        }
        qreal actualAfter = 0;
        if (!finiteProperty(ancestor, "contentY", actualAfter)) return finish();
        if (actualAfter < minimum || actualAfter > maximum) {
            result["geometryValid"] = false;
            return finish();
        }
        scroll["afterY"] = actualAfter;
        scroll["afterObserved"] = true;
        if (scrolls.size() < ObservationLimit) scrolls.append(scroll);
    }
    if (!canRead(target)) return finish();
    const auto finalGeometry = itemGeometry(target);
    result["geometryValid"] = !finalGeometry.isEmpty();
    result["geometry"] = finalGeometry;
    return finish();
}

// A fixed-size digest of either reveal result for timeout diagnostics.
inline QVariantMap revealSummary(const QVariantMap &reveal) {
    bool fits = true;
    QVariant lastAfterY;
    for (const auto &value : reveal.value("scrolls").toList()) {
        const auto scroll = value.toMap();
        if (scroll.contains("fitsViewport")) fits = fits && scroll.value("fitsViewport").toBool();
        if (scroll.contains("afterY")) lastAfterY = scroll.value("afterY");
    }
    QVariantMap result{{"present", !reveal.isEmpty()}, {"expired", reveal.value("expired").toBool()},
                       {"geometryValid", reveal.value("geometryValid").toBool()},
                       {"scrollCount", reveal.value("scrollCount").toInt()},
                       {"ancestorCount", reveal.value("ancestorCount").toInt()}, {"fitsViewport", fits}};
    if (reveal.contains("elapsedMs")) result["elapsedMs"] = reveal.value("elapsedMs");
    if (lastAfterY.isValid()) result["lastAfterY"] = lastAfterY;
    return result;
}

// Unlike OnceGate, this gate owns one ordered list of subactions. It owns no
// clock: every reveal, inspection and action uses the caller's one step clock.
// At most one action runs per poll; earlier fields need not stay visible after
// scrolling to a later field or the save control.
class SequentialGate {
  public:
    struct Action {
        QString name;
        std::function<QQuickItem *()> target;
        std::function<QVariantMap(QQuickItem *)> inspect;
        std::function<void(QQuickItem *)> perform;
    };
    enum Result { Waiting, Performed, Expired, Failed };
    Result poll(const ElapsedClock &elapsedMs, int deadlineMs, const std::vector<Action> &actions) {
        // The guard is set before any caller-owned callback, including clock
        // and lookup callbacks, can reenter through synchronous QML signals.
        if (busy) return Waiting;
        if (failed) return Failed;
        if (expired) return Expired;
        busy = true;
        struct BusyGuard {
            bool &value;
            ~BusyGuard() { value = false; }
        } guard{busy};
        try {
            ++polls;
            auto now = elapsedMs();
            if (now >= deadlineMs) return expire();
            if (actions.empty() || actions.size() > ObservationLimit)
                throw std::invalid_argument("READINESS_SEQUENCE_ACTION_COUNT");
            if (records.empty()) {
                for (size_t i = 0; i < actions.size(); ++i) {
                    Record record;
                    record.name = actions[i].name.left(80);
                    record.index = static_cast<int>(i);
                    records.push_back(record);
                }
            }
            if (records.size() != actions.size())
                throw std::invalid_argument("READINESS_SEQUENCE_CHANGED");
            for (size_t i = 0; i < records.size(); ++i)
                if (records[i].name != actions[i].name.left(80))
                    throw std::invalid_argument("READINESS_SEQUENCE_CHANGED");
            if (next == records.size()) return Performed;
            auto &record = records[next];
            const auto &action = actions[next];
            ++record.polls;
            QPointer<QQuickItem> target = action.target();
            now = elapsedMs();
            if (now >= deadlineMs) return expire();
            const auto reveal = revealCenter(target, elapsedMs, deadlineMs);
            now = elapsedMs();
            if (reveal.value("expired").toBool() || now >= deadlineMs) {
                observe(record, now, {}, reveal);
                return expire();
            }
            const auto state = boundedState(action.inspect(target));
            now = elapsedMs();
            observe(record, now, state, reveal);
            if (now >= deadlineMs) return expire();
            if (!target || !reveal.value("geometryValid").toBool() || !state.value("ready").toBool())
                return Waiting;
            // This is intentionally separate from the check after inspection.
            // Metadata collection cannot grant more time to start an input.
            now = elapsedMs();
            if (now >= deadlineMs) return expire();
            record.attempted = true;
            record.actionElapsedMs = now;
            action.perform(target);
            record.performed = true;
            ++next;
            now = elapsedMs();
            if (now >= deadlineMs) return expire();
            return next == records.size() ? Performed : Waiting;
        } catch (...) {
            // A callback may have sent input before throwing. Latch the whole
            // sequence so a later poll cannot retry that action automatically.
            failed = true;
            if (next < records.size()) records[next].failed = true;
            throw;
        }
    }
    QVariantMap metadata() const {
        QVariantList actions;
        for (const auto &record : records)
            actions.append(QVariantMap{{"name", record.name}, {"index", record.index},
                                       {"polls", record.polls}, {"attempted", record.attempted},
                                       {"performed", record.performed}, {"failed", record.failed},
                                       {"actionElapsedMs", record.actionElapsedMs},
                                       {"samples", record.samples}, {"last", record.last}});
        return {{"polls", polls}, {"actionIndex", static_cast<int>(next)},
                {"performed", !records.empty() && next == records.size()},
                {"expired", expired}, {"failed", failed}, {"busy", busy},
                {"actions", actions}, {"sampleLimit", ObservationLimit},
                {"scrollLimit", ObservationLimit}, {"actionLimit", ObservationLimit},
                {"pollIntervalMs", 100}};
    }
    void resetForNextStep() { if (!busy) *this = {}; }
  private:
    struct Record {
        QString name;
        int index = 0, polls = 0;
        bool attempted = false, performed = false, failed = false;
        qint64 actionElapsedMs = -1;
        QVariantList samples;
        QVariantMap last;
    };
    static QVariantMap boundedState(const QVariantMap &state) {
        QVariantMap bounded;
        for (const auto *key : {"found", "enabled", "visible", "inputPointInsideClip", "surfaceClosed", "ready"})
            bounded[key] = state.value(key).toBool();
        for (const auto *key : {"visibleWidth", "visibleHeight"}) {
            bool ok = false;
            const auto value = state.value(key).toDouble(&ok);
            if (ok && std::isfinite(value)) bounded[key] = value;
        }
        return bounded;
    }
    static void observe(Record &record, qint64 now, const QVariantMap &state, const QVariantMap &reveal) {
        QVariantMap sample{{"elapsedMs", now}, {"state", state}, {"reveal", reveal}};
        if (record.samples.size() < ObservationLimit) record.samples.append(sample);
        record.last = sample;
    }
    Result expire() {
        expired = true;
        return Expired;
    }
    bool busy = false, failed = false, expired = false;
    int polls = 0;
    size_t next = 0;
    std::vector<Record> records;
};
} // namespace NativeControlReadiness
