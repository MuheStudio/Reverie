#include "../src/PreviewEvents.h"
#include "../src/PreviewWorkspace.h"
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTest>
#include <sys/stat.h>
#include <unistd.h>

class PreviewEventsTest final : public QObject {
    Q_OBJECT
    static QString base(QTemporaryDir &d) { return QFileInfo(d.path()).canonicalFilePath() + "/workspace"; }
    static QByteArray read(const QString &p) { QFile f(p); if (!f.open(QIODevice::ReadOnly)) throw std::runtime_error("fixture read"); return f.readAll(); }
    static void write(const QString &p, const QByteArray &b) {
        QFile f(p); if (!f.open(QIODevice::WriteOnly) || f.write(b) != b.size()) throw std::runtime_error("fixture write");
        f.close(); if (::chmod(QFile::encodeName(p), 0600)) throw std::runtime_error("fixture mode");
    }
    static bool rejects(const std::function<void()> &f) {
        try { f(); } catch (const PreviewWorkspace::Error &e) { return e.exitCode == 70 && QByteArray(e.what()) == "PREVIEW_EVENT_WRITE_FAILED"; }
        return false;
    }
private slots:
    void lockedWriterEmitsOnlyFixedFieldsAndUnknownCode() {
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session s(root); PreviewEvents::Writer w(s);
        w.record("startup_failed", "secret-token /Users/private/body https://private.invalid");
        const auto bytes = read(root + "/preview-events.jsonl");
        QVERIFY(!bytes.contains("secret")); QVERIFY(!bytes.contains("/Users")); QVERIFY(!bytes.contains("https"));
        auto o = QJsonDocument::fromJson(bytes.trimmed()).object();
        QCOMPARE(o.size(), 8); QCOMPARE(o["code"].toString(), QString("UNKNOWN")); QCOMPARE(o["sequence"].toInt(), 1);
        QCOMPARE(o["event"].toString(), QString("startup_failed"));
        struct stat st{}; QVERIFY(::lstat(QFile::encodeName(root + "/preview-events.jsonl"), &st) == 0);
        QCOMPARE(st.st_mode & 07777, mode_t(0600));
    }
    void duplicateInstanceCannotWriteAnyEvent() {
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session s(root); PreviewEvents::Writer w(s); w.record("startup");
        const auto before = read(root + "/preview-events.jsonl"); bool rejected = false;
        try { PreviewWorkspace::Session duplicate(root); PreviewEvents::Writer unwanted(duplicate); unwanted.record("startup"); }
        catch (const PreviewWorkspace::Error &e) { rejected = e.exitCode == PreviewWorkspace::AlreadyRunning; }
        QVERIFY(rejected); QCOMPARE(read(root + "/preview-events.jsonl"), before);
    }
    void retentionIsBoundedAndKeepsNewestCompleteRecords() {
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session s(root); PreviewEvents::Writer w(s);
        for (int i=0;i<400;++i) w.record("restore_state", "CLEAN", i);
        const auto bytes = read(root + "/preview-events.jsonl"); QVERIFY(bytes.size() <= PreviewEvents::MaximumBytes);
        auto lines = bytes.trimmed().split('\n'); QCOMPARE(lines.size(), PreviewEvents::MaximumRecords);
        QCOMPARE(QJsonDocument::fromJson(lines.front()).object()["value"].toInt(), 272);
        QCOMPARE(QJsonDocument::fromJson(lines.back()).object()["value"].toInt(), 399);
        PreviewEvents::Writer next(s); next.record("startup");
        QCOMPARE(read(root + "/preview-events.jsonl").trimmed().split('\n').size(), PreviewEvents::MaximumRecords);
    }
    void unknownEventRejectsWithoutChangingPriorFile() {
        QTemporaryDir d; const auto root=base(d); PreviewWorkspace::Session s(root); PreviewEvents::Writer w(s); w.record("startup");
        const auto before=read(root+"/preview-events.jsonl");
        QVERIFY(rejects([&]{ w.record("secret-body"); })); QCOMPARE(read(root+"/preview-events.jsonl"),before);
    }
    void importedMalformedHistoryIsNotRewritten() {
        QTemporaryDir d; const auto root=base(d); PreviewWorkspace::Session s(root);
        const QByteArray privateBytes="{\"body\":\"private sentinel\"}\n"; write(root+"/preview-events.jsonl",privateBytes);
        QVERIFY(rejects([&]{ PreviewEvents::Writer w(s); })); QCOMPARE(read(root+"/preview-events.jsonl"),privateBytes);
    }
    void eventSymlinkAndHardlinkAreRejected() {
        QTemporaryDir d; const auto root=base(d); PreviewWorkspace::Session s(root);
        const auto external=QFileInfo(d.path()).canonicalFilePath()+"/keep"; write(external,"private sentinel");
        const auto file=root+"/preview-events.jsonl";
        QVERIFY(::symlink(QFile::encodeName(external),QFile::encodeName(file))==0);
        QVERIFY(rejects([&]{PreviewEvents::Writer w(s);})); QCOMPARE(read(external),QByteArray("private sentinel"));
        QVERIFY(QFile::remove(file)); QVERIFY(::link(QFile::encodeName(external),QFile::encodeName(file))==0);
        QVERIFY(rejects([&]{PreviewEvents::Writer w(s);})); QCOMPARE(read(external),QByteArray("private sentinel"));
    }
    void eventDestinationSwapToLinkRejectsWithoutFollowing() {
        QTemporaryDir d; const auto root=base(d); PreviewWorkspace::Session s(root); PreviewEvents::Writer w(s); w.record("startup");
        const auto external=QFileInfo(d.path()).canonicalFilePath()+"/keep"; write(external,"private sentinel");
        const auto file=root+"/preview-events.jsonl"; QVERIFY(QFile::remove(file));
        QVERIFY(::symlink(QFile::encodeName(external),QFile::encodeName(file))==0);
        QVERIFY(rejects([&]{w.record("ready","CLEAN");})); QCOMPARE(read(external),QByteArray("private sentinel"));
    }
    void renamedWorkspacePathCannotRedirectWritesThroughReplacementSymlink() {
        QTemporaryDir d;
        const auto root = base(d), heldRoot = root + "-held";
        const auto outside = QFileInfo(d.path()).canonicalFilePath() + "/outside";
        PreviewWorkspace::Session session(root); PreviewEvents::Writer writer(session);
        writer.record("startup");
        QVERIFY(QDir().mkdir(outside)); QVERIFY(::chmod(QFile::encodeName(outside), 0700) == 0);
        const QByteArray outsideBytes("outside private sentinel; preserve original bytes");
        write(outside + "/preview-events.jsonl", outsideBytes);
        QVERIFY(QDir().rename(root, heldRoot));
        QVERIFY(::symlink(QFile::encodeName(outside), QFile::encodeName(root)) == 0);
        writer.record("ready", "CLEAN");
        QCOMPARE(read(outside + "/preview-events.jsonl"), outsideBytes);
        QCOMPARE(QDir(outside).entryList(QDir::AllEntries | QDir::Hidden | QDir::NoDotAndDotDot),
                 QStringList({"preview-events.jsonl"}));
        const auto lines = read(heldRoot + "/preview-events.jsonl").trimmed().split('\n');
        QCOMPARE(lines.size(), 2);
        QCOMPARE(QJsonDocument::fromJson(lines.last()).object()["event"].toString(), QString("ready"));
        QCOMPARE(QJsonDocument::fromJson(lines.last()).object()["code"].toString(), QString("CLEAN"));
        QVERIFY(!read(heldRoot + "/preview-events.jsonl").contains("outside private sentinel"));
    }
    void duplicateJsonKeysCannotRetainHiddenPrivateStrings_data() {
        QTest::addColumn<QByteArray>("duplicateFields");
        QTest::newRow("hidden-error-code") << QByteArray("\"code\":\"private-sentinel https://private.invalid/token\",\"code\":\"OK\"");
        QTest::newRow("hidden-numeric-field") << QByteArray("\"hostPid\":\"private-sentinel /Users/private/avatar-name\",\"hostPid\":123,\"code\":\"OK\"");
    }
    void duplicateJsonKeysCannotRetainHiddenPrivateStrings() {
        QFETCH(QByteArray, duplicateFields);
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session session(root);
        const QByteArray original = QByteArray("{\"schema\":\"reverie.qt.preview-event.v1\",\"event\":\"startup\",\"hostPid\":123,") +
            "\"sequence\":1,\"timeMs\":1,\"elapsedMs\":0,\"value\":0," + duplicateFields + "}\n";
        write(root + "/preview-events.jsonl", original);
        PreviewEvents::Writer writer(session); writer.record("ready", "CLEAN");
        const auto retained = read(root + "/preview-events.jsonl");
        QVERIFY(!retained.contains("private-sentinel")); QVERIFY(!retained.contains("https://"));
        QVERIFY(!retained.contains("/Users/")); QVERIFY(!retained.contains("avatar-name"));
        const auto lines = retained.trimmed().split('\n'); QCOMPARE(lines.size(), 2);
        QCOMPARE(QJsonDocument::fromJson(lines.first()).object()["code"].toString(), QString("OK"));
        QCOMPARE(QJsonDocument::fromJson(lines.last()).object()["code"].toString(), QString("CLEAN"));
    }
    void serviceFailureProviderEnumAcceptsOnlyDefinedValues_data() {
        QTest::addColumn<qint64>("provider"); QTest::addColumn<bool>("accepted");
        QTest::newRow("unknown-provider") << qint64(0) << true;
        QTest::newRow("llm-provider") << qint64(1) << true;
        QTest::newRow("other-provider") << qint64(9) << true;
        QTest::newRow("negative") << qint64(-1) << false;
        QTest::newRow("out-of-range") << qint64(10) << false;
        QTest::newRow("large-number") << qint64(9007199254740991LL) << false;
    }
    void serviceFailureProviderEnumAcceptsOnlyDefinedValues() {
        QFETCH(qint64, provider); QFETCH(bool, accepted);
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session session(root); PreviewEvents::Writer writer(session);
        writer.record("startup"); const auto before = read(root + "/preview-events.jsonl");
        if (!accepted) {
            QVERIFY(rejects([&] { writer.record("service_failure", "PROVIDER_AUTH_FAILED", provider); }));
            QCOMPARE(read(root + "/preview-events.jsonl"), before);
            return;
        }
        writer.record("service_failure", "PROVIDER_AUTH_FAILED", provider);
        const auto lines = read(root + "/preview-events.jsonl").trimmed().split('\n');
        const auto record = QJsonDocument::fromJson(lines.last()).object();
        QCOMPARE(record["event"].toString(), QString("service_failure"));
        QCOMPARE(record["code"].toString(), QString("PROVIDER_AUTH_FAILED"));
        QCOMPARE(record["value"].toInteger(), provider);
        PreviewEvents::Writer restored(session); restored.record("ready", "CLEAN");
        QCOMPARE(read(root + "/preview-events.jsonl").trimmed().split('\n').size(), 3);
    }
    void importedServiceFailureCannotSmuggleAnOutOfRangeProviderEnum_data() {
        QTest::addColumn<qint64>("provider");
        QTest::addColumn<bool>("lowercaseCode");
        QTest::newRow("negative") << qint64(-1) << false;
        QTest::newRow("out-of-range") << qint64(10) << false;
        QTest::newRow("large-number") << qint64(9007199254740991LL) << false;
        QTest::newRow("lowercase-code") << qint64(1) << true;
    }
    void importedServiceFailureCannotSmuggleAnOutOfRangeProviderEnum() {
        QFETCH(qint64, provider); QFETCH(bool, lowercaseCode);
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session session(root);
        // Establish a fresh real writer/reader baseline outside the rejection
        // assertion. Setup or acceptance failures must never pass a negative.
        { PreviewEvents::Writer writer(session); writer.record("service_failure", "PROVIDER_AUTH_FAILED", 1); }
        const auto validBytes = read(root + "/preview-events.jsonl");
        const auto baseline = QJsonDocument::fromJson(validBytes.trimmed()).object();
        QCOMPARE(baseline["event"].toString(), QString("service_failure"));
        QCOMPARE(baseline["code"].toString(), QString("PROVIDER_AUTH_FAILED"));
        QCOMPARE(baseline["value"].toInteger(), qint64(1));
        { PreviewEvents::Writer accepted(session); }
        QCOMPARE(read(root + "/preview-events.jsonl"), validBytes);
        auto record = baseline;
        const QString changedField = lowercaseCode ? "code" : "value";
        if (lowercaseCode) record[changedField] = "provider_auth_failed";
        else record[changedField] = provider;
        auto unchangedFields = record; unchangedFields[changedField] = baseline[changedField];
        QCOMPARE(unchangedFields, baseline);
        const auto original = QJsonDocument(record).toJson(QJsonDocument::Compact) + '\n';
        write(root + "/preview-events.jsonl", original);
        QVERIFY(rejects([&] { PreviewEvents::Writer writer(session); }));
        QCOMPARE(read(root + "/preview-events.jsonl"), original);
    }
    void explicitPrivateFileModeSurvivesRestrictiveUmask() {
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session session(root); PreviewEvents::Writer writer(session);
        struct RestrictiveMask {
            mode_t previous = ::umask(0777);
            ~RestrictiveMask() { ::umask(previous); }
        };
        { RestrictiveMask restricted; writer.record("startup"); }
        struct stat status{}; QVERIFY(::lstat(QFile::encodeName(root + "/preview-events.jsonl"), &status) == 0);
        QCOMPARE(status.st_mode & 07777, mode_t(0600));
        PreviewEvents::Writer restored(session); restored.record("ready", "CLEAN");
        QCOMPARE(read(root + "/preview-events.jsonl").trimmed().split('\n').size(), 2);
    }
    void readinessAndRecoveryEventsRetainOnlyTheirFixedCodes() {
        QTemporaryDir d; const auto root = base(d); PreviewWorkspace::Session session(root); PreviewEvents::Writer writer(session);
        writer.record("restore_state", "RECOVERY_REQUIRED"); writer.record("restore_state", "READ_ONLY");
        writer.record("restore_state", "CLEAN"); writer.record("ready", "CLEAN");
        writer.record("startup_failed", "KEY_MISSING_EXISTING_DATABASE");
        const auto lines = read(root + "/preview-events.jsonl").trimmed().split('\n'); QCOMPARE(lines.size(), 5);
        const QStringList expected{"RECOVERY_REQUIRED", "READ_ONLY", "CLEAN", "CLEAN", "KEY_MISSING_EXISTING_DATABASE"};
        for (qsizetype i = 0; i < lines.size(); ++i)
            QCOMPARE(QJsonDocument::fromJson(lines[i]).object()["code"].toString(), expected[i]);
    }
    void keychainFailureCopyIsPreviewOnly_data() {
        QTest::addColumn<QString>("code");
        QTest::newRow("denied-or-unavailable") << QString("KEYCHAIN_UNAVAILABLE");
        QTest::newRow("invalid-key") << QString("KEYCHAIN_KEY_INVALID");
        QTest::newRow("missing-existing-database") << QString("KEY_MISSING_EXISTING_DATABASE");
    }
    void keychainFailureCopyIsPreviewOnly() {
        QFETCH(QString,code);
        QCOMPARE(PreviewEvents::startupNotice(true,code),QString("无法从钥匙串读取存储密钥，预览没有启动，数据没有改动"));
        QCOMPARE(PreviewEvents::startupNotice(false,code),QString("启动被安全拒绝：%1").arg(code));
    }
    void unrelatedFailureCopyStaysUnchanged() {
        QCOMPARE(PreviewEvents::startupNotice(true,"PROJECT_PYTHON_INVALID"),QString("启动被安全拒绝：PROJECT_PYTHON_INVALID"));
    }
    void runtimeBuildDigestIsReadWithoutChangingLegacyMetadataContract() {
        QTemporaryDir d; const auto root=QFileInfo(d.path()).canonicalFilePath();
        QVERIFY(QDir(root).mkpath(".tools/python/runtime/bin"));
        const auto python=root+"/.tools/python/runtime/bin/python3"; write(python,"never executed"); QVERIFY(::chmod(QFile::encodeName(python),0700)==0);
        QJsonObject object{{"schema","reverie.qt.preview-runtime.v1"},{"candidate","synthetic"},{"sourceHead",QString(40,'a')},{"buildManifestSha256",QString(64,'b')}};
        write(root+"/preview-runtime.json",QJsonDocument(object).toJson());
        QCOMPARE(PreviewWorkspace::readRuntime(root,python).buildManifestSha256,QString(64,'b'));
        object.remove("buildManifestSha256"); write(root+"/preview-runtime.json",QJsonDocument(object).toJson());
        QVERIFY(PreviewWorkspace::readRuntime(root,python).buildManifestSha256.isEmpty());
    }
};
QTEST_GUILESS_MAIN(PreviewEventsTest)
#include "PreviewEventsTest.moc"
