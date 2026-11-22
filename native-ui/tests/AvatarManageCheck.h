#pragma once
#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;

namespace AvatarManageCheck {
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart,
         const QString &modelSource, std::function<void(QVariantMap)> done);
}
