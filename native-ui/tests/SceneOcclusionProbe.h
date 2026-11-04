#pragma once

#include <QQuickItem>
#include <QJSValue>
#include <QQuickWindow>
#include <QVariantMap>
#include <algorithm>

// GUI-thread geometry observations. These do not recognize facial pixels or
// measure optical quality. Decorative shadows are outside the tested bodies.
class SceneOcclusionProbe {
  public:
    QString error;
    int frames = 0;
    int samples = 0;
    double maximumArea = 0;
    QVariantMap counts;
    QVariantMap capturePeak;
    void sample(QQuickWindow *window) {
        if (!window || !error.isEmpty()) return;
        if (auto *compositor = window->findChild<QObject *>("layerCompositor")) {
            const auto value = compositor->property("captureDiagnostics");
            const auto data = value.metaType() == QMetaType::fromType<QJSValue>() ? value.value<QJSValue>().toVariant().toMap() : value.toMap();
            if (data.value("requestedTexturePixels").toDouble() >= capturePeak.value("requestedTexturePixels").toDouble()) capturePeak = data;
        }
        auto *director = window->findChild<QObject *>("sceneDirector");
        if (!director || director->property("avatarVisibility").toDouble() <= .001) return;
        const auto reserve = director->property("avatarReserveRect").toRectF();
        if (reserve.isEmpty()) { error = "SCENE_AVATAR_RESERVE_MISSING"; return; }
        ++frames;
        for (const QString &name : {"chatReadingSurface", "chatComposerSurface", "chatCompanionBar",
                                    "drawer-memory", "drawer-settings", "taskSurface"}) {
            auto *item = find(window->contentItem(), name);
            if (!item) { error = "SCENE_OCCLUSION_SURFACE_MISSING:" + name; return; }
            if (item->property("progress").isValid() && item->property("progress").toDouble() <= .002) continue;
            double alpha = 1;
            bool visible = true;
            QRectF rect = item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
            for (auto *ancestor = item; ancestor; ancestor = ancestor->parentItem()) {
                visible = visible && ancestor->isVisible();
                alpha *= ancestor->opacity();
                if (ancestor->clip()) rect = rect.intersected(ancestor->mapRectToScene(QRectF(0, 0, ancestor->width(), ancestor->height())));
            }
            if (!visible || alpha <= .001) continue;
            rect = rect.intersected(QRectF(0, 0, window->width(), window->height()));
            const auto intersection = rect.intersected(reserve);
            const double area = std::max(0., intersection.width()) * std::max(0., intersection.height());
            maximumArea = std::max(maximumArea, area);
            ++samples;
            counts[name] = counts.value(name).toInt() + 1;
            if (area > .25) {
                error = "SCENE_VISIBLE_BODY_COVERS_AVATAR_RESERVE:" + name + ":" + QString::number(area)
                    + ":read=" + director->property("readBlend").toString()
                    + ":task=" + director->property("taskBlend").toString();
                return;
            }
        }
    }
    QVariantMap report() const {
        return {{"method", "afterAnimating GUI-thread rectangles; effective opacity > .001; closed scene objects and decorative shadows excluded"},
                {"frames", frames}, {"samples", samples}, {"surfaceSamples", counts},
                {"maximumOverlapLogicalSquarePixels", maximumArea}, {"capturePeak", capturePeak}, {"error", error}};
    }
  private:
    static QQuickItem *find(QQuickItem *root, const QString &name) {
        if (!root) return nullptr;
        if (root->objectName() == name) return root;
        for (auto *child : root->childItems()) if (auto *found = find(child, name)) return found;
        return nullptr;
    }
};
