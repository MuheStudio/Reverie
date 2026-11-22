#pragma once

#include <QString>
#include <QVariantMap>
#include <functional>

class QQuickWindow;
class RuntimeBridge;

namespace StrategicGameCheck {
enum class Kind { Chess, Go };

void run(QQuickWindow *, RuntimeBridge *, Kind, bool restart, const QString &reportPath,
         std::function<void(QVariantMap)> done);
}
