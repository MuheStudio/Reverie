#pragma once
#include "WorldbookInjectionInput.h"
#include <QGuiApplication>
#include <QStyleHints>

// One physical click, Escape, then the original eight traversal keys. Both
// callers retain their own preparation and four-second clock. Observations
// are published before assertions, including a failed partial traversal.
namespace WorldbookInjectionNavigation {
struct Context {
    QPointer<QObject> editor;
    std::function<QQuickItem *(const QString &)> resolve;
    std::function<QVariantMap()> values;
    std::function<QVariantMap()> metadata;
    std::function<QPoint(QQuickItem *, bool, bool)> qualify;
    std::function<void(const QVariantMap &)> publish;
    // Unset for the frozen native navigation records: the original call and
    // all original keys, snapshots and raw schemas then remain unchanged.
    std::function<void(const QPoint &)> mouseDispatch;
};
// The diagnostic class name may be a QML-derived alias (for example
// GlassField_QMLTYPE_*). Navigation type decisions use QObject inheritance.
inline QVariantMap typeFlags(const QObject *object) {
    return {{"textInput", object && object->inherits("QQuickTextInput")},
        {"textEdit", object && object->inherits("QQuickTextEdit")},
        {"comboBox", object && object->inherits("QQuickComboBox")},
        {"spinBox", object && object->inherits("QQuickSpinBox")}};
}
inline QVariantMap describe(QQuickItem *item, QQuickWindow *window) {
    auto out = WorldbookInjectionInput::identity(item);
    out.insert("typeFlags", typeFlags(item));
    const auto policy = item ? item->property("focusPolicy") : QVariant();
    const auto reason = item ? item->property("focusReason") : QVariant();
    auto *popup = item ? item->property("popup").value<QObject *>() : nullptr;
    out.insert({{"visible", item && item->isVisible()}, {"enabled", item && item->isEnabled()},
        {"focusPolicy", policy.isValid() ? QVariant(policy.toInt()) : QVariant()},
        {"focusReason", reason.isValid() ? QVariant(reason.toInt()) : QVariant()},
        {"activeFocusOnTab", item && item->activeFocusOnTab()}, {"isFocusScope", item && item->isFocusScope()},
        {"scopedFocusItem", WorldbookInjectionInput::identity(item && item->isFocusScope() ? item->scopedFocusItem() : nullptr)},
        {"contentItem", WorldbookInjectionInput::identity(item ? item->property("contentItem").value<QQuickItem *>() : nullptr)},
        {"popupVisible", popup && popup->property("visible").toBool()},
        {"geometry", NativeControlReadiness::wholeVisibility(item, window)}});
    return out;
}
inline QQuickItem *owner(QQuickItem *leaf) {
    for (auto *current = leaf; current; current = current->parentItem())
        if (current->property("focusReason").isValid() && current->property("focusPolicy").isValid()) return current;
    return nullptr;
}
inline QVariantMap traverse(QQuickWindow *window, QQuickItem *control, const Context &context) {
    QPointer<QQuickItem> position = control;
    QPointer<QQuickItem> depth = context.resolve("worldbookInsertionDepth");
    QPointer<QQuickItem> role = context.resolve("worldbookInsertionRole");
    QSignalSpy positionActivated(position, SIGNAL(activated(int)));
    QSignalSpy depthModified(depth, SIGNAL(valueModified()));
    QSignalSpy roleActivated(role, SIGNAL(activated(int)));
    const auto before = context.values(), caller = context.metadata();
    QVariantMap evidence{{"schema", "reverie.qt.worldbook-injection-navigation.v2"},
        {"controlObjectName", "worldbookInsertionPosition"}, {"completed", false},
        {"windowWidth", window ? window->width() : 0}, {"windowHeight", window ? window->height() : 0},
        {"tabFocusBehavior", int(QGuiApplication::styleHints()->tabFocusBehavior())},
        {"beforeGroup", before}, {"afterGroup", before}};
    for (const auto *key : {"step", "stepAtMs", "inputAtMs", "selectedEntryId", "scope", "generation"})
        evidence[key] = caller.value(key);
    QVariantList snapshots, keyDispatches;
    QStringList keys, visited;
    int mouseDispatchCount = 0, keyDispatchCount = 0;
    const auto inside = [&](QQuickItem *leaf) {
        return leaf && ((position && (position == leaf || position->isAncestorOf(leaf))) ||
            (depth && (depth == leaf || depth->isAncestorOf(leaf))) ||
            (role && (role == leaf || role->isAncestorOf(leaf))));
    };
    const auto capture = [&](const QString &phase, int actionIndex, const QString &action,
                             QQuickItem *expected, bool selector = false) {
        auto *focus = window ? window->activeFocusItem() : nullptr;
        const auto metadata = context.metadata();
        const QVariantMap controls{{"position", describe(position, window)}, {"depth", describe(depth, window)},
            {"role", describe(role, window)}};
        const QVariant keyCode = action == "Click" ? QVariant() : QVariant(int(action == "Escape" ? Qt::Key_Escape :
            action == "Backtab" ? Qt::Key_Backtab : Qt::Key_Tab));
        const int modifiers = int(action == "Backtab" ? Qt::ShiftModifier : Qt::NoModifier);
        QVariantMap sample{{"phase", phase}, {"capturePoint", "before-boundary-assertion"},
            {"actionIndex", actionIndex}, {"action", action}, {"keyCode",keyCode},{"modifiers",modifiers},
            {"mouseDispatchCount", mouseDispatchCount},
            {"keyDispatchCount", keyDispatchCount}, {"positionActivatedSignals", positionActivated.count()},
            {"depthModifiedSignals", depthModified.count()}, {"roleActivatedSignals", roleActivated.count()},
            {"values", context.values()}, {"tabFocusBehavior", int(QGuiApplication::styleHints()->tabFocusBehavior())},
            {"focus", describe(focus, window)}, {"owner", describe(owner(focus), window)},
            {"expected", describe(expected, window)},
            {"focusInExpected", ArchiveInputProbe::keyboardFocusMatches(expected, window, selector)},
            {"groupContains", inside(focus)}, {"controls", controls}};
        for (const auto *key : {"nowMs", "elapsedMs", "stepAtMs", "inputAtMs", "scope", "generation", "step", "frame", "selectedEntryId"})
            sample[key] = metadata.value(key);
        if (snapshots.size() < 32) snapshots.append(sample);
        evidence.insert({{"snapshots", snapshots}, {"mouseDispatchCount", mouseDispatchCount},
            {"keyDispatchCount", keyDispatchCount}, {"keyActions", keys}, {"keyDispatches",keyDispatches},{"visited", visited},
            {"positionActivatedSignals", positionActivated.count()}, {"depthModifiedSignals", depthModified.count()},
            {"roleActivatedSignals", roleActivated.count()}, {"afterGroup", context.values()}});
        context.publish(evidence);
        return sample;
    };
    const auto require = [&](bool ok, const QString &code) { NativeCheck::require(ok, code, evidence); };
    const auto stable = [&](const QVariantMap &sample) {
        require(context.editor && position && depth && role &&
            context.resolve("worldbookInsertionPosition") == position && context.resolve("worldbookInsertionDepth") == depth &&
            context.resolve("worldbookInsertionRole") == role, "INJECTION_TAB_TARGET_CHANGED");
        require(sample.value("values").toMap() == before && positionActivated.count() == 0 &&
            depthModified.count() == 0 && roleActivated.count() == 0, "INJECTION_TAB_CHANGED_VALUE");
        require(sample.value("tabFocusBehavior") == evidence.value("tabFocusBehavior"), "INJECTION_TAB_POLICY_CHANGED");
        require(sample.value("elapsedMs").toLongLong() >= 0 && sample.value("elapsedMs").toLongLong() < 4000,
            "INJECTION_INPUT_DEADLINE");
    };
    auto sample = capture("before-click", 0, "Click", position);
    require(window && position && depth && role && position->isEnabled() && depth->isEnabled() && role->isEnabled() &&
        positionActivated.isValid() && depthModified.isValid() && roleActivated.isValid(), "INJECTION_TAB_CONTROLS");
    stable(sample);
    const auto point = context.qualify(position, false, false);
    ++mouseDispatchCount;
    if (context.mouseDispatch) context.mouseDispatch(point);
    else QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, point, 0);
    sample = capture("after-click", 0, "Click", position, true);
    stable(sample); require(sample.value("focusInExpected").toBool(), "INJECTION_KEY_FOCUS_MISMATCH");
    sample = capture("before-escape", 1, "Escape", position, true);
    stable(sample); context.qualify(position, true, true);
    ++keyDispatchCount; keys.append("Escape");
    keyDispatches.append(QVariantMap{{"keyCode",int(Qt::Key_Escape)},{"modifiers",int(Qt::NoModifier)}});
    QTest::keyClick(window, Qt::Key_Escape, Qt::NoModifier, 0);
    sample = capture("after-escape", 1, "Escape", position);
    stable(sample); require(sample.value("focusInExpected").toBool(), "INJECTION_KEY_FOCUS_MISMATCH");
    visited.append("worldbookInsertionPosition");

    struct Move { const char *phase; bool backwards; QQuickItem *from; QQuickItem *to; const char *code; const char *visit; };
    QPointer<QQuickItem> forwardOutside, backwardOutside;
    const auto move = [&](const Move &entry, int index) {
        const QString action = entry.backwards ? "Backtab" : "Tab";
        sample = capture("before-" + QString::fromLatin1(entry.phase), index, action, entry.from);
        stable(sample); context.qualify(entry.from, true, false);
        ++keyDispatchCount; keys.append(action);
        keyDispatches.append(QVariantMap{{"keyCode",int(entry.backwards ? Qt::Key_Backtab : Qt::Key_Tab)},
            {"modifiers",int(entry.backwards ? Qt::ShiftModifier : Qt::NoModifier)}});
        // KeyNavigation distinguishes the platform's Backtab key code from
        // Tab; preserve one logical Shift+Tab dispatch with that actual code.
        QTest::keyClick(window, entry.backwards ? Qt::Key_Backtab : Qt::Key_Tab,
            entry.backwards ? Qt::ShiftModifier : Qt::NoModifier, 0);
        auto *focus = window->activeFocusItem();
        sample = capture("after-" + QString::fromLatin1(entry.phase), index, action, entry.to ? entry.to : focus);
        stable(sample);
        require(entry.to ? ArchiveInputProbe::keyboardFocusMatches(entry.to, window) : focus && !inside(focus),
            QString::fromLatin1(entry.code));
        visited.append(QString::fromLatin1(entry.visit));
    };
    move({"tab-depth", false, position, depth, "INJECTION_TAB_DEPTH", "worldbookInsertionDepth"}, 2);
    move({"tab-role", false, depth, role, "INJECTION_TAB_ROLE", "worldbookInsertionRole"}, 3);
    move({"tab-outside", false, role, nullptr, "INJECTION_TAB_OUTSIDE_GROUP", "after-group"}, 4);
    forwardOutside = window->activeFocusItem();
    require(forwardOutside && window->activeFocusItem() == forwardOutside, "INJECTION_TAB_OUTSIDE_CHANGED");
    move({"backtab-role", true, forwardOutside, role, "INJECTION_BACKTAB_ROLE", "worldbookInsertionRole"}, 5);
    move({"backtab-depth", true, role, depth, "INJECTION_BACKTAB_DEPTH", "worldbookInsertionDepth"}, 6);
    move({"backtab-position", true, depth, position, "INJECTION_BACKTAB_POSITION", "worldbookInsertionPosition"}, 7);
    move({"backtab-outside", true, position, nullptr, "INJECTION_BACKTAB_OUTSIDE_GROUP", "before-group"}, 8);
    backwardOutside = window->activeFocusItem();
    require(backwardOutside && window->activeFocusItem() == backwardOutside, "INJECTION_BACKTAB_OUTSIDE_CHANGED");
    move({"tab-position", false, backwardOutside, position, "INJECTION_TAB_BACK_POSITION", "worldbookInsertionPosition"}, 9);
    require(before == context.values() && mouseDispatchCount == 1 && keyDispatchCount == 9 && snapshots.size() == 20,
        "INJECTION_TAB_CHANGED_VALUE");
    evidence.insert({{"completed", true}, {"visited", visited}, {"afterGroup", context.values()}});
    context.publish(evidence);
    return evidence;
}
} // namespace WorldbookInjectionNavigation
