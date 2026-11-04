#include "PersonaProfileEditCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "ArchiveInputProbe.h"
#include "PersonaProfileEditInput.h"
#include "../src/RuntimeBridge.h"
#include "../src/ArchiveEditor.h"
#include <QCryptographicHash>
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickWindow>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

namespace {
const QString descriptionSuffix = "\n角色卡编辑验收：晴在独立观景室记录微风。";
const QString greeting = "角色卡编辑验收问候：愿今天的微风陪伴你。";
const QString tone = "温和、清晰，使用简短自然的句子。";
QString hash(const QVariantMap &v) {
    return QString::fromLatin1(QCryptographicHash::hash(
        QJsonDocument(QJsonObject::fromVariantMap(v)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
QVariantMap fields(const QVariantMap &persona) {
    const auto identity = persona.value("identity").toMap();
    return {{"description", identity.value("description")}, {"personality_traits", persona.value("personality_traits")},
        {"tone", persona.value("speaking_style").toMap().value("tone")}, {"first_message", identity.value("first_message")},
        {"alternate_greetings", identity.value("alternate_greetings")}, {"message_example", identity.value("message_example")}};
}
class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, finished = false;
    int step = 0, targetIndex = -1, inputGeneration = -1;
    qint64 at = 0;
    quint64 frame = 0, observeFrame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QString target, originalId, inputScope, saveId, saveScope;
    int saveGeneration = -1;
    QVariantMap baseline, expected, initialFields, observations, inputSignals;
    QVariantList checks, inputs, saves, switches, reads;
    NativeControlReadiness::OnceGate gate;
    SummaryInteractionProbe::StableGate stable;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify,
          std::function<void(QVariantMap)> callback)
        : QObject(window), w(window), s(session), e(editor), restart(verify), done(std::move(callback)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing || finished) return;
            executing = true;
            try { tick(); } catch (const std::exception &error) { finish(false, QString::fromUtf8(error.what())); }
            executing = false;
        });
        timer.start();
    }
    void require(bool ok, const QString &code) const {
        NativeCheck::require(ok, code, {{"step", step}, {"elapsedMs", clock.elapsed()}});
    }
    QString active() const { return s->state().value("personas").toMap().value("active_id").toString(); }
    QVariantMap profile() const { return s->personaProfileState(); }
    QVariantMap archive() const { return s->state().value("archive").toMap().value("archive").toMap(); }
    QVariantList messageIds() const {
        QVariantList out;
        for (const auto &v : s->messages()) out.append(v.toMap().value("id").toString());
        return out;
    }
    QVariantMap snapshot() const {
        return {{"activeId", active()}, {"scope", s->scopeKey()}, {"generation", s->generation()},
            {"profiles", s->state().value("personas").toMap().value("profiles")},
            {"messageIds", messageIds()}, {"archiveRevision", e->revision()}, {"archiveHash", hash(archive())},
            {"authorHash", hash(e->authorPrompts())}, {"runtimeWritable", s->runtimeWritable()}, {"recoveryState", s->recoveryState()}};
    }
    bool settled() const {
        for (const auto &v : s->diagnostics().value("pendingCommands").toList())
            if (QStringList{"persona:get", "persona:list", "chat:history", "archive:get"}.contains(v.toMap().value("command").toString())) return false;
        return !s->personaChanging() && !s->busy() && e->initialized() && !e->busy() &&
            e->archiveScope() == s->scopeKey() && e->revision() == s->state().value("archive").toMap().value("revision").toInt();
    }
    QQuickItem *item(const QString &name) const { return NativeCheck::findVisual(w->contentItem(), name, true).item; }
    void next(int n) {
        step = n; at = clock.elapsed(); observeFrame = frame;
        gate.resetForNextStep(); stable.reset(); inputScope = s->scopeKey(); inputGeneration = s->generation();
    }
    void record(const QString &name) { checks.append(QVariantMap{{"name", name}, {"passed", true}}); }
    SummaryInteractionProbe::ControlObservation inspect(QQuickItem *target) const {
        bool ready = s->connected() && s->runtimeWritable() && !s->personaChanging();
        for (auto *p = target; p; p = p->parentItem())
            if (p->property("inputReady").isValid()) ready = ready && p->property("inputReady").toBool();
        auto result = SummaryInteractionProbe::inspect(target, w, ready, s->scopeKey());
        const auto whole = NativeControlReadiness::wholeVisibility(target, w);
        result.eligible = result.eligible && whole.value("fullyVisible").toBool();
        result.state["fullyVisible"] = whole.value("fullyVisible");
        return result;
    }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &send) {
        const auto elapsed = [this] { return clock.elapsed() - at; };
        require(elapsed() < 4000, "CARD_EDIT_INPUT_DEADLINE:" + name);
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "CARD_EDIT_INPUT_SCOPE_CHANGED");
        QPointer<QQuickItem> target = item(name);
        NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        auto observation = inspect(target);
        const auto layout = stable.observe(observation, elapsed(), frame);
        if (!layout.value("ready").toBool()) { w->update(); return false; }
        const auto result = gate.poll(elapsed(), 4000, [this, target, name] {
            auto state = NativeControlReadiness::snapshot(target, w, true);
            state["ready"] = target && item(name) == target && stable.matches(inspect(target)) &&
                s->scopeKey() == inputScope && s->generation() == inputGeneration;
            return state;
        }, [this, target, &send, &elapsed] {
            require(target && elapsed() < 4000 && stable.matches(inspect(target)), "CARD_EDIT_FINAL_INPUT_CHANGED");
            inputSignals.clear(); send(target);
        });
        require(result != NativeControlReadiness::OnceGate::Expired, "CARD_EDIT_INPUT_DEADLINE:" + name);
        if (result != NativeControlReadiness::OnceGate::Performed) return false;
        auto evidence = gate.metadata(); evidence["pollIntervalMs"] = 40;
        inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
            {"generation", inputGeneration}, {"layout", layout}, {"gate", evidence}, {"signals", inputSignals}});
        return true;
    }
    void mouse(QQuickItem *target) {
        const auto current = inspect(target);
        require(stable.matches(current) && NativeCheck::hitTest(w, current.point, target).accepted(), "CARD_EDIT_HIT_CHANGED");
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, current.point, 0);
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy clicked(target, SIGNAL(clicked())); require(clicked.isValid(), "CARD_EDIT_CLICK_OBSERVER");
            mouse(target); require(clicked.count() == 1, "CARD_EDIT_CLICK_COUNT");
            inputSignals = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", clicked.count()}};
        });
    }
    bool text(const QString &name, const QString &value) {
        return control(name, [this, value](QQuickItem *target) {
            const QPointer<QQuickItem> guarded(target);
            const auto name = target->objectName();
            mouse(guarded);
            require(guarded && ArchiveInputProbe::keyboardFocusMatches(guarded, w, false), "CARD_EDIT_TEXT_FOCUS");
            PersonaProfileEditInput::replace(w, guarded, value, [this, guarded, name] {
                require(clock.elapsed() - at < 4000 && clock.elapsed() < (restart ? 20000 : 45000), "CARD_EDIT_INPUT_DEADLINE:" + name);
                require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "CARD_EDIT_INPUT_SCOPE_CHANGED");
                require(guarded && item(name) == guarded, "CARD_EDIT_TEXT_TARGET_CHANGED");
            });
            inputSignals = {{"kind", "text"}, {"mouseDispatchCount", 1}, {"commitCount", 1}, {"focusInTarget", true}};
        });
    }
    bool rowObservation(int index, bool enabled, const QString &notice, const QString &key) {
        const auto elapsed = [this] { return clock.elapsed() - at; };
        require(elapsed() < 4000, "CARD_EDIT_ROW_OBSERVATION_DEADLINE");
        require(index >= 0 && index < s->state().value("personas").toMap().value("profiles").toList().size(), "CARD_EDIT_ROW_INDEX");
        const auto name = "personaEdit_" + QString::number(index);
        auto *button = item(name);
        auto *hint = notice.isEmpty() ? nullptr : item("personaEditDisabledHint_" + QString::number(index));
        NativeControlReadiness::revealWholeItem(button, elapsed, 4000);
        if (hint) NativeControlReadiness::revealWholeItem(hint, elapsed, 4000);
        if (clock.elapsed() - at < 40 || frame <= observeFrame) { w->update(); return false; }
        require(button && button->isEnabled() == enabled &&
            NativeControlReadiness::wholeVisibility(button, w).value("fullyVisible").toBool(), "CARD_EDIT_ROW_STATE");
        require(notice.isEmpty() || (hint && hint->property("text").toString().contains(notice) &&
            NativeControlReadiness::wholeVisibility(hint, w).value("fullyVisible").toBool()), "CARD_EDIT_ROW_NOTICE");
        observations[key] = QVariantMap{{"profileId", s->state().value("personas").toMap().value("profiles").toList()[index].toMap().value("id")},
            {"enabled", enabled}, {"button", NativeControlReadiness::wholeVisibility(button, w)},
            {"noticeVisible", !notice.isEmpty()}, {"notice", hint ? NativeControlReadiness::wholeVisibility(hint, w) : QVariantMap{}}};
        return true;
    }
    int indexOf(const QString &id) const {
        const auto list = s->state().value("personas").toMap().value("profiles").toList();
        for (int i = 0; i < list.size(); ++i) if (list[i].toMap().value("id") == id) return i;
        return -1;
    }
    void saveStarted() {
        const auto state = profile(); saveId = state.value("requestId").toString();
        require(state.value("status") == "saving" && !saveId.isEmpty(), "CARD_EDIT_SAVE_NOT_SENT");
        saveScope = s->scopeKey(); saveGeneration = s->generation();
    }
    bool saved(int version) {
        require(clock.elapsed() - at < 10000, "CARD_EDIT_SAVE_RECEIPT_DEADLINE");
        const auto state = profile();
        if (state.value("status") == "saving") return false;
        require(state.value("status") == "success" && state.value("requestId") == saveId &&
            state.value("profile_id") == target && state.value("identity_version").toInt() == version &&
            state.value("active").metaType().id() == QMetaType::Bool && !state.value("active").toBool() &&
            state.value("fields").toMap() == expected && s->scopeKey() == saveScope && s->generation() == saveGeneration,
            "CARD_EDIT_SAVE_RECEIPT_MISMATCH");
        saves.append(QVariantMap{{"requestId", saveId}, {"profileId", target}, {"version", version},
            {"fingerprint", state.value("identity_fingerprint")}, {"fields", state.value("fields")},
            {"scopeBefore", saveScope}, {"scopeAfter", s->scopeKey()}, {"generationBefore", saveGeneration},
            {"generationAfter", s->generation()}, {"active", false}});
        return true;
    }
    void beginSwitch(const QString &id) {
        require(indexOf(id) >= 0 && id != active(), "CARD_EDIT_SWITCH_TARGET");
        switches.append(QVariantMap{{"targetId", id}, {"sourceId", active()}, {"scopeBefore", s->scopeKey()}, {"generationBefore", s->generation()}});
    }
    bool switchReady(const QString &id) {
        require(clock.elapsed() - at < 10000, "CARD_EDIT_SWITCH_DEADLINE");
        if (!settled() || s->personaChanging()) return false;
        require(active() == id && s->personaFeedback().value("status") == "success" &&
            s->runtimeWritable() && s->recoveryState() == "clean", "CARD_EDIT_SWITCH_NOT_WRITABLE");
        auto record = switches.last().toMap(); record.insert({{"scopeAfter", s->scopeKey()}, {"generationAfter", s->generation()},
            {"runtimeWritable", true}, {"recoveryState", "clean"}}); switches.last() = record;
        return true;
    }
    void tick() {
        require(clock.elapsed() < (restart ? 20000 : 45000), "CARD_EDIT_SEGMENT_TIMEOUT");
        require(s->connected() && s->runtimeWritable() && s->recoveryState() == "clean", "CARD_EDIT_RUNTIME_UNAVAILABLE");
        if (step == 0) {
            if (!settled()) return;
            originalId = active();
            const auto list = s->state().value("personas").toMap().value("profiles").toList();
            QString moon;
            for (int i = 0; i < list.size(); ++i) {
                const auto row = list[i].toMap();
                if (row.value("name") == "测试人格·晴") { target = row.value("id").toString(); targetIndex = i; }
                if (row.value("name") == "测试人格·月") moon = row.value("id").toString();
            }
            require(list.size() == 4 && targetIndex >= 0 && !target.isEmpty() && target != originalId &&
                originalId == (restart ? "default" : moon) && !e->dirty() && s->draft().isEmpty(), "CARD_EDIT_START_STATE");
            baseline = snapshot(); next(1); return;
        }
        if (step == 1) { if (click("nav-character")) next(restart ? 6 : 2); return; }
        if (step == 2) { if (rowObservation(indexOf("default"), false, "内置人格不能编辑", "builtin")) next(3); return; }
        if (step == 3) { if (rowObservation(indexOf(originalId), false, "使用中", "active")) next(4); return; }
        if (step == 4) { if (rowObservation(targetIndex, true, {}, "target")) next(5); return; }
        if (step == 5) {
            const auto list = s->state().value("personas").toMap().value("profiles").toList();
            for (int i = 0; i < list.size(); ++i) if (i != targetIndex && list[i].toMap().value("id") != originalId && list[i].toMap().value("id") != "default") {
                if (!rowObservation(i, true, {}, "otherImported")) return;
            }
            record("current-and-builtin-disabled-other-imports-editable"); next(6); return;
        }
        if (step == 6) { if (click("personaEdit_" + QString::number(targetIndex))) next(7); return; }
        if (step == 7) {
            require(clock.elapsed() - at < 10000, "CARD_EDIT_READ_DEADLINE");
            const auto state = profile();
            if (state.value("status") == "loading" || state.value("status") == "pending" || !state.value("open").toBool()) return;
            require(state.value("profile_id") == target && state.value("identity_version").toInt() == (restart ? 3 : 1) &&
                !state.value("active").toBool() && state.value("fields").toMap().size() == 6, "CARD_EDIT_READ_MISMATCH");
            reads.append(QVariantMap{{"profileId", target}, {"version", state.value("identity_version")},
                {"fingerprint", state.value("identity_fingerprint")}, {"fields", state.value("fields")}, {"requestId", state.value("requestId")}});
            initialFields = state.value("fields").toMap(); expected = initialFields;
            if (restart) { record("restart-third-version-read-back"); next(18); return; }
            require(initialFields.value("alternate_greetings").toList().isEmpty(), "CARD_EDIT_GREETING_BASELINE");
            expected["description"] = initialFields.value("description").toString() + descriptionSuffix;
            next(8); return;
        }
        if (step == 8) { if (text("personaProfileDescription", expected.value("description").toString())) next(9); return; }
        if (step == 9) { if (click("personaProfileAddGreeting")) next(10); return; }
        if (step == 10) {
            if (text("personaProfileGreeting_0", greeting)) { expected["alternate_greetings"] = QVariantList{greeting}; next(11); } return;
        }
        if (step == 11) { if (click("personaProfileSave")) next(12); return; }
        if (step == 12) { if (click("personaProfileConfirmSave")) { saveStarted(); next(13); } return; }
        if (step == 13) { if (saved(2)) { record("inactive-description-and-greeting-saved-as-version-two"); next(14); } return; }
        if (step == 14) { if (text("personaProfileTone", tone)) { expected["tone"] = tone; next(15); } return; }
        if (step == 15) { if (click("personaProfileSave")) next(16); return; }
        if (step == 16) { if (click("personaProfileConfirmSave")) { saveStarted(); next(17); } return; }
        if (step == 17) { if (saved(3)) { record("inactive-tone-saved-as-version-three"); next(18); } return; }
        if (step == 18) { if (click("personaProfileCancel")) next(19); return; }
        if (step == 19) { if (profile().value("open").toBool()) return; next(20); return; }
        if (step == 20) { if (click("personaSwitch-" + target)) { beginSwitch(target); next(21); } return; }
        if (step == 21) { if (click("personaSwitchConfirm")) next(22); return; }
        if (step == 22) {
            if (!switchReady(target)) return;
            const auto persona = s->state().value("persona").toMap().value("persona").toMap();
            require(fields(persona) == expected && persona.value("identity").toMap().value("identity_version").toInt() == 3,
                "CARD_EDIT_MOUNTED_VERSION_MISMATCH");
            next(26); return;
        }
        if (step == 26) {
            if (!rowObservation(targetIndex, false, "使用中", "mountedTarget")) return;
            record("edited-persona-version-three-mounted-writable"); next(23); return;
        }
        if (step == 23) { if (click("personaSwitch-" + originalId)) { beginSwitch(originalId); next(24); } return; }
        if (step == 24) { if (click("personaSwitchConfirm")) next(25); return; }
        if (step == 25) {
            if (!switchReady(originalId)) return;
            const auto after = snapshot();
            for (const auto *key : {"activeId", "profiles", "messageIds", "archiveRevision", "archiveHash", "authorHash", "runtimeWritable", "recoveryState"})
                require(after.value(key) == baseline.value(key), "CARD_EDIT_RETURN_CHANGED_BASELINE:" + QString::fromLatin1(key));
            record("return-preserves-original-persona-archive-history-and-author-switches"); finish(true); return;
        }
    }
    void finish(bool passed, const QString &error = {}) {
        if (finished) return; finished = true; timer.stop();
        auto callback = std::move(done);
        if (callback) callback({{"schema", "reverie.native.card-edit.gui-evidence.v1"}, {"passed", passed}, {"error", error},
            {"mode", restart ? "restart-readback" : "edit-and-mount"}, {"profileId", target}, {"profileName", "测试人格·晴"},
            {"previouslyMounted", true}, {"deadlineMs", restart ? 20000 : 45000}, {"elapsedMs", clock.elapsed()},
            {"checks", checks}, {"inputs", inputs}, {"observations", observations}, {"reads", reads}, {"saves", saves},
            {"switches", switches}, {"before", baseline}, {"after", snapshot()}, {"fields", expected}, {"modelCalls", 0}});
        deleteLater();
    }
};
}
void PersonaProfileEditCheck::run(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *e, bool restart,
                                  std::function<void(QVariantMap)> done) {
    new Check(w, s, e, restart, std::move(done));
}
