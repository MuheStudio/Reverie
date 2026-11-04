#include "MemoryRecallCheck.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include "ControlReadiness.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonObject>
#include <QQuickItem>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QSet>
#include <QTest>
#include <QTimer>
#include <cmath>

namespace {
const QString marker = "星图标记";
QQuickItem *find(QQuickItem *root, const QString &name, bool visible = true) {
    if (root->objectName() == name && (!visible || root->isVisible())) return root;
    for (auto *child : root->childItems())
        if (auto *found = find(child, name, visible)) return found;
    return nullptr;
}
QStringList ids(const QVariantList &rows) {
    QStringList result;
    for (const auto &row : rows) result.append(row.toMap().value("id").toString());
    return result;
}
class Check final : public QObject {
  public:
    using Action = NativeControlReadiness::SequentialGate::Action;
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, inputStarted = false, narrowTabsCaptured = false;
    QString prefix, scope, draft, archiveContent, filter, requestId, pagingFingerprint;
    QVariantMap initialState, initialFeedback, initialList, initialUiDraft, rawResponse, observed;
    QVariantList initialMessages, cases;
    QStringList initialIds;
    int initialCommands, initialGeneration, initialRevision, initialEpoch = 0;
    int responseCount = 0, responseGeneration = -1, step = 0;
    QString responseId;
    bool initialDirty;
    QTimer timer;
    QElapsedTimer clock, inputClock;
    qint64 at = 0;
    NativeControlReadiness::SequentialGate gate;
    std::function<void(QVariantMap)> done;

    Check(QQuickWindow *window, RuntimeBridge *bridge, ArchiveEditor *editor, bool verify,
          QString capturePrefix, std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(bridge), e(editor), restart(verify), prefix(std::move(capturePrefix)),
          scope(bridge->scopeKey()), draft(bridge->draft()), archiveContent(editor->content()),
          filter(bridge->memoryQuery()), pagingFingerprint(bridge->memoryPagingFingerprint()),
          initialState(bridge->state()), initialFeedback(bridge->memoryFeedback()),
          initialList(bridge->state().value("memory").toMap()), initialMessages(bridge->messages()),
          initialIds(ids(initialList.value("memories").toList())),
          initialCommands(bridge->diagnostics().value("commands").toInt()), initialGeneration(bridge->generation()),
          initialRevision(editor->revision()), initialDirty(editor->dirty()), done(std::move(callback)) {
        clock.start();
        initialUiDraft = uiDraft();
        connect(s, &RuntimeBridge::responseReceived, this,
                [this](const QString &id, const QString &command, const QVariantMap &result, int generation) {
                    if (command != "memory:query") return;
                    ++responseCount;
                    responseId = id;
                    responseGeneration = generation;
                    rawResponse = result;
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
    void require(bool value, const QString &error) const {
        if (!value) throw std::runtime_error(error.toStdString());
    }
    void next(int target) { step = target; at = clock.elapsed(); inputStarted = false; gate.resetForNextStep(); }
    QVariantMap recall() const { return s->memoryRecallState(); }
    int commands() const { return s->diagnostics().value("commands").toInt(); }
    QQuickItem *item(const QString &name, bool visible = true) const { return find(w->contentItem(), name, visible); }
    QString text(const QString &name) const {
        const auto *control = item(name);
        return control ? control->property("text").toString() : QString();
    }
    bool opened() const {
        const auto *surface = item("drawer-memory");
        return surface && surface->property("inputReady").toBool();
    }
    bool closed() const {
        for (const auto *name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            const auto *surface = item(name, false);
            if (surface && surface->property("progress").toDouble() > 0) return false;
        }
        return true;
    }
    void requireInputTime() const {
        require(clock.elapsed() < 20000, "MEMORY_RECALL_TIMEOUT");
        require(inputStarted && inputClock.elapsed() < 4000, "MEMORY_RECALL_INPUT_DEADLINE");
    }
    void click(QQuickItem *control) {
        require(control && control->isEnabled(), "MEMORY_RECALL_CONTROL_UNAVAILABLE");
        const auto center = control->mapToScene(QPointF(control->width() / 2, control->height() / 2)).toPoint();
        requireInputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, center, 0);
    }
    Action press(const QString &name) {
        return {name, [this, name] { return item(name, false); },
                [this](QQuickItem *control) { return NativeControlReadiness::snapshot(control, w, opened()); },
                [this](QQuickItem *control) { click(control); }};
    }
    Action type(const QString &name, const QString &value) {
        return {name, [this, name] { return item(name, false); },
                [this](QQuickItem *control) { return NativeControlReadiness::snapshot(control, w, opened()); },
                [this, value](QQuickItem *control) {
                    QPointer<QQuickItem> editor(control);
                    click(editor);
                    require(editor, "MEMORY_RECALL_EDITOR_DISAPPEARED");
                    requireInputTime();
                    require(QMetaObject::invokeMethod(editor, "selectAll"), "MEMORY_RECALL_SELECT_ALL_UNAVAILABLE");
                    QInputMethodEvent commit;
                    commit.setCommitString(value);
                    require(editor, "MEMORY_RECALL_EDITOR_DISAPPEARED");
                    requireInputTime();
                    QCoreApplication::sendEvent(w, &commit);
                    require(editor && editor->property("text").toString() == value, "MEMORY_RECALL_INPUT_NOT_COMMITTED");
                }};
    }
    bool input(const std::vector<Action> &actions) {
        require(clock.elapsed() < 20000, "MEMORY_RECALL_TIMEOUT");
        if (!inputStarted) { inputStarted = true; inputClock.start(); }
        const auto result = gate.poll([this] { return clock.elapsed() >= 20000 ? qint64(4000) : inputClock.elapsed(); }, 4000, actions);
        require(result != NativeControlReadiness::SequentialGate::Expired, "MEMORY_RECALL_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "MEMORY_RECALL_INPUT_FAILED");
        return result == NativeControlReadiness::SequentialGate::Performed;
    }
    void record(const QString &name) { cases.append(QVariantMap{{"name", name}, {"passed", true}}); }
    QVariantMap uiDraft() const {
        QVariantMap values;
        for (const auto *name : {"memoryFilterField", "profileName", "profileNickname", "profileBirthday",
                                 "profileSchedule", "profileIdentity", "profileInterests", "profileHobbies", "profileTopics"}) {
            const auto *control = item(name, false);
            values[name] = control ? control->property("text") : QVariant();
        }
        for (auto *ancestor = item("memoryPage", false); ancestor; ancestor = ancestor->parentItem()) {
            if (!ancestor->property("editingMemoryId").isValid()) continue;
            for (const auto *name : {"editingMemoryId", "deletingMemoryId", "profileDirty", "profileEditRevision",
                                     "profileSavingRevision", "profileSaveRequestId"})
                values[name] = ancestor->property(name);
            break;
        }
        return values;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        // Restore the ordinary viewport on every exit, including an assertion
        // failure during the one narrow observation. This sends no command.
        if (w->size() != QSize(1380, 900)) w->resize(1380, 900);
        observed["queryDispatchCount"] = commands() - initialCommands;
        observed["queryResponseCount"] = responseCount;
        auto callback = std::move(done);
        if (callback) callback({{"passed", passed}, {"error", error}, {"stage", restart ? 2 : 1},
                                {"step", step}, {"elapsedMs", clock.elapsed()}, {"checks", cases}, {"observed", observed},
                                {"contentCollected", false}});
        deleteLater();
    }
    void unchanged() {
        const auto current = s->state().value("memory").toMap();
        const bool idOrder = ids(current.value("memories").toList()) == initialIds;
        const bool state = current == initialList && s->state().value("candidates") == initialState.value("candidates");
        const bool feedback = s->memoryFeedback() == initialFeedback;
        const bool query = s->memoryQuery() == filter && current.value("query") == initialList.value("query");
        const bool cursor = s->memoryPagingFingerprint() == pagingFingerprint;
        const bool hasMore = current.value("hasMore") == initialList.value("hasMore");
        const bool drafts = s->draft() == draft && e->content() == archiveContent &&
                            e->revision() == initialRevision && e->dirty() == initialDirty && uiDraft() == initialUiDraft;
        const bool messages = s->messages() == initialMessages;
        observed.insert({{"managementCount", current.value("memories").toList().size()},
            {"managementIdOrderMatches", idOrder}, {"managementStateMatches", state},
            {"managementFeedbackMatches", feedback}, {"filterMatches", query}, {"cursorMatches", cursor},
            {"hasMoreMatches", hasMore}, {"draftsMatch", drafts}, {"messageIdsMatch", messages}});
        require(idOrder && state && feedback && query && cursor && hasMore && drafts && messages,
                "MEMORY_RECALL_CHANGED_MANAGEMENT_OR_DRAFT");
        require(s->scopeKey() == scope && s->generation() == initialGeneration, "MEMORY_RECALL_SCOPE_CHANGED");
    }
    void managementVisible() {
        unchanged();
        require(item("memoryTabs") && item("memoryTabs")->property("currentIndex").toInt() == 0,
                "MEMORY_RECALL_MANAGEMENT_TAB_NOT_RETURNED");
        require(text("memoryFilterField") == filter, "MEMORY_RECALL_FILTER_DRAFT_CHANGED");
        require(bool(item("memoryLoadMore")) == initialList.value("hasMore").toBool(),
                "MEMORY_RECALL_LOAD_MORE_CHANGED");
        require(text("memoryListFeedback") == initialFeedback.value("list").toMap().value("text").toString(),
                "MEMORY_RECALL_LIST_RECEIPT_CHANGED");
    }
    bool completelyVisible(QQuickItem *control) const {
        return NativeControlReadiness::wholeVisibility(control, w).value("fullyVisible").toBool();
    }
    // The latest bounded geometry per phase; a step deadline leaves the last
    // poll's record in observed, so a failure shows why the item never fit.
    void visibilityDiagnostic(const QString &key, QQuickItem *control, const QVariantMap &reveal) {
        observed[key] = QVariantMap{{"reveal", NativeControlReadiness::revealSummary(reveal)},
                                    {"visibility", NativeControlReadiness::wholeVisibility(control, w)},
                                    {"stepElapsedMs", clock.elapsed() - at}, {"windowWidth", w->width()},
                                    {"windowHeight", w->height()}};
    }
    bool readonlyResults(bool narrow) {
        require(clock.elapsed() - at < 4000, "MEMORY_RECALL_RESULT_VISIBILITY_DEADLINE");
        const auto rows = recall().value("results").toStringList();
        require(!rows.isEmpty(), "MEMORY_RECALL_NO_VISIBLE_RESULTS");
        for (int n = 0; n < rows.size(); ++n) {
            auto *control = item("memoryRecallText" + QString::number(n));
            if (!control || control->property("text").toString() != rows[n] ||
                !control->property("readOnly").toBool() || control->property("textFormat").toInt() != Qt::PlainText)
                return false;
        }
        require(!item("memoryEdit0") && !item("memoryDelete0") && !item("memoryPin0") &&
                    !item("memoryCandidateConfirm0") && !item("memoryCandidateReject0"),
                "MEMORY_RECALL_RECORD_ACTION_VISIBLE");
        auto *first = item("memoryRecallText0");
        // A center inside the page does not prove both edges fit; reveal the whole result.
        const auto reveal = NativeControlReadiness::revealWholeItem(first,
            [this] { return clock.elapsed() >= 20000 ? qint64(4000) : clock.elapsed() - at; }, 4000);
        visibilityDiagnostic(narrow ? "narrowResultVisibilityDiagnostic" : "resultVisibilityDiagnostic", first, reveal);
        require(!reveal.value("expired").toBool(), "MEMORY_RECALL_RESULT_REVEAL_DEADLINE");
        if (!completelyVisible(first)) return false;
        observed["plainReadonlyMatches"] = true;
        observed["noRecordActions"] = true;
        if (narrow) observed["narrowResultBoundsMatch"] = true;
        return true;
    }
    void received() {
        const auto state = recall();
        const auto payload = QJsonObject::fromVariantMap(rawResponse);
        require(responseCount == 1 && responseId == requestId && responseGeneration == initialGeneration &&
                    state.value("requestId") == requestId && state.value("scopeKey") == scope &&
                    state.value("generation").toInt() == initialGeneration,
                "MEMORY_RECALL_RESPONSE_CORRELATION_FAILED");
        require(payload.value("memories").isArray() && payload.value("retrieval").isObject(),
                "MEMORY_RECALL_RESPONSE_SHAPE_INVALID");
        const auto rows = payload.value("memories").toArray();
        const auto retrieval = payload.value("retrieval").toObject();
        QStringList actual;
        int characters = 0;
        bool markerMatches = false;
        for (const auto &row : rows) {
            require(row.isString(), "MEMORY_RECALL_RESULT_NOT_STRING");
            const auto value = row.toString();
            actual.append(value);
            characters += value.toUcs4().size();
            markerMatches = markerMatches || value.contains(marker);
        }
        require(!actual.isEmpty() && actual.size() <= 20 && characters <= 5400 && markerMatches,
                "MEMORY_RECALL_RESULT_BOUNDS_OR_MARKER_FAILED");
        require(actual == state.value("results").toStringList(), "MEMORY_RECALL_UI_RESULTS_DIFFER");
        const auto mode = retrieval.value("mode").toString();
        const auto reason = retrieval.value("reason").toString();
        require(mode == "lexical_fallback" && (reason == "model_unavailable" || reason == "index_unavailable"),
                "MEMORY_RECALL_EXPECTED_OBSERVED_LEXICAL_FALLBACK");
        const auto pending = retrieval.value("indexPending");
        require(pending.isNull() || (pending.isDouble() && pending.toDouble() >= 0 &&
                                    std::floor(pending.toDouble()) == pending.toDouble()),
                "MEMORY_RECALL_INDEX_PENDING_INVALID");
        require(state.value("mode") == mode && state.value("reason") == reason &&
                    QJsonValue::fromVariant(state.value("indexPending")) == pending,
                "MEMORY_RECALL_UI_RETRIEVAL_METADATA_DIFFER");
        require(text("memoryRecallFeedback") == state.value("text").toString() &&
                    text("memoryRecallSubmittedQuery") == "本次查询：" + marker && text("memoryRecallMode") == "词法回退",
                "MEMORY_RECALL_RECEIPT_NOT_VISIBLE");
        observed.insert({{"requestId", requestId}, {"requestScopeMatches", true}, {"requestGenerationMatches", true},
            {"resultCount", actual.size()}, {"resultCharacters", characters}, {"resultStrings", true},
            {"markerMatches", markerMatches}, {"mode", mode}, {"reason", reason},
            {"indexPending", pending.toVariant()}});
        unchanged();
    }
    bool narrowTabs() {
        const QList<QPair<QString, QString>> expected{{"memories", "记忆"}, {"summary", "摘要"},
            {"profile", "你的资料"}, {"backup", "备份"}, {"recall", "关联回忆"}};
        for (const auto &[name, label] : expected) {
            auto *control = item("memoryTab-" + name);
            auto *content = item("memoryTabLabel-" + name);
            if (!control || !content || control->property("text").toString() != label ||
                content->property("text").toString() != label || content->property("truncated").toBool() ||
                content->property("elide").toInt() != Qt::ElideNone ||
                content->property("lineCount").toInt() < 1 || content->property("lineCount").toInt() > 2 ||
                !completelyVisible(control) || !completelyVisible(content)) return false;
        }
        observed["narrowTabCount"] = expected.size();
        observed["narrowTabLabelsMatch"] = true;
        return true;
    }
    void tick() {
        require(clock.elapsed() < 20000, "MEMORY_RECALL_TIMEOUT");
        if (step == 0) {
            require(opened() && item("memoryPage"), "MEMORY_RECALL_APPEND_SURFACE_NOT_OPEN");
            managementVisible();
            require(s->diagnostics().value("pendingCommands").toList().isEmpty(), "MEMORY_RECALL_APPEND_HAS_PENDING_COMMAND");
            if (input({press("memoryTab-recall")})) next(1);
            return;
        }
        if (step == 1) {
            const auto state = recall();
            require(commands() == initialCommands && responseCount == 0 && text("memoryRecallQuery").isEmpty() &&
                        state.value("results").toStringList().isEmpty() && state.value("requestId").toString().isEmpty() &&
                        state.value("submittedQuery").toString().isEmpty() &&
                        (state.isEmpty() || state.value("status") == "idle"),
                    "MEMORY_RECALL_PERSISTED_OR_DISPATCHED_BEFORE_INPUT");
            initialEpoch = state.value("inputEpoch").toInt();
            observed["notPersistedMatches"] = true;
            observed["switchCommandCount"] = 0;
            record(restart ? "restart-recall-empty-before-input" : "recall-starts-empty-without-dispatch");
            next(2);
            return;
        }
        if (step == 2) {
            if (!input({type("memoryRecallQuery", marker), press("memoryRecallSubmit")})) return;
            const auto state = recall();
            requestId = state.value("requestId").toString();
            require(QRegularExpression("^[A-Za-z0-9_-]{8,128}$").match(requestId).hasMatch() &&
                        state.value("submittedQuery") == marker && commands() == initialCommands + 1,
                    "MEMORY_RECALL_OWN_QUERY_NOT_DISPATCHED");
            for (const auto &value : initialFeedback)
                require(value.toMap().value("requestId") != requestId, "MEMORY_RECALL_REQUEST_ID_REUSED");
            next(3);
            return;
        }
        if (step == 3) {
            require(clock.elapsed() - at < 10000, "MEMORY_RECALL_READ_DEADLINE");
            if (recall().value("status") == "pending" || responseCount == 0) return;
            require(recall().value("status") == "success", "MEMORY_RECALL_RESULT_NOT_SUCCESSFUL");
            received();
            next(13);
            return;
        }
        if (step == 13) {
            if (!readonlyResults(false)) return;
            record(restart ? "restart-recall-fresh-query-and-readonly-result" : "recall-query-shows-correlated-lexical-fallback");
            w->grabWindow().save(prefix + (restart ? ".memory-recall-restart.png" : ".memory-recall.png"));
            if (restart) next(6);
            else { w->resize(760, 650); next(4); }
            return;
        }
        if (step == 4) {
            require(clock.elapsed() - at < 4000, "MEMORY_RECALL_NARROW_VISIBILITY_DEADLINE");
            if (w->size() != QSize(760, 650)) return;
            // Revealing the result scrolls the shared page. Bring the tab row
            // back before assessing every complete label in the same viewport.
            if (!narrowTabsCaptured) {
                auto *tabs = item("memoryTabs");
                const auto reveal = NativeControlReadiness::revealWholeItem(tabs,
                    [this] { return clock.elapsed() >= 20000 ? qint64(4000) : clock.elapsed() - at; }, 4000);
                visibilityDiagnostic("narrowTabsDiagnostic", tabs, reveal);
                if (!narrowTabs()) return;
                w->grabWindow().save(prefix + ".memory-recall-narrow-tabs.png");
                narrowTabsCaptured = true;
                return;
            }
            if (!readonlyResults(true)) return;
            require(commands() == initialCommands + 1, "MEMORY_RECALL_RESIZE_DISPATCHED_COMMAND");
            w->grabWindow().save(prefix + ".memory-recall-narrow.png");
            record("recall-tabs-and-readonly-result-fit-narrow-window");
            w->resize(1380, 900);
            next(5);
            return;
        }
        if (step == 5) {
            require(clock.elapsed() - at < 4000, "MEMORY_RECALL_VIEWPORT_RESTORE_DEADLINE");
            if (w->size() != QSize(1380, 900)) return;
            next(6);
            return;
        }
        if (step == 6) {
            if (input({press("memoryTab-memories")})) next(7);
            return;
        }
        if (step == 7) {
            managementVisible();
            require(commands() == initialCommands + 1, "MEMORY_RECALL_TAB_RETURN_REFRESHED_LIST");
            record(restart ? "restart-recall-return-preserves-management-state" : "recall-return-preserves-management-state");
            w->grabWindow().save(prefix + ".memory-recall-management.png");
            next(8);
            return;
        }
        if (step == 8) {
            if (input({press("memoryTab-recall"), press("memoryRecallClear")})) next(9);
            return;
        }
        if (step == 9) {
            const auto state = recall();
            require(commands() == initialCommands + 1 && responseCount == 1 &&
                        state.value("inputEpoch").toInt() > initialEpoch &&
                        state.value("requestId").toString().isEmpty() && state.value("submittedQuery").toString().isEmpty() &&
                        state.value("results").toStringList().isEmpty() && text("memoryRecallQuery").isEmpty() &&
                        state.value("status") == "idle" && !item("memoryRecallText0"),
                    "MEMORY_RECALL_CLEAR_DID_NOT_INVALIDATE_LOCAL_READ");
            observed["clearCommandCount"] = 0;
            observed["invalidatedReadMatches"] = true;
            record(restart ? "restart-recall-clear-without-command" : "recall-clear-invalidates-read-without-command");
            next(10);
            return;
        }
        if (step == 10) {
            if (input({press("memoryTab-memories")})) next(11);
            return;
        }
        if (step == 11) {
            managementVisible();
            require(commands() == initialCommands + 1 && responseCount == 1,
                    "MEMORY_RECALL_EXTRA_COMMAND_OR_RESULT");
            if (input({press("memory-close")})) next(12);
            return;
        }
        if (step == 12) {
            require(clock.elapsed() - at < 4000, "MEMORY_RECALL_CLOSE_DEADLINE");
            if (!closed()) return;
            unchanged();
            observed["finalTabIndex"] = item("memoryTabs", false)->property("currentIndex").toInt();
            observed["finalSurfacesClosedMatch"] = true;
            record(restart ? "restart-recall-final-management-and-drafts-unchanged" : "recall-final-management-and-drafts-unchanged");
            finish(true);
        }
    }
};
}
namespace MemoryRecallCheck {
void run(QQuickWindow *window, RuntimeBridge *bridge, ArchiveEditor *editor, bool restart,
         const QString &capturePrefix, std::function<void(QVariantMap)> completion) {
    new Check(window, bridge, editor, restart, capturePrefix, std::move(completion));
}
}
