#include "../src/ArchiveEditor.h"
#include <QCryptographicHash>
#include <QJsonDocument>
#include <QJsonObject>
#include <QtTest>

namespace {

QVariantMap existingArchive() {
    const QVariantMap firstEntry{{"id", "entry-primary"},
                                 {"comment", "Comment hidden by this editor"},
                                 {"content", "Original note"},
                                 {"keywords", QVariantList{"reverie", "home"}},
                                 {"secondaryKeywords", QVariantList{"night", "quiet"}},
                                 {"enabled", true},
                                 {"alwaysActive", false},
                                 {"selectiveLogic", "and_all"},
                                 {"position", "after_char"},
                                 {"insertionOrder", 73},
                                 {"priority", 4},
                                 {"caseSensitive", true},
                                 {"useRegex", false},
                                 {"scanDepth", 17},
                                 {"tokenBudget", 320},
                                 {"depth", 2},
                                 {"role", "user"}};
    const QVariantMap siblingEntry{{"id", "entry-sibling"},
                                   {"content", "Do not rewrite this sibling"},
                                   {"keywords", QVariantList{"sibling"}},
                                   {"secondaryKeywords", QVariantList{}},
                                   {"enabled", false},
                                   {"alwaysActive", true},
                                   {"comment", "Sibling metadata"},
                                   {"priority", 11},
                                   {"position", "before_char"},
                                   {"role", "system"}};
    const QVariantMap primaryBook{{"id", "book-primary"},
                                  {"name", "Original book"},
                                  {"entries", QVariantList{firstEntry, siblingEntry}},
                                  {"scanDepth", 23},
                                  {"tokenBudget", 620},
                                  {"recursiveScanning", false},
                                  {"createdAt", "2026-09-01T10:00:00+00:00"},
                                  {"updatedAt", "2026-09-02T10:00:00+00:00"}};
    const QVariantMap siblingBook{
        {"id", "book-sibling"},
        {"name", "Keep the other book"},
        {"entries", QVariantList{QVariantMap{{"id", "entry-other-book"},
                                             {"content", "Other book content"},
                                             {"keywords", QVariantList{"other"}},
                                             {"enabled", true},
                                             {"alwaysActive", false},
                                             {"comment", "Untouched other book"}}}},
        {"scanDepth", 9},
        {"tokenBudget", 840},
        {"recursiveScanning", true},
        {"createdAt", "2026-08-01T10:00:00+00:00"},
        {"updatedAt", "2026-08-02T10:00:00+00:00"}};
    const QVariantMap character{{"id", "character-keep"},
                                {"name", "Existing character"},
                                {"description", "Keep the character description"},
                                {"importedSystemPrompt", "A hidden imported prompt"},
                                {"useImportedSystemPrompt", true},
                                {"alternateGreetings", QVariantList{"first", "second"}}};
    return {{"characters", QVariantList{character}},
            {"activeCharacterIds", QVariantList{"character-keep"}},
            {"worldBooks", QVariantList{primaryBook, siblingBook}}};
}

QVariantMap snapshot(const QVariantMap &archive, int revision) {
    const auto document = QJsonDocument(QJsonObject::fromVariantMap(archive));
    const auto bytes = document.toJson(QJsonDocument::Compact);
    return {{"ok", true},
            {"exists", true},
            {"revision", revision},
            {"archive", document.object().toVariantMap()},
            {"checksum", QString::fromLatin1(
                             QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())},
            {"updated_at_utc", "2026-10-07T00:00:00+00:00"}};
}

QVariantMap firstBook(const QVariantMap &archive) {
    return archive.value("worldBooks").toList().first().toMap();
}

QVariantMap firstEntry(const QVariantMap &archive) {
    return firstBook(archive).value("entries").toList().first().toMap();
}
QVariantMap entryAt(const QVariantMap &archive, int book, int entry) {
    return archive.value("worldBooks").toList()[book].toMap().value("entries").toList()[entry].toMap();
}
QVariantMap withoutEntry(QVariantMap archive, int book, int entry) {
    auto books = archive.value("worldBooks").toList();
    auto selected = books[book].toMap();
    auto entries = selected.value("entries").toList();
    entries.removeAt(entry); selected["entries"] = entries; books[book] = selected;
    archive["worldBooks"] = books;
    return archive;
}
QVariantMap withoutBook(QVariantMap archive, int book) {
    auto books = archive.value("worldBooks").toList();
    books.removeAt(book); archive["worldBooks"] = books;
    return archive;
}

QVariantMap withFields(QVariantMap archive, const QString &title, const QString &content,
                       const QVariantList &keywords, bool enabled = true) {
    auto books = archive.value("worldBooks").toList();
    auto book = books.first().toMap();
    auto entries = book.value("entries").toList();
    auto entry = entries.first().toMap();
    book["name"] = title;
    entry["content"] = content;
    entry["keywords"] = keywords;
    entry["enabled"] = enabled;
    entries[0] = entry;
    book["entries"] = entries;
    books[0] = book;
    archive["worldBooks"] = books;
    return archive;
}

QVariantMap withAdvancedRules(QVariantMap archive, const QVariantList &secondaryKeywords,
                              const QString &logic, bool sensitive, int bookIndex = 0,
                              int entryIndex = 0) {
    auto books = archive.value("worldBooks").toList();
    auto book = books[bookIndex].toMap();
    auto entries = book.value("entries").toList();
    auto entry = entries[entryIndex].toMap();
    entry["secondaryKeywords"] = secondaryKeywords;
    entry["selectiveLogic"] = logic;
    entry["caseSensitive"] = sensitive;
    entries[entryIndex] = entry;
    book["entries"] = entries;
    books[bookIndex] = book;
    archive["worldBooks"] = books;
    return archive;
}

QVariantMap withPriority(QVariantMap archive, const QVariant &priority, int bookIndex = 0,
                         int entryIndex = 0) {
    auto books = archive.value("worldBooks").toList();
    auto book = books[bookIndex].toMap();
    auto entries = book.value("entries").toList();
    auto entry = entries[entryIndex].toMap();
    if (priority.isValid()) entry["priority"] = priority;
    else entry.remove("priority");
    entries[entryIndex] = entry;
    book["entries"] = entries;
    books[bookIndex] = book;
    archive["worldBooks"] = books;
    return archive;
}

// Invalid values remove the key, as an archive written before the field existed.
QVariantMap withBookSettings(QVariantMap archive, const QVariantMap &settings, int bookIndex = 0) {
    auto books = archive.value("worldBooks").toList();
    auto book = books[bookIndex].toMap();
    for (auto it = settings.cbegin(); it != settings.cend(); ++it) {
        if (it.value().isValid()) book[it.key()] = it.value();
        else book.remove(it.key());
    }
    books[bookIndex] = book;
    archive["worldBooks"] = books;
    return archive;
}

// The entry's own scan depth and budget. An invalid QVariant removes the key,
// as an entry written before the field existed; null means "follow the book".
QVariantMap withEntrySettings(QVariantMap archive, const QVariantMap &settings, int bookIndex = 0,
                              int entryIndex = 0) {
    auto books = archive.value("worldBooks").toList();
    auto book = books[bookIndex].toMap();
    auto entries = book.value("entries").toList();
    auto entry = entries[entryIndex].toMap();
    for (auto it = settings.cbegin(); it != settings.cend(); ++it) {
        if (it.value().isValid()) entry[it.key()] = it.value();
        else entry.remove(it.key());
    }
    entries[entryIndex] = entry;
    book["entries"] = entries;
    books[bookIndex] = book;
    archive["worldBooks"] = books;
    return archive;
}
QVariant jsonNull() { return QVariant::fromValue(nullptr); }
bool isJsonNull(const QVariant &value) { return value.metaType().id() == QMetaType::Nullptr; }

// Successful archive:put receipts use the store's explicit-null representation.
// Keep snapshot() raw: legacy GETs and malformed receipt tests must not be fixed
// implicitly by the fixture.
QVariantMap storedEntrySettings(QVariantMap archive) {
    auto books = archive.value("worldBooks").toList();
    for (int b = 0; b < books.size(); ++b) {
        auto book = books[b].toMap();
        auto entries = book.value("entries").toList();
        for (int e = 0; e < entries.size(); ++e) {
            auto entry = entries[e].toMap();
            for (const auto &key : {"scanDepth", "tokenBudget"})
                if (!entry.contains(key)) entry[key] = jsonNull();
            entries[e] = entry;
        }
        book["entries"] = entries; books[b] = book;
    }
    archive["worldBooks"] = books;
    return archive;
}

// Only injection-focused cases request storage defaults here; old fixtures
// deliberately keep their legacy sparse forms and expectations unchanged.
QVariantMap storedInsertionSettings(QVariantMap archive) {
    archive = storedEntrySettings(archive);
    auto books = archive.value("worldBooks").toList();
    for (int b = 0; b < books.size(); ++b) {
        auto book = books[b].toMap(); auto entries = book.value("entries").toList();
        for (int e = 0; e < entries.size(); ++e) {
            auto entry = entries[e].toMap();
            if (!entry.contains("position")) entry["position"] = "before_char";
            if (!entry.contains("depth")) entry["depth"] = 0;
            if (!entry.contains("role")) entry["role"] = "system";
            entries[e] = entry;
        }
        book["entries"] = entries; books[b] = book;
    }
    archive["worldBooks"] = books;
    return archive;
}

QVariantMap worldbookDiagnostic(const QString &code, int revision = 37, const QString &request = "turn-regex-1",
                                  int book = 0, int entry = 0, const QString &bookId = "book-primary",
                                  const QString &entryId = "entry-primary", const QString &persona = "persona-A") {
    return {{"persona_id", persona}, {"revision", revision}, {"request_id", request}, {"book_index", book},
        {"entry_index", entry}, {"book_id", bookId}, {"entry_id", entryId}, {"code", code}};
}
QVariantMap withWorldbookDiagnostics(QVariantMap result, const QVariantList &entries = {},
                                     const QString &request = "turn-regex-1", int truncated = 0,
                                     const QString &persona = "persona-A") {
    result["persona_id"] = persona;
    result["world_book_diagnostics"] = QVariantMap{{"persona_id", persona}, {"revision", result.value("revision")},
        {"request_id", request}, {"entries", entries}, {"truncated", truncated}};
    return result;
}
QByteArray json(const QVariantMap &map) {
    return QJsonDocument(QJsonObject::fromVariantMap(map)).toJson(QJsonDocument::Compact);
}

// The backend review that rides beside an archive read: the card in
// existingArchive() holds the system-prompt switch.
QVariantMap authorReview(bool systemEnabled, const QVariantList &systemFlags = {},
                         const QString &cardId = "character-keep") {
    return {{"card_id", cardId},
            {"system", QVariantMap{{"text", "A hidden imported prompt"},
                                   {"flags", systemFlags},
                                   {"enabled", systemEnabled},
                                   {"effective", systemEnabled && systemFlags.isEmpty()}}},
            {"post_history", QVariantMap{{"text", ""},
                                         {"flags", QVariantList{}},
                                         {"enabled", false},
                                         {"effective", false}}}};
}

QVariantMap withSystemSwitch(QVariantMap archive, bool enabled) {
    auto characters = archive.value("characters").toList();
    auto character = characters.first().toMap();
    character["useImportedSystemPrompt"] = enabled;
    characters[0] = character;
    archive["characters"] = characters;
    return archive;
}

QVariantMap reviewed(QVariantMap result, const QVariantMap &review) {
    result["author_prompts"] = review;
    return result;
}

struct Request {
    QString id;
    QString command;
    QVariantMap payload;
};

struct Harness {
    QList<Request> requests;
    int nextId = 0;
    bool dispatchEnabled = true;
    ArchiveEditor editor;

    Harness()
        : editor([this](const QString &command, const QVariantMap &payload) {
              const QString id = dispatchEnabled ? QString("request-%1").arg(++nextId) : QString{};
              requests.append({id, command, payload});
              return id;
          }) {}

    void connectExisting(int revision = 37) {
        connectArchive(existingArchive(), revision);
    }

    void connectArchive(const QVariantMap &archive, int revision = 37) {
        editor.setSession(true, 1, "persona-A");
        const auto request = requests.last();
        editor.receive(request.id, request.command, snapshot(archive, revision), 1);
    }
    QString bookKey(int index) const { return editor.bookRows()[index].toMap().value("key").toString(); }
    QString entryKey(int index) const { return editor.entryRows()[index].toMap().value("key").toString(); }
    int puts() const {
        int count = 0;
        for (const auto &request : requests) if (request.command == "archive:put") ++count;
        return count;
    }

    void connectReviewed(bool systemEnabled, const QVariantMap &review, int revision = 37) {
        editor.setSession(true, 1, "persona-A");
        const auto request = requests.last();
        editor.receive(request.id, request.command,
                       reviewed(snapshot(withSystemSwitch(existingArchive(), systemEnabled), revision), review),
                       1);
    }

    QString authorStatus() const { return editor.authorPromptFeedback().value("status").toString(); }
    QString authorText() const { return editor.authorPromptFeedback().value("text").toString(); }

    void makeDraft() {
        editor.setTitle("Draft book");
        editor.setKeywords("draft, companion");
        editor.setContent("Draft content");
    }
};

} // namespace

class ArchiveEditorTest : public QObject {
    Q_OBJECT

  private slots:
    void insertionPositionsAndImplicitDefaults_data() {
        QTest::addColumn<QString>("position"); QTest::addColumn<bool>("implicit");
        QTest::newRow("before-explicit") << "before_char" << false;
        QTest::newRow("after-explicit") << "after_char" << false;
        QTest::newRow("depth-explicit") << "at_depth" << false;
        QTest::newRow("all-implicit-defaults") << "before_char" << true;
    }
    void insertionPositionsAndImplicitDefaults() {
        QFETCH(QString, position); QFETCH(bool, implicit);
        const auto archive = withEntrySettings(existingArchive(), implicit
            ? QVariantMap{{"position", QVariant{}}, {"depth", QVariant{}}, {"role", QVariant{}}}
            : QVariantMap{{"position", position}, {"depth", 2}, {"role", "assistant"}});
        Harness h; h.connectArchive(archive);
        QCOMPARE(h.editor.insertionPosition().toString(), position);
        QCOMPARE(h.editor.insertionDepth().toInt(), implicit ? 0 : 2);
        QCOMPARE(h.editor.insertionRole().toString(), implicit ? QString("system") : QString("assistant"));
        for (const auto &key : {"position", "depth", "role"}) {
            QVERIFY(h.editor.insertionConfirmed(key));
            QCOMPARE(h.editor.insertionStates().value(key).toMap().value("present").toBool(), !implicit);
            QCOMPARE(h.editor.insertionEditable(key), QString(key) == "position" || position == "at_depth");
        }
        const QString positionText = position == "at_depth" ? "对话中 · 按深度插入"
            : position == "after_char" ? "系统提示 · 角色状态之后" : "系统提示 · 身份段之后";
        QCOMPARE(h.editor.insertionStates().value("position").toMap().value("text").toString(), positionText);
        QCOMPARE(h.editor.insertionEffectiveText(), position == "at_depth"
            ? QString("对话中按深度插入 · 深度 2 · 助手") : positionText + "（深度、角色此时不生效）");
        const auto advanced = h.editor.advancedFields();
        h.editor.setContent("Only content changed"); h.editor.save();
        const auto sent = firstEntry(h.requests.last().payload.value("archive").toMap());
        for (const auto &key : {"position", "depth", "role"}) {
            QCOMPARE(sent.contains(key), firstEntry(archive).contains(key));
            QCOMPARE(sent.value(key), firstEntry(archive).value(key));
        }
        QCOMPARE(h.editor.advancedFields(), advanced);
        QCOMPARE(h.puts(), 1);
    }
    void insertionScalarSaveBindsTheWholeGroup_data() {
        QTest::addColumn<QString>("edited"); QTest::addColumn<bool>("implicit");
        QTest::newRow("position-only") << "position" << false;
        QTest::newRow("depth-only") << "depth" << false;
        QTest::newRow("role-only") << "role" << false;
        QTest::newRow("position-materializes-only-edited-key") << "position" << true;
    }
    void insertionScalarSaveBindsTheWholeGroup() {
        QFETCH(QString, edited); QFETCH(bool, implicit);
        const auto archive = withEntrySettings(existingArchive(), implicit
            ? QVariantMap{{"position", QVariant{}}, {"depth", QVariant{}}, {"role", QVariant{}}}
            : QVariantMap{{"position", "at_depth"}, {"depth", 2}, {"role", "assistant"}});
        Harness h; h.connectArchive(archive);
        if (edited == "position") h.editor.setInsertionPosition(implicit ? "at_depth" : "after_char");
        if (edited == "depth") h.editor.setInsertionDepth(0);
        if (edited == "role") h.editor.setInsertionRole("user");
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); h.editor.save();
        const auto put = h.requests.last(); const auto submitted = put.payload.value("archive").toMap();
        const auto entry = firstEntry(submitted);
        for (const auto &key : {"position", "depth", "role"})
            if (QString(key) != edited) {
                QCOMPARE(entry.contains(key), firstEntry(archive).contains(key));
                QCOMPARE(entry.value(key), firstEntry(archive).value(key));
            }
        h.editor.receive("foreign", put.command, snapshot(storedInsertionSettings(submitted), 38), 1);
        QCOMPARE(h.editor.status(), QString("saving"));
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(submitted), 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.revision(), 38); QCOMPARE(h.puts(), 1);
    }
    void insertionWholeGroupReceiptRejectsFaults_data() {
        QTest::addColumn<QString>("edited"); QTest::addColumn<QString>("fault");
        for (const auto *edited : {"position", "depth", "role"})
            for (const auto *fault : {"position", "depth", "role", "missing-position", "missing-depth", "missing-role", "depth-string", "depth-bool", "depth-fraction", "role-number", "revision"})
                QTest::newRow((QByteArray(edited) + "-" + fault).constData()) << QString(edited) << QString(fault);
    }
    void insertionWholeGroupReceiptRejectsFaults() {
        QFETCH(QString, edited); QFETCH(QString, fault);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", 2}, {"role", "assistant"}}));
        if (edited == "position") h.editor.setInsertionPosition("after_char");
        if (edited == "depth") h.editor.setInsertionDepth(0);
        if (edited == "role") h.editor.setInsertionRole("user");
        const auto expectedText = h.editor.insertionEffectiveText(); h.editor.save();
        const auto put = h.requests.last(); auto receipt = storedInsertionSettings(put.payload.value("archive").toMap());
        if (fault == "position") receipt = withEntrySettings(receipt, {{"position", "before_char"}});
        if (fault == "depth") receipt = withEntrySettings(receipt, {{"depth", 9}});
        if (fault == "role") receipt = withEntrySettings(receipt, {{"role", "system"}});
        if (fault.startsWith("missing-")) receipt = withEntrySettings(receipt, {{fault.mid(8), QVariant{}}});
        if (fault == "depth-string") receipt = withEntrySettings(receipt, {{"depth", QString::number(h.editor.insertionDepth().toInt())}});
        if (fault == "depth-bool") receipt = withEntrySettings(receipt, {{"depth", false}});
        if (fault == "depth-fraction") receipt = withEntrySettings(receipt, {{"depth", .5}});
        if (fault == "role-number") receipt = withEntrySettings(receipt, {{"role", 1}});
        h.editor.receive(put.id, put.command, snapshot(receipt, fault == "revision" ? 39 : 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.insertionEffectiveText(), expectedText); QCOMPARE(h.puts(), 1);
    }
    void insertionImplicitReceiptRequiresAllDefaults_data() {
        QTest::addColumn<QString>("missing");
        QTest::newRow("missing-default-depth") << "depth";
        QTest::newRow("missing-default-role") << "role";
    }
    void insertionImplicitReceiptRequiresAllDefaults() {
        QFETCH(QString, missing);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"position", QVariant{}}, {"depth", QVariant{}}, {"role", QVariant{}}}));
        h.editor.setInsertionPosition("at_depth"); h.editor.save(); const auto put = h.requests.last();
        auto receipt = storedInsertionSettings(put.payload.value("archive").toMap());
        receipt = withEntrySettings(receipt, {{missing, QVariant{}}});
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.revision(), 37);
    }
    void insertionIndependentReadMergeAndDependencyNotice_data() {
        QTest::addColumn<QString>("local"); QTest::addColumn<QString>("authority");
        QTest::newRow("local-depth-authority-position") << "depth" << "position";
        QTest::newRow("local-role-authority-position") << "role" << "position";
        QTest::newRow("local-position-authority-depth") << "position" << "depth";
        QTest::newRow("local-position-authority-role") << "position" << "role";
        QTest::newRow("local-content-authority-all") << "content" << "all";
    }
    void insertionIndependentReadMergeAndDependencyNotice() {
        QFETCH(QString, local); QFETCH(QString, authority);
        const auto initial = withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", 2}, {"role", "system"}});
        Harness h; h.connectArchive(initial); h.editor.load(); const auto read = h.requests.last();
        if (local == "depth") h.editor.setInsertionDepth(5);
        if (local == "role") h.editor.setInsertionRole("assistant");
        if (local == "position") h.editor.setInsertionPosition("before_char");
        if (local == "content") h.editor.setContent("Local content");
        auto archive = initial;
        if (authority == "position" || authority == "all") archive = withEntrySettings(archive, {{"position", authority == "position" ? "before_char" : "after_char"}});
        if (authority == "depth" || authority == "all") archive = withEntrySettings(archive, {{"depth", 9}});
        if (authority == "role" || authority == "all") archive = withEntrySettings(archive, {{"role", "user"}});
        h.editor.receive(read.id, read.command, snapshot(archive, 38), 1);
        QCOMPARE(h.editor.insertionPosition().toString(), local == "position" || authority == "position" ? QString("before_char") : authority == "all" ? QString("after_char") : QString("at_depth"));
        QCOMPARE(h.editor.insertionDepth().toInt(), local == "depth" ? 5 : authority == "depth" || authority == "all" ? 9 : 2);
        QCOMPARE(h.editor.insertionRole().toString(), local == "role" ? QString("assistant") : authority == "role" || authority == "all" ? QString("user") : QString("system"));
        QCOMPARE(!h.editor.insertionDependencyNotice().isEmpty(), local != "content");
        QVERIFY(h.editor.canSave());
        if (local != "content") {
            const auto notice = h.editor.insertionDependencyNotice();
            QVERIFY(!notice.contains("（默认）"));
            h.editor.setContent("Unrelated later edit"); QCOMPARE(h.editor.insertionDependencyNotice(), notice);
            h.editor.save(); const auto put = h.requests.last();
            h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(put.payload.value("archive").toMap()), 39), 1);
            QVERIFY(h.editor.insertionDependencyNotice().isEmpty()); QVERIFY(!h.editor.dirty());
        }
    }
    void insertionDependencyNoticeClearsOnGroupEditOrDiscard_data() {
        QTest::addColumn<bool>("discard"); QTest::newRow("edit-clears-notice") << false; QTest::newRow("discard-clears-notice") << true;
    }
    void insertionDependencyNoticeClearsOnGroupEditOrDiscard() {
        QFETCH(bool, discard);
        const auto initial = withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", 2}, {"role", "user"}});
        Harness h; h.connectArchive(initial); h.editor.load(); auto read = h.requests.last();
        h.editor.setInsertionDepth(4); const auto authority = withEntrySettings(initial, {{"position", "after_char"}});
        h.editor.receive(read.id, read.command, snapshot(authority, 38), 1);
        QVERIFY(h.editor.insertionDependencyNotice().contains("在此位置下不生效"));
        if (discard) {
            h.editor.reloadDiscardingDraft(); read = h.requests.last(); h.editor.receive(read.id, read.command, snapshot(authority, 38), 1);
            QCOMPARE(h.editor.insertionDepth().toInt(), 2); QVERIFY(!h.editor.dirty());
        } else h.editor.setInsertionPosition("at_depth");
        QVERIFY(h.editor.insertionDependencyNotice().isEmpty());
    }
    void insertionImplicitLaterRevertStaysDraftAfterNormalization() {
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", QVariant{}}, {"role", QVariant{}}}));
        h.editor.setInsertionDepth(5); h.editor.save(); const auto put = h.requests.last();
        h.editor.setInsertionDepth(0);
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(put.payload.value("archive").toMap()), 38), 1);
        QCOMPARE(h.editor.insertionDepth().toInt(), 0); QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave());
        h.editor.save(); const auto entry = firstEntry(h.requests.last().payload.value("archive").toMap());
        QVERIFY(entry.contains("depth")); QCOMPARE(entry.value("depth").toInt(), 0);
        QCOMPARE(entry.value("role").toString(), QString("system"));
    }
    void insertionAuthorityNormalizationDoesNotCreateANotice() {
        const auto initial = withEntrySettings(existingArchive(), {{"position", QVariant{}}, {"depth", QVariant{}}, {"role", QVariant{}}});
        Harness h; h.connectArchive(initial); h.editor.load(); const auto read = h.requests.last();
        h.editor.setContent("Keep local content");
        h.editor.receive(read.id, read.command, snapshot(storedInsertionSettings(initial), 38), 1);
        QVERIFY(h.editor.insertionDependencyNotice().isEmpty());
        QCOMPARE(h.editor.insertionDepth().toInt(), 0); QCOMPARE(h.editor.insertionRole().toString(), QString("system"));
        h.editor.save(); const auto sent = firstEntry(h.requests.last().payload.value("archive").toMap());
        QCOMPARE(sent.value("position").toString(), QString("before_char")); QCOMPARE(sent.value("depth").toInt(), 0);
    }
    void insertionDuplicateIdReceiptRetainsTheSelectedOccurrence() {
        auto archive = withEntrySettings(existingArchive(), {{"position", "before_char"}, {"depth", QVariant{}}, {"role", QVariant{}}});
        archive = withEntrySettings(archive, {{"id", "entry-primary"}}, 0, 1);
        Harness h; h.connectArchive(archive); const auto selected = h.editor.selectedEntryKey();
        h.editor.setInsertionPosition("at_depth"); h.editor.save(); const auto put = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(put.payload.value("archive").toMap()), 38), 1);
        QCOMPARE(h.editor.selectedEntryKey(), selected); QCOMPARE(h.editor.status(), QString("saved"));
        QCOMPARE(h.editor.insertionPosition().toString(), QString("at_depth")); QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.advancedFields().value("entry").toMap().value("depth").toInt(), 0);
    }
    void insertionUneditedSaveReceiptStillReportsDependencyChanges_data() {
        QTest::addColumn<bool>("positionDraft");
        QTest::newRow("content-save-then-depth-draft") << false;
        QTest::newRow("content-save-then-position-draft") << true;
    }
    void insertionUneditedSaveReceiptStillReportsDependencyChanges() {
        QFETCH(bool, positionDraft);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", 2}, {"role", "user"}}));
        h.editor.setContent("Save only this content"); h.editor.save(); const auto put = h.requests.last();
        if (positionDraft) h.editor.setInsertionPosition("before_char"); else h.editor.setInsertionDepth(5);
        auto authority = storedInsertionSettings(put.payload.value("archive").toMap());
        authority = withEntrySettings(authority, positionDraft ? QVariantMap{{"depth", 9}} : QVariantMap{{"position", "after_char"}});
        h.editor.receive(put.id, put.command, snapshot(authority, 38), 1);
        QCOMPARE(h.editor.revision(), 38); QVERIFY(h.editor.dirty()); QVERIFY(!h.editor.insertionDependencyNotice().isEmpty());
        QCOMPARE(h.editor.insertionPosition().toString(), positionDraft ? QString("before_char") : QString("after_char"));
        QCOMPARE(h.editor.insertionDepth().toInt(), positionDraft ? 9 : 5);
    }
    void insertionLaterEditsSurviveSave_data() {
        QTest::addColumn<QString>("later");
        QTest::newRow("later-depth") << "depth";
        QTest::newRow("later-role") << "role";
        QTest::newRow("later-position") << "position";
        QTest::newRow("reverted-to-old-depth") << "revert";
        QTest::newRow("inactive-depth-and-role-stay-dirty") << "inactive";
    }
    void insertionLaterEditsSurviveSave() {
        QFETCH(QString, later);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"position", "at_depth"}, {"depth", 2}, {"role", "system"}}));
        h.editor.setInsertionDepth(5); h.editor.save(); const auto put = h.requests.last();
        if (later == "depth") h.editor.setInsertionDepth(9);
        if (later == "revert") h.editor.setInsertionDepth(2);
        if (later == "role") h.editor.setInsertionRole("assistant");
        if (later == "position") h.editor.setInsertionPosition("after_char");
        if (later == "inactive") {
            h.editor.setInsertionDepth(7); h.editor.setInsertionRole("user"); h.editor.setInsertionPosition("before_char");
            h.editor.setInsertionDepth(8); h.editor.setInsertionRole("assistant");
        }
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(put.payload.value("archive").toMap()), 38), 1);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.insertionDepth().toInt(), later == "depth" ? 9 : later == "revert" ? 2 : later == "inactive" ? 7 : 5);
        if (later == "inactive") {
            QCOMPARE(h.editor.insertionRole().toString(), QString("user"));
            QVERIFY(!h.editor.insertionEditable("depth") && !h.editor.insertionEditable("role"));
        }
        h.editor.save(); const auto next = h.requests.last();
        QCOMPARE(next.payload.value("expected_revision").toInt(), 38);
        const auto entry = firstEntry(next.payload.value("archive").toMap());
        QCOMPARE(entry.value("depth").toInt(), h.editor.insertionDepth().toInt());
        QCOMPARE(entry.value("position"), h.editor.insertionPosition()); QCOMPARE(entry.value("role"), h.editor.insertionRole());
        h.editor.receive(next.id, next.command, snapshot(storedInsertionSettings(next.payload.value("archive").toMap()), 39), 1);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.editor.status(), QString("saved"));
    }
    void insertionMalformedAndLegacyValuesStayReadOnly_data() {
        QTest::addColumn<QString>("key"); QTest::addColumn<QVariant>("value"); QTest::addColumn<bool>("confirmed");
        QTest::addColumn<QString>("position");
        QTest::newRow("legacy-depth-201") << "depth" << QVariant(201) << true << "at_depth";
        QTest::newRow("legacy-depth-large") << "depth" << QVariant(qint64(4294967297LL)) << true << "at_depth";
        QTest::newRow("unknown-position") << "position" << QVariant("future") << false << "at_depth";
        QTest::newRow("numeric-position") << "position" << QVariant(1) << false << "at_depth";
        QTest::newRow("null-position") << "position" << jsonNull() << false << "at_depth";
        QTest::newRow("string-depth") << "depth" << QVariant("2") << false << "at_depth";
        QTest::newRow("bool-depth") << "depth" << QVariant(true) << false << "at_depth";
        QTest::newRow("negative-depth") << "depth" << QVariant(-1) << false << "at_depth";
        QTest::newRow("fractional-depth") << "depth" << QVariant(1.5) << false << "at_depth";
        QTest::newRow("null-depth") << "depth" << jsonNull() << false << "at_depth";
        QTest::newRow("unknown-role") << "role" << QVariant("future") << false << "at_depth";
        QTest::newRow("bool-role") << "role" << QVariant(false) << false << "at_depth";
        QTest::newRow("unconfirmed-depth-before-default-position") << "depth" << QVariant("2") << false << "before_char";
    }
    void insertionMalformedAndLegacyValuesStayReadOnly() {
        QFETCH(QString, key); QFETCH(QVariant, value); QFETCH(bool, confirmed); QFETCH(QString, position);
        const auto archive = withEntrySettings(existingArchive(), {{"position", position}, {key, value}});
        Harness h; h.connectArchive(archive); QVERIFY(h.editor.initialized());
        QCOMPARE(h.editor.insertionConfirmed(key), confirmed); QVERIFY(!h.editor.insertionEditable(key));
        if (position == "before_char")
            QCOMPARE(h.editor.insertionEffectiveText(), QString("插入方式未确认 · 系统提示 · 身份段之后（深度或角色未确认）"));
        const auto raw = h.editor.advancedFields().value("entry").toMap().value(key);
        h.editor.setInsertionDepth(3); h.editor.setInsertionRole("system"); h.editor.setInsertionPosition("after_char");
        if (!confirmed) QVERIFY(!h.editor.canSave());
        h.editor.reloadDiscardingDraft(); const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(archive, 38), 1);
        h.editor.setContent("Preserve original metadata"); QVERIFY(h.editor.canSave()); h.editor.save();
        QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap()).value(key), raw);
        if (confirmed) QVERIFY(h.editor.insertionStates().value("depth").toMap().value("readonlyReason").toString().contains("原值 " + h.editor.insertionDepth().toString()));
    }
    void insertionStrictSettersAndInactiveGating() {
        Harness h; h.connectExisting();
        h.editor.setInsertionDepth(3); h.editor.setInsertionRole("assistant"); QVERIFY(!h.editor.dirty());
        h.editor.setInsertionPosition("at_depth");
        for (const auto &value : {QVariant(true), QVariant("3"), QVariant(-1), QVariant(1.5), QVariant(201)}) h.editor.setInsertionDepth(value);
        QCOMPARE(h.editor.insertionDepth().toInt(), 2);
        h.editor.setInsertionRole(1); h.editor.setInsertionRole("future"); QCOMPARE(h.editor.insertionRole().toString(), QString("user"));
        h.editor.setInsertionPosition(2); h.editor.setInsertionPosition("future"); QCOMPARE(h.editor.insertionPosition().toString(), QString("at_depth"));
        h.editor.setInsertionDepth(200); QCOMPARE(h.editor.insertionDepth().toInt(), 200);
        h.editor.setInsertionDepth(0); QCOMPARE(h.editor.insertionDepth().toInt(), 0);
        h.editor.setInsertionRole("assistant"); h.editor.setInsertionPosition("after_char");
        QVERIFY(h.editor.canSave()); QCOMPARE(h.editor.insertionDepth().toInt(), 0); QCOMPARE(h.editor.insertionRole().toString(), QString("assistant"));
        h.editor.setInsertionPosition("at_depth"); QCOMPARE(h.editor.insertionDepth().toInt(), 0); QCOMPARE(h.editor.insertionRole().toString(), QString("assistant"));
    }
    void insertionReadFailureOnlyBlocksAnEditedGroup_data() {
        QTest::addColumn<bool>("edited"); QTest::newRow("untouched-group") << false; QTest::newRow("edited-group") << true;
    }
    void insertionReadFailureOnlyBlocksAnEditedGroup() {
        QFETCH(bool, edited); Harness h; h.connectExisting();
        if (edited) h.editor.setInsertionPosition("at_depth");
        h.editor.setContent("Content draft"); h.editor.reloadDiscardingDraft(); const auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        for (const auto &key : {"position", "depth", "role"}) QVERIFY(!h.editor.insertionConfirmed(key) && !h.editor.insertionEditable(key));
        QCOMPARE(h.editor.canSave(), !edited);
        if (edited) QCOMPARE(h.editor.saveBlocker(), QString("插入方式尚未确认，请重新读取档案；不会使用默认值覆盖。"));
        h.editor.save(); QCOMPARE(h.puts(), edited ? 0 : 1);
    }
    void insertionBlockerFollowsEntryScanningBlocker() {
        Harness h; h.connectExisting(); h.editor.setInsertionPosition("at_depth"); h.editor.setEntryScanDepth(4);
        h.editor.reloadDiscardingDraft(); const auto read = h.requests.last(); h.editor.failed(read.id, "deadline", 1);
        QCOMPARE(h.editor.saveBlocker(), QString("条目扫描设置尚未确认，请重新读取档案；不会使用默认值覆盖。"));
    }
    void insertionMissingSaveTargetUsesOrphanDraft_data() {
        QTest::addColumn<bool>("book"); QTest::addColumn<QString>("extra");
        QTest::newRow("entry-disappeared") << false << "";
        QTest::newRow("book-disappeared") << true << "";
        QTest::newRow("entry-disappeared-with-rule-edit") << false << "rule";
    }
    void insertionMissingSaveTargetUsesOrphanDraft() {
        QFETCH(bool, book); QFETCH(QString, extra); Harness h; h.connectExisting(); const auto selected = h.editor.selectedEntryKey();
        h.editor.setInsertionPosition("at_depth"); h.editor.setInsertionDepth(4);
        if (extra == "rule") h.editor.setKeywords("insertion, orphan");
        h.editor.save(); const auto put = h.requests.last();
        const auto submitted = storedInsertionSettings(put.payload.value("archive").toMap());
        const auto receipt = book ? withoutBook(submitted, 0) : withoutEntry(submitted, 0, 0);
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.editor.status(), QString("orphan")); QVERIFY(h.editor.writesBlocked()); QVERIFY(h.editor.dirty()); QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.selectedEntryKey(), selected); QCOMPARE(h.editor.insertionDepth().toInt(), 4); QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.insertionPosition().toString(), QString("at_depth")); QCOMPARE(h.editor.insertionRole().toString(), QString("user"));
        if (extra == "rule") QCOMPARE(h.editor.keywordItems(), (QVariantList{"insertion", "orphan"}));
        h.editor.save(); QCOMPARE(h.puts(), 1);
    }
    void insertionMissingSaveTargetKeepsOtherReceiptsStrict_data() {
        QTest::addColumn<QString>("extra");
        QTest::newRow("entry-disappeared-with-priority-edit") << "priority";
        QTest::newRow("entry-disappeared-with-scan-edit") << "scan";
        QTest::newRow("book-disappeared-with-book-edit") << "book";
        QTest::newRow("new-entry-disappeared") << "new";
    }
    void insertionMissingSaveTargetKeepsOtherReceiptsStrict() {
        QFETCH(QString, extra); Harness h; h.connectExisting();
        if (extra == "new") h.editor.newEntry();
        const auto selected = h.editor.selectedEntryKey();
        h.editor.setContent("Draft retained after missing-target receipt");
        h.editor.setInsertionPosition("at_depth"); h.editor.setInsertionDepth(4);
        const auto role = h.editor.insertionRole();
        if (extra == "priority") h.editor.setPriority(10);
        if (extra == "scan") h.editor.setEntryScanDepth(6);
        if (extra == "book") h.editor.setScanDepth(11);
        QVERIFY(h.editor.canSave()); h.editor.save(); const auto put = h.requests.last();
        const auto submitted = storedInsertionSettings(put.payload.value("archive").toMap());
        const auto receipt = extra == "book" ? withoutBook(submitted, 0) : withoutEntry(submitted, 0, extra == "new" ? 2 : 0);
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.editor.status(), QString("error"));
        QCOMPARE(h.editor.statusText(), QString("保存回执的匹配规则、条目、优先级、书设置或条目扫描设置不一致，草稿保留，请重新读取确认。"));
        QCOMPARE(h.editor.revision(), 37); QVERIFY(!h.editor.writesBlocked()); QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.selectedEntryKey(), selected);
        QCOMPARE(h.editor.insertionPosition().toString(), QString("at_depth")); QCOMPARE(h.editor.insertionDepth().toInt(), 4);
        QCOMPARE(h.editor.insertionRole(), role);
        QCOMPARE(h.editor.content(), QString("Draft retained after missing-target receipt"));
        if (extra == "priority") QCOMPARE(h.editor.priority().toInt(), 10);
        if (extra == "scan") QCOMPARE(h.editor.entryScanDepth().toInt(), 6);
        if (extra == "book") QCOMPARE(h.editor.scanDepth().toInt(), 11);
        if (extra == "new") QVERIFY(h.editor.newLocal());
        QCOMPARE(h.puts(), 1);
    }
    void insertionNewEntryTemplateAndPreSaveEdits_data() {
        QTest::addColumn<bool>("edited"); QTest::newRow("template-unchanged") << false; QTest::newRow("new-entry-edited") << true;
    }
    void insertionNewEntryTemplateAndPreSaveEdits() {
        QFETCH(bool, edited); Harness h; h.connectExisting(); h.editor.newEntry(); h.editor.setContent("New entry content");
        QCOMPARE(h.editor.insertionPosition().toString(), QString("before_char"));
        if (edited) { h.editor.setInsertionPosition("at_depth"); h.editor.setInsertionDepth(1); h.editor.setInsertionRole("assistant"); }
        h.editor.save(); const auto put = h.requests.last(); const auto submitted = put.payload.value("archive").toMap();
        const auto entry = entryAt(submitted, 0, 2);
        QCOMPARE(entry.value("position").toString(), edited ? QString("at_depth") : QString("before_char"));
        QCOMPARE(entry.contains("depth"), edited); QCOMPARE(entry.contains("role"), edited);
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(submitted), 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.newLocal()); QVERIFY(!h.editor.dirty());
    }
    void insertionNavigationAndScopeKeepIdentityBinding() {
        Harness h; h.connectExisting(); const auto original = h.editor.selectedEntryKey(), sibling = h.entryKey(1);
        h.editor.setInsertionPosition("at_depth"); h.editor.selectEntry(sibling); QVERIFY(!h.editor.navigationPrompt().isEmpty());
        h.editor.resolveNavigation("cancel"); QCOMPARE(h.editor.selectedEntryKey(), original);
        h.editor.selectEntry(sibling); h.editor.resolveNavigation("discard"); QCOMPARE(h.editor.selectedEntryKey(), sibling);
        QVERIFY(!h.editor.dirty()); h.editor.selectEntry(original); h.editor.setInsertionPosition("at_depth"); h.editor.save(); const auto put = h.requests.last();
        h.editor.setSession(true, 2, "persona-B"); const auto read = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(storedInsertionSettings(put.payload.value("archive").toMap()), 38), 1);
        QVERIFY(!h.editor.initialized());
        h.editor.receive(read.id, read.command, snapshot(existingArchive(), 4), 2);
        QCOMPARE(h.editor.insertionPosition().toString(), QString("after_char")); QVERIFY(!h.editor.dirty()); QVERIFY(h.editor.insertionDependencyNotice().isEmpty());
    }
    void regexArrayViewsPreserveOpaqueItems_data() {
        QTest::addColumn<QVariantList>("items"); QTest::addColumn<bool>("regex"); QTest::addColumn<bool>("editable");
        QTest::newRow("literal-ascii-comma") << QVariantList{"a,b"} << false << false;
        QTest::newRow("literal-fullwidth-comma") << QVariantList{QString::fromUtf8("你好，世界")} << false << false;
        QTest::newRow("literal-leading-space") << QVariantList{" leading"} << false << false;
        QTest::newRow("literal-trailing-space") << QVariantList{"trailing "} << false << false;
        QTest::newRow("literal-inner-tab") << QVariantList{"a\tb"} << false << true;
        QTest::newRow("regex-comma-and-edge-spaces") << QVariantList{" ID-(?:\\d{1,3}) "} << true << true;
        QTest::newRow("regex-literal-tab") << QVariantList{QString("a") + QChar('\t') + "b"} << true << true;
        QTest::newRow("regex-non-bmp") << QVariantList{QString::fromUtf8("😀+")} << true << true;
        QTest::newRow("opaque-line-feed") << QVariantList{QString("a\nb")} << true << false;
        QTest::newRow("opaque-carriage-return") << QVariantList{QString("a\rb")} << true << false;
        QTest::newRow("opaque-line-separator") << QVariantList{QString("a") + QChar(0x2028) + "b"} << true << false;
        QTest::newRow("opaque-paragraph-separator") << QVariantList{QString("a") + QChar(0x2029) + "b"} << true << false;
        QTest::newRow("opaque-vertical-tab") << QVariantList{QString("a") + QChar(0x000b) + "b"} << true << false;
        QTest::newRow("opaque-form-feed") << QVariantList{QString("a") + QChar(0x000c) + "b"} << true << false;
        QTest::newRow("opaque-next-line") << QVariantList{QString("a") + QChar(0x0085) + "b"} << true << false;
    }
    void regexArrayViewsPreserveOpaqueItems() {
        QFETCH(QVariantList, items); QFETCH(bool, regex); QFETCH(bool, editable);
        const auto archive = withEntrySettings(existingArchive(), {{"useRegex", regex}, {"keywords", items}, {"secondaryKeywords", items}});
        Harness h; h.connectArchive(archive);
        QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
        QCOMPARE(h.editor.keywordsEditable(), editable); QCOMPARE(h.editor.secondaryKeywordsEditable(), editable);
        if (!editable) {
            h.editor.setKeywords("must not replace opaque primary");
            h.editor.setSecondaryKeywords("must not replace opaque auxiliary");
            QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
            QVERIFY(!h.editor.keywordsReadonlyReason().isEmpty());
        }
        h.editor.setUseRegex(!regex); QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
        h.editor.setUseRegex(regex); QVERIFY(!h.editor.dirty());
        h.editor.setContent("Only this body changed"); h.editor.save(); QCOMPARE(h.puts(), 1);
        const auto put = h.requests.last();
        const auto expected = withFields(archive, "Original book", "Only this body changed", items);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
    }
    void regexMultilineSpecialCharactersRemainOpaque_data() {
        QTest::addColumn<QString>("key"); QTest::addColumn<int>("codePoint");
        QTest::newRow("primary-no-break-space") << "keywords" << 0x00a0;
        QTest::newRow("primary-fdd0") << "keywords" << 0xfdd0;
        QTest::newRow("primary-fdd1") << "keywords" << 0xfdd1;
        QTest::newRow("secondary-no-break-space") << "secondaryKeywords" << 0x00a0;
        QTest::newRow("secondary-fdd0") << "secondaryKeywords" << 0xfdd0;
        QTest::newRow("secondary-fdd1") << "secondaryKeywords" << 0xfdd1;
    }
    void regexMultilineSpecialCharactersRemainOpaque() {
        QFETCH(QString, key); QFETCH(int, codePoint);
        const QVariantList items{"before", QString("a") + QChar(codePoint) + "b", "after"};
        const auto archive = withEntrySettings(existingArchive(), {{"useRegex", true}, {key, items}});
        const auto primary = firstEntry(archive).value("keywords").toList();
        const auto secondary = firstEntry(archive).value("secondaryKeywords").toList();
        const QString reason = "这些模式含换行、不换行空格等特殊字符或超过 16,384 字符，无法逐行原样编辑；当前只读，保存其他字段时原样保留。";
        Harness h; h.connectArchive(archive);
        QCOMPARE(h.editor.keywordsEditable(), key != "keywords");
        QCOMPARE(h.editor.secondaryKeywordsEditable(), key != "secondaryKeywords");
        QCOMPARE(key == "keywords" ? h.editor.keywordsReadonlyReason() : h.editor.secondaryKeywordsReadonlyReason(), reason);
        if (key == "keywords") h.editor.setKeywords("replacement\nline");
        else h.editor.setSecondaryKeywords("replacement\nline");
        QCOMPARE(h.editor.keywordItems(), primary); QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 0);
        h.editor.setUseRegex(false);
        QCOMPARE(h.editor.keywordItems(), primary); QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        h.editor.setUseRegex(true);
        QCOMPARE(h.editor.keywordItems(), primary); QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        QVERIFY(!h.editor.dirty());
        QVERIFY(key == "keywords" ? !h.editor.keywordsEditable() : !h.editor.secondaryKeywordsEditable());
        h.editor.setContent("Preserve opaque multiline items"); QVERIFY(h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 1); const auto put = h.requests.last();
        const auto expected = withFields(archive, "Original book", "Preserve opaque multiline items", primary);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(expected), 38), 1);
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.keywordItems(), primary); QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        QCOMPARE(key == "keywords" ? h.editor.keywordsReadonlyReason() : h.editor.secondaryKeywordsReadonlyReason(), reason);
    }
    void literalNonbreakingSpaceDraftBecomesReadOnlyInRegex_data() {
        QTest::addColumn<QString>("key");
        QTest::newRow("primary-literal-no-break-space") << "keywords";
        QTest::newRow("secondary-literal-no-break-space") << "secondaryKeywords";
    }
    void literalNonbreakingSpaceDraftBecomesReadOnlyInRegex() {
        QFETCH(QString, key);
        const auto pattern = QString("a") + QChar(0x00a0) + "b";
        const QVariantList items{pattern};
        Harness h; h.connectExisting();
        QVERIFY(!h.editor.useRegex());
        if (key == "keywords") h.editor.setKeywords(pattern); else h.editor.setSecondaryKeywords(pattern);
        QCOMPARE(key == "keywords" ? h.editor.keywordItems() : h.editor.secondaryKeywordItems(), items);
        QVERIFY(key == "keywords" ? h.editor.keywordsEditable() : h.editor.secondaryKeywordsEditable());
        h.editor.setUseRegex(true);
        QVERIFY(key == "keywords" ? !h.editor.keywordsEditable() : !h.editor.secondaryKeywordsEditable());
        if (key == "keywords") h.editor.setKeywords("replacement"); else h.editor.setSecondaryKeywords("replacement");
        QCOMPARE(key == "keywords" ? h.editor.keywordItems() : h.editor.secondaryKeywordItems(), items);
        h.editor.setUseRegex(false);
        QVERIFY(key == "keywords" ? h.editor.keywordsEditable() : h.editor.secondaryKeywordsEditable());
        h.editor.setUseRegex(true);
        QVERIFY(key == "keywords" ? !h.editor.keywordsEditable() : !h.editor.secondaryKeywordsEditable());
        QCOMPARE(key == "keywords" ? h.editor.keywordItems() : h.editor.secondaryKeywordItems(), items);
        h.editor.setContent("Preserve the literal draft after conversion");
        QVERIFY(h.editor.canSave()); h.editor.save(); QCOMPARE(h.puts(), 1);
        const auto put = h.requests.last(); const auto submitted = put.payload.value("archive").toMap();
        QCOMPARE(firstEntry(submitted).value(key).toList(), items);
        h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(submitted), 38), 1);
        QVERIFY(!h.editor.dirty());
        QCOMPARE(key == "keywords" ? h.editor.keywordItems() : h.editor.secondaryKeywordItems(), items);
        QVERIFY(key == "keywords" ? !h.editor.keywordsEditable() : !h.editor.secondaryKeywordsEditable());
    }
    void rulesEditedBeforeAReadFailureCannotBeSaved() {
        Harness h; h.connectExisting(); h.editor.setKeywords("retained, rule draft");
        QVERIFY(h.editor.canSave());
        h.editor.reloadDiscardingDraft(); const auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        QCOMPARE(h.editor.keywordItems(), (QVariantList{"retained", "rule draft"}));
        QVERIFY(h.editor.dirty()); QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.saveBlocker(), QString("匹配规则尚未确认，请重新读取档案；不会使用默认值覆盖。"));
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void bodyOnlyEditAfterAReadFailurePreservesLegacyRuleFields() {
        const auto archive = withEntrySettings(existingArchive(), {{"useRegex", QVariant{}}, {"secondaryKeywords", QVariant{}},
            {"selectiveLogic", QVariant{}}, {"caseSensitive", QVariant{}}});
        Harness h; h.connectArchive(archive); h.editor.load(); const auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        h.editor.setContent("Only the body changes after a failed read");
        QVERIFY(h.editor.canSave()); QCOMPARE(h.editor.saveBlocker(), QString{});
        h.editor.save(); QCOMPARE(h.puts(), 1); const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        const auto expected = withFields(archive, "Original book", "Only the body changes after a failed read",
                                         firstEntry(archive).value("keywords").toList());
        QCOMPARE(json(submitted), json(expected));
        const auto entry = firstEntry(submitted);
        for (const auto &key : {"useRegex", "keywords", "secondaryKeywords", "selectiveLogic", "caseSensitive"}) {
            QCOMPARE(entry.contains(key), firstEntry(archive).contains(key));
            QCOMPARE(entry.value(key), firstEntry(archive).value(key));
        }
        h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(expected), 38), 1);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.editor.status(), QString("saved"));
    }
    void ruleSettersRemainReadOnlyAfterAReadFailureUntilConfirmedRead() {
        Harness h; h.connectExisting(); h.editor.load(); auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        QVERIFY(!h.editor.advancedRuleEditable());
        QVERIFY(!h.editor.keywordsEditable()); QVERIFY(!h.editor.secondaryKeywordsEditable());
        h.editor.setUseRegex(true); h.editor.setKeywords("blocked primary");
        h.editor.setSecondaryKeywords("blocked secondary"); h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        QVERIFY(!h.editor.useRegex());
        QCOMPARE(h.editor.keywordItems(), (QVariantList{"reverie", "home"}));
        QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{"night", "quiet"}));
        QCOMPARE(h.editor.selectiveLogic(), QString("and_all")); QVERIFY(h.editor.caseSensitive());
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 0);
        h.editor.load(); read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(existingArchive(), 38), 1);
        QVERIFY(h.editor.advancedRuleEditable());
        QVERIFY(h.editor.keywordsEditable()); QVERIFY(h.editor.secondaryKeywordsEditable());
        h.editor.setUseRegex(true); h.editor.setKeywords("accepted primary");
        h.editor.setSecondaryKeywords("accepted secondary"); h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        QVERIFY(h.editor.useRegex());
        QCOMPARE(h.editor.keywordItems(), (QVariantList{"accepted primary"}));
        QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{"accepted secondary"}));
        QCOMPARE(h.editor.selectiveLogic(), QString("not_any")); QVERIFY(!h.editor.caseSensitive());
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); QCOMPARE(h.puts(), 0);
    }
    void regexLinesKeepPatternBytesAndEditingBuffer_data() {
        QTest::addColumn<QString>("text"); QTest::addColumn<QVariantList>("items");
        QTest::newRow("commas-and-spaces") << QString(" ID-(?:\\d{1,3}) \n\tword\t\n\n  \n") << QVariantList{" ID-(?:\\d{1,3}) ", "\tword\t"};
        QTest::newRow("blank-lines-only") << QString("\n \n\t\n") << QVariantList{};
        QTest::newRow("python-whitespace-only-item") << (QString(QChar(0x001c)) + "\nvalue\n") << QVariantList{"value"};
        QTest::newRow("plain-markup") << QString("<tag>[a-z]+\n") << QVariantList{"<tag>[a-z]+"};
    }
    void regexLinesKeepPatternBytesAndEditingBuffer() {
        QFETCH(QString, text); QFETCH(QVariantList, items);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"useRegex", true}}));
        h.editor.setKeywords(text); h.editor.setSecondaryKeywords(text);
        QCOMPARE(h.editor.keywords(), text); QCOMPARE(h.editor.secondaryKeywords(), text);
        QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
        h.editor.setUseRegex(false); QCOMPARE(h.editor.keywordItems(), items);
        h.editor.setUseRegex(true); QCOMPARE(h.editor.keywordItems(), items); QCOMPARE(h.editor.secondaryKeywordItems(), items);
        h.editor.save(); QCOMPARE(h.puts(), 1); const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        QCOMPARE(firstEntry(submitted).value("keywords").toList(), items);
        QCOMPARE(firstEntry(submitted).value("secondaryKeywords").toList(), items);
        h.editor.receive(put.id, put.command, snapshot(submitted, 38), 1); QVERIFY(!h.editor.dirty());
    }
    void regexCodePointLimitsDistinguishImportedAndNewDrafts_data() {
        QTest::addColumn<QString>("kind"); QTest::addColumn<int>("count");
        QTest::newRow("primary-16384-surrogate-pairs") << "primary" << 16384;
        QTest::newRow("primary-16385-surrogate-pairs") << "primary" << 16385;
        QTest::newRow("secondary-16384-surrogate-pairs") << "secondary" << 16384;
        QTest::newRow("secondary-16385-surrogate-pairs") << "secondary" << 16385;
        QTest::newRow("imported-regex-too-long-preserved") << "imported" << 16385;
        QTest::newRow("literal-to-regex-too-long-blocked") << "conversion" << 16385;
    }
    void regexCodePointLimitsDistinguishImportedAndNewDrafts() {
        QFETCH(QString, kind); QFETCH(int, count);
        const auto pattern = QString::fromUtf8("😀").repeated(count);
        auto archive = withEntrySettings(existingArchive(), {{"useRegex", kind != "conversion"}});
        if (kind == "imported" || kind == "conversion") archive = withEntrySettings(archive, {{"keywords", QVariantList{pattern}}});
        Harness h; h.connectArchive(archive);
        if (kind == "primary") h.editor.setKeywords(pattern);
        else if (kind == "secondary") h.editor.setSecondaryKeywords(pattern);
        else h.editor.setContent("Preserve other edits");
        if (kind == "conversion") h.editor.setUseRegex(true);
        if (kind == "imported") {
            QVERIFY(!h.editor.keywordsEditable()); QVERIFY(h.editor.canSave());
            h.editor.save(); QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap()).value("keywords").toList(), (QVariantList{pattern}));
        } else if (count == 16384) {
            QVERIFY(h.editor.canSave()); h.editor.save(); QCOMPARE(h.puts(), 1);
        } else {
            QVERIFY(!h.editor.canSave()); QVERIFY(h.editor.saveBlocker().contains("16,384"));
            h.editor.save(); QCOMPARE(h.puts(), 0);
            if (kind == "conversion") { h.editor.setUseRegex(false); QVERIFY(h.editor.canSave()); }
            else {
                QVERIFY(kind == "primary" ? h.editor.keywordsEditable() : h.editor.secondaryKeywordsEditable());
                if (kind == "primary") h.editor.setKeywords("corrected"); else h.editor.setSecondaryKeywords("corrected");
                QVERIFY(h.editor.canSave());
            }
        }
    }
    void regexLocallyOversizedConversionRemainsCorrectable_data() {
        QTest::addColumn<bool>("create");
        QTest::newRow("literal-converted-regex-oversize-comma-can-shorten") << false;
        QTest::newRow("new-entry-regex-oversize-comma-can-shorten") << true;
    }
    void regexLocallyOversizedConversionRemainsCorrectable() {
        QFETCH(bool, create); Harness h; h.connectExisting();
        if (create) { h.editor.newEntry(); h.editor.setContent("New entry body"); }
        QVERIFY(!h.editor.useRegex()); h.editor.setUseRegex(true); QVERIFY(h.editor.keywordsEditable());
        h.editor.setKeywords(QString(16384, 'x') + ",");
        QCOMPARE(h.editor.keywordItems().size(), 1); QVERIFY(!h.editor.canSave());
        QVERIFY(h.editor.keywordsEditable());
        h.editor.setKeywords("ID-(?:\\d{1,3})");
        QVERIFY(h.editor.canSave()); h.editor.save(); QCOMPARE(h.puts(), 1);
        const auto put=h.requests.last();
        h.editor.receive(put.id,put.command,snapshot(storedEntrySettings(put.payload.value("archive").toMap()),38),1);
        QVERIFY(!h.editor.dirty()); QVERIFY(h.editor.useRegex());
        QCOMPARE(h.editor.keywordItems(),(QVariantList{"ID-(?:\\d{1,3})"}));
    }
    void regexImportedOversizeCorrectedThroughLiteralCanBeCorrectedAgain() {
        const auto original=QString(16385,'x');
        Harness h;h.connectArchive(withEntrySettings(existingArchive(),{{"useRegex",true},{"keywords",QVariantList{original}}}));
        QVERIFY(!h.editor.keywordsEditable());h.editor.setUseRegex(false);QVERIFY(h.editor.keywordsEditable());
        h.editor.setKeywords("short");h.editor.setUseRegex(true);QVERIFY(h.editor.keywordsEditable());
        h.editor.setKeywords(original+",");QVERIFY(!h.editor.canSave());QVERIFY(h.editor.keywordsEditable());
        h.editor.setKeywords("fixed,whole");QVERIFY(h.editor.canSave());h.editor.save();QCOMPARE(h.puts(),1);
        const auto put=h.requests.last();h.editor.receive(put.id,put.command,snapshot(put.payload.value("archive").toMap(),38),1);
        QVERIFY(!h.editor.dirty());QCOMPARE(h.editor.keywordItems(),(QVariantList{"fixed,whole"}));
    }
    void regexListAndArchiveCaps_data() {
        QTest::addColumn<QString>("kind"); QTest::addColumn<int>("count");
        QTest::newRow("primary-200") << "primary" << 200;
        QTest::newRow("primary-201") << "primary" << 201;
        QTest::newRow("secondary-200") << "secondary" << 200;
        QTest::newRow("secondary-201") << "secondary" << 201;
        QTest::newRow("individually-valid-patterns-exceed-archive-cap") << "archive" << 100;
    }
    void regexListAndArchiveCaps() {
        QFETCH(QString, kind); QFETCH(int, count);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"useRegex", true}}));
        QStringList lines;
        for (int i = 0; i < count; ++i) lines << (kind == "archive" ? QString(10000, 'a') : QString("pattern-%1").arg(i));
        if (kind == "secondary") h.editor.setSecondaryKeywords(lines.join('\n')); else h.editor.setKeywords(lines.join('\n'));
        QCOMPARE(h.editor.canSave(), count <= 200 && kind != "archive");
        if (kind == "archive") { QVERIFY(h.editor.draftBytes() > 900000); QVERIFY(h.editor.saveBlocker().contains("900000")); }
        h.editor.save(); QCOMPARE(h.puts(), count <= 200 && kind != "archive" ? 1 : 0);
    }
    void regexRuleConflictsRequireExplicitAuthorityAdoption_data() {
        QTest::addColumn<QString>("kind");
        QTest::newRow("authority-changes-mode-with-local-rule-draft") << "remote-mode";
        QTest::newRow("local-mode-change-and-authority-primary-change") << "remote-primary";
        QTest::newRow("local-mode-change-and-authority-secondary-change") << "remote-secondary";
    }
    void regexRuleConflictsRequireExplicitAuthorityAdoption() {
        QFETCH(QString, kind); Harness h; h.connectExisting();
        h.editor.setContent("Independent body draft");
        if (kind == "remote-mode") h.editor.setKeywords("local, literal"); else h.editor.setUseRegex(true);
        const auto localPrimary = h.editor.keywordItems(); const bool localMode = h.editor.useRegex();
        h.editor.reconcileAfterRestore(); const auto read = h.requests.last();
        auto archive = withEntrySettings(existingArchive(), kind == "remote-mode" ? QVariantMap{{"useRegex", true}}
            : kind == "remote-primary" ? QVariantMap{{"keywords", QVariantList{"remote primary"}}}
                                        : QVariantMap{{"secondaryKeywords", QVariantList{"remote auxiliary"}}});
        h.editor.receive(read.id, read.command, snapshot(archive, 38), 1);
        QVERIFY(h.editor.ruleConflict()); QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.keywordItems(), localPrimary); QCOMPARE(h.editor.useRegex(), localMode);
        h.editor.save(); QCOMPARE(h.puts(), 0);
        h.editor.adoptSavedRules(); QVERIFY(!h.editor.ruleConflict()); QVERIFY(h.editor.canSave());
        QCOMPARE(h.editor.content(), QString("Independent body draft"));
        QCOMPARE(h.editor.keywordItems(), firstEntry(archive).value("keywords").toList());
        QCOMPARE(h.editor.secondaryKeywordItems(), firstEntry(archive).value("secondaryKeywords").toList());
        h.editor.save(); QCOMPARE(h.puts(), 1);
    }
    void regexInFlightReadProtectsEditsReturnedToOldValues_data() {
        QTest::addColumn<bool>("editMode");
        QTest::newRow("list-edit-returned-to-baseline-versus-remote-mode") << false;
        QTest::newRow("mode-edit-returned-to-baseline-versus-remote-list") << true;
    }
    void regexInFlightReadProtectsEditsReturnedToOldValues() {
        QFETCH(bool, editMode); Harness h; h.connectExisting();
        h.editor.load(); const auto read=h.requests.last();
        const auto originalItems=h.editor.keywordItems();
        if(editMode) { h.editor.setUseRegex(true); h.editor.setUseRegex(false); }
        else { h.editor.setKeywords("temporary"); h.editor.setKeywords("reverie, home"); }
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.useRegex());
        auto authority=withEntrySettings(existingArchive(),editMode ? QVariantMap{{"keywords",QVariantList{"authority"}}}
                                                                 : QVariantMap{{"useRegex",true}});
        h.editor.receive(read.id,read.command,snapshot(authority,38),1);
        QVERIFY(h.editor.ruleConflict()); QVERIFY(!h.editor.canSave());
        QVERIFY(!h.editor.useRegex());
        if(!editMode) QCOMPARE(h.editor.keywordItems(),originalItems);
        h.editor.save(); QCOMPARE(h.puts(),0);
        h.editor.adoptSavedRules(); QVERIFY(!h.editor.ruleConflict());
        QCOMPARE(h.editor.useRegex(),firstEntry(authority).value("useRegex").toBool());
        QCOMPARE(h.editor.keywordItems(),firstEntry(authority).value("keywords").toList());
    }
    void regexSaveReceiptKeepsLaterEdits_data() {
        QTest::addColumn<QString>("field");
        QTest::newRow("primary-buffer-and-array") << "primary";
        QTest::newRow("secondary-buffer-and-array") << "secondary";
        QTest::newRow("mode-after-submit") << "mode";
        QTest::newRow("logic-after-submit") << "logic";
        QTest::newRow("case-after-submit") << "case";
    }
    void regexSaveReceiptKeepsLaterEdits() {
        QFETCH(QString, field); Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"useRegex", true}}));
        h.editor.setKeywords("submitted\nsecond"); h.editor.save(); const auto put = h.requests.last();
        if (field == "primary") h.editor.setKeywords("later,whole\n\n");
        else if (field == "secondary") h.editor.setSecondaryKeywords("  auxiliary  \n");
        else if (field == "mode") h.editor.setUseRegex(false);
        else if (field == "logic") h.editor.setSelectiveLogic("not_all");
        else h.editor.setCaseSensitive(false);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QVERIFY(!h.editor.ruleConflict()); QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave());
        if (field == "primary") { QCOMPARE(h.editor.keywords(), QString("later,whole\n\n")); QCOMPARE(h.editor.keywordItems(), (QVariantList{"later,whole"})); }
        else if (field == "secondary") { QCOMPARE(h.editor.secondaryKeywords(), QString("  auxiliary  \n")); QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{"  auxiliary  "})); }
        else if (field == "mode") QVERIFY(!h.editor.useRegex());
        else if (field == "logic") QCOMPARE(h.editor.selectiveLogic(), QString("not_all"));
        else QVERIFY(!h.editor.caseSensitive());
    }
    void regexRuleReceiptRejectsAnyGroupMismatch_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("missing-mode") << "missing-mode";
        QTest::newRow("wrong-mode") << "wrong-mode";
        QTest::newRow("numeric-mode") << "numeric-mode";
        QTest::newRow("split-primary") << "split-primary";
        QTest::newRow("trimmed-primary") << "trimmed-primary";
        QTest::newRow("reordered-primary") << "reordered-primary";
        QTest::newRow("wrong-secondary") << "wrong-secondary";
        QTest::newRow("wrong-logic") << "wrong-logic";
        QTest::newRow("wrong-case") << "wrong-case";
    }
    void regexRuleReceiptRejectsAnyGroupMismatch() {
        QFETCH(QString, change); Harness h; h.connectExisting();
        h.editor.setUseRegex(true); h.editor.setKeywords(" ID-(?:\\d{1,3}) \nother"); h.editor.save(); const auto put = h.requests.last();
        auto receipt = put.payload.value("archive").toMap();
        if (change == "missing-target") receipt = withoutEntry(receipt, 0, 0);
        else {
            QVariantMap mutation;
            if (change == "missing-mode") mutation["useRegex"] = QVariant{};
            else if (change == "wrong-mode") mutation["useRegex"] = false;
            else if (change == "numeric-mode") mutation["useRegex"] = 1;
            else if (change == "split-primary") mutation["keywords"] = QVariantList{" ID-(?:\\d{1", "3}) ", "other"};
            else if (change == "trimmed-primary") mutation["keywords"] = QVariantList{"ID-(?:\\d{1,3})", "other"};
            else if (change == "reordered-primary") mutation["keywords"] = QVariantList{"other", " ID-(?:\\d{1,3}) "};
            else if (change == "wrong-secondary") mutation["secondaryKeywords"] = QVariantList{"different"};
            else if (change == "wrong-logic") mutation["selectiveLogic"] = "and_any";
            else mutation["caseSensitive"] = false;
            receipt = withEntrySettings(receipt, mutation);
        }
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.revision(), 37); QCOMPARE(h.editor.status(), QString("error"));
        QCOMPARE(h.editor.keywordItems(), (QVariantList{" ID-(?:\\d{1,3}) ", "other"}));
    }
    void regexRuleReceiptMissingTargetKeepsDraftOrphaned_data() {
        QTest::addColumn<QString>("missing");
        QTest::newRow("missing-entry") << "entry";
        QTest::newRow("missing-book") << "book";
    }
    void regexRuleReceiptMissingTargetKeepsDraftOrphaned() {
        QFETCH(QString, missing);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"useRegex", true}}));
        const auto book = h.editor.selectedBookKey(), entry = h.editor.selectedEntryKey();
        const QVariantList primary{" ID-(?:\\d{1,3}) ", "other"};
        const QVariantList secondary{" auxiliary(?:x,y) ", "second"};
        h.editor.setKeywords(" ID-(?:\\d{1,3}) \nother");
        h.editor.setSecondaryKeywords(" auxiliary(?:x,y) \nsecond");
        h.editor.setContent("Regex body draft retained after target disappearance");
        QVERIFY(h.editor.canSave()); h.editor.save(); QCOMPARE(h.puts(), 1);
        const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        const auto receipt = missing == "entry" ? withoutEntry(submitted, 0, 0) : withoutBook(submitted, 0);
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.editor.status(), QString("orphan")); QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.selectedBookKey(), book); QCOMPARE(h.editor.selectedEntryKey(), entry);
        QVERIFY(h.editor.useRegex()); QCOMPARE(h.editor.keywordItems(), primary);
        QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        QCOMPARE(h.editor.content(), QString("Regex body draft retained after target disappearance"));
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.writesBlocked()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 1);
    }
    void regexRuleReceiptMissingTargetStillRejectsPriorityEdits() {
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{"useRegex", true}}));
        const QVariantList primary{" ID-(?:\\d{1,3}) ", "other"};
        const QVariantList secondary{" auxiliary(?:x,y) ", "second"};
        h.editor.setKeywords(" ID-(?:\\d{1,3}) \nother");
        h.editor.setSecondaryKeywords(" auxiliary(?:x,y) \nsecond");
        h.editor.setContent("Regex and priority draft retained after rejected receipt");
        h.editor.setPriority(2); QVERIFY(h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 1); const auto put = h.requests.last();
        h.editor.receive(put.id, put.command,
                         snapshot(withoutEntry(put.payload.value("archive").toMap(), 0, 0), 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.useRegex());
        QCOMPARE(h.editor.keywordItems(), primary); QCOMPARE(h.editor.secondaryKeywordItems(), secondary);
        QCOMPARE(h.editor.content(), QString("Regex and priority draft retained after rejected receipt"));
        QCOMPARE(h.editor.priority().toInt(), 2); QCOMPARE(h.puts(), 1);
    }
    void regexDiagnosticsDisplayOnlyValidatedCurrentEvidence_data() {
        QTest::addColumn<QString>("kind"); QTest::addColumn<QString>("state");
        QTest::newRow("no-run-after-read") << "unrun" << "unrun";
        QTest::newRow("clean-is-not-syntax-validation") << "clear" << "clear";
        QTest::newRow("invalid-regex-current-entry") << "invalid" << "entry-error";
        QTest::newRow("duplicate-entry-records-deduplicated") << "duplicate" << "entry-error";
        QTest::newRow("snapshot-global-error") << "global" << "global-error";
        QTest::newRow("worker-global-error") << "worker" << "global-error";
        QTest::newRow("truncated-without-current-record-is-unknown") << "truncated" << "truncated";
        QTest::newRow("truncated-preserves-current-error") << "truncated-error" << "entry-error";
        QTest::newRow("book-recursion-not-shown-as-entry-error") << "book-recursion" << "clear";
        QTest::newRow("source-entry-recursion-retains-explicit-owner") << "entry-recursion" << "entry-error";
    }
    void regexDiagnosticsDisplayOnlyValidatedCurrentEvidence() {
        QFETCH(QString, kind); QFETCH(QString, state);
        Harness h; const auto archive = withEntrySettings(existingArchive(), {{"useRegex", true}}); h.connectArchive(archive);
        QVariantList entries; int truncated = 0;
        if (kind == "invalid" || kind == "duplicate" || kind == "truncated-error") entries.append(worldbookDiagnostic("invalid_regex"));
        if (kind == "duplicate") entries.append(worldbookDiagnostic("invalid_regex"));
        if (kind == "global" || kind == "worker") entries.append(worldbookDiagnostic(kind == "global" ? "snapshot_unavailable" : "regex_worker_unavailable", 37, "turn-regex-1", -1, -1, "", ""));
        if (kind == "book-recursion") entries.append(worldbookDiagnostic("recursion_depth_limit", 37, "turn-regex-1", 0, -1, "book-primary", ""));
        if (kind == "entry-recursion") entries.append(worldbookDiagnostic("recursion_text_limit"));
        if (kind.startsWith("truncated")) truncated = 4;
        h.editor.load(); const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, withWorldbookDiagnostics(snapshot(archive,37), entries, kind=="unrun" ? "" : "turn-regex-1",truncated),1);
        const auto diagnostic = h.editor.regexDiagnostics();
        QCOMPARE(diagnostic.value("status").toString(),state); QVERIFY(diagnostic.value("available").toBool());
        if (kind == "duplicate") QCOMPARE(diagnostic.value("messages").toStringList().size(),1);
        if (kind == "clear") QVERIFY(diagnostic.value("text").toString().contains("不表示正则已验证有效"));
        if (truncated) QVERIFY(diagnostic.value("text").toString().contains("4"));
    }
    void regexDiagnosticsRejectMalformedEnvelopeOrAnyRecord_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("missing-metadata") << "missing";
        QTest::newRow("foreign-result-persona") << "outer-persona";
        QTest::newRow("foreign-diagnostic-persona") << "persona";
        QTest::newRow("old-diagnostic-revision") << "revision";
        QTest::newRow("noninteger-revision") << "fraction";
        QTest::newRow("wrong-request-type") << "request-type";
        QTest::newRow("control-in-request-id") << "request-control";
        QTest::newRow("oversized-request-id") << "request-length";
        QTest::newRow("unknown-code") << "code";
        QTest::newRow("foreign-record-persona") << "row-persona";
        QTest::newRow("foreign-record-request") << "row-request";
        QTest::newRow("old-record-revision") << "row-revision";
        QTest::newRow("book-index-outside-snapshot") << "book-index";
        QTest::newRow("entry-index-outside-snapshot") << "entry-index";
        QTest::newRow("wrong-book-id") << "book-id";
        QTest::newRow("wrong-entry-id") << "entry-id";
        QTest::newRow("wrong-global-shape") << "global";
        QTest::newRow("wrong-recursion-shape") << "recursive";
        QTest::newRow("boolean-truncated") << "truncated";
        QTest::newRow("too-many-records") << "many";
        QTest::newRow("nonobject-record") << "scalar";
        QTest::newRow("empty-request-with-error-is-not-unrun") << "empty-request";
    }
    void regexDiagnosticsRejectMalformedEnvelopeOrAnyRecord() {
        QFETCH(QString, change); Harness h; const auto archive=withEntrySettings(existingArchive(),{{"useRegex",true}});h.connectArchive(archive);
        const auto good=withWorldbookDiagnostics(snapshot(archive,37),{worldbookDiagnostic("invalid_regex")});
        h.editor.load(); auto read=h.requests.last();h.editor.receive(read.id,read.command,good,1);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("entry-error"));
        auto bad=good;auto data=bad.value("world_book_diagnostics").toMap();auto rows=data.value("entries").toList();auto row=rows[0].toMap();
        if(change=="outer-persona")bad["persona_id"]="foreign";
        else if(change=="persona")data["persona_id"]="foreign";
        else if(change=="revision")data["revision"]=36;
        else if(change=="fraction")data["revision"]=37.5;
        else if(change=="request-type")data["request_id"]=true;
        else if(change=="request-control")data["request_id"]="turn\nprivate";
        else if(change=="request-length")data["request_id"]=QString(129,'x');
        else if(change=="code")row["code"]="private_unknown_reason";
        else if(change=="row-persona")row["persona_id"]="foreign";
        else if(change=="row-request")row["request_id"]="other-turn";
        else if(change=="row-revision")row["revision"]=36;
        else if(change=="book-index")row["book_index"]=2;
        else if(change=="entry-index")row["entry_index"]=100;
        else if(change=="book-id")row["book_id"]="other";
        else if(change=="entry-id")row["entry_id"]="entry-sibling";
        else if(change=="global")row["code"]="snapshot_unavailable";
        else if(change=="recursive") {row["code"]="recursion_text_limit";row["entry_index"]=-1;}
        else if(change=="truncated")data["truncated"]=true;
        else if(change=="empty-request") {data["request_id"]="";row["request_id"]="";}
        rows[0]=row;
        if(change=="many")for(int i=1;i<201;++i)rows.append(row);
        if(change=="scalar")rows[0]=7;
        data["entries"]=rows;bad["world_book_diagnostics"]=data;
        if(change=="missing")bad.remove("world_book_diagnostics");
        h.editor.load();read=h.requests.last();h.editor.receive(read.id,read.command,bad,1);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unavailable"));
        QVERIFY(!h.editor.regexDiagnostics().value("available").toBool());
        QVERIFY(h.editor.initialized());QCOMPARE(h.editor.revision(),37);
    }
    void regexDiagnosticsBindDuplicateIdsToOrdinalsAndExpire() {
        auto archive=withEntrySettings(existingArchive(),{{"useRegex",true}});
        archive=withEntrySettings(archive,{{"id","entry-primary"},{"useRegex",true}},0,1);
        Harness h;h.connectArchive(archive);h.editor.load();auto read=h.requests.last();
        h.editor.receive(read.id,read.command,withWorldbookDiagnostics(snapshot(archive,37),{worldbookDiagnostic("invalid_regex",37,"turn-regex-1",0,1)}),1);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("clear"));
        h.editor.selectEntry(h.entryKey(1));QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("entry-error"));
        h.editor.setComment("Uncommitted note");QVERIFY(h.editor.regexDiagnostics().value("dirtyNote").toString().contains("REV 37"));
        h.editor.setSession(false,2,"persona-A");QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unavailable"));
        h.editor.setSession(true,2,"persona-A");QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unavailable"));
    }
    void regexDiagnosticsNewRevisionAndNewEntryHaveNoRun() {
        const auto archive=withEntrySettings(existingArchive(),{{"useRegex",true}});Harness h;h.connectArchive(archive);
        h.editor.load();auto read=h.requests.last();h.editor.receive(read.id,read.command,withWorldbookDiagnostics(snapshot(archive,37),{worldbookDiagnostic("invalid_regex")}),1);
        h.editor.setKeywords("fixed");h.editor.save();const auto put=h.requests.last();
        h.editor.receive(put.id,put.command,withWorldbookDiagnostics(snapshot(put.payload.value("archive").toMap(),38),{},""),1);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unrun"));
        h.editor.newEntry();h.editor.setUseRegex(true);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unsaved"));
    }
    void regexDiagnosticsPersonaWithColonUsesFullScopeIdentity() {
        Harness h;h.editor.setSession(true,1,"persona:with-colon:4:fingerprint");const auto read=h.requests.last();
        const auto archive=withEntrySettings(existingArchive(),{{"useRegex",true}});
        h.editor.receive(read.id,read.command,withWorldbookDiagnostics(snapshot(archive,37),{},"",0,"persona:with-colon"),1);
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unrun"));
        h.editor.setSession(true,1,"persona-other:5:fingerprint");
        QCOMPARE(h.editor.regexDiagnostics().value("status").toString(),QString("unavailable"));
    }
    void regexSameModeReadMergesUneditedRulesWithoutConvertingDrafts() {
        Harness h;h.connectExisting();h.editor.setKeywords("local,primary");h.editor.setContent("Independent body draft");
        h.editor.reconcileAfterRestore();const auto read=h.requests.last();
        auto newer=withAdvancedRules(existingArchive(),{"remote auxiliary"},"not_all",false);
        newer=withEntrySettings(newer,{{"keywords",QVariantList{"remote primary"}}});
        h.editor.receive(read.id,read.command,snapshot(newer,38),1);
        QVERIFY(!h.editor.ruleConflict());QCOMPARE(h.editor.keywordItems(),(QVariantList{"local","primary"}));
        QCOMPARE(h.editor.secondaryKeywordItems(),(QVariantList{"remote auxiliary"}));
        QCOMPARE(h.editor.selectiveLogic(),QString("not_all"));QVERIFY(!h.editor.caseSensitive());
        QCOMPARE(h.editor.content(),QString("Independent body draft"));
        h.editor.save();QCOMPARE(h.puts(),1);
    }
    void regexNewEntryAndLegacyMatchingEditSubmitCompleteRuleGroup() {
        auto archive=withEntrySettings(existingArchive(),{{"useRegex",QVariant{}},{"secondaryKeywords",QVariant{}},
            {"selectiveLogic",QVariant{}},{"caseSensitive",QVariant{}}});
        Harness h;h.connectArchive(archive);h.editor.setKeywords("legacy,new");h.editor.save();auto put=h.requests.last();
        auto sent=put.payload.value("archive").toMap();auto entry=firstEntry(sent);
        for(const auto &key:{"useRegex","keywords","secondaryKeywords","selectiveLogic","caseSensitive"})QVERIFY(entry.contains(key));
        QVERIFY(!entry.value("useRegex").toBool());QCOMPARE(entry.value("secondaryKeywords").toList(),QVariantList{});
        QCOMPARE(entry.value("selectiveLogic").toString(),QString("and_any"));
        h.editor.receive(put.id,put.command,snapshot(storedEntrySettings(sent),38),1);QCOMPARE(h.editor.status(),QString("saved"));
        h.editor.newEntry();h.editor.setUseRegex(true);h.editor.setKeywords("new(?:1,3)");h.editor.setContent("New regex entry");
        h.editor.save();put=h.requests.last();sent=put.payload.value("archive").toMap();
        const auto entries=firstBook(sent).value("entries").toList();entry=entries.last().toMap();
        QVERIFY(entry.value("useRegex").toBool());QCOMPARE(entry.value("keywords").toList(),(QVariantList{"new(?:1,3)"}));
        h.editor.receive(put.id,put.command,snapshot(storedEntrySettings(sent),39),1);QVERIFY(!h.editor.dirty());QVERIFY(h.editor.useRegex());
    }
    void regexMalformedRulesAreNotAdopted_data() {
        QTest::addColumn<QString>("field");QTest::addColumn<QVariant>("value");
        QTest::newRow("mode-not-boolean") << "useRegex" << QVariant("true");
        QTest::newRow("case-not-boolean") << "caseSensitive" << QVariant(1);
        QTest::newRow("logic-not-known") << "selectiveLogic" << QVariant("unknown");
        QTest::newRow("auxiliary-not-array") << "secondaryKeywords" << QVariant("a,b");
        QTest::newRow("auxiliary-item-not-string") << "secondaryKeywords" << QVariant(QVariantList{true});
    }
    void regexMalformedRulesAreNotAdopted() {
        QFETCH(QString,field);QFETCH(QVariant,value);Harness h;
        h.connectArchive(withEntrySettings(existingArchive(),{{field,value}}));
        QVERIFY(!h.editor.initialized());QVERIFY(!h.editor.advancedRuleEditable());QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.status(),QString("read-error"));
    }
    void regexDiagnosticsNeverPartiallyAcceptInvalidUnselectedRecord() {
        const auto archive=withEntrySettings(existingArchive(),{{"useRegex",true}});Harness h;h.connectArchive(archive);
        auto other=worldbookDiagnostic("invalid_regex",37,"turn-regex-1",0,1,"book-primary","wrong-id");
        h.editor.load();const auto read=h.requests.last();
        h.editor.receive(read.id,read.command,withWorldbookDiagnostics(snapshot(archive,37),{worldbookDiagnostic("invalid_regex"),other}),1);
        const auto diagnostic=h.editor.regexDiagnostics();QCOMPARE(diagnostic.value("status").toString(),QString("unavailable"));
        QVERIFY(diagnostic.value("codes").toStringList().isEmpty());
        QVERIFY(diagnostic.value("messages").toStringList().isEmpty());
    }
    void focusContextTransactionPrecedesFieldPublication_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("entry-selection-invalidates-before-shared-notify") << "entry";
        QTest::newRow("book-selection-invalidates-before-shared-notify") << "book";
        QTest::newRow("persona-replacement-invalidates-before-shared-notify") << "persona";
        QTest::newRow("same-entry-authoritative-body-replacement-is-guarded") << "body-read";
        QTest::newRow("discarded-body-draft-replacement-is-guarded") << "body-discard";
        QTest::newRow("new-entry-context-is-guarded") << "new-entry";
        QTest::newRow("new-book-context-is-guarded") << "new-book";
    }
    void focusContextTransactionPrecedesFieldPublication() {
        QFETCH(QString, change);
        Harness h; h.connectExisting();
        if (change == "body-discard") h.editor.setContent("Draft replaced by authority");
        const auto oldBook = h.editor.selectedBookKey(), oldEntry = h.editor.selectedEntryKey();
        const auto oldScope = h.editor.archiveScope(), oldBody = h.editor.content();
        const int oldRevision = h.editor.focusContextRevision();
        QVERIFY(!h.editor.focusContextChanging());
        QList<QVariantMap> events;
        const auto record = [&](const QString &kind) {
            events.append({{"kind", kind}, {"changing", h.editor.focusContextChanging()},
                {"revision", h.editor.focusContextRevision()}, {"book", h.editor.selectedBookKey()},
                {"entry", h.editor.selectedEntryKey()}, {"scope", h.editor.archiveScope()},
                {"body", h.editor.content()}});
        };
        connect(&h.editor, &ArchiveEditor::focusContextChanged, this, [&] {
            record(h.editor.focusContextChanging() ? "begin" : "finish");
        });
        connect(&h.editor, &ArchiveEditor::changed, this, [&] { record("publish"); });
        if (change == "entry") h.editor.selectEntry(h.entryKey(1));
        else if (change == "book") h.editor.selectBook(h.bookKey(1));
        else if (change == "persona") h.editor.setSession(true, 1, "persona-B");
        else if (change == "new-entry") h.editor.newEntry();
        else if (change == "new-book") h.editor.newBook();
        else {
            auto authority = existingArchive();
            if (change == "body-read")
                authority = withFields(authority, "Original book", "New authoritative body",
                                       QVariantList{"reverie", "home"});
            h.editor.reloadDiscardingDraft();
            const auto read = h.requests.last();
            QCOMPARE(read.command, QString("archive:get"));
            h.editor.receive(read.id, read.command, snapshot(authority, 38), 1);
        }
        QVERIFY(!h.editor.focusContextChanging());
        QVERIFY(h.editor.focusContextRevision() > oldRevision);
        int firstBegin = -1, depth = 0, completed = 0;
        bool publishedWhileChanging = false;
        for (int i = 0; i < events.size(); ++i) {
            const auto &event = events[i];
            if (event.value("kind") == "begin") {
                if (firstBegin < 0) firstBegin = i;
                QCOMPARE(depth, 0); depth = 1;
                QVERIFY(event.value("changing").toBool());
            } else if (event.value("kind") == "finish") {
                QCOMPARE(depth, 1);
                QVERIFY(publishedWhileChanging);
                QVERIFY(!event.value("changing").toBool());
                depth = 0; ++completed; publishedWhileChanging = false;
            } else if (depth) {
                QVERIFY(event.value("changing").toBool());
                publishedWhileChanging = true;
            }
        }
        QVERIFY(firstBegin >= 0); QVERIFY(completed > 0); QCOMPARE(depth, 0);
        const auto initial = events[firstBegin];
        QCOMPARE(initial.value("book").toString(), oldBook);
        QCOMPARE(initial.value("entry").toString(), oldEntry);
        QCOMPARE(initial.value("scope").toString(), oldScope);
        QCOMPARE(initial.value("body").toString(), oldBody);
        QCOMPARE(initial.value("revision").toInt(), oldRevision + 1);
    }
    void focusContextStableEditsPreservePresentationRevision_data() {
        QTest::addColumn<QString>("action");
        QTest::newRow("ordinary-body-typing-keeps-context") << "typing";
        QTest::newRow("ordinary-title-edit-keeps-context") << "title";
        QTest::newRow("unchanged-authoritative-read-keeps-context") << "read";
        QTest::newRow("entry-settings-save-ack-keeps-context") << "settings-save";
        QTest::newRow("save-ack-preserves-later-body-draft-context") << "later-draft";
        QTest::newRow("discard-other-fields-keeps-same-body-context") << "metadata-discard";
        QTest::newRow("failed-read-status-keeps-body-context") << "failed-read";
    }
    void focusContextStableEditsPreservePresentationRevision() {
        QFETCH(QString, action);
        Harness h; h.connectExisting();
        const int before = h.editor.focusContextRevision();
        const auto book = h.editor.selectedBookKey(), entry = h.editor.selectedEntryKey();
        QSignalSpy context(&h.editor, &ArchiveEditor::focusContextChanged);
        QVERIFY(context.isValid());
        if (action == "typing") h.editor.setContent("User typing remains in this entry");
        else if (action == "title") h.editor.setTitle("Edited title");
        else if (action == "settings-save" || action == "later-draft") {
            if (action == "settings-save") h.editor.setEntryScanDepth(5);
            else h.editor.setTitle("Submitted title");
            h.editor.save();
            const auto put = h.requests.last(); QCOMPARE(put.command, QString("archive:put"));
            if (action == "later-draft") h.editor.setContent("User typed after save dispatch");
            h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
            if (action == "later-draft") {
                QCOMPARE(h.editor.content(), QString("User typed after save dispatch"));
                QVERIFY(h.editor.dirty());
            } else QCOMPARE(h.editor.status(), QString("saved"));
        } else {
            if (action == "metadata-discard") h.editor.setTitle("Discard this title only");
            h.editor.reloadDiscardingDraft();
            const auto read = h.requests.last(); QCOMPARE(read.command, QString("archive:get"));
            if (action == "failed-read") h.editor.failed(read.id, "unavailable", 1);
            else h.editor.receive(read.id, read.command, snapshot(existingArchive(), 38), 1);
            QCOMPARE(h.editor.content(), QString("Original note"));
        }
        QCOMPARE(context.size(), 0);
        QCOMPARE(h.editor.focusContextRevision(), before);
        QVERIFY(!h.editor.focusContextChanging());
        QCOMPARE(h.editor.selectedBookKey(), book);
        QCOMPARE(h.editor.selectedEntryKey(), entry);
    }
    void priorityRoundTripChangesOnlyTheSelectedAllocationValue_data() {
        QTest::addColumn<int>("value");
        QTest::addColumn<bool>("regex");
        QTest::newRow("literal-zero") << 0 << false;
        QTest::newRow("literal-two") << 2 << false;
        QTest::newRow("literal-maximum") << 2147483647 << false;
        QTest::newRow("regex-zero") << 0 << true;
        QTest::newRow("regex-two") << 2 << true;
        QTest::newRow("regex-maximum") << 2147483647 << true;
    }
    void priorityRoundTripChangesOnlyTheSelectedAllocationValue() {
        QFETCH(int, value); QFETCH(bool, regex);
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList();
        auto book = books[0].toMap(); auto entries = book.value("entries").toList();
        auto entry = entries[0].toMap(); entry["useRegex"] = regex;
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        const auto rows = h.editor.entryRows();
        QVERIFY(h.editor.priorityConfirmed());
        QVERIFY(h.editor.priorityEditable());
        QVERIFY(h.editor.advancedRuleEditable());
        QCOMPARE(h.editor.useRegex(), regex);
        QCOMPARE(h.editor.priorityText(), QString("4"));
        h.editor.setPriority(value);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave());
        QCOMPARE(h.editor.entryRows(), rows); // Priority never orders or rewrites list rows.
        h.editor.save();
        const auto put = h.requests.last();
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        const auto expected = withPriority(archive, value);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved"));
        QCOMPARE(h.editor.priority().toInt(), value);
        QCOMPARE(h.editor.priorityText(), QString::number(value));
        QCOMPARE(h.editor.advancedFields().value("entry").toMap().value("priority").toInt(), value);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 1);
    }
    void priorityRejectsInvalidSetterInputsWithoutCoercion_data() {
        QTest::addColumn<QVariant>("value");
        QTest::newRow("negative") << QVariant(-1);
        QTest::newRow("beyond-ui-range") << QVariant(qint64(2147483648LL));
        QTest::newRow("numeric-string") << QVariant("2");
        QTest::newRow("true") << QVariant(true);
        QTest::newRow("false") << QVariant(false);
        QTest::newRow("fraction") << QVariant(1.5);
        QTest::newRow("missing") << QVariant{};
        QTest::newRow("object") << QVariant(QVariantMap{{"value", 2}});
    }
    void priorityRejectsInvalidSetterInputsWithoutCoercion() {
        QFETCH(QVariant, value);
        Harness h; h.connectExisting();
        h.editor.setPriority(value);
        QCOMPARE(h.editor.priority().toInt(), 4);
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void priorityNewEntryDefaultsToZeroWithoutChangingItsNeighbors() {
        Harness h; h.connectExisting();
        h.editor.newEntry();
        QVERIFY(h.editor.priorityConfirmed()); QVERIFY(h.editor.priorityEditable());
        QCOMPARE(h.editor.priority().toInt(), 0); QCOMPARE(h.editor.priorityText(), QString("0"));
        h.editor.setContent("A new priority entry");
        h.editor.save();
        const auto put = h.requests.last(); const auto archive = put.payload.value("archive").toMap();
        QCOMPARE(entryAt(archive, 0, 2).value("priority").toInt(), 0);
        QCOMPARE(json(entryAt(archive, 0, 0)), json(entryAt(existingArchive(), 0, 0)));
        QCOMPARE(json(entryAt(archive, 0, 1)), json(entryAt(existingArchive(), 0, 1)));
        h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(archive), 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
    }
    void legacyPriorityOutsideTheUiRangeIsReadOnlyAndPreserved_data() {
        QTest::addColumn<qint64>("value");
        QTest::newRow("first-outside-value") << qint64(2147483648LL);
        QTest::newRow("above-uint32") << qint64(4294967297LL);
        QTest::newRow("large-exact-integer") << qint64(1000000000000LL);
    }
    void legacyPriorityOutsideTheUiRangeIsReadOnlyAndPreserved() {
        QFETCH(qint64, value);
        Harness h; const auto archive = withPriority(existingArchive(), value); h.connectArchive(archive);
        QVERIFY(h.editor.priorityConfirmed()); QVERIFY(!h.editor.priorityEditable());
        QCOMPARE(h.editor.priorityText(), QString::number(value));
        h.editor.setPriority(0); QVERIFY(!h.editor.dirty());
        h.editor.setContent("Only the content changes"); h.editor.save();
        const auto put = h.requests.last();
        const auto expected = withFields(archive, "Original book", "Only the content changes", {"reverie", "home"});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.priorityText(), QString::number(value)); QVERIFY(!h.editor.priorityEditable());
    }
    void malformedPriorityRemainsUnknownAndIsNeverDefaulted_data() {
        QTest::addColumn<QVariant>("value");
        QTest::newRow("string") << QVariant("4");
        QTest::newRow("bool") << QVariant(true);
        QTest::newRow("fraction") << QVariant(4.5);
        QTest::newRow("negative") << QVariant(-4);
        QTest::newRow("null") << QVariant::fromValue(nullptr);
    }
    void malformedPriorityRemainsUnknownAndIsNeverDefaulted() {
        QFETCH(QVariant, value);
        Harness h; const auto archive = withPriority(existingArchive(), value); h.connectArchive(archive);
        QVERIFY(!h.editor.priorityConfirmed()); QVERIFY(!h.editor.priorityEditable());
        QCOMPARE(h.editor.priorityText(), QString("未确认"));
        QVERIFY(!h.editor.initialized()); QCOMPARE(h.editor.status(), QString("read-error"));
        h.editor.setPriority(0); QVERIFY(!h.editor.dirty());
        h.editor.setContent("Unconfirmed archive must not be sent"); h.editor.save();
        QCOMPARE(h.puts(), 0);
    }
    void priorityMissingLegacyFieldStaysUnknownAndAbsentDuringOtherEdits() {
        Harness h; const auto archive = withPriority(existingArchive(), {}); h.connectArchive(archive);
        QVERIFY(h.editor.initialized()); QVERIFY(!h.editor.priorityConfirmed());
        QVERIFY(!h.editor.priorityEditable()); QCOMPARE(h.editor.priorityText(), QString("未确认"));
        h.editor.setPriority(0); QVERIFY(!h.editor.dirty());
        h.editor.setContent("Only content changed"); h.editor.save();
        const auto expected = withFields(archive, "Original book", "Only content changed", {"reverie", "home"});
        QCOMPARE(json(h.requests.last().payload.value("archive").toMap()), json(expected));
        QVERIFY(!firstEntry(h.requests.last().payload.value("archive").toMap()).contains("priority"));
    }
    void priorityReadFailureRetainsRawValueAndRequiresAConfirmedRead() {
        Harness h; h.connectExisting(); h.editor.load();
        auto read = h.requests.last(); h.editor.failed(read.id, "deadline", 1);
        QCOMPARE(h.editor.priority().toInt(), 4); QCOMPARE(h.editor.priorityText(), QString("未确认"));
        QVERIFY(!h.editor.priorityEditable()); h.editor.setPriority(2); QVERIFY(!h.editor.dirty());
        h.editor.load(); read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withPriority(existingArchive(), 6), 38), 1);
        QVERIFY(h.editor.priorityConfirmed()); QCOMPARE(h.editor.priorityText(), QString("6"));
        QCOMPARE(h.puts(), 0);
    }
    void prioritySaveRejectsMismatchedAuthorityAndPreservesDraft_data() {
        QTest::addColumn<QString>("fault");
        QTest::newRow("wrong-priority") << "wrong";
        QTest::newRow("string-priority") << "string";
        QTest::newRow("missing-priority") << "missing";
        QTest::newRow("missing-entry") << "entry";
        QTest::newRow("missing-book") << "book";
        QTest::newRow("wrong-revision") << "revision";
    }
    void prioritySaveRejectsMismatchedAuthorityAndPreservesDraft() {
        QFETCH(QString, fault);
        Harness h; h.connectExisting(); h.editor.setPriority(2); h.editor.save();
        const auto put = h.requests.last(); auto archive = put.payload.value("archive").toMap();
        if (fault == "wrong") archive = withPriority(archive, 3);
        if (fault == "string") archive = withPriority(archive, "2");
        if (fault == "missing") archive = withPriority(archive, {});
        if (fault == "entry") archive = withoutEntry(archive, 0, 0);
        if (fault == "book") archive = withoutBook(archive, 0);
        h.editor.receive(put.id, put.command, snapshot(archive, fault == "revision" ? 37 : 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.priority().toInt(), 2); QVERIFY(h.editor.dirty()); QCOMPARE(h.puts(), 1);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
    }
    void priorityEditsDuringSaveKeepTheLaterValue_data() {
        QTest::addColumn<int>("later");
        QTest::newRow("different-later-value") << 9;
        QTest::newRow("back-to-original-baseline") << 4;
    }
    void priorityEditsDuringSaveKeepTheLaterValue() {
        QFETCH(int, later);
        Harness h; h.connectExisting(); h.editor.setPriority(2); h.editor.save();
        const auto put = h.requests.last(); h.editor.setPriority(later);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.priority().toInt(), later); QCOMPARE(h.editor.status(), QString("dirty"));
        QVERIFY(h.editor.dirty()); h.editor.save();
        QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap()).value("priority").toInt(), later);
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 38);
    }
    void priorityUntouchedDuringReadDoesNotOverwriteANewerAuthorityValue() {
        Harness h; h.connectExisting(); h.editor.load(); const auto read = h.requests.last();
        h.editor.setContent("Typed while the read is pending");
        const auto current = withPriority(existingArchive(), qint64(4294967297LL));
        h.editor.receive(read.id, read.command, snapshot(current, 38), 1);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.priorityText(), QString("4294967297"));
        QVERIFY(!h.editor.priorityEditable()); h.editor.save();
        QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap()).value("priority").toLongLong(), 4294967297LL);
    }
    void priorityFailuresAndConflictNeverResend_data() {
        QTest::addColumn<QString>("outcome");
        QTest::newRow("conflict") << "conflict";
        QTest::newRow("deadline") << "deadline";
        QTest::newRow("storage-error") << "module_degraded";
    }
    void priorityFailuresAndConflictNeverResend() {
        QFETCH(QString, outcome);
        Harness h; h.connectExisting(); h.editor.setPriority(2); h.editor.save();
        const auto put = h.requests.last();
        if (outcome == "deadline") h.editor.failed(put.id, outcome, 1);
        else h.editor.receive(put.id, put.command, {{"ok", false}, {"code", outcome}}, 1);
        QCOMPARE(h.editor.status(), outcome == "conflict" ? QString("conflict") : QString("error"));
        QCOMPARE(h.editor.priority().toInt(), 2); QVERIFY(h.editor.dirty());
        h.editor.setSession(true, 1, "persona-A"); QCOMPARE(h.puts(), 1);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.revision(), 37); QVERIFY(h.editor.dirty());
    }
    void priorityScopeChangeInvalidatesThePendingSaveAndOldGeneration() {
        Harness h; h.connectExisting(); h.editor.setPriority(2); h.editor.save();
        const auto put = h.requests.last(); h.editor.setSession(true, 1, "persona-B");
        const auto read = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QVERIFY(!h.editor.initialized()); QVERIFY(!h.editor.priorityConfirmed());
        h.editor.receive(read.id, read.command, snapshot(withPriority(existingArchive(), 7), 9), 1);
        QCOMPARE(h.editor.priority().toInt(), 7); QVERIFY(!h.editor.dirty());
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 0);
        QCOMPARE(h.editor.priority().toInt(), 7); QCOMPARE(h.editor.revision(), 9); QCOMPARE(h.puts(), 1);
    }
    void priorityDraftUsesTheExistingNavigationConfirmation() {
        Harness h; h.connectExisting(); const auto original = h.entryKey(0), other = h.entryKey(1);
        h.editor.setPriority(2); h.editor.selectEntry(other);
        QVERIFY(!h.editor.navigationPrompt().isEmpty()); h.editor.resolveNavigation("cancel");
        QCOMPARE(h.editor.selectedEntryKey(), original); QCOMPARE(h.editor.priority().toInt(), 2);
        h.editor.selectEntry(other); h.editor.resolveNavigation("save");
        const auto put = h.requests.last(); QCOMPARE(h.editor.selectedEntryKey(), original);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.selectedEntryKey(), other); QCOMPARE(h.editor.priority().toInt(), 11);
        QCOMPARE(h.puts(), 1);
    }
    void bookSettingsRoundTripChangesOnlyTheEditedValue_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("value");
        QTest::newRow("scan-depth-zero") << "scanDepth" << QVariant(0);
        QTest::newRow("scan-depth-three") << "scanDepth" << QVariant(3);
        QTest::newRow("scan-depth-maximum") << "scanDepth" << QVariant(200);
        QTest::newRow("token-budget-zero") << "tokenBudget" << QVariant(0);
        QTest::newRow("token-budget-maximum") << "tokenBudget" << QVariant(4000);
        QTest::newRow("recursion-on") << "recursiveScanning" << QVariant(true);
    }
    void bookSettingsRoundTripChangesOnlyTheEditedValue() {
        QFETCH(QString, key); QFETCH(QVariant, value);
        Harness h; h.connectExisting();
        h.editor.selectEntry({});
        QVERIFY(h.editor.hasBook()); QVERIFY(!h.editor.hasEntry());
        const auto states = h.editor.bookSettingStates();
        QCOMPARE(states.value("scanDepth").toMap().value("text").toString(), QString("23"));
        QCOMPARE(states.value("tokenBudget").toMap().value("text").toString(), QString("620"));
        QCOMPARE(states.value("recursiveScanning").toMap().value("text").toString(), QString("关闭"));
        for (const auto &name : {"scanDepth", "tokenBudget", "recursiveScanning"})
            QVERIFY(h.editor.bookSettingEditable(name));
        const auto books = h.editor.bookRows(), entries = h.editor.entryRows();
        if (key == "scanDepth") h.editor.setScanDepth(value);
        else if (key == "tokenBudget") h.editor.setBookTokenBudget(value);
        else h.editor.setRecursiveScanning(value);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave());
        QCOMPARE(h.editor.bookRows(), books); QCOMPARE(h.editor.entryRows(), entries);
        h.editor.save();
        const auto put = h.requests.last();
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        const auto expected = withBookSettings(existingArchive(), {{key, value}});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.advancedFields().value("book").toMap().value(key).toString(), value.toString());
        QCOMPARE(h.puts(), 1);
    }
    void bookSettingsRejectInvalidSetterInputsWithoutCoercion_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("value");
        QTest::newRow("scan-negative") << "scanDepth" << QVariant(-1);
        QTest::newRow("scan-beyond-ui-range") << "scanDepth" << QVariant(201);
        QTest::newRow("scan-numeric-string") << "scanDepth" << QVariant("3");
        QTest::newRow("scan-bool") << "scanDepth" << QVariant(true);
        QTest::newRow("scan-fraction") << "scanDepth" << QVariant(1.5);
        QTest::newRow("scan-missing") << "scanDepth" << QVariant{};
        QTest::newRow("budget-beyond-ui-range") << "tokenBudget" << QVariant(4001);
        QTest::newRow("budget-negative") << "tokenBudget" << QVariant(-50);
        QTest::newRow("budget-string") << "tokenBudget" << QVariant("100");
        QTest::newRow("recursion-number") << "recursiveScanning" << QVariant(1);
        QTest::newRow("recursion-string") << "recursiveScanning" << QVariant("true");
        QTest::newRow("recursion-missing") << "recursiveScanning" << QVariant{};
    }
    void bookSettingsRejectInvalidSetterInputsWithoutCoercion() {
        QFETCH(QString, key); QFETCH(QVariant, value);
        Harness h; h.connectExisting(); h.editor.selectEntry({});
        if (key == "scanDepth") h.editor.setScanDepth(value);
        else if (key == "tokenBudget") h.editor.setBookTokenBudget(value);
        else h.editor.setRecursiveScanning(value);
        QCOMPARE(h.editor.scanDepth().toInt(), 23); QCOMPARE(h.editor.bookTokenBudget().toInt(), 620);
        QCOMPARE(h.editor.recursiveScanning(), QVariant(false));
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void legacyBookSettingsOutsideTheUiRangeAreReadOnlyAndPreserved() {
        Harness h;
        const auto archive = withBookSettings(existingArchive(), {{"scanDepth", 201}, {"tokenBudget", qint64(4294967297LL)}});
        h.connectArchive(archive); h.editor.selectEntry({});
        for (const auto &key : {"scanDepth", "tokenBudget"}) {
            QVERIFY(h.editor.bookSettingConfirmed(key)); QVERIFY(!h.editor.bookSettingEditable(key));
        }
        QCOMPARE(h.editor.bookSettingStates().value("scanDepth").toMap().value("text").toString(), QString("201"));
        QCOMPARE(h.editor.bookSettingStates().value("tokenBudget").toMap().value("text").toString(), QString("4294967297"));
        QVERIFY(h.editor.bookSettingEditable("recursiveScanning"));
        h.editor.setScanDepth(3); h.editor.setBookTokenBudget(0); QVERIFY(!h.editor.dirty());
        h.editor.setTitle("Only the title changes"); h.editor.save();
        const auto put = h.requests.last();
        auto expected = archive;
        auto books = expected.value("worldBooks").toList(); auto book = books[0].toMap();
        book["name"] = "Only the title changes"; books[0] = book; expected["worldBooks"] = books;
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved"));
        QCOMPARE(h.editor.bookSettingStates().value("scanDepth").toMap().value("text").toString(), QString("201"));
    }
    void malformedBookSettingsRemainUnknownAndAreNeverDefaulted_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("value");
        QTest::newRow("scan-string") << "scanDepth" << QVariant("4");
        QTest::newRow("scan-bool") << "scanDepth" << QVariant(true);
        QTest::newRow("scan-fraction") << "scanDepth" << QVariant(4.5);
        QTest::newRow("scan-negative") << "scanDepth" << QVariant(-4);
        QTest::newRow("scan-null") << "scanDepth" << QVariant::fromValue(nullptr);
        QTest::newRow("budget-string") << "tokenBudget" << QVariant("500");
        QTest::newRow("recursion-number") << "recursiveScanning" << QVariant(1);
        QTest::newRow("recursion-string") << "recursiveScanning" << QVariant("true");
        QTest::newRow("recursion-null") << "recursiveScanning" << QVariant::fromValue(nullptr);
    }
    void malformedBookSettingsRemainUnknownAndAreNeverDefaulted() {
        QFETCH(QString, key); QFETCH(QVariant, value);
        Harness h; h.connectArchive(withBookSettings(existingArchive(), {{key, value}}));
        QVERIFY(!h.editor.initialized()); QCOMPARE(h.editor.status(), QString("read-error"));
        QVERIFY(!h.editor.bookSettingConfirmed(key)); QVERIFY(!h.editor.bookSettingEditable(key));
        h.editor.setScanDepth(3); h.editor.setRecursiveScanning(true); h.editor.setTitle("Must not be sent");
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void missingBookSettingsStayUnknownAndAbsentDuringOtherEdits() {
        Harness h;
        const auto archive = withBookSettings(existingArchive(),
            {{"scanDepth", QVariant{}}, {"tokenBudget", QVariant{}}, {"recursiveScanning", QVariant{}}});
        h.connectArchive(archive); h.editor.selectEntry({});
        QVERIFY(h.editor.initialized());
        for (const auto &key : {"scanDepth", "tokenBudget", "recursiveScanning"}) {
            QVERIFY(!h.editor.bookSettingConfirmed(key));
            QCOMPARE(h.editor.bookSettingStates().value(key).toMap().value("text").toString(), QString("未确认"));
        }
        h.editor.setScanDepth(3); h.editor.setBookTokenBudget(100); h.editor.setRecursiveScanning(true);
        QVERIFY(!h.editor.dirty());
        h.editor.setTitle("Only the title changes"); h.editor.save();
        const auto book = firstBook(h.requests.last().payload.value("archive").toMap());
        QCOMPARE(book.value("name").toString(), QString("Only the title changes"));
        for (const auto &key : {"scanDepth", "tokenBudget", "recursiveScanning"}) QVERIFY(!book.contains(key));
    }
    void partialBookSettingsSavePreservesMissingFields_data() {
        QTest::addColumn<QStringList>("missingKeys");
        QTest::addColumn<QString>("editedKey");
        QTest::addColumn<QVariant>("value");
        QTest::newRow("missing-depth-edit-budget")
            << QStringList{"scanDepth"} << "tokenBudget" << QVariant(100);
        QTest::newRow("missing-depth-edit-recursion")
            << QStringList{"scanDepth"} << "recursiveScanning" << QVariant(true);
        QTest::newRow("missing-budget-edit-depth")
            << QStringList{"tokenBudget"} << "scanDepth" << QVariant(3);
        QTest::newRow("missing-budget-edit-recursion")
            << QStringList{"tokenBudget"} << "recursiveScanning" << QVariant(true);
        QTest::newRow("missing-recursion-edit-depth")
            << QStringList{"recursiveScanning"} << "scanDepth" << QVariant(3);
        QTest::newRow("missing-recursion-edit-budget")
            << QStringList{"recursiveScanning"} << "tokenBudget" << QVariant(100);
        QTest::newRow("only-depth-present")
            << (QStringList{"tokenBudget", "recursiveScanning"}) << "scanDepth" << QVariant(3);
        QTest::newRow("only-budget-present")
            << (QStringList{"scanDepth", "recursiveScanning"}) << "tokenBudget" << QVariant(100);
        QTest::newRow("only-recursion-present")
            << (QStringList{"scanDepth", "tokenBudget"}) << "recursiveScanning" << QVariant(true);
    }
    void partialBookSettingsSavePreservesMissingFields() {
        QFETCH(QStringList, missingKeys); QFETCH(QString, editedKey); QFETCH(QVariant, value);
        QVariantMap missing;
        for (const auto &key : missingKeys) missing[key] = QVariant{};
        const auto archive = withBookSettings(existingArchive(), missing);
        Harness h; h.connectArchive(archive); h.editor.selectEntry({});
        QVERIFY(h.editor.initialized());
        for (const auto &key : missingKeys) {
            QVERIFY(!h.editor.bookSettingConfirmed(key)); QVERIFY(!h.editor.bookSettingEditable(key));
            QCOMPARE(h.editor.bookSettingStates().value(key).toMap().value("text").toString(), QString("未确认"));
        }
        QVERIFY(h.editor.bookSettingEditable(editedKey));
        if (editedKey == "scanDepth") h.editor.setScanDepth(value);
        else if (editedKey == "tokenBudget") h.editor.setBookTokenBudget(value);
        else h.editor.setRecursiveScanning(value);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); h.editor.save();
        const auto put = h.requests.last();
        const auto expected = withBookSettings(archive, {{editedKey, value}});
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        for (const auto &key : missingKeys) QVERIFY(!firstBook(expected).contains(key));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QCOMPARE(h.editor.revision(), 38);
        QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 1);
        for (const auto &key : missingKeys) {
            QVERIFY(!h.editor.bookSettingConfirmed(key));
            QVERIFY(!h.editor.advancedFields().value("book").toMap().contains(key));
        }
        QCOMPARE(h.editor.advancedFields().value("book").toMap().value(editedKey).toString(), value.toString());
    }
    void partialBookSettingsSaveRejectsChangedFieldPresence_data() {
        QTest::addColumn<QString>("missingKey");
        QTest::addColumn<QString>("editedKey");
        QTest::addColumn<QString>("changedKey");
        QTest::addColumn<bool>("addField");
        QTest::newRow("receipt-adds-missing-depth") << "scanDepth" << "tokenBudget" << "scanDepth" << true;
        QTest::newRow("receipt-adds-missing-budget") << "tokenBudget" << "recursiveScanning" << "tokenBudget" << true;
        QTest::newRow("receipt-adds-missing-recursion") << "recursiveScanning" << "scanDepth" << "recursiveScanning" << true;
        QTest::newRow("receipt-removes-untouched-depth") << "tokenBudget" << "recursiveScanning" << "scanDepth" << false;
        QTest::newRow("receipt-removes-untouched-budget") << "recursiveScanning" << "scanDepth" << "tokenBudget" << false;
        QTest::newRow("receipt-removes-untouched-recursion") << "scanDepth" << "tokenBudget" << "recursiveScanning" << false;
    }
    void partialBookSettingsSaveRejectsChangedFieldPresence() {
        QFETCH(QString, missingKey); QFETCH(QString, editedKey); QFETCH(QString, changedKey); QFETCH(bool, addField);
        const auto archive = withBookSettings(existingArchive(), {{missingKey, QVariant{}}});
        const QVariant value = editedKey == "recursiveScanning" ? QVariant(true)
                               : editedKey == "scanDepth" ? QVariant(3) : QVariant(100);
        Harness h; h.connectArchive(archive); h.editor.selectEntry({});
        QVERIFY(h.editor.initialized()); QVERIFY(h.editor.bookSettingEditable(editedKey));
        QVERIFY(!h.editor.bookSettingConfirmed(missingKey));
        if (editedKey == "scanDepth") h.editor.setScanDepth(value);
        else if (editedKey == "tokenBudget") h.editor.setBookTokenBudget(value);
        else h.editor.setRecursiveScanning(value);
        QVERIFY(h.editor.canSave()); h.editor.save();
        const auto put = h.requests.last();
        const auto expected = withBookSettings(archive, {{editedKey, value}});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        const auto changedValue = addField ? firstBook(existingArchive()).value(changedKey) : QVariant{};
        const auto altered = withBookSettings(expected, {{changedKey, changedValue}});
        QCOMPARE(firstBook(altered).contains(changedKey), addField);
        QVERIFY(firstBook(altered).contains(changedKey) != firstBook(expected).contains(changedKey));
        h.editor.receive(put.id, put.command, snapshot(altered, 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.puts(), 1);
        const auto draftValue = editedKey == "scanDepth" ? h.editor.scanDepth()
                                : editedKey == "tokenBudget" ? h.editor.bookTokenBudget() : h.editor.recursiveScanning();
        QCOMPARE(draftValue.toString(), value.toString());
        QVERIFY(!h.editor.bookSettingConfirmed(missingKey));
        // A rejected receipt must not become the next submission's baseline.
        QVERIFY(h.editor.canSave()); h.editor.save();
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 37);
        QCOMPARE(json(h.requests.last().payload.value("archive").toMap()), json(expected));
        QCOMPARE(h.puts(), 2);
    }
    void partialBookSettingsEditsDuringSaveKeepTheLaterValue() {
        const auto archive = withBookSettings(existingArchive(), {{"tokenBudget", QVariant{}}});
        Harness h; h.connectArchive(archive); h.editor.selectEntry({});
        QVERIFY(h.editor.initialized()); QVERIFY(!h.editor.bookSettingConfirmed("tokenBudget"));
        h.editor.setScanDepth(3); QVERIFY(h.editor.canSave()); h.editor.save();
        const auto put = h.requests.last();
        const auto submitted = withBookSettings(archive, {{"scanDepth", 3}});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(submitted));
        h.editor.setRecursiveScanning(true);
        h.editor.receive(put.id, put.command, snapshot(submitted, 38), 1);
        QCOMPARE(h.editor.status(), QString("dirty")); QCOMPARE(h.editor.revision(), 38);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.scanDepth().toInt(), 3);
        QCOMPARE(h.editor.recursiveScanning(), QVariant(true)); QVERIFY(!h.editor.bookSettingConfirmed("tokenBudget"));
        h.editor.save(); const auto laterPut = h.requests.last();
        const auto expected = withBookSettings(submitted, {{"recursiveScanning", true}});
        QCOMPARE(laterPut.payload.value("expected_revision").toInt(), 38);
        QCOMPARE(json(laterPut.payload.value("archive").toMap()), json(expected));
        QVERIFY(!firstBook(expected).contains("tokenBudget"));
        h.editor.receive(laterPut.id, laterPut.command, snapshot(expected, 39), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QCOMPARE(h.editor.revision(), 39);
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.bookSettingConfirmed("tokenBudget")); QCOMPARE(h.puts(), 2);
    }
    void bookSettingsReadFailureRequiresAConfirmedRead() {
        Harness h; h.connectExisting(); h.editor.selectEntry({}); h.editor.load();
        auto read = h.requests.last(); h.editor.failed(read.id, "deadline", 1);
        QCOMPARE(h.editor.scanDepth().toInt(), 23);
        QCOMPARE(h.editor.bookSettingStates().value("scanDepth").toMap().value("text").toString(), QString("未确认"));
        QVERIFY(!h.editor.bookSettingEditable("scanDepth")); h.editor.setScanDepth(3); QVERIFY(!h.editor.dirty());
        h.editor.load(); read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withBookSettings(existingArchive(), {{"scanDepth", 6}}), 38), 1);
        QVERIFY(h.editor.bookSettingEditable("scanDepth")); QCOMPARE(h.editor.scanDepth().toInt(), 6);
        QCOMPARE(h.puts(), 0);
    }
    void bookSettingsEditedBeforeAReadFailureCannotBeSaved() {
        Harness h; h.connectExisting(); h.editor.selectEntry({}); h.editor.setScanDepth(3);
        QVERIFY(h.editor.canSave());
        h.editor.reloadDiscardingDraft(); const auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        QVERIFY(h.editor.dirty()); QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.saveBlocker(), QString("书设置尚未确认，请重新读取档案；不会使用默认值覆盖。"));
        h.editor.save(); QCOMPARE(h.puts(), 0); QCOMPARE(h.editor.scanDepth().toInt(), 3);
    }
    void bookSettingsSaveRejectsMismatchedAuthorityAndPreservesDraft_data() {
        QTest::addColumn<QString>("fault");
        QTest::newRow("wrong-value") << "wrong";
        QTest::newRow("string-value") << "string";
        QTest::newRow("missing-value") << "missing";
        QTest::newRow("other-setting-changed") << "other";
        QTest::newRow("missing-book") << "book";
        QTest::newRow("wrong-revision") << "revision";
    }
    void bookSettingsSaveRejectsMismatchedAuthorityAndPreservesDraft() {
        QFETCH(QString, fault);
        Harness h; h.connectExisting(); h.editor.selectEntry({}); h.editor.setScanDepth(3); h.editor.save();
        const auto put = h.requests.last(); auto archive = put.payload.value("archive").toMap();
        if (fault == "wrong") archive = withBookSettings(archive, {{"scanDepth", 4}});
        if (fault == "string") archive = withBookSettings(archive, {{"scanDepth", "3"}});
        if (fault == "missing") archive = withBookSettings(archive, {{"scanDepth", QVariant{}}});
        if (fault == "other") archive = withBookSettings(archive, {{"tokenBudget", 500}});
        if (fault == "book") archive = withoutBook(archive, 0);
        h.editor.receive(put.id, put.command, snapshot(archive, fault == "revision" ? 37 : 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.scanDepth().toInt(), 3); QVERIFY(h.editor.dirty()); QCOMPARE(h.puts(), 1);
    }
    void bookSettingsEditsDuringSaveKeepTheLaterValue() {
        Harness h; h.connectExisting(); h.editor.selectEntry({});
        h.editor.setScanDepth(3); h.editor.save();
        const auto put = h.requests.last(); h.editor.setRecursiveScanning(true);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.status(), QString("dirty")); QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.scanDepth().toInt(), 3); QCOMPARE(h.editor.recursiveScanning(), QVariant(true));
        h.editor.save();
        const auto book = firstBook(h.requests.last().payload.value("archive").toMap());
        QCOMPARE(book.value("scanDepth").toInt(), 3); QCOMPARE(book.value("recursiveScanning"), QVariant(true));
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 38);
    }
    void bookSettingsUntouchedDuringReadFollowTheNewerAuthority() {
        Harness h; h.connectExisting(); h.editor.selectEntry({}); h.editor.load();
        const auto read = h.requests.last();
        h.editor.setTitle("Typed while the read is pending"); h.editor.setBookTokenBudget(100);
        const auto current = withBookSettings(existingArchive(), {{"scanDepth", 30}, {"tokenBudget", 700}});
        h.editor.receive(read.id, read.command, snapshot(current, 38), 1);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.scanDepth().toInt(), 30);
        QCOMPARE(h.editor.bookTokenBudget().toInt(), 100);
        h.editor.save();
        const auto book = firstBook(h.requests.last().payload.value("archive").toMap());
        QCOMPARE(book.value("scanDepth").toInt(), 30); QCOMPARE(book.value("tokenBudget").toInt(), 100);
        QCOMPARE(book.value("name").toString(), QString("Typed while the read is pending"));
    }
    void bookSettingsNewBookKeepsItsDefaultsUnlessEdited() {
        Harness h; h.connectExisting(); h.editor.newBook();
        QCOMPARE(h.editor.scanDepth().toInt(), 50); QCOMPARE(h.editor.bookTokenBudget().toInt(), 500);
        QCOMPARE(h.editor.recursiveScanning(), QVariant(false));
        for (const auto &key : {"scanDepth", "tokenBudget", "recursiveScanning"}) QVERIFY(h.editor.bookSettingEditable(key));
        h.editor.setScanDepth(3); h.editor.setRecursiveScanning(true); h.editor.save();
        const auto put = h.requests.last();
        const auto book = put.payload.value("archive").toMap().value("worldBooks").toList().last().toMap();
        QCOMPARE(book.value("scanDepth").toInt(), 3); QCOMPARE(book.value("tokenBudget").toInt(), 500);
        QCOMPARE(book.value("recursiveScanning"), QVariant(true));
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
    }
    void bookSettingsDraftUsesTheExistingNavigationConfirmation() {
        Harness h; h.connectExisting(); const auto entry = h.entryKey(0);
        h.editor.selectEntry({}); h.editor.setBookTokenBudget(0); h.editor.selectEntry(entry);
        QVERIFY(!h.editor.navigationPrompt().isEmpty()); h.editor.resolveNavigation("cancel");
        QVERIFY(!h.editor.hasEntry()); QCOMPARE(h.editor.bookTokenBudget().toInt(), 0);
        h.editor.selectEntry(entry); h.editor.resolveNavigation("save");
        const auto put = h.requests.last(); QVERIFY(!h.editor.hasEntry());
        QCOMPARE(firstBook(put.payload.value("archive").toMap()).value("tokenBudget").toInt(), 0);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.selectedEntryKey(), entry); QCOMPARE(h.editor.bookTokenBudget().toInt(), 0);
        QCOMPARE(h.puts(), 1);
    }
    void bookSettingsScopeChangeDiscardsTheOldDraftAndReceipt() {
        Harness h; h.connectExisting(); h.editor.selectEntry({}); h.editor.setScanDepth(3); h.editor.save();
        const auto put = h.requests.last(); h.editor.setSession(true, 1, "persona-B");
        const auto read = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QVERIFY(!h.editor.initialized()); QVERIFY(!h.editor.bookSettingConfirmed("scanDepth"));
        h.editor.receive(read.id, read.command, snapshot(withBookSettings(existingArchive(), {{"scanDepth", 9}}), 9), 1);
        QCOMPARE(h.editor.scanDepth().toInt(), 9); QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 1);
    }
    void entrySettingsOverrideRoundTripChangesOnlyTheEditedValue_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<int>("value");
        QTest::addColumn<bool>("regex");
        QTest::newRow("scan-zero") << "scanDepth" << 0 << false;
        QTest::newRow("scan-five") << "scanDepth" << 5 << false;
        QTest::newRow("scan-maximum") << "scanDepth" << 200 << false;
        QTest::newRow("budget-zero") << "tokenBudget" << 0 << false;
        QTest::newRow("budget-fifty") << "tokenBudget" << 50 << false;
        QTest::newRow("budget-maximum") << "tokenBudget" << 4000 << false;
        QTest::newRow("regex-scan-five") << "scanDepth" << 5 << true;
        QTest::newRow("regex-budget-fifty") << "tokenBudget" << 50 << true;
    }
    void entrySettingsOverrideRoundTripChangesOnlyTheEditedValue() {
        QFETCH(QString, key); QFETCH(int, value); QFETCH(bool, regex);
        auto archive = existingArchive();
        if (regex) archive = withEntrySettings(archive, {{"useRegex", true}});
        Harness h; h.connectArchive(archive);
        QVERIFY(h.editor.hasEntry());
        const auto states = h.editor.entrySettingStates();
        QCOMPARE(states.value("scanDepth").toMap().value("text").toString(), QString("17"));
        QCOMPARE(states.value("tokenBudget").toMap().value("text").toString(), QString("320"));
        for (const auto &name : {"scanDepth", "tokenBudget"}) {
            QVERIFY(h.editor.entrySettingEditable(name)); QVERIFY(!h.editor.entrySettingInherited(name));
        }
        const auto rows = h.editor.entryRows();
        if (key == "scanDepth") h.editor.setEntryScanDepth(value); else h.editor.setEntryTokenBudget(value);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); QCOMPARE(h.editor.entryRows(), rows);
        h.editor.save();
        const auto put = h.requests.last();
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        const auto expected = withEntrySettings(archive, {{key, value}});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.entrySettingStates().value(key).toMap().value("text").toString(), QString::number(value));
        QCOMPARE(h.puts(), 1);
    }
    void entrySettingsRejectInvalidSetterInputsWithoutCoercion_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("value");
        QTest::newRow("scan-negative") << "scanDepth" << QVariant(-1);
        QTest::newRow("scan-beyond-ui-range") << "scanDepth" << QVariant(201);
        QTest::newRow("scan-numeric-string") << "scanDepth" << QVariant("3");
        QTest::newRow("scan-bool") << "scanDepth" << QVariant(true);
        QTest::newRow("scan-fraction") << "scanDepth" << QVariant(1.5);
        QTest::newRow("scan-missing") << "scanDepth" << QVariant{};
        QTest::newRow("scan-null") << "scanDepth" << jsonNull();
        QTest::newRow("budget-beyond-ui-range") << "tokenBudget" << QVariant(4001);
        QTest::newRow("budget-negative") << "tokenBudget" << QVariant(-50);
        QTest::newRow("budget-string") << "tokenBudget" << QVariant("100");
        QTest::newRow("budget-null") << "tokenBudget" << jsonNull();
    }
    void entrySettingsRejectInvalidSetterInputsWithoutCoercion() {
        QFETCH(QString, key); QFETCH(QVariant, value);
        Harness h; h.connectExisting();
        if (key == "scanDepth") h.editor.setEntryScanDepth(value); else h.editor.setEntryTokenBudget(value);
        QCOMPARE(h.editor.entryScanDepth().toInt(), 17); QCOMPARE(h.editor.entryTokenBudget().toInt(), 320);
        QVERIFY(!h.editor.entrySettingInherited(key));
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void entrySettingsInheritWritesNullAndOverrideStartsFromTheSnapshotBook_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<int>("bookValue");
        QTest::newRow("scan-depth") << "scanDepth" << 23;
        QTest::newRow("token-budget") << "tokenBudget" << 620;
    }
    void entrySettingsInheritWritesNullAndOverrideStartsFromTheSnapshotBook() {
        QFETCH(QString, key); QFETCH(int, bookValue);
        Harness h; h.connectExisting();
        const QString other = key == "scanDepth" ? "tokenBudget" : "scanDepth";
        h.editor.setEntrySettingInherited(key, true);
        QVERIFY(h.editor.entrySettingInherited(key)); QVERIFY(!h.editor.entrySettingInherited(other));
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave());
        auto state = h.editor.entrySettingStates().value(key).toMap();
        QCOMPARE(state.value("text").toString(), QString("跟随本书"));
        QCOMPARE(state.value("bookText").toString(), QString::number(bookValue));
        QVERIFY(state.value("canOverride").toBool()); QVERIFY(state.value("present").toBool());
        h.editor.save();
        auto put = h.requests.last();
        const auto inherited = withEntrySettings(existingArchive(), {{key, jsonNull()}});
        QCOMPARE(json(put.payload.value("archive").toMap()), json(inherited));
        QVERIFY(isJsonNull(firstEntry(put.payload.value("archive").toMap()).value(key)));
        h.editor.receive(put.id, put.command, snapshot(inherited, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
        QVERIFY(h.editor.entrySettingInherited(key));
        // The override starts from this snapshot's book value, then edits it.
        h.editor.setEntrySettingInherited(key, false);
        QCOMPARE((key == "scanDepth" ? h.editor.entryScanDepth() : h.editor.entryTokenBudget()).toInt(), bookValue);
        QVERIFY(h.editor.dirty());
        if (key == "scanDepth") h.editor.setEntryScanDepth(bookValue + 2); else h.editor.setEntryTokenBudget(bookValue - 50);
        h.editor.save(); put = h.requests.last();
        const auto overridden = withEntrySettings(inherited, {{key, key == "scanDepth" ? bookValue + 2 : bookValue - 50}});
        QCOMPARE(put.payload.value("expected_revision").toInt(), 38);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(overridden));
        h.editor.receive(put.id, put.command, snapshot(overridden, 39), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.entrySettingInherited(key)); QCOMPARE(h.puts(), 2);
    }
    void absentEntrySettingsFollowTheBookAndOnlyTheEditedFieldIsWritten_data() {
        QTest::addColumn<QString>("receipt");
        QTest::addColumn<bool>("accepted");
        QTest::newRow("store-normalized-null") << "normalized" << true;
        QTest::newRow("receipt-keeps-field-absent") << "absent" << false;
        QTest::newRow("receipt-supplies-default") << "default" << false;
        QTest::newRow("receipt-zero-for-null") << "zero" << false;
    }
    void absentEntrySettingsFollowTheBookAndOnlyTheEditedFieldIsWritten() {
        QFETCH(QString, receipt); QFETCH(bool, accepted);
        Harness h; h.connectExisting(); h.editor.selectEntry(h.entryKey(1));
        for (const auto &key : {"scanDepth", "tokenBudget"}) {
            const auto state = h.editor.entrySettingStates().value(key).toMap();
            QVERIFY(state.value("confirmed").toBool()); QVERIFY(state.value("inherited").toBool());
            QVERIFY(!state.value("present").toBool()); QVERIFY(state.value("canOverride").toBool());
        }
        h.editor.setEntrySettingInherited("scanDepth", false); QCOMPARE(h.editor.entryScanDepth().toInt(), 23);
        h.editor.setEntryScanDepth(25); QVERIFY(h.editor.canSave()); h.editor.save();
        const auto put = h.requests.last();
        const auto submitted = withEntrySettings(existingArchive(), {{"scanDepth", 25}}, 0, 1);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(submitted));
        QVERIFY(!entryAt(put.payload.value("archive").toMap(), 0, 1).contains("tokenBudget"));
        const QVariant budget = receipt == "normalized" ? jsonNull() : receipt == "default" ? QVariant(620)
                                : receipt == "zero" ? QVariant(0) : QVariant{};
        h.editor.receive(put.id, put.command, snapshot(withEntrySettings(submitted, {{"tokenBudget", budget}}, 0, 1), 38), 1);
        QCOMPARE(h.editor.status(), accepted ? QString("saved") : QString("error"));
        QCOMPARE(h.editor.revision(), accepted ? 38 : 37); QCOMPARE(h.editor.dirty(), !accepted);
        QCOMPARE(h.editor.entryScanDepth().toInt(), 25); QCOMPARE(h.puts(), 1);
    }
    void reinheritingAnAbsentFieldRestoresItsReadFormWithoutAWrite() {
        Harness h; h.connectExisting(); h.editor.selectEntry(h.entryKey(1));
        h.editor.setEntrySettingInherited("tokenBudget", false); h.editor.setEntryTokenBudget(50);
        QVERIFY(h.editor.dirty());
        h.editor.setEntrySettingInherited("tokenBudget", true);
        QVERIFY(h.editor.entrySettingInherited("tokenBudget")); QVERIFY(!h.editor.entryTokenBudget().isValid());
        QVERIFY(!h.editor.entrySettingStates().value("tokenBudget").toMap().value("present").toBool());
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.setContent("Only the content changes"); h.editor.save();
        QVERIFY(!entryAt(h.requests.last().payload.value("archive").toMap(), 0, 1).contains("tokenBudget"));
    }
    void absentEntrySettingsReinheritBeforeDispatchLeavesNoWrite_data() {
        QTest::addColumn<QString>("key");
        QTest::newRow("scan-depth") << "scanDepth";
        QTest::newRow("token-budget") << "tokenBudget";
    }
    void absentEntrySettingsReinheritBeforeDispatchLeavesNoWrite() {
        QFETCH(QString, key);
        const auto archive = withEntrySettings(existingArchive(), {{"scanDepth", QVariant{}}, {"tokenBudget", QVariant{}}});
        Harness h; h.connectArchive(archive);
        h.editor.setEntrySettingInherited(key, false);
        if (key == "scanDepth") h.editor.setEntryScanDepth(5); else h.editor.setEntryTokenBudget(50);
        QVERIFY(h.editor.dirty());
        h.editor.setEntrySettingInherited(key, true);
        QVERIFY(h.editor.entrySettingInherited(key));
        QVERIFY(!h.editor.entrySettingStates().value(key).toMap().value("present").toBool());
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 0);
        h.editor.setContent("Only content changes after cancelling the override"); h.editor.save();
        const auto entry = firstEntry(h.requests.last().payload.value("archive").toMap());
        QVERIFY(!entry.contains("scanDepth")); QVERIFY(!entry.contains("tokenBudget"));
        QCOMPARE(h.puts(), 1);
    }
    void absentEntrySettingsReinheritDuringSaveOrReadWritesNull_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QString>("operation");
        QTest::newRow("existing-save-scan-depth") << "scanDepth" << "save";
        QTest::newRow("existing-save-token-budget") << "tokenBudget" << "save";
        QTest::newRow("existing-read-scan-depth") << "scanDepth" << "read";
        QTest::newRow("existing-read-token-budget") << "tokenBudget" << "read";
        QTest::newRow("new-save-scan-depth") << "scanDepth" << "new-save";
        QTest::newRow("new-save-token-budget") << "tokenBudget" << "new-save";
    }
    void absentEntrySettingsReinheritDuringSaveOrReadWritesNull() {
        QFETCH(QString, key); QFETCH(QString, operation);
        const auto archive = withEntrySettings(existingArchive(), {{"scanDepth", QVariant{}}, {"tokenBudget", QVariant{}}});
        Harness h; h.connectArchive(archive);
        const bool read = operation == "read", created = operation == "new-save";
        const int index = created ? 2 : 0;
        const int overrideValue = key == "scanDepth" ? 5 : 50;
        if (created) { h.editor.newEntry(); h.editor.setContent("New entry with a later inherit intent"); }
        if (read) h.editor.load();
        h.editor.setEntrySettingInherited(key, false);
        if (key == "scanDepth") h.editor.setEntryScanDepth(overrideValue); else h.editor.setEntryTokenBudget(overrideValue);
        if (!read) h.editor.save();
        const auto pending = h.requests.last();
        QCOMPARE(pending.command, read ? QString("archive:get") : QString("archive:put"));
        const auto responseArchive = storedEntrySettings(read ? withEntrySettings(archive, {{key, overrideValue}})
                                                              : pending.payload.value("archive").toMap());
        h.editor.setEntrySettingInherited(key, true);
        QVERIFY(h.editor.entrySettingInherited(key));
        QVERIFY(!h.editor.entrySettingStates().value(key).toMap().value("present").toBool());
        h.editor.receive(pending.id, pending.command, snapshot(responseArchive, 38), 1);
        QCOMPARE(h.editor.revision(), 38); QCOMPARE(h.editor.status(), QString("dirty"));
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.canSave()); QVERIFY(h.editor.entrySettingInherited(key));
        QCOMPARE(h.puts(), read ? 0 : 1); // Receiving authority never retries the later edit.
        h.editor.save(); const auto put = h.requests.last();
        QCOMPARE(put.payload.value("expected_revision").toInt(), 38);
        const auto saved = put.payload.value("archive").toMap();
        QVERIFY(entryAt(saved, 0, index).contains(key));
        QVERIFY(isJsonNull(entryAt(saved, 0, index).value(key)));
        QCOMPARE(json(saved), json(withEntrySettings(responseArchive, {{key, jsonNull()}}, 0, index)));
        h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(saved), 39), 1);
        QCOMPARE(h.editor.status(), QString("saved")); QVERIFY(!h.editor.dirty());
        QVERIFY(h.editor.entrySettingInherited(key)); QCOMPARE(h.puts(), read ? 1 : 2);
    }
    void retainedAbsentInheritanceAdoptsCanonicalNullWithoutAnotherWrite_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<bool>("save");
        QTest::newRow("save-scan-depth") << "scanDepth" << true;
        QTest::newRow("save-token-budget") << "tokenBudget" << true;
        QTest::newRow("read-scan-depth") << "scanDepth" << false;
        QTest::newRow("read-token-budget") << "tokenBudget" << false;
    }
    void retainedAbsentInheritanceAdoptsCanonicalNullWithoutAnotherWrite() {
        QFETCH(QString, key); QFETCH(bool, save);
        const auto archive = withEntrySettings(existingArchive(), {{"scanDepth", QVariant{}}, {"tokenBudget", QVariant{}}});
        Harness h; h.connectArchive(archive);
        if (save) { h.editor.setContent("Content submitted while settings still inherit"); h.editor.save(); }
        else h.editor.load();
        const auto pending = h.requests.last();
        h.editor.setEntrySettingInherited(key, false);
        if (key == "scanDepth") h.editor.setEntryScanDepth(5); else h.editor.setEntryTokenBudget(50);
        h.editor.setEntrySettingInherited(key, true);
        const auto returned = storedEntrySettings(save ? pending.payload.value("archive").toMap() : archive);
        h.editor.receive(pending.id, pending.command, snapshot(returned, 38), 1);
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.status(), save ? QString("saved") : QString("clean"));
        QVERIFY(h.editor.entrySettingInherited(key));
        QVERIFY(h.editor.entrySettingStates().value(key).toMap().value("present").toBool());
        QVERIFY(!h.editor.dirty()); QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), save ? 1 : 0);
    }
    void uneditedEntrySettingsBindEverySelectedEntrySave_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QString>("initial");
        QTest::addColumn<QString>("receipt");
        QTest::newRow("scan-absent-accepted") << "scanDepth" << "absent" << "accepted";
        QTest::newRow("scan-absent-missing") << "scanDepth" << "absent" << "missing";
        QTest::newRow("scan-absent-zero") << "scanDepth" << "absent" << "opposite";
        QTest::newRow("scan-absent-wrong-integer") << "scanDepth" << "absent" << "integer";
        QTest::newRow("scan-absent-string") << "scanDepth" << "absent" << "string";
        QTest::newRow("scan-absent-bool") << "scanDepth" << "absent" << "bool";
        QTest::newRow("scan-null-accepted") << "scanDepth" << "null" << "accepted";
        QTest::newRow("scan-null-missing") << "scanDepth" << "null" << "missing";
        QTest::newRow("scan-null-zero") << "scanDepth" << "null" << "opposite";
        QTest::newRow("scan-null-wrong-integer") << "scanDepth" << "null" << "integer";
        QTest::newRow("scan-null-string") << "scanDepth" << "null" << "string";
        QTest::newRow("scan-null-bool") << "scanDepth" << "null" << "bool";
        QTest::newRow("scan-integer-accepted") << "scanDepth" << "integer" << "accepted";
        QTest::newRow("scan-integer-missing") << "scanDepth" << "integer" << "missing";
        QTest::newRow("scan-integer-null") << "scanDepth" << "integer" << "opposite";
        QTest::newRow("scan-integer-wrong-integer") << "scanDepth" << "integer" << "integer";
        QTest::newRow("scan-integer-string") << "scanDepth" << "integer" << "string";
        QTest::newRow("scan-integer-bool") << "scanDepth" << "integer" << "bool";
        QTest::newRow("scan-new-accepted") << "scanDepth" << "new" << "accepted";
        QTest::newRow("scan-new-missing") << "scanDepth" << "new" << "missing";
        QTest::newRow("scan-new-zero") << "scanDepth" << "new" << "opposite";
        QTest::newRow("scan-new-wrong-integer") << "scanDepth" << "new" << "integer";
        QTest::newRow("scan-new-string") << "scanDepth" << "new" << "string";
        QTest::newRow("scan-new-bool") << "scanDepth" << "new" << "bool";
        QTest::newRow("budget-absent-accepted") << "tokenBudget" << "absent" << "accepted";
        QTest::newRow("budget-absent-missing") << "tokenBudget" << "absent" << "missing";
        QTest::newRow("budget-absent-zero") << "tokenBudget" << "absent" << "opposite";
        QTest::newRow("budget-absent-wrong-integer") << "tokenBudget" << "absent" << "integer";
        QTest::newRow("budget-absent-string") << "tokenBudget" << "absent" << "string";
        QTest::newRow("budget-absent-bool") << "tokenBudget" << "absent" << "bool";
        QTest::newRow("budget-null-accepted") << "tokenBudget" << "null" << "accepted";
        QTest::newRow("budget-null-missing") << "tokenBudget" << "null" << "missing";
        QTest::newRow("budget-null-zero") << "tokenBudget" << "null" << "opposite";
        QTest::newRow("budget-null-wrong-integer") << "tokenBudget" << "null" << "integer";
        QTest::newRow("budget-null-string") << "tokenBudget" << "null" << "string";
        QTest::newRow("budget-null-bool") << "tokenBudget" << "null" << "bool";
        QTest::newRow("budget-integer-accepted") << "tokenBudget" << "integer" << "accepted";
        QTest::newRow("budget-integer-missing") << "tokenBudget" << "integer" << "missing";
        QTest::newRow("budget-integer-null") << "tokenBudget" << "integer" << "opposite";
        QTest::newRow("budget-integer-wrong-integer") << "tokenBudget" << "integer" << "integer";
        QTest::newRow("budget-integer-string") << "tokenBudget" << "integer" << "string";
        QTest::newRow("budget-integer-bool") << "tokenBudget" << "integer" << "bool";
        QTest::newRow("budget-new-accepted") << "tokenBudget" << "new" << "accepted";
        QTest::newRow("budget-new-missing") << "tokenBudget" << "new" << "missing";
        QTest::newRow("budget-new-zero") << "tokenBudget" << "new" << "opposite";
        QTest::newRow("budget-new-wrong-integer") << "tokenBudget" << "new" << "integer";
        QTest::newRow("budget-new-string") << "tokenBudget" << "new" << "string";
        QTest::newRow("budget-new-bool") << "tokenBudget" << "new" << "bool";
    }
    void uneditedEntrySettingsBindEverySelectedEntrySave() {
        QFETCH(QString, key); QFETCH(QString, initial); QFETCH(QString, receipt);
        auto archive = existingArchive();
        if (initial == "absent") archive = withEntrySettings(archive, {{"scanDepth", QVariant{}}, {"tokenBudget", QVariant{}}});
        if (initial == "null") archive = withEntrySettings(archive, {{"scanDepth", jsonNull()}, {"tokenBudget", jsonNull()}});
        Harness h; h.connectArchive(archive);
        if (initial == "new") h.editor.newEntry();
        const int index = initial == "new" ? 2 : 0;
        const bool inherited = initial != "integer";
        const auto selected = h.editor.selectedEntryKey();
        const auto oldSettings = initial == "new" ? QVariantMap{} : firstEntry(archive);
        h.editor.setContent("Content-only save must also bind inherited settings"); h.editor.save();
        const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        const auto entry = entryAt(submitted, 0, index);
        for (const auto &field : {"scanDepth", "tokenBudget"}) {
            QCOMPARE(entry.contains(field), oldSettings.contains(field));
            QCOMPARE(entry.value(field), oldSettings.value(field));
        }
        auto returned = storedEntrySettings(submitted);
        if (receipt == "missing") returned = withEntrySettings(returned, {{key, QVariant{}}}, 0, index);
        if (receipt == "opposite") returned = withEntrySettings(returned, {{key, inherited ? QVariant(0) : jsonNull()}}, 0, index);
        if (receipt == "integer") returned = withEntrySettings(returned, {{key, 9}}, 0, index);
        if (receipt == "string") returned = withEntrySettings(returned, {{key, inherited ? QVariant("null") : QVariant(oldSettings.value(key).toString())}}, 0, index);
        if (receipt == "bool") returned = withEntrySettings(returned, {{key, false}}, 0, index);
        h.editor.receive(put.id, put.command, snapshot(returned, 38), 1);
        const bool accepted = receipt == "accepted";
        QCOMPARE(h.editor.status(), accepted ? QString("saved") : QString("error"));
        QCOMPARE(h.editor.revision(), accepted ? 38 : 37);
        QCOMPARE(h.editor.dirty(), !accepted); QCOMPARE(h.editor.newLocal(), !accepted && initial == "new");
        QCOMPARE(h.editor.selectedEntryKey(), selected);
        QCOMPARE(h.editor.content(), QString("Content-only save must also bind inherited settings"));
        QCOMPARE(h.editor.entrySettingInherited(key), inherited); QCOMPARE(h.puts(), 1);
        if (!accepted) {
            // A rejected ACK cannot be repaired by a second response for the
            // same request, and there is no implicit retry.
            h.editor.receive(put.id, put.command, snapshot(storedEntrySettings(submitted), 38), 1);
            QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
            QVERIFY(h.editor.dirty()); QCOMPARE(h.puts(), 1);
        }
    }
    void entrySettingsSaveRejectsMismatchedAuthorityAndPreservesDraft_data() {
        QTest::addColumn<bool>("inherit");
        QTest::addColumn<QString>("fault");
        QTest::newRow("override-wrong-value") << false << "wrong";
        QTest::newRow("override-null-for-integer") << false << "null";
        QTest::newRow("override-string-value") << false << "string";
        QTest::newRow("override-missing-value") << false << "missing";
        QTest::newRow("override-other-setting-changed") << false << "other";
        QTest::newRow("override-other-setting-nulled") << false << "other-null";
        QTest::newRow("override-missing-entry") << false << "entry";
        QTest::newRow("override-wrong-revision") << false << "revision";
        QTest::newRow("inherit-zero-for-null") << true << "zero";
        QTest::newRow("inherit-integer-for-null") << true << "integer";
        QTest::newRow("inherit-missing-value") << true << "missing";
    }
    void entrySettingsSaveRejectsMismatchedAuthorityAndPreservesDraft() {
        QFETCH(bool, inherit); QFETCH(QString, fault);
        Harness h; h.connectExisting();
        if (inherit) h.editor.setEntrySettingInherited("scanDepth", true); else h.editor.setEntryScanDepth(5);
        h.editor.save();
        const auto put = h.requests.last(); auto archive = put.payload.value("archive").toMap();
        if (fault == "wrong") archive = withEntrySettings(archive, {{"scanDepth", 6}});
        if (fault == "null") archive = withEntrySettings(archive, {{"scanDepth", jsonNull()}});
        if (fault == "string") archive = withEntrySettings(archive, {{"scanDepth", "5"}});
        if (fault == "missing") archive = withEntrySettings(archive, {{"scanDepth", QVariant{}}});
        if (fault == "other") archive = withEntrySettings(archive, {{"tokenBudget", 321}});
        if (fault == "other-null") archive = withEntrySettings(archive, {{"tokenBudget", jsonNull()}});
        if (fault == "entry") archive = withoutEntry(archive, 0, 0);
        if (fault == "zero") archive = withEntrySettings(archive, {{"scanDepth", 0}});
        if (fault == "integer") archive = withEntrySettings(archive, {{"scanDepth", 23}});
        h.editor.receive(put.id, put.command, snapshot(archive, fault == "revision" ? 37 : 38), 1);
        QCOMPARE(h.editor.status(), QString("error")); QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty()); QCOMPARE(h.puts(), 1);
        if (inherit) QVERIFY(h.editor.entrySettingInherited("scanDepth"));
        else QCOMPARE(h.editor.entryScanDepth().toInt(), 5);
    }
    void legacyEntrySettingsOutsideTheUiRangeAreReadOnlyIncludingTheInheritSwitch() {
        const auto archive = withEntrySettings(existingArchive(), {{"scanDepth", 201}, {"tokenBudget", qint64(4294967297LL)}});
        Harness h; h.connectArchive(archive);
        for (const auto &key : {"scanDepth", "tokenBudget"}) {
            QVERIFY(h.editor.entrySettingConfirmed(key)); QVERIFY(!h.editor.entrySettingEditable(key));
            QVERIFY(!h.editor.entrySettingInherited(key)); QVERIFY(!h.editor.entrySettingCanOverride(key));
            h.editor.setEntrySettingInherited(key, true);
        }
        QCOMPARE(h.editor.entrySettingStates().value("scanDepth").toMap().value("text").toString(), QString("201"));
        QCOMPARE(h.editor.entrySettingStates().value("tokenBudget").toMap().value("text").toString(), QString("4294967297"));
        h.editor.setEntryScanDepth(3); h.editor.setEntryTokenBudget(50); QVERIFY(!h.editor.dirty());
        h.editor.setContent("Only the content changes"); h.editor.save();
        const auto put = h.requests.last();
        const auto entry = firstEntry(put.payload.value("archive").toMap());
        QCOMPARE(entry.value("scanDepth").toInt(), 201); QCOMPARE(entry.value("tokenBudget").toLongLong(), 4294967297LL);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.status(), QString("saved"));
        QCOMPARE(h.editor.entrySettingStates().value("scanDepth").toMap().value("text").toString(), QString("201"));
    }
    void malformedEntrySettingsInAnyEntryInvalidateTheRead_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("value");
        QTest::addColumn<int>("book");
        QTest::addColumn<int>("entry");
        QTest::newRow("selected-scan-string") << "scanDepth" << QVariant("4") << 0 << 0;
        QTest::newRow("selected-scan-bool") << "scanDepth" << QVariant(true) << 0 << 0;
        QTest::newRow("selected-scan-fraction") << "scanDepth" << QVariant(4.5) << 0 << 0;
        QTest::newRow("selected-scan-negative") << "scanDepth" << QVariant(-4) << 0 << 0;
        QTest::newRow("selected-budget-string") << "tokenBudget" << QVariant("500") << 0 << 0;
        QTest::newRow("selected-budget-object") << "tokenBudget" << QVariant(QVariantMap{{"value", 5}}) << 0 << 0;
        QTest::newRow("sibling-scan-string") << "scanDepth" << QVariant("4") << 0 << 1;
        QTest::newRow("other-book-budget-negative") << "tokenBudget" << QVariant(-1) << 1 << 0;
    }
    void malformedEntrySettingsInAnyEntryInvalidateTheRead() {
        QFETCH(QString, key); QFETCH(QVariant, value); QFETCH(int, book); QFETCH(int, entry);
        Harness h; h.connectArchive(withEntrySettings(existingArchive(), {{key, value}}, book, entry));
        QVERIFY(!h.editor.initialized()); QCOMPARE(h.editor.status(), QString("read-error"));
        QVERIFY(!h.editor.entrySettingConfirmed(key)); QVERIFY(!h.editor.entrySettingEditable(key));
        h.editor.setEntrySettingInherited(key, true); h.editor.setContent("Must not be sent");
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void entryOverrideNeedsAConfirmedInRangeBookValue_data() {
        QTest::addColumn<QString>("key");
        QTest::addColumn<QVariant>("bookValue");
        QTest::newRow("book-scan-missing") << "scanDepth" << QVariant{};
        QTest::newRow("book-scan-beyond-ui-range") << "scanDepth" << QVariant(201);
        QTest::newRow("book-budget-missing") << "tokenBudget" << QVariant{};
        QTest::newRow("book-budget-beyond-ui-range") << "tokenBudget" << QVariant(qint64(4294967297LL));
    }
    void entryOverrideNeedsAConfirmedInRangeBookValue() {
        QFETCH(QString, key); QFETCH(QVariant, bookValue);
        Harness h; h.connectArchive(withBookSettings(existingArchive(), {{key, bookValue}}));
        h.editor.selectEntry(h.entryKey(1));
        QVERIFY(h.editor.entrySettingEditable(key)); QVERIFY(h.editor.entrySettingInherited(key));
        QVERIFY(!h.editor.entrySettingCanOverride(key));
        QCOMPARE(h.editor.entrySettingStates().value(key).toMap().value("bookText").toString(), QString());
        h.editor.setEntrySettingInherited(key, false);
        QVERIFY(h.editor.entrySettingInherited(key)); QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 0);
    }
    void entryOverrideIgnoresAnUnsavedBookDraft() {
        Harness h; h.connectExisting(); h.editor.selectEntry(h.entryKey(1));
        h.editor.setScanDepth(3); QCOMPARE(h.editor.scanDepth().toInt(), 3);
        h.editor.setEntrySettingInherited("scanDepth", false);
        QCOMPARE(h.editor.entryScanDepth().toInt(), 23);
    }
    void entrySettingsReadFailureRequiresAConfirmedRead() {
        Harness h; h.connectExisting(); h.editor.load();
        auto read = h.requests.last(); h.editor.failed(read.id, "deadline", 1);
        QCOMPARE(h.editor.entrySettingStates().value("scanDepth").toMap().value("text").toString(), QString("未确认"));
        QVERIFY(!h.editor.entrySettingEditable("scanDepth"));
        h.editor.setEntrySettingInherited("scanDepth", true); h.editor.setEntryTokenBudget(50); QVERIFY(!h.editor.dirty());
        h.editor.load(); read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withEntrySettings(existingArchive(), {{"scanDepth", jsonNull()}}), 38), 1);
        QVERIFY(h.editor.entrySettingEditable("scanDepth")); QVERIFY(h.editor.entrySettingInherited("scanDepth"));
        QCOMPARE(h.puts(), 0);
    }
    void entrySettingsEditedBeforeAReadFailureCannotBeSaved() {
        Harness h; h.connectExisting(); h.editor.setEntrySettingInherited("tokenBudget", true);
        QVERIFY(h.editor.canSave());
        h.editor.reloadDiscardingDraft(); const auto read = h.requests.last();
        h.editor.failed(read.id, "deadline", 1);
        QVERIFY(h.editor.dirty()); QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.saveBlocker(), QString("条目扫描设置尚未确认，请重新读取档案；不会使用默认值覆盖。"));
        h.editor.save(); QCOMPARE(h.puts(), 0);
    }
    void entrySettingsEditsDuringSaveKeepTheLaterValue_data() {
        QTest::addColumn<QString>("later");
        QTest::newRow("same-field-inherits") << "same-inherit";
        QTest::newRow("same-field-new-value") << "same-value";
        QTest::newRow("other-field-inherits") << "other-inherit";
    }
    void entrySettingsEditsDuringSaveKeepTheLaterValue() {
        QFETCH(QString, later);
        Harness h; h.connectExisting(); h.editor.setEntryScanDepth(5); h.editor.save();
        const auto put = h.requests.last();
        if (later == "same-inherit") h.editor.setEntrySettingInherited("scanDepth", true);
        if (later == "same-value") h.editor.setEntryScanDepth(9);
        if (later == "other-inherit") h.editor.setEntrySettingInherited("tokenBudget", true);
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.status(), QString("dirty")); QVERIFY(h.editor.dirty()); QCOMPARE(h.editor.revision(), 38);
        h.editor.save();
        const auto entry = firstEntry(h.requests.last().payload.value("archive").toMap());
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 38);
        if (later == "same-inherit") QVERIFY(isJsonNull(entry.value("scanDepth")));
        else QCOMPARE(entry.value("scanDepth").toInt(), later == "same-value" ? 9 : 5);
        if (later == "other-inherit") QVERIFY(isJsonNull(entry.value("tokenBudget")));
        else QCOMPARE(entry.value("tokenBudget").toInt(), 320);
    }
    void entrySettingsUntouchedDuringReadFollowTheNewerAuthority() {
        Harness h; h.connectExisting(); h.editor.load(); const auto read = h.requests.last();
        h.editor.setContent("Typed while the read is pending"); h.editor.setEntryTokenBudget(100);
        const auto current = withEntrySettings(existingArchive(), {{"scanDepth", jsonNull()}, {"tokenBudget", 700}});
        h.editor.receive(read.id, read.command, snapshot(current, 38), 1);
        QVERIFY(h.editor.dirty()); QVERIFY(h.editor.entrySettingInherited("scanDepth"));
        QCOMPARE(h.editor.entryTokenBudget().toInt(), 100);
        h.editor.save();
        const auto entry = firstEntry(h.requests.last().payload.value("archive").toMap());
        QVERIFY(isJsonNull(entry.value("scanDepth"))); QCOMPARE(entry.value("tokenBudget").toInt(), 100);
        QCOMPARE(entry.value("content").toString(), QString("Typed while the read is pending"));
    }
    void entrySettingsNewEntryWritesNothingUntilEdited_data() {
        QTest::addColumn<bool>("override");
        QTest::addColumn<bool>("normalized");
        QTest::newRow("unedited-receipt-absent") << false << false;
        QTest::newRow("unedited-receipt-normalized") << false << true;
        QTest::newRow("override-receipt-normalized") << true << true;
        QTest::newRow("override-receipt-absent") << true << false;
    }
    void entrySettingsNewEntryWritesNothingUntilEdited() {
        QFETCH(bool, override); QFETCH(bool, normalized);
        Harness h; h.connectExisting(); h.editor.newEntry();
        for (const auto &key : {"scanDepth", "tokenBudget"}) {
            QVERIFY(h.editor.entrySettingInherited(key)); QVERIFY(h.editor.entrySettingCanOverride(key));
            QVERIFY(!h.editor.entrySettingStates().value(key).toMap().value("present").toBool());
        }
        h.editor.setContent("A new entry");
        if (override) { h.editor.setEntrySettingInherited("tokenBudget", false); h.editor.setEntryTokenBudget(50); }
        h.editor.save();
        const auto put = h.requests.last(); const auto submitted = put.payload.value("archive").toMap();
        const auto added = entryAt(submitted, 0, 2);
        QVERIFY(!added.contains("scanDepth"));
        QCOMPARE(added.contains("tokenBudget"), override);
        if (override) QCOMPARE(added.value("tokenBudget").toInt(), 50);
        const auto receipt = normalized ? storedEntrySettings(submitted) : submitted;
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        // Untouched defaults bind the receipt too; absent submitted fields
        // must come back as the store's explicit null.
        const bool accepted = normalized;
        QCOMPARE(h.editor.status(), accepted ? QString("saved") : QString("error"));
        QCOMPARE(h.editor.revision(), accepted ? 38 : 37);
        QCOMPARE(h.editor.dirty(), !accepted);
    }
    void entrySettingsDraftUsesTheExistingNavigationConfirmation() {
        Harness h; h.connectExisting(); const auto original = h.entryKey(0), other = h.entryKey(1);
        h.editor.setEntrySettingInherited("scanDepth", true); h.editor.selectEntry(other);
        QVERIFY(!h.editor.navigationPrompt().isEmpty()); h.editor.resolveNavigation("cancel");
        QCOMPARE(h.editor.selectedEntryKey(), original); QVERIFY(h.editor.entrySettingInherited("scanDepth"));
        h.editor.selectEntry(other); h.editor.resolveNavigation("save");
        const auto put = h.requests.last(); QCOMPARE(h.editor.selectedEntryKey(), original);
        QVERIFY(isJsonNull(firstEntry(put.payload.value("archive").toMap()).value("scanDepth")));
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.selectedEntryKey(), other); QVERIFY(h.editor.entrySettingInherited("scanDepth"));
        QVERIFY(!h.editor.entrySettingStates().value("scanDepth").toMap().value("present").toBool());
        QCOMPARE(h.puts(), 1);
    }
    void entrySettingsScopeChangeDiscardsTheOldDraftAndReceipt() {
        Harness h; h.connectExisting(); h.editor.setEntryScanDepth(5); h.editor.save();
        const auto put = h.requests.last(); h.editor.setSession(true, 1, "persona-B");
        const auto read = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
        QVERIFY(!h.editor.initialized()); QVERIFY(!h.editor.entrySettingConfirmed("scanDepth"));
        h.editor.receive(read.id, read.command, snapshot(withEntrySettings(existingArchive(), {{"scanDepth", 9}}), 9), 1);
        QCOMPARE(h.editor.entryScanDepth().toInt(), 9); QVERIFY(!h.editor.dirty()); QCOMPARE(h.puts(), 1);
    }
    void literalRulesRoundTrip_data() {
        QTest::addColumn<QString>("logic");
        QTest::addColumn<QString>("typedKeywords");
        QTest::addColumn<QVariantList>("savedKeywords");
        for (const auto &logic : {"and_any", "and_all", "not_any", "not_all"}) {
            QTest::newRow(logic) << QString(logic) << QString("  dawn， hush , , calm  ")
                                 << (QVariantList{"dawn", "hush", "calm"});
            const auto emptyName = QByteArray(logic) + "-empty-secondary";
            QTest::newRow(emptyName.constData()) << QString(logic) << QString(" ， ,  ") << QVariantList{};
        }
    }
    void literalRulesRoundTrip() {
        QFETCH(QString, logic);
        QFETCH(QString, typedKeywords);
        QFETCH(QVariantList, savedKeywords);
        Harness h;
        h.connectExisting();
        QVERIFY(h.editor.advancedRuleEditable());
        QCOMPARE(h.editor.secondaryKeywords(), QString("night, quiet"));
        QCOMPARE(h.editor.selectiveLogic(), QString("and_all"));
        QVERIFY(h.editor.caseSensitive());
        h.editor.setSecondaryKeywords(typedKeywords);
        h.editor.setSelectiveLogic(logic);
        h.editor.setCaseSensitive(false);
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.canSave());
        h.editor.save();
        const auto put = h.requests.last();
        const auto expected = withAdvancedRules(existingArchive(), savedKeywords, logic, false);
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.revision(), 38);
        QStringList displayKeywords;
        for (const auto &word : savedKeywords) displayKeywords << word.toString();
        QCOMPARE(h.editor.secondaryKeywords(), displayKeywords.join(", "));
        QCOMPARE(h.editor.selectiveLogic(), logic);
        QVERIFY(!h.editor.caseSensitive());
    }

    void invalidSelectiveLogicDoesNotMutateTheDraft_data() {
        QTest::addColumn<QString>("logic");
        QTest::newRow("empty") << QString();
        QTest::newRow("unknown") << "or_any";
        QTest::newRow("case-variant") << "AND_ANY";
        QTest::newRow("whitespace") << " and_any ";
    }
    void invalidSelectiveLogicDoesNotMutateTheDraft() {
        QFETCH(QString, logic);
        Harness h;
        h.connectExisting();
        QSignalSpy changes(&h.editor, &ArchiveEditor::changed);
        h.editor.setSelectiveLogic(logic);
        QCOMPARE(h.editor.selectiveLogic(), QString("and_all"));
        QCOMPARE(changes.count(), 0);
        QVERIFY(!h.editor.dirty());
        h.editor.save();
        QCOMPARE(h.puts(), 0);
    }

    void secondaryKeywordCountUsesTheExistingDelimiterAndSafeLimit() {
        Harness h;
        h.connectExisting();
        QStringList keywords;
        for (int i = 0; i < 201; ++i) keywords << QString("auxiliary-%1").arg(i);
        h.editor.setSecondaryKeywords(keywords.join(QChar(0xff0c)));
        QVERIFY(h.editor.dirty());
        QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.saveBlocker(), QString("辅助关键词不能超过 200 个。"));
        h.editor.save();
        QCOMPARE(h.puts(), 0);
        keywords.removeLast();
        h.editor.setSecondaryKeywords(keywords.join(", "));
        QVERIFY(h.editor.canSave());
        h.editor.save();
        QCOMPARE(h.puts(), 1);
        QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap())
                     .value("secondaryKeywords").toList().size(), 200);
    }

    void advancedRuleEditAloneDuringSaveAdvancesTheDraftSerial_data() {
        QTest::addColumn<QString>("field");
        QTest::newRow("secondary-keywords") << "secondaryKeywords";
        QTest::newRow("logic") << "selectiveLogic";
        QTest::newRow("case-sensitivity") << "caseSensitive";
    }
    void advancedRuleEditAloneDuringSaveAdvancesTheDraftSerial() {
        QFETCH(QString, field);
        Harness h;
        h.connectExisting();
        h.editor.setContent("Content submitted before the advanced rule edit");
        h.editor.save();
        const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        if (field == "secondaryKeywords") h.editor.setSecondaryKeywords("later, auxiliary");
        else if (field == "selectiveLogic") h.editor.setSelectiveLogic("not_any");
        else h.editor.setCaseSensitive(false);
        h.editor.receive(put.id, put.command, snapshot(submitted, 38), 1);
        QCOMPARE(h.editor.revision(), 38);
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.canSave());
        h.editor.save();
        const auto next = h.requests.last();
        QCOMPARE(next.payload.value("expected_revision").toInt(), 38);
        const auto savedEntry = firstEntry(next.payload.value("archive").toMap());
        if (field == "secondaryKeywords")
            QCOMPARE(savedEntry.value(field).toList(), (QVariantList{"later", "auxiliary"}));
        else if (field == "selectiveLogic")
            QCOMPARE(savedEntry.value(field).toString(), QString("not_any"));
        else
            QCOMPARE(savedEntry.value(field).toBool(), false);
    }

    // Historical identity retained: this now checks the explicitly opened
    // regex rules and the preservation of unrelated archive fields.
    void regexAdvancedRulesRemainReadOnlyInSettersAndOtherFieldSaves() {
        auto archive = withEntrySettings(existingArchive(), {{"useRegex", true},
            {"secondaryKeywords", QVariantList{"^night$", "quiet.*"}}});
        Harness h; h.connectArchive(archive);
        QVERIFY(h.editor.advancedRuleEditable()); QVERIFY(h.editor.useRegex());
        QCOMPARE(h.editor.secondaryKeywords(), QString("^night$\nquiet.*"));
        h.editor.setSecondaryKeywords(" replacement,whole ");
        h.editor.setSelectiveLogic("not_any"); h.editor.setCaseSensitive(false);
        h.editor.setContent("Regex entry body and rule edits are explicit");
        h.editor.save(); const auto put = h.requests.last();
        auto expected = withFields(archive, "Original book", h.editor.content(), {"reverie", "home"});
        expected = withAdvancedRules(expected, {" replacement,whole "}, "not_any", false);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QVERIFY(!h.editor.dirty()); QVERIFY(h.editor.advancedRuleEditable());
        QVERIFY(h.editor.useRegex()); QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{" replacement,whole "}));
        h.editor.selectEntry(h.entryKey(1)); QVERIFY(!h.editor.useRegex());
        h.editor.selectEntry(""); QVERIFY(!h.editor.advancedRuleEditable());
    }

    void authoritativeRegexRulesCannotBeOverwrittenByARetainedLiteralDraft() {
        Harness h; h.connectExisting();
        h.editor.setContent("Retained content draft");
        h.editor.setSecondaryKeywords("local, literal"); h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        h.editor.reconcileAfterRestore(); const auto read = h.requests.last();
        auto restored = withEntrySettings(withAdvancedRules(existingArchive(), {"^remote$"}, "not_all", true),
                                          {{"useRegex", true}});
        h.editor.receive(read.id, read.command, snapshot(restored, 61), 1);
        QVERIFY(h.editor.ruleConflict()); QVERIFY(!h.editor.canSave());
        QVERIFY(!h.editor.useRegex()); QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{"local", "literal"}));
        QCOMPARE(h.editor.content(), QString("Retained content draft"));
        h.editor.save(); QCOMPARE(h.puts(), 0);
        h.editor.adoptSavedRules();
        QVERIFY(!h.editor.ruleConflict()); QVERIFY(h.editor.useRegex());
        QCOMPARE(h.editor.secondaryKeywordItems(), (QVariantList{"^remote$"}));
        QCOMPARE(h.editor.content(), QString("Retained content draft")); QVERIFY(h.editor.dirty());
        h.editor.save(); QCOMPARE(h.puts(), 1); const auto put = h.requests.last();
        QCOMPARE(put.payload.value("expected_revision").toInt(), 61);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(withFields(restored, "Original book", "Retained content draft", {"reverie", "home"})));
    }

    void restoreLockRetainsDraftAndReconcilesAuthoritativeRevisionWithoutAutosave() {
        Harness h;
        h.connectExisting(37);
        h.makeDraft();
        h.editor.setSecondaryKeywords("restore, retained");
        h.editor.setSelectiveLogic("not_all");
        h.editor.setCaseSensitive(false);
        h.editor.setSession(true, 1, "persona-A", false);
        QVERIFY(h.editor.dirty());
        QVERIFY(!h.editor.canSave());
        const int requests = h.requests.size();
        h.editor.save();
        QCOMPARE(h.requests.size(), requests);
        h.editor.setSession(true, 1, "persona-A", true);
        h.editor.reconcileAfterRestore();
        const auto read = h.requests.last();
        QCOMPARE(read.command, QString("archive:get"));
        QVERIFY(!h.editor.canSave());
        auto restored = withFields(existingArchive(), "Restored book", "Restored content", {"restored"});
        h.editor.receive(read.id, read.command, snapshot(restored, 61), 1);
        QCOMPARE(h.editor.revision(), 61);
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.secondaryKeywords(), QString("restore, retained"));
        QCOMPARE(h.editor.selectiveLogic(), QString("not_all"));
        QVERIFY(!h.editor.caseSensitive());
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.requests.size(), requests + 1);
        h.editor.save();
        QCOMPARE(h.requests.last().command, QString("archive:put"));
        QCOMPARE(h.requests.last().payload["expected_revision"].toInt(), 61);
        QCOMPARE(firstEntry(h.requests.last().payload.value("archive").toMap())
                     .value("secondaryKeywords").toList(), (QVariantList{"restore", "retained"}));
    }
    void readAndSavePreserveCanonicalNeighborsAndMetadata() {
        Harness h;
        h.connectExisting();
        QVERIFY(h.editor.initialized());
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.title(), QString("Original book"));
        QCOMPARE(h.editor.keywords(), QString("reverie, home"));
        QCOMPARE(h.editor.content(), QString("Original note"));
        QVERIFY(!h.editor.dirty());
        QVERIFY(!h.editor.canSave());

        h.editor.setTitle("Renamed book");
        h.editor.setKeywords("  alpha， beta , , gamma  ");
        h.editor.setContent("An edited note");
        h.editor.setEntryEnabled(false);
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.canSave());
        h.editor.save();
        QCOMPARE(h.requests.size(), 2);
        const auto request = h.requests.last();
        QCOMPARE(request.command, QString("archive:put"));
        QCOMPARE(request.payload.value("expected_revision").toInt(), 37);
        const auto submitted = request.payload.value("archive").toMap();
        const auto expected = withFields(existingArchive(), "Renamed book", "An edited note",
                                         {"alpha", "beta", "gamma"}, false);
        // Compare complete wire JSON, not just the fields exposed in the drawer.
        QCOMPARE(json(submitted), json(expected));
        QCOMPARE(firstBook(submitted).value("id").toString(), QString("book-primary"));
        QCOMPARE(firstEntry(submitted).value("id").toString(), QString("entry-primary"));

        h.editor.receive(request.id, request.command, snapshot(submitted, 38), 1);
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.status(), QString("saved"));
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.keywords(), QString("alpha, beta, gamma"));
    }

    void viewLifetimeAndReopeningDoNotDiscardDraft() {
        Harness h;
        h.connectExisting();
        // A scene view may come and go. The persistent editor has no view parent.
        auto *view = new QObject;
        QObject::connect(&h.editor, &ArchiveEditor::changed, view, [] {});
        h.makeDraft();
        h.editor.setSecondaryKeywords("drawer, retained");
        h.editor.setSelectiveLogic("not_all");
        h.editor.setCaseSensitive(false);
        const auto requestsBeforeClose = h.requests.size();
        delete view;
        QVERIFY(h.editor.parent() == nullptr);
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.secondaryKeywords(), QString("drawer, retained"));
        QCOMPARE(h.editor.selectiveLogic(), QString("not_all"));
        QVERIFY(!h.editor.caseSensitive());
        QCOMPARE(h.requests.size(), requestsBeforeClose);
        h.editor.load();
        QCOMPARE(h.requests.size(), requestsBeforeClose);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.status(), QString("dirty"));
    }

    void editingBackToBaselineClearsDirtyState() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.setEntryEnabled(false);
        h.editor.setSecondaryKeywords("temporary");
        h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        QVERIFY(h.editor.dirty());
        h.editor.setTitle("Original book");
        h.editor.setKeywords("reverie, home");
        h.editor.setContent("Original note");
        h.editor.setEntryEnabled(true);
        h.editor.setSecondaryKeywords("night, quiet");
        h.editor.setSelectiveLogic("and_all");
        h.editor.setCaseSensitive(true);
        QVERIFY(!h.editor.dirty());
        QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.status(), QString("clean"));
    }

    void editsDuringSaveSurviveItsAcknowledgement() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.setSecondaryKeywords("submitted, auxiliary");
        h.editor.setSelectiveLogic("and_any");
        h.editor.setCaseSensitive(false);
        h.editor.save();
        const auto firstSave = h.requests.last();
        const auto submitted = firstSave.payload.value("archive").toMap();
        h.editor.setContent("A later edit while the save is pending");
        h.editor.setEntryEnabled(false);
        h.editor.setSecondaryKeywords("later, auxiliary");
        h.editor.setSelectiveLogic("not_all");
        h.editor.setCaseSensitive(true);
        QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.status(), QString("saving"));
        h.editor.save();
        QCOMPARE(h.requests.size(), 2);
        h.editor.receive(firstSave.id, firstSave.command, snapshot(submitted, 38), 1);
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.content(), QString("A later edit while the save is pending"));
        QVERIFY(!h.editor.entryEnabled());
        QCOMPARE(h.editor.secondaryKeywords(), QString("later, auxiliary"));
        QCOMPARE(h.editor.selectiveLogic(), QString("not_all"));
        QVERIFY(h.editor.caseSensitive());
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.canSave());
        QCOMPARE(h.editor.status(), QString("dirty"));

        h.editor.save();
        const auto secondSave = h.requests.last();
        QCOMPARE(secondSave.payload.value("expected_revision").toInt(), 38);
        const auto expected = withAdvancedRules(
            withFields(existingArchive(), "Draft book", "A later edit while the save is pending",
                       {"draft", "companion"}, false), {"later", "auxiliary"}, "not_all", true);
        QCOMPARE(json(secondSave.payload.value("archive").toMap()), json(expected));
    }

    void failedAndConflictingSavesKeepDraft_data() {
        QTest::addColumn<QString>("code");
        QTest::addColumn<QString>("expectedStatus");
        QTest::newRow("conflict-with-current-server-snapshot") << "conflict" << "conflict";
        QTest::newRow("storage-failure") << "module_degraded" << "error";
    }

    void failedAndConflictingSavesKeepDraft() {
        QFETCH(QString, code);
        QFETCH(QString, expectedStatus);
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.setSecondaryKeywords("conflict, retained");
        h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        h.editor.save();
        const auto save = h.requests.last();
        // Real conflicts can include the newer snapshot, but it must not become
        // this editor's baseline until an explicit successful read.
        auto result = snapshot(existingArchive(), 45);
        result["ok"] = false;
        result["code"] = code;
        h.editor.receive(save.id, save.command, result, 1);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.secondaryKeywords(), QString("conflict, retained"));
        QCOMPARE(h.editor.selectiveLogic(), QString("not_any"));
        QVERIFY(!h.editor.caseSensitive());
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.status(), expectedStatus);
        QVERIFY(!h.editor.diagnostics().value("saving").toBool());
    }

    void timeoutKeepsDraftAndRejectsLateAcknowledgement() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.save();
        const auto save = h.requests.last();
        h.editor.failed("unknown-request", "timeout", 1);
        QVERIFY(h.editor.diagnostics().value("saving").toBool());
        h.editor.failed(save.id, "timeout", 9);
        QVERIFY(h.editor.diagnostics().value("saving").toBool());
        h.editor.failed(save.id, "timeout", 1);
        QCOMPARE(h.editor.status(), QString("error"));
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.revision(), 37);
        h.editor.receive(save.id, save.command, snapshot(save.payload.value("archive").toMap(), 38),
                         1);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.status(), QString("error"));
    }

    void mismatchedSaveRevisionDoesNotConfirmSuccess_data() {
        QTest::addColumn<int>("ackRevision");
        QTest::newRow("unchanged-revision") << 37;
        QTest::newRow("skipped-revision") << 39;
        QTest::newRow("older-revision") << 12;
    }

    void mismatchedSaveRevisionDoesNotConfirmSuccess() {
        QFETCH(int, ackRevision);
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.save();
        const auto save = h.requests.last();
        h.editor.receive(save.id, save.command,
                         snapshot(save.payload.value("archive").toMap(), ackRevision), 1);
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.status(), QString("error"));
    }

    void unmatchedRequestCommandAndGenerationAreIgnored() {
        Harness h;
        h.editor.setSession(true, 1, "persona-A");
        const auto read = h.requests.last();
        const auto response = snapshot(existingArchive(), 37);
        h.editor.receive("unknown-request", "archive:get", response, 1);
        h.editor.receive(read.id, "archive:put", response, 1);
        h.editor.receive(read.id, "archive:get", response, 2);
        QVERIFY(!h.editor.initialized());
        QCOMPARE(h.editor.status(), QString("loading"));
        h.editor.receive(read.id, read.command, response, 1);
        QVERIFY(h.editor.initialized());
        QCOMPARE(h.editor.revision(), 37);
        h.editor.receive(read.id, read.command, snapshot(existingArchive(), 999), 1);
        QCOMPARE(h.editor.revision(), 37);
    }

    void initialReadTimeoutWaitsForExplicitRetry() {
        Harness h;
        h.editor.setSession(true, 1, "persona-A");
        const auto read = h.requests.last();
        h.editor.failed(read.id, "timeout", 1);
        QVERIFY(!h.editor.initialized());
        QCOMPARE(h.editor.status(), QString("error"));
        h.editor.setSession(true, 1, "persona-A");
        h.editor.setSession(true, 1, "persona-A");
        QCOMPARE(h.requests.size(), 1);
        h.editor.load();
        QCOMPARE(h.requests.size(), 2);
        const auto retry = h.requests.last();
        h.editor.receive(retry.id, retry.command, snapshot(existingArchive(), 37), 1);
        QVERIFY(h.editor.initialized());
        QCOMPARE(h.editor.revision(), 37);
    }

    void disconnectAndReconnectDoNotAutomaticallyWrite() {
        Harness h;
        h.editor.save();
        h.editor.load();
        QVERIFY(h.requests.isEmpty());
        h.connectExisting();
        h.makeDraft();
        h.editor.save();
        const auto save = h.requests.last();
        h.editor.setSession(false, 2, "persona-A");
        QVERIFY(!h.editor.canSave());
        QVERIFY(h.editor.dirty());
        h.editor.save();
        h.editor.load();
        h.editor.reloadDiscardingDraft();
        QCOMPARE(h.requests.size(), 2);
        h.editor.receive(save.id, save.command, snapshot(save.payload.value("archive").toMap(), 38),
                         1);
        QCOMPARE(h.editor.revision(), 37);
        h.editor.setSession(true, 2, "persona-A");
        QCOMPARE(h.requests.size(), 2);
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.content(), QString("Draft content"));
        h.editor.save();
        QCOMPARE(h.requests.size(), 3);
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 37);
    }

    void scopeChangeInvalidatesPendingReadEvenWithoutGenerationChange() {
        Harness h;
        h.editor.setSession(true, 1, "persona-A");
        const auto oldRead = h.requests.last();
        h.editor.setSession(true, 1, "persona-B");
        QCOMPARE(h.requests.size(), 2);
        const auto newRead = h.requests.last();
        h.editor.receive(oldRead.id, oldRead.command, snapshot(existingArchive(), 37), 1);
        QVERIFY(!h.editor.initialized());
        QCOMPARE(h.editor.revision(), 0);
        const auto other = withFields(existingArchive(), "Persona B book", "B content", {"B"});
        h.editor.receive(newRead.id, newRead.command, snapshot(other, 8), 1);
        QCOMPARE(h.editor.title(), QString("Persona B book"));
        QCOMPARE(h.editor.content(), QString("B content"));
        QCOMPARE(h.editor.revision(), 8);
        QVERIFY(!h.editor.dirty());
    }

    void scopeChangeInvalidatesPendingSaveEvenWithoutGenerationChange() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.setSecondaryKeywords("persona-A-only");
        h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        h.editor.save();
        const auto oldSave = h.requests.last();
        h.editor.setSession(true, 1, "persona-B");
        QCOMPARE(h.requests.size(), 3);
        const auto newRead = h.requests.last();
        QCOMPARE(newRead.command, QString("archive:get"));
        QVERIFY(h.editor.secondaryKeywords().isEmpty());
        QCOMPARE(h.editor.selectiveLogic(), QString("and_any"));
        QVERIFY(!h.editor.caseSensitive());
        QVERIFY(!h.editor.advancedRuleEditable());
        h.editor.receive(oldSave.id, oldSave.command,
                         snapshot(oldSave.payload.value("archive").toMap(), 38), 1);
        QVERIFY(!h.editor.initialized());
        QCOMPARE(h.editor.revision(), 0);
        const auto other = withFields(existingArchive(), "Persona B book", "B content", {"B"});
        h.editor.receive(newRead.id, newRead.command, snapshot(other, 8), 1);
        QCOMPARE(h.editor.title(), QString("Persona B book"));
        QCOMPARE(h.editor.revision(), 8);
        QCOMPARE(h.editor.secondaryKeywords(), QString("night, quiet"));
        QCOMPARE(h.editor.selectiveLogic(), QString("and_all"));
        QVERIFY(h.editor.caseSensitive());
    }

    void explicitReloadDiscardsTheExistingDraft() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.reloadDiscardingDraft();
        QCOMPARE(h.requests.size(), 2);
        const auto read = h.requests.last();
        const auto server =
            withFields(existingArchive(), "Server book", "Server note", {"server"}, false);
        h.editor.receive(read.id, read.command, snapshot(server, 42), 1);
        QCOMPARE(h.editor.title(), QString("Server book"));
        QCOMPARE(h.editor.keywords(), QString("server"));
        QCOMPARE(h.editor.content(), QString("Server note"));
        QVERIFY(!h.editor.entryEnabled());
        QCOMPARE(h.editor.revision(), 42);
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.status(), QString("clean"));
    }

    void editsMadeAfterExplicitReloadStartsRemainDrafts() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.reloadDiscardingDraft();
        const auto read = h.requests.last();
        h.editor.setContent("Typed while reload was pending");
        const auto server = withFields(existingArchive(), "Server book", "Server note", {"server"});
        h.editor.receive(read.id, read.command, snapshot(server, 42), 1);
        QCOMPARE(h.editor.revision(), 42);
        QCOMPARE(h.editor.content(), QString("Typed while reload was pending"));
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.status(), QString("dirty"));
    }

    void malformedReadDoesNotReplaceDraft_data() {
        QTest::addColumn<QVariantMap>("response");
        auto result = snapshot(existingArchive(), 42);
        auto add = [&](const char *label, const QVariantMap &response) {
            QTest::newRow(label) << response;
        };
        auto malformed = result;
        malformed["ok"] = false;
        add("failed-result", malformed);
        malformed = result;
        malformed.remove("revision");
        add("missing-revision", malformed);
        for (const auto value :
             {QVariant("not-a-revision"), QVariant(42.5), QVariant(true), QVariant(-1)}) {
            malformed = result;
            malformed["revision"] = value;
            add(qPrintable(QString("invalid-revision-%1").arg(value.toString())), malformed);
        }
        malformed = result;
        malformed.remove("archive");
        add("missing-archive", malformed);
        auto archive = existingArchive();
        archive["worldBooks"] = "not-an-array";
        malformed = result;
        malformed["archive"] = archive;
        add("worldbooks-not-array", malformed);
        archive = existingArchive();
        archive["worldBooks"] = QVariantList{"not-a-book"};
        malformed["archive"] = archive;
        add("book-not-object", malformed);
        archive = existingArchive();
        auto books = archive.value("worldBooks").toList();
        auto book = books.first().toMap();
        book["entries"] = "not-an-array";
        books[0] = book;
        archive["worldBooks"] = books;
        malformed["archive"] = archive;
        add("entries-not-array", malformed);
        book = firstBook(existingArchive());
        book["entries"] = QVariantList{"not-an-entry"};
        books[0] = book;
        archive["worldBooks"] = books;
        malformed["archive"] = archive;
        add("entry-not-object", malformed);
        malformed = result;
        malformed["revision"] = 0;
        malformed["exists"] = false;
        add("missing-sentinel-with-nonempty-archive", malformed);
    }

    void malformedReadDoesNotReplaceDraft() {
        QFETCH(QVariantMap, response);
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.editor.reloadDiscardingDraft();
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, response, 1);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.status(), QString("read-error"));
        h.editor.setSession(true, 1, "persona-A");
        QCOMPARE(h.requests.size(), 2);
    }

    void emptyArchiveCreatesStableNewIdentifiersAtRevisionZero() {
        Harness h;
        h.editor.setSession(true, 1, "persona-A");
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command,
                         {{"ok", true},
                          {"exists", false},
                          {"revision", 0},
                          {"archive", QVariant{}},
                          {"checksum", ""}},
                         1);
        QVERIFY(h.editor.initialized());
        QCOMPARE(h.editor.revision(), 0);
        QVERIFY(h.editor.bookRows().isEmpty());
        QVERIFY(!h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        h.editor.newBook();
        QVERIFY(h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        QVERIFY(h.editor.dirty());
        h.editor.save();
        const auto emptyBookSave = h.requests.last();
        const auto emptyBook = emptyBookSave.payload.value("archive").toMap();
        QVERIFY(firstBook(emptyBook).value("entries").toList().isEmpty());
        QCOMPARE(emptyBookSave.payload.value("expected_revision").toInt(), 0);
        h.editor.receive(emptyBookSave.id, emptyBookSave.command, snapshot(emptyBook, 1), 1);
        h.editor.newEntry();
        QVERIFY(h.editor.hasEntry());
        QVERIFY(!h.editor.canSave());
        h.makeDraft();
        h.editor.save();
        const auto save = h.requests.last();
        QCOMPARE(save.payload.value("expected_revision").toInt(), 1);
        const auto archive = save.payload.value("archive").toMap();
        QVERIFY(!firstBook(archive).value("id").toString().isEmpty());
        QVERIFY(!firstEntry(archive).value("id").toString().isEmpty());
        QVERIFY(archive.value("characters").toList().isEmpty());
        QVERIFY(archive.value("activeCharacterIds").toList().isEmpty());
        h.editor.receive(save.id, save.command, snapshot(storedEntrySettings(archive), 2), 1);
        QVERIFY(!h.editor.dirty());
        h.editor.setContent("Second revision of the new entry");
        h.editor.save();
        const auto second = h.requests.last().payload.value("archive").toMap();
        QCOMPARE(firstBook(second).value("id"), firstBook(archive).value("id"));
        QCOMPARE(firstEntry(second).value("id"), firstEntry(archive).value("id"));
        QCOMPARE(h.requests.last().payload.value("expected_revision").toInt(), 2);
    }

    void refusedDispatchPreservesDraftAndRevision() {
        Harness h;
        h.connectExisting();
        h.makeDraft();
        h.dispatchEnabled = false;
        h.editor.save();
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.status(), QString("error"));
        QVERIFY(!h.editor.diagnostics().value("saving").toBool());
    }

    void oversizedHiddenArchiveIsNotTruncatedOrSent() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList();
        for (int i = 0; i < 10; ++i) {
            auto book = books.last().toMap();
            book["id"] = QString("book-large-%1").arg(i);
            book["entries"] = QVariantList{QVariantMap{{"id", QString("entry-large-%1").arg(i)},
                                                       {"content", QString(100000, QChar('x'))},
                                                       {"keywords", QVariantList{"large"}},
                                                       {"enabled", true}}};
            books.append(book);
        }
        archive["worldBooks"] = books;
        h.editor.setSession(true, 1, "persona-A");
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(archive, 37), 1);
        QVERIFY(h.editor.initialized());
        h.makeDraft();
        h.editor.save();
        QCOMPARE(h.requests.size(), 1);
        QCOMPARE(h.editor.status(), QString("error"));
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.dirty());
    }
    void selectedNonfirstRowsEditOnlyTheirFieldsAndExposeAdvancedMetadata() {
        Harness h;
        h.connectExisting();
        QCOMPARE(h.editor.bookRows().size(), 2);
        const auto primary = h.bookKey(0), other = h.bookKey(1);
        const auto sibling = h.entryKey(1);
        h.editor.selectEntry(sibling);
        QCOMPARE(h.editor.content(), QString("Do not rewrite this sibling"));
        QCOMPARE(h.editor.comment(), QString("Sibling metadata"));
        QVERIFY(h.editor.alwaysActive());
        QCOMPARE(h.editor.advancedFields().value("entry").toMap().value("role").toString(), QString("system"));
        QCOMPARE(h.editor.advancedFields().value("book").toMap().value("scanDepth").toInt(), 23);
        h.editor.setComment("Renamed sibling");
        h.editor.setAlwaysActive(false);
        h.editor.setInsertionOrder(204);
        h.editor.setContent("Edited sibling content");
        h.editor.setSecondaryKeywords("sibling, auxiliary");
        h.editor.setSelectiveLogic("not_all");
        h.editor.setCaseSensitive(true);
        h.editor.save();
        const auto put = h.requests.last();
        auto expected = existingArchive();
        auto books = expected.value("worldBooks").toList();
        auto book = books[0].toMap();
        auto entries = book.value("entries").toList();
        auto entry = entries[1].toMap();
        entry["comment"] = "Renamed sibling"; entry["alwaysActive"] = false;
        entry["insertionOrder"] = 204; entry["content"] = "Edited sibling content";
        entry["secondaryKeywords"] = QVariantList{"sibling", "auxiliary"};
        entry["selectiveLogic"] = "not_all"; entry["caseSensitive"] = true;
        entry["useRegex"] = false;
        entries[1] = entry; book["entries"] = entries; books[0] = book; expected["worldBooks"] = books;
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        expected = storedEntrySettings(expected);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.selectedBookKey(), primary);
        QCOMPARE(h.editor.selectedEntryKey(), sibling);
        h.editor.selectBook(other);
        QCOMPARE(h.editor.title(), QString("Keep the other book"));
        QCOMPARE(h.editor.content(), QString("Other book content"));
        h.editor.selectEntry("");
        QVERIFY(h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        h.editor.setTitle("A book-only rename");
        h.editor.save();
        const auto next = h.requests.last();
        books = expected.value("worldBooks").toList(); book = books[1].toMap();
        book["name"] = "A book-only rename"; books[1] = book; expected["worldBooks"] = books;
        QCOMPARE(json(next.payload.value("archive").toMap()), json(expected));
        QCOMPARE(next.payload.value("expected_revision").toInt(), 38);
    }

    void everyAdvancedEntryFieldAndBookMetadataSurviveEditableFieldChanges() {
        Harness h;
        h.connectExisting();
        const auto advanced = h.editor.advancedFields();
        h.editor.setComment("Visible entry comment");
        h.editor.setAlwaysActive(true);
        h.editor.setInsertionOrder(901);
        h.makeDraft();
        h.editor.setSecondaryKeywords("visible, auxiliary");
        h.editor.setSelectiveLogic("not_any");
        h.editor.setCaseSensitive(false);
        h.editor.save();
        const auto archive = h.requests.last().payload.value("archive").toMap();
        auto expected = withFields(existingArchive(), "Draft book", "Draft content", {"draft", "companion"});
        auto books = expected.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto entry = entries[0].toMap();
        entry["comment"] = "Visible entry comment"; entry["alwaysActive"] = true; entry["insertionOrder"] = 901;
        entry["secondaryKeywords"] = QVariantList{"visible", "auxiliary"};
        entry["selectiveLogic"] = "not_any"; entry["caseSensitive"] = false;
        entries[0] = entry; book["entries"] = entries; books[0] = book; expected["worldBooks"] = books;
        QCOMPARE(json(archive), json(expected));
        auto preserved = firstEntry(archive);
        for (const auto &key : advanced.value("entry").toMap().keys())
            QCOMPARE(preserved.value(key), advanced.value("entry").toMap().value(key));
        QCOMPARE(h.editor.advancedFields(), advanced);
    }

    void duplicateImportedIdsHaveStableDistinctKeysAndAreNeverRewritten() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto second = entries[1].toMap();
        second["id"] = "entry-primary"; entries[1] = second; book["entries"] = entries;
        books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        const auto firstKey = h.entryKey(0), secondKey = h.entryKey(1);
        QVERIFY(firstKey != secondKey);
        h.editor.selectEntry(secondKey);
        h.editor.setContent("Only duplicate number two");
        h.editor.setKeywords("duplicate, second");
        h.editor.setSecondaryKeywords("second-only, auxiliary");
        h.editor.setSelectiveLogic("and_all");
        h.editor.setCaseSensitive(true);
        h.editor.save();
        const auto put = h.requests.last();
        const auto submitted = put.payload.value("archive").toMap();
        QCOMPARE(entryAt(submitted, 0, 0), entryAt(archive, 0, 0));
        QCOMPARE(entryAt(submitted, 0, 1).value("id").toString(), QString("entry-primary"));
        QCOMPARE(entryAt(submitted, 0, 1).value("content").toString(), QString("Only duplicate number two"));
        QCOMPARE(entryAt(submitted, 0, 1).value("keywords").toList(), (QVariantList{"duplicate", "second"}));
        QCOMPARE(entryAt(submitted, 0, 1).value("secondaryKeywords").toList(), (QVariantList{"second-only", "auxiliary"}));
        QCOMPARE(entryAt(submitted, 0, 1).value("selectiveLogic").toString(), QString("and_all"));
        QCOMPARE(entryAt(submitted, 0, 1).value("caseSensitive").toBool(), true);
        const auto receipt = storedEntrySettings(submitted);
        h.editor.receive(put.id, put.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.editor.status(), QString("saved"));
        QCOMPARE(h.editor.revision(), 38); QVERIFY(!h.editor.dirty());
        QCOMPARE(h.entryKey(0), firstKey);
        QCOMPARE(h.entryKey(1), secondKey);
        QCOMPARE(h.editor.selectedEntryKey(), secondKey);
        h.editor.load();
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(receipt, 38), 1);
        QCOMPARE(h.entryKey(0), firstKey);
        QCOMPARE(h.entryKey(1), secondKey);
    }

    void readThatLosesTheSelectedTargetPreservesAnOrphanInsteadOfEditingItsNeighbor() {
        Harness h;
        h.connectExisting();
        const auto selected = h.editor.selectedEntryKey();
        h.makeDraft();
        h.editor.reconcileAfterRestore();
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withoutEntry(existingArchive(), 0, 0), 61), 1);
        QCOMPARE(h.editor.revision(), 61);
        QCOMPARE(h.editor.selectedEntryKey(), selected);
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.status(), QString("orphan"));
        QVERIFY(!h.editor.canSave());
        const int sent = h.requests.size();
        h.editor.save();
        QCOMPARE(h.requests.size(), sent);
        const auto neighbor = h.entryKey(0);
        h.editor.selectEntry(neighbor);
        h.editor.resolveNavigation("cancel");
        QCOMPARE(h.editor.content(), QString("Draft content"));
        h.editor.selectEntry(neighbor);
        h.editor.resolveNavigation("discard");
        QCOMPARE(h.editor.selectedEntryKey(), neighbor);
        QCOMPARE(h.editor.content(), QString("Do not rewrite this sibling"));
        QVERIFY(!h.editor.dirty());
    }

    void readWithFewerDuplicateIdsNeverMovesADraftOntoTheRemainingDuplicate() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto second = entries[1].toMap();
        second["id"] = "entry-primary"; entries[1] = second; book["entries"] = entries;
        books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        const auto selected = h.entryKey(1);
        h.editor.selectEntry(selected);
        h.editor.setContent("Duplicate draft that must not migrate");
        h.editor.reconcileAfterRestore();
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withoutEntry(archive, 0, 1), 61), 1);
        QCOMPARE(h.editor.selectedEntryKey(), selected);
        QCOMPARE(h.editor.content(), QString("Duplicate draft that must not migrate"));
        QVERIFY(h.editor.writesBlocked());
        QVERIFY(!h.editor.canSave());
        QCOMPARE(h.editor.status(), QString("orphan"));
    }

    void localCreationAndDiscardDoNotWriteAndDoNotSynthesizeAnEntry() {
        Harness h;
        h.connectExisting();
        const int sent = h.requests.size();
        h.editor.newBook();
        QVERIFY(h.editor.newLocal());
        QVERIFY(h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        QVERIFY(h.editor.entryRows().isEmpty());
        QCOMPARE(h.editor.bookRows().size(), 3);
        QVERIFY(h.editor.canSave());
        QVERIFY(!h.editor.canDeleteBook());
        h.editor.discardNew();
        QCOMPARE(h.editor.bookRows().size(), 2);
        QVERIFY(!h.editor.newLocal());
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.requests.size(), sent);
        h.editor.selectBook(h.bookKey(1));
        h.editor.newEntry();
        QCOMPARE(h.editor.entryRows().size(), 2);
        QVERIFY(h.editor.entryEnabled());
        QVERIFY(!h.editor.alwaysActive());
        QCOMPARE(h.editor.insertionOrder(), 100);
        QVERIFY(h.editor.secondaryKeywords().isEmpty());
        QCOMPARE(h.editor.selectiveLogic(), QString("and_any"));
        QVERIFY(!h.editor.caseSensitive());
        QVERIFY(h.editor.advancedRuleEditable());
        QCOMPARE(h.editor.advancedFields().value("entry").toMap().value("useRegex").toBool(), false);
        QVERIFY(!h.editor.canSave());
        h.editor.setContent("   ");
        h.editor.save();
        QCOMPARE(h.requests.size(), sent);
        h.editor.setContent("Local populated entry");
        QVERIFY(h.editor.canSave());
        h.editor.discardNew();
        QCOMPARE(h.editor.entryRows().size(), 1);
        QCOMPARE(h.editor.content(), QString("Other book content"));
        QCOMPARE(h.requests.size(), sent);
    }

    void emptyPersistedBookCanBeRenamedAndRemainEmpty() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[1].toMap();
        book["entries"] = QVariantList{}; books[1] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        h.editor.selectBook(h.bookKey(1));
        QVERIFY(h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        h.editor.setTitle("Empty renamed book");
        QVERIFY(h.editor.canSave());
        h.editor.save();
        const auto put = h.requests.last();
        book["name"] = "Empty renamed book"; books[1] = book; archive["worldBooks"] = books;
        QCOMPARE(json(put.payload.value("archive").toMap()), json(archive));
        h.editor.receive(put.id, put.command, snapshot(archive, 38), 1);
        QVERIFY(!h.editor.hasEntry());
        QVERIFY(!h.editor.dirty());
    }

    void dirtySwitchCancelAndDiscardApplyTheRequestedIntentWithoutWrites() {
        Harness h;
        h.connectExisting();
        const auto oldKey = h.editor.selectedEntryKey(), target = h.entryKey(1);
        h.makeDraft();
        h.editor.selectEntry(target);
        QCOMPARE(h.editor.navigationPrompt().value("action").toString(), QString("entry"));
        QCOMPARE(h.editor.selectedEntryKey(), oldKey);
        h.editor.resolveNavigation("cancel");
        QVERIFY(h.editor.navigationPrompt().isEmpty());
        QCOMPARE(h.editor.content(), QString("Draft content"));
        h.editor.selectEntry(target);
        h.editor.resolveNavigation("discard");
        QCOMPARE(h.editor.selectedEntryKey(), target);
        QCOMPARE(h.editor.content(), QString("Do not rewrite this sibling"));
        QCOMPARE(h.puts(), 0);
        h.editor.setContent("New dirty text");
        h.editor.newBook();
        QCOMPARE(h.editor.navigationPrompt().value("action").toString(), QString("new-book"));
        h.editor.resolveNavigation("discard");
        QVERIFY(h.editor.newLocal());
        QVERIFY(!h.editor.hasEntry());
        const auto existing = h.bookKey(0);
        h.editor.selectBook(existing);
        h.editor.resolveNavigation("discard");
        QCOMPARE(h.editor.bookRows().size(), 2);
        QCOMPARE(h.editor.selectedBookKey(), existing);
        QCOMPARE(h.puts(), 0);
    }

    void dirtySwitchSaveWaitsForAReceiptAndOnlyContinuesWithoutLaterEdits() {
        for (const bool editLater : {false, true}) {
            Harness h;
            h.connectExisting();
            const auto original = h.editor.selectedEntryKey(), target = h.entryKey(1);
            h.makeDraft();
            h.editor.selectEntry(target);
            h.editor.resolveNavigation("save");
            QVERIFY(h.editor.navigationPrompt().isEmpty());
            const auto put = h.requests.last();
            QCOMPARE(h.editor.selectedEntryKey(), original);
            QVERIFY(h.editor.busy());
            QVERIFY(!h.editor.canNavigate());
            QVERIFY(!h.editor.canCreateBook());
            const int sent = h.requests.size();
            h.editor.selectBook(h.bookKey(1)); h.editor.newBook(); h.editor.requestDelete("entry");
            QCOMPARE(h.requests.size(), sent);
            QCOMPARE(h.editor.selectedEntryKey(), original);
            QVERIFY(h.editor.deletePrompt().isEmpty());
            if (editLater) h.editor.setContent("Later text survives SaveThenContinue");
            h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
            QCOMPARE(h.editor.selectedEntryKey(), editLater ? original : target);
            QCOMPARE(h.editor.content(), editLater ? QString("Later text survives SaveThenContinue")
                                                   : QString("Do not rewrite this sibling"));
            QCOMPARE(h.editor.dirty(), editLater);
        }
    }

    void failedSaveThenContinueStaysOnTheOriginalDraft() {
        for (const QString code : {QString("conflict"), QString("module_degraded")}) {
            Harness h;
            h.connectExisting();
            const auto original = h.editor.selectedEntryKey();
            h.makeDraft(); h.editor.newBook(); h.editor.resolveNavigation("save");
            const auto put = h.requests.last();
            h.editor.receive(put.id, put.command, {{"ok", false}, {"code", code}}, 1);
            QCOMPARE(h.editor.selectedEntryKey(), original);
            QCOMPARE(h.editor.content(), QString("Draft content"));
            QVERIFY(h.editor.dirty());
            QVERIFY(!h.editor.newLocal());
            QCOMPARE(h.editor.revision(), 37);
        }
    }

    void deletePromptReportsImpactAndCancelSendsNothing() {
        Harness h;
        h.connectExisting();
        h.editor.requestDelete("book");
        const auto prompt = h.editor.deletePrompt();
        QCOMPARE(prompt.value("name").toString(), QString("Original book"));
        QCOMPARE(prompt.value("entryCount").toInt(), 2);
        QCOMPARE(prompt.value("enabledCount").toInt(), 1);
        QCOMPARE(prompt.value("alwaysActiveCount").toInt(), 0); // Disabled constant entries are not active.
        QCOMPARE(prompt.value("revision").toInt(), 37);
        QCOMPARE(h.puts(), 0);
        h.editor.cancelDelete();
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.confirmDelete();
        QCOMPARE(h.puts(), 0);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.editor.bookRows().size(), 2);
    }

    void deleteRequiresCleanWritableExistingTargetAndRechecksAtConfirmation() {
        Harness h;
        h.connectExisting();
        h.editor.setSession(true, 1, "persona-A", false);
        h.editor.requestDelete("entry");
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.setSession(true, 1, "persona-A", true, true);
        h.editor.requestDelete("entry");
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.setSession(true, 1, "persona-A");
        h.editor.requestDelete("entry");
        QVERIFY(!h.editor.deletePrompt().isEmpty());
        h.editor.setContent("Edits invalidate the pending delete confirmation");
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.confirmDelete();
        QCOMPARE(h.puts(), 0);
        h.editor.requestDelete("entry");
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.newBook(); h.editor.resolveNavigation("discard");
        h.editor.requestDelete("book");
        QVERIFY(h.editor.deletePrompt().isEmpty());
        h.editor.discardNew();
        QCOMPARE(h.puts(), 0);
    }

    void confirmedEntryDeleteWaitsForAuthoritativeReadAndSelectsAdjacentEntry() {
        Harness h;
        h.connectExisting();
        const auto next = h.entryKey(1), book = h.bookKey(0), original = h.entryKey(0);
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        const auto expected = withoutEntry(existingArchive(), 0, 0);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        QCOMPARE(put.payload.value("expected_revision").toInt(), 37);
        QCOMPARE(h.editor.entryRows().size(), 2);
        QCOMPARE(h.editor.selectedEntryKey(), original);
        QCOMPARE(h.editor.revision(), 37);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        const auto read = h.requests.last();
        QCOMPARE(read.command, QString("archive:get"));
        QCOMPARE(h.editor.entryRows().size(), 2);
        QCOMPARE(h.editor.revision(), 37);
        h.editor.receive(read.id, read.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.entryRows().size(), 1);
        QCOMPARE(h.editor.selectedBookKey(), book);
        QCOMPARE(h.editor.selectedEntryKey(), next);
        QCOMPARE(h.editor.content(), QString("Do not rewrite this sibling"));
        QCOMPARE(h.editor.deleteFeedback().value("status").toString(), QString("success"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("absent"));
        QCOMPARE(h.puts(), 1);
        QCOMPARE(h.editor.revision(), 38);
    }

    void lastEntryDeletionKeepsTheEmptyBookAndBookDeletionAllowsEmptyArchive() {
        Harness h;
        auto archive = withoutBook(existingArchive(), 0);
        h.connectArchive(archive);
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        auto put = h.requests.last(); archive = withoutEntry(archive, 0, 0);
        h.editor.receive(put.id, put.command, snapshot(archive, 38), 1);
        auto read = h.requests.last(); h.editor.receive(read.id, read.command, snapshot(archive, 38), 1);
        QVERIFY(!h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        QCOMPARE(h.editor.bookRows().size(), 1);
        QCOMPARE(h.editor.bookRows()[0].toMap().value("entryCount").toInt(), 0);
        h.editor.selectBook(h.bookKey(0));
        QVERIFY(!h.editor.hasEntry());
        h.editor.requestDelete("book"); h.editor.confirmDelete();
        put = h.requests.last(); archive = withoutBook(archive, 0);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(archive));
        h.editor.receive(put.id, put.command, snapshot(archive, 39), 1);
        read = h.requests.last(); h.editor.receive(read.id, read.command, snapshot(archive, 39), 1);
        QVERIFY(h.editor.bookRows().isEmpty());
        QVERIFY(!h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        QVERIFY(!h.editor.dirty());
        QCOMPARE(h.editor.revision(), 39);
        QCOMPARE(h.puts(), 2);
    }

    void deleteRefusalKeepsTheEntireSnapshotAndNeverUsesConflictPayload() {
        for (const QString code : {QString("conflict"), QString("module_degraded")}) {
            Harness h;
            h.connectExisting();
            const auto books = h.editor.bookRows(), entries = h.editor.entryRows();
            h.editor.requestDelete("entry"); h.editor.confirmDelete();
            const auto put = h.requests.last();
            auto refused = snapshot(withoutEntry(existingArchive(), 0, 0), 45);
            refused["ok"] = false; refused["code"] = code;
            h.editor.receive(put.id, put.command, refused, 1);
            QCOMPARE(h.editor.bookRows(), books);
            QCOMPARE(h.editor.entryRows(), entries);
            QCOMPARE(h.editor.revision(), 37);
            QCOMPARE(h.requests.size(), 2);
            QCOMPARE(h.editor.deleteFeedback().value("status").toString(), code == "conflict" ? QString("conflict") : QString("error"));
        }
    }

    void duplicateIdDeletionRemovesExactlyTheSelectedOccurrenceOnMatchingRead() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto second = entries[1].toMap();
        second["id"] = "entry-primary"; entries[1] = second; book["entries"] = entries;
        books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        const auto first = h.entryKey(0), selected = h.entryKey(1);
        h.editor.selectEntry(selected);
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); const auto expected = withoutEntry(archive, 0, 1);
        QCOMPARE(json(put.payload.value("archive").toMap()), json(expected));
        QCOMPARE(h.editor.entryRows().size(), 2);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        const auto read = h.requests.last(); h.editor.receive(read.id, read.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.entryRows().size(), 1);
        QCOMPARE(h.editor.selectedEntryKey(), first);
        QCOMPARE(h.editor.content(), QString("Original note"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("absent"));
        QCOMPARE(h.puts(), 1);
    }

    void duplicateIdCountDropCannotDeclareTheSelectedRemainingObjectAbsent() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto second = entries[1].toMap();
        second["id"] = "entry-primary"; entries[1] = second; book["entries"] = entries;
        books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        h.editor.selectEntry(h.entryKey(1));
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); h.editor.failed(put.id, "deadline", 1);
        const auto read = h.requests.last();
        // Another actor removed the first duplicate. Our selected object still exists.
        h.editor.receive(read.id, read.command, snapshot(withoutEntry(archive, 0, 0), 39), 1);
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("present"));
        QVERIFY(h.editor.deleteFeedback().value("text").toString().contains("仍存在"));
        QCOMPARE(h.puts(), 1);
    }

    void ambiguousDuplicateReadRetainsSnapshotUntilExplicitManualRefresh() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto second = entries[1].toMap();
        second["id"] = "entry-primary"; entries[1] = second; book["entries"] = entries;
        books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        h.editor.selectEntry(h.entryKey(1));
        const auto oldRows = h.editor.entryRows();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); h.editor.failed(put.id, "deadline", 1);
        const auto read = h.requests.last();
        auto ambiguous = withoutEntry(archive, 0, 0);
        auto currentBooks = ambiguous.value("worldBooks").toList();
        auto currentBook = currentBooks[0].toMap(); auto currentEntries = currentBook.value("entries").toList();
        auto edited = currentEntries[0].toMap(); edited["content"] = "Unidentifiable surviving duplicate";
        currentEntries[0] = edited; currentBook["entries"] = currentEntries;
        currentBooks[0] = currentBook; ambiguous["worldBooks"] = currentBooks;
        h.editor.receive(read.id, read.command, snapshot(ambiguous, 39), 1);
        QCOMPARE(h.editor.entryRows(), oldRows);
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("unconfirmed"));
        h.editor.reloadDiscardingDraft();
        const auto manual = h.requests.last(); h.editor.receive(manual.id, manual.command, snapshot(ambiguous, 39), 1);
        QVERIFY(!h.editor.writesBlocked());
        QCOMPARE(h.editor.revision(), 39);
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("unconfirmed"));
        QCOMPARE(h.puts(), 1);
    }

    void confirmedDeleteRejectsStaleAndWrongCanonicalAuthority_data() {
        QTest::addColumn<int>("readRevision");
        QTest::addColumn<bool>("correctArchive");
        QTest::newRow("old-revision") << 37 << true;
        QTest::newRow("same-revision-wrong-archive") << 38 << false;
    }
    void confirmedDeleteRejectsStaleAndWrongCanonicalAuthority() {
        QFETCH(int, readRevision); QFETCH(bool, correctArchive);
        Harness h;
        h.connectExisting();
        const auto oldRows = h.editor.entryRows();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); const auto expected = withoutEntry(existingArchive(), 0, 0);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command,
                         snapshot(correctArchive ? expected : existingArchive(), readRevision), 1);
        QCOMPARE(h.editor.entryRows(), oldRows);
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("confirmed-put"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("unconfirmed"));
        h.editor.reloadDiscardingDraft();
        const auto manual = h.requests.last(); h.editor.receive(manual.id, manual.command, snapshot(expected, 38), 1);
        QVERIFY(!h.editor.writesBlocked());
        QCOMPARE(h.editor.entryRows().size(), 1);
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.puts(), 1);
    }

    void oversizedLegacyInsertionOrderSurvivesUnrelatedEditingWithoutIntTruncation() {
        Harness h;
        auto archive = existingArchive();
        auto books = archive.value("worldBooks").toList(); auto book = books[0].toMap();
        auto entries = book.value("entries").toList(); auto entry = entries[0].toMap();
        entry["insertionOrder"] = qint64(4294967295LL); entries[0] = entry;
        book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        h.connectArchive(archive);
        QCOMPARE(h.editor.insertionOrder(), qint64(4294967295LL));
        QCOMPARE(h.editor.insertionOrderText(), QString("4294967295"));
        h.editor.setContent("Unrelated content edit"); h.editor.save();
        const auto submitted = h.requests.last().payload.value("archive").toMap();
        QCOMPARE(firstEntry(submitted).value("insertionOrder").toLongLong(), qint64(4294967295LL));
        QCOMPARE(firstEntry(submitted).value("role"), firstEntry(archive).value("role"));
    }

    void invalidCommentAndKeywordCountsExplainWhyNothingCanBeSent() {
        Harness h;
        h.connectExisting();
        h.editor.setComment(QString(5001, QChar('x')));
        QVERIFY(!h.editor.canSave());
        QVERIFY(h.editor.saveBlocker().contains("5000"));
        QVERIFY(h.editor.statusText().contains("5000"));
        h.editor.save(); QCOMPARE(h.puts(), 0);
        h.editor.setComment("Valid comment");
        QStringList words;
        for (int i = 0; i < 201; ++i) words.append(QString("key-%1").arg(i));
        h.editor.setKeywords(words.join(", "));
        QVERIFY(!h.editor.canSave());
        QVERIFY(h.editor.saveBlocker().contains("200"));
        h.editor.save(); QCOMPARE(h.puts(), 0);
        words.removeLast(); h.editor.setKeywords(words.join(", "));
        QVERIFY(h.editor.canSave());
    }

    void unknownDeleteReadsOnceAndKeepsUnknownOutcomeAfterReportingCurrentFact() {
        for (const bool applied : {false, true}) {
            Harness h;
            h.connectExisting();
            h.editor.requestDelete("entry"); h.editor.confirmDelete();
            const auto put = h.requests.last();
            h.editor.failed(put.id, "deadline", 1);
            const auto read = h.requests.last();
            QCOMPARE(read.command, QString("archive:get"));
            QCOMPARE(h.editor.entryRows().size(), 2);
            QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
            const auto current = applied ? withoutEntry(existingArchive(), 0, 0) : existingArchive();
            h.editor.receive(read.id, read.command, snapshot(current, applied ? 38 : 37), 1);
            QCOMPARE(h.editor.deleteFeedback().value("status").toString(), QString("unknown"));
            QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
            QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), applied ? QString("absent") : QString("present"));
            QCOMPARE(h.editor.entryRows().size(), applied ? 1 : 2);
            h.editor.receive(put.id, put.command, snapshot(put.payload.value("archive").toMap(), 38), 1);
            QCOMPARE(h.puts(), 1);
            QCOMPARE(h.requests.size(), 3);
            QVERIFY(!h.editor.writesBlocked());
        }
    }

    void unknownDeleteCannotAdoptDifferentContentAtTheUnchangedCasRevision() {
        Harness h;
        h.connectExisting();
        const auto oldRows = h.editor.entryRows();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); h.editor.failed(put.id, "deadline", 1);
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(withoutEntry(existingArchive(), 0, 0), 37), 1);
        QCOMPARE(h.editor.entryRows(), oldRows);
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("unconfirmed"));
        QCOMPARE(h.puts(), 1);
    }

    void settledUnknownDeleteDoesNotMarkAWorldBookSaveAsDeleting() {
        Harness h;
        h.connectExisting();
        QVERIFY(!h.editor.deletionActive());
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        QVERIFY(h.editor.deletionActive());
        const auto deletion = h.requests.last(); h.editor.failed(deletion.id, "deadline", 1);
        QVERIFY(h.editor.deletionActive());
        const auto read = h.requests.last(); h.editor.receive(read.id, read.command, snapshot(existingArchive(), 37), 1);
        QVERIFY(!h.editor.deletionActive());
        QCOMPARE(h.editor.deleteFeedback().value("status").toString(), QString("unknown"));
        h.editor.setContent("An independent worldbook save"); h.editor.save();
        const auto ordinary = h.requests.last();
        QVERIFY(h.editor.busy());
        QVERIFY(!h.editor.deletionActive());
        h.editor.setContent("A later edit during the independent save");
        h.editor.receive(ordinary.id, ordinary.command, snapshot(ordinary.payload.value("archive").toMap(), 38), 1);
        QCOMPARE(h.editor.content(), QString("A later edit during the independent save"));
        QVERIFY(h.editor.dirty());
        QVERIFY(!h.editor.deletionActive());
        QCOMPARE(h.puts(), 2);
    }

    void mismatchedDeleteReceiptKeepsItsUnknownOutcomeAfterSuccessfulRead() {
        Harness h;
        h.connectExisting();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(existingArchive(), 38), 1);
        const auto read = h.requests.last();
        QCOMPARE(read.command, QString("archive:get"));
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        h.editor.receive(read.id, read.command, snapshot(withoutEntry(existingArchive(), 0, 0), 38), 1);
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("absent"));
        QCOMPARE(h.editor.entryRows().size(), 1);
        QCOMPARE(h.puts(), 1);
    }

    void saveReceiptLosingTheSelectedTargetKeepsTheDraftOrphaned() {
        Harness h;
        h.connectExisting();
        const auto original = h.editor.selectedEntryKey();
        h.makeDraft(); h.editor.save();
        const auto put = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(withoutEntry(existingArchive(), 0, 0), 38), 1);
        QCOMPARE(h.editor.selectedEntryKey(), original);
        QCOMPARE(h.editor.content(), QString("Draft content"));
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QCOMPARE(h.editor.status(), QString("orphan"));
        QCOMPARE(h.editor.revision(), 38);
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.writesBlocked());
        QVERIFY(!h.editor.canSave());
        h.editor.save(); QCOMPARE(h.puts(), 1);
    }

    void unknownDeleteReadFailureBlocksAllWritesUntilManualRefresh() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last(); h.editor.failed(put.id, "deadline", 1);
        const auto read = h.requests.last(); h.editor.failed(read.id, "deadline", 1);
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.entryRows().size(), 2);
        QCOMPARE(h.editor.revision(), 37);
        QVERIFY(!h.editor.canDeleteEntry());
        QVERIFY(!h.editor.canCreateBook());
        h.editor.setContent("Preserved while result is uncertain");
        h.editor.save(); h.editor.newBook(); h.editor.requestDelete("book");
        h.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(h.puts(), 1);
        QCOMPARE(h.requests.size(), 3);
        h.editor.setSession(true, 1, "persona-A");
        QCOMPARE(h.requests.size(), 3);
        h.editor.reloadDiscardingDraft();
        const auto manual = h.requests.last();
        h.editor.receive(manual.id, manual.command,
                         reviewed(snapshot(withSystemSwitch(existingArchive(), false), 37), authorReview(false)), 1);
        QVERIFY(!h.editor.writesBlocked());
        QCOMPARE(h.editor.deleteFeedback().value("outcome").toString(), QString("unknown"));
        QCOMPARE(h.editor.deleteFeedback().value("currentFact").toString(), QString("present"));
        QCOMPARE(h.puts(), 1);
    }

    void editsDuringDeletePutStayOrphanedAfterTheTargetIsRemoved() {
        Harness h;
        h.connectExisting();
        const auto original = h.editor.selectedEntryKey();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        h.editor.setContent("An edit typed after deletion submission");
        const auto expected = withoutEntry(existingArchive(), 0, 0);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        const auto read = h.requests.last();
        h.editor.receive(read.id, read.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.content(), QString("An edit typed after deletion submission"));
        QCOMPARE(h.editor.selectedEntryKey(), original);
        QVERIFY(h.editor.dirty());
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.status(), QString("orphan"));
        QCOMPARE(h.puts(), 1);
    }

    void lostDeleteAuthorityReadRequiresManualRefreshAfterReconnect() {
        Harness h;
        h.connectExisting();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        const auto expected = withoutEntry(existingArchive(), 0, 0);
        h.editor.receive(put.id, put.command, snapshot(expected, 38), 1);
        const auto lostRead = h.requests.last();
        h.editor.setSession(false, 2, "persona-A");
        h.editor.setSession(true, 2, "persona-A");
        QCOMPARE(h.requests.size(), 3);
        QVERIFY(h.editor.writesBlocked());
        QCOMPARE(h.editor.revision(), 37);
        h.editor.receive(lostRead.id, lostRead.command, snapshot(expected, 38), 1);
        QCOMPARE(h.editor.revision(), 37);
        h.editor.reloadDiscardingDraft();
        const auto manual = h.requests.last();
        h.editor.receive(manual.id, manual.command, snapshot(expected, 38), 2);
        QVERIFY(!h.editor.writesBlocked());
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.puts(), 1);
    }

    void queuedRestoreReadDrainsOnlyAfterTheDeletionAuthorityBoundary_data() {
        QTest::addColumn<QString>("stage");
        QTest::newRow("restore-before-delete-read") << "put";
        QTest::newRow("restore-after-delete-read-start") << "read";
        QTest::newRow("refused-put-preserves-postsubmission-draft") << "refused";
        QTest::newRow("failed-authority-stays-blocked-until-manual") << "failed";
    }
    void queuedRestoreReadDrainsOnlyAfterTheDeletionAuthorityBoundary() {
        QFETCH(QString, stage);
        Harness h;
        h.connectExisting();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        const auto deleted = withoutEntry(existingArchive(), 0, 0);
        if (stage == "put" || stage == "refused") h.editor.reconcileAfterRestore();
        QVERIFY(!h.editor.canCreateBook());
        if (stage == "refused") {
            h.editor.setContent("Draft typed after delete submission");
            h.editor.receive(put.id, put.command, {{"ok", false}, {"code", "conflict"}}, 1);
            const auto restoration = h.requests.last();
            QCOMPARE(restoration.command, QString("archive:get"));
            QCOMPARE(h.requests.size(), 3);
            QVERIFY(!h.editor.canSave());
            h.editor.receive(restoration.id, restoration.command, snapshot(existingArchive(), 61), 1);
            QCOMPARE(h.editor.content(), QString("Draft typed after delete submission"));
            QVERIFY(h.editor.dirty());
            QVERIFY(h.editor.canSave());
            QVERIFY(h.editor.canCreateBook());
            QCOMPARE(h.puts(), 1);
            QCOMPARE(h.requests.size(), 3);
            return;
        }
        h.editor.receive(put.id, put.command, snapshot(deleted, 38), 1);
        const auto authority = h.requests.last();
        if (stage != "put") h.editor.reconcileAfterRestore();
        if (stage == "failed") {
            h.editor.failed(authority.id, "deadline", 1);
            QVERIFY(h.editor.writesBlocked());
            QCOMPARE(h.requests.size(), 3); // No automatic retry or restore read.
            h.editor.setSession(true, 1, "persona-A", false);
            h.editor.setSession(true, 1, "persona-A", true);
            QCOMPARE(h.requests.size(), 3);
            h.editor.reloadDiscardingDraft();
            const auto manual = h.requests.last();
            h.editor.receive(manual.id, manual.command, snapshot(deleted, 38), 1);
            QVERIFY(!h.editor.writesBlocked());
            QVERIFY(h.editor.canCreateBook());
            QCOMPARE(h.requests.size(), 4);
            QCOMPARE(h.puts(), 1);
            return;
        }
        h.editor.receive(authority.id, authority.command, snapshot(deleted, 38), 1);
        if (stage == "put") {
            QCOMPARE(h.requests.size(), 3); // Authority read began after the restore request.
            QVERIFY(!h.editor.busy());
            QVERIFY(h.editor.canCreateBook());
        } else {
            QCOMPARE(h.requests.size(), 4); // Earlier authority read cannot satisfy the later restore.
            const auto restoration = h.requests.last();
            QCOMPARE(restoration.command, QString("archive:get"));
            h.editor.setContent("Draft typed while restore read was pending");
            h.editor.receive(restoration.id, restoration.command, snapshot(deleted, 61), 1);
            QCOMPARE(h.editor.content(), QString("Draft typed while restore read was pending"));
            QVERIFY(h.editor.dirty());
            QVERIFY(h.editor.canSave());
            QVERIFY(h.editor.canCreateBook());
            QCOMPARE(h.requests.size(), 4);
        }
        QCOMPARE(h.puts(), 1);
    }

    void lateDeleteResultsCannotPopulateAnotherPersonaEvenAtTheSameGeneration() {
        Harness h;
        h.connectExisting();
        h.editor.requestDelete("entry"); h.editor.confirmDelete();
        const auto put = h.requests.last();
        h.editor.receive(put.id, put.command, snapshot(withoutEntry(existingArchive(), 0, 0), 38), 1);
        const auto deleteRead = h.requests.last();
        h.editor.setSession(true, 1, "persona-B");
        const auto personaRead = h.requests.last();
        QVERIFY(!h.editor.hasBook());
        QVERIFY(!h.editor.hasEntry());
        QVERIFY(h.editor.title().isEmpty());
        QVERIFY(h.editor.comment().isEmpty());
        QVERIFY(h.editor.keywords().isEmpty());
        QVERIFY(h.editor.content().isEmpty());
        QVERIFY(h.editor.deletePrompt().isEmpty());
        QVERIFY(h.editor.deleteFeedback().isEmpty());
        h.editor.receive(deleteRead.id, deleteRead.command, snapshot(withoutEntry(existingArchive(), 0, 0), 38), 1);
        h.editor.receive(put.id, put.command, snapshot(withoutEntry(existingArchive(), 0, 0), 38), 1);
        QVERIFY(!h.editor.initialized());
        QCOMPARE(h.editor.revision(), 0);
        h.editor.receive(personaRead.id, personaRead.command, snapshot(existingArchive(), 5), 1);
        QCOMPARE(h.editor.revision(), 5);
        QCOMPARE(h.editor.entryRows().size(), 2);
    }

    void fullCompactUtf8CapacityChecksIncludeHiddenArchiveAtExactBoundaries_data() {
        QTest::addColumn<int>("bytes");
        QTest::addColumn<bool>("allowed");
        QTest::addColumn<bool>("warning");
        QTest::newRow("below-warning") << 809999 << true << false;
        QTest::newRow("warning-boundary") << 810000 << true << true;
        QTest::newRow("cap-minus-one") << 899999 << true << true;
        QTest::newRow("cap-exact") << 900000 << true << true;
        QTest::newRow("cap-plus-one") << 900001 << false << true;
    }
    void fullCompactUtf8CapacityChecksIncludeHiddenArchiveAtExactBoundaries() {
        QFETCH(int, bytes); QFETCH(bool, allowed); QFETCH(bool, warning);
        auto archive = existingArchive();
        // Hidden entries stay within each entry's 100000-character limit;
        // only the complete archive reaches the transport guard.
        auto books = archive.value("worldBooks").toList();
        QVariantList entries;
        for (int i = 0; i < 9; ++i)
            entries.append(QVariantMap{{"id", QString("capacity-entry-%1").arg(i)},
                                       {"content", i < 8 ? QString(100000, QChar('x')) : QString{}},
                                       {"keywords", QVariantList{}}, {"enabled", true},
                                       {"alwaysActive", false}, {"useRegex", false},
                                       {"position", "before_char"}, {"insertionOrder", 100}});
        QVariantMap hiddenBook{{"id", "capacity-book"}, {"name", "Hidden capacity book"},
                               {"entries", entries}, {"scanDepth", 20}, {"tokenBudget", 500},
                               {"recursiveScanning", true}};
        books.append(hiddenBook); archive["worldBooks"] = books;
        const auto candidate = withFields(archive, "Original book", "三", {"reverie", "home"});
        const int padding = bytes - int(json(candidate).size());
        QVERIFY(padding > 0 && padding <= 100000);
        auto last = entries.last().toMap(); last["content"] = QString(padding, QChar('x'));
        entries[8] = last; hiddenBook["entries"] = entries;
        books.last() = hiddenBook; archive["worldBooks"] = books;
        Harness h; h.connectArchive(archive);
        QCOMPARE(h.editor.savedBytes(), qint64(json(archive).size()));
        h.editor.setContent("三");
        QCOMPARE(h.editor.draftBytes(), qint64(bytes));
        QCOMPARE(!h.editor.sizeWarning().isEmpty(), warning);
        QCOMPARE(h.editor.canSave(), allowed);
        h.editor.save();
        QCOMPARE(h.puts(), allowed ? 1 : 0);
        if (allowed) QCOMPARE(json(h.requests.last().payload.value("archive").toMap()).size(), bytes);
        else {
            QCOMPARE(h.editor.revision(), 37);
            QVERIFY(h.editor.dirty());
            QCOMPARE(h.editor.status(), QString("error"));
        }
    }

    void authorPromptSaveSharesRevisionWithoutMovingANonfirstEntryDraft() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.editor.selectBook(h.bookKey(1));
        const auto book = h.editor.selectedBookKey(), entry = h.editor.selectedEntryKey();
        h.editor.setAuthorPrompt("system", true, true);
        const auto put = h.requests.last();
        QCOMPARE(json(put.payload.value("archive").toMap()), json(withSystemSwitch(existingArchive(), true)));
        h.editor.setComment("A later comment on the selected second book");
        h.editor.setContent("A later second-book entry draft");
        h.editor.receive(put.id, put.command,
                         reviewed(snapshot(withSystemSwitch(existingArchive(), true), 38), authorReview(true)), 1);
        QCOMPARE(h.editor.selectedBookKey(), book);
        QCOMPARE(h.editor.selectedEntryKey(), entry);
        QCOMPARE(h.editor.title(), QString("Keep the other book"));
        QCOMPARE(h.editor.comment(), QString("A later comment on the selected second book"));
        QCOMPARE(h.editor.content(), QString("A later second-book entry draft"));
        QVERIFY(h.editor.dirty());
        h.editor.save();
        const auto next = h.requests.last();
        QCOMPARE(next.payload.value("expected_revision").toInt(), 38);
        QCOMPARE(firstBook(next.payload.value("archive").toMap()), firstBook(existingArchive()));
        QCOMPARE(next.payload.value("archive").toMap().value("characters"), withSystemSwitch(existingArchive(), true).value("characters"));
    }

    void authorPromptReviewRidesBesideTheArchiveAndIsNeverWritten() {
        Harness h;
        const auto review = authorReview(false);
        h.connectReviewed(false, review);
        QCOMPARE(h.editor.authorPrompts(), review);
        QCOMPARE(h.editor.authorPromptBlocker(), QString());
        h.makeDraft();
        h.editor.save();
        const auto save = h.requests.last();
        QCOMPARE(save.payload.keys(), (QStringList{"archive", "expected_revision"}));
        QVERIFY(!save.payload.value("archive").toMap().contains("author_prompts"));
        // A malformed review is not trusted: the switches become unknown.
        auto malformed = review;
        auto system = malformed["system"].toMap();
        system["flags"] = "override_previous";
        malformed["system"] = system;
        h.editor.receive(save.id, save.command,
                         reviewed(snapshot(save.payload.value("archive").toMap(), 38), malformed), 1);
        QCOMPARE(h.editor.revision(), 38);
        QVERIFY(h.editor.authorPrompts().isEmpty());
        QCOMPARE(h.editor.authorPromptBlocker(), QString("档案尚未读取，开关暂不能切换。"));
    }
    void authorPromptSwitchChangesOnlyItsFlagOnTheConfirmedArchive() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        const int before = h.requests.size();
        h.editor.setAuthorPrompt("system", true);
        QCOMPARE(h.requests.size(), before);
        QCOMPARE(h.authorStatus(), QString("error"));
        QCOMPARE(h.authorText(), QString("开启前需要先在确认框里确认，开关没有改动。"));
        h.editor.setAuthorPrompt("unknown", true, true);
        QCOMPARE(h.authorText(), QString("开关无效，没有发送。"));
        h.editor.setAuthorPrompt("system", false);
        QCOMPARE(h.requests.size(), before);
        h.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(h.requests.size(), before + 1);
        const auto save = h.requests.last();
        QCOMPARE(save.command, QString("archive:put"));
        QCOMPARE(save.payload.value("expected_revision").toInt(), 37);
        QCOMPARE(json(save.payload.value("archive").toMap()), json(withSystemSwitch(existingArchive(), true)));
        const auto feedback = h.editor.authorPromptFeedback();
        QCOMPARE(feedback.value("status").toString(), QString("pending"));
        QCOMPARE(feedback.value("kind").toString(), QString("system"));
        QVERIFY(feedback.value("enabled").toBool());
        QCOMPARE(feedback.value("requestId").toString(), save.id);
        QCOMPARE(h.editor.authorPromptBlocker(), QString("档案正在读写，请稍候。"));
        QVERIFY(h.editor.diagnostics().value("authorPromptSaving").toBool());
        // A second request while one saves neither sends nor replaces the pending feedback.
        h.editor.setAuthorPrompt("system", false);
        QCOMPARE(h.requests.size(), before + 1);
        QCOMPARE(h.editor.authorPromptFeedback(), feedback);
        h.makeDraft();
        QCOMPARE(h.editor.status(), QString("dirty"));
        QVERIFY(!h.editor.canSave());
    }
    void confirmedAuthorPromptSaveUpdatesTheReviewAndKeepsTheDraft() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.editor.setAuthorPrompt("system", true, true);
        const auto save = h.requests.last();
        h.makeDraft();
        h.editor.receive(save.id, save.command,
                         reviewed(snapshot(save.payload.value("archive").toMap(), 38), authorReview(true)), 1);
        QCOMPARE(h.editor.revision(), 38);
        QCOMPARE(h.editor.authorPrompts(), authorReview(true));
        QCOMPARE(h.authorStatus(), QString("success"));
        QCOMPARE(h.authorText(), QString("已开启卡作者系统提示，下一轮对话起附上。"));
        QVERIFY(!h.editor.diagnostics().value("authorPromptSaving").toBool());
        QCOMPARE(h.editor.title(), QString("Draft book"));
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.status(), QString("dirty"));
        // The next world-book save builds on the archive that holds the switch.
        h.editor.save();
        const auto next = h.requests.last();
        QCOMPARE(next.payload.value("expected_revision").toInt(), 38);
        QCOMPARE(json(next.payload.value("archive").toMap()),
                 json(withFields(withSystemSwitch(existingArchive(), true), "Draft book", "Draft content",
                                 {"draft", "companion"})));
    }
    void refusedAuthorPromptSavesKeepTheSwitchAndReadItBack_data() {
        QTest::addColumn<QString>("code");
        QTest::addColumn<QString>("text");
        QTest::newRow("untrusted") << "author_prompt_untrusted"
                                   << "这段卡作者系统提示含有可疑指令，后端拒绝开启，开关没有改动。已重新读取当前状态。";
        QTest::newRow("missing") << "author_prompt_missing"
                                 << "当前人格没有卡作者系统提示，后端拒绝开启，开关没有改动。已重新读取当前状态。";
        QTest::newRow("conflict") << "conflict" << "档案已被其他操作更新，开关没有改动。已重新读取当前状态。";
        QTest::newRow("storage") << "module_degraded" << "开关未能保存，原状态保留。已重新读取当前状态。";
    }
    void refusedAuthorPromptSavesKeepTheSwitchAndReadItBack() {
        QFETCH(QString, code);
        QFETCH(QString, text);
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.editor.setAuthorPrompt("system", true, true);
        const auto save = h.requests.last();
        auto result = reviewed(snapshot(withSystemSwitch(existingArchive(), false), 45), authorReview(false));
        result["ok"] = false;
        result["code"] = code;
        h.editor.receive(save.id, save.command, result, 1);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.authorStatus(), QString("error"));
        QCOMPARE(h.authorText(), text);
        QCOMPARE(h.editor.authorPrompts(), authorReview(false));
        const auto reread = h.requests.last();
        QCOMPARE(reread.command, QString("archive:get"));
        QCOMPARE(h.editor.status(), QString("loading"));
        h.editor.receive(reread.id, reread.command,
                         reviewed(snapshot(withSystemSwitch(existingArchive(), false), 45), authorReview(false)), 1);
        QCOMPARE(h.editor.revision(), 45);
        QCOMPARE(h.editor.status(), QString("clean"));
    }
    void mismatchedAuthorPromptReceiptIsNotReportedAsSaved() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.editor.setAuthorPrompt("system", true, true);
        const auto save = h.requests.last();
        h.editor.receive(save.id, save.command,
                         reviewed(snapshot(save.payload.value("archive").toMap(), 38), authorReview(false)), 1);
        QCOMPARE(h.editor.revision(), 37);
        QCOMPARE(h.authorStatus(), QString("unknown"));
        QCOMPARE(h.authorText(), QString("保存回执与请求不一致，结果未确认。已重新读取当前状态。"));
        QCOMPARE(h.requests.last().command, QString("archive:get"));
    }
    void authorPromptSwitchWaitsForTheWorldBookDraft() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        h.makeDraft();
        const QString blocker("资料匣里有未保存的世界书修改，请先保存或放弃后再切换。");
        QCOMPARE(h.editor.authorPromptBlocker(), blocker);
        const int before = h.requests.size();
        h.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(h.requests.size(), before);
        QCOMPARE(h.authorText(), blocker);
        QVERIFY(h.editor.dirty());
        QCOMPARE(h.editor.title(), QString("Draft book"));
    }
    void flaggedOrMissingAuthorPromptsCannotBeTurnedOn() {
        Harness h;
        h.connectReviewed(false, authorReview(false, {"override_previous"}));
        const int before = h.requests.size();
        h.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(h.requests.size(), before);
        QCOMPARE(h.authorText(), QString("这段卡作者系统提示含有可疑指令，已隔离，不能开启。"));
        h.editor.setAuthorPrompt("post_history", true, true);
        QCOMPARE(h.requests.size(), before);
        QCOMPARE(h.authorText(), QString("当前人格没有卡作者对话后指令，开关没有改动。"));
        // An older archive may hold a flagged prompt switched on; it can still be turned off.
        Harness legacy;
        legacy.connectReviewed(true, authorReview(true, {"override_previous"}));
        legacy.editor.setAuthorPrompt("system", false);
        QCOMPARE(legacy.requests.last().command, QString("archive:put"));
        QCOMPARE(json(legacy.requests.last().payload.value("archive").toMap()),
                 json(withSystemSwitch(existingArchive(), false)));
        // Without a card record there is nowhere to keep the switch.
        Harness cardless;
        cardless.connectReviewed(false, authorReview(false, {}, QString()));
        QCOMPARE(cardless.editor.authorPromptBlocker(), QString("这个人格的档案里没有角色卡记录，无法保存开关。"));
        cardless.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(cardless.requests.size(), 1);
    }
    void authorPromptSwitchNeedsAConnectedWritableSettledIdentity() {
        Harness h;
        h.connectReviewed(false, authorReview(false));
        const int before = h.requests.size();
        h.editor.setSession(true, 1, "persona-A", false);
        QCOMPARE(h.editor.authorPromptBlocker(), QString("当前为只读状态，开关暂不能切换。"));
        h.editor.setAuthorPrompt("system", true, true);
        h.editor.setSession(true, 1, "persona-A", true, true);
        QCOMPARE(h.editor.authorPromptBlocker(), QString("人格操作仍在核对中，开关暂不能切换。"));
        h.editor.setAuthorPrompt("system", true, true);
        h.editor.setSession(false, 2, "persona-A");
        QCOMPARE(h.editor.authorPromptBlocker(), QString("本地服务尚未连接，开关暂不能切换。"));
        h.editor.setAuthorPrompt("system", true, true);
        QCOMPARE(h.requests.size(), before);
        // Reconnecting without a lost switch save reads nothing.
        h.editor.setSession(true, 2, "persona-A");
        QCOMPARE(h.editor.authorPromptBlocker(), QString());
        QCOMPARE(h.requests.size(), before);
    }
    void lostAuthorPromptSavesAreUnknownAndReadBack() {
        {
            Harness h;
            h.connectReviewed(false, authorReview(false));
            h.editor.setAuthorPrompt("system", true, true);
            const auto save = h.requests.last();
            h.editor.failed(save.id, "deadline", 1);
            QCOMPARE(h.authorStatus(), QString("unknown"));
            QCOMPARE(h.authorText(), QString("开关保存结果未确认。已重新读取当前状态。"));
            QCOMPARE(h.requests.last().command, QString("archive:get"));
            QCOMPARE(h.editor.status(), QString("loading"));
            h.editor.receive(save.id, save.command,
                             reviewed(snapshot(save.payload.value("archive").toMap(), 38), authorReview(true)), 1);
            QCOMPARE(h.editor.revision(), 37);
        }
        {
            Harness h;
            h.connectReviewed(false, authorReview(false));
            h.editor.setAuthorPrompt("system", true, true);
            const int sent = h.requests.size();
            h.editor.setSession(false, 2, "persona-A");
            QCOMPARE(h.authorStatus(), QString("unknown"));
            QCOMPARE(h.authorText(), QString("连接中断，开关保存结果未确认；重新连接后会重新读取。"));
            QCOMPARE(h.requests.size(), sent);
            h.editor.setSession(true, 2, "persona-A");
            QCOMPARE(h.requests.size(), sent + 1);
            QCOMPARE(h.requests.last().command, QString("archive:get"));
        }
        {
            Harness h;
            h.connectReviewed(false, authorReview(false));
            h.editor.setAuthorPrompt("system", true, true);
            h.editor.setSession(true, 1, "persona-B");
            QCOMPARE(h.authorStatus(), QString("unknown"));
            QCOMPARE(h.authorText(), QString("人格已切换，上一个人格的开关保存结果未确认。"));
            QVERIFY(h.editor.authorPrompts().isEmpty());
            QCOMPARE(h.requests.last().command, QString("archive:get"));
        }
    }
    void newEntryBodyOnlySaveKeepsDefaultFields() {
        Harness h; h.connectExisting(); h.editor.newEntry();
        h.editor.setContent("A new entry with only its body edited");
        h.editor.save();
        QCOMPARE(h.puts(), 1);
        const auto put = h.requests.last();
        QCOMPARE(put.command, QString("archive:put"));
        const auto added = entryAt(put.payload.value("archive").toMap(), 0, 2);
        QVERIFY(!added.value("id").toString().isEmpty());
        QCOMPARE(added.value("content").toString(), QString("A new entry with only its body edited"));
        QCOMPARE(added.value("keywords").toList(), QVariantList{});
        QCOMPARE(added.value("secondaryKeywords").toList(), QVariantList{});
        QCOMPARE(added.value("selectiveLogic"), QVariant("and_any"));
        QCOMPARE(added.value("caseSensitive"), QVariant(false));
        QCOMPARE(added.value("enabled"), QVariant(true));
        QCOMPARE(added.value("alwaysActive"), QVariant(false));
        QCOMPARE(added.value("useRegex"), QVariant(false));
        QCOMPARE(added.value("position"), QVariant("before_char"));
        QCOMPARE(added.value("insertionOrder"), QVariant(100));
        QCOMPARE(added.value("priority"), QVariant(0));
        for (const auto &key : {"scanDepth", "tokenBudget", "depth", "role"}) QVERIFY(!added.contains(key));
    }
};

QTEST_GUILESS_MAIN(ArchiveEditorTest)
#include "ArchiveEditorTest.moc"
