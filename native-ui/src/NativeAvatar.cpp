#include "NativeAvatar.h"
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QImage>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QOpenGLContext>
#include <QOpenGLFramebufferObject>
#include <QOpenGLFunctions>
#include <QPointer>
#include <QQuickOpenGLUtils>
#include <QQuickWindow>
#include <cmath>
#include <cstdlib>
#include <cstring>
#include <limits>
#include <memory>
#include <stdexcept>

namespace A = ReverieAvatar;
static QPointF qtPoint(A::Point p) { return {p.x, p.y}; }
static QVariantMap pointMap(A::Point p) { return {{"x", p.x}, {"y", p.y}}; }
static QVariantMap boundsMap(A::Bounds b) {
    return {{"left", b.left}, {"bottom", b.bottom}, {"right", b.right}, {"top", b.top}};
}

#ifdef REVERIE_LOCAL_CUBISM
#include <CubismFramework.hpp>
#include <ICubismAllocator.hpp>
#include <Id/CubismIdManager.hpp>
#include <Math/CubismMatrix44.hpp>
#include <Model/CubismModel.hpp>
#include <Model/CubismUserModel.hpp>
#include <Motion/CubismExpressionMotionManager.hpp>
#include <Motion/CubismMotionManager.hpp>
#include <Physics/CubismPhysics.hpp>
#include <Rendering/OpenGL/CubismRenderer_OpenGLES2.hpp>
namespace C = Live2D::Cubism::Framework;
class Allocator final : public C::ICubismAllocator {
  public:
    void *Allocate(C::csmSizeType n) override { return malloc(n); }
    void Deallocate(void *p) override { free(p); }
    void *AllocateAligned(C::csmSizeType n, C::csmUint32 alignment) override {
        void *p = nullptr;
        return posix_memalign(&p, alignment, n) == 0 ? p : nullptr;
    }
    void DeallocateAligned(void *p) override { free(p); }
};
static Allocator allocator;
static C::csmByte *shaderFile(const std::string path, C::csmSizeInt *size) {
    QFile f(QString(REVERIE_CUBISM_SHADERS) + "/" +
            QFileInfo(QString::fromStdString(path)).fileName());
    if (!f.open(QIODevice::ReadOnly)) {
        *size = 0;
        return nullptr;
    }
    const auto bytes = f.readAll();
    *size = bytes.size();
    auto *output = new C::csmByte[bytes.size()];
    memcpy(output, bytes.data(), bytes.size());
    return output;
}
static void releaseFile(C::csmByte *p) { delete[] p; }
static QByteArray asset(const QString &root, const QString &relative) {
    QFileInfo info(root + "/" + relative);
    if (relative.isEmpty() || info.isSymLink() || !info.isFile() ||
        !info.canonicalFilePath().startsWith(QFileInfo(root).canonicalFilePath() + "/"))
        throw std::runtime_error("MODEL_REFERENCE_REJECTED");
    QFile f(info.absoluteFilePath());
    if (!f.open(QIODevice::ReadOnly) || f.size() > 300 * 1024 * 1024)
        throw std::runtime_error("MODEL_ASSET_INVALID");
    return f.readAll();
}

class AvatarModel final : public C::CubismUserModel {
  public:
    QJsonObject references;
    QJsonArray hitAreas;
    QString root;
    QVector<GLuint> textures;
    A::Transform layout;
    float idleSeconds = 0, userAnimationSeconds = 0;
    int probeDrawable = -1;
    int hitProbeDrawable = -1;
    std::array<int, 3> hitProbeIndices{};
    QString hitProbeArea;

    ~AvatarModel() {
        if (!textures.isEmpty())
            glDeleteTextures(textures.size(), textures.data());
    }
    void load(const QString &entry) {
        root = QFileInfo(entry).absolutePath();
        const auto json =
            QJsonDocument::fromJson(asset(root, QFileInfo(entry).fileName())).object();
        references = json["FileReferences"].toObject();
        hitAreas = json["HitAreas"].toArray();
        const auto moc = asset(root, references["Moc"].toString());
        LoadModel(reinterpret_cast<const C::csmByte *>(moc.constData()), moc.size(), true);
        if (!GetModel())
            throw std::runtime_error("NATIVE_MOC_REJECTED");
        const auto physics = references["Physics"].toString();
        if (!physics.isEmpty()) {
            const auto bytes = asset(root, physics);
            LoadPhysics(reinterpret_cast<const C::csmByte *>(bytes.constData()), bytes.size());
        }
        CreateRenderer();
        auto *renderer = GetRenderer<C::Rendering::CubismRenderer_OpenGLES2>();
        renderer->IsPremultipliedAlpha(true);
        int slot = 0;
        for (const auto value : references["Textures"].toArray()) {
            const auto bytes = asset(root, value.toString());
            const auto image =
                QImage::fromData(bytes).convertToFormat(QImage::Format_RGBA8888_Premultiplied);
            if (image.isNull() || image.width() > 8192 || image.height() > 8192)
                throw std::runtime_error("NATIVE_TEXTURE_REJECTED");
            GLuint texture;
            glGenTextures(1, &texture);
            glBindTexture(GL_TEXTURE_2D, texture);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_LINEAR);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_S, GL_CLAMP_TO_EDGE);
            glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_WRAP_T, GL_CLAMP_TO_EDGE);
            glPixelStorei(GL_UNPACK_ALIGNMENT, 4);
            glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, image.width(), image.height(), 0, GL_RGBA,
                         GL_UNSIGNED_BYTE, image.constBits());
            textures.push_back(texture);
            renderer->BindTexture(slot++, texture);
        }
        GetModel()->SaveParameters();
        GetModel()->Update();
        captureBaseline();
        initializeInteractionProbe();
    }
    void captureBaseline() {
        const double infinity = std::numeric_limits<double>::infinity();
        A::Bounds bounds{infinity, infinity, -infinity, -infinity};
        for (int d = 0; d < GetModel()->GetDrawableCount(); ++d) {
            if (GetModel()->GetDrawableOpacity(d) <= .001f)
                continue;
            const auto *vertices = GetModel()->GetDrawableVertices(d);
            const int count = GetModel()->GetDrawableVertexCount(d);
            if (probeDrawable < 0 && count > 0)
                probeDrawable = d;
            for (int i = 0; i < count; ++i) {
                bounds.left = std::min(bounds.left, double(vertices[i * 2]));
                bounds.right = std::max(bounds.right, double(vertices[i * 2]));
                bounds.bottom = std::min(bounds.bottom, double(vertices[i * 2 + 1]));
                bounds.top = std::max(bounds.top, double(vertices[i * 2 + 1]));
            }
        }
        if (!layout.captureBaseline(bounds))
            throw std::runtime_error("MODEL_HAS_NO_VISIBLE_GEOMETRY");
    }
    QStringList motionNames() const {
        QStringList names;
        const auto groups = references["Motions"].toObject();
        for (auto it = groups.begin(); it != groups.end(); ++it)
            if (!it.value().toArray().isEmpty())
                names.append(it.key());
        return names;
    }
    QStringList expressionNames() const {
        QStringList names;
        for (const auto value : references["Expressions"].toArray()) {
            const auto name = value.toObject()["Name"].toString();
            if (!name.isEmpty())
                names.append(name);
        }
        return names;
    }
    bool motionActive() const { return _motionManager && !_motionManager->IsFinished(); }
    bool expressionActive() const {
        return _expressionManager && !_expressionManager->IsFinished();
    }
    int parameterIndex(const char *name) {
        const auto id = C::CubismFramework::GetIdManager()->GetId(name);
        // GetParameterIndex synthesizes nonexistent parameters, so only use
        // actual model IDs for optional idle decoration.
        for (int i = 0; i < GetModel()->GetParameterCount(); ++i)
            if (GetModel()->GetParameterId(i) == id)
                return i;
        return -1;
    }
    void tick(float dt, bool reducedMotion) {
        GetModel()->LoadParameters();
        const bool userMotion = motionActive(), userExpression = expressionActive();
        if (userMotion || userExpression)
            userAnimationSeconds += dt;
        if (userMotion)
            _motionManager->UpdateMotion(GetModel(), dt);
        GetModel()->SaveParameters();
        if (!reducedMotion && !userMotion) {
            idleSeconds += dt;
            const auto set = [this](const char *name, float value) {
                const int index = parameterIndex(name);
                if (index >= 0)
                    GetModel()->SetParameterValue(index, value);
            };
            set("ParamAngleX", std::sin(idleSeconds * .36f) * 3);
            set("ParamBreath", (std::sin(idleSeconds * 1.2f) + 1) * .35f);
            const float blink = std::fmod(idleSeconds, 5.f);
            const float eye = blink < .14f ? std::abs(blink - .07f) / .07f : 1.f;
            set("ParamEyeLOpen", eye);
            set("ParamEyeROpen", eye);
        }
        if (_expressionManager)
            _expressionManager->UpdateMotion(GetModel(), dt);
        if (_physics && (!reducedMotion || userMotion || userExpression))
            _physics->Evaluate(GetModel(), dt);
        GetModel()->Update();
    }
    bool startMotion(const QString &name, QString &reason) {
        const auto values = references["Motions"].toObject()[name].toArray();
        if (values.isEmpty()) {
            reason = "MOTION_NOT_AVAILABLE";
            return false;
        }
        const auto entry = values.first().toObject();
        const auto bytes = asset(root, entry["File"].toString());
        auto *motion = LoadMotion(reinterpret_cast<const C::csmByte *>(bytes.constData()),
                                  bytes.size(), name.toUtf8().constData());
        if (!motion) {
            reason = "MOTION_LOAD_REJECTED";
            return false;
        }
        if (entry["FadeInTime"].isDouble())
            motion->SetFadeInTime(entry["FadeInTime"].toDouble());
        if (entry["FadeOutTime"].isDouble())
            motion->SetFadeOutTime(entry["FadeOutTime"].toDouble());
        _motionManager->StartMotionPriority(motion, true, 3);
        reason = "MOTION_STARTED";
        return true;
    }
    bool startExpression(const QString &name, QString &reason) {
        for (const auto value : references["Expressions"].toArray()) {
            const auto entry = value.toObject();
            if (entry["Name"].toString() != name)
                continue;
            const auto bytes = asset(root, entry["File"].toString());
            auto *expression =
                LoadExpression(reinterpret_cast<const C::csmByte *>(bytes.constData()),
                               bytes.size(), name.toUtf8().constData());
            if (!expression) {
                reason = "EXPRESSION_LOAD_REJECTED";
                return false;
            }
            _expressionManager->StartMotion(expression, true);
            reason = "EXPRESSION_STARTED";
            return true;
        }
        reason = "EXPRESSION_NOT_AVAILABLE";
        return false;
    }
    bool meshContains(int drawable, A::Point point) const {
        if (drawable < 0 || GetModel()->GetDrawableOpacity(drawable) <= .001f)
            return false;
        const auto *vertices = GetModel()->GetDrawableVertices(drawable);
        const auto *indices = GetModel()->GetDrawableVertexIndices(drawable);
        const int count = GetModel()->GetDrawableVertexIndexCount(drawable);
        const int vertexCount = GetModel()->GetDrawableVertexCount(drawable);
        const auto vertex = [vertices](int index) {
            return A::Point{vertices[index * 2], vertices[index * 2 + 1]};
        };
        for (int i = 0; i + 2 < count; i += 3) {
            if (indices[i] >= vertexCount || indices[i + 1] >= vertexCount ||
                indices[i + 2] >= vertexCount)
                continue;
            if (A::triangleContains(point, vertex(indices[i]), vertex(indices[i + 1]),
                                    vertex(indices[i + 2])))
                return true;
        }
        return false;
    }
    void initializeInteractionProbe() {
        const auto choose = [this](int drawable, const QString &name) {
            if (drawable < 0 || GetModel()->GetDrawableOpacity(drawable) <= .001f)
                return false;
            const auto *vertices = GetModel()->GetDrawableVertices(drawable);
            const auto *indices = GetModel()->GetDrawableVertexIndices(drawable);
            const int count = GetModel()->GetDrawableVertexIndexCount(drawable);
            const int vertexCount = GetModel()->GetDrawableVertexCount(drawable);
            for (int i = 0; i + 2 < count; i += 3) {
                if (indices[i] >= vertexCount || indices[i + 1] >= vertexCount ||
                    indices[i + 2] >= vertexCount)
                    continue;
                const A::Point a{vertices[indices[i] * 2], vertices[indices[i] * 2 + 1]};
                const A::Point b{vertices[indices[i + 1] * 2], vertices[indices[i + 1] * 2 + 1]};
                const A::Point c{vertices[indices[i + 2] * 2], vertices[indices[i + 2] * 2 + 1]};
                if (!A::triangleContains({(a.x + b.x + c.x) / 3, (a.y + b.y + c.y) / 3}, a, b, c))
                    continue;
                hitProbeDrawable = drawable;
                hitProbeIndices = {indices[i], indices[i + 1], indices[i + 2]};
                hitProbeArea = name;
                return true;
            }
            return false;
        };
        for (const auto value : hitAreas) {
            const auto area = value.toObject();
            const auto id = C::CubismFramework::GetIdManager()->GetId(
                area["Id"].toString().toUtf8().constData());
            if (choose(GetModel()->GetDrawableIndex(id), area["Name"].toString()))
                return;
        }
        if (hitAreas.isEmpty())
            for (int d = 0; d < GetModel()->GetDrawableCount(); ++d)
                if (choose(d, "ModelSurface"))
                    return;
    }
    QString hitArea(A::Point point) {
        for (const auto value : hitAreas) {
            const auto area = value.toObject();
            const auto id = C::CubismFramework::GetIdManager()->GetId(
                area["Id"].toString().toUtf8().constData());
            const int drawable = GetModel()->GetDrawableIndex(id);
            if (meshContains(drawable, point))
                return area["Name"].toString();
        }
        // Models without authored regions can still receive an explicit tap
        // on visible model geometry; no synthetic mouth or region is implied.
        if (hitAreas.isEmpty())
            for (int d = GetModel()->GetDrawableCount() - 1; d >= 0; --d)
                if (meshContains(d, point))
                    return "ModelSurface";
        return {};
    }
    bool interact(const QString &area, QString &kind, QString &name, QString &reason) {
        const auto motions = motionNames(), expressions = expressionNames();
        // Prefer a declared matching tap motion, then a supported capability.
        const QString matching = "Tap" + area;
        if (!area.isEmpty() && motions.contains(matching))
            name = matching;
        else if (!expressions.isEmpty() && area.compare("Head", Qt::CaseInsensitive) == 0) {
            kind = "expression";
            name = expressions.first();
            return startExpression(name, reason);
        } else {
            for (const auto &candidate : motions)
                if (candidate.compare("Idle", Qt::CaseInsensitive) != 0) {
                    name = candidate;
                    break;
                }
            if (name.isEmpty() && !motions.isEmpty())
                name = motions.first();
        }
        if (!name.isEmpty()) {
            kind = "motion";
            return startMotion(name, reason);
        }
        if (!expressions.isEmpty()) {
            kind = "expression";
            name = expressions.first();
            return startExpression(name, reason);
        }
        reason = "NO_SUPPORTED_INTERACTION";
        return false;
    }
    QVariantMap animationState() const {
        QVariantMap state{{"motionActive", motionActive()},
                          {"expressionActive", expressionActive()},
                          {"idleSeconds", idleSeconds},
                          {"userAnimationSeconds", userAnimationSeconds},
                          {"hitTestMode", hitAreas.isEmpty() ? "visibleDrawableMeshes"
                                                             : "declaredDrawableMeshes"}};
        if (probeDrawable >= 0) {
            const auto *vertices = GetModel()->GetDrawableVertices(probeDrawable);
            state["geometryProbeModel"] = pointMap({vertices[0], vertices[1]});
        }
        if (hitProbeDrawable >= 0 && GetModel()->GetDrawableOpacity(hitProbeDrawable) > .001f) {
            const auto *vertices = GetModel()->GetDrawableVertices(hitProbeDrawable);
            A::Point point;
            for (const int index : hitProbeIndices) {
                point.x += vertices[index * 2] / 3.;
                point.y += vertices[index * 2 + 1] / 3.;
            }
            state["interactionProbeModel"] = pointMap(point);
            state["interactionProbeArea"] = hitProbeArea;
        }
        return state;
    }
    void draw() {
        if (!layout.valid())
            return;
        auto values = layout.matrix();
        C::CubismMatrix44 matrix;
        matrix.SetMatrix(values.data());
        auto *renderer = GetRenderer<C::Rendering::CubismRenderer_OpenGLES2>();
        renderer->SetMvpMatrix(&matrix);
        renderer->DrawModel();
    }
};
#endif

class AvatarRenderer final : public QQuickFramebufferObject::Renderer {
    QPointer<NativeAvatar> owner;
    QString desired, current;
    QList<NativeAvatar::Request> requests;
    bool active = true, reducedMotion = false, firstFrame = false;
    qreal viewScale = 1;
    QPointF viewOffset;
    QSizeF logicalSize;
    QSize retainedRaster;
    int framebufferAllocations = 0;
    quint64 refitToken = 0, appliedRefit = 0;
    int reloadToken = 0, appliedReload = 0;
    QElapsedTimer clock;
    float last = 0;
#ifdef REVERIE_LOCAL_CUBISM
    std::unique_ptr<AvatarModel> model;
#endif
    void notify(bool ok, const QString &reason, bool loaded = false) {
        auto p = owner;
        if (!p)
            return;
        QMetaObject::invokeMethod(
            p,
            [p, ok, reason, loaded, path = current] {
                if (!p || p->m_path != path)
                    return;
                if (loaded)
                    ++p->m_loads;
                emit p->statisticsChanged();
                emit p->rendered(ok, reason, path);
            },
            Qt::QueuedConnection);
    }
    void interactionResult(const NativeAvatar::Request &request, bool ok, const QString &kind,
                           const QString &name, const QString &reason,
                           const QString &hitArea = {}) {
        auto p = owner;
        if (!p)
            return;
        QMetaObject::invokeMethod(
            p,
            [p, request, ok, kind, name, reason, hitArea] {
                if (!p || p->m_path != request.path)
                    return;
                p->m_lastInteraction = {{"requestId", QVariant::fromValue(request.id)},
                                        {"ok", ok},
                                        {"kind", kind},
                                        {"name", name},
                                        {"reason", reason},
                                        {"hitArea", hitArea}};
                if (ok)
                    ++p->m_successfulInteractions;
                emit p->statisticsChanged();
                emit p->interactionFinished(ok, kind, name, reason);
            },
            Qt::QueuedConnection);
    }

  public:
    AvatarRenderer() { clock.start(); }
    QOpenGLFramebufferObject *createFramebufferObject(const QSize &size) override {
        QOpenGLFramebufferObjectFormat format;
        format.setAttachment(QOpenGLFramebufferObject::CombinedDepthStencil);
        retainedRaster = retainedRaster.expandedTo(size);
        ++framebufferAllocations;
        return new QOpenGLFramebufferObject(retainedRaster, format);
    }
    void synchronize(QQuickFramebufferObject *item) override {
        owner = static_cast<NativeAvatar *>(item);
        desired = owner->m_path;
        active = owner->m_running;
        reducedMotion = owner->m_reducedMotion;
        viewScale = owner->m_viewScale;
        viewOffset = owner->m_viewOffset;
        logicalSize = QSizeF(owner->width(), owner->height());
        const qreal dpr = owner->window() ? owner->window()->effectiveDevicePixelRatio() : 1;
        const QSize required(qCeil(logicalSize.width() * dpr), qCeil(logicalSize.height() * dpr));
        if (required.width() > retainedRaster.width() ||
            required.height() > retainedRaster.height()) {
            retainedRaster = retainedRaster.expandedTo(required);
            if (framebufferObject())
                invalidateFramebufferObject();
        }
        refitToken = owner->m_refitToken;
        reloadToken = owner->m_reloadToken;
        requests.append(owner->m_requests);
        owner->m_requests.clear();
    }
    void render() override {
        auto *functions = QOpenGLContext::currentContext()->functions();
        functions->glViewport(0, 0, framebufferObject()->width(), framebufferObject()->height());
        functions->glClearColor(0, 0, 0, 0);
        functions->glClear(GL_COLOR_BUFFER_BIT | GL_DEPTH_BUFFER_BIT | GL_STENCIL_BUFFER_BIT);
        A::Transform publishedLayout;
        QVariantMap animation;
        QStringList motions, expressions;
#ifdef REVERIE_LOCAL_CUBISM
        try {
            if (!C::CubismFramework::IsStarted()) {
                static C::CubismFramework::Option option;
                option.LoadFileFunction = shaderFile;
                option.ReleaseBytesFunction = releaseFile;
                C::CubismFramework::StartUp(&allocator, &option);
                C::CubismFramework::Initialize();
            }
            if (desired != current || reloadToken != appliedReload) {
                appliedReload = reloadToken;
                const bool released = bool(model);
                model.reset();
                current = desired;
                firstFrame = false;
                appliedRefit = refitToken;
                auto p = owner;
                if (released && p)
                    QMetaObject::invokeMethod(
                        p,
                        [p] {
                            if (p) {
                                ++p->m_releases;
                                emit p->statisticsChanged();
                            }
                        },
                        Qt::QueuedConnection);
                if (!current.isEmpty()) {
                    auto next = std::make_unique<AvatarModel>();
                    next->load(current);
                    model = std::move(next);
                    firstFrame = true;
                }
            }
            if (model) {
                if (refitToken != appliedRefit) {
                    model->captureBaseline();
                    appliedRefit = refitToken;
                }
                model->layout.configure(logicalSize.width(), logicalSize.height(), viewScale,
                                        {viewOffset.x(), viewOffset.y()});
                for (const auto &request : requests) {
                    QString kind = request.kind, name = request.name, reason, area;
                    bool ok = false;
                    try {
                        if (request.path != current)
                            reason = "MODEL_CHANGED";
                        else if (kind == "motion")
                            ok = model->startMotion(name, reason);
                        else if (kind == "expression")
                            ok = model->startExpression(name, reason);
                        else if (kind == "pointer") {
                            if (!model->layout.valid())
                                reason = "MODEL_LAYOUT_UNAVAILABLE";
                            else if (!QRectF(QPointF(), logicalSize).contains(request.point))
                                reason = "POINTER_OUTSIDE_ITEM";
                            else {
                                const auto point = model->layout.itemToModel(
                                    {request.point.x(), request.point.y()});
                                area = model->hitArea(point);
                                if (area.isEmpty())
                                    reason = "NO_MODEL_HIT_AREA";
                                else
                                    ok = model->interact(area, kind, name, reason);
                            }
                        } else
                            ok = model->interact({}, kind, name, reason);
                    } catch (const std::exception &error) {
                        reason = QString::fromUtf8(error.what());
                    }
                    interactionResult(request, ok, kind, name, reason, area);
                }
                const float now = clock.elapsed() / 1000.f;
                const float dt = active ? std::clamp(now - last, 0.f, .05f) : 0.f;
                last = now;
                if (active)
                    model->tick(dt, reducedMotion);
                model->draw();
                publishedLayout = model->layout;
                animation = model->animationState();
                motions = model->motionNames();
                expressions = model->expressionNames();
                if (firstFrame && model->layout.valid()) {
                    const auto size = framebufferObject()->size();
                    QByteArray pixels(size.width() * size.height() * 4, 0);
                    functions->glReadPixels(0, 0, size.width(), size.height(), GL_RGBA,
                                            GL_UNSIGNED_BYTE, pixels.data());
                    int painted = 0;
                    for (qsizetype n = 3; n < pixels.size(); n += 4)
                        if (static_cast<unsigned char>(pixels[n]) > 16)
                            ++painted;
                    if (painted < 1000)
                        throw std::runtime_error("NATIVE_FRAME_EMPTY");
                    auto p = owner;
                    if (p)
                        QMetaObject::invokeMethod(
                            p,
                            [p, painted, path = current] {
                                if (p && p->m_path == path)
                                    p->m_paintedPixels = painted;
                            },
                            Qt::QueuedConnection);
                    firstFrame = false;
                    notify(true, "Native 模型已绘制", true);
                }
            } else
                for (const auto &request : requests)
                    interactionResult(request, false, request.kind, request.name,
                                      "MODEL_NOT_LOADED");
        } catch (const std::exception &error) {
            const bool released = bool(model);
            model.reset();
            publishedLayout = {};
            animation = {};
            auto p = owner;
            if (released && p)
                QMetaObject::invokeMethod(
                    p,
                    [p] {
                        if (p) {
                            ++p->m_releases;
                            emit p->statisticsChanged();
                        }
                    },
                    Qt::QueuedConnection);
            for (const auto &request : requests)
                interactionResult(request, false, request.kind, request.name,
                                  "MODEL_RENDER_FAILED");
            notify(false, QString("模型加载失败：%1").arg(error.what()));
        }
#else
        if (!desired.isEmpty() && (current != desired || reloadToken != appliedReload)) {
            current = desired;
            appliedReload = reloadToken;
            notify(false, "当前构建未配置本地 Native Core");
        }
        for (const auto &request : requests)
            interactionResult(request, false, request.kind, request.name,
                              "NATIVE_CORE_UNAVAILABLE");
#endif
        requests.clear();
        QQuickOpenGLUtils::resetOpenGLState();
        auto p = owner;
        if (p)
            QMetaObject::invokeMethod(
                p,
                [p, path = current, publishedLayout, animation, motions, expressions,
                 framebufferSize = framebufferObject()->size(),
                 allocations = framebufferAllocations] {
                    if (!p || p->m_path != path)
                        return;
                    const bool capabilitiesChanged =
                        p->m_motionNames != motions || p->m_expressionNames != expressions;
                    const bool layoutChanged =
                        p->m_layout.revision() != publishedLayout.revision() ||
                        p->m_framebufferSize != framebufferSize;
                    p->m_layout = publishedLayout;
                    p->m_framebufferSize = framebufferSize;
                    p->m_framebufferAllocations = allocations;
                    p->m_animationState = animation;
                    p->m_motionNames = motions;
                    p->m_expressionNames = expressions;
                    ++p->m_frames;
                    if (capabilitiesChanged)
                        emit p->capabilitiesChanged();
                    if (layoutChanged || p->m_frames % 30 == 0)
                        emit p->statisticsChanged();
                },
                Qt::QueuedConnection);
    }
};

NativeAvatar::NativeAvatar(QQuickItem *parent) : QQuickFramebufferObject(parent) {
    setMirrorVertically(true);
    setTextureFollowsItemSize(false);
    m_timer.setInterval(16);
    connect(&m_timer, &QTimer::timeout, this, [this] {
        if (m_running && isVisible() && !m_path.isEmpty())
            update();
    });
    m_timer.start();
}
void NativeAvatar::setModelPath(const QString &value) {
    if (m_path == value)
        return;
    m_path = value;
    m_layout = {};
    m_framebufferSize = {};
    m_paintedPixels = 0;
    m_motionNames.clear();
    m_expressionNames.clear();
    m_animationState.clear();
    m_lastInteraction.clear();
    emit modelPathChanged();
    emit capabilitiesChanged();
    emit statisticsChanged();
    update();
}
void NativeAvatar::setReloadToken(int value) {
    if (m_reloadToken == value)
        return;
    m_reloadToken = value;
    m_layout = {};
    m_framebufferSize = {};
    m_paintedPixels = 0;
    m_motionNames.clear();
    m_expressionNames.clear();
    m_animationState.clear();
    m_lastInteraction.clear();
    emit reloadTokenChanged();
    emit capabilitiesChanged();
    emit statisticsChanged();
    update();
}
void NativeAvatar::setRunning(bool value) {
    if (value == m_running)
        return;
    m_running = value;
    emit runningChanged();
    update();
}
void NativeAvatar::setReducedMotion(bool value) {
    if (value == m_reducedMotion)
        return;
    m_reducedMotion = value;
    emit reducedMotionChanged();
    update();
}
void NativeAvatar::setViewScale(qreal value) {
    if (!std::isfinite(value))
        return;
    value = std::clamp(value, qreal(.25), qreal(4));
    if (value == m_viewScale)
        return;
    m_viewScale = value;
    emit viewTransformChanged();
    update();
}
void NativeAvatar::setViewOffset(QPointF value) {
    if (!std::isfinite(value.x()) || !std::isfinite(value.y()) || value == m_viewOffset)
        return;
    m_viewOffset = value;
    emit viewTransformChanged();
    update();
}
void NativeAvatar::enqueue(const QString &kind, const QString &name, QPointF point) {
    if (m_requests.size() >= 32) {
        emit interactionFinished(false, kind, name, "INTERACTION_QUEUE_FULL");
        return;
    }
    m_requests.append({++m_requestId, m_path, kind, name, point});
    update();
}
void NativeAvatar::playMotion(const QString &name) { enqueue("motion", name); }
void NativeAvatar::expression(const QString &name) { enqueue("expression", name); }
void NativeAvatar::interact() { enqueue("activate"); }
void NativeAvatar::interactAt(qreal x, qreal y) { enqueue("pointer", {}, {x, y}); }
void NativeAvatar::refit() {
    ++m_refitToken;
    update();
}
A::Transform NativeAvatar::itemTransform() const {
    auto transform = m_layout;
    transform.configure(width(), height(), m_viewScale, {m_viewOffset.x(), m_viewOffset.y()});
    return transform;
}
QPointF NativeAvatar::modelToItem(QPointF point) const {
    const auto transform = itemTransform();
    if (!transform.valid())
        return {qQNaN(), qQNaN()};
    return qtPoint(transform.modelToItem({point.x(), point.y()}));
}
QPointF NativeAvatar::itemToModel(QPointF point) const {
    const auto transform = itemTransform();
    if (!transform.valid())
        return {qQNaN(), qQNaN()};
    return qtPoint(transform.itemToModel({point.x(), point.y()}));
}
QVariantMap NativeAvatar::diagnostics() const {
    const auto transform = itemTransform();
    QVariantMap result = m_animationState;
    result["modelPath"] = m_path;
    result["layoutValid"] = transform.valid();
    result["layoutRevision"] = transform.revision();
    result["baselineBounds"] = boundsMap(transform.bounds());
    result["modelAnchor"] = pointMap(transform.modelAnchor());
    result["itemAnchor"] = pointMap(transform.itemAnchor());
    const auto windowAnchor = itemToWindow(qtPoint(transform.itemAnchor()));
    result["windowAnchor"] = pointMap({windowAnchor.x(), windowAnchor.y()});
    result["logicalSize"] = QVariantMap{{"width", width()}, {"height", height()}};
    result["framebufferSize"] =
        QVariantMap{{"width", m_framebufferSize.width()}, {"height", m_framebufferSize.height()}};
    result["framebufferAllocations"] = m_framebufferAllocations;
    result["framebufferScale"] =
        QVariantMap{{"x", width() > 0 ? m_framebufferSize.width() / width() : 0},
                    {"y", height() > 0 ? m_framebufferSize.height() / height() : 0}};
    result["logicalPixelsPerModelUnit"] = transform.scale();
    result["viewScale"] = m_viewScale;
    result["viewOffset"] = pointMap({m_viewOffset.x(), m_viewOffset.y()});
    result["motionNames"] = m_motionNames;
    result["expressionNames"] = m_expressionNames;
    result["running"] = m_running;
    result["reducedMotion"] = m_reducedMotion;
    result["successfulInteractions"] = m_successfulInteractions;
    result["lastInteraction"] = m_lastInteraction;
    result["frames"] = m_frames;
    result["loads"] = m_loads;
    result["releases"] = m_releases;
    result["paintedPixels"] = m_paintedPixels;
    return result;
}
QQuickFramebufferObject::Renderer *NativeAvatar::createRenderer() const {
    return new AvatarRenderer;
}
