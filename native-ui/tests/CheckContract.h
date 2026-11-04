#pragma once
#include "ControlReadiness.h"
#include <QColor>
#include <QImage>
#include <QMetaObject>
#include <QMetaType>
#include <QPointer>
#include <QQmlContext>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickWindow>
#include <QStringList>
#include <QVariantMap>
#include <algorithm>
#include <cmath>
#include <optional>
#include <stdexcept>
#include <vector>

// Shared check conventions; see docs/NATIVE-CHECK-INFRA-20261019.md. Every
// helper here is test-side observation: none sends input, writes QML state,
// retries, or grants a deadline more time. Each one exists because a past
// batch stopped on the measurement itself rather than on the product.
namespace NativeCheck {
inline constexpr int ObservationLimit = NativeControlReadiness::ObservationLimit;

// ---- Failures carry the values that were observed --------------------------
// A bare error code made several batches spend their next run on diagnostics.
// Only identities, enumerations, numbers and booleans are printed; any other
// string is reduced to its length so memory text or input never leaves.
namespace detail {
inline bool identityKey(const QString &key) {
    static const QStringList exact{"id", "name", "class", "kind", "status", "reason", "phase",
                                   "scope", "result", "control", "command", "verb"};
    static const QStringList suffixes{"Id", "Name", "Class", "Kind", "Status", "Reason", "Phase",
                                      "Scope", "Result", "Control", "Command"};
    if (exact.contains(key)) return true;
    for (const auto &suffix : suffixes)
        if (key.endsWith(suffix)) return true;
    return false;
}
inline bool numeric(const QVariant &value) {
    switch (value.metaType().id()) {
    case QMetaType::Int: case QMetaType::UInt: case QMetaType::LongLong: case QMetaType::ULongLong:
    case QMetaType::Double: case QMetaType::Float: case QMetaType::Short: case QMetaType::UShort:
        return true;
    default:
        return false;
    }
}
inline QString describeValue(const QString &key, const QVariant &value, int depth);
inline QString describeMap(const QVariantMap &map, int depth) {
    QStringList parts;
    for (auto it = map.cbegin(); it != map.cend(); ++it) {
        if (parts.size() == 24) { parts.append("…"); break; }
        parts.append(it.key().left(48) + "=" + describeValue(it.key(), it.value(), depth));
    }
    return parts.join(", ");
}
inline QString describeValue(const QString &key, const QVariant &value, int depth) {
    if (!value.isValid() || value.isNull()) return "null";
    if (value.metaType().id() == QMetaType::Bool) return value.toBool() ? "true" : "false";
    if (numeric(value)) {
        const double number = value.toDouble();
        return std::isfinite(number) ? QString::number(number, 'g', 10) : QString("nonfinite");
    }
    if (value.metaType().id() == QMetaType::QString) {
        const auto text = value.toString();
        if (!identityKey(key)) return QString("<text:%1>").arg(text.size());
        auto shown = text.left(80);
        shown.replace('\n', ' ').replace('\r', ' ');
        return text.size() > 80 ? shown + "…" : shown;
    }
    if (value.metaType().id() == QMetaType::QVariantMap)
        return depth >= 2 ? QString("{…}") : "{" + describeMap(value.toMap(), depth + 1) + "}";
    if (value.metaType().id() == QMetaType::QVariantList || value.metaType().id() == QMetaType::QStringList)
        return QString("[%1 items]").arg(value.toList().size());
    return QString("<%1>").arg(QString::fromLatin1(value.metaType().name()).left(40));
}
} // namespace detail

// The code stays first and is followed by one space, so a runner that matches
// failure codes by prefix keeps matching after values are appended.
inline QString describe(const QString &code, const QVariantMap &observed) {
    const auto body = detail::describeMap(observed, 0);
    return (code + " {" + body + "}").left(code.size() + 900);
}
[[noreturn]] inline void fail(const QString &code, const QVariantMap &observed) {
    throw std::runtime_error(describe(code, observed).toStdString());
}
inline void require(bool ok, const QString &code, const QVariantMap &observed) {
    if (!ok) fail(code, observed);
}

inline QVariantMap identity(const QQuickItem *item) {
    if (!item) return {{"found", false}};
    return {{"found", true}, {"objectName", item->objectName().left(80)},
            {"className", QString::fromLatin1(item->metaObject()->className()).left(80)}};
}

// ---- Text contrast -----------------------------------------------------------
// WCAG 2 contrast ratio between two opaque colors (1 to 21).
inline double relativeLuminance(const QColor &color) {
    const auto channel = [](double value) {
        return value <= 0.03928 ? value / 12.92 : std::pow((value + 0.055) / 1.055, 2.4);
    };
    return 0.2126 * channel(color.redF()) + 0.7152 * channel(color.greenF()) + 0.0722 * channel(color.blueF());
}
inline double contrastRatio(const QColor &a, const QColor &b) {
    const double la = relativeLuminance(a), lb = relativeLuminance(b);
    return (std::max(la, lb) + 0.05) / (std::min(la, lb) + 0.05);
}
// Rendered contrast of a left-aligned single-line Text in a window capture.
// The region is the glyph run (leftPadding to contentWidth) over the item's
// full height, so glyphs stay a minority: the median-luminance pixel stands
// for the background and the pixel farthest from it for the glyph core.
// This reads what was painted, including the translucent material behind.
inline QVariantMap renderedTextContrast(const QImage &capture, const QQuickItem *text) {
    QVariantMap observed{{"label", identity(text)}};
    if (!text || capture.isNull()) return observed;
    const double padding = text->property("leftPadding").toDouble();
    const double width = text->property("contentWidth").toDouble();
    const QRectF scene = text->mapRectToScene(QRectF(padding, 0, width, text->height()));
    const double ratio = capture.devicePixelRatio();
    const QRect pixels = QRectF(scene.topLeft() * ratio, scene.bottomRight() * ratio).toAlignedRect() &
                         capture.rect();
    observed.insert({{"sceneX", scene.x()}, {"sceneY", scene.y()}, {"sceneWidth", scene.width()},
                     {"sceneHeight", scene.height()}, {"pixelCount", pixels.width() * pixels.height()}});
    if (pixels.width() < 4 || pixels.height() < 4) return observed;
    std::vector<std::pair<double, QColor>> samples;
    samples.reserve(size_t(pixels.width()) * size_t(pixels.height()));
    for (int y = pixels.top(); y <= pixels.bottom(); ++y)
        for (int x = pixels.left(); x <= pixels.right(); ++x) {
            const QColor color = QColor::fromRgb(capture.pixel(x, y));
            samples.emplace_back(relativeLuminance(color), color);
        }
    std::nth_element(samples.begin(), samples.begin() + samples.size() / 2, samples.end(),
                     [](const auto &a, const auto &b) { return a.first < b.first; });
    const QColor background = samples[samples.size() / 2].second;
    double best = 1;
    QColor glyph = background;
    for (const auto &sample : samples) {
        const double value = contrastRatio(sample.second, background);
        if (value > best) { best = value; glyph = sample.second; }
    }
    observed.insert({{"background", background.name()}, {"glyph", glyph.name()},
                     {"contrast", std::round(best * 100) / 100}});
    return observed;
}

// ---- Which item would take a left press at a scene point -------------------
// Finding a control by name and pressing its center does not prove the press
// reaches it: an overlay, a stale delegate or a clipping ancestor can take it.
// This walks the visual tree in paint order like Qt's delivery does for mouse
// buttons. It does not model pointer handlers or childMouseEventFilter, so a
// result other than "target"/"descendant" is evidence to read, not a verdict
// on Qt's delivery. One pointer-handler case is modelled: a plain Item whose
// only handlers are PointHandlers (see passivePointObserver). An item that keeps the left button but ignores ordinary
// presses (a Text keeps it for links) is still reported as the acceptor, so
// over another control it reads as "other" although Qt passes the press on.
struct Hit {
    QPointer<QQuickItem> acceptor;
    QString result = "unavailable"; // target | descendant | ancestor | other | none | unavailable
    QVariantList containing;        // deepest first, bounded
    int containingCount = 0;
    QVariantList passiveObservers;  // skipped passive observers, bounded
    int passiveObserverCount = 0;
    bool accepted() const { return result == "target" || result == "descendant"; }
    QVariantMap metadata() const {
        auto who = identity(acceptor);
        return {{"hitResult", result}, {"acceptorFound", who.value("found")},
                {"acceptorName", who.value("objectName")}, {"acceptorClass", who.value("className")},
                {"containing", containing}, {"containingCount", containingCount},
                {"passiveObservers", passiveObservers}, {"passiveObserverCount", passiveObserverCount},
                {"containingLimit", ObservationLimit}};
    }
};
namespace detail {
inline const QMetaObject *nativeClass(const QObject *object) {
    // QML adds derived meta-objects (QQuickItem_QML_12) for inline types.
    const QMetaObject *meta = object ? object->metaObject() : nullptr;
    while (meta && QByteArray(meta->className()).contains("_QML_")) meta = meta->superClass();
    return meta;
}
// Qt makes an item with pointer handlers accept every mouse button, so the
// tree walk alone reports it as the acceptor. A plain Item cannot take a press
// itself, and a PointHandler only ever grabs passively, so Qt keeps delivering
// the press to the items beneath. TaskPanel's full-window
// candidatePointerObservationLayer is one (memory page, profile fields r1 v4).
// Any other handler type can take an exclusive grab and is still reported.
inline bool passivePointObserver(const QQuickItem *item) {
    const auto *meta = nativeClass(item);
    if (!meta || qstrcmp(meta->className(), "QQuickItem") != 0) return false;
    int handlers = 0;
    for (const QObject *child : item->children()) {
        if (!child->inherits("QQuickPointerHandler")) continue;
        const auto *kind = nativeClass(child);
        if (!kind || qstrcmp(kind->className(), "QQuickPointHandler") != 0) return false;
        ++handlers;
    }
    return handlers > 0;
}
inline QQuickItem *acceptorAt(QQuickItem *item, const QPointF &scene, Hit &hit, int depth) {
    // Disabled and hidden subtrees receive nothing; items beneath them still can.
    if (!item || !item->isVisible() || !item->isEnabled() || depth > 96) return nullptr;
    const bool inside = item->contains(item->mapFromScene(scene));
    if (item->clip() && !inside) return nullptr;
    auto children = item->childItems();
    std::vector<QQuickItem *> ordered(children.cbegin(), children.cend());
    // Paint order: ascending z, declaration order within equal z. Topmost first.
    std::stable_sort(ordered.begin(), ordered.end(),
                     [](const QQuickItem *a, const QQuickItem *b) { return a->z() < b->z(); });
    for (auto it = ordered.rbegin(); it != ordered.rend(); ++it)
        if (auto *found = acceptorAt(*it, scene, hit, depth + 1)) return found;
    if (!inside) return nullptr;
    ++hit.containingCount;
    if (hit.containing.size() < ObservationLimit) hit.containing.append(identity(item));
    if (!item->acceptedMouseButtons().testFlag(Qt::LeftButton)) return nullptr;
    // MouseArea.enabled is MouseArea's own property, not Item.enabled: when it
    // is false the area ignores mouse events while isEnabled() stays true.
    if (item->inherits("QQuickMouseArea") && !item->property("enabled").toBool()) return nullptr;
    if (passivePointObserver(item)) {
        ++hit.passiveObserverCount;
        if (hit.passiveObservers.size() < ObservationLimit) hit.passiveObservers.append(identity(item));
        return nullptr;
    }
    return item;
}
} // namespace detail
inline Hit hitTest(QQuickWindow *window, const QPointF &scene, const QQuickItem *target) {
    Hit hit;
    if (!window || !window->contentItem() || !NativeControlReadiness::finiteGeometry(scene)) return hit;
    hit.acceptor = detail::acceptorAt(window->contentItem(), scene, hit, 0);
    if (!hit.acceptor) hit.result = "none";
    else if (hit.acceptor.data() == target) hit.result = "target";
    else if (target && target->isAncestorOf(hit.acceptor)) hit.result = "descendant";
    else if (target && hit.acceptor->isAncestorOf(target)) hit.result = "ancestor";
    else hit.result = "other";
    return hit;
}

// ---- Who owns active focus, not only how often it moved --------------------
// A bare activeFocusItemChanged count (2 where 0 was expected) could not tell a
// stolen focus from a destroyed delegate handing focus back to its scope.
class FocusTrace {
public:
    explicit FocusTrace(QQuickWindow *window) : m_window(window) {
        if (!window) return;
        m_initial = identity(window->activeFocusItem());
        m_connection = QObject::connect(window, &QQuickWindow::activeFocusItemChanged, window, [this] {
            ++m_count;
            if (m_changes.size() == ObservationLimit) { ++m_overflow; return; }
            auto *owner = m_window ? m_window->activeFocusItem() : nullptr;
            auto entry = identity(owner);
            entry.insert({{"ordinal", m_count}, {"visible", owner && owner->isVisible()}});
            m_changes.append(entry);
        });
    }
    ~FocusTrace() { QObject::disconnect(m_connection); }
    FocusTrace(const FocusTrace &) = delete;
    FocusTrace &operator=(const FocusTrace &) = delete;
    bool armed() const { return bool(m_connection); }
    int count() const { return m_count; }
    QVariantMap metadata() const {
        return {{"armed", armed()}, {"count", m_count}, {"overflow", m_overflow}, {"initial", m_initial},
                {"current", identity(m_window ? m_window->activeFocusItem() : nullptr)},
                {"changes", m_changes}, {"changeLimit", ObservationLimit}};
    }
private:
    QPointer<QQuickWindow> m_window;
    QMetaObject::Connection m_connection;
    QVariantMap m_initial;
    QVariantList m_changes;
    int m_count = 0, m_overflow = 0;
};

// ---- Find by objectName in the visual tree ---------------------------------
// Repeater delegates and other dynamically created items are reached through
// childItems(); a QObject-tree findChild() is not a substitute. A name that
// matches more than once yields no item, never an arbitrary one.
struct VisualMatch {
    QPointer<QQuickItem> item;
    int matches = 0;
    QVariantMap metadata() const { return {{"matches", matches}, {"unique", matches == 1}}; }
};
inline VisualMatch findVisual(QQuickItem *root, const QString &objectName, bool visibleOnly = false) {
    VisualMatch out;
    QQuickItem *candidate = nullptr;
    std::vector<QQuickItem *> pending{root};
    while (!pending.empty()) {
        auto *item = pending.back();
        pending.pop_back();
        if (!item || (visibleOnly && !item->isVisible())) continue;
        if (item->objectName() == objectName) { candidate = item; ++out.matches; }
        for (auto *child : item->childItems()) pending.push_back(child);
    }
    if (out.matches == 1) out.item = candidate;
    return out;
}

// ---- Call a QML function ---------------------------------------------------
// A QML function without type annotations returns QVariant and takes QVariant
// arguments. Asking for a bool return fails with a return type mismatch.
struct QmlCall {
    bool invoked = false;
    QVariant value;
    QString reason;
    QVariantMap metadata() const {
        return {{"invoked", invoked}, {"reason", reason}, {"valueValid", value.isValid()},
                {"valueTypeName", QString::fromLatin1(value.metaType().name()).left(40)}};
    }
};
inline QmlCall invokeQml(QObject *object, const char *method, const QVariantList &args = {}) {
    QmlCall out;
    if (!object) { out.reason = "object-unavailable"; return out; }
    if (args.size() > 3) { out.reason = "too-many-arguments"; return out; }
    QVariant value;
    switch (args.size()) {
    case 0: out.invoked = QMetaObject::invokeMethod(object, method, Q_RETURN_ARG(QVariant, value)); break;
    case 1: out.invoked = QMetaObject::invokeMethod(object, method, Q_RETURN_ARG(QVariant, value),
                                                    Q_ARG(QVariant, args[0])); break;
    case 2: out.invoked = QMetaObject::invokeMethod(object, method, Q_RETURN_ARG(QVariant, value),
                                                    Q_ARG(QVariant, args[0]), Q_ARG(QVariant, args[1])); break;
    default: out.invoked = QMetaObject::invokeMethod(object, method, Q_RETURN_ARG(QVariant, value),
                                                     Q_ARG(QVariant, args[0]), Q_ARG(QVariant, args[1]),
                                                     Q_ARG(QVariant, args[2])); break;
    }
    if (!out.invoked) out.reason = "invoke-failed";
    out.value = value;
    return out;
}

// ---- Read an attached property such as Accessible.role ---------------------
// An attached property resolves only through the item's own QML context.
// Without it QQmlProperty is invalid and read() is an invalid QVariant whose
// toInt() is 0, which once read as "the role is 0".
struct AttachedRead {
    bool contextValid = false, propertyValid = false, valueValid = false;
    QVariant value;
    std::optional<int> integer() const {
        if (!valueValid) return std::nullopt;
        const auto type = value.metaType();
        if (type.id() != QMetaType::Int && !type.flags().testFlag(QMetaType::IsEnumeration)) return std::nullopt;
        bool ok = false;
        const int result = value.toInt(&ok);
        return ok ? std::optional<int>(result) : std::nullopt;
    }
    QVariantMap metadata() const {
        QVariantMap out{{"contextValid", contextValid}, {"propertyValid", propertyValid},
                        {"valueValid", valueValid},
                        {"valueTypeName", QString::fromLatin1(value.metaType().name()).left(40)}};
        if (const auto number = integer()) out["integerValue"] = *number;
        if (valueValid && value.metaType().id() == QMetaType::QString) out["textLength"] = value.toString().size();
        return out;
    }
};
inline AttachedRead readAttached(QQuickItem *item, const QString &path) {
    AttachedRead out;
    auto *context = item ? qmlContext(item) : nullptr;
    out.contextValid = context && context->isValid();
    if (!out.contextValid) return out;
    const QQmlProperty property(item, path, context);
    out.propertyValid = property.isValid() && property.isProperty();
    if (!out.propertyValid) return out;
    out.value = property.read();
    out.valueValid = out.value.isValid();
    return out;
}

// ---- Which signals one real input produces, per control kind ---------------
// Signals only admit an input; the business effect (request, receipt and
// authoritative read-back) decides the result. A Switch toggles before it is
// triggered: when onToggled starts a save that disables the switch, the
// trigger sees it disabled and clicked is not emitted. Requiring clicked == 1
// for every control was the r9 mistake.
enum class ControlKind { Button, Tab, Switch };
struct InputSignals {
    bool observerValid = false;
    int mouseDispatchCount = 0;
    std::optional<qint64> clicked, toggled;
};
inline QString controlKindName(ControlKind kind) {
    switch (kind) {
    case ControlKind::Button: return "button";
    case ControlKind::Tab: return "tab";
    case ControlKind::Switch: return "switch";
    }
    return "unknown";
}
inline QString inputContractFailure(ControlKind kind, const InputSignals &counts) {
    if (!counts.observerValid) return "signal-observer-unavailable";
    if (counts.mouseDispatchCount != 1) return "mouse-dispatch-count";
    if (!counts.clicked || *counts.clicked < 0) return "clicked-signal-count";
    if (kind == ControlKind::Switch) {
        if (*counts.clicked > 1) return "clicked-signal-count";
        if (!counts.toggled || *counts.toggled != 1) return "toggled-signal-count";
        return {};
    }
    // A Tab is a button whose selection must then be read from product state.
    return *counts.clicked == 1 ? QString() : QString("clicked-signal-count");
}
inline QVariantMap describeSignals(ControlKind kind, const InputSignals &counts) {
    return {{"controlKind", controlKindName(kind)}, {"observerValid", counts.observerValid},
            {"mouseDispatchCount", counts.mouseDispatchCount},
            {"clickedSignals", counts.clicked ? QVariant::fromValue(*counts.clicked) : QVariant{}},
            {"toggledSignals", counts.toggled ? QVariant::fromValue(*counts.toggled) : QVariant{}},
            {"contractReason", inputContractFailure(kind, counts)}};
}

// ---- Evidence for the legacy name-and-center click -------------------------
// Old checks still press a control's center after finding it by name. This log
// changes none of their pass conditions; it keeps the last few presses and the
// first suspicious one (point clipped or taken by another item), so a later
// failure can be read without spending a run on diagnostics.
class LegacyClickLog {
public:
    void record(const QString &controlName, QQuickItem *item, QQuickWindow *window, const QPointF &point) {
        ++m_total;
        QVariantMap entry{{"ordinal", m_total}, {"control", controlName.left(80)}, {"found", item != nullptr}};
        bool suspect = item == nullptr;
        if (item && window) {
            const auto clip = NativeControlReadiness::visibleRect(item, window);
            const bool finitePoint = NativeControlReadiness::finiteGeometry(point);
            const bool inside = finitePoint && clip.contains(point);
            entry.insert({{"visible", item->isVisible()}, {"enabled", item->isEnabled()},
                          {"effectiveOpacity", NativeControlReadiness::effectiveOpacity(item)},
                          {"geometry", NativeControlReadiness::itemGeometry(item)},
                          {"visibleWidth", clip.width()}, {"visibleHeight", clip.height()},
                          {"pointX", finitePoint ? QVariant(point.x()) : QVariant{}},
                          {"pointY", finitePoint ? QVariant(point.y()) : QVariant{}},
                          {"pointInsideClip", inside}});
            const auto hit = hitTest(window, point, item);
            auto hitData = hit.metadata();
            hitData.remove("containing");
            entry["hit"] = hitData;
            suspect = !inside || !hit.accepted();
        }
        entry["suspect"] = suspect;
        if (suspect) {
            ++m_suspects;
            if (m_firstSuspect.isEmpty()) m_firstSuspect = entry;
        }
        m_recent.append(entry);
        if (m_recent.size() > ObservationLimit) m_recent.removeFirst();
    }
    int total() const { return m_total; }
    int suspects() const { return m_suspects; }
    QVariantMap metadata() const {
        return {{"scope", "evidence-only"}, {"total", m_total}, {"suspectCount", m_suspects},
                {"firstSuspect", m_firstSuspect}, {"recent", m_recent}, {"recentLimit", ObservationLimit}};
    }
private:
    QVariantList m_recent;
    QVariantMap m_firstSuspect;
    int m_total = 0, m_suspects = 0;
};
} // namespace NativeCheck
