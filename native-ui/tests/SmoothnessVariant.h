#pragma once
#include <QJSValue>
#include <QQmlContext>
#include <QQmlEngine>
#include <QVariantMap>
#include <stdexcept>

namespace SmoothnessVariant {
inline int surfaceCount(QObject *compositor) {
    if(!compositor)throw std::runtime_error("SMOOTHNESS_COMPOSITOR_REQUIRED");
    const auto value=compositor->property("surfaces");
    if(value.metaType().id()==qMetaTypeId<QJSValue>()) {
        const auto array=value.value<QJSValue>();
        if(!array.isArray())throw std::runtime_error("SMOOTHNESS_SURFACES_ARRAY_REQUIRED");
        return array.property("length").toInt();
    }
    if(value.metaType().id()!=QMetaType::QVariantList)throw std::runtime_error("SMOOTHNESS_SURFACES_ARRAY_REQUIRED");
    return value.toList().size();
}
inline void disableDrawerBackground(QObject *compositor) {
    // Same diagnostic-only write used by W4. The product QML is unchanged.
    auto *context=QQmlEngine::contextForObject(compositor);
    if(!context||!context->engine())throw std::runtime_error("SMOOTHNESS_COMPOSITOR_QML_CONTEXT_REQUIRED");
    if(!compositor->setProperty("surfaces",QVariant::fromValue(context->engine()->newArray(0))))
        throw std::runtime_error("SMOOTHNESS_COMPOSITOR_SURFACES_WRITE_FAILED");
    if(surfaceCount(compositor)!=0)throw std::runtime_error("SMOOTHNESS_DRAWER_VARIANT_READBACK_FAILED");
}
inline QVariantMap readback(QObject *compositor,bool reduced) {
    return {{"surfaceCount",surfaceCount(compositor)}, {"pixelRatio",compositor->property("pixelRatio")},
        {"effectsActive",compositor->property("effectsActive")},{"reducedTransparency",reduced}};
}
}
