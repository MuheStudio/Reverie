#include "WorldbookPriorityCheck.h"
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

namespace {
const QString bookId = "p1_priority_book", entryA = "p1_priority_a", entryB = "p1_priority_b";
const QStringList chatTexts{"优先级记录一：请核对第一条", "优先级记录二：请核对第二条", "优先级记录三：重启后请核对"};
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, finished = false;
    QString prefix, sunny, originalPersona, originalScope, scope, readId, writeId;
    int step = 0, generation = 0, stage = 0, revision = 0;
    qint64 at = 0;
    quint64 frame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QVariantMap observed, original, originalArchive, sunnyBaseline, terminalArchive, inputEvidence;
    QStringList sunnyBefore, chatBefore;
    QVariantList checks, inputs, receipts, saves, chats;
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
                if (receipts.size() >= 40) { finish(false, "PRIORITY_RECEIPT_BOUND"); return; }
                const auto archive = result.value("archive").toMap();
                QVariantMap record{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scope", s->scopeKey()}, {"personaId", active()}, {"ok", result.value("ok")},
                    {"revision", result.value("revision")}, {"exists", result.value("exists")}, {"archiveHash", hash(archive)}, {"book", fixtureBook(archive)},
                    {"restHash", hash(withoutFixture(archive))}};
                receipts.append(record);
                responses[id] = record;
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            if (!finished && (id == readId || id == writeId)) finish(false, "PRIORITY_REQUEST_FAILED:" + code);
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
    int deadline() const { return restart ? 20000 : 30000; }
    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(ok, code, details);
    }
    void next(int n) {
        step = n; at = clock.elapsed(); stable.reset(); inputGate.resetForNextStep();
        phaseClock.enter(at, n == 8 || n == 13);
        if (n == 11) saveBinding = {};
        inputScope = s->scopeKey(); inputGeneration = s->generation();
        personaInput.reset();
        if (n == 1 || n == 40) {
            personaInput = std::make_unique<PersonaRowInputProbe::Input>();
            require(personaInput->bind(n, n == 1 ? sunny : originalPersona, inputScope, inputGeneration, at, active(),
                s->state().value("persona").toMap().value("persona_id").toString()), "PRIORITY_PERSONA_INPUT_BINDING");
        }
    }
    void record(const QString &name) {
        for (const auto &value : checks) require(value.toMap().value("name") != name, "PRIORITY_CHECK_DUPLICATED");
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
    QString pendingId(const QString &command) const {
        QString out;
        for (const auto &v : s->diagnostics().value("pendingCommands").toList()) if (v.toMap().value("command") == command) {
            require(out.isEmpty(), "PRIORITY_MULTIPLE_PENDING_WRITES"); out = v.toMap().value("id").toString();
        }
        return out;
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
                phaseClock.elapsed(clock.elapsed()) < 4000, "PRIORITY_INPUT_DEADLINE");
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "PRIORITY_INPUT_SCOPE_CHANGED");
    }
    bool settled() const {
        for (const auto *command : {"persona:get", "persona:list", "chat:history", "archive:get"}) if (pending(command)) return false;
        return !s->personaChanging() && e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == currentRevision();
    }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &perform, bool clickable = true) {
        require(phaseClock.beginInput(clock.elapsed()), "PRIORITY_INPUT_CLOCK");
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : phaseClock.elapsed(clock.elapsed()); };
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"elapsedMs", elapsed()},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"frame", QVariant::fromValue(frame)},
            {"revealSummary", NativeControlReadiness::revealSummary(revealed)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(target, w)}};
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "PRIORITY_INPUT_DEADLINE");
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
                require(qualified && item(name) == qualified && stable.matches(fresh), "PRIORITY_INPUT_TARGET_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
                if (clickable) require(hit.accepted(), "PRIORITY_INPUT_HIT", hit.metadata());
                const auto beforeValue = qualified->property("value");
                inputTime(); inputEvidence.clear(); perform(qualified);
                require(clock.elapsed() < deadline() && elapsed() < 4000, "PRIORITY_INPUT_DEADLINE");
                require(qualified, "PRIORITY_CONTROL_DESTROYED_AFTER_INPUT");
                if (clickable) inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
                    {"generation", inputGeneration}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"beforeValue", beforeValue}, {"afterValue", qualified->property("value")}, {"signals", inputEvidence},
                    {"hit", hit.metadata()}, {"windowWidth", w->width()}, {"windowHeight", w->height()},
                    {"inputAtMs", phaseClock.inputAt()}, {"stepAtMs", at}, {"elapsedMs", elapsed()}});
            }}});
        require(result != NativeControlReadiness::SequentialGate::Expired, "PRIORITY_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "PRIORITY_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        return true;
    }
    bool personaRowClick() {
        require(bool(personaInput), "PRIORITY_PERSONA_INPUT_MISSING");
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
        require(result != PersonaRowInputProbe::Input::Expired, "PRIORITY_INPUT_DEADLINE");
        require(result != PersonaRowInputProbe::Input::Failed, "PRIORITY_PERSONA_INPUT_FAILED", personaInput->metadata());
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
        require(qualified && item(qualified->objectName()) == qualified && stable.matches(fresh), "PRIORITY_MOUSE_TARGET_CHANGED");
        require(NativeCheck::hitTest(w, fresh.point, qualified).accepted(), "PRIORITY_MOUSE_HIT_CHANGED");
        inputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
    }
    void keyInput(QQuickItem *target, bool selector = false) const {
        inputTime(); QPointer<QQuickItem> qualified = target;
        require(qualified && item(qualified->objectName()) == qualified && qualified->isEnabled(),
                "PRIORITY_KEY_TARGET_CHANGED");
        require(ArchiveInputProbe::keyboardFocusMatches(qualified, w, selector), "PRIORITY_KEY_FOCUS_MISMATCH",
                {{"selector", selector}, {"focusFound", w->activeFocusItem() != nullptr}});
        inputTime();
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy signal(target, SIGNAL(clicked())); require(signal.isValid(), "PRIORITY_CLICK_SIGNAL_MISSING");
            mouseInput(target);
            require(signal.count() == 1, "PRIORITY_CLICK_SIGNAL_COUNT");
            inputEvidence = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", signal.count()}};
        });
    }
    bool select(const QString &name, const QVariantList &rows, const QString &id) {
        int index = -1; for (int i = 0; i < rows.size(); ++i) if (rows[i].toMap().value("id") == id) index = i + 1;
        require(index > 0, "PRIORITY_SELECTOR_ID_MISSING");
        return control(name, [this, index](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            require(index < target->property("count").toInt(), "PRIORITY_SELECTOR_RANGE");
            QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "PRIORITY_SELECTOR_SIGNAL_MISSING");
            mouseInput(qualified);
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Home);
            for (int row = 0; row < index; ++row) { keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Down); }
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Return);
            require(qualified && activated.count() == 1 && qualified->property("currentIndex").toInt() == index, "PRIORITY_SELECTOR_ACTIVATION");
            inputEvidence = {{"kind", "selector"}, {"mouseDispatchCount", 1}, {"activatedSignals", activated.count()}, {"selectedIndex", index}};
        });
    }
    void newRead() {
        readId = s->request("archive:get");
        require(!readId.isEmpty() && !responses.contains(readId), "PRIORITY_READ_NOT_NEW");
    }
    bool readReady() {
        require(clock.elapsed() - at < 10000, "PRIORITY_READ_DEADLINE");
        if (!responses.contains(readId)) return false;
        const auto receipt = responses.value(readId);
        require(receipt.value("ok").metaType().id() == QMetaType::Bool && receipt.value("ok").toBool() &&
                receipt.value("scope") == s->scopeKey() && receipt.value("generation").toInt() == s->generation() &&
                receipt.value("personaId") == active() && receipt.value("command") == "archive:get" &&
                receipt.value("revision").toInt() == currentRevision() && receipt.value("archiveHash") == hash(archive()),
                "PRIORITY_READ_IDENTITY");
        return !pending("archive:get");
    }
    void requireFixture(int priority) {
        const auto book = fixtureBook(archive()); const auto entries = book.value("entries").toList();
        require(book.value("tokenBudget").toInt() == 8 && entries.size() == 2, "PRIORITY_FIXTURE_BOOK");
        for (int i = 0; i < 2; ++i) {
            const auto entry = entries[i].toMap();
            require(entry.value("id") == (i ? entryB : entryA) && entry.value("content") == (i ? "PRIORITY_B_ONLY" : "PRIORITY_A_ONLY") &&
                entry.value("priority").toLongLong() == (i ? 1 : priority) && entry.value("insertionOrder").toInt() == (i ? 20 : 10) &&
                entry.value("enabled").toBool() && entry.value("alwaysActive").toBool() && !entry.value("useRegex").toBool() &&
                entry.value("tokenBudget").isNull(), "PRIORITY_FIXTURE_ENTRY");
        }
        require(withoutFixture(archive()) == sunnyBaseline, "PRIORITY_OTHER_FIELDS_CHANGED");
    }
    bool reply() {
        require(clock.elapsed() - at < 10000, "PRIORITY_CHAT_DEADLINE");
        if (s->busy() || pending("chat:history") || pending("chat:send")) return false;
        const auto all = s->messages(); if (all.size() < chatBefore.size() + 2) return false;
        require(all.size() == chatBefore.size() + 2 && ids().mid(0, chatBefore.size()) == chatBefore, "PRIORITY_CHAT_ID_PREFIX");
        const auto user = all[all.size()-2].toMap(), assistant = all.last().toMap();
        const QString request = user.value("request_id").toString();
        require(user.value("role") == "user" && user.value("content") == chatTexts[stage-1] && assistant.value("role") == "assistant" &&
                assistant.value("content") == "优先级效果已核对" && !request.isEmpty() && assistant.value("request_id") == request,
                "PRIORITY_CHAT_PAIR");
        chats.append(QVariantMap{{"stage", stage}, {"requestId", request}, {"scope", s->scopeKey()}, {"generation", s->generation()},
            {"personaId", active()}, {"beforeIds", chatBefore}, {"afterIds", ids()}, {"userId", user.value("id")}, {"assistantId", assistant.value("id")},
            {"text", user.value("content")}, {"reply", assistant.value("content")}, {"revision", currentRevision()}, {"archiveHash", hash(archive())}});
        return true;
    }
    void tick() {
        require(clock.elapsed() < deadline(), "PRIORITY_SEGMENT_DEADLINE");
        require(s->connected() && s->runtimeWritable() && s->recoveryState() == "clean", "PRIORITY_RUNTIME_UNAVAILABLE");
        // Scope changes are permitted only at the two explicit confirmation steps.
        if (!scope.isEmpty() && !QList<int>{3, 4, 41, 42}.contains(step))
            require(s->scopeKey() == scope && s->generation() == generation, "PRIORITY_SCOPE_CHANGED");
        if (step == 0) {
            if (!settled()) return;
            require(!e->dirty() && s->draft().isEmpty(), "PRIORITY_START_HAS_DRAFT");
            originalPersona = active(); originalScope = scope = s->scopeKey(); generation = s->generation();
            const auto profiles = s->state().value("personas").toMap().value("profiles").toList();
            require(profiles.size() == 4, "PRIORITY_PROFILE_COUNT");
            QString moon;
            for (const auto &v : profiles) {
                const auto p = v.toMap(); if (p.value("name") == "测试人格·晴") sunny = p.value("id").toString();
                if (p.value("name") == "测试人格·月") moon = p.value("id").toString();
            }
            require(!sunny.isEmpty() && sunny != originalPersona && originalPersona == (restart ? "default" : moon), "PRIORITY_START_PERSONA");
            newRead(); next(50); return;
        }
        if (step == 50) {
            if (!readReady() || !settled()) return;
            original = snapshot(); originalArchive = archive(); observed["originalBefore"] = original;
            observed["sunnyPersonaId"] = sunny; observed["originalScope"] = originalScope; observed["originalReadId"] = readId;
            next(51); return;
        }
        if (step == 51) { if (click("nav-character")) next(1); return; }
        if (step == 1) { if (personaRowClick()) next(2); return; }
        if (step == 2) { if (click("personaSwitchConfirm")) next(3); return; }
        if (step == 3) {
            require(clock.elapsed() - at < 10000, "PRIORITY_SWITCH_DEADLINE");
            if (s->personaChanging() || !settled()) return;
            require(s->personaFeedback().value("status") == "success" && active() == sunny && s->scopeKey() != originalScope && s->draft().isEmpty(), "PRIORITY_SWITCH_UNCONFIRMED");
            scope = s->scopeKey(); generation = s->generation(); observed["sunnyScope"] = scope;
            newRead(); next(4); return;
        }
        if (step == 4) {
            if (!readReady() || !settled()) return;
            sunnyBefore = ids(); sunnyBaseline = withoutFixture(archive()); revision = currentRevision();
            const auto raw = s->state().value("archive").toMap();
            if (archive().isEmpty()) {
                require(raw.value("exists").metaType().id() == QMetaType::Bool && !raw.value("exists").toBool() && revision == 0 && raw.value("archive").isNull(), "PRIORITY_ABSENT_ARCHIVE_IDENTITY");
                sunnyBaseline = {{"characters", QVariantList{}}, {"activeCharacterIds", QVariantList{}}, {"worldBooks", QVariantList{}}};
            } else require(raw.value("exists").toBool() && archive().contains("characters") && archive().contains("activeCharacterIds") && archive().contains("worldBooks"), "PRIORITY_BASELINE_NOT_CANONICAL");
            observed["canonicalBaselineRestHash"] = hash(sunnyBaseline);
            observed["sunnyBefore"] = snapshot(); observed["baselineReadId"] = readId;
            if (restart) {
                requireFixture(0); terminalArchive = archive();
                observed["terminalBefore"] = snapshot(); observed["book"] = fixtureBook(archive());
                record("priority-restart-sunny-archive-and-message-identities"); stage = 3;
                next(29); return;
            }
            require(archive().value("worldBooks").toList().isEmpty() && fixtureBook(archive()).isEmpty(), "PRIORITY_SEED_BASELINE_NOT_EMPTY");
            record("priority-original-persona-captured-and-sunny-baseline-read");
            auto proposed = sunnyBaseline; QVariantList entries;
            for (int i = 0; i < 2; ++i) entries.append(QVariantMap{{"id", i ? entryB : entryA}, {"comment", i ? "预算候选 B" : "预算候选 A"},
                {"content", i ? "PRIORITY_B_ONLY" : "PRIORITY_A_ONLY"}, {"keywords", QVariantList{}}, {"secondaryKeywords", QVariantList{}},
                {"selectiveLogic", "and_any"}, {"caseSensitive", false}, {"useRegex", false}, {"enabled", true}, {"alwaysActive", true},
                {"position", "before_char"}, {"insertionOrder", i ? 20 : 10}, {"priority", i}, {"depth", 0}, {"role", "system"}});
            proposed["worldBooks"] = QVariantList{QVariantMap{{"id", bookId}, {"name", "优先级预算验收资料"},
                {"scanDepth", 1}, {"tokenBudget", 8}, {"recursiveScanning", false}, {"entries", entries}}};
            require(s->scopeKey() == scope && s->generation() == generation && active() == sunny,
                    "PRIORITY_PREPARATION_SCOPE_CHANGED");
            writeId = s->request("archive:put", {{"archive", proposed}, {"expected_revision", revision}});
            require(!writeId.isEmpty(), "PRIORITY_PREPARATION_NOT_SENT"); observed["prepareWriteId"] = writeId; observed["preparedExpectedRevision"] = revision;
            next(5); return;
        }
        if (step == 5) {
            require(clock.elapsed() - at < 10000, "PRIORITY_PREPARATION_DEADLINE");
            if (!responses.contains(writeId)) return;
            const auto r = responses.value(writeId);
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == sunny && r.value("command") == "archive:put" && r.value("revision").toInt() == revision+1,
                    "PRIORITY_PREPARATION_RECEIPT");
            requireFixture(0); revision = currentRevision(); observed["preparedRevision"] = revision;
            newRead(); next(6); return;
        }
        if (step == 6) {
            if (!readReady()) return; requireFixture(0); observed["prepareReadId"] = readId;
            record("priority-fixture-prepared-once-with-budget-eight");
            next(16); return;
        }
        if (step == 16) { if (click("nav-memory")) next(7); return; }
        if (step == 29) { if (click("nav-chat")) next(30); return; }
        if (step == 7) { if (click("reloadWorldbook")) next(8); return; }
        if (step == 8) {
            if (phaseClock.inputAt() < 0) {
                require(clock.elapsed() - at < 10000, "PRIORITY_RELOAD_READ_DEADLINE");
                if (!settled()) return;
                require(phaseClock.beginInput(clock.elapsed()), "PRIORITY_INPUT_CLOCK");
            }
            if (select("worldbookBookSelector", e->bookRows(), bookId)) next(9); return;
        }
        if (step == 9) { if (select("worldbookEntrySelector", e->entryRows(), entryA)) { stage = 1; next(10); } return; }
        if (step == 10) {
            const int target = stage == 1 ? 2 : 0;
            if (control("worldbookPriority", [this, target](QQuickItem *control) {
                QPointer<QQuickItem> qualified = control;
                require(e->priorityEditable() && e->priorityConfirmed(), "PRIORITY_CONTROL_NOT_EDITABLE");
                mouseInput(control);
                require(qualified, "PRIORITY_KEY_TARGET_CHANGED");
                control->forceActiveFocus();
                const int before = control->property("value").toInt(); require(qAbs(target-before) == 2, "PRIORITY_CONTROL_BASELINE");
                QSignalSpy modified(control, SIGNAL(valueModified())); require(modified.isValid(), "PRIORITY_CONTROL_SIGNAL_MISSING");
                for (int i=0; i<2; ++i) { keyInput(qualified); QTest::keyClick(w, target > before ? Qt::Key_Up : Qt::Key_Down); }
                require(qualified && modified.count() == 2 && qualified->property("value").toInt() == target && e->priority().toInt() == target && e->dirty(), "PRIORITY_CONTROL_INPUT");
                inputEvidence = {{"kind", "integer"}, {"mouseDispatchCount", 1}, {"keyDispatchCount", 2}, {"valueModifiedSignals", modified.count()}};
            })) next(11); return;
        }
        if (step == 11) {
            if (!saveBinding.metadata().value("armed").toBool()) {
                revision = currentRevision();
                require(saveBinding.arm(scope, generation, pendingCommands(), receipts), "PRIORITY_SAVE_BINDING_BASELINE");
            }
            if (click("saveWorldbook")) {
                const auto matched = saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts);
                require(matched == ArchiveInputProbe::SaveBinding::Matched, "PRIORITY_SAVE_NOT_DISPATCHED", saveBinding.metadata());
                writeId = saveBinding.requestId(); next(12);
            } return;
        }
        if (step == 12) {
            require(clock.elapsed()-at < 10000, "PRIORITY_SAVE_DEADLINE");
            if (!responses.contains(writeId) || e->busy()) return;
            const auto r = responses.value(writeId);
            require(saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts) == ArchiveInputProbe::SaveBinding::Matched,
                    "PRIORITY_SAVE_BINDING_CHANGED", saveBinding.metadata());
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation && r.value("personaId") == sunny &&
                    r.value("revision").toInt() == revision+1 && e->status() == "saved" && !e->dirty(), "PRIORITY_SAVE_RECEIPT");
            requireFixture(stage == 1 ? 2 : 0); newRead(); next(13); return;
        }
        if (step == 13) {
            if (phaseClock.inputAt() < 0) {
                if (!readReady()) return;
                require(phaseClock.beginInput(clock.elapsed()), "PRIORITY_INPUT_CLOCK");
            }
            requireFixture(stage == 1 ? 2 : 0);
            if (!control("archive-status", [this](QQuickItem *label) {
                require(label->property("text").toString().contains("已保存"), "PRIORITY_SAVE_FEEDBACK");
                const QString image = prefix + ".worldbook-priority-save-" + QString::number(stage) + ".png";
                require(w->grabWindow().save(image), "PRIORITY_CAPTURE_FAILED");
                inputTime();
                require(item("archive-status") == label && stable.matches(inspectControl(label)), "PRIORITY_CAPTURE_LAYOUT_CHANGED");
                saves.append(QVariantMap{{"stage", stage}, {"writeId", writeId}, {"readId", readId}, {"scope", scope},
                    {"generation", generation}, {"personaId", sunny}, {"expectedRevision", revision}, {"revision", currentRevision()},
                    {"priority", stage == 1 ? 2 : 0}, {"archiveHash", hash(archive())}, {"restHash", hash(withoutFixture(archive()))},
                    {"book", fixtureBook(archive())}, {"feedback", label->property("text")},
                    {"binding", saveBinding.metadata()}, {"readAtMs", at}, {"feedbackInputAtMs", phaseClock.inputAt()},
                    {"feedbackGeometry", NativeControlReadiness::wholeVisibility(label, w)}, {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"screenshot", image}});
            }, false)) return;
            next(14); return;
        }
        if (step == 14) { if (click("memory-close")) next(30); return; }
        if (step == 30) {
            if (control("chatComposer", [this](QQuickItem *composer) {
                QPointer<QQuickItem> qualified = composer;
                require(s->draft().isEmpty(), "PRIORITY_CHAT_STALE_DRAFT"); chatBefore = ids();
                mouseInput(composer);
                inputTime(); require(qualified, "PRIORITY_KEY_TARGET_CHANGED"); qualified->forceActiveFocus();
                QInputMethodEvent event; event.setCommitString(chatTexts[stage-1]);
                keyInput(qualified); QCoreApplication::sendEvent(w, &event);
                require(qualified && s->draft() == chatTexts[stage-1] && qualified->property("text") == chatTexts[stage-1], "PRIORITY_CHAT_INPUT");
                inputEvidence = {{"kind", "text"}, {"mouseDispatchCount", 1}, {"commitCount", 1}, {"focusInTarget", composer->hasActiveFocus() || (w->activeFocusItem() && composer->isAncestorOf(w->activeFocusItem()))}};
            })) next(31); return;
        }
        if (step == 31) { if (click("sendChat")) next(32); return; }
        if (step == 32) {
            if (!reply()) return; requireFixture(stage == 1 ? 2 : 0);
            if (restart) record("priority-restart-third-chat-only-b-and-one-message-pair");
            else record(stage == 1 ? "priority-a-two-saved-read-back-and-first-chat" : "priority-a-zero-saved-read-back-and-second-chat");
            if (stage == 1) { stage = 2; next(33); return; }
            terminalArchive = archive(); observed["sunnyTerminal"] = snapshot(); observed["book"] = fixtureBook(archive());
            observed["sunnyBaselineMessageIds"] = sunnyBefore;
            if (!restart) record("priority-sunny-terminal-only-two-edits-and-four-messages");
            next(34); return;
        }
        if (step == 33) { if (click("nav-memory")) next(10); return; }
        if (step == 34) { if (click("nav-character")) next(40); return; }
        if (step == 40) { if (personaRowClick()) next(41); return; }
        if (step == 41) { if (click("personaSwitchConfirm")) next(42); return; }
        if (step == 42) {
            require(clock.elapsed()-at < 10000, "PRIORITY_RETURN_DEADLINE");
            if (!settled()) return;
            require(s->personaFeedback().value("status") == "success" && active() == originalPersona && s->scopeKey() != scope && s->draft().isEmpty(), "PRIORITY_RETURN_SCOPE");
            scope = s->scopeKey(); generation = s->generation(); newRead(); next(43); return;
        }
        if (step == 43) {
            if (!readReady() || !settled()) return;
            require(snapshot() == original && archive() == originalArchive, "PRIORITY_RETURN_CHANGED_ORIGINAL");
            observed["originalAfter"] = snapshot(); observed["returnScope"] = scope; observed["returnReadId"] = readId;
            record(restart ? "priority-restart-default-archive-messages-switches-avatar-preserved" : "priority-return-moon-archive-messages-switches-preserved");
            if (restart) record("priority-restart-zero-preparation-and-zero-save-writes");
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(puts == (restart ? 0 : 3) && saves.size() == (restart ? 0 : 2) && chats.size() == (restart ? 1 : 2), "PRIORITY_WRITE_CHAT_COUNTS");
            require(ids() == original.value("messageIds").toStringList(), "PRIORITY_ORIGINAL_HISTORY_CHANGED");
            observed["putCount"] = puts; finish(true); return;
        }
    }
    void finish(bool passed, QString error = {}) {
        if (finished) return; finished = true; timer.stop();
        if (personaInput && !personaInput->terminal()) personaInput->abort("priority-segment-failed", clock.elapsed());
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
void WorldbookPriorityCheck::run(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *e, bool restart,
    const QString &capture, std::function<void(QVariantMap)> done) { new Check(w,s,e,restart,capture,std::move(done)); }
