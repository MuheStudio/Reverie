#include "../src/Keychain.h"
#include "../src/StorageKeyChannel.h"

// Only this fixture helper uses the existing preview cleanup machinery.
#include "../src/PreviewWorkspace.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QSet>
#include <QTemporaryDir>
#include <QTest>
#include <cerrno>
#include <cstdio>
#include <cstdlib>
#include <fcntl.h>
#include <optional>
#include <stdexcept>
#include <sys/stat.h>
#include <unistd.h>

namespace Fixture {
void require(bool value, const char *code) {
    if (!value) throw std::runtime_error(code);
}
void expectMissingStorageKeyTwice(const QString &root, KeychainDomain domain) {
    for (int attempt = 0; attempt < 2; ++attempt) {
        bool rejected = false;
        try { auto unexpected = storageKeyFor(root, domain); unexpected.fill(0); }
        catch (const std::runtime_error &error) { rejected = QByteArray(error.what()) == "KEY_MISSING_EXISTING_DATABASE"; }
        require(rejected, attempt == 0 ? "PLATFORM_CONTRACT_MISSING_KEY_FIRST_READ" : "PLATFORM_CONTRACT_MISSING_KEY_SECOND_READ");
    }
}
void write(const QString &path, const QByteArray &bytes) {
    QFile file(path);
    require(file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size(), "FIXTURE_WRITE_FAILED");
    require(file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner), "FIXTURE_PERMISSION_FAILED");
}
QByteArray read(const QString &path) {
    QFile file(path);
    require(file.open(QIODevice::ReadOnly), "FIXTURE_READ_FAILED");
    return file.readAll();
}
QJsonObject identity(const QString &path) {
    struct stat s{};
    require(::lstat(QFile::encodeName(path).constData(), &s) == 0 && S_ISDIR(s.st_mode), "FIXTURE_IDENTITY_FAILED");
    return {{"path", path}, {"device", QString::number(s.st_dev)}, {"inode", QString::number(s.st_ino)}};
}
class Environment final {
    QByteArray data = qgetenv("REVERIE_DATA_DIR"), temporary = qgetenv("TMPDIR");
    bool hadData = qEnvironmentVariableIsSet("REVERIE_DATA_DIR"), hadTemporary = qEnvironmentVariableIsSet("TMPDIR");
public:
    explicit Environment(const QString &root) {
        qputenv("REVERIE_DATA_DIR", (root + "/data").toUtf8());
        qputenv("TMPDIR", (root + "/tmp/").toUtf8());
    }
    ~Environment() {
        if (hadData) qputenv("REVERIE_DATA_DIR", data); else qunsetenv("REVERIE_DATA_DIR");
        if (hadTemporary) qputenv("TMPDIR", temporary); else qunsetenv("TMPDIR");
    }
};
class Account final {
    QTemporaryDir temporary{QDir::tempPath() + "/reverie-local-platform-contract-XXXXXX"};
    std::optional<PreviewWorkspace::CleanupTarget> target;
    bool finished = false;
    QString root;
    bool absent(const QString &service) const {
        const auto account = QString::fromLatin1(QCryptographicHash::hash(root.toUtf8(), QCryptographicHash::Sha256).toHex());
        QProcess query;
        query.start("/usr/bin/security", {"find-generic-password", "-s", service, "-a", account});
        const bool done = query.waitForFinished(5000);
        // Never request -w/-g and never forward the tool output.
        query.readAllStandardOutput(); query.readAllStandardError();
        return done && query.exitStatus() == QProcess::NormalExit && query.exitCode() == 44;
    }
    bool eraseAndCheck() {
        try {
            removeTestStorageKey(root);
            removeTestProviderKey(root);
            if (target) removePreviewTestKeys(*target);
            for (const auto domain : {KeychainDomain::Local, KeychainDomain::Preview})
                if (!absent(storageKeychainService(domain)) || !absent(providerKeychainService(domain))) return false;
            return true;
        } catch (...) { return false; }
    }
public:
    explicit Account(bool preview = false) {
        require(temporary.isValid(), "FIXTURE_TEMPORARY_ROOT_FAILED");
        root = QFileInfo(temporary.path()).canonicalFilePath();
        if (preview) {
            for (const auto &path : {root + "/data", root + "/tmp"}) {
                require(QDir().mkdir(path) && ::chmod(QFile::encodeName(path), 0700) == 0, "FIXTURE_DIRECTORY_FAILED");
            }
            const QString workspace = root + "/preview-workspace";
            { PreviewWorkspace::Session session(workspace); }
            const QString context = root + "/cleanup-context.json";
            write(context, QJsonDocument(QJsonObject{{"schema", "reverie.qt.isolation.v1"},
                {"purpose", "reverie.qt.preview-test-cleanup.v1"}, {"root", identity(root)},
                {"data", identity(root + "/data")}, {"previewWorkspace", identity(workspace)}}).toJson());
            {
                Environment environment(root);
                target.emplace(PreviewWorkspace::validateTestCleanupContext(context, root + "/data"));
            }
            // Creation and deletion must use this exact path string.
            root = target->workspace();
        }
    }
    const QString &path() const { return root; }
    void erase() {
        try {
            removeTestStorageKey(root);
            removeTestProviderKey(root);
            if (target) removePreviewTestKeys(*target);
        } catch (...) {
            finished = true;
            throw;
        }
    }
    void finish() {
        require(!finished, "FIXTURE_CLEANUP_ALREADY_FINISHED");
        // Do not retry a failed delete. The destructor only cleans an unfinished test.
        finished = true;
        require(eraseAndCheck(), "PLATFORM_CONTRACT_CLEANUP_FAILED_OR_RESIDUAL");
    }
    ~Account() {
        if (!finished && !eraseAndCheck()) {
            std::fputs("PLATFORM_CONTRACT_CLEANUP_FAILED_OR_RESIDUAL\n", stderr);
            std::abort();
        }
    }
};
QSet<int> descriptors() {
    QSet<int> result;
    const auto names = QDir("/dev/fd").entryList(QDir::Files | QDir::System | QDir::NoDotAndDotDot);
    for (const auto &name : names) {
        bool ok = false; const int descriptor = name.toInt(&ok);
        if (ok && ::fcntl(descriptor, F_GETFD) != -1) result.insert(descriptor);
    }
    return result;
}
bool allClosed(const QSet<int> &values) {
    for (const int descriptor : values)
        if (::fcntl(descriptor, F_GETFD) != -1 || errno != EBADF) return false;
    return true;
}
QByteArray syntheticKey(int slot) { return QByteArray(32, char('K' + slot)); }
int child(const QStringList &arguments) {
    bool slotOk = false; const int slot = arguments.value(2).toInt(&slotOk);
    if (!slotOk || slot < 0 || slot > 1 || qgetenv("REVERIE_STORAGE_KEY_FD") != "3") return 10;
    const auto expected = syntheticKey(slot);
    const auto environment = QProcessEnvironment::systemEnvironment().toStringList().join('\n').toUtf8();
    if (arguments.join('\n').toUtf8().contains(expected) || environment.contains(expected)) return 11;
    QFile input;
    if (!input.open(3, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) return 12;
    auto bytes = input.read(33);
    const bool matched = bytes.size() == 32 && bytes == expected && input.read(1).isEmpty() && input.atEnd();
    input.close(); bytes.fill(0);
    if (!matched) return 13;
    std::fputs("{\"receivedBytes\":32,\"matched\":true,\"eof\":true,\"argvClean\":true,\"environmentClean\":true}\n", stdout);
    return 0;
}
void prepareChild(QProcess &process, int slot) {
    auto environment = QProcessEnvironment::systemEnvironment();
    environment.insert("REVERIE_STORAGE_KEY_FD", "3");
    process.setProcessEnvironment(environment);
    process.setProgram(QCoreApplication::applicationFilePath());
    process.setArguments({"--storage-key-channel-child", QString::number(slot)});
}
bool completed(QProcess &process) {
    if ((process.state() != QProcess::NotRunning && !process.waitForFinished(5000)) ||
        process.exitStatus() != QProcess::NormalExit || process.exitCode() != 0) return false;
    const auto result = QJsonDocument::fromJson(process.readAllStandardOutput()).object();
    return process.readAllStandardError().isEmpty() && result["receivedBytes"] == 32 && result["matched"] == true &&
        result["eof"] == true && result["argvClean"] == true && result["environmentClean"] == true;
}
} // namespace Fixture

class PlatformContractTest final : public QObject {
    Q_OBJECT
private slots:
    void newStorageKeyHasExactLengthAndSameRootReadsSameKey() {
        Fixture::Account account;
        auto first = storageKeyFor(account.path()), again = storageKeyFor(account.path());
        QVERIFY(first.size() == 32 && again == first);
        first.fill(0); again.fill(0);
        account.finish();
    }
    void storageRootsAndDomainsRemainIndependent() {
        Fixture::Account first(true), second(true);
        auto a = storageKeyFor(first.path(), KeychainDomain::Local);
        auto b = storageKeyFor(first.path(), KeychainDomain::Preview);
        auto c = storageKeyFor(second.path(), KeychainDomain::Local);
        auto d = storageKeyFor(second.path(), KeychainDomain::Preview);
        QVERIFY(a.size() == 32 && b.size() == 32 && c.size() == 32 && d.size() == 32);
        QVERIFY(a != b && a != c && a != d && b != c && b != d && c != d);
        a.fill(0); b.fill(0); c.fill(0); d.fill(0);
        first.erase(); second.erase();
        for (auto *account : {&first, &second}) {
            Fixture::write(account->path() + "/deletion-proof.db", "unchanged database canary");
            for (const auto domain : {KeychainDomain::Local, KeychainDomain::Preview}) {
                Fixture::expectMissingStorageKeyTwice(account->path(), domain);
            }
            account->finish();
        }
    }
    void existingDatabaseWithoutKeyNeverCreatesReplacement_data() {
        QTest::addColumn<QString>("name");
        QTest::newRow("sqlite") << QString("existing.sqlite");
        QTest::newRow("db") << QString("existing.db");
    }
    void existingDatabaseWithoutKeyNeverCreatesReplacement() {
        QFETCH(QString, name);
        Fixture::Account account;
        const QByteArray original("existing database bytes");
        Fixture::write(account.path() + '/' + name, original);
        Fixture::expectMissingStorageKeyTwice(account.path(), KeychainDomain::Local);
        QVERIFY(Fixture::read(account.path() + '/' + name) == original);
        account.finish();
    }
    void providerRecordRoundTripsAndRepeatedClearIsSafe() {
        Fixture::Account account;
        auto store = keychainProviderKeyStore(account.path());
        QVERIFY(!store->read());
        StoredProviderKey expected{providerKeyBinding("ollama", "http://127.0.0.1:11999/v1"), "synthetic-provider-canary", "synthetic-write"};
        store->write(expected);
        const auto actual = store->read();
        QVERIFY(actual && actual->binding == expected.binding && actual->apiKey == expected.apiKey && actual->writeId == expected.writeId);
        store->clear(); store->clear();
        QVERIFY(!store->read());
        account.finish();
    }
    void childReceivesExactlyOneKeyEofAndNoArgvOrEnvironmentKey() {
        QProcess process; Fixture::prepareChild(process, 0);
        StorageKeyChannel channel("PLATFORM_CONTRACT_PIPE_FAILED");
        channel.configureChild(process); process.start();
        auto key = Fixture::syntheticKey(0);
        const auto count = channel.sendAndClose(key); key.fill(0);
        QCOMPARE(count, qint64(32));
        QVERIFY(Fixture::completed(process));
    }
    void twoChannelsNeverExchangeKeys() {
        QProcess first, second;
        Fixture::prepareChild(first, 0); Fixture::prepareChild(second, 1);
        StorageKeyChannel a("PLATFORM_CONTRACT_PIPE_FAILED");
        a.configureChild(first); first.start();
        auto firstKey = Fixture::syntheticKey(0), secondKey = Fixture::syntheticKey(1);
        const auto ca = a.sendAndClose(firstKey);
        StorageKeyChannel b("PLATFORM_CONTRACT_PIPE_FAILED");
        b.configureChild(second); second.start();
        const auto cb = b.sendAndClose(secondKey);
        firstKey.fill(0); secondKey.fill(0);
        QCOMPARE(ca, qint64(32)); QCOMPARE(cb, qint64(32));
        QVERIFY(Fixture::completed(first)); QVERIFY(Fixture::completed(second));
    }
    void failedProcessStartIsReportedAndChannelDestructionClosesBothEnds() {
        QTemporaryDir root; QProcess process;
        const auto before = Fixture::descriptors(); QSet<int> endpoints;
        {
            StorageKeyChannel channel("PLATFORM_CONTRACT_PIPE_FAILED");
            endpoints = Fixture::descriptors() - before;
            QCOMPARE(endpoints.size(), 2);
            channel.configureChild(process);
            process.start(root.filePath("missing-executable"), {});
            QVERIFY(!process.waitForStarted(5000));
            QCOMPARE(process.error(), QProcess::FailedToStart);
        }
        QVERIFY(Fixture::allClosed(endpoints));
    }
};

int main(int argc, char **argv) {
    QCoreApplication app(argc, argv);
    if (app.arguments().value(1) == "--storage-key-channel-child") return Fixture::child(app.arguments());
    PlatformContractTest test;
    return QTest::qExec(&test, argc, argv);
}
#include "PlatformContractTest.moc"
