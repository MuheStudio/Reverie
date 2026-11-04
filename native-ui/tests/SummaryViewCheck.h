#pragma once
#include <QStringList>
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace SummaryViewCheck {
// Ordinary --p1-memory only, after all of the original controls and model
// checks. The source identities come from the already completed memory check;
// opening the management page keeps its existing first-page refresh behavior.
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart,
         const QStringList &source127Ids, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
