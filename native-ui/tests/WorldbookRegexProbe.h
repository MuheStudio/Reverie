#pragma once
#include "ArchiveInputProbe.h"
#include "CandidateHeaderProbe.h"
#include "CheckContract.h"
#include <algorithm>

// Passive observations shared by the regex driver and its controlled cases.
// They never focus, reveal, scroll, or pump events.
namespace WorldbookRegexProbe {
inline QVariant textFormat(const QObject *object) {
    // Qt 6.11.2 TextArea inherits this property and Q_ENUM from QQuickTextEdit.
    // A different QObject's enum member numbered zero is not this contract.
    if (!object || !object->inherits("QQuickTextEdit")) return {};
    const int index = object->metaObject()->indexOfProperty("textFormat");
    if (index < 0) return {};
    const auto property = object->metaObject()->property(index);
    const auto enumeration = property.enumerator();
    if (!property.isEnumType() || !enumeration.isValid()) return {};
    const auto *owner = property.enclosingMetaObject();
    bool plainMemberExists = false;
    const int plainMember = enumeration.keyToValue("PlainText", &plainMemberExists);
    if (!owner || QString::fromLatin1(owner->className()) != "QQuickTextEdit" ||
        enumeration.enclosingMetaObject() != owner || QString::fromLatin1(enumeration.scope()) != "QQuickTextEdit" ||
        QString::fromLatin1(enumeration.name()) != "TextFormat" || !plainMemberExists || plainMember != int(Qt::PlainText)) return {};
    const auto observation = CandidateHeaderProbe::enumProperty(object, "textFormat");
    const auto value = observation.value("value");
    return observation.value("valid").metaType().id() == QMetaType::Bool && observation.value("valid").toBool() &&
        value.metaType().id() == QMetaType::Int ? value : QVariant();
}
inline bool plainTextFormat(const QObject *object) {
    const auto value = textFormat(object);
    return value.isValid() && !value.isNull() && value.metaType().id() == QMetaType::Int && value.toInt() == 0;
}
inline QVariantMap rectMap(const QRectF &rect) {
    return {{"x",rect.x()},{"y",rect.y()},{"width",rect.width()},{"height",rect.height()}};
}
template <typename Require>
inline QVariantMap patternGeometry(QQuickItem *target, QQuickItem *viewport, QQuickWindow *window, Require require) {
    require(viewport && target, "REGEX_PATTERN_VIEWPORT_MISSING");
    const auto clip = NativeControlReadiness::visibleRect(target, window);
    const auto scene = target->mapRectToScene(QRectF(QPointF(), target->size()));
    const int start = target->property("selectionStart").toInt(), end = target->property("selectionEnd").toInt();
    QRectF beginRect, endRect;
    require(QMetaObject::invokeMethod(target,"positionToRectangle",Q_RETURN_ARG(QRectF,beginRect),Q_ARG(int,start)) &&
            QMetaObject::invokeMethod(target,"positionToRectangle",Q_RETURN_ARG(QRectF,endRect),Q_ARG(int,end)),
            "REGEX_PATTERN_POSITION_RECT_UNAVAILABLE");
    const QRectF selection = end > start ? target->mapRectToScene(QRectF(beginRect.x(),beginRect.y(),
        std::max<qreal>(1,endRect.x()-beginRect.x()),beginRect.height())) : QRectF();
    return {{"controlRect",rectMap(scene)},{"visibleRect",rectMap(clip)},
        {"viewportRect",rectMap(NativeControlReadiness::visibleRect(viewport,window))},
        {"selectionRect",rectMap(selection)},{"selectionStart",start},{"selectionEnd",end},
        {"cursorPosition",target->property("cursorPosition")},{"hasSelection",end>start},
        {"selectionFullyVisible",end>start && clip.contains(selection)},
        {"fullyVisible",clip.contains(scene)},{"focusInTarget",ArchiveInputProbe::keyboardFocusMatches(target,window)},
        {"textFormat",textFormat(target)}};
}
inline QVariantMap patternGeometry(QQuickItem *target, QQuickItem *viewport, QQuickWindow *window) {
    return patternGeometry(target, viewport, window, [](bool ok, const QString &code) {
        NativeCheck::require(ok, code, {});
    });
}
} // namespace WorldbookRegexProbe
