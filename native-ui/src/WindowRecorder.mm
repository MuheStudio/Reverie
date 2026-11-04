#include "WindowRecorder.h"
#include "TransitionDiagnostics.h"

#include <AVFoundation/AVFoundation.h>
#include <CoreVideo/CoreVideo.h>
#include <Foundation/Foundation.h>
#include <QDir>
#include <QElapsedTimer>
#include <QEventLoop>
#include <QFileInfo>
#include <QImage>
#include <QPainter>
#include <QPointer>
#include <QQuickWindow>
#include <QThread>
#include <QTimer>
#include <atomic>
#include <dispatch/dispatch.h>
#include <limits>

namespace {
constexpr int canvasWidth = 1380;
constexpr int canvasHeight = 900;
constexpr int captureIntervalMs = 33;
constexpr int finishTimeoutMs = 15000;
constexpr int32_t timestampScale = 1000000000;

QString describeError(NSError *error, const QString &fallback) {
    return error ? QString::fromUtf8(error.localizedDescription.UTF8String) : fallback;
}

void cancelWithoutBlocking(AVAssetWriter *writer) {
    // cancelWriting is documented to block until cancellation finishes. Keep
    // it off the GUI thread so even a wedged encoder cannot defeat our timeout.
    // ARC retains the writer for this block; it owns no WindowRecorder pointer.
    dispatch_async(dispatch_get_global_queue(QOS_CLASS_UTILITY, 0), ^{
      @autoreleasepool {
          [writer cancelWriting];
      }
    });
}
} // namespace

struct WindowRecorder::Private {
    enum class State { Idle, Recording, Finishing, Finished, Failed };
    QPointer<QQuickWindow> window;
    QTimer *timer = nullptr;
    QElapsedTimer clock;
    State state = State::Idle;
    QString file;
    QString error;
    quint64 frames = 0;
    quint64 attempts = 0;
    quint64 dropped = 0;
    quint64 notReady = 0;
    quint64 missedTimerTicks = 0;
    quint64 emptyCaptures = 0;
    quint64 allocationFailures = 0;
    quint64 appendFailures = 0;
    qint64 lastTimestampNs = -1;
    qint64 lastAttemptSlot = -1;
    qint64 stopTimestampNs = 0;
    bool finishTimedOut = false;
    bool cancellationRequested = false;
    QVariantList timestampsNs;
    QVariantList sourceSizes;
    QSize lastSourceSize;
    __strong AVAssetWriter *writer = nil;
    __strong AVAssetWriterInput *input = nil;
    __strong AVAssetWriterInputPixelBufferAdaptor *adaptor = nil;
};

WindowRecorder::WindowRecorder(QQuickWindow *window, QObject *parent)
    : QObject(parent), d(std::make_unique<Private>()) {
    d->window = window;
    d->timer = new QTimer(this);
    d->timer->setTimerType(Qt::PreciseTimer);
    d->timer->setInterval(captureIntervalMs);
    connect(d->timer, &QTimer::timeout, this, &WindowRecorder::captureFrame);
}

WindowRecorder::~WindowRecorder() {
    d->timer->stop();
    // Explicit finish() is the only successful completion path. Destruction
    // cannot wait indefinitely for an encoder or report an unfinished movie.
    @autoreleasepool {
        if (d->writer && d->writer.status == AVAssetWriterStatusWriting)
            cancelWithoutBlocking(d->writer);
    }
}

bool WindowRecorder::start(QString file) {
    if (d->state != Private::State::Idle) {
        if (d->error.isEmpty())
            d->error = QStringLiteral("WindowRecorder is a single-use recorder");
        return false;
    }
    if (QThread::currentThread() != thread() || !d->window || d->window->thread() != thread()) {
        fail(QStringLiteral("Window recording must start on its QQuickWindow GUI thread"));
        return false;
    }
    if (file.isEmpty() || file.contains(QChar::Null) ||
        QFileInfo(file).suffix().compare(QStringLiteral("mov"), Qt::CaseInsensitive) != 0) {
        fail(QStringLiteral("Window recording requires a local .mov output path"));
        return false;
    }
    const QFileInfo output(file);
    d->file = output.absoluteFilePath();
    if (output.exists() || output.isSymLink()) {
        fail(QStringLiteral("Window recording refuses to overwrite an existing output"));
        return false;
    }
    if (!QDir().mkpath(output.absolutePath())) {
        fail(QStringLiteral("Window recording output directory could not be created"));
        return false;
    }
    @autoreleasepool {
        NSError *writerError = nil;
        NSString *path = [NSString stringWithUTF8String:d->file.toUtf8().constData()];
        d->writer = [[AVAssetWriter alloc] initWithURL:[NSURL fileURLWithPath:path]
                                              fileType:AVFileTypeQuickTimeMovie
                                                 error:&writerError];
        if (!d->writer) {
            fail(describeError(writerError, QStringLiteral("AVAssetWriter could not be created")));
            return false;
        }
        NSDictionary *settings = @{
            AVVideoCodecKey : AVVideoCodecTypeH264,
            AVVideoWidthKey : @(canvasWidth),
            AVVideoHeightKey : @(canvasHeight),
            AVVideoCompressionPropertiesKey : @{
                AVVideoAverageBitRateKey : @8000000,
                AVVideoExpectedSourceFrameRateKey : @30,
                AVVideoMaxKeyFrameIntervalKey : @60,
                AVVideoAllowFrameReorderingKey : @NO,
                AVVideoProfileLevelKey : AVVideoProfileLevelH264HighAutoLevel
            }
        };
        if (![d->writer canApplyOutputSettings:settings forMediaType:AVMediaTypeVideo]) {
            fail(QStringLiteral("AVAssetWriter cannot encode the requested H.264 settings"));
            return false;
        }
        d->input = [AVAssetWriterInput assetWriterInputWithMediaType:AVMediaTypeVideo
                                                      outputSettings:settings];
        d->input.expectsMediaDataInRealTime = YES;
        NSDictionary *attributes = @{
            (__bridge id)kCVPixelBufferPixelFormatTypeKey : @(kCVPixelFormatType_32BGRA),
            (__bridge id)kCVPixelBufferWidthKey : @(canvasWidth),
            (__bridge id)kCVPixelBufferHeightKey : @(canvasHeight),
            (__bridge id)kCVPixelBufferCGImageCompatibilityKey : @YES,
            (__bridge id)kCVPixelBufferCGBitmapContextCompatibilityKey : @YES,
            (__bridge id)kCVPixelBufferIOSurfacePropertiesKey : @{}
        };
        d->adaptor = [AVAssetWriterInputPixelBufferAdaptor
            assetWriterInputPixelBufferAdaptorWithAssetWriterInput:d->input
                                       sourcePixelBufferAttributes:attributes];
        if (![d->writer canAddInput:d->input]) {
            fail(QStringLiteral("AVAssetWriter rejected the video input"));
            return false;
        }
        [d->writer addInput:d->input];
        if (![d->writer startWriting]) {
            fail(describeError(d->writer.error, QStringLiteral("AVAssetWriter failed to start")));
            return false;
        }
        [d->writer startSessionAtSourceTime:kCMTimeZero];
        d->clock.start();
        d->state = Private::State::Recording;
        d->timer->start();
        QTimer::singleShot(0, this, &WindowRecorder::captureFrame);
    }
    return true;
}

void WindowRecorder::fail(const QString &message) {
    d->timer->stop();
    if (d->clock.isValid() && d->stopTimestampNs == 0)
        d->stopTimestampNs = d->clock.nsecsElapsed();
    if (d->error.isEmpty())
        d->error = message;
    d->state = Private::State::Failed;
}

void WindowRecorder::captureFrame() {
    if (d->state != Private::State::Recording)
        return;
    const qint64 slot = d->clock.nsecsElapsed() / (captureIntervalMs * 1000000LL);
    if (slot > d->lastAttemptSlot + 1) {
        const quint64 missed = static_cast<quint64>(slot - d->lastAttemptSlot - 1);
        d->missedTimerTicks += missed;
        d->dropped += missed;
    }
    d->lastAttemptSlot = qMax(d->lastAttemptSlot, slot);
    ++d->attempts;
    if (!d->window) {
        ++d->dropped;
        fail(QStringLiteral("The recorded QQuickWindow was destroyed"));
        return;
    }
    @autoreleasepool {
        if (d->writer.status != AVAssetWriterStatusWriting) {
            ++d->dropped;
            fail(describeError(d->writer.error,
                               QStringLiteral("AVAssetWriter stopped during capture")));
            return;
        }
        if (!d->input.readyForMoreMediaData) {
            ++d->notReady;
            ++d->dropped;
            return;
        }
        // grabWindow reads only this QQuickWindow's own render result. It is a
        // synchronous GPU readback, so this run is unsuitable for performance
        // conclusions. No display capture, frame synthesis or duplicate fill.
#ifdef REVERIE_TIMING_DIAGNOSTICS
        TransitionDiagnostics::captureBegin(d->attempts, slot);
#endif
        QImage source = d->window->grabWindow();
        const qint64 timestampNs = d->clock.nsecsElapsed();
#ifdef REVERIE_TIMING_DIAGNOSTICS
        TransitionDiagnostics::captureEnd(d->attempts, timestampNs, !source.isNull());
#endif
        if (source.isNull()) {
            ++d->emptyCaptures;
            ++d->dropped;
            return;
        }
        if (timestampNs <= d->lastTimestampNs) {
            ++d->dropped;
            return;
        }
        CVPixelBufferRef buffer = nullptr;
        CVPixelBufferPoolRef pool = d->adaptor.pixelBufferPool;
        const CVReturn allocation =
            pool ? CVPixelBufferPoolCreatePixelBuffer(kCFAllocatorDefault, pool, &buffer)
                 : kCVReturnInvalidArgument;
        if (allocation != kCVReturnSuccess || !buffer) {
            ++d->allocationFailures;
            ++d->dropped;
            fail(QStringLiteral("Video pixel buffer allocation failed (%1)").arg(allocation));
            return;
        }
        const CVReturn locked = CVPixelBufferLockBaseAddress(buffer, 0);
        const size_t stride = CVPixelBufferGetBytesPerRow(buffer);
        void *pixels = locked == kCVReturnSuccess ? CVPixelBufferGetBaseAddress(buffer) : nullptr;
        if (!pixels || stride > static_cast<size_t>(std::numeric_limits<qsizetype>::max())) {
            if (locked == kCVReturnSuccess)
                CVPixelBufferUnlockBaseAddress(buffer, 0);
            CVPixelBufferRelease(buffer);
            ++d->allocationFailures;
            ++d->dropped;
            fail(QStringLiteral("Video pixel buffer could not be mapped (%1)").arg(locked));
            return;
        }
        {
            // On arm64 macOS, QImage ARGB32 memory is BGRA, matching the pool.
            QImage canvas(static_cast<uchar *>(pixels), canvasWidth, canvasHeight,
                          static_cast<qsizetype>(stride), QImage::Format_ARGB32_Premultiplied);
            canvas.fill(Qt::black);
            source.setDevicePixelRatio(1);
            const QSize fitted =
                source.size().scaled(QSize(canvasWidth, canvasHeight), Qt::KeepAspectRatio);
            const QRect target((canvasWidth - fitted.width()) / 2,
                               (canvasHeight - fitted.height()) / 2, fitted.width(),
                               fitted.height());
            QPainter painter(&canvas);
            painter.setRenderHint(QPainter::SmoothPixmapTransform);
            painter.drawImage(target, source, source.rect());
        }
        CVPixelBufferUnlockBaseAddress(buffer, 0);
        const BOOL accepted =
            [d->adaptor appendPixelBuffer:buffer
                     withPresentationTime:CMTimeMake(timestampNs, timestampScale)];
        CVPixelBufferRelease(buffer);
        if (!accepted) {
            ++d->appendFailures;
            ++d->dropped;
            fail(describeError(d->writer.error,
                               QStringLiteral("AVAssetWriter rejected a captured frame")));
            return;
        }
        ++d->frames;
#ifdef REVERIE_TIMING_DIAGNOSTICS
        // An appended media frame is separate evidence from progress signals
        // and frameSwapped. Its pixel content is not inferred from either.
        TransitionDiagnostics::frameAppended(d->attempts, d->frames, timestampNs);
#endif
        d->lastTimestampNs = timestampNs;
        d->timestampsNs.append(timestampNs);
        if (source.size() != d->lastSourceSize) {
            d->lastSourceSize = source.size();
            d->sourceSizes.append(QVariantMap{{"timestampNs", timestampNs},
                                              {"pixelWidth", source.width()},
                                              {"pixelHeight", source.height()},
                                              {"windowWidth", d->window->width()},
                                              {"windowHeight", d->window->height()}});
        }
    }
}

QVariantMap WindowRecorder::finish() {
    if (QThread::currentThread() != thread()) {
        return {{"ok", false}, {"error", "WindowRecorder::finish must run on the GUI thread"}};
    }
    d->timer->stop();
    if (d->state == Private::State::Finished || d->state == Private::State::Finishing)
        return result();
    if (d->clock.isValid() && d->stopTimestampNs == 0)
        d->stopTimestampNs = d->clock.nsecsElapsed();
    if (d->state == Private::State::Idle) {
        fail(QStringLiteral("Window recording was never started"));
        return result();
    }
    @autoreleasepool {
        if (d->writer.status != AVAssetWriterStatusWriting) {
            if (d->state != Private::State::Failed)
                fail(describeError(d->writer.error,
                                   QStringLiteral("AVAssetWriter is not writing a movie")));
            return result();
        }
        d->state = Private::State::Finishing;
        [d->input markAsFinished];
        // The completion block owns only an atomic token. It never references
        // this object or a stack event loop, even if timeout/destruction wins.
        auto completed = std::make_shared<std::atomic_bool>(false);
        [d->writer finishWritingWithCompletionHandler:^{
          completed->store(true, std::memory_order_release);
        }];
        if (!completed->load(std::memory_order_acquire)) {
            QEventLoop loop;
            QTimer poll;
            QTimer deadline;
            poll.setTimerType(Qt::PreciseTimer);
            deadline.setTimerType(Qt::PreciseTimer);
            poll.setInterval(10);
            deadline.setSingleShot(true);
            deadline.setInterval(finishTimeoutMs);
            connect(&poll, &QTimer::timeout, &loop, [&] {
                if (completed->load(std::memory_order_acquire))
                    loop.quit();
            });
            connect(&deadline, &QTimer::timeout, &loop, &QEventLoop::quit);
            poll.start();
            deadline.start();
            loop.exec(QEventLoop::ExcludeUserInputEvents);
        }
        if (!completed->load(std::memory_order_acquire)) {
            d->finishTimedOut = true;
            fail(QStringLiteral("AVAssetWriter finishWriting timed out after %1 ms")
                     .arg(finishTimeoutMs));
            d->cancellationRequested = true;
            cancelWithoutBlocking(d->writer);
        } else if (d->writer.status != AVAssetWriterStatusCompleted) {
            fail(describeError(d->writer.error,
                               QStringLiteral("AVAssetWriter did not complete the movie")));
        } else {
            const QFileInfo output(d->file);
            if (d->frames == 0)
                fail(QStringLiteral("Window recording contains no captured frames"));
            else if (!output.isFile() || output.size() <= 0)
                fail(QStringLiteral("AVAssetWriter completed without a nonempty movie file"));
            else if (!d->error.isEmpty())
                d->state = Private::State::Failed;
            else
                d->state = Private::State::Finished;
        }
    }
    return result();
}

QVariantMap WindowRecorder::result() const {
    REVERIE_TRANSITION_POINT("recording-terminal", {{"passed", d->state == Private::State::Finished &&
                                                   d->error.isEmpty()}, {"error", d->error}});
    return {{"ok", d->state == Private::State::Finished && d->error.isEmpty()},
            {"file", d->file},
            {"error", d->error},
            {"frames", d->frames},
            {"attempts", d->attempts},
            {"dropped", d->dropped},
            {"notReady", d->notReady},
            {"missedTimerTicks", d->missedTimerTicks},
            {"emptyCaptures", d->emptyCaptures},
            {"allocationFailures", d->allocationFailures},
            {"appendFailures", d->appendFailures},
            {"duration", duration()},
            {"width", width()},
            {"height", height()},
            {"intervalMs", captureIntervalMs},
            {"finishTimeoutMs", finishTimeoutMs},
            {"finishTimedOut", d->finishTimedOut},
            {"cancellationRequested", d->cancellationRequested},
            {"codec", "H.264"},
            {"container", "QuickTime .mov"},
            {"captureSource", "The supplied QQuickWindow::grabWindow only"},
            {"timestampBasis", "QElapsedTimer monotonic nanoseconds after each actual grabWindow"},
            {"dropCountBasis", "Skipped captures plus unoccupied elapsed 33 ms timer slots"},
            {"frameTimestampsNs", d->timestampsNs},
            {"sourceSizes", d->sourceSizes},
            {"timingIsRecordingEvidenceOnly", true}};
}

QString WindowRecorder::error() const { return d->error; }
quint64 WindowRecorder::frames() const { return d->frames; }
double WindowRecorder::duration() const {
    const qint64 elapsed = d->state == Private::State::Recording && d->clock.isValid()
                               ? d->clock.nsecsElapsed()
                               : d->stopTimestampNs;
    return static_cast<double>(elapsed) / timestampScale;
}
int WindowRecorder::width() const { return canvasWidth; }
int WindowRecorder::height() const { return canvasHeight; }
