import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Dialogs

Item {
    id: tasks
    property var navigation
    property string page: "settings"
    property var avatarItem
    readonly property bool diaryActive: page === "activities" && navigation?.currentSubentry === "diary"
    readonly property bool gomokuActive: page === "activities" && navigation?.currentSubentry === "gomoku"
    readonly property bool chessActive: page === "activities" && navigation?.currentSubentry === "chess"
    readonly property bool goActive: page === "activities" && navigation?.currentSubentry === "go"
    readonly property Item firstFocusItem: page === "activities"
        ? (diaryActive ? diaryPage.item?.firstFocusItem
            : gomokuActive ? gomokuPage.item?.firstFocusItem
            : chessActive ? chessPage.item?.firstFocusItem
            : goActive ? goPage.item?.firstFocusItem : xiangqiPage.item?.firstFocusItem) || null
        : page === "memory" ? (memoryTabs.currentIndex === 4 ? memoryRecallQuery : memoryRefresh)
        : [endpoint, splitMessagesSwitch, retentionShort, forgettingSwitch, misrememberSwitch, flawsSwitch, emotionSwitch, budgetSwitch][settingsTabs.currentIndex] || endpoint
    onDiaryActiveChanged: if (diaryActive && pageScroll) pageScroll.contentItem.contentY = 0
    onGomokuActiveChanged: if (gomokuActive && pageScroll) pageScroll.contentItem.contentY = 0
    onChessActiveChanged: if (chessActive && pageScroll) pageScroll.contentItem.contentY = 0
    onGoActiveChanged: if (goActive && pageScroll) pageScroll.contentItem.contentY = 0
    readonly property bool modalOpen: personaProfilePanel.visible || personaProfileSaveDialog.visible || personaProfileDiscardDialog.visible || consent.visible || modelFolder.visible || legacyFile.visible || backupSaveDialog.visible || backupOpenDialog.visible || backupConfirm.visible || personaConfirm.visible || personaCardFile.visible || personaImportConfirmDialog.visible || personaCardExportDialog.visible || personaCardSaveDialog.visible || retentionConfirm.visible || misrememberConfirm.visible || authorPromptConfirm.visible || profileClearDialog.visible || memoryBatchDeleteDialog.visible || memoryBatchPinDialog.visible || memoryCandidateBatchDialog.visible || avatarRemoveDialog.visible || xiangqiPage.item?.resetOpen === true || gomokuPage.item?.resetOpen === true || chessPage.item?.resetOpen === true
        || goPage.item?.resetOpen === true || goPage.item?.endOpen === true
    readonly property bool characterPageActive: page === "character" && (navigation?.currentFeature || "character") === "character"
    onCharacterPageActiveChanged: {
        if (!characterPageActive) {
            personaImportFeedbackReveal = null;
            if (typeof session.dismissAvatarRemovalSuccess === "function")
                session.dismissAvatarRemovalSuccess();
        }
    }
    readonly property var avatarRemovalFeedback: session.avatarRemovalFeedback || ({})
    readonly property var avatarRemovalContext: [session.state.avatars, session.avatarBusy, session.avatarCandidate,
        session.runtimeWritable, session.avatarRemovalFeedback]
    readonly property string avatarConsentImportId: session.avatarCandidate.importId || ""
    onAvatarConsentImportIdChanged: {
        if (rights) rights.checked = false;
        if (performanceWarning) performanceWarning.checked = false;
    }
    function avatarRemovalBlocker(id) {
        // These public properties notify the binding when the shared C++ gate
        // changes; a method's internal reads are not QML dependencies.
        return avatarRemovalContext.length === 5 && typeof session.modelRemovalBlocker === "function"
            ? session.modelRemovalBlocker(id) : "请等待当前操作完成。";
    }
    readonly property bool writesAllowed: session.runtimeWritable !== false
    readonly property var personaProfiles: session.state.personas?.profiles || []
    readonly property var personaFeedback: session.personaFeedback || ({})
    readonly property var personaCardCandidate: session.personaCardCandidate || ({})
    readonly property var personaCardFeedback: session.personaCardFeedback || ({})
    readonly property string personaImportResultKey: {
        const receipt = personaCardFeedback;
        return (receipt.status === "success" || receipt.status === "error") && receipt.text
            ? JSON.stringify([receipt.status, receipt.requestId || "", receipt.text]) : "";
    }
    property var personaImportFeedbackReveal: null
    onPersonaImportResultKeyChanged: armPersonaImportFeedbackReveal()
    function armPersonaImportFeedbackReveal() {
        personaImportFeedbackReveal = characterPageActive && visible && personaImportResultKey
            ? {key: personaImportResultKey, scope: session.scopeKey, generation: session.connectionGeneration} : null;
        queuePersonaImportFeedbackReveal();
    }
    function queuePersonaImportFeedbackReveal() {
        if (personaImportFeedbackReveal)
            Qt.callLater(tasks.revealPersonaImportFeedback);
    }
    function revealPersonaImportFeedback() {
        const intent = personaImportFeedbackReveal;
        if (!intent)
            return;
        if (!characterPageActive || !visible || intent.key !== personaImportResultKey ||
                intent.scope !== session.scopeKey || intent.generation !== session.connectionGeneration) {
            personaImportFeedbackReveal = null;
            return;
        }
        const scroll = pageScroll.contentItem;
        const feedback = personaImportFeedback;
        if (!enabled || !scroll || !feedback.visible || feedback.height <= 0 || scroll.height <= 0)
            return;
        if (scroll.dragging || scroll.flicking || pageScroll.ScrollBar.vertical?.pressed) {
            personaImportFeedbackReveal = null;
            return;
        }

        const top = feedback.mapToItem(scroll, 0, 0).y;
        const bottom = feedback.mapToItem(scroll, 0, feedback.height).y;
        if (top >= 0 && bottom <= scroll.height)
            return;

        // Bring a clipped receipt into view and leave room below it when it fits.
        const delta = top < 0 ? top : Math.min(top, bottom - scroll.height + 16);
        const minimum = scroll.originY - scroll.topMargin;
        const maximum = Math.max(minimum, scroll.originY + scroll.contentHeight - scroll.height + scroll.bottomMargin);
        const destination = Math.max(minimum, Math.min(maximum, scroll.contentY + delta));
        if (destination !== scroll.contentY)
            scroll.contentY = destination;
    }
    readonly property var personaCardExportState: session.personaCardExportState || ({})
    readonly property bool personaExportAvailable: session.personaCardExportAvailable === true
    readonly property int personaExportGeneration: session.connectionGeneration || 0
    onPersonaExportAvailableChanged: {
        if (!personaExportAvailable) {
            if (personaCardExportDialog) personaCardExportDialog.close();
            if (personaCardSaveDialog) personaCardSaveDialog.close();
        }
    }
    onPersonaExportGenerationChanged: {
        if (personaCardExportDialog) personaCardExportDialog.close();
        if (personaCardSaveDialog) personaCardSaveDialog.close();
    }
    // Both maps share the bridge's changed notification. React to their joint
    // state, not whichever QML binding happens to refresh first.
    readonly property bool personaCardConfirmationReady: page === "character" && personaCardFeedback.status === "confirmation" && !!personaCardCandidate.filename && personaCardCandidate.scopeKey === personaScope
    function syncPersonaCardConfirmation() {
        if (!personaImportConfirmDialog)
            return;
        if (personaCardConfirmationReady)
            personaImportConfirmDialog.open();
        else if (personaImportConfirmDialog.visible)
            personaImportConfirmDialog.close();
    }
    onPersonaCardConfirmationReadyChanged: syncPersonaCardConfirmation()
    Component.onCompleted: {
        syncPersonaCardConfirmation();
        syncPersonaProfileEditor();
        syncProfileClearConfirmation();
        loadFlawsField();
    }
    // The first-run sheet hands off to the service page, opened at its top.
    function showServicePage() {
        if (settingsTabs.currentIndex !== 0)
            pageScroll.contentItem.contentY = 0;
        settingsTabs.currentIndex = 0;
    }
    // Entering the memory page reads the list again from its first page, so
    // the page opens at its top rather than deep inside the replaced list.
    function showMemoryStart() {
        pageScroll.contentItem.contentY = 0;
    }
    readonly property bool personaSwitchAllowed: !session.personaProfilePending && session.connected && tasks.writesAllowed && !session.busy && !session.personaChanging && personaFeedback.status !== "pending" && personaCardFeedback.status !== "pending" && personaCardExportState.status !== "pending"
    readonly property var personaProfileState: session.personaProfileState || ({})
    readonly property bool personaProfileOpen: page === "character" && personaProfileState.open === true
    readonly property string personaProfileLoadedKey: personaProfileOpen ? personaProfileState.profile_id + ":" + personaProfileState.identity_version + ":" + personaProfileState.identity_fingerprint : ""
    property var personaProfileGreetings: []
    ListModel { id: personaProfileGreetingModel }
    function profileCharacterCount(value) { return Array.from(value || "").length; }
    function personaProfileTraits() {
        if (!personaProfileTraitsInput) return [];
        return personaProfileTraitsInput.text.split(/\r?\n/).map(value => value.trim()).filter(value => value.length > 0);
    }
    function personaProfileDraftFields() {
        if (!personaProfileDescriptionInput || !personaProfileToneInput || !personaProfileFirstInput || !personaProfileExampleInput)
            return {description: "", personality_traits: [], tone: "", first_message: "", alternate_greetings: [], message_example: ""};
        return {description: personaProfileDescriptionInput.text, personality_traits: personaProfileTraits(),
            tone: personaProfileToneInput.text, first_message: personaProfileFirstInput.text,
            alternate_greetings: personaProfileGreetings, message_example: personaProfileExampleInput.text};
    }
    readonly property var personaProfileDraft: personaProfileDraftFields()
    readonly property var personaProfileChangedFields: {
        const labels = {description: "档案正文", personality_traits: "性格特征", tone: "说话语气", first_message: "开场白", alternate_greetings: "备选问候", message_example: "对话示例"};
        const base = personaProfileState.fields || ({});
        return Object.keys(labels).filter(key => JSON.stringify(personaProfileDraft[key]) !== JSON.stringify(base[key])).map(key => labels[key]);
    }
    readonly property bool personaProfileDirty: personaProfileOpen && personaProfileChangedFields.length > 0
    readonly property bool personaProfileTraitsValid: personaProfileTraits().length >= 1 && personaProfileTraits().length <= 24 && personaProfileTraits().every(value => profileCharacterCount(value) >= 2 && profileCharacterCount(value) <= 160)
    readonly property bool personaProfileDraftValid: profileCharacterCount(personaProfileDescriptionInput.text) <= 24000 && personaProfileTraitsValid && profileCharacterCount(personaProfileToneInput.text) <= 2000 && profileCharacterCount(personaProfileFirstInput.text) <= 4000 && profileCharacterCount(personaProfileExampleInput.text) <= 8000 && personaProfileGreetings.length <= 20 && personaProfileGreetings.every(value => value.trim().length > 0 && profileCharacterCount(value) <= 4000)
    function setPersonaProfileGreeting(index, text) {
        if (index < 0 || index >= personaProfileGreetingModel.count) return;
        if (personaProfileGreetingModel.get(index).value !== text) personaProfileGreetingModel.setProperty(index, "value", text);
        syncPersonaProfileGreetings();
    }
    function syncPersonaProfileGreetings() {
        const values = []; for (let index = 0; index < personaProfileGreetingModel.count; ++index) values.push(personaProfileGreetingModel.get(index).value);
        personaProfileGreetings = values;
    }
    function addPersonaProfileGreeting() {
        if (personaProfileGreetingModel.count >= 20) return;
        personaProfileGreetingModel.append({value: ""}); syncPersonaProfileGreetings();
    }
    function removePersonaProfileGreeting(index) {
        personaProfileGreetingModel.remove(index); syncPersonaProfileGreetings();
    }
    function closePersonaProfileEditor() {
        if (personaProfileDirty) personaProfileDiscardDialog.open();
        else session.closePersonaProfile();
    }
    onPersonaProfileLoadedKeyChanged: syncPersonaProfileEditor()
    function syncPersonaProfileEditor() {
        if (!personaProfilePanel || !personaProfileSaveDialog || !personaProfileDiscardDialog || !personaProfileDescriptionInput || !personaProfileGreetingModel) return;
        if (!personaProfileOpen) {
            personaProfileSaveDialog.close(); personaProfileDiscardDialog.close(); personaProfilePanel.close();
            personaProfileDescriptionInput.text = ""; personaProfileTraitsInput.text = "";
            personaProfileToneInput.text = ""; personaProfileFirstInput.text = "";
            personaProfileExampleInput.text = ""; personaProfileGreetingModel.clear(); personaProfileGreetings = [];
            return;
        }
        const fields = personaProfileState.fields || ({});
        personaProfileDescriptionInput.text = fields.description || "";
        personaProfileTraitsInput.text = (fields.personality_traits || []).join("\n");
        personaProfileToneInput.text = fields.tone || "";
        personaProfileFirstInput.text = fields.first_message || "";
        personaProfileExampleInput.text = fields.message_example || "";
        personaProfileGreetingModel.clear();
        for (const value of fields.alternate_greetings || []) personaProfileGreetingModel.append({value: value});
        syncPersonaProfileGreetings();
        personaProfilePanel.open();
    }
    function personaProfileEditHint(profile) {
        if (["builtin", "builtin_legacy"].includes(profile.source_format)) return "内置人格不能编辑";
        return profile.active === true ? "使用中的人格不能编辑，请先切换到其他人格" : "";
    }
    // Unsaved edits belong to the live persona and cannot follow a switch.
    readonly property var unsavedDraftNames: [session.draft.trim().length > 0 ? "聊天草稿" : "", archiveEditor.dirty ? "世界书编辑" : "", profileDirty ? "你的资料编辑" : ""].filter(name => name.length > 0)
    function personaSourceLabel(format) {
        return ["builtin", "builtin_legacy"].includes(format) ? "内置人格" : "导入的角色卡";
    }
    function confirmPersonaSwitch(id, name) {
        personaConfirm.targetId = id;
        personaConfirm.targetName = name;
        personaConfirm.open();
    }
    // Card-author prompts: the archive review says what is stored and what is
    // sent; a switch shows its requested value only while that save is pending.
    readonly property var authorPrompts: archiveEditor.authorPrompts || ({})
    readonly property var authorPromptFeedback: archiveEditor.authorPromptFeedback || ({})
    function authorPromptName(kind) {
        return kind === "post_history" ? "卡作者对话后指令" : "卡作者系统提示";
    }
    function authorPromptFlagText(flags) {
        const names = {
            override_previous: "要求忽略之前的规则",
            prompt_reference: "提到系统提示或隐藏指令",
            instruction_marker: "伪装成系统指令的标记",
            exfiltration: "要求泄露提示或密钥",
            tool_execution: "要求执行命令或代码",
            memory_poisoning: "要求写入记忆"
        };
        return (flags || []).map(flag => names[flag] || flag).join("、");
    }
    function confirmAuthorPrompt(kind) {
        authorPromptConfirm.kind = kind;
        authorPromptConfirm.open();
    }
    // A new identity starts from its own saved profile; an edit typed for the
    // previous persona must not be saved into the next one.
    readonly property string personaScope: session.scopeKey
    onPersonaScopeChanged: {
        if (personaImportFeedbackReveal && personaImportFeedbackReveal.scope !== session.scopeKey)
            personaImportFeedbackReveal = null;
        personaCardExportDialog.close();
        personaCardSaveDialog.close();
        if (personaConfirm.visible)
            personaConfirm.close();
        if (authorPromptConfirm.visible)
            authorPromptConfirm.close();
        if (personaImportConfirmDialog.visible)
            personaImportConfirmDialog.close();
        if (profileClearDialog.visible)
            profileClearDialog.close();
        profileDirty = false;
        profileFieldEditRevisions = ({});
        profileClearStartRevision = -1;
        profileClearBoundSnapshot = "";
        profileClearBoundScope = "";
        profileSaveRequestId = "";
        profileSavingRevision = -1;
        editingMemoryId = "";
        deletingMemoryId = "";
        clearMemorySelection(true);
        clearCandidateSelection(true);
        for (const field of profileInputs)
            field.text = "";
        loadProfileFields();
    }
    property bool backupRescueSelection: false
    readonly property var backupSelection: session.state.backupRestore || ({})
    property int profileEditRevision: 0
    property int profileSavingRevision: -1
    property string profileSaveRequestId: ""
    property string processedActionRequestId: ""
    property bool profileDirty: false
    property var profileFieldEditRevisions: ({})
    property int profileClearStartRevision: -1
    property string profileClearBoundSnapshot: ""
    property string profileClearBoundScope: ""
    function profileEdited(name) {
        profileDirty = true;
        profileEditRevision++;
        const revisions = Object.assign({}, profileFieldEditRevisions);
        revisions[name] = profileEditRevision;
        profileFieldEditRevisions = revisions;
    }
    property bool providerDirty: false
    property string providerKind: "ollama"
    // Named cloud services use their published endpoint; the backend pins it.
    readonly property var providerOptions: [
        {
            value: "ollama",
            label: "本机服务（Ollama 或兼容）"
        },
        {
            value: "custom",
            label: "自定义 HTTPS 服务"
        },
        {
            value: "openai",
            label: "OpenAI"
        },
        {
            value: "anthropic",
            label: "Anthropic"
        },
        {
            value: "gemini",
            label: "Google Gemini"
        },
        {
            value: "grok",
            label: "xAI Grok"
        },
        {
            value: "deepseek",
            label: "DeepSeek"
        },
        {
            value: "kimi",
            label: "Kimi（月之暗面）"
        },
        {
            value: "glm",
            label: "智谱 GLM"
        }
    ]
    readonly property bool providerTakesAddress: providerKind === "ollama" || providerKind === "custom"
    readonly property var providerKey: session.state.providerKey || ({})
    function providerKeyStatusText() {
        if (!tasks.providerKey.available)
            return tasks.providerKey.error || "本机安全存储不可用，密钥无法保存。";
        // A delete whose stop the service did not confirm outranks the stored-key text.
        if (tasks.providerKey.clearState === "verifying")
            return "密钥已从钥匙串删除，正在核对本地服务是否已停用它…";
        if (tasks.providerKey.clearState === "held")
            return "密钥已从钥匙串删除，但本地服务仍在使用它。";
        if (tasks.providerKey.clearState === "unconfirmed")
            return "密钥已从钥匙串删除；本地服务是否已停用尚未确认。";
        if (tasks.providerKey.pending)
            return "正在把已保存的密钥交给本地服务…";
        if (!tasks.providerKey.stored)
            return "没有保存的密钥。";
        if (!tasks.providerKey.matches)
            return "已保存的密钥属于其他服务或地址，当前服务不会使用它；需要时请重新输入。";
        return tasks.providerKey.applied ? "密钥已保存在本机钥匙串，当前服务正在使用。" : "密钥已保存在本机钥匙串，尚未交给本地服务。";
    }
    property int providerEditRevision: 0
    property int providerSavingRevision: -1
    property string consentFeature: ""
    property string consentDigest: ""
    property int consentEpoch: -1
    readonly property var listFeedback: session.memoryFeedback?.list || ({})
    readonly property var actionFeedback: session.memoryFeedback?.action || ({})
    readonly property var candidateFeedback: session.memoryFeedback?.candidates || ({})
    readonly property var candidatePage: session.memoryCandidatePage || ({})
    readonly property var candidateRows: session.state.candidates?.candidates || []
    readonly property bool candidateActionsEnabled: memoryActionsEnabled && candidatePage.live === true && candidatePage.busy !== true && candidatePage.blocked !== true && !candidateSelectionMode
    property bool candidateWasBusy: false
    property bool candidateFocusEligible: false
    property bool candidateFocusPrepared: false
    property bool candidateFocusPending: false
    property int candidateSeenRevision: 0
    property var candidateFocusContext: null
    // Typed storage becomes null when a replaced delegate is destroyed.
    property Item candidateFocusSource: null
    property int candidateFocusSerial: 0
    // Fixed reasons describe a cancelled intent without recording input data.
    property string candidateFocusCancelReason: ""
    property int candidateFocusQueuedSerial: -1
    function insideCandidateArea(item) {
        for (let current = item; current; current = current.parent)
            if (current === candidateRegion)
                return true;
        return false;
    }
    function candidateFocusSnapshot() {
        // These getters share one changed signal. Reading them together avoids
        // mixing a new page binding with an old action or read receipt.
        const feedback = session.memoryFeedback || ({});
        return {
            connected: session.connected,
            scopeKey: session.scopeKey,
            page: session.memoryCandidatePage || ({}),
            action: feedback.action || ({}),
            list: feedback.list || ({}),
            candidates: feedback.candidates || ({}),
            rows: session.state.candidates?.candidates || []
        };
    }
    function cancelCandidateFocus(reason) {
        if (!candidateFocusContext)
            return;
        ++candidateFocusSerial;
        candidateFocusContext = null;
        candidateFocusSource = null;
        candidateFocusEligible = false;
        candidateFocusPrepared = false;
        candidateFocusPending = false;
        candidateFocusCancelReason = reason;
    }
    function candidateFocusPageActive() {
        const window = tasks.Window.window;
        return tasks.visible && page === "memory" && memoryTabs.currentIndex === 0 &&
                window && window.visible && window.active === true;
    }
    function prepareCandidateFocus(source, kind, targetId) {
        if (candidateFocusContext)
            cancelCandidateFocus("superseded");
        if (!source || !source.visible || !source.enabled || !insideCandidateArea(source) || !candidateFocusPageActive())
            return;
        const snapshot = candidateFocusSnapshot();
        const serial = ++candidateFocusSerial;
        candidateFocusSource = source;
        candidateFocusContext = {
            serial: serial, phase: "prepared", source: source, kind: kind,
            targetId: targetId || "", scopeKey: snapshot.scopeKey,
            startRevision: snapshot.page.revision || 0,
            oldActionId: snapshot.action.requestId || "",
            oldListReadId: snapshot.list.requestId || "",
            oldCandidateReadId: snapshot.candidates.requestId || "",
            actionRequestId: "", listReadId: "", candidateReadId: "",
            successListId: "", successCandidateReadId: "",
            actionSucceeded: false, ready: false,
            sourceHadFocus: source.activeFocus === true,
            sourceRemoved: false, fallbackAllowed: false
        };
        candidateFocusEligible = source.activeFocus === true;
        candidateFocusPrepared = true;
        candidateFocusPending = false;
        candidateFocusCancelReason = "";
    }
    function commitCandidateFocus(source, kind, targetId) {
        const prepared = candidateFocusContext;
        if (!prepared || prepared.phase !== "prepared" || prepared.source !== source ||
                prepared.kind !== kind || prepared.targetId !== (targetId || ""))
            prepareCandidateFocus(source, kind, targetId);
        const context = candidateFocusContext;
        if (!context)
            return -1;
        const snapshot = candidateFocusSnapshot();
        if (!candidateFocusPageActive() || context.scopeKey !== snapshot.scopeKey || !snapshot.connected) {
            cancelCandidateFocus(!snapshot.connected ? "disconnected" : context.scopeKey !== snapshot.scopeKey ? "scope" : "inactive");
            return -1;
        }
        // Commit before invoking the bridge: disabling the source may move its
        // focus synchronously during the first changed notification.
        candidateFocusContext = Object.assign({}, context, {
            phase: "committed", startRevision: snapshot.page.revision || 0,
            oldActionId: snapshot.action.requestId || "",
            oldListReadId: snapshot.list.requestId || "",
            oldCandidateReadId: snapshot.candidates.requestId || "",
            sourceHadFocus: context.sourceHadFocus || source.activeFocus === true
        });
        candidateFocusEligible = context.sourceHadFocus || source.activeFocus === true;
        candidateFocusPrepared = false;
        candidateFocusPending = true;
        return context.serial;
    }
    function cancelPreparedCandidateFocus(source) {
        // Business disabling can emit canceled after clicked has committed.
        const context = candidateFocusContext;
        if (context && context.phase === "prepared" && context.source === source)
            cancelCandidateFocus("press-canceled");
    }
    function releaseCandidateFocus(source) {
        const context = candidateFocusContext;
        if (!context || context.phase !== "prepared" || context.source !== source)
            return;
        const serial = context.serial;
        Qt.callLater(function () {
            const current = tasks.candidateFocusContext;
            if (serial === tasks.candidateFocusSerial && current?.serial === serial && current.phase === "prepared")
                tasks.cancelPreparedCandidateFocus(source);
        });
    }
    function candidateFocusRequestStarted(serial) {
        if (serial !== candidateFocusSerial || candidateFocusContext?.serial !== serial)
            return;
        reconcileCandidateFocus(false);
        const context = candidateFocusContext;
        if (context?.serial === serial && !(context.kind === "confirm" || context.kind === "reject"
                ? context.actionRequestId.length : context.candidateReadId.length))
            cancelCandidateFocus("no-request");
    }
    function candidateFocusFallbackItem(item) {
        const window = tasks.Window.window;
        return !item || item === tasks || item === window?.contentItem ||
                item === pageScroll || item === pageScroll.contentItem;
    }
    function candidateFocusSourceRemoved() {
        const context = candidateFocusContext;
        if (!context)
            return;
        if (context.phase === "prepared") {
            cancelCandidateFocus("press-canceled");
            return;
        }
        candidateFocusContext = Object.assign({}, context, {source: null, sourceRemoved: true});
        reconcileCandidateFocus(false);
    }
    onCandidateFocusSourceChanged: {
        if (!candidateFocusSource)
            candidateFocusSourceRemoved();
    }
    function queueCandidateFocusReconcile() {
        const context = candidateFocusContext;
        if (!context || context.phase !== "committed" || candidateFocusQueuedSerial === context.serial)
            return;
        const serial = context.serial;
        candidateFocusQueuedSerial = serial;
        Qt.callLater(function () {
            if (tasks.candidateFocusQueuedSerial === serial)
                tasks.candidateFocusQueuedSerial = -1;
            if (serial === tasks.candidateFocusSerial && tasks.candidateFocusContext?.serial === serial)
                tasks.reconcileCandidateFocus(true);
        });
    }
    function reconcileCandidateFocus(allowTransfer) {
        const snapshot = candidateFocusSnapshot();
        candidateWasBusy = snapshot.page.busy === true;
        candidateSeenRevision = snapshot.page.revision || 0;
        const context = candidateFocusContext;
        if (!context)
            return;
        if (!snapshot.connected || snapshot.scopeKey !== context.scopeKey || snapshot.page.live !== true) {
            cancelCandidateFocus(!snapshot.connected ? "disconnected" : snapshot.scopeKey !== context.scopeKey ? "scope" : "not-live");
            return;
        }
        if (context.phase !== "committed")
            return;
        const current = Object.assign({}, context);
        const decision = current.kind === "confirm" || current.kind === "reject";
        if (decision) {
            const actionId = snapshot.action.requestId || "";
            if (!current.actionRequestId && actionId && actionId !== current.oldActionId)
                current.actionRequestId = actionId;
            if (current.actionRequestId) {
                const expectedVerb = current.kind === "confirm" ? "记住这条" : "不记这条";
                if (actionId !== current.actionRequestId || snapshot.action.subjectId !== current.targetId ||
                        snapshot.action.verb !== expectedVerb || !["pending", "success"].includes(snapshot.action.status) ||
                        (current.actionSucceeded && snapshot.action.status !== "success")) {
                    cancelCandidateFocus("receipt");
                    return;
                }
                if (!current.actionSucceeded && snapshot.action.status === "success") {
                    // Observe the action's own notification before its bridge
                    // starts either read. Reads already visible cannot count.
                    current.actionSucceeded = true;
                    current.successListId = snapshot.list.requestId || "";
                    current.successCandidateReadId = snapshot.candidates.requestId || "";
                } else if (current.actionSucceeded) {
                    const listId = snapshot.list.requestId || "";
                    if (!current.listReadId && listId && listId !== current.oldListReadId && listId !== current.successListId)
                        current.listReadId = listId;
                    const candidateId = snapshot.candidates.requestId || "";
                    if (!current.candidateReadId && candidateId && candidateId !== current.oldCandidateReadId && candidateId !== current.successCandidateReadId)
                        current.candidateReadId = candidateId;
                }
            }
        } else {
            const candidateId = snapshot.candidates.requestId || "";
            if (!current.candidateReadId && candidateId && candidateId !== current.oldCandidateReadId)
                current.candidateReadId = candidateId;
        }
        if ((current.listReadId && (snapshot.list.requestId !== current.listReadId || !["pending", "success"].includes(snapshot.list.status))) ||
                (current.candidateReadId && (snapshot.candidates.requestId !== current.candidateReadId ||
                snapshot.page.readRequestId !== current.candidateReadId || !["pending", "success"].includes(snapshot.candidates.status)))) {
            cancelCandidateFocus("receipt");
            return;
        }
        const started = decision ? !!current.actionRequestId : !!current.candidateReadId;
        // blocked is expected while a decision or either of its reads is busy.
        if (started && snapshot.page.busy !== true && snapshot.page.decisionBusy !== true &&
                (snapshot.page.blocked === true || snapshot.page.needsRefresh === true)) {
            cancelCandidateFocus("terminal-blocked");
            return;
        }
        const source = candidateFocusSource;
        if (started && current.sourceHadFocus &&
                (snapshot.page.busy === true || (snapshot.page.revision || 0) > current.startRevision) &&
                (current.sourceRemoved || !source || !source.enabled || !source.visible))
            current.fallbackAllowed = true;
        const active = tasks.Window.window?.activeFocusItem;
        if (!(source && active === source) && !(current.fallbackAllowed && candidateFocusFallbackItem(active))) {
            cancelCandidateFocus("focus");
            return;
        }
        current.ready = !!current.candidateReadId && snapshot.candidates.status === "success" &&
                (!decision || (current.actionSucceeded && !!current.listReadId && snapshot.list.status === "success")) &&
                (snapshot.page.revision || 0) > current.startRevision;
        candidateFocusContext = current;
        if (!allowTransfer) {
            queueCandidateFocusReconcile();
            return;
        }
        if (!current.ready || snapshot.page.busy === true || snapshot.page.decisionBusy === true ||
                snapshot.page.blocked === true || snapshot.page.needsRefresh === true || !candidateFocusPageActive())
            return;
        const emptyTail = snapshot.page.pageNumber > 1 && snapshot.rows.length === 0 && snapshot.page.hasMore === false;
        if (emptyTail && (!candidateFirst.visible || !candidateFirst.enabled))
            return;
        const transfer = emptyTail && candidateFocusEligible;
        // Consume first: the focus notification must not re-enter this intent.
        ++candidateFocusSerial;
        candidateFocusContext = null;
        candidateFocusSource = null;
        candidateFocusEligible = false;
        candidateFocusPrepared = false;
        candidateFocusPending = false;
        if (transfer)
            candidateFirst.forceActiveFocus(Qt.OtherFocusReason);
    }
    onCandidatePageChanged: queueCandidateFocusReconcile()
    onCandidateFeedbackChanged: queueCandidateFocusReconcile()
    onPageChanged: {
        if (page !== "memory")
            cancelCandidateFocus("page");
        if (page !== "character") {
            if (avatarRemoveDialog) avatarRemoveDialog.close();
            if (personaCardExportDialog) personaCardExportDialog.close();
            if (personaCardSaveDialog) personaCardSaveDialog.close();
        }
    }
    onVisibleChanged: {
        if (!visible) {
            cancelCandidateFocus("hidden");
            personaImportFeedbackReveal = null;
            if (avatarRemoveDialog) avatarRemoveDialog.close();
        }
    }
    onEnabledChanged: if (enabled) queuePersonaImportFeedbackReveal()
    WheelHandler {
        parent: pageScroll.contentItem || pageScroll
        target: null
        enabled: tasks.personaImportFeedbackReveal !== null
        acceptedDevices: PointerDevice.Mouse | PointerDevice.TouchPad
        blocking: false
        onWheel: event => {
            tasks.personaImportFeedbackReveal = null;
            event.accepted = false;
        }
    }
    Connections {
        target: pageScroll.contentItem
        enabled: tasks.personaImportFeedbackReveal !== null
        function onDraggingChanged() {
            if (pageScroll.contentItem.dragging)
                tasks.personaImportFeedbackReveal = null;
        }
    }
    Connections {
        target: pageScroll.ScrollBar.vertical
        enabled: tasks.personaImportFeedbackReveal !== null
        function onPressedChanged() {
            if (pageScroll.ScrollBar.vertical.pressed)
                tasks.personaImportFeedbackReveal = null;
        }
    }
    Connections {
        target: tasks.Window.window
        function onActiveFocusItemChanged() {
            tasks.reconcileCandidateFocus(false);
        }
        function onActiveChanged() {
            if (tasks.Window.window?.active !== true)
                tasks.cancelCandidateFocus("inactive");
        }
        function onVisibleChanged() {
            if (tasks.Window.window?.visible !== true)
                tasks.cancelCandidateFocus("inactive");
        }
    }
    Connections {
        target: tasks.candidateFocusSource
        function onEnabledChanged() { tasks.reconcileCandidateFocus(false); }
        function onVisibleChanged() { tasks.reconcileCandidateFocus(false); }
    }
    Connections {
        // Observe the focused item's BeforeItem Keys, including keys a control
        // consumes. Leaving accepted untouched preserves its normal handling.
        target: tasks.candidateFocusContext && tasks.Window.window?.activeFocusItem ? tasks.Window.window.activeFocusItem.Keys : null
        function onPressed(event) { tasks.cancelCandidateFocus("input"); }
        function onShortcutOverride(event) { tasks.cancelCandidateFocus("input"); }
    }
    Item {
        id: candidatePointerObservationLayer
        objectName: "candidatePointerObservationLayer"
        parent: tasks.Window.window ? tasks.Window.window.contentItem : null
        x: 0
        y: 0
        width: parent ? parent.width : 0
        height: parent ? parent.height : 0
        z: 1000000
        focus: false
        activeFocusOnTab: false
        PointHandler {
            id: candidatePointerObserver
            objectName: "candidatePointerObserver"
            target: null
            enabled: tasks.visible && tasks.page === "memory"
            acceptedButtons: Qt.AllButtons
            grabPermissions: PointerHandler.ApprovesTakeOverByAnything
            onActiveChanged: {
                // The initiating press may reach this observer after onPressed;
                // only an already committed operation can be revoked by it.
                if (active && tasks.candidateFocusContext?.phase === "committed")
                    tasks.cancelCandidateFocus("input");
            }
        }
    }
    WheelHandler {
        parent: tasks.Window.window ? tasks.Window.window.contentItem : tasks
        target: null
        enabled: tasks.visible && tasks.page === "memory"
        blocking: false
        onWheel: event => {
            if (tasks.candidateFocusContext?.phase === "committed")
                tasks.cancelCandidateFocus("input");
            event.accepted = false;
        }
    }
    readonly property var profileFeedback: session.memoryFeedback?.profile || ({})
    readonly property var memoryRecallState: session.memoryRecallState || ({})
    readonly property int memoryRecallInputEpoch: memoryRecallState.inputEpoch || 0
    onMemoryRecallInputEpochChanged: {
        if (memoryRecallQuery)
            memoryRecallQuery.text = "";
    }
    function submitMemoryRecall() {
        if (!session.connected || session.personaChanging || memoryRecallState.status === "pending" || memoryRecallQuery.inputMethodComposing)
            return;
        session.queryRelatedMemories(memoryRecallQuery.text);
    }
    function memoryRecallModeLabel(mode) {
        return mode === "hybrid" ? "本地混合检索" : mode === "lexical_fallback" ? "词法回退" : "检索方式未确认";
    }
    readonly property var profileClearState: session.profileClearState || ({})
    readonly property bool profileClearBlocked: ["pending", "unknown"].includes(profileClearState.status) || !!profileClearState.manualRefreshing
    readonly property var profileClearChoices: [
        { key: "name", label: "名字" }, { key: "nickname", label: "称呼" },
        { key: "birthday", label: "生日" }, { key: "identity", label: "身份或近况" },
        { key: "schedule", label: "作息" }, { key: "interests", label: "兴趣" },
        { key: "hobbies", label: "爱好" }, { key: "favorite_topics", label: "喜欢聊的话题" },
        { key: "favorite_games", label: "喜欢的游戏" }, { key: "favorite_anime", label: "喜欢的动漫" },
        { key: "age", label: "年龄" }
    ]
    property var profileClearSelectedFields: []
    readonly property bool profileClearConfirmationReady: page === "memory" && profileClearState.status === "confirmation" && session.connected && writesAllowed && !profileDirty && profileFeedback.status !== "pending" && profileClearState.scopeKey === personaScope && profileClearState.profileSnapshot === session.state.profile?.profile_snapshot
    function syncProfileClearConfirmation() {
        if (!profileClearDialog)
            return;
        if (profileClearConfirmationReady && !profileClearDialog.visible) {
            profileClearSelectedFields = [];
            profileClearDialog.open();
        } else if (!profileClearConfirmationReady && profileClearDialog.visible)
            profileClearDialog.close();
    }
    onProfileClearConfirmationReadyChanged: syncProfileClearConfirmation()
    readonly property string profileClearReadbackKey: profileClearStartRevision >= 0 && profileClearState.scopeKey === profileClearBoundScope && profileClearState.profileSnapshot === profileClearBoundSnapshot && profileClearState.currentProfileSnapshot === session.state.profile?.profile_snapshot ? (profileClearState.currentProfileReadId || "") : ""
    onProfileClearReadbackKeyChanged: {
        if (!profileClearReadbackKey.length)
            return;
        // An authoritative read updates fields the person has not touched
        // since confirming. A new edit, including one in a cleared field,
        // remains a draft and must never be overwritten by the read-back.
        const values = profileTextValues(session.state.profile?.profile || ({}));
        for (const field of profileInputs)
            if ((profileFieldEditRevisions[field.objectName] || 0) <= profileClearStartRevision && values[field.objectName] !== undefined)
                field.text = values[field.objectName];
    }
    readonly property var backupFeedback: session.memoryFeedback?.backup || ({})
    function openBackupSave() {
        backupSaveDialog.selectedFile = session.suggestedBackupFile();
        backupSaveDialog.open();
    }
    readonly property var savedProfile: session.state.profile?.profile || null
    function profileTextValues(profile) {
        return {
            profileName: profile.name || "",
            profileNickname: profile.nickname || "",
            profileBirthday: profile.birthday || "",
            profileIdentity: profile.identity || "",
            profileSchedule: profile.schedule || "",
            profileInterests: (profile.interests || []).join("，"),
            profileHobbies: (profile.hobbies || []).join("，"),
            profileTopics: (profile.favorite_topics || []).join("，"),
            profileFavoriteGames: (profile.favorite_games || []).join("，"),
            profileFavoriteAnime: (profile.favorite_anime || []).join("，"),
            // A stored age outside 18-120 is shown as it is; saving explains it.
            profileAge: Number.isInteger(profile.age) ? String(profile.age) : ""
        };
    }
    // Fill the profile fields from the saved profile unless the person has an
    // unsaved edit; assigning only changed text keeps the caret in place.
    function loadProfileFields() {
        if (profileDirty || !savedProfile)
            return;
        const values = profileTextValues(savedProfile);
        for (const field of profileInputs) {
            const value = values[field.objectName];
            if (value !== undefined && field.text !== value)
                field.text = value;
        }
    }
    readonly property var profileInputs: [profileNameField, profileNicknameField, profileBirthdayField, profileScheduleField, profileIdentityField, profileInterestsField, profileHobbiesField, profileTopicsField, profileFavoriteGamesField, profileFavoriteAnimeField, profileAgeField]
    onSavedProfileChanged: loadProfileFields()
    onProfileFeedbackChanged: {
        if (profileFeedback.status === "pending" && profileFeedback.requestId !== profileSaveRequestId) {
            profileSaveRequestId = profileFeedback.requestId || "";
            profileSavingRevision = profileEditRevision;
        } else if (profileSaveRequestId.length && profileFeedback.requestId === profileSaveRequestId && profileFeedback.status !== "pending") {
            profileSaveRequestId = "";
            if (profileFeedback.status === "success" && profileSavingRevision === profileEditRevision) {
                profileDirty = false;
                loadProfileFields();
            }
        }
    }
    readonly property var memoryRows: session.state.memory?.memories || []
    function memoryImportanceText(value) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1)
            return "—";
        return (Math.round(value * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
    }
    readonly property var memoryBatchDelete: session.memoryBatchDelete || ({})
    readonly property var memoryBatchPin: session.memoryBatchPin || ({})
    readonly property var memoryCandidateBatch: session.memoryCandidateBatch || ({})
    readonly property int candidateRevision: candidatePage.revision || 0
    readonly property int memoryListRevision: session.memoryListRevision || 0
    readonly property bool memoryBatchDeleteBlocked: memoryBatchDelete.blocked === true
    readonly property bool memoryBatchPinBlocked: memoryBatchPin.blocked === true
    readonly property bool candidateBatchBlocked: memoryCandidateBatch.blocked === true
    readonly property bool candidateDecisionLocked: candidatePage.decisionLocked === true || candidatePage.decisionBusy === true
    readonly property bool memoryActionsEnabled: session.connected && tasks.writesAllowed && actionFeedback.status !== "pending" && !memoryBatchDeleteBlocked && !memoryBatchPinBlocked && !candidateBatchBlocked
    readonly property bool singleMemoryActionsEnabled: memoryActionsEnabled && !memorySelectionMode
    property bool memorySelectionMode: false
    property var memorySelectedIds: []
    property string processedMemoryBatchRequestId: ""
    property string processedMemoryPinResultKey: ""
    property bool candidateSelectionMode: false
    property var candidateSelectedIds: []
    property string processedCandidateBatchResultKey: ""
    readonly property bool candidateSelectionEditable: candidateSelectionMode && memoryActionsEnabled && !candidateDecisionLocked && candidatePage.live === true && candidatePage.busy !== true && candidatePage.needsRefresh !== true
    readonly property bool candidateSelectionCanDecide: candidateSelectionEditable && candidateSelectedIds.length > 0 && candidateSelectedIds.length <= 100 && candidateSelectedIds.every((id, index) => typeof id === "string" && id.length > 0 && candidateSelectedIds.indexOf(id) === index && candidateRows.some(row => row.id === id))
    readonly property bool candidateDialogCurrent: candidateSelectionMode && memoryCandidateBatchDialog.scopeKey === personaScope && memoryCandidateBatch.scopeKey === personaScope && memoryCandidateBatch.generation === memoryCandidateBatchDialog.generation && memoryCandidateBatchDialog.candidateRevision === candidateRevision && memoryCandidateBatch.candidateRevision === candidateRevision && memoryCandidateBatch.previewRequestId === memoryCandidateBatchDialog.previewRequestId && memoryCandidateBatch.confirm === memoryCandidateBatchDialog.confirm && memoryCandidateBatchDialog.candidateIds.length === candidateSelectedIds.length && memoryCandidateBatch.ids?.length === candidateSelectedIds.length && memoryCandidateBatchDialog.candidateIds.every((id, index) => id === candidateSelectedIds[index] && id === memoryCandidateBatch.ids[index])
    readonly property bool candidatePreviewReady: candidateDialogCurrent && memoryCandidateBatch.status === "ready"
    readonly property bool candidateConfirmationReady: candidatePreviewReady && memoryCandidateBatch.confirmationReady === true
    readonly property int memorySelectedPinnedCount: memoryRows.filter(row => row.pinned === true && memorySelectedIds.includes(row.id)).length
    readonly property bool memorySelectionEditable: memorySelectionMode && memoryActionsEnabled && !candidateDecisionLocked && listFeedback.status !== "pending"
    readonly property bool memorySelectionCanDelete: memorySelectionEditable && memorySelectedIds.length > 0 && memorySelectedIds.length <= 100 && memorySelectedIds.every((id, index) => typeof id === "string" && id.length > 0 && memorySelectedIds.indexOf(id) === index && memoryRows.some(row => row.id === id))
    readonly property bool memoryBatchConfirmationReady: memorySelectionCanDelete && memoryBatchDeleteDialog.scopeKey === personaScope && memoryBatchDeleteDialog.listRevision === memoryListRevision && memoryBatchDeleteDialog.memoryIds.length === memorySelectedIds.length && memoryBatchDeleteDialog.memoryIds.every((id, index) => id === memorySelectedIds[index])
    readonly property bool memoryPinDialogCurrent: memorySelectionMode && memoryBatchPinDialog.scopeKey === personaScope && memoryBatchPin.scopeKey === personaScope && memoryBatchPin.generation === memoryBatchPinDialog.generation && memoryBatchPinDialog.listRevision === memoryListRevision && memoryBatchPin.listRevision === memoryListRevision && memoryBatchPin.previewRequestId === memoryBatchPinDialog.previewRequestId && memoryBatchPin.pinned === memoryBatchPinDialog.pinned && memoryBatchPinDialog.memoryIds.length === memorySelectedIds.length && memoryBatchPin.ids?.length === memorySelectedIds.length && memoryBatchPinDialog.memoryIds.every((id, index) => id === memorySelectedIds[index] && id === memoryBatchPin.ids[index])
    readonly property bool memoryPinPreviewReady: memoryPinDialogCurrent && memoryBatchPin.status === "ready"
    readonly property bool memoryPinConfirmationReady: memoryPinPreviewReady && memoryBatchPin.confirmationReady === true
    function clearMemorySelection(exitMode) {
        memorySelectedIds = [];
        if (exitMode)
            memorySelectionMode = false;
        if (memoryBatchDeleteDialog && memoryBatchDeleteDialog.visible)
            memoryBatchDeleteDialog.close();
        if (memoryBatchPinDialog && memoryBatchPinDialog.visible)
            memoryBatchPinDialog.close();
    }
    function beginMemorySelection() {
        if (!memoryActionsEnabled || candidateDecisionLocked || candidateSelectionMode || listFeedback.status === "pending")
            return;
        session.clearBatchSuccessFeedback();
        editingMemoryId = "";
        deletingMemoryId = "";
        memorySelectedIds = [];
        memorySelectionMode = true;
    }
    function toggleMemorySelection(id, checked) {
        if (!memorySelectionEditable || typeof id !== "string" || !memoryRows.some(row => row.id === id))
            return;
        const selected = memorySelectedIds.slice();
        const index = selected.indexOf(id);
        if (checked && index < 0 && selected.length < 100)
            selected.push(id);
        else if (!checked && index >= 0)
            selected.splice(index, 1);
        else
            return;
        memorySelectedIds = selected;
    }
    function confirmMemorySelection() {
        if (!memorySelectionCanDelete)
            return;
        memoryBatchDeleteDialog.memoryIds = memorySelectedIds.slice();
        memoryBatchDeleteDialog.pinnedCount = memorySelectedPinnedCount;
        memoryBatchDeleteDialog.scopeKey = personaScope;
        memoryBatchDeleteDialog.listRevision = memoryListRevision;
        memoryBatchDeleteDialog.open();
    }
    function previewMemoryPinSelection(pinned) {
        if (!memorySelectionCanDelete || typeof pinned !== "boolean")
            return;
        const previous = memoryBatchPin.previewRequestId || "";
        memoryBatchPinDialog.memoryIds = memorySelectedIds.slice();
        memoryBatchPinDialog.pinned = pinned;
        memoryBatchPinDialog.scopeKey = personaScope;
        memoryBatchPinDialog.listRevision = memoryListRevision;
        session.previewMemoryPins(memoryBatchPinDialog.memoryIds, pinned);
        const requestId = session.memoryBatchPin?.previewRequestId || "";
        if (!requestId || requestId === previous)
            return;
        memoryBatchPinDialog.previewRequestId = requestId;
        memoryBatchPinDialog.generation = session.memoryBatchPin.generation;
        memoryBatchPinDialog.open();
    }
    function clearCandidateSelection(exitMode) {
        candidateSelectedIds = [];
        if (exitMode)
            candidateSelectionMode = false;
        if (memoryCandidateBatchDialog && memoryCandidateBatchDialog.visible)
            memoryCandidateBatchDialog.close();
    }
    function beginCandidateSelection() {
        if (!candidateActionsEnabled || memorySelectionMode)
            return;
        session.clearBatchSuccessFeedback();
        candidateSelectedIds = [];
        candidateSelectionMode = true;
    }
    function toggleCandidateSelection(id, checked) {
        if (!candidateSelectionEditable || typeof id !== "string" || !candidateRows.some(row => row.id === id))
            return;
        const selected = candidateSelectedIds.slice();
        const index = selected.indexOf(id);
        if (checked && index < 0 && selected.length < 100)
            selected.push(id);
        else if (!checked && index >= 0)
            selected.splice(index, 1);
        else
            return;
        candidateSelectedIds = selected;
    }
    function previewCandidateSelection(confirm) {
        if (!candidateSelectionCanDecide || typeof confirm !== "boolean")
            return;
        const previous = memoryCandidateBatch.previewRequestId || "";
        memoryCandidateBatchDialog.candidateIds = candidateSelectedIds.slice();
        memoryCandidateBatchDialog.confirm = confirm;
        memoryCandidateBatchDialog.scopeKey = personaScope;
        memoryCandidateBatchDialog.candidateRevision = candidateRevision;
        session.previewCandidateDecisions(memoryCandidateBatchDialog.candidateIds, confirm);
        const requestId = session.memoryCandidateBatch?.previewRequestId || "";
        if (!requestId || requestId === previous)
            return;
        memoryCandidateBatchDialog.previewRequestId = requestId;
        memoryCandidateBatchDialog.generation = session.memoryCandidateBatch.generation;
        memoryCandidateBatchDialog.open();
    }
    // The batch's own reads replace the candidate page; only they keep the selection.
    onCandidateRevisionChanged: {
        if (session.memoryCandidateBatch?.preserveSelection !== true)
            clearCandidateSelection(false);
    }
    onMemoryCandidateBatchChanged: {
        if (["success", "refreshed"].includes(memoryCandidateBatch.status) && memoryCandidateBatch.requestId) {
            const key = [memoryCandidateBatch.status, memoryCandidateBatch.requestId, memoryCandidateBatch.statusReadId, memoryCandidateBatch.candidateReadId, memoryCandidateBatch.listReadId].join(":");
            if (key !== processedCandidateBatchResultKey) {
                processedCandidateBatchResultKey = key;
                clearCandidateSelection(true);
            }
        }
        if (!["previewing", "ready", "preview_error"].includes(memoryCandidateBatch.status) && memoryCandidateBatchDialog.visible)
            memoryCandidateBatchDialog.close();
    }
    onCandidateDialogCurrentChanged: {
        if (!candidateDialogCurrent && memoryCandidateBatchDialog.visible)
            memoryCandidateBatchDialog.close();
    }
    // Only a bridge-owned pin read may replace the shown page while keeping
    // the original selection, including IDs outside that replacement page.
    onMemoryListRevisionChanged: {
        if (session.memoryBatchPin?.preserveSelection !== true)
            clearMemorySelection(false);
    }
    onMemoryBatchPinChanged: {
        if (["success", "refreshed"].includes(memoryBatchPin.status) && memoryBatchPin.requestId) {
            const key = [memoryBatchPin.status, memoryBatchPin.requestId, memoryBatchPin.statusReadId, memoryBatchPin.listReadId].join(":");
            if (key !== processedMemoryPinResultKey) {
                processedMemoryPinResultKey = key;
                clearMemorySelection(true);
            }
        }
        if (!["previewing", "ready", "preview_error"].includes(memoryBatchPin.status) && memoryBatchPinDialog.visible)
            memoryBatchPinDialog.close();
    }
    onMemoryPinDialogCurrentChanged: {
        if (!memoryPinDialogCurrent && memoryBatchPinDialog.visible)
            memoryBatchPinDialog.close();
    }
    onMemoryBatchDeleteChanged: {
        if (["success", "rejected"].includes(memoryBatchDelete.status) && memoryBatchDelete.requestId && memoryBatchDelete.requestId !== processedMemoryBatchRequestId) {
            processedMemoryBatchRequestId = memoryBatchDelete.requestId;
            clearMemorySelection(true);
        }
    }
    onMemoryBatchConfirmationReadyChanged: {
        if (!memoryBatchConfirmationReady && memoryBatchDeleteDialog.visible)
            memoryBatchDeleteDialog.close();
    }
    property string editingMemoryId: ""
    property string deletingMemoryId: ""
    // A committed edit or delete closes its inline editor or confirmation.
    onActionFeedbackChanged: {
        if (actionFeedback.status !== "success" || !actionFeedback.requestId || actionFeedback.requestId === processedActionRequestId)
            return;
        processedActionRequestId = actionFeedback.requestId;
        if (actionFeedback.subjectId === editingMemoryId)
            editingMemoryId = "";
        if (actionFeedback.subjectId === deletingMemoryId)
            deletingMemoryId = "";
    }
    readonly property var summaryFeedback: session.memoryFeedback?.summary || ({})
    readonly property var legacyFeedback: session.memoryFeedback?.legacy || ({})
    readonly property var summaryDirectory: session.state.summary || ({})
    readonly property var summaryDetailState: session.summaryDetailState || ({})
    // Read access follows the live runtime and persona, including while local
    // writes or model calls are paused. It never grants a generation permission.
    readonly property bool summaryReadAllowed: session.connected && !session.personaChanging
    // The bridge supplies a validated QVariantList, exposed to QML as a
    // sequence. Admit its bounded shape before copying it to a JS array.
    readonly property var summaryDirectorySequence: summaryDirectory.summaries
    readonly property bool summaryDirectorySequenceValid: summaryDirectorySequence !== null && typeof summaryDirectorySequence === "object" && Number.isInteger(summaryDirectorySequence.length) && summaryDirectorySequence.length >= 0 && summaryDirectorySequence.length <= 100
    readonly property bool summaryDirectoryValid: summaryDirectory.ok === true && summaryDirectory.directoryReady === true && summaryDirectory.conversation_id === "dream-room" && summaryDirectorySequenceValid && Number.isInteger(summaryDirectory.summaryTotal) && summaryDirectory.summaryTotal >= summaryDirectorySequence.length && typeof summaryDirectory.hasMore === "boolean"
    readonly property var summaryDirectoryRows: summaryDirectoryValid ? Array.from(summaryDirectorySequence) : []
    readonly property int summarySelectedIndex: summaryDirectoryRows.findIndex(row => row.summary_id === summaryDetailState.summaryId)
    function summaryDirectoryText() {
        if (summaryDirectory.ok === false)
            return summaryDirectory.directoryFeedback || "摘要目录读取失败，请刷新目录后再试。";
        if (summaryDirectory.summaries === undefined)
            return "摘要目录尚未确认，请刷新目录。";
        if (!summaryDirectoryValid)
            return summaryDirectory.directoryFeedback || "摘要目录无效，请刷新目录后再试。";
        if (summaryDirectoryRows.length === 0)
            return "当前会话尚无可用的 AI 摘要。";
        return "已列出最近 " + summaryDirectoryRows.length + " 段，共 " + summaryDirectory.summaryTotal + " 段可用摘要。";
    }
    function summaryEntryText(row, index) {
        return "摘要 " + (index + 1) + " · 来源消息 " + row.messageIds.length + " 条";
    }
    // Terminal settings sections. A control shows the requested value while its
    // save is pending, otherwise only what the runtime last reported.
    readonly property var settingsSnapshot: session.state.settings || ({})
    readonly property bool settingsKnown: settingsSnapshot.ok === true && !session.settingsFeedback?.read
    function settingsReceipt(section) {
        return session.settingsFeedback?.[section] || ({});
    }
    function settingValue(section, key) {
        const receipt = settingsReceipt(section);
        if (receipt.status === "pending" && receipt.fields && key in receipt.fields)
            return receipt.fields[key];
        return (section === "personality" ? settingsSnapshot.features : settingsSnapshot[section])?.[key];
    }
    function settingsEditable(section) {
        return session.connected && tasks.writesAllowed && tasks.settingsKnown && !session.personaChanging && settingsReceipt(section).status !== "pending";
    }
    // A toggle replaces the switch's checked binding; restore it so the switch
    // keeps following the pending request and then the value read back.
    function toggleSetting(control, section, key, value) {
        const fields = {};
        fields[key] = value;
        session.saveSettings(section, fields);
        control.checked = Qt.binding(() => control.shownValue);
    }
    function toggleFlaws(control, value) {
        const fields = {
            personality_flaws_enabled: value
        };
        if (value && flawsAcknowledged.checked)
            fields.personality_flaws_disclaimer_acknowledged = true;
        session.saveSettings("personality", fields);
        control.checked = Qt.binding(() => control.shownValue);
    }
    readonly property int retentionShown: Number(settingValue("memory", "retention_days")) || 0
    function chooseRetention(days) {
        if (days === retentionShown || !settingsEditable("memory"))
            return;
        if (days < retentionShown) {
            retentionConfirm.targetDays = days;
            retentionConfirm.open();
        } else {
            session.saveSettings("memory", {
                retention_days: days
            });
        }
    }
    function retentionLabel(days) {
        return ({
                365: "1 年",
                730: "2 年",
                1095: "3 年"
            })[days] || "";
    }
    // Forgetting and misremembering offer presets only; the bridge rejects
    // anything else. Chances are shown in whole percents and sent as fractions.
    readonly property var chancePresets: [1, 3, 5, 10]
    function chooseMemoryPreset(key, value) {
        if (!settingsEditable("memory") || Number(settingValue("memory", key)) === value)
            return;
        const fields = {};
        fields[key] = value;
        session.saveSettings("memory", fields);
    }
    // Emotion presets are global and saved with the personality section; the
    // ratio is shown in whole percents and sent as a fraction.
    readonly property var emotionDayPresets: [1, 3, 5, 7]
    readonly property var emotionRatioPresets: [5, 10, 15, 30]
    function chooseEmotionPreset(key, value) {
        if (!settingsEditable("personality") || Number(settingValue("personality", key)) === value)
            return;
        const fields = {};
        fields[key] = value;
        session.saveSettings("personality", fields);
    }
    readonly property var budgetRequestPresets: [30, 60, 120, 240]
    readonly property var budgetTokenPresets: [10000, 30000, 100000, 300000]
    function chooseBudgetPreset(key, value) {
        if (!settingsEditable("personality") || !budgetSwitch.shownValue || Number(settingValue("personality", key)) === value)
            return;
        const fields = {};
        fields[key] = value;
        session.saveSettings("personality", fields);
    }
    readonly property var budgetUsageState: session.budgetState || ({})
    readonly property var budgetUsageSnapshot: budgetUsageState.snapshot || ({})
    readonly property bool budgetUsageCurrent: session.connected && !session.personaChanging && budgetUsageState.status === "success" && budgetUsageState.live === true && budgetUsageState.stale !== true && !!budgetUsageSnapshot.background
    readonly property bool budgetTrackingDisabled: (settingsKnown && settingsSnapshot.features?.api_budget_tracking_enabled === false) || (settingsKnown && settingsSnapshot.budgetRuntime?.tracking_enabled === false) || (budgetUsageCurrent && budgetUsageSnapshot.tracking_enabled === false)
    function budgetUsageStatusText() {
        if (!session.connected || session.personaChanging)
            return "用量暂时读不到。";
        if (budgetUsageState.status === "pending")
            return "正在读取今日用量…";
        if (budgetUsageCurrent)
            return budgetUsageSnapshot.tracking_enabled === false ? "记账已关闭，以下仅为账本已有用量。" : "今日用量已读取，仅统计已记账的后台请求。";
        if (budgetUsageState.status === "error")
            return "用量暂时读不到。";
        return "今日用量尚未读取。";
    }
    // Turning misremembering on waits for its confirmation; the switch keeps
    // showing the saved value meanwhile. Turning it off saves at once.
    function toggleMisremembering(control, value) {
        if (value)
            misrememberConfirm.open();
        else
            session.saveSettings("memory", {
                misremembering_enabled: false
            });
        control.checked = Qt.binding(() => control.shownValue);
    }
    // One labelled row of preset segments. A saved value
    // outside the presets selects none of them and is shown under the row.
    // The row only reports a choice; its caller saves it.
    component MemoryPresetRow: ColumnLayout {
        id: presetRow
        required property string objectPrefix
        required property string label
        required property var values
        required property var savedValue
        property bool settingsKnown: false
        property bool percent: false
        property string unit: " 天"
        property var valueLabels: ({})
        property bool rowEnabled: true
        signal chosen(real value)
        readonly property real shown: Number(savedValue)
        readonly property real shownUnits: percent ? Math.round(shown * 1000) / 10 : shown
        readonly property bool known: settingsKnown && Number.isFinite(shown)
        function valueLabel(value) {
            const label = valueLabels[String(value)];
            return label !== undefined ? String(label) : value + (percent ? "%" : unit);
        }
        Layout.fillWidth: true
        spacing: 4
        RowLayout {
            Layout.fillWidth: true
            spacing: 6
            Text {
                Layout.preferredWidth: 176
                textFormat: Text.PlainText
                text: presetRow.label
                color: presetRow.rowEnabled ? "#c8dce9" : "#75858a"
                font.pixelSize: 13
                wrapMode: Text.Wrap
            }
            Repeater {
                model: presetRow.values
                GlassButton {
                    required property var modelData
                    objectName: presetRow.objectPrefix + "-" + modelData
                    Layout.fillWidth: true
                    implicitHeight: 32
                    padding: 5
                    text: presetRow.valueLabel(modelData)
                    accented: presetRow.known && presetRow.shownUnits === modelData
                    enabled: presetRow.rowEnabled
                    Accessible.role: Accessible.RadioButton
                    Accessible.checked: accented
                    onClicked: presetRow.chosen(presetRow.percent ? modelData / 100 : modelData)
                }
            }
        }
        Text {
            objectName: presetRow.objectPrefix + "Current"
            visible: presetRow.known && !presetRow.values.includes(presetRow.shownUnits)
            Layout.fillWidth: true
            textFormat: Text.PlainText
            text: "当前为 " + presetRow.valueLabel(presetRow.shownUnits) + "，可从上面选择。"
            color: "#e6c9a4"
            font.pixelSize: 12
            wrapMode: Text.Wrap
        }
    }
    // The flaw text keeps an unsaved edit; only a completed read replaces it.
    property bool flawsDirty: false
    property int flawsEditRevision: 0
    property int flawsSavingRevision: -1
    property string flawsSaveRequestId: ""
    readonly property var traitsFeedback: settingsReceipt("personality")
    function loadFlawsField() {
        const saved = settingsSnapshot.features?.user_selected_flaws;
        if (flawsDirty || typeof saved !== "string")
            return;
        if (flawsField.text !== saved)
            flawsField.text = saved;
    }
    function saveFlaws() {
        flawsSavingRevision = flawsEditRevision;
        session.saveSettings("personality", {
            user_selected_flaws: flawsField.text,
            personality_flaws_enabled: true,
            personality_flaws_disclaimer_acknowledged: true
        });
        if (traitsFeedback.status === "pending")
            flawsSaveRequestId = traitsFeedback.requestId || "";
    }
    onTraitsFeedbackChanged: {
        if (!flawsSaveRequestId.length || traitsFeedback.requestId !== flawsSaveRequestId || traitsFeedback.status === "pending")
            return;
        flawsSaveRequestId = "";
        // The read that settled the save has already replaced the snapshot.
        if (traitsFeedback.status === "success" && flawsSavingRevision === flawsEditRevision) {
            flawsDirty = false;
            loadFlawsField();
        }
    }
    Connections {
        target: session
        function onSettingsRead() {
            tasks.loadFlawsField();
        }
    }
    function feedbackColor(feedback) {
        return ["error", "unknown", "partial", "saved"].includes(feedback?.status) ? "#e6b4a4" : "#b7d5cf";
    }
    function summaryStatusText(summary) {
        if (!summary || summary.status === undefined)
            return "摘要状态尚未读取。";
        if (summary.ok === false)
            return "摘要服务暂不可用，原消息不受影响。";
        return ({
                disabled: "已关闭",
                unauthorized: "已开启 · 尚未授权费用，可在终端的费用许可中授权",
                running: "已开启 · 后台整理中",
                ready: "已开启 · 已有 " + (summary.activeCount || 0) + " 段可用摘要",
                cooldown: "已开启 · 刚整理过，稍后继续",
                below_threshold: "已开启 · 等待足够的新对话",
                failed: "已开启 · 上次整理失败，等待下一次整理",
                outcome_unknown: "已开启 · 上次整理结果未知，未自动重试",
                no_source: "已开启 · 等待合格历史",
                idle: "已开启 · 等待合格历史"
            })[summary.status] || "已开启";
    }
    function permissionStatus(permission) {
        if (session.permissionsKnown !== true || typeof permission?.enabled !== "boolean" || typeof permission?.effective !== "boolean")
            return "状态尚未确认";
        if (!permission.enabled)
            return "未授权";
        return permission.effective ? "已授权，许可条件满足" : "已授权，暂不生效";
    }
    function permissionDetail(permission) {
        if (session.permissionsKnown !== true || permission?.enabled !== true || permission?.effective !== false)
            return "";
        if (permission.api_cost_acknowledged === false)
            return "尚未确认此项费用许可。";
        if (permission.provider !== permission.current_provider || permission.origin !== permission.current_origin)
            return "当前服务或目的地已变化，需要重新确认许可。";
        return "许可暂不生效，请检查对应功能开关和配置。";
    }
    Dialog {
        id: consent
        objectName: "settingsCostConsent"
        width: 420
        title: "确认后台模型费用"
        modal: true
        anchors.centerIn: Overlay.overlay
        standardButtons: Dialog.NoButton
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: consent.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 8
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: Text {
            textFormat: Text.PlainText
            text: "该功能会向当前配置的服务发送必要内容，并可能产生费用。\n授权只适用于当前服务和目的地；随时可撤销。"
            wrapMode: Text.Wrap
            color: "#d8e8f0"
            width: 340
        }
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
                    objectName: "settingsCostConsentCancel"
                    text: "取消"
                    implicitHeight: 38
                    padding: 8
                    onClicked: consent.reject()
                }
                GlassButton {
                    objectName: "settingsCostConsentConfirm"
                    text: "确定"
                    implicitHeight: 38
                    padding: 8
                    accented: true
                    onClicked: consent.accept()
                }
            }
        }
        onAccepted: session.grantFeature(tasks.consentFeature, tasks.consentDigest, true, tasks.consentEpoch)
        onRejected: session.grantFeature(tasks.consentFeature, tasks.consentDigest, false, tasks.consentEpoch)
    }
    Dialog {
        id: memoryBatchDeleteDialog
        objectName: "memoryBatchDeleteDialog"
        property var memoryIds: []
        property int pinnedCount: 0
        property string scopeKey: ""
        property int listRevision: -1
        title: "删除所选记忆？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: memoryBatchDeleteDialog.title
            textFormat: Text.PlainText
            color: "#dce9f2"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "memoryBatchDeleteCount"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: tasks.memoryBatchConfirmationReady ? "#dce9f2" : "#b0bfc4"
                text: "将删除" + memoryBatchDeleteDialog.memoryIds.length + "条记忆，其中已固定" + memoryBatchDeleteDialog.pinnedCount + "条。"
                Accessible.name: text
            }
            Text {
                objectName: "memoryBatchDeleteExplanation"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: tasks.memoryBatchConfirmationReady ? "#dce9f2" : "#b0bfc4"
                text: "会清除这些记忆及其全部修订，无法恢复。"
                Accessible.name: text
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    id: memoryBatchCancel
                    objectName: "memoryBatchDeleteCancel"
                    text: "取消"
                    contentItem: Text {
                        objectName: "memoryBatchDeleteCancelLabel"
                        text: memoryBatchCancel.text
                        textFormat: Text.PlainText
                        font: memoryBatchCancel.font
                        color: memoryBatchCancel.enabled ? "#dce9f2" : "#b0bfc4"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                    onClicked: memoryBatchDeleteDialog.close()
                }
                GlassButton {
                    id: memoryBatchConfirm
                    objectName: "memoryBatchDeleteConfirm"
                    text: "确认删除所选记忆"
                    enabled: tasks.memoryBatchConfirmationReady
                    contentItem: Text {
                        objectName: "memoryBatchDeleteConfirmLabel"
                        text: memoryBatchConfirm.text
                        textFormat: Text.PlainText
                        font: memoryBatchConfirm.font
                        color: memoryBatchConfirm.enabled ? "#dce9f2" : "#b0bfc4"
                        horizontalAlignment: Text.AlignHCenter
                        verticalAlignment: Text.AlignVCenter
                    }
                    onClicked: {
                        if (!tasks.memoryBatchConfirmationReady)
                            return;
                        const ids = memoryBatchDeleteDialog.memoryIds.slice();
                        memoryBatchDeleteDialog.close();
                        session.deleteMemories(ids);
                    }
                }
            }
        }
    }
    Dialog {
        id: memoryBatchPinDialog
        objectName: "memoryBatchPinDialog"
        property var memoryIds: []
        property bool pinned: true
        property string scopeKey: ""
        property int listRevision: -1
        property string previewRequestId: ""
        property int generation: -1
        title: pinned ? "固定所选记忆？" : "取消固定所选记忆？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        onClosed: {
            if (["previewing", "ready", "preview_error"].includes(session.memoryBatchPin?.status))
                session.cancelMemoryPinPreview();
        }
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: memoryBatchPinDialog.title
            textFormat: Text.PlainText
            color: "#dce9f2"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "memoryBatchPinCount"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#dce9f2"
                text: tasks.memoryPinPreviewReady
                    ? "已选" + tasks.memoryBatchPin.selectedCount + "条，预计" + (memoryBatchPinDialog.pinned ? "固定" : "取消固定") + tasks.memoryBatchPin.expectedChangedCount + "条；" + tasks.memoryBatchPin.unchangedCount + "条无需更改。"
                    : tasks.memoryBatchPin.status === "preview_error" ? "所选记忆的固定状态暂时读不到，请取消后重新打开。" : "正在核对所选记忆的固定状态…"
                Accessible.name: text
            }
            Text {
                objectName: "memoryBatchPinCapacity"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#dce9f2"
                text: tasks.memoryPinPreviewReady
                    ? "当前人格已固定" + tasks.memoryBatchPin.pinnedTotal + "条／上限" + tasks.memoryBatchPin.pinLimit + "条（读取时状态）；提交时会重新核查容量。"
                    : tasks.memoryBatchPin.status === "preview_error" ? "当前人格的固定数量尚未确认。" : "正在读取当前人格的固定数量…"
                Accessible.name: text
            }
            Text {
                objectName: "memoryBatchPinExplanation"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#dce9f2"
                text: memoryBatchPinDialog.pinned
                    ? "只更改所选记忆的固定状态，不会删除记忆。"
                    : "取消后恢复按保留层和保护级别适用的正常淡忘规则，不会立即删除。"
                Accessible.name: text
            }
            Text {
                objectName: "memoryBatchPinPreviewFeedback"
                Layout.fillWidth: true
                // Counts and capacity already have dedicated preview labels.
                // Keep non-actionable states and errors visible.
                visible: text.length > 0 && !tasks.memoryPinConfirmationReady
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: tasks.feedbackColor(tasks.memoryBatchPin)
                text: tasks.memoryBatchPin.text || ""
                Accessible.name: text
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton {
                    objectName: "memoryBatchPinCancel"
                    text: "取消"
                    onClicked: {
                        session.cancelMemoryPinPreview();
                        memoryBatchPinDialog.close();
                    }
                }
                GlassButton {
                    objectName: "memoryBatchPinConfirm"
                    text: tasks.memoryPinPreviewReady && tasks.memoryBatchPin.expectedChangedCount === 0
                        ? "无需更改" : memoryBatchPinDialog.pinned ? "确认固定所选记忆" : "确认取消固定"
                    enabled: tasks.memoryPinConfirmationReady
                    onClicked: {
                        if (!tasks.memoryPinConfirmationReady)
                            return;
                        session.confirmMemoryPins();
                    }
                }
            }
        }
    }
    Dialog {
        id: memoryCandidateBatchDialog
        objectName: "memoryCandidateBatchDialog"
        property var candidateIds: []
        property bool confirm: true
        property string scopeKey: ""
        property int candidateRevision: -1
        property string previewRequestId: ""
        property int generation: -1
        title: confirm ? "记住所选候选？" : "不记所选候选？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        onClosed: {
            if (["previewing", "ready", "preview_error"].includes(session.memoryCandidateBatch?.status))
                session.cancelCandidateBatchPreview();
        }
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: memoryCandidateBatchDialog.title
            textFormat: Text.PlainText
            color: "#dce9f2"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "memoryCandidateBatchCount"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#dce9f2"
                text: !tasks.candidatePreviewReady
                    ? (tasks.memoryCandidateBatch.status === "preview_error" ? "所选候选的状态暂时读不到，请取消后重新打开。" : "正在核对所选候选…")
                    : memoryCandidateBatchDialog.confirm
                    ? "已选" + tasks.memoryCandidateBatch.selectedCount + "条：将新增" + tasks.memoryCandidateBatch.newCount + "条、替换已有记忆" + tasks.memoryCandidateBatch.replaceCount + "条（旧内容保留为历史版本），" + tasks.memoryCandidateBatch.sameCount + "条与现有记忆相同无需新增。"
                    : "将不记" + tasks.memoryCandidateBatch.selectedCount + "条，这些候选不会成为记忆。"
                Accessible.name: text
            }
            Text {
                objectName: "memoryCandidateBatchPinned"
                Layout.fillWidth: true
                visible: tasks.candidatePreviewReady && memoryCandidateBatchDialog.confirm && tasks.memoryCandidateBatch.replacedPinnedCount > 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e6c9a4"
                text: "其中" + tasks.memoryCandidateBatch.replacedPinnedCount + "条已固定，替换后的新记忆不再固定。"
                Accessible.name: text
            }
            Text {
                objectName: "memoryCandidateBatchExplanation"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#dce9f2"
                text: memoryCandidateBatchDialog.confirm
                    ? "数量来自读取时的状态，提交时会重新核对；同一事实的候选需要分开处理。"
                    : "只改变所选候选的状态，不会改动已有记忆。"
                Accessible.name: text
            }
            Text {
                objectName: "memoryCandidateBatchPreviewFeedback"
                Layout.fillWidth: true
                // Counts have their own labels; keep conflicts and errors visible.
                visible: text.length > 0 && !tasks.candidateConfirmationReady
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: tasks.feedbackColor(tasks.memoryCandidateBatch)
                text: tasks.memoryCandidateBatch.text || ""
                Accessible.name: text
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton {
                    objectName: "memoryCandidateBatchCancel"
                    text: "取消"
                    onClicked: {
                        session.cancelCandidateBatchPreview();
                        memoryCandidateBatchDialog.close();
                    }
                }
                GlassButton {
                    objectName: "memoryCandidateBatchConfirm"
                    text: memoryCandidateBatchDialog.confirm ? "确认记住所选候选" : "确认不记所选候选"
                    enabled: tasks.candidateConfirmationReady
                    onClicked: {
                        if (!tasks.candidateConfirmationReady)
                            return;
                        session.confirmCandidateDecisions();
                    }
                }
            }
        }
    }
    Dialog {
        id: profileClearDialog
        objectName: "profileClearDialog"
        title: "清空指定资料字段？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: profileClearDialog.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "profileClearExplanation"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "清空会作用于所有人格共用的资料。仅清空你选中的已保存字段，并更新当前人格中由这些字段生成的资料事实；其他人格已有的资料派生记忆不保证立即同步。聊天历史、情绪记忆、独立确认的记忆、日记和世界书不在清空范围内。\n默认不选任何字段；已有空字段不能选择。确认后不会自动重试。"
                Accessible.name: text
            }
            GridLayout {
                Layout.fillWidth: true
                // Eleven choices stay within the narrow window in three columns.
                columns: profileClearDialog.availableWidth >= 420 ? 3 : 2
                columnSpacing: 12
                Repeater {
                    model: tasks.profileClearChoices
                    CheckBox {
                        id: clearChoice
                        required property var modelData
                        objectName: "profileClearField-" + modelData.key
                        text: modelData.label
                        enabled: tasks.profileClearConfirmationReady && (tasks.profileClearState.availableFields || []).includes(modelData.key)
                        checked: tasks.profileClearSelectedFields.includes(modelData.key)
                        // The Basic style's disabled label matches the glass
                        // background; empty fields stay readable but dimmer.
                        contentItem: Text {
                            objectName: "profileClearFieldLabel-" + clearChoice.modelData.key
                            leftPadding: clearChoice.indicator.width + clearChoice.spacing
                            text: clearChoice.text
                            textFormat: Text.PlainText
                            font: clearChoice.font
                            color: clearChoice.enabled ? "#dce9f2" : "#b0bfc4"
                            verticalAlignment: Text.AlignVCenter
                        }
                        onToggled: {
                            const selected = tasks.profileClearSelectedFields.slice();
                            const index = selected.indexOf(modelData.key);
                            if (checked && index < 0)
                                selected.push(modelData.key);
                            else if (!checked && index >= 0)
                                selected.splice(index, 1);
                            else
                                return;
                            tasks.profileClearSelectedFields = selected;
                        }
                    }
                }
            }
            Text {
                objectName: "profileClearSelectedNames"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#bdd0de"
                text: tasks.profileClearSelectedFields.length ? "将清空：" + tasks.profileClearChoices.filter(field => tasks.profileClearSelectedFields.includes(field.key)).map(field => field.label).join("、") : "尚未选择字段"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "profileClearCancel"
                    text: "取消"
                    onClicked: {
                        session.cancelProfileClear();
                        profileClearDialog.close();
                    }
                }
                GlassButton {
                    objectName: "profileClearConfirm"
                    text: "确认清空所选字段"
                    enabled: tasks.profileClearConfirmationReady && tasks.profileClearSelectedFields.length > 0
                    onClicked: {
                        tasks.profileClearStartRevision = tasks.profileEditRevision;
                        tasks.profileClearBoundSnapshot = tasks.profileClearState.profileSnapshot;
                        tasks.profileClearBoundScope = tasks.profileClearState.scopeKey;
                        session.confirmProfileClear(tasks.profileClearSelectedFields, tasks.profileClearState.scopeKey, tasks.profileClearState.profileSnapshot, tasks.profileDirty);
                    }
                }
            }
        }
        onClosed: session.cancelProfileClear()
    }
    Connections {
        target: session
        function onChanged() {
            tasks.reconcileCandidateFocus(false);
            if (!tasks.providerDirty && session.state.provider) {
                tasks.providerKind = session.state.provider.provider || "ollama";
                endpoint.text = session.state.provider.base_url || "";
                modelName.text = session.state.provider.model || "";
            }
        }
        function onCommandResult(command, result) {
            if (command === "provider:configure" && result.ok && tasks.providerSavingRevision === tasks.providerEditRevision) {
                tasks.providerDirty = false;
                tasks.providerKind = result.llm.provider;
                endpoint.text = result.llm.base_url;
                modelName.text = result.llm.model;
                apiKey.text = "";
            }
        }
    }
    FolderDialog {
        id: modelFolder
        objectName: "avatarModelFolder"
        title: "选择你的 Live2D 模型目录"
        onAccepted: session.importModel(selectedFolder)
    }
    FileDialog {
        id: backupSaveDialog
        title: "导出备份"
        fileMode: FileDialog.SaveFile
        defaultSuffix: "json"
        nameFilters: ["备份 JSON (*.json)"]
        onAccepted: session.exportBackup(selectedFile)
    }
    FileDialog {
        id: backupOpenDialog
        title: tasks.backupRescueSelection ? "选择已知完好的备份以恢复解困" : "选择备份文件"
        fileMode: FileDialog.OpenFile
        nameFilters: ["备份 JSON (*.json)"]
        onAccepted: tasks.backupRescueSelection ? session.chooseBackupForRescue(selectedFile) : session.chooseBackupForRestore(selectedFile)
    }
    Dialog {
        id: backupConfirm
        title: tasks.backupSelection.mode === "rescue" ? "用已知完好的备份恢复解困？" : "确认恢复这份备份？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: backupConfirm.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "backupRestoreConfirmation"
            spacing: 12
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: (tasks.backupSelection.fileName || "") + " · " + (tasks.backupSelection.fileBytes || 0) + " 字节\n" + (tasks.backupSelection.mode === "rescue" ? "请确认这份文件来自已知完好的状态。它将替换当前人格的记忆、资料、情绪、关系和日记，并通过恢复日志核对后解除写入锁。" : "将替换当前人格的记忆、资料、情绪、关系和日记。未保存草稿会保留，确认后不会自动重试。")
            }
            CheckBox {
                id: backupKnownGood
                objectName: "backupKnownGood"
                visible: tasks.backupSelection.mode === "rescue"
                text: "我确认这是已知完好的备份"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "backupRestoreCancel"
                    text: "取消"
                    onClicked: {
                        backupConfirm.close();
                        session.cancelBackupRestore();
                    }
                }
                GlassButton {
                    objectName: "backupRestoreConfirm"
                    text: tasks.backupSelection.mode === "rescue" ? "确认恢复解困" : "确认恢复"
                    enabled: tasks.backupSelection.mode !== "rescue" || backupKnownGood.checked
                    onClicked: {
                        backupConfirm.close();
                        session.confirmBackupRestore(backupKnownGood.checked);
                    }
                }
            }
        }
        onOpened: backupKnownGood.checked = false
    }
    component PersonaProfileTextField: ColumnLayout {
        id: profileField
        property string label
        property string inputName
        property int maximum: 0
        property bool extraInvalid: false
        property string countText: tasks.profileCharacterCount(text) + " / " + maximum + " 字"
        property alias text: profileInput.text
        readonly property bool invalid: extraInvalid || (maximum > 0 && tasks.profileCharacterCount(text) > maximum)
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        spacing: 5
        Text {
            objectName: profileField.inputName + "Count"
            Layout.fillWidth: true
            text: profileField.label + "（" + profileField.countText + "）"
            textFormat: Text.PlainText
            color: profileField.invalid ? "#ef9d99" : "#b7cbd8"
            font.pixelSize: 13
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        ScrollView {
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            Layout.preferredHeight: 112
            clip: true
            contentWidth: availableWidth
            TextArea {
                id: profileInput
                objectName: profileField.inputName
                width: parent.width
                textFormat: TextEdit.PlainText
                wrapMode: TextEdit.Wrap
                selectByMouse: true
                readOnly: session.personaProfilePending || tasks.personaProfileState.active === true
                color: "#dce9f2"
                font.pixelSize: 14
                padding: 9
                Accessible.name: profileField.label
                background: Rectangle {
                    color: "#30050e14"
                    radius: 7
                    border.width: 1
                    border.color: profileField.invalid ? "#ef9d99" : "#38515d"
                }
            }
        }
    }
    Dialog {
        id: personaProfilePanel
        objectName: "personaProfilePanel"
        title: "编辑「" + (tasks.personaProfileState.name || "人格") + "」· 第 " + (tasks.personaProfileState.identity_version || "") + " 版 · " + (tasks.personaProfileState.active === true ? "当前人格" : "非当前人格")
        modal: true
        width: Math.min(620, Overlay.overlay ? Overlay.overlay.width - 32 : 620)
        height: Math.min(720, Overlay.overlay ? Overlay.overlay.height - 32 : 720)
        anchors.centerIn: Overlay.overlay
        padding: 16
        closePolicy: Popup.NoAutoClose
        background: GlassPane { padding: 0; materialRole: "work"; cornerRadius: 16 }
        header: Text {
            objectName: "personaProfileTitle"
            text: personaProfilePanel.title
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: "#dce9f2"
            font.pixelSize: 16
            leftPadding: 16; rightPadding: 16; topPadding: 16; bottomPadding: 8
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 10
            ScrollView {
                id: personaProfileScroll
                objectName: "personaProfileScroll"
                Layout.fillWidth: true
                Layout.fillHeight: true
                Layout.minimumHeight: 0
                contentWidth: availableWidth
                clip: true
                ColumnLayout {
                    width: personaProfileScroll.availableWidth
                    spacing: 14
                    PersonaProfileTextField {
                        id: personaProfileDescriptionInput
                        label: "档案正文"; inputName: "personaProfileDescription"; maximum: 24000
                    }
                    PersonaProfileTextField {
                        id: personaProfileTraitsInput
                        label: "性格特征，每行一条"; inputName: "personaProfileTraits"
                        extraInvalid: !tasks.personaProfileTraitsValid
                        countText: tasks.personaProfileTraits().length + " / 24 条；每条 2–160 字；当前各条 " + tasks.personaProfileTraits().map(value => tasks.profileCharacterCount(value)).join("、") + " 字"
                    }
                    PersonaProfileTextField {
                        id: personaProfileToneInput
                        label: "说话语气"; inputName: "personaProfileTone"; maximum: 2000
                    }
                    PersonaProfileTextField {
                        id: personaProfileFirstInput
                        label: "开场白"; inputName: "personaProfileFirstMessage"; maximum: 4000
                    }
                    Text {
                        Layout.fillWidth: true
                        text: "备选问候（" + tasks.personaProfileGreetings.length + " / 20 条）"
                        textFormat: Text.PlainText
                        color: "#b7cbd8"
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        Accessible.name: text
                    }
                    Repeater {
                        model: personaProfileGreetingModel
                        delegate: ColumnLayout {
                            id: greetingItem
                            required property int index
                            required property string value
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            PersonaProfileTextField {
                                label: "问候 " + (greetingItem.index + 1)
                                inputName: "personaProfileGreeting_" + greetingItem.index
                                maximum: 4000
                                extraInvalid: text.trim().length === 0
                                text: greetingItem.value
                                onTextChanged: tasks.setPersonaProfileGreeting(greetingItem.index, text)
                            }
                            GlassButton {
                                objectName: "personaProfileRemoveGreeting_" + greetingItem.index
                                text: "删除这条问候"
                                enabled: !session.personaProfilePending && tasks.personaProfileState.active !== true
                                onClicked: tasks.removePersonaProfileGreeting(greetingItem.index)
                            }
                        }
                    }
                    GlassButton {
                        objectName: "personaProfileAddGreeting"
                        text: "添加备选问候"
                        enabled: tasks.personaProfileGreetings.length < 20 && !session.personaProfilePending && tasks.personaProfileState.active !== true
                        onClicked: tasks.addPersonaProfileGreeting()
                    }
                    PersonaProfileTextField {
                        id: personaProfileExampleInput
                        label: "对话示例"; inputName: "personaProfileMessageExample"; maximum: 8000
                    }
                }
            }
            Text {
                objectName: "personaProfilePanelFeedback"
                Layout.fillWidth: true
                visible: text.length > 0
                text: tasks.personaProfileState.text || ""
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: tasks.feedbackColor(tasks.personaProfileState)
                font.pixelSize: 13
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton {
                    objectName: "personaProfileSave"
                    text: "保存"
                    enabled: tasks.personaProfileDirty && tasks.personaProfileDraftValid && !session.personaProfilePending && tasks.writesAllowed && tasks.personaProfileState.active !== true && tasks.personaProfileState.status !== "conflict"
                    onClicked: personaProfileSaveDialog.open()
                }
                GlassButton {
                    objectName: "personaProfileCancel"
                    text: "取消"
                    enabled: !session.personaProfilePending
                    onClicked: tasks.closePersonaProfileEditor()
                }
            }
        }
    }
    Dialog {
        id: personaProfileSaveDialog
        objectName: "personaProfileSaveDialog"
        title: "确认保存人格新版本？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 32 : 470)
        anchors.centerIn: Overlay.overlay
        padding: 16
        closePolicy: Popup.NoAutoClose
        background: GlassPane { padding: 0; materialRole: "work"; cornerRadius: 16 }
        header: Text {
            text: personaProfileSaveDialog.title; textFormat: Text.PlainText; color: "#dce9f2"
            font.pixelSize: 15; wrapMode: Text.Wrap
            leftPadding: 16; rightPadding: 16; topPadding: 16; bottomPadding: 8
        }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "personaProfileSaveExplanation"
                Layout.fillWidth: true
                text: "改动字段：" + tasks.personaProfileChangedFields.join("、") + "。\n保存后成为第 " + ((tasks.personaProfileState.identity_version || 0) + 1) + " 版，旧版本保留在本机。\n这个人格在本次编辑之前的备份，将不能再恢复。\n切换到这个人格后生效。"
                textFormat: Text.PlainText; wrapMode: Text.Wrap; color: "#dce9f2"
                Accessible.role: Accessible.StaticText; Accessible.name: text
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton {
                    objectName: "personaProfileCancelSave"; text: "返回编辑"
                    onClicked: personaProfileSaveDialog.close()
                }
                GlassButton {
                    objectName: "personaProfileConfirmSave"; text: "确认保存"
                    enabled: tasks.personaProfileDirty && tasks.personaProfileDraftValid && !session.personaProfilePending && tasks.writesAllowed && tasks.personaProfileState.active !== true
                    onClicked: { personaProfileSaveDialog.close(); session.savePersonaProfile(tasks.personaProfileDraftFields(), true); }
                }
            }
        }
    }
    Dialog {
        id: personaProfileDiscardDialog
        objectName: "personaProfileDiscardDialog"
        title: "放弃未保存的编辑？"
        modal: true
        width: Math.min(420, Overlay.overlay ? Overlay.overlay.width - 32 : 420)
        anchors.centerIn: Overlay.overlay
        padding: 16
        closePolicy: Popup.NoAutoClose
        background: GlassPane { padding: 0; materialRole: "work"; cornerRadius: 16 }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                Layout.fillWidth: true
                text: "放弃未保存的编辑？"; textFormat: Text.PlainText; color: "#dce9f2"; wrapMode: Text.Wrap
            }
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton { objectName: "personaProfileKeepEditing"; text: "继续编辑"; onClicked: personaProfileDiscardDialog.close() }
                GlassButton {
                    objectName: "personaProfileConfirmDiscard"; text: "放弃编辑"
                    onClicked: { personaProfileDiscardDialog.close(); session.closePersonaProfile(); }
                }
            }
        }
    }
    Dialog {
        id: avatarRemoveDialog
        objectName: "avatarRemoveConfirmation"
        property string targetId: ""
        property string targetName: ""
        readonly property string blocker: tasks.avatarRemovalBlocker(targetId)
        title: "删除这个形象？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        padding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane { padding: 0; materialRole: "work"; cornerRadius: 16 }
        header: Text {
            text: avatarRemoveDialog.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                objectName: "avatarRemoveName"
                Layout.fillWidth: true
                text: avatarRemoveDialog.targetName
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                font.pixelSize: 14
            }
            Text {
                objectName: "avatarRemoveNotice"
                Layout.fillWidth: true
                text: "这会删除应用保存的副本。原来的模型文件夹不受影响，需要时可以重新导入。"
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#aabfce"
                font.pixelSize: 13
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "avatarRemoveCancel"
                    text: "取消"
                    onClicked: avatarRemoveDialog.close()
                }
                GlassButton {
                    objectName: "avatarRemoveConfirm"
                    text: "删除"
                    enabled: avatarRemoveDialog.visible && avatarRemoveDialog.blocker.length === 0
                    onClicked: {
                        if (!avatarRemoveDialog.visible || avatarRemoveDialog.blocker.length > 0)
                            return;
                        const id = avatarRemoveDialog.targetId;
                        avatarRemoveDialog.close();
                        session.removeModel(id);
                    }
                }
            }
        }
    }
    Dialog {
        id: personaConfirm
        property string targetId: ""
        property string targetName: ""
        title: "切换为「" + targetName + "」？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: personaConfirm.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "personaSwitchConfirmation"
            spacing: 12
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "记忆、聊天和日记按人格分开保存；当前人格的内容不会被覆盖，之后可以切回。进行中的回复会被取消，形象不随人格更换。"
            }
            Text {
                objectName: "personaDiscardedDrafts"
                Layout.fillWidth: true
                visible: tasks.unsavedDraftNames.length > 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e6b4a4"
                text: "以下未保存内容属于当前人格，切换后会被丢弃：" + tasks.unsavedDraftNames.join("、") + "。"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "personaSwitchCancel"
                    text: "取消"
                    onClicked: personaConfirm.close()
                }
                GlassButton {
                    objectName: "personaSwitchConfirm"
                    text: "确认切换"
                    enabled: tasks.personaSwitchAllowed
                    onClicked: {
                        personaConfirm.close();
                        session.selectPersona(personaConfirm.targetId);
                    }
                }
            }
        }
    }
    Dialog {
        id: authorPromptConfirm
        property string kind: ""
        readonly property var item: tasks.authorPrompts[kind] || ({})
        title: "开启" + tasks.authorPromptName(kind) + "？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: authorPromptConfirm.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "authorPromptConfirmation"
            spacing: 12
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "这段文字来自角色卡作者，不是 Reverie 写的。开启后，当前人格的每轮对话都会附上它，会多占上下文；它可以影响语气和设定，但不能覆盖身份与安全规则。只对当前人格生效，可以随时关闭。"
            }
            ScrollView {
                Layout.fillWidth: true
                Layout.preferredHeight: Math.min(160, authorPromptConfirmText.implicitHeight + 4)
                clip: true
                contentWidth: availableWidth
                Text {
                    id: authorPromptConfirmText
                    objectName: "authorPromptConfirmationText"
                    width: parent.width
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    color: "#b9cad6"
                    font.pixelSize: 13
                    text: authorPromptConfirm.item.text || ""
                }
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                color: "#819ab0"
                font.pixelSize: 12
                text: "共 " + (authorPromptConfirm.item.text || "").length + " 字"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "authorPromptCancel"
                    text: "取消"
                    onClicked: authorPromptConfirm.close()
                }
                GlassButton {
                    objectName: "authorPromptConfirm"
                    text: "确认开启"
                    enabled: archiveEditor.authorPromptBlocker === "" && (authorPromptConfirm.item.flags || []).length === 0
                    onClicked: {
                        authorPromptConfirm.close();
                        archiveEditor.setAuthorPrompt(authorPromptConfirm.kind, true, true);
                    }
                }
            }
        }
    }
    FileDialog {
        id: personaCardFile
        title: "选择角色卡"
        fileMode: FileDialog.OpenFile
        nameFilters: ["角色卡 (*.json *.png)", "JSON 角色卡 (*.json)", "PNG 角色卡 (*.png)"]
        onAccepted: {
            session.choosePersonaCard(selectedFile);
            // A second local rejection can have exactly the same receipt text.
            tasks.armPersonaImportFeedbackReveal();
        }
        onRejected: session.cancelPersonaCard()
    }
    FileDialog {
        id: personaCardSaveDialog
        property string worldBookId: ""
        property string boundScope: ""
        property int boundGeneration: -1
        title: "导出 SillyTavern V2 角色卡"
        fileMode: FileDialog.SaveFile
        defaultSuffix: "json"
        nameFilters: ["SillyTavern V2 JSON (*.json)"]
        onAccepted: {
            if (tasks.personaExportAvailable && boundScope === tasks.personaScope && boundGeneration === tasks.personaExportGeneration)
                session.exportPersonaCard(selectedFile, worldBookId);
        }
    }
    Dialog {
        id: personaCardExportDialog
        objectName: "personaCardExportConfirmation"
        property string boundScope: ""
        property int boundGeneration: -1
        title: "导出角色卡"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        padding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        Overlay.modal: Rectangle { color: "#99050b0e" }
        contentItem: ColumnLayout {
            spacing: 12
            Text {
                Layout.fillWidth: true
                text: "选择要嵌入的世界书"
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                font.pixelSize: 14
            }
            ComboBox {
                id: personaCardExportBook
                objectName: "personaCardExportBook"
                Layout.fillWidth: true
                model: session.personaCardExportBooks || []
                textRole: "name"
                valueRole: "id"
                delegate: ItemDelegate {
                    required property var modelData
                    required property int index
                    width: personaCardExportBook.width
                    text: modelData.name
                    font: personaCardExportBook.font
                    highlighted: personaCardExportBook.highlightedIndex === index
                    contentItem: Text {
                        text: parent.text
                        textFormat: Text.PlainText
                        font: parent.font
                        color: parent.palette.text
                        elide: Text.ElideRight
                        verticalAlignment: Text.AlignVCenter
                    }
                }
            }
            Text {
                objectName: "personaCardExportSavedNotice"
                Layout.fillWidth: true
                text: "只导出已保存的内容"
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#9fb4c7"
                font.pixelSize: 13
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "personaCardExportCancel"
                    text: "取消"
                    onClicked: personaCardExportDialog.close()
                }
                GlassButton {
                    objectName: "personaCardExportConfirm"
                    text: "选择保存位置…"
                    enabled: tasks.personaExportAvailable && personaCardExportDialog.boundScope === tasks.personaScope && personaCardExportDialog.boundGeneration === tasks.personaExportGeneration
                    onClicked: {
                        personaCardSaveDialog.worldBookId = personaCardExportBook.currentValue || "";
                        personaCardSaveDialog.boundScope = personaCardExportDialog.boundScope;
                        personaCardSaveDialog.boundGeneration = personaCardExportDialog.boundGeneration;
                        personaCardSaveDialog.selectedFile = session.suggestedPersonaCardFile();
                        personaCardExportDialog.close();
                        personaCardSaveDialog.open();
                    }
                }
            }
        }
    }
    Dialog {
        id: personaImportConfirmDialog
        objectName: "personaImportConfirmation"
        title: "导入角色卡并立即切换？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: personaImportConfirmDialog.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "personaImportConfirmationContent"
            spacing: 12
            Text {
                objectName: "personaImportFilename"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: tasks.personaCardCandidate.filename || ""
                wrapMode: Text.Wrap
                color: "#e3eff7"
                font.pixelSize: 14
            }
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                text: (tasks.personaCardCandidate.name || "待后端核验的角色卡") + " · " + (tasks.personaCardCandidate.sourceFormat || "").toUpperCase()
                wrapMode: Text.Wrap
                color: "#9fb4c7"
                font.pixelSize: 12
            }
            Text {
                objectName: "personaImportNotice"
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "卡片内容按不可信资料处理，确认后由本地服务核验。卡内系统提示默认不启用；脚本、扩展与远程资源隔离、不执行、不加载。\n确认后将立即切换人格；原人格保留在列表中，可随时切回。记忆、聊天和日记按人格分开保存，Live2D 形象独立，不随卡片更换。"
            }
            Text {
                objectName: "personaImportDiscardedDrafts"
                Layout.fillWidth: true
                visible: tasks.unsavedDraftNames.length > 0
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e6b4a4"
                text: "以下未保存内容属于当前人格，切换后会被丢弃：" + tasks.unsavedDraftNames.join("、") + "。"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "personaImportCancel"
                    text: "取消"
                    onClicked: {
                        session.cancelPersonaCard();
                        personaImportConfirmDialog.close();
                    }
                }
                GlassButton {
                    objectName: "personaImportConfirm"
                    text: "导入并切换"
                    enabled: tasks.personaSwitchAllowed && !!tasks.personaCardCandidate.filename
                    onClicked: {
                        session.importPersonaCard();
                        personaImportConfirmDialog.close();
                    }
                }
            }
        }
    }
    Dialog {
        id: retentionConfirm
        property int targetDays: 0
        title: "缩短为 " + tasks.retentionLabel(targetDays) + "？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: retentionConfirm.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "settingsRetentionConfirmation"
            spacing: 12
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "保留期对所有人格生效。早于新期限、没有固定的记忆，会在之后的每日整理中过期，不再用于对话；之后再延长保留期也不会恢复它们，这里也不能恢复。"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "settingsRetentionCancel"
                    text: "取消"
                    onClicked: retentionConfirm.close()
                }
                GlassButton {
                    objectName: "settingsRetentionConfirm"
                    text: "确认缩短"
                    enabled: tasks.settingsEditable("memory")
                    onClicked: {
                        retentionConfirm.close();
                        session.saveSettings("memory", {
                            retention_days: retentionConfirm.targetDays
                        }, true);
                    }
                }
            }
        }
    }
    Dialog {
        id: misrememberConfirm
        title: "开启记错？"
        modal: true
        width: Math.min(470, Overlay.overlay ? Overlay.overlay.width - 48 : 470)
        anchors.centerIn: Overlay.overlay
        leftPadding: 18
        rightPadding: 18
        topPadding: 8
        bottomPadding: 18
        closePolicy: Popup.NoAutoClose
        background: GlassPane {
            padding: 0
            materialRole: "work"
            cornerRadius: 16
        }
        header: Text {
            text: misrememberConfirm.title
            textFormat: Text.PlainText
            color: "#edf4f4"
            font.pixelSize: 15
            font.weight: Font.DemiBold
            leftPadding: 18
            rightPadding: 18
            topPadding: 18
            bottomPadding: 10
        }
        Overlay.modal: Rectangle {
            color: "#99050b0e"
        }
        contentItem: ColumnLayout {
            objectName: "settingsMisrememberConfirmation"
            spacing: 12
            Text {
                Layout.fillWidth: true
                textFormat: Text.PlainText
                wrapMode: Text.Wrap
                color: "#e3eff7"
                text: "记错对所有人格生效。开启后，她偶尔会把较旧的事情记混，例如把两款游戏的名字弄混；记忆本身不会被改动，关闭后不再发生。"
            }
            RowLayout {
                Layout.alignment: Qt.AlignRight
                GlassButton {
                    objectName: "settingsMisrememberCancel"
                    text: "取消"
                    onClicked: misrememberConfirm.close()
                }
                GlassButton {
                    objectName: "settingsMisrememberConfirm"
                    text: "确认开启"
                    enabled: tasks.settingsEditable("memory")
                    onClicked: {
                        misrememberConfirm.close();
                        session.saveSettings("memory", {
                            misremembering_enabled: true
                        }, true);
                    }
                }
            }
        }
    }
    onBackupFeedbackChanged: {
        if (tasks.page !== "memory")
            return;
        if (backupFeedback.status === "confirmation" && !session.backupRestoring)
            backupConfirm.open();
        else if (backupConfirm.visible)
            backupConfirm.close();
    }
    FileDialog {
        id: legacyFile
        title: "选择旧摘要 JSON"
        nameFilters: ["摘要 JSON (*.json)"]
        onAccepted: session.chooseSummaryFile(selectedFile)
    }
    ColumnLayout {
        anchors.fill: parent
        spacing: 16
        RowLayout {
            Layout.fillWidth: true
            // The memory page lives inside the archive drawer, whose portal
            // already shows the title and close control.
            visible: tasks.page !== "memory"
            ColumnLayout {
                spacing: 4
                Text {
                    textFormat: Text.PlainText
                    text: ({
                            character: "角色与形象",
                            memory: "记忆与资料",
                            activities: tasks.diaryActive ? "日记" : tasks.gomokuActive ? "五子棋"
                                : tasks.chessActive ? "国际象棋" : tasks.goActive ? "围棋" : "中国象棋",
                            settings: "空间控制台",
                            about: "关于这个空间",
                            palette: "前往哪里？"
                        })[tasks.page] || ""
                    color: "#ecf4fa"
                    font.pixelSize: 23
                    font.weight: Font.DemiBold
                }
                Text {
                    textFormat: Text.PlainText
                    text: ({
                            character: "一个形象，始终在场",
                            memory: "保留值得记住的，决定如何使用",
                            activities: tasks.diaryActive ? "读她每天写的日记" : "和角色下一盘",
                            settings: "连接、授权与空间偏好",
                            about: "REVERIE / SCENE",
                            palette: "场景物件与快捷入口使用同一个控制器"
                        })[tasks.page] || ""
                    color: "#8dabc0"
                    font.pixelSize: 12
                }
            }
            Item {
                Layout.fillWidth: true
            }
            GlassButton {
                text: "×"
                Accessible.name: "关闭面板"
                onClicked: navigation.close()
            }
        }
        Text {
            objectName: "runtimeRecoveryWarning"
            Layout.fillWidth: true
            visible: !tasks.writesAllowed
            textFormat: Text.PlainText
            text: session.recoveryWarning || "本地数据可写状态尚未确认，写入暂停；草稿已保留。"
            color: "#e6b4a4"
            font.pixelSize: 12
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        // Action feedback belongs to the active management page, not a row
        // or either long list. Reserve layout space so a reply stays readable
        // at the user's current scroll position without covering controls.
        Text {
            objectName: "memoryActionFeedback"
            Layout.fillWidth: true
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && text.length > 0
            textFormat: Text.PlainText
            text: tasks.actionFeedback.text || ""
            color: tasks.feedbackColor(tasks.actionFeedback)
            font.pixelSize: 12
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        Text {
            objectName: "memoryBatchPinFeedback"
            Layout.fillWidth: true
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && !["idle", "previewing", "ready", "preview_error"].includes(tasks.memoryBatchPin.status || "idle") && text.length > 0
            textFormat: Text.PlainText
            text: tasks.memoryBatchPin.status === "success" && Number.isInteger(tasks.memoryBatchPin.actualChangedCount)
                ? (tasks.memoryBatchPin.pinned ? "实际固定" : "实际取消固定") + tasks.memoryBatchPin.actualChangedCount + "条，" + tasks.memoryBatchPin.unchangedCount + "条无需更改；当前人格已固定" + tasks.memoryBatchPin.pinnedTotal + "条／上限" + tasks.memoryBatchPin.pinLimit + "条。"
                : tasks.memoryBatchPin.text || ""
            color: tasks.feedbackColor(tasks.memoryBatchPin)
            font.pixelSize: 12
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        Text {
            objectName: "memoryCandidateBatchFeedback"
            Layout.fillWidth: true
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && !["idle", "previewing", "ready", "preview_error"].includes(tasks.memoryCandidateBatch.status || "idle") && text.length > 0
            textFormat: Text.PlainText
            text: tasks.memoryCandidateBatch.text || ""
            color: tasks.feedbackColor(tasks.memoryCandidateBatch)
            font.pixelSize: 12
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        Text {
            objectName: "memoryCandidatePageInfo"
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            textFormat: Text.PlainText
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && (tasks.candidatePage.live === true || tasks.candidateRows.length > 0 || tasks.candidatePage.busy === true)
            text: "待确认 · 第" + (tasks.candidatePage.pageNumber || 1) + "批 · 本批" + tasks.candidateRows.length + "条"
            color: "#d8c79f"
            font.pixelSize: 14
            wrapMode: Text.Wrap
            Accessible.role: Accessible.StaticText
            Accessible.name: text
        }
        ScrollView {
            id: pageScroll
            objectName: "memoryPageScroll"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: availableWidth
            contentHeight: pageScrollContent.implicitHeight + 16
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            onHeightChanged: tasks.queuePersonaImportFeedbackReveal()
            onContentHeightChanged: tasks.queuePersonaImportFeedbackReveal()
            ColumnLayout {
                id: pageScrollContent
                width: parent.width
                spacing: 18
                ColumnLayout {
                    visible: tasks.page === "character"
                    Layout.fillWidth: true
                    spacing: 15
                    Text {
                        textFormat: Text.PlainText
                        text: session.avatarState
                        color: "#b8ddca"
                        font.pixelSize: 14
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                    Text {
                        objectName: "avatarRemovalFeedback"
                        Layout.fillWidth: true
                        visible: text.length > 0
                        text: tasks.avatarRemovalFeedback.text || ""
                        textFormat: Text.PlainText
                        color: tasks.avatarRemovalFeedback.status === "success" ? "#b8ddca" : "#e6b4a4"
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                    }
                    GlassButton {
                        objectName: "importModel"
                        enabled: tasks.writesAllowed && !session.avatarBusy
                        text: "导入 Live2D 模型"
                        onClicked: {
                            session.dismissAvatarRemovalSuccess();
                            modelFolder.open();
                        }
                    }
                    Text {
                        textFormat: Text.PlainText
                        text: "先在场景中预览，确认后才保存为当前形象。原资源不会被修改。"
                        color: "#95a9bd"
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        font.pixelSize: 13
                    }
                    ColumnLayout {
                        visible: Object.keys(session.avatarCandidate).length > 0
                        Layout.fillWidth: true
                        Text {
                            textFormat: Text.PlainText
                            text: session.avatarCandidate.name || ""
                            color: "#ecf4fa"
                            font.pixelSize: 15
                        }
                        CheckBox {
                            id: rights
                            objectName: "modelRights"
                            text: "我有权在本机使用这些模型资源"
                            palette.windowText: "#d8e5ef"
                        }
                        Text {
                            textFormat: Text.PlainText
                            visible: (session.avatarCandidate.warnings || []).length > 0
                            Layout.fillWidth: true
                            text: (session.avatarCandidate.warnings || []).join("\n")
                            color: "#d7bf97"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        CheckBox {
                            id: performanceWarning
                            objectName: "modelWarnings"
                            visible: (session.avatarCandidate.warnings || []).length > 0
                            text: "我已阅读并接受上述资源调整与性能提示"
                            palette.windowText: "#d8e5ef"
                        }
                        GlassButton {
                            objectName: "confirmModel"
                            text: "保留这个形象"
                            accented: true
                            enabled: tasks.writesAllowed && !session.avatarBusy && rights.checked && (!(session.avatarCandidate.warnings || []).length || performanceWarning.checked) && session.avatarCandidate.previewReady === true
                            onClicked: session.confirmModel(rights.checked, performanceWarning.checked)
                        }
                    }
                    Repeater {
                        model: session.state.avatars ? session.state.avatars.records : []
                        ColumnLayout {
                            id: avatarRow
                            required property var modelData
                            readonly property string removalBlocker: tasks.avatarRemovalBlocker(modelData.id)
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            spacing: 4
                            RowLayout {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 8
                                GlassButton {
                                    objectName: "avatarRecord-" + avatarRow.modelData.id
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: 0
                                    Layout.preferredWidth: 1
                                    text: avatarRow.modelData.name + (session.state.avatars.activeId === avatarRow.modelData.id ? " · 当前" : "")
                                    enabled: tasks.writesAllowed
                                    onClicked: session.selectModel(avatarRow.modelData.id)
                                }
                                GlassButton {
                                    objectName: "avatarRemove-" + avatarRow.modelData.id
                                    text: "删除"
                                    readonly property string removalBlocker: avatarRow.removalBlocker
                                    enabled: removalBlocker.length === 0 && !tasks.modalOpen
                                    ToolTip.visible: hovered && !enabled && removalBlocker.length > 0
                                    ToolTip.text: removalBlocker
                                    onClicked: {
                                        if (avatarRow.removalBlocker.length > 0)
                                            return;
                                        avatarRemoveDialog.targetId = avatarRow.modelData.id;
                                        avatarRemoveDialog.targetName = avatarRow.modelData.name || "未命名形象";
                                        session.dismissAvatarRemovalSuccess();
                                        avatarRemoveDialog.open();
                                    }
                                }
                            }
                            Text {
                                objectName: "avatarRemoveReason-" + avatarRow.modelData.id
                                Layout.fillWidth: true
                                visible: avatarRow.removalBlocker.length > 0
                                text: avatarRow.removalBlocker
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#aabfce"
                                font.pixelSize: 12
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                        }
                    }
                    RowLayout {
                        Layout.fillWidth: true
                        Repeater {
                            model: session.state.avatars?.records?.find(r => r.id === session.state.avatars.activeId)?.detected?.animationClips || []
                            GlassButton {
                                required property string modelData
                                text: modelData
                                onClicked: tasks.avatarItem.playMotion(modelData)
                            }
                        }
                    }
                    ComboBox {
                        Layout.fillWidth: true
                        model: session.state.avatars?.records?.find(r => r.id === session.state.avatars.activeId)?.detected?.expressions || []
                        onActivated: tasks.avatarItem.expression(currentText)
                    }
                    Rectangle {
                        Layout.fillWidth: true
                        height: 1
                        color: "#1cb8d4d4"
                    }
                    Text {
                        textFormat: Text.PlainText
                        text: "人格与角色"
                        color: "#dfeaf4"
                        font.pixelSize: 17
                    }
                    Text {
                        objectName: "personaCurrentName"
                        textFormat: Text.PlainText
                        text: session.state.persona ? (session.state.persona.name || session.state.persona.persona?.name || "当前人格已连接") : "正在读取…"
                        color: "#9fb4c7"
                        font.pixelSize: 14
                        Layout.fillWidth: true
                        wrapMode: Text.Wrap
                    }
                    ColumnLayout {
                        id: relationshipBlock
                        objectName: "relationshipStatus"
                        readonly property var snapshot: session.relationshipStatus || ({})
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 4

                        component RelationshipLine: Text {
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            color: "#9fb4c7"
                            font.pixelSize: 13
                            Layout.fillWidth: true
                            wrapMode: Text.Wrap
                        }
                        RelationshipLine {
                            text: relationshipBlock.snapshot.message || ""
                        }
                        RelationshipLine {
                            objectName: "relationshipStage"
                            text: relationshipBlock.snapshot.stage || ""
                        }
                        RelationshipLine {
                            objectName: "relationshipDetail"
                            text: relationshipBlock.snapshot.detail || ""
                        }
                        RelationshipLine {
                            objectName: "relationshipIntimacy"
                            text: relationshipBlock.snapshot.intimacy || ""
                        }
                        RelationshipLine {
                            objectName: "relationshipNote"
                            text: relationshipBlock.snapshot.note || ""
                        }
                        RelationshipLine {
                            objectName: "relationshipRefreshNote"
                            text: relationshipBlock.snapshot.refreshNote || ""
                        }
                    }
                    ColumnLayout {
                        id: moodBlock
                        objectName: "moodStatus"
                        readonly property var snapshot: session.moodStatus || ({})
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 4

                        component MoodLine: Text {
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            color: "#9fb4c7"
                            font.pixelSize: 13
                            Layout.fillWidth: true
                            wrapMode: Text.Wrap
                        }
                        MoodLine {
                            objectName: "moodMessage"
                            text: moodBlock.snapshot.message || ""
                        }
                        MoodLine {
                            objectName: "moodLabel"
                            text: moodBlock.snapshot.label || ""
                        }
                        MoodLine {
                            objectName: "moodDominant"
                            text: moodBlock.snapshot.dominant || ""
                        }
                        MoodLine {
                            objectName: "moodRefreshNote"
                            text: moodBlock.snapshot.refreshNote || ""
                        }
                    }
                    Flow {
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        spacing: 8
                        GlassButton {
                            objectName: "personaImportCard"
                            text: "导入角色卡…"
                            enabled: tasks.personaSwitchAllowed
                            onClicked: personaCardFile.open()
                        }
                        GlassButton {
                            objectName: "personaCardExport"
                            text: "导出角色卡…"
                            enabled: tasks.personaExportAvailable
                            onClicked: {
                                personaCardExportDialog.boundScope = tasks.personaScope;
                                personaCardExportDialog.boundGeneration = tasks.personaExportGeneration;
                                const books = session.personaCardExportBooks || [];
                                personaCardExportBook.currentIndex = Math.max(0, books.findIndex(book => book.id === session.personaCardExportDefaultBookId));
                                personaCardExportDialog.open();
                            }
                        }
                    }
                    // Directly under its button: an import that adds a row to
                    // the list below must not push its own result out of view.
                    Text {
                        id: personaImportFeedback
                        objectName: "personaImportFeedback"
                        visible: text.length > 0
                        textFormat: Text.PlainText
                        text: tasks.personaCardFeedback.text || ""
                        color: tasks.feedbackColor(tasks.personaCardFeedback)
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        onYChanged: tasks.queuePersonaImportFeedbackReveal()
                        onHeightChanged: tasks.queuePersonaImportFeedbackReveal()
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    Text {
                        objectName: "personaCardExportBuiltinNotice"
                        visible: session.personaCardExportBuiltin === true
                        text: "内置人格不能导出角色卡"
                        textFormat: Text.PlainText
                        color: "#9fb4c7"
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                    Text {
                        objectName: "personaCardExportFeedback"
                        visible: text.length > 0
                        text: tasks.personaCardExportState.text || ""
                        textFormat: Text.PlainText
                        color: tasks.feedbackColor(tasks.personaCardExportState)
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    Text {
                        objectName: "personaProfileFeedback"
                        visible: text.length > 0
                        Layout.fillWidth: true
                        text: tasks.personaProfileState.text || ""
                        textFormat: Text.PlainText
                        color: tasks.feedbackColor(tasks.personaProfileState)
                        wrapMode: Text.Wrap
                        font.pixelSize: 13
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    Repeater {
                        model: tasks.personaProfiles
                        delegate: RowLayout {
                            required property var modelData
                            required property int index
                            objectName: "personaRow-" + modelData.id
                            Layout.fillWidth: true
                            spacing: 10
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 2
                                Text {
                                    Layout.fillWidth: true
                                    textFormat: Text.PlainText
                                    text: modelData.name || modelData.id
                                    color: "#e3eff7"
                                    font.pixelSize: 14
                                    elide: Text.ElideRight
                                }
                                Text {
                                    textFormat: Text.PlainText
                                    text: tasks.personaSourceLabel(modelData.source_format)
                                    color: "#8498af"
                                    font.pixelSize: 11
                                }
                                Text {
                                    objectName: "personaEditDisabledHint_" + index
                                    Layout.fillWidth: true
                                    visible: text.length > 0
                                    textFormat: Text.PlainText
                                    text: tasks.personaProfileEditHint(modelData)
                                    color: "#8498af"
                                    font.pixelSize: 11
                                    wrapMode: Text.Wrap
                                    Accessible.role: Accessible.StaticText
                                    Accessible.name: text
                                }
                            }
                            Text {
                                objectName: "personaActive-" + modelData.id
                                visible: modelData.active === true
                                textFormat: Text.PlainText
                                text: "当前"
                                color: "#b7d5cf"
                                font.pixelSize: 12
                            }
                            GlassButton {
                                objectName: "personaEdit_" + index
                                text: "编辑"
                                enabled: session.connected && tasks.writesAllowed && !session.personaChanging && !session.personaProfilePending && tasks.personaCardExportState.status !== "pending" && tasks.personaProfileEditHint(modelData) === ""
                                Accessible.name: "编辑" + (modelData.name || modelData.id)
                                onClicked: session.loadPersonaProfile(modelData.id)
                            }
                            GlassButton {
                                objectName: "personaSwitch-" + modelData.id
                                visible: modelData.active !== true
                                text: "切换"
                                enabled: tasks.personaSwitchAllowed
                                Accessible.name: "切换为" + (modelData.name || modelData.id)
                                onClicked: tasks.confirmPersonaSwitch(modelData.id, modelData.name || modelData.id)
                            }
                        }
                    }
                    Text {
                        objectName: "personaSingleHint"
                        visible: session.state.personas !== undefined && tasks.personaProfiles.length <= 1
                        textFormat: Text.PlainText
                        text: "目前只有一个本地人格。导入角色卡后可在此切换。"
                        color: "#8498af"
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                    Text {
                        objectName: "personaFeedback"
                        visible: text.length > 0
                        textFormat: Text.PlainText
                        text: tasks.personaFeedback.text || ""
                        color: tasks.feedbackColor(tasks.personaFeedback)
                        font.pixelSize: 13
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    Text {
                        textFormat: Text.PlainText
                        text: "形象更换不会改变人格。切换人格会取消进行中的回复，记忆、聊天和日记按人格分开保存。"
                        color: "#8498af"
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                    // After the list, so an import never moves its own result
                    // out of view; shown only for a persona that has such text.
                    ColumnLayout {
                        objectName: "authorPromptSection"
                        visible: !!(tasks.authorPrompts.system?.text || tasks.authorPrompts.post_history?.text)
                        Layout.fillWidth: true
                        spacing: 10
                        Rectangle {
                            Layout.fillWidth: true
                            implicitHeight: 1
                            color: "#1cb8d4d4"
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "卡作者提示"
                            color: "#dfeaf4"
                            font.pixelSize: 17
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "导入的角色卡里由作者写的提示，默认不启用，只对当前人格生效。开启后每轮对话都会附上，不能覆盖身份与安全规则。含可疑指令的提示不能开启。"
                            color: "#8498af"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        // Above the switches, so a long prompt below them never pushes the
                        // result of a switch out of view.
                        Text {
                            objectName: "authorPromptBlocked"
                            visible: text.length > 0 && tasks.authorPromptFeedback.status !== "pending"
                            textFormat: Text.PlainText
                            text: archiveEditor.authorPromptBlocker
                            color: "#8498af"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "authorPromptFeedback"
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.authorPromptFeedback.text || ""
                            color: tasks.feedbackColor(tasks.authorPromptFeedback)
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Repeater {
                            model: [
                                {
                                    kind: "system",
                                    title: "系统提示"
                                },
                                {
                                    kind: "post_history",
                                    title: "对话后指令"
                                }
                            ]
                            delegate: ColumnLayout {
                                id: authorPromptItem
                                required property var modelData
                                readonly property var item: tasks.authorPrompts[modelData.kind] || ({})
                                readonly property bool flagged: (item.flags || []).length > 0
                                property bool expanded: false
                                objectName: "authorPrompt-" + modelData.kind
                                visible: !!item.text
                                Layout.fillWidth: true
                                spacing: 6
                                GlassSwitch {
                                    id: authorSwitch
                                    objectName: "authorPromptSwitch-" + authorPromptItem.modelData.kind
                                    readonly property bool pending: tasks.authorPromptFeedback.status === "pending" && tasks.authorPromptFeedback.kind === authorPromptItem.modelData.kind
                                    readonly property bool shownValue: pending ? tasks.authorPromptFeedback.enabled === true : authorPromptItem.item.enabled === true
                                    text: "启用卡作者" + authorPromptItem.modelData.title
                                    checked: shownValue
                                    // A flagged prompt can only be turned off, never on.
                                    enabled: archiveEditor.authorPromptBlocker === "" && (authorPromptItem.item.enabled === true || !authorPromptItem.flagged)
                                    onToggled: {
                                        const wanted = checked;
                                        checked = Qt.binding(() => authorSwitch.shownValue);
                                        if (wanted)
                                            tasks.confirmAuthorPrompt(authorPromptItem.modelData.kind);
                                        else
                                            archiveEditor.setAuthorPrompt(authorPromptItem.modelData.kind, false, false);
                                    }
                                }
                                Text {
                                    objectName: "authorPromptFlagged-" + authorPromptItem.modelData.kind
                                    visible: authorPromptItem.flagged
                                    textFormat: Text.PlainText
                                    text: "这段" + authorPromptItem.modelData.title + "含有可疑指令（" + tasks.authorPromptFlagText(authorPromptItem.item.flags) + "），已隔离，不能开启。" + (authorPromptItem.item.enabled === true ? "档案里这项是开启的，但不会发给模型；可以关闭。" : "")
                                    color: "#e6b4a4"
                                    font.pixelSize: 12
                                    wrapMode: Text.Wrap
                                    Layout.fillWidth: true
                                }
                                Text {
                                    objectName: "authorPromptText-" + authorPromptItem.modelData.kind
                                    textFormat: Text.PlainText
                                    text: authorPromptItem.item.text || ""
                                    color: "#b9cad6"
                                    font.pixelSize: 13
                                    wrapMode: Text.Wrap
                                    maximumLineCount: authorPromptItem.expanded ? 100000 : 4
                                    elide: Text.ElideRight
                                    Layout.fillWidth: true
                                }
                                RowLayout {
                                    spacing: 10
                                    Text {
                                        textFormat: Text.PlainText
                                        text: "共 " + (authorPromptItem.item.text || "").length + " 字"
                                        color: "#819ab0"
                                        font.pixelSize: 12
                                    }
                                    GlassButton {
                                        objectName: "authorPromptExpand-" + authorPromptItem.modelData.kind
                                        text: authorPromptItem.expanded ? "收起" : "展开全文"
                                        onClicked: authorPromptItem.expanded = !authorPromptItem.expanded
                                    }
                                }
                            }
                        }
                    }
                }
                ColumnLayout {
                    objectName: "memoryPage"
                    visible: tasks.page === "memory"
                    Layout.fillWidth: true
                    spacing: 12
                    RowLayout {
                        Layout.fillWidth: true
                        Text {
                            textFormat: Text.PlainText
                            text: "记忆与摘要"
                            color: "#edf6f5"
                            font.pixelSize: 18
                            font.weight: Font.DemiBold
                        }
                        Item {
                            Layout.fillWidth: true
                        }
                        GlassButton {
                            id: openWorldbook
                            objectName: "memory-open-worldbook"
                            text: "世界书"
                            implicitHeight: 28
                            padding: 5
                            onClicked: tasks.navigation.open("memory", "worldbook", openWorldbook)
                        }
                    }
                    // World books are edited only in the archive drawer's single
                    // persistent editor; this page holds memories and summaries.
                    // Glass segments matching the navigation rail; the selected
                    // page is accented like the current rail destination.
                    RowLayout {
                        id: memoryTabs
                        objectName: "memoryTabs"
                        property int currentIndex: 0
                        onCurrentIndexChanged: {
                            if (currentIndex !== 0)
                                tasks.cancelCandidateFocus("page");
                        }
                        Layout.fillWidth: true
                        spacing: 6
                        Repeater {
                            model: [
                                {
                                    name: "memories",
                                    label: "记忆"
                                },
                                {
                                    name: "summary",
                                    label: "摘要"
                                },
                                {
                                    name: "profile",
                                    label: "你的资料"
                                },
                                {
                                    name: "backup",
                                    label: "备份"
                                },
                                {
                                    name: "recall",
                                    label: "关联回忆"
                                }
                            ]
                            GlassButton {
                                id: memoryTabButton
                                required property var modelData
                                required property int index
                                objectName: "memoryTab-" + modelData.name
                                Layout.fillWidth: true
                                Layout.fillHeight: true
                                Layout.preferredWidth: 1
                                Layout.minimumWidth: 0
                                implicitHeight: Math.max(32, contentItem.implicitHeight + topPadding + bottomPadding)
                                padding: 5
                                text: modelData.label
                                contentItem: Text {
                                    objectName: "memoryTabLabel-" + memoryTabButton.modelData.name
                                    textFormat: Text.PlainText
                                    text: memoryTabButton.text
                                    font: memoryTabButton.font
                                    color: memoryTabButton.enabled ? (memoryTabButton.accented ? "#f2fbfa" : "#e0e9eb") : "#75858a"
                                    horizontalAlignment: Text.AlignHCenter
                                    verticalAlignment: Text.AlignVCenter
                                    wrapMode: Text.Wrap
                                    maximumLineCount: 2
                                    elide: Text.ElideNone
                                }
                                accented: memoryTabs.currentIndex === index
                                Accessible.role: Accessible.PageTab
                                Accessible.checked: accented
                                onClicked: memoryTabs.currentIndex = index
                            }
                        }
                    }
                    ColumnLayout {
                        visible: memoryTabs.currentIndex === 0
                        Layout.fillWidth: true
                        spacing: 10
                        Text {
                            textFormat: Text.PlainText
                            text: "当前人格的记忆"
                            color: "#e3eff7"
                            font.pixelSize: 16
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "按当前人格隔离。待确认的内容来自你说过的话，记住后才会在对话中使用。"
                            color: "#94a9bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            GlassButton {
                                id: memoryRefresh
                                objectName: "memoryRefresh"
                                text: "刷新记忆"
                                enabled: session.connected && tasks.listFeedback.status !== "pending" && tasks.candidatePage.decisionBusy !== true && tasks.memoryBatchDelete.busy !== true && tasks.memoryBatchPin.busy !== true && (!tasks.memoryBatchPinBlocked || tasks.memoryBatchPin.status === "unknown") && tasks.memoryCandidateBatch.busy !== true && (!tasks.candidateBatchBlocked || tasks.memoryCandidateBatch.status === "unknown")
                                onClicked: session.refreshMemories()
                            }
                            GlassButton {
                                objectName: "memorySelectMode"
                                text: "选择"
                                visible: !tasks.memorySelectionMode
                                enabled: tasks.memoryActionsEnabled && !tasks.candidateDecisionLocked && !tasks.candidateSelectionMode && tasks.listFeedback.status !== "pending" && tasks.memoryRows.length > 0
                                onClicked: tasks.beginMemorySelection()
                            }
                            Item { Layout.fillWidth: true }
                        }
                        // A literal filter over the confirmed list; the bridge keeps the applied one.
                        RowLayout {
                            id: memoryFilterRow
                            Layout.fillWidth: true
                            spacing: 6
                            readonly property string appliedQuery: session.memoryQuery
                            onAppliedQueryChanged: memoryFilterField.text = appliedQuery
                            function apply() {
                                if (tasks.candidatePage.decisionBusy === true || tasks.memoryBatchDeleteBlocked || tasks.memoryBatchPinBlocked || tasks.candidateBatchBlocked)
                                    return;
                                session.filterMemories(memoryFilterField.text);
                            }
                            GlassField {
                                id: memoryFilterField
                                objectName: "memoryFilterField"
                                Layout.fillWidth: true
                                placeholderText: "筛选记忆中的文字"
                                maximumLength: 100
                                enabled: !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && !tasks.candidateBatchBlocked
                                Keys.onReturnPressed: event => {
                                    if (memoryFilterField.inputMethodComposing) {
                                        event.accepted = false;
                                        return;
                                    }
                                    memoryFilterRow.apply();
                                    event.accepted = true;
                                }
                            }
                            GlassButton {
                                objectName: "memoryFilterApply"
                                text: "筛选"
                                implicitHeight: 32
                                padding: 5
                                enabled: session.connected && tasks.listFeedback.status !== "pending" && tasks.candidatePage.decisionBusy !== true && !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && !tasks.candidateBatchBlocked
                                onClicked: memoryFilterRow.apply()
                            }
                            GlassButton {
                                objectName: "memoryFilterClear"
                                visible: session.memoryQuery.length > 0
                                text: "清除"
                                implicitHeight: 32
                                padding: 5
                                enabled: session.connected && tasks.listFeedback.status !== "pending" && tasks.candidatePage.decisionBusy !== true && !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && !tasks.candidateBatchBlocked
                                onClicked: session.filterMemories("")
                            }
                        }
                        Text {
                            objectName: "memoryListFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.listFeedback.text || ""
                            color: tasks.feedbackColor(tasks.listFeedback)
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        ColumnLayout {
                            id: candidateRegion
                            objectName: "memoryCandidateRegion"
                            Layout.fillWidth: true
                            spacing: 8
                            Text {
                                objectName: "memoryCandidateFeedback"
                                Layout.fillWidth: true
                                visible: text.length > 0
                                textFormat: Text.PlainText
                                text: tasks.candidateFeedback.text || ""
                                color: tasks.feedbackColor(tasks.candidateFeedback)
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                GlassButton {
                                    id: candidateFirst
                                    objectName: "memoryCandidateFirst"
                                    visible: tasks.candidateRows.length > 0 || tasks.candidatePage.pageNumber > 1 || tasks.candidatePage.busy === true || tasks.candidatePage.needsRefresh === true
                                    text: "回到首批"
                                    implicitHeight: 30
                                    padding: 6
                                    enabled: session.connected && tasks.candidatePage.decisionBusy !== true && !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && (!tasks.candidateSelectionMode || tasks.memoryCandidateBatch.status === "unknown") && (!tasks.candidateBatchBlocked || tasks.memoryCandidateBatch.status === "unknown")
                                    onPressed: tasks.prepareCandidateFocus(candidateFirst, "first", "")
                                    onReleased: tasks.releaseCandidateFocus(candidateFirst)
                                    onCanceled: tasks.cancelPreparedCandidateFocus(candidateFirst)
                                    onEnabledChanged: tasks.queueCandidateFocusReconcile()
                                    onVisibleChanged: tasks.queueCandidateFocusReconcile()
                                    onClicked: {
                                        if (!enabled || !visible)
                                            return;
                                        const serial = tasks.commitCandidateFocus(candidateFirst, "first", "");
                                        session.firstMemoryCandidates();
                                        tasks.candidateFocusRequestStarted(serial);
                                    }
                                }
                                GlassButton {
                                    id: candidateNext
                                    objectName: "memoryCandidateNext"
                                    visible: tasks.candidatePage.hasMore === true
                                    text: "下一批"
                                    implicitHeight: 30
                                    padding: 6
                                    enabled: session.connected && tasks.candidatePage.live === true && tasks.candidatePage.busy !== true && tasks.candidatePage.blocked !== true && !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && !tasks.candidateSelectionMode
                                    onPressed: tasks.prepareCandidateFocus(candidateNext, "next", "")
                                    onReleased: tasks.releaseCandidateFocus(candidateNext)
                                    onCanceled: tasks.cancelPreparedCandidateFocus(candidateNext)
                                    onClicked: {
                                        if (!enabled)
                                            return;
                                        const serial = tasks.commitCandidateFocus(candidateNext, "next", "");
                                        session.loadNextMemoryCandidates();
                                        tasks.candidateFocusRequestStarted(serial);
                                    }
                                }
                                GlassButton {
                                    objectName: "memoryCandidateSelectMode"
                                    visible: !tasks.candidateSelectionMode && tasks.candidateRows.length > 0
                                    text: "选择"
                                    implicitHeight: 30
                                    padding: 6
                                    enabled: tasks.candidateActionsEnabled && !tasks.memorySelectionMode
                                    onClicked: tasks.beginCandidateSelection()
                                }
                            }
                            Repeater {
                                model: tasks.candidateRows
                                ColumnLayout {
                                    required property var modelData
                                    required property int index
                                    readonly property string candidateId: modelData.id || ""
                                    Layout.fillWidth: true
                                    spacing: 4
                                    Text {
                                        textFormat: Text.PlainText
                                        Layout.fillWidth: true
                                        text: modelData.proposed_text || ""
                                        color: "#e2e9ef"
                                        wrapMode: Text.Wrap
                                        font.pixelSize: 14
                                    }
                                    Text {
                                        textFormat: Text.PlainText
                                        Layout.fillWidth: true
                                        visible: text.length > 0
                                        text: modelData.source_text ? "来自：" + modelData.source_text : ""
                                        color: "#8fa5b8"
                                        font.pixelSize: 11
                                        elide: Text.ElideRight
                                        maximumLineCount: 1
                                    }
                                    CheckBox {
                                        id: candidateChoice
                                        readonly property string candidateId: modelData.id || ""
                                        objectName: "memoryCandidateSelect" + index
                                        visible: tasks.candidateSelectionMode
                                        text: "选择这条候选"
                                        enabled: tasks.candidateSelectionEditable && (checked || tasks.candidateSelectedIds.length < 100)
                                        checked: tasks.candidateSelectedIds.includes(candidateId)
                                        contentItem: Text {
                                            objectName: "memoryCandidateSelectLabel" + index
                                            leftPadding: candidateChoice.indicator.width + candidateChoice.spacing
                                            text: candidateChoice.text
                                            textFormat: Text.PlainText
                                            font: candidateChoice.font
                                            color: candidateChoice.enabled ? "#dce9f2" : "#b0bfc4"
                                            verticalAlignment: Text.AlignVCenter
                                        }
                                        onToggled: tasks.toggleCandidateSelection(candidateId, checked)
                                    }
                                    RowLayout {
                                        visible: !tasks.candidateSelectionMode
                                        GlassButton {
                                            id: candidateConfirm
                                            objectName: "memoryCandidateConfirm" + index
                                            text: "记住"
                                            accented: true
                                            implicitHeight: 28
                                            padding: 5
                                            enabled: tasks.candidateActionsEnabled
                                            onPressed: tasks.prepareCandidateFocus(candidateConfirm, "confirm", modelData.id)
                                            onReleased: tasks.releaseCandidateFocus(candidateConfirm)
                                            onCanceled: tasks.cancelPreparedCandidateFocus(candidateConfirm)
                                            onClicked: {
                                                if (!enabled)
                                                    return;
                                                const serial = tasks.commitCandidateFocus(candidateConfirm, "confirm", modelData.id);
                                                session.decideMemoryCandidate(modelData.id, true);
                                                tasks.candidateFocusRequestStarted(serial);
                                            }
                                        }
                                        GlassButton {
                                            id: candidateReject
                                            objectName: "memoryCandidateReject" + index
                                            text: "不记"
                                            implicitHeight: 28
                                            padding: 5
                                            enabled: tasks.candidateActionsEnabled
                                            onPressed: tasks.prepareCandidateFocus(candidateReject, "reject", modelData.id)
                                            onReleased: tasks.releaseCandidateFocus(candidateReject)
                                            onCanceled: tasks.cancelPreparedCandidateFocus(candidateReject)
                                            onClicked: {
                                                if (!enabled)
                                                    return;
                                                const serial = tasks.commitCandidateFocus(candidateReject, "reject", modelData.id);
                                                session.decideMemoryCandidate(modelData.id, false);
                                                tasks.candidateFocusRequestStarted(serial);
                                            }
                                        }
                                    }
                                }
                            }
                            Rectangle {
                                Layout.fillWidth: true
                                Layout.preferredHeight: 1
                                visible: tasks.candidateRows.length > 0
                                color: "#1cb8d4d4"
                            }
                        }
                        Repeater {
                            model: tasks.memoryRows
                            ColumnLayout {
                                id: memoryRow
                                required property var modelData
                                required property int index
                                readonly property bool editing: tasks.editingMemoryId !== "" && tasks.editingMemoryId === modelData.id
                                readonly property bool confirmingDelete: tasks.deletingMemoryId !== "" && tasks.deletingMemoryId === modelData.id
                                Layout.fillWidth: true
                                spacing: 6
                                Text {
                                    objectName: "memoryText" + memoryRow.index
                                    visible: !memoryRow.editing
                                    textFormat: Text.PlainText
                                    Layout.fillWidth: true
                                    text: (memoryRow.modelData.pinned ? "已固定 · " : "") + (memoryRow.modelData.text || "")
                                    color: "#c6d4e3"
                                    wrapMode: Text.Wrap
                                    font.pixelSize: 14
                                }
                                Text {
                                    objectName: "memoryImportance" + memoryRow.index
                                    visible: !memoryRow.editing
                                    textFormat: Text.PlainText
                                    Layout.fillWidth: true
                                    text: "重要度 " + tasks.memoryImportanceText(memoryRow.modelData.importance)
                                    color: "#94a9bb"
                                    wrapMode: Text.Wrap
                                    font.pixelSize: 12
                                }
                                CheckBox {
                                    id: memoryChoice
                                    readonly property string memoryId: memoryRow.modelData.id || ""
                                    objectName: "memorySelect" + memoryRow.index
                                    visible: tasks.memorySelectionMode
                                    text: "选择这条记忆"
                                    enabled: tasks.memorySelectionEditable && (checked || tasks.memorySelectedIds.length < 100)
                                    checked: tasks.memorySelectedIds.includes(memoryId)
                                    contentItem: Text {
                                        objectName: "memorySelectLabel" + memoryRow.index
                                        leftPadding: memoryChoice.indicator.width + memoryChoice.spacing
                                        text: memoryChoice.text
                                        textFormat: Text.PlainText
                                        font: memoryChoice.font
                                        color: memoryChoice.enabled ? "#dce9f2" : "#b0bfc4"
                                        verticalAlignment: Text.AlignVCenter
                                    }
                                    onToggled: tasks.toggleMemorySelection(memoryId, checked)
                                }
                                GlassField {
                                    id: memoryEditField
                                    objectName: "memoryEditField"
                                    visible: memoryRow.editing
                                    Layout.fillWidth: true
                                    placeholderText: "修改后的记忆内容"
                                }
                                Flow {
                                    Layout.fillWidth: true
                                    spacing: 6
                                    visible: !memoryRow.editing && !memoryRow.confirmingDelete
                                    GlassButton {
                                        objectName: "memoryPin" + memoryRow.index
                                        text: memoryRow.modelData.pinned ? "取消固定" : "固定"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.setMemoryPinned(memoryRow.modelData.id, !memoryRow.modelData.pinned);
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryEdit" + memoryRow.index
                                        text: "修改"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (!tasks.singleMemoryActionsEnabled)
                                                return;
                                            tasks.deletingMemoryId = "";
                                            tasks.editingMemoryId = memoryRow.modelData.id;
                                            memoryEditField.text = memoryRow.modelData.text || "";
                                            memoryEditField.forceActiveFocus();
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryDelete" + memoryRow.index
                                        text: "删除"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (!tasks.singleMemoryActionsEnabled)
                                                return;
                                            tasks.editingMemoryId = "";
                                            tasks.deletingMemoryId = memoryRow.modelData.id;
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryStrengthen" + memoryRow.index
                                        text: "强化"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.adjustMemory(memoryRow.modelData.id, "strengthen");
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryWeaken" + memoryRow.index
                                        text: "弱化"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.adjustMemory(memoryRow.modelData.id, "weaken");
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryReactivate" + memoryRow.index
                                        text: "重温"
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.adjustMemory(memoryRow.modelData.id, "reactivate");
                                        }
                                    }
                                }
                                RowLayout {
                                    visible: memoryRow.editing
                                    GlassButton {
                                        objectName: "memoryEditSave"
                                        text: "保存修改"
                                        accented: true
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled && memoryEditField.text.trim().length > 0
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.editMemory(memoryRow.modelData.id, memoryEditField.text);
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryEditCancel"
                                        text: "取消"
                                        implicitHeight: 28
                                        padding: 5
                                        onClicked: tasks.editingMemoryId = ""
                                    }
                                }
                                Text {
                                    visible: memoryRow.confirmingDelete
                                    textFormat: Text.PlainText
                                    Layout.fillWidth: true
                                    text: "删除会清除这条记忆及其全部修订，无法恢复。"
                                    color: "#e6b4a4"
                                    font.pixelSize: 12
                                    wrapMode: Text.Wrap
                                }
                                RowLayout {
                                    visible: memoryRow.confirmingDelete
                                    GlassButton {
                                        objectName: "memoryDeleteConfirm"
                                        text: "确认删除"
                                        accented: true
                                        implicitHeight: 28
                                        padding: 5
                                        enabled: tasks.singleMemoryActionsEnabled
                                        onClicked: {
                                            if (tasks.singleMemoryActionsEnabled)
                                                session.deleteMemory(memoryRow.modelData.id);
                                        }
                                    }
                                    GlassButton {
                                        objectName: "memoryDeleteCancel"
                                        text: "取消"
                                        implicitHeight: 28
                                        padding: 5
                                        onClicked: tasks.deletingMemoryId = ""
                                    }
                                }
                            }
                        }
                        // The next page of the shown list; a change or refresh starts again from the first.
                        GlassButton {
                            objectName: "memoryLoadMore"
                            visible: !!session.state.memory?.hasMore
                            text: tasks.listFeedback.status === "pending" ? "正在加载…" : "加载更多"
                            enabled: session.connected && tasks.listFeedback.status !== "pending" && !tasks.memoryBatchDeleteBlocked && !tasks.memoryBatchPinBlocked && !tasks.candidateBatchBlocked
                            onClicked: session.loadMoreMemories()
                        }
                    }
                    ColumnLayout {
                        visible: memoryTabs.currentIndex === 1
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "对话摘要"
                            color: "#e3eff7"
                            font.pixelSize: 16
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "回复完成后后台整理，下轮使用。不会删除原消息。"
                            color: "#94a9bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: summarySwitch
                            objectName: "summaryEnabled"
                            // The saved request until the status is read again, then the runtime value.
                            readonly property bool shownValue: typeof tasks.summaryFeedback.enabled === "boolean" ? tasks.summaryFeedback.enabled : session.state.summary?.enabled === true
                            text: "开启对话摘要"
                            checked: shownValue
                            enabled: session.connected && tasks.writesAllowed && session.state.summary?.ok !== false && typeof session.state.summary?.enabled === "boolean" && tasks.summaryFeedback.status !== "pending"
                            onToggled: {
                                session.setSummaryEnabled(checked);
                                checked = Qt.binding(() => summarySwitch.shownValue);
                            }
                        }
                        Text {
                            objectName: "summaryStatus"
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: tasks.summaryStatusText(session.state.summary)
                            color: session.state.summary?.ok === false ? "#e6b4a4" : "#acd7c7"
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "summaryFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.summaryFeedback.text || ""
                            color: tasks.feedbackColor(tasks.summaryFeedback)
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Rectangle {
                            Layout.fillWidth: true
                            Layout.preferredHeight: 1
                            color: "#1cb8d4d4"
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "旧摘要会加密隔离保存，全部保持未启用。"
                            color: "#9bb0c4"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassButton {
                            objectName: "summaryLegacyChoose"
                            text: "选择旧摘要文件"
                            enabled: session.connected && tasks.writesAllowed && tasks.legacyFeedback.status !== "pending"
                            onClicked: legacyFile.open()
                        }
                        Text {
                            objectName: "summaryLegacyFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.legacyFeedback.text || ""
                            color: tasks.feedbackColor(tasks.legacyFeedback)
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        GlassButton {
                            objectName: "summaryLegacyConfirm"
                            visible: session.state.importPreview !== undefined
                            enabled: session.connected && tasks.writesAllowed && tasks.legacyFeedback.status === "preview"
                            text: "确认加密隔离保存"
                            onClicked: session.confirmSummaryImport()
                        }
                        // Keep the existing switch, status and legacy controls
                        // at their original positions. This read-only section
                        // is appended after them inside the existing page scroll.
                        ColumnLayout {
                            objectName: "summaryReadSection"
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            spacing: 10
                            Rectangle {
                                Layout.fillWidth: true
                                Layout.preferredHeight: 1
                                color: "#1cb8d4d4"
                            }
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: "查看已生成的摘要"
                                color: "#e3eff7"
                                font.pixelSize: 15
                                wrapMode: Text.Wrap
                            }
                            Text {
                                objectName: "summaryReadScope"
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: "仅查看当前人格、当前会话中已生成的有效 AI 摘要。AI 摘要不是原始消息，可能省略或误解内容。"
                                color: "#94a9bb"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            RowLayout {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                GlassButton {
                                    objectName: "summaryDirectoryRefresh"
                                    text: "刷新摘要目录"
                                    enabled: tasks.summaryReadAllowed
                                    onClicked: session.refreshSummaryDirectory()
                                }
                                GlassButton {
                                    objectName: "summaryDetailClear"
                                    text: "关闭正文"
                                    enabled: tasks.summaryDetailState.status !== "idle" && !!tasks.summaryDetailState.summaryId
                                    onClicked: session.clearSummaryDetail()
                                }
                            }
                            Text {
                                objectName: "summaryDirectoryStatus"
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: tasks.summaryDirectoryText()
                                color: tasks.summaryDirectory.ok === false || (tasks.summaryDirectory.summaries !== undefined && !tasks.summaryDirectoryValid) ? "#e6b4a4" : "#b7d5cf"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            Text {
                                objectName: "summaryDirectoryLimit"
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: tasks.summaryDirectoryValid && tasks.summaryDirectory.hasMore ? "还有更早的摘要。这里只显示最近 100 段，不支持翻页；未列出的摘要不能在本页读取。" : "目录最多显示当前会话最近 100 段有效摘要，不支持翻页。"
                                color: "#94a9bb"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            ListView {
                                id: summaryDirectoryList
                                objectName: "summaryDirectoryList"
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                Layout.preferredHeight: Math.min(168, count * 56)
                                visible: count > 0
                                clip: true
                                spacing: 4
                                boundsBehavior: Flickable.StopAtBounds
                                model: tasks.summaryDirectoryRows
                                currentIndex: tasks.summarySelectedIndex
                                ScrollBar.vertical: ScrollBar {
                                    policy: ScrollBar.AsNeeded
                                }
                                delegate: GlassButton {
                                    id: summaryDirectoryEntry
                                    required property var modelData
                                    required property int index
                                    readonly property string summaryId: modelData.summary_id
                                    objectName: "summaryDirectoryEntry-" + summaryId
                                    width: summaryDirectoryList.width
                                    implicitHeight: Math.max(52, contentItem.implicitHeight + topPadding + bottomPadding)
                                    padding: 8
                                    text: tasks.summaryEntryText(modelData, index)
                                    accented: tasks.summaryDetailState.summaryId === summaryId
                                    enabled: tasks.summaryReadAllowed && !(tasks.summaryDetailState.status === "pending" && tasks.summaryDetailState.summaryId === summaryId)
                                    Accessible.role: Accessible.ListItem
                                    Accessible.selected: accented
                                    contentItem: Text {
                                        objectName: "summaryDirectoryLabel-" + summaryDirectoryEntry.summaryId
                                        textFormat: Text.PlainText
                                        text: summaryDirectoryEntry.text
                                        color: summaryDirectoryEntry.enabled ? "#dce9ed" : "#75858a"
                                        font: summaryDirectoryEntry.font
                                        horizontalAlignment: Text.AlignLeft
                                        verticalAlignment: Text.AlignVCenter
                                        wrapMode: Text.Wrap
                                        elide: Text.ElideNone
                                    }
                                    onClicked: session.readSummaryDetail(summaryId)
                                }
                            }
                            Text {
                                objectName: "summaryDetailSelection"
                                Layout.fillWidth: true
                                visible: !!tasks.summaryDetailState.summaryId
                                textFormat: Text.PlainText
                                text: tasks.summarySelectedIndex >= 0 ? "已选摘要：摘要 " + (tasks.summarySelectedIndex + 1) : "已选摘要"
                                color: "#a2c7ca"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                            Text {
                                objectName: "summaryDetailFeedback"
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: tasks.summaryDetailState.feedback || "从目录选择一段摘要，读取其正文。"
                                color: tasks.summaryDetailState.status === "error" ? "#e6b4a4" : "#b7d5cf"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                                Accessible.role: Accessible.StaticText
                                Accessible.name: text
                            }
                            TextArea {
                                objectName: "summaryDetailText"
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                visible: tasks.summaryDetailState.status === "success"
                                textFormat: TextEdit.PlainText
                                readOnly: true
                                selectByMouse: true
                                text: tasks.summaryDetailState.status === "success" ? tasks.summaryDetailState.text || "" : ""
                                color: "#dce9ed"
                                font.pixelSize: 14
                                wrapMode: TextEdit.Wrap
                                padding: 8
                                Accessible.name: "AI 摘要正文，可选择并复制"
                                background: Rectangle {
                                    radius: 8
                                    color: "#18050e14"
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: "关闭正文仅移除本页选择、正文和请求关联，不会删除已保存的摘要。读取与刷新不生成新摘要，也不需要模型费用许可。"
                                color: "#94a9bb"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                        }
                    }
                    ColumnLayout {
                        visible: memoryTabs.currentIndex === 2
                        Layout.fillWidth: true
                        spacing: 8
                        Text {
                            textFormat: Text.PlainText
                            text: "关于你"
                            color: "#e3eff7"
                            font.pixelSize: 16
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "角色会参考这些资料。保存时留空的项保持原样；清空已有内容请使用「清空指定字段…」。列表用逗号或顿号分隔。"
                            color: "#94a9bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        // Labels sit above the fields, as in the archive drawer, so
                        // a filled field still says what it holds.
                        GridLayout {
                            id: profileFields
                            Layout.fillWidth: true
                            columns: tasks.width >= 520 ? 2 : 1
                            columnSpacing: 10
                            rowSpacing: 8
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Label {
                                    text: "名字"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileNameField
                                    objectName: "profileName"
                                    Layout.fillWidth: true
                                    placeholderText: ""
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Label {
                                    text: "称呼"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileNicknameField
                                    objectName: "profileNickname"
                                    Layout.fillWidth: true
                                    placeholderText: "希望被怎么称呼"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Label {
                                    text: "生日"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileBirthdayField
                                    objectName: "profileBirthday"
                                    Layout.fillWidth: true
                                    placeholderText: "如 2000-01-31"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Label {
                                    text: "作息"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileScheduleField
                                    objectName: "profileSchedule"
                                    Layout.fillWidth: true
                                    placeholderText: "如 23:30-7:30"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "身份或近况"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileIdentityField
                                    objectName: "profileIdentity"
                                    Layout.fillWidth: true
                                    placeholderText: ""
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "兴趣"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileInterestsField
                                    objectName: "profileInterests"
                                    Layout.fillWidth: true
                                    placeholderText: "用逗号或顿号分隔"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "爱好"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileHobbiesField
                                    objectName: "profileHobbies"
                                    Layout.fillWidth: true
                                    placeholderText: "用逗号或顿号分隔"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "喜欢聊的话题"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileTopicsField
                                    objectName: "profileTopics"
                                    Layout.fillWidth: true
                                    placeholderText: "用逗号或顿号分隔"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "喜欢的游戏"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileFavoriteGamesField
                                    objectName: "profileFavoriteGames"
                                    Layout.fillWidth: true
                                    placeholderText: "用逗号或顿号分隔"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                Layout.columnSpan: profileFields.columns
                                spacing: 4
                                Label {
                                    text: "喜欢的动漫"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileFavoriteAnimeField
                                    objectName: "profileFavoriteAnime"
                                    Layout.fillWidth: true
                                    placeholderText: "用逗号或顿号分隔"
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                            ColumnLayout {
                                Layout.fillWidth: true
                                spacing: 4
                                Label {
                                    text: "年龄"
                                    color: "#bdd0de"
                                    font.pixelSize: 11
                                }
                                GlassField {
                                    id: profileAgeField
                                    objectName: "profileAge"
                                    Layout.fillWidth: true
                                    placeholderText: "18 到 120 的整数"
                                    inputMethodHints: Qt.ImhDigitsOnly
                                    onTextEdited: tasks.profileEdited(objectName)
                                }
                            }
                        }
                    }
                    ColumnLayout {
                        visible: memoryTabs.currentIndex === 3
                        Layout.fillWidth: true
                        spacing: 10
                        Text {
                            textFormat: Text.PlainText
                            text: "本地备份"
                            color: "#e3eff7"
                            font.pixelSize: 16
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "备份包含当前人格的全部记忆、你的资料、情绪、关系和日记，是未加密的明文 JSON，离开了本机加密数据库；请存放在安全的位置，不要分享。"
                            color: "#d8c79f"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "backupIdentityBinding"
                            textFormat: Text.PlainText
                            text: "备份绑定当前人格和身份版本。人格身份变化后，旧备份会被拒绝恢复。"
                            color: "#d8c79f"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        RowLayout {
                            GlassButton {
                                objectName: "backupExport"
                                text: tasks.writesAllowed ? "导出备份" : "导出未确认状态，仅供留存"
                                enabled: session.connected && !session.backupRestoring && tasks.backupFeedback.status !== "pending"
                                onClicked: tasks.openBackupSave()
                            }
                            GlassButton {
                                objectName: "backupChoose"
                                text: "从备份恢复"
                                enabled: session.connected && tasks.writesAllowed && tasks.backupFeedback.status !== "pending"
                                onClicked: {
                                    tasks.backupRescueSelection = false;
                                    backupOpenDialog.open();
                                }
                            }
                        }
                        GlassButton {
                            objectName: "backupRescueChoose"
                            text: "选择已知完好的备份恢复解困"
                            visible: session.recoveryState === "recovery_required"
                            enabled: session.connected && !session.backupRestoring && tasks.backupFeedback.status !== "pending"
                            onClicked: {
                                tasks.backupRescueSelection = true;
                                backupOpenDialog.open();
                            }
                        }
                        Text {
                            objectName: "backupRestoreWarning"
                            Layout.fillWidth: true
                            // While writes are locked the page-wide runtimeRecoveryWarning
                            // already states the lock and the rescue path.
                            visible: tasks.writesAllowed
                            textFormat: Text.PlainText
                            text: "恢复前会检查备份，并要求明确确认；同一备份仅恢复一次，未确认结果不会自动重试。"
                            color: "#e6b4a4"
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Text {
                            objectName: "backupFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.backupFeedback.text || ""
                            color: tasks.feedbackColor(tasks.backupFeedback)
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        id: memoryRecallPage
                        objectName: "memoryRecallPage"
                        visible: memoryTabs.currentIndex === 4
                        Layout.fillWidth: true
                        spacing: 10
                        Text {
                            textFormat: Text.PlainText
                            text: "关联回忆"
                            color: "#e3eff7"
                            font.pixelSize: 16
                        }
                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "输入一句话或一段内容，查询当前人格的本地关联回忆。结果可能包含永久身份、资料和仍生效的观察，可能与输入相关；这里不是完整的已确认记忆列表，也不表示精确匹配。"
                            color: "#94a9bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        GlassField {
                            id: memoryRecallQuery
                            objectName: "memoryRecallQuery"
                            Layout.fillWidth: true
                            placeholderText: "输入 1–2000 个字符"
                            Accessible.name: "关联回忆查询内容"
                            // Do not cap UTF-16 units: an emoji is one character
                            // for the bridge's Unicode code-point validation.
                            Keys.onReturnPressed: event => {
                                if (memoryRecallQuery.inputMethodComposing) {
                                    event.accepted = false;
                                    return;
                                }
                                tasks.submitMemoryRecall();
                                event.accepted = true;
                            }
                            Keys.onEnterPressed: event => {
                                if (memoryRecallQuery.inputMethodComposing) {
                                    event.accepted = false;
                                    return;
                                }
                                tasks.submitMemoryRecall();
                                event.accepted = true;
                            }
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            GlassButton {
                                objectName: "memoryRecallSubmit"
                                text: tasks.memoryRecallState.status === "pending" ? "查询中…" : "查询关联回忆"
                                enabled: session.connected && !session.personaChanging && tasks.memoryRecallState.status !== "pending" && !memoryRecallQuery.inputMethodComposing && memoryRecallQuery.text.trim().length > 0
                                onClicked: tasks.submitMemoryRecall()
                            }
                            GlassButton {
                                objectName: "memoryRecallClear"
                                text: "清空输入与结果"
                                onClicked: session.clearMemoryRecall()
                            }
                        }
                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "清空仅移除本页输入、结果和请求关联，已发给本地服务的查询仍可能完成。输入与结果只保留在本次窗口中。"
                            color: "#94a9bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "memoryRecallSubmittedQuery"
                            Layout.fillWidth: true
                            visible: tasks.memoryRecallState.submittedQuery?.length > 0
                            textFormat: Text.PlainText
                            text: "本次查询：" + (tasks.memoryRecallState.submittedQuery || "")
                            color: "#c3d6df"
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "memoryRecallFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.memoryRecallState.text || ""
                            color: tasks.feedbackColor(tasks.memoryRecallState)
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Text {
                            objectName: "memoryRecallMode"
                            Layout.fillWidth: true
                            visible: ["success", "empty"].includes(tasks.memoryRecallState.status)
                            textFormat: Text.PlainText
                            text: tasks.memoryRecallModeLabel(tasks.memoryRecallState.mode)
                            color: "#a2c7ca"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "memoryRecallIndexPending"
                            Layout.fillWidth: true
                            visible: tasks.memoryRecallState.mode === "hybrid" && tasks.memoryRecallState.indexPending > 0
                            textFormat: Text.PlainText
                            text: "仍有 " + tasks.memoryRecallState.indexPending + " 条内容等待索引，当前索引尚不完整；检索方式不保证结果相关性。"
                            color: "#d8c79f"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        ColumnLayout {
                            objectName: "memoryRecallResults"
                            Layout.fillWidth: true
                            spacing: 8
                            Repeater {
                                model: tasks.memoryRecallState.results || []
                                TextArea {
                                    required property string modelData
                                    required property int index
                                    objectName: "memoryRecallText" + index
                                    Layout.fillWidth: true
                                    textFormat: TextEdit.PlainText
                                    readOnly: true
                                    selectByMouse: true
                                    text: modelData
                                    color: "#dce9ed"
                                    font.pixelSize: 14
                                    wrapMode: TextEdit.Wrap
                                    padding: 8
                                    background: Rectangle {
                                        radius: 8
                                        color: "#18050e14"
                                    }
                                }
                            }
                        }
                    }
                }
                ColumnLayout {
                    visible: tasks.page === "settings"
                    Layout.fillWidth: true
                    spacing: 14
                    // Glass segments like the memory page. The service page keeps its
                    // original controls and stays first; the section pages hold settings
                    // the native runtime delivers, each saved and read back on its own.
                    GridLayout {
                        id: settingsTabs
                        objectName: "settingsTabs"
                        property int currentIndex: 0
                        Layout.fillWidth: true
                        // Keep every label intact when the settings pane is narrow.
                        columns: width < 660 ? 4 : 8
                        columnSpacing: 6
                        rowSpacing: 6
                        Repeater {
                            model: [
                                {
                                    name: "service",
                                    label: "服务与隐私"
                                },
                                {
                                    name: "chat",
                                    label: "聊天"
                                },
                                {
                                    name: "memory",
                                    label: "记忆"
                                },
                                {
                                    name: "forgetting",
                                    label: "淡忘"
                                },
                                {
                                    name: "misremember",
                                    label: "记错"
                                },
                                {
                                    name: "traits",
                                    label: "性格"
                                },
                                {
                                    name: "emotion",
                                    label: "情绪"
                                },
                                {
                                    name: "budget",
                                    label: "用量"
                                }
                            ]
                            GlassButton {
                                required property var modelData
                                required property int index
                                objectName: "settingsTab-" + modelData.name
                                Layout.fillWidth: true
                                Layout.minimumWidth: implicitWidth
                                implicitHeight: 32
                                padding: 5
                                text: modelData.label
                                accented: settingsTabs.currentIndex === index
                                Accessible.role: Accessible.PageTab
                                Accessible.checked: accented
                                onClicked: {
                                    // Each page opens at its top; the service page is much longer.
                                    if (settingsTabs.currentIndex !== index)
                                        pageScroll.contentItem.contentY = 0;
                                    settingsTabs.currentIndex = index;
                                }
                            }
                        }
                    }
                    Text {
                        objectName: "settingsReadStatus"
                        Layout.fillWidth: true
                        visible: settingsTabs.currentIndex > 0 && !tasks.settingsKnown
                        textFormat: Text.PlainText
                        text: session.settingsFeedback?.read?.text || "当前设置尚未读取，暂不能修改。"
                        color: "#e6b4a4"
                        font.pixelSize: 12
                        wrapMode: Text.Wrap
                        Accessible.role: Accessible.StaticText
                        Accessible.name: text
                    }
                    ColumnLayout {
                        objectName: "settingsServicePage"
                        visible: settingsTabs.currentIndex === 0
                        Layout.fillWidth: true
                        spacing: 14
                        Text {
                            textFormat: Text.PlainText
                            text: "回复服务"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "选择本机服务或云端服务。只有测试通过后才应用配置。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        ComboBox {
                            objectName: "providerKind"
                            Layout.fillWidth: true
                            model: tasks.providerOptions
                            textRole: "label"
                            valueRole: "value"
                            currentIndex: Math.max(0, tasks.providerOptions.findIndex(option => option.value === tasks.providerKind))
                            onActivated: function (index) {
                                tasks.providerKind = tasks.providerOptions[index].value;
                                tasks.providerDirty = true;
                                tasks.providerEditRevision++;
                                session.providerDraftChanged();
                            }
                        }
                        Text {
                            objectName: "providerCloudNotice"
                            visible: tasks.providerKind !== "ollama"
                            textFormat: Text.PlainText
                            text: (tasks.providerTakesAddress ? "请填写服务的 HTTPS 地址。" : "地址由服务商固定。") + "聊天内容会发送到这个服务；更换服务或地址时，可选 AI 功能的授权会撤销，需要重新确认。"
                            color: "#c9b48f"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassField {
                            id: endpoint
                            objectName: "providerEndpoint"
                            visible: tasks.providerTakesAddress
                            Layout.fillWidth: true
                            placeholderText: tasks.providerKind === "custom" ? "https://example.com/v1" : "http://127.0.0.1:11434/v1"
                            onTextEdited: {
                                tasks.providerDirty = true;
                                tasks.providerEditRevision++;
                                session.providerDraftChanged();
                            }
                        }
                        GlassField {
                            id: modelName
                            objectName: "providerModel"
                            Layout.fillWidth: true
                            placeholderText: "模型名称"
                            onTextEdited: {
                                tasks.providerDirty = true;
                                tasks.providerEditRevision++;
                                session.providerDraftChanged();
                            }
                        }
                        GlassField {
                            id: apiKey
                            objectName: "providerApiKey"
                            Layout.fillWidth: true
                            echoMode: TextInput.Password
                            inputMethodHints: Qt.ImhSensitiveData | Qt.ImhNoPredictiveText | Qt.ImhNoAutoUppercase
                            placeholderText: tasks.providerKey.stored && tasks.providerKey.matches ? "已保存密钥；留空则继续使用" : (tasks.providerKind === "ollama" ? "API Key（可选）" : "API Key")
                            enabled: tasks.providerKey.available === true
                            onTextEdited: {
                                tasks.providerDirty = true;
                                tasks.providerEditRevision++;
                                session.providerDraftChanged();
                            }
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            Text {
                                objectName: "providerKeyStatus"
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: tasks.providerKeyStatusText()
                                color: tasks.providerKey.error ? "#e6b4a4" : "#9fb4c7"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                            GlassButton {
                                objectName: "clearProviderKey"
                                text: "删除密钥"
                                visible: tasks.providerKey.stored === true
                                enabled: session.connected && tasks.writesAllowed && session.providerFeedback?.pending !== true && tasks.providerKey.pending !== true
                                onClicked: session.clearProviderKey()
                            }
                            GlassButton {
                                objectName: "providerKeyRetryClear"
                                text: "再次停用"
                                visible: tasks.providerKey.clearState === "held" || tasks.providerKey.clearState === "unconfirmed"
                                enabled: session.connected && tasks.writesAllowed && session.providerFeedback?.pending !== true && tasks.providerKey.pending !== true
                                onClicked: session.retryProviderKeyClear()
                            }
                        }
                        RowLayout {
                            GlassButton {
                                objectName: "testProvider"
                                text: "测试连接"
                                enabled: session.connected && tasks.writesAllowed && session.providerFeedback?.pending !== true && tasks.providerKey.pending !== true
                                onClicked: session.testProviderConfig(tasks.providerKind, endpoint.text, modelName.text, apiKey.text)
                            }
                            GlassButton {
                                objectName: "saveProvider"
                                text: "保存并应用"
                                accented: true
                                enabled: session.connected && tasks.writesAllowed && session.state.providerTestReady === true && session.providerFeedback?.pending !== true && tasks.providerKey.pending !== true
                                onClicked: {
                                    tasks.providerSavingRevision = tasks.providerEditRevision;
                                    session.saveProvider();
                                }
                            }
                        }
                        Text {
                            objectName: "providerFeedbackText"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: session.providerFeedback?.text || ""
                            color: ["error", "unknown"].includes(session.providerFeedback?.status) ? "#e6b4a4" : "#b7d5cf"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Rectangle {
                            height: 1
                            Layout.fillWidth: true
                            color: "#1cb8d4d4"
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "空间与感官"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        GlassSwitch {
                            objectName: "reduceMotion"
                            text: "减少动态效果"
                            checked: session.reducedMotion
                            enabled: tasks.writesAllowed
                            onToggled: session.reducedMotion = checked
                        }
                        GlassSwitch {
                            objectName: "reduceTransparency"
                            text: "降低透明度"
                            checked: session.reducedTransparency
                            enabled: tasks.writesAllowed
                            onToggled: session.reducedTransparency = checked
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "降低效果后仍保留明确的层级、文本对比与全部操作入口。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            Text {
                                Layout.preferredWidth: 176
                                textFormat: Text.PlainText
                                text: "房间画质"
                                color: tasks.writesAllowed ? "#c8dce9" : "#75858a"
                                font.pixelSize: 13
                                wrapMode: Text.Wrap
                            }
                            Repeater {
                                model: [
                                    { value: "clear", label: "清晰" },
                                    { value: "balanced", label: "均衡" },
                                    { value: "smooth", label: "流畅" }
                                ]
                                GlassButton {
                                    required property var modelData
                                    objectName: "roomQuality-" + modelData.value
                                    Layout.fillWidth: true
                                    implicitHeight: 32
                                    padding: 5
                                    text: modelData.label
                                    accented: session.roomQuality === modelData.value
                                    enabled: tasks.writesAllowed
                                    Accessible.role: Accessible.RadioButton
                                    Accessible.checked: accented
                                    onClicked: session.roomQuality = modelData.value
                                }
                            }
                        }
                        Text {
                            objectName: "roomQualityDescription"
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "只影响房间背景。均衡在画面变化时降低分辨率，停下后恢复；清晰始终最清楚，开合抽屉时可能卡顿；流畅始终较低分辨率。非 Retina 屏幕上三档相同。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Rectangle {
                            height: 1
                            Layout.fillWidth: true
                            color: "#1cb8d4d4"
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "后台费用与隐私"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "功能开关与费用授权分别管理。未经明确确认，不因打开面板自动调用模型。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassButton {
                            text: "刷新授权状态"
                            enabled: session.connected && session.providerFeedback?.saving !== true && session.permissionFeedback?.refresh?.status !== "pending"
                            onClicked: session.refreshPermissions()
                        }
                        Text {
                            objectName: "permissionSnapshotStatus"
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: session.permissionsKnown === true ? "许可已按当前服务核对；网络暂停独立生效。" : "当前服务的许可状态尚未确认，请等待核对或刷新。"
                            color: session.permissionsKnown === true ? "#b7d5cf" : "#e6b4a4"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "permissionRefreshFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: session.permissionFeedback?.refresh?.text || ""
                            color: ["error", "unknown"].includes(session.permissionFeedback?.refresh?.status) ? "#e6b4a4" : "#b7d5cf"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        GlassSwitch {
                            text: "暂停网络模型调用"
                            checked: session.state.offline === true
                            enabled: session.connected && tasks.writesAllowed && session.networkFeedback?.status !== "pending"
                            onToggled: session.setOffline(checked)
                        }
                        Text {
                            objectName: "networkFeedbackText"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: session.networkFeedback?.text || ""
                            color: ["error", "unknown"].includes(session.networkFeedback?.status) ? "#e6b4a4" : "#b7d5cf"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Repeater {
                            model: Object.keys(session.state.permissions?.features || {})
                            ColumnLayout {
                                required property string modelData
                                Layout.fillWidth: true
                                property var permission: session.state.permissions.features[modelData]
                                property var feedback: session.permissionFeedback?.[modelData] || ({})
                                Text {
                                    textFormat: Text.PlainText
                                    text: permission.description || modelData
                                    color: "#c8dce9"
                                    font.pixelSize: 13
                                    wrapMode: Text.Wrap
                                    Layout.fillWidth: true
                                }
                                Text {
                                    objectName: "permissionStatus-" + modelData
                                    Layout.fillWidth: true
                                    textFormat: Text.PlainText
                                    text: tasks.permissionStatus(permission)
                                    color: "#b7d5cf"
                                    font.pixelSize: 13
                                    wrapMode: Text.Wrap
                                }
                                Text {
                                    Layout.fillWidth: true
                                    visible: text.length > 0
                                    textFormat: Text.PlainText
                                    text: tasks.permissionDetail(permission)
                                    color: "#b6c4ce"
                                    font.pixelSize: 12
                                    wrapMode: Text.Wrap
                                }
                                RowLayout {
                                    GlassButton {
                                        text: "授权当前服务"
                                        enabled: session.connected && tasks.writesAllowed && session.permissionsKnown === true && session.providerFeedback?.saving !== true && feedback.status !== "pending"
                                        onClicked: {
                                            tasks.consentFeature = modelData;
                                            tasks.consentDigest = permission.consent_digest;
                                            tasks.consentEpoch = session.permissionContextEpoch;
                                            consent.open();
                                        }
                                    }
                                    GlassButton {
                                        text: "撤销"
                                        enabled: session.connected && tasks.writesAllowed && feedback.status !== "pending"
                                        onClicked: session.request("ai_usage:revoke", {
                                            feature: modelData
                                        })
                                    }
                                }
                                Text {
                                    objectName: "permissionFeedback-" + modelData
                                    Layout.fillWidth: true
                                    visible: text.length > 0
                                    textFormat: Text.PlainText
                                    text: feedback.text || ""
                                    color: ["error", "unknown"].includes(feedback.status) ? "#e6b4a4" : "#b7d5cf"
                                    font.pixelSize: 12
                                    wrapMode: Text.Wrap
                                }
                            }
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "本地业务服务：" + (session.connected ? "已连接" : "未连接")
                            color: "#bdd3df"
                            font.pixelSize: 13
                        }
                        GlassButton {
                            text: "许可与关于"
                            onClicked: navigation.open("settings", "about")
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsChatPage"
                        visible: settingsTabs.currentIndex === 1
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "聊天"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格生效。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: splitMessagesSwitch
                            objectName: "settingsSplitMessages"
                            readonly property bool shownValue: tasks.settingValue("chat", "split_messages") === true
                            text: "长回复分成几条消息发送"
                            checked: shownValue
                            enabled: tasks.settingsEditable("chat")
                            onToggled: tasks.toggleSetting(splitMessagesSwitch, "chat", "split_messages", checked)
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "像聊天软件里连着发的几条消息；较短的回复仍是一条。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: environmentSwitch
                            objectName: "settingsEnvironmentDescription"
                            readonly property bool shownValue: tasks.settingValue("chat", "allow_environment_description") === true
                            text: "允许描写动作和周围环境"
                            checked: shownValue
                            enabled: tasks.settingsEditable("chat")
                            onToggled: tasks.toggleSetting(environmentSwitch, "chat", "allow_environment_description", checked)
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "关闭时回复像手机聊天，不描写房间、动作和光线；开启后只在确有需要时简短提到周围。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "settingsChatFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("chat").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("chat"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        ColumnLayout {
                            id: proactiveSettings
                            objectName: "settingsProactive"
                            Layout.fillWidth: true
                            Layout.minimumWidth: 0
                            spacing: 8
                            readonly property var features: tasks.settingsSnapshot.features || ({})
                            readonly property var permission: session.state.permissions?.features?.proactive_chat || ({})
                            readonly property var consentFeedback: session.permissionFeedback?.proactive_chat || ({})
                            readonly property bool available: session.state.settings?.proactive_available !== false
                            readonly property bool active: features.proactive_chat_enabled === true
                            readonly property bool permissionKnown: session.permissionsKnown === true
                                && typeof permission.enabled === "boolean" && typeof permission.effective === "boolean"
                            readonly property bool editable: tasks.settingsEditable("features")
                                && available && typeof features.proactive_chat_enabled === "boolean"
                            Text {
                                textFormat: Text.PlainText
                                text: "主动消息"
                                color: "#e4eef7"
                                font.pixelSize: 16
                            }
                            GlassSwitch {
                                id: proactiveSwitch
                                objectName: "settingsProactiveEnabled"
                                readonly property bool shownValue: proactiveSettings.active
                                text: "允许她主动发消息"
                                checked: shownValue
                                enabled: proactiveSettings.editable
                                onToggled: tasks.toggleSetting(proactiveSwitch, "features", "proactive_chat_enabled", checked)
                            }
                            Flow {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 8
                                Text {
                                    objectName: "settingsProactiveStatus"
                                    width: Math.min(implicitWidth, parent.width)
                                    textFormat: Text.PlainText
                                    wrapMode: Text.Wrap
                                    text: !proactiveSettings.available ? "主动消息暂不可用"
                                        : !proactiveSettings.active ? "未开启"
                                        : !proactiveSettings.permissionKnown || !proactiveSettings.permission.enabled ? "已开启，还需要授权费用"
                                        : proactiveSettings.permission.effective ? "已开启并已授权"
                                        : "已授权但暂不生效（换过服务，需要重新授权）"
                                    color: "#b7d5cf"
                                    font.pixelSize: 13
                                }
                                GlassButton {
                                    objectName: "settingsProactiveAuthorize"
                                    text: "授权"
                                    visible: proactiveSettings.available && proactiveSettings.active
                                        && (!proactiveSettings.permissionKnown || !proactiveSettings.permission.effective)
                                    enabled: proactiveSettings.editable && proactiveSettings.permissionKnown
                                        && session.providerFeedback?.saving !== true && proactiveSettings.consentFeedback.status !== "pending"
                                    onClicked: {
                                        tasks.consentFeature = "proactive_chat";
                                        tasks.consentDigest = proactiveSettings.permission.consent_digest;
                                        tasks.consentEpoch = session.permissionContextEpoch;
                                        consent.open();
                                    }
                                }
                            }
                            Text {
                                objectName: "settingsProactiveDailyLimit"
                                textFormat: Text.PlainText
                                text: "每天最多：" + (proactiveSettings.features.proactive_daily_limit ?? 2) + " 条"
                                color: "#c8dce9"
                                font.pixelSize: 13
                            }
                            Flow {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 8
                                Repeater {
                                    model: [1, 2, 3, 5]
                                    GlassButton {
                                        required property int modelData
                                        objectName: "settingsProactiveDailyLimit-" + modelData
                                        text: modelData + " 条"
                                        accented: proactiveSettings.features.proactive_daily_limit === modelData
                                        enabled: proactiveSettings.editable
                                        onClicked: if (!accented) session.saveSettings("features", {proactive_daily_limit: modelData})
                                    }
                                }
                            }
                            Text {
                                objectName: "settingsProactiveMinInterval"
                                textFormat: Text.PlainText
                                readonly property real minutes: proactiveSettings.features.proactive_min_interval_minutes ?? 120
                                text: "最短间隔：" + (minutes % 60 === 0 ? minutes / 60 + " 小时" : minutes + " 分钟")
                                color: "#c8dce9"
                                font.pixelSize: 13
                            }
                            Flow {
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                spacing: 8
                                Repeater {
                                    model: [60, 120, 240, 480]
                                    GlassButton {
                                        required property int modelData
                                        objectName: "settingsProactiveMinInterval-" + modelData
                                        text: modelData / 60 + " 小时"
                                        accented: proactiveSettings.features.proactive_min_interval_minutes === modelData
                                        enabled: proactiveSettings.editable
                                        onClicked: if (!accented) session.saveSettings("features", {proactive_min_interval_minutes: modelData})
                                    }
                                }
                            }
                            Text {
                                Layout.fillWidth: true
                                textFormat: Text.PlainText
                                text: "只有应用开着时她才会发。每条消息调用一次模型，计入后台用量。刚认识时她更克制，实际条数可能比这里设的少。"
                                color: "#819ab0"
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                            Text {
                                objectName: "settingsProactiveFeedback"
                                Layout.fillWidth: true
                                visible: text.length > 0
                                textFormat: Text.PlainText
                                text: tasks.settingsReceipt("features").text || ""
                                color: tasks.feedbackColor(tasks.settingsReceipt("features"))
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                            Text {
                                Layout.fillWidth: true
                                visible: text.length > 0
                                textFormat: Text.PlainText
                                text: proactiveSettings.consentFeedback.text || ""
                                color: tasks.feedbackColor(proactiveSettings.consentFeedback)
                                font.pixelSize: 12
                                wrapMode: Text.Wrap
                            }
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsMemoryPage"
                        visible: settingsTabs.currentIndex === 2
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "记忆"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格的记忆生效。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "记忆保留期"
                            color: "#c8dce9"
                            font.pixelSize: 14
                        }
                        RowLayout {
                            Layout.fillWidth: true
                            spacing: 6
                            GlassButton {
                                id: retentionShort
                                objectName: "settingsRetention-365"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                padding: 5
                                text: "1 年"
                                accented: tasks.retentionShown === 365
                                enabled: tasks.settingsEditable("memory")
                                Accessible.role: Accessible.RadioButton
                                Accessible.checked: accented
                                onClicked: tasks.chooseRetention(365)
                            }
                            GlassButton {
                                objectName: "settingsRetention-730"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                padding: 5
                                text: "2 年"
                                accented: tasks.retentionShown === 730
                                enabled: tasks.settingsEditable("memory")
                                Accessible.role: Accessible.RadioButton
                                Accessible.checked: accented
                                onClicked: tasks.chooseRetention(730)
                            }
                            GlassButton {
                                objectName: "settingsRetention-1095"
                                Layout.fillWidth: true
                                implicitHeight: 32
                                padding: 5
                                text: "3 年"
                                accented: tasks.retentionShown === 1095
                                enabled: tasks.settingsEditable("memory")
                                Accessible.role: Accessible.RadioButton
                                Accessible.checked: accented
                                onClicked: tasks.chooseRetention(1095)
                            }
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "早于保留期、没有固定的记忆会在每日整理中过期，不再用于对话。缩短前会先确认。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "settingsMemoryFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("memory").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("memory"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsForgettingPage"
                        visible: settingsTabs.currentIndex === 3
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "淡忘"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格的记忆生效。淡忘不会删除任何记忆，原文仍在记忆页。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: forgettingSwitch
                            objectName: "settingsForgetting"
                            readonly property bool shownValue: tasks.settingValue("memory", "forgetting_enabled") === true
                            text: "随时间淡忘旧记忆"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory")
                            onToggled: tasks.toggleSetting(forgettingSwitch, "memory", "forgetting_enabled", checked)
                        }
                        GlassSwitch {
                            id: longForgettingSwitch
                            objectName: "settingsLongTermForgetting"
                            readonly property bool shownValue: tasks.settingValue("memory", "long_term_forgetting_enabled") === true
                            text: "长期记忆也会慢慢淡忘"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory") && forgettingSwitch.shownValue
                            onToggled: tasks.toggleSetting(longForgettingSwitch, "memory", "long_term_forgetting_enabled", checked)
                        }
                        // Days also decide whether a memory can be misremembered, so
                        // they stay adjustable while forgetting itself is off.
                        MemoryPresetRow {
                            objectPrefix: "settingsLongForgetDays"
                            savedValue: tasks.settingValue("memory", "long_term_forget_days")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("long_term_forget_days", value)
                            label: "多久没想起开始淡忘"
                            values: [60, 90, 180, 365]
                            rowEnabled: tasks.settingsEditable("memory")
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsLongForgetChance"
                            savedValue: tasks.settingValue("memory", "long_term_forget_probability")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("long_term_forget_probability", value)
                            label: "聊天时一时想不起来的概率"
                            values: tasks.chancePresets
                            percent: true
                            rowEnabled: tasks.settingsEditable("memory") && forgettingSwitch.shownValue && longForgettingSwitch.shownValue
                        }
                        GlassSwitch {
                            id: shortForgettingSwitch
                            objectName: "settingsShortTermForgetting"
                            readonly property bool shownValue: tasks.settingValue("memory", "short_term_forgetting_enabled") === true
                            text: "短期记忆会较快淡忘"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory") && forgettingSwitch.shownValue
                            onToggled: tasks.toggleSetting(shortForgettingSwitch, "memory", "short_term_forgetting_enabled", checked)
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsShortForgetDays"
                            savedValue: tasks.settingValue("memory", "short_term_forget_days")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("short_term_forget_days", value)
                            label: "多久没想起开始淡忘"
                            values: [3, 7, 14, 30]
                            rowEnabled: tasks.settingsEditable("memory")
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsShortForgetChance"
                            savedValue: tasks.settingValue("memory", "short_term_forget_probability")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("short_term_forget_probability", value)
                            label: "聊天时一时想不起来的概率"
                            values: tasks.chancePresets
                            percent: true
                            rowEnabled: tasks.settingsEditable("memory") && forgettingSwitch.shownValue && shortForgettingSwitch.shownValue
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "很久没被想起的记忆会渐渐淡化，相关度不高时就不再被想起。超过所选天数没被想起的记忆，聊天时还会按所选概率一时想不起来：每轮最多一条，之后仍可能想起。永久、固定、很重要的记忆，以及生日、约定等受保护的事实不受影响。天数也决定能否记错，见「记错」页。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "settingsForgettingFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("memory").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("memory"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsMisrememberPage"
                        visible: settingsTabs.currentIndex === 4
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "记错"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格生效，默认关闭。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: misrememberSwitch
                            objectName: "settingsMisremembering"
                            readonly property bool shownValue: tasks.settingValue("memory", "misremembering_enabled") === true
                            text: "偶尔把很久以前的事记错"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory")
                            onToggled: tasks.toggleMisremembering(misrememberSwitch, checked)
                        }
                        GlassSwitch {
                            id: longMisrememberSwitch
                            objectName: "settingsLongTermMisremembering"
                            readonly property bool shownValue: tasks.settingValue("memory", "long_term_misremembering_enabled") === true
                            text: "长期记忆可能记错"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory") && misrememberSwitch.shownValue
                            onToggled: tasks.toggleSetting(longMisrememberSwitch, "memory", "long_term_misremembering_enabled", checked)
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsLongMisrememberChance"
                            savedValue: tasks.settingValue("memory", "long_term_misremember_probability")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("long_term_misremember_probability", value)
                            label: "记错的概率"
                            values: tasks.chancePresets
                            percent: true
                            rowEnabled: tasks.settingsEditable("memory") && misrememberSwitch.shownValue && longMisrememberSwitch.shownValue
                        }
                        GlassSwitch {
                            id: shortMisrememberSwitch
                            objectName: "settingsShortTermMisremembering"
                            readonly property bool shownValue: tasks.settingValue("memory", "short_term_misremembering_enabled") === true
                            text: "短期记忆可能记错"
                            checked: shownValue
                            enabled: tasks.settingsEditable("memory") && misrememberSwitch.shownValue
                            onToggled: tasks.toggleSetting(shortMisrememberSwitch, "memory", "short_term_misremembering_enabled", checked)
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsShortMisrememberChance"
                            savedValue: tasks.settingValue("memory", "short_term_misremember_probability")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseMemoryPreset("short_term_misremember_probability", value)
                            label: "记错的概率"
                            values: tasks.chancePresets
                            percent: true
                            rowEnabled: tasks.settingsEditable("memory") && misrememberSwitch.shownValue && shortMisrememberSwitch.shownValue
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "开启后，聊天中想起较旧的记忆时，她偶尔会把其中的名称和另一条同类记忆弄混，例如两款游戏的名字，每轮最多一处；记忆本身不会被改动。你指出她记错了，正确的记忆会被加强。长期记忆满 90 天、短期记忆满 5 天才可能记错；「淡忘」页的天数少于 90 天或 5 天时，对应的记忆不会记错。实际几率约为所选值的一半到六成。永久、固定、很重要的记忆和受保护的事实不会记错。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "settingsMisrememberFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("memory").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("memory"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsTraitsPage"
                        visible: settingsTabs.currentIndex === 5
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "性格"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格生效，包括导入的角色卡人格。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: flawsSwitch
                            objectName: "settingsFlawsEnabled"
                            readonly property bool shownValue: tasks.settingValue("personality", "personality_flaws_enabled") === true
                            text: "带一点无伤大雅的小缺点"
                            checked: shownValue
                            enabled: tasks.settingsEditable("personality")
                            onToggled: tasks.toggleFlaws(flawsSwitch, checked)
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "她会把这些当作自己的小毛病在聊天里自然流露，不会当作指令执行。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassField {
                            id: flawsField
                            objectName: "settingsFlawsText"
                            Layout.fillWidth: true
                            maximumLength: 400
                            placeholderText: "例如：路痴、偶尔拖延、怕黑"
                            onTextEdited: {
                                tasks.flawsDirty = true;
                                tasks.flawsEditRevision++;
                            }
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "因用户所设置的‘缺点’而引发的一系列问题由用户自行承担，与本项目及本项目的所有者将不承担任何责任。保存或开启小缺点前需要先勾选知悉。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        CheckBox {
                            id: flawsAcknowledged
                            objectName: "settingsFlawsAcknowledged"
                            text: "我已知悉上述说明"
                            contentItem: Text {
                                leftPadding: flawsAcknowledged.indicator.width + flawsAcknowledged.spacing
                                text: flawsAcknowledged.text
                                textFormat: Text.PlainText
                                font.pixelSize: 13
                                color: flawsAcknowledged.enabled ? "#dce9f2" : "#75858a"
                                verticalAlignment: Text.AlignVCenter
                            }
                        }
                        RowLayout {
                            spacing: 10
                            GlassButton {
                                objectName: "settingsFlawsSave"
                                text: "保存并开启小缺点"
                                accented: true
                                enabled: tasks.settingsEditable("personality") && tasks.flawsDirty && flawsField.text.trim().length > 0 && flawsAcknowledged.checked
                                onClicked: tasks.saveFlaws()
                            }
                            Text {
                                objectName: "settingsFlawsDirtyHint"
                                visible: tasks.flawsDirty
                                textFormat: Text.PlainText
                                text: "有未保存的修改"
                                color: "#e6c9a4"
                                font.pixelSize: 12
                            }
                        }
                        Text {
                            objectName: "settingsTraitsFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.traitsFeedback.text || ""
                            color: tasks.feedbackColor(tasks.traitsFeedback)
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsEmotionPage"
                        visible: settingsTabs.currentIndex === 6
                        Layout.fillWidth: true
                        spacing: 12
                        Text {
                            textFormat: Text.PlainText
                            text: "情绪"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "这些设置对所有人格生效；每个人格的情绪各自保留。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: emotionSwitch
                            objectName: "settingsEmotionEnabled"
                            readonly property bool shownValue: tasks.settingValue("personality", "emotion_system_enabled") === true
                            text: "情绪随聊天和日子变化"
                            checked: shownValue
                            enabled: tasks.settingsEditable("personality")
                            onToggled: tasks.toggleSetting(emotionSwitch, "personality", "emotion_system_enabled", checked)
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsEmotionCarryoverDays"
                            savedValue: tasks.settingValue("personality", "emotion_carryover_days")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseEmotionPreset("emotion_carryover_days", value)
                            label: "跨日平复天数"
                            values: tasks.emotionDayPresets
                            rowEnabled: tasks.settingsEditable("personality") && emotionSwitch.shownValue
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsEmotionInertia"
                            savedValue: tasks.settingValue("personality", "emotion_inertia_factor")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseEmotionPreset("emotion_inertia_factor", value)
                            label: "每轮平复比例"
                            values: tasks.emotionRatioPresets
                            percent: true
                            rowEnabled: tasks.settingsEditable("personality") && emotionSwitch.shownValue
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "关闭后，她保留现在的情绪，不再随聊天和日期变化，已有的情绪仍会影响她说话的语气；重新开启后从保留的情绪继续，不补算关闭期间。跨日平复天数决定隔天以后情绪回到平常的快慢：天数越多回落越慢，大约这么多天平复大半，并不是到期清零。每轮平复比例决定每次聊天后情绪向平常心情回落多少：比例越大，越快回到平常。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        Text {
                            objectName: "settingsEmotionFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("personality").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("personality"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                    }
                    ColumnLayout {
                        objectName: "settingsBudgetPage"
                        // Page entry triggers a read; the bridge refreshes after saves.
                        readonly property bool readReady: tasks.page === "settings" && visible && session.connected && !session.personaChanging
                        visible: settingsTabs.currentIndex === 7
                        Layout.fillWidth: true
                        spacing: 12
                        onReadReadyChanged: {
                            if (readReady)
                                session.refreshBudget();
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "用量"
                            color: "#e4eef7"
                            font.pixelSize: 18
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "上限对所有人格共用，保存后从下一次请求生效。"
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Layout.fillWidth: true
                        }
                        GlassSwitch {
                            id: budgetSwitch
                            objectName: "settingsBudgetEnforced"
                            readonly property bool shownValue: tasks.settingValue("personality", "api_background_budget_enforced") === true
                            text: "后台用量上限"
                            checked: shownValue
                            enabled: tasks.settingsEditable("personality")
                            onToggled: tasks.toggleSetting(budgetSwitch, "personality", "api_background_budget_enforced", checked)
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsBudgetRequests"
                            savedValue: tasks.settingValue("personality", "api_background_daily_request_budget")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseBudgetPreset("api_background_daily_request_budget", value)
                            label: "每日后台请求"
                            values: tasks.budgetRequestPresets
                            unit: " 次"
                            rowEnabled: tasks.settingsEditable("personality") && budgetSwitch.shownValue
                        }
                        MemoryPresetRow {
                            objectPrefix: "settingsBudgetTokens"
                            savedValue: tasks.settingValue("personality", "api_background_daily_token_budget")
                            settingsKnown: tasks.settingsKnown
                            onChosen: value => tasks.chooseBudgetPreset("api_background_daily_token_budget", value)
                            label: "每日后台 Token"
                            values: tasks.budgetTokenPresets
                            unit: " Token"
                            valueLabels: ({
                                    10000: "1 万",
                                    30000: "3 万",
                                    100000: "10 万",
                                    300000: "30 万"
                                })
                            rowEnabled: tasks.settingsEditable("personality") && budgetSwitch.shownValue
                        }
                        Text {
                            objectName: "settingsBudgetTrackingStatus"
                            visible: tasks.budgetTrackingDisabled
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "用量记账已关闭，上限目前不生效"
                            color: "#e6c9a4"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Text {
                            objectName: "settingsBudgetFeedback"
                            Layout.fillWidth: true
                            visible: text.length > 0
                            textFormat: Text.PlainText
                            text: tasks.settingsReceipt("personality").text || ""
                            color: tasks.feedbackColor(tasks.settingsReceipt("personality"))
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: "今日后台用量"
                            color: "#c8dce9"
                            font.pixelSize: 14
                        }
                        Text {
                            objectName: "settingsBudgetUsageStatus"
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: tasks.budgetUsageStatusText()
                            color: tasks.budgetUsageCurrent ? "#b7d5cf" : "#e6c9a4"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                            Accessible.role: Accessible.StaticText
                            Accessible.name: text
                        }
                        Text {
                            objectName: "settingsBudgetUsageDate"
                            visible: tasks.budgetUsageCurrent
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: tasks.budgetUsageCurrent ? "统计日期：" + tasks.budgetUsageSnapshot.local_day + "（本机日期）" : ""
                            color: "#8fa7bb"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "settingsBudgetUsageRequests"
                            visible: tasks.budgetUsageCurrent
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: tasks.budgetUsageCurrent && tasks.budgetUsageSnapshot.background ? "今日后台请求 " + tasks.budgetUsageSnapshot.background.requests + "／" + tasks.budgetUsageSnapshot.background.request_budget + " 次" : ""
                            color: "#c8dce9"
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                        }
                        Text {
                            objectName: "settingsBudgetUsageTokens"
                            visible: tasks.budgetUsageCurrent
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: tasks.budgetUsageCurrent && tasks.budgetUsageSnapshot.background ? "今日后台 Token 约 " + tasks.budgetUsageSnapshot.background.tokens + "／" + tasks.budgetUsageSnapshot.background.token_budget : ""
                            color: "#c8dce9"
                            font.pixelSize: 13
                            wrapMode: Text.Wrap
                        }
                        GlassButton {
                            objectName: "settingsBudgetRefresh"
                            text: "刷新用量"
                            enabled: session.connected && !session.personaChanging && tasks.budgetUsageState.status !== "pending"
                            onClicked: session.refreshBudget()
                        }
                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "只限制经过用量账本、标记为后台的模型请求，前台聊天不受影响。请求数或 Token 任一余量不足，都会拒绝新的后台请求。按本机日期在零点开始新一天的统计，换日不会清空旧账。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "Token 含估算，可能高于或低于实际；账本读写出错时，请求照常发出。这里只限制请求数和 Token，不代表费用硬上限。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                        Text {
                            Layout.fillWidth: true
                            textFormat: Text.PlainText
                            text: "对话摘要被拒后，冷却结束或增加上限都不会自动补做原来源；只有后续合格的新来源才可能触发尝试。"
                            color: "#819ab0"
                            font.pixelSize: 12
                            wrapMode: Text.Wrap
                        }
                    }
                }
                Loader {
                    id: xiangqiPage
                    visible: active
                    active: tasks.page === "activities" && !tasks.diaryActive && !tasks.gomokuActive && !tasks.chessActive && !tasks.goActive
                    Layout.fillWidth: true
                    sourceComponent: XiangqiPanel {}
                }
                Loader {
                    id: gomokuPage
                    visible: active
                    active: tasks.gomokuActive
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    sourceComponent: GomokuPanel {}
                }
                Loader {
                    id: chessPage
                    visible: active
                    active: tasks.chessActive
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    sourceComponent: ChessPanel {}
                }
                Loader {
                    id: goPage
                    visible: active
                    active: tasks.goActive
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    sourceComponent: GoPanel {}
                }
                Loader {
                    id: diaryPage
                    visible: active
                    active: tasks.diaryActive
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    sourceComponent: DiaryPanel {
                        onAuthorizationRequested: {
                            const permission = session.state.permissions?.features?.diary_generation;
                            tasks.consentFeature = "diary_generation";
                            tasks.consentDigest = permission?.consent_digest || "";
                            tasks.consentEpoch = session.permissionContextEpoch;
                            consent.open();
                        }
                    }
                }
                ColumnLayout {
                    visible: tasks.page === "about"
                    Layout.fillWidth: true
                    spacing: 14
                    Text {
                        textFormat: Text.PlainText
                        text: "REVERIE\nSCENE / 01"
                        color: "#d7eeed"
                        font.pixelSize: 32
                        font.letterSpacing: 4
                    }
                    Text {
                        objectName: "aboutPreviewDescription"
                        textFormat: Text.PlainText
                        text: "科技与柔软，共处一个空间。\n\nQt Quick / QML 原生界面，C++ 持久控制器，现有 Python 业务内核。角色通过 Native Core 进入同一场景纹理。\n\n这是内部预览版。项目代码按 Apache-2.0 许可；Qt 与 Cubism 的许可边界独立保留。"
                        color: "#98aec2"
                        font.pixelSize: 14
                        wrapMode: Text.Wrap
                        Layout.fillWidth: true
                    }
                }
                ColumnLayout {
                    visible: tasks.page === "palette"
                    Layout.fillWidth: true
                    spacing: 10
                    Repeater {
                        model: [
                            {
                                id: "chat",
                                label: "陪伴与聊天"
                            },
                            {
                                id: "character",
                                label: "角色与形象"
                            },
                            {
                                id: "memory",
                                label: "记忆与资料"
                            },
                            {
                                id: "activities",
                                label: "中国象棋"
                            },
                            {
                                id: "settings",
                                label: "空间控制台"
                            }
                        ]
                        GlassButton {
                            required property var modelData
                            Layout.fillWidth: true
                            text: modelData.label
                            onClicked: navigation.open(modelData.id)
                        }
                    }
                }
            }
        }
        Flow {
            objectName: "memorySelectionBar"
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && tasks.memorySelectionMode
            Layout.fillWidth: true
            spacing: 8
            Text {
                objectName: "memorySelectionCount"
                height: memorySelectionCancel.implicitHeight
                verticalAlignment: Text.AlignVCenter
                text: "已选" + tasks.memorySelectedIds.length + "条"
                textFormat: Text.PlainText
                color: "#dce9f2"
                Accessible.name: text
            }
            GlassButton {
                objectName: "memoryPinSelected"
                text: "固定所选…"
                enabled: tasks.memorySelectionCanDelete
                onClicked: tasks.previewMemoryPinSelection(true)
            }
            GlassButton {
                objectName: "memoryUnpinSelected"
                text: "取消固定所选…"
                enabled: tasks.memorySelectionCanDelete
                onClicked: tasks.previewMemoryPinSelection(false)
            }
            GlassButton {
                objectName: "memoryDeleteSelected"
                text: "删除所选…"
                enabled: tasks.memorySelectionCanDelete
                onClicked: tasks.confirmMemorySelection()
            }
            GlassButton {
                id: memorySelectionCancel
                objectName: "memorySelectionCancel"
                text: "取消选择"
                enabled: tasks.memoryBatchDelete.busy !== true && !tasks.memoryBatchPinBlocked && tasks.memoryBatchPin.busy !== true
                onClicked: tasks.clearMemorySelection(true)
            }
        }
        Flow {
            objectName: "memoryCandidateSelectionBar"
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 0 && tasks.candidateSelectionMode
            Layout.fillWidth: true
            spacing: 8
            Text {
                objectName: "memoryCandidateSelectionCount"
                height: candidateSelectionCancel.implicitHeight
                verticalAlignment: Text.AlignVCenter
                text: "已选候选" + tasks.candidateSelectedIds.length + "条"
                textFormat: Text.PlainText
                color: "#dce9f2"
                Accessible.name: text
            }
            GlassButton {
                objectName: "memoryCandidateConfirmSelected"
                text: "记住所选…"
                enabled: tasks.candidateSelectionCanDecide
                onClicked: tasks.previewCandidateSelection(true)
            }
            GlassButton {
                objectName: "memoryCandidateRejectSelected"
                text: "不记所选…"
                enabled: tasks.candidateSelectionCanDecide
                onClicked: tasks.previewCandidateSelection(false)
            }
            GlassButton {
                id: candidateSelectionCancel
                objectName: "memoryCandidateSelectionCancel"
                text: "取消选择"
                enabled: !tasks.candidateBatchBlocked && tasks.memoryCandidateBatch.busy !== true
                onClicked: tasks.clearCandidateSelection(true)
            }
        }
        // Saving, clearing and refreshing, their hints and the latest receipts
        // stay outside the page scroll, so they never depend on how far the
        // form has been scrolled or how many fields it holds.
        ColumnLayout {
            objectName: "profileActionBar"
            visible: tasks.page === "memory" && memoryTabs.currentIndex === 2
            Layout.fillWidth: true
            spacing: 8
            Flow {
                Layout.fillWidth: true
                spacing: 8
                GlassButton {
                    objectName: "profileSave"
                    text: "保存资料"
                    accented: true
                    enabled: session.connected && tasks.writesAllowed && tasks.profileDirty && tasks.profileFeedback.status !== "pending" && !tasks.profileClearBlocked
                    onClicked: {
                        const fields = {};
                        const keys = {
                            profileName: "name",
                            profileNickname: "nickname",
                            profileBirthday: "birthday",
                            profileIdentity: "identity",
                            profileSchedule: "schedule",
                            profileInterests: "interests",
                            profileHobbies: "hobbies",
                            profileTopics: "favorite_topics",
                            profileFavoriteGames: "favorite_games",
                            profileFavoriteAnime: "favorite_anime",
                            profileAge: "age"
                        };
                        for (const field of tasks.profileInputs)
                            if (keys[field.objectName])
                                fields[keys[field.objectName]] = field.text;
                        session.saveProfile(fields);
                    }
                }
                GlassButton {
                    objectName: "profileClear"
                    text: "清空指定字段…"
                    enabled: session.connected && tasks.writesAllowed && !tasks.profileDirty && tasks.profileFeedback.status !== "pending" && !tasks.profileClearBlocked && !session.personaChanging
                    onClicked: session.proposeProfileClear(tasks.profileDirty)
                }
                GlassButton {
                    objectName: "profileClearRefresh"
                    text: "刷新当前资料"
                    enabled: session.connected && tasks.profileClearState.status !== "pending" && !tasks.profileClearState.manualRefreshing && tasks.profileFeedback.status !== "pending"
                    onClicked: session.refreshProfile()
                }
            }
            Text {
                objectName: "profileDirtyHint"
                Layout.fillWidth: true
                visible: tasks.profileDirty
                textFormat: Text.PlainText
                text: "有未保存的修改"
                color: "#a5b8c8"
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
            Text {
                objectName: "profileClearDirtyHint"
                Layout.fillWidth: true
                visible: tasks.profileDirty
                textFormat: Text.PlainText
                text: "请先保存资料编辑，再清空指定字段。"
                color: "#a5b8c8"
                font.pixelSize: 12
                wrapMode: Text.Wrap
            }
            Text {
                objectName: "profileFeedback"
                Layout.fillWidth: true
                visible: text.length > 0
                textFormat: Text.PlainText
                text: tasks.profileFeedback.text || ""
                color: tasks.feedbackColor(tasks.profileFeedback)
                font.pixelSize: 12
                wrapMode: Text.Wrap
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
            Text {
                objectName: "profileClearFeedback"
                Layout.fillWidth: true
                visible: text.length > 0 && tasks.profileClearState.status !== "confirmation"
                textFormat: Text.PlainText
                text: tasks.profileClearState.text || ""
                color: tasks.feedbackColor(tasks.profileClearState)
                font.pixelSize: 12
                wrapMode: Text.Wrap
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
        }
    }
}
