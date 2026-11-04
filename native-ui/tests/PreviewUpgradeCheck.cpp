#include "PreviewUpgradeCheck.h"
#include "../src/Keychain.h"
#include "../src/StorageKeyChannel.h"
#include "../src/PreviewWorkspace.h"
#include "../src/PreviewDataFormat.h"
#include "PreviewUpgradeTrust.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QProcess>
#include <QProcessEnvironment>
#include <QRandomGenerator>
#include <QRegularExpression>
#include <QSet>
#include <QUrl>
#include <QUuid>
#include <QtEndian>
#include <algorithm>
#include <fcntl.h>
#include <stdexcept>
#include <signal.h>
#include <sys/stat.h>
#include <unistd.h>

namespace PreviewUpgradeCheck {
namespace {
void need(bool condition, const char *code) { if (!condition) throw std::runtime_error(code); }
QString digest(const QByteArray &bytes) {
    return QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
}
QString id() { return QUuid::createUuid().toString(QUuid::Id128); }
QByteArray json(const QJsonObject &value) { return QJsonDocument(value).toJson(QJsonDocument::Compact); }
QJsonObject readObject(const QString &path) {
    QFile file(path);
    need(file.open(QIODevice::ReadOnly) && file.size() <= 65536, "PREVIEW_UPGRADE_CONTEXT_READ");
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(file.readAll(), &error);
    need(error.error == QJsonParseError::NoError && document.isObject(), "PREVIEW_UPGRADE_CONTEXT_JSON");
    return document.object();
}
QString trustedFileHash(const QString &path) {
    struct stat before{}, opened{}, after{}, named{};
    need(::lstat(QFile::encodeName(path).constData(), &before) == 0 && S_ISREG(before.st_mode) &&
         before.st_uid == ::getuid() && before.st_nlink == 1 && QFileInfo(path).canonicalFilePath() == path,
         "PREVIEW_UPGRADE_VERIFIER_FILE_UNSAFE");
    const int descriptor = ::open(QFile::encodeName(path).constData(), O_RDONLY | O_NOFOLLOW | O_CLOEXEC);
    QFile file;
    if (descriptor < 0) throw std::runtime_error("PREVIEW_UPGRADE_VERIFIER_FILE_UNSAFE");
    if (::fstat(descriptor, &opened) != 0 || opened.st_dev != before.st_dev || opened.st_ino != before.st_ino ||
        opened.st_size != before.st_size || !file.open(descriptor, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) {
        ::close(descriptor); throw std::runtime_error("PREVIEW_UPGRADE_VERIFIER_FILE_CHANGED");
    }
    QCryptographicHash hash(QCryptographicHash::Sha256);
    need(hash.addData(&file) && ::fstat(descriptor, &after) == 0 &&
         ::lstat(QFile::encodeName(path).constData(), &named) == 0 &&
         after.st_dev == before.st_dev && after.st_ino == before.st_ino && after.st_size == before.st_size &&
         after.st_mtime == before.st_mtime && after.st_ctime == before.st_ctime && after.st_nlink == 1 &&
         named.st_dev == before.st_dev && named.st_ino == before.st_ino,
         "PREVIEW_UPGRADE_VERIFIER_FILE_CHANGED");
    return QString::fromLatin1(hash.result().toHex());
}
QProcessEnvironment privateEnvironment(const QString &workspace, const QString &runtimeRoot) {
    QProcessEnvironment env;
    for (const auto *name : {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "LC_ALL"})
        if (qEnvironmentVariableIsSet(name)) env.insert(name, qEnvironmentVariable(name));
    env.insert("PATH", runtimeRoot + "/.tools/node/bin:/usr/bin:/bin:/usr/sbin:/sbin");
    env.insert("PYTHONNOUSERSITE", "1"); env.insert("PYTHONDONTWRITEBYTECODE", "1"); env.insert("PYTHON_DOTENV_DISABLED", "1");
    env.insert("XDG_CACHE_HOME", workspace + "/data/cache"); env.insert("HF_HOME", workspace + "/data/cache/huggingface");
    env.insert("HF_HUB_CACHE", workspace + "/data/cache/huggingface/hub"); env.insert("TORCH_HOME", workspace + "/data/cache/torch");
    env.insert("HF_HUB_OFFLINE", "1"); env.insert("TRANSFORMERS_OFFLINE", "1");
    env.insert("MPLCONFIGDIR", workspace + "/data/cache/matplotlib");
    return env;
}
QJsonObject identityOf(const QJsonObject &runtime) {
    return {{"candidate", runtime["candidate"]}, {"sourceHead", runtime["sourceHead"]}, {"buildManifestSha256", runtime["buildManifestSha256"]}};
}
void verifySelectedRuntime(const QString &selectedRoot, const QString &selectedPython, const QString &workspace,
                           const QJsonObject &context) {
    // Only the installation containing this actual executable supplies a
    // verifier. Neither the chosen backend nor caller-controlled metadata can
    // choose Node, preload options, or an alternate verification script.
    const auto executable = QFileInfo(QCoreApplication::applicationFilePath()).canonicalFilePath();
    QDir directory(QFileInfo(executable).absolutePath());
    for (int n = 0; n < 4; ++n) need(directory.cdUp(), "PREVIEW_UPGRADE_SELF_RUNTIME_LAYOUT");
    const auto selfRoot = directory.canonicalPath();
    need(executable == selfRoot + "/candidate/Reverie Scene.app/Contents/MacOS/Reverie Scene", "PREVIEW_UPGRADE_SELF_RUNTIME_LAYOUT");
    const auto checkVerifier = [&] {
        QSet<QString> actual;
        for (const auto &entry : PreviewUpgradeTrust::VerifierFiles) {
            const auto relative = QString::fromUtf8(entry.path);
            need(!actual.contains(relative) && trustedFileHash(selfRoot + '/' + relative) == QString::fromUtf8(entry.sha256),
                 "PREVIEW_UPGRADE_VERIFIER_HASH_CHANGED"); actual.insert(relative);
        }
        need(actual == QSet<QString>{".tools/node/bin/node", "native-ui/preview-runtime.cjs", "native-ui/build-record.cjs"},
             "PREVIEW_UPGRADE_VERIFIER_DEPENDENCY_SET");
    };
    checkVerifier();
    const auto verify = [&](const QString &root) {
        QProcess verifier; verifier.setWorkingDirectory(selfRoot); verifier.setProcessEnvironment(privateEnvironment(workspace, selfRoot));
        const QString program = QStringLiteral("const fs=require('node:fs'),c=require('node:crypto');"
            "const r=require(process.argv[1]).verifyRuntime(process.argv[2]);"
            "const m=JSON.parse(fs.readFileSync(r.metadataPath));"
            "const b=JSON.parse(fs.readFileSync(r.runtimeRoot+'/candidate/build.json'));"
            "console.log(JSON.stringify({...r,buildManifestSha256:m.buildManifestSha256,"
            "runtimeInputsSha256:b.source.runtimeInputs.sha256,"
            "pythonSha256:c.createHash('sha256').update(fs.readFileSync(r.python)).digest('hex')}));");
        verifier.start(selfRoot + "/.tools/node/bin/node", {"-e", program, selfRoot + "/native-ui/preview-runtime.cjs", root});
        need(verifier.waitForStarted(5000) && verifier.waitForFinished(60000) && verifier.exitStatus() == QProcess::NormalExit &&
             verifier.exitCode() == 0, "PREVIEW_UPGRADE_RUNTIME_VERIFICATION_FAILED");
        const auto payload = verifier.readAllStandardOutput(); need(payload.size() <= 65536, "PREVIEW_UPGRADE_RUNTIME_VERIFICATION_LIMIT");
        QJsonParseError error; const auto value = QJsonDocument::fromJson(payload, &error);
        need(error.error == QJsonParseError::NoError && value.isObject(), "PREVIEW_UPGRADE_RUNTIME_VERIFICATION_JSON");
        return value.object();
    };
    const auto self = verify(selfRoot);
    need(self["runtimeRoot"] == selfRoot && self["hostExecutable"] == executable &&
         self["sourceHead"] == QString::fromUtf8(PreviewUpgradeTrust::CurrentSourceHead) &&
         self["runtimeInputsSha256"] == QString::fromUtf8(PreviewUpgradeTrust::CurrentRuntimeInputsSha256) &&
         self["pythonSha256"] == QString::fromUtf8(PreviewUpgradeTrust::CurrentPythonSha256), "PREVIEW_UPGRADE_SELF_IDENTITY_CHANGED");
    const auto selected = selectedRoot == selfRoot ? self : verify(selectedRoot);
    const QJsonObject previous{{"candidate", PreviewUpgradeTrust::PreviousCandidate}, {"sourceHead", PreviewUpgradeTrust::PreviousSourceHead},
                              {"buildManifestSha256", PreviewUpgradeTrust::PreviousBuildManifestSha256}};
    need(selected["runtimeRoot"] == selectedRoot && selected["python"] == selectedPython &&
         (selectedRoot == selfRoot || identityOf(selected) == previous) &&
         context["previewUpgradeIdentity"].toObject() == identityOf(selected) &&
         context["previewUpgradePublicResultSha256"] == QString::fromUtf8(PreviewUpgradeTrust::PreviousPublicResultSha256),
         "PREVIEW_UPGRADE_FROZEN_BACKEND_IDENTITY_CHANGED");
    // Check that verifier inputs did not change while verifying either runtime.
    checkVerifier();
}
QJsonObject arguments(const QStringList &raw) {
    QJsonObject result;
    const QSet<QString> allowed{"--context", "--data-dir", "--backend-root", "--backend-python",
        "--upgrade-action", "--upgrade-report", "--upgrade-endpoint", "--upgrade-model"};
    bool entry = false;
    for (qsizetype n = 0; n < raw.size(); ++n) {
        const auto option = raw[n];
        if (option == "--preview-upgrade-check") { need(!entry, "PREVIEW_UPGRADE_ARGUMENTS"); entry = true; continue; }
        need(allowed.contains(option) && !result.contains(option) && n + 1 < raw.size(), "PREVIEW_UPGRADE_ARGUMENTS");
        const auto value = raw[++n];
        need(!value.isEmpty() && !value.startsWith('-'), "PREVIEW_UPGRADE_ARGUMENTS");
        result[option] = value;
    }
    need(entry, "PREVIEW_UPGRADE_ARGUMENTS");
    for (const auto *key : {"--context", "--data-dir", "--backend-root", "--backend-python", "--upgrade-action", "--upgrade-report"})
        need(result.contains(key), "PREVIEW_UPGRADE_ARGUMENTS");
    const auto action = result["--upgrade-action"].toString();
    need(action == "seed" || action == "read", "PREVIEW_UPGRADE_ACTION");
    need((action == "seed") == result.contains("--upgrade-endpoint") &&
         (action == "seed") == result.contains("--upgrade-model"), "PREVIEW_UPGRADE_ARGUMENTS");
    return result;
}
class Backend {
public:
    QProcess process;
    QByteArray buffer;
    QJsonObject persona, ready;
    QJsonArray reads;
    quint64 receivedSequence = 0, lastReceiptSequence = 0;
    QString lastReceiptId, lastReceiptSha, activeChat, cleanChatText, displayChatText;
    QString activeConversation = QStringLiteral("dream-room");
    QJsonObject ownerModel, chatScope, bubbleSummary, doneSummary;
    static bool fixedMarker(const QString &text) {
        return QRegularExpression(QStringLiteral("(?<![A-Za-z0-9_])W5(?![A-Za-z0-9_])")).match(text).hasMatch();
    }
    void observeChat(const QJsonObject &event) {
        if (activeChat.isEmpty()) return;
        const auto type = event["type"].toString(); const auto payload = event["payload"].toObject();
        if (payload["request_id"] != activeChat) return;
        need(type != "error" && type != "chat:error" && type != "chat:cancelled" &&
             !QStringList{"failed", "failed_uncertain", "cancelled"}.contains(payload["state"].toString()) &&
             payload["error"].toString().isEmpty(), "PREVIEW_UPGRADE_CHAT_FAILED_OR_CANCELLED");
        if (type != "chat:bubble" && type != "chat:done") return;
        need(payload["conversation_id"] == activeConversation && payload["persona_id"] == persona["persona_id"] &&
             payload["persona_epoch"] == persona["epoch"] && payload["persona_fingerprint"] == persona["fingerprint"] &&
             payload["model_epoch"] == ownerModel["epoch"] && payload["model_fingerprint"] == ownerModel["fingerprint"] &&
             !payload["delivery_id"].toString().isEmpty(), "PREVIEW_UPGRADE_CHAT_SCOPE_MISMATCH");
        const QJsonObject scope{{"requestId", activeChat}, {"deliveryId", payload["delivery_id"]}, {"conversationId", payload["conversation_id"]},
            {"personaId", payload["persona_id"]}, {"personaEpoch", payload["persona_epoch"]}, {"personaFingerprint", payload["persona_fingerprint"]},
            {"modelEpoch", payload["model_epoch"]}, {"modelFingerprint", payload["model_fingerprint"]}};
        if (chatScope.isEmpty()) chatScope = scope;
        need(chatScope == scope, "PREVIEW_UPGRADE_CHAT_SCOPE_MISMATCH");
        if (type == "chat:bubble") {
            need(bubbleSummary.isEmpty() && doneSummary.isEmpty() && payload["index"].toInt(-1) == 0 &&
                 payload["bubble_index"].toInt(-1) == 0 && payload["total"].toInt() == 1 && payload["source"] == "assistant" &&
                 payload["text"].isString() && !payload["text"].toString().trimmed().isEmpty(), "PREVIEW_UPGRADE_CHAT_BUBBLE_INVALID");
            displayChatText = payload["text"].toString();
            bubbleSummary = {{"scopeSha256", digest(json(scope))}, {"sequence", qint64(receivedSequence)}, {"index", 0}, {"total", 1},
                {"displaySha256", digest(displayChatText.toUtf8())}, {"displayBytes", displayChatText.toUtf8().size()}};
            return;
        }
        const auto shown = payload["messages"].toArray(), clean = payload["clean_messages"].toArray();
        need(!bubbleSummary.isEmpty() && doneSummary.isEmpty() && payload["state"] == "done" && payload["incremental_delivery"] == true &&
             payload["degraded_to_local_reflex"] == false && shown.size() == 1 && clean.size() == 1 && shown[0].isString() && clean[0].isString() &&
             shown[0].toString().trimmed() == displayChatText, "PREVIEW_UPGRADE_CHAT_DONE_INVALID");
        cleanChatText = clean[0].toString().trimmed();
        need(!cleanChatText.isEmpty() && payload["reply"].toString().trimmed() == cleanChatText && fixedMarker(displayChatText) && fixedMarker(cleanChatText),
             "PREVIEW_UPGRADE_CHAT_CLEAN_OR_MARKER_INVALID");
        const auto receipt = digest(json(payload));
        doneSummary = {{"scopeSha256", digest(json(scope))}, {"sequence", qint64(receivedSequence)}, {"responseSha256", receipt},
            {"displaySha256", digest(displayChatText.toUtf8())}, {"displayBytes", displayChatText.toUtf8().size()},
            {"cleanSha256", digest(cleanChatText.toUtf8())}, {"cleanBytes", cleanChatText.toUtf8().size()},
            {"cleanCount", 1}, {"displayCount", 1}, {"stateDone", true}, {"incremental", true}, {"degraded", false},
            {"markerInDisplay", true}, {"markerInClean", true}};
        reads.append(QJsonObject{{"command", "chat:send"}, {"requestId", activeChat}, {"responseSha256", receipt}});
    }
    explicit Backend(const QString &root, const QString &python, const QString &workspace) {
        QByteArray key = storageKeyFor(workspace, KeychainDomain::Preview);
        StorageKeyChannel keyChannel("PREVIEW_UPGRADE_KEY_PIPE");
        QByteArray random(32, 0);
        for (auto &byte : random) byte = char(QRandomGenerator::system()->generate() & 255);
        const auto secret = QString::fromLatin1(random.toHex()); random.fill(0);
        QProcessEnvironment env;
        for (const auto *name : {"HOME", "USER", "LOGNAME", "TMPDIR", "LANG", "PATH"})
            if (qEnvironmentVariableIsSet(name)) env.insert(name, qEnvironmentVariable(name));
        for (const auto *name : {"PYTHONNOUSERSITE", "PYTHONDONTWRITEBYTECODE", "PYTHON_DOTENV_DISABLED", "PYTHONUNBUFFERED",
                                  "REVERIE_REQUIRE_ENCRYPTED_STORAGE", "HF_HUB_OFFLINE", "TRANSFORMERS_OFFLINE"}) env.insert(name, "1");
        env.insert("REVERIE_BRIDGE_MODE", "1"); env.insert("REVERIE_BRIDGE_PROTOCOL_VERSION", "4");
        env.insert("REVERIE_BRIDGE_SECRET", secret); env.insert("REVERIE_STORAGE_KEY_FD", "3");
        env.insert("REVERIE_PARENT_PID", QString::number(QCoreApplication::applicationPid()));
        env.insert("REVERIE_DATA_DIR", workspace + "/data"); env.insert("REVERIE_LOCAL_MODE", "0");
        env.insert("REVERIE_LOCAL_MODE_EPOCH", "0"); env.insert("XDG_CACHE_HOME", workspace + "/data/cache");
        env.insert("HF_HOME", workspace + "/data/cache/huggingface"); env.insert("TORCH_HOME", workspace + "/data/cache/torch");
        process.setProcessEnvironment(env); process.setWorkingDirectory(root);
        keyChannel.configureChild(process);
        process.start(python, {root + "/src/main.py", "--stdio-bridge"});
        const auto written = keyChannel.sendAndClose(key);
        key.fill(0);
        need(written == 32 && process.waitForStarted(5000), "PREVIEW_UPGRADE_BACKEND_START");
        ready = frame(30000);
        need(ready["kind"] == "ready" && ready["schema"] == "reverie.bridge.stdio.ready.v4" &&
             ready["pid"].toInteger() == process.processId() && ready["protocolVersion"].toInt() == 4 &&
             ready["secretSha256"] == digest(secret.toUtf8()) && ready["runtimeWritable"] == true &&
             ready["writesBlocked"] == false && ready["recoveryState"] == "clean", "PREVIEW_UPGRADE_AUTHENTICATED_READY");
        persona = {{"persona_id", ready["personaId"]}, {"epoch", ready["personaEpoch"]}, {"fingerprint", ready["personaFingerprint"]}};
    }
    ~Backend() { if (process.state() != QProcess::NotRunning) { process.kill(); process.waitForFinished(5000); } }
    QJsonObject frame(int timeout) {
        QElapsedTimer clock; clock.start();
        while (clock.elapsed() < timeout) {
            buffer += process.readAllStandardOutput(); process.readAllStandardError();
            need(buffer.size() <= 2097160, "PREVIEW_UPGRADE_FRAME_LIMIT");
            if (buffer.size() >= 4) {
                const auto size = qFromBigEndian<quint32>(buffer.constData());
                need(size >= 2 && size <= 1048576, "PREVIEW_UPGRADE_FRAME_SIZE");
                if (buffer.size() >= size + 4) {
                    QJsonParseError error;
                    const auto document = QJsonDocument::fromJson(buffer.mid(4, size), &error);
                    buffer.remove(0, size + 4);
                    need(error.error == QJsonParseError::NoError && document.isObject(), "PREVIEW_UPGRADE_FRAME_JSON");
                    const auto value = document.object();
                    need(value["kind"] != "fatal_error", "PREVIEW_UPGRADE_PROTOCOL_REJECTED");
                    ++receivedSequence;
                    if (value["kind"] == "event") observeChat(value["frame"].toObject());
                    return value;
                }
            }
            need(process.state() != QProcess::NotRunning, "PREVIEW_UPGRADE_BACKEND_EXITED");
            process.waitForReadyRead(100);
        }
        throw std::runtime_error("PREVIEW_UPGRADE_RESPONSE_TIMEOUT");
    }
    QJsonObject call(const QString &command, QJsonObject payload = {}, bool control = false, QString *issuedRequest = nullptr) {
        const auto request = id();
        if (issuedRequest) *issuedRequest = request;
        // Match the production owner's identity binding: the coordinator must
        // persist the same request id as the strict V4 command envelope.
        if (command == "chat:send") payload["request_id"] = request;
        if (command == "chat:send") {
            need(activeChat.isEmpty() && !ownerModel.isEmpty(), "PREVIEW_UPGRADE_CHAT_ALREADY_ISSUED"); activeChat = request;
            activeConversation = payload["conversation_id"].toString(QStringLiteral("dream-room"));
        }
        QJsonObject message;
        if (control) message = {{"kind", "control"}, {"schema", "reverie.bridge.stdio.control.v4"}, {"requestId", request}, {"type", command}};
        else message = {{"kind", "renderer_command"}, {"schema", "reverie.command.v4"}, {"envelope", QJsonObject{
            {"protocol_version", 4}, {"request_id", request}, {"idempotency_key", request}, {"command", command},
            {"persona", persona}, {"payload", payload}, {"created_at_utc", QDateTime::currentDateTimeUtc().toString(Qt::ISODateWithMs)}}}};
        if (control) for (auto it = payload.begin(); it != payload.end(); ++it) message[it.key()] = it.value();
        const auto bytes = json(message); QByteArray header(4, 0); qToBigEndian<quint32>(bytes.size(), header.data());
        need(process.write(header + bytes) == bytes.size() + 4, "PREVIEW_UPGRADE_WRITE_FRAME"); process.waitForBytesWritten(5000);
        // V4 delivery events carry their request in payload.request_id, rather
        // than the command-result top-level id. The central frame observer
        // captures them while ordinary correlated reads continue.
        if (command == "chat:send") return {};
        QElapsedTimer clock; clock.start();
        while (clock.elapsed() < 45000) {
            const auto value = frame(45000 - int(clock.elapsed()));
            const auto event = value["frame"].toObject();
            const bool matched = control ? value["kind"] == "control_result" && value["requestId"] == request
                : value["kind"] == "event" && event["request_id"] == request;
            if (!matched) continue;
            const auto result = control ? value : event["payload"].toObject();
            need(event["type"] != "error" && result["ok"] != false && !result.contains("error"), "PREVIEW_UPGRADE_COMMAND_REJECTED");
            reads.append(QJsonObject{{"command", command}, {"requestId", request}, {"responseSha256", digest(json(result))}});
            lastReceiptId = request; lastReceiptSha = digest(json(result)); lastReceiptSequence = receivedSequence;
            return result;
        }
        throw std::runtime_error("PREVIEW_UPGRADE_COMMAND_TIMEOUT");
    }
    void close() {
        process.closeWriteChannel();
        need(process.waitForFinished(10000) && process.exitStatus() == QProcess::NormalExit && process.exitCode() == 0,
             "PREVIEW_UPGRADE_BACKEND_CLEAN_EXIT");
    }
};
QJsonObject avatar(const QString &root, const QString &python, const QString &workspace, QJsonObject job) {
    QProcess process; process.setWorkingDirectory(root);
    auto env = privateEnvironment(workspace, root);
    process.setProcessEnvironment(env);
    job["storageDir"] = workspace + "/avatars"; job["python"] = python; job["runtimeAvailable"] = true;
    process.start(root + "/.tools/node/bin/node", {root + "/native-ui/avatar-host.cjs"});
    need(process.waitForStarted(5000), "PREVIEW_UPGRADE_AVATAR_START"); process.write(json(job)); process.closeWriteChannel();
    need(process.waitForFinished(120000) && process.exitStatus() == QProcess::NormalExit && process.exitCode() == 0,
         "PREVIEW_UPGRADE_AVATAR_FAILED");
    const auto bytes = process.readAllStandardOutput(); need(bytes.size() <= 65536, "PREVIEW_UPGRADE_AVATAR_LIMIT");
    const auto result = QJsonDocument::fromJson(bytes).object(); need(result["ok"] == true, "PREVIEW_UPGRADE_AVATAR_RESULT"); return result;
}
QJsonObject category(QJsonArray values, const QStringList &fields) {
    QList<QJsonObject> items;
    for (const auto &value : values) {
        const auto source = value.toObject(); const auto identity = source["id"].toString();
        need(!identity.isEmpty(), "PREVIEW_UPGRADE_ITEM_ID_MISSING");
        QJsonObject content;
        for (const auto &key : fields) { need(source.contains(key), "PREVIEW_UPGRADE_ITEM_FIELD_MISSING"); content[key] = source[key]; }
        items.append({{"id", identity}, {"sha256", digest(json(content))}});
    }
    std::sort(items.begin(), items.end(), [](const auto &a, const auto &b) { return a["id"].toString() < b["id"].toString(); });
    QJsonArray normalized; QSet<QString> seen;
    for (const auto &item : items) { need(!seen.contains(item["id"].toString()), "PREVIEW_UPGRADE_ITEM_DUPLICATE"); seen.insert(item["id"].toString()); normalized.append(item); }
    need(!normalized.isEmpty(), "PREVIEW_UPGRADE_CATEGORY_EMPTY");
    return {{"count", normalized.size()}, {"items", normalized}};
}
QJsonObject selectedRecord(const QJsonObject &source, const QStringList &fields) {
    need(!source["id"].toString().isEmpty(), "PREVIEW_UPGRADE_SEED_ID_MISSING");
    QJsonObject value{{"id", source["id"]}};
    for (const auto &field : fields) { need(source.contains(field), "PREVIEW_UPGRADE_SEED_FIELD_MISSING"); value[field] = source[field]; }
    return value;
}
QJsonObject chatRecord(const QJsonObject &source) {
    auto value = selectedRecord(source, {"role", "request_id", "persona_id", "bubble_index"});
    need(source["content"].isString() && !source["content"].toString().trimmed().isEmpty(), "PREVIEW_UPGRADE_CHAT_HISTORY_EMPTY");
    const auto bytes = source["content"].toString().toUtf8(); value["contentSha256"] = digest(bytes); value["contentBytes"] = bytes.size();
    return value;
}
QJsonObject selectedFields(const QJsonObject &source, const QStringList &fields) {
    QJsonObject value;
    for (const auto &field : fields) { need(source.contains(field), "PREVIEW_UPGRADE_SETTING_FIELD_MISSING"); value[field] = source[field]; }
    return value;
}
QJsonObject settingsProjection(const QJsonObject &settings) {
    return {{"chat", selectedFields(settings["chat"].toObject(), {"split_messages", "reply_delay_min", "reply_delay_max"})},
        {"memory", selectedFields(settings["memory"].toObject(), {"retention_days"})},
        {"ui", selectedFields(settings["ui"].toObject(), {"onboarding_completed", "onboarding_version", "onboarding_state", "onboarding_last_step"})},
        {"features", selectedFields(settings["features"].toObject(), {"autonomous_memory_enabled", "autonomous_memory_llm_enabled", "self_growth_enabled"})}};
}
QJsonObject profileRecord(Backend &backend, QJsonObject profile) {
    QJsonObject content;
    if (QStringList{"chara_card_v2", "chara_card_v3", "tavern_card_v1"}.contains(profile["source_format"].toString())) {
        const auto full = backend.call("persona:profile:get", {{"profile_id", profile["id"]}});
        need(full["profile_id"] == profile["id"], "PREVIEW_UPGRADE_PERSONA_READ_ID");
        for (const auto *key : {"fields", "identity_version", "identity_fingerprint"}) {
            need(full.contains(key), "PREVIEW_UPGRADE_PERSONA_CONTENT_MISSING"); content[key] = full[key];
        }
    }
    profile["profile"] = content;
    return selectedRecord(profile, {"name", "source_format", "active", "profile"});
}
QJsonObject avatarResources(const QString &workspace) {
    const QString directory = workspace + "/avatars";
    QDirIterator iterator(directory, QDir::Files | QDir::Dirs | QDir::Hidden | QDir::NoDotAndDotDot,
                          QDirIterator::Subdirectories);
    QList<QJsonObject> items;
    while (iterator.hasNext()) {
        const auto path = iterator.next(); const QFileInfo info(path);
        need(!info.isSymLink(), "PREVIEW_UPGRADE_AVATAR_RESOURCE_LINK");
        if (info.isDir()) continue;
        struct stat status{};
        need(::lstat(QFile::encodeName(path).constData(), &status) == 0 && S_ISREG(status.st_mode) && status.st_uid == ::getuid(),
             "PREVIEW_UPGRADE_AVATAR_RESOURCE_TYPE");
        QFile file(path); need(file.open(QIODevice::ReadOnly), "PREVIEW_UPGRADE_AVATAR_RESOURCE_READ");
        QCryptographicHash hash(QCryptographicHash::Sha256);
        need(hash.addData(&file), "PREVIEW_UPGRADE_AVATAR_RESOURCE_HASH");
        items.append({{"id", QDir(directory).relativeFilePath(path)}, {"sha256", QString::fromLatin1(hash.result().toHex())}});
        need(items.size() <= 50000, "PREVIEW_UPGRADE_AVATAR_RESOURCE_LIMIT");
    }
    std::sort(items.begin(), items.end(), [](const auto &a, const auto &b) { return a["id"].toString() < b["id"].toString(); });
    QJsonArray rows; for (const auto &item : items) rows.append(item);
    need(!rows.isEmpty(), "PREVIEW_UPGRADE_AVATAR_RESOURCE_EMPTY");
    return {{"count", rows.size()}, {"items", rows}};
}
#include "PreviewUpgradeMemory.h"

QJsonObject collect(Backend &backend, const QString &root, const QString &python, const QString &workspace) {
    const auto chat = backend.call("chat:history", {{"conversation_id", "dream-room"}, {"limit", 300}});
    need(chat["has_more"] != true, "PREVIEW_UPGRADE_CHAT_PAGE_LIMIT");
    const auto personas = backend.call("persona:list");
    QJsonArray profiles;
    for (const auto &value : personas["profiles"].toArray()) profiles.append(profileRecord(backend, value.toObject()));
    const auto memories = collectProductMemory(backend);
    const auto archive = backend.call("archive:get")["archive"].toObject();
    const auto settings = settingsProjection(backend.call("settings:get"));
    QJsonArray settingRows;
    for (const auto *section : {"chat", "memory", "ui", "features"}) settingRows.append(QJsonObject{{"id", section}, {"value", settings[section]}});
    const auto avatars = avatar(root, python, workspace, {{"action", "list"}})["list"].toObject();
    need(!avatars["activeId"].toString().isEmpty(), "PREVIEW_UPGRADE_AVATAR_INACTIVE");
    QJsonArray chatRows; for (const auto &value : chat["items"].toArray()) chatRows.append(chatRecord(value.toObject()));
    need(chatRows.size() == 2, "PREVIEW_UPGRADE_EXTRA_CHAT_HISTORY");
    return {{"chat", category(chatRows, {"role", "contentSha256", "contentBytes", "request_id", "persona_id", "bubble_index"})},
        {"persona", category(profiles, {"name", "source_format", "active", "profile"})},
        {"memory", category(memories["records"].toArray(), productMemoryFields())},
        {"worldbook", category(archive["worldBooks"].toArray(), {"name", "entries", "scanDepth", "tokenBudget", "recursiveScanning"})},
        {"settings", category(settingRows, {"value"})},
        {"avatar", avatarResources(workspace)}};
}
QJsonObject seed(Backend &backend, const QString &root, const QString &python, const QString &workspace,
          const QString &endpoint, const QString &model) {
    const QUrl url(endpoint);
    need(url.scheme() == "http" && url.host() == "127.0.0.1" && url.port() >= 1024 && url.path() == "/v1" &&
         url.userInfo().isEmpty() && !url.hasQuery() && !url.hasFragment(), "PREVIEW_UPGRADE_ENDPOINT");
    backend.call("provider:configure", {{"llm", QJsonObject{{"provider", "ollama"}, {"model", "reverie-preview-upgrade"}, {"base_url", endpoint}}}}, true);
    backend.call("settings:update", {{"section", "onboarding"}, {"completed", true}});
    backend.call("settings:update", {{"section", "chat"}, {"split_messages", false}, {"reply_delay_min", 1.0}, {"reply_delay_max", 1.0}});
    backend.call("settings:update", {{"section", "memory"}, {"retention_days", 730}, {"autonomous_memory_enabled", false}, {"autonomous_memory_llm_enabled", false}, {"self_growth_enabled", false}});
    const auto actualSettings = backend.call("settings:get");
    const auto llm = actualSettings["llm"].toObject(), chatSettings = actualSettings["chat"].toObject();
    const auto features = actualSettings["features"].toObject(), ui = actualSettings["ui"].toObject();
    need(llm["provider"] == "ollama" && llm["model"] == "reverie-preview-upgrade" && llm["base_url"] == endpoint &&
         ui["onboarding_completed"] == true && ui["onboarding_version"].toInt() == 3 &&
         ui["onboarding_state"] == "complete" && ui["onboarding_last_step"] == "finish" && chatSettings["split_messages"] == false &&
         chatSettings["reply_delay_min"].toDouble() == 1.0 && chatSettings["reply_delay_max"].toDouble() == 1.0 &&
         actualSettings["memory"].toObject()["retention_days"].toInt() == 730 &&
         features["autonomous_memory_enabled"] == false && features["autonomous_memory_llm_enabled"] == false &&
         features["self_growth_enabled"] == false, "PREVIEW_UPGRADE_SETTINGS_SEED_READBACK");
    const auto modelMaterial = llm["provider"].toString().toUtf8() + '\0' + llm["model"].toString().toUtf8() + '\0' + llm["base_url"].toString().toUtf8();
    backend.ownerModel = {{"epoch", llm["model_epoch"]}, {"fingerprint", digest(modelMaterial).left(24)}};
    QJsonObject card{{"spec", "chara_card_v2"}, {"spec_version", "2.0"}, {"data", QJsonObject{
        {"name", "W5 isolated persona"}, {"description", "Synthetic preview upgrade character, age 24."},
        {"personality", "Calm"}, {"scenario", "Isolated upgrade fixture"}, {"first_mes", "Hello"}, {"mes_example", ""},
        {"creator_notes", ""}, {"system_prompt", ""}, {"post_history_instructions", ""}, {"alternate_greetings", QJsonArray{}},
        {"tags", QJsonArray{}}, {"creator", ""}, {"character_version", ""}, {"extensions", QJsonObject{}}}}};
    const auto imported = backend.call("persona:import", {{"json", QString::fromUtf8(json(card))}, {"filename", "w5-isolated.json"}});
    const auto profileId = imported["card_id"].toString(), cardDigest = digest(json(card));
    need(imported["saved"] == true && imported["activated"] == false && imported["source_sha256"] == cardDigest &&
         profileId == "st_" + cardDigest.left(20), "PREVIEW_UPGRADE_PERSONA_IMPORT_RECEIPT");
    const auto personaList = backend.call("persona:list")["profiles"].toArray(); QJsonObject importedProfile;
    for (const auto &value : personaList) if (value.toObject()["id"] == profileId) importedProfile = profileRecord(backend, value.toObject());
    const auto profileContent = importedProfile["profile"].toObject(), profileFields = profileContent["fields"].toObject();
    need(importedProfile["id"] == profileId && importedProfile["name"] == "W5 isolated persona" &&
         importedProfile["source_format"] == "chara_card_v2" && importedProfile["active"] == false &&
         profileContent["identity_version"].toInt() == 1 && profileContent["identity_fingerprint"].toString().size() == 64 &&
         profileFields["description"] == "Synthetic preview upgrade character, age 24.\n\nCalm\n\nIsolated upgrade fixture" &&
         profileFields["first_message"] == "Hello", "PREVIEW_UPGRADE_PERSONA_SEED_READBACK");
    const auto existing = backend.call("archive:get");
    auto archive = existing["archive"].toObject();
    archive["characters"] = QJsonArray{}; archive["activeCharacterIds"] = QJsonArray{};
    const QJsonObject entry{{"id", "w5-upgrade-entry"}, {"comment", "W5 isolated"}, {"content", "W5 durable worldbook marker"},
        {"keywords", QJsonArray{}}, {"secondaryKeywords", QJsonArray{}}, {"selectiveLogic", "and_any"}, {"caseSensitive", false},
        {"useRegex", false}, {"enabled", true}, {"alwaysActive", true}, {"position", "before_char"}, {"insertionOrder", 10},
        {"priority", 0}, {"depth", 0}, {"role", "system"}};
    archive["worldBooks"] = QJsonArray{QJsonObject{{"id", "w5-upgrade-book"}, {"name", "W5 isolated worldbook"},
        {"scanDepth", 1}, {"tokenBudget", 256}, {"recursiveScanning", false}, {"entries", QJsonArray{entry}}}};
    backend.call("archive:put", {{"archive", archive}, {"expected_revision", existing["revision"].toInt()}});
    const auto books = backend.call("archive:get")["archive"].toObject()["worldBooks"].toArray(); QJsonObject storedBook;
    for (const auto &value : books) if (value.toObject()["id"] == "w5-upgrade-book")
        storedBook = selectedRecord(value.toObject(), {"name", "entries", "scanDepth", "tokenBudget", "recursiveScanning"});
    const auto storedEntries = storedBook["entries"].toArray();
    need(storedBook["name"] == "W5 isolated worldbook" && storedBook["scanDepth"].toInt() == 1 && storedBook["tokenBudget"].toInt() == 256 &&
         storedBook["recursiveScanning"] == false && storedEntries.size() == 1 && storedEntries[0].toObject()["id"] == "w5-upgrade-entry" &&
         storedEntries[0].toObject()["content"] == "W5 durable worldbook marker", "PREVIEW_UPGRADE_WORLDBOOK_SEED_READBACK");
    const auto memoryProof = seedProductMemory(backend);
    // This existing owner directive keeps the chat fixture separate from the
    // explicitly stored permanent memory; no production capture rule changes.
    QSet<QString> earlierMessages;
    for (const auto &value : backend.call("chat:history", {{"conversation_id", "dream-room"}, {"limit", 300}})["items"].toArray())
        earlierMessages.insert(value.toObject()["id"].toString());
    QString chatRequest;
    backend.call("chat:send", {{"text", "W5 isolated upgrade conversation marker /forget-this"}, {"conversation_id", "dream-room"}}, false, &chatRequest);
    QElapsedTimer clock; clock.start(); QJsonObject userMessage, assistantMessage;
    while (clock.elapsed() < 90000) {
        const auto history = backend.call("chat:history", {{"conversation_id", "dream-room"}, {"limit", 300}})["items"].toArray();
        for (const auto &value : history) {
            const auto row = value.toObject();
            if (earlierMessages.contains(row["id"].toString()) || row["request_id"] != chatRequest || row["persona_id"] != backend.persona["persona_id"] ||
                row["conversation_id"] != "dream-room" || row["bubble_index"].toInt(-1) != 0) continue;
            if (row["role"] == "user" && row["content"] == "W5 isolated upgrade conversation marker /forget-this") userMessage = chatRecord(row);
            if (!backend.doneSummary.isEmpty() && row["role"] == "assistant" && row["content"].toString() == backend.cleanChatText) assistantMessage = chatRecord(row);
        }
        if (!userMessage.isEmpty() && !assistantMessage.isEmpty()) break;
        backend.process.waitForReadyRead(250);
    }
    need(!userMessage.isEmpty() && !assistantMessage.isEmpty() && userMessage["id"] != assistantMessage["id"], "PREVIEW_UPGRADE_CHAT_NO_CORRELATED_REPLY");
    need(!backend.doneSummary.isEmpty() && backend.lastReceiptSequence > quint64(backend.doneSummary["sequence"].toInteger()), "PREVIEW_UPGRADE_CHAT_HISTORY_BEFORE_DELIVERY");
    QJsonArray beforeIds; auto sortedIds = earlierMessages.values(); sortedIds.sort(); for (const auto &value : sortedIds) beforeIds.append(value);
    const QJsonObject delivery{{"scope", backend.chatScope}, {"ownerPersona", backend.persona}, {"ownerModel", backend.ownerModel},
        {"bubble", backend.bubbleSummary}, {"done", backend.doneSummary}, {"beforeMessageIds", beforeIds},
        {"history", QJsonObject{{"requestId", backend.lastReceiptId}, {"responseSha256", backend.lastReceiptSha}, {"sequence", qint64(backend.lastReceiptSequence)}}},
        {"marker", QJsonObject{{"sha256", digest(QByteArrayLiteral("W5"))}, {"bytes", 2}, {"unique", false}, {"inUser", true}, {"inMock", true}}}};
    backend.cleanChatText.clear(); backend.displayChatText.clear();
    const auto beforeAvatars = avatar(root, python, workspace, {{"action", "list"}})["list"].toObject();
    QSet<QString> earlierAvatars;
    for (const auto &value : beforeAvatars["records"].toArray()) earlierAvatars.insert(value.toObject()["id"].toString());
    const auto scan = avatar(root, python, workspace, {{"action", "scan"}, {"path", model}});
    const auto importId = scan["candidate"].toObject()["importId"].toString(); need(!importId.isEmpty(), "PREVIEW_UPGRADE_AVATAR_IMPORT_ID");
    avatar(root, python, workspace, {{"action", "preview"}, {"importId", importId}});
    const auto committed = avatar(root, python, workspace, {{"action", "commit"}, {"importId", importId}, {"rightsConfirmed", true}, {"warningAccepted", true}});
    const auto committedList = committed["list"].toObject(); const auto avatarId = committedList["activeId"].toString();
    const auto listedAgain = avatar(root, python, workspace, {{"action", "list"}})["list"].toObject();
    need(!avatarId.isEmpty() && !earlierAvatars.contains(avatarId) && listedAgain["activeId"] == avatarId &&
         listedAgain["records"].toArray().size() == beforeAvatars["records"].toArray().size() + 1 &&
         committed["entryPath"].toString().startsWith(workspace + "/avatars/records/" + avatarId + "/payload/"), "PREVIEW_UPGRADE_AVATAR_COMMIT_READBACK");
    const auto resources = avatarResources(workspace); bool payloadFound = false, manifestFound = false;
    for (const auto &value : resources["items"].toArray()) {
        const auto path = value.toObject()["id"].toString();
        if (path == "records/" + avatarId + "/manifest.json") manifestFound = true;
        if (path.startsWith("records/" + avatarId + "/payload/")) payloadFound = true;
    }
    need(payloadFound && manifestFound, "PREVIEW_UPGRADE_AVATAR_RESOURCE_SEED_READBACK");
    auto settingsProof = settingsProjection(actualSettings);
    settingsProof["llm"] = selectedFields(actualSettings["llm"].toObject(), {"provider", "model", "base_url"});
    return {{"persona", importedProfile}, {"memory", memoryProof}, {"worldbook", storedBook}, {"settings", settingsProof},
        {"chat", QJsonObject{{"requestId", chatRequest}, {"user", userMessage}, {"assistant", assistantMessage}, {"delivery", delivery}}},
        {"avatar", QJsonObject{{"id", avatarId}, {"activeId", listedAgain["activeId"]}, {"importId", importId},
            {"resourceCount", resources["count"]}, {"resourceInventorySha256", digest(json(resources))}}}};
}
void saveReport(const QString &path, const QByteArray &bytes) {
    const int fd = ::open(QFile::encodeName(path).constData(), O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0600);
    need(fd >= 0, "PREVIEW_UPGRADE_REPORT_EXISTS_OR_UNSAFE");
    QFile file; const bool opened = file.open(fd, QIODevice::WriteOnly, QFileDevice::AutoCloseHandle);
    if (!opened) ::close(fd);
    need(opened && file.write(bytes) == bytes.size() && file.flush() && ::fsync(fd) == 0, "PREVIEW_UPGRADE_REPORT_WRITE");
}
} // namespace
bool requested(const QStringList &raw) {
    for (const auto &argument : raw) if (argument.section('=', 0, 0) == "--preview-upgrade-check") return true;
    return false;
}
int run(int argc, char **argv) {
    ::signal(SIGPIPE, SIG_IGN);
    QCoreApplication app(argc, argv);
    try {
        const auto args = arguments(app.arguments().mid(1));
        const auto contextFile = args["--context"].toString();
        auto target = PreviewWorkspace::validateTestCleanupContext(contextFile, args["--data-dir"].toString());
        const auto context = readObject(contextFile); const auto bound = context["previewUpgrade"].toObject();
        for (auto it = args.begin(); it != args.end(); ++it)
            need(it.key() == "--context" || it.key() == "--data-dir" || bound[it.key()] == it.value(), "PREVIEW_UPGRADE_CONTEXT_BINDING");
        need(bound.size() == args.size() - 2, "PREVIEW_UPGRADE_CONTEXT_BINDING");
        const auto root = args["--backend-root"].toString(), python = args["--backend-python"].toString();
        const auto runtime = PreviewWorkspace::readRuntime(root, python);
        const auto report = args["--upgrade-report"].toString();
        const auto isolation = context["root"].toObject()["path"].toString();
        need(QFileInfo(report).absolutePath() == isolation && QDir::cleanPath(report) == report && !QFileInfo::exists(report), "PREVIEW_UPGRADE_REPORT_SCOPE");
        PreviewDataFormat::checkWorkspace(target.workspace(), PreviewDataFormat::Current);
        verifySelectedRuntime(root, python, target.workspace(), context);
        Backend backend(root, python, target.workspace());
        const auto backendPid = backend.process.processId();
        QJsonValue seedProof = QJsonValue::Null;
        if (args["--upgrade-action"] == "seed") seedProof = seed(backend, root, python, target.workspace(), args["--upgrade-endpoint"].toString(), args["--upgrade-model"].toString());
        const auto categories = collect(backend, root, python, target.workspace());
        backend.close();
        QJsonObject result{{"schema", "reverie.preview.upgrade-host.v2"}, {"action", args["--upgrade-action"]},
            {"hostPid", QCoreApplication::applicationPid()}, {"backendPid", backendPid}, {"backendExited", true},
            {"oldHostParticipated", false}, {"workspaceId", digest(target.workspace().toUtf8())},
            {"backendIdentity", QJsonObject{{"candidate", runtime.candidate}, {"sourceHead", runtime.sourceHead}, {"buildManifestSha256", runtime.buildManifestSha256}}},
            {"categories", categories}, {"seedProof", seedProof}, {"authenticatedReady", true}, {"backendRuntimeVerified", true},
            {"previousPublicResultSha256", PreviewUpgradeTrust::PreviousPublicResultSha256}, {"requests", backend.reads}};
        saveReport(report, json(result) + '\n'); return 0;
    } catch (const std::exception &error) { qCritical("%s", error.what()); return 71; }
}
} // namespace PreviewUpgradeCheck
