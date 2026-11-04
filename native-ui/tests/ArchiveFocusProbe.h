#pragma once
#include "ControlReadiness.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QJSValue>
#include <QVector>
#include <QMetaProperty>

// Read-only, bounded, shared native/GUI observation. No text, addresses, event
// pumping, focus changes or positioning calls occur in this probe.
class ArchiveFocusProbe final {
public:
    static QVariantMap rect(const QRectF &r) {
        return {{"x", r.x()}, {"y", r.y()}, {"width", r.width()}, {"height", r.height()}};
    }
    QString token(QQuickItem *item) {
        if (!item) return {};
        for (qsizetype i = 0; i < m_items.size(); ++i)
            if (m_items[i] == item) return "focus-" + QString::number(i + 1);
        if (m_items.size() >= 256) return "overflow";
        m_items.append(item);
        return "focus-" + QString::number(m_items.size());
    }
    static QVariantMap causalSnapshot(QQuickItem *drawer) {
        QVariant value;
        if (!drawer || !QMetaObject::invokeMethod(drawer, "focusCausalSnapshot", Q_RETURN_ARG(QVariant, value)))
            return {{"schema", "archive-focus-causal.v1"}, {"overflow", true}, {"events", QVariantList{}}};
        if (value.metaType() == QMetaType::fromType<QJSValue>()) value = value.value<QJSValue>().toVariant();
        return value.toMap();
    }
    static bool beginObservation(QQuickItem *drawer) {
        return drawer && QMetaObject::invokeMethod(drawer, "beginFocusObservation");
    }
    static QVariantMap selection(QQuickItem *body) {
        return {{"selectionStart", body ? body->property("selectionStart") : QVariant()},
            {"selectionEnd", body ? body->property("selectionEnd") : QVariant()},
            {"cursorPosition", body ? body->property("cursorPosition") : QVariant()}};
    }
    QVariantMap snapshot(QQuickWindow *window, QQuickItem *drawer) {
        auto *leaf = window ? window->activeFocusItem() : nullptr;
        QQuickItem *owner = nullptr;
        if (leaf && drawer) {
            QVariant result;
            QMetaObject::invokeMethod(drawer, "focusControl", Q_RETURN_ARG(QVariant, result),
                                      Q_ARG(QVariant, QVariant::fromValue(leaf)));
            if (result.metaType() == QMetaType::fromType<QJSValue>()) result = result.value<QJSValue>().toVariant();
            owner = result.value<QQuickItem *>();
            if (!owner) owner = qobject_cast<QQuickItem *>(result.value<QObject *>());
        }
        if (!owner) {
            for (auto *p = leaf; p; p = p->parentItem())
                if (p->property("focusPolicy").isValid()) { owner = p; break; }
            if (!owner) owner = leaf;
        }
        if (!m_window && window) m_window = window;
        QVariantMap out{{"windowToken", window && m_window == window ? "window-1" : "different-window"}, {"instanceToken", token(leaf)}, {"objectName", leaf ? leaf->objectName() : QString()},
            {"className", leaf ? QString::fromLatin1(leaf->metaObject()->className()) : QString()},
            {"owner", QVariantMap{{"instanceToken", token(owner)}, {"objectName", owner ? owner->objectName() : QString()},
                {"className", owner ? QString::fromLatin1(owner->metaObject()->className()) : QString()}}},
            {"visible", leaf && leaf->isVisible()}, {"enabled", leaf && leaf->isEnabled()},
            {"opacity", leaf ? NativeControlReadiness::effectiveOpacity(leaf) : 0.},
            {"rect", rect(leaf ? leaf->mapRectToScene(QRectF(QPointF(), leaf->size())) : QRectF())},
            {"windowRect", rect(window ? QRectF(0, 0, window->width(), window->height()) : QRectF())},
            {"intersection", rect(NativeControlReadiness::visibleRect(leaf, window))},
            {"focusReason", QVariant()}, {"focusReasonStatus", "absent"}, {"cursorRect", QVariant()}};
        QVariantList clips, scrolls, ancestry;
        bool foundReason = false; int ancestorCount = 0, clipCount = 0, scrollCount = 0;
        for (auto *p = leaf; p; p = p->parentItem()) {
            ++ancestorCount;
            if (ancestry.size() < 64) ancestry.append(QVariantMap{{"instanceToken", token(p)}, {"objectName", p->objectName()},
                {"className", QString::fromLatin1(p->metaObject()->className())}, {"visible", p->isVisible()},
                {"enabled", p->isEnabled()}, {"opacity", p->opacity()}, {"clip", p->clip()},
                {"isFlickable", p->inherits("QQuickFlickable")},
                {"rect", rect(p->mapRectToScene(QRectF(QPointF(), p->size())))}});
            if (!foundReason && p->property("focusReason").isValid()) {
                foundReason = true;
                const auto value = p->property("focusReason");
                const auto type = value.metaType();
                const bool integral = type.flags().testFlag(QMetaType::IsEnumeration) ||
                    type.id() == QMetaType::Int || type.id() == QMetaType::UInt ||
                    type.id() == QMetaType::LongLong || type.id() == QMetaType::ULongLong;
                bool converted = false; const auto reason = value.toLongLong(&converted);
                const bool known = integral && converted && reason >= 0 && reason <= 8;
                out["focusReasonStatus"] = known ? "known" : "invalid";
                // Explicit plain integer prevents QJsonValue::fromVariant from
                // serializing a Qt enum by its symbolic string name.
                if (known) out["focusReason"] = int(reason);
            }
            if (out["cursorRect"].isNull() && p->property("cursorRectangle").isValid())
                out["cursorRect"] = rect(p->mapRectToScene(p->property("cursorRectangle").toRectF()));
            if (p != leaf && p->clip()) ++clipCount;
            if (p != leaf && p->clip() && clips.size() < 63)
                clips.append(QVariantMap{{"instanceToken", token(p)}, {"objectName", p->objectName()},
                    {"rect", rect(p->mapRectToScene(QRectF(QPointF(), p->size())))}});
            if (p->inherits("QQuickFlickable")) ++scrollCount;
            if (p->inherits("QQuickFlickable") && scrolls.size() < 8) {
                const auto origin = p->property("originY").toDouble();
                const auto min = origin - p->property("topMargin").toDouble();
                scrolls.append(QVariantMap{{"instanceToken", token(p)}, {"objectName", p->objectName()},
                    {"y", p->property("contentY")}, {"contentHeight", p->property("contentHeight")},
                    {"height", p->height()}, {"minimumY", min},
                    {"maximumY", std::max(min, origin + p->property("contentHeight").toDouble() - p->height() + p->property("bottomMargin").toDouble())}});
            }
        }
        out["clipChain"] = clips; out["scrolls"] = scrolls; out["ancestry"] = ancestry;
        out["clipChainComplete"] = clipCount == clips.size();
        out["scrollsComplete"] = scrollCount == scrolls.size();
        out["ancestryComplete"] = ancestorCount == ancestry.size() && !ancestry.isEmpty() && window && ancestry.last().toMap()["instanceToken"] == token(window->contentItem());
        return out;
    }
    static QString context(const QVariantMap &record) {
        const auto after = record.value("after").toMap();
        return QString("[ARCHIVE_FOCUS_VISIBLE] index=%1 direction=%2 leaf=%3 owner=%4")
            .arg(record.value("index").toInt()).arg(record.value("direction").toString())
            .arg(after.value("instanceToken").toString()).arg(after.value("owner").toMap().value("objectName").toString());
    }
    static QByteArray json(const QVariantMap &trace) {
        return QJsonDocument(QJsonObject::fromVariantMap(trace)).toJson(QJsonDocument::Compact);
    }
private:
    QVector<QPointer<QQuickItem>> m_items;
    QPointer<QQuickWindow> m_window;
};
