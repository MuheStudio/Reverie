#pragma once

#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QStringList>
#include <QVariantMap>
#include <algorithm>
#include <cmath>
#include <functional>
#include <limits>

// Test-only discovery. All text interfaces below are public, read-only Qt
// queries. The caller owns waiting and the single real mouse gesture.
namespace ReadingSelectionProbe {
using Clock = std::function<qint64()>;
inline constexpr int CandidateLimit = 64;
inline constexpr int LineLimit = 32;

// The integration runner calls this gate only after live revalidation. Claim
// before either callback: even a reentrant clock/action or a thrown gesture
// cannot cause a second press on a later polling tick.
class OnceGesture {
public:
    bool attempted() const { return m_attempted; }
    bool completed() const { return m_completed; }
    bool failed() const { return m_failed; }
    bool run(const Clock &clock, qint64 deadline, const std::function<void()> &gesture) {
        if (m_attempted) return false;
        m_attempted = true;
        try {
            if (!clock || clock() >= deadline || !gesture) {
                m_failed = true;
                return false;
            }
            gesture();
            m_completed = true;
            return true;
        } catch (...) {
            m_failed = true;
            throw;
        }
    }
private:
    bool m_attempted = false;
    bool m_completed = false;
    bool m_failed = false;
};

struct Candidate {
    QString name;
    QString messageId;
    QPointer<QQuickItem> item;
    QPoint start;
    QPoint end;
    int firstPosition = -1;
    int lastPosition = -1;
    int trimmedLength = 0;
    bool isValid() const {
        return item && !messageId.isEmpty() && firstPosition >= 0 &&
               lastPosition > firstPosition && trimmedLength >= 4;
    }
};

struct ProbeResult {
    Candidate candidate;
    QVariantMap diagnostic;
    bool hasCandidate() const { return candidate.isValid(); }
};

inline QString acquisitionTimeoutCode(const QVariantMap &lastDiagnostic, const QString &fallback) {
    return lastDiagnostic.value("reason").toString() == "row-position-inconsistent"
        ? QStringLiteral("MOONROOM_READING_SELECTION_LAYOUT_INCONSISTENT") : fallback;
}

namespace detail {
inline const QString Prefix = QStringLiteral("chatMessage-");

inline QVariantMap rectMap(const QRectF &r) {
    return {{"x", r.x()}, {"y", r.y()}, {"width", r.width()}, {"height", r.height()}};
}
inline QVariantMap pointMap(const QPoint &p) { return {{"x", p.x()}, {"y", p.y()}}; }
inline bool finiteRect(const QRectF &r) {
    return std::isfinite(r.x()) && std::isfinite(r.y()) &&
           std::isfinite(r.width()) && std::isfinite(r.height());
}
inline bool inside(const QRectF &r, const QPointF &p) {
    return p.x() > r.left() && p.x() < r.right() &&
           p.y() > r.top() && p.y() < r.bottom();
}
inline bool sameLine(const QRectF &a, const QRectF &b) {
    return qAbs(a.top() - b.top()) < .01 && qAbs(a.bottom() - b.bottom()) < .01;
}
inline bool validUtf16Span(const QString &text, int first, int last) {
    if (first < 0 || last <= first || last > text.size()) return false;
    for (int i = first; i < last; ++i) {
        if (text.at(i).isLowSurrogate()) return false;
        if (text.at(i).isHighSurrogate()) {
            if (++i >= last || !text.at(i).isLowSurrogate()) return false;
        }
    }
    return true;
}

struct Queries {
    const Clock &clock;
    qint64 deadline;
    int count = 0;
    bool deadlineReached = false;
    qint64 lastLiveMs = -1;
    bool live() {
        if (deadlineReached) return false;
        const qint64 now = clock ? clock() : deadline;
        if (now >= deadline) {
            deadlineReached = true;
            return false;
        }
        lastLiveMs = now;
        return true;
    }
    template <typename Object, typename Value, typename Reader>
    bool read(const QPointer<Object> &object, Value &out, Reader reader) {
        if (!live() || !object) return false;
        ++count;
        out = reader(object.data());
        return live() && object;
    }
};

inline bool sceneRect(Queries &q, const QPointer<QQuickItem> &item, QRectF &out) {
    QRectF local;
    return q.read(item, local, [](auto *p) { return QRectF(QPointF(), p->size()); }) &&
           q.read(item, out, [&](auto *p) { return p->mapRectToScene(local); }) && finiteRect(out);
}

struct FoundItem {
    QPointer<QQuickItem> item;
    QString name;
    QRectF scene;
    bool geometryValid = true;
};

// Count all instantiated matches so truncation is explicit; only the first 64
// in scene order can receive eligibility or rendered-line inspection.
inline QList<FoundItem> collect(Queries &q, const QPointer<QQuickItem> &history,
                                bool &complete) {
    QList<FoundItem> found;
    QList<QPointer<QQuickItem>> pending{history};
    complete = true;
    while (!pending.isEmpty()) {
        const auto item = pending.takeLast();
        if (!item) { complete = false; continue; }
        QString name;
        if (!q.read(item, name, [](auto *p) { return p->objectName(); })) {
            complete = false;
            if (q.deadlineReached) { complete = false; break; }
            continue;
        }
        if (name.startsWith(Prefix)) {
            QRectF scene;
            const bool geometryValid = sceneRect(q, item, scene);
            found.append({item, name, scene, geometryValid});
            if (!geometryValid) complete = false;
            if (q.deadlineReached) break;
        }
        QList<QPointer<QQuickItem>> children;
        if (!q.read(item, children, [](auto *p) {
                QList<QPointer<QQuickItem>> guarded;
                for (auto *child : p->childItems()) guarded.append(child);
                return guarded;
            })) {
            complete = false;
            if (q.deadlineReached) { complete = false; break; }
            continue;
        }
        pending.append(children);
    }
    std::stable_sort(found.begin(), found.end(), [](const auto &a, const auto &b) {
        if (a.geometryValid != b.geometryValid) return a.geometryValid;
        if (!a.geometryValid) return a.name < b.name;
        if (a.scene.top() != b.scene.top()) return a.scene.top() < b.scene.top();
        if (a.scene.left() != b.scene.left()) return a.scene.left() < b.scene.left();
        return a.name < b.name;
    });
    return found;
}

struct ItemState {
    QPointer<QQuickItem> item;
    QString name;
    QString messageId;
    QString text; // Never copied into diagnostics.
    bool visible = true;
    bool enabled = true;
    qreal opacity = 1;
    QRectF scene;
    QRectF exposed;
    QList<QPointer<QQuickItem>> clips;
};

inline bool readState(Queries &q, const FoundItem &found,
                      const QPointer<QQuickWindow> &window, ItemState &state) {
    state.item = found.item;
    if (!q.read(state.item, state.name, [](auto *p) { return p->objectName(); }) ||
        !state.name.startsWith(Prefix)) return false;
    state.messageId = state.name.mid(Prefix.size());
    if (!q.read(state.item, state.text, [](auto *p) { return p->property("text").toString(); }) ||
        !sceneRect(q, state.item, state.scene)) return false;
    QSize windowSize;
    if (!q.read(window, windowSize, [](auto *p) { return p->size(); })) return false;
    state.exposed = state.scene.intersected(QRectF(QPointF(), windowSize));
    state.clips.append(state.item);
    auto ancestor = state.item;
    while (ancestor) {
        bool visible = false, enabled = false, clip = false;
        qreal opacity = 0;
        if (!q.read(ancestor, visible, [](auto *p) { return p->isVisible(); }) ||
            !q.read(ancestor, enabled, [](auto *p) { return p->isEnabled(); }) ||
            !q.read(ancestor, opacity, [](auto *p) { return p->opacity(); }) ||
            !q.read(ancestor, clip, [](auto *p) { return p->clip(); })) return false;
        state.visible = state.visible && visible;
        state.enabled = state.enabled && enabled;
        state.opacity *= opacity;
        if (clip) {
            QRectF clipped;
            if (!sceneRect(q, ancestor, clipped)) return false;
            state.exposed = state.exposed.intersected(clipped);
            if (ancestor != state.item) state.clips.append(ancestor);
        }
        QPointer<QQuickItem> parent;
        if (!q.read(ancestor, parent, [](auto *p) { return QPointer<QQuickItem>(p->parentItem()); }))
            return false;
        ancestor = parent;
    }
    return state.item && window && finiteRect(state.exposed);
}

inline QVariantMap stateRecord(const ItemState &s) {
    return {{"name", s.name}, {"messageId", s.messageId}, {"textLength", s.text.size()},
            {"visible", s.visible}, {"enabled", s.enabled}, {"effectiveOpacity", s.opacity},
            {"sceneRect", rectMap(s.scene)}, {"exposedRect", rectMap(s.exposed)},
            {"oldTextLengthGate", s.text.size() > 32}, {"oldWidthGate", s.exposed.width() > 180},
            {"oldHeightGate", s.exposed.height() > 50}, {"lineProbeCount", 0},
            {"linesTruncated", false}, {"bestSpan", QVariantMap{}}};
}

inline QStringList gateReasons(const ItemState &s, bool ready) {
    QStringList reasons;
    if (!ready) reasons.append("reading-not-ready");
    if (s.messageId.isEmpty()) reasons.append("missing-message-id");
    if (!s.visible) reasons.append("hidden");
    if (!s.enabled) reasons.append("disabled");
    if (!std::isfinite(s.opacity) || s.opacity <= .05) reasons.append("low-effective-opacity");
    if (s.text.size() <= 32) reasons.append("text-length-at-most-32");
    if (s.exposed.width() <= 180) reasons.append("exposed-width-at-most-180");
    if (s.exposed.isEmpty()) reasons.append("unexposed");
    return reasons;
}

struct RowPosition {
    int index = -1;
    QPointer<QQuickItem> item;
    qreal y = 0;
    qreal height = 0;

    QVariantMap record() const {
        QVariantMap value{{"index", index}, {"instantiated", !item.isNull()}};
        if (item) {
            value.insert("y", y);
            value.insert("height", height);
        }
        return value;
    }
};

inline bool readRowPosition(Queries &q, const QPointer<QQuickItem> &history, int index, int count,
                            RowPosition &row) {
    row.index = index;
    if (index < 0 || index >= count) return true;
    bool invoked = false;
    if (!q.read(history, invoked, [&](auto *list) {
            QQuickItem *item = nullptr;
            const bool ok = QMetaObject::invokeMethod(list, "itemAtIndex", Q_RETURN_ARG(QQuickItem *, item),
                                                       Q_ARG(int, index));
            row.item = item;
            return ok;
        }) || !invoked) return false;
    return !row.item ||
           (q.read(row.item, row.y, [](auto *item) { return item->y(); }) &&
            q.read(row.item, row.height, [](auto *item) { return item->height(); }) &&
            std::isfinite(row.y) && std::isfinite(row.height) && row.height >= 0);
}

inline bool readRowAdjacency(Queries &q, const QPointer<QQuickItem> &history, const ItemState &state,
                             QVariantMap &record) {
    const QString rowName = QStringLiteral("chatMessageRow-") + state.messageId;
    auto ancestor = state.item;
    while (ancestor && ancestor != history) {
        QString name;
        if (!q.read(ancestor, name, [](auto *item) { return item->objectName(); })) return false;
        if (name == rowName) break;
        QPointer<QQuickItem> parent;
        if (!q.read(ancestor, parent, [](auto *item) { return QPointer<QQuickItem>(item->parentItem()); }))
            return false;
        ancestor = parent;
    }
    if (!ancestor || ancestor == history) return false;

    bool indexKnown = false;
    int index = -1, count = 0;
    qreal spacing = 0;
    if (!q.read(ancestor, index, [&](auto *row) { return row->property("index").toInt(&indexKnown); }) || !indexKnown ||
        !q.read(history, count, [](auto *list) { return list->property("count").toInt(); }) ||
        !q.read(history, spacing, [](auto *list) { return list->property("spacing").toReal(); }) ||
        index < 0 || index >= count || !std::isfinite(spacing)) return false;

    RowPosition previous, target, next;
    if (!readRowPosition(q, history, index, count, target) || target.item != ancestor ||
        !readRowPosition(q, history, index - 1, count, previous) ||
        !readRowPosition(q, history, index + 1, count, next) || !target.item || !state.item)
        return false;

    const bool inconsistent = (previous.item && std::abs(target.y - (previous.y + previous.height + spacing)) >= 1) ||
                              (next.item && std::abs(next.y - (target.y + target.height + spacing)) >= 1);
    const bool hasNeighbor = previous.item || next.item;
    const QString status = inconsistent ? "inconsistent" : hasNeighbor ? "consistent" : "unavailable";
    record = {{"status", status}, {"observedAtMs", q.lastLiveMs}, {"spacing", spacing}, {"previous", previous.record()},
              {"target", target.record()}, {"next", next.record()}};
    return true;
}

inline bool positionAt(Queries &q, const QPointer<QQuickItem> &item, const QPointF &local,
                        int &position) {
    bool invoked = false;
    return q.read(item, invoked, [&](auto *p) {
        return QMetaObject::invokeMethod(p, "positionAt", Q_RETURN_ARG(int, position),
                                         Q_ARG(qreal, local.x()), Q_ARG(qreal, local.y()));
    }) && invoked;
}
inline bool positionRect(Queries &q, const QPointer<QQuickItem> &item, int position,
                          QRectF &rect) {
    bool invoked = false;
    return q.read(item, invoked, [&](auto *p) {
        return QMetaObject::invokeMethod(p, "positionToRectangle", Q_RETURN_ARG(QRectF, rect),
                                         Q_ARG(int, position));
    }) && invoked && finiteRect(rect) && rect.height() > 0;
}

inline bool pointInsideClips(Queries &q, const ItemState &state, const QPoint &point) {
    if (!inside(state.exposed, point)) return false;
    for (const auto &clip : state.clips) {
        QPointF local;
        QRectF bounds;
        if (!q.read(clip, local, [&](auto *p) { return p->mapFromScene(point); }) ||
            !q.read(clip, bounds, [](auto *p) { return QRectF(QPointF(), p->size()); }) ||
            !inside(bounds, local)) return false;
    }
    return true;
}

inline QVariantMap candidateMap(const Candidate &c) {
    return {{"name", c.name}, {"messageId", c.messageId}, {"start", pointMap(c.start)},
            {"end", pointMap(c.end)}, {"firstPosition", c.firstPosition},
            {"lastPosition", c.lastPosition}, {"utf16Length", c.lastPosition - c.firstPosition},
            {"trimmedLength", c.trimmedLength}};
}

// Reuse the exact integer scene coordinates passed to QTest, including their
// inverse mapping for hit tests. No floating-point-only successful hit exists.
inline bool hitSpan(Queries &q, const ItemState &state, const QPoint &start, const QPoint &end,
                     Candidate &candidate, QRectF &line) {
    if (start.y() != end.y() || end.x() <= start.x() ||
        !pointInsideClips(q, state, start) || !pointInsideClips(q, state, end)) return false;
    QPointF firstLocal, lastLocal;
    int first = -1, last = -1;
    QRectF firstRect, lastRect;
    if (!q.read(state.item, firstLocal, [&](auto *p) { return p->mapFromScene(start); }) ||
        !q.read(state.item, lastLocal, [&](auto *p) { return p->mapFromScene(end); }) ||
        !positionAt(q, state.item, firstLocal, first) ||
        !positionAt(q, state.item, lastLocal, last) ||
        !validUtf16Span(state.text, first, last) ||
        !positionRect(q, state.item, first, firstRect) ||
        !positionRect(q, state.item, last, lastRect) || !sameLine(firstRect, lastRect)) return false;
    QRectF sceneLine;
    if (!q.read(state.item, sceneLine, [&](auto *p) { return p->mapRectToScene(firstRect); }) ||
        !finiteRect(sceneLine) || sceneLine.top() < state.exposed.top() - .001 ||
        sceneLine.bottom() > state.exposed.bottom() + .001 ||
        start.y() <= sceneLine.top() || start.y() >= sceneLine.bottom()) return false;
    candidate = {state.name, state.messageId, state.item, start, end, first, last,
                 int(state.text.mid(first, last - first).trimmed().size())};
    line = firstRect;
    return true;
}

inline Candidate findLine(Queries &q, const ItemState &state, QVariantMap &record) {
    Candidate candidate;
    QPointF exposedTop, exposedBottom;
    if (!q.read(state.item, exposedTop, [&](auto *p) {
            return p->mapFromScene(QPointF(state.exposed.left() + 1, state.exposed.top()));
        }) || !q.read(state.item, exposedBottom, [&](auto *p) {
            return p->mapFromScene(QPointF(state.exposed.left() + 1, state.exposed.bottom()));
        })) return candidate;
    qreal y = exposedTop.y() + .125;
    qreal previousBottom = -std::numeric_limits<qreal>::infinity();
    int probed = 0;
    bool noMoreLines = false;
    QVariantMap best;
    int bestTrimmed = -1;
    while (probed < LineLimit && y < exposedBottom.y() && q.live()) {
        int seed = -1;
        QRectF line;
        if (!positionAt(q, state.item, QPointF(exposedTop.x(), y), seed) ||
            seed < 0 || seed > state.text.size() || !positionRect(q, state.item, seed, line)) break;
        if (line.bottom() <= previousBottom + .01) { noMoreLines = true; break; }
        previousBottom = line.bottom();
        ++probed;
        QRectF sceneLine;
        if (!q.read(state.item, sceneLine, [&](auto *p) { return p->mapRectToScene(line); })) break;
        if (sceneLine.top() >= state.exposed.top() - .001 &&
            sceneLine.bottom() <= state.exposed.bottom() + .001) {
            const int eventY = qRound(sceneLine.center().y());
            const int firstX = int(std::ceil(state.exposed.left() + 1));
            // The rightmost hit can be the next wrapped line's insertion
            // position. Try a small, fixed set of shorter same-line spans.
            for (const qreal fraction : {1., .75, .5, .25}) {
                const int lastX = int(std::floor(state.exposed.left() +
                    (state.exposed.width() - 2) * fraction));
                Candidate hit;
                QRectF hitLine;
                if (!hitSpan(q, state, QPoint(firstX, eventY), QPoint(lastX, eventY), hit, hitLine)) {
                    if (q.deadlineReached || !state.item) break;
                    continue;
                }
                if (hit.trimmedLength > bestTrimmed) {
                    bestTrimmed = hit.trimmedLength;
                    best = candidateMap(hit);
                    best.insert("lineRect", rectMap(hitLine));
                }
                if (hit.trimmedLength >= 4 && sameLine(line, hitLine)) {
                    candidate = hit;
                    break;
                }
            }
            if (candidate.isValid() || q.deadlineReached || !state.item) break;
        }
        // Public cursor geometry supplies the next rendered line boundary;
        // no fixed item-height requirement or arbitrary vertical stride.
        y = line.bottom() + .125;
    }
    const bool truncated = !candidate.isValid() && probed == LineLimit && !noMoreLines &&
                           y < exposedBottom.y();
    record.insert("lineProbeCount", probed);
    record.insert("linesTruncated", truncated);
    record.insert("bestSpan", best);
    return candidate;
}
} // namespace detail

inline ProbeResult probe(QQuickItem *history, QQuickWindow *window, bool readingReady,
                         const Clock &clock, qint64 deadline, bool checkRowAdjacency = false) {
    ProbeResult result;
    const QPointer<QQuickItem> guardedHistory(history);
    const QPointer<QQuickWindow> guardedWindow(window);
    detail::Queries q{clock, deadline};
    bool countComplete = false;
    const auto found = detail::collect(q, guardedHistory, countComplete);
    QVariantList records;
    QVariantMap rowAdjacency;
    bool rowInconsistent = false;
    bool anyLinesTruncated = false;
    for (int i = 0; i < qMin(CandidateLimit, int(found.size())); ++i) {
        if (!q.live() || !guardedHistory || !guardedWindow) break;
        detail::ItemState state;
        QVariantMap record{{"name", found.at(i).name}, {"lineProbeCount", 0},
                           {"geometryValid", found.at(i).geometryValid},
                           {"linesTruncated", false}, {"bestSpan", QVariantMap{}}};
        QStringList reasons;
        if (!found.at(i).geometryValid) {
            reasons.append("candidate-geometry-unavailable");
        } else if (!detail::readState(q, found.at(i), guardedWindow, state)) {
            reasons.append(q.deadlineReached ? "deadline-reached" : "item-unavailable");
        } else {
            record = detail::stateRecord(state);
            record.insert("geometryValid", true);
            reasons = detail::gateReasons(state, readingReady);
            if (reasons.isEmpty()) {
                result.candidate = detail::findLine(q, state, record);
                if (!result.hasCandidate())
                    reasons.append(q.deadlineReached ? "deadline-reached" : "no-complete-visible-line-span");
                else if (checkRowAdjacency) {
                    if (!detail::readRowAdjacency(q, guardedHistory, state, rowAdjacency)) {
                        result.candidate = {};
                        reasons.append(q.deadlineReached ? "deadline-reached" : "candidate-geometry-unavailable");
                    } else if (rowAdjacency.value("status").toString() == "inconsistent") {
                        result.candidate = {};
                        rowInconsistent = true;
                        reasons.append("row-position-inconsistent");
                    }
                    if (!rowAdjacency.isEmpty()) record.insert("rowAdjacency", rowAdjacency);
                }
            }
        }
        record.insert("reasons", reasons);
        anyLinesTruncated = anyLinesTruncated || record.value("linesTruncated").toBool();
        records.append(record);
        if (result.hasCandidate() || rowInconsistent || q.deadlineReached) break;
    }
    if (!q.live() || !guardedHistory || !guardedWindow) result.candidate = {};
    result.diagnostic = {{"readingReady", readingReady}, {"candidateCount", found.size()},
        {"candidateCountComplete", countComplete}, {"candidateLimit", CandidateLimit},
        {"inspectedCandidates", records.size()}, {"candidatesTruncated", found.size() > CandidateLimit},
        {"lineLimitPerItem", LineLimit}, {"anyLinesTruncated", anyLinesTruncated},
        {"deadlineReached", q.deadlineReached}, {"queryCount", q.count}, {"items", records},
        {"reason", result.hasCandidate() ? "candidate-found" :
            rowInconsistent ? "row-position-inconsistent" : q.deadlineReached ? "deadline-reached" : "no-candidate"}};
    if (!rowAdjacency.isEmpty()) result.diagnostic.insert("rowAdjacency", rowAdjacency);
    if (result.hasCandidate()) result.diagnostic.insert("selected", detail::candidateMap(result.candidate));
    return result;
}

inline ProbeResult probeBeforePress(QQuickItem *history, QQuickWindow *window, bool readingReady,
                                    const Clock &clock, qint64 deadline) {
    return probe(history, window, readingReady, clock, deadline, true);
}

inline bool revalidate(const Candidate &requested, QQuickItem *history, QQuickWindow *window,
                       bool readingReady, const Clock &clock, qint64 deadline,
                       Candidate *liveCandidate = nullptr, QVariantMap *diagnostic = nullptr,
                       bool checkRowAdjacency = false) {
    const Candidate expected = requested; // Input and output may be the same object.
    if (liveCandidate) *liveCandidate = {};
    const QPointer<QQuickItem> guardedHistory(history);
    const QPointer<QQuickWindow> guardedWindow(window);
    detail::Queries q{clock, deadline};
    QString reason;
    QVariantMap record;
    QVariantMap rowAdjacency;
    Candidate live;
    bool countComplete = false;
    const auto found = detail::collect(q, guardedHistory, countComplete);
    QPointer<QQuickItem> target;
    int matches = 0;
    for (const auto &entry : found) {
        if (entry.name == expected.name && entry.name.mid(detail::Prefix.size()) == expected.messageId) {
            target = entry.item;
            ++matches;
        }
    }
    if (!readingReady) reason = "reading-not-ready";
    else if (!q.live()) reason = "deadline-reached";
    else if (matches != 1 || !target) reason = "stable-target-unavailable";
    else if (!expected.item || target != expected.item) reason = "stable-target-replaced";
    else {
        detail::ItemState state;
        if (!detail::readState(q, {target, expected.name, {}}, guardedWindow, state)) {
            reason = "item-unavailable";
        } else if (state.name != expected.name || state.messageId != expected.messageId) {
            reason = "stable-target-identity-changed";
        } else {
            record = detail::stateRecord(state);
            const auto rejected = detail::gateReasons(state, readingReady);
            QRectF line;
            if (!rejected.isEmpty()) reason = rejected.join(',');
            else if (!detail::hitSpan(q, state, expected.start, expected.end, live, line) ||
                     !live.isValid()) reason = "rounded-hit-no-longer-valid";
            else if (live.firstPosition != expected.firstPosition || live.lastPosition != expected.lastPosition ||
                     live.trimmedLength != expected.trimmedLength) reason = "rounded-hit-span-changed";
            else {
                record.insert("bestSpan", detail::candidateMap(live));
                if (checkRowAdjacency) {
                    if (!detail::readRowAdjacency(q, guardedHistory, state, rowAdjacency))
                        reason = "candidate-geometry-unavailable";
                    else if (rowAdjacency.value("status").toString() == "inconsistent")
                        reason = "row-position-inconsistent";
                    if (!rowAdjacency.isEmpty()) record.insert("rowAdjacency", rowAdjacency);
                }
            }
        }
    }
    if (!q.live() && reason != "row-position-inconsistent") reason = "deadline-reached";
    if (!guardedHistory || !guardedWindow || !target || !expected.item || target != expected.item) {
        if (reason.isEmpty()) reason = "stable-target-unavailable";
    }
    const bool valid = reason.isEmpty() && live.isValid();
    if (valid && liveCandidate) *liveCandidate = live;
    if (diagnostic) *diagnostic = {{"valid", valid}, {"reason", valid ? "validated" : reason},
        {"deadlineReached", q.deadlineReached}, {"queryCount", q.count},
        {"candidateCount", found.size()}, {"candidateCountComplete", countComplete},
        {"candidateLimit", CandidateLimit}, {"candidatesTruncated", found.size() > CandidateLimit},
        {"lineLimitPerItem", LineLimit},
        {"item", record}};
    if (diagnostic && !rowAdjacency.isEmpty()) diagnostic->insert("rowAdjacency", rowAdjacency);
    return valid;
}

inline bool revalidateBeforePress(const Candidate &requested, QQuickItem *history, QQuickWindow *window,
                                  bool readingReady, const Clock &clock, qint64 deadline,
                                  Candidate *liveCandidate = nullptr, QVariantMap *diagnostic = nullptr) {
    return revalidate(requested, history, window, readingReady, clock, deadline, liveCandidate, diagnostic, true);
}
} // namespace ReadingSelectionProbe
