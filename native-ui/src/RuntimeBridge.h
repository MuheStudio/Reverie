#pragma once
#include <QHash>
#include <QJSEngine>
#include <QJsonObject>
#include <QObject>
#include <QPointF>
#include <QProcess>
#include <QStringList>
#include <QTimer>
#include <QVariantList>
#include <QVariantMap>
#include <functional>
#include <memory>
class ProviderKeyStore;
class RuntimeBridge final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantMap state READ state NOTIFY changed)
    Q_PROPERTY(QVariantList messages READ messages NOTIFY messagesChanged)
    Q_PROPERTY(QString draft READ draft WRITE setDraft NOTIFY draftChanged)
    Q_PROPERTY(QString panel READ panel WRITE openPanel NOTIFY panelChanged)
    Q_PROPERTY(QPointF panelOrigin READ panelOrigin NOTIFY panelChanged)
    Q_PROPERTY(QString notice READ notice NOTIFY changed)
    Q_PROPERTY(QVariantMap chatFeedback READ chatFeedback NOTIFY changed)
    Q_PROPERTY(QVariantMap providerFeedback READ providerFeedback NOTIFY changed)
    Q_PROPERTY(QVariantMap networkFeedback READ networkFeedback NOTIFY changed)
    // Why a chat may not be sent yet for the reply service or its saved key; empty when it may.
    Q_PROPERTY(QVariantMap chatSendGate READ chatSendGate NOTIFY changed)
    Q_PROPERTY(QVariantMap permissionFeedback READ permissionFeedback NOTIFY changed)
    // Visible receipts for the memory page: "list", "action", "summary", "legacy", "profile" and "backup".
    Q_PROPERTY(QVariantMap memoryFeedback READ memoryFeedback NOTIFY changed)
    // The explicit profile-clear proposal and its correlated receipt/read-back.
    Q_PROPERTY(QVariantMap profileClearState READ profileClearState NOTIFY changed)
    // The literal filter the memory list is read with; cleared with the persona.
    Q_PROPERTY(QString memoryQuery READ memoryQuery NOTIFY changed)
    // Batch writes keep their receipt association and unknown-outcome lock separate from rows.
    Q_PROPERTY(QVariantMap memoryBatchDelete READ memoryBatchDelete NOTIFY changed)
    Q_PROPERTY(QVariantMap memoryBatchPin READ memoryBatchPin NOTIFY changed)
    Q_PROPERTY(QVariantMap memoryCandidateBatch READ memoryCandidateBatch NOTIFY changed)
    // Changes when a replacement is requested or its identity is invalidated, never on append.
    Q_PROPERTY(int memoryListRevision READ memoryListRevision NOTIFY changed)
    // Candidate batches replace their rows; opaque cursors never leave C++.
    Q_PROPERTY(QVariantMap memoryCandidatePage READ memoryCandidatePage NOTIFY changed)
    // A separate, read-only related-memory lookup; never a managed-list or chat draft.
    Q_PROPERTY(QVariantMap memoryRecallState READ memoryRecallState NOTIFY changed)
    // The selected existing summary's body; directory/status reads never supply it.
    Q_PROPERTY(QVariantMap summaryDetailState READ summaryDetailState NOTIFY changed)
    // Receipts of the terminal settings sections ("chat", "memory", "personality") and of the
    // first-run sheet ("onboarding"); a pending
    // entry carries the requested fields. "read" is present while the last settings read failed.
    Q_PROPERTY(QVariantMap settingsFeedback READ settingsFeedback NOTIFY changed)
    // Only a fresh, correlated ledger read makes the cached snapshot live.
    Q_PROPERTY(QVariantMap budgetState READ budgetState NOTIFY changed)
    // Visible receipt of an explicit persona switch; it outlives the identity
    // reset that a confirmed switch causes.
    Q_PROPERTY(QVariantMap personaFeedback READ personaFeedback NOTIFY changed)
    // A complete settings read reports first-run setup as not completed; false while unknown.
    Q_PROPERTY(bool firstRunPending READ firstRunPending NOTIFY changed)
    Q_PROPERTY(QVariantMap personaCardCandidate READ personaCardCandidate NOTIFY changed)
    Q_PROPERTY(QVariantMap personaCardFeedback READ personaCardFeedback NOTIFY changed)
    Q_PROPERTY(QVariantMap personaCardExportState READ personaCardExportState NOTIFY changed)
    Q_PROPERTY(QVariantList personaCardExportBooks READ personaCardExportBooks NOTIFY changed)
    Q_PROPERTY(QString personaCardExportDefaultBookId READ personaCardExportDefaultBookId NOTIFY changed)
    Q_PROPERTY(bool personaCardExportAvailable READ personaCardExportAvailable NOTIFY changed)
    Q_PROPERTY(bool personaCardExportBuiltin READ personaCardExportBuiltin NOTIFY changed)
    Q_PROPERTY(QVariantMap personaProfileState READ personaProfileState NOTIFY changed)
    Q_PROPERTY(bool personaProfilePending READ personaProfilePending NOTIFY changed)
    Q_PROPERTY(bool personaChanging READ personaChanging NOTIFY changed)
    Q_PROPERTY(QString scopeKey READ scopeKey NOTIFY changed)
    // Read-only presentation identity; no protocol/state payload or RPC changes.
    Q_PROPERTY(int connectionGeneration READ generation NOTIFY changed)
    Q_PROPERTY(bool backupRestoring READ backupRestoring NOTIFY changed)
    Q_PROPERTY(bool runtimeWritable READ runtimeWritable NOTIFY changed)
    Q_PROPERTY(QString recoveryState READ recoveryState NOTIFY changed)
    Q_PROPERTY(QString recoveryWarning READ recoveryWarning NOTIFY changed)
    Q_PROPERTY(bool permissionsKnown READ permissionsKnown NOTIFY changed)
    Q_PROPERTY(int permissionContextEpoch READ permissionContextEpoch NOTIFY changed)
    Q_PROPERTY(bool connected READ connected NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(bool reducedMotion READ reducedMotion WRITE setReducedMotion NOTIFY changed)
    Q_PROPERTY(bool reducedTransparency READ reducedTransparency WRITE setReducedTransparency NOTIFY
                   changed)
    Q_PROPERTY(QString avatarPath READ avatarPath NOTIFY avatarChanged)
    Q_PROPERTY(QString avatarState READ avatarState NOTIFY avatarChanged)
    Q_PROPERTY(int avatarReloadToken READ avatarReloadToken NOTIFY avatarChanged)
    Q_PROPERTY(QVariantMap avatarCandidate READ avatarCandidate NOTIFY avatarChanged)
    Q_PROPERTY(bool avatarBusy READ avatarBusy NOTIFY avatarChanged)
    Q_PROPERTY(QVariantList gameBoard READ gameBoard NOTIFY gameChanged)
    Q_PROPERTY(QString gameStatus READ gameStatus NOTIFY gameChanged)
    Q_PROPERTY(bool gameReady READ gameReady NOTIFY gameChanged)
  public:
    RuntimeBridge(QString root, QString data, QString python, QObject *parent = nullptr,
                  bool supplementaryFixture = false, bool previewMode = false);
    ~RuntimeBridge() override;
    QVariantMap state() const { return m_state; }
    QVariantList messages() const { return m_messages; }
    QString draft() const { return m_draft; }
    void setDraft(const QString &);
    QString panel() const { return m_panel; }
    QString notice() const { return m_notice; }
    QVariantMap chatFeedback() const { return m_chatFeedback; }
    QVariantMap providerFeedback() const { return m_providerFeedback; }
    QVariantMap networkFeedback() const { return m_networkFeedback; }
    QVariantMap chatSendGate() const;
    QVariantMap permissionFeedback() const { return m_permissionFeedback; }
    QVariantMap memoryFeedback() const { return m_memoryFeedback; }
    QVariantMap profileClearState() const { return m_profileClearState; }
    QString memoryQuery() const { return m_memoryQuery; }
    QVariantMap memoryBatchDelete() const;
    QVariantMap memoryBatchPin() const;
    QVariantMap memoryCandidateBatch() const;
    int memoryListRevision() const { return m_memoryListRevision; }
    QVariantMap memoryCandidatePage() const;
    QVariantMap memoryRecallState() const { return m_memoryRecallState; }
    QVariantMap summaryDetailState() const { return m_summaryDetailState; }
    QVariantMap settingsFeedback() const { return m_settingsFeedback; }
    QVariantMap budgetState() const;
    QVariantMap personaFeedback() const { return m_personaFeedback; }
    bool firstRunPending() const;
    QVariantMap personaCardCandidate() const { return m_personaCardCandidate; }
    QVariantMap personaCardFeedback() const { return m_personaCardFeedback; }
    QVariantMap personaCardExportState() const { return m_personaCardExportState; }
    QVariantList personaCardExportBooks() const;
    QString personaCardExportDefaultBookId() const;
    bool personaCardExportAvailable() const;
    bool personaCardExportBuiltin() const;
    QVariantMap personaProfileState() const { return m_personaProfileState; }
    bool personaProfilePending() const;
    bool personaChanging() const { return !m_personaSwitch.isEmpty() || !m_personaImport.isEmpty(); }
    bool backupRestoring() const { return m_backupRestoring; }
    bool runtimeWritable() const { return m_connected && m_runtimeWritable && !m_backupRestoring; }
    QString recoveryState() const { return m_recoveryState; }
    QString recoveryWarning() const;
    bool permissionsKnown() const { return m_permissionsKnown; }
    int permissionContextEpoch() const { return m_permissionContextEpoch; }
    QPointF panelOrigin() const { return m_panelOrigin; }
    bool connected() const { return m_connected; }
    bool busy() const { return m_busy; }
    bool reducedMotion() const { return m_reducedMotion; }
    bool reducedTransparency() const { return m_reducedTransparency; }
    void setReducedMotion(bool);
    void setReducedTransparency(bool);
    QString avatarPath() const { return m_avatarPath; }
    QString avatarState() const { return m_avatarState; }
    int avatarReloadToken() const { return m_avatarReloadToken; }
    QVariantMap avatarCandidate() const { return m_candidate; }
    bool avatarBusy() const { return m_avatarBusy; }
    QVariantList gameBoard() const { return m_gameBoard; }
    QString gameStatus() const { return m_gameStatus; }
    bool gameReady() const { return m_gameReady && !m_gameSaving && runtimeWritable(); }
    Q_INVOKABLE void gameClick(int square);
    Q_INVOKABLE void gameUndo();
    Q_INVOKABLE void gameReset();
    Q_INVOKABLE void gameModeChanged(bool companion);
    Q_INVOKABLE void openPanel(const QString &);
    Q_INVOKABLE void openPanelAt(const QString &name, double x, double y) {
        m_panelOrigin = {x, y};
        openPanel(name);
    }
    Q_INVOKABLE void sendChat();
    Q_INVOKABLE void cancelChat();
    Q_INVOKABLE QString request(const QString &, const QVariantMap &payload = {});
    // The local service without a key, as the earlier controls and test hosts use it.
    Q_INVOKABLE void testProvider(const QString &, const QString &);
    // An empty key tests with the saved key only when the destination is the
    // current one; a typed key replaces the saved one when this test is saved.
    Q_INVOKABLE void testProviderConfig(const QString &provider, const QString &url, const QString &model,
                                        const QString &apiKey);
    Q_INVOKABLE void saveProvider();
    // Deletes the saved key, then stops the local service from using it.
    Q_INVOKABLE void clearProviderKey();
    // Sends the stop again after a delete the service did not confirm; the Keychain is not touched.
    Q_INVOKABLE void retryProviderKeyClear();
    Q_INVOKABLE void providerDraftChanged();
    Q_INVOKABLE void setOffline(bool active);
    Q_INVOKABLE void refreshPermissions();
    Q_INVOKABLE void refreshBudget();
    Q_INVOKABLE void refreshMemories();
    // Appends the next page of the shown list, with its own cursor and query.
    Q_INVOKABLE void loadMoreMemories();
    Q_INVOKABLE void loadNextMemoryCandidates();
    Q_INVOKABLE void firstMemoryCandidates();
    // Starts a new list with this literal filter; an empty text clears it.
    Q_INVOKABLE void filterMemories(const QString &text);
    Q_INVOKABLE void queryRelatedMemories(const QString &text);
    // Drops only this window's input/results/request association, not backend work.
    Q_INVOKABLE void clearMemoryRecall();
    // Reads one ID from the current conversation's existing summary directory.
    Q_INVOKABLE void readSummaryDetail(const QString &summaryId);
    Q_INVOKABLE void clearSummaryDetail();
    // Refreshes metadata only, without requesting summary generation or changing settings.
    Q_INVOKABLE void refreshSummaryDirectory();
    Q_INVOKABLE void editMemory(const QString &memoryId, const QString &text);
    Q_INVOKABLE void deleteMemory(const QString &memoryId);
    Q_INVOKABLE void adjustMemory(const QString &memoryId, const QString &op);
    Q_INVOKABLE void deleteMemories(const QVariantList &memoryIds);
    Q_INVOKABLE void setMemoryPinned(const QString &memoryId, bool pinned);
    Q_INVOKABLE void previewMemoryPins(const QVariantList &memoryIds, bool pinned);
    Q_INVOKABLE void cancelMemoryPinPreview();
    Q_INVOKABLE void confirmMemoryPins();
    // Candidate batches preview, decide and read back as one locked operation.
    Q_INVOKABLE void previewCandidateDecisions(const QVariantList &candidateIds, bool confirm);
    Q_INVOKABLE void cancelCandidateBatchPreview();
    Q_INVOKABLE void confirmCandidateDecisions();
    // Entering a new batch selection drops earlier batch success notices only.
    Q_INVOKABLE void clearBatchSuccessFeedback();
    Q_INVOKABLE void decideMemoryCandidate(const QString &candidateId, bool confirm);
    Q_INVOKABLE void setSummaryEnabled(bool enabled);
    // Saves offered fields of one settings section and reads the runtime value back after its
    // receipt. A shorter memory retention is sent only when `confirmed`. "onboarding" accepts
    // only {completed: true}.
    Q_INVOKABLE void saveSettings(const QString &section, const QVariantMap &fields, bool confirmed = false);
    Q_INVOKABLE void grantFeature(const QString &feature, const QString &digest, bool confirmed,
                                 int expectedEpoch = -1);
    Q_INVOKABLE void reloadWorldbook();
    Q_INVOKABLE void importModel(const QUrl &);
    Q_INVOKABLE void confirmModel(bool rights, bool warnings);
    Q_INVOKABLE void modelRendered(bool, const QString &, const QString &path);
    Q_INVOKABLE void selectModel(const QString &);
    Q_INVOKABLE void saveWorldbook(const QString &, const QString &, const QString &, bool);
    // Inspect chosen backup bytes before a private staging copy and explicit confirmation.
    Q_INVOKABLE void exportBackup(const QUrl &target);
    Q_INVOKABLE QUrl suggestedBackupFile() const;
    Q_INVOKABLE void chooseBackupForRestore(const QUrl &source);
    Q_INVOKABLE void chooseBackupForRescue(const QUrl &source);
    Q_INVOKABLE void confirmBackupRestore(bool knownGood = false);
    Q_INVOKABLE void cancelBackupRestore();
    // Saves the user's own profile; blank fields mean "unchanged" in the backend.
    Q_INVOKABLE void saveProfile(const QVariantMap &fields);
    Q_INVOKABLE void proposeProfileClear(bool draftDirty = false);
    Q_INVOKABLE void confirmProfileClear(const QStringList &fields, const QString &expectedScope,
                                        const QString &expectedSnapshot, bool draftDirty = false);
    Q_INVOKABLE void cancelProfileClear();
    Q_INVOKABLE void refreshProfile();
    Q_INVOKABLE void selectPersona(const QString &);
    Q_INVOKABLE void refreshPersonas();
    Q_INVOKABLE void choosePersonaCard(const QUrl &source);
    Q_INVOKABLE void importPersonaCard();
    Q_INVOKABLE void cancelPersonaCard();
    Q_INVOKABLE QUrl suggestedPersonaCardFile() const;
    Q_INVOKABLE void exportPersonaCard(const QUrl &target, const QString &worldBookId);
    Q_INVOKABLE void loadPersonaProfile(const QString &profileId);
    Q_INVOKABLE void savePersonaProfile(const QVariantMap &fields, bool confirmed = false);
    Q_INVOKABLE void closePersonaProfile();
    Q_INVOKABLE void chooseSummaryFile(const QUrl &);
    Q_INVOKABLE void confirmSummaryImport();
    Q_INVOKABLE void quit();
    void start();
    // C++ test host only. The caller validates its isolated context and loopback endpoint.
    void setSupplementaryFixtureArguments(const QString &context, const QString &endpoint, int cycle,
                                         bool p0Tail = false, const QString &endpointB = {});
    void setRestoreFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setPersonaFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setMemoryFixtureArguments(const QString &context, const QString &endpoint, int cycle,
                                   bool candidatePaging = false);
    void setProfileFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setSettingsFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setWorldbookEntryFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setWorldbookInjectionFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    void setWorldbookRegexFixtureArguments(const QString &context, const QString &endpoint, int cycle);
    // Where the reply-service key is kept; without one, keys cannot be saved.
    void setProviderKeyStore(std::unique_ptr<ProviderKeyStore> store);
    void shutdown();
    QString dataRoot() const { return m_data; }
    QString projectRoot() const { return m_root; }
    QVariantMap diagnostics() const;
    // C++ fixture comparison only. Never exposes cursor, list IDs or text to QML/reports.
    QString memoryPagingFingerprint() const;
    QString candidatePagingFingerprint() const;
    int generation() const { return m_generation; }
    QString scopeKey() const {
        return m_persona.value("persona_id").toString() + ":" +
               QString::number(m_persona.value("epoch").toInt()) + ":" +
               m_persona.value("fingerprint").toString();
    }
  signals:
    void changed();
    void messagesChanged();
    void draftChanged();
    void panelChanged();
    void avatarChanged();
    void gameChanged();
    void commandResult(QString command, QVariantMap result);
    void shutdownComplete();
    // Only emitted for a preview host after private ready and recovery validation.
    void validatedReady(QVariantMap status);
    // Preview-only sanitized event input. The writer applies its fixed allowlist.
    void previewEvent(QString event, QString code, qint64 value);
    void backupRestoreReconciled();
    // A complete settings snapshot has replaced state["settings"].
    void settingsRead();
    void responseReceived(QString requestId, QString command, QVariantMap result, int generation);
    void requestFailed(QString requestId, QString code, int generation);

  private:
    friend class RuntimeBridgeTest;
    void readFrames();
    void acceptFrame(const QJsonObject &);
    bool write(const QJsonObject &);
    // timeoutMs 0 means the call settles only by its acknowledgement or a lost connection.
    QString control(const QString &, QJsonObject fields = {},
                    std::function<void(QJsonObject)> callback = {}, int timeoutMs = 30000);
    void event(const QJsonObject &);
    void refresh();
    void setNotice(QString);
    void expirePending(const QString &id);
    void finishChat(const QString &status);
    void setChatFeedback(const QString &status, const QString &text);
    void setCancelFeedback(const QString &status, const QString &text, const QString &requestId,
                           const QString &subjectRequestId);
    void setProviderFeedback(const QString &status, const QString &text, bool currentDraft = true);
    void setPermissionFeedback(const QString &key, const QString &status, const QString &text,
                               const QString &action, const QString &requestId = {});
    void invalidatePermissions();
    void setMemoryFeedback(const QString &key, const QString &status, const QString &text,
                           const QString &requestId = {}, const QVariantMap &extra = {});
    bool memoryRequestPending(const QString &key) const;
    bool memoryAdjustmentPending() const;
    bool memoryBatchDeleteBlocked() const;
    void unknownMemoryBatchDelete();
    void finishMemoryBatchDelete(const QString &type, const QJsonObject &payload, const QString &requestId);
    void settleMemoryBatchDeleteRead(const QString &requestId, bool success);
    bool memoryBatchPinBlocked() const;
    bool memoryPinOtherWritePending() const;
    void failMemoryPinPreview(const QString &text);
    void unknownMemoryBatchPin();
    void invalidateMemoryPinConnection(bool scopeChanged);
    void applyMemoryPinStatus(const QString &type, const QJsonObject &payload, const QString &id);
    void finishMemoryBatchPin(const QString &type, const QJsonObject &payload, const QString &id);
    void readMemoryBatchPin(bool manual);
    void settleMemoryBatchPinList(const QString &type, const QJsonObject &payload,
                                  const QString &id, bool success);
    void settleMemoryBatchPinReads();
    bool candidateBatchBlocked() const;
    bool candidateBatchOtherWritePending() const;
    void failCandidateBatchPreview(const QString &text);
    void unknownCandidateBatch();
    void invalidateCandidateBatchConnection(bool scopeChanged);
    void applyCandidateBatchStatus(const QString &type, const QJsonObject &payload, const QString &id);
    void finishCandidateBatch(const QString &type, const QJsonObject &payload, const QString &id);
    void readCandidateBatch(bool manual);
    void settleCandidateBatchRead(const QString &id, bool success);
    void settleCandidateBatchReads();
    void setSettingsFeedback(const QString &key, const QString &status, const QString &text,
                             const QString &requestId = {}, const QVariantMap &fields = {});
    // Builds the settings:update body from the offered fields; empty means nothing to send.
    static QVariantMap settingsUpdate(const QString &section, const QVariantMap &fields, QString *error);
    // A complete snapshot was read and no later read has failed.
    bool settingsKnown() const;
    // A pending save loses its correlation; its outcome becomes unknown.
    void unsettleSettingsSaves(const QString &text);
    // A confirmed save settles once the read it requested has returned or been lost.
    void settleSettingsRead(const QString &readId);
    void invalidateBudget(const QString &text);
    void applyBudgetRead(const QString &type, const QJsonObject &payload, const QString &requestId);
    void setPersonaFeedback(const QString &status, const QString &text, const QString &requestId = {});
    // Clears persona-scoped state on an identity change; app-wide state stays.
    void resetPersonaState();
    // Called after an identity reset: settles a switch this bridge requested.
    void settlePersonaSwitch(bool restartRequired);
    void finishPersonaActivation(const QString &type, const QJsonObject &payload, const QString &id);
    bool personaCardActionAllowed();
    void clearPersonaCardCandidate();
    void setPersonaCardFeedback(const QString &status, const QString &text,
                                const QString &requestId = {}, const QVariantMap &extra = {});
    void observePersonaCardIdentity(const QJsonObject &proof, const QJsonObject &payload);
    void finishPersonaCardImport(const QString &type, const QJsonObject &payload, const QString &id);
    void settlePersonaCardReceipt();
    void forgetPersonaCardImport(const QString &text);
    QVariantMap personaCardExportProfile() const;
    bool personaCardExportArchiveKnown() const;
    bool personaCardExportPending() const;
    void setPersonaCardExportState(const QString &status, const QString &text,
                                   const QVariantMap &details = {});
    void unknownPersonaCardExport();
    void invalidatePersonaProfile();
    void finishPersonaProfile(const QString &type, const QJsonObject &payload, const QString &id);
    void setPersonaProfileStatus(const QString &status, const QString &text);
    // Builds the {profile:{...}} body from form text; empty means nothing to send.
    static QVariantMap profileUpdate(const QVariantMap &fields, QString *error);
    bool profileSnapshotKnown() const;
    bool profileUpdatePending() const;
    bool profileClearBlocksWrite() const;
    void setProfileClearState(const QString &status, const QString &text);
    void unknownProfileClear(const QString &text);
    void reconcileProfileClear();
    void observeProfileResult(const QString &command, const QString &type,
                              const QJsonObject &payload, const QString &id);
    // Checks mirror the desktop host:
    // regular non-symlink file, size bound, unchanged identity.
    static QString stageBackupFile(const QString &source, const QString &stagingDir, QString *error);
    void discardStagedBackup();
    void rejectBackupRestore();
    bool applyRecoverySnapshot(const QJsonObject &, bool ready = false, bool allowUnlock = false);
    void chooseBackup(const QUrl &, bool rescue);
    static QVariantMap backupFileBinding(const QString &, QString *error);
    void memoryAction(const QString &command, const QVariantMap &payload, const QString &verb,
                      const QString &subjectId);
    void readMemories(bool afterChange);
    // Reads the first page with the current filter; it replaces the shown list.
    QString startMemoryList();
    void applyMemoryPage(bool firstPage, const QString &type, const QJsonObject &payload,
                         bool failed, const QString &requestId);
    QString startCandidatePage(const QString &kind, const QString &startCursor, int pageNumber);
    bool applyCandidatePage(const QString &type, const QJsonObject &payload,
                            bool failed, const QString &requestId);
    void candidateReadSettled(const QString &requestId, bool success);
    void unknownCandidateDecision(const QString &text);
    void reconcileCandidateDecision(bool manual);
    bool candidateDecisionLocked() const;
    void invalidateCandidatePaging(bool clearRows);
    void invalidateMemoryRecall(bool clearInput, const QString &status = "idle",
                                const QString &text = {});
    void applyMemoryRecall(const QString &type, const QJsonObject &payload,
                           const QString &requestId);
    void invalidateSummaryDetail(const QString &status = "idle", const QString &feedback = {});
    void failSummaryDetail(const QString &feedback);
    void invalidateSummaryDirectory();
    bool summaryDirectoryCurrent() const;
    QVariantMap summaryStatusSnapshot(const QJsonObject &payload);
    void applySummaryDetail(const QString &type, const QJsonObject &payload,
                            const QString &requestId);
    void readProviderForPermissions(bool reconcileSave);
    // A read reported a destination without a model; chat waits for a saved service.
    void markProviderUnconfigured();
    // Sends the saved key when it belongs to this provider snapshot's destination.
    void applyProviderKey(const QJsonObject &snapshot, const QString &reason);
    void rollBackProviderAfterKeyFailure(const QJsonObject &previous);
    void updateProviderKeyState();
    // An identity reset drops pending requests without their callbacks.
    void settleDroppedProviderKeyRequests();
    // A provider read or configure is awaiting its acknowledgement.
    bool providerControlPending() const;
    // Tells the service to stop using the deleted key; an unconfirmed stop is verified by a read.
    void sendProviderKeyClear(const QString &voided);
    // One read-only provider:get whose has_api_key settles an unconfirmed stop.
    void verifyProviderKeyCleared();
    // Any valid provider snapshot settles or confirms an unconfirmed stop.
    void observeProviderKeyClear(const QJsonObject &snapshot, bool verifying);
    void avatarJob(const QJsonObject &, std::function<void(QJsonObject)>);
    void persistAppearance();
    void rememberAvatar(const QJsonObject &);
    bool retargetAvatar(const QString &entry);
    void rebuildGame();
    void saveGame();
    void scheduleOpponent();
    void applyMove(const QVariantMap &move);
    QString m_root, m_data, m_python, m_secret, m_panel, m_draft, m_notice, m_chatId, m_avatarPath,
        m_avatarState = "未选择形象";
    QPointF m_panelOrigin{400, 800};
    QVariantMap m_state, m_candidate;
    QVariantMap m_chatFeedback{{"status", "idle"}, {"text", ""}},
        m_providerFeedback{{"status", "idle"}, {"text", ""}, {"pending", false}, {"saving", false}},
        m_networkFeedback{{"status", "unknown"}, {"text", "网络调用状态尚未确认。"}, {"known", false}},
        m_permissionFeedback, m_memoryFeedback, m_settingsFeedback, m_personaFeedback;
    QVariantMap m_budgetState{{"status", "idle"}, {"text", "用量尚未读取。"}, {"live", false},
        {"stale", true}, {"snapshot", QVariantMap{}}, {"requestId", ""},
        {"scopeKey", ""}, {"generation", -1}};
    QString m_budgetReadId;
    QJsonObject m_budgetReadPersona;
    int m_budgetReadGeneration = -1;
    int m_budgetDispatchGeneration = -1, m_budgetReadDispatchCount = 0;
    // {requestId, targetId, targetName} of the one switch awaiting its identity change.
    QVariantMap m_personaSwitch;
    QVariantMap m_personaCardCandidate, m_personaCardFeedback, m_personaImport;
    QVariantMap m_personaCardExportState;
    QVariantMap m_personaProfileState;
    QJsonObject m_personaProfileProof;
    int m_personaProfileGeneration = -1;
    bool m_personaProfileSending = false;
    QJsonObject m_personaCardExportArchivePersona;
    int m_personaCardExportArchiveGeneration = -1, m_personaCardExportProfilesGeneration = -1;
    QVariantMap m_profileClearState;
    QJsonObject m_profileClearProfile, m_profileClearReceipt;
    QString m_profileReadId, m_profileSnapshotScope;
    int m_profileSnapshotGeneration = -1;
    bool m_profileClearSending = false;
    QString m_personaCardJson;
    QJsonObject m_personaImportReceipt;
    QVariantList m_messages;
    QProcess m_process;
    QByteArray m_buffer;
    QJsonObject m_persona, m_providerTest, m_chatPersona;
    // Reply-service key: only binding metadata is cached; the key itself is
    // read from the store when it is sent and kept between test and save only.
    std::unique_ptr<ProviderKeyStore> m_keyStore;
    QString m_providerTestKey, m_keyApplyId, m_keyClearId, m_keyStoreError, m_keyApplyReason;
    QString m_keyBinding, m_keyStoredBinding, m_keyStoredWriteId;
    QString m_keyAppliedBinding, m_keyAppliedWriteId;
    int m_keyAppliedHandshake = -1;
    // The connection whose provider snapshot was last read or saved, and the
    // one whose key send the service explicitly failed; both gate chat sends.
    int m_providerConfirmedHandshake = -1, m_keyApplyFailedHandshake = -1;
    // The connection whose provider read reported no model chosen yet (a fresh install).
    int m_providerUnconfiguredHandshake = -1;
    // After a delete whose stop was not confirmed: "verifying" while a read checks the
    // service, "unconfirmed" when that read failed, "held" when the service still has a key.
    // Ends on has_api_key=false, a confirmed stop, a new key saved or a new connection.
    QString m_keyClearState, m_keyClearVerifyId, m_keyClearVoided;
    // Process-local successful key acknowledgements, never a secret or a
    // claim that a resend was necessary for the backend to retain its key.
    qulonglong m_keyDeliveryCount = 0;
    bool m_keyStored = false, m_providerTestReplacesKey = false, m_keyReapply = false;
    QString m_providerSaveId, m_networkRequestId, m_permissionProviderReadId;
    // Memory list: the shown list's first-page and load-more reads, the query
    // the first-page read was sent with, and the shown list's next cursor. A
    // cursor counts only on the connection that returned it.
    QString m_memoryQuery, m_memoryListId, m_memoryListQuery, m_memoryMoreId, m_memoryCursor;
    bool m_memoryListLive = false;
    QVariantMap m_memoryBatchDelete;
    // Exists only while adjustMemory dispatches its exact, scope-bound request.
    QVariantMap m_memoryAdjustDispatch;
    QVariantMap m_memoryBatchPin, m_memoryPinReadStates;
    qulonglong m_memoryBatchPinDispatchCount = 0, m_memoryPinStatusDispatchCount = 0;
    bool m_memoryPinStatusSending = false, m_memoryPinListSending = false;
    QVariantMap m_candidateBatch;
    qulonglong m_candidateBatchDispatchCount = 0, m_candidateStatusDispatchCount = 0;
    bool m_candidateStatusSending = false, m_candidateBatchReading = false;
    int m_memoryListRevision = 0;
    qulonglong m_memoryBatchDeleteDispatchCount = 0;
    QString m_candidateStartCursor, m_candidateNextCursor, m_candidateReadId, m_candidateLastReadId,
        m_candidateReadStartCursor, m_candidateReadKind, m_candidateScope;
    QJsonObject m_candidateReadPersona;
    QVariantMap m_candidateStartBoundary, m_candidateReadBoundary, m_candidateDecision;
    int m_candidatePageNumber = 1, m_candidateReadPageNumber = 1,
        m_candidateGeneration = -1, m_candidateReadGeneration = -1,
        m_candidateRevision = 0;
    bool m_candidateLive = false, m_candidateHasMore = false, m_candidateNeedsRefresh = false;
    QVariantMap m_memoryRecallState{{"status", "idle"}, {"text", ""}, {"requestId", ""},
        {"submittedQuery", ""}, {"results", QStringList{}}, {"mode", "unknown"},
        {"reason", ""}, {"indexPending", QVariant()}, {"inputEpoch", 0},
        {"scopeKey", ""}, {"generation", -1}};
    QString m_memoryRecallId;
    QJsonObject m_memoryRecallPersona;
    int m_memoryRecallGeneration = -1;
    QVariantMap m_summaryDetailState{{"status", "idle"}, {"summaryId", ""},
        {"text", ""}, {"requestId", ""}, {"conversationId", "dream-room"}, {"feedback", ""}};
    QString m_summaryDetailId, m_summaryStatusReadId;
    QJsonObject m_summaryDirectory, m_summaryDirectoryPersona, m_summaryDetailPersona,
        m_summaryDetailMetadata;
    int m_summaryDirectoryGeneration = -1, m_summaryDetailGeneration = -1;
    bool m_summaryDetailSending = false;
    bool m_supplementaryFixture = false, m_restoreFixture = false, m_personaFixture = false,
         m_memoryFixture = false, m_profileFixture = false, m_settingsFixture = false,
         m_worldbookEntryFixture = false, m_worldbookRegexFixture = false, m_worldbookInjectionFixture = false;
    bool m_previewMode = false;
    bool m_fixtureP0Tail = false;
    bool m_fixtureCandidatePaging = false;
    QString m_fixtureContext, m_fixtureEndpoint, m_fixtureEndpointB;
    int m_fixtureCycle = 0;
    bool m_connected = false, m_busy = false, m_stopping = false, m_reducedMotion = false,
         m_reducedTransparency = false, m_modelConfirmed = false, m_offline = false,
         m_avatarBusy = false;
    bool m_permissionsKnown = false, m_providerContextUnknown = false;
    int m_generation = 0, m_commands = 0, m_handshakes = 0, m_providerGeneration = 0,
        m_localModeEpoch = 0, m_chatGeneration = -1;
    int m_permissionContextEpoch = 0, m_permissionSequence = 0;
    // Render outcome of m_avatarPath, reported by the native surface.
    enum class AvatarRender { Pending, Ready, Failed } m_avatarRender = AvatarRender::Pending;
    int m_avatarReloadToken = 0;
    QString m_backupStaged, m_backupSource;
    QVariantMap m_backupInspection, m_backupSourceBinding;
    bool m_backupRescue = false, m_runtimeWritable = false, m_recoveryLocked = false;
    QString m_recoveryState = "unknown";
    bool m_backupRestoring = false;
    QTimer m_readyTimer;
    struct Pending {
        QString command;
        int generation;
        std::function<void(QJsonObject)> callback;
        int gameEpoch = -1;
        QString subjectRequestId;
        QString feature;
        int permissionContextEpoch = -1;
        int permissionSequence = -1;
        bool memoryAdjustment = false;
    };
    QHash<QString, Pending> m_pending;
    // Friend-only transport seam for dispatcher tests; production uses QProcess.
    std::function<qint64(const QByteArray &)> m_frameWriter;
    QJSEngine m_rules;
    QJSValue m_xiangqi, m_position;
    QVariantList m_moves, m_gameBoard;
    QString m_gameStatus = "正在读取棋局…";
    int m_selection = -1, m_gameRevision = 0, m_gameGeneration = 0;
    bool m_gameReady = false, m_gameSaving = false, m_companion = false, m_opponentPending = false;
    QString m_legacyContent, m_legacySha;
    int m_legacyGeneration = -1;
    QVariantMap m_archive;
};
