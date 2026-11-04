import QtQuick

// Static stand-in for the ArchiveEditor properties ArchiveDrawer reads. It
// never saves or reloads anything.
QtObject {
    property string status: "saved"
    property string statusText: ""
    property int revision: 1
    property string title: "星空手记"
    property string keywords: "星空"
    property bool useRegex: false
    property string secondaryKeywords: ""
    property string selectiveLogic: "and_any"
    property bool caseSensitive: false
    readonly property bool advancedRuleEditable: true
    property var keywordItems: ["星空"]
    property var secondaryKeywordItems: []
    property bool keywordsEditable: true
    property bool secondaryKeywordsEditable: true
    property string keywordsReadonlyReason: ""
    property string secondaryKeywordsReadonlyReason: ""
    property bool ruleConflict: false
    property string ruleConflictText: ""
    property var regexDiagnostics: ({status: "unrun", text: "本版本尚无运行诊断", messages: [], requestId: "", revision: 2, truncated: 0, available: true, dirtyNote: ""})
    function adoptSavedRules() { ruleConflict = false }
    property string content: "我们的观星暗号是青绿色的流星。"
    property string comment: "观星暗号"
    property bool entryEnabled: true
    property bool alwaysActive: false
    property int insertionOrder: 100
    readonly property string insertionOrderText: String(insertionOrder)
    property int priority: 0
    readonly property string priorityText: String(priority)
    readonly property bool priorityConfirmed: true
    readonly property bool priorityEditable: true
    property int scanDepth: 20
    property int bookTokenBudget: 500
    property bool recursiveScanning: true
    readonly property var bookSettingStates: ({scanDepth: {confirmed: true, editable: true, text: String(scanDepth)}, tokenBudget: {confirmed: true, editable: true, text: String(bookTokenBudget)}, recursiveScanning: {confirmed: true, editable: true, text: recursiveScanning ? "开启" : "关闭"}})
    property var entryScanDepth: null
    property var entryTokenBudget: null
    readonly property var entrySettingStates: ({scanDepth: {confirmed: true, editable: true, inherited: entryScanDepth === null, present: entryScanDepth !== null, canOverride: true, bookText: String(scanDepth), text: entryScanDepth === null ? "跟随本书" : String(entryScanDepth)}, tokenBudget: {confirmed: true, editable: true, inherited: entryTokenBudget === null, present: entryTokenBudget !== null, canOverride: true, bookText: String(bookTokenBudget), text: entryTokenBudget === null ? "跟随本书" : String(entryTokenBudget)}})
    property string insertionPosition: "before_char"
    property int insertionDepth: 0
    property string insertionRole: "system"
    readonly property var insertionStates: ({position: {confirmed: true, editable: true, present: true, text: "系统提示 · 身份段之后", readonlyReason: ""}, depth: {confirmed: true, editable: insertionPosition === "at_depth", present: false, text: String(insertionDepth), readonlyReason: ""}, role: {confirmed: true, editable: insertionPosition === "at_depth", present: false, text: insertionRole === "system" ? "系统" : insertionRole === "user" ? "用户" : "助手", readonlyReason: ""}})
    readonly property string insertionEffectiveText: insertionPosition === "at_depth" ? "对话中按深度插入 · 深度 " + insertionDepth + " · " + insertionStates.role.text : "系统提示 · 身份段之后（深度、角色此时不生效）"
    property string insertionDependencyNotice: ""
    property bool dirty: false
    readonly property bool initialized: true
    readonly property bool hasBook: true
    readonly property bool hasEntry: true
    readonly property bool newLocal: false
    readonly property bool busy: false
    readonly property bool deletionActive: false
    readonly property bool canNavigate: false
    readonly property bool canCreateBook: false
    readonly property bool canCreateEntry: false
    readonly property bool canDeleteBook: false
    readonly property bool canDeleteEntry: false
    readonly property bool writesBlocked: false
    readonly property string archiveScope: typeof session !== "undefined" ? session.scopeKey || "" : ""
    readonly property bool focusContextChanging: false
    readonly property int focusContextRevision: 0
    signal focusContextChanged()
    readonly property string selectedBookKey: "preview-book"
    readonly property string selectedEntryKey: "preview-entry"
    readonly property var bookRows: [{key: "preview-book", id: "preview-book", name: "星空手记", entryCount: 1, newLocal: false}]
    readonly property var entryRows: [{key: "preview-entry", id: "preview-entry", comment: "观星暗号", enabled: true, alwaysActive: false, insertionOrder: 100, newLocal: false}]
    readonly property var advancedFields: ({book: {scanDepth: 20, tokenBudget: 500, recursiveScanning: true}, entry: {}})
    readonly property int savedBytes: 480
    readonly property int draftBytes: 480
    readonly property string sizeWarning: ""
    readonly property var navigationPrompt: ({})
    readonly property var deletePrompt: ({})
    readonly property var deleteFeedback: ({})
    readonly property bool canSave: false
    readonly property string saveBlocker: ""
    signal changed
    function save() {
    }
    function reloadDiscardingDraft() {
    }
    function selectBook(key) {}
    function selectEntry(key) {}
    function newBook() {}
    function newEntry() {}
    function setEntrySettingInherited(key, inherited) {}
    function resolveNavigation(choice) {}
    function discardNew() {}
    function requestDelete(kind) {}
    function confirmDelete() {}
    function cancelDelete() {}
}
