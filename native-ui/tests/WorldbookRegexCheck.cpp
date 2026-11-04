#include "WorldbookRegexCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "ArchiveInputProbe.h"
#include "WorldbookRegexProbe.h"
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
#include <QSet>

// The regex editing and diagnostics tail of the isolated
// --p1-worldbook-regex mode. It runs on the default persona after the
// unchanged ordinary check, in its own book whose two entries are allocated
// before every other book, so no other condition decides either effect.
namespace {
const QString bookId = "p1_regex_book", entryA = "p1_regex_a", entryB = "p1_regex_b";
const QString contentA = "REGEX_A_ONLY", contentB = "REGEX_B_ONLY";
const QString patternA = "ID-\\d\\d", patternOldB = "ID-(?:\\d{4})",
    patternNewB = "ID-(?:\\d{1,3})", patternInvalidB = "ID-(?:\\d{1,3}";
const QStringList chatTexts{"正则记录一：ID-12", "正则记录二：ID-12", "正则记录三：ID-12"};
const QString reply = "正则设置效果已核对";
const QString syntheticDraft = "原生场景中的合成草稿";
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
struct Rules { bool regexA; QString patternB; };
const Rules states[] = {{false, patternOldB}, {true, patternOldB}, {true, patternNewB}, {true, patternInvalidB}};
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
    bool patternPerformed = false;
    quint64 patternPerformedFrame = 0;
    QVariantMap patternPending;
    QSet<QString> reloadBeforeIds;
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
                if (receipts.size() >= 40) { finish(false, "REGEX_RECEIPT_BOUND"); return; }
                const auto archive = result.value("archive").toMap();
                QVariantMap record{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scope", s->scopeKey()}, {"personaId", active()}, {"ok", result.value("ok")},
                    {"revision", result.value("revision")}, {"exists", result.value("exists")}, {"archiveHash", hash(archive)},
                    {"book", fixtureBook(archive)}, {"restHash", hash(withoutFixture(archive))},
                    {"runtimePersonaId", result.value("persona_id")}, {"worldBookDiagnostics", result.value("world_book_diagnostics")}};
                receipts.append(record);
                responses[id] = record;
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            if (!finished && (id == readId || id == writeId)) finish(false, "REGEX_REQUEST_FAILED:" + code);
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
        phaseClock.enter(at, n == 8 || n == 13 || n == 20 || n == 22 || n == 37 || n == 38 || n == 42);
        if (n == 11) saveBinding = {};
        patternPerformed = false; patternPending.clear(); patternPerformedFrame = 0;
        inputScope = s->scopeKey(); inputGeneration = s->generation();
    }
    void record(const QString &name) {
        for (const auto &value : checks) require(value.toMap().value("name") != name, "REGEX_CHECK_DUPLICATED");
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
                phaseClock.elapsed(clock.elapsed()) < 4000, "REGEX_INPUT_DEADLINE");
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "REGEX_INPUT_SCOPE_CHANGED");
    }
    bool settled() const {
        for (const auto *command : {"persona:get", "persona:list", "chat:history", "archive:get"}) if (pending(command)) return false;
        return !s->personaChanging() && e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == currentRevision();
    }
    static bool checkbox(const QString &name) { return name == "worldbookUseRegex" || name == "worldbookCaseSensitive"; }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &perform, bool clickable = true) {
        require(phaseClock.beginInput(clock.elapsed()), "REGEX_INPUT_CLOCK");
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : phaseClock.elapsed(clock.elapsed()); };
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"control", name}, {"elapsedMs", elapsed()},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"frame", QVariant::fromValue(frame)},
            {"revealSummary", NativeControlReadiness::revealSummary(revealed)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(target, w)}};
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "REGEX_INPUT_DEADLINE");
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
                require(qualified && item(name) == qualified && stable.matches(fresh), "REGEX_INPUT_TARGET_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
                if (clickable) require(hit.accepted(), "REGEX_INPUT_HIT", hit.metadata());
                const auto beforeValue = qualified->property(checkbox(name) ? "checked" : "value");
                inputTime(); inputEvidence.clear(); perform(qualified);
                require(clock.elapsed() < deadline() && elapsed() < 4000, "REGEX_INPUT_DEADLINE");
                require(qualified, "REGEX_CONTROL_DESTROYED_AFTER_INPUT");
                if (clickable) inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
                    {"generation", inputGeneration}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"beforeValue", beforeValue}, {"afterValue", qualified->property(checkbox(name) ? "checked" : "value")},
                    {"selectedEntryId", selectedEntryId()}, {"signals", inputEvidence}, {"hit", hit.metadata()},
                    {"windowWidth", w->width()}, {"windowHeight", w->height()},
                    {"inputAtMs", phaseClock.inputAt()}, {"stepAtMs", at}, {"elapsedMs", elapsed()}});
            }}});
        require(result != NativeControlReadiness::SequentialGate::Expired, "REGEX_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "REGEX_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        return true;
    }
    void mouseInput(QQuickItem *target) {
        inputTime(); QPointer<QQuickItem> qualified = target;
        const auto fresh = inspectControl(qualified);
        require(qualified && item(qualified->objectName()) == qualified && stable.matches(fresh), "REGEX_MOUSE_TARGET_CHANGED");
        require(NativeCheck::hitTest(w, fresh.point, qualified).accepted(), "REGEX_MOUSE_HIT_CHANGED");
        inputTime();
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
    }
    void keyInput(QQuickItem *target, bool selector = false) const {
        inputTime(); QPointer<QQuickItem> qualified = target;
        require(qualified && item(qualified->objectName()) == qualified && qualified->isEnabled(),
                "REGEX_KEY_TARGET_CHANGED");
        require(ArchiveInputProbe::keyboardFocusMatches(qualified, w, selector), "REGEX_KEY_FOCUS_MISMATCH",
                {{"selector", selector}, {"focusFound", w->activeFocusItem() != nullptr}});
        inputTime();
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy signal(target, SIGNAL(clicked())); require(signal.isValid(), "REGEX_CLICK_SIGNAL_MISSING");
            mouseInput(target);
            require(signal.count() == 1, "REGEX_CLICK_SIGNAL_COUNT");
            inputEvidence = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", signal.count()}};
        });
    }
    // Index 0 of the book selector is "all books"; index 0 of the entry
    // selector is the book-settings row.
    bool select(const QString &name, int index) {
        return control(name, [this, index](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            require(index >= 0 && index < target->property("count").toInt() && target->property("currentIndex").toInt() != index,
                    "REGEX_SELECTOR_RANGE");
            QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "REGEX_SELECTOR_SIGNAL_MISSING");
            mouseInput(qualified);
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Home);
            for (int row = 0; row < index; ++row) { keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Down); }
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Return);
            require(qualified && activated.count() == 1 && qualified->property("currentIndex").toInt() == index, "REGEX_SELECTOR_ACTIVATION");
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
    static QVariantMap ruleGroup(const QVariantMap &entry) {
        return {{"useRegex", entry.value("useRegex")}, {"keywords", entry.value("keywords")},
            {"secondaryKeywords", entry.value("secondaryKeywords")}, {"selectiveLogic", entry.value("selectiveLogic")},
            {"caseSensitive", entry.value("caseSensitive")}};
    }
    QVariantMap selectedRuleGroup() const {
        const auto entries = fixtureBook(archive()).value("entries").toList();
        for (const auto &value : entries) if (value.toMap().value("id") == selectedEntryId()) return ruleGroup(value.toMap());
        return {};
    }
    bool toggleRegex() {
        return control("worldbookUseRegex", [this](QQuickItem *target) {
            require(selectedEntryId() == entryA && !e->useRegex() && !target->property("checked").toBool(), "REGEX_TOGGLE_BASELINE");
            QSignalSpy toggled(target, SIGNAL(toggled())); require(toggled.isValid(), "REGEX_TOGGLE_SIGNAL_MISSING");
            mouseInput(target);
            require(toggled.count() == 1 && target->property("checked").toBool() && e->useRegex() &&
                    e->keywords() == patternA && e->secondaryKeywords().isEmpty() && e->dirty(), "REGEX_TOGGLE_RESULT");
            inputEvidence = {{"kind", "checkbox"}, {"mouseDispatchCount", 1}, {"toggledSignals", toggled.count()}, {"checked", true}};
        });
    }
    QVariantMap patternGeometry(QQuickItem *target) const {
        return WorldbookRegexProbe::patternGeometry(target, item("worldbook-regex-keywords-scroll"), w,
            [this](bool ok, const QString &code) { require(ok, code); });
    }
    bool tabToPattern() {
        return control("worldbookComment", [this](QQuickItem *target) {
            require(selectedEntryId()==entryB && e->useRegex(),"REGEX_PATTERN_WRONG_ENTRY");
            auto *pattern=item("worldbookRegexKeywords");require(pattern && pattern->isVisible() && pattern->isEnabled(),"REGEX_PATTERN_NOT_READY");
            const auto before=pattern->property("text").toString();
            mouseInput(target);keyInput(target);QTest::keyClick(w,Qt::Key_Tab);
            const auto geometry=patternGeometry(pattern);
            require(pattern->property("text").toString()==before && geometry.value("focusInTarget").toBool() &&
                    geometry.value("fullyVisible").toBool(),"REGEX_PATTERN_TAB_NOT_IMMEDIATE");
            inputEvidence={{"kind","pattern-tab-focus"},{"mouseDispatchCount",1},{"keyDispatchCount",1},
                {"patternControl","worldbookRegexKeywords"},{"beforeText",before},{"afterText",pattern->property("text")},
                {"geometry",geometry},{"focusInTarget",geometry.value("focusInTarget")},{"textFormat",WorldbookRegexProbe::textFormat(pattern)}};
        });
    }
    bool patternAction(const QString &action) {
        const QString name="worldbookRegexKeywords";
        const QString before=action=="delete-close" ? patternNewB : patternOldB;
        const QString after=action=="replace-quantifier" ? patternNewB : action=="delete-close" ? patternInvalidB : patternOldB;
        if (!patternPerformed) {
            if (!control(name,[this,action,before,after](QQuickItem *target) {
                require(selectedEntryId()==entryB && e->useRegex() && target->property("text")==before &&
                        WorldbookRegexProbe::plainTextFormat(target),"REGEX_PATTERN_BASELINE");
                keyInput(target);
                QSignalSpy changed(target,SIGNAL(textChanged())); require(changed.isValid(),"REGEX_PATTERN_TEXT_SIGNAL_MISSING");
                int keys=0; QVariant afterTabText, afterBacktabText, tabLeft, backtabReturned;
                if (action=="select-quantifier") {
                    for (int i=0;i<before.size();++i) {keyInput(target);QTest::keyClick(w,Qt::Key_Left);++keys;}
                    for (int i=0;i<9;++i) {keyInput(target);QTest::keyClick(w,Qt::Key_Right);++keys;}
                    keyInput(target);QTest::keyClick(w,Qt::Key_Right,Qt::ShiftModifier);++keys;
                    require(target->property("selectedText")=="4" && target->property("selectionStart").toInt()==9 &&
                        target->property("selectionEnd").toInt()==10 && changed.count()==0,"REGEX_PATTERN_SELECTION");
                } else {
                    if (action=="replace-quantifier") {
                        require(target->property("selectedText")=="4", "REGEX_PATTERN_SELECTION_LOST");
                        for (const auto key : {Qt::Key_1,Qt::Key_Comma,Qt::Key_3}) {keyInput(target);QTest::keyClick(w,key);++keys;}
                    } else {
                        for (int i=0;i<before.size();++i) {keyInput(target);QTest::keyClick(w,Qt::Key_Right);++keys;}
                        keyInput(target);QTest::keyClick(w,Qt::Key_Backspace);++keys;
                    }
                    require(target->property("text")==after && e->keywords()==after && e->dirty(),"REGEX_PATTERN_EDIT_RESULT");
                    keyInput(target);QTest::keyClick(w,Qt::Key_Tab);++keys;
                    afterTabText=target->property("text");tabLeft=!ArchiveInputProbe::keyboardFocusMatches(target,w);
                    require(tabLeft.toBool() && afterTabText==after,"REGEX_PATTERN_TAB_INSERTED");
                    inputTime();QTest::keyClick(w,Qt::Key_Backtab);++keys;
                    afterBacktabText=target->property("text");backtabReturned=ArchiveInputProbe::keyboardFocusMatches(target,w);
                    require(backtabReturned.toBool() && afterBacktabText==after &&
                            patternGeometry(target).value("fullyVisible").toBool(),"REGEX_PATTERN_BACKTAB_NOT_IMMEDIATE");
                    require(changed.count()==(action=="replace-quantifier"?3:1),"REGEX_PATTERN_CHANGE_SIGNAL_COUNT");
                }
                const auto geometry=patternGeometry(target);
                if (action=="select-quantifier") require(geometry.value("selectionFullyVisible").toBool(),"REGEX_PATTERN_SELECTION_CLIPPED");
                patternPending={{"kind","pattern-keyboard"},{"action",action},{"mouseDispatchCount",0},
                    {"keyDispatchCount",keys},{"textChangedSignals",changed.count()},{"beforeText",before},{"afterText",after},
                    {"immediateGeometry",geometry},{"performedFrame",QVariant::fromValue(frame)},
                    {"focusInTarget",geometry.value("focusInTarget")},{"textFormat",WorldbookRegexProbe::textFormat(target)},
                    {"selectionStart",target->property("selectionStart")},{"selectionEnd",target->property("selectionEnd")},
                    {"selectedText",target->property("selectedText")},{"afterTabText",afterTabText},{"afterBacktabText",afterBacktabText},
                    {"tabLeft",tabLeft},{"backtabReturned",backtabReturned}};
            },false)) return false;
            patternPerformed=true;patternPerformedFrame=frame;stable.reset();w->update();return false;
        }
        inputTime();auto *target=item(name);require(target && target->property("text")==after,"REGEX_PATTERN_CHANGED_BEFORE_FRAME");
        const auto observation=inspectControl(target);
        if (!stable.observe(observation,phaseClock.elapsed(clock.elapsed()),frame).value("ready").toBool() || frame<=patternPerformedFrame) {w->update();return false;}
        const auto geometry=patternGeometry(target);
        if (action=="select-quantifier") require(target->property("selectedText")=="4" && geometry.value("selectionFullyVisible").toBool(),"REGEX_PATTERN_SELECTION_NOT_PRESENTED");
        const QString image=prefix+".worldbook-regex-"+action+".png";
        require(w->grabWindow().save(image),"REGEX_CAPTURE_FAILED");inputTime();
        inputs.append(QVariantMap{{"step",step},{"control",name},{"scope",inputScope},{"generation",inputGeneration},
            {"frame",QVariant::fromValue(frame)},{"layout",stable.metadata()},{"selectedEntryId",entryB},
            {"signals",patternPending},{"patternGeometry",geometry},{"beforeValue",before},{"afterValue",after},
            {"windowWidth",w->width()},{"windowHeight",w->height()},{"inputAtMs",phaseClock.inputAt()},
            {"stepAtMs",at},{"elapsedMs",phaseClock.elapsed(clock.elapsed())},{"screenshot",image}});
        return true;
    }
    void newRead() {
        readId = s->request("archive:get");
        require(!readId.isEmpty() && !responses.contains(readId), "REGEX_READ_NOT_NEW");
    }
    bool readReady() {
        require(clock.elapsed() - at < 10000, "REGEX_READ_DEADLINE");
        if (!responses.contains(readId)) return false;
        const auto receipt = responses.value(readId);
        require(receipt.value("ok").metaType().id() == QMetaType::Bool && receipt.value("ok").toBool() &&
                receipt.value("scope") == s->scopeKey() && receipt.value("generation").toInt() == s->generation() &&
                receipt.value("personaId") == active() && receipt.value("command") == "archive:get" &&
                receipt.value("revision").toInt() == currentRevision() && receipt.value("archiveHash") == hash(archive()),
                "REGEX_READ_IDENTITY");
        return !pending("archive:get");
    }
    void requireFixture(const Rules &expected) {
        const auto book=fixtureBook(archive());const auto entries=book.value("entries").toList();
        require(book.value("scanDepth").toInt()==1 && book.value("tokenBudget").toInt()==100 &&
            book.value("recursiveScanning")==QVariant(false) && book.value("name")=="正则验收资料" && entries.size()==2,"REGEX_FIXTURE_BOOK");
        for (int i=0;i<2;++i) {
            const auto entry=entries[i].toMap();
            require(entry.value("id")== (i?entryB:entryA) && entry.value("content")== (i?contentB:contentA) &&
                entry.value("keywords")==QVariantList{i?expected.patternB:patternA} &&
                entry.value("insertionOrder").toInt()==(i?40:30) && entry.value("priority").toInt()==1000 &&
                entry.value("enabled")==QVariant(true) && entry.value("alwaysActive")==QVariant(false) &&
                entry.value("useRegex")==QVariant(i?true:expected.regexA) && entry.value("secondaryKeywords")==QVariantList{} &&
                entry.value("selectiveLogic")=="and_any" && entry.value("caseSensitive")==QVariant(false) &&
                entry.contains("scanDepth") && entry.value("scanDepth").metaType().id()==QMetaType::Nullptr &&
                entry.contains("tokenBudget") && entry.value("tokenBudget").metaType().id()==QMetaType::Nullptr,
                "REGEX_FIXTURE_ENTRY",{{"entry",entry.value("id")}});
        }
        require(withoutFixture(archive())==restBaseline,"REGEX_OTHER_FIELDS_CHANGED");
    }
    void requireDiagnostics(const QString &entry, const QString &status, const QString &request) {
        const auto value=e->regexDiagnostics();
        require(selectedEntryId()==entry && value.value("available").toBool() && value.value("status")==status &&
            value.value("revision").toInt()==currentRevision() && value.value("requestId")==request,"REGEX_DIAGNOSTIC_STATE");
        const auto codes=value.value("codes").toStringList();
        require(status=="entry-error" ? codes==QStringList{"invalid_regex"} : codes.isEmpty(),"REGEX_DIAGNOSTIC_CODES");
        const auto raw=s->state().value("archive").toMap().value("world_book_diagnostics").toMap();
        const auto runtimePersona=s->state().value("archive").toMap().value("persona_id").toString();
        require(!runtimePersona.isEmpty() && raw.value("persona_id")==runtimePersona && raw.value("revision").toInt()==currentRevision() &&
            raw.value("request_id")==request && raw.value("truncated").toInt()==0,"REGEX_DIAGNOSTIC_RAW_BOUNDARY");
        const auto diagnostics=raw.value("entries").toList();
        if (restart) require(diagnostics.isEmpty(),"REGEX_DIAGNOSTIC_RESTART_NOT_EMPTY");
        else {
            require(diagnostics.size()==1,"REGEX_DIAGNOSTIC_ENTRY_COUNT");const auto row=diagnostics.first().toMap();
            require(row.value("persona_id")==runtimePersona && row.value("revision").toInt()==currentRevision() &&
                row.value("request_id")==request && row.value("book_id")==bookId && row.value("entry_id")==entryB &&
                row.value("book_index").toInt()==bookIndex()-1 && row.value("entry_index").toInt()==1 && row.value("code")=="invalid_regex",
                "REGEX_DIAGNOSTIC_TARGET");
        }
    }
    bool chatReply() {
        require(clock.elapsed() - at < 10000, "REGEX_CHAT_DEADLINE");
        if (s->busy() || pending("chat:history") || pending("chat:send")) return false;
        const auto all = s->messages(); if (all.size() < chatBefore.size() + 2) return false;
        require(all.size() == chatBefore.size() + 2 && ids().mid(0, chatBefore.size()) == chatBefore, "REGEX_CHAT_ID_PREFIX");
        const auto user = all[all.size()-2].toMap(), assistant = all.last().toMap();
        const QString request = user.value("request_id").toString();
        require(user.value("role") == "user" && user.value("content") == chatTexts[stage-1] && assistant.value("role") == "assistant" &&
                assistant.value("content") == reply && !request.isEmpty() && assistant.value("request_id") == request,
                "REGEX_CHAT_PAIR");
        chats.append(QVariantMap{{"stage", stage}, {"requestId", request}, {"scope", s->scopeKey()}, {"generation", s->generation()},
            {"personaId", active()}, {"beforeIds", chatBefore}, {"afterIds", ids()}, {"userId", user.value("id")}, {"assistantId", assistant.value("id")},
            {"text", user.value("content")}, {"reply", assistant.value("content")}, {"revision", currentRevision()}, {"archiveHash", hash(archive())}});
        return true;
    }
    // Restart samples share one step's input clock; each control has its own
    // whole-item observation and none claims simultaneous visibility.
    bool sample(const QStringList &names, const QString &entry) {
        if (phaseClock.inputAt()<0) {
            require(clock.elapsed()-at<10000,"REGEX_READBACK_DEADLINE");if(!settled())return false;
            require(phaseClock.beginInput(clock.elapsed()),"REGEX_INPUT_CLOCK");
        }
        int taken=0;for(const auto &v:samples)taken+=v.toMap().value("step").toInt()==step;
        require(taken<names.size(),"REGEX_READBACK_SAMPLE_OVERFLOW");const QString name=names[taken];
        if(!control(name,[this,name,entry](QQuickItem *target){
            require(target->isVisible() && target->isEnabled() && selectedEntryId()==entry && !e->dirty(),"REGEX_READBACK_CONTROLS");
            const QString pattern=entry==entryA?patternA:patternInvalidB;
            QVariant value;
            if(name=="worldbookUseRegex" || name=="worldbookCaseSensitive") {
                value=target->property("checked");require(value.metaType().id()==QMetaType::Bool && value.toBool()==(name=="worldbookUseRegex"),"REGEX_READBACK_BOOLEAN");
            } else if(name=="worldbookRegexKeywords" || name=="worldbookRegexSecondaryKeywords") {
                value=target->property("text");require(value==(name=="worldbookRegexKeywords"?pattern:QString()) && WorldbookRegexProbe::plainTextFormat(target),"REGEX_READBACK_TEXT");
            } else if(name=="worldbookSelectiveLogic") {
                value=target->property("currentIndex");require(value.toInt()==0 && e->selectiveLogic()=="and_any","REGEX_READBACK_LOGIC");
            } else {
                const QString wanted=restart?"unrun":entry==entryB?"entry-error":"clear";
                const QString request=restart?QString():chats.last().toMap().value("requestId").toString();
                requireDiagnostics(entry,wanted,request);value=target->property("diagnosticStatus");
                require(value==wanted && target->property("diagnosticRequestId")==request && target->property("diagnosticRevision").toInt()==currentRevision(),"REGEX_DIAGNOSTIC_UI");
                auto displayed=e->regexDiagnostics();
                require(!displayed.value("text").toString().isEmpty() && target->property("text").toString().contains(displayed.value("text").toString()),"REGEX_DIAGNOSTIC_TEXT");
                displayed["geometry"]=NativeControlReadiness::wholeVisibility(target,w);
                displayed["layout"]=stable.metadata(); displayed["displayText"]=target->property("text");
                observed[entry==entryB?"diagnosticsB":"diagnosticsA"]=displayed;
            }
            require(e->useRegex() && e->keywords()==pattern && e->secondaryKeywords().isEmpty() && !e->caseSensitive(),"REGEX_READBACK_MODEL");
            requireFixture(states[3]);
            inputTime();samples.append(QVariantMap{{"control",name},{"step",step},{"entryId",entry},{"value",value},
                {"ruleGroup",selectedRuleGroup()},{"diagnostic",name=="worldbookRegexDiagnostics"?e->regexDiagnostics():QVariantMap{}},
                {"scope",scope},{"generation",generation},{"personaId",active()},{"revision",currentRevision()},
                {"archiveHash",hash(archive())},{"stepAtMs",at},{"inputAtMs",phaseClock.inputAt()},
                {"sampledAtMs",clock.elapsed()},{"frame",QVariant::fromValue(frame)},{"layout",stable.metadata()},
                {"geometry",NativeControlReadiness::wholeVisibility(target,w)},{"windowWidth",w->width()},{"windowHeight",w->height()}});
        },false))return false;
        if(taken+1<names.size()){stable.reset();inputGate.resetForNextStep();w->update();return false;}
        return true;
    }
    void tick() {
        require(clock.elapsed() < deadline(), "REGEX_SEGMENT_DEADLINE");
        require(s->connected() && s->runtimeWritable() && s->recoveryState() == "clean", "REGEX_RUNTIME_UNAVAILABLE");
        if (!scope.isEmpty())
            require(s->scopeKey() == scope && s->generation() == generation && active() == "default", "REGEX_SCOPE_CHANGED");
        if (step == 0) {
            if (!settled()) return;
            const QString expectedDraft = restart ? syntheticDraft : QString();
            observed["startState"] = QVariantMap{{"dirty", e->dirty()}, {"draftLength", s->draft().size()},
                {"expectedDraftLength", expectedDraft.size()}, {"draftMatches", s->draft() == expectedDraft}, {"activeId", active()}};
            require(!e->dirty(), "REGEX_START_EDITOR_DIRTY");
            require(s->draft() == expectedDraft, "REGEX_START_DRAFT",
                    {{"draftLength", s->draft().size()}, {"expectedDraftLength", expectedDraft.size()}});
            require(active() == "default", "REGEX_START_PERSONA", {{"activeId", active()}});
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
            observed["runtimePersonaId"] = s->state().value("archive").toMap().value("persona_id");
            if (restart) {
                requireFixture(states[3]);
                observed["restartReadId"] = readId;
                record("regex-restart-archive-and-messages-read-back");
                next(16); return;
            }
            require(fixtureBook(archive()).isEmpty(), "REGEX_BASELINE_UNEXPECTED");
            observed["otherBookCount"] = restBaseline.value("worldBooks").toList().size();
            record("regex-default-baseline-read");
            auto proposed = archive(); auto books = proposed.value("worldBooks").toList(); QVariantList entries;
            for (int i = 0; i < 2; ++i) entries.append(QVariantMap{{"id", i ? entryB : entryA}, {"comment", i ? "正则 B" : "正则 A"},
                {"content", i ? contentB : contentA}, {"keywords", QVariantList{i ? patternOldB : patternA}},
                {"secondaryKeywords", QVariantList{}}, {"selectiveLogic", "and_any"}, {"caseSensitive", false}, {"useRegex", i == 1},
                {"enabled", true}, {"alwaysActive", false}, {"position", "before_char"}, {"insertionOrder", i ? 40 : 30},
                {"priority", 1000}, {"depth", 0}, {"role", "system"},
                {"scanDepth", QVariant::fromValue(nullptr)}, {"tokenBudget", QVariant::fromValue(nullptr)}});
            books.append(QVariantMap{{"id", bookId}, {"name", "正则验收资料"}, {"scanDepth", 1}, {"tokenBudget", 100},
                {"recursiveScanning", false}, {"entries", entries}});
            proposed["worldBooks"] = books;
            writeId = s->request("archive:put", {{"archive", proposed}, {"expected_revision", revision}});
            require(!writeId.isEmpty(), "REGEX_PREPARATION_NOT_SENT");
            observed["prepareWriteId"] = writeId; observed["preparedExpectedRevision"] = revision;
            next(5); return;
        }
        if (step == 5) {
            require(clock.elapsed() - at < 10000, "REGEX_PREPARATION_DEADLINE");
            if (!responses.contains(writeId)) return;
            const auto r = responses.value(writeId);
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == "default" && r.value("command") == "archive:put" && r.value("revision").toInt() == revision+1,
                    "REGEX_PREPARATION_RECEIPT");
            requireFixture(states[0]); revision = currentRevision(); observed["preparedRevision"] = revision;
            newRead(); next(6); return;
        }
        if (step == 6) {
            if (!readReady()) return; requireFixture(states[0]); observed["prepareReadId"] = readId;
            record("regex-fixture-prepared");
            stage = 1; next(29); return;
        }
        if (step == 29) { if (click("nav-chat")) next(30); return; }
        if (step == 16) { if (click("nav-memory")) next(7); return; }
        if (step == 7) { if (click("reloadWorldbook")) next(8); return; }
        if (step == 8) {
            if (phaseClock.inputAt() < 0) {
                require(clock.elapsed() - at < 10000, "REGEX_RELOAD_READ_DEADLINE");
                if (!settled()) return;
                require(phaseClock.beginInput(clock.elapsed()), "REGEX_INPUT_CLOCK");
            }
            const int index = bookIndex();
            require(index > 0, "REGEX_SELECTOR_ID_MISSING");
            if (!select("worldbookBookSelector", index)) return;
            // Selecting a book also selects its first entry, A.
            require(e->hasEntry() && selectedEntryId() == entryA, "REGEX_FIRST_ENTRY_NOT_SELECTED");
            next(restart ? 20 : 10); return;
        }
        if (step == 10) { if (toggleRegex()) next(11); return; }
        if (step == 17) { if (tabToPattern()) next(18); return; }
        if (step == 9) {
            const int index = entryIndex(entryB); require(index > 0, "REGEX_SELECTOR_ID_MISSING");
            if (!select("worldbookEntrySelector", index)) return;
            require(selectedEntryId() == entryB, "REGEX_ENTRY_NOT_SELECTED");
            next(17); return;
        }
        if (step == 18) { if (patternAction("select-quantifier")) next(19); return; }
        if (step == 19) { if (patternAction("replace-quantifier")) next(11); return; }
        if (step == 33) { if (click("nav-memory")) next(34); return; }
        if (step == 34) { if (tabToPattern()) next(35); return; }
        if (step == 35) { if (patternAction("delete-close")) next(11); return; }
        if (step == 11) {
            if (!saveBinding.metadata().value("armed").toBool()) {
                revision = currentRevision();
                require(saveBinding.arm(scope, generation, pendingCommands(), receipts), "REGEX_SAVE_BINDING_BASELINE");
            }
            if (click("saveWorldbook")) {
                const auto matched = saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts);
                require(matched == ArchiveInputProbe::SaveBinding::Matched, "REGEX_SAVE_NOT_DISPATCHED", saveBinding.metadata());
                writeId = saveBinding.requestId(); next(12);
            } return;
        }
        if (step == 12) {
            require(clock.elapsed()-at < 10000, "REGEX_SAVE_DEADLINE");
            if (!responses.contains(writeId) || e->busy()) return;
            const auto r = responses.value(writeId);
            require(saveBinding.observe(s->scopeKey(), s->generation(), pendingCommands(), receipts) == ArchiveInputProbe::SaveBinding::Matched,
                    "REGEX_SAVE_BINDING_CHANGED", saveBinding.metadata());
            require(r.value("ok").toBool() && r.value("scope") == scope && r.value("generation").toInt() == generation &&
                    r.value("personaId") == "default" && r.value("revision").toInt() == revision+1 && e->status() == "saved" && !e->dirty(),
                    "REGEX_SAVE_RECEIPT");
            requireFixture(states[saves.size() + 1]); newRead(); next(13); return;
        }
        if (step == 13) {
            if (phaseClock.inputAt() < 0) {
                if (!readReady()) return;
                require(phaseClock.beginInput(clock.elapsed()), "REGEX_INPUT_CLOCK");
            }
            const int number = saves.size() + 1;
            requireFixture(states[number]);
            if (!control("archive-status", [this, number](QQuickItem *label) {
                require(label->property("text").toString().contains("已保存"), "REGEX_SAVE_FEEDBACK");
                const QString image = prefix + ".worldbook-regex-save-" + QString::number(number) + ".png";
                require(w->grabWindow().save(image), "REGEX_CAPTURE_FAILED");
                inputTime();
                require(item("archive-status") == label && stable.matches(inspectControl(label)), "REGEX_CAPTURE_LAYOUT_CHANGED");
                saves.append(QVariantMap{{"stage", number}, {"writeId", writeId}, {"readId", readId}, {"scope", scope},
                    {"generation", generation}, {"personaId", active()}, {"expectedRevision", revision}, {"revision", currentRevision()},
                    {"entryId", selectedEntryId()},
                    {"ruleGroup", selectedRuleGroup()},
                    {"archiveHash", hash(archive())}, {"restHash", hash(withoutFixture(archive()))},
                    {"book", fixtureBook(archive())}, {"feedback", label->property("text")},
                    {"binding", saveBinding.metadata()}, {"readAtMs", at}, {"feedbackInputAtMs", phaseClock.inputAt()},
                    {"feedbackGeometry", NativeControlReadiness::wholeVisibility(label, w)}, {"windowWidth", w->width()},
                    {"windowHeight", w->height()}, {"screenshot", image}});
            }, false)) return;
            if (number == 1) { record("regex-a-enabled-saved-and-read-back"); next(9); return; }
            record(number == 2 ? "regex-b-comma-pattern-saved-and-read-back"
                               : "regex-b-invalid-pattern-saved-and-read-back");
            stage = number == 2 ? 2 : 3; next(14); return;
        }
        if (step == 20) {
            if (!sample({"worldbookUseRegex", "worldbookRegexKeywords", "worldbookRegexSecondaryKeywords", "worldbookSelectiveLogic", "worldbookCaseSensitive"}, entryA)) return;
            record("regex-restart-entry-a-rules");
            next(21); return;
        }
        if (step == 21) {
            const int index = entryIndex(entryB); require(index > 0, "REGEX_SELECTOR_ID_MISSING");
            if (!select("worldbookEntrySelector", index)) return;
            require(selectedEntryId() == entryB, "REGEX_ENTRY_NOT_SELECTED");
            next(22); return;
        }
        if (step == 22) {
            if (!sample({"worldbookUseRegex", "worldbookRegexKeywords", "worldbookRegexSecondaryKeywords", "worldbookSelectiveLogic", "worldbookCaseSensitive", "worldbookRegexDiagnostics"}, entryB)) return;
            const QString image = prefix + ".worldbook-regex-restart.png";
            require(w->grabWindow().save(image), "REGEX_CAPTURE_FAILED");
            observed["restartScreenshot"] = image; observed["restartScreenshotControl"] = "worldbookRegexDiagnostics";
            record("regex-restart-entry-b-rules-and-no-diagnostic");
            next(14); return;
        }
        if (step == 14) { if (click("memory-close")) next(restart ? 40 : 30); return; }
        if (step == 30) {
            if (control("chatComposer", [this](QQuickItem *composer) {
                QPointer<QQuickItem> qualified = composer;
                require(s->draft().isEmpty(), "REGEX_CHAT_STALE_DRAFT"); chatBefore = ids();
                mouseInput(composer);
                inputTime(); require(qualified, "REGEX_KEY_TARGET_CHANGED"); qualified->forceActiveFocus();
                QInputMethodEvent event; event.setCommitString(chatTexts[stage-1]);
                keyInput(qualified); QCoreApplication::sendEvent(w, &event);
                require(qualified && s->draft() == chatTexts[stage-1] && qualified->property("text") == chatTexts[stage-1], "REGEX_CHAT_INPUT");
                inputEvidence = {{"kind", "text"}, {"mouseDispatchCount", 1}, {"commitCount", 1}, {"focusInTarget", composer->hasActiveFocus() || (w->activeFocusItem() && composer->isAncestorOf(w->activeFocusItem()))}};
            })) next(31); return;
        }
        if (step == 31) { if (click("sendChat")) next(32); return; }
        if (step == 32) {
            if (!chatReply()) return; requireFixture(states[saves.size()]);
            if (stage == 1) { record("regex-first-chat-no-test-markers"); next(16); return; }
            if (stage == 2) { record("regex-second-chat-both-markers"); next(33); return; }
            record("regex-third-chat-invalid-b-isolated");
            next(36); return;
        }
        if (step == 36) { if (click("nav-memory")) next(37); return; }
        if (step == 37) {
            if (!settled()) { require(clock.elapsed()-at<10000,"REGEX_DIAGNOSTIC_RELOAD_WAIT"); return; }
            if (reloadBeforeIds.isEmpty()) for (auto it=responses.cbegin();it!=responses.cend();++it) reloadBeforeIds.insert(it.key());
            if (!click("reloadWorldbook")) return;
            QSet<QString> fresh;
            for (const auto &v:pendingCommands()) {const auto row=v.toMap();if(row.value("command")=="archive:get" && !reloadBeforeIds.contains(row.value("id").toString()))fresh.insert(row.value("id").toString());}
            for (auto it=responses.cbegin();it!=responses.cend();++it) if(it.value().value("command")=="archive:get" && !reloadBeforeIds.contains(it.key()))fresh.insert(it.key());
            require(fresh.size()==1 && !fresh.contains(QString()),"REGEX_DIAGNOSTIC_READ_NOT_UNIQUE");
            readId=*fresh.cbegin();observed["diagnosticReadId"]=readId;next(38);return;
        }
        if (step == 38) {
            if (!readReady() || !settled()) return;
            require(selectedEntryId()==entryB,"REGEX_DIAGNOSTIC_ENTRY_CHANGED");
            if (!sample({"worldbookRegexDiagnostics"},entryB)) return;
            next(39);return;
        }
        if (step == 39) {
            const int index=entryIndex(entryA);require(index>0,"REGEX_SELECTOR_ID_MISSING");
            if (select("worldbookEntrySelector",index)) next(42);return;
        }
        if (step == 42) {
            if (!sample({"worldbookRegexDiagnostics"},entryA)) return;
            record("regex-diagnostics-bound-to-third-chat");
            require(saves.size() == 3 && chats.size() == 3, "REGEX_TERMINAL_EVIDENCE_COUNT");
            const auto lastSave = saves.last().toMap(), fresh = responses.value(observed.value("diagnosticReadId").toString()), chat = chats.last().toMap();
            require(currentRevision() == lastSave.value("revision").toInt() && currentRevision() == fresh.value("revision").toInt() &&
                    currentRevision() == chat.value("revision").toInt() && hash(archive()) == lastSave.value("archiveHash") &&
                    hash(archive()) == fresh.value("archiveHash") && hash(archive()) == chat.value("archiveHash"),
                    "REGEX_TERMINAL_FINAL_SAVE");
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(puts == 4 && ids().size() == baselineIds.size() + 6 && ids().mid(0, baselineIds.size()) == baselineIds,
                    "REGEX_WRITE_CHAT_COUNTS");
            observed["terminalRevision"] = currentRevision(); observed["terminalArchiveHash"] = hash(archive());
            observed["terminalMessageIds"] = ids(); observed["book"] = fixtureBook(archive()); observed["putCount"] = puts;
            record("regex-terminal-three-saves-six-messages-rest-unchanged");
            finish(true); return;
        }
        if (step == 40) { newRead(); next(41); return; }
        if (step == 41) {
            if (!readReady() || !settled()) return;
            requireFixture(states[3]);
            const auto baseline = responses.value(observed.value("restartReadId").toString());
            const int puts = std::count_if(receipts.cbegin(), receipts.cend(), [](const QVariant &v) { return v.toMap().value("command") == "archive:put"; });
            require(baseline.value("archiveHash") == hash(archive()) && baseline.value("revision").toInt() == currentRevision() &&
                    ids() == baselineIds && puts == 0 && saves.isEmpty() && chats.isEmpty(), "REGEX_RESTART_CHANGED");
            observed["terminalDraftMatches"] = s->draft() == syntheticDraft;
            require(s->draft() == syntheticDraft, "REGEX_RESTART_DRAFT_CHANGED", {{"draftLength", s->draft().size()}});
            observed["finalReadId"] = readId; observed["putCount"] = puts; observed["terminalMessageIds"] = ids();
            observed["terminalRevision"] = currentRevision(); observed["terminalArchiveHash"] = hash(archive());
            observed["book"] = fixtureBook(archive());
            record("regex-restart-zero-writes-and-zero-chats");
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
void WorldbookRegexCheck::run(QQuickWindow *w, RuntimeBridge *s, ArchiveEditor *e, bool restart,
    const QString &capture, std::function<void(QVariantMap)> done) { new Check(w,s,e,restart,capture,std::move(done)); }
