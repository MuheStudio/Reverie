#pragma once
#include <QByteArray>
#include <QString>
#include <memory>
#include <optional>
// These functions access only the new Qt host's namespaced records.
enum class KeychainDomain { Local, Preview };
QString storageKeychainService(KeychainDomain domain);
QString providerKeychainService(KeychainDomain domain);
QByteArray storageKeyFor(const QString &dataRoot, KeychainDomain domain = KeychainDomain::Local);
void removeTestStorageKey(const QString &dataRoot);
namespace PreviewWorkspace { class CleanupTarget; }
void removePreviewTestKeys(const PreviewWorkspace::CleanupTarget &target);

// One reply-service API key, bound to the provider and endpoint it was saved
// for. It is never written to the data directory, a backup or a report.
struct StoredProviderKey {
    QString binding; // providerKeyBinding() of the destination it belongs to
    QString apiKey;
    QString writeId;
};
class ProviderKeyStore {
  public:
    virtual ~ProviderKeyStore() = default;
    // nullopt means no saved key; an unreadable store throws std::runtime_error.
    virtual std::optional<StoredProviderKey> read() = 0;
    virtual void write(const StoredProviderKey &) = 0;
    virtual void clear() = 0;
    // Non-secret record name, reported so an isolated test host can confirm cleanup.
    virtual QString account() const = 0;
};
// sha256("llm\0provider\0base_url") in lowercase hex, as the desktop host bound its keys.
QString providerKeyBinding(const QString &provider, const QString &baseUrl);
std::unique_ptr<ProviderKeyStore> keychainProviderKeyStore(
    const QString &dataRoot, KeychainDomain domain = KeychainDomain::Local);
void removeTestProviderKey(const QString &dataRoot);
