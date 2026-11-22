#include "WorldbookFileCheck.h"
#include "ArchiveInputProbe.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include <QCoreApplication>
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QFileInfo>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QJsonObject>
#include <QQuickWindow>
#include <QSaveFile>
#include <QSet>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

// An independent, model-free tail after the unchanged --p1-settings checks.
// Native file dialogs are handed paths; confirmation, editing, selection and
// saving use the real controls. Nothing enters settingsSections or its gates.
namespace {
const QString sourceName = "p1-worldbook-source.json", exportName = "p1-worldbook-export.json";
const QString bookName = "文件导入验证书", savedName = "文件导入验证书（已保存修改）";
const QString bodyMarker = "W9_FILE_GUI_BODY_MARKER_20261107";
const QString keyMarker = "W9_FILE_GUI_KEY_MARKER_20261107";
const QString disabledBody = "W9_FILE_GUI_DISABLED_BODY_20261107";

QString digest(const QByteArray &bytes) {
    return QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex());
}
QString hash(const QVariantMap &value) {
    return digest(QJsonDocument(QJsonObject::fromVariantMap(value)).toJson(QJsonDocument::Compact));
}
QString keywordsHash(const QVariantList &value) {
    return digest(QJsonDocument(QJsonArray::fromVariantList(value)).toJson(QJsonDocument::Compact));
}
QByteArray fixtureBytes() {
    const QJsonObject first{{"key", QJsonArray{keyMarker}}, {"content", bodyMarker + QChar(0x200b)},
        {"comment", "文件导入条目"}, {"probability", 60}, {"position", 4}, {"depth", 2}, {"role", 2}};
    const QJsonObject second{{"key", QJsonArray{"/w9-file-gui-regex/", "w9-file-gui-literal"}},
        {"content", disabledBody}, {"comment", "混合正则停用条目"}};
    return QJsonDocument(QJsonObject{{"name", bookName}, {"entries", QJsonObject{
        {"0", first}, {"1", second}, {"2", QJsonObject{{"key", QJsonArray{"empty"}}, {"content", ""}}}}}})
        .toJson(QJsonDocument::Indented);
}

class Check final : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *e;
    bool restart, executing = false, finished = false;
    QString prefix, scope, bookId, readId, saveId;
    int step = 0, generation = 0, baselineRevision = 0, putResponses = 0;
    qint64 at = 0;
    quint64 frame = 0;
    QTimer timer;
    QElapsedTimer clock;
    QVariantMap observed, baselineArchive, importedBook, initialFileState;
    QVariantList checks, inputs, receipts;
    QStringList messageIds;
    QMap<QString, QVariantMap> responses;
    QMap<QString, QSet<QString>> fileIds;
    SummaryInteractionProbe::StableGate stable;
    NativeControlReadiness::OnceGate gate;
    std::function<void(QVariantMap)> done;
  public:
    Check(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool verify,
          QString capture, std::function<void(QVariantMap)> completion)
        : QObject(window), w(window), s(session), e(editor), restart(verify),
          prefix(std::move(capture)), done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::changed, this, [this] {
            if (finished) return;
            const auto state = s->worldbookFileState();
            const auto operation = state.value("operation").toString(), id = state.value("requestId").toString();
            if (QStringList{"inspect", "import", "export"}.contains(operation) && !id.isEmpty())
                fileIds[operation].insert(id);
        });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &result, int g) {
                if (finished || !QStringList{"archive:get", "archive:put"}.contains(command)) return;
                if (command == "archive:put") ++putResponses;
                const QVariantMap receipt{{"requestId", id}, {"command", command}, {"generation", g},
                    {"scopeKey", s->scopeKey()}, {"ok", result.value("ok")}, {"revision", result.value("revision")}};
                responses[id] = receipt;
                receipts.append(receipt);
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
    int deadline() const { return restart ? 15000 : 30000; }
    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"step", step}, {"elapsedMs", clock.elapsed()}, {"generation", s->generation()}});
        NativeCheck::require(ok, code, details);
    }
    void next(int n) { step = n; at = clock.elapsed(); stable.reset(); gate.resetForNextStep(); }
    void record(const QString &name) { checks.append(QVariantMap{{"name", name}, {"passed", true}}); }
    QVariantMap archive() const { return s->state().value("archive").toMap().value("archive").toMap(); }
    int revision() const { return s->state().value("archive").toMap().value("revision").toInt(); }
    QStringList ids() const {
        QStringList result;
        for (const auto &value : s->messages()) result.append(value.toMap().value("id").toString());
        return result;
    }
    QString pendingId(const QString &command) const {
        for (const auto &value : s->diagnostics().value("pendingCommands").toList()) {
            const auto pending = value.toMap();
            if (pending.value("command") == command) return pending.value("id").toString();
        }
        return {};
    }
    QString actionRequestId(const QString &command, qsizetype receiptStart) const {
        auto id = pendingId(command);
        // A local response may arrive while QTest delivers the click. The
        // correlated receipt is as authoritative as the still-pending row.
        for (qsizetype i = receiptStart; i < receipts.size(); ++i) {
            const auto receipt = receipts[i].toMap();
            if (receipt.value("command") != command) continue;
            const auto received = receipt.value("requestId").toString();
            require(id.isEmpty() || id == received, "WORLDBOOK_FILE_MULTIPLE_ACTION_REQUESTS");
            id = received;
        }
        return id;
    }
    bool settled() const {
        return s->connected() && s->runtimeWritable() && !s->busy() && !s->personaChanging() &&
            e->initialized() && !e->busy() && e->archiveScope() == s->scopeKey() && e->revision() == revision() &&
            pendingId("chat:send").isEmpty() && pendingId("chat:history").isEmpty() && pendingId("archive:get").isEmpty();
    }
    QQuickItem *item(const QString &name) const { return NativeCheck::findVisual(w->contentItem(), name, true).item; }
    bool archiveReady() const {
        const auto found = NativeCheck::findVisual(w->contentItem(), "drawer-memory", false).item;
        return found && found->property("inputReady").toBool();
    }
    SummaryInteractionProbe::ControlObservation inspect(QQuickItem *target) const {
        bool ready = true;
        for (auto *parent = target; parent; parent = parent->parentItem())
            if (parent->property("inputReady").isValid()) ready = ready && parent->property("inputReady").toBool();
        auto value = SummaryInteractionProbe::inspect(target, w, ready, scope);
        const bool whole = NativeControlReadiness::wholeVisibility(target, w).value("fullyVisible").toBool();
        value.eligible = value.eligible && whole;
        value.state["fullyVisible"] = whole; value.state["ready"] = value.eligible;
        return value;
    }
    bool control(const QString &name, const QString &kind,
                 const std::function<QVariantMap(QQuickItem *, QPoint)> &action) {
        const auto elapsed = [this] { return clock.elapsed() - at; };
        require(elapsed() < 4000 && clock.elapsed() < deadline(), "WORLDBOOK_FILE_INPUT_DEADLINE", {{"control", name}});
        QPointer<QQuickItem> target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        require(!revealed.value("expired").toBool() && elapsed() < 4000, "WORLDBOOK_FILE_INPUT_DEADLINE");
        const auto observation = inspect(target);
        const auto layout = stable.observe(observation, elapsed(), frame);
        if (!layout.value("ready").toBool()) { w->update(); return false; }
        QVariantMap evidence;
        const auto performed = gate.poll(elapsed(), 4000, [&] {
            auto fresh = inspect(item(name)); auto state = fresh.state;
            state["ready"] = item(name) == target && stable.matches(fresh) && s->scopeKey() == scope &&
                s->generation() == generation && clock.elapsed() < deadline();
            return state;
        }, [&] {
            const auto fresh = inspect(target);
            require(target && item(name) == target && stable.matches(fresh), "WORLDBOOK_FILE_INPUT_TARGET_CHANGED");
            const auto hit = NativeCheck::hitTest(w, fresh.point, target);
            require(hit.accepted(), "WORLDBOOK_FILE_INPUT_HIT", hit.metadata());
            require(elapsed() < 4000 && clock.elapsed() < deadline(), "WORLDBOOK_FILE_INPUT_DEADLINE");
            evidence = action(target, fresh.point);
            evidence.insert({{"step", step}, {"control", name}, {"kind", kind}, {"scopeKey", scope},
                {"generation", generation}, {"layout", layout}, {"hit", hit.metadata()},
                {"elapsedMs", elapsed()}, {"frame", QVariant::fromValue(frame)}, {"deadlineMs", 4000}});
        });
        require(performed != NativeControlReadiness::OnceGate::Expired, "WORLDBOOK_FILE_INPUT_DEADLINE");
        if (performed != NativeControlReadiness::OnceGate::Performed) return false;
        auto proof = gate.metadata(); proof["pollIntervalMs"] = timer.interval();
        evidence["gate"] = proof; inputs.append(evidence);
        return true;
    }
    bool click(const QString &name) {
        return control(name, "button", [this](QQuickItem *target, QPoint point) {
            QSignalSpy clicked(target, SIGNAL(clicked())); require(clicked.isValid(), "WORLDBOOK_FILE_CLICK_SIGNAL");
            QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, point, 0);
            require(clicked.count() == 1, "WORLDBOOK_FILE_CLICK_COUNT");
            return QVariantMap{{"mouseDispatchCount", 1}, {"clickedSignals", clicked.count()}};
        });
    }
    QVariantMap book() const {
        for (const auto &value : archive().value("worldBooks").toList())
            if (value.toMap().value("id").toString() == bookId) return value.toMap();
        return {};
    }
    QString selectedId() const {
        for (const auto &value : e->bookRows())
            if (value.toMap().value("key").toString() == e->selectedBookKey()) return value.toMap().value("id").toString();
        return {};
    }
    int selectorIndex() const {
        const auto rows = e->bookRows();
        for (int i = 0; i < rows.size(); ++i) if (rows[i].toMap().value("id").toString() == bookId) return i + 1;
        return -1;
    }
    QVariantMap withoutBook(QVariantMap value) const {
        QVariantList books;
        for (const auto &entry : value.value("worldBooks").toList())
            if (entry.toMap().value("id").toString() != bookId) books.append(entry);
        value["worldBooks"] = books; return value;
    }
    QVariantMap configuration() const {
        const auto current = book(); QVariantList entries;
        for (const auto &value : current.value("entries").toList()) {
            const auto entry = value.toMap();
            QVariantMap fields;
            for (const auto *key : {"id", "enabled", "alwaysActive", "position", "depth", "role", "insertionOrder",
                                    "priority", "selectiveLogic", "scanDepth", "tokenBudget", "caseSensitive", "useRegex"})
                fields[key] = entry.value(key);
            fields["contentSha256"] = digest(entry.value("content").toString().toUtf8());
            fields["keywordsSha256"] = keywordsHash(entry.value("keywords").toList());
            fields["secondaryKeywordsSha256"] = keywordsHash(entry.value("secondaryKeywords").toList());
            entries.append(fields);
        }
        return {{"bookId", bookId}, {"bookName", current.value("name")}, {"scanDepth", current.value("scanDepth")},
            {"tokenBudget", current.value("tokenBudget")}, {"recursiveScanning", current.value("recursiveScanning")},
            {"entryCount", entries.size()}, {"entries", entries}};
    }
    void requireBook(const QString &name) const {
        const auto current = book();
        const auto entries = current.value("entries").toList();
        require(current.value("name") == name && entries.size() == 2, "WORLDBOOK_FILE_SAVED_BOOK");
        const auto first = entries[0].toMap(), second = entries[1].toMap();
        require(first.value("content") == bodyMarker && first.value("keywords").toStringList() == QStringList{keyMarker} &&
            first.value("position") == "at_depth" && first.value("depth").toInt() == 2 && first.value("role") == "assistant" &&
            first.value("enabled") == QVariant(true) && second.value("content") == disabledBody &&
            second.value("enabled") == QVariant(false), "WORLDBOOK_FILE_SAVED_CONFIGURATION");
    }
    void finish(bool passed, const QString &error = {}) {
        if (finished) return;
        finished = true; timer.stop();
        QVariantMap counts;
        for (const auto &operation : {"inspect", "import", "export"}) {
            QStringList values = fileIds.value(operation).values(); values.sort(); counts[operation] = values;
        }
        observed["fileControlRequestIds"] = counts;
        observed["archivePutReceiptCount"] = putResponses;
        observed["finalMessageIds"] = ids();
        auto callback = std::move(done);
        if (callback) callback({{"schema", "reverie.native.worldbook-file.gui-evidence.v1"}, {"passed", passed},
            {"error", error}, {"mode", restart ? "restart-readback" : "import-edit-export"}, {"step", step},
            {"deadlineMs", deadline()}, {"elapsedMs", clock.elapsed()}, {"pollIntervalMs", timer.interval()},
            {"checks", checks}, {"observed", observed}, {"inputs", inputs}, {"archiveReceipts", receipts},
            {"systemOpenDialogCovered", false}, {"systemSaveDialogCovered", false}, {"contentCollected", false},
            {"inputMethodScope", "synthetic QInputMethodEvent commit, not physical OS IME acceptance"}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < deadline(), "WORLDBOOK_FILE_TAIL_TIMEOUT");
        if (step == 0) {
            require(clock.elapsed() - at < 4000, "WORLDBOOK_FILE_BASELINE_DEADLINE");
            if (!settled()) return;
            require(!e->dirty() && !s->worldbookFileBusy(), "WORLDBOOK_FILE_BASELINE_BUSY");
            scope = s->scopeKey(); generation = s->generation(); baselineRevision = revision();
            baselineArchive = archive(); messageIds = ids(); initialFileState = s->worldbookFileState();
            observed.insert({{"scopeKey", scope}, {"generation", generation}, {"baselineRevision", baselineRevision},
                {"initialMessageIds", messageIds}, {"baselineBookCount", e->bookRows().size()}});
            if (restart) {
                int found = 0;
                for (const auto &value : e->bookRows()) if (value.toMap().value("name") == savedName) {
                    bookId = value.toMap().value("id").toString(); ++found;
                }
                require(found == 1 && !bookId.isEmpty(), "WORLDBOOK_FILE_RESTART_BOOK_MISSING");
                observed["bookId"] = bookId; observed["archiveHashBefore"] = hash(baselineArchive);
                requireBook(savedName);
            } else {
                const auto bytes = fixtureBytes(); const auto path = s->dataRoot() + "/" + sourceName;
                require(!QFileInfo::exists(path) && !QFileInfo::exists(s->dataRoot() + "/" + exportName), "WORLDBOOK_FILE_FIXTURE_EXISTS");
                QSaveFile file(path); require(file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size() && file.commit(),
                    "WORLDBOOK_FILE_FIXTURE_WRITE");
                observed["source"] = QVariantMap{{"file_name", sourceName}, {"file_bytes", bytes.size()}, {"sha256", digest(bytes)}};
            }
            next(1); return;
        }
        require(s->scopeKey() == scope && s->generation() == generation, "WORLDBOOK_FILE_SCOPE_CHANGED");
        if (step == 1) { if (click("nav-memory")) next(2); return; }
        if (step == 2) {
            if (!archiveReady()) { require(clock.elapsed() - at < 4000, "WORLDBOOK_FILE_ARCHIVE_OPEN_DEADLINE"); return; }
            if (restart) {
                const auto before = receipts.size();
                if (click("reloadWorldbook")) {
                    readId = actionRequestId("archive:get", before); require(!readId.isEmpty(), "WORLDBOOK_FILE_RESTART_READ_NOT_SENT");
                    next(20);
                }
            } else if (control("worldbookFileImport", "path-handoff", [this](QQuickItem *, QPoint) {
                s->inspectWorldbookFile(QUrl::fromLocalFile(s->dataRoot() + "/" + sourceName), e->revision());
                return QVariantMap{{"pathHandoffCount", 1}, {"mouseDispatchCount", 0}};
            })) next(3);
            return;
        }
        if (step == 3) {
            require(clock.elapsed() - at < 8000, "WORLDBOOK_FILE_INSPECT_DEADLINE");
            const auto state = s->worldbookFileState(); const auto status = state.value("status").toString();
            require(!QStringList{"error", "unknown"}.contains(status), "WORLDBOOK_FILE_INSPECT_FAILED");
            if (status != "confirmation") return;
            const auto source = observed.value("source").toMap(); auto *summary = item("worldbookFileImportSummary");
            if (!summary) return;
            const auto text = summary->property("text").toString();
            require(state.value("book_name") == bookName && state.value("importable_entry_count").toInt() == 2 &&
                state.value("skipped").toMap() == QVariantMap{{"empty", 1}} && state.value("dropped_fields").toMap() == QVariantMap{{"probability", 1}} &&
                state.value("disabled_regex_entry_count").toInt() == 1 && state.value("cleaned_entry_count").toInt() == 1 &&
                state.value("sha256") == source.value("sha256") && state.value("file_bytes") == source.value("file_bytes"),
                "WORLDBOOK_FILE_INSPECTION_METADATA");
            require(summary->property("textFormat").toInt() == int(Qt::PlainText) && text.contains(bookName) &&
                text.contains("将导入 2 条") && text.contains("跳过 1 条") && text.contains("probability") &&
                text.contains("1 条正则已关闭") && text.contains("1 条文字被清理") &&
                !text.contains(bodyMarker) && !text.contains(keyMarker) && !text.contains(disabledBody), "WORLDBOOK_FILE_CONFIRMATION_CONTENT");
            observed["inspect"] = state;
            observed["confirmation"] = QVariantMap{{"summaryText", text}, {"plainText", true}, {"visible", summary->isVisible()},
                {"noBodyOrKeywords", true}};
            record("source-inspected-with-closed-summary"); next(4); return;
        }
        if (step == 4) { if (click("worldbookFileImportConfirm")) next(5); return; }
        if (step == 5) {
            require(clock.elapsed() - at < 8000, "WORLDBOOK_FILE_IMPORT_READBACK_DEADLINE");
            const auto state = s->worldbookFileState(); const auto status = state.value("status").toString();
            require(!QStringList{"error", "unknown"}.contains(status), "WORLDBOOK_FILE_IMPORT_FAILED");
            if (status != "success" || !settled()) return;
            bookId = state.value("world_book_id").toString();
            require(!bookId.isEmpty() && state.value("operation") == "import" && state.value("revision").toInt() == baselineRevision + 1 &&
                state.value("readbackRevision").toInt() == baselineRevision + 1 && state.value("selectedWorldBookId") == bookId &&
                selectedId() == bookId && e->title() == bookName && !e->dirty(), "WORLDBOOK_FILE_IMPORT_SELECTION");
            requireBook(bookName); importedBook = book(); observed["bookId"] = bookId; observed["import"] = state;
            QVariantList reads;
            for (const auto &value : receipts) {
                const auto receipt = value.toMap();
                if (receipt.value("command") == "archive:get" && receipt.value("ok") == QVariant(true) &&
                    receipt.value("revision").toInt() == baselineRevision + 1 && receipt.value("scopeKey") == scope &&
                    receipt.value("generation").toInt() == generation) reads.append(receipt);
            }
            require(reads.size() == 1, "WORLDBOOK_FILE_IMPORT_READ_CORRELATION");
            observed["importRead"] = reads.first();
            record("real-confirmation-imports-and-selects-new-book"); next(6); return;
        }
        if (step == 6) {
            if (control("worldbookName", "text", [this](QQuickItem *target, QPoint point) {
                QSignalSpy edited(target, SIGNAL(textEdited())); require(edited.isValid(), "WORLDBOOK_FILE_TEXT_SIGNAL");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, point, 0);
                target->forceActiveFocus();
                require(ArchiveInputProbe::keyboardFocusMatches(target, w), "WORLDBOOK_FILE_TEXT_FOCUS");
                require(QMetaObject::invokeMethod(target, "selectAll"), "WORLDBOOK_FILE_TEXT_SELECT_ALL");
                QInputMethodEvent commit; commit.setCommitString(savedName); QCoreApplication::sendEvent(w, &commit);
                require(edited.count() == 1 && target->property("text") == savedName && e->title() == savedName && e->dirty(),
                    "WORLDBOOK_FILE_TEXT_COMMIT");
                return QVariantMap{{"mouseDispatchCount", 1}, {"inputMethodCommitCount", 1}, {"textEditedSignals", edited.count()}};
            })) next(7);
            return;
        }
        if (step == 7) {
            auto *importButton = item("worldbookFileImport"), *exportButton = item("worldbookFileExport");
            require(importButton && exportButton && !importButton->isEnabled() && !exportButton->isEnabled() && e->canSave(),
                "WORLDBOOK_FILE_DIRTY_GATE");
            observed["nameEdit"] = QVariantMap{{"field", "name"}, {"before", bookName}, {"after", savedName},
                {"dirty", e->dirty()}, {"importEnabled", importButton->isEnabled()}, {"exportEnabled", exportButton->isEnabled()}};
            record("dirty-draft-disables-file-operations"); next(8); return;
        }
        if (step == 8) {
            const auto before = receipts.size();
            if (click("saveWorldbook")) {
                saveId = actionRequestId("archive:put", before); require(!saveId.isEmpty(), "WORLDBOOK_FILE_SAVE_NOT_SENT");
                next(9);
            }
            return;
        }
        if (step == 9) {
            require(clock.elapsed() - at < 8000, "WORLDBOOK_FILE_SAVE_DEADLINE");
            if (!responses.contains(saveId) || !settled()) return;
            const auto receipt = responses.value(saveId);
            require(receipt.value("ok") == QVariant(true) && receipt.value("revision").toInt() == baselineRevision + 2 &&
                revision() == baselineRevision + 2 && !e->dirty() && e->title() == savedName, "WORLDBOOK_FILE_SAVE_READBACK");
            requireBook(savedName);
            auto before = importedBook, after = book(); before.remove("name"); after.remove("name");
            require(before == after, "WORLDBOOK_FILE_SAVE_CHANGED_OTHER_FIELDS");
            auto save = receipt; save.insert({{"expectedRevision", baselineRevision + 1}, {"dirtyBefore", true},
                {"dirtyAfter", e->dirty()}, {"bookId", bookId}, {"bookName", savedName}, {"changedFields", QStringList{"name"}}});
            observed["save"] = save; record("real-name-edit-and-save-read-back"); next(10); return;
        }
        if (step == 10) {
            if (control("worldbookFileExport", "path-handoff", [this](QQuickItem *, QPoint) {
                s->exportWorldbookFile(QUrl::fromLocalFile(s->dataRoot() + "/" + exportName), bookId, e->revision());
                return QVariantMap{{"pathHandoffCount", 1}, {"mouseDispatchCount", 0}};
            })) next(11);
            return;
        }
        if (step == 11) {
            require(clock.elapsed() - at < 8000, "WORLDBOOK_FILE_EXPORT_DEADLINE");
            const auto state = s->worldbookFileState(); const auto status = state.value("status").toString();
            require(!QStringList{"error", "unknown"}.contains(status), "WORLDBOOK_FILE_EXPORT_FAILED");
            if (status != "success") return;
            require(state.value("operation") == "export" && state.value("world_book_id") == bookId && state.value("book_name") == savedName &&
                state.value("entry_count").toInt() == 2 && state.value("file_name") == exportName && state.value("bytes").toLongLong() > 0,
                "WORLDBOOK_FILE_EXPORT_METADATA");
            observed["export"] = state; observed["final"] = configuration();
            record("export-writes-selected-saved-book");
            require(hash(withoutBook(archive())) == hash(baselineArchive) && ids() == messageIds && putResponses == 1 &&
                fileIds.value("inspect").size() == 1 && fileIds.value("import").size() == 1 && fileIds.value("export").size() == 1,
                "WORLDBOOK_FILE_UNRELATED_STATE_CHANGED");
            observed["restHashBefore"] = hash(baselineArchive); observed["restHashAfter"] = hash(withoutBook(archive()));
            observed["finalArchiveHash"] = hash(archive());
            observed["messageIdsUnchanged"] = true; observed["finalRevision"] = revision();
            record("original-books-and-messages-preserved"); finish(true); return;
        }
        if (step == 20) {
            require(clock.elapsed() - at < 8000, "WORLDBOOK_FILE_RESTART_READ_DEADLINE");
            if (!responses.contains(readId) || !settled()) return;
            const auto receipt = responses.value(readId);
            require(receipt.value("ok") == QVariant(true) && receipt.value("revision").toInt() == baselineRevision &&
                hash(archive()) == hash(baselineArchive), "WORLDBOOK_FILE_RESTART_READBACK");
            observed["restartRead"] = receipt; record("restart-rereads-persisted-file-book"); next(21); return;
        }
        if (step == 21) {
            if (selectedId() == bookId) { next(22); return; }
            const int index = selectorIndex(); require(index > 0, "WORLDBOOK_FILE_RESTART_SELECTOR_ID");
            if (control("worldbookBookSelector", "selector", [this, index](QQuickItem *target, QPoint point) {
                QSignalSpy activated(target, SIGNAL(activated(int))); require(activated.isValid(), "WORLDBOOK_FILE_SELECTOR_SIGNAL");
                QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, point, 0);
                require(ArchiveInputProbe::keyboardFocusMatches(target, w, true), "WORLDBOOK_FILE_SELECTOR_FOCUS");
                QTest::keyClick(w, Qt::Key_Home);
                for (int i = 0; i < index; ++i) QTest::keyClick(w, Qt::Key_Down);
                QTest::keyClick(w, Qt::Key_Return);
                require(activated.count() == 1 && target->property("currentIndex").toInt() == index, "WORLDBOOK_FILE_SELECTOR_ACTIVATION");
                return QVariantMap{{"mouseDispatchCount", 1}, {"keyDispatchCount", index + 2},
                    {"activatedSignals", activated.count()}, {"selectedIndex", index}};
            })) next(22);
            return;
        }
        if (step == 22) {
            require(clock.elapsed() - at < 4000, "WORLDBOOK_FILE_RESTART_CONTROL_DEADLINE");
            auto *field = item("worldbookName");
            if (!field || selectedId() != bookId || field->property("text") != savedName) return;
            requireBook(savedName);
            require(e->title() == savedName && !e->dirty() && revision() == baselineRevision &&
                hash(archive()) == hash(baselineArchive) && ids() == messageIds, "WORLDBOOK_FILE_RESTART_STATE_CHANGED");
            observed["final"] = configuration(); observed["finalRevision"] = revision();
            observed["archiveHashAfter"] = hash(archive()); observed["messageIdsUnchanged"] = true;
            record("restart-controls-show-saved-name-and-configuration");
            require(putResponses == 0 && fileIds.isEmpty() && s->worldbookFileState() == initialFileState,
                "WORLDBOOK_FILE_RESTART_WROTE");
            record("restart-sends-no-file-controls-or-saves"); finish(true);
        }
    }
};
}

namespace WorldbookFileCheck {
void run(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *editor, bool restart,
         const QString &prefix, std::function<void(QVariantMap)> done) {
    new Check(window, session, editor, restart, prefix, std::move(done));
}
}
