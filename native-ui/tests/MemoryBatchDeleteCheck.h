#pragma once
#include <QStringList>
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace MemoryBatchDeleteCheck {
// Only the ordinary --p1-memory scenario, after its entire archive/restore
// flow. The candidate-paging variant keeps its already accepted 130-ID contract.
inline constexpr int Numbers[] = {130, 129, 127};
void run(QQuickWindow *, RuntimeBridge *, const QStringList &baselineIds,
         const QString &capturePrefix, std::function<void(QVariantMap)>);
}
