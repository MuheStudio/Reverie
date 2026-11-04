#pragma once

#include "AvatarTransform.h"
#include <QQuickFramebufferObject>
#include <QStringList>
#include <QTimer>
#include <QVariantMap>

class AvatarRenderer;
class NativeAvatar : public QQuickFramebufferObject {
    Q_OBJECT
    Q_PROPERTY(QString modelPath READ modelPath WRITE setModelPath NOTIFY modelPathChanged)
    // A changed token loads the same path again, e.g. a retry after a failed load.
    Q_PROPERTY(int reloadToken READ reloadToken WRITE setReloadToken NOTIFY reloadTokenChanged)
    Q_PROPERTY(bool running READ running WRITE setRunning NOTIFY runningChanged)
    Q_PROPERTY(
        bool reducedMotion READ reducedMotion WRITE setReducedMotion NOTIFY reducedMotionChanged)
    Q_PROPERTY(qreal viewScale READ viewScale WRITE setViewScale NOTIFY viewTransformChanged)
    Q_PROPERTY(QPointF viewOffset READ viewOffset WRITE setViewOffset NOTIFY viewTransformChanged)
    Q_PROPERTY(QStringList motionNames READ motionNames NOTIFY capabilitiesChanged)
    Q_PROPERTY(QStringList expressionNames READ expressionNames NOTIFY capabilitiesChanged)
    Q_PROPERTY(int successfulInteractions READ successfulInteractions NOTIFY statisticsChanged)
    Q_PROPERTY(int loads READ loads NOTIFY statisticsChanged)
    Q_PROPERTY(int releases READ releases NOTIFY statisticsChanged)
    Q_PROPERTY(int frames READ frames NOTIFY statisticsChanged)
    Q_PROPERTY(int paintedPixels READ paintedPixels NOTIFY statisticsChanged)
  public:
    explicit NativeAvatar(QQuickItem *parent = nullptr);
    Renderer *createRenderer() const override;
    QString modelPath() const { return m_path; }
    void setModelPath(const QString &value);
    int reloadToken() const { return m_reloadToken; }
    void setReloadToken(int value);
    bool running() const { return m_running; }
    void setRunning(bool value);
    bool reducedMotion() const { return m_reducedMotion; }
    void setReducedMotion(bool value);
    qreal viewScale() const { return m_viewScale; }
    void setViewScale(qreal value);
    QPointF viewOffset() const { return m_viewOffset; }
    void setViewOffset(QPointF value);
    QStringList motionNames() const { return m_motionNames; }
    QStringList expressionNames() const { return m_expressionNames; }
    int successfulInteractions() const { return m_successfulInteractions; }
    int loads() const { return m_loads; }
    int releases() const { return m_releases; }
    int frames() const { return m_frames; }
    int paintedPixels() const { return m_paintedPixels; }

    Q_INVOKABLE void playMotion(const QString &name);
    Q_INVOKABLE void expression(const QString &name);
    Q_INVOKABLE void interact();
    Q_INVOKABLE void interactAt(qreal x, qreal y);
    Q_INVOKABLE void refit();
    Q_INVOKABLE QPointF modelToItem(QPointF point) const;
    Q_INVOKABLE QPointF itemToModel(QPointF point) const;
    Q_INVOKABLE QPointF itemToWindow(QPointF point) const { return mapToScene(point); }
    Q_INVOKABLE QPointF windowToItem(QPointF point) const { return mapFromScene(point); }
    Q_INVOKABLE QVariantMap diagnostics() const;

  signals:
    void modelPathChanged();
    void reloadTokenChanged();
    void runningChanged();
    void reducedMotionChanged();
    void viewTransformChanged();
    void capabilitiesChanged();
    void statisticsChanged();
    void rendered(bool ok, QString reason, QString modelPath);
    // Reports a processed request/start result, not completion of playback.
    void interactionFinished(bool ok, QString kind, QString name, QString reason);

  private:
    friend class AvatarRenderer;
    struct Request {
        quint64 id;
        QString path, kind, name;
        QPointF point;
    };
    void enqueue(const QString &kind, const QString &name = {}, QPointF point = {});
    ReverieAvatar::Transform itemTransform() const;
    QString m_path;
    bool m_running = true, m_reducedMotion = false;
    qreal m_viewScale = 1;
    QPointF m_viewOffset;
    QStringList m_motionNames, m_expressionNames;
    QList<Request> m_requests;
    quint64 m_requestId = 0, m_refitToken = 0;
    int m_reloadToken = 0;
    int m_loads = 0, m_releases = 0, m_frames = 0, m_paintedPixels = 0;
    int m_successfulInteractions = 0;
    ReverieAvatar::Transform m_layout;
    QSize m_framebufferSize;
    int m_framebufferAllocations = 0;
    QVariantMap m_animationState, m_lastInteraction;
    QTimer m_timer;
};
