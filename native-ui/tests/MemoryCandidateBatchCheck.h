#pragma once
#include <QVariantMap>
#include <QStringList>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace MemoryCandidateBatchCheck {
// Seeded paging candidate numbers, newest first: three remembered, then two declined.
inline constexpr int ConfirmNumbers[] = {130, 129, 128};
inline constexpr int RejectNumbers[] = {127, 126};
void run(QQuickWindow *, RuntimeBridge *, const QStringList &baselineCandidateIds, const QString &capturePrefix,
         std::function<void(QVariantMap)>);
}
