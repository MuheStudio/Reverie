#include "MemoryBatchDeleteCheck.h"
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
    QString scope, prefix, readId, batchId;
    int generation, step = 0, cancelCommands = 0, batchDispatches = 0, responses = 0;
    QStringList baseline, targets, remaining;
    QVariantMap observed;
    QVariantList checks, inputs;
    QTimer timer;
    QElapsedTimer clock;
    qint64 at = 0;
    quint64 frame = 0;
    bool executing = false;
    NativeControlReadiness::SequentialGate gate;
    SummaryInteractionProbe::StableGate stable, explanationStable;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, QStringList ids, QString capture,
          std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), scope(session->scopeKey()), prefix(std::move(capture)),
          generation(session->generation()), baseline(std::move(ids)), done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &result, int g) {
                if (g != generation || s->scopeKey() != scope || command != "memory:delete_many") return;
                ++responses;
                observed["responseId"] = id;
                observed["responseOk"] = result.value("ok").metaType().id() == QMetaType::Bool && result.value("ok").toBool();
                observed["responseIdsMatch"] = result.value("deleted_ids").toStringList() == targets;
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
    void require(bool value, const QString &code, const QVariantMap &details = {}) const {
        auto actual = details;
        actual.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"scope", s->scopeKey()},
                       {"generation", s->generation()}});
        NativeCheck::require(value, code, actual);
    }
    QQuickItem *item(const QString &name) const { return NativeCheck::findVisual(w->contentItem(), name, true).item; }
    QVariantMap feedback(const QString &key) const { return s->memoryFeedback().value(key).toMap(); }
    QVariantMap batch() const { return s->diagnostics().value("memoryBatchDelete").toMap(); }
    QVariantMap list() const { return s->state().value("memory").toMap(); }
    QVariantList rows() const { return list().value("memories").toList(); }
    QStringList ids() const {
        QStringList out;
        for (const auto &row : rows()) out.append(row.toMap().value("id").toString());
        return out;
    }
    QStringList selectedIds() const {
        auto *tasks = item("memoryTasks");
        const auto value = tasks ? tasks->property("memorySelectedIds") : QVariant{};
        return (value.metaType().id() == qMetaTypeId<QJSValue>() ? value.value<QJSValue>().toVariant() : value).toStringList();
    }
    bool opened() const { auto *i = item("drawer-memory"); return i && i->property("inputReady").toBool(); }
    bool closed() const { auto *i = item("drawer-memory"); return !i || i->property("progress").toDouble() == 0; }
    void next(int value) { step = value; at = clock.elapsed(); gate.resetForNextStep(); stable.reset(); explanationStable.reset(); }
    void record(const QString &name) {
        for (const auto &check : checks)
            require(check.toMap().value("name").toString() != name,
                    "BATCH_MEMORY_CHECK_DUPLICATED", {{"name", name}});
        checks.append(QVariantMap{{"name", name}, {"passed", true}});
    }
    int commands() const { return s->diagnostics().value("commands").toInt(); }
    bool readyRead() {
        require(clock.elapsed() - at < 10000, "BATCH_MEMORY_READ_DEADLINE");
        const auto receipt = feedback("list");
        if (receipt.value("status") == "pending") return false;
        require(receipt.value("status") == "success" && receipt.value("requestId") == readId,
                "BATCH_MEMORY_READ_UNCONFIRMED", receipt);
        return true;
    }
    void ownRead(QString old) {
        readId = feedback("list").value("requestId").toString();
        require(!readId.isEmpty() && readId != old, "BATCH_MEMORY_READ_NOT_DISPATCHED", {{"oldId", old}, {"newId", readId}});
    }
    QString selectionControl(const QString &id) const {
        const auto current = ids();
        const auto index = current.indexOf(id);
        return index < 0 ? QString() : "memorySelect" + QString::number(index);
    }
    bool press(const QString &name, const std::function<void()> &after = {}, const QString &targetId = {}, bool checkbox = false) {
        const auto locate = [this, name, targetId] { return item(targetId.isEmpty() ? name : selectionControl(targetId)); };
        Action action{name, locate,
            [this, name](QQuickItem *control) {
                const bool surface = name == "nav-memory" ? closed() : opened();
                return stable.observe(SummaryInteractionProbe::inspect(control, w, surface, scope), clock.elapsed() - at, frame);
            }, [this, locate, after, checkbox, targetId, name](QQuickItem *control) {
                require(clock.elapsed() - at < 4000 && clock.elapsed() < 30000, "BATCH_MEMORY_INPUT_DEADLINE");
                const auto fresh = SummaryInteractionProbe::inspect(control, w, opened() || closed(), scope);
                require(locate() == control && stable.matches(fresh), "BATCH_MEMORY_INPUT_TARGET_CHANGED");
                if (!targetId.isEmpty()) require(control->property("memoryId").toString() == targetId,
                                                "BATCH_MEMORY_ROW_ID_MISMATCH", {{"id", targetId}});
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
                require(hit.accepted(), "BATCH_MEMORY_INPUT_HIT", hit.metadata());
                QSignalSpy clicked(control, SIGNAL(clicked()));
                QSignalSpy toggled(control, SIGNAL(toggled()));
                require(clicked.isValid() && (!checkbox || toggled.isValid()), "BATCH_MEMORY_SIGNAL_OBSERVER");
                require(clock.elapsed() - at < 4000 && clock.elapsed() < 30000, "BATCH_MEMORY_INPUT_DEADLINE");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                NativeCheck::InputSignals counts{true, 1, clicked.count(), toggled.isValid() ? std::optional<qint64>(toggled.count()) : std::nullopt};
                const auto kind = checkbox ? NativeCheck::ControlKind::Switch
                    : name == "memoryTab-memories" ? NativeCheck::ControlKind::Tab : NativeCheck::ControlKind::Button;
                require(NativeCheck::inputContractFailure(kind, counts).isEmpty(), "BATCH_MEMORY_INPUT_SIGNAL",
                        NativeCheck::describeSignals(kind, counts));
                if (checkbox) require(control->property("checked").toBool(), "BATCH_MEMORY_CHECK_NOT_SELECTED");
                inputs.append(QVariantMap{{"step", step}, {"id", targetId}, {"control", control->objectName()},
                    {"signals", NativeCheck::describeSignals(kind, counts)}, {"layout", stable.metadata()}, {"hit", hit.metadata()}});
                if (after) after();
            }};
        const auto state = gate.poll([this] { return clock.elapsed() >= 30000 ? qint64(4000) : clock.elapsed() - at; }, 4000, {action});
        require(state != NativeControlReadiness::SequentialGate::Expired && state != NativeControlReadiness::SequentialGate::Failed,
                "BATCH_MEMORY_INPUT_UNAVAILABLE", gate.metadata());
        w->update();
        return state == NativeControlReadiness::SequentialGate::Performed;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        observed["terminalStatus"] = batch().value("status");
        observed["responseCount"] = responses;
        auto callback = std::move(done);
        if (callback) callback({{"passed", passed}, {"error", error}, {"step", step}, {"checks", checks},
            {"observed", observed}, {"inputs", inputs}, {"inputCurrent", gate.metadata()},
            {"elapsedMs", clock.elapsed()}, {"deadlineMs", 30000}, {"contentCollected", false}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < 30000 && s->scopeKey() == scope && s->generation() == generation,
                "BATCH_MEMORY_DEADLINE_OR_SCOPE_CHANGED");
        if (step == 0) { if (press("nav-memory")) next(1); return; }
        if (step == 1) { if (press("archive-open-memories")) next(21); return; }
        // The preceding archive/restore flow leaves the backup tab selected.
        // Reopening the drawer preserves that state; choose the management tab
        // through its real control before asserting the selected-page contract.
        if (step == 21) { if (press("memoryTab-memories")) next(2); return; }
        if (step == 2) {
            require(clock.elapsed() - at < 10000, "BATCH_MEMORY_INITIAL_READ_DEADLINE");
            if (feedback("list").value("status") == "pending" || feedback("candidates").value("status") == "pending") return;
            require(item("memoryTabs") && item("memoryTabs")->property("currentIndex").toInt() == 0 && s->memoryQuery().isEmpty(),
                    "BATCH_MEMORY_PAGE_NOT_SELECTED");
            readId = feedback("list").value("requestId").toString();
            if (press("memoryRefresh", [this] { ownRead(readId); })) next(3);
            return;
        }
        if (step == 3) { if (readyRead()) { require(ids() == baseline.mid(0, 100), "BATCH_MEMORY_FIRST_PAGE_CHANGED"); next(4); } return; }
        if (step == 4) { if (press("memoryLoadMore", [this] { ownRead(readId); })) next(5); return; }
        if (step == 5) {
            if (!readyRead()) return;
            require(ids() == baseline && baseline.size() == 130 && !list().value("hasMore").toBool(), "BATCH_MEMORY_BASELINE_CHANGED");
            for (int number : MemoryBatchDeleteCheck::Numbers) {
                QString id;
                for (const auto &value : rows()) {
                    const auto row = value.toMap();
                    if (row.value("text") == MemoryPageCheck::seededText(number)) {
                        require(id.isEmpty() && row.value("pinned").toBool() == (number == 130), "BATCH_MEMORY_TARGET_FIXTURE");
                        id = row.value("id").toString();
                    }
                }
                require(!id.isEmpty(), "BATCH_MEMORY_TARGET_MISSING", {{"number", number}}); targets.append(id);
            }
            remaining = baseline; for (const auto &id : targets) remaining.removeAll(id);
            observed.insert({{"baselineIds", baseline}, {"deletedIds", targets}, {"expectedRemainingIds", remaining}, {"pinnedCount", 1}});
            record("baseline-and-three-independent-targets"); next(6); return;
        }
        if (step == 6) { if (press("memorySelectMode")) next(7); return; }
        if (step >= 7 && step <= 9) { if (press("selection", {}, targets[step - 7], true)) next(step + 1); return; }
        if (step == 10) {
            require(selectedIds() == targets, "BATCH_MEMORY_SELECTION_MISMATCH");
            cancelCommands = commands();
            if (press("memoryDeleteSelected")) next(11); return;
        }
        if (step == 11) {
            require(clock.elapsed() - at < 4000, "BATCH_MEMORY_DIALOG_READINESS_DEADLINE");
            auto *tasks = item("memoryTasks");
            const auto popups = tasks ? tasks->findChildren<QObject *>("memoryBatchDeleteDialog") : QList<QObject *>{};
            require(popups.size() == 1, "BATCH_MEMORY_DIALOG_IDENTITY", {{"matches", popups.size()}});
            const bool shown = popups.front()->property("visible").toBool() && popups.front()->property("opened").toBool();
            auto *count = item("memoryBatchDeleteCount");
            auto *explanation = item("memoryBatchDeleteExplanation");
            const auto qualification = stable.observe(SummaryInteractionProbe::inspect(count, w, opened() && shown, scope), clock.elapsed() - at, frame);
            const auto explanationQualification = explanationStable.observe(SummaryInteractionProbe::inspect(explanation, w, opened() && shown, scope), clock.elapsed() - at, frame);
            if (!qualification.value("ready").toBool() || !explanationQualification.value("ready").toBool()) { w->update(); return; }
            require(count && count->property("text").toString() == "将删除3条记忆，其中已固定1条。" &&
                    explanation && explanation->property("text").toString() == "会清除这些记忆及其全部修订，无法恢复。",
                    "BATCH_MEMORY_CONFIRMATION_COUNTS");
            const auto capture = w->grabWindow();
            QVariantList contrasts;
            for (const auto *name : {"memoryBatchDeleteCount", "memoryBatchDeleteExplanation"}) {
                const auto measured = NativeCheck::renderedTextContrast(capture, item(name));
                require(measured.contains("contrast") && measured.value("contrast").toDouble() >= 4.5,
                        "BATCH_MEMORY_CONFIRMATION_CONTRAST", measured); contrasts.append(measured);
            }
            observed["labelContrast"] = contrasts;
            require(capture.save(prefix + ".memory-batch-delete-confirmation.png"), "BATCH_MEMORY_SCREENSHOT_FAILED");
            record("confirmation-counts-and-rendered-labels"); next(12); return;
        }
        if (step == 12) { if (press("memoryBatchDeleteCancel")) next(13); return; }
        if (step == 13) {
            require(commands() == cancelCommands && ids() == baseline && selectedIds() == targets,
                    "BATCH_MEMORY_CANCEL_CHANGED_STATE", {{"commandDelta", commands() - cancelCommands}});
            observed["cancelCommandDelta"] = 0;
            if (press("memoryDeleteSelected")) {
                record("cancel-preserves-selection-with-zero-commands");
                next(14);
            }
            return;
        }
        if (step == 14) {
            const auto oldBatch = batch().value("requestId").toString();
            batchDispatches = batch().value("dispatchCount").toInt();
            if (press("memoryBatchDeleteConfirm", [this, oldBatch] {
                    batchId = batch().value("requestId").toString();
                    require(!batchId.isEmpty() && batchId != oldBatch && batch().value("dispatchCount").toInt() == batchDispatches + 1 &&
                            batch().value("ids").toStringList() == targets, "BATCH_MEMORY_REQUEST_NOT_UNIQUE", batch());
                    observed["requestId"] = batchId; observed["dispatchDelta"] = 1;
                })) next(15);
            return;
        }
        if (step == 15) {
            require(clock.elapsed() - at < 10000, "BATCH_MEMORY_DELETE_READ_DEADLINE");
            const auto current = batch();
            if (current.value("busy").toBool() || feedback("list").value("status") == "pending") return;
            require(current.value("status") == "success" && current.value("requestId") == batchId &&
                        responses == 1 && observed.value("responseId") == batchId && observed.value("responseOk").toBool() &&
                        observed.value("responseIdsMatch").toBool(), "BATCH_MEMORY_DELETE_NOT_CONFIRMED", current);
            readId = current.value("readRequestId").toString();
            require(!readId.isEmpty() && feedback("list").value("requestId") == readId && feedback("list").value("status") == "success" &&
                        ids() == remaining.mid(0, 100), "BATCH_MEMORY_DELETE_READ_MISMATCH");
            observed["readRequestId"] = readId;
            record("one-batch-request-and-authoritative-first-read"); next(16); return;
        }
        if (step == 16) { if (press("memoryLoadMore", [this] { ownRead(readId); })) next(17); return; }
        if (step == 17) {
            if (!readyRead()) return;
            require(ids() == remaining && remaining.size() == 127 && !list().value("hasMore").toBool(), "BATCH_MEMORY_REMAINING_ORDER");
            observed["remainingIds"] = ids(); record("remaining-127-identities-keep-order"); next(18); return;
        }
        if (step == 18) { if (press("memory-close")) next(19); return; }
        if (step == 19) { require(clock.elapsed() - at < 4000, "BATCH_MEMORY_CLOSE_DEADLINE"); if (closed()) finish(true); }
    }
};
}
namespace MemoryBatchDeleteCheck {
void run(QQuickWindow *w, RuntimeBridge *s, const QStringList &ids, const QString &prefix,
         std::function<void(QVariantMap)> completion) { new Check(w, s, ids, prefix, std::move(completion)); }
}
