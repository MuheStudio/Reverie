#include "SummaryViewCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "CandidateHeaderProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSet>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

namespace {
const QString fixtureId = "summary_eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee";
const QString fixtureBody = "SUMMARY_VIEW_R3_MARKER：窗边的合成回忆。<b>这是纯文本</b>\n本段仅用于隔离查看。";
QString digest(const QByteArray &bytes) {
    return QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
}
QStringList ids(const QVariantList &rows) {
    QStringList result;
    for (const auto &row : rows) result.append(row.toMap().value("id").toString());
    return result;
}
QString idsDigest(const QStringList &values) {
    return digest(QJsonDocument(QJsonArray::fromStringList(values)).toJson(QJsonDocument::Compact));
}
bool actualBool(const QVariantMap &values, const QString &key, bool expected) {
    return values.value(key).metaType().id() == QMetaType::Bool && values.value(key).toBool() == expected;
}
// New acquisition diagnostics retain only finite numeric/boolean leaves.
// In particular, never copy the observation's scope or textual reason.
QVariant numericMetadata(const QVariant &value, int depth = 0) {
    if (depth > 6) return {};
    switch (value.metaType().id()) {
    case QMetaType::Bool: return value;
    case QMetaType::Int: case QMetaType::UInt:
    case QMetaType::LongLong: case QMetaType::ULongLong: return value;
    case QMetaType::Double: case QMetaType::Float:
        return std::isfinite(value.toDouble()) ? value : QVariant{};
    case QMetaType::QVariantMap: {
        QVariantMap out;
        const auto source = value.toMap();
        for (auto it = source.begin(); it != source.end() && out.size() < 64; ++it) {
            const auto measured = numericMetadata(it.value(), depth + 1);
            if (measured.isValid()) out[it.key()] = measured;
        }
        return out;
    }
    case QMetaType::QVariantList: {
        QVariantList out;
        for (const auto &item : value.toList()) {
            if (out.size() == NativeControlReadiness::ObservationLimit) break;
            const auto measured = numericMetadata(item, depth + 1);
            if (measured.isValid()) out.append(measured);
        }
        return out;
    }
    default: return {};
    }
}
bool receiptScopeMatches(const QVariantMap &value, const QString &scope) {
    const auto id = value.value("personaId").toString();
    const auto fingerprint = value.value("personaFingerprint").toString();
    bool numeric = false;
    const int epoch = value.value("personaEpoch").toInt(&numeric);
    return !id.isEmpty() && !fingerprint.isEmpty() && numeric &&
        id + ":" + QString::number(epoch) + ":" + fingerprint == scope;
}
QVariantMap sourceMetadata(const QVariantMap &row) {
    const auto sourceIds = row.value("messageIds").toStringList();
    return {{"summaryId", row.value("summary_id")}, {"sourceDigest", row.value("sourceDigest")},
        {"sourceIdsSha256", idsDigest(sourceIds)}, {"sourceMessageCount", sourceIds.size()},
        {"firstSequence", row.value("firstSequence")}, {"lastSequence", row.value("lastSequence")},
        {"contractVersion", row.value("contractVersion")}};
}
// Only this explicit allowlist leaves the check. The raw response body remains
// in memory for equality checks; report/error values contain lengths and hashes.
QVariantMap receipt(const QString &id, const QString &command, const QVariantMap &payload,
                    int generation, const QString &scope, bool detail) {
    QVariantMap result{{"requestId", id}, {"command", command}, {"generation", generation}, {"scope", scope},
        {"ok", payload.value("ok")}, {"operation", payload.value("operation")},
        {"conversationId", payload.value("conversation_id")}, {"personaId", payload.value("persona_id")},
        {"personaEpoch", payload.value("persona_epoch")}, {"personaFingerprint", payload.value("persona_fingerprint")}};
    const auto rows = payload.value("summaries").toList();
    const auto row = detail ? payload.value("summary").toMap() : rows.value(0).toMap();
    result.insert(sourceMetadata(row));
    if (detail) {
        const auto body = row.value("text").toString();
        result.insert({{"bodySha256", digest(body.toUtf8())}, {"bodyCharacters", body.toUcs4().size()},
            {"bodyUtf16Length", body.size()},
            {"bodyMatchesFixture", row.value("text").metaType().id() == QMetaType::QString && body == fixtureBody}});
    } else {
        bool bodyPresent = payload.contains("text") || payload.contains("body");
        for (const auto &value : rows) {
            const auto offered = value.toMap();
            bodyPresent = bodyPresent || offered.contains("text") || offered.contains("body");
        }
        result.insert({{"status", payload.value("status")}, {"enabled", payload.value("enabled")},
            {"authorized", payload.value("authorized")}, {"summaryTotal", payload.value("summaryTotal")},
            {"hasMore", payload.value("hasMore")}, {"bodyFieldPresent", bodyPresent}});
    }
    return result;
}
QVariantMap directorySnapshot(const QVariantMap &directory) {
    QVariantMap snapshot;
    for (const auto *key : {"ok", "directoryReady", "enabled", "authorized", "status", "summaryTotal", "hasMore"})
        snapshot[key] = directory.value(key);
    snapshot["conversationId"] = directory.value("conversation_id");
    QVariantList rows;
    for (const auto &value : directory.value("summaries").toList()) {
        QVariantMap row;
        const auto offered = value.toMap();
        for (const auto *key : {"summary_id", "sourceDigest", "messageIds", "firstSequence", "lastSequence", "contractVersion"})
            row[key] = offered.value(key);
        rows.append(row);
    }
    snapshot["summaries"] = rows;
    return snapshot;
}
class Check final : public QObject {
    using Action = NativeControlReadiness::SequentialGate::Action;
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, baselineReady = false, directoryArmed = false, detailArmed = false;
    QString prefix, scope, draft, filter, pagingFingerprint, directoryId, detailId, lastOpeningDirectoryId;
    QStringList source127, beforeOpeningIds;
    QVariantMap initialArchive, initialUiDraft, initialRecall, initialSettings, initialPermissions;
    QVariantMap managementList, managementFeedback, managementCandidates, rawDirectory, rawDetail;
    QVariantMap directoryRow, detailRow, observed;
    QVariantList messages, checks, inputs, openingReads;
    int generation, startCommands, baselineCommands = -1, clearCommands = -1;
    int directoryResponses = 0, detailResponses = 0, otherResponses = 0, step = 0;
    QTimer timer;
    QElapsedTimer clock;
    qint64 at = 0, closeAt = -1;
    quint64 frame = 0;
    NativeControlReadiness::SequentialGate gate;
    SummaryInteractionProbe::StableGate stable;
    CandidateHeaderProbe::StableRead headerStable;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify,
          QStringList expectedIds, QString capture, std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), e(editor), restart(verify), prefix(std::move(capture)),
          scope(session->scopeKey()), draft(session->draft()), filter(session->memoryQuery()),
          source127(std::move(expectedIds)), beforeOpeningIds(ids(list().value("memories").toList())),
          initialArchive(archiveDraft()), initialUiDraft(uiDraft()), initialRecall(session->memoryRecallState()),
          initialSettings(session->state().value("settings").toMap()),
          initialPermissions(session->state().value("permissions").toMap()), messages(session->messages()),
          generation(session->generation()), startCommands(commands()), done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int g) {
                if (!baselineReady) {
                    openingReads.append(QVariantMap{{"requestId", id}, {"command", command}, {"generation", g}});
                    if (command == "summary:status") lastOpeningDirectoryId = id;
                    return;
                }
                if (command == "summary:status" && directoryArmed) {
                    ++directoryResponses;
                    rawDirectory = receipt(id, command, payload, g, s->scopeKey(), false);
                    const auto rows = payload.value("summaries").toList();
                    directoryRow = rows.value(0).toMap();
                } else if (command == "summary:get" && detailArmed) {
                    ++detailResponses;
                    rawDetail = receipt(id, command, payload, g, s->scopeKey(), true);
                    detailRow = payload.value("summary").toMap();
                } else ++otherResponses;
            });
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing) return;
            executing = true;
            try { tick(); } catch (const std::exception &error) { finish(false, error.what()); }
            executing = false;
        });
        timer.start();
    }
    void require(bool passed, const QString &code, QVariantMap values = {}) const {
        values.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"scope", s->scopeKey()},
                       {"generation", s->generation()}});
        NativeCheck::require(passed, code, values);
    }
    QVariantMap list() const { return s->state().value("memory").toMap(); }
    QVariantMap directory() const { return s->state().value("summary").toMap(); }
    int commands() const { return s->diagnostics().value("commands").toInt(); }
    NativeCheck::VisualMatch matchItem(const QString &name, bool visible = false) const {
        // Main owns three TaskPanel instances. Their hidden controls retain
        // the same object names, so memory controls must stay inside this
        // page's persistent subtree even before opening or after local clear.
        static const QStringList globalControls{"memoryTasks", "nav-memory", "archive-open-memories", "memory-close",
                                                "drawer-memory", "drawer-settings", "taskSurface"};
        auto *root = w->contentItem();
        if (!globalControls.contains(name))
            root = NativeCheck::findVisual(root, "memoryTasks").item;
        return NativeCheck::findVisual(root, name, visible);
    }
    QQuickItem *item(const QString &name, bool visible = false) const {
        return matchItem(name, visible).item;
    }
    bool opened() const {
        const auto *surface = item("drawer-memory");
        return surface && surface->property("inputReady").toBool();
    }
    bool closed() const {
        for (const auto *name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            const auto *surface = item(name);
            if (surface && surface->property("progress").toDouble() > 0) return false;
        }
        return true;
    }
    QVariantMap archiveDraft() const {
        QVariantMap result;
        for (const auto *name : {"title", "comment", "keywords", "secondaryKeywords", "selectiveLogic", "caseSensitive",
                "content", "entryEnabled", "alwaysActive", "insertionOrder", "selectedBookKey", "selectedEntryKey",
                "newLocal", "advancedFields", "dirty", "revision"}) result[name] = e->property(name);
        return result;
    }
    QVariantMap uiDraft() const {
        QVariantMap result;
        for (const auto *name : {"memoryFilterField", "profileName", "profileNickname", "profileBirthday", "profileSchedule",
                "profileIdentity", "profileInterests", "profileHobbies", "profileTopics",
                "profileFavoriteGames", "profileFavoriteAnime", "profileAge"}) {
            const auto *control = item(name);
            NativeCheck::require(control && control->property("text").metaType().id() == QMetaType::QString,
                "SUMMARY_VIEW_DRAFT_CONTROL_UNAVAILABLE", {{"control", name}, {"found", control != nullptr}});
            result[name] = control->property("text");
        }
        const auto *tasks = item("memoryTasks");
        NativeCheck::require(tasks != nullptr, "SUMMARY_VIEW_TASKS_UNAVAILABLE", {{"found", tasks != nullptr}});
        for (const auto *name : {"editingMemoryId", "deletingMemoryId", "profileDirty", "profileEditRevision",
                "profileSavingRevision", "profileSaveRequestId"}) {
            const auto value = tasks->property(name);
            NativeCheck::require(value.isValid(), "SUMMARY_VIEW_DRAFT_STATE_UNAVAILABLE", {{"name", name}, {"found", value.isValid()}});
            result[name] = value;
        }
        return result;
    }
    QVariantList pending() const { return s->diagnostics().value("pendingCommands").toList(); }
    QString ownPending(const QString &command) const {
        QString id;
        int count = 0;
        for (const auto &value : pending()) {
            const auto request = value.toMap();
            if (request.value("command").toString() != command) continue;
            ++count;
            require(request.value("generation").toInt() == generation, "SUMMARY_VIEW_PENDING_GENERATION");
            id = request.value("id").toString();
        }
        require(count <= 1, "SUMMARY_VIEW_MULTIPLE_PENDING", {{"command", command}, {"count", count}});
        return id;
    }
    void next(int target) { step = target; at = clock.elapsed(); gate.resetForNextStep(); stable.reset(); headerStable.reset(); }
    void record(const QString &name) {
        for (const auto &check : checks)
            require(check.toMap().value("name").toString() != name, "SUMMARY_VIEW_CHECK_DUPLICATED", {{"name", name}});
        checks.append(QVariantMap{{"name", name}, {"passed", true}});
    }
    bool observeCandidateHeader(const QString &phase, bool visible) {
        const auto page = s->memoryCandidatePage();
        const auto candidates = s->state().value("candidates").toMap().value("candidates").toList();
        const auto readId = s->memoryFeedback().value("candidates").toMap().value("requestId").toString();
        auto header = CandidateHeaderProbe::inspect(w, page, candidates.size(), readId, scope, generation, frame);
        observed["lastCandidateHeader"] = header;
        const auto result = headerStable.poll(header, visible, clock.elapsed() - at, visible ? 4000 : 10000);
        observed["candidateHeaderAcquisition"] = headerStable.evidence();
        require(result != CandidateHeaderProbe::StableRead::Expired && result != CandidateHeaderProbe::StableRead::Failed,
                "SUMMARY_VIEW_CANDIDATE_HEADER_VISIBILITY", header);
        if (result != CandidateHeaderProbe::StableRead::Ready) { w->update(); return false; }
        header["settling"] = headerStable.evidence();
        auto headers = observed.value("candidateHeaders").toList();
        require(headers.size() < 2, "SUMMARY_VIEW_CANDIDATE_HEADER_BOUND");
        headers.append(QVariantMap{{"phase", phase}, {"pageNumber", page.value("pageNumber").toInt()},
            {"count", candidates.size()}, {"readRequestId", readId}, {"scope", scope},
            {"generation", generation}, {"header", header}});
        observed["candidateHeaders"] = headers;
        return true;
    }
    bool detailEmpty() const {
        const auto detail = s->summaryDetailState();
        return detail.value("status") == "idle" && detail.value("summaryId").toString().isEmpty() &&
            detail.value("requestId").toString().isEmpty() && detail.value("text").toString().isEmpty();
    }
    SummaryInteractionProbe::ControlObservation inspect(QQuickItem *control, bool surface) const {
        auto result = SummaryInteractionProbe::inspect(control, w, surface, scope);
        const bool fullyVisible = control && result.clip.contains(result.scene.adjusted(.5, .5, -.5, -.5));
        result.eligible = result.eligible && fullyVisible;
        result.state["fullyVisible"] = fullyVisible;
        result.state["ready"] = result.eligible;
        return result;
    }
    bool press(const QString &name, const std::function<void()> &before = {}, const std::function<void()> &after = {},
               bool entry = false) {
        const auto locate = [this, name, entry] {
            // Resolve the identity from the current validated directory at each
            // poll and again before dispatch; never retain a delegate index.
            const auto rows = directory().value("summaries").toList();
            if (entry && (rows.size() != 1 || rows.front().toMap().value("summary_id") != fixtureId))
                return static_cast<QQuickItem *>(nullptr);
            return item(entry ? "summaryDirectoryEntry-" + rows.front().toMap().value("summary_id").toString() : name, true);
        };
        const auto elapsed = [this] { return clock.elapsed() >= 20000 ? qint64(4000) : clock.elapsed() - at; };
        require(elapsed() < 4000, "SUMMARY_VIEW_INPUT_DEADLINE");
        QPointer<QQuickItem> wholeTarget = locate();
        const auto wholeReveal = NativeControlReadiness::revealWholeItem(wholeTarget, elapsed, 4000);
        observed["inputWholeReveal"] = QVariantMap{{"step", step}, {"targetFound", !wholeTarget.isNull()},
            {"frameSerial", QVariant::fromValue(frame)}, {"reveal", numericMetadata(wholeReveal)}};
        require(!wholeReveal.value("expired").toBool() && elapsed() < 4000, "SUMMARY_VIEW_INPUT_DEADLINE");
        if (!wholeTarget || !actualBool(wholeReveal, "geometryValid", true) || locate() != wholeTarget) {
            stable.reset(); w->update(); return false;
        }
        Action action{name, locate,
            [this, name](QQuickItem *control) {
                return stable.observe(inspect(control, name == "nav-memory" ? closed() : opened()), clock.elapsed() - at, frame);
            }, [this, name, locate, before, after, entry, wholeTarget, wholeReveal](QQuickItem *control) {
                require(clock.elapsed() - at < 4000 && clock.elapsed() < 20000, "SUMMARY_VIEW_INPUT_DEADLINE");
                const auto fresh = inspect(control, name == "nav-memory" ? closed() : opened());
                require(locate() == control && stable.matches(fresh), "SUMMARY_VIEW_INPUT_TARGET_CHANGED");
                if (entry) require(control->property("summaryId").toString() == fixtureId, "SUMMARY_VIEW_ENTRY_ID_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, control);
                observed["lastInputHit"] = hit.metadata();
                require(hit.accepted(), "SUMMARY_VIEW_INPUT_HIT", hit.metadata());
                const auto gateActions = gate.metadata().value("actions").toList();
                const auto reveal = gateActions.value(0).toMap().value("last").toMap().value("reveal").toMap();
                require(actualBool(reveal, "expired", false) && actualBool(reveal, "geometryValid", true),
                        "SUMMARY_VIEW_INPUT_REVEAL_UNCONFIRMED", reveal);
                require(wholeTarget && wholeTarget == control && actualBool(wholeReveal, "expired", false) &&
                        actualBool(wholeReveal, "geometryValid", true),
                        "SUMMARY_VIEW_INPUT_REVEAL_UNCONFIRMED", wholeReveal);
                QSignalSpy clicked(control, SIGNAL(clicked()));
                QSignalSpy toggled(control, SIGNAL(toggled()));
                require(clicked.isValid(), "SUMMARY_VIEW_SIGNAL_OBSERVER");
                if (before) before();
                require(clock.elapsed() - at < 4000 && clock.elapsed() < 20000, "SUMMARY_VIEW_INPUT_DEADLINE");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                const auto kind = name.startsWith("memoryTab-") ? NativeCheck::ControlKind::Tab : NativeCheck::ControlKind::Button;
                const NativeCheck::InputSignals counts{clicked.isValid(), 1, clicked.count(),
                    toggled.isValid() ? std::optional<qint64>(toggled.count()) : std::nullopt};
                auto signalMetadata = NativeCheck::describeSignals(kind, counts);
                signalMetadata["clickedObserverValid"] = clicked.isValid();
                require(NativeCheck::inputContractFailure(kind, counts).isEmpty(), "SUMMARY_VIEW_INPUT_SIGNAL", signalMetadata);
                inputs.append(QVariantMap{{"step", step}, {"control", control->objectName()},
                    {"summaryId", entry ? fixtureId : QString()}, {"source", "QSignalSpy"},
                    {"signals", signalMetadata}, {"reveal", reveal}, {"wholeReveal", numericMetadata(wholeReveal)},
                    {"layout", stable.metadata()}, {"hit", hit.metadata()}});
                if (after) after();
            }};
        // Whole-item reveal above and the unchanged gate's revealCenter use
        // the original step clock. The gate still owns fresh inspection,
        // cross-frame stability, hit validation and exactly one mouse input.
        const auto result = gate.poll(elapsed, 4000, {action});
        require(result != NativeControlReadiness::SequentialGate::Expired && result != NativeControlReadiness::SequentialGate::Failed,
                "SUMMARY_VIEW_INPUT_UNAVAILABLE", gate.metadata());
        w->update();
        return result == NativeControlReadiness::SequentialGate::Performed;
    }
    void originalPreserved(const QString &phase) {
        const bool messageMatch = s->messages() == messages && messages.size() == 39;
        const bool chatMatch = s->draft() == draft;
        const bool archiveMatch = archiveDraft() == initialArchive;
        const bool formMatch = uiDraft() == initialUiDraft;
        const bool recallMatch = s->memoryRecallState() == initialRecall;
        const bool settingsMatch = s->state().value("settings").toMap() == initialSettings &&
            s->state().value("permissions").toMap() == initialPermissions;
        observed[phase + "Preservation"] = QVariantMap{{"messageCount", s->messages().size()}, {"messageIdsMatch", messageMatch},
            {"chatDraftMatches", chatMatch}, {"archiveDraftMatches", archiveMatch}, {"profileAndFormDraftsMatch", formMatch},
            {"archiveDirty", e->dirty()}, {"archiveRevision", e->revision()},
            {"profileDirty", item("memoryTasks") ? item("memoryTasks")->property("profileDirty") : QVariant{}},
            {"recallMatches", recallMatch}, {"settingsAndPermissionsMatch", settingsMatch}};
        require(messageMatch && chatMatch && archiveMatch && formMatch && recallMatch && settingsMatch,
                "SUMMARY_VIEW_ORIGINAL_STATE_CHANGED", observed.value(phase + "Preservation").toMap());
    }
    void managementPreserved() {
        const auto current = list();
        const bool listMatch = current == managementList;
        const bool feedbackMatch = s->memoryFeedback() == managementFeedback;
        const bool candidatesMatch = s->state().value("candidates").toMap() == managementCandidates;
        const bool pagingMatch = s->memoryPagingFingerprint() == pagingFingerprint && s->memoryQuery() == filter;
        observed.insert({{"managementStateMatches", listMatch}, {"managementFeedbackMatches", feedbackMatch},
            {"managementCandidatesMatch", candidatesMatch}, {"managementPagingMatches", pagingMatch}});
        require(listMatch && feedbackMatch && candidatesMatch && pagingMatch, "SUMMARY_VIEW_MANAGEMENT_CHANGED");
        originalPreserved("final");
    }
    void readAccess() {
        const auto value = directory();
        const auto *tasks = item("memoryTasks");
        require(actualBool(value, "ok", true) && actualBool(value, "enabled", false) && actualBool(value, "authorized", false) &&
                value.value("status") == "disabled" && tasks && tasks->property("summaryReadAllowed").toBool(),
                "SUMMARY_VIEW_READ_ACCESS_OR_CONSENT", {{"ok", value.value("ok")}, {"enabled", value.value("enabled")},
                {"authorized", value.value("authorized")}, {"status", value.value("status")}});
        observed.insert({{"enabled", value.value("enabled")}, {"authorized", value.value("authorized")}, {"readAllowed", true}});
    }
    void validateDirectory() {
        const auto value = directory();
        const auto rows = value.value("summaries").toList();
        const auto *tasks = item("memoryTasks");
        require(actualBool(value, "directoryReady", true) && value.value("conversation_id") == "dream-room" &&
                rows.size() == 1 && value.value("summaryTotal").toInt() == 1 && actualBool(value, "hasMore", false) &&
                rows.front().toMap().value("summary_id") == fixtureId && tasks && tasks->property("summaryDirectoryValid").toBool(),
                "SUMMARY_VIEW_DIRECTORY_INVALID", {{"count", rows.size()}, {"total", value.value("summaryTotal")},
                {"hasMore", value.value("hasMore")}, {"directoryReady", value.value("directoryReady")}});
        const auto row = rows.front().toMap();
        require(!row.contains("text") && !row.contains("body"), "SUMMARY_VIEW_DIRECTORY_LEAKED_BODY");
        const auto sourceIds = row.value("messageIds").toStringList();
        const auto messageIds = ids(messages);
        require(!sourceIds.isEmpty(), "SUMMARY_VIEW_SOURCE_IDS_EMPTY");
        for (const auto &id : sourceIds) require(messageIds.contains(id), "SUMMARY_VIEW_SOURCE_MESSAGE_MISSING", {{"id", id}});
        readAccess();
        observed.insert({{"fixtureSummaryId", fixtureId}, {"directoryCount", rows.size()}, {"directoryTotal", value.value("summaryTotal")},
            {"directoryHasMore", value.value("hasMore")}, {"directoryValidated", true}});
    }
    bool visibleBody(bool narrow) {
        const auto diagnosticKey = narrow ? QString("narrowBodyDiagnostic") : QString("bodyDiagnostic");
        auto diagnostic = observed.value(diagnosticKey).toMap();
        // A terminal poll retains the last measured geometry with its own
        // timestamp, while marking that no fresh reads were admitted.
        diagnostic.insert({{"polls", diagnostic.value("polls").toInt() + 1}, {"step", step},
            {"stepElapsedMs", clock.elapsed() - at}, {"segmentElapsedMs", clock.elapsed()},
            {"frameSerial", QVariant::fromValue(frame)}, {"lookupUpdated", false},
            {"revealUpdated", false}, {"observationUpdated", false},
            {"stepDeadlineReached", clock.elapsed() - at >= 4000},
            {"segmentDeadlineReached", clock.elapsed() >= 20000}});
        // Reason codes: 0 unmeasured, 1/2 body/wrapper not unique, 3 unbound,
        // 4 invalid geometry, 5 clipped integer point, 6 control not ready,
        // 7 whole rectangle clipped, 8 awaiting stable frame, 9 ready, 10 deadline,
        // 11 target replaced or no longer visible after reveal.
        diagnostic["eligibilityReasonCode"] = 10;
        observed[diagnosticKey] = diagnostic;
        require(clock.elapsed() - at < 4000 && clock.elapsed() < 20000, "SUMMARY_VIEW_BODY_VISIBILITY_DEADLINE");
        diagnostic.insert({{"windowWidth", w->width()}, {"windowHeight", w->height()}});
        const auto bodyMatch = matchItem("summaryDetailText", true);
        const auto wrapperMatch = matchItem("summaryReadSection", true);
        QPointer<QQuickItem> body = bodyMatch.item, wrapper = wrapperMatch.item;
        diagnostic.insert({{"bodyLookupMatches", bodyMatch.matches}, {"wrapperLookupMatches", wrapperMatch.matches},
            {"bodyFound", !body.isNull()}, {"wrapperFound", !wrapper.isNull()}, {"lookupUpdated", true},
            {"lookupStepElapsedMs", clock.elapsed() - at}});
        observed[diagnosticKey] = diagnostic;
        if (!body || !wrapper) {
            stable.reset();
            diagnostic["eligibilityReasonCode"] = !body ? 1 : 2;
            diagnostic["stable"] = numericMetadata(stable.metadata());
            observed[diagnosticKey] = diagnostic;
            w->update(); return false;
        }
        const auto reveal = NativeControlReadiness::revealWholeItem(body,
            [this] { return clock.elapsed() >= 20000 ? qint64(4000) : clock.elapsed() - at; }, 4000);
        diagnostic.insert({{"reveal", numericMetadata(reveal)}, {"revealUpdated", true},
            {"revealStepElapsedMs", clock.elapsed() - at}, {"stepDeadlineReached", clock.elapsed() - at >= 4000},
            {"segmentDeadlineReached", clock.elapsed() >= 20000}});
        observed[diagnosticKey] = diagnostic;
        require(!reveal.value("expired").toBool(), "SUMMARY_VIEW_BODY_REVEAL_DEADLINE");
        require(clock.elapsed() - at < 4000 && clock.elapsed() < 20000, "SUMMARY_VIEW_BODY_VISIBILITY_DEADLINE");
        // A contentYChanged handler may replace a delegate synchronously.
        if (!body || !wrapper || item("summaryDetailText", true) != body || item("summaryReadSection", true) != wrapper) {
            stable.reset(); diagnostic["eligibilityReasonCode"] = 11;
            diagnostic["targetChangedDuringReveal"] = true;
            observed[diagnosticKey] = diagnostic; w->update(); return false;
        }
        const auto observation = inspect(body, opened());
        const auto ready = stable.observe(observation, clock.elapsed() - at, frame);
        const auto &state = observation.state;
        diagnostic.insert({{"observation", numericMetadata(state)}, {"stable", numericMetadata(stable.metadata())},
            {"observationUpdated", true}, {"observationStepElapsedMs", clock.elapsed() - at},
            {"targetChangedDuringReveal", false},
            {"eligibilityReasonCode", !state.value("bound").toBool() ? 3
                : !state.value("geometryValid").toBool() ? 4 : !state.value("integerPointInsideClip").toBool() ? 5
                : !state.value("fullyVisible").toBool() ? 7 : !observation.eligible ? 6
                : !ready.value("ready").toBool() ? 8 : 9}});
        observed[diagnosticKey] = diagnostic;
        if (!ready.value("ready").toBool()) { w->update(); return false; }
        require(clock.elapsed() - at < 4000 && clock.elapsed() < 20000, "SUMMARY_VIEW_BODY_VISIBILITY_DEADLINE");
        const auto rect = body->mapRectToScene(QRectF(QPointF(), body->size()));
        const auto bounds = wrapper->mapRectToScene(QRectF(QPointF(), wrapper->size()));
        const bool fits = std::isfinite(rect.width()) && rect.width() > 1 && rect.left() >= bounds.left() - .5 &&
            rect.right() <= bounds.right() + .5 && rect.left() >= -.5 && rect.right() <= w->width() + .5;
        const bool plain = body->property("textFormat").toInt() == Qt::PlainText;
        const bool readonly = actualBool({{"readOnly", body->property("readOnly")}}, "readOnly", true);
        const bool matches = body->property("text").toString() == fixtureBody;
        require(fits && plain && readonly && matches, "SUMMARY_VIEW_BODY_PRESENTATION_INVALID",
                {{"widthFits", fits}, {"plainText", plain}, {"readOnly", readonly}, {"bodyMatches", matches},
                 {"bodyWidth", rect.width()}, {"wrapperWidth", bounds.width()}});
        const auto key = narrow ? QString("narrowBody") : QString("body");
        observed[key + "Visible"] = true; observed[key + "WidthFits"] = fits;
        observed[key + "Width"] = rect.width(); observed[key + "WrapperWidth"] = bounds.width();
        observed[key + "PlainText"] = plain; observed[key + "ReadOnly"] = readonly;
        observed[key + "MatchesFixture"] = matches;
        observed[key + "WindowWidth"] = w->width(); observed[key + "WindowHeight"] = w->height();
        const auto capture = w->grabWindow();
        require(capture.save(prefix + (narrow ? ".summary-view-narrow.png" : ".summary-view-body.png")), "SUMMARY_VIEW_SCREENSHOT_FAILED");
        return true;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        if (step == 9 || step == 10) {
            const auto key = step == 10 ? QString("narrowBodyDiagnostic") : QString("bodyDiagnostic");
            auto diagnostic = observed.value(key).toMap();
            diagnostic.insert({{"terminalStepElapsedMs", clock.elapsed() - at}, {"terminalSegmentElapsedMs", clock.elapsed()},
                {"terminalFrameSerial", QVariant::fromValue(frame)}, {"terminalStepDeadlineReached", clock.elapsed() - at >= 4000},
                {"terminalSegmentDeadlineReached", clock.elapsed() >= 20000}});
            observed[key] = diagnostic;
        }
        if (w->size() != QSize(1380, 900)) w->resize(1380, 900);
        observed.insert({{"scope", scope}, {"generation", generation}, {"sourceMemoryIds", source127},
            {"beforeOpeningMemoryIds", beforeOpeningIds}, {"finalMemoryIds", ids(list().value("memories").toList())},
            {"directoryRequestId", directoryId}, {"detailRequestId", detailId},
            {"directoryResponseCount", directoryResponses}, {"detailResponseCount", detailResponses},
            {"otherResponseCount", otherResponses}, {"rawDirectory", rawDirectory}, {"rawDetail", rawDetail},
            {"openingReads", openingReads}, {"segmentCommandDelta", baselineCommands < 0 ? QVariant{} : QVariant(commands() - baselineCommands)}});
        auto callback = std::move(done);
        if (callback) callback({{"schema", "reverie.qt.summary-view.v1"}, {"passed", passed}, {"error", error},
            {"cycle", restart ? 2 : 1}, {"step", step}, {"elapsedMs", clock.elapsed()}, {"deadlineMs", 20000},
            {"inputDeadlineMs", 4000}, {"readDeadlineMs", 10000}, {"closeDeadlineMs", 4000},
            {"checks", checks}, {"inputs", inputs}, {"inputCurrent", gate.metadata()}, {"observed", observed}, {"contentCollected", false}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < 20000 && s->scopeKey() == scope && s->generation() == generation,
                "SUMMARY_VIEW_DEADLINE_OR_SCOPE_CHANGED");
        if (closeAt >= 0) require(clock.elapsed() - closeAt < 4000, "SUMMARY_VIEW_CLOSE_DEADLINE");
        if (step == 0) {
            require(source127.size() == 127 && QSet<QString>(source127.begin(), source127.end()).size() == 127 &&
                    (beforeOpeningIds == source127 || beforeOpeningIds == source127.mid(0, 100)), "SUMMARY_VIEW_SOURCE_BASELINE_INVALID",
                    {{"sourceCount", source127.size()}, {"shownCount", beforeOpeningIds.size()}});
            require(detailEmpty(), "SUMMARY_VIEW_INITIAL_DETAIL_PERSISTED");
            observed.insert({{"initialDetailIdle", true}, {"initialDetailEmpty", true}, {"initialBodyCharacters", 0},
                {"initialArchiveDirty", e->dirty()}, {"initialArchiveRevision", e->revision()},
                {"initialProfileDirty", initialUiDraft.value("profileDirty")}, {"beforeOpeningMessageIds", ids(messages)}});
            record("initial-detail-idle-empty"); next(1); return;
        }
        if (step == 1) { if (press("nav-memory")) next(2); return; }
        if (step == 2) { if (press("archive-open-memories")) next(3); return; }
        if (step == 3) { if (press("memoryTab-summary")) next(4); return; }
        if (step == 4) {
            require(clock.elapsed() - at < 10000, "SUMMARY_VIEW_OPENING_READ_DEADLINE");
            if (!pending().isEmpty()) return;
            // These are the existing reads caused by entering the page. They
            // are observed before the two-request viewing baseline, rather
            // than misreported as a zero-command opening operation.
            const QStringList openingReadCommands{"archive:get", "memory:list", "memory:candidates:list", "summary:status", "user:profile:get"};
            require(!lastOpeningDirectoryId.isEmpty(), "SUMMARY_VIEW_OPENING_DIRECTORY_RECEIPT_MISSING");
            for (const auto &value : openingReads) {
                const auto response = value.toMap();
                require(openingReadCommands.contains(response.value("command").toString()) &&
                        response.value("generation").toInt() == generation, "SUMMARY_VIEW_OPENING_NON_READ_RESPONSE", response);
            }
            require(opened() && item("memoryTabs") && item("memoryTabs")->property("currentIndex").toInt() == 1,
                    "SUMMARY_VIEW_TAB_NOT_SELECTED");
            if (!observeCandidateHeader("summary-tab-hidden", false)) return;
            validateDirectory();
            require(detailEmpty(), "SUMMARY_VIEW_OPENING_READ_FILLED_DETAIL");
            originalPreserved("afterOpening");
            const auto currentIds = ids(list().value("memories").toList());
            require(currentIds == source127.mid(0, 100) && actualBool(list(), "hasMore", true),
                    "SUMMARY_VIEW_OPENING_FIRST_PAGE_CHANGED", {{"count", currentIds.size()}, {"hasMore", list().value("hasMore")}});
            managementList = list(); managementFeedback = s->memoryFeedback();
            managementCandidates = s->state().value("candidates").toMap();
            pagingFingerprint = s->memoryPagingFingerprint();
            baselineCommands = commands(); baselineReady = true;
            observed.insert({{"openingCommandDelta", commands() - startCommands}, {"afterOpeningMemoryIds", currentIds},
                {"afterOpeningMessageIds", ids(s->messages())}, {"directoryBeforeRequestId", lastOpeningDirectoryId},
                {"directoryBefore", directorySnapshot(directory())}, {"afterOpeningDetailIdle", true}, {"afterOpeningDetailEmpty", true}});
            record("opened-current-directory-read-access"); next(5); return;
        }
        if (step == 5) {
            if (press("summaryDirectoryRefresh", [this] {
                    require(pending().isEmpty() && !directoryArmed && detailEmpty(), "SUMMARY_VIEW_DIRECTORY_PRECONDITION");
                    directoryArmed = true;
                }, [this] {
                    directoryId = ownPending("summary:status");
                    if (directoryId.isEmpty()) directoryId = rawDirectory.value("requestId").toString();
                    require(!directoryId.isEmpty() && directoryId != lastOpeningDirectoryId && commands() == baselineCommands + 1,
                            "SUMMARY_VIEW_DIRECTORY_REQUEST_NOT_UNIQUE");
                    observed["directoryCommandDelta"] = 1;
                })) next(6);
            return;
        }
        if (step == 6) {
            require(clock.elapsed() - at < 10000, "SUMMARY_VIEW_DIRECTORY_READ_DEADLINE");
            if (directoryResponses == 0 || !pending().isEmpty()) return;
            validateDirectory();
            require(directoryResponses == 1 && rawDirectory.value("requestId") == directoryId && rawDirectory.value("generation").toInt() == generation &&
                    rawDirectory.value("scope") == scope && receiptScopeMatches(rawDirectory, scope) &&
                    actualBool(rawDirectory, "ok", true) && rawDirectory.value("operation") == "status" &&
                    actualBool(rawDirectory, "bodyFieldPresent", false) && directoryRow == directory().value("summaries").toList().front().toMap() &&
                    detailEmpty(), "SUMMARY_VIEW_DIRECTORY_RESPONSE_CORRELATION", rawDirectory);
            observed["directoryAfter"] = directorySnapshot(directory());
            require(observed.value("directoryBefore") == observed.value("directoryAfter"), "SUMMARY_VIEW_DIRECTORY_CHANGED_ON_REFRESH");
            managementPreserved();
            record("fresh-directory-refresh-metadata-only"); next(7); return;
        }
        if (step == 7) {
            if (press("summaryDirectoryEntry-" + fixtureId, [this] {
                    validateDirectory();
                    require(!detailArmed && detailEmpty() && pending().isEmpty(), "SUMMARY_VIEW_DETAIL_PRECONDITION");
                    detailArmed = true;
                }, [this] {
                    detailId = s->summaryDetailState().value("requestId").toString();
                    require(!detailId.isEmpty() && detailId != directoryId && commands() == baselineCommands + 2,
                            "SUMMARY_VIEW_DETAIL_REQUEST_NOT_UNIQUE");
                    observed["detailCommandDelta"] = 1;
                }, true)) next(8);
            return;
        }
        if (step == 8) {
            require(clock.elapsed() - at < 10000, "SUMMARY_VIEW_DETAIL_READ_DEADLINE");
            if (detailResponses == 0 || s->summaryDetailState().value("status") == "pending") return;
            auto metadata = detailRow; metadata.remove("text");
            const auto detail = s->summaryDetailState();
            require(detailResponses == 1 && rawDetail.value("requestId") == detailId && rawDetail.value("generation").toInt() == generation &&
                    rawDetail.value("scope") == scope && receiptScopeMatches(rawDetail, scope) &&
                    actualBool(rawDetail, "ok", true) && rawDetail.value("operation") == "detail" &&
                    rawDetail.value("conversationId") == "dream-room" && metadata == directoryRow &&
                    actualBool(rawDetail, "bodyMatchesFixture", true) && detail.value("status") == "success" &&
                    detail.value("summaryId") == fixtureId && detail.value("requestId") == detailId && detail.value("text") == fixtureBody,
                    "SUMMARY_VIEW_DETAIL_RESPONSE_CORRELATION", rawDetail);
            readAccess(); managementPreserved();
            record("one-correlated-summary-detail-read"); next(9); return;
        }
        if (step == 9) {
            if (!visibleBody(false)) return;
            record("plain-readonly-visible-body");
            if (!restart) { w->resize(760, 650); next(10); }
            else { closeAt = clock.elapsed(); next(12); }
            return;
        }
        if (step == 10) {
            if (!visibleBody(true)) return;
            record("narrow-plain-readonly-body");
            w->resize(1380, 900); next(11); return;
        }
        if (step == 11) {
            require(clock.elapsed() - at < 4000, "SUMMARY_VIEW_RESTORE_LAYOUT_DEADLINE");
            if (w->size() != QSize(1380, 900)) return;
            closeAt = clock.elapsed(); next(12); return;
        }
        if (step == 12) {
            if (press("summaryDetailClear", [this] { clearCommands = commands(); })) next(13);
            return;
        }
        if (step == 13) {
            const auto *body = item("summaryDetailText");
            require(detailEmpty() && body && !body->isVisible() && body->property("text").toString().isEmpty() &&
                    commands() == clearCommands && pending().isEmpty(), "SUMMARY_VIEW_CLEAR_SENT_COMMAND_OR_RETAINED_BODY");
            observed.insert({{"clearCommandDelta", commands() - clearCommands}, {"clearIdle", true}, {"clearEmpty", true}});
            managementPreserved(); record("local-clear-zero-commands"); next(14); return;
        }
        if (step == 14) { if (press("memoryTab-memories")) next(15); return; }
        if (step == 15) {
            require(item("memoryTabs") && item("memoryTabs")->property("currentIndex").toInt() == 0 &&
                    item("memoryFilterField") && item("memoryFilterField")->property("text").toString() == filter && detailEmpty(),
                    "SUMMARY_VIEW_MANAGEMENT_NOT_RETURNED");
            if (!observeCandidateHeader("memory-tab-visible", true)) return;
            managementPreserved(); record("management-tab-returned"); next(16); return;
        }
        if (step == 16) { if (press("memory-close")) next(17); return; }
        if (step == 17) {
            if (!closed()) return;
            managementPreserved(); readAccess();
            require(clock.elapsed() < 20000 && clock.elapsed() - closeAt < 4000 && detailEmpty() &&
                    commands() == baselineCommands + 2 && directoryResponses == 1 && detailResponses == 1 &&
                    otherResponses == 0 && pending().isEmpty() && inputs.size() == 8,
                    "SUMMARY_VIEW_FINAL_COMMANDS_OR_INPUTS", {{"commandDelta", commands() - baselineCommands},
                    {"directoryResponses", directoryResponses}, {"detailResponses", detailResponses}, {"otherResponses", otherResponses}, {"inputs", inputs.size()}});
            observed.insert({{"noAiOrSettingsWrites", true}, {"finalMessageIds", ids(s->messages())}, {"surfaceClosed", closed()},
                {"finalTabIndex", item("memoryTabs") ? item("memoryTabs")->property("currentIndex") : QVariant{}},
                {"finalWindowWidth", w->width()}, {"finalWindowHeight", w->height()},
                {"finalDetailIdle", s->summaryDetailState().value("status") == "idle"},
                {"finalDetailEmpty", detailEmpty()}, {"finalPendingCount", pending().size()}});
            record("closed-preserves-snapshots"); finish(true);
        }
    }
};
}
namespace SummaryViewCheck {
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool restart,
         const QStringList &source127Ids, const QString &capturePrefix, std::function<void(QVariantMap)> completion) {
    new Check(window, session, editor, restart, source127Ids, capturePrefix, std::move(completion));
}
}
