#pragma once

#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;

namespace KeepsakeCheck {
void run(QQuickWindow *, RuntimeBridge *, bool restart, std::function<void(QVariantMap)> done);
}
