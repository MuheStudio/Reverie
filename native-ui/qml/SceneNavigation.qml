import QtQuick

QtObject {
    id: navigation
    objectName: "sceneNavigation"

    // Navigation owns location and focus. Requests, drafts and saved data remain
    // with the persistent session/editor objects.
    signal aboutToNavigate(var context)
    signal palettePresented
    signal focusDiagnostic(string kind, var fields)
    property bool transitionCommitting: false
    property var focusWindow
    property string focusScopeKey: ""
    property int focusGeneration: 0
    property int focusActivityRevision: 0
    property int focusRequestRevision: 0
    onActiveFocusItemChanged: {
        // Enabling/disabling a FocusScope can transiently focus its neutral
        // root. Count real interactive destinations, including anonymous text
        // leaves, but do not treat that lifecycle handoff as new user intent.
        if (isInteractiveFocusTarget(activeFocusItem))
            focusActivityRevision += 1;
    }
    signal focusSuspended(var item, string source)
    signal focusRestored(var item, string source)
    signal focusRestorationCancelled(string source)
    property string currentFeature: "chat"
    property string currentSubentry: "companion"
    property string outgoingFeature: ""
    property string outgoingSubentry: ""
    property string chatReturnSubentry: "companion"
    property int transitionRevision: 0
    property var inputContext
    property var activeFocusItem
    property var returnFocusItem
    property var paletteReturnFocusItem
    property var fallbackFocusItem
    property var lastFocusedItem: ({})
    property bool paletteOpen: false
    property string query: ""
    readonly property bool surfaceOpen: currentFeature !== "chat"
    readonly property var entries: [
        {
            feature: "chat",
            subentry: "companion",
            shortLabel: "陪伴",
            glyph: "✧",
            available: true,
            showInRail: true,
            label: "陪伴与聊天",
            detail: "回到窗边，继续此刻的对话",
            keywords: "陪伴 聊天 chat companion"
        },
        {
            feature: "chat",
            subentry: "reading",
            shortLabel: "历史",
            glyph: "≋",
            available: true,
            showInRail: true,
            label: "完整聊天历史",
            detail: "展开当前对话，保留阅读位置",
            keywords: "历史 对话 阅读 history reading"
        },
        {
            feature: "memory",
            subentry: "worldbook",
            shortLabel: "资料",
            glyph: "▥",
            available: true,
            showInRail: true,
            label: "资料匣 · 世界书",
            detail: "编辑并保存角色的世界设定",
            keywords: "资料 世界书 设定 archive worldbook"
        },
        {
            feature: "memory",
            subentry: "memories",
            shortLabel: "记忆",
            glyph: "▥",
            available: true,
            showInRail: false,
            label: "资料匣 · 记忆与摘要",
            detail: "查看已确认的记忆，管理对话摘要",
            keywords: "资料 记忆 摘要 memory summary"
        },
        {
            feature: "settings",
            subentry: "provider",
            shortLabel: "设置",
            glyph: "⌘",
            available: true,
            showInRail: true,
            label: "终端 · 回复服务",
            detail: "连接与测试回复服务",
            keywords: "终端 设置 服务 模型 连接 settings provider"
        },
        {
            feature: "character",
            subentry: "",
            shortLabel: "角色",
            glyph: "✧",
            available: true,
            showInRail: false,
            label: "角色与形象",
            detail: "导入与管理当前 Live2D",
            keywords: "角色 形象 live2d avatar character"
        },
        {
            feature: "settings",
            subentry: "about",
            shortLabel: "说明",
            glyph: "i",
            available: true,
            showInRail: false,
            label: "空间说明",
            detail: "版本与本地运行说明",
            keywords: "关于 说明 版本 about"
        },
        {
            feature: "activities",
            subentry: "xiangqi",
            shortLabel: "象棋",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "中国象棋",
            detail: "和角色下一盘，或本地练习",
            keywords: "棋 象棋 xiangqi"
        },
        {
            feature: "activities",
            subentry: "gomoku",
            shortLabel: "五子棋",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "五子棋",
            detail: "和角色下一盘，或本地练习",
            keywords: "棋 五子棋 gomoku"
        },
        {
            feature: "activities",
            subentry: "chess",
            shortLabel: "国际象棋",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "国际象棋",
            detail: "和角色下一盘，或本地练习",
            keywords: "棋 国际象棋 chess"
        },
        {
            feature: "activities",
            subentry: "go",
            shortLabel: "围棋",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "围棋",
            detail: "九路，和角色下一盘，或本地练习",
            keywords: "棋 围棋 weiqi"
        },
        {
            feature: "activities",
            subentry: "diary",
            shortLabel: "日记",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "日记",
            detail: "读她每天写的日记",
            keywords: "日记 手记 diary"
        },
        {
            feature: "keepsake",
            subentry: "list",
            shortLabel: "收藏",
            glyph: "◇",
            available: true,
            showInRail: false,
            label: "收藏",
            detail: "翻看留住的话与图片",
            keywords: "收藏 keepsake"
        }
    ]
    readonly property var filteredEntries: {
        const needle = query.trim().toLowerCase();
        return needle.length === 0 ? entries : entries.filter(entry => (entry.label + " " + entry.detail + " " + entry.keywords).toLowerCase().indexOf(needle) !== -1);
    }

    signal enteredFeature(string feature, string subentry)
    signal closeRequested
    signal cancelInteraction

    function defaultSubentry(feature) {
        return ({
                chat: "companion",
                memory: "worldbook",
                settings: "provider",
                activities: "xiangqi",
                keepsake: "list"
            })[feature] || "";
    }
    function entryFor(feature, subentry) {
        const selected = subentry || defaultSubentry(feature);
        return entries.find(entry => entry.feature === feature && entry.subentry === selected);
    }
    function isAvailable(feature, subentry) {
        const entry = entryFor(feature, subentry);
        return !!entry && entry.available;
    }
    function commitBefore(callback) {
        if (inputContext && typeof inputContext.commitBefore === "function")
            inputContext.commitBefore(callback);
        else {
            Qt.inputMethod.commit();
            callback();
        }
    }
    function canFocus(item) {
        if (!item || typeof item.forceActiveFocus !== "function")
            return false;
        for (let ancestor = item; ancestor; ancestor = ancestor.parent) {
            if (ancestor.visible === false || ancestor.enabled === false)
                return false;
        }
        return true;
    }
    function isInteractiveFocusTarget(item) {
        if (!canFocus(item) || !targetInFocusWindow(item, focusWindow))
            return false;
        for (let ancestor = item; ancestor; ancestor = ancestor.parent)
            if (ancestor.opacity <= 0)
                return false;
        // A ScenePortal is an activeFocusOnTab FocusScope whose entrance
        // method forwards to its real button. Its neutral lifecycle root is
        // not a new destination; that button and its other controls are.
        if (typeof item.focusEntrance === "function")
            return false;
        return item.activeFocusOnTab === true || item.keyNavigationEnabled === true
                || (item.focusPolicy !== undefined && item.focusPolicy !== Qt.NoFocus)
                || (item.cursorPosition !== undefined && item.cursorRectangle !== undefined);
    }
    function focusItem(item) {
        if (!canFocus(item) || (focusWindow && !targetInFocusWindow(item, focusWindow)))
            return false;
        if (typeof item.focusEntrance === "function")
            item.focusEntrance();
        else
            item.forceActiveFocus(Qt.OtherFocusReason);
        return focusTargetReached(item);
    }
    function focusTargetReached(item) {
        if (!targetInFocusWindow(item, focusWindow))
            return false;
        // forceActiveFocus is void. A refusal or a synchronous newer target
        // must not be reported as a successful restoration.
        for (let current = focusWindow.activeFocusItem; current; current = current.parent)
            if (current === item)
                return true;
        return false;
    }
    function rememberFeatureFocus(feature, item) {
        if (!item || paletteOpen || !canFocus(item))
            return;
        const remembered = Object.assign({}, lastFocusedItem);
        remembered[feature] = item;
        lastFocusedItem = remembered;
    }
    function restoreFeatureFocus(feature, fallbackItem) {
        if (paletteOpen || currentFeature !== feature)
            return false;
        return focusItem(lastFocusedItem[feature]) || focusItem(fallbackItem);
    }
    function restoreFocus(expectedRevision) {
        if (paletteOpen || (expectedRevision !== undefined && expectedRevision !== transitionRevision))
            return false;
        return focusItem(returnFocusItem) || restoreFeatureFocus(currentFeature, fallbackFocusItem);
    }
    function focusGuard(item, paletteExpected) {
        return { target: item, window: focusWindow, scope: focusScopeKey, generation: focusGeneration,
                 revision: transitionRevision, activity: focusActivityRevision,
                 feature: currentFeature, subentry: currentSubentry,
                 palette: paletteExpected, request: ++focusRequestRevision };
    }
    function targetInFocusWindow(item, window) {
        if (!item || !window || !window.contentItem)
            return false;
        // Item identity alone is insufficient: a live control can be reparented
        // or detached while a queued restoration still owns its reference.
        for (let ancestor = item; ancestor; ancestor = ancestor.parent)
            if (ancestor === window.contentItem)
                return true;
        return false;
    }
    function focusGuardRejectCode(guard) {
        if (!guard) return 1;
        if (guard.request !== focusRequestRevision) return 2;
        if (guard.window !== focusWindow) return 3;
        if (guard.scope !== focusScopeKey) return 4;
        if (guard.generation !== focusGeneration) return 5;
        if (guard.revision !== transitionRevision) return 6;
        if (guard.activity !== focusActivityRevision) return 7;
        if (guard.feature !== currentFeature) return 8;
        if (guard.subentry !== currentSubentry) return 9;
        if (guard.palette !== paletteOpen) return 10;
        if (transitionCommitting) return 11;
        if (!targetInFocusWindow(guard.target, guard.window)) return 12;
        if (!canFocus(guard.target)) return 13;
        return 0;
    }
    function focusGuardSnapshot(guard) {
        return {rejectCode: focusGuardRejectCode(guard), request: focusRequestRevision,
            expectedRequest: guard ? guard.request : null, revision: transitionRevision,
            expectedRevision: guard ? guard.revision : null, activity: focusActivityRevision,
            expectedActivity: guard ? guard.activity : null, palette: paletteOpen,
            committing: transitionCommitting};
    }
    function focusGuardCurrent(guard) {
        return focusGuardRejectCode(guard) === 0;
    }
    function applyFocusGuard(guard, reason, source) {
        const fields = focusGuardSnapshot(guard);
        if (fields.rejectCode !== 0) {
            focusDiagnostic("navigation-focus-rejected", fields);
            return false;
        }
        let restored = false;
        if (reason === Qt.OtherFocusReason)
            restored = focusItem(guard.target);
        else {
            guard.target.forceActiveFocus(reason);
            restored = focusTargetReached(guard.target);
        }
        focusDiagnostic("navigation-focus-applied", {request: guard.request,
            revision: guard.revision, activity: focusActivityRevision, restored: restored});
        if (restored && source)
            focusRestored(activeFocusItem, source);
        return restored;
    }
    function focusItemNow(item, reason, paletteExpected, source) {
        return applyFocusGuard(focusGuard(item, paletteExpected), reason, source);
    }
    function deferFocusItem(item, reason, paletteExpected, source, finished) {
        const guard = focusGuard(item, paletteExpected);
        Qt.callLater(() => {
            const restored = applyFocusGuard(guard, reason, source);
            if (typeof finished === "function")
                finished(restored);
        });
        return guard;
    }
    function featureFocusTarget(feature, fallbackItem, preferredItem) {
        return canFocus(preferredItem) ? preferredItem
                : canFocus(lastFocusedItem[feature]) ? lastFocusedItem[feature] : fallbackItem;
    }
    function restoreFeatureFocusNow(feature, fallbackItem, source, preferredItem) {
        if (paletteOpen || currentFeature !== feature)
            return false;
        return focusItemNow(featureFocusTarget(feature, fallbackItem, preferredItem),
            Qt.OtherFocusReason, false, source);
    }
    function deferFeatureFocus(feature, fallbackItem, source, finished, preferredItem) {
        if (paletteOpen || currentFeature !== feature) {
            if (typeof finished === "function") finished(false);
            return null;
        }
        const target = featureFocusTarget(feature, fallbackItem, preferredItem);
        return deferFocusItem(target, Qt.OtherFocusReason, false, source, finished);
    }
    function open(feature, subentry, sourceItem) {
        const nextSubentry = subentry || defaultSubentry(feature);
        if (!isAvailable(feature, nextSubentry))
            return;
        commitBefore(() => openCommitted(feature, nextSubentry, sourceItem));
    }
    function openCommitted(feature, subentry, sourceItem) {
        const previousFeature = currentFeature;
        const previousSubentry = currentSubentry;
        const wasPaletteOpen = paletteOpen;
        const changed = previousFeature !== feature || previousSubentry !== subentry;
        // Consumers capture entering state before cancelDrag can synchronously
        // finish a reduced-motion transition, and before page bindings change.
        const context = { previousFeature, previousSubentry, feature, subentry,
                          revision: transitionRevision + 1, changed,
                          fromPalette: wasPaletteOpen, window: focusWindow,
                          scope: focusScopeKey, generation: focusGeneration, focusActivity: focusActivityRevision };
        // The guard is not a destination mutation. Raise it after the snapshot
        // but before listeners change page geometry and finish an old portal.
        transitionCommitting = true;
        aboutToNavigate(context);
        cancelInteraction();
        if (previousFeature === "chat" && feature !== "chat") {
            chatReturnSubentry = previousSubentry || "companion";
            returnFocusItem = sourceItem || (wasPaletteOpen ? paletteReturnFocusItem : null) || lastFocusedItem.chat || fallbackFocusItem;
        }
        outgoingFeature = changed && previousFeature !== "chat" ? previousFeature : "";
        outgoingSubentry = outgoingFeature ? previousSubentry : "";
        if (wasPaletteOpen && changed)
            focusRestorationCancelled("palette");
        paletteOpen = false;
        transitionRevision += 1;
        currentSubentry = subentry;
        currentFeature = feature;
        if (feature === "chat")
            chatReturnSubentry = subentry;
        if (changed)
            enteredFeature(feature, subentry);
        if (previousFeature !== "chat" && feature === "chat")
            closeRequested();
        transitionCommitting = false;
        if (!changed && wasPaletteOpen)
            deferFeatureFocus(feature, fallbackFocusItem, "palette", null, paletteReturnFocusItem);
        else if (!changed && feature === "chat")
            restoreFeatureFocus("chat", fallbackFocusItem);
    }
    function toggle(feature, sourceItem) {
        if (currentFeature === feature && feature !== "chat")
            close();
        else
            open(feature, "", sourceItem);
    }
    function close() {
        commitBefore(() => {
            const wasOpen = surfaceOpen;
            const destination = wasOpen ? chatReturnSubentry : "companion";
            openCommitted("chat", destination, null);
            if (!wasOpen)
                restoreFocus();
        });
    }
    function showPalette(sourceItem) {
        commitBefore(() => {
            const returnItem = canFocus(lastFocusedItem[currentFeature]) ? lastFocusedItem[currentFeature]
                    : canFocus(activeFocusItem) ? activeFocusItem : sourceItem;
            transitionCommitting = true;
            cancelInteraction();
            paletteReturnFocusItem = returnItem;
            query = "";
            transitionRevision += 1;
            focusSuspended(paletteReturnFocusItem, "palette");
            paletteOpen = true;
            transitionCommitting = false;
            // Visibility/enabled bindings now describe the presented palette.
            // Its own focus-scope handoff must precede the search-focus guard.
            palettePresented();
        });
    }
    function dismissPalette() {
        commitBefore(() => {
            paletteOpen = false;
            transitionRevision += 1;
            deferFeatureFocus(currentFeature, fallbackFocusItem, "palette", null, paletteReturnFocusItem);
        });
    }
}
