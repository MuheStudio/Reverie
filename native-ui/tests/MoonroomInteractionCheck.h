#pragma once

#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;

namespace MoonroomInteractionCheck {
using Completion = std::function<void(QVariantMap)>;
// Uses the registered application's existing window and persistent editors.
// The caller supplies the two long reading replies and separate slow stop reply.
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *archiveEditor,
         const QString &capturePrefix, Completion completion);
} // namespace MoonroomInteractionCheck
