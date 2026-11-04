#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace MemoryPageCheck {
// The first cycle starts on 130 seeded confirmed memories and one pending
// candidate. It reads the first page, loads the rest, filters to the twelve
// marked memories, edits one inside the filter, rejects the candidate and
// clears the filter. It runs before the ordinary flow. The restart pages and
// filters the same list again without writing.
void run(QQuickWindow *, RuntimeBridge *, bool verifyOnly, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion, bool keepOpen = false, bool batchDelete = false);
// The registered fixture texts, shared with the bootstrap by value.
QString seededText(int number);
}
