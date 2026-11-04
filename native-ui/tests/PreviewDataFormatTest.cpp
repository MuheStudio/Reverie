#include "../src/PreviewDataFormat.h"
#include "../src/PreviewWorkspace.h"
#include "../src/PreviewPlatform.h"

#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QTemporaryDir>
#include <QTest>
#include <sys/stat.h>
#include <unistd.h>

class PreviewDataFormatTest final : public QObject {
    Q_OBJECT
    static void save(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size())
            throw std::runtime_error("synthetic format fixture write failed");
        file.close();
        if (::chmod(QFile::encodeName(path).constData(), 0600) != 0)
            throw std::runtime_error("synthetic format fixture permissions failed");
    }
    static QByteArray read(const QString &path) {
        QFile file(path);
        if (!file.open(QIODevice::ReadOnly)) throw std::runtime_error("synthetic format fixture read failed");
        return file.readAll();
    }
    static QByteArray record(int version) {
        return QJsonDocument(QJsonObject{{"schema", PreviewDataFormat::Schema}, {"formatVersion", version}}).toJson();
    }
    static QString rejected(const std::function<void()> &operation) {
        try { operation(); } catch (const PreviewDataFormat::Error &error) { return QString::fromUtf8(error.what()); }
        return {};
    }
    static QString root(QTemporaryDir &temporary) {
        const auto path = QFileInfo(temporary.path()).canonicalFilePath();
        if (path.isEmpty() || ::chmod(QFile::encodeName(path).constData(), 0700) != 0)
            throw std::runtime_error("synthetic private isolation unavailable");
        return path;
    }
private slots:
    void absentLegacyRecordCreatesNothing() {
        QTemporaryDir temporary; const auto parent = root(temporary), workspace = parent + "/workspace";
        QCOMPARE(PreviewDataFormat::checkWorkspace(workspace), 1);
        QVERIFY(!QFileInfo::exists(workspace));
        { PreviewWorkspace::Session locked(workspace, PreviewWorkspace::Session::Initialization::LockOnly);
          QCOMPARE(PreviewDataFormat::checkWorkspace(workspace), 1);
          QVERIFY(!QFileInfo::exists(workspace + "/data"));
          QVERIFY(!QFileInfo::exists(workspace + "/avatars")); }
    }
    void futureRecordRefusesBeforeChildrenAndPreservesBytes() {
        QTemporaryDir temporary; const auto parent = root(temporary), workspace = parent + "/workspace";
        { PreviewWorkspace::Session session(workspace); }
        const auto file = workspace + "/data/" + PreviewDataFormat::FileName;
        const auto bytes = record(PreviewDataFormat::Current + 1); save(file, bytes);
        save(workspace + "/avatars/synthetic-resource", "unchanged avatar bytes");
        QVERIFY(QDir(workspace + "/qml-cache").removeRecursively());
        QVERIFY(QDir(workspace + "/logs").removeRecursively());
        PreviewWorkspace::Session locked(workspace, PreviewWorkspace::Session::Initialization::LockOnly);
        QCOMPARE(rejected([&] { PreviewDataFormat::checkWorkspace(workspace); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        QCOMPARE(read(file), bytes);
        QCOMPARE(read(workspace + "/avatars/synthetic-resource"), QByteArray("unchanged avatar bytes"));
        QVERIFY(!QFileInfo::exists(workspace + "/qml-cache"));
        QVERIFY(!QFileInfo::exists(workspace + "/logs"));
        QCOMPARE(rejected([&] { PreviewDataFormat::writeReady(locked); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        QCOMPARE(read(file), bytes);
    }
    void readyPublishesOnePrivateRecordAndRetainsLegacyData() {
        QTemporaryDir temporary; const auto workspace = root(temporary) + "/workspace";
        PreviewWorkspace::Session session(workspace);
        save(workspace + "/data/synthetic-legacy.json", "legacy exact bytes");
        const auto file = workspace + "/data/" + PreviewDataFormat::FileName;
        QVERIFY(!QFileInfo::exists(file));
        PreviewDataFormat::writeReady(session);
        QCOMPARE(PreviewDataFormat::checkWorkspace(workspace), PreviewDataFormat::Current);
        const auto bytes = read(file);
        PreviewDataFormat::writeReady(session);
        QCOMPARE(read(file), bytes);
        QCOMPARE(read(workspace + "/data/synthetic-legacy.json"), QByteArray("legacy exact bytes"));
        struct stat info{}; QVERIFY(::lstat(QFile::encodeName(file).constData(), &info) == 0);
        QCOMPARE(info.st_nlink, nlink_t(1)); QCOMPARE(info.st_mode & 07777, mode_t(0600));
    }
    void malformedRecordsFailClosed_data() {
        QTest::addColumn<QByteArray>("bytes");
        QTest::newRow("syntax") << QByteArray("{");
        QTest::newRow("unknown-schema") << QByteArray("{\"schema\":\"reverie.preview.data-format.v2\",\"formatVersion\":1}");
        QTest::newRow("boolean") << QByteArray("{\"schema\":\"reverie.preview.data-format.v1\",\"formatVersion\":true}");
        QTest::newRow("fraction") << QByteArray("{\"schema\":\"reverie.preview.data-format.v1\",\"formatVersion\":1.5}");
        QTest::newRow("zero") << record(0);
        QTest::newRow("extra-key") << QByteArray("{\"schema\":\"reverie.preview.data-format.v1\",\"formatVersion\":1,\"extra\":0}");
    }
    void malformedRecordsFailClosed() {
        QFETCH(QByteArray, bytes);
        QTemporaryDir temporary; const auto workspace = root(temporary) + "/workspace";
        PreviewWorkspace::Session session(workspace);
        const auto file = workspace + "/data/" + PreviewDataFormat::FileName; save(file, bytes);
        QCOMPARE(rejected([&] { PreviewDataFormat::checkWorkspace(workspace); }), QString("PREVIEW_DATA_FORMAT_INVALID"));
        QCOMPARE(read(file), bytes);
    }
    void aliasesAreNotFormatRecords() {
        QTemporaryDir temporary; const auto workspace = root(temporary) + "/workspace";
        PreviewWorkspace::Session session(workspace);
        const auto file = workspace + "/data/" + PreviewDataFormat::FileName, source = workspace + "/data/source.json";
        save(source, record(1));
        QVERIFY(::link(QFile::encodeName(source).constData(), QFile::encodeName(file).constData()) == 0);
        QCOMPARE(rejected([&] { PreviewDataFormat::checkWorkspace(workspace); }), QString("PREVIEW_DATA_FORMAT_INVALID"));
        QVERIFY(QFile::remove(file));
        QVERIFY(::symlink("source.json", QFile::encodeName(file).constData()) == 0);
        QCOMPARE(rejected([&] { PreviewDataFormat::checkWorkspace(workspace); }), QString("PREVIEW_DATA_FORMAT_INVALID"));
        QCOMPARE(read(source), record(1));
    }
    void runtimeLegacyDefaultIsReadOnlyAndStrict() {
        QCOMPARE(PreviewDataFormat::supportedRuntimeValue(QJsonValue(QJsonValue::Undefined)), 1);
        QCOMPARE(PreviewDataFormat::supportedRuntimeValue(QJsonValue(2)), 2);
        QCOMPARE(rejected([] { PreviewDataFormat::supportedRuntimeValue(QJsonValue("1")); }), QString("PREVIEW_DATA_FORMAT_INVALID"));
    }
    void recoveryBackupAndStagingFormatsAreCheckedWithoutRenaming() {
        QTemporaryDir temporary; const auto workspace = root(temporary) + "/workspace";
        PreviewWorkspace::Session session(workspace);
        const auto original = workspace + "/data/" + PreviewDataFormat::FileName;
        save(original, record(2));
        QVERIFY(QDir(workspace).rename("data", ".restore-old-data-synthetic"));
        QVERIFY(QDir(workspace).mkdir(".restore-stage-synthetic"));
        QVERIFY(::chmod(QFile::encodeName(workspace + "/.restore-stage-synthetic").constData(), 0700) == 0);
        const auto stagedRecord = workspace + "/.restore-stage-synthetic/" + PreviewDataFormat::FileName;
        save(stagedRecord, record(1));
        const auto handle = PreviewPlatform::openRoot(workspace);
        auto backup = PreviewPlatform::openDirectory(handle, ".restore-old-data-synthetic", true);
        auto staged = PreviewPlatform::openDirectory(handle, ".restore-stage-synthetic", true);
        QCOMPARE(PreviewDataFormat::checkWorkspace(workspace), 1); // Canonical data is absent during the transaction.
        QCOMPARE(rejected([&] { PreviewDataFormat::checkDataDirectory(backup); }), QString("PREVIEW_DATA_FORMAT_TOO_NEW"));
        QCOMPARE(PreviewDataFormat::checkDataDirectory(staged), 1);
        QVERIFY(!QFileInfo::exists(workspace + "/data"));
        QCOMPARE(read(workspace + "/.restore-old-data-synthetic/" + PreviewDataFormat::FileName), record(2));
        QCOMPARE(read(stagedRecord), record(1));
    }
};
QTEST_GUILESS_MAIN(PreviewDataFormatTest)
#include "PreviewDataFormatTest.moc"
