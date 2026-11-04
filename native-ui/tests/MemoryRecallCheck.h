#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace MemoryRecallCheck {
// Appended to the existing P1 memory page check while its exact management
// state is still open. One real local query per cycle; the segment owns the
// original final close and an independent 20 s deadline.
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
