#include "AvatarManageCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickWindow>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

// A separate settings tail after W9. Folder selection is a path handoff;
// reselect, switch, import confirmation and both deletion choices use the
// existing controls. Avatar jobs are observed across their real host processes.
namespace {
const QString currentBlocker = "先切换到其他形象，再删除。";
const QString deleteNotice = "这会删除应用保存的副本。原来的模型文件夹不受影响，需要时可以重新导入。";
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact),
        QCryptographicHash::Sha256).toHex());
}

class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    NativeAvatar *avatar;
    bool restart, executing = false, finished = false;
    bool reselectWatching = false, reselectViolated = false, switchWatching = false, switchFailed = false;
    QString modelSource, scope, aId, bId, aPath, importId;
    int generation = 0, step = 0, reselectLoads = 0;
    qint64 at = 0, inputAt = -1;
    quint64 frame = 0, reselectFrame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QVariantMap observed, traceBefore, beforeArchive, reselectBefore, reselectImmediate,
        cancelBefore, cancelDialog, removeBefore, removeDialog, timing, consent;
    QVariantList checks, inputs;
    SummaryInteractionProbe::StableGate stable;
    NativeControlReadiness::OnceGate gate;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify,
          QString source, std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), e(editor),
          avatar(window->findChild<NativeAvatar *>("nativeAvatar")), restart(verify),
          modelSource(std::move(source)), done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::avatarChanged, this, [this] { observeReselect(); });
        if (avatar) {
            connect(avatar, &NativeAvatar::statisticsChanged, this, [this] { observeReselect(); });
            connect(avatar, &NativeAvatar::rendered, this, [this](bool ok, const QString &, const QString &path) {
                if (switchWatching && path == aPath && !ok) switchFailed = true;
            });
        }
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing || finished) return;
            executing = true;
            try { tick(); } catch (const std::exception &error) { finish(false, error.what()); }
            executing = false;
        });
        timer.start();
    }
    int deadline() const { return restart ? 15000 : 120000; }
    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}});
        NativeCheck::require(ok, code, details);
    }
    void next(int n) { step = n; at = clock.elapsed(); inputAt = -1; stable.reset(); gate.resetForNextStep(); }
    qint64 inputElapsed() {
        if (inputAt < 0) inputAt = clock.elapsed();
        return clock.elapsed() - inputAt;
    }
    void record(const QString &name) { checks.append(QVariantMap{{"name", name}, {"passed", true}}); }
    QVariantMap trace() const { return s->diagnostics().value("avatarJobs").toMap(); }
    QVariantList records() const { return s->state().value("avatars").toMap().value("records").toList(); }
    QString active() const { return s->state().value("avatars").toMap().value("activeId").toString(); }
    QStringList ids() const {
        QStringList result;
        for (const auto &value : records()) result.append(value.toMap().value("id").toString());
        result.sort(); return result;
    }
    QVariantMap archiveSnapshot() const {
        QStringList messages;
        for (const auto &value : s->messages()) messages.append(value.toMap().value("id").toString());
        const auto archive = s->state().value("archive").toMap();
        return {{"revision", archive.value("revision")}, {"sha256", hash(archive.value("archive").toMap())},
                {"messageIds", messages}};
    }
    QVariantMap snapshot() const {
        QVariantMap names, statuses, urls;
        for (const auto &value : records()) {
            const auto row = value.toMap(); const auto id = row.value("id").toString();
            names[id] = row.value("name"); statuses[id] = row.value("status"); urls[id] = row.value("entryUrl");
        }
        const auto jobs = trace();
        return {{"activeId", active()}, {"recordIds", ids()}, {"names", names}, {"statuses", statuses},
            {"entryUrlsById", urls}, {"path", s->avatarPath()}, {"modelPath", avatar ? avatar->modelPath() : QString()},
            {"loads", avatar ? avatar->loads() : -1}, {"ready", s->avatarState() == "形象已就绪"},
            {"state", s->avatarState()}, {"candidateEmpty", s->avatarCandidate().isEmpty()}, {"busy", s->avatarBusy()},
            {"jobDispatched", jobs.value("dispatched")}, {"jobStarted", jobs.value("started")},
            {"jobCompleted", jobs.value("completed")}};
    }
    void observeReselect() {
        if (!reselectWatching || finished) return;
        if (!avatar || s->avatarState() != "形象已就绪" || s->avatarPath() != aPath ||
            avatar->modelPath() != aPath || avatar->loads() != reselectLoads) reselectViolated = true;
    }
    QVariantList ownJobs() const {
        QVariantList jobs;
        for (const auto &value : trace().value("records").toList())
            if (value.toMap().value("serial").toULongLong() > traceBefore.value("dispatched").toULongLong()) jobs.append(value);
        return jobs;
    }
    bool jobsSettled(int count) const {
        const auto value = trace();
        require(value.value("truncated") == QVariant(false), "AVATAR_MANAGE_JOB_TRACE_TRUNCATED");
        const auto expected = traceBefore.value("dispatched").toULongLong() + count;
        require(value.value("dispatched").toULongLong() <= expected, "AVATAR_MANAGE_EXTRA_JOB");
        if (value.value("dispatched").toULongLong() < expected || s->avatarBusy() ||
            value.value("started").toULongLong() < expected || value.value("completed").toULongLong() < expected) return false;
        require(value.value("started").toULongLong() == expected && value.value("completed").toULongLong() == expected,
                "AVATAR_MANAGE_JOB_TOTALS");
        const auto jobs = ownJobs();
        require(jobs.size() == count, "AVATAR_MANAGE_JOB_TRACE_MISSING");
        const QStringList actions{"select", "scan", "preview", "commit", "select", "remove"};
        for (int i = 0; i < jobs.size(); ++i) {
            const auto job = jobs[i].toMap();
            require(job.value("serial").toULongLong() == traceBefore.value("dispatched").toULongLong() + i + 1 &&
                job.value("action") == actions[i] && job.value("status") == "completed" &&
                job.value("started") == QVariant(true) && job.value("exitCode").toInt() == 0 && job.value("ok") == QVariant(true),
                "AVATAR_MANAGE_JOB_FAILED_OR_REORDERED");
            if (i == 0 || i == 4) require(job.value("id") == aId, "AVATAR_MANAGE_SELECT_WRONG_ID");
            if (i == 5) require(job.value("id") == bId, "AVATAR_MANAGE_REMOVE_WRONG_ID");
            if (i >= 1 && i <= 3 && !importId.isEmpty())
                require(job.value("importId") == importId, "AVATAR_MANAGE_IMPORT_CORRELATION");
        }
        return true;
    }
    QQuickItem *item(const QString &name) const { return NativeCheck::findVisual(w->contentItem(), name, true).item; }
    QObject *dialog() const {
        QObject *visible = nullptr;
        // Main owns both the settings and character TaskPanel instances.
        // Only the visible popup belongs to this input, never the first
        // QObject with the shared production objectName.
        for (auto *candidate : w->findChildren<QObject *>("avatarRemoveConfirmation")) {
            if (!candidate->property("visible").toBool()) continue;
            require(!visible, "AVATAR_MANAGE_MULTIPLE_CONFIRMATIONS"); visible = candidate;
        }
        return visible;
    }
    SummaryInteractionProbe::ControlObservation inspect(QQuickItem *target) const {
        bool ready = true;
        for (auto *parent = target; parent; parent = parent->parentItem())
            if (parent->property("inputReady").isValid()) ready = ready && parent->property("inputReady").toBool();
        auto result = SummaryInteractionProbe::inspect(target, w, ready, scope);
        const bool whole = NativeControlReadiness::wholeVisibility(target, w).value("fullyVisible").toBool();
        result.eligible = result.eligible && whole;
        result.state["fullyVisible"] = whole; result.state["ready"] = result.eligible;
        return result;
    }
    bool control(const QString &name, const QString &kind,
                 const std::function<QVariantMap(QQuickItem *, QPoint)> &action) {
        const auto elapsed = [this] { return clock.elapsed() - inputAt; };
        inputElapsed();
        require(elapsed() < 4000 && clock.elapsed() < deadline(), "AVATAR_MANAGE_INPUT_DEADLINE", {{"control", name}});
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "AVATAR_MANAGE_INPUT_DEADLINE");
        const auto observation = inspect(target); const auto layout = stable.observe(observation, elapsed(), frame);
        if (!layout.value("ready").toBool()) { w->update(); return false; }
        QVariantMap evidence;
        const auto performed = gate.poll(elapsed(), 4000, [&] {
            const auto fresh = inspect(item(name)); auto state = fresh.state;
            state["ready"] = item(name) == target && stable.matches(fresh) && s->scopeKey() == scope &&
                s->generation() == generation && clock.elapsed() < deadline();
            return state;
        }, [&] {
            const auto fresh = inspect(target); const auto hit = NativeCheck::hitTest(w, fresh.point, target);
            require(target && item(name) == target && stable.matches(fresh) && hit.accepted(), "AVATAR_MANAGE_INPUT_TARGET", hit.metadata());
            require(elapsed() < 4000 && clock.elapsed() < deadline(), "AVATAR_MANAGE_INPUT_DEADLINE");
            evidence = action(target, fresh.point);
            evidence.insert({{"step", step}, {"control", name}, {"kind", kind}, {"elapsedMs", elapsed()},
                {"deadlineMs", 4000}, {"frame", QVariant::fromValue(frame)}, {"layout", layout}, {"hit", hit.metadata()}});
        });
        require(performed != NativeControlReadiness::OnceGate::Expired, "AVATAR_MANAGE_INPUT_DEADLINE");
        if (performed != NativeControlReadiness::OnceGate::Performed) return false;
        auto proof = gate.metadata(); proof["pollIntervalMs"] = timer.interval(); evidence["gate"] = proof;
        inputs.append(evidence); return true;
    }
    QVariantMap mouseClick(QQuickItem *target, QPoint point) {
        QSignalSpy clicked(target, SIGNAL(clicked())); require(clicked.isValid(), "AVATAR_MANAGE_CLICK_SIGNAL");
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, point, 0);
        require(clicked.count() == 1, "AVATAR_MANAGE_CLICK_COUNT");
        return {{"mouseDispatchCount", 1}, {"clickedSignals", clicked.count()}};
    }
    bool click(const QString &name) {
        return control(name, "button", [this](QQuickItem *target, QPoint point) { return mouseClick(target, point); });
    }
    bool removalGate(const QString &id, bool enabled, const QString &reason, QVariantMap &out) {
        inputElapsed(); const auto elapsed = [this] { return clock.elapsed() - inputAt; };
        require(elapsed() < 4000, "AVATAR_MANAGE_REMOVAL_GATE_DEADLINE");
        auto *button = item("avatarRemove-" + id);
        const auto revealed = NativeControlReadiness::revealWholeItem(button, elapsed, 4000);
        const auto whole = NativeControlReadiness::wholeVisibility(button, w);
        require(!revealed.value("expired").toBool() && elapsed() < 4000, "AVATAR_MANAGE_REMOVAL_GATE_DEADLINE");
        if (!button || !whole.value("fullyVisible").toBool() || button->isEnabled() != enabled ||
            button->property("removalBlocker").toString() != reason) { w->update(); return false; }
        require(s->modelRemovalBlocker(id) == reason, "AVATAR_MANAGE_BLOCKER_MISMATCH");
        out = {{"id", id}, {"enabled", button->isEnabled()}, {"blocker", button->property("removalBlocker")},
               {"visible", button->isVisible()}, {"wholeVisibility", whole}};
        return true;
    }
    QVariantMap dialogSnapshot() const {
        auto *popup = dialog(); auto *name = item("avatarRemoveName"), *notice = item("avatarRemoveNotice");
        require(popup && popup->property("visible").toBool() && name && notice, "AVATAR_MANAGE_CONFIRMATION_MISSING");
        const auto label = snapshot().value("names").toMap().value(bId).toString();
        require(popup->property("targetId") == bId && name->property("text") == label &&
            popup->property("title") == "删除这个形象？" && notice->property("text") == deleteNotice &&
            name->property("textFormat").toInt() == int(Qt::PlainText) && notice->property("textFormat").toInt() == int(Qt::PlainText),
            "AVATAR_MANAGE_CONFIRMATION_CONTENT");
        return {{"targetId", popup->property("targetId")}, {"name", name->property("text")}, {"title", popup->property("title")},
            {"notice", notice->property("text")}, {"namePlainText", true}, {"noticePlainText", true}, {"visible", true}};
    }
    void requireReady(const QString &id, const QString &path) const {
        require(avatar && active() == id && s->avatarPath() == path && avatar->modelPath() == path &&
            s->avatarState() == "形象已就绪" && !s->avatarBusy() && s->avatarCandidate().isEmpty(), "AVATAR_MANAGE_READY_PATH");
    }
    void finish(bool passed, const QString &error = {}) {
        if (finished) return;
        finished = true; timer.stop(); reselectWatching = false; switchWatching = false;
        observed["roles"] = QVariantMap{{"aId", aId}, {"bId", bId}};
        observed["jobBaseline"] = traceBefore; observed["jobFinal"] = trace(); observed["jobs"] = ownJobs();
        observed["archiveBefore"] = beforeArchive; observed["archiveAfter"] = archiveSnapshot();
        auto callback = std::move(done);
        if (callback) callback({{"schema", "reverie.native.avatar-manage.gui-evidence.v1"}, {"passed", passed}, {"error", error},
            {"mode", restart ? "restart-readback" : "manage-and-readback"}, {"step", step}, {"deadlineMs", deadline()},
            {"elapsedMs", clock.elapsed()}, {"pollIntervalMs", timer.interval()}, {"checks", checks}, {"inputs", inputs},
            {"observed", observed}, {"systemFolderDialogCovered", false}, {"modelRequestsAdded", false}, {"contentCollected", false}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < deadline(), "AVATAR_MANAGE_TAIL_TIMEOUT");
        require(s->connected() && s->runtimeWritable(), "AVATAR_MANAGE_RUNTIME_UNAVAILABLE");
        if (step == 0) {
            require(avatar && !e->dirty(), "AVATAR_MANAGE_START_STATE");
            if (s->avatarBusy() || s->avatarState() != "形象已就绪" || e->busy()) return;
            const auto jobs = trace();
            if (jobs.value("dispatched") != jobs.value("completed")) return;
            require(jobs.value("truncated") == QVariant(false) && jobs.value("dispatched") == jobs.value("started") &&
                jobs.value("records").toList().size() == jobs.value("dispatched").toInt(), "AVATAR_MANAGE_START_TRACE");
            require(records().size() == 1 && s->avatarCandidate().isEmpty() && !active().isEmpty() &&
                records().first().toMap().value("status") == "ready", "AVATAR_MANAGE_START_RECORDS");
            aId = active(); aPath = s->avatarPath(); scope = s->scopeKey(); generation = s->generation();
            require(aPath.startsWith(s->dataRoot() + "/avatars/records/" + aId + "/payload/") &&
                avatar->modelPath() == aPath && avatar->loads() > 0, "AVATAR_MANAGE_START_PATH");
            traceBefore = jobs; beforeArchive = archiveSnapshot(); observed["baseline"] = snapshot();
            observed["scopeKey"] = scope; observed["generation"] = generation;
            if (restart) {
                const auto all = jobs.value("records").toList();
                require(all.size() == 1 && all[0].toMap().value("action") == "list" &&
                    all[0].toMap().value("status") == "completed" && all[0].toMap().value("ok") == QVariant(true),
                    "AVATAR_MANAGE_RESTART_EXTRA_ACTION");
            } else require(QFileInfo(modelSource).isDir(), "AVATAR_MANAGE_SOURCE_MODEL");
            next(1); return;
        }
        require(scope == s->scopeKey() && generation == s->generation(), "AVATAR_MANAGE_CONTEXT_CHANGED");
        for (const auto &value : ownJobs()) {
            const auto job = value.toMap(); const auto status = job.value("status").toString();
            if (status == "completed" || status == "failed-to-start")
                require(status == "completed" && job.value("ok") == QVariant(true), "AVATAR_MANAGE_HOST_JOB_FAILED");
        }
        require(!reselectViolated, "AVATAR_MANAGE_A4_RESELECT_CHANGED_READY_PATH_OR_LOADS");
        require(!switchFailed, "AVATAR_MANAGE_A4_SWITCH_RENDER_FAILED");
        if (step == 1) { if (click("nav-character")) next(restart ? 20 : 2); return; }
        if (step == 2) {
            QVariantMap state;
            if (!removalGate(aId, false, currentBlocker, state)) return;
            observed["initialGate"] = state;
            if (control("avatarRecord-" + aId, "button", [this](QQuickItem *target, QPoint point) {
                record("initial-current-avatar-delete-disabled"); reselectBefore = snapshot();
                reselectLoads = avatar->loads(); reselectFrame = frame; reselectWatching = true;
                auto input = mouseClick(target, point); observeReselect(); reselectImmediate = snapshot();
                require(!reselectViolated, "AVATAR_MANAGE_A4_RESELECT_IMMEDIATE"); return input;
            })) next(3);
            return;
        }
        if (step == 3) {
            observeReselect(); require(!reselectViolated, "AVATAR_MANAGE_A4_RESELECT_CHANGED_READY_PATH_OR_LOADS");
            if (!jobsSettled(1) || frame <= reselectFrame) { w->update(); return; }
            requireReady(aId, aPath); reselectWatching = false;
            observed["reselect"] = QVariantMap{{"before", reselectBefore}, {"immediate", reselectImmediate}, {"after", snapshot()}};
            record("current-reselect-keeps-ready-path-and-loads"); next(4); return;
        }
        if (step == 4) {
            if (control("importModel", "path-handoff", [this](QQuickItem *, QPoint) {
                timing["pathHandoffAtMs"] = clock.elapsed();
                s->importModel(QUrl::fromLocalFile(modelSource));
                return QVariantMap{{"pathHandoffCount", 1}, {"mouseDispatchCount", 0}};
            })) next(5);
            return;
        }
        if (step == 5) {
            if (!s->avatarCandidate().value("previewReady").toBool() || !jobsSettled(3)) return;
            importId = s->avatarCandidate().value("importId").toString();
            require(!importId.isEmpty() && active() == aId && ids() == QStringList{aId} &&
                s->avatarPath().startsWith(s->dataRoot() + "/avatars/staging/" + importId + "/payload/"), "AVATAR_MANAGE_PREVIEW_TARGET");
            if (!timing.contains("previewReadyAtMs")) timing["previewReadyAtMs"] = clock.elapsed();
            QVariantMap state; if (!removalGate(aId, false, currentBlocker, state)) return;
            require(jobsSettled(3), "AVATAR_MANAGE_PREVIEW_JOBS");
            observed["previewGate"] = state; observed["preview"] = snapshot();
            consent["warningsRequired"] = !s->avatarCandidate().value("warnings").toList().isEmpty();
            record("duplicate-preview-disables-delete"); next(6); return;
        }
        if (step == 6) {
            auto *rights = item("modelRights");
            require(rights, "AVATAR_MANAGE_RIGHTS_MISSING");
            if (!consent.contains("rightsBefore")) consent["rightsBefore"] = rights->property("checked");
            if (rights->property("checked").toBool()) {
                consent["rightsAfter"] = true; consent["rightsClicks"] = 0; next(7); return;
            }
            if (control("modelRights", "checkbox", [this](QQuickItem *target, QPoint point) {
                QSignalSpy toggled(target, SIGNAL(toggled())); require(toggled.isValid(), "AVATAR_MANAGE_RIGHTS_SIGNAL");
                auto input = mouseClick(target, point);
                require(toggled.count() == 1 && target->property("checked").toBool(), "AVATAR_MANAGE_RIGHTS_CONFIRMATION");
                input["checked"] = true; input["toggledSignals"] = toggled.count(); return input;
            })) { consent["rightsAfter"] = true; consent["rightsClicks"] = 1; next(7); }
            return;
        }
        if (step == 7) {
            auto *warnings = item("modelWarnings");
            const bool required = consent.value("warningsRequired").toBool();
            if (!consent.contains("warningsBefore")) consent["warningsBefore"] = warnings && warnings->property("checked").toBool();
            if (!required || (warnings && warnings->property("checked").toBool())) {
                consent["warningsAfter"] = warnings && warnings->property("checked").toBool();
                consent["warningClicks"] = 0; observed["consent"] = consent; next(8); return;
            }
            if (control("modelWarnings", "checkbox", [this](QQuickItem *target, QPoint point) {
                QSignalSpy toggled(target, SIGNAL(toggled())); require(toggled.isValid(), "AVATAR_MANAGE_WARNING_SIGNAL");
                auto input = mouseClick(target, point);
                require(toggled.count() == 1 && target->property("checked").toBool(), "AVATAR_MANAGE_WARNING_CONFIRMATION");
                input["checked"] = true; input["toggledSignals"] = toggled.count(); return input;
            })) {
                consent["warningsAfter"] = true; consent["warningClicks"] = 1; observed["consent"] = consent; next(8);
            }
            return;
        }
        if (step == 8) {
            if (control("confirmModel", "button", [this](QQuickItem *target, QPoint point) {
                timing["confirmAtMs"] = clock.elapsed(); return mouseClick(target, point);
            })) next(9);
            return;
        }
        if (step == 9) {
            if (!jobsSettled(4) || !s->avatarCandidate().isEmpty() || s->avatarState() != "形象已就绪") return;
            bId = active();
            require(!bId.isEmpty() && bId != aId && ids().size() == 2 && ids().contains(aId) && ids().contains(bId) &&
                s->avatarPath() != aPath && s->avatarPath().startsWith(s->dataRoot() + "/avatars/records/" + bId + "/payload/") &&
                avatar->modelPath() == s->avatarPath(), "AVATAR_MANAGE_DUPLICATE_COMMIT");
            const auto committedAt = clock.elapsed();
            timing["committedReadyAtMs"] = committedAt;
            timing["elapsedMs"] = committedAt - timing.value("pathHandoffAtMs").toLongLong();
            observed["importTiming"] = timing; observed["committed"] = snapshot();
            record("duplicate-import-keeps-two-records-and-selects-new"); next(10); return;
        }
        if (step == 10) {
            if (control("avatarRecord-" + aId, "button", [this](QQuickItem *target, QPoint point) {
                switchWatching = true; return mouseClick(target, point);
            })) next(11);
            return;
        }
        if (step == 11) {
            require(!switchFailed, "AVATAR_MANAGE_A4_SWITCH_RENDER_FAILED");
            if (!jobsSettled(5) || s->avatarState() != "形象已就绪") return;
            requireReady(aId, aPath); switchWatching = false;
            QVariantMap a, b;
            if (!removalGate(aId, false, currentBlocker, a) || !removalGate(bId, true, {}, b)) return;
            observed["switchGates"] = QVariantMap{{"A", a}, {"B", b}}; observed["switchBack"] = snapshot();
            record("switch-back-restores-original-ready-avatar"); next(12); return;
        }
        if (step == 12) {
            if (control("avatarRemove-" + bId, "button", [this](QQuickItem *target, QPoint point) {
                cancelBefore = snapshot(); return mouseClick(target, point);
            })) next(13);
            return;
        }
        if (step == 13) {
            if (!dialog() || !dialog()->property("visible").toBool()) return;
            cancelDialog = dialogSnapshot(); if (click("avatarRemoveCancel")) next(14); return;
        }
        if (step == 14) {
            if (dialog() && dialog()->property("visible").toBool()) return;
            require(jobsSettled(5) && snapshot() == cancelBefore, "AVATAR_MANAGE_CANCEL_CHANGED_STATE");
            observed["cancel"] = QVariantMap{{"before", cancelBefore}, {"after", snapshot()}, {"dialog", cancelDialog}};
            record("delete-cancel-dispatches-nothing"); next(15); return;
        }
        if (step == 15) {
            if (control("avatarRemove-" + bId, "button", [this](QQuickItem *target, QPoint point) {
                removeBefore = snapshot(); return mouseClick(target, point);
            })) next(16);
            return;
        }
        if (step == 16) {
            if (!dialog() || !dialog()->property("visible").toBool()) return;
            removeDialog = dialogSnapshot(); if (click("avatarRemoveConfirm")) next(17); return;
        }
        if (step == 17) {
            const auto feedback = s->avatarRemovalFeedback();
            require(!QStringList{"error", "blocked", "refreshing"}.contains(feedback.value("status").toString()), "AVATAR_MANAGE_REMOVE_FAILED");
            if (feedback.value("status") != "success" || !jobsSettled(6)) return;
            const auto name = removeDialog.value("name").toString();
            requireReady(aId, aPath);
            require(ids() == QStringList{aId} && avatar->loads() == removeBefore.value("loads").toInt() && feedback.value("id") == bId &&
                feedback.value("name") == name && feedback.value("text") == QString("已删除「%1」。").arg(name) &&
                feedback.value("listReloaded") == QVariant(true), "AVATAR_MANAGE_REMOVE_RESULT");
            auto *message = item("avatarRemovalFeedback");
            require(message && message->property("text") == feedback.value("text"), "AVATAR_MANAGE_REMOVE_FEEDBACK_NOT_SHOWN");
            observed["remove"] = QVariantMap{{"before", removeBefore}, {"after", snapshot()}, {"dialog", removeDialog}, {"feedback", feedback}};
            record("delete-confirm-removes-only-inactive-without-reload"); next(18); return;
        }
        if (step == 18) {
            require(archiveSnapshot() == beforeArchive && jobsSettled(6), "AVATAR_MANAGE_CHANGED_ARCHIVE_OR_MESSAGES");
            record("tail-preserves-archive-and-messages"); finish(true); return;
        }
        if (step == 20) {
            QVariantMap state; if (!removalGate(aId, false, currentBlocker, state)) return;
            requireReady(aId, aPath); observed["initialGate"] = state; observed["restart"] = snapshot();
            record("restart-loads-only-surviving-original-avatar");
            require(trace() == traceBefore && ownJobs().isEmpty(), "AVATAR_MANAGE_RESTART_DISPATCHED_JOB");
            record("restart-sends-no-model-actions");
            require(archiveSnapshot() == beforeArchive, "AVATAR_MANAGE_RESTART_CHANGED_ARCHIVE_OR_MESSAGES");
            record("restart-preserves-archive-and-messages"); finish(true);
        }
    }
};
}

namespace AvatarManageCheck {
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool restart,
         const QString &modelSource, std::function<void(QVariantMap)> done) {
    new Check(window, session, editor, restart, modelSource, std::move(done));
}
}
