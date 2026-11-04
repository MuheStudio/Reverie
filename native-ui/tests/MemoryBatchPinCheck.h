#pragma once
#include <QStringList>
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace MemoryBatchPinCheck {
inline constexpr int Numbers[] = {126, 125, 124};
void run(QQuickWindow *, RuntimeBridge *, bool restart, const QStringList &baselineIds,
         const QString &capturePrefix, std::function<void(QVariantMap)>);
}
