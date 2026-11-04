#include "Keychain.h"
#include "PreviewWorkspace.h"
#include <Foundation/Foundation.h>
#include <QCryptographicHash>
#include <QDirIterator>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <Security/Security.h>
#include <stdexcept>
static NSString *account(const QString &root) {
    auto bytes = QCryptographicHash::hash(root.toUtf8(), QCryptographicHash::Sha256).toHex();
    return [NSString stringWithUTF8String:bytes.constData()];
}
QString storageKeychainService(KeychainDomain domain) {
    return domain == KeychainDomain::Preview ? "com.muhe.reverie.qt.preview.storage.v1"
                                           : "com.muhe.reverie.qt.local.storage.v1";
}
QString providerKeychainService(KeychainDomain domain) {
    return domain == KeychainDomain::Preview ? "com.muhe.reverie.qt.preview.credentials.v1"
                                           : "com.muhe.reverie.qt.local.credentials.v1";
}
static NSMutableDictionary *query(const QString &root, KeychainDomain domain) {
    return [@{
        (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService : storageKeychainService(domain).toNSString(),
        (__bridge id)kSecAttrAccount : account(root)
    } mutableCopy];
}
QByteArray storageKeyFor(const QString &root, KeychainDomain domain) {
    @autoreleasepool {
        auto q = query(root, domain);
        q[(__bridge id)kSecReturnData] = @YES;
        q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
        CFTypeRef found = nullptr;
        OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &found);
        if (status == errSecSuccess) {
            NSData *data = (__bridge_transfer NSData *)found;
            if (data.length != 32)
                throw std::runtime_error("KEYCHAIN_KEY_INVALID");
            return QByteArray((const char *)data.bytes, 32);
        }
        if (status != errSecItemNotFound)
            throw std::runtime_error("KEYCHAIN_UNAVAILABLE");
        QDirIterator files(root, QDir::Files | QDir::Hidden, QDirIterator::Subdirectories);
        while (files.hasNext()) {
            const auto name = QFileInfo(files.next()).fileName();
            if (name.contains(".sqlite") || name.contains(".db"))
                throw std::runtime_error("KEY_MISSING_EXISTING_DATABASE");
        }
        QByteArray key(32, 0);
        if (SecRandomCopyBytes(kSecRandomDefault, 32, key.data()) != errSecSuccess)
            throw std::runtime_error("KEY_GENERATION_FAILED");
        auto add = query(root, domain);
        add[(__bridge id)kSecValueData] = [NSData dataWithBytes:key.constData() length:32];
        add[(__bridge id)kSecAttrAccessible] =
            (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
        if (SecItemAdd((__bridge CFDictionaryRef)add, nullptr) != errSecSuccess) {
            key.fill(0);
            throw std::runtime_error("KEYCHAIN_WRITE_FAILED");
        }
        return key;
    }
}
void removeTestStorageKey(const QString &root) {
    @autoreleasepool {
        auto q = query(root, KeychainDomain::Local);
        auto s = SecItemDelete((__bridge CFDictionaryRef)q);
        if (s != errSecSuccess && s != errSecItemNotFound)
            throw std::runtime_error("TEST_KEY_CLEANUP_FAILED");
    }
}
static NSMutableDictionary *providerKeyQuery(const QString &root, KeychainDomain domain) {
    return [@{
        (__bridge id)kSecClass : (__bridge id)kSecClassGenericPassword,
        (__bridge id)kSecAttrService : providerKeychainService(domain).toNSString(),
        (__bridge id)kSecAttrAccount : account(root)
    } mutableCopy];
}
QString providerKeyBinding(const QString &provider, const QString &baseUrl) {
    const auto material = QString("llm") + QChar(0) + provider + QChar(0) + baseUrl;
    return QString::fromLatin1(
        QCryptographicHash::hash(material.toUtf8(), QCryptographicHash::Sha256).toHex());
}
namespace {
class KeychainProviderKeyStore final : public ProviderKeyStore {
  public:
    KeychainProviderKeyStore(QString root, KeychainDomain domain) : m_root(std::move(root)), m_domain(domain) {}
    std::optional<StoredProviderKey> read() override {
        @autoreleasepool {
            auto q = providerKeyQuery(m_root, m_domain);
            q[(__bridge id)kSecReturnData] = @YES;
            q[(__bridge id)kSecMatchLimit] = (__bridge id)kSecMatchLimitOne;
            CFTypeRef found = nullptr;
            const OSStatus status = SecItemCopyMatching((__bridge CFDictionaryRef)q, &found);
            if (status == errSecItemNotFound)
                return std::nullopt;
            if (status != errSecSuccess)
                throw std::runtime_error("PROVIDER_KEY_STORE_UNAVAILABLE");
            NSData *data = (__bridge_transfer NSData *)found;
            QByteArray bytes((const char *)data.bytes, (qsizetype)data.length);
            const auto object = QJsonDocument::fromJson(bytes).object();
            bytes.fill(0);
            StoredProviderKey key{object.value("binding").toString(), object.value("apiKey").toString(),
                                  object.value("writeId").toString()};
            static const QRegularExpression hex("^[0-9a-f]{64}$");
            if (object.value("schema").toString() != "reverie.qt.provider-key.v1" ||
                !hex.match(key.binding).hasMatch() || key.apiKey.isEmpty() || key.apiKey.size() > 16384 ||
                key.writeId.isEmpty())
                throw std::runtime_error("PROVIDER_KEY_RECORD_INVALID");
            return key;
        }
    }
    void write(const StoredProviderKey &key) override {
        @autoreleasepool {
            auto bytes = QJsonDocument(QJsonObject{{"schema", "reverie.qt.provider-key.v1"},
                                                   {"binding", key.binding},
                                                   {"apiKey", key.apiKey},
                                                   {"writeId", key.writeId}})
                             .toJson(QJsonDocument::Compact);
            NSData *value = [NSData dataWithBytes:bytes.constData() length:(NSUInteger)bytes.size()];
            bytes.fill(0);
            auto q = providerKeyQuery(m_root, m_domain);
            OSStatus status = SecItemUpdate((__bridge CFDictionaryRef)q,
                                            (__bridge CFDictionaryRef) @{(__bridge id)kSecValueData : value});
            if (status == errSecItemNotFound) {
                auto add = providerKeyQuery(m_root, m_domain);
                add[(__bridge id)kSecValueData] = value;
                add[(__bridge id)kSecAttrAccessible] =
                    (__bridge id)kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly;
                status = SecItemAdd((__bridge CFDictionaryRef)add, nullptr);
            }
            if (status != errSecSuccess)
                throw std::runtime_error("PROVIDER_KEY_WRITE_FAILED");
        }
    }
    void clear() override {
        @autoreleasepool {
            const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)providerKeyQuery(m_root, m_domain));
            if (status != errSecSuccess && status != errSecItemNotFound)
                throw std::runtime_error("PROVIDER_KEY_CLEAR_FAILED");
        }
    }
    QString account() const override {
        @autoreleasepool {
            return QString::fromNSString(::account(m_root));
        }
    }

  private:
    QString m_root;
    KeychainDomain m_domain;
};
} // namespace
std::unique_ptr<ProviderKeyStore> keychainProviderKeyStore(const QString &root, KeychainDomain domain) {
    return std::make_unique<KeychainProviderKeyStore>(root, domain);
}
void removeTestProviderKey(const QString &root) {
    @autoreleasepool {
        const OSStatus status = SecItemDelete((__bridge CFDictionaryRef)providerKeyQuery(root, KeychainDomain::Local));
        if (status != errSecSuccess && status != errSecItemNotFound)
            throw std::runtime_error("TEST_PROVIDER_KEY_CLEANUP_FAILED");
    }
}
void removePreviewTestKeys(const PreviewWorkspace::CleanupTarget &target) {
    @autoreleasepool {
        const OSStatus storage = SecItemDelete((__bridge CFDictionaryRef)query(target.workspace(), KeychainDomain::Preview));
        if (storage != errSecSuccess && storage != errSecItemNotFound)
            throw std::runtime_error("PREVIEW_TEST_STORAGE_KEY_CLEANUP_FAILED");
        const OSStatus provider = SecItemDelete((__bridge CFDictionaryRef)providerKeyQuery(target.workspace(), KeychainDomain::Preview));
        if (provider != errSecSuccess && provider != errSecItemNotFound)
            throw std::runtime_error("PREVIEW_TEST_PROVIDER_KEY_CLEANUP_FAILED");
    }
}
