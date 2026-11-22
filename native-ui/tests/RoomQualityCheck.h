#pragma once

#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;

namespace RoomQualityCheck {
void run(QQuickWindow *, RuntimeBridge *, bool restart, std::function<void(QVariantMap)> done);
}
