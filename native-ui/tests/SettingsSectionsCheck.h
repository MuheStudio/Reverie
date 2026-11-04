#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace SettingsSectionsCheck {
// The first cycle changes the terminal settings sections through their controls
// and checks each effect in the next real reply; the restart cycle only verifies
// that the saved values were read back. Neither touches other settings.
void run(QQuickWindow *, RuntimeBridge *, bool verifyOnly, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
