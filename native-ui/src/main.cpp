#include "WindowInputState.h"
#include "../tests/ArchiveInteractionCheck.h"
#include "../tests/PersonaProfileEditCheck.h"
#include "../tests/WorldbookPriorityCheck.h"
#include "../tests/WorldbookBookSettingsCheck.h"
#include "../tests/WorldbookEntrySettingsCheck.h"
#include "../tests/WorldbookRegexCheck.h"
#include "../tests/WorldbookInjectionCheck.h"
#include "../tests/MoonroomInteractionCheck.h"
#include "../tests/SceneSurfaceCheck.h"
#include "PreviewWorkspace.h"
#include "PreviewSnapshot.h"
#include "PreviewRestore.h"
#include "PreviewDataFormat.h"
#include "PreviewEvents.h"
#include "../tests/PreviewUpgradeCheck.h"
#include "../tests/SettingsSectionsCheck.h"
#include "../tests/ProviderCredentialCheck.h"
#include "../tests/OnboardingCheck.h"
#include "../tests/MemoryPageCheck.h"
#include "../tests/MemoryBatchDeleteCheck.h"
#include "../tests/MemoryRecallCheck.h"
#include "../tests/MemoryCandidatePageCheck.h"
#include "../tests/SummaryViewCheck.h"
#include "../tests/MemoryBatchPinCheck.h"
#include "../tests/MemoryCandidateBatchCheck.h"
#include "../tests/ProfileClearCheck.h"
#include "../tests/SupplementaryFunctionCheck.h"
#include "../tests/P0TailCheck.h"
#include "../tests/ControlReadiness.h"
#include "../tests/PerfBootstrap.h"
#include "../tests/PerfScenarioCheck.h"
#include "PerfDiagnostics.h"
#include "TimingTrace.h"
#include "TransitionDiagnostics.h"
#include "ArchiveEditor.h"
#include "Keychain.h"
#include "StorageKeyChannel.h"
#include "NativeAvatar.h"
#include "RuntimeBridge.h"
#include "WindowRecorder.h"
#include <QCommandLineParser>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QMap>
#include <QSet>
#include <QQmlApplicationEngine>
#include <QQmlContext>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSaveFile>
#include <QSurfaceFormat>
#include <QTest>
#include <QTimer>
#include <QProcess>
#include <QProcessEnvironment>
#ifdef REVERIE_QML_PROFILER
#include <QQmlDebuggingEnabler>
#endif
#include <fcntl.h>
#include <algorithm>
#include <cstdio>
#include <memory>
#include <vector>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>
static void verifyContext(const QString &file, const QString &data) {
    QFile f(file);
    if (!f.open(QIODevice::ReadOnly) || f.size() > 16384)
        throw std::runtime_error("ISOLATION_CONTEXT_REQUIRED");
    auto o = QJsonDocument::fromJson(f.readAll()).object();
    if (o["schema"] != "reverie.qt.isolation.v1" || o["data"].toObject()["path"] != data)
        throw std::runtime_error("ISOLATION_CONTEXT_INVALID");
    for (auto key : {"root", "data"}) {
        auto expected = o[key].toObject();
        auto p = expected["path"].toString();
        struct stat s{};
        if (lstat(p.toUtf8(), &s) || !S_ISDIR(s.st_mode) || s.st_uid != getuid() ||
            QFileInfo(p).canonicalFilePath() != p ||
            QString::number(s.st_dev) != expected["device"] ||
            QString::number(s.st_ino) != expected["inode"])
            throw std::runtime_error("ISOLATION_DIRECTORY_REPLACED");
    }
}
static QQuickItem *visualItem(QQuickItem *root, const QString &name) {
    if (root->objectName() == name && root->isVisible())
        return root;
    for (auto *child : root->childItems())
        if (auto *found = visualItem(child, name))
            return found;
    return nullptr;
}
static int seedPerformanceFixture(const QCommandLineParser &args) {
    const auto root=args.value("project-root"),data=args.value("data-dir"),python=args.value("python");
    const int rows=args.value("perf-rows").toInt();
    if ((rows!=9 && rows!=100 && rows!=300) || !QFileInfo(python).isExecutable() ||
        !QFileInfo(python).canonicalFilePath().startsWith(root+"/.tools/python/") ||
        !QFileInfo(args.value("perf-fixture-report")).isAbsolute())
        throw std::runtime_error("PERF_FIXTURE_ARGUMENTS_INVALID");
    auto key=storageKeyFor(data);StorageKeyChannel keyChannel("PERF_FIXTURE_PIPE_FAILED");
    QProcess process;auto env=QProcessEnvironment::systemEnvironment();
    for(const auto &name:{"PYTHONPATH","PYTHONHOME","REVERIE_STORAGE_KEY","REVERIE_MASTER_KEY"}) env.remove(name);
    env.insert("PYTHONNOUSERSITE","1");env.insert("PYTHONDONTWRITEBYTECODE","1");env.insert("PYTHON_DOTENV_DISABLED","1");
    env.insert("REVERIE_REQUIRE_ENCRYPTED_STORAGE","1");env.insert("REVERIE_STORAGE_KEY_FD","3");env.insert("REVERIE_DATA_DIR",data+"/data");
    process.setWorkingDirectory(root);process.setProcessEnvironment(env);
    keyChannel.configureChild(process);
    process.start(python,{root+"/native-ui/perf-fixtures.py","--data-dir",data,"--rows",QString::number(rows),
        "--context",args.value("context"),"--report",args.value("perf-fixture-report")});
    const auto count=keyChannel.sendAndClose(key);key.fill(0);
    if(count!=32 || !process.waitForFinished(60000) || process.exitStatus()!=QProcess::NormalExit || process.exitCode()!=0) {
        if(process.state()!=QProcess::NotRunning){process.kill();process.waitForFinished(2000);}
        qWarning().noquote()<<QString::fromUtf8(process.readAllStandardError()).left(4096);
        throw std::runtime_error("PERF_FIXTURE_PROCESS_FAILED");
    }
    return 0;
}
static bool workspaceControlRequested(const QStringList &arguments) {
    for (const auto &argument : arguments)
        if (argument.section('=', 0, 0) == "--preview-workspace-control") return true;
    return false;
}
static int workspaceControl(int argc, char **argv, const QStringList &arguments) {
    // This is a separate headless production maintenance entry. It never
    // accepts --workspace or test flags, and never constructs RuntimeBridge.
    QCoreApplication controlApp(argc, argv);
    const QSet<QString> allowed{"--preview-workspace-control", "--workspace-path", "--project-root", "--python", "--snapshot"};
    QMap<QString, QString> values;
    for (qsizetype index = 0; index < arguments.size(); ++index) {
        const auto name = arguments[index].section('=', 0, 0);
        if (!allowed.contains(name) || values.contains(name)) return PreviewWorkspace::ArgumentConflict;
        QString value;
        if (arguments[index].contains('=')) value = arguments[index].mid(arguments[index].indexOf('=') + 1);
        else if (++index < arguments.size()) value = arguments[index];
        if (value.isEmpty() || value.startsWith('-')) return PreviewWorkspace::ArgumentConflict;
        values.insert(name, value);
    }
    const auto operation = values.value("--preview-workspace-control");
    if (!QStringList{"snapshots", "restore", "recover"}.contains(operation) ||
        !values.contains("--workspace-path") || !values.contains("--project-root") || !values.contains("--python") ||
        values.contains("--snapshot") != (operation == "restore")) return PreviewWorkspace::ArgumentConflict;
    try {
        const auto runtime = PreviewWorkspace::readRuntime(values["--project-root"], values["--python"]);
        const auto workspace = values["--workspace-path"];
        if (workspace == runtime.root || workspace.startsWith(runtime.root + '/') || runtime.root.startsWith(workspace + '/'))
            throw PreviewWorkspace::Error(PreviewWorkspace::InvalidWorkspace, "PREVIEW_WORKSPACE_OVERLAPS_RUNTIME");
        if (!QFileInfo(workspace).isDir()) throw PreviewWorkspace::Error(PreviewWorkspace::InvalidWorkspace, "PREVIEW_WORKSPACE_REQUIRED");
        PreviewWorkspace::Session session(workspace, PreviewWorkspace::Session::Initialization::LockOnly);
        // Explicit maintenance is the escape hatch for a newer format. It can
        // restore earlier bytes without opening databases or starting tools.
        PreviewRestore::recoverPending(session, {}, operation == "restore" ? QStringList{values["--snapshot"]} : QStringList{});
        QJsonObject result;
        if (operation == "snapshots")
            result = {{"schema", "reverie.preview.snapshots.v1"}, {"snapshots", PreviewRestore::listSnapshots(session)}};
        else if (operation == "restore")
            result = PreviewRestore::restore(session, values["--snapshot"],
                {runtime.candidate, runtime.sourceHead, runtime.buildManifestSha256});
        else
            result = {{"schema", "reverie.preview.recovered.v1"}, {"recovered", true}};
        const auto bytes = QJsonDocument(result).toJson(QJsonDocument::Compact) + '\n';
        std::fwrite(bytes.constData(), 1, size_t(bytes.size()), stdout);
        return 0;
    } catch (const PreviewSnapshot::Error &error) {
        const auto code = QString::fromUtf8(error.what());
        const auto message = code == "PREVIEW_RESTORE_RECOVERY_REQUIRED"
            ? QStringLiteral("恢复记录状态不明，已保留现场，预览未启动。请勿删除目录，导出诊断并反馈。")
            : PreviewSnapshot::failureMessage(code);
        std::fprintf(stderr, "%s: %s\n", error.what(), message.toUtf8().constData()); return error.exitCode;
    } catch (const PreviewWorkspace::Error &error) {
        std::fprintf(stderr, "%s\n", error.what()); return error.exitCode;
    } catch (const PreviewDataFormat::Error &error) {
        const auto message = PreviewDataFormat::notice(QString::fromUtf8(error.what())).toUtf8();
        std::fprintf(stderr, "%s: %s\n", error.what(), message.constData()); return error.exitCode;
    } catch (const std::exception &) {
        std::fputs("PREVIEW_RESTORE_CONTROL_FAILED\n", stderr); return PreviewSnapshot::Failure;
    }
}
int main(int argc, char **argv) {
    QStringList rawArguments;
    for (int i = 1; i < argc; ++i) rawArguments.append(QString::fromLocal8Bit(argv[i]));
    const bool previewMode = PreviewWorkspace::requested(rawArguments);
    if (PreviewWorkspace::argumentConflict(rawArguments)) {
        std::fputs("PREVIEW_ARGUMENT_CONFLICT: 预览工作区不能与测试、诊断或其他入口参数组合。\n", stderr);
        return PreviewWorkspace::ArgumentConflict;
    }
    if (workspaceControlRequested(rawArguments)) return workspaceControl(argc, argv, rawArguments);
    if (PreviewUpgradeCheck::requested(rawArguments)) return PreviewUpgradeCheck::run(argc, argv);
    const bool previewCleanupMode = PreviewWorkspace::cleanupRequested(rawArguments);
    if (PreviewWorkspace::cleanupArgumentConflict(rawArguments)) {
        std::fputs("PREVIEW_CLEANUP_ARGUMENT_CONFLICT\n", stderr);
        return PreviewWorkspace::CleanupScopeRejected;
    }
    if (previewCleanupMode) {
        // This action has no GUI application, window, runtime or backend.
        QCoreApplication cleanupApp(argc, argv);
        QCommandLineParser cleanupArguments;
        cleanupArguments.addOption({"remove-preview-test-key", "Remove only isolated preview keys"});
        cleanupArguments.addOption({"context", "Disposable cleanup context", "file"});
        cleanupArguments.addOption({"data-dir", "Disposable runner data directory", "path"});
        cleanupArguments.process(cleanupApp);
        const auto cleanupData = cleanupArguments.value("data-dir");
        try {
            auto target = PreviewWorkspace::validateTestCleanupContext(cleanupArguments.value("context"), cleanupData);
            verifyContext(cleanupArguments.value("context"), cleanupData);
            try {
                removePreviewTestKeys(target);
                return 0;
            } catch (const std::exception &error) {
                qCritical("%s", error.what());
                return PreviewWorkspace::CleanupFailed;
            }
        } catch (const std::exception &error) {
            qCritical("%s", error.what());
            return PreviewWorkspace::CleanupScopeRejected;
        }
    }
    signal(SIGPIPE, SIG_IGN);
    QCoreApplication::setAttribute(Qt::AA_DisableShaderDiskCache);
    QSurfaceFormat format;
    format.setVersion(2, 1);
    format.setProfile(QSurfaceFormat::NoProfile);
    format.setDepthBufferSize(24);
    format.setStencilBufferSize(8);
    QSurfaceFormat::setDefaultFormat(format);
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    bool performanceEntry=false;
    for(int i=1;i<argc;i++) {
        const auto option=QString::fromLocal8Bit(argv[i]);
        if(option=="--perf-report") performanceEntry=true;
    }
    // QSG_INFO captures bounded general initialization/loop metadata. It does
    // not enable the separate per-frame QSG_RENDER_TIMING categories.
    if(performanceEntry){qputenv("QSG_INFO","1");PerfDiagnostics::installMessageCapture();}
#ifdef REVERIE_TIMING_DIAGNOSTICS
    TimingGuiApplication app(argc, argv);
#else
    QGuiApplication app(argc, argv);
#endif
    QCoreApplication::setApplicationName("Reverie Scene");
    QCoreApplication::setOrganizationName("Reverie Local Qt");
    QQuickStyle::setStyle("Basic");
    QCommandLineParser args;
    args.addHelpOption();
    args.addOption({"workspace", "Persistent preview workspace", "absolute-path"});
    for (auto name : {"project-root", "data-dir", "python", "context", "test-report", "test-model",
                      "test-endpoint", "test-endpoint-b", "test-cycle", "test-suite", "perf-report", "perf-rows", "perf-mode", "perf-protocol", "perf-fixture-report", "profiler-port", "diagnostic-case"})
        args.addOption({name, name, "value"});
    args.addOption({"demo-mode", "Disposable local demonstration"});
    args.addOption({"record-ui", "Record only the owned native test window"});
    args.addOption({"record-demo", "Pace the reading demonstration; requires --record-ui"});
    args.addOption({"p1-restore", "Use only the explicit isolated P1 restore check bootstrap"});
    args.addOption({"p1-persona", "Use only the explicit isolated P1 persona switch and card import bootstrap"});
    args.addOption({"p1-settings", "Extend the isolated ordinary check with the terminal settings sections"});
    args.addOption({"p1-provider", "Extend the isolated ordinary check with the reply-service key"});
    args.addOption({"p1-onboarding", "Start the isolated ordinary check from a fresh install's first-run sheet"});
    args.addOption({"p1-memory", "Use only the explicit isolated P1 memory paging bootstrap"});
    args.addOption({"candidate-paging", "Extend only --p1-memory with isolated candidate paging controls"});
    args.addOption({"p1-profile", "Extend the isolated ordinary check with explicit profile field clear"});
    args.addOption({"p1-worldbook-entry", "Extend the isolated ordinary check with the worldbook entry scan depth and budget tail"});
    args.addOption({"p1-worldbook-injection", "Extend the isolated ordinary check with the worldbook injection tail"});
    args.addOption({"p1-worldbook-regex", "Extend the isolated ordinary check with the worldbook regex tail"});
    args.addOption({"p0-tail", "Run only the explicit isolated P0 follow-up suite"});
    args.addOption({"remove-test-key", "Remove only this isolated Qt key"});
    args.addOption({"remove-preview-test-key", "Remove only preview keys in an explicit disposable cleanup context"});
    args.addOption({"perf-seed", "Prepare only an isolated encrypted performance fixture"});
    args.addOption({"diagnostic-control-fd4", "Use the inherited private diagnostic control socket on fd4"});
#ifdef REVERIE_TIMING_DIAGNOSTICS
    args.addOption({"metacall-context", "Observe bounded MetaCall receiver context in reading-close diagnostics"});
    args.addOption({"transition-diagnostics", "Observe the original isolated native control path without changing input"});
#endif
    args.process(app);
    const bool candidatePagingEntry = args.isSet("candidate-paging");
    // The established P1 gate below validates the ordinary isolated path.
    // Reject only the orphan flag and earlier action/diagnostic exits here.
    if (candidatePagingEntry && (!args.isSet("p1-memory") || args.isSet("remove-test-key") ||
        args.isSet("perf-seed") || args.isSet("diagnostic-case"))) return 6;
    const auto diagnosticCase=args.value("diagnostic-case");
    const bool selectedCase=args.isSet("diagnostic-case");
#ifdef REVERIE_TIMING_DIAGNOSTICS
    const bool transitionDiagnostics=args.isSet("transition-diagnostics");
    const bool metaCallContext=args.isSet("metacall-context");
#else
    constexpr bool transitionDiagnostics=false, metaCallContext=false;
#endif
    if(metaCallContext) {
        if(!selectedCase || diagnosticCase!="reading-close" || args.value("perf-mode")!="diagnostic" ||
            !args.isSet("perf-report") || transitionDiagnostics || args.isSet("perf-seed") ||
            args.isSet("demo-mode") || args.isSet("record-demo")) return 6;
    }
    if(transitionDiagnostics) {
#ifdef REVERIE_TIMING_DIAGNOSTICS
        if(!args.isSet("test-report") || args.value("test-cycle")!="1" || args.isSet("perf-report") ||
            args.isSet("perf-seed") || args.isSet("demo-mode") || args.isSet("record-demo") ||
            args.isSet("profiler-port") || args.isSet("remove-test-key") || selectedCase) return 6;
#else
        qCritical("TRANSITION_DIAGNOSTICS_NOT_COMPILED");return 6;
#endif
    }
    if(args.isSet("diagnostic-control-fd4") && !selectedCase) return 6;
    if(selectedCase) {
#ifdef REVERIE_TIMING_DIAGNOSTICS
        const auto protocol=args.isSet("perf-protocol") ? args.value("perf-protocol") : QStringLiteral("stress-v1");
        const auto rows=args.value("perf-rows").toInt();
        const bool reading=diagnosticCase=="reading-close";
        const bool scrolling=diagnosticCase=="scroll-tail" || diagnosticCase=="scroll-tail-with-prefix";
        if(!args.isSet("perf-report") || args.value("perf-mode")!="diagnostic" || args.isSet("record-ui") ||
            (!reading && !scrolling) || (reading && (protocol!="stress-v1" || (rows!=100 && rows!=300))) ||
            (scrolling && (protocol!="companion-transactions-v1" || rows!=300)) ||
            !TimingTrace::configureControl(&app,args.isSet("diagnostic-control-fd4") ? 4 : -1,diagnosticCase,protocol,rows)) return 6;
#else
        qCritical("TIMING_DIAGNOSTICS_NOT_COMPILED");return 6;
#endif
    }
    auto data = args.value("data-dir");
    PreviewWorkspace::RuntimeInfo previewRuntime;
    std::unique_ptr<PreviewWorkspace::Session> previewWorkspace;
    std::unique_ptr<PreviewEvents::Writer> previewEvents;
    std::unique_ptr<PreviewSnapshot::Manager> previewSnapshot;
    auto recordPreview = [&](const QString &event, const QString &code = QStringLiteral("OK"), qint64 value = 0) {
        if (!previewEvents) return;
        try { previewEvents->record(event, code, value); }
        catch (...) { qWarning("PREVIEW_EVENT_WRITE_FAILED"); }
    };
    auto showPreviewFailure = [&app](const QString &message, int status) {
        QQmlApplicationEngine failure;
        failure.rootContext()->setContextProperty("previewFailureText", message);
        failure.loadData(R"(import QtQuick
import QtQuick.Window
Window { width: 560; height: 200; visible: true; title: "Reverie 预览未启动"
 color: "#24242a"
 Text { anchors.fill: parent; anchors.margins: 28; text: previewFailureText
 color: "#ffffff"; wrapMode: Text.Wrap; font.pixelSize: 18; verticalAlignment: Text.AlignVCenter }
})");
        if (!failure.rootObjects().isEmpty()) app.exec();
        return status;
    };
    if (previewMode) {
        try {
            previewRuntime = PreviewWorkspace::readRuntime(args.value("project-root"), args.value("python"));
            previewWorkspace = std::make_unique<PreviewWorkspace::Session>(args.value("workspace"),
                PreviewWorkspace::Session::Initialization::LockOnly);
            const int supported = std::min(PreviewDataFormat::Current, previewRuntime.supportedDataFormat);
            // Check before recovery too: a newer data tree must not be
            // modified merely to discover that this program cannot open it.
            PreviewDataFormat::checkWorkspace(previewWorkspace->root(), supported);
            PreviewRestore::recoverPending(*previewWorkspace);
            PreviewDataFormat::checkWorkspace(previewWorkspace->root(), supported);
            previewWorkspace->initializeDirectories();
            data = previewWorkspace->root();
            previewEvents = std::make_unique<PreviewEvents::Writer>(*previewWorkspace);
            previewEvents->record("startup");
            previewSnapshot = std::make_unique<PreviewSnapshot::Manager>(*previewWorkspace,
                PreviewSnapshot::Identity{previewRuntime.candidate, previewRuntime.sourceHead, previewRuntime.buildManifestSha256});
            const auto snapshot = previewSnapshot->prepare();
            using Action = PreviewSnapshot::Action;
            if (snapshot.action == Action::Created) previewEvents->record("snapshot_created", "CREATED");
            else if (snapshot.action == Action::Reused) previewEvents->record("snapshot_reused", "REUSED");
            else previewEvents->record("snapshot_skipped", snapshot.action == Action::FirstLaunch ? "FIRST_LAUNCH" : "UNCHANGED");
            for (const auto &warning : snapshot.warnings) {
                Q_UNUSED(warning);
                recordPreview("snapshot_warning", "UNMANAGED");
            }
        } catch (const PreviewDataFormat::Error &error) {
            recordPreview("startup_failed", QString::fromUtf8(error.what()));
            qCritical("%s", error.what());
            const auto message = PreviewDataFormat::notice(QString::fromUtf8(error.what())).toUtf8();
            std::fprintf(stderr, "%s\n", message.constData());
            return error.exitCode;
        } catch (const PreviewSnapshot::Error &error) {
            const auto code = QString::fromUtf8(error.what());
            if (code == "PREVIEW_RESTORE_RECOVERY_REQUIRED") recordPreview("startup_failed", code);
            else recordPreview("snapshot_failed", PreviewSnapshot::failureCode(code));
            qCritical("%s", error.what());
            return showPreviewFailure(code == "PREVIEW_RESTORE_RECOVERY_REQUIRED"
                ? QStringLiteral("恢复记录状态不明，已保留现场，预览未启动。请勿删除目录，导出诊断并反馈。")
                : PreviewSnapshot::failureMessage(code), error.exitCode);
        } catch (const PreviewWorkspace::Error &error) {
            qCritical("%s", error.what());
            if (error.exitCode == PreviewWorkspace::InvalidWorkspace)
                qCritical("预览工作区必须是本人所有、权限为0700的绝对规范目录；子目录也须为私有目录。");
            else if (error.exitCode == PreviewWorkspace::InvalidRuntime)
                qCritical("预览运行目录未通过核对，请使用预览启动脚本启动已安装的版本。");
            if (error.exitCode == 70)
                return showPreviewFailure(QStringLiteral("预览事件记录无法安全写入，预览没有启动。请检查工作区权限；现有数据未改动。"), error.exitCode);
            return error.exitCode;
        }
    } else {
        try {
            verifyContext(args.value("context"), data);
            if (args.isSet("remove-test-key")) {
                removeTestStorageKey(data);
                removeTestProviderKey(data);
                return 0;
            }
            if(args.isSet("perf-seed")) return seedPerformanceFixture(args);
        } catch (const std::exception &e) {
            qCritical("%s", e.what());
            return 2;
        }
    }
    qputenv("QML_DISK_CACHE_PATH", (data + "/qml-cache").toUtf8());
    if(transitionDiagnostics) TransitionDiagnostics::start(args.isSet("record-ui"));
    if(args.isSet("profiler-port")) {
#ifdef REVERIE_QML_PROFILER
        bool parsed=false;const int port=args.value("profiler-port").toInt(&parsed);
        if(args.value("perf-mode")!="diagnostic" || !parsed || port<1024 || port>65535) return 5;
        QQmlDebuggingEnabler::enableDebugging(true);
        QQmlDebuggingEnabler::setServices(QQmlDebuggingEnabler::profilerServices());
        if(!QQmlDebuggingEnabler::startTcpDebugServer(port,QQmlDebuggingEnabler::DoNotWaitForClient,"127.0.0.1")) return 5;
#else
        qCritical("QML_PROFILER_NOT_COMPILED");return 5;
#endif
    }
    registerArchiveInteractionTypes();
    qmlRegisterType<NativeAvatar>("Reverie.Native", 1, 0, "NativeAvatar");
    // Select the fixed testing bootstrap only after the same isolated entry
    // gate has passed. Ordinary launches always retain the production backend.
    const bool supplementaryEntry = args.isSet("test-suite");
    const bool p0TailEntry = args.isSet("p0-tail");
    const bool p1RestoreEntry = args.isSet("p1-restore");
    const bool p1PersonaEntry = args.isSet("p1-persona");
    const bool p1SettingsEntry = args.isSet("p1-settings");
    const bool p1ProviderEntry = args.isSet("p1-provider");
    const bool p1OnboardingEntry = args.isSet("p1-onboarding");
    const bool p1MemoryEntry = args.isSet("p1-memory");
    const bool p1ProfileEntry = args.isSet("p1-profile");
    const bool p1WorldbookEntryEntry = args.isSet("p1-worldbook-entry");
    const bool p1WorldbookInjectionEntry = args.isSet("p1-worldbook-injection");
    const bool p1WorldbookRegexEntry = args.isSet("p1-worldbook-regex");
    if (int(p1RestoreEntry) + int(p1PersonaEntry) + int(p1SettingsEntry) + int(p1ProviderEntry) +
            int(p1OnboardingEntry) + int(p1MemoryEntry) + int(p1ProfileEntry) + int(p1WorldbookEntryEntry) + int(p1WorldbookRegexEntry) + int(p1WorldbookInjectionEntry) > 1)
        return 6;
    if (p1RestoreEntry || p1PersonaEntry || p1SettingsEntry || p1ProviderEntry || p1OnboardingEntry ||
        p1MemoryEntry || p1ProfileEntry || p1WorldbookEntryEntry || p1WorldbookRegexEntry || p1WorldbookInjectionEntry) {
        const QUrl endpoint(args.value("test-endpoint"));
        const int cycle = args.value("test-cycle").toInt();
        if (!args.isSet("test-report") || supplementaryEntry || !QFileInfo(args.value("test-report")).isAbsolute() ||
            (cycle != 1 && cycle != 2) || endpoint.scheme() != "http" || endpoint.host() != "127.0.0.1" ||
            endpoint.port() < 1024 || args.isSet("record-ui") || args.isSet("record-demo") ||
            args.isSet("demo-mode") || args.isSet("perf-report") || args.isSet("profiler-port") ||
            args.isSet("remove-test-key") || args.isSet("perf-seed") || selectedCase || transitionDiagnostics)
            return 6;
    }
    if ((p0TailEntry || args.isSet("test-endpoint-b")) && !supplementaryEntry) return 6;
    if (supplementaryEntry) {
        const QUrl endpoint(args.value("test-endpoint"));
        const QUrl endpointB(args.value("test-endpoint-b"));
        const int cycle = args.value("test-cycle").toInt();
        const bool validSuite = p0TailEntry ? args.value("test-suite") == "p0-tail" : args.value("test-suite") == "supplementary";
        const bool validSecondEndpoint = p0TailEntry ? args.isSet("test-endpoint-b") && endpointB.scheme() == "http" &&
            endpointB.host() == "127.0.0.1" && endpointB.port() >= 1024 && endpointB != endpoint &&
            endpointB.path() == "/v1" && endpointB.userInfo().isEmpty() && !endpointB.hasQuery() && !endpointB.hasFragment()
            : !args.isSet("test-endpoint-b");
        if (!validSuite || !validSecondEndpoint || !args.isSet("test-report") ||
            !QFileInfo(args.value("test-report")).isAbsolute() || (cycle != 1 && cycle != 2) ||
            endpoint.scheme() != "http" || endpoint.host() != "127.0.0.1" || endpoint.port() < 1024 ||
            (p0TailEntry && (endpoint.path() != "/v1" || !endpoint.userInfo().isEmpty() || endpoint.hasQuery() || endpoint.hasFragment())) ||
            args.isSet("record-ui") || args.isSet("record-demo") || args.isSet("demo-mode") ||
            transitionDiagnostics || args.isSet("perf-report") || args.isSet("profiler-port") ||
            args.isSet("perf-seed") || args.isSet("remove-test-key") || selectedCase ||
            args.isSet("diagnostic-control-fd4"))
            return 6;
    }
    RuntimeBridge session(args.value("project-root"), data, args.value("python"), nullptr, supplementaryEntry, previewMode);
    if (previewMode)
        QObject::connect(&session, &RuntimeBridge::previewEvent, &session, recordPreview);
    if (supplementaryEntry)
        session.setSupplementaryFixtureArguments(args.value("context"), args.value("test-endpoint"),
                                                args.value("test-cycle").toInt(), p0TailEntry, args.value("test-endpoint-b"));
    if (p1RestoreEntry)
        session.setRestoreFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1PersonaEntry)
        session.setPersonaFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1MemoryEntry)
        session.setMemoryFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt(),
                                          candidatePagingEntry);
    if (p1ProfileEntry)
        session.setProfileFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1SettingsEntry)
        session.setSettingsFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1WorldbookEntryEntry)
        session.setWorldbookEntryFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1WorldbookRegexEntry)
        session.setWorldbookRegexFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    if (p1WorldbookInjectionEntry)
        session.setWorldbookInjectionFixtureArguments(args.value("context"), args.value("test-endpoint"), args.value("test-cycle").toInt());
    session.setProviderKeyStore(keychainProviderKeyStore(data, previewMode ? KeychainDomain::Preview : KeychainDomain::Local));
    if (previewMode) {
        struct ReadyState { qint64 authenticatedPid = 0, publishedPid = 0; bool failed = false; };
        auto readyState = std::make_shared<ReadyState>();
        auto publishReady = [bridge = &session, runtime = previewRuntime, workspaceId = previewWorkspace->id(),
                             readyState, snapshot = previewSnapshot.get(), workspace = previewWorkspace.get(), &recordPreview] {
            auto status = bridge->diagnostics();
            const qint64 pid = status.value("backendPid").toLongLong();
            if (readyState->failed || !bridge->connected() || pid != readyState->authenticatedPid || pid == readyState->publishedPid) return;
            const auto line = PreviewWorkspace::readyLine(runtime, workspaceId, QCoreApplication::applicationPid(), status);
            if (!line.isEmpty()) {
                try {
                    PreviewDataFormat::writeReady(*workspace);
                    snapshot->markReady();
                } catch (const std::exception &error) {
                    readyState->failed = true;
                    recordPreview("startup_failed", "PREVIEW_READY_RECORD_FAILED");
                    qCritical("%s", error.what());
                    bridge->shutdown();
                    return;
                }
                readyState->publishedPid = pid;
                recordPreview("ready", "CLEAN");
                std::fwrite(line.constData(), 1, size_t(line.size()), stdout);
                std::fflush(stdout);
                readyState->publishedPid = pid;
            }
        };
        QObject::connect(&session, &RuntimeBridge::validatedReady, &session,
            [readyState, publishReady, &recordPreview](const QVariantMap &status) {
                recordPreview("restore_state", status.value("recoveryState").toString() == "clean"
                    ? (status.value("runtimeWritable").toBool() ? "CLEAN" : "READ_ONLY") : "RECOVERY_REQUIRED");
                readyState->authenticatedPid = status.value("backendPid").toLongLong();
                publishReady();
            });
        QObject::connect(&session, &RuntimeBridge::changed, &session, publishReady);
    }
    // The provider check's synthetic key and second loopback endpoint, registered by the isolated host.
    ProviderCredentialCheck::Fixture providerFixture;
    if (p1ProviderEntry) {
        try {
            providerFixture = ProviderCredentialCheck::readFixture(args.value("context"), args.value("test-endpoint"));
        } catch (const std::exception &e) {
            qCritical("%s", e.what());
            return 6;
        }
    }
    bool testRejectWrite = false;
    ArchiveEditor archiveEditor(
        [&session, &testRejectWrite](const QString &command, const QVariantMap &payload) {
            auto value = payload;
            if (testRejectWrite && command == "archive:put") {
                testRejectWrite = false;
                auto archive = value["archive"].toMap();
                archive["native_rejection_fixture"] = true;
                value["archive"] = archive;
            }
            return session.request(command, value);
        });
    QObject::connect(&session, &RuntimeBridge::changed, &archiveEditor, [&] {
        archiveEditor.setSession(session.connected(), session.generation(), session.scopeKey(), session.runtimeWritable(),
                                 session.personaChanging());
    });
    QObject::connect(&session, &RuntimeBridge::backupRestoreReconciled, &archiveEditor, &ArchiveEditor::reconcileAfterRestore);
    QObject::connect(&session, &RuntimeBridge::responseReceived, &archiveEditor,
                     &ArchiveEditor::receive);
    QObject::connect(&session, &RuntimeBridge::requestFailed, &archiveEditor,
                     &ArchiveEditor::failed);
    QQmlApplicationEngine engine;
    engine.rootContext()->setContextProperty("session", &session);
    engine.rootContext()->setContextProperty("archiveEditor", &archiveEditor);
    engine.rootContext()->setContextProperty("previewDisposable", args.isSet("demo-mode"));
    engine.rootContext()->setContextProperty("previewWorkspaceTitle", previewMode ? previewRuntime.title() : QString());
    engine.load(QUrl("qrc:/ui/Main.qml"));
    if (engine.rootObjects().isEmpty())
        return 3;
    auto *window = qobject_cast<QQuickWindow *>(engine.rootObjects().first());
    std::unique_ptr<PreviewWorkspace::Termination> previewTermination;
    if (previewMode) {
        try {
            previewTermination = std::make_unique<PreviewWorkspace::Termination>(&app, [window] { window->close(); });
        } catch (const PreviewWorkspace::Error &error) {
            qCritical("%s", error.what());
            return error.exitCode;
        }
    }
    if(selectedCase) TimingTrace::setObservedWindow(window);
    WindowRecorder recorder(window);
    window->setPersistentGraphics(true);
    window->setPersistentSceneGraph(true);
    QObject::connect(&session, &RuntimeBridge::shutdownComplete, &app, [&app] { app.exit(0); });
    QTimer::singleShot(0, &session, &RuntimeBridge::start);
    if(args.isSet("perf-report")) {
        const auto mode=args.value("perf-mode");const int rows=args.value("perf-rows").toInt();
        const auto protocol=args.isSet("perf-protocol") ? args.value("perf-protocol") : QStringLiteral("stress-v1");
        const QUrl endpoint(args.value("test-endpoint"));
        if((mode!="perf" && mode!="diagnostic" && mode!="visual") || (rows!=9 && rows!=100 && rows!=300) ||
            (protocol!="stress-v1" && protocol!="companion-transactions-v1") ||
            endpoint.scheme()!="http" || endpoint.host()!="127.0.0.1" || endpoint.port()<1024 || args.isSet("test-report") ||
            (args.isSet("record-ui") && mode!="visual")) return 6;
        // The diagnostic collector observes this owned window. It never changes
        // a render loop, calls glFinish, or drives application updates.
        auto diagnostics=std::make_shared<PerfDiagnostics>(mode=="diagnostic",nullptr,selectedCase);
        if(mode!="visual") diagnostics->attach(window);
        auto finish=[&,diagnostics,mode,selectedCase](QVariantMap report){
            diagnostics->stop([&,diagnostics,mode,selectedCase,report=std::move(report)]() mutable {
                if(selectedCase) {
                    TimingTrace::stop();
                    report["timingTrace"]=TimingTrace::snapshot().toVariantMap();
                }
                report["diagnostics"]=mode=="visual" ? QVariantMap{{"measured",false},{"reason","Visual validation; timing disabled"}} : diagnostics->snapshot().toVariantMap();
                report["session"]=session.diagnostics();
                if(mode=="visual" && args.isSet("record-ui")) {
                    const auto capture=recorder.finish();report["recording"]=capture;
                    if(!capture.value("ok").toBool()){report["passed"]=false;report["error"]="PERF_RECORD_FAILED";}
                }
                QSaveFile file(args.value("perf-report"));
                if(!file.open(QIODevice::WriteOnly) || file.write(QJsonDocument::fromVariant(report).toJson())<0 || !file.commit())
                    qCritical("PERF_REPORT_WRITE_FAILED");
                session.quit();
            });
        };
        PerfBootstrap::run(window,&session,&archiveEditor,args.value("test-model"),endpoint.toString(),rows,
            [&,finish,diagnostics,mode,rows,protocol,diagnosticCase](bool ok,QVariantMap bootstrap){
                if(!ok){finish({{"passed",false},{"bootstrap",bootstrap}});return;}
                if(mode=="visual" && args.isSet("record-ui") && !recorder.start(args.value("perf-report")+".mov")) {
                    finish({{"passed",false},{"error","PERF_RECORD_START_FAILED"}});return;
                }
                if(!diagnosticCase.isEmpty()) {
                    TimingTrace::setMetaCallContextEnabled(metaCallContext);
                    TimingTrace::start();
                }
                PerfScenarioCheck::run(window,&session,&archiveEditor,mode,rows,args.value("perf-report"),
                    [finish,bootstrap](QVariantMap report) mutable { report["bootstrap"]=bootstrap;finish(report); },protocol,diagnosticCase);
            });
        return app.exec();
    }
    if (args.isSet("demo-mode")) {
        const QUrl endpoint(args.value("test-endpoint"));
        if (endpoint.scheme() != "http" || endpoint.host() != "127.0.0.1" || endpoint.port() < 1024)
            return 4;
        auto phase = std::make_shared<int>(0);
        QObject::connect(&session, &RuntimeBridge::changed, &app, [&, phase] {
            if (*phase == 0 && session.connected()) {
                *phase = 1;
                session.testProvider(args.value("test-endpoint"), "reverie-local-demo");
            } else if (*phase == 1 && session.state()["providerTestReady"].toBool()) {
                *phase = 2;
                session.saveProvider();
            }
        });
    }
    if (args.isSet("test-suite")) {
        // The supplementary function audit is an explicit test entry; it never
        // combines with recording, diagnostics or the default control check.
        const QUrl endpoint(args.value("test-endpoint"));
        const int cycle = args.value("test-cycle").toInt();
        if ((args.value("test-suite") != (p0TailEntry ? "p0-tail" : "supplementary")) || !args.isSet("test-report") ||
            (cycle != 1 && cycle != 2) || endpoint.scheme() != "http" || endpoint.host() != "127.0.0.1" ||
            endpoint.port() < 1024 || args.isSet("record-ui") || args.isSet("demo-mode") ||
            transitionDiagnostics || args.isSet("perf-report"))
            return 6;
        window->requestActivate();
        const auto completed = [&, window, cycle, p0TailEntry](QVariantMap data) {
                QJsonArray messageMetadata;
                for (const auto &value : session.messages()) {
                    const auto message = value.toMap();
                    messageMetadata.append(QJsonObject{{"id", message["id"].toString()},
                                                      {"role", message["role"].toString()},
                                                      {"characters", int(message["content"].toString().size())}});
                }
                QJsonObject report{{"schema", p0TailEntry ? "reverie.qt.native-p0-tail.v1" : "reverie.qt.native-supplementary.v2"},
                                   {"cycle", cycle},
                                   {"completed", true},
                                   {p0TailEntry ? "p0Tail" : "supplementary", QJsonObject::fromVariantMap(data)},
                                   {"diagnostics", QJsonObject::fromVariantMap(session.diagnostics())},
                                   {"messageMetadata", messageMetadata},
                                   {"contentCollected", false},
                                   {"window", QJsonObject{{"width", window->width()}, {"height", window->height()},
                                                          {"devicePixelRatio", window->devicePixelRatio()}}},
                                   {"appearanceFile", QFileInfo::exists(args.value("data-dir") + "/qt-appearance.json")}};
                if (auto *av = window->findChild<NativeAvatar *>("nativeAvatar"))
                    report["avatar"] = QJsonObject{{"loads", av->loads()}, {"frames", av->frames()},
                                                   {"paintedPixels", av->paintedPixels()},
                                                   {"modelPath", av->diagnostics()["modelPath"].toString()}};
                if (!p0TailEntry) window->grabWindow().save(args.value("test-report") + ".png");
                QSaveFile f(args.value("test-report"));
                if (!f.open(QIODevice::WriteOnly) || f.write(QJsonDocument(report).toJson()) < 0 || !f.commit())
                    qCritical("%s", p0TailEntry ? "P0_TAIL_REPORT_WRITE_FAILED" : "SUPPLEMENTARY_REPORT_WRITE_FAILED");
                session.quit();
            };
        if (p0TailEntry)
            P0TailCheck::run(window, &session, cycle, endpoint.toString(), args.value("test-endpoint-b"),
                            args.value("test-report"), completed);
        else
            SupplementaryFunctionCheck::run(window, &session, cycle, endpoint.toString(), args.value("test-model"),
                                             args.value("test-report"), completed);
        return app.exec();
    }
    if (args.isSet("test-report")) {
        window->requestActivate();
        auto *timer = new QTimer(&app);
        timer->setInterval(100);
        auto *step = new int(0);
        auto *ticks = new int(0);
        auto *result = new QJsonObject{{"schema", "reverie.qt.native-smoke.v1"},
                                       {"passed", false},
                                       {"cycle", args.value("test-cycle")}};
        auto inputGate = std::make_shared<NativeControlReadiness::OnceGate>();
        auto inputGateStep = std::make_shared<int>(-1);
        auto inputGateClock = std::make_shared<QElapsedTimer>();
        auto archiveInputGate = std::make_shared<NativeControlReadiness::SequentialGate>();
        auto archiveInputStep = std::make_shared<int>(-1);
        auto archiveInputClock = std::make_shared<QElapsedTimer>();
        auto archiveInputDispatching = std::make_shared<bool>(false);
        QObject::connect(timer, &QTimer::timeout, &app, [&, step, ticks, result, timer, window,
                                                        inputGate, inputGateStep, inputGateClock,
                                                        archiveInputGate, archiveInputStep, archiveInputClock,
                                                        archiveInputDispatching] {
            // The entry-creation buttons use the existing OnceGate. QTest may
            // pump this timer before their callbacks return, so protect the
            // initial archive segment too, before another tick can reset its
            // step clock or dispatch the same creation action twice.
            if (*archiveInputDispatching) return;
            const bool initialArchiveStep = *step == 5 || *step == 51 || *step == 52 || *step == 53;
            struct ArchiveDispatchGuard {
                bool &dispatching;
                bool owns;
                ~ArchiveDispatchGuard() { if (owns) dispatching = false; }
            } dispatchGuard{*archiveInputDispatching, initialArchiveStep};
            if (initialArchiveStep) *archiveInputDispatching = true;
            ++*ticks;
            auto finish = [&](bool ok, QString error = {}) {
                timer->stop();
                if (args.isSet("record-ui") && args.value("test-cycle") == "1") {
                    auto recording = recorder.finish();
                    (*result)["recording"] = QJsonObject::fromVariantMap(recording);
                    (*result)["performanceComparable"] = false;
                    if (!recording.value("ok").toBool()) {
                        ok = false;
                        error += " RECORDING_FAILED:" + recording.value("error").toString();
                    }
                } else
                    (*result)["performanceComparable"] = true;
                if(transitionDiagnostics) {
                    TransitionDiagnostics::stop();
                    const auto capture = TransitionDiagnostics::snapshot();
                    (*result)["transitionDiagnostics"] = QJsonObject::fromVariantMap(capture);
                    (*result)["diagnosticCaptureComplete"] = capture.value("complete").toBool();
                    (*result)["originalConstraintsPassed"] = ok;
                    if(!capture.value("complete").toBool()) {
                        ok = false;
                        error += " TRANSITION_DIAGNOSTIC_CAPTURE_INCOMPLETE";
                    }
                    (*result)["performanceComparable"] = false;
                }
                (*result)["step"] = *step;
                (*result)["passed"] = ok;
                (*result)["error"] = error;
                (*result)["diagnostics"] = QJsonObject::fromVariantMap(session.diagnostics());
                (*result)["messages"] = QJsonArray::fromVariantList(session.messages());
                if (p1PersonaEntry)
                    (*result)["personas"] = QJsonObject::fromVariantMap(session.state().value("personas").toMap());
                auto *av = window->findChild<NativeAvatar *>("nativeAvatar");
                if (av)
                    (*result)["avatar"] = QJsonObject{{"loads", av->loads()},
                                                      {"releases", av->releases()},
                                                      {"frames", av->frames()},
                                                      {"paintedPixels", av->paintedPixels()}};
                window->grabWindow().save(args.value("test-report") + ".png");
                QSaveFile f(args.value("test-report"));
                f.open(QIODevice::WriteOnly);
                f.write(QJsonDocument(*result).toJson());
                f.commit();
                session.quit();
            };
            if (*ticks > 600) {
                finish(false, "NATIVE_SCENARIO_TIMEOUT");
                return;
            }
            auto click = [&](const QString &name, const std::function<void()> &beforeInput = {}) {
                auto *i = visualItem(window->contentItem(), name);
                if (!i || !i->isVisible() || !i->isEnabled())
                    throw std::runtime_error(("CONTROL_UNAVAILABLE:" + name).toStdString());
                QPointF p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
                if (!QRectF(0, 0, window->width(), window->height()).contains(p))
                    throw std::runtime_error("CONTROL_CLIPPED");
                if (beforeInput) beforeInput();
                QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, p.toPoint());
            };
            auto type = [&](const QString &name, const QString &text,
                            const std::function<void()> &beforeInput = {}) {
                auto *i = visualItem(window->contentItem(), name);
                if (!i || !i->isVisible())
                    throw std::runtime_error("EDITOR_UNAVAILABLE");
                if (beforeInput) beforeInput();
                i->forceActiveFocus();
                if (beforeInput) beforeInput();
                QTest::keyClick(window, Qt::Key_A, Qt::ControlModifier);
                if (beforeInput) beforeInput();
                QMetaObject::invokeMethod(i, "selectAll");
                QInputMethodEvent commit;
                commit.setCommitString(text);
                if (beforeInput) beforeInput();
                QCoreApplication::sendEvent(window, &commit);
                if (i->property("text").toString() != text)
                    throw std::runtime_error(("INPUT_NOT_COMMITTED:" + name).toStdString());
            };
            auto whenReady = [&](const QString &name, const std::function<void()> &action) {
                if (*inputGateStep != *step) {
                    *inputGateStep = *step;
                    inputGate->resetForNextStep();
                    inputGateClock->start();
                }
                const auto outcome = inputGate->poll(inputGateClock->elapsed(), 4000, [&] {
                    auto state = NativeControlReadiness::snapshot(visualItem(window->contentItem(), name), window);
                    state["step"] = *step;
                    state["control"] = name;
                    return state;
                }, action);
                (*result)["initialInputReadinessCurrent"] = QJsonObject::fromVariantMap(inputGate->metadata());
                if (outcome == NativeControlReadiness::OnceGate::Expired)
                    throw std::runtime_error(("INITIAL_READINESS_DEADLINE:" + name).toStdString());
                if (outcome != NativeControlReadiness::OnceGate::Performed)
                    return false;
                auto recorded = (*result)["initialInputReadiness"].toArray();
                recorded.append(QJsonObject{{"step", *step}, {"control", name},
                                            {"gate", QJsonObject::fromVariantMap(inputGate->metadata())}});
                (*result)["initialInputReadiness"] = recorded;
                return true;
            };
            auto enterArchiveInput = [&](int nextStep) {
                // Start at the logical transition, not at the first eligible
                // control. All of this step's fields share this one deadline.
                *step = nextStep;
                *archiveInputStep = nextStep;
                archiveInputGate->resetForNextStep();
                archiveInputClock->start();
            };
            auto archiveInput = [&](bool bookOnly) {
                if (*archiveInputStep != *step || !archiveInputClock->isValid())
                    throw std::runtime_error("INITIAL_ARCHIVE_INPUT_CLOCK_MISSING");
                using Action = NativeControlReadiness::SequentialGate::Action;
                std::vector<Action> actions;
                auto inspect = [&](QQuickItem *item, const QString &name) {
                    auto *surface = visualItem(window->contentItem(), "drawer-memory");
                    auto state = NativeControlReadiness::snapshot(
                        item, window, surface && surface->property("inputReady").toBool());
                    state["step"] = *step;
                    state["control"] = name;
                    return state;
                };
                auto add = [&](const QString &name, const QString &value, bool save) {
                    actions.push_back({name,
                        [&, name] { return visualItem(window->contentItem(), name); },
                        [&, name](QQuickItem *item) { return inspect(item, name); },
                        [&, name, value, save](QQuickItem *item) {
                            // QTest selection may process events. Recheck the
                            // live deadline before the later IME commit too.
                            const auto guard = [&, name, item] {
                                if (archiveInputClock->elapsed() >= 4000)
                                    throw std::runtime_error(("INITIAL_READINESS_DEADLINE:" + name).toStdString());
                                if (visualItem(window->contentItem(), name) != item ||
                                    !inspect(item, name).value("ready").toBool())
                                    throw std::runtime_error(("INITIAL_INPUT_ELIGIBILITY_CHANGED:" + name).toStdString());
                                if (archiveInputClock->elapsed() >= 4000)
                                    throw std::runtime_error(("INITIAL_READINESS_DEADLINE:" + name).toStdString());
                            };
                            if (save) click(name, guard);
                            else type(name, value, guard);
                        }});
                };
                add("worldbookName", "星空手记", false);
                if (!bookOnly) {
                    add("worldbookKeys", "星空", false);
                    add("worldbookContent", "我们的观星暗号是青绿色的流星。", false);
                }
                add("saveWorldbook", {}, true);
                auto recordCurrent = [&] {
                    auto metadata = archiveInputGate->metadata();
                    metadata["step"] = *step;
                    metadata["deadlineMs"] = 4000;
                    (*result)["initialArchiveInputCurrent"] = QJsonObject::fromVariantMap(metadata);
                };
                NativeControlReadiness::SequentialGate::Result outcome;
                try {
                    outcome = archiveInputGate->poll([&] { return archiveInputClock->elapsed(); }, 4000, actions);
                } catch (...) {
                    recordCurrent();
                    throw;
                }
                recordCurrent();
                if (outcome == NativeControlReadiness::SequentialGate::Expired) {
                    const auto index = archiveInputGate->metadata().value("actionIndex").toInt();
                    const auto name = actions[std::min<int>(index, int(actions.size()) - 1)].name;
                    throw std::runtime_error(("INITIAL_READINESS_DEADLINE:" + name).toStdString());
                }
                if (outcome == NativeControlReadiness::SequentialGate::Failed)
                    throw std::runtime_error("INITIAL_ARCHIVE_INPUT_ACTION_FAILED");
                if (outcome != NativeControlReadiness::SequentialGate::Performed)
                    return false;
                auto completed = (*result)["initialArchiveInputs"].toArray();
                completed.append((*result)["initialArchiveInputCurrent"]);
                (*result)["initialArchiveInputs"] = completed;
                return true;
            };
            auto recordDraft = [&](const QString &stage, const QString &expected) {
                auto *composer = window->findChild<QQuickItem *>("chatComposer");
                if (!composer)
                    throw std::runtime_error("DRAFT_COMPOSER_MISSING");
                const auto bridgeDraft = session.draft();
                const auto editorDraft = composer->property("text").toString();
                const bool match = bridgeDraft == expected && editorDraft == expected;
                auto records = (*result)["draftAssertions"].toArray();
                records.append(QJsonObject{{"stage", stage}, {"scopeKey", session.scopeKey()},
                                           {"bridgeLength", int(bridgeDraft.size())}, {"composerLength", int(editorDraft.size())},
                                           {"match", match}, {"empty", bridgeDraft.isEmpty() && editorDraft.isEmpty()}});
                (*result)["draftAssertions"] = records;
                if (!match)
                    throw std::runtime_error(("DRAFT_STATE_MISMATCH:" + stage).toStdString());
            };
            try {
                if (*step == 0 && session.connected() && p1RestoreEntry && args.value("test-cycle") == "2" && !result->contains("restoreStartup")) {
                    *step = 80;
                    timer->stop();
                    ArchiveInteractionCheck::runStartupRescue(window, &session, &archiveEditor, args.value("test-report"),
                        [&, result, step, ticks, timer](QVariantMap check) {
                            (*result)["restoreStartup"] = QJsonObject::fromVariantMap(check);
                            *step = 81;
                            *ticks = 0;
                            timer->start();
                        });
                    return;
                }
                if (*step == 81) {
                    const auto rescue = (*result)["restoreStartup"].toObject();
                    if (!rescue["passed"].toBool()) { finish(false, rescue["error"].toString()); *step = 99; return; }
                    *step = 0;
                }
                // Every start outside the restore fault check, including the
                // restart on data an earlier cycle wrote, must be writable
                // before the first edit; a startup replay may still settle.
                if (*step == 0 && session.connected() && !p1RestoreEntry &&
                    !result->contains("startupRecoveryState")) {
                    const auto state = session.recoveryState();
                    if (state == "recovering" || state == "unknown")
                        return;
                    (*result)["startupRecoveryState"] = state;
                    if (state != "clean" || !session.runtimeWritable())
                        throw std::runtime_error(("STARTUP_NOT_WRITABLE:" + state).toStdString());
                }
                // The first-run sheet comes before the ordinary flow: the first cycle walks
                // it on a fresh install, the restart only reads back what it saved.
                if (*step == 0 && session.connected() && p1OnboardingEntry && !result->contains("onboarding")) {
                    *step = 84;
                    timer->stop();
                    OnboardingCheck::run(window, &session, args.value("test-cycle") == "2", args.value("test-endpoint"),
                                         args.value("test-report"), [&, result, step, ticks, timer](QVariantMap check) {
                                             (*result)["onboarding"] = QJsonObject::fromVariantMap(check);
                                             *step = 85;
                                             *ticks = 0;
                                             timer->start();
                                         });
                    return;
                }
                if (*step == 85) {
                    const auto check = (*result)["onboarding"].toObject();
                    if (!check["passed"].toBool()) {
                        finish(false, check["error"].toString());
                        *step = 99;
                        return;
                    }
                    *step = 0;
                    return;
                }
                // This explicitly selected segment closes its own surface and leaves
                // the original page, recall and ordinary sequences intact.
                if (*step == 0 && session.connected() && candidatePagingEntry && !result->contains("memoryCandidatePage")) {
                    // Capture the restart's history and editor baseline only
                    // after the startup reads and their dependent controls.
                    if (!session.diagnostics().value("pendingCommands").toList().isEmpty()) return;
                    *step = 78;
                    timer->stop();
                    MemoryCandidatePageCheck::run(window, &session, &archiveEditor, args.value("test-cycle") == "2",
                        args.value("test-report"),
                        [&, result, step, ticks, timer](QVariantMap check) {
                            (*result)["memoryCandidatePage"] = QJsonObject::fromVariantMap(check);
                            *step = 79;
                            *ticks = 0;
                            timer->start();
                        });
                    return;
                }
                if (*step == 79) {
                    const auto check = (*result)["memoryCandidatePage"].toObject();
                    if (!check["passed"].toBool()) {
                        finish(false, check["error"].toString());
                        *step = 99;
                        return;
                    }
                    *step = 0;
                    return;
                }
                // The paged memory list also comes before the ordinary flow: the first cycle
                // pages, filters, edits and rejects on the seeded list, the restart reads it back.
                if (*step == 0 && session.connected() && p1MemoryEntry && !result->contains("memoryPage")) {
                    *step = 86;
                    timer->stop();
                    MemoryPageCheck::run(window, &session, args.value("test-cycle") == "2", args.value("test-report"),
                                         [&, result, step, ticks, timer](QVariantMap check) {
                                             (*result)["memoryPage"] = QJsonObject::fromVariantMap(check);
                                             *step = 87;
                                             *ticks = 0;
                                             timer->start();
                                         }, true, !candidatePagingEntry);
                    return;
                }
                if (*step == 87) {
                    const auto check = (*result)["memoryPage"].toObject();
                    if (!check["passed"].toBool()) {
                        finish(false, check["error"].toString());
                        *step = 99;
                        return;
                    }
                    // The recall check owns its own 20 s segment after the
                    // existing paging deadline and keeps the completed list
                    // open, avoiding an entry-triggered management refresh.
                    *step = 82;
                    timer->stop();
                    MemoryRecallCheck::run(window, &session, &archiveEditor, args.value("test-cycle") == "2",
                                           args.value("test-report"), [&, result, step, ticks, timer](QVariantMap recall) {
                                               (*result)["memoryRecall"] = QJsonObject::fromVariantMap(recall);
                                               *step = 83;
                                               *ticks = 0;
                                               timer->start();
                                           });
                    return;
                }
                if (*step == 83) {
                    const auto check = (*result)["memoryRecall"].toObject();
                    if (!check["passed"].toBool()) {
                        finish(false, check["error"].toString());
                        *step = 99;
                        return;
                    }
                    *step = 0;
                    return;
                }
                // The profile restart owns the first profile read on disk,
                // before the ordinary flow can type anything into the page.
                if (*step == 0 && session.connected() && p1ProfileEntry && args.value("test-cycle") == "2" &&
                    !result->contains("profileClear")) {
                    *step = 88;
                    timer->stop();
                    ProfileClearCheck::run(window, &session, &archiveEditor, true, args.value("test-report"),
                                           [&, result, step, ticks, timer](QVariantMap check) {
                                               (*result)["profileClear"] = QJsonObject::fromVariantMap(check);
                                               *step = 89;
                                               *ticks = 0;
                                               timer->start();
                                           });
                    return;
                }
                if (*step == 89) {
                    const auto check = (*result)["profileClear"].toObject();
                    if (!check["passed"].toBool()) {
                        finish(false, check["error"].toString());
                        *step = 99;
                        return;
                    }
                    *step = 0;
                    return;
                }
                if (*step == 0 && session.connected()) {
                    if (p1PersonaEntry && !result->contains("startupPersona")) {
                        const auto personas = session.state().value("personas").toMap();
                        bool pending = false;
                        for (const auto &value : session.diagnostics().value("pendingCommands").toList())
                            pending = pending || value.toMap().value("command").toString() == "persona:list" ||
                                      value.toMap().value("command").toString() == "persona:get";
                        if (pending || !personas.contains("profiles"))
                            return;
                        const auto profiles = personas.value("profiles").toList();
                        const bool first = args.value("test-cycle") == "1";
                        // The first cycle ends on the imported 「测试人格·月」, so the restart starts on it.
                        QString expectedActive = first ? "default" : QString();
                        for (const auto &value : profiles)
                            if (!first && value.toMap().value("name").toString() == "测试人格·月")
                                expectedActive = value.toMap().value("id").toString();
                        if (expectedActive.isEmpty() || personas.value("active_id").toString() != expectedActive ||
                            profiles.size() != (first ? 2 : 4) || !session.runtimeWritable() ||
                            session.recoveryState() != "clean")
                            throw std::runtime_error("PERSONA_STARTUP_IDENTITY_OR_PROFILE_COUNT");
                        (*result)["startupPersona"] = QJsonObject{{"activeId", expectedActive}, {"profiles", int(profiles.size())},
                                                               {"runtimeWritable", true}, {"recoveryState", "clean"}};
                    }
                    if (p1PersonaEntry && !result->contains("draftAssertions")) {
                        if (!whenReady("chatComposer", [&] {
                                recordDraft("before-first-synthetic-input", "");
                                window->grabWindow().save(args.value("test-report") + ".before-first-synthetic-input.png");
                            }))
                            return;
                    }
                    click("nav-settings");
                    *step = 1;
                    *ticks = 0;
                    return;
                }
                if (*step == 1 && *ticks > 4) {
                    // The provider restart proves the saved key is sent at startup, so
                    // nothing is tested or saved before its own check.
                    if (p1ProviderEntry && args.value("test-cycle") == "2") {
                        click("nav-character");
                        *step = 3;
                        return;
                    }
                    if (!whenReady("providerEndpoint", [&] {
                            type("providerEndpoint", args.value("test-endpoint"));
                            type("providerModel", "reverie-qt-test");
                            click("testProvider");
                        }))
                        return;
                    *step = 2;
                    return;
                }
                if (*step == 2 && session.state()["providerTestReady"].toBool()) {
                    click("saveProvider");
                    click("nav-character");
                    if (args.value("test-cycle") == "1")
                        session.importModel(QUrl::fromLocalFile(args.value("test-model")));
                    *step = 3;
                    return;
                }
                if (*step == 3) {
                    if (args.value("test-cycle") == "1") {
                        if (!session.avatarCandidate()["previewReady"].toBool() ||
                            session.avatarBusy())
                            return;
                        click("modelRights");
                        click("modelWarnings");
                        click("confirmModel");
                    } else if (!session.avatarState().contains("就绪"))
                        return;
                    *step = 4;
                    return;
                }
                if (*step == 4 && session.avatarCandidate().isEmpty() &&
                    session.avatarState().contains("就绪")) {
                    click("nav-memory");
                    *step = 5;
                    *ticks = 0;
                    return;
                }
                if (*step == 5 && *ticks > 4) {
                    auto *surface = visualItem(window->contentItem(), "drawer-memory");
                    if (!surface || !surface->property("inputReady").toBool())
                        return;
                    if (args.value("test-cycle") == "1") {
                        // New archives require an explicit empty-book save and
                        // a local entry creation before editing its content.
                        if (!archiveEditor.hasBook()) {
                            if (whenReady("newWorldbook", [&] { click("newWorldbook"); }))
                                enterArchiveInput(51);
                            return;
                        }
                        if (!archiveEditor.hasEntry()) {
                            if (whenReady("newWorldbookEntry", [&] { click("newWorldbookEntry"); }))
                                enterArchiveInput(53);
                            return;
                        }
                        enterArchiveInput(53);
                        return;
                    }
                    *step = 6;
                    return;
                }
                if (*step == 51) {
                    if (!archiveInput(true))
                        return;
                    *step = 52;
                    return;
                }
                if (*step == 52) {
                    if (archiveEditor.status() == "error" || archiveEditor.status() == "conflict")
                        throw std::runtime_error("INITIAL_EMPTY_BOOK_SAVE_FAILED");
                    if (archiveEditor.busy() || archiveEditor.dirty() || !archiveEditor.hasBook())
                        return;
                    if (whenReady("newWorldbookEntry", [&] { click("newWorldbookEntry"); }))
                        enterArchiveInput(53);
                    return;
                }
                if (*step == 53) {
                    if (!archiveInput(false))
                        return;
                    *step = 6;
                    return;
                }
                if (*step == 6) {
                    if (archiveEditor.busy())
                        return;
                    if (archiveEditor.status() == "error" || archiveEditor.status() == "conflict" ||
                        archiveEditor.status() == "read-error")
                        throw std::runtime_error("INITIAL_WORLDBOOK_NOT_CONFIRMED");
                    if (args.value("test-cycle") == "1" &&
                        (archiveEditor.dirty() || !archiveEditor.hasEntry()))
                        return;
                    auto ar = session.state()["archive"].toMap();
                    if (ar["revision"].toInt() < 1)
                        return;
                    (*result)["archiveRevision"] = ar["revision"].toInt();
                    (*result)["nativeControls"] = true;
                    click("nav-chat");
                    *step = 7;
                    *ticks = 0;
                    return;
                }
                if (*step == 7 && *ticks > 4) {
                    if (!whenReady("chatComposer", [&] {
                            type("chatComposer", "原生场景中的合成草稿");
                            click("nav-settings");
                        }))
                        return;
                    *step = 8;
                    return;
                }
                if (*step == 8) {
                    if (session.draft() != "原生场景中的合成草稿")
                        throw std::runtime_error("DRAFT_LOST");
                    if (p1PersonaEntry)
                        recordDraft("after-startup-synthetic-input", "原生场景中的合成草稿");
                    click("nav-chat");
                    *step = 9;
                    *ticks = 0;
                    return;
                }
                if (*step == 9 && *ticks > 4) {
                    if (args.value("test-cycle") == "1") {
                        if (!whenReady("chatComposer", [&] {
                                type("chatComposer", "你好，我喜欢和你一起看星空。");
                                click("sendChat");
                                (*result)["chatDuringNavigationBefore"] =
                                    QJsonObject::fromVariantMap(session.diagnostics());
                                (*result)["chatAvatarLoads"] =
                                    window->findChild<NativeAvatar *>("nativeAvatar")->loads();
                            }))
                            return;
                        *step = 90;
                    } else
                        *step = 10;
                    return;
                }
                if (*step == 90 && session.busy()) {
                    click("nav-memory");
                    *step = 91;
                    *ticks = 0;
                    return;
                }
                if (*step == 91 && *ticks > 5) {
                    if (!session.busy())
                        throw std::runtime_error("CHAT_FINISHED_BEFORE_INTERACTION");
                    click("memory-close");
                    click("nav-settings");
                    *step = 92;
                    *ticks = 0;
                    return;
                }
                if (*step == 92 && *ticks > 5) {
                    if (!session.busy())
                        throw std::runtime_error("CHAT_NOT_ACTIVE_DURING_PANEL_SWITCH");
                    if (window->findChild<NativeAvatar *>("nativeAvatar")->loads() !=
                        (*result)["chatAvatarLoads"].toInt())
                        throw std::runtime_error("MODEL_RELOADED_DURING_CHAT_NAVIGATION");
                    (*result)["chatDuringNavigationAfter"] =
                        QJsonObject::fromVariantMap(session.diagnostics());
                    click("settings-close");
                    click("nav-chat");
                    *step = 10;
                    return;
                }
                if (*step == 10 && !session.busy() && session.messages().size() >= 2) {
                    auto *av = window->findChild<NativeAvatar *>("nativeAvatar");
                    (*result)["loadsBeforeResize"] = av->loads();
                    window->resize(950, 760);
                    *step = 11;
                    *ticks = 0;
                    return;
                }
                if (*step == 11 && *ticks > 4) {
                    window->grabWindow().save(args.value("test-report") + ".narrow.png");
                    auto *i = visualItem(window->contentItem(), "chatComposer");
                    if (!i || i->width() < 260 || i->height() < 28)
                        throw std::runtime_error("COMPOSER_TOO_SMALL");
                    window->resize(1380, 900);
                    click("nav-settings");
                    *step = 93;
                    *ticks = 0;
                    return;
                }
                if (*step == 93 && *ticks > 5) {
                    // Rest the pointer on a switch so its hover state is captured.
                    auto *i = visualItem(window->contentItem(), "reduceMotion");
                    if (!i || !i->isVisible())
                        throw std::runtime_error("CONTROL_UNAVAILABLE:reduceMotion");
                    QTest::mouseMove(window, i->mapToScene(QPointF(i->width() / 2, i->height() / 2)).toPoint());
                    *step = 95;
                    *ticks = 0;
                    return;
                }
                if (*step == 95 && *ticks > 2) {
                    window->grabWindow().save(args.value("test-report") + ".switch-hover.png");
                    click("reduceMotion");
                    click("reduceTransparency");
                    click("settings-close");
                    auto *av = window->findChild<NativeAvatar *>("nativeAvatar");
                    (*result)["reducedBefore"] = QJsonObject::fromVariantMap(av->diagnostics());
                    av->forceActiveFocus();
                    QTest::keyClick(window, Qt::Key_Return);
                    *step = 12;
                    *ticks = 0;
                    return;
                }
                if (*step == 12 && *ticks > 10) {
                    auto *av = window->findChild<NativeAvatar *>("nativeAvatar");
                    auto before = (*result)["reducedBefore"].toObject();
                    auto after = QJsonObject::fromVariantMap(av->diagnostics());
                    if (std::abs(after["idleSeconds"].toDouble() -
                                 before["idleSeconds"].toDouble()) > .08 ||
                        after["userAnimationSeconds"].toDouble() <=
                            before["userAnimationSeconds"].toDouble() + .2)
                        throw std::runtime_error(
                            "REDUCED_MOTION_DISABLED_USER_ACTION_OR_KEPT_IDLE");
                    (*result)["reducedAfter"] = after;
                    window->grabWindow().save(args.value("test-report") + ".reduced.png");
                    click("nav-settings");
                    *step = 94;
                    *ticks = 0;
                    return;
                }
                if (*step == 94 && *ticks > 3) {
                    click("reduceMotion");
                    click("reduceTransparency");
                    click("settings-close");
                    *step = 13;
                    *ticks = 0;
                    return;
                }
                if (*step == 13 && *ticks > 4) {
                    auto *av = window->findChild<NativeAvatar *>("nativeAvatar");
                    if (av->loads() != (*result)["loadsBeforeResize"].toInt() ||
                        av->paintedPixels() < 1000)
                        throw std::runtime_error("MODEL_LIFETIME_OR_FRAME_FAILED");
                    if (args.value("test-cycle") == "1") {
                        if (args.isSet("record-ui") && !args.isSet("record-demo") &&
                            !recorder.start(args.value("test-report") + ".mov"))
                            throw std::runtime_error(recorder.error().toStdString());
                        *step = 14;
                        timer->stop();
                        SceneSurfaceCheck::run(
                            window, av,
                            [&, result, timer, step](QVariantMap checks) {
                                (*result)["interaction"] = QJsonObject::fromVariantMap(checks);
                                *step = 15;
                                timer->start();
                            },
                            !args.isSet("record-ui"), transitionDiagnostics,
                            [&] { return QVariantMap{{"scope", session.scopeKey()},
                                {"generation", session.generation()}, {"revision", archiveEditor.revision()},
                                {"bookId", archiveEditor.selectedBookKey()}, {"entryId", archiveEditor.selectedEntryKey()}}; });
                    } else if (p1SettingsEntry) {
                        // The restart only reads the saved settings back.
                        *step = 27;
                        timer->stop();
                        SettingsSectionsCheck::run(window, &session, true, args.value("test-report"),
                                                   [&, result, step, timer](QVariantMap data) {
                                                       (*result)["settingsSections"] = QJsonObject::fromVariantMap(data);
                                                       *step = 28;
                                                       timer->start();
                                                   });
                    } else if (p1ProviderEntry) {
                        // The restart uses the key it saved, then deletes it.
                        *step = 33;
                        timer->stop();
                        ProviderCredentialCheck::run(window, &session, true, providerFixture, args.value("test-report"),
                                                     [&, result, step, timer](QVariantMap data) {
                                                         (*result)["providerCredential"] = QJsonObject::fromVariantMap(data);
                                                         *step = 34;
                                                         timer->start();
                                                     });
                    } else if (p1PersonaEntry) {
                        // The restart starts on the imported persona and reads its switches back.
                        *step = 29;
                        timer->stop();
                        ArchiveInteractionCheck::runPersonaRestart(
                            window, &session, &archiveEditor, args.value("test-report"),
                            [&, result, step, timer](QVariantMap data) {
                                (*result)["personaRestart"] = QJsonObject::fromVariantMap(data);
                                *step = 30;
                                timer->start();
                            });
                    } else if (p1WorldbookInjectionEntry) {
                        *step = 59; timer->stop();
                        WorldbookInjectionCheck::run(window, &session, &archiveEditor, true, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookInjection"] = QJsonObject::fromVariantMap(data);
                                *step = 60; timer->start();
                            });
                        return;
                    } else if (p1WorldbookRegexEntry) {
                        *step = 57;
                        timer->stop();
                        WorldbookRegexCheck::run(window, &session, &archiveEditor, true, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookRegex"] = QJsonObject::fromVariantMap(data);
                                *step = 58; timer->start();
                            });
                        return;
                    } else if (p1WorldbookEntryEntry) {
                        // The original restart controls have passed; only the
                        // entry-settings read-back follows, then the same finish.
                        *step = 55;
                        timer->stop();
                        WorldbookEntrySettingsCheck::run(window, &session, &archiveEditor, true, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookEntrySettings"] = QJsonObject::fromVariantMap(data);
                                *step = 56; timer->start();
                            });
                        return;
                    } else if (p1MemoryEntry && !candidatePagingEntry) {
                        // The restart's original controls and model assertions
                        // have finished. A separate 20 s segment reads only the
                        // already seeded summary, then resumes the same finish.
                        *step = 39;
                        timer->stop();
                        const auto baseline = (*result)["memoryPage"].toObject()["observed"].toObject()["restartIds"].toArray();
                        QStringList ids;
                        for (const auto &id : baseline) ids.append(id.toString());
                        SummaryViewCheck::run(window, &session, &archiveEditor, true, ids, args.value("test-report"),
                            [result, step, ticks, timer](QVariantMap data) {
                                (*result)["summaryView"] = QJsonObject::fromVariantMap(data);
                                *step = 40; *ticks = 0; timer->start();
                            });
                        return;
                    } else if (p1MemoryEntry && candidatePagingEntry) {
                        // The original restart read-back of every pending
                        // candidate has passed; only then may this segment
                        // decide five of them.
                        *step = 43;
                        timer->stop();
                        const auto baseline = (*result)["memoryCandidatePage"].toObject()["observed"].toObject()["finalCandidateIds"].toArray();
                        QStringList ids;
                        for (const auto &id : baseline) ids.append(id.toString());
                        MemoryCandidateBatchCheck::run(window, &session, ids, args.value("test-report"),
                            [result, step, ticks, timer](QVariantMap data) {
                                (*result)["memoryCandidateBatch"] = QJsonObject::fromVariantMap(data);
                                *step = 44; *ticks = 0; timer->start();
                            });
                        return;
                    } else {
                        finish(true);
                        *step = 16;
                    }
                }
                if (*step == 44) {
                    const auto check = (*result)["memoryCandidateBatch"].toObject();
                    finish(check["passed"].toBool(), check["error"].toString());
                    *step = 99;
                    return;
                }
                if (*step == 34) {
                    const auto checks = (*result)["providerCredential"].toObject();
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99;
                    return;
                }
                if (*step == 30) {
                    const auto checks = (*result)["personaRestart"].toObject();
                    if (!checks["passed"].toBool()) { finish(false, checks["error"].toString()); *step = 99; return; }
                    *step = 45; timer->stop();
                    WorldbookPriorityCheck::run(window, &session, &archiveEditor, true, args.value("test-report"),
                        [result, step, timer](QVariantMap data) {
                            (*result)["worldbookPriority"] = QJsonObject::fromVariantMap(data);
                            *step = 46; timer->start();
                        });
                    return;
                }
                if (*step == 46) {
                    const auto checks = (*result)["worldbookPriority"].toObject();
                    if (!checks["passed"].toBool()) { finish(false, checks["error"].toString()); *step = 99; return; }
                    *step = 47; timer->stop();
                    // The book-settings tail follows the priority tail in the same cycle mode.
                    WorldbookBookSettingsCheck::run(window, &session, &archiveEditor, checks["mode"].toString() == "restart-readback",
                        args.value("test-report"), [result, step, timer](QVariantMap data) {
                            (*result)["worldbookBookSettings"] = QJsonObject::fromVariantMap(data);
                            *step = 48; timer->start();
                        });
                    return;
                }
                if (*step == 48) {
                    const auto checks = (*result)["worldbookBookSettings"].toObject();
                    if (p1PersonaEntry && checks["passed"].toBool() && !result->contains("cardEdit")) {
                        timer->stop();
                        PersonaProfileEditCheck::run(window, &session, &archiveEditor, args.value("test-cycle") == "2",
                            [result, timer](QVariantMap data) {
                                (*result)["cardEdit"] = QJsonObject::fromVariantMap(data);
                                timer->start();
                            });
                        return;
                    }
                    if (p1PersonaEntry && result->contains("cardEdit")) {
                        const auto edit = (*result)["cardEdit"].toObject();
                        if (!edit["passed"].toBool()) { finish(false, edit["error"].toString()); *step = 99; return; }
                    }
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99; return;
                }
                if (*step == 56) {
                    const auto checks = (*result)["worldbookEntrySettings"].toObject();
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99; return;
                }
                if (*step == 60) {
                    const auto checks = (*result)["worldbookInjection"].toObject();
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99; return;
                }
                if (*step == 58) {
                    const auto checks = (*result)["worldbookRegex"].toObject();
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99; return;
                }
                if (*step == 28) {
                    const auto checks = (*result)["settingsSections"].toObject();
                    finish(checks["passed"].toBool(), checks["error"].toString());
                    *step = 99;
                    return;
                }
                if (*step == 15) {
                    const auto checks = (*result)["interaction"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 18;
                        return;
                    }
                    *step = 16;
                    timer->stop();
                    if (args.isSet("record-demo")) {
                        if (!args.isSet("record-ui") || !recorder.start(args.value("test-report") + ".mov"))
                            throw std::runtime_error("DEMONSTRATION_RECORDING_START_FAILED");
                        window->setProperty("reverieDemoRecording", true);
                    }
                    window->setProperty("reverieRecording", args.isSet("record-ui"));
                    MoonroomInteractionCheck::run(
                        window, &session, &archiveEditor, args.value("test-report"),
                        [&, result, step, timer](QVariantMap data) {
                            (*result)["moonroom"] = QJsonObject::fromVariantMap(data);
                            *step = 20;
                            timer->start();
                        });
                }
                if (*step == 20) {
                    const auto checks = (*result)["moonroom"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 99;
                        return;
                    }
                    *step = 21;
                    timer->stop();
                    ArchiveInteractionCheck::run(
                        window, &session, &archiveEditor,
                        [&testRejectWrite] { testRejectWrite = true; }, args.value("test-report"),
                        [&, result, step, timer](QVariantMap data) {
                            (*result)["archiveInteraction"] = QJsonObject::fromVariantMap(data);
                            *step = 22;
                            *ticks = 0;
                            timer->start();
                        }, p1RestoreEntry, p1PersonaEntry);
                }
                if (*step == 22) {
                    const auto checks = (*result)["archiveInteraction"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 99;
                        return;
                    }
                    if (p1MemoryEntry && !candidatePagingEntry && args.value("test-cycle") == "1" && !result->contains("memoryBatchDelete")) {
                        *step = 37;
                        timer->stop();
                        const auto baseline = (*result)["memoryPage"].toObject()["observed"].toObject()["finalIds"].toArray();
                        QStringList ids;
                        for (const auto &id : baseline) ids.append(id.toString());
                        MemoryBatchDeleteCheck::run(window, &session, ids, args.value("test-report"),
                            [&, result, step, ticks, timer](QVariantMap check) {
                                (*result)["memoryBatchDelete"] = QJsonObject::fromVariantMap(check);
                                *step = 38; *ticks = 0; timer->start();
                            });
                        return;
                    }
                    // The existing profile, backup and worldbook assertions
                    // have all finished with their original 小星 fixture.
                    if (p1ProfileEntry) {
                        *step = 35;
                        timer->stop();
                        ProfileClearCheck::run(window, &session, &archiveEditor, false, args.value("test-report"),
                                               [&, result, step, ticks, timer](QVariantMap data) {
                                                   (*result)["profileClear"] = QJsonObject::fromVariantMap(data);
                                                   *step = 36;
                                                   *ticks = 0;
                                                   timer->start();
                                               });
                        return;
                    }
                    if (p1ProviderEntry) {
                        *step = 31;
                        timer->stop();
                        ProviderCredentialCheck::run(window, &session, false, providerFixture, args.value("test-report"),
                                                     [&, result, step, timer](QVariantMap data) {
                                                         (*result)["providerCredential"] = QJsonObject::fromVariantMap(data);
                                                         *step = 32;
                                                         *ticks = 0;
                                                         timer->start();
                                                     });
                        return;
                    }
                    if (p1SettingsEntry) {
                        *step = 25;
                        timer->stop();
                        SettingsSectionsCheck::run(window, &session, false, args.value("test-report"),
                                                   [&, result, step, timer](QVariantMap data) {
                                                       (*result)["settingsSections"] = QJsonObject::fromVariantMap(data);
                                                       *step = 26;
                                                       *ticks = 0;
                                                       timer->start();
                                                   });
                        return;
                    }
                    click("nav-settings");
                    *step = 23;
                    *ticks = 0;
                }
                if (*step == 38) {
                    const auto check = (*result)["memoryBatchDelete"].toObject();
                    if (!check["passed"].toBool()) { finish(false, check["error"].toString()); *step = 99; return; }
                    *step = 22;
                    return;
                }
                if (*step == 36) {
                    const auto checks = (*result)["profileClear"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 99;
                        return;
                    }
                    click("nav-settings");
                    *step = 23;
                    *ticks = 0;
                }
                if (*step == 32) {
                    const auto checks = (*result)["providerCredential"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 99;
                        return;
                    }
                    click("nav-settings");
                    *step = 23;
                    *ticks = 0;
                }
                if (*step == 26) {
                    const auto checks = (*result)["settingsSections"].toObject();
                    if (!checks["passed"].toBool()) {
                        finish(false, checks["error"].toString());
                        *step = 99;
                        return;
                    }
                    click("nav-settings");
                    *step = 23;
                    *ticks = 0;
                }
                if (*step == 23 && *ticks > 6) {
                    click("settings-close");
                    *step = 24;
                    *ticks = 0;
                }
                if (*step == 24 && *ticks > 6) {
                    if (p1PersonaEntry) {
                        *step = 45; timer->stop();
                        WorldbookPriorityCheck::run(window, &session, &archiveEditor, false, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookPriority"] = QJsonObject::fromVariantMap(data);
                                *step = 46; timer->start();
                            });
                        return;
                    }
                    if (p1MemoryEntry && !candidatePagingEntry && !result->contains("summaryView")) {
                        *step = 39;
                        timer->stop();
                        const auto baseline = (*result)["memoryBatchDelete"].toObject()["observed"].toObject()["remainingIds"].toArray();
                        QStringList ids;
                        for (const auto &id : baseline) ids.append(id.toString());
                        SummaryViewCheck::run(window, &session, &archiveEditor, false, ids, args.value("test-report"),
                            [result, step, ticks, timer](QVariantMap data) {
                                (*result)["summaryView"] = QJsonObject::fromVariantMap(data);
                                *step = 40; *ticks = 0; timer->start();
                            });
                        return;
                    }
                    if (p1WorldbookInjectionEntry) {
                        *step = 59; timer->stop();
                        WorldbookInjectionCheck::run(window, &session, &archiveEditor, false, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookInjection"] = QJsonObject::fromVariantMap(data);
                                *step = 60; timer->start();
                            });
                        return;
                    }
                    if (p1WorldbookRegexEntry) {
                        *step = 57; timer->stop();
                        WorldbookRegexCheck::run(window, &session, &archiveEditor, false, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookRegex"] = QJsonObject::fromVariantMap(data);
                                *step = 58; timer->start();
                            });
                        return;
                    }
                    if (p1WorldbookEntryEntry) {
                        *step = 55; timer->stop();
                        WorldbookEntrySettingsCheck::run(window, &session, &archiveEditor, false, args.value("test-report"),
                            [result, step, timer](QVariantMap data) {
                                (*result)["worldbookEntrySettings"] = QJsonObject::fromVariantMap(data);
                                *step = 56; timer->start();
                            });
                        return;
                    }
                    finish(true);
                    *step = 99;
                }
                if (*step == 40) {
                    const auto check = (*result)["summaryView"].toObject();
                    if (!check["passed"].toBool()) { finish(false, check["error"].toString()); *step = 99; return; }
                    const bool restart = args.value("test-cycle") == "2";
                    const auto baseline = restart
                        ? (*result)["memoryPage"].toObject()["observed"].toObject()["restartIds"].toArray()
                        : (*result)["memoryBatchDelete"].toObject()["observed"].toObject()["remainingIds"].toArray();
                    QStringList ids; for (const auto &id : baseline) ids.append(id.toString());
                    *step = 41; timer->stop();
                    MemoryBatchPinCheck::run(window, &session, restart, ids, args.value("test-report"),
                        [result, step, timer](QVariantMap data) {
                            (*result)["memoryBatchPin"] = QJsonObject::fromVariantMap(data);
                            *step = 42; timer->start();
                        });
                    return;
                }
                if (*step == 42) {
                    const auto check = (*result)["memoryBatchPin"].toObject();
                    finish(check["passed"].toBool(), check["error"].toString());
                    *step = 99;
                    return;
                }
            } catch (const std::exception &e) {
                finish(false, e.what());
            }
        });
        timer->start();
    }
    const int result = app.exec();
    if (previewMode) recordPreview("exit", "OK", result);
    return result;
}
