#include "MemoryBatchPinCheck.h"
#include "MemoryPageCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"
#include <QElapsedTimer>
#include <QQuickWindow>
#include <QSet>
#include <QJSValue>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

namespace {
class Check final : public QObject {
    using Action = NativeControlReadiness::SequentialGate::Action;
    QQuickWindow *w;
    RuntimeBridge *s;
    bool restart, executing = false;
    QString scope, prefix, readId, previewId, batchId;
    int generation, step = 0, initialWrites, initialReads, cancelledWrites = 0;
    QStringList baseline, targets, selected, beforeMessages;
    QVariantMap observed, beforePins;
    QVariantList checks, inputs, receipts, actions, listReads;
    QTimer timer;
    QElapsedTimer clock;
    qint64 at = 0;
    quint64 frame = 0;
    NativeControlReadiness::SequentialGate gate;
    SummaryInteractionProbe::StableGate stable, explanationStable;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, bool verify, QStringList ids, QString capture,
          std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), restart(verify), scope(session->scopeKey()),
          prefix(std::move(capture)), generation(session->generation()), baseline(std::move(ids)),
          initialWrites(session->memoryBatchPin().value("dispatchCount").toInt()),
          initialReads(session->memoryBatchPin().value("statusReadDispatchCount").toInt()), done(std::move(completion)) {
        clock.start();
        beforeMessages = messageIds();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &result, int g) {
                if (g != generation || s->scopeKey() != scope ||
                    !QStringList{"memory:pin_status", "memory:pin_many", "memory:list"}.contains(command)) return;
                if (receipts.size() >= 24) { finish(false, "BATCH_PIN_RECEIPT_BOUND"); return; }
                QVariantMap value{{"requestId", id}, {"command", command}, {"generation", g}, {"scope", scope}};
                for (const auto *key : {"ok", "memory_ids", "pinned", "states", "stale_ids", "pinned_total", "pin_limit",
                                       "changed_ids", "unchanged_ids", "pinned_total_before", "pinned_total_after"})
                    if (result.contains(key)) value[key] = result.value(key);
                if (command == "memory:list") value["pins"] = pinMap(result.value("memories").toList());
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
    int deadline() const { return restart ? 10000 : 30000; }
    void require(bool value, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(value, code, details);
    }
    QQuickItem *item(const QString &name) const {
        auto *root = w->contentItem();
        if (!name.startsWith("memoryBatchPin") &&
            !QStringList{"memoryTasks", "nav-memory", "archive-open-memories", "memory-close", "drawer-memory"}.contains(name))
            root = NativeCheck::findVisual(root, "memoryTasks").item;
        return NativeCheck::findVisual(root, name, true).item;
    }
    QVariantMap batch() const { return s->memoryBatchPin(); }
    QVariantMap feedback(const QString &key) const { return s->memoryFeedback().value(key).toMap(); }
    QVariantMap list() const { return s->state().value("memory").toMap(); }
    QVariantList rows() const { return list().value("memories").toList(); }
    QStringList ids() const { QStringList out; for (const auto &row : rows()) out.append(row.toMap().value("id").toString()); return out; }
    QStringList messageIds() const { QStringList out; for (const auto &row : s->messages()) out.append(row.toMap().value("id").toString()); return out; }
    static QVariantMap pinMap(const QVariantList &values) {
        QVariantMap out;
        for (const auto &value : values) { const auto row = value.toMap(); out[row.value("id").toString()] = row.value("pinned"); }
        return out;
    }
    QStringList selectedIds() const {
        auto *tasks = item("memoryTasks"); const auto v = tasks ? tasks->property("memorySelectedIds") : QVariant{};
        return (v.metaType().id() == qMetaTypeId<QJSValue>() ? v.value<QJSValue>().toVariant() : v).toStringList();
    }
    bool selectionMode() const { auto *tasks = item("memoryTasks"); return tasks && tasks->property("memorySelectionMode").toBool(); }
    bool opened() const { auto *i = item("drawer-memory"); return i && i->property("inputReady").toBool(); }
    bool closed() const { auto i = NativeCheck::findVisual(w->contentItem(), "drawer-memory").item; return !i || i->property("progress").toDouble() == 0; }
    void next(int value) { step = value; at = clock.elapsed(); gate.resetForNextStep(); stable.reset(); explanationStable.reset(); }
    void record(const QString &name) {
        for (const auto &check : checks) require(check.toMap().value("name") != name, "BATCH_PIN_CHECK_DUPLICATED");
        checks.append(QVariantMap{{"name", name}, {"passed", true}});
    }
    // `old` is a by-value snapshot: callers pass the readId member itself.
    void ownRead(QString old) {
        const QString fresh = feedback("list").value("requestId").toString();
        listReads.append(QVariantMap{{"step", step}, {"oldId", old}, {"newId", fresh}});
        require(!fresh.isEmpty() && fresh != old, "BATCH_PIN_READ_NOT_NEW");
        readId = fresh;
    }
    bool readyRead() {
        require(clock.elapsed() - at < 10000, "BATCH_PIN_READ_DEADLINE");
        if (feedback("list").value("status") == "pending") return false;
        require(feedback("list").value("status") == "success" && feedback("list").value("requestId") == readId,
                "BATCH_PIN_READ_UNCONFIRMED");
        return true;
    }
    QString selectionControl(const QString &id) const { const int index = ids().indexOf(id); return index < 0 ? QString() : "memorySelect" + QString::number(index); }
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
        require(!reveal.value("expired").toBool() && elapsed() < 4000, "BATCH_PIN_INPUT_DEADLINE");
        if (!wholeTarget || locate() != wholeTarget || !reveal.value("geometryValid").toBool()) {
            stable.reset(); w->update(); return false;
        }
        Action action{name, locate,
            [this, name](QQuickItem *control) {
                const bool surface = name == "nav-memory" ? closed() : opened();
                return stable.observe(inspect(control, surface), clock.elapsed() - at, frame);
            }, [this, locate, after, checkbox, targetId, name](QQuickItem *control) {
                require(clock.elapsed() - at < 4000 && clock.elapsed() < deadline(), "BATCH_PIN_INPUT_DEADLINE");
                const auto fresh = inspect(control, opened() || closed());
                require(locate() == control && stable.matches(fresh), "BATCH_PIN_INPUT_TARGET_CHANGED");
                if (!targetId.isEmpty()) require(control->property("memoryId").toString() == targetId,
                                                "BATCH_PIN_ROW_ID_MISMATCH", {{"id", targetId}});
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
                require(hit.accepted(), "BATCH_PIN_INPUT_HIT", hit.metadata());
                QSignalSpy clicked(control, SIGNAL(clicked()));
                QSignalSpy toggled(control, SIGNAL(toggled()));
                require(clicked.isValid() && (!checkbox || toggled.isValid()), "BATCH_PIN_SIGNAL_OBSERVER");
                require(clock.elapsed() - at < 4000 && clock.elapsed() < deadline(), "BATCH_PIN_INPUT_DEADLINE");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                NativeCheck::InputSignals counts{true, 1, clicked.count(), toggled.isValid() ? std::optional<qint64>(toggled.count()) : std::nullopt};
                const auto kind = checkbox ? NativeCheck::ControlKind::Switch
                    : name == "memoryTab-memories" ? NativeCheck::ControlKind::Tab : NativeCheck::ControlKind::Button;
                require(NativeCheck::inputContractFailure(kind, counts).isEmpty(), "BATCH_PIN_INPUT_SIGNAL",
                        NativeCheck::describeSignals(kind, counts));
                if (checkbox) require(control->property("checked").toBool(), "BATCH_PIN_CHECK_NOT_SELECTED");
                inputs.append(QVariantMap{{"step", step}, {"id", targetId}, {"control", control->objectName()},
                    {"signals", NativeCheck::describeSignals(kind, counts)}, {"layout", stable.metadata()}, {"hit", hit.metadata()}});
                if (after) after();
            }};
        const auto state = gate.poll([this] { return clock.elapsed() >= deadline() ? qint64(4000) : clock.elapsed() - at; }, 4000, {action});
        require(state != NativeControlReadiness::SequentialGate::Expired && state != NativeControlReadiness::SequentialGate::Failed,
                "BATCH_PIN_INPUT_UNAVAILABLE", gate.metadata());
        w->update();
        return state == NativeControlReadiness::SequentialGate::Performed;
    }
    bool previewReady(bool target, int expectedChanges) {
        require(clock.elapsed() - at < 10000, "BATCH_PIN_PREVIEW_DEADLINE");
        const auto b = batch();
        if (b.value("status") == "previewing") return false;
        require(b.value("status") == "ready" && b.value("confirmationReady").toBool() &&
                b.value("ids").toStringList() == selected && b.value("pinned").toBool() == target &&
                b.value("previewRequestId") == previewId && b.value("expectedChangedCount").toInt() == expectedChanges &&
                b.value("selectedCount").toInt() == selected.size() && b.value("pinLimit").toInt() == 20,
                "BATCH_PIN_PREVIEW_MISMATCH", b);
        const auto *label = item("memoryBatchPinCount");
        require(label && label->property("text").toString().contains("预计"), "BATCH_PIN_PREVIEW_NOT_ESTIMATED");
        observed["lastPreview"] = QVariantMap{{"selectedCount", b.value("selectedCount")},
            {"expectedChangedCount", b.value("expectedChangedCount")}, {"pinnedTotal", b.value("pinnedTotal")},
            {"pinLimit", b.value("pinLimit")}, {"ready", b.value("confirmationReady")}};
        return true;
    }
    void openPreview(const QString &control, int nextStep) {
        const auto old = batch().value("previewRequestId").toString();
        const int count = batch().value("statusReadDispatchCount").toInt();
        if (press(control, [this, old, count] {
            previewId = batch().value("previewRequestId").toString();
            require(!previewId.isEmpty() && previewId != old && batch().value("statusReadDispatchCount").toInt() == count + 1,
                    "BATCH_PIN_PREVIEW_NOT_DISPATCHED");
        })) next(nextStep);
    }
    void submit(int nextStep) {
        const auto old = batch().value("requestId").toString();
        const int count = batch().value("dispatchCount").toInt();
        if (press("memoryBatchPinConfirm", [this, old, count] {
            batchId = batch().value("requestId").toString();
            require(!batchId.isEmpty() && batchId != old && batch().value("dispatchCount").toInt() == count + 1,
                    "BATCH_PIN_WRITE_NOT_UNIQUE");
        })) next(nextStep);
    }
    bool successful(bool target, int changed) {
        require(clock.elapsed() - at < 10000, "BATCH_PIN_WRITE_READ_DEADLINE");
        const auto b = batch();
        if (b.value("busy").toBool()) return false;
        require(b.value("status") == "success" && b.value("requestId") == batchId &&
                b.value("pinned").toBool() == target && b.value("ids").toStringList() == selected &&
                b.value("actualChangedCount").toInt() == changed && !b.value("blocked").toBool() &&
                !b.value("statusReadId").toString().isEmpty() && !b.value("listReadId").toString().isEmpty() &&
                feedback("list").value("status") == "success" && feedback("list").value("requestId") == b.value("listReadId") &&
                ids() == baseline.mid(0, 100) && selectedIds().isEmpty() && !selectionMode(),
                "BATCH_PIN_SUCCESS_BARRIER", b);
        auto *label = item("memoryBatchPinFeedback");
        const auto elapsed = [this] { return clock.elapsed() - at; };
        const auto reveal = NativeControlReadiness::revealWholeItem(label, elapsed, 10000);
        observed["lastFeedbackGeometry"] = QVariantMap{{"elapsedMs", elapsed()}, {"windowWidth", w->width()},
            {"windowHeight", w->height()}, {"revealSummary", NativeControlReadiness::revealSummary(reveal)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(label, w)}};
        require(elapsed() < 10000, "BATCH_PIN_FEEDBACK_DEADLINE");
        if (!stable.observe(inspect(label, opened()), elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        require(label && label->property("text").toString().contains(QString::number(changed) + "条"), "BATCH_PIN_ACTUAL_FEEDBACK_COUNT");
        const auto capture = w->grabWindow();
        const auto contrast = NativeCheck::renderedTextContrast(capture, label);
        require(contrast.value("contrast").toDouble() >= 4.5 && contrast.value("pixelCount").toInt() > 0, "BATCH_PIN_FEEDBACK_CONTRAST", contrast);
        require(capture.save(prefix + (target ? ".memory-batch-pin-success.png" : ".memory-batch-pin-unpin-success.png")), "BATCH_PIN_FEEDBACK_CAPTURE");
        readId = b.value("listReadId").toString();
        actions.append(QVariantMap{{"requestId", batchId}, {"previewRequestId", previewId},
            {"statusReadId", b.value("statusReadId")}, {"listReadId", readId}, {"ids", selected},
            {"pinned", target}, {"changed", changed}, {"status", b.value("status")},
            {"feedbackWholeVisible", true}, {"feedbackContrast", contrast}});
        return true;
    }
    bool captureDialog(const QString &suffix) {
        const auto elapsed = [this] { return clock.elapsed() - at; };
        auto *count = item("memoryBatchPinCount");
        auto *explanation = item("memoryBatchPinExplanation");
        const auto reveal = NativeControlReadiness::revealWholeItem(explanation, elapsed, 4000);
        observed["lastDialogGeometry"] = QVariantMap{{"elapsedMs", elapsed()}, {"windowWidth", w->width()},
            {"windowHeight", w->height()}, {"revealSummary", NativeControlReadiness::revealSummary(reveal)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(explanation, w)}};
        require(elapsed() < 4000, "BATCH_PIN_DIALOG_DEADLINE");
        if (!stable.observe(inspect(count, opened()), elapsed(), frame).value("ready").toBool() ||
            !explanationStable.observe(inspect(explanation, opened()), elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        const auto image = w->grabWindow();
        QVariantList contrast;
        for (const auto *name : {"memoryBatchPinCount", "memoryBatchPinExplanation"}) {
            const auto value = NativeCheck::renderedTextContrast(image, item(name));
            require(value.value("contrast").toDouble() >= 4.5 && value.value("pixelCount").toInt() > 0, "BATCH_PIN_CONTRAST", value);
            contrast.append(value);
        }
        observed[suffix + "Contrast"] = contrast;
        require(image.save(prefix + ".memory-batch-pin-" + suffix + ".png"), "BATCH_PIN_CAPTURE_FAILED");
        return true;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        observed.insert({{"scope", scope}, {"generation", generation}, {"targetIds", targets}, {"baselineIds", baseline},
            {"beforePins", beforePins}, {"finalPins", pinMap(rows())}, {"remainingIds", ids()},
            {"beforeMessageIds", beforeMessages}, {"finalMessageIds", messageIds()},
            {"writeDispatchDelta", batch().value("dispatchCount").toInt() - initialWrites},
            {"statusReadDispatchDelta", batch().value("statusReadDispatchCount").toInt() - initialReads},
            {"receipts", receipts}, {"actions", actions}, {"listReads", listReads}, {"selectionEmpty", selectedIds().isEmpty()},
            {"selectionMode", selectionMode()}, {"terminalStatus", batch().value("status")}, {"surfaceClosed", closed()}});
        auto callback = std::move(done);
        if (callback) callback({{"passed", passed}, {"error", error}, {"step", step}, {"checks", checks},
            {"observed", observed}, {"inputs", inputs}, {"inputCurrent", gate.metadata()},
            {"elapsedMs", clock.elapsed()}, {"deadlineMs", deadline()}, {"contentCollected", false}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < deadline() && s->scopeKey() == scope && s->generation() == generation, "BATCH_PIN_DEADLINE_OR_SCOPE");
        require(messageIds() == beforeMessages, "BATCH_PIN_MESSAGES_CHANGED");
        if (step == 0) { if (press("nav-memory")) next(1); return; }
        if (step == 1) { if (press("archive-open-memories")) next(2); return; }
        if (step == 2) { if (press("memoryTab-memories")) next(3); return; }
        if (step == 3) {
            require(clock.elapsed() - at < 10000, "BATCH_PIN_INITIAL_READ_DEADLINE");
            if (feedback("list").value("status") == "pending") return;
            require(s->memoryQuery().isEmpty() && item("memoryTabs") && item("memoryTabs")->property("currentIndex").toInt() == 0, "BATCH_PIN_PAGE_NOT_SELECTED");
            readId = feedback("list").value("requestId").toString();
            if (press("memoryRefresh", [this] { ownRead(readId); })) next(4);
            return;
        }
        if (step == 4) { if (readyRead()) { require(ids() == baseline.mid(0, 100), "BATCH_PIN_FIRST_PAGE_CHANGED"); next(5); } return; }
        if (step == 5) { if (press("memoryLoadMore", [this] { ownRead(readId); })) next(6); return; }
        if (step == 6) {
            if (!readyRead()) return;
            require(baseline.size() == 127 && ids() == baseline && !list().value("hasMore").toBool(), "BATCH_PIN_BASELINE_CHANGED");
            beforePins = pinMap(rows());
            for (int number : MemoryBatchPinCheck::Numbers) {
                QString id;
                for (const auto &v : rows()) {
                    const auto row = v.toMap();
                    if (row.value("text") != MemoryPageCheck::seededText(number)) continue;
                    require(id.isEmpty() && row.value("pinned").metaType().id() == QMetaType::Bool &&
                            row.value("pinned").toBool() == (restart && number == 126), "BATCH_PIN_SEED_STATE");
                    id = row.value("id").toString();
                }
                require(!id.isEmpty(), "BATCH_PIN_SEED_MISSING"); targets.append(id);
            }
            selected = targets; next(7); return;
        }
        if (step == 7) { if (press("memorySelectMode")) next(8); return; }
        if (step >= 8 && step <= 10) { if (press("selection", {}, targets[step - 8], true)) next(step + 1); return; }
        if (step == 11) { require(selectedIds() == selected, "BATCH_PIN_SELECTION"); openPreview("memoryPinSelected", 12); return; }
        if (step == 12) {
            if (!previewReady(true, restart ? 2 : 3)) return;
            observed["initialPreviewId"] = previewId;
            observed["initialPinnedTotal"] = batch().value("pinnedTotal");
            cancelledWrites = batch().value("dispatchCount").toInt();
            next(restart ? 13 : 112); return;
        }
        if (step == 112) {
            if (captureDialog("confirm")) { record("baseline-and-authoritative-preview"); next(13); }
            return;
        }
        if (step == 13) { if (press("memoryBatchPinCancel")) next(14); return; }
        if (step == 14) {
            require(clock.elapsed() - at < 4000, "BATCH_PIN_CANCEL_CLOSE_DEADLINE");
            require(batch().value("dispatchCount").toInt() == cancelledWrites && ids() == baseline && selectedIds() == targets,
                    "BATCH_PIN_CANCEL_CHANGED_STATE");
            auto *tasks = item("memoryTasks");
            const auto dialogs = tasks ? tasks->findChildren<QObject *>("memoryBatchPinDialog") : QList<QObject *>{};
            require(dialogs.size() == 1, "BATCH_PIN_CANCEL_DIALOG_IDENTITY");
            if (dialogs.front()->property("visible").toBool() || dialogs.front()->property("opened").toBool()) return;
            require(batch().value("status") == "idle", "BATCH_PIN_CANCEL_PREVIEW_NOT_RELEASED");
            observed["cancelWriteDelta"] = 0;
            if (restart) {
                if (press("memorySelectionCancel")) { record("restart-pins-and-identities-read-back"); next(31); }
            } else next(15);
            return;
        }
        if (step == 15) {
            require(selectedIds() == targets && batch().value("dispatchCount").toInt() == cancelledWrites, "BATCH_PIN_CANCEL_NOT_PRESERVED");
            openPreview("memoryPinSelected", 16);
            if (step == 16) record("cancel-preserves-selection-with-zero-writes");
            return;
        }
        if (step == 16) { if (previewReady(true, 3)) { require(previewId != observed.value("initialPreviewId"), "BATCH_PIN_PREVIEW_REUSED"); next(17); } return; }
        if (step == 17) { submit(18); return; }
        if (step == 18) { if (successful(true, 3)) next(19); return; }
        if (step == 19) { if (press("memoryLoadMore", [this] { ownRead(readId); })) next(20); return; }
        if (step == 20) {
            if (!readyRead()) return;
            require(ids() == baseline, "BATCH_PIN_AFTER_PIN_ORDER");
            auto expected = beforePins; for (const auto &id : targets) expected[id] = true;
            require(pinMap(rows()) == expected, "BATCH_PIN_AFTER_PIN_STATES");
            observed["afterPinIds"] = ids(); observed["afterPinStates"] = pinMap(rows());
            record("pin-ack-and-two-authoritative-reads"); selected = targets.mid(1); next(21); return;
        }
        if (step == 21) { if (press("memorySelectMode")) next(22); return; }
        if (step == 22 || step == 23) { if (press("selection", {}, selected[step - 22], true)) next(step + 1); return; }
        if (step == 24) { openPreview("memoryUnpinSelected", 25); return; }
        if (step == 25) { if (previewReady(false, 2)) next(125); return; }
        if (step == 125) { if (captureDialog("unpin-confirm")) next(26); return; }
        if (step == 26) { submit(27); return; }
        if (step == 27) { if (successful(false, 2)) next(28); return; }
        if (step == 28) { if (press("memoryLoadMore", [this] { ownRead(readId); })) next(29); return; }
        if (step == 29) {
            if (!readyRead()) return;
            require(ids() == baseline, "BATCH_PIN_AFTER_UNPIN_ORDER");
            auto expected = beforePins; expected[targets[0]] = true;
            require(pinMap(rows()) == expected, "BATCH_PIN_AFTER_UNPIN_STATES");
            record("unpin-ack-and-two-authoritative-reads"); next(30); return;
        }
        if (step == 30) {
            require(!selectionMode() && selectedIds().isEmpty() && actions.size() == 2, "BATCH_PIN_SELECTION_NOT_FINISHED");
            record("remaining-identities-and-selection-finished"); next(31); return;
        }
        if (step == 31) { if (press("memory-close")) next(32); return; }
        if (step == 32) { require(clock.elapsed() - at < 4000, "BATCH_PIN_CLOSE_DEADLINE"); if (closed()) finish(true); }
    }
};
}
namespace MemoryBatchPinCheck {
void run(QQuickWindow *window, RuntimeBridge *session, bool restart, const QStringList &baselineIds,
         const QString &prefix, std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, baselineIds, prefix, std::move(done));
}
}
