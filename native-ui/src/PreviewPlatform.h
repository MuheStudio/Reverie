#pragma once

#include <QByteArray>
#include <QList>
#include <QString>
#include <memory>
#include <stdexcept>
#include <functional>

class QObject;

// All native filesystem handles, ownership and durability rules live here.
// Algorithms use metadata identities rather than POSIX stat structures.
namespace PreviewPlatform {
enum class Kind { Missing, Directory, Regular, Link, Other };
enum class Failure { Io, NoSpace, SpecialFile, Changed, Limit, Invalid, Busy, Unsupported };
class Error final : public std::runtime_error {
public:
    explicit Error(Failure reason);
    Failure reason;
};
struct Metadata {
    Kind kind = Kind::Missing;
    quint64 volume = 0, object = 0, owner = 0, links = 0, bytes = 0;
    quint32 permissions = 0;
    qint64 modifiedSeconds = 0, modifiedNanos = 0, changedSeconds = 0, changedNanos = 0;
    bool owned = false;
    bool privateAccess = false;
};
bool sameObject(const Metadata &, const Metadata &);
bool unchanged(const Metadata &, const Metadata &);
class Handle final {
public:
    Handle();
    ~Handle();
    Handle(Handle &&) noexcept;
    Handle &operator=(Handle &&) noexcept;
    Handle(const Handle &) = delete;
    explicit operator bool() const;
    // Compatibility boundary for the existing injectable byte writer only.
    int nativeDescriptor() const;
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
    explicit Handle(int);
    friend struct Native;
};
quint64 currentOwner();
bool canonicalAbsolute(const QString &);
void validatePrivateDirectory(const QString &, quint64 owner);
void ensurePrivateDirectory(const QString &);
Metadata inspect(const Handle &parent, const QByteArray &name);
Metadata inspectPath(const QString &path);
Metadata metadata(const Handle &);
Handle duplicate(const Handle &);
Handle openRoot(const QString &, bool privateAccess = true);
Handle openDirectory(const Handle &, const QByteArray &, bool privateAccess = false);
Handle openRegular(const Handle &, const QByteArray &, bool privateAccess = true, bool allowSourceLinks = false);
Handle createFile(const Handle &, const QByteArray &);
void createDirectory(const Handle &, const QByteArray &);
QList<QByteArray> children(const Handle &, qsizetype limit = 100000);
qint64 read(const Handle &, char *, qint64);
qint64 writeNative(int, const char *, qint64);
bool syncNative(int);
quint64 availableBytesNative(int);
void flush(const Handle &);
void renameNoReplace(const Handle &, const QByteArray &from, const QByteArray &to);
void moveNoReplace(const Handle &fromParent, const QByteArray &from,
                   const Handle &toParent, const QByteArray &to);
void replaceFile(const Handle &, const QByteArray &from, const QByteArray &to);
void removeEntry(const Handle &, const QByteArray &, bool directory);
[[noreturn]] void throwLastIoError();

class WorkspaceLock final {
public:
    enum class OpenMode { ExistingOnly, Create };
    explicit WorkspaceLock(const QString &, OpenMode = OpenMode::ExistingOnly);
    ~WorkspaceLock();
    WorkspaceLock(const WorkspaceLock &) = delete;
    QString root() const;
    void writeDiagnosticPid(qint64);
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
class Termination final {
public:
    Termination(QObject *context, std::function<void()> closeWindow);
    ~Termination();
private:
    struct Impl;
    std::unique_ptr<Impl> m_impl;
};
} // namespace PreviewPlatform
