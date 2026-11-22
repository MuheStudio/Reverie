import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window
import QtQuick.Dialogs
import Reverie.Archive 1.0

Item {
    id: editor
    property var navigation
    readonly property Item firstFocusItem: archiveEditor.hasBook ? titleField : bookSelector.count > 1 ? bookSelector : newBookButton
    readonly property bool modalOpen: reloadConfirm.visible || navigationConfirm.visible || deleteConfirm.visible
        || worldbookImportConfirm.visible || worldbookOpenDialog.visible || worldbookSaveDialog.visible
    readonly property var worldbookFileState: session.worldbookFileState || ({})
    readonly property bool worldbookFileBusy: session.worldbookFileBusy === true
    readonly property var selectedFileBook: (archiveEditor.bookRows || []).find(row => row.key === archiveEditor.selectedBookKey) || ({})
    readonly property bool worldbookFileReady: session.worldbookFileAvailable === true && archiveEditor.initialized
        && archiveEditor.archiveScope === personaScope && !archiveEditor.busy && !archiveEditor.dirty
        && !archiveEditor.newLocal && !archiveEditor.writesBlocked && !modalOpen
    property string worldbookReadbackRequest: ""
    property bool saveAcknowledged: false
    property int lastSavedRevision: -1
    property bool detailsExpanded: false
    readonly property bool saving: archiveEditor.status === "saving"
    readonly property bool loading: archiveEditor.status === "loading"
    readonly property bool failed: ["error", "read-error", "orphan"].includes(archiveEditor.status)
    readonly property bool conflicted: archiveEditor.status === "conflict"
    readonly property var navigationPrompt: archiveEditor.navigationPrompt || ({})
    readonly property var deletePrompt: archiveEditor.deletePrompt || ({})
    readonly property var deleteFeedback: archiveEditor.deleteFeedback || ({})
    readonly property var advancedFields: archiveEditor.advancedFields || ({})
    readonly property string personaScope: session.scopeKey || ""
    readonly property bool deleting: archiveEditor.deletionActive
    readonly property bool entryEditable: archiveEditor.hasEntry && archiveEditor.initialized && !deleting
    readonly property bool advancedRuleEditable: entryEditable && archiveEditor.advancedRuleEditable
    readonly property bool orderEditable: archiveEditor.insertionOrder >= 0 && archiveEditor.insertionOrder <= 2147483647
    readonly property bool priorityEditable: entryEditable && archiveEditor.priorityEditable
    readonly property var bookSettingStates: archiveEditor.bookSettingStates || ({})
    readonly property bool bookSettingsEditable: archiveEditor.hasBook && !archiveEditor.hasEntry && archiveEditor.initialized && !deleting
    readonly property var entrySettingStates: archiveEditor.entrySettingStates || ({})
    readonly property var insertionStates: archiveEditor.insertionStates || ({})
    readonly property var insertionPositionChoices: [
        {key: "before_char", label: "系统提示 · 身份段之后（默认）"},
        {key: "after_char", label: "系统提示 · 角色状态之后"},
        {key: "at_depth", label: "对话中 · 按深度插入"}
    ]
    readonly property var insertionRoleChoices: [
        {key: "system", label: "系统"}, {key: "user", label: "用户"}, {key: "assistant", label: "助手"}
    ]
    readonly property var selectiveLogicChoices: [
        {key: "and_any", label: "任一辅助词匹配"},
        {key: "and_all", label: "全部辅助词匹配"},
        {key: "not_any", label: "所有辅助词均不匹配"},
        {key: "not_all", label: "辅助词未全部匹配"}
    ]
    readonly property color statusAccent: failed ? "#e3a19d" : conflicted ? "#d8bb8b" : saving || loading ? "#a8c6d9" : saveAcknowledged ? "#a7d3bf" : "#a5b8c8"
    readonly property string statusMessage: archiveEditor.status === "saved" && !saveAcknowledged ? "当前已保存版本 · REV " + archiveEditor.revision : archiveEditor.statusText
    readonly property var bookChoices: [{key: "", label: "全部世界书"}].concat((archiveEditor.bookRows || []).map(row => ({
        key: row.key,
        label: (row.name || "未命名世界书") + " · " + row.entryCount + " 条" + (row.newLocal ? " · 本地新建" : "")
    })))
    readonly property var entryChoices: (archiveEditor.hasBook ? [{key: "", label: "书设置 / 不选择条目"}] : []).concat((archiveEditor.entryRows || []).map(row => ({
        key: row.key,
        label: (row.comment || row.name || "未命名条目") + (row.enabled ? "" : " · 停用") + (row.alwaysActive ? " · 常驻" : "") + (row.newLocal ? " · 本地新建" : "")
    })))
    signal requestClose

    // Focus remains owned by Qt and SceneNavigation. These observations only
    // expose the focused control; they never select a new focus target.
    readonly property var focusWindow: Window.window
    readonly property Item focusedControl: focusControl(focusWindow ? focusWindow.activeFocusItem : null)
    readonly property string focusContentKey: JSON.stringify([personaScope, archiveEditor.archiveScope,
        archiveEditor.selectedBookKey, archiveEditor.selectedEntryKey])
    readonly property int focusNavigationRevision: navigation ? navigation.transitionRevision : 0
    property int focusVisibilityRevision: 0
    property bool editorContextChanging: false
    readonly property int focusRuntimeRevision: session.connectionGeneration
    property var paletteFocusRestore: null
    property bool paletteFocusSuspended: false
    property var pendingFocusRestore: null
    property bool focusRestoreQueued: false
    property bool revealingFocus: false
    property bool focusLayoutDirty: false
    property var focusRevealIntent: null
    property bool navigationFocusBlocked: false
    property int navigationFocusRevision: -1
    property var focusCausalEvents: []
    property bool focusCausalOverflow: false
    property bool focusCausalEnabled: false
    property bool bodyUserChange: false
    property bool primaryPatternUserChange: false
    property bool secondaryPatternUserChange: false
    readonly property bool regexMode: archiveEditor.useRegex
    readonly property string primaryPatternValue: String(archiveEditor.keywords || "")
    readonly property string secondaryPatternValue: String(archiveEditor.secondaryKeywords || "")
    readonly property string bodyContentValue: String(archiveEditor.content || "")

    // Insertion placement is one keyboard editing group, including on macOS
    // when the default Tab chain admits text fields but skips closed combos.
    // Its outside neighbors still come from Qt's current system-policy chain.
    readonly property bool insertionNavigationEnabled: Qt.styleHints.tabFocusBehavior !== Qt.NoTabFocus
        && insertionPositionField.visible && insertionPositionField.enabled
        && insertionDepthField.visible && insertionDepthField.enabled && insertionDepthField.contentItem !== null
        && insertionRoleField.visible && insertionRoleField.enabled
    readonly property var insertionBeforeCandidates: [titleField, commentField, keywordsField, regexKeywordsField,
        orderField.contentItem, priorityField.contentItem, entryScanInheritCheck, entryScanDepthField.contentItem,
        entryBudgetInheritCheck, entryBudgetField.contentItem]
    readonly property var insertionAfterCandidates: [secondaryKeywordsField, regexSecondaryKeywordsField,
        selectiveLogicField, caseSensitiveCheck, useRegexCheck, adoptRulesButton, bodyField]
    readonly property var insertionBoundaryInputs: ({policy: Qt.styleHints.tabFocusBehavior,
        primaryReadOnly: keywordsField.readOnly, regexPrimaryReadOnly: regexKeywordsField.readOnly,
        secondaryReadOnly: secondaryKeywordsField.readOnly, regexSecondaryReadOnly: regexSecondaryKeywordsField.readOnly})
    readonly property Item insertionBeforeItem: insertionNavigationEnabled ? insertionBoundary(false, insertionBoundaryInputs) : null
    readonly property Item insertionAfterItem: insertionNavigationEnabled ? insertionBoundary(true, insertionBoundaryInputs) : null
    function insertionBoundary(forward, inputs) {
        // Qt decides which readonly/text/list controls this policy admits.
        // The inputs object makes changes of actual readonly state re-run
        // that query without applying a second, stricter type filter here.
        if (inputs.policy === Qt.NoTabFocus) return null;
        const candidates = forward ? insertionAfterCandidates : insertionBeforeCandidates;
        const eligible = candidates.filter(candidate => candidate && candidate.visible && candidate.enabled
            && candidate.activeFocusOnTab);
        const anchor = forward ? insertionRoleField : insertionPositionField;
        const next = anchor.nextItemInFocusChain(forward);
        return eligible.includes(next) ? next : null;
    }
    // Persistent explicit bindings clear a former boundary when it changes.
    // This avoids retaining KeyNavigation's implicit reciprocal on an old
    // neighbor. Only the direction entering this group is changed.
    Repeater {
        model: editor.insertionBeforeCandidates
        delegate: Item {
            id: insertionBeforeBinding
            required property var modelData
            visible: false
            Binding {
                target: insertionBeforeBinding.modelData ? insertionBeforeBinding.modelData.KeyNavigation : null
                property: "tab"
                value: editor.insertionBeforeItem === insertionBeforeBinding.modelData ? insertionPositionField : null
            }
            Binding {
                target: insertionBeforeBinding.modelData ? insertionBeforeBinding.modelData.KeyNavigation : null
                property: "priority"
                value: editor.insertionBeforeItem === insertionBeforeBinding.modelData ? KeyNavigation.BeforeItem : KeyNavigation.AfterItem
            }
        }
    }
    Repeater {
        model: editor.insertionAfterCandidates
        delegate: Item {
            id: insertionAfterBinding
            required property var modelData
            visible: false
            Binding {
                target: insertionAfterBinding.modelData ? insertionAfterBinding.modelData.KeyNavigation : null
                property: "backtab"
                value: editor.insertionAfterItem === insertionAfterBinding.modelData ? insertionRoleField : null
            }
            Binding {
                target: insertionAfterBinding.modelData ? insertionAfterBinding.modelData.KeyNavigation : null
                property: "priority"
                value: editor.insertionAfterItem === insertionAfterBinding.modelData ? KeyNavigation.BeforeItem : KeyNavigation.AfterItem
            }
        }
    }
    Binding {
        target: insertionDepthField.contentItem ? insertionDepthField.contentItem.KeyNavigation : null
        property: "tab"
        value: editor.insertionNavigationEnabled ? insertionRoleField : null
    }
    Binding {
        target: insertionDepthField.contentItem ? insertionDepthField.contentItem.KeyNavigation : null
        property: "backtab"
        value: editor.insertionNavigationEnabled ? insertionPositionField : null
    }
    Binding {
        target: insertionDepthField.contentItem ? insertionDepthField.contentItem.KeyNavigation : null
        property: "priority"
        value: KeyNavigation.BeforeItem
    }

    // Diagnostics only. Observers reset immediately before one action and read
    // the first bounded record before asserting; product behavior never reads it.
    function beginFocusObservation() {
        focusCausalEvents = [];
        focusCausalOverflow = false;
        focusCausalEnabled = true;
        traceFocus("observation-start", {held: windowInput ? windowInput.held : false,
            pointerActive: pointerActivity ? pointerActivity.active : false,
            visibilityRevision: focusVisibilityRevision, runtimeRevision: focusRuntimeRevision,
            navigationRevision: focusNavigationRevision});
    }
    function focusCausalSnapshot() {
        return {schema: "archive-focus-causal.v1", events: focusCausalEvents.slice(), overflow: focusCausalOverflow};
    }
    function traceFocus(kind, fields) {
        if (!focusCausalEnabled)
            return;
        if (focusCausalEvents.length >= 32) {
            focusCausalOverflow = true;
            return;
        }
        const event = {sequence: focusCausalEvents.length, kind: kind};
        for (const key of Object.keys(fields || {}))
            event[key] = fields[key];
        focusCausalEvents.push(event);
    }
    function textSelectionObservation(kind, field, viewport) {
        if (!field || !viewport || !formScroll)
            return;
        traceFocus(kind, {cursor: field.cursorPosition, selectionStart: field.selectionStart,
            selectionEnd: field.selectionEnd, innerY: viewport.contentItem ? viewport.contentItem.contentY : null,
            outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null, active: field.activeFocus});
    }
    function selectionObservation(kind) { textSelectionObservation(kind, bodyField, bodyScroll); }
    function textViewport(owner) {
        return owner === bodyField ? bodyScroll : owner === regexKeywordsField ? regexKeywordsScroll
            : owner === regexSecondaryKeywordsField ? regexSecondaryKeywordsScroll : null;
    }
    function movePatternFocus(field, backwards) {
        const next = field.nextItemInFocusChain(!backwards);
        if (next && next !== field)
            next.forceActiveFocus(backwards ? Qt.BacktabFocusReason : Qt.TabFocusReason);
    }
    function clearPatternSelections() {
        if (regexKeywordsField) regexKeywordsField.deselect();
        if (regexSecondaryKeywordsField) regexSecondaryKeywordsField.deselect();
    }
    function belongsTo(item, ancestor) {
        for (let current = item; current; current = current.parent)
            if (current === ancestor)
                return true;
        return false;
    }
    function focusControl(item) {
        if (!belongsTo(item, editor))
            return null;
        // SpinBox's anonymous TextInput has no focusReason. Its real Control
        // owns the reason; unknown must never be inferred to mean Tab.
        for (let current = item; current && current !== editor; current = current.parent)
            if (current.focusReason !== undefined && current.focusPolicy !== undefined)
                return current;
        return null;
    }
    function cancelFocusIntent(kind) {
        focusRevealIntent = null;
        pendingFocusRestore = null;
        traceFocus(kind || "intent-cancelled", {held: windowInput ? windowInput.held : false,
            pointerActive: pointerActivity ? pointerActivity.active : false});
    }
    // Stable diagnostics identify the exact first failed visibility guard;
    // evaluating these helpers never restores focus or moves either scroller.
    function focusVisibilityRejectCode(item) {
        if (!focusWindow) return 1;
        if (!item || focusWindow.activeFocusItem !== item) return 2;
        if (!visible) return 3;
        if (!enabled) return 4;
        if (editorContextChanging || archiveEditor.focusContextChanging) return 17;
        if (modalOpen) return 5;
        if (windowInput.held) return 6;
        if (pointerActivity.active) return 7;
        if (navigationFocusBlocked) return 8;
        if (navigation && navigation.paletteOpen) return 9;
        if (navigation && navigation.currentFeature !== "memory") return 10;
        if (navigation && navigation.currentSubentry !== "worldbook") return 11;
        if (bookSelector.popup.visible || entrySelector.popup.visible || selectiveLogicField.popup.visible || insertionPositionField.popup.visible || insertionRoleField.popup.visible)
            return 12;
        for (let current = item; current; current = current.parent) {
            if (!current.visible) return 13;
            if (!current.enabled) return 14;
            if (current.opacity <= 0) return 15;
            if (current === editor)
                return 0;
        }
        return 16;
    }
    function focusVisibilityAllowed(item) {
        return focusVisibilityRejectCode(item) === 0;
    }
    function focusGuardSnapshot(target) {
        const item = target || (focusWindow ? focusWindow.activeFocusItem : null);
        const owner = focusControl(item);
        return {rejectCode: focusVisibilityRejectCode(item), hasWindow: !!focusWindow,
            hasItem: !!item, currentFocus: !!focusWindow && focusWindow.activeFocusItem === item,
            hasOwner: !!owner, ownerReason: owner ? Number(owner.focusReason) : null,
            visible: visible, enabled: enabled, navigationBlocked: navigationFocusBlocked,
            navigationRevision: focusNavigationRevision, blockedRevision: navigationFocusRevision,
            runtimeRevision: focusRuntimeRevision, visibilityRevision: focusVisibilityRevision,
            editorContextChanging: editorContextChanging || archiveEditor.focusContextChanging,
            editorContextRevision: archiveEditor.focusContextRevision,
            palette: !!navigation && navigation.paletteOpen, modal: modalOpen,
            popup: bookSelector.popup.visible || entrySelector.popup.visible || selectiveLogicField.popup.visible || insertionPositionField.popup.visible || insertionRoleField.popup.visible,
            held: windowInput.held, pointerActive: pointerActivity.active,
            hasIntent: !!focusRevealIntent, intentValid: !!focusRevealIntent && !!focusIntentValid(focusRevealIntent),
            outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null,
            viewportHeight: formScroll.contentItem ? formScroll.contentItem.height : null};
    }
    function focusIntentValid(intent) {
        return intent && intent.item === (focusWindow ? focusWindow.activeFocusItem : null)
            && intent.owner === focusControl(intent.item) && intent.window === focusWindow
            && intent.content === focusContentKey && intent.navigationRevision === focusNavigationRevision
            && intent.visibilityRevision === focusVisibilityRevision && intent.runtimeRevision === focusRuntimeRevision
            && intent.editorContextRevision === archiveEditor.focusContextRevision
            && focusVisibilityAllowed(intent.item);
    }
    function makeFocusIntent(item) {
        return {item: item, owner: focusControl(item), window: focusWindow, content: focusContentKey,
            navigationRevision: focusNavigationRevision, visibilityRevision: focusVisibilityRevision,
            runtimeRevision: focusRuntimeRevision, editorContextRevision: archiveEditor.focusContextRevision};
    }
    function polishFocusLayouts() {
        // Only public QQuickItem API, outside-in. Every layout owning form
        // geometry is explicit; nested grid columns are polished after grids.
        const layouts = [formLayout, formScroll, formContent, primaryGrid, bookSettingsGrid,
            entrySettingsGrid, insertionSettingsGrid, triggerGrid, matchingOptionsRow, ruleConflictArea, detailsLayout, bodyScroll, bodyField,
            regexKeywordsScroll, regexKeywordsField, regexSecondaryKeywordsScroll, regexSecondaryKeywordsField];
        for (const layout of layouts) {
            layout.ensurePolished();
            if ([primaryGrid, bookSettingsGrid, entrySettingsGrid, insertionSettingsGrid, triggerGrid].includes(layout))
                for (const column of layout.children)
                    column.ensurePolished();
        }
    }
    function intersectRect(a, b) {
        const left = Math.max(a.x, b.x), top = Math.max(a.y, b.y);
        return Qt.rect(left, top, Math.max(0, Math.min(a.x + a.width, b.x + b.width) - left),
            Math.max(0, Math.min(a.y + a.height, b.y + b.height) - top));
    }
    function effectiveFormViewport(flick) {
        const root = focusWindow.contentItem;
        let rect = flick.mapToItem(root, 0, 0, flick.width, flick.height);
        rect = intersectRect(rect, Qt.rect(0, 0, root.width, root.height));
        for (let parent = flick.parent; parent; parent = parent.parent)
            if (parent.clip)
                rect = intersectRect(rect, parent.mapToItem(root, 0, 0, parent.width, parent.height));
        return flick.mapFromItem(root, rect.x, rect.y, rect.width, rect.height);
    }
    function focusLayoutSignature(intent) {
        const flick = formScroll.contentItem;
        const owner = textViewport(intent.owner) || intent.owner;
        if (!flick || !owner)
            return [];
        const rect = owner.mapToItem(flick, 0, 0, owner.width, owner.height);
        return [editor.width, editor.height, flick.width, flick.height, flick.contentHeight,
            formContent.width, formContent.height, rect.x, rect.y, rect.width, rect.height];
    }
    function revealFocusControl(item, retainIntent) {
        const owner = focusControl(item);
        if (!owner || !focusVisibilityAllowed(item) || !belongsTo(owner, formScroll))
            return;
        const intent = retainIntent && focusRevealIntent ? focusRevealIntent : makeFocusIntent(item);
        if (revealingFocus) {
            focusLayoutDirty = true;
            return;
        }
        revealingFocus = true;
        let stable = false;
        try {
            for (let pass = 0; pass < 4; ++pass) {
                focusLayoutDirty = false;
                traceFocus("layout-before", {pass: pass, viewportHeight: formScroll.contentItem.height,
                    contentHeight: formScroll.contentItem.contentHeight, outerY: formScroll.contentItem.contentY});
                polishFocusLayouts();
                if (!focusIntentValid(intent)) {
                    traceFocus("layout-invalidated", {pass: pass});
                    break;
                }
                const flick = formScroll.contentItem;
                const view = effectiveFormViewport(flick);
                const viewport = textViewport(owner);
                const target = viewport || owner;
                let rect = target.mapToItem(flick, 0, 0, target.width, target.height);
                if (viewport && rect.height > view.height) {
                    // The native inner TextArea keeps its caret visible. For a
                    // body taller than the outer clip, expose the actual caret
                    // without touching native cursor, selection or inner scroll.
                    const cursor = owner.cursorRectangle;
                    rect = owner.mapToItem(flick, cursor.x, cursor.y, cursor.width, cursor.height);
                }
                const before = focusLayoutSignature(intent);
                let delta = 0;
                if (view.width > 0 && view.height > 0 && rect.width > 0 && rect.height > 0) {
                    if (rect.y < view.y)
                        delta = rect.y - view.y;
                    else if (rect.y + rect.height > view.y + view.height)
                        delta = rect.y + rect.height - view.y - view.height;
                }
                const minimum = Number.isFinite(flick.originY) ? flick.originY : 0;
                const maximum = minimum + Math.max(0, flick.contentHeight - flick.height);
                const oldY = flick.contentY;
                if (Number.isFinite(delta) && delta !== 0 && focusIntentValid(intent))
                    flick.contentY = Math.max(minimum, Math.min(maximum, oldY + delta));
                traceFocus("layout-after", {pass: pass, viewportHeight: flick.height,
                    contentHeight: flick.contentHeight, beforeY: oldY, outerY: flick.contentY,
                    viewY: view.y, viewHeight: view.height, targetY: rect.y, targetHeight: rect.height,
                    held: windowInput.held});
                const after = focusLayoutSignature(intent);
                // contentY changes the mapped target coordinate deliberately.
                // Layout dimensions, not that translation, establish stability.
                stable = !focusLayoutDirty && before.every((value, index) => index === 8 || value === after[index]);
                if (stable)
                    break;
            }
            if (!stable)
                traceFocus("layout-unstable", {passes: 4});
        } finally {
            revealingFocus = false;
        }
    }
    function observeKeyboardFocus() {
        const item = focusWindow ? focusWindow.activeFocusItem : null;
        const owner = focusControl(item);
        if (!owner || (owner.focusReason !== Qt.TabFocusReason && owner.focusReason !== Qt.BacktabFocusReason))
            return;
        const rejection = focusVisibilityRejectCode(item);
        if (rejection !== 0) {
            traceFocus("keyboard-focus-rejected", {rejectCode: rejection,
                navigationBlocked: navigationFocusBlocked, navigationRevision: focusNavigationRevision,
                held: windowInput.held, pointerActive: pointerActivity.active});
            return;
        }
        focusRevealIntent = makeFocusIntent(item);
        revealFocusControl(item, true);
    }
    function observeFocusGeometry() {
        if (revealingFocus) {
            focusLayoutDirty = true;
            return;
        }
        if (focusIntentValid(focusRevealIntent))
            revealFocusControl(focusRevealIntent.item, true);
    }
    function beginNavigationFocus(revision, resetTop) {
        navigationFocusRevision = revision;
        navigationFocusBlocked = true;
        cancelFocusIntent("navigation-begin");
        if (resetTop)
            showFormStart();
    }
    function finishNavigationFocus(revision) {
        if (navigationFocusRevision !== revision || !navigationFocusBlocked)
            return;
        navigationFocusBlocked = false;
        traceFocus("navigation-finish", {revision: revision, outerY: formScroll.contentItem.contentY});
    }
    function focusRestoreSnapshot(item) {
        if (!item || !focusControl(item) || !visible || !enabled
                || editorContextChanging || archiveEditor.focusContextChanging)
            return null;
        return {item: item, owner: focusControl(item), window: focusWindow, content: focusContentKey,
            navigationRevision: focusNavigationRevision, visibilityRevision: focusVisibilityRevision,
            runtimeRevision: focusRuntimeRevision, editorContextRevision: archiveEditor.focusContextRevision};
    }
    function focusRestoreRejectCode(item, source, snapshot) {
        if (!["palette", "dialog"].includes(source)) return 1;
        if (!snapshot || !snapshot.owner) return 2;
        if (editorContextChanging || archiveEditor.focusContextChanging) return 3;
        if (snapshot.editorContextRevision !== archiveEditor.focusContextRevision) return 4;
        if (focusControl(item) !== snapshot.owner) return 5;
        if (snapshot.window !== focusWindow) return 6;
        if (snapshot.content !== focusContentKey) return 7;
        if (snapshot.visibilityRevision !== focusVisibilityRevision) return 8;
        if (snapshot.runtimeRevision !== focusRuntimeRevision) return 9;
        if (source === "dialog" && snapshot.navigationRevision !== focusNavigationRevision) return 10;
        return 0;
    }
    function revealRestoredFocus(item, source, snapshot) {
        const rejection = focusRestoreRejectCode(item, source, snapshot);
        traceFocus("restore-context-check", {rejectCode: rejection, palette: source === "palette",
            editorContextRevision: archiveEditor.focusContextRevision,
            expectedContextRevision: snapshot && typeof snapshot.editorContextRevision === "number"
                ? snapshot.editorContextRevision : null,
            outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null});
        if (rejection !== 0)
            return;
        revealFocusControl(item);
    }
    function queueDialogFocusRestore(snapshot) {
        if (!snapshot) {
            traceFocus("restore-queue-rejected", {rejectCode: 1});
            return;
        }
        const current = focusWindow ? focusWindow.activeFocusItem : null;
        pendingFocusRestore = {snapshot: snapshot, returned: focusControl(current) === snapshot.owner,
            outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null};
        traceFocus("restore-queued", {returned: pendingFocusRestore.returned,
            alreadyQueued: focusRestoreQueued, outerY: pendingFocusRestore.outerY,
            editorContextRevision: archiveEditor.focusContextRevision,
            expectedContextRevision: typeof snapshot.editorContextRevision === "number"
                ? snapshot.editorContextRevision : null});
        if (!focusRestoreQueued) {
            focusRestoreQueued = true;
            Qt.callLater(flushFocusRestore);
        }
    }
    function flushFocusRestore() {
        focusRestoreQueued = false;
        const pending = pendingFocusRestore;
        pendingFocusRestore = null;
        traceFocus("restore-flush", {hasPending: !!pending, returned: !!pending && pending.returned,
            outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null,
            expectedOuterY: pending ? pending.outerY : null,
            rejectCode: !pending ? 1 : !pending.returned ? 2 : !formScroll.contentItem ? 3
                : formScroll.contentItem.contentY !== pending.outerY ? 4 : 0});
        if (pending && pending.returned && formScroll.contentItem
                && formScroll.contentItem.contentY === pending.outerY)
            revealRestoredFocus(focusWindow ? focusWindow.activeFocusItem : null, "dialog", pending.snapshot);
    }
    function observeWindowFocus() {
        focusRevealIntent = null;
        selectionObservation("window-focus");
        if (pendingFocusRestore) {
            const item = focusWindow ? focusWindow.activeFocusItem : null;
            const owner = focusControl(item);
            if (owner === pendingFocusRestore.snapshot.owner) {
                pendingFocusRestore.returned = true;
            } else if (pendingFocusRestore.returned || item) {
                // After Qt returns focus, any blur invalidates the callback,
                // even if the user subsequently comes back to the same field.
                pendingFocusRestore = null;
            }
        }
        observeKeyboardFocus();
    }
    function invalidateFocusVisibility() {
        ++focusVisibilityRevision;
        cancelFocusIntent("visibility-invalidated");
        paletteFocusRestore = null;
        paletteFocusSuspended = false;
        pendingFocusRestore = null;
    }
    onFocusContentKeyChanged: {
        if (!editorContextChanging) invalidateFocusVisibility();
        if (bodyField && !editorContextChanging) {
            bodyField.deselect();
            selectionObservation("selection-context-reset");
            clearPatternSelections();
        }
    }
    onRegexModeChanged: { invalidateFocusVisibility(); clearPatternSelections(); }
    onPrimaryPatternValueChanged: if (regexKeywordsField && !primaryPatternUserChange) regexKeywordsField.deselect();
    onSecondaryPatternValueChanged: if (regexSecondaryKeywordsField && !secondaryPatternUserChange) regexSecondaryKeywordsField.deselect();
    onBodyContentValueChanged: if (bodyField && !bodyUserChange) {
        bodyField.deselect();
        selectionObservation("selection-content-reset");
    }
    onFocusNavigationRevisionChanged: cancelFocusIntent("navigation-revision")
    onFocusRuntimeRevisionChanged: invalidateFocusVisibility()
    onFocusWindowChanged: invalidateFocusVisibility()
    onModalOpenChanged: if (modalOpen) cancelFocusIntent("modal-open")
    onWidthChanged: observeFocusGeometry()
    onHeightChanged: observeFocusGeometry()
    onVisibleChanged: invalidateFocusVisibility()
    onEnabledChanged: if (!paletteFocusSuspended) invalidateFocusVisibility()
    Connections {
        target: editor.focusWindow
        function onActiveFocusItemChanged() { editor.observeWindowFocus(); }
    }
    Connections {
        target: editor.focusedControl
        function onFocusReasonChanged() { editor.observeKeyboardFocus(); }
    }
    Connections {
        target: editor.navigation || null
        ignoreUnknownSignals: true
        function onFocusSuspended(item, source) {
            if (source !== "palette")
                return;
            // Navigation emits before the palette disables ScenePortal's body.
            editor.paletteFocusRestore = editor.focusRestoreSnapshot(item);
            editor.paletteFocusSuspended = editor.paletteFocusRestore !== null;
        }
        function onFocusRestored(item, source) {
            editor.revealRestoredFocus(item, source, editor.paletteFocusRestore);
            editor.paletteFocusRestore = null;
            editor.paletteFocusSuspended = false;
        }
        function onFocusRestorationCancelled(source) {
            if (source === "palette")
                editor.invalidateFocusVisibility();
        }
        function onFocusDiagnostic(kind, fields) { editor.traceFocus(kind, fields); }
        function onCurrentFeatureChanged() { editor.invalidateFocusVisibility(); }
        function onCurrentSubentryChanged() { editor.invalidateFocusVisibility(); }
    }
    WindowInputState {
        id: windowInput
        objectName: "archiveWindowInputState"
        window: editor.focusWindow
        onInteractionObserved: kind => {
            editor.cancelFocusIntent("input-observed");
            editor.traceFocus("input-state", {inputKind: kind, buttons: mouseButtons,
                touches: touchCount, held: held, revision: revision});
        }
    }
    Connections {
        target: bookSelector.popup
        function onVisibleChanged() { if (bookSelector.popup.visible) editor.cancelFocusIntent("selector-popup"); }
    }
    Connections {
        target: entrySelector.popup
        function onVisibleChanged() { if (entrySelector.popup.visible) editor.cancelFocusIntent("selector-popup"); }
    }
    Connections {
        target: selectiveLogicField.popup
        function onVisibleChanged() { if (selectiveLogicField.popup.visible) editor.cancelFocusIntent("selector-popup"); }
    }
    Connections {
        target: insertionPositionField.popup
        function onVisibleChanged() { if (insertionPositionField.popup.visible) editor.cancelFocusIntent("selector-popup"); }
    }
    Connections {
        target: insertionRoleField.popup
        function onVisibleChanged() { if (insertionRoleField.popup.visible) editor.cancelFocusIntent("selector-popup"); }
    }
    Connections {
        target: formScroll.contentItem
        function onWidthChanged() { editor.observeFocusGeometry(); }
        function onHeightChanged() { editor.observeFocusGeometry(); }
        function onContentHeightChanged() { editor.observeFocusGeometry(); }
    }
    // Passive observation does not take the pointer grab from a field,
    // scrollbar, popup or drawer drag gesture.
    PointHandler {
        id: pointerActivity
        acceptedButtons: Qt.AllButtons
        grabPermissions: PointerHandler.TakeOverForbidden
        onActiveChanged: if (active) editor.cancelFocusIntent("pointer-active")
    }

    function rememberFocus(item) {
        if (navigation && typeof navigation.rememberFeatureFocus === "function")
            navigation.rememberFeatureFocus("memory", item);
    }
    function selectedIndex(rows, key) {
        for (let i = 0; i < rows.length; ++i)
            if (rows[i].key === key)
                return i;
        return -1;
    }
    function syncSelectors() {
        if (!bookSelector || !entrySelector || !selectiveLogicField)
            return;
        bookSelector.currentIndex = selectedIndex(bookChoices, archiveEditor.selectedBookKey);
        entrySelector.currentIndex = selectedIndex(entryChoices, archiveEditor.selectedEntryKey);
        selectiveLogicField.currentIndex = selectedIndex(selectiveLogicChoices, archiveEditor.selectiveLogic);
        insertionPositionField.currentIndex = selectedIndex(insertionPositionChoices, archiveEditor.insertionPosition);
        insertionRoleField.currentIndex = selectedIndex(insertionRoleChoices, archiveEditor.insertionRole);
    }
    function syncDialogs() {
        if (!navigationConfirm || !deleteConfirm)
            return;
        // A prompt belongs to the controller's current persona and intent.
        const sameScope = archiveEditor.archiveScope === personaScope;
        if (sameScope && navigationPrompt.action)
            navigationConfirm.open();
        else
            navigationConfirm.close();
        if (sameScope && deletePrompt.kind)
            deleteConfirm.open();
        else
            deleteConfirm.close();
    }
    function worldbookImportSummary() {
        const state = worldbookFileState;
        const skipped = state.skipped || ({});
        const reasons = {invalid: "无效条目", empty: "空正文", unsafe: "不安全内容", oversized: "超出条目上限"};
        let skippedCount = 0;
        const skippedText = [];
        for (const key of Object.keys(reasons)) {
            const count = Number(skipped[key] || 0);
            skippedCount += count;
            if (count > 0) skippedText.push(reasons[key] + " " + count + " 条");
        }
        const dropped = state.dropped_fields || ({});
        const droppedText = Object.keys(dropped).sort().map(key => key + "（" + dropped[key] + " 条）");
        return "《" + (state.book_name || "") + "》\n将导入 " + Number(state.importable_entry_count || 0) + " 条"
            + "\n跳过 " + skippedCount + " 条" + (skippedText.length ? "（" + skippedText.join("、") + "）" : "")
            + "\n未保留的设置：" + (droppedText.length ? droppedText.join("、") : "无")
            + "\n" + Number(state.disabled_regex_entry_count || 0) + " 条正则已关闭"
            + "\n" + Number(state.cleaned_entry_count || 0) + " 条文字被清理。";
    }
    function syncWorldbookFile() {
        const state = worldbookFileState;
        const sameScope = state.scopeKey === personaScope && state.generation === focusRuntimeRevision;
        if (worldbookOpenDialog.visible && (worldbookOpenDialog.boundScope !== personaScope
                || worldbookOpenDialog.boundGeneration !== focusRuntimeRevision))
            worldbookOpenDialog.close();
        if (worldbookSaveDialog.visible && (worldbookSaveDialog.boundScope !== personaScope
                || worldbookSaveDialog.boundGeneration !== focusRuntimeRevision))
            worldbookSaveDialog.close();
        if (state.status === "confirmation" && sameScope)
            worldbookImportConfirm.open();
        else
            worldbookImportConfirm.close();
        if (!sameScope) {
            worldbookReadbackTimer.stop();
            worldbookReadbackRequest = "";
            return;
        }
        if (state.status !== "imported") {
            worldbookReadbackTimer.stop();
            worldbookReadbackRequest = "";
            return;
        }
        if (archiveEditor.dirty) {
            session.acknowledgeWorldbookFileImportReadback(state.world_book_id || "", archiveEditor.revision, false);
            return;
        }
        if (worldbookReadbackRequest !== state.requestId) {
            worldbookReadbackRequest = state.requestId;
            worldbookReadbackTimer.restart();
            archiveEditor.load();
            return;
        }
        if (archiveEditor.busy)
            return;
        let selected = false;
        if (archiveEditor.initialized && !archiveEditor.dirty && archiveEditor.archiveScope === personaScope
                && archiveEditor.revision === state.revision) {
            const row = (archiveEditor.bookRows || []).find(value => value.id === state.world_book_id);
            if (row) {
                archiveEditor.selectBook(row.key);
                archiveEditor.selectEntry("");
                selected = archiveEditor.selectedBookKey === row.key && !archiveEditor.hasEntry;
            }
        }
        session.acknowledgeWorldbookFileImportReadback(state.world_book_id || "", archiveEditor.revision, selected);
    }
    function requestReload() {
        if (archiveEditor.busy)
            return;
        if (archiveEditor.dirty)
            reloadConfirm.open();
        else
            archiveEditor.reloadDiscardingDraft();
    }
    // A drawer entered from closed starts at the top of the form. The opening
    // transition grows the viewport, and each taller viewport clamps contentY
    // against content not yet relaid, so a kept offset would land wherever
    // the frames happened to fall.
    function showFormStart() {
        invalidateFocusVisibility();
        if (formScroll.contentItem) {
            traceFocus("form-reset-before", {outerY: formScroll.contentItem.contentY});
            formScroll.contentItem.contentY = 0;
            traceFocus("form-reset-after", {outerY: formScroll.contentItem.contentY});
        }
    }
    function focusFirstField() {
        if (visible && enabled && firstFocusItem)
            firstFocusItem.forceActiveFocus(Qt.TabFocusReason);
    }
    function observeSaveStatus() {
        if (archiveEditor.status === "saved" && archiveEditor.revision !== lastSavedRevision) {
            lastSavedRevision = archiveEditor.revision;
            saveAcknowledged = true;
            successHold.restart();
        } else if (archiveEditor.status !== "saved") {
            saveAcknowledged = false;
            successHold.stop();
        }
    }
    function fieldLabel(key) {
        const labels = {
            scanDepth: "扫描深度", tokenBudget: "Token 预算", recursiveScanning: "递归扫描",
            recursive: "递归扫描", keywordsSecondary: "次要关键词", secondaryKeywords: "次要关键词",
            selective: "选择性触发", selectiveLogic: "关键词逻辑", caseSensitive: "区分大小写",
            matchWholeWords: "完整词匹配", priority: "优先级", position: "插入位置", depth: "插入深度",
            role: "消息角色", probability: "触发概率", useProbability: "启用概率",
            cooldown: "冷却", delay: "延迟", sticky: "持续轮数", excludeRecursion: "排除递归",
            preventRecursion: "阻止递归", vectorized: "向量匹配", extensions: "扩展元数据"
        };
        return labels[key] || key;
    }
    function bookSettingReadonlyText(key, range) {
        const state = bookSettingStates[key] || ({});
        return state.confirmed
            ? "原值 " + state.text + "。超出本界面 " + range + " 的编辑范围，当前只读；编辑其余字段时会保留此值。"
            : (key === "scanDepth" ? "扫描深度" : "书级预算") + "未确认，请重新读取档案；不会使用默认值覆盖。";
    }
    function entryInheritText(key) {
        const state = entrySettingStates[key] || ({});
        if (state.bookText)
            return "跟随本书（本书 " + state.bookText + "）";
        return state.inherited ? "跟随本书；本书的值未确认或超出编辑范围，暂不能单独设置" : "跟随本书";
    }
    function entrySettingReadonlyText(key, range) {
        const state = entrySettingStates[key] || ({});
        return state.confirmed
            ? "原值 " + state.text + "。超出本界面 " + range + " 的编辑范围，当前只读；编辑其余字段时会保留此值。"
            : (key === "scanDepth" ? "条目扫描深度" : "条目 Token 预算") + "未确认，请重新读取档案；不会使用默认值覆盖。";
    }
    function insertionDefaultText(key) {
        const state = insertionStates[key] || ({});
        return state.confirmed && !state.present ? "未提供，按默认：" + state.text : "";
    }
    function insertionExplanation() {
        if (archiveEditor.insertionPosition !== "at_depth")
            return "命中的条目会放在系统提示的这一段世界设定里。";
        const depth = insertionStates.depth?.confirmed ? String(archiveEditor.insertionDepth) : "未确认";
        let text = "放在对话记录中，之后还有 " + depth + " 条历史消息；历史不足 " + depth + " 条时放在最前。你本轮的消息（以及启用时的卡作者历史后指令）始终在它之后。插入的内容只用于这一次回复，不会保存进聊天记录。";
        if (archiveEditor.insertionRole === "user") text += "这段内容会以你的身份出现。";
        if (archiveEditor.insertionRole === "assistant") text += "这段内容会被当作角色自己说过的话。";
        return text;
    }
    function fieldValue(value) {
        if (value === true)
            return "是";
        if (value === false)
            return "否";
        if (value === null || value === undefined)
            return "未提供";
        return typeof value === "object" ? JSON.stringify(value) : String(value);
    }
    function advancedFieldValue(key, value) {
        const translated = key === "position" ? {before_char: "角色设定前", after_char: "角色设定后"}
            : key === "role" ? {system: "系统", user: "用户", assistant: "助手"} : ({});
        return translated[value] ? String(value) + "（" + translated[value] + "）" : fieldValue(value);
    }
    function regexDiagnosticText() {
        const report = archiveEditor.regexDiagnostics || ({});
        // The model text already includes every selected/global message and
        // truncation notice; append only the separate saved-version note.
        const parts = [report.text || "运行诊断暂不可用"];
        if (report.dirtyNote) parts.push(report.dirtyNote);
        return parts.join("\n");
    }
    onBookChoicesChanged: Qt.callLater(syncSelectors)
    onEntryChoicesChanged: Qt.callLater(syncSelectors)
    onPersonaScopeChanged: {
        invalidateFocusVisibility();
        if (reloadConfirm) reloadConfirm.close();
        if (navigationConfirm) navigationConfirm.close();
        if (deleteConfirm) deleteConfirm.close();
        saveAcknowledged = false;
        lastSavedRevision = -1;
        if (successHold) successHold.stop();
    }
    Component.onCompleted: {
        observeSaveStatus();
        syncSelectors();
        syncDialogs();
        syncWorldbookFile();
    }
    Connections {
        target: archiveEditor
        function onFocusContextChanged() {
            if (archiveEditor.focusContextChanging) {
                editor.editorContextChanging = true;
                editor.invalidateFocusVisibility();
                if (bodyField) bodyField.deselect();
                editor.clearPatternSelections();
                editor.traceFocus("editor-context-begin", {revision: archiveEditor.focusContextRevision,
                    outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null});
                return;
            }
            if (!editor.editorContextChanging) return;
            // Shared changed bindings have all been published. Finish their
            // synchronous layout while native focus migration is still barred
            // from creating a new keyboard-reveal intent. Position is not reset.
            editor.traceFocus("editor-context-publish", {revision: archiveEditor.focusContextRevision,
                outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null});
            try {
                editor.polishFocusLayouts();
            } finally {
                editor.editorContextChanging = false;
                editor.traceFocus("editor-context-finish", {revision: archiveEditor.focusContextRevision,
                    outerY: formScroll.contentItem ? formScroll.contentItem.contentY : null});
            }
        }
        function onChanged() {
            editor.observeSaveStatus();
            Qt.callLater(editor.syncSelectors);
            Qt.callLater(editor.syncDialogs);
            Qt.callLater(editor.syncWorldbookFile);
        }
    }
    Connections {
        target: session
        ignoreUnknownSignals: true
        function onChanged() { Qt.callLater(editor.syncWorldbookFile); }
    }
    Timer {
        id: worldbookReadbackTimer
        interval: 30000
        onTriggered: session.acknowledgeWorldbookFileImportReadback(editor.worldbookFileState.world_book_id || "", archiveEditor.revision, false)
    }
    Timer {
        id: successHold
        interval: 2400
        onTriggered: editor.saveAcknowledged = false
    }

    component ArchiveSelector: ComboBox {
        id: control
        property string emptyText: "请选择"
        implicitHeight: 32
        textRole: "label"
        valueRole: "key"
        font.pixelSize: 12
        padding: 8
        rightPadding: 25
        hoverEnabled: true
        contentItem: Text {
            text: control.currentIndex >= 0 ? control.displayText : control.emptyText
            textFormat: Text.PlainText
            color: control.enabled ? "#e4eff1" : "#829498"
            font: control.font
            verticalAlignment: Text.AlignVCenter
            elide: Text.ElideRight
        }
        indicator: Text {
            x: control.width - width - 9
            y: (control.height - height) / 2
            text: "⌄"
            color: "#a8c5cd"
            font.pixelSize: 14
        }
        background: GlassPane {
            padding: 0
            materialRole: "reading"
            cornerRadius: 10
            castsShadow: false
            outlineStrength: 0.62
            focusHighlight: control.activeFocus
            interactionHover: control.hovered ? 1 : 0
            opacity: control.enabled ? 1 : 0.58
        }
        delegate: ItemDelegate {
            required property var modelData
            required property int index
            objectName: control.objectName + "-row-" + index
            width: control.width
            text: modelData.label
            highlighted: control.highlightedIndex === index
            contentItem: Text {
                text: parent.text
                textFormat: Text.PlainText
                color: "#e4eff1"
                font.pixelSize: 12
                elide: Text.ElideRight
                verticalAlignment: Text.AlignVCenter
            }
            background: Rectangle {
                radius: 7
                color: parent.highlighted ? "#41646c" : parent.hovered ? "#2c444c" : "transparent"
            }
            Accessible.name: text
        }
        popup: Popup {
            y: control.height + 4
            width: control.width
            padding: 4
            implicitHeight: Math.min(contentItem.implicitHeight + topPadding + bottomPadding, 240)
            contentItem: ListView {
                clip: true
                implicitHeight: contentHeight
                model: control.popup.visible ? control.delegateModel : null
                currentIndex: control.highlightedIndex
                ScrollIndicator.vertical: ScrollIndicator {}
            }
            background: GlassPane {
                padding: 0
                materialRole: "work"
                cornerRadius: 12
            }
        }
    }
    component ArchiveCheckBox: CheckBox {
        id: control
        implicitHeight: 27
        padding: 0
        spacing: 7
        indicator: Rectangle {
            x: 0
            y: (control.height - height) / 2
            width: 18
            height: 18
            radius: 5
            color: control.checked ? "#658f91" : "#1e2b31"
            border.color: control.activeFocus ? "#c4e4d9" : "#58737d"
            opacity: control.enabled ? 1 : 0.58
            Text {
                anchors.centerIn: parent
                text: control.checked ? "✓" : ""
                color: "#edf6f1"
                font.pixelSize: 13
            }
        }
        contentItem: Text {
            leftPadding: control.indicator.width + control.spacing
            text: control.text
            textFormat: Text.PlainText
            color: control.enabled ? "#dce9ee" : "#829498"
            font.pixelSize: 12
            verticalAlignment: Text.AlignVCenter
        }
        Accessible.name: text
    }
    component ArchiveDialog: Dialog {
        id: control
        property var focusRestore: null
        onAboutToShow: focusRestore = editor.focusRestoreSnapshot(editor.focusWindow ? editor.focusWindow.activeFocusItem : null)
        onClosed: {
            // Popup may finish restoring focus after its closed notification.
            // A single context-bound callback observes that result without
            // forcing focus or replaying a stale restoration on another page.
            const snapshot = focusRestore;
            focusRestore = null;
            editor.queueDialogFocusRestore(snapshot);
        }
        readonly property real dialogWidth: Math.min(440, Overlay.overlay ? Overlay.overlay.width - 48 : 440)
        width: dialogWidth
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        spacing: 0
        modal: true
        anchors.centerIn: Overlay.overlay
        standardButtons: Dialog.NoButton
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: control.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            wrapMode: Text.Wrap
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
    }
    FileDialog {
        id: worldbookOpenDialog
        property string boundScope: ""
        property int boundGeneration: -1
        property int boundRevision: -1
        title: "选择 JSON 世界书"
        fileMode: FileDialog.OpenFile
        nameFilters: ["JSON 世界书 (*.json)"]
        onAccepted: {
            if (boundScope === editor.personaScope && boundGeneration === editor.focusRuntimeRevision
                    && boundRevision === archiveEditor.revision && !archiveEditor.dirty && !archiveEditor.busy)
                session.inspectWorldbookFile(selectedFile, boundRevision);
        }
    }
    FileDialog {
        id: worldbookSaveDialog
        property string boundScope: ""
        property int boundGeneration: -1
        property int boundRevision: -1
        property string worldBookId: ""
        title: "导出 SillyTavern 世界书"
        fileMode: FileDialog.SaveFile
        defaultSuffix: "json"
        nameFilters: ["JSON 世界书 (*.json)"]
        onAccepted: {
            if (boundScope === editor.personaScope && boundGeneration === editor.focusRuntimeRevision
                    && boundRevision === archiveEditor.revision && !archiveEditor.dirty && !archiveEditor.busy)
                session.exportWorldbookFile(selectedFile, worldBookId, boundRevision);
        }
    }
    ArchiveDialog {
        id: worldbookImportConfirm
        objectName: "worldbookFileImportConfirmation"
        title: "导入为一本新世界书？"
        closePolicy: Popup.NoAutoClose
        contentItem: ScrollView {
            id: worldbookImportSummaryScroll
            implicitHeight: Math.min(worldbookImportSummaryText.implicitHeight,
                Math.max(100, (Overlay.overlay ? Overlay.overlay.height : 650) - 220))
            contentWidth: availableWidth
            clip: true
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            Text {
                id: worldbookImportSummaryText
                objectName: "worldbookFileImportSummary"
                width: worldbookImportSummaryScroll.availableWidth
                text: editor.worldbookImportSummary()
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#d9e9ef"
                font.pixelSize: 13
            }
        }
        footer: Item {
            implicitHeight: 56
            RowLayout {
                anchors.fill: parent
                anchors.margins: 12
                Item { Layout.fillWidth: true }
                GlassButton {
                    objectName: "worldbookFileImportCancel"
                    text: "取消"
                    implicitHeight: 34
                    onClicked: session.cancelWorldbookFileImport()
                }
                GlassButton {
                    objectName: "worldbookFileImportConfirm"
                    text: "导入新书"
                    implicitHeight: 34
                    accented: true
                    enabled: editor.worldbookFileState.status === "confirmation" && !archiveEditor.dirty && !archiveEditor.busy
                        && archiveEditor.revision === editor.worldbookFileState.archiveRevision
                    onClicked: session.confirmWorldbookFileImport(archiveEditor.revision)
                }
            }
        }
        onRejected: session.cancelWorldbookFileImport()
    }
    ArchiveDialog {
        id: reloadConfirm
        objectName: "archive-reload-confirm"
        title: "重新读取已保存的版本？"
        footer: Item {
            implicitHeight: 54
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                anchors.bottomMargin: 16
                spacing: 8
                Item { Layout.fillWidth: true }
                GlassButton {
                    objectName: "archive-reload-cancel"
                    text: "保留草稿"
                    implicitHeight: 38
                    padding: 8
                    onClicked: reloadConfirm.reject()
                }
                GlassButton {
                    objectName: "archive-discard-confirm"
                    text: "载入已保存版本"
                    implicitHeight: 38
                    padding: 8
                    accented: true
                    onClicked: reloadConfirm.accept()
                }
            }
        }
        contentItem: Text {
            width: reloadConfirm.dialogWidth - reloadConfirm.leftPadding - reloadConfirm.rightPadding
            wrapMode: Text.Wrap
            textFormat: Text.PlainText
            color: "#d9e9ef"
            font.pixelSize: 13
            lineHeight: 1.15
            text: "读取成功后会替换当前草稿。保存失败或冲突时，当前草稿不会被自动删除。"
        }
        onAccepted: archiveEditor.reloadDiscardingDraft()
    }
    ArchiveDialog {
        id: navigationConfirm
        objectName: "archive-navigation-confirm"
        title: "先处理当前草稿"
        footer: Item {
            implicitHeight: 54
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                anchors.bottomMargin: 16
                spacing: 7
                GlassButton {
                    objectName: "archive-navigation-cancel"
                    text: "取消"
                    Layout.fillWidth: true
                    implicitHeight: 38
                    padding: 7
                    onClicked: archiveEditor.resolveNavigation("cancel")
                }
                GlassButton {
                    objectName: "archive-navigation-discard"
                    text: "放弃并继续"
                    Layout.fillWidth: true
                    implicitHeight: 38
                    padding: 7
                    onClicked: archiveEditor.resolveNavigation("discard")
                }
                GlassButton {
                    objectName: "archive-navigation-save"
                    text: "保存后继续"
                    Layout.fillWidth: true
                    implicitHeight: 38
                    padding: 7
                    accented: true
                    enabled: archiveEditor.canSave
                    onClicked: archiveEditor.resolveNavigation("save")
                }
            }
        }
        contentItem: Text {
            width: navigationConfirm.dialogWidth - navigationConfirm.leftPadding - navigationConfirm.rightPadding
            wrapMode: Text.Wrap
            textFormat: Text.PlainText
            color: "#d9e9ef"
            font.pixelSize: 13
            lineHeight: 1.15
            text: (editor.navigationPrompt.text || "当前草稿尚未保存。") + "\n保存成功后才会继续；如果保存期间继续编辑，会保留后来输入的草稿。"
        }
        onRejected: archiveEditor.resolveNavigation("cancel")
    }
    ArchiveDialog {
        id: deleteConfirm
        objectName: "archive-delete-confirm"
        title: editor.deletePrompt.kind === "book" ? "删除这本世界书？" : "删除这条设定？"
        footer: Item {
            implicitHeight: 54
            RowLayout {
                anchors.fill: parent
                anchors.leftMargin: 16
                anchors.rightMargin: 16
                anchors.bottomMargin: 16
                spacing: 8
                Item { Layout.fillWidth: true }
                GlassButton {
                    objectName: "archive-delete-cancel"
                    text: "取消"
                    implicitHeight: 38
                    padding: 8
                    onClicked: archiveEditor.cancelDelete()
                }
                GlassButton {
                    objectName: "archive-delete-accept"
                    text: "确认删除"
                    implicitHeight: 38
                    padding: 8
                    accented: true
                    onClicked: archiveEditor.confirmDelete()
                }
            }
        }
        contentItem: ScrollView {
            id: deleteSummaryScroll
            objectName: "archive-delete-summary-scroll"
            readonly property real bodyHeightLimit: Math.max(0, (Overlay.overlay ? Overlay.overlay.height : 520) - 48 - deleteConfirm.topPadding - deleteConfirm.bottomPadding - (deleteConfirm.header ? deleteConfirm.header.implicitHeight : 36) - (deleteConfirm.footer ? deleteConfirm.footer.implicitHeight : 54))
            implicitWidth: deleteConfirm.dialogWidth - deleteConfirm.leftPadding - deleteConfirm.rightPadding
            implicitHeight: Math.min(deleteSummaryText.implicitHeight, bodyHeightLimit)
            clip: true
            contentWidth: availableWidth
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            Text {
                id: deleteSummaryText
                objectName: "archive-delete-summary"
                // Reserve a small scrollbar gutter. Wrapping depends on the
                // overlay-derived width, not the dialog's measured height.
                width: Math.max(0, deleteConfirm.dialogWidth - deleteConfirm.leftPadding - deleteConfirm.rightPadding - 12)
                wrapMode: Text.Wrap
                textFormat: Text.PlainText
                color: "#d9e9ef"
                font.pixelSize: 13
                lineHeight: 1.15
                text: "「" + (editor.deletePrompt.name || "未命名") + "」\n共 " + (editor.deletePrompt.entryCount || 0) + " 条；启用 " + (editor.deletePrompt.enabledCount || 0) + " 条，其中启用且常驻 " + (editor.deletePrompt.alwaysActiveCount || 0) + " 条。\n确认后立即提交删除，并重新读取保存结果。此处没有撤销；恢复需要已有备份。"
                Accessible.name: text
            }
        }
        onOpened: if (deleteSummaryScroll.contentItem) deleteSummaryScroll.contentItem.contentY = 0
        onRejected: archiveEditor.cancelDelete()
    }

    // The form scrolls on short/narrow surfaces. Capacity, receipts and save
    // actions stay visible, alongside enablement and constant activation.
    Item {
        objectName: "archive-editor-scroll"
        anchors.fill: parent
        ColumnLayout {
            id: formLayout
            enabled: !editor.worldbookFileBusy
            anchors.fill: parent
            spacing: 6
            RowLayout {
                Layout.fillWidth: true
                Text {
                    textFormat: Text.PlainText
                    text: "世界书"
                    color: "#edf6f5"
                    font.pixelSize: 18
                    font.weight: Font.DemiBold
                }
                Item { Layout.fillWidth: true }
                GlassButton {
                    id: openMemories
                    objectName: "archive-open-memories"
                    text: "记忆与摘要"
                    implicitHeight: 26
                    padding: 5
                    onClicked: editor.navigation.open("memory", "memories", openMemories)
                }
                Text {
                    textFormat: Text.PlainText
                    text: "REV " + archiveEditor.revision
                    color: "#9ab2c5"
                    font.pixelSize: 11
                }
            }
            Text {
                objectName: "archiveRecoveryWarning"
                Layout.fillWidth: true
                visible: session.runtimeWritable === false
                textFormat: Text.PlainText
                text: session.recoveryWarning || "本地数据可写状态尚未确认，写入暂停；草稿已保留。"
                color: "#e6b4a4"
                font.pixelSize: 12
                wrapMode: Text.Wrap
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 6
                Label { text: "书"; color: "#bdd0de"; font.pixelSize: 11 }
                ArchiveSelector {
                    id: bookSelector
                    objectName: "worldbookBookSelector"
                    Layout.fillWidth: true
                    Layout.minimumWidth: 60
                    model: editor.bookChoices
                    emptyText: archiveEditor.hasBook ? archiveEditor.title + " · 草稿" : "全部世界书"
                    enabled: archiveEditor.canNavigate && !editor.modalOpen && !editor.worldbookFileBusy
                    onActivated: index => {
                        archiveEditor.selectBook(model[index].key);
                        editor.syncSelectors();
                    }
                    onActiveFocusChanged: if (activeFocus) editor.rememberFocus(bookSelector)
                    Accessible.name: "选择世界书"
                }
                GlassButton {
                    id: newBookButton
                    objectName: "newWorldbook"
                    text: "新建书"
                    implicitHeight: 32
                    padding: 7
                    enabled: archiveEditor.canCreateBook && !editor.modalOpen && !editor.worldbookFileBusy
                    onClicked: archiveEditor.newBook()
                }
                GlassButton {
                    objectName: "deleteWorldbook"
                    text: "删书"
                    implicitHeight: 32
                    padding: 7
                    enabled: archiveEditor.canDeleteBook && !editor.modalOpen && !editor.worldbookFileBusy
                    onClicked: archiveEditor.requestDelete("book")
                    ToolTip.visible: hovered && !enabled
                    ToolTip.text: archiveEditor.dirty ? "先保存或放弃草稿，再删除已保存的世界书。" : "当前没有可删除的已保存世界书。"
                }
                GlassButton {
                    objectName: "worldbookFileImport"
                    text: "导入"
                    implicitHeight: 32
                    padding: 7
                    enabled: editor.worldbookFileReady
                    onClicked: {
                        worldbookOpenDialog.boundScope = editor.personaScope;
                        worldbookOpenDialog.boundGeneration = editor.focusRuntimeRevision;
                        worldbookOpenDialog.boundRevision = archiveEditor.revision;
                        worldbookOpenDialog.open();
                    }
                    ToolTip.visible: hovered && !enabled
                    ToolTip.text: archiveEditor.dirty ? "先保存或放弃草稿，再导入世界书。" : "请等待当前操作完成并重新读取档案。"
                }
                GlassButton {
                    objectName: "worldbookFileExport"
                    text: "导出"
                    implicitHeight: 32
                    padding: 7
                    enabled: editor.worldbookFileReady && archiveEditor.hasBook && Number(editor.selectedFileBook.entryCount || 0) > 0
                    onClicked: {
                        worldbookSaveDialog.boundScope = editor.personaScope;
                        worldbookSaveDialog.boundGeneration = editor.focusRuntimeRevision;
                        worldbookSaveDialog.boundRevision = archiveEditor.revision;
                        worldbookSaveDialog.worldBookId = editor.selectedFileBook.id || "";
                        worldbookSaveDialog.selectedFile = session.suggestedWorldbookFile(worldbookSaveDialog.worldBookId);
                        worldbookSaveDialog.open();
                    }
                    ToolTip.visible: hovered && !enabled
                    ToolTip.text: archiveEditor.dirty ? "先保存或放弃草稿，再导出世界书。"
                        : archiveEditor.hasBook && Number(editor.selectedFileBook.entryCount || 0) === 0 ? "这本书还没有条目。"
                        : "请先选择一本已保存的世界书，并等待当前操作完成。"
                }
            }
            Text {
                objectName: "worldbookFileFeedback"
                Layout.fillWidth: true
                visible: text.length > 0
                text: editor.worldbookFileState.scopeKey === editor.personaScope
                    && editor.worldbookFileState.generation === editor.focusRuntimeRevision ? editor.worldbookFileState.text || "" : ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                font.pixelSize: 12
                color: ["error", "unknown"].includes(editor.worldbookFileState.status) ? "#e6b4a4" : "#bdd0de"
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 6
                Label { text: "条目"; color: "#bdd0de"; font.pixelSize: 11 }
                ArchiveSelector {
                    id: entrySelector
                    objectName: "worldbookEntrySelector"
                    Layout.fillWidth: true
                    Layout.minimumWidth: 60
                    model: editor.entryChoices
                    emptyText: archiveEditor.hasEntry ? (archiveEditor.comment || "未命名条目") + " · 草稿" : archiveEditor.hasBook ? "这本书还没有条目" : "先选择世界书"
                    enabled: archiveEditor.canNavigate && archiveEditor.hasBook && count > 1 && !editor.modalOpen && !editor.worldbookFileBusy
                    onActivated: index => {
                        archiveEditor.selectEntry(model[index].key);
                        editor.syncSelectors();
                    }
                    onActiveFocusChanged: if (activeFocus) editor.rememberFocus(entrySelector)
                    Accessible.name: "选择世界书条目"
                }
                GlassButton {
                    objectName: "newWorldbookEntry"
                    text: "新建条目"
                    implicitHeight: 32
                    padding: 7
                    enabled: archiveEditor.canCreateEntry && !editor.modalOpen && !editor.worldbookFileBusy
                    onClicked: archiveEditor.newEntry()
                }
                GlassButton {
                    objectName: "deleteWorldbookEntry"
                    text: "删条目"
                    implicitHeight: 32
                    padding: 7
                    enabled: archiveEditor.canDeleteEntry && !editor.modalOpen && !editor.worldbookFileBusy
                    onClicked: archiveEditor.requestDelete("entry")
                    ToolTip.visible: hovered && !enabled
                    ToolTip.text: archiveEditor.dirty ? "先保存或放弃草稿，再删除已保存的条目。" : "当前没有可删除的已保存条目。"
                }
            }
            RowLayout {
                Layout.fillWidth: true
                visible: archiveEditor.hasEntry
                spacing: 14
                ArchiveCheckBox {
                    id: enabledCheck
                    objectName: "worldbookEnabled"
                    text: "启用"
                    checked: archiveEditor.entryEnabled
                    enabled: editor.entryEditable
                    onToggled: archiveEditor.entryEnabled = checked
                    onActiveFocusChanged: if (activeFocus) editor.rememberFocus(enabledCheck)
                    Accessible.name: "启用这条设定"
                }
                ArchiveCheckBox {
                    id: constantCheck
                    objectName: "worldbookAlwaysActive"
                    text: "常驻"
                    checked: archiveEditor.alwaysActive
                    enabled: editor.entryEditable
                    onToggled: archiveEditor.alwaysActive = checked
                    onActiveFocusChanged: if (activeFocus) editor.rememberFocus(constantCheck)
                    Accessible.name: "常驻这条设定"
                }
                Text {
                    Layout.fillWidth: true
                    text: archiveEditor.entryEnabled ? archiveEditor.alwaysActive ? "跳过匹配，仍受预算限制" : "匹配关键词时参考" : "当前条目已停用"
                    textFormat: Text.PlainText
                    font.pixelSize: 11
                    color: "#9cb3c5"
                    elide: Text.ElideRight
                }
            }
            ScrollView {
                id: formScroll
                enabled: !editor.worldbookFileBusy
                objectName: "worldbook-form-scroll"
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.minimumHeight: 72
                contentWidth: availableWidth
                clip: true
                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                ColumnLayout {
                    id: formContent
                    width: formScroll.availableWidth
                    onWidthChanged: editor.observeFocusGeometry()
                    onHeightChanged: editor.observeFocusGeometry()
                    spacing: 7
                    Text {
                        objectName: "worldbookEmptyState"
                        Layout.fillWidth: true
                        visible: !archiveEditor.hasBook || !archiveEditor.hasEntry
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        text: !archiveEditor.initialized ? "世界书读取结果尚未确认。读取成功后可选择或新建。" : !archiveEditor.hasBook ? (archiveEditor.bookRows.length === 0 ? "这里还没有世界书。新建一本书后，为它添加设定条目。" : "从上方选择一本世界书，或新建一本。") : archiveEditor.newLocal ? "这本世界书尚在本地。保存书名后即可添加条目；放弃本地新建不会发送删除请求。" : archiveEditor.entryRows.length === 0 ? "这本世界书暂时没有条目。可以编辑书名和书设置，或新建一条设定。" : "当前显示书名与书设置。从上方选择一条设定即可编辑其内容。"
                        color: "#a9bfcc"
                        font.pixelSize: 12
                        Accessible.name: text
                    }
                    GridLayout {
                        id: primaryGrid
                        onColumnsChanged: editor.observeFocusGeometry()
                        Layout.fillWidth: true
                        visible: archiveEditor.hasBook
                        columns: editor.width >= 400 && archiveEditor.hasEntry ? 2 : 1
                        columnSpacing: 10
                        rowSpacing: 6
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "世界书名称"; color: "#bdd0de"; font.pixelSize: 11 }
                            GlassField {
                                id: titleField
                                objectName: "worldbookName"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                padding: 8
                                font.pixelSize: 13
                                text: archiveEditor.title
                                placeholderText: "为这本世界书命名"
                                enabled: archiveEditor.hasBook && archiveEditor.initialized && !editor.deleting
                                onTextEdited: archiveEditor.title = text
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(titleField)
                                Accessible.name: "世界书名称"
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            visible: archiveEditor.hasEntry
                            spacing: 3
                            Label { text: "条目名称 / 注释"; color: "#bdd0de"; font.pixelSize: 11 }
                            GlassField {
                                id: commentField
                                objectName: "worldbookComment"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                padding: 8
                                font.pixelSize: 13
                                text: archiveEditor.comment
                                placeholderText: "为这条设定命名"
                                enabled: editor.entryEditable
                                onTextEdited: archiveEditor.comment = text
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(commentField)
                                Accessible.name: "条目名称与注释"
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            visible: archiveEditor.hasEntry
                            spacing: 3
                            Label { text: editor.regexMode ? "主模式（任一匹配，每行一项）" : "主关键词（任一匹配）"; color: "#bdd0de"; font.pixelSize: 11 }
                            GlassField {
                                id: keywordsField
                                objectName: "worldbookKeys"
                                // Canonical literal items have no per-item cap.
                                // Saving still uses the whole-archive byte limit.
                                maximumLength: 2147483647
                                Layout.fillWidth: true
                                visible: !editor.regexMode
                                readOnly: !archiveEditor.keywordsEditable
                                implicitHeight: 32
                                padding: 8
                                font.pixelSize: 13
                                text: archiveEditor.keywords
                                placeholderText: "例如：星空，夜晚"
                                enabled: editor.entryEditable
                                onTextEdited: archiveEditor.keywords = text
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(keywordsField)
                                Accessible.name: "触发关键词"
                            }
                            ScrollView {
                                id: regexKeywordsScroll
                                objectName: "worldbook-regex-keywords-scroll"
                                Layout.fillWidth: true
                                Layout.preferredHeight: 96
                                visible: editor.regexMode
                                clip: true
                                contentWidth: availableWidth
                                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                                onWidthChanged: editor.observeFocusGeometry()
                                onHeightChanged: editor.observeFocusGeometry()
                                background: GlassPane {
                                    padding: 0; materialRole: "reading"; cornerRadius: 10
                                    castsShadow: false; outlineStrength: 0.62
                                    focusHighlight: regexKeywordsField.activeFocus
                                }
                                TextArea {
                                    id: regexKeywordsField
                                    objectName: "worldbookRegexKeywords"
                                    width: regexKeywordsScroll.availableWidth
                                    height: Math.max(regexKeywordsScroll.availableHeight, contentHeight + topPadding + bottomPadding)
                                    text: archiveEditor.keywords
                                    textFormat: TextEdit.PlainText
                                    wrapMode: TextArea.Wrap
                                    selectByMouse: true
                                    persistentSelection: true
                                    enabled: editor.entryEditable
                                    readOnly: !archiveEditor.keywordsEditable
                                    activeFocusOnTab: true
                                    color: enabled ? "#e4f0f6" : "#829498"
                                    selectionColor: "#44767c"
                                    placeholderText: "每行一个 Python 正则表达式"
                                    placeholderTextColor: "#7993a8"
                                    padding: 8
                                    font.pixelSize: 13
                                    background: null
                                    Keys.priority: Keys.BeforeItem
                                    Keys.onPressed: event => {
                                        if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
                                            event.accepted = true;
                                            editor.movePatternFocus(regexKeywordsField, event.key === Qt.Key_Backtab || (event.modifiers & Qt.ShiftModifier));
                                        }
                                    }
                                    onTextChanged: if (activeFocus && editor.regexMode && !readOnly && text !== archiveEditor.keywords) {
                                        editor.primaryPatternUserChange = true;
                                        try { archiveEditor.keywords = text; }
                                        finally { editor.primaryPatternUserChange = false; }
                                    }
                                    onActiveFocusChanged: {
                                        editor.textSelectionObservation(activeFocus ? "regex-primary-focus-in" : "regex-primary-focus-out", regexKeywordsField, regexKeywordsScroll);
                                        if (activeFocus) editor.rememberFocus(regexKeywordsField);
                                    }
                                    onSelectionStartChanged: editor.textSelectionObservation("regex-primary-selection-start", regexKeywordsField, regexKeywordsScroll)
                                    onSelectionEndChanged: editor.textSelectionObservation("regex-primary-selection-end", regexKeywordsField, regexKeywordsScroll)
                                    onCursorRectangleChanged: editor.observeFocusGeometry()
                                    Accessible.name: "主模式，每行一个 Python 正则表达式"
                                }
                            }
                            Text {
                                objectName: "worldbookRegexKeywordsReadonlyReason"
                                Layout.fillWidth: true
                                visible: !archiveEditor.keywordsEditable
                                text: archiveEditor.keywordsReadonlyReason
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            visible: archiveEditor.hasEntry
                            spacing: 3
                            Label { text: "插入顺序（非负整数）"; color: "#bdd0de"; font.pixelSize: 11 }
                            SpinBox {
                                id: orderField
                                objectName: "worldbookInsertionOrder"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 2147483647
                                value: editor.orderEditable ? archiveEditor.insertionOrder : 0
                                editable: true
                                visible: editor.orderEditable
                                enabled: editor.entryEditable && editor.orderEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.insertionOrder = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(orderField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: orderField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "条目插入顺序，非负整数"
                            }
                            Text {
                                objectName: "worldbookOriginalInsertionOrder"
                                Layout.fillWidth: true
                                visible: !editor.orderEditable
                                text: "原值 " + archiveEditor.insertionOrderText + "。超出本界面 0–2,147,483,647 的编辑范围，当前只读；编辑其余字段时会保留此值。"
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            visible: archiveEditor.hasEntry
                            spacing: 3
                            Label { text: "预算优先级（非负整数）"; color: "#bdd0de"; font.pixelSize: 11 }
                            SpinBox {
                                id: priorityField
                                objectName: "worldbookPriority"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 2147483647
                                value: archiveEditor.priorityEditable ? archiveEditor.priority : 0
                                editable: true
                                visible: archiveEditor.priorityEditable
                                enabled: editor.priorityEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.priority = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(priorityField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: priorityField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "条目预算优先级，非负整数"
                            }
                            Text {
                                objectName: "worldbookOriginalPriority"
                                Layout.fillWidth: true
                                visible: !archiveEditor.priorityEditable
                                text: archiveEditor.priorityConfirmed
                                    ? "原值 " + archiveEditor.priorityText + "。超出本界面 0–2,147,483,647 的编辑范围，当前只读；编辑其余字段时会保留此值。"
                                    : "优先级未确认，请重新读取档案；不会默认成 0 或截断原值。"
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                    }
                    GridLayout {
                        id: bookSettingsGrid
                        onColumnsChanged: editor.observeFocusGeometry()
                        objectName: "worldbookBookSettings"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasBook && !archiveEditor.hasEntry
                        columns: editor.width >= 400 ? 2 : 1
                        columnSpacing: 10
                        rowSpacing: 6
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "扫描深度（0–200 条消息）"; color: "#bdd0de"; font.pixelSize: 11 }
                            SpinBox {
                                id: scanDepthField
                                objectName: "worldbookScanDepth"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 200
                                value: editor.bookSettingStates.scanDepth?.editable ? archiveEditor.scanDepth : 0
                                editable: true
                                visible: editor.bookSettingStates.scanDepth?.editable === true
                                enabled: editor.bookSettingsEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.scanDepth = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(scanDepthField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: scanDepthField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "本书扫描深度，0 到 200 条消息"
                            }
                            Text {
                                objectName: "worldbookOriginalScanDepth"
                                Layout.fillWidth: true
                                visible: editor.bookSettingStates.scanDepth?.editable !== true
                                text: editor.bookSettingReadonlyText("scanDepth", "0–200")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "书级 Token 预算（0–4000）"; color: "#bdd0de"; font.pixelSize: 11 }
                            SpinBox {
                                id: bookBudgetField
                                objectName: "worldbookBookTokenBudget"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 4000
                                stepSize: 50
                                value: editor.bookSettingStates.tokenBudget?.editable ? archiveEditor.bookTokenBudget : 0
                                editable: true
                                visible: editor.bookSettingStates.tokenBudget?.editable === true
                                enabled: editor.bookSettingsEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.bookTokenBudget = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(bookBudgetField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: bookBudgetField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "本书 Token 预算，0 到 4000"
                            }
                            Text {
                                objectName: "worldbookOriginalBookTokenBudget"
                                Layout.fillWidth: true
                                visible: editor.bookSettingStates.tokenBudget?.editable !== true
                                text: editor.bookSettingReadonlyText("tokenBudget", "0–4000")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                    }
                    ArchiveCheckBox {
                        id: recursiveScanningCheck
                        objectName: "worldbookRecursiveScanning"
                        visible: archiveEditor.hasBook && !archiveEditor.hasEntry && editor.bookSettingStates.recursiveScanning?.editable === true
                        text: "递归扫描：已入选条目的正文可再触发本书其他条目"
                        checked: archiveEditor.recursiveScanning === true
                        enabled: editor.bookSettingsEditable
                        onToggled: archiveEditor.recursiveScanning = checked
                        onActiveFocusChanged: if (activeFocus) editor.rememberFocus(recursiveScanningCheck)
                    }
                    Text {
                        objectName: "worldbookOriginalRecursiveScanning"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasBook && !archiveEditor.hasEntry && editor.bookSettingStates.recursiveScanning?.editable !== true
                        text: "递归扫描未确认，请重新读取档案；不会使用默认值覆盖。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#d8bb8b"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookBookSettingsExplanation"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasBook && !archiveEditor.hasEntry
                        text: "扫描深度是匹配关键词时回看的最近消息条数（含本轮输入）；对话最多提供最近 20 条历史加本轮输入，更大的值不再扩大范围；为 0 时只有常驻条目及其递归触发的条目参与。书级预算为 0 时整本书停用；全部世界书合计上限固定为 800 token，单本预算更高也不会超过它。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#9cb3c5"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookPriorityExplanation"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: "优先级数值较大者优先参与预算分配，但不能绕过触发条件或容量限制；入选后在提示词中的排列仍由插入顺序控制。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#9cb3c5"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    GridLayout {
                        id: entrySettingsGrid
                        onColumnsChanged: editor.observeFocusGeometry()
                        objectName: "worldbookEntrySettings"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        columns: editor.width >= 400 ? 2 : 1
                        columnSpacing: 10
                        rowSpacing: 6
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "条目扫描深度（0–200 条消息）"; color: "#bdd0de"; font.pixelSize: 11 }
                            ArchiveCheckBox {
                                id: entryScanInheritCheck
                                objectName: "worldbookEntryScanDepthInherit"
                                Layout.fillWidth: true
                                visible: editor.entrySettingStates.scanDepth?.editable === true
                                text: editor.entryInheritText("scanDepth")
                                checked: editor.entrySettingStates.scanDepth?.inherited === true
                                enabled: editor.entryEditable && (!checked || editor.entrySettingStates.scanDepth?.canOverride === true)
                                onToggled: {
                                    archiveEditor.setEntrySettingInherited("scanDepth", checked);
                                    checked = Qt.binding(() => editor.entrySettingStates.scanDepth?.inherited === true);
                                }
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(entryScanInheritCheck)
                            }
                            SpinBox {
                                id: entryScanDepthField
                                objectName: "worldbookEntryScanDepth"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 200
                                value: editor.entrySettingStates.scanDepth?.editable && !editor.entrySettingStates.scanDepth?.inherited ? archiveEditor.entryScanDepth : 0
                                editable: true
                                visible: editor.entrySettingStates.scanDepth?.editable === true && editor.entrySettingStates.scanDepth?.inherited !== true
                                enabled: editor.entryEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.entryScanDepth = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(entryScanDepthField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: entryScanDepthField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "条目扫描深度，0 到 200 条消息"
                            }
                            Text {
                                objectName: "worldbookOriginalEntryScanDepth"
                                Layout.fillWidth: true
                                visible: editor.entrySettingStates.scanDepth?.editable !== true
                                text: editor.entrySettingReadonlyText("scanDepth", "0–200")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "条目 Token 预算（0–4000）"; color: "#bdd0de"; font.pixelSize: 11 }
                            ArchiveCheckBox {
                                id: entryBudgetInheritCheck
                                objectName: "worldbookEntryTokenBudgetInherit"
                                Layout.fillWidth: true
                                visible: editor.entrySettingStates.tokenBudget?.editable === true
                                text: editor.entryInheritText("tokenBudget")
                                checked: editor.entrySettingStates.tokenBudget?.inherited === true
                                enabled: editor.entryEditable && (!checked || editor.entrySettingStates.tokenBudget?.canOverride === true)
                                onToggled: {
                                    archiveEditor.setEntrySettingInherited("tokenBudget", checked);
                                    checked = Qt.binding(() => editor.entrySettingStates.tokenBudget?.inherited === true);
                                }
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(entryBudgetInheritCheck)
                            }
                            SpinBox {
                                id: entryBudgetField
                                objectName: "worldbookEntryTokenBudget"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 4000
                                stepSize: 50
                                value: editor.entrySettingStates.tokenBudget?.editable && !editor.entrySettingStates.tokenBudget?.inherited ? archiveEditor.entryTokenBudget : 0
                                editable: true
                                visible: editor.entrySettingStates.tokenBudget?.editable === true && editor.entrySettingStates.tokenBudget?.inherited !== true
                                enabled: editor.entryEditable
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.entryTokenBudget = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(entryBudgetField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: entryBudgetField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "条目 Token 预算，0 到 4000"
                            }
                            Text {
                                objectName: "worldbookOriginalEntryTokenBudget"
                                Layout.fillWidth: true
                                visible: editor.entrySettingStates.tokenBudget?.editable !== true
                                text: editor.entrySettingReadonlyText("tokenBudget", "0–4000")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                    }
                    Text {
                        objectName: "worldbookEntrySettingsExplanation"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: "条目扫描深度只对这一条生效，可比本书更大或更小；对话最多提供最近 20 条历史加本轮输入，更大的值不再扩大范围。条目 Token 预算只限制这一条正文本身（约每 2 个字符计 1 token），本书预算和全部世界书合计 800 token 的上限仍然生效。条目预算为 0 时这一条不参与匹配和注入，也不作为递归来源；预算为正但小于正文时，这一条不会注入，但在本书开启递归扫描时仍可能作为递归来源触发本书其他条目。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#9cb3c5"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Label {
                        visible: archiveEditor.hasEntry
                        text: "插入方式"
                        color: "#bdd0de"
                        font.pixelSize: 12
                    }
                    GridLayout {
                        id: insertionSettingsGrid
                        objectName: "worldbookInsertionSettings"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        columns: editor.width >= 520 ? 3 : editor.width >= 400 ? 2 : 1
                        columnSpacing: 10
                        rowSpacing: 6
                        onColumnsChanged: editor.observeFocusGeometry()
                        onHeightChanged: editor.observeFocusGeometry()
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "插入位置"; color: "#bdd0de"; font.pixelSize: 11 }
                            ArchiveSelector {
                                id: insertionPositionField
                                objectName: "worldbookInsertionPosition"
                                KeyNavigation.tab: editor.insertionNavigationEnabled ? insertionDepthField.contentItem : null
                                KeyNavigation.backtab: editor.insertionBeforeItem
                                KeyNavigation.priority: KeyNavigation.BeforeItem
                                Layout.fillWidth: true
                                model: editor.insertionPositionChoices
                                currentIndex: editor.selectedIndex(model, archiveEditor.insertionPosition)
                                visible: editor.insertionStates.position?.confirmed === true
                                enabled: editor.entryEditable && editor.insertionStates.position?.editable === true
                                onActivated: index => archiveEditor.insertionPosition = model[index].key
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(insertionPositionField)
                                Accessible.name: "插入位置"
                            }
                            Text {
                                objectName: "worldbookOriginalInsertionPosition"
                                Layout.fillWidth: true
                                visible: editor.insertionStates.position?.confirmed !== true
                                text: editor.insertionStates.position?.readonlyReason || "插入位置未确认"
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                            Text {
                                Layout.fillWidth: true
                                visible: text.length > 0
                                text: editor.insertionDefaultText("position")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#9cb3c5"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "插入深度（0–200）"; color: "#bdd0de"; font.pixelSize: 11 }
                            SpinBox {
                                id: insertionDepthField
                                objectName: "worldbookInsertionDepth"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                from: 0
                                to: 200
                                value: editor.insertionStates.depth?.confirmed && Number(archiveEditor.insertionDepth) <= 200 ? archiveEditor.insertionDepth : 0
                                editable: true
                                visible: editor.insertionStates.depth?.confirmed === true && Number(archiveEditor.insertionDepth) <= 200
                                enabled: editor.entryEditable && editor.insertionStates.depth?.editable === true
                                font.pixelSize: 13
                                palette.text: "#e4eff1"
                                palette.buttonText: "#e4eff1"
                                palette.base: "#1e3037"
                                palette.button: "#29424a"
                                onValueModified: archiveEditor.insertionDepth = value
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(insertionDepthField)
                                background: GlassPane {
                                    padding: 0
                                    materialRole: "reading"
                                    cornerRadius: 10
                                    castsShadow: false
                                    focusHighlight: insertionDepthField.activeFocus
                                    outlineStrength: 0.62
                                }
                                Accessible.name: "插入深度，0 到 200 条历史消息"
                            }
                            Text {
                                objectName: "worldbookOriginalInsertionDepth"
                                Layout.fillWidth: true
                                visible: !insertionDepthField.visible
                                text: editor.insertionStates.depth?.readonlyReason || "插入深度未确认"
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                            Text {
                                Layout.fillWidth: true
                                visible: text.length > 0
                                text: editor.insertionDefaultText("depth")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#9cb3c5"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "消息角色"; color: "#bdd0de"; font.pixelSize: 11 }
                            ArchiveSelector {
                                id: insertionRoleField
                                objectName: "worldbookInsertionRole"
                                KeyNavigation.tab: editor.insertionAfterItem
                                KeyNavigation.backtab: editor.insertionNavigationEnabled ? insertionDepthField.contentItem : null
                                KeyNavigation.priority: KeyNavigation.BeforeItem
                                Layout.fillWidth: true
                                model: editor.insertionRoleChoices
                                currentIndex: editor.selectedIndex(model, archiveEditor.insertionRole)
                                visible: editor.insertionStates.role?.confirmed === true
                                enabled: editor.entryEditable && editor.insertionStates.role?.editable === true
                                onActivated: index => archiveEditor.insertionRole = model[index].key
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(insertionRoleField)
                                Accessible.name: "消息角色"
                            }
                            Text {
                                objectName: "worldbookOriginalInsertionRole"
                                Layout.fillWidth: true
                                visible: editor.insertionStates.role?.confirmed !== true
                                text: editor.insertionStates.role?.readonlyReason || "消息角色未确认"
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                            Text {
                                Layout.fillWidth: true
                                visible: text.length > 0
                                text: editor.insertionDefaultText("role")
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#9cb3c5"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                    }
                    Text {
                        objectName: "worldbookInsertionEffective"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: "实际生效：" + archiveEditor.insertionEffectiveText
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#bdd0de"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookInsertionDependencyNotice"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry && text.length > 0
                        text: archiveEditor.insertionDependencyNotice
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#d8bb8b"
                        font.pixelSize: 11
                        Accessible.name: text
                        onVisibleChanged: editor.observeFocusGeometry()
                        onHeightChanged: editor.observeFocusGeometry()
                    }
                    Text {
                        objectName: "worldbookInsertionExplanation"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: editor.insertionExplanation()
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#9cb3c5"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookInsertionProviderWarning"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry && archiveEditor.insertionPosition === "at_depth" && archiveEditor.insertionRole === "system"
                        text: "使用 Anthropic 服务时，系统角色的插入会并入系统提示，不保持深度位置；需要保持位置请改用用户或助手角色。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#d8bb8b"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookInsertionDowngradeWarning"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry && archiveEditor.insertionPosition === "at_depth"
                        text: "保存后，旧版本将无法使用本人格的世界书；回退旧版本前请先把这类条目改回其他位置。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#d8bb8b"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    GridLayout {
                        id: triggerGrid
                        onColumnsChanged: editor.observeFocusGeometry()
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        columns: editor.width >= 400 ? 2 : 1
                        columnSpacing: 10
                        rowSpacing: 6
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: editor.regexMode ? "辅助模式（最多 200 项）" : "辅助关键词（最多 200 个）"; color: "#bdd0de"; font.pixelSize: 11 }
                            GlassField {
                                id: secondaryKeywordsField
                                objectName: "worldbookSecondaryKeywords"
                                // Canonical literal items have no per-item cap.
                                // Saving still uses the whole-archive byte limit.
                                maximumLength: 2147483647
                                Layout.fillWidth: true
                                visible: !editor.regexMode
                                readOnly: !archiveEditor.secondaryKeywordsEditable
                                implicitHeight: 32
                                padding: 8
                                font.pixelSize: 13
                                text: archiveEditor.secondaryKeywords
                                placeholderText: "逗号分隔，留空不增加限制"
                                enabled: editor.entryEditable
                                onTextEdited: archiveEditor.secondaryKeywords = text
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(secondaryKeywordsField)
                                Accessible.name: "辅助关键词，逗号分隔，留空不增加限制"
                            }
                            ScrollView {
                                id: regexSecondaryKeywordsScroll
                                objectName: "worldbook-regex-secondary-scroll"
                                Layout.fillWidth: true
                                Layout.preferredHeight: 96
                                visible: editor.regexMode
                                clip: true
                                contentWidth: availableWidth
                                ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                                onWidthChanged: editor.observeFocusGeometry()
                                onHeightChanged: editor.observeFocusGeometry()
                                background: GlassPane {
                                    padding: 0; materialRole: "reading"; cornerRadius: 10
                                    castsShadow: false; outlineStrength: 0.62
                                    focusHighlight: regexSecondaryKeywordsField.activeFocus
                                }
                                TextArea {
                                    id: regexSecondaryKeywordsField
                                    objectName: "worldbookRegexSecondaryKeywords"
                                    width: regexSecondaryKeywordsScroll.availableWidth
                                    height: Math.max(regexSecondaryKeywordsScroll.availableHeight, contentHeight + topPadding + bottomPadding)
                                    text: archiveEditor.secondaryKeywords
                                    textFormat: TextEdit.PlainText
                                    wrapMode: TextArea.Wrap
                                    selectByMouse: true
                                    persistentSelection: true
                                    enabled: editor.entryEditable
                                    readOnly: !archiveEditor.secondaryKeywordsEditable
                                    activeFocusOnTab: true
                                    color: enabled ? "#e4f0f6" : "#829498"
                                    selectionColor: "#44767c"
                                    placeholderText: "每行一个 Python 正则表达式"
                                    placeholderTextColor: "#7993a8"
                                    padding: 8
                                    font.pixelSize: 13
                                    background: null
                                    Keys.priority: Keys.BeforeItem
                                    Keys.onPressed: event => {
                                        if (event.key === Qt.Key_Tab || event.key === Qt.Key_Backtab) {
                                            const backwards = event.key === Qt.Key_Backtab || (event.modifiers & Qt.ShiftModifier);
                                            if (backwards && editor.insertionAfterItem === regexSecondaryKeywordsField) {
                                                event.accepted = false;
                                            } else {
                                                event.accepted = true;
                                                editor.movePatternFocus(regexSecondaryKeywordsField, backwards);
                                            }
                                        }
                                    }
                                    onTextChanged: if (activeFocus && editor.regexMode && !readOnly && text !== archiveEditor.secondaryKeywords) {
                                        editor.secondaryPatternUserChange = true;
                                        try { archiveEditor.secondaryKeywords = text; }
                                        finally { editor.secondaryPatternUserChange = false; }
                                    }
                                    onActiveFocusChanged: {
                                        editor.textSelectionObservation(activeFocus ? "regex-secondary-focus-in" : "regex-secondary-focus-out", regexSecondaryKeywordsField, regexSecondaryKeywordsScroll);
                                        if (activeFocus) editor.rememberFocus(regexSecondaryKeywordsField);
                                    }
                                    onSelectionStartChanged: editor.textSelectionObservation("regex-secondary-selection-start", regexSecondaryKeywordsField, regexSecondaryKeywordsScroll)
                                    onSelectionEndChanged: editor.textSelectionObservation("regex-secondary-selection-end", regexSecondaryKeywordsField, regexSecondaryKeywordsScroll)
                                    onCursorRectangleChanged: editor.observeFocusGeometry()
                                    Accessible.name: "辅助模式，每行一个 Python 正则表达式"
                                }
                            }
                            Text {
                                objectName: "worldbookRegexSecondaryKeywordsReadonlyReason"
                                Layout.fillWidth: true
                                visible: !archiveEditor.secondaryKeywordsEditable
                                text: archiveEditor.secondaryKeywordsReadonlyReason
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#d8bb8b"
                                font.pixelSize: 11
                                Accessible.name: text
                            }
                        }
                        ColumnLayout {
                            Layout.fillWidth: true
                            Layout.preferredWidth: 1
                            spacing: 3
                            Label { text: "辅助关键词逻辑"; color: "#bdd0de"; font.pixelSize: 11 }
                            ArchiveSelector {
                                id: selectiveLogicField
                                objectName: "worldbookSelectiveLogic"
                                Layout.fillWidth: true
                                model: editor.selectiveLogicChoices
                                currentIndex: editor.selectedIndex(editor.selectiveLogicChoices, archiveEditor.selectiveLogic)
                                enabled: editor.advancedRuleEditable
                                onActivated: index => archiveEditor.selectiveLogic = model[index].key
                                onActiveFocusChanged: if (activeFocus) editor.rememberFocus(selectiveLogicField)
                                Accessible.name: "辅助关键词逻辑"
                            }
                        }
                    }
                    Flow {
                        id: matchingOptionsRow
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        spacing: 12
                        ArchiveCheckBox {
                            id: caseSensitiveCheck
                            objectName: "worldbookCaseSensitive"
                            text: "主关键词和辅助关键词均区分大小写"
                            checked: archiveEditor.caseSensitive
                            enabled: editor.advancedRuleEditable
                            onToggled: archiveEditor.caseSensitive = checked
                            onActiveFocusChanged: if (activeFocus) editor.rememberFocus(caseSensitiveCheck)
                        }
                        ArchiveCheckBox {
                            id: useRegexCheck
                            objectName: "worldbookUseRegex"
                            text: "使用正则表达式"
                            checked: archiveEditor.useRegex
                            enabled: editor.advancedRuleEditable
                            onToggled: archiveEditor.useRegex = checked
                            onActiveFocusChanged: if (activeFocus) editor.rememberFocus(useRegexCheck)
                        }
                    }
                    Text {
                        objectName: "worldbookMatchingExplanation"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: editor.regexMode ? "每行一个 Python 正则表达式；空行不计入，其余行原样保存，不去首尾空格。保存时不检查语法；无效的模式会让此条目在对话中不注入，并在下方运行诊断中说明。Tab 用于移动焦点，需要制表符时写 \\t。" : "先匹配任一主关键词，再判断辅助关键词；辅助关键词为空时不增加限制。常驻跳过关键词匹配，仍受启用状态和预算限制。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#9cb3c5"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    Text {
                        objectName: "worldbookRegexDiagnostics"
                        readonly property string diagnosticStatus: archiveEditor.regexDiagnostics.status || "unavailable"
                        readonly property string diagnosticRequestId: archiveEditor.regexDiagnostics.requestId || ""
                        readonly property int diagnosticRevision: archiveEditor.regexDiagnostics.revision || 0
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry && editor.regexMode
                        text: editor.regexDiagnosticText()
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: ["clear", "unrun", "unsaved"].includes(diagnosticStatus) ? "#9cb3c5" : "#d8bb8b"
                        font.pixelSize: 11
                        Accessible.name: text
                    }
                    ColumnLayout {
                        id: ruleConflictArea
                        objectName: "worldbookRuleConflict"
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry && archiveEditor.ruleConflict
                        spacing: 5
                        Text {
                            Layout.fillWidth: true
                            text: archiveEditor.ruleConflictText
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: "#d8bb8b"
                            font.pixelSize: 11
                            Accessible.name: text
                        }
                        GlassButton {
                            id: adoptRulesButton
                            objectName: "worldbookAdoptSavedRules"
                            text: "采用已保存的规则"
                            implicitHeight: 32
                            enabled: editor.advancedRuleEditable && !archiveEditor.busy && !archiveEditor.writesBlocked
                            onClicked: archiveEditor.adoptSavedRules()
                            onActiveFocusChanged: if (activeFocus) editor.rememberFocus(adoptRulesButton)
                            Accessible.name: text
                        }
                    }
                    Text {
                        Layout.fillWidth: true
                        visible: archiveEditor.hasEntry
                        text: "设定内容"
                        color: "#bdd0de"
                        font.pixelSize: 12
                    }
                    ScrollView {
                        id: bodyScroll
                        onWidthChanged: editor.observeFocusGeometry()
                        onHeightChanged: editor.observeFocusGeometry()
                        objectName: "worldbook-content-scroll"
                        Layout.fillWidth: true
                        Layout.preferredHeight: Math.max(100, formScroll.availableHeight - 142)
                        visible: archiveEditor.hasEntry
                        clip: true
                        contentWidth: availableWidth
                        ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
                        background: GlassPane {
                            padding: 0
                            materialRole: "reading"
                            cornerRadius: 12
                            castsShadow: false
                            outlineStrength: 0.62
                            interactionHover: bodyField.hovered ? 1 : 0
                            focusHighlight: bodyField.activeFocus
                            Rectangle {
                                anchors.fill: parent
                                radius: 12
                                color: "#16040e14"
                            }
                        }
                        TextArea {
                            id: bodyField
                            objectName: "worldbookContent"
                            width: bodyScroll.availableWidth
                            height: Math.max(bodyScroll.availableHeight, contentHeight + topPadding + bottomPadding)
                            text: archiveEditor.content
                            textFormat: TextEdit.PlainText
                            wrapMode: TextArea.Wrap
                            selectByMouse: true
                            persistentSelection: true
                            enabled: editor.entryEditable
                            color: enabled ? "#e4f0f6" : "#829498"
                            selectionColor: "#44767c"
                            placeholderText: "写下希望陪伴角色在相关对话中参考的设定…"
                            placeholderTextColor: "#7993a8"
                            padding: 12
                            font.pixelSize: 14
                            onTextChanged: if (activeFocus && text !== archiveEditor.content) {
                                editor.bodyUserChange = true;
                                try { archiveEditor.content = text; }
                                finally { editor.bodyUserChange = false; }
                            }
                            onActiveFocusChanged: {
                                editor.selectionObservation(activeFocus ? "body-focus-in" : "body-focus-out");
                                if (activeFocus) editor.rememberFocus(bodyField);
                            }
                            onSelectionStartChanged: editor.selectionObservation("selection-start")
                            onSelectionEndChanged: editor.selectionObservation("selection-end")
                            onCursorRectangleChanged: editor.observeFocusGeometry()
                            background: null
                            Accessible.name: "设定内容"
                        }
                    }
                    ColumnLayout {
                        id: detailsLayout
                        onVisibleChanged: editor.observeFocusGeometry()
                        onHeightChanged: editor.observeFocusGeometry()
                        objectName: "worldbookReadonlyDetails"
                        Layout.fillWidth: true
                        visible: editor.detailsExpanded
                        spacing: 5
                        Text {
                            Layout.fillWidth: true
                            text: "其余高级字段保存时原样保留。"
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: "#9cb3c5"
                            font.pixelSize: 11
                        }
                        Repeater {
                            model: Object.keys(editor.advancedFields.book || {}).filter(key => !["scanDepth", "tokenBudget", "recursiveScanning"].includes(key)).sort()
                            Text {
                                required property string modelData
                                Layout.fillWidth: true
                                text: "书 · " + editor.fieldLabel(modelData) + "：" + editor.fieldValue(editor.advancedFields.book[modelData])
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#a9bfcc"
                                font.pixelSize: 11
                            }
                        }
                        Repeater {
                            model: Object.keys(editor.advancedFields.entry || {}).filter(key => !["priority", "scanDepth", "tokenBudget", "useRegex", "position", "depth", "role"].includes(key)).sort()
                            Text {
                                required property string modelData
                                Layout.fillWidth: true
                                text: "条目 · " + editor.fieldLabel(modelData) + "：" + editor.advancedFieldValue(modelData, editor.advancedFields.entry[modelData])
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#a9bfcc"
                                font.pixelSize: 11
                            }
                        }
                        Text {
                            objectName: "worldbookCapacityExplanation"
                            Layout.fillWidth: true
                            text: "编辑上限为完整档案 UTF-8 JSON 的 900,000 字节，810,000 字节起预警。桥接单次请求与回复各限 1 MiB，低于后端的 5 MiB 限制，因此这里采用较低上限；不会截断内容。"
                            textFormat: Text.PlainText
                            wrapMode: Text.Wrap
                            color: "#a9bfcc"
                            font.pixelSize: 11
                        }
                    }
                    Item { Layout.fillWidth: true; implicitHeight: 2 }
                }
            }
            RowLayout {
                Layout.fillWidth: true
                spacing: 7
                GlassButton {
                    objectName: "worldbookDetailsToggle"
                    text: editor.detailsExpanded ? "收起只读详情" : "只读详情"
                    implicitHeight: 25
                    padding: 5
                    onClicked: editor.detailsExpanded = !editor.detailsExpanded
                }
                Text {
                    objectName: "worldbookCapacity"
                    Layout.fillWidth: true
                    text: archiveEditor.initialized ? "草稿 " + Number(archiveEditor.draftBytes).toLocaleString() + " / 900,000 字节 · 已保存 " + Number(archiveEditor.savedBytes).toLocaleString() : "完整档案大小尚未确认"
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: archiveEditor.sizeWarning ? "#e1bc88" : "#9cb3c5"
                    font.pixelSize: 10
                    Accessible.name: text
                }
                GlassButton {
                    objectName: "discardNewWorldbookItem"
                    visible: archiveEditor.newLocal
                    text: "放弃本地新建"
                    implicitHeight: 25
                    padding: 5
                    enabled: !archiveEditor.busy && !editor.modalOpen
                    onClicked: archiveEditor.discardNew()
                }
            }
            Text {
                objectName: "worldbookCapacityWarning"
                Layout.fillWidth: true
                visible: archiveEditor.sizeWarning
                text: archiveEditor.draftBytes > 900000 ? "草稿已超过 900,000 字节，保存暂停。请缩减内容；不会截断草稿。桥接请求 / 回复各限 1 MiB，后端上限为 5 MiB。" : "完整档案已达到容量预警线（810,000 字节）。保存上限为 900,000 字节；不会截断内容。"
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e1bc88"
                font.pixelSize: 11
                Accessible.name: text
            }
            Text {
                objectName: "worldbookSaveBlocker"
                Layout.fillWidth: true
                visible: archiveEditor.dirty && !archiveEditor.busy && (archiveEditor.saveBlocker || "").length > 0
                text: archiveEditor.saveBlocker || ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e1bc88"
                font.pixelSize: 11
                Accessible.name: text
            }
            Text {
                objectName: "archive-delete-feedback"
                Layout.fillWidth: true
                visible: (editor.deleteFeedback.text || "").length > 0
                text: editor.deleteFeedback.text || ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: ["error", "unknown", "conflict"].includes(editor.deleteFeedback.status) ? "#e6b4a4" : "#a9bfcc"
                font.pixelSize: 11
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
            Rectangle {
                Layout.fillWidth: true
                implicitHeight: Math.max(32, statusLabel.implicitHeight + 14)
                radius: 10
                color: editor.failed ? "#3c2931" : editor.conflicted ? "#3d332c" : editor.saveAcknowledged ? "#203b3b" : "#1e2b31"
                border.color: editor.failed ? "#835253" : editor.conflicted ? "#8c7353" : editor.saveAcknowledged ? "#4e7871" : "#34474d"
                border.width: 1
                Rectangle {
                    x: 10
                    anchors.verticalCenter: parent.verticalCenter
                    width: 5
                    height: 5
                    radius: 2.5
                    color: editor.statusAccent
                }
                Text {
                    id: statusLabel
                    objectName: "archive-status"
                    x: 23
                    y: (parent.height - height) / 2
                    width: Math.max(0, parent.width - 33)
                    height: implicitHeight
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    text: editor.statusMessage
                    color: editor.statusAccent
                    font.pixelSize: 11
                    Accessible.role: Accessible.StaticText
                    Accessible.name: text
                }
            }
            RowLayout {
                Layout.fillWidth: true
                GlassButton {
                    objectName: "reloadWorldbook"
                    text: "重新读取"
                    implicitHeight: 34
                    padding: 8
                    enabled: !archiveEditor.busy && !editor.modalOpen
                    onClicked: editor.requestReload()
                }
                Item { Layout.fillWidth: true }
                GlassButton {
                    objectName: "saveWorldbook"
                    text: editor.saving ? "保存中…" : "保存设定"
                    implicitHeight: 34
                    padding: 8
                    accented: true
                    enabled: archiveEditor.canSave && !editor.modalOpen
                    onClicked: archiveEditor.save()
                }
            }
        }
    }
}
