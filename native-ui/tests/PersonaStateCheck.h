#pragma once

#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;

namespace PersonaStateCheck {
void run(QQuickWindow *, RuntimeBridge *, int cycle, const QString &moonId,
         std::function<void(QVariantMap)> done);
}
