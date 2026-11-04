#include "PreviewSnapshot.h"
#include "PreviewPlatform.h"
#include "PreviewWorkspace.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QSet>
#include <QUuid>
#include <algorithm>
#include <cerrno>
#include <limits>

namespace PreviewSnapshot {
namespace {
namespace P = PreviewPlatform;
constexpr qint64 ManifestLimit = 16 * 1024 * 1024;
constexpr qsizetype EntryLimit = 100000, DepthLimit = 128;
const char *const Invalid = "PREVIEW_SNAPSHOT_INVALID";
const char *const IoFailed = "PREVIEW_SNAPSHOT_IO_FAILED";
const char *const NoSpace = "PREVIEW_SNAPSHOT_NO_SPACE";
const char *const Special = "PREVIEW_SNAPSHOT_SPECIAL_FILE";
const char *const Limit = "PREVIEW_SNAPSHOT_ENTRY_LIMIT";
const char *const Changed = "PREVIEW_SNAPSHOT_SOURCE_CHANGED";
const char *const Verify = "PREVIEW_SNAPSHOT_VERIFY_FAILED";
[[noreturn]] void platformError(const P::Error &error) {
    switch (error.reason) {
    case P::Failure::NoSpace: throw Error(NoSpace);
    case P::Failure::SpecialFile: throw Error(Special);
    case P::Failure::Changed: throw Error(Changed);
    case P::Failure::Limit: throw Error(Limit);
    case P::Failure::Invalid: throw Error(Invalid);
    default: throw Error(IoFailed);
    }
}
[[noreturn]] void ioError() { try { P::throwLastIoError(); } catch (const P::Error &error) { platformError(error); } }
bool matches(const QString &text, const char *pattern) { return QRegularExpression(QString::fromLatin1(pattern)).match(text).hasMatch(); }
bool keys(const QJsonObject &object, QStringList wanted) { auto actual = object.keys(); actual.sort(); wanted.sort(); return actual == wanted; }
QString token() { return QUuid::createUuid().toString(QUuid::Id128); }
QByteArray encoded(const QString &value) { return QFile::encodeName(value); }
struct Entry { QString path; P::Metadata status; };
struct Inventory { QList<Entry> directories, files; quint64 bytes = 0; };
struct Ready { Identity identity; QString id; bool exists = false; };
struct Snapshot {
    QString name, createdAt, fromReadyId, transition, kind;
    Identity from, to, dataIdentity;
    QJsonObject manifest;
};
bool safePath(const QString &path, bool file) {
    if (path.isEmpty() || path.contains('\\') || path.contains(QChar::Null)) return false;
    const auto components = path.split('/');
    if ((components.first() != "data" && components.first() != "avatars") || (file && components.size() < 2) ||
        (components.first() == "data" && components.size() > 1 && components[1] == "cache")) return false;
    for (const auto &component : components)
        if (component.isEmpty() || component == "." || component == ".." || QFile::decodeName(encoded(component)) != component) return false;
    return true;
}
QString leaf(const QString &path) { return path.section('/', -1); }
P::Handle parentFor(const P::Handle &root, const QString &path) {
    auto parent = P::duplicate(root); const auto components = path.split('/');
    for (qsizetype i = 0; i + 1 < components.size(); ++i) parent = P::openDirectory(parent, encoded(components[i]));
    return parent;
}
void scan(const P::Handle &directory, const QString &prefix, Inventory &result, bool source) {
    if (prefix.count('/') >= DepthLimit) throw Error(Limit);
    for (const auto &name : P::children(directory, EntryLimit)) {
        const auto decoded = QFile::decodeName(name);
        if (encoded(decoded) != name) throw Error(Invalid);
        const auto path = prefix.isEmpty() ? decoded : prefix + '/' + decoded;
        if (source && path == "data/cache") continue;
        if (result.files.size() + result.directories.size() >= EntryLimit) throw Error(Limit);
        const auto value = P::inspect(directory, name);
        if (value.kind == P::Kind::Directory) {
            if (!safePath(path, false)) throw Error(Invalid);
            auto child = P::openDirectory(directory, name, !source);
            result.directories.append({path, value}); scan(child, path, result, source);
        } else if (value.kind == P::Kind::Regular) {
            if (!safePath(path, true) || !value.owned || !value.links || (!source && value.links != 1) ||
                (!source && !value.privateAccess)) throw Error(Special);
            if (value.bytes > std::numeric_limits<quint64>::max() - result.bytes) throw Error(Limit);
            result.files.append({path, value}); result.bytes += value.bytes;
        } else throw Error(Special);
    }
}
Inventory inventory(const P::Handle &root, bool source) {
    Inventory result;
    for (const auto *name : {"data", "avatars"}) {
        auto directory = P::openDirectory(root, name, !source);
        result.directories.append({QString::fromLatin1(name), P::inspect(root, name)});
        scan(directory, QString::fromLatin1(name), result, source);
    }
    return result;
}
QByteArray bounded(const P::Handle &file, qint64 maximum) {
    QByteArray result; char chunk[65536];
    for (;;) {
        const auto count = P::read(file, chunk, sizeof(chunk)); if (!count) return result;
        if (result.size() > maximum - count) throw Error(Limit);
        result.append(chunk, qsizetype(count));
    }
}
QJsonObject jsonFile(const P::Handle &parent, const QByteArray &name, qint64 maximum) {
    auto file = P::openRegular(parent, name); const auto before = P::metadata(file);
    if (!before.bytes || before.bytes > quint64(maximum)) throw Error(Invalid);
    QJsonParseError error; const auto document = QJsonDocument::fromJson(bounded(file, maximum), &error);
    if (!P::unchanged(before, P::metadata(file)) || error.error != QJsonParseError::NoError || !document.isObject()) throw Error(Invalid);
    return document.object();
}
Ready readReady(const P::Handle &root) {
    if (P::inspect(root, "ready-candidate.json").kind == P::Kind::Missing) return {};
    const auto object = jsonFile(root, "ready-candidate.json", 4096);
    if (!keys(object, {"schema", "readyId", "candidate", "sourceHead", "buildManifestSha256"}) ||
        object["schema"] != "reverie.preview.ready-candidate.v1" || !matches(object["readyId"].toString(), "^[0-9a-f]{32}$"))
        throw Error("PREVIEW_READY_CANDIDATE_INVALID");
    return {identityFromJson(QJsonObject{{"candidate", object["candidate"]}, {"sourceHead", object["sourceHead"]},
        {"buildManifestSha256", object["buildManifestSha256"]}}), object["readyId"].toString(), true};
}
QString transitionDigest(const Ready &from, const Identity &to) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject{{"fromReadyId", from.id},
        {"from", identityJson(from.identity)}, {"to", identityJson(to)}}).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
void writeAll(FileOperations &operations, const P::Handle &file, const char *bytes, qint64 size) {
    qint64 offset = 0;
    while (offset < size) {
        const auto count = operations.write(file.nativeDescriptor(), bytes + offset, size - offset);
        if (count < 0) { if (errno == EINTR) continue; ioError(); }
        if (!count || count > size - offset) throw Error(IoFailed);
        offset += count;
    }
}
void sync(FileOperations &operations, const P::Handle &file) { if (!operations.sync(file.nativeDescriptor())) ioError(); }
void writeBytes(FileOperations &operations, const P::Handle &parent, const QByteArray &name, const QByteArray &bytes) {
    auto file = P::createFile(parent, name); writeAll(operations, file, bytes.constData(), bytes.size()); sync(operations, file);
}
QByteArray fileHash(const P::Handle &parent, const QByteArray &name, quint64 expected) {
    auto file = P::openRegular(parent, name); const auto before = P::metadata(file);
    if (before.bytes != expected) throw Error(Verify);
    QCryptographicHash hash(QCryptographicHash::Sha256); char chunk[65536]; quint64 total = 0;
    for (;;) {
        const auto count = P::read(file, chunk, sizeof(chunk)); if (!count) break;
        if (quint64(count) > expected - total) throw Error(Verify);
        hash.addData(QByteArrayView(chunk, count)); total += quint64(count);
    }
    if (total != expected) throw Error(Verify);
    if (!P::unchanged(before, P::metadata(file))) throw Error(Invalid);
    return hash.result().toHex();
}
quint64 decimal(const QJsonValue &value) {
    if (!value.isString() || !matches(value.toString(), "^(0|[1-9][0-9]{0,19})$")) throw Error(Invalid);
    bool ok = false; const auto result = value.toString().toULongLong(&ok); if (!ok) throw Error(Invalid); return result;
}
QString namePrefix(const Snapshot &snapshot) {
    if (snapshot.kind == "pre-restore") return "pre-restore-" + snapshot.createdAt + '-' + snapshot.dataIdentity.candidate.left(32) + '-';
    return "snapshot-" + snapshot.createdAt + '-' + snapshot.from.candidate.left(32) + "--" + snapshot.to.candidate.left(32) + '-' + snapshot.transition.left(32) + '-';
}
Snapshot validate(const P::Handle &directory, const QString &name) {
    const auto manifest = jsonFile(directory, "manifest.json", ManifestLimit);
    const bool old = manifest["schema"] == "reverie.preview.snapshot.v1";
    const bool current = manifest["schema"] == "reverie.preview.snapshot.v2";
    QStringList expected{"schema", "name", "createdAt", "fromReadyId", "from", "to", "transitionSha256", "files", "directories", "totalBytes"};
    if (current) expected.append({"kind", "dataIdentity"});
    if ((!old && !current) || !keys(manifest, expected) || manifest["name"] != name ||
        !matches(manifest["createdAt"].toString(), "^[0-9]{8}T[0-9]{9}Z$") ||
        !matches(manifest["fromReadyId"].toString(), "^[0-9a-f]{32}$") || !manifest["files"].isArray() || !manifest["directories"].isArray()) throw Error(Invalid);
    Snapshot result{name, manifest["createdAt"].toString(), manifest["fromReadyId"].toString(), manifest["transitionSha256"].toString(),
        old ? QStringLiteral("upgrade") : manifest["kind"].toString(), identityFromJson(manifest["from"]), identityFromJson(manifest["to"]), {}, manifest};
    result.dataIdentity = old ? result.from : identityFromJson(manifest["dataIdentity"]);
    if ((result.kind != "upgrade" && result.kind != "pre-restore") || (result.kind == "upgrade" && (!(result.dataIdentity == result.from) || result.from == result.to))) throw Error(Invalid);
    const auto date = QDate::fromString(result.createdAt.left(8), "yyyyMMdd");
    const auto time = QTime::fromString(result.createdAt.mid(9, 9), "HHmmsszzz");
    const Ready previous{result.from, result.fromReadyId, true};
    if (!date.isValid() || !time.isValid() || date.toString("yyyyMMdd") + 'T' + time.toString("HHmmsszzz") + 'Z' != result.createdAt ||
        result.transition != transitionDigest(previous, result.to) || !name.startsWith(namePrefix(result)) ||
        !matches(name.mid(namePrefix(result).size()), "^[0-9a-f]{8}$")) throw Error(Invalid);
    QSet<QString> directories, files; quint64 total = 0;
    const auto directoryArray = manifest["directories"].toArray(), fileArray = manifest["files"].toArray();
    if (directoryArray.size() + fileArray.size() > EntryLimit) throw Error(Limit);
    for (const auto &value : directoryArray) {
        if (!value.isString() || !safePath(value.toString(), false) || directories.contains(value.toString())) throw Error(Invalid);
        directories.insert(value.toString());
    }
    if (!directories.contains("data") || !directories.contains("avatars")) throw Error(Invalid);
    for (const auto &path : directories) if (path.contains('/') && !directories.contains(path.section('/', 0, -2))) throw Error(Invalid);
    for (const auto &value : fileArray) {
        const auto file = value.toObject(); const auto path = file["path"].toString();
        const QStringList fields = old ? QStringList{"path", "size", "sha256"} : QStringList{"path", "type", "sourceLinkCount", "size", "sha256"};
        if (!value.isObject() || !keys(file, fields) || !safePath(path, true) || !matches(file["sha256"].toString(), "^[0-9a-f]{64}$") ||
            files.contains(path) || directories.contains(path) || !directories.contains(path.section('/', 0, -2))) throw Error(Invalid);
        if (!old && (file["type"] != "regular" || !decimal(file["sourceLinkCount"]))) throw Error(Invalid);
        const auto size = decimal(file["size"]); if (size > std::numeric_limits<quint64>::max() - total) throw Error(Limit);
        auto parent = parentFor(directory, path); if (fileHash(parent, encoded(leaf(path)), size) != file["sha256"].toString().toLatin1()) throw Error(Verify);
        files.insert(path); total += size;
    }
    if (total != decimal(manifest["totalBytes"])) throw Error(Invalid);
    for (const auto &entry : P::children(directory)) if (entry != "data" && entry != "avatars" && entry != "manifest.json") throw Error(Invalid);
    const auto actual = inventory(directory, false);
    if (actual.files.size() != files.size() || actual.directories.size() != directories.size()) throw Error(Invalid);
    for (const auto &entry : actual.files) if (!files.contains(entry.path)) throw Error(Invalid);
    for (const auto &entry : actual.directories) if (!directories.contains(entry.path)) throw Error(Invalid);
    return result;
}
void removeContents(const P::Handle &directory, qsizetype depth = 0) {
    if (depth > DepthLimit) throw Error(Limit);
    for (const auto &name : P::children(directory)) {
        const auto before = P::inspect(directory, name);
        if (before.kind == P::Kind::Directory) {
            auto child = P::openDirectory(directory, name, true); removeContents(child, depth + 1);
            if (!P::sameObject(P::inspect(directory, name), P::metadata(child))) throw Error(Invalid);
            P::removeEntry(directory, name, true);
        } else P::removeEntry(directory, name, false);
    }
}
void removeOwned(const P::Handle &parent, const QByteArray &name, const P::Handle &directory) {
    const auto identity = P::metadata(directory);
    if (!P::sameObject(P::inspect(parent, name), identity)) throw Error(Invalid);
    removeContents(directory);
    const auto after = P::inspect(parent, name);
    if (after.volume != identity.volume || after.object != identity.object) throw Error(Invalid);
    P::removeEntry(parent, name, true);
}
void copyFile(FileOperations &operations, const P::Handle &root, const P::Handle &targetRoot, const Entry &entry, QJsonArray &files, bool sourceLinks) {
    auto parent = parentFor(root, entry.path); auto source = P::openRegular(parent, encoded(leaf(entry.path)), !sourceLinks, sourceLinks);
    const auto before = P::metadata(source); if (!P::unchanged(entry.status, before)) throw Error(Changed);
    auto targetParent = parentFor(targetRoot, entry.path); auto target = P::createFile(targetParent, encoded(leaf(entry.path)));
    QCryptographicHash hash(QCryptographicHash::Sha256); char chunk[65536]; quint64 total = 0;
    for (;;) {
        const auto count = P::read(source, chunk, sizeof(chunk)); if (!count) break;
        if (quint64(count) > before.bytes - total) throw Error(Changed);
        hash.addData(QByteArrayView(chunk, count)); writeAll(operations, target, chunk, count); total += quint64(count);
    }
    if (total != before.bytes || !P::unchanged(before, P::metadata(source))) throw Error(Changed);
    sync(operations, target); const auto digest = hash.result().toHex();
    if (fileHash(targetParent, encoded(leaf(entry.path)), total) != digest) throw Error(Verify);
    files.append(QJsonObject{{"path", entry.path}, {"type", "regular"}, {"sourceLinkCount", QString::number(before.links)},
        {"size", QString::number(total)}, {"sha256", QString::fromLatin1(digest)}});
}
void createPayload(FileOperations &operations, const P::Handle &source, const P::Handle &target, const Inventory &before, QJsonArray &directories, QJsonArray &files, bool sourceLinks) {
    for (const auto &entry : before.directories) { auto parent = parentFor(target, entry.path); P::createDirectory(parent, encoded(leaf(entry.path))); directories.append(entry.path); }
    for (const auto &entry : before.files) copyFile(operations, source, target, entry, files, sourceLinks);
    const auto after = inventory(source, sourceLinks);
    if (before.directories.size() != after.directories.size() || before.files.size() != after.files.size()) throw Error(Changed);
    for (qsizetype i = 0; i < before.files.size(); ++i)
        if (before.files[i].path != after.files[i].path || !P::unchanged(before.files[i].status, after.files[i].status)) throw Error(Changed);
    for (qsizetype i = 0; i < before.directories.size(); ++i)
        if (before.directories[i].path != after.directories[i].path || before.directories[i].status.volume != after.directories[i].status.volume ||
            before.directories[i].status.object != after.directories[i].status.object) throw Error(Changed);
    for (auto i = before.directories.crbegin(); i != before.directories.crend(); ++i) {
        auto parent = parentFor(target, i->path); auto child = P::openDirectory(parent, encoded(leaf(i->path)), true); sync(operations, child);
    }
    sync(operations, target);
}
struct Store {
    P::Handle root;
    std::shared_ptr<FileOperations> operations;
    QStringList warnings;
    Store(const PreviewWorkspace::Session &session, std::shared_ptr<FileOperations> io) : root(P::openRoot(session.root())), operations(std::move(io)) {
        if (!operations) operations = std::make_shared<FileOperations>();
    }
    P::Handle snapshots(bool create) {
        if (P::inspect(root, "snapshots").kind == P::Kind::Missing && create) P::createDirectory(root, "snapshots");
        return P::openDirectory(root, "snapshots", true);
    }
    QList<Snapshot> managed(const P::Handle &directory) {
        QList<Snapshot> result;
        for (const auto &name : P::children(directory)) {
            try {
                const auto decoded = QFile::decodeName(name);
                if (encoded(decoded) != name || (!decoded.startsWith("snapshot-") && !decoded.startsWith("pre-restore-"))) throw Error(Invalid);
                auto child = P::openDirectory(directory, name, true); result.append(validate(child, decoded));
            } catch (const Error &) { if (!warnings.contains("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT")) warnings.append("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT"); }
              catch (const P::Error &) { if (!warnings.contains("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT")) warnings.append("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT"); }
        }
        return result;
    }
    void prune(const QStringList &protectedNames, const QString &priority = {}) {
        if (P::inspect(root, "snapshots").kind == P::Kind::Missing) return;
        if (P::inspect(root, "restore-transaction.json").kind != P::Kind::Missing) return;
        auto directory = snapshots(false); auto valid = managed(directory);
        std::sort(valid.begin(), valid.end(), [&priority](const Snapshot &a, const Snapshot &b) {
            if ((a.name == priority) != (b.name == priority)) return a.name == priority;
            return a.createdAt == b.createdAt ? a.name > b.name : a.createdAt > b.createdAt;
        });
        int upgrades = 0, preRestore = 0;
        for (const auto &value : valid) {
            auto &count = value.kind == "upgrade" ? upgrades : preRestore; ++count;
            const auto limit = value.kind == "upgrade" ? 3 : 1;
            if (count <= limit || protectedNames.contains(value.name)) continue;
            try { auto child = P::openDirectory(directory, encoded(value.name), true); validate(child, value.name); removeOwned(directory, encoded(value.name), child); }
            catch (...) { if (!warnings.contains("PREVIEW_SNAPSHOT_RETENTION_WARNING")) warnings.append("PREVIEW_SNAPSHOT_RETENTION_WARNING"); }
        }
    }
    Snapshot save(const Ready &from, const Identity &to, const QString &kind, const QStringList &protectedNames = {}) {
        if (!from.exists) throw Error("PREVIEW_READY_CANDIDATE_INVALID");
        auto directory = snapshots(true); const auto before = inventory(root, true);
        operations->checkpoint("snapshot.source-scanned");
        if (before.bytes > std::numeric_limits<quint64>::max() - quint64(ManifestLimit) || operations->availableBytes(directory.nativeDescriptor()) < before.bytes + quint64(ManifestLimit)) throw Error(NoSpace);
        const auto temporaryName = encoded(".snapshot-tmp-" + token()); P::createDirectory(directory, temporaryName);
        auto temporary = P::openDirectory(directory, temporaryName, true); bool published = false;
        try {
            QJsonArray directories, files; createPayload(*operations, root, temporary, before, directories, files, true);
            Snapshot value; value.createdAt = QDateTime::currentDateTimeUtc().toString("yyyyMMdd'T'HHmmsszzz'Z'");
            value.from = from.identity; value.to = to; value.fromReadyId = from.id; value.transition = transitionDigest(from, to); value.kind = kind; value.dataIdentity = from.identity;
            value.name = namePrefix(value) + token().left(8);
            value.manifest = {{"schema", "reverie.preview.snapshot.v2"}, {"name", value.name}, {"createdAt", value.createdAt},
                {"kind", kind}, {"dataIdentity", identityJson(value.dataIdentity)}, {"fromReadyId", from.id}, {"from", identityJson(from.identity)},
                {"to", identityJson(to)}, {"transitionSha256", value.transition}, {"directories", directories}, {"files", files}, {"totalBytes", QString::number(before.bytes)}};
            const auto bytes = QJsonDocument(value.manifest).toJson(QJsonDocument::Compact); if (bytes.size() > ManifestLimit) throw Error(Limit);
            writeBytes(*operations, temporary, "manifest.json", bytes); validate(temporary, value.name); sync(*operations, temporary);
            P::renameNoReplace(directory, temporaryName, encoded(value.name)); published = true; sync(*operations, directory);
            prune(protectedNames, value.name); return value;
        } catch (...) { if (!published) { try { removeOwned(directory, temporaryName, temporary); } catch (...) {} } throw; }
    }
};
}

bool validIdentity(const Identity &identity) {
    return matches(identity.candidate, "^[A-Za-z0-9._-]{1,128}$") && identity.candidate != "." && identity.candidate != ".." &&
        matches(identity.sourceHead, "^[0-9a-f]{40}$") && matches(identity.buildManifestSha256, "^[0-9a-f]{64}$");
}
QJsonObject identityJson(const Identity &identity) { return {{"candidate", identity.candidate}, {"sourceHead", identity.sourceHead}, {"buildManifestSha256", identity.buildManifestSha256}}; }
Identity identityFromJson(const QJsonValue &value) {
    const auto object = value.toObject();
    if (!value.isObject() || !keys(object, {"candidate", "sourceHead", "buildManifestSha256"})) throw Error(Invalid);
    Identity identity{object["candidate"].toString(), object["sourceHead"].toString(), object["buildManifestSha256"].toString()};
    if (!validIdentity(identity)) throw Error(Invalid);
    return identity;
}
QString failureCode(const QString &code) {
    for (const auto *fixed : {NoSpace, Special, Limit, Changed, Verify, IoFailed}) if (code == QLatin1String(fixed)) return code;
    if (code.contains("INVALID") || code.contains("VERIFY")) return QString::fromLatin1(Verify);
    if (code.contains("CHANGED")) return QString::fromLatin1(Changed);
    return QString::fromLatin1(IoFailed);
}
QString failureMessage(const QString &raw) {
    const auto code = failureCode(raw);
    if (code == QLatin1String(NoSpace)) return QStringLiteral("工作区快照或恢复未完成：可用空间不足。请释放空间后重试；不要删除工作区或快照。");
    if (code == QLatin1String(Special)) return QStringLiteral("工作区快照或恢复未完成：遇到符号链接、管道、设备或不安全文件。请保留现场并导出诊断反馈。");
    if (code == QLatin1String(Limit)) return QStringLiteral("工作区快照或恢复未完成：文件数量、目录深度或清单超过上限。请保留现场并导出诊断反馈。");
    if (code == QLatin1String(Changed)) return QStringLiteral("工作区快照或恢复未完成：复制时源数据发生变化。请关闭使用此工作区的程序后重试。");
    if (code == QLatin1String(Verify)) return QStringLiteral("工作区快照或恢复未完成：清单或内容校验失败。请保留现有数据和快照并导出诊断反馈。");
    return QStringLiteral("工作区快照或恢复未完成：文件读写失败。请检查磁盘连接与工作区权限后重试。");
}
qint64 FileOperations::write(int descriptor, const char *bytes, qint64 size) { return P::writeNative(descriptor, bytes, size); }
bool FileOperations::sync(int descriptor) { return P::syncNative(descriptor); }
quint64 FileOperations::availableBytes(int descriptor) { return P::availableBytesNative(descriptor); }
void FileOperations::checkpoint(const QString &) {}

struct Repository::Impl { Store store; Impl(const PreviewWorkspace::Session &session, std::shared_ptr<FileOperations> io) : store(session, std::move(io)) {} };
Repository::Repository(const PreviewWorkspace::Session &session, std::shared_ptr<FileOperations> io) {
    try { m_impl = std::make_unique<Impl>(session, std::move(io)); } catch (const P::Error &error) { platformError(error); }
}
Repository::~Repository() = default;
QJsonArray Repository::list() {
    try {
        auto &store = m_impl->store; QJsonArray result;
        if (P::inspect(store.root, "snapshots").kind == P::Kind::Missing) return result;
        auto directory = store.snapshots(false); auto values = store.managed(directory);
        std::sort(values.begin(), values.end(), [](const Snapshot &a, const Snapshot &b) { return a.name > b.name; });
        QSet<QString> verifiedNames;
        for (const auto &value : values) result.append(QJsonObject{{"name", value.name}, {"createdAt", value.createdAt}, {"kind", value.kind},
            {"from", identityJson(value.from)}, {"to", identityJson(value.to)}, {"dataIdentity", identityJson(value.dataIdentity)},
            {"totalBytes", value.manifest["totalBytes"]}, {"verification", "verified"}});
        for (const auto &value : values) verifiedNames.insert(value.name);
        // Show an unsafe/corrupt managed-looking snapshot as unverified without
        // trusting any of its metadata. Unrelated names are never echoed.
        for (const auto &name : P::children(directory)) {
            const auto decoded = QFile::decodeName(name);
            if (!verifiedNames.contains(decoded) && encoded(decoded) == name &&
                matches(decoded, "^(snapshot|pre-restore)-[A-Za-z0-9._-]{1,240}$"))
                result.append(QJsonObject{{"name", decoded}, {"verification", "invalid"}});
        }
        return result;
    } catch (const P::Error &error) { platformError(error); }
}
QJsonObject Repository::manifest(const QString &name) {
    try {
        if (name.contains('/') || name.contains('\\') || name.contains(QChar::Null) || (!name.startsWith("snapshot-") && !name.startsWith("pre-restore-"))) throw Error(Invalid);
        auto directory = m_impl->store.snapshots(false); auto child = P::openDirectory(directory, encoded(name), true); return validate(child, name).manifest;
    } catch (const P::Error &error) { platformError(error); }
}
QString Repository::savePreRestore(const Identity &fallback, const QStringList &protectedNames) {
    try {
        if (!validIdentity(fallback)) throw Error(Invalid);
        auto from = readReady(m_impl->store.root); if (!from.exists) from = {fallback, token(), true};
        return m_impl->store.save(from, fallback, "pre-restore", protectedNames).name;
    } catch (const P::Error &error) { platformError(error); }
}
void Repository::copyPayload(const QString &name, const P::Handle &destination) {
    try {
        manifest(name); auto directory = m_impl->store.snapshots(false); auto source = P::openDirectory(directory, encoded(name), true);
        const auto verified = validate(source, name); const auto before = inventory(source, false);
        if (!P::children(destination).isEmpty()) throw Error(Invalid);
        if (m_impl->store.operations->availableBytes(destination.nativeDescriptor()) < before.bytes) throw Error(NoSpace);
        QJsonArray directories, files; createPayload(*m_impl->store.operations, source, destination, before, directories, files, false);
        if (validate(source, name).manifest != verified.manifest) throw Error(Changed);
    } catch (const P::Error &error) { platformError(error); }
}
void Repository::prune(const QStringList &protectedNames, const QString &priorityName) { try { m_impl->store.prune(protectedNames, priorityName); } catch (const P::Error &error) { platformError(error); } }
QStringList Repository::warnings() const { return m_impl->store.warnings; }

struct Manager::Impl {
    Store store; Identity identity; Ready previous; bool prepared = false; Result result;
    Impl(const PreviewWorkspace::Session &session, Identity current, std::shared_ptr<FileOperations> io) : store(session, std::move(io)), identity(std::move(current)) {
        if (!validIdentity(identity)) throw Error("PREVIEW_SNAPSHOT_IDENTITY_INVALID");
    }
    Result prepare() {
        if (prepared) return result;
        previous = readReady(store.root);
        if (!previous.exists) {
            try { store.prune({}); } catch (...) { store.warnings.append("PREVIEW_SNAPSHOT_RETENTION_WARNING"); }
            result.warnings = store.warnings; prepared = true; return result;
        }
        if (previous.identity == identity) {
            try { store.prune({}); } catch (...) { store.warnings.append("PREVIEW_SNAPSHOT_RETENTION_WARNING"); }
            result.warnings = store.warnings;
            result.action = Action::Unchanged; prepared = true; return result;
        }
        auto directory = store.snapshots(true); const auto transition = transitionDigest(previous, identity);
        for (const auto &value : store.managed(directory)) if (value.kind == "upgrade" && value.transition == transition) {
            result.action = Action::Reused; result.snapshotName = value.name; store.prune({}, value.name); result.warnings = store.warnings; prepared = true; return result;
        }
        const auto value = store.save(previous, identity, "upgrade"); result.action = Action::Created; result.snapshotName = value.name;
        result.warnings = store.warnings; prepared = true; return result;
    }
    void markReady() {
        if (!prepared) throw Error("PREVIEW_SNAPSHOT_NOT_PREPARED");
        const auto current = readReady(store.root);
        if (current.exists != previous.exists || (current.exists && (current.id != previous.id || !(current.identity == previous.identity)))) throw Error("PREVIEW_READY_CANDIDATE_CHANGED");
        if (current.exists && current.identity == identity) return;
        auto object = identityJson(identity); object["schema"] = "reverie.preview.ready-candidate.v1"; object["readyId"] = token();
        const auto temporary = encoded(".ready-candidate-" + token() + ".tmp"); bool created = false;
        try {
            auto file = P::createFile(store.root, temporary); created = true;
            const auto bytes = QJsonDocument(object).toJson(QJsonDocument::Compact); writeAll(*store.operations, file, bytes.constData(), bytes.size()); sync(*store.operations, file);
            try { if (jsonFile(store.root, temporary, 4096) != object) throw Error(Invalid); }
            catch (const Error &) { throw Error("PREVIEW_READY_CANDIDATE_VERIFY_FAILED"); }
            P::replaceFile(store.root, temporary, "ready-candidate.json"); created = false; sync(*store.operations, store.root); previous = {identity, object["readyId"].toString(), true};
        } catch (...) { if (created) { try { P::removeEntry(store.root, temporary, false); } catch (...) {} } throw; }
    }
};
Manager::Manager(const PreviewWorkspace::Session &session, Identity identity, std::shared_ptr<FileOperations> operations) {
    try { m_impl = std::make_unique<Impl>(session, std::move(identity), std::move(operations)); } catch (const P::Error &error) { platformError(error); }
}
Manager::~Manager() = default;
Result Manager::prepare() { try { return m_impl->prepare(); } catch (const P::Error &error) { platformError(error); } }
void Manager::markReady() { try { m_impl->markReady(); } catch (const P::Error &error) { platformError(error); } }
} // namespace PreviewSnapshot
