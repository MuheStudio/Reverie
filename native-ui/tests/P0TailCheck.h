#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
// Explicit, isolated follow-up batch. The original supplementary cases and
// their 20-second deadlines are retained in SupplementaryFunctionCheck.
namespace P0TailCheck {
void run(QQuickWindow *, RuntimeBridge *, int cycle, const QString &endpointA, const QString &endpointB,
         const QString &capturePrefix, std::function<void(QVariantMap)> completion);
}
