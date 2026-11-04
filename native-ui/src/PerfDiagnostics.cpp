#include "PerfDiagnostics.h"
#include "TimingTrace.h"

#include <QJsonArray>
#include <QDynamicPropertyChangeEvent>
#include <QLoggingCategory>
#include <QMutex>
#include <QMutexLocker>
#include <QOpenGLContext>
#include <QOpenGLFunctions>
#include <QPointer>
#include <QQmlProperty>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRunnable>
#include <QScreen>
#include <QSGRendererInterface>
#include <QSGTexture>
#include <QSGTextureProvider>
#include <QSurfaceFormat>
#include <QThread>
#include <QTimer>
#include <algorithm>
#include <array>
#include <chrono>
#include <cstdio>
#include <functional>
#include <limits>
#include <mutex>
#include <utility>
#include <vector>

namespace {
constexpr qsizetype MaxFrames = 60000;
constexpr qsizetype MaxTextureEvents = 16000;
constexpr qsizetype MaxLogMessages = 2048;
constexpr qsizetype MaxIdentityObjects = 16000;
constexpr qsizetype MaxTargets = 512;
constexpr qsizetype MaxContexts = 64;
constexpr size_t QueryRingSize = 8;

struct CapturedLog {
    QString category;
    QString message;
};
struct LogCapture {
    QMutex mutex;
    bool installed = false;
    QtMessageHandler previous = nullptr;
    std::vector<CapturedLog> messages;
    quint64 dropped = 0;
};
LogCapture &logCapture() {
    static LogCapture capture;
    return capture;
}
void captureMessage(QtMsgType type, const QMessageLogContext &context, const QString &message) {
    auto &capture = logCapture();
    QtMessageHandler previous = nullptr;
    const QString category = QString::fromUtf8(context.category ? context.category : "default");
    {
        QMutexLocker lock(&capture.mutex);
        previous = capture.previous;
        if (capture.installed &&
            (category.startsWith("qt.scenegraph") || category.startsWith("qt.rhi"))) {
            if (capture.messages.size() < size_t(MaxLogMessages))
                capture.messages.push_back({category, message});
            else
                ++capture.dropped;
        }
    }
    if (previous)
        previous(type, context, message);
    else {
        const auto formatted = qFormatLogMessage(type, context, message).toLocal8Bit();
        std::fwrite(formatted.constData(), 1, size_t(formatted.size()), stderr);
        std::fputc('\n', stderr);
    }
}
QString identity(const void *pointer) {
    return pointer ? QStringLiteral("0x%1").arg(quintptr(pointer), 0, 16) : QString();
}
QJsonObject dimensions(const QSize &size) {
    return {{"width", size.width()}, {"height", size.height()}};
}
QString filtering(QSGTexture::Filtering value) {
    switch (value) {
    case QSGTexture::None: return "none";
    case QSGTexture::Nearest: return "nearest";
    case QSGTexture::Linear: return "linear";
    }
    return "unknown";
}
QString profile(QSurfaceFormat::OpenGLContextProfile value) {
    switch (value) {
    case QSurfaceFormat::NoProfile: return "no_profile";
    case QSurfaceFormat::CoreProfile: return "core";
    case QSurfaceFormat::CompatibilityProfile: return "compatibility";
    }
    return "unknown";
}
QString graphicsApi(QSGRendererInterface::GraphicsApi api) {
    switch (api) {
    case QSGRendererInterface::Unknown: return "unknown";
    case QSGRendererInterface::Software: return "software";
    case QSGRendererInterface::OpenVG: return "openvg";
    case QSGRendererInterface::OpenGL: return "opengl";
    case QSGRendererInterface::Direct3D11: return "direct3d11";
    case QSGRendererInterface::Vulkan: return "vulkan";
    case QSGRendererInterface::Metal: return "metal";
    case QSGRendererInterface::Null: return "null";
    case QSGRendererInterface::Direct3D12: return "direct3d12";
    }
    return "unknown";
}
QString itemPath(QQuickItem *item) {
    QStringList parts;
    for (auto *current = item; current; current = current->parentItem()) {
        QString label = current->objectName();
        if (label.isEmpty()) {
            label = QString::fromLatin1(current->metaObject()->className());
            if (auto *parent = current->parentItem())
                label += QStringLiteral("[%1]").arg(parent->childItems().indexOf(current));
        }
        parts.prepend(label);
    }
    return parts.join('/');
}
void collectItems(QQuickItem *root, QList<QQuickItem *> &items) {
    if (!root)
        return;
    items.push_back(root);
    for (auto *child : root->childItems())
        collectItems(child, items);
}
QQuickItem *itemProperty(QObject *object, const char *name) {
    const auto value = object->property(name);
    if (auto *item = value.value<QQuickItem *>())
        return item;
    return qobject_cast<QQuickItem *>(value.value<QObject *>());
}
QJsonObject requestedProperties(QQuickItem *item) {
    QJsonObject result{{"itemSize", QJsonObject{{"width", item->width()}, {"height", item->height()}}},
                       {"visible", item->isVisible()}, {"smooth", item->smooth()}};
    const auto size = item->property("textureSize");
    if (size.isValid())
        result["requestedTextureSize"] = dimensions(size.toSize());
    for (const auto *name : {"live", "hideSource", "recursive", "mipmap"}) {
        const auto value = item->property(name);
        if (value.isValid())
            result[QString::fromLatin1(name)] = QJsonValue::fromVariant(value);
    }
    if (auto *source = itemProperty(item, "sourceItem")) {
        result["sourceItemObjectName"] = source->objectName();
        result["sourceItemClass"] = source->metaObject()->className();
        result["sourceItemIdentity"] = identity(source);
    }
    const auto rect = item->property("sourceRect");
    if (rect.isValid()) {
        const auto r = rect.toRectF();
        result["sourceRect"] = QJsonObject{{"x", r.x()}, {"y", r.y()},
                                           {"width", r.width()}, {"height", r.height()}};
    }
    if (item->objectName() == "roomWithAvatar" || item->objectName() == "lowerComposition") {
        result["layerEnabled"] = QQmlProperty::read(item, "layer.enabled").toBool();
        result["requestedLayerTextureSize"] =
            dimensions(QQmlProperty::read(item, "layer.textureSize").toSize());
    }
    result["scope"] = "Requested properties; not measured GPU allocation";
    return result;
}
class FunctionJob final : public QRunnable {
public:
    explicit FunctionJob(std::function<void()> fn) : fn(std::move(fn)) {}
    void run() override { fn(); }
private:
    std::function<void()> fn;
};
} // namespace

struct PerfDiagnostics::Impl {
    using Clock = std::chrono::steady_clock;
    struct Frame {
        quint64 sequence = 0;
        QString phase;
        qint64 beforeSync = -1;
        qint64 afterSync = -1;
        qint64 beforeRender = -1;
        qint64 afterRender = -1;
        qint64 swapped = -1;
    };
    struct TextureState {
        quint64 provider = 0;
        quint64 texture = 0;
        GLuint native = 0;
        bool nativeAvailable = false;
        QSize size;
        QSGTexture::Filtering filter = QSGTexture::None;
        QSGTexture::Filtering mipmapFilter = QSGTexture::None;
        qint64 comparisonKey = 0;
        bool alpha = false;
        bool mipmaps = false;
        bool atlas = false;
        bool operator==(const TextureState &) const = default;
    };
    struct Target {
        quint64 id = 0;
        QPointer<QQuickItem> item;
        QString path;
        QString objectName;
        QString className;
        QStringList aliases;
        QJsonObject requested;
        TextureState latest;
        QString lastPhase;
        quint64 observedFrames = 0;
        quint64 providerTransitions = 0;
        quint64 textureTransitions = 0;
        quint64 nativeTransitions = 0;
        bool observed = false;
    };
    struct Provider {
        quint64 id = 0;
        QPointer<QSGTextureProvider> pointer;
        QString address;
        quint64 notifications = 0;
        bool destroyed = false;
    };
    struct Texture {
        quint64 id = 0;
        QPointer<QSGTexture> pointer;
        QString address;
    };
    struct TextureEvent {
        quint64 frame = 0;
        qint64 observedNs = 0;
        QString phase;
        quint64 target = 0;
        TextureState state;
    };
    struct Query {
        GLuint object = 0;
        bool pending = false;
        quint64 frame = 0;
        QString phase;
    };
    struct GpuSample {
        quint64 frame = 0;
        QString phase;
        quint64 durationNs = 0;
        qint64 availableNs = 0;
    };

    mutable QMutex mutex;
    QPointer<QQuickWindow> window;
    QPointer<QTimer> targetRefresh;
    QList<QMetaObject::Connection> connections;
    Clock::time_point started = Clock::now();
    qint64 startedNs = TimingTrace::nowNs();
    QString phase = "unlabelled";
    quint64 sequence = 0;
    Frame currentFrame;
    bool currentFrameActive = false;
    std::vector<Frame> frames;
    quint64 droppedFrames = 0;
    quint64 incompleteFrames = 0;
    quint64 framesWithoutSynchronizing = 0;
    std::vector<Target> targets;
    std::vector<Provider> providers;
    std::vector<Texture> textures;
    std::vector<TextureEvent> textureEvents;
    quint64 droppedTextureEvents = 0;
    std::vector<GpuSample> gpuSamples;
    std::array<Query, QueryRingSize> queries;
    QPointer<QOpenGLContext> timerContext;
    QPointer<QOpenGLContext> observedContext;
    using GetQueryiv = void (*)(GLenum, GLenum, GLint *);
    using GenQueries = void (*)(GLsizei, GLuint *);
    using DeleteQueries = void (*)(GLsizei, const GLuint *);
    using BeginQuery = void (*)(GLenum, GLuint);
    using EndQuery = void (*)(GLenum);
    using GetQueryObjectuiv = void (*)(GLuint, GLenum, GLuint *);
    using GetQueryObjectui64v = void (*)(GLuint, GLenum, GLuint64 *);
    GetQueryiv getQueryiv = nullptr;
    GenQueries genQueries = nullptr;
    DeleteQueries deleteQueries = nullptr;
    BeginQuery beginQuery = nullptr;
    EndQuery endQuery = nullptr;
    GetQueryObjectuiv getQueryObjectuiv = nullptr;
    GetQueryObjectui64v getQueryObjectui64v = nullptr;
    int activeQuery = -1;
    QString gpuStatus = "not_initialized";
    QString gpuReason = "No render-thread OpenGL context observed yet";
    quint64 queryIssued = 0;
    quint64 queryRingBusy = 0;
    quint64 existingQuerySkips = 0;
    quint64 lostQueryResults = 0;
    quint64 queriesRetiredWithCurrentContext = 0;
    quint64 queriesRetiredByContextDestruction = 0;
    quint64 droppedGpuSamples = 0;
    quint64 droppedIdentityObjects = 0;
    quint64 droppedTargets = 0;
    quint64 droppedContextHistory = 0;
    quint64 contextGeneration = 0;
    QJsonArray contextHistory;
    QJsonObject context;
    QJsonObject viewport;
    bool attached = false;
    bool diagnostic = true;
    bool timingOnly = false;
    bool stopping = false;
    bool stopped = false;

    explicit Impl(bool enableDiagnostic, bool onlyTiming)
        : diagnostic(enableDiagnostic && !onlyTiming), timingOnly(onlyTiming) {
        frames.reserve(MaxFrames);
        if (diagnostic) {
            gpuSamples.reserve(MaxFrames);
            textureEvents.reserve(MaxTextureEvents);
            targets.reserve(64);
            providers.reserve(64);
            textures.reserve(64);
        }
    }
    qint64 now() const {
        if (timingOnly)
            return TimingTrace::nowNs() - startedNs;
        return std::chrono::duration_cast<std::chrono::nanoseconds>(Clock::now() - started).count();
    }
    void readContext() {
        auto *gl = QOpenGLContext::currentContext();
        if (!gl || gl == observedContext)
            return;
        observedContext = gl;
        auto *functions = gl->functions();
        auto string = [functions](GLenum name) {
            const auto *value = functions->glGetString(name);
            return value ? QString::fromLatin1(reinterpret_cast<const char *>(value)) : QString();
        };
        const auto format = gl->format();
        QStringList extensions;
        for (const auto &extension : gl->extensions())
            extensions.push_back(QString::fromLatin1(extension));
        extensions.sort();
        context = {{"contextIdentity", identity(gl)}, {"generation", double(++contextGeneration)},
                   {"majorVersion", format.majorVersion()}, {"minorVersion", format.minorVersion()},
                   {"profile", profile(format.profile())}, {"isOpenGLES", gl->isOpenGLES()},
                   {"versionString", string(GL_VERSION)}, {"vendor", string(GL_VENDOR)},
                   {"renderer", string(GL_RENDERER)},
                   {"shadingLanguageVersion", string(GL_SHADING_LANGUAGE_VERSION)},
                   {"extensions", QJsonArray::fromStringList(extensions)},
                   {"depthBufferSize", format.depthBufferSize()},
                   {"stencilBufferSize", format.stencilBufferSize()},
                   {"samples", format.samples()}, {"swapInterval", format.swapInterval()},
                   {"observedAtNs", double(now())},
                   {"graphicsApi", graphicsApi(window->rendererInterface()->graphicsApi())}};
        if (contextHistory.size() < MaxContexts)
            contextHistory.append(context);
        else
            ++droppedContextHistory;
    }
    void initializeQueries() {
        if (!diagnostic)
            return;
        if (gpuStatus != "not_initialized")
            return;
        auto *gl = QOpenGLContext::currentContext();
        if (!gl)
            return;
        const auto format = gl->format();
        const bool core = format.majorVersion() > 3 ||
                          (format.majorVersion() == 3 && format.minorVersion() >= 3);
        const bool arb = gl->hasExtension(QByteArrayLiteral("GL_ARB_timer_query"));
        const bool ext = gl->hasExtension(QByteArrayLiteral("GL_EXT_timer_query"));
        if (gl->isOpenGLES() || !(core || arb || ext)) {
            gpuStatus = "unsupported";
            gpuReason = "No desktop OpenGL 3.3 / ARB_timer_query / EXT_timer_query support";
            return;
        }
        auto resolve = [gl](const char *name, const char *fallback) {
            auto function = gl->getProcAddress(name);
            return function ? function : gl->getProcAddress(fallback);
        };
        getQueryiv = reinterpret_cast<GetQueryiv>(resolve("glGetQueryiv", "glGetQueryivARB"));
        genQueries = reinterpret_cast<GenQueries>(resolve("glGenQueries", "glGenQueriesARB"));
        deleteQueries = reinterpret_cast<DeleteQueries>(resolve("glDeleteQueries", "glDeleteQueriesARB"));
        beginQuery = reinterpret_cast<BeginQuery>(resolve("glBeginQuery", "glBeginQueryARB"));
        endQuery = reinterpret_cast<EndQuery>(resolve("glEndQuery", "glEndQueryARB"));
        getQueryObjectuiv = reinterpret_cast<GetQueryObjectuiv>(
            resolve("glGetQueryObjectuiv", "glGetQueryObjectuivARB"));
        getQueryObjectui64v = reinterpret_cast<GetQueryObjectui64v>(
            resolve("glGetQueryObjectui64v", "glGetQueryObjectui64vEXT"));
        if (!getQueryiv || !genQueries || !deleteQueries || !beginQuery || !endQuery ||
            !getQueryObjectuiv || !getQueryObjectui64v) {
            gpuStatus = "unsupported";
            gpuReason = "Required public OpenGL timer-query functions are unavailable";
            return;
        }
        timerContext = gl;
        std::array<GLuint, QueryRingSize> ids{};
        genQueries(GLsizei(ids.size()), ids.data());
        for (size_t index = 0; index < queries.size(); ++index)
            queries[index].object = ids[index];
        if (std::any_of(ids.begin(), ids.end(), [](GLuint id) { return id == 0; })) {
            releaseQueries();
            gpuStatus = "unsupported";
            gpuReason = "glGenQueries did not create all query IDs with the actual context current";
            return;
        }
        gpuStatus = "supported";
        gpuReason = core ? "Desktop OpenGL >= 3.3 and all native query IDs created" :
                    arb ? "GL_ARB_timer_query and all native query IDs created" :
                          "GL_EXT_timer_query and all native query IDs created";
    }
    void releaseQueries() {
        // Native query IDs have no Qt wrapper destructor that can call
        // makeCurrent through a retired context. Never issue a GL operation
        // unless the owning context is still valid and already current.
        const bool current = timerContext && timerContext->isValid() &&
                             QOpenGLContext::currentContext() == timerContext;
        if (activeQuery >= 0 && current && endQuery)
            endQuery(GL_TIME_ELAPSED);
        activeQuery = -1;
        for (auto &query : queries) {
            if (query.pending)
                ++lostQueryResults;
            query.pending = false;
            if (query.object) {
                if (current && deleteQueries) {
                    deleteQueries(1, &query.object);
                    ++queriesRetiredWithCurrentContext;
                } else {
                    // Context destruction owns the remaining driver resources;
                    // there is no C++ wrapper or allocation left to leak.
                    ++queriesRetiredByContextDestruction;
                }
                query.object = 0;
            }
        }
        timerContext = nullptr;
        getQueryiv = nullptr;
        genQueries = nullptr;
        deleteQueries = nullptr;
        beginQuery = nullptr;
        endQuery = nullptr;
        getQueryObjectuiv = nullptr;
        getQueryObjectui64v = nullptr;
    }
    void pollQueries() {
        if (gpuStatus != "supported" || QOpenGLContext::currentContext() != timerContext)
            return;
        for (auto &query : queries) {
            if (!query.pending || !query.object)
                continue;
            GLuint available = 0;
            getQueryObjectuiv(query.object, GL_QUERY_RESULT_AVAILABLE, &available);
            if (!available)
                continue;
            // GL_QUERY_RESULT is read only after the nonblocking availability
            // check succeeds. No glFinish, forced flush, or final blocking drain.
            GLuint64 result = 0;
            getQueryObjectui64v(query.object, GL_QUERY_RESULT, &result);
            if (gpuSamples.size() < size_t(MaxFrames))
                gpuSamples.push_back({query.frame, query.phase, result, now()});
            else
                ++droppedGpuSamples;
            query.pending = false;
        }
    }
    quint64 providerId(QSGTextureProvider *pointer, PerfDiagnostics *owner) {
        if (!pointer)
            return 0;
        for (const auto &provider : providers)
            if (provider.pointer == pointer)
                return provider.id;
        if (providers.size() >= size_t(MaxIdentityObjects)) {
            ++droppedIdentityObjects;
            return 0;
        }
        const quint64 id = providers.size() + 1;
        providers.push_back({id, pointer, identity(pointer), 0, false});
        const auto weak = std::weak_ptr<Impl>(owner->d);
        connections.push_back(QObject::connect(pointer, &QSGTextureProvider::textureChanged, owner,
                                                [weak, id] {
            if (auto state = weak.lock()) {
                QMutexLocker lock(&state->mutex);
                ++state->providers[size_t(id - 1)].notifications;
            }
        }, Qt::DirectConnection));
        connections.push_back(QObject::connect(pointer, &QObject::destroyed, owner, [weak, id] {
            if (auto state = weak.lock()) {
                QMutexLocker lock(&state->mutex);
                state->providers[size_t(id - 1)].destroyed = true;
            }
        }, Qt::DirectConnection));
        return id;
    }
    quint64 textureId(QSGTexture *pointer) {
        if (!pointer)
            return 0;
        for (const auto &texture : textures)
            if (texture.pointer == pointer)
                return texture.id;
        if (textures.size() >= size_t(MaxIdentityObjects)) {
            ++droppedIdentityObjects;
            return 0;
        }
        const quint64 id = textures.size() + 1;
        textures.push_back({id, pointer, identity(pointer)});
        return id;
    }
    void observeTextures(PerfDiagnostics *owner) {
        // afterSynchronizing keeps GUI object lifetimes and public item reads
        // stable. Getter calls happen without our mutex: a provider can emit a
        // notification when it lazily creates its public texture provider.
        std::vector<std::pair<quint64, QPointer<QQuickItem>>> items;
        {
            QMutexLocker lock(&mutex);
            items.reserve(targets.size());
            for (const auto &target : targets)
                items.emplace_back(target.id, target.item);
        }
        for (const auto &[targetId, item] : items) {
            if (!item || item->window() != window)
                continue;
            auto *provider = item->isTextureProvider() ? item->textureProvider() : nullptr;
            auto *texture = provider ? provider->texture() : nullptr;
            TextureState observed;
            if (texture) {
                observed.size = texture->textureSize();
                observed.filter = texture->filtering();
                observed.mipmapFilter = texture->mipmapFiltering();
                observed.comparisonKey = texture->comparisonKey();
                observed.alpha = texture->hasAlphaChannel();
                observed.mipmaps = texture->hasMipmaps();
                observed.atlas = texture->isAtlasTexture();
                if (auto *native = texture->nativeInterface<QNativeInterface::QSGOpenGLTexture>()) {
                    observed.native = native->nativeTexture();
                    observed.nativeAvailable = true;
                }
            }
            QMutexLocker lock(&mutex);
            observed.provider = providerId(provider, owner);
            observed.texture = textureId(texture);
            auto &target = targets[size_t(targetId - 1)];
            ++target.observedFrames;
            if (!target.observed || !(observed == target.latest) || target.lastPhase != phase) {
                if (target.observed) {
                    target.providerTransitions += observed.provider != target.latest.provider;
                    target.textureTransitions += observed.texture != target.latest.texture;
                    target.nativeTransitions += observed.nativeAvailable != target.latest.nativeAvailable ||
                                                observed.native != target.latest.native;
                }
                target.latest = observed;
                target.observed = true;
                target.lastPhase = phase;
                if (textureEvents.size() < size_t(MaxTextureEvents))
                    textureEvents.push_back({sequence, now(), phase, targetId, observed});
                else
                    ++droppedTextureEvents;
            }
        }
    }
    static QJsonObject textureJson(const TextureState &state) {
        QJsonObject result{{"providerObservationId", double(state.provider)},
                           {"textureObservationId", double(state.texture)},
                           {"textureSize", dimensions(state.size)},
                           {"filtering", filtering(state.filter)},
                           {"mipmapFiltering", filtering(state.mipmapFilter)},
                           {"comparisonKey", QString::number(state.comparisonKey)},
                           {"hasAlphaChannel", state.alpha}, {"hasMipmaps", state.mipmaps},
                           {"isAtlasTexture", state.atlas},
                           {"nativeOpenGLTextureAvailable", state.nativeAvailable}};
        result["nativeOpenGLTexture"] = state.nativeAvailable ?
            QJsonValue(double(state.native)) : QJsonValue(QJsonValue::Null);
        return result;
    }
};

PerfDiagnostics::PerfDiagnostics(bool diagnostic, QObject *parent, bool timingOnly)
    : QObject(parent), d(std::make_shared<Impl>(diagnostic, timingOnly)) {
    if (!d->diagnostic) {
        d->gpuStatus = "disabled";
        d->gpuReason = timingOnly ? "Timing-only diagnostic case; all GL and texture queries disabled"
                                 : "GPU queries are enabled only in diagnostic mode";
    }
}

PerfDiagnostics::~PerfDiagnostics() {
    if (d->targetRefresh)
        d->targetRefresh->stop();
    QList<QMetaObject::Connection> connections;
    {
        QMutexLocker lock(&d->mutex);
        connections = std::move(d->connections);
    }
    for (const auto &connection : std::as_const(connections))
        QObject::disconnect(connection);
    QMutexLocker lock(&d->mutex);
    // stop() normally deletes all IDs in a live beforeRendering callback.
    // Destruction never schedules a job against a retiring QQuickWindow. If
    // stop() was skipped during abnormal shutdown, the guard below makes no GL
    // calls without the owning context current, and its destruction retires
    // any remaining driver-owned IDs.
    d->releaseQueries();
}

void PerfDiagnostics::installMessageCapture() {
    auto &capture = logCapture();
    QMutexLocker lock(&capture.mutex);
    if (capture.installed)
        return;
    capture.messages.clear();
    capture.messages.reserve(MaxLogMessages);
    capture.dropped = 0;
    capture.installed = true;
    capture.previous = qInstallMessageHandler(captureMessage);
}

void PerfDiagnostics::uninstallMessageCapture() {
    auto &capture = logCapture();
    QMutexLocker lock(&capture.mutex);
    if (!capture.installed)
        return;
    qInstallMessageHandler(capture.previous);
    capture.installed = false;
    capture.previous = nullptr;
}

bool PerfDiagnostics::attach(QQuickWindow *window) {
    if (!window || d->attached || QThread::currentThread() != window->thread())
        return false;
    d->attached = true;
    d->window = window;
    window->installEventFilter(this);
    const auto initialPhase = window->property("reveriePerfPhase");
    if (initialPhase.isValid())
        d->phase = initialPhase.toString();
    if (d->diagnostic) {
        refreshTargets();
        auto *refresh = new QTimer(this);
        refresh->setInterval(1000);
        d->targetRefresh = refresh;
        QObject::connect(refresh, &QTimer::timeout, this, &PerfDiagnostics::refreshTargets);
        refresh->start();
    }
    auto state = d;
    d->connections.push_back(QObject::connect(window, &QQuickWindow::beforeSynchronizing, this,
                                              [state] {
        TimingTrace::Scope timing(TimingTrace::Kind::BeforeSync);
        QMutexLocker lock(&state->mutex);
        if (state->stopping)
            return;
        if (state->currentFrameActive)
            ++state->incompleteFrames;
        state->currentFrame = {};
        state->currentFrame.sequence = ++state->sequence;
        state->currentFrame.phase = state->phase;
        state->currentFrame.beforeSync = state->now();
        state->currentFrameActive = true;
    }, Qt::DirectConnection));
    d->connections.push_back(QObject::connect(window, &QQuickWindow::afterSynchronizing, this,
                                              [state, this] {
        TimingTrace::Scope timing(TimingTrace::Kind::AfterSync);
        {
            QMutexLocker lock(&state->mutex);
            if (state->stopping)
                return;
            state->currentFrame.afterSync = state->now();
            state->currentFrame.phase = state->phase;
            if (!state->timingOnly) {
                state->readContext();
                state->initializeQueries();
            }
            if (!state->timingOnly && (state->viewport.isEmpty() || state->diagnostic)) {
                auto *screen = state->window->screen();
                const auto dpr = state->window->effectiveDevicePixelRatio();
                state->viewport = {{"logicalWidth", state->window->width()},
                               {"logicalHeight", state->window->height()},
                               {"effectiveDevicePixelRatio", dpr},
                               {"windowDevicePixelRatio", state->window->devicePixelRatio()},
                               {"physicalWidthRounded", qRound(state->window->width() * dpr)},
                               {"physicalHeightRounded", qRound(state->window->height() * dpr)}};
                if (screen) {
                    state->viewport["screen"] = screen->name();
                    state->viewport["screenDevicePixelRatio"] = screen->devicePixelRatio();
                    state->viewport["screenRefreshRateHz"] = screen->refreshRate();
                    state->viewport["refreshRateScope"] = "QScreen reported refresh rate, not measured presentation cadence";
                }
            }
        }
        if (state->diagnostic)
            state->observeTextures(this);
    }, Qt::DirectConnection));
    d->connections.push_back(QObject::connect(window, &QQuickWindow::beforeRendering, this, [state] {
        TimingTrace::Scope timing(TimingTrace::Kind::BeforeRender);
        QMutexLocker lock(&state->mutex);
        if (state->stopping)
            return;
        if (!state->currentFrameActive) {
            state->currentFrame = {};
            state->currentFrame.sequence = ++state->sequence;
            state->currentFrame.phase = state->phase;
            state->currentFrameActive = true;
            ++state->framesWithoutSynchronizing;
        }
        state->currentFrame.beforeRender = state->now();
        if (state->timingOnly)
            return;
        state->readContext();
        state->initializeQueries();
        state->pollQueries();
        if (state->gpuStatus != "supported" || state->activeQuery >= 0 ||
            QOpenGLContext::currentContext() != state->timerContext)
            return;
        GLint existing = 0;
        state->getQueryiv(GL_TIME_ELAPSED, GL_CURRENT_QUERY, &existing);
        if (existing != 0) {
            ++state->existingQuerySkips;
            return;
        }
        for (size_t index = 0; index < state->queries.size(); ++index) {
            auto &query = state->queries[index];
            if (query.pending)
                continue;
            query.frame = state->sequence;
            query.phase = state->phase;
            state->beginQuery(GL_TIME_ELAPSED, query.object);
            state->activeQuery = int(index);
            ++state->queryIssued;
            return;
        }
        ++state->queryRingBusy;
    }, Qt::DirectConnection));
    d->connections.push_back(QObject::connect(window, &QQuickWindow::afterRendering, this, [state] {
        TimingTrace::Scope timing(TimingTrace::Kind::AfterRender);
        QMutexLocker lock(&state->mutex);
        if (state->activeQuery >= 0) {
            auto &query = state->queries[size_t(state->activeQuery)];
            state->endQuery(GL_TIME_ELAPSED);
            query.pending = true;
            state->activeQuery = -1;
        }
        if (state->stopping)
            return;
        state->currentFrame.afterRender = state->now();
        if (auto *gl = state->diagnostic ? QOpenGLContext::currentContext() : nullptr) {
            GLint value[4] = {};
            gl->functions()->glGetIntegerv(GL_VIEWPORT, value);
            state->viewport["glViewportAfterRendering"] =
                QJsonArray{value[0], value[1], value[2], value[3]};
            state->viewport["glViewportScope"] = "Current GL viewport observed afterRendering; no state changed";
        }
    }, Qt::DirectConnection));
    d->connections.push_back(QObject::connect(window, &QQuickWindow::frameSwapped, this, [state] {
        TimingTrace::Scope timing(TimingTrace::Kind::FrameSwapped);
        QMutexLocker lock(&state->mutex);
        if (state->stopping)
            return;
        if (!state->currentFrameActive)
            return;
        state->currentFrame.swapped = state->now();
        if (state->frames.size() < size_t(MaxFrames))
            state->frames.push_back(state->currentFrame);
        else
            ++state->droppedFrames;
        state->currentFrameActive = false;
    }, Qt::DirectConnection));
    d->connections.push_back(QObject::connect(window, &QQuickWindow::sceneGraphInvalidated, this,
                                              [state] {
        QMutexLocker lock(&state->mutex);
        state->releaseQueries();
        if (state->diagnostic) {
            state->gpuStatus = "not_initialized";
            state->gpuReason = "Scene graph invalidated; waiting for the next current context";
        }
        state->context = {};
        state->observedContext = nullptr;
    }, Qt::DirectConnection));
    return true;
}

void PerfDiagnostics::setPhase(const QString &phase) {
#ifdef REVERIE_TIMING_DIAGNOSTICS
    {
        TimingTrace::Scope wait(TimingTrace::Kind::SetPhaseLockWait);
        d->mutex.lock();
    }
    std::lock_guard<QMutex> lock(d->mutex, std::adopt_lock);
    TimingTrace::Scope assignment(TimingTrace::Kind::SetPhaseAssignment);
#else
    QMutexLocker lock(&d->mutex);
#endif
    d->phase = phase;
}

void PerfDiagnostics::stop(std::function<void()> finished) {
    if (d->targetRefresh)
        d->targetRefresh->stop();
    bool hasQueries = false;
    {
        QMutexLocker lock(&d->mutex);
        d->stopping = true;
        for (const auto &query : d->queries)
            hasQueries = hasQueries || query.object != 0;
        if (!hasQueries || !d->window)
            d->stopped = true;
    }
    if (!hasQueries || !d->window) {
        if (finished)
            finished();
        return;
    }
    auto state = d;
    QPointer<PerfDiagnostics> owner(this);
    state->window->scheduleRenderJob(new FunctionJob([state, owner, finished = std::move(finished)] {
        {
            QMutexLocker lock(&state->mutex);
            state->pollQueries();
            state->releaseQueries();
            state->stopped = true;
        }
        if (owner && finished)
            QMetaObject::invokeMethod(owner, [finished] { finished(); }, Qt::QueuedConnection);
    }), QQuickWindow::BeforeRenderingStage);
    state->window->update();
}

bool PerfDiagnostics::eventFilter(QObject *watched, QEvent *event) {
    if (watched == d->window && event->type() == QEvent::DynamicPropertyChange) {
        auto *change = static_cast<QDynamicPropertyChangeEvent *>(event);
        if (change->propertyName() == QByteArrayLiteral("reveriePerfPhase"))
            setPhase(watched->property("reveriePerfPhase").toString());
    }
    return QObject::eventFilter(watched, event);
}

void PerfDiagnostics::refreshTargets() {
    if (!d->diagnostic || !d->window || QThread::currentThread() != d->window->thread())
        return;
    QList<QQuickItem *> items;
    collectItems(d->window->contentItem(), items);
    QHash<QQuickItem *, QStringList> aliases;
    for (auto *item : items) {
        const QString cls = QString::fromLatin1(item->metaObject()->className());
        if (item->objectName() == "roomWithAvatar" || item->objectName() == "lowerComposition" ||
            item->objectName() == "nativeAvatar" || cls.contains("ShaderEffectSource"))
            aliases[item].append(itemPath(item));
        if (item->objectName() == "layerCompositor" || cls.startsWith("BackdropStage") ||
            cls.startsWith("SharedBlur")) {
            for (const auto *name : {"baseTexture", "baseBlur", "dialogueTexture", "dialogueBlur",
                                     "finalTexture", "finalBlur", "texture", "blurredTexture"}) {
                if (auto *target = itemProperty(item, name))
                    aliases[target].append(itemPath(item) + '.' + QString::fromLatin1(name));
            }
        }
    }
    for (auto iterator = aliases.begin(); iterator != aliases.end(); ++iterator) {
        auto *item = iterator.key();
        auto names = iterator.value();
        names.removeDuplicates();
        names.sort();
        auto requested = requestedProperties(item);
        QMutexLocker lock(&d->mutex);
        auto found = std::find_if(d->targets.begin(), d->targets.end(), [item](const auto &target) {
            return target.item == item;
        });
        if (found == d->targets.end()) {
            if (d->targets.size() >= size_t(MaxTargets)) {
                ++d->droppedTargets;
                continue;
            }
            Impl::Target target;
            target.id = d->targets.size() + 1;
            target.item = item;
            target.path = itemPath(item);
            target.objectName = item->objectName();
            target.className = item->metaObject()->className();
            target.aliases = std::move(names);
            target.requested = std::move(requested);
            d->targets.push_back(std::move(target));
        } else {
            found->aliases = std::move(names);
            found->requested = std::move(requested);
        }
    }
}

QJsonObject PerfDiagnostics::snapshot() const {
    QJsonObject report;
    {
        QMutexLocker lock(&d->mutex);
        QJsonArray frames;
        auto milliseconds = [](qint64 value) {
            return value >= 0 ? QJsonValue(double(value) / 1e6) : QJsonValue(QJsonValue::Null);
        };
        auto duration = [&milliseconds](qint64 start, qint64 end) {
            return start >= 0 && end >= start ? milliseconds(end - start) : QJsonValue(QJsonValue::Null);
        };
        for (const auto &frame : d->frames) {
            frames.append(QJsonObject{{"sequence", double(frame.sequence)}, {"phase", frame.phase},
                                       {"beforeSynchronizingMs", milliseconds(frame.beforeSync)},
                                       {"afterSynchronizingMs", milliseconds(frame.afterSync)},
                                       {"beforeRenderingMs", milliseconds(frame.beforeRender)},
                                       {"afterRenderingMs", milliseconds(frame.afterRender)},
                                       {"frameSwappedMs", milliseconds(frame.swapped)},
                                       {"synchronizeMs", duration(frame.beforeSync, frame.afterSync)},
                                       {"renderCallbackSpanMs", duration(frame.beforeRender, frame.afterRender)},
                                       {"synchronizeToSwapMs", duration(frame.beforeSync, frame.swapped)},
                                       {"afterRenderToSwapMs", duration(frame.afterRender, frame.swapped)}});
        }
        QJsonArray targets;
        for (const auto &target : d->targets) {
            targets.append(QJsonObject{{"targetObservationId", double(target.id)},
                                        {"objectName", target.objectName}, {"className", target.className},
                                        {"path", target.path}, {"aliases", QJsonArray::fromStringList(target.aliases)},
                                        {"alive", bool(target.item)}, {"requested", target.requested},
                                        {"observedFrames", double(target.observedFrames)},
                                        {"providerIdentityTransitions", double(target.providerTransitions)},
                                        {"textureIdentityTransitions", double(target.textureTransitions)},
                                        {"nativeTextureIdentityTransitions", double(target.nativeTransitions)},
                                        {"latestObservation", Impl::textureJson(target.latest)}});
        }
        QJsonArray providers;
        for (const auto &provider : d->providers)
            providers.append(QJsonObject{{"providerObservationId", double(provider.id)},
                                          {"address", provider.address},
                                          {"textureChangedNotifications", double(provider.notifications)},
                                          {"destroyed", provider.destroyed}});
        QJsonArray textures;
        for (const auto &texture : d->textures)
            textures.append(QJsonObject{{"textureObservationId", double(texture.id)},
                                         {"address", texture.address}, {"alive", bool(texture.pointer)}});
        QJsonArray events;
        for (const auto &event : d->textureEvents) {
            auto object = Impl::textureJson(event.state);
            object["sequence"] = double(event.frame);
            object["phase"] = event.phase;
            object["observedMs"] = double(event.observedNs) / 1e6;
            object["targetObservationId"] = double(event.target);
            events.append(object);
        }
        QJsonArray gpuSamples;
        for (const auto &sample : d->gpuSamples)
            gpuSamples.append(QJsonObject{{"sequence", double(sample.frame)}, {"phase", sample.phase},
                                           {"durationNs", QString::number(sample.durationNs)},
                                           {"durationMs", double(sample.durationNs) / 1e6},
                                           {"resultAvailableMs", double(sample.availableNs) / 1e6}});
        quint64 pending = 0;
        for (const auto &query : d->queries)
            pending += query.pending;
        report = {{"schema", "reverie.qt.perf-diagnostics.v1"}, {"attached", d->attached},
                  {"instrumented", true}, {"diagnostic", d->diagnostic},
                  {"stopping", d->stopping}, {"stopped", d->stopped},
                  {"performanceComparable", !d->diagnostic && !d->timingOnly},
                  {"actualGlContext", d->context}, {"glContextHistory", d->contextHistory},
                  {"droppedContextHistory", double(d->droppedContextHistory)},
                  {"viewport", d->viewport},
                  {"cpuStages", QJsonObject{{"frames", frames}, {"maxRetainedFrames", double(MaxFrames)},
                     {"droppedFrames", double(d->droppedFrames)},
                     {"incompleteFramesWithoutSwap", double(d->incompleteFrames)},
                     {"framesWithoutSynchronizing", double(d->framesWithoutSynchronizing)},
                     {"clock", "std::chrono::steady_clock; milliseconds since diagnostics construction"},
                     {"scope", "Direct Qt render callback spans, including instrumentation; frameSwapped is queued presentation, not physical display timing"}}},
                  {"textures", QJsonObject{{"enabled", d->diagnostic}, {"targets", targets}, {"providers", providers},
                     {"textureObjects", textures}, {"events", events},
                     {"maxRetainedEvents", double(MaxTextureEvents)},
                     {"droppedEvents", double(d->droppedTextureEvents)},
                     {"droppedIdentityObjects", double(d->droppedIdentityObjects)},
                     {"droppedTargets", double(d->droppedTargets)},
                     {"samplingStage", "afterSynchronizing on the rendering thread while the GUI thread is blocked"},
                     {"scope", "Public QQuickItem/QSGTextureProvider/QSGTexture observations; aliases share observation IDs. Notifications are not redraw counts. Identity transitions are not allocation counts. Native IDs can be reused. No texture format, VRAM bytes, FBO allocations, or per-pass GPU timing is inferred."}}},
                  {"gpuTimer", QJsonObject{{"status", d->gpuStatus}, {"reason", d->gpuReason},
                     {"queryRingSize", double(QueryRingSize)}, {"queriesIssued", double(d->queryIssued)},
                     {"ringBusySkips", double(d->queryRingBusy)},
                     {"existingElapsedQuerySkips", double(d->existingQuerySkips)},
                     {"pendingResults", double(pending)}, {"lostResultsOnInvalidation", double(d->lostQueryResults)},
                     {"activeQuery", d->activeQuery >= 0},
                     {"droppedSamples", double(d->droppedGpuSamples)},
                     {"implementation", "Public OpenGL query IDs; no QOpenGLTimerQuery lifetime or context switching"},
                     {"queriesDeletedWithCurrentContext", double(d->queriesRetiredWithCurrentContext)},
                     {"queriesRetiredByContextDestruction", double(d->queriesRetiredByContextDestruction)},
                     {"samples", gpuSamples},
                     {"scope", "One nonnested elapsed query around beforeRendering to afterRendering; aggregate Qt scene-graph command interval, not per-pass attribution"},
                     {"retrieval", "Only GL_QUERY_RESULT_AVAILABLE results are read; pending results are reported without blocking, forced flush, or glFinish"}}}};
    }
    auto &capture = logCapture();
    {
        QMutexLocker lock(&capture.mutex);
        QJsonArray logs;
        QJsonArray renderLoopEvidence;
        QString observedLoop;
        for (const auto &message : capture.messages) {
            auto object = QJsonObject{{"category", message.category}, {"message", message.message}};
            logs.append(object);
            const auto lower = message.message.toLower();
            if (lower.contains("render loop") || message.category.contains("renderloop")) {
                renderLoopEvidence.append(object);
                if (lower.contains("threaded render loop"))
                    observedLoop = "threaded";
                else if (lower.contains("basic render loop"))
                    observedLoop = "basic";
                else if (lower.contains("windows render loop"))
                    observedLoop = "windows";
            }
        }
        report["sceneGraphLogs"] = QJsonObject{{"captureInstalled", capture.installed},
                                                {"messages", logs}, {"droppedMessages", double(capture.dropped)}};
        report["renderLoop"] = QJsonObject{{"observed", observedLoop.isEmpty() ? "not_reported" : observedLoop},
                                           {"evidence", renderLoopEvidence},
                                           {"requestedEnvironment", QString::fromUtf8(qgetenv("QSG_RENDER_LOOP"))},
                                           {"scope", "Actual loop label is copied only from Qt log text; environment requests and thread identity are not proof"}};
    }
    if (d->timingOnly) {
        report["timingOnly"] = true;
        report["clockAbsoluteOriginNs"] = QString::number(d->startedNs);
        report["clockOrigin"] = "absolute-steady-clock";
    }
    return report;
}
