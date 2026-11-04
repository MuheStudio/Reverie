#include "WorldbookBookSettingsCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "PersonaRowInputProbe.h"
#include "ArchiveInputProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include <algorithm>
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickWindow>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

// The book-level scan depth, budget and recursion tail. It runs after the
// priority tail on the flagged 「霜」 persona, whose archive no other persona
// segment reads, so the signed-off Sunny priority fixture stays untouched.
namespace {
const QString bookId = "p1_book_settings_book", depthEntry = "p1_book_settings_depth",
    recursionEntry = "p1_book_settings_recursion";
const QStringList chatTexts{"书级记录一：远灯亮起", "书级记录二：请继续核对", "书级记录三：远灯再亮"};
const QString reply = "书级设置效果已核对";
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
struct Settings { int depth; int budget; bool recursive; };
// Prepared, after the first save and after the second save.
const Settings prepared{1, 100, false}, firstSave{3, 100, true}, secondSave{3, 0, true};
class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, finished = false;
    QString prefix, frost, originalPersona, originalScope, scope, readId, writeId;
    int step = 0, generation = 0, stage = 0, revision = 0;
    qint64 at = 0;
    quint64 frame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QVariantMap observed, original, originalArchive, frostBaseline, inputEvidence;
    QStringList frostBefore, chatBefore;
    QVariantList checks, inputs, receipts, saves, chats, restartControlSamples;
    QMap<QString, QVariantMap> responses;
    SummaryInteractionProbe::StableGate stable;
    NativeControlReadiness::SequentialGate inputGate;
    ArchiveInputProbe::PhaseClock phaseClock;
    ArchiveInputProbe::SaveBinding saveBinding;
    QString inputScope;
    int inputGeneration = -1;
    std::unique_ptr<PersonaRowInputProbe::Input> personaInput;
    QVariantList personaInputs;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify,
          QString capture, std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), e(editor), restart(verify), prefix(std::move(capture)), done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &result, int g) {
                if (finished || !QStringList{"archive:get", "archive:put"}.contains(command)) return;
                if (receipts.size() >= 40) { finish(false, "BOOK_SETTINGS_RECEIPT_BOUND"); return; }
                const auto archive = result.value("archive").toMap();
                QVariantMap record{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scope", s->scopeKey()}, {"personaId", active()}, {"ok", result.value("ok")},
                    {"revision", result.value("revision")}, {"exists", result.value("exists")}, {"archiveHash", hash(archive)}, {"book", fixtureBook(archive)},
                    {"restHash", hash(withoutFixture(archive))}};
                receipts.append(record);
                responses[id] = record;
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            if (!finished && (id == readId || id == writeId)) finish(false, "BOOK_SETTINGS_REQUEST_FAILED:" + code);
        });
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing || finished) return;
            executing = true;
            try { tick(); } catch (const std::exception &error) { finish(false, error.what()); }
            executing = false;
        });
        timer.start();
    }
    int deadline() const { return restart ? 20000 : 40000; }
    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(ok, code, details);
    }
    void next(int n) {
        step = n; at = clock.elapsed(); stable.reset(); inputGate.resetForNextStep();
        phaseClock.enter(at, n == 8 || n == 13 || n == 19);
        if (n == 11) saveBinding = {};
        if (n == 19) restartControlSamples.clear();
        inputScope = s->scopeKey(); inputGeneration = s->generation();
        personaInput.reset();
        if (n == 1 || n == 40) {
            personaInput = std::make_unique<PersonaRowInputProbe::Input>();
            require(personaInput->bind(n, n == 1 ? frost : originalPersona, inputScope, inputGeneration, at, active(),
                s->state().value("persona").toMap().value("persona_id").toString()), "BOOK_SETTINGS_PERSONA_INPUT_BINDING");
        }
    }
    void record(const QString &name) {
        for (const auto &value : checks) require(value.toMap().value("name") != name, "BOOK_SETTINGS_CHECK_DUPLICATED");
        checks.append(QVariantMap{{"name", name}, {"passed", true}});
    }
    QString active() const { return s->state().value("personas").toMap().value("active_id").toString(); }
    QStringList ids() const { QStringList out; for (const auto &v : s->messages()) out.append(v.toMap().value("id").toString()); return out; }
    QVariantMap archive() const { return s->state().value("archive").toMap().value("archive").toMap(); }
    int currentRevision() const { return s->state().value("archive").toMap().value("revision").toInt(); }
    static QVariantMap fixtureBook(const QVariantMap &value) {
        for (const auto &v : value.value("worldBooks").toList()) if (v.toMap().value("id") == bookId) return v.toMap();
        return {};
    }
    static QVariantMap withoutFixture(QVariantMap value) {
        QVariantList books;
        for (const auto &v : value.value("worldBooks").toList()) if (v.toMap().value("id") != bookId) books.append(v);
        value["worldBooks"] = books;
        return value;
    }
    QVariantMap snapshot() const {
        const auto av = s->state().value("avatars").toMap(); QStringList avatarIds;
        for (const auto &v : av.value("records").toList()) avatarIds.append(v.toMap().value("id").toString());
        return {{"personaId", active()}, {"exists", s->state().value("archive").toMap().value("exists")}, {"revision", currentRevision()}, {"archiveHash", hash(archive())},
            {"messageIds", ids()}, {"charactersHash", hash({{"characters", archive().value("characters")}})},
            {"avatarIds", avatarIds}, {"activeAvatar", av.value("activeId")}, {"avatarState", s->avatarState()}};
    }
    QQuickItem *item(const QString &name) const { return NativeCheck::findVisual(w->contentItem(), name, true).item; }
    bool pending(const QString &command) const {
        for (const auto &v : s->diagnostics().value("pendingCommands").toList()) if (v.toMap().value("command") == command) return true;
        return false;
    }
    QVariantList pendingCommands() const { return s->diagnostics().value("pendingCommands").toList(); }
    SummaryInteractionProbe::ControlObservation inspectControl(QQuickItem *target) const {
        bool surfaceReady = true;
        for (auto *parent = target; parent; parent = parent->parentItem())
            if (parent->property("inputReady").isValid()) surfaceReady = surfaceReady && parent->property("inputReady").toBool();
        auto observation = SummaryInteractionProbe::inspect(target, w, surfaceReady, s->scopeKey());
        const bool whole = NativeControlReadiness::wholeVisibility(target, w).value("fullyVisible").toBool();
        observation.eligible = observation.eligible && whole;
        observation.state["fullyVisible"] = whole; observation.state["ready"] = observation.eligible;
        return observation;
    }
    void inputTime() const {
        require(clock.elapsed() < deadline() && phaseClock.elapsed(clock.elapsed()) >= 0 &&
                phaseClock.elapsed(clock.elapsed()) < 4000, "BOOK_SETTINGS_INPUT_DEADLINE");
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "BOOK_SETTINGS_INPUT_SCOPE_CHANGED");
    }
    bool settled() const {
        for (const auto *command : {"persona:get", "persona:list", "chat:history", "archive:get"}) if (pending(command)) return false;
        return !s->personaChanging() && e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == currentRevision();
    }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &perform, bool clickable = true) {
        require(phaseClock.beginInput(clock.elapsed()), "BOOK_SETTINGS_INPUT_CLOCK");
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : phaseClock.elapsed(clock.elapsed()); };
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"elapsedMs", elapsed()},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"frame", QVariant::fromValue(frame)},
            {"revealSummary", NativeControlReadiness::revealSummary(revealed)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(target, w)}};
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "BOOK_SETTINGS_INPUT_DEADLINE");
        if (!target || !revealed.value("geometryValid").toBool()) { stable.reset(); w->update(); return false; }
        auto observation = inspectControl(target);
        if (!stable.observe(observation, elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        const auto result = inputGate.poll(elapsed, 4000, {{name, [this, name] { return item(name); },
            [this, name](QQuickItem *candidate) {
                const auto fresh = inspectControl(candidate); auto state = fresh.state;
                state["ready"] = candidate && item(name) == candidate && stable.matches(fresh) &&
                    s->scopeKey() == inputScope && s->generation() == inputGeneration;
                return state;
            }, [this, name, clickable, &perform, &elapsed](QQuickItem *candidate) {
                QPointer<QQuickItem> qualified = candidate;
                inputTime(); const auto fresh = inspectControl(qualified);
                require(qualified && item(name) == qualified && stable.matches(fresh), "BOOK_SETTINGS_INPUT_TARGET_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
                if (clickable) require(hit.accepted(), "BOOK_SETTINGS_INPUT_HIT", hit.metadata());
                const auto beforeValue = qualified->property(name == "worldbookRecursiveScanning" ? "checked" : "value");
                inputTime(); inputEvidence.clear(); perform(qualified);
                require(clock.elapsed() < deadline() && elapsed() < 4000, "BOOK_SETTINGS_INPUT_DEADLINE");
                require(qualified, "BOOK_SETTINGS_CONTROL_DESTROYED_AFTER_INPUT");
                if (clickable) inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
                    {"generation", inputGeneration}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"beforeValue", beforeValue}, {"afterValue", qualified->property(name == "worldbookRecursiveScanning" ? "checked" : "value")},
                    {"signals", inputEvidence}, {"hit", hit.metadata()}, {"windowWidth", w->width()}, {"windowHeight", w->height()},
                    {"inputAtMs", phaseClock.inputAt()}, {"stepAtMs", at}, {"elapsedMs", elapsed()}});
            }}});
        require(result != NativeControlReadiness::SequentialGate::Expired, "BOOK_SETTINGS_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "BOOK_SETTINGS_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        return true;
    }
    bool personaRowClick() {
        require(bool(personaInput), "BOOK_SETTINGS_PERSONA_INPUT_MISSING");
        PersonaRowInputProbe::Context context;
        context.window = w; context.currentScope = [this] { return s->scopeKey(); };
        context.currentGeneration = [this] { return s->generation(); };
        context.currentPersonaId = [this] { return active(); };
        context.profiles = [this] { return s->state().value("personas").toMap().value("profiles").toList(); };
        context.personaState = [this] { return s->state().value("persona").toMap(); };
        context.personasState = [this] { return s->state().value("personas").toMap(); };
        context.nowMs = [this] { return clock.elapsed(); }; context.frameSerial = [this] { return frame; };
        context.dispatch = [this](QQuickItem *, const QPoint &, const std::function<void()> &sendMouse) { inputTime(); sendMouse(); };
        const auto result = personaInput->poll(context);
        require(result != PersonaRowInputProbe::Input::Expired, "BOOK_SETTINGS_INPUT_DEADLINE");
        require(result != PersonaRowInputProbe::Input::Failed, "BOOK_SETTINGS_PERSONA_INPUT_FAILED", personaInput->metadata());
        if (result != PersonaRowInputProbe::Input::Performed) return false;
        const auto evidence = personaInput->metadata(), terminal = evidence.value("terminal").toMap();
        auto layout = terminal.value("layout").toMap();
        auto current = terminal.value("mouse").toMap().value("control").toMap();
        for (const auto *key : {"elapsedMs", "frameSerial", "stableSinceMs", "stableFrameSerial", "layoutStable"}) current[key] = layout.value(key);
        inputs.append(QVariantMap{{"step", step}, {"control", evidence.value("control")}, {"scope", inputScope},
            {"generation", inputGeneration}, {"frame", terminal.value("mouseFrameSerial")},
            {"layout", QVariantMap{{"ready", true}, {"minimumStableMs", 40}, {"last", current}}},
            {"beforeValue", QVariant{}}, {"afterValue", QVariant{}}, {"signals", QVariantMap{{"kind", "button"},
                {"mouseDispatchCount", terminal.value("mouseDispatchCount")}, {"clickedSignals", terminal.value("clickedSignals")}}},
            {"hit", terminal.value("mouse").toMap().value("hit")}, {"windowWidth", w->width()}, {"windowHeight", w->height()},
            {"elapsedMs", terminal.value("mouseElapsedMs")}});
        personaInputs.append(evidence); return true;
    }
    void mouseInput(QQuickItem *target) {
        inputTime(); QPointer<QQuickItem> qualified = target;
        const auto fresh = inspectControl(qualified);
        require(qualified && item(qualified->objectName()) == qualified && stable.matches(fresh), "BOOK_SETTINGS_MOUSE_TARGET_CHANGED");
        require(NativeCheck::hitTest(w, fresh.point, qualified).accepted(), "BOOK_SETTINGS_MOUSE_HIT_CHANGED");
        inputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
    }
    void keyInput(QQuickItem *target, bool selector = false) const {
        inputTime(); QPointer<QQuickItem> qualified = target;
        require(qualified && item(qualified->objectName()) == qualified && qualified->isEnabled(),
                "BOOK_SETTINGS_KEY_TARGET_CHANGED");
        require(ArchiveInputProbe::keyboardFocusMatches(qualified, w, selector), "BOOK_SETTINGS_KEY_FOCUS_MISMATCH",
                {{"selector", selector}, {"focusFound", w->activeFocusItem() != nullptr}});
        inputTime();
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy signal(target, SIGNAL(clicked())); require(signal.isValid(), "BOOK_SETTINGS_CLICK_SIGNAL_MISSING");
            mouseInput(target);
            require(signal.count() == 1, "BOOK_SETTINGS_CLICK_SIGNAL_COUNT");
            inputEvidence = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", signal.count()}};
        });
    }
    // Index 0 of the entry selector is the book-settings row.
    bool select(const QString &name, int index) {
        return control(name, [this, index](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            require(index >= 0 && index < target->property("count").toInt() && target->property("currentIndex").toInt() != index,
                    "BOOK_SETTINGS_SELECTOR_RANGE");
            QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "BOOK_SETTINGS_SELECTOR_SIGNAL_MISSING");
            mouseInput(qualified);
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Home);
            for (int row = 0; row < index; ++row) { keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Down); }
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Return);
            require(qualified && activated.count() == 1 && qualified->property("currentIndex").toInt() == index, "BOOK_SETTINGS_SELECTOR_ACTIVATION");
            inputEvidence = {{"kind", "selector"}, {"mouseDispatchCount", 1}, {"activatedSignals", activated.count()}, {"selectedIndex", index}};
        });
    }
    bool stepInteger(const QString &name, int before, int after) {
        return control(name, [this, name, before, after](QQuickItem *control) {
            QPointer<QQuickItem> qualified = control;
            const auto key = name == "worldbookScanDepth" ? QString("scanDepth") : QString("tokenBudget");
            require(e->bookSettingEditable(key) && !e->hasEntry(), "BOOK_SETTINGS_CONTROL_NOT_EDITABLE");
            mouseInput(control);
            require(qualified, "BOOK_SETTINGS_KEY_TARGET_CHANGED");
            control->forceActiveFocus();
            require(control->property("value").toInt() == before, "BOOK_SETTINGS_CONTROL_BASELINE");
            QSignalSpy modified(control, SIGNAL(valueModified())); require(modified.isValid(), "BOOK_SETTINGS_CONTROL_SIGNAL_MISSING");
            for (int i = 0; i < 2; ++i) { keyInput(qualified); QTest::keyClick(w, after > before ? Qt::Key_Up : Qt::Key_Down); }
            const auto value = key == "scanDepth" ? e->scanDepth() : e->bookTokenBudget();
            require(qualified && modified.count() == 2 && qualified->property("value").toInt() == after && value.toInt() == after && e->dirty(),
                    "BOOK_SETTINGS_CONTROL_INPUT");
            inputEvidence = {{"kind", "integer"}, {"mouseDispatchCount", 1}, {"keyDispatchCount", 2}, {"valueModifiedSignals", modified.count()}};
        });
    }
    bool toggleRecursion() {
        return control("worldbookRecursiveScanning", [this](QQuickItem *control) {
            QPointer<QQuickItem> qualified = control;
            require(e->bookSettingEditable("recursiveScanning") && !e->hasEntry() && !control->property("checked").toBool(),
                    "BOOK_SETTINGS_CONTROL_NOT_EDITABLE");
            QSignalSpy toggled(control, SIGNAL(toggled())); require(toggled.isValid(), "BOOK_SETTINGS_CONTROL_SIGNAL_MISSING");
            mouseInput(control);
            require(qualified && toggled.count() == 1 && qualified->property("checked").toBool() &&
                    e->recursiveScanning() == QVariant(true) && e->dirty(), "BOOK_SETTINGS_CONTROL_INPUT");
            inputEvidence = {{"kind", "checkbox"}, {"mouseDispatchCount", 1}, {"toggledSignals", toggled.count()}, {"checked", true}};
        });
    }
    void newRead() {
        readId = s->request("archive:get");
        require(!readId.isEmpty() && !responses.contains(readId), "BOOK_SETTINGS_READ_NOT_NEW");
    }
    bool readReady() {
        require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_READ_DEADLINE");
        if (!responses.contains(readId)) return false;
        const auto receipt = responses.value(readId);
        require(receipt.value("ok").metaType().id() == QMetaType::Bool && receipt.value("ok").toBool() &&
                receipt.value("scope") == s->scopeKey() && receipt.value("generation").toInt() == s->generation() &&
                receipt.value("personaId") == active() && receipt.value("command") == "archive:get" &&
                receipt.value("revision").toInt() == currentRevision() && receipt.value("archiveHash") == hash(archive()),
                "BOOK_SETTINGS_READ_IDENTITY");
        return !pending("archive:get");
    }
    void requireFixture(const Settings &expected) {
        const auto book = fixtureBook(archive()); const auto entries = book.value("entries").toList();
        require(book.value("scanDepth").toInt() == expected.depth && book.value("tokenBudget").toInt() == expected.budget &&
                book.value("recursiveScanning") == QVariant(expected.recursive) && book.value("name") == "书级设置验收资料" &&
                entries.size() == 2, "BOOK_SETTINGS_FIXTURE_BOOK");
        for (int i = 0; i < 2; ++i) {
            const auto entry = entries[i].toMap();
            require(entry.value("id") == (i ? recursionEntry : depthEntry) &&
                entry.value("content") == (i ? "BOOK_RECURSION_ONLY" : "BOOK_DEPTH_ONLY 回声") &&
                entry.value("keywords") == QVariantList{i ? "回声" : "远灯"} && entry.value("insertionOrder").toInt() == (i ? 40 : 30) &&
                entry.value("priority").toInt() == 0 && entry.value("enabled").toBool() && !entry.value("alwaysActive").toBool() &&
                !entry.value("useRegex").toBool() && entry.value("scanDepth").isNull() && entry.value("tokenBudget").isNull(),
                "BOOK_SETTINGS_FIXTURE_ENTRY");
        }
        require(withoutFixture(archive()) == frostBaseline, "BOOK_SETTINGS_OTHER_FIELDS_CHANGED");
    }
    bool chatReply() {
        require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_CHAT_DEADLINE");
        if (s->busy() || pending("chat:history") || pending("chat:send")) return false;
        const auto all = s->messages(); if (all.size() < chatBefore.size() + 2) return false;
        require(all.size() == chatBefore.size() + 2 && ids().mid(0, chatBefore.size()) == chatBefore, "BOOK_SETTINGS_CHAT_ID_PREFIX");
        const auto user = all[all.size()-2].toMap(), assistant = all.last().toMap();
        const QString request = user.value("request_id").toString();
        require(user.value("role") == "user" && user.value("content") == chatTexts[stage-1] && assistant.value("role") == "assistant" &&
                assistant.value("content") == reply && !request.isEmpty() && assistant.value("request_id") == request,
                "BOOK_SETTINGS_CHAT_PAIR");
        chats.append(QVariantMap{{"stage", stage}, {"requestId", request}, {"scope", s->scopeKey()}, {"generation", s->generation()},
            {"personaId", active()}, {"beforeIds", chatBefore}, {"afterIds", ids()}, {"userId", user.value("id")}, {"assistantId", assistant.value("id")},
            {"text", user.value("content")}, {"reply", assistant.value("content")}, {"revision", currentRevision()}, {"archiveHash", hash(archive())}});
        return true;
    }
    const Settings &settingsAfter(int saveCount) const { return saveCount == 0 ? prepared : saveCount == 1 ? firstSave : secondSave; }
    void tick() {
        require(clock.elapsed() < deadline(), "BOOK_SETTINGS_SEGMENT_DEADLINE");
        require(s->connected() && s->runtimeWritable() && s->recoveryState() == "clean", "BOOK_SETTINGS_RUNTIME_UNAVAILABLE");
        // Scope changes are permitted only at the two explicit confirmation steps.
        if (!scope.isEmpty() && !QList<int>{3, 4, 41, 42}.contains(step))
            require(s->scopeKey() == scope && s->generation() == generation, "BOOK_SETTINGS_SCOPE_CHANGED");
        if (step == 0) {
            if (!settled()) return;
            require(!e->dirty() && s->draft().isEmpty(), "BOOK_SETTINGS_START_HAS_DRAFT");
            originalPersona = active(); originalScope = scope = s->scopeKey(); generation = s->generation();
            const auto profiles = s->state().value("personas").toMap().value("profiles").toList();
            require(profiles.size() == 4, "BOOK_SETTINGS_PROFILE_COUNT");
            QString moon;
            for (const auto &v : profiles) {
                const auto p = v.toMap(); if (p.value("name") == "测试人格·霜") frost = p.value("id").toString();
                if (p.value("name") == "测试人格·月") moon = p.value("id").toString();
            }
            require(!frost.isEmpty() && frost != originalPersona && originalPersona == (restart ? "default" : moon), "BOOK_SETTINGS_START_PERSONA");
            newRead(); next(50); return;
        }
        if (step == 50) {
            if (!readReady() || !settled()) return;
            original = snapshot(); originalArchive = archive(); observed["originalBefore"] = original;
            observed["frostPersonaId"] = frost; observed["originalScope"] = originalScope; observed["originalReadId"] = readId;
            next(51); return;
        }
        if (step == 51) { if (click("nav-character")) next(1); return; }
        if (step == 1) { if (personaRowClick()) next(2); return; }
        if (step == 2) { if (click("personaSwitchConfirm")) next(3); return; }
        if (step == 3) {
            require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_SWITCH_DEADLINE");
            if (s->personaChanging() || !settled()) return;
            require(s->personaFeedback().value("status") == "success" && active() == frost && s->scopeKey() != originalScope && s->draft().isEmpty(), "BOOK_SETTINGS_SWITCH_UNCONFIRMED");
            scope = s->scopeKey(); generation = s->generation(); observed["frostScope"] = scope;
            newRead(); next(4); return;
        }
        if (step == 4) {
            if (!readReady() || !settled()) return;
            frostBefore = ids(); frostBaseline = withoutFixture(archive()); revision = currentRevision();
            const auto raw = s->state().value("archive").toMap();
            require(raw.value("exists").toBool() && archive().contains("characters") && archive().contains("activeCharacterIds") && archive().contains("worldBooks"),
                    "BOOK_SETTINGS_BASELINE_NOT_CANONICAL");
            observed["canonicalBaselineRestHash"] = hash(frostBaseline);
            observed["frostBefore"] = snapshot(); observed["baselineReadId"] = readId;
            if (restart) {
                requireFixture(secondSave);
                observed["book"] = fixtureBook(archive());
                record("book-settings-restart-frost-archive-and-message-identities");
                next(16); return;
            }
            require(archive().value("worldBooks").toList().isEmpty() && fixtureBook(archive()).isEmpty(), "BOOK_SETTINGS_BASELINE_NOT_EMPTY");
            record("book-settings-original-persona-captured-and-frost-baseline-read");
            auto proposed = frostBaseline; QVariantList entries;
            for (int i = 0; i < 2; ++i) entries.append(QVariantMap{{"id", i ? recursionEntry : depthEntry}, {"comment", i ? "递归条目" : "深度条目"},
                {"content", i ? "BOOK_RECURSION_ONLY" : "BOOK_DEPTH_ONLY 回声"}, {"keywords", QVariantList{i ? "回声" : "远灯"}},
                {"secondaryKeywords", QVariantList{}}, {"selectiveLogic", "and_any"}, {"caseSensitive", false}, {"useRegex", false},
                {"enabled", true}, {"alwaysActive", false}, {"position", "before_char"}, {"insertionOrder", i ? 40 : 30}, {"priority", 0},
                {"depth", 0}, {"role", "system"}});
            proposed["worldBooks"] = QVariantList{QVariantMap{{"id", bookId}, {"name", "书级设置验收资料"},
                {"scanDepth", prepared.depth}, {"tokenBudget", prepared.budget}, {"recursiveScanning", prepared.recursive}, {"entries", entries}}};
            require(s->scopeKey() == scope && s->generation() == generation && active() == frost, "BOOK_SETTINGS_PREPARATION_SCOPE_CHANGED");
            writeId = s->request("archive:put", {{"archive", proposed}, {"expected_revision", revision}});
            require(!writeId.isEmpty(), "BOOK_SETTINGS_PREPARATION_NOT_SENT");
            observed["prepareWriteId"] = writeId; observed["preparedExpectedRevision"] = revision;
            next(5); return;
        }
        if (step == 5) {
            require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_PREPARATION_DEADLINE");
            if (!responses.contains(writeId)) return;
            const auto r = responses.value(writeId);
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == frost && r.value("command") == "archive:put" && r.value("revision").toInt() == revision+1,
                    "BOOK_SETTINGS_PREPARATION_RECEIPT");
            requireFixture(prepared); revision = currentRevision(); observed["preparedRevision"] = revision;
            newRead(); next(6); return;
        }
        if (step == 6) {
            if (!readReady()) return; requireFixture(prepared); observed["prepareReadId"] = readId;
            record("book-settings-fixture-prepared-depth-one-budget-hundred-recursion-off");
            stage = 1; next(29); return;
        }
        if (step == 29) { if (click("nav-chat")) next(30); return; }
        if (step == 16) { if (click("nav-memory")) next(7); return; }
        if (step == 7) { if (click("reloadWorldbook")) next(8); return; }
        if (step == 8) {
            if (phaseClock.inputAt() < 0) {
                require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_RELOAD_READ_DEADLINE");
                if (!settled()) return;
                // After a restart the first read of 「霜」 has already selected
                // its only book and first entry; only the entry selector moves.
                if (restart) {
                    const auto rows = e->bookRows();
                    require(rows.size() == 1 && rows[0].toMap().value("id") == bookId &&
                            e->selectedBookKey() == rows[0].toMap().value("key").toString() && e->hasEntry(),
                            "BOOK_SETTINGS_RESTART_BOOK_NOT_PRESELECTED");
                    next(9); return;
                }
                require(phaseClock.beginInput(clock.elapsed()), "BOOK_SETTINGS_INPUT_CLOCK");
            }
            int index = -1; const auto rows = e->bookRows();
            for (int i = 0; i < rows.size(); ++i) if (rows[i].toMap().value("id") == bookId) index = i + 1;
            require(index > 0, "BOOK_SETTINGS_SELECTOR_ID_MISSING");
            if (select("worldbookBookSelector", index)) next(9); return;
        }
        if (step == 9) {
            if (!select("worldbookEntrySelector", 0)) return;
            require(e->hasBook() && !e->hasEntry(), "BOOK_SETTINGS_VIEW_NOT_SELECTED");
            next(restart ? 19 : 10); return;
        }
        if (step == 10) { if (stepInteger("worldbookScanDepth", prepared.depth, firstSave.depth)) next(17); return; }
        if (step == 17) { if (toggleRecursion()) next(11); return; }
        if (step == 18) { if (stepInteger("worldbookBookTokenBudget", firstSave.budget, secondSave.budget)) next(11); return; }
        if (step == 11) {
            if (!saveBinding.metadata().value("armed").toBool()) {
                revision = currentRevision();
                require(saveBinding.arm(scope, generation, pendingCommands(), receipts), "BOOK_SETTINGS_SAVE_BINDING_BASELINE");
            }
            if (click("saveWorldbook")) {
                const auto matched = saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts);
                require(matched == ArchiveInputProbe::SaveBinding::Matched, "BOOK_SETTINGS_SAVE_NOT_DISPATCHED", saveBinding.metadata());
                writeId = saveBinding.requestId(); next(12);
            } return;
        }
        if (step == 12) {
            require(clock.elapsed()-at < 10000, "BOOK_SETTINGS_SAVE_DEADLINE");
            if (!responses.contains(writeId) || e->busy()) return;
            const auto r = responses.value(writeId);
            require(saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts) == ArchiveInputProbe::SaveBinding::Matched,
                    "BOOK_SETTINGS_SAVE_BINDING_CHANGED", saveBinding.metadata());
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation && r.value("personaId") == frost &&
                    r.value("revision").toInt() == revision+1 && e->status() == "saved" && !e->dirty(), "BOOK_SETTINGS_SAVE_RECEIPT");
            requireFixture(settingsAfter(saves.size() + 1)); newRead(); next(13); return;
        }
        if (step == 13) {
            if (phaseClock.inputAt() < 0) {
                if (!readReady()) return;
                require(phaseClock.beginInput(clock.elapsed()), "BOOK_SETTINGS_INPUT_CLOCK");
            }
            const int number = saves.size() + 1;
            const auto &values = settingsAfter(number);
            requireFixture(values);
            if (!control("archive-status", [this, number, &values](QQuickItem *label) {
                require(label->property("text").toString().contains("已保存"), "BOOK_SETTINGS_SAVE_FEEDBACK");
                const QString image = prefix + ".worldbook-book-settings-save-" + QString::number(number) + ".png";
                require(w->grabWindow().save(image), "BOOK_SETTINGS_CAPTURE_FAILED");
                inputTime();
                require(item("archive-status") == label && stable.matches(inspectControl(label)), "BOOK_SETTINGS_CAPTURE_LAYOUT_CHANGED");
                saves.append(QVariantMap{{"stage", number}, {"writeId", writeId}, {"readId", readId}, {"scope", scope},
                    {"generation", generation}, {"personaId", frost}, {"expectedRevision", revision}, {"revision", currentRevision()},
                    {"scanDepth", values.depth}, {"tokenBudget", values.budget}, {"recursiveScanning", values.recursive},
                    {"archiveHash", hash(archive())}, {"restHash", hash(withoutFixture(archive()))},
                    {"book", fixtureBook(archive())}, {"feedback", label->property("text")},
                    {"binding", saveBinding.metadata()}, {"readAtMs", at}, {"feedbackInputAtMs", phaseClock.inputAt()},
                    {"feedbackGeometry", NativeControlReadiness::wholeVisibility(label, w)}, {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"screenshot", image}});
            }, false)) return;
            stage = number + 1; next(14); return;
        }
        if (step == 19) {
            if (phaseClock.inputAt() < 0) {
                require(clock.elapsed() - at < 10000, "BOOK_SETTINGS_READBACK_DEADLINE");
                if (!settled()) return;
                require(phaseClock.beginInput(clock.elapsed()), "BOOK_SETTINGS_INPUT_CLOCK");
            }
            // Each control has its own actual whole-item observation. They may
            // require different scroll positions; none claims simultaneous
            // visibility. All three share this step's original input clock.
            const QStringList names{"worldbookScanDepth", "worldbookBookTokenBudget", "worldbookRecursiveScanning"};
            require(restartControlSamples.size() < names.size(), "BOOK_SETTINGS_READBACK_SAMPLE_OVERFLOW");
            const QString name = names[restartControlSamples.size()];
            observed["restartControlSampling"] = QVariantMap{{"control", name}, {"samples", restartControlSamples},
                {"stepAtMs", at}, {"inputAtMs", phaseClock.inputAt()}, {"inputElapsedMs", phaseClock.elapsed(clock.elapsed())}};
            if (!control(name, [this, name](QQuickItem *target) {
                const auto value = target->property(name == "worldbookRecursiveScanning" ? "checked" : "value");
                const auto editorValue = name == "worldbookScanDepth" ? e->scanDepth() :
                    name == "worldbookBookTokenBudget" ? e->bookTokenBudget() : e->recursiveScanning();
                const QVariant expected = name == "worldbookScanDepth" ? QVariant(secondSave.depth) :
                    name == "worldbookBookTokenBudget" ? QVariant(secondSave.budget) : QVariant(secondSave.recursive);
                require(target->isVisible() && target->isEnabled(), "BOOK_SETTINGS_READBACK_CONTROLS");
                require(value == expected && editorValue == expected && !e->dirty(), "BOOK_SETTINGS_READBACK_VALUES");
                requireFixture(secondSave);
                const auto baseline = responses.value(observed.value("baselineReadId").toString());
                require(baseline.value("archiveHash") == hash(archive()) && baseline.value("revision").toInt() == currentRevision(),
                    "BOOK_SETTINGS_READBACK_ARCHIVE_CHANGED");
                inputTime();
                restartControlSamples.append(QVariantMap{{"control", name}, {"step", step}, {"value", value}, {"editorValue", editorValue},
                    {"readId", observed.value("baselineReadId")}, {"scope", scope}, {"generation", generation}, {"personaId", active()},
                    {"revision", currentRevision()}, {"archiveHash", hash(archive())}, {"stepAtMs", at}, {"inputAtMs", phaseClock.inputAt()},
                    {"sampledAtMs", clock.elapsed()}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"geometry", NativeControlReadiness::wholeVisibility(target, w)}, {"windowWidth", w->width()}, {"windowHeight", w->height()}});
                observed["restartControlSampling"] = QVariantMap{{"control", name}, {"samples", restartControlSamples},
                    {"stepAtMs", at}, {"inputAtMs", phaseClock.inputAt()}, {"inputElapsedMs", phaseClock.elapsed(clock.elapsed())}};
                if (restartControlSamples.size() == 3) {
                    const QString image = prefix + ".worldbook-book-settings-restart.png";
                    require(w->grabWindow().save(image), "BOOK_SETTINGS_CAPTURE_FAILED");
                    inputTime();
                    require(item(name) == target && stable.matches(inspectControl(target)), "BOOK_SETTINGS_CAPTURE_LAYOUT_CHANGED");
                    const auto scan = restartControlSamples[0].toMap(), budget = restartControlSamples[1].toMap(), recursive = restartControlSamples[2].toMap();
                    observed["restartControls"] = QVariantMap{{"scanDepth", scan.value("value")}, {"tokenBudget", budget.value("value")},
                        {"recursiveScanning", recursive.value("value")}, {"editorScanDepth", scan.value("editorValue")},
                        {"editorTokenBudget", budget.value("editorValue")}, {"editorRecursiveScanning", recursive.value("editorValue")},
                        {"scanGeometry", scan.value("geometry")}, {"readAtMs", at}, {"inputAtMs", phaseClock.inputAt()},
                        {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"screenshot", image},
                        {"samplingPolicy", "sequential-whole-within-one-input-deadline"}, {"samples", restartControlSamples},
                        {"screenshotControl", name}};
                }
            }, false)) return;
            if (restartControlSamples.size() < 3) {
                // Re-arm target qualification only, never next()/PhaseClock:
                // changing controls must not grant another four seconds.
                stable.reset(); inputGate.resetForNextStep(); w->update(); return;
            }
            observed["frostTerminal"] = snapshot();
            record("book-settings-restart-controls-read-back");
            next(14); return;
        }
        if (step == 14) { if (click("memory-close")) next(restart ? 34 : 30); return; }
        if (step == 30) {
            if (control("chatComposer", [this](QQuickItem *composer) {
                QPointer<QQuickItem> qualified = composer;
                require(s->draft().isEmpty(), "BOOK_SETTINGS_CHAT_STALE_DRAFT"); chatBefore = ids();
                mouseInput(composer);
                inputTime(); require(qualified, "BOOK_SETTINGS_KEY_TARGET_CHANGED"); qualified->forceActiveFocus();
                QInputMethodEvent event; event.setCommitString(chatTexts[stage-1]);
                keyInput(qualified); QCoreApplication::sendEvent(w, &event);
                require(qualified && s->draft() == chatTexts[stage-1] && qualified->property("text") == chatTexts[stage-1], "BOOK_SETTINGS_CHAT_INPUT");
                inputEvidence = {{"kind", "text"}, {"mouseDispatchCount", 1}, {"commitCount", 1}, {"focusInTarget", composer->hasActiveFocus() || (w->activeFocusItem() && composer->isAncestorOf(w->activeFocusItem()))}};
            })) next(31); return;
        }
        if (step == 31) { if (click("sendChat")) next(32); return; }
        if (step == 32) {
            if (!chatReply()) return; requireFixture(settingsAfter(stage - 1));
            if (stage == 1) { record("book-settings-first-chat-depth-one-without-recursion"); next(16); return; }
            if (stage == 2) { record("book-settings-depth-three-recursion-on-saved-read-back-and-second-chat"); next(33); return; }
            record("book-settings-budget-zero-saved-read-back-and-third-chat");
            observed["frostTerminal"] = snapshot(); observed["book"] = fixtureBook(archive());
            require(saves.size() == 2 && chats.size() == 3, "BOOK_SETTINGS_TERMINAL_EVIDENCE_COUNT");
            const auto lastSave = saves.last().toMap(), fresh = responses.value(lastSave.value("readId").toString()), chat = chats.last().toMap();
            require(currentRevision() == lastSave.value("revision").toInt() && currentRevision() == fresh.value("revision").toInt() &&
                    currentRevision() == chat.value("revision").toInt() && hash(archive()) == lastSave.value("archiveHash") &&
                    hash(archive()) == fresh.value("archiveHash") && hash(archive()) == chat.value("archiveHash"),
                    "BOOK_SETTINGS_TERMINAL_FINAL_SAVE");
            observed["frostBaselineMessageIds"] = frostBefore;
            record("book-settings-frost-terminal-only-two-edits-and-six-messages");
            next(34); return;
        }
        if (step == 33) { if (click("nav-memory")) next(18); return; }
        if (step == 34) { if (click("nav-character")) next(40); return; }
        if (step == 40) { if (personaRowClick()) next(41); return; }
        if (step == 41) { if (click("personaSwitchConfirm")) next(42); return; }
        if (step == 42) {
            require(clock.elapsed()-at < 10000, "BOOK_SETTINGS_RETURN_DEADLINE");
            if (!settled()) return;
            require(s->personaFeedback().value("status") == "success" && active() == originalPersona && s->scopeKey() != scope && s->draft().isEmpty(), "BOOK_SETTINGS_RETURN_SCOPE");
            scope = s->scopeKey(); generation = s->generation(); newRead(); next(43); return;
        }
        if (step == 43) {
            if (!readReady() || !settled()) return;
            require(snapshot() == original && archive() == originalArchive, "BOOK_SETTINGS_RETURN_CHANGED_ORIGINAL");
            observed["originalAfter"] = snapshot(); observed["returnScope"] = scope; observed["returnReadId"] = readId;
            record(restart ? "book-settings-restart-default-archive-messages-switches-avatar-preserved" : "book-settings-return-moon-archive-messages-switches-preserved");
            if (restart) record("book-settings-restart-zero-preparation-zero-save-writes-and-zero-chats");
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(puts == (restart ? 0 : 3) && saves.size() == (restart ? 0 : 2) && chats.size() == (restart ? 0 : 3), "BOOK_SETTINGS_WRITE_CHAT_COUNTS");
            require(ids() == original.value("messageIds").toStringList(), "BOOK_SETTINGS_ORIGINAL_HISTORY_CHANGED");
            observed["putCount"] = puts; finish(true); return;
        }
    }
    void finish(bool passed, QString error = {}) {
        if (finished) return; finished = true; timer.stop();
        if (personaInput && !personaInput->terminal()) personaInput->abort("book-settings-segment-failed", clock.elapsed());
        if (personaInput && (personaInputs.isEmpty() || personaInputs.last().toMap().value("step").toInt() != step))
            personaInputs.append(personaInput->metadata());
        observed["step"] = step; observed["elapsedMs"] = clock.elapsed();
        done({{"passed", passed}, {"error", error}, {"mode", restart ? "restart-readback" : "change-and-effect"},
            {"deadlineMs", deadline()}, {"checks", checks}, {"inputs", inputs}, {"receipts", receipts},
            {"saves", saves}, {"chats", chats}, {"personaRowInputs", personaInputs}, {"observed", observed}});
        deleteLater();
    }
};
}
void WorldbookBookSettingsCheck::run(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *e, bool restart,
    const QString &capture, std::function<void(QVariantMap)> done) { new Check(w,s,e,restart,capture,std::move(done)); }
