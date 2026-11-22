#pragma once
#if defined(REVERIE_TIMING_DIAGNOSTICS) || defined(REVERIE_QML_PROFILER)
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace SmoothnessCheck {
bool requested();
void bootstrap(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, const QString &, const QString &, int,
               std::function<void(bool, QVariantMap)>);
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, std::function<void(QVariantMap)>);
}
#endif
