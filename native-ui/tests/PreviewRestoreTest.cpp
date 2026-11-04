#include "../src/PreviewRestore.h"
#include "../src/PreviewPlatform.h"
#include "../src/PreviewDataFormat.h"
#include "../src/PreviewWorkspace.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QTemporaryDir>
#include <QTest>
#include <QSet>
#include <functional>
#include <sys/stat.h>
#include <unistd.h>

class PreviewRestoreTest final : public QObject {
    Q_OBJECT
    using Identity = PreviewSnapshot::Identity;
    using Manager = PreviewSnapshot::Manager;
    using Repository = PreviewSnapshot::Repository;
    static Identity candidate(const QString &name) { return {name, QString(40, 'a'), QString(64, 'b')}; }
    static void write(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(bytes) != bytes.size() ||
            !file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner)) throw std::runtime_error("fixture write failed");
    }
    static QByteArray read(const QString &path) {
        QFile file(path); if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("fixture read failed"); return file.readAll();
    }
    static QJsonObject object(const QString &path) { return QJsonDocument::fromJson(read(path)).object(); }
    static QString failure(const std::function<void()> &operation) {
        try { operation(); } catch (const PreviewSnapshot::Error &error) { return QString::fromLatin1(error.what()); } return {};
    }
    static QString formatFailure(const std::function<void()> &operation) {
        try { operation(); } catch (const PreviewDataFormat::Error &error) { return QString::fromLatin1(error.what()); } return {};
    }
    static QByteArray formatRecord(int version) {
        return QJsonDocument(QJsonObject{{"schema", PreviewDataFormat::Schema}, {"formatVersion", version}}).toJson();
    }
    struct Fixture {
        QTemporaryDir temporary;
        QString root, snapshot;
        std::unique_ptr<PreviewWorkspace::Session> session;
        Fixture() {
            const auto parent = QFileInfo(temporary.path()).canonicalFilePath();
            if (parent.isEmpty()) throw std::runtime_error("fixture isolation unavailable");
            root = parent + "/workspace"; session = std::make_unique<PreviewWorkspace::Session>(root);
            write(root + "/data/value", "old-data"); write(root + "/avatars/value", "old-avatar");
            Manager old(*session, candidate("old")); old.prepare(); old.markReady();
            Manager next(*session, candidate("new")); snapshot = next.prepare().snapshotName; next.markReady();
            write(root + "/data/value", "current-data"); write(root + "/avatars/value", "current-avatar");
        }
    };
    struct Fault final : PreviewSnapshot::FileOperations {
        QString target, interruptionPoint; bool fired = false;
        explicit Fault(QString operation, bool interrupt = false) : target(std::move(operation)),
            interruptionPoint(interrupt ? QStringLiteral("restore.rollback.begin") : QString()) {}
        void checkpoint(const QString &operation) override {
            if ((!fired && operation == target) || (fired && !interruptionPoint.isEmpty() && operation == interruptionPoint)) {
                fired = true; throw PreviewSnapshot::Error("PREVIEW_SNAPSHOT_IO_FAILED");
            }
        }
    };
private slots:
    void legacyV1SnapshotRemainsReadableAndRestorable() {
        Fixture fixture;
        const auto path = fixture.root + "/snapshots/" + fixture.snapshot + "/manifest.json";
        auto manifest = object(path); manifest["schema"] = "reverie.preview.snapshot.v1";
        manifest.remove("kind"); manifest.remove("dataIdentity"); QJsonArray files;
        for (const auto &value : manifest["files"].toArray()) {
            auto file = value.toObject(); file.remove("type"); file.remove("sourceLinkCount"); files.append(file);
        }
        manifest["files"] = files; write(path, QJsonDocument(manifest).toJson());
        Repository repository(*fixture.session);
        QCOMPARE(repository.manifest(fixture.snapshot)["schema"].toString(), QString("reverie.preview.snapshot.v1"));
        QCOMPARE(repository.list().size(), 1);
        const auto result = PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"));
        QCOMPARE(result["dataIdentity"].toObject(), PreviewSnapshot::identityJson(candidate("old")));
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("old-data"));
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("old-avatar"));
    }
    void successfulRestorePreservesUndoAndUsesFreshCompatibleCandidateRecord() {
        Fixture fixture; const auto before = object(fixture.root + "/ready-candidate.json");
        const auto original = object(fixture.root + "/snapshots/" + fixture.snapshot + "/manifest.json");
        const auto result = PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"));
        QCOMPARE(result["schema"].toString(), QString("reverie.preview.restore-result.v1"));
        const auto ready = object(fixture.root + "/ready-candidate.json");
        QCOMPARE(ready["schema"].toString(), QString("reverie.preview.ready-candidate.v1"));
        QCOMPARE(ready.keys().size(), 5); QCOMPARE(ready["candidate"].toString(), QString("old"));
        QVERIFY(ready["readyId"] != original["fromReadyId"]); QVERIFY(ready["readyId"] != before["readyId"]);
        QCOMPARE(object(fixture.root + "/restore-source.json")["snapshot"].toString(), fixture.snapshot);
        const auto undo = result["preRestoreSnapshot"].toString();
        QCOMPARE(read(fixture.root + "/snapshots/" + undo + "/data/value"), QByteArray("current-data"));
        QCOMPARE(read(fixture.root + "/snapshots/" + undo + "/avatars/value"), QByteArray("current-avatar"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
        QVERIFY(QDir(fixture.root).entryList({".restore-stage-*", ".restore-old-*"}, QDir::Dirs | QDir::Hidden).isEmpty());
    }
    void restoredHardLinksBecomeIndependentFiles() {
        Fixture fixture;
        const auto first = fixture.root + "/data/shared", second = fixture.root + "/avatars/shared";
        write(first, "shared-original");
        QCOMPARE(::link(QFile::encodeName(first).constData(), QFile::encodeName(second).constData()), 0);
        Repository repository(*fixture.session); const auto target = repository.savePreRestore(candidate("new"));
        PreviewRestore::restore(*fixture.session, target, candidate("new"));
        struct stat a{}, b{};
        QCOMPARE(::lstat(QFile::encodeName(first).constData(), &a), 0); QCOMPARE(::lstat(QFile::encodeName(second).constData(), &b), 0);
        QCOMPARE(quint64(a.st_nlink), quint64(1)); QCOMPARE(quint64(b.st_nlink), quint64(1));
        QVERIFY(a.st_dev != b.st_dev || a.st_ino != b.st_ino);
        write(first, "independent"); QCOMPARE(read(second), QByteArray("shared-original"));
    }
    void corruptTargetIsListedUnverifiedAndRejectedBeforeCreatingAnUndo() {
        Fixture fixture;
        write(fixture.root + "/snapshots/" + fixture.snapshot + "/data/value", "corrupt-target");
        const auto entries = PreviewRestore::listSnapshots(*fixture.session);
        QCOMPARE(entries.size(), 1); QCOMPARE(entries[0].toObject()["verification"].toString(), QString("invalid"));
        QCOMPARE(entries[0].toObject().keys().size(), 2);
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new")); }), QString("PREVIEW_SNAPSHOT_VERIFY_FAILED"));
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data"));
        QVERIFY(QDir(fixture.root + "/snapshots").entryList({"pre-restore-*"}, QDir::Dirs).isEmpty());
    }
    void cleanupNeverFollowsTheExcludedCacheLinkIntoAnOutsideDirectory() {
        Fixture fixture;
        const auto outside = QFileInfo(fixture.root).absolutePath() + "/outside";
        QVERIFY(QDir().mkdir(outside)); write(outside + "/sentinel", "preserve-outside");
        QCOMPARE(::symlink(QFile::encodeName(outside).constData(), QFile::encodeName(fixture.root + "/data/cache").constData()), 0);
        PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"));
        QCOMPARE(read(outside + "/sentinel"), QByteArray("preserve-outside"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/data/cache"));
    }
    void threeUpgradeSnapshotsAndOnePreRestoreHaveIndependentRetention() {
        Fixture fixture;
        for (int i = 0; i < 5; ++i) { Manager manager(*fixture.session, candidate("next-" + QString::number(i))); manager.prepare(); manager.markReady(); }
        Repository repository(*fixture.session);
        for (int i = 0; i < 3; ++i) repository.savePreRestore(candidate("next-4"));
        int upgrade = 0, pre = 0;
        for (const auto &value : repository.list()) {
            const auto kind = value.toObject()["kind"].toString(); upgrade += kind == "upgrade"; pre += kind == "pre-restore";
        }
        QCOMPARE(upgrade, 3); QCOMPARE(pre, 1);
    }
    void restoringTheSinglePreRestoreSnapshotDoesNotEvictItsSourceBeforeCopy() {
        Fixture fixture;
        const auto first = PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"));
        const auto undo = first["preRestoreSnapshot"].toString();
        const auto second = PreviewRestore::restore(*fixture.session, undo, candidate("new"));
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data"));
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        const auto replacementUndo = second["preRestoreSnapshot"].toString();
        QCOMPARE(read(fixture.root + "/snapshots/" + replacementUndo + "/data/value"), QByteArray("old-data"));
        int count = 0; for (const auto &value : PreviewRestore::listSnapshots(*fixture.session)) count += value.toObject()["kind"] == "pre-restore";
        QCOMPARE(count, 1);
    }
    void preJournalFailureRotatesTheExtraPreRestoreAtTheNextSafeStartupGate() {
        Fixture fixture; Repository repository(*fixture.session);
        const auto target = repository.savePreRestore(candidate("new"));
        const auto ready = read(fixture.root + "/ready-candidate.json");
        auto fault = std::make_shared<Fault>("restore.pre-snapshot-created");
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, target, candidate("new"), fault); }), QString("PREVIEW_SNAPSHOT_IO_FAILED"));
        int before = 0; for (const auto &entry : repository.list()) before += entry.toObject()["kind"] == "pre-restore";
        QCOMPARE(before, 2); QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
        // Recovery/listing without a journal must leave both snapshots intact.
        PreviewRestore::recoverPending(*fixture.session);
        int afterRecovery = 0; for (const auto &entry : repository.list()) afterRecovery += entry.toObject()["kind"] == "pre-restore";
        QCOMPARE(afterRecovery, 2);
        int listed = 0; for (const auto &entry : PreviewRestore::listSnapshots(*fixture.session)) listed += entry.toObject()["kind"] == "pre-restore";
        QCOMPARE(listed, 2);
        // Normal startup is the point at which an idle repository rotates.
        Manager unchanged(*fixture.session, candidate("new")); QCOMPARE(unchanged.prepare().action, PreviewSnapshot::Action::Unchanged);
        int after = 0; for (const auto &entry : repository.list()) after += entry.toObject()["kind"] == "pre-restore";
        QCOMPARE(after, 1); QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data"));
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready);
    }
    void newerOriginalInItsJournalBackupRefusesBeforeAnyRollbackRename() {
        Fixture fixture; const auto bytes = formatRecord(PreviewDataFormat::Current + 1);
        write(fixture.root + "/data/" + PreviewDataFormat::FileName, bytes);
        auto fault = std::make_shared<Fault>("restore.old-data-moved");
        QCOMPARE(formatFailure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        const auto journal = read(fixture.root + "/restore-transaction.json");
        const auto id = object(fixture.root + "/restore-transaction.json")["id"].toString();
        const auto backup = fixture.root + "/.restore-old-data-" + id;
        QVERIFY(!QFileInfo::exists(fixture.root + "/data"));
        const auto names = QDir(fixture.root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDir::Name);
        QCOMPARE(formatFailure([&] { PreviewRestore::recoverPending(*fixture.session); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        QCOMPARE(read(fixture.root + "/restore-transaction.json"), journal);
        QCOMPARE(QDir(fixture.root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDir::Name), names);
        QCOMPARE(read(backup + "/value"), QByteArray("current-data")); QCOMPARE(read(backup + '/' + PreviewDataFormat::FileName), bytes);
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/data"));
    }
    void unsupportedOrUnknownStagedFormatPreservesThePreparedTransaction_data() {
        QTest::addColumn<QByteArray>("bytes"); QTest::addColumn<QString>("code");
        QTest::newRow("newer") << formatRecord(PreviewDataFormat::Current + 1) << QString("PREVIEW_DATA_FORMAT_TOO_NEW");
        QTest::newRow("unknown") << QByteArray("{\"schema\":\"unknown\",\"formatVersion\":1}") << QString("PREVIEW_DATA_FORMAT_INVALID");
    }
    void unsupportedOrUnknownStagedFormatPreservesThePreparedTransaction() {
        QFETCH(QByteArray, bytes); QFETCH(QString, code); Fixture fixture;
        struct MutateStage final : PreviewSnapshot::FileOperations {
            QString root; QByteArray bytes;
            MutateStage(QString path, QByteArray value) : root(std::move(path)), bytes(std::move(value)) {}
            void checkpoint(const QString &operation) override {
                if (operation != "restore.prepared") return;
                const auto stages = QDir(root).entryList({".restore-stage-*"}, QDir::Dirs | QDir::Hidden);
                if (stages.size() != 1) throw std::runtime_error("missing staged fixture");
                PreviewRestoreTest::write(root + '/' + stages[0] + "/data/" + PreviewDataFormat::FileName, bytes);
                throw PreviewSnapshot::Error("PREVIEW_SNAPSHOT_IO_FAILED");
            }
        };
        auto operation = std::make_shared<MutateStage>(fixture.root, bytes);
        QCOMPARE(formatFailure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), operation); }), code);
        const auto journal = read(fixture.root + "/restore-transaction.json");
        const auto names = QDir(fixture.root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDir::Name);
        QCOMPARE(formatFailure([&] { PreviewRestore::recoverPending(*fixture.session); }), code);
        QCOMPARE(read(fixture.root + "/restore-transaction.json"), journal);
        QCOMPARE(QDir(fixture.root).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot, QDir::Name), names);
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data")); QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
    }
    void restoringANewerFormatIsRejectedWhileOnlyTheStagingCopyExists() {
        Fixture fixture; const auto formatPath = fixture.root + "/data/" + PreviewDataFormat::FileName;
        write(formatPath, formatRecord(PreviewDataFormat::Current + 1));
        Repository repository(*fixture.session); const auto target = repository.savePreRestore(candidate("new"));
        QVERIFY(QFile::remove(formatPath)); const auto ready = read(fixture.root + "/ready-candidate.json");
        QCOMPARE(formatFailure([&] { PreviewRestore::restore(*fixture.session, target, candidate("new")); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        QVERIFY(!QFileInfo::exists(formatPath)); QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
        QVERIFY(QDir(fixture.root).entryList({".restore-stage-*"}, QDir::Dirs | QDir::Hidden).isEmpty());
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data")); QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready);
    }
    void everyPrecommitFailureRollsBack_data() {
        QTest::addColumn<QString>("operation");
        for (const auto *operation : {"restore.target-verified", "restore.pre-snapshot-created", "restore.staged", "restore.prepared",
            "restore.old-data-moved", "restore.new-data-moved", "restore.old-avatars-moved", "restore.new-avatars-moved", "restore.ready-written", "restore.source-written"})
            QTest::newRow(operation) << QString::fromLatin1(operation);
    }
    void everyPrecommitFailureRollsBack() {
        QFETCH(QString, operation); Fixture fixture;
        const auto ready = read(fixture.root + "/ready-candidate.json");
        auto fault = std::make_shared<Fault>(operation);
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault); }), QString("PREVIEW_SNAPSHOT_IO_FAILED"));
        QVERIFY(fault->fired);
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data"));
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready);
        QVERIFY(!QFileInfo::exists(fixture.root + "/restore-source.json"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
    }
    void persistedInterruptedStatesAreRecoveredBeforeUse_data() {
        QTest::addColumn<QString>("operation");
        for (const auto *operation : {"restore.prepared", "restore.old-data-moved", "restore.new-data-moved", "restore.old-avatars-moved",
            "restore.new-avatars-moved", "restore.ready-written", "restore.source-written"}) QTest::newRow(operation) << QString::fromLatin1(operation);
    }
    void persistedInterruptedStatesAreRecoveredBeforeUse() {
        QFETCH(QString, operation); Fixture fixture; const auto ready = read(fixture.root + "/ready-candidate.json");
        auto fault = std::make_shared<Fault>(operation, true);
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault); }), QString("PREVIEW_RESTORE_RECOVERY_REQUIRED"));
        QVERIFY(QFileInfo::exists(fixture.root + "/restore-transaction.json"));
        PreviewRestore::recoverPending(*fixture.session);
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data")); QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready); QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
    }
    void unknownRecoveryStatePreservesAllEvidenceAndRefusesUse() {
        Fixture fixture;
        auto fault = std::make_shared<Fault>("restore.old-data-moved", true);
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault); }), QString("PREVIEW_RESTORE_RECOVERY_REQUIRED"));
        const auto journal = read(fixture.root + "/restore-transaction.json");
        QVERIFY(QDir().mkdir(fixture.root + "/data")); QCOMPARE(::chmod(QFile::encodeName(fixture.root + "/data").constData(), 0700), 0);
        write(fixture.root + "/data/foreign", "preserve-unrecognized-data");
        QCOMPARE(failure([&] { PreviewRestore::recoverPending(*fixture.session); }), QString("PREVIEW_RESTORE_RECOVERY_REQUIRED"));
        QCOMPARE(read(fixture.root + "/restore-transaction.json"), journal); QCOMPARE(read(fixture.root + "/data/foreign"), QByteArray("preserve-unrecognized-data"));
        QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
    }
    void interruptedRollbackIsItselfRecoverable_data() {
        QTest::addColumn<QString>("operation");
        for (const auto *operation : {"restore.rollback.new-data", "restore.rollback.old-data", "restore.rollback.new-avatars",
            "restore.rollback.old-avatars", "restore.rollback.ready", "restore.rollback.source", "restore.rolled-back", "restore.cleanup.stage"})
            QTest::newRow(operation) << QString::fromLatin1(operation);
    }
    void interruptedRollbackIsItselfRecoverable() {
        QFETCH(QString, operation); Fixture fixture; const auto ready = read(fixture.root + "/ready-candidate.json");
        auto fault = std::make_shared<Fault>("restore.source-written"); fault->interruptionPoint = operation;
        QCOMPARE(failure([&] { PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault); }), QString("PREVIEW_RESTORE_RECOVERY_REQUIRED"));
        QVERIFY(QFileInfo::exists(fixture.root + "/restore-transaction.json"));
        PreviewRestore::recoverPending(*fixture.session);
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("current-data")); QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("current-avatar"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready); QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
    }
    void committedCleanupInterruptionKeepsConsistentNewDataAndCanFinish() {
        Fixture fixture; auto fault = std::make_shared<Fault>("restore.cleanup.data");
        const auto result = PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"), fault);
        QVERIFY(result["warnings"].toArray().contains("PREVIEW_RESTORE_CLEANUP_PENDING"));
        QCOMPARE(read(fixture.root + "/data/value"), QByteArray("old-data")); QCOMPARE(read(fixture.root + "/avatars/value"), QByteArray("old-avatar"));
        QCOMPARE(object(fixture.root + "/restore-transaction.json")["phase"].toString(), QString("committed"));
        PreviewRestore::recoverPending(*fixture.session); QVERIFY(!QFileInfo::exists(fixture.root + "/restore-transaction.json"));
    }
    void newVersionAfterRestoreTakesNewSnapshotOldVersionSkipsAndUntouchedBehaviorStays() {
        Fixture fixture;
        Manager untouched(*fixture.session, candidate("new")); QCOMPARE(untouched.prepare().action, PreviewSnapshot::Action::Unchanged);
        PreviewRestore::restore(*fixture.session, fixture.snapshot, candidate("new"));
        Manager old(*fixture.session, candidate("old")); QCOMPARE(old.prepare().action, PreviewSnapshot::Action::Unchanged);
        Manager retry(*fixture.session, candidate("new")); const auto result = retry.prepare(); QCOMPARE(result.action, PreviewSnapshot::Action::Created);
        QVERIFY(result.snapshotName != fixture.snapshot);
        QCOMPARE(read(fixture.root + "/snapshots/" + result.snapshotName + "/data/value"), QByteArray("old-data"));
        retry.markReady(); Manager same(*fixture.session, candidate("new")); QCOMPARE(same.prepare().action, PreviewSnapshot::Action::Unchanged);
    }
    void allFailureCategoriesHaveDistinctActionableMessages() {
        QSet<QString> messages;
        for (const auto *code : {"PREVIEW_SNAPSHOT_NO_SPACE", "PREVIEW_SNAPSHOT_SPECIAL_FILE", "PREVIEW_SNAPSHOT_ENTRY_LIMIT",
            "PREVIEW_SNAPSHOT_SOURCE_CHANGED", "PREVIEW_SNAPSHOT_VERIFY_FAILED", "PREVIEW_SNAPSHOT_IO_FAILED"}) {
            QCOMPARE(PreviewSnapshot::failureCode(code), QString::fromLatin1(code));
            const auto message = PreviewSnapshot::failureMessage(code); QVERIFY(!message.isEmpty()); messages.insert(message);
        }
        QCOMPARE(messages.size(), 6);
    }
    void sourceMutationAfterInventoryIsClassifiedAndNeverPublished() {
        Fixture fixture;
        struct Mutate final : PreviewSnapshot::FileOperations {
            QString path;
            explicit Mutate(QString value) : path(std::move(value)) {}
            void checkpoint(const QString &operation) override {
                if (operation == "snapshot.source-scanned") PreviewRestoreTest::write(path, "changed-after-inventory-with-different-size");
            }
        };
        const auto ready = read(fixture.root + "/ready-candidate.json");
        Manager manager(*fixture.session, candidate("third"), std::make_shared<Mutate>(fixture.root + "/data/value"));
        QCOMPARE(failure([&] { manager.prepare(); }), QString("PREVIEW_SNAPSHOT_SOURCE_CHANGED"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), ready);
        QCOMPARE(Repository(*fixture.session).list().size(), 1);
    }
};
QTEST_GUILESS_MAIN(PreviewRestoreTest)
#include "PreviewRestoreTest.moc"
