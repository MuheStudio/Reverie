#include "WindowInputState.h"

#include <QGuiApplication>
#include <QMouseEvent>
#include <QTouchEvent>
#include <QtQml/qqml.h>

WindowInputState::WindowInputState(QObject *parent) : QObject(parent) {}
WindowInputState::~WindowInputState()
{
    if (m_window)
        m_window->removeEventFilter(this);
}

void WindowInputState::setWindow(QQuickWindow *window)
{
    if (m_window == window)
        return;
    if (m_window)
        m_window->removeEventFilter(this);
    cancel(10);
    m_window = window;
    if (m_window)
        m_window->installEventFilter(this);
    emit windowChanged();
}

int WindowInputState::mouseButtons() const
{
    return int(m_mouseButtons | QGuiApplication::mouseButtons());
}

bool WindowInputState::held() const
{
    return m_releaseLatch || mouseButtons() != int(Qt::NoButton) || m_touchCount > 0;
}

void WindowInputState::cancel(int kind)
{
    ++m_revision;
    m_mouseButtons = Qt::NoButton;
    m_touchCount = 0;
    m_releaseLatch = false;
    emit interactionObserved(kind);
    emit changed();
}

void WindowInputState::releaseAfterDelivery()
{
    const int revision = m_revision;
    const QPointer<QQuickWindow> window = m_window;
    QMetaObject::invokeMethod(this, [this, revision, window] {
        if (m_revision != revision || m_window != window)
            return;
        m_releaseLatch = false;
        emit changed();
    }, Qt::QueuedConnection);
}

bool WindowInputState::eventFilter(QObject *watched, QEvent *event)
{
    if (watched != m_window)
        return false;
    int kind = 0;
    switch (event->type()) {
    case QEvent::KeyPress:
        // A subsequent keyboard dispatch is a new input boundary. In
        // particular, synthetic mouseClick + keyClick need no event-loop wait
        // between them. Direct focus changes from the release handler remain
        // blocked by the latch; a held physical button is never cleared here.
        if (m_releaseLatch && m_mouseButtons == Qt::NoButton && m_touchCount == 0
                && QGuiApplication::mouseButtons() == Qt::NoButton) {
            m_releaseLatch = false;
            emit changed();
        }
        return false;
    case QEvent::MouseButtonPress:
    case QEvent::MouseButtonDblClick:
        m_mouseButtons = static_cast<QMouseEvent *>(event)->buttons();
        m_releaseLatch = true;
        kind = 1;
        break;
    case QEvent::MouseButtonRelease:
        m_mouseButtons = static_cast<QMouseEvent *>(event)->buttons();
        m_releaseLatch = true;
        kind = 2;
        break;
    case QEvent::MouseMove:
        m_mouseButtons = static_cast<QMouseEvent *>(event)->buttons();
        if (m_mouseButtons == Qt::NoButton)
            return false;
        kind = 3;
        break;
    case QEvent::Wheel:
        kind = 4;
        break;
    case QEvent::TouchBegin:
    case QEvent::TouchUpdate:
    case QEvent::TouchEnd: {
        m_touchCount = 0;
        const auto *touch = static_cast<QTouchEvent *>(event);
        for (const QEventPoint &point : touch->points())
            if (point.state() != QEventPoint::State::Released)
                ++m_touchCount;
        m_releaseLatch = true;
        kind = event->type() == QEvent::TouchBegin ? 5 : event->type() == QEvent::TouchEnd ? 7 : 6;
        break;
    }
    case QEvent::TouchCancel:
        cancel(8);
        return false;
    case QEvent::UngrabMouse:
        cancel(11);
        return false;
    case QEvent::WindowDeactivate:
    case QEvent::Hide:
    case QEvent::Close:
        cancel(9);
        return false;
    default:
        return false;
    }
    ++m_revision;
    emit interactionObserved(kind);
    emit changed();
    if (kind == 2 || kind == 7 || (kind == 6 && m_touchCount == 0))
        releaseAfterDelivery();
    return false;
}

void registerArchiveInteractionTypes()
{
    static const int typeId = qmlRegisterType<WindowInputState>("Reverie.Archive", 1, 0, "WindowInputState");
    Q_UNUSED(typeId);
}
