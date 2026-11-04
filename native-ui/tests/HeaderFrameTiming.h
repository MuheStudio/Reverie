#pragma once

#include "HeaderFrameGpuLoad.h"
#include <QMetaObject>
#include <QMutex>
#include <QMutexLocker>
#include <QObject>
#include <QOpenGLContext>
#include <QPointer>
#include <QQuickWindow>
#include <QVariantList>
#include <QVariantMap>
#include <rhi/qrhi.h>
#include <algorithm>
#include <array>
#include <cmath>
#include <cstring>
#include <functional>
#include <limits>
#include <memory>
#include <utility>
#include <vector>

namespace HeaderFrameTiming {
inline constexpr size_t FrameCapacity = 60000;
inline constexpr size_t QueryRingSize = 8;
inline constexpr size_t CallCapacity = 200000;
struct Options { bool localCollection = false; bool positiveControl = false; };

namespace Detail {
inline constexpr GLuint AvailableSentinel = std::numeric_limits<GLuint>::max();
inline constexpr GLuint64 DurationSentinel = std::numeric_limits<GLuint64>::max();
inline int loadIndex(int draws) {
    switch (draws) { case 0: return 0; case 64: return 1; case 128: return 2; case 256: return 3; default: return -1; }
}
struct Frame {
    quint64 frameId = 0, startContextGeneration = 0, endContextGeneration = 0;
    qint64 frameBeginNs = -1, beforeRenderNs = -1, afterRenderNs = -1, swappedNs = -1, frameEndNs = -1;
    qint64 queryIssuedNs = -1, resultAvailableNs = -1;
    GLuint queryObject = 0, availableValue = AvailableSentinel;
    GLuint64 durationRawValue = DurationSentinel;
    int loadDraws = 0, actualLoadDraws = 0;
    const char *status = "not-issued", *invalidReason = "", *startStage = "", *endStage = "";
    bool preparing = false, loadInitializedAtFrameStart = false;
    bool queryStarted = false, queryEnded = false, sameContext = false;
    bool availableOutputWritten = false, durationOutputWritten = false, durationWithinCounterBits = false;
    bool invalid = false, valid = false;
    bool auxiliaryObserved = false;
    double auxiliarySeconds = 0;
};
struct Query { GLuint object = 0; size_t frameIndex = 0; bool pending = false; };
struct Call {
    quint64 frameId = 0, observedAtFrameId = 0;
    qint64 atNs = -1;
    GLuint queryObject = 0;
    const char *function = "", *phase = "";
    std::array<GLenum, 8> errors{};
    int errorCount = 0;
    bool preexisting = false, errorsOverflow = false;
};
struct Context {
    int major = 0, minor = 0, profile = 0, counterBits = -1;
    bool isOpenGLES = false, coreTimer = false, arbTimer = false, extTimer = false;
    std::array<char, 256> version{}, vendor{}, renderer{};
};
struct Functions {
    using QueryInfo = void (*)(GLenum, GLenum, GLint *);
    using Create = void (*)(GLsizei, GLuint *);
    using Delete = void (*)(GLsizei, const GLuint *);
    using Begin = void (*)(GLenum, GLuint);
    using End = void (*)(GLenum);
    using Available = void (*)(GLuint, GLenum, GLuint *);
    using Duration = void (*)(GLuint, GLenum, GLuint64 *);
    QueryInfo queryInfo = nullptr;
    Create create = nullptr;
    Delete remove = nullptr;
    Begin begin = nullptr;
    End end = nullptr;
    Available available = nullptr;
    Duration duration = nullptr;
    const char *infoName = "", *createName = "", *deleteName = "", *beginName = "", *endName = "";
    const char *availableName = "", *durationName = "";
};
struct State {
    State(std::function<qint64()> clock, Options value, QSize loadSize)
        : nowNs(std::move(clock)), options(value) {
        load.size = loadSize;
        if (options.localCollection) {
            frames = std::make_unique<std::array<Frame, FrameCapacity>>();
            calls = std::make_unique<std::array<Call, CallCapacity>>();
        } else { collecting = false; resolved = true; }
        rhiRequested = options.localCollection && qEnvironmentVariableIntValue("QSG_RHI_PROFILE") != 0;
    }
    mutable QMutex mutex;
    std::function<qint64()> nowNs;
    Options options;
    std::unique_ptr<std::array<Frame, FrameCapacity>> frames;
    std::unique_ptr<std::array<Call, CallCapacity>> calls;
    std::array<Query, QueryRingSize> queries{};
    std::array<QMetaObject::Connection, 8> connections{};
    QPointer<QQuickWindow> window;
    QPointer<QOpenGLContext> owner;
    QOpenGLFunctions *gl = nullptr;
    Functions functions;
    Context context;
    GpuLoad load;
    QString failureReason;
    size_t frameCount = 0, callCount = 0;
    int current = -1, activeQuery = -1, requestedDraws = 0;
    quint64 nextFrame = 0, droppedFrames = 0, glCallOverflow = 0;
    quint64 queryIssued = 0, pendingAtStop = 0, activeAtStop = 0, ringBusy = 0;
    quint64 existingQuery = 0, contextLosses = 0, deletedQueries = 0, abandonedQueries = 0;
    std::array<quint64, 4> validByLoad{}, zeroByLoad{};
    qint64 stoppedNs = -1;
    bool collecting = true, resolved = false, initialized = false, fatal = false, cleanupDeferred = false;
    bool loadWasInitialized = false;
    bool rhiRequested = false, rhiResolved = false, rhiSupported = false;

    Frame *currentFrame() { return current >= 0 ? &(*frames)[size_t(current)] : nullptr; }
    qint64 time() const { return nowNs ? nowNs() : stoppedNs; }
    bool ownsCurrent() const { return owner && QOpenGLContext::currentContext() == owner && owner->isValid(); }
    bool hasObjects() const {
        return load.hasObjects() || std::any_of(queries.begin(), queries.end(), [](const Query &q) { return q.object != 0; });
    }
    void fail(Frame *frame, const char *reason) {
        if (frame) { frame->invalid = true; frame->valid = false; frame->status = "invalid"; frame->invalidReason = reason; }
        if (!fatal) failureReason = QString::fromLatin1(reason);
        fatal = true; resolved = true;
    }
    void disconnectAll() {
        for (auto &connection : connections) { QObject::disconnect(connection); connection = {}; }
    }
    Call errors(Frame *frame, const char *phase, const char *function, GLuint object, bool preexisting) {
        Call result;
        result.frameId = frame ? frame->frameId : 0;
        result.observedAtFrameId = currentFrame() ? currentFrame()->frameId : nextFrame;
        result.atNs = time(); result.queryObject = object;
        result.phase = phase; result.function = function; result.preexisting = preexisting;
        for (size_t i = 0; i < result.errors.size(); ++i) {
            const GLenum error = gl->glGetError();
            if (error == GL_NO_ERROR) return result;
            result.errors[size_t(result.errorCount++)] = error;
        }
        result.errorsOverflow = true;
        return result;
    }
    bool appendCall(Call record, Frame *frame) {
        if (callCount == CallCapacity) { ++glCallOverflow; fail(frame, "GL call record capacity exceeded"); return false; }
        (*calls)[callCount++] = record;
        if (record.errorCount || record.errorsOverflow) {
            fail(frame, record.preexisting ? "Preexisting GL errors before instrumentation" : "GL error after instrumented call");
            return false;
        }
        return true;
    }
    void preexisting(Frame *frame) {
        if (!gl || !ownsCurrent()) return;
        const auto record = errors(frame, "preexisting", "glGetError:before-instrumentation", frame ? frame->queryObject : 0, true);
        if (record.errorCount || record.errorsOverflow) appendCall(record, frame);
    }
    template<class Action> bool checked(Frame *frame, const char *phase, const char *name, Action &&action, GLuint object = 0) {
        action();
        return appendCall(errors(frame, phase, name, object ? object : frame ? frame->queryObject : 0, false), frame);
    }
    void initialize(Frame &frame) {
        frame.preparing = true; frame.status = "initializing";
        auto *contextNow = QOpenGLContext::currentContext();
        if (!contextNow || !contextNow->isValid()) { fail(&frame, "No valid current context at beforeSynchronizing"); return; }
        owner = contextNow; gl = owner->functions();
        preexisting(&frame);
        const auto format = owner->format();
        context.major = format.majorVersion(); context.minor = format.minorVersion(); context.profile = int(format.profile());
        context.isOpenGLES = owner->isOpenGLES();
        context.coreTimer = context.major > 3 || (context.major == 3 && context.minor >= 3);
        context.arbTimer = owner->hasExtension(QByteArrayLiteral("GL_ARB_timer_query"));
        context.extTimer = owner->hasExtension(QByteArrayLiteral("GL_EXT_timer_query"));
        const auto string = [&](GLenum token, std::array<char, 256> &destination) {
            const GLubyte *value = nullptr;
            checked(&frame, "initialization", "glGetString", [&] { value = gl->glGetString(token); });
            if (value) { std::strncpy(destination.data(), reinterpret_cast<const char *>(value), destination.size() - 1); destination.back() = '\0'; }
        };
        string(GL_VERSION, context.version); string(GL_VENDOR, context.vendor); string(GL_RENDERER, context.renderer);
        if (fatal) return;
        if (context.isOpenGLES || !(context.coreTimer || context.arbTimer || context.extTimer)) {
            fail(&frame, "No implemented desktop OpenGL elapsed-query support"); return;
        }
        const auto resolve = [&](const char *core, const char *arb, const char *&selected) {
            auto address = owner->getProcAddress(core); selected = core;
            if (!address && owner->hasExtension(QByteArrayLiteral("GL_ARB_occlusion_query"))) {
                address = owner->getProcAddress(arb); selected = arb;
            }
            return address;
        };
        functions.queryInfo = reinterpret_cast<Functions::QueryInfo>(resolve("glGetQueryiv", "glGetQueryivARB", functions.infoName));
        functions.create = reinterpret_cast<Functions::Create>(resolve("glGenQueries", "glGenQueriesARB", functions.createName));
        functions.remove = reinterpret_cast<Functions::Delete>(resolve("glDeleteQueries", "glDeleteQueriesARB", functions.deleteName));
        functions.begin = reinterpret_cast<Functions::Begin>(resolve("glBeginQuery", "glBeginQueryARB", functions.beginName));
        functions.end = reinterpret_cast<Functions::End>(resolve("glEndQuery", "glEndQueryARB", functions.endName));
        functions.available = reinterpret_cast<Functions::Available>(resolve("glGetQueryObjectuiv", "glGetQueryObjectuivARB", functions.availableName));
        // EXT-only contexts use the EXT entry explicitly, never a core alias.
        functions.durationName = context.coreTimer || context.arbTimer ? "glGetQueryObjectui64v" : "glGetQueryObjectui64vEXT";
        functions.duration = reinterpret_cast<Functions::Duration>(owner->getProcAddress(functions.durationName));
        if (!functions.queryInfo || !functions.create || !functions.remove || !functions.begin || !functions.end ||
            !functions.available || !functions.duration) { fail(&frame, "Required selected GL query entry is unavailable"); return; }
        GLint bits = -1;
        checked(&frame, "initialization", functions.infoName, [&] { functions.queryInfo(GL_TIME_ELAPSED, GL_QUERY_COUNTER_BITS, &bits); });
        context.counterBits = bits;
        if (fatal || bits <= 0 || bits > 64) { fail(&frame, "Elapsed-query counter bits were not validly written"); return; }
        std::array<GLuint, QueryRingSize> ids{};
        checked(&frame, "initialization", functions.createName, [&] { functions.create(GLsizei(ids.size()), ids.data()); });
        for (size_t i = 0; i < queries.size(); ++i) queries[i].object = ids[i];
        if (fatal || std::any_of(ids.begin(), ids.end(), [](GLuint id) { return id == 0; })) {
            fail(&frame, "Query IDs were not successfully created"); return;
        }
        if (options.positiveControl) {
            const auto check = [&](const char *name, auto &&action) { return checked(&frame, "initialization", name, action); };
            if (load.size.isEmpty() || !load.initialize(gl, check)) { fail(&frame, "Positive-control shader/FBO initialization failed"); return; }
            loadWasInitialized = true;
        }
        initialized = true; resolved = true;
    }
    void poll() {
        if (!initialized || fatal || !ownsCurrent()) return;
        for (auto &query : queries) {
            if (!query.pending) continue;
            auto &frame = (*frames)[query.frameIndex];
            GLuint available = AvailableSentinel;
            const bool ok = checked(&frame, "availability", functions.availableName,
                [&] { functions.available(query.object, GL_QUERY_RESULT_AVAILABLE, &available); }, query.object);
            frame.availableValue = available;
            frame.availableOutputWritten = available != AvailableSentinel && (available == 0 || available == 1);
            if (!ok || !frame.availableOutputWritten) { fail(&frame, "Query availability was not successfully written"); return; }
            if (!available) continue;
            GLuint64 duration = DurationSentinel;
            const bool read = checked(&frame, "duration", functions.durationName,
                [&] { functions.duration(query.object, GL_QUERY_RESULT, &duration); }, query.object);
            frame.durationRawValue = duration; frame.durationOutputWritten = duration != DurationSentinel;
            frame.durationWithinCounterBits = context.counterBits == 64 ||
                (context.counterBits > 0 && context.counterBits < 64 && duration < (GLuint64(1) << context.counterBits));
            frame.resultAvailableNs = time(); query.pending = false;
            if (!read || !frame.durationOutputWritten) { fail(&frame, "Query duration was not successfully written"); return; }
            if (!frame.durationWithinCounterBits) { fail(&frame, "Query duration exceeds the advertised counter-bit range"); return; }
            frame.valid = !frame.invalid && frame.queryStarted && frame.queryEnded && frame.sameContext &&
                frame.durationWithinCounterBits && frame.actualLoadDraws == frame.loadDraws && frame.frameEndNs >= frame.frameBeginNs;
            if (!frame.valid) { fail(&frame, "Completed query has invalid scope or load coverage"); return; }
            frame.status = "ready";
            const int index = loadIndex(frame.loadDraws);
            ++validByLoad[size_t(index)]; if (!duration) ++zeroByLoad[size_t(index)];
        }
    }
    void start(Frame &frame, const char *stage) {
        if (fatal || frame.preparing || frame.queryStarted || !initialized) return;
        if (!ownsCurrent()) return; // beforeFrameBegin is not guaranteed current.
        preexisting(&frame); if (fatal) return;
        poll(); if (fatal) return;
        GLint existing = -1;
        checked(&frame, "begin", functions.infoName, [&] { functions.queryInfo(GL_TIME_ELAPSED, GL_CURRENT_QUERY, &existing); });
        if (fatal || existing != 0) { ++existingQuery; fail(&frame, "Elapsed-query target is already active or was not validly read"); return; }
        for (size_t i = 0; i < queries.size(); ++i) {
            auto &query = queries[i]; if (query.pending) continue;
            query.frameIndex = size_t(current); frame.queryObject = query.object;
            frame.startStage = stage; frame.startContextGeneration = 1; frame.queryIssuedNs = time();
            const bool began = checked(&frame, "begin", functions.beginName, [&] { functions.begin(GL_TIME_ELAPSED, query.object); });
            GLint active = -1;
            const bool read = checked(&frame, "begin", functions.infoName, [&] { functions.queryInfo(GL_TIME_ELAPSED, GL_CURRENT_QUERY, &active); });
            if (GLuint(active) == query.object) activeQuery = int(i);
            frame.queryStarted = began && read && GLuint(active) == query.object;
            if (!frame.queryStarted) { fail(&frame, "The selected elapsed query did not become current"); return; }
            ++queryIssued; frame.status = "active"; return;
        }
        ++ringBusy; fail(&frame, "Elapsed-query ring is busy");
    }
    void frameBegin() {
        QMutexLocker lock(&mutex);
        if (!collecting) { retire(); return; }
        if (activeQuery >= 0) { fail(currentFrame(), "A previous frame's elapsed query was not closed"); return; }
        ++nextFrame; current = -1;
        if (frameCount == FrameCapacity) { ++droppedFrames; fail(nullptr, "Frame record capacity exceeded"); return; }
        current = int(frameCount++);
        auto &frame = *currentFrame();
        frame.frameId = nextFrame; frame.frameBeginNs = time(); frame.loadDraws = requestedDraws;
        frame.loadInitializedAtFrameStart = !options.positiveControl || load.initialized;
        if (fatal) { fail(&frame, "Collection already invalid"); return; }
        if (initialized && ownsCurrent()) start(frame, "beforeFrameBegin");
    }
    void beforeSync() {
        QMutexLocker lock(&mutex);
        if (!collecting) { retire(); return; }
        auto *frame = currentFrame(); if (!frame || fatal) return;
        if (!initialized) { initialize(*frame); return; }
        if (!ownsCurrent()) { ++contextLosses; fail(frame, "Owning GL context changed at beforeSynchronizing"); return; }
        if (!frame->queryStarted) start(*frame, "beforeSynchronizing");
    }
    void beforeRender() {
        QMutexLocker lock(&mutex);
        if (!collecting) { retire(); return; }
        auto *frame = currentFrame();
        if (frame) frame->beforeRenderNs = time();
        if (!window) return;
        auto *rhi = window->rhi();
        // Record the independent Qt capability even when native GL setup has
        // failed. No timing read or GL operation is attempted on that path.
        if (rhi && !rhiResolved) { rhiSupported = rhi->isFeatureSupported(QRhi::Timestamps); rhiResolved = true; }
        if (!frame || fatal) return;
        if (initialized && !ownsCurrent()) { ++contextLosses; fail(frame, "Owning GL context changed at beforeRendering"); return; }
        if (!rhi) return;
        if (rhiRequested && rhiSupported && rhi->isRecordingFrame()) {
            if (auto *swapchain = window->swapChain()) if (auto *commandBuffer = swapchain->currentFrameCommandBuffer()) {
                preexisting(frame);
                checked(frame, "auxiliaryRhi", "QRhiCommandBuffer::lastCompletedGpuTime", [&] { frame->auxiliarySeconds = commandBuffer->lastCompletedGpuTime(); });
                frame->auxiliaryObserved = std::isfinite(frame->auxiliarySeconds) && frame->auxiliarySeconds >= 0;
            }
        }
    }
    void afterRender() {
        QMutexLocker lock(&mutex);
        if (!collecting) { retire(); return; }
        auto *frame = currentFrame(); if (!frame) return;
        frame->afterRenderNs = time();
        if (fatal || frame->preparing || !frame->queryStarted || !options.positiveControl || !frame->loadDraws) return;
        if (!ownsCurrent()) { ++contextLosses; fail(frame, "Owning context changed before positive-control work"); return; }
        preexisting(frame); if (fatal) return;
        const bool entered = checked(frame, "load", "QQuickWindow::beginExternalCommands", [&] { window->beginExternalCommands(); });
        const auto check = [&](const char *name, auto &&action) { return checked(frame, "load", name, action); };
        frame->actualLoadDraws = entered ? load.draw(gl, check, frame->loadDraws) : -1;
        checked(frame, "load", "QQuickWindow::endExternalCommands", [&] { window->endExternalCommands(); });
        if (frame->actualLoadDraws != frame->loadDraws) fail(frame, "Positive-control draw count or GL state restoration failed");
    }
    void swapped() {
        QMutexLocker lock(&mutex);
        if (collecting && currentFrame()) currentFrame()->swappedNs = time();
    }
    void frameEnd() {
        QMutexLocker lock(&mutex);
        if (!collecting) { retire(); return; }
        auto *frame = currentFrame(); if (!frame) return;
        frame->frameEndNs = time(); if (activeQuery < 0) return;
        auto &query = queries[size_t(activeQuery)]; auto &origin = (*frames)[query.frameIndex];
        origin.endStage = "afterFrameEnd"; origin.sameContext = ownsCurrent();
        origin.endContextGeneration = origin.sameContext ? 1 : 0;
        if (!origin.sameContext) { ++contextLosses; fail(&origin, "Owning GL context is not current at afterFrameEnd"); return; }
        preexisting(&origin);
        GLint currentQuery = -1;
        const bool known = checked(&origin, "end", functions.infoName, [&] { functions.queryInfo(GL_TIME_ELAPSED, GL_CURRENT_QUERY, &currentQuery); });
        if (!known || GLuint(currentQuery) != query.object) { fail(&origin, "Elapsed query changed before afterFrameEnd"); return; }
        const bool ended = checked(&origin, "end", functions.endName, [&] { functions.end(GL_TIME_ELAPSED); });
        origin.queryEnded = ended; if (!ended) return;
        activeQuery = -1; query.pending = true; if (!origin.invalid) origin.status = "pending";
    }
    void retire() {
        if (!hasObjects()) { cleanupDeferred = false; if (!collecting) disconnectAll(); return; }
        if (!ownsCurrent()) {
            if (!owner) { abandon(); cleanupDeferred = false; if (!collecting) disconnectAll(); }
            else cleanupDeferred = true;
            return;
        }
        if (activeQuery >= 0 && functions.queryInfo && functions.end) {
            auto &query = queries[size_t(activeQuery)]; GLint active = -1;
            checked(nullptr, "cleanup", functions.infoName, [&] { functions.queryInfo(GL_TIME_ELAPSED, GL_CURRENT_QUERY, &active); }, query.object);
            if (GLuint(active) == query.object) checked(nullptr, "cleanup", functions.endName, [&] { functions.end(GL_TIME_ELAPSED); }, query.object);
            activeQuery = -1;
        }
        if (functions.remove) for (auto &query : queries) {
            if (query.object) { checked(nullptr, "cleanup", functions.deleteName, [&] { functions.remove(1, &query.object); }, query.object); ++deletedQueries; }
            query = {};
        }
        const auto check = [&](const char *name, auto &&action) { return checked(nullptr, "cleanup", name, action); };
        load.release(gl, check); cleanupDeferred = false; if (!collecting) disconnectAll();
    }
    void abandon() {
        for (auto &query : queries) { if (query.object) ++abandonedQueries; query = {}; }
        activeQuery = -1; load.abandon();
    }
    void invalidated() {
        QMutexLocker lock(&mutex);
        if (collecting) { ++contextLosses; fail(currentFrame(), "Scene-graph GL context was invalidated"); }
        retire();
    }
    void destroyed() {
        QMutexLocker lock(&mutex);
        if (collecting) fail(currentFrame(), "Observed window was destroyed");
        collecting = false; nowNs = {}; abandon(); disconnectAll(); window = nullptr;
    }
    void stop() {
        QMutexLocker lock(&mutex); if (!collecting) return;
        stoppedNs = time(); collecting = false;
        for (auto &query : queries) if (query.pending) {
            ++pendingAtStop; auto &frame = (*frames)[query.frameIndex]; if (!frame.invalid) frame.status = "pending-at-stop";
        }
        if (activeQuery >= 0) {
            ++activeAtStop; auto &frame = (*frames)[queries[size_t(activeQuery)].frameIndex];
            frame.invalid = true; frame.status = "invalid"; frame.invalidReason = "Stopped before query end";
        }
        nowNs = {}; retire();
    }
};
inline QVariant timeValue(qint64 value) { return value >= 0 ? QVariant::fromValue(value) : QVariant(); }
}

class Observer final {
public:
    Observer(QQuickWindow *window, std::function<qint64()> nowNs, Options options = {})
        : m_state(std::make_shared<Detail::State>(std::move(nowNs), options,
              window ? QSize(qRound(window->width() * window->effectiveDevicePixelRatio()),
                             qRound(window->height() * window->effectiveDevicePixelRatio())) : QSize())) {
        const auto state = m_state;
        if (!options.localCollection) { state->nowNs = {}; return; }
        if (!window || !state->nowNs) { state->fail(nullptr, "Window and caller clock are required"); state->collecting = false; state->nowNs = {}; return; }
        state->window = window;
        state->connections[0] = QObject::connect(window, &QQuickWindow::beforeFrameBegin, window,
            [state] { const auto keep = state; keep->frameBegin(); }, Qt::DirectConnection);
        state->connections[1] = QObject::connect(window, &QQuickWindow::beforeSynchronizing, window,
            [state] { const auto keep = state; keep->beforeSync(); }, Qt::DirectConnection);
        state->connections[2] = QObject::connect(window, &QQuickWindow::beforeRendering, window,
            [state] { const auto keep = state; keep->beforeRender(); }, Qt::DirectConnection);
        state->connections[3] = QObject::connect(window, &QQuickWindow::afterRendering, window,
            [state] { const auto keep = state; keep->afterRender(); }, Qt::DirectConnection);
        state->connections[4] = QObject::connect(window, &QQuickWindow::frameSwapped, window,
            [state] { const auto keep = state; keep->swapped(); }, Qt::DirectConnection);
        state->connections[5] = QObject::connect(window, &QQuickWindow::afterFrameEnd, window,
            [state] { const auto keep = state; keep->frameEnd(); }, Qt::DirectConnection);
        state->connections[6] = QObject::connect(window, &QQuickWindow::sceneGraphInvalidated, window,
            [state] { const auto keep = state; keep->invalidated(); }, Qt::DirectConnection);
        state->connections[7] = QObject::connect(window, &QObject::destroyed, window,
            [state] { const auto keep = state; keep->destroyed(); }, Qt::DirectConnection);
        if (std::any_of(state->connections.begin(), state->connections.end(), [](const auto &connection) { return !connection; })) {
            state->fail(nullptr, "Required window callback could not be installed"); state->collecting = false; state->nowNs = {}; state->disconnectAll();
        }
    }
    ~Observer() { stop(); }
    Observer(const Observer &) = delete;
    Observer &operator=(const Observer &) = delete;
    void stop() { m_state->stop(); }
    bool capabilityResolved() const { QMutexLocker lock(&m_state->mutex); return m_state->resolved; }
    bool queriesAvailable() const { QMutexLocker lock(&m_state->mutex); return m_state->options.localCollection && m_state->initialized && !m_state->fatal; }
    QString unavailableReason() const {
        QMutexLocker lock(&m_state->mutex);
        if (!m_state->options.localCollection) return QStringLiteral("Not collected: no positive-control-validated method has been enabled for ordinary checks");
        if (m_state->fatal) return m_state->failureReason;
        return m_state->resolved ? QString() : QStringLiteral("Waiting for initialization with the owning current GL context");
    }
    bool setLoadDraws(int draws) {
        QMutexLocker lock(&m_state->mutex);
        if (!m_state->collecting || m_state->fatal || !m_state->options.localCollection ||
            !m_state->options.positiveControl || Detail::loadIndex(draws) < 0) return false;
        m_state->requestedDraws = draws; return true;
    }
    bool loadReady() const {
        QMutexLocker lock(&m_state->mutex);
        return !m_state->fatal && m_state->initialized && (!m_state->options.positiveControl || m_state->load.initialized);
    }
    quint64 validSampleCount(int draws) const {
        QMutexLocker lock(&m_state->mutex); const int index = Detail::loadIndex(draws);
        return index >= 0 ? m_state->validByLoad[size_t(index)] : 0;
    }
    QVariantMap snapshot() const {
        std::vector<Detail::Frame> frames; std::vector<Detail::Call> calls;
        // Allocate/copy numeric storage before serialization outside the lock.
        if (m_state->options.localCollection) { frames.reserve(FrameCapacity); calls.reserve(CallCapacity); }
        Detail::Context context; Detail::Functions functions; Detail::GpuLoad loadDescription;
        Options options; QString failure; QSize loadSize;
        std::array<quint64, 4> valid{}, zeros{};
        quint64 observed, dropped, callOverflow, issued, pending, active, busy, conflict, lost, deleted, abandoned;
        qint64 stopped;
        bool collecting, initialized, resolved, fatal, cleanup, loadInitialized, rhiRequested, rhiResolved, rhiSupported;
        {
            QMutexLocker lock(&m_state->mutex);
            if (m_state->frames) frames.assign(m_state->frames->begin(), m_state->frames->begin() + m_state->frameCount);
            if (m_state->calls) calls.assign(m_state->calls->begin(), m_state->calls->begin() + m_state->callCount);
            context = m_state->context; functions = m_state->functions; options = m_state->options; failure = m_state->failureReason;
            loadSize = m_state->load.size; valid = m_state->validByLoad; zeros = m_state->zeroByLoad;
            loadDescription = m_state->load;
            observed = m_state->nextFrame; dropped = m_state->droppedFrames; callOverflow = m_state->glCallOverflow;
            issued = m_state->queryIssued; pending = m_state->pendingAtStop; active = m_state->activeAtStop;
            busy = m_state->ringBusy; conflict = m_state->existingQuery; lost = m_state->contextLosses;
            deleted = m_state->deletedQueries; abandoned = m_state->abandonedQueries; stopped = m_state->stoppedNs;
            collecting = m_state->collecting; initialized = m_state->initialized; resolved = m_state->resolved; fatal = m_state->fatal;
            cleanup = m_state->cleanupDeferred; loadInitialized = m_state->loadWasInitialized;
            rhiRequested = m_state->rhiRequested; rhiResolved = m_state->rhiResolved; rhiSupported = m_state->rhiSupported;
        }
        QVariantList rows, callRows, auxiliary, loadCounts;
        for (const auto &frame : frames) {
            rows.append(QVariantMap{{"frameId", qulonglong(frame.frameId)}, {"frameBeginNs", Detail::timeValue(frame.frameBeginNs)},
                {"beforeRenderNs", Detail::timeValue(frame.beforeRenderNs)}, {"afterRenderNs", Detail::timeValue(frame.afterRenderNs)},
                {"swappedNs", Detail::timeValue(frame.swappedNs)}, {"frameEndNs", Detail::timeValue(frame.frameEndNs)},
                {"queryIssuedNs", Detail::timeValue(frame.queryIssuedNs)}, {"resultAvailableNs", Detail::timeValue(frame.resultAvailableNs)},
                {"gpuDurationNs", frame.valid ? QVariant::fromValue(qulonglong(frame.durationRawValue)) : QVariant()},
                {"durationRawValue", QString::number(qulonglong(frame.durationRawValue))},
                {"availableValue", qulonglong(frame.availableValue)}, {"availableSentinel", QStringLiteral("4294967295")},
                {"durationSentinel", QStringLiteral("18446744073709551615")},
                {"availableOutputWritten", frame.availableOutputWritten}, {"durationOutputWritten", frame.durationOutputWritten},
                {"durationWithinCounterBits", frame.durationWithinCounterBits},
                {"queryStarted", frame.queryStarted}, {"queryEnded", frame.queryEnded}, {"queryObject", qulonglong(frame.queryObject)},
                {"queryStartStage", frame.startStage}, {"queryEndStage", frame.endStage}, {"sameContext", frame.sameContext},
                {"startContextGeneration", qulonglong(frame.startContextGeneration)}, {"endContextGeneration", qulonglong(frame.endContextGeneration)},
                {"loadDraws", frame.loadDraws}, {"actualLoadDraws", frame.actualLoadDraws},
                {"loadInitializedAtFrameStart", frame.loadInitializedAtFrameStart},
                {"status", frame.status}, {"valid", frame.valid}, {"invalidReason", frame.invalidReason}});
            if (frame.auxiliaryObserved) auxiliary.append(QVariantMap{{"observedAtFrameId", qulonglong(frame.frameId)},
                {"sourceFrameId", QVariant()}, {"seconds", frame.auxiliarySeconds}});
        }
        for (size_t i = 0; i < calls.size(); ++i) {
            const auto &call = calls[i]; QVariantList errors;
            for (int n = 0; n < call.errorCount; ++n) errors.append(qulonglong(call.errors[size_t(n)]));
            callRows.append(QVariantMap{{"callId", qulonglong(i + 1)}, {"frameId", qulonglong(call.frameId)},
                {"observedAtFrameId", qulonglong(call.observedAtFrameId)}, {"queryObject", qulonglong(call.queryObject)},
                {"function", call.function}, {"phase", call.phase}, {"atNs", Detail::timeValue(call.atNs)},
                {"preexisting", call.preexisting}, {"errors", errors}, {"errorsOverflow", call.errorsOverflow}});
        }
        quint64 ready = 0, readyZero = 0; constexpr int levels[] = {0, 64, 128, 256};
        for (size_t i = 0; i < valid.size(); ++i) {
            ready += valid[i]; readyZero += zeros[i];
            loadCounts.append(QVariantMap{{"draws", levels[i]}, {"validSamples", qulonglong(valid[i])}, {"validZeroSamples", qulonglong(zeros[i])}});
        }
        const bool available = options.localCollection && initialized && !fatal;
        return {{"schema", "reverie.qt.header-frame-timing.v2"}, {"collectionState", options.localCollection ? "本地诊断" : "未采集"},
            {"status", !options.localCollection ? "not-collected" : fatal ? "invalid" : initialized ? "available" : "initializing"},
            {"unavailableReason", !options.localCollection ? QStringLiteral("Not collected: ordinary checks have no positive-control-validated method enabled") : failure},
            {"capabilityResolved", resolved}, {"queriesAvailable", available}, {"collecting", collecting},
            {"clock", "Caller-supplied steady-clock nanoseconds; callback observations after collector lock"},
            {"scope", "OpenGL elapsed interval from the recorded owning-context frame-start hook through afterFrameEnd after Qt frame submission. "
                      "The interval can include command-issuance, CPU/presentation pacing and idle gaps; it is not exclusive GPU busy time or physical display latency."},
            {"validation", "This collector does not declare the method validated. Independent host positive control must pass before interpretation or ordinary-build promotion."},
            {"limits", QVariantMap{{"frames", qulonglong(FrameCapacity)}, {"queryRing", qulonglong(QueryRingSize)}, {"glCalls", qulonglong(CallCapacity)}}},
            {"frameCount", qulonglong(frames.size())}, {"framesObserved", qulonglong(observed)}, {"droppedFrames", qulonglong(dropped)},
            {"frames", rows}, {"glCalls", callRows}, {"glCallOverflow", qulonglong(callOverflow)},
            {"functions", QVariantMap{{"queryInfo", functions.infoName}, {"queryCreate", functions.createName}, {"queryDelete", functions.deleteName},
                {"queryBegin", functions.beginName}, {"queryEnd", functions.endName}, {"queryAvailable", functions.availableName}, {"queryDuration", functions.durationName}}},
            {"context", QVariantMap{{"observed", context.major > 0}, {"generation", initialized ? 1 : 0},
                {"majorVersion", context.major}, {"minorVersion", context.minor}, {"profile", context.profile}, {"isOpenGLES", context.isOpenGLES},
                {"coreTimerQuery", context.coreTimer}, {"arbTimerQuery", context.arbTimer}, {"extTimerQuery", context.extTimer}, {"counterBits", context.counterBits},
                {"versionString", QString::fromLatin1(context.version.data())}, {"vendor", QString::fromLatin1(context.vendor.data())}, {"renderer", QString::fromLatin1(context.renderer.data())}}},
            {"queryCounts", QVariantMap{{"issued", qulonglong(issued)}, {"readyResults", qulonglong(ready)}, {"readyZeroResults", qulonglong(readyZero)},
                {"missingGpuResults", qulonglong(frames.size() - ready)}, {"pendingAtStop", qulonglong(pending)}, {"activeAtStop", qulonglong(active)},
                {"ringBusy", qulonglong(busy)}, {"existingActiveQuery", qulonglong(conflict)}, {"contextLosses", qulonglong(lost)},
                {"deletedWithCurrentContext", qulonglong(deleted)}, {"abandonedToOwningContext", qulonglong(abandoned)}}},
            {"load", QVariantMap{{"enabled", options.positiveControl}, {"initialized", loadInitialized},
                {"targetWidth", loadSize.width()}, {"targetHeight", loadSize.height()}, {"fragmentIterations", Detail::GpuLoad::FragmentIterations},
                {"allowedDraws", QVariantList{0, 64, 128, 256}}, {"counts", loadCounts},
                {"initialization", loadDescription.diagnostics()},
                {"scope", "Own offscreen RGBA FBO, full-size triangle, dependent 64-iteration GLSL 1.20 arithmetic and destination-dependent blending; resources prepared outside sampled queries. Load 0 issues no load draw."}}},
            {"auxiliaryRhi", QVariantMap{{"requested", rhiRequested}, {"capabilityResolved", rhiResolved}, {"featureSupported", rhiSupported},
                {"samples", auxiliary}, {"scope", "lastCompletedGpuTime is an asynchronous last-known value with no public source-frame ID; never paired with a particular swap interval."}}},
            {"stoppedNs", Detail::timeValue(stopped)}, {"cleanupDeferredUntilNaturalCallbackOrContextDestruction", cleanup},
            {"retrieval", "Availability and duration have distinct sentinels; every explicit instrumented GL operation is followed by bounded error draining. Preexisting errors are separate. glGetError itself is the recorder, not recursively instrumented. No blocking result read, forced flush, glFinish, context switching or extra update."}};
    }
private:
    std::shared_ptr<Detail::State> m_state;
};
}
