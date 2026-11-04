#include "PreviewRestore.h"
#include "PreviewPlatform.h"
#include "PreviewWorkspace.h"
#include "PreviewDataFormat.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDebug>
#include <QFile>
#include <QJsonDocument>
#include <QRegularExpression>
#include <QUuid>
#include <cerrno>
#include <exception>

namespace PreviewRestore {
namespace {
namespace P = PreviewPlatform;
using PreviewSnapshot::Error;
using PreviewSnapshot::FileOperations;
using PreviewSnapshot::Identity;
constexpr auto Journal = "restore-transaction.json";
constexpr qint64 ControlLimit = 65536;
[[noreturn]] void recoveryRequired() { throw Error("PREVIEW_RESTORE_RECOVERY_REQUIRED"); }
[[noreturn]] void ioError() {
    try { P::throwLastIoError(); }
    catch (const P::Error &error) { throw Error(error.reason == P::Failure::NoSpace ? "PREVIEW_SNAPSHOT_NO_SPACE" : "PREVIEW_SNAPSHOT_IO_FAILED"); }
}
[[noreturn]] void convert(const P::Error &error) {
    switch (error.reason) {
    case P::Failure::NoSpace: throw Error("PREVIEW_SNAPSHOT_NO_SPACE");
    case P::Failure::SpecialFile: throw Error("PREVIEW_SNAPSHOT_SPECIAL_FILE");
    case P::Failure::Changed: throw Error("PREVIEW_SNAPSHOT_SOURCE_CHANGED");
    case P::Failure::Limit: throw Error("PREVIEW_SNAPSHOT_ENTRY_LIMIT");
    case P::Failure::Invalid: throw Error("PREVIEW_SNAPSHOT_VERIFY_FAILED");
    default: throw Error("PREVIEW_SNAPSHOT_IO_FAILED");
    }
}
QString token() { return QUuid::createUuid().toString(QUuid::Id128); }
QByteArray encoded(const QString &value) { return QFile::encodeName(value); }
bool keys(const QJsonObject &object, QStringList expected) { auto actual = object.keys(); actual.sort(); expected.sort(); return actual == expected; }
bool matches(const QString &value, const char *pattern) { return QRegularExpression(QString::fromLatin1(pattern)).match(value).hasMatch(); }
QByteArray readFile(const P::Handle &parent, const QByteArray &name, qint64 limit = ControlLimit) {
    auto file = P::openRegular(parent, name); const auto before = P::metadata(file);
    if (before.bytes > quint64(limit)) recoveryRequired();
    QByteArray result; char chunk[4096];
    for (;;) { const auto count = P::read(file, chunk, sizeof(chunk)); if (!count) break;
        if (result.size() > limit - count) recoveryRequired(); result.append(chunk, qsizetype(count)); }
    if (!P::unchanged(before, P::metadata(file))) recoveryRequired();
    return result;
}
QJsonValue optionalBytes(const P::Handle &root, const QByteArray &name) {
    if (P::inspect(root, name).kind == P::Kind::Missing) return QJsonValue::Null;
    return QString::fromLatin1(readFile(root, name).toBase64());
}
bool sameControl(const P::Handle &root, const QByteArray &name, const QJsonValue &expected) {
    const auto actual = optionalBytes(root, name); return actual == expected;
}
void sync(FileOperations &operations, const P::Handle &handle) { if (!operations.sync(handle.nativeDescriptor())) ioError(); }
void writeFile(FileOperations &operations, const P::Handle &root, const QByteArray &name, const QByteArray &bytes) {
    auto file = P::createFile(root, name); qint64 offset = 0;
    while (offset < bytes.size()) {
        const auto count = operations.write(file.nativeDescriptor(), bytes.constData() + offset, bytes.size() - offset);
        if (count < 0) { if (errno == EINTR) continue; ioError(); }
        if (!count || count > bytes.size() - offset) throw Error("PREVIEW_SNAPSHOT_IO_FAILED"); offset += count;
    }
    sync(operations, file);
    if (readFile(root, name) != bytes) throw Error("PREVIEW_SNAPSHOT_VERIFY_FAILED");
}
void replaceControl(FileOperations &operations, const P::Handle &root, const QByteArray &name, const QJsonValue &value) {
    if (P::inspect(root, name).kind != P::Kind::Missing) {
        auto existing = P::openRegular(root, name);
        if (!P::sameObject(P::metadata(existing), P::inspect(root, name))) recoveryRequired();
    }
    if (value.isNull()) {
        if (P::inspect(root, name).kind != P::Kind::Missing) P::removeEntry(root, name, false);
        sync(operations, root); return;
    }
    if (!value.isString()) recoveryRequired();
    const auto text = value.toString().toLatin1();
    const auto bytes = QByteArray::fromBase64(text, QByteArray::AbortOnBase64DecodingErrors);
    if (bytes.toBase64() != text || bytes.size() > ControlLimit) recoveryRequired();
    const auto temporary = encoded(".restore-control-" + token()); bool created = false;
    try {
        // CreateFile is exclusive; only remove a temporary successfully owned by
        // this call. A crash may leave it, but never makes it a deletion target.
        auto file = P::createFile(root, temporary); created = true;
        qint64 offset = 0;
        while (offset < bytes.size()) {
            const auto count = operations.write(file.nativeDescriptor(), bytes.constData() + offset, bytes.size() - offset);
            if (count < 0) { if (errno == EINTR) continue; ioError(); }
            if (!count || count > bytes.size() - offset) throw Error("PREVIEW_SNAPSHOT_IO_FAILED"); offset += count;
        }
        sync(operations, file);
        if (readFile(root, temporary) != bytes) throw Error("PREVIEW_SNAPSHOT_VERIFY_FAILED");
        P::replaceFile(root, temporary, name); created = false; sync(operations, root);
    } catch (...) { if (created) { try { P::removeEntry(root, temporary, false); } catch (...) {} } throw; }
}
QJsonValue jsonBytes(const QJsonObject &object) { return QString::fromLatin1(QJsonDocument(object).toJson(QJsonDocument::Compact).toBase64()); }
QJsonObject identity(const P::Metadata &value) {
    if (value.kind != P::Kind::Directory || !value.owned) recoveryRequired();
    return {{"volume", QString::number(value.volume)}, {"object", QString::number(value.object)}};
}
bool validObjectIdentity(const QJsonValue &value) {
    if (!value.isObject() || !keys(value.toObject(), {"volume", "object"})) return false;
    for (const auto *key : {"volume", "object"}) {
        const auto text = value.toObject()[key].toString(); bool ok = false;
        text.toULongLong(&ok); if (!ok || !matches(text, "^(0|[1-9][0-9]{0,19})$")) return false;
    }
    return true;
}
bool isIdentity(const P::Metadata &value, const QJsonValue &expected) {
    return value.kind == P::Kind::Directory && value.owned && validObjectIdentity(expected) && identity(value) == expected.toObject();
}
bool missing(const P::Metadata &value) { return value.kind == P::Kind::Missing; }
void removeTree(const P::Handle &parent, const QByteArray &name, const QJsonValue &expected, qsizetype depth = 0) {
    const auto before = P::inspect(parent, name);
    if (missing(before)) return;
    if (depth > 128 || !isIdentity(before, expected)) recoveryRequired();
    auto directory = P::openDirectory(parent, name);
    for (const auto &childName : P::children(directory)) {
        const auto child = P::inspect(directory, childName);
        if (!child.owned) recoveryRequired();
        if (child.kind == P::Kind::Directory) removeTree(directory, childName, identity(child), depth + 1);
        else P::removeEntry(directory, childName, false); // unlink links, never follow
    }
    if (!isIdentity(P::inspect(parent, name), expected) || !isIdentity(P::metadata(directory), expected)) recoveryRequired();
    P::removeEntry(parent, name, true);
}
struct Transaction {
    QJsonObject object;
    QString id, phase;
    QByteArray stage, oldData, oldAvatars;
};
Transaction transaction(const QJsonObject &object, const P::Handle &root) {
    if (!keys(object, {"schema", "id", "phase", "rootIdentity", "stageIdentity", "oldDataIdentity", "oldAvatarsIdentity", "newDataIdentity", "newAvatarsIdentity",
        "snapshot", "preRestoreSnapshot", "oldReady", "newReady", "oldSource", "newSource"}) || object["schema"] != "reverie.preview.restore-transaction.v1" ||
        !matches(object["id"].toString(), "^[0-9a-f]{32}$") || (object["phase"] != "prepared" && object["phase"] != "committed" && object["phase"] != "rolled-back")) recoveryRequired();
    for (const auto *field : {"rootIdentity", "stageIdentity", "oldDataIdentity", "oldAvatarsIdentity", "newDataIdentity", "newAvatarsIdentity"})
        if (!validObjectIdentity(object[field])) recoveryRequired();
    if (!isIdentity(P::metadata(root), object["rootIdentity"])) recoveryRequired();
    for (const auto *field : {"oldReady", "newReady", "oldSource", "newSource"}) {
        const auto value = object[field]; if (value.isNull()) continue;
        const auto text = value.toString().toLatin1(); const auto bytes = QByteArray::fromBase64(text, QByteArray::AbortOnBase64DecodingErrors);
        if (!value.isString() || bytes.size() > ControlLimit || bytes.toBase64() != text) recoveryRequired();
    }
    if (object["newReady"].isNull() || object["newSource"].isNull()) recoveryRequired();
    for (const auto *field : {"snapshot", "preRestoreSnapshot"})
        if (!matches(object[field].toString(), "^(snapshot|pre-restore)-[A-Za-z0-9._-]{1,240}$")) recoveryRequired();
    const auto id = object["id"].toString();
    return {object, id, object["phase"].toString(), encoded(".restore-stage-" + id), encoded(".restore-old-data-" + id), encoded(".restore-old-avatars-" + id)};
}
Transaction readTransaction(const P::Handle &root) {
    QJsonParseError error; const auto document = QJsonDocument::fromJson(readFile(root, Journal), &error);
    if (error.error != QJsonParseError::NoError || !document.isObject()) recoveryRequired();
    return transaction(document.object(), root);
}
void persist(FileOperations &operations, const P::Handle &root, Transaction &value, const QString &phase) {
    auto object = value.object; object["phase"] = phase;
    replaceControl(operations, root, Journal, jsonBytes(object));
    value.object = object; value.phase = phase;
}
void validateControlChoices(const P::Handle &root, const Transaction &value, bool finalNew, bool finalOld = false) {
    for (const auto *name : {"Ready", "Source"}) {
        const auto file = QByteArray(name) == "Ready" ? QByteArrayLiteral("ready-candidate.json") : QByteArrayLiteral("restore-source.json");
        const auto oldValue = value.object[QStringLiteral("old") + name], newValue = value.object[QStringLiteral("new") + name];
        if (finalNew ? !sameControl(root, file, newValue) : finalOld ? !sameControl(root, file, oldValue) :
            (!sameControl(root, file, oldValue) && !sameControl(root, file, newValue))) recoveryRequired();
    }
}
enum class TreeState { Original, Detached, Replaced };
TreeState treeState(const P::Handle &root, const P::Handle &stage, const QByteArray &name, const QByteArray &backup,
                    const QJsonValue &oldIdentity, const QJsonValue &newIdentity) {
    const auto live = P::inspect(root, name), saved = P::inspect(root, backup), fresh = P::inspect(stage, name);
    if (isIdentity(live, oldIdentity) && missing(saved) && isIdentity(fresh, newIdentity)) return TreeState::Original;
    if (missing(live) && isIdentity(saved, oldIdentity) && isIdentity(fresh, newIdentity)) return TreeState::Detached;
    if (isIdentity(live, newIdentity) && isIdentity(saved, oldIdentity) && missing(fresh)) return TreeState::Replaced;
    recoveryRequired();
}
void cleanup(FileOperations &operations, const P::Handle &root, Transaction &value) {
    const bool committed = value.phase == "committed";
    if (!committed && value.phase != "rolled-back") recoveryRequired();
    validateControlChoices(root, value, committed, !committed);
    for (const auto *name : {"data", "avatars"}) {
        const auto title = QString::fromLatin1(name) == "data" ? QStringLiteral("Data") : QStringLiteral("Avatars");
        const auto expected = value.object[(committed ? QStringLiteral("new") : QStringLiteral("old")) + title + "Identity"];
        if (!isIdentity(P::inspect(root, name), expected)) recoveryRequired();
        const auto backup = QByteArray(name) == "data" ? value.oldData : value.oldAvatars;
        if (!committed && !missing(P::inspect(root, backup))) recoveryRequired();
    }
    operations.checkpoint("restore.cleanup.begin");
    if (committed) {
        removeTree(root, value.oldData, value.object["oldDataIdentity"]); sync(operations, root); operations.checkpoint("restore.cleanup.data");
        removeTree(root, value.oldAvatars, value.object["oldAvatarsIdentity"]); sync(operations, root); operations.checkpoint("restore.cleanup.avatars");
    }
    removeTree(root, value.stage, value.object["stageIdentity"]); sync(operations, root); operations.checkpoint("restore.cleanup.stage");
    // The still-present journal pins its snapshots until all referenced trees
    // are removed. It is always the final object removed from a transaction.
    if (readTransaction(root).object != value.object) recoveryRequired();
    P::removeEntry(root, Journal, false); sync(operations, root);
}
void checkDataAt(const P::Handle &parent, const QByteArray &name) {
    auto data = P::openDirectory(parent, name, true);
    PreviewDataFormat::checkDataDirectory(data);
}
void recover(FileOperations &operations, const P::Handle &root) {
    if (missing(P::inspect(root, Journal))) return;
    auto value = readTransaction(root);
    if (value.phase != "prepared") {
        // Recovery may encounter a committed or already rolled-back cleanup.
        // Inspect every still-present data generation before deleting evidence.
        const auto liveIdentity = value.phase == "committed" ? value.object["newDataIdentity"] : value.object["oldDataIdentity"];
        if (!isIdentity(P::inspect(root, "data"), liveIdentity)) recoveryRequired();
        checkDataAt(root, "data");
        if (!missing(P::inspect(root, value.oldData))) {
            if (!isIdentity(P::inspect(root, value.oldData), value.object["oldDataIdentity"])) recoveryRequired();
            checkDataAt(root, value.oldData);
        }
        if (!missing(P::inspect(root, value.stage))) {
            if (!isIdentity(P::inspect(root, value.stage), value.object["stageIdentity"])) recoveryRequired();
            auto stage = P::openDirectory(root, value.stage, true);
            if (!missing(P::inspect(stage, "data"))) {
                if (!isIdentity(P::inspect(stage, "data"), value.object["newDataIdentity"])) recoveryRequired();
                checkDataAt(stage, "data");
            }
        }
        cleanup(operations, root, value); return;
    }
    if (!isIdentity(P::inspect(root, value.stage), value.object["stageIdentity"])) recoveryRequired();
    auto stage = P::openDirectory(root, value.stage, true);
    // Validate both trees and both controls before the first rollback write.
    const auto dataState = treeState(root, stage, "data", value.oldData, value.object["oldDataIdentity"], value.object["newDataIdentity"]);
    treeState(root, stage, "avatars", value.oldAvatars, value.object["oldAvatarsIdentity"], value.object["newAvatarsIdentity"]);
    validateControlChoices(root, value, false);
    // A missing live data name must never silently inherit legacy format 1.
    // The journal identifies both the original and staged/live replacement.
    checkDataAt(root, dataState == TreeState::Original ? QByteArrayLiteral("data") : value.oldData);
    checkDataAt(dataState == TreeState::Replaced ? root : stage, "data");
    operations.checkpoint("restore.rollback.begin");
    for (const auto *name : {"data", "avatars"}) {
        const auto title = QByteArray(name) == "data" ? QStringLiteral("Data") : QStringLiteral("Avatars");
        const auto backup = QByteArray(name) == "data" ? value.oldData : value.oldAvatars;
        auto state = treeState(root, stage, name, backup, value.object["old" + title + "Identity"], value.object["new" + title + "Identity"]);
        if (state == TreeState::Replaced) {
            P::moveNoReplace(root, name, stage, name); sync(operations, stage); sync(operations, root);
            operations.checkpoint("restore.rollback.new-" + QString::fromLatin1(name)); state = TreeState::Detached;
        }
        if (state == TreeState::Detached) {
            P::renameNoReplace(root, backup, name); sync(operations, root);
            operations.checkpoint("restore.rollback.old-" + QString::fromLatin1(name));
        }
    }
    replaceControl(operations, root, "ready-candidate.json", value.object["oldReady"]); operations.checkpoint("restore.rollback.ready");
    replaceControl(operations, root, "restore-source.json", value.object["oldSource"]); operations.checkpoint("restore.rollback.source");
    persist(operations, root, value, "rolled-back"); operations.checkpoint("restore.rolled-back"); cleanup(operations, root, value);
}
} // namespace

void recoverPending(const PreviewWorkspace::Session &session, std::shared_ptr<FileOperations> operations, const QStringList &protectedSnapshots) {
    if (!operations) operations = std::make_shared<FileOperations>();
    try {
        auto root = P::openRoot(session.root());
        const bool pending = !missing(P::inspect(root, Journal));
        const auto priority = pending ? readTransaction(root).object["preRestoreSnapshot"].toString() : QString();
        recover(*operations, root);
        // Listing an idle repository is read-only. A real pending transaction
        // may finish its protected rotation after recovery; ordinary startup
        // finishes pre-journal leftovers in Snapshot::Manager::prepare instead.
        if (pending) {
            try {
                PreviewSnapshot::Repository repository(session, operations);
                repository.prune(protectedSnapshots, priority);
                if (repository.warnings().contains("PREVIEW_SNAPSHOT_RETENTION_WARNING")) qWarning("PREVIEW_SNAPSHOT_RETENTION_WARNING");
            } catch (...) { qWarning("PREVIEW_SNAPSHOT_RETENTION_WARNING"); }
        }
    }
    catch (const PreviewDataFormat::Error &) { throw; }
    catch (...) { recoveryRequired(); }
}
QJsonArray listSnapshots(const PreviewWorkspace::Session &session) {
    // Main's pre-directory gate has already recovered; repeat for callers that
    // use the API directly under an existing Session.
    recoverPending(session); PreviewSnapshot::Repository repository(session); return repository.list();
}
QJsonObject restore(const PreviewWorkspace::Session &session, const QString &snapshotName, const Identity &currentIdentity,
                    std::shared_ptr<FileOperations> operations) {
    if (!operations) operations = std::make_shared<FileOperations>();
    if (!PreviewSnapshot::validIdentity(currentIdentity)) throw Error("PREVIEW_SNAPSHOT_IDENTITY_INVALID");
    recoverPending(session, operations, {snapshotName});
    try {
        auto root = P::openRoot(session.root()); PreviewSnapshot::Repository repository(session, operations);
        const auto manifest = repository.manifest(snapshotName);
        const auto dataIdentity = PreviewSnapshot::identityFromJson(manifest["schema"] == "reverie.preview.snapshot.v1" ? manifest["from"] : manifest["dataIdentity"]);
        operations->checkpoint("restore.target-verified");
        const auto preRestore = repository.savePreRestore(currentIdentity, {snapshotName});
        operations->checkpoint("restore.pre-snapshot-created");
        const auto id = token(), readyId = token();
        const auto stageName = encoded(".restore-stage-" + id); P::createDirectory(root, stageName);
        auto stage = P::openDirectory(root, stageName, true); const auto stageIdentity = identity(P::metadata(stage));
        bool journalPublished = false, committed = false;
        try {
            repository.copyPayload(snapshotName, stage);
            checkDataAt(stage, "data");
            operations->checkpoint("restore.staged");
            const auto oldReady = optionalBytes(root, "ready-candidate.json"), oldSource = optionalBytes(root, "restore-source.json");
            auto ready = PreviewSnapshot::identityJson(dataIdentity); ready["schema"] = "reverie.preview.ready-candidate.v1"; ready["readyId"] = readyId;
            const auto source = QJsonObject{{"schema", "reverie.preview.restore-source.v1"}, {"restoreId", id}, {"snapshot", snapshotName},
                {"preRestoreSnapshot", preRestore}, {"dataIdentity", PreviewSnapshot::identityJson(dataIdentity)}, {"readyId", readyId},
                {"restoredAt", QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}};
            Transaction value;
            value = transaction(QJsonObject{{"schema", "reverie.preview.restore-transaction.v1"}, {"id", id}, {"phase", "prepared"},
                {"rootIdentity", identity(P::metadata(root))}, {"stageIdentity", stageIdentity},
                {"oldDataIdentity", identity(P::inspect(root, "data"))}, {"oldAvatarsIdentity", identity(P::inspect(root, "avatars"))},
                {"newDataIdentity", identity(P::inspect(stage, "data"))}, {"newAvatarsIdentity", identity(P::inspect(stage, "avatars"))},
                {"snapshot", snapshotName}, {"preRestoreSnapshot", preRestore}, {"oldReady", oldReady}, {"newReady", jsonBytes(ready)},
                {"oldSource", oldSource}, {"newSource", jsonBytes(source)}}, root);
            const auto journalTemporary = encoded(".restore-journal-" + id);
            writeFile(*operations, root, journalTemporary, QJsonDocument(value.object).toJson(QJsonDocument::Compact));
            P::renameNoReplace(root, journalTemporary, Journal); journalPublished = true; sync(*operations, root);
            operations->checkpoint("restore.prepared");
            for (const auto *name : {"data", "avatars"}) {
                const auto backup = QByteArray(name) == "data" ? value.oldData : value.oldAvatars;
                P::renameNoReplace(root, name, backup); sync(*operations, root); operations->checkpoint("restore.old-" + QString::fromLatin1(name) + "-moved");
                P::moveNoReplace(stage, name, root, name); sync(*operations, stage); sync(*operations, root); operations->checkpoint("restore.new-" + QString::fromLatin1(name) + "-moved");
            }
            validateControlChoices(root, value, false);
            replaceControl(*operations, root, "ready-candidate.json", value.object["newReady"]); operations->checkpoint("restore.ready-written");
            replaceControl(*operations, root, "restore-source.json", value.object["newSource"]); operations->checkpoint("restore.source-written");
            if (!isIdentity(P::inspect(root, "data"), value.object["newDataIdentity"]) ||
                !isIdentity(P::inspect(root, "avatars"), value.object["newAvatarsIdentity"])) recoveryRequired();
            persist(*operations, root, value, "committed"); committed = true; operations->checkpoint("restore.committed");
            try { cleanup(*operations, root, value); }
            catch (...) { return QJsonObject{{"schema", "reverie.preview.restore-result.v1"}, {"name", snapshotName}, {"preRestoreSnapshot", preRestore},
                {"dataIdentity", PreviewSnapshot::identityJson(dataIdentity)}, {"readyId", readyId}, {"warnings", QJsonArray{"PREVIEW_RESTORE_CLEANUP_PENDING"}}}; }
        } catch (...) {
            const auto original = std::current_exception();
            if (journalPublished) {
                // Read the durable phase instead of assuming the commit write
                // did not happen when a later sync/observer failed.
                try {
                    auto persisted = readTransaction(root);
                    if (persisted.phase == "committed") {
                        committed = true; validateControlChoices(root, persisted, true);
                        if (!isIdentity(P::inspect(root, "data"), persisted.object["newDataIdentity"]) ||
                            !isIdentity(P::inspect(root, "avatars"), persisted.object["newAvatarsIdentity"])) recoveryRequired();
                    }
                    else recover(*operations, root);
                } catch (const PreviewDataFormat::Error &) { throw; }
                catch (...) { recoveryRequired(); }
                if (committed) return QJsonObject{{"schema", "reverie.preview.restore-result.v1"}, {"name", snapshotName}, {"preRestoreSnapshot", preRestore},
                    {"dataIdentity", PreviewSnapshot::identityJson(dataIdentity)}, {"readyId", readyId}, {"warnings", QJsonArray{"PREVIEW_RESTORE_CLEANUP_PENDING"}}};
            } else {
                try { removeTree(root, stageName, stageIdentity); sync(*operations, root); } catch (...) {}
            }
            std::rethrow_exception(original);
        }
        QStringList warnings = repository.warnings();
        try { repository.prune({}, preRestore); warnings = repository.warnings(); }
        catch (...) { warnings.append("PREVIEW_SNAPSHOT_RETENTION_WARNING"); }
        return {{"schema", "reverie.preview.restore-result.v1"}, {"name", snapshotName}, {"preRestoreSnapshot", preRestore},
            {"dataIdentity", PreviewSnapshot::identityJson(dataIdentity)}, {"readyId", readyId}, {"warnings", QJsonArray::fromStringList(warnings)}};
    } catch (const P::Error &error) { convert(error); }
}
} // namespace PreviewRestore
