#pragma once

#include <QVariantMap>
#include <functional>

class QQuickWindow;
class NativeAvatar;
namespace SceneSurfaceCheck {
using Completion = std::function<void(QVariantMap)>;
// Run inside the already registered application after the model and archive
// editor are ready. Completion fires once; no application is launched here.
void run(QQuickWindow *window, NativeAvatar *avatar, Completion completion,
         bool measureTiming = true, bool transitionDiagnostics = false,
         std::function<QVariantMap()> archiveContext = {});
} // namespace SceneSurfaceCheck
