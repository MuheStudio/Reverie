#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace PersonaProfileEditCheck {
// Independent tail after every signed persona/book-settings check.
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart,
         std::function<void(QVariantMap)> completion);
}
