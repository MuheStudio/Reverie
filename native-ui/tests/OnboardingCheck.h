#pragma once
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace OnboardingCheck {
// The first cycle starts on a fresh install: it walks the first-run sheet, hands off
// to the service page and back without saving, skips the service, saves a nickname,
// finishes, and shows that a chat is held until a service is chosen. It runs before
// the ordinary flow, which then configures the service. The restart only verifies
// that the sheet stays away and that what it saved was read back.
void run(QQuickWindow *, RuntimeBridge *, bool verifyOnly, const QString &endpoint, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
