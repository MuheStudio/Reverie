pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Dialogs
import QtQuick.Layouts

Item {
    id: chat
    objectName: "persistentChat"
    property var director
    property var navigation
    property var inputContext: navigation ? navigation.inputContext : null
    property var sceneSource
    property var blurredSource
    property Item sceneRoot
    property bool followLatest: true
    property real companionHistoryHeight: 250
    property alias composerItem: composer
    property alias historyItem: history
    property int readingPointerCount: 0
    readonly property bool readingPointerActive: readingPointerCount > 0
    readonly property string presentationMode: director ? director.mode : "companion"
    readonly property real taskProgress: director ? director.taskBlend : 0
    readonly property real readProgress: director ? director.readBlend : 0
    readonly property bool expandedHistory: director ? director.chatLayoutReading : readProgress >= .5
    readonly property bool geometryReady: director ? director.chatInputReady : presentationMode !== "task" && taskProgress < .001 && (presentationMode === "reading" ? readProgress > .999 : readProgress < .001) && (!navigation || !navigation.paletteOpen)
    readonly property bool inputReady: geometryReady && !layoutRestorePending
    readonly property rect historyRect: director ? director.historyRect : Qt.rect(0, 0, width, Math.max(100, height - 120))
    readonly property real historyBodyWidth: director ? director.historyBodyWidth : historyRect.width
    readonly property rect composerRect: director ? director.composerRect : Qt.rect(0, Math.max(100, height - 112), width, 112)
    readonly property rect companionBarRect: director ? director.companionBarRect : Qt.rect(0, Math.max(0, height - 148), width, 148)
    readonly property real bodyOpacity: director ? director.chatBodyOpacity : Math.max(0, 1 - taskProgress)
    readonly property real surfaceOpacity: director ? 1 - director.phaseWeight(0, .30, taskProgress) : Math.max(0, 1 - taskProgress)
    readonly property real readingBodyOpacity: director ? director.readBodyOpacity : 1
    readonly property url stagedImage: session.chatImagePreview ?? ""
    readonly property bool hasStagedImage: stagedImage.toString() !== ""
    readonly property string imageFeedback: session.chatImageFeedback || ""
    property var imagePickerOverride: null
    property var imagePickerScope: null
    readonly property real requestedComposerHeight: Math.max(68, Math.min(144, Math.ceil(composer.contentHeight) + 40))
        + (hasStagedImage ? 52 : 0) + (imageFeedback.length > 0 ? 19 : 0)
    readonly property var operationFeedback: session.chatFeedback || ({})
    readonly property bool feedbackTerminal: ["done", "cancelled", "failed", "failed_uncertain"].includes(operationFeedback.status)
    readonly property var cancelFeedback: operationFeedback.cancel || ({})
    readonly property bool cancelPending: !feedbackTerminal && cancelFeedback.status === "pending"
    // A completed reply is already visible as its bubble, so "已回复" is only a
    // short cue. Send-time refusals stay only while their cause still holds.
    // Stopped and failed outcomes persist until the next send replaces them.
    property int doneNoticeMs: 4000
    property bool doneNoticeActive: false
    property string doneNoticeKey: ""
    readonly property string operationText: {
        const status = operationFeedback.status;
        const text = operationFeedback.text || "";
        if (status === "done")
            return doneNoticeActive ? text : "";
        if (status === "paused")
            return session.state?.offline === true ? text : "";
        if (status === "gate_pending" || status === "gate_unknown")
            return session.networkFeedback?.known === true ? "" : text;
        // The reply-service gate shows its current cause and clears with it; nothing is sent by itself.
        if (["provider_unconfigured", "provider_pending", "provider_saving", "key_clearing", "key_clear_unconfirmed", "key_pending", "key_unconfirmed"].includes(status))
            return session.chatSendGate?.status ? (session.chatSendGate.text || text) : "";
        if (status === "disconnected")
            return session.connected ? "" : text;
        if (status === "restoring")
            return session.runtimeWritable === false ? text : "";
        return text;
    }
    readonly property string recoveryText: session.runtimeWritable === false ? (session.recoveryWarning || "本地数据可写状态尚未确认，写入暂停；草稿已保留。") : ""
    readonly property string feedbackText: recoveryText || (!feedbackTerminal && cancelFeedback.text)
                                          || operationText || (session.busy ? "正在组织回应" : "")
    readonly property bool feedbackIsError: recoveryText.length > 0 || (!feedbackTerminal && ["error", "unknown"].includes(cancelFeedback.status))
                                           || (operationText.length > 0
                                               && ["failed", "failed_uncertain", "gate_unknown", "disconnected", "key_unconfirmed", "key_clear_unconfirmed"].includes(operationFeedback.status))
    // An unread reply outranks a neutral status in the collapsed bar.
    readonly property string companionStatusText: (!session.busy && !feedbackIsError && unreadReplyCount > 0)
                                                  ? "有新回复" : (feedbackText || (unreadReplyCount > 0 ? "有新回复" : "对话仍在这里"))
    onOperationFeedbackChanged: {
        const key = operationFeedback.status === "done" ? "done:" + String(operationFeedback.requestId || "") : "";
        if (key === doneNoticeKey)
            return;
        doneNoticeKey = key;
        doneNoticeActive = key.length > 0;
        if (doneNoticeActive)
            doneNoticeTimer.restart();
        else
            doneNoticeTimer.stop();
    }
    Timer {
        id: doneNoticeTimer
        interval: chat.doneNoticeMs
        onTriggered: chat.doneNoticeActive = false
    }
    readonly property string latestReply: {
        const messages = session.messages;
        for (let index = messages.length - 1; index >= 0; --index) {
            if (messages[index].role === "assistant")
                return messages[index].content || "";
        }
        return "有想说的话，随时回来。";
    }
    // Companion rows before the latest exchange keep this fixed, hidden extent.
    // Zero heights would all fall inside the viewport, so ListView would create
    // every message with its full TextEdit layout on each list replacement and
    // each reading close.
    readonly property real companionSpacerHeight: 480
    // This signature gates scroll capture while a replacement QVariantList is
    // being laid out, including a reply arriving behind an open task surface.
    readonly property string messagesSignature: {
        const messages = session.messages;
        return messages.map((message, index) => messageKey(message, index) + ":" + String(message.content || "").length).join("|");
    }
    property var readingAnchor: ({
            messageId: "",
            index: 0,
            offset: 0,
            textPosition: 0,
            viewportOffset: 0,
            followLatest: true
        })
    property var messageSelections: ({})
    property var seenReplies: ({})
    property var unreadReplyIds: ({})
    property int unreadReplyCount: 0
    property string presentationPersonaId: ""
    property string presentationPersonaProof: ""
    property int presentationScopeRevision: 0
    property bool presentationHadMessages: false
    property string laidOutMessagesSignature: ""
    property string pendingFullMessageId: ""
    property string savedChatFocusKind: ""
    property string savedChatFocusMessageId: ""
    property int savedComposerCursor: 0
    property int savedComposerSelectionStart: 0
    property int savedComposerSelectionEnd: 0
    property real anchorViewportWidth: 0
    property real anchorViewportHeight: 0
    property bool restoringReading: false
    property bool restoringComposer: false
    property bool pendingChatFocus: false
    property bool pendingComposerFocus: false
    property bool pendingHistoryFocus: false
    property bool layoutRestorePending: true
    property bool hiddenRestoreQueued: false
    property int restoreAttempts: 0
    // Common A/B work counters; no view behavior depends on these values.
    property int restoreRequestCount: 0
    property int restoreExecutionCount: 0
    property int forceLayoutCount: 0

    function messageKey(message, index) {
        return String(message.id || message.message_id || message.delivery_id || (message.role + ":" + index));
    }
    function companionExchange() {
        // Read the list directly: a replaced model creates its rows while
        // panel bindings on the same list may still hold the previous value.
        const messages = session.messages;
        const last = messages[messages.length - 1];
        if (last?.source === "proactive" && last.proactive_id) {
            let first = messages.length - 1;
            while (first > 0 && messages[first - 1].source === "proactive" &&
                   messages[first - 1].proactive_id === last.proactive_id)
                --first;
            return {user: -1, assistant: messages.length - 1, first: first, proactive: true};
        }
        let assistant = -1;
        for (let index = messages.length - 1; index >= 0; --index) {
            const role = messages[index].role;
            if (role === "user")
                return {
                    user: index,
                    assistant: assistant,
                    first: index
                };
            if (role === "assistant" && assistant < 0)
                assistant = index;
        }
        return {
            user: -1,
            assistant: assistant,
            first: assistant
        };
    }
    function companionRowRole(index) {
        const exchange = companionExchange();
        if (exchange.proactive && index >= exchange.first && index <= exchange.assistant)
            return index === exchange.assistant ? "assistant" : "proactive";
        if (index === exchange.user)
            return "user";
        if (index === exchange.assistant)
            return "assistant";
        return exchange.first < 0 || index < exchange.first ? "spacer" : "tail";
    }
    function positionCompanionPreview() {
        if (history.count === 0)
            return;
        const first = companionExchange().first;
        if (first >= 0)
            history.positionViewAtIndex(first, ListView.Beginning);
        // As in the former collapsed layout, an exchange taller than the
        // viewport shows its end.
        const last = history.itemAtIndex(history.count - 1);
        if (first < 0 || !last || last.y + last.height > history.contentY + history.height + .5)
            history.positionViewAtEnd();
    }
    function resetPresentationState() {
        // RuntimeBridge clears its single message source when persona identity
        // changes. Reset only view state; its draft and business IDs stay owned
        // by the bridge.
        presentationScopeRevision++;
        seenReplies = ({});
        clearUnreadReplies();
        messageSelections = ({});
        followLatest = true;
        readingAnchor = {
            messageId: "",
            index: 0,
            offset: 0,
            textPosition: 0,
            viewportOffset: 0,
            followLatest: true
        };
        pendingFullMessageId = "";
        savedChatFocusKind = "";
        savedChatFocusMessageId = "";
        savedComposerCursor = 0;
        savedComposerSelectionStart = 0;
        savedComposerSelectionEnd = 0;
        presentationHadMessages = false;
        scheduleReadingRestore();
    }
    function syncPresentationScope() {
        const messages = session.messages;
        const persona = session.state.persona || ({});
        const scopedMessage = messages.find(message => !!message.persona_id);
        const personaId = String(persona.persona_id || (scopedMessage ? scopedMessage.persona_id : ""));
        const proof = persona.persona_epoch !== undefined ? String(persona.persona_epoch) + ":" + String(persona.persona_fingerprint || "") : "";
        const sourceCleared = messages.length === 0 && presentationHadMessages;
        const identityChanged = personaId && presentationPersonaId && personaId !== presentationPersonaId;
        const proofChanged = proof && presentationPersonaProof && proof !== presentationPersonaProof;
        if (sourceCleared || identityChanged || proofChanged) {
            resetPresentationState();
            presentationPersonaId = personaId;
            presentationPersonaProof = proof;
        } else {
            if (personaId)
                presentationPersonaId = personaId;
            if (proof)
                presentationPersonaProof = proof;
        }
        presentationHadMessages = messages.length > 0;
    }
    function observeReplies() {
        syncPresentationScope();
        const observed = Object.assign({}, seenReplies);
        const unread = Object.assign({}, unreadReplyIds);
        const messages = session.messages;
        let precedingUser = null;
        for (let index = 0; index < messages.length; ++index) {
            const message = messages[index];
            if (message.role === "user") {
                precedingUser = message;
                continue;
            }
            if (message.role !== "assistant")
                continue;
            // A live bubble's delivery ID is replaced by a durable history ID.
            // The preceding pending user ID is the same request ID retained by
            // both durable rows, so one response turn receives one cue.
            const proactiveId = message.source === "proactive" ? message.proactive_id : "";
            const requestId = message.request_id || (precedingUser ? precedingUser.request_id || precedingUser.id : "");
            const key = "scope:" + presentationScopeRevision + "|" + (proactiveId ? "proactive:" + proactiveId
                : requestId ? "turn:" + requestId : "message:" + messageKey(message, index));
            const content = String(message.content || "");
            if ((!followLatest || (proactiveId && (presentationMode === "task" || taskProgress > .001))) &&
                content.length && !observed[key])
                unread[key] = true;
            if (content.length)
                observed[key] = true;
        }
        seenReplies = observed;
        unreadReplyIds = unread;
        unreadReplyCount = Object.keys(unread).length;
    }
    function clearUnreadReplies() {
        unreadReplyIds = ({});
        unreadReplyCount = 0;
    }
    function acknowledgeVisibleProactiveReplies() {
        if (!followLatest || presentationMode === "task" || taskProgress > .001 || !geometryReady)
            return;
        const keys = Object.keys(unreadReplyIds);
        const remaining = keys.filter(key => !key.includes("|proactive:"));
        if (remaining.length !== keys.length) {
            const unread = ({});
            for (const key of remaining)
                unread[key] = true;
            unreadReplyIds = unread;
            unreadReplyCount = remaining.length;
        }
    }
    function requestComposerHeight() {
        if (director && composer)
            director.composerRequestedHeight = requestedComposerHeight;
    }
    function previewHeight(edit, maximumLines) {
        // Keep the complete document in the same TextEdit. The clip ends at a
        // real text line boundary instead of a guessed pixel row height.
        const contentHeight = edit.contentHeight;
        const textWidth = edit.width;
        if (contentHeight <= 0 || textWidth <= 0)
            return 0;
        let line = edit.positionToRectangle(0);
        if (line.height <= 0)
            return Math.min(contentHeight, maximumLines * messageMetrics.lineSpacing);
        for (let index = 1; index < maximumLines; ++index) {
            const position = edit.positionAt(0, line.y + line.height + .5);
            const next = edit.positionToRectangle(position);
            if (next.y <= line.y + .1)
                break;
            line = next;
        }
        return Math.min(contentHeight, line.y + line.height);
    }
    function captureChatFocus() {
        if (composer.activeFocus) {
            savedChatFocusKind = "composer";
            savedChatFocusMessageId = "";
            return;
        }
        for (let index = 0; index < history.count; ++index) {
            const item = history.itemAtIndex(index);
            if (item && item.messageEditor && item.messageEditor.activeFocus) {
                savedChatFocusKind = "message";
                savedChatFocusMessageId = item.messageId;
                return;
            }
        }
        if (history.activeFocus) {
            savedChatFocusKind = "history";
            savedChatFocusMessageId = "";
        }
    }
    function restoreChatFocus() {
        if (savedChatFocusKind === "composer") {
            composer.forceActiveFocus(Qt.OtherFocusReason);
            return true;
        }
        if (!expandedHistory)
            return false;
        if (savedChatFocusKind === "message") {
            for (let index = 0; index < history.count; ++index) {
                const item = history.itemAtIndex(index);
                if (item && item.messageId === savedChatFocusMessageId && item.messageEditor) {
                    item.messageEditor.forceActiveFocus(Qt.OtherFocusReason);
                    return true;
                }
            }
        }
        if (savedChatFocusKind === "history") {
            history.forceActiveFocus(Qt.OtherFocusReason);
            return true;
        }
        return false;
    }
    function captureComposerState() {
        if (restoringComposer)
            return;
        savedComposerCursor = composer.cursorPosition;
        savedComposerSelectionStart = composer.selectionStart;
        savedComposerSelectionEnd = composer.selectionEnd;
    }
    function restoreComposerState() {
        // Resizing an active draft must leave the native preedit cursor alone.
        if (composer.inputMethodComposing)
            return;
        restoringComposer = true;
        const length = composer.length;
        const first = Math.min(length, savedComposerSelectionStart);
        const last = Math.min(length, savedComposerSelectionEnd);
        composer.cursorPosition = Math.min(length, savedComposerCursor);
        if (first !== last)
            composer.select(savedComposerCursor === first ? last : first, savedComposerCursor === first ? first : last);
        restoringComposer = false;
    }
    function captureReadingAnchor() {
        captureComposerState();
        captureChatFocus();
        if (!expandedHistory || !geometryReady || layoutRestorePending || restoringReading || history.count === 0)
            return;
        let index = history.indexAt(history.contentX + 1, history.contentY + 1);
        // The top edge can lie in ListView spacing. Find the next visible row.
        for (let offset = 8; index < 0 && offset < Math.min(80, history.height); offset += 8)
            index = history.indexAt(history.contentX + 1, history.contentY + offset);
        if (index < 0)
            return;
        const item = history.itemAtIndex(index);
        const message = session.messages[index];
        if (!item || !message)
            return;
        const edit = item.messageEditor;
        const local = edit ? edit.mapFromItem(history, 0, 0) : null;
        const position = edit ? edit.positionAt(0, Math.max(0, local.y)) : -1;
        const caret = position >= 0 ? edit.positionToRectangle(position) : null;
        const viewportPoint = caret ? edit.mapToItem(history, caret.x, caret.y) : null;
        readingAnchor = {
            messageId: messageKey(message, index),
            index: index,
            offset: history.contentY - item.y,
            textPosition: Math.max(0, position),
            viewportOffset: viewportPoint ? viewportPoint.y : 0,
            followLatest: followLatest
        };
        anchorViewportWidth = history.width;
        anchorViewportHeight = history.height;
    }
    function updateCompanionHeight() {
        if (expandedHistory || !director)
            return;
        let previewHeight = 0;
        for (let index = 0; index < history.count; ++index) {
            const item = history.itemAtIndex(index);
            if (item && item.previewVisible)
                previewHeight += item.height;
        }
        const feedbackExtra = chatStatusRow.visible ? Math.max(0, chatStatusRow.implicitHeight - 14) : 0;
        companionHistoryHeight = Math.max(170, previewHeight + 78 + feedbackExtra);
        director.companionRequestedHeight = companionHistoryHeight;
    }
    function scheduleReadingRestore(blockInput) {
        restoreRequestCount++;
        if (blockInput !== false && geometryReady && !layoutRestorePending)
            captureChatFocus();
        if (blockInput !== false)
            layoutRestorePending = true;
        restoreAttempts = 0;
        restoreTimer.restart();
    }
    function prepareHiddenReadingLayout() {
        if (hiddenRestoreQueued)
            return;
        hiddenRestoreQueued = true;
        Qt.callLater(function () {
            hiddenRestoreQueued = false;
            if (readingBodyOpacity < .001 && taskProgress < .001 && (!navigation || !navigation.paletteOpen))
                restoreReadingAnchor();
        });
    }
    function restoreReadingAnchor() {
        // A passive height correction must not move the document or reset the
        // TextEdit's selection anchor while its native mouse drag is held.
        if (readingPointerActive)
            return false;
        restoreExecutionCount++;
        if (!expandedHistory) {
            restoringReading = true;
            forceLayoutCount++;
            history.forceLayout();
            positionCompanionPreview();
            laidOutMessagesSignature = messagesSignature;
            restoringReading = false;
            return true;
        }
        restoringReading = true;
        forceLayoutCount++;
        history.forceLayout();
        const targetMessageId = pendingFullMessageId || readingAnchor.messageId;
        const explicitMessage = pendingFullMessageId.length > 0;
        if (!explicitMessage && readingAnchor.followLatest) {
            history.positionViewAtEnd();
        } else if (history.count > 0) {
            const messages = session.messages;
            let index = messages.findIndex((message, position) => messageKey(message, position) === targetMessageId);
            if (index < 0)
                index = Math.min(history.count - 1, Math.max(0, readingAnchor.index));
            history.positionViewAtIndex(index, ListView.Beginning);
            forceLayoutCount++;
            history.forceLayout();
            const item = history.itemAtIndex(index);
            if (!item) {
                restoringReading = false;
                return false;
            }
            const minimum = history.originY;
            const maximum = Math.max(minimum, minimum + history.contentHeight - history.height);
            const edit = item.messageEditor;
            const textPosition = explicitMessage ? 0 : readingAnchor.textPosition;
            let contentY = item.y + (explicitMessage ? 0 : readingAnchor.offset);
            if (edit && textPosition !== undefined) {
                const caret = edit.positionToRectangle(Math.max(0, Math.min(edit.length, textPosition)));
                const viewportPoint = edit.mapToItem(history, caret.x, caret.y);
                if (Number.isFinite(viewportPoint.y))
                    contentY = history.contentY + viewportPoint.y - (explicitMessage ? 11 : readingAnchor.viewportOffset);
            }
            history.contentY = Math.max(minimum, Math.min(maximum, contentY));
            if (explicitMessage) {
                readingAnchor = {
                    messageId: messageKey(messages[index], index),
                    index: index,
                    offset: history.contentY - item.y,
                    textPosition: 0,
                    viewportOffset: edit ? edit.mapToItem(history, 0, edit.positionToRectangle(0).y).y : 0,
                    followLatest: false
                };
                pendingFullMessageId = "";
            }
        }
        followLatest = readingAnchor.followLatest;
        for (let index = 0; index < history.count; ++index) {
            const item = history.itemAtIndex(index);
            if (item && item.messageEditor)
                applyMessageSelection(item.messageId, item.messageEditor);
        }
        laidOutMessagesSignature = messagesSignature;
        anchorViewportWidth = history.width;
        anchorViewportHeight = history.height;
        restoringReading = false;
        return true;
    }
    function rememberMessageSelection(key, edit) {
        if (restoringReading)
            return;
        const remembered = Object.assign({}, messageSelections);
        remembered[key] = {
            cursor: edit.cursorPosition,
            start: edit.selectionStart,
            end: edit.selectionEnd
        };
        messageSelections = remembered;
    }
    function applyMessageSelection(key, edit) {
        const state = messageSelections[key];
        if (!state)
            return;
        const first = Math.min(edit.length, state.start);
        const last = Math.min(edit.length, state.end);
        edit.cursorPosition = Math.min(edit.length, state.cursor);
        if (first !== last)
            edit.select(state.cursor === first ? last : first, state.cursor === first ? first : last);
    }
    function focusComposer() {
        pendingComposerFocus = true;
        scheduleReadingRestore();
    }
    function focusEntrance() {
        if (!inputReady) {
            pendingChatFocus = true;
            scheduleReadingRestore();
            return;
        }
        if (expandedHistory)
            history.forceActiveFocus(Qt.OtherFocusReason);
        else
            focusComposer();
    }
    function openHistory() {
        pendingHistoryFocus = true;
        if (navigation)
            navigation.open("chat", "reading", openHistoryButton);
    }
    function openFullMessage(messageId, sourceItem) {
        captureReadingAnchor();
        pendingFullMessageId = messageId;
        followLatest = false;
        pendingHistoryFocus = true;
        if (navigation)
            navigation.open("chat", "reading", sourceItem || openHistoryButton);
        scheduleReadingRestore();
    }
    function closeHistory() {
        if (navigation)
            navigation.open("chat", "companion", closeHistoryButton);
        pendingComposerFocus = true;
        scheduleReadingRestore();
    }
    function continueConversation() {
        pendingChatFocus = true;
        if (navigation)
            navigation.close();
        scheduleReadingRestore();
    }
    function sendOrStop() {
        if (session.busy) {
            session.cancelChat();
            return;
        }
        const send = () => session.sendChat();
        if (inputContext && typeof inputContext.commitBefore === "function")
            inputContext.commitBefore(send);
        else {
            Qt.inputMethod.commit();
            send();
        }
    }
    function jumpToLatest() {
        followLatest = true;
        pendingFullMessageId = "";
        clearUnreadReplies();
        readingAnchor = Object.assign({}, readingAnchor, {
            followLatest: true
        });
        history.positionViewAtEnd();
        captureReadingAnchor();
    }

    function openChatImagePicker() {
        imagePickerScope = { scope: session.scopeKey, generation: session.connectionGeneration };
        if (imagePickerOverride)
            imagePickerOverride();
        else
            imageFileDialog.open();
    }

    function applyChatImage(file) {
        const picker = imagePickerScope;
        imagePickerScope = null;
        if (!picker || picker.scope !== session.scopeKey || picker.generation !== session.connectionGeneration)
            return false;
        return session.chooseChatImage(file);
    }

    FileDialog {
        id: imageFileDialog
        title: "选择图片"
        fileMode: FileDialog.OpenFile
        nameFilters: ["图片 (*.jpg *.jpeg *.png *.webp *.gif)", "所有文件 (*)"]
        onAccepted: chat.applyChatImage(selectedFile)
        onRejected: chat.imagePickerScope = null
    }

    onHistoryRectChanged: scheduleReadingRestore()
    onComposerRectChanged: scheduleReadingRestore()
    onPresentationModeChanged: {
        if (presentationMode === "task") {
            pendingChatFocus = false;
            pendingComposerFocus = false;
            pendingHistoryFocus = false;
        } else if (presentationMode === "companion") {
            pendingHistoryFocus = false;
        }
        scheduleReadingRestore();
    }
    onTaskProgressChanged: scheduleReadingRestore()
    onReadProgressChanged: scheduleReadingRestore()
    onExpandedHistoryChanged: {
        scheduleReadingRestore();
        prepareHiddenReadingLayout();
    }
    onHistoryBodyWidthChanged: {
        scheduleReadingRestore();
        prepareHiddenReadingLayout();
    }
    onRequestedComposerHeightChanged: requestComposerHeight()
    onDirectorChanged: requestComposerHeight()
    Component.onCompleted: {
        observeReplies();
        requestComposerHeight();
        scheduleReadingRestore();
    }

    FontMetrics {
        id: messageMetrics
        font.pixelSize: 16
    }
    Connections {
        target: session
        function onChanged() {
            chat.syncPresentationScope();
        }
        function onMessagesChanged() {
            chat.observeReplies();
            chat.scheduleReadingRestore();
        }
    }

    Connections {
        target: chat.navigation
        function onCancelInteraction() {
            chat.captureReadingAnchor();
        }
        function onPaletteOpenChanged() {
            if (!chat.navigation.paletteOpen)
                chat.scheduleReadingRestore();
        }
    }
    Timer {
        id: restoreTimer
        interval: 24
        onTriggered: {
            // Wait for stable geometry; interpolating frames must not rewrite
            // the saved reading anchor or move focus into a disappearing layer.
            if (!chat.geometryReady) {
                if (chat.presentationMode !== "task" && (!chat.navigation || !chat.navigation.paletteOpen))
                    restart();
                return;
            }
            if (chat.readingPointerActive || history.moving || history.dragging || history.flicking) {
                restart();
                return;
            }
            if (!chat.restoreReadingAnchor() && chat.restoreAttempts++ < 3) {
                restart();
                return;
            }
            chat.acknowledgeVisibleProactiveReplies();
            const inputWasBlocked = chat.layoutRestorePending;
            if (inputWasBlocked || chat.pendingComposerFocus || chat.pendingChatFocus)
                chat.restoreComposerState();
            chat.layoutRestorePending = false;
            chat.updateCompanionHeight();
            if (chat.pendingHistoryFocus && chat.expandedHistory) {
                chat.pendingHistoryFocus = false;
                chat.pendingComposerFocus = false;
                chat.pendingChatFocus = false;
                history.forceActiveFocus(Qt.OtherFocusReason);
            } else if (chat.pendingComposerFocus) {
                chat.pendingComposerFocus = false;
                chat.pendingChatFocus = false;
                composer.forceActiveFocus(Qt.OtherFocusReason);
            } else if (chat.pendingChatFocus) {
                chat.pendingChatFocus = false;
                if (chat.restoreChatFocus()) {
                    // A model refresh may have replaced a row delegate while
                    // its exact message, selection, and character anchor remain.
                } else if (chat.navigation)
                    chat.navigation.restoreFeatureFocus("chat", chat.expandedHistory ? history : composer);
                else
                    chat.focusEntrance();
            } else if (inputWasBlocked && chat.navigation && chat.navigation.currentFeature === "chat" && !chat.navigation.paletteOpen) {
                chat.restoreChatFocus();
            }
        }
    }

    GlassPane {
        id: historySurface
        objectName: "chatReadingSurface"
        x: chat.historyRect.x
        y: chat.historyRect.y
        width: Math.max(1, chat.historyRect.width)
        height: Math.max(1, chat.historyRect.height)
        padding: 16
        cornerRadius: 20
        materialRole: "reading"
        sceneSource: chat.sceneSource
        blurredSource: chat.blurredSource
        sceneRoot: chat.sceneRoot
        opacity: chat.surfaceOpacity
        visible: opacity > .001
        enabled: chat.geometryReady
        Item {
            anchors.fill: parent
            clip: true
            ColumnLayout {
                anchors.top: parent.top
                anchors.bottom: parent.bottom
                anchors.right: parent.right
                width: Math.max(1, chat.historyBodyWidth - historySurface.leftPadding - historySurface.rightPadding)
                opacity: chat.readingBodyOpacity
                spacing: 8
                RowLayout {
                    Layout.fillWidth: true
                    Text {
                        Layout.fillWidth: true
                        textFormat: Text.PlainText
                        text: chat.expandedHistory ? "此刻与过往" : "与你，共享此刻"
                        color: "#dae8ed"
                        font.pixelSize: chat.expandedHistory ? 19 : 14
                        font.weight: Font.Medium
                    }
                    GlassButton {
                        id: openHistoryButton
                        objectName: "openHistory"
                        visible: !chat.expandedHistory
                        text: "历史  ≋"
                        implicitHeight: 30
                        padding: 6
                        onClicked: chat.openHistory()
                    }
                    GlassButton {
                        id: closeHistoryButton
                        objectName: "closeHistory"
                        visible: chat.expandedHistory
                        text: "返回窗边"
                        implicitHeight: 32
                        padding: 7
                        onClicked: chat.closeHistory()
                    }
                }
                ListView {
                    id: history
                    objectName: "chatHistory"
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    spacing: 0
                    model: session.messages
                    enabled: chat.inputReady
                    interactive: chat.expandedHistory && chat.inputReady
                    activeFocusOnTab: chat.expandedHistory && chat.inputReady
                    reuseItems: false
                    // Lets the first companion preview reach the viewport top
                    // above the short tail of the conversation.
                    bottomMargin: chat.expandedHistory ? 0 : height
                    Accessible.role: Accessible.List
                    Accessible.name: "当前对话历史"
                    ScrollBar.vertical: ScrollBar {
                        id: historyScroll
                        policy: chat.expandedHistory ? ScrollBar.AsNeeded : ScrollBar.AlwaysOff
                    }
                    onContentYChanged: {
                        if (chat.inputReady && chat.expandedHistory && !chat.restoringReading && !restoreTimer.running && (moving || dragging || flicking || historyScroll.pressed) && chat.messagesSignature === chat.laidOutMessagesSignature && width === chat.anchorViewportWidth && height === chat.anchorViewportHeight) {
                            chat.followLatest = atYEnd;
                            if (chat.followLatest)
                                chat.clearUnreadReplies();
                            chat.captureReadingAnchor();
                        }
                    }
                    onMovementEnded: {
                        if (chat.expandedHistory && chat.inputReady && !chat.restoringReading) {
                            chat.followLatest = atYEnd;
                            if (chat.followLatest)
                                chat.clearUnreadReplies();
                            chat.captureReadingAnchor();
                        }
                    }
                    onModelChanged: {
                        // A replaced list restarts at the content top. Keep the
                        // latest exchange in place before the next frame.
                        if (!chat.expandedHistory)
                            chat.positionCompanionPreview();
                        chat.scheduleReadingRestore();
                    }
                    onCountChanged: chat.scheduleReadingRestore()
                    onContentHeightChanged: {
                        // Loading a row while the user scrolls can refine the
                        // ListView's height estimate. It must not cancel that scroll
                        // or replay the earlier anchor over the user's new position.
                        if (chat.messagesSignature !== chat.laidOutMessagesSignature || !chat.geometryReady || chat.layoutRestorePending)
                            chat.scheduleReadingRestore();
                        else if (!(moving || dragging || flicking || historyScroll.pressed))
                            chat.scheduleReadingRestore(false);
                        Qt.callLater(chat.updateCompanionHeight);
                    }
                    delegate: Item {
                        id: messageRow
                        required property var modelData
                        required property int index
                        readonly property string messageId: chat.messageKey(modelData, index)
                        readonly property string companionRole: chat.companionRowRole(index)
                        readonly property bool previewUser: companionRole === "user"
                        readonly property bool previewAssistant: companionRole === "assistant"
                        readonly property bool previewVisible: previewUser || previewAssistant || companionRole === "proactive"
                        // A page may start in the middle of a turn. Only the
                        // durable first bubble carries the source label.
                        readonly property bool proactiveFirst: modelData.source === "proactive" &&
                            !!modelData.proactive_id && modelData.bubble_index === 0
                        readonly property string imageId: {
                            if (modelData.role !== "user")
                                return "";
                            if (modelData.pending_chat_image)
                                return modelData.pending_chat_image;
                            const media = (modelData.media || []).find(item => item.mime === "image/jpeg"
                                && /^[0-9a-fA-F]{64}$/.test(item.media_id));
                            return media ? media.media_id : "";
                        }
                        readonly property var thumbnail: imageId ? (session.chatImageThumbnails?.[imageId] || ({})) : ({})
                        readonly property int previewLineCount: previewUser ? 1 : 4
                        readonly property real previewTextHeight: chat.previewHeight(messageText, previewLineCount)
                        property alias messageEditor: messageText
                        objectName: "chatMessageRow-" + messageId
                        width: history.width
                        height: chat.expandedHistory ? messageBox.implicitHeight + 14 : previewVisible ? messageBox.implicitHeight + 8 : companionRole === "spacer" ? chat.companionSpacerHeight : 0
                        visible: chat.expandedHistory || previewVisible
                        clip: true
                        onHeightChanged: if (!chat.expandedHistory)
                            Qt.callLater(chat.updateCompanionHeight)
                        Rectangle {
                            id: messageBox
                            width: parent.width * (messageRow.modelData.role === "user" ? .9 : 1)
                            implicitHeight: (chat.expandedHistory ? messageText.contentHeight : messageRow.previewTextHeight)
                                + 22 + (messageRow.proactiveFirst ? proactiveSource.implicitHeight + 4 : 0)
                                + (messageRow.imageId ? imageBody.height + 6 : 0)
                                + (!chat.expandedHistory && messageRow.previewAssistant ? 37 : 0)
                            height: implicitHeight
                            anchors.right: messageRow.modelData.role === "user" ? parent.right : undefined
                            radius: 12
                            color: messageRow.modelData.role === "user" ? "#5a3a545c" : "#4a14232f"
                            border.color: messageRow.modelData.role === "user" ? "#286a8c90" : "#1a4a6470"
                            Text {
                                id: proactiveSource
                                objectName: "proactiveSource-" + messageRow.messageId
                                x: 12
                                y: 11
                                visible: messageRow.proactiveFirst
                                text: "她主动发来"
                                textFormat: Text.PlainText
                                color: "#8fa7bb"
                                font.pixelSize: 11
                            }
                            Item {
                                id: imageBody
                                visible: messageRow.imageId !== ""
                                x: 12
                                y: 11
                                width: parent.width - 24
                                height: chat.expandedHistory ? 120 : 68
                                Image {
                                    objectName: "chatMessageImage-" + messageRow.messageId
                                    width: Math.min(parent.width, chat.expandedHistory ? 200 : 100)
                                    height: parent.height
                                    source: messageRow.thumbnail.source ?? ""
                                    cache: false
                                    fillMode: Image.PreserveAspectFit
                                    visible: status === Image.Ready
                                }
                                Text {
                                    objectName: "chatMessageImageError-" + messageRow.messageId
                                    visible: messageRow.thumbnail.status === "error"
                                    anchors.verticalCenter: parent.verticalCenter
                                    text: "图片读不到"
                                    textFormat: Text.PlainText
                                    color: "#e6b4a4"
                                    font.pixelSize: 13
                                }
                            }
                            Item {
                                id: textViewport
                                x: 12
                                y: 11 + (messageRow.proactiveFirst ? proactiveSource.implicitHeight + 4 : 0)
                                    + (messageRow.imageId ? imageBody.height + 6 : 0)
                                width: parent.width - 24
                                height: chat.expandedHistory ? messageText.contentHeight : messageRow.previewTextHeight
                                clip: !chat.expandedHistory
                                TextEdit {
                                    id: messageText
                                    objectName: "chatMessage-" + messageRow.messageId
                                    width: parent.width
                                    height: contentHeight
                                    text: messageRow.modelData.content || ""
                                    readOnly: true
                                    selectByMouse: chat.expandedHistory
                                    persistentSelection: true
                                    wrapMode: TextEdit.Wrap
                                    textFormat: TextEdit.PlainText
                                    font.pixelSize: 16
                                    color: messageRow.modelData.role === "user" ? "#e0eee7" : "#edf0f4"
                                    selectionColor: "#4b7588"
                                    property bool stateReady: false
                                    PointHandler {
                                        objectName: "chatReadingPointer-" + messageRow.messageId
                                        parent: messageText
                                        enabled: chat.expandedHistory && chat.geometryReady
                                        acceptedButtons: Qt.LeftButton
                                        target: null
                                        property bool counted: false
                                        onActiveChanged: {
                                            if (active && !counted) {
                                                counted = true;
                                                chat.readingPointerCount++;
                                            } else if (!active && counted) {
                                                counted = false;
                                                chat.readingPointerCount = Math.max(0, chat.readingPointerCount - 1);
                                            }
                                        }
                                        Component.onDestruction: if (counted)
                                            chat.readingPointerCount = Math.max(0, chat.readingPointerCount - 1)
                                    }
                                    onCursorPositionChanged: if (stateReady)
                                        chat.rememberMessageSelection(messageRow.messageId, messageText)
                                    onSelectionStartChanged: if (stateReady)
                                        chat.rememberMessageSelection(messageRow.messageId, messageText)
                                    onSelectionEndChanged: if (stateReady)
                                        chat.rememberMessageSelection(messageRow.messageId, messageText)
                                    Component.onCompleted: {
                                        chat.applyMessageSelection(messageRow.messageId, messageText);
                                        stateReady = true;
                                    }
                                }
                            }
                            GlassButton {
                                id: fullMessageButton
                                objectName: "openFullMessage-" + messageRow.messageId
                                visible: !chat.expandedHistory && messageRow.previewAssistant
                                x: 10
                                y: textViewport.y + textViewport.height + 5
                                text: "阅读全文 ↗"
                                implicitHeight: 28
                                padding: 5
                                onClicked: chat.openFullMessage(messageRow.messageId, fullMessageButton)
                            }
                        }
                        GlassButton {
                            objectName: "keepsakeMessage-" + messageRow.messageId
                            visible: chat.expandedHistory
                            x: messageRow.width - width - 4
                            y: messageBox.height - 10
                            width: 60
                            height: 24
                            padding: 0
                            font.pixelSize: 11
                            text: session.keepsakeMessageIds?.[messageRow.messageId] ? "已收藏" : "收藏"
                            enabled: session.keepsakeView?.writeAvailable === true &&
                                !session.keepsakeMessageIds?.[messageRow.messageId]
                            onClicked: session.collectKeepsake(messageRow.messageId)
                            ToolTip.visible: !!session.keepsakeView?.notice && session.keepsakeView?.messageId === messageRow.messageId
                            ToolTip.text: session.keepsakeView?.notice || ""
                            ToolTip.timeout: 5000
                        }
                    }
                    Column {
                        anchors.centerIn: parent
                        visible: history.count === 0
                        spacing: 8
                        Text {
                            anchors.horizontalCenter: parent.horizontalCenter
                            textFormat: Text.PlainText
                            text: "✧"
                            color: "#accfce"
                            font.pixelSize: 27
                        }
                        Text {
                            anchors.horizontalCenter: parent.horizontalCenter
                            textFormat: Text.PlainText
                            text: "从一句问候开始。"
                            color: "#a6bac8"
                            font.pixelSize: 13
                        }
                    }
                }
                RowLayout {
                    id: chatStatusRow
                    Layout.fillWidth: true
                    visible: chat.feedbackText.length > 0 || (chat.expandedHistory && !chat.followLatest)
                    onImplicitHeightChanged: Qt.callLater(chat.updateCompanionHeight)
                    onVisibleChanged: Qt.callLater(chat.updateCompanionHeight)
                    Text {
                        objectName: "chatFeedbackText"
                        Layout.fillWidth: true
                        textFormat: Text.PlainText
                        visible: text.length > 0
                        text: chat.feedbackText
                        color: chat.feedbackIsError ? "#e6b4a4" : "#b7d5cf"
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                    Text {
                        visible: chat.expandedHistory && !chat.followLatest && chat.unreadReplyCount > 0
                        textFormat: Text.PlainText
                        text: chat.unreadReplyCount === 1 ? "有新回复" : chat.unreadReplyCount + " 条新回复"
                        color: "#b9d7cc"
                        font.pixelSize: 12
                    }
                    GlassButton {
                        objectName: "chatLatest"
                        visible: chat.expandedHistory && !chat.followLatest
                        text: "回到最新 ↓"
                        implicitHeight: 30
                        padding: 6
                        onClicked: chat.jumpToLatest()
                    }
                }
            }
        }
    }

    GlassPane {
        id: composerSurface
        objectName: "chatComposerSurface"
        x: chat.composerRect.x
        y: chat.composerRect.y
        width: Math.max(1, chat.composerRect.width)
        height: Math.max(1, chat.composerRect.height)
        cornerRadius: 19
        padding: 10
        materialRole: "clear"
        sceneSource: chat.sceneSource
        blurredSource: chat.blurredSource
        sceneRoot: chat.sceneRoot
        focusHighlight: composer.activeFocus
        opacity: chat.surfaceOpacity
        visible: opacity > .001
        // The draft is independent of message-list restoration. Only the shared
        // scene handoff changes its input eligibility or native preedit focus.
        enabled: chat.geometryReady
        RowLayout {
            anchors.fill: parent
            spacing: 10
            opacity: chat.readingBodyOpacity
            ColumnLayout {
                Layout.fillWidth: true
                Layout.fillHeight: true
                spacing: 3
                RowLayout {
                    visible: chat.hasStagedImage
                    Layout.fillWidth: true
                    Layout.preferredHeight: 48
                    Image {
                        objectName: "chatImagePreview"
                        Layout.preferredWidth: 54
                        Layout.preferredHeight: 44
                        source: chat.stagedImage
                        cache: false
                        fillMode: Image.PreserveAspectFit
                    }
                    Text {
                        objectName: "chatImageDisclosure"
                        Layout.fillWidth: true
                        text: "图片会发送给当前的模型服务。"
                        textFormat: Text.PlainText
                        wrapMode: Text.Wrap
                        color: "#acbdc6"
                        font.pixelSize: 12
                    }
                    GlassButton {
                        objectName: "chatImageRemove"
                        text: "移除"
                        implicitHeight: 30
                        padding: 5
                        onClicked: session.removeChatImage()
                    }
                }
                Text {
                    objectName: "chatImageFeedback"
                    visible: chat.imageFeedback.length > 0
                    Layout.fillWidth: true
                    text: chat.imageFeedback
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: "#e6b4a4"
                    font.pixelSize: 12
                }
                ScrollView {
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    clip: true
                    TextArea {
                        id: composer
                        objectName: "chatComposer"
                        text: session.draft
                        placeholderText: "说说你现在的想法…"
                        placeholderTextColor: "#8299a9"
                        color: "#edf3f6"
                        font.pixelSize: 16
                        padding: 2
                        wrapMode: TextArea.Wrap
                        selectByMouse: true
                        persistentSelection: true
                        background: null
                        Accessible.name: "聊天草稿"
                        onTextChanged: if (session.draft !== text)
                            session.draft = text
                        onCursorPositionChanged: chat.captureComposerState()
                        onSelectionStartChanged: chat.captureComposerState()
                        onSelectionEndChanged: chat.captureComposerState()
                        Keys.onPressed: event => {
                            const composing = inputMethodComposing || (chat.inputContext && chat.inputContext.composing);
                            if (!composing && event.matches(StandardKey.Paste) && typeof session.pasteChatImage === "function"
                                && session.pasteChatImage()) {
                                event.accepted = true;
                                return;
                            }
                            if ((event.key === Qt.Key_Return || event.key === Qt.Key_Enter) && !(event.modifiers & Qt.ShiftModifier) && !composing) {
                                if (!session.busy)
                                    chat.sendOrStop();
                                event.accepted = true;
                            }
                        }
                    }
                }
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: "Enter 发送 · Shift + Enter 换行"
                    color: "#8198a8"
                    font.pixelSize: 10
                    elide: Text.ElideRight
                }
            }
            GlassButton {
                objectName: "chatImageChoose"
                visible: typeof session.chooseChatImage === "function"
                Layout.alignment: Qt.AlignBottom
                text: "图片"
                implicitHeight: 32
                padding: 6
                enabled: session.chatImageCanChoose === true
                onClicked: chat.openChatImagePicker()
            }
            GlassButton {
                objectName: "sendChat"
                Layout.alignment: Qt.AlignBottom
                text: session.busy ? (chat.cancelPending ? "正在停止…" : "停止") : "发送  ↗"
                implicitHeight: 32
                padding: 6
                accented: true
                enabled: session.busy ? !chat.cancelPending : chat.hasStagedImage ? session.chatImageCanSend === true
                    : (session.connected && session.runtimeWritable !== false && session.draft.trim().length > 0)
                onClicked: chat.sendOrStop()
            }
        }
    }

    GlassPane {
        id: companionBar
        objectName: "chatCompanionBar"
        x: chat.companionBarRect.x
        y: chat.companionBarRect.y
        width: Math.max(1, chat.companionBarRect.width)
        height: Math.max(1, chat.companionBarRect.height)
        padding: chat.director && chat.director.compact ? 8 : 12
        cornerRadius: 19
        materialRole: "work"
        sceneSource: chat.sceneSource
        blurredSource: chat.blurredSource
        sceneRoot: chat.sceneRoot
        opacity: chat.director ? chat.director.companionBarOpacity : chat.taskProgress
        visible: opacity > .001
        enabled: chat.presentationMode === "task" && chat.taskProgress > .999 && (!chat.navigation || !chat.navigation.paletteOpen)
        RowLayout {
            anchors.fill: parent
            spacing: 10
            ColumnLayout {
                Layout.fillWidth: true
                spacing: 3
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    objectName: "companionChatFeedback"
                    text: chat.companionStatusText + (session.draft.length ? " · 草稿已保留" : "")
                    color: chat.feedbackIsError ? "#e6b4a4" : "#b4c9d0"
                    font.pixelSize: 10
                    elide: Text.ElideRight
                }
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: chat.latestReply
                    color: "#e0e9ed"
                    font.pixelSize: 12
                    maximumLineCount: 1
                    elide: Text.ElideRight
                }
            }
            GlassButton {
                objectName: "compactStop"
                visible: session.busy
                text: chat.cancelPending ? "正在停止…" : "停止"
                enabled: !chat.cancelPending
                implicitHeight: 30
                padding: 5
                onClicked: session.cancelChat()
            }
            GlassButton {
                objectName: "continueChat"
                text: "继续对话 ↗"
                implicitHeight: 30
                padding: 6
                onClicked: chat.continueConversation()
            }
        }
    }
}
