#pragma once
#include "ControlReadiness.h"
#include <QCryptographicHash>
#include <QMetaEnum>
#include <QMetaProperty>

// A passive, bounded observation. Never reveals or scrolls the page and never
// pumps events: geometry describes the same frame as the surrounding check.
namespace CandidateHeaderProbe {
inline void find(QQuickItem *root, const QString &name, QList<QQuickItem *> &result) {
    if (!root) return;
    if (root->objectName() == name) result.append(root);
    for (auto *child : root->childItems()) find(child, name, result);
}
inline QQuickItem *one(QQuickItem *root, const QString &name) {
    QList<QQuickItem *> found; find(root, name, found);
    return found.size() == 1 ? found.front() : nullptr;
}
inline QQuickItem *scrollContent(QQuickItem *root) {
    if (!root) return nullptr;
    if (root->property("contentY").isValid()) return root;
    for (auto *child : root->childItems())
        if (auto *found = scrollContent(child)) return found;
    return nullptr;
}
inline QString expectedText(int pageNumber, int rows) {
    return QString("待确认 · 第%1批 · 本批%2条").arg(pageNumber > 0 ? pageNumber : 1).arg(rows);
}
inline QVariantMap passiveChildren(const QObject *root) {
    QList<const QObject *> pending;
    if (root) for (auto *child : root->children()) pending.append(child);
    int inspected = 0, mouseAreas = 0, pointerHandlers = 0;
    while (!pending.isEmpty() && inspected < 64) {
        const auto *child = pending.takeLast(); ++inspected;
        mouseAreas += child->inherits("QQuickMouseArea");
        pointerHandlers += child->inherits("QQuickPointerHandler");
        for (auto *descendant : child->children()) pending.append(descendant);
    }
    return {{"childrenInspected", inspected}, {"childScanComplete", pending.isEmpty()},
        {"mouseAreaChildren", mouseAreas}, {"pointerHandlerChildren", pointerHandlers}};
}
inline QVariantMap enumProperty(const QObject *object, const char *name) {
    const int index = object ? object->metaObject()->indexOfProperty(name) : -1;
    const bool exists = index >= 0;
    const auto property = exists ? object->metaObject()->property(index) : QMetaProperty();
    const bool readable = exists && property.isReadable();
    const bool enumProperty = exists && property.isEnumType() && property.enumerator().isValid();
    const QVariant raw = readable ? property.read(object) : QVariant();
    const bool readSucceeded = raw.isValid() && !raw.isNull();
    const bool enumType = enumProperty && readSucceeded && raw.metaType() == property.metaType() &&
        raw.metaType().flags().testFlag(QMetaType::IsEnumeration);
    bool conversionSucceeded = false;
    const int number = enumType ? raw.toInt(&conversionSucceeded) : 0;
    const bool memberValid = enumType && conversionSucceeded && property.enumerator().valueToKey(number);
    const bool valid = exists && readable && enumProperty && readSucceeded && enumType && conversionSucceeded && memberValid;
    // A raw enum QVariant becomes a key string in QJsonObject::fromVariantMap.
    // Only a validated member is emitted as a plain integer. Unknown stays null.
    return {{"value", valid ? QVariant(number) : QVariant()}, {"valid", valid},
        {"property", QVariantMap{{"exists", exists}, {"readable", readable}, {"enumProperty", enumProperty},
            {"readSucceeded", readSucceeded}, {"enumType", enumType},
            {"conversionSucceeded", conversionSucceeded}, {"memberValid", memberValid}}}};
}
inline QVariantMap inspect(QQuickWindow *window, const QVariantMap &page, int rows,
                           const QString &readId, const QString &scope, int generation, quint64 frame) {
    auto *root = window ? window->contentItem() : nullptr;
    auto *tasks = one(root, "memoryTasks");
    // The standalone production TaskPanel fixture keeps a different root name.
    if (!tasks) tasks = one(root, "fixtureTaskPanel");
    // Other drawers also instantiate TaskPanel. Uniqueness belongs to this
    // management surface, never a first matching hidden sibling drawer.
    QList<QQuickItem *> headers; find(tasks, "memoryCandidatePageInfo", headers);
    auto *header = headers.size() == 1 ? headers.front() : nullptr;
    auto *scroll = one(tasks, "memoryPageScroll");
    auto *content = scrollContent(scroll);
    auto *tabs = one(tasks, "memoryTabs");
    const double before = content ? content->property("contentY").toDouble() : 0;
    const auto geometry = NativeControlReadiness::wholeVisibility(header, window);
    const QString text = header ? header->property("text").toString() : QString();
    const auto hash = QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Sha256).toHex();
    const int number = page.value("pageNumber").toInt() > 0 ? page.value("pageNumber").toInt() : 1;
    const bool outside = header && scroll && header->parentItem() == scroll->parentItem() && !scroll->isAncestorOf(header);
    const auto textFormat = enumProperty(header, "textFormat");
    return {{"schema", "reverie.candidate-header.v1"}, {"objectName", "memoryCandidatePageInfo"},
        {"rootObjectName", tasks ? tasks->objectName() : QString()},
        {"objectCount", headers.size()}, {"outsideScroll", outside},
        {"page", tasks ? tasks->property("page") : QVariant()},
        {"tabIndex", tabs ? tabs->property("currentIndex") : QVariant()},
        {"live", page.value("live").toBool()}, {"busy", page.value("busy").toBool()},
        {"pageNumber", number}, {"count", rows}, {"readRequestId", readId},
        {"scope", scope}, {"generation", generation}, {"frameSerial", qint64(frame)},
        {"textLength", text.size()}, {"textSha256", QString::fromLatin1(hash)},
        {"textMatches", text == expectedText(number, rows)},
        {"className", header ? QString::fromLatin1(header->metaObject()->className()).left(96) : QString()},
        {"inheritsQuickText", header && header->inherits("QQuickText")},
        {"textFormat", textFormat.value("value")}, {"textFormatValid", textFormat.value("valid")},
        {"textFormatProperty", textFormat.value("property")},
        {"childInputObjects", passiveChildren(header)},
        {"activeFocus", header && header->hasActiveFocus()}, {"activeFocusOnTab", header && header->activeFocusOnTab()},
        {"acceptedMouseButtons", header ? int(header->acceptedMouseButtons()) : -1},
        {"contentWidth", header ? header->property("contentWidth") : QVariant()},
        {"contentHeight", header ? header->property("contentHeight") : QVariant()},
        {"geometry", geometry}, {"windowWidth", window ? window->width() : 0},
        {"windowHeight", window ? window->height() : 0},
        {"scrollFound", content != nullptr}, {"contentYBefore", before},
        {"contentYAfter", content ? content->property("contentY").toDouble() : 0}};
}
inline bool valid(const QVariantMap &value, bool visible) {
    const auto geometry = value.value("geometry").toMap();
    const auto children = value.value("childInputObjects").toMap();
    const auto textFormat = value.value("textFormat");
    const auto formatProperty = value.value("textFormatProperty").toMap();
    bool formatPropertyValid = true;
    for (const auto *key : {"exists", "readable", "enumProperty", "readSucceeded", "enumType", "conversionSucceeded", "memberValid"})
        formatPropertyValid = formatPropertyValid && formatProperty.value(key).metaType().id() == QMetaType::Bool &&
            formatProperty.value(key).toBool();
    const bool textFormatValid = value.value("textFormatValid").metaType().id() == QMetaType::Bool &&
        value.value("textFormatValid").toBool() && formatPropertyValid &&
        textFormat.metaType().id() == QMetaType::Int && textFormat.toInt() == 0;
    const bool identity = value.value("objectCount").toInt() == 1 && value.value("outsideScroll").toBool() &&
        value.value("textMatches").toBool() && value.value("textLength").toInt() <= 96 &&
        value.value("scrollFound").toBool() && value.value("contentYBefore") == value.value("contentYAfter") &&
        !value.value("activeFocus").toBool() && !value.value("activeFocusOnTab").toBool() &&
        value.value("inheritsQuickText").toBool() && textFormatValid &&
        children.value("childScanComplete").toBool() && children.value("mouseAreaChildren").toInt() == 0 &&
        children.value("pointerHandlerChildren").toInt() == 0 &&
        // The r1 real Text observations all reported NoButton. Keep that
        // exact passive-input contract; the layout cases also click the label.
        value.value("acceptedMouseButtons").metaType().id() == QMetaType::Int &&
        value.value("acceptedMouseButtons").toInt() == int(Qt::NoButton);
    return identity && geometry.value("visible").toBool() == visible && (!visible ||
        (geometry.value("fullyVisible").toBool() &&
         value.value("contentWidth").toDouble() <= geometry.value("sceneWidth").toDouble() + .5 &&
         value.value("contentHeight").toDouble() <= geometry.value("sceneHeight").toDouble() + .5));
}
// Passive layout acquisition; the caller owns the original clock and requests
// frames. This never changes contentY, focus, selection, or any request.
class StableRead {
public:
    enum Result { Waiting, Ready, Expired, Failed };
    Result poll(const QVariantMap &header, bool visible, qint64 elapsedMs, int deadlineMs,
                const QVariantMap &companionGeometry = {}) {
        if (m_result == Expired || m_result == Failed) return m_result;
        const bool clockChanged = m_polls > 0 && (elapsedMs < m_previousElapsed || deadlineMs != m_deadline || visible != m_visible);
        ++m_polls;
        m_previousElapsed = elapsedMs;
        m_last = header; m_last["elapsedMs"] = elapsedMs;
        m_lastCompanion = companionGeometry;
        m_deadline = deadlineMs; m_visible = visible;
        if (m_samples.size() < 6) m_samples.append(m_last);
        if (clockChanged || elapsedMs < 0 || deadlineMs <= 0) return m_result = Failed;
        if (elapsedMs >= deadlineMs) return m_result = Expired;
        const auto identity = binding(header);
        if (m_binding.isEmpty()) m_binding = identity;
        if (identity != m_binding) return m_result = Failed;
        const bool companionReady = companionGeometry.isEmpty() || companionGeometry.value("fullyVisible").toBool();
        if (!valid(header, visible) || !companionReady) {
            m_anchor.clear(); m_anchorCompanion.clear(); return m_result = Waiting;
        }
        const auto frame = header.value("frameSerial").toLongLong();
        if (frame < 0) return m_result = Failed;
        if (m_anchor.isEmpty() || !equivalent(m_anchor, header) ||
            !nearGeometry(m_anchorCompanion, companionGeometry) || elapsedMs < m_since || frame < m_frame) {
            m_anchor = header; m_anchor["elapsedMs"] = elapsedMs;
            m_anchorCompanion = companionGeometry; m_since = elapsedMs; m_frame = frame;
            return m_result = Waiting;
        }
        return m_result = elapsedMs - m_since >= 40 && frame > m_frame ? Ready : Waiting;
    }
    bool matches(const QVariantMap &header, const QVariantMap &companionGeometry = {}) const {
        return m_result == Ready && valid(header, m_visible) && equivalent(m_anchor, header) &&
            nearGeometry(m_anchorCompanion, companionGeometry) &&
            (companionGeometry.isEmpty() || companionGeometry.value("fullyVisible").toBool());
    }
    QVariantMap evidence() const {
        return {{"minimumStableMs", 40}, {"deadlineMs", m_deadline},
            {"elapsedMs", m_last.value("elapsedMs")}, {"stableSinceMs", m_anchor.isEmpty() ? QVariant{} : QVariant(m_since)},
            {"frameSerial", m_last.value("frameSerial")}, {"stableFrameSerial", m_anchor.isEmpty() ? QVariant{} : QVariant(m_frame)},
            {"polls", m_polls}, {"sampleLimit", 6}, {"samples", m_samples}, {"anchor", m_anchor},
            {"companionAnchor", m_anchorCompanion}, {"companionTerminal", m_lastCompanion},
            {"terminal", m_last}, {"terminalCount", m_result == Waiting ? 0 : 1},
            {"ready", m_result == Ready}, {"expired", m_result == Expired}, {"failed", m_result == Failed}};
    }
    void reset() { *this = {}; }
private:
    static QVariantMap binding(const QVariantMap &value) {
        QVariantMap out;
        for (const auto *key : {"rootObjectName", "objectName", "page", "tabIndex", "pageNumber", "count",
                                "readRequestId", "scope", "generation"}) out[key] = value.value(key);
        return out;
    }
    static bool nearGeometry(const QVariantMap &left, const QVariantMap &right) {
        if (left.isEmpty() || right.isEmpty()) return left.isEmpty() && right.isEmpty();
        for (const auto *key : {"found", "visible", "fullyVisible"})
            if (left.value(key) != right.value(key)) return false;
        for (const auto *key : {"sceneX", "sceneY", "sceneWidth", "sceneHeight", "clipX", "clipY", "clipWidth", "clipHeight"}) {
            bool a = false, b = false;
            const double x = left.value(key).toDouble(&a), y = right.value(key).toDouble(&b);
            if (!a || !b || !std::isfinite(x) || !std::isfinite(y) || std::abs(x-y) > .5) return false;
        }
        return true;
    }
    static bool equivalent(const QVariantMap &left, const QVariantMap &right) {
        if (binding(left) != binding(right) || !nearGeometry(left.value("geometry").toMap(), right.value("geometry").toMap())) return false;
        for (const auto *key : {"textLength", "textSha256", "live", "busy", "objectCount", "outsideScroll", "activeFocus", "activeFocusOnTab"})
            if (left.value(key) != right.value(key)) return false;
        for (const auto *key : {"contentWidth", "contentHeight", "contentYBefore", "contentYAfter", "windowWidth", "windowHeight"}) {
            bool a = false, b = false;
            const double x = left.value(key).toDouble(&a), y = right.value(key).toDouble(&b);
            if (!a || !b || !std::isfinite(x) || !std::isfinite(y) || std::abs(x-y) > .5) return false;
        }
        return true;
    }
    QVariantMap m_binding, m_anchor, m_last, m_anchorCompanion, m_lastCompanion;
    QVariantList m_samples;
    qint64 m_since = -1, m_frame = -1, m_previousElapsed = -1;
    int m_polls = 0, m_deadline = 0;
    bool m_visible = false;
    Result m_result = Waiting;
};

}
