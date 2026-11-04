#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace MemoryCandidatePageCheck {
// Only --p1-memory --candidate-paging selects this segment. The ordinary
// MemoryPageCheck and MemoryRecallCheck run afterwards with their old cases.
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
QString seededText(int number);
}
