#include "ArchiveEditor.h"
#include <QJsonDocument>
#include <QJsonObject>
#include <QUuid>
#include <QSet>
#include <cmath>
#include <algorithm>

namespace {
// The archive card switch behind each author-prompt kind, and its name in the window.
QString authorSwitchField(const QString &kind) {
    return kind == "system"         ? "useImportedSystemPrompt"
           : kind == "post_history" ? "useImportedPostHistoryInstructions"
                                    : QString();
}
QString authorPromptName(const QString &kind) {
    return kind == "system" ? "卡作者系统提示" : "卡作者对话后指令";
}
QString rowKey() { return QUuid::createUuid().toString(QUuid::WithoutBraces); }
QStringList keywordList(const QString &text) {
    QStringList words;
    for (const auto &value : QString(text).replace(QChar(0xff0c), ',').split(',', Qt::SkipEmptyParts)) {
        const auto clean = value.trimmed();
        if (!clean.isEmpty()) words << clean;
    }
    return words;
}
// Canonical rule drafts are arrays. The buffers only describe the currently
// selected view and are never reparsed by mode changes, snapshots or receipts.
const QStringList ruleKeys{"useRegex", "keywords", "secondaryKeywords", "selectiveLogic", "caseSensitive"};
QVariantList stringVariants(const QStringList &values) {
    QVariantList result; for (const auto &value : values) result.append(value); return result;
}
QString listText(const QVariantList &values, bool regex) {
    QStringList text; for (const auto &value : values) text.append(value.toString());
    return text.join(regex ? "\n" : ", ");
}
bool blankPatternLine(const QString &line) {
    // Match Python str.strip() whitespace without trimming retained patterns.
    return std::all_of(line.begin(), line.end(), [](QChar c) {
        const auto n = c.unicode();
        return (n >= 9 && n <= 13) || (n >= 0x1c && n <= 0x20) || n == 0x85 || n == 0xa0 ||
            n == 0x1680 || (n >= 0x2000 && n <= 0x200a) || n == 0x2028 || n == 0x2029 ||
            n == 0x202f || n == 0x205f || n == 0x3000;
    });
}
QVariantList regexList(const QString &text) {
    QVariantList result;
    for (const auto &line : text.split('\n', Qt::KeepEmptyParts))
        if (!blankPatternLine(line)) result.append(line);
    return result;
}
bool hasLineCharacter(const QString &value) {
    for (const QChar c : value)
        if (c == '\n' || c == '\r' || c.unicode() == 0x2028 || c.unicode() == 0x2029 ||
            c.unicode() == 0x000b || c.unicode() == 0x000c || c.unicode() == 0x0085) return true;
    return false;
}
bool hasUnrepresentableMultilineCharacter(const QString &value) {
    if (hasLineCharacter(value)) return true;
    for (const QChar c : value)
        if (c.unicode() == 0x00a0 || c.unicode() == 0xfdd0 || c.unicode() == 0xfdd1) return true;
    return false;
}
bool oversizedRegex(const QVariantList &values) {
    for (const auto &value : values) if (value.toString().toUcs4().size() > 16384) return true;
    return false;
}
bool listViewRepresentable(const QVariantList &values, bool regex) {
    for (const auto &value : values)
        if (regex ? hasUnrepresentableMultilineCharacter(value.toString()) : hasLineCharacter(value.toString())) return false;
    return regex ? regexList(listText(values, true)) == values && !oversizedRegex(values)
                 : stringVariants(keywordList(listText(values, false))) == values;
}
QVariantMap ruleGroup(const QVariantMap &fields) {
    QVariantMap values; for (const auto &key : ruleKeys) values[key] = fields.value(key); return values;
}
QString personaFromScope(const QString &scope) {
    // IDs may themselves contain ':'. Strip only the known epoch/fingerprint
    // suffix, not the first separator. Unit harnesses can use a bare ID.
    const int last = scope.lastIndexOf(':');
    const int previous = last > 0 ? scope.lastIndexOf(':', last - 1) : -1;
    bool epoch = false;
    if (previous >= 0) scope.mid(previous + 1, last - previous - 1).toUInt(&epoch);
    return epoch && last < scope.size() - 1 ? scope.left(previous) : scope;
}
const QHash<QString, QString> worldbookLabels{
    {"invalid_regex", "正则表达式无效，本轮未使用此条目。"},
    {"regex_timeout", "正则匹配超时，本轮未使用此条目。"},
    {"regex_budget_exhausted", "本轮正则处理预算已用完，未使用此条目。"},
    {"regex_worker_unavailable", "正则处理暂不可用，本轮未使用此条目。"},
    {"regex_input_limit", "正则输入超出处理上限，本轮未使用此条目。"},
    {"recursion_depth_limit", "已达到递归层数上限，本轮停止继续展开。"},
    {"recursion_text_limit", "已达到递归文本上限，本轮停止继续展开。"},
    {"snapshot_unavailable", "世界书档案暂不可读，本轮未注入世界书。"}};
bool diagnosticIdentifier(const QVariant &value, int maximum = 160, bool allowEmpty = false) {
    if (value.metaType().id() != QMetaType::QString) return false;
    const auto text = value.toString();
    if ((!allowEmpty && text.isEmpty()) || text.size() > maximum) return false;
    for (const QChar c : text) if (c.unicode() < 32 || c.unicode() == 127) return false;
    return true;
}
bool boundedInteger(const QVariant &value, qint64 minimum, qint64 maximum) {
    if (!QList<int>{QMetaType::Int, QMetaType::UInt, QMetaType::LongLong,
                    QMetaType::ULongLong, QMetaType::Double}.contains(value.metaType().id())) return false;
    const double n = value.toDouble();
    return std::isfinite(n) && std::floor(n) == n && n >= minimum && n <= maximum;
}
bool validSelectiveLogic(const QString &logic) {
    return logic == "and_any" || logic == "and_all" || logic == "not_any" || logic == "not_all";
}
bool nonNegativeInteger(const QVariant &value) {
    if (!QList<int>{QMetaType::Int, QMetaType::UInt, QMetaType::LongLong,
                    QMetaType::ULongLong, QMetaType::Double}.contains(value.metaType().id()))
        return false;
    const double number = value.toDouble();
    return std::isfinite(number) && number >= 0 && number == std::floor(number);
}
bool editablePriority(const QVariant &value) {
    return nonNegativeInteger(value) && value.toDouble() <= 2147483647.0;
}
// The book's scan and budget settings the runtime consumes. Only these three
// are editable; the editable ranges follow the import bounds, with 0 allowed.
const QStringList bookSettingKeys{"scanDepth", "tokenBudget", "recursiveScanning"};
bool validBookSetting(const QString &key, const QVariant &value) {
    return key == "recursiveScanning" ? value.metaType().id() == QMetaType::Bool : nonNegativeInteger(value);
}
bool editableBookSetting(const QString &key, const QVariant &value) {
    if (!validBookSetting(key, value)) return false;
    return key == "recursiveScanning" || value.toDouble() <= (key == "scanDepth" ? 200.0 : 4000.0);
}
// The selected entry's own scan depth and budget. Absent or null follows the
// book; an integer overrides it within the same editable ranges as the book.
const QStringList entrySettingKeys{"scanDepth", "tokenBudget"};
bool nullSetting(const QVariant &value) { return value.metaType().id() == QMetaType::Nullptr; }
bool inheritedSetting(const QVariant &value) { return !value.isValid() || nullSetting(value); }
bool validEntrySetting(const QVariant &value) { return inheritedSetting(value) || nonNegativeInteger(value); }
bool editableEntryOverride(const QString &key, const QVariant &value) {
    return nonNegativeInteger(value) && value.toDouble() <= (key == "scanDepth" ? 200.0 : 4000.0);
}
QString entryFieldKey(const QString &key) { return key == "scanDepth" ? "entryScanDepth" : "entryTokenBudget"; }
// Absent and null both follow the book but remain distinct stored forms.
QVariant entrySettingToken(const QVariant &value) {
    return nullSetting(value) ? QVariant(QStringLiteral("null")) : value;
}
QVariant entrySettingFromToken(const QVariant &token) {
    return token.metaType().id() == QMetaType::QString ? QVariant::fromValue(nullptr) : token;
}
QVariantMap storedEntrySettings(QVariantMap archive) {
    auto books = archive.value("worldBooks").toList();
    for (int b = 0; b < books.size(); ++b) {
        auto book = books[b].toMap();
        auto entries = book.value("entries").toList();
        for (int e = 0; e < entries.size(); ++e) {
            auto entry = entries[e].toMap();
            for (const auto &key : entrySettingKeys)
                if (!entry.contains(key)) entry[key] = QVariant::fromValue(nullptr);
            entries[e] = entry;
        }
        book["entries"] = entries;
        books[b] = book;
    }
    archive["worldBooks"] = books;
    return archive;
}

// Position is the premise for the other two independent scalar drafts.
const QStringList insertionKeys{"position", "depth", "role"};
QString insertionFieldKey(const QString &key) { return "insertion" + key.left(1).toUpper() + key.mid(1); }
QVariant insertionDefault(const QString &key) {
    return key == "depth" ? QVariant(0) : QVariant(key == "position" ? "before_char" : "system");
}
QVariant effectiveInsertion(const QString &key, const QVariant &raw) {
    return raw.isValid() ? raw : insertionDefault(key);
}
bool validInsertion(const QString &key, const QVariant &value) {
    if (key == "depth") return nonNegativeInteger(value);
    if (value.metaType().id() != QMetaType::QString) return false;
    return key == "position" ? QStringList{"before_char", "after_char", "at_depth"}.contains(value.toString())
                             : key == "role" && QStringList{"system", "user", "assistant"}.contains(value.toString());
}
QString insertionLabel(const QString &key, const QVariant &value) {
    if (key == "depth") return value.metaType().id() == QMetaType::Double
        ? QString::number(value.toDouble(), 'f', 0) : value.toString();
    if (key == "position") return value == "at_depth" ? QString("对话中 · 按深度插入")
        : value == "after_char" ? QString("系统提示 · 角色状态之后") : QString("系统提示 · 身份段之后");
    return value == "assistant" ? QString("助手") : value == "user" ? QString("用户") : QString("系统");
}

// An imported ID is data, not a UI key. Unique IDs survive metadata changes.
// Duplicate IDs are matched by exact objects only while their multiplicity is
// unchanged; an ambiguous missing row must never inherit another row's draft.
QList<int> rowMatches(const QVariantList &rows, const QVariantList &oldRows) {
    QList<int> matches;
    QSet<int> used;
    for (const auto &value : rows) {
        const auto item = value.toMap();
        const auto id = item.value("id").toString();
        QList<int> oldCandidates;
        int newCount = 0;
        for (int i = 0; i < oldRows.size(); ++i)
            if (oldRows[i].toMap().value("id").toString() == id)
                oldCandidates.append(i);
        for (const auto &row : rows)
            if (row.toMap().value("id").toString() == id)
                ++newCount;
        int match = -1;
        if (oldCandidates.size() == 1 && newCount == 1)
            match = oldCandidates.first();
        else if (oldCandidates.size() == newCount)
            for (const int candidate : oldCandidates)
                if (!used.contains(candidate) && oldRows[candidate].toMap() == item) {
                    match = candidate;
                    break;
                }
        if (match >= 0)
            used.insert(match);
        matches.append(match);
    }
    return matches;
}
} // namespace

ArchiveEditor::ArchiveEditor(Sender sender, QObject *parent)
    : QObject(parent), m_send(std::move(sender)) {
    m_deadline.setSingleShot(true);
    m_deadline.setInterval(15000);
    connect(&m_deadline, &QTimer::timeout, this,
            [this] { failed(m_saveId.isEmpty() ? m_readId : m_saveId, "deadline", m_generation); });
}
QVariantMap ArchiveEditor::fields() const {
    return {{"title", m_title},
            {"comment", m_comment},
            {"keywords", m_keywordItems},
            {"secondaryKeywords", m_secondaryKeywordItems},
            {"useRegex", m_useRegex},
            {"selectiveLogic", m_selectiveLogic},
            {"caseSensitive", m_caseSensitive},
            {"content", m_content},
            {"enabled", m_enabled},
            {"alwaysActive", m_alwaysActive},
            {"insertionOrder", m_insertionOrder},
            {"priority", m_priority},
            {"scanDepth", scanDepth()},
            {"tokenBudget", bookTokenBudget()},
            {"recursiveScanning", recursiveScanning()},
            {"entryScanDepth", entrySettingToken(entryScanDepth())},
            {"entryTokenBudget", entrySettingToken(entryTokenBudget())},
            {"insertionPosition", m_insertionSettings.value("position")},
            {"insertionDepth", m_insertionSettings.value("depth")},
            {"insertionRole", m_insertionSettings.value("role")}};
}
bool ArchiveEditor::dirty() const {
    return m_initialized && (newLocal() || m_orphan || m_ruleConflict || (hasBook() && fields() != m_baseline));
}
bool ArchiveEditor::saveAllowed(bool checkSize) const {
    return m_connected && m_writable && !m_identityBusy && !m_reconcilePending &&
           !writesBlocked() && m_initialized && !busy() && hasBook() && dirty() &&
           !m_title.trimmed().isEmpty() && m_title.size() <= 500 && bookSettingsSavable() &&
           (!hasEntry() || (!m_content.trimmed().isEmpty() && m_content.size() <= 100000 &&
                           m_comment.size() <= 5000 && rulesSavable() &&
                           m_insertionOrder >= 0 &&
                           (!m_priorityEdited || (priorityConfirmed() && editablePriority(m_priority))) &&
                           entrySettingsSavable() && insertionSavable())) &&
           (!checkSize || draftBytes() <= 900000);
}
bool ArchiveEditor::canSave() const { return saveAllowed(true); }
bool ArchiveEditor::canCreateBook() const {
    return canNavigate() && m_connected && m_writable && !writesBlocked() && !m_reconcilePending;
}
bool ArchiveEditor::canCreateEntry() const { return canCreateBook() && hasBook() && m_newKind != "book"; }
bool ArchiveEditor::canDeleteBook() const {
    return canCreateBook() && !dirty() && hasBook() && !newLocal() && bookIndex(m_bookKey) >= 0;
}
bool ArchiveEditor::canDeleteEntry() const { return canDeleteBook() && hasEntry(); }
QVariantMap ArchiveEditor::emptyArchive() {
    return {{"characters", QVariantList{}}, {"activeCharacterIds", QVariantList{}},
            {"worldBooks", QVariantList{}}};
}
qint64 ArchiveEditor::archiveBytes(const QVariantMap &archive) {
    return QJsonDocument(QJsonObject::fromVariantMap(archive)).toJson(QJsonDocument::Compact).size();
}
qint64 ArchiveEditor::savedBytes() const { return m_initialized ? archiveBytes(m_archive) : 0; }
qint64 ArchiveEditor::draftBytes() const {
    return m_initialized ? archiveBytes(updatedArchive()) : 0;
}
QString ArchiveEditor::sizeWarning() const {
    const auto bytes = draftBytes();
    return bytes > 900000 ? QString("完整档案超过 900000 字节，本次不能保存；数据不会截断。")
           : bytes >= 810000 ? QString("完整档案接近 900000 字节保存上限。") : QString();
}
QString ArchiveEditor::saveBlocker() const {
    if (!m_connected) return "本地服务尚未连接，草稿保留。";
    if (!m_writable) return "当前为只读状态，暂不能保存。";
    if (m_identityBusy) return "人格操作仍在核对中，请稍候。";
    if (busy()) return "档案正在读写，请稍候。";
    if (m_reconcilePending || m_writeBlocked) return "档案结果尚未核对，请手动重新读取后再保存。";
    if (m_orphan) return "所选条目已不存在，原草稿保留；不能把它写入其他条目。";
    if (!m_initialized || !hasBook()) return "请先选择或新建世界书。";
    if (m_title.trimmed().isEmpty()) return "世界书名称不能为空。";
    if (m_title.size() > 500) return "世界书名称不能超过 500 个字符。";
    if (!bookSettingsSavable()) return "书设置尚未确认，请重新读取档案；不会使用默认值覆盖。";
    if (hasEntry()) {
        if (m_ruleConflict) return ruleConflictText();
        if (m_useRegex && !rulesSavable() && (oversizedRegex(m_keywordItems) || oversizedRegex(m_secondaryKeywordItems)))
            return "有模式超过 16,384 字符，正则方式不能保存；请缩短或改回字面。";
        if (m_content.trimmed().isEmpty()) return "条目正文不能为空，填写后才能保存。";
        if (m_content.size() > 100000) return "条目正文不能超过 100000 个字符。";
        if (m_comment.size() > 5000) return "条目名称不能超过 5000 个字符。";
        if (m_keywordItems.size() > 200) return "条目关键词不能超过 200 个。";
        if (m_secondaryKeywordItems.size() > 200) return "辅助关键词不能超过 200 个。";
        if (!validSelectiveLogic(m_selectiveLogic)) return "辅助关键词逻辑无效，请重新读取档案。";
        if (m_insertionOrder < 0) return "插入顺序不能小于 0。";
        if (m_readFailed && rulesDirty()) return "匹配规则尚未确认，请重新读取档案；不会使用默认值覆盖。";
        if (m_priorityEdited && (!priorityConfirmed() || !editablePriority(m_priority)))
            return "优先级尚未确认，请重新读取档案；不会使用默认值覆盖。";
        if (!entrySettingsSavable()) return "条目扫描设置尚未确认，请重新读取档案；不会使用默认值覆盖。";
        if (!insertionSavable()) return "插入方式尚未确认，请重新读取档案；不会使用默认值覆盖。";
    }
    if (draftBytes() > 900000) return sizeWarning();
    return {};
}
void ArchiveEditor::status(const QString &state, const QString &text) {
    m_status = state;
    m_statusText = text;
    emit changed();
    // All replacement paths publish their fields through this existing
    // boundary. Keep the presentation guard raised while QML evaluates the
    // shared NOTIFY bindings, then release it without replaying old focus.
    finishFocusContextChange();
}
void ArchiveEditor::beginFocusContextChange() {
    if (m_focusContextChanging) return;
    m_focusContextChanging = true;
    ++m_focusContextRevision;
    emit focusContextChanged();
}
void ArchiveEditor::finishFocusContextChange() {
    if (!m_focusContextChanging) return;
    m_focusContextChanging = false;
    emit focusContextChanged();
}
void ArchiveEditor::editChanged() {
    ++m_editSerial;
    // A switch save in flight does not carry the world-book fields.
    m_deletePrompt.clear();
    if (!m_saveId.isEmpty() && m_authorKind.isEmpty())
        status("saving", "正在保存已提交的版本；后续编辑会继续保留。");
    else if (dirty() && !saveBlocker().isEmpty())
        status(m_orphan ? "orphan" : "dirty", saveBlocker());
    else if (dirty())
        status("dirty", "有未保存的修改 · 收起资料匣会保留草稿");
    else
        status("clean", "与已保存的档案一致");
}
void ArchiveEditor::setTitle(const QString &s) {
    if (!hasBook() || s == m_title)
        return;
    m_title = s;
    editChanged();
}
void ArchiveEditor::setComment(const QString &s) {
    if (!hasEntry() || s == m_comment)
        return;
    m_comment = s;
    editChanged();
}
bool ArchiveEditor::rulesDirty() const {
    return ruleGroup(fields()) != ruleGroup(m_baseline);
}
bool ArchiveEditor::rulesSavable() const {
    if ((m_readFailed && rulesDirty()) || m_ruleConflict || m_keywordItems.size() > 200 || m_secondaryKeywordItems.size() > 200 ||
        !validSelectiveLogic(m_selectiveLogic)) return false;
    if (!m_useRegex) return true;
    // Legal imported oversized patterns can be carried untouched. A changed
    // list, new entry or literal-to-regex conversion must meet runtime bounds.
    for (const auto &key : {QString("keywords"), QString("secondaryKeywords")}) {
        const auto values = key == "keywords" ? m_keywordItems : m_secondaryKeywordItems;
        if (oversizedRegex(values) && (m_newKind == "entry" || !m_baseline.value("useRegex").toBool() ||
            values != m_baseline.value(key).toList())) return false;
    }
    return true;
}
bool ArchiveEditor::ruleListEditable(const QString &key) const {
    if (!advancedRuleEditable()) return false;
    const auto values = key == "keywords" ? m_keywordItems : m_secondaryKeywordItems;
    if (listViewRepresentable(values, m_useRegex)) return true;
    // Do not lock a user out of shortening an oversized draft they just typed
    // through an editable view. Only a successful editable setter records the key;
    // untouched imported opaque values therefore stay read-only.
    return m_useRegex && m_ruleEditSerials.contains(key) &&
        !std::any_of(values.begin(), values.end(), [](const QVariant &v) { return hasUnrepresentableMultilineCharacter(v.toString()); });
}
bool ArchiveEditor::keywordsEditable() const { return ruleListEditable("keywords"); }
bool ArchiveEditor::secondaryKeywordsEditable() const { return ruleListEditable("secondaryKeywords"); }
QString ArchiveEditor::keywordsReadonlyReason() const {
    if (keywordsEditable()) return {};
    return m_useRegex ? "这些模式含换行、不换行空格等特殊字符或超过 16,384 字符，无法逐行原样编辑；当前只读，保存其他字段时原样保留。"
                      : "这些关键词含逗号、首尾空白或换行，逗号格式无法原样编辑；当前只读，保存其他字段时原样保留。";
}
QString ArchiveEditor::secondaryKeywordsReadonlyReason() const {
    if (secondaryKeywordsEditable()) return {};
    return m_useRegex ? "这些模式含换行、不换行空格等特殊字符或超过 16,384 字符，无法逐行原样编辑；当前只读，保存其他字段时原样保留。"
                      : "这些关键词含逗号、首尾空白或换行，逗号格式无法原样编辑；当前只读，保存其他字段时原样保留。";
}
QString ArchiveEditor::ruleConflictText() const {
    return m_ruleConflict ? "已保存的版本与本地草稿的匹配方式或规则列表不一致，本地修改的匹配规则不能直接保存。可采用已保存的规则（保留其他修改），或放弃修改、重新读取。" : QString{};
}
void ArchiveEditor::refreshRuleViews() {
    m_keywords = listText(m_keywordItems, m_useRegex);
    m_secondaryKeywords = listText(m_secondaryKeywordItems, m_useRegex);
}
void ArchiveEditor::assignRules(const QVariantMap &value) {
    m_keywordItems = value.value("keywords").toList();
    m_secondaryKeywordItems = value.value("secondaryKeywords").toList();
    m_useRegex = value.value("useRegex", false).toBool();
    m_selectiveLogic = value.value("selectiveLogic", "and_any").toString();
    m_caseSensitive = value.value("caseSensitive", false).toBool();
    m_ruleEditSerials.clear(); m_ruleConflict = false;
    refreshRuleViews();
}
void ArchiveEditor::setKeywords(const QString &s) {
    if (!keywordsEditable() || s == m_keywords) return;
    m_keywords = s;
    m_keywordItems = m_useRegex ? regexList(s) : stringVariants(keywordList(s));
    m_ruleEditSerials["keywords"] = m_editSerial + 1;
    editChanged();
}
void ArchiveEditor::setSecondaryKeywords(const QString &s) {
    if (!secondaryKeywordsEditable() || s == m_secondaryKeywords) return;
    m_secondaryKeywords = s;
    m_secondaryKeywordItems = m_useRegex ? regexList(s) : stringVariants(keywordList(s));
    m_ruleEditSerials["secondaryKeywords"] = m_editSerial + 1;
    editChanged();
}
void ArchiveEditor::setUseRegex(bool value) {
    if (!advancedRuleEditable() || value == m_useRegex) return;
    m_useRegex = value;
    m_ruleEditSerials["useRegex"] = m_editSerial + 1;
    refreshRuleViews();
    editChanged();
}
void ArchiveEditor::adoptSavedRules() {
    if (!m_ruleConflict || busy() || !advancedRuleEditable() || m_orphan) return;
    assignRules(m_baseline);
    editChanged();
}
void ArchiveEditor::setSelectiveLogic(const QString &logic) {
    if (!advancedRuleEditable() || !validSelectiveLogic(logic) || logic == m_selectiveLogic) return;
    m_selectiveLogic = logic;
    m_ruleEditSerials["selectiveLogic"] = m_editSerial + 1;
    editChanged();
}
void ArchiveEditor::setCaseSensitive(bool sensitive) {
    if (!advancedRuleEditable() || sensitive == m_caseSensitive) return;
    m_caseSensitive = sensitive;
    m_ruleEditSerials["caseSensitive"] = m_editSerial + 1;
    editChanged();
}
void ArchiveEditor::setContent(const QString &s) {
    if (!hasEntry() || s == m_content)
        return;
    m_content = s;
    editChanged();
}
void ArchiveEditor::setEntryEnabled(bool enabled) {
    if (!hasEntry() || enabled == m_enabled)
        return;
    m_enabled = enabled;
    editChanged();
}
void ArchiveEditor::setAlwaysActive(bool active) {
    if (!hasEntry() || active == m_alwaysActive)
        return;
    m_alwaysActive = active;
    editChanged();
}
void ArchiveEditor::setInsertionOrder(qint64 order) {
    if (!hasEntry() || order == m_insertionOrder)
        return;
    m_insertionOrder = order;
    editChanged();
}
bool ArchiveEditor::priorityConfirmed() const {
    return m_initialized && hasEntry() && !m_readFailed && nonNegativeInteger(m_priority);
}
bool ArchiveEditor::priorityEditable() const {
    return priorityConfirmed() && editablePriority(m_priority);
}
QString ArchiveEditor::priorityText() const {
    if (!priorityConfirmed()) return "未确认";
    return m_priority.metaType().id() == QMetaType::Double
               ? QString::number(m_priority.toDouble(), 'f', 0) : m_priority.toString();
}
void ArchiveEditor::setPriority(const QVariant &value) {
    // A regex entry may change allocation priority without changing its rule.
    // Reject coercions (including bool/string/fraction), never clamp an old value.
    if (!priorityEditable() || !editablePriority(value) || value == m_priority)
        return;
    m_priority = value.toInt();
    m_priorityEdited = m_priority != m_baseline.value("priority");
    m_priorityEditSerial = m_editSerial + 1;
    editChanged();
}
bool ArchiveEditor::bookSettingConfirmed(const QString &key) const {
    return m_initialized && hasBook() && !m_readFailed && validBookSetting(key, m_bookSettings.value(key));
}
bool ArchiveEditor::bookSettingEditable(const QString &key) const {
    return bookSettingConfirmed(key) && editableBookSetting(key, m_bookSettings.value(key));
}
bool ArchiveEditor::bookSettingEdited(const QString &key) const {
    return m_bookEditSerials.value(key) > 0 && m_bookSettings.value(key) != m_baseline.value(key);
}
bool ArchiveEditor::bookSettingsSavable() const {
    for (const auto &key : bookSettingKeys)
        if (bookSettingEdited(key) && !bookSettingEditable(key)) return false;
    return true;
}
QVariantMap ArchiveEditor::bookSettingStates() const {
    QVariantMap states;
    for (const auto &key : bookSettingKeys) {
        const auto value = m_bookSettings.value(key);
        const bool confirmed = bookSettingConfirmed(key);
        states[key] = QVariantMap{{"confirmed", confirmed}, {"editable", bookSettingEditable(key)},
            {"text", !confirmed ? QString("未确认")
                     : key == "recursiveScanning" ? QString(value.toBool() ? "开启" : "关闭")
                     : value.metaType().id() == QMetaType::Double ? QString::number(value.toDouble(), 'f', 0)
                                                                  : value.toString()}};
    }
    return states;
}
void ArchiveEditor::setBookSetting(const QString &key, const QVariant &value) {
    // Reject coercions (strings, fractions, numbers for the switch) and never
    // clamp an old value that lies outside the editable range.
    if (!bookSettingEditable(key) || !editableBookSetting(key, value) || value == m_bookSettings.value(key))
        return;
    m_bookSettings[key] = key == "recursiveScanning" ? QVariant(value.toBool()) : QVariant(value.toInt());
    m_bookEditSerials[key] = m_editSerial + 1;
    editChanged();
}
bool ArchiveEditor::entrySettingConfirmed(const QString &key) const {
    return m_initialized && hasEntry() && !m_readFailed && entrySettingKeys.contains(key) &&
           validEntrySetting(m_entrySettings.value(key));
}
bool ArchiveEditor::entrySettingInherited(const QString &key) const {
    return entrySettingConfirmed(key) && inheritedSetting(m_entrySettings.value(key));
}
bool ArchiveEditor::entrySettingEditable(const QString &key) const {
    // A legal override outside the editable range stays read-only, and so does
    // its inherit switch: it must never be silently replaced by null.
    const auto value = m_entrySettings.value(key);
    return entrySettingConfirmed(key) && (inheritedSetting(value) || editableEntryOverride(key, value));
}
bool ArchiveEditor::entrySettingCanOverride(const QString &key) const {
    // An override starts from the book value of this same authoritative
    // snapshot, never from a default or from an unsaved book draft.
    return entrySettingInherited(key) && entrySettingEditable(key) &&
           editableBookSetting(key, m_selectedBook.value(key));
}
bool ArchiveEditor::entrySettingEdited(const QString &key) const {
    return m_entryEditSerials.value(key) > 0 &&
           entrySettingToken(m_entrySettings.value(key)) != m_baseline.value(entryFieldKey(key));
}
bool ArchiveEditor::entrySettingsSavable() const {
    for (const auto &key : entrySettingKeys)
        if (entrySettingEdited(key) && !entrySettingEditable(key)) return false;
    return true;
}
QVariantMap ArchiveEditor::entrySettingStates() const {
    const auto number = [](const QVariant &value) {
        return value.metaType().id() == QMetaType::Double ? QString::number(value.toDouble(), 'f', 0) : value.toString();
    };
    QVariantMap states;
    for (const auto &key : entrySettingKeys) {
        const auto value = m_entrySettings.value(key), book = m_selectedBook.value(key);
        const bool confirmed = entrySettingConfirmed(key), inherited = entrySettingInherited(key);
        states[key] = QVariantMap{{"confirmed", confirmed}, {"editable", entrySettingEditable(key)},
            {"inherited", inherited}, {"present", value.isValid()}, {"canOverride", entrySettingCanOverride(key)},
            {"bookText", confirmed && editableBookSetting(key, book) ? number(book) : QString()},
            {"text", !confirmed ? QString("未确认") : inherited ? QString("跟随本书") : number(value)}};
    }
    return states;
}
void ArchiveEditor::setEntrySetting(const QString &key, const QVariant &value) {
    // An integer applies only to an override already started from the book
    // value. Reject coercions and never clamp an old out-of-range value.
    if (!entrySettingEditable(key) || entrySettingInherited(key) || !editableEntryOverride(key, value) ||
        value == m_entrySettings.value(key))
        return;
    m_entrySettings[key] = QVariant(value.toInt());
    m_entryEditSerials[key] = m_editSerial + 1;
    editChanged();
}
void ArchiveEditor::setEntrySettingInherited(const QString &key, bool inherited) {
    if (!entrySettingEditable(key) || inherited == entrySettingInherited(key))
        return;
    if (inherited) {
        // Return to the read form when that already followed the book, so an
        // absent field stays absent; otherwise the entry stores null.
        const auto baseline = entrySettingFromToken(m_baseline.value(entryFieldKey(key)));
        m_entrySettings[key] = inheritedSetting(baseline) ? baseline : QVariant::fromValue(nullptr);
    } else {
        if (!entrySettingCanOverride(key))
            return;
        m_entrySettings[key] = QVariant(m_selectedBook.value(key).toInt());
    }
    m_entryEditSerials[key] = m_editSerial + 1;
    editChanged();
}
QVariant ArchiveEditor::insertionPosition() const { return effectiveInsertion("position", m_insertionSettings.value("position")); }
QVariant ArchiveEditor::insertionDepth() const { return effectiveInsertion("depth", m_insertionSettings.value("depth")); }
QVariant ArchiveEditor::insertionRole() const { return effectiveInsertion("role", m_insertionSettings.value("role")); }
bool ArchiveEditor::insertionConfirmed(const QString &key) const {
    return m_initialized && hasEntry() && !m_readFailed && insertionKeys.contains(key) &&
        validInsertion(key, effectiveInsertion(key, m_insertionSettings.value(key)));
}
bool ArchiveEditor::insertionEditable(const QString &key) const {
    return insertionConfirmed(key) && (key == "position" ||
        (insertionConfirmed("position") && insertionPosition() == "at_depth" &&
         (key != "depth" || insertionDepth().toDouble() <= 200.0)));
}
bool ArchiveEditor::insertionEdited(const QString &key) const {
    return m_insertionEditSerials.value(key) > 0 &&
        m_insertionSettings.value(key) != m_baseline.value(insertionFieldKey(key));
}
bool ArchiveEditor::insertionDirty() const {
    return std::any_of(insertionKeys.begin(), insertionKeys.end(),
        [this](const QString &key) { return insertionEdited(key); });
}
bool ArchiveEditor::insertionSavable() const {
    if (!insertionDirty()) return true;
    // Inactive depth/role drafts remain savable. Switching position changes
    // editability, never their value or their status as an explicit edit.
    for (const auto &key : insertionKeys)
        if (!insertionConfirmed(key) ||
            (key == "depth" && insertionEdited(key) && insertionDepth().toDouble() > 200.0)) return false;
    return true;
}
QVariantMap ArchiveEditor::insertionStates() const {
    QVariantMap states;
    for (const auto &key : insertionKeys) {
        const auto raw = m_insertionSettings.value(key), value = effectiveInsertion(key, raw);
        const bool confirmed = insertionConfirmed(key);
        QString reason;
        if (!confirmed) reason = "插入方式尚未确认，请重新读取档案；不会使用默认值覆盖。";
        else if (key == "depth" && value.toDouble() > 200.0)
            reason = "原值 " + insertionLabel(key, value) + "。超出本界面 0–200 的编辑范围，当前只读；编辑其余字段时会保留此值。";
        else if (key != "position" && insertionPosition() != "at_depth") reason = "仅在对话中按深度插入时可编辑，此值会保留。";
        states[key] = QVariantMap{{"confirmed", confirmed}, {"editable", insertionEditable(key)},
            {"present", raw.isValid()}, {"text", confirmed ? insertionLabel(key, value) : QString("未确认")},
            {"readonlyReason", reason}};
    }
    return states;
}
QString ArchiveEditor::insertionEffectiveText() const {
    if (!insertionConfirmed("position")) return "插入方式未确认";
    if (!insertionConfirmed("depth") || !insertionConfirmed("role"))
        return "插入方式未确认 · " + insertionLabel("position", insertionPosition()) + "（深度或角色未确认）";
    if (insertionPosition() != "at_depth")
        return insertionLabel("position", insertionPosition()) + "（深度、角色此时不生效）";
    return "对话中按深度插入 · 深度 " + insertionLabel("depth", insertionDepth()) + " · " + insertionLabel("role", insertionRole());
}
void ArchiveEditor::setInsertionSetting(const QString &key, const QVariant &value) {
    if (!insertionEditable(key) || !validInsertion(key, value) ||
        (key == "depth" && value.toDouble() > 200.0) ||
        value == effectiveInsertion(key, m_insertionSettings.value(key))) return;
    auto raw = key == "depth" ? QVariant(value.toInt()) : value;
    // Reverting an implicit default preserves its omission.
    if (!m_baseline.value(insertionFieldKey(key)).isValid() && value == insertionDefault(key)) raw = {};
    m_insertionSettings[key] = raw;
    m_insertionEditSerials[key] = m_editSerial + 1;
    m_insertionDependencyNotice.clear();
    editChanged();
}
QVariantMap ArchiveEditor::editableFields(const QVariantMap &book, const QVariantMap &entry) {
    return {{"title", book.value("name").toString()},
            {"comment", entry.value("comment").toString()},
            {"keywords", entry.value("keywords", QVariantList{})},
            {"secondaryKeywords", entry.value("secondaryKeywords", QVariantList{})},
            {"useRegex", entry.value("useRegex", false)},
            {"selectiveLogic", entry.value("selectiveLogic", "and_any").toString()},
            {"caseSensitive", entry.value("caseSensitive", false).toBool()},
            {"content", entry.value("content").toString()},
            {"enabled", entry.value("enabled", true).toBool()},
            {"alwaysActive", entry.value("alwaysActive", false).toBool()},
            {"insertionOrder", entry.value("insertionOrder", 100).toLongLong()},
            {"priority", entry.value("priority")},
            {"scanDepth", book.value("scanDepth")},
            {"tokenBudget", book.value("tokenBudget")},
            {"recursiveScanning", book.value("recursiveScanning")},
            {"entryScanDepth", entrySettingToken(entry.value("scanDepth"))},
            {"entryTokenBudget", entrySettingToken(entry.value("tokenBudget"))},
            {"insertionPosition", entry.value("position")},
            {"insertionDepth", entry.value("depth")},
            {"insertionRole", entry.value("role")}};
}
void ArchiveEditor::assignFields(const QVariantMap &value) {
    m_title = value.value("title").toString();
    m_comment = value.value("comment").toString();
    assignRules(value);
    m_content = value.value("content").toString();
    m_enabled = value.value("enabled", true).toBool();
    m_alwaysActive = value.value("alwaysActive", false).toBool();
    m_insertionOrder = value.value("insertionOrder", 100).toLongLong();
    m_priority = value.value("priority");
    m_priorityEdited = false;
    m_priorityEditSerial = 0;
    m_bookSettings.clear();
    for (const auto &key : bookSettingKeys) m_bookSettings[key] = value.value(key);
    m_bookEditSerials.clear();
    m_entrySettings.clear();
    for (const auto &key : entrySettingKeys) m_entrySettings[key] = entrySettingFromToken(value.value(entryFieldKey(key)));
    m_entryEditSerials.clear();
    m_insertionSettings.clear();
    for (const auto &key : insertionKeys) m_insertionSettings[key] = value.value(insertionFieldKey(key));
    m_insertionEditSerials.clear();
    m_insertionDependencyNotice.clear();
}
int ArchiveEditor::bookIndex(const QString &key) const { return m_bookKeys.indexOf(key); }
int ArchiveEditor::entryIndex(const QString &key, int book) const {
    return book >= 0 && book < m_entryKeys.size() ? m_entryKeys[book].indexOf(key) : -1;
}
QVariantList ArchiveEditor::bookRows() const {
    QVariantList rows;
    const auto books = m_archive.value("worldBooks").toList();
    for (int i = 0; i < books.size(); ++i) {
        const auto book = books[i].toMap();
        rows.append(QVariantMap{{"key", m_bookKeys.value(i)}, {"id", book.value("id")},
                                {"name", m_bookKey == m_bookKeys.value(i) ? m_title : book.value("name").toString()},
                                {"entryCount", book.value("entries").toList().size()}, {"newLocal", false}});
    }
    if (m_newKind == "book")
        rows.append(QVariantMap{{"key", m_bookKey}, {"id", m_newBook.value("id")},
                                {"name", m_title}, {"entryCount", 0}, {"newLocal", true}});
    return rows;
}
QVariantList ArchiveEditor::entryRows() const {
    QVariantList rows;
    const int b = bookIndex(m_bookKey);
    if (b < 0)
        return rows;
    const auto entries = m_archive.value("worldBooks").toList()[b].toMap().value("entries").toList();
    for (int i = 0; i < entries.size(); ++i) {
        const auto entry = entries[i].toMap();
        const bool selected = m_entryKey == m_entryKeys[b].value(i);
        rows.append(QVariantMap{{"key", m_entryKeys[b].value(i)}, {"id", entry.value("id")},
                                {"comment", selected ? m_comment : entry.value("comment").toString()},
                                {"enabled", selected ? m_enabled : entry.value("enabled", true).toBool()},
                                {"alwaysActive", selected ? m_alwaysActive : entry.value("alwaysActive", false).toBool()},
                                {"insertionOrder", selected ? m_insertionOrder : entry.value("insertionOrder", 100).toLongLong()},
                                {"newLocal", false}});
    }
    if (m_newKind == "entry")
        rows.append(QVariantMap{{"key", m_entryKey}, {"id", m_newEntry.value("id")},
                                {"comment", m_comment}, {"enabled", m_enabled},
                                {"alwaysActive", m_alwaysActive}, {"insertionOrder", m_insertionOrder},
                                {"newLocal", true}});
    return rows;
}
QVariantMap ArchiveEditor::advancedFields() const {
    auto book = m_selectedBook;
    auto entry = m_selectedEntry;
    for (const auto &key : {"id", "name", "entries"}) book.remove(key);
    for (const auto &key : {"id", "comment", "keywords", "secondaryKeywords", "selectiveLogic",
                            "caseSensitive", "useRegex", "content", "enabled", "alwaysActive", "insertionOrder"})
        entry.remove(key);
    return {{"book", book}, {"entry", entry}};
}
void ArchiveEditor::resetSelection(bool announceContextChange) {
    if (announceContextChange) beginFocusContextChange();
    m_bookKey.clear(); m_entryKey.clear(); m_newKind.clear(); m_newBook.clear(); m_newEntry.clear();
    m_selectedBook.clear(); m_selectedEntry.clear(); m_baseline.clear(); m_orphan = false;
    assignFields(editableFields({}, {}));
}
void ArchiveEditor::selectNow(const QString &bookKey, const QString &entryKey) {
    const auto requestedBook = bookKey, requestedEntry = entryKey;
    const int b = bookIndex(requestedBook);
    const int e = entryIndex(requestedEntry, b);
    const auto book = b >= 0 ? m_archive.value("worldBooks").toList()[b].toMap() : QVariantMap{};
    const auto entry = e >= 0 ? book.value("entries").toList()[e].toMap() : QVariantMap{};
    if (m_bookKey != (b >= 0 ? requestedBook : QString{}) ||
        m_entryKey != (e >= 0 ? requestedEntry : QString{}) ||
        m_content != entry.value("content").toString())
        beginFocusContextChange();
    // Internal clearing is not a second presented context. In particular a
    // same-entry discard that only resets other fields keeps its body selection.
    resetSelection(false);
    if (b >= 0) {
        m_bookKey = requestedBook;
        m_selectedBook = book;
        if (e >= 0) {
            m_entryKey = requestedEntry;
            m_selectedEntry = entry;
        }
        m_baseline = editableFields(m_selectedBook, m_selectedEntry);
        assignFields(m_baseline);
    }
    m_deletePrompt.clear();
    status("clean", "与已保存的档案一致");
}
void ArchiveEditor::selectBook(const QString &key) {
    if (key == m_bookKey || (!key.isEmpty() && bookIndex(key) < 0)) return;
    requestNavigation("book", key);
}
void ArchiveEditor::selectEntry(const QString &key) {
    if (!hasBook() || key == m_entryKey || (!key.isEmpty() && entryIndex(key, bookIndex(m_bookKey)) < 0)) return;
    requestNavigation("entry", key);
}
void ArchiveEditor::newBook() { if (canCreateBook()) requestNavigation("new-book"); }
void ArchiveEditor::newEntry() { if (canCreateEntry()) requestNavigation("new-entry"); }
void ArchiveEditor::requestNavigation(const QString &action, const QString &key) {
    if (!canNavigate() || !m_navigationPrompt.isEmpty()) return;
    if (dirty()) {
        m_pendingAction = action; m_pendingKey = key;
        m_navigationPrompt = {{"action", action}, {"text", "当前有未保存修改。保存后继续、放弃后继续，或取消。"}};
        emit changed();
    } else performNavigation(action, key);
}
void ArchiveEditor::performNavigation(const QString &action, const QString &key) {
    if (action == "book") {
        const int b = bookIndex(key);
        selectNow(key, b >= 0 ? m_entryKeys[b].value(0) : QString{});
    } else if (action == "entry") selectNow(m_bookKey, key);
    else if (action == "new-book") {
        resetSelection();
        m_newKind = "book"; m_bookKey = rowKey();
        m_newBook = {{"id", rowKey()}, {"name", "新世界书"}, {"entries", QVariantList{}},
                     {"scanDepth", 50}, {"tokenBudget", 500}, {"recursiveScanning", false}};
        m_selectedBook = m_newBook;
        assignFields(editableFields(m_newBook, {}));
        editChanged();
    } else if (action == "new-entry") {
        const QString book = m_bookKey;
        selectNow(book, {});
        beginFocusContextChange();
        m_newKind = "entry"; m_entryKey = rowKey();
        m_newEntry = {{"id", rowKey()}, {"comment", "新条目"}, {"keywords", QVariantList{}},
                      {"secondaryKeywords", QVariantList{}}, {"selectiveLogic", "and_any"},
                      {"caseSensitive", false},
                      {"content", ""}, {"enabled", true}, {"alwaysActive", false},
                      {"useRegex", false}, {"position", "before_char"}, {"insertionOrder", 100},
                      {"priority", 0}};
        m_selectedEntry = m_newEntry;
        assignFields(editableFields(m_selectedBook, m_newEntry));
        editChanged();
    }
}
void ArchiveEditor::discardDraft() {
    if (m_newKind == "book") selectNow({}, {});
    else if (m_newKind == "entry") {
        const int b = bookIndex(m_bookKey);
        selectNow(m_bookKey, b >= 0 ? m_entryKeys[b].value(0) : QString{});
    } else selectNow(m_bookKey, m_entryKey);
}
void ArchiveEditor::discardNew() {
    if (!newLocal() || busy()) return;
    m_pendingAction.clear(); m_pendingKey.clear(); m_navigationPrompt.clear();
    discardDraft();
}
void ArchiveEditor::resolveNavigation(const QString &choice) {
    if (m_navigationPrompt.isEmpty() || busy()) return;
    if (choice == "cancel") {
        m_pendingAction.clear(); m_pendingKey.clear(); m_navigationPrompt.clear(); emit changed(); return;
    }
    if (choice == "save") {
        if (!canSave()) return;
        m_navigationPrompt.clear();
        save();
        if (m_saveId.isEmpty()) { m_pendingAction.clear(); m_pendingKey.clear(); }
    } else if (choice == "discard") {
        const auto action = m_pendingAction, key = m_pendingKey;
        m_pendingAction.clear(); m_pendingKey.clear(); m_navigationPrompt.clear();
        discardDraft();
        performNavigation(action, key);
    }
}
void ArchiveEditor::remapKeys(const QVariantMap &archive, const QVariantMap &reference,
                             const QStringList &oldBookKeys, const QList<QStringList> &oldEntryKeys) {
    // Callers may pass the current members; copy before replacing them.
    const auto bookKeys = oldBookKeys;
    const auto entryKeys = oldEntryKeys;
    const auto books = archive.value("worldBooks").toList();
    const auto oldBooks = reference.value("worldBooks").toList();
    const auto matches = rowMatches(books, oldBooks);
    m_bookKeys.clear(); m_entryKeys.clear();
    for (int b = 0; b < books.size(); ++b) {
        const int old = matches[b];
        m_bookKeys.append(old >= 0 ? bookKeys.value(old, rowKey()) : rowKey());
        const auto entries = books[b].toMap().value("entries").toList();
        const auto oldEntries = old >= 0 ? oldBooks[old].toMap().value("entries").toList() : QVariantList{};
        const auto entryMatches = rowMatches(entries, oldEntries);
        QStringList keys;
        for (int e = 0; e < entries.size(); ++e)
            keys.append(old >= 0 && entryMatches[e] >= 0
                            ? entryKeys.value(old).value(entryMatches[e], rowKey()) : rowKey());
        m_entryKeys.append(keys);
    }
}
void ArchiveEditor::applySnapshot(const QVariantMap &archive, int revision, bool replaceDraft, bool ownSave) {
    m_readFailed = false;
    const auto priorBaseline = m_baseline;
    const auto currentInsertion = m_insertionSettings;
    QStringList keepInsertion;
    const auto insertionReference = ownSave ? m_submittedInsertionDraft : QVariantMap{};
    for (const auto &key : insertionKeys) {
        const auto reference = ownSave ? insertionReference.value(key) : priorBaseline.value(insertionFieldKey(key));
        if (currentInsertion.value(key) != reference ||
            m_insertionEditSerials.value(key) > (ownSave ? m_saveSerial : m_readSerial)) keepInsertion.append(key);
    }
    const auto currentRules = ruleGroup(fields());
    const bool editedRulesDuringRead = !ownSave && std::any_of(ruleKeys.begin(), ruleKeys.end(),
        [&](const QString &key) { return m_ruleEditSerials.value(key) > m_readSerial; });
    // An edit made after dispatch remains an explicit intent even if it was
    // changed back to the old value before this authority response arrives.
    const bool priorRuleDirty = m_ruleConflict || currentRules != ruleGroup(priorBaseline) || editedRulesDuringRead;
    const bool localModeEdited = currentRules.value("useRegex") != priorBaseline.value("useRegex") ||
        (!ownSave && m_ruleEditSerials.value("useRegex") > m_readSerial);
    const bool first = !m_initialized;
    const bool localBook = m_newKind == "book", localEntry = m_newKind == "entry";
    remapKeys(archive, ownSave ? m_submittedArchive : m_archive,
              ownSave ? m_submittedBookKeys : m_bookKeys,
              ownSave ? m_submittedEntryKeys : m_entryKeys);
    m_archive = archive; m_revision = revision; m_initialized = true;
    if (first) {
        selectNow(m_bookKeys.value(0), m_entryKeys.value(0).value(0));
        return;
    }
    const int b = bookIndex(m_bookKey), e = entryIndex(m_entryKey, b);
    if (!replaceDraft && !ownSave && (localBook || (localEntry && b >= 0))) return;
    if (hasBook() && (b < 0 || (hasEntry() && e < 0))) {
        if (!replaceDraft || ownSave) {
            m_orphan = true;
            return;
        }
        resetSelection();
        return;
    }
    if (ownSave) { m_newKind.clear(); m_newBook.clear(); m_newEntry.clear(); }
    m_orphan = false;
    m_selectedBook = b >= 0 ? archive.value("worldBooks").toList()[b].toMap() : QVariantMap{};
    m_selectedEntry = e >= 0 ? m_selectedBook.value("entries").toList()[e].toMap() : QVariantMap{};
    const bool keepPriority = m_priorityEdited ||
                              m_priorityEditSerial > (ownSave ? m_saveSerial : m_readSerial);
    QStringList keepBook;
    for (const auto &key : bookSettingKeys)
        if (bookSettingEdited(key) || m_bookEditSerials.value(key) > (ownSave ? m_saveSerial : m_readSerial))
            keepBook.append(key);
    QStringList keepEntry;
    for (const auto &key : entrySettingKeys)
        if (entrySettingEdited(key) || m_entryEditSerials.value(key) > (ownSave ? m_saveSerial : m_readSerial))
            keepEntry.append(key);
    m_baseline = editableFields(m_selectedBook, m_selectedEntry);
    if (replaceDraft) {
        // A same-entry authority replacement can change the body while the
        // selected keys stay identical. Ordinary user typing and an unchanged
        // save acknowledgement do not enter this presentation transaction.
        if (m_content != m_baseline.value("content").toString()) beginFocusContextChange();
        const auto insertionNotice = m_insertionDependencyNotice;
        assignFields(m_baseline);
        if (ownSave && !m_submittedInsertionEdited) m_insertionDependencyNotice = insertionNotice;
        return;
    }
    if (ownSave && m_submittedInsertionEdited) m_insertionDependencyNotice.clear();
    const auto authorityPosition = effectiveInsertion("position", m_baseline.value("insertionPosition"));
    const bool authorityPositionChanged = authorityPosition != effectiveInsertion("position", priorBaseline.value("insertionPosition"));
    const bool authorityDependentsChanged =
        effectiveInsertion("depth", m_baseline.value("insertionDepth")) != effectiveInsertion("depth", priorBaseline.value("insertionDepth")) ||
        effectiveInsertion("role", m_baseline.value("insertionRole")) != effectiveInsertion("role", priorBaseline.value("insertionRole"));
    if ((!ownSave || !m_submittedInsertionEdited) && ((authorityPositionChanged && (keepInsertion.contains("depth") || keepInsertion.contains("role"))) ||
                     (keepInsertion.contains("position") && authorityDependentsChanged))) {
        const auto mergedPosition = keepInsertion.contains("position") ? effectiveInsertion("position", currentInsertion.value("position")) : authorityPosition;
        m_insertionDependencyNotice = validInsertion("position", authorityPosition)
            ? "已保存的插入位置为「" + insertionLabel("position", authorityPosition) + "」。" : "已保存的插入位置未确认。";
        if (authorityPositionChanged && (keepInsertion.contains("depth") || keepInsertion.contains("role")))
            m_insertionDependencyNotice += mergedPosition != "at_depth"
                ? "你修改的深度／角色在此位置下不生效。" : "你修改的深度／角色仍保留，请核对实际生效状态。";
        if (keepInsertion.contains("position") && authorityDependentsChanged)
            m_insertionDependencyNotice += "已保存的深度／角色已变化；你修改的插入位置仍保留，请核对实际生效状态。";
    }
    for (const auto &key : insertionKeys)
        if (!keepInsertion.contains(key)) {
            m_insertionSettings[key] = m_baseline.value(insertionFieldKey(key));
            m_insertionEditSerials.remove(key);
        }
    const auto authorityRules = ruleGroup(m_baseline);
    if (!ownSave && priorRuleDirty &&
        (authorityRules.value("useRegex") != priorBaseline.value("useRegex") ||
         (localModeEdited &&
          (authorityRules.value("keywords") != priorBaseline.value("keywords") ||
           authorityRules.value("secondaryKeywords") != priorBaseline.value("secondaryKeywords")))))
        m_ruleConflict = true;
    if (ownSave) m_ruleConflict = false;
    if (!m_ruleConflict) {
        const auto reference = ownSave ? m_submittedRules : ruleGroup(priorBaseline);
        auto merged = currentRules;
        bool primaryChanged = false, secondaryChanged = false, modeChanged = false;
        for (const auto &key : ruleKeys) {
            const bool keep = currentRules.value(key) != reference.value(key) ||
                m_ruleEditSerials.value(key) > (ownSave ? m_saveSerial : m_readSerial);
            if (!keep) {
                merged[key] = authorityRules.value(key);
                m_ruleEditSerials.remove(key);
            }
        }
        primaryChanged = merged.value("keywords").toList() != m_keywordItems;
        secondaryChanged = merged.value("secondaryKeywords").toList() != m_secondaryKeywordItems;
        modeChanged = merged.value("useRegex").toBool() != m_useRegex;
        m_keywordItems = merged.value("keywords").toList();
        m_secondaryKeywordItems = merged.value("secondaryKeywords").toList();
        m_useRegex = merged.value("useRegex").toBool();
        m_selectiveLogic = merged.value("selectiveLogic").toString();
        m_caseSensitive = merged.value("caseSensitive").toBool();
        if (primaryChanged || modeChanged) m_keywords = listText(m_keywordItems, m_useRegex);
        if (secondaryChanged || modeChanged) m_secondaryKeywords = listText(m_secondaryKeywordItems, m_useRegex);
    }
    if (!keepPriority) m_priority = m_baseline.value("priority");
    else m_priorityEdited = m_priority != m_baseline.value("priority");
    for (const auto &key : bookSettingKeys)
        if (!keepBook.contains(key)) {
            m_bookSettings[key] = m_baseline.value(key);
            m_bookEditSerials.remove(key);
        }
    for (const auto &key : entrySettingKeys)
        if (!keepEntry.contains(key) ||
            (inheritedSetting(m_entrySettings.value(key)) &&
             inheritedSetting(entrySettingFromToken(m_baseline.value(entryFieldKey(key)))))) {
            // A retained inherit intent already agrees with an authoritative
            // inherit value. Adopt its stored form instead of keeping a
            // missing-versus-null-only dirty draft after normalization.
            m_entrySettings[key] = entrySettingFromToken(m_baseline.value(entryFieldKey(key)));
            m_entryEditSerials.remove(key);
        }
}
bool ArchiveEditor::snapshotValid(const QVariantMap &result) {
    if (result.value("ok").metaType().id() != QMetaType::Bool || !result.value("ok").toBool())
        return false;
    const auto revision = result.value("revision");
    if (!QList<int>{QMetaType::Int, QMetaType::UInt, QMetaType::LongLong, QMetaType::ULongLong,
                    QMetaType::Double}
             .contains(revision.metaType().id()))
        return false;
    const double number = revision.toDouble();
    if (!std::isfinite(number) || number < 0 || number > 1000000000 || number != std::floor(number))
        return false;
    if (result.value("exists").metaType().id() != QMetaType::Bool)
        return false;
    if (!result.value("exists").toBool())
        return number == 0 && result.contains("archive") && result.value("archive").isNull();
    const auto archive = result.value("archive").toMap();
    for (const auto &key : {"characters", "activeCharacterIds", "worldBooks"})
        if (archive.value(key).metaType().id() != QMetaType::QVariantList)
            return false;
    for (const auto &value : archive.value("worldBooks").toList()) {
        if (value.metaType().id() != QMetaType::QVariantMap)
            return false;
        const auto book = value.toMap();
        if (book.value("id").metaType().id() != QMetaType::QString ||
            book.value("id").toString().isEmpty() ||
            book.value("name").metaType().id() != QMetaType::QString ||
            book.value("entries").metaType().id() != QMetaType::QVariantList)
            return false;
        // As with priority below, a malformed book setting is never adopted
        // and then normalized by a whole-archive save.
        for (const auto &key : bookSettingKeys)
            if (book.contains(key) && !validBookSetting(key, book.value(key)))
                return false;
        for (const auto &item : book.value("entries").toList()) {
            if (item.metaType().id() != QMetaType::QVariantMap)
                return false;
            const auto entry = item.toMap();
            if (entry.value("id").metaType().id() != QMetaType::QString ||
                entry.value("id").toString().isEmpty() ||
                entry.value("content").metaType().id() != QMetaType::QString ||
                entry.value("keywords").metaType().id() != QMetaType::QVariantList)
                return false;
            // Never adopt a malformed priority and subsequently let a whole-
            // archive save normalize it into zero. Missing legacy fields remain
            // absent and read-only; valid large integers are retained verbatim.
            if (entry.contains("priority") && !nonNegativeInteger(entry.value("priority")))
                return false;
            // Every entry, not only the selected one: null follows the book,
            // anything other than null or a non-negative integer is malformed.
            for (const auto &key : entrySettingKeys)
                if (entry.contains(key) && !validEntrySetting(entry.value(key)))
                    return false;
            for (const auto &key : {"useRegex", "caseSensitive"})
                if (entry.contains(key) && entry.value(key).metaType().id() != QMetaType::Bool) return false;
            if (entry.contains("selectiveLogic") &&
                (entry.value("selectiveLogic").metaType().id() != QMetaType::QString ||
                 !validSelectiveLogic(entry.value("selectiveLogic").toString()))) return false;
            for (const auto &key : {"keywords", "secondaryKeywords"}) {
                if (!entry.contains(key) && QString(key) == "secondaryKeywords") continue;
                if (entry.value(key).metaType().id() != QMetaType::QVariantList || entry.value(key).toList().size() > 200)
                    return false;
                for (const auto &word : entry.value(key).toList())
                    if (word.metaType().id() != QMetaType::QString) return false;
            }
        }
    }
    return true;
}
QVariantMap ArchiveEditor::authorPromptReview(const QVariantMap &result) {
    const auto value = result.value("author_prompts");
    if (value.metaType().id() != QMetaType::QVariantMap)
        return {};
    const auto review = value.toMap();
    if (review.value("card_id").metaType().id() != QMetaType::QString)
        return {};
    for (const auto &kind : {"system", "post_history"}) {
        if (review.value(kind).metaType().id() != QMetaType::QVariantMap)
            return {};
        const auto item = review.value(kind).toMap();
        if (item.value("text").metaType().id() != QMetaType::QString ||
            item.value("flags").metaType().id() != QMetaType::QVariantList ||
            item.value("enabled").metaType().id() != QMetaType::Bool ||
            item.value("effective").metaType().id() != QMetaType::Bool)
            return {};
        for (const auto &flag : item.value("flags").toList())
            if (flag.metaType().id() != QMetaType::QString)
                return {};
    }
    return review;
}
QString ArchiveEditor::authorPromptBlocker() const {
    if (!m_connected)
        return "本地服务尚未连接，开关暂不能切换。";
    if (!m_writable)
        return "当前为只读状态，开关暂不能切换。";
    if (m_identityBusy)
        return "人格操作仍在核对中，开关暂不能切换。";
    if (!m_initialized || m_authorPrompts.isEmpty())
        return "档案尚未读取，开关暂不能切换。";
    if (!m_readId.isEmpty() || !m_saveId.isEmpty() || m_reconcilePending)
        return "档案正在读写，请稍候。";
    if (writesBlocked())
        return "档案保存状态尚未核对，请手动重新读取后再切换。";
    if (dirty())
        return "资料匣里有未保存的世界书修改，请先保存或放弃后再切换。";
    if (m_authorPrompts.value("card_id").toString().isEmpty())
        return "这个人格的档案里没有角色卡记录，无法保存开关。";
    return {};
}
void ArchiveEditor::authorFeedback(const QString &state, const QString &text, const QString &kind,
                                   bool enabled) {
    m_authorFeedback = {{"status", state}, {"text", text}, {"kind", kind}, {"enabled", enabled}};
    if (state == "pending")
        m_authorFeedback["requestId"] = m_saveId;
    emit changed();
}
void ArchiveEditor::setSession(bool connected, int generation, const QString &scope, bool writable,
                               bool identityBusy) {
    const bool replaced = !m_scope.isEmpty() && m_scope != scope;
    const bool busyChanged = m_identityBusy != identityBusy;
    m_identityBusy = identityBusy;
    if (replaced) {
        beginFocusContextChange();
        m_archive.clear();
        m_submittedArchive.clear(); m_submittedBookKeys.clear(); m_submittedEntryKeys.clear();
        resetSelection();
        m_bookKeys.clear(); m_entryKeys.clear();
        m_navigationPrompt.clear(); m_pendingAction.clear(); m_pendingKey.clear();
        m_deletePrompt.clear(); m_deleteFeedback.clear(); m_deleteTarget.clear();
        m_deleteReading = false; m_deleteUnknown = false; m_deleteRereadPending = false;
        m_deleteManualRefresh = false;
        m_deleteReadReconcilesRestore = false;
        m_writeBlocked = false;
        m_initialized = false;
        m_revision = 0;
        m_editSerial = 0;
        m_saveSerial = 0; m_readSerial = 0; m_savedRevision = 0;
        m_reconcilePending = false;
        m_reconcileRead = false;
        m_reconcileKeepDraft = false;
        m_authorPrompts.clear();
        m_authorFeedback.clear();
        m_authorRereadPending = false;
    }
    if (replaced || generation != m_generation) {
        m_worldbookDiagnostics.clear();
        if (!replaced && !m_deleteTarget.isEmpty() &&
            (!m_saveId.isEmpty() || m_deleteReading)) {
            const bool lostRead = m_deleteReading;
            if (!lostRead) m_deleteUnknown = true;
            // A lost put gets one authority read after reconnecting. A lost
            // authority read has already consumed that attempt; only a manual
            // refresh may retry it.
            m_deleteRereadPending = !lostRead;
            m_deleteReading = false;
            m_deleteReadReconcilesRestore = false;
            m_writeBlocked = true;
            m_deleteFeedback = {{"status", "unknown"}, {"outcome", m_deleteUnknown ? "unknown" : "confirmed-put"},
                                {"currentFact", "unconfirmed"},
                                {"text", lostRead ? "删除核对读取中断，原列表保留；请手动重新读取。"
                                                  : "连接中断，删除结果未确认；重新连接后只读取一次核对。"}};
        }
        m_reconcileRead = false;
        m_readId.clear();
        m_saveId.clear();
        m_deadline.stop();
        m_autoReadAttempted = false;
        m_pendingAction.clear(); m_pendingKey.clear(); m_navigationPrompt.clear();
        // The switch may or may not have been written; never report either.
        if (!m_authorKind.isEmpty()) {
            const auto kind = m_authorKind;
            m_authorKind.clear();
            m_authorRereadPending = !replaced;
            authorFeedback("unknown",
                           replaced ? "人格已切换，上一个人格的开关保存结果未确认。"
                                    : "连接中断，开关保存结果未确认；重新连接后会重新读取。",
                           kind, m_authorRequested);
        }
    }
    m_generation = generation;
    m_scope = scope;
    m_connected = connected;
    const bool becameWritable = !m_writable && writable;
    const bool writableChanged = m_writable != writable;
    m_writable = writable;
    if (becameWritable && m_reconcilePending && m_readId.isEmpty() && m_saveId.isEmpty())
        reconcileAfterRestore();
    if (!connected) {
        status("error", m_initialized ? "本地服务断开；草稿保留，尚未确认的保存不记为成功。"
                                      : "等待本地服务连接后读取档案。");
        return;
    }
    if (replaced)
        status("loading", "人格已切换，正在读取对应档案。");
    if (!m_initialized && m_readId.isEmpty() && !m_autoReadAttempted)
        load();
    else if (m_deleteRereadPending && !busy()) {
        m_deleteRereadPending = false;
        if (!readDeleteResult()) deleteReadFailed();
    }
    else if (m_authorRereadPending && rereadForAuthorPrompt())
        m_authorRereadPending = false;
    else if (writableChanged || busyChanged)
        emit changed();
}
void ArchiveEditor::reconcileAfterRestore() {
    m_reconcilePending = true;
    // This read began before the new restore event, so it cannot satisfy it.
    if (m_deleteReading) m_deleteReadReconcilesRestore = false;
    if (!m_connected || !m_readId.isEmpty() || !m_saveId.isEmpty())
        return;
    // A failed delete authority read remains a manual-refresh boundary.
    if (m_writeBlocked && !m_deleteTarget.isEmpty()) return;
    m_reconcileKeepDraft = dirty();
    m_navigationPrompt.clear(); m_pendingAction.clear(); m_pendingKey.clear(); m_deletePrompt.clear();
    m_reconcileRead = true;
    m_readSerial = m_editSerial;
    m_readId = m_send("archive:get", {});
    if (m_readId.isEmpty()) {
        m_readFailed = true;
        status("read-error", "恢复后的档案尚未核对；草稿保留，保存暂停。");
        return;
    }
    m_deadline.start();
    status("loading", "正在核对恢复后的档案 revision；未保存草稿会保留…");
}
void ArchiveEditor::load() {
    if (!m_connected || !m_readId.isEmpty() || !m_saveId.isEmpty())
        return;
    if (dirty()) {
        status("dirty", "草稿已保留；确认重新载入后才会替换它。");
        return;
    }
    m_readSerial = m_editSerial;
    m_reconcileKeepDraft = false;
    m_deletePrompt.clear();
    m_autoReadAttempted = true;
    m_deleteManualRefresh = m_writeBlocked && !m_deleteTarget.isEmpty();
    if (m_deleteManualRefresh) m_deleteReadReconcilesRestore = m_reconcilePending;
    m_readId = m_send("archive:get", {});
    if (m_readId.isEmpty()) {
        m_readFailed = true;
        status("error", "档案读取未派发，原草稿保留。");
        return;
    }
    m_deadline.start();
    status("loading", "正在读取当前人格的加密档案…");
}
void ArchiveEditor::reloadDiscardingDraft() {
    if (!m_connected || !m_saveId.isEmpty() || !m_readId.isEmpty())
        return;
    m_reconcileRead = m_reconcilePending;
    m_reconcileKeepDraft = false;
    m_readSerial = m_editSerial;
    m_autoReadAttempted = true;
    m_deleteManualRefresh = m_writeBlocked && !m_deleteTarget.isEmpty();
    if (m_deleteManualRefresh) m_deleteReadReconcilesRestore = m_reconcilePending;
    m_navigationPrompt.clear(); m_pendingAction.clear(); m_pendingKey.clear(); m_deletePrompt.clear();
    m_readId = m_send("archive:get", {});
    if (m_readId.isEmpty()) {
        m_readFailed = true;
        status("error", "未能重新读取；草稿仍保留。");
        return;
    }
    m_deadline.start();
    status("loading", "正在重新读取，成功后替换当前草稿…");
}
// Re-reads the authoritative switches unless a draft or another operation
// is in the way; a draft is never replaced on the switch's behalf.
bool ArchiveEditor::rereadForAuthorPrompt() {
    if (!m_connected || dirty() || !m_readId.isEmpty() || !m_saveId.isEmpty())
        return false;
    load();
    return !m_readId.isEmpty();
}
void ArchiveEditor::setAuthorPrompt(const QString &kind, bool enabled, bool confirmed) {
    // One switch save at a time; its pending feedback stays until it settles.
    if (!m_authorKind.isEmpty())
        return;
    const auto field = authorSwitchField(kind);
    if (field.isEmpty()) {
        authorFeedback("error", "开关无效，没有发送。", kind, enabled);
        return;
    }
    const auto name = authorPromptName(kind);
    if (const auto blocker = authorPromptBlocker(); !blocker.isEmpty()) {
        authorFeedback("error", blocker, kind, enabled);
        return;
    }
    const auto review = m_authorPrompts.value(kind).toMap();
    if (review.value("text").toString().isEmpty()) {
        authorFeedback("error", "当前人格没有" + name + "，开关没有改动。", kind, enabled);
        return;
    }
    if (review.value("enabled").toBool() == enabled)
        return;
    if (enabled && !review.value("flags").toList().isEmpty()) {
        authorFeedback("error", "这段" + name + "含有可疑指令，已隔离，不能开启。", kind, enabled);
        return;
    }
    if (enabled && !confirmed) {
        authorFeedback("error", "开启前需要先在确认框里确认，开关没有改动。", kind, enabled);
        return;
    }
    // Only this switch changes, on the last confirmed archive; a world-book
    // draft never rides along.
    auto archive = m_archive;
    auto cards = archive.value("characters").toList();
    const auto cardId = m_authorPrompts.value("card_id").toString();
    qsizetype index = -1;
    for (qsizetype i = 0; i < cards.size() && index < 0; ++i)
        if (cards[i].toMap().value("id").toString() == cardId)
            index = i;
    if (index < 0) {
        authorFeedback("error", "档案里找不到当前角色卡记录，开关没有改动。", kind, enabled);
        return;
    }
    auto card = cards[index].toMap();
    card[field] = enabled;
    cards[index] = card;
    archive["characters"] = cards;
    if (archiveBytes(archive) > 900000) {
        authorFeedback("error", "完整档案超过本次传输上限，开关没有发送。", kind, enabled);
        return;
    }
    m_deletePrompt.clear();
    m_savedRevision = m_revision;
    m_saveId = m_send("archive:put", {{"archive", archive}, {"expected_revision", m_revision}});
    if (m_saveId.isEmpty()) {
        authorFeedback("error", "开关未能发送，没有改动。", kind, enabled);
        return;
    }
    m_authorKind = kind;
    m_authorRequested = enabled;
    m_deadline.start();
    authorFeedback("pending", "正在保存…", kind, enabled);
}
void ArchiveEditor::receiveAuthorPrompt(const QVariantMap &result) {
    const auto kind = m_authorKind;
    const bool requested = m_authorRequested;
    const auto name = authorPromptName(kind);
    m_authorKind.clear();
    if (!snapshotValid(result)) {
        const auto code = result.value("code").toString();
        const auto text = code == "author_prompt_untrusted"
                              ? "这段" + name + "含有可疑指令，后端拒绝开启，开关没有改动。"
                          : code == "author_prompt_missing"
                              ? "当前人格没有" + name + "，后端拒绝开启，开关没有改动。"
                          : code == "conflict" ? QString("档案已被其他操作更新，开关没有改动。")
                                               : QString("开关未能保存，原状态保留。");
        const bool reread = rereadForAuthorPrompt();
        authorFeedback("error", text + (reread ? "已重新读取当前状态。" : ""), kind, requested);
        return;
    }
    const auto review = authorPromptReview(result);
    if (result.value("revision").toInt() != m_savedRevision + 1 || review.isEmpty() ||
        review.value(kind).toMap().value("enabled").toBool() != requested) {
        const bool reread = rereadForAuthorPrompt();
        authorFeedback("unknown",
                       QString("保存回执与请求不一致，结果未确认。") + (reread ? "已重新读取当前状态。" : ""),
                       kind, requested);
        return;
    }
    applySnapshot(result.value("archive").toMap(), result.value("revision").toInt(), false);
    m_authorPrompts = review;
    acceptWorldbookDiagnostics(result);
    // The world-book fields are untouched: an edit typed meanwhile stays a draft.
    if (dirty())
        status("dirty", "有未保存的修改 · 收起资料匣会保留草稿");
    else
        status("clean", "与已保存的档案一致");
    authorFeedback("success", requested ? "已开启" + name + "，下一轮对话起附上。" : "已关闭" + name + "。", kind,
                   requested);
}
QVariantMap ArchiveEditor::updatedArchive() const {
    auto archive = m_archive;
    if (!archive.contains("characters")) archive["characters"] = QVariantList{};
    if (!archive.contains("activeCharacterIds")) archive["activeCharacterIds"] = QVariantList{};
    auto books = archive.value("worldBooks").toList();
    const int b = bookIndex(m_bookKey);
    if (!hasBook() || m_orphan || (b < 0 && m_newKind != "book")) return archive;
    auto book = m_newKind == "book" ? m_newBook : books[b].toMap();
    if (m_newKind == "book" || m_title != m_baseline.value("title").toString()) book["name"] = m_title;
    for (const auto &key : bookSettingKeys)
        if ((m_newKind == "book" || bookSettingEdited(key)) && editableBookSetting(key, m_bookSettings.value(key)))
            book[key] = m_bookSettings.value(key);
    auto entries = book.value("entries").toList();
    const int e = entryIndex(m_entryKey, b);
    if (hasEntry() && (e >= 0 || m_newKind == "entry")) {
        auto entry = m_newKind == "entry" ? m_newEntry : entries[e].toMap();
        const auto current = fields();
        for (const auto &key : {"comment", "content", "enabled", "alwaysActive", "insertionOrder"})
            if (m_newKind == "entry" || current.value(key) != m_baseline.value(key)) entry[key] = current.value(key);
        if (m_priorityEdited && editablePriority(m_priority)) entry["priority"] = m_priority;
        for (const auto &key : entrySettingKeys)
            if (entrySettingEdited(key) && entrySettingEditable(key))
                // A later "follow the book" edit may still have the absent
                // form of the old baseline after an in-flight save/read
                // establishes an integer. Both inherited forms write null.
                entry[key] = inheritedSetting(m_entrySettings.value(key)) ? QVariant::fromValue(nullptr)
                                                                          : QVariant(m_entrySettings.value(key).toInt());
        for (const auto &key : insertionKeys)
            if (insertionEdited(key) && validInsertion(key, effectiveInsertion(key, m_insertionSettings.value(key))))
                entry[key] = effectiveInsertion(key, m_insertionSettings.value(key));
        if (m_newKind == "entry" || rulesDirty())
            for (const auto &key : ruleKeys) entry[key] = current.value(key);
        if (m_newKind == "entry") entries.append(entry);
        else entries[e] = entry;
    }
    book["entries"] = entries;
    if (m_newKind == "book") books.append(book);
    else books[b] = book;
    archive["worldBooks"] = books;
    return archive;
}
bool ArchiveEditor::submittedRulesMatch(const QVariantMap &archive, bool &missingTarget) const {
    missingTarget = false;
    if (!m_submittedRulesEdited) return true;
    const int submittedBook = m_submittedBookKeys.indexOf(m_bookKey);
    if (submittedBook < 0 || submittedBook >= m_submittedEntryKeys.size()) return false;
    const int submittedEntry = m_submittedEntryKeys[submittedBook].indexOf(m_entryKey);
    const auto expectedBooks = m_submittedArchive.value("worldBooks").toList();
    if (submittedBook >= expectedBooks.size() || submittedEntry < 0) return false;
    const auto expectedEntries = expectedBooks[submittedBook].toMap().value("entries").toList();
    if (submittedEntry >= expectedEntries.size()) return false;
    const auto books = archive.value("worldBooks").toList();
    const int book = rowMatches(books, expectedBooks).indexOf(submittedBook);
    if (book < 0) { missingTarget = true; return false; }
    const auto entries = books[book].toMap().value("entries").toList();
    const int entry = rowMatches(entries, expectedEntries).indexOf(submittedEntry);
    if (entry < 0) { missingTarget = true; return false; }
    const auto actual = entries[entry].toMap();
    for (const auto &key : ruleKeys) {
        if (!actual.contains(key)) return false;
        const auto want = m_submittedRules.value(key), got = actual.value(key);
        if (got.metaType() != want.metaType() || got != want) return false;
    }
    return true;
}
bool ArchiveEditor::submittedPriorityMatches(const QVariantMap &archive) const {
    if (!m_submittedPriorityEdited) return true;
    const int submittedBook = m_submittedBookKeys.indexOf(m_bookKey);
    if (submittedBook < 0 || submittedBook >= m_submittedEntryKeys.size()) return false;
    const int submittedEntry = m_submittedEntryKeys[submittedBook].indexOf(m_entryKey);
    const auto expectedBooks = m_submittedArchive.value("worldBooks").toList();
    const auto books = archive.value("worldBooks").toList();
    const int book = rowMatches(books, expectedBooks).indexOf(submittedBook);
    if (book < 0 || submittedEntry < 0) return false;
    const auto expectedEntries = expectedBooks[submittedBook].toMap().value("entries").toList();
    const auto entries = books[book].toMap().value("entries").toList();
    const int entry = rowMatches(entries, expectedEntries).indexOf(submittedEntry);
    if (entry < 0 || submittedEntry >= expectedEntries.size()) return false;
    const auto actual = entries[entry].toMap().value("priority");
    const auto expected = expectedEntries[submittedEntry].toMap().value("priority");
    return editablePriority(actual) && actual == expected;
}
bool ArchiveEditor::submittedBookSettingsMatch(const QVariantMap &archive) const {
    if (!m_submittedBookSettings) return true;
    const int submittedBook = m_submittedBookKeys.indexOf(m_bookKey);
    const auto expectedBooks = m_submittedArchive.value("worldBooks").toList();
    if (submittedBook < 0 || submittedBook >= expectedBooks.size()) return false;
    const auto books = archive.value("worldBooks").toList();
    const int book = rowMatches(books, expectedBooks).indexOf(submittedBook);
    if (book < 0) return false;
    const auto actual = books[book].toMap(), expected = expectedBooks[submittedBook].toMap();
    for (const auto &key : bookSettingKeys) {
        // An old archive may omit a setting. Its absence is part of the
        // submitted snapshot, not permission for a receipt to supply a default.
        if (actual.contains(key) != expected.contains(key)) return false;
        if (!expected.contains(key)) continue;
        if (!validBookSetting(key, expected.value(key)) || !validBookSetting(key, actual.value(key)) ||
            actual.value(key) != expected.value(key)) return false;
    }
    return true;
}
bool ArchiveEditor::submittedEntrySettingsMatch(const QVariantMap &archive, bool &missingTarget) const {
    missingTarget = false;
    if (!m_submittedEntrySettings) return true;
    const int submittedBook = m_submittedBookKeys.indexOf(m_bookKey);
    if (submittedBook < 0 || submittedBook >= m_submittedEntryKeys.size()) return false;
    const int submittedEntry = m_submittedEntryKeys[submittedBook].indexOf(m_entryKey);
    const auto expectedBooks = m_submittedArchive.value("worldBooks").toList();
    const auto books = archive.value("worldBooks").toList();
    const int book = rowMatches(books, expectedBooks).indexOf(submittedBook);
    if (submittedEntry < 0) return false;
    if (book < 0) { missingTarget = true; return false; }
    const auto expectedEntries = expectedBooks[submittedBook].toMap().value("entries").toList();
    const auto entries = books[book].toMap().value("entries").toList();
    const int entry = rowMatches(entries, expectedEntries).indexOf(submittedEntry);
    if (submittedEntry >= expectedEntries.size()) return false;
    if (entry < 0) { missingTarget = true; return false; }
    const auto actual = entries[entry].toMap(), expected = expectedEntries[submittedEntry].toMap();
    for (const auto &key : entrySettingKeys) {
        // The store writes an absent nullable setting as an explicit null. Only
        // that absence is normalized; the receipt itself must carry the field.
        const auto want = expected.contains(key) ? expected.value(key) : QVariant::fromValue(nullptr);
        if (!actual.contains(key) || !validEntrySetting(want)) return false;
        const auto got = actual.value(key);
        if (nullSetting(want) ? !nullSetting(got) : !(nonNegativeInteger(got) && got == want)) return false;
    }
    return true;
}
bool ArchiveEditor::submittedInsertionMatches(const QVariantMap &archive, bool &missingTarget) const {
    missingTarget = false;
    if (!m_submittedInsertionEdited) return true;
    const int submittedBook = m_submittedBookKeys.indexOf(m_bookKey);
    if (submittedBook < 0 || submittedBook >= m_submittedEntryKeys.size()) return false;
    const int submittedEntry = m_submittedEntryKeys[submittedBook].indexOf(m_entryKey);
    const auto expectedBooks = m_submittedArchive.value("worldBooks").toList(), books = archive.value("worldBooks").toList();
    if (submittedBook >= expectedBooks.size() || submittedEntry < 0) return false;
    const int book = rowMatches(books, expectedBooks).indexOf(submittedBook);
    if (book < 0) { missingTarget = true; return false; }
    const auto expectedEntries = expectedBooks[submittedBook].toMap().value("entries").toList();
    const auto entries = books[book].toMap().value("entries").toList();
    const int entry = rowMatches(entries, expectedEntries).indexOf(submittedEntry);
    if (entry < 0) { missingTarget = true; return false; }
    const auto actual = entries[entry].toMap();
    for (const auto &key : insertionKeys) {
        const auto want = m_submittedInsertion.value(key), got = actual.value(key);
        if (!actual.contains(key) || !validInsertion(key, got) || got.metaType() != want.metaType() || got != want) return false;
    }
    return true;
}
void ArchiveEditor::save() {
    if (!saveAllowed(false))
        return;
    const auto archive = updatedArchive();
    if (archiveBytes(archive) > 900000) {
        status("error", "档案超过本次传输限额；未截断或写入数据。");
        return;
    }
    m_deletePrompt.clear();
    // Keep the wire payload's legacy omissions, but compare/remap the receipt
    // against the store's canonical form of these two nullable entry fields.
    // This also preserves exact-object matching for duplicate imported IDs.
    m_submittedArchive = storedEntrySettings(QJsonObject::fromVariantMap(archive).toVariantMap());
    m_submittedBookKeys = m_bookKeys;
    m_submittedEntryKeys = m_entryKeys;
    if (m_newKind == "book") {
        m_submittedBookKeys.append(m_bookKey);
        m_submittedEntryKeys.append(QStringList{});
    } else if (m_newKind == "entry") m_submittedEntryKeys[bookIndex(m_bookKey)].append(m_entryKey);
    m_saveSerial = m_editSerial;
    m_savedRevision = m_revision;
    m_submittedInsertionDraft = m_insertionSettings;
    m_submittedInsertionEdited = hasEntry() && insertionDirty();
    QVariantMap expectedInsertion;
    for (const auto &key : insertionKeys) expectedInsertion[key] = effectiveInsertion(key, m_insertionSettings.value(key));
    m_submittedInsertion = QJsonObject::fromVariantMap(expectedInsertion).toVariantMap();
    if (m_submittedInsertionEdited) {
        // The store materializes implicit defaults. Canonicalize the selected
        // reference object too so duplicate-ID receipts can still match the
        // exact submitted occurrence; the transmitted archive stays sparse.
        const int b = m_submittedBookKeys.indexOf(m_bookKey);
        const int e = b >= 0 ? m_submittedEntryKeys[b].indexOf(m_entryKey) : -1;
        auto books = m_submittedArchive.value("worldBooks").toList();
        if (b >= 0 && b < books.size() && e >= 0) {
            auto book = books[b].toMap(); auto entries = book.value("entries").toList();
            if (e < entries.size()) {
                auto entry = entries[e].toMap();
                for (const auto &key : insertionKeys) entry[key] = m_submittedInsertion.value(key);
                entries[e] = entry; book["entries"] = entries; books[b] = book;
                m_submittedArchive["worldBooks"] = books;
            }
        }
    }
    m_submittedRules = ruleGroup(fields());
    m_submittedRulesEdited = hasEntry() && (m_newKind == "entry" || rulesDirty());
    m_submittedPriorityEdited = m_priorityEdited || m_newKind == "entry";
    m_submittedBookSettings = m_newKind == "book";
    for (const auto &key : bookSettingKeys) m_submittedBookSettings = m_submittedBookSettings || bookSettingEdited(key);
    // Every selected-entry save binds its inherited/overridden settings, even
    // when only content changed or a new entry kept both default inherit flags.
    m_submittedEntrySettings = hasEntry();
    m_submittedEntrySettingsEdited = false;
    for (const auto &key : entrySettingKeys)
        m_submittedEntrySettingsEdited = m_submittedEntrySettingsEdited || (hasEntry() && entrySettingEdited(key));
    m_saveId = m_send("archive:put", {{"archive", archive}, {"expected_revision", m_revision}});
    if (m_saveId.isEmpty()) {
        status("error", "保存未派发，草稿保留。");
        return;
    }
    m_deadline.start();
    status("saving", "正在等待档案保存回执…");
}
void ArchiveEditor::requestDelete(const QString &kind) {
    if ((kind == "book" && !canDeleteBook()) || (kind == "entry" && !canDeleteEntry()) ||
        (kind != "book" && kind != "entry")) return;
    const auto entries = m_selectedBook.value("entries").toList();
    int enabled = 0, always = 0;
    const auto counted = kind == "book" ? entries : QVariantList{m_selectedEntry};
    for (const auto &value : counted) {
        const auto entry = value.toMap();
        enabled += entry.value("enabled", true).toBool() ? 1 : 0;
        always += entry.value("enabled", true).toBool() && entry.value("alwaysActive", false).toBool() ? 1 : 0;
    }
    m_deletePrompt = {{"kind", kind}, {"name", kind == "book" ? m_title : m_comment},
                      {"entryCount", counted.size()}, {"enabledCount", enabled},
                      {"alwaysActiveCount", always}, {"revision", m_revision},
                      {"bookKey", m_bookKey}, {"entryKey", m_entryKey}};
    emit changed();
}
void ArchiveEditor::cancelDelete() { m_deletePrompt.clear(); emit changed(); }
void ArchiveEditor::confirmDelete() {
    if (m_deletePrompt.isEmpty()) return;
    const auto kind = m_deletePrompt.value("kind").toString();
    if ((kind == "book" ? !canDeleteBook() : !canDeleteEntry()) ||
        m_deletePrompt.value("revision").toInt() != m_revision ||
        m_deletePrompt.value("bookKey").toString() != m_bookKey ||
        m_deletePrompt.value("entryKey").toString() != m_entryKey) {
        m_deletePrompt.clear(); emit changed(); return;
    }
    auto archive = m_archive;
    auto books = archive.value("worldBooks").toList();
    const int b = bookIndex(m_bookKey), e = entryIndex(m_entryKey, b);
    m_submittedBookKeys = m_bookKeys; m_submittedEntryKeys = m_entryKeys;
    m_deleteTarget = m_deletePrompt;
    m_deleteTarget["book"] = m_selectedBook;
    m_deleteTarget["entry"] = m_selectedEntry;
    m_deleteTarget["bookIndex"] = b;
    m_deleteTarget["entryIndex"] = e;
    if (kind == "book") {
        books.removeAt(b); m_submittedBookKeys.removeAt(b); m_submittedEntryKeys.removeAt(b);
    } else {
        auto book = books[b].toMap();
        auto entries = book.value("entries").toList();
        entries.removeAt(e); m_submittedEntryKeys[b].removeAt(e);
        m_deleteTarget["nextEntryKey"] = m_submittedEntryKeys[b].value(qMin(e, int(entries.size()) - 1));
        book["entries"] = entries; books[b] = book;
    }
    archive["worldBooks"] = books;
    m_deletePrompt.clear();
    if (archiveBytes(archive) > 900000) {
        m_deleteTarget.clear();
        status("error", "删除后的完整档案仍超过传输上限，没有发送。"); return;
    }
    m_submittedArchive = archive;
    m_savedRevision = m_revision; m_saveSerial = m_editSerial;
    m_deleteUnknown = false;
    m_deleteManualRefresh = false;
    m_deleteReadReconcilesRestore = false;
    m_saveId = m_send("archive:put", {{"archive", archive}, {"expected_revision", m_revision}});
    if (m_saveId.isEmpty()) {
        m_deleteTarget.clear();
        m_deleteFeedback = {{"status", "error"}, {"outcome", "not-sent"}, {"currentFact", "present"},
                            {"text", "删除未派发，当前档案保持不变。"}};
        status("error", m_deleteFeedback.value("text").toString()); return;
    }
    m_deleteFeedback = {{"status", "pending"}, {"outcome", "pending"}, {"currentFact", "present"},
                        {"text", "正在提交删除；读回档案后才更新列表。"}};
    m_deadline.start(); status("saving", m_deleteFeedback.value("text").toString());
}
bool ArchiveEditor::readDeleteResult() {
    if (!m_connected || busy()) return false;
    m_readSerial = m_editSerial;
    m_deleteManualRefresh = false;
    m_deleteReadReconcilesRestore = m_reconcilePending;
    m_readId = m_send("archive:get", {});
    if (m_readId.isEmpty()) return false;
    m_deleteReading = true;
    m_deleteFeedback["status"] = m_deleteUnknown ? "unknown" : "reading";
    m_deleteFeedback["outcome"] = m_deleteUnknown ? "unknown" : "confirmed-put";
    m_deleteFeedback["text"] = m_deleteUnknown ? "删除结果未确认，正在读取当前档案；不会重发删除。"
                                                : "删除提交已确认，正在读取当前档案…";
    m_deadline.start(); status("loading", m_deleteFeedback.value("text").toString());
    return true;
}
void ArchiveEditor::deleteReadFailed() {
    m_deleteReading = false; m_deleteRereadPending = false; m_writeBlocked = true;
    m_deleteFeedback = {{"status", "unknown"}, {"outcome", m_deleteUnknown ? "unknown" : "confirmed-put"},
                        {"currentFact", "unconfirmed"},
                        {"text", "当前删除状态未读回，原列表保留。请手动重新读取；核对前暂停档案写入。"}};
    status("read-error", m_deleteFeedback.value("text").toString());
}
void ArchiveEditor::finishDeleteReconciliation(bool authoritativeRead) {
    const bool satisfiesRestore = authoritativeRead && m_deleteReadReconcilesRestore;
    m_deleteReadReconcilesRestore = false;
    if (!m_reconcilePending) return;
    if (satisfiesRestore) {
        m_reconcilePending = false;
        m_reconcileRead = false;
        m_reconcileKeepDraft = false;
        emit changed();
    } else if (!busy() && !m_writeBlocked) {
        // This is the previously requested restoration read, not a second
        // attempt at the unknown deletion's authority read.
        reconcileAfterRestore();
    }
}
void ArchiveEditor::settleDeleteRead(const QVariantMap &result) {
    if (!snapshotValid(result)) { deleteReadFailed(); return; }
    const auto archive = result.value("exists").toBool() ? result.value("archive").toMap() : emptyArchive();
    const int revision = result.value("revision").toInt();
    if (revision < m_savedRevision + (m_deleteUnknown ? 0 : 1) ||
        (m_deleteUnknown && revision == m_savedRevision && archive != m_archive) ||
        (!m_deleteUnknown && revision == m_savedRevision + 1 && archive != m_submittedArchive)) {
        deleteReadFailed();
        m_deleteFeedback["text"] = "读回 revision 过旧或与删除提交不一致；原列表保留，请手动重新读取核对。";
        status("read-error", m_deleteFeedback.value("text").toString());
        return;
    }
    const auto kind = m_deleteTarget.value("kind").toString();
    const auto targetBook = m_deleteTarget.value("book").toMap();
    const auto targetEntry = m_deleteTarget.value("entry").toMap();
    auto matchingBooks = [&](const QVariantMap &candidate) {
        QVariantList matches;
        for (const auto &value : candidate.value("worldBooks").toList())
            if (value.toMap().value("id") == targetBook.value("id")) matches.append(value);
        return matches;
    };
    const auto oldBooks = matchingBooks(m_archive), currentBooks = matchingBooks(archive);
    QString fact;
    // The complete submitted snapshot proves precisely which local occurrence
    // was removed, even when imported IDs are duplicated.
    if (revision >= m_savedRevision + 1 && archive == m_submittedArchive) fact = "absent";
    else if (archive == m_archive) fact = "present";
    else if (oldBooks.size() == 1 && currentBooks.isEmpty()) fact = "absent";
    else if (oldBooks.size() == 1 && currentBooks.size() == 1) {
        if (kind == "book") fact = "present";
        else {
            auto matchingEntries = [&](const QVariantMap &book) {
                QVariantList matches;
                for (const auto &value : book.value("entries").toList())
                    if (value.toMap().value("id") == targetEntry.value("id")) matches.append(value);
                return matches;
            };
            const auto oldEntries = matchingEntries(targetBook);
            const auto currentEntries = matchingEntries(currentBooks.first().toMap());
            if (oldEntries.size() == 1 && currentEntries.isEmpty()) fact = "absent";
            else if (oldEntries.size() == 1 && currentEntries.size() == 1) fact = "present";
            else {
                int oldExact = 0, currentExact = 0;
                for (const auto &value : oldEntries) if (value.toMap() == targetEntry) ++oldExact;
                for (const auto &value : currentEntries) if (value.toMap() == targetEntry) ++currentExact;
                // An unchanged selected object can establish presence. A lower
                // duplicate-ID count alone does not establish its absence.
                if (oldExact > 0 && currentExact >= oldExact) fact = "present";
            }
        }
    } else {
        int oldExact = 0, currentExact = 0;
        for (const auto &value : oldBooks) if (value.toMap() == targetBook) ++oldExact;
        for (const auto &value : currentBooks) if (value.toMap() == targetBook) ++currentExact;
        if (oldExact > 0 && currentExact >= oldExact) fact = "present";
    }
    if (fact.isEmpty() && m_deleteManualRefresh) {
        applySnapshot(archive, revision, m_editSerial == m_readSerial);
        m_authorPrompts = authorPromptReview(result);
    acceptWorldbookDiagnostics(result);
        m_writeBlocked = false; m_deleteReading = false; m_deleteRereadPending = false;
        m_deleteManualRefresh = false; m_deleteTarget.clear();
        m_deleteFeedback = {{"status", "unknown"}, {"outcome", m_deleteUnknown ? "unknown" : "confirmed-put"},
                            {"currentFact", "unconfirmed"},
                            {"text", "已手动读取当前档案；原删除目标含重复标识，无法确认请求结果。"}};
        status(m_orphan ? "orphan" : dirty() ? "dirty" : "clean", m_deleteFeedback.value("text").toString());
        finishDeleteReconciliation(true);
        return;
    }
    if (fact.isEmpty()) {
        deleteReadFailed();
        m_deleteFeedback["text"] = "重复标识的删除目标无法从当前档案唯一核对；原列表保留，请手动重新读取。";
        status("read-error", m_deleteFeedback.value("text").toString());
        return;
    }
    const bool absent = fact == "absent";
    const bool keepDraft = m_editSerial != (m_deleteManualRefresh ? m_readSerial : m_saveSerial);
    if (absent) {
        applySnapshot(archive, revision, !keepDraft, true);
        if (!keepDraft) {
            const auto next = m_deleteTarget.value("nextEntryKey").toString();
            const auto book = m_deleteTarget.value("bookKey").toString();
            if (kind == "entry" && !next.isEmpty() && entryIndex(next, bookIndex(book)) >= 0)
                selectNow(book, next);
            else selectNow({}, {});
        }
    } else applySnapshot(archive, revision, !keepDraft);
    m_authorPrompts = authorPromptReview(result);
    acceptWorldbookDiagnostics(result);
    m_writeBlocked = false; m_deleteReading = false; m_deleteRereadPending = false; m_deleteManualRefresh = false;
    const auto outcome = m_deleteUnknown ? QString("unknown") : QString("confirmed-put");
    m_deleteFeedback = {{"status", m_deleteUnknown ? "unknown" : absent ? "success" : "error"},
                        {"outcome", outcome}, {"currentFact", absent ? "absent" : "present"},
                        {"text", m_deleteUnknown
                                     ? (absent ? "原删除请求结果未确认；当前读回目标已不存在。" : "原删除请求结果未确认；当前读回目标仍存在。")
                                     : (absent ? "删除已确认，当前档案已读回。" : "已收到删除回执；当前读回目标仍存在，请核对。")}};
    m_deleteTarget.clear();
    status(m_orphan ? "orphan" : dirty() ? "dirty" : "clean", m_deleteFeedback.value("text").toString());
    finishDeleteReconciliation(true);
}
void ArchiveEditor::receive(const QString &id, const QString &command, const QVariantMap &result,
                            int generation) {
    if (generation != m_generation)
        return;
    const bool read = command == "archive:get" && id == m_readId && !id.isEmpty();
    const bool save = command == "archive:put" && id == m_saveId && !id.isEmpty();
    if (!read && !save)
        return;
    m_deadline.stop();
    if (read)
        m_readId.clear();
    else
        m_saveId.clear();
    if (save && !m_authorKind.isEmpty()) {
        receiveAuthorPrompt(result);
        return;
    }
    if (read && (m_deleteReading || (m_writeBlocked && !m_deleteTarget.isEmpty()))) {
        settleDeleteRead(result);
        return;
    }
    if (save && !m_deleteTarget.isEmpty()) {
        const bool valid = snapshotValid(result) && result.value("revision").toInt() == m_savedRevision + 1 &&
                           result.value("archive").toMap() == m_submittedArchive;
        const auto code = result.value("code").toString();
        const bool uncertainCode = QStringList{"timeout", "deadline", "disconnected", "unknown", "transport_error"}.contains(code);
        const bool refused = result.value("ok").metaType().id() == QMetaType::Bool &&
                             !result.value("ok").toBool() && !code.isEmpty() && !uncertainCode;
        if (!valid && refused) {
            m_deleteFeedback = {{"status", code == "conflict" ? "conflict" : "error"},
                                {"outcome", "refused"}, {"currentFact", "unconfirmed"},
                                {"text", code == "conflict" ? "档案已被其他操作更新，删除被拒绝；原列表保留。"
                                                              : "删除被拒绝，原列表与 revision 保留。"}};
            m_deleteTarget.clear();
            status(code == "conflict" ? "conflict" : "error", m_deleteFeedback.value("text").toString());
            finishDeleteReconciliation(false);
            return;
        }
        m_deleteUnknown = !valid;
        if (!readDeleteResult()) deleteReadFailed();
        return;
    }
    if (!snapshotValid(result)) {
        m_worldbookDiagnostics.clear();
        if (read) m_readFailed = true;
        m_pendingAction.clear(); m_pendingKey.clear();
        if (save && result.value("code") == "conflict")
            status("conflict", "档案已被其他操作更新。草稿保留，请重新载入后再合并修改。");
        else
            status(read ? "read-error" : "error",
                   read ? "读取失败；优先级、书设置与条目扫描设置未确认，不使用默认值。现有草稿保留，不使用不完整的档案替换它。"
                        : "保存失败或结果未确认；草稿保留，没有写入成功的结论。");
        return;
    }
    if (save && result.value("revision").toInt() != m_savedRevision + 1) {
        m_worldbookDiagnostics.clear();
        m_pendingAction.clear(); m_pendingKey.clear();
        status("error", "保存回执的 revision 不一致，草稿保留，请重新读取确认。");
        return;
    }
    if (save) {
        bool missingRuleTarget = false;
        const bool rulesMatch = submittedRulesMatch(result.value("archive").toMap(), missingRuleTarget);
        bool missingEntryTarget = false;
        const bool entrySettingsMatch = submittedEntrySettingsMatch(result.value("archive").toMap(), missingEntryTarget);
        // A content or rule save that loses its selected target still follows the
        // existing orphan/write-lock path in applySnapshot below. Explicit
        // priority/settings edits retain their original receipt rejection.
        bool missingInsertionTarget = false;
        const bool insertionMatch = submittedInsertionMatches(result.value("archive").toMap(), missingInsertionTarget);
        const bool reconcileOrphan = missingEntryTarget && !m_submittedEntrySettingsEdited;
        if ((!rulesMatch && !missingRuleTarget) ||
            !submittedPriorityMatches(result.value("archive").toMap()) ||
            !submittedBookSettingsMatch(result.value("archive").toMap()) ||
            (!entrySettingsMatch && !reconcileOrphan) ||
            (!insertionMatch && !missingInsertionTarget)) {
            m_pendingAction.clear(); m_pendingKey.clear();
            m_worldbookDiagnostics.clear();
            status("error", !insertionMatch && !missingInsertionTarget
                ? "保存回执的插入方式不一致，草稿保留，请重新读取确认。"
                : "保存回执的匹配规则、条目、优先级、书设置或条目扫描设置不一致，草稿保留，请重新读取确认。");
            return;
        }
    }
    const bool replaceDraft = (read && m_editSerial == m_readSerial && !(m_reconcileRead && m_reconcileKeepDraft)) ||
                              (save && m_editSerial == m_saveSerial);
    const auto archive = result.value("exists").toBool() ? result.value("archive").toMap() : emptyArchive();
    applySnapshot(archive, result.value("revision").toInt(), replaceDraft, save);
    m_authorPrompts = authorPromptReview(result);
    acceptWorldbookDiagnostics(result);
    if (read) m_writeBlocked = false;
    if (read && m_reconcileRead) {
        m_reconcileRead = false;
        m_reconcilePending = false;
    }
    status(m_orphan ? "orphan"
           : dirty() ? "dirty"
           : save  ? "saved"
                   : "clean",
           m_orphan ? "当前条目在读回档案中已不存在；原草稿保留，不能写入其他条目。请放弃或重新读取。"
           : dirty() ? (read ? "新版本已读取；读取期间的编辑仍保留为草稿。"
                           : "提交版本已保存；后续编辑仍为草稿。")
           : save  ? "已保存 · 下一轮聊天使用新 revision"
                   : "已读取当前人格的档案");
    if (save && !m_pendingAction.isEmpty()) {
        const auto action = m_pendingAction, key = m_pendingKey;
        m_pendingAction.clear(); m_pendingKey.clear();
        if (m_editSerial == m_saveSerial && !dirty()) performNavigation(action, key);
    }
    if (m_reconcilePending && !m_reconcileRead) reconcileAfterRestore();
}
void ArchiveEditor::failed(const QString &id, const QString &, int generation) {
    if (generation != m_generation || (id != m_readId && id != m_saveId) || id.isEmpty())
        return;
    m_worldbookDiagnostics.clear();
    const bool author = id == m_saveId && !m_authorKind.isEmpty();
    if (id == m_readId) m_readFailed = true;
    const bool deletion = id == m_saveId && !m_deleteTarget.isEmpty();
    const bool deleteRead = id == m_readId && (m_deleteReading || (m_writeBlocked && !m_deleteTarget.isEmpty()));
    m_readId.clear();
    m_saveId.clear();
    m_deadline.stop();
    m_pendingAction.clear(); m_pendingKey.clear();
    if (deleteRead) { deleteReadFailed(); return; }
    if (deletion) {
        m_deleteUnknown = true;
        if (!readDeleteResult()) deleteReadFailed();
        return;
    }
    if (author) {
        const auto kind = m_authorKind;
        m_authorKind.clear();
        const bool reread = rereadForAuthorPrompt();
        m_authorRereadPending = !reread;
        authorFeedback("unknown",
                       QString("开关保存结果未确认。") +
                           (reread ? "已重新读取当前状态。" : "重新连接或处理草稿后会重新读取。"),
                       kind, m_authorRequested);
        return;
    }
    status("error", "操作未收到确认；草稿保留，请重新读取核对结果。");
}
void ArchiveEditor::acceptWorldbookDiagnostics(const QVariantMap &result) {
    m_worldbookDiagnostics.clear();
    if (result.value("ok").metaType().id() != QMetaType::Bool || !result.value("ok").toBool() ||
        result.value("persona_id").metaType().id() != QMetaType::QString ||
        result.value("persona_id").toString() != personaFromScope(m_scope) ||
        result.value("world_book_diagnostics").metaType().id() != QMetaType::QVariantMap) return;
    const auto data = result.value("world_book_diagnostics").toMap();
    const auto persona = data.value("persona_id"), request = data.value("request_id"), revision = data.value("revision");
    const auto truncated = data.value("truncated", 0);
    if (!diagnosticIdentifier(persona) || persona.toString() != personaFromScope(m_scope) ||
        !diagnosticIdentifier(request, 128, true) || !boundedInteger(revision, 0, 1000000000) ||
        revision.toInt() != m_revision || result.value("revision").toInt() != m_revision ||
        !boundedInteger(truncated, 0, 1000000) || data.value("entries").metaType().id() != QMetaType::QVariantList ||
        data.value("entries").toList().size() > 200) return;
    const auto books = m_archive.value("worldBooks").toList();
    QVariantList accepted; QSet<QByteArray> seen;
    for (const auto &value : data.value("entries").toList()) {
        if (value.metaType().id() != QMetaType::QVariantMap) return;
        const auto entry = value.toMap();
        if (entry.value("persona_id").metaType().id() != QMetaType::QString || entry.value("persona_id") != persona ||
            !boundedInteger(entry.value("revision"), 0, 1000000000) || entry.value("revision").toInt() != revision.toInt() ||
            entry.value("request_id").metaType().id() != QMetaType::QString || entry.value("request_id") != request ||
            entry.value("code").metaType().id() != QMetaType::QString || !worldbookLabels.contains(entry.value("code").toString()) ||
            !diagnosticIdentifier(entry.value("book_id"), 160, true) ||
            !diagnosticIdentifier(entry.value("entry_id"), 160, true) ||
            !boundedInteger(entry.value("book_index"), -1, 100000) ||
            !boundedInteger(entry.value("entry_index"), -1, 100000)) return;
        const auto code = entry.value("code").toString();
        const int b = entry.value("book_index").toInt(), e = entry.value("entry_index").toInt();
        const auto bookId = entry.value("book_id").toString(), entryId = entry.value("entry_id").toString();
        const bool global = code == "snapshot_unavailable" || (code == "regex_worker_unavailable" && b == -1);
        const bool recursive = code == "recursion_depth_limit" || code == "recursion_text_limit";
        if (global) {
            if (b != -1 || e != -1 || !bookId.isEmpty() || !entryId.isEmpty()) return;
        } else {
            if (b < 0 || b >= books.size() || bookId.isEmpty() || books[b].toMap().value("id").toString() != bookId) return;
            const auto entries = books[b].toMap().value("entries").toList();
            if (recursive && e == -1) {
                if (!entryId.isEmpty()) return;
            } else if (e < 0 || e >= entries.size() || entryId.isEmpty() ||
                       entries[e].toMap().value("id").toString() != entryId) return;
        }
        QVariantMap clean{{"persona_id", persona}, {"revision", revision.toInt()}, {"request_id", request},
            {"book_index", b}, {"entry_index", e}, {"book_id", bookId}, {"entry_id", entryId}, {"code", code}};
        const auto identity = QJsonDocument(QJsonObject::fromVariantMap({{"book_index", b}, {"entry_index", e},
            {"book_id", bookId}, {"entry_id", entryId}, {"code", code}})).toJson(QJsonDocument::Compact);
        if (!seen.contains(identity)) { seen.insert(identity); accepted.append(clean); }
    }
    if (request.toString().isEmpty() && (!accepted.isEmpty() || truncated.toInt() != 0)) return;
    m_worldbookDiagnostics = {{"persona_id", persona}, {"revision", revision.toInt()}, {"request_id", request},
        {"entries", accepted}, {"truncated", truncated.toInt()}};
}
QVariantMap ArchiveEditor::regexDiagnostics() const {
    const int b = bookIndex(m_bookKey), e = entryIndex(m_entryKey, b);
    QVariantMap result{{"status", "unavailable"}, {"text", "运行诊断暂不可用"},
        {"messages", QStringList{}}, {"codes", QStringList{}}, {"requestId", ""},
        {"revision", m_revision}, {"truncated", 0}, {"available", false}, {"dirtyNote", ""},
        {"bookIndex", b}, {"entryIndex", e}};
    if (hasEntry() && m_newKind == "entry") {
        result["status"] = "unsaved"; result["text"] = "尚未保存，没有运行诊断。";
        return result;
    }
    if (!hasEntry() || m_orphan || b < 0 || e < 0 || !m_useRegex || !m_connected || m_readFailed || m_worldbookDiagnostics.isEmpty() ||
        m_worldbookDiagnostics.value("revision").toInt() != m_revision ||
        m_worldbookDiagnostics.value("persona_id").toString() != personaFromScope(m_scope)) return result;
    result["available"] = true;
    result["requestId"] = m_worldbookDiagnostics.value("request_id");
    const int truncated = m_worldbookDiagnostics.value("truncated").toInt(); result["truncated"] = truncated;
    if (dirty()) result["dirtyNote"] = QString("以下诊断属于已保存版本 REV %1，不含未保存的修改。").arg(m_revision);
    if (result.value("requestId").toString().isEmpty()) {
        result["status"] = "unrun"; result["text"] = "本版本尚无运行诊断"; return result;
    }
    QStringList codes, messages; bool global = false;
    for (const auto &value : m_worldbookDiagnostics.value("entries").toList()) {
        const auto entry = value.toMap();
        const bool all = entry.value("book_index").toInt() == -1;
        // Book-only recursion reports are valid metadata but outside this UI.
        // A source-entry recursion report has explicit ownership and is shown.
        const bool selected = entry.value("book_index").toInt() == b && entry.value("entry_index").toInt() == e;
        if (!all && !selected) continue;
        const auto code = entry.value("code").toString();
        if (!codes.contains(code)) { codes.append(code); messages.append(worldbookLabels.value(code)); }
        global = global || all;
    }
    result["codes"] = codes; result["messages"] = messages;
    if (!messages.isEmpty()) {
        result["status"] = global ? "global-error" : "entry-error";
        result["text"] = messages.join(" ");
    } else if (truncated > 0) {
        result["status"] = "truncated"; result["text"] = "诊断未完整列出，无法确定此条目的运行情况。";
    } else {
        result["status"] = "clear";
        result["text"] = "最近一次对话评估未报告此条目的问题。这不表示正则已验证有效：常驻条目不执行匹配，主模式未命中时不执行辅助模式。";
    }
    if (truncated > 0) result["text"] = result.value("text").toString() + QString(" 另有 %1 条诊断未列出。").arg(truncated);
    return result;
}
QVariantMap ArchiveEditor::diagnostics() const {
    return {{"initialized", m_initialized},
            {"dirty", dirty()},
            {"status", m_status},
            {"revision", m_revision},
            {"selectedBookKey", m_bookKey},
            {"selectedEntryKey", m_entryKey},
            {"newLocal", newLocal()},
            {"orphan", m_orphan},
            {"writesBlocked", writesBlocked()},
            {"savedBytes", savedBytes()},
            {"draftBytes", draftBytes()},
            {"deleteFeedback", m_deleteFeedback},
            {"saving", !m_saveId.isEmpty()},
            {"authorPromptSaving", !m_authorKind.isEmpty()},
            {"loading", !m_readId.isEmpty()}};
}
