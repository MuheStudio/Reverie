#include "WorldbookInjectionCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "ArchiveInputProbe.h"
#include "WorldbookInjectionInput.h"
#include "WorldbookInjectionNavigation.h"
#include "WorldbookInjectionHit.h"
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

// Independent injection tail. Ordinary checks finish before this object starts.
namespace {
const QString bookId = "p1_injection_book";
const QStringList entryIds{"p1_injection_p", "p1_injection_q", "p1_injection_r", "p1_injection_s"};
const QStringList markers{"INJECTION_P_ONLY", "INJECTION_Q_ONLY", "INJECTION_R_ONLY", "INJECTION_S_ONLY"};
const QStringList chatTexts{"插入记录一：清风徐来", "插入记录二：云影经过", "插入记录三：远灯亮起"};
const QString reply = "插入设置效果已核对";
const QString syntheticDraft = "原生场景中的合成草稿";
const int orders[] = {40, 10, 30, 20};
struct Placement { QString position; int depth; QString role; };
const Placement states[5][4] = {
    {{"before_char",0,"system"},{"before_char",0,"system"},{"before_char",0,"system"},{"before_char",0,"system"}},
    {{"before_char",0,"system"},{"after_char",0,"system"},{"before_char",0,"system"},{"before_char",0,"system"}},
    {{"before_char",0,"system"},{"after_char",0,"system"},{"at_depth",1,"system"},{"before_char",0,"system"}},
    {{"before_char",0,"system"},{"after_char",0,"system"},{"at_depth",0,"user"},{"before_char",0,"system"}},
    {{"before_char",0,"system"},{"after_char",0,"system"},{"at_depth",0,"user"},{"at_depth",2,"assistant"}}
};
QString hash(const QVariantMap &value) {
    return QString::fromLatin1(QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact), QCryptographicHash::Sha256).toHex());
}
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
    QVariantMap observed, restBaseline, inputEvidence, inputHitEvidence;
    QStringList baselineIds, chatBefore;
    QString historyReadId;
    QMap<QString,QVariantMap> historyReceipts;
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
                if (finished) return;
                if (command == "chat:history") {
                    if (id.isEmpty() || id != historyReadId) return;
                    try { captureHistory(id,result,g); }
                    catch (const std::exception &error) { finish(false,error.what()); }
                    return;
                }
                if (!QStringList{"archive:get", "archive:put"}.contains(command)) return;
                if (receipts.size() >= 40) { finish(false, "INJECTION_RECEIPT_BOUND"); return; }
                const auto archive = result.value("archive").toMap();
                QVariantMap record{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scope", s->scopeKey()}, {"personaId", active()}, {"ok", result.value("ok")},
                    {"revision", result.value("revision")}, {"exists", result.value("exists")}, {"archiveHash", hash(archive)},
                    {"book", fixtureBook(archive)}, {"restHash", hash(withoutFixture(archive))},
                    {"runtimePersonaId", result.value("persona_id")}};
                receipts.append(record);
                responses[id] = record;
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            if (!finished && (id == readId || id == writeId || id == historyReadId)) finish(false, "INJECTION_REQUEST_FAILED:" + code);
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
        phaseClock.enter(at, n == 202 || n == 208 || (n >= 400 && n <= 403));
        if (n == 205) saveBinding = {};
        inputScope = s->scopeKey(); inputGeneration = s->generation();
    }
    void record(const QString &name) {
        for (const auto &value : checks) require(value.toMap().value("name") != name, "INJECTION_CHECK_DUPLICATED");
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
    SummaryInteractionProbe::ControlObservation inspectControl(QQuickItem *target, bool allowDisabled = false) const {
        bool surfaceReady = true;
        for (auto *parent = target; parent; parent = parent->parentItem())
            if (parent->property("inputReady").isValid()) surfaceReady = surfaceReady && parent->property("inputReady").toBool();
        auto observation = SummaryInteractionProbe::inspect(target, w, surfaceReady, s->scopeKey());
        const bool whole = NativeControlReadiness::wholeVisibility(target, w).value("fullyVisible").toBool();
        observation.eligible = whole && (observation.eligible || (allowDisabled && target && !target->isEnabled() && observation.state.value("visible").toBool() && observation.state.value("bound").toBool() && observation.state.value("geometryValid").toBool() && observation.state.value("integerPointInsideClip").toBool() && surfaceReady));
        observation.state["fullyVisible"] = whole; observation.state["ready"] = observation.eligible;
        return observation;
    }
    void inputTime() const {
        require(clock.elapsed() < deadline() && phaseClock.elapsed(clock.elapsed()) >= 0 &&
                phaseClock.elapsed(clock.elapsed()) < 4000, "INJECTION_INPUT_DEADLINE");
        require(s->scopeKey() == inputScope && s->generation() == inputGeneration, "INJECTION_INPUT_SCOPE_CHANGED");
    }
    bool runtimeSettled() const {
        for (const auto *command : {"persona:get", "persona:list", "chat:history", "archive:get"}) if (pending(command)) return false;
        return !s->personaChanging();
    }
    bool settled() const {
        return runtimeSettled() && e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == currentRevision();
    }
    static const char *valueProperty(const QString &name) {
        return name == "chatComposer" ? "text" :
            name.endsWith("Selector") || name == "worldbookInsertionPosition" || name == "worldbookInsertionRole" ? "currentIndex" : "value";
    }
    bool control(const QString &name, const std::function<void(QQuickItem *)> &perform, bool clickable = true) {
        require(phaseClock.beginInput(clock.elapsed()), "INJECTION_INPUT_CLOCK");
        const auto elapsed = [this] { return clock.elapsed() >= deadline() ? qint64(4000) : phaseClock.elapsed(clock.elapsed()); };
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        observed["lastInputGeometry"] = QVariantMap{{"step", step}, {"control", name}, {"elapsedMs", elapsed()},
            {"windowWidth", w->width()}, {"windowHeight", w->height()}, {"frame", QVariant::fromValue(frame)},
            {"revealSummary", NativeControlReadiness::revealSummary(revealed)},
            {"wholeVisibility", NativeControlReadiness::wholeVisibility(target, w)}};
        require(elapsed() < 4000 && !revealed.value("expired").toBool(), "INJECTION_INPUT_DEADLINE");
        if (!target || !revealed.value("geometryValid").toBool()) { stable.reset(); w->update(); return false; }
        auto observation = inspectControl(target, !clickable);
        if (!stable.observe(observation, elapsed(), frame).value("ready").toBool()) { w->update(); return false; }
        const auto result = inputGate.poll(elapsed, 4000, {{name, [this, name] { return item(name); },
            [this, name, clickable](QQuickItem *candidate) {
                const auto fresh = inspectControl(candidate, !clickable); auto state = fresh.state;
                state["ready"] = candidate && item(name) == candidate && stable.matches(fresh) &&
                    s->scopeKey() == inputScope && s->generation() == inputGeneration;
                return state;
            }, [this, name, clickable, &perform, &elapsed](QQuickItem *candidate) {
                QPointer<QQuickItem> qualified = candidate;
                inputTime(); const auto fresh = inspectControl(qualified, !clickable);
                require(qualified && item(name) == qualified && stable.matches(fresh), "INJECTION_INPUT_TARGET_CHANGED");
                const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
                observed["lastHitProbe"] = WorldbookInjectionHit::probe(w,qualified,fresh.point,hit,[this] { return hitClock(); });
                if (clickable) require(hit.accepted(), "INJECTION_INPUT_HIT", hit.metadata());
                const auto beforeValue = qualified->property(valueProperty(name));
                const auto selectedEntryIdBefore = selectedEntryId();
                inputTime(); inputEvidence.clear(); inputHitEvidence.clear(); perform(qualified);
                require(clock.elapsed() < deadline() && elapsed() < 4000, "INJECTION_INPUT_DEADLINE");
                require(qualified, "INJECTION_CONTROL_DESTROYED_AFTER_INPUT");
                if (clickable) inputs.append(QVariantMap{{"step", step}, {"control", name}, {"scope", inputScope},
                    {"generation", inputGeneration}, {"frame", QVariant::fromValue(frame)}, {"layout", stable.metadata()},
                    {"beforeValue", beforeValue}, {"afterValue", qualified->property(valueProperty(name))},
                    {"selectedEntryId", selectedEntryId()}, {"selectedEntryIdBefore", selectedEntryIdBefore},
                    {"signals", inputEvidence}, {"hit", inputHitEvidence.value("probe").toMap().value("hit")},
                    {"inputHit", inputHitEvidence},
                    {"windowWidth", w->width()}, {"windowHeight", w->height()},
                    {"inputAtMs", phaseClock.inputAt()}, {"stepAtMs", at}, {"elapsedMs", elapsed()}});
            }}});
        require(result != NativeControlReadiness::SequentialGate::Expired, "INJECTION_INPUT_DEADLINE");
        require(result != NativeControlReadiness::SequentialGate::Failed, "INJECTION_INPUT_FAILED");
        if (result != NativeControlReadiness::SequentialGate::Performed) { w->update(); return false; }
        return true;
    }
    QVariantMap hitClock() const {
        const auto now = clock.elapsed();
        return {{"step",step},{"stepAtMs",at},{"inputAtMs",phaseClock.inputAt()},
            {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",QVariant::fromValue(frame)},
            {"scope",s->scopeKey()},{"generation",s->generation()},{"selectedEntryId",selectedEntryId()}};
    }
    void dispatchMouse(QQuickItem *target, const QString &kind, const QPoint &readinessPoint,
                       const QVariantMap &hitProbe, const QPoint &dispatchPoint) {
        inputHitEvidence = WorldbookInjectionHit::mouseClick(w,target,kind,readinessPoint,hitProbe,
            dispatchPoint,[this] { return hitClock(); });
        observed["lastInputHit"] = inputHitEvidence;
    }
    void mouseInput(QQuickItem *target, const QString &kind) {
        inputTime(); QPointer<QQuickItem> qualified = target;
        const auto fresh = inspectControl(qualified);
        require(qualified && item(qualified->objectName()) == qualified && stable.matches(fresh), "INJECTION_MOUSE_TARGET_CHANGED");
        const auto hit = NativeCheck::hitTest(w, fresh.point, qualified);
        const auto probe = WorldbookInjectionHit::probe(w,qualified,fresh.point,hit,[this] { return hitClock(); });
        observed["lastHitProbe"] = probe;
        require(hit.accepted(), "INJECTION_MOUSE_HIT_CHANGED");
        inputTime();
        dispatchMouse(qualified,kind,fresh.point,probe,fresh.point);
    }
    void keyInput(QQuickItem *target, bool selector = false) const {
        inputTime(); QPointer<QQuickItem> qualified = target;
        require(qualified && item(qualified->objectName()) == qualified && qualified->isEnabled(),
                "INJECTION_KEY_TARGET_CHANGED");
        require(ArchiveInputProbe::keyboardFocusMatches(qualified, w, selector), "INJECTION_KEY_FOCUS_MISMATCH",
                {{"selector", selector}, {"focusFound", w->activeFocusItem() != nullptr}});
        inputTime();
    }
    bool click(const QString &name) {
        return control(name, [this](QQuickItem *target) {
            QSignalSpy signal(target, SIGNAL(clicked())); require(signal.isValid(), "INJECTION_CLICK_SIGNAL_MISSING");
            mouseInput(target,"button");
            require(signal.count() == 1, "INJECTION_CLICK_SIGNAL_COUNT");
            inputEvidence = {{"kind", "button"}, {"mouseDispatchCount", 1}, {"clickedSignals", signal.count()}};
        });
    }
    // Selector activation is always dispatched through actual keyboard input.
    bool select(const QString &name, int index) {
        return control(name, [this, index](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            require(index >= 0 && index < target->property("count").toInt() && target->property("currentIndex").toInt() != index,
                    "INJECTION_SELECTOR_RANGE");
            QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "INJECTION_SELECTOR_SIGNAL_MISSING");
            mouseInput(qualified,"selector");
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Home);
            for (int row = 0; row < index; ++row) { keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Down); }
            keyInput(qualified, true); QTest::keyClick(w, Qt::Key_Return);
            require(qualified && activated.count() == 1 && qualified->property("currentIndex").toInt() == index, "INJECTION_SELECTOR_ACTIVATION");
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
    static QVariantMap placement(const QVariantMap &entry) {
        return {{"position",entry.value("position")},{"depth",entry.value("depth")},{"role",entry.value("role")}};
    }
    static QVariantMap expectedPlacement(int state, int entry) {
        const auto &p=states[state][entry]; return {{"position",p.position},{"depth",p.depth},{"role",p.role}};
    }
    QVariantMap selectedPlacement() const {
        for(const auto &v:fixtureBook(archive()).value("entries").toList())
            if(v.toMap().value("id")==selectedEntryId()) return placement(v.toMap());
        return {};
    }
    void requireFixture(int state) const {
        const auto book=fixtureBook(archive()); const auto entries=book.value("entries").toList();
        require(book.value("name")=="插入验收资料" && book.value("scanDepth").toInt()==1 &&
            book.value("tokenBudget").toInt()==1000 && book.value("recursiveScanning")==QVariant(false) && entries.size()==4,"INJECTION_FIXTURE_BOOK");
        for(int i=0;i<4;++i) {
            const auto v=entries[i].toMap();
            require(v.value("id")==entryIds[i] && v.value("content")==markers[i] && v.value("insertionOrder").toInt()==orders[i] &&
                v.value("priority").toInt()==1000 && v.value("enabled")==QVariant(true) && v.value("alwaysActive")==QVariant(true) &&
                v.value("keywords")==QVariantList{} && v.value("secondaryKeywords")==QVariantList{} && v.value("selectiveLogic")=="and_any" &&
                v.value("caseSensitive")==QVariant(false) && v.value("useRegex")==QVariant(false) &&
                v.contains("scanDepth") && v.value("scanDepth").metaType().id()==QMetaType::Nullptr &&
                v.contains("tokenBudget") && v.value("tokenBudget").metaType().id()==QMetaType::Nullptr &&
                placement(v)==expectedPlacement(state,i),"INJECTION_FIXTURE_ENTRY",{{"entryIndex",i}});
        }
        require(withoutFixture(archive())==restBaseline,"INJECTION_REST_CHANGED");
    }
    void captureHistory(const QString &id,const QVariantMap &result,int g) {
        require(id==historyReadId && !historyReceipts.contains(id) && g==generation && s->scopeKey()==scope && active()=="default",
            "INJECTION_HISTORY_RESPONSE_BINDING");
        require(!result.contains("error") && (!result.contains("ok") ||
            (result.value("ok").metaType().id()==QMetaType::Bool && result.value("ok").toBool())),"INJECTION_HISTORY_RESPONSE_FAILED");
        require(result.value("items").metaType().id()==QMetaType::QVariantList &&
            result.value("has_more").metaType().id()==QMetaType::Bool && !result.value("has_more").toBool() &&
            result.contains("next_cursor") && result.value("next_cursor").metaType().id()==QMetaType::Nullptr,
            "INJECTION_HISTORY_RESPONSE_SHAPE");
        const auto rows=result.value("items").toList();require(rows.size()<=300,"INJECTION_HISTORY_RESPONSE_BOUND");
        QStringList authoritativeIds;QSet<QString> unique;QVariantList counts{0,0,0,0};
        const auto served=scope.section(':',0,0);
        for(const auto &value:rows) {
            require(value.metaType().id()==QMetaType::QVariantMap,"INJECTION_HISTORY_ROW_SHAPE");const auto row=value.toMap();
            require(row.value("id").metaType().id()==QMetaType::QString && !row.value("id").toString().isEmpty() &&
                !unique.contains(row.value("id").toString()) && row.value("content").metaType().id()==QMetaType::QString &&
                row.value("role").metaType().id()==QMetaType::QString && QStringList{"user","assistant"}.contains(row.value("role").toString()) &&
                row.value("persona_id")==QVariant(served) && row.value("conversation_id")==QVariant("dream-room"),"INJECTION_HISTORY_ROW_BOUND");
            authoritativeIds.append(row.value("id").toString());unique.insert(row.value("id").toString());
            for(int i=0;i<markers.size();++i)counts[i]=counts[i].toInt()+row.value("content").toString().count(markers[i]);
        }
        require(counts==QVariantList{0,0,0,0},"INJECTION_HISTORY_RESPONSE_POLLUTION");
        historyReceipts[id]={{"schema","reverie.qt.worldbook-injection-history-read.v1"},{"requestId",id},{"command","chat:history"},
            {"scope",scope},{"generation",g},{"personaId",active()},{"runtimePersonaId",served},{"errorPresent",result.contains("error")},
            {"okPresent",result.contains("ok")},{"okValue",result.value("ok")},{"itemsArray",true},{"hasMore",result.value("has_more")},
            {"nextCursorNull",true},{"rowsInScope",true},{"messageIds",authoritativeIds},{"markerCounts",counts}};
    }
    void newRead() {
        readId=s->request("archive:get"); require(!readId.isEmpty() && !responses.contains(readId),"INJECTION_READ_NOT_NEW");
    }
    bool readReady() {
        require(clock.elapsed()-at<10000,"INJECTION_READ_DEADLINE");
        if(!responses.contains(readId)) return false;
        const auto r=responses.value(readId);
        require(r.value("ok").metaType().id()==QMetaType::Bool && r.value("ok").toBool() && r.value("command")=="archive:get" &&
            r.value("scope")==scope && r.value("generation").toInt()==generation && r.value("personaId")=="default" &&
            r.value("revision").toInt()==currentRevision() && r.value("archiveHash")==hash(archive()),"INJECTION_READ_IDENTITY");
        return !pending("archive:get");
    }
    bool chooseEntry(int index) {
        const auto id=entryIds[index]; const int row=entryIndex(id); require(row>0,"INJECTION_ENTRY_ROW");
        if(!select("worldbookEntrySelector",row)) return false;
        require(selectedEntryId()==id,"INJECTION_ENTRY_SELECTION"); return true;
    }
    bool choosePlacement(const QString &name,int index) {
        return select(name,index);
    }
    bool depth(int value) {
        return control("worldbookInsertionDepth",[this,value](QQuickItem *target) {
            QPointer<QQuickItem> qualified = target;
            QVariantMap mouseProbe;
            QPoint mouseReadinessPoint;
            WorldbookInjectionInput::Context context;
            context.editor = e;
            context.resolveTarget = [this] { return item("worldbookInsertionDepth"); };
            context.editorValue = [this] { return e->insertionDepth(); };
            context.baselineReady = [this] { return e->insertionPosition() == QVariant("at_depth"); };
            context.metadata = [this] {
                const auto now = clock.elapsed();
                return QVariantMap{{"step",step},{"stepAtMs",at},{"inputAtMs",phaseClock.inputAt()},
                    {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",QVariant::fromValue(frame)},
                    {"scope",s->scopeKey()},{"generation",s->generation()},{"selectedEntryId",selectedEntryId()}};
            };
            context.qualify = [this, qualified, &mouseProbe, &mouseReadinessPoint](const QString &, bool keyboard) {
                inputTime();
                const auto fresh = inspectControl(qualified);
                require(qualified && item("worldbookInsertionDepth") == qualified && stable.matches(fresh),
                    "INJECTION_DEPTH_TARGET_CHANGED");
                if (keyboard) keyInput(qualified);
                else {
                    const auto hit = NativeCheck::hitTest(w,fresh.point,qualified);
                    mouseReadinessPoint = fresh.point;
                    mouseProbe = WorldbookInjectionHit::probe(w,qualified,fresh.point,hit,[this] { return hitClock(); });
                    observed["lastHitProbe"] = mouseProbe;
                    require(hit.accepted(),"INJECTION_MOUSE_HIT_CHANGED");
                }
                inputTime();
                return fresh.point;
            };
            context.mouseDispatch = [this,qualified,&mouseProbe,&mouseReadinessPoint](const QPoint &point) {
                dispatchMouse(qualified,"depth-keyboard",mouseReadinessPoint,mouseProbe,point);
            };
            context.publish = [this](const QVariantMap &evidence) {
                observed["lastDepthInput"] = evidence;
                inputEvidence = {{"kind","depth-keyboard"},{"mouseDispatchCount",evidence.value("mouseDispatchCount")},
                    {"valueModifiedSignals",evidence.value("valueModifiedSignals")},
                    {"keyDispatchCount",evidence.value("keyDispatchCount")},
                    {"focusInTarget",evidence.value("snapshots").toList().last().toMap().value("focusInTarget")},
                    {"depthInput",evidence}};
            };
            WorldbookInjectionInput::replaceDepth(w,target,value,context);
        });
    }
    bool tabUnchanged() {
        return control("worldbookInsertionPosition",[this](QQuickItem *target) {
            QVariantMap mouseProbe;
            QPoint mouseReadinessPoint;
            WorldbookInjectionNavigation::Context context;
            context.editor = e;
            context.resolve = [this](const QString &name) { return item(name); };
            context.values = [this] { return QVariantMap{{"position",e->insertionPosition()},
                {"depth",e->insertionDepth()},{"role",e->insertionRole()}}; };
            context.metadata = [this] {
                const auto now = clock.elapsed();
                return QVariantMap{{"step",step},{"stepAtMs",at},{"inputAtMs",phaseClock.inputAt()},
                    {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",QVariant::fromValue(frame)},
                    {"scope",s->scopeKey()},{"generation",s->generation()},{"selectedEntryId",selectedEntryId()}};
            };
            context.qualify = [this,target,&mouseProbe,&mouseReadinessPoint](QQuickItem *candidate, bool keyboard, bool selector) {
                inputTime();
                if (!keyboard) {
                    const auto fresh = inspectControl(candidate);
                    require(candidate == target && item("worldbookInsertionPosition") == candidate && stable.matches(fresh),
                        "INJECTION_MOUSE_TARGET_CHANGED");
                    const auto hit = NativeCheck::hitTest(w,fresh.point,candidate);
                    mouseReadinessPoint = fresh.point;
                    mouseProbe = WorldbookInjectionHit::probe(w,candidate,fresh.point,hit,[this] { return hitClock(); });
                    observed["lastHitProbe"] = mouseProbe;
                    require(hit.accepted(),"INJECTION_MOUSE_HIT_CHANGED");
                    inputTime(); return fresh.point;
                }
                const bool group = candidate && QStringList{"worldbookInsertionPosition","worldbookInsertionDepth", "worldbookInsertionRole"}.contains(candidate->objectName());
                if (group) keyInput(candidate,selector);
                else require(candidate && w->activeFocusItem() == candidate && candidate->isVisible() && candidate->isEnabled(),
                    "INJECTION_TAB_OUTSIDE_CHANGED");
                inputTime(); return QPoint();
            };
            context.mouseDispatch = [this,target,&mouseProbe,&mouseReadinessPoint](const QPoint &point) {
                dispatchMouse(target,"insertion-tab-backtab",mouseReadinessPoint,mouseProbe,point);
            };
            context.publish = [this](const QVariantMap &evidence) { observed["lastNavigation"] = evidence; };
            const auto navigation = WorldbookInjectionNavigation::traverse(w,target,context);
            inputEvidence={{"kind","insertion-tab-backtab"},{"mouseDispatchCount",1},{"keyDispatchCount",9},
                {"beforeGroup",navigation.value("beforeGroup")},{"afterGroup",navigation.value("afterGroup")},
                {"forwardOutsideGroup",true},{"backwardOutsideGroup",true},{"visited",navigation.value("visited")},
                {"navigation",navigation}};
        });
    }
    bool chatReply() {
        require(clock.elapsed()-at<10000,"INJECTION_CHAT_DEADLINE");
        if(s->busy() || pending("chat:history") || pending("chat:send")) return false;
        const auto all=s->messages(); if(all.size()<chatBefore.size()+2) return false;
        require(all.size()==chatBefore.size()+2 && ids().mid(0,chatBefore.size())==chatBefore,"INJECTION_CHAT_ID_PREFIX");
        const auto u=all[all.size()-2].toMap(),a=all.last().toMap(); const auto request=u.value("request_id").toString();
        require(u.value("role")=="user" && u.value("content")==chatTexts[stage-1] && a.value("role")=="assistant" &&
            a.value("content")==reply && !request.isEmpty() && a.value("request_id")==request,"INJECTION_CHAT_PAIR");
        for(const auto &v:all) for(const auto &marker:markers)
            require(!v.toMap().value("content").toString().contains(marker),"INJECTION_HISTORY_POLLUTION");
        chats.append(QVariantMap{{"stage",stage},{"requestId",request},{"scope",scope},{"generation",generation},{"personaId",active()},
            {"beforeIds",chatBefore},{"afterIds",ids()},{"userId",u.value("id")},{"assistantId",a.value("id")},
            {"text",u.value("content")},{"reply",a.value("content")},{"revision",currentRevision()},{"archiveHash",hash(archive())},{"historyMarkerCount",0}});
        return true;
    }
    bool sample(int entry) {
        if(phaseClock.inputAt()<0) { if(!settled()) return false; require(phaseClock.beginInput(clock.elapsed()),"INJECTION_INPUT_CLOCK"); }
        const QStringList names{"worldbookInsertionPosition","worldbookInsertionDepth","worldbookInsertionRole","worldbookInsertionEffective"};
        int count=0;for(const auto &v:samples) if(v.toMap().value("entryId")==entryIds[entry])++count;
        if(count>=names.size()) return true;
        const QString name=names[count];
        if(!control(name,[this,entry,name](QQuickItem *target) {
            require(selectedEntryId()==entryIds[entry],"INJECTION_SAMPLE_ENTRY");requireFixture(4);
            const auto expected=expectedPlacement(4,entry); QVariant value;
            if(name=="worldbookInsertionPosition") value=target->property("currentIndex");
            else if(name=="worldbookInsertionDepth") value=target->property("value");
            else if(name=="worldbookInsertionRole") value=target->property("currentIndex");
            else { value=target->property("text");require(value=="实际生效："+e->insertionEffectiveText() && !e->insertionEffectiveText().isEmpty(),"INJECTION_EFFECTIVE_TEXT"); }
            require(e->insertionPosition()==expected.value("position") && e->insertionDepth()==expected.value("depth") && e->insertionRole()==expected.value("role"),"INJECTION_SAMPLE_MODEL");
            const int position=entry==0?0:entry==1?1:2,role=entry==2?1:entry==3?2:0;
            if(name=="worldbookInsertionPosition") require(value.toInt()==position,"INJECTION_POSITION_CONTROL");
            if(name=="worldbookInsertionDepth") require(value.toInt()==states[4][entry].depth,"INJECTION_DEPTH_CONTROL");
            if(name=="worldbookInsertionRole") require(value.toInt()==role,"INJECTION_ROLE_CONTROL");
            samples.append(QVariantMap{{"step",step},{"control",name},{"entryId",entryIds[entry]},{"value",value},{"placement",expected},
                {"effectiveText",e->insertionEffectiveText()},{"scope",scope},{"generation",generation},{"personaId",active()},
                {"revision",currentRevision()},{"archiveHash",hash(archive())},{"stepAtMs",at},{"inputAtMs",phaseClock.inputAt()},
                {"sampledAtMs",clock.elapsed()},{"frame",QVariant::fromValue(frame)},{"layout",stable.metadata()},
                {"geometry",NativeControlReadiness::wholeVisibility(target,w)},{"windowWidth",w->width()},{"windowHeight",w->height()}});
        },false))return false;
        if(count+1<names.size()) {stable.reset();inputGate.resetForNextStep();w->update();return false;}return true;
    }
    void tick() {
        require(clock.elapsed()<deadline(),"INJECTION_SEGMENT_DEADLINE");
        require(s->connected() && s->runtimeWritable() && s->recoveryState()=="clean","INJECTION_RUNTIME_UNAVAILABLE");
        if(!scope.isEmpty()) require(s->scopeKey()==scope && s->generation()==generation && active()=="default","INJECTION_SCOPE_CHANGED");
        if(step==0) {
            if(!settled())return;const auto draft=restart?syntheticDraft:QString();
            observed["startState"]=QVariantMap{{"dirty",e->dirty()},{"activeId",active()},{"draftMatches",s->draft()==draft},
                {"draftLength",s->draft().size()},{"expectedDraftLength",draft.size()}};
            require(!e->dirty() && s->draft()==draft && active()=="default","INJECTION_START_STATE");
            scope=s->scopeKey();generation=s->generation();newRead();next(50);return;
        }
        if(step==50) {
            if(!readReady() || !settled())return;
            revision=currentRevision();baselineIds=ids();restBaseline=withoutFixture(archive());
            observed.insert({{"baselineReadId",readId},{"baselineRevision",revision},{"baselineArchiveHash",hash(archive())},
                {"baselineMessageIds",baselineIds},{"restHash",hash(restBaseline)},{"scope",scope},
                {"runtimePersonaId",s->state().value("archive").toMap().value("persona_id")}});
            if(restart) {requireFixture(4);record("injection-restart-archive-and-messages-read-back");next(200);return;}
            require(fixtureBook(archive()).isEmpty(),"INJECTION_BASELINE_UNEXPECTED");record("injection-default-baseline-read");
            auto proposed=archive();auto books=proposed.value("worldBooks").toList();QVariantList entries;
            for(int i=0;i<4;++i)entries.append(QVariantMap{{"id",entryIds[i]},{"comment",QString("插入 ")+QString("PQRS")[i]},
                {"content",markers[i]},{"keywords",QVariantList{}},{"secondaryKeywords",QVariantList{}},{"selectiveLogic","and_any"},
                {"caseSensitive",false},{"useRegex",false},{"enabled",true},{"alwaysActive",true},{"position","before_char"},
                {"depth",0},{"role","system"},{"insertionOrder",orders[i]},{"priority",1000},
                {"scanDepth",QVariant::fromValue(nullptr)},{"tokenBudget",QVariant::fromValue(nullptr)}});
            books.append(QVariantMap{{"id",bookId},{"name","插入验收资料"},{"scanDepth",1},{"tokenBudget",1000},{"recursiveScanning",false},{"entries",entries}});
            proposed["worldBooks"]=books;writeId=s->request("archive:put",{{"archive",proposed},{"expected_revision",revision}});
            require(!writeId.isEmpty(),"INJECTION_PREPARE_NOT_SENT");observed["prepareWriteId"]=writeId;observed["preparedExpectedRevision"]=revision;next(5);return;
        }
        if(step==5) {
            require(clock.elapsed()-at<10000,"INJECTION_PREPARE_DEADLINE");if(!responses.contains(writeId))return;
            const auto r=responses.value(writeId);require(r.value("ok")==QVariant(true) && r.value("revision").toInt()==revision+1 &&
                r.value("scope")==scope && r.value("generation").toInt()==generation && r.value("personaId")=="default","INJECTION_PREPARE_RECEIPT");
            requireFixture(0);observed["preparedRevision"]=currentRevision();newRead();next(6);return;
        }
        if(step==6) {if(!readReady())return;requireFixture(0);observed["prepareReadId"]=readId;record("injection-fixture-prepared");stage=1;next(100);return;}
        if(step==100) {if(click("nav-chat"))next(101);return;}
        if(step==101) {
            if(control("chatComposer",[this](QQuickItem *target) {
                require(s->draft().isEmpty(),"INJECTION_CHAT_STALE_DRAFT");chatBefore=ids();mouseInput(target,"text");
                keyInput(target);QInputMethodEvent event;event.setCommitString(chatTexts[stage-1]);QCoreApplication::sendEvent(w,&event);
                require(s->draft()==chatTexts[stage-1] && target->property("text")==chatTexts[stage-1],"INJECTION_CHAT_INPUT");
                inputEvidence={{"kind","text"},{"mouseDispatchCount",1},{"commitCount",1},{"focusInTarget",ArchiveInputProbe::keyboardFocusMatches(target,w)}};
            }))next(102);return;
        }
        if(step==102) {if(click("sendChat"))next(103);return;}
        if(step==103) {
            if(!chatReply())return;requireFixture(stage==1?0:stage==2?2:4);
            newRead();historyReadId=s->request("chat:history");require(!historyReadId.isEmpty(),"INJECTION_HISTORY_READ");next(104);return;
        }
        if(step==104) {
            if(!readReady() || !historyReceipts.contains(historyReadId) || pending("chat:history") || !runtimeSettled())return;
            const auto history=historyReceipts.value(historyReadId);
            require(history.value("requestId")==historyReadId && history.value("scope")==scope && history.value("generation").toInt()==generation &&
                history.value("personaId")=="default" && history.value("messageIds").toStringList()==ids(),"INJECTION_CHAT_HISTORY_BINDING");
            auto chat=chats.last().toMap();
            require(chat.value("afterIds").toStringList()==history.value("messageIds").toStringList() && chat.value("revision").toInt()==currentRevision() && chat.value("archiveHash")==hash(archive()),"INJECTION_CHAT_READBACK_CHANGED");
            for(const auto &v:s->messages())for(const auto &marker:markers)require(!v.toMap().value("content").toString().contains(marker),"INJECTION_CHAT_READBACK_POLLUTION");
            chat.insert({{"readId",readId},{"historyReadId",historyReadId},{"historyReadReceived",true},{"historyReceipt",history},{"readMessageIds",history.value("messageIds")},
                {"readArchiveHash",hash(archive())},{"readRevision",currentRevision()}});chats.last()=chat;
            requireFixture(stage==1?0:stage==2?2:4);
            record(stage==1?"injection-first-chat-all-before":stage==2?"injection-second-chat-system-depth-one":"injection-third-chat-role-depth-placement");
            if(stage==1)next(200);else if(stage==2)next(230);else next(300);return;
        }
        if(step==200) {if(click("nav-memory"))next(201);return;}
        if(step==201) {if(click("reloadWorldbook"))next(202);return;}
        if(step==202) {
            require(clock.elapsed()-at<10000,"INJECTION_RELOAD_DEADLINE");if(!settled())return;
            const int row=bookIndex();require(row>0,"INJECTION_BOOK_ROW");
            if(select("worldbookBookSelector",row)){require(selectedEntryId()==entryIds[0],"INJECTION_FIRST_ENTRY");next(restart?400:203);}return;
        }
        if(step==203) {if(chooseEntry(1))next(restart?401:204);return;}
        if(step==204) {if(choosePlacement("worldbookInsertionPosition",1))next(205);return;}
        if(step==210) {if(chooseEntry(2))next(restart?402:211);return;}
        if(step==211) {if(choosePlacement("worldbookInsertionPosition",2))next(212);return;}
        if(step==212) {if(depth(1))next(213);return;}
        if(step==213) {if(tabUnchanged())next(205);return;}
        if(step==220) {if(click("memory-close"))next(restart?290:101);return;}
        if(step==230) {if(click("nav-memory"))next(231);return;}
        if(step==231) {if(depth(0))next(232);return;}
        if(step==232) {if(choosePlacement("worldbookInsertionRole",1))next(205);return;}
        if(step==240) {if(chooseEntry(3))next(restart?403:241);return;}
        if(step==241) {if(choosePlacement("worldbookInsertionPosition",2))next(242);return;}
        if(step==242) {if(depth(2))next(243);return;}
        if(step==243) {if(choosePlacement("worldbookInsertionRole",2))next(244);return;}
        if(step==244) {if(tabUnchanged())next(205);return;}
        if(step==205) {
            if(!saveBinding.metadata().value("armed").toBool()) {revision=currentRevision();require(saveBinding.arm(scope,generation,pendingCommands(),receipts),"INJECTION_SAVE_BASELINE");}
            if(click("saveWorldbook")) {require(saveBinding.observe(scope,generation,pendingCommands(),receipts)==ArchiveInputProbe::SaveBinding::Matched,"INJECTION_SAVE_DISPATCH");writeId=saveBinding.requestId();next(206);}return;
        }
        if(step==206) {
            require(clock.elapsed()-at<10000,"INJECTION_SAVE_DEADLINE");if(!responses.contains(writeId) || e->busy())return;
            require(saveBinding.observe(scope,generation,pendingCommands(),receipts)==ArchiveInputProbe::SaveBinding::Matched,"INJECTION_SAVE_BINDING");
            const auto r=responses.value(writeId);require(r.value("ok")==QVariant(true) && r.value("revision").toInt()==revision+1 && r.value("scope")==scope &&
                r.value("generation").toInt()==generation && r.value("personaId")=="default" && e->status()=="saved" && !e->dirty(),"INJECTION_SAVE_RECEIPT");
            requireFixture(saves.size()+1);newRead();next(208);return;
        }
        if(step==208) {
            if(!readReady())return;const int n=saves.size()+1;requireFixture(n);
            if(!control("archive-status",[this,n](QQuickItem *target) {
                require(target->property("text").toString().contains("已保存"),"INJECTION_SAVE_FEEDBACK");
                const QString image=prefix+".worldbook-injection-save-"+QString::number(n)+".png";
                require(w->grabWindow().save(image),"INJECTION_CAPTURE_FAILED");inputTime();
                require(item("archive-status")==target && stable.matches(inspectControl(target)),"INJECTION_CAPTURE_LAYOUT_CHANGED");
                saves.append(QVariantMap{{"stage",n},{"writeId",writeId},{"readId",readId},{"scope",scope},{"generation",generation},{"personaId",active()},
                    {"expectedRevision",revision},{"revision",currentRevision()},{"entryId",selectedEntryId()},{"placement",selectedPlacement()},
                    {"book",fixtureBook(archive())},{"archiveHash",hash(archive())},{"restHash",hash(withoutFixture(archive()))},
                    {"feedback",target->property("text")},{"binding",saveBinding.metadata()},{"readAtMs",at},{"feedbackInputAtMs",phaseClock.inputAt()},
                    {"feedbackGeometry",NativeControlReadiness::wholeVisibility(target,w)},{"windowWidth",w->width()},{"windowHeight",w->height()},{"screenshot",image}});
            },false))return;
            record(n==1?"injection-q-after-saved-and-read-back":n==2?"injection-r-system-depth-one-saved-and-read-back":n==3?"injection-r-user-depth-zero-saved-and-read-back":"injection-s-assistant-depth-two-saved-and-read-back");
            if(n==1)next(210);else if(n==2){stage=2;next(220);}else if(n==3)next(240);else{stage=3;next(220);}return;
        }
        if(step>=400 && step<=403) {
            const int index=step-400;if(!sample(index))return;
            record(QString("injection-restart-entry-")+QString("pqrs")[index]+"-controls");
            if(index==0)next(203);else if(index==1)next(210);else if(index==2)next(240);else next(220);return;
        }
        if(step==290) {newRead();historyReadId=s->request("chat:history");require(!historyReadId.isEmpty(),"INJECTION_HISTORY_READ");next(300);return;}
        if(step==300) {
            if(!readReady() || !historyReceipts.contains(historyReadId) || pending("chat:history") || !settled())return;
            const auto history=historyReceipts.value(historyReadId);
            require(history.value("requestId")==historyReadId && history.value("scope")==scope && history.value("generation").toInt()==generation &&
                history.value("personaId")=="default" && history.value("messageIds").toStringList()==ids(),"INJECTION_TERMINAL_HISTORY_BINDING");
            requireFixture(4);const int puts=std::count_if(receipts.cbegin(),receipts.cend(),[](const QVariant &v){return v.toMap().value("command")=="archive:put";});
            require(puts==(restart?0:5) && saves.size()==(restart?0:4) && chats.size()==(restart?0:3),"INJECTION_TERMINAL_COUNTS");
            require(ids().size()==baselineIds.size()+(restart?0:6) && ids().mid(0,baselineIds.size())==baselineIds,"INJECTION_TERMINAL_IDS");
            for(const auto &v:s->messages())for(const auto &marker:markers)require(!v.toMap().value("content").toString().contains(marker),"INJECTION_TERMINAL_HISTORY");
            if(restart)require(s->draft()==syntheticDraft && hash(archive())==observed.value("baselineArchiveHash") && currentRevision()==observed.value("baselineRevision").toInt(),"INJECTION_RESTART_CHANGED");
            observed.insert({{"finalReadId",readId},{"historyReadId",historyReadId},{"historyReadReceived",true},{"historyReceipt",history},{"historyMarkerCount",0},
                {"putCount",puts},{"terminalMessageIds",ids()},{"terminalRevision",currentRevision()},{"terminalArchiveHash",hash(archive())},
                {"book",fixtureBook(archive())},{"terminalDraftMatches",!restart || s->draft()==syntheticDraft}});
            record(restart?"injection-restart-zero-writes-and-zero-chats":"injection-terminal-four-saves-six-messages-rest-unchanged");finish(true);return;
        }
    }
    void finish(bool passed,QString error={}) {
        if(finished)return;finished=true;timer.stop();observed["step"]=step;observed["elapsedMs"]=clock.elapsed();
        done({{"passed",passed},{"error",error},{"mode",restart?"restart-readback":"change-and-effect"},{"deadlineMs",deadline()},
            {"checks",checks},{"inputs",inputs},{"receipts",receipts},{"saves",saves},{"chats",chats},{"samples",samples},{"observed",observed}});deleteLater();
    }
};
}
void WorldbookInjectionCheck::run(QQuickWindow *w,RuntimeBridge *s,ArchiveEditor *e,bool restart,
    const QString &capture,std::function<void(QVariantMap)> done) {new Check(w,s,e,restart,capture,std::move(done));}
