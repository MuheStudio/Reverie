#pragma once

#include <QString>
#include <QVariantMap>

// Classifies the partial-task keyboard switch from navigation state captured
// immediately before and after the original key helper. It never changes the
// key, the pointer release or the original assertions.
namespace ShortcutHandoff {

inline bool entered(const QVariantMap &before, const QVariantMap &after) {
    return after.value("currentFeature").toString() == "settings" &&
           after.value("transitionRevision") != before.value("transitionRevision");
}

// A window shortcut matches only while its window is active; QTest key events
// reach the window either way. Empty when navigation accepted the switch or
// its state was not observable.
inline QString gap(const QVariantMap &before, const QVariantMap &after) {
    if (!before.contains("transitionRevision") || !after.contains("transitionRevision") ||
        entered(before, after))
        return {};
    return before.value("windowActive").toBool() ? "PARTIAL_TASK_SHORTCUT_NOT_ACCEPTED"
                                                 : "PARTIAL_TASK_SHORTCUT_WINDOW_INACTIVE";
}

} // namespace ShortcutHandoff
