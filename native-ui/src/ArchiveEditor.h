#pragma once
#include <QHash>
#include <QObject>
#include <QTimer>
#include <QVariantMap>
#include <functional>

// One persistent edit transaction, independent of its scene presentation.
class ArchiveEditor final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QString title READ title WRITE setTitle NOTIFY changed)
    Q_PROPERTY(QString comment READ comment WRITE setComment NOTIFY changed)
    Q_PROPERTY(QString keywords READ keywords WRITE setKeywords NOTIFY changed)
    Q_PROPERTY(QString secondaryKeywords READ secondaryKeywords WRITE setSecondaryKeywords NOTIFY changed)
    Q_PROPERTY(QString selectiveLogic READ selectiveLogic WRITE setSelectiveLogic NOTIFY changed)
    Q_PROPERTY(bool caseSensitive READ caseSensitive WRITE setCaseSensitive NOTIFY changed)
    Q_PROPERTY(bool advancedRuleEditable READ advancedRuleEditable NOTIFY changed)
    Q_PROPERTY(bool useRegex READ useRegex WRITE setUseRegex NOTIFY changed)
    Q_PROPERTY(QVariantList keywordItems READ keywordItems NOTIFY changed)
    Q_PROPERTY(QVariantList secondaryKeywordItems READ secondaryKeywordItems NOTIFY changed)
    Q_PROPERTY(bool keywordsEditable READ keywordsEditable NOTIFY changed)
    Q_PROPERTY(bool secondaryKeywordsEditable READ secondaryKeywordsEditable NOTIFY changed)
    Q_PROPERTY(QString keywordsReadonlyReason READ keywordsReadonlyReason NOTIFY changed)
    Q_PROPERTY(QString secondaryKeywordsReadonlyReason READ secondaryKeywordsReadonlyReason NOTIFY changed)
    Q_PROPERTY(bool ruleConflict READ ruleConflict NOTIFY changed)
    Q_PROPERTY(QString ruleConflictText READ ruleConflictText NOTIFY changed)
    Q_PROPERTY(QVariantMap regexDiagnostics READ regexDiagnostics NOTIFY changed)
    Q_PROPERTY(QString content READ content WRITE setContent NOTIFY changed)
    Q_PROPERTY(bool entryEnabled READ entryEnabled WRITE setEntryEnabled NOTIFY changed)
    Q_PROPERTY(bool alwaysActive READ alwaysActive WRITE setAlwaysActive NOTIFY changed)
    Q_PROPERTY(qint64 insertionOrder READ insertionOrder WRITE setInsertionOrder NOTIFY changed)
    Q_PROPERTY(QString insertionOrderText READ insertionOrderText NOTIFY changed)
    Q_PROPERTY(QVariant priority READ priority WRITE setPriority NOTIFY changed)
    Q_PROPERTY(QString priorityText READ priorityText NOTIFY changed)
    Q_PROPERTY(bool priorityConfirmed READ priorityConfirmed NOTIFY changed)
    Q_PROPERTY(bool priorityEditable READ priorityEditable NOTIFY changed)
    Q_PROPERTY(QVariant scanDepth READ scanDepth WRITE setScanDepth NOTIFY changed)
    Q_PROPERTY(QVariant bookTokenBudget READ bookTokenBudget WRITE setBookTokenBudget NOTIFY changed)
    Q_PROPERTY(QVariant recursiveScanning READ recursiveScanning WRITE setRecursiveScanning NOTIFY changed)
    Q_PROPERTY(QVariantMap bookSettingStates READ bookSettingStates NOTIFY changed)
    Q_PROPERTY(QVariant entryScanDepth READ entryScanDepth WRITE setEntryScanDepth NOTIFY changed)
    Q_PROPERTY(QVariant entryTokenBudget READ entryTokenBudget WRITE setEntryTokenBudget NOTIFY changed)
    Q_PROPERTY(QVariantMap entrySettingStates READ entrySettingStates NOTIFY changed)
    Q_PROPERTY(QVariant insertionPosition READ insertionPosition WRITE setInsertionPosition NOTIFY changed)
    Q_PROPERTY(QVariant insertionDepth READ insertionDepth WRITE setInsertionDepth NOTIFY changed)
    Q_PROPERTY(QVariant insertionRole READ insertionRole WRITE setInsertionRole NOTIFY changed)
    Q_PROPERTY(QVariantMap insertionStates READ insertionStates NOTIFY changed)
    Q_PROPERTY(QString insertionEffectiveText READ insertionEffectiveText NOTIFY changed)
    Q_PROPERTY(QString insertionDependencyNotice READ insertionDependencyNotice NOTIFY changed)
    Q_PROPERTY(QVariantList bookRows READ bookRows NOTIFY changed)
    Q_PROPERTY(QVariantList entryRows READ entryRows NOTIFY changed)
    Q_PROPERTY(QString selectedBookKey READ selectedBookKey NOTIFY changed)
    Q_PROPERTY(QString selectedEntryKey READ selectedEntryKey NOTIFY changed)
    Q_PROPERTY(bool hasBook READ hasBook NOTIFY changed)
    Q_PROPERTY(bool hasEntry READ hasEntry NOTIFY changed)
    Q_PROPERTY(bool newLocal READ newLocal NOTIFY changed)
    Q_PROPERTY(QVariantMap advancedFields READ advancedFields NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(bool deletionActive READ deletionActive NOTIFY changed)
    Q_PROPERTY(bool canNavigate READ canNavigate NOTIFY changed)
    Q_PROPERTY(bool canCreateBook READ canCreateBook NOTIFY changed)
    Q_PROPERTY(bool canCreateEntry READ canCreateEntry NOTIFY changed)
    Q_PROPERTY(bool canDeleteBook READ canDeleteBook NOTIFY changed)
    Q_PROPERTY(bool canDeleteEntry READ canDeleteEntry NOTIFY changed)
    Q_PROPERTY(QVariantMap navigationPrompt READ navigationPrompt NOTIFY changed)
    Q_PROPERTY(QVariantMap deletePrompt READ deletePrompt NOTIFY changed)
    Q_PROPERTY(QVariantMap deleteFeedback READ deleteFeedback NOTIFY changed)
    Q_PROPERTY(qint64 savedBytes READ savedBytes NOTIFY changed)
    Q_PROPERTY(qint64 draftBytes READ draftBytes NOTIFY changed)
    Q_PROPERTY(QString sizeWarning READ sizeWarning NOTIFY changed)
    Q_PROPERTY(QString saveBlocker READ saveBlocker NOTIFY changed)
    Q_PROPERTY(bool writesBlocked READ writesBlocked NOTIFY changed)
    Q_PROPERTY(QString archiveScope READ archiveScope NOTIFY changed)
    // Presentation context changes are announced before the shared changed
    // notification can update visibility, layout and the selected identity in
    // a different order. They do not participate in the archive protocol.
    Q_PROPERTY(bool focusContextChanging READ focusContextChanging NOTIFY focusContextChanged)
    Q_PROPERTY(int focusContextRevision READ focusContextRevision NOTIFY focusContextChanged)
    Q_PROPERTY(bool dirty READ dirty NOTIFY changed)
    Q_PROPERTY(bool initialized READ initialized NOTIFY changed)
    Q_PROPERTY(bool canSave READ canSave NOTIFY changed)
    Q_PROPERTY(QString status READ status NOTIFY changed)
    Q_PROPERTY(QString statusText READ statusText NOTIFY changed)
    Q_PROPERTY(int revision READ revision NOTIFY changed)
    Q_PROPERTY(QVariantMap authorPrompts READ authorPrompts NOTIFY changed)
    Q_PROPERTY(QVariantMap authorPromptFeedback READ authorPromptFeedback NOTIFY changed)
    Q_PROPERTY(QString authorPromptBlocker READ authorPromptBlocker NOTIFY changed)
  public:
    using Sender = std::function<QString(const QString &, const QVariantMap &)>;
    explicit ArchiveEditor(Sender sender, QObject *parent = nullptr);
    QString title() const { return m_title; }
    QString comment() const { return m_comment; }
    QString keywords() const { return m_keywords; }
    QString secondaryKeywords() const { return m_secondaryKeywords; }
    QString selectiveLogic() const { return m_selectiveLogic; }
    bool caseSensitive() const { return m_caseSensitive; }
    bool advancedRuleEditable() const { return hasEntry() && m_initialized && !m_readFailed; }
    bool useRegex() const { return m_useRegex; }
    QVariantList keywordItems() const { return m_keywordItems; }
    QVariantList secondaryKeywordItems() const { return m_secondaryKeywordItems; }
    bool keywordsEditable() const;
    bool secondaryKeywordsEditable() const;
    QString keywordsReadonlyReason() const;
    QString secondaryKeywordsReadonlyReason() const;
    bool ruleConflict() const { return m_ruleConflict; }
    QString ruleConflictText() const;
    QVariantMap regexDiagnostics() const;
    QString content() const { return m_content; }
    bool entryEnabled() const { return m_enabled; }
    bool alwaysActive() const { return m_alwaysActive; }
    qint64 insertionOrder() const { return m_insertionOrder; }
    QString insertionOrderText() const { return QString::number(m_insertionOrder); }
    QVariant priority() const { return m_priority; }
    QString priorityText() const;
    bool priorityConfirmed() const;
    bool priorityEditable() const;
    QVariant scanDepth() const { return m_bookSettings.value("scanDepth"); }
    QVariant bookTokenBudget() const { return m_bookSettings.value("tokenBudget"); }
    QVariant recursiveScanning() const { return m_bookSettings.value("recursiveScanning"); }
    bool bookSettingConfirmed(const QString &key) const;
    bool bookSettingEditable(const QString &key) const;
    QVariantMap bookSettingStates() const;
    QVariant entryScanDepth() const { return m_entrySettings.value("scanDepth"); }
    QVariant entryTokenBudget() const { return m_entrySettings.value("tokenBudget"); }
    bool entrySettingConfirmed(const QString &key) const;
    bool entrySettingEditable(const QString &key) const;
    bool entrySettingInherited(const QString &key) const;
    bool entrySettingCanOverride(const QString &key) const;
    QVariantMap entrySettingStates() const;
    QVariant insertionPosition() const;
    QVariant insertionDepth() const;
    QVariant insertionRole() const;
    bool insertionConfirmed(const QString &key) const;
    bool insertionEditable(const QString &key) const;
    QVariantMap insertionStates() const;
    QString insertionEffectiveText() const;
    QString insertionDependencyNotice() const { return m_insertionDependencyNotice; }
    QVariantList bookRows() const;
    QVariantList entryRows() const;
    QString selectedBookKey() const { return m_bookKey; }
    QString selectedEntryKey() const { return m_entryKey; }
    bool hasBook() const { return !m_bookKey.isEmpty(); }
    bool hasEntry() const { return !m_entryKey.isEmpty(); }
    bool newLocal() const { return !m_newKind.isEmpty(); }
    QVariantMap advancedFields() const;
    bool busy() const { return !m_readId.isEmpty() || !m_saveId.isEmpty(); }
    bool deletionActive() const { return !m_deleteTarget.isEmpty() && busy(); }
    bool canNavigate() const { return m_initialized && !busy() && !m_identityBusy; }
    bool canCreateBook() const;
    bool canCreateEntry() const;
    bool canDeleteBook() const;
    bool canDeleteEntry() const;
    QVariantMap navigationPrompt() const { return m_navigationPrompt; }
    QVariantMap deletePrompt() const { return m_deletePrompt; }
    QVariantMap deleteFeedback() const { return m_deleteFeedback; }
    qint64 savedBytes() const;
    qint64 draftBytes() const;
    QString sizeWarning() const;
    QString saveBlocker() const;
    bool writesBlocked() const { return m_writeBlocked || m_orphan; }
    QString archiveScope() const { return m_scope; }
    bool focusContextChanging() const { return m_focusContextChanging; }
    int focusContextRevision() const { return m_focusContextRevision; }
    bool dirty() const;
    bool initialized() const { return m_initialized; }
    bool canSave() const;
    QString status() const { return m_status; }
    QString statusText() const { return m_statusText; }
    int revision() const { return m_revision; }
    QVariantMap authorPrompts() const { return m_authorPrompts; }
    QVariantMap authorPromptFeedback() const { return m_authorFeedback; }
    QString authorPromptBlocker() const;
    void setTitle(const QString &);
    void setComment(const QString &);
    void setKeywords(const QString &);
    void setUseRegex(bool);
    Q_INVOKABLE void adoptSavedRules();
    void setSecondaryKeywords(const QString &);
    void setSelectiveLogic(const QString &);
    void setCaseSensitive(bool);
    void setContent(const QString &);
    void setEntryEnabled(bool);
    void setAlwaysActive(bool);
    void setInsertionOrder(qint64);
    void setPriority(const QVariant &);
    void setScanDepth(const QVariant &value) { setBookSetting("scanDepth", value); }
    void setBookTokenBudget(const QVariant &value) { setBookSetting("tokenBudget", value); }
    void setRecursiveScanning(const QVariant &value) { setBookSetting("recursiveScanning", value); }
    void setEntryScanDepth(const QVariant &value) { setEntrySetting("scanDepth", value); }
    void setEntryTokenBudget(const QVariant &value) { setEntrySetting("tokenBudget", value); }
    Q_INVOKABLE void setEntrySettingInherited(const QString &key, bool inherited);
    void setInsertionPosition(const QVariant &value) { setInsertionSetting("position", value); }
    void setInsertionDepth(const QVariant &value) { setInsertionSetting("depth", value); }
    void setInsertionRole(const QVariant &value) { setInsertionSetting("role", value); }
    void setSession(bool connected, int generation, const QString &scope, bool writable = true,
                    bool identityBusy = false);
    void reconcileAfterRestore();
    void receive(const QString &id, const QString &command, const QVariantMap &result, int generation);
    void failed(const QString &id, const QString &code, int generation);
    Q_INVOKABLE void load();
    Q_INVOKABLE void save();
    Q_INVOKABLE void reloadDiscardingDraft();
    Q_INVOKABLE void selectBook(const QString &key);
    Q_INVOKABLE void selectEntry(const QString &key);
    Q_INVOKABLE void newBook();
    Q_INVOKABLE void newEntry();
    Q_INVOKABLE void resolveNavigation(const QString &choice);
    Q_INVOKABLE void discardNew();
    Q_INVOKABLE void requestDelete(const QString &kind);
    Q_INVOKABLE void confirmDelete();
    Q_INVOKABLE void cancelDelete();
    Q_INVOKABLE void setAuthorPrompt(const QString &kind, bool enabled, bool confirmed = false);
    QVariantMap diagnostics() const;
  signals:
    void changed();
    void focusContextChanged();

  private:
    QVariantMap fields() const;
    static QVariantMap editableFields(const QVariantMap &book, const QVariantMap &entry);
    static bool snapshotValid(const QVariantMap &result);
    static QVariantMap authorPromptReview(const QVariantMap &result);
    static QVariantMap emptyArchive();
    static qint64 archiveBytes(const QVariantMap &archive);
    QVariantMap updatedArchive() const;
    bool saveAllowed(bool checkSize) const;
    bool submittedPriorityMatches(const QVariantMap &archive) const;
    bool submittedRulesMatch(const QVariantMap &archive, bool &missingTarget) const;
    bool rulesDirty() const;
    bool rulesSavable() const;
    bool ruleListEditable(const QString &key) const;
    void assignRules(const QVariantMap &values);
    void refreshRuleViews();
    void acceptWorldbookDiagnostics(const QVariantMap &result);
    void setBookSetting(const QString &key, const QVariant &value);
    bool bookSettingEdited(const QString &key) const;
    bool bookSettingsSavable() const;
    bool submittedBookSettingsMatch(const QVariantMap &archive) const;
    void setEntrySetting(const QString &key, const QVariant &value);
    bool entrySettingEdited(const QString &key) const;
    bool entrySettingsSavable() const;
    bool submittedEntrySettingsMatch(const QVariantMap &archive, bool &missingTarget) const;
    void setInsertionSetting(const QString &key, const QVariant &value);
    bool insertionEdited(const QString &key) const;
    bool insertionDirty() const;
    bool insertionSavable() const;
    bool submittedInsertionMatches(const QVariantMap &archive, bool &missingTarget) const;
    int bookIndex(const QString &key) const;
    int entryIndex(const QString &key, int book) const;
    void selectNow(const QString &bookKey, const QString &entryKey);
    void resetSelection(bool announceContextChange = true);
    void assignFields(const QVariantMap &fields);
    void requestNavigation(const QString &action, const QString &key = {});
    void performNavigation(const QString &action, const QString &key);
    void discardDraft();
    void applySnapshot(const QVariantMap &archive, int revision, bool replaceDraft, bool ownSave = false);
    void remapKeys(const QVariantMap &archive, const QVariantMap &reference,
                   const QStringList &bookKeys, const QList<QStringList> &entryKeys);
    void editChanged();
    void status(const QString &, const QString &);
    void beginFocusContextChange();
    void finishFocusContextChange();
    void authorFeedback(const QString &status, const QString &text, const QString &kind, bool enabled);
    void receiveAuthorPrompt(const QVariantMap &result);
    bool rereadForAuthorPrompt();
    bool readDeleteResult();
    void settleDeleteRead(const QVariantMap &result);
    void deleteReadFailed();
    void finishDeleteReconciliation(bool authoritativeRead);
    Sender m_send;
    QTimer m_deadline;
    QString m_title, m_comment, m_keywords, m_secondaryKeywords, m_selectiveLogic = "and_any", m_content,
        m_status = "loading", m_statusText = "正在连接本地档案…", m_scope, m_readId, m_saveId;
    QString m_bookKey, m_entryKey, m_newKind, m_pendingAction, m_pendingKey;
    QStringList m_bookKeys, m_submittedBookKeys;
    QList<QStringList> m_entryKeys, m_submittedEntryKeys;
    bool m_enabled = true, m_alwaysActive = false, m_caseSensitive = false,
         m_connected = false, m_initialized = false,
         m_autoReadAttempted = false, m_writable = true, m_reconcileRead = false,
         m_reconcilePending = false, m_reconcileKeepDraft = false, m_identityBusy = false,
         m_authorRequested = false, m_authorRereadPending = false, m_orphan = false,
         m_writeBlocked = false, m_deleteReading = false, m_deleteUnknown = false,
         m_deleteRereadPending = false, m_deleteManualRefresh = false,
         m_deleteReadReconcilesRestore = false;
    QVariantList m_keywordItems, m_secondaryKeywordItems;
    QVariantMap m_submittedRules, m_worldbookDiagnostics;
    QHash<QString, int> m_ruleEditSerials;
    bool m_useRegex = false, m_ruleConflict = false, m_submittedRulesEdited = false;
    bool m_priorityEdited = false, m_readFailed = false,
         m_submittedPriorityEdited = false, m_submittedBookSettings = false,
         m_submittedEntrySettings = false, m_submittedEntrySettingsEdited = false;
    int m_generation = 0, m_revision = 0, m_editSerial = 0, m_saveSerial = 0, m_readSerial = 0,
        m_savedRevision = 0, m_priorityEditSerial = 0;
    qint64 m_insertionOrder = 100;
    bool m_focusContextChanging = false;
    int m_focusContextRevision = 0;
    QVariant m_priority;
    // Book scan depth, token budget and recursion, each with the edit serial
    // that last changed it; an unedited value follows each authoritative read.
    QVariantMap m_bookSettings;
    QHash<QString, int> m_bookEditSerials;
    // The selected entry's own scan depth and budget exactly as read: absent,
    // null (follows the book) or an integer, with the same edit serials.
    QVariantMap m_entrySettings;
    QHash<QString, int> m_entryEditSerials;
    // Preserve absent defaults separately from the effective values shown by
    // QML; only a field the user changed is added to the wire archive.
    QVariantMap m_insertionSettings, m_submittedInsertionDraft, m_submittedInsertion;
    QHash<QString, int> m_insertionEditSerials;
    QString m_insertionDependencyNotice;
    bool m_submittedInsertionEdited = false;
    QVariantMap m_archive, m_baseline, m_selectedBook, m_selectedEntry, m_newBook, m_newEntry,
        m_submittedArchive, m_authorPrompts, m_authorFeedback, m_navigationPrompt,
        m_deletePrompt, m_deleteFeedback, m_deleteTarget;
    // All mutations share m_saveId and the same full-archive CAS revision.
    QString m_authorKind;
};
