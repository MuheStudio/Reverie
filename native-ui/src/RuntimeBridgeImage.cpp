#include "RuntimeBridge.h"

#include <CoreFoundation/CoreFoundation.h>
#include <ImageIO/ImageIO.h>
#include <QBuffer>
#include <QClipboard>
#include <QFile>
#include <QFileInfo>
#include <QGuiApplication>
#include <QImage>
#include <QImageReader>
#include <QMimeData>
#include <QRegularExpression>
#include <QScopeGuard>
#include <QTimer>
#include <algorithm>

namespace {
constexpr qsizetype MaxFileBytes = 5 * 1024 * 1024;
constexpr qsizetype MaxClipboardUrl = 350000;
constexpr int MaxThumbnailEdge = 640;
constexpr int MaxPreviewEdge = 320;
constexpr int MaxClipboardEdge = 1280;
constexpr qint64 MaxFilePixels = 24000000;
const QByteArray JpegPrefix("data:image/jpeg;base64,");
const QString CannotRead = "这个文件读不了";
const QString Unsupported = "不支持这种图片格式";
const QString TooBig = "图片超过 5MB";
const QString CannotPaste = "这张图片太大，请改用选文件";

bool isImageId(const QString &id) {
    static const QRegularExpression format("\\A[0-9a-fA-F]{64}\\z");
    return format.match(id).hasMatch();
}

QByteArray encodeJpeg(const QImage &image, int quality) {
    QByteArray jpeg;
    QBuffer output(&jpeg);
    if (!output.open(QIODevice::WriteOnly) || !image.save(&output, "JPEG", quality))
        return {};
    return jpeg;
}

QUrl jpegUrl(const QByteArray &jpeg) {
    return jpeg.isEmpty() ? QUrl{} : QUrl(QString::fromLatin1(JpegPrefix + jpeg.toBase64()));
}

bool supportedFileType(CFStringRef type) {
    return CFEqual(type, CFSTR("public.jpeg")) || CFEqual(type, CFSTR("public.png")) ||
           CFEqual(type, CFSTR("com.compuserve.gif")) || CFEqual(type, CFSTR("org.webmproject.webp"));
}

QByteArray filePreview(const QByteArray &bytes, QString &problem) {
    const auto data = CFDataCreateWithBytesNoCopy(kCFAllocatorDefault,
        reinterpret_cast<const UInt8 *>(bytes.constData()), bytes.size(), kCFAllocatorNull);
    if (!data)
        return {};
    const auto releaseData = qScopeGuard([data] { CFRelease(data); });
    const auto source = CGImageSourceCreateWithData(data, nullptr);
    if (!source)
        return {};
    const auto releaseSource = qScopeGuard([source] { CFRelease(source); });
    const auto type = CGImageSourceGetType(source);
    if (!type)
        return {};
    if (!supportedFileType(type)) {
        problem = Unsupported;
        return {};
    }
    const auto properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nullptr);
    if (!properties)
        return {};
    const auto releaseProperties = qScopeGuard([properties] { CFRelease(properties); });
    const auto dimension = [properties](CFStringRef key) {
        const auto value = CFDictionaryGetValue(properties, key);
        qint64 pixels = 0;
        if (value && CFGetTypeID(value) == CFNumberGetTypeID())
            CFNumberGetValue(static_cast<CFNumberRef>(value), kCFNumberSInt64Type, &pixels);
        return pixels;
    };
    const auto width = dimension(kCGImagePropertyPixelWidth);
    const auto height = dimension(kCGImagePropertyPixelHeight);
    if (width < 1 || height < 1 || width > MaxFilePixels / height)
        return {};

    const auto edge = CFNumberCreate(kCFAllocatorDefault, kCFNumberIntType, &MaxPreviewEdge);
    if (!edge)
        return {};
    const auto releaseEdge = qScopeGuard([edge] { CFRelease(edge); });
    const void *keys[]{kCGImageSourceCreateThumbnailFromImageAlways,
                       kCGImageSourceCreateThumbnailWithTransform, kCGImageSourceThumbnailMaxPixelSize};
    const void *values[]{kCFBooleanTrue, kCFBooleanTrue, edge};
    const auto options = CFDictionaryCreate(kCFAllocatorDefault, keys, values, 3,
        &kCFTypeDictionaryKeyCallBacks, &kCFTypeDictionaryValueCallBacks);
    if (!options)
        return {};
    const auto releaseOptions = qScopeGuard([options] { CFRelease(options); });
    const auto preview = CGImageSourceCreateThumbnailAtIndex(source, 0, options);
    if (!preview)
        return {};
    const auto releasePreview = qScopeGuard([preview] { CFRelease(preview); });
    const auto jpeg = CFDataCreateMutable(kCFAllocatorDefault, 0);
    if (!jpeg)
        return {};
    const auto releaseJpeg = qScopeGuard([jpeg] { CFRelease(jpeg); });
    const auto encoder = CGImageDestinationCreateWithData(jpeg, CFSTR("public.jpeg"), 1, nullptr);
    if (!encoder)
        return {};
    const auto releaseEncoder = qScopeGuard([encoder] { CFRelease(encoder); });
    CGImageDestinationAddImage(encoder, preview, nullptr);
    if (!CGImageDestinationFinalize(encoder))
        return {};
    return QByteArray(reinterpret_cast<const char *>(CFDataGetBytePtr(jpeg)), CFDataGetLength(jpeg));
}

QUrl acceptedThumbnail(const QJsonObject &payload) {
    if (payload.contains("error") || payload["ok"] == false || payload["mime"] != "image/jpeg")
        return {};
    const auto url = payload["data_url"].toString();
    if (url.size() > 1048576 || !url.startsWith(QString::fromLatin1(JpegPrefix)))
        return {};
    const auto decoded = QByteArray::fromBase64Encoding(url.mid(JpegPrefix.size()).toLatin1(),
                                                      QByteArray::AbortOnBase64DecodingErrors);
    if (!decoded)
        return {};
    QBuffer input;
    input.setData(decoded.decoded);
    if (!input.open(QIODevice::ReadOnly))
        return {};
    QImageReader reader(&input, "jpeg");
    const auto dimensions = reader.size();
    if (!dimensions.isValid() || qMax(dimensions.width(), dimensions.height()) > MaxThumbnailEdge ||
        reader.read().isNull())
        return {};
    return QUrl(url);
}
}

bool RuntimeBridge::chatImageCanChoose() const {
    return m_connected && !m_stopping && !m_busy && runtimeWritable() && !personaChanging() &&
           !m_offline && m_networkFeedback.value("known").toBool() &&
           m_networkFeedback.value("status") != "pending";
}

bool RuntimeBridge::chatImageCanSend() const {
    return chatImageCanChoose() && chatSendGate().isEmpty();
}

void RuntimeBridge::setChatImageFeedback(const QString &text) {
    m_chatImageFeedback = text;
    emit chatImagesChanged();
}

bool RuntimeBridge::chooseChatImage(const QUrl &file) {
    if (!chatImageCanChoose())
        return false;
    m_chatImagePreview = QUrl{};
    m_chatImagePath.clear();
    m_chatImageData.clear();
    const auto path = file.toLocalFile();
    const QFileInfo info(path);
    if (!file.isLocalFile() || !info.isAbsolute() || path.toUcs4().size() > 1024 ||
        std::any_of(path.cbegin(), path.cend(), [](QChar ch) { return ch.unicode() < 32; }) ||
        !info.isFile()) {
        setChatImageFeedback(CannotRead);
        return false;
    }
    if (info.size() > MaxFileBytes) {
        setChatImageFeedback(TooBig);
        return false;
    }
    QFile input(path);
    if (!input.open(QIODevice::ReadOnly)) {
        setChatImageFeedback(CannotRead);
        return false;
    }
    const auto bytes = input.read(MaxFileBytes + 1);
    if (bytes.size() > MaxFileBytes) {
        setChatImageFeedback(TooBig);
        return false;
    }
    QString problem = CannotRead;
    m_chatImagePreview = jpegUrl(filePreview(bytes, problem));
    if (m_chatImagePreview.isEmpty()) {
        setChatImageFeedback(problem);
        return false;
    }
    m_chatImagePath = path;
    setChatImageFeedback({});
    return true;
}

bool RuntimeBridge::pasteChatImage() {
    const auto clipboard = QGuiApplication::clipboard();
    const auto mime = clipboard ? clipboard->mimeData() : nullptr;
    if (!mime || !mime->hasImage())
        return false;
    if (chatImageCanChoose())
        stagePastedChatImage(clipboard->image());
    return true;
}

bool RuntimeBridge::stagePastedChatImage(const QImage &input) {
    if (!chatImageCanChoose())
        return false;
    m_chatImagePreview = QUrl{};
    m_chatImagePath.clear();
    m_chatImageData.clear();
    if (input.isNull()) {
        setChatImageFeedback(CannotRead);
        return false;
    }
    if (qint64(input.width()) * input.height() > MaxFilePixels) {
        setChatImageFeedback(CannotPaste);
        return false;
    }
    const auto scaled = qMax(input.width(), input.height()) > MaxClipboardEdge
        ? input.scaled(MaxClipboardEdge, MaxClipboardEdge, Qt::KeepAspectRatio, Qt::SmoothTransformation) : input;
    for (const int quality : {90, 85, 80, 75, 70, 65, 60}) {
        const auto jpeg = encodeJpeg(scaled, quality);
        if (jpeg.isEmpty())
            break;
        const auto encoded = JpegPrefix + jpeg.toBase64();
        if (encoded.size() > MaxClipboardUrl)
            continue;
        const auto preview = qMax(scaled.width(), scaled.height()) > MaxPreviewEdge
            ? scaled.scaled(MaxPreviewEdge, MaxPreviewEdge, Qt::KeepAspectRatio, Qt::SmoothTransformation) : scaled;
        m_chatImagePreview = jpegUrl(encodeJpeg(preview, 85));
        if (!m_chatImagePreview.isEmpty()) {
            m_chatImageData = QString::fromLatin1(encoded);
            setChatImageFeedback({});
            return true;
        }
        break;
    }
    setChatImageFeedback(CannotPaste);
    return false;
}

void RuntimeBridge::removeChatImage() {
    m_chatImagePreview = QUrl{};
    m_chatImagePath.clear();
    m_chatImageData.clear();
    setChatImageFeedback({});
}

void RuntimeBridge::appendChatImageFields(QVariantMap &payload) const {
    if (!m_chatImagePath.isEmpty())
        payload["image_path"] = m_chatImagePath;
    else if (!m_chatImageData.isEmpty())
        payload["image_data_url"] = m_chatImageData;
}

void RuntimeBridge::resetChatImages(bool discardDraft) {
    m_pending.remove(m_chatImageReadId);
    m_chatImageReadId.clear();
    m_chatImageReadMedia.clear();
    m_chatImageReadPersona = {};
    m_chatImageReads.clear();
    m_chatImageThumbnails.clear();
    m_chatImageInFlight = false;
    m_chatImageSentDraft.clear();
    if (discardDraft)
        removeChatImage();
    else
        emit chatImagesChanged();
}

void RuntimeBridge::discoverChatImageThumbnails() {
    for (auto it = m_chatImageThumbnails.begin(); it != m_chatImageThumbnails.end();) {
        if (!isImageId(it.key()))
            it = m_chatImageThumbnails.erase(it);
        else
            ++it;
    }
    bool discovered = false;
    for (const auto &message : m_messages) {
        const auto row = message.toMap();
        if (row.value("role") != "user")
            continue;
        for (const auto &attachment : row.value("media").toList()) {
            const auto media = attachment.toMap();
            const auto id = media.value("media_id").toString();
            if (media.value("mime") != "image/jpeg" || !isImageId(id) || m_chatImageThumbnails.contains(id))
                continue;
            m_chatImageThumbnails[id] = QVariantMap{{"status", "loading"}};
            m_chatImageReads.append(id);
            discovered = true;
        }
    }
    if (discovered)
        emit chatImagesChanged();
    readNextChatImageThumbnail();
}

void RuntimeBridge::readNextChatImageThumbnail() {
    if (!m_connected || m_stopping || personaChanging() || !m_chatImageReadMedia.isEmpty() || m_chatImageReads.isEmpty())
        return;
    m_chatImageReadMedia = m_chatImageReads.takeFirst();
    m_chatImageReadPersona = m_persona;
    m_chatImageReadId = request("chat:media", {{"media_id", m_chatImageReadMedia}, {"thumbnail", true}});
    if (m_chatImageReadId.isEmpty())
        settleChatImageThumbnail();
}

void RuntimeBridge::settleChatImageThumbnail(const QUrl &url) {
    const auto media = m_chatImageReadMedia;
    m_chatImageReadMedia.clear();
    m_chatImageReadId.clear();
    m_chatImageReadPersona = {};
    if (media.isEmpty())
        return;
    m_chatImageThumbnails[media] = url.isEmpty() ? QVariantMap{{"status", "error"}}
                                              : QVariantMap{{"status", "ready"}, {"source", url}};
    emit chatImagesChanged();
    // Yield before the next read to keep the framed receive buffer bounded.
    QTimer::singleShot(0, this, [this] { readNextChatImageThumbnail(); });
}

bool RuntimeBridge::acceptChatImageThumbnail(const QJsonObject &frame, const QJsonObject &payload, const QString &id) {
    const auto type = frame["type"].toString();
    if (type != "chat:media:result" && m_pending.value(id).command != "chat:media")
        return false;
    if (!m_connected || m_stopping || personaChanging() || id.isEmpty() || id != m_chatImageReadId ||
        m_pending.value(id).command != "chat:media" || m_pending.value(id).generation != m_generation ||
        m_chatImageReadPersona != m_persona || (type != "chat:media:result" && type != "error") ||
        (frame.contains("request_id") && frame["request_id"] != id) ||
        (payload.contains("request_id") && payload["request_id"] != id) ||
        (payload.contains("persona_id") && payload["persona_id"] != m_persona["persona_id"]) ||
        (payload.contains("persona_epoch") && payload["persona_epoch"] != m_persona["epoch"]) ||
        (payload.contains("persona_fingerprint") && payload["persona_fingerprint"] != m_persona["fingerprint"]) ||
        (payload.contains("media_id") && payload["media_id"] != m_chatImageReadMedia) ||
        (type == "chat:media:result" && !payload.contains("media_id") && !payload.contains("error")))
        return true;
    m_pending.remove(id);
    const auto media = m_chatImageReadMedia;
    const auto url = type == "chat:media:result" ? acceptedThumbnail(payload) : QUrl{};
    settleChatImageThumbnail(url);
    emit responseReceived(id, "chat:media", {{"media_id", media}, {"ok", !url.isEmpty()}}, m_generation);
    return true;
}

bool RuntimeBridge::rejectSentChatImage(const QJsonObject &payload) {
    if (!m_chatImageInFlight || payload["scope"] != "chat")
        return false;
    const QHash<QString, QString> reasons{{"image_format_unsupported", Unsupported},
        {"image_too_large", TooBig}, {"image_unreadable", CannotRead},
        {"image_processing_failed", "图片没有发出"}};
    const auto reason = reasons.value(payload["code"].toString());
    if (reason.isEmpty())
        return false;
    const auto id = m_chatId;
    for (qsizetype index = m_messages.size(); index > 0; --index) {
        if (m_messages.at(index - 1).toMap().value("id") == id) {
            m_messages.removeAt(index - 1);
            break;
        }
    }
    m_chatImageThumbnails.remove(id);
    finishChat("failed");
    setChatImageFeedback(reason);
    emit messagesChanged();
    return true;
}
