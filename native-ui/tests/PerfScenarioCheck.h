#pragma once

#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;

namespace PerfScenarioCheck {
using Completion = std::function<void(QVariantMap)>;

// The caller boots the ordinary application, imports the local model through
// its controls and loads fixtureRows durable history rows through RuntimeBridge.
// mode is perf, diagnostic or visual. Only visual may capture the owned window.
// All modes use the same real controls and fixed workload for the selected protocol.
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *archiveEditor,
         const QString &mode, int fixtureRows, const QString &reportPrefix,
         Completion completion, const QString &protocol = QStringLiteral("stress-v1"),
         const QString &diagnosticCase = QString());
} // namespace PerfScenarioCheck
