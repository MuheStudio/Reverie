#include "PreviewWorkspace.h"
#include "PreviewPlatform.h"
#include "PreviewDataFormat.h"

#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDir>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QRegularExpression>
#include <QSet>

namespace PreviewWorkspace {
namespace {
QString optionName(const QString &argument) {
    return argument.section('=', 0, 0);
}
bool canonicalAbsolute(const QString &path) {
    return PreviewPlatform::canonicalAbsolute(path);
}
QByteArray readRecord(const QString &path, qint64 maximum, bool privateFile) {
    auto parent = PreviewPlatform::openRoot(QFileInfo(path).absolutePath(), false);
    const auto name = QFileInfo(path).fileName().toUtf8();
    const auto before = PreviewPlatform::inspect(parent, name);
    if (before.kind != PreviewPlatform::Kind::Regular || !before.owned || before.links != 1 ||
        before.bytes == 0 || before.bytes > quint64(maximum) || (privateFile && before.permissions != 0600))
        throw PreviewPlatform::Error(PreviewPlatform::Failure::Invalid);
    auto file = PreviewPlatform::openRegular(parent, name, privateFile);
    if (!PreviewPlatform::unchanged(before, PreviewPlatform::metadata(file)))
        throw PreviewPlatform::Error(PreviewPlatform::Failure::Changed);
    QByteArray result; char block[4096];
    for (;;) {
        const auto count = PreviewPlatform::read(file, block, sizeof block);
        if (count == 0) break;
        if (count < 0 || result.size() + count > maximum)
            throw PreviewPlatform::Error(PreviewPlatform::Failure::Invalid);
        result.append(block, count);
    }
    if (!PreviewPlatform::unchanged(before, PreviewPlatform::metadata(file)) ||
        !PreviewPlatform::unchanged(before, PreviewPlatform::inspect(parent, name)))
        throw PreviewPlatform::Error(PreviewPlatform::Failure::Changed);
    return result;
}
} // namespace

QString RuntimeInfo::title() const {
    return QString("Reverie 预览 · %1 · %2").arg(candidate, sourceHead.left(8));
}
bool requested(const QStringList &arguments) {
    for (const auto &argument : arguments)
        if (optionName(argument) == "--workspace") return true;
    return false;
}
QStringList forbiddenOptions() {
    return {"--context", "--data-dir", "--test-report", "--test-model", "--test-endpoint",
        "--test-endpoint-b", "--test-cycle", "--test-suite", "--perf-report", "--perf-rows",
        "--perf-mode", "--perf-protocol", "--perf-fixture-report", "--profiler-port", "--diagnostic-case",
        "--demo-mode", "--record-ui", "--record-demo", "--p1-restore", "--p1-persona",
        "--p1-settings", "--p1-provider", "--p1-onboarding", "--p1-memory", "--candidate-paging",
        "--p1-profile", "--p1-worldbook-entry", "--p1-worldbook-injection", "--p1-worldbook-regex",
        "--p0-tail", "--remove-test-key", "--perf-seed", "--diagnostic-control-fd4",
        "--metacall-context", "--transition-diagnostics", "--remove-preview-test-key"};
}
bool argumentConflict(const QStringList &arguments) {
    if (!requested(arguments)) return false;
    const QSet<QString> allowed{"--workspace", "--project-root", "--python"};
    QSet<QString> seen;
    for (qsizetype i = 0; i < arguments.size(); ++i) {
        const QString name = optionName(arguments[i]);
        if (!allowed.contains(name) || seen.contains(name)) return true;
        seen.insert(name);
        QString value;
        if (arguments[i].contains('=')) value = arguments[i].mid(arguments[i].indexOf('=') + 1);
        else if (++i < arguments.size()) value = arguments[i];
        if (value.isEmpty() || value.startsWith('-')) return true;
    }
    return seen != allowed;
}
bool cleanupRequested(const QStringList &arguments) {
    for (const auto &argument : arguments)
        if (optionName(argument) == "--remove-preview-test-key") return true;
    return false;
}
bool cleanupArgumentConflict(const QStringList &arguments) {
    if (!cleanupRequested(arguments)) return false;
    const QSet<QString> allowed{"--remove-preview-test-key", "--context", "--data-dir"};
    QSet<QString> seen;
    for (qsizetype i = 0; i < arguments.size(); ++i) {
        const QString name = optionName(arguments[i]);
        if (!allowed.contains(name) || seen.contains(name)) return true;
        seen.insert(name);
        if (name == "--remove-preview-test-key") {
            if (arguments[i] != name) return true;
            continue;
        }
        QString value;
        if (arguments[i].contains('=')) value = arguments[i].mid(arguments[i].indexOf('=') + 1);
        else if (++i < arguments.size()) value = arguments[i];
        if (value.isEmpty() || value.startsWith('-')) return true;
    }
    return seen != allowed;
}

struct CleanupTarget::Guard {
    std::unique_ptr<PreviewPlatform::WorkspaceLock> lock;
};
CleanupTarget::CleanupTarget(QString workspace, std::unique_ptr<Guard> guard)
    : m_workspace(std::move(workspace)), m_guard(std::move(guard)) {}
CleanupTarget::CleanupTarget(CleanupTarget &&) noexcept = default;
CleanupTarget::~CleanupTarget() = default;
void CleanupTarget::validateDirectory(const QString &path, quint64 owner) {
    try { PreviewPlatform::validatePrivateDirectory(path, owner); }
    catch (const PreviewPlatform::Error &) {
        throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_DIRECTORY_INVALID");
    }
}
CleanupTarget validateTestCleanupContext(const QString &contextFile, const QString &data) {
    // Bind the context to the current disposable runner before following any
    // path supplied by its JSON. Ordinary preview workspaces have no such gate.
    const QString environmentData = qEnvironmentVariable("REVERIE_DATA_DIR");
    const QString root = QFileInfo(environmentData).absolutePath();
    QString temporary = qEnvironmentVariable("TMPDIR");
    while (temporary.size() > 1 && temporary.endsWith('/')) temporary.chop(1);
    if (!canonicalAbsolute(environmentData) || data != environmentData || data != root + "/data" ||
        !QFileInfo(root).fileName().startsWith("reverie-local-") || temporary != root + "/tmp" ||
        !canonicalAbsolute(contextFile) || !contextFile.startsWith(root + '/'))
        throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_ISOLATION_BINDING_INVALID");
    CleanupTarget::validateDirectory(root, PreviewPlatform::currentOwner());
    CleanupTarget::validateDirectory(data, PreviewPlatform::currentOwner());
    CleanupTarget::validateDirectory(temporary, PreviewPlatform::currentOwner());
    const auto validateDescendant = [&](const QString &path) {
        if (!canonicalAbsolute(path) || !path.startsWith(root + '/'))
            throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_PATH_OUTSIDE_ISOLATION");
        QString current = root;
        for (const auto &component : path.mid(root.size() + 1).split('/')) {
            current += '/' + component;
            CleanupTarget::validateDirectory(current, PreviewPlatform::currentOwner());
        }
    };
    if (QFileInfo(contextFile).absolutePath() != root)
        validateDescendant(QFileInfo(contextFile).absolutePath());
    QByteArray contextBytes;
    try { contextBytes = readRecord(contextFile, 16384, true); }
    catch (const PreviewPlatform::Error &) { throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_CONTEXT_INVALID"); }
    QJsonParseError parseError;
    const auto document = QJsonDocument::fromJson(contextBytes, &parseError);
    const auto object = document.object();
    if (parseError.error != QJsonParseError::NoError || !document.isObject() ||
        object["schema"] != "reverie.qt.isolation.v1" ||
        object["purpose"] != "reverie.qt.preview-test-cleanup.v1" ||
        object["root"].toObject()["path"] != root || object["data"].toObject()["path"] != data)
        throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_CONTEXT_SCOPE_INVALID");
    const QString workspace = object["previewWorkspace"].toObject()["path"].toString();
    if (workspace == data || workspace.startsWith(data + '/') || workspace == temporary || workspace.startsWith(temporary + '/'))
        throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_WORKSPACE_INVALID");
    validateDescendant(workspace);
    const auto verifyIdentities = [&] {
        for (const auto *key : {"root", "data", "previewWorkspace"}) {
            const auto expected = object[key].toObject();
            const QString path = expected["path"].toString();
            CleanupTarget::validateDirectory(path, PreviewPlatform::currentOwner());
            const auto status = PreviewPlatform::inspectPath(path);
            if (expected["device"] != QString::number(status.volume) ||
                expected["inode"] != QString::number(status.object))
                throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_DIRECTORY_REPLACED");
        }
    };
    verifyIdentities();
    auto guard = std::make_unique<CleanupTarget::Guard>();
    try { guard->lock = std::make_unique<PreviewPlatform::WorkspaceLock>(workspace); }
    catch (const PreviewPlatform::Error &) { throw Error(CleanupScopeRejected, "PREVIEW_CLEANUP_WORKSPACE_LOCK_UNAVAILABLE"); }
    // No creation, chmod, truncation or PID write occurs on the cleanup path.
    verifyIdentities();
    return CleanupTarget(workspace, std::move(guard));
}
RuntimeInfo readRuntime(const QString &root, const QString &python) {
    try { auto directory = PreviewPlatform::openRoot(root, false); }
    catch (const PreviewPlatform::Error &) { throw Error(InvalidRuntime, "PREVIEW_RUNTIME_ROOT_INVALID"); }
    QByteArray bytes;
    try { bytes = readRecord(root + "/preview-runtime.json", 65536, false); }
    catch (const PreviewPlatform::Error &) { throw Error(InvalidRuntime, "PREVIEW_RUNTIME_METADATA_INVALID"); }
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(bytes, &error);
    const auto object = document.object();
    const QString candidate = object["candidate"].toString(), source = object["sourceHead"].toString();
    static const QRegularExpression candidatePattern("^[A-Za-z0-9._-]{1,128}$");
    static const QRegularExpression sourcePattern("^[0-9a-f]{40}$");
    if (error.error != QJsonParseError::NoError || !document.isObject() ||
        object["schema"] != "reverie.qt.preview-runtime.v1" ||
        !candidatePattern.match(candidate).hasMatch() || !sourcePattern.match(source).hasMatch())
        throw Error(InvalidRuntime, "PREVIEW_RUNTIME_METADATA_INVALID");
    const QFileInfo interpreter(python);
    if (!QDir::isAbsolutePath(python) || !interpreter.isFile() || !interpreter.isExecutable() ||
        !interpreter.canonicalFilePath().startsWith(root + "/.tools/python/"))
        throw Error(InvalidRuntime, "PREVIEW_RUNTIME_PYTHON_INVALID");
    // Older W1 metadata readers did not require this field. Preserve their
    // read contract; a snapshot Manager requires the real digest before start.
    const QString build = object["buildManifestSha256"].toString();
    if (object.contains("buildManifestSha256") &&
        !QRegularExpression("^[0-9a-f]{64}$").match(build).hasMatch())
        throw Error(InvalidRuntime, "PREVIEW_RUNTIME_METADATA_INVALID");
    int supported = 1;
    try { supported = PreviewDataFormat::supportedRuntimeValue(object["supportedDataFormat"]); }
    catch (const PreviewDataFormat::Error &) { throw Error(InvalidRuntime, "PREVIEW_RUNTIME_DATA_FORMAT_INVALID"); }
    return {root, candidate, source, build, supported};
}

void Session::validateOwnedDirectory(const QString &path, quint64 owner) {
    try { PreviewPlatform::validatePrivateDirectory(path, owner); }
    catch (const PreviewPlatform::Error &) { throw Error(InvalidWorkspace, "PREVIEW_WORKSPACE_OWNER_MODE_OR_PATH_INVALID"); }
}
struct Session::Lock {
    std::unique_ptr<PreviewPlatform::WorkspaceLock> platform;
};
Session::Session(const QString &workspace, Initialization initialization) : m_root(workspace) {
    try {
        m_lock = std::make_unique<Lock>();
        m_lock->platform = std::make_unique<PreviewPlatform::WorkspaceLock>(workspace,
            PreviewPlatform::WorkspaceLock::OpenMode::Create);
        m_lock->platform->writeDiagnosticPid(QCoreApplication::applicationPid());
        if (initialization == Initialization::ReadyDirectories) initializeDirectories();
    } catch (const PreviewPlatform::Error &error) {
        if (error.reason == PreviewPlatform::Failure::Busy)
            throw Error(AlreadyRunning, "这个预览工作区已在运行，请切回现有窗口。");
        throw Error(InvalidWorkspace, "PREVIEW_WORKSPACE_OWNER_MODE_OR_PATH_INVALID");
    }
}
void Session::initializeDirectories() {
    try {
        PreviewPlatform::validatePrivateDirectory(m_root, PreviewPlatform::currentOwner());
        for (const auto *child : {"data", "avatars", "qml-cache", "logs"})
            PreviewPlatform::ensurePrivateDirectory(m_root + '/' + child);
    } catch (const PreviewPlatform::Error &) {
        throw Error(InvalidWorkspace, "PREVIEW_WORKSPACE_CHILD_INVALID");
    }
}
Session::~Session() = default;
QString Session::id() const {
    return QString::fromLatin1(QCryptographicHash::hash(m_root.toUtf8(), QCryptographicHash::Sha256).toHex());
}

QByteArray readyLine(const RuntimeInfo &runtime, const QString &workspaceId, qint64 hostPid,
                     const QVariantMap &status) {
    const qint64 backendPid = status.value("backendPid").toLongLong();
    const QString recovery = status.value("recoveryState").toString();
    static const QRegularExpression identifier("^[0-9a-f]{64}$");
    if (hostPid <= 1 || backendPid <= 1 || hostPid == backendPid || !identifier.match(workspaceId).hasMatch() ||
        status.value("runtimeWritable").metaType().id() != QMetaType::Bool ||
        !status.value("runtimeWritable").toBool() || recovery != "clean") return {};
    const QJsonObject object{{"schema", "reverie.qt.preview.ready.v1"}, {"hostPid", hostPid},
        {"backendPid", backendPid}, {"workspaceId", workspaceId}, {"sourceHead", runtime.sourceHead},
        {"candidate", runtime.candidate}, {"recoveryState", recovery},
        {"runtimeWritable", status.value("runtimeWritable").toBool()}};
    return "REVERIE_PREVIEW_READY " + QJsonDocument(object).toJson(QJsonDocument::Compact) + '\n';
}

struct Termination::Impl {
    std::unique_ptr<PreviewPlatform::Termination> platform;
};
Termination::Termination(QObject *context, std::function<void()> closeWindow)
    : QObject(context), m_impl(std::make_unique<Impl>()) {
    try { m_impl->platform = std::make_unique<PreviewPlatform::Termination>(this, std::move(closeWindow)); }
    catch (const PreviewPlatform::Error &) { throw Error(InvalidRuntime, "PREVIEW_SIGNAL_PIPE_FAILED"); }
}
Termination::~Termination() = default;
} // namespace PreviewWorkspace
