#include "../src/PreviewPlatform.h"

#include <QFile>
#include <QFileInfo>
#include <QTemporaryDir>
#include <QTest>
#include <functional>
#include <sys/stat.h>
#include <unistd.h>

class PreviewPlatformTest final : public QObject {
    Q_OBJECT
    using Failure = PreviewPlatform::Failure;
    static QString root(const QTemporaryDir &temporary) {
        const auto value = QFileInfo(temporary.path()).canonicalFilePath();
        if (value.isEmpty()) throw std::runtime_error("fixture isolation unavailable"); return value;
    }
    static bool fails(const std::function<void()> &operation, Failure expected) {
        try { operation(); } catch (const PreviewPlatform::Error &error) { return error.reason == expected; } return false;
    }
    static void write(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        if (!file.open(QIODevice::WriteOnly) || file.write(bytes) != bytes.size() ||
            !file.setPermissions(QFileDevice::ReadOwner | QFileDevice::WriteOwner)) throw std::runtime_error("fixture write failed");
    }
private slots:
    void existingLockIsExclusiveAndItsInodeAndPidSurviveGuardRelease() {
        QTemporaryDir temporary; const auto workspace = root(temporary) + "/workspace";
        PreviewPlatform::Metadata identity;
        {
            PreviewPlatform::WorkspaceLock lock(workspace, PreviewPlatform::WorkspaceLock::OpenMode::Create);
            lock.writeDiagnosticPid(12345); identity = PreviewPlatform::inspectPath(workspace + "/workspace.lock");
            QVERIFY(fails([&] { PreviewPlatform::WorkspaceLock second(workspace); }, Failure::Busy));
        }
        const auto after = PreviewPlatform::inspectPath(workspace + "/workspace.lock");
        QVERIFY(PreviewPlatform::sameObject(identity, after));
        PreviewPlatform::WorkspaceLock reopened(workspace);
        QVERIFY(PreviewPlatform::sameObject(after, PreviewPlatform::inspectPath(workspace + "/workspace.lock")));
    }
    void existingOnlyNeverCreatesAMissingWorkspaceOrLock() {
        QTemporaryDir temporary; const auto parent = root(temporary);
        QVERIFY(fails([&] { PreviewPlatform::WorkspaceLock missing(parent + "/missing"); }, Failure::Invalid));
        QVERIFY(!QFileInfo::exists(parent + "/missing"));
        QVERIFY(fails([&] { PreviewPlatform::WorkspaceLock missingLock(parent); }, Failure::Invalid));
        QVERIFY(!QFileInfo::exists(parent + "/workspace.lock"));
    }
    void noFollowAndSingleLinkControlPolicyAreSeparateFromSourceContentPolicy() {
        QTemporaryDir temporary; const auto path = root(temporary);
        write(path + "/file", "source");
        QCOMPARE(::link(QFile::encodeName(path + "/file").constData(), QFile::encodeName(path + "/alias").constData()), 0);
        QCOMPARE(::symlink(QFile::encodeName(path + "/file").constData(), QFile::encodeName(path + "/symlink").constData()), 0);
        auto directory = PreviewPlatform::openRoot(path);
        QVERIFY(fails([&] { PreviewPlatform::openRegular(directory, "file"); }, Failure::SpecialFile));
        auto source = PreviewPlatform::openRegular(directory, "file", false, true);
        QCOMPARE(PreviewPlatform::metadata(source).links, quint64(2));
        QVERIFY(fails([&] { PreviewPlatform::openRegular(directory, "symlink", false, true); }, Failure::SpecialFile));
        QVERIFY(fails([&] { PreviewPlatform::openDirectory(directory, "symlink"); }, Failure::SpecialFile));
        QCOMPARE(PreviewPlatform::inspect(directory, "symlink").kind, PreviewPlatform::Kind::Link);
    }
    void exclusivePublicationDoesNotReplaceACollisionAndMovesAcrossOwnedDirectories() {
        QTemporaryDir temporary; const auto path = root(temporary); auto directory = PreviewPlatform::openRoot(path);
        PreviewPlatform::createDirectory(directory, "source"); PreviewPlatform::createDirectory(directory, "target");
        const auto sourceIdentity = PreviewPlatform::inspect(directory, "source");
        QVERIFY(fails([&] { PreviewPlatform::renameNoReplace(directory, "source", "target"); }, Failure::Io));
        QVERIFY(PreviewPlatform::sameObject(sourceIdentity, PreviewPlatform::inspect(directory, "source")));
        auto target = PreviewPlatform::openDirectory(directory, "target", true);
        PreviewPlatform::moveNoReplace(directory, "source", target, "nested");
        QCOMPARE(PreviewPlatform::inspect(directory, "source").kind, PreviewPlatform::Kind::Missing);
        QVERIFY(PreviewPlatform::sameObject(sourceIdentity, PreviewPlatform::inspect(target, "nested")));
        PreviewPlatform::flush(target); PreviewPlatform::flush(directory);
    }
    void privateExclusiveFilesAndBoundedSortedEnumerationKeepTheirContracts() {
        QTemporaryDir temporary; auto directory = PreviewPlatform::openRoot(root(temporary));
        { auto b = PreviewPlatform::createFile(directory, "b"); QCOMPARE(PreviewPlatform::writeNative(b.nativeDescriptor(), "bytes", 5), qint64(5)); PreviewPlatform::flush(b); }
        { auto a = PreviewPlatform::createFile(directory, "a"); PreviewPlatform::flush(a); }
        QCOMPARE(PreviewPlatform::inspect(directory, "b").permissions, quint32(0600));
        QCOMPARE(PreviewPlatform::children(directory), QList<QByteArray>({"a", "b"}));
        QVERIFY(fails([&] { PreviewPlatform::children(directory, 1); }, Failure::Limit));
        QVERIFY(fails([&] { PreviewPlatform::createFile(directory, "b"); }, Failure::Io));
        auto file = PreviewPlatform::openRegular(directory, "b"); char bytes[5]{};
        QCOMPARE(PreviewPlatform::read(file, bytes, 5), qint64(5)); QCOMPARE(QByteArray(bytes, 5), QByteArray("bytes"));
    }
};
QTEST_GUILESS_MAIN(PreviewPlatformTest)
#include "PreviewPlatformTest.moc"
