#pragma once

#include <QByteArray>
#include <QObject>
#include <QStringList>
#include <QVariantMap>
#include <functional>
#include <memory>
#include <stdexcept>

class PreviewWorkspaceTest;

namespace PreviewWorkspace {
inline constexpr int ArgumentConflict = 64;
inline constexpr int InvalidWorkspace = 65;
inline constexpr int AlreadyRunning = 66;
inline constexpr int InvalidRuntime = 67;
inline constexpr int CleanupScopeRejected = 68;
inline constexpr int CleanupFailed = 69;

class Error final : public std::runtime_error {
public:
    Error(int status, const char *message) : std::runtime_error(message), exitCode(status) {}
    const int exitCode;
};

struct RuntimeInfo {
    QString root;
    QString candidate;
    QString sourceHead;
    QString buildManifestSha256;
    int supportedDataFormat = 1;
    QString title() const;
};

bool requested(const QStringList &arguments);
bool argumentConflict(const QStringList &arguments);
QStringList forbiddenOptions();
bool cleanupRequested(const QStringList &arguments);
bool cleanupArgumentConflict(const QStringList &arguments);
RuntimeInfo readRuntime(const QString &root, const QString &python);
QByteArray readyLine(const RuntimeInfo &, const QString &workspaceId, qint64 hostPid,
                     const QVariantMap &validatedStatus);

// Only the validator can create a deletion target. Its guard holds the existing
// workspace lock without creating a file or changing the diagnostic PID.
class CleanupTarget final {
public:
    CleanupTarget(CleanupTarget &&) noexcept;
    ~CleanupTarget();
    const QString &workspace() const {
        if (!m_guard) throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_TARGET_INVALID");
        return m_workspace;
    }
private:
    friend class ::PreviewWorkspaceTest;
    friend CleanupTarget validateTestCleanupContext(const QString &, const QString &);
    static void validateDirectory(const QString &path, quint64 owner);
    struct Guard;
    CleanupTarget(QString workspace, std::unique_ptr<Guard> guard);
    QString m_workspace;
    std::unique_ptr<Guard> m_guard;
};
CleanupTarget validateTestCleanupContext(const QString &contextFile, const QString &data);

// Owns the lock until the host's RuntimeBridge has finished shutting down.
class Session final {
public:
    enum class Initialization { ReadyDirectories, LockOnly };
    explicit Session(const QString &workspace, Initialization = Initialization::ReadyDirectories);
    ~Session();
    QString root() const { return m_root; }
    QString id() const;
    // Call only after pending recovery and the read-only data format gate.
    void initializeDirectories();
private:
    friend class ::PreviewWorkspaceTest;
    static void validateOwnedDirectory(const QString &path, quint64 owner);
    struct Lock;
    QString m_root;
    std::unique_ptr<Lock> m_lock;
};

// SIGTERM only writes to a nonblocking self-pipe. Qt performs normal window
// closing on its own thread; the signal handler never calls a Qt API.
class Termination final : public QObject {
public:
    Termination(QObject *context, std::function<void()> closeWindow);
    ~Termination() override;
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
} // namespace PreviewWorkspace
