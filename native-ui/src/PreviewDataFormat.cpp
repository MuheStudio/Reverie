#include "PreviewDataFormat.h"
#include "PreviewPlatform.h"
#include "PreviewWorkspace.h"

#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QUuid>
#include <cmath>
#include <limits>

namespace PreviewDataFormat {
namespace {
int positiveInteger(const QJsonValue &value) {
    const double number = value.toDouble(-1);
    if (!value.isDouble() || !std::isfinite(number) || number < 1 ||
        number > std::numeric_limits<int>::max() || number != std::floor(number))
        throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
    return int(number);
}
int readRecord(const PreviewPlatform::Handle &data) {
    using namespace PreviewPlatform;
    const QByteArray name(FileName);
    const auto before = inspect(data, name);
    if (before.kind == Kind::Missing) return 1;
    if (before.kind != Kind::Regular || !before.owned || before.links != 1 ||
        before.permissions != 0600 || before.bytes == 0 || before.bytes > 4096)
        throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
    auto file = openRegular(data, name);
    if (!unchanged(before, metadata(file))) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
    QByteArray bytes;
    char block[4097];
    for (;;) {
        const auto count = PreviewPlatform::read(file, block, sizeof block);
        if (count == 0) break;
        if (count < 0 || bytes.size() + count > 4096) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
        bytes.append(block, count);
    }
    if (!unchanged(before, metadata(file)) || !unchanged(before, inspect(data, name)))
        throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
    QJsonParseError error;
    const auto document = QJsonDocument::fromJson(bytes, &error);
    const auto object = document.object();
    const auto keys = object.keys();
    if (error.error != QJsonParseError::NoError || !document.isObject() ||
        QSet<QString>(keys.begin(), keys.end()) != QSet<QString>{"schema", "formatVersion"} ||
        object["schema"] != Schema)
        throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
    return positiveInteger(object["formatVersion"]);
}
}
int supportedRuntimeValue(const QJsonValue &value) {
    return value.isUndefined() ? 1 : positiveInteger(value);
}
int checkDataDirectory(const PreviewPlatform::Handle &data, int supported) {
    if (supported < 1) throw Error("PREVIEW_DATA_FORMAT_INVALID");
    try {
        const auto info = PreviewPlatform::metadata(data);
        if (info.kind != PreviewPlatform::Kind::Directory || !info.owned || info.permissions != 0700)
            throw Error("PREVIEW_DATA_FORMAT_INVALID");
        const int stored = readRecord(data);
        if (stored > supported) throw Error("PREVIEW_DATA_FORMAT_TOO_NEW");
        return stored;
    } catch (const PreviewPlatform::Error &) {
        throw Error("PREVIEW_DATA_FORMAT_INVALID");
    }
}
int checkWorkspace(const QString &root, int supported) {
    if (supported < 1) throw Error("PREVIEW_DATA_FORMAT_INVALID");
    try {
        using namespace PreviewPlatform;
        if (!canonicalAbsolute(root)) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_INVALID");
        const auto rootInfo = inspectPath(root);
        if (rootInfo.kind == Kind::Missing) return 1;
        auto directory = openRoot(root);
        const auto dataInfo = inspect(directory, "data");
        int stored = 1;
        if (dataInfo.kind != Kind::Missing) {
            auto data = openDirectory(directory, "data", true);
            stored = checkDataDirectory(data, supported);
        }
        if (stored > supported) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_TOO_NEW");
        return stored;
    } catch (const PreviewPlatform::Error &) {
        throw Error("PREVIEW_DATA_FORMAT_INVALID");
    }
}
void writeReady(const PreviewWorkspace::Session &session, int format) {
    if (format != Current) throw Error("PREVIEW_DATA_FORMAT_INVALID");
    checkWorkspace(session.root(), format);
    try {
        using namespace PreviewPlatform;
        auto root = openRoot(session.root());
        auto data = openDirectory(root, "data", true);
        const QByteArray name(FileName);
        const auto old = inspect(data, name);
        if (old.kind != Kind::Missing && readRecord(data) == format) return;
        const auto temporary = QByteArray(".preview-data-format-") + QUuid::createUuid().toByteArray(QUuid::Id128) + ".tmp";
        auto file = createFile(data, temporary);
        try {
            const auto bytes = QJsonDocument(QJsonObject{{"schema", Schema}, {"formatVersion", format}}).toJson(QJsonDocument::Compact) + '\n';
            qint64 offset = 0;
            while (offset < bytes.size()) {
                const auto count = writeNative(file.nativeDescriptor(), bytes.constData() + offset, bytes.size() - offset);
                if (count <= 0 || count > bytes.size() - offset) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_WRITE_FAILED");
                offset += count;
            }
            flush(file);
            if (!unchanged(old, inspect(data, name))) throw PreviewDataFormat::Error("PREVIEW_DATA_FORMAT_WRITE_FAILED");
            replaceFile(data, temporary, name);
            flush(data);
        } catch (...) {
            try { removeEntry(data, temporary, false); } catch (...) {}
            throw;
        }
    } catch (const PreviewPlatform::Error &) {
        throw Error("PREVIEW_DATA_FORMAT_WRITE_FAILED");
    }
}
QString notice(const QString &code) {
    if (code == "PREVIEW_DATA_FORMAT_TOO_NEW")
        return QStringLiteral("数据来自更新的版本，请用新版本打开，或先恢复升级前的快照。");
    if (code == "PREVIEW_DATA_FORMAT_WRITE_FAILED")
        return QStringLiteral("工作区数据格式记录未能安全保存，预览已停止。请检查空间和工作区权限。");
    return QStringLiteral("工作区数据格式记录无法安全读取，预览没有启动。请保留现场并反馈。");
}
} // namespace PreviewDataFormat
