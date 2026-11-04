#include "PreviewEvents.h"
#include "PreviewWorkspace.h"
#include "PreviewStartupPolicy.h"
#include <QCoreApplication>
#include <QDateTime>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QSet>
#include <QUuid>
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace PreviewEvents {
namespace {
[[noreturn]] void failed() { throw PreviewWorkspace::Error(70, "PREVIEW_EVENT_WRITE_FAILED"); }
bool privateFile(const struct stat &s) {
    return S_ISREG(s.st_mode) && s.st_uid == ::getuid() && s.st_nlink == 1 && (s.st_mode & 07777) == 0600;
}
bool validSaved(const QByteArray &line) {
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(line, &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject() || line.size() > 1024) return false;
    const auto object = doc.object();
    const QSet<QString> keys{"schema", "event", "hostPid", "sequence", "timeMs", "elapsedMs", "code", "value"};
    const auto actual = object.keys();
    if (QSet<QString>(actual.begin(), actual.end()) != keys || object["schema"] != "reverie.qt.preview-event.v1" ||
        !object["event"].isString() || !knownEvent(object["event"].toString()) ||
        !object["code"].isString() || normalizedCode(object["code"].toString()) != object["code"].toString()) return false;
    for (const auto *key : {"hostPid", "sequence", "timeMs", "elapsedMs", "value"}) {
        const auto v = object[key]; const double n = v.toDouble();
        if (!v.isDouble() || n < -9007199254740991.0 || n > 9007199254740991.0 || n != double(qint64(n))) return false;
        if (QString(key) != "value" && n < (QString(key) == "hostPid" || QString(key) == "sequence" ? 1 : 0)) return false;
    }
    if (object["event"] == "service_failure" && (object["value"].toInteger() < 0 || object["value"].toInteger() > 9)) return false;
    return true;
}
}
QString normalizedCode(const QString &code) {
    static const QSet<QString> allowed{"OK", "UNKNOWN", "FIRST_LAUNCH", "UNCHANGED", "CREATED", "REUSED",
        "UNMANAGED", "INVALID_SNAPSHOT", "KEYCHAIN_UNAVAILABLE", "KEYCHAIN_KEY_INVALID", "PREVIEW_SNAPSHOT_FAILED",
        "PREVIEW_READY_RECORD_FAILED", "CLEAN", "RECOVERY_REQUIRED", "READ_ONLY", "KEY_MISSING_EXISTING_DATABASE",
        "PROVIDER_UNAUTHORIZED", "PROVIDER_AUTH_FAILED", "PROVIDER_RATE_LIMITED", "PROVIDER_TIMEOUT", "PROVIDER_UNREACHABLE",
        "PROVIDER_CONNECTION_FAILED", "PROVIDER_INVALID_RESPONSE", "PROVIDER_INVALID_RESPONSE_SCHEMA", "PROVIDER_EMPTY_RESPONSE",
        "PROVIDER_REASONING_ONLY_RESPONSE", "PROVIDER_OUTPUT_TRUNCATED", "PROVIDER_CONTENT_FILTERED", "PROVIDER_TOOL_ONLY_RESPONSE",
        "PROVIDER_REJECTED", "PROVIDER_FAILURE",
        "PREVIEW_SNAPSHOT_NO_SPACE", "PREVIEW_SNAPSHOT_SPECIAL_FILE", "PREVIEW_SNAPSHOT_ENTRY_LIMIT",
        "PREVIEW_SNAPSHOT_SOURCE_CHANGED", "PREVIEW_SNAPSHOT_VERIFY_FAILED", "PREVIEW_SNAPSHOT_IO_FAILED",
        "PREVIEW_DATA_FORMAT_TOO_NEW", "PREVIEW_DATA_FORMAT_INVALID", "PREVIEW_DATA_FORMAT_WRITE_FAILED",
        "PREVIEW_RESTORE_RECOVERY_REQUIRED", "PREVIEW_RESTORE_CONTROL_RUNTIME_REQUIRED", "PREVIEW_RESTORE_CLEANUP_PENDING"};
    return allowed.contains(code) ? code : QStringLiteral("UNKNOWN");
}
bool knownEvent(const QString &event) {
    static const QSet<QString> allowed{"startup", "snapshot_skipped", "snapshot_created", "snapshot_reused",
        "snapshot_failed", "snapshot_warning", "keychain_read_started", "keychain_ready", "backend_starting",
        "ready", "startup_failed", "backend_exit", "restore_state", "service_failure", "exit"};
    return allowed.contains(event);
}
QString startupNotice(bool preview, const QString &code) { return PreviewStartupPolicy::notice(preview, code); }
Writer::Writer(const PreviewWorkspace::Session &session) : m_root(session.root()) {
    m_clock.start();
    m_directory = ::open(QFile::encodeName(m_root).constData(), O_RDONLY | O_DIRECTORY | O_NOFOLLOW | O_CLOEXEC);
    struct stat directory{};
    if (m_directory < 0 || ::fstat(m_directory, &directory) != 0 || directory.st_uid != ::getuid() ||
        (directory.st_mode & 07777) != 0700 || QFileInfo(m_root).canonicalFilePath() != m_root) {
        if (m_directory >= 0) ::close(m_directory); m_directory = -1; failed();
    }
    try {
    struct stat before{};
    if (::fstatat(m_directory, "preview-events.jsonl", &before, AT_SYMLINK_NOFOLLOW) != 0) { if (errno == ENOENT) return; failed(); }
    if (!privateFile(before) || before.st_size > MaximumBytes) failed();
    int fd = ::openat(m_directory, "preview-events.jsonl", O_RDONLY | O_NOFOLLOW | O_CLOEXEC | O_NONBLOCK);
    struct stat opened{}; QFile file;
    if (fd < 0 || ::fstat(fd, &opened) != 0 || !privateFile(opened) || opened.st_ino != before.st_ino ||
        opened.st_dev != before.st_dev || !file.open(fd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) {
        if (fd >= 0) ::close(fd); failed();
    }
    const auto bytes = file.read(MaximumBytes + 1);
    if (bytes.size() > MaximumBytes || (!bytes.isEmpty() && !bytes.endsWith('\n'))) failed();
    for (const auto &line : bytes.split('\n')) if (!line.isEmpty()) {
        // Do not rewrite unknown/imported content as if it were safe history.
        if (!validSaved(line) || m_records.size() >= MaximumRecords) failed();
        m_records.append(QJsonDocument(QJsonDocument::fromJson(line).object()).toJson(QJsonDocument::Compact) + '\n');
    }
    } catch (...) { ::close(m_directory); m_directory = -1; throw; }
}
Writer::~Writer() { if (m_directory >= 0) ::close(m_directory); }
void Writer::record(const QString &event, const QString &code, qint64 value) {
    if (!knownEvent(event) || value < -9007199254740991LL || value > 9007199254740991LL ||
        (event == "service_failure" && (value < 0 || value > 9))) failed();
    QJsonObject object{{"schema", "reverie.qt.preview-event.v1"}, {"event", event},
        {"hostPid", QCoreApplication::applicationPid()}, {"sequence", ++m_sequence},
        {"timeMs", QDateTime::currentMSecsSinceEpoch()}, {"elapsedMs", m_clock.elapsed()},
        {"code", normalizedCode(code)}, {"value", value}};
    auto next = m_records; next.append(QJsonDocument(object).toJson(QJsonDocument::Compact) + '\n');
    auto size = [&] { qint64 total = 0; for (const auto &r : next) total += r.size(); return total; };
    while (next.size() > MaximumRecords || size() > MaximumBytes) next.removeFirst();
    QByteArray bytes; for (const auto &line : next) bytes += line;
    const QByteArray final("preview-events.jsonl");
    const QByteArray temp = (".preview-events-" + QUuid::createUuid().toString(QUuid::Id128)).toUtf8();
    struct stat old{};
    if (::fstatat(m_directory, final.constData(), &old, AT_SYMLINK_NOFOLLOW) == 0) { if (!privateFile(old)) failed(); }
    else if (errno != ENOENT) failed();
    int fd = ::openat(m_directory, temp.constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    if (fd < 0) failed();
    bool ok = ::fchmod(fd, 0600) == 0; qsizetype written = 0;
    while (ok && written < bytes.size()) {
        const auto n = ::write(fd, bytes.constData() + written, size_t(bytes.size() - written));
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) { ok = false; break; } written += n;
    }
    if (::fsync(fd) != 0) ok = false;
    if (::close(fd) != 0) ok = false;
    if (ok && ::renameat(m_directory, temp.constData(), m_directory, final.constData()) != 0) ok = false;
    if (!ok) { ::unlinkat(m_directory, temp.constData(), 0); failed(); }
    m_records = std::move(next);
}
} // namespace PreviewEvents
