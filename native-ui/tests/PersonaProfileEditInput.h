#pragma once
#include "CheckContract.h"
#include <QCoreApplication>
#include <QInputMethodEvent>
#include <QMetaObject>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <functional>

// The independent edit driver owns the real mouse, its stable acquisition and
// the original 4 s clock. Selection can scroll a TextArea; after acquisition we
// keep checking the same target/focus/scope/clock rather than its old geometry.
namespace PersonaProfileEditInput {
inline void replace(QQuickWindow *window, QQuickItem *target, const QString &text,
                    const std::function<void()> &verify) {
    QPointer<QQuickWindow> guardedWindow(window);
    QPointer<QQuickItem> guarded(target);
    auto available = [&] {
        NativeCheck::require(guardedWindow && guarded && guarded->isVisible() && guarded->isEnabled() &&
            !NativeControlReadiness::visibleRect(guarded, guardedWindow).isEmpty(), "CARD_EDIT_TEXT_TARGET_UNAVAILABLE", {});
    };
    auto focused = [&] {
        verify(); available();
        auto *focus = guardedWindow->activeFocusItem();
        NativeCheck::require(focus && (focus == guarded || guarded->isAncestorOf(focus)), "CARD_EDIT_TEXT_FOCUS", {});
    };
    // verify calls: 1 before focus, 2 before selectAll, 3 before commit,
    // 4 after commit. A failed guard never retries the input.
    verify(); available();
    guarded->forceActiveFocus();
    focused();
    NativeCheck::require(QMetaObject::invokeMethod(guarded, "selectAll"), "CARD_EDIT_TEXT_SELECT_ALL_UNAVAILABLE", {});
    focused();
    QInputMethodEvent commit;
    commit.setCommitString(text);
    QCoreApplication::sendEvent(guardedWindow, &commit);
    focused();
    NativeCheck::require(guarded->property("text").toString() == text, "CARD_EDIT_TEXT_NOT_COMMITTED", {});
}
}
