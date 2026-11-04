#include "PreviewPlatform.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QPointer>
#include <QSocketNotifier>
#include <algorithm>
#include <cerrno>
#include <cstdio>
#include <dirent.h>
#include <fcntl.h>
#include <limits>
#include <signal.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <unistd.h>
#include <utility>

namespace PreviewPlatform {
Error::Error(Failure value) : std::runtime_error("PREVIEW_PLATFORM_FAILED"), reason(value) {}
[[noreturn]] void throwLastIoError() {
    throw Error(errno == ENOSPC || errno == EDQUOT ? Failure::NoSpace : Failure::Io);
}
namespace {
Metadata converted(const struct stat &s) {
    Metadata result;
    result.kind = S_ISDIR(s.st_mode) ? Kind::Directory : S_ISREG(s.st_mode) ? Kind::Regular :
        S_ISLNK(s.st_mode) ? Kind::Link : Kind::Other;
    result.volume = quint64(s.st_dev); result.object = quint64(s.st_ino);
    result.owner = quint64(s.st_uid); result.owned = s.st_uid == ::getuid();
    result.links = quint64(s.st_nlink); result.bytes = s.st_size < 0 ? 0 : quint64(s.st_size);
    result.permissions = quint32(s.st_mode & 07777);
    result.privateAccess = result.permissions == (result.kind == Kind::Directory ? 0700U : 0600U);
#if defined(__APPLE__)
    result.modifiedSeconds = s.st_mtimespec.tv_sec; result.modifiedNanos = s.st_mtimespec.tv_nsec;
    result.changedSeconds = s.st_ctimespec.tv_sec; result.changedNanos = s.st_ctimespec.tv_nsec;
#else
    result.modifiedSeconds = s.st_mtim.tv_sec; result.modifiedNanos = s.st_mtim.tv_nsec;
    result.changedSeconds = s.st_ctim.tv_sec; result.changedNanos = s.st_ctim.tv_nsec;
#endif
    return result;
}
bool component(const QByteArray &name) {
    return !name.isEmpty() && name != "." && name != ".." && !name.contains('/') && !name.contains('\0');
}
void requireComponent(const QByteArray &name) { if (!component(name)) throw Error(Failure::Invalid); }
volatile sig_atomic_t terminationWriteFd = -1;
void terminationSignal(int) {
    const int saved = errno;
    const int descriptor = terminationWriteFd;
    if (descriptor >= 0) { const char byte = 1; const auto ignored = ::write(descriptor, &byte, 1); (void)ignored; }
    errno = saved;
}
}
bool sameObject(const Metadata &a, const Metadata &b) {
    return a.kind == b.kind && a.volume == b.volume && a.object == b.object && a.owner == b.owner &&
        a.links == b.links && a.bytes == b.bytes && a.permissions == b.permissions;
}
bool unchanged(const Metadata &a, const Metadata &b) {
    return sameObject(a, b) && a.modifiedSeconds == b.modifiedSeconds && a.modifiedNanos == b.modifiedNanos &&
        a.changedSeconds == b.changedSeconds && a.changedNanos == b.changedNanos;
}
struct Handle::Impl { int descriptor; explicit Impl(int value) : descriptor(value) {} ~Impl() { if (descriptor >= 0) ::close(descriptor); } };
struct Native { static Handle handle(int descriptor) { if (descriptor < 0) throwLastIoError(); return Handle(descriptor); } };
Handle::Handle() = default;
Handle::Handle(int descriptor) : m_impl(std::make_unique<Impl>(descriptor)) {}
Handle::~Handle() = default;
Handle::Handle(Handle &&) noexcept = default;
Handle &Handle::operator=(Handle &&) noexcept = default;
Handle::operator bool() const { return m_impl && m_impl->descriptor >= 0; }
int Handle::nativeDescriptor() const { if (!*this) throw Error(Failure::Invalid); return m_impl->descriptor; }
quint64 currentOwner() { return quint64(::getuid()); }
bool canonicalAbsolute(const QString &path) { return !path.isEmpty() && QDir::isAbsolutePath(path) && QDir::cleanPath(path) == path; }
Metadata inspectPath(const QString &path) {
    struct stat value{};
    if (::lstat(QFile::encodeName(path).constData(), &value) != 0) {
        if (errno == ENOENT) return {};
        throwLastIoError();
    }
    return converted(value);
}
void validatePrivateDirectory(const QString &path, quint64 owner) {
    const auto value = inspectPath(path);
    if (!canonicalAbsolute(path) || value.kind != Kind::Directory || value.owner != owner || value.permissions != 0700 ||
        QFileInfo(path).canonicalFilePath() != path) throw Error(Failure::Invalid);
}
void ensurePrivateDirectory(const QString &path) {
    if (inspectPath(path).kind == Kind::Missing && ::mkdir(QFile::encodeName(path).constData(), 0700) != 0)
        throwLastIoError();
    validatePrivateDirectory(path, currentOwner());
}
Metadata inspect(const Handle &parent, const QByteArray &name) {
    requireComponent(name); struct stat value{};
    if (::fstatat(parent.nativeDescriptor(), name.constData(), &value, AT_SYMLINK_NOFOLLOW) != 0) {
        if (errno == ENOENT) return {};
        throwLastIoError();
    }
    return converted(value);
}
Metadata metadata(const Handle &handle) {
    struct stat value{}; if (::fstat(handle.nativeDescriptor(), &value) != 0) throwLastIoError(); return converted(value);
}
Handle duplicate(const Handle &handle) { return Native::handle(::dup(handle.nativeDescriptor())); }
Handle openRoot(const QString &path, bool privateAccess) {
    if (!canonicalAbsolute(path) || QFileInfo(path).canonicalFilePath() != path) throw Error(Failure::Invalid);
    const auto before = inspectPath(path);
    if (before.kind != Kind::Directory || !before.owned || (privateAccess && before.permissions != 0700)) throw Error(Failure::Invalid);
    auto result = Native::handle(::open(QFile::encodeName(path).constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (!sameObject(before, metadata(result))) throw Error(Failure::Changed);
    return result;
}
Handle openDirectory(const Handle &parent, const QByteArray &name, bool privateAccess) {
    const auto before = inspect(parent, name);
    if (before.kind != Kind::Directory || !before.owned || (privateAccess && before.permissions != 0700)) throw Error(Failure::SpecialFile);
    auto result = Native::handle(::openat(parent.nativeDescriptor(), name.constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC));
    if (!sameObject(before, metadata(result))) throw Error(Failure::Changed);
    return result;
}
Handle openRegular(const Handle &parent, const QByteArray &name, bool privateAccess, bool allowSourceLinks) {
    const auto before = inspect(parent, name);
    if (before.kind != Kind::Regular || !before.owned || !before.links || (!allowSourceLinks && before.links != 1) ||
        (privateAccess && before.permissions != 0600)) throw Error(Failure::SpecialFile);
    auto result = Native::handle(::openat(parent.nativeDescriptor(), name.constData(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC));
    if (!sameObject(before, metadata(result))) throw Error(Failure::Changed);
    return result;
}
Handle createFile(const Handle &parent, const QByteArray &name) {
    requireComponent(name);
    auto result = Native::handle(::openat(parent.nativeDescriptor(), name.constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600));
    if (::fchmod(result.nativeDescriptor(), 0600) != 0) throwLastIoError();
    return result;
}
void createDirectory(const Handle &parent, const QByteArray &name) {
    requireComponent(name); if (::mkdirat(parent.nativeDescriptor(), name.constData(), 0700) != 0) throwLastIoError();
}
QList<QByteArray> children(const Handle &handle, qsizetype limit) {
    const int copy = ::dup(handle.nativeDescriptor()); if (copy < 0) throwLastIoError();
    DIR *directory = ::fdopendir(copy); if (!directory) { ::close(copy); throwLastIoError(); }
    ::rewinddir(directory); QList<QByteArray> result; errno = 0;
    while (auto *entry = ::readdir(directory)) {
        const QByteArray name(entry->d_name);
        if (name != "." && name != "..") result.append(name);
        if (result.size() > limit) { ::closedir(directory); throw Error(Failure::Limit); }
        errno = 0;
    }
    const int error = errno; ::closedir(directory);
    if (error) { errno = error; throwLastIoError(); }
    std::sort(result.begin(), result.end()); return result;
}
qint64 read(const Handle &handle, char *bytes, qint64 size) {
    for (;;) { const auto count = ::read(handle.nativeDescriptor(), bytes, size_t(size)); if (count >= 0) return count; if (errno != EINTR) throwLastIoError(); }
}
qint64 writeNative(int descriptor, const char *bytes, qint64 size) { return ::write(descriptor, bytes, size_t(size)); }
bool syncNative(int descriptor) { return ::fsync(descriptor) == 0; }
quint64 availableBytesNative(int descriptor) {
    struct statvfs value{}; if (::fstatvfs(descriptor, &value) != 0) throwLastIoError();
    const auto unit = quint64(value.f_frsize), blocks = quint64(value.f_bavail);
    if (unit && blocks > std::numeric_limits<quint64>::max() / unit) return std::numeric_limits<quint64>::max();
    return unit * blocks;
}
void flush(const Handle &handle) { if (!syncNative(handle.nativeDescriptor())) throwLastIoError(); }
void renameNoReplace(const Handle &parent, const QByteArray &from, const QByteArray &to) {
    moveNoReplace(parent, from, parent, to);
}
void moveNoReplace(const Handle &fromParent, const QByteArray &from, const Handle &toParent, const QByteArray &to) {
    requireComponent(from); requireComponent(to);
#if defined(__APPLE__)
    if (::renameatx_np(fromParent.nativeDescriptor(), from.constData(), toParent.nativeDescriptor(), to.constData(), RENAME_EXCL) != 0) throwLastIoError();
#else
    throw Error(Failure::Unsupported);
#endif
}
void replaceFile(const Handle &parent, const QByteArray &from, const QByteArray &to) {
    requireComponent(from); requireComponent(to);
    if (::renameat(parent.nativeDescriptor(), from.constData(), parent.nativeDescriptor(), to.constData()) != 0) throwLastIoError();
}
void removeEntry(const Handle &parent, const QByteArray &name, bool directory) {
    requireComponent(name); if (::unlinkat(parent.nativeDescriptor(), name.constData(), directory ? AT_REMOVEDIR : 0) != 0) throwLastIoError();
}
struct WorkspaceLock::Impl { QString path; Handle directory, file; };
WorkspaceLock::WorkspaceLock(const QString &path, OpenMode mode) : m_impl(std::make_unique<Impl>()) {
    if (!canonicalAbsolute(path)) throw Error(Failure::Invalid);
    if (mode == OpenMode::Create && inspectPath(path).kind == Kind::Missing) {
        const QString parent = QFileInfo(path).absolutePath();
        if (QFileInfo(parent).canonicalFilePath() != parent || !QFileInfo(parent).isDir()) throw Error(Failure::Invalid);
        ensurePrivateDirectory(path);
    }
    validatePrivateDirectory(path, currentOwner());
    m_impl->path = path; m_impl->directory = openRoot(path);
    const auto name = QByteArrayLiteral("workspace.lock");
    const auto before = inspect(m_impl->directory, name);
    if (before.kind == Kind::Missing && mode == OpenMode::ExistingOnly) throw Error(Failure::Invalid);
    const int flags = O_RDWR | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK | (mode == OpenMode::Create ? O_CREAT : 0);
    m_impl->file = Native::handle(::openat(m_impl->directory.nativeDescriptor(), name.constData(), flags, 0600));
    const auto opened = metadata(m_impl->file);
    if (opened.kind != Kind::Regular || !opened.owned || opened.links != 1 ||
        (mode == OpenMode::ExistingOnly && opened.permissions != 0600)) throw Error(Failure::Invalid);
    if (::flock(m_impl->file.nativeDescriptor(), LOCK_EX | LOCK_NB) != 0) {
        if (errno == EAGAIN || errno == EWOULDBLOCK) throw Error(Failure::Busy);
        throwLastIoError();
    }
    if (!sameObject(opened, inspect(m_impl->directory, name))) throw Error(Failure::Changed);
    if (mode == OpenMode::Create && ::fchmod(m_impl->file.nativeDescriptor(), 0600) != 0) throwLastIoError();
}
WorkspaceLock::~WorkspaceLock() = default;
QString WorkspaceLock::root() const { return m_impl->path; }
void WorkspaceLock::writeDiagnosticPid(qint64 pid) {
    const auto bytes = QByteArray::number(pid) + '\n';
    if (::ftruncate(m_impl->file.nativeDescriptor(), 0) != 0 ||
        writeNative(m_impl->file.nativeDescriptor(), bytes.constData(), bytes.size()) != bytes.size()) throwLastIoError();
}
struct Termination::Impl {
    int descriptors[2]{-1, -1};
    struct sigaction previous{};
    bool installed = false, requested = false;
    QPointer<QSocketNotifier> notifier;
    ~Impl() {
        delete notifier.data();
        if (installed) { terminationWriteFd = -1; ::sigaction(SIGTERM, &previous, nullptr); }
        for (const int descriptor : descriptors) if (descriptor >= 0) ::close(descriptor);
    }
};
Termination::Termination(QObject *context, std::function<void()> closeWindow) : m_impl(std::make_unique<Impl>()) {
    if (!context || !closeWindow || terminationWriteFd >= 0 || ::pipe(m_impl->descriptors) != 0) throw Error(Failure::Io);
    for (const int descriptor : m_impl->descriptors)
        if (::fcntl(descriptor, F_SETFL, ::fcntl(descriptor, F_GETFL) | O_NONBLOCK) == -1 || ::fcntl(descriptor, F_SETFD, FD_CLOEXEC) == -1) throw Error(Failure::Io);
    struct sigaction action{}; action.sa_handler = terminationSignal; sigemptyset(&action.sa_mask);
    if (::sigaction(SIGTERM, &action, &m_impl->previous) != 0) throw Error(Failure::Io);
    m_impl->installed = true; terminationWriteFd = m_impl->descriptors[1];
    m_impl->notifier = new QSocketNotifier(m_impl->descriptors[0], QSocketNotifier::Read, context);
    QObject::connect(m_impl->notifier.data(), &QSocketNotifier::activated, context, [state = m_impl.get(), closeWindow = std::move(closeWindow)] {
        char bytes[64]; while (::read(state->descriptors[0], bytes, sizeof(bytes)) > 0) {}
        if (!state->requested) { state->requested = true; closeWindow(); }
    });
}
Termination::~Termination() = default;
} // namespace PreviewPlatform
