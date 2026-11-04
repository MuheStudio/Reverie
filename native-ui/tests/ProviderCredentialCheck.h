#pragma once
#include <QString>
#include <QVariantMap>
#include <functional>
class QQuickWindow;
class RuntimeBridge;
namespace ProviderCredentialCheck {
// A synthetic key, two owned loopback endpoints and fixed filenames in the
// registered isolated data directory; no user card or backup is adopted.
struct Fixture {
    QString apiKey, endpointA, endpointB, backupFile, cardFile;
};
// Reads p1_provider from the already verified isolation context; throws on anything else.
Fixture readFixture(const QString &context, const QString &endpointA);
// The first cycle saves the key through the reply-service controls, moves to a
// second endpoint and back, restores its own backup, imports a synthetic card
// through confirmation and switches back. Each confirms a new key delivery;
// the restart uses the saved key without any test or save, then deletes it.
void run(QQuickWindow *, RuntimeBridge *, bool restart, const Fixture &, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion);
}
