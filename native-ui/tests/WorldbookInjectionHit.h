#pragma once
#include "CheckContract.h"
#include <QMouseEvent>
#include <QTest>
#include <functional>
#include <utility>

// Injection-only evidence. NativeCheck::Hit and its nine-field metadata stay
// unchanged. A readiness point, the point actually probed, the argument sent to
// QTest, and the positions delivered to the real window are separate readings.
namespace WorldbookInjectionHit {
using Clock = std::function<QVariantMap()>;

inline QVariantMap identity(const QObject *object) {
    return {{"found", object != nullptr}, {"objectName", object ? object->objectName().left(80) : QString()},
        {"className", object ? QString::fromLatin1(object->metaObject()->className()).left(80) : QString()},
        {"token", object ? QString::number(reinterpret_cast<quintptr>(object), 16) : QString()}};
}
inline QVariantMap point(const QPoint &value) { return {{"x", value.x()}, {"y", value.y()}}; }
inline QVariantMap metadata(QQuickWindow *window, QQuickItem *target, const Clock &clock) {
    const auto caller = clock();
    QVariantMap out{{"control", target ? target->objectName() : QString()},
        {"window", identity(window)}, {"target", identity(target)}};
    for (const auto *key : {"nowMs", "elapsedMs", "frame", "scope", "generation", "step",
                           "selectedEntryId", "stepAtMs", "inputAtMs"}) out[key] = caller.value(key);
    return out;
}
inline QVariantMap probe(QQuickWindow *window, QQuickItem *target, const QPoint &probePoint,
                         const NativeCheck::Hit &hit, const Clock &clock) {
    return {{"point", point(probePoint)}, {"accepted", hit.accepted()}, {"hit", hit.metadata()},
        {"metadata", metadata(window, target, clock)}};
}

// A window event filter observes the events sent by this one QTest call. It
// never consumes them. Three retained events make overflow rejectable while
// avoiding unbounded observation work; a valid click has exactly two events.
class WindowObserver final : public QObject {
public:
    WindowObserver(QQuickWindow *window, QQuickItem *target, Clock clock)
        : m_window(window), m_target(target), m_clock(std::move(clock)) {
        if (m_window) m_window->installEventFilter(this);
    }
    ~WindowObserver() override { if (m_window) m_window->removeEventFilter(this); }
    QVariantList events() const { return m_events; }
protected:
    bool eventFilter(QObject *watched, QEvent *event) override {
        if (watched != m_window || m_events.size() >= 3 ||
            (event->type() != QEvent::MouseButtonPress && event->type() != QEvent::MouseButtonRelease)) return false;
        const auto *mouse = static_cast<QMouseEvent *>(event);
        m_events.append(QVariantMap{{"type", event->type() == QEvent::MouseButtonPress ? "press" : "release"},
            {"x", mouse->position().x()}, {"y", mouse->position().y()}, {"button", int(mouse->button())},
            {"buttons", int(mouse->buttons())}, {"modifiers", int(mouse->modifiers())},
            {"timestampMs", QVariant::fromValue(quint64(mouse->timestamp()))},
            {"metadata", metadata(m_window, m_target, m_clock)}});
        return false;
    }
private:
    QPointer<QQuickWindow> m_window;
    QPointer<QQuickItem> m_target;
    Clock m_clock;
    QVariantList m_events;
};

// This is the same single dispatch as the original callers: no extra input,
// waiting, event pumping, request, retry, clock reset, or readiness decision.
inline QVariantMap mouseClick(QQuickWindow *window, QQuickItem *target, const QString &kind,
                              const QPoint &readinessPoint, const QVariantMap &hitProbe,
                              const QPoint &dispatchPoint, const Clock &clock) {
    QPointer<QQuickWindow> boundWindow = window;
    QPointer<QQuickItem> boundTarget = target;
    const auto before = metadata(boundWindow, boundTarget, clock);
    WindowObserver observer(boundWindow, boundTarget, clock);
    QTest::mouseClick(boundWindow, Qt::LeftButton, Qt::NoModifier, dispatchPoint, 0);
    const auto after = metadata(boundWindow, boundTarget, clock);
    QVariantMap out{{"schema", "reverie.qt.worldbook-injection-input-hit.v1"}, {"kind", kind},
        {"control", before.value("control")}, {"window", before.value("window")}, {"target", before.value("target")},
        {"windowWidth", boundWindow ? boundWindow->width() : 0}, {"windowHeight", boundWindow ? boundWindow->height() : 0},
        {"readinessPoint", point(readinessPoint)}, {"probe", hitProbe},
        {"dispatch", QVariantMap{{"point", point(dispatchPoint)}, {"button", int(Qt::LeftButton)},
            {"modifiers", int(Qt::NoModifier)}, {"delayMs", 0}, {"mouseDispatchCount", 1},
            {"before", before}, {"after", after}, {"events", observer.events()}}}};
    for (const auto *key : {"scope", "generation", "step", "selectedEntryId", "stepAtMs", "inputAtMs"})
        out[key] = before.value(key);
    return out;
}
} // namespace WorldbookInjectionHit
