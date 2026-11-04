#pragma once

#include <QByteArray>
#include <QJsonArray>
#include <QJsonObject>
#include <QString>
#include <QStringList>
#include <memory>
#include <stdexcept>

namespace PreviewWorkspace { class Session; }
namespace PreviewPlatform { class Handle; }

namespace PreviewSnapshot {
inline constexpr int Failure = 70;

class Error final : public std::runtime_error {
public:
    explicit Error(const char *code) : std::runtime_error(code) {}
    const int exitCode = Failure;
};

struct Identity {
    QString candidate;
    QString sourceHead;
    QString buildManifestSha256;
    bool operator==(const Identity &) const = default;
};

// Fixed category and user-facing text shared by startup and the restricted
// workspace control entry. Unknown parse/control errors are verification errors.
QString failureCode(const QString &code);
QString failureMessage(const QString &code);
bool validIdentity(const Identity &);
QJsonObject identityJson(const Identity &);
Identity identityFromJson(const QJsonValue &);

// An ordinary filesystem dependency, also usable by a caller with a storage
// quota or alternate write policy. No environment or command-line test gates.
class FileOperations {
public:
    virtual ~FileOperations() = default;
    virtual qint64 write(int descriptor, const char *bytes, qint64 size);
    virtual bool sync(int descriptor);
    virtual quint64 availableBytes(int directoryDescriptor);
    // A normal operation observer permits quotas, diagnostics and deterministic
    // fault injection without environment switches or command-line test gates.
    virtual void checkpoint(const QString &operation);
};

// A verified repository bound to a Session whose existing lock remains alive.
// The restore algorithm shares this byte-snapshot implementation; it never
// interprets a database or re-creates a source hard-link relationship.
class Repository final {
public:
    explicit Repository(const PreviewWorkspace::Session &, std::shared_ptr<FileOperations> = {});
    ~Repository();
    QJsonArray list();
    QJsonObject manifest(const QString &name);
    QString savePreRestore(const Identity &fallback, const QStringList &protectedNames = {});
    void copyPayload(const QString &name, const PreviewPlatform::Handle &destination);
    void prune(const QStringList &protectedNames = {}, const QString &priorityName = {});
    QStringList warnings() const;
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};

enum class Action { FirstLaunch, Unchanged, Created, Reused };
struct Result {
    Action action = Action::FirstLaunch;
    QString snapshotName;
    QStringList warnings; // Fixed codes only; never paths or imported names.
};

class Manager final {
public:
    // Keep the Session alive until this object and the runtime are destroyed.
    Manager(const PreviewWorkspace::Session &, Identity,
            std::shared_ptr<FileOperations> operations = {});
    ~Manager();
    Manager(const Manager &) = delete;
    Manager &operator=(const Manager &) = delete;
    // Call while the session holds its lock, before keychain/backend work.
    Result prepare();
    // Call only after the existing clean/writable ready gate succeeds.
    void markReady();
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
} // namespace PreviewSnapshot
