#pragma once

#include <QObject>
#include <QPointer>
#include <QQuickWindow>

// A passive observer of delivery to one window. It never accepts input, takes
// a grab, or changes focus. The release latch remains set until delivery ends.
class WindowInputState : public QObject
{
    Q_OBJECT
    Q_PROPERTY(QQuickWindow *window READ window WRITE setWindow NOTIFY windowChanged)
    Q_PROPERTY(bool held READ held NOTIFY changed)
    Q_PROPERTY(int mouseButtons READ mouseButtons NOTIFY changed)
    Q_PROPERTY(int touchCount READ touchCount NOTIFY changed)
    Q_PROPERTY(int revision READ revision NOTIFY changed)
public:
    explicit WindowInputState(QObject *parent = nullptr);
    ~WindowInputState() override;
    QQuickWindow *window() const { return m_window; }
    void setWindow(QQuickWindow *window);
    bool held() const;
    int mouseButtons() const;
    int touchCount() const { return m_touchCount; }
    int revision() const { return m_revision; }
signals:
    void windowChanged();
    void changed();
    // Numeric input kinds are also suitable for bounded diagnostic records.
    void interactionObserved(int kind);
protected:
    bool eventFilter(QObject *watched, QEvent *event) override;
private:
    void cancel(int kind);
    void releaseAfterDelivery();
    QPointer<QQuickWindow> m_window;
    Qt::MouseButtons m_mouseButtons = Qt::NoButton;
    int m_touchCount = 0;
    int m_revision = 0;
    bool m_releaseLatch = false;
};

void registerArchiveInteractionTypes();
