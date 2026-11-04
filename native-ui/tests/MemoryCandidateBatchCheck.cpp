#include "MemoryCandidateBatchCheck.h"
#include "MemoryCandidatePageCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "CandidateHeaderProbe.h"
#include "../src/RuntimeBridge.h"
#include <QElapsedTimer>
#include <QQuickWindow>
#include <QRegularExpression>
#include <QSet>
#include <QJSValue>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

// Runs once, at the end of the --candidate-paging restart, after the original
// restart read-back of all 128 pending candidates has passed. Decisions made
// here therefore never change an earlier registered assertion.
namespace {
class Check final : public QObject {
    using Action = NativeControlReadiness::SequentialGate::Action;
    QQuickWindow *w;
    RuntimeBridge *s;
    bool executing = false;
    QString scope, prefix, readId, previewId, batchId;
    int generation, step = 0, initialWrites, initialReads, cancelledWrites = 0;
    QStringList baselineCandidates, confirmTargets, rejectTargets, selected, beforeMessages, initialPending;
    QVariantMap observed;
    QVariantList checks, inputs, receipts, actions, candidateReads;
    QTimer timer;
    QElapsedTimer clock;
    qint64 at = 0;
    quint64 frame = 0;
    NativeControlReadiness::SequentialGate gate;
    SummaryInteractionProbe::StableGate stable, explanationStable;
    CandidateHeaderProbe::StableRead headerStable;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, QStringList baseline, QString capture,
          std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), scope(session->scopeKey()), prefix(std::move(capture)),
          generation(session->generation()),
          initialWrites(session->memoryCandidateBatch().value("dispatchCount").toInt()),
          initialReads(session->memoryCandidateBatch().value("statusReadDispatchCount").toInt()),
          baselineCandidates(std::move(baseline)), done(std::move(completion)) {
        clock.start();
        beforeMessages = messageIds();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &result, int g) {
                if (g != generation || s->scopeKey() != scope) return;
                const auto current = batch();
                const bool candidateList = command == "memory:candidates:list" && !id.isEmpty() &&
                    id == current.value("candidateReadId").toString();
                const bool memoryList = command == "memory:list" && !id.isEmpty() &&
                    id == current.value("listReadId").toString();
                if (!candidateList && !memoryList &&
                    !QStringList{"memory:candidates:status", "memory:candidates:decide_many"}.contains(command)) return;
                if (receipts.size() >= 16) { finish(false, "CANDIDATE_BATCH_RECEIPT_BOUND"); return; }
                QVariantMap value{{"requestId", id}, {"command", command}, {"generation", g}, {"scope", scope}};
                if (candidateList || memoryList) {
                    value["ok"] = result.value("ok").metaType().id() == QMetaType::Bool ? result.value("ok") : QVariant();
                    value.insert(identityPage(result.value(candidateList ? "candidates" : "memories"), candidateList));
                    receipts.append(value);
                    return;
                }
                for (const auto *key : {"ok", "candidate_ids", "decision", "pending_ids", "stale_ids", "new_ids",
                                       "replace_ids", "same_ids", "replaced_pinned_ids", "conflict_groups",
                                       "rejected_ids", "error_code"})
                    if (result.contains(key)) value[key] = result.value(key);
                if (result.contains("states")) {
                    QVariantMap states;
                    for (const auto &entry : result.value("states").toList())
                        states[entry.toMap().value("candidate_id").toString()] = entry.toMap().value("status");
                    value["states"] = states;
                }
                if (result.contains("confirmed")) {
                    QVariantList confirmed;
                    for (const auto &entry : result.value("confirmed").toList()) {
                        const auto row = entry.toMap();
                        confirmed.append(QVariantMap{{"candidate_id", row.value("candidate_id")},
                            {"memory_id", row.value("memory_id")}, {"replaced_memory_id", row.value("replaced_memory_id")},
                            {"idempotent", row.value("idempotent")}});
                    }
                    value["confirmed"] = confirmed;
                }
                receipts.append(value);
            });
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing) return;
            executing = true;
            try { tick(); } catch (const std::exception &e) { finish(false, e.what()); }
            executing = false;
        });
        timer.start();
    }
    int deadline() const { return 30000; }
    void require(bool value, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(value, code, details);
    }
    QQuickItem *item(const QString &name) const {
        auto *root = w->contentItem();
        if (!name.startsWith("memoryCandidateBatch") &&
            !QStringList{"memoryTasks", "nav-memory", "archive-open-memories", "memory-close", "drawer-memory"}.contains(name))
            root = NativeCheck::findVisual(root, "memoryTasks").item;
        return NativeCheck::findVisual(root, name, true).item;
    }
    QVariantMap batch() const { return s->memoryCandidateBatch(); }
    QVariantMap page() const { return s->memoryCandidatePage(); }
    QVariantMap feedback(const QString &key) const { return s->memoryFeedback().value(key).toMap(); }
    QVariantList candidates() const { return s->state().value("candidates").toMap().value("candidates").toList(); }
    QStringList candidateIds() const { QStringList out; for (const auto &row : candidates()) out.append(row.toMap().value("id").toString()); return out; }
    QStringList candidateTexts() const { QStringList out; for (const auto &row : candidates()) out.append(row.toMap().value("proposed_text").toString()); return out; }
    QVariantList memories() const { return s->state().value("memory").toMap().value("memories").toList(); }
    QStringList memoryPageIds() const { QStringList out; for (const auto &row : memories()) out.append(row.toMap().value("id").toString()); return out; }
    QStringList messageIds() const { QStringList out; for (const auto &row : s->messages()) out.append(row.toMap().value("id").toString()); return out; }
    QStringList selectedIds() const {
        auto *tasks = item("memoryTasks"); const auto v = tasks ? tasks->property("candidateSelectedIds") : QVariant{};
        return (v.metaType().id() == qMetaTypeId<QJSValue>() ? v.value<QJSValue>().toVariant() : v).toStringList();
    }
    bool selectionMode() const { auto *tasks = item("memoryTasks"); return tasks && tasks->property("candidateSelectionMode").toBool(); }
    bool opened() const { auto *i = item("drawer-memory"); return i && i->property("inputReady").toBool(); }
    bool closed() const { auto i = NativeCheck::findVisual(w->contentItem(), "drawer-memory").item; return !i || i->property("progress").toDouble() == 0; }
    void next(int value) { step = value; at = clock.elapsed(); gate.resetForNextStep(); stable.reset(); explanationStable.reset(); headerStable.reset(); }
    void record(const QString &name) {
        for (const auto &check : checks) require(check.toMap().value("name") != name, "CANDIDATE_BATCH_CHECK_DUPLICATED");
        checks.append(QVariantMap{{"name", name}, {"passed", true}});
    }
    // Pending paging candidates still expected on the first batch, newest first.
    static QStringList expectedFirstPage(const QSet<int> &decided) {
        QStringList out;
        for (int n = 130; n >= 1 && out.size() < 100; --n)
            if (n != 30 && n != 29 && !decided.contains(n)) out.append(MemoryCandidatePageCheck::seededText(n));
        return out;
    }
    QStringList expectedFirstPageIds(const QStringList &decided) const {
        QStringList out;
        for (const auto &id : baselineCandidates)
            if (!decided.contains(id) && out.size() < 100) out.append(id);
        return out;
    }
    static bool candidateIdentities(const QStringList &ids, int count) {
        static const QRegularExpression pattern("\\Amc_[a-f0-9]{32}\\z");
        if (ids.size() != count || QSet<QString>(ids.begin(), ids.end()).size() != count) return false;
        for (const auto &id : ids) if (!pattern.match(id).hasMatch()) return false;
        return true;
    }
    // Persist only bounded identities from the actual response, never row text
    // or cursors. Invalid identities become empty sentinels, not report content.
    static QVariantMap identityPage(const QVariant &offered, bool candidates) {
        const auto rows = offered.toList();
        static const QRegularExpression candidatePattern("\\Amc_[a-f0-9]{32}\\z");
        static const QRegularExpression memoryPattern("\\A[A-Za-z0-9][A-Za-z0-9._:-]{0,127}\\z");
        const auto &pattern = candidates ? candidatePattern : memoryPattern;
        bool valid = offered.metaType().id() == QMetaType::QVariantList && rows.size() <= 100;
        bool pending = offered.metaType().id() == QMetaType::QVariantList;
        QStringList ids;
        QSet<QString> seen;
        for (int index = 0; index < rows.size() && index < 100; ++index) {
            const auto row = rows[index].toMap();
            const auto value = row.value("id");
            const auto id = value.toString();
            const bool identity = rows[index].metaType().id() == QMetaType::QVariantMap &&
                value.metaType().id() == QMetaType::QString && pattern.match(id).hasMatch();
            valid = valid && identity && !seen.contains(id);
            ids.append(identity ? id : QString());
            seen.insert(id);
            pending = pending && row.value("status").metaType().id() == QMetaType::QString &&
                row.value("status").toString() == "pending";
        }
        QVariantMap result{{"pageIds", ids}, {"pageCount", rows.size()}, {"identityValid", valid}};
        if (candidates) result["allPending"] = pending;
        return result;
    }
    // `old` is a by-value snapshot: callers pass the readId member itself.
    void ownCandidateRead(QString old) {
        const QString fresh = feedback("candidates").value("requestId").toString();
        candidateReads.append(QVariantMap{{"step", step}, {"oldId", old}, {"newId", fresh}});
        require(!fresh.isEmpty() && fresh != old, "CANDIDATE_BATCH_READ_NOT_NEW");
        readId = fresh;
    }
    QString selectionControl(const QString &id) const {
        const int index = candidateIds().indexOf(id);
        return index < 0 ? QString() : "memoryCandidateSelect" + QString::number(index);
    }
    SummaryInteractionProbe::ControlObservation inspect(QQuickItem *control, bool surface) const {
        auto value = SummaryInteractionProbe::inspect(control, w, surface, scope);
        const bool whole = control && value.clip.contains(value.scene.adjusted(.5, .5, -.5, -.5));
        value.eligible = value.eligible && whole; value.state["fullyVisible"] = whole; value.state["ready"] = value.eligible;
        return value;
    }
    bool press(const QString &name, const std::function<void()> &after = {}, const QString &targetId = {}, bool checkbox = false) {
        const auto locate = [this, name, targetId] { return item(targetId.isEmpty() ? name : selectionControl(targetId)); };
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : clock.elapsed() - at; };
        QPointer<QQuickItem> wholeTarget = locate();
        const auto reveal = NativeControlReadiness::revealWholeItem(wholeTarget, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"elapsedMs", elapsed()},
            {"frameSerial", QVariant::fromValue(frame)}, {"windowWidth", w->width()}, {"windowHeight", w->height()},
            {"revealSummary", NativeControlReadiness::revealSummary(reveal)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(wholeTarget, w)}};
        require(!reveal.value("expired").toBool() && elapsed() < 4000, "CANDIDATE_BATCH_INPUT_DEADLINE");
        if (!wholeTarget || locate() != wholeTarget || !reveal.value("geometryValid").toBool()) {
            stable.reset(); w->update(); return false;
        }
        Action action{name, locate,
            [this, name](QQuickItem *control) {
                const bool surface = name == "nav-memory" ? closed() : opened();
                return stable.observe(inspect(control, surface), clock.elapsed() - at, frame);
            }, [this, locate, after, checkbox, targetId, name](QQuickItem *control) {
                require(clock.elapsed() - at < 4000 && clock.elapsed() < deadline(), "CANDIDATE_BATCH_INPUT_DEADLINE");
                const auto fresh = inspect(control, opened() || closed());
                require(locate() == control && stable.matches(fresh), "CANDIDATE_BATCH_INPUT_TARGET_CHANGED");
                if (!targetId.isEmpty()) require(control->property("candidateId").toString() == targetId,
                                                "CANDIDATE_BATCH_ROW_ID_MISMATCH", {{"id", targetId}});
                const auto hit = NativeCheck::hitTest(w, fresh.point, control);
                if (!hit.accepted()) {
                    // One failure-only snapshot, before any input or cleanup.
                    // The hit walk predicts a receiver; it is not Qt delivery.
                    auto receiver = NativeCheck::identity(hit.acceptor);
                    receiver.insert({{"sceneRect", QVariant()}, {"visible", QVariant()},
                                     {"enabled", QVariant()}, {"opacity", QVariant()},
                                     {"acceptedMouseButtons", QVariant()}});
                    for (const auto *key : {"orientation", "policy", "interactive", "size", "active"})
                        receiver[key] = QVariant();
                    if (const auto *acceptor = hit.acceptor.data()) {
                        const auto rect = acceptor->mapRectToScene(QRectF(0, 0, acceptor->width(), acceptor->height()));
                        receiver["sceneRect"] = QVariantMap{{"x", rect.x()}, {"y", rect.y()},
                            {"width", rect.width()}, {"height", rect.height()}};
                        receiver["visible"] = acceptor->isVisible();
                        receiver["enabled"] = acceptor->isEnabled();
                        receiver["opacity"] = acceptor->opacity();
                        receiver["acceptedMouseButtons"] = int(acceptor->acceptedMouseButtons());
                        for (const auto *key : {"orientation", "policy", "interactive", "size", "active"}) {
                            const auto value = acceptor->property(key);
                            if (value.metaType().id() == QMetaType::Bool || NativeCheck::detail::numeric(value))
                                receiver[key] = value;
                            else if (value.metaType().flags().testFlag(QMetaType::IsEnumeration)) {
                                bool converted = false;
                                const int number = value.toInt(&converted);
                                if (converted) receiver[key] = number;
                            }
                        }
                    }
                    observed["failedInputHit"] = QVariantMap{{"step", step}, {"control", name.left(80)},
                        {"targetId", targetId.left(80)}, {"pointX", fresh.point.x()}, {"pointY", fresh.point.y()},
                        {"frame", QVariant::fromValue(frame)}, {"elapsedMs", clock.elapsed() - at},
                        {"mouseDispatched", false}, {"hit", hit.metadata()}, {"acceptor", receiver}};
                }
                require(hit.accepted(), "CANDIDATE_BATCH_INPUT_HIT", hit.metadata());
                QSignalSpy clicked(control, SIGNAL(clicked()));
                QSignalSpy toggled(control, SIGNAL(toggled()));
                require(clicked.isValid() && (!checkbox || toggled.isValid()), "CANDIDATE_BATCH_SIGNAL_OBSERVER");
                require(clock.elapsed() - at < 4000 && clock.elapsed() < deadline(), "CANDIDATE_BATCH_INPUT_DEADLINE");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                NativeCheck::InputSignals counts{true, 1, clicked.count(), toggled.isValid() ? std::optional<qint64>(toggled.count()) : std::nullopt};
                const auto kind = checkbox ? NativeCheck::ControlKind::Switch
                    : name == "memoryTab-memories" ? NativeCheck::ControlKind::Tab : NativeCheck::ControlKind::Button;
                require(NativeCheck::inputContractFailure(kind, counts).isEmpty(), "CANDIDATE_BATCH_INPUT_SIGNAL",
                        NativeCheck::describeSignals(kind, counts));
                if (checkbox) require(control->property("checked").toBool(), "CANDIDATE_BATCH_CHECK_NOT_SELECTED");
                inputs.append(QVariantMap{{"step", step}, {"id", targetId}, {"control", control->objectName()},
                    {"signals", NativeCheck::describeSignals(kind, counts)}, {"layout", stable.metadata()}, {"hit", hit.metadata()}});
                if (after) after();
            }};
        const auto state = gate.poll([this] { return clock.elapsed() >= deadline() ? qint64(4000) : clock.elapsed() - at; }, 4000, {action});
        require(state != NativeControlReadiness::SequentialGate::Expired && state != NativeControlReadiness::SequentialGate::Failed,
                "CANDIDATE_BATCH_INPUT_UNAVAILABLE", gate.metadata());
        w->update();
        return state == NativeControlReadiness::SequentialGate::Performed;
    }
    bool previewReady(bool confirm, int count) {
        require(clock.elapsed() - at < 10000, "CANDIDATE_BATCH_PREVIEW_DEADLINE");
        const auto b = batch();
        if (b.value("status") == "previewing") return false;
        require(b.value("status") == "ready" && b.value("confirmationReady").toBool() &&
                b.value("ids").toStringList() == selected && b.value("confirm").toBool() == confirm &&
                b.value("previewRequestId") == previewId && b.value("selectedCount").toInt() == count &&
                b.value("newCount").toInt() == count && b.value("replaceCount").toInt() == 0 &&
                b.value("sameCount").toInt() == 0 && b.value("conflictCount").toInt() == 0,
                "CANDIDATE_BATCH_PREVIEW_MISMATCH", b);
        const auto *label = item("memoryCandidateBatchCount");
        require(label && label->property("text").toString().contains(confirm ? "将新增" : "将不记"),
                "CANDIDATE_BATCH_PREVIEW_NOT_SHOWN");
        observed[confirm ? "lastConfirmPreview" : "lastRejectPreview"] = QVariantMap{
            {"selectedCount", b.value("selectedCount")}, {"newCount", b.value("newCount")},
            {"replaceCount", b.value("replaceCount")}, {"sameCount", b.value("sameCount")},
            {"conflictCount", b.value("conflictCount")}, {"ready", b.value("confirmationReady")}};
        return true;
    }
    void openPreview(const QString &control, int nextStep) {
        const auto old = batch().value("previewRequestId").toString();
        const int count = batch().value("statusReadDispatchCount").toInt();
        if (press(control, [this, old, count] {
            previewId = batch().value("previewRequestId").toString();
            require(!previewId.isEmpty() && previewId != old && batch().value("statusReadDispatchCount").toInt() == count + 1,
                    "CANDIDATE_BATCH_PREVIEW_NOT_DISPATCHED");
        })) next(nextStep);
    }
    void submit(int nextStep) {
        const auto old = batch().value("requestId").toString();
        const int count = batch().value("dispatchCount").toInt();
        if (press("memoryCandidateBatchConfirm", [this, old, count] {
            batchId = batch().value("requestId").toString();
            require(!batchId.isEmpty() && batchId != old && batch().value("dispatchCount").toInt() == count + 1,
                    "CANDIDATE_BATCH_WRITE_NOT_UNIQUE");
        })) next(nextStep);
    }
    bool successful(bool confirm, const QSet<int> &decided) {
        require(clock.elapsed() - at < 10000, "CANDIDATE_BATCH_WRITE_READ_DEADLINE");
        const auto b = batch();
        if (b.value("busy").toBool()) return false;
        const int count = selected.size();
        require(b.value("status") == "success" && b.value("requestId") == batchId &&
                b.value("confirm").toBool() == confirm && b.value("ids").toStringList() == selected &&
                b.value("actualNewCount").toInt() == (confirm ? count : 0) && b.value("actualReplaceCount").toInt() == 0 &&
                b.value("actualSameCount").toInt() == 0 && !b.value("blocked").toBool() &&
                !b.value("statusReadId").toString().isEmpty() && !b.value("candidateReadId").toString().isEmpty() &&
                !b.value("listReadId").toString().isEmpty() &&
                feedback("candidates").value("status") == "success" &&
                feedback("candidates").value("requestId") == b.value("candidateReadId") &&
                feedback("list").value("status") == "success" && feedback("list").value("requestId") == b.value("listReadId") &&
                candidateTexts() == expectedFirstPage(decided) &&
                candidateIds() == expectedFirstPageIds(confirm ? confirmTargets : confirmTargets + rejectTargets) &&
                selectedIds().isEmpty() && !selectionMode(),
                "CANDIDATE_BATCH_SUCCESS_BARRIER", b);
        QStringList memoryIds;
        for (const auto &id : b.value("memoryIds").toList()) memoryIds.append(id.toString());
        if (confirm) {
            // The new revisions are the newest confirmed rows of an unfiltered read.
            QStringList top, topTexts, wanted;
            for (int index = 0; index < count && index < memories().size(); ++index) {
                top.append(memories()[index].toMap().value("id").toString());
                topTexts.append(memories()[index].toMap().value("text").toString());
            }
            for (int number : MemoryCandidateBatchCheck::ConfirmNumbers) wanted.append(MemoryCandidatePageCheck::seededText(number));
            require(s->memoryQuery().isEmpty() && memoryIds.size() == count &&
                    QSet<QString>(top.begin(), top.end()) == QSet<QString>(memoryIds.begin(), memoryIds.end()) &&
                    QSet<QString>(topTexts.begin(), topTexts.end()) == QSet<QString>(wanted.begin(), wanted.end()),
                    "CANDIDATE_BATCH_NEW_MEMORIES_NOT_READ", {{"memoryIds", memoryIds}});
        } else {
            require(memoryIds.isEmpty(), "CANDIDATE_BATCH_REJECT_CREATED_MEMORY");
        }
        auto *label = item("memoryCandidateBatchFeedback");
        const auto elapsed = [this] { return clock.elapsed() - at; };
        // Both labels are fixed siblings of the scroll view. Observe the
        // actual position; no reveal or scroll may hide a clipped page line.
        auto header = CandidateHeaderProbe::inspect(w, page(), candidates().size(),
            feedback("candidates").value("requestId").toString(), scope, generation, frame);
        const auto feedbackGeometry = NativeControlReadiness::wholeVisibility(label, w);
        observed["lastFeedbackGeometry"] = QVariantMap{{"elapsedMs", elapsed()}, {"windowWidth", w->width()},
            {"windowHeight", w->height()}, {"wholeVisibility", feedbackGeometry}, {"header", header}};
        require(elapsed() < 10000, "CANDIDATE_BATCH_FEEDBACK_DEADLINE");
        const auto acquired = headerStable.poll(header, true, elapsed(), 10000, feedbackGeometry);
        observed["candidateHeaderAcquisition"] = headerStable.evidence();
        require(acquired != CandidateHeaderProbe::StableRead::Expired && acquired != CandidateHeaderProbe::StableRead::Failed,
                "CANDIDATE_BATCH_HEADER_ACQUISITION_FAILED");
        if (acquired != CandidateHeaderProbe::StableRead::Ready) { w->update(); return false; }
        if (!stable.observe(inspect(label, opened()), elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        const auto expected = confirm
            ? QString("已记住 %1 条：新增 %1 条，替换已有记忆 0 条，0 条与现有记忆相同未新增。").arg(count)
            : QString("已不记 %1 条，这些候选不会成为记忆。").arg(count);
        require(label && label->property("text").toString() == expected, "CANDIDATE_BATCH_FEEDBACK_TEXT");
        const auto capture = w->grabWindow();
        const auto currentHeader = CandidateHeaderProbe::inspect(w, page(), candidates().size(),
            feedback("candidates").value("requestId").toString(), scope, generation, frame);
        require(elapsed() < 10000 && clock.elapsed() < 30000 &&
            headerStable.matches(currentHeader, NativeControlReadiness::wholeVisibility(label, w)),
            "CANDIDATE_BATCH_CAPTURE_CHANGED_GEOMETRY_OR_DEADLINE");
        header["settling"] = headerStable.evidence();
        const auto contrast = NativeCheck::renderedTextContrast(capture, label);
        require(contrast.value("contrast").toDouble() >= 4.5 && contrast.value("pixelCount").toInt() > 0,
                "CANDIDATE_BATCH_FEEDBACK_CONTRAST", contrast);
        require(capture.save(prefix + (confirm ? ".memory-candidate-batch-success.png"
                                               : ".memory-candidate-batch-reject-success.png")), "CANDIDATE_BATCH_FEEDBACK_CAPTURE");
        readId = b.value("candidateReadId").toString();
        actions.append(QVariantMap{{"requestId", batchId}, {"previewRequestId", previewId},
            {"statusReadId", b.value("statusReadId")}, {"candidateReadId", readId}, {"listReadId", b.value("listReadId")},
            {"ids", selected}, {"confirm", confirm}, {"memoryIds", memoryIds}, {"status", b.value("status")},
            {"candidatePageIds", candidateIds()}, {"memoryPageIds", memoryPageIds()},
            {"feedbackWholeVisible", true}, {"feedbackContrast", contrast},
            {"feedbackGeometry", feedbackGeometry}, {"header", header}});
        return true;
    }
    bool captureDialog(const QString &suffix) {
        const auto elapsed = [this] { return clock.elapsed() - at; };
        auto *count = item("memoryCandidateBatchCount");
        auto *explanation = item("memoryCandidateBatchExplanation");
        const auto reveal = NativeControlReadiness::revealWholeItem(explanation, elapsed, 4000);
        observed["lastDialogGeometry"] = QVariantMap{{"elapsedMs", elapsed()}, {"windowWidth", w->width()},
            {"windowHeight", w->height()}, {"revealSummary", NativeControlReadiness::revealSummary(reveal)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(explanation, w)}};
        require(elapsed() < 4000, "CANDIDATE_BATCH_DIALOG_DEADLINE");
        if (!stable.observe(inspect(count, opened()), elapsed(), frame).value("ready").toBool() ||
            !explanationStable.observe(inspect(explanation, opened()), elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        const auto image = w->grabWindow();
        QVariantList contrast;
        for (const auto *name : {"memoryCandidateBatchCount", "memoryCandidateBatchExplanation"}) {
            const auto value = NativeCheck::renderedTextContrast(image, item(name));
            require(value.value("contrast").toDouble() >= 4.5 && value.value("pixelCount").toInt() > 0, "CANDIDATE_BATCH_CONTRAST", value);
            contrast.append(value);
        }
        observed[suffix + "Contrast"] = contrast;
        require(image.save(prefix + ".memory-candidate-batch-" + suffix + ".png"), "CANDIDATE_BATCH_CAPTURE_FAILED");
        return true;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        QStringList finalTexts = candidateTexts();
        observed.insert({{"scope", scope}, {"generation", generation}, {"baselineCandidateIds", baselineCandidates},
            {"initialCandidateIds", initialPending}, {"confirmTargets", confirmTargets},
            {"rejectTargets", rejectTargets}, {"initialPendingCount", initialPending.size()},
            {"finalCandidateIds", candidateIds()}, {"finalCandidateCount", finalTexts.size()},
            {"finalPageMatches", finalTexts == expectedFirstPage({130, 129, 128, 127, 126})},
            {"beforeMessageIds", beforeMessages}, {"finalMessageIds", messageIds()},
            {"writeDispatchDelta", batch().value("dispatchCount").toInt() - initialWrites},
            {"statusReadDispatchDelta", batch().value("statusReadDispatchCount").toInt() - initialReads},
            {"receipts", receipts}, {"actions", actions}, {"candidateReads", candidateReads},
            {"selectionEmpty", selectedIds().isEmpty()}, {"selectionMode", selectionMode()},
            {"terminalStatus", batch().value("status")}, {"surfaceClosed", closed()}});
        auto callback = std::move(done);
        if (callback) callback({{"passed", passed}, {"error", error}, {"step", step}, {"checks", checks},
            {"observed", observed}, {"inputs", inputs}, {"inputCurrent", gate.metadata()},
            {"elapsedMs", clock.elapsed()}, {"deadlineMs", deadline()}, {"contentCollected", false}});
        deleteLater();
    }
    QString target(const QStringList &targets, int index) const { return index < targets.size() ? targets[index] : QString(); }
    void tick() {
        require(clock.elapsed() < deadline() && s->scopeKey() == scope && s->generation() == generation, "CANDIDATE_BATCH_DEADLINE_OR_SCOPE");
        require(messageIds() == beforeMessages, "CANDIDATE_BATCH_MESSAGES_CHANGED");
        if (step == 0) { if (press("nav-memory")) next(1); return; }
        if (step == 1) { if (press("archive-open-memories")) next(2); return; }
        if (step == 2) { if (press("memoryTab-memories")) next(3); return; }
        if (step == 3) {
            require(clock.elapsed() - at < 10000, "CANDIDATE_BATCH_INITIAL_READ_DEADLINE");
            if (feedback("candidates").value("status") == "pending" || page().value("busy").toBool() ||
                feedback("list").value("status") == "pending") return;
            require(page().value("live").toBool() && !page().value("blocked").toBool(), "CANDIDATE_BATCH_PAGE_NOT_LIVE", page());
            readId = feedback("candidates").value("requestId").toString();
            if (press("memoryCandidateFirst", [this] { ownCandidateRead(readId); })) next(4);
            return;
        }
        if (step == 4) {
            require(clock.elapsed() - at < 10000, "CANDIDATE_BATCH_READ_DEADLINE");
            if (feedback("candidates").value("status") == "pending") return;
            require(feedback("candidates").value("status") == "success" && feedback("candidates").value("requestId") == readId &&
                    page().value("pageNumber").toInt() == 1 && page().value("hasMore").toBool(), "CANDIDATE_BATCH_READ_UNCONFIRMED");
            require(candidateTexts() == expectedFirstPage({}), "CANDIDATE_BATCH_BASELINE_CHANGED");
            initialPending = candidateIds();
            require(candidateIdentities(baselineCandidates, 128) && initialPending == baselineCandidates.mid(0, 100),
                    "CANDIDATE_BATCH_BASELINE_IDENTITIES_CHANGED");
            for (int number : MemoryCandidateBatchCheck::ConfirmNumbers)
                confirmTargets.append(initialPending[candidateTexts().indexOf(MemoryCandidatePageCheck::seededText(number))]);
            for (int number : MemoryCandidateBatchCheck::RejectNumbers)
                rejectTargets.append(initialPending[candidateTexts().indexOf(MemoryCandidatePageCheck::seededText(number))]);
            selected = confirmTargets;
            next(5); return;
        }
        if (step == 5) { if (press("memoryCandidateSelectMode")) next(6); return; }
        if (step >= 6 && step <= 8) { if (press("selection", {}, target(confirmTargets, step - 6), true)) next(step + 1); return; }
        if (step == 9) { require(selectedIds() == selected, "CANDIDATE_BATCH_SELECTION"); openPreview("memoryCandidateConfirmSelected", 10); return; }
        if (step == 10) {
            if (!previewReady(true, 3)) return;
            observed["initialPreviewId"] = previewId;
            cancelledWrites = batch().value("dispatchCount").toInt();
            next(11); return;
        }
        if (step == 11) { if (captureDialog("confirm")) { record("candidate-batch-preview-reads-authoritative-counts"); next(12); } return; }
        if (step == 12) { if (press("memoryCandidateBatchCancel")) next(13); return; }
        if (step == 13) {
            require(clock.elapsed() - at < 4000, "CANDIDATE_BATCH_CANCEL_CLOSE_DEADLINE");
            require(batch().value("dispatchCount").toInt() == cancelledWrites && selectedIds() == selected && selectionMode(),
                    "CANDIDATE_BATCH_CANCEL_CHANGED_STATE");
            auto *tasks = item("memoryTasks");
            const auto dialogs = tasks ? tasks->findChildren<QObject *>("memoryCandidateBatchDialog") : QList<QObject *>{};
            require(dialogs.size() == 1, "CANDIDATE_BATCH_CANCEL_DIALOG_IDENTITY");
            if (dialogs.front()->property("visible").toBool() || dialogs.front()->property("opened").toBool()) return;
            require(batch().value("status") == "idle", "CANDIDATE_BATCH_CANCEL_PREVIEW_NOT_RELEASED");
            observed["cancelWriteDelta"] = 0;
            record("candidate-batch-cancel-keeps-selection-with-zero-writes"); next(14); return;
        }
        if (step == 14) { openPreview("memoryCandidateConfirmSelected", 15); return; }
        if (step == 15) {
            if (!previewReady(true, 3)) return;
            require(previewId != observed.value("initialPreviewId"), "CANDIDATE_BATCH_PREVIEW_REUSED");
            next(16); return;
        }
        if (step == 16) { submit(17); return; }
        if (step == 17) { if (successful(true, {130, 129, 128})) {
            record("candidate-batch-confirm-ack-and-three-reads");
            record("candidate-batch-confirm-page-and-first-feedback-whole-visible");
            selected = rejectTargets; next(18); } return; }
        if (step == 18) { if (press("memoryCandidateSelectMode")) next(19); return; }
        if (step == 19 || step == 20) { if (press("selection", {}, target(rejectTargets, step - 19), true)) next(step + 1); return; }
        if (step == 21) { require(selectedIds() == selected, "CANDIDATE_BATCH_SELECTION"); openPreview("memoryCandidateRejectSelected", 22); return; }
        if (step == 22) { if (previewReady(false, 2)) next(23); return; }
        if (step == 23) { if (captureDialog("reject-confirm")) next(24); return; }
        if (step == 24) { submit(25); return; }
        if (step == 25) { if (successful(false, {130, 129, 128, 127, 126})) {
            record("candidate-batch-reject-ack-and-three-reads");
            record("candidate-batch-reject-page-and-first-feedback-whole-visible"); next(26); } return; }
        if (step == 26) {
            const auto finalIds = candidateIds();
            for (const auto &id : confirmTargets + rejectTargets)
                require(!finalIds.contains(id), "CANDIDATE_BATCH_DECIDED_STILL_PENDING", {{"id", id}});
            require(candidateTexts() == expectedFirstPage({130, 129, 128, 127, 126}) && actions.size() == 2 &&
                    finalIds == expectedFirstPageIds(confirmTargets + rejectTargets) &&
                    !selectionMode() && selectedIds().isEmpty(), "CANDIDATE_BATCH_SELECTION_NOT_FINISHED");
            record("candidate-batch-final-pages-and-selection-finished"); next(27); return;
        }
        if (step == 27) { if (press("memory-close")) next(28); return; }
        if (step == 28) { require(clock.elapsed() - at < 4000, "CANDIDATE_BATCH_CLOSE_DEADLINE"); if (closed()) finish(true); }
    }
};
}
namespace MemoryCandidateBatchCheck {
void run(QQuickWindow *window, RuntimeBridge *session, const QStringList &baselineCandidateIds, const QString &prefix,
         std::function<void(QVariantMap)> done) {
    new Check(window, session, baselineCandidateIds, prefix, std::move(done));
}
}
