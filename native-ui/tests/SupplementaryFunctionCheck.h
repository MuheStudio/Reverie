#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
// Supplementary function audit, entered only through --test-suite
// supplementary. It drives the visible service, network pause, cost
// permission and model/preference controls with synthetic native clicks and
// input commits. It records independent original 20 s recovery and controlled
// planner cases, metadata without content, and four discrete receipt captures.
// The orchestrator adds server lifecycle and bounded backend metadata.
namespace SupplementaryFunctionCheck {
void run(QQuickWindow *, RuntimeBridge *, int cycle, const QString &endpoint, const QString &model,
         const QString &capturePrefix, std::function<void(QVariantMap)> completion);
}
