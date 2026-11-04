#include "../src/PreviewWorkspace.h"
#include "../src/Keychain.h"

#include <QCoreApplication>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QTemporaryDir>
#include <QTest>
#include <cstdio>
#include <sys/stat.h>
#include <type_traits>
#include <unistd.h>

class PreviewWorkspaceTest final : public QObject {
    Q_OBJECT
    static QString canonical(const QString &path) {
        if (path.isEmpty()) throw std::runtime_error("temporary isolation directory is unavailable");
        const QString result = QFileInfo(path).canonicalFilePath();
        if (result.isEmpty()) throw std::runtime_error("temporary isolation directory is unavailable");
        return result;
    }
    static int rejected(const std::function<void()> &operation) {
        try { operation(); }
        catch (const PreviewWorkspace::Error &error) { return error.exitCode; }
        return 0;
    }
    static void write(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size())
            throw std::runtime_error("synthetic fixture write failed");
    }
    static QString runtime(const QString &root) {
        QDir(root).mkpath(".tools/python/runtime/bin");
        const QString python = root + "/.tools/python/runtime/bin/python3";
        write(python, "synthetic interpreter; never executed by this test\n");
        QFile::setPermissions(python, QFileDevice::ReadOwner | QFileDevice::WriteOwner | QFileDevice::ExeOwner);
        write(root + "/preview-runtime.json", QJsonDocument(QJsonObject{
            {"schema", "reverie.qt.preview-runtime.v1"}, {"candidate", "synthetic-preview"},
            {"sourceHead", QString(40, 'a')}}).toJson());
        return python;
    }
    static QStringList arguments(const QString &workspace = "/synthetic/workspace") {
        return {"--workspace", workspace, "--project-root", "/synthetic/runtime", "--python", "/synthetic/runtime/.venv/bin/python"};
    }
    static QByteArray read(const QString &path) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("synthetic fixture read failed");
        return file.readAll();
    }
    static QJsonObject directoryRecord(const QString &path) {
        struct stat status{};
        if (::lstat(QFile::encodeName(path).constData(), &status) != 0 || !S_ISDIR(status.st_mode))
            throw std::runtime_error("synthetic directory identity unavailable");
        return {{"path", path}, {"device", QString::number(status.st_dev)}, {"inode", QString::number(status.st_ino)}};
    }
    struct CleanupFixture {
        QTemporaryDir temporary{QDir::tempPath() + "/reverie-local-preview-cleanup-XXXXXX"};
        QString root, data, workspace, context;
        QJsonObject object;
        CleanupFixture() {
            root = canonical(temporary.path());
            data = root + "/data"; workspace = root + "/preview-workspace";
            context = root + "/preview-cleanup-context.json";
            for (const auto &path : QStringList{data, root + "/tmp"})
                if (!QDir().mkdir(path) || ::chmod(QFile::encodeName(path).constData(), 0700) != 0)
                    throw std::runtime_error("synthetic private directory unavailable");
            { PreviewWorkspace::Session session(workspace); }
            object = {{"schema", "reverie.qt.isolation.v1"}, {"purpose", "reverie.qt.preview-test-cleanup.v1"},
                      {"root", directoryRecord(root)}, {"data", directoryRecord(data)},
                      {"previewWorkspace", directoryRecord(workspace)}};
            save();
        }
        void save() const {
            write(context, QJsonDocument(object).toJson());
            if (::chmod(QFile::encodeName(context).constData(), 0600) != 0)
                throw std::runtime_error("synthetic context mode unavailable");
        }
    };
    struct CleanupEnvironment {
        QByteArray oldData = qgetenv("REVERIE_DATA_DIR"), oldTemporary = qgetenv("TMPDIR");
        bool hadData = qEnvironmentVariableIsSet("REVERIE_DATA_DIR"), hadTemporary = qEnvironmentVariableIsSet("TMPDIR");
        explicit CleanupEnvironment(const CleanupFixture &fixture) {
            qputenv("REVERIE_DATA_DIR", fixture.data.toUtf8());
            qputenv("TMPDIR", (fixture.root + "/tmp/").toUtf8());
        }
        ~CleanupEnvironment() {
            if (hadData) qputenv("REVERIE_DATA_DIR", oldData); else qunsetenv("REVERIE_DATA_DIR");
            if (hadTemporary) qputenv("TMPDIR", oldTemporary); else qunsetenv("TMPDIR");
        }
    };
private slots:
    void everyTestDiagnosticAndAlternateEntryConflicts_data() {
        QTest::addColumn<QString>("option");
        for (const auto &name : PreviewWorkspace::forbiddenOptions())
            QTest::newRow(qPrintable(name)) << name;
    }
    void everyTestDiagnosticAndAlternateEntryConflicts() {
        QFETCH(QString, option);
        auto values = arguments();
        values.append(option);
        QVERIFY(PreviewWorkspace::argumentConflict(values));
        values.last() += "=synthetic";
        QVERIFY(PreviewWorkspace::argumentConflict(values));
    }
    void onlyTheThreePreviewInputsAreAccepted() {
        QVERIFY(PreviewWorkspace::requested(arguments()));
        QVERIFY(!PreviewWorkspace::argumentConflict(arguments()));
        QVERIFY(!PreviewWorkspace::argumentConflict({"--workspace=/synthetic/workspace", "--project-root=/synthetic/runtime",
                                                   "--python=/synthetic/runtime/.venv/bin/python"}));
        QVERIFY(PreviewWorkspace::argumentConflict({"--workspace", "/synthetic/workspace"}));
        auto duplicate = arguments(); duplicate.append({"--workspace", "/other"});
        QVERIFY(PreviewWorkspace::argumentConflict(duplicate));
        auto unknown = arguments(); unknown.append("--unknown-preview-hook");
        QVERIFY(PreviewWorkspace::argumentConflict(unknown));
        auto positional = arguments(); positional.append("unexpected");
        QVERIFY(PreviewWorkspace::argumentConflict(positional));
        auto help = arguments(); help.append("--help");
        QVERIFY(PreviewWorkspace::argumentConflict(help));
    }
    void ordinaryModeStillUsesItsExistingParserAndGates() {
        for (const auto &name : PreviewWorkspace::forbiddenOptions()) {
            const QStringList original{"--context", "/synthetic/context", name};
            QVERIFY(!PreviewWorkspace::requested(original));
            QVERIFY(!PreviewWorkspace::argumentConflict(original));
        }
    }
    void conflictDetectionDoesNotCreateAWorkspace() {
        QTemporaryDir temporary;
        const QString path = canonical(temporary.path()) + "/not-created";
        auto values = arguments(path); values.append("--remove-test-key");
        QVERIFY(PreviewWorkspace::argumentConflict(values));
        QVERIFY(!QFileInfo::exists(path));
    }
    void missingWorkspaceCreatesOnlyTheLastPrivateDirectory() {
        QTemporaryDir temporary;
        const QString path = canonical(temporary.path()) + "/workspace";
        {
            PreviewWorkspace::Session workspace(path);
            QCOMPARE(workspace.root(), path);
            QCOMPARE(workspace.id().size(), 64);
            for (const auto &child : {QString(), QString("/data"), QString("/avatars"), QString("/qml-cache"), QString("/logs")}) {
                struct stat status{};
                QCOMPARE(::lstat(QFile::encodeName(path + child).constData(), &status), 0);
                QVERIFY(S_ISDIR(status.st_mode));
                QCOMPARE(int(status.st_mode & 0777), 0700);
                QCOMPARE(status.st_uid, ::getuid());
            }
            QVERIFY(QFileInfo::exists(path + "/workspace.lock"));
        }
        QVERIFY(QFileInfo::exists(path + "/workspace.lock"));
        { PreviewWorkspace::Session reopened(path); QCOMPARE(reopened.root(), path); }
        const QString missingParent = canonical(temporary.path()) + "/missing-parent/leaf";
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(missingParent); }), PreviewWorkspace::InvalidWorkspace);
        QVERIFY(!QFileInfo::exists(QFileInfo(missingParent).absolutePath()));
    }
    void relativeNoncanonicalFileAndSymlinkWorkspacesAreRejected() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path());
        QCOMPARE(rejected([] { PreviewWorkspace::Session workspace("relative"); }), PreviewWorkspace::InvalidWorkspace);
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root + "/./workspace"); }), PreviewWorkspace::InvalidWorkspace);
        write(root + "/file", "synthetic");
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root + "/file"); }), PreviewWorkspace::InvalidWorkspace);
        QVERIFY(QFile::link(root, root + "/alias"));
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root + "/alias"); }), PreviewWorkspace::InvalidWorkspace);
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root + "/alias/leaf"); }), PreviewWorkspace::InvalidWorkspace);
        QVERIFY(!QFileInfo::exists(root + "/leaf"));
    }
    void foreignOwnershipAndBroadPermissionsAreNotRepaired() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path());
        // A different expected uid exercises the real stat/owner predicate
        // without chown, elevated permissions or another user's directory.
        QCOMPARE(rejected([&] { PreviewWorkspace::Session::validateOwnedDirectory(root, quint64(::getuid()) + 1); }),
                 PreviewWorkspace::InvalidWorkspace);
        QCOMPARE(::chmod(QFile::encodeName(root).constData(), 0755), 0);
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root); }), PreviewWorkspace::InvalidWorkspace);
        struct stat status{};
        QCOMPARE(::lstat(QFile::encodeName(root).constData(), &status), 0);
        QCOMPARE(int(status.st_mode & 0777), 0755);
    }
    void secondInstanceCannotAcquireTheWorkspace() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()) + "/workspace";
        PreviewWorkspace::Session first(root);
        QCOMPARE(rejected([&] { PreviewWorkspace::Session second(root); }), PreviewWorkspace::AlreadyRunning);
        QVERIFY(QFileInfo::exists(root + "/workspace.lock"));
    }
    void specialDirectoryModeBitsAreRejected() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path());
        QCOMPARE(::chmod(QFile::encodeName(root).constData(), 01700), 0);
        QCOMPARE(rejected([&] { PreviewWorkspace::Session workspace(root); }), PreviewWorkspace::InvalidWorkspace);
    }
    void privateChildAndLockSymlinksAreRejected() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path());
        const QString workspace = root + "/workspace";
        QVERIFY(QDir().mkdir(workspace));
        QCOMPARE(::chmod(QFile::encodeName(workspace).constData(), 0700), 0);
        QVERIFY(QFile::link(root, workspace + "/data"));
        QCOMPARE(rejected([&] { PreviewWorkspace::Session session(workspace); }), PreviewWorkspace::InvalidWorkspace);
        QVERIFY(QFile::remove(workspace + "/data"));
        // The failed, isolated constructor already closed its kernel lock.
        QVERIFY(QFile::remove(workspace + "/workspace.lock"));
        write(root + "/other-lock", "synthetic");
        QVERIFY(QFile::link(root + "/other-lock", workspace + "/workspace.lock"));
        QCOMPARE(rejected([&] { PreviewWorkspace::Session session(workspace); }), PreviewWorkspace::InvalidWorkspace);
    }
    void aKilledHostLeavesARecoverableLock() {
        QTemporaryDir temporary;
        const QString workspace = canonical(temporary.path()) + "/workspace";
        QProcess holder;
        holder.start(QCoreApplication::applicationFilePath(), {"--preview-lock-fixture", workspace});
        QVERIFY(holder.waitForStarted(5000));
        QVERIFY(holder.waitForReadyRead(5000));
        QCOMPARE(holder.readAllStandardOutput().trimmed(), QByteArray("LOCKED"));
        QCOMPARE(rejected([&] { PreviewWorkspace::Session second(workspace); }), PreviewWorkspace::AlreadyRunning);
        holder.kill();
        QVERIFY(holder.waitForFinished(5000));
        QVERIFY(QFileInfo::exists(workspace + "/workspace.lock"));
        PreviewWorkspace::Session recovered(workspace);
        QCOMPARE(recovered.root(), workspace);
    }
    void incompleteResidualLockMetadataDoesNotPreventRecovery() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()) + "/workspace";
        QVERIFY(QDir().mkdir(root));
        QCOMPARE(::chmod(QFile::encodeName(root).constData(), 0700), 0);
        for (const auto &leftover : {QByteArray(), QByteArray("partial-owner-record")}) {
            write(root + "/workspace.lock", leftover);
            PreviewWorkspace::Session recovered(root);
            QCOMPARE(recovered.root(), root);
        }
    }
    void runtimeMetadataWorksWithoutAGitCheckout() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()), python = runtime(root);
        QVERIFY(!QFileInfo::exists(root + "/.git"));
        const auto info = PreviewWorkspace::readRuntime(root, python);
        QCOMPARE(info.candidate, QString("synthetic-preview"));
        QCOMPARE(info.sourceHead, QString(40, 'a'));
        QCOMPARE(info.title(), QString("Reverie 预览 · synthetic-preview · aaaaaaaa"));
    }
    void metadataAndInterpreterCannotEscapeTheInstalledRuntime() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()), python = runtime(root);
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, "/bin/sh"); }), PreviewWorkspace::InvalidRuntime);
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, QFileInfo(python).absolutePath()); }), PreviewWorkspace::InvalidRuntime);
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root + "/.", python); }), PreviewWorkspace::InvalidRuntime);
        write(root + "/preview-runtime.json", "{truncated");
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, python); }), PreviewWorkspace::InvalidRuntime);
        runtime(root);
        QVERIFY(QFile::rename(root + "/preview-runtime.json", root + "/metadata-original.json"));
        QVERIFY(QFile::link(root + "/metadata-original.json", root + "/preview-runtime.json"));
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, python); }), PreviewWorkspace::InvalidRuntime);
    }
    void runtimeMetadataHasABoundedRead() {
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()), python = runtime(root);
        QFile file(root + "/preview-runtime.json");
        QVERIFY(file.open(QIODevice::ReadOnly));
        QByteArray valid = file.readAll(); file.close();
        valid.append(QByteArray(65536 - valid.size(), ' '));
        write(file.fileName(), valid);
        QCOMPARE(PreviewWorkspace::readRuntime(root, python).candidate, QString("synthetic-preview"));
        valid.append(' '); write(file.fileName(), valid);
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, python); }), PreviewWorkspace::InvalidRuntime);
    }
    void metadataSchemaAndIdentityAreRequired_data() {
        QTest::addColumn<QString>("key"); QTest::addColumn<QString>("value");
        QTest::newRow("wrong-schema") << QString("schema") << QString("other");
        QTest::newRow("candidate-path") << QString("candidate") << QString("../other");
        QTest::newRow("candidate-too-long") << QString("candidate") << QString(129, 'a');
        QTest::newRow("source-not-commit") << QString("sourceHead") << QString("working-tree");
    }
    void metadataSchemaAndIdentityAreRequired() {
        QFETCH(QString, key); QFETCH(QString, value);
        QTemporaryDir temporary;
        const QString root = canonical(temporary.path()), python = runtime(root);
        QJsonObject metadata{{"schema", "reverie.qt.preview-runtime.v1"}, {"candidate", "synthetic"}, {"sourceHead", QString(40, 'a')}};
        metadata[key] = value;
        write(root + "/preview-runtime.json", QJsonDocument(metadata).toJson());
        QCOMPARE(rejected([&] { PreviewWorkspace::readRuntime(root, python); }), PreviewWorkspace::InvalidRuntime);
    }
    void previewAndExistingKeychainServicesAreDisjoint() {
        QCOMPARE(storageKeychainService(KeychainDomain::Local), QString("com.muhe.reverie.qt.local.storage.v1"));
        QCOMPARE(providerKeychainService(KeychainDomain::Local), QString("com.muhe.reverie.qt.local.credentials.v1"));
        QCOMPARE(storageKeychainService(KeychainDomain::Preview), QString("com.muhe.reverie.qt.preview.storage.v1"));
        QCOMPARE(providerKeychainService(KeychainDomain::Preview), QString("com.muhe.reverie.qt.preview.credentials.v1"));
        QVERIFY(storageKeychainService(KeychainDomain::Local) != storageKeychainService(KeychainDomain::Preview));
        QVERIFY(providerKeychainService(KeychainDomain::Local) != providerKeychainService(KeychainDomain::Preview));
        // No Keychain API is invoked by these namespace checks.
    }
    void cleanupAcceptsOnlyItsThreeExplicitInputs() {
        const QStringList valid{"--remove-preview-test-key", "--context", "/synthetic/context", "--data-dir", "/synthetic/data"};
        QVERIFY(PreviewWorkspace::cleanupRequested(valid));
        QVERIFY(!PreviewWorkspace::cleanupArgumentConflict(valid));
        QVERIFY(!PreviewWorkspace::cleanupArgumentConflict({"--remove-preview-test-key", "--context=/synthetic/context",
                                                           "--data-dir=/synthetic/data"}));
        QVERIFY(!PreviewWorkspace::cleanupRequested({"--remove-test-key", "--context", "/synthetic/context"}));
        QVERIFY(!PreviewWorkspace::cleanupArgumentConflict({"--remove-test-key", "--context", "/synthetic/context"}));
        for (const auto &extra : {"--help", "--remove-test-key", "--project-root", "--python", "--perf-seed", "unexpected"}) {
            auto values = valid; values.append(extra);
            QVERIFY(PreviewWorkspace::cleanupArgumentConflict(values));
        }
        auto duplicate = valid; duplicate.append("--remove-preview-test-key");
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict(duplicate));
        duplicate = valid; duplicate.append("--context=/other");
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict(duplicate));
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict({"--remove-preview-test-key", "--context", "/synthetic/context"}));
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict({"--remove-preview-test-key", "--context=", "--data-dir=/synthetic/data"}));
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict({"--remove-preview-test-key=true", "--context=/synthetic/context",
                                                          "--data-dir=/synthetic/data"}));
        auto preview = arguments(); preview.append("--remove-preview-test-key");
        QVERIFY(PreviewWorkspace::argumentConflict(preview)); // Main gives preview conflict 64 precedence.
        QVERIFY(PreviewWorkspace::cleanupArgumentConflict(preview));
    }
    void cleanupTokenHoldsTheExistingLockWithoutChangingFiles() {
        static_assert(!std::is_default_constructible_v<PreviewWorkspace::CleanupTarget>);
        static_assert(!std::is_copy_constructible_v<PreviewWorkspace::CleanupTarget>);
        CleanupFixture fixture;
        CleanupEnvironment environment(fixture);
        const auto lockBefore = read(fixture.workspace + "/workspace.lock"), contextBefore = read(fixture.context);
        struct stat before{}, after{};
        QCOMPARE(::lstat(QFile::encodeName(fixture.workspace + "/workspace.lock").constData(), &before), 0);
        {
            auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data);
            QCOMPARE(target.workspace(), fixture.workspace);
            auto moved = std::move(target);
            QCOMPARE(moved.workspace(), fixture.workspace);
            QCOMPARE(rejected([&] { (void)target.workspace(); }), PreviewWorkspace::CleanupScopeRejected);
            QCOMPARE(rejected([&] { removePreviewTestKeys(target); }), PreviewWorkspace::CleanupScopeRejected);
            QCOMPARE(rejected([&] { PreviewWorkspace::Session active(fixture.workspace); }), PreviewWorkspace::AlreadyRunning);
            QCOMPARE(read(fixture.workspace + "/workspace.lock"), lockBefore);
            QCOMPARE(read(fixture.context), contextBefore);
        }
        QCOMPARE(::lstat(QFile::encodeName(fixture.workspace + "/workspace.lock").constData(), &after), 0);
        QCOMPARE(after.st_dev, before.st_dev); QCOMPARE(after.st_ino, before.st_ino);
        QCOMPARE(read(fixture.workspace + "/workspace.lock"), lockBefore);
        PreviewWorkspace::Session reopened(fixture.workspace);
        QCOMPARE(reopened.root(), fixture.workspace);
        // The invalid-token deletion exits before constructing a query or
        // calling any Security framework API; the live token is never deleted.
    }
    void cleanupRejectsOrdinaryAndWrongPurposeContexts_data() {
        QTest::addColumn<QString>("purpose");
        QTest::newRow("ordinary-context") << QString();
        QTest::newRow("wrong-purpose") << QString("reverie.qt.other-cleanup.v1");
    }
    void cleanupRejectsOrdinaryAndWrongPurposeContexts() {
        QFETCH(QString, purpose);
        CleanupFixture fixture; CleanupEnvironment environment(fixture);
        if (purpose.isEmpty()) fixture.object.remove("purpose"); else fixture.object["purpose"] = purpose;
        fixture.save();
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data); }),
                 PreviewWorkspace::CleanupScopeRejected);
    }
    void cleanupRejectsWorkspaceScopeAndAliasChanges_data() {
        QTest::addColumn<QString>("change");
        for (const auto *name : {"outside", "root-itself", "data", "temporary", "relative", "dot-alias", "symlink", "ancestor-symlink"})
            QTest::newRow(name) << QString::fromLatin1(name);
    }
    void cleanupRejectsWorkspaceScopeAndAliasChanges() {
        QFETCH(QString, change);
        CleanupFixture fixture;
        QTemporaryDir outside;
        CleanupEnvironment environment(fixture);
        QString selected = fixture.workspace;
        if (change == "outside") selected = canonical(outside.path());
        else if (change == "root-itself") selected = fixture.root;
        else if (change == "data") selected = fixture.data;
        else if (change == "temporary") selected = fixture.root + "/tmp";
        else if (change == "relative") selected = "preview-workspace";
        else if (change == "dot-alias") selected = fixture.root + "/./preview-workspace";
        else if (change == "symlink") {
            selected = fixture.root + "/alias"; QVERIFY(QFile::link(fixture.workspace, selected));
        } else if (change == "ancestor-symlink") {
            QVERIFY(QFile::link(fixture.root, fixture.root + "/alias"));
            selected = fixture.root + "/alias/preview-workspace";
        }
        auto record = fixture.object["previewWorkspace"].toObject(); record["path"] = selected;
        fixture.object["previewWorkspace"] = record; fixture.save();
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data); }),
                 PreviewWorkspace::CleanupScopeRejected);
    }
    void cleanupRejectsEnvironmentAndIdentityChanges_data() {
        QTest::addColumn<QString>("change");
        for (const auto *name : {"environment-data", "environment-tmp", "argument-data", "root-path", "data-path",
                                 "root-device", "data-inode", "workspace-inode", "schema"})
            QTest::newRow(name) << QString::fromLatin1(name);
    }
    void cleanupRejectsEnvironmentAndIdentityChanges() {
        QFETCH(QString, change);
        CleanupFixture fixture; CleanupEnvironment environment(fixture);
        QString data = fixture.data;
        if (change == "environment-data") qputenv("REVERIE_DATA_DIR", (fixture.root + "/other-data").toUtf8());
        else if (change == "environment-tmp") qputenv("TMPDIR", (fixture.root + "/other-tmp").toUtf8());
        else if (change == "argument-data") data += "/.";
        else if (change == "schema") fixture.object["schema"] = "other";
        else {
            const QString key = change.startsWith("root-") ? "root" : change.startsWith("data-") ? "data" : "previewWorkspace";
            auto record = fixture.object[key].toObject();
            const QString field = change.endsWith("path") ? "path" : change.endsWith("device") ? "device" : "inode";
            record[field] = field == "path" ? fixture.root + "/other" : "changed";
            fixture.object[key] = record;
        }
        fixture.save();
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, data); }),
                 PreviewWorkspace::CleanupScopeRejected);
    }
    void cleanupRejectsUnsafeOwnerAndDirectoryModes() {
        CleanupFixture fixture; CleanupEnvironment environment(fixture);
        QCOMPARE(rejected([&] { PreviewWorkspace::CleanupTarget::validateDirectory(fixture.workspace, quint64(::getuid()) + 1); }),
                 PreviewWorkspace::CleanupScopeRejected);
        for (const auto &path : QStringList{fixture.root, fixture.data, fixture.root + "/tmp", fixture.workspace}) {
            QCOMPARE(::chmod(QFile::encodeName(path).constData(), 0755), 0);
            QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data); }),
                     PreviewWorkspace::CleanupScopeRejected);
            QCOMPARE(::chmod(QFile::encodeName(path).constData(), 0700), 0);
        }
    }
    void cleanupRejectsUnsafeContextFiles_data() {
        QTest::addColumn<QString>("change");
        for (const auto *name : {"outside", "symlink", "hardlink", "mode", "too-large", "malformed"})
            QTest::newRow(name) << QString::fromLatin1(name);
    }
    void cleanupRejectsUnsafeContextFiles() {
        QFETCH(QString, change);
        CleanupFixture fixture;
        QTemporaryDir outside;
        CleanupEnvironment environment(fixture);
        QString context = fixture.context;
        if (change == "outside") {
            context = canonical(outside.path()) + "/context.json"; write(context, read(fixture.context));
            QCOMPARE(::chmod(QFile::encodeName(context).constData(), 0600), 0);
        } else if (change == "symlink") {
            context = fixture.root + "/context-alias"; QVERIFY(QFile::link(fixture.context, context));
        } else if (change == "hardlink") {
            QCOMPARE(::link(QFile::encodeName(context).constData(), QFile::encodeName(fixture.root + "/context-link").constData()), 0);
        } else if (change == "mode") QCOMPARE(::chmod(QFile::encodeName(context).constData(), 0644), 0);
        else if (change == "too-large") write(context, QByteArray(16385, ' '));
        else if (change == "malformed") write(context, "{truncated");
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(context, fixture.data); }),
                 PreviewWorkspace::CleanupScopeRejected);
    }
    void cleanupRejectsAnActiveWorkspace() {
        CleanupFixture fixture; CleanupEnvironment environment(fixture);
        PreviewWorkspace::Session running(fixture.workspace);
        const auto before = read(fixture.workspace + "/workspace.lock");
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data); }),
                 PreviewWorkspace::CleanupScopeRejected);
        QCOMPARE(read(fixture.workspace + "/workspace.lock"), before);
    }
    void cleanupNeverCreatesOrRepairsALock_data() {
        QTest::addColumn<QString>("change");
        for (const auto *name : {"missing", "symlink", "hardlink", "mode"}) QTest::newRow(name) << QString::fromLatin1(name);
    }
    void cleanupNeverCreatesOrRepairsALock() {
        QFETCH(QString, change);
        CleanupFixture fixture; CleanupEnvironment environment(fixture);
        const QString lock = fixture.workspace + "/workspace.lock";
        if (change == "missing") QVERIFY(QFile::remove(lock));
        else if (change == "symlink") {
            QVERIFY(QFile::remove(lock)); QVERIFY(QFile::link(fixture.context, lock));
        } else if (change == "hardlink") {
            QCOMPARE(::link(QFile::encodeName(lock).constData(), QFile::encodeName(fixture.root + "/lock-link").constData()), 0);
        } else QCOMPARE(::chmod(QFile::encodeName(lock).constData(), 0644), 0);
        QCOMPARE(rejected([&] { auto target = PreviewWorkspace::validateTestCleanupContext(fixture.context, fixture.data); }),
                 PreviewWorkspace::CleanupScopeRejected);
        if (change == "missing") QVERIFY(!QFileInfo::exists(lock));
        else if (change == "mode") {
            struct stat status{}; QCOMPARE(::lstat(QFile::encodeName(lock).constData(), &status), 0);
            QCOMPARE(int(status.st_mode & 0777), 0644);
        }
    }
    void readyOutputProjectsOnlyAuthenticatedNonsecretState() {
        const PreviewWorkspace::RuntimeInfo info{"/synthetic/runtime", "synthetic-preview", QString(40, 'a')};
        const QVariantMap status{{"backendPid", 12345}, {"recoveryState", "clean"}, {"runtimeWritable", true},
            {"secret", "never-output"}, {"secretSha256", "never-output"}, {"personaFingerprint", "never-output"}};
        const auto line = PreviewWorkspace::readyLine(info, QString(64, 'b'), 12344, status);
        QVERIFY(line.startsWith("REVERIE_PREVIEW_READY "));
        QVERIFY(line.endsWith('\n'));
        QVERIFY(!line.contains("never-output"));
        const auto object = QJsonDocument::fromJson(line.mid(QByteArray("REVERIE_PREVIEW_READY ").size())).object();
        QCOMPARE(object.size(), 8);
        QCOMPARE(object["schema"].toString(), QString("reverie.qt.preview.ready.v1"));
        QCOMPARE(object["candidate"].toString(), info.candidate);
        QCOMPARE(object["sourceHead"].toString(), info.sourceHead);
        QCOMPARE(object["backendPid"].toInt(), 12345);
        QCOMPARE(object["hostPid"].toInt(), 12344);
        QVERIFY(object["runtimeWritable"].toBool());
        auto invalid = status; invalid["runtimeWritable"] = "true";
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'b'), 12344, invalid).isEmpty());
        invalid = status; invalid["backendPid"] = 0;
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'b'), 12344, invalid).isEmpty());
        invalid = status; invalid["runtimeWritable"] = false;
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'b'), 12344, invalid).isEmpty());
        invalid = status; invalid["recoveryState"] = "recovering";
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'b'), 12344, invalid).isEmpty());
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'z'), 12344, status).isEmpty());
        QVERIFY(PreviewWorkspace::readyLine(info, QString(64, 'b'), 12345, status).isEmpty());
    }
    void sigtermUsesTheQtCloseCallbackAndExitsNormally() {
        QProcess child;
        child.start(QCoreApplication::applicationFilePath(), {"--preview-term-fixture"});
        QVERIFY(child.waitForStarted(5000));
        QVERIFY(child.waitForReadyRead(5000));
        QCOMPARE(child.readAllStandardOutput().trimmed(), QByteArray("TERM_READY"));
        child.terminate();
        QVERIFY(child.waitForFinished(5000));
        QCOMPARE(child.exitStatus(), QProcess::NormalExit);
        QCOMPARE(child.exitCode(), 0);
        QCOMPARE(child.readAllStandardOutput().trimmed(), QByteArray("CLOSE_CALLBACK"));
    }
};

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    app.setApplicationName("PreviewWorkspaceTest");
    const auto arguments = app.arguments();
    if (arguments.size() == 3 && arguments[1] == "--preview-lock-fixture") {
        PreviewWorkspace::Session workspace(arguments[2]);
        std::fputs("LOCKED\n", stdout); std::fflush(stdout);
        return app.exec();
    }
    if (arguments.size() == 2 && arguments[1] == "--preview-term-fixture") {
        PreviewWorkspace::Termination termination(&app, [&] {
            std::fputs("CLOSE_CALLBACK\n", stdout); std::fflush(stdout); app.quit();
        });
        std::fputs("TERM_READY\n", stdout); std::fflush(stdout);
        return app.exec();
    }
    PreviewWorkspaceTest test;
    return QTest::qExec(&test, argc, argv);
}
#include "PreviewWorkspaceTest.moc"
