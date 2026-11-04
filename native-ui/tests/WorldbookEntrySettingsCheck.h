#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
class ArchiveEditor;
namespace WorldbookEntrySettingsCheck {
void run(QQuickWindow *, RuntimeBridge *, ArchiveEditor *, bool restart,
         const QString &capturePrefix, std::function<void(QVariantMap)>);
}
