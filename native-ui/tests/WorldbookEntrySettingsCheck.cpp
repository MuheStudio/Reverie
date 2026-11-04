#include "WorldbookEntrySettingsCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
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

// The entry-level scan depth and budget tail of the isolated
// --p1-worldbook-entry mode. It runs on the default persona after the
// unchanged ordinary check, in its own book whose two entries are allocated
// before every other book, so no other condition decides either effect.
namespace {
const QString bookId = "p1_entry_settings_book", entryA = "p1_entry_settings_depth",
    entryB = "p1_entry_settings_budget";
const QString contentA = "ENTRY_DEPTH_A_16", contentB = "ENTRY_BUDGET_B_" + QString(86, QChar('X'));
const QStringList chatTexts{"条目记录一：远灯与预算灯", "条目记录二：预算灯", "条目记录三：请再核对"};
const QString reply = "条目设置效果已核对";
// The ordinary restart cycle types this draft and never sends it (the first
// cycle replaces and sends it), so the restart tail starts and ends with it.
const QString syntheticDraft = "原生场景中的合成草稿";
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
// -1 is an explicit null: the entry follows the book. Prepared, then after
// each of the three saves (A depth 5; B budget 50; A follows the book again).
struct Settings { int scanA, budgetA, scanB, budgetB; };
const Settings states[] = {{-1, -1, -1, -1}, {5, -1, -1, -1}, {5, -1, -1, 50}, {-1, -1, -1, 50}};
class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, finished = false;
    QString prefix, scope, readId, writeId;
    int step = 0, generation = 0, stage = 0, revision = 0;
    qint64 at = 0;
    quint64 frame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QVariantMap observed, restBaseline, inputEvidence;
    QStringList baselineIds, chatBefore;
    QVariantList checks, inputs, receipts, saves, chats, samples;
    QMap<QString, QVariantMap> responses;
    SummaryInteractionProbe::StableGate stable;
    NativeControlReadiness::SequentialGate inputGate;
    ArchiveInputProbe::PhaseClock phaseClock;
    ArchiveInputProbe::SaveBinding saveBinding;
    QString inputScope;
    int inputGeneration = -1;
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
                if (receipts.size() >= 40) { finish(false, "ENTRY_SETTINGS_RECEIPT_BOUND"); return; }
                const auto archive = result.value("archive").toMap();
                QVariantMap record{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scope", s->scopeKey()}, {"personaId", active()}, {"ok", result.value("ok")},
                    {"revision", result.value("revision")}, {"exists", result.value("exists")}, {"archiveHash", hash(archive)},
                    {"book", fixtureBook(archive)}, {"restHash", hash(withoutFixture(archive))}};
                receipts.append(record);
                responses[id] = record;
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            if (!finished && (id == readId || id == writeId)) finish(false, "ENTRY_SETTINGS_REQUEST_FAILED:" + code);
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
    int deadline() const { return restart ? 20000 : 45000; }
    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(ok, code, details);
    }
    void next(int n) {
        step = n; at = clock.elapsed(); stable.reset(); inputGate.resetForNextStep();
        phaseClock.enter(at, n == 8 || n == 13 || n == 20 || n == 22);
        if (n == 11) saveBinding = {};
        inputScope = s->scopeKey(); inputGeneration = s->generation();
    }
    void record(const QString &name) {
        for (const auto &value : checks) require(value.toMap().value("name") != name, "ENTRY_SETTINGS_CHECK_DUPLICATED");
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
                phaseClock.elapsed(clock.elapsed()) < 4000, "ENTRY_SETTINGS_INPUT_DEADLINE");
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "ENTRY_SETTINGS_INPUT_SCOPE_CHANGED");
    }
    bool settled() const {
        for (const auto *command : {"persona:get", "persona:list", "chat:history", "archive:get"}) if (pending(command)) return false;
        return !s->personaChanging() && e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == currentRevision();
    }
    static bool checkbox(const QString &name) { return name.endsWith("Inherit"); }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &perform, bool clickable = true) {
        require(phaseClock.beginInput(clock.elapsed()), "ENTRY_SETTINGS_INPUT_CLOCK");
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : phaseClock.elapsed(clock.elapsed()); };
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"control", name}, {"elapsedMs", elapsed()},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"frame", QVariant::fromValue(frame)},
            {"revealSummary", NativeControlReadiness::revealSummary(revealed)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(target, w)}};
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "ENTRY_SETTINGS_INPUT_DEADLINE");
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
                require(qualified && item(name) == qualified && stable.matches(fresh), "ENTRY_SETTINGS_INPUT_TARGET_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
                if (clickable) require(hit.accepted(), "ENTRY_SETTINGS_INPUT_HIT", hit.metadata());
                const auto beforeValue = qualified->property(checkbox(name) ? "checked" : "value");
                inputTime(); inputEvidence.clear(); perform(qualified);
                require(clock.elapsed() < deadline() && elapsed() < 4000, "ENTRY_SETTINGS_INPUT_DEADLINE");
                require(qualified, "ENTRY_SETTINGS_CONTROL_DESTROYED_AFTER_INPUT");
                if (clickable) inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
                    {"generation", inputGeneration}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"beforeValue", beforeValue}, {"afterValue", qualified->property(checkbox(name) ? "checked" : "value")},
                    {"selectedEntryId", selectedEntryId()}, {"signals", inputEvidence}, {"hit", hit.metadata()},
                    {"windowWidth", w->width()}, {"windowHeight", w->height()},
                    {"inputAtMs", phaseClock.inputAt()}, {"stepAtMs", at}, {"elapsedMs", elapsed()}});
            }}});
        require(result != NativeControlReadiness::SequentialGate::Expired, "ENTRY_SETTINGS_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "ENTRY_SETTINGS_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        return true;
    }
    void mouseInput(QQuickItem *target) {
        inputTime(); QPointer<QQuickItem> qualified = target;
        const auto fresh = inspectControl(qualified);
        require(qualified && item(qualified->objectName()) == qualified && stable.matches(fresh), "ENTRY_SETTINGS_MOUSE_TARGET_CHANGED");
        require(NativeCheck::hitTest(w, fresh.point, qualified).accepted(), "ENTRY_SETTINGS_MOUSE_HIT_CHANGED");
        inputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
    }
    void keyInput(QQuickItem *target, bool selector = false) const {
        inputTime(); QPointer<QQuickItem> qualified = target;
        require(qualified && item(qualified->objectName()) == qualified && qualified->isEnabled(),
                "ENTRY_SETTINGS_KEY_TARGET_CHANGED");
        require(ArchiveInputProbe::keyboardFocusMatches(qualified, w, selector), "ENTRY_SETTINGS_KEY_FOCUS_MISMATCH",
                {{"selector", selector}, {"focusFound", w->activeFocusItem() != nullptr}});
        inputTime();
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy signal(target, SIGNAL(clicked())); require(signal.isValid(), "ENTRY_SETTINGS_CLICK_SIGNAL_MISSING");
            mouseInput(target);
            require(signal.count() == 1, "ENTRY_SETTINGS_CLICK_SIGNAL_COUNT");
            inputEvidence = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", signal.count()}};
        });
    }
    // Index 0 of the book selector is "all books"; index 0 of the entry
    // selector is the book-settings row.
    bool select(const QString &name, int index) {
        return control(name, [this, index](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            require(index >= 0 && index < target->property("count").toInt() && target->property("currentIndex").toInt() != index,
                    "ENTRY_SETTINGS_SELECTOR_RANGE");
            QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "ENTRY_SETTINGS_SELECTOR_SIGNAL_MISSING");
            mouseInput(qualified);
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Home);
            for (int row = 0; row < index; ++row) { keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Down); }
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Return);
            require(qualified && activated.count() == 1 && qualified->property("currentIndex").toInt() == index, "ENTRY_SETTINGS_SELECTOR_ACTIVATION");
            inputEvidence = {{"kind", "selector"}, {"mouseDispatchCount", 1}, {"activatedSignals", activated.count()}, {"selectedIndex", index}};
        });
    }
    QString selectedEntryId() const {
        for (const auto &v : e->entryRows()) if (v.toMap().value("key") == e->selectedEntryKey()) return v.toMap().value("id").toString();
        return {};
    }
    int bookIndex() const {
        const auto rows = e->bookRows();
        for (int i = 0; i < rows.size(); ++i) if (rows[i].toMap().value("id") == bookId) return i + 1;
        return -1;
    }
    int entryIndex(const QString &id) const {
        const auto rows = e->entryRows();
        for (int i = 0; i < rows.size(); ++i) if (rows[i].toMap().value("id") == id) return i + 1;
        return -1;
    }
    bool toggleInherit(const QString &name, const QString &key, bool after, const QString &entry) {
        return control(name, [this, key, after, entry](QQuickItem *control) {
            QPointer<QQuickItem> qualified = control;
            require(selectedEntryId() == entry && e->entrySettingEditable(key) && e->entrySettingInherited(key) != after &&
                    control->property("checked").toBool() != after && control->isEnabled() &&
                    (after || e->entrySettingCanOverride(key)), "ENTRY_SETTINGS_CONTROL_NOT_EDITABLE");
            QSignalSpy toggled(control, SIGNAL(toggled())); require(toggled.isValid(), "ENTRY_SETTINGS_CONTROL_SIGNAL_MISSING");
            mouseInput(control);
            require(qualified && toggled.count() == 1 && qualified->property("checked").toBool() == after &&
                    e->entrySettingInherited(key) == after && e->dirty(), "ENTRY_SETTINGS_CONTROL_INPUT");
            inputEvidence = {{"kind", "checkbox"}, {"mouseDispatchCount", 1}, {"toggledSignals", toggled.count()}, {"checked", after}};
        });
    }
    bool stepInteger(const QString &name, const QString &key, int before, int after, int presses, const QString &entry) {
        return control(name, [this, key, before, after, presses, entry](QQuickItem *control) {
            QPointer<QQuickItem> qualified = control;
            require(selectedEntryId() == entry && e->entrySettingEditable(key) && !e->entrySettingInherited(key),
                    "ENTRY_SETTINGS_CONTROL_NOT_EDITABLE");
            mouseInput(control);
            require(qualified, "ENTRY_SETTINGS_KEY_TARGET_CHANGED");
            control->forceActiveFocus();
            const auto current = key == "scanDepth" ? e->entryScanDepth() : e->entryTokenBudget();
            require(control->property("value").toInt() == before && current.toInt() == before, "ENTRY_SETTINGS_CONTROL_BASELINE");
            QSignalSpy modified(control, SIGNAL(valueModified())); require(modified.isValid(), "ENTRY_SETTINGS_CONTROL_SIGNAL_MISSING");
            for (int i = 0; i < presses; ++i) { keyInput(qualified); QTest::keyClick(w, after > before ? Qt::Key_Up : Qt::Key_Down); }
            const auto value = key == "scanDepth" ? e->entryScanDepth() : e->entryTokenBudget();
            require(qualified && modified.count() == presses && qualified->property("value").toInt() == after && value.toInt() == after && e->dirty(),
                    "ENTRY_SETTINGS_CONTROL_INPUT");
            inputEvidence = {{"kind", "integer"}, {"mouseDispatchCount", 1}, {"keyDispatchCount", presses}, {"valueModifiedSignals", modified.count()}};
        });
    }
    void newRead() {
        readId = s->request("archive:get");
        require(!readId.isEmpty() && !responses.contains(readId), "ENTRY_SETTINGS_READ_NOT_NEW");
    }
    bool readReady() {
        require(clock.elapsed() - at < 10000, "ENTRY_SETTINGS_READ_DEADLINE");
        if (!responses.contains(readId)) return false;
        const auto receipt = responses.value(readId);
        require(receipt.value("ok").metaType().id() == QMetaType::Bool && receipt.value("ok").toBool() &&
                receipt.value("scope") == s->scopeKey() && receipt.value("generation").toInt() == s->generation() &&
                receipt.value("personaId") == active() && receipt.value("command") == "archive:get" &&
                receipt.value("revision").toInt() == currentRevision() && receipt.value("archiveHash") == hash(archive()),
                "ENTRY_SETTINGS_READ_IDENTITY");
        return !pending("archive:get");
    }
    static bool setting(const QVariantMap &entry, const QString &key, int expected) {
        if (!entry.contains(key)) return false;
        const auto value = entry.value(key);
        if (expected < 0) return value.metaType().id() == QMetaType::Nullptr;
        return value.metaType().id() != QMetaType::Nullptr && value.toDouble() == expected;
    }
    void requireFixture(const Settings &expected) {
        const auto book = fixtureBook(archive()); const auto entries = book.value("entries").toList();
        require(book.value("scanDepth").toInt() == 1 && book.value("tokenBudget").toInt() == 100 &&
                book.value("recursiveScanning") == QVariant(false) && book.value("name") == "条目设置验收资料" &&
                entries.size() == 2, "ENTRY_SETTINGS_FIXTURE_BOOK");
        for (int i = 0; i < 2; ++i) {
            const auto entry = entries[i].toMap();
            require(entry.value("id") == (i ? entryB : entryA) && entry.value("content") == (i ? contentB : contentA) &&
                entry.value("keywords") == QVariantList{i ? "预算灯" : "远灯"} && entry.value("insertionOrder").toInt() == (i ? 40 : 30) &&
                entry.value("priority").toInt() == 1000 && entry.value("enabled").toBool() && !entry.value("alwaysActive").toBool() &&
                !entry.value("useRegex").toBool() && entry.value("secondaryKeywords").toList().isEmpty(),
                "ENTRY_SETTINGS_FIXTURE_ENTRY");
            require(setting(entry, "scanDepth", i ? expected.scanB : expected.scanA) &&
                    setting(entry, "tokenBudget", i ? expected.budgetB : expected.budgetA), "ENTRY_SETTINGS_FIXTURE_VALUES",
                    {{"entry", entry.value("id")}});
        }
        require(withoutFixture(archive()) == restBaseline, "ENTRY_SETTINGS_OTHER_FIELDS_CHANGED");
    }
    bool chatReply() {
        require(clock.elapsed() - at < 10000, "ENTRY_SETTINGS_CHAT_DEADLINE");
        if (s->busy() || pending("chat:history") || pending("chat:send")) return false;
        const auto all = s->messages(); if (all.size() < chatBefore.size() + 2) return false;
        require(all.size() == chatBefore.size() + 2 && ids().mid(0, chatBefore.size()) == chatBefore, "ENTRY_SETTINGS_CHAT_ID_PREFIX");
        const auto user = all[all.size()-2].toMap(), assistant = all.last().toMap();
        const QString request = user.value("request_id").toString();
        require(user.value("role") == "user" && user.value("content") == chatTexts[stage-1] && assistant.value("role") == "assistant" &&
                assistant.value("content") == reply && !request.isEmpty() && assistant.value("request_id") == request,
                "ENTRY_SETTINGS_CHAT_PAIR");
        chats.append(QVariantMap{{"stage", stage}, {"requestId", request}, {"scope", s->scopeKey()}, {"generation", s->generation()},
            {"personaId", active()}, {"beforeIds", chatBefore}, {"afterIds", ids()}, {"userId", user.value("id")}, {"assistantId", assistant.value("id")},
            {"text", user.value("content")}, {"reply", assistant.value("content")}, {"revision", currentRevision()}, {"archiveHash", hash(archive())}});
        return true;
    }
    // Restart samples share one step's input clock; each control has its own
    // whole-item observation and none claims simultaneous visibility.
    bool sample(const QStringList &names, const QString &entry) {
        if (phaseClock.inputAt() < 0) {
            require(clock.elapsed() - at < 10000, "ENTRY_SETTINGS_READBACK_DEADLINE");
            if (!settled()) return false;
            require(phaseClock.beginInput(clock.elapsed()), "ENTRY_SETTINGS_INPUT_CLOCK");
        }
        int taken = 0;
        for (const auto &v : samples) taken += v.toMap().value("step").toInt() == step;
        require(taken < names.size(), "ENTRY_SETTINGS_READBACK_SAMPLE_OVERFLOW");
        const QString name = names[taken];
        if (!control(name, [this, name, entry](QQuickItem *target) {
            const QString key = name.contains("ScanDepth") ? "scanDepth" : "tokenBudget";
            const bool inheritControl = checkbox(name);
            const auto value = target->property(inheritControl ? "checked" : "value");
            const auto expected = states[3];
            const int stored = entry == entryA ? (key == "scanDepth" ? expected.scanA : expected.budgetA)
                                               : (key == "scanDepth" ? expected.scanB : expected.budgetB);
            require(target->isVisible() && target->isEnabled() && selectedEntryId() == entry && !e->dirty(), "ENTRY_SETTINGS_READBACK_CONTROLS");
            require(e->entrySettingInherited(key) == (stored < 0) &&
                    (inheritControl ? value.toBool() == (stored < 0) : value.toInt() == stored &&
                     (key == "scanDepth" ? e->entryScanDepth() : e->entryTokenBudget()).toInt() == stored),
                    "ENTRY_SETTINGS_READBACK_VALUES", {{"control", name}});
            requireFixture(states[3]);
            const auto baseline = responses.value(observed.value("restartReadId").toString());
            require(baseline.value("archiveHash") == hash(archive()) && baseline.value("revision").toInt() == currentRevision(),
                    "ENTRY_SETTINGS_READBACK_ARCHIVE_CHANGED");
            inputTime();
            samples.append(QVariantMap{{"control", name}, {"step", step}, {"entryId", entry}, {"value", value},
                {"inherited", e->entrySettingInherited(key)}, {"scope", scope}, {"generation", generation}, {"personaId", active()},
                {"revision", currentRevision()}, {"archiveHash", hash(archive())}, {"stepAtMs", at}, {"inputAtMs", phaseClock.inputAt()},
                {"sampledAtMs", clock.elapsed()}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                {"geometry", NativeControlReadiness::wholeVisibility(target, w)}, {"windowWidth", w->width()}, {"windowHeight", w->height()}});
        }, false)) return false;
        if (taken + 1 < names.size()) {
            // Re-arm target qualification only, never next()/PhaseClock.
            stable.reset(); inputGate.resetForNextStep(); w->update(); return false;
        }
        return true;
    }
    void tick() {
        require(clock.elapsed() < deadline(), "ENTRY_SETTINGS_SEGMENT_DEADLINE");
        require(s->connected() && s->runtimeWritable() && s->recoveryState() == "clean", "ENTRY_SETTINGS_RUNTIME_UNAVAILABLE");
        if (!scope.isEmpty())
            require(s->scopeKey() == scope && s->generation() == generation && active() == "default", "ENTRY_SETTINGS_SCOPE_CHANGED");
        if (step == 0) {
            if (!settled()) return;
            const QString expectedDraft = restart ? syntheticDraft : QString();
            observed["startState"] = QVariantMap{{"dirty", e->dirty()}, {"draftLength", s->draft().size()},
                {"expectedDraftLength", expectedDraft.size()}, {"draftMatches", s->draft() == expectedDraft}, {"activeId", active()}};
            require(!e->dirty(), "ENTRY_SETTINGS_START_EDITOR_DIRTY");
            require(s->draft() == expectedDraft, "ENTRY_SETTINGS_START_DRAFT",
                    {{"draftLength", s->draft().size()}, {"expectedDraftLength", expectedDraft.size()}});
            require(active() == "default", "ENTRY_SETTINGS_START_PERSONA", {{"activeId", active()}});
            scope = s->scopeKey(); generation = s->generation();
            newRead(); next(50); return;
        }
        if (step == 50) {
            if (!readReady() || !settled()) return;
            revision = currentRevision(); baselineIds = ids();
            restBaseline = withoutFixture(archive());
            observed["baselineReadId"] = readId; observed["baselineRevision"] = revision;
            observed["baselineArchiveHash"] = hash(archive()); observed["baselineMessageIds"] = baselineIds;
            observed["restHash"] = hash(restBaseline); observed["scope"] = scope;
            if (restart) {
                requireFixture(states[3]);
                observed["restartReadId"] = readId;
                record("entry-settings-restart-archive-and-messages-read-back");
                next(16); return;
            }
            require(fixtureBook(archive()).isEmpty(), "ENTRY_SETTINGS_BASELINE_UNEXPECTED");
            observed["otherBookCount"] = restBaseline.value("worldBooks").toList().size();
            record("entry-settings-default-baseline-read");
            auto proposed = archive(); auto books = proposed.value("worldBooks").toList(); QVariantList entries;
            for (int i = 0; i < 2; ++i) entries.append(QVariantMap{{"id", i ? entryB : entryA}, {"comment", i ? "预算条目" : "深度条目"},
                {"content", i ? contentB : contentA}, {"keywords", QVariantList{i ? "预算灯" : "远灯"}},
                {"secondaryKeywords", QVariantList{}}, {"selectiveLogic", "and_any"}, {"caseSensitive", false}, {"useRegex", false},
                {"enabled", true}, {"alwaysActive", false}, {"position", "before_char"}, {"insertionOrder", i ? 40 : 30},
                {"priority", 1000}, {"depth", 0}, {"role", "system"},
                {"scanDepth", QVariant::fromValue(nullptr)}, {"tokenBudget", QVariant::fromValue(nullptr)}});
            books.append(QVariantMap{{"id", bookId}, {"name", "条目设置验收资料"}, {"scanDepth", 1}, {"tokenBudget", 100},
                {"recursiveScanning", false}, {"entries", entries}});
            proposed["worldBooks"] = books;
            writeId = s->request("archive:put", {{"archive", proposed}, {"expected_revision", revision}});
            require(!writeId.isEmpty(), "ENTRY_SETTINGS_PREPARATION_NOT_SENT");
            observed["prepareWriteId"] = writeId; observed["preparedExpectedRevision"] = revision;
            next(5); return;
        }
        if (step == 5) {
            require(clock.elapsed() - at < 10000, "ENTRY_SETTINGS_PREPARATION_DEADLINE");
            if (!responses.contains(writeId)) return;
            const auto r = responses.value(writeId);
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == "default" && r.value("command") == "archive:put" && r.value("revision").toInt() == revision+1,
                    "ENTRY_SETTINGS_PREPARATION_RECEIPT");
            requireFixture(states[0]); revision = currentRevision(); observed["preparedRevision"] = revision;
            newRead(); next(6); return;
        }
        if (step == 6) {
            if (!readReady()) return; requireFixture(states[0]); observed["prepareReadId"] = readId;
            record("entry-settings-fixture-prepared-book-depth-one-budget-hundred-entries-follow-book");
            stage = 1; next(29); return;
        }
        if (step == 29) { if (click("nav-chat")) next(30); return; }
        if (step == 16) { if (click("nav-memory")) next(7); return; }
        if (step == 7) { if (click("reloadWorldbook")) next(8); return; }
        if (step == 8) {
            if (phaseClock.inputAt() < 0) {
                require(clock.elapsed() - at < 10000, "ENTRY_SETTINGS_RELOAD_READ_DEADLINE");
                if (!settled()) return;
                require(phaseClock.beginInput(clock.elapsed()), "ENTRY_SETTINGS_INPUT_CLOCK");
            }
            const int index = bookIndex();
            require(index > 0, "ENTRY_SETTINGS_SELECTOR_ID_MISSING");
            if (!select("worldbookBookSelector", index)) return;
            // Selecting a book also selects its first entry, A.
            require(e->hasEntry() && selectedEntryId() == entryA, "ENTRY_SETTINGS_FIRST_ENTRY_NOT_SELECTED");
            next(restart ? 20 : 10); return;
        }
        if (step == 10) { if (toggleInherit("worldbookEntryScanDepthInherit", "scanDepth", false, entryA)) next(17); return; }
        if (step == 17) { if (stepInteger("worldbookEntryScanDepth", "scanDepth", 1, 5, 4, entryA)) next(11); return; }
        if (step == 9) {
            const int index = entryIndex(entryB); require(index > 0, "ENTRY_SETTINGS_SELECTOR_ID_MISSING");
            if (!select("worldbookEntrySelector", index)) return;
            require(selectedEntryId() == entryB, "ENTRY_SETTINGS_ENTRY_NOT_SELECTED");
            next(18); return;
        }
        if (step == 18) { if (toggleInherit("worldbookEntryTokenBudgetInherit", "tokenBudget", false, entryB)) next(19); return; }
        if (step == 19) { if (stepInteger("worldbookEntryTokenBudget", "tokenBudget", 100, 50, 1, entryB)) next(11); return; }
        if (step == 33) { if (click("nav-memory")) next(34); return; }
        if (step == 34) {
            const int index = entryIndex(entryA); require(index > 0, "ENTRY_SETTINGS_SELECTOR_ID_MISSING");
            if (!select("worldbookEntrySelector", index)) return;
            require(selectedEntryId() == entryA, "ENTRY_SETTINGS_ENTRY_NOT_SELECTED");
            next(35); return;
        }
        if (step == 35) { if (toggleInherit("worldbookEntryScanDepthInherit", "scanDepth", true, entryA)) next(11); return; }
        if (step == 11) {
            if (!saveBinding.metadata().value("armed").toBool()) {
                revision = currentRevision();
                require(saveBinding.arm(scope, generation, pendingCommands(), receipts), "ENTRY_SETTINGS_SAVE_BINDING_BASELINE");
            }
            if (click("saveWorldbook")) {
                const auto matched = saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts);
                require(matched == ArchiveInputProbe::SaveBinding::Matched, "ENTRY_SETTINGS_SAVE_NOT_DISPATCHED", saveBinding.metadata());
                writeId = saveBinding.requestId(); next(12);
            } return;
        }
        if (step == 12) {
            require(clock.elapsed()-at < 10000, "ENTRY_SETTINGS_SAVE_DEADLINE");
            if (!responses.contains(writeId) || e->busy()) return;
            const auto r = responses.value(writeId);
            require(saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts) == ArchiveInputProbe::SaveBinding::Matched,
                    "ENTRY_SETTINGS_SAVE_BINDING_CHANGED", saveBinding.metadata());
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == "default" && r.value("revision").toInt() == revision+1 && e->status() == "saved" && !e->dirty(),
                    "ENTRY_SETTINGS_SAVE_RECEIPT");
            requireFixture(states[saves.size() + 1]); newRead(); next(13); return;
        }
        if (step == 13) {
            if (phaseClock.inputAt() < 0) {
                if (!readReady()) return;
                require(phaseClock.beginInput(clock.elapsed()), "ENTRY_SETTINGS_INPUT_CLOCK");
            }
            const int number = saves.size() + 1;
            requireFixture(states[number]);
            if (!control("archive-status", [this, number](QQuickItem *label) {
                require(label->property("text").toString().contains("已保存"), "ENTRY_SETTINGS_SAVE_FEEDBACK");
                const QString image = prefix + ".worldbook-entry-settings-save-" + QString::number(number) + ".png";
                require(w->grabWindow().save(image), "ENTRY_SETTINGS_CAPTURE_FAILED");
                inputTime();
                require(item("archive-status") == label && stable.matches(inspectControl(label)), "ENTRY_SETTINGS_CAPTURE_LAYOUT_CHANGED");
                const auto values = states[number];
                const auto json = [](int value) { return value < 0 ? QVariant::fromValue(nullptr) : QVariant(value); };
                saves.append(QVariantMap{{"stage", number}, {"writeId", writeId}, {"readId", readId}, {"scope", scope},
                    {"generation", generation}, {"personaId", active()}, {"expectedRevision", revision}, {"revision", currentRevision()},
                    {"entryId", selectedEntryId()},
                    {"settings", QVariantList{json(values.scanA), json(values.budgetA), json(values.scanB), json(values.budgetB)}},
                    {"archiveHash", hash(archive())}, {"restHash", hash(withoutFixture(archive()))},
                    {"book", fixtureBook(archive())}, {"feedback", label->property("text")},
                    {"binding", saveBinding.metadata()}, {"readAtMs", at}, {"feedbackInputAtMs", phaseClock.inputAt()},
                    {"feedbackGeometry", NativeControlReadiness::wholeVisibility(label, w)}, {"windowWidth", w->width()},
                    {"windowHeight", w->height()}, {"screenshot", image}});
            }, false)) return;
            if (number == 1) { record("entry-settings-a-depth-five-saved-and-read-back"); next(9); return; }
            record(number == 2 ? "entry-settings-b-budget-fifty-saved-and-read-back"
                               : "entry-settings-a-follows-book-again-saved-and-read-back");
            stage = number == 2 ? 2 : 3; next(14); return;
        }
        if (step == 20) {
            if (!sample({"worldbookEntryScanDepthInherit", "worldbookEntryTokenBudgetInherit"}, entryA)) return;
            record("entry-settings-restart-entry-a-follows-book-for-both");
            next(21); return;
        }
        if (step == 21) {
            const int index = entryIndex(entryB); require(index > 0, "ENTRY_SETTINGS_SELECTOR_ID_MISSING");
            if (!select("worldbookEntrySelector", index)) return;
            require(selectedEntryId() == entryB, "ENTRY_SETTINGS_ENTRY_NOT_SELECTED");
            next(22); return;
        }
        if (step == 22) {
            if (!sample({"worldbookEntryScanDepthInherit", "worldbookEntryTokenBudget"}, entryB)) return;
            const QString image = prefix + ".worldbook-entry-settings-restart.png";
            require(w->grabWindow().save(image), "ENTRY_SETTINGS_CAPTURE_FAILED");
            observed["restartScreenshot"] = image; observed["restartScreenshotControl"] = "worldbookEntryTokenBudget";
            record("entry-settings-restart-entry-b-budget-fifty-and-depth-follows-book");
            next(14); return;
        }
        if (step == 14) { if (click("memory-close")) next(restart ? 40 : 30); return; }
        if (step == 30) {
            if (control("chatComposer", [this](QQuickItem *composer) {
                QPointer<QQuickItem> qualified = composer;
                require(s->draft().isEmpty(), "ENTRY_SETTINGS_CHAT_STALE_DRAFT"); chatBefore = ids();
                mouseInput(composer);
                inputTime(); require(qualified, "ENTRY_SETTINGS_KEY_TARGET_CHANGED"); qualified->forceActiveFocus();
                QInputMethodEvent event; event.setCommitString(chatTexts[stage-1]);
                keyInput(qualified); QCoreApplication::sendEvent(w, &event);
                require(qualified && s->draft() == chatTexts[stage-1] && qualified->property("text") == chatTexts[stage-1], "ENTRY_SETTINGS_CHAT_INPUT");
                inputEvidence = {{"kind", "text"}, {"mouseDispatchCount", 1}, {"commitCount", 1}, {"focusInTarget", composer->hasActiveFocus() || (w->activeFocusItem() && composer->isAncestorOf(w->activeFocusItem()))}};
            })) next(31); return;
        }
        if (step == 31) { if (click("sendChat")) next(32); return; }
        if (step == 32) {
            if (!chatReply()) return; requireFixture(states[saves.size()]);
            if (stage == 1) { record("entry-settings-first-chat-both-entries-follow-book"); next(16); return; }
            if (stage == 2) { record("entry-settings-second-chat-a-depth-five-b-budget-fifty"); next(33); return; }
            record("entry-settings-third-chat-after-a-follows-book-again");
            require(saves.size() == 3 && chats.size() == 3, "ENTRY_SETTINGS_TERMINAL_EVIDENCE_COUNT");
            const auto lastSave = saves.last().toMap(), fresh = responses.value(lastSave.value("readId").toString()), chat = chats.last().toMap();
            require(currentRevision() == lastSave.value("revision").toInt() && currentRevision() == fresh.value("revision").toInt() &&
                    currentRevision() == chat.value("revision").toInt() && hash(archive()) == lastSave.value("archiveHash") &&
                    hash(archive()) == fresh.value("archiveHash") && hash(archive()) == chat.value("archiveHash"),
                    "ENTRY_SETTINGS_TERMINAL_FINAL_SAVE");
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(puts == 4 && ids().size() == baselineIds.size() + 6 && ids().mid(0, baselineIds.size()) == baselineIds,
                    "ENTRY_SETTINGS_WRITE_CHAT_COUNTS");
            observed["terminalRevision"] = currentRevision(); observed["terminalArchiveHash"] = hash(archive());
            observed["terminalMessageIds"] = ids(); observed["book"] = fixtureBook(archive()); observed["putCount"] = puts;
            record("entry-settings-terminal-three-saves-six-messages-rest-unchanged");
            finish(true); return;
        }
        if (step == 40) { newRead(); next(41); return; }
        if (step == 41) {
            if (!readReady() || !settled()) return;
            requireFixture(states[3]);
            const auto baseline = responses.value(observed.value("restartReadId").toString());
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(baseline.value("archiveHash") == hash(archive()) && baseline.value("revision").toInt() == currentRevision() &&
                    ids() == baselineIds && puts == 0 && saves.isEmpty() && chats.isEmpty(), "ENTRY_SETTINGS_RESTART_CHANGED");
            observed["terminalDraftMatches"] = s->draft() == syntheticDraft;
            require(s->draft() == syntheticDraft, "ENTRY_SETTINGS_RESTART_DRAFT_CHANGED", {{"draftLength", s->draft().size()}});
            observed["finalReadId"] = readId; observed["putCount"] = puts; observed["terminalMessageIds"] = ids();
            observed["terminalRevision"] = currentRevision(); observed["terminalArchiveHash"] = hash(archive());
            record("entry-settings-restart-zero-writes-and-zero-chats");
            finish(true); return;
        }
    }
    void finish(bool passed, QString error = {}) {
        if (finished) return; finished = true; timer.stop();
        observed["step"] = step; observed["elapsedMs"] = clock.elapsed();
        done({{"passed", passed}, {"error", error}, {"mode", restart ? "restart-readback" : "change-and-effect"},
            {"deadlineMs", deadline()}, {"checks", checks}, {"inputs", inputs}, {"receipts", receipts},
            {"saves", saves}, {"chats", chats}, {"samples", samples}, {"observed", observed}});
        deleteLater();
    }
};
}
void WorldbookEntrySettingsCheck::run(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *e, bool restart,
    const QString &capture, std::function<void(QVariantMap)> done) { new Check(w,s,e,restart,capture,std::move(done)); }
