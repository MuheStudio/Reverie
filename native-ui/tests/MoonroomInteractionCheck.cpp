#include "MoonroomInteractionCheck.h"
#include "CheckContract.h"
#include "SceneOcclusionProbe.h"
#include "FrameCadenceProbe.h"
#include "ReadingSelectionProbe.h"
#include "ArchiveControlReadiness.h"
#include "ArchiveFocusProbe.h"
#include "../src/ArchiveEditor.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include <QCoreApplication>
#include <QDateTime>
#include <QGuiApplication>
#include <QStyleHints>
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QJsonValue>
#include <QJSValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QSet>
#include <QTest>
#include <QTimer>
#include <QThread>
#include <QtTest/qtestwheel.h>
#include <algorithm>
#include <cmath>
#include <exception>
#include <stdexcept>
#include <utility>

namespace {
using Action = std::function<void()>;
using Predicate = std::function<bool()>;
struct Step {
    QString name;
    Action enter;
    Predicate ready;
    Action validate;
    int minimumMs = 0;
    int timeoutMs = 4000;
};

void require(bool condition, const QString &reason) {
    if (!condition)
        throw std::runtime_error(reason.toStdString());
}
QVariantMap mapValue(const QVariant &value) {
    return value.metaType() == QMetaType::fromType<QJSValue>()
               ? value.value<QJSValue>().toVariant().toMap()
               : value.toMap();
}
QQuickItem *visualFind(QQuickItem *root, const QString &name, bool usable = true) {
    if (!root)
        return nullptr;
    if (root->objectName() == name && (!usable || (root->isVisible() && root->isEnabled())))
        return root;
    for (auto *child : root->childItems())
        if (auto *found = visualFind(child, name, usable))
            return found;
    return nullptr;
}
bool within(QQuickItem *item, QQuickItem *ancestor) {
    for (auto *current = item; current; current = current->parentItem())
        if (current == ancestor)
            return true;
    return false;
}
QRectF sceneRect(QQuickItem *item) {
    return item->mapRectToScene(QRectF(0, 0, item->width(), item->height()));
}
double effectiveOpacity(QQuickItem *item) {
    double opacity = 1;
    for (auto *current = item; current; current = current->parentItem())
        opacity *= current->opacity();
    return opacity;
}
QVariantMap rectMap(const QRectF &rect) {
    return {{"x", rect.x()}, {"y", rect.y()}, {"width", rect.width()}, {"height", rect.height()}};
}

// A bounded, passive view of the final pre-press review through the first move
// review. Added/removed mean observed visual-tree membership, not construction
// or destruction. Only QObject::destroyed is recorded as confirmed destruction.
class ReadingLayoutTimeline final : public QObject {
    Q_OBJECT
public:
    explicit ReadingLayoutTimeline(QObject *parent = nullptr) : QObject(parent) {}
    ~ReadingLayoutTimeline() override { disconnectAll(); }
    class WindowGuard final {
    public:
        explicit WindowGuard(ReadingLayoutTimeline &observer)
            : m_observer(&observer), m_exceptions(std::uncaught_exceptions()) {}
        ~WindowGuard() {
            if (!m_observer) return;
            m_observer->stop(std::uncaught_exceptions() > m_exceptions
                ? "exception-before-first-move" : m_observer->m_armed
                    ? "review-scope-exit" : "final-review-not-armed");
        }
    private:
        QPointer<ReadingLayoutTimeline> m_observer;
        int m_exceptions;
    };

    void reset() noexcept {
        disconnectAll();
        m_prepared = m_armed = m_stopped = m_inCallback = false;
        m_observerError = m_scanTruncated = m_trackingTruncated = m_stringTruncated = false;
        m_events.clear(); m_rows.clear(); m_watches.clear(); m_missingNotifications.clear();
        m_initialRows.clear(); m_terminalRows.clear(); m_lastLayout.clear();
        m_initialLayout.clear(); m_terminalLayout.clear();
        m_history.clear(); m_chat.clear(); m_text.clear(); m_targetRow.clear(); m_content.clear();
        m_started = m_ended = -1; m_sequence = m_droppedEvents = m_scanOmissions = 0;
        m_trackingOmissions = m_connectionOmissions = 0;
        m_suppressedNotifications = 0;
        m_missingNotificationOmissions = 0;
        m_targetIndex = -1; m_nextRowToken = 0; m_stopReason.clear();
        m_destroyedSource.clear();
    }
    void prepare(QQuickItem *history, QQuickItem *chat, QQuickItem *text,
                 ReadingSelectionProbe::Clock clock) noexcept {
        reset();
        try {
            m_history = history; m_chat = chat; m_text = text; m_clock = std::move(clock);
            if (QThread::currentThread() != thread() || !history || !chat || !text ||
                history->thread() != thread() || chat->thread() != thread() || text->thread() != thread())
                return;
            const QString wanted = "chatMessageRow-" + text->objectName().mid(QString("chatMessage-").size());
            auto *ancestor = text->parentItem();
            for (int depth = 0; ancestor && depth < ParentLimit; ++depth, ancestor = ancestor->parentItem())
                if (ancestor->objectName() == wanted) { m_targetRow = ancestor; break; }
            if (!m_targetRow && ancestor) m_trackingTruncated = true;
            m_content = history->property("contentItem").value<QQuickItem *>();
            for (const auto *name : {"contentHeight", "originY", "contentY", "count"})
                watch(history, name, "list");
            for (const auto *name : {"restoreRequestCount", "restoreExecutionCount", "readingPointerActive"})
                watch(chat, name, "chat");
            for (auto *item : {m_targetRow.data(), text}) {
                if (!item) continue;
                const QString source = item == text ? "textItem" : "targetRow";
                for (const auto *name : {"x", "y", "width", "height", "parent"}) watch(item, name, source);
                if (item != text)
                    for (const auto *name : {"index", "messageId", "objectName"}) watch(item, name, source);
            }
            const std::pair<QObject *, const char *> sources[] = {
                {history, "list"}, {chat, "chat"}, {text, "textItem"},
                {m_targetRow.data(), "targetRow"}, {m_content.data(), "contentItem"}};
            for (const auto &[object, source] : sources) {
                if (!object) continue;
                keep(connect(object, &QObject::destroyed, this, [this, source] {
                    // Ancestors may already be destructing. Preserve the last
                    // read values, rather than mapping partially destroyed items.
                    m_destroyedSource = QString::fromLatin1(source);
                    stop("source-destroyed", true);
                }, Qt::DirectConnection));
            }
            if (m_content)
                keep(connect(m_content, &QQuickItem::childrenChanged, this,
                             &ReadingLayoutTimeline::childrenChanged, Qt::DirectConnection));
            m_prepared = true;
            m_inCallback = true;
            refreshRows();
            m_inCallback = false;
        } catch (...) { diagnosticError(); }
    }
    void arm() noexcept {
        try {
            if (!m_prepared || m_stopped) return;
            bool known = false;
            m_targetIndex = m_targetRow ? m_targetRow->property("index").toInt(&known) : -1;
            if (!known) m_targetIndex = -1;
            m_inCallback = true;
            refreshRows();
            m_initialRows = upperRows();
            m_started = now();
            m_armed = true;
            append("window", "final-before-press-review");
            m_initialLayout = m_lastLayout;
            m_inCallback = false;
        } catch (...) { diagnosticError(); }
    }
    void stop(const char *reason, bool cachedOnly = false) noexcept {
        if (m_stopped) return;
        try {
            m_stopReason = QString::fromLatin1(reason).left(ReasonLimit);
            if (m_armed) {
                m_inCallback = true;
                if (!cachedOnly) {
                    refreshRows();
                    m_terminalRows = upperRows();
                    m_terminalLayout = layout();
                } else {
                    m_terminalRows = cachedUpperRows();
                    m_terminalLayout = m_lastLayout;
                }
                append("window", m_stopReason, {}, cachedOnly);
                m_inCallback = false;
            }
            m_ended = m_clock ? now() : -1;
        } catch (...) { m_observerError = true; }
        m_stopped = true;
        disconnectAll();
    }
    QVariantMap snapshot() const {
        return {{"prepared", m_prepared}, {"armed", m_armed}, {"stopped", m_stopped},
            {"startStepElapsedMs", m_started >= 0 ? QVariant(m_started) : nullValue()},
            {"endStepElapsedMs", m_ended >= 0 ? QVariant(m_ended) : nullValue()},
            {"stopReason", m_stopReason}, {"observerError", m_observerError},
            {"destroyedSource", m_destroyedSource.isEmpty() ? nullValue() : QVariant(m_destroyedSource)},
            {"eventLimit", EventLimit}, {"upperRowLimit", UpperLimit},
            {"childScanLimit", ChildLimit}, {"trackedRowLimit", RowLimit},
            {"connectionLimit", ConnectionLimit}, {"idCharacterLimit", IdLimit},
            {"unavailableNotificationLimit", MissingNotificationLimit}, {"targetAncestorWalkLimit", ParentLimit},
            {"reasonCharacterLimit", ReasonLimit}, {"eventCount", m_events.size()},
            {"observedEventCount", m_sequence}, {"droppedEventCount", m_droppedEvents},
            {"childScanOmissions", m_scanOmissions}, {"rowTrackingOmissions", m_trackingOmissions},
            {"connectionOmissions", m_connectionOmissions},
            {"suppressedReentrantNotifications", m_suppressedNotifications},
            {"unavailableNotificationOmissions", m_missingNotificationOmissions},
            {"truncated", m_droppedEvents > 0 || m_scanTruncated || m_trackingTruncated ||
                          m_stringTruncated || m_connectionOmissions > 0 || m_suppressedNotifications > 0 ||
                          m_missingNotificationOmissions > 0},
            {"stringsTruncated", m_stringTruncated},
            {"unavailableNotifications", m_missingNotifications},
            {"targetIndexAtArm", m_targetIndex >= 0 ? QVariant(m_targetIndex) : nullValue()},
            {"upperIndexFirst", m_targetIndex >= 0 ? QVariant(std::max(0, m_targetIndex - UpperLimit)) : nullValue()},
            {"upperIndexEndExclusive", m_targetIndex >= 0 ? QVariant(m_targetIndex) : nullValue()},
            {"upperIndexReference", "target-index-at-arm"},
            {"initialUpperRows", m_initialRows}, {"terminalUpperRows", m_terminalRows},
            {"initialLayout", m_initialLayout.isEmpty() ? nullValue() : QVariant(m_initialLayout)},
            {"terminalLayout", m_terminalLayout.isEmpty() ? nullValue() : QVariant(m_terminalLayout)},
            {"lifecycleMeaning", "visual-child-added/first-observed and visual-child-removed are observations; only destroyed confirms destruction"},
            {"events", m_events}};
    }

private:
    static constexpr int EventLimit = 128, UpperLimit = 16, ChildLimit = 128;
    static constexpr int RowLimit = 64, ParentLimit = 16, ConnectionLimit = 512;
    static constexpr int IdLimit = 160, ReasonLimit = 96;
    static constexpr int MissingNotificationLimit = 32;
    struct Row {
        int token;
        QPointer<QQuickItem> item;
        QVariantMap last;
        bool inContent = true, relevant = false;
        qint64 firstObservedMs = -1;
        bool observedBeforeArm = true;
    };
    struct Watch {
        QPointer<QObject> object;
        int signal;
        QString source, reason;
        int rowToken;
    };
    QPointer<QQuickItem> m_history, m_chat, m_text, m_targetRow, m_content;
    ReadingSelectionProbe::Clock m_clock;
    QVector<QMetaObject::Connection> m_connections;
    QVector<Watch> m_watches;
    QVector<Row> m_rows;
    QVariantList m_events, m_initialRows, m_terminalRows;
    QVariantMap m_lastLayout, m_initialLayout, m_terminalLayout;
    QStringList m_missingNotifications;
    QString m_stopReason, m_destroyedSource;
    bool m_prepared = false, m_armed = false, m_stopped = false, m_inCallback = false;
    bool m_observerError = false, m_scanTruncated = false, m_trackingTruncated = false, m_stringTruncated = false;
    int m_targetIndex = -1, m_nextRowToken = 0;
    qint64 m_started = -1, m_ended = -1, m_sequence = 0, m_droppedEvents = 0;
    qint64 m_scanOmissions = 0, m_trackingOmissions = 0, m_connectionOmissions = 0;
    qint64 m_suppressedNotifications = 0;
    qint64 m_missingNotificationOmissions = 0;

    static QVariant nullValue() { return QJsonValue(QJsonValue::Null).toVariant(); }
    qint64 now() const { return m_clock ? m_clock() : -1; }
    QString identifier(const QString &value) {
        if (value.size() > IdLimit) m_stringTruncated = true;
        return value.left(IdLimit);
    }
    void disconnectAll() noexcept {
        for (const auto &connection : m_connections) QObject::disconnect(connection);
        m_connections.clear(); m_watches.clear(); m_clock = {};
    }
    void diagnosticError() noexcept {
        m_observerError = true;
        m_inCallback = false;
        m_stopped = true;
        disconnectAll();
    }
    void keep(const QMetaObject::Connection &connection) {
        if (!connection) { ++m_connectionOmissions; return; }
        if (m_connections.size() < ConnectionLimit) m_connections.append(connection);
        else { QObject::disconnect(connection); ++m_connectionOmissions; }
    }
    void missingNotification(const QString &reason) {
        const QString bounded = reason.left(ReasonLimit);
        if (m_missingNotifications.contains(bounded)) return;
        if (m_missingNotifications.size() < MissingNotificationLimit) m_missingNotifications.append(bounded);
        else ++m_missingNotificationOmissions;
    }
    void watch(QObject *object, const char *name, const QString &source, int rowToken = 0) {
        const int index = object->metaObject()->indexOfProperty(name);
        const auto property = index >= 0 ? object->metaObject()->property(index) : QMetaProperty();
        if (!property.isValid() || !property.hasNotifySignal()) {
            missingNotification(source + ":" + QString::fromLatin1(name));
            return;
        }
        const int signal = property.notifySignalIndex();
        for (const auto &entry : m_watches)
            if (entry.object == object && entry.signal == signal) return;
        if (m_connections.size() >= ConnectionLimit) { ++m_connectionOmissions; return; }
        const auto connection = connect(object, property.notifySignal(), this,
            metaObject()->method(metaObject()->indexOfSlot("propertyChanged()")), Qt::DirectConnection);
        if (!connection) {
            missingNotification(source + ":" + QString::fromLatin1(name) + ":connect-failed");
            return;
        }
        m_connections.append(connection);
        m_watches.append({object, signal, source, QString::fromLatin1(name), rowToken});
    }
    QVariantMap geometry(QQuickItem *item) {
        if (!item) return {{"available", false}, {"y", nullValue()}, {"height", nullValue()}, {"sceneRect", nullValue()}};
        return {{"available", true}, {"y", item->y()}, {"height", item->height()},
                {"sceneRect", rectMap(sceneRect(item))}};
    }
    QVariantMap rowState(QQuickItem *item, int token) {
        auto state = geometry(item);
        state["objectToken"] = token;
        const QString name = item ? item->objectName() : QString();
        const QString prefix = "chatMessageRow-";
        bool indexKnown = false;
        int index = -1;
        QString messageId;
        // A child can be attached before its delegate identity is initialized.
        // Do not label a default index=0 as a real row or force its ID binding
        // before objectName has observed a nonempty message identity.
        if (item && name.startsWith(prefix) && name.size() > prefix.size()) {
            index = item->property("index").toInt(&indexKnown);
            messageId = item->property("messageId").toString();
        }
        const bool identityAvailable = indexKnown && index >= 0 && !messageId.isEmpty() && name == prefix + messageId;
        state["identityAvailable"] = identityAvailable;
        state["index"] = identityAvailable ? QVariant(index) : nullValue();
        state["messageId"] = identityAvailable ? QVariant(identifier(messageId)) : nullValue();
        state["objectName"] = item ? QVariant(identifier(name)) : nullValue();
        state["inContent"] = item && item->parentItem() == m_content;
        return state;
    }
    bool relevant(const QVariantMap &state) const {
        bool known = false;
        const int index = state.value("index").toInt(&known);
        return m_targetIndex >= 0 && known && index >= std::max(0, m_targetIndex - UpperLimit) && index < m_targetIndex;
    }
    void updateRow(Row &row) {
        row.last = rowState(row.item, row.token);
        row.last["firstObservedStepElapsedMs"] = row.firstObservedMs;
        row.last["observedBeforeArm"] = row.observedBeforeArm;
        row.relevant = relevant(row.last);
        row.inContent = row.last.value("inContent").toBool();
    }
    QVariantMap layout() {
        QVariantMap list, chat;
        for (const auto *name : {"contentHeight", "originY", "contentY", "count"})
            list[name] = m_history ? m_history->property(name) : nullValue();
        for (const auto *name : {"restoreRequestCount", "restoreExecutionCount", "readingPointerActive"})
            chat[name] = m_chat ? m_chat->property(name) : nullValue();
        auto row = geometry(m_targetRow);
        row["index"] = m_targetRow ? m_targetRow->property("index") : nullValue();
        row["messageId"] = m_targetRow ? QVariant(identifier(m_targetRow->property("messageId").toString())) : nullValue();
        return {{"list", list}, {"chat", chat}, {"targetRow", row}, {"textItem", geometry(m_text)}};
    }
    void append(const QString &source, const QString &reason, const QVariantMap &row = {}, bool cachedOnly = false) {
        if (!m_armed || m_stopped) return;
        ++m_sequence;
        if (m_events.size() >= EventLimit) { ++m_droppedEvents; return; }
        if (!cachedOnly) m_lastLayout = layout();
        QVariantMap event{{"seq", m_sequence}, {"stepElapsedMs", now()},
            {"source", source.left(ReasonLimit)}, {"reason", reason.left(ReasonLimit)},
            {"valuesFromLastObservation", cachedOnly}, {"state", m_lastLayout}};
        if (!row.isEmpty()) event["row"] = row;
        m_events.append(event);
    }
    QVariantList cachedUpperRows() const {
        QVariantList rows;
        if (m_targetIndex < 0) return rows;
        for (int index = std::max(0, m_targetIndex - UpperLimit); index < m_targetIndex; ++index) {
            QVariantMap state{{"index", index}, {"available", false}, {"unavailableReason", "not-observed-instantiated"}};
            for (const auto &row : m_rows) {
                bool known = false;
                const int observedIndex = row.last.value("index").toInt(&known);
                if (row.inContent && row.item && known && observedIndex == index) { state = row.last; break; }
            }
            rows.append(state);
        }
        return rows;
    }
    QVariantList upperRows() {
        for (auto &row : m_rows)
            if (row.item) updateRow(row);
        return cachedUpperRows();
    }
    void refreshRows() {
        if (!m_content) return;
        const auto children = m_content->childItems();
        if (children.size() > ChildLimit) {
            m_scanTruncated = true; m_scanOmissions += children.size() - ChildLimit;
        }
        for (auto &row : m_rows) {
            if (!row.item) continue;
            const bool attached = row.item->parentItem() == m_content;
            row.last["inContent"] = attached;
            if (row.inContent && !attached && row.relevant)
                append("row", "visual-child-removed", row.last);
            if (!attached) row.inContent = false;
        }
        const int limit = std::min<int>(children.size(), ChildLimit);
        for (int i = 0; i < limit; ++i) {
            auto *item = children[i];
            if (!item || item == m_targetRow) continue;
            const QString name = item->objectName();
            if (!name.isEmpty() && !name.startsWith("chatMessageRow-")) continue;
            auto found = std::find_if(m_rows.begin(), m_rows.end(), [item](const Row &row) { return row.item == item; });
            if (found != m_rows.end()) {
                const bool wasAttached = found->inContent;
                updateRow(*found);
                for (const auto *property : {"index", "messageId", "objectName", "y", "height", "parent"})
                    watch(item, property, "row", found->token);
                if (!wasAttached && found->relevant)
                    append("row", "visual-child-reentered", found->last);
                continue;
            }
            if (m_rows.size() >= RowLimit) { m_trackingTruncated = true; ++m_trackingOmissions; continue; }
            const int token = ++m_nextRowToken;
            Row row{token, item, {}};
            row.firstObservedMs = now();
            row.observedBeforeArm = !m_armed;
            updateRow(row);
            m_rows.append(row);
            for (const auto *property : {"index", "messageId", "objectName", "y", "height", "parent"})
                watch(item, property, "row", token);
            keep(connect(item, &QObject::destroyed, this,
                         [this, token] { rowDestroyed(token); }, Qt::DirectConnection));
            if (row.relevant) append("row", "visual-child-added-or-first-observed", row.last);
        }
    }
    void rowDestroyed(int token) noexcept {
        if (m_stopped || QThread::currentThread() != thread()) return;
        if (m_inCallback) {
            ++m_suppressedNotifications;
            for (auto &row : m_rows) if (row.token == token) row.inContent = false;
            return;
        }
        m_inCallback = true;
        try {
            for (auto &row : m_rows) if (row.token == token) {
                row.inContent = false;
                row.last["inContent"] = false;
                row.last["lastKnownBeforeDestruction"] = true;
                if (row.relevant) append("row", "destroyed", row.last, true);
                break; // Never query the destructing QQuickItem.
            }
        } catch (...) { diagnosticError(); }
        m_inCallback = false;
    }

private slots:
    void propertyChanged() noexcept {
        if (m_stopped || QThread::currentThread() != thread()) return;
        if (m_inCallback) { ++m_suppressedNotifications; return; }
        m_inCallback = true;
        try {
            Watch trigger;
            bool found = false;
            for (const auto &watch : m_watches)
                if (watch.object == sender() && watch.signal == senderSignalIndex()) { trigger = watch; found = true; break; }
            if (found && trigger.rowToken) {
                for (auto &row : m_rows) if (row.token == trigger.rowToken && row.item) {
                    const bool wasRelevant = row.relevant;
                    const bool wasAttached = row.inContent;
                    updateRow(row);
                    row.inContent = row.item->parentItem() == m_content;
                    for (const auto *name : {"index", "messageId"}) watch(row.item, name, "row", row.token);
                    if (wasRelevant || row.relevant) {
                        const QString reason = wasAttached != row.inContent
                            ? row.inContent ? "visual-child-reentered" : "visual-child-removed"
                            : trigger.reason;
                        append("row", reason, row.last);
                    }
                    break;
                }
            } else if (found) {
                append(trigger.source, trigger.reason);
            }
        } catch (...) { diagnosticError(); }
        m_inCallback = false;
    }
    void childrenChanged() noexcept {
        if (m_stopped || QThread::currentThread() != thread()) return;
        if (m_inCallback) { ++m_suppressedNotifications; return; }
        m_inCallback = true;
        try { refreshRows(); append("list", "content-children-changed"); }
        catch (...) { diagnosticError(); }
        m_inCallback = false;
    }
};

class Runner final : public QObject {
  public:
    Runner(QQuickWindow *window, RuntimeBridge *session, ArchiveEditor *archiveEditor,
           QString capturePrefix, MoonroomInteractionCheck::Completion completion)
        : QObject(window), m_window(window), m_session(session), m_editor(archiveEditor),
          m_prefix(std::move(capturePrefix)), m_completion(std::move(completion)) {
        m_timer.setInterval(24);
        connect(&m_timer, &QTimer::timeout, this, [this] { tick(); });
        connect(window, &QQuickWindow::afterAnimating, this, [this] {
            if (m_director) m_occlusion.sample(m_window);
            sampleCombinedReplyTiming();
        });
        connect(window, &QQuickWindow::frameSwapped, this,
                [this] { ++m_archivePresentedFrame; }, Qt::QueuedConnection);
        m_cadence.start(window, this, !window->property("reverieRecording").toBool());
        buildSteps();
        QTimer::singleShot(0, this, [this] {
            m_total.start();
            m_timer.start();
            tick();
        });
    }

    ~Runner() override { m_readingLayoutTimeline.stop("runner-destroyed", true); }

  private:
    QPointer<QQuickWindow> m_window;
    QPointer<RuntimeBridge> m_session;
    QPointer<ArchiveEditor> m_editor;
    QPointer<NativeAvatar> m_avatar;
    QPointer<QQuickItem> m_director, m_chat, m_selectedText, m_editFocus;
    MoonroomInteractionCheck::Completion m_completion;
    QString m_prefix, m_originalDraft, m_selectedTextName;
    QSize m_originalSize;
    QTimer m_timer;
    QElapsedTimer m_total, m_stepClock, m_wheelClock;
    QVector<Step> m_steps;
    QVariantList m_checks, m_captures, m_focusTrail;
    QVariantMap m_stepTimeoutDiagnostic, m_archiveFocusTraversal;
    NativeCheck::LegacyClickLog m_clickLog;
    QVariantMap m_previewTabObservation;
    QVariantMap m_archiveBefore, m_anchorBefore, m_selectionsBefore;
    QVariantMap m_hiddenReturnBefore, m_hiddenAvatarBefore;
    int m_step = 0, m_baselineUserCount = 0, m_baselineAssistantCount = 0, m_loads = 0;
    int m_readingSendClicks = 0, m_stopSendClicks = 0, m_stopClicks = 0, m_wheelEvents = 0;
    int m_readingHistoryGateHeldTicks = 0;
    bool m_entered = false, m_inTick = false, m_finished = false, m_mousePressed = false;
    bool m_watchTaskBlend = false, m_preeditSent = false;
    double m_minTaskBlend = 1, m_scrollBefore = 0, m_scrollAfter = 0;
    qint64 m_captureTimeMs = 0;
    QPointF m_selectionEnd;
    SceneOcclusionProbe m_occlusion;
    FrameCadenceProbe m_cadence;
    qint64 m_demoHoldUntil = 0;
    QVariantMap m_combinedComposer;
    int m_combinedAssistantCount = 0;
    QVariant m_combinedSendEpochMs, m_combinedCheck38StartedEpochMs, m_combinedReplyObservedEpochMs;
    QVariantList m_combinedReplyStateChanges;
    QVariantMap m_combinedReplyLastState;
    bool m_combinedReplyTimingArmed = false, m_combinedReplyTimingActive = false;
    QString m_fullMessageId;
    QVariantList m_readingSelectionAcquisitions, m_readingSelectionSnapshots;
    QVariantMap m_readingSelectionLastDiagnostic;
    QVariantMap m_readingSelectionLastRowAdjacency;
    qint64 m_readingSelectionLastRowAdjacencyMs = -1, m_readingSelectionFirstRowPositionConsistentMs = -1;
    int m_readingSelectionRowPositionRetryCount = 0;
    ReadingLayoutTimeline m_readingLayoutTimeline;
    ReadingSelectionProbe::Candidate m_readingSelectionCandidate;
    ReadingSelectionProbe::OnceGesture m_readingSelectionGesture;
    QString m_readingSelectionStep;
    qint64 m_readingSelectionWindowStartMs = -1, m_readingSelectionDeadlineMs = -1;
    qint64 m_readingSelectionLastProbeMs = -1;
    qint64 m_readingSelectionGestureCompletedMs = -1;
    int m_readingSelectionStepTimeoutMs = 0, m_readingSelectionAttempts = 0;
    int m_readingSelectionPressCount = 0, m_readingSelectionMoveCount = 0;
    int m_readingSelectionReleaseCount = 0, m_readingSelectionCleanupReleaseCount = 0;
    bool m_readingSelectionAcquiring = false, m_readingSelectionDragStarted = false;
    bool m_readingSelectionDragCompleted = false;
    NativeArchiveControlReadiness::Gate m_archiveGate;
    QVariantList m_archiveControlReadiness;
    QString m_archiveActionId, m_archiveControl;
    int m_archiveActionStep = -1;
    quint64 m_archivePresentedFrame = 0;
    bool m_archiveActionRecorded = false;

    void archiveActionRecord() {
        if (m_archiveActionStep < 0 || m_archiveActionRecorded) return;
        m_archiveControlReadiness.append(QVariantMap{{"id", m_archiveActionId},
            {"step", m_archiveActionStep}, {"control", m_archiveControl}, {"gate", m_archiveGate.metadata()}});
        m_archiveActionRecorded = true;
    }
    bool archiveAction(const QString &id, const QString &control,
                       NativeArchiveControlReadiness::Region region,
                       const std::function<void(const NativeArchiveControlReadiness::Prepared &)> &perform) {
        if (m_archiveActionStep != m_step) {
            archiveActionRecord();
            m_archiveGate.resetForNextStep();
            m_archiveActionStep = m_step; m_archiveActionId = id; m_archiveControl = control;
            m_archiveActionRecorded = false;
        }
        require(m_archiveActionId == id && m_archiveControl == control, "MOONROOM_ARCHIVE_ACTION_CHANGED");
        NativeArchiveControlReadiness::Request request;
        request.region = region; request.control = control;
        request.target = [this, control] { return visualFind(m_window->contentItem(), control, false); };
        request.context = [this] { return QVariantMap{{"scope", m_session->scopeKey()},
            {"generation", m_session->generation()}, {"revision", m_editor->revision()},
            {"bookId", m_editor->selectedBookKey()}, {"entryId", m_editor->selectedEntryKey()}}; };
        request.currentFrame = [this] { return qint64(m_archivePresentedFrame); };
        const auto result = m_archiveGate.poll(m_window, request, [this] { return m_stepClock.elapsed(); },
            m_steps[m_step].timeoutMs, m_archivePresentedFrame, perform);
        require(result != NativeArchiveControlReadiness::Gate::Expired, "MOONROOM_ARCHIVE_INPUT_DEADLINE:" + id);
        require(result != NativeArchiveControlReadiness::Gate::Failed, "MOONROOM_ARCHIVE_INPUT_FAILED:" + id);
        if (result != NativeArchiveControlReadiness::Gate::Performed) return false;
        archiveActionRecord();
        return true;
    }
    void archiveClick(const NativeArchiveControlReadiness::Prepared &prepared) {
        require(prepared.target, "MOONROOM_ARCHIVE_TARGET_DESTROYED");
        m_clickLog.record(prepared.target->objectName(), prepared.target, m_window, prepared.start);
        NativeArchiveControlReadiness::mouseClick(m_window, prepared,
            [this] { return m_stepClock.elapsed(); }, m_steps[m_step].timeoutMs);
    }

    QQuickItem *find(const QString &name, bool usable = true) const {
        auto *item = visualFind(m_window ? m_window->contentItem() : nullptr, name, usable);
        require(item, "MOONROOM_CONTROL_UNAVAILABLE:" + name);
        return item;
    }
    QRectF visibleRect(QQuickItem *item) const {
        QRectF rect =
            sceneRect(item).intersected(QRectF(0, 0, m_window->width(), m_window->height()));
        for (auto *ancestor = item->parentItem(); ancestor; ancestor = ancestor->parentItem())
            if (ancestor->clip())
                rect = rect.intersected(sceneRect(ancestor));
        return rect;
    }
    QPointF inputPoint(QQuickItem *item) const {
        const auto rect = visibleRect(item);
        require(item->isVisible() && item->isEnabled() && !rect.isEmpty() &&
                    effectiveOpacity(item) > .05,
                "MOONROOM_CONTROL_CLIPPED_OR_DISABLED:" + item->objectName());
        return rect.center();
    }
    void click(const QString &name) {
        auto *item = find(name);
        const auto point = inputPoint(item);
        // Evidence only: find() and inputPoint() keep their pass conditions.
        m_clickLog.record(name, item, m_window, point);
        const bool startsCombinedReplyTiming = m_combinedReplyTimingArmed && name == "sendChat";
        if (startsCombinedReplyTiming) {
            m_combinedReplyTimingArmed = false;
            m_combinedReplyTimingActive = true;
            m_combinedReplyStateChanges.clear();
            m_combinedReplyLastState.clear();
            m_combinedCheck38StartedEpochMs.clear();
            m_combinedReplyObservedEpochMs.clear();
            m_combinedSendEpochMs = QDateTime::currentMSecsSinceEpoch();
        }
        QTest::mouseClick(m_window, Qt::LeftButton, Qt::NoModifier, point.toPoint());
        if (startsCombinedReplyTiming)
            sampleCombinedReplyTiming();
    }
    void type(const QString &name, const QString &text) {
        auto *item = find(name);
        click(name);
        require(within(m_window->activeFocusItem(), item), "MOONROOM_CLICK_DID_NOT_FOCUS:" + name + ":" +
                    (m_window->activeFocusItem() ? m_window->activeFocusItem()->objectName() : "none"));
        // Qt maps ControlModifier to Command on macOS (Meta means physical Control).
        QTest::keyClick(m_window, Qt::Key_A, Qt::ControlModifier);
        require(item->property("selectionEnd").toInt() - item->property("selectionStart").toInt() == item->property("text").toString().size(),
                "MOONROOM_SELECT_ALL_NOT_APPLIED:" + name);
        if (text.isEmpty()) {
            QTest::keyClick(m_window, Qt::Key_Backspace);
        } else {
            QInputMethodEvent commit;
            commit.setCommitString(text);
            QCoreApplication::sendEvent(m_window, &commit);
        }
        require(item->property("text").toString() == text, "MOONROOM_INPUT_NOT_COMMITTED:" + name + ":actual=" + item->property("text").toString() + ":expected=" + text + ":focus=" +
                    (m_window->activeFocusItem() ? m_window->activeFocusItem()->objectName() : "none"));
    }
    double blend(const char *name) const { return m_director->property(name).toDouble(); }
    QString mode() const { return m_director->property("mode").toString(); }
    bool chatReady(const QString &state) const {
        return mode() == state && blend("taskBlend") < .001 &&
               std::abs(blend("readBlend") - (state == "reading" ? 1 : 0)) < .001 &&
               m_chat->property("inputReady").toBool();
    }
    bool taskReady(const QString &feature) const {
        auto *portal = find(feature == "character" ? "taskSurface" : "drawer-" + feature, false);
        return mode() == "task" && blend("taskBlend") > .999 &&
               portal->property("inputReady").toBool() &&
               portal->property("transitionState").toString() == "open";
    }
    int messageCount(const QString &role, const QString &exactText = {}) const {
        int count = 0;
        for (const auto &value : m_session->messages()) {
            const auto message = value.toMap();
            if (message.value("role").toString() == role &&
                (exactText.isEmpty() || message.value("content").toString() == exactText))
                ++count;
        }
        return count;
    }
    void sampleCombinedReplyTiming() {
        if (m_finished || !m_combinedReplyTimingActive || !m_session)
            return;
        const auto session = m_session->diagnostics();
        const QVariantMap state{
            {"chatState", session.value("chatState").toString().left(32)},
            {"busy", m_session->busy()},
            {"pendingCommandCount", session.value("pendingCommands").toList().size()},
            {"assistantMessages", messageCount("assistant")}};
        const qint64 now = QDateTime::currentMSecsSinceEpoch();
        // Diagnostic completion is independent of the task surface's readiness.
        if (!m_combinedReplyObservedEpochMs.isValid() && !state.value("busy").toBool() &&
            state.value("assistantMessages").toInt() == m_combinedAssistantCount + 1)
            m_combinedReplyObservedEpochMs = now;
        if (state != m_combinedReplyLastState) {
            m_combinedReplyLastState = state;
            if (m_combinedReplyStateChanges.size() < 64) {
                auto snapshot = state;
                snapshot.insert("epochMs", now);
                m_combinedReplyStateChanges.append(snapshot);
            }
        }
    }
    int assistantCharactersAfter(const QString &userText) const {
        bool inTurn = false;
        int characters = 0;
        for (const auto &value : m_session->messages()) {
            const auto message = value.toMap();
            if (message.value("role").toString() == "user") {
                if (inTurn)
                    break;
                inTurn = message.value("content").toString() == userText;
            } else if (inTurn && message.value("role").toString() == "assistant") {
                characters += message.value("content").toString().size();
            }
        }
        return characters;
    }
    QVariantMap archiveFields() const {
        return {{"title", m_editor->title()},     {"keywords", m_editor->keywords()},
                {"content", m_editor->content()}, {"entryEnabled", m_editor->entryEnabled()},
                {"dirty", m_editor->dirty()},     {"revision", m_editor->revision()}};
    }
    QVariantMap readingState() const {
        auto *history = find("chatHistory", false);
        return {{"anchor", mapValue(m_chat->property("readingAnchor"))},
                {"followLatest", m_chat->property("followLatest")},
                {"unreadReplyCount", m_chat->property("unreadReplyCount")},
                {"contentY", history->property("contentY")},
                {"originY", history->property("originY")},
                {"contentHeight", history->property("contentHeight")},
                {"viewportHeight", history->height()},
                {"messageSelections", mapValue(m_chat->property("messageSelections"))}};
    }
    void record(const QString &name, QVariantMap evidence = {}) {
        evidence["name"] = name;
        evidence["passed"] = true;
        evidence["mode"] = mode();
        evidence["taskBlend"] = blend("taskBlend");
        evidence["readBlend"] = blend("readBlend");
        evidence["avatarVisibility"] = blend("avatarVisibility");
        evidence["avatarLoads"] = m_avatar->loads();
        evidence["viewport"] =
            QVariantMap{{"width", m_window->width()}, {"height", m_window->height()}};
        evidence["activeFocusItem"] =
            m_window->activeFocusItem() ? m_window->activeFocusItem()->objectName() : QString();
        m_checks.append(evidence);
    }
    void capture(const QString &name) {
        m_cadence.phase({});
        // No frame-cadence/performance samples are collected by this runner.
        // Even the interaction wall-clock result subtracts synchronous grabs.
        QElapsedTimer captureClock;
        captureClock.start();
        const QString path = m_prefix + ".moonroom-" + name + ".png";
        const auto snapshot = m_window->grabWindow();
        require(!snapshot.isNull() && snapshot.save(path), "MOONROOM_CAPTURE_FAILED:" + name);
        const auto elapsed = captureClock.elapsed();
        m_captureTimeMs += elapsed;
        m_captures.append(QVariantMap{
            {"name", name}, {"path", path}, {"captureMsExcludedFromInteractionTime", elapsed}});
        if (m_window->property("reverieDemoRecording").toBool()) m_demoHoldUntil = m_total.elapsed() + 1400;
    }
    void add(QString name, Action enter, Predicate ready = {}, Action validate = {},
             int minimumMs = 0, int timeoutMs = 4000) {
        m_steps.append({std::move(name), std::move(enter), std::move(ready), std::move(validate),
                        minimumMs, timeoutMs});
    }
    void checkAvatarIdentity() const {
        require(m_avatar && m_avatar == find("nativeAvatar", false), "MOONROOM_AVATAR_REPLACED");
        require(m_avatar->loads() == m_loads, "MOONROOM_RESIZE_OR_TASK_RELOADED_AVATAR");
    }
    void checkGeometry(const QString &feature) {
        checkAvatarIdentity();
        const bool compact = m_window->width() < 1180;
        const auto task = m_director->property("taskRect").toRectF();
        const auto avatar = m_director->property("avatarRect").toRectF();
        const auto protectedRect = m_director->property("avatarProtectedRect").toRectF();
        const auto windowRect = QRectF(0, 0, m_window->width(), m_window->height());
        require(task.width() > 0 && task.height() > 0 && windowRect.contains(task),
                "MOONROOM_TASK_GEOMETRY_OUTSIDE_WINDOW");
        require(avatar.width() > 0 && avatar.height() > 0 && avatar.contains(protectedRect),
                "MOONROOM_AVATAR_PROTECTED_RECT_INVALID");
        if (compact && (feature == "memory" || feature == "settings"))
            require(blend("avatarVisibility") < .001 && !m_avatar->isEnabled(),
                    "MOONROOM_COMPACT_TASK_AVATAR_STILL_INTERACTIVE");
        else
            require(blend("avatarVisibility") > .999 && m_avatar->isEnabled() &&
                        !task.intersects(protectedRect),
                    "MOONROOM_TASK_COVERS_AVATAR_PROTECTED_RECT");
        auto *portal = find(feature == "character" ? "taskSurface" : "drawer-" + feature, false);
        const auto physical = sceneRect(portal);
        require(std::abs(physical.x() - task.x()) < 1 && std::abs(physical.y() - task.y()) < 1 &&
                    std::abs(physical.width() - task.width()) < 1 &&
                    std::abs(physical.height() - task.height()) < 1,
                "MOONROOM_PORTAL_DID_NOT_REACH_DIRECTOR_TASK_RECT");
        if (feature == "memory") {
            for (const auto &name : {"worldbookName", "worldbookKeys", "worldbookEnabled",
                                     "archive-status", "reloadWorldbook", "saveWorldbook"}) {
                auto *control = find(name, false);
                const auto whole = sceneRect(control);
                const auto exposed = visibleRect(control);
                require(control->isVisible() && whole.width() > 0 && whole.height() > 0 &&
                            exposed.width() >= whole.width() - 1 &&
                            exposed.height() >= whole.height() - 1,
                        "MOONROOM_ARCHIVE_FIXED_CONTROL_CLIPPED:" + QString(name));
            }
            require(find("worldbook-content-scroll")->height() >= 71,
                    "MOONROOM_ARCHIVE_BODY_VIEWPORT_TOO_SMALL");
        }
        QVariantMap evidence{{"taskRect", rectMap(task)},
                             {"avatarRect", rectMap(avatar)},
                             {"avatarProtectedRect", rectMap(protectedRect)},
                             {"compact", compact},
                             {"avatarEnabled", m_avatar->isEnabled()}};
        // Evidence only: where the world book form stood when the drawer was entered.
        if (feature == "memory")
            if (auto *form = find("worldbook-form-scroll", false)->property("contentItem").value<QQuickItem *>())
                evidence["worldbookFormContentY"] = form->property("contentY");
        record(feature + "-geometry", evidence);
    }
    void checkAnchor(bool restored) {
        const auto state = readingState();
        const auto anchor = state.value("anchor").toMap();
        require(anchor.value("messageId") == m_anchorBefore.value("messageId") &&
                    anchor.value("index") == m_anchorBefore.value("index") &&
                    std::abs(anchor.value("offset").toDouble() -
                             m_anchorBefore.value("offset").toDouble()) < 2 &&
                    !state.value("followLatest").toBool(),
                "MOONROOM_TASK_LOST_READING_ANCHOR");
        const auto selections = state.value("messageSelections").toMap();
        require(selections == m_selectionsBefore, "MOONROOM_TASK_LOST_MESSAGE_SELECTION");
        if (restored) {
            require(std::abs(state.value("contentY").toDouble() - m_scrollAfter) < 2,
                    "MOONROOM_READING_SCROLL_POSITION_NOT_RESTORED");
            auto *selection = find(m_selectedTextName, false);
            require(selection->property("selectionEnd").toInt() >
                            selection->property("selectionStart").toInt() &&
                        selection->property("selectedText").toString().trimmed().size() >= 4,
                    "MOONROOM_MESSAGE_SELECTION_NOT_RESTORED");
        }
    }
    double scrollFraction() const {
        auto *history = find("chatHistory");
        const double range = history->property("contentHeight").toDouble() - history->height();
        require(range > history->height(), "MOONROOM_READING_FIXTURE_TOO_SHORT");
        return (history->property("contentY").toDouble() -
                history->property("originY").toDouble()) /
               range;
    }
    bool wheelToMiddle() {
        const double fraction = scrollFraction();
        if (fraction >= .36 && fraction <= .64)
            return !find("chatHistory")->property("moving").toBool();
        if (!m_wheelClock.isValid() || m_wheelClock.elapsed() >= 90) {
            auto *history = find("chatHistory");
            const auto point = inputPoint(history);
            QTest::mouseMove(m_window, point.toPoint());
            QTest::wheelEvent(m_window, point, QPoint(0, fraction > .64 ? 1440 : -1440));
            ++m_wheelEvents;
            m_wheelClock.restart();
        }
        return false;
    }
    QQuickItem *readingSelectionHistory() const {
        return visualFind(m_window ? m_window->contentItem() : nullptr, "chatHistory", false);
    }
    bool readingSelectionReady(QQuickItem *history) const {
        return m_window && m_director && m_chat && history && chatReady("reading") &&
               !m_chat->property("restoringReading").toBool() &&
               !m_chat->property("layoutRestorePending").toBool() &&
               !history->property("moving").toBool() &&
               !history->property("dragging").toBool() &&
               !history->property("flicking").toBool();
    }
    ReadingSelectionProbe::Clock readingSelectionClock() const {
        return [this] { return m_stepClock.elapsed(); };
    }
    bool readingSelectionBeforeDeadline() const {
        return m_readingSelectionDeadlineMs >= 0 &&
               m_stepClock.elapsed() < m_readingSelectionDeadlineMs;
    }
    QString readingSelectionTimeoutCode(const QString &fallback) const {
        if (!m_readingSelectionAcquiring || m_readingSelectionGesture.attempted())
            return fallback;
        return ReadingSelectionProbe::acquisitionTimeoutCode(m_readingSelectionLastDiagnostic, fallback);
    }
    void recordReadingSelectionRowSample(QVariantMap &snapshot, bool reused) const {
        const bool available = !m_readingSelectionLastRowAdjacency.isEmpty();
        snapshot["rowAdjacency"] = available ? m_readingSelectionLastRowAdjacency : QVariantMap{{"status", "unavailable"}};
        snapshot["rowAdjacencyElapsedMs"] = m_readingSelectionLastRowAdjacencyMs;
        snapshot["rowAdjacencyReused"] = available && reused;
    }
    QVariantMap readingSelectionSnapshot(const QString &stage, const QVariantMap &diagnostic,
                                        qint64 probeElapsedMs, bool reusedProbe = false) const {
        auto *history = readingSelectionHistory();
        auto *actual = m_readingSelectionCandidate.name.isEmpty()
                           ? nullptr
                           : visualFind(m_window ? m_window->contentItem() : nullptr,
                                        m_readingSelectionCandidate.name, false);
        const QString selected = actual ? actual->property("selectedText").toString() : QString();
        QVariantMap snapshot{
            {"stage", stage},
            {"elapsedMs", m_stepClock.elapsed()},
            {"windowElapsedMs", m_readingSelectionWindowStartMs >= 0
                                    ? m_stepClock.elapsed() - m_readingSelectionWindowStartMs : -1},
            {"attemptCount", m_readingSelectionAttempts},
            {"selectedId", m_readingSelectionCandidate.messageId},
            {"deadlineReached", !readingSelectionBeforeDeadline()},
            {"readingReady", readingSelectionReady(history)},
            {"inputReady", m_chat && m_chat->property("inputReady").toBool()},
            {"geometryReady", m_chat && m_chat->property("geometryReady").toBool()},
            {"layoutRestorePending", m_chat && m_chat->property("layoutRestorePending").toBool()},
            {"restoringReading", m_chat && m_chat->property("restoringReading").toBool()},
            {"readingPointerActive", m_chat && m_chat->property("readingPointerActive").toBool()},
            {"restoreRequestCount", m_chat ? m_chat->property("restoreRequestCount").toInt() : -1},
            {"restoreExecutionCount", m_chat ? m_chat->property("restoreExecutionCount").toInt() : -1},
            {"forceLayoutCount", m_chat ? m_chat->property("forceLayoutCount").toInt() : -1},
            {"historyMoving", history && history->property("moving").toBool()},
            {"historyDragging", history && history->property("dragging").toBool()},
            {"historyFlicking", history && history->property("flicking").toBool()},
            {"mousePressed", m_mousePressed},
            {"dragStarted", m_readingSelectionDragStarted},
            {"dragCompleted", m_readingSelectionDragCompleted},
            {"pressCount", m_readingSelectionPressCount},
            {"moveCount", m_readingSelectionMoveCount},
            {"releaseCount", m_readingSelectionReleaseCount},
            {"windowRect", m_window ? rectMap(QRectF(0, 0, m_window->width(), m_window->height())) : QVariantMap()},
            {"historyRect", history ? rectMap(sceneRect(history)) : QVariantMap()},
            {"historyVisibleRect", history && m_window ? rectMap(visibleRect(history)) : QVariantMap()},
            {"contentY", history ? history->property("contentY").toDouble() : 0.},
            {"originY", history ? history->property("originY").toDouble() : 0.},
            {"contentHeight", history ? history->property("contentHeight").toDouble() : 0.},
            {"candidateCap", 64},
            {"lineCapPerCandidate", 32},
            {"candidateSnapshotAvailable", !diagnostic.isEmpty()},
            {"candidateSnapshotElapsedMs", probeElapsedMs},
            {"candidateSnapshotReused", reusedProbe},
            {"candidateSnapshotStale", reusedProbe},
            {"candidateProbe", diagnostic},
            {"roundedStart", QVariantMap{{"x", m_readingSelectionCandidate.start.x()}, {"y", m_readingSelectionCandidate.start.y()}}},
            {"roundedEnd", QVariantMap{{"x", m_readingSelectionCandidate.end.x()}, {"y", m_readingSelectionCandidate.end.y()}}},
            {"predictedUtf16Start", m_readingSelectionCandidate.firstPosition},
            {"predictedUtf16End", m_readingSelectionCandidate.lastPosition},
            {"predictedUtf16Length", m_readingSelectionCandidate.lastPosition - m_readingSelectionCandidate.firstPosition},
            {"predictedTrimmedUtf16Length", m_readingSelectionCandidate.trimmedLength},
            {"selectionItemLive", actual != nullptr},
            {"selectionDelegateMatches", actual && actual == m_readingSelectionCandidate.item.data()},
            {"actualUtf16Start", actual ? actual->property("selectionStart").toInt() : -1},
            {"actualUtf16End", actual ? actual->property("selectionEnd").toInt() : -1},
            {"actualUtf16Length", selected.size()},
            {"actualTrimmedUtf16Length", selected.trimmed().size()}};
        recordReadingSelectionRowSample(snapshot, reusedProbe || !diagnostic.contains("rowAdjacency"));
        return snapshot;
    }
    void beginReadingSelectionAcquisition(const QString &step, int stepTimeoutMs,
                                         bool startAtEntry) {
        m_readingLayoutTimeline.reset();
        m_readingSelectionStep = step;
        m_readingSelectionStepTimeoutMs = stepTimeoutMs;
        m_readingSelectionWindowStartMs = startAtEntry ? 0 : -1;
        m_readingSelectionDeadlineMs = startAtEntry ? stepTimeoutMs : -1;
        m_readingSelectionLastProbeMs = -1;
        m_readingSelectionGestureCompletedMs = -1;
        m_readingSelectionAttempts = 0;
        m_readingSelectionPressCount = 0;
        m_readingSelectionMoveCount = 0;
        m_readingSelectionReleaseCount = 0;
        m_readingSelectionCleanupReleaseCount = 0;
        m_readingSelectionAcquiring = true;
        m_readingSelectionDragStarted = false;
        m_readingSelectionDragCompleted = false;
        m_readingSelectionGesture = {};
        m_readingSelectionCandidate = {};
        m_readingSelectionLastDiagnostic.clear();
        m_readingSelectionLastRowAdjacency.clear();
        m_readingSelectionLastRowAdjacencyMs = -1;
        m_readingSelectionFirstRowPositionConsistentMs = -1;
        m_readingSelectionRowPositionRetryCount = 0;
        m_readingSelectionSnapshots.clear();
        m_selectedText = nullptr;
        m_selectedTextName.clear();
        m_selectionEnd = {};
    }
    void startReadingSelectionWindow() {
        const qint64 now = m_stepClock.elapsed();
        require(now < m_readingSelectionStepTimeoutMs,
                "MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT");
        m_readingSelectionWindowStartMs = now;
        m_readingSelectionDeadlineMs =
            std::min<qint64>(m_readingSelectionStepTimeoutMs, now + 4000);
    }
    void rememberReadingSelectionObservation(const QVariantMap &diagnostic, bool beforePress = false) {
        // Keep the last bounded observation. A completed row comparison can
        // still be the newest observation when the final clock check expires.
        const bool rowInconsistent = beforePress && diagnostic.value("reason").toString() == "row-position-inconsistent";
        if (diagnostic.value("deadlineReached").toBool() &&
            !rowInconsistent && !m_readingSelectionLastDiagnostic.isEmpty())
            return;
        m_readingSelectionLastDiagnostic = diagnostic;
        m_readingSelectionLastProbeMs = m_stepClock.elapsed();
        if (!beforePress) return;
        m_readingSelectionLastRowAdjacency = diagnostic.value("rowAdjacency").toMap();
        m_readingSelectionLastRowAdjacencyMs = m_readingSelectionLastRowAdjacency.value("observedAtMs", -1).toLongLong();
        if (m_readingSelectionFirstRowPositionConsistentMs < 0 &&
                m_readingSelectionLastRowAdjacency.value("status").toString() == "consistent")
            m_readingSelectionFirstRowPositionConsistentMs = m_readingSelectionLastRowAdjacencyMs;
    }
    void finishReadingSelectionAcquisition(bool passed) {
        m_readingLayoutTimeline.stop("acquisition-finished");
        if (!m_readingSelectionAcquiring)
            return;
        // The bounded candidate observation keeps its own timestamp. Terminal
        // properties below are live; they do not turn old geometry into a new
        // post-deadline candidate decision or select another item after press.
        m_readingSelectionSnapshots.append(
            readingSelectionSnapshot("terminal", m_readingSelectionLastDiagnostic,
                                     m_readingSelectionLastProbeMs,
                                     !m_readingSelectionLastDiagnostic.isEmpty()));
        const qint64 elapsed = m_stepClock.elapsed();
        m_readingSelectionAcquisitions.append(QVariantMap{
            {"step", m_readingSelectionStep},
            {"status", passed ? "selected" : "failed"},
            {"stepTimeoutMs", m_readingSelectionStepTimeoutMs},
            {"windowStartMs", m_readingSelectionWindowStartMs},
            {"windowMs", m_readingSelectionWindowStartMs >= 0
                             ? m_readingSelectionDeadlineMs - m_readingSelectionWindowStartMs : 0},
            {"deadlineMs", m_readingSelectionDeadlineMs},
            {"elapsedMs", elapsed},
            {"windowElapsedMs", m_readingSelectionWindowStartMs >= 0
                                    ? elapsed - m_readingSelectionWindowStartMs : -1},
            {"attemptCount", m_readingSelectionAttempts},
            {"rowPositionRetryCount", m_readingSelectionRowPositionRetryCount},
            {"firstRowPositionConsistentMs", m_readingSelectionFirstRowPositionConsistentMs},
            {"selectedId", m_readingSelectionCandidate.messageId},
            {"dragAttemptCount", m_readingSelectionGesture.attempted() ? 1 : 0},
            {"gestureCompleted", m_readingSelectionGesture.completed()},
            {"gestureFailed", m_readingSelectionGesture.failed()},
            {"gestureCompletedElapsedMs", m_readingSelectionGestureCompletedMs},
            {"pressCount", m_readingSelectionPressCount},
            {"moveCount", m_readingSelectionMoveCount},
            {"releaseCount", m_readingSelectionReleaseCount},
            {"cleanupReleaseCount", m_readingSelectionCleanupReleaseCount},
            {"snapshotCap", 3},
            {"candidateCap", 64},
            {"lineCapPerCandidate", 32},
            {"layoutTimeline", m_readingLayoutTimeline.snapshot()},
            {"snapshots", m_readingSelectionSnapshots}});
        m_readingSelectionAcquiring = false;
    }
    void requireLiveReadingSelection(const QString &operation) {
        require(readingSelectionBeforeDeadline(),
                "MOONROOM_READING_SELECTION_DEADLINE:" + operation);
        auto *history = readingSelectionHistory();
        ReadingSelectionProbe::Candidate live;
        QVariantMap diagnostic;
        const bool valid = ReadingSelectionProbe::revalidate(
            m_readingSelectionCandidate, history, m_window, readingSelectionReady(history),
            readingSelectionClock(), m_readingSelectionDeadlineMs, &live, &diagnostic);
        rememberReadingSelectionObservation(diagnostic);
        require(valid && readingSelectionBeforeDeadline(),
                "MOONROOM_READING_SELECTION_CHANGED_OR_EXPIRED:" + operation);
        m_readingSelectionCandidate = live;
        m_selectedText = live.item;
    }
    bool acquireReadingSelection() {
        if (m_readingSelectionGesture.completed())
            return true;
        require(!m_readingSelectionGesture.attempted(), "MOONROOM_READING_SELECTION_RETRY_AFTER_PRESS");
        require(readingSelectionBeforeDeadline(), readingSelectionTimeoutCode("MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT"));
        auto *history = readingSelectionHistory();
        if (m_readingSelectionLastDiagnostic.value("reason").toString() == "row-position-inconsistent")
            ++m_readingSelectionRowPositionRetryCount;
        ++m_readingSelectionAttempts;
        const auto probe = ReadingSelectionProbe::probeBeforePress(
            history, m_window, readingSelectionReady(history), readingSelectionClock(),
            m_readingSelectionDeadlineMs);
        rememberReadingSelectionObservation(probe.diagnostic, true);
        if (probe.hasCandidate())
            m_readingSelectionCandidate = probe.candidate;
        if (m_readingSelectionSnapshots.isEmpty())
            m_readingSelectionSnapshots.append(
                readingSelectionSnapshot("first", probe.diagnostic, m_readingSelectionLastProbeMs));
        require(readingSelectionBeforeDeadline(), readingSelectionTimeoutCode("MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT"));
        if (!probe.hasCandidate())
            return false;
        ReadingSelectionProbe::Candidate live;
        QVariantMap diagnostic;
        if (!ReadingSelectionProbe::revalidateBeforePress(
                probe.candidate, history, m_window, readingSelectionReady(history),
                readingSelectionClock(), m_readingSelectionDeadlineMs, &live, &diagnostic)) {
            rememberReadingSelectionObservation(diagnostic, true);
            require(readingSelectionBeforeDeadline(), readingSelectionTimeoutCode("MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT"));
            return false;
        }
        m_readingSelectionCandidate = live;
        rememberReadingSelectionObservation(diagnostic, true);
        auto beforePress = readingSelectionSnapshot(
            "beforePress", diagnostic, m_readingSelectionLastProbeMs);
        // Diagnostics do not pump events. Reacquire once more after their public
        // Qt queries so a replaced delegate remains a candidate-only retry.
        ReadingSelectionProbe::Candidate finalLive;
        history = readingSelectionHistory();
        m_readingLayoutTimeline.prepare(history, m_chat, live.item, readingSelectionClock());
        ReadingLayoutTimeline::WindowGuard layoutWindow(m_readingLayoutTimeline);
        if (!ReadingSelectionProbe::revalidateBeforePress(
                live, history, m_window, readingSelectionReady(history), readingSelectionClock(),
                m_readingSelectionDeadlineMs, &finalLive, &diagnostic)) {
            rememberReadingSelectionObservation(diagnostic, true);
            require(readingSelectionBeforeDeadline(), readingSelectionTimeoutCode("MOONROOM_READING_SELECTION_ACQUISITION_TIMEOUT"));
            return false;
        }
        m_readingSelectionCandidate = finalLive;
        rememberReadingSelectionObservation(diagnostic, true);
        recordReadingSelectionRowSample(beforePress, false);
        m_selectedText = finalLive.item;
        m_selectedTextName = finalLive.name;
        const QPointF start = finalLive.start;
        m_selectionEnd = finalLive.end;
        m_readingSelectionSnapshots.append(beforePress);
        m_readingLayoutTimeline.arm();
        const bool dragged = m_readingSelectionGesture.run(
            readingSelectionClock(), m_readingSelectionDeadlineMs, [this, start] {
                require(readingSelectionBeforeDeadline(), "MOONROOM_READING_SELECTION_DEADLINE:press");
                m_readingSelectionDragStarted = true;
                m_mousePressed = true;
                QTest::mousePress(m_window, Qt::LeftButton, Qt::NoModifier, start.toPoint(), 0);
                ++m_readingSelectionPressCount;
                requireLiveReadingSelection("after-press");
                auto *handler = m_window->findChild<QObject *>("chatReadingPointer-" + m_selectedTextName.mid(QString("chatMessage-").size()));
                auto *handlerParent = handler ? handler->property("parent").value<QQuickItem *>() : nullptr;
                require(m_chat->property("readingPointerActive").toBool(),
                        "READING_SELECTION_POINTER_NOT_OBSERVED:focus=" +
                        (m_window->activeFocusItem() ? m_window->activeFocusItem()->objectName() : "none") +
                        ":grab=" + (m_window->mouseGrabberItem() ? m_window->mouseGrabberItem()->objectName() : "none") +
                        ":ready=" + m_chat->property("inputReady").toString() +
                        ":handlerParent=" + (handlerParent ? handlerParent->objectName() : "none") +
                        ":point=" + QString::number(start.x()) + "," + QString::number(start.y()));
                // Reproduce a pending passive layout refinement while the real text
                // drag owns the pointer. It must not replay an older cursor/selection.
                require(readingSelectionBeforeDeadline(), "MOONROOM_READING_SELECTION_DEADLINE:passive-restore");
                require(QMetaObject::invokeMethod(m_chat, "scheduleReadingRestore", Q_ARG(QVariant, false)),
                        "READING_PASSIVE_RESTORE_INTERFACE_MISSING");
                QTest::qWait(40);
                require(m_chat->property("inputReady").toBool(), "PASSIVE_RESTORE_DISABLED_HELD_SELECTION");
                for (int move = 1; move <= 5; ++move) {
                    requireLiveReadingSelection("move-" + QString::number(move));
                    if (move == 1) m_readingLayoutTimeline.stop("first-move-review-complete");
                    require(readingSelectionBeforeDeadline(), "MOONROOM_READING_SELECTION_DEADLINE:move");
                    QTest::mouseMove(m_window, (start + (m_selectionEnd - start) * (move / 5.)).toPoint());
                    ++m_readingSelectionMoveCount;
                }
                requireLiveReadingSelection("release");
                require(readingSelectionBeforeDeadline(), "MOONROOM_READING_SELECTION_DEADLINE:release");
                QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_selectionEnd.toPoint());
                ++m_readingSelectionReleaseCount;
                m_mousePressed = false;
                const qint64 releasedAt = m_stepClock.elapsed();
                require(releasedAt < m_readingSelectionDeadlineMs,
                        "MOONROOM_READING_SELECTION_DEADLINE:after-release");
                m_readingSelectionGestureCompletedMs = releasedAt;
                m_readingSelectionDragCompleted = true;
            });
        require(dragged, "MOONROOM_READING_SELECTION_GESTURE_NOT_DISPATCHED");
        return true;
    }
    void watchTaskSwitch() {
        m_minTaskBlend = blend("taskBlend");
        m_watchTaskBlend = true;
        click("nav-settings");
    }
    void finishTaskSwitch() {
        m_watchTaskBlend = false;
        require(m_minTaskBlend > .995, "MOONROOM_TASK_SWITCH_RETURNED_TO_COMPANION");
        record("memory-to-settings-keeps-task-mode", {{"minimumTaskBlend", m_minTaskBlend}});
    }
    void checkTabFocus(const NativeArchiveControlReadiness::Prepared &prepared) {
        archiveClick(prepared);
        QSet<QQuickItem *> visited;
        ArchiveFocusProbe probe;
        QVariantList records;
        m_archiveFocusTraversal = {{"schema", "reverie.qt.archive-focus-traversal.v2"}, {"windowToken", "window-1"},
            {"scope", m_session->scopeKey()}, {"generation", m_session->generation()},
            {"deadlineMs", 4000}, {"startElapsedMs", m_stepClock.elapsed()},
            {"phase", "tab-visible-controls"}, {"step", 28},
            {"initialPositioningCount", qint64(NativeControlReadiness::testRevealCallCount)}};
        for (int index = 0; index < 24; ++index) {
            // Identity checks observe only. Product behavior owns all Tab scroll.
            prepared.verifyIdentity();
            const bool bodyFocused = within(m_window->activeFocusItem(), find("worldbookContent", false));
            const auto key = bodyFocused || index >= 12 ? Qt::Key_Backtab : Qt::Key_Tab;
            QVariantMap row{{"index", index}, {"step", 28}, {"direction", key == Qt::Key_Tab ? "Tab" : "Backtab"},
                {"scope", m_session->scopeKey()}, {"generation", m_session->generation()},
                {"bodyFocused", bodyFocused}, {"inputCount", 0}, {"immediate", true},
                {"before", probe.snapshot(m_window, find("archiveDrawer", false))},
                {"positioningBefore", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameBefore", m_archivePresentedFrame}, {"elapsedBeforeMs", m_stepClock.elapsed()}};
            ArchiveFocusProbe::beginObservation(find("archiveDrawer", false));
            int dispatchCount = 0;
            ++dispatchCount;
            QTest::keyClick(m_window, key);
            row["inputCount"] = dispatchCount;
            row["causal"] = ArchiveFocusProbe::causalSnapshot(find("archiveDrawer", false));
            auto *focused = m_window->activeFocusItem();
            row.insert({{"after", probe.snapshot(m_window, find("archiveDrawer", false))},
                {"positioningAfter", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameAfter", m_archivePresentedFrame}, {"elapsedAfterMs", m_stepClock.elapsed()}});
            records.append(row); m_archiveFocusTraversal["records"] = records;
            m_archiveFocusTraversal["endElapsedMs"] = row["elapsedAfterMs"];
            // Preserve the sample before any possible assertion or late identity
            // rejection, including the first invisible leaf.
            prepared.verifyIdentity();
            require(focused && focused->isVisible() && focused->isEnabled() &&
                        effectiveOpacity(focused) > .01 && !visibleRect(focused).isEmpty(),
                    ArchiveFocusProbe::context(row));
            require(row["positioningBefore"] == row["positioningAfter"],
                    "[ARCHIVE_FOCUS_TEST_POSITIONING] index=" + QString::number(index));
            require(!row["causal"].toMap()["overflow"].toBool(), "[ARCHIVE_FOCUS_CAUSAL] bounded observation overflow");
            require(m_stepClock.elapsed() < 4000, "[ARCHIVE_FOCUS_TIME] index=" + QString::number(index));
            for (const auto &hidden :
                 {"chatReadingSurface", "chatComposerSurface", "terminalTasks", "characterTasks"})
                require(!within(focused, find(hidden, false)),
                        "MOONROOM_TAB_ENTERED_INACTIVE_BODY:" + QString(hidden));
            visited.insert(focused);
            m_focusTrail.append(focused->objectName());
        }
        require(visited.size() >= 3, "MOONROOM_TAB_DID_NOT_TRAVERSE_CONTROLS");
        record("tab-skips-hidden-chat-and-inactive-task-bodies",
               {{"uniqueFocusItems", visited.size()}});
    }
    void buildSteps() {
        add(
            "initialize-existing-window",
            [this] {
                require(m_session->connected() && m_editor->initialized(),
                        "MOONROOM_SESSION_OR_ARCHIVE_NOT_READY");
                m_originalSize = m_window->size();
                m_originalDraft = m_session->draft();
                m_director = find("sceneDirector", false);
                m_chat = find("persistentChat", false);
                m_avatar = qobject_cast<NativeAvatar *>(find("nativeAvatar", false));
                require(m_avatar, "MOONROOM_NATIVE_AVATAR_REQUIRED");
                m_loads = m_avatar->loads();
                m_archiveBefore = archiveFields();
                m_baselineUserCount = messageCount("user");
                m_baselineAssistantCount = messageCount("assistant");
                require(messageCount("user", "阅读记录 1") == 0 &&
                            messageCount("user", "阅读记录 2") == 0 &&
                            messageCount("user", "停止记录") == 0,
                        "MOONROOM_FIXTURE_TEXT_ALREADY_PRESENT");
                m_window->resize(QSize(1380, 900));
                click("nav-chat");
            },
            [this] { return m_window->size() == QSize(1380, 900) && chatReady("companion"); },
            [this] {
                checkAvatarIdentity();
                capture("companion");
                record("companion-mode-ready");
            },
            80);
        add("command-two-opens-archive", [this] { QTest::keyClick(m_window, Qt::Key_2, Qt::ControlModifier); },
            [this] { return taskReady("memory"); }, [this] { record("command-two-real-key-opens-archive"); });
        add("command-one-returns-companion", [this] { QTest::keyClick(m_window, Qt::Key_1, Qt::ControlModifier); },
            [this] { return chatReady("companion"); }, [this] { record("command-one-real-key-returns-companion"); });
        for (int turn = 1; turn <= 2; ++turn) {
            const QString text =
                "阅读记录 " + QString::number(turn) + "：请认真给我一份完整的项目说明";
            add(
                "reading-fixture-send-" + QString::number(turn),
                [this, text] {
                    m_readingHistoryGateHeldTicks = 0;
                    type("chatComposer", text);
                    click("sendChat");
                    ++m_readingSendClicks;
                },
                [this, text, turn] {
                    const bool ready = !m_session->busy() && chatReady("companion") && messageCount("user", text) == 1 &&
                                       messageCount("assistant") >= m_baselineAssistantCount + turn &&
                                       assistantCharactersAfter(text) >= 600;
                    if (!ready)
                        return false;
                    bool historyPending = false;
                    for (const auto &value : m_session->diagnostics().value("pendingCommands").toList())
                        historyPending = historyPending || value.toMap().value("command").toString() == "chat:history";
                    if (historyPending)
                        ++m_readingHistoryGateHeldTicks;
                    return !historyPending;
                },
                [this, text, turn] {
                    require(messageCount("user") == m_baselineUserCount + turn,
                            "MOONROOM_READING_FIXTURE_REDISPATCHED");
                    record("reading-fixture-ui-send",
                           {{"turn", turn},
                            {"text", text},
                            {"matchingUserRows", messageCount("user", text)},
                            {"assistantCharacters", assistantCharactersAfter(text)},
                            {"historyGateHeldTicks", m_readingHistoryGateHeldTicks},
                            {"purpose", "long-history reading fixture"}});
                },
                120, 30000);
        }
        add("preview-open-full-message", [this] {
            for (const auto &value : m_session->messages()) {
                const auto message = value.toMap();
                if (message.value("role").toString() == "assistant") m_fullMessageId = message.value("id").toString();
            }
            auto *row = find("chatMessageRow-" + m_fullMessageId);
            require(row->property("previewLineCount").toInt() <= 4, "PREVIEW_EXCEEDS_FOUR_LINES");
            auto unbox = [](QVariant value) {
                return value.metaType() == QMetaType::fromType<QJSValue>()
                    ? value.value<QJSValue>().toVariant() : value;
            };
            auto *button = find("openFullMessage-" + m_fullMessageId);
            auto *background = unbox(button->property("background")).value<QObject *>();
            require(background, "PREVIEW_BUTTON_BACKGROUND_MISSING");
            const bool hasSource = unbox(background->property("sceneSource")).value<QObject *>() != nullptr;
            const bool hasRoot = unbox(background->property("sceneRoot")).value<QObject *>() != nullptr;
            QObject *observers = nullptr;
            for (auto *candidate : background->findChildren<QObject *>()) {
                const auto *meta = candidate->metaObject();
                if (meta->indexOfProperty("count") >= 0 && meta->indexOfProperty("model") >= 0
                    && meta->indexOfMethod("objectAt(int)") >= 0) { observers = candidate; break; }
            }
            require(observers && !hasSource && !hasRoot && observers->property("count").toInt() == 0,
                    "PREVIEW_BUTTON_RETAINS_UNSOURCED_OBSERVERS");
            record("real-preview-button-no-source-observers", {{"hasSource", hasSource},
                {"hasRoot", hasRoot}, {"observerCount", observers->property("count")}});
            click("openFullMessage-" + m_fullMessageId);
        }, [this] { return chatReady("reading"); }, [this] {
            const auto anchor = mapValue(m_chat->property("readingAnchor"));
            require(anchor.value("messageId").toString() == m_fullMessageId && anchor.value("textPosition").toInt() == 0,
                    "READ_FULL_MESSAGE_DID_NOT_TARGET_REPLY");
            record("preview-opens-complete-message-by-id", {{"messageId", m_fullMessageId}});
        });
        add("preview-return-companion", [this] { click("closeHistory"); }, [this] { return chatReady("companion"); });
        add("preview-keyboard-focus-origin", [this] { click("nav-chat"); },
            [this] { return chatReady("companion"); });
        add("preview-keyboard-open-full-message", [this] {
            auto *button = find("openFullMessage-" + m_fullMessageId);
            require(button->isEnabled(), "PREVIEW_KEYBOARD_BUTTON_NOT_READY");
            bool reached = false;
            QStringList trail;
            const auto tabPolicy = QGuiApplication::styleHints()->tabFocusBehavior();
            for (int index = 0; tabPolicy == Qt::TabFocusAllControls && index < 40; ++index) {
                QTest::keyClick(m_window, Qt::Key_Tab, Qt::ShiftModifier);
                auto *focused = m_window->activeFocusItem();
                require(focused && focused->isVisible() && focused->isEnabled() && effectiveOpacity(focused) > .01,
                        "PREVIEW_KEYBOARD_ENTERED_INACTIVE_CONTROL");
                trail.append(focused->objectName());
                if (within(focused, button)) { reached = true; break; }
            }
            m_previewTabObservation = {{"tabFocusBehavior", int(tabPolicy)},
                {"attempted", tabPolicy == Qt::TabFocusAllControls},
                {"buttonReachedByTab", tabPolicy == Qt::TabFocusAllControls ? QVariant(reached) : QVariant()},
                {"focusTrail", trail},
                {"scope", "Observed system Qt tab policy, never modified; full-button Tab remains unverified under text/list-only policy and is not included in passed checks"}};
            if (!reached) {
                require(tabPolicy != Qt::TabFocusAllControls,
                        "PREVIEW_BUTTON_NOT_KEYBOARD_REACHABLE:" + trail.join(","));
                // Respect the user's macOS text-only Tab policy. Establish
                // focus through a real cancelled press, then test Space;
                // do not call forceActiveFocus or invoke the action directly.
                QTest::mousePress(m_window, Qt::LeftButton, Qt::NoModifier, inputPoint(button).toPoint());
                QTest::mouseMove(m_window, QPoint(4, 4));
                QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, QPoint(4, 4));
                require(chatReady("companion") && within(m_window->activeFocusItem(), button),
                        "PREVIEW_CANCELLED_PRESS_DID_NOT_PRESERVE_FOCUS");
            }
            // The loaded button may be destroyed by the resulting navigation;
            // use the window as event target and retain only the message ID.
            QTest::keyClick(m_window, Qt::Key_Space);
        }, [this] { return chatReady("reading"); }, [this] {
            const auto anchor = mapValue(m_chat->property("readingAnchor"));
            require(anchor.value("messageId").toString() == m_fullMessageId && anchor.value("textPosition").toInt() == 0,
                    "PREVIEW_KEYBOARD_TARGET_CHANGED");
            record("preview-button-space-activation", {{"messageId", m_fullMessageId},
                {"scope", "Actual focused control Space activation; Tab eligibility recorded separately"}});
        });
        add("preview-keyboard-return-companion", [this] { click("closeHistory"); }, [this] { return chatReady("companion"); });
        add(
            "independent-stop-fixture-send",
            [this] {
                type("chatComposer", "停止记录");
                click("sendChat");
                ++m_stopSendClicks;
                click("nav-memory");
            },
            // Stop only after the backend reports generation, so this case
            // always cancels an in-flight provider call; cancelling a request
            // that has not been dispatched yet is a different path. The
            // deadline covers the reply-start planner's online deferral
            // (8-35 s x complexity, src/chat/scheduler.py).
            [this] {
                return taskReady("memory") && m_session->busy() &&
                       m_session->chatFeedback().value("status").toString() == "generating";
            },
            [this] {
                record("stop-fixture-reaches-task-companion-bar",
                       {{"purpose", "separate cancellation fixture"},
                        {"chatStateBeforeStop", m_session->chatFeedback().value("status")}});
            },
            0, 45000);
        add(
            "stop-through-visible-companion-control",
            [this] {
                click("compactStop");
                ++m_stopClicks;
            },
            [this] { return !m_session->busy() && messageCount("user", "停止记录") == 1; },
            [this] {
                require(!find("compactStop", false)->isVisible(),
                        "MOONROOM_IDLE_STOP_CONTROL_VISIBLE");
                record("task-companion-bar-stops-separate-request",
                       {{"stopUiClicks", m_stopClicks}});
            },
            180, 8000);
        add(
            "continue-after-stop", [this] { click("continueChat"); },
            [this] { return chatReady("companion"); }, [this] { checkAvatarIdentity(); }, 100);
        add("reading-reverse-start", [this] { click("nav-reading"); },
            [this] { return blend("readBlend") > .08 && blend("readBlend") < .9; },
            [this] { record("reading-interrupted-before-body-ready"); });
        add("reading-resize-across-breakpoint", [this] {
            const double progress = blend("readBlend");
            const double velocity = blend("readVelocity");
            m_window->resize(1179, 760);
            require(std::abs(blend("readBlend") - progress) < .0001 && std::abs(blend("readVelocity") - velocity) < .0001,
                    "READING_RESIZE_RESET_CONTINUOUS_MOTION");
        }, [this] { return m_window->size() == QSize(1179, 760); },
            [this] { record("reading-resize-across-1180-keeps-motion"); });
        add("reading-reverse-return", [this] { click("nav-chat"); },
            [this] { return chatReady("companion"); },
            [this] { record("reading-reverse-keeps-avatar-reserve"); });
        add("reading-resize-back-wide", [this] { m_window->resize(1380, 900); },
            [this] { return chatReady("companion"); }, {}, 120);
        for (int toggle = 0; toggle < 4; ++toggle)
            add("reading-rapid-" + QString::number(toggle),
                [this, toggle] { click(toggle % 2 == 0 ? "nav-reading" : "nav-chat"); }, {}, {}, 55);
        add("reading-rapid-settle", {}, [this] { return chatReady("companion"); },
            [this] { record("reading-rapid-toggle-settles-current-target"); });
        add(
            "companion-to-reading", [this] { click("nav-reading"); },
            [this] { return chatReady("reading"); },
            [this] { record("companion-to-reading-through-navigation"); }, 100);
        add(
            "reading-wheel-middle",
            [this] { m_scrollBefore = find("chatHistory", false)->property("contentY").toDouble(); },
            [this] { return chatReady("reading") && wheelToMiddle(); },
            [this] {
                m_scrollAfter = find("chatHistory")->property("contentY").toDouble();
                require(std::abs(m_scrollAfter - m_scrollBefore) > 20 &&
                            !m_chat->property("followLatest").toBool(),
                        "MOONROOM_WHEEL_DID_NOT_ESTABLISH_READING_ANCHOR");
                record("wheel-establishes-middle-reading-position",
                       {{"contentYBefore", m_scrollBefore},
                        {"contentYAfter", m_scrollAfter},
                        {"fraction", scrollFraction()},
                        {"wheelEvents", m_wheelEvents}});
            },
            0, 14000);
        add(
            "reading-mouse-selection",
            [this] { beginReadingSelectionAcquisition("reading-mouse-selection", 4000, true); },
            [this] { return acquireReadingSelection(); },
            [this] {
                // QVariantList refreshes can replace a delegate between timer
                // steps. Reacquire its stable message identity, not a stale item.
                m_selectedText = find(m_selectedTextName, false);
                require(m_selectedText->property("selectionEnd").toInt() >
                                m_selectedText->property("selectionStart").toInt() &&
                            m_selectedText->property("selectedText").toString().trimmed().size() >= 4,
                        "MOONROOM_MOUSE_DID_NOT_SELECT_READING_TEXT");
                require(QMetaObject::invokeMethod(m_chat, "captureReadingAnchor"),
                        "MOONROOM_ANCHOR_CAPTURE_INTERFACE_MISSING");
                m_anchorBefore = mapValue(m_chat->property("readingAnchor"));
                m_selectedTextName = m_selectedText->objectName();
                m_selectionsBefore = mapValue(m_chat->property("messageSelections"));
                m_scrollAfter = find("chatHistory")->property("contentY").toDouble();
                require(!m_anchorBefore.value("messageId").toString().isEmpty() &&
                            !m_selectionsBefore.isEmpty(),
                        "MOONROOM_READING_STATE_NOT_OBSERVABLE");
                require(!find("drawer-memory", false)->isVisible() &&
                            !find("drawer-settings", false)->isVisible(),
                        "MOONROOM_CLOSED_SCENE_LABEL_OVER_READING_CONTENT");
                finishReadingSelectionAcquisition(true);
                capture("reading");
                record("mouse-selects-readable-message-text",
                       {{"readingState", readingState()},
                        {"selectionItem", m_selectedText->objectName()}});
            },
            100);
        add(
            "reading-to-memory", [this] { click("nav-memory"); },
            [this] { return taskReady("memory"); },
            [this] {
                checkAnchor(false);
                checkGeometry("memory");
                require(find("drawer-memory", false)->property("decorationsSettling").toBool(),
                        "MOONROOM_BODY_INPUT_WAITS_FOR_DECORATIVE_SETTLE");
                capture("memory");
                record("task-preserves-reading-anchor-while-body-is-ready");
            });
        add(
            "search-from-editor",
            {},
            [this] {
                if (!archiveAction("search-from-editor", "worldbookContent",
                    NativeArchiveControlReadiness::Region::BodyPoint, [this](const auto &prepared) {
                        archiveClick(prepared);
                        m_editFocus = prepared.target;
                        require(within(m_window->activeFocusItem(), m_editFocus), "MOONROOM_EDITOR_FOCUS_MISSING");
                        prepared.verifyIdentity();
                        click("scene-navigation-search");
                    })) return false;
                return find("sceneCommandPalette", false)->isVisible();
            });
        add(
            "search-cancel-restores-editor",
            [this] {
                type("scene-search", "资料");
                QTest::keyClick(m_window, Qt::Key_Escape);
            },
            [this] { return !find("sceneCommandPalette", false)->isVisible(); },
            [this] {
                require(within(m_window->activeFocusItem(), m_editFocus),
                        "MOONROOM_SEARCH_CANCEL_LOST_EDITOR_FOCUS");
                checkAnchor(false);
                record("search-cancel-restores-exact-editor-focus");
            },
            100);
        add("tab-visible-controls", {}, [this] {
            return archiveAction("tab-visible-controls", "worldbookName",
                NativeArchiveControlReadiness::Region::WholeItem,
                [this](const auto &prepared) { checkTabFocus(prepared); });
        });
        add(
            "synthetic-preedit-begins",
            {},
            [this] {
                if (!archiveAction("synthetic-preedit-begins", "worldbookContent",
                    NativeArchiveControlReadiness::Region::BodyPoint, [this](const auto &prepared) {
                        archiveClick(prepared);
                        const QList<QInputMethodEvent::Attribute> attributes{
                            {QInputMethodEvent::Cursor, 3, 1, QVariant()}};
                        QInputMethodEvent preedit("测试预编辑", attributes);
                        prepared.verifyIdentity();
                        require(within(m_window->activeFocusItem(), prepared.target), "MOONROOM_EDITOR_FOCUS_MISSING");
                        QCoreApplication::sendEvent(m_window, &preedit);
                        m_preeditSent = true;
                    })) return false;
                return find("worldbookContent")->property("inputMethodComposing").toBool();
            });
        add(
            "escape-during-preedit-keeps-task",
            [this] { QTest::keyClick(m_window, Qt::Key_Escape); }, {},
            [this] {
                require(taskReady("memory"), "MOONROOM_PREEDIT_ESCAPE_CLOSED_TASK");
                QInputMethodEvent clear;
                QCoreApplication::sendEvent(m_window, &clear);
                m_preeditSent = false;
                require(archiveFields() == m_archiveBefore,
                        "MOONROOM_PREEDIT_OR_NAVIGATION_CHANGED_ARCHIVE_DRAFT");
                record("synthetic-preedit-escape-does-not-close-task",
                       {{"scope", "synthetic QInputMethodEvent; not physical OS IME acceptance"}});
            },
            80);
        add(
            "memory-to-settings-continuity", [this] { watchTaskSwitch(); },
            [this] { return taskReady("settings"); },
            [this] {
                finishTaskSwitch();
                checkAnchor(false);
                checkGeometry("settings");
                capture("settings");
            });
        add(
            "task-to-preserved-reading", [this] { click("continueChat"); },
            [this] {
                return chatReady("reading") && !m_chat->property("restoringReading").toBool();
            },
            [this] {
                checkAnchor(true);
                record("continue-restores-reading-scroll-and-selection",
                       {{"readingState", readingState()}});
            },
            180);
        add(
            "close-history-returns-companion", [this] { click("closeHistory"); },
            [this] { return chatReady("companion"); },
            [this] { record("close-history-returns-companion"); }, 100);

        add("combined-delayed-send", [this] {
            m_combinedAssistantCount = messageCount("assistant");
            type("chatComposer", "组合记录：请认真给我一份完整的后续安排");
            m_combinedReplyTimingArmed = true;
            click("sendChat");
        }, [this] { return m_session->busy(); });
        add("combined-open-reading", [this] { click("nav-reading"); },
            [this] { return chatReady("reading"); });
        add("combined-old-text", [this] {
                m_wheelClock.invalidate();
                beginReadingSelectionAcquisition("combined-old-text", 14000, false);
            },
            [this] {
                if (m_readingSelectionWindowStartMs < 0) {
                    if (!chatReady("reading") || !wheelToMiddle())
                        return false;
                    startReadingSelectionWindow();
                }
                return acquireReadingSelection();
            }, [this] {
                m_selectedText = find(m_selectedTextName, false);
                require(m_selectedText->property("selectionEnd").toInt() > m_selectedText->property("selectionStart").toInt() &&
                            m_selectedText->property("selectedText").toString().trimmed().size() >= 4,
                        "COMBINED_READING_SELECTION_MISSING");
                m_selectedTextName = m_selectedText->objectName();
                finishReadingSelectionAcquisition(true);
                type("chatComposer", "下一条草稿 🌙\n暂时留在这里，不要发送。\n窗口换行后仍保留光标与选区。");
                for (int i = 0; i < 6; ++i) QTest::keyClick(m_window, Qt::Key_Left, Qt::ShiftModifier);
                auto *composer = find("chatComposer");
                m_combinedComposer = {{"text", composer->property("text")}, {"cursor", composer->property("cursorPosition")},
                    {"start", composer->property("selectionStart")}, {"end", composer->property("selectionEnd")}};
            }, 0, 14000);
        add("composer-growth-capture-settled-anchor", {}, [this] { return chatReady("reading") && !m_chat->property("restoringReading").toBool(); },
            [this] {
                require(m_session->busy(), "COMBINED_REPLY_ARRIVED_BEFORE_TASK");
                QMetaObject::invokeMethod(m_chat, "captureReadingAnchor");
                m_anchorBefore = mapValue(m_chat->property("readingAnchor"));
                m_selectionsBefore = mapValue(m_chat->property("messageSelections"));
                require(m_anchorBefore.value("textPosition").toInt() >= 0 && !m_chat->property("followLatest").toBool(),
                        "COMBINED_TEXT_ANCHOR_MISSING");
                click("nav-memory");
            }, 160);
        add("combined-reply-arrives-behind-task", {},
            [this] { return taskReady("memory") && !m_session->busy() && messageCount("assistant") == m_combinedAssistantCount + 1; },
            [this] {
                require(m_session->draft() == m_combinedComposer.value("text").toString(), "COMBINED_REPLY_CHANGED_DRAFT");
                record("reply-arrives-behind-task-with-unread-marker", {{"readingState", readingState()}, {"draftPreserved", true}});
                capture("combined-reply-in-task");
            }, 0, 30000);
        add("combined-resize-task", [this] { m_window->resize(950, 760); },
            [this] { return m_window->size() == QSize(950, 760) && taskReady("memory"); }, {}, 180);
        add("combined-second-task", [this] { watchTaskSwitch(); },
            [this] { return taskReady("settings"); }, [this] { finishTaskSwitch(); });
        add("combined-return-to-text", [this] { click("continueChat"); },
            [this] { return chatReady("reading") && !m_chat->property("restoringReading").toBool(); },
            [this] {
                const auto restored = mapValue(m_chat->property("readingAnchor"));
                require(restored.value("messageId") == m_anchorBefore.value("messageId") &&
                            restored.value("textPosition") == m_anchorBefore.value("textPosition") &&
                            !m_chat->property("followLatest").toBool(), "COMBINED_REFLOW_LOST_TEXT_ANCHOR");
                require(mapValue(m_chat->property("messageSelections")) == m_selectionsBefore, "COMBINED_REFLOW_LOST_SELECTION");
                auto *composer = find("chatComposer");
                require(composer->property("text") == m_combinedComposer.value("text") &&
                            composer->property("cursorPosition") == m_combinedComposer.value("cursor") &&
                            composer->property("selectionStart") == m_combinedComposer.value("start") &&
                            composer->property("selectionEnd") == m_combinedComposer.value("end"), "COMBINED_REFLOW_LOST_DRAFT_CURSOR");
                auto *anchorText = find("chatMessage-" + restored.value("messageId").toString(), false);
                QRectF character;
                require(QMetaObject::invokeMethod(anchorText, "positionToRectangle", Q_RETURN_ARG(QRectF, character),
                            Q_ARG(int, restored.value("textPosition").toInt())), "COMBINED_TEXT_RECT_INTERFACE_MISSING");
                const double offset = anchorText->mapToScene(character.topLeft()).y() - sceneRect(find("chatHistory")).top();
                require(std::abs(offset - m_anchorBefore.value("viewportOffset").toDouble()) < 3,
                        "COMBINED_TEXT_POSITION_NOT_RESTORED:" + QString::number(offset));
                require(m_chat->property("unreadReplyCount").toInt() == 1, "COMBINED_NEW_REPLY_NOT_MARKED:" + m_chat->property("unreadReplyCount").toString());
                require(blend("avatarVisibility") > .999 && m_avatar->isEnabled(), "COMBINED_COMPACT_READING_HID_AVATAR");
                checkAvatarIdentity();
                capture("combined-reading-restored");
                record("combined-reply-resize-restores-text-selection-draft", {{"anchor", restored}, {"restoredTextViewportOffset", offset},
                    {"draftCursor", m_combinedComposer.value("cursor")}, {"draftSelectionStart", m_combinedComposer.value("start")},
                    {"draftSelectionEnd", m_combinedComposer.value("end")}, {"onlyOneNewAssistant", true}});
            }, 220);
        add("combined-explicit-latest", [this] { click("chatLatest"); },
            [this] { return m_chat->property("followLatest").toBool() && chatReady("reading"); },
            [this] { record("only-explicit-latest-leaves-old-reading-position"); });
        add("combined-return-companion", [this] { click("closeHistory"); },
            [this] { return chatReady("companion"); });

        for (const auto size : {QSize(1380, 900), QSize(950, 760), QSize(760, 650)}) {
            const QString label =
                QString::number(size.width()) + "x" + QString::number(size.height());
            add(
                label + "-resize", [this, size] { m_window->resize(size); },
                [this, size] { return m_window->size() == size && chatReady("companion"); },
                [this] {
                    checkAvatarIdentity();
                    require(blend("avatarVisibility") > .999 && m_avatar->isVisible() &&
                                m_avatar->isEnabled(),
                            "MOONROOM_COMPANION_AVATAR_NOT_RESTORED");
                },
                160);
            add(label + "-reading-visible-actor", [this] { click("nav-reading"); },
                [this] { return chatReady("reading"); }, [this, label] {
                    checkAvatarIdentity();
                    require(blend("avatarVisibility") > .999 && m_avatar->isEnabled(), "READING_LAYOUT_USED_TASK_HIDE_POLICY");
                    capture("reading-" + label);
                    record("reading-keeps-independent-visible-actor-lane");
                }, 100);
            add(label + "-reading-return", [this] { click("closeHistory"); },
                [this] { return chatReady("companion"); });
            if (size.width() < 1180) {
                add(
                    label + "-avatar-return-before-hidden-task",
                    [this] {
                        m_hiddenReturnBefore = m_avatar->diagnostics();
                        m_avatar->forceActiveFocus(Qt::OtherFocusReason);
                        QTest::keyClick(m_window, Qt::Key_Return);
                    },
                    [this] {
                        return m_avatar->successfulInteractions() >
                               m_hiddenReturnBefore.value("successfulInteractions").toInt();
                    },
                    [this] {
                        require(m_avatar->diagnostics()
                                    .value("lastInteraction")
                                    .toMap()
                                    .value("ok")
                                    .toBool(),
                                "MOONROOM_VISIBLE_AVATAR_RETURN_ACTION_FAILED");
                        record("visible-avatar-return-starts-user-action",
                               {{"input",
                                 "real QTest Return event on the existing focused NativeAvatar"},
                                {"lastInteraction",
                                 m_avatar->diagnostics().value("lastInteraction")}});
                    },
                    80);
            }
            add(
                label + "-memory", [this] { click("nav-memory"); },
                [this] { return taskReady("memory"); },
                [this, label] {
                    checkGeometry("memory");
                    if (m_window->width() < 1180)
                        capture("compact-memory-" + label);
                },
                80);
            if (size.width() < 1180) {
                add(
                    label + "-hidden-avatar-keeps-running",
                    [this] {
                        require(blend("avatarVisibility") < .001 && !m_avatar->isEnabled() &&
                                    m_avatar->running(),
                                "MOONROOM_HIDDEN_AVATAR_NOT_RUNNING_AT_START");
                        m_hiddenAvatarBefore = m_avatar->diagnostics();
                    },
                    {},
                    [this] {
                        checkAvatarIdentity();
                        const auto after = m_avatar->diagnostics();
                        const int frameAdvance = after.value("frames").toInt() -
                                                 m_hiddenAvatarBefore.value("frames").toInt();
                        const double idleAdvance =
                            after.value("idleSeconds").toDouble() -
                            m_hiddenAvatarBefore.value("idleSeconds").toDouble();
                        const double userAdvance =
                            after.value("userAnimationSeconds").toDouble() -
                            m_hiddenAvatarBefore.value("userAnimationSeconds").toDouble();
                        require(taskReady("memory") && blend("avatarVisibility") < .001 &&
                                    !m_avatar->isEnabled() && m_avatar->running(),
                                "MOONROOM_HIDDEN_TASK_AVATAR_STOPPED_RUNNING");
                        require(frameAdvance > 0 || idleAdvance > .01,
                                "MOONROOM_HIDDEN_AVATAR_FRAMES_AND_IDLE_TIME_FROZEN");
                        require(after.value("loads") == m_hiddenAvatarBefore.value("loads") &&
                                    after.value("releases") ==
                                        m_hiddenAvatarBefore.value("releases"),
                                "MOONROOM_HIDDEN_AVATAR_RELOADED_OR_RELEASED");
                        const bool userActionActiveAtStart =
                            m_hiddenAvatarBefore.value("motionActive").toBool() ||
                            m_hiddenAvatarBefore.value("expressionActive").toBool();
                        if (userActionActiveAtStart)
                            require(userAdvance > .01,
                                    "MOONROOM_HIDDEN_USER_ANIMATION_TIME_FROZEN");
                        record("compact-task-retains-running-avatar-and-user-action",
                               {{"hiddenObservationMs", m_stepClock.elapsed()},
                                {"sameNativeAvatar", true},
                                {"runningBefore", m_hiddenAvatarBefore.value("running")},
                                {"runningAfter", after.value("running")},
                                {"frameAdvance", frameAdvance},
                                {"idleSecondsAdvance", idleAdvance},
                                {"userAnimationSecondsAdvance", userAdvance},
                                {"userActionActiveAtStart", userActionActiveAtStart},
                                {"loadsBefore", m_hiddenAvatarBefore.value("loads")},
                                {"loadsAfter", after.value("loads")},
                                {"releasesBefore", m_hiddenAvatarBefore.value("releases")},
                                {"releasesAfter", after.value("releases")}});
                    },
                    350);
            }
            add(
                label + "-settings", [this] { watchTaskSwitch(); },
                [this] { return taskReady("settings"); },
                [this, label] {
                    finishTaskSwitch();
                    checkGeometry("settings");
                    require(!find("compactStop", false)->isVisible(),
                            "MOONROOM_IDLE_STOP_CONTROL_VISIBLE");
                    if (m_window->width() < 1180)
                        capture("compact-task-" + label);
                },
                80);
            add(
                label + "-character-exception", [this] { click("nav-character"); },
                [this] { return taskReady("character"); },
                [this] {
                    checkGeometry("character");
                    record("character-task-keeps-avatar-available");
                },
                80);
            add(
                label + "-return-companion", [this] { click("continueChat"); },
                [this] { return chatReady("companion"); },
                [this] {
                    checkAvatarIdentity();
                    require(blend("avatarVisibility") > .999 && m_avatar->isVisible() &&
                                m_avatar->isEnabled(),
                            "MOONROOM_RETURN_COMPANION_DID_NOT_RESTORE_AVATAR");
                    record("return-companion-restores-avatar-without-reload");
                },
                100);
        }
        add(
            "restore-original-viewport-and-draft", [this] { m_window->resize(m_originalSize); },
            [this] { return m_window->size() == m_originalSize && chatReady("companion"); },
            [this] {
                type("chatComposer", m_originalDraft);
                require(m_session->draft() == m_originalDraft && archiveFields() == m_archiveBefore,
                        "MOONROOM_TEST_CHANGED_EXISTING_DRAFT");
                require(m_readingSendClicks == 2 && m_stopSendClicks == 1 && m_stopClicks == 1 &&
                            messageCount("user", "阅读记录 1：请认真给我一份完整的项目说明") == 1 &&
                            messageCount("user", "阅读记录 2：请认真给我一份完整的项目说明") == 1 &&
                            messageCount("user", "停止记录") == 1 &&
                            messageCount("user", "组合记录：请认真给我一份完整的后续安排") == 1 &&
                            messageCount("user") == m_baselineUserCount + 4,
                        "MOONROOM_FIXTURE_DISPATCH_COUNT_MISMATCH");
                capture("companion-final");
                record("fixture-dispatches-remain-exact",
                       {{"readingUiSendClicks", m_readingSendClicks},
                        {"independentStopUiSendClicks", m_stopSendClicks},
                        {"stopUiClicks", m_stopClicks}});
            },
            180);
    }
    void tick() {
        if (m_finished || m_inTick)
            return;
        m_inTick = true;
        try {
            require(m_window && m_session && m_editor, "MOONROOM_WINDOW_OR_SESSION_DESTROYED");
            require(m_occlusion.error.isEmpty(), m_occlusion.error);
            require(m_total.elapsed() < 140000, "MOONROOM_INTERACTION_TOTAL_TIMEOUT");
            if (m_total.elapsed() < m_demoHoldUntil) { m_inTick = false; return; }
            if (m_watchTaskBlend) {
                m_minTaskBlend = std::min(m_minTaskBlend, blend("taskBlend"));
                require(mode() == "task" && blend("taskBlend") > .995,
                        "MOONROOM_TASK_SWITCH_RETURNED_TO_COMPANION");
            }
            if (m_step >= m_steps.size()) {
                m_inTick = false;
                finish(true);
                return;
            }
            auto &step = m_steps[m_step];
            if (!m_entered) {
                m_entered = true;
                m_stepClock.restart();
                if (step.name == "combined-reply-arrives-behind-task")
                    m_combinedCheck38StartedEpochMs = QDateTime::currentMSecsSinceEpoch();
                m_cadence.phase(step.name.contains("resize") ? "resize" : step.name.contains("wheel") || step.name == "combined-old-text" ? "reading-scroll" : step.name.startsWith("composer-growth") ? "composer-growth" : step.name.startsWith("reading-reverse") || step.name.startsWith("reading-rapid") || step.name == "companion-to-reading" ? "reading-transition" : "");
                if (step.enter)
                    step.enter();
            }
            if (m_stepClock.elapsed() > step.timeoutMs) {
                // Bounded state at the deadline: enum strings and counts only.
                const auto session = m_session ? m_session->diagnostics() : QVariantMap();
                m_stepTimeoutDiagnostic = {
                    {"stepIndex", int(m_step)}, {"stepElapsedMs", m_stepClock.elapsed()},
                    {"timeoutMs", step.timeoutMs}, {"minimumMs", step.minimumMs},
                    {"busy", m_session && m_session->busy()},
                    {"chatState", session.value("chatState").toString().left(32)},
                    {"pendingCommandCount", session.value("pendingCommands").toList().size()},
                    {"assistantMessages", m_session ? messageCount("assistant") : -1},
                    {"userMessages", m_session ? messageCount("user") : -1}};
            }
            require(m_stepClock.elapsed() <= step.timeoutMs, readingSelectionTimeoutCode("MOONROOM_STEP_TIMEOUT:" + step.name));
            if (m_stepClock.elapsed() >= step.minimumMs && (!step.ready || step.ready())) {
                if (step.validate)
                    step.validate();
                if (step.name == "combined-reply-arrives-behind-task") {
                    sampleCombinedReplyTiming();
                    m_combinedReplyTimingActive = false;
                }
                ++m_step;
                m_entered = false;
            }
        } catch (const std::exception &error) {
            m_inTick = false;
            finish(false, QString::fromUtf8(error.what()));
            return;
        }
        m_inTick = false;
    }
    void finish(bool passed, const QString &error = {}) {
        if (m_finished)
            return;
        sampleCombinedReplyTiming();
        m_combinedReplyTimingActive = false;
        m_combinedReplyTimingArmed = false;
        m_finished = true;
        m_timer.stop();
        archiveActionRecord();
        // Preserve failure properties while the actual held pointer is still
        // observable. The cleanup release is never a successful drag release.
        finishReadingSelectionAcquisition(false);
        if (m_window && m_mousePressed) {
            QTest::mouseRelease(m_window, Qt::LeftButton, Qt::NoModifier, m_selectionEnd.toPoint());
            m_mousePressed = false;
            if (m_readingSelectionDragStarted && !m_readingSelectionAcquisitions.isEmpty()) {
                ++m_readingSelectionCleanupReleaseCount;
                auto acquisition = m_readingSelectionAcquisitions.last().toMap();
                acquisition["cleanupReleaseCount"] = m_readingSelectionCleanupReleaseCount;
                m_readingSelectionAcquisitions.last() = acquisition;
            }
        }
        if (m_window && m_preeditSent) {
            QInputMethodEvent clear;
            QCoreApplication::sendEvent(m_window, &clear);
        }
        if (m_window && !m_originalSize.isEmpty() && m_window->size() != m_originalSize)
            m_window->resize(m_originalSize);
        const QVariantMap result{
            {"schema", "reverie.qt.moonroom-interaction.v1"},
            {"passed", passed},
            {"error", error},
            {"step", m_step < m_steps.size() ? m_steps[m_step].name : "complete"},
            {"elapsedMs", m_total.isValid() ? m_total.elapsed() : 0},
            {"interactionElapsedMsExcludingCaptures",
             m_total.isValid() ? m_total.elapsed() - m_captureTimeMs : 0},
            {"captureTimeMsExcluded", m_captureTimeMs},
            {"performanceScope", "No frame-cadence or GPU timing claims; synchronous screenshots "
                                 "excluded from interaction wall-clock"},
            {"inputScope",
             "QTest mouse, wheel and keyboard events in existing QQuickWindow; synthetic "
             "QInputMethodEvent commits and preedit, not physical OS IME acceptance"},
            {"readingFixtureUiSendClicks", m_readingSendClicks},
            {"independentStopFixtureUiSendClicks", m_stopSendClicks},
            {"stopUiClicks", m_stopClicks},
            {"readingWheelEvents", m_wheelEvents},
            {"readingSelectionAcquisition", m_readingSelectionAcquisitions},
            {"fixtureDispatchScope",
             "Exactly two distinct reading user rows, one delayed combined scenario and one separate cancellation row; caller "
             "verifies model request counts independently"},
            {"checks", m_checks},
            {"legacyClicks", m_clickLog.metadata()},
            {"archiveControlReadiness", m_archiveControlReadiness},
            {"captures", m_captures},
            {"tabFocusTrail", m_focusTrail},
            {"archiveFocusTraversal", m_archiveFocusTraversal},
            {"previewButtonTabObservation", m_previewTabObservation},
            {"allForegroundOcclusion", m_occlusion.report()},
            {"additionalCadence", m_cadence.report()},
            {"avatarLoadsBefore", m_loads},
            {"avatarLoadsAfter", m_avatar ? m_avatar->loads() : -1},
            {"sessionDiagnostics", m_session ? m_session->diagnostics() : QVariantMap()},
            {"combinedReplyTiming", QVariantMap{
                {"sendEpochMs", m_combinedSendEpochMs},
                {"check38StartedEpochMs", m_combinedCheck38StartedEpochMs},
                {"replyObservedEpochMs", m_combinedReplyObservedEpochMs},
                {"stateChanges", m_combinedReplyStateChanges}}},
            {"stepTimeoutDiagnostic", m_stepTimeoutDiagnostic}};
        auto completion = std::move(m_completion);
        if (completion)
            completion(result);
        deleteLater();
    }
};
} // namespace

void MoonroomInteractionCheck::run(QQuickWindow *window, RuntimeBridge *session,
                                   ArchiveEditor *archiveEditor, const QString &capturePrefix,
                                   Completion completion) {
    if (!window || !session || !archiveEditor) {
        QTimer::singleShot(0, [completion = std::move(completion)] {
            if (completion)
                completion(
                    {{"passed", false}, {"error", "MOONROOM_WINDOW_SESSION_AND_EDITOR_REQUIRED"}});
        });
        return;
    }
    new Runner(window, session, archiveEditor, capturePrefix, std::move(completion));
}

#include "MoonroomInteractionCheck.moc"
