#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace ArchiveInteractionCheck {
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, std::function<void()> rejectNextWrite,
         const QString &capturePrefix, std::function<void(QVariantMap)> completion, bool p1Restore = false,
         bool p1Persona = false);
// Second --p1-persona cycle: starts on the imported persona the first cycle
// ended on, reads its author-prompt switches back, then turns the remaining
// one off after a switch away and back. The default persona's saved multiple
// books and entries are selected through the same controls after its re-read.
void runPersonaRestart(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, const QString &capturePrefix,
                       std::function<void(QVariantMap)> completion);
void runStartupRescue(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, const QString &capturePrefix,
                      std::function<void(QVariantMap)> completion);
}
