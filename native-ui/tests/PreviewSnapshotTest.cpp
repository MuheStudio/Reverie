#include "../src/PreviewSnapshot.h"
#include "../src/PreviewWorkspace.h"

#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTest>
#include <cerrno>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

class PreviewSnapshotTest final : public QObject {
    Q_OBJECT
    using Identity = PreviewSnapshot::Identity;
    using Manager = PreviewSnapshot::Manager;
    using Action = PreviewSnapshot::Action;
    static Identity identity(const QString &candidate = "synthetic-previous") {
        return {candidate, QString(40, 'a'), QString(64, 'b')};
    }
    static void write(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly | QIODevice::Truncate) || file.write(bytes) != bytes.size() ||
            !file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner))
            throw std::runtime_error("synthetic fixture write failed");
    }
    static QByteArray read(const QString &path) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("synthetic fixture read failed");
        return file.readAll();
    }
    static QJsonObject object(const QString &path) {
        return QJsonDocument::fromJson(read(path)).object();
    }
    static QString failure(const std::function<void()> &operation) {
        try { operation(); }
        catch (const PreviewSnapshot::Error &error) { return QString::fromLatin1(error.what()); }
        return {};
    }
    static QStringList children(const QString &path) {
        return QDir(path).entryList(QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden, QDir::Name);
    }
    static QStringList snapshots(const QString &workspace) {
        return QDir(workspace + "/snapshots").entryList({"snapshot-*"}, QDir::Dirs | QDir::NoDotAndDotDot, QDir::Name);
    }
    static void mkdir(const QString &path) {
        if (!QDir().mkdir(path) || ::chmod(QFile::encodeName(path).constData(), 0700) != 0)
            throw std::runtime_error("synthetic fixture directory failed");
    }
    static int mode(const QString &path) {
        struct stat value{};
        if (::lstat(QFile::encodeName(path).constData(), &value) != 0) return -1;
        return value.st_mode & 07777;
    }
    struct Fixture {
        QTemporaryDir temporary;
        QString root;
        std::unique_ptr<PreviewWorkspace::Session> session;
        Fixture() {
            const auto parent = QFileInfo(temporary.path()).canonicalFilePath();
            if (parent.isEmpty()) throw std::runtime_error("synthetic isolation unavailable");
            root = parent + "/workspace";
            session = std::make_unique<PreviewWorkspace::Session>(root);
            write(root + "/data/database.db", QByteArray("\0encrypted\xff\x01", 12));
        }
        void ready(const Identity &current) {
            Manager manager(*session, current); manager.prepare(); manager.markReady();
        }
    };
    struct LimitedSpace final : PreviewSnapshot::FileOperations {
        quint64 availableBytes(int) override { return 0; }
    };
    struct FailedWrite final : PreviewSnapshot::FileOperations {
        qint64 remaining = 4;
        qint64 write(int descriptor, const char *bytes, qint64 size) override {
            if (remaining == 0) { errno = ENOSPC; return -1; }
            const auto count = PreviewSnapshot::FileOperations::write(descriptor, bytes, qMin(size, remaining));
            if (count > 0) remaining -= count;
            return count;
        }
    };
    struct CorruptWrite final : PreviewSnapshot::FileOperations {
        bool corrupted = false;
        qint64 write(int descriptor, const char *bytes, qint64 size) override {
            if (!corrupted && size > 0) {
                QByteArray changed(bytes, qsizetype(size)); changed[0] = char(changed[0] ^ 0x40);
                corrupted = true;
                return PreviewSnapshot::FileOperations::write(descriptor, changed.constData(), size);
            }
            return PreviewSnapshot::FileOperations::write(descriptor, bytes, size);
        }
    };
    struct FailedSync final : PreviewSnapshot::FileOperations {
        bool sync(int) override { errno = EIO; return false; }
    };
private slots:
    void firstLaunchAndSameIdentityDoNotSnapshotAndOnlyReadyWritesMarker() {
        Fixture fixture;
        Manager first(*fixture.session, identity());
        QCOMPARE(first.prepare().action, Action::FirstLaunch);
        QVERIFY(!QFileInfo::exists(fixture.root + "/ready-candidate.json"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/snapshots"));
        first.markReady();
        const auto bytes = read(fixture.root + "/ready-candidate.json");
        const auto marker = object(fixture.root + "/ready-candidate.json");
        QCOMPARE(marker["schema"].toString(), QString("reverie.preview.ready-candidate.v1"));
        QCOMPARE(marker["readyId"].toString().size(), 32);
        QCOMPARE(mode(fixture.root + "/ready-candidate.json"), 0600);
        Manager same(*fixture.session, identity());
        QCOMPARE(same.prepare().action, Action::Unchanged);
        same.markReady();
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), bytes);
        QVERIFY(!QFileInfo::exists(fixture.root + "/snapshots"));
    }
    void eachIdentityFieldTriggersSnapshot_data() {
        QTest::addColumn<int>("field");
        QTest::newRow("candidate") << 0;
        QTest::newRow("source") << 1;
        QTest::newRow("build-manifest") << 2;
    }
    void eachIdentityFieldTriggersSnapshot() {
        QFETCH(int, field);
        Fixture fixture; fixture.ready(identity());
        auto next = identity();
        if (field == 0) next.candidate = "synthetic-next";
        if (field == 1) next.sourceHead = QString(40, 'c');
        if (field == 2) next.buildManifestSha256 = QString(64, 'd');
        const auto oldMarker = read(fixture.root + "/ready-candidate.json");
        Manager changed(*fixture.session, next);
        QCOMPARE(changed.prepare().action, Action::Created);
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), oldMarker);
        changed.markReady();
        QCOMPARE(object(fixture.root + "/ready-candidate.json")["buildManifestSha256"].toString(), next.buildManifestSha256);
        QCOMPARE(snapshots(fixture.root).size(), 1);
    }
    void originalBytesAuxiliaryFilesAndEmptyDirectoriesArePreservedWithExclusions() {
        Fixture fixture; fixture.ready(identity());
        mkdir(fixture.root + "/data/cache"); mkdir(fixture.root + "/data/empty");
        mkdir(fixture.root + "/avatars/records"); mkdir(fixture.root + "/avatars/records/empty");
        write(fixture.root + "/data/database.db-journal", "encrypted rollback journal");
        write(fixture.root + "/data/config.json", "private plaintext fixture");
        write(fixture.root + "/data/cache/private-resource", "excluded cache bytes");
        write(fixture.root + "/avatars/records/private-name.model3.json", "original avatar payload");
        write(fixture.root + "/logs/host.log", "excluded log bytes");
        write(fixture.root + "/qml-cache/qmlc", "excluded qml bytes");
        Manager changed(*fixture.session, identity("synthetic-next"));
        const auto result = changed.prepare();
        QCOMPARE(result.action, Action::Created);
        const auto path = fixture.root + "/snapshots/" + result.snapshotName;
        QCOMPARE(mode(fixture.root + "/snapshots"), 0700);
        QCOMPARE(mode(path), 0700); QCOMPARE(mode(path + "/manifest.json"), 0600);
        QCOMPARE(read(path + "/data/database.db"), read(fixture.root + "/data/database.db"));
        QCOMPARE(read(path + "/data/database.db-journal"), QByteArray("encrypted rollback journal"));
        QCOMPARE(read(path + "/data/config.json"), QByteArray("private plaintext fixture"));
        QCOMPARE(read(path + "/avatars/records/private-name.model3.json"), QByteArray("original avatar payload"));
        QVERIFY(QFileInfo(path + "/data/empty").isDir());
        QVERIFY(QFileInfo(path + "/avatars/records/empty").isDir());
        for (const auto &excluded : {"data/cache", "logs", "qml-cache", "workspace.lock", "ready-candidate.json", "snapshots"})
            QVERIFY(!QFileInfo::exists(path + '/' + excluded));
        const auto manifest = object(path + "/manifest.json");
        QCOMPARE(manifest["schema"].toString(), QString("reverie.preview.snapshot.v2"));
        quint64 total = 0;
        for (const auto &value : manifest["files"].toArray()) {
            const auto file = value.toObject(); const auto copied = read(path + '/' + file["path"].toString());
            QCOMPARE(file["size"].toString(), QString::number(copied.size()));
            QCOMPARE(file["sha256"].toString().toLatin1(), QCryptographicHash::hash(copied, QCryptographicHash::Sha256).toHex());
            QCOMPARE(mode(path + '/' + file["path"].toString()), 0600); total += quint64(copied.size());
        }
        QCOMPARE(manifest["totalBytes"].toString(), QString::number(total));
        for (const auto &value : manifest["directories"].toArray()) QCOMPARE(mode(path + '/' + value.toString()), 0700);
    }
    void linksAndSpecialFilesAreNeverFollowed_data() {
        QTest::addColumn<QString>("kind");
        for (const auto &kind : {"data-file-link", "avatar-directory-link", "data-hardlink", "avatar-hardlink", "fifo"})
            QTest::newRow(kind) << QString::fromLatin1(kind);
    }
    void linksAndSpecialFilesAreNeverFollowed() {
        QFETCH(QString, kind);
        Fixture fixture; fixture.ready(identity());
        const auto outside = QFileInfo(fixture.root).absolutePath() + "/outside";
        mkdir(outside); write(outside + "/sentinel", "outside original bytes");
        const auto path = fixture.root + (kind.startsWith("avatar") ? "/avatars/unsafe" : "/data/unsafe");
        int result = -1;
        if (kind.endsWith("hardlink")) result = ::link(QFile::encodeName(outside + "/sentinel").constData(), QFile::encodeName(path).constData());
        else if (kind == "fifo") result = ::mkfifo(QFile::encodeName(path).constData(), 0600);
        else result = ::symlink(QFile::encodeName(kind == "avatar-directory-link" ? outside : outside + "/sentinel").constData(),
                                QFile::encodeName(path).constData());
        QCOMPARE(result, 0);
        const auto oldMarker = read(fixture.root + "/ready-candidate.json");
        Manager changed(*fixture.session, identity("synthetic-next"));
        if (kind.endsWith("hardlink")) {
            const auto snapshot = changed.prepare();
            QCOMPARE(snapshot.action, Action::Created);
            const auto relative = kind.startsWith("avatar") ? QString("avatars/unsafe") : QString("data/unsafe");
            const auto copiedPath = fixture.root + "/snapshots/" + snapshot.snapshotName + '/' + relative;
            struct stat original{}, copied{};
            QCOMPARE(::lstat(QFile::encodeName(path).constData(), &original), 0);
            QCOMPARE(::lstat(QFile::encodeName(copiedPath).constData(), &copied), 0);
            QCOMPARE(quint64(copied.st_nlink), quint64(1));
            QVERIFY(original.st_dev != copied.st_dev || original.st_ino != copied.st_ino);
            QCOMPARE(read(copiedPath), QByteArray("outside original bytes"));
            const auto manifest = object(fixture.root + "/snapshots/" + snapshot.snapshotName + "/manifest.json");
            QCOMPARE(manifest["schema"].toString(), QString("reverie.preview.snapshot.v2"));
            bool found = false;
            for (const auto &value : manifest["files"].toArray()) {
                const auto file = value.toObject();
                if (file["path"] != relative) continue;
                found = true;
                QCOMPARE(file["type"].toString(), QString("regular"));
                QCOMPARE(file["sourceLinkCount"].toString(), QString("2"));
            }
            QVERIFY(found);
        } else {
            QCOMPARE(failure([&] { changed.prepare(); }), QString("PREVIEW_SNAPSHOT_SPECIAL_FILE"));
        }
        QCOMPARE(read(outside + "/sentinel"), QByteArray("outside original bytes"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), oldMarker);
        QCOMPARE(children(fixture.root + "/snapshots").size(), kind.endsWith("hardlink") ? 1 : 0);
    }
    void excludedCacheSymlinkIsNotTraversed() {
        Fixture fixture; fixture.ready(identity());
        const auto outside = QFileInfo(fixture.root).absolutePath() + "/outside";
        mkdir(outside); write(outside + "/sentinel", "outside original bytes");
        QCOMPARE(::symlink(QFile::encodeName(outside).constData(), QFile::encodeName(fixture.root + "/data/cache").constData()), 0);
        Manager changed(*fixture.session, identity("synthetic-next"));
        const auto result = changed.prepare();
        QCOMPARE(result.action, Action::Created);
        QVERIFY(!QFileInfo::exists(fixture.root + "/snapshots/" + result.snapshotName + "/data/cache"));
        QCOMPARE(read(outside + "/sentinel"), QByteArray("outside original bytes"));
    }
    void malformedReadyMarkersAreRejected_data() {
        QTest::addColumn<QByteArray>("bytes");
        QTest::newRow("truncated") << QByteArray("{");
        QTest::newRow("array") << QByteArray("[]");
        QTest::newRow("wrong-schema") << QByteArray("{\"schema\":\"unknown\"}");
        auto value = QJsonObject{{"schema", "reverie.preview.ready-candidate.v1"}, {"readyId", QString(32, '1')},
            {"candidate", "../escape"}, {"sourceHead", QString(40, 'a')}, {"buildManifestSha256", QString(64, 'b')}};
        QTest::newRow("candidate-traversal") << QJsonDocument(value).toJson();
        value["candidate"] = "synthetic-previous"; value["buildManifestSha256"] = "missing";
        QTest::newRow("bad-build-identity") << QJsonDocument(value).toJson();
        QTest::newRow("oversized") << QByteArray(5000, 'x');
    }
    void malformedReadyMarkersAreRejected() {
        QFETCH(QByteArray, bytes);
        Fixture fixture; write(fixture.root + "/ready-candidate.json", bytes);
        Manager changed(*fixture.session, identity("synthetic-next"));
        QVERIFY(!failure([&] { changed.prepare(); }).isEmpty());
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), bytes);
        QVERIFY(!QFileInfo::exists(fixture.root + "/snapshots"));
    }
    void markerLinksAndNonPrivateModesAreRejected_data() {
        QTest::addColumn<int>("kind");
        QTest::newRow("symlink") << 0; QTest::newRow("hardlink") << 1; QTest::newRow("public-mode") << 2;
    }
    void markerLinksAndNonPrivateModesAreRejected() {
        QFETCH(int, kind);
        Fixture fixture; fixture.ready(identity());
        const auto marker = fixture.root + "/ready-candidate.json";
        const auto outside = QFileInfo(fixture.root).absolutePath() + "/outside-marker";
        const auto original = read(marker); write(outside, original);
        if (kind < 2) {
            QVERIFY(QFile::remove(marker));
            if (kind == 0) QCOMPARE(::symlink(QFile::encodeName(outside).constData(), QFile::encodeName(marker).constData()), 0);
            else QCOMPARE(::link(QFile::encodeName(outside).constData(), QFile::encodeName(marker).constData()), 0);
        } else QCOMPARE(::chmod(QFile::encodeName(marker).constData(), 0644), 0);
        Manager changed(*fixture.session, identity("synthetic-next"));
        QVERIFY(!failure([&] { changed.prepare(); }).isEmpty());
        QCOMPARE(read(outside), original); QCOMPARE(read(marker), original);
    }
    void failedSpaceCopyVerificationOrSyncOnlyRemovesItsOwnTemporaryDirectory_data() {
        QTest::addColumn<int>("kind");
        QTest::newRow("preflight-no-space") << 0;
        QTest::newRow("write-enospc") << 1;
        QTest::newRow("checksum-mismatch") << 2;
        QTest::newRow("sync-failure") << 3;
    }
    void failedSpaceCopyVerificationOrSyncOnlyRemovesItsOwnTemporaryDirectory() {
        QFETCH(int, kind);
        Fixture fixture; fixture.ready(identity());
        mkdir(fixture.root + "/snapshots"); mkdir(fixture.root + "/snapshots/.snapshot-tmp-not-ours");
        write(fixture.root + "/snapshots/.snapshot-tmp-not-ours/sentinel", "preserve stale temporary bytes");
        write(fixture.root + "/snapshots/user-note", "preserve unrelated bytes");
        const auto oldMarker = read(fixture.root + "/ready-candidate.json");
        const auto oldData = read(fixture.root + "/data/database.db");
        std::shared_ptr<PreviewSnapshot::FileOperations> operations;
        if (kind == 0) operations = std::make_shared<LimitedSpace>();
        if (kind == 1) operations = std::make_shared<FailedWrite>();
        if (kind == 2) operations = std::make_shared<CorruptWrite>();
        if (kind == 3) operations = std::make_shared<FailedSync>();
        Manager changed(*fixture.session, identity("synthetic-next"), operations);
        const auto code = failure([&] { changed.prepare(); });
        QVERIFY(!code.isEmpty());
        if (kind < 2) QCOMPARE(code, QString("PREVIEW_SNAPSHOT_NO_SPACE"));
        if (kind == 2) QCOMPARE(code, QString("PREVIEW_SNAPSHOT_VERIFY_FAILED"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), oldMarker);
        QCOMPARE(read(fixture.root + "/data/database.db"), oldData);
        QCOMPARE(children(fixture.root + "/snapshots"), QStringList({".snapshot-tmp-not-ours", "user-note"}));
        QCOMPARE(read(fixture.root + "/snapshots/.snapshot-tmp-not-ours/sentinel"), QByteArray("preserve stale temporary bytes"));
        QCOMPARE(read(fixture.root + "/snapshots/user-note"), QByteArray("preserve unrelated bytes"));
        QCOMPARE(failure([&] { changed.markReady(); }), QString("PREVIEW_SNAPSHOT_NOT_PREPARED"));
    }
    void verifiedTransitionIsReusedAfterFailureBeforeReady() {
        Fixture fixture; fixture.ready(identity());
        QString firstName;
        {
            Manager attempt(*fixture.session, identity("synthetic-next"));
            const auto result = attempt.prepare(); QCOMPARE(result.action, Action::Created); firstName = result.snapshotName;
        }
        const auto manifest = read(fixture.root + "/snapshots/" + firstName + "/manifest.json");
        Manager retry(*fixture.session, identity("synthetic-next"));
        const auto reused = retry.prepare();
        QCOMPARE(reused.action, Action::Reused); QCOMPARE(reused.snapshotName, firstName);
        QCOMPARE(snapshots(fixture.root).size(), 1);
        QCOMPARE(read(fixture.root + "/snapshots/" + firstName + "/manifest.json"), manifest);
        retry.markReady();
        Manager same(*fixture.session, identity("synthetic-next"));
        QCOMPARE(same.prepare().action, Action::Unchanged);
        QCOMPARE(snapshots(fixture.root).size(), 1);
    }
    void aLaterCompletedCycleDoesNotReuseAnEarlierEpoch() {
        Fixture fixture; fixture.ready(identity("synthetic-a"));
        fixture.ready(identity("synthetic-b"));
        fixture.ready(identity("synthetic-a"));
        Manager next(*fixture.session, identity("synthetic-b"));
        QCOMPARE(next.prepare().action, Action::Created);
        QCOMPARE(snapshots(fixture.root).size(), 3);
    }
    void reusedVerifiedSnapshotFinishesRetentionInterruptedAfterRename() {
        Fixture fixture; fixture.ready(identity());
        Manager initial(*fixture.session, identity("synthetic-next"));
        const auto original = initial.prepare();
        const auto source = fixture.root + "/snapshots/" + original.snapshotName;
        const auto manifest = object(source + "/manifest.json");
        // Reconstruct otherwise valid managed snapshots to model a persisted
        // over-limit set after the prior writer stopped before pruning.
        for (int i = 1; i <= 3; ++i) {
            const auto suffix = (original.snapshotName.right(8).toULongLong(nullptr, 16) + quint64(i)) & 0xffffffffULL;
            const auto name = original.snapshotName.chopped(8) + QString::number(suffix, 16).rightJustified(8, '0');
            const auto path = fixture.root + "/snapshots/" + name; mkdir(path);
            for (const auto &value : manifest["directories"].toArray()) mkdir(path + '/' + value.toString());
            for (const auto &value : manifest["files"].toArray()) {
                const auto relative = value.toObject()["path"].toString(); write(path + '/' + relative, read(source + '/' + relative));
            }
            auto copy = manifest; copy["name"] = name; write(path + "/manifest.json", QJsonDocument(copy).toJson());
        }
        QCOMPARE(snapshots(fixture.root).size(), 4);
        Manager retry(*fixture.session, identity("synthetic-next"));
        const auto reused = retry.prepare();
        QCOMPARE(reused.action, Action::Reused);
        QCOMPARE(snapshots(fixture.root).size(), 3);
        QVERIFY(QFileInfo::exists(fixture.root + "/snapshots/" + reused.snapshotName + "/manifest.json"));
    }
    void malformedOrCorruptSnapshotsArePreservedAndCannotBeReused_data() {
        QTest::addColumn<int>("kind");
        QTest::newRow("payload-hash-mismatch") << 0;
        QTest::newRow("manifest-parent-traversal") << 1;
        QTest::newRow("manifest-absolute-path") << 2;
        QTest::newRow("unexpected-child") << 3;
        QTest::newRow("manifest-hardlink") << 4;
    }
    void malformedOrCorruptSnapshotsArePreservedAndCannotBeReused() {
        QFETCH(int, kind);
        Fixture fixture; fixture.ready(identity());
        Manager first(*fixture.session, identity("synthetic-next"));
        const auto result = first.prepare();
        const auto path = fixture.root + "/snapshots/" + result.snapshotName;
        if (kind == 0) write(path + "/data/database.db", "corrupted snapshot only");
        if (kind == 1 || kind == 2) {
            auto manifest = object(path + "/manifest.json"); auto files = manifest["files"].toArray();
            auto file = files[0].toObject(); file["path"] = kind == 1 ? "data/../../escape" : "/outside/escape";
            files[0] = file; manifest["files"] = files; write(path + "/manifest.json", QJsonDocument(manifest).toJson());
        }
        if (kind == 3) write(path + "/data/unlisted-private-name", "preserve unknown file");
        if (kind == 4) {
            const auto outside = QFileInfo(fixture.root).absolutePath() + "/linked-manifest";
            QCOMPARE(::link(QFile::encodeName(path + "/manifest.json").constData(), QFile::encodeName(outside).constData()), 0);
        }
        const auto badManifest = read(path + "/manifest.json");
        Manager retry(*fixture.session, identity("synthetic-next"));
        const auto replacement = retry.prepare();
        QCOMPARE(replacement.action, Action::Created);
        QVERIFY(replacement.warnings.contains("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT"));
        QVERIFY(replacement.snapshotName != result.snapshotName);
        QCOMPARE(read(path + "/manifest.json"), badManifest);
        QCOMPARE(snapshots(fixture.root).size(), 2);
    }
    void retentionKeepsThreeVerifiedSnapshotsAndPreservesOtherContents() {
        Fixture fixture; fixture.ready(identity("synthetic-0"));
        mkdir(fixture.root + "/snapshots");
        mkdir(fixture.root + "/snapshots/snapshot-user-content");
        write(fixture.root + "/snapshots/snapshot-user-content/manifest.json", "not a managed manifest");
        mkdir(fixture.root + "/snapshots/.snapshot-tmp-stale");
        write(fixture.root + "/snapshots/.snapshot-tmp-stale/sentinel", "stale bytes");
        write(fixture.root + "/snapshots/private-user-note", "unrelated bytes");
        QString firstName;
        for (int i = 1; i <= 4; ++i) {
            Manager next(*fixture.session, identity("synthetic-" + QString::number(i)));
            const auto result = next.prepare(); QCOMPARE(result.action, Action::Created);
            QVERIFY(result.warnings.contains("PREVIEW_SNAPSHOT_UNMANAGED_CONTENT"));
            if (i == 1) firstName = result.snapshotName;
            next.markReady();
        }
        QCOMPARE(snapshots(fixture.root).size(), 4); // Three managed + preserved user directory.
        QVERIFY(!QFileInfo::exists(fixture.root + "/snapshots/" + firstName));
        QCOMPARE(read(fixture.root + "/snapshots/snapshot-user-content/manifest.json"), QByteArray("not a managed manifest"));
        QCOMPARE(read(fixture.root + "/snapshots/.snapshot-tmp-stale/sentinel"), QByteArray("stale bytes"));
        QCOMPARE(read(fixture.root + "/snapshots/private-user-note"), QByteArray("unrelated bytes"));
    }
    void snapshotsRootSymlinkDoesNotModifyItsTarget() {
        Fixture fixture; fixture.ready(identity());
        const auto outside = QFileInfo(fixture.root).absolutePath() + "/outside";
        mkdir(outside); write(outside + "/sentinel", "outside original bytes");
        QCOMPARE(::symlink(QFile::encodeName(outside).constData(), QFile::encodeName(fixture.root + "/snapshots").constData()), 0);
        Manager next(*fixture.session, identity("synthetic-next"));
        QVERIFY(!failure([&] { next.prepare(); }).isEmpty());
        QCOMPARE(children(outside), QStringList({"sentinel"}));
        QCOMPARE(read(outside + "/sentinel"), QByteArray("outside original bytes"));
    }
    void readyCannotBeRecordedBeforePreparationOrAfterFailure() {
        Fixture fixture;
        Manager manager(*fixture.session, identity());
        QCOMPARE(failure([&] { manager.markReady(); }), QString("PREVIEW_SNAPSHOT_NOT_PREPARED"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/ready-candidate.json"));
        manager.prepare(); manager.markReady();
        const auto oldMarker = read(fixture.root + "/ready-candidate.json");
        Manager failed(*fixture.session, identity("synthetic-next"), std::make_shared<LimitedSpace>());
        QCOMPARE(failure([&] { failed.prepare(); }), QString("PREVIEW_SNAPSHOT_NO_SPACE"));
        QCOMPARE(failure([&] { failed.markReady(); }), QString("PREVIEW_SNAPSHOT_NOT_PREPARED"));
        QCOMPARE(read(fixture.root + "/ready-candidate.json"), oldMarker);
    }
    void failedReadyWriteIsAtomicAndOnlyRemovesItsOwnTemporaryFile() {
        Fixture fixture;
        write(fixture.root + "/.ready-candidate-unrelated.tmp", "preserve unrelated temporary bytes");
        Manager manager(*fixture.session, identity(), std::make_shared<CorruptWrite>());
        QCOMPARE(manager.prepare().action, Action::FirstLaunch);
        QCOMPARE(failure([&] { manager.markReady(); }), QString("PREVIEW_READY_CANDIDATE_VERIFY_FAILED"));
        QVERIFY(!QFileInfo::exists(fixture.root + "/ready-candidate.json"));
        QCOMPARE(read(fixture.root + "/.ready-candidate-unrelated.tmp"), QByteArray("preserve unrelated temporary bytes"));
        QCOMPARE(QDir(fixture.root).entryList({".ready-candidate-*.tmp"}, QDir::Files | QDir::Hidden),
                 QStringList({".ready-candidate-unrelated.tmp"}));
    }
    void malformedManagedNameSnapshotSurvivesRetention() {
        Fixture fixture; fixture.ready(identity("synthetic-0"));
        Manager initial(*fixture.session, identity("synthetic-1"));
        const auto invalidName = initial.prepare().snapshotName;
        const auto invalidPath = fixture.root + "/snapshots/" + invalidName;
        write(invalidPath + "/data/database.db", "preserve corrupted snapshot payload");
        const auto manifest = read(invalidPath + "/manifest.json");
        initial.markReady();
        for (int i = 2; i <= 5; ++i) fixture.ready(identity("synthetic-" + QString::number(i)));
        QCOMPARE(snapshots(fixture.root).size(), 4); // Three valid and the preserved invalid snapshot.
        QCOMPARE(read(invalidPath + "/manifest.json"), manifest);
        QCOMPARE(read(invalidPath + "/data/database.db"), QByteArray("preserve corrupted snapshot payload"));
    }
    void excessiveSourceNestingFailsBeforeCopy() {
        Fixture fixture; fixture.ready(identity());
        auto path = fixture.root + "/avatars";
        for (int i = 0; i < 129; ++i) { path += "/d"; mkdir(path); }
        write(path + "/private-name", "private deeply nested bytes");
        Manager manager(*fixture.session, identity("synthetic-next"));
        QVERIFY(!failure([&] { manager.prepare(); }).isEmpty());
        QCOMPARE(children(fixture.root + "/snapshots").size(), 0);
        QCOMPARE(read(path + "/private-name"), QByteArray("private deeply nested bytes"));
    }
};

QTEST_GUILESS_MAIN(PreviewSnapshotTest)
#include "PreviewSnapshotTest.moc"
