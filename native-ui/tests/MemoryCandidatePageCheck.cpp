#include "MemoryCandidatePageCheck.h"
#include "MemoryPageCheck.h"
#include "MemoryActionProbe.h"
#include "CandidateHeaderProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QJsonArray>
#include <QJsonDocument>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QSet>
#include <QTest>
#include <QTimer>

namespace {
const QString ordinaryCandidate = "隔离候选：待拒绝的星图";
QQuickItem *find(QQuickItem *root, const QString &name, bool visible = true) {
    if (!root) return nullptr;
    if (root->objectName() == name && (!visible || root->isVisible())) return root;
    for (auto *child : root->childItems())
        if (auto *found = find(child, name, visible)) return found;
    return nullptr;
}
QStringList values(const QVariantList &rows, const QString &key) {
    QStringList result;
    for (const auto &row : rows) result.append(row.toMap().value(key).toString());
    return result;
}
QString digest(const QStringList &ids) {
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(QJsonArray::fromStringList(ids)).toJson(QJsonDocument::Compact),
        QCryptographicHash::Sha256).toHex());
}
QStringList confirmedTexts() {
    QStringList result;
    for (int n = 130; n >= 1; --n) result.append(MemoryPageCheck::seededText(n));
    return result;
}
QStringList candidateTexts(int highest, int lowest, bool ordinary = false) {
    QStringList result;
    if (ordinary) result.append(ordinaryCandidate);
    for (int n = highest; n >= lowest; --n) result.append(MemoryCandidatePageCheck::seededText(n));
    return result;
}
class Check final : public QObject {
  public:
    using Action = NativeControlReadiness::SequentialGate::Action;
    struct RowAction {
        QString name, id, control, verb;
        int step = 0, clicks = 0;
        qint64 at = 0, elapsedMs = -1;
        bool performed = false, complete = false;
        MemoryActionProbe::LayoutGate layout;
        MemoryActionProbe::BoundedDiagnostic diagnostic;
        QVariantMap receipt;
    };
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false;
    QString scope, draft, archiveContent, listRead, candidateRead, firstStart, tailStart, capturePrefix;
    QString confirmId, rejectId, committedId;
    QStringList initialMessageIds, baselineIds, firstCandidateIds, tailCandidateIds, frozenIds;
    QMap<QString, QString> candidateIds;
    int initialRevision, generation, step = 0, actionResponses = 0;
    bool initialDirty;
    qint64 at = 0;
    quint64 frameSerial = 0;
    QTimer timer;
    QElapsedTimer clock;
    NativeControlReadiness::SequentialGate inputGate;
    MemoryActionProbe::ReceiptTracker tracker;
    std::vector<RowAction> rowActions;
    int currentRow = -1;
    QVariantList cases, inputMetadata;
    QVariantMap observed, initialUiDraft;
    std::function<void(QVariantMap)> done;

    Check(QQuickWindow *window, RuntimeBridge *bridge, ArchiveEditor *editor, bool verify, QString prefix,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(bridge), e(editor), restart(verify), scope(bridge->scopeKey()),
          draft(bridge->draft()), archiveContent(editor->content()),
          initialMessageIds(values(bridge->messages(), "id")), initialRevision(editor->revision()), generation(bridge->generation()),
          initialDirty(editor->dirty()), done(std::move(callback)) {
        capturePrefix = std::move(prefix);
        observed.insert({{"scope", scope}, {"generation", generation}});
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frameSerial; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::changed, this, [this] { observeReceipt(); });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &, const QString &command, const QVariantMap &, int) {
                if (command == "memory:candidates:confirm" || command == "memory:candidates:reject" || command == "memory:delete")
                    ++actionResponses;
            });
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing) return;
            executing = true;
            try { tick(); }
            catch (const std::exception &error) { finish(false, error.what()); }
            executing = false;
        });
        timer.start();
    }
    int deadline() const { return restart ? 20000 : 45000; }
    void require(bool value, const QString &error) const {
        if (!value) throw std::runtime_error(error.toStdString());
    }
    CandidateHeaderProbe::StableRead headerStable;
    void next(int target) { step = target; at = clock.elapsed(); inputGate.resetForNextStep(); headerStable.reset(); }
    QQuickItem *item(const QString &name, bool visible = true) const { return find(w->contentItem(), name, visible); }
    QVariantMap receipt(const QString &key) const { return s->memoryFeedback().value(key).toMap(); }
    QVariantMap page() const { return s->memoryCandidatePage(); }
    QVariantMap diagnostic() const { return s->diagnostics().value("candidatePaging").toMap(); }
    QVariantList candidates() const { return s->state().value("candidates").toMap().value("candidates").toList(); }
    QVariantList memories() const { return s->state().value("memory").toMap().value("memories").toList(); }
    QString text(const QString &name) const { auto *control = item(name); return control ? control->property("text").toString() : QString(); }
    bool opened() const { const auto *surface = item("drawer-memory"); return surface && surface->property("inputReady").toBool(); }
    bool closed() const {
        for (const auto *name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            const auto *surface = item(name, false);
            if (surface && surface->property("progress").toDouble() > 0) return false;
        }
        return true;
    }
    bool settled() const {
        return receipt("list").value("status") == "success" && receipt("candidates").value("status") == "success" &&
               receipt("action").value("status") != "pending" && !page().value("busy").toBool();
    }
    bool readReady() const {
        require(clock.elapsed() - at < 10000, "CANDIDATE_PAGE_READ_DEADLINE");
        return settled();
    }
    QVariantMap uiDraft() const {
        QVariantMap result;
        for (const auto *name : {"memoryFilterField", "profileName", "profileNickname", "profileBirthday", "profileSchedule",
                                 "profileIdentity", "profileInterests", "profileHobbies", "profileTopics"}) {
            const auto *control = item(name, false);
            result[name] = control ? control->property("text") : QVariant();
        }
        if (const auto *tasks = item("memoryTasks", false))
            for (const auto *name : {"editingMemoryId", "deletingMemoryId", "profileDirty", "profileEditRevision",
                                     "profileSavingRevision", "profileSaveRequestId"}) result[name] = tasks->property(name);
        return result;
    }
    void capture(const QString &suffix) {
        require(clock.elapsed() < deadline(), "CANDIDATE_PAGE_TIMEOUT");
        require(w->grabWindow().save(capturePrefix + suffix), "CANDIDATE_PAGE_CAPTURE_WRITE_FAILED");
        require(clock.elapsed() < deadline(), "CANDIDATE_PAGE_TIMEOUT");
    }
    void inputTime() const {
        require(clock.elapsed() < deadline(), "CANDIDATE_PAGE_TIMEOUT");
        require(clock.elapsed() - at < 4000, "CANDIDATE_PAGE_INPUT_DEADLINE");
    }
    void click(QQuickItem *control) {
        inputTime();
        require(control && control->isEnabled(), "CANDIDATE_PAGE_CONTROL_UNAVAILABLE");
        const auto center = control->mapToScene(QPointF(control->width() / 2, control->height() / 2)).toPoint();
        inputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, center, 0);
    }
    bool press(const QString &name, const QStringList &readKeys = {},
               const std::function<void(const QVariantMap &)> &after = {}) {
        Action action{name, [this, name] { return item(name, false); },
            [this, name](QQuickItem *control) {
                const bool surface = name == "nav-memory" ? closed() : opened();
                return NativeControlReadiness::snapshot(control, w, surface);
            }, [this, after, readKeys](QQuickItem *control) {
                QVariantMap previousReads;
                for (const auto &key : readKeys) previousReads[key] = receipt(key).value("requestId").toString();
                // QTest::mouseClick processes events, so this click's own fast
                // read can be successful before control returns to this code.
                click(control);
                if (after) after(previousReads);
            }};
        const auto result = inputGate.poll([this] { return clock.elapsed() >= deadline() ? qint64(4000) : clock.elapsed() - at; },
                                           4000, {action});
        require(result != NativeControlReadiness::SequentialGate::Expired, "CANDIDATE_PAGE_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "CANDIDATE_PAGE_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) return false;
        inputMetadata.append(QVariantMap{{"step", step}, {"control", name}, {"qualification", inputGate.metadata()}});
        return true;
    }
    void ownRead(const QString &key, QString &destination, const QString &previousRead) {
        const auto value = receipt(key);
        destination = value.value("requestId").toString();
        const auto status = value.value("status").toString();
        require(!destination.isEmpty() && destination != previousRead && (status == "pending" || status == "success"),
                "CANDIDATE_PAGE_OWN_READ_NOT_SENT");
    }
    void uniqueIds(const QStringList &ids, int count) const {
        require(ids.size() == count && !ids.contains(QString()) && QSet<QString>(ids.begin(), ids.end()).size() == count,
                "CANDIDATE_PAGE_ID_COUNT_OR_DUPLICATE");
    }
    void requireCandidates(const QStringList &expected, int number, bool more) {
        const auto rows = candidates();
        require(values(rows, "proposed_text") == expected, "CANDIDATE_PAGE_ROWS_UNEXPECTED");
        uniqueIds(values(rows, "id"), expected.size());
        const auto state = page();
        require(state.value("pageNumber").toInt() == number && state.value("count").toInt() == expected.size() &&
                    state.value("hasMore").toBool() == more && state.value("live").toBool() &&
                    !state.value("busy").toBool() && !state.value("needsRefresh").toBool() && !state.value("blocked").toBool(),
                "CANDIDATE_PAGE_STATE_UNEXPECTED");
        require(!text("memoryCandidatePageInfo").isEmpty() &&
                    text("memoryCandidateFeedback") == receipt("candidates").value("text").toString(),
                "CANDIDATE_PAGE_RECEIPT_NOT_SHOWN");
        for (const auto &value : rows) {
            const auto row = value.toMap();
            const auto proposed = row.value("proposed_text").toString(), id = row.value("id").toString();
            if (candidateIds.contains(proposed)) require(candidateIds.value(proposed) == id, "CANDIDATE_PAGE_ID_CHANGED");
            candidateIds[proposed] = id;
        }
    }
    bool observePageRead(const QString &phase) {
        auto reads = observed.value("pageReads").toList();
        require(reads.size() < 6, "CANDIDATE_PAGE_READ_METADATA_LIMIT");
        const auto current = page(), details = diagnostic(), feedback = receipt("candidates");
        require(s->generation() == generation, "CANDIDATE_PAGE_HEADER_GENERATION_CHANGED");
        const auto feedbackId = feedback.value("requestId").toString();
        static const QRegularExpression requestId("\\A[A-Za-z0-9_-]{8,128}\\z");
        static const QRegularExpression sha256("\\A[a-f0-9]{64}\\z");
        require(feedback.value("status") == "success" && requestId.match(feedbackId).hasMatch() &&
                    details.value("readRequestId").toString() == feedbackId,
                "CANDIDATE_PAGE_READ_METADATA_REQUEST_MISMATCH");
        QVariantMap entry{{"phase", phase}, {"pageNumber", current.value("pageNumber").toInt()},
            {"count", current.value("count").toInt()}, {"feedbackRequestId", feedbackId},
            {"readRequestId", details.value("readRequestId").toString()},
            {"readKind", details.value("readKind").toString()}};
        auto header = CandidateHeaderProbe::inspect(w, current, candidates().size(), feedbackId,
                                                          scope, s->generation(), frameSerial);
        observed["lastCandidateHeader"] = header;
        const auto settled = headerStable.poll(header, true, clock.elapsed() - at, 10000);
        observed["candidateHeaderAcquisition"] = headerStable.evidence();
        require(settled != CandidateHeaderProbe::StableRead::Expired && settled != CandidateHeaderProbe::StableRead::Failed,
                "CANDIDATE_PAGE_HEADER_TEXT_OR_GEOMETRY");
        if (settled != CandidateHeaderProbe::StableRead::Ready) { w->update(); return false; }
        header["settling"] = headerStable.evidence();
        entry["header"] = header;
        for (const auto *key : {"currentStartCursorDigest", "readStartCursorDigest", "nextCursorDigest"}) {
            const auto digest = details.value(key).toString();
            require(sha256.match(digest).hasMatch(), "CANDIDATE_PAGE_READ_METADATA_DIGEST_INVALID");
            entry[key] = digest;
        }
        reads.append(entry);
        observed["pageReads"] = reads;
        observed["pageReadLimit"] = 6;
        return true;
    }
    void requireConfirmed(const QStringList &expected) {
        require(values(memories(), "text") == expected, "CANDIDATE_PAGE_CONFIRMED_ROWS_UNEXPECTED");
        uniqueIds(values(memories(), "id"), expected.size());
        require(s->memoryQuery().isEmpty() && s->state().value("memory").toMap().value("query").toString().isEmpty(),
                "CANDIDATE_PAGE_CHANGED_CONFIRMED_FILTER");
    }
    MemoryActionProbe::Context context() const {
        MemoryActionProbe::Context result;
        result.scope = s->scopeKey();
        result.listId = receipt("list").value("requestId").toString();
        result.listStatus = receipt("list").value("status").toString();
        result.candidateReadId = receipt("candidates").value("requestId").toString();
        result.candidateStatus = receipt("candidates").value("status").toString();
        if (auto *tasks = item("memoryTasks", false)) {
            result.editingId = tasks->property("editingMemoryId").toString();
            result.deletingId = tasks->property("deletingMemoryId").toString();
        }
        result.surfaceReady = opened() && item("memoryPage") && !page().value("busy").toBool();
        return result;
    }
    MemoryActionProbe::Observation observation() const {
        const auto &action = rowActions[currentRow];
        return MemoryActionProbe::inspect(item("memoryPage"), w, action.id, action.control, context());
    }
    void observeReceipt() {
        if (tracker.armed() && currentRow >= 0 && !rowActions[currentRow].complete)
            tracker.observe(s->scopeKey(), receipt("action"), receipt("list"), receipt("candidates"));
    }
    bool rowPress(const QString &name, const QString &id, const QString &control, const QString &verb = {}) {
        if (currentRow < 0 || rowActions[currentRow].step != step) {
            RowAction record;
            record.name = name; record.id = id; record.control = control; record.verb = verb; record.step = step; record.at = at;
            currentRow = static_cast<int>(rowActions.size()); rowActions.push_back(std::move(record));
            tracker.reset();
        }
        auto &record = rowActions[currentRow];
        require(record.id == id && record.control == control, "CANDIDATE_PAGE_ROW_SEQUENCE_CHANGED");
        Action action{name, [this] {
                const auto &record = rowActions[currentRow];
                return MemoryActionProbe::rowControl(MemoryActionProbe::findRow(item("memoryPage"), record.id), record.control);
            }, [this](QQuickItem *target) {
                auto &record = rowActions[currentRow];
                const auto fresh = observation();
                auto state = record.layout.observe(fresh, clock.elapsed() - at, frameSerial);
                if (fresh.control.data() != target) state["ready"] = false;
                state["layout"] = record.layout.metadata();
                record.diagnostic.observe(state);
                return state;
            }, [this](QQuickItem *target) {
                auto &record = rowActions[currentRow];
                inputTime();
                auto fresh = observation();
                require(fresh.control.data() == target && record.layout.matches(fresh) && s->scopeKey() == scope,
                        "CANDIDATE_PAGE_STABLE_ROW_CHANGED");
                if (!record.verb.isEmpty()) {
                    require(tracker.arm(scope, record.verb, record.id, receipt("action").value("requestId").toString(),
                                        receipt("list").value("requestId").toString(), receipt("candidates").value("requestId").toString()),
                            "CANDIDATE_PAGE_RECEIPT_NOT_ARMED");
                }
                fresh = observation();
                inputTime();
                require(fresh.control.data() == target && record.layout.matches(fresh), "CANDIDATE_PAGE_STABLE_ROW_CHANGED");
                record.elapsedMs = clock.elapsed() - at;
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.center, 0);
                ++record.clicks; record.performed = true;
                observeReceipt();
                if (!record.verb.isEmpty()) require(!tracker.failed() && !tracker.requestId().isEmpty(),
                                                   "CANDIDATE_PAGE_ACTION_NOT_DISPATCHED");
                else record.complete = true;
            }};
        const auto result = inputGate.poll([this] { return clock.elapsed() >= deadline() ? qint64(4000) : clock.elapsed() - at; },
                                           4000, {action});
        require(result != NativeControlReadiness::SequentialGate::Expired, "CANDIDATE_PAGE_ROW_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "CANDIDATE_PAGE_ROW_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        if (record.verb.isEmpty()) {
            record.diagnostic.terminal(QVariantMap{{"layout", record.layout.metadata()}, {"sequence", inputGate.metadata()}});
        }
        return true;
    }
    bool actionReady(bool sameStart = true) {
        require(clock.elapsed() - at < 10000, "CANDIDATE_PAGE_ACTION_READ_DEADLINE");
        observeReceipt();
        require(!tracker.failed(), "CANDIDATE_PAGE_ACTION_RECEIPT_FAILED");
        if (!settled() || !tracker.complete()) return false;
        require(tracker.matchesComplete(scope, receipt("action"), receipt("list"), receipt("candidates")),
                "CANDIDATE_PAGE_ACTION_COMPLETION_CHANGED");
        auto &record = rowActions[currentRow];
        record.complete = true; record.receipt = tracker.metadata();
        record.diagnostic.terminal(QVariantMap{{"layout", record.layout.metadata()}, {"receipt", record.receipt}});
        require(receipt("action").value("subjectId") == record.id && receipt("action").value("verb") == record.verb,
                "CANDIDATE_PAGE_WRONG_ACTION_SUBJECT");
        require(!text("memoryActionFeedback").isEmpty() &&
                    text("memoryActionFeedback") == receipt("action").value("text").toString(),
                "CANDIDATE_PAGE_ACTION_RECEIPT_NOT_SHOWN");
        require(!sameStart || (diagnostic().value("currentStartCursorDigest") == tailStart &&
                    diagnostic().value("readStartCursorDigest") == tailStart),
                "CANDIDATE_PAGE_ACTION_CHANGED_START_CURSOR");
        return true;
    }
    void record(const QString &name) { cases.append(QVariantMap{{"name", name}, {"passed", true}}); }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        QVariantList actions;
        for (const auto &action : rowActions)
            actions.append(QVariantMap{{"name", action.name}, {"subjectId", action.id}, {"control", action.control},
                {"verb", action.verb}, {"step", action.step}, {"clickCount", action.clicks},
                {"inputElapsedMs", action.elapsedMs}, {"performed", action.performed}, {"complete", action.complete},
                {"receipt", action.receipt}, {"diagnostic", action.diagnostic.metadata()}});
        observed["actionResponseCount"] = actionResponses;
        auto callback = std::move(done);
        if (callback) callback({{"passed", passed}, {"error", error}, {"stage", restart ? 2 : 1},
            {"mode", restart ? "candidate-restart-readback" : "candidate-page-confirm-reject-delete"},
            {"step", step}, {"elapsedMs", clock.elapsed()}, {"deadlineMs", deadline()}, {"checks", cases},
            {"observed", observed}, {"actions", actions}, {"input", inputMetadata}, {"contentCollected", false}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < deadline(), "CANDIDATE_PAGE_TIMEOUT");
        require(s->scopeKey() == scope, "CANDIDATE_PAGE_SCOPE_CHANGED");
        if (step == 0) { if (press("nav-memory")) next(1); return; }
        if (step == 1) { if (press("archive-open-memories")) next(2); return; }
        if (step == 2) {
            if (!readReady() || !item("memoryPage")) return;
            require(item("memoryTabs", false)->property("currentIndex").toInt() == 0, "CANDIDATE_PAGE_WRONG_TAB");
            if (press("memoryRefresh", {"list", "candidates"}, [this](const QVariantMap &previous) {
                    ownRead("list", listRead, previous.value("list").toString());
                    ownRead("candidates", candidateRead, previous.value("candidates").toString());
                })) next(3);
            return;
        }
        if (step == 3) {
            if (!readReady()) return;
            require(receipt("list").value("requestId") == listRead && receipt("candidates").value("requestId") == candidateRead,
                    "CANDIDATE_PAGE_REFRESH_RECEIPT_MISMATCH");
            initialUiDraft = uiDraft();
            requireCandidates(restart ? candidateTexts(130, 31) : candidateTexts(130, 32, true), 1, true);
            if (!observePageRead("first")) return;
            firstCandidateIds = values(candidates(), "id"); firstStart = diagnostic().value("currentStartCursorDigest").toString();
            require(!firstStart.isEmpty(), "CANDIDATE_PAGE_FIRST_CURSOR_DIGEST_MISSING");
            if (!restart) requireConfirmed(confirmedTexts().mid(0, 100));
            record(restart ? "restart-candidate-first-page-reads-back-100" : "candidate-first-page-shows-newest-100");
            next(restart ? 6 : 4); return;
        }
        if (step == 4) {
            if (press("memoryLoadMore", {"list"}, [this](const QVariantMap &previous) {
                    ownRead("list", listRead, previous.value("list").toString());
                })) next(5);
            return;
        }
        if (step == 5) {
            if (!readReady()) return;
            require(receipt("list").value("requestId") == listRead, "CANDIDATE_PAGE_BASELINE_READ_MISMATCH");
            requireConfirmed(confirmedTexts()); baselineIds = values(memories(), "id"); next(6); return;
        }
        if (step == 6) {
            if (press("memoryCandidateNext", {"candidates"}, [this](const QVariantMap &previous) {
                    ownRead("candidates", candidateRead, previous.value("candidates").toString());
                })) next(7);
            return;
        }
        if (step == 7) {
            if (!readReady()) return;
            require(receipt("candidates").value("requestId") == candidateRead, "CANDIDATE_PAGE_NEXT_RECEIPT_MISMATCH");
            requireCandidates(restart ? candidateTexts(28, 1) : candidateTexts(31, 1), 2, false);
            if (!observePageRead("next")) return;
            tailCandidateIds = values(candidates(), "id"); tailStart = diagnostic().value("currentStartCursorDigest").toString();
            require(!tailStart.isEmpty() && tailStart != firstStart && diagnostic().value("readStartCursorDigest") == tailStart,
                    "CANDIDATE_PAGE_NEXT_START_CURSOR_MISMATCH");
            const auto combined = firstCandidateIds + tailCandidateIds;
            uniqueIds(combined, restart ? 128 : 131);
            record(restart ? "restart-candidate-next-page-replaces-with-28" : "candidate-next-page-replaces-with-oldest-31");
            capture(restart ? ".memory-candidates-restart-next.png" : ".memory-candidates-next.png");
            if (restart) {
                frozenIds = combined;
                record("restart-candidate-128-id-order-readback"); next(18);
            } else {
                confirmId = candidateIds.value(MemoryCandidatePageCheck::seededText(30));
                rejectId = candidateIds.value(MemoryCandidatePageCheck::seededText(29)); next(8);
            }
            return;
        }
        if (step == 8) { if (rowPress("confirm-candidate-30", confirmId, "memoryCandidateConfirm", "记住这条")) next(9); return; }
        if (step == 9) {
            if (!actionReady()) return;
            auto expected = candidateTexts(31, 1); expected.removeAll(MemoryCandidatePageCheck::seededText(30));
            requireCandidates(expected, 2, false);
            requireConfirmed(QStringList{MemoryCandidatePageCheck::seededText(30)} + confirmedTexts().mid(0, 99));
            if (!observePageRead("confirm-reread")) return;
            committedId = values(memories(), "id").first();
            require(!baselineIds.contains(committedId), "CANDIDATE_PAGE_CONFIRM_OVERWROTE_OLD_FACT");
            observed["confirmedCandidateId"] = confirmId; observed["committedMemoryId"] = committedId;
            observed["confirmSameStartMatches"] = true; observed["afterConfirmCount"] = candidates().size();
            capture(".memory-candidates-confirmed-same-page.png");
            record("candidate-confirm-rereads-same-page"); next(10); return;
        }
        if (step == 10) { if (rowPress("reject-candidate-29", rejectId, "memoryCandidateReject", "不记这条")) next(11); return; }
        if (step == 11) {
            if (!actionReady()) return;
            auto expected = candidateTexts(31, 1);
            expected.removeAll(MemoryCandidatePageCheck::seededText(30)); expected.removeAll(MemoryCandidatePageCheck::seededText(29));
            requireCandidates(expected, 2, false); tailCandidateIds = values(candidates(), "id");
            if (!observePageRead("reject-reread")) return;
            observed["rejectedCandidateId"] = rejectId; observed["rejectSameStartMatches"] = true;
            observed["afterRejectCount"] = candidates().size();
            record("candidate-reject-rereads-same-page"); next(12); return;
        }
        if (step == 12) { if (rowPress("open-memory-delete", committedId, "memoryDelete")) next(13); return; }
        if (step == 13) {
            require(context().deletingId == committedId && values(memories(), "id").contains(committedId),
                    "CANDIDATE_PAGE_DELETE_BEFORE_CONFIRMATION");
            if (rowPress("confirm-memory-delete", committedId, "memoryDeleteConfirm", "删除记忆")) next(14); return;
        }
        if (step == 14) {
            if (!actionReady(false)) return;
            requireConfirmed(confirmedTexts().mid(0, 100));
            require(!values(memories(), "id").contains(committedId), "CANDIDATE_PAGE_DELETED_FACT_STILL_SHOWN");
            observed["deleteConfirmedMemoryMatches"] = true;
            record("candidate-confirmed-fact-deleted-through-confirmation"); next(15); return;
        }
        if (step == 15) {
            if (press("memoryLoadMore", {"list"}, [this](const QVariantMap &previous) {
                    ownRead("list", listRead, previous.value("list").toString());
                })) next(16);
            return;
        }
        if (step == 16) {
            if (!readReady()) return;
            require(receipt("list").value("requestId") == listRead, "CANDIDATE_PAGE_RESTORED_READ_MISMATCH");
            requireConfirmed(confirmedTexts());
            require(values(memories(), "id") == baselineIds, "CANDIDATE_PAGE_CONFIRMED_BASELINE_ID_ORDER_CHANGED");
            observed["confirmedBaselineCount"] = baselineIds.size(); observed["confirmedIdOrderRestored"] = true;
            observed["confirmedBaselineDigest"] = digest(baselineIds);
            record("candidate-confirmed-baseline-restored"); next(18); return;
        }
        if (step == 18) {
            if (press("memoryCandidateFirst", {"candidates"}, [this](const QVariantMap &previous) {
                    ownRead("candidates", candidateRead, previous.value("candidates").toString());
                })) next(19);
            return;
        }
        if (step == 19) {
            if (!readReady()) return;
            require(receipt("candidates").value("requestId") == candidateRead, "CANDIDATE_PAGE_RETURN_RECEIPT_MISMATCH");
            requireCandidates(restart ? candidateTexts(130, 31) : candidateTexts(130, 32, true), 1, true);
            require(values(candidates(), "id") == firstCandidateIds && diagnostic().value("currentStartCursorDigest") == firstStart,
                    "CANDIDATE_PAGE_RETURN_FIRST_ID_OR_CURSOR_CHANGED");
            if (!observePageRead("return-first")) return;
            if (!restart) {
                frozenIds = firstCandidateIds + tailCandidateIds;
                frozenIds.removeAll(candidateIds.value(ordinaryCandidate));
            }
            uniqueIds(frozenIds, 128);
            observed["finalCandidateIds"] = frozenIds; observed["finalCandidateIdsDigest"] = digest(frozenIds);
            observed["finalCandidateCount"] = frozenIds.size(); observed["firstPageCount"] = 100;
            observed["tailPageCount"] = restart ? 28 : 29;
            observed["firstPageRestoredMatches"] = true;
            require(actionResponses == (restart ? 0 : 3) && (!restart || !s->memoryFeedback().contains("action")),
                    "CANDIDATE_PAGE_ACTION_COUNT_UNEXPECTED");
            capture(restart ? ".memory-candidates-restart-final-first.png" : ".memory-candidates-final-first.png");
            record(restart ? "restart-candidate-return-first-without-actions" : "candidate-return-first-freezes-128-pending");
            next(20); return;
        }
        if (step == 20) { if (press("memory-close")) next(21); return; }
        if (step == 21) {
            require(clock.elapsed() - at < 4000, "CANDIDATE_PAGE_CLOSE_DEADLINE");
            if (!closed()) return;
            require(s->draft() == draft && e->content() == archiveContent && e->revision() == initialRevision && e->dirty() == initialDirty &&
                        values(s->messages(), "id") == initialMessageIds && s->scopeKey() == scope,
                    "CANDIDATE_PAGE_CHANGED_DRAFT_OR_HISTORY");
            require(uiDraft() == initialUiDraft, "CANDIDATE_PAGE_CHANGED_UI_DRAFT");
            require(w->size() == QSize(1380, 900) && item("memoryTabs", false)->property("currentIndex").toInt() == 0 &&
                        s->memoryQuery().isEmpty() && page().value("pageNumber").toInt() == 1 &&
                        s->diagnostics().value("pendingCommands").toList().isEmpty(), "CANDIDATE_PAGE_FINAL_STATE_UNEXPECTED");
            observed["finalSurfacesClosedMatch"] = true; observed["draftsMatch"] = true; observed["messageIdsMatch"] = true;
            observed["finalPageNumber"] = 1; observed["finalTabIndex"] = 0;
            observed["candidateBackupRestoreCovered"] = false;
            record(restart ? "restart-candidate-final-state-and-drafts-unchanged" : "candidate-final-state-and-drafts-unchanged");
            finish(true);
        }
    }
};
}
namespace MemoryCandidatePageCheck {
QString seededText(int number) { return QString("隔离分页候选第%1条：水面记录").arg(number, 3, 10, QChar('0')); }
void run(QQuickWindow *window, RuntimeBridge *bridge, ArchiveEditor *editor, bool restart, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion) {
    new Check(window, bridge, editor, restart, capturePrefix, std::move(completion));
}
}
