#pragma once
#include <QString>
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace PerfBootstrap {
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, const QString &modelPath,
         const QString &endpoint, int rows, std::function<void(bool, QVariantMap)> completion);
}
