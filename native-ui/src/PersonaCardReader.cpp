#include "PersonaCardReader.h"
#include <QCryptographicHash>
#include <QFile>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QHash>
#include <QStringDecoder>
#include <QtEndian>
#include <fcntl.h>
#include <sys/stat.h>
#include <unistd.h>

namespace {
constexpr qint64 JsonLimit = 1024 * 1024;
constexpr qint64 PngLimit = 16 * 1024 * 1024;
constexpr quint32 TextLimit = 3 * 1024 * 1024;
quint32 crc32(const QByteArray &bytes, qsizetype start, qsizetype count) {
    quint32 crc = 0xffffffff;
    for (qsizetype i = start; i < start + count; ++i) {
        crc ^= quint8(bytes[i]);
        for (int bit = 0; bit < 8; ++bit)
            crc = (crc >> 1) ^ ((crc & 1) ? 0xedb88320 : 0);
    }
    return crc ^ 0xffffffff;
}
bool utf8(const QByteArray &bytes, QString *text) {
    QStringDecoder decode(QStringDecoder::Utf8, QStringDecoder::Flag::Stateless);
    *text = decode(bytes);
    return !decode.hasError();
}
bool jsonObject(const QByteArray &bytes, QString *text, QJsonObject *object) {
    if (!utf8(bytes, text))
        return false;
    QJsonParseError error;
    const auto doc = QJsonDocument::fromJson(bytes, &error);
    if (error.error != QJsonParseError::NoError || !doc.isObject())
        return false;
    *object = doc.object();
    return true;
}
bool sameFile(const struct stat &a, const struct stat &b) {
    return a.st_dev == b.st_dev && a.st_ino == b.st_ino && a.st_size == b.st_size &&
           a.st_mtimespec.tv_sec == b.st_mtimespec.tv_sec &&
           a.st_mtimespec.tv_nsec == b.st_mtimespec.tv_nsec &&
           a.st_ctimespec.tv_sec == b.st_ctimespec.tv_sec &&
           a.st_ctimespec.tv_nsec == b.st_ctimespec.tv_nsec;
}
}
namespace PersonaCardReader {
Card parseBytes(const QByteArray &bytes, const QString &filename) {
    Card card;
    card.filename = QFileInfo(filename).fileName();
    const auto suffix = QFileInfo(filename).suffix().toLower();
    QByteArray raw = bytes;
    if (suffix == "png") {
        card.sourceFormat = "png";
        const QByteArray signature = QByteArray::fromHex("89504e470d0a1a0a");
        if (bytes.size() > PngLimit || !bytes.startsWith(signature)) {
            card.error = "请选择不超过 16 MiB 的有效 PNG 角色卡。";
            return card;
        }
        qsizetype offset = 8;
        int chunks = 0;
        bool iend = false;
        QHash<QByteArray, QByteArray> payloads;
        while (offset + 12 <= bytes.size()) {
            if (++chunks > 10000) {
                card.error = "PNG 数据块过多，无法读取角色卡。";
                return card;
            }
            const auto length = qFromBigEndian<quint32>(bytes.constData() + offset);
            if (quint64(length) + 12 > quint64(bytes.size() - offset))
                break;
            const auto type = bytes.mid(offset + 4, 4);
            if (crc32(bytes, offset + 4, length + 4) !=
                qFromBigEndian<quint32>(bytes.constData() + offset + 8 + length)) {
                card.error = "PNG 数据校验失败，请重新选择原始文件。";
                return card;
            }
            if (type == "tEXt") {
                if (length > TextLimit) {
                    card.error = "PNG 文本数据超过 3 MiB 限额。";
                    return card;
                }
                const auto data = bytes.mid(offset + 8, length);
                const auto separator = data.indexOf('\0');
                const auto keyword = separator >= 0 ? data.left(separator) : QByteArray();
                if (keyword == "chara" || keyword == "ccv3") {
                    if (payloads.contains(keyword)) {
                        card.error = "PNG 包含重复角色卡数据，无法确定要导入的内容。";
                        return card;
                    }
                    payloads.insert(keyword, data.mid(separator + 1));
                }
            }
            offset += qsizetype(length) + 12;
            if (type == "IEND") {
                if (length != 0) {
                    card.error = "PNG 结束块格式无效。";
                    return card;
                }
                iend = true;
                break;
            }
        }
        if (!iend || payloads.isEmpty()) {
            card.error = iend ? "这个 PNG 没有内嵌角色卡数据。" : "PNG 缺少完整结束块。";
            return card;
        }
        raw = payloads.value(payloads.contains("ccv3") ? "ccv3" : "chara").trimmed();
        QString direct;
        QJsonObject object;
        if (!jsonObject(raw, &direct, &object)) {
            const auto decoded = QByteArray::fromBase64Encoding(raw, QByteArray::AbortOnBase64DecodingErrors);
            if (!decoded || decoded.decoded.toBase64() != raw) {
                card.error = "PNG 角色卡数据不是有效 JSON 或严格 Base64。";
                return card;
            }
            raw = decoded.decoded;
        }
    } else if (suffix == "json") {
        card.sourceFormat = "json";
    } else {
        card.error = "请选择本地 JSON 或 PNG 角色卡。";
        return card;
    }
    QJsonObject object;
    if (raw.isEmpty() || raw.size() > JsonLimit) {
        card.error = "角色卡 JSON 数据须在 1 MiB 以内。";
        return card;
    }
    if (!jsonObject(raw, &card.json, &object)) {
        card.error = "角色卡须包含有效的 UTF-8 JSON 对象。";
        card.json.clear();
        return card;
    }
    // A display hint only; the backend validates every card field on confirmation.
    card.name = object.value("data").isObject() ? object.value("data").toObject().value("name").toString()
                                                : object.value("name").toString();
    card.name = card.name.left(160);
    card.targetId = "st_" + QString::fromLatin1(QCryptographicHash::hash(card.json.toUtf8(), QCryptographicHash::Sha256).toHex().left(20));
    return card;
}
Card readFile(const QString &path) {
    Card failure;
    failure.error = "请选择本地普通 JSON 或 PNG 文件，符号链接不能导入。";
    if (path.isEmpty() || !QFileInfo(path).isAbsolute())
        return failure;
    const auto suffix = QFileInfo(path).suffix().toLower();
    const qint64 limit = suffix == "json" ? JsonLimit : suffix == "png" ? PngLimit : 0;
    if (!limit)
        return failure;
    struct stat before{}, after{}, current{};
    const auto encoded = QFile::encodeName(path);
    const int fd = ::open(encoded.constData(), O_RDONLY | O_NOFOLLOW | O_NONBLOCK | O_CLOEXEC);
    if (fd < 0)
        return failure;
    QFile file;
    if (::fstat(fd, &before) || !S_ISREG(before.st_mode) || before.st_size <= 0 || before.st_size > limit ||
        !file.open(fd, QIODevice::ReadOnly, QFileDevice::AutoCloseHandle)) {
        ::close(fd);
        failure.error = "文件无法读取或超过限额（JSON 1 MiB，PNG 16 MiB）。";
        return failure;
    }
    const auto bytes = file.read(limit + 1);
    if (file.error() != QFileDevice::NoError || bytes.size() != before.st_size ||
        ::fstat(fd, &after) || ::lstat(encoded.constData(), &current) ||
        !S_ISREG(current.st_mode) || !sameFile(before, after) || !sameFile(after, current)) {
        failure.error = "文件在读取期间发生变化，请重新选择。";
        return failure;
    }
    return parseBytes(bytes, QFileInfo(path).fileName());
}
}
