#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace ProfileClearCheck {
// Runs after the first ordinary profile/backup/worldbook checks. The restart
// runs before any profile input and refills only through the existing controls.
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
