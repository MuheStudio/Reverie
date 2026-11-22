#pragma once
#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;

namespace WorldbookFileCheck {
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart,
         const QString &capturePrefix, std::function<void(QVariantMap)> done);
}
