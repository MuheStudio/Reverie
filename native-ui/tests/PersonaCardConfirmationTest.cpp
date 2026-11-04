#include "../src/ArchiveEditor.h"
#include "../src/RuntimeBridge.h"
#include "CheckContract.h"
#include "CandidateHeaderProbe.h"
#include "PersonaRowInputProbe.h"
#include "ArchiveInputProbe.h"
#include "PersonaProfileEditInput.h"
#include "ArchiveFocusProbe.h"
#include "WorldbookRegexProbe.h"
#include "WorldbookInjectionInput.h"
#include "WorldbookInjectionNavigation.h"
#include "WorldbookInjectionHit.h"
#include "../src/WindowInputState.h"
#include <QDir>
#include <QFileInfo>
#include <QFont>
#include "MemoryActionProbe.h"
#include "SummaryInteractionProbe.h"
#include <QCryptographicHash>
#include <QAccessible>
#include <QColor>
#include <QDeadlineTimer>
#include <QDebug>
#include <QElapsedTimer>
#include <QEventPoint>
#include <QFile>
#include <QGuiApplication>
#include <QInputMethodEvent>
#include <QJsonArray>
#include <QJsonDocument>
#include <QKeyEvent>
#include <QJSValue>
#include <QMetaMethod>
#include <QMetaProperty>
#include <QMouseEvent>
#include <QTouchEvent>
#include <QWheelEvent>
#include <QPointingDevice>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QQmlPropertyMap>
#include <QQuickItem>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSGRendererInterface>
#include <QScopeGuard>
#include <QSet>
#include <QSignalSpy>
#include <QTemporaryDir>
#include <QTest>
#include <QtTest/qtestwheel.h>
#include <QUrl>
#include <QtCore/qtestsupport_core.h>
#include <qpa/qwindowsysteminterface.h>
#include <cmath>
#include <functional>
#include <limits>
#include <memory>

// Split the two map notifications solely to make both QML evaluation orders
// deterministic. Every value and action still comes from the real bridge.
// The ordinary cases below bind session directly to RuntimeBridge instead.
class CardNotificationOrderSession final : public QQmlPropertyMap {
    Q_OBJECT
public:
    enum Order { CandidateFirst, FeedbackFirst };
    CardNotificationOrderSession(RuntimeBridge *bridge, Order order)
        : QQmlPropertyMap(this, nullptr), m_bridge(bridge), m_order(order) {
        sync();
        connect(bridge, &RuntimeBridge::changed, this, &CardNotificationOrderSession::sync);
        connect(bridge, &RuntimeBridge::commandResult, this, &CardNotificationOrderSession::commandResult);
    }
    Q_INVOKABLE void cancelPersonaCard() { m_bridge->cancelPersonaCard(); }
    Q_INVOKABLE void importPersonaCard() { m_bridge->importPersonaCard(); }

signals:
    void changed();
    void commandResult(QString command, QVariantMap result);
    void cardPropertyPublished(QString name);

private:
    void sync() {
        const auto &meta = RuntimeBridge::staticMetaObject;
        for (int index = meta.propertyOffset(); index < meta.propertyCount(); ++index) {
            const auto property = meta.property(index);
            const QString name = QString::fromLatin1(property.name());
            if (name != "personaCardCandidate" && name != "personaCardFeedback")
                insert(name, property.read(m_bridge));
        }
        const QString candidate = "personaCardCandidate";
        const QString feedback = "personaCardFeedback";
        const QStringList order = m_order == CandidateFirst
            ? QStringList{candidate, feedback} : QStringList{feedback, candidate};
        for (const auto &name : order) {
            const auto next = m_bridge->property(name.toLatin1().constData());
            if (!contains(name) || value(name) != next) {
                insert(name, next);
                emit cardPropertyPublished(name);
            }
        }
        emit changed();
    }
    RuntimeBridge *m_bridge;
    Order m_order;
};

// QML notify methods are discovered from their properties. Keeping this
// receiver outside the QtTest object avoids adding an accidental test slot.
class CandidateFocusObserver final : public QObject {
    Q_OBJECT
public:
    std::function<void()> observe;
public slots:
    void changed() { if (observe) observe(); }
};

// This observer is scoped to one blank-input helper and one actual window.
// It observes delivery before Qt Quick handles the event and never consumes it.
class CandidateWindowPointerObserver final : public QObject {
public:
    explicit CandidateWindowPointerObserver(QQuickWindow *window) : m_window(window) {
        if (m_window)
            m_window->installEventFilter(this);
    }
    ~CandidateWindowPointerObserver() override {
        if (m_window)
            m_window->removeEventFilter(this);
    }
    std::function<void(const QMouseEvent &)> observe;
protected:
    bool eventFilter(QObject *watched, QEvent *event) override {
        if (watched == m_window && observe &&
            (event->type() == QEvent::MouseButtonPress || event->type() == QEvent::MouseButtonRelease))
            observe(*static_cast<QMouseEvent *>(event));
        return false;
    }
private:
    QPointer<QQuickWindow> m_window;
};

// An adversarial input fault, scoped to one real window. Consume only the
// actual platform SelectAll press so the shared helper must reject the absent
// selection before it can dispatch a digit or commit the SpinBox.
class WorldbookDepthSelectAllBlocker final : public QObject {
public:
    explicit WorldbookDepthSelectAllBlocker(QQuickWindow *window) : m_window(window) {
        if (m_window) m_window->installEventFilter(this);
    }
    ~WorldbookDepthSelectAllBlocker() override {
        if (m_window) m_window->removeEventFilter(this);
    }
    int blockedPresses() const { return m_blocked; }
protected:
    bool eventFilter(QObject *watched, QEvent *event) override {
        if (watched == m_window && event->type() == QEvent::KeyPress &&
            static_cast<QKeyEvent *>(event)->matches(QKeySequence::SelectAll)) {
            ++m_blocked;
            return true;
        }
        return false;
    }
private:
    QPointer<QQuickWindow> m_window;
    int m_blocked = 0;
};

// Test-only visual move of an intact archive subtree. A TextArea managed by
// ScrollView must stay with its internal Flickable; moving that leaf alone can
// detach private Qt control associations that setParentItem() cannot restore.
// QObject ownership is deliberately never changed. The destructor restores the
// visual tree on every early QVERIFY return, before the auxiliary window dies.
class ArchiveVisualSubtreeLease final {
public:
    ArchiveVisualSubtreeLease(QQuickItem *root, QQuickItem *leaf)
        : m_root(root), m_leaf(leaf), m_visualParent(root ? root->parentItem() : nullptr),
          m_objectParent(root ? root->parent() : nullptr), m_window(root ? root->window() : nullptr),
          m_leafVisualParent(leaf ? leaf->parentItem() : nullptr), m_leafObjectParent(leaf ? leaf->parent() : nullptr),
          m_rootOwnership(root ? QQmlEngine::objectOwnership(root) : QQmlEngine::CppOwnership),
          m_leafOwnership(leaf ? QQmlEngine::objectOwnership(leaf) : QQmlEngine::CppOwnership) {}
    ~ArchiveVisualSubtreeLease() { restore(); }
    bool valid() const {
        return m_root && m_leaf && m_visualParent && m_window
            && (m_root == m_leaf || m_root->isAncestorOf(m_leaf));
    }
    bool moveTo(QQuickItem *parent) {
        if (!valid()) return false;
        m_root->setParentItem(parent);
        return m_root->parentItem() == parent && structureIntact();
    }
    bool restore() {
        if (!m_root || !m_visualParent) return false;
        m_root->setParentItem(m_visualParent);
        return m_root->parentItem() == m_visualParent && m_root->window() == m_window && structureIntact();
    }
    bool structureIntact() const {
        return m_root && m_leaf && m_root->parent() == m_objectParent
            && m_leaf->parent() == m_leafObjectParent && m_leaf->parentItem() == m_leafVisualParent
            && QQmlEngine::objectOwnership(m_root) == m_rootOwnership
            && QQmlEngine::objectOwnership(m_leaf) == m_leafOwnership
            && (m_root == m_leaf || m_root->isAncestorOf(m_leaf));
    }
    QVariantMap snapshot() const {
        return {{"rootPresent", !m_root.isNull()}, {"leafPresent", !m_leaf.isNull()},
            {"visualParentRestored", m_root && m_root->parentItem() == m_visualParent},
            {"rootObjectParentUnchanged", m_root && m_root->parent() == m_objectParent},
            {"leafObjectParentUnchanged", m_leaf && m_leaf->parent() == m_leafObjectParent},
            {"leafVisualParentUnchanged", m_leaf && m_leaf->parentItem() == m_leafVisualParent},
            {"rootOwnershipUnchanged", m_root && QQmlEngine::objectOwnership(m_root) == m_rootOwnership},
            {"leafOwnershipUnchanged", m_leaf && QQmlEngine::objectOwnership(m_leaf) == m_leafOwnership},
            {"originalWindowRestored", m_root && m_root->window() == m_window},
            {"leafMatchesRootWindow", m_root && m_leaf && m_root->window() == m_leaf->window()},
            {"structureIntact", structureIntact()}};
    }
private:
    QPointer<QQuickItem> m_root, m_leaf, m_visualParent;
    QPointer<QObject> m_objectParent;
    QPointer<QQuickWindow> m_window;
    QPointer<QQuickItem> m_leafVisualParent;
    QPointer<QObject> m_leafObjectParent;
    QQmlEngine::ObjectOwnership m_rootOwnership, m_leafOwnership;
};

// Deliberately malformed property shapes for the evidence reader. This is
// not a second widget implementation; the positive path reads the real Text.
class CandidateHeaderEnumFixture final : public QObject {
    Q_OBJECT
public:
    enum Format : int { Plain = 0, Styled = 1 };
    Q_ENUM(Format)
    Q_PROPERTY(int integerFormat READ integerFormat)
    Q_PROPERTY(QString stringFormat READ stringFormat)
    Q_PROPERTY(Format invalidFormat READ invalidFormat)
    int integerFormat() const { return 0; }
    QString stringFormat() const { return "Plain"; }
    Format invalidFormat() const { return static_cast<Format>(99); }
};

// Malformed property shapes only; the accepted textFormat path below reads
// production ArchiveDrawer TextAreas and their actual Qt enum metadata.
class WorldbookRegexRawFormatFixture final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariant textFormat MEMBER value)
public:
    QVariant value;
};
class WorldbookRegexForeignFormatFixture final : public QObject {
    Q_OBJECT
public:
    enum Format : int { PlainText = 0, RichText = 1 };
    Q_ENUM(Format)
    Q_PROPERTY(Format textFormat READ textFormat)
    Format textFormat() const { return PlainText; }
};

// A real non-text QObject whose diagnostic class name contains TextField.
// The navigation evidence must not mistake this test-only alias for a widget.
class NavigationTextFieldAlias final : public QQuickItem {
    Q_OBJECT
};

namespace {
struct MemoryFeedbackAttachedRead {
    bool attempted = false;
    bool contextPresent = false, contextValid = false, engineMatches = false;
    bool rolePropertyValid = false, roleIsProperty = false, roleValueValid = false, roleTypeValid = false;
    bool roleConversionOk = false, roleMeasured = false;
    bool namePropertyValid = false, nameIsProperty = false, nameValueValid = false, nameIsQString = false;
    bool nameMeasured = false, nameMatches = false, missingRole = false;
    int roleTypeId = QMetaType::UnknownType, nameTypeId = QMetaType::UnknownType, role = 0, nameLength = 0;
    QString roleTypeName, nameTypeName;
    bool valid() const {
        return attempted && contextPresent && contextValid && engineMatches && rolePropertyValid && roleIsProperty &&
            roleValueValid && roleTypeValid && roleConversionOk && roleMeasured && role == int(QAccessible::StaticText) &&
            namePropertyValid && nameIsProperty && nameValueValid && nameIsQString && nameMeasured && nameMatches;
    }
    QJsonObject metadata() const {
        return {{"attempted", attempted}, {"contextPresent", contextPresent}, {"contextValid", contextValid}, {"engineMatches", engineMatches},
            {"rolePath", missingRole ? "fixed-missing" : "Accessible.role"}, {"rolePropertyValid", rolePropertyValid},
            {"roleIsProperty", roleIsProperty}, {"roleValueValid", roleValueValid}, {"roleTypeValid", roleTypeValid},
            {"roleTypeId", roleValueValid ? QJsonValue(roleTypeId) : QJsonValue(QJsonValue::Null)},
            {"roleTypeName", roleTypeName.left(80)}, {"roleConversionOk", roleConversionOk},
            {"roleMeasured", roleMeasured}, {"roleValue", roleMeasured ? QJsonValue(role) : QJsonValue(QJsonValue::Null)},
            {"namePropertyValid", namePropertyValid}, {"nameIsProperty", nameIsProperty}, {"nameValueValid", nameValueValid},
            {"nameIsQString", nameIsQString}, {"nameTypeId", nameValueValid ? QJsonValue(nameTypeId) : QJsonValue(QJsonValue::Null)},
            {"nameTypeName", nameTypeName.left(80)},
            {"nameMeasured", nameMeasured}, {"nameLength", nameMeasured ? QJsonValue(nameLength) : QJsonValue(QJsonValue::Null)},
            {"nameMatches", nameMatches}, {"valid", valid()}, {"fallbackUsed", false}};
    }
};

MemoryFeedbackAttachedRead readMemoryFeedbackAttached(QQuickItem *feedback, QQmlEngine *engine,
                                                      const QString &expectedName, bool missingRole = false) {
    MemoryFeedbackAttachedRead out;
    out.attempted = true;
    out.missingRole = missingRole;
    auto *context = feedback ? qmlContext(feedback) : nullptr;
    out.contextPresent = context != nullptr;
    out.contextValid = context && context->isValid();
    out.engineMatches = context && context->engine() == engine && engine;
    if (!out.contextValid || !out.engineMatches) return out;
    const QQmlProperty roleProperty(feedback,
        missingRole ? QString("Accessible.memoryFeedbackFixedMissingRole") : QString("Accessible.role"), context);
    out.rolePropertyValid = roleProperty.isValid();
    out.roleIsProperty = roleProperty.isProperty();
    if (out.rolePropertyValid && out.roleIsProperty) {
        const auto value = roleProperty.read();
        out.roleValueValid = value.isValid();
        if (out.roleValueValid) {
            out.roleTypeId = value.metaType().id();
            out.roleTypeName = QString::fromLatin1(value.metaType().name());
            out.roleTypeValid = out.roleTypeId == QMetaType::Int ||
                value.metaType().flags().testFlag(QMetaType::IsEnumeration);
            if (out.roleTypeValid) {
                out.role = value.toInt(&out.roleConversionOk);
                out.roleMeasured = out.roleConversionOk;
            }
        }
    }
    const QQmlProperty nameProperty(feedback, "Accessible.name", context);
    out.namePropertyValid = nameProperty.isValid();
    out.nameIsProperty = nameProperty.isProperty();
    if (out.namePropertyValid && out.nameIsProperty) {
        const auto value = nameProperty.read();
        out.nameValueValid = value.isValid();
        if (out.nameValueValid) {
            out.nameTypeId = value.metaType().id();
            out.nameTypeName = QString::fromLatin1(value.metaType().name());
            out.nameIsQString = value.metaType() == QMetaType::fromType<QString>();
            if (out.nameIsQString) {
                const auto name = value.value<QString>();
                out.nameMeasured = true; out.nameLength = name.size(); out.nameMatches = name == expectedName;
            }
        }
    }
    return out;
}

// One operation owns one observer and independent nonvisual focus scope. The
// owner survives model/delegate replacement and is outside the TaskPanel.
// Destruction also runs on every QVERIFY early return, without candidate trace.
class MemoryFeedbackProbe final : public QObject {
public:
    MemoryFeedbackProbe(QQuickWindow *window, QQuickItem *panel, QElapsedTimer &clock,
                        const QDeadlineTimer &deadline, std::function<void(QWindow *)> activate,
                        const QString &operation)
        : m_window(window), m_panel(panel), m_clock(clock), m_deadline(deadline), m_activate(std::move(activate)),
          m_operation(operation) {
        static const QStringList operations{"pin", "unpin", "edit", "delete", "display-pending", "display-success",
            "display-error", "display-unknown", "negative-focus", "negative-attached"};
        if (!m_window || !m_panel || !m_panel->parentItem() || !operations.contains(operation)) {
            reject("fixture-unavailable"); return;
        }
        m_scope = std::make_unique<QQuickItem>(m_panel->parentItem());
        m_scope->setObjectName("memoryFeedbackSentinelScope");
        m_scope->setFlag(QQuickItem::ItemIsFocusScope, true);
        m_scope->setFlag(QQuickItem::ItemHasContents, false);
        m_scope->setAcceptedMouseButtons(Qt::NoButton); m_scope->setActiveFocusOnTab(false);
        m_leaf = std::make_unique<QQuickItem>(m_scope.get());
        m_leaf->setObjectName("memoryFeedbackSentinelLeaf");
        m_leaf->setFlag(QQuickItem::ItemHasContents, false);
        m_leaf->setAcceptedMouseButtons(Qt::NoButton); m_leaf->setActiveFocusOnTab(false);
        m_other = std::make_unique<QQuickItem>(m_scope.get());
        m_other->setObjectName("memoryFeedbackForeignLeaf");
        m_other->setFlag(QQuickItem::ItemHasContents, false);
        m_other->setAcceptedMouseButtons(Qt::NoButton); m_other->setActiveFocusOnTab(false);
        m_lastOwnerIdentity = reinterpret_cast<quintptr>(m_window->activeFocusItem());
        m_connections.append(connect(m_window, &QQuickWindow::activeFocusItemChanged, this, [this] {
            const auto identity = reinterpret_cast<quintptr>(m_window->activeFocusItem());
            const bool changed = identity != m_lastOwnerIdentity;
            m_lastOwnerIdentity = identity;
            ++m_totalFocusEvents;
            if (m_armed) { ++m_armedFocusEvents; reject("armed-focus-event"); }
            else { ++m_preparationFocusEvents; invalidateAnchor(); }
            int priority = m_armed ? 60 : 20;
            if (m_armed && changed) {
                ++m_armedOwnerChanges;
                if (m_armedOwnerChanges <= 3) priority = 104 - m_armedOwnerChanges;
            }
            record("focus-item", priority, changed);
        }, Qt::DirectConnection));
        m_connections.append(connect(m_window, &QWindow::activeChanged, this, [this] { windowEvent("window-active"); }, Qt::DirectConnection));
        m_connections.append(connect(qGuiApp, &QGuiApplication::focusWindowChanged, this,
            [this](QWindow *) { windowEvent("focus-window"); }, Qt::DirectConnection));
        m_connections.append(connect(m_window, &QQuickWindow::frameSwapped, this, [this] {
            ++m_frameSerial;
            if (m_stableAt < 0 || m_frameSerial <= m_stableFrame || m_postQueued) return;
            m_postQueued = true;
            const auto generation = m_stableGeneration;
            QMetaObject::invokeMethod(this, [this, generation] {
                if (generation == m_stableGeneration) m_postedAfterFrame = true;
            }, Qt::QueuedConnection);
        }, Qt::QueuedConnection));
        m_activate(m_window);
    }
    ~MemoryFeedbackProbe() override {
        std::sort(m_records.begin(), m_records.end(), [](const Record &a, const Record &b) { return a.ordinal < b.ordinal; });
        for (const auto &record : m_records) emitRecord(record.state);
        emitRecord(snapshot("terminal", "terminal", -1));
        for (const auto &connection : m_connections) disconnect(connection);
        m_connections.clear();
        if (m_activate) m_activate(nullptr);
        m_other.reset(); m_leaf.reset(); m_scope.reset();
    }
    bool windowReady() {
        if (m_activationVerified) return windowMatches() && m_window->isActive() && inTime();
        if (!m_window || m_rejected) return false;
        m_activationVerified = QTest::qWaitFor([this] {
            if (!inTime()) return false;
            m_window->update();
            return windowMatches() && m_window->isActive();
        }, m_deadline) && inTime();
        if (!m_activationVerified) reject("activation-deadline");
        record("activation", 40);
        return m_activationVerified;
    }
    bool prepareAndArm() {
        if (m_prepareAttempted || m_armed || m_rejected) { reject("preparation-already-attempted"); return false; }
        m_prepareAttempted = true;
        if (!m_leaf || !windowReady() || !inTime()) { reject("preparation-unavailable"); return false; }
        ++m_leafForceCount;
        m_leaf->forceActiveFocus(Qt::OtherFocusReason);
        record("baseline-forced", 45);
        const bool ready = QTest::qWaitFor([this] {
            if (!inTime() || m_rejected) return false;
            m_window->update();
            if (!windowMatches() || !m_window->isActive() || !ownerMatchesLeaf()) {
                invalidateAnchor();
                return false;
            }
            if (m_stableAt < 0) {
                m_stableAt = m_clock.elapsed(); m_stableFrame = m_frameSerial; m_stableObservations = 1;
                m_postQueued = m_postedAfterFrame = false; ++m_stableGeneration;
                return false;
            }
            ++m_stableObservations;
            if (m_stableObservations < 2 || m_clock.elapsed() - m_stableAt < 40 ||
                m_frameSerial <= m_stableFrame || !m_postedAfterFrame) return false;
            record("baseline-stable", 90);
            m_armed = true; m_armedAt = m_clock.elapsed(); m_armedFrame = m_frameSerial;
            record("armed", 90);
            return true;
        }, m_deadline);
        if (!ready || !inTime()) reject("baseline-deadline");
        return ready && m_armed && !m_rejected;
    }
    bool focusUnchanged() {
        if (!m_armed || !inTime() || !windowMatches() || !m_window->isActive() || !ownerMatchesLeaf() ||
            m_armedFocusEvents || m_armedWindowEvents) reject("focus-check-failed");
        record("focus-check", 30);
        return m_armed && !m_rejected;
    }
    void attached(const MemoryFeedbackAttachedRead &read) { m_attached = read.metadata(); record("attached", 80); }
    int armedEvents() const { return m_armedFocusEvents; }
    int leafForceCount() const { return m_leafForceCount; }
    bool ownerMatchesLeaf() const { return m_window && m_leaf && m_window->activeFocusItem() == m_leaf.get(); }
    QQuickItem *foreignItem() const { return m_other.get(); }
private:
    bool inTime() const { return !m_deadline.hasExpired() && m_clock.elapsed() < 4000; }
    bool windowMatches() const { return m_window && QGuiApplication::focusWindow() == m_window; }
    void reject(const QString &reason) { m_rejected = true; if (m_reason.isEmpty()) m_reason = reason; }
    void invalidateAnchor() {
        m_stableAt = -1; m_stableFrame = 0; m_stableObservations = 0;
        m_postQueued = m_postedAfterFrame = false;
        ++m_stableGeneration;
    }
    void windowEvent(const QString &event) {
        if (m_armed) { ++m_armedWindowEvents; reject("armed-window-event"); }
        else { ++m_preparationWindowEvents; invalidateAnchor(); }
        record(event, m_armed ? 85 : 20);
    }
    QJsonObject owner() const {
        auto *item = m_window ? m_window->activeFocusItem() : nullptr;
        const QString region = !item ? "none" : item == m_leaf.get() ? "sentinel-leaf" : item == m_other.get() ? "sentinel-other"
            : item == m_scope.get() ? "sentinel-scope" : item == m_panel || (m_panel && m_panel->isAncestorOf(item)) ? "task-panel"
            : m_window && item == m_window->contentItem() ? "window-content" : "window-other";
        return {{"present", item != nullptr}, {"name", item ? item->objectName().left(80) : QString()},
            {"class", item ? QString::fromLatin1(item->metaObject()->className()).left(80) : QString()},
            {"region", region}, {"matchesLeaf", ownerMatchesLeaf()}};
    }
    struct Record { QJsonObject state; int priority = 0; quint64 ordinal = 0; };
    void record(const QString &event, int priority, int ownerChanged = -1) {
        ++m_processObserved;
        Record next{snapshot("process", event, ownerChanged), priority, m_processObserved};
        if (m_records.size() < 6) { m_records.append(next); return; }
        int lowest = 0;
        for (int index = 1; index < m_records.size(); ++index)
            if (m_records[index].priority < m_records[lowest].priority) lowest = index;
        if (priority > m_records[lowest].priority) m_records[lowest] = next;
    }
    QJsonObject snapshot(const QString &kind, const QString &event, int ownerChanged) const {
        QJsonObject out{{"schema", "reverie.qt.memory-feedback-probe.v1"}, {"case", QString::fromLatin1(QTest::currentTestFunction())},
            {"dataTag", QString::fromLatin1(QTest::currentDataTag() ? QTest::currentDataTag() : "")},
            {"operation", m_operation}, {"kind", kind}, {"event", event}, {"stage", m_armed ? "armed" : "preparation"},
            {"elapsedMs", m_clock.elapsed()}, {"frameSerial", qint64(m_frameSerial)}, {"windowFocusMatches", windowMatches()},
            {"windowActive", m_window && m_window->isActive()}, {"owner", owner()},
            {"preparationFocusEvents", m_preparationFocusEvents}, {"armedFocusEvents", m_armedFocusEvents},
            {"preparationWindowEvents", m_preparationWindowEvents}, {"armedWindowEvents", m_armedWindowEvents},
            {"totalFocusEvents", m_totalFocusEvents}, {"armedOwnerChanges", m_armedOwnerChanges},
            {"ownerChanged", ownerChanged >= 0 ? QJsonValue(bool(ownerChanged)) : QJsonValue(QJsonValue::Null)},
            {"eventOrdinal", qint64(m_processObserved + (kind == "terminal" ? 1 : 0))},
            {"prepareAttempted", m_prepareAttempted}, {"armed", m_armed},
            {"leafForceCount", m_leafForceCount}, {"stableObservations", m_stableObservations}, {"stableSinceMs", m_stableAt},
            {"stableFrame", qint64(m_stableFrame)}, {"armedAtMs", m_armedAt}, {"armedFrame", qint64(m_armedFrame)},
            {"postedAfterFrame", m_postedAfterFrame}, {"rejected", m_rejected}, {"reason", m_reason}, {"attached", m_attached}};
        if (kind == "terminal") out["outcome"] = QTest::currentTestFailed() ? "body-failed" : "body-passed";
        return out;
    }
    void emitRecord(QJsonObject out) const {
        int focusRecords = 0;
        for (const auto &record : m_records) focusRecords += record.state.value("event").toString() == "focus-item";
        out.insert("processCount", m_records.size()); out.insert("processLimit", 6);
        out.insert("processObserved", qint64(m_processObserved));
        out.insert("processOverflow", qint64(m_processObserved) - m_records.size());
        out.insert("focusRecordOverflow", m_totalFocusEvents - focusRecords);
        qInfo().noquote() << "MEMORY_FEEDBACK_PROBE" << QString::fromUtf8(QJsonDocument(out).toJson(QJsonDocument::Compact));
    }
    QPointer<QQuickWindow> m_window;
    QPointer<QQuickItem> m_panel;
    QElapsedTimer &m_clock;
    const QDeadlineTimer &m_deadline;
    std::function<void(QWindow *)> m_activate;
    QString m_operation, m_reason;
    std::unique_ptr<QQuickItem> m_scope, m_leaf, m_other;
    QList<QMetaObject::Connection> m_connections;
    QList<Record> m_records;
    QJsonObject m_attached = MemoryFeedbackAttachedRead{}.metadata();
    int m_preparationFocusEvents = 0, m_armedFocusEvents = 0, m_preparationWindowEvents = 0, m_armedWindowEvents = 0;
    int m_totalFocusEvents = 0, m_armedOwnerChanges = 0, m_leafForceCount = 0, m_stableObservations = 0;
    quint64 m_processObserved = 0;
    quintptr m_lastOwnerIdentity = 0;
    quint64 m_frameSerial = 0, m_stableFrame = 0, m_armedFrame = 0, m_stableGeneration = 0;
    qint64 m_stableAt = -1, m_armedAt = -1;
    bool m_activationVerified = false, m_prepareAttempted = false, m_armed = false, m_rejected = false;
    bool m_postQueued = false, m_postedAfterFrame = false;
};
} // namespace

// This name uses RuntimeBridge's existing test friend, in a separate executable
// from RuntimeBridgeTest. No production access hook or notification is added.
class RuntimeBridgeTest final : public QObject {
    Q_OBJECT
    std::unique_ptr<QTemporaryDir> m_data;
    std::unique_ptr<RuntimeBridge> m_bridge;
    std::unique_ptr<ArchiveEditor> m_archive;
    std::unique_ptr<CardNotificationOrderSession> m_orderSession;
    std::unique_ptr<QQmlEngine> m_engine;
    std::unique_ptr<QQuickWindow> m_window;
    QQuickItem *m_panel = nullptr;
    QObject *m_dialog = nullptr;
    QList<QJsonObject> m_frames;
    QVariantList m_personaFixtureSamples;
    QVariantMap m_personaFixtureLast;
    QPointer<QQuickItem> m_personaFixtureCopy;
    bool m_personaFixtureUsed = false;
    QJsonArray m_nativeEvidenceFiles;
    QString m_profileDiagnostic;
    QString m_summaryDiagnostic;
    int m_profileClickCount = 0;
    enum class ProfileScope { Page, Dialog };

    struct CandidateTarget {
        QString name, rowId;
    };
    struct CandidateObservation {
        QPointer<QQuickItem> item, row;
        int index = -1;
        QRectF scene, clip;
        QPoint point;
        QList<QPair<QPointer<QQuickItem>, QRectF>> clips;
        QJsonObject metadata;
        bool eligible = false;
    };
    struct CandidateBaseline {
        QString actionCommand, actionId, listId, candidateId;
        int actionCount = 0, listCount = 0, candidateCount = 0;
    };
    struct CandidateInput {
        CandidateBaseline before;
        QJsonObject envelope;
        QString requestId;
    };
    struct CandidateReads {
        QString listId, candidateId;
    };
    struct CandidateChange {
        QString semantic;
        QJsonObject state;
        int priority = 0;
        quint64 ordinal = 0;
    };
    struct CandidateHandlerPoint {
        bool measured = false;
        int id = -1, pressedButtons = 0;
        QPointF scene;
        QJsonObject metadata;
    };
    struct CandidatePointerObjects {
        QPointer<QQuickItem> layer;
        QPointer<QObject> observer;
        QRectF scene;
        bool eligible = false;
        QJsonObject metadata;
    };
    bool m_candidateTraceArmed = false, m_candidateFailureObservation = false,
        m_candidateInputDelivery = false;
    QElapsedTimer m_candidateElapsed;
    quint64 m_candidateFrameSerial = 0;
    CandidateTarget m_candidateTarget;
    CandidateBaseline m_candidateBaseline;
    QString m_candidateActionCommand, m_candidateDiagnostic, m_candidateFailureLayer,
        m_candidateFailureReason, m_candidateLayer, m_candidateLastChange;
    QStringList m_candidateFixedStages;
    int m_candidatePhysicalClicks = 0, m_candidatePhysicalSignals = 0,
        m_candidateSyntheticSignals = 0, m_candidateChangeSnapshots = 0,
        m_candidateChangeOverflow = 0;
    int m_candidatePhysicalKeys = 0, m_candidatePreArmKeys = 0,
        m_candidateFocusTransfers = 0;
    quint64 m_candidateObservationSerial = 0;
    QJsonObject m_candidateLastSemantic;
    QJsonObject m_candidateBlankInput, m_candidateHiddenKeyInput;
    QList<CandidateChange> m_candidateChanges;
    std::unique_ptr<CandidateFocusObserver> m_candidateFocusObserver;
    QList<QMetaObject::Connection> m_candidatePropertyConnections;
    int m_candidatePreArmClicks = 0, m_candidatePreArmSignals = 0, m_candidatePreArmSynthetic = 0;
    qint64 m_candidateInputBudgetMs = 0, m_candidateStableSinceMs = -1,
        m_candidateQualifiedAtMs = -1;
    quint64 m_candidateStableFrameSerial = 0, m_candidateQualifiedFrameSerial = 0;
    QMetaObject::Connection m_candidateFrameConnection, m_candidateBridgeConnection,
        m_candidateFocusConnection, m_candidateActiveConnection;

    static QByteArray cardJson() {
        return R"({"name":"Local card","description":"Untrusted local fixture"})";
    }
    static bool writeLocal(const QString &path, const QByteArray &bytes) {
        QFile file(path);
        return file.open(QIODevice::WriteOnly) && file.write(bytes) == bytes.size();
    }
    int importCount() const {
        int count = 0;
        for (const auto &frame : m_frames)
            count += frame.value("envelope").toObject().value("command").toString() == "persona:import";
        return count;
    }
    int profileUpdateCount() const {
        int count = 0;
        for (const auto &frame : m_frames)
            count += frame.value("envelope").toObject().value("command").toString() == "user:profile:update";
        return count;
    }
    int rendererCommandCount(const QString &command) const {
        int count = 0;
        for (const auto &frame : m_frames)
            count += frame["envelope"].toObject()["command"].toString() == command;
        return count;
    }
    QJsonObject lastRendererCommand(const QString &command) const {
        for (auto it = m_frames.crbegin(); it != m_frames.crend(); ++it) {
            const auto envelope = (*it)["envelope"].toObject();
            if (envelope["command"].toString() == command)
                return envelope;
        }
        return {};
    }
    void deliverRecall(const QString &id, const QJsonArray &memories,
                       const QString &mode = "hybrid", const QString &reason = "vector_search_completed",
                       QJsonValue pending = 0) {
        m_bridge->event({{"type", "memory:result"}, {"request_id", id},
            {"payload", QJsonObject{{"memories", memories},
                {"retrieval", QJsonObject{{"mode", mode}, {"reason", reason}, {"indexPending", pending}}}}}});
    }
    bool selectMemoryRecallPage() {
        if (!m_panel || !m_panel->setProperty("page", "memory"))
            return false;
        auto *tabs = m_panel->findChild<QQuickItem *>("memoryTabs");
        return tabs && tabs->setProperty("currentIndex", 4);
    }
    static QString candidateId(int n) {
        return "mc_" + QString("%1").arg(n, 32, 16, QLatin1Char('0'));
    }
    static QJsonArray candidateRows(int first, int count) {
        QJsonArray rows;
        for (int n = first; n < first + count; ++n)
            rows.append(QJsonObject{{"id", candidateId(n)}, {"created_at", 100000.0 - n},
                {"proposed_text", QString("候选 %1").arg(n)}, {"source_text", "用户原话"}, {"status", "pending"}});
        return rows;
    }
    static QJsonObject candidatePage(const QJsonArray &rows, bool more = false,
                                     const QString &cursor = {}) {
        return {{"ok", true}, {"status", "pending"}, {"candidates", rows}, {"has_more", more},
                {"next_cursor", more ? QJsonValue(cursor) : QJsonValue(QJsonValue::Null)}};
    }
    void deliverCandidate(const QJsonObject &payload, const QString &requestId = {}) {
        const auto id = requestId.isEmpty()
            ? lastRendererCommand("memory:candidates:list")["request_id"].toString() : requestId;
        m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", id}, {"payload", payload}});
    }
    void deliverConfirmed() {
        const auto id = lastRendererCommand("memory:list")["request_id"].toString();
        m_bridge->event({{"type", "memory:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", true}, {"memories", QJsonArray{}},
                {"has_more", false}, {"next_cursor", QJsonValue::Null}, {"query", m_bridge->memoryQuery()}}}});
    }
    bool selectMemoryCandidatesPage() {
        if (!m_panel || !m_panel->setProperty("page", "memory"))
            return false;
        auto *tabs = m_panel->findChild<QQuickItem *>("memoryTabs");
        return tabs && tabs->setProperty("currentIndex", 0);
    }
    static void setCandidateFocusWindow(QWindow *window) {
        // Match ShortcutActivationTest's offscreen window-system fixture.
        QWindowSystemInterface::handleFocusWindowChanged<QWindowSystemInterface::SynchronousDelivery>(
            window, Qt::ActiveWindowFocusReason);
    }
    QJsonObject rendererCommandAt(const QString &command, int ordinal) const {
        for (const auto &frame : m_frames) {
            const auto envelope = frame["envelope"].toObject();
            if (envelope["command"].toString() == command && ordinal-- == 0)
                return envelope;
        }
        return {};
    }
    CandidateBaseline candidateBaseline(const QString &actionCommand) const {
        return {actionCommand, lastRendererCommand(actionCommand)["request_id"].toString(),
            lastRendererCommand("memory:list")["request_id"].toString(),
            lastRendererCommand("memory:candidates:list")["request_id"].toString(),
            rendererCommandCount(actionCommand), rendererCommandCount("memory:list"),
            rendererCommandCount("memory:candidates:list")};
    }
    void deliverCandidateConfirmed(const QString &id) {
        m_bridge->event({{"type", "memory:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", true}, {"memories", QJsonArray{}},
                {"has_more", false}, {"next_cursor", QJsonValue::Null}, {"query", m_bridge->memoryQuery()}}}});
    }
    static QJsonValue candidateNumber(qreal value) {
        return std::isfinite(value) ? QJsonValue(value) : QJsonValue(QJsonValue::Null);
    }
    static QJsonObject candidateRect(const QRectF &rect) {
        return {{"x", candidateNumber(rect.x())}, {"y", candidateNumber(rect.y())},
            {"width", candidateNumber(rect.width())}, {"height", candidateNumber(rect.height())}};
    }
    CandidateObservation observeCandidateTarget(const CandidateTarget &target) const {
        CandidateObservation out;
        int matches = 0;
        if (target.rowId.isEmpty()) {
            QList<QQuickItem *> found;
            visualMatches(m_panel, target.name, found);
            matches = found.size();
            if (matches == 1)
                out.item = found.first();
        } else {
            const auto row = MemoryActionProbe::findRow(m_panel, target.rowId);
            if (row.valid() && row.id == target.rowId) {
                out.row = row.item;
                out.index = row.index;
                out.item = MemoryActionProbe::rowControl(row, target.name);
                matches = out.item ? 1 : 0;
            }
        }
        const bool bound = out.item && m_panel && m_window &&
            out.item->window() == m_window.get() && m_panel->window() == m_window.get() &&
            (out.item == m_panel || m_panel->isAncestorOf(out.item)) &&
            m_window->contentItem()->isAncestorOf(m_panel);
        bool measured = bound && std::isfinite(out.item->width()) && std::isfinite(out.item->height()) &&
            out.item->width() > 0 && out.item->height() > 0;
        if (measured) {
            const auto center = out.item->mapToScene(QPointF(out.item->width() / 2, out.item->height() / 2));
            out.scene = out.item->mapRectToScene(QRectF(QPointF(), out.item->size()));
            out.clip = out.scene & QRectF(QPointF(), QSizeF(m_window->size()));
            measured = std::isfinite(center.x()) && std::isfinite(center.y()) &&
                MemoryActionProbe::detail::finite(out.scene);
            if (measured)
                out.point = center.toPoint();
            for (auto *parent = out.item->parentItem(); parent; parent = parent->parentItem()) {
                if (!parent->clip())
                    continue;
                const auto clip = parent->mapRectToScene(QRectF(QPointF(), parent->size()));
                out.clips.append({parent, clip});
                measured = measured && MemoryActionProbe::detail::finite(clip);
                out.clip &= clip;
            }
            measured = measured && MemoryActionProbe::detail::finite(out.clip);
        }
        const bool inside = measured && !out.clip.isEmpty() &&
            QRect(QPoint(), m_window->size()).contains(out.point) && out.clip.contains(QPointF(out.point)) &&
            out.item->contains(out.item->mapFromScene(QPointF(out.point)));
        out.eligible = bound && measured && inside && out.item->isVisible() && out.item->isEnabled();
        out.metadata = {{"name", target.name.left(80)}, {"rowId", target.rowId}, {"rowIndex", out.index},
            {"objectName", out.item ? out.item->objectName().left(80) : QString()}, {"matches", matches},
            {"class", out.item ? QString::fromLatin1(out.item->metaObject()->className()).left(80) : QString()},
            {"bound", bound}, {"visible", out.item && out.item->isVisible()},
            {"enabled", out.item && out.item->isEnabled()}, {"geometryMeasured", measured},
            {"scene", measured ? candidateRect(out.scene) : QJsonObject()},
            {"clip", measured ? candidateRect(out.clip) : QJsonObject()},
            {"pointX", measured ? QJsonValue(out.point.x()) : QJsonValue(QJsonValue::Null)},
            {"pointY", measured ? QJsonValue(out.point.y()) : QJsonValue(QJsonValue::Null)},
            {"integerPointInsideClip", inside}, {"clipCount", out.clips.size()}, {"eligible", out.eligible}};
        return out;
    }
    static bool sameCandidateTarget(const CandidateObservation &a, const CandidateObservation &b) {
        if (!a.eligible || !b.eligible || a.item != b.item || a.row != b.row || a.index != b.index ||
            a.point != b.point || a.scene != b.scene || a.clip != b.clip || a.clips.size() != b.clips.size())
            return false;
        for (qsizetype index = 0; index < a.clips.size(); ++index)
            if (!a.clips[index].first || a.clips[index] != b.clips[index])
                return false;
        return true;
    }
    static CandidateHandlerPoint observeCandidateHandlerPoint(QObject *observer) {
        CandidateHandlerPoint out;
        const auto value = observer ? observer->property("point") : QVariant();
        const auto *meta = value.metaType().metaObject();
        const auto read = [&](const char *name) {
            const int index = meta ? meta->indexOfProperty(name) : -1;
            return index >= 0 ? meta->property(index).readOnGadget(value.constData()) : QVariant();
        };
        const auto id = read("id"), scene = read("scenePosition"), buttons = read("pressedButtons");
        bool idOk = false, buttonsOk = false;
        out.id = id.toInt(&idOk);
        out.pressedButtons = buttons.toInt(&buttonsOk);
        out.scene = scene.toPointF();
        out.measured = value.isValid() && idOk && buttonsOk && scene.canConvert<QPointF>() &&
            std::isfinite(out.scene.x()) && std::isfinite(out.scene.y());
        out.metadata = {{"measured", out.measured}, {"id", out.measured ? QJsonValue(out.id) : QJsonValue(QJsonValue::Null)},
            {"pressedButtons", out.measured ? QJsonValue(out.pressedButtons) : QJsonValue(QJsonValue::Null)},
            {"sceneX", out.measured ? candidateNumber(out.scene.x()) : QJsonValue(QJsonValue::Null)},
            {"sceneY", out.measured ? candidateNumber(out.scene.y()) : QJsonValue(QJsonValue::Null)},
            {"pointX", out.measured ? QJsonValue(out.scene.toPoint().x()) : QJsonValue(QJsonValue::Null)},
            {"pointY", out.measured ? QJsonValue(out.scene.toPoint().y()) : QJsonValue(QJsonValue::Null)},
            // QQuickHandlerPoint has no timestamp property in the fixed Qt.
            {"timestampKnown", false}, {"timestampMs", QJsonValue::Null}};
        return out;
    }
    static QJsonObject candidateEventPoint(const QEventPoint &point) {
        QString state = "Unknown";
        if (point.state() == QEventPoint::Pressed) state = "Pressed";
        else if (point.state() == QEventPoint::Released) state = "Released";
        else if (point.state() == QEventPoint::Updated) state = "Updated";
        else if (point.state() == QEventPoint::Stationary) state = "Stationary";
        const auto scene = point.scenePosition();
        const bool measured = std::isfinite(scene.x()) && std::isfinite(scene.y());
        return {{"state", state}, {"id", point.id()}, {"sceneMeasured", measured},
            {"sceneX", measured ? candidateNumber(scene.x()) : QJsonValue(QJsonValue::Null)},
            {"sceneY", measured ? candidateNumber(scene.y()) : QJsonValue(QJsonValue::Null)},
            {"pointX", measured ? QJsonValue(scene.toPoint().x()) : QJsonValue(QJsonValue::Null)},
            {"pointY", measured ? QJsonValue(scene.toPoint().y()) : QJsonValue(QJsonValue::Null)},
            {"timestampKnown", point.timestamp() != 0},
            {"timestampMs", point.timestamp() ? QJsonValue(qint64(point.timestamp())) : QJsonValue(QJsonValue::Null)}};
    }
    CandidatePointerObjects observeCandidatePointerObjects() const {
        CandidatePointerObjects out;
        QList<QQuickItem *> layers;
        if (m_window)
            visualMatches(m_window->contentItem(), "candidatePointerObservationLayer", layers);
        if (layers.size() == 1) {
            out.layer = layers.first();
            const auto observers = out.layer->findChildren<QObject *>("candidatePointerObserver");
            if (observers.size() == 1)
                out.observer = observers.first();
        }
        const bool bound = m_window && out.layer && out.observer &&
            out.layer->window() == m_window.get() && out.layer->parentItem() == m_window->contentItem() &&
            out.observer->property("parent").value<QQuickItem *>() == out.layer;
        if (bound)
            out.scene = out.layer->mapRectToScene(QRectF(QPointF(), out.layer->size()));
        const bool bounds = bound && MemoryActionProbe::detail::finite(out.scene) &&
            out.scene == QRectF(QPointF(), QSizeF(m_window->size()));
        out.eligible = bounds && out.layer->isVisible() && out.layer->isEnabled() &&
            out.layer->z() >= 1000000 && !out.layer->hasFocus() && !out.layer->hasActiveFocus() &&
            !out.layer->activeFocusOnTab() && out.observer->property("enabled").toBool() &&
            (out.observer->property("acceptedButtons").toInt() & int(Qt::LeftButton)) &&
            !out.observer->property("target").value<QObject *>();
        out.metadata = {{"layerMatches", layers.size()}, {"bound", bound}, {"windowBounds", bounds},
            {"scene", bounds ? candidateRect(out.scene) : QJsonObject()}, {"eligible", out.eligible},
            {"observerPresent", bool(out.observer)}, {"observerEnabled", out.observer && out.observer->property("enabled").toBool()},
            {"observerActive", out.observer && out.observer->property("active").toBool()}};
        return out;
    }
    CandidateObservation observeCandidateScrollBlank() const {
        auto out = observeCandidateTarget({"memoryPageScroll", {}});
        out.metadata["name"] = "memoryPageScrollBlank";
        bool found = false;
        QPoint point;
        const QStringList controls{"memoryCandidateFirst", "memoryCandidateNext", "memoryFilterField",
            "memoryFilterApply", "memoryFilterClear", "memoryRefresh"};
        if (out.eligible) {
            // Choose geometry only. No candidate point is clicked during this
            // search, and every later observation must retain this integer point.
            for (int y = int(out.clip.bottom()) - 24; y > int(out.clip.top()) + 24 && !found; y -= 16) {
                const QPoint candidate(int(out.clip.right()) - 28, y);
                if (!out.clip.contains(QPointF(candidate)))
                    continue;
                bool occupied = false;
                for (const auto &name : controls) {
                    auto *item = profileItem(name, ProfileScope::Page);
                    occupied = occupied || (item && item->isVisible() &&
                        item->mapRectToScene(QRectF(QPointF(), item->size())).contains(candidate));
                }
                const auto rows = m_bridge->state().value("candidates").toMap().value("candidates").toList();
                for (const auto &value : rows) {
                    const auto row = MemoryActionProbe::findRow(m_panel, value.toMap().value("id").toString());
                    for (const auto &name : {"memoryCandidateConfirm", "memoryCandidateReject"}) {
                        auto *item = MemoryActionProbe::rowControl(row, name);
                        occupied = occupied || (item && item->isVisible() &&
                            item->mapRectToScene(QRectF(QPointF(), item->size())).contains(candidate));
                    }
                }
                if (!occupied && out.item->contains(out.item->mapFromScene(candidate))) {
                    point = candidate;
                    found = true;
                }
            }
        }
        out.point = point;
        out.eligible = out.eligible && found && QRect(QPoint(), m_window->size()).contains(point);
        out.metadata["blankPointFound"] = found;
        out.metadata["pointX"] = found ? QJsonValue(point.x()) : QJsonValue(QJsonValue::Null);
        out.metadata["pointY"] = found ? QJsonValue(point.y()) : QJsonValue(QJsonValue::Null);
        out.metadata["integerPointInsideClip"] = out.eligible;
        out.metadata["eligible"] = out.eligible;
        return out;
    }
    QJsonArray candidateBlankGeometryHits(const QPoint &point) const {
        QJsonArray hits;
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *content = scroll ? scroll->property("contentItem").value<QQuickItem *>() : nullptr;
        auto *region = profileItem("memoryCandidateRegion", ProfileScope::Page);
        const QStringList allowed{"candidatePointerObservationLayer", "memoryPageScroll", "memoryCandidateRegion",
            "memoryCandidateFirst", "memoryCandidateNext", "memoryFilterField", "memoryFilterApply",
            "memoryFilterClear", "memoryRefresh", "memoryCandidateConfirm", "memoryCandidateReject"};
        for (const auto &[scope, root] : QList<QPair<QString, QQuickItem *>>{
                 {"window", m_window ? m_window->contentItem() : nullptr}, {"scroll", scroll},
                 {"scroll-content", content}, {"candidate-region", region}}) {
            auto *hit = root ? root->childAt(root->mapFromScene(point).x(), root->mapFromScene(point).y()) : nullptr;
            const auto name = hit ? hit->objectName() : QString();
            hits.append(QJsonObject{{"scope", scope}, {"geometryHit", !hit ? QString("none") :
                allowed.contains(name) ? name : name.isEmpty() ? QString("unnamed-item") : QString("other-named-item")}});
        }
        return hits;
    }
    static QString candidateStatus(const QString &status) {
        return QStringList{"none", "pending", "success", "error", "unknown", "refreshed",
            "sending", "reading", "reconciling"}.contains(status) ? status : QString("invalid");
    }
    static QString candidateDigest(const QString &cursor) {
        return QString::fromLatin1(QCryptographicHash::hash(cursor.toUtf8(), QCryptographicHash::Sha256).toHex());
    }
    QVariantMap candidateFocusContext() const {
        auto context = m_panel ? m_panel->property("candidateFocusContext") : QVariant();
        if (context.metaType() == QMetaType::fromType<QJSValue>())
            context = context.value<QJSValue>().toVariant();
        return context.toMap();
    }
    static QString candidateCancelReason(const QString &reason) {
        return QStringList{"", "superseded", "press-canceled", "no-request", "input", "focus", "page",
            "hidden", "inactive", "scope", "disconnected", "not-live", "receipt", "terminal-blocked"}
            .contains(reason) ? reason : QString("invalid");
    }
    QString candidateFocusContainer(QQuickItem *active) const {
        if (!active)
            return "none";
        auto *region = profileItem("memoryCandidateRegion", ProfileScope::Page);
        auto *field = profileItem("memoryFilterField", ProfileScope::Page);
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *scrollContent = scroll ? scroll->property("contentItem").value<QQuickItem *>() : nullptr;
        if (active == scroll) return "memory-page-scroll";
        if (active == scrollContent) return "memory-page-content";
        if (active == region) return "candidate-region";
        if (region && region->isAncestorOf(active)) return "candidate-control";
        if (active == field || (field && field->isAncestorOf(active))) return "filter";
        if (m_window && active == m_window->contentItem()) return "window-content";
        if (m_panel && active == m_panel) return "task-panel";
        if (m_panel && m_panel->isAncestorOf(active)) return "other-panel-item";
        return "outside-panel";
    }
    bool candidateFocusBoundTo(const CandidateInput &input, const QString &kind) {
        const auto context = candidateFocusContext();
        const auto idKey = kind == "confirm" || kind == "reject" ? "actionRequestId" : "candidateReadId";
        if (!m_panel->property("candidateFocusEligible").toBool() ||
            !m_panel->property("candidateFocusPending").toBool() ||
            m_panel->property("candidateFocusPrepared").toBool() ||
            context.value("phase").toString() != "committed" || context.value("kind").toString() != kind ||
            context.value("targetId").toString() != input.envelope["payload"].toObject()["candidate_id"].toString() ||
            context.value(idKey).toString() != input.requestId ||
            context.value("scopeKey").toString() != m_bridge->scopeKey() ||
            context.value("serial").toULongLong() != m_panel->property("candidateFocusSerial").toULongLong())
            return candidateFailure("focus-qualification", "current-operation-focus-context");
        return true;
    }
    bool candidateFocusOwnReads(const CandidateInput &input, const CandidateReads &reads, const QString &kind) {
        if (!candidateFocusBoundTo(input, kind))
            return false;
        const auto context = candidateFocusContext();
        if (context.value("listReadId").toString() != reads.listId ||
            context.value("candidateReadId").toString() != reads.candidateId ||
            !context.value("actionSucceeded").toBool())
            return candidateFailure("focus-qualification", "current-operation-read-identities");
        return true;
    }
    QJsonObject candidateTraceState() const {
        const auto feedback = m_bridge ? m_bridge->memoryFeedback() : QVariantMap{};
        const auto receipt = [&](const QString &key) {
            const auto value = feedback.value(key).toMap();
            return QJsonObject{{"requestId", value.value("requestId").toString()},
                {"status", candidateStatus(value.value("status", "none").toString())}};
        };
        const auto commands = [&](const QString &command) {
            return QJsonObject{{"command", command}, {"count", rendererCommandCount(command)},
                {"requestId", lastRendererCommand(command)["request_id"].toString()}};
        };
        auto *active = m_window ? m_window->activeFocusItem() : nullptr;
        auto *region = m_panel ? m_panel->findChild<QQuickItem *>("memoryCandidateRegion") : nullptr;
        auto *field = m_panel ? m_panel->findChild<QQuickItem *>("memoryFilterField") : nullptr;
        QString focusRegion = "none";
        if (active) {
            if (active == region || (region && region->isAncestorOf(active))) focusRegion = "candidate";
            else if (active == field || (field && field->isAncestorOf(active))) focusRegion = "filter";
            else if (m_window && active == m_window->contentItem()) focusRegion = "content";
            else if (m_panel && (active == m_panel || m_panel->isAncestorOf(active))) focusRegion = "panel";
            else focusRegion = "outside";
        }
        auto *first = m_panel ? m_panel->findChild<QQuickItem *>("memoryCandidateFirst") : nullptr;
        const auto focusContext = candidateFocusContext();
        QJsonObject context;
        // Never serialize the source QObject, scope text, or any row body.
        for (const auto &key : {"serial", "phase", "kind", "targetId", "startRevision", "actionRequestId",
                                "listReadId", "candidateReadId", "actionSucceeded", "ready"})
            context[QLatin1String(key)] = QJsonValue::fromVariant(focusContext.value(QLatin1String(key)));
        context["sourcePresent"] = focusContext.value("source").value<QObject *>() != nullptr;
        context["scopeMatches"] = !focusContext.isEmpty() && m_bridge &&
            focusContext.value("scopeKey").toString() == m_bridge->scopeKey();
        const auto currentPage = m_bridge ? m_bridge->memoryCandidatePage() : QVariantMap{};
        QJsonObject page;
        for (const auto &key : {"pageNumber", "count", "hasMore", "live", "busy", "decisionBusy", "blocked",
                                "needsRefresh", "revision", "readRequestId"})
            page[QLatin1String(key)] = QJsonValue::fromVariant(currentPage.value(QLatin1String(key)));
        page["readKind"] = m_bridge ? m_bridge->m_candidateReadKind : QString();
        page["decisionStatus"] = m_bridge
            ? candidateStatus(m_bridge->m_candidateDecision.value("status", "none").toString()) : QString("none");
        page["startCursorDigest"] = m_bridge ? QJsonValue(candidateDigest(m_bridge->m_candidateStartCursor)) : QJsonValue(QJsonValue::Null);
        page["readStartCursorDigest"] = m_bridge ? QJsonValue(candidateDigest(m_bridge->m_candidateReadStartCursor)) : QJsonValue(QJsonValue::Null);
        page["nextCursorDigest"] = m_bridge ? QJsonValue(candidateDigest(m_bridge->m_candidateNextCursor)) : QJsonValue(QJsonValue::Null);
        return {{"elapsedMs", m_candidateElapsed.isValid() ? QJsonValue(m_candidateElapsed.elapsed()) : QJsonValue(QJsonValue::Null)},
            {"elapsedMeasured", m_candidateElapsed.isValid()}, {"frameSerial", qint64(m_candidateFrameSerial)},
            {"failureObservation", m_candidateFailureObservation},
            {"objects", QJsonObject{{"bridgePresent", bool(m_bridge)}, {"windowPresent", bool(m_window)},
                {"panelPresent", m_panel != nullptr}}},
            {"target", observeCandidateTarget(m_candidateTarget).metadata},
            {"physicalClicks", m_candidatePhysicalClicks}, {"physicalClickedSignals", m_candidatePhysicalSignals},
            {"physicalKeyActivations", m_candidatePhysicalKeys}, {"focusTransfers", m_candidateFocusTransfers},
            {"syntheticSignals", m_candidateSyntheticSignals},
            {"preArmPhysicalClicks", m_candidatePreArmClicks}, {"preArmPhysicalClickedSignals", m_candidatePreArmSignals},
            {"preArmSyntheticSignals", m_candidatePreArmSynthetic},
            {"physicalClicksSinceArm", m_candidatePhysicalClicks - m_candidatePreArmClicks},
            {"physicalKeyActivationsSinceArm", m_candidatePhysicalKeys - m_candidatePreArmKeys},
            {"physicalClickedSignalsSinceArm", m_candidatePhysicalSignals - m_candidatePreArmSignals},
            {"syntheticSignalsSinceArm", m_candidateSyntheticSignals - m_candidatePreArmSynthetic},
            {"inputBudgetMs", m_candidateInputBudgetMs}, {"stableSinceMs", m_candidateStableSinceMs},
            {"qualifiedAtMs", m_candidateQualifiedAtMs},
            {"stableFrameSerial", qint64(m_candidateStableFrameSerial)},
            {"qualifiedFrameSerial", qint64(m_candidateQualifiedFrameSerial)},
            {"blankInput", m_candidateBlankInput}, {"hiddenKeyInput", m_candidateHiddenKeyInput},
            {"commands", QJsonObject{{"action", commands(m_candidateActionCommand)},
                {"list", commands("memory:list")}, {"candidates", commands("memory:candidates:list")}}},
            {"baseline", QJsonObject{{"actionId", m_candidateBaseline.actionId},
                {"listId", m_candidateBaseline.listId}, {"candidateId", m_candidateBaseline.candidateId},
                {"actionCount", m_candidateBaseline.actionCount}, {"listCount", m_candidateBaseline.listCount},
                {"candidateCount", m_candidateBaseline.candidateCount}}},
            {"receipts", QJsonObject{{"action", receipt("action")}, {"list", receipt("list")},
                {"candidates", receipt("candidates")}}}, {"page", page},
            {"candidateFocusEligible", m_panel && m_panel->property("candidateFocusEligible").toBool()},
            {"candidateFocusPrepared", m_panel && m_panel->property("candidateFocusPrepared").toBool()},
            {"candidateFocusPending", m_panel && m_panel->property("candidateFocusPending").toBool()},
            {"candidateWasBusy", m_panel && m_panel->property("candidateWasBusy").toBool()},
            {"candidateFocusContext", context},
            {"candidateFocusSerial", m_panel ? QJsonValue::fromVariant(m_panel->property("candidateFocusSerial")) : QJsonValue(QJsonValue::Null)},
            {"candidateFocusCancelReason", candidateCancelReason(m_panel ? m_panel->property("candidateFocusCancelReason").toString() : QString())},
            {"windowVisible", m_window && m_window->isVisible()}, {"windowActive", m_window && m_window->isActive()},
            {"focusWindowMatches", m_window && QGuiApplication::focusWindow() == m_window.get()},
            {"focusWindowNull", QGuiApplication::focusWindow() == nullptr},
            {"activeFocusItem", QJsonObject{{"name", active ? active->objectName().left(80) : QString()},
                {"class", active ? QString::fromLatin1(active->metaObject()->className()).left(80) : QString()},
                {"region", focusRegion}, {"container", candidateFocusContainer(active)}}},
            {"first", QJsonObject{{"visible", first && first->isVisible()}, {"enabled", first && first->isEnabled()},
                {"focus", first && first->hasActiveFocus()}}},
            {"failureLayer", m_candidateFailureLayer}, {"failureReason", m_candidateFailureReason}};
    }
    void emitCandidateSnapshot(const QString &stage, bool fixed) {
        auto state = candidateTraceState();
        state["stage"] = stage;
        state["kind"] = fixed ? "fixed" : "change";
        state["fixedSnapshots"] = m_candidateFixedStages.size();
        state["changeSnapshots"] = m_candidateChangeSnapshots;
        state["changeOverflow"] = m_candidateChangeOverflow;
        if (stage == "terminal") {
            state["outcome"] = QTest::currentTestFailed() ? "body-failed" : "body-passed";
            if (QTest::currentTestFailed() && m_candidateFailureLayer.isEmpty())
                state["failureLayer"] = m_candidateLayer;
        }
        qInfo().noquote() << "CANDIDATE_FIXTURE" << compactDiagnostic(state);
    }
    void candidateFixedStage(const QString &stage) {
        if (!m_candidateTraceArmed || m_candidateFixedStages.contains(stage) ||
            !QStringList{"arm", "qualified", "input", "readback", "settled", "terminal"}.contains(stage))
            return;
        m_candidateFixedStages.append(stage);
        if (stage == "terminal") {
            // Select bounded semantic evidence while notifications are live,
            // then publish it in observed order before object destruction.
            while (!m_candidateChanges.isEmpty()) {
                int earliest = 0;
                for (int index = 1; index < m_candidateChanges.size(); ++index)
                    if (m_candidateChanges[index].ordinal < m_candidateChanges[earliest].ordinal)
                        earliest = index;
                auto change = m_candidateChanges.takeAt(earliest);
                change.state["stage"] = "state-change";
                change.state["kind"] = "change";
                change.state["semantic"] = change.semantic;
                change.state["observationSerial"] = qint64(change.ordinal);
                change.state["fixedSnapshots"] = m_candidateFixedStages.size();
                change.state["changeSnapshots"] = m_candidateChangeSnapshots;
                change.state["changeOverflow"] = m_candidateChangeOverflow;
                qInfo().noquote() << "CANDIDATE_FIXTURE" << compactDiagnostic(change.state);
            }
        }
        emitCandidateSnapshot(stage, true);
    }
    void candidateObserveChange() {
        if (!m_candidateTraceArmed)
            return;
        const auto observed = candidateTraceState();
        auto state = observed;
        for (const auto &key : {"elapsedMs", "frameSerial", "inputBudgetMs", "stableSinceMs", "qualifiedAtMs",
                                "stableFrameSerial", "qualifiedFrameSerial"})
            state.remove(QLatin1String(key));
        const auto next = compactDiagnostic(state);
        if (next == m_candidateLastChange)
            return;
        m_candidateLastChange = next;
        const auto prior = m_candidateLastSemantic;
        m_candidateLastSemantic = state;
        const auto context = state["candidateFocusContext"].toObject();
        const auto oldContext = prior["candidateFocusContext"].toObject();
        const auto receipts = state["receipts"].toObject();
        const auto listReceipt = receipts["list"].toObject(), candidateReceipt = receipts["candidates"].toObject();
        const auto actionReceipt = receipts["action"].toObject();
        const auto commands = state["commands"].toObject(), baseline = state["baseline"].toObject();
        const auto listReadId = context["listReadId"].toString(), candidateReadId = context["candidateReadId"].toString();
        const auto actionRequestId = context["actionRequestId"].toString();
        const bool ownCurrentReads = context["phase"].toString() == "committed" && context["actionSucceeded"].toBool() &&
            !actionRequestId.isEmpty() && actionRequestId != baseline["actionId"].toString() &&
            actionRequestId == actionReceipt["requestId"].toString() && actionReceipt["status"].toString() == "success" &&
            actionRequestId == commands["action"].toObject()["requestId"].toString() &&
            !listReadId.isEmpty() && !candidateReadId.isEmpty() && listReadId != candidateReadId &&
            listReadId != baseline["listId"].toString() && candidateReadId != baseline["candidateId"].toString() &&
            listReadId == listReceipt["requestId"].toString() && candidateReadId == candidateReceipt["requestId"].toString() &&
            listReadId == commands["list"].toObject()["requestId"].toString() &&
            candidateReadId == commands["candidates"].toObject()["requestId"].toString();
        const bool exactlyOneOwnReadSucceeded =
            (listReceipt["status"].toString() == "success" && candidateReceipt["status"].toString() == "pending") ||
            (candidateReceipt["status"].toString() == "success" && listReceipt["status"].toString() == "pending");
        QString semantic = "operation-state";
        int priority = 10;
        if (state["focusTransfers"].toInt() != prior["focusTransfers"].toInt()) {
            semantic = "focus-transfer";
            priority = 120;
        } else if (state["candidateFocusEligible"].toBool() && !prior["candidateFocusEligible"].toBool()) {
            semantic = "eligibility-established";
            priority = 110;
        } else if ((!state["candidateFocusEligible"].toBool() && prior["candidateFocusEligible"].toBool()) ||
                   (state["candidateFocusCancelReason"].toString() != prior["candidateFocusCancelReason"].toString() &&
                    !state["candidateFocusCancelReason"].toString().isEmpty())) {
            semantic = "intent-revoked";
            priority = 115;
        } else if (context["phase"].toString() == "committed" &&
                   (context["actionRequestId"] != oldContext["actionRequestId"] ||
                    context["candidateReadId"] != oldContext["candidateReadId"] ||
                    context["listReadId"] != oldContext["listReadId"])) {
            semantic = "operation-bound";
            priority = 105;
        } else if (state["candidateFocusPending"].toBool() && !prior["candidateFocusPending"].toBool()) {
            semantic = "intent-established";
            priority = 100;
        } else if (state["candidateFocusPending"].toBool() && state["page"].toObject()["busy"].toBool() &&
                   ownCurrentReads && exactlyOneOwnReadSucceeded) {
            semantic = "partial-success-intent-retained";
            priority = 95;
        } else if (context["ready"].toBool() && !oldContext["ready"].toBool()) {
            semantic = "completion-ready";
            priority = 90;
        }
        const CandidateChange change{semantic, observed, priority, ++m_candidateObservationSerial};
        for (auto &saved : m_candidateChanges) {
            if (saved.semantic == semantic) {
                saved = change;
                ++m_candidateChangeOverflow;
                return;
            }
        }
        if (m_candidateChanges.size() < 6) {
            m_candidateChanges.append(change);
            m_candidateChangeSnapshots = m_candidateChanges.size();
            return;
        }
        int least = 0;
        for (int index = 1; index < m_candidateChanges.size(); ++index)
            if (m_candidateChanges[index].priority < m_candidateChanges[least].priority)
                least = index;
        if (priority > m_candidateChanges[least].priority)
            m_candidateChanges[least] = change;
        ++m_candidateChangeOverflow;
    }
    void trackCandidateFrames() {
        if (!m_window || m_candidateFrameConnection)
            return;
        m_candidateFrameConnection = connect(m_window.get(), &QQuickWindow::frameSwapped, this,
            [this, window = QPointer<QQuickWindow>(m_window.get())] {
            if (window && window == m_window.get())
                ++m_candidateFrameSerial;
        }, Qt::QueuedConnection);
    }
    void armCandidateTrace(const CandidateTarget &target, const QString &actionCommand = {}) {
        if (m_candidateTraceArmed) {
            candidateFailure("diagnostic-contract", "trace-already-armed");
            return;
        }
        m_candidatePreArmClicks = m_candidatePhysicalClicks;
        m_candidatePreArmSignals = m_candidatePhysicalSignals;
        m_candidatePreArmSynthetic = m_candidateSyntheticSignals;
        m_candidatePreArmKeys = m_candidatePhysicalKeys;
        m_candidateFixedStages.clear();
        m_candidateChangeSnapshots = m_candidateChangeOverflow = 0;
        m_candidateChanges.clear();
        m_candidateLastSemantic = {};
        m_candidateObservationSerial = 0;
        m_candidateFocusTransfers = 0;
        m_candidateFailureLayer.clear();
        m_candidateFailureReason.clear();
        m_candidateDiagnostic.clear();
        m_candidateInputBudgetMs = 0;
        m_candidateBlankInput = {};
        m_candidateHiddenKeyInput = {};
        m_candidateStableSinceMs = m_candidateQualifiedAtMs = -1;
        m_candidateStableFrameSerial = m_candidateQualifiedFrameSerial = 0;
        m_candidateTraceArmed = true;
        m_candidateFailureObservation = false;
        m_candidateElapsed.start();
        m_candidateTarget = target;
        m_candidateActionCommand = actionCommand;
        m_candidateBaseline = candidateBaseline(actionCommand);
        m_candidateLayer = "fixture";
        trackCandidateFrames();
        m_candidateBridgeConnection = connect(m_bridge.get(), &RuntimeBridge::changed, this,
            &RuntimeBridgeTest::candidateObserveChange);
        m_candidateFocusConnection = connect(m_window.get(), &QQuickWindow::activeFocusItemChanged, this, [this] {
            if (auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
                first && m_window->activeFocusItem() == first && !m_candidateInputDelivery)
                ++m_candidateFocusTransfers;
            candidateObserveChange();
        });
        m_candidateActiveConnection = connect(m_window.get(), &QWindow::activeChanged, this,
            &RuntimeBridgeTest::candidateObserveChange);
        m_candidateFocusObserver = std::make_unique<CandidateFocusObserver>();
        m_candidateFocusObserver->observe = [this] { candidateObserveChange(); };
        const auto changed = m_candidateFocusObserver->metaObject()->method(
            m_candidateFocusObserver->metaObject()->indexOfSlot("changed()"));
        for (const auto &name : {"candidateFocusEligible", "candidateFocusPrepared", "candidateFocusPending",
                                "candidateWasBusy", "candidateFocusContext", "candidateFocusSerial", "candidateFocusCancelReason"}) {
            const auto index = m_panel->metaObject()->indexOfProperty(name);
            const auto property = m_panel->metaObject()->property(index);
            if (index < 0 || !property.hasNotifySignal()) {
                candidateFailure("diagnostic-contract", "candidate-property-notify-missing");
                continue;
            }
            m_candidatePropertyConnections.append(connect(m_panel, property.notifySignal(),
                m_candidateFocusObserver.get(), changed, Qt::DirectConnection));
        }
        // Arm is the initial observation, rather than a duplicate change.
        auto initial = candidateTraceState();
        for (const auto &key : {"elapsedMs", "frameSerial", "inputBudgetMs", "stableSinceMs", "qualifiedAtMs",
                                "stableFrameSerial", "qualifiedFrameSerial"})
            initial.remove(QLatin1String(key));
        m_candidateLastChange = compactDiagnostic(initial);
        m_candidateLastSemantic = initial;
        candidateFixedStage("arm");
    }
    bool candidateFailure(const QString &layer, const QString &reason) {
        m_candidateFailureLayer = layer;
        m_candidateFailureReason = reason;
        m_candidateDiagnostic = compactDiagnostic({{"layer", layer}, {"reason", reason}});
        if (!m_candidateTraceArmed) {
            // A failed preparatory input gets one observation-only trace.
            // Preserve its clock, target, geometry and command baseline; do
            // not restart the input deadline or perform any further input.
            m_candidateTraceArmed = true;
            m_candidateFailureObservation = true;
            if (!m_candidateElapsed.isValid())
                m_candidateElapsed.start();
            m_candidatePreArmClicks = m_candidatePhysicalClicks;
            m_candidatePreArmSignals = m_candidatePhysicalSignals;
            m_candidatePreArmSynthetic = m_candidateSyntheticSignals;
            auto initial = candidateTraceState();
            for (const auto &key : {"elapsedMs", "frameSerial", "inputBudgetMs", "stableSinceMs", "qualifiedAtMs",
                                    "stableFrameSerial", "qualifiedFrameSerial"})
                initial.remove(QLatin1String(key));
            m_candidateLastChange = compactDiagnostic(initial);
            candidateFixedStage("arm");
        }
        candidateObserveChange();
        return false;
    }
    bool clickCandidateInput(const CandidateTarget &target, const QString &command, CandidateInput &input,
                             bool keyboard = false) {
        // One captured default budget covers layout qualification, one physical
        // click, and its own new command. It is never restarted or retried.
        const auto budget = QTest::defaultTryTimeout.load(std::memory_order_relaxed);
        const QDeadlineTimer deadline(budget, Qt::PreciseTimer);
        if (!m_candidateElapsed.isValid())
            m_candidateElapsed.start();
        trackCandidateFrames();
        QElapsedTimer elapsed;
        elapsed.start();
        m_candidateInputBudgetMs = qint64(budget.count());
        m_candidateStableSinceMs = -1;
        m_candidateQualifiedAtMs = -1;
        m_candidateStableFrameSerial = 0;
        m_candidateQualifiedFrameSerial = 0;
        m_candidateTarget = target;
        m_candidateLayer = "input-qualification";
        if (!m_candidateTraceArmed)
            m_candidateBaseline = candidateBaseline(m_candidateActionCommand);
        if (!m_bridge || !m_panel || !m_window)
            return candidateFailure("fixture-construction", "candidate-input-objects-missing");
        CandidateObservation anchor, accepted;
        qint64 anchoredAt = 0;
        quint64 anchoredFrame = 0;
        bool anchored = false;
        const bool ready = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            const auto current = observeCandidateTarget(target);
            candidateObserveChange();
            if (!current.eligible) {
                anchored = false;
            } else if (!anchored || !sameCandidateTarget(anchor, current)) {
                anchor = current;
                anchoredAt = elapsed.elapsed();
                anchoredFrame = m_candidateFrameSerial;
                m_candidateStableSinceMs = elapsed.elapsed();
                m_candidateStableFrameSerial = anchoredFrame;
                anchored = true;
            } else if (elapsed.elapsed() - anchoredAt >= 40 && m_candidateFrameSerial > anchoredFrame) {
                accepted = current;
                m_candidateQualifiedAtMs = elapsed.elapsed();
                m_candidateQualifiedFrameSerial = m_candidateFrameSerial;
                return !deadline.hasExpired();
            }
            m_window->update();
            return false;
        }, deadline);
        if (!ready || deadline.hasExpired())
            return candidateFailure("input-qualification", "stable-visible-target-deadline");
        // This lookup and comparison process no events and retain no raw
        // delegate across the wait. The integer hit point must still match.
        const auto fresh = observeCandidateTarget(target);
        if (!sameCandidateTarget(accepted, fresh))
            return candidateFailure("input-qualification", "fresh-target-changed");
        input.before = candidateBaseline(m_candidateActionCommand);
        m_candidateBaseline = input.before;
        const int beforeCount = rendererCommandCount(command);
        const auto oldId = lastRendererCommand(command)["request_id"].toString();
        QSignalSpy clicked(fresh.item, SIGNAL(clicked()));
        if (!clicked.isValid())
            return candidateFailure("input-delivery", "clicked-spy-invalid");
        candidateFixedStage("qualified");
        if (deadline.hasExpired())
            return candidateFailure("input-qualification", "deadline-before-input");
        if (keyboard) {
            if (!fresh.item->hasActiveFocus())
                return candidateFailure("input-delivery", "keyboard-source-not-focused");
            ++m_candidatePhysicalKeys;
            m_candidateInputDelivery = true;
            QTest::keyClick(m_window.get(), Qt::Key_Space, Qt::NoModifier, 0);
            m_candidateInputDelivery = false;
        } else {
            ++m_candidatePhysicalClicks;
            m_candidateInputDelivery = true;
            QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
            m_candidateInputDelivery = false;
        }
        m_candidatePhysicalSignals += clicked.count();
        candidateFixedStage("input");
        if (deadline.hasExpired())
            return candidateFailure("input-delivery", "deadline-after-input");
        if (clicked.count() != 1)
            return candidateFailure("input-delivery", "physical-clicked-signal-count");
        m_candidateLayer = "command-correlation";
        const bool dispatched = QTest::qWaitFor([&] {
            candidateObserveChange();
            return !deadline.hasExpired() && rendererCommandCount(command) > beforeCount;
        }, deadline);
        if (!dispatched || deadline.hasExpired())
            return candidateFailure("command-correlation", "new-command-deadline");
        if (rendererCommandCount(command) != beforeCount + 1)
            return candidateFailure("command-correlation", "new-command-count");
        input.envelope = rendererCommandAt(command, beforeCount);
        input.requestId = input.envelope["request_id"].toString();
        if (input.requestId.isEmpty() || input.requestId == oldId)
            return candidateFailure("command-correlation", "new-command-request-id");
        if (!target.rowId.isEmpty() && input.envelope["payload"].toObject()["candidate_id"].toString() != target.rowId)
            return candidateFailure("command-correlation", "new-command-candidate-identity");
        if (deadline.hasExpired())
            return candidateFailure("command-correlation", "deadline-after-correlation");
        return true;
    }
    bool waitForCandidateFrameAndPostedEvent() {
        const auto budget = QTest::defaultTryTimeout.load(std::memory_order_relaxed);
        const QDeadlineTimer deadline(budget, Qt::PreciseTimer);
        bool frameSeen = false, postedAfterFrame = false;
        QObject receiver;
        connect(m_window.get(), &QQuickWindow::frameSwapped, &receiver, [&] {
            if (frameSeen)
                return;
            frameSeen = true;
            QMetaObject::invokeMethod(&receiver, [&] { postedAfterFrame = true; }, Qt::QueuedConnection);
        }, Qt::QueuedConnection);
        const bool settled = QTest::qWaitFor([&] {
            candidateObserveChange();
            if (deadline.hasExpired())
                return false;
            if (frameSeen && postedAfterFrame)
                return true;
            m_window->update();
            return false;
        }, deadline);
        return settled && !deadline.hasExpired() ? true
            : candidateFailure("focus-event-barrier", "frame-and-posted-event-deadline");
    }
    bool clickCandidateScrollBlank(const CandidateInput &input, const QString &kind) {
        // One unchanged default deadline covers qualification, one press, its
        // actual receipts and revocation, and one release. No point is retried.
        const auto budget = QTest::defaultTryTimeout.load(std::memory_order_relaxed);
        const QDeadlineTimer deadline(budget, Qt::PreciseTimer);
        QElapsedTimer elapsed;
        elapsed.start();
        trackCandidateFrames();
        m_candidateLayer = "blank-input-qualification";
        m_candidateBlankInput = {{"budgetMs", qint64(budget.count())}, {"physicalPressAttempts", 0},
            {"physicalReleaseAttempts", 0}, {"windowPresses", 0}, {"windowReleases", 0},
            {"releasedBeforeInput", false}, {"pressProvenBeforeRelease", false}, {"completed", false}};
        if (!m_window || !m_panel || !m_bridge)
            return candidateFailure("fixture-construction", "blank-input-objects-missing");
        auto initialObjects = observeCandidatePointerObjects();
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *content = scroll ? scroll->property("contentItem").value<QQuickItem *>() : nullptr;
        const QPointer<QQuickItem> focusBefore = m_window->activeFocusItem();
        const auto initialPoint = observeCandidateHandlerPoint(initialObjects.observer);
        m_candidateBlankInput["observerBefore"] = initialObjects.metadata;
        m_candidateBlankInput["handlerPointBefore"] = initialPoint.metadata;
        if (!scroll || !content || !profileItem("memoryCandidateRegion", ProfileScope::Page) ||
            !initialObjects.eligible || (focusBefore != scroll && focusBefore != content))
            return candidateFailure("blank-input-qualification", "blank-input-container-or-observer");
        if (!candidateFocusBoundTo(input, kind))
            return false;
        const auto committedSerial = m_panel->property("candidateFocusSerial").toULongLong();
        const auto ownsCommittedContext = [&] {
            const auto context = candidateFocusContext();
            return context.value("phase").toString() == "committed" && context.value("kind").toString() == kind &&
                context.value("actionRequestId").toString() == input.requestId &&
                context.value("serial").toULongLong() == committedSerial &&
                m_panel->property("candidateFocusSerial").toULongLong() == committedSerial &&
                m_panel->property("candidateFocusEligible").toBool() &&
                m_panel->property("candidateFocusPending").toBool() &&
                !m_panel->property("candidateFocusPrepared").toBool();
        };
        const bool previouslyReleased = !initialObjects.observer->property("active").toBool() &&
            initialPoint.measured && initialPoint.pressedButtons == int(Qt::NoButton) &&
            QGuiApplication::mouseButtons() == Qt::NoButton;
        m_candidateBlankInput["releasedBeforeInput"] = previouslyReleased;
        m_candidateBlankInput["serialBefore"] = qint64(committedSerial);
        m_candidateBlankInput["committedBeforeInput"] = ownsCommittedContext();
        if (!previouslyReleased)
            return candidateFailure("blank-input-qualification", "previous-pointer-not-released");
        qRegisterMetaType<QEventPoint>();
        qRegisterMetaType<QPointingDevice::GrabTransition>();
        QSignalSpy active(initialObjects.observer, SIGNAL(activeChanged()));
        QSignalSpy point(initialObjects.observer, SIGNAL(pointChanged()));
        QSignalSpy grab(initialObjects.observer, SIGNAL(grabChanged(QPointingDevice::GrabTransition,QEventPoint)));
        if (!active.isValid() || !point.isValid() || !grab.isValid())
            return candidateFailure("blank-input-delivery", "pointer-observer-spy-invalid");
        CandidateObservation accepted, anchor;
        CandidatePointerObjects acceptedObjects, anchorObjects;
        int windowPresses = 0, windowReleases = 0, pressPointId = -1;
        ulong pressTimestamp = 0;
        const QPointingDevice *pressDevice = nullptr;
        bool windowPressMatches = false, windowReleaseMatches = false;
        CandidateWindowPointerObserver delivery(m_window.get());
        delivery.observe = [&](const QMouseEvent &event) {
            const auto eventPoint = event.points().constFirst();
            auto receipt = candidateEventPoint(eventPoint);
            receipt["button"] = int(event.button());
            receipt["pressedButtons"] = int(event.buttons());
            receipt["timestampKnown"] = event.timestamp() != 0;
            receipt["timestampMs"] = event.timestamp() ? QJsonValue(qint64(event.timestamp())) : QJsonValue(QJsonValue::Null);
            if (event.type() == QEvent::MouseButtonPress) {
                ++windowPresses;
                pressPointId = eventPoint.id();
                pressDevice = event.pointingDevice();
                pressTimestamp = event.timestamp();
                windowPressMatches = event.button() == Qt::LeftButton && event.buttons() == Qt::LeftButton &&
                    eventPoint.state() == QEventPoint::Pressed && eventPoint.scenePosition().toPoint() == accepted.point;
                receipt["matchesQualifiedInput"] = windowPressMatches;
                receipt["committedContextAtDelivery"] = ownsCommittedContext();
                m_candidateBlankInput["windowPress"] = receipt;
            } else {
                ++windowReleases;
                windowReleaseMatches = event.button() == Qt::LeftButton && event.buttons() == Qt::NoButton &&
                    eventPoint.state() == QEventPoint::Released && eventPoint.scenePosition().toPoint() == accepted.point &&
                    eventPoint.id() == pressPointId && event.pointingDevice() == pressDevice;
                receipt["matchesQualifiedInput"] = windowReleaseMatches;
                m_candidateBlankInput["windowRelease"] = receipt;
            }
            m_candidateBlankInput["windowPresses"] = windowPresses;
            m_candidateBlankInput["windowReleases"] = windowReleases;
        };
        bool anchored = false;
        qint64 anchoredAt = 0;
        quint64 anchoredFrame = 0;
        const bool qualified = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            const auto current = observeCandidateScrollBlank();
            const auto objects = observeCandidatePointerObjects();
            const auto handlerPoint = observeCandidateHandlerPoint(objects.observer);
            m_candidateBlankInput["geometry"] = current.metadata;
            const bool eligible = current.eligible && objects.eligible && objects.layer == initialObjects.layer &&
                objects.observer == initialObjects.observer && handlerPoint.measured &&
                handlerPoint.pressedButtons == int(Qt::NoButton) && !objects.observer->property("active").toBool() &&
                ownsCommittedContext() && m_window->activeFocusItem() == focusBefore && windowPresses == 0 && windowReleases == 0;
            if (!eligible) {
                anchored = false;
            } else if (!anchored || !sameCandidateTarget(anchor, current) ||
                       anchorObjects.layer != objects.layer || anchorObjects.observer != objects.observer ||
                       anchorObjects.scene != objects.scene) {
                anchor = current;
                anchorObjects = objects;
                anchoredAt = elapsed.elapsed();
                anchoredFrame = m_candidateFrameSerial;
                m_candidateBlankInput["stableSinceMs"] = anchoredAt;
                m_candidateBlankInput["stableFrameSerial"] = qint64(anchoredFrame);
                anchored = true;
            } else if (elapsed.elapsed() - anchoredAt >= 40 && m_candidateFrameSerial > anchoredFrame) {
                accepted = current;
                acceptedObjects = objects;
                m_candidateBlankInput["qualifiedAtMs"] = elapsed.elapsed();
                m_candidateBlankInput["qualifiedFrameSerial"] = qint64(m_candidateFrameSerial);
                return !deadline.hasExpired();
            }
            candidateObserveChange();
            m_window->update();
            return false;
        }, deadline);
        if (!qualified || deadline.hasExpired())
            return candidateFailure("blank-input-qualification", "stable-blank-target-deadline");
        // Reacquire the scroll and the reparented window observer without
        // processing events before committing the sole physical press.
        const auto fresh = observeCandidateScrollBlank();
        const auto freshObjects = observeCandidatePointerObjects();
        const auto freshPoint = observeCandidateHandlerPoint(freshObjects.observer);
        if (deadline.hasExpired())
            return candidateFailure("blank-input-qualification", "deadline-after-fresh-blank-observation");
        if (!sameCandidateTarget(accepted, fresh) || !freshObjects.eligible ||
            freshObjects.layer != acceptedObjects.layer || freshObjects.observer != acceptedObjects.observer ||
            freshObjects.scene != acceptedObjects.scene || !freshPoint.measured ||
            freshPoint.pressedButtons != int(Qt::NoButton) || freshObjects.observer->property("active").toBool() ||
            !ownsCommittedContext() || m_window->activeFocusItem() != focusBefore ||
            windowPresses != 0 || windowReleases != 0 || active.count() != 0 || grab.count() != 0)
            return candidateFailure("blank-input-qualification", "fresh-blank-target-or-context-changed");
        m_candidateBlankInput["geometryHits"] = candidateBlankGeometryHits(accepted.point);
        m_candidateBlankInput["qualified"] = true;
        const auto observeReceipts = [&] {
            int passiveCount = 0, matchingPassivePressCount = 0;
            QJsonObject matched;
            for (const auto &arguments : grab) {
                if (arguments.size() != 2 || !arguments[1].canConvert<QEventPoint>())
                    continue;
                const auto transition = arguments[0].value<QPointingDevice::GrabTransition>();
                const auto eventPoint = arguments[1].value<QEventPoint>();
                if (transition != QPointingDevice::GrabPassive)
                    continue;
                ++passiveCount;
                const bool timestampsKnown = pressTimestamp != 0 && eventPoint.timestamp() != 0;
                const bool matches = windowPresses == 1 && windowPressMatches &&
                    eventPoint.state() == QEventPoint::Pressed && eventPoint.scenePosition().toPoint() == accepted.point &&
                    eventPoint.id() == pressPointId && eventPoint.device() == pressDevice &&
                    (!timestampsKnown || pressTimestamp == eventPoint.timestamp());
                if (matches) {
                    ++matchingPassivePressCount;
                    matched = candidateEventPoint(eventPoint);
                    matched["transition"] = "GrabPassive";
                    matched["timestampRelationKnown"] = timestampsKnown;
                    matched["windowTimestampMatches"] = timestampsKnown ? QJsonValue(pressTimestamp == eventPoint.timestamp())
                        : QJsonValue(QJsonValue::Null);
                }
            }
            m_candidateBlankInput["handlerActiveSignals"] = active.count();
            m_candidateBlankInput["handlerPointSignals"] = point.count();
            m_candidateBlankInput["handlerGrabSignals"] = grab.count();
            m_candidateBlankInput["passiveGrabs"] = passiveCount;
            m_candidateBlankInput["matchingPassivePressGrabs"] = matchingPassivePressCount;
            if (!matched.isEmpty())
                m_candidateBlankInput["passivePressGrab"] = matched;
            const auto handlerPoint = observeCandidateHandlerPoint(initialObjects.observer);
            m_candidateBlankInput["handlerPointNow"] = handlerPoint.metadata;
            m_candidateBlankInput["handlerActiveNow"] = initialObjects.observer && initialObjects.observer->property("active").toBool();
            return matchingPassivePressCount == 1 && active.count() > 0 && initialObjects.observer &&
                initialObjects.observer->property("active").toBool() && handlerPoint.measured &&
                handlerPoint.pressedButtons == int(Qt::LeftButton) && handlerPoint.scene.toPoint() == accepted.point &&
                handlerPoint.id == pressPointId;
        };
        bool pressed = false, released = false;
        const auto release = [&](bool cleanup) {
            if (!pressed || released)
                return;
            released = true;
            m_candidateBlankInput["releaseWasCleanup"] = cleanup;
            m_candidateBlankInput["physicalReleaseAttempts"] = 1;
            QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, accepted.point, 0);
            observeReceipts();
        };
        const auto releaseGuard = qScopeGuard([&] { release(true); });
        const auto failedAfterPress = [&](const QString &reason) {
            release(true);
            return candidateFailure("blank-input-delivery", reason);
        };
        if (deadline.hasExpired())
            return candidateFailure("blank-input-qualification", "deadline-before-blank-press");
        m_candidateLayer = "blank-input-delivery";
        pressed = true;
        m_candidateBlankInput["physicalPressAttempts"] = 1;
        QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, accepted.point, 0);
        observeReceipts();
        if (deadline.hasExpired())
            return failedAfterPress("deadline-after-blank-press");
        QString receiptFailure;
        const bool proven = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            const bool receipt = observeReceipts();
            const bool revoked = m_panel->property("candidateFocusCancelReason").toString() == "input" &&
                m_panel->property("candidateFocusSerial").toULongLong() > committedSerial &&
                !m_panel->property("candidateFocusEligible").toBool() &&
                !m_panel->property("candidateFocusPending").toBool() && candidateFocusContext().isEmpty();
            m_candidateBlankInput["revokedBeforeRelease"] = revoked;
            m_candidateBlankInput["serialAfterPress"] = QJsonValue::fromVariant(m_panel->property("candidateFocusSerial"));
            m_candidateBlankInput["sameScrollFocusBeforeRelease"] = m_window->activeFocusItem() == focusBefore;
            if (windowPresses > 1 || windowReleases != 0 || (windowPresses == 1 && !windowPressMatches))
                receiptFailure = "blank-window-receipt-mismatch";
            else if (!initialObjects.observer || m_window->activeFocusItem() != focusBefore)
                receiptFailure = "blank-observer-or-scroll-focus-changed";
            candidateObserveChange();
            return !receiptFailure.isEmpty() || (receipt && revoked && windowPresses == 1 && windowReleases == 0 &&
                m_candidateBlankInput["windowPress"].toObject()["committedContextAtDelivery"].toBool());
        }, deadline);
        if (!receiptFailure.isEmpty())
            return failedAfterPress(receiptFailure);
        if (!proven || deadline.hasExpired())
            return failedAfterPress("blank-press-proof-or-revocation-deadline");
        m_candidateBlankInput["pressProvenBeforeRelease"] = true;
        m_candidateBlankInput["handlerPointBeforeRelease"] = observeCandidateHandlerPoint(initialObjects.observer).metadata;
        m_candidateBlankInput["activeSignalsBeforeRelease"] = int(active.count());
        m_candidateBlankInput["pointSignalsBeforeRelease"] = int(point.count());
        m_candidateBlankInput["grabSignalsBeforeRelease"] = int(grab.count());
        m_candidateBlankInput["matchingPassivePressGrabsBeforeRelease"] = m_candidateBlankInput["matchingPassivePressGrabs"];
        release(false);
        if (deadline.hasExpired())
            return candidateFailure("blank-input-delivery", "deadline-after-blank-release");
        const bool releasedCleanly = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            observeReceipts();
            const auto handlerPoint = observeCandidateHandlerPoint(initialObjects.observer);
            candidateObserveChange();
            return windowPresses == 1 && windowReleases == 1 && windowReleaseMatches && initialObjects.observer &&
                !initialObjects.observer->property("active").toBool() && handlerPoint.measured &&
                handlerPoint.pressedButtons == int(Qt::NoButton) && m_window->activeFocusItem() == focusBefore;
        }, deadline);
        if (!releasedCleanly || deadline.hasExpired())
            return candidateFailure("blank-input-delivery", "blank-release-receipt-deadline");
        m_candidateBlankInput["completed"] = true;
        candidateObserveChange();
        return true;
    }
    bool acknowledgeCandidate(const CandidateInput &input, CandidateReads &reads) {
        m_candidateLayer = "readback-correlation";
        const auto &before = input.before;
        if (rendererCommandCount("memory:list") != before.listCount ||
            rendererCommandCount("memory:candidates:list") != before.candidateCount)
            return candidateFailure("readback-correlation", "reads-before-action-ack");
        m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", input.requestId},
            {"payload", QJsonObject{{"ok", true}}}});
        if (rendererCommandCount("memory:list") != before.listCount + 1 ||
            rendererCommandCount("memory:candidates:list") != before.candidateCount + 1)
            return candidateFailure("readback-correlation", "ack-new-read-counts");
        const auto list = rendererCommandAt("memory:list", before.listCount);
        const auto candidates = rendererCommandAt("memory:candidates:list", before.candidateCount);
        reads.listId = list["request_id"].toString();
        reads.candidateId = candidates["request_id"].toString();
        if (reads.listId.isEmpty() || reads.candidateId.isEmpty() || reads.listId == before.listId ||
            reads.candidateId == before.candidateId || reads.listId == reads.candidateId ||
            reads.listId == input.requestId || reads.candidateId == input.requestId)
            return candidateFailure("readback-correlation", "ack-new-read-identities");
        if (candidates["payload"].toObject()["cursor"].toString() != QString("mc1.sameStart"))
            return candidateFailure("readback-correlation", "candidate-read-start-boundary");
        const auto feedback = m_bridge->memoryFeedback();
        const auto action = feedback.value("action").toMap();
        if (feedback.value("action").toMap().value("requestId").toString() != input.requestId ||
            feedback.value("action").toMap().value("status").toString() != "success" ||
            action.value("subjectId").toString() != input.envelope["payload"].toObject()["candidate_id"].toString() ||
            action.value("verb").toString() != (before.actionCommand.endsWith(":confirm") ? QString("记住这条") : QString("不记这条")) ||
            feedback.value("list").toMap().value("requestId").toString() != reads.listId ||
            feedback.value("candidates").toMap().value("requestId").toString() != reads.candidateId)
            return candidateFailure("readback-correlation", "ack-own-receipt-identities");
        candidateFixedStage("readback");
        return true;
    }
    bool waitForCandidateDeferredFocus(QQuickItem *&first) {
        const auto budget = QTest::defaultTryTimeout.load(std::memory_order_relaxed);
        const QDeadlineTimer deadline(budget, Qt::PreciseTimer);
        if (!m_window || !m_panel)
            return candidateFailure("fixture-construction", "candidate-focus-objects-missing");
        bool frameSeen = false, afterFramePostedTurn = false;
        // This new receiver sees only frame signals emitted after the failed
        // readback. Its destruction drops queued callbacks even on timeout.
        QObject drainContext;
        connect(m_window.get(), &QQuickWindow::frameSwapped, &drainContext, [&] {
            if (frameSeen)
                return;
            frameSeen = true;
            QMetaObject::invokeMethod(&drainContext, [&] { afterFramePostedTurn = true; }, Qt::QueuedConnection);
        }, Qt::QueuedConnection);
        const bool settled = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            candidateObserveChange();
            if (frameSeen && afterFramePostedTurn && !m_panel->property("candidateFocusPending").toBool())
                return !deadline.hasExpired();
            m_window->update();
            return false;
        }, deadline);
        if (!settled || deadline.hasExpired())
            return candidateFailure("failed-readback-focus", "deferred-focus-settlement-deadline");
        first = profileItem("memoryCandidateFirst", ProfileScope::Page);
        if (!first)
            return candidateFailure("failed-readback-focus", "fresh-first-missing");
        if (deadline.hasExpired())
            return candidateFailure("failed-readback-focus", "deadline-after-fresh-first");
        return true;
    }
    bool loadCandidatePanel(const CandidateTarget &target) {
        m_candidateTarget = target;
        if (!m_candidateElapsed.isValid())
            m_candidateElapsed.start();
        loadPanel();
        if (QTest::currentTestFailed() || !m_bridge || !m_window || !m_panel)
            return candidateFailure("fixture-construction", "candidate-panel-construction-failed");
        return true;
    }
    // The backend's to_dict always carries every UI field; age is null when unset.
    static QJsonObject profileSnapshot(char token = 'a', bool cleared = false, const QJsonObject &overrides = {}) {
        QJsonObject profile{{"name", "测试名字"}, {"nickname", cleared ? "" : "测试称呼"},
            {"birthday", ""}, {"identity", ""}, {"schedule", ""},
            {"interests", cleared ? QJsonArray{} : QJsonArray{"观星"}},
            {"hobbies", QJsonArray{}}, {"favorite_topics", QJsonArray{}},
            {"favorite_games", QJsonArray{}}, {"favorite_anime", QJsonArray{}},
            {"age", QJsonValue(QJsonValue::Null)}};
        for (auto it = overrides.begin(); it != overrides.end(); ++it)
            profile[it.key()] = it.value();
        return {{"ok", true}, {"profile_snapshot", QString(64, QLatin1Char(token))}, {"profile", profile}};
    }
    // Every field filled, so all eleven clear choices are enabled.
    static QJsonObject profileAllFieldsFilled() {
        return {{"birthday", "2000-01-31"}, {"identity", "测试身份"}, {"schedule", "23:00-7:00"},
                {"hobbies", QJsonArray{"测试爱好"}}, {"favorite_topics", QJsonArray{"测试话题"}},
                {"favorite_games", QJsonArray{"测试游戏甲", "测试游戏乙"}},
                {"favorite_anime", QJsonArray{"测试动漫"}}, {"age", 30}};
    }
    static const QStringList &profileClearKeys() {
        static const QStringList keys{"name", "nickname", "birthday", "identity", "schedule", "interests",
                                      "hobbies", "favorite_topics", "favorite_games", "favorite_anime", "age"};
        return keys;
    }
    // Replaces the saved profile through a real read and waits for the form.
    bool deliverFilledProfile(char token, const QJsonObject &overrides, const QString &ageText) {
        deliverProfile(m_bridge->request("user:profile:get"), profileSnapshot(token, false, overrides));
        const bool shown = QTest::qWaitFor([&] {
            const auto *age = profileItem("profileAge", ProfileScope::Page);
            return age && age->property("text").toString() == ageText;
        }, QTest::defaultTryTimeout.load(std::memory_order_relaxed));
        return shown || profileFailure("profile-filled-form-not-shown", profileItemState("profileAge", ProfileScope::Page));
    }
    void deliverProfile(const QString &id, const QJsonObject &payload) {
        m_bridge->event({{"type", "user:profile:result"}, {"request_id", id}, {"payload", payload}});
    }
    static void visualMatches(QQuickItem *root, const QString &name, QList<QQuickItem *> &matches) {
        if (!root)
            return;
        if (root->objectName() == name)
            matches.append(root);
        for (auto *child : root->childItems())
            visualMatches(child, name, matches);
    }
    QQuickItem *profileRoot(ProfileScope scope) const {
        if (scope == ProfileScope::Page)
            return m_panel;
        const auto dialogs = m_panel ? m_panel->findChildren<QObject *>("profileClearDialog") : QList<QObject *>{};
        if (dialogs.size() != 1 || dialogs.first() != m_dialog)
            return nullptr;
        return m_dialog->property("contentItem").value<QQuickItem *>();
    }
    QList<QQuickItem *> profileMatches(const QString &name, ProfileScope scope) const {
        QList<QQuickItem *> matches;
        visualMatches(profileRoot(scope), name, matches);
        return matches;
    }
    QQuickItem *profileItem(const QString &name, ProfileScope scope) const {
        const auto matches = profileMatches(name, scope);
        return matches.size() == 1 ? matches.first() : nullptr;
    }
    QJsonObject profileItemState(const QString &name, ProfileScope scope) const {
        const auto matches = profileMatches(name, scope);
        const auto *item = matches.size() == 1 ? matches.first() : nullptr;
        const auto *root = profileRoot(scope);
        const bool bound = root && item && m_window && item->window() == m_window.get() &&
            root->window() == m_window.get() && (root == item || root->isAncestorOf(item)) &&
            m_window->contentItem()->isAncestorOf(root);
        bool geometry = item && std::isfinite(item->width()) && std::isfinite(item->height()) &&
                        item->width() > 0 && item->height() > 0;
        QPoint point;
        QRectF visible;
        bool pointMeasured = false, clipMeasured = false;
        if (geometry && m_window) {
            const auto center = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
            geometry = std::isfinite(center.x()) && std::isfinite(center.y());
            if (geometry) {
                point = center.toPoint();
                pointMeasured = true;
                visible = item->mapRectToScene(QRectF(0, 0, item->width(), item->height())) &
                          QRectF(QPointF(), QSizeF(m_window->size()));
                for (auto *parent = item->parentItem(); parent; parent = parent->parentItem())
                    if (parent->clip())
                        visible &= parent->mapRectToScene(QRectF(0, 0, parent->width(), parent->height()));
                clipMeasured = true;
                geometry = std::isfinite(visible.x()) && std::isfinite(visible.y()) &&
                           std::isfinite(visible.width()) && std::isfinite(visible.height());
            }
        }
        const bool readable = bound && geometry && item->isVisible() && !visible.isEmpty();
        const bool pointInside = readable && QRect(QPoint(), m_window->size()).contains(point) &&
            visible.contains(QPointF(point)) && item->contains(item->mapFromScene(QPointF(point)));
        const auto finiteNumber = [](qreal value) {
            return std::isfinite(value) ? QJsonValue(value) : QJsonValue(QJsonValue::Null);
        };
        return {{"name", name.left(80)}, {"matches", matches.size()}, {"bound", bound},
            {"visible", item && item->isVisible()}, {"enabled", item && item->isEnabled()},
            {"geometry", geometry}, {"readable", readable}, {"pointInsideClip", pointInside},
            {"pointMeasured", pointMeasured},
            {"width", item ? finiteNumber(item->width()) : QJsonValue(QJsonValue::Null)},
            {"height", item ? finiteNumber(item->height()) : QJsonValue(QJsonValue::Null)},
            {"clipX", clipMeasured ? finiteNumber(visible.x()) : QJsonValue(QJsonValue::Null)},
            {"clipY", clipMeasured ? finiteNumber(visible.y()) : QJsonValue(QJsonValue::Null)},
            {"clipWidth", clipMeasured ? finiteNumber(visible.width()) : QJsonValue(QJsonValue::Null)},
            {"clipHeight", clipMeasured ? finiteNumber(visible.height()) : QJsonValue(QJsonValue::Null)},
            {"pointX", pointMeasured ? QJsonValue(point.x()) : QJsonValue(QJsonValue::Null)},
            {"pointY", pointMeasured ? QJsonValue(point.y()) : QJsonValue(QJsonValue::Null)}};
    }
    QJsonObject profileDialogState() const {
        const auto dialogs = m_panel ? m_panel->findChildren<QObject *>("profileClearDialog") : QList<QObject *>{};
        const bool current = dialogs.size() == 1 && dialogs.first() == m_dialog;
        const bool opened = current && m_dialog->property("opened").toBool();
        const bool visible = current && m_dialog->property("visible").toBool();
        bool ready = opened && visible;
        QJsonArray fields;
        for (const auto &key : profileClearKeys()) {
            const auto state = profileItemState("profileClearField-" + key, ProfileScope::Dialog);
            fields.append(state);
            // Disabled empty fields must remain inspectable. Selection and
            // enabled/checked expectations belong to the test's assertions.
            ready = ready && state["readable"].toBool();
        }
        return {{"dialogMatches", dialogs.size()}, {"currentDialog", current},
            {"contentRoot", profileRoot(ProfileScope::Dialog) != nullptr},
            {"opened", opened}, {"visible", visible}, {"ready", ready}, {"fields", fields}};
    }
    static QString compactDiagnostic(const QJsonObject &state) {
        return QString::fromUtf8(QJsonDocument(state).toJson(QJsonDocument::Compact));
    }
    bool profileFailure(const QString &reason, QJsonObject state = {}) {
        state["reason"] = reason;
        m_profileDiagnostic = compactDiagnostic(state);
        qInfo().noquote() << "PROFILE_FIXTURE_FAILURE" << m_profileDiagnostic;
        return false;
    }
    bool loadProfilePanel() {
        m_profileDiagnostic.clear();
        deliverProfile(m_bridge->request("user:profile:get"), profileSnapshot());
        loadPanel();
        if (QTest::currentTestFailed() || !m_panel || !m_window)
            return profileFailure("profile-panel-load");
        if (!m_panel->setProperty("page", "memory"))
            return profileFailure("profile-page-selection");
        auto *tabs = m_panel->findChild<QQuickItem *>("memoryTabs");
        if (!tabs || !tabs->setProperty("currentIndex", 2))
            return profileFailure("profile-tab-selection");
        const auto dialogs = m_panel->findChildren<QObject *>("profileClearDialog");
        if (dialogs.size() != 1)
            return profileFailure("profile-dialog-ambiguous", {{"matches", dialogs.size()}});
        m_dialog = dialogs.first();
        m_window->resize(1000, 1100);
        const QDeadlineTimer deadline(QTest::defaultTryTimeout.load(std::memory_order_relaxed), Qt::PreciseTimer);
        const bool loaded = QTest::qWaitFor([&] {
            if (deadline.hasExpired())
                return false;
            const auto *nickname = profileItem("profileNickname", ProfileScope::Page);
            return nickname && nickname->property("text").toString() == "测试称呼" &&
                   profileItemState("profileClear", ProfileScope::Page)["readable"].toBool();
        }, deadline);
        if (!loaded || deadline.hasExpired())
            return profileFailure("profile-form-not-ready", profileItemState("profileClear", ProfileScope::Page));
        QCoreApplication::processEvents();
        if (QTest::currentTestFailed())
            return profileFailure("profile-panel-event-failure");
        if (deadline.hasExpired())
            return profileFailure("profile-form-deadline-expired", profileItemState("profileClear", ProfileScope::Page));
        m_frames.clear();
        return true;
    }
    bool clickProfileItem(const QString &name, ProfileScope scope, const QDeadlineTimer *deadline = nullptr) {
        m_profileDiagnostic.clear();
        const auto state = profileItemState(name, scope);
        if (!state["readable"].toBool() || !state["enabled"].toBool() || !state["pointInsideClip"].toBool())
            return profileFailure("profile-input-not-ready", state);
        // State inspection and this fresh lookup do not process events. Never
        // retain a delegate pointer across a wait or after mouse delivery.
        if (!profileItem(name, scope))
            return profileFailure("profile-input-target-changed", state);
        const QPoint point(state["pointX"].toInt(), state["pointY"].toInt());
        if (deadline && deadline->hasExpired())
            return profileFailure("profile-input-deadline-expired", state);
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
        ++m_profileClickCount;
        qInfo().noquote() << "PROFILE_FIXTURE_CLICK" << compactDiagnostic({
            {"name", name.left(80)}, {"pointX", point.x()}, {"pointY", point.y()},
            {"clickCount", m_profileClickCount}});
        return true;
    }
    bool openProfileClear() {
        const auto timeout = QTest::defaultTryTimeout.load(std::memory_order_relaxed);
        QElapsedTimer elapsed;
        elapsed.start();
        const QDeadlineTimer deadline(timeout, Qt::PreciseTimer);
        const bool clicked = clickProfileItem("profileClear", ProfileScope::Page, &deadline);
        auto initial = profileDialogState();
        initial["stage"] = "initial";
        initial["timeoutMs"] = qint64(timeout.count());
        initial["elapsedMs"] = elapsed.elapsed();
        initial["deadlineExpired"] = deadline.hasExpired();
        qInfo().noquote() << "PROFILE_DIALOG_READINESS" << compactDiagnostic(initial);
        const bool observed = clicked && QTest::qWaitFor([&] {
            return !deadline.hasExpired() && profileDialogState()["ready"].toBool();
        }, deadline);
        auto terminal = profileDialogState();
        terminal["elapsedMs"] = elapsed.elapsed();
        const bool expired = deadline.hasExpired();
        const bool ready = observed && !expired && terminal["ready"].toBool();
        terminal["stage"] = "terminal";
        terminal["timeoutMs"] = qint64(timeout.count());
        terminal["deadlineExpired"] = expired;
        terminal["admitted"] = ready;
        // At most these two eight-field records per wait; the failure receipt
        // below is a short reason, so cleanup cannot erase the terminal state.
        qInfo().noquote() << "PROFILE_DIALOG_READINESS" << compactDiagnostic(terminal);
        if (!ready) {
            QString reason = clicked ? "profile-dialog-readiness-timeout" : "profile-dialog-open-input-failed";
            QJsonObject target;
            if (terminal["dialogMatches"].toInteger() == 0)
                reason = "profile-dialog-missing";
            else if (terminal["dialogMatches"].toInteger() > 1)
                reason = "profile-dialog-ambiguous";
            else if (!terminal["currentDialog"].toBool())
                reason = "profile-dialog-not-current";
            else if (!terminal["contentRoot"].toBool())
                reason = "profile-dialog-content-missing";
            else
                for (const auto &entry : terminal["fields"].toArray()) {
                    const auto field = entry.toObject();
                    if (field["matches"].toInteger() != 1) {
                        reason = field["matches"].toInteger() > 1 ? "profile-field-ambiguous" : "profile-field-missing";
                        target["name"] = field["name"];
                        break;
                    }
                }
            return profileFailure(reason, target);
        }
        return true;
    }
    bool editProfileField(const QString &name, const QString &value) {
        m_profileDiagnostic.clear();
        const auto state = profileItemState(name, ProfileScope::Page);
        auto *field = profileItem(name, ProfileScope::Page);
        if (!field || !state["readable"].toBool() || !state["enabled"].toBool())
            return profileFailure("profile-editor-not-ready", state);
        field->forceActiveFocus();
        if (!QMetaObject::invokeMethod(field, "selectAll"))
            return profileFailure("profile-editor-selection-failed", state);
        QInputMethodEvent commit;
        commit.setCommitString(value);
        QCoreApplication::sendEvent(m_window.get(), &commit);
        field = profileItem(name, ProfileScope::Page);
        if (!field || field->property("text").toString() != value || !m_panel->property("profileDirty").toBool())
            return profileFailure("profile-editor-commit-failed", profileItemState(name, ProfileScope::Page));
        return true;
    }
    // A smaller window can leave a page control below the memory page
    // viewport. Scroll the page as a user would, then require the control
    // fully visible and unchanged across a settled frame before any input.
    bool revealProfileEntry(const QString &name) {
        m_profileDiagnostic.clear();
        const QDeadlineTimer deadline(QTest::defaultTryTimeout.load(std::memory_order_relaxed), Qt::PreciseTimer);
        if (!feedbackLayoutSettled(deadline))
            return profileFailure("profile-reveal-layout-timeout", profileItemState(name, ProfileScope::Page));
        auto *content = feedbackScrollContent();
        auto *item = profileItem(name, ProfileScope::Page);
        if (!content || !item)
            return profileFailure("profile-reveal-target-missing",
                                  {{"name", name}, {"scroll", content != nullptr}, {"item", item != nullptr}});
        const auto before = content->property("contentY").toDouble();
        bool scrolled = false;
        if (!feedbackItemFullyVisible(item)) {
            const auto origin = content->property("originY").toDouble();
            const auto minimum = origin - content->property("topMargin").toDouble();
            const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
                content->height() + content->property("bottomMargin").toDouble());
            const auto viewport = content->mapRectToScene(QRectF(QPointF(), content->size()));
            const auto target = item->mapRectToScene(QRectF(QPointF(), item->size()));
            const auto wanted = qBound(minimum, before + target.center().y() - viewport.center().y(), maximum);
            if (!std::isfinite(wanted) || !content->setProperty("contentY", wanted))
                return profileFailure("profile-reveal-scroll-rejected",
                                      {{"name", name}, {"contentYBefore", before}, {"wanted", wanted}});
            scrolled = true;
        }
        if (!feedbackLayoutSettled(deadline))
            return profileFailure("profile-reveal-layout-timeout", profileItemState(name, ProfileScope::Page));
        item = profileItem(name, ProfileScope::Page);
        const auto first = item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
        if (!feedbackLayoutSettled(deadline))
            return profileFailure("profile-reveal-layout-timeout", profileItemState(name, ProfileScope::Page));
        item = profileItem(name, ProfileScope::Page);
        auto state = profileItemState(name, ProfileScope::Page);
        state["scrolled"] = scrolled;
        state["contentYBefore"] = before;
        state["contentYAfter"] = content->property("contentY").toDouble();
        const auto second = item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
        const bool stable = item && qAbs(second.x() - first.x()) <= .5 && qAbs(second.y() - first.y()) <= .5 &&
            qAbs(second.width() - first.width()) <= .5 && qAbs(second.height() - first.height()) <= .5;
        state["stable"] = stable;
        if (!stable || !feedbackItemFullyVisible(item) || !state["readable"].toBool() ||
            !state["pointInsideClip"].toBool())
            return profileFailure("profile-reveal-not-visible", state);
        qInfo().noquote() << "PROFILE_ENTRY_REVEALED" << compactDiagnostic(state);
        return true;
    }
    void loadPanel(QObject *session = nullptr) {
        m_engine = std::make_unique<QQmlEngine>();
        m_engine->rootContext()->setContextProperty("session", session ? session : m_bridge.get());
        m_engine->rootContext()->setContextProperty("archiveEditor", m_archive.get());
        QQmlComponent component(m_engine.get(), QUrl("qrc:/persona-card-confirmation/PersonaCardConfirmationFixture.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        m_window.reset(qobject_cast<QQuickWindow *>(component.create()));
        QVERIFY2(m_window, qPrintable(component.errorString()));
        m_panel = m_window->findChild<QQuickItem *>("fixtureTaskPanel");
        QVERIFY(m_panel);
        m_dialog = m_panel->findChild<QObject *>("personaImportConfirmation");
        QVERIFY(m_dialog);
        QCOMPARE(m_panel->findChildren<QObject *>("personaImportConfirmation").size(), 1);
        m_window->show();
        QVERIFY(QTest::qWaitForWindowExposed(m_window.get()));
    }
    // These helpers exercise the existing TaskPanel, command writer and shared
    // input gate. They do not emit the older candidate/profile diagnostics.
    static QString feedbackMemoryId(int index) { return QString("fact_feedback_%1").arg(index); }
    static QJsonArray feedbackMemoryRows(int count = 80) {
        QJsonArray rows;
        for (int index = 0; index < count; ++index)
            rows.append(QJsonObject{{"id", feedbackMemoryId(index)}, {"text", QString("固定反馈布局的独立记忆行 %1").arg(index)},
                                    {"pinned", false}, {"revision", 1}});
        return rows;
    }
    void deliverFeedbackMemories(const QString &requestId, const QJsonArray &rows) {
        m_bridge->event({{"type", "memory:result"}, {"request_id", requestId},
            {"payload", QJsonObject{{"ok", true}, {"memories", rows}, {"has_more", false},
                {"next_cursor", QJsonValue::Null}, {"query", m_bridge->memoryQuery()}}}});
    }
    static QString batchMemoryId(int index) { return QString("fact_batch_%1").arg(index); }
    static QJsonArray batchMemoryRows(int first = 0, int count = 3) {
        QJsonArray rows;
        for (int index = first; index < first + count; ++index)
            rows.append(QJsonObject{{"id", batchMemoryId(index)}, {"text", QString("批量选择测试记忆 %1").arg(index)},
                {"pinned", index == 0}, {"revision", 1}});
        return rows;
    }
    void deliverBatchMemories(const QString &requestId, const QJsonArray &rows,
                              bool more = false, const QString &cursor = {}) {
        m_bridge->event({{"type", "memory:result"}, {"request_id", requestId},
            {"payload", QJsonObject{{"ok", true}, {"memories", rows}, {"has_more", more},
                {"next_cursor", more ? QJsonValue(cursor) : QJsonValue(QJsonValue::Null)},
                {"query", m_bridge->memoryQuery()}}}});
    }
    QVariantList batchSelectedIds() const {
        const auto value = m_panel ? m_panel->property("memorySelectedIds") : QVariant{};
        return value.metaType() == QMetaType::fromType<QJSValue>()
            ? value.value<QJSValue>().toVariant().toList() : value.toList();
    }
    QObject *batchDialog() const {
        const auto dialogs = m_panel ? m_panel->findChildren<QObject *>("memoryBatchDeleteDialog") : QList<QObject *>{};
        return dialogs.size() == 1 ? dialogs.first() : nullptr;
    }
    QObject *batchPinDialog() const {
        const auto dialogs = m_panel ? m_panel->findChildren<QObject *>("memoryBatchPinDialog") : QList<QObject *>{};
        return dialogs.size() == 1 ? dialogs.first() : nullptr;
    }
    static QJsonObject batchPinStatus(const QVariantList &ids, const QSet<QString> &pinnedIds, int total) {
        QJsonArray states;
        for (const auto &id : ids)
            states.append(QJsonObject{{"memory_id", id.toString()}, {"pinned", pinnedIds.contains(id.toString())}});
        return {{"ok", true}, {"memory_ids", QJsonArray::fromVariantList(ids)}, {"states", states},
            {"stale_ids", QJsonArray{}}, {"pinned_total", total}, {"pin_limit", 20}};
    }
    void deliverBatchPinStatus(const QString &requestId, const QVariantList &ids,
                               const QSet<QString> &pinnedIds, int total) {
        m_bridge->event({{"type", "memory:result"}, {"request_id", requestId},
            {"payload", batchPinStatus(ids, pinnedIds, total)}});
    }
    void deliverBatchPinAck(const QString &requestId, const QVariantList &ids, bool pinned,
                            const QVariantList &changed, int before, int after) {
        QVariantList unchanged;
        for (const auto &id : ids)
            if (!changed.contains(id)) unchanged.append(id);
        m_bridge->event({{"type", "memory:result"}, {"request_id", requestId},
            {"payload", QJsonObject{{"ok", true}, {"memory_ids", QJsonArray::fromVariantList(ids)},
                {"pinned", pinned}, {"changed_ids", QJsonArray::fromVariantList(changed)},
                {"unchanged_ids", QJsonArray::fromVariantList(unchanged)}, {"pinned_total_before", before},
                {"pinned_total_after", after}, {"pin_limit", 20}}}});
    }
    static QJsonArray batchPinReadRows(const QJsonArray &source, const QVariantList &ids, bool pinned) {
        QJsonArray rows;
        for (const auto &entry : source) {
            auto row = entry.toObject();
            if (ids.contains(row.value("id").toString())) row["pinned"] = pinned;
            rows.append(row);
        }
        return rows;
    }
    QObject *candidateBatchDialog() const {
        const auto dialogs = m_panel ? m_panel->findChildren<QObject *>("memoryCandidateBatchDialog") : QList<QObject *>{};
        return dialogs.size() == 1 ? dialogs.first() : nullptr;
    }
    QVariantList candidateSelectedIds() const {
        const auto value = m_panel ? m_panel->property("candidateSelectedIds") : QVariant{};
        return value.metaType() == QMetaType::fromType<QJSValue>()
            ? value.value<QJSValue>().toVariant().toList() : value.toList();
    }
    // Outcome lists follow selection order, as the backend writes them.
    static QJsonObject candidateBatchSnapshot(const QVariantList &ids, const QVariantList &replace = {},
                                              const QVariantList &pinned = {}, const QString &status = "pending") {
        QJsonArray states, pendingIds, stale, fresh, replaced, pinnedIds;
        for (const auto &value : ids) {
            states.append(QJsonObject{{"candidate_id", value.toString()}, {"status", status}});
            if (status != "pending") {
                stale.append(value.toString());
                continue;
            }
            pendingIds.append(value.toString());
            (replace.contains(value) ? replaced : fresh).append(value.toString());
            if (pinned.contains(value))
                pinnedIds.append(value.toString());
        }
        return {{"ok", true}, {"candidate_ids", QJsonArray::fromVariantList(ids)}, {"states", states},
            {"pending_ids", pendingIds}, {"stale_ids", stale}, {"new_ids", fresh}, {"replace_ids", replaced},
            {"same_ids", QJsonArray{}}, {"replaced_pinned_ids", pinnedIds}, {"conflict_groups", QJsonArray{}}};
    }
    void deliverCandidateBatchStatus(const QString &requestId, const QJsonObject &payload) {
        m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", requestId}, {"payload", payload}});
    }
    bool prepareCandidateBatchPanel(int width = 1000, int height = 1100) {
        loadPanel();
        if (QTest::currentTestFailed() || !m_window || !m_panel || !candidateBatchDialog()) return false;
        m_window->resize(width, height);
        if (!selectMemoryCandidatesPage()) return false;
        m_bridge->refreshMemories();
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), batchMemoryRows(0, 3));
        deliverCandidate(candidatePage(candidateRows(1, 3)));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        return feedbackLayoutSettled(deadline) && batchControl("memoryCandidateSelectMode") &&
            batchControl("memoryCandidateSelectMode")->isEnabled();
    }
    QQuickItem *batchControl(const QString &name, bool dialog = false) const {
        auto *root = m_panel;
        if (dialog) {
            auto *current = name.startsWith("memoryCandidateBatch") ? candidateBatchDialog()
                : name.startsWith("memoryBatchPin") ? batchPinDialog() : batchDialog();
            root = current ? current->property("contentItem").value<QQuickItem *>() : nullptr;
        }
        return NativeCheck::findVisual(root, name).item;
    }
    bool prepareBatchPanel(const QJsonArray &rows, bool more = false, const QString &cursor = {},
                           int width = 1000, int height = 1100) {
        loadPanel();
        if (QTest::currentTestFailed() || !m_window || !m_panel || !batchDialog()) return false;
        m_window->resize(width, height);
        if (!selectMemoryCandidatesPage()) return false;
        m_bridge->refreshMemories();
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), rows, more, cursor);
        deliverCandidate(candidatePage({}));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        return feedbackLayoutSettled(deadline) && batchControl("memorySelectMode") &&
            batchControl("memorySelectMode")->isEnabled();
    }
    // Reuse the production control gate and CheckContract's unique visual
    // lookup, hit test and signal rules. Reveal and input share one 4 s clock;
    // input needs one stable frame and 40 ms on the same identity/geometry.
    bool batchInput(const QString &name, bool dialog = false, bool checkbox = false) {
        m_profileDiagnostic.clear();
        if (!m_panel || !m_window) return false;
        const auto scope = m_bridge->scopeKey();
        const int revision = m_bridge->memoryListRevision();
        QElapsedTimer clock;
        clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        trackCandidateFrames();
        NativeControlReadiness::SequentialGate gate;
        QPointer<QQuickItem> anchor, accepted;
        QRectF anchorScene, anchorClip;
        qint64 stableAt = 0;
        quint64 stableFrame = 0;
        bool delivered = false;
        NativeCheck::InputSignals counts;
        const auto identityCurrent = [&] {
            return m_bridge->scopeKey() == scope && m_bridge->memoryListRevision() == revision;
        };
        const std::vector<NativeControlReadiness::SequentialGate::Action> actions{{name,
            [&] { return batchControl(name, dialog); },
            [&](QQuickItem *item) {
                // SequentialGate reveals the center. A center already in the
                // viewport can still leave a button edge clipped, so finish
                // that page reveal before anchoring the stable observation.
                if (!dialog && item && !feedbackItemFullyVisible(item) && !deadline.hasExpired()) {
                    auto *content = feedbackScrollContent();
                    if (content) {
                        const auto origin = content->property("originY").toDouble();
                        const auto minimum = origin - content->property("topMargin").toDouble();
                        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
                            content->height() + content->property("bottomMargin").toDouble());
                        const auto viewport = content->mapRectToScene(QRectF(QPointF(), content->size()));
                        const auto target = item->mapRectToScene(QRectF(QPointF(), item->size()));
                        const auto wanted = qBound(minimum, content->property("contentY").toDouble() +
                            target.center().y() - viewport.center().y(), maximum);
                        if (std::isfinite(wanted) && !deadline.hasExpired()) content->setProperty("contentY", wanted);
                    }
                }
                const auto scene = item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
                const auto clip = NativeControlReadiness::visibleRect(item, m_window.get());
                auto state = NativeControlReadiness::snapshot(item, m_window.get());
                const bool candidate = identityCurrent() && item && batchControl(name, dialog) == item &&
                    item->window() == m_window.get() && item->isVisible() && item->isEnabled() &&
                    MemoryActionProbe::detail::finite(scene) && scene.width() > 0 && scene.height() > 0 &&
                    clip.adjusted(-.5, -.5, .5, .5).contains(scene);
                bool ready = false;
                if (!candidate) anchor.clear();
                else if (anchor != item || anchorScene != scene || anchorClip != clip) {
                    anchor = item; anchorScene = scene; anchorClip = clip;
                    stableAt = clock.elapsed(); stableFrame = m_candidateFrameSerial;
                } else if (clock.elapsed() - stableAt >= 40 && m_candidateFrameSerial > stableFrame) {
                    accepted = item; ready = true;
                }
                state["ready"] = ready;
                return state;
            }, [&](QQuickItem *item) {
                const auto scene = item ? item->mapRectToScene(QRectF(QPointF(), item->size())) : QRectF();
                const auto clip = NativeControlReadiness::visibleRect(item, m_window.get());
                if (deadline.hasExpired() || !identityCurrent() || accepted != item || batchControl(name, dialog) != item ||
                    scene != anchorScene || clip != anchorClip)
                    NativeCheck::fail("BATCH_INPUT_CHANGED", {{"control", name}});
                const auto point = item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint();
                const auto hit = NativeCheck::hitTest(m_window.get(), point, item);
                NativeCheck::require(hit.accepted(), "BATCH_INPUT_HIT", hit.metadata());
                QSignalSpy clicked(item, SIGNAL(clicked()));
                QSignalSpy toggled(item, SIGNAL(toggled()));
                counts.observerValid = clicked.isValid() && (!checkbox || toggled.isValid());
                if (!counts.observerValid) NativeCheck::fail("BATCH_INPUT_SIGNALS", {{"control", name}});
                QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point, 0);
                counts.mouseDispatchCount = 1;
                counts.clicked = clicked.count();
                if (checkbox) counts.toggled = toggled.count();
                const auto kind = checkbox ? NativeCheck::ControlKind::Switch : NativeCheck::ControlKind::Button;
                NativeCheck::require(NativeCheck::inputContractFailure(kind, counts).isEmpty(),
                                     "BATCH_INPUT_SIGNAL_COUNT", NativeCheck::describeSignals(kind, counts));
                delivered = true;
            }}};
        try {
            const bool performed = QTest::qWaitFor([&] {
                if (deadline.hasExpired()) return false;
                const auto result = gate.poll([&] { return clock.elapsed(); }, 4000, actions);
                m_window->update();
                return result == NativeControlReadiness::SequentialGate::Performed;
            }, deadline);
            if (performed && delivered && !deadline.hasExpired()) return true;
            m_profileDiagnostic = NativeCheck::describe("BATCH_INPUT_TIMEOUT", {{"control", name},
                {"delivered", delivered}, {"dialog", dialog}, {"elapsedMs", clock.elapsed()}});
        } catch (const std::exception &error) {
            m_profileDiagnostic = QString::fromUtf8(error.what());
        }
        return false;
    }
    QQuickItem *fixedMemoryFeedback() const {
        QList<QQuickItem *> matches;
        visualMatches(m_panel, "memoryActionFeedback", matches);
        return matches.size() == 1 ? matches.first() : nullptr;
    }
    QQuickItem *feedbackScrollContent() const {
        const auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        return scroll ? scroll->property("contentItem").value<QQuickItem *>() : nullptr;
    }
    bool feedbackItemFullyVisible(QQuickItem *item) const {
        if (!item || !m_window || !m_panel || !item->isVisible()) return false;
        const auto scene = item->mapRectToScene(QRectF(QPointF(), item->size()));
        const auto clip = NativeControlReadiness::visibleRect(item, m_window.get());
        const auto panel = m_panel->mapRectToScene(QRectF(QPointF(), m_panel->size()));
        return MemoryActionProbe::detail::finite(scene) && scene.width() > 0 && scene.height() > 0 &&
            clip.adjusted(-.5, -.5, .5, .5).contains(scene) && panel.adjusted(-.5, -.5, .5, .5).contains(scene);
    }
    bool feedbackLayoutSettled(const QDeadlineTimer &deadline) {
        bool frame = false, posted = false;
        QObject receiver;
        connect(m_window.get(), &QQuickWindow::frameSwapped, &receiver, [&] {
            if (frame) return;
            frame = true;
            QMetaObject::invokeMethod(&receiver, [&] { posted = true; }, Qt::QueuedConnection);
        }, Qt::QueuedConnection);
        return QTest::qWaitFor([&] {
            if (deadline.hasExpired()) return false;
            m_window->update();
            return frame && posted;
        }, deadline) && !deadline.hasExpired();
    }
    QJsonObject memoryLayoutSnapshot() const {
        const auto rectangle = [](const QQuickItem *item) {
            if (!item) return QJsonValue(QJsonValue::Null);
            const auto rect = item->mapRectToScene(QRectF(QPointF(), item->size()));
            return QJsonValue(QJsonObject{{"x", rect.x()}, {"y", rect.y()},
                {"width", rect.width()}, {"height", rect.height()}, {"visible", item->isVisible()}});
        };
        const auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        const auto *header = batchControl("memoryCandidatePageInfo");
        const auto *content = feedbackScrollContent();
        const auto spacing = scroll && scroll->parentItem() ? scroll->parentItem()->property("spacing") : QVariant{};
        bool spacingOk = false;
        const auto spacingValue = spacing.toDouble(&spacingOk);
        return {{"frameSerial", qint64(m_candidateFrameSerial)}, {"panel", rectangle(m_panel)},
            {"scroll", rectangle(scroll)}, {"header", rectangle(header)},
            {"feedback", rectangle(fixedMemoryFeedback())},
            {"warning", rectangle(profileItem("runtimeRecoveryWarning", ProfileScope::Page))},
            {"headerHeight", header ? QJsonValue(header->height()) : QJsonValue(QJsonValue::Null)},
            {"parentSpacing", spacingOk ? QJsonValue(spacingValue) : QJsonValue(QJsonValue::Null)},
            {"scrollOffset", content ? QJsonValue(content->property("contentY").toDouble()) : QJsonValue(QJsonValue::Null)}};
    }
    QString memoryLayoutDiagnostic(const QJsonObject &before, const QString &stage) const {
        return compactDiagnostic({{"stage", stage}, {"before", before}, {"after", memoryLayoutSnapshot()}});
    }
    bool feedbackOffsetRetained(qreal before) const {
        const auto *content = feedbackScrollContent();
        if (!content) return false;
        const auto after = content->property("contentY").toDouble();
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        if (!std::isfinite(before) || !std::isfinite(after) || after < minimum - .5 || after > maximum + .5)
            return false;
        // A still-legal middle offset is invariant. A boundary follows Qt's
        // clamp into the actual new range and cannot accept an arbitrary jump.
        return qAbs(after - qBound(minimum, before, maximum)) <= .5;
    }
    bool feedbackInput(const CandidateTarget &target, const QString &command, CandidateInput &input,
                       qreal &offsetBeforeInput, QElapsedTimer &clock, const QDeadlineTimer &deadline,
                       const QString &commit = QString()) {
        if (!m_bridge || !m_window || !m_panel || !feedbackScrollContent()) return false;
        const auto scope = m_bridge->scopeKey();
        const auto initialFeedback = m_bridge->memoryFeedback();
        const auto listId = initialFeedback.value("list").toMap().value("requestId").toString();
        const auto candidateReadId = initialFeedback.value("candidates").toMap().value("requestId").toString();
        const auto identitiesMatch = [&] {
            const auto current = m_bridge->memoryFeedback();
            return m_bridge->scopeKey() == scope &&
                current.value("list").toMap().value("requestId").toString() == listId &&
                current.value("candidates").toMap().value("requestId").toString() == candidateReadId;
        };
        trackCandidateFrames();
        NativeControlReadiness::SequentialGate gate;
        CandidateObservation anchor, accepted;
        bool anchored = false;
        qint64 anchorAt = 0;
        quint64 anchorFrame = 0;
        int clicks = 0;
        const std::vector<NativeControlReadiness::SequentialGate::Action> actions{{target.name,
            [&] { return observeCandidateTarget(target).item.data(); },
            [&](QQuickItem *item) {
                const auto current = observeCandidateTarget(target);
                bool ready = false;
                if (!identitiesMatch() || !current.eligible || current.item != item) anchored = false;
                else if (!anchored || !sameCandidateTarget(anchor, current)) {
                    anchor = current; anchorAt = clock.elapsed(); anchorFrame = m_candidateFrameSerial; anchored = true;
                } else if (clock.elapsed() - anchorAt >= 40 && m_candidateFrameSerial > anchorFrame) {
                    accepted = current; ready = true;
                }
                auto state = NativeControlReadiness::snapshot(item, m_window.get());
                state["ready"] = ready;
                return state;
            }, [&](QQuickItem *item) {
                const auto fresh = observeCandidateTarget(target);
                if (deadline.hasExpired() || !identitiesMatch() || !sameCandidateTarget(accepted, fresh) || fresh.item != item)
                    throw std::runtime_error("memory feedback input target changed");
                input.before = candidateBaseline(command);
                const int framesBefore = m_frames.size();
                offsetBeforeInput = feedbackScrollContent()->property("contentY").toDouble();
                if (!commit.isNull()) {
                    if (deadline.hasExpired() || clock.elapsed() >= 4000)
                        throw std::runtime_error("memory feedback focus deadline");
                    item->forceActiveFocus();
                    if (!QMetaObject::invokeMethod(item, "selectAll") || deadline.hasExpired())
                        throw std::runtime_error("memory feedback edit input unavailable");
                    QInputMethodEvent event;
                    event.setCommitString(commit);
                    if (deadline.hasExpired() || clock.elapsed() >= 4000)
                        throw std::runtime_error("memory feedback commit deadline");
                    QCoreApplication::sendEvent(m_window.get(), &event);
                    if (item->property("text").toString() != commit)
                        throw std::runtime_error("memory feedback edit input not committed");
                } else {
                    QSignalSpy clicked(item, SIGNAL(clicked()));
                    if (!clicked.isValid()) throw std::runtime_error("memory feedback click unavailable");
                    if (deadline.hasExpired() || clock.elapsed() >= 4000)
                        throw std::runtime_error("memory feedback click deadline");
                    QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                    clicks = clicked.count();
                    if (clicks != 1) throw std::runtime_error("memory feedback click count");
                }
                if (command.isEmpty()) {
                    if (m_frames.size() != framesBefore) throw std::runtime_error("memory feedback local input sent RPC");
                } else {
                    if (rendererCommandCount(command) != input.before.actionCount + 1)
                        throw std::runtime_error("memory feedback action count");
                    input.envelope = rendererCommandAt(command, input.before.actionCount);
                    input.requestId = input.envelope["request_id"].toString();
                    if (input.requestId.isEmpty() || input.requestId == input.before.actionId ||
                        (!target.rowId.isEmpty() && input.envelope["payload"].toObject()["memory_id"].toString() != target.rowId))
                        throw std::runtime_error("memory feedback action identity");
                }
            }}};
        try {
            const bool performed = QTest::qWaitFor([&] {
                if (deadline.hasExpired()) return false;
                const auto result = gate.poll([&] { return clock.elapsed(); }, 4000, actions);
                m_window->update();
                return result == NativeControlReadiness::SequentialGate::Performed;
            }, deadline);
            return performed && !deadline.hasExpired() && (commit.isNull() ? clicks == 1 : true);
        } catch (const std::exception &error) {
            m_candidateDiagnostic = QString::fromUtf8(error.what());
            return false;
        }
    }
    bool prepareFeedbackRows(const QJsonArray &rows) {
        if (!selectMemoryCandidatesPage()) return false;
        QElapsedTimer clock; clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        CandidateInput refresh;
        qreal offset = 0;
        if (!feedbackInput({"memoryRefresh", {}}, "memory:list", refresh, offset, clock, deadline)) return false;
        if (rendererCommandCount("memory:list") != refresh.before.listCount + 1 ||
            rendererCommandCount("memory:candidates:list") != refresh.before.candidateCount + 1) return false;
        const auto list = rendererCommandAt("memory:list", refresh.before.listCount)["request_id"].toString();
        const auto candidates = rendererCommandAt("memory:candidates:list", refresh.before.candidateCount)["request_id"].toString();
        if (list.isEmpty() || candidates.isEmpty() || list != refresh.requestId ||
            list == refresh.before.listId || candidates == refresh.before.candidateId || list == candidates) return false;
        deliverFeedbackMemories(list, rows);
        deliverCandidate(candidatePage(candidateRows(1, 100)), candidates);
        return feedbackLayoutSettled(deadline);
    }
    bool finishFeedbackAction(const CandidateInput &input, const QString &verb, const QJsonArray &rows,
                              const QDeadlineTimer &deadline, bool deleted = false) {
        MemoryActionProbe::ReceiptTracker tracker;
        if (!tracker.arm(m_bridge->scopeKey(), verb, input.envelope["payload"].toObject()["memory_id"].toString(),
                         input.before.actionId, input.before.listId, input.before.candidateId)) return false;
        const auto observe = [&] {
            const auto feedback = m_bridge->memoryFeedback();
            tracker.observe(m_bridge->scopeKey(), feedback.value("action").toMap(),
                            feedback.value("list").toMap(), feedback.value("candidates").toMap());
        };
        QObject receiver;
        connect(m_bridge.get(), &RuntimeBridge::changed, &receiver, observe);
        observe();
        const int framesBefore = m_frames.size();
        m_bridge->event({{"type", "memory:result"}, {"request_id", input.requestId},
                         {"payload", QJsonObject{{"ok", true}, {"deleted", deleted}}}});
        if (m_frames.size() != framesBefore + 2 || rendererCommandCount("memory:list") != input.before.listCount + 1 ||
            rendererCommandCount("memory:candidates:list") != input.before.candidateCount + 1) return false;
        const auto list = rendererCommandAt("memory:list", input.before.listCount)["request_id"].toString();
        const auto candidates = rendererCommandAt("memory:candidates:list", input.before.candidateCount)["request_id"].toString();
        if (list.isEmpty() || candidates.isEmpty() || list == input.before.listId || candidates == input.before.candidateId ||
            list == candidates || list == input.requestId || candidates == input.requestId) return false;
        deliverFeedbackMemories(list, rows);
        deliverCandidate(candidatePage(candidateRows(1, 100)), candidates);
        if (!feedbackLayoutSettled(deadline) || m_frames.size() != framesBefore + 2) return false;
        const auto feedback = m_bridge->memoryFeedback();
        return tracker.requestId() == input.requestId && tracker.matchesComplete(m_bridge->scopeKey(),
            feedback.value("action").toMap(), feedback.value("list").toMap(), feedback.value("candidates").toMap());
    }
    // The summary controls use the production TaskPanel and bridge writer.
    // Only fixture reads and explicit backend replies are supplied here; no
    // navigation success is produced by setting the tab's currentIndex.
    // Each input owns a content-free trace. Shared ownership keeps the signal
    // observers alive through its ACK/readback and every QVERIFY early return.
    struct SummaryEvidence {
        QString control, operation, test = QString::fromLatin1(QTest::currentTestFunction()),
            dataTag = QString::fromLatin1(QTest::currentDataTag() ? QTest::currentDataTag() : "");
        std::shared_ptr<SummaryInteractionProbe::SignalProbe> signalProbe =
            std::make_shared<SummaryInteractionProbe::SignalProbe>();
        QVariantList samples;
        QList<int> sampleKinds;
        QVariantMap last;
        int observations = 0;
        bool sealed = false, emitEnabled = false;
        SummaryEvidence(const QString &name, const QString &action) : control(name), operation(action) {}
        static QVariantMap flatSignals(QVariantMap value) {
            for (const auto *key : {"samples", "terminal", "terminalCount", "sampleLimit", "observations"})
                value.remove(key);
            return value;
        }
        void observe(QVariantMap state) {
            if (sealed) return;
            ++observations;
            state["signalProbe"] = flatSignals(signalProbe->metadata());
            last = state;
            const auto signal = state.value("signalProbe").toMap();
            const auto request = state.value("requestObservation").toMap();
            // Reserve bounded slots for the first pending publication and
            // actual input result; qualification polls cannot crowd them out.
            const int kind = !signal.value("armed").toBool() ? 0
                : signal.value("mouseDispatchCount").toInt() == 0 ? 1
                : request.value("readResponses").toInt() > 0 ? 5
                : request.value("saveResponses").toInt() > 0 ? 4
                : state.value("phase") == "save-readback" && request.value("savePending").toBool() ? 2 : 3;
            const auto index = sampleKinds.indexOf(kind);
            if (index < 0 && samples.size() < 6) { sampleKinds.append(kind); samples.append(state); }
            else if (index >= 0 && kind != 0 && kind != 2) samples[index] = state;
        }
        void seal() {
            if (sealed) return;
            signalProbe->terminal();
            last["signalProbe"] = flatSignals(signalProbe->metadata());
            last["phase"] = "terminal";
            sealed = true;
            signalProbe.reset();
        }
        ~SummaryEvidence() {
            if (!emitEnabled) return;
            seal();
            const auto emitRecord = [&](const QString &kind, const QVariantMap &state, int ordinal) {
                const QVariantMap record{{"schema", "reverie.qt.summary-input-probe.v1"},
                    {"case", test}, {"dataTag", dataTag}, {"control", control}, {"operation", operation}, {"kind", kind},
                    {"ordinal", ordinal}, {"sampleLimit", 6}, {"observations", observations},
                    {"state", state}};
                qInfo().noquote() << "SUMMARY_INPUT_PROBE" <<
                    QString::fromUtf8(QJsonDocument::fromVariant(record).toJson(QJsonDocument::Compact));
            };
            int ordinal = 0;
            for (const auto &sample : samples) emitRecord("process", sample.toMap(), ordinal++);
            emitRecord("terminal", last, ordinal);
        }
    };
    struct SummaryInput {
        QPointer<QQuickItem> item;
        QPoint point;
        // Physical mouse dispatches, independent of clicked/toggled signals.
        int clicks = 0;
        qint64 elapsedMs = -1, clickAtMs = -1;
        QDeadlineTimer readbackDeadline;
        QVariantMap layout;
        std::shared_ptr<SummaryEvidence> evidence;
    };
    struct SummaryRound {
        QString scope, oldSaveId, oldReadId, saveId, readId;
        qint64 generation = -1;
        qint64 clickAtMs = -1;
        QElapsedTimer inputClock;
        QDeadlineTimer readbackDeadline;
        bool expected = false;
        int savesBefore = 0, readsBefore = 0, framesBefore = 0;
        int saveResponses = 0, readResponses = 0;
        bool observerHealthy = true;
        QVariantMap save, read;
        SummaryInteractionProbe::ReceiptTracker receipt;
        std::shared_ptr<SummaryEvidence> evidence;
        // Destroy the receiver before any state referenced by its callbacks.
        std::unique_ptr<QObject> observer;
    };
    bool summaryFailure(const QString &reason) {
        m_summaryDiagnostic = reason;
        return false;
    }
    QVariantMap summaryRequestObservation(int savesBefore, int readsBefore, const SummaryRound *round) const {
        const int saves = rendererCommandCount("settings:update") - savesBefore;
        const int reads = rendererCommandCount("summary:status") - readsBefore;
        const auto save = saves > 0 ? rendererCommandAt("settings:update", savesBefore) : QJsonObject{};
        const auto payload = save["payload"].toObject();
        const auto actual = m_bridge->memoryFeedback().value("summary").toMap();
        const auto saveId = save["request_id"].toString();
        const auto readId = reads > 0 ? rendererCommandAt("summary:status", readsBefore)["request_id"].toString() : QString();
        const bool armed = round && round->observer && round->receipt.armed();
        return {{"source", "renderer-command-delta"}, {"observerArmed", armed},
            {"observedSaveRequestCount", armed ? QVariant(saves) : QVariant{}},
            {"observedReadRequestCount", armed ? QVariant(reads) : QVariant{}},
            {"rendererSettingsDelta", saves}, {"rendererReadDelta", reads},
            {"saveRequestId", saveId}, {"readRequestId", readId},
            {"sourceSaveId", round ? round->read.value("sourceSaveId") : QVariant{}},
            {"saveResponses", armed ? QVariant(round->saveResponses) : QVariant{}},
            {"readResponses", armed ? QVariant(round->readResponses) : QVariant{}},
            {"scope", m_bridge->scopeKey()}, {"generation", m_bridge->m_generation},
            {"expected", round ? QVariant(round->expected) : QVariant{}},
            {"saveIdentityMatches", armed ? QVariant(saves == 1 && !saveId.isEmpty() &&
                saveId != round->oldSaveId && actual.value("requestId").toString() == saveId) : QVariant{}},
            {"payloadMatches", armed ? QVariant(saves == 1 && payload["section"].toString() == "features" &&
                payload["hypa_compression_enabled"].isBool() &&
                payload["hypa_compression_enabled"].toBool() == round->expected) : QVariant{}},
            {"savePending", armed ? QVariant(actual.value("status").toString() == "pending") : QVariant{}}};
    }
    void cacheSummaryRound(SummaryRound &round, const QString &phase) {
        if (!round.evidence || round.evidence->sealed) return;
        round.evidence->signalProbe->observe("save-readback");
        auto state = round.evidence->last;
        state["phase"] = phase;
        state["elapsedMs"] = round.inputClock.isValid() ? QVariant(round.inputClock.elapsed()) : QVariant{};
        state["clickAtMs"] = round.clickAtMs < 0 ? QVariant{} : QVariant(round.clickAtMs);
        state["readbackRemainingMs"] = round.clickAtMs < 0 ? QVariant{} : QVariant(round.readbackDeadline.remainingTime());
        state["requestObservation"] = summaryRequestObservation(round.savesBefore, round.readsBefore, &round);
        state["requestCountDelta"] = m_frames.size() - round.framesBefore;
        state["receipt"] = round.receipt.metadata();
        state["observerHealthy"] = round.observerHealthy;
        state["failureReason"] = m_summaryDiagnostic;
        round.evidence->observe(state);
    }
    bool summarySelected() const {
        const auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        const auto *tab = profileItem("memoryTab-summary", ProfileScope::Page);
        return m_panel && m_panel->property("page").toString() == "memory" && tabs && tab &&
            tabs->property("currentIndex").toInt() == 1 && tab->property("accented").toBool();
    }
    bool summaryShownFromStatus(bool expected) const {
        const auto summary = m_bridge->state().value("summary").toMap();
        const auto feedback = m_bridge->memoryFeedback().value("summary").toMap();
        const auto *toggle = profileItem("summaryEnabled", ProfileScope::Page);
        const auto *status = profileItem("summaryStatus", ProfileScope::Page);
        return summarySelected() && summary.value("ok").toBool() &&
            summary.value("enabled").metaType() == QMetaType::fromType<bool>() &&
            summary.value("enabled").toBool() == expected && !feedback.contains("enabled") &&
            toggle && toggle->isVisible() && toggle->isEnabled() &&
            toggle->property("checked").toBool() == expected && status && status->isVisible();
    }
    static QString summaryReadId(int index) {
        return "summary_" + QString("%1").arg(index, 32, 16, QLatin1Char('0'));
    }
    static QJsonObject summaryReadRow(int index) {
        return {{"summary_id", summaryReadId(index)}, {"sourceDigest", QString(64, QLatin1Char('a'))},
            {"firstSequence", index * 2 + 1}, {"lastSequence", index * 2 + 2},
            {"messageIds", QJsonArray{QString("summary-source-%1-user").arg(index),
                QString("summary-source-%1-assistant").arg(index)}},
            {"contractVersion", "reverie.conversation-summary.v1"}};
    }
    static QJsonArray summaryReadRows(int count) {
        QJsonArray rows;
        for (int index = 0; index < count; ++index) rows.append(summaryReadRow(index));
        return rows;
    }
    QJsonObject summaryReadPayload(const QJsonArray &rows, int total = -1, bool more = false) const {
        if (total < 0) total = rows.size();
        return {{"ok", true}, {"operation", "status"}, {"conversation_id", "dream-room"},
            {"enabled", false}, {"status", "disabled"}, {"activeCount", total},
            {"summaries", rows}, {"summaryTotal", total}, {"hasMore", more},
            {"persona_id", m_bridge->m_persona["persona_id"]},
            {"persona_epoch", m_bridge->m_persona["epoch"]},
            {"persona_fingerprint", m_bridge->m_persona["fingerprint"]}};
    }
    void deliverSummaryDirectory(const QString &requestId, const QJsonArray &rows,
                                 int total = -1, bool more = false) {
        m_bridge->event({{"type", "summary:result"}, {"request_id", requestId},
            {"payload", summaryReadPayload(rows, total, more)}});
    }
    QJsonObject summaryReadDetailPayload(int index, const QString &text) const {
        auto summary = summaryReadRow(index);
        summary["text"] = text;
        return {{"ok", true}, {"operation", "detail"}, {"conversation_id", "dream-room"},
            {"summary", summary}, {"persona_id", m_bridge->m_persona["persona_id"]},
            {"persona_epoch", m_bridge->m_persona["epoch"]},
            {"persona_fingerprint", m_bridge->m_persona["fingerprint"]}};
    }
    void deliverSummaryDetail(const QString &requestId, int index, const QString &text) {
        m_bridge->event({{"type", "summary:result"}, {"request_id", requestId},
            {"payload", summaryReadDetailPayload(index, text)}});
    }
    bool clickSummaryReadControl(const QString &name) {
        return revealProfileEntry(name) && clickProfileItem(name, ProfileScope::Page);
    }
    struct SummaryDirectoryRead {
        int count = 0, generation = -1;
        QString previousId, requestId, scope;
        QJsonObject persona;
    };
    SummaryDirectoryRead summaryReadDirectoryBaseline() const {
        return {rendererCommandCount("summary:status"), m_bridge->m_generation,
            lastRendererCommand("summary:status")["request_id"].toString(), {},
            m_bridge->scopeKey(), m_bridge->m_persona};
    }
    bool summaryReadDirectoryStage(const QString &layer, const SummaryDirectoryRead &read,
                                   bool passed, QJsonObject state = {}) {
        const auto scope = m_bridge->scopeKey();
        const QJsonObject context{{"layer", layer}, {"passed", passed}, {"requestId", read.requestId.left(80)},
            {"requestIdLength", read.requestId.size()}, {"previousRequestId", read.previousId.left(80)},
            {"latestRequestId", m_bridge->m_summaryStatusReadId.left(80)},
            {"scope", read.scope.left(160)}, {"scopeLength", read.scope.size()},
            {"currentScope", scope.left(160)}, {"currentScopeLength", scope.size()},
            {"generation", read.generation}, {"currentGeneration", m_bridge->m_generation},
            {"statusCountBefore", read.count}, {"statusCount", rendererCommandCount("summary:status")}};
        for (auto it = context.begin(); it != context.end(); ++it)
            state.insert(it.key(), it.value());
        if (!passed) return profileFailure("summary-read-directory-" + layer, state);
        qInfo().noquote() << "SUMMARY_DIRECTORY_FIXTURE" << compactDiagnostic(state);
        return true;
    }
    bool correlateSummaryReadDirectory(SummaryDirectoryRead &read) {
        const auto envelope = rendererCommandAt("summary:status", read.count);
        read.requestId = envelope["request_id"].toString();
        int occurrences = 0, currentPending = 0;
        for (const auto &frame : m_frames)
            occurrences += !read.requestId.isEmpty() &&
                frame["envelope"].toObject()["request_id"].toString() == read.requestId;
        for (auto it = m_bridge->m_pending.cbegin(); it != m_bridge->m_pending.cend(); ++it)
            currentPending += it->command == "summary:status" && it->generation == read.generation;
        const auto pending = m_bridge->m_pending.constFind(read.requestId);
        const bool present = pending != m_bridge->m_pending.cend();
        const bool payloadMatches = envelope["payload"].toObject() ==
            QJsonObject{{"conversation_id", "dream-room"}};
        return summaryReadDirectoryStage("request", read,
            rendererCommandCount("summary:status") == read.count + 1 && !read.requestId.isEmpty() &&
            read.requestId != read.previousId && occurrences == 1 && currentPending == 1 && present &&
            pending->command == "summary:status" && pending->generation == read.generation &&
            m_bridge->m_summaryStatusReadId == read.requestId && payloadMatches &&
            m_bridge->m_generation == read.generation && m_bridge->scopeKey() == read.scope &&
            m_bridge->m_persona == read.persona,
            {{"requestIdOccurrences", occurrences}, {"currentStatusPendingCount", currentPending},
                {"pendingPresent", present},
                {"pendingCommandMatches", present ? QJsonValue(pending->command == "summary:status") : QJsonValue(QJsonValue::Null)},
                {"pendingGeneration", present ? QJsonValue(pending->generation) : QJsonValue(QJsonValue::Null)},
                {"payloadMatches", payloadMatches}, {"personaMatches", m_bridge->m_persona == read.persona}});
    }
    static QJsonObject summaryReadValueShape(QVariant value) {
        QJsonObject shape{{"valid", value.isValid()},
            {"typeId", value.isValid() ? QJsonValue(value.metaType().id()) : QJsonValue(QJsonValue::Null)},
            {"typeName", value.isValid() ? QJsonValue(QString::fromLatin1(value.metaType().name()).left(80)) : QJsonValue(QJsonValue::Null)},
            {"null", value.isValid() ? QJsonValue(value.isNull()) : QJsonValue(QJsonValue::Null)},
            {"length", QJsonValue(QJsonValue::Null)}};
        if (value.metaType() == QMetaType::fromType<QJSValue>()) {
            const auto js = value.value<QJSValue>();
            shape["jsNull"] = js.isNull();
            shape["jsUndefined"] = js.isUndefined();
            shape["jsObject"] = js.isObject();
            shape["jsArray"] = js.isArray();
            const auto length = js.isObject() ? js.property("length") : QJSValue();
            if (length.isNumber() && std::isfinite(length.toNumber()))
                shape["length"] = length.toNumber();
            value = js.toVariant();
        }
        if (value.metaType() == QMetaType::fromType<QVariantList>())
            shape["length"] = value.toList().size();
        return shape;
    }
    bool acceptSummaryReadDirectory(const SummaryDirectoryRead &read, const QJsonArray &expectedRows,
                                    bool expectedReady, bool expectedOk,
                                    const QDeadlineTimer *deadline = nullptr) {
        const auto wait = [&](const std::function<bool()> &condition) {
            if (!deadline) return condition();
            return QTest::qWaitFor([&] { return !deadline->hasExpired() && condition(); }, *deadline) &&
                !deadline->hasExpired();
        };
        const auto observedBool = [](const QVariant &value) {
            return value.metaType() == QMetaType::fromType<bool>()
                ? QJsonValue(value.toBool()) : QJsonValue(QJsonValue::Null);
        };
        const auto cppAccepted = [&] {
            const auto summary = m_bridge->state().value("summary").toMap();
            const auto rows = summary.value("summaries");
            return m_bridge->m_summaryStatusReadId == read.requestId && !m_bridge->m_pending.contains(read.requestId) &&
                rendererCommandCount("summary:status") == read.count + 1 &&
                m_bridge->m_generation == read.generation && m_bridge->scopeKey() == read.scope &&
                m_bridge->m_persona == read.persona && observedBool(summary.value("ok")) == QJsonValue(expectedOk) &&
                observedBool(summary.value("directoryReady")) == QJsonValue(expectedReady) &&
                rows.metaType() == QMetaType::fromType<QVariantList>() &&
                QJsonArray::fromVariantList(rows.toList()) == expectedRows &&
                m_bridge->m_summaryDirectory.size() == expectedRows.size() &&
                m_bridge->m_summaryDirectoryGeneration == (expectedReady ? read.generation : -1) &&
                m_bridge->m_summaryDirectoryPersona == (expectedReady ? read.persona : QJsonObject{});
        };
        const bool cppReady = wait(cppAccepted);
        const auto summary = m_bridge->state().value("summary").toMap();
        const auto cppRows = summary.value("summaries");
        if (!summaryReadDirectoryStage("cpp", read, cppReady,
            {{"expectedReady", expectedReady}, {"directoryReady", observedBool(summary.value("directoryReady"))},
                {"expectedOk", expectedOk}, {"ok", observedBool(summary.value("ok"))},
                {"expectedCount", expectedRows.size()}, {"rows", summaryReadValueShape(cppRows)},
                {"rowsMatch", cppRows.metaType() == QMetaType::fromType<QVariantList>() &&
                    QJsonArray::fromVariantList(cppRows.toList()) == expectedRows},
                {"directoryGeneration", m_bridge->m_summaryDirectoryGeneration},
                {"directoryPersonaMatches", m_bridge->m_summaryDirectoryPersona == read.persona},
                {"pendingConsumed", !m_bridge->m_pending.contains(read.requestId)}})) return false;
        const bool qmlReady = wait([&] {
            return m_panel && observedBool(m_panel->property("summaryDirectoryValid")) == QJsonValue(expectedReady);
        });
        auto directory = m_panel ? m_panel->property("summaryDirectory") : QVariant{};
        const auto sourceRows = directory.metaType() == QMetaType::fromType<QJSValue>()
            ? QVariant::fromValue(directory.value<QJSValue>().property("summaries"))
            : directory.toMap().value("summaries");
        if (!summaryReadDirectoryStage("qml", read, qmlReady,
            {{"expectedValid", expectedReady},
                {"summaryDirectoryValid", observedBool(m_panel ? m_panel->property("summaryDirectoryValid") : QVariant{})},
                {"sourceRows", summaryReadValueShape(sourceRows)},
                {"rows", summaryReadValueShape(m_panel ? m_panel->property("summaryDirectoryRows") : QVariant{})}})) return false;
        const bool modelReady = wait([&] {
            const auto *list = profileItem("summaryDirectoryList", ProfileScope::Page);
            const auto count = list ? list->property("count") : QVariant{};
            return count.metaType() == QMetaType::fromType<int>() && count.toInt() == expectedRows.size();
        });
        const auto *list = profileItem("summaryDirectoryList", ProfileScope::Page);
        return summaryReadDirectoryStage("model", read, modelReady,
            {{"expectedCount", expectedRows.size()},
                {"count", list ? QJsonValue::fromVariant(list->property("count")) : QJsonValue(QJsonValue::Null)},
                {"model", summaryReadValueShape(list ? list->property("model") : QVariant{})}});
    }
    bool prepareSummaryReadPanel(const QJsonArray &rows, int width = 760, int height = 650,
                                 int total = -1, bool more = false) {
        loadPanel();
        if (QTest::currentTestFailed() || !m_panel || !m_window) return false;
        m_window->resize(width, height);
        if (!m_panel->setProperty("page", "memory")) return false;
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        if (!tabs || !tabs->setProperty("currentIndex", 1)) return false;
        auto read = summaryReadDirectoryBaseline();
        if (!clickSummaryReadControl("summaryDirectoryRefresh")) return false;
        if (!correlateSummaryReadDirectory(read)) return false;
        deliverSummaryDirectory(read.requestId, rows, total, more);
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        if (!acceptSummaryReadDirectory(read, rows, true, true, &deadline)) return false;
        return feedbackLayoutSettled(deadline) && profileItem("summaryDirectoryList", ProfileScope::Page);
    }
    bool prepareSummaryPanel(int width, int height, bool enabled) {
        m_summaryDiagnostic.clear();
        loadPanel();
        if (!m_panel || !m_window) return summaryFailure("summary-fixture-unavailable");
        m_window->resize(width, height);
        setCandidateFocusWindow(m_window.get());
        if (QGuiApplication::focusWindow() != m_window.get() || !m_window->isActive())
            return summaryFailure("summary-fixture-window-not-active");
        if (!m_panel->setProperty("page", "memory")) return summaryFailure("summary-memory-page-unavailable");
        const auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        if (!tabs || tabs->property("currentIndex").toInt() != 0)
            return summaryFailure("summary-fixture-default-tab-changed");
        m_bridge->refreshMemories();
        const auto list = lastRendererCommand("memory:list")["request_id"].toString();
        const auto candidates = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        if (list.isEmpty() || candidates.isEmpty()) return summaryFailure("summary-fixture-list-read-missing");
        deliverFeedbackMemories(list, feedbackMemoryRows(100));
        deliverCandidate(candidatePage(QJsonArray{}), candidates);
        const auto status = m_bridge->request("summary:status");
        if (status.isEmpty()) return summaryFailure("summary-fixture-status-read-missing");
        deliverSummaryStatus(status, enabled);
        trackCandidateFrames();
        const QDeadlineTimer preparation(4000, Qt::PreciseTimer);
        if (!feedbackLayoutSettled(preparation)) return summaryFailure("summary-fixture-layout-timeout");
        auto *content = feedbackScrollContent();
        if (!content) return summaryFailure("summary-fixture-scroll-missing");
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        if (!std::isfinite(maximum) || maximum - minimum <= 3 * content->height() ||
            !content->setProperty("contentY", maximum - content->height() / 2))
            return summaryFailure("summary-fixture-not-a-deep-list");
        if (!feedbackLayoutSettled(preparation)) return summaryFailure("summary-fixture-deep-layout-timeout");
        const auto observation = SummaryInteractionProbe::inspect(
            profileItem("memoryTab-summary", ProfileScope::Page), m_window.get(), true, m_bridge->scopeKey());
        if (observation.eligible || content->property("contentY").toDouble() <= content->height())
            return summaryFailure("summary-fixture-tab-not-clipped");
        return true;
    }
    void deliverSummaryStatus(const QString &id, bool enabled) {
        m_bridge->event({{"type", "summary:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", true}, {"operation", "status"}, {"enabled", enabled},
                {"status", enabled ? QString("idle") : QString("disabled")}, {"activeCount", 0},
                {"persona_id", m_bridge->m_persona["persona_id"]},
                {"persona_epoch", m_bridge->m_persona["epoch"]},
                {"persona_fingerprint", m_bridge->m_persona["fingerprint"]}}}});
    }
    bool clickSummaryControl(const QString &name, QElapsedTimer &clock, const QDeadlineTimer &deadline,
                             SummaryInput &input, SummaryRound *round = nullptr) {
        const auto scope = m_bridge->scopeKey();
        SummaryInteractionProbe::StableGate layout;
        NativeControlReadiness::SequentialGate sequence;
        const int savesBefore = round ? round->savesBefore : rendererCommandCount("settings:update");
        const int readsBefore = round ? round->readsBefore : rendererCommandCount("summary:status");
        const int framesBefore = round ? round->framesBefore : m_frames.size();
        bool accepted = false;
        input.evidence = round ? round->evidence : std::make_shared<SummaryEvidence>(name, "tab");
        input.evidence->emitEnabled = true;
        auto &probe = *input.evidence->signalProbe;
        const auto cache = [&](const QString &phase) {
            probe.observe(phase);
            QVariantMap state{{"phase", phase}, {"control", name}, {"scope", m_bridge->scopeKey()},
                {"generation", m_bridge->m_generation}, {"selected", summarySelected()},
                {"elapsedMs", clock.elapsed()}, {"clickAtMs", input.clickAtMs < 0 ? QVariant{} : QVariant(input.clickAtMs)},
                {"readbackRemainingMs", !round || input.clickAtMs < 0 ? QVariant{} : QVariant(input.readbackDeadline.remainingTime())},
                {"requestCountDelta", m_frames.size() - framesBefore},
                {"requestObservation", summaryRequestObservation(savesBefore, readsBefore, round)},
                {"layout", layout.metadata()}, {"inputAccepted", accepted}, {"failureReason", m_summaryDiagnostic}};
            if (round) state["receipt"] = round->receipt.metadata();
            input.evidence->observe(state);
        };
        // Declared after probe/layout: every early return and exception caches
        // the measured counts and writer identities while all objects live.
        const auto finalObservation = qScopeGuard([&] {
            input.layout = layout.metadata();
            cache(input.clickAtMs < 0 ? "before-input" : "after-input");
            if (!accepted || !round) input.evidence->seal();
        });
        const auto available = [&] {
            return m_panel && m_panel->isVisible() && m_panel->property("page").toString() == "memory" &&
                m_bridge->scopeKey() == scope && (name != "summaryEnabled" || summarySelected());
        };
        const std::vector<NativeControlReadiness::SequentialGate::Action> actions{{name,
            [&] { return profileItem(name, ProfileScope::Page); },
            [&](QQuickItem *item) {
                const auto current = SummaryInteractionProbe::inspect(item, m_window.get(), available(), scope);
                return layout.observe(current, clock.elapsed(), m_candidateFrameSerial);
            }, [&](QQuickItem *item) {
                const auto fresh = SummaryInteractionProbe::inspect(
                    profileItem(name, ProfileScope::Page), m_window.get(), available(), scope);
                cache("before-input");
                if (deadline.hasExpired() || clock.elapsed() >= 4000 || fresh.item != item || !layout.matches(fresh))
                    throw std::runtime_error("summary-input-target-changed");
                const bool armed = probe.arm(item);
                cache("before-input");
                if (!armed) throw std::runtime_error("summary-signal-observer-invalid");
                if (name == "summaryEnabled" && (!round || !round->observer || !round->receipt.armed()))
                    throw std::runtime_error("summary-request-observer-not-armed");
                input.item = item; input.point = fresh.point; input.elapsedMs = clock.elapsed();
                if (deadline.hasExpired() || input.elapsedMs >= 4000)
                    throw std::runtime_error("summary-input-deadline");
                // Establish the absolute read deadline before dispatch. Later
                // ACK code copies this deadline instead of granting ten more seconds.
                if (round) input.readbackDeadline = QDeadlineTimer(10000, Qt::PreciseTimer);
                cache("before-input");
                input.elapsedMs = clock.elapsed();
                if (deadline.hasExpired() || input.elapsedMs >= 4000)
                    throw std::runtime_error("summary-input-deadline");
                input.clickAtMs = input.elapsedMs;
                if (round) {
                    round->inputClock = clock;
                    round->clickAtMs = input.clickAtMs;
                    round->readbackDeadline = input.readbackDeadline;
                }
                probe.recordMouseDispatch();
                ++input.clicks;
                QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, fresh.point, 0);
                cache("after-input");
                const auto failure = SummaryInteractionProbe::inputFailure(name, probe.counts());
                if (!failure.isEmpty()) throw std::runtime_error(failure.toStdString());
                if (name == "memoryTab-summary" && (m_frames.size() != framesBefore || !summarySelected()))
                    throw std::runtime_error("summary-tab-selection-or-rpc");
            }}};
        try {
            const bool performed = QTest::qWaitFor([&] {
                if (deadline.hasExpired()) return false;
                const auto result = sequence.poll([&] { return clock.elapsed(); }, 4000, actions);
                m_window->update();
                return result == NativeControlReadiness::SequentialGate::Performed;
            }, deadline);
            cache("after-input");
            if (!performed || deadline.hasExpired() ||
                !SummaryInteractionProbe::inputContract(name, probe.counts()))
                return summaryFailure("summary-input-not-performed:" + name);
            accepted = true;
            return true;
        } catch (const std::exception &error) {
            return summaryFailure(QString::fromUtf8(error.what()));
        }
    }
    bool armSummaryRound(SummaryRound &round, bool expected, const QString &operation = "change") {
        round.scope = m_bridge->scopeKey(); round.generation = m_bridge->m_generation; round.expected = expected;
        round.oldSaveId = m_bridge->memoryFeedback().value("summary").toMap().value("requestId").toString();
        round.oldReadId = lastRendererCommand("summary:status")["request_id"].toString();
        round.savesBefore = rendererCommandCount("settings:update");
        round.readsBefore = rendererCommandCount("summary:status"); round.framesBefore = m_frames.size();
        round.evidence = std::make_shared<SummaryEvidence>("summaryEnabled", operation);
        const bool armed = round.receipt.arm(round.scope, round.generation, expected, round.oldSaveId, round.oldReadId);
        cacheSummaryRound(round, "before-input");
        if (!armed) return summaryRoundFailure(round, "summary-receipt-arm-failed");
        round.observer = std::make_unique<QObject>();
        // QML's onToggled may publish pending before a test toggled observer
        // runs. Capture bridge identity changes independently, before input.
        connect(m_bridge.get(), &RuntimeBridge::changed, round.observer.get(),
            [this, &round] { observeSummaryRound(round); }, Qt::DirectConnection);
        connect(m_bridge.get(), &RuntimeBridge::responseReceived, round.observer.get(),
            [this, &round](const QString &id, const QString &command, const QVariantMap &result, int generation) {
                if (round.evidence && round.evidence->sealed) return;
                observeSummaryRound(round);
                if (generation != round.generation || m_bridge->scopeKey() != round.scope) {
                    round.observerHealthy = false;
                } else if (command == "settings:update" && id == round.saveId) {
                    ++round.saveResponses;
                    QStringList reads;
                    for (const auto &value : m_bridge->diagnostics().value("pendingCommands").toList()) {
                        const auto pending = value.toMap();
                        if (pending.value("command").toString() == "summary:status" &&
                            pending.value("generation").toLongLong() == round.generation &&
                            pending.value("id").toString() != round.oldReadId)
                            reads.append(pending.value("id").toString());
                    }
                    if (reads.size() != 1 || !result.value("ok").toBool()) {
                        round.observerHealthy = false;
                    } else {
                        round.readId = reads.first();
                        round.read = {{"requestId", round.readId}, {"status", "pending"},
                            {"sourceSaveId", round.saveId}, {"command", "summary:status"}};
                    }
                } else if (command == "summary:status" && id == round.readId) {
                    ++round.readResponses;
                    const bool valid = result.value("ok").toBool() && result.value("operation").toString() == "status" &&
                        result.value("enabled").metaType() == QMetaType::fromType<bool>();
                    round.read["status"] = valid ? "success" : "error";
                }
                round.receipt.observe(m_bridge->scopeKey(), m_bridge->m_generation, round.save, round.read,
                    m_bridge->state().value("summary").toMap());
                cacheSummaryRound(round, "save-readback");
            }, Qt::DirectConnection);
        connect(m_bridge.get(), &RuntimeBridge::requestFailed, round.observer.get(),
            [this, &round](const QString &id, const QString &, int generation) {
                if (round.evidence && round.evidence->sealed) return;
                if (generation != round.generation || id == round.saveId || id == round.readId)
                    round.observerHealthy = false;
                cacheSummaryRound(round, "save-readback");
            }, Qt::DirectConnection);
        cacheSummaryRound(round, "before-input");
        return true;
    }
    void observeSummaryRound(SummaryRound &round) {
        if (!round.observer || (round.evidence && round.evidence->sealed)) return;
        const auto actual = m_bridge->memoryFeedback().value("summary").toMap();
        const auto id = actual.value("requestId").toString();
        if (!id.isEmpty() && id != round.oldSaveId) {
            if (round.saveId.isEmpty()) round.saveId = id;
            else if (round.saveId != id) round.observerHealthy = false;
            round.save = actual;
        }
        round.receipt.observe(m_bridge->scopeKey(), m_bridge->m_generation, round.save, round.read,
            m_bridge->state().value("summary").toMap());
        cacheSummaryRound(round, "save-readback");
    }
    bool summaryRoundFailure(SummaryRound &round, const QString &reason) {
        summaryFailure(reason);
        cacheSummaryRound(round, "save-readback");
        return false;
    }
    bool summarySaveWasDispatched(SummaryRound &round) {
        observeSummaryRound(round);
        const auto envelope = rendererCommandAt("settings:update", round.savesBefore);
        const auto payload = envelope["payload"].toObject();
        const auto actual = m_bridge->memoryFeedback().value("summary").toMap();
        const int reads = rendererCommandCount("summary:status") - round.readsBefore;
        // Cache the actual writer delta and identity before any rejection. A
        // fast legitimate ACK/read may already have replaced pending by success.
        cacheSummaryRound(round, "after-input");
        if (!round.observerHealthy || rendererCommandCount("settings:update") != round.savesBefore + 1 ||
            reads < 0 || reads > 1 || m_frames.size() != round.framesBefore + 1 + reads ||
            round.saveId.isEmpty() || round.saveId == round.oldSaveId ||
            envelope["request_id"].toString() != round.saveId || actual.value("requestId").toString() != round.saveId ||
            payload["section"].toString() != "features" || !payload["hypa_compression_enabled"].isBool() ||
            payload["hypa_compression_enabled"].toBool() != round.expected ||
            !QStringList{"pending", "success"}.contains(actual.value("status").toString()) || round.receipt.failed())
            return summaryRoundFailure(round, "summary-save-dispatch-identity");
        return true;
    }
    bool acknowledgeSummaryRound(SummaryRound &round, bool returnedValue, const QDeadlineTimer &deadline) {
        cacheSummaryRound(round, "save-readback");
        if (deadline.hasExpired()) return summaryRoundFailure(round, "summary-readback-deadline-before-ack");
        // The observers were installed by armSummaryRound before mouse input.
        // Do not inject a second ACK if a fast response was already captured.
        if (round.saveResponses == 0) {
            m_bridge->event({{"type", "settings:update:result"}, {"request_id", round.saveId},
                {"payload", QJsonObject{{"ok", true},
                    {"features", QJsonObject{{"hypa_compression_enabled", round.expected}}}}}});
        }
        cacheSummaryRound(round, "save-readback");
        if (!round.observerHealthy || round.saveResponses != 1 || round.readResponses > 1 || round.readId.isEmpty() ||
            round.readId == round.oldReadId || round.readId == round.saveId ||
            rendererCommandCount("settings:update") != round.savesBefore + 1 ||
            rendererCommandCount("summary:status") != round.readsBefore + 1 ||
            lastRendererCommand("summary:status")["request_id"].toString() != round.readId ||
            m_frames.size() != round.framesBefore + 2 || round.receipt.failed())
            return summaryRoundFailure(round, "summary-ack-not-correlated-with-new-read");
        if (deadline.hasExpired()) return summaryRoundFailure(round, "summary-readback-deadline-before-status");
        if (round.readResponses == 0) deliverSummaryStatus(round.readId, returnedValue);
        cacheSummaryRound(round, "save-readback");
        if (!round.observerHealthy || round.saveResponses != 1 || round.readResponses != 1 ||
            rendererCommandCount("settings:update") != round.savesBefore + 1 ||
            rendererCommandCount("summary:status") != round.readsBefore + 1 || m_frames.size() != round.framesBefore + 2)
            return summaryRoundFailure(round, "summary-readback-response-identity");
        // responseReceived precedes the final changed notification. Inspect
        // QML only after a presented frame and its queued event have settled.
        if (!feedbackLayoutSettled(deadline)) return summaryRoundFailure(round, "summary-readback-layout-timeout");
        cacheSummaryRound(round, "save-readback");
        if (!round.evidence || !SummaryInteractionProbe::inputContract("summaryEnabled", round.evidence->signalProbe->counts()))
            return summaryRoundFailure(round, "summary-terminal-input-contract");
        bool passed = false;
        if (returnedValue != round.expected) {
            passed = round.receipt.failed() && !round.receipt.complete();
        } else {
            const auto receipt = m_bridge->memoryFeedback().value("summary").toMap();
            auto *feedback = profileItem("summaryFeedback", ProfileScope::Page);
            passed = !deadline.hasExpired() && round.receipt.matchesComplete(m_bridge->scopeKey(), m_bridge->m_generation,
                receipt, round.read, m_bridge->state().value("summary").toMap()) &&
                summaryShownFromStatus(round.expected) && receipt.value("status").toString() == "success" &&
                receipt.value("requestId").toString() == round.saveId && feedback &&
                feedback->property("text").toString() == receipt.value("text").toString() &&
                !receipt.value("text").toString().isEmpty() && feedbackItemFullyVisible(feedback);
        }
        if (!passed) return summaryRoundFailure(round, "summary-readback-validation");
        // Freeze this round's values before restore changes global feedback.
        cacheSummaryRound(round, "save-readback");
        if (deadline.hasExpired()) return summaryRoundFailure(round, "summary-readback-deadline-before-seal");
        round.evidence->seal();
        round.observer.reset();
        return true;
    }
    void chooseCard() {
        m_bridge->choosePersonaCard(QUrl::fromLocalFile(m_data->filePath("local.json")));
        QCOMPARE(m_bridge->personaCardFeedback().value("status").toString(), QString("confirmation"));
        QCOMPARE(m_bridge->personaCardCandidate().value("scopeKey").toString(), m_bridge->scopeKey());
        QCOMPARE(m_bridge->m_personaCardJson.toUtf8(), cardJson());
    }
    void readConfirmationWithoutDispatch() {
        const int writesBefore = m_frames.size();
        auto *filename = m_panel->findChild<QQuickItem *>("personaImportFilename");
        QVERIFY(filename);
        QCOMPARE(filename->property("text").toString(), QString("local.json"));
        auto exposedCandidate = m_panel->property("personaCardCandidate");
        if (exposedCandidate.metaType() == QMetaType::fromType<QJSValue>())
            exposedCandidate = exposedCandidate.value<QJSValue>().toVariant();
        QCOMPARE(exposedCandidate.toMap(), m_bridge->personaCardCandidate());
        QCOMPARE(m_bridge->personaCardCandidate().value("filename").toString(), QString("local.json"));
        QCoreApplication::processEvents();
        QCOMPARE(m_frames.size(), writesBefore);
        QCOMPARE(importCount(), 0);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void clickButton(const QString &name) {
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        auto *button = m_panel->findChild<QQuickItem *>(name);
        QVERIFY(button);
        QVERIFY(button->isVisible() && button->isEnabled());
        QVERIFY(button->width() > 0 && button->height() > 0);
        QCOMPARE(button->window(), m_window.get());
        const QPoint point = button->mapToScene(QPointF(button->width() / 2, button->height() / 2)).toPoint();
        QVERIFY(QRect(QPoint(), m_window->size()).contains(point));
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
    }
    void verifyButtonResult(bool confirmed) {
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QVERIFY(m_bridge->personaCardCandidate().isEmpty());
        QVERIFY(m_bridge->m_personaCardJson.isEmpty());
        QCOMPARE(importCount(), confirmed ? 1 : 0);
        QCOMPARE(m_frames.size(), confirmed ? 1 : 0);
        if (confirmed) {
            const auto sent = m_frames.first();
            const auto envelope = sent.value("envelope").toObject();
            const auto payload = envelope.value("payload").toObject();
            QCOMPARE(sent.value("schema").toString(), QString("reverie.command.v4"));
            QCOMPARE(envelope.value("command").toString(), QString("persona:import"));
            QCOMPARE(envelope.value("persona").toObject(), m_bridge->m_persona);
            QCOMPARE(payload.value("json").toString().toUtf8(), cardJson());
            QCOMPARE(payload.value("filename").toString(), QString("local.json"));
            QVERIFY(payload.value("identity_change_confirmed").toBool());
            QCOMPARE(payload.value("actor").toString(), QString("owner"));
            QCOMPARE(m_bridge->personaCardFeedback().value("status").toString(), QString("pending"));
        } else {
            QVERIFY(m_bridge->personaCardFeedback().isEmpty());
            emit m_bridge->changed();
            QCoreApplication::processEvents();
            QVERIFY(!m_dialog->property("visible").toBool());
            QCOMPARE(importCount(), 0);
        }
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }

    static QJsonObject priorityFixtureArchive(const QJsonValue &priority, bool regex) {
        return {{"characters", QJsonArray{}}, {"activeCharacterIds", QJsonArray{}},
            {"worldBooks", QJsonArray{QJsonObject{{"id", "priority-book"}, {"name", "优先级夹具"},
                {"tokenBudget", 8}, {"entries", QJsonArray{QJsonObject{{"id", "priority-a"},
                    {"comment", "A"}, {"content", "PRIORITY_A_ONLY"}, {"priority", priority},
                    {"insertionOrder", 10}, {"keywords", QJsonArray{"hello"}},
                    {"secondaryKeywords", QJsonArray{}}, {"selectiveLogic", "and_any"},
                    {"useRegex", regex}, {"enabled", true}, {"alwaysActive", true},
                    {"position", "after_char"}, {"depth", 7}, {"role", "assistant"}}}}}}}};
    }
    // Successful archive:put responses materialize the two nullable entry
    // settings, as the store does. Reads and fault responses keep their input.
    static QJsonObject normalizedEntrySettingsReceipt(QJsonObject archive) {
        auto books = archive["worldBooks"].toArray();
        for (qsizetype b = 0; b < books.size(); ++b) {
            auto book = books[b].toObject();
            auto entries = book["entries"].toArray();
            for (qsizetype e = 0; e < entries.size(); ++e) {
                auto entry = entries[e].toObject();
                for (const auto *key : {"scanDepth", "tokenBudget"})
                    if (!entry.contains(key)) entry[key] = QJsonValue(QJsonValue::Null);
                entries[e] = entry;
            }
            book["entries"] = entries;
            books[b] = book;
        }
        archive["worldBooks"] = books;
        return archive;
    }
    void priorityFixtureResponse(const QString &id, const QJsonObject &archive, int revision) {
        m_bridge->event({{"type", "archive:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", true}, {"exists", true}, {"revision", revision},
                {"archive", archive}, {"checksum", "fixture-checksum"}}}});
    }
    bool loadPriorityDrawer(const QJsonValue &priority, bool regex, int width = 760) {
        return loadArchiveDrawer(priorityFixtureArchive(priority, regex), width, true);
    }
    // The book-settings view: the book is selected and no entry is.
    static QJsonObject bookSettingsFixtureArchive(const QJsonValue &scanDepth, const QJsonValue &tokenBudget,
                                                  const QJsonValue &recursive) {
        auto archive = priorityFixtureArchive(0, false);
        auto books = archive["worldBooks"].toArray();
        auto book = books[0].toObject();
        book["scanDepth"] = scanDepth; book["tokenBudget"] = tokenBudget; book["recursiveScanning"] = recursive;
        book["createdAt"] = "fixture-created";
        books[0] = book; archive["worldBooks"] = books;
        return archive;
    }
    // The entry view: an undefined value leaves the field absent.
    static QJsonObject entrySettingsFixtureArchive(const QJsonValue &scanDepth, const QJsonValue &tokenBudget,
                                                   const QJsonValue &bookBudget = QJsonValue(100)) {
        auto archive = bookSettingsFixtureArchive(1, 100, false);
        auto books = archive["worldBooks"].toArray();
        auto book = books[0].toObject();
        if (bookBudget.isUndefined()) book.remove("tokenBudget"); else book["tokenBudget"] = bookBudget;
        auto entries = book["entries"].toArray();
        auto entry = entries[0].toObject();
        if (scanDepth.isUndefined()) entry.remove("scanDepth"); else entry["scanDepth"] = scanDepth;
        if (tokenBudget.isUndefined()) entry.remove("tokenBudget"); else entry["tokenBudget"] = tokenBudget;
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        return archive;
    }
    static QJsonObject insertionFixtureArchive(const QString &position = "at_depth", const QJsonValue &depth = QJsonValue(2),
                                               const QJsonValue &role = QJsonValue("system")) {
        auto archive = entrySettingsFixtureArchive(QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Null));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["position"] = position; entry["depth"] = depth; entry["role"] = role;
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        return archive;
    }
    static QJsonObject regexFixtureArchive(bool regex = true,
            const QJsonArray &primary = QJsonArray{QStringLiteral("ID-(?:\\d{4})")},
            const QJsonArray &secondary = QJsonArray{QStringLiteral("aux.*")}) {
        auto archive = entrySettingsFixtureArchive(QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Null));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["useRegex"] = regex; entry["keywords"] = primary; entry["secondaryKeywords"] = secondary;
        entry["selectiveLogic"] = "and_any"; entry["caseSensitive"] = false; entry["alwaysActive"] = false;
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        return archive;
    }
    bool prepareRegexViewport(QQuickItem *viewport, QElapsedTimer &clock) {
        return viewport && QTest::qWaitFor([&] {
            NativeControlReadiness::revealWholeItem(viewport, [&] { return clock.elapsed(); }, 4000);
            m_window->update();
            return NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool();
        }, int(std::max<qint64>(0, 4000 - clock.elapsed())));
    }
    bool loadArchiveDrawer(const QJsonObject &archive, int width, bool selectEntry, bool hosted = false, bool reducedMotion = true, bool openHosted = true) {
        m_archive = std::make_unique<ArchiveEditor>([this](const QString &command, const QVariantMap &payload) {
            return m_bridge->request(command, payload);
        });
        connect(m_bridge.get(), &RuntimeBridge::responseReceived, m_archive.get(), &ArchiveEditor::receive);
        connect(m_bridge.get(), &RuntimeBridge::requestFailed, m_archive.get(), &ArchiveEditor::failed);
        m_archive->setSession(true, m_bridge->generation(), m_bridge->scopeKey(), true);
        const auto id = lastRendererCommand("archive:get")["request_id"].toString();
        if (id.isEmpty()) return false;
        priorityFixtureResponse(id, archive, 4);
        if (!m_archive->initialized()) return false;
        const auto books = m_archive->bookRows();
        if (books.size() != 1) return false;
        m_archive->selectBook(books.first().toMap().value("key").toString());
        const auto entries = m_archive->entryRows();
        if (entries.size() != 1) return false;
        if (selectEntry) m_archive->selectEntry(entries.first().toMap().value("key").toString());
        else m_archive->selectEntry({});
        if (m_archive->hasEntry() != selectEntry) return false;
        m_engine = std::make_unique<QQmlEngine>();
        m_engine->rootContext()->setContextProperty("session", m_bridge.get());
        m_engine->rootContext()->setContextProperty("archiveEditor", m_archive.get());
        QQmlComponent component(m_engine.get(), QUrl(hosted
            ? "qrc:/persona-card-confirmation/ArchiveFocusHostFixture.qml"
            : "qrc:/persona-card-confirmation/WorldbookPriorityFixture.qml"));
        if (component.isError()) { qWarning() << component.errorString(); return false; }
        m_window.reset(qobject_cast<QQuickWindow *>(component.create()));
        if (!m_window) { qWarning() << component.errorString(); return false; }
        m_window->resize(width, hosted ? (width == 1380 ? 900 : width == 950 ? 760 : 650) : 650);
        if (hosted) m_window->setProperty("reducedMotion", reducedMotion);
        m_panel = m_window->findChild<QQuickItem *>("fixturePriorityDrawer");
        m_window->show();
        if (!m_panel || !QTest::qWaitForWindowExposed(m_window.get())) return false;
        if (!hosted) return true;
        m_archiveFocusDiagnosticUsed = true;
        m_archiveFocusDiagnosticFrameConnection = connect(m_window.get(), &QQuickWindow::afterAnimating, this,
            [this] { ++m_archiveFocusDiagnosticFrame; });
        m_archiveFocusDiagnosticClock.start();
        if (!ArchiveFocusProbe::beginObservation(m_panel)) return false;
        archiveFocusDiagnostic("before-host-entry");
        if (!openHosted) return true;
        if (!QMetaObject::invokeMethod(m_window.get(), "openArchive")) return false;
        archiveFocusDiagnostic("after-host-entry-dispatch");
        auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        const bool ready = portal && QTest::qWaitFor([&] { return portal->property("contentReady").toBool() && m_panel->isEnabled(); });
        archiveFocusDiagnostic("host-ready-boundary");
        return ready;
    }
    bool m_archiveFocusDiagnosticUsed = false;
    int m_archiveFocusDiagnosticCount = 0;
    int m_archiveFocusDiagnosticDropped = 0;
    qint64 m_archiveFocusDiagnosticFrame = 0;
    QMetaObject::Connection m_archiveFocusDiagnosticFrameConnection;
    QElapsedTimer m_archiveFocusDiagnosticClock;
    ArchiveFocusProbe m_archiveFocusDiagnosticProbe;
    QPointer<QQuickItem> m_archiveFocusDiagnosticTarget;
    // Separate diagnostic envelope: this does not change the frozen trace-v2
    // files or become a passing proof. The terminal slot survives QVERIFY's
    // early return and is emitted in cleanup while the objects still exist.
    void archiveFocusDiagnostic(const QString &stage, QQuickItem *target = nullptr) {
        if (!m_archiveFocusDiagnosticUsed || !m_window || !m_panel) return;
        if (target) m_archiveFocusDiagnosticTarget = target;
        target = m_archiveFocusDiagnosticTarget;
        const bool terminal = stage == "terminal";
        if (m_archiveFocusDiagnosticCount >= 31 && !terminal) {
            ++m_archiveFocusDiagnosticDropped;
            return;
        }
        QVariant guard;
        const bool guardRead = QMetaObject::invokeMethod(m_panel, "focusGuardSnapshot", Q_RETURN_ARG(QVariant, guard),
            Q_ARG(QVariant, QVariant::fromValue(target)));
        if (guard.metaType() == QMetaType::fromType<QJSValue>()) guard = guard.value<QJSValue>().toVariant();
        auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation");
        auto *observer = m_panel->findChild<WindowInputState *>("archiveWindowInputState");
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        QVariantMap targetState{{"present", target != nullptr}, {"instanceToken", m_archiveFocusDiagnosticProbe.token(target)},
            {"objectName", target ? target->objectName() : QString()}, {"windowMatches", target && target->window() == m_window.get()},
            {"visible", target && target->isVisible()}, {"enabled", target && target->isEnabled()},
            {"active", target && (target == m_window->activeFocusItem() || target->isAncestorOf(m_window->activeFocusItem()))},
            {"rect", ArchiveFocusProbe::rect(target ? target->mapRectToScene(QRectF(QPointF(), target->size())) : QRectF())},
            {"intersection", ArchiveFocusProbe::rect(NativeControlReadiness::visibleRect(target, m_window.get()))}};
        qInfo().noquote() << "ARCHIVE_FOCUS_PREREQUISITE" << ArchiveFocusProbe::json({
            {"schema", "reverie.qt.archive-focus-prerequisite.v1"}, {"case", QTest::currentTestFunction()},
            {"dataTag", QTest::currentDataTag() ? QTest::currentDataTag() : ""},
            {"sequence", m_archiveFocusDiagnosticCount++}, {"limit", 32}, {"stage", stage},
            {"droppedCount", m_archiveFocusDiagnosticDropped}, {"truncated", m_archiveFocusDiagnosticDropped > 0},
            {"elapsedMs", m_archiveFocusDiagnosticClock.elapsed()}, {"frameSerial", m_archiveFocusDiagnosticFrame}, {"terminal", terminal}, {"testFailed", QTest::currentTestFailed()},
            {"target", targetState}, {"focus", m_archiveFocusDiagnosticProbe.snapshot(m_window.get(), m_panel)},
            {"guardRead", guardRead}, {"guard", guard.toMap()},
            {"portal", QVariantMap{{"ready", portal && portal->property("contentReady").toBool()},
                {"inputReady", portal && portal->property("inputReady").toBool()},
                {"drawerEnabled", m_panel->isEnabled()}, {"drawerVisible", m_panel->isVisible()},
                {"navigationBlocked", m_panel->property("navigationFocusBlocked")}}},
            {"navigation", QVariantMap{{"committing", navigation ? navigation->property("transitionCommitting") : QVariant()},
                {"revision", navigation ? navigation->property("transitionRevision") : QVariant()},
                {"activity", navigation ? navigation->property("focusActivityRevision") : QVariant()},
                {"request", navigation ? navigation->property("focusRequestRevision") : QVariant()},
                {"palette", navigation ? navigation->property("paletteOpen") : QVariant()}}},
            {"input", QVariantMap{{"held", observer && observer->held()}, {"buttons", observer ? observer->mouseButtons() : -1},
                {"touches", observer ? observer->touchCount() : -1}, {"systemButtons", int(QGuiApplication::mouseButtons())}}},
            {"selection", ArchiveFocusProbe::selection(body)}, {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
    }
    QVariantMap archiveFocusDraftState() const {
        QVariantMap state;
        for (const auto *key : {"title", "comment", "keywords", "secondaryKeywords", "keywordItems", "secondaryKeywordItems",
             "useRegex", "ruleConflict", "selectiveLogic", "caseSensitive", "content", "entryEnabled", "alwaysActive", "priority", "insertionOrder",
             "scanDepth", "bookTokenBudget", "recursiveScanning", "entryScanDepth", "entryTokenBudget",
             "insertionPosition", "insertionDepth", "insertionRole", "insertionEffectiveText", "insertionDependencyNotice",
             "dirty", "revision", "selectedBookKey", "selectedEntryKey", "archiveScope"})
            state[key] = m_archive->property(key);
        state["frames"] = m_frames.size();
        return state;
    }
    QQuickItem *archiveFormFlickable() const {
        auto *form = m_panel ? m_panel->findChild<QQuickItem *>("worldbook-form-scroll") : nullptr;
        return form ? form->property("contentItem").value<QQuickItem *>() : nullptr;
    }
    void archiveHostTraceTraversal(QQuickItem *initial, const QString &evidenceTag = {}) {
        QVERIFY(initial);
        QElapsedTimer elapsed; elapsed.start();
        qint64 frame = 0;
        const auto frameConnection = connect(m_window.get(), &QQuickWindow::afterAnimating, this, [&] { ++frame; });
        const auto disconnectFrame = qScopeGuard([&] { disconnect(frameConnection); });
        const auto prepare = [&](QQuickItem *item) {
            if (!item) return false;
            return QTest::qWaitFor([&] {
                NativeControlReadiness::revealWholeItem(item, [&] { return int(elapsed.elapsed()); }, 4000);
                m_window->update();
                return NativeControlReadiness::wholeVisibility(item, m_window.get()).value("fullyVisible").toBool();
            }, int(std::max<qint64>(0, 4000 - elapsed.elapsed())));
        };
        // The drawer follows only keyboard focus across later layout passes; a
        // clicked control keeps the scroll position computed when it was
        // revealed. Reveal and click only once the form layout has stopped
        // changing, and fail rather than trace from a layout that then moved.
        const auto formLayout = [this] {
            auto *flick = archiveFormFlickable();
            return QVariantList{m_window->width(), m_window->height(), m_panel->width(), m_panel->height(),
                flick ? QVariant(flick->width()) : QVariant(), flick ? QVariant(flick->height()) : QVariant(),
                flick ? flick->property("contentWidth") : QVariant(), flick ? flick->property("contentHeight") : QVariant()};
        };
        QVariantList settledLayout; qint64 sampledFrame = -1; int unchangedFrames = 0;
        QVERIFY2(QTest::qWaitFor([&] {
            m_window->update();
            if (frame == sampledFrame) return false;
            sampledFrame = frame;
            const auto current = formLayout();
            unchangedFrames = current == settledLayout ? unchangedFrames + 1 : 0;
            settledLayout = current;
            return unchangedFrames >= 2;
        }, int(std::max<qint64>(0, 4000 - elapsed.elapsed()))),
            "[ARCHIVE_FOCUS_LAYOUT_UNSETTLED] form layout kept changing before the traversal");
        if (initial->objectName() == "worldbookContent") {
            QVERIFY(prepare(m_panel->findChild<QQuickItem *>("worldbook-content-scroll")));
            const auto visible = NativeControlReadiness::visibleRect(initial, m_window.get());
            QVERIFY(!visible.isEmpty());
            QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, visible.center().toPoint());
        } else {
            QVERIFY(prepare(initial));
            clickCenter(initial);
        }
        QVERIFY(elapsed.elapsed() < 4000);
        const auto actionElapsedMs = elapsed.elapsed(), actionFrame = frame;
        const auto before = archiveFocusDraftState();
        ArchiveFocusProbe probe; QVariantList records; QSet<QQuickItem *> visited;
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        QVariantMap trace{{"schema", "reverie.qt.archive-focus-traversal.v2"}, {"phase", "tab-visible-controls"},
            {"step", 28}, {"scope", m_bridge->scopeKey()}, {"generation", m_bridge->generation()},
            {"windowToken", "window-1"}, {"deadlineMs", 4000}, {"startElapsedMs", elapsed.elapsed()},
            {"initialPositioningCount", qint64(positioning)}};
        QVERIFY2(formLayout() == settledLayout,
                 "[ARCHIVE_FOCUS_LAYOUT_CHANGED_BEFORE_TRAVERSAL] form layout changed between reveal and the first snapshot");
        for (int index = 0; index < 24; ++index) {
            auto *leaf = m_window->activeFocusItem();
            auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
            const bool bodyFocused = leaf && body && (leaf == body || body->isAncestorOf(leaf));
            const auto key = bodyFocused || index >= 12 ? Qt::Key_Backtab : Qt::Key_Tab;
            QVariantMap row{{"index", index}, {"step", 28}, {"direction", key == Qt::Key_Tab ? "Tab" : "Backtab"},
                {"scope", m_bridge->scopeKey()}, {"generation", m_bridge->generation()}, {"bodyFocused", bodyFocused},
                {"inputCount", 0}, {"immediate", true}, {"before", probe.snapshot(m_window.get(), m_panel)},
                {"positioningBefore", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameBefore", frame}, {"elapsedBeforeMs", elapsed.elapsed()}};
            ArchiveFocusProbe::beginObservation(m_panel);
            int dispatchCount = 0;
            ++dispatchCount;
            QTest::keyClick(m_window.get(), key);
            row["inputCount"] = dispatchCount;
            row["causal"] = ArchiveFocusProbe::causalSnapshot(m_panel);
            leaf = m_window->activeFocusItem();
            row.insert({{"after", probe.snapshot(m_window.get(), m_panel)},
                {"positioningAfter", qint64(NativeControlReadiness::testRevealCallCount)},
                {"frameAfter", frame}, {"elapsedAfterMs", elapsed.elapsed()}});
            records.append(row); trace["records"] = records; trace["endElapsedMs"] = row["elapsedAfterMs"];
            qInfo().noquote() << "ARCHIVE_FOCUS_TRACE" << ArchiveFocusProbe::json(trace);
            const auto reason = ArchiveFocusProbe::context(row).toUtf8();
            QVERIFY2(leaf && leaf->isVisible() && leaf->isEnabled() && NativeControlReadiness::effectiveOpacity(leaf) > .01, reason.constData());
            QVERIFY2(!NativeControlReadiness::visibleRect(leaf, m_window.get()).isEmpty(), reason.constData());
            QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
            QVERIFY2(!row["causal"].toMap()["overflow"].toBool(), "[ARCHIVE_FOCUS_CAUSAL] bounded observation overflow");
            QVERIFY(elapsed.elapsed() < 4000);
            visited.insert(leaf);
        }
        QVERIFY(visited.size() >= 3);
        QCOMPARE(archiveFocusDraftState(), before);
        if (!evidenceTag.isEmpty()) {
            const QVariantMap boundary{{"source", "native"}, {"dataTag", evidenceTag},
                {"scope", m_bridge->scopeKey()}, {"generation", m_bridge->generation()},
                {"windowToken", "window-1"}, {"windowWidth", m_window->width()}, {"windowHeight", m_window->height()},
                {"deadlineMs", 4000}, {"actionElapsedMs", actionElapsedMs}, {"afterElapsedMs", trace["endElapsedMs"]},
                {"actionFrame", actionFrame}, {"afterFrame", frame}};
            QVERIFY(writeArchiveFocusEvidence(evidenceTag, trace, boundary));
        }
    }
    bool revealPriorityControl(QQuickItem *item) {
        if (!item) return false;
        const QDeadlineTimer deadline(QTest::defaultTryTimeout.load(std::memory_order_relaxed), Qt::PreciseTimer);
        QElapsedTimer elapsed; elapsed.start();
        return QTest::qWaitFor([&] {
            NativeControlReadiness::revealWholeItem(item, [&] { return int(elapsed.elapsed()); }, int(deadline.remainingTime() + elapsed.elapsed()));
            m_window->update();
            return NativeControlReadiness::wholeVisibility(item, m_window.get()).value("fullyVisible").toBool();
        }, deadline);
    }

    static QVariantMap personaInputRowData(QQuickItem *row) {
        QVariant value = row ? row->property("modelData") : QVariant{};
        if (value.metaType() == QMetaType::fromType<QJSValue>()) value = value.value<QJSValue>().toVariant();
        return value.toMap();
    }
    void capturePersonaFixture(const QString &stage, QQuickItem *copy = nullptr) {
        m_personaFixtureUsed = true;
        if (copy) m_personaFixtureCopy = copy;
        const auto describe = [this](QQuickItem *panel) {
            QVariantMap value{{"present", panel != nullptr}, {"visible", panel ? QVariant(panel->isVisible()) : QVariant{}},
                {"width", panel ? QVariant(panel->width()) : QVariant{}}, {"height", panel ? QVariant(panel->height()) : QVariant{}}};
            if (!panel) return value;
            QList<QQuickItem *> rows, buttons;
            visualMatches(panel, "personaRow-persona-target", rows);
            visualMatches(panel, "personaSwitch-persona-target", buttons);
            auto model = panel->property("personaProfiles");
            if (model.metaType() == QMetaType::fromType<QJSValue>()) model = model.value<QJSValue>().toVariant();
            QVariantList ids;
            for (const auto &entry : model.toList()) ids.append(entry.toMap().value("id"));
            QList<QQuickItem *> surfaces; visualMatches(m_window ? m_window->contentItem() : nullptr, "taskSurface", surfaces);
            value.insert({{"objectName", panel->objectName()}, {"page", panel->property("page")},
                {"objectTreeMatches", panel->findChildren<QQuickItem *>("personaSwitch-persona-target").size()},
                {"visualRowMatches", rows.size()}, {"visualControlMatches", buttons.size()},
                {"modelIds", ids}, {"modelCount", ids.size()},
                {"windowMatches", panel->window() == m_window.get()},
                {"engineMatches", qmlContext(panel) && qmlContext(panel)->engine() == m_engine.get()},
                {"taskSurfaceMatches", surfaces.size()},
                {"insideTaskSurface", surfaces.size() == 1 ? QVariant(surfaces.first()->isAncestorOf(panel)) : QVariant{}}});
            QVariantList repeaters;
            const auto scan = [&](auto &&self, QQuickItem *item) -> void {
                if (!item) return;
                auto repeatedModel = item->property("model");
                if (repeatedModel.metaType() == QMetaType::fromType<QJSValue>()) repeatedModel = repeatedModel.value<QJSValue>().toVariant();
                QVariantList repeatedIds;
                for (const auto &entry : repeatedModel.toList()) repeatedIds.append(entry.toMap().value("id"));
                if (item->inherits("QQuickRepeater") && repeaters.size() < 8 && !ids.isEmpty() && repeatedIds == ids) {
                    const int count = item->property("count").toInt();
                    QVariantList present;
                    for (int index = 0; index < qMin(count, 4); ++index) {
                        QQuickItem *entry = nullptr;
                        const bool read = QMetaObject::invokeMethod(item, "itemAt", Q_RETURN_ARG(QQuickItem *, entry), Q_ARG(int, index));
                        present.append(QVariantMap{{"read", read}, {"present", entry != nullptr},
                            {"objectName", entry ? QVariant(entry->objectName()) : QVariant{}}});
                    }
                    repeaters.append(QVariantMap{{"count", count}, {"firstItems", present}});
                }
                for (auto *child : item->childItems()) self(self, child);
            };
            scan(scan, panel); value["repeaters"] = repeaters;
            if (rows.size() == 1) {
                const auto row = personaInputRowData(rows.first());
                value["rowId"] = row.value("id"); value["rowActive"] = row.value("active");
            }
            return value;
        };
        m_personaFixtureLast = {{"phase", stage}, {"frameSerial", qint64(m_candidateFrameSerial)},
            {"active", describe(m_panel)}, {"copy", describe(m_personaFixtureCopy)}};
        if (stage != "terminal" && m_personaFixtureSamples.size() < 6) m_personaFixtureSamples.append(m_personaFixtureLast);
    }
    QString personaInputDialogTarget() const {
        QStringList targets;
        if (m_panel) for (auto *object : m_panel->findChildren<QObject *>()) {
            if (object->inherits("QQuickDialog") && object->property("targetId").isValid() &&
                object->property("targetName").isValid() && object->property("visible").toBool())
                targets.append(object->property("targetId").toString());
        }
        return targets.size() == 1 ? targets.first() : QString();
    }
    bool preparePersonaPortalPanel(int width, int height, bool blocked = false) {
        capturePersonaFixture("portal-prepare-start");
        m_engine = std::make_unique<QQmlEngine>();
        m_engine->rootContext()->setContextProperty("session", m_bridge.get());
        m_engine->rootContext()->setContextProperty("archiveEditor", m_archive.get());
        QQmlComponent component(m_engine.get(), QUrl("qrc:/persona-card-confirmation/PersonaRowInputFixture.qml"));
        if (component.isError()) { qWarning() << component.errorString(); return false; }
        m_window.reset(qobject_cast<QQuickWindow *>(component.createWithInitialProperties({
            {"width", width}, {"height", height}, {"blockInput", blocked}})));
        if (!m_window) { qWarning() << component.errorString(); return false; }
        QList<QQuickItem *> roots;
        visualMatches(m_window->contentItem(), "characterTasks", roots);
        m_panel = roots.size() == 1 ? roots.first() : nullptr;
        if (!m_panel) return false;
        m_dialog = m_panel->findChild<QObject *>("personaImportConfirmation");
        trackCandidateFrames();
        m_window->show();
        const bool exposed = QTest::qWaitForWindowExposed(m_window.get());
        const bool settled = exposed && feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer));
        capturePersonaFixture("production-portal-prepared");
        return settled;
    }
    void configurePersonaInputIdentity(const QString &profile, const QString &live, const QString &target,
                                       int epoch, int generation, QChar fingerprint) {
        m_bridge->m_persona = {{"persona_id", live}, {"epoch", epoch}, {"fingerprint", QString(64, fingerprint)}};
        m_bridge->m_generation = generation;
        publishPersonaInputProfiles({QVariantMap{{"id", profile}, {"name", "当前人格"}, {"active", true}},
            QVariantMap{{"id", target}, {"name", "目标人格"}, {"active", false}}});
    }
    static QByteArray nativeEvidenceContractBytes() {
        QFile file(":/persona-card-confirmation/p1-native-evidence-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    static QJsonObject nativeEvidenceContract() {
        return QJsonDocument::fromJson(nativeEvidenceContractBytes()).object();
    }
    QJsonArray m_worldbookRegexEvidenceFiles;
    static QByteArray worldbookRegexEvidenceContractBytes() {
        QFile file(":/persona-card-confirmation/worldbook-regex-native-evidence-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    static QJsonObject worldbookRegexEvidenceContract() {
        return QJsonDocument::fromJson(worldbookRegexEvidenceContractBytes()).object();
    }
    bool writeWorldbookRegexEvidence(const QString &caseId, const QByteArray &bytes) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_REGEX_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookRegexEvidenceContract();
        QJsonObject specification;
        for (const auto &entry : contract["cases"].toArray())
            if (entry.toObject()["caseId"].toString() == caseId) specification = entry.toObject();
        if (specification.isEmpty() || bytes.isEmpty() || bytes.size() > contract["maximumRecordBytes"].toInt()) return false;
        const auto filename = specification["filename"].toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &entry : m_worldbookRegexEvidenceFiles)
            if (entry.toObject()["caseId"].toString() == caseId) return false;
        // Preserve the original Qt serialization bytes asserted by the test.
        // No parsed record is rewritten, and an existing file is never replaced.
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_worldbookRegexEvidenceFiles.append(QJsonObject{{"caseId", caseId}, {"filename", filename}, {"bytes", bytes.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    bool writeWorldbookRegexManifest() {
        const auto directory = qEnvironmentVariable("REVERIE_P1_REGEX_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookRegexEvidenceContract();
        const auto cases = contract["cases"].toArray();
        if (cases.size() != 2 || m_worldbookRegexEvidenceFiles.size() != cases.size()) return false;
        QJsonArray ordered;
        for (const auto &entry : cases) {
            QJsonObject written;
            for (const auto &file : m_worldbookRegexEvidenceFiles)
                if (file.toObject()["caseId"] == entry.toObject()["caseId"]) written = file.toObject();
            if (written.isEmpty()) return false;
            ordered.append(written);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema", contract["manifestSchema"]},
            {"contractSha256", QString::fromLatin1(QCryptographicHash::hash(worldbookRegexEvidenceContractBytes(), QCryptographicHash::Sha256).toHex())},
            {"cases", ordered}}).toJson(QJsonDocument::Compact);
        QFile output(QDir(directory).filePath("manifest.json"));
        return output.open(QIODevice::WriteOnly | QIODevice::NewOnly) && output.write(bytes) == bytes.size() && output.flush();
    }
    QJsonArray m_worldbookDepthEvidenceFiles;
    static QByteArray worldbookDepthEvidenceContractBytes() {
        QFile file(":/persona-card-confirmation/worldbook-injection-depth-native-evidence-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    static QJsonObject worldbookDepthEvidenceContract() {
        return QJsonDocument::fromJson(worldbookDepthEvidenceContractBytes()).object();
    }
    bool writeWorldbookDepthEvidence(const QString &caseId, const QByteArray &bytes) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_DEPTH_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookDepthEvidenceContract();
        QJsonObject specification;
        for (const auto &entry : contract["cases"].toArray())
            if (entry.toObject()["caseId"].toString() == caseId) specification = entry.toObject();
        if (specification.isEmpty() || bytes.isEmpty() || bytes.size() > contract["maximumRecordBytes"].toInt()) return false;
        const auto filename = specification["filename"].toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &entry : m_worldbookDepthEvidenceFiles)
            if (entry.toObject()["caseId"].toString() == caseId) return false;
        // Write the original Qt JSON bytes. The Node reader consumes this exact
        // file; an existing record is never replaced or converted to fit it.
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_worldbookDepthEvidenceFiles.append(QJsonObject{{"caseId", caseId}, {"filename", filename}, {"bytes", bytes.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    bool writeWorldbookDepthManifest() {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_DEPTH_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookDepthEvidenceContract();
        const auto cases = contract["cases"].toArray();
        if (cases.size() != 3 || m_worldbookDepthEvidenceFiles.size() != cases.size()) return false;
        QJsonArray ordered;
        for (const auto &entry : cases) {
            QJsonObject written;
            for (const auto &file : m_worldbookDepthEvidenceFiles)
                if (file.toObject()["caseId"] == entry.toObject()["caseId"]) written = file.toObject();
            if (written.isEmpty()) return false;
            ordered.append(written);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema", contract["manifestSchema"]},
            {"contractSha256", QString::fromLatin1(QCryptographicHash::hash(worldbookDepthEvidenceContractBytes(), QCryptographicHash::Sha256).toHex())},
            {"cases", ordered}}).toJson(QJsonDocument::Compact);
        QFile output(QDir(directory).filePath("manifest.json"));
        return output.open(QIODevice::WriteOnly | QIODevice::NewOnly) && output.write(bytes) == bytes.size() && output.flush();
    }
    QString worldbookDepthSelectedEntryId() const {
        for (const auto &entry : m_archive->entryRows())
            if (entry.toMap().value("key") == m_archive->selectedEntryKey()) return entry.toMap().value("id").toString();
        return {};
    }
    SummaryInteractionProbe::ControlObservation inspectWorldbookDepthInput(QQuickItem *target) const {
        bool surfaceReady = true;
        for (auto *parent = target; parent; parent = parent->parentItem())
            if (parent->property("inputReady").isValid()) surfaceReady = surfaceReady && parent->property("inputReady").toBool();
        auto observation = SummaryInteractionProbe::inspect(target, m_window.get(), surfaceReady, m_bridge->scopeKey());
        const bool whole = NativeControlReadiness::wholeVisibility(target, m_window.get()).value("fullyVisible").toBool();
        observation.eligible = observation.eligible && whole;
        observation.state["fullyVisible"] = whole; observation.state["ready"] = observation.eligible;
        return observation;
    }
    bool prepareWorldbookDepthInput(QQuickItem *target, QElapsedTimer &clock, ArchiveInputProbe::PhaseClock &phaseClock,
                                   SummaryInteractionProbe::StableGate &stable) {
        const auto elapsed = [&] { return phaseClock.elapsed(clock.elapsed()); };
        return target && QTest::qWaitFor([&] {
            const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
            if (revealed.value("expired").toBool()) return false;
            const auto observation = inspectWorldbookDepthInput(target);
            const bool ready = stable.observe(observation,elapsed(),m_archiveFocusDiagnosticFrame).value("ready").toBool();
            m_window->update();
            return ready;
        }, int(std::max<qint64>(0,4000-elapsed())));
    }
    WorldbookInjectionInput::Context worldbookDepthInputContext(QQuickItem *target, QElapsedTimer &clock,
            ArchiveInputProbe::PhaseClock &phaseClock, SummaryInteractionProbe::StableGate &stable,
            qint64 stepAt, int step, QVariantMap &latest, QVariantList &qualifications) {
        const auto scope = m_bridge->scopeKey(); const int generation = m_bridge->generation();
        QPointer<QQuickItem> bound = target;
        WorldbookInjectionInput::Context context;
        context.editor = m_archive.get();
        context.resolveTarget = [this] { return m_panel->findChild<QQuickItem *>("worldbookInsertionDepth"); };
        context.editorValue = [this] { return m_archive->insertionDepth(); };
        context.baselineReady = [this] { return m_archive->insertionPosition() == QVariant("at_depth"); };
        context.metadata = [this,&clock,&phaseClock,stepAt,step] {
            const auto now = clock.elapsed();
            return QVariantMap{{"step",step},{"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},
                {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",m_archiveFocusDiagnosticFrame},
                {"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},
                {"selectedEntryId",worldbookDepthSelectedEntryId()}};
        };
        context.qualify = [this,bound,&clock,&phaseClock,&stable,&qualifications,scope,generation](const QString &phase,bool keyboard) {
            const auto observation = inspectWorldbookDepthInput(bound);
            const auto hit = keyboard ? QVariantMap{} : NativeCheck::hitTest(m_window.get(),observation.point,bound).metadata();
            const auto now = clock.elapsed();
            const QVariantMap row{{"phase",phase},{"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},
                {"frame",m_archiveFocusDiagnosticFrame},{"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},
                {"target",WorldbookInjectionInput::identity(bound)},
                {"wholeVisibility",NativeControlReadiness::wholeVisibility(bound,m_window.get())},
                {"layoutMatches",stable.matches(observation)},
                {"focusInTarget",ArchiveInputProbe::keyboardFocusMatches(bound,m_window.get())},{"hit",hit}};
            qualifications.append(row);
            NativeCheck::require(now < 4000 && phaseClock.elapsed(now) >= 0 && phaseClock.elapsed(now) < 4000,
                "NATIVE_DEPTH_INPUT_DEADLINE",row);
            NativeCheck::require(bound && m_panel->findChild<QQuickItem *>("worldbookInsertionDepth") == bound &&
                stable.matches(observation) && m_bridge->scopeKey() == scope && m_bridge->generation() == generation,
                "NATIVE_DEPTH_TARGET_CHANGED",row);
            NativeCheck::require(keyboard ? ArchiveInputProbe::keyboardFocusMatches(bound,m_window.get()) :
                QStringList{"target","descendant"}.contains(hit.value("hitResult").toString()),"NATIVE_DEPTH_INPUT_QUALIFICATION",row);
            return observation.point;
        };
        context.publish = [&latest](const QVariantMap &record) { latest = record; };
        return context;
    }
    // Two-entry fixture for the new entry-selection boundary only. The older
    // loader's one-entry setup and every existing test body remain unchanged.
    bool loadWorldbookHitEntrySelector() {
        auto fixture = insertionFixtureArchive("at_depth",0,"system");
        auto books = fixture["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto second = entries[0].toObject();
        second["id"] = "priority-b"; second["content"] = "HIT_ENTRY_B";
        entries.append(second); book["entries"] = entries; books[0] = book; fixture["worldBooks"] = books;
        m_archive = std::make_unique<ArchiveEditor>([this](const QString &command, const QVariantMap &payload) {
            return m_bridge->request(command, payload);
        });
        connect(m_bridge.get(), &RuntimeBridge::responseReceived, m_archive.get(), &ArchiveEditor::receive);
        connect(m_bridge.get(), &RuntimeBridge::requestFailed, m_archive.get(), &ArchiveEditor::failed);
        m_archive->setSession(true,m_bridge->generation(),m_bridge->scopeKey(),true);
        const auto id = lastRendererCommand("archive:get")["request_id"].toString();
        if (id.isEmpty()) return false;
        priorityFixtureResponse(id,fixture,4);
        if (!m_archive->initialized() || m_archive->bookRows().size() != 1) return false;
        m_archive->selectBook(m_archive->bookRows().first().toMap().value("key").toString());
        const auto rows = m_archive->entryRows();
        if (rows.size() != 2 || rows[0].toMap().value("id") != "priority-a" || rows[1].toMap().value("id") != "priority-b") return false;
        m_archive->selectEntry(rows[0].toMap().value("key").toString());
        if (worldbookDepthSelectedEntryId() != "priority-a") return false;
        m_engine = std::make_unique<QQmlEngine>();
        m_engine->rootContext()->setContextProperty("session",m_bridge.get());
        m_engine->rootContext()->setContextProperty("archiveEditor",m_archive.get());
        QQmlComponent component(m_engine.get(),QUrl("qrc:/persona-card-confirmation/ArchiveFocusHostFixture.qml"));
        if (component.isError()) { qWarning() << component.errorString(); return false; }
        m_window.reset(qobject_cast<QQuickWindow *>(component.create()));
        if (!m_window) { qWarning() << component.errorString(); return false; }
        m_window->resize(1380,900); m_window->setProperty("reducedMotion",true);
        m_panel = m_window->findChild<QQuickItem *>("fixturePriorityDrawer");
        m_window->show();
        if (!m_panel || !QTest::qWaitForWindowExposed(m_window.get())) return false;
        m_archiveFocusDiagnosticUsed = true;
        m_archiveFocusDiagnosticFrameConnection = connect(m_window.get(),&QQuickWindow::afterAnimating,this,
            [this] { ++m_archiveFocusDiagnosticFrame; });
        m_archiveFocusDiagnosticClock.start();
        if (!ArchiveFocusProbe::beginObservation(m_panel)) return false;
        archiveFocusDiagnostic("before-host-entry");
        if (!QMetaObject::invokeMethod(m_window.get(),"openArchive")) return false;
        archiveFocusDiagnostic("after-host-entry-dispatch");
        auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        const bool ready = portal && QTest::qWaitFor([&] { return portal->property("contentReady").toBool() && m_panel->isEnabled(); });
        archiveFocusDiagnostic("host-ready-boundary");
        return ready;
    }
    QJsonArray m_worldbookHitEvidenceFiles;
    static QByteArray worldbookHitContractBytes() {
        QFile file(":/persona-card-confirmation/worldbook-injection-hit-native-evidence-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    static QJsonObject worldbookHitContract() {
        return QJsonDocument::fromJson(worldbookHitContractBytes()).object();
    }
    bool writeWorldbookHitEvidence(const QString &caseId, const QByteArray &bytes) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_HIT_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookHitContract();
        QJsonObject specification;
        for (const auto &entry : contract["cases"].toArray())
            if (entry.toObject()["caseId"].toString() == caseId) specification = entry.toObject();
        if (specification.isEmpty() || bytes.isEmpty() || bytes.size() > contract["maximumRecordBytes"].toInt()) return false;
        const auto filename = specification["filename"].toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &entry : m_worldbookHitEvidenceFiles)
            if (entry.toObject()["caseId"].toString() == caseId) return false;
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_worldbookHitEvidenceFiles.append(QJsonObject{{"caseId",caseId},{"filename",filename},{"bytes",bytes.size()},
            {"sha256",QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    bool writeWorldbookHitManifest() {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_HIT_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookHitContract();
        const auto cases = contract["cases"].toArray();
        if (cases.size() != 8 || m_worldbookHitEvidenceFiles.size() != cases.size()) return false;
        QJsonArray ordered;
        for (const auto &entry : cases) {
            QJsonObject written;
            for (const auto &file : m_worldbookHitEvidenceFiles)
                if (file.toObject()["caseId"] == entry.toObject()["caseId"]) written = file.toObject();
            if (written.isEmpty()) return false;
            ordered.append(written);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema",contract["manifestSchema"]},
            {"contractSha256",QString::fromLatin1(QCryptographicHash::hash(worldbookHitContractBytes(),QCryptographicHash::Sha256).toHex())},
            {"cases",ordered}}).toJson(QJsonDocument::Compact);
        QFile output(QDir(directory).filePath("manifest.json"));
        return output.open(QIODevice::WriteOnly | QIODevice::NewOnly) && output.write(bytes) == bytes.size() && output.flush();
    }
    QJsonArray m_worldbookNavigationEvidenceFiles;
    static QByteArray worldbookNavigationContractBytes() {
        QFile file(":/persona-card-confirmation/worldbook-injection-navigation-native-evidence-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    static QJsonObject worldbookNavigationContract() {
        return QJsonDocument::fromJson(worldbookNavigationContractBytes()).object();
    }
    bool writeWorldbookNavigationEvidence(const QString &caseId, const QByteArray &bytes) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_NAVIGATION_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookNavigationContract();
        QJsonObject specification;
        for (const auto &entry : contract["cases"].toArray())
            if (entry.toObject()["caseId"].toString() == caseId) specification = entry.toObject();
        if (specification.isEmpty() || bytes.isEmpty() || bytes.size() > contract["maximumRecordBytes"].toInt()) return false;
        const auto filename = specification["filename"].toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &entry : m_worldbookNavigationEvidenceFiles)
            if (entry.toObject()["caseId"].toString() == caseId) return false;
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_worldbookNavigationEvidenceFiles.append(QJsonObject{{"caseId",caseId},{"filename",filename},{"bytes",bytes.size()},
            {"sha256",QString::fromLatin1(QCryptographicHash::hash(bytes,QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    bool writeWorldbookNavigationManifest() {
        const auto directory = qEnvironmentVariable("REVERIE_P1_INJECTION_NAVIGATION_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = worldbookNavigationContract();
        const auto cases = contract["cases"].toArray();
        if (cases.size() != 6 || m_worldbookNavigationEvidenceFiles.size() != cases.size()) return false;
        QJsonArray ordered;
        for (const auto &entry : cases) {
            QJsonObject written;
            for (const auto &file : m_worldbookNavigationEvidenceFiles)
                if (file.toObject()["caseId"] == entry.toObject()["caseId"]) written = file.toObject();
            if (written.isEmpty()) return false;
            ordered.append(written);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema",contract["manifestSchema"]},
            {"contractSha256",QString::fromLatin1(QCryptographicHash::hash(worldbookNavigationContractBytes(),QCryptographicHash::Sha256).toHex())},
            {"cases",ordered}}).toJson(QJsonDocument::Compact);
        QFile output(QDir(directory).filePath("manifest.json"));
        return output.open(QIODevice::WriteOnly | QIODevice::NewOnly) && output.write(bytes) == bytes.size() && output.flush();
    }
    QVariantMap worldbookNavigationValues() const {
        return {{"position",m_archive->insertionPosition()},{"depth",m_archive->insertionDepth()},{"role",m_archive->insertionRole()}};
    }
    QVariantMap worldbookNavigationPageContext() const {
        const auto states = m_archive->entrySettingStates();
        const auto setting = [&states](const QString &key, const QVariant &value) {
            const auto state = states.value(key).toMap();
            QVariantMap result{{"value",value}};
            for (const auto *flag : {"confirmed","editable","inherited","present","canOverride"})
                result[flag] = state.value(flag);
            return result;
        };
        auto *before = m_panel->property("insertionBeforeItem").value<QQuickItem *>();
        auto *after = m_panel->property("insertionAfterItem").value<QQuickItem *>();
        return {{"useRegex",m_archive->useRegex()},
            {"entrySettings",QVariantMap{{"scanDepth",setting("scanDepth",m_archive->entryScanDepth())},
                {"tokenBudget",setting("tokenBudget",m_archive->entryTokenBudget())}}},
            {"beforeItem",WorldbookInjectionInput::identity(before)},
            {"beforeOwner",WorldbookInjectionInput::identity(WorldbookInjectionNavigation::owner(before))},
            {"afterItem",WorldbookInjectionInput::identity(after)},
            {"afterOwner",WorldbookInjectionInput::identity(WorldbookInjectionNavigation::owner(after))}};
    }
    bool selectWorldbookNavigationControl(QQuickItem *target, int index, QElapsedTimer &clock,
            ArchiveInputProbe::PhaseClock &phaseClock, QVariantList &setup, const QString &stage) {
        SummaryInteractionProbe::StableGate gate;
        if (!target || !prepareWorldbookDepthInput(target,clock,phaseClock,gate)) return false;
        const auto observation = inspectWorldbookDepthInput(target);
        const auto before = worldbookNavigationValues();
        const auto beforeIndex = target->property("currentIndex");
        if (!NativeCheck::hitTest(m_window.get(),observation.point,target).accepted()) return false;
        QSignalSpy activated(target,SIGNAL(activated(int)));
        if (!activated.isValid() || clock.elapsed() >= 4000) return false;
        QTest::mouseClick(m_window.get(),Qt::LeftButton,Qt::NoModifier,observation.point,0);
        int keyCount = 0;
        const auto send = [&](Qt::Key key) {
            if (clock.elapsed() >= 4000 || !ArchiveInputProbe::keyboardFocusMatches(target,m_window.get(),true)) return false;
            ++keyCount; QTest::keyClick(m_window.get(),key,Qt::NoModifier,0); return true;
        };
        if (!send(Qt::Key_Home)) return false;
        for (int row = 0; row < index; ++row) if (!send(Qt::Key_Down)) return false;
        if (!send(Qt::Key_Return)) return false;
        setup.append(QVariantMap{{"stage",stage},{"beforeGroup",before},{"afterGroup",worldbookNavigationValues()},
            {"beforeIndex",beforeIndex},{"afterIndex",target->property("currentIndex")},
            {"mouseDispatchCount",1},{"keyDispatchCount",keyCount},{"activatedSignals",activated.count()},
            {"nowMs",clock.elapsed()},{"frame",m_archiveFocusDiagnosticFrame},
            {"target",WorldbookInjectionInput::identity(target)}});
        return target->property("currentIndex").toInt() == index && activated.count() == 1 && clock.elapsed() < 4000;
    }
    WorldbookInjectionNavigation::Context worldbookNavigationContext(QQuickItem *position, QElapsedTimer &clock,
            ArchiveInputProbe::PhaseClock &phaseClock, SummaryInteractionProbe::StableGate &stable,
            qint64 stepAt, int step, QVariantMap &latest, QVariantList &qualifications) {
        const auto scope = m_bridge->scopeKey(); const auto generation = m_bridge->generation();
        QPointer<QQuickItem> boundPosition = position;
        WorldbookInjectionNavigation::Context context;
        context.editor = m_archive.get();
        context.resolve = [this](const QString &name) { return m_panel->findChild<QQuickItem *>(name); };
        context.values = [this] { return worldbookNavigationValues(); };
        context.metadata = [this,&clock,&phaseClock,stepAt,step] {
            const auto now = clock.elapsed();
            return QVariantMap{{"step",step},{"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},
                {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",m_archiveFocusDiagnosticFrame},
                {"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},
                {"selectedEntryId",worldbookDepthSelectedEntryId()}};
        };
        context.qualify = [this,boundPosition,&clock,&phaseClock,&stable,&qualifications,scope,generation]
                (QQuickItem *target,bool keyboard,bool selector) {
            const auto now = clock.elapsed();
            const auto observation = keyboard ? SummaryInteractionProbe::ControlObservation{} : inspectWorldbookDepthInput(target);
            const auto hit = keyboard ? QVariantMap{} : NativeCheck::hitTest(m_window.get(),observation.point,target).metadata();
            const bool focusMatches = ArchiveInputProbe::keyboardFocusMatches(target,m_window.get(),selector);
            const QVariantMap row{{"index",qualifications.size()},{"keyboard",keyboard},{"selector",selector},
                {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",m_archiveFocusDiagnosticFrame},
                {"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},
                {"target",WorldbookInjectionInput::identity(target)},
                {"wholeVisibility",NativeControlReadiness::wholeVisibility(target,m_window.get())},
                {"layoutMatches",keyboard ? QVariant() : QVariant(stable.matches(observation))},
                {"focusInTarget",focusMatches},{"hit",hit}};
            if (qualifications.size() < 32) qualifications.append(row);
            NativeCheck::require(now < 4000 && phaseClock.elapsed(now) >= 0 && phaseClock.elapsed(now) < 4000,
                "NATIVE_NAVIGATION_DEADLINE",row);
            NativeCheck::require(target && target->isEnabled() && target->isVisible() && boundPosition &&
                m_panel->findChild<QQuickItem *>("worldbookInsertionPosition") == boundPosition &&
                m_bridge->scopeKey() == scope && m_bridge->generation() == generation,"NATIVE_NAVIGATION_TARGET_CHANGED",row);
            NativeCheck::require(keyboard ? focusMatches : target == boundPosition && stable.matches(observation) &&
                QStringList{"target","descendant"}.contains(hit.value("hitResult").toString()),"NATIVE_NAVIGATION_QUALIFICATION",row);
            return keyboard ? QPoint() : observation.point;
        };
        context.publish = [&latest](const QVariantMap &record) { latest = record; };
        return context;
    }
    bool writeNativeEvidence(const QString &caseId, const QVariantMap &record, const QJsonObject &read = {}) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_NATIVE_EVIDENCE_DIR");
        if (directory.isEmpty()) return true; // Ordinary unit runs still execute all assertions.
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = nativeEvidenceContract();
        QJsonObject specification;
        for (const auto &value : contract.value("cases").toArray())
            if (value.toObject().value("caseId").toString() == caseId) specification = value.toObject();
        if (specification.isEmpty()) return false;
        const auto filename = specification.value("filename").toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &entry : m_nativeEvidenceFiles)
            if (entry.toObject().value("caseId").toString() == caseId) return false;
        QJsonObject wrapper{{"schema", "reverie.native-input-evidence.v1"}, {"caseId", caseId},
            {"record", QJsonObject::fromVariantMap(record)}};
        if (!read.isEmpty()) wrapper["read"] = read;
        // These are the original Qt serialization bytes, never rewritten to
        // satisfy Node. The independent expected contract is a committed file.
        const auto bytes = QJsonDocument(wrapper).toJson(QJsonDocument::Compact);
        if (bytes.isEmpty() || bytes.size() > contract.value("maxRecordBytes").toInt()) return false;
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_nativeEvidenceFiles.append(QJsonObject{{"caseId", caseId}, {"filename", filename}, {"kind", specification.value("kind")}, {"bytes", bytes.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    QJsonArray m_archiveFocusEvidenceFiles;
    static QByteArray archiveFocusContractBytes() {
        QFile file(":/persona-card-confirmation/archive-control-readiness-contract.json");
        return file.open(QIODevice::ReadOnly) ? file.readAll() : QByteArray{};
    }
    bool writeArchiveFocusEvidence(const QString &dataTag, const QVariantMap &trace, QVariantMap boundary) {
        const auto directory = qEnvironmentVariable("REVERIE_P1_ARCHIVE_FOCUS_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const QFileInfo info(directory);
        if (!info.isAbsolute() || !info.isDir() || info.isSymLink()) return false;
        const auto contract = QJsonDocument::fromJson(archiveFocusContractBytes()).object()["nativeFocusEvidence"].toObject();
        QJsonObject specification;
        for (const auto &value : contract["cases"].toArray())
            if (value.toObject()["dataTag"].toString() == dataTag) specification = value.toObject();
        if (specification.isEmpty()) return false;
        const auto caseId = specification["caseId"].toString(), filename = specification["filename"].toString();
        if (QFileInfo(filename).fileName() != filename || !filename.endsWith(".json")) return false;
        for (const auto &file : m_archiveFocusEvidenceFiles)
            if (file.toObject()["caseId"].toString() == caseId) return false;
        boundary["caseId"] = caseId;
        const auto bytes = QJsonDocument(QJsonObject{{"schema", contract["schema"]}, {"caseId", caseId},
            {"trace", QJsonObject::fromVariantMap(trace)}, {"boundary", QJsonObject::fromVariantMap(boundary)}}).toJson(QJsonDocument::Compact);
        if (bytes.isEmpty() || bytes.size() > contract["maximumRecordBytes"].toInt()) return false;
        QFile output(QDir(directory).filePath(filename));
        if (!output.open(QIODevice::WriteOnly | QIODevice::NewOnly) || output.write(bytes) != bytes.size() || !output.flush()) return false;
        m_archiveFocusEvidenceFiles.append(QJsonObject{{"caseId", caseId}, {"filename", filename}, {"bytes", bytes.size()},
            {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}});
        return true;
    }
    bool writeArchiveFocusManifest() {
        const auto directory = qEnvironmentVariable("REVERIE_P1_ARCHIVE_FOCUS_EVIDENCE_DIR");
        if (directory.isEmpty()) return true;
        const auto contract = QJsonDocument::fromJson(archiveFocusContractBytes()).object()["nativeFocusEvidence"].toObject();
        const auto cases = contract["cases"].toArray();
        if (m_archiveFocusEvidenceFiles.size() != cases.size()) return false;
        QJsonArray ordered;
        for (const auto &entry : cases) {
            QJsonObject found;
            for (const auto &file : m_archiveFocusEvidenceFiles)
                if (file.toObject()["caseId"] == entry.toObject()["caseId"]) found = file.toObject();
            if (found.isEmpty()) return false;
            ordered.append(found);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema", contract["manifestSchema"]},
            {"contractSha256", QString::fromLatin1(QCryptographicHash::hash(archiveFocusContractBytes(), QCryptographicHash::Sha256).toHex())},
            {"cases", ordered}}).toJson(QJsonDocument::Compact);
        QFile output(QDir(directory).filePath("manifest.json"));
        return output.open(QIODevice::WriteOnly | QIODevice::NewOnly) && output.write(bytes) == bytes.size() && output.flush();
    }
    bool stableCandidateHeader(const QString &readId, int count, bool visible, QVariantMap &record) {
        CandidateHeaderProbe::StableRead gate;
        QElapsedTimer clock; clock.start();
        CandidateHeaderProbe::StableRead::Result result = CandidateHeaderProbe::StableRead::Waiting;
        const bool ready = QTest::qWaitFor([&] {
            record = CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), count,
                readId, m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial);
            result = gate.poll(record, visible, clock.elapsed(), 10000);
            if (result == CandidateHeaderProbe::StableRead::Waiting) m_window->update();
            return result != CandidateHeaderProbe::StableRead::Waiting;
        }, QDeadlineTimer(10000, Qt::PreciseTimer));
        if (!ready || result != CandidateHeaderProbe::StableRead::Ready || !gate.matches(record)) return false;
        record["settling"] = gate.evidence();
        return true;
    }

    // The production TaskPanel and bridge supply every persona row. Only the
    // surface wrapper and elapsed-clock offsets belong to this controlled test.
    QVariantList personaInputProfiles(bool target = true, int preceding = 0) const {
        QVariantList rows{QVariantMap{{"id", "persona-current"}, {"name", "当前人格"}, {"active", true}}};
        for (int index = 0; index < preceding; ++index)
            rows.append(QVariantMap{{"id", QString("persona-before-%1").arg(index)},
                {"name", QString("前置人格 %1").arg(index)}, {"active", false}});
        if (target) rows.append(QVariantMap{{"id", "persona-target"}, {"name", "目标人格"}, {"active", false}});
        return rows;
    }
    void publishPersonaInputProfiles(const QVariantList &rows) {
        QString active;
        for (const auto &value : rows)
            if (value.toMap().value("active").toBool()) { active = value.toMap().value("id").toString(); break; }
        const QVariantMap scope{{"persona_id", m_bridge->m_persona.value("persona_id").toString()},
            {"persona_epoch", m_bridge->m_persona.value("epoch").toInt()},
            {"persona_fingerprint", m_bridge->m_persona.value("fingerprint").toString()}};
        auto list = scope; list.insert({{"ok", true}, {"active_id", active}, {"profiles", rows}});
        m_bridge->m_state["persona"] = scope;
        m_bridge->m_state["personas"] = list;
        emit m_bridge->changed();
    }
    bool preparePersonaInputPanel(bool target, int preceding = 0, const QDeadlineTimer *setupDeadline = nullptr) {
        capturePersonaFixture("panel-prepare-start");
        publishPersonaInputProfiles(personaInputProfiles(target, preceding));
        loadPanel();
        if (QTest::currentTestFailed() || !m_panel || !m_window) return false;
        m_window->resize(760, 650);
        auto *surface = new QQuickItem(m_window->contentItem());
        surface->setObjectName("taskSurface");
        surface->setSize(m_window->size());
        surface->setProperty("inputReady", true);
        m_panel->setParentItem(surface);
        m_panel->setObjectName("characterTasks");
        trackCandidateFrames();
        const bool settled = feedbackLayoutSettled(setupDeadline ? *setupDeadline : QDeadlineTimer(4000, Qt::PreciseTimer));
        capturePersonaFixture("active-panel-prepared");
        return settled;
    }
    QQuickItem *personaInputTarget(const QString &id = "persona-target") const {
        QList<QQuickItem *> rows;
        visualMatches(m_panel, "personaSwitch-" + id, rows);
        return rows.size() == 1 ? rows.first() : nullptr;
    }
    PersonaRowInputProbe::Context personaInputContext(QElapsedTimer &clock, qint64 &offset, int &dispatches,
                                                     const QString &targetId = "persona-target") {
        PersonaRowInputProbe::Context context;
        context.window = m_window.get();
        context.nowMs = [&clock, &offset] { return offset + clock.elapsed(); };
        context.frameSerial = [this] { return m_candidateFrameSerial; };
        context.currentScope = [this] { return m_bridge->scopeKey(); };
        context.currentGeneration = [this] { return m_bridge->generation(); };
        context.currentPersonaId = [this] { return m_bridge->state().value("personas").toMap().value("active_id").toString(); };
        context.personaState = [this] { return m_bridge->state().value("persona").toMap(); };
        context.personasState = [this] { return m_bridge->state().value("personas").toMap(); };
        context.profiles = [this] { return m_bridge->state().value("personas").toMap().value("profiles").toList(); };
        context.dispatch = [this, &dispatches, targetId](QQuickItem *item, const QPoint &, const std::function<void()> &sendMouse) {
            ++dispatches;
            QVERIFY(item == personaInputTarget(targetId));
            sendMouse();
        };
        return context;
    }
    PersonaRowInputProbe::Input::Result awaitPersonaInput(PersonaRowInputProbe::Input &input,
                                                  const PersonaRowInputProbe::Context &context) {
        auto result = PersonaRowInputProbe::Input::Waiting;
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        const bool finished = QTest::qWaitFor([&] {
            result = input.poll(context);
            return result != PersonaRowInputProbe::Input::Waiting;
        }, deadline);
        if (!finished) input.abort("controlled-test-wait-expired", context.nowMs());
        return finished ? result : PersonaRowInputProbe::Input::Failed;
    }
    bool personaInputEvidenceBounded(const QVariantMap &record, qint64 stepAt, int dispatches) const {
        const auto samples = record.value("samples").toList();
        const auto terminal = record.value("terminal").toMap();
        if (samples.size() > 6 || terminal.isEmpty()) return false;
        const auto wire = QJsonDocument::fromVariant(record).toJson(QJsonDocument::Compact);
        QJsonParseError error;
        const auto parsed = QJsonDocument::fromJson(wire, &error);
        return error.error == QJsonParseError::NoError && parsed.isObject() &&
            record.value("stepAtMs").toLongLong() == stepAt &&
            record.value("deadlineMs").toInt() == 4000 &&
            record.value("dispatchCount").toInt() == dispatches &&
            record.value("terminalCount").toInt() == 1 &&
            record.value("minimumStableMs").toInt() == 40 &&
            (dispatches != 0 || (!record.value("clickedSignals").isValid() &&
                !terminal.value("dispatchElapsedMs").isValid()));
    }

private slots:
    void personaRowInputTracksLateLayoutWithoutRestart_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("late-delegate") << QString("late");
        QTest::newRow("range-grows-after-first-reveal") << QString("growth");
        QTest::newRow("already-visible-no-scroll") << QString("visible");
        QTest::newRow("hidden-taskpanel-outside-root") << QString("hidden-copy");
    }
    void personaRowInputTracksLateLayoutWithoutRestart() {
        QFETCH(QString, scenario);
        const QDeadlineTimer setupDeadline(4000, Qt::PreciseTimer);
        QVERIFY(preparePersonaInputPanel(scenario != "late", scenario == "growth" ? 20 : 0, &setupDeadline));
        std::unique_ptr<QQuickItem> otherPanel;
        std::unique_ptr<QSignalSpy> hiddenClicked;
        const auto terminal = qScopeGuard([this] { capturePersonaFixture("terminal"); });
        if (scenario == "hidden-copy") {
            QQmlComponent component(m_engine.get(), QUrl("qrc:/persona-card-confirmation/ui/TaskPanel.qml"));
            QVERIFY2(!component.isError(), qPrintable(component.errorString()));
            otherPanel.reset(qobject_cast<QQuickItem *>(component.createWithInitialProperties({
                {"parent", QVariant::fromValue(m_window->contentItem())}, {"objectName", "hiddenPersonaTaskPanel"},
                {"page", "character"}, {"visible", false}, {"width", m_panel->width()}, {"height", m_panel->height()}})));
            capturePersonaFixture("hidden-copy-created", otherPanel.get());
            QVERIFY2(otherPanel, qPrintable(component.errorString()));
            const bool ready = QTest::qWaitFor([&] {
                capturePersonaFixture("hidden-copy-ready", otherPanel.get());
                QList<QQuickItem *> targets, rows;
                visualMatches(otherPanel.get(), "personaSwitch-persona-target", targets);
                visualMatches(otherPanel.get(), "personaRow-persona-target", rows);
                return targets.size() == 1 && rows.size() == 1 && rows.first()->isAncestorOf(targets.first());
            }, setupDeadline);
            QVERIFY2(ready && !setupDeadline.hasExpired(), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(m_personaFixtureLast))));
            QList<QQuickItem *> hiddenRows;
            visualMatches(otherPanel.get(), "personaRow-persona-target", hiddenRows);
            QCOMPARE(personaInputRowData(hiddenRows.first()).value("id").toString(), QString("persona-target"));
            QCOMPARE(personaInputRowData(hiddenRows.first()).value("active").toBool(), false);
            QVERIFY(!otherPanel->isVisible());
            QVERIFY(!m_panel->parentItem()->isAncestorOf(otherPanel.get()));
            QList<QQuickItem *> hiddenTargets; visualMatches(otherPanel.get(), "personaSwitch-persona-target", hiddenTargets);
            QCOMPARE(hiddenTargets.size(), 1);
            hiddenClicked = std::make_unique<QSignalSpy>(hiddenTargets.first(), SIGNAL(clicked()));
            QVERIFY(hiddenClicked->isValid());
            QCOMPARE(otherPanel->width(), m_panel->width());
            QCOMPARE(otherPanel->height(), m_panel->height());
        }
        auto *scroll = feedbackScrollContent();
        QVERIFY(scroll);
        const qreal initialY = scroll->property("contentY").toDouble();
        QElapsedTimer clock; clock.start();
        qint64 offset = 10000;
        int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const qint64 stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(422, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        if (scenario == "late") {
            QVERIFY(!personaInputTarget());
            publishPersonaInputProfiles(personaInputProfiles());
        } else if (scenario == "growth") {
            auto *row = personaInputTarget()->parentItem();
            const qreal oldHeight = scroll->property("contentHeight").toDouble();
            QVERIFY(QQmlProperty::write(row, "Layout.topMargin", 900, qmlContext(row)));
            QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
            QVERIFY(scroll->property("contentHeight").toDouble() > oldHeight);
            QVERIFY(!NativeControlReadiness::wholeVisibility(personaInputTarget(), m_window.get()).value("fullyVisible").toBool());
        }
        QCOMPARE(awaitPersonaInput(input, context), PersonaRowInputProbe::Input::Performed);
        QCOMPARE(dispatches, 1);
        if (otherPanel) { QVERIFY(!otherPanel->property("modalOpen").toBool()); QCOMPARE(hiddenClicked->count(), 0); }
        QCOMPARE(personaInputDialogTarget(), QString("persona-target"));
        QCOMPARE(rendererCommandCount("persona:activate"), 0); // Only the real confirmation dialog opens.
        QVERIFY(m_panel->property("modalOpen").toBool());
        const auto evidence = input.metadata();
        QVERIFY2(personaInputEvidenceBounded(evidence, stepAt, 1), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(evidence))));
        QCOMPARE(evidence.value("clickedSignals").toInt(), 1);
        const auto completed = evidence.value("terminal").toMap();
        const auto stable = completed.value("stableAnchor").toMap();
        QVERIFY(completed.value("dispatchElapsedMs").toLongLong() - stable.value("elapsedMs").toLongLong() >= 40);
        QVERIFY(completed.value("dispatchFrameSerial").toULongLong() > stable.value("frameSerial").toULongLong());
        if (scenario == "visible" || scenario == "hidden-copy")
            QCOMPARE(scroll->property("contentY").toDouble(), initialY);
        if (scenario == "growth") QVERIFY(scroll->property("contentY").toDouble() > initialY);
    }
    void personaRowInputRejectsChangedIdentity_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("scope-changed") << QString("scope");
        QTest::newRow("generation-changed") << QString("generation");
        QTest::newRow("source-persona-changed") << QString("source");
        QTest::newRow("row-id-changed") << QString("row");
        QTest::newRow("target-now-active") << QString("active");
        QTest::newRow("duplicate-target-under-active-root") << QString("duplicate");
    }
    void personaRowInputRejectsChangedIdentity() {
        QFETCH(QString, scenario);
        QVERIFY(preparePersonaInputPanel(true));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(401, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        std::unique_ptr<QQuickItem> duplicate;
        if (scenario == "scope") m_bridge->m_persona["epoch"] = 4;
        if (scenario == "generation") ++m_bridge->m_generation;
        if (scenario == "source") context.currentPersonaId = [] { return QString("persona-other"); };
        if (scenario == "row") {
            auto *row = personaInputTarget()->parentItem();
            QVERIFY(row->setProperty("modelData", QVariantMap{{"id", "persona-other"}, {"active", false}}));
        }
        if (scenario == "active") {
            auto rows = personaInputProfiles();
            auto target = rows.last().toMap(); target["active"] = true; rows.last() = target;
            publishPersonaInputProfiles(rows);
        }
        if (scenario == "duplicate") {
            duplicate = std::make_unique<QQuickItem>(personaInputTarget()->parentItem());
            duplicate->setObjectName("personaSwitch-persona-target");
        }
        const auto result = input.poll(context);
        if (scenario == "duplicate") QCOMPARE(result, PersonaRowInputProbe::Input::Failed);
        QVERIFY(result != PersonaRowInputProbe::Input::Performed);
        offset = stepAt + 4000 - clock.elapsed();
        QVERIFY(input.poll(context) != PersonaRowInputProbe::Input::Performed);
        QCOMPARE(dispatches, 0);
        QCOMPARE(rendererCommandCount("persona:activate"), 0);
        QVERIFY(!m_panel->property("modalOpen").toBool());
        QVERIFY2(personaInputEvidenceBounded(input.metadata(), stepAt, 0), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(input.metadata()))));
    }
    void personaRowInputUnavailableTargetNeverClicks_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("disabled") << QString("disabled");
        QTest::newRow("always-clipped") << QString("clipped");
        QTest::newRow("transparent") << QString("transparent");
        QTest::newRow("surface-not-ready") << QString("surface");
        QTest::newRow("no-new-presented-frame") << QString("frame");
        QTest::newRow("covered-by-input-acceptor") << QString("covered");
    }
    void personaRowInputUnavailableTargetNeverClicks() {
        QFETCH(QString, scenario);
        QVERIFY(preparePersonaInputPanel(true));
        auto *target = personaInputTarget(); QVERIFY(target);
        auto *surface = m_panel->parentItem();
        std::unique_ptr<QQuickItem> cover;
        if (scenario == "disabled") target->setEnabled(false);
        if (scenario == "clipped") { surface->setClip(true); surface->setHeight(1); }
        if (scenario == "transparent") target->setOpacity(0);
        if (scenario == "surface") surface->setProperty("inputReady", false);
        if (scenario == "covered") {
            cover = std::make_unique<QQuickItem>(m_window->contentItem());
            cover->setSize(m_window->size()); cover->setZ(1000); cover->setAcceptedMouseButtons(Qt::LeftButton);
        }
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        if (scenario == "frame") context.frameSerial = [] { return quint64(11); };
        const auto stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(405, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        for (int index = 0; index < 9; ++index) {
            offset = stepAt + index * 100 - clock.elapsed();
            QVERIFY(input.poll(context) != PersonaRowInputProbe::Input::Performed);
            QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
        }
        offset = stepAt + 4000 - clock.elapsed();
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Expired);
        QCOMPARE(dispatches, 0);
        const auto evidence = input.metadata();
        QVERIFY2(personaInputEvidenceBounded(evidence, stepAt, 0), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(evidence))));
        QVERIFY(evidence.value("samples").toList().size() <= 6);
        QVERIFY(!evidence.value("terminal").toMap().isEmpty());
    }
    void personaRowInputDeadlineAndFinalScopeAreRechecked_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("exact-deadline") << QString("deadline");
        QTest::newRow("deadline-consumed-during-reveal") << QString("reveal");
        QTest::newRow("deadline-consumed-by-capture") << QString("capture");
        QTest::newRow("scope-changes-during-capture") << QString("scope");
    }
    void personaRowInputDeadlineAndFinalScopeAreRechecked() {
        QFETCH(QString, scenario);
        QVERIFY(preparePersonaInputPanel(true, scenario == "reveal" ? 20 : 0));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(418, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        CandidateFocusObserver revealObserver;
        int preparationCalls = 0;
        if (scenario == "reveal") {
            auto *scroll = feedbackScrollContent(); QVERIFY(scroll);
            const auto property = scroll->metaObject()->property(scroll->metaObject()->indexOfProperty("contentY"));
            QVERIFY(property.hasNotifySignal());
            revealObserver.observe = [&] { ++preparationCalls; offset = stepAt + 4000 - clock.elapsed(); };
            const auto slot = revealObserver.metaObject()->method(revealObserver.metaObject()->indexOfSlot("changed()"));
            QVERIFY(QObject::connect(scroll, property.notifySignal(), &revealObserver, slot, Qt::DirectConnection));
        } else if (scenario == "deadline") offset = stepAt + 4000 - clock.elapsed();
        else context.beforeDispatch = [&] {
            ++preparationCalls;
            if (scenario == "capture") offset = stepAt + 4000 - clock.elapsed();
            else m_bridge->m_persona["epoch"] = 4;
        };
        const auto result = awaitPersonaInput(input, context);
        QVERIFY(result == PersonaRowInputProbe::Input::Expired || result == PersonaRowInputProbe::Input::Failed);
        QCOMPARE(dispatches, 0);
        if (scenario != "deadline") QCOMPARE(preparationCalls, 1);
        const auto terminal = input.metadata();
        QVERIFY2(personaInputEvidenceBounded(terminal, stepAt, 0), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(terminal))));
        // Restoring the clock or scope cannot resurrect this finished input.
        offset = 10000 - clock.elapsed(); m_bridge->m_persona["epoch"] = 3;
        QVERIFY(input.poll(context) != PersonaRowInputProbe::Input::Performed);
        QCOMPARE(dispatches, 0);
    }
    void personaRowInputReplacementResetsObservationOnly() {
        QVERIFY(preparePersonaInputPanel(true));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(506, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        QPointer<QQuickItem> oldTarget = personaInputTarget(); QVERIFY(oldTarget);
        publishPersonaInputProfiles(personaInputProfiles(false));
        QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
        QVERIFY(!personaInputTarget());
        publishPersonaInputProfiles(personaInputProfiles());
        QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
        QVERIFY(personaInputTarget());
        QVERIFY(oldTarget != personaInputTarget());
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        QCOMPARE(dispatches, 0);
        QCOMPARE(awaitPersonaInput(input, context), PersonaRowInputProbe::Input::Performed);
        QCOMPARE(dispatches, 1);
        QVERIFY(personaInputEvidenceBounded(input.metadata(), stepAt, 1));
    }
    void personaRowInputDispatchRemainsOnce_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("repeated-poll-after-click") << QString("repeat");
        QTest::newRow("synchronous-reentry") << QString("reenter");
        QTest::newRow("dispatch-exception") << QString("throw");
    }
    void personaRowInputDispatchRemainsOnce() {
        QFETCH(QString, scenario);
        QVERIFY(preparePersonaInputPanel(true));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs();
        PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(scenario == "repeat" ? 510 : 518, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        const auto physical = context.dispatch;
        context.dispatch = [&](QQuickItem *target, const QPoint &point, const std::function<void()> &sendMouse) {
            if (scenario == "reenter") QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
            if (scenario == "throw") { ++dispatches; throw std::runtime_error("fixed-dispatch-test-failure"); }
            physical(target, point, sendMouse);
        };
        const auto result = awaitPersonaInput(input, context);
        QCOMPARE(result, scenario == "throw" ? PersonaRowInputProbe::Input::Failed : PersonaRowInputProbe::Input::Performed);
        for (int index = 0; index < 3; ++index) QCOMPARE(input.poll(context), result);
        QCOMPARE(dispatches, 1);
        QCOMPARE(m_panel->property("modalOpen").toBool(), scenario != "throw");
        QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), scenario == "throw" ? 0 : 1);
        QVERIFY2(personaInputEvidenceBounded(input.metadata(), stepAt, 1), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(input.metadata()))));
    }

    void personaRowInputProductionPortalGeometry_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height"); QTest::addColumn<bool>("blocked");
        QTest::newRow("normal-nested-clip") << 900 << 760 << false;
        QTest::newRow("narrow-nested-clip") << 591 << 546 << false;
        QTest::newRow("real-input-ready-transition") << 591 << 546 << true;
    }
    void personaRowInputProductionPortalGeometry() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, blocked);
        publishPersonaInputProfiles(personaInputProfiles(true, 20));
        QVERIFY(preparePersonaPortalPanel(width, height, blocked));
        QList<QQuickItem *> roots, globalTargets;
        visualMatches(m_window->contentItem(), "taskSurface", roots);
        visualMatches(m_window->contentItem(), "personaSwitch-persona-target", globalTargets);
        QCOMPARE(roots.size(), 1); QCOMPARE(globalTargets.size(), 3);
        QVERIFY(roots.first()->isAncestorOf(m_panel));
        QCOMPARE(roots.first()->property("inputReady").toBool(), !blocked);
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs(); PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(422, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        if (blocked) {
            QCOMPARE(dispatches, 0);
            QVERIFY(!personaInputTarget()->isEnabled());
            QVERIFY(m_window->setProperty("blockInput", false));
        }
        QCOMPARE(awaitPersonaInput(input, context), PersonaRowInputProbe::Input::Performed);
        QCOMPARE(dispatches, 1); QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), 1);
        const auto terminal = input.metadata().value("terminal").toMap();
        QVERIFY(terminal.value("control").toMap().value("clipCount").toInt() >= 2);
        QVERIFY(terminal.value("whole").toMap().value("fullyVisible").toBool());
        QCOMPARE(terminal.value("controlCount").toInt(), 1);
        for (const auto *name : {"memoryTasks", "terminalTasks"}) {
            QList<QQuickItem *> panels; visualMatches(m_window->contentItem(), name, panels);
            QCOMPARE(panels.size(), 1); QVERIFY(!panels.first()->isVisible());
            QVERIFY(!panels.first()->property("modalOpen").toBool());
        }
        QVERIFY(personaInputEvidenceBounded(input.metadata(), stepAt, 1));
    }
    void personaRowInputTransparentSurfaceBlocksPhysicalInput() {
        publishPersonaInputProfiles(personaInputProfiles());
        QVERIFY(preparePersonaPortalPanel(760, 650));
        QVERIFY(m_window->setProperty("transparentShield", true));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs(); PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(422, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        offset = stepAt + 4000 - clock.elapsed();
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Expired);
        QCOMPARE(dispatches, 0); QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), 0);
        QVERIFY(!m_panel->property("modalOpen").toBool());
        const auto sample = input.metadata().value("samples").toList().first().toMap();
        QCOMPARE(sample.value("hit").toMap().value("hitResult").toString(), QString("other"));
        QVERIFY(sample.value("whole").toMap().value("fullyVisible").toBool());
    }
    void personaRowInputPhysicalSignalKeepsOnce_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("actual-clicked-signal-reentry") << QString("reentry");
        QTest::newRow("exception-after-physical-click") << QString("after-click-throw");
    }
    void personaRowInputPhysicalSignalKeepsOnce() {
        QFETCH(QString, scenario); QVERIFY(preparePersonaInputPanel(true));
        auto *target = personaInputTarget(); QVERIFY(target);
        QSignalSpy clicked(target, SIGNAL(clicked())); QVERIFY(clicked.isValid());
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0, reentries = 0;
        auto context = personaInputContext(clock, offset, dispatches);
        const auto stepAt = context.nowMs(); PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(518, "persona-target", m_bridge->scopeKey(), m_bridge->generation(), stepAt, "persona-current", "persona-current"));
        CandidateFocusObserver observer;
        observer.observe = [&] { ++reentries; QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting); };
        if (scenario == "reentry") {
            const auto signal = target->metaObject()->method(target->metaObject()->indexOfSignal("clicked()"));
            const auto slot = observer.metaObject()->method(observer.metaObject()->indexOfSlot("changed()"));
            QVERIFY(QObject::connect(target, signal, &observer, slot, Qt::DirectConnection));
        }
        const auto physical = context.dispatch;
        context.dispatch = [&](QQuickItem *item, const QPoint &point, const std::function<void()> &sendMouse) {
            physical(item, point, sendMouse);
            if (scenario == "after-click-throw") throw std::runtime_error("fixed-error-after-physical-click");
        };
        const auto result = awaitPersonaInput(input, context);
        QCOMPARE(result, scenario == "reentry" ? PersonaRowInputProbe::Input::Performed : PersonaRowInputProbe::Input::Failed);
        QCOMPARE(dispatches, 1); QCOMPARE(clicked.count(), 1);
        QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), 1);
        QCOMPARE(input.metadata().value("clickedSignals").toInt(), 1);
        QCOMPARE(reentries, scenario == "reentry" ? 1 : 0);
        QVERIFY(m_panel->property("modalOpen").toBool());
        for (int index = 0; index < 3; ++index) QCOMPARE(input.poll(context), result);
        QCOMPARE(clicked.count(), 1); QCOMPARE(dispatches, 1);
    }
    void personaRowInputIndependentIdentityReadsMustAgree_data() {
        QTest::addColumn<QString>("field");
        QTest::newRow("get-live-id-differs") << QString("get-live");
        QTest::newRow("list-live-scope-differs") << QString("list-scope");
        QTest::newRow("active-profile-differs") << QString("active-profile");
    }
    void personaRowInputIndependentIdentityReadsMustAgree() {
        QFETCH(QString, field);
        configurePersonaInputIdentity("default", "builtin_hoshino_yumetsuki", "persona-sunny", 3, 7, QLatin1Char('a'));
        QVERIFY(preparePersonaPortalPanel(760, 650));
        QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
        auto context = personaInputContext(clock, offset, dispatches, "persona-sunny");
        const auto stepAt = context.nowMs(); PersonaRowInputProbe::Input input;
        QVERIFY(input.bind(401, "persona-sunny", m_bridge->scopeKey(), 7, stepAt, "default", "builtin_hoshino_yumetsuki"));
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Waiting);
        auto get = m_bridge->m_state.value("persona").toMap(), list = m_bridge->m_state.value("personas").toMap();
        if (field == "get-live") get["persona_id"] = "other-live";
        if (field == "list-scope") list["persona_epoch"] = 4;
        if (field == "active-profile") list["active_id"] = "persona-sunny";
        m_bridge->m_state["persona"] = get; m_bridge->m_state["personas"] = list;
        QCOMPARE(input.poll(context), PersonaRowInputProbe::Input::Failed);
        QCOMPARE(dispatches, 0); QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), 0);
        QVERIFY(!m_panel->property("modalOpen").toBool());
    }
    void candidateHeaderStableReadUsesRealLayout_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("late-layout-must-restabilize") << QString("late-layout");
        QTest::newRow("same-frame-never-qualifies") << QString("same-frame");
        QTest::newRow("hidden-retains-new-frame-gate") << QString("hidden");
        QTest::newRow("expired-read-cannot-qualify") << QString("expired");
        QTest::newRow("read-clock-regression-is-terminal") << QString("regression");
        QTest::newRow("read-binding-change-is-terminal") << QString("binding");
    }
    void candidateHeaderStableReadUsesRealLayout() {
        QFETCH(QString, scenario); QVERIFY(prepareCandidateBatchPanel(760, 650));
        m_panel->setObjectName("memoryTasks");
        if (scenario == "hidden") QVERIFY(m_panel->setProperty("page", "settings"));
        trackCandidateFrames(); QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
        const auto readId = lastRendererCommand("memory:candidates:list").value("request_id").toString();
        const auto inspect = [&] { return CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), 3,
            readId, m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial); };
        CandidateHeaderProbe::StableRead gate;
        auto first = inspect();
        QCOMPARE(gate.poll(first, scenario != "hidden", 0, 10000), CandidateHeaderProbe::StableRead::Waiting);
        if (scenario == "same-frame") {
            QCOMPARE(gate.poll(first, true, 100, 10000), CandidateHeaderProbe::StableRead::Waiting);
            QCOMPARE(gate.poll(first, true, 10000, 10000), CandidateHeaderProbe::StableRead::Expired);
            QVERIFY(!gate.evidence().value("ready").toBool()); return;
        }
        if (scenario == "expired") {
            QCOMPARE(gate.poll(first, true, 10000, 10000), CandidateHeaderProbe::StableRead::Expired);
            QVERIFY(!gate.matches(first));
            QCOMPARE(gate.poll(first, true, 1, 10000), CandidateHeaderProbe::StableRead::Expired);
            QVERIFY(!gate.matches(first)); return;
        }
        if (scenario == "regression") {
            QCOMPARE(gate.poll(first, true, 100, 10000), CandidateHeaderProbe::StableRead::Waiting);
            QCOMPARE(gate.poll(first, true, 99, 10000), CandidateHeaderProbe::StableRead::Failed);
            QCOMPARE(gate.poll(first, true, 101, 10000), CandidateHeaderProbe::StableRead::Failed);
            QVERIFY(!gate.matches(first)); return;
        }
        if (scenario == "binding") {
            ++m_bridge->m_generation;
            QCOMPARE(gate.poll(inspect(), true, 40, 10000), CandidateHeaderProbe::StableRead::Failed);
            --m_bridge->m_generation;
            QCOMPARE(gate.poll(inspect(), true, 80, 10000), CandidateHeaderProbe::StableRead::Failed);
            QVERIFY(!gate.matches(first)); return;
        }
        if (scenario == "late-layout") m_window->resize(591, 650);
        QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
        auto current = inspect();
        const auto result = gate.poll(current, scenario != "hidden", 60, 10000);
        if (scenario == "late-layout") {
            QCOMPARE(result, CandidateHeaderProbe::StableRead::Waiting);
            QCOMPARE(gate.evidence().value("stableSinceMs").toLongLong(), 60);
            QVERIFY(feedbackLayoutSettled(QDeadlineTimer(4000, Qt::PreciseTimer)));
            current = inspect();
            QCOMPARE(gate.poll(current, true, 101, 10000), CandidateHeaderProbe::StableRead::Ready);
        } else QCOMPARE(result, CandidateHeaderProbe::StableRead::Ready);
        QVERIFY(gate.matches(current));
        QVERIFY(gate.evidence().value("frameSerial").toLongLong() > gate.evidence().value("stableFrameSerial").toLongLong());
    }
    void archiveInputPhaseClockKeepsReadAndInputLimitsSeparate() {
        ArchiveInputProbe::PhaseClock clock;
        clock.enter(100, true);
        QCOMPARE(clock.inputAt(), qint64(-1)); QCOMPARE(clock.readElapsed(4200), qint64(4100));
        QVERIFY(clock.beginInput(4200)); QCOMPARE(clock.elapsed(4200), qint64(0));
        QVERIFY(clock.beginInput(4300)); QCOMPARE(clock.inputAt(), qint64(4200));
        QCOMPARE(clock.elapsed(8199), qint64(3999)); QCOMPARE(clock.elapsed(8200), qint64(4000));
        clock.enter(9000, false); QCOMPARE(clock.inputAt(), qint64(9000));
        QVERIFY(!clock.beginInput(8999)); QCOMPARE(clock.inputAt(), qint64(9000));
    }
    void archiveSaveBindingAcceptsReceiptBeforePendingPoll_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("ack-before-pending-observation") << QString("fast");
        QTest::newRow("pending-and-ack-same-id") << QString("same");
        QTest::newRow("old-receipt-cannot-bind") << QString("old");
        QTest::newRow("two-new-writes-refused") << QString("multiple");
        QTest::newRow("generation-change-refused") << QString("generation");
    }
    void archiveSaveBindingAcceptsReceiptBeforePendingPoll() {
        QFETCH(QString, scenario);
        const QString scope = "persona-sunny:4:" + QString(64, QLatin1Char('b'));
        const QVariantMap old{{"requestId", "old-write"}, {"command", "archive:put"}, {"scope", scope}, {"generation", 8}};
        const QVariantMap pending{{"id", "new-write"}, {"command", "archive:put"}, {"generation", 8}};
        const QVariantMap receipt{{"requestId", "new-write"}, {"command", "archive:put"}, {"scope", scope}, {"generation", 8}};
        ArchiveInputProbe::SaveBinding binding; QVERIFY(binding.arm(scope, 8, {}, {old}));
        QVariantList waits, replies{old}; int generation = 8;
        if (scenario != "old") replies.append(receipt);
        if (scenario == "same") waits.append(pending);
        if (scenario == "multiple") { auto extra = receipt; extra["requestId"] = "other-write"; replies.append(extra); }
        if (scenario == "generation") generation = 9;
        const auto result = binding.observe(scope, generation, waits, replies);
        if (scenario == "old") { QCOMPARE(result, ArchiveInputProbe::SaveBinding::Waiting); QVERIFY(binding.requestId().isEmpty()); }
        else if (scenario == "multiple" || scenario == "generation") QCOMPARE(result, ArchiveInputProbe::SaveBinding::Failed);
        else { QCOMPARE(result, ArchiveInputProbe::SaveBinding::Matched); QCOMPARE(binding.requestId(), QString("new-write")); }
    }
    void archiveSelectorPhysicalPopupRetainsKeyboardOwnership() {
        QVERIFY(loadPriorityDrawer(0, false));
        trackCandidateFrames();
        const auto commands = m_frames.size();
        for (const auto *name : {"worldbookBookSelector", "worldbookEntrySelector"}) {
            QList<QQuickItem *> controls; visualMatches(m_panel, name, controls); QCOMPARE(controls.size(), 1);
            auto *target = controls.first();
            QElapsedTimer clock; clock.start(); const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            const bool shown = QTest::qWaitFor([&] {
                NativeControlReadiness::revealWholeItem(target, [&] { return clock.elapsed(); }, 4000);
                m_window->update();
                return NativeControlReadiness::wholeVisibility(target, m_window.get()).value("fullyVisible").toBool();
            }, deadline);
            QVERIFY(shown && !deadline.hasExpired());
            QSignalSpy activated(target, SIGNAL(activated(int))); QVERIFY(activated.isValid());
            const auto point = target->mapToScene(QPointF(target->width()/2, target->height()/2)).toPoint();
            QVERIFY(NativeCheck::hitTest(m_window.get(), point, target).accepted());
            QVERIFY(!deadline.hasExpired());
            QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point, 0);
            auto *popup = target->property("popup").value<QObject *>(); QVERIFY(popup);
            QVERIFY(popup->property("visible").toBool());
            for (const auto key : {Qt::Key_Home, Qt::Key_Down, Qt::Key_Return}) {
                QVERIFY(!deadline.hasExpired());
                QVERIFY(ArchiveInputProbe::keyboardFocusMatches(target, m_window.get(), true));
                QTest::keyClick(m_window.get(), key);
            }
            QVERIFY(!deadline.hasExpired());
            QCOMPARE(activated.count(), 1); QCOMPARE(target->property("currentIndex").toInt(), 1);
            QVERIFY(!popup->property("visible").toBool());
        }
        QCOMPARE(m_frames.size(), commands); QVERIFY(!m_archive->dirty());
    }
    void authorPromptOffUsesSwitchSignalAndOwnArchiveWrite() {
        m_archive = std::make_unique<ArchiveEditor>([this](const QString &command, const QVariantMap &payload) {
            return m_bridge->request(command, payload);
        });
        connect(m_bridge.get(), &RuntimeBridge::responseReceived, m_archive.get(), &ArchiveEditor::receive);
        connect(m_bridge.get(), &RuntimeBridge::requestFailed, m_archive.get(), &ArchiveEditor::failed);
        m_archive->setSession(true, m_bridge->generation(), m_bridge->scopeKey(), true);
        const auto readId = lastRendererCommand("archive:get").value("request_id").toString(); QVERIFY(!readId.isEmpty());
        QJsonObject card{{"id", "persona-current"}, {"name", "当前人格"},
            {"useImportedSystemPrompt", false}, {"useImportedPostHistoryInstructions", true}};
        QJsonObject archive{{"characters", QJsonArray{card}}, {"activeCharacterIds", QJsonArray{"persona-current"}}, {"worldBooks", QJsonArray{}}};
        const auto review = [](bool on) { return QJsonObject{{"card_id", "persona-current"},
            {"system", QJsonObject{{"text", "测试系统提示"}, {"flags", QJsonArray{}}, {"enabled", false}, {"effective", false}}},
            {"post_history", QJsonObject{{"text", "测试对话后指令"}, {"flags", QJsonArray{}}, {"enabled", on}, {"effective", on}}}}; };
        m_bridge->event({{"type", "archive:result"}, {"request_id", readId}, {"payload", QJsonObject{{"ok", true},
            {"exists", true}, {"revision", 4}, {"archive", archive}, {"author_prompts", review(true)}}}});
        QVERIFY(m_archive->initialized()); QVERIFY(m_archive->authorPromptBlocker().isEmpty());
        publishPersonaInputProfiles(personaInputProfiles()); loadPanel(); QVERIFY(m_panel);
        QList<QQuickItem *> matches; visualMatches(m_panel, "authorPromptSwitch-post_history", matches);
        QCOMPARE(matches.size(), 1); auto *target = matches.first();
        QElapsedTimer clock; clock.start(); const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        const bool shown = QTest::qWaitFor([&] {
            NativeControlReadiness::revealWholeItem(target, [&] { return clock.elapsed(); }, 4000);
            m_window->update();
            return NativeControlReadiness::wholeVisibility(target, m_window.get()).value("fullyVisible").toBool();
        }, deadline);
        QVERIFY(shown && !deadline.hasExpired()); QVERIFY(target->isEnabled()); QVERIFY(target->property("checked").toBool());
        QSignalSpy clicked(target, SIGNAL(clicked())), toggled(target, SIGNAL(toggled()));
        QVERIFY(clicked.isValid() && toggled.isValid());
        ArchiveInputProbe::SaveBinding binding;
        QVERIFY(binding.arm(m_bridge->scopeKey(), m_bridge->generation(), m_bridge->diagnostics().value("pendingCommands").toList(), {}));
        const auto puts = rendererCommandCount("archive:put");
        const auto point = target->mapToScene(QPointF(target->width()/2, target->height()/2)).toPoint();
        QVERIFY(NativeCheck::hitTest(m_window.get(), point, target).accepted());
        QVERIFY(!deadline.hasExpired());
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point, 0);
        QVERIFY(ArchiveInputProbe::switchInputMatches(1, clicked.count(), toggled.count()));
        QCOMPARE(toggled.count(), 1); QCOMPARE(rendererCommandCount("archive:put"), puts + 1);
        QCOMPARE(m_archive->authorPromptFeedback().value("status").toString(), QString("pending"));
        QVERIFY(!target->isEnabled()); QVERIFY(!target->property("checked").toBool());
        const auto write = lastRendererCommand("archive:put");
        QCOMPARE(binding.observe(m_bridge->scopeKey(), m_bridge->generation(), m_bridge->diagnostics().value("pendingCommands").toList(), {}), ArchiveInputProbe::SaveBinding::Matched);
        QCOMPARE(binding.requestId(), write.value("request_id").toString());
        QCOMPARE(write.value("payload").toObject().value("expected_revision").toInt(), 4);
        card["useImportedPostHistoryInstructions"] = false; archive["characters"] = QJsonArray{card};
        QCOMPARE(write.value("payload").toObject().value("archive").toObject(), archive);
        m_bridge->event({{"type", "archive:result"}, {"request_id", write.value("request_id")}, {"payload", QJsonObject{{"ok", true},
            {"exists", true}, {"revision", 5}, {"archive", archive}, {"author_prompts", review(false)}}}});
        QCOMPARE(m_archive->revision(), 5); QCOMPARE(m_archive->authorPromptFeedback().value("status").toString(), QString("success"));
        QCOMPARE(rendererCommandCount("archive:put"), puts + 1); QVERIFY(!target->property("checked").toBool());
    }

    void nativeInputEvidenceProducedForHost_data() {
        QTest::addColumn<QString>("caseId");
        QTest::newRow("persona-row-default-success") << QString("persona-row-default-success");
        QTest::newRow("persona-row-imported-success") << QString("persona-row-imported-success");
        QTest::newRow("candidate-header-visible") << QString("candidate-header-visible");
        QTest::newRow("candidate-header-hidden") << QString("candidate-header-hidden");
    }
    void nativeInputEvidenceProducedForHost() {
        QFETCH(QString, caseId);
        QJsonObject specification;
        for (const auto &entry : nativeEvidenceContract().value("cases").toArray())
            if (entry.toObject().value("caseId").toString() == caseId) specification = entry.toObject();
        QVERIFY(!specification.isEmpty()); const auto expected = specification.value("expected").toObject();
        if (specification.value("kind").toString() == "persona-row") {
            const auto profile = expected.value("sourcePersonaId").toString(), live = expected.value("livePersonaId").toString();
            const auto targetId = expected.value("targetId").toString();
            const auto parts = expected.value("scope").toString().split(':'); QCOMPARE(parts.size(), 3);
            configurePersonaInputIdentity(profile, live, targetId, parts[1].toInt(), expected.value("generation").toInt(), parts[2].front());
            QVERIFY(preparePersonaPortalPanel(760, 650));
            QElapsedTimer clock; clock.start(); qint64 offset = 10000; int dispatches = 0;
            auto context = personaInputContext(clock, offset, dispatches, targetId);
            const auto stepAt = context.nowMs(); PersonaRowInputProbe::Input input;
            QVERIFY(input.bind(expected.value("step").toInt(), targetId, m_bridge->scopeKey(), m_bridge->generation(), stepAt, profile, live));
            QCOMPARE(awaitPersonaInput(input, context), PersonaRowInputProbe::Input::Performed);
            QCOMPARE(dispatches, 1); QCOMPARE(input.metadata().value("mouseDispatchCount").toInt(), 1);
            const auto mouse = input.metadata().value("terminal").toMap().value("mouse").toMap();
            QCOMPARE(mouse.value("control").toMap().value("fullyVisible"), mouse.value("whole").toMap().value("fullyVisible"));
            QCOMPARE(mouse.value("control").toMap().value("fullyVisible"), QVariant(true));
            QCOMPARE(personaInputDialogTarget(), targetId);
            QVERIFY(personaInputEvidenceBounded(input.metadata(), stepAt, 1));
            QVERIFY(writeNativeEvidence(caseId, input.metadata()));
        } else {
            configurePersonaInputIdentity("default", "builtin_hoshino_yumetsuki", "persona-sunny", 3, 7, QLatin1Char('a'));
            loadPanel(); QVERIFY(m_panel); m_panel->setObjectName("memoryTasks"); m_window->resize(591, 650);
            QVERIFY(selectMemoryCandidatesPage());
            m_bridge->refreshMemories();
            const auto envelope = lastRendererCommand("memory:candidates:list");
            const auto readId = envelope.value("request_id").toString(); QVERIFY(!readId.isEmpty());
            auto payload = candidatePage(candidateRows(1, 100));
            payload.insert("persona_id", m_bridge->m_persona.value("persona_id"));
            payload.insert("persona_epoch", m_bridge->m_persona.value("epoch"));
            payload.insert("persona_fingerprint", m_bridge->m_persona.value("fingerprint"));
            const QJsonObject receipt{{"type", "memory:candidates:result"}, {"request_id", readId}, {"payload", payload}};
            m_bridge->event(receipt); deliverConfirmed();
            const bool visible = expected.value("visible").toBool();
            if (!visible) QVERIFY(m_panel->setProperty("page", "settings"));
            trackCandidateFrames();
            QVariantMap record; QVERIFY(stableCandidateHeader(readId, 100, visible, record));
            QVERIFY(writeNativeEvidence(caseId, record, {{"command", "memory:candidates:list"}, {"envelope", envelope}, {"receipt", receipt}}));
        }
    }
    void cleanupTestCase() {
        QVERIFY(writeArchiveFocusManifest());
        QVERIFY(writeWorldbookRegexManifest());
        const auto directory = qEnvironmentVariable("REVERIE_P1_NATIVE_EVIDENCE_DIR");
        if (directory.isEmpty()) return;
        const auto contract = nativeEvidenceContract(); const auto cases = contract.value("cases").toArray();
        QCOMPARE(m_nativeEvidenceFiles.size(), cases.size());
        QJsonArray ordered;
        for (const auto &entry : cases) {
            const auto caseId = entry.toObject().value("caseId").toString();
            QJsonObject written;
            for (const auto &file : m_nativeEvidenceFiles) if (file.toObject().value("caseId").toString() == caseId) written = file.toObject();
            QVERIFY(!written.isEmpty()); ordered.append(written);
        }
        const auto bytes = QJsonDocument(QJsonObject{{"schema", "reverie.native-input-evidence.manifest.v1"},
            {"contractSha256", QString::fromLatin1(QCryptographicHash::hash(nativeEvidenceContractBytes(), QCryptographicHash::Sha256).toHex())},
            {"cases", ordered}}).toJson(QJsonDocument::Compact);
        QFile manifest(QDir(directory).filePath("manifest.json"));
        QVERIFY(manifest.open(QIODevice::WriteOnly | QIODevice::NewOnly));
        QCOMPARE(manifest.write(bytes), qint64(bytes.size())); QVERIFY(manifest.flush());
    }

    void candidateHeaderRemainsWholeAtEveryScrollPosition_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("height"); QTest::addColumn<int>("position");
        QTest::newRow("normal-top") << 1000 << 900 << 0;
        QTest::newRow("normal-middle") << 1000 << 900 << 1;
        QTest::newRow("normal-bottom") << 1000 << 900 << 2;
        QTest::newRow("narrow-top") << 591 << 546 << 0;
        QTest::newRow("narrow-middle") << 591 << 546 << 1;
        QTest::newRow("narrow-bottom") << 591 << 546 << 2;
    }
    void candidateHeaderRemainsWholeAtEveryScrollPosition() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(int, position);
        QVERIFY(prepareCandidateBatchPanel(width, height));
        m_bridge->refreshMemories();
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), feedbackMemoryRows());
        deliverCandidate(candidatePage(candidateRows(1, 100), true, "mc1.next"));
        trackCandidateFrames();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *header = batchControl("memoryCandidatePageInfo");
        auto *content = feedbackScrollContent();
        QVERIFY(header && content);
        const double maximum = content->property("contentHeight").toDouble() - content->height();
        QVERIFY(maximum > 0);
        QVERIFY(content->setProperty("contentY", position == 0 ? 0 : position == 1 ? maximum / 2 : maximum));
        QVERIFY(feedbackLayoutSettled(deadline));
        QQuickItem sentinel(m_window->contentItem());
        sentinel.setFlag(QQuickItem::ItemIsFocusScope); sentinel.forceActiveFocus();
        auto *focused = m_window->activeFocusItem();
        const auto frames = m_frames.size();
        const double offset = content->property("contentY").toDouble();
        const auto proof = CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), 100,
            lastRendererCommand("memory:candidates:list")["request_id"].toString(),
            m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial);
        QVERIFY2(CandidateHeaderProbe::valid(proof, true), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(proof))));
        // Exercise the same QVariantMap -> JSON wire representation used by
        // the real GUI report; enum metadata must not serialize as "PlainText".
        QJsonParseError parseError;
        const auto wire = QJsonDocument(QJsonObject::fromVariantMap(proof)).toJson(QJsonDocument::Compact);
        const auto parsed = QJsonDocument::fromJson(wire, &parseError);
        QCOMPARE(parseError.error, QJsonParseError::NoError);
        QVERIFY(parsed.isObject());
        const auto serialized = parsed.object();
        QVERIFY(serialized.value("textFormat").isDouble());
        QCOMPARE(serialized.value("textFormat").toDouble(), 0.);
        QVERIFY(serialized.value("textFormatValid").isBool());
        QVERIFY(serialized.value("textFormatValid").toBool());
        QVERIFY(serialized.value("acceptedMouseButtons").isDouble());
        QCOMPARE(serialized.value("acceptedMouseButtons").toDouble(), double(Qt::NoButton));
        QCOMPARE(header->property("text").toString(), QString("待确认 · 第1批 · 本批100条"));
        QCOMPARE(header->property("color").value<QColor>(), QColor("#d8c79f"));
        QCOMPARE(header->property("font").value<QFont>().pixelSize(), 14);
        QCOMPARE(m_window->activeFocusItem(), focused);
        QCOMPARE(content->property("contentY").toDouble(), offset);
        QCOMPARE(m_frames.size(), frames);
        // The production plain Text has NoButton. Still deliver a real press
        // and require it to leave focus, scroll and command counts unchanged.
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier,
            header->mapToScene(QPointF(header->width()/2, header->height()/2)).toPoint());
        QVERIFY(feedbackLayoutSettled(deadline));
        QCOMPARE(m_window->activeFocusItem(), focused);
        QCOMPARE(content->property("contentY").toDouble(), offset);
        QCOMPARE(m_frames.size(), frames);
        const auto attached = readMemoryFeedbackAttached(header, m_engine.get(), header->property("text").toString());
        QVERIFY(attached.valid());
    }
    void candidateHeaderEnumEvidenceKeepsUnknownValuesNull_data() {
        QTest::addColumn<QByteArray>("propertyName");
        QTest::newRow("missing-property") << QByteArray("missingFormat");
        QTest::newRow("non-enum-integer") << QByteArray("integerFormat");
        QTest::newRow("non-enum-string") << QByteArray("stringFormat");
        QTest::newRow("invalid-enum-member") << QByteArray("invalidFormat");
    }
    void candidateHeaderEnumEvidenceKeepsUnknownValuesNull() {
        QFETCH(QByteArray, propertyName);
        CandidateHeaderEnumFixture source;
        const auto result = CandidateHeaderProbe::enumProperty(&source, propertyName.constData());
        QVERIFY(result.value("valid").metaType().id() == QMetaType::Bool);
        QVERIFY(!result.value("valid").toBool());
        QVERIFY(!result.value("value").isValid());
        const auto metadata = result.value("property").toMap();
        QVERIFY(!metadata.value("memberValid").toBool());
        if (propertyName == "missingFormat") {
            QVERIFY(!metadata.value("exists").toBool());
            QVERIFY(!metadata.value("readSucceeded").toBool());
        } else {
            QVERIFY(metadata.value("exists").toBool());
            QVERIFY(metadata.value("readable").toBool());
            QVERIFY(metadata.value("readSucceeded").toBool());
            QCOMPARE(metadata.value("enumProperty").toBool(), propertyName == "invalidFormat");
        }
        QJsonParseError parseError;
        const auto wire = QJsonDocument(QJsonObject::fromVariantMap(result)).toJson(QJsonDocument::Compact);
        const auto serialized = QJsonDocument::fromJson(wire, &parseError);
        QCOMPARE(parseError.error, QJsonParseError::NoError);
        QVERIFY(serialized.isObject());
        QVERIFY(serialized.object().value("value").isNull());
        QVERIFY(serialized.object().value("valid").isBool());
        QVERIFY(!serialized.object().value("valid").toBool());
        QCOMPARE(m_frames.size(), 0);
    }
    void candidateHeaderBusyEmptyAndDisconnectedKeepOriginalVisibility_data() {
        QTest::addColumn<QString>("state");
        QTest::newRow("busy-empty") << QString("busy");
        QTest::newRow("live-empty") << QString("empty");
        QTest::newRow("disconnected-empty") << QString("disconnected");
    }
    void candidateHeaderBusyEmptyAndDisconnectedKeepOriginalVisibility() {
        QFETCH(QString, state);
        QVERIFY(prepareCandidateBatchPanel(591, 626));
        m_bridge->refreshMemories();
        deliverCandidate(candidatePage({}));
        deliverConfirmed();
        if (state == "busy") m_bridge->firstMemoryCandidates();
        if (state == "disconnected") {
            m_bridge->m_connected = false;
            m_bridge->invalidateCandidatePaging(true);
            emit m_bridge->changed();
        }
        trackCandidateFrames();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        const auto frames = m_frames.size();
        const auto proof = CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), 0,
            lastRendererCommand("memory:candidates:list")["request_id"].toString(),
            m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial);
        QVERIFY2(CandidateHeaderProbe::valid(proof, state != "disconnected"), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(proof))));
        QCOMPARE(proof.value("busy").toBool(), state == "busy");
        QCOMPARE(m_frames.size(), frames);
    }
    void candidateHeaderWithFeedbackAndRecoveryStillFits() {
        QVERIFY(prepareCandidateBatchPanel(591, 626));
        m_bridge->m_runtimeWritable = false;
        m_bridge->m_memoryFeedback["action"] = QVariantMap{{"status", "success"}, {"text", "已删除3条记忆。"}};
        m_bridge->m_candidateBatch = QVariantMap{{"status", "unknown"}, {"text", "结果未确认，请手动重新读取。"}};
        emit m_bridge->changed();
        trackCandidateFrames();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        const auto proof = CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), 3,
            lastRendererCommand("memory:candidates:list")["request_id"].toString(),
            m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial);
        QVERIFY2(CandidateHeaderProbe::valid(proof, true), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(proof))));
        for (const auto *name : {"runtimeRecoveryWarning", "memoryActionFeedback", "memoryCandidateBatchFeedback"}) {
            auto *label = batchControl(name);
            QVERIFY2(label && label->isVisible() && feedbackItemFullyVisible(label), name);
        }
        auto *header = batchControl("memoryCandidatePageInfo");
        auto *feedback = batchControl("memoryCandidateBatchFeedback");
        QVERIFY(feedback->mapToScene(QPointF(0, feedback->height())).y() <= header->mapToScene(QPointF()).y());
    }
    void candidateHeaderHiddenSegmentsDoNotReserveLayoutSpace_data() {
        QTest::addColumn<int>("tab"); QTest::addColumn<QString>("page");
        QTest::newRow("summary") << 1 << QString("memory");
        QTest::newRow("profile") << 2 << QString("memory");
        QTest::newRow("backup") << 3 << QString("memory");
        QTest::newRow("recall") << 4 << QString("memory");
        QTest::newRow("settings") << 0 << QString("settings");
    }
    void candidateHeaderHiddenSegmentsDoNotReserveLayoutSpace() {
        QFETCH(int, tab); QFETCH(QString, page);
        QVERIFY(prepareCandidateBatchPanel(760, 650));
        auto *header = batchControl("memoryCandidatePageInfo");
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *tabs = m_panel->findChild<QQuickItem *>("memoryTabs");
        QVERIFY(header && scroll && tabs);
        trackCandidateFrames();
        const auto before = memoryLayoutSnapshot();
        const qreal beforeY = scroll->y(), headerHeight = header->height();
        const auto frames = m_frames.size();
        QVERIFY(tabs->setProperty("currentIndex", tab));
        QVERIFY(m_panel->setProperty("page", page));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!header->isVisible());
        if (page == "memory") {
            QVERIFY2(scroll->y() <= beforeY - headerHeight + .5,
                qPrintable(memoryLayoutDiagnostic(before, "hidden-memory-segment")));
        }
        // Establish this page's baseline before changing only candidate state.
        // Settings has its own title row; comparing it with memory/tab0 would
        // incorrectly attribute the title's height to the candidate header.
        const auto hiddenBaseline = memoryLayoutSnapshot();
        const auto hiddenRect = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
        m_bridge->invalidateCandidatePaging(true);
        emit m_bridge->changed();
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!header->isVisible());
        const auto noCandidatesRect = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
        QVERIFY2(qAbs(noCandidatesRect.x() - hiddenRect.x()) <= .5 &&
            qAbs(noCandidatesRect.y() - hiddenRect.y()) <= .5 &&
            qAbs(noCandidatesRect.width() - hiddenRect.width()) <= .5 &&
            qAbs(noCandidatesRect.height() - hiddenRect.height()) <= .5,
            qPrintable(memoryLayoutDiagnostic(hiddenBaseline, "hidden-page-zero-occupancy")));
        const auto proof = CandidateHeaderProbe::inspect(m_window.get(), m_bridge->memoryCandidatePage(), 0,
            lastRendererCommand("memory:candidates:list")["request_id"].toString(),
            m_bridge->scopeKey(), m_bridge->generation(), m_candidateFrameSerial);
        QVERIFY2(CandidateHeaderProbe::valid(proof, false), qPrintable(compactDiagnostic(QJsonObject::fromVariantMap(proof))));
        QCOMPARE(m_frames.size(), frames);
    }

    void worldbookInsertionNavigationTypeEvidence_data() {
        QTest::addColumn<QString>("kind");
        QTest::addColumn<bool>("input"); QTest::addColumn<bool>("edit");
        QTest::addColumn<bool>("combo"); QTest::addColumn<bool>("spin");
        QTest::newRow("real-glassfield") << QString("glassfield") << true << false << false << false;
        QTest::newRow("qml-derived-textarea") << QString("textarea") << false << true << false << false;
        QTest::newRow("real-combobox") << QString("combobox") << false << false << true << false;
        QTest::newRow("real-spinbox") << QString("spinbox") << false << false << false << true;
        QTest::newRow("nontext-textfield-objectname") << QString("objectname") << false << false << false << false;
        QTest::newRow("nontext-textfield-class-alias") << QString("class-alias") << false << false << false << false;
        QTest::newRow("nontext-qml-textfield-alias") << QString("qml-alias") << false << false << false << false;
        QTest::newRow("missing-item") << QString("missing") << false << false << false << false;
    }
    void worldbookInsertionNavigationTypeEvidence() {
        QFETCH(QString,kind); QFETCH(bool,input); QFETCH(bool,edit); QFETCH(bool,combo); QFETCH(bool,spin);
        QQmlEngine engine;
        QQmlComponent component(&engine);
        const QUrl fixtureUrl("qrc:/persona-card-confirmation/NavigationTypeEvidence.qml");
        const QString resourcePath(":/persona-card-confirmation/ui/GlassField.qml");
        const QByteArray expectedResourceSha256("2715178eef1da71adf20be767ede2eda7857f205699fdb98c2908c3b1f948d95");
        QByteArray resourceBytes;
        bool resourceOpened = false, resourceComplete = false;
        if (kind == "glassfield") {
            QFile resource(resourcePath);
            resourceOpened = resource.open(QIODevice::ReadOnly);
            if (resourceOpened) {
                resourceBytes = resource.read(8193);
                resourceComplete = resource.atEnd() && resource.error() == QFileDevice::NoError;
            }
        }
        const auto resourceSha256 = resourceOpened
            ? QCryptographicHash::hash(resourceBytes,QCryptographicHash::Sha256).toHex() : QByteArray();
        std::unique_ptr<QObject> object;
        if (kind == "class-alias") {
            object = std::make_unique<NavigationTextFieldAlias>();
            object->setObjectName("QQuickTextInput_TextEdit_TextField_TextArea");
        } else if (kind != "missing") {
            QByteArray source;
            if (kind == "glassfield") {
                source = R"QML(import QtQuick
import "qrc:/persona-card-confirmation/ui" as ActualUi
ActualUi.GlassField { objectName: "navigationRealGlassField"; width: 200; height: 46 }
)QML";
            } else if (kind == "textarea") {
                source = R"QML(import QtQuick
import QtQuick.Controls
Item {
    component NavigationArea: TextArea { property bool navigationDerived: true }
    NavigationArea { objectName: "navigationDerivedTextArea"; width: 200; height: 80 }
}
)QML";
            } else if (kind == "qml-alias") {
                source = R"QML(import QtQuick
Item {
    component TextFieldAlias: Item { property bool navigationNonText: true }
    TextFieldAlias { objectName: "navigationTextFieldAlias"; width: 200; height: 46 }
}
)QML";
            } else if (kind == "combobox") {
                source = "import QtQuick.Controls\nComboBox { objectName: \"navigationComboBox\"; model: [\"one\",\"two\"] }";
            } else if (kind == "spinbox") {
                source = "import QtQuick.Controls\nSpinBox { objectName: \"navigationSpinBox\" }";
            } else {
                source = "import QtQuick\nItem { objectName: \"QQuickTextInput_TextEdit_TextField_TextArea\"; width: 200; height: 46 }";
            }
            component.setData(source, fixtureUrl);
            if (!component.isError()) object.reset(component.create());
        }
        auto *item = qobject_cast<QQuickItem *>(object.get());
        if (kind == "textarea") item = object ? object->findChild<QQuickItem *>("navigationDerivedTextArea") : nullptr;
        if (kind == "qml-alias") item = object ? object->findChild<QQuickItem *>("navigationTextFieldAlias") : nullptr;
        const auto descriptor = WorldbookInjectionNavigation::describe(item,nullptr);
        const auto flags = descriptor.value("typeFlags").toMap();
        const auto hasProperty = [item](const char *name) {
            return item && item->metaObject()->indexOfProperty(name) >= 0;
        };
        const bool materialRoleMatches = item && item->property("materialRole").metaType().id() == QMetaType::QString
            && item->property("materialRole").toString() == "reading";
        // Publish bounded real observations before the first load, provenance,
        // or type assertion. A generated QML class name is diagnostic only.
        const QVariantMap observation{{"schema","reverie.qt.injection-type-fixture-observation.v1"},
            {"kind",kind.left(32)},{"found",item != nullptr},
            {"actualClassName",descriptor.value("className")},{"objectName",descriptor.value("objectName")},
            {"typeFlags",flags},{"fixtureUrl",fixtureUrl.toString()},
            {"componentUrl",component.url().toString().left(240)},
            {"componentStatus",int(component.status())},{"componentErrorCount",component.errors().size()},
            {"creationSucceeded",object != nullptr},{"resourcePath",resourcePath},
            {"resourceOpened",resourceOpened},{"resourceComplete",resourceComplete},
            {"resourceBytes",resourceBytes.size()},{"resourceSha256",QString::fromLatin1(resourceSha256)},
            {"expectedResourceSha256",QString::fromLatin1(expectedResourceSha256)},
            {"materialRoleProperty",hasProperty("materialRole")},{"materialRoleMatches",materialRoleMatches},
            {"sceneSourceProperty",hasProperty("sceneSource")},{"sceneRootProperty",hasProperty("sceneRoot")}};
        const auto observationWire = QJsonDocument(QJsonObject::fromVariantMap(observation)).toJson(QJsonDocument::Compact);
        qInfo().noquote().nospace() << "INJECTION_TYPE_FIXTURE " << observationWire;
        QVERIFY(observationWire.size() <= 4096);
        if (kind != "missing" && kind != "class-alias") {
            QVERIFY2(!component.isError(),qPrintable(component.errorString()));
            QVERIFY2(object,qPrintable(component.errorString()));
            QCOMPARE(component.url(),fixtureUrl);
        }
        QVERIFY(kind == "missing" || item);
        if (kind == "glassfield") {
            QVERIFY(resourceOpened && resourceComplete && !resourceBytes.isEmpty() && resourceBytes.size() <= 8192);
            QCOMPARE(resourceSha256,expectedResourceSha256);
            QCOMPARE(item->objectName(),QString("navigationRealGlassField"));
            QVERIFY(hasProperty("materialRole") && materialRoleMatches);
            QVERIFY(hasProperty("sceneSource") && hasProperty("sceneRoot"));
        }
        if (kind == "textarea") QVERIFY(item->property("navigationDerived").toBool());
        if (kind == "class-alias")
            QVERIFY(QString::fromLatin1(item->metaObject()->className()).contains("TextField"));
        if (kind == "objectname" || kind == "class-alias" || kind == "qml-alias")
            QVERIFY(item->objectName().contains("TextField"));
        const QVariantMap expected{{"textInput",input},{"textEdit",edit},{"comboBox",combo},{"spinBox",spin}};
        QCOMPARE(flags,expected);
        QCOMPARE(flags.size(),4);
        int trueFlags = 0;
        for (const auto *key : {"textInput","textEdit","comboBox","spinBox"}) {
            QCOMPARE(flags.value(key).metaType().id(),int(QMetaType::Bool));
            trueFlags += flags.value(key).toBool() ? 1 : 0;
        }
        QVERIFY(trueFlags <= 1);
        QCOMPARE(flags.value("textInput").toBool(),item && item->inherits("QQuickTextInput"));
        QCOMPARE(flags.value("textEdit").toBool(),item && item->inherits("QQuickTextEdit"));
        QCOMPARE(flags.value("comboBox").toBool(),item && item->inherits("QQuickComboBox"));
        QCOMPARE(flags.value("spinBox").toBool(),item && item->inherits("QQuickSpinBox"));
        QCOMPARE(descriptor.value("found").toBool(),item != nullptr);
        const auto content = descriptor.value("contentItem").toMap();
        const auto *contentObject = item ? item->property("contentItem").value<QQuickItem *>() : nullptr;
        QCOMPARE(content,WorldbookInjectionInput::identity(contentObject));
        QVERIFY(!content.contains("typeFlags"));
        const auto wire = QJsonDocument(QJsonObject::fromVariantMap(descriptor)).toJson(QJsonDocument::Compact);
        QJsonParseError parseError;
        const auto serialized = QJsonDocument::fromJson(wire,&parseError).object();
        QCOMPARE(parseError.error,QJsonParseError::NoError);
        const auto serializedFlags = serialized.value("typeFlags").toObject();
        for (const auto *key : {"textInput","textEdit","comboBox","spinBox"}) {
            QVERIFY(serializedFlags.value(key).isBool());
            QCOMPARE(serializedFlags.value(key).toBool(),expected.value(key).toBool());
        }
        if (!item) {
            QCOMPARE(trueFlags,0);
            QVERIFY(!content.value("found").toBool());
        }
        QCOMPARE(m_frames.size(),0);
    }

    void worldbookInsertionHitActualDispatchEvidence_data() {
        QTest::addColumn<QString>("caseId"); QTest::addColumn<QString>("kind");
        QTest::addColumn<QString>("control"); QTest::addColumn<QString>("fault"); QTest::addColumn<int>("step");
        QTest::newRow("hit-button") << QString("hit-button") << QString("button") << QString("worldbookEnabled") << QString("none") << 601;
        QTest::newRow("hit-text") << QString("hit-text") << QString("text") << QString("worldbookName") << QString("none") << 602;
        QTest::newRow("hit-selector") << QString("hit-selector") << QString("selector") << QString("worldbookInsertionPosition") << QString("none") << 603;
        QTest::newRow("hit-depth") << QString("hit-depth") << QString("depth-keyboard") << QString("worldbookInsertionDepth") << QString("none") << 604;
        QTest::newRow("hit-navigation") << QString("hit-navigation") << QString("insertion-tab-backtab") << QString("worldbookInsertionPosition") << QString("none") << 605;
        QTest::newRow("hit-dispatch-coordinate-mismatch") << QString("hit-dispatch-coordinate-mismatch") << QString("button") << QString("worldbookEnabled") << QString("dispatch-coordinate-mismatch") << 606;
        QTest::newRow("hit-legacy-without-envelope") << QString("hit-legacy-without-envelope") << QString("button") << QString("worldbookEnabled") << QString("legacy-input-without-envelope") << 607;
        QTest::newRow("hit-entry-selector") << QString("hit-entry-selector") << QString("selector") << QString("worldbookEntrySelector") << QString("none") << 608;
    }
    void worldbookInsertionHitActualDispatchEvidence() {
        QFETCH(QString,caseId); QFETCH(QString,kind); QFETCH(QString,control); QFETCH(QString,fault); QFETCH(int,step);
        const bool entrySelector = caseId == "hit-entry-selector";
        if (entrySelector) QVERIFY(loadWorldbookHitEntrySelector());
        else QVERIFY(loadArchiveDrawer(insertionFixtureArchive("at_depth",0,"system"),1380,true,true));
        QPointer<QQuickItem> target = m_panel->findChild<QQuickItem *>(control);
        QVERIFY(target); QCOMPARE(worldbookDepthSelectedEntryId(),QString("priority-a"));
        const auto selectedEntryIdBefore = worldbookDepthSelectedEntryId();
        const auto scope = m_bridge->scopeKey(); const int generation = m_bridge->generation();
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        SummaryInteractionProbe::StableGate stable; QVERIFY(prepareWorldbookDepthInput(target,clock,phaseClock,stable));
        const auto callerClock = [this,&clock,&phaseClock,stepAt,step] {
            const auto now = clock.elapsed();
            return QVariantMap{{"step",step},{"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},
                {"nowMs",now},{"elapsedMs",phaseClock.elapsed(now)},{"frame",m_archiveFocusDiagnosticFrame},
                {"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},
                {"selectedEntryId",worldbookDepthSelectedEntryId()}};
        };
        QVariantMap actualHit, actualProbe;
        QPoint readinessPoint;
        int dispatchCount = 0;
        const auto qualifyMouse = [&](const QPoint &point) {
            const auto observation = inspectWorldbookDepthInput(target);
            NativeCheck::require(target && m_panel->findChild<QQuickItem *>(control) == target &&
                stable.matches(observation) && observation.point == point && m_bridge->scopeKey() == scope &&
                m_bridge->generation() == generation && phaseClock.elapsed(clock.elapsed()) >= 0 &&
                phaseClock.elapsed(clock.elapsed()) < 4000,"NATIVE_HIT_TARGET_CHANGED",callerClock());
            const auto hit = NativeCheck::hitTest(m_window.get(),point,target);
            NativeCheck::require(hit.accepted(),"NATIVE_HIT_NOT_ACCEPTED",hit.metadata());
            readinessPoint = observation.point;
            actualProbe = WorldbookInjectionHit::probe(m_window.get(),target,point,hit,callerClock);
        };
        const auto dispatch = [&](const QPoint &point) {
            ++dispatchCount;
            actualHit = WorldbookInjectionHit::mouseClick(m_window.get(),target,kind,readinessPoint,
                actualProbe,point,callerClock);
        };
        QString failure;
        try {
            if (kind == "depth-keyboard") {
                QVariantMap latest; QVariantList qualifications;
                auto context = worldbookDepthInputContext(target,clock,phaseClock,stable,stepAt,step,latest,qualifications);
                const auto originalQualify = context.qualify;
                context.qualify = [&,originalQualify](const QString &phase,bool keyboard) {
                    const auto point = originalQualify(phase,keyboard);
                    if (!keyboard) qualifyMouse(point);
                    return point;
                };
                context.mouseDispatch = dispatch;
                WorldbookInjectionInput::replaceDepth(m_window.get(),target,1,context);
                NativeCheck::require(latest.value("completed").toBool() && latest.value("mouseDispatchCount") == QVariant(1) &&
                    latest.value("keyDispatchCount") == QVariant(3) && m_archive->insertionDepth() == QVariant(1),"NATIVE_HIT_DEPTH_INPUT",callerClock());
            } else if (kind == "insertion-tab-backtab") {
                QVariantMap latest; QVariantList qualifications;
                auto context = worldbookNavigationContext(target,clock,phaseClock,stable,stepAt,step,latest,qualifications);
                const auto originalQualify = context.qualify;
                context.qualify = [&,originalQualify](QQuickItem *candidate,bool keyboard,bool selector) {
                    const auto point = originalQualify(candidate,keyboard,selector);
                    if (!keyboard) qualifyMouse(point);
                    return point;
                };
                context.mouseDispatch = dispatch;
                WorldbookInjectionNavigation::traverse(m_window.get(),target,context);
                NativeCheck::require(latest.value("completed").toBool() && latest.value("mouseDispatchCount") == QVariant(1) &&
                    latest.value("keyDispatchCount") == QVariant(9),"NATIVE_HIT_NAVIGATION_INPUT",callerClock());
            } else {
                const auto observation = inspectWorldbookDepthInput(target);
                qualifyMouse(observation.point);
                if (kind == "button") {
                    const bool before = m_archive->entryEnabled();
                    QSignalSpy clicked(target,SIGNAL(clicked()));
                    NativeCheck::require(clicked.isValid(),"NATIVE_HIT_BUTTON_SIGNAL",callerClock());
                    dispatch(observation.point);
                    NativeCheck::require(clicked.count() == 1 && m_archive->entryEnabled() != before,"NATIVE_HIT_BUTTON_INPUT",callerClock());
                } else if (kind == "text") {
                    const auto beforeText = target->property("text").toString();
                    dispatch(observation.point);
                    NativeCheck::require(ArchiveInputProbe::keyboardFocusMatches(target,m_window.get()),"NATIVE_HIT_TEXT_FOCUS",callerClock());
                    QInputMethodEvent event; event.setCommitString("HIT_EVIDENCE"); QCoreApplication::sendEvent(m_window.get(),&event);
                    NativeCheck::require(target && target->property("text").toString().size() == beforeText.size() + 12 &&
                        target->property("text").toString().contains("HIT_EVIDENCE") &&
                        m_archive->title() == target->property("text").toString(),"NATIVE_HIT_TEXT_INPUT",callerClock());
                } else {
                    NativeCheck::require(kind == "selector","NATIVE_HIT_UNKNOWN_KIND",callerClock());
                    QSignalSpy activated(target,SIGNAL(activated(int)));
                    NativeCheck::require(activated.isValid(),"NATIVE_HIT_SELECTOR_SIGNAL",callerClock());
                    dispatch(observation.point);
                    const auto send = [&](Qt::Key key) {
                        NativeCheck::require(phaseClock.elapsed(clock.elapsed()) < 4000 &&
                            ArchiveInputProbe::keyboardFocusMatches(target,m_window.get(),true),"NATIVE_HIT_SELECTOR_FOCUS",callerClock());
                        QTest::keyClick(m_window.get(),key,Qt::NoModifier,0);
                    };
                    send(Qt::Key_Home);
                    if (entrySelector) { send(Qt::Key_Down); send(Qt::Key_Down); }
                    send(Qt::Key_Return);
                    NativeCheck::require(target && activated.count() == 1 &&
                        target->property("currentIndex") == QVariant(entrySelector ? 2 : 0) &&
                        (entrySelector ? worldbookDepthSelectedEntryId() == "priority-b" :
                            m_archive->insertionPosition() == QVariant("before_char")),"NATIVE_HIT_SELECTOR_INPUT",callerClock());
                }
            }
        } catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        const QVariantMap attempt{{"schema","reverie.qt.worldbook-injection-hit-attempt.v1"},
            {"caseId",caseId.left(80)},{"kind",kind.left(40)},{"failure",failure.left(512)},
            {"dispatchCount",dispatchCount},{"inputHit",actualHit}};
        const auto attemptWire = QJsonDocument(QJsonObject::fromVariantMap(attempt)).toJson(QJsonDocument::Compact);
        qInfo().noquote().nospace() << "INJECTION_HIT_ATTEMPT " << attemptWire;
        QVERIFY(attemptWire.size() <= 32768);
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        QVERIFY(target); QCOMPARE(dispatchCount,1); QVERIFY(phaseClock.elapsed(clock.elapsed()) < 4000);
        QCOMPARE(worldbookDepthSelectedEntryId(),entrySelector ? QString("priority-b") : QString("priority-a"));
        QCOMPARE(actualHit.value("schema"),QVariant("reverie.qt.worldbook-injection-input-hit.v1"));
        const auto events = actualHit.value("dispatch").toMap().value("events").toList();
        QCOMPARE(events.size(),2); QCOMPARE(events[0].toMap().value("type"),QVariant("press"));
        QCOMPARE(events[1].toMap().value("type"),QVariant("release"));
        QCOMPARE(actualProbe.value("accepted"),QVariant(true)); QCOMPARE(actualProbe.value("hit").toMap().size(),9);
        for (const auto &value : events) {
            const auto event = value.toMap();
            QCOMPARE(event.value("x").toDouble(),double(readinessPoint.x()));
            QCOMPARE(event.value("y").toDouble(),double(readinessPoint.y()));
            QCOMPARE(event.value("button"),QVariant(int(Qt::LeftButton)));
        }
        const auto now = clock.elapsed();
        const QVariantMap sourceInput{{"step",step},{"control",control},{"scope",scope},{"generation",generation},
            {"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},{"elapsedMs",phaseClock.elapsed(now)},
            {"frame",m_archiveFocusDiagnosticFrame},{"selectedEntryId",worldbookDepthSelectedEntryId()},
            {"selectedEntryIdBefore",selectedEntryIdBefore},
            {"layout",stable.metadata()},{"hit",actualProbe.value("hit")},
            {"windowWidth",m_window->width()},{"windowHeight",m_window->height()},
            {"signals",QVariantMap{{"kind",kind},{"mouseDispatchCount",dispatchCount}}},{"inputHit",actualHit}};
        // sourceInput always contains this case's fresh real dispatch. Only the
        // separately named candidate is mutated; a failed/missing measurement
        // never becomes a passing negative record.
        QVariantMap candidate = sourceInput;
        if (fault == "dispatch-coordinate-mismatch") {
            auto envelope = candidate.value("inputHit").toMap();
            auto sent = envelope.value("dispatch").toMap(); auto point = sent.value("point").toMap();
            point["x"] = point.value("x").toInt() + 1;
            sent["point"] = point; envelope["dispatch"] = sent; candidate["inputHit"] = envelope;
            QVERIFY(candidate != sourceInput);
        } else if (fault == "legacy-input-without-envelope") {
            QCOMPARE(candidate.remove("inputHit"),1); QVERIFY(candidate != sourceInput);
        } else { QCOMPARE(fault,QString("none")); QCOMPARE(candidate,sourceInput); }
        const QVariantMap record{{"schema","reverie.qt.worldbook-injection-hit-native-evidence.v1"},
            {"caseId",caseId},{"sourceInput",sourceInput},{"input",candidate}};
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(record)).toJson(QJsonDocument::Compact);
        qInfo().noquote() << "WORLDBOOK_INPUT_HIT" << QString::fromUtf8(bytes);
        QVERIFY(bytes.size() <= 131072); QVERIFY(writeWorldbookHitEvidence(caseId,bytes));
        if (m_worldbookHitEvidenceFiles.size() == 8) QVERIFY(writeWorldbookHitManifest());
        QCOMPARE(rendererCommandCount("archive:put"),0); QCOMPARE(rendererCommandCount("chat:send"),0);
        QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }

    void worldbookInsertionNavigationAfterRealEditing_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("policy"); QTest::addColumn<int>("step");
        QTest::addColumn<int>("expectedValue"); QTest::addColumn<QString>("role");
        QTest::addColumn<QString>("boundaryMode"); QTest::addColumn<bool>("regex");
        QTest::newRow("wide-policy-3") << 1380 << 3 << 213 << 1 << QString("system") << QString("inherited") << false;
        QTest::newRow("wide-policy-255") << 1380 << 255 << 244 << 2 << QString("assistant") << QString("inherited") << false;
        QTest::newRow("compact-policy-3") << 950 << 3 << 244 << 2 << QString("assistant") << QString("custom-budget") << false;
        QTest::newRow("compact-policy-255") << 950 << 255 << 213 << 1 << QString("system") << QString("custom-budget") << false;
        QTest::newRow("narrow-policy-3") << 760 << 3 << 213 << 1 << QString("system") << QString("inherited") << true;
        QTest::newRow("narrow-policy-255") << 760 << 255 << 244 << 2 << QString("assistant") << QString("inherited") << true;
    }
    void worldbookInsertionNavigationAfterRealEditing() {
        QFETCH(int,width); QFETCH(int,policy); QFETCH(int,step); QFETCH(int,expectedValue);
        QFETCH(QString,role); QFETCH(QString,boundaryMode); QFETCH(bool,regex);
        auto *hints = QGuiApplication::styleHints();
        const auto originalPolicy = hints->tabFocusBehavior();
        const auto restorePolicy = qScopeGuard([hints,originalPolicy] { hints->setTabFocusBehavior(originalPolicy); });
        hints->setTabFocusBehavior(static_cast<Qt::TabFocusBehavior>(policy));
        const QString initialRole = role == "system" ? "assistant" : "system";
        auto fixture = insertionFixtureArchive("before_char",0,initialRole);
        auto books = fixture["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        if (boundaryMode == "custom-budget") entry["tokenBudget"] = 100;
        entry["useRegex"] = regex;
        entries[0] = entry; book["entries"] = entries; books[0] = book; fixture["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(fixture,width,true,true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *roleControl = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        QVERIFY(position && depth && roleControl); QVERIFY(!depth->isEnabled() && !roleControl->isEnabled());
        const QString caseId = "navigation-" + QString::fromLatin1(QTest::currentDataTag());
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        QVariantList setup;
        QVERIFY(selectWorldbookNavigationControl(position,2,clock,phaseClock,setup,"position"));
        QCOMPARE(m_archive->insertionPosition(),QVariant("at_depth"));
        QVERIFY(depth->isEnabled() && roleControl->isEnabled());
        SummaryInteractionProbe::StableGate depthStable;
        QVERIFY(prepareWorldbookDepthInput(depth,clock,phaseClock,depthStable));
        const int depthStep = step == 213 ? 212 : 242;
        QVariantMap depthBoundary{{"schema","reverie.qt.worldbook-injection-depth-native-boundary.v1"},
            {"source","native"},{"caseId",caseId},{"control","worldbookInsertionDepth"},
            {"windowWidth",m_window->width()},{"windowHeight",m_window->height()},
            {"beforeValue",depth->property("value")},{"expectedValue",expectedValue},
            {"selectedEntryId",worldbookDepthSelectedEntryId()},{"scope",m_bridge->scopeKey()},
            {"generation",m_bridge->generation()},{"step",depthStep},{"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},
            {"preparedAtMs",clock.elapsed()},{"prepareFrame",m_archiveFocusDiagnosticFrame},
            {"wholeVisibility",NativeControlReadiness::wholeVisibility(depth,m_window.get())},{"layout",depthStable.metadata()}};
        QVariantMap depthInput; QVariantList depthQualifications;
        const auto depthContext = worldbookDepthInputContext(depth,clock,phaseClock,depthStable,stepAt,depthStep,depthInput,depthQualifications);
        QString failure;
        try { WorldbookInjectionInput::replaceDepth(m_window.get(),depth,expectedValue,depthContext); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        depthBoundary.insert({{"afterAtMs",clock.elapsed()},{"afterFrame",m_archiveFocusDiagnosticFrame},{"qualifications",depthQualifications}});
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        setup.append(QVariantMap{{"stage","depth"},{"beforeGroup",setup.last().toMap().value("afterGroup")},
            {"afterGroup",worldbookNavigationValues()},{"mouseDispatchCount",depthInput.value("mouseDispatchCount")},
            {"keyDispatchCount",depthInput.value("keyDispatchCount")},{"valueModifiedSignals",depthInput.value("valueModifiedSignals")},
            {"nowMs",clock.elapsed()},{"frame",m_archiveFocusDiagnosticFrame},{"target",WorldbookInjectionInput::identity(depth)}});
        QVERIFY(selectWorldbookNavigationControl(roleControl,role == "system" ? 0 : 2,clock,phaseClock,setup,"role"));
        QCOMPARE(m_archive->insertionRole(),QVariant(role));
        QCOMPARE(m_panel->findChild<QQuickItem *>("worldbookInsertionProviderWarning")->isVisible(),role == "system");
        const auto beforeGroup = worldbookNavigationValues();
        const QVariantMap requestCountsBefore{{"archivePut",rendererCommandCount("archive:put")},{"chatSend",rendererCommandCount("chat:send")}};
        const bool backendRunningBefore = m_bridge->m_process.state() != QProcess::NotRunning;
        SummaryInteractionProbe::StableGate navigationStable;
        QVERIFY(prepareWorldbookDepthInput(position,clock,phaseClock,navigationStable));
        QVariantMap boundary{{"schema","reverie.qt.worldbook-injection-navigation-native-boundary.v1"},
            {"source","native"},{"caseId",caseId},{"control","worldbookInsertionPosition"},
            {"windowWidth",m_window->width()},{"windowHeight",m_window->height()},
            {"beforeGroup",beforeGroup},{"expectedValue",expectedValue},{"selectedEntryId",worldbookDepthSelectedEntryId()},
            {"scope",m_bridge->scopeKey()},{"generation",m_bridge->generation()},{"step",step},
            {"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},{"preparedAtMs",clock.elapsed()},
            {"prepareFrame",m_archiveFocusDiagnosticFrame},{"tabFocusBehavior",policy},{"setup",setup},
            {"contextBefore",worldbookNavigationPageContext()},
            {"wholeVisibility",NativeControlReadiness::wholeVisibility(position,m_window.get())},{"layout",navigationStable.metadata()}};
        QVariantMap latest; QVariantList qualifications;
        const auto context = worldbookNavigationContext(position,clock,phaseClock,navigationStable,stepAt,step,latest,qualifications);
        try { WorldbookInjectionNavigation::traverse(m_window.get(),position,context); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        boundary.insert({{"afterAtMs",clock.elapsed()},{"afterFrame",m_archiveFocusDiagnosticFrame},{"qualifications",qualifications},
            {"contextAfter",worldbookNavigationPageContext()},
            {"requestCountsBefore",requestCountsBefore},
            {"requestCountsAfter",QVariantMap{{"archivePut",rendererCommandCount("archive:put")},{"chatSend",rendererCommandCount("chat:send")}}},
            {"backendRunningBefore",backendRunningBefore},{"backendRunningAfter",m_bridge->m_process.state() != QProcess::NotRunning}});
        const QVariantMap record{{"schema","reverie.qt.worldbook-injection-navigation-native-evidence.v2"},
            {"caseId",caseId},{"navigation",latest},{"depthInput",depthInput},{"boundary",boundary},{"depthBoundary",depthBoundary}};
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(record)).toJson(QJsonDocument::Compact);
        qInfo().noquote() << "WORLDBOOK_INSERTION_NAVIGATION" << QString::fromUtf8(bytes);
        QVERIFY(bytes.size() <= 131072); QVERIFY(writeWorldbookNavigationEvidence(caseId,bytes));
        if (m_worldbookNavigationEvidenceFiles.size() == 6) QVERIFY(writeWorldbookNavigationManifest());
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        QVERIFY(clock.elapsed() < 4000); QCOMPARE(qualifications.size(),10);
        QCOMPARE(latest.value("snapshots").toList().size(),20); QCOMPARE(latest.value("completed"),QVariant(true));
        QCOMPARE(latest.value("keyDispatchCount"),QVariant(9)); QCOMPARE(latest.value("mouseDispatchCount"),QVariant(1));
        QCOMPARE(boundary.value("contextBefore"),boundary.value("contextAfter"));
        QCOMPARE(worldbookNavigationValues(),beforeGroup); QCOMPARE(rendererCommandCount("archive:put"),0);
        QCOMPARE(rendererCommandCount("chat:send"),0); QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
        QJsonParseError parseError; const auto parsed = QJsonDocument::fromJson(bytes,&parseError);
        QCOMPARE(parseError.error,QJsonParseError::NoError); QVERIFY(parsed.isObject());
        QCOMPARE(parsed.object()["navigation"].toObject()["snapshots"].toArray().size(),20);
    }
    void worldbookInsertionNavigationBoundariesChangeWithoutOldReciprocals_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("policy");
        QTest::newRow("wide-policy-3") << 1380 << 3;
        QTest::newRow("wide-policy-255") << 1380 << 255;
        QTest::newRow("compact-policy-3") << 950 << 3;
        QTest::newRow("compact-policy-255") << 950 << 255;
        QTest::newRow("narrow-policy-3") << 760 << 3;
        QTest::newRow("narrow-policy-255") << 760 << 255;
    }
    void worldbookInsertionNavigationBoundariesChangeWithoutOldReciprocals() {
        QFETCH(int,width); QFETCH(int,policy);
        auto *hints = QGuiApplication::styleHints(); const auto originalPolicy = hints->tabFocusBehavior();
        const auto restorePolicy = qScopeGuard([hints,originalPolicy] { hints->setTabFocusBehavior(originalPolicy); });
        hints->setTabFocusBehavior(static_cast<Qt::TabFocusBehavior>(policy));
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive("at_depth",0,"system"),width,true,true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *budgetCheck = m_panel->findChild<QQuickItem *>("worldbookEntryTokenBudgetInherit");
        auto *budget = m_panel->findChild<QQuickItem *>("worldbookEntryTokenBudget");
        auto *regexCheck = m_panel->findChild<QQuickItem *>("worldbookUseRegex");
        QVERIFY(position && budgetCheck && budget && regexCheck);
        QVERIFY(budgetCheck->property("checked").toBool()); QVERIFY(!budget->isVisible());
        QPointer<QQuickItem> oldBefore = m_panel->property("insertionBeforeItem").value<QQuickItem *>();
        QPointer<QQuickItem> oldAfter = m_panel->property("insertionAfterItem").value<QQuickItem *>();
        QVERIFY(oldBefore && oldAfter); QCOMPARE(oldAfter->objectName(),QString("worldbookSecondaryKeywords"));
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        const auto values = worldbookNavigationValues();
        SummaryInteractionProbe::StableGate firstStable; QVERIFY(prepareWorldbookDepthInput(position,clock,phaseClock,firstStable));
        QVariantMap first; QVariantList firstQualifications;
        const auto firstContext = worldbookNavigationContext(position,clock,phaseClock,firstStable,stepAt,213,first,firstQualifications);
        QString failure;
        try { WorldbookInjectionNavigation::traverse(m_window.get(),position,firstContext); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        SummaryInteractionProbe::StableGate checkboxStable;
        QVERIFY(prepareWorldbookDepthInput(budgetCheck,clock,phaseClock,checkboxStable));
        const auto budgetObservation = inspectWorldbookDepthInput(budgetCheck);
        QVERIFY(NativeCheck::hitTest(m_window.get(),budgetObservation.point,budgetCheck).accepted());
        QTest::mouseClick(m_window.get(),Qt::LeftButton,Qt::NoModifier,budgetObservation.point,0);
        QVERIFY(!budgetCheck->property("checked").toBool()); QVERIFY(budget->isVisible());
        QCOMPARE(m_panel->property("insertionBeforeItem").value<QQuickItem *>(),WorldbookInjectionInput::editableTextInput(budget));
        QVERIFY(oldBefore != m_panel->property("insertionBeforeItem").value<QQuickItem *>());
        const auto oldBeforeNavigation = NativeCheck::readAttached(oldBefore,"KeyNavigation.tab");
        QVERIFY(oldBeforeNavigation.propertyValid && oldBeforeNavigation.valueValid);
        QVERIFY(oldBeforeNavigation.value.value<QQuickItem *>() == nullptr);
        SummaryInteractionProbe::StableGate regexStable;
        QVERIFY(prepareWorldbookDepthInput(regexCheck,clock,phaseClock,regexStable));
        const auto regexObservation = inspectWorldbookDepthInput(regexCheck);
        QVERIFY(NativeCheck::hitTest(m_window.get(),regexObservation.point,regexCheck).accepted());
        QTest::mouseClick(m_window.get(),Qt::LeftButton,Qt::NoModifier,regexObservation.point,0);
        QVERIFY(m_archive->useRegex());
        auto *newAfter = m_panel->property("insertionAfterItem").value<QQuickItem *>();
        QVERIFY(newAfter); QCOMPARE(newAfter->objectName(),QString("worldbookRegexSecondaryKeywords"));
        const auto oldAfterNavigation = NativeCheck::readAttached(oldAfter,"KeyNavigation.backtab");
        QVERIFY(oldAfterNavigation.propertyValid && oldAfterNavigation.valueValid);
        QVERIFY(oldAfterNavigation.value.value<QQuickItem *>() == nullptr);
        SummaryInteractionProbe::StableGate secondStable; QVERIFY(prepareWorldbookDepthInput(position,clock,phaseClock,secondStable));
        QVariantMap second; QVariantList secondQualifications;
        const auto secondContext = worldbookNavigationContext(position,clock,phaseClock,secondStable,stepAt,244,second,secondQualifications);
        try { WorldbookInjectionNavigation::traverse(m_window.get(),position,secondContext); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        QCOMPARE(first.value("completed"),QVariant(true)); QCOMPARE(second.value("completed"),QVariant(true));
        QCOMPARE(worldbookNavigationValues(),values); QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(rendererCommandCount("archive:put"),0); QCOMPARE(rendererCommandCount("chat:send"),0);
        QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }
    void worldbookInsertionNavigationSkipsUnavailableControlsWithoutTrap_data() {
        QTest::addColumn<int>("policy"); QTest::addColumn<QString>("mode");
        QTest::newRow("policy-3-hidden-depth") << 3 << QString("hidden-depth");
        QTest::newRow("policy-255-hidden-depth") << 255 << QString("hidden-depth");
        QTest::newRow("policy-3-disabled-role") << 3 << QString("disabled-role");
        QTest::newRow("policy-255-disabled-role") << 255 << QString("disabled-role");
        QTest::newRow("policy-3-inactive-fields") << 3 << QString("inactive-fields");
        QTest::newRow("policy-255-inactive-fields") << 255 << QString("inactive-fields");
    }
    void worldbookInsertionNavigationSkipsUnavailableControlsWithoutTrap() {
        QFETCH(int,policy); QFETCH(QString,mode);
        auto *hints = QGuiApplication::styleHints(); const auto originalPolicy = hints->tabFocusBehavior();
        const auto restorePolicy = qScopeGuard([hints,originalPolicy] { hints->setTabFocusBehavior(originalPolicy); });
        hints->setTabFocusBehavior(static_cast<Qt::TabFocusBehavior>(policy));
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive(mode == "inactive-fields" ? "before_char" : "at_depth",
            mode == "hidden-depth" ? 201 : 0,"system"),760,true,true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *role = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        QVERIFY(position && depth && role);
        // Fault injection changes only the enabled state, never focus or data.
        if (mode == "disabled-role") role->setEnabled(false);
        if (mode == "hidden-depth") QVERIFY(!depth->isVisible());
        if (mode == "inactive-fields") QVERIFY(!depth->isEnabled() && !role->isEnabled());
        QVERIFY(!m_panel->property("insertionNavigationEnabled").toBool());
        const auto before = worldbookNavigationValues();
        QElapsedTimer clock; clock.start(); ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(clock.elapsed());
        SummaryInteractionProbe::StableGate stable; QVERIFY(prepareWorldbookDepthInput(position,clock,phaseClock,stable));
        const auto observation = inspectWorldbookDepthInput(position);
        QVERIFY(NativeCheck::hitTest(m_window.get(),observation.point,position).accepted());
        QTest::mouseClick(m_window.get(),Qt::LeftButton,Qt::NoModifier,observation.point,0);
        QVERIFY(ArchiveInputProbe::keyboardFocusMatches(position,m_window.get(),true));
        QTest::keyClick(m_window.get(),Qt::Key_Escape,Qt::NoModifier,0);
        QPointer<QQuickItem> last = m_window->activeFocusItem();
        QVERIFY(last);
        const QList<Qt::KeyboardModifiers> directions{Qt::NoModifier,Qt::NoModifier,Qt::ShiftModifier,Qt::ShiftModifier};
        for (const auto direction : directions) {
            QTest::keyClick(m_window.get(),direction == Qt::ShiftModifier ? Qt::Key_Backtab : Qt::Key_Tab,direction,0);
            auto *focus = m_window->activeFocusItem();
            QVERIFY(focus && focus != last && focus->isVisible() && focus->isEnabled());
            if (!depth->isVisible() || !depth->isEnabled()) QVERIFY(focus != depth && !depth->isAncestorOf(focus));
            if (!role->isEnabled()) QVERIFY(focus != role && !role->isAncestorOf(focus));
            last = focus;
        }
        QCOMPARE(worldbookNavigationValues(),before); QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(rendererCommandCount("archive:put"),0); QCOMPARE(rendererCommandCount("chat:send"),0);
        QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }
    void worldbookInsertionNavigationReadonlyNeighborsFollowQtPolicy_data() {
        QTest::addColumn<int>("policy"); QTest::addColumn<bool>("regex");
        QTest::newRow("policy-3-literal-readonly-neighbor") << 3 << false;
        QTest::newRow("policy-255-literal-readonly-neighbor") << 255 << false;
        QTest::newRow("policy-3-regex-readonly-neighbor") << 3 << true;
        QTest::newRow("policy-255-regex-readonly-neighbor") << 255 << true;
    }
    void worldbookInsertionNavigationReadonlyNeighborsFollowQtPolicy() {
        QFETCH(int,policy); QFETCH(bool,regex);
        auto *hints = QGuiApplication::styleHints(); const auto originalPolicy = hints->tabFocusBehavior();
        const auto restorePolicy = qScopeGuard([hints,originalPolicy] { hints->setTabFocusBehavior(originalPolicy); });
        hints->setTabFocusBehavior(static_cast<Qt::TabFocusBehavior>(policy));
        auto fixture = insertionFixtureArchive("at_depth",1,"system");
        auto books = fixture["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        // These are legal imported values which the compact text editor
        // cannot round-trip. Insertion placement remains independently editable.
        entry["secondaryKeywords"] = QJsonArray{regex ? QString(16385,QChar('x')) : QString("literal,comma")};
        entry["useRegex"] = regex;
        entries[0] = entry; book["entries"] = entries; books[0] = book; fixture["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(fixture,760,true,true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *role = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        auto *readonlyNeighbor = m_panel->findChild<QQuickItem *>(regex ? "worldbookRegexSecondaryKeywords" : "worldbookSecondaryKeywords");
        QVERIFY(position && depth && role && readonlyNeighbor);
        QVERIFY(position->isEnabled() && depth->isEnabled() && role->isEnabled());
        QVERIFY(readonlyNeighbor->isVisible() && readonlyNeighbor->isEnabled() && readonlyNeighbor->property("readOnly").toBool());
        QVERIFY(!m_archive->secondaryKeywordsEditable()); QVERIFY(m_panel->property("insertionNavigationEnabled").toBool());
        QPointer<QQuickItem> expectedAfter = role->nextItemInFocusChain(true);
        QVERIFY(expectedAfter && expectedAfter->isVisible() && expectedAfter->isEnabled());
        QCOMPARE(m_panel->property("insertionAfterItem").value<QQuickItem *>(),expectedAfter.data());
        if (policy == 255) QCOMPARE(expectedAfter.data(),readonlyNeighbor);
        else QVERIFY(expectedAfter != readonlyNeighbor);
        const auto before = worldbookNavigationValues(); const auto originalKeywords = m_archive->secondaryKeywordItems();
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        SummaryInteractionProbe::StableGate stable; QVERIFY(prepareWorldbookDepthInput(position,clock,phaseClock,stable));
        QVariantMap latest; QVariantList qualifications;
        const auto context = worldbookNavigationContext(position,clock,phaseClock,stable,stepAt,policy == 3 ? 213 : 244,latest,qualifications);
        QString failure;
        try { WorldbookInjectionNavigation::traverse(m_window.get(),position,context); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        const auto samples = latest.value("snapshots").toList(); QCOMPARE(samples.size(),20);
        QCOMPARE(samples[9].toMap().value("focus").toMap().value("token"),WorldbookInjectionInput::identity(expectedAfter).value("token"));
        QCOMPARE(samples[9].toMap().value("owner").toMap().value("token"),
            WorldbookInjectionInput::identity(WorldbookInjectionNavigation::owner(expectedAfter)).value("token"));
        QCOMPARE(samples[11].toMap().value("owner").toMap().value("token"),WorldbookInjectionInput::identity(role).value("token"));
        QCOMPARE(worldbookNavigationValues(),before); QCOMPARE(m_archive->secondaryKeywordItems(),originalKeywords);
        QVERIFY(clock.elapsed() < 4000); QCOMPARE(rendererCommandCount("archive:put"),0);
        QCOMPARE(rendererCommandCount("chat:send"),0); QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }
    void worldbookInsertionDepthKeyboardReplacement_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("beforeValue");
        QTest::addColumn<int>("expectedValue"); QTest::addColumn<int>("step");
        QTest::newRow("wide-0-to-1") << 1380 << 0 << 1 << 212;
        QTest::newRow("wide-1-to-0") << 1380 << 1 << 0 << 231;
        QTest::newRow("wide-0-to-2") << 1380 << 0 << 2 << 242;
        QTest::newRow("compact-0-to-1") << 950 << 0 << 1 << 212;
        QTest::newRow("compact-1-to-0") << 950 << 1 << 0 << 231;
        QTest::newRow("compact-0-to-2") << 950 << 0 << 2 << 242;
        QTest::newRow("narrow-0-to-1") << 760 << 0 << 1 << 212;
        QTest::newRow("narrow-1-to-0") << 760 << 1 << 0 << 231;
        QTest::newRow("narrow-0-to-2") << 760 << 0 << 2 << 242;
    }
    void worldbookInsertionDepthKeyboardReplacement() {
        QFETCH(int,width); QFETCH(int,beforeValue); QFETCH(int,expectedValue); QFETCH(int,step);
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive("at_depth",beforeValue,"system"),width,true,true));
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        QVERIFY(depth && WorldbookInjectionInput::editableTextInput(depth));
        QSignalSpy independentModified(depth,SIGNAL(valueModified())); QVERIFY(independentModified.isValid());
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        SummaryInteractionProbe::StableGate stable;
        QVERIFY(prepareWorldbookDepthInput(depth,clock,phaseClock,stable));
        const QString caseId = QString("depth-%1-to-%2").arg(beforeValue).arg(expectedValue);
        QVariantMap boundary{{"schema","reverie.qt.worldbook-injection-depth-native-boundary.v1"},
            {"source","native"},{"caseId",caseId},{"control","worldbookInsertionDepth"},
            {"windowWidth",m_window->width()},{"windowHeight",m_window->height()},
            {"beforeValue",depth->property("value")},{"expectedValue",expectedValue},
            {"selectedEntryId",worldbookDepthSelectedEntryId()},{"scope",m_bridge->scopeKey()},
            {"generation",m_bridge->generation()},{"step",step},{"stepAtMs",stepAt},{"inputAtMs",phaseClock.inputAt()},
            {"preparedAtMs",clock.elapsed()},{"prepareFrame",m_archiveFocusDiagnosticFrame},
            {"wholeVisibility",NativeControlReadiness::wholeVisibility(depth,m_window.get())},{"layout",stable.metadata()}};
        QVariantMap latest; QVariantList qualifications;
        const auto context = worldbookDepthInputContext(depth,clock,phaseClock,stable,stepAt,step,latest,qualifications);
        QString failure;
        try { WorldbookInjectionInput::replaceDepth(m_window.get(),depth,expectedValue,context); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        boundary.insert({{"afterAtMs",clock.elapsed()},{"afterFrame",m_archiveFocusDiagnosticFrame},
            {"qualifications",qualifications}});
        const QVariantMap record{{"schema","reverie.qt.worldbook-injection-depth-native-evidence.v1"},
            {"caseId",caseId},{"depthInput",latest},{"boundary",boundary}};
        // Preserve the real helper's QVariantMap -> original Qt JSON bytes ->
        // parsed JSON boundary before deciding whether the attempt passed.
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(record)).toJson(QJsonDocument::Compact);
        qInfo().noquote() << "WORLDBOOK_DEPTH_INPUT" << QString::fromUtf8(bytes);
        QVERIFY2(failure.isEmpty(),qPrintable(failure));
        QVERIFY(clock.elapsed() < 4000); QCOMPARE(boundary.value("beforeValue"),QVariant(beforeValue));
        QCOMPARE(depth->property("value"),QVariant(expectedValue)); QCOMPARE(m_archive->insertionDepth(),QVariant(expectedValue));
        QCOMPARE(independentModified.count(),1); QVERIFY(m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"),0);
        QCOMPARE(latest.value("mouseDispatchCount"),QVariant(1)); QCOMPARE(latest.value("keyDispatchCount"),QVariant(3));
        QCOMPARE(qualifications.size(),4); QCOMPARE(latest.value("snapshots").toList().size(),8);
        QJsonParseError parseError;
        const auto parsed = QJsonDocument::fromJson(bytes,&parseError);
        QCOMPARE(parseError.error,QJsonParseError::NoError); QVERIFY(parsed.isObject());
        const auto serialized = parsed.object()["depthInput"].toObject();
        QVERIFY(serialized["completed"].isBool()); QVERIFY(serialized["completed"].toBool());
        QVERIFY(serialized["valueModifiedSignals"].isDouble()); QCOMPARE(serialized["valueModifiedSignals"].toInt(),1);
        const auto serializedSamples = serialized["snapshots"].toArray(); QCOMPARE(serializedSamples.size(),8);
        for (const auto &value : serializedSamples) {
            const auto sample = value.toObject();
            QVERIFY(sample["textLength"].isDouble()); QCOMPARE(sample["textLength"].toInt(),1);
            QVERIFY(sample["fullSelection"].isBool()); QVERIFY(sample["controlValue"].isDouble());
            QVERIFY(sample["editorValue"].isDouble()); QVERIFY(sample["valueModifiedSignals"].isDouble());
        }
        const auto selected = serializedSamples[3].toObject();
        QVERIFY(selected["fullSelection"].toBool()); QCOMPARE(selected["selectionStart"].toInt(),0);
        QCOMPARE(selected["selectionEnd"].toInt(),1); QCOMPARE(selected["selectedTextLength"].toInt(),1);
        const auto terminal = serializedSamples.last().toObject();
        QCOMPARE(terminal["controlValue"].toInt(),expectedValue); QCOMPARE(terminal["editorValue"].toInt(),expectedValue);
        QVERIFY(bytes.size() <= 131072);
        if (width == 1380) {
            QVERIFY(writeWorldbookDepthEvidence(caseId,bytes));
            if (m_worldbookDepthEvidenceFiles.size() == 3) QVERIFY(writeWorldbookDepthManifest());
        }
        QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }
    void worldbookInsertionDepthMissingSelectionIsRejected() {
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive("at_depth",0,"system"),1380,true,true));
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth"); QVERIFY(depth);
        QSignalSpy independentModified(depth,SIGNAL(valueModified())); QVERIFY(independentModified.isValid());
        QElapsedTimer clock; clock.start(); const auto stepAt = clock.elapsed();
        ArchiveInputProbe::PhaseClock phaseClock; phaseClock.enter(stepAt);
        SummaryInteractionProbe::StableGate stable; QVERIFY(prepareWorldbookDepthInput(depth,clock,phaseClock,stable));
        QVariantMap latest; QVariantList qualifications;
        const auto context = worldbookDepthInputContext(depth,clock,phaseClock,stable,stepAt,212,latest,qualifications);
        WorldbookDepthSelectAllBlocker blocker(m_window.get());
        QString failure;
        try { WorldbookInjectionInput::replaceDepth(m_window.get(),depth,1,context); }
        catch (const std::exception &error) { failure = QString::fromUtf8(error.what()); }
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(latest)).toJson(QJsonDocument::Compact);
        qInfo().noquote() << "WORLDBOOK_DEPTH_SELECTION_FAULT" << QString::fromUtf8(bytes);
        QVERIFY2(failure.startsWith("INJECTION_DEPTH_SELECTION "),qPrintable(failure));
        QCOMPARE(blocker.blockedPresses(),1); QCOMPARE(independentModified.count(),0);
        QCOMPARE(depth->property("value"),QVariant(0)); QCOMPARE(m_archive->insertionDepth(),QVariant(0));
        QVERIFY(!m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"),0);
        QCOMPARE(latest.value("completed"),QVariant(false)); QCOMPARE(latest.value("mouseDispatchCount"),QVariant(1));
        QCOMPARE(latest.value("keyDispatchCount"),QVariant(1)); QCOMPARE(latest.value("keyActions").toStringList(),QStringList{"SelectAll"});
        QCOMPARE(qualifications.size(),2); const auto samples = latest.value("snapshots").toList(); QCOMPARE(samples.size(),4);
        const auto rejected = samples.last().toMap(); QCOMPARE(rejected.value("phase"),QVariant("after-select-all"));
        QVERIFY(rejected.value("propertiesValid").toBool()); QVERIFY(rejected.value("selectionBoundsValid").toBool());
        QVERIFY(!WorldbookInjectionInput::fullSelection(rejected)); QCOMPARE(rejected.value("valueModifiedSignals"),QVariant(0));
        QVERIFY(clock.elapsed() < 4000); QCOMPARE(m_bridge->m_process.state(),QProcess::NotRunning);
    }
    void worldbookInsertionRealControlsAndWarnings_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<QString>("role");
        for (const int width : {1380, 950, 760})
            for (const auto *role : {"system", "user", "assistant"})
                QTest::newRow((QByteArray::number(width) + "-" + role).constData()) << width << QString(role);
    }
    void worldbookInsertionRealControlsAndWarnings() {
        QFETCH(int, width); QFETCH(QString, role);
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive("at_depth", 2, role), width, true, true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *roleControl = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        QVERIFY(position && depth && roleControl && position->isEnabled() && depth->isEnabled() && roleControl->isEnabled());
        QCOMPARE(depth->property("from").toInt(), 0); QCOMPARE(depth->property("to").toInt(), 200);
        auto *provider = m_panel->findChild<QQuickItem *>("worldbookInsertionProviderWarning");
        auto *downgrade = m_panel->findChild<QQuickItem *>("worldbookInsertionDowngradeWarning");
        auto *effective = m_panel->findChild<QQuickItem *>("worldbookInsertionEffective");
        auto *explanation = m_panel->findChild<QQuickItem *>("worldbookInsertionExplanation");
        QVERIFY(provider && downgrade && effective && explanation);
        QCOMPARE(provider->isVisible(), role == "system"); QVERIFY(downgrade->isVisible());
        QVERIFY(effective->property("text").toString().contains("深度 2"));
        if (role == "user") QVERIFY(explanation->property("text").toString().contains("以你的身份"));
        if (role == "assistant") QVERIFY(explanation->property("text").toString().contains("角色自己说过"));
        QVERIFY(revealPriorityControl(depth)); depth->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up); QTRY_COMPARE(m_archive->insertionDepth().toInt(), 3);
        QVERIFY(m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        auto *save = m_panel->findChild<QQuickItem *>("saveWorldbook"); QVERIFY(save && revealPriorityControl(save));
        clickCenter(save); QTRY_COMPARE(rendererCommandCount("archive:put"), 1);
        const auto command = lastRendererCommand("archive:put"); const auto sent = command["payload"].toObject()["archive"].toObject();
        const auto entry = sent["worldBooks"].toArray()[0].toObject()["entries"].toArray()[0].toObject();
        QCOMPARE(entry["position"].toString(), QString("at_depth")); QCOMPARE(entry["depth"].toInt(), 3); QCOMPARE(entry["role"].toString(), role);
        QCOMPARE(entry["priority"].toInt(), 0); QCOMPARE(entry["insertionOrder"].toInt(), 10);
        priorityFixtureResponse(command["request_id"].toString(), normalizedEntrySettingsReceipt(sent), 5);
        QTRY_COMPARE(m_archive->status(), QString("saved")); QVERIFY(!m_archive->dirty());
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void worldbookInsertionPositionKeyboardControlsInactiveFields_data() {
        QTest::addColumn<int>("width");
        QTest::newRow("wide-position-selector") << 1380;
        QTest::newRow("compact-position-selector") << 950;
        QTest::newRow("narrow-position-selector") << 760;
    }
    void worldbookInsertionPositionKeyboardControlsInactiveFields() {
        QFETCH(int, width); QVERIFY(loadArchiveDrawer(insertionFixtureArchive("before_char", 7, "assistant"), width, true, true));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *role = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        QVERIFY(position && depth && role); QVERIFY(!depth->isEnabled() && !role->isEnabled());
        QVERIFY(revealPriorityControl(position)); position->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Down); QTest::keyClick(m_window.get(), Qt::Key_Down);
        QTRY_COMPARE(m_archive->insertionPosition().toString(), QString("at_depth"));
        QVERIFY(depth->isEnabled() && role->isEnabled()); QCOMPARE(m_archive->insertionDepth().toInt(), 7);
        QVERIFY(revealPriorityControl(role)); role->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Home);
        QTRY_COMPARE(m_archive->insertionRole().toString(), QString("system"));
        QVERIFY(m_panel->findChild<QQuickItem *>("worldbookInsertionProviderWarning")->isVisible());
        QVERIFY(revealPriorityControl(position)); position->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->insertionPosition().toString(), QString("after_char"));
        QVERIFY(!depth->isEnabled() && !role->isEnabled()); QCOMPARE(m_archive->insertionDepth().toInt(), 7);
        QCOMPARE(m_archive->insertionRole().toString(), QString("system"));
        QVERIFY(!m_panel->findChild<QQuickItem *>("worldbookInsertionProviderWarning")->isVisible());
        QVERIFY(!m_panel->findChild<QQuickItem *>("worldbookInsertionDowngradeWarning")->isVisible());
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }
    void worldbookInsertionSharedHostTabRevealsWholeControls_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<bool>("reduced");
        for (const int width : {1380, 950, 760}) for (const bool reduced : {false, true})
            QTest::newRow((QByteArray::number(width) + (reduced ? "-reduced" : "-animated")).constData()) << width << reduced;
    }
    void worldbookInsertionSharedHostTabRevealsWholeControls() {
        QFETCH(int, width); QFETCH(bool, reduced);
        QVERIFY(loadArchiveDrawer(insertionFixtureArchive(), width, true, true, reduced));
        auto *position = m_panel->findChild<QQuickItem *>("worldbookInsertionPosition");
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth");
        auto *role = m_panel->findChild<QQuickItem *>("worldbookInsertionRole");
        QVERIFY(position && depth && role && revealPriorityControl(position)); position->forceActiveFocus(Qt::TabFocusReason);
        const auto before = archiveFocusDraftState();
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        const QList<QPair<Qt::Key, QQuickItem *>> steps{{Qt::Key_Tab, depth}, {Qt::Key_Tab, role}, {Qt::Key_Backtab, depth}, {Qt::Key_Backtab, position}};
        for (const auto &step : steps) {
            QVERIFY(ArchiveFocusProbe::beginObservation(m_panel)); QTest::keyClick(m_window.get(), step.first);
            auto *leaf = m_window->activeFocusItem();
            QVERIFY(leaf && (leaf == step.second || step.second->isAncestorOf(leaf)));
            QVERIFY(NativeControlReadiness::wholeVisibility(step.second, m_window.get()).value("fullyVisible").toBool());
            QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
            QVERIFY(!ArchiveFocusProbe::causalSnapshot(m_panel).value("overflow").toBool());
        }
        QCOMPARE(archiveFocusDraftState(), before); QCOMPARE(rendererCommandCount("archive:put"), 0);
    }
    void worldbookInsertionReadonlyAndMissingViews_data() {
        QTest::addColumn<QString>("mode");
        QTest::newRow("missing-defaults") << "missing";
        QTest::newRow("legacy-depth-201") << "legacy";
        QTest::newRow("invalid-depth-type") << "invalid";
        QTest::newRow("read-failure") << "failed";
    }
    void worldbookInsertionReadonlyAndMissingViews() {
        QFETCH(QString, mode); auto archive = insertionFixtureArchive("at_depth", mode == "legacy" ? QJsonValue(201) : mode == "invalid" ? QJsonValue("bad") : QJsonValue(2));
        if (mode == "missing") {
            auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject(); auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
            entry.remove("position"); entry.remove("depth"); entry.remove("role"); entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        }
        QVERIFY(loadArchiveDrawer(archive, 760, true, true));
        if (mode == "failed") { m_archive->load(); const auto read = lastRendererCommand("archive:get")["request_id"].toString(); m_archive->failed(read, "deadline", m_bridge->generation()); }
        auto *depth = m_panel->findChild<QQuickItem *>("worldbookInsertionDepth"); QVERIFY(depth);
        if (mode == "legacy" || mode == "invalid" || mode == "failed") {
            QVERIFY(!depth->isVisible()); auto *text = m_panel->findChild<QQuickItem *>("worldbookOriginalInsertionDepth");
            QVERIFY(text && text->isVisible() && revealPriorityControl(text));
            QVERIFY(NativeControlReadiness::wholeVisibility(text, m_window.get()).value("fullyVisible").toBool());
            QVERIFY(text->property("text").toString().contains(mode == "legacy" ? "原值 201" : "未确认"));
        } else {
            QCOMPARE(depth->property("value").toInt(), 0); QVERIFY(!depth->isEnabled());
            for (const auto &key : {"position", "depth", "role"}) QVERIFY(!m_archive->insertionStates().value(key).toMap().value("present").toBool());
        }
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }

    void worldbookPriorityRealControlKeepsMetadataAndOwnSave_data() {
        QTest::addColumn<bool>("regex");
        QTest::addColumn<int>("width");
        QTest::newRow("literal-normal") << false << 1000;
        QTest::newRow("literal-narrow") << false << 591;
        QTest::newRow("regex-normal") << true << 1000;
        QTest::newRow("regex-narrow") << true << 591;
    }
    void worldbookPriorityRealControlKeepsMetadataAndOwnSave() {
        QFETCH(bool, regex); QFETCH(int, width);
        QVERIFY(loadPriorityDrawer(0, regex, width));
        auto *priority = m_panel->findChild<QQuickItem *>("worldbookPriority");
        QVERIFY(priority && priority->isEnabled() && priority->isVisible());
        QCOMPARE(m_panel->findChildren<QObject *>("worldbookPriority").size(), 1);
        QCOMPARE(priority->property("from").toInt(), 0);
        QCOMPARE(priority->property("to").toInt(), 2147483647);
        QVERIFY(revealPriorityControl(priority));
        priority->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->priority().toInt(), 1);
        QVERIFY(m_archive->dirty());
        QCOMPARE(rendererCommandCount("archive:put"), 0);
        auto *save = m_panel->findChild<QQuickItem *>("saveWorldbook");
        QVERIFY(save && save->isEnabled() && revealPriorityControl(save));
        const auto center = save->mapToScene(QPointF(save->width() / 2, save->height() / 2)).toPoint();
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, center);
        QTRY_COMPARE(rendererCommandCount("archive:put"), 1);
        const auto command = lastRendererCommand("archive:put");
        const auto payload = command["payload"].toObject();
        QCOMPARE(payload["expected_revision"].toInt(), 4);
        auto expected = priorityFixtureArchive(1, regex);
        QCOMPARE(payload["archive"].toObject(), expected);
        priorityFixtureResponse("foreign-save", expected, 5);
        QCOMPARE(m_archive->status(), QString("saving"));
        QVERIFY(m_archive->dirty());
        const auto submittedEntry = expected["worldBooks"].toArray()[0].toObject()["entries"].toArray()[0].toObject();
        QVERIFY(!submittedEntry.contains("scanDepth") && !submittedEntry.contains("tokenBudget"));
        const auto receipt = normalizedEntrySettingsReceipt(expected);
        const auto returnedEntry = receipt["worldBooks"].toArray()[0].toObject()["entries"].toArray()[0].toObject();
        QVERIFY(returnedEntry["scanDepth"].isNull() && returnedEntry["tokenBudget"].isNull());
        priorityFixtureResponse(command["request_id"].toString(), receipt, 5);
        QTRY_COMPARE(m_archive->status(), QString("saved"));
        QVERIFY(!m_archive->dirty());
        QCOMPARE(m_archive->priority().toInt(), 1);
        QCOMPARE(m_archive->revision(), 5);
        QCOMPARE(rendererCommandCount("archive:put"), 1);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void worldbookPriorityLegacyAndInvalidAreReadOnly_data() {
        QTest::addColumn<QJsonValue>("priority");
        QTest::addColumn<bool>("confirmed");
        QTest::newRow("legacy-large") << QJsonValue(2147483648.0) << true;
        QTest::newRow("invalid-string") << QJsonValue("bad") << false;
        QTest::newRow("invalid-bool") << QJsonValue(true) << false;
    }
    void worldbookPriorityLegacyAndInvalidAreReadOnly() {
        QFETCH(QJsonValue, priority); QFETCH(bool, confirmed);
        QVERIFY(loadPriorityDrawer(confirmed ? priority : QJsonValue(0), true));
        if (!confirmed) {
            m_archive->reloadDiscardingDraft();
            priorityFixtureResponse(lastRendererCommand("archive:get")["request_id"].toString(),
                                    priorityFixtureArchive(priority, true), 4);
            QCOMPARE(m_archive->status(), QString("read-error"));
        }
        auto *control = m_panel->findChild<QQuickItem *>("worldbookPriority");
        auto *original = m_panel->findChild<QQuickItem *>("worldbookOriginalPriority");
        QVERIFY(control && original);
        QVERIFY(!control->isVisible() && !control->isEnabled());
        QTRY_VERIFY(original->isVisible());
        QCOMPARE(m_archive->priorityConfirmed(), confirmed);
        QVERIFY(!m_archive->priorityEditable());
        if (confirmed) QVERIFY(original->property("text").toString().contains("2147483648"));
        else QVERIFY(original->property("text").toString().contains("未确认"));
        QVERIFY(revealPriorityControl(original));
        QVERIFY(!original->property("truncated").toBool());
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }
    void worldbookPrioritySubsequentDraftSurvivesRealSaveReceipt() {
        QVERIFY(loadPriorityDrawer(0, false));
        auto *priority = m_panel->findChild<QQuickItem *>("worldbookPriority");
        QVERIFY(revealPriorityControl(priority));
        priority->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->priority().toInt(), 1);
        auto *save = m_panel->findChild<QQuickItem *>("saveWorldbook");
        QVERIFY(revealPriorityControl(save));
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier,
                         save->mapToScene(QPointF(save->width()/2, save->height()/2)).toPoint());
        QTRY_COMPARE(rendererCommandCount("archive:put"), 1);
        const auto id = lastRendererCommand("archive:put")["request_id"].toString();
        QVERIFY(revealPriorityControl(priority));
        priority->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->priority().toInt(), 2);
        const auto submitted = lastRendererCommand("archive:put")["payload"].toObject()["archive"].toObject();
        const auto submittedEntry = submitted["worldBooks"].toArray()[0].toObject()["entries"].toArray()[0].toObject();
        QVERIFY(!submittedEntry.contains("scanDepth") && !submittedEntry.contains("tokenBudget"));
        const auto receipt = normalizedEntrySettingsReceipt(priorityFixtureArchive(1, false));
        const auto returnedEntry = receipt["worldBooks"].toArray()[0].toObject()["entries"].toArray()[0].toObject();
        QVERIFY(returnedEntry["scanDepth"].isNull() && returnedEntry["tokenBudget"].isNull());
        priorityFixtureResponse(id, receipt, 5);
        QTRY_COMPARE(m_archive->status(), QString("dirty"));
        QCOMPARE(m_archive->priority().toInt(), 2);
        QVERIFY(m_archive->dirty());
        QCOMPARE(m_archive->revision(), 5);
        QCOMPARE(rendererCommandCount("archive:put"), 1);
    }
    void clickCenter(QQuickItem *item) {
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier,
                          item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint());
    }
    void worldbookBookSettingsRealControlsSaveOnlyEditedSettings_data() {
        QTest::addColumn<int>("width");
        QTest::newRow("normal") << 1000;
        QTest::newRow("narrow") << 591;
    }
    void worldbookBookSettingsRealControlsSaveOnlyEditedSettings() {
        QFETCH(int, width);
        QVERIFY(loadArchiveDrawer(bookSettingsFixtureArchive(1, 100, false), width, false));
        auto *scan = m_panel->findChild<QQuickItem *>("worldbookScanDepth");
        auto *budget = m_panel->findChild<QQuickItem *>("worldbookBookTokenBudget");
        auto *recursive = m_panel->findChild<QQuickItem *>("worldbookRecursiveScanning");
        auto *priority = m_panel->findChild<QQuickItem *>("worldbookPriority");
        QVERIFY(scan && budget && recursive && priority);
        for (const auto *name : {"worldbookScanDepth", "worldbookBookTokenBudget", "worldbookRecursiveScanning"})
            QCOMPARE(m_panel->findChildren<QObject *>(name).size(), 1);
        QTRY_VERIFY(scan->isVisible() && budget->isVisible() && recursive->isVisible());
        QVERIFY(scan->isEnabled() && budget->isEnabled() && recursive->isEnabled());
        QVERIFY(!priority->isVisible());
        QCOMPARE(scan->property("from").toInt(), 0); QCOMPARE(scan->property("to").toInt(), 200);
        QCOMPARE(budget->property("from").toInt(), 0); QCOMPARE(budget->property("to").toInt(), 4000);
        QCOMPARE(budget->property("stepSize").toInt(), 50);
        QCOMPARE(scan->property("value").toInt(), 1); QCOMPARE(budget->property("value").toInt(), 100);
        QVERIFY(!recursive->property("checked").toBool());
        QVERIFY(revealPriorityControl(scan));
        scan->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Up); QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->scanDepth().toInt(), 3);
        QVERIFY(revealPriorityControl(recursive));
        clickCenter(recursive);
        QTRY_COMPARE(m_archive->recursiveScanning(), QVariant(true));
        QVERIFY(revealPriorityControl(budget));
        budget->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Down); QTest::keyClick(m_window.get(), Qt::Key_Down);
        QTRY_COMPARE(m_archive->bookTokenBudget().toInt(), 0);
        QVERIFY(m_archive->dirty());
        QCOMPARE(rendererCommandCount("archive:put"), 0);
        auto *save = m_panel->findChild<QQuickItem *>("saveWorldbook");
        QVERIFY(save && save->isEnabled() && revealPriorityControl(save));
        clickCenter(save);
        QTRY_COMPARE(rendererCommandCount("archive:put"), 1);
        const auto command = lastRendererCommand("archive:put");
        const auto payload = command["payload"].toObject();
        QCOMPARE(payload["expected_revision"].toInt(), 4);
        const auto expected = bookSettingsFixtureArchive(3, 0, true);
        QCOMPARE(payload["archive"].toObject(), expected);
        priorityFixtureResponse(command["request_id"].toString(), expected, 5);
        QTRY_COMPARE(m_archive->status(), QString("saved"));
        QVERIFY(!m_archive->dirty());
        QTRY_COMPARE(scan->property("value").toInt(), 3);
        QCOMPARE(budget->property("value").toInt(), 0);
        QVERIFY(recursive->property("checked").toBool());
        QCOMPARE(rendererCommandCount("archive:put"), 1);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void worldbookBookSettingsLegacyAndInvalidAreReadOnly_data() {
        QTest::addColumn<QString>("control");
        QTest::addColumn<QJsonValue>("scanDepth");
        QTest::addColumn<QJsonValue>("tokenBudget");
        QTest::addColumn<QString>("shown");
        QTest::newRow("scan-legacy-large") << "ScanDepth" << QJsonValue(201) << QJsonValue(100) << "201";
        QTest::newRow("budget-legacy-large") << "BookTokenBudget" << QJsonValue(1) << QJsonValue(4001) << "4001";
        QTest::newRow("scan-invalid-string") << "ScanDepth" << QJsonValue("1") << QJsonValue(100) << "未确认";
    }
    void worldbookBookSettingsLegacyAndInvalidAreReadOnly() {
        QFETCH(QString, control); QFETCH(QJsonValue, scanDepth); QFETCH(QJsonValue, tokenBudget); QFETCH(QString, shown);
        const bool confirmed = shown != "未确认";
        QVERIFY(loadArchiveDrawer(bookSettingsFixtureArchive(confirmed ? scanDepth : QJsonValue(1), tokenBudget, false), 760, false));
        if (!confirmed) {
            m_archive->reloadDiscardingDraft();
            priorityFixtureResponse(lastRendererCommand("archive:get")["request_id"].toString(),
                                    bookSettingsFixtureArchive(scanDepth, tokenBudget, false), 4);
            QCOMPARE(m_archive->status(), QString("read-error"));
        }
        auto *input = m_panel->findChild<QQuickItem *>("worldbook" + control);
        auto *original = m_panel->findChild<QQuickItem *>("worldbookOriginal" + control);
        QVERIFY(input && original);
        QTRY_VERIFY(original->isVisible());
        QVERIFY(!input->isVisible());
        QVERIFY(original->property("text").toString().contains(shown));
        QVERIFY(revealPriorityControl(original));
        QVERIFY(!original->property("truncated").toBool());
        if (!confirmed) {
            auto *recursive = m_panel->findChild<QQuickItem *>("worldbookOriginalRecursiveScanning");
            QVERIFY(recursive && recursive->isVisible());
        }
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }
    void worldbookEntrySettingsRealControlsOverrideAndInherit_data() {
        QTest::addColumn<int>("width");
        QTest::newRow("normal") << 1000;
        QTest::newRow("narrow") << 591;
    }
    void worldbookEntrySettingsRealControlsOverrideAndInherit() {
        QFETCH(int, width);
        const QJsonValue null(QJsonValue::Null);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(null, null), width, true));
        auto *scanInherit = m_panel->findChild<QQuickItem *>("worldbookEntryScanDepthInherit");
        auto *budgetInherit = m_panel->findChild<QQuickItem *>("worldbookEntryTokenBudgetInherit");
        auto *scan = m_panel->findChild<QQuickItem *>("worldbookEntryScanDepth");
        auto *budget = m_panel->findChild<QQuickItem *>("worldbookEntryTokenBudget");
        auto *bookScan = m_panel->findChild<QQuickItem *>("worldbookScanDepth");
        QVERIFY(scanInherit && budgetInherit && scan && budget && bookScan);
        for (const auto *name : {"worldbookEntryScanDepthInherit", "worldbookEntryTokenBudgetInherit",
                                 "worldbookEntryScanDepth", "worldbookEntryTokenBudget"})
            QCOMPARE(m_panel->findChildren<QObject *>(name).size(), 1);
        QTRY_VERIFY(scanInherit->isVisible() && budgetInherit->isVisible());
        QVERIFY(scanInherit->isEnabled() && budgetInherit->isEnabled());
        QVERIFY(scanInherit->property("checked").toBool() && budgetInherit->property("checked").toBool());
        QVERIFY(scanInherit->property("text").toString().contains("本书 1"));
        QVERIFY(budgetInherit->property("text").toString().contains("本书 100"));
        QVERIFY(!scan->isVisible() && !budget->isVisible() && !bookScan->isVisible());
        QCOMPARE(scan->property("to").toInt(), 200); QCOMPARE(budget->property("to").toInt(), 4000);
        QCOMPARE(budget->property("stepSize").toInt(), 50);
        // Overrides start from the book's own values.
        QVERIFY(revealPriorityControl(scanInherit)); clickCenter(scanInherit);
        QTRY_VERIFY(scan->isVisible()); QVERIFY(!scanInherit->property("checked").toBool());
        QCOMPARE(scan->property("value").toInt(), 1);
        QVERIFY(revealPriorityControl(scan)); scan->forceActiveFocus(Qt::TabFocusReason);
        for (int i = 0; i < 4; ++i) QTest::keyClick(m_window.get(), Qt::Key_Up);
        QTRY_COMPARE(m_archive->entryScanDepth().toInt(), 5);
        QVERIFY(revealPriorityControl(budgetInherit)); clickCenter(budgetInherit);
        QTRY_VERIFY(budget->isVisible()); QCOMPARE(budget->property("value").toInt(), 100);
        QVERIFY(revealPriorityControl(budget)); budget->forceActiveFocus(Qt::TabFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Down);
        QTRY_COMPARE(m_archive->entryTokenBudget().toInt(), 50);
        QCOMPARE(rendererCommandCount("archive:put"), 0);
        auto *save = m_panel->findChild<QQuickItem *>("saveWorldbook");
        QVERIFY(save && save->isEnabled() && revealPriorityControl(save)); clickCenter(save);
        QTRY_COMPARE(rendererCommandCount("archive:put"), 1);
        auto command = lastRendererCommand("archive:put");
        auto expected = entrySettingsFixtureArchive(5, 50);
        QCOMPARE(command["payload"].toObject()["archive"].toObject(), expected);
        priorityFixtureResponse(command["request_id"].toString(), expected, 5);
        QTRY_COMPARE(m_archive->status(), QString("saved"));
        QTRY_COMPARE(scan->property("value").toInt(), 5); QCOMPARE(budget->property("value").toInt(), 50);
        // Following the book again writes an explicit null.
        QVERIFY(revealPriorityControl(scanInherit)); clickCenter(scanInherit);
        QTRY_VERIFY(scanInherit->property("checked").toBool()); QTRY_VERIFY(!scan->isVisible());
        QVERIFY(save->isEnabled() && revealPriorityControl(save)); clickCenter(save);
        QTRY_COMPARE(rendererCommandCount("archive:put"), 2);
        command = lastRendererCommand("archive:put");
        QCOMPARE(command["payload"].toObject()["expected_revision"].toInt(), 5);
        expected = entrySettingsFixtureArchive(null, 50);
        QCOMPARE(command["payload"].toObject()["archive"].toObject(), expected);
        priorityFixtureResponse(command["request_id"].toString(), expected, 6);
        QTRY_COMPARE(m_archive->status(), QString("saved"));
        QVERIFY(m_archive->entrySettingInherited("scanDepth")); QVERIFY(!m_archive->dirty());
        QVERIFY(scanInherit->property("checked").toBool() && !budgetInherit->property("checked").toBool());
        QCOMPARE(rendererCommandCount("archive:put"), 2);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void worldbookEntrySettingsLegacyInvalidAndBlockedAreReadOnly_data() {
        QTest::addColumn<QString>("control");
        QTest::addColumn<QJsonValue>("scanDepth");
        QTest::addColumn<QJsonValue>("tokenBudget");
        QTest::addColumn<QJsonValue>("bookBudget");
        QTest::addColumn<QString>("shown");
        const QJsonValue null(QJsonValue::Null);
        QTest::newRow("scan-legacy-large") << "ScanDepth" << QJsonValue(201) << null << QJsonValue(100) << "201";
        QTest::newRow("budget-legacy-large") << "TokenBudget" << null << QJsonValue(4001) << QJsonValue(100) << "4001";
        QTest::newRow("scan-invalid-string") << "ScanDepth" << QJsonValue("1") << null << QJsonValue(100) << "未确认";
        QTest::newRow("budget-book-unconfirmed") << "TokenBudget" << null << null << QJsonValue(QJsonValue::Undefined) << "暂不能单独设置";
    }
    void worldbookEntrySettingsLegacyInvalidAndBlockedAreReadOnly() {
        QFETCH(QString, control); QFETCH(QJsonValue, scanDepth); QFETCH(QJsonValue, tokenBudget);
        QFETCH(QJsonValue, bookBudget); QFETCH(QString, shown);
        const bool invalid = shown == "未确认", blocked = shown == "暂不能单独设置";
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(invalid ? QJsonValue(1) : scanDepth, tokenBudget, bookBudget), 760, true));
        if (invalid) {
            m_archive->reloadDiscardingDraft();
            priorityFixtureResponse(lastRendererCommand("archive:get")["request_id"].toString(),
                                    entrySettingsFixtureArchive(scanDepth, tokenBudget, bookBudget), 4);
            QCOMPARE(m_archive->status(), QString("read-error"));
        }
        auto *input = m_panel->findChild<QQuickItem *>("worldbookEntry" + control);
        auto *inherit = m_panel->findChild<QQuickItem *>("worldbookEntry" + control + "Inherit");
        auto *original = m_panel->findChild<QQuickItem *>("worldbookOriginalEntry" + control);
        QVERIFY(input && inherit && original);
        QTRY_VERIFY(!input->isVisible());
        if (blocked) {
            QTRY_VERIFY(inherit->isVisible());
            QVERIFY(inherit->property("checked").toBool() && !inherit->isEnabled());
            QVERIFY(inherit->property("text").toString().contains(shown));
            QVERIFY(!original->isVisible());
            QVERIFY(revealPriorityControl(inherit));
            clickCenter(inherit);
            QVERIFY(m_archive->entrySettingInherited("tokenBudget")); QVERIFY(!m_archive->dirty());
        } else {
            QTRY_VERIFY(original->isVisible());
            QVERIFY(!inherit->isVisible());
            QVERIFY(original->property("text").toString().contains(shown));
            QVERIFY(revealPriorityControl(original));
            QVERIFY(!original->property("truncated").toBool());
        }
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }

    void worldbookRegexPatternControlsKeepPlainTextAndTab_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<bool>("secondary");
        QTest::newRow("wide-primary-pattern") << 1380 << false;
        QTest::newRow("wide-secondary-pattern") << 1380 << true;
        QTest::newRow("compact-primary-pattern") << 950 << false;
        QTest::newRow("compact-secondary-pattern") << 950 << true;
        QTest::newRow("narrow-primary-pattern") << 760 << false;
        QTest::newRow("narrow-secondary-pattern") << 760 << true;
    }
    void worldbookRegexPatternControlsKeepPlainTextAndTab() {
        QFETCH(int, width); QFETCH(bool, secondary);
        const QString pattern = QStringLiteral(" <tag>\\d{1,3}\\t ");
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, {pattern}, {pattern}), width, true, true));
        const char *fieldName = secondary ? "worldbookRegexSecondaryKeywords" : "worldbookRegexKeywords";
        const char *viewName = secondary ? "worldbook-regex-secondary-scroll" : "worldbook-regex-keywords-scroll";
        auto *field = m_panel->findChild<QQuickItem *>(fieldName);
        auto *viewport = m_panel->findChild<QQuickItem *>(viewName);
        auto *literal = m_panel->findChild<QQuickItem *>(secondary ? "worldbookSecondaryKeywords" : "worldbookKeys");
        QVERIFY(field && viewport && literal && field->isVisible() && field->isEnabled() && !literal->isVisible());
        const auto format = WorldbookRegexProbe::textFormat(field);
        QVERIFY(WorldbookRegexProbe::plainTextFormat(field));
        QCOMPARE(format.metaType().id(), QMetaType::Int);
        QJsonParseError formatError;
        const auto formatBytes = QJsonDocument(QJsonObject::fromVariantMap({{"textFormat", format}})).toJson(QJsonDocument::Compact);
        const auto formatWire = QJsonDocument::fromJson(formatBytes, &formatError);
        QCOMPARE(formatError.error, QJsonParseError::NoError);
        QVERIFY(formatWire.isObject());
        QVERIFY(formatWire.object()["textFormat"].isDouble());
        QCOMPARE(formatWire.object()["textFormat"].toDouble(-1), 0.0);
        QCOMPARE(field->property("text").toString(), pattern);
        QVERIFY(!field->property("readOnly").toBool());
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        const auto before = archiveFocusDraftState();
        auto *previous = secondary ? field->nextItemInFocusChain(false) : m_panel->findChild<QQuickItem *>("worldbookComment");
        QVERIFY(previous && previous != field && previous->isVisible() && previous->isEnabled());
        previous->forceActiveFocus(Qt::OtherFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Tab);
        QVERIFY(m_window->activeFocusItem() == field || field->isAncestorOf(m_window->activeFocusItem()));
        QVERIFY(NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool());
        QCOMPARE(field->property("text").toString(), pattern);
        QTest::keyClick(m_window.get(), Qt::Key_Tab);
        QVERIFY(m_window->activeFocusItem() != field);
        QCOMPARE(field->property("text").toString(), pattern);
        field->forceActiveFocus(Qt::OtherFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Backtab);
        QVERIFY(m_window->activeFocusItem() != field);
        QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
        QCOMPARE(field->property("text").toString(), pattern);
        QCOMPARE(archiveFocusDraftState(), before);
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexTextFormatRejectsMalformedAndNonPlain_data() {
        QTest::addColumn<QString>("sourceKind");
        QTest::newRow("missing-object") << QString("missing-object");
        QTest::newRow("missing-property") << QString("missing-property");
        QTest::newRow("null-property") << QString("null-property");
        QTest::newRow("string-plain-text") << QString("string-plain-text");
        QTest::newRow("integer-zero") << QString("integer-zero");
        QTest::newRow("unknown-integer") << QString("unknown-integer");
        QTest::newRow("foreign-enum-zero") << QString("foreign-enum-zero");
        QTest::newRow("real-rich-text") << QString("real-rich-text");
        QTest::newRow("real-auto-text") << QString("real-auto-text");
        QTest::newRow("real-unknown-enum-member") << QString("real-unknown-enum-member");
    }
    void worldbookRegexTextFormatRejectsMalformedAndNonPlain() {
        QFETCH(QString, sourceKind);
        QObject missing;
        WorldbookRegexRawFormatFixture raw;
        WorldbookRegexForeignFormatFixture foreign;
        QObject *source = &raw;
        bool knownNonPlain = false;
        int expectedNumber = -1;
        if (sourceKind == "missing-object") source = nullptr;
        else if (sourceKind == "missing-property") source = &missing;
        else if (sourceKind == "null-property") raw.value = QVariant::fromValue(nullptr);
        else if (sourceKind == "string-plain-text") raw.value = QString("PlainText");
        else if (sourceKind == "integer-zero") raw.value = 0;
        else if (sourceKind == "unknown-integer") raw.value = 99;
        else if (sourceKind == "foreign-enum-zero") source = &foreign;
        else {
            QVERIFY(loadArchiveDrawer(regexFixtureArchive(), 760, true, true));
            source = m_panel->findChild<QQuickItem *>("worldbookRegexKeywords");
            QVERIFY(source);
            const int propertyIndex = source->metaObject()->indexOfProperty("textFormat");
            QVERIFY(propertyIndex >= 0);
            const auto property = source->metaObject()->property(propertyIndex);
            QVERIFY(property.isReadable() && property.isWritable() && property.isEnumType());
            const auto enumeration = property.enumerator();
            QVERIFY(enumeration.isValid());
            QCOMPARE(enumeration.keyToValue("PlainText"), 0);
            if (sourceKind == "real-unknown-enum-member") {
                expectedNumber = 99;
                QVERIFY(!enumeration.valueToKey(expectedNumber));
            } else {
                const auto member = sourceKind == "real-rich-text" ? "RichText" : "AutoText";
                expectedNumber = enumeration.keyToValue(member);
                QVERIFY(expectedNumber > 0);
                knownNonPlain = true;
            }
            // Keep the real property's enum metatype when introducing a known
            // non-plain member or an unknown member; no integer coercion probe.
            QVERIFY(property.write(source, QVariant(property.metaType(), &expectedNumber)));
            const auto observed = property.read(source);
            QCOMPARE(observed.metaType(), property.metaType());
            QVERIFY(observed.metaType().flags().testFlag(QMetaType::IsEnumeration));
            QCOMPARE(observed.toInt(), expectedNumber);
        }
        const auto format = WorldbookRegexProbe::textFormat(source);
        QVERIFY(!WorldbookRegexProbe::plainTextFormat(source));
        if (knownNonPlain) {
            QCOMPARE(format.metaType().id(), QMetaType::Int);
            QCOMPARE(format.toInt(), expectedNumber);
        } else {
            QVERIFY(!format.isValid());
        }
        QJsonParseError parseError;
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap({{"textFormat", format}})).toJson(QJsonDocument::Compact);
        const auto parsed = QJsonDocument::fromJson(bytes, &parseError);
        QCOMPARE(parseError.error, QJsonParseError::NoError);
        QVERIFY(parsed.isObject());
        const auto serialized = parsed.object()["textFormat"];
        if (knownNonPlain) {
            QVERIFY(serialized.isDouble());
            QCOMPARE(serialized.toDouble(-1), double(expectedNumber));
            QVERIFY(serialized.toDouble(-1) != 0.0);
        } else {
            QVERIFY(serialized.isNull());
        }
    }
    void worldbookRegexNativeEvidenceProducedForHost_data() {
        QTest::addColumn<QString>("caseId");
        QTest::newRow("regex-primary-selected") << QString("regex-primary-selected");
        QTest::newRow("regex-secondary-plain") << QString("regex-secondary-plain");
    }
    void worldbookRegexNativeEvidenceProducedForHost() {
        QFETCH(QString, caseId);
        const auto contract = worldbookRegexEvidenceContract();
        QCOMPARE(contract["schema"].toString(), QString("reverie.regex-native-evidence-contract.v1"));
        QCOMPARE(contract["recordSchema"].toString(), QString("reverie.regex-native-evidence.v1"));
        QCOMPARE(contract["manifestSchema"].toString(), QString("reverie.regex-native-evidence-manifest.v1"));
        QCOMPARE(contract["maximumRecordBytes"].toInt(), 131072);
        QCOMPARE(contract["cases"].toArray().size(), 2);
        QJsonObject specification;
        for (const auto &entry : contract["cases"].toArray())
            if (entry.toObject()["caseId"].toString() == caseId) specification = entry.toObject();
        QVERIFY(!specification.isEmpty());
        const auto control = specification["control"].toString();
        const auto viewportName = specification["viewport"].toString();
        const bool selected = specification["selectionRequired"].toBool();
        const QString pattern = QStringLiteral("ID-(?:\\d{4})");
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, {pattern}, {pattern}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>(control);
        auto *viewport = m_panel->findChild<QQuickItem *>(viewportName);
        QVERIFY(field && viewport && field->isVisible() && field->isEnabled());
        QCOMPARE(field->property("text").toString(), pattern);
        const int propertyIndex = field->metaObject()->indexOfProperty("textFormat");
        QVERIFY(propertyIndex >= 0);
        const auto property = field->metaObject()->property(propertyIndex);
        QVERIFY(property.isEnumType() && property.enumerator().isValid());
        const auto rawFormat = property.read(field);
        QCOMPARE(rawFormat.metaType(), property.metaType());
        QVERIFY(rawFormat.metaType().flags().testFlag(QMetaType::IsEnumeration));
        QVERIFY(WorldbookRegexProbe::plainTextFormat(field));
        QElapsedTimer clock; clock.start();
        QVERIFY(prepareRegexViewport(viewport, clock));
        field->forceActiveFocus(Qt::OtherFocusReason);
        QVERIFY(QMetaObject::invokeMethod(field, "select", Q_ARG(int, selected ? 9 : 0), Q_ARG(int, selected ? 10 : 0)));
        QCOMPARE(field->property("selectedText").toString(), selected ? QString("4") : QString());
        QVariantMap geometry;
        QString probeFailure;
        const bool ready = QTest::qWaitFor([&] {
            m_window->update();
            geometry = WorldbookRegexProbe::patternGeometry(field, viewport, m_window.get(), [&](bool ok, const QString &code) {
                if (!ok && probeFailure.isEmpty()) probeFailure = code;
            });
            return probeFailure.isEmpty() && geometry["fullyVisible"].toBool() && geometry["focusInTarget"].toBool() &&
                geometry["hasSelection"].toBool() == selected &&
                (selected ? geometry["selectionFullyVisible"].toBool() : !geometry["selectionFullyVisible"].toBool());
        }, int(std::max<qint64>(0, 4000 - clock.elapsed())));
        QVERIFY2(probeFailure.isEmpty(), qPrintable(probeFailure));
        QVERIFY(ready);
        const auto format = WorldbookRegexProbe::textFormat(field);
        QCOMPARE(format.metaType().id(), QMetaType::Int);
        QCOMPARE(format, geometry["textFormat"]);
        QCOMPARE(geometry["selectionStart"].toInt(), selected ? 9 : 0);
        QCOMPARE(geometry["selectionEnd"].toInt(), selected ? 10 : 0);
        if (!selected) QCOMPARE(geometry["selectionRect"].toMap(), WorldbookRegexProbe::rectMap(QRectF()));
        const QVariantMap record{{"schema", contract["recordSchema"].toString()}, {"caseId", caseId}, {"control", control},
            {"windowWidth", m_window->width()}, {"windowHeight", m_window->height()},
            {"textFormat", format}, {"geometry", geometry}};
        // Both fields cross the production QVariantMap -> Qt JSON bytes ->
        // parsed JSON boundary. The writer receives these exact original bytes.
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(record)).toJson(QJsonDocument::Compact);
        QJsonParseError parseError;
        const auto parsed = QJsonDocument::fromJson(bytes, &parseError);
        QCOMPARE(parseError.error, QJsonParseError::NoError);
        QVERIFY(parsed.isObject());
        const auto serialized = parsed.object();
        QVERIFY(serialized["textFormat"].isDouble());
        QCOMPARE(serialized["textFormat"].toDouble(-1), 0.0);
        const auto serializedGeometry = serialized["geometry"].toObject();
        QVERIFY(serializedGeometry["textFormat"].isDouble());
        QCOMPARE(serializedGeometry["textFormat"].toDouble(-1), 0.0);
        QCOMPARE(serializedGeometry["hasSelection"].toBool(), selected);
        QVERIFY(clock.elapsed() < 4000);
        QVERIFY(writeWorldbookRegexEvidence(caseId, bytes));
    }
    void worldbookRegexKeyboardEditPreservesCommaAndNewLine_data() {
        QTest::addColumn<bool>("secondary");
        QTest::newRow("primary-visible-selection-and-first-feedback") << false;
        QTest::newRow("secondary-visible-selection-and-first-feedback") << true;
    }
    void worldbookRegexKeyboardEditPreservesCommaAndNewLine() {
        QFETCH(bool, secondary);
        const QString initial = QStringLiteral("ID-(?:\\d{4})");
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, {initial}, {initial}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>(secondary ? "worldbookRegexSecondaryKeywords" : "worldbookRegexKeywords");
        auto *viewport = m_panel->findChild<QQuickItem *>(secondary ? "worldbook-regex-secondary-scroll" : "worldbook-regex-keywords-scroll");
        QVERIFY(field && viewport);
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        auto *previous = secondary ? field->nextItemInFocusChain(false) : m_panel->findChild<QQuickItem *>("worldbookComment");
        QVERIFY(previous && previous != field); previous->forceActiveFocus(Qt::OtherFocusReason);
        QTest::keyClick(m_window.get(), Qt::Key_Tab);
        QVERIFY(field->hasActiveFocus());
        QTest::keyClick(m_window.get(), Qt::Key_Home);
        QCOMPARE(field->property("cursorPosition").toInt(), 0);
        for (int i = 0; i < 9; ++i) QTest::keyClick(m_window.get(), Qt::Key_Right);
        QTest::keyClick(m_window.get(), Qt::Key_Right, Qt::ShiftModifier);
        QCOMPARE(field->property("selectionStart").toInt(), 9);
        QCOMPARE(field->property("selectionEnd").toInt(), 10);
        QCOMPARE(field->property("selectedText").toString(), QString("4"));
        QVERIFY(NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool());
        QString firstText; bool firstVisible = false; bool captured = false; qint64 firstFrame = -1;
        const auto capture = connect(m_window.get(), &QQuickWindow::afterAnimating, this, [&] {
            if (captured) return;
            captured = true; firstText = field->property("text").toString(); firstFrame = m_archiveFocusDiagnosticFrame;
            firstVisible = NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool();
        });
        const auto disconnectCapture = qScopeGuard([&] { disconnect(capture); });
        QTest::keyClick(m_window.get(), Qt::Key_1);
        const QString one = QStringLiteral("ID-(?:\\d{1})");
        QCOMPARE(field->property("text").toString(), one);
        m_window->update();
        QVERIFY(QTest::qWaitFor([&] { return captured; }, int(std::max<qint64>(0, 4000 - clock.elapsed()))));
        QCOMPARE(firstText, one); QVERIFY(firstVisible);
        QTest::qWait(40); // Stable feedback follows the already captured first frame.
        QCOMPARE(field->property("text").toString(), one);
        QVERIFY(m_archiveFocusDiagnosticFrame >= firstFrame);
        QVERIFY(NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool());
        QTest::keyClick(m_window.get(), Qt::Key_Comma); QTest::keyClick(m_window.get(), Qt::Key_3);
        const QString edited = QStringLiteral("ID-(?:\\d{1,3})");
        QCOMPARE(field->property("text").toString(), edited);
        const char *items = secondary ? "secondaryKeywordItems" : "keywordItems";
        QCOMPARE(m_archive->property(items).toList(), (QVariantList{edited}));
        QTest::keyClick(m_window.get(), Qt::Key_End); QTest::keyClick(m_window.get(), Qt::Key_Return);
        QCOMPARE(field->property("text").toString(), edited + '\n');
        QCOMPARE(m_archive->property(items).toList(), (QVariantList{edited}));
        QTest::keyClick(m_window.get(), 'x');
        QCOMPARE(m_archive->property(items).toList(), (QVariantList{edited, QString("x")}));
        QVERIFY(m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexSelectionSurvivesFocusReturn_data() {
        QTest::addColumn<bool>("secondary");
        QTest::newRow("primary-long-pattern-selection") << false;
        QTest::newRow("secondary-long-pattern-selection") << true;
    }
    void worldbookRegexSelectionSurvivesFocusReturn() {
        QFETCH(bool, secondary);
        QJsonArray patterns;
        for (int i = 0; i < 80; ++i) patterns.append(QString("pattern-%1-(?:[A-Z]{1,3})").arg(i));
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, patterns, patterns), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>(secondary ? "worldbookRegexSecondaryKeywords" : "worldbookRegexKeywords");
        auto *viewport = m_panel->findChild<QQuickItem *>(secondary ? "worldbook-regex-secondary-scroll" : "worldbook-regex-keywords-scroll");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        QVERIFY(field && viewport && title);
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        field->forceActiveFocus(Qt::TabFocusReason);
        QVERIFY(QMetaObject::invokeMethod(field, "select", Q_ARG(int, 700), Q_ARG(int, 705)));
        QTest::qWait(60); // Native caret/selection setup; return assertions remain immediate.
        auto *inner = viewport->property("contentItem").value<QQuickItem *>(); QVERIFY(inner);
        const auto caret = field->mapRectToScene(field->property("cursorRectangle").toRectF());
        QVERIFY(!caret.intersected(NativeControlReadiness::visibleRect(inner, m_window.get())).isEmpty());
        const auto selection = ArchiveFocusProbe::selection(field);
        const auto before = archiveFocusDraftState();
        title->forceActiveFocus(Qt::TabFocusReason);
        QCOMPARE(ArchiveFocusProbe::selection(field), selection);
        field->forceActiveFocus(Qt::BacktabFocusReason);
        QCOMPARE(ArchiveFocusProbe::selection(field), selection);
        QVERIFY(field->hasActiveFocus());
        QVERIFY(NativeControlReadiness::wholeVisibility(viewport, m_window.get()).value("fullyVisible").toBool());
        const auto returnedCaret = field->mapRectToScene(field->property("cursorRectangle").toRectF());
        QVERIFY(!returnedCaret.intersected(NativeControlReadiness::visibleRect(inner, m_window.get())).isEmpty());
        QCOMPARE(archiveFocusDraftState(), before);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexSwitchPreservesRealArrays_data() {
        QTest::addColumn<QString>("pattern");
        QTest::newRow("ordinary-pattern-roundtrip") << QStringLiteral("ID-\\d\\d");
        QTest::newRow("imported-comma-literal-roundtrip") << QStringLiteral("  alpha,beta  ");
    }
    void worldbookRegexSwitchPreservesRealArrays() {
        QFETCH(QString, pattern);
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(false, {pattern}, {}), 760, true, true));
        auto *toggle = m_panel->findChild<QQuickItem *>("worldbookUseRegex");
        auto *literal = m_panel->findChild<QQuickItem *>("worldbookKeys");
        auto *regex = m_panel->findChild<QQuickItem *>("worldbookRegexKeywords");
        QVERIFY(toggle && literal && regex && !regex->isVisible());
        const auto original = m_archive->property("keywordItems");
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(toggle, clock));
        QSignalSpy toggled(toggle, SIGNAL(toggled())); QVERIFY(toggled.isValid());
        clickCenter(toggle);
        QCOMPARE(m_archive->property("useRegex").toBool(), true);
        QCOMPARE(m_archive->property("keywordItems"), original);
        QVERIFY(regex->isVisible() && !literal->isVisible());
        QCOMPARE(regex->property("text").toString(), pattern);
        QVERIFY(prepareRegexViewport(toggle, clock)); clickCenter(toggle);
        QCOMPARE(toggled.size(), 2);
        QCOMPARE(m_archive->property("useRegex").toBool(), false);
        QCOMPARE(m_archive->property("keywordItems"), original);
        QVERIFY(literal->isVisible() && !regex->isVisible());
        QCOMPARE(literal->property("readOnly").toBool(), pattern.contains(','));
        QVERIFY(!m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexUnrepresentableViewsStayReadOnly_data() {
        QTest::addColumn<bool>("regex"); QTest::addColumn<QString>("pattern");
        QTest::newRow("literal-comma-kept") << false << QString("a,b");
        QTest::newRow("literal-edge-spaces-kept") << false << QString(" a ");
        QTest::newRow("regex-embedded-newline-kept") << true << QString("a\nb");
        QTest::newRow("regex-legacy-too-long-kept") << true << QString(16385, 'x');
    }
    void worldbookRegexUnrepresentableViewsStayReadOnly() {
        QFETCH(bool, regex); QFETCH(QString, pattern);
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(regex, {pattern}, {}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>(regex ? "worldbookRegexKeywords" : "worldbookKeys");
        auto *viewport = regex ? m_panel->findChild<QQuickItem *>("worldbook-regex-keywords-scroll") : field;
        QVERIFY(field && viewport && field->isEnabled() && field->property("readOnly").toBool());
        const auto before = m_archive->property("keywordItems");
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        const auto point = NativeControlReadiness::visibleRect(field, m_window.get()).center().toPoint();
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
        QVERIFY(field->hasActiveFocus()); QTest::keyClick(m_window.get(), Qt::Key_X);
        QCOMPARE(field->property("text").toString(), pattern);
        QCOMPARE(m_archive->property("keywordItems"), before);
        QVERIFY(!m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexNonbreakingSpaceRealControlRejectsKeyboardEdit() {
        const QString pattern = QStringLiteral("a") + QChar(0x00a0) + QStringLiteral("b");
        const QJsonArray patterns{pattern, QStringLiteral("untouched.*")};
        const QVariantList authority = patterns.toVariantList();
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, patterns, {}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>("worldbookRegexKeywords");
        auto *viewport = m_panel->findChild<QQuickItem *>("worldbook-regex-keywords-scroll");
        QVERIFY(field && viewport && field->isVisible() && field->isEnabled());
        QVERIFY(field->property("readOnly").toBool());
        QCOMPARE(m_archive->keywordItems(), authority);
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        const auto point = NativeControlReadiness::visibleRect(field, m_window.get()).center().toPoint();
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
        QVERIFY(field->hasActiveFocus());
        // The displayed text may normalize NBSP on some Qt versions. Only the
        // canonical array, and rejection of actual keyboard input, are contractual.
        const QString displayed = field->property("text").toString();
        QTest::keyClick(m_window.get(), Qt::Key_X);
        QCoreApplication::processEvents();
        QCOMPARE(field->property("text").toString(), displayed);
        QVERIFY(field->property("readOnly").toBool());
        QCOMPARE(m_archive->keywordItems(), authority);
        QVERIFY(!m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexFocusedRealControlKeepsNonbreakingSpaceAuthorityClean() {
        const QString initial = QStringLiteral("editable.*");
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(true, {initial}, {}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>("worldbookRegexKeywords");
        auto *viewport = m_panel->findChild<QQuickItem *>("worldbook-regex-keywords-scroll");
        QVERIFY(field && viewport && field->isVisible() && field->isEnabled());
        QVERIFY(!field->property("readOnly").toBool());
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(viewport, clock));
        clickCenter(field); QVERIFY(field->hasActiveFocus());
        QVERIFY(!m_archive->dirty());
        const int readsBefore = rendererCommandCount("archive:get");
        m_archive->load();
        QCOMPARE(rendererCommandCount("archive:get"), readsBefore + 1);
        const auto read = lastRendererCommand("archive:get")["request_id"].toString(); QVERIFY(!read.isEmpty());
        QVERIFY(field->hasActiveFocus() && !field->property("readOnly").toBool());
        const QString pattern = QStringLiteral("a") + QChar(0x00a0) + QStringLiteral("b");
        const QJsonArray patterns{pattern, QStringLiteral("authoritative.*")};
        priorityFixtureResponse(read, regexFixtureArchive(true, patterns, {}), 5);
        QCoreApplication::processEvents();
        // Do not assert the TextArea's NBSP representation: the model must
        // reject any lossy textChanged feedback regardless of binding order.
        QCOMPARE(m_archive->keywordItems(), patterns.toVariantList());
        QCOMPARE(m_archive->revision(), 5);
        QVERIFY(field->property("readOnly").toBool());
        QVERIFY(!m_archive->dirty()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookLiteralLongKeywordViewsDoNotTruncate_data() {
        QTest::addColumn<bool>("secondary");
        QTest::newRow("primary-above-textfield-default-cap") << false;
        QTest::newRow("secondary-above-textfield-default-cap") << true;
    }
    void worldbookLiteralLongKeywordViewsDoNotTruncate() {
        QFETCH(bool, secondary);
        const QString pattern(40000, 'z');
        QVERIFY(loadArchiveDrawer(regexFixtureArchive(false, secondary ? QJsonArray{"primary"} : QJsonArray{pattern},
            secondary ? QJsonArray{pattern} : QJsonArray{}), 760, true, true));
        auto *field = m_panel->findChild<QQuickItem *>(secondary ? "worldbookSecondaryKeywords" : "worldbookKeys");
        QVERIFY(field && field->isVisible() && field->isEnabled() && !field->property("readOnly").toBool());
        QCOMPARE(field->property("maximumLength").toInt(), 2147483647);
        QCOMPARE(field->property("text").toString(), pattern);
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(field, clock));
        clickCenter(field); QVERIFY(field->hasActiveFocus());
        QTest::keyClick(m_window.get(), Qt::Key_End); QTest::keyClick(m_window.get(), 'x');
        QCOMPARE(field->property("text").toString(), pattern + 'x');
        QCOMPARE(m_archive->property(secondary ? "secondaryKeywordItems" : "keywordItems").toList(),
                 (QVariantList{pattern + 'x'}));
        QVERIFY(m_archive->canSave()); QCOMPARE(rendererCommandCount("archive:put"), 0);
        QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexRuleConflictAdoptsOnlySavedRules() {
        const auto original = regexFixtureArchive(false, {"local"}, {});
        QVERIFY(loadArchiveDrawer(original, 760, true, true));
        m_archive->setContent("Keep this independent content draft");
        m_archive->setProperty("useRegex", true);
        m_archive->reconcileAfterRestore();
        const auto read = lastRendererCommand("archive:get")["request_id"].toString(); QVERIFY(!read.isEmpty());
        const auto authority = regexFixtureArchive(false, {"remote,opaque"}, {});
        priorityFixtureResponse(read, authority, 5);
        QVERIFY(m_archive->property("ruleConflict").toBool()); QVERIFY(!m_archive->canSave());
        auto *button = m_panel->findChild<QQuickItem *>("worldbookAdoptSavedRules"); QVERIFY(button && button->isVisible());
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(button, clock)); clickCenter(button);
        QVERIFY(!m_archive->property("ruleConflict").toBool());
        QCOMPARE(m_archive->property("useRegex").toBool(), false);
        QCOMPARE(m_archive->property("keywordItems").toList(), (QVariantList{QString("remote,opaque")}));
        QCOMPARE(m_archive->content(), QString("Keep this independent content draft"));
        QVERIFY(m_archive->dirty()); QVERIFY(m_archive->canSave());
        QCOMPARE(rendererCommandCount("archive:put"), 0); QVERIFY(clock.elapsed() < 4000);
    }
    void worldbookRegexDiagnosticsUsePlainSavedVersionText_data() {
        QTest::addColumn<QString>("state");
        QTest::newRow("no-runtime-record") << "unrun";
        QTest::newRow("current-entry-error") << "entry-error";
        QTest::newRow("current-global-error") << "global-error";
        QTest::newRow("current-evaluation-without-errors") << "clear";
        QTest::newRow("truncated-cannot-report-clear") << "truncated";
        QTest::newRow("unknown-code-unavailable") << "unavailable";
    }
    void worldbookRegexDiagnosticsUsePlainSavedVersionText() {
        QFETCH(QString, state);
        const auto archive = regexFixtureArchive(); QVERIFY(loadArchiveDrawer(archive, 760, true, true));
        m_archive->load(); const auto id = lastRendererCommand("archive:get")["request_id"].toString(); QVERIFY(!id.isEmpty());
        const QString persona = m_bridge->m_persona.value("persona_id").toString();
        const QString request = state == "unrun" ? QString() : QString("regex-fixture-request");
        QJsonArray records;
        if (state == "entry-error" || state == "global-error" || state == "unavailable") {
            const bool global = state == "global-error";
            records.append(QJsonObject{{"persona_id", persona}, {"revision", 4}, {"request_id", request},
                {"book_id", global ? "" : "priority-book"}, {"entry_id", global ? "" : "priority-a"},
                {"book_index", global ? -1 : 0}, {"entry_index", global ? -1 : 0},
                {"code", global ? "snapshot_unavailable" : state == "unavailable" ? "not-a-known-code" : "invalid_regex"}});
        }
        const QJsonObject diagnostics{{"persona_id", persona}, {"revision", 4}, {"request_id", request},
            {"entries", records}, {"truncated", state == "truncated" ? 2 : 0}};
        m_bridge->event({{"type", "archive:result"}, {"request_id", id}, {"payload", QJsonObject{
            {"ok", true}, {"exists", true}, {"revision", 4}, {"archive", archive}, {"checksum", "fixture-checksum"},
            {"persona_id", persona}, {"world_book_diagnostics", diagnostics}}}});
        auto *text = m_panel->findChild<QQuickItem *>("worldbookRegexDiagnostics"); QVERIFY(text && text->isVisible());
        QCOMPARE(text->property("diagnosticStatus").toString(), state);
        QCOMPARE(text->property("textFormat").toInt(), int(Qt::PlainText));
        QVERIFY(!text->property("text").toString().isEmpty());
        if (state == "entry-error") QVERIFY(text->property("text").toString().contains("无效"));
        if (state == "unrun") QVERIFY(text->property("text").toString().contains("本版本尚无运行诊断"));
        QElapsedTimer clock; clock.start(); QVERIFY(prepareRegexViewport(text, clock));
        QVERIFY(NativeControlReadiness::wholeVisibility(text, m_window.get()).value("fullyVisible").toBool());
        QCOMPARE(rendererCommandCount("archive:put"), 0); QVERIFY(clock.elapsed() < 4000);
    }

    void archiveFocusRealHostTraversal_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<QString>("mode");
        QTest::addColumn<QString>("start");
        QTest::newRow("wide-entry-inherit-title") << 1380 << "inherit" << "worldbookName";
        QTest::newRow("compact-entry-inherit-title") << 950 << "inherit" << "worldbookName";
        QTest::newRow("narrow-entry-inherit-title") << 760 << "inherit" << "worldbookName";
        QTest::newRow("wide-entry-custom-spinbox") << 1380 << "custom" << "worldbookEntryScanDepth";
        QTest::newRow("compact-entry-custom-spinbox") << 950 << "custom" << "worldbookEntryTokenBudget";
        QTest::newRow("narrow-entry-custom-spinbox") << 760 << "custom" << "worldbookEntryScanDepth";
        QTest::newRow("wide-book-spinbox") << 1380 << "book" << "worldbookScanDepth";
        QTest::newRow("compact-book-checkbox") << 950 << "book" << "worldbookRecursiveScanning";
        QTest::newRow("narrow-book-spinbox") << 760 << "book" << "worldbookBookTokenBudget";
        QTest::newRow("wide-regex-readonly-fields") << 1380 << "regex" << "worldbookName";
        QTest::newRow("compact-legacy-readonly-fields") << 950 << "legacy" << "worldbookName";
        QTest::newRow("narrow-loading-no-save") << 760 << "loading" << "worldbookName";
        QTest::newRow("wide-long-body-backtab") << 1380 << "long" << "worldbookContent";
        QTest::newRow("compact-long-body-backtab") << 950 << "long" << "worldbookContent";
        QTest::newRow("narrow-long-body-backtab") << 760 << "long" << "worldbookContent";
    }
    void archiveFocusRealHostTraversal() {
        QFETCH(int, width); QFETCH(QString, mode); QFETCH(QString, start);
        const QJsonValue null(QJsonValue::Null);
        auto archive = entrySettingsFixtureArchive(mode == "custom" ? QJsonValue(5) : mode == "legacy" ? QJsonValue(201) : null,
            mode == "custom" ? QJsonValue(50) : mode == "legacy" ? QJsonValue(4001) : null);
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        if (mode == "regex") entry["useRegex"] = true;
        if (mode == "long") entry["content"] = QString("Caret preservation line.\n").repeated(90);
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(archive, width, mode != "book", true));
        if (mode == "loading") m_archive->reloadDiscardingDraft();
        auto *control = m_panel->findChild<QQuickItem *>(start);
        QVERIFY(control && control->isVisible() && control->isEnabled());
        const QString tag = QString::fromUtf8(QTest::currentDataTag());
        const bool exportCase = tag == "wide-entry-inherit-title" || tag == "compact-entry-custom-spinbox" || tag == "narrow-long-body-backtab";
        archiveHostTraceTraversal(control, exportCase ? tag : QString());
    }
    void archiveFocusHostCaretPreservesSelection_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<int>("position");
        QTest::newRow("wide-long-first") << 1380 << 0;
        QTest::newRow("compact-long-middle") << 950 << 1100;
        QTest::newRow("narrow-long-last") << 760 << 2100;
    }
    void archiveFocusHostCaretPreservesSelection() {
        QFETCH(int, width); QFETCH(int, position);
        auto archive = entrySettingsFixtureArchive(QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Null));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["content"] = QString("Caret preservation line.\n").repeated(100);
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(archive, width, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent"); QVERIFY(body);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        body->setProperty("cursorPosition", position);
        QVERIFY(QMetaObject::invokeMethod(body, "select", Q_ARG(int, position), Q_ARG(int, position + 5)));
        QTest::qWait(60); // Initial native caret setup; no delay follows the focus assertion below.
        const auto state = archiveFocusDraftState();
        const auto start = body->property("selectionStart"), end = body->property("selectionEnd"), cursor = body->property("cursorPosition");
        auto *bodyScroll = m_panel->findChild<QQuickItem *>("worldbook-content-scroll"); QVERIFY(bodyScroll);
        auto *inner = bodyScroll->property("contentItem").value<QQuickItem *>(); QVERIFY(inner);
        const auto innerY = inner->property("contentY");
        const auto cursorBefore = body->mapRectToScene(body->property("cursorRectangle").toRectF());
        archiveFocusDiagnostic("initial-caret-visibility", body);
        QVERIFY(!cursorBefore.intersected(NativeControlReadiness::visibleRect(inner, m_window.get())).isEmpty());
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName"); QVERIFY(title);
        archiveFocusDiagnostic("selection-return-action-boundary", body);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        const auto beforeBlur = ArchiveFocusProbe::selection(body);
        title->forceActiveFocus(Qt::TabFocusReason);
        const auto afterBlur = ArchiveFocusProbe::selection(body);
        archiveFocusDiagnostic("selection-after-blur", body);
        body->forceActiveFocus(Qt::BacktabFocusReason);
        const auto afterReturn = ArchiveFocusProbe::selection(body);
        archiveFocusDiagnostic("selection-after-return", body);
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", "selection-focus-return"},
            {"beforeBlur", beforeBlur}, {"afterBlur", afterBlur}, {"afterReturn", afterReturn},
            {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QCOMPARE(body->property("selectionStart"), start); QCOMPARE(body->property("selectionEnd"), end);
        QCOMPARE(body->property("cursorPosition"), cursor);
        QCOMPARE(inner->property("contentY"), innerY);
        const auto cursorAfter = body->mapRectToScene(body->property("cursorRectangle").toRectF());
        QVERIFY(!cursorAfter.intersected(NativeControlReadiness::visibleRect(inner, m_window.get())).isEmpty());
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostRestorationAndSuppression_data() {
        QTest::addColumn<QString>("scenario");
        QTest::newRow("palette-return") << "palette";
        QTest::newRow("popup-suppresses-background") << "popup";
        QTest::newRow("modal-cancel-preserves-draft") << "modal";
        QTest::newRow("mouse-held-no-reposition") << "mouse";
        QTest::newRow("wheel-offset-not-pulled-back") << "wheel";
        QTest::newRow("close-reopen-start") << "reopen";
        QTest::newRow("hidden-does-not-reveal") << "hidden";
        QTest::newRow("disabled-does-not-reveal") << "disabled";
        QTest::newRow("scope-change-invalidates-palette") << "scope";
        QTest::newRow("entry-change-invalidates-palette") << "entry";
        QTest::newRow("owner-replacement-invalidates-palette") << "replacement";
    }
    void archiveFocusHostRestorationAndSuppression() {
        QFETCH(QString, scenario);
        auto archive = entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50));
        if (scenario == "wheel") {
            auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
            auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
            entry["content"] = QString("Wheel capacity remains inside the actual body viewport.\n").repeated(100);
            entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        }
        QVERIFY(loadArchiveDrawer(archive, 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *outer = archiveFormFlickable();
        QVERIFY(body && title && outer);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        if (scenario == "modal") m_archive->setComment("unsaved but preserved");
        const auto state = archiveFocusDraftState();
        archiveFocusDiagnostic("restoration-action-boundary", body);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        std::unique_ptr<ArchiveVisualSubtreeLease> replacementLease;
        std::unique_ptr<QQuickItem> replacement;
        if (scenario == "palette" || scenario == "scope" || scenario == "entry" || scenario == "replacement") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openPalette"));
            auto *navigation = m_window->findChild<QObject *>("sceneNavigation");
            QVERIFY(navigation && navigation->property("paletteOpen").toBool());
            outer->setProperty("contentY", 0.);
            if (scenario == "scope") {
                m_bridge->m_persona["epoch"] = 4; emit m_bridge->changed();
            } else if (scenario == "entry") m_archive->selectEntry({});
            else if (scenario == "replacement") {
                // Keep the original TextArea together with its managed
                // Flickable while orphaning it from the current visual tree.
                // A separate same-name target must never alias that owner.
                auto *bodyScroll = m_panel->findChild<QQuickItem *>("worldbook-content-scroll"); QVERIFY(bodyScroll);
                replacementLease = std::make_unique<ArchiveVisualSubtreeLease>(bodyScroll, body);
                QVERIFY(replacementLease->valid());
                QVERIFY(replacementLease->moveTo(nullptr));
                QVERIFY(!body->window());
                replacement = std::make_unique<QQuickItem>(m_panel);
                replacement->setObjectName("worldbookContent"); replacement->setSize(QSizeF(200, 40));
                replacement->setActiveFocusOnTab(true);
                qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
                    {"stage", "replacement-original-detached"}, {"structure", replacementLease->snapshot()},
                    {"sameName", replacement->objectName() == body->objectName()}, {"differentInstance", replacement.get() != body}});
            }
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "cancelPalette"));
            if (replacement) {
                QVERIFY(replacement->isVisible() && replacement->isEnabled() && replacement->window() == m_window.get());
                replacement->forceActiveFocus(Qt::OtherFocusReason);
                QVERIFY(m_window->activeFocusItem() == replacement.get());
            }
            QTest::qWait(60); // Actual deferred navigation restoration, not a Tab assertion.
            if (scenario == "palette") {
                QVERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
                QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
            } else QCOMPARE(outer->property("contentY").toDouble(), 0.);
            if (replacement) {
                QVERIFY(m_window->activeFocusItem() == replacement.get());
                QVERIFY(m_window->activeFocusItem() != body);
                QVERIFY(replacementLease->structureIntact());
                QVERIFY(replacementLease->restore());
                qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
                    {"stage", "replacement-original-restored"}, {"structure", replacementLease->snapshot()}});
            }
        } else if (scenario == "popup") {
            auto *selector = m_panel->findChild<QQuickItem *>("worldbookEntrySelector"); QVERIFY(selector);
            auto value = selector->property("popup");
            if (value.metaType() == QMetaType::fromType<QJSValue>()) value = value.value<QJSValue>().toVariant();
            auto *popup = value.value<QObject *>(); QVERIFY(popup);
            QVERIFY(QMetaObject::invokeMethod(popup, "open"));
            QVERIFY(popup->property("visible").toBool());
            outer->setProperty("contentY", 0.);
            title->forceActiveFocus(Qt::OtherFocusReason);
            QVERIFY(m_window->activeFocusItem() == title || title->isAncestorOf(m_window->activeFocusItem()));
            archiveFocusDiagnostic("before-initial-body-focus", body);
            body->forceActiveFocus(Qt::TabFocusReason);
            archiveFocusDiagnostic("after-initial-body-focus", body);
            QVERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
            QVERIFY(QMetaObject::invokeMethod(popup, "close"));
        } else if (scenario == "modal") {
            QVERIFY(QMetaObject::invokeMethod(m_panel, "requestReload"));
            auto *dialog = m_panel->findChild<QObject *>("archive-reload-confirm"); QVERIFY(dialog);
            QTRY_VERIFY(dialog->property("visible").toBool());
            outer->setProperty("contentY", 0.);
            title->forceActiveFocus(Qt::OtherFocusReason);
            QVERIFY(m_window->activeFocusItem() == title || title->isAncestorOf(m_window->activeFocusItem()));
            archiveFocusDiagnostic("before-initial-body-focus", body);
            body->forceActiveFocus(Qt::TabFocusReason);
            archiveFocusDiagnostic("after-initial-body-focus", body);
            QVERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
            QVERIFY(QMetaObject::invokeMethod(dialog, "reject"));
            QTest::qWait(60);
            QVERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
            QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
        } else if (scenario == "reopen") {
            archiveFocusDiagnostic("reopen-nonzero-offset-baseline", body);
            QVERIFY(outer->property("contentY").toDouble() > 0.);
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "closeArchive"));
            auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal"); QVERIFY(portal);
            QTRY_VERIFY(!portal->property("contentReady").toBool());
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
            QTRY_VERIFY(portal->property("contentReady").toBool());
            qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", "close-reopen"},
                {"outerY", outer->property("contentY")}, {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
        } else if (scenario == "mouse") {
            const auto point = NativeControlReadiness::visibleRect(body, m_window.get()).center().toPoint();
            QTest::mousePress(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
            const auto heldOffset = outer->property("contentY");
            title->forceActiveFocus(Qt::TabFocusReason);
            const auto after = outer->property("contentY");
            const auto held = ArchiveFocusProbe::causalSnapshot(m_panel);
            qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", "mouse-held-focus"},
                {"beforeY", heldOffset}, {"afterY", after}, {"causal", held}});
            QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
            QCOMPARE(after, heldOffset);
        } else if (scenario == "wheel") {
            const auto point = NativeControlReadiness::visibleRect(body, m_window.get()).center().toPoint();
            auto *bodyScroll = m_panel->findChild<QQuickItem *>("worldbook-content-scroll"); QVERIFY(bodyScroll);
            auto *inner = bodyScroll->property("contentItem").value<QQuickItem *>(); QVERIFY(inner);
            const auto beforeWheel = QPointF(outer->property("contentY").toDouble(), inner->property("contentY").toDouble());
            const auto innerMinimum = inner->property("originY").toDouble();
            const auto innerMaximum = innerMinimum + std::max(0., inner->property("contentHeight").toDouble() - inner->height());
            QVERIFY(innerMaximum - beforeWheel.y() > 24.);
            QVERIFY(NativeControlReadiness::visibleRect(inner, m_window.get()).contains(point));
            qInfo().noquote() << "ARCHIVE_WHEEL_OBSERVATION" << ArchiveFocusProbe::json({
                {"stage", "before-dispatch"}, {"angleDeltaY", -120}, {"point", QVariantMap{{"x", point.x()}, {"y", point.y()}}},
                {"innerMinimumY", innerMinimum}, {"innerMaximumY", innerMaximum},
                {"innerContentHeight", inner->property("contentHeight")}, {"innerViewportHeight", inner->height()},
                {"outerY", beforeWheel.x()}, {"innerY", beforeWheel.y()}, {"pointInsideActualViewport", true}});
            // Same window-local/global coordinates used by QTest::wheelEvent,
            // with the real window delivery retained. The stack event lets us
            // observe accepted after delivery without intercepting the event.
            QWheelEvent wheel(QPointF(point), m_window->mapToGlobal(QPointF(point)), QPoint(), QPoint(0, -120),
                Qt::NoButton, Qt::NoModifier, Qt::NoScrollPhase, false);
            wheel.setAccepted(false);
            QCoreApplication::sendEvent(m_window.get(), &wheel);
            qInfo().noquote() << "ARCHIVE_WHEEL_OBSERVATION" << ArchiveFocusProbe::json({
                {"stage", "after-dispatch"}, {"accepted", wheel.isAccepted()},
                {"outerY", outer->property("contentY")}, {"innerY", inner->property("contentY")}});
            QElapsedTimer wheelClock; wheelClock.start();
            QPointF lastOffsets = beforeWheel; qint64 changedAt = 0;
            // Flickable's actual wheel animation may continue after dispatch.
            // Settle it before checking pullback; no event wait is added to Tab.
            QVERIFY(QTest::qWaitFor([&] {
                const QPointF now(outer->property("contentY").toDouble(), inner->property("contentY").toDouble());
                if (std::abs(now.x() - lastOffsets.x()) > .01 || std::abs(now.y() - lastOffsets.y()) > .01) {
                    lastOffsets = now; changedAt = wheelClock.elapsed();
                }
                return now.y() > beforeWheel.y() && wheelClock.elapsed() - changedAt >= 80;
            }, 1500));
            const auto afterWheel = lastOffsets;
            archiveFocusDiagnostic("wheel-real-offset-settled", body);
            QTest::qWait(60);
            qInfo().noquote() << "ARCHIVE_WHEEL_OBSERVATION" << ArchiveFocusProbe::json({
                {"stage", "no-pullback"}, {"accepted", wheel.isAccepted()},
                {"outerBeforeY", beforeWheel.x()}, {"innerBeforeY", beforeWheel.y()},
                {"outerSettledY", afterWheel.x()}, {"innerSettledY", afterWheel.y()},
                {"outerY", outer->property("contentY")}, {"innerY", inner->property("contentY")}});
            QCOMPARE(QPointF(outer->property("contentY").toDouble(), inner->property("contentY").toDouble()), afterWheel);
            QVERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
        } else {
            if (scenario == "hidden") m_panel->setVisible(false); else m_panel->setEnabled(false);
            outer->setProperty("contentY", 0.);
            title->forceActiveFocus(Qt::TabFocusReason); body->forceActiveFocus(Qt::TabFocusReason);
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
        }
        if (scenario != "scope" && scenario != "entry") QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostDeferredRestorationRejectsStale_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("focus-away-and-back-before-flush") << "blur";
        QTest::newRow("same-scope-runtime-generation-before-flush") << "generation";
        QTest::newRow("entry-navigation-before-flush") << "entry";
        QTest::newRow("drawer-hidden-before-flush") << "hidden";
        QTest::newRow("task-page-change-before-flush") << "page";
        QTest::newRow("selector-popup-before-flush") << "popup";
        QTest::newRow("window-reparent-before-flush") << "window";
    }
    void archiveFocusHostDeferredRestorationRejectsStale() {
        QFETCH(QString, change);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *outer = archiveFormFlickable(); QVERIFY(body && title && outer);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        auto unbox = [](QVariant value) {
            return value.metaType() == QMetaType::fromType<QJSValue>() ? value.value<QJSValue>().toVariant() : value;
        };
        QVariant snapshot;
        QVERIFY(QMetaObject::invokeMethod(m_panel, "focusRestoreSnapshot", Q_RETURN_ARG(QVariant, snapshot),
            Q_ARG(QVariant, QVariant::fromValue(body))));
        const auto initial = unbox(snapshot).toMap();
        QCOMPARE(initial.value("owner").value<QObject *>(), body);
        QCOMPARE(initial.value("window").value<QObject *>(), m_window.get());
        QVERIFY(!initial.value("content").toString().isEmpty());
        // A valid unmodified control must reveal first. Invalid snapshot or
        // queueing is a failed precondition, never a passing stale negative.
        outer->setProperty("contentY", 0.);
        QVERIFY(QMetaObject::invokeMethod(m_panel, "queueDialogFocusRestore", Q_ARG(QVariant, snapshot)));
        QVERIFY(unbox(m_panel->property("pendingFocusRestore")).toMap().value("returned").toBool());
        QVERIFY(m_panel->property("focusRestoreQueued").toBool());
        QTest::qWait(60);
        QVERIFY(outer->property("contentY").toDouble() > 0.);
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QVERIFY(QMetaObject::invokeMethod(m_panel, "focusRestoreSnapshot", Q_RETURN_ARG(QVariant, snapshot),
            Q_ARG(QVariant, QVariant::fromValue(body))));
        QCOMPARE(unbox(snapshot).toMap().value("owner").value<QObject *>(), body);
        outer->setProperty("contentY", 0.);
        const auto state = archiveFocusDraftState();
        auto otherWindow = std::make_unique<QQuickWindow>();
        auto holder = std::make_unique<QQuickItem>(otherWindow->contentItem());
        auto *originalParent = m_panel->parentItem(); QVERIFY(originalParent);
        holder->setSize(originalParent->size());
        ArchiveVisualSubtreeLease restoreParent(m_panel, body);
        QVERIFY(restoreParent.valid());
        // The positive baseline above has its own complete observation. Start
        // a fresh bounded action record before queueing the invalidated copy,
        // so its rejection cannot be hidden by entry/preparation events.
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        archiveFocusDiagnostic("stale-restore-before-queue", body);
        QVERIFY(QMetaObject::invokeMethod(m_panel, "queueDialogFocusRestore", Q_ARG(QVariant, snapshot)));
        QVERIFY(unbox(m_panel->property("pendingFocusRestore")).toMap().value("returned").toBool());
        QVERIFY(m_panel->property("focusRestoreQueued").toBool());
        archiveFocusDiagnostic("stale-restore-before-mutation", body);
        if (change == "blur") {
            title->forceActiveFocus(Qt::OtherFocusReason);
            body->forceActiveFocus(Qt::OtherFocusReason);
        } else if (change == "generation") {
            ++m_bridge->m_generation; emit m_bridge->changed();
        } else if (change == "entry") m_archive->selectEntry({});
        else if (change == "page") {
            auto *navigation = m_window->findChild<QObject *>("sceneNavigation"); QVERIFY(navigation);
            QVERIFY(QMetaObject::invokeMethod(navigation, "open", Q_ARG(QVariant, "memory"),
                Q_ARG(QVariant, "memories"), Q_ARG(QVariant, QVariant())));
        } else if (change == "popup") {
            auto *selector = m_panel->findChild<QQuickItem *>("worldbookEntrySelector"); QVERIFY(selector);
            auto value = selector->property("popup");
            if (value.metaType() == QMetaType::fromType<QJSValue>()) value = value.value<QJSValue>().toVariant();
            auto *popup = value.value<QObject *>(); QVERIFY(popup);
            QVERIFY(QMetaObject::invokeMethod(popup, "open"));
        } else if (change == "window") {
            otherWindow->resize(m_window->size());
            QVERIFY(restoreParent.moveTo(holder.get()));
            QVERIFY(body->window() == otherWindow.get());
            body->forceActiveFocus(Qt::OtherFocusReason);
        } else m_panel->setVisible(false);
        archiveFocusDiagnostic("stale-restore-after-mutation", body);
        QTest::qWait(60);
        archiveFocusDiagnostic("stale-restore-after-flush", body);
        QCOMPARE(outer->property("contentY").toDouble(), 0.);
        if (change != "entry") QCOMPARE(archiveFocusDraftState(), state);
        auto pending = m_panel->property("pendingFocusRestore");
        if (pending.metaType() == QMetaType::fromType<QJSValue>()) pending = pending.value<QJSValue>().toVariant();
        QVERIFY(!pending.isValid() || pending.isNull());
        QVERIFY(!m_panel->property("focusRestoreQueued").toBool());
        QVERIFY(restoreParent.structureIntact());
        QVERIFY(restoreParent.restore());
        holder.reset();
        otherWindow.reset();
        QVERIFY(restoreParent.structureIntact());
        QVERIFY(body->window() == m_window.get());
        qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
            {"stage", "stale-restore-auxiliary-destroyed"}, {"structure", restoreParent.snapshot()}});
    }
    void archiveFocusHostResizeAndReflow_data() {
        QTest::addColumn<bool>("resize");
        QTest::newRow("wide-to-narrow-then-real-tab") << true;
        QTest::newRow("inherit-to-custom-reflow-then-real-tab") << false;
    }
    void archiveFocusHostResizeAndReflow() {
        QFETCH(bool, resize);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(QJsonValue::Null), QJsonValue(QJsonValue::Null)), 1380, true, true));
        if (resize) m_window->resize(760, 650);
        else {
            m_archive->setEntrySettingInherited("scanDepth", false);
            m_archive->setEntrySettingInherited("tokenBudget", false);
        }
        QTest::qWait(60); // Settle the layout change before starting the unchanged immediate key contract.
        archiveHostTraceTraversal(m_panel->findChild<QQuickItem *>("worldbookName"));
    }
    void archiveFocusHostAnimatedTraversal_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<QString>("start");
        QTest::newRow("normal-wide-inherit-title") << 1380 << "worldbookName";
        QTest::newRow("normal-compact-custom-spinbox") << 950 << "worldbookEntryScanDepth";
        QTest::newRow("normal-narrow-long-body") << 760 << "worldbookContent";
    }
    void archiveFocusHostAnimatedTraversal() {
        QFETCH(int, width); QFETCH(QString, start);
        auto archive = entrySettingsFixtureArchive(width == 1380 ? QJsonValue(QJsonValue::Null) : QJsonValue(5),
            width == 1380 ? QJsonValue(QJsonValue::Null) : QJsonValue(50));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["content"] = QString("Caret preservation line.\n").repeated(100);
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(archive, width, true, true, false));
        archiveHostTraceTraversal(m_panel->findChild<QQuickItem *>(start));
    }
    void archiveFocusHostSynchronousReflow_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("window-shrinks-before-next-key") << "window";
        QTest::newRow("inheritance-controls-reflow") << "inherit";
        QTest::newRow("book-entry-shape-reflow") << "book";
        QTest::newRow("read-error-feedback-height-reflow") << "feedback";
        QTest::newRow("readonly-details-expansion-reflow") << "details";
        QTest::newRow("loading-hidden-save-eligibility") << "loading";
        QTest::newRow("body-view-resize-keeps-caret") << "body";
    }
    void archiveFocusHostSynchronousReflow() {
        QFETCH(QString, change);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 1380, true, true));
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName"); QVERIFY(title);
        archiveFocusDiagnostic("before-initial-title-focus", title);
        title->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-title-focus", title);
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        QVariant cursorBefore;
        if (change == "body") {
            QVERIFY(body);
            archiveFocusDiagnostic("before-initial-body-focus", body);
            body->forceActiveFocus(Qt::TabFocusReason);
            archiveFocusDiagnostic("after-initial-body-focus", body);
            cursorBefore = body->property("cursorPosition");
        }
        archiveFocusDiagnostic("reflow-action-boundary", change == "body" ? body : title);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        if (change == "window" || change == "body") m_window->resize(760, 650);
        else if (change == "inherit") {
            m_archive->setEntrySettingInherited("scanDepth", true);
            m_archive->setEntrySettingInherited("tokenBudget", true);
        } else if (change == "book") m_archive->selectEntry({});
        else if (change == "details") QVERIFY(m_panel->setProperty("detailsExpanded", true));
        else if (change == "feedback") {
            m_archive->reloadDiscardingDraft();
            const auto readId = lastRendererCommand("archive:get")["request_id"].toString();
            QVERIFY(!readId.isEmpty());
            m_archive->failed(readId, "deadline", m_bridge->generation());
            QCOMPARE(m_archive->status(), QString("error"));
        } else m_archive->reloadDiscardingDraft();
        const auto state = archiveFocusDraftState();
        if (change == "body") {
            auto *scroll = m_panel->findChild<QQuickItem *>("worldbook-content-scroll"); QVERIFY(scroll);
            auto *inner = scroll->property("contentItem").value<QQuickItem *>(); QVERIFY(inner);
            const auto caret = body->mapRectToScene(body->property("cursorRectangle").toRectF());
            archiveFocusDiagnostic("reflow-caret-before-key", body);
            QCOMPARE(body->property("cursorPosition"), cursorBefore);
            QVERIFY(!caret.intersected(NativeControlReadiness::visibleRect(inner, m_window.get())).isEmpty());
        }
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        QTest::keyClick(m_window.get(), change == "body" ? Qt::Key_Backtab : Qt::Key_Tab);
        ArchiveFocusProbe probe;
        const auto snapshot = probe.snapshot(m_window.get(), m_panel);
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", change},
            {"after", snapshot}, {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        auto *leaf = m_window->activeFocusItem();
        QVERIFY(leaf && leaf->isVisible() && leaf->isEnabled());
        QVERIFY(!NativeControlReadiness::visibleRect(leaf, m_window.get()).isEmpty());
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostSelectionLifecycle_data() {
        QTest::addColumn<QString>("change");
        QTest::newRow("same-entry-reopen-retains-selection-and-resets-outer") << "reopen";
        QTest::newRow("entry-change-discards-selection") << "entry";
        QTest::newRow("book-change-discards-selection") << "book";
        QTest::newRow("persona-change-discards-selection") << "scope";
        QTest::newRow("authoritative-content-replacement-discards-selection") << "replacement";
    }
    void archiveFocusHostSelectionLifecycle() {
        QFETCH(QString, change);
        auto archive = entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["content"] = QString("Selection lifecycle line.\n").repeated(100);
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(archive, 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent"); QVERIFY(body);
        auto *outer = archiveFormFlickable(); QVERIFY(outer);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        QVERIFY(QMetaObject::invokeMethod(body, "select", Q_ARG(int, 1100), Q_ARG(int, 1110)));
        const auto selection = ArchiveFocusProbe::selection(body);
        const auto writes = rendererCommandCount("archive:put");
        archiveFocusDiagnostic("selection-lifecycle-action-boundary", body);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        if (change == "reopen") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "closeArchive"));
            auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal"); QVERIFY(portal);
            QTRY_VERIFY(!portal->property("contentReady").toBool());
            qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", "closed-selection"},
                {"before", selection}, {"after", ArchiveFocusProbe::selection(body)},
                {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
            QCOMPARE(ArchiveFocusProbe::selection(body), selection);
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
            QTRY_VERIFY(portal->property("contentReady").toBool());
        } else if (change == "entry") m_archive->selectEntry({});
        else if (change == "book") m_archive->selectBook({});
        else if (change == "scope") {
            m_bridge->m_persona["epoch"] = 7; emit m_bridge->changed();
        } else {
            m_archive->reloadDiscardingDraft();
            entry["content"] = QString("Authoritatively replaced body.\n").repeated(80);
            entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
            priorityFixtureResponse(lastRendererCommand("archive:get")["request_id"].toString(), archive, 5);
        }
        const auto after = ArchiveFocusProbe::selection(body);
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", change},
            {"before", selection}, {"after", after}, {"outerY", outer->property("contentY")},
            {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        if (change == "reopen") {
            QCOMPARE(after, selection);
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
        } else QCOMPARE(body->property("selectionStart"), body->property("selectionEnd"));
        QCOMPARE(rendererCommandCount("archive:put"), writes);
    }
    void archiveFocusHostHeldInputBoundaries_data() {
        QTest::addColumn<QString>("kind");
        QTest::newRow("accepted-left-press-keeps-offset") << "left";
        QTest::newRow("accepted-right-press-keeps-offset") << "right";
        QTest::newRow("multiple-buttons-partial-release-keeps-offset") << "multi";
        QTest::newRow("drag-selection-does-not-reposition") << "drag";
        QTest::newRow("touch-contact-keeps-offset") << "touch";
        QTest::newRow("touch-cancel-clears-state-without-reveal") << "cancel";
        QTest::newRow("deactivate-clears-state-without-reveal") << "deactivate";
        QTest::newRow("lost-mouse-grab-clears-intent-without-reveal") << "lost-grab";
    }
    void archiveFocusHostHeldInputBoundaries() {
        QFETCH(QString, kind);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *observer = m_panel->findChild<WindowInputState *>("archiveWindowInputState");
        auto *outer = archiveFormFlickable(); QVERIFY(body && title && observer && outer);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        const auto point = NativeControlReadiness::visibleRect(body, m_window.get()).center().toPoint();
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        const auto state = archiveFocusDraftState();
        archiveFocusDiagnostic("held-input-action-boundary", body);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        const bool touch = kind == "touch" || kind == "cancel" || kind == "deactivate";
        auto *device = QTest::createTouchDevice();
        bool touchPressed = false;
        Qt::MouseButtons pressedButtons = Qt::NoButton;
        const auto releaseOnFailure = qScopeGuard([&] {
            if (!touchPressed && pressedButtons == Qt::NoButton) return;
            archiveFocusDiagnostic("held-input-before-failure-cleanup", title);
            if (touchPressed) QTest::touchEvent(m_window.get(), device).release(0, point, m_window.get()).commit();
            for (const auto button : {Qt::LeftButton, Qt::RightButton})
                if (pressedButtons.testFlag(button)) QTest::mouseRelease(m_window.get(), button, Qt::NoModifier, point);
        });
        if (touch) {
            touchPressed = true;
            QTest::touchEvent(m_window.get(), device).press(0, point, m_window.get()).commit();
        } else {
            const auto firstButton = kind == "right" ? Qt::RightButton : Qt::LeftButton;
            pressedButtons |= firstButton;
            QTest::mousePress(m_window.get(), firstButton, Qt::NoModifier, point);
            if (kind == "multi") {
                pressedButtons |= Qt::RightButton;
                QTest::mousePress(m_window.get(), Qt::RightButton, Qt::NoModifier, point);
                QTest::mouseRelease(m_window.get(), Qt::LeftButton, Qt::NoModifier, point);
                pressedButtons &= ~Qt::MouseButtons(Qt::LeftButton);
            }
            if (kind == "drag") QTest::mouseMove(m_window.get(), point + QPoint(12, 0));
        }
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", "input-pressed"},
            {"held", observer->held()}, {"buttons", observer->mouseButtons()}, {"touches", observer->touchCount()},
            {"outerY", outer->property("contentY")}, {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        QVERIFY(observer->held());
        const auto heldOffset = outer->property("contentY");
        title->forceActiveFocus(Qt::TabFocusReason);
        const auto afterFocus = outer->property("contentY");
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", kind},
            {"held", observer->held()}, {"buttons", observer->mouseButtons()}, {"touches", observer->touchCount()},
            {"beforeY", heldOffset}, {"afterY", afterFocus}, {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        if (kind == "cancel" || kind == "deactivate" || kind == "lost-grab") {
            if (kind == "cancel") {
                QTouchEvent cancelled(QEvent::TouchCancel, device, Qt::NoModifier, QList<QEventPoint>{});
                QCoreApplication::sendEvent(m_window.get(), &cancelled);
            } else {
                QEvent cancelled(kind == "lost-grab" ? QEvent::UngrabMouse : QEvent::WindowDeactivate);
                QCoreApplication::sendEvent(m_window.get(), &cancelled);
            }
            QCOMPARE(observer->touchCount(), 0);
        }
        if (touch) {
            QTest::touchEvent(m_window.get(), device).release(0, point, m_window.get()).commit();
            touchPressed = false;
        } else {
            QTest::mouseRelease(m_window.get(), kind == "right" || kind == "multi" ? Qt::RightButton : Qt::LeftButton,
                Qt::NoModifier, point);
            pressedButtons = Qt::NoButton;
        }
        QCOMPARE(afterFocus, heldOffset);
        QTRY_VERIFY(!observer->held());
        QCOMPARE(outer->property("contentY"), heldOffset);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostNavigationCompletion_data() {
        QTest::addColumn<QString>("scenario"); QTest::addColumn<bool>("reduced");
        QTest::newRow("normal-close-reopen-top") << "reopen" << false;
        QTest::newRow("reduced-close-reopen-top") << "reopen" << true;
        QTest::newRow("palette-current-destination-restores") << "palette-current" << true;
        QTest::newRow("palette-focus-callback-cannot-steal-new-focus") << "palette-stale" << true;
        QTest::newRow("page-restore-callback-cannot-steal-new-focus") << "page-stale" << true;
        QTest::newRow("palette-target-reparent-rejects-old-window") << "palette-reparent" << true;
        QTest::newRow("reduced-toggle-during-opening-notifies-once") << "motion-toggle" << false;
        QTest::newRow("drag-cancel-new-settle-notifies-once") << "drag-cancel" << true;
    }
    void archiveFocusHostNavigationCompletion() {
        QFETCH(QString, scenario); QFETCH(bool, reduced);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true, reduced));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *outer = archiveFormFlickable(); auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        QVERIFY(body && title && outer && portal);
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation"); QVERIFY(navigation);
        archiveFocusDiagnostic("before-initial-body-focus", body);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("after-initial-body-focus", body);
        const auto before = archiveFocusDraftState();
        QSignalSpy opened(portal, SIGNAL(opened())); QVERIFY(opened.isValid());
        archiveFocusDiagnostic("navigation-action-boundary", body);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        if (scenario == "palette-current" || scenario == "palette-stale") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openPalette"));
            QVERIFY(m_window->findChild<QQuickItem *>("sceneCommandPalette"));
            if (scenario == "palette-current") {
                archiveFocusDiagnostic("before-palette-search", m_window->findChild<QQuickItem *>("scene-search"));
                QTRY_VERIFY(m_window->findChild<QQuickItem *>("scene-search")->hasActiveFocus());
                archiveFocusDiagnostic("palette-search-acquired", m_window->findChild<QQuickItem *>("scene-search"));
                QVERIFY(QMetaObject::invokeMethod(m_window.get(), "chooseCurrentPaletteDestination"));
                QTRY_VERIFY(m_window->activeFocusItem() == body || body->isAncestorOf(m_window->activeFocusItem()));
                QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
            } else {
                auto *search = m_window->findChild<QQuickItem *>("scene-search");
                archiveFocusDiagnostic("palette-stale-valid-search-baseline", search);
                QVERIFY(search && search->isVisible() && search->isEnabled());
                QTRY_VERIFY(search->hasActiveFocus());
                const auto pendingBefore = navigation->property("focusRequestRevision").toInt();
                QVariant pending;
                QVERIFY(QMetaObject::invokeMethod(navigation, "deferFocusItem", Q_RETURN_ARG(QVariant, pending),
                    Q_ARG(QVariant, QVariant::fromValue(search)), Q_ARG(QVariant, int(Qt::ShortcutFocusReason)),
                    Q_ARG(QVariant, true), Q_ARG(QVariant, QString()), Q_ARG(QVariant, QVariant())));
                QVERIFY(navigation->property("focusRequestRevision").toInt() > pendingBefore);
                auto *newTarget = m_window->findChild<QQuickItem *>("palette-close");
                archiveFocusDiagnostic("palette-later-target-before-acquire", newTarget);
                QVERIFY(newTarget && newTarget->isVisible() && newTarget->isEnabled());
                QVERIFY(newTarget->window() == m_window.get());
                newTarget->forceActiveFocus(Qt::TabFocusReason);
                archiveFocusDiagnostic("palette-later-target-acquired", newTarget);
                QVERIFY(m_window->activeFocusItem() == newTarget || newTarget->isAncestorOf(m_window->activeFocusItem()));
                QTest::qWait(60); // Drain only deferred navigation; never relax a Tab visibility assertion.
                archiveFocusDiagnostic("palette-later-target-after-drain", newTarget);
                QVERIFY(m_window->activeFocusItem() == newTarget || newTarget->isAncestorOf(m_window->activeFocusItem()));
            }
        } else if (scenario == "palette-reparent") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openPalette"));
            archiveFocusDiagnostic("before-palette-search", m_window->findChild<QQuickItem *>("scene-search"));
            QTRY_VERIFY(m_window->findChild<QQuickItem *>("scene-search")->hasActiveFocus());
            archiveFocusDiagnostic("palette-search-acquired", m_window->findChild<QQuickItem *>("scene-search"));
            const auto oldY = outer->property("contentY");
            auto otherWindow = std::make_unique<QQuickWindow>();
            auto holder = std::make_unique<QQuickItem>(otherWindow->contentItem());
            auto *originalParent = m_panel->parentItem(); QVERIFY(originalParent);
            holder->setSize(originalParent->size());
            otherWindow->resize(m_window->size());
            ArchiveVisualSubtreeLease restore(m_panel, body);
            QVERIFY(restore.valid());
            QSignalSpy restored(navigation, SIGNAL(focusRestored(QVariant,QString)));
            QVERIFY(restored.isValid());
            const auto requestRevision = navigation->property("focusRequestRevision").toInt();
            QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
            archiveFocusDiagnostic("palette-reparent-before-cancel", body);
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "cancelPalette"));
            QVERIFY(navigation->property("focusRequestRevision").toInt() > requestRevision);
            // Preserve the TextArea/ScrollView/Flickable association and the
            // drawer's layout size while the actual target changes windows.
            QVERIFY(restore.moveTo(holder.get()));
            QVERIFY(body->window() == otherWindow.get());
            QVERIFY(restore.structureIntact());
            qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
                {"stage", "palette-target-foreign-window"}, {"structure", restore.snapshot()},
                {"outerY", outer->property("contentY")}, {"targetWindowChanged", body->window() != m_window.get()}});
            QTest::qWait(60);
            archiveFocusDiagnostic("palette-reparent-after-flush", body);
            QCOMPARE(restored.size(), 0);
            QVERIFY(m_window->activeFocusItem() != body);
            QCOMPARE(outer->property("contentY"), oldY);
            const auto causal = ArchiveFocusProbe::causalSnapshot(m_panel);
            bool rejectedForeignWindow = false;
            for (const auto &value : causal.value("events").toList()) {
                const auto event = value.toMap();
                if (event.value("kind") == "navigation-focus-rejected" && event.value("rejectCode").toInt() == 12)
                    rejectedForeignWindow = true;
            }
            QVERIFY(!causal.value("overflow").toBool());
            QVERIFY(rejectedForeignWindow);
            QVERIFY(restore.restore());
            holder.reset();
            otherWindow.reset();
            QVERIFY(restore.structureIntact());
            QVERIFY(body->window() == m_window.get());
            QCOMPARE(outer->property("contentY"), oldY);
            qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
                {"stage", "palette-target-restored-auxiliary-destroyed"}, {"structure", restore.snapshot()}});
        } else if (scenario == "page-stale") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openMemoryPage"));
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
            archiveFocusDiagnostic("page-later-target-before-acquire", title);
            QVERIFY(title->isVisible() && title->isEnabled() && title->window() == m_window.get());
            title->forceActiveFocus(Qt::OtherFocusReason);
            archiveFocusDiagnostic("page-later-target-acquired", title);
            QVERIFY(m_window->activeFocusItem() == title || title->isAncestorOf(m_window->activeFocusItem()));
            QTest::qWait(60);
            QVERIFY(m_window->activeFocusItem() == title || title->isAncestorOf(m_window->activeFocusItem()));
        } else if (scenario == "drag-cancel") {
            QVERIFY(QMetaObject::invokeMethod(portal, "handlePress", Q_ARG(QVariant, QPointF(24, 24))));
            QVERIFY(portal->property("gestureArmed").toBool());
            QVERIFY(QMetaObject::invokeMethod(portal, "cancelDrag"));
            QTRY_COMPARE(opened.size(), 1);
            QTest::qWait(60); QCOMPARE(opened.size(), 1);
        } else {
            archiveFocusDiagnostic("completion-nonzero-offset-baseline", body);
            QVERIFY(outer->property("contentY").toDouble() > 0.);
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "closeArchive"));
            QTRY_VERIFY(!portal->property("contentReady").toBool());
            opened.clear();
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
            if (scenario == "motion-toggle") m_window->setProperty("reducedMotion", true);
            QTRY_VERIFY(portal->property("contentReady").toBool());
            QTRY_COMPARE(opened.size(), 1);
            QTest::qWait(60); QCOMPARE(opened.size(), 1);
            QCOMPARE(outer->property("contentY").toDouble(), 0.);
        }
        qInfo().noquote() << "ARCHIVE_FOCUS_CAUSE" << ArchiveFocusProbe::json({{"action", scenario},
            {"openedCount", opened.size()}, {"outerY", outer->property("contentY")},
            {"causal", ArchiveFocusProbe::causalSnapshot(m_panel)}});
        QCOMPARE(archiveFocusDraftState(), before);
    }
    void archiveFocusHostReparentSubtreeLifecycle_data() {
        QTest::addColumn<QString>("move"); QTest::addColumn<bool>("explicitRestore");
        QTest::newRow("drawer-cross-window-explicit-restore-and-host-destroy") << "drawer" << true;
        QTest::newRow("drawer-cross-window-scope-restore-and-host-destroy") << "drawer" << false;
        QTest::newRow("body-scroll-orphan-roundtrip-and-host-destroy") << "body-scroll" << true;
    }
    void archiveFocusHostReparentSubtreeLifecycle() {
        QFETCH(QString, move); QFETCH(bool, explicitRestore);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        QPointer<QQuickItem> body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *bodyScroll = m_panel->findChild<QQuickItem *>("worldbook-content-scroll");
        QVERIFY(body && bodyScroll);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("subtree-lifecycle-valid-baseline", body);
        QVERIFY(body->hasActiveFocus() && !NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        const auto state = archiveFocusDraftState();
        QPointer<QQuickItem> root = move == "drawer" ? m_panel : bodyScroll;
        QPointer<QQuickItem> oldVisualParent = root->parentItem();
        QVERIFY(oldVisualParent);
        QPointer<QObject> oldObjectParent = root->parent();
        QPointer<QQuickItem> oldLeafVisualParent = body->parentItem();
        const auto rootOwnership = QQmlEngine::objectOwnership(root);
        const auto leafOwnership = QQmlEngine::objectOwnership(body);
        auto otherWindow = std::make_unique<QQuickWindow>();
        otherWindow->resize(m_window->size());
        auto holder = std::make_unique<QQuickItem>(otherWindow->contentItem());
        holder->setSize(oldVisualParent->size());
        QElapsedTimer clock; clock.start();
        {
            ArchiveVisualSubtreeLease lease(root, body);
            QVERIFY(lease.valid());
            QVERIFY(lease.moveTo(move == "drawer" ? holder.get() : nullptr));
            QVERIFY(lease.structureIntact());
            QVERIFY(body->window() == (move == "drawer" ? otherWindow.get() : nullptr));
            qInfo().noquote() << "ARCHIVE_REPARENT_STRUCTURE" << ArchiveFocusProbe::json({
                {"stage", "lifecycle-moved"}, {"structure", lease.snapshot()}, {"scopeRestore", !explicitRestore}});
            if (explicitRestore) QVERIFY(lease.restore());
            // The other row intentionally takes the same lexical exit used
            // by an early assertion, proving the lease restores before the
            // auxiliary window/holder can destroy a visual subtree.
        }
        QVERIFY(root && body);
        QCOMPARE(root->parentItem(), oldVisualParent.data());
        QCOMPARE(root->parent(), oldObjectParent.data());
        QCOMPARE(body->parentItem(), oldLeafVisualParent.data());
        QCOMPARE(QQmlEngine::objectOwnership(root), rootOwnership);
        QCOMPARE(QQmlEngine::objectOwnership(body), leafOwnership);
        QCOMPARE(root->window(), m_window.get()); QCOMPARE(body->window(), m_window.get());
        holder.reset(); otherWindow.reset();
        QVERIFY(root && body);
        QVERIFY(root->window() == m_window.get() && body->window() == m_window.get());
        QCOMPARE(archiveFocusDraftState(), state);
        QPointer<QQuickItem> drawerAlive(m_panel), bodyAlive(body);
        archiveFocusDiagnostic("terminal", body);
        m_archiveFocusDiagnosticUsed = false;
        disconnect(m_archiveFocusDiagnosticFrameConnection);
        m_archiveFocusDiagnosticFrameConnection = {};
        m_panel = nullptr; m_dialog = nullptr;
        m_window.reset();
        QVERIFY(drawerAlive.isNull()); QVERIFY(bodyAlive.isNull());
        QVERIFY(clock.elapsed() < 4000);
    }
    void archiveFocusHostContextTransaction_data() {
        QTest::addColumn<bool>("clearBook");
        QTest::newRow("entry-context-begins-before-publish-and-does-not-replay-old-focus") << false;
        QTest::newRow("book-context-begins-before-publish-and-does-not-replay-old-focus") << true;
    }
    void archiveFocusHostContextTransaction() {
        QFETCH(bool, clearBook);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *outer = archiveFormFlickable();
        QVERIFY(body && title && outer);
        const auto bookKey = m_archive->selectedBookKey();
        const auto entryKey = m_archive->selectedEntryKey();
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("context-transaction-valid-baseline", body);
        QVERIFY(body->hasActiveFocus() && !NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        auto unbox = [](QVariant value) {
            return value.metaType() == QMetaType::fromType<QJSValue>() ? value.value<QJSValue>().toVariant() : value;
        };
        QVariant snapshot;
        QVERIFY(QMetaObject::invokeMethod(m_panel, "focusRestoreSnapshot", Q_RETURN_ARG(QVariant, snapshot),
            Q_ARG(QVariant, QVariant::fromValue(body))));
        QCOMPARE(unbox(snapshot).toMap().value("owner").value<QObject *>(), body);
        outer->setProperty("contentY", 0.);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        QVERIFY(QMetaObject::invokeMethod(m_panel, "queueDialogFocusRestore", Q_ARG(QVariant, snapshot)));
        QVERIFY(m_panel->property("focusRestoreQueued").toBool());
        QVERIFY(unbox(m_panel->property("pendingFocusRestore")).toMap().value("returned").toBool());
        const auto beforeRevision = m_archive->focusContextRevision();
        QVariantList contextEvents;
        bool publishedWhileChanging = false;
        const auto contextConnection = connect(m_archive.get(), &ArchiveEditor::focusContextChanged, this, [&] {
            const bool changing = m_archive->focusContextChanging();
            QVariant guard;
            const bool read = QMetaObject::invokeMethod(m_panel, "focusGuardSnapshot", Q_RETURN_ARG(QVariant, guard),
                Q_ARG(QVariant, QVariant::fromValue(body)));
            const auto beforeY = outer->property("contentY");
            const auto pending = unbox(m_panel->property("pendingFocusRestore"));
            const bool cleared = !pending.isValid() || pending.isNull() || pending.toMap().isEmpty();
            if (changing) {
                // Direct internal focus handoff during the synchronous model
                // transaction must not create a surviving reveal intention.
                title->forceActiveFocus(Qt::OtherFocusReason);
                body->forceActiveFocus(Qt::TabFocusReason);
            }
            contextEvents.append(QVariantMap{{"changing", changing}, {"revision", m_archive->focusContextRevision()},
                {"oldSelectionStillPresent", m_archive->selectedEntryKey() == entryKey}, {"guardRead", read},
                {"rejectCode", unbox(guard).toMap().value("rejectCode")}, {"pendingCleared", cleared},
                {"outerBeforeY", beforeY}, {"outerAfterY", outer->property("contentY")}});
            archiveFocusDiagnostic(changing ? "context-transaction-begin" : "context-transaction-finish", body);
        });
        const auto publishConnection = connect(m_archive.get(), &ArchiveEditor::changed, this, [&] {
            publishedWhileChanging |= m_archive->focusContextChanging();
        });
        const auto disconnectContext = qScopeGuard([&] { disconnect(contextConnection); disconnect(publishConnection); });
        QElapsedTimer clock; clock.start();
        if (clearBook) m_archive->selectBook({}); else m_archive->selectEntry({});
        archiveFocusDiagnostic("context-transaction-after-mutation", body);
        QCOMPARE(contextEvents.size(), 2);
        const auto begin = contextEvents.first().toMap();
        QVERIFY(begin.value("changing").toBool());
        QVERIFY(begin.value("oldSelectionStillPresent").toBool());
        QVERIFY(begin.value("guardRead").toBool()); QCOMPARE(begin.value("rejectCode").toInt(), 17);
        QVERIFY(begin.value("pendingCleared").toBool());
        QCOMPARE(begin.value("outerBeforeY").toDouble(), 0.);
        QCOMPARE(begin.value("outerAfterY").toDouble(), 0.);
        QVERIFY(!contextEvents.last().toMap().value("changing").toBool());
        QVERIFY(publishedWhileChanging);
        QCOMPARE(m_archive->focusContextRevision(), beforeRevision + 1);
        QVERIFY(!m_archive->focusContextChanging());
        QCOMPARE(outer->property("contentY").toDouble(), 0.);
        QTest::qWait(60); // Only the old restore queue; no Tab visibility assertion waits.
        archiveFocusDiagnostic("context-transaction-after-old-flush", body);
        QCOMPARE(outer->property("contentY").toDouble(), 0.);
        QVERIFY(!m_panel->property("focusRestoreQueued").toBool());
        QVERIFY(unbox(m_panel->property("pendingFocusRestore")).toMap().isEmpty());
        const auto causal = ArchiveFocusProbe::causalSnapshot(m_panel);
        QVERIFY(!causal.value("overflow").toBool());
        bool rejectedEmptyPending = false;
        for (const auto &value : causal.value("events").toList()) {
            const auto event = value.toMap();
            if (event.value("kind") == "restore-flush" && event.value("rejectCode").toInt() == 1)
                rejectedEmptyPending = true;
        }
        QVERIFY(rejectedEmptyPending);
        qInfo().noquote() << "ARCHIVE_CONTEXT_TRANSACTION" << ArchiveFocusProbe::json({
            {"events", contextEvents}, {"publishedWhileChanging", publishedWhileChanging}, {"causal", causal}});
        disconnect(contextConnection); disconnect(publishConnection);
        if (clearBook) m_archive->selectBook(bookKey);
        m_archive->selectEntry(entryKey);
        QVERIFY(m_archive->hasEntry() && body->isVisible() && body->isEnabled());
        title->forceActiveFocus(Qt::OtherFocusReason);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("context-transaction-new-tab-immediate", body);
        QVERIFY(body->hasActiveFocus());
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QVERIFY(clock.elapsed() < 4000);
    }
    void archiveFocusHostReadyBoundary_data() {
        QTest::addColumn<int>("width"); QTest::addColumn<bool>("reduced");
        QTest::newRow("reduced-wide-ready-reveals-before-queue") << 1380 << true;
        QTest::newRow("reduced-compact-ready-reveals-before-queue") << 950 << true;
        QTest::newRow("reduced-narrow-ready-reveals-before-queue") << 760 << true;
        QTest::newRow("normal-wide-ready-reveals-before-queue") << 1380 << false;
        QTest::newRow("normal-compact-ready-reveals-before-queue") << 950 << false;
        QTest::newRow("normal-narrow-ready-reveals-before-queue") << 760 << false;
    }
    void archiveFocusHostReadyBoundary() {
        QFETCH(int, width); QFETCH(bool, reduced);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), width, true, true, reduced, false));
        auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        QVERIFY(portal && body);
        const auto state = archiveFocusDraftState();
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        QElapsedTimer clock; clock.start();
        QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
        // Waiting for the existing animated surface transition is permitted.
        // Reduced motion has no event drain at all before the ready assertions.
        if (!reduced) QVERIFY(QTest::qWaitFor([&] { return portal->property("contentReady").toBool() && m_panel->isEnabled(); },
            int(std::max<qint64>(0, 4000 - clock.elapsed()))));
        archiveFocusDiagnostic("ready-implies-reveal-available", body);
        QVERIFY(portal->property("contentReady").toBool());
        QVERIFY(portal->property("inputReady").toBool());
        QVERIFY(m_panel->isVisible() && m_panel->isEnabled());
        QVERIFY(!m_panel->property("navigationFocusBlocked").toBool());
        QVERIFY(body->isVisible() && body->isEnabled());
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("ready-direct-focus-immediate", body);
        auto *leaf = m_window->activeFocusItem();
        QVERIFY(leaf == body || body->isAncestorOf(leaf));
        QVERIFY(!NativeControlReadiness::visibleRect(leaf, m_window.get()).isEmpty());
        const auto *acquired = leaf;
        // Only exercise the later queue boundary after all immediate assertions
        // succeeded. It cannot rescue an earlier failed observation.
        QTest::qWait(60);
        archiveFocusDiagnostic("ready-direct-focus-after-queue", body);
        QCOMPARE(m_window->activeFocusItem(), acquired);
        QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
        QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostNonzeroReopen_data() {
        QTest::addColumn<bool>("reduced");
        QTest::newRow("normal-nonzero-body-offset-resets-on-reopen") << false;
        QTest::newRow("reduced-nonzero-body-offset-resets-on-reopen") << true;
    }
    void archiveFocusHostNonzeroReopen() {
        QFETCH(bool, reduced);
        auto archive = entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50));
        auto books = archive["worldBooks"].toArray(); auto book = books[0].toObject();
        auto entries = book["entries"].toArray(); auto entry = entries[0].toObject();
        entry["content"] = QString("Same-entry selection preservation.\n").repeated(100);
        entries[0] = entry; book["entries"] = entries; books[0] = book; archive["worldBooks"] = books;
        QVERIFY(loadArchiveDrawer(archive, 760, true, true, reduced));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *outer = archiveFormFlickable();
        auto *portal = m_window->findChild<QQuickItem *>("focusHostPortal");
        QVERIFY(body && outer && portal);
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        body->forceActiveFocus(Qt::TabFocusReason);
        QVERIFY(QMetaObject::invokeMethod(body, "select", Q_ARG(int, 1100), Q_ARG(int, 1110)));
        archiveFocusDiagnostic("nonzero-reopen-valid-baseline", body);
        QVERIFY(body->hasActiveFocus() && !NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QVERIFY(outer->property("contentY").toDouble() > 0.);
        const auto selection = ArchiveFocusProbe::selection(body);
        const auto state = archiveFocusDraftState();
        QElapsedTimer clock; clock.start();
        QVERIFY(QMetaObject::invokeMethod(m_window.get(), "closeArchive"));
        QVERIFY(QTest::qWaitFor([&] { return !portal->property("contentReady").toBool(); },
            int(std::max<qint64>(0, 4000 - clock.elapsed()))));
        archiveFocusDiagnostic("nonzero-reopen-closed", body);
        QCOMPARE(ArchiveFocusProbe::selection(body), selection);
        QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
        QVERIFY(QTest::qWaitFor([&] { return portal->property("contentReady").toBool() && m_panel->isEnabled(); },
            int(std::max<qint64>(0, 4000 - clock.elapsed()))));
        archiveFocusDiagnostic("nonzero-reopen-ready", body);
        QCOMPARE(outer->property("contentY").toDouble(), 0.);
        QCOMPARE(ArchiveFocusProbe::selection(body), selection);
        QTest::qWait(60); // Detect late overwrite only after the immediate top assertion passed.
        archiveFocusDiagnostic("nonzero-reopen-after-queue", body);
        QCOMPARE(outer->property("contentY").toDouble(), 0.);
        QCOMPARE(ArchiveFocusProbe::selection(body), selection);
        QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostLatestIntentBeatsDeferredFocus_data() {
        QTest::addColumn<QString>("source");
        QTest::newRow("archive-queued-restore-yields-to-acquired-title") << "archive";
        QTest::newRow("page-queued-restore-yields-to-acquired-title") << "page";
        QTest::newRow("palette-queued-search-yields-to-acquired-close") << "palette-search";
        QTest::newRow("palette-queued-return-yields-to-acquired-title") << "palette-return";
    }
    void archiveFocusHostLatestIntentBeatsDeferredFocus() {
        QFETCH(QString, source);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation");
        QVERIFY(body && title && navigation);
        const auto state = archiveFocusDraftState();
        const auto positioning = NativeControlReadiness::testRevealCallCount;
        QElapsedTimer clock; clock.start();
        if (source == "page") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openMemoryPage"));
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openArchive"));
        }
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("later-intent-valid-body-baseline", body);
        QVERIFY(body->hasActiveFocus() && body->isVisible() && body->isEnabled());
        QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QQuickItem *queuedTarget = body, *newTarget = title;
        if (source.startsWith("palette")) {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openPalette"));
            auto *search = m_window->findChild<QQuickItem *>("scene-search");
            archiveFocusDiagnostic("later-intent-valid-palette-baseline", search);
            QVERIFY(search && search->isVisible() && search->isEnabled() && search->hasActiveFocus());
            if (source == "palette-search") {
                queuedTarget = search;
                newTarget = m_window->findChild<QQuickItem *>("palette-close");
            }
        }
        archiveFocusDiagnostic("later-intent-action-boundary", queuedTarget);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        const auto requestBefore = navigation->property("focusRequestRevision").toInt();
        if (source == "palette-return") {
            QVERIFY(QMetaObject::invokeMethod(m_window.get(), "cancelPalette"));
        } else {
            QVariant pending;
            QVERIFY(QMetaObject::invokeMethod(navigation, "deferFocusItem", Q_RETURN_ARG(QVariant, pending),
                Q_ARG(QVariant, QVariant::fromValue(queuedTarget)), Q_ARG(QVariant, int(Qt::OtherFocusReason)),
                Q_ARG(QVariant, source == "palette-search"), Q_ARG(QVariant, QString()), Q_ARG(QVariant, QVariant())));
        }
        QVERIFY(navigation->property("focusRequestRevision").toInt() > requestBefore);
        archiveFocusDiagnostic("later-intent-before-acquire", newTarget);
        QVERIFY(newTarget && newTarget != queuedTarget && newTarget->isVisible() && newTarget->isEnabled());
        QVERIFY(newTarget->window() == m_window.get());
        newTarget->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("later-intent-acquired-before-drain", newTarget);
        QVERIFY(m_window->activeFocusItem() == newTarget || newTarget->isAncestorOf(m_window->activeFocusItem()));
        QVERIFY(!NativeControlReadiness::visibleRect(m_window->activeFocusItem(), m_window.get()).isEmpty());
        const auto *acquired = m_window->activeFocusItem();
        QTest::qWait(60);
        archiveFocusDiagnostic("later-intent-after-drain", newTarget);
        QCOMPARE(m_window->activeFocusItem(), acquired);
        QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(NativeControlReadiness::testRevealCallCount, positioning);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostNeutralLifecycleAllowsDeferredFocus_data() {
        QTest::addColumn<bool>("windowRoot");
        QTest::newRow("window-content-handoff-keeps-queued-restore-valid") << true;
        QTest::newRow("passive-focus-scope-handoff-keeps-queued-restore-valid") << false;
    }
    void archiveFocusHostNeutralLifecycleAllowsDeferredFocus() {
        QFETCH(bool, windowRoot);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *title = m_panel->findChild<QQuickItem *>("worldbookName");
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation");
        auto *neutral = windowRoot ? m_window->contentItem() : m_window->findChild<QQuickItem *>("focusHostLifecycleScope");
        QVERIFY(body && title && navigation && neutral);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("neutral-handoff-valid-baseline", body);
        QVERIFY(body->hasActiveFocus() && !NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        QVERIFY(title->isVisible() && title->isEnabled() && neutral->isVisible() && neutral->isEnabled());
        QVERIFY(neutral->window() == m_window.get());
        const auto state = archiveFocusDraftState();
        const auto activity = navigation->property("focusActivityRevision").toInt();
        const auto request = navigation->property("focusRequestRevision").toInt();
        QVariant pending, current;
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        QVERIFY(QMetaObject::invokeMethod(navigation, "deferFocusItem", Q_RETURN_ARG(QVariant, pending),
            Q_ARG(QVariant, QVariant::fromValue(title)), Q_ARG(QVariant, int(Qt::OtherFocusReason)),
            Q_ARG(QVariant, false), Q_ARG(QVariant, QString()), Q_ARG(QVariant, QVariant())));
        QVERIFY(navigation->property("focusRequestRevision").toInt() > request);
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuardCurrent", Q_RETURN_ARG(QVariant, current), Q_ARG(QVariant, pending)));
        QVERIFY(current.toBool());
        if (windowRoot) {
            // forceActiveFocus() on a scope keeps its remembered focused
            // descendant. Capture the actual path before changing it: clearing
            // only TextArea leaves its parent ScrollView as that descendant.
            // This is one finite lifecycle handoff, never a retry-until-root
            // loop, and uses only the public QQuickItem focus API.
            constexpr int chainLimit = 32;
            QList<QPointer<QQuickItem>> ancestors, scopedChildren;
            QSet<QQuickItem *> ancestorSet, scopeSet;
            bool complete = false, cycle = false, truncated = false, foreignWindow = false, invalidScopeLink = false;
            for (auto *item = m_window->activeFocusItem(); item; item = item->parentItem()) {
                if (ancestors.size() >= chainLimit) { truncated = true; break; }
                if (ancestorSet.contains(item)) { cycle = true; break; }
                ancestorSet.insert(item); ancestors.append(item);
                if (item->window() != m_window.get()) foreignWindow = true;
                if (item == neutral) { complete = true; break; }
            }
            for (auto *item = neutral; item;) {
                if (scopedChildren.size() >= chainLimit) { truncated = true; break; }
                if (scopeSet.contains(item)) { cycle = true; break; }
                scopeSet.insert(item); scopedChildren.append(item);
                if (item->window() != m_window.get()) foreignWindow = true;
                auto *child = item->scopedFocusItem();
                if (child && (!item->isAncestorOf(child) || !ancestorSet.contains(child))) {
                    invalidScopeLink = true; break;
                }
                item = child;
            }
            const auto chainState = [&](const QList<QPointer<QQuickItem>> &items) {
                QVariantList states;
                for (const auto &pointer : items) {
                    auto *item = pointer.data();
                    states.append(QVariantMap{{"present", item != nullptr},
                        {"token", m_archiveFocusDiagnosticProbe.token(item)},
                        {"objectName", item ? item->objectName() : QString()},
                        {"className", item ? QString::fromLatin1(item->metaObject()->className()) : QString()},
                        {"parentToken", m_archiveFocusDiagnosticProbe.token(item ? item->parentItem() : nullptr)},
                        {"scopeChildToken", m_archiveFocusDiagnosticProbe.token(item ? item->scopedFocusItem() : nullptr)},
                        {"focus", item && item->hasFocus()}, {"activeFocus", item && item->hasActiveFocus()},
                        {"focusScope", item && item->isFocusScope()},
                        {"windowMatches", item && item->window() == m_window.get()}});
                }
                return states;
            };
            qInfo().noquote() << "ARCHIVE_NEUTRAL_FOCUS_HANDOFF" << ArchiveFocusProbe::json({
                {"schema", "reverie.qt.neutral-focus-handoff.v1"}, {"stage", "captured-before-clear"},
                {"limit", chainLimit}, {"complete", complete}, {"cycle", cycle}, {"truncated", truncated},
                {"foreignWindow", foreignWindow}, {"invalidScopeLink", invalidScopeLink},
                {"actualLeafToken", m_archiveFocusDiagnosticProbe.token(m_window->activeFocusItem())},
                {"targetToken", m_archiveFocusDiagnosticProbe.token(neutral)},
                {"ancestors", chainState(ancestors)}, {"scopedChildren", chainState(scopedChildren)}});
            QVERIFY(complete); QVERIFY(!cycle); QVERIFY(!truncated); QVERIFY(!foreignWindow); QVERIFY(!invalidScopeLink);
            QVERIFY(!ancestors.isEmpty());
            QVERIFY(ancestors.first() == body || body->isAncestorOf(ancestors.first()));
            QVariantList cleared;
            for (const auto &pointer : ancestors) {
                auto *item = pointer.data();
                QVERIFY(item); QVERIFY(item->window() == m_window.get());
                if (item == neutral) break;
                if (!item->hasFocus()) continue;
                const auto beforeLeaf = m_archiveFocusDiagnosticProbe.token(m_window->activeFocusItem());
                const auto beforeActivity = navigation->property("focusActivityRevision").toInt();
                item->setFocus(false, Qt::OtherFocusReason);
                cleared.append(QVariantMap{{"itemToken", m_archiveFocusDiagnosticProbe.token(item)},
                    {"beforeLeafToken", beforeLeaf},
                    {"afterLeafToken", m_archiveFocusDiagnosticProbe.token(m_window->activeFocusItem())},
                    {"activityBefore", beforeActivity},
                    {"activityAfter", navigation->property("focusActivityRevision")}});
            }
            qInfo().noquote() << "ARCHIVE_NEUTRAL_FOCUS_HANDOFF" << ArchiveFocusProbe::json({
                {"schema", "reverie.qt.neutral-focus-handoff.v1"}, {"stage", "captured-chain-cleared"},
                {"limit", chainLimit}, {"cleared", cleared},
                {"ancestors", chainState(ancestors)}, {"scopedChildren", chainState(scopedChildren)},
                {"rootScopedChildAbsent", neutral->scopedFocusItem() == nullptr},
                {"actualLeafToken", m_archiveFocusDiagnosticProbe.token(m_window->activeFocusItem())},
                {"activity", navigation->property("focusActivityRevision")}});
            QVERIFY(!cleared.isEmpty());
        } else {
            // The sibling scope has no remembered descendant of its own.
            // Preserve its existing passing handoff rather than changing it.
            body->setFocus(false);
        }
        neutral->forceActiveFocus(Qt::OtherFocusReason);
        archiveFocusDiagnostic("neutral-handoff-acquired", neutral);
        QCOMPARE(m_window->activeFocusItem(), neutral);
        QCOMPARE(navigation->property("focusActivityRevision").toInt(), activity);
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuardCurrent", Q_RETURN_ARG(QVariant, current), Q_ARG(QVariant, pending)));
        QVERIFY(current.toBool());
        QTest::qWait(60); // Deferred restore; no keyboard visibility assertion is delayed.
        archiveFocusDiagnostic("neutral-handoff-restored", title);
        QVERIFY(m_window->activeFocusItem() == title || title->isAncestorOf(m_window->activeFocusItem()));
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostPaletteFlows_data() {
        QTest::addColumn<QString>("action");
        QTest::newRow("actual-palette-open-has-search-focus") << "open";
        QTest::newRow("actual-palette-close-restores-body") << "close";
        QTest::newRow("actual-palette-escape-restores-body") << "escape";
        QTest::newRow("actual-palette-current-result-restores-body") << "current";
        QTest::newRow("actual-palette-other-result-switches-page") << "other";
    }
    void archiveFocusHostPaletteFlows() {
        QFETCH(QString, action);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent");
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation");
        QVERIFY(body && navigation);
        body->forceActiveFocus(Qt::TabFocusReason);
        archiveFocusDiagnostic("palette-flow-body-baseline", body);
        QVERIFY(body->hasActiveFocus() && !NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        const auto state = archiveFocusDraftState();
        QElapsedTimer clock; clock.start();
        QVERIFY(QMetaObject::invokeMethod(m_window.get(), "openPalette"));
        auto *search = m_window->findChild<QQuickItem *>("scene-search");
        archiveFocusDiagnostic("palette-flow-search-ready", search);
        QVERIFY(search && search->isVisible() && search->isEnabled() && search->hasActiveFocus());
        QVERIFY(!NativeControlReadiness::visibleRect(search, m_window.get()).isEmpty());
        QVERIFY(navigation->property("paletteOpen").toBool());
        if (action == "open") {
            QCOMPARE(archiveFocusDraftState(), state);
            return;
        }
        archiveFocusDiagnostic("palette-flow-action-boundary", search);
        QVERIFY(ArchiveFocusProbe::beginObservation(m_panel));
        if (action == "escape") {
            QTest::keyClick(m_window.get(), Qt::Key_Escape);
        } else {
            QList<QQuickItem *> matches;
            const QString objectName = action == "close" ? "palette-close" : action == "current"
                ? "search-result-memory-worldbook" : "search-result-memory-memories";
            visualMatches(m_window->contentItem(), objectName, matches);
            QCOMPARE(matches.size(), 1);
            auto *target = matches.first();
            archiveFocusDiagnostic("palette-flow-real-control", target);
            QVERIFY(target->isVisible() && target->isEnabled());
            const auto visible = NativeControlReadiness::visibleRect(target, m_window.get());
            QVERIFY(!visible.isEmpty());
            QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, visible.center().toPoint());
        }
        archiveFocusDiagnostic("palette-flow-dispatched", body);
        QVERIFY(!navigation->property("paletteOpen").toBool());
        if (action == "other") {
            QCOMPARE(navigation->property("currentFeature").toString(), QString("memory"));
            QCOMPARE(navigation->property("currentSubentry").toString(), QString("memories"));
            QVERIFY(!m_panel->isVisible());
        } else {
            QVERIFY(QTest::qWaitFor([&] { return body->hasActiveFocus(); }, int(std::max<qint64>(0, 4000 - clock.elapsed()))));
            archiveFocusDiagnostic("palette-flow-returned", body);
            QVERIFY(!NativeControlReadiness::visibleRect(body, m_window.get()).isEmpty());
        }
        QVERIFY(clock.elapsed() < 4000);
        QCOMPARE(archiveFocusDraftState(), state);
    }
    void archiveFocusHostActualGenerationGuard_data() {
        QTest::addColumn<bool>("checkBothTransitions");
        QTest::newRow("ordinary-changed-retains-guard-actual-generation-invalidates") << true;
    }
    void archiveFocusHostActualGenerationGuard() {
        QFETCH(bool, checkBothTransitions); QVERIFY(checkBothTransitions);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        auto *body = m_panel->findChild<QQuickItem *>("worldbookContent"); QVERIFY(body);
        auto *navigation = m_window->findChild<QObject *>("sceneNavigation"); QVERIFY(navigation);
        body->forceActiveFocus(Qt::TabFocusReason);
        const auto generation = m_bridge->generation();
        QCOMPARE(m_panel->property("focusRuntimeRevision").toInt(), generation);
        QCOMPARE(navigation->property("focusGeneration").toInt(), generation);
        QVariant guard, current;
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuard", Q_RETURN_ARG(QVariant, guard),
            Q_ARG(QVariant, QVariant::fromValue(body)), Q_ARG(QVariant, false)));
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuardCurrent", Q_RETURN_ARG(QVariant, current),
            Q_ARG(QVariant, guard)));
        QVERIFY(current.toBool()); // Valid baseline before either notification.
        emit m_bridge->changed();
        QCOMPARE(m_panel->property("focusRuntimeRevision").toInt(), generation);
        QCOMPARE(navigation->property("focusGeneration").toInt(), generation);
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuardCurrent", Q_RETURN_ARG(QVariant, current),
            Q_ARG(QVariant, guard)));
        QVERIFY(current.toBool());
        ++m_bridge->m_generation; emit m_bridge->changed();
        QCOMPARE(m_panel->property("focusRuntimeRevision").toInt(), generation + 1);
        QCOMPARE(navigation->property("focusGeneration").toInt(), generation + 1);
        QVERIFY(QMetaObject::invokeMethod(navigation, "focusGuardCurrent", Q_RETURN_ARG(QVariant, current),
            Q_ARG(QVariant, guard)));
        QVERIFY(!current.toBool());
        QCOMPARE(rendererCommandCount("archive:put"), 0);
    }
    void archiveFocusProbeReasonContract_data() {
        QTest::addColumn<int>("reason"); QTest::addColumn<QString>("status");
        QTest::newRow("qt-mouse-enum-to-integer") << 0 << "known";
        QTest::newRow("qt-tab-enum-to-integer") << 1 << "known";
        QTest::newRow("qt-backtab-enum-to-integer") << 2 << "known";
        QTest::newRow("qt-activewindow-enum-to-integer") << 3 << "known";
        QTest::newRow("qt-popup-enum-to-integer") << 4 << "known";
        QTest::newRow("qt-shortcut-enum-to-integer") << 5 << "known";
        QTest::newRow("qt-menubar-enum-to-integer") << 6 << "known";
        QTest::newRow("qt-other-enum-to-integer") << 7 << "known";
        QTest::newRow("qt-nofocus-enum-to-integer") << 8 << "known";
        QTest::newRow("unknown-enum-is-invalid") << 9 << "invalid";
        QTest::newRow("symbolic-string-is-invalid") << 10 << "invalid";
        QTest::newRow("absent-property-is-explicit") << 11 << "absent";
    }
    void archiveFocusProbeReasonContract() {
        QFETCH(int, reason); QFETCH(QString, status);
        QVERIFY(loadArchiveDrawer(entrySettingsFixtureArchive(QJsonValue(5), QJsonValue(50)), 760, true, true));
        QQuickItem leaf(m_window->contentItem());
        leaf.setObjectName("focusReasonSerializationLeaf"); leaf.setSize(QSizeF(30, 30));
        if (reason <= 9) leaf.setProperty("focusReason", QVariant::fromValue(static_cast<Qt::FocusReason>(reason)));
        else if (reason == 10) leaf.setProperty("focusReason", "TabFocusReason");
        leaf.forceActiveFocus(Qt::OtherFocusReason);
        QCOMPARE(m_window->activeFocusItem(), &leaf);
        ArchiveFocusProbe probe;
        const auto snapshot = probe.snapshot(m_window.get(), nullptr);
        QCOMPARE(snapshot["focusReasonStatus"].toString(), status);
        const auto json = QJsonDocument::fromJson(ArchiveFocusProbe::json(snapshot)).object();
        if (status == "known") {
            QVERIFY(json["focusReason"].isDouble());
            QCOMPARE(json["focusReason"].toInt(), reason);
        } else QVERIFY(json["focusReason"].isNull());
        QVERIFY(snapshot["ancestryComplete"].toBool());
        QVERIFY(snapshot["clipChainComplete"].toBool());
        QVERIFY(snapshot["scrollsComplete"].toBool());
    }
    void initTestCase() {
        registerArchiveInteractionTypes();
        QQuickStyle::setStyle("Basic");
        QQuickWindow::setGraphicsApi(QSGRendererInterface::Software);
    }
    void init() {
        m_personaFixtureSamples.clear(); m_personaFixtureLast.clear(); m_personaFixtureCopy.clear(); m_personaFixtureUsed = false;
        m_profileClickCount = 0;
        m_candidateTraceArmed = false;
        m_candidateFailureObservation = false;
        m_candidateInputDelivery = false;
        m_candidateElapsed.invalidate();
        m_candidateFrameSerial = 0;
        m_candidateTarget = {};
        m_candidateBaseline = {};
        m_candidateActionCommand.clear();
        m_candidateLayer.clear();
        m_candidateFixedStages.clear();
        m_candidateLastChange.clear();
        m_candidateDiagnostic.clear();
        m_candidateFailureLayer.clear();
        m_candidateFailureReason.clear();
        m_candidatePhysicalClicks = m_candidatePhysicalSignals = m_candidateSyntheticSignals = 0;
        m_candidatePhysicalKeys = m_candidatePreArmKeys = m_candidateFocusTransfers = 0;
        m_candidateObservationSerial = 0;
        m_candidateLastSemantic = {};
        m_candidateBlankInput = {};
        m_candidateHiddenKeyInput = {};
        m_candidateChanges.clear();
        m_candidatePreArmClicks = m_candidatePreArmSignals = m_candidatePreArmSynthetic = 0;
        m_candidateChangeSnapshots = m_candidateChangeOverflow = 0;
        m_candidateInputBudgetMs = 0;
        m_candidateStableSinceMs = m_candidateQualifiedAtMs = -1;
        m_candidateStableFrameSerial = m_candidateQualifiedFrameSerial = 0;
        m_data = std::make_unique<QTemporaryDir>();
        QVERIFY(m_data->isValid());
        // All constructor reads and selected files are temporary. Never start
        // the service, avatar helper, network client or storage-key path.
        QVERIFY(writeLocal(m_data->filePath("qt-appearance.json"),
                           R"({"reducedMotion":true,"reducedTransparency":true})"));
        QVERIFY(writeLocal(m_data->filePath("local.json"), cardJson()));
        m_bridge = std::make_unique<RuntimeBridge>(m_data->path(), m_data->path(), m_data->filePath("unused-python"));
        m_bridge->m_connected = true;
        m_bridge->m_runtimeWritable = true;
        m_bridge->m_recoveryState = "clean";
        m_bridge->m_generation = 7;
        m_bridge->m_persona = {{"persona_id", "persona-current"}, {"epoch", 3},
                               {"fingerprint", "fingerprint-current"}};
        m_bridge->m_frameWriter = [this](const QByteArray &bytes) {
            m_frames.append(QJsonDocument::fromJson(bytes.mid(4)).object());
            return bytes.size();
        };
        m_archive = std::make_unique<ArchiveEditor>([](const QString &, const QVariantMap &) { return QString(); });
    }
    void cleanup() {
        if (m_archiveFocusDiagnosticUsed) archiveFocusDiagnostic("terminal");
        m_archiveFocusDiagnosticUsed = false;
        disconnect(m_archiveFocusDiagnosticFrameConnection);
        m_archiveFocusDiagnosticFrameConnection = {};
        m_archiveFocusDiagnosticFrame = 0;
        m_archiveFocusDiagnosticCount = 0;
        m_archiveFocusDiagnosticDropped = 0;
        m_archiveFocusDiagnosticTarget = nullptr;
        m_archiveFocusDiagnosticProbe = ArchiveFocusProbe{};
        if (m_personaFixtureUsed) {
            if (m_personaFixtureLast.value("phase") != "terminal") capturePersonaFixture("terminal");
            qInfo().noquote() << "PERSONA_FIXTURE_PROBE" << compactDiagnostic(QJsonObject::fromVariantMap({
                {"schema", "reverie.persona-fixture.v1"}, {"case", QTest::currentTestFunction()},
                {"dataTag", QTest::currentDataTag() ? QTest::currentDataTag() : ""}, {"samples", m_personaFixtureSamples},
                {"sampleLimit", 6}, {"terminal", m_personaFixtureLast}, {"terminalCount", 1}}));
        }
        bool candidateFocusCleared = true;
        if (m_candidateTraceArmed) {
            // The terminal slot is reserved independently of the six change
            // slots, and is emitted while every inspected object still lives.
            candidateFixedStage("terminal");
            m_candidateTraceArmed = false;
            disconnect(m_candidateBridgeConnection);
            disconnect(m_candidateFocusConnection);
            disconnect(m_candidateActiveConnection);
            for (const auto &connection : m_candidatePropertyConnections)
                disconnect(connection);
            m_candidatePropertyConnections.clear();
            m_candidateFocusObserver.reset();
            setCandidateFocusWindow(nullptr);
            candidateFocusCleared = !QGuiApplication::focusWindow() && (!m_window || !m_window->isActive());
        }
        disconnect(m_candidateFrameConnection);
        m_candidateFrameConnection = {};
        m_dialog = nullptr;
        m_panel = nullptr;
        m_window.reset();
        m_engine.reset();
        m_orderSession.reset();
        m_archive.reset();
        m_bridge.reset();
        m_data.reset();
        m_frames.clear();
        QVERIFY(candidateFocusCleared);
    }

    void realBridgeSelectionNeedsTheProductionButton_data() {
        QTest::addColumn<bool>("confirmed");
        QTest::newRow("cancel-sends-zero") << false;
        QTest::newRow("confirm-sends-one") << true;
    }
    void realBridgeSelectionNeedsTheProductionButton() {
        QFETCH(bool, confirmed);
        loadPanel();
        QVERIFY(m_panel && m_dialog);
        QSignalSpy opening(m_dialog, SIGNAL(aboutToShow()));
        QVERIFY(opening.isValid());
        chooseCard();
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        QCOMPARE(opening.count(), 1);
        readConfirmationWithoutDispatch();
        clickButton(confirmed ? "personaImportConfirm" : "personaImportCancel");
        verifyButtonResult(confirmed);
        QCOMPARE(opening.count(), 1);
    }

    void notificationOrdersOpenExactlyOneDialog_data() {
        QTest::addColumn<int>("order");
        QTest::newRow("candidate-before-feedback") << int(CardNotificationOrderSession::CandidateFirst);
        QTest::newRow("feedback-before-candidate") << int(CardNotificationOrderSession::FeedbackFirst);
    }
    void notificationOrdersOpenExactlyOneDialog() {
        QFETCH(int, order);
        m_orderSession = std::make_unique<CardNotificationOrderSession>(m_bridge.get(), CardNotificationOrderSession::Order(order));
        loadPanel(m_orderSession.get());
        QVERIFY(m_panel && m_dialog);
        QSignalSpy opening(m_dialog, SIGNAL(aboutToShow()));
        QVERIFY(opening.isValid());
        QStringList notifications;
        QList<bool> visibility;
        connect(m_orderSession.get(), &CardNotificationOrderSession::cardPropertyPublished, this,
                [&](const QString &name) {
                    notifications.append(name);
                    visibility.append(m_dialog->property("visible").toBool());
                });
        chooseCard();
        const QString candidate = "personaCardCandidate";
        const QString feedback = "personaCardFeedback";
        QCOMPARE(notifications, order == CardNotificationOrderSession::CandidateFirst
            ? QStringList({candidate, feedback}) : QStringList({feedback, candidate}));
        QCOMPARE(visibility, QList<bool>({false, true}));
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        QCOMPARE(opening.count(), 1);
        readConfirmationWithoutDispatch();
        for (int repeat = 0; repeat < 3; ++repeat)
            emit m_bridge->changed();
        QCoreApplication::processEvents();
        QCOMPARE(opening.count(), 1);
        QCOMPARE(m_panel->findChildren<QObject *>("personaImportConfirmation").size(), 1);
        // Click the real control; the projection forwards to RuntimeBridge.
        clickButton("personaImportCancel");
        verifyButtonResult(false);
    }

    void nonownerPagesAndWrongCandidateScopeCloseTheDialog() {
        loadPanel();
        QVERIFY(m_panel && m_dialog);
        QSignalSpy opening(m_dialog, SIGNAL(aboutToShow()));
        QVERIFY(opening.isValid());
        QVERIFY(m_panel->setProperty("page", "settings"));
        chooseCard();
        const auto candidate = m_bridge->personaCardCandidate();
        for (const auto &page : {"memory", "settings", "activities", "about", "palette"}) {
            QVERIFY(m_panel->setProperty("page", page));
            emit m_bridge->changed();
            QCoreApplication::processEvents();
            QVERIFY(!m_dialog->property("visible").toBool());
        }
        QCOMPARE(opening.count(), 0);
        QCOMPARE(m_frames.size(), 0);
        QVERIFY(m_panel->setProperty("page", "character"));
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        QCOMPARE(opening.count(), 1);
        QVERIFY(m_panel->setProperty("page", "memory"));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(m_bridge->personaCardCandidate(), candidate);
        QVERIFY(m_panel->setProperty("page", "character"));
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        QCOMPARE(opening.count(), 2);
        m_bridge->m_personaCardCandidate["scopeKey"] = "persona-other:4:fingerprint-other";
        emit m_bridge->changed();
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        emit m_bridge->changed();
        QCoreApplication::processEvents();
        QCOMPARE(opening.count(), 2);
        QCOMPARE(m_frames.size(), 0);
        m_bridge->m_personaCardCandidate = candidate;
        emit m_bridge->changed();
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        QCOMPARE(opening.count(), 3);
        clickButton("personaImportCancel");
        verifyButtonResult(false);
    }

    void liveIdentityInvalidatesTheCandidate() {
        loadPanel();
        QVERIFY(m_panel && m_dialog);
        chooseCard();
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        const auto previousScope = m_bridge->scopeKey();
        m_bridge->event({{"type", "persona:data"}, {"request_id", ""},
            {"payload", QJsonObject{{"persona_id", "persona-next"}, {"persona_epoch", 4},
                                     {"persona_fingerprint", "fingerprint-next"}}}});
        QVERIFY(m_bridge->scopeKey() != previousScope);
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QVERIFY(m_bridge->personaCardCandidate().isEmpty());
        QVERIFY(m_bridge->m_personaCardJson.isEmpty());
        QCOMPARE(importCount(), 0);
        // Identity refresh reads are captured locally too; repeated UI reads
        // and notifications must not add any command, especially an import.
        const int writesAfterIdentity = m_frames.size();
        QVERIFY(m_panel->setProperty("page", "memory"));
        QVERIFY(m_panel->setProperty("page", "character"));
        emit m_bridge->changed();
        QCoreApplication::processEvents();
        QVERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(m_frames.size(), writesAfterIdentity);
        QCOMPARE(importCount(), 0);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }

    void alreadySelectedCardOpensAtComponentCompletion() {
        chooseCard();
        loadPanel();
        QVERIFY(m_panel && m_dialog);
        QTRY_VERIFY(m_dialog->property("opened").toBool());
        readConfirmationWithoutDispatch();
        clickButton("personaImportCancel");
        verifyButtonResult(false);
    }
    void profilePointDiagnosticsDistinguishUnmeasuredFromOrigin_data() {
        QTest::addColumn<QString>("kind");
        QTest::newRow("missing-target") << QString("missing");
        QTest::newRow("unmeasurable-center") << QString("nonfinite");
        QTest::newRow("valid-origin") << QString("origin");
    }
    void profilePointDiagnosticsDistinguishUnmeasuredFromOrigin() {
        QFETCH(QString, kind);
        loadPanel();
        QVERIFY(m_panel && m_window);
        const QString name = "profileDiagnosticPointFixture";
        std::unique_ptr<QQuickItem> target;
        if (kind != "missing") {
            target = std::make_unique<QQuickItem>(m_panel);
            target->setObjectName(name);
            target->setSize(QSizeF(20, 20));
            target->setPosition(kind == "nonfinite"
                ? QPointF(std::numeric_limits<qreal>::quiet_NaN(), 0)
                : m_panel->mapFromScene(QPointF()) - QPointF(10, 10));
        }
        const auto state = profileItemState(name, ProfileScope::Page);
        const bool measured = kind == "origin";
        QCOMPARE(state["pointMeasured"].toBool(), measured);
        QCOMPARE(state["pointX"].isNull(), !measured);
        QCOMPARE(state["pointY"].isNull(), !measured);
        if (measured) {
            QVERIFY(state["pointX"].isDouble() && state["pointY"].isDouble());
            QCOMPARE(state["pointX"].toInt(), 0);
            QCOMPARE(state["pointY"].toInt(), 0);
        }
        QCOMPARE(m_profileClickCount, 0);
        QCOMPARE(m_frames.size(), 0);
    }
    void memoryActionFirstFeedbackSurvivesDeepRowChanges_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626-body") << 591 << 626;
        QTest::newRow("591x546-body") << 591 << 546;
        QTest::newRow("760x650-window") << 760 << 650;
    }
    void memoryActionFirstFeedbackSurvivesDeepRowChanges() {
        QFETCH(int, width);
        QFETCH(int, height);
        loadPanel();
        QVERIFY(m_panel && m_window);
        // These are controlled standalone TaskPanel sizes, not whole-app
        // drawer geometry. In particular 626/546 are real available heights.
        m_window->resize(width, height);
        auto rows = feedbackMemoryRows();
        QVERIFY2(prepareFeedbackRows(rows), qPrintable(m_candidateDiagnostic));
        auto *feedback = fixedMemoryFeedback();
        auto *page = profileItem("memoryPage", ProfileScope::Page);
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        QVERIFY(feedback && page && scroll && feedbackScrollContent());
        QVERIFY(!page->isAncestorOf(feedback) && !scroll->isAncestorOf(feedback));
        QVERIFY(feedback->property("text").toString().isEmpty() && !feedback->isVisible());
        QCOMPARE(rendererCommandCount("memory:list"), 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 1);
        const auto id = feedbackMemoryId(40);
        QString currentId = id;
        for (const bool pinned : {true, false}) {
            QElapsedTimer clock; clock.start();
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
                &RuntimeBridgeTest::setCandidateFocusWindow, pinned ? "pin" : "unpin");
            QVERIFY(probe.windowReady());
            CandidateInput input;
            qreal offset = 0;
            QVERIFY2(feedbackInput({"memoryPin", id}, "memory:reinforce", input, offset, clock, deadline),
                     qPrintable(m_candidateDiagnostic));
            QCOMPARE(input.envelope["payload"].toObject()["op"].toString(), pinned ? QString("pin") : QString("unpin"));
            QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status").toString(), QString("pending"));
            QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("requestId").toString(), input.requestId);
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(feedbackItemFullyVisible(fixedMemoryFeedback()));
            QVERIFY(feedbackOffsetRetained(offset));
            QVERIFY(feedbackScrollContent()->property("contentY").toDouble() > 1000);
            auto changed = rows[40].toObject(); changed["pinned"] = pinned; rows[40] = changed;
            QVERIFY(probe.prepareAndArm());
            const auto beforeReadback = feedbackScrollContent()->property("contentY").toDouble();
            QVERIFY(finishFeedbackAction(input, pinned ? QString("固定记忆") : QString("取消固定"), rows, deadline));
            QCOMPARE(probe.armedEvents(), 0);
            QVERIFY(probe.ownerMatchesLeaf());
            QVERIFY(probe.focusUnchanged());
            QVERIFY(feedbackItemFullyVisible(fixedMemoryFeedback()));
            QVERIFY(feedbackOffsetRetained(beforeReadback));
            const auto row = MemoryActionProbe::findRow(m_panel, id);
            QVERIFY(row.valid());
            QCOMPARE(MemoryActionProbe::detail::dataMap(row.item->property("modelData")).value("pinned").toBool(), pinned);
            auto *text = MemoryActionProbe::rowControl(row, "memoryText");
            QVERIFY(text);
            QCOMPARE(text->property("text").toString().startsWith("已固定"), pinned);
            QVERIFY(probe.focusUnchanged());
        }
        {
            // One original absolute input budget covers open, commit and save.
            QElapsedTimer clock; clock.start();
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
                &RuntimeBridgeTest::setCandidateFocusWindow, "edit");
            QVERIFY(probe.windowReady());
            CandidateInput local, saved;
            qreal offset = 0;
            QVERIFY2(feedbackInput({"memoryEdit", id}, {}, local, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            QCOMPARE(m_panel->property("editingMemoryId").toString(), id);
            const QString edited = "真实编辑控件写入的新修订记忆";
            QVERIFY2(feedbackInput({"memoryEditField", id}, {}, local, offset, clock, deadline, edited), qPrintable(m_candidateDiagnostic));
            QVERIFY2(feedbackInput({"memoryEditSave", id}, "memory:edit", saved, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            QCOMPARE(saved.envelope["payload"].toObject()["text"].toString(), edited);
            const QString revisionId = "fact_feedback_revision_40";
            auto changed = rows[40].toObject();
            changed["id"] = revisionId; changed["text"] = edited; changed["revision"] = 2; rows[40] = changed;
            QVERIFY(probe.prepareAndArm());
            QVERIFY(finishFeedbackAction(saved, "修改记忆", rows, deadline));
            QCOMPARE(probe.armedEvents(), 0);
            QVERIFY(probe.ownerMatchesLeaf());
            QVERIFY(probe.focusUnchanged());
            QCOMPARE(fixedMemoryFeedback(), feedback);
            QVERIFY(feedbackItemFullyVisible(fixedMemoryFeedback()));
            QVERIFY(feedbackOffsetRetained(offset));
            QVERIFY(!MemoryActionProbe::findRow(m_panel, id).valid());
            const auto row = MemoryActionProbe::findRow(m_panel, revisionId);
            QVERIFY(row.valid());
            const auto model = MemoryActionProbe::detail::dataMap(row.item->property("modelData"));
            QCOMPARE(model.value("id").toString(), revisionId);
            QCOMPARE(model.value("revision").toInt(), 2);
            QCOMPARE(model.value("text").toString(), edited);
            QCOMPARE(m_panel->property("editingMemoryId").toString(), QString());
            currentId = revisionId;
            QVERIFY(probe.focusUnchanged());
        }
        {
            QElapsedTimer clock; clock.start();
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
                &RuntimeBridgeTest::setCandidateFocusWindow, "delete");
            QVERIFY(probe.windowReady());
            CandidateInput local, removed;
            qreal offset = 0;
            QVERIFY2(feedbackInput({"memoryDelete", currentId}, {}, local, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            QCOMPARE(m_panel->property("deletingMemoryId").toString(), currentId);
            QVERIFY2(feedbackInput({"memoryDeleteConfirm", currentId}, "memory:delete", removed, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            rows.removeAt(40);
            // Keep a surviving focus owner during feedback/readback checks;
            // deleting a focused delegate may legitimately release its focus.
            QVERIFY(probe.prepareAndArm());
            QVERIFY(finishFeedbackAction(removed, "删除记忆", rows, deadline, true));
            QCOMPARE(probe.armedEvents(), 0);
            QVERIFY(probe.ownerMatchesLeaf());
            QVERIFY(probe.focusUnchanged());
            QVERIFY(!MemoryActionProbe::findRow(m_panel, id).valid());
            QVERIFY(!MemoryActionProbe::findRow(m_panel, currentId).valid());
            QCOMPARE(fixedMemoryFeedback(), feedback);
            QVERIFY(feedbackItemFullyVisible(fixedMemoryFeedback()));
            QVERIFY(feedbackOffsetRetained(offset));
            QCOMPARE(m_panel->property("deletingMemoryId").toString(), QString());
            QVERIFY(probe.focusUnchanged());
        }
        QCOMPARE(rendererCommandCount("memory:reinforce"), 2);
        QCOMPARE(rendererCommandCount("memory:edit"), 1);
        QCOMPARE(rendererCommandCount("memory:delete"), 1);
        QCOMPARE(rendererCommandCount("memory:list"), 5);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 5);
        QCOMPARE(m_frames.size(), 14);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryActionFeedbackLayoutIsPlainPassiveAndLocal_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("1000x900-normal") << 1000 << 900;
        QTest::newRow("760x650-narrow") << 760 << 650;
    }
    void memoryActionFeedbackLayoutIsPlainPassiveAndLocal() {
        QFETCH(int, width);
        QFETCH(int, height);
        loadPanel();
        QVERIFY(m_panel && m_window);
        m_window->resize(width, height);
        QVERIFY2(prepareFeedbackRows(feedbackMemoryRows()), qPrintable(m_candidateDiagnostic));
        auto *feedback = fixedMemoryFeedback();
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *warning = profileItem("runtimeRecoveryWarning", ProfileScope::Page);
        QVERIFY(feedback && scroll && warning && feedbackScrollContent());
        QCOMPARE(feedback->parentItem(), scroll->parentItem());
        trackCandidateFrames();
        const auto emptyScrollTop = scroll->mapToScene(QPointF()).y();
        const auto emptyMemoryLayout = memoryLayoutSnapshot();
        const auto failureGeometry = qScopeGuard([&] {
            if (QTest::currentTestFailed())
                qWarning().noquote() << memoryLayoutDiagnostic(emptyMemoryLayout, "feedback-layout-matrix");
        });
        QVERIFY(!feedback->isVisible() && feedback->property("text").toString().isEmpty());
        const int frames = m_frames.size();
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        QVERIFY(tabs);
        QMap<QString, QJsonObject> noFeedbackLayouts;
        {
            const QDeadlineTimer preparation(4000, Qt::PreciseTimer);
            const QStringList names{"summary", "profile", "backup", "recall"};
            for (int index = 0; index < names.size(); ++index) {
                QVERIFY(tabs->setProperty("currentIndex", index + 1));
                QVERIFY(feedbackLayoutSettled(preparation));
                QVERIFY(!feedback->isVisible());
                noFeedbackLayouts.insert(names[index], memoryLayoutSnapshot());
            }
            QVERIFY(tabs->setProperty("currentIndex", 0));
            for (const auto &pageName : {QString("settings"), QString("character")}) {
                QVERIFY(m_panel->setProperty("page", pageName));
                QVERIFY(feedbackLayoutSettled(preparation));
                QVERIFY(!feedback->isVisible());
                noFeedbackLayouts.insert(pageName, memoryLayoutSnapshot());
            }
            QVERIFY(m_panel->setProperty("page", "memory"));
            QVERIFY(feedbackLayoutSettled(preparation));
            QVERIFY2(qAbs(scroll->mapToScene(QPointF()).y() - emptyScrollTop) <= .5,
                qPrintable(memoryLayoutDiagnostic(emptyMemoryLayout, "baseline-return-to-memory")));
            QCOMPARE(m_frames.size(), frames);
        }
        const auto contentHeight = feedbackScrollContent()->property("contentHeight").toDouble();
        QVERIFY(feedbackScrollContent()->setProperty("contentY", contentHeight / 2));
        const QString longText = QString("<b>仍为纯文本 & 不创建链接</b>\n第二行保持完整换行。\n").repeated(5);
        for (const auto &status : {QString("pending"), QString("success"), QString("error"), QString("unknown")}) {
            QElapsedTimer clock; clock.start();
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
                &RuntimeBridgeTest::setCandidateFocusWindow, "display-" + status);
            QVERIFY(probe.windowReady());
            QVERIFY(probe.prepareAndArm());
            const auto offset = feedbackScrollContent()->property("contentY").toDouble();
            // This display-only matrix supplies passive bridge feedback. Real
            // memory mutations above use production controls and own frames.
            const bool recovery = status == "error";
            m_bridge->m_runtimeWritable = !recovery;
            m_bridge->m_recoveryState = recovery ? "recovery_required" : "clean";
            const auto text = recovery ? longText : status + QString("\n本次状态仍在列表外显示。");
            m_bridge->setMemoryFeedback("action", status, text, "display-" + status);
            QVERIFY(feedbackLayoutSettled(deadline));
            QCOMPARE(fixedMemoryFeedback(), feedback);
            QCOMPARE(feedback->property("text").toString(), text);
            QCOMPARE(feedback->property("textFormat").toInt(), 0);
            QCOMPARE(feedback->property("wrapMode").toInt(), 4);
            const auto attached = readMemoryFeedbackAttached(feedback, m_engine.get(), text);
            probe.attached(attached);
            QVERIFY(attached.contextPresent && attached.contextValid && attached.engineMatches);
            QVERIFY(attached.rolePropertyValid && attached.roleIsProperty);
            QVERIFY(attached.roleValueValid && attached.roleTypeValid);
            QVERIFY(attached.roleConversionOk && attached.roleMeasured);
            QCOMPARE(attached.role, int(QAccessible::StaticText));
            QVERIFY(attached.namePropertyValid && attached.nameIsProperty);
            QVERIFY(attached.nameValueValid && attached.nameIsQString && attached.nameMeasured);
            QVERIFY(attached.nameMatches);
            QVERIFY(attached.valid());
            QCOMPARE(feedback->property("color").value<QColor>(), QColor(status == "error" || status == "unknown" ? "#e6b4a4" : "#b7d5cf"));
            QVERIFY(feedbackItemFullyVisible(feedback));
            QVERIFY(!feedback->hasActiveFocus() && !feedback->activeFocusOnTab());
            const auto feedbackRect = feedback->mapRectToScene(QRectF(QPointF(), feedback->size()));
            const auto scrollRect = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
            QVERIFY(feedbackRect.bottom() <= scrollRect.top() + .5);
            QVERIFY(scroll->height() > 0);
            QCOMPARE(warning->isVisible(), recovery);
            if (recovery) {
                QVERIFY(feedbackItemFullyVisible(warning));
                QVERIFY(warning->mapRectToScene(QRectF(QPointF(), warning->size())).bottom() <= feedbackRect.top() + .5);
                QVERIFY(feedback->property("lineCount").toInt() >= 10);
            }
            QVERIFY(feedbackOffsetRetained(offset));
            QCOMPARE(probe.armedEvents(), 0);
            QVERIFY(probe.ownerMatchesLeaf());
            QVERIFY(probe.focusUnchanged());
            QCOMPARE(m_frames.size(), frames);
        }
        // The remaining r6 business checks allow their ordinary navigation
        // focus changes. Restore only the controlled active test window.
        const auto clearTailFocus = qScopeGuard([] { RuntimeBridgeTest::setCandidateFocusWindow(nullptr); });
        setCandidateFocusWindow(m_window.get());
        QVERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        // Hiding an active feedback row returns its reserved space. At a real
        // lower boundary, Qt may clamp Y when the viewport grows.
        auto *content = feedbackScrollContent();
        QVERIFY(content->setProperty("contentY", std::max(0., content->property("contentHeight").toDouble() - content->height())));
        const auto boundary = content->property("contentY").toDouble();
        m_bridge->setMemoryFeedback("action", "", "", "display-empty");
        {
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            QVERIFY(feedbackLayoutSettled(deadline));
        }
        QVERIFY(!feedback->isVisible());
        QVERIFY2(qAbs(scroll->mapToScene(QPointF()).y() - emptyScrollTop) <= .5,
            qPrintable(memoryLayoutDiagnostic(emptyMemoryLayout, "feedback-cleared-memory")));
        QVERIFY(feedbackOffsetRetained(boundary));
        m_bridge->setMemoryFeedback("action", "success", "仍属于记忆管理页。", "display-visible");
        for (const auto &name : {QString("summary"), QString("profile"), QString("backup"), QString("recall")}) {
            QElapsedTimer clock; clock.start();
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            CandidateInput local;
            qreal offset = 0;
            QVERIFY2(feedbackInput({"memoryTab-" + name, {}}, {}, local, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(!feedback->isVisible());
            const auto baseline = noFeedbackLayouts.value(name);
            const auto beforeRect = baseline.value("scroll").toObject();
            const auto afterRect = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
            QVERIFY2(qAbs(afterRect.y() - beforeRect.value("y").toDouble()) <= .5 &&
                qAbs(afterRect.height() - beforeRect.value("height").toDouble()) <= .5,
                qPrintable(memoryLayoutDiagnostic(baseline, "feedback-hidden-" + name)));
            QVERIFY2(feedbackInput({"memoryTab-memories", {}}, {}, local, offset, clock, deadline), qPrintable(m_candidateDiagnostic));
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(feedbackItemFullyVisible(feedback));
            QCOMPARE(m_frames.size(), frames);
        }
        for (const auto &pageName : {QString("settings"), QString("character")}) {
            QVERIFY(m_panel->setProperty("page", pageName));
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(!feedback->isVisible());
            const auto baseline = noFeedbackLayouts.value(pageName);
            const auto beforeRect = baseline.value("scroll").toObject();
            const auto top = scroll->mapToScene(QPointF()).y(), available = scroll->height();
            QVERIFY2(qAbs(top - beforeRect.value("y").toDouble()) <= .5 &&
                qAbs(available - beforeRect.value("height").toDouble()) <= .5,
                qPrintable(memoryLayoutDiagnostic(baseline, "feedback-hidden-" + pageName)));
            m_bridge->setMemoryFeedback("action", "success", longText, "display-other-page");
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(!feedback->isVisible());
            QVERIFY2(qAbs(scroll->mapToScene(QPointF()).y() - top) <= .5 && qAbs(scroll->height() - available) <= .5,
                qPrintable(memoryLayoutDiagnostic(baseline, "feedback-updated-hidden-" + pageName)));
        }
        QVERIFY(m_panel->setProperty("page", "memory"));
        {
            const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(feedbackItemFullyVisible(feedback));
            m_panel->setVisible(false);
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(!feedback->isVisible());
            m_panel->setVisible(true);
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(feedbackItemFullyVisible(feedback));
        }
        QCOMPARE(m_frames.size(), frames);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryActionFeedbackScopeChangeCannotReviveOldResponse() {
        loadPanel();
        QVERIFY(m_panel && m_window);
        m_window->resize(591, 626);
        const auto rows = feedbackMemoryRows();
        QVERIFY2(prepareFeedbackRows(rows), qPrintable(m_candidateDiagnostic));
        QElapsedTimer clock; clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        CandidateInput input;
        qreal offset = 0;
        QVERIFY2(feedbackInput({"memoryPin", feedbackMemoryId(40)}, "memory:reinforce", input, offset, clock, deadline),
                 qPrintable(m_candidateDiagnostic));
        m_bridge->event({{"type", "memory:result"}, {"request_id", input.requestId}, {"payload", QJsonObject{{"ok", true}}}});
        QCOMPARE(rendererCommandCount("memory:list"), input.before.listCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), input.before.candidateCount + 1);
        const auto listId = rendererCommandAt("memory:list", input.before.listCount)["request_id"].toString();
        const auto candidateReadId = rendererCommandAt("memory:candidates:list", input.before.candidateCount)["request_id"].toString();
        QVERIFY(!listId.isEmpty() && listId != input.before.listId);
        QVERIFY(!candidateReadId.isEmpty() && candidateReadId != input.before.candidateId);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(feedbackItemFullyVisible(fixedMemoryFeedback()));
        const auto previousScope = m_bridge->scopeKey();
        m_bridge->event({{"type", "persona:scope"}, {"payload", QJsonObject{
            {"persona_id", "feedback-next-persona"}, {"epoch", 9}, {"fingerprint", "feedback-next-fingerprint"}}}});
        QVERIFY(m_bridge->scopeKey() != previousScope);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(fixedMemoryFeedback());
        QVERIFY(fixedMemoryFeedback()->property("text").toString().isEmpty());
        QVERIFY(!fixedMemoryFeedback()->isVisible());
        const int framesAfterScope = m_frames.size();
        m_bridge->event({{"type", "memory:result"}, {"request_id", input.requestId}, {"payload", QJsonObject{{"ok", true}}}});
        deliverFeedbackMemories(listId, rows);
        deliverCandidate(candidatePage(candidateRows(1, 100)), candidateReadId);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(m_bridge->memoryFeedback().value("action").toMap().isEmpty());
        QVERIFY(fixedMemoryFeedback()->property("text").toString().isEmpty() && !fixedMemoryFeedback()->isVisible());
        QVERIFY(!MemoryActionProbe::findRow(m_panel, feedbackMemoryId(40)).valid());
        QCOMPARE(m_frames.size(), framesAfterScope);
        QCOMPARE(rendererCommandCount("memory:reinforce"), 1);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryFeedbackFocusProbeRejectsForeignOwner() {
        loadPanel();
        QVERIFY(m_panel && m_window);
        QElapsedTimer clock; clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
            &RuntimeBridgeTest::setCandidateFocusWindow, "negative-focus");
        QVERIFY(probe.windowReady());
        QVERIFY(probe.prepareAndArm());
        QCOMPARE(probe.leafForceCount(), 1);
        QVERIFY(probe.ownerMatchesLeaf());
        QVERIFY(probe.foreignItem());
        probe.foreignItem()->forceActiveFocus(Qt::OtherFocusReason);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!probe.focusUnchanged());
        QVERIFY(probe.armedEvents() > 0);
        QVERIFY(!probe.ownerMatchesLeaf());
        QCOMPARE(m_window->activeFocusItem(), probe.foreignItem());
        QCOMPARE(probe.leafForceCount(), 1);
        QCOMPARE(m_frames.size(), 0);
    }
    void memoryFeedbackAttachedProbeRejectsMissingProperty() {
        loadPanel();
        QVERIFY(m_panel && m_window);
        auto *feedback = fixedMemoryFeedback();
        QVERIFY(feedback);
        QElapsedTimer clock; clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        MemoryFeedbackProbe probe(m_window.get(), m_panel, clock, deadline,
            &RuntimeBridgeTest::setCandidateFocusWindow, "negative-attached");
        QVERIFY(probe.windowReady());
        QVERIFY(probe.prepareAndArm());
        const auto attached = readMemoryFeedbackAttached(feedback, m_engine.get(), feedback->property("text").toString(), true);
        probe.attached(attached);
        QVERIFY(attached.contextPresent && attached.contextValid && attached.engineMatches);
        QVERIFY(!attached.rolePropertyValid && !attached.roleIsProperty);
        QVERIFY(!attached.roleValueValid && !attached.roleConversionOk && !attached.roleMeasured);
        QVERIFY(attached.metadata().value("roleValue").isNull());
        QVERIFY(!attached.metadata().value("fallbackUsed").toBool());
        QVERIFY(!attached.valid());
        QCOMPARE(probe.armedEvents(), 0);
        QVERIFY(probe.ownerMatchesLeaf());
        QVERIFY(probe.focusUnchanged());
        QCOMPARE(m_frames.size(), 0);
    }
    void memoryPageHorizontalScrollbarIsHidden_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626-body") << 591 << 626;
        QTest::newRow("591x546-body") << 591 << 546;
        QTest::newRow("760x650-window") << 760 << 650;
    }
    void memoryPageHorizontalScrollbarIsHidden() {
        QFETCH(int, width);
        QFETCH(int, height);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        QVERIFY(scroll);
        const QQmlProperty horizontalProperty(scroll, "ScrollBar.horizontal", qmlContext(scroll));
        QVERIFY(horizontalProperty.isValid() && horizontalProperty.isProperty());
        auto *horizontal = qobject_cast<QQuickItem *>(horizontalProperty.read().value<QObject *>());
        QVERIFY(horizontal);
        QCOMPARE(horizontal->property("orientation").toInt(), int(Qt::Horizontal));
        QVERIFY(!horizontal->isVisible());
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!horizontal->isVisible());
    }
    void memoryCheckboxCenterInBottomTenPixelsReceivesHit_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626-body") << 591 << 626;
        QTest::newRow("591x546-body") << 591 << 546;
        QTest::newRow("760x650-window") << 760 << 650;
    }
    void memoryCheckboxCenterInBottomTenPixelsReceivesHit() {
        QFETCH(int, width);
        QFETCH(int, height);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *content = feedbackScrollContent();
        auto *choice = batchControl("memorySelect10");
        QVERIFY(scroll && content && choice && choice->isVisible() && choice->isEnabled());
        QCOMPARE(choice->property("memoryId").toString(), batchMemoryId(10));
        const auto viewport = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
        const auto before = choice->mapToScene(QPointF(choice->width() / 2, choice->height() / 2));
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        const auto wanted = content->property("contentY").toDouble() + before.y() - (viewport.bottom() - 9);
        QVERIFY(std::isfinite(wanted) && wanted > minimum && wanted < maximum);
        QVERIFY(content->setProperty("contentY", wanted));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(qAbs(content->property("contentY").toDouble() - wanted) <= .5);
        choice = batchControl("memorySelect10");
        QVERIFY(choice && choice->isVisible() && choice->isEnabled());
        const auto center = choice->mapToScene(QPointF(choice->width() / 2, choice->height() / 2));
        const auto point = center.toPoint();
        const auto bottomDistance = viewport.bottom() - center.y();
        const auto pointBottomDistance = viewport.bottom() - point.y();
        QVERIFY(bottomDistance > 0 && bottomDistance < 10);
        QVERIFY(pointBottomDistance > 0 && pointBottomDistance < 10);
        QVERIFY(viewport.contains(QPointF(point)));
        QVERIFY(NativeControlReadiness::visibleRect(choice, m_window.get()).contains(QPointF(point)));
        QVERIFY(choice->mapRectToScene(QRectF(QPointF(), choice->size())).bottom() > viewport.bottom());
        // Keep the deliberately clipped center in place. batchInput would
        // fully reveal the row and lose the bottom-strip regression fixture.
        const auto hit = NativeCheck::hitTest(m_window.get(), point, choice);
        QVERIFY2(hit.result == "target" || hit.result == "descendant",
                 qPrintable(NativeCheck::describe("BATCH_BOTTOM_STRIP_HIT", hit.metadata())));
        QSignalSpy clicked(choice, SIGNAL(clicked()));
        QSignalSpy toggled(choice, SIGNAL(toggled()));
        QVERIFY(clicked.isValid() && toggled.isValid());
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, point, 0);
        QCOMPARE(clicked.count(), 1);
        QCOMPARE(toggled.count(), 1);
        QCOMPARE(batchSelectedIds(), QVariantList{batchMemoryId(10)});
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
    }
    void memorySelectionBarStaysOutsideScroll_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626-body") << 591 << 626;
        QTest::newRow("591x546-body") << 591 << 546;
        QTest::newRow("760x650-window") << 760 << 650;
    }
    void memorySelectionBarStaysOutsideScroll() {
        QFETCH(int, width);
        QFETCH(int, height);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        auto *bar = batchControl("memorySelectionBar");
        QVERIFY(bar && !bar->isVisible());
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *content = feedbackScrollContent();
        QVERIFY(scroll && content && bar->isVisible());
        QCOMPARE(bar->parentItem(), scroll->parentItem());
        QVERIFY(!scroll->isAncestorOf(bar));
        const auto sceneRect = [](const QQuickItem *item) {
            return item->mapRectToScene(QRectF(QPointF(), item->size()));
        };
        const auto barScene = sceneRect(bar);
        QVERIFY(barScene.top() >= sceneRect(scroll).bottom());
        QVERIFY(!barScene.intersects(sceneRect(scroll)));
        QList<QPair<QQuickItem *, QRectF>> stationary;
        stationary.append({bar, barScene});
        for (const auto *name : {"memorySelectionCount", "memoryDeleteSelected", "memorySelectionCancel"}) {
            auto *item = batchControl(QString::fromLatin1(name));
            QVERIFY(item && bar->isAncestorOf(item));
            stationary.append({item, sceneRect(item)});
        }
        QCOMPARE(batchControl("memorySelectionCount")->property("text").toString(), QString("已选1条"));
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        QVERIFY(maximum - minimum > 40);
        for (const auto offset : {minimum, maximum, minimum + (maximum - minimum) / 2}) {
            QVERIFY(content->setProperty("contentY", offset));
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(qAbs(content->property("contentY").toDouble() - offset) <= .5);
            for (const auto &[item, scene] : stationary) {
                QCOMPARE(sceneRect(item), scene);
                QVERIFY(feedbackItemFullyVisible(item));
            }
            for (const auto *name : {"memoryDeleteSelected", "memorySelectionCancel"}) {
                auto *item = batchControl(QString::fromLatin1(name));
                QVERIFY(item && item->isEnabled());
                const auto point = item->mapToScene(QPointF(item->width() / 2, item->height() / 2)).toPoint();
                const auto hit = NativeCheck::hitTest(m_window.get(), point, item);
                QVERIFY2(hit.accepted(), qPrintable(NativeCheck::describe("BATCH_FIXED_FOOTER_HIT", hit.metadata())));
            }
        }
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        QVERIFY(tabs);
        for (const int segment : {1, 2, 3, 4}) {
            QVERIFY(tabs->setProperty("currentIndex", segment));
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY(m_panel->property("memorySelectionMode").toBool());
            QVERIFY(!bar->isVisible());
        }
        QVERIFY(tabs->setProperty("currentIndex", 0));
        QVERIFY(m_panel->setProperty("page", "character"));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QVERIFY(!bar->isVisible());
        QVERIFY(m_panel->setProperty("page", "memory"));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(bar->isVisible());
        QCOMPARE(sceneRect(bar), barScene);
        QCOMPARE(batchSelectedIds(), QVariantList{batchMemoryId(0)});
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
    }
    void memoryNonselectionScrollHeightMatchesOriginalLayout_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<int>("beforeChangeScrollHeight");
        // In the original full-window fixture, the memory page's outer
        // layout has only its scroll visible: no header, warning or feedback.
        QTest::newRow("591x626-body") << 591 << 626 << 626;
        QTest::newRow("591x546-body") << 591 << 546 << 546;
        QTest::newRow("760x650-window") << 760 << 650 << 650;
    }
    void memoryNonselectionScrollHeightMatchesOriginalLayout() {
        QFETCH(int, width);
        QFETCH(int, height);
        QFETCH(int, beforeChangeScrollHeight);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        trackCandidateFrames();
        m_bridge->invalidateCandidatePaging(true);
        emit m_bridge->changed();
        const QDeadlineTimer noHeaderPreparation(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(noHeaderPreparation));
        const auto page = m_bridge->memoryCandidatePage();
        QVERIFY(!page.value("live").toBool() && !page.value("busy").toBool());
        QVERIFY(!m_bridge->state().contains("candidates"));
        QCOMPARE(page.value("count").toInt(), 0);
        auto *header = batchControl("memoryCandidatePageInfo");
        QVERIFY(header && !header->isVisible());
        const auto baseline = memoryLayoutSnapshot();
        const auto failureGeometry = qScopeGuard([&] {
            if (QTest::currentTestFailed())
                qWarning().noquote() << memoryLayoutDiagnostic(baseline, "no-header-original-layout");
        });
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *bar = batchControl("memorySelectionBar");
        auto *warning = profileItem("runtimeRecoveryWarning", ProfileScope::Page);
        auto *profileBar = profileItem("profileActionBar", ProfileScope::Page);
        auto *feedback = fixedMemoryFeedback();
        QVERIFY(scroll && bar && warning && profileBar && feedback);
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QVERIFY(!bar->isVisible() && !warning->isVisible() && !profileBar->isVisible() && !feedback->isVisible());
        QCOMPARE(m_panel->height(), qreal(height));
        QCOMPARE(scroll->mapToScene(QPointF()).y(), m_panel->mapToScene(QPointF()).y());
        QCOMPARE(scroll->height(), qreal(beforeChangeScrollHeight));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(bar->isVisible());
        QVERIFY(scroll->height() < beforeChangeScrollHeight);
        QVERIFY2(batchInput("memorySelectionCancel"), qPrintable(m_profileDiagnostic));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QVERIFY(!bar->isVisible());
        QCOMPARE(scroll->height(), qreal(beforeChangeScrollHeight));
    }
    void memoryLiveHeaderReservesMeasuredSpaceAndCancelRestoresLayout_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<bool>("empty");
        QTest::newRow("591x626-live-empty") << 591 << 626 << true;
        QTest::newRow("591x546-live-empty") << 591 << 546 << true;
        QTest::newRow("760x650-live-empty") << 760 << 650 << true;
        QTest::newRow("591x626-populated") << 591 << 626 << false;
        QTest::newRow("591x546-populated") << 591 << 546 << false;
        QTest::newRow("760x650-populated") << 760 << 650 << false;
    }
    void memoryLiveHeaderReservesMeasuredSpaceAndCancelRestoresLayout() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, empty);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        trackCandidateFrames();
        if (!empty) {
            m_bridge->firstMemoryCandidates();
            deliverCandidate(candidatePage(candidateRows(1, 3)));
        }
        const QDeadlineTimer preparation(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(preparation));
        auto *header = batchControl("memoryCandidatePageInfo");
        auto *bar = batchControl("memorySelectionBar");
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        QVERIFY(header && bar && scroll && scroll->parentItem());
        const auto baseline = memoryLayoutSnapshot();
        const auto failureGeometry = qScopeGuard([&] {
            if (QTest::currentTestFailed())
                qWarning().noquote() << memoryLayoutDiagnostic(baseline, "live-header-measured-layout");
        });
        const auto page = m_bridge->memoryCandidatePage();
        QVERIFY(page.value("live").toBool() && !page.value("busy").toBool());
        QCOMPARE(page.value("count").toInt(), empty ? 0 : 3);
        QVERIFY(header->isVisible() && feedbackItemFullyVisible(header));
        QVERIFY(!bar->isVisible() && !m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(header->parentItem(), scroll->parentItem());
        bool spacingOk = false;
        const auto spacing = scroll->parentItem()->property("spacing").toDouble(&spacingOk);
        QVERIFY(spacingOk && std::isfinite(spacing) && spacing >= 0);
        QVERIFY(std::isfinite(header->height()) && header->height() > 0);
        const auto reserved = header->height() + spacing;
        const auto panelScene = m_panel->mapRectToScene(QRectF(QPointF(), m_panel->size()));
        const auto headerScene = header->mapRectToScene(QRectF(QPointF(), header->size()));
        const auto scrollScene = scroll->mapRectToScene(QRectF(QPointF(), scroll->size()));
        QVERIFY(qAbs(headerScene.top() - panelScene.top()) <= .5);
        QVERIFY(qAbs(scrollScene.top() - (panelScene.top() + reserved)) <= .5);
        QVERIFY(qAbs(scroll->height() - (m_panel->height() - reserved)) <= .5);
        QVERIFY(qAbs(scrollScene.bottom() - panelScene.bottom()) <= .5);
        const auto frames = m_frames.size();
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(bar->isVisible());
        QVERIFY(header->isVisible() && feedbackItemFullyVisible(header));
        QVERIFY(scroll->height() < scrollScene.height());
        QVERIFY2(batchInput("memorySelectionCancel"), qPrintable(m_profileDiagnostic));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QVERIFY(!bar->isVisible());
        QVERIFY(header->isVisible() && feedbackItemFullyVisible(header));
        QCOMPARE(scroll->mapRectToScene(QRectF(QPointF(), scroll->size())), scrollScene);
        QCOMPARE(header->mapRectToScene(QRectF(QPointF(), header->size())), headerScene);
        QCOMPARE(m_frames.size(), frames);
    }
    void memoryBatchSelectionCancelUsesProductionControls_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626-body") << 591 << 626;
        QTest::newRow("591x546-body") << 591 << 546;
        QTest::newRow("760x650-window") << 760 << 650;
    }
    void memoryBatchSelectionCancelUsesProductionControls() {
        QFETCH(int, width);
        QFETCH(int, height);
        QVERIFY(prepareBatchPanel(batchMemoryRows(), false, {}, width, height));
        QVERIFY2(batchInput("memoryEdit0"), qPrintable(m_profileDiagnostic));
        QCOMPARE(m_panel->property("editingMemoryId").toString(), batchMemoryId(0));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QVERIFY(m_panel->property("editingMemoryId").toString().isEmpty());
        QVERIFY(m_panel->property("deletingMemoryId").toString().isEmpty());
        QVERIFY(batchSelectedIds().isEmpty());
        QVERIFY(batchControl("memoryDeleteSelected") && !batchControl("memoryDeleteSelected")->isEnabled());
        for (int index = 0; index < 3; ++index) {
            for (const auto *kind : {"memoryPin", "memoryEdit", "memoryDelete"}) {
                const auto name = QString::fromLatin1(kind) + QString::number(index);
                const auto *item = batchControl(name);
                QVERIFY2(item && !item->isEnabled(), qPrintable(name));
            }
            const auto *choice = batchControl("memorySelect" + QString::number(index));
            QVERIFY(choice && choice->isVisible() && choice->isEnabled());
            QCOMPARE(choice->property("memoryId").toString(), batchMemoryId(index));
        }
        QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect2", false, true), qPrintable(m_profileDiagnostic));
        const QVariantList selected{batchMemoryId(0), batchMemoryId(2)};
        QCOMPARE(batchSelectedIds(), selected);
        QCOMPARE(batchControl("memorySelectionCount")->property("text").toString(), QString("已选2条"));
        QCOMPARE(m_panel->property("memorySelectedPinnedCount").toInt(), 1);
        const int framesBefore = m_frames.size();
        QVERIFY2(batchInput("memoryDeleteSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchDialog() && batchDialog()->property("opened").toBool());
        QCOMPARE(batchControl("memoryBatchDeleteCount", true)->property("text").toString(),
                 QString("将删除2条记忆，其中已固定1条。"));
        QCOMPARE(batchControl("memoryBatchDeleteExplanation", true)->property("text").toString(),
                 QString("会清除这些记忆及其全部修订，无法恢复。"));
        const QColor glass("#2f4346");
        for (const auto *name : {"memorySelectLabel0", "memorySelectLabel2"}) {
            const auto *label = batchControl(QString::fromLatin1(name));
            QVERIFY(label);
            const auto color = label->property("color").value<QColor>();
            QCOMPARE(color, QColor("#dce9f2"));
            QVERIFY2(NativeCheck::contrastRatio(color, glass) >= 4.5, name);
        }
        for (const auto *name : {"memoryBatchDeleteCount", "memoryBatchDeleteExplanation",
                                 "memoryBatchDeleteCancelLabel", "memoryBatchDeleteConfirmLabel"}) {
            const auto *label = batchControl(QString::fromLatin1(name), true);
            QVERIFY2(label && label->isVisible(), name);
            QCOMPARE(label->property("textFormat").toInt(), 0);
            const auto color = label->property("color").value<QColor>();
            QCOMPARE(color, QColor("#dce9f2"));
            QVERIFY2(NativeCheck::contrastRatio(color, glass) >= 4.5, name);
            const auto scene = label->mapRectToScene(QRectF(QPointF(), label->size()));
            QVERIFY2(NativeControlReadiness::visibleRect(label, m_window.get()).adjusted(-.5, -.5, .5, .5).contains(scene), name);
        }
        for (const auto *name : {"memoryBatchDeleteCancel", "memoryBatchDeleteConfirm"}) {
            const auto *button = batchControl(QString::fromLatin1(name), true);
            const auto *label = batchControl(QString::fromLatin1(name) + "Label", true);
            QVERIFY(button && label);
            QCOMPARE(button->property("contentItem").value<QQuickItem *>(), label);
        }
        QVERIFY2(batchInput("memoryBatchDeleteCancel", true), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!batchDialog()->property("visible").toBool());
        QCOMPARE(m_frames.size(), framesBefore);
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QVERIFY2(batchInput("memorySelectionCancel"), qPrintable(m_profileDiagnostic));
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QVERIFY(batchSelectedIds().isEmpty());
        for (const auto *name : {"memoryPin0", "memoryEdit0", "memoryDelete0"})
            QVERIFY(batchControl(QString::fromLatin1(name)) && batchControl(QString::fromLatin1(name))->isEnabled());
        QCOMPARE(m_frames.size(), framesBefore);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryBatchSelectionClosesAnInlineDeleteConfirmation() {
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memoryDelete0"), qPrintable(m_profileDiagnostic));
        QCOMPARE(m_panel->property("deletingMemoryId").toString(), batchMemoryId(0));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY(m_panel->property("deletingMemoryId").toString().isEmpty());
        const auto row = MemoryActionProbe::findRow(m_panel, batchMemoryId(0));
        const auto *confirm = MemoryActionProbe::rowControl(row, "memoryDeleteConfirm");
        QVERIFY(confirm && !confirm->isVisible());
        QCOMPARE(rendererCommandCount("memory:delete"), 0);
    }
    void memoryBatchSelectionKeepsAppendAndClearsEachReplacement_data() {
        QTest::addColumn<QString>("replacement");
        QTest::newRow("manual-refresh") << QString("refresh");
        QTest::newRow("filter") << QString("filter");
        QTest::newRow("clear-filter") << QString("clear-filter");
        QTest::newRow("persona-scope") << QString("scope");
        QTest::newRow("generation-disconnect") << QString("generation");
        QTest::newRow("ordinary-action-readback") << QString("action");
    }
    void memoryBatchSelectionKeepsAppendAndClearsEachReplacement() {
        QFETCH(QString, replacement);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 2), true, "v1.batch-next"));
        if (replacement == "clear-filter") {
            m_bridge->filterMemories("测试");
            deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(),
                                 batchMemoryRows(0, 2), true, "v1.batch-next");
        }
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
        const int revision = m_bridge->memoryListRevision();
        QVERIFY2(batchInput("memoryLoadMore"), qPrintable(m_profileDiagnostic));
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), batchMemoryRows(2, 2));
        QTRY_VERIFY(batchControl("memorySelect3"));
        QCOMPARE(m_bridge->memoryListRevision(), revision);
        QCOMPARE(batchSelectedIds(), QVariantList{batchMemoryId(0)});
        QVERIFY(batchControl("memorySelect0")->property("checked").toBool());
        QVERIFY2(batchInput("memoryDeleteSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchDialog()->property("opened").toBool());
        if (replacement == "refresh") m_bridge->refreshMemories();
        else if (replacement == "filter") m_bridge->filterMemories("另一个筛选");
        else if (replacement == "clear-filter") m_bridge->filterMemories("");
        else if (replacement == "scope")
            m_bridge->event({{"type", "persona:scope"}, {"payload", QJsonObject{
                {"persona_id", "batch-next-persona"}, {"epoch", 9}, {"fingerprint", "batch-next-fingerprint"}}}});
        else if (replacement == "generation") m_bridge->m_process.finished(1, QProcess::CrashExit);
        else {
            // A memory change outside this UI still replaces the whole list
            // when its authoritative read-back starts.
            m_bridge->setMemoryPinned(batchMemoryId(3), true);
            const auto action = lastRendererCommand("memory:reinforce")["request_id"].toString();
            QVERIFY(!action.isEmpty());
            m_bridge->event({{"type", "memory:result"}, {"request_id", action}, {"payload", QJsonObject{{"ok", true}}}});
        }
        QTRY_VERIFY(batchSelectedIds().isEmpty());
        QTRY_VERIFY(!batchDialog()->property("visible").toBool());
        QVERIFY(m_bridge->memoryListRevision() > revision);
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
    }
    void memoryBatchSelectionOnlyAcceptsOneHundredLoadedIds() {
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 100), true, "v1.batch-last"));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memoryLoadMore"), qPrintable(m_profileDiagnostic));
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), batchMemoryRows(100, 1));
        QTRY_VERIFY(batchControl("memorySelect100"));
        // The boundary fixture populates selection through the same guarded
        // QML function; the user-input contract is covered above and below.
        for (int index = 0; index < 100; ++index) {
            const auto call = NativeCheck::invokeQml(m_panel, "toggleMemorySelection", {batchMemoryId(index), true});
            QVERIFY2(call.invoked, qPrintable(NativeCheck::describe("BATCH_SELECTION_CALL", call.metadata())));
        }
        QCOMPARE(batchSelectedIds().size(), 100);
        QVERIFY(batchControl("memoryDeleteSelected")->isEnabled());
        auto *extra = batchControl("memorySelect100");
        auto *extraLabel = batchControl("memorySelectLabel100");
        QVERIFY(extra && extraLabel && !extra->isEnabled());
        QCOMPARE(extra->property("contentItem").value<QQuickItem *>(), extraLabel);
        QCOMPARE(extraLabel->property("color").value<QColor>(), QColor("#b0bfc4"));
        QVERIFY(NativeCheck::contrastRatio(extraLabel->property("color").value<QColor>(), QColor("#2f4346")) >= 4.5);
        for (const auto &id : {batchMemoryId(100), QString("fact_not_loaded")}) {
            const auto call = NativeCheck::invokeQml(m_panel, "toggleMemorySelection", {id, true});
            QVERIFY(call.invoked);
        }
        QCOMPARE(batchSelectedIds().size(), 100);
        QVERIFY(!batchSelectedIds().contains(batchMemoryId(100)));
        QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
        QCOMPARE(batchSelectedIds().size(), 99);
        QVERIFY(batchControl("memorySelect100")->isEnabled());
        QVERIFY2(batchInput("memorySelect100", false, true), qPrintable(m_profileDiagnostic));
        QCOMPARE(batchSelectedIds().size(), 100);
        QVERIFY(batchSelectedIds().contains(batchMemoryId(100)));
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
    }
    void memoryBatchConfirmationDispatchesOnceAndFollowsItsResult_data() {
        QTest::addColumn<QString>("outcome");
        QTest::newRow("success") << QString("success");
        QTest::newRow("stale-selection") << QString("rejected");
        QTest::newRow("timeout-manual-refresh") << QString("unknown");
    }
    void memoryBatchConfirmationDispatchesOnceAndFollowsItsResult() {
        QFETCH(QString, outcome);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 4), true, "v1.batch-more"));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        for (int index = 0; index < 3; ++index)
            QVERIFY2(batchInput("memorySelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const QVariantList selected{batchMemoryId(0), batchMemoryId(1), batchMemoryId(2)};
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY2(batchInput("memoryDeleteSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchDialog()->property("opened").toBool());
        QCOMPARE(batchControl("memoryBatchDeleteCount", true)->property("text").toString(),
                 QString("将删除3条记忆，其中已固定1条。"));
        const int listBefore = rendererCommandCount("memory:list");
        QVERIFY2(batchInput("memoryBatchDeleteConfirm", true), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!batchDialog()->property("visible").toBool());
        QCOMPARE(rendererCommandCount("memory:delete_many"), 1);
        const auto sent = lastRendererCommand("memory:delete_many");
        const auto requestId = sent["request_id"].toString();
        QVERIFY(!requestId.isEmpty());
        QCOMPARE(sent["payload"].toObject().keys(), QStringList{"memory_ids"});
        QCOMPARE(sent["payload"].toObject()["memory_ids"].toArray(), QJsonArray::fromVariantList(selected));
        QCOMPARE(m_bridge->memoryBatchDelete().value("status").toString(), QString("pending"));
        for (const auto *name : {"memoryPin0", "memoryEdit0", "memoryDelete0", "memoryFilterField", "memoryFilterApply",
                                 "memoryLoadMore", "memoryDeleteSelected", "memoryRefresh", "memoryCandidateFirst"})
            QVERIFY2(batchControl(QString::fromLatin1(name)) && !batchControl(QString::fromLatin1(name))->isEnabled(), name);
        if (outcome == "unknown") {
            m_bridge->expirePending(requestId);
            QTRY_COMPARE(m_bridge->memoryBatchDelete().value("status").toString(), QString("unknown"));
            QVERIFY(m_bridge->memoryBatchDelete().value("blocked").toBool());
            QCOMPARE(rendererCommandCount("memory:list"), listBefore);
            QCOMPARE(batchSelectedIds(), selected);
            QVERIFY(m_panel->property("memorySelectionMode").toBool());
            QVERIFY(batchControl("memoryRefresh")->isEnabled());
            QVERIFY(!batchControl("memoryFilterApply")->isEnabled());
            QVERIFY(!batchControl("memoryDeleteSelected")->isEnabled());
            QVERIFY2(batchInput("memoryRefresh"), qPrintable(m_profileDiagnostic));
            QVERIFY(batchSelectedIds().isEmpty());
            const auto manual = lastRendererCommand("memory:list")["request_id"].toString();
            QVERIFY(!manual.isEmpty() && manual != requestId);
            deliverBatchMemories(manual, batchMemoryRows(3, 1));
            deliverCandidate(candidatePage({}));
            QTRY_COMPARE(m_bridge->memoryBatchDelete().value("status").toString(), QString("refreshed"));
            QVERIFY(!m_bridge->memoryBatchDelete().value("blocked").toBool());
            QVERIFY(batchControl("memoryFilterApply")->isEnabled());
        } else {
            const QJsonObject receipt = outcome == "success"
                ? QJsonObject{{"ok", true}, {"deleted_ids", QJsonArray::fromVariantList(selected)}, {"purged_revisions", 3}}
                : QJsonObject{{"ok", false}, {"error_code", "stale_selection"}, {"stale_ids", QJsonArray{batchMemoryId(1)}}};
            m_bridge->event({{"type", "memory:result"}, {"request_id", requestId}, {"payload", receipt}});
            QTRY_VERIFY(!m_panel->property("memorySelectionMode").toBool());
            QVERIFY(batchSelectedIds().isEmpty());
            QCOMPARE(rendererCommandCount("memory:list"), listBefore + 1);
            const auto readId = lastRendererCommand("memory:list")["request_id"].toString();
            deliverBatchMemories(readId, outcome == "success" ? batchMemoryRows(3, 1) : batchMemoryRows(0, 4));
            deliverCandidate(candidatePage({}));
            QTRY_VERIFY(batchControl("memorySelectMode") && batchControl("memorySelectMode")->isEnabled());
            QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
            QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
            emit m_bridge->changed();
            QVERIFY(m_panel->property("memorySelectionMode").toBool());
            QCOMPARE(batchSelectedIds().size(), 1);
        }
        QCOMPARE(rendererCommandCount("memory:delete_many"), 1);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryBatchDeleteRemainsDisabledForAnUnknownCandidateDecision() {
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        m_bridge->firstMemoryCandidates();
        deliverCandidate(candidatePage(candidateRows(1, 1)));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect0", false, true), qPrintable(m_profileDiagnostic));
        QVERIFY(batchControl("memoryDeleteSelected")->isEnabled());
        m_bridge->decideMemoryCandidate(candidateId(1), true);
        const auto request = lastRendererCommand("memory:candidates:confirm")["request_id"].toString();
        QVERIFY(!request.isEmpty());
        QVERIFY(m_bridge->memoryCandidatePage().value("decisionLocked").toBool());
        QVERIFY(!batchControl("memoryDeleteSelected")->isEnabled());
        m_bridge->expirePending(request);
        QVERIFY(m_bridge->memoryCandidatePage().value("decisionLocked").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
        QVERIFY(!batchControl("memoryDeleteSelected")->isEnabled());
        QVERIFY(QMetaObject::invokeMethod(batchControl("memoryDeleteSelected"), "clicked"));
        QVERIFY(!batchDialog()->property("visible").toBool());
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
    }
    void memoryBatchPinCancelKeepsSelectionAndReopensWithANewRead_data() {
        QTest::addColumn<bool>("pinned");
        QTest::newRow("pin") << true;
        QTest::newRow("unpin") << false;
    }
    void memoryBatchPinCancelKeepsSelectionAndReopensWithANewRead() {
        QFETCH(bool, pinned);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 4)));
        QVERIFY(batchPinDialog());
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        for (int index : {0, 1})
            QVERIFY2(batchInput("memorySelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        const auto button = pinned ? QString("memoryPinSelected") : QString("memoryUnpinSelected");
        const int reads = rendererCommandCount("memory:pin_status");
        const int lists = rendererCommandCount("memory:list");
        QVERIFY2(batchInput(button), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchPinDialog()->property("opened").toBool());
        const auto first = lastRendererCommand("memory:pin_status");
        const auto firstId = first["request_id"].toString();
        QVERIFY(!firstId.isEmpty());
        QCOMPARE(first["payload"].toObject(), (QJsonObject{{"memory_ids", QJsonArray::fromVariantList(selected)}}));
        QCOMPARE(rendererCommandCount("memory:pin_status"), reads + 1);
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
        QVERIFY(!batchControl("memoryBatchPinConfirm", true)->isEnabled());
        deliverBatchPinStatus(firstId, selected, {batchMemoryId(0)}, 17);
        QTRY_VERIFY(batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QCOMPARE(batchControl("memoryBatchPinCapacity", true)->property("text").toString(), QString("当前人格已固定17条／上限20条（读取时状态）；提交时会重新核查容量。"));
        QVERIFY(batchControl("memoryBatchPinCount", true)->property("text").toString().contains(pinned ? "预计固定1条" : "预计取消固定1条"));
        auto *previewFeedback = batchControl("memoryBatchPinPreviewFeedback", true);
        QVERIFY(previewFeedback);
        QVERIFY(!previewFeedback->isVisible());
        if (!pinned)
            QCOMPARE(batchControl("memoryBatchPinExplanation", true)->property("text").toString(),
                     QString("取消后恢复按保留层和保护级别适用的正常淡忘规则，不会立即删除。"));
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
        // Cancel releases the bridge immediately, before Popup's exit
        // transition finishes and before another opening can be attempted.
        QCOMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("idle"));
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
        QTRY_VERIFY(!batchPinDialog()->property("visible").toBool());
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
        QCOMPARE(rendererCommandCount("memory:list"), lists);
        QVERIFY2(batchInput(button), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchPinDialog()->property("opened").toBool());
        const auto secondId = lastRendererCommand("memory:pin_status")["request_id"].toString();
        QVERIFY(!secondId.isEmpty() && secondId != firstId);
        QCOMPARE(rendererCommandCount("memory:pin_status"), reads + 2);
        // A canceled preview cannot make the reopened confirmation writable.
        deliverBatchPinStatus(firstId, selected, {batchMemoryId(0)}, 17);
        QVERIFY(!batchControl("memoryBatchPinConfirm", true)->isEnabled());
        deliverBatchPinStatus(secondId, selected, {batchMemoryId(0)}, 17);
        QTRY_VERIFY(batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
    }
    void memoryBatchPinNoopAndGlobalCapacityDisableWrites_data() {
        QTest::addColumn<bool>("pinned");
        QTest::addColumn<int>("target");
        QTest::addColumn<int>("total");
        QTest::addColumn<bool>("noop");
        QTest::newRow("pin-noop-above-legacy-cap") << true << 0 << 23 << true;
        QTest::newRow("unpin-noop") << false << 1 << 23 << true;
        QTest::newRow("global-capacity-not-visible-page-count") << true << 1 << 20 << false;
    }
    void memoryBatchPinNoopAndGlobalCapacityDisableWrites() {
        QFETCH(bool, pinned);
        QFETCH(int, target);
        QFETCH(int, total);
        QFETCH(bool, noop);
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect" + QString::number(target), false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput(pinned ? "memoryPinSelected" : "memoryUnpinSelected"), qPrintable(m_profileDiagnostic));
        deliverBatchPinStatus(lastRendererCommand("memory:pin_status")["request_id"].toString(), selected, {batchMemoryId(0)}, total);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("ready"));
        QVERIFY(!batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QCOMPARE(batchControl("memoryBatchPinCapacity", true)->property("text").toString(),
                 QString("当前人格已固定%1条／上限20条（读取时状态）；提交时会重新核查容量。").arg(total));
        auto *previewFeedback = batchControl("memoryBatchPinPreviewFeedback", true);
        QVERIFY(previewFeedback && previewFeedback->isVisible());
        QVERIFY(!previewFeedback->property("text").toString().isEmpty());
        if (noop)
            QCOMPARE(batchControl("memoryBatchPinConfirm", true)->property("text").toString(), QString("无需更改"));
        else
            QVERIFY(batchControl("memoryBatchPinPreviewFeedback", true)->property("text").toString().contains("超过"));
        QVERIFY(QMetaObject::invokeMethod(batchControl("memoryBatchPinConfirm", true), "clicked"));
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
    }
    void memoryBatchPinPreviewFailureKeepsUnknownCounts_data() {
        QTest::addColumn<bool>("timeout");
        QTest::newRow("read-error") << false;
        QTest::newRow("read-timeout") << true;
    }
    void memoryBatchPinPreviewFailureKeepsUnknownCounts() {
        QFETCH(bool, timeout);
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect1", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(batchPinDialog()->property("opened").toBool());
        const auto id = lastRendererCommand("memory:pin_status")["request_id"].toString();
        if (timeout) m_bridge->expirePending(id);
        else m_bridge->event({{"type", "memory:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", false}, {"error_code", "memory_unavailable"}}}});
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("preview_error"));
        QVERIFY(batchPinDialog()->property("visible").toBool());
        QCOMPARE(batchControl("memoryBatchPinCapacity", true)->property("text").toString(), QString("当前人格的固定数量尚未确认。"));
        auto *previewFeedback = batchControl("memoryBatchPinPreviewFeedback", true);
        QVERIFY(previewFeedback && previewFeedback->isVisible());
        QVERIFY(!previewFeedback->property("text").toString().isEmpty());
        QVERIFY(!batchControl("memoryBatchPinCount", true)->property("text").toString().contains("预计"));
        QVERIFY(!batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
    }
    void memoryBatchPinConfirmationWaitsForBothOwnedReads_data() {
        QTest::addColumn<bool>("pinned");
        QTest::addColumn<bool>("statusFirst");
        QTest::addColumn<bool>("actualChange");
        QTest::newRow("pin-status-first") << true << true << true;
        QTest::newRow("pin-list-first") << true << false << true;
        QTest::newRow("unpin-status-first-above-legacy-cap") << false << true << true;
        QTest::newRow("unpin-list-first-above-legacy-cap") << false << false << true;
        QTest::newRow("actual-noop-after-changing-preview") << true << false << false;
    }
    void memoryBatchPinConfirmationWaitsForBothOwnedReads() {
        QFETCH(bool, pinned);
        QFETCH(bool, statusFirst);
        QFETCH(bool, actualChange);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 4), true, "v1.pin-next"));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        for (int index : {0, 1})
            QVERIFY2(batchInput("memorySelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput(pinned ? "memoryPinSelected" : "memoryUnpinSelected"), qPrintable(m_profileDiagnostic));
        const auto previewId = lastRendererCommand("memory:pin_status")["request_id"].toString();
        deliverBatchPinStatus(previewId, selected, {batchMemoryId(0)}, pinned ? 18 : 25);
        QTRY_VERIFY(batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QCOMPARE(m_bridge->memoryBatchPin().value("expectedChangedCount").toInt(), 1);
        const int lists = rendererCommandCount("memory:list");
        QVERIFY2(batchInput("memoryBatchPinConfirm", true), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!batchPinDialog()->property("visible").toBool());
        const auto sent = lastRendererCommand("memory:pin_many");
        const auto requestId = sent["request_id"].toString();
        QVERIFY(!requestId.isEmpty() && requestId != previewId);
        const QJsonObject expectedPayload{{"memory_ids", QJsonArray::fromVariantList(selected)}, {"pinned", pinned}};
        QCOMPARE(sent["payload"].toObject(), expectedPayload);
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
        QVERIFY(QMetaObject::invokeMethod(batchControl("memoryBatchPinConfirm", true), "clicked"));
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
        for (const auto *name : {"memoryDeleteSelected", "memoryPinSelected", "memoryUnpinSelected", "memoryFilterField",
                                 "memoryFilterApply", "memoryLoadMore", "memoryCandidateFirst", "memorySelectionCancel"})
            QVERIFY2(batchControl(name) && !batchControl(name)->isEnabled(), name);
        QCOMPARE(rendererCommandCount("memory:list"), lists);
        const int before = pinned ? (actualChange ? 18 : 19) : 25;
        const int after = before + (actualChange ? (pinned ? 1 : -1) : 0);
        const QVariantList changed = actualChange ? QVariantList{batchMemoryId(pinned ? 1 : 0)} : QVariantList{};
        deliverBatchPinAck(requestId, selected, pinned, changed, before, after);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("reading"));
        const auto pinState = m_bridge->memoryBatchPin();
        const auto statusId = pinState.value("statusReadId").toString();
        const auto listId = pinState.value("listReadId").toString();
        QVERIFY(!statusId.isEmpty() && !listId.isEmpty() && statusId != listId && statusId != previewId && listId != requestId);
        QCOMPARE(lastRendererCommand("memory:pin_status")["payload"].toObject(), (QJsonObject{{"memory_ids", QJsonArray::fromVariantList(selected)}}));
        QCOMPARE(rendererCommandCount("memory:list"), lists + 1);
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        const QSet<QString> pinnedIds = pinned ? QSet<QString>{batchMemoryId(0), batchMemoryId(1)} : QSet<QString>{};
        if (statusFirst) deliverBatchPinStatus(statusId, selected, pinnedIds, after);
        else deliverBatchMemories(listId, batchPinReadRows(batchMemoryRows(0, 4), selected, pinned));
        QCOMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("reading"));
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        // The selection bar legitimately disappears at completion. Keep the
        // focus baseline outside it so hiding a focused button is not
        // mistaken for feedback moving focus.
        QQuickItem focusSentinel(m_window->contentItem());
        focusSentinel.setWidth(1);
        focusSentinel.setHeight(1);
        focusSentinel.forceActiveFocus(Qt::OtherFocusReason);
        QCOMPARE(m_window->activeFocusItem(), &focusSentinel);
        if (statusFirst) deliverBatchMemories(listId, batchPinReadRows(batchMemoryRows(0, 4), selected, pinned));
        else deliverBatchPinStatus(statusId, selected, pinnedIds, after);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("success"));
        QTRY_VERIFY(batchSelectedIds().isEmpty());
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(m_bridge->memoryBatchPin().value("actualChangedCount").toInt(), actualChange ? 1 : 0);
        auto *feedback = batchControl("memoryBatchPinFeedback");
        QVERIFY(feedback && feedback->isVisible());
        QVERIFY(!feedback->activeFocusOnTab());
        QVERIFY(feedback->property("text").toString().contains(QString("实际%1%2条").arg(pinned ? "固定" : "取消固定").arg(actualChange ? 1 : 0)));
        QCOMPARE(m_window->activeFocusItem(), &focusSentinel);
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
        QCOMPARE(rendererCommandCount("memory:delete_many"), 0);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryBatchPinRejectedReceiptRetainsSelectionAndInvalidatesDialog() {
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect1", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        const auto preview = lastRendererCommand("memory:pin_status")["request_id"].toString();
        deliverBatchPinStatus(preview, selected, {}, 19);
        QVERIFY2(batchInput("memoryBatchPinConfirm", true), qPrintable(m_profileDiagnostic));
        const auto write = lastRendererCommand("memory:pin_many")["request_id"].toString();
        const int lists = rendererCommandCount("memory:list");
        m_bridge->event({{"type", "memory:result"}, {"request_id", write},
            {"payload", QJsonObject{{"ok", false}, {"error_code", "pin_limit_exceeded"}}}});
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("rejected"));
        QTRY_VERIFY(!batchPinDialog()->property("visible").toBool());
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:list"), lists);
        QVERIFY(!m_panel->property("memoryPinConfirmationReady").toBool());
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        const auto next = lastRendererCommand("memory:pin_status")["request_id"].toString();
        QVERIFY(!next.isEmpty() && next != preview);
        QVERIFY(!batchControl("memoryBatchPinConfirm", true)->isEnabled());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
    }
    void memoryBatchPinFailedOwnedReadKeepsSelection_data() {
        QTest::addColumn<bool>("statusFails");
        QTest::newRow("status-read-fails") << true;
        QTest::newRow("list-read-fails") << false;
    }
    void memoryBatchPinFailedOwnedReadKeepsSelection() {
        QFETCH(bool, statusFails);
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect1", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        deliverBatchPinStatus(lastRendererCommand("memory:pin_status")["request_id"].toString(), selected, {}, 5);
        QVERIFY2(batchInput("memoryBatchPinConfirm", true), qPrintable(m_profileDiagnostic));
        const auto write = lastRendererCommand("memory:pin_many")["request_id"].toString();
        deliverBatchPinAck(write, selected, true, selected, 5, 6);
        const auto state = m_bridge->memoryBatchPin();
        const auto failedRead = state.value(statusFails ? "statusReadId" : "listReadId").toString();
        m_bridge->event({{"type", "memory:result"}, {"request_id", failedRead},
            {"payload", QJsonObject{{"ok", false}, {"error_code", "memory_unavailable"}}}});
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("unknown"));
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QVERIFY(batchControl("memoryRefresh")->isEnabled());
        QVERIFY(!batchControl("memoryPinSelected")->isEnabled());
        QVERIFY(!batchControl("memoryDeleteSelected")->isEnabled());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
    }
    void memoryBatchPinUnknownClearsOnlyAfterManualDualRead() {
        QVERIFY(prepareBatchPanel(batchMemoryRows()));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memorySelect1", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = batchSelectedIds();
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        deliverBatchPinStatus(lastRendererCommand("memory:pin_status")["request_id"].toString(), selected, {}, 5);
        QVERIFY2(batchInput("memoryBatchPinConfirm", true), qPrintable(m_profileDiagnostic));
        const auto write = lastRendererCommand("memory:pin_many")["request_id"].toString();
        m_bridge->expirePending(write);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("unknown"));
        QTRY_VERIFY(!batchPinDialog()->property("visible").toBool());
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY2(batchInput("memoryRefresh"), qPrintable(m_profileDiagnostic));
        const auto state = m_bridge->memoryBatchPin();
        const auto listId = state.value("listReadId").toString();
        const auto statusId = state.value("statusReadId").toString();
        QVERIFY(!listId.isEmpty() && !statusId.isEmpty() && listId != statusId);
        QCOMPARE(batchSelectedIds(), selected);
        deliverBatchMemories(listId, batchMemoryRows());
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        // A manual read can observe the old value; it resolves freshness,
        // without converting the timed-out write into a confirmed success.
        deliverBatchPinStatus(statusId, selected, {}, 5);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("refreshed"));
        QTRY_VERIFY(batchSelectedIds().isEmpty());
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
    }
    void memoryBatchPin450thTargetSurvivesFirstPageReplacementUntilStatusRead() {
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 100), true, "v1.pin-page-1"));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        for (int first = 100; first < 500; first += 100) {
            QVERIFY2(batchInput("memoryLoadMore"), qPrintable(m_profileDiagnostic));
            deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), batchMemoryRows(first, 100),
                                 first < 400, "v1.pin-page-" + QString::number(first / 100 + 1));
        }
        QTRY_VERIFY(batchControl("memorySelect449"));
        QVERIFY2(batchInput("memorySelect449", false, true), qPrintable(m_profileDiagnostic));
        const QVariantList selected{batchMemoryId(449)};
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY2(batchInput("memoryPinSelected"), qPrintable(m_profileDiagnostic));
        deliverBatchPinStatus(lastRendererCommand("memory:pin_status")["request_id"].toString(), selected, {}, 5);
        QVERIFY2(batchInput("memoryBatchPinConfirm", true), qPrintable(m_profileDiagnostic));
        deliverBatchPinAck(lastRendererCommand("memory:pin_many")["request_id"].toString(), selected, true, selected, 5, 6);
        const auto state = m_bridge->memoryBatchPin();
        QCOMPARE(batchSelectedIds(), selected);
        deliverBatchMemories(state.value("listReadId").toString(), batchMemoryRows(0, 100), true, "v1.pin-after");
        QTRY_VERIFY(!batchControl("memorySelect449"));
        QCOMPARE(batchSelectedIds(), selected);
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("reading"));
        deliverBatchPinStatus(state.value("statusReadId").toString(), selected, {batchMemoryId(449)}, 6);
        QTRY_COMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("success"));
        QTRY_VERIFY(batchSelectedIds().isEmpty());
        QVERIFY(!m_panel->property("memorySelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:pin_many"), 1);
    }
    void memoryBatchPinNarrowBarAndConfirmationKeepWholeLabels_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<bool>("pinned");
        QTest::newRow("591x626-pin") << 591 << 626 << true;
        QTest::newRow("591x546-pin") << 591 << 546 << true;
        QTest::newRow("760x650-pin") << 760 << 650 << true;
        QTest::newRow("591x626-unpin") << 591 << 626 << false;
        QTest::newRow("591x546-unpin") << 591 << 546 << false;
        QTest::newRow("760x650-unpin") << 760 << 650 << false;
    }
    void memoryBatchPinNarrowBarAndConfirmationKeepWholeLabels() {
        QFETCH(int, width);
        QFETCH(int, height);
        QFETCH(bool, pinned);
        QVERIFY(prepareBatchPanel(batchMemoryRows(0, 80), false, {}, width, height));
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        for (int index : {0, 1})
            QVERIFY2(batchInput("memorySelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *bar = batchControl("memorySelectionBar");
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        QVERIFY(bar && scroll && bar->parentItem() == scroll->parentItem() && !scroll->isAncestorOf(bar));
        for (const auto *name : {"memorySelectionCount", "memoryPinSelected", "memoryUnpinSelected", "memoryDeleteSelected", "memorySelectionCancel"}) {
            auto *item = batchControl(name);
            QVERIFY2(item && item->isVisible() && feedbackItemFullyVisible(item), name);
        }
        QVERIFY2(batchInput(pinned ? "memoryPinSelected" : "memoryUnpinSelected"), qPrintable(m_profileDiagnostic));
        deliverBatchPinStatus(lastRendererCommand("memory:pin_status")["request_id"].toString(), batchSelectedIds(), {batchMemoryId(0)}, 17);
        QTRY_VERIFY(batchPinDialog()->property("opened").toBool());
        const QDeadlineTimer dialogDeadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(dialogDeadline));
        auto *previewFeedback = batchControl("memoryBatchPinPreviewFeedback", true);
        QVERIFY(previewFeedback);
        QVERIFY(!previewFeedback->isVisible());
        for (const auto *name : {"memoryBatchPinCount", "memoryBatchPinCapacity", "memoryBatchPinExplanation", "memoryBatchPinCancel", "memoryBatchPinConfirm"}) {
            auto *item = batchControl(name, true);
            QVERIFY2(item && item->isVisible() && feedbackItemFullyVisible(item), name);
            if (item->property("wrapMode").isValid())
                QVERIFY2(item->height() + .5 >= item->property("contentHeight").toDouble(), name);
        }
        QVERIFY2(batchInput("memoryBatchPinCancel", true), qPrintable(m_profileDiagnostic));
        QCOMPARE(rendererCommandCount("memory:pin_many"), 0);
    }
    void memoryCandidateBatchPreviewCancelAndConfirmCloseTheLoop_data() {
        QTest::addColumn<bool>("confirm");
        QTest::newRow("confirm") << true;
        QTest::newRow("reject") << false;
    }
    void memoryCandidateBatchPreviewCancelAndConfirmCloseTheLoop() {
        QFETCH(bool, confirm);
        QVERIFY(prepareCandidateBatchPanel());
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY(m_panel->property("candidateSelectionMode").toBool());
        QVERIFY(!batchControl("memorySelectMode")->isEnabled());
        QVERIFY(!batchControl("memoryCandidateConfirm0")->isVisible());
        for (int index : {0, 1})
            QVERIFY2(batchInput("memoryCandidateSelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const auto selected = candidateSelectedIds();
        QCOMPARE(selected, (QVariantList{candidateId(1), candidateId(2)}));
        const auto button = confirm ? QString("memoryCandidateConfirmSelected") : QString("memoryCandidateRejectSelected");
        QVERIFY2(batchInput(button), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
        const auto first = lastRendererCommand("memory:candidates:status");
        const auto firstId = first["request_id"].toString();
        QCOMPARE(first["payload"].toObject(), (QJsonObject{{"candidate_ids", QJsonArray::fromVariantList(selected)}}));
        QVERIFY(!batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        const QVariantList replace{candidateId(2)};
        deliverCandidateBatchStatus(firstId, candidateBatchSnapshot(selected, replace, replace));
        QTRY_VERIFY(batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        QCOMPARE(batchControl("memoryCandidateBatchCount", true)->property("text").toString(), confirm
            ? QString("已选2条：将新增1条、替换已有记忆1条（旧内容保留为历史版本），0条与现有记忆相同无需新增。")
            : QString("将不记2条，这些候选不会成为记忆。"));
        QCOMPARE(batchControl("memoryCandidateBatchPinned", true)->isVisible(), confirm);
        if (confirm)
            QCOMPARE(batchControl("memoryCandidateBatchPinned", true)->property("text").toString(),
                     QString("其中1条已固定，替换后的新记忆不再固定。"));
        QVERIFY(!batchControl("memoryCandidateBatchPreviewFeedback", true)->isVisible());
        QVERIFY2(batchInput("memoryCandidateBatchCancel", true), qPrintable(m_profileDiagnostic));
        QCOMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("idle"));
        QTRY_VERIFY(!candidateBatchDialog()->property("visible").toBool());
        QCOMPARE(candidateSelectedIds(), selected);
        QVERIFY(m_panel->property("candidateSelectionMode").toBool());
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 0);
        QVERIFY2(batchInput(button), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
        const auto secondId = lastRendererCommand("memory:candidates:status")["request_id"].toString();
        QVERIFY(!secondId.isEmpty() && secondId != firstId);
        // A canceled preview cannot make the reopened confirmation writable.
        deliverCandidateBatchStatus(firstId, candidateBatchSnapshot(selected, replace, replace));
        QVERIFY(!batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        deliverCandidateBatchStatus(secondId, candidateBatchSnapshot(selected, replace, replace));
        QTRY_VERIFY(batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        QVERIFY2(batchInput("memoryCandidateBatchConfirm", true), qPrintable(m_profileDiagnostic));
        const auto write = lastRendererCommand("memory:candidates:decide_many");
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 1);
        QCOMPARE(write["payload"].toObject(), (QJsonObject{{"candidate_ids", QJsonArray::fromVariantList(selected)},
                                                           {"decision", confirm ? "confirm" : "reject"}}));
        QTRY_VERIFY(!candidateBatchDialog()->property("visible").toBool());
        QJsonObject receipt{{"ok", true}, {"candidate_ids", QJsonArray::fromVariantList(selected)},
                            {"decision", confirm ? "confirm" : "reject"}};
        if (confirm) {
            receipt.insert("confirmed", QJsonArray{
                QJsonObject{{"candidate_id", candidateId(1)}, {"memory_id", "fact_new_1"}, {"replaced_memory_id", ""}, {"idempotent", false}},
                QJsonObject{{"candidate_id", candidateId(2)}, {"memory_id", "fact_new_2"}, {"replaced_memory_id", batchMemoryId(0)}, {"idempotent", false}}});
            receipt.insert("new_ids", QJsonArray{candidateId(1)});
            receipt.insert("replace_ids", QJsonArray{candidateId(2)});
            receipt.insert("same_ids", QJsonArray{});
            receipt.insert("replaced_pinned_ids", QJsonArray{candidateId(2)});
        } else {
            receipt.insert("rejected_ids", QJsonArray::fromVariantList(selected));
        }
        m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", write["request_id"].toString()}, {"payload", receipt}});
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("reading"));
        QCOMPARE(candidateSelectedIds(), selected);
        const auto read = m_bridge->memoryCandidateBatch();
        deliverCandidateBatchStatus(read.value("statusReadId").toString(),
                                    candidateBatchSnapshot(selected, {}, {}, confirm ? "confirmed" : "rejected"));
        deliverCandidate(candidatePage(candidateRows(3, 1)), read.value("candidateReadId").toString());
        QJsonArray rows;
        if (confirm)
            for (const auto *id : {"fact_new_1", "fact_new_2"})
                rows.append(QJsonObject{{"id", id}, {"text", "新记忆"}, {"pinned", false}, {"revision", 1}});
        for (const auto &row : batchMemoryRows(1, 2))
            rows.append(row);
        deliverBatchMemories(read.value("listReadId").toString(), rows);
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("success"));
        QTRY_VERIFY(!m_panel->property("candidateSelectionMode").toBool());
        QVERIFY(candidateSelectedIds().isEmpty());
        auto *feedback = batchControl("memoryCandidateBatchFeedback");
        QVERIFY(feedback && feedback->isVisible());
        QCOMPARE(feedback->property("text").toString(), confirm
            ? QString("已记住 2 条：新增 1 条，替换已有记忆 1 条，0 条与现有记忆相同未新增。")
            : QString("已不记 2 条，这些候选不会成为记忆。"));
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 1);
    }
    void memoryCandidateBatchSameFactKeepsConfirmDisabled() {
        QVERIFY(prepareCandidateBatchPanel());
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        for (int index : {0, 1})
            QVERIFY2(batchInput("memoryCandidateSelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const auto selected = candidateSelectedIds();
        QVERIFY2(batchInput("memoryCandidateConfirmSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
        auto snapshot = candidateBatchSnapshot(selected);
        snapshot["conflict_groups"] = QJsonArray{QJsonArray::fromVariantList(selected)};
        deliverCandidateBatchStatus(lastRendererCommand("memory:candidates:status")["request_id"].toString(), snapshot);
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("ready"));
        QVERIFY(!batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        auto *preview = batchControl("memoryCandidateBatchPreviewFeedback", true);
        QVERIFY(preview && preview->isVisible());
        QCOMPARE(preview->property("text").toString(), QString("所选候选中有 2 条属于同一事实，确认后会互相替换；请分开处理。"));
        QVERIFY(QMetaObject::invokeMethod(batchControl("memoryCandidateBatchConfirm", true), "clicked"));
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 0);
        QCOMPARE(candidateSelectedIds(), selected);
        QVERIFY2(batchInput("memoryCandidateBatchCancel", true), qPrintable(m_profileDiagnostic));
    }
    void memoryCandidateBatchUnknownUsesFirstButtonAndThreeFreshReads_data() {
        QTest::addColumn<QString>("source");
        QTest::addColumn<QString>("lastRead");
        for (const auto &source : QStringList{"write-timeout", "list-failure"})
            for (const auto &last : QStringList{"status", "candidates", "memory"})
                QTest::newRow(qPrintable(source + "-" + last + "-last")) << source << last;
    }
    void memoryCandidateBatchUnknownUsesFirstButtonAndThreeFreshReads() {
        QFETCH(QString, source); QFETCH(QString, lastRead);
        QVERIFY(prepareCandidateBatchPanel());
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memoryCandidateSelect0", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = candidateSelectedIds();
        QVERIFY2(batchInput("memoryCandidateRejectSelected"), qPrintable(m_profileDiagnostic));
        const auto preview = lastRendererCommand("memory:candidates:status")["request_id"].toString();
        deliverCandidateBatchStatus(preview, candidateBatchSnapshot(selected));
        QVERIFY2(batchInput("memoryCandidateBatchConfirm", true), qPrintable(m_profileDiagnostic));
        const auto write = lastRendererCommand("memory:candidates:decide_many")["request_id"].toString();
        const QJsonObject receipt{{"ok", true}, {"decision", "reject"},
            {"candidate_ids", QJsonArray::fromVariantList(selected)}, {"rejected_ids", QJsonArray::fromVariantList(selected)}};
        QVariantMap oldReads;
        if (source == "write-timeout") m_bridge->expirePending(write);
        else {
            m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", write}, {"payload", receipt}});
            oldReads = m_bridge->memoryCandidateBatch();
            m_bridge->event({{"type", "error"}, {"request_id", oldReads.value("listReadId").toString()},
                             {"payload", QJsonObject{{"error", "unavailable"}}}});
        }
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("unknown"));
        QTRY_VERIFY(!candidateBatchDialog()->property("visible").toBool());
        QCOMPARE(candidateSelectedIds(), selected);
        QVERIFY(m_panel->property("candidateSelectionMode").toBool());
        for (const auto *name : {"memoryCandidateConfirmSelected", "memoryCandidateRejectSelected",
                                 "memoryCandidateSelectionCancel", "memorySelectMode", "memoryCandidateSelect0",
                                 "memoryFilterApply", "memoryLoadMore"}) {
            auto *item = batchControl(name);
            QVERIFY2(item && !item->isEnabled(), name);
        }
        QVERIFY(batchControl("memoryCandidateFirst") && batchControl("memoryCandidateFirst")->isEnabled());
        const int statuses = rendererCommandCount("memory:candidates:status");
        const int candidates = rendererCommandCount("memory:candidates:list");
        const int memories = rendererCommandCount("memory:list");
        // Use a real mouse click on the production button while selection is kept.
        QVERIFY2(batchInput("memoryCandidateFirst"), qPrintable(m_profileDiagnostic));
        const auto read = m_bridge->memoryCandidateBatch();
        QCOMPARE(read.value("status").toString(), QString("reading"));
        QVERIFY(read.value("manual").toBool());
        QCOMPARE(rendererCommandCount("memory:candidates:status"), statuses + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), candidates + 1);
        QCOMPARE(rendererCommandCount("memory:list"), memories + 1);
        QSet<QString> readIds;
        for (const auto &key : QStringList{"statusReadId", "candidateReadId", "listReadId"}) {
            const auto id = read.value(key).toString();
            QVERIFY(!id.isEmpty() && id != preview && id != write && read.value(key) != oldReads.value(key));
            readIds.insert(id);
        }
        QCOMPARE(readIds.size(), 3);
        QVERIFY(!batchControl("memoryCandidateFirst")->isEnabled());
        QVERIFY(!batchControl("memoryCandidateRejectSelected")->isEnabled());
        QCOMPARE(candidateSelectedIds(), selected);
        // Timed-out writes and older reads cannot settle the manual attempt.
        m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", write}, {"payload", receipt}});
        deliverCandidateBatchStatus(preview, candidateBatchSnapshot(selected));
        if (!oldReads.isEmpty()) {
            deliverCandidateBatchStatus(oldReads.value("statusReadId").toString(),
                                        candidateBatchSnapshot(selected, {}, {}, "rejected"));
            deliverCandidate(candidatePage(candidateRows(3, 1)), oldReads.value("candidateReadId").toString());
            deliverBatchMemories(oldReads.value("listReadId").toString(), batchMemoryRows(0, 3));
        }
        QCOMPARE(m_bridge->memoryCandidateBatch(), read);
        const QHash<QString, std::function<void()>> deliver{
            {"status", [&] { deliverCandidateBatchStatus(read.value("statusReadId").toString(),
                                                        candidateBatchSnapshot(selected)); }},
            {"candidates", [&] { deliverCandidate(candidatePage(candidateRows(1, 3)),
                                                  read.value("candidateReadId").toString()); }},
            {"memory", [&] { deliverBatchMemories(read.value("listReadId").toString(), batchMemoryRows(0, 3)); }}};
        for (const auto &key : QStringList{"status", "candidates", "memory"})
            if (key != lastRead) deliver.value(key)();
        QCOMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("reading"));
        QVERIFY(m_bridge->memoryCandidateBatch().value("blocked").toBool());
        QCOMPARE(candidateSelectedIds(), selected);
        QVERIFY(m_panel->property("candidateSelectionMode").toBool());
        QVERIFY(!batchControl("memoryCandidateConfirmSelected")->isEnabled());
        deliver.value(lastRead)();
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("refreshed"));
        QTRY_VERIFY(!m_panel->property("candidateSelectionMode").toBool());
        QVERIFY(candidateSelectedIds().isEmpty());
        QVERIFY(!m_bridge->memoryCandidateBatch().value("blocked").toBool());
        QVERIFY(batchControl("memoryCandidateBatchFeedback")->property("text").toString().contains("未确认为成功"));
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 1);
    }
    void memoryCandidateBatchPersonaChangeClearsSelectionAndDialog_data() {
        QTest::addColumn<QString>("phase");
        for (const auto &phase : QStringList{"selection", "previewing", "ready", "reading", "unknown"})
            QTest::newRow(qPrintable(phase)) << phase;
    }
    void memoryCandidateBatchPersonaChangeClearsSelectionAndDialog() {
        QFETCH(QString, phase);
        QVERIFY(prepareCandidateBatchPanel());
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memoryCandidateSelect0", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = candidateSelectedIds();
        QString preview, write;
        if (phase != "selection") {
            QVERIFY2(batchInput("memoryCandidateRejectSelected"), qPrintable(m_profileDiagnostic));
            QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
            preview = lastRendererCommand("memory:candidates:status")["request_id"].toString();
            if (phase != "previewing") deliverCandidateBatchStatus(preview, candidateBatchSnapshot(selected));
            if (phase == "reading" || phase == "unknown") {
                QVERIFY2(batchInput("memoryCandidateBatchConfirm", true), qPrintable(m_profileDiagnostic));
                write = lastRendererCommand("memory:candidates:decide_many")["request_id"].toString();
                if (phase == "unknown") m_bridge->expirePending(write);
                else m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", write},
                    {"payload", QJsonObject{{"ok", true}, {"decision", "reject"},
                        {"candidate_ids", QJsonArray::fromVariantList(selected)},
                        {"rejected_ids", QJsonArray::fromVariantList(selected)}}}});
            }
        }
        const auto oldBatch = m_bridge->memoryCandidateBatch();
        const auto previousScope = m_bridge->scopeKey();
        m_bridge->event({{"type", "persona:scope"}, {"payload", QJsonObject{
            {"persona_id", "candidate-batch-next-persona"}, {"epoch", 9},
            {"fingerprint", "candidate-batch-next-fingerprint"}}}});
        QVERIFY(m_bridge->scopeKey() != previousScope);
        QTRY_VERIFY(candidateSelectedIds().isEmpty());
        QTRY_VERIFY(!m_panel->property("candidateSelectionMode").toBool());
        QTRY_VERIFY(!candidateBatchDialog()->property("visible").toBool());
        QCOMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("idle"));
        QVERIFY(!m_bridge->memoryCandidateBatch().value("blocked").toBool());
        const int framesAfterScope = m_frames.size();
        if (!preview.isEmpty()) deliverCandidateBatchStatus(preview, candidateBatchSnapshot(selected));
        if (!write.isEmpty())
            m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", write},
                {"payload", QJsonObject{{"ok", true}, {"decision", "reject"},
                    {"candidate_ids", QJsonArray::fromVariantList(selected)},
                    {"rejected_ids", QJsonArray::fromVariantList(selected)}}}});
        if (phase == "reading") {
            deliverCandidateBatchStatus(oldBatch.value("statusReadId").toString(),
                                        candidateBatchSnapshot(selected, {}, {}, "rejected"));
            deliverCandidate(candidatePage(candidateRows(3, 1)), oldBatch.value("candidateReadId").toString());
            deliverBatchMemories(oldBatch.value("listReadId").toString(), batchMemoryRows(0, 3));
        }
        QCOMPARE(m_frames.size(), framesAfterScope);
        QVERIFY(candidateSelectedIds().isEmpty());
        QVERIFY(!m_panel->property("candidateSelectionMode").toBool());
        QVERIFY(!candidateBatchDialog()->property("visible").toBool());
        m_bridge->refreshMemories();
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), batchMemoryRows(3, 2));
        deliverCandidate(candidatePage(candidateRows(4, 2)));
        QTRY_VERIFY(batchControl("memorySelectMode")->isEnabled());
        QTRY_VERIFY(batchControl("memoryCandidateSelectMode")->isEnabled());
        QVERIFY(candidateSelectedIds().isEmpty());
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), write.isEmpty() ? 0 : 1);
    }
    void memoryCandidateBatchPreviewFailureShowsNoCounts_data() {
        QTest::addColumn<bool>("timeout");
        QTest::newRow("read-error") << false;
        QTest::newRow("read-timeout") << true;
    }
    void memoryCandidateBatchPreviewFailureShowsNoCounts() {
        QFETCH(bool, timeout);
        QVERIFY(prepareCandidateBatchPanel());
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY2(batchInput("memoryCandidateSelect1", false, true), qPrintable(m_profileDiagnostic));
        const auto selected = candidateSelectedIds();
        QVERIFY2(batchInput("memoryCandidateRejectSelected"), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
        const auto id = lastRendererCommand("memory:candidates:status")["request_id"].toString();
        if (timeout) m_bridge->expirePending(id);
        else m_bridge->event({{"type", "memory:candidates:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", false}, {"error_code", "memory_unavailable"}}}});
        QTRY_COMPARE(m_bridge->memoryCandidateBatch().value("status").toString(), QString("preview_error"));
        QVERIFY(candidateBatchDialog()->property("visible").toBool());
        QCOMPARE(batchControl("memoryCandidateBatchCount", true)->property("text").toString(),
                 QString("所选候选的状态暂时读不到，请取消后重新打开。"));
        QVERIFY(!batchControl("memoryCandidateBatchConfirm", true)->isEnabled());
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 0);
        QCOMPARE(candidateSelectedIds(), selected);
        QVERIFY2(batchInput("memoryCandidateBatchCancel", true), qPrintable(m_profileDiagnostic));
    }
    void batchSelectionClearsOnlyEarlierBatchSuccessNotices_data() {
        QTest::addColumn<QString>("status");
        QTest::newRow("success-cleared") << QString("success");
        QTest::newRow("error-kept") << QString("error");
    }
    void batchSelectionClearsOnlyEarlierBatchSuccessNotices() {
        QFETCH(QString, status);
        QVERIFY(prepareCandidateBatchPanel());
        const auto text = status == "success" ? QString("已删除3条记忆。") : QString("批量删除未执行，没有删除任何一条；已刷新列表。");
        m_bridge->setMemoryFeedback("action", status, text, "delete-earlier", {{"verb", "批量删除记忆"}});
        QTRY_VERIFY(batchControl("memoryActionFeedback")->isVisible());
        QCOMPARE(batchControl("memoryActionFeedback")->property("text").toString(), text);
        QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        QVERIFY(m_panel->property("memorySelectionMode").toBool());
        if (status == "success") {
            QTRY_VERIFY(!batchControl("memoryActionFeedback")->isVisible());
            QVERIFY(m_bridge->memoryFeedback().value("action").toMap().isEmpty());
        } else {
            QCOMPARE(batchControl("memoryActionFeedback")->property("text").toString(), text);
        }
        QVERIFY2(batchInput("memorySelectionCancel"), qPrintable(m_profileDiagnostic));
        m_bridge->m_memoryBatchPin = {{"status", status == "success" ? "success" : "unknown"},
            {"requestId", "pin-earlier"}, {"text", "earlier pin"}};
        emit m_bridge->changed();
        if (status == "success") {
            QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
            QCOMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("idle"));
            QVERIFY(m_panel->property("candidateSelectionMode").toBool());
        } else {
            // An unknown pin keeps the write lock; candidate selection stays closed.
            QVERIFY(!batchControl("memoryCandidateSelectMode")->isEnabled());
            QCOMPARE(m_bridge->memoryBatchPin().value("status").toString(), QString("unknown"));
        }
    }
    void memoryCandidateBatchNarrowBarAndConfirmationKeepWholeLabels_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x626") << 591 << 626;
        QTest::newRow("591x546") << 591 << 546;
        QTest::newRow("760x650") << 760 << 650;
    }
    void memoryCandidateBatchNarrowBarAndConfirmationKeepWholeLabels() {
        QFETCH(int, width);
        QFETCH(int, height);
        QVERIFY(prepareCandidateBatchPanel(width, height));
        QVERIFY2(batchInput("memoryCandidateSelectMode"), qPrintable(m_profileDiagnostic));
        for (int index : {0, 1})
            QVERIFY2(batchInput("memoryCandidateSelect" + QString::number(index), false, true), qPrintable(m_profileDiagnostic));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *bar = batchControl("memoryCandidateSelectionBar");
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        QVERIFY(bar && scroll && bar->parentItem() == scroll->parentItem() && !scroll->isAncestorOf(bar));
        for (const auto *name : {"memoryCandidateSelectionCount", "memoryCandidateConfirmSelected",
                                 "memoryCandidateRejectSelected", "memoryCandidateSelectionCancel"}) {
            auto *item = batchControl(name);
            QVERIFY2(item && item->isVisible() && feedbackItemFullyVisible(item), name);
        }
        QVERIFY2(batchInput("memoryCandidateConfirmSelected"), qPrintable(m_profileDiagnostic));
        const QVariantList replace{candidateId(2)};
        deliverCandidateBatchStatus(lastRendererCommand("memory:candidates:status")["request_id"].toString(),
                                    candidateBatchSnapshot(candidateSelectedIds(), replace, replace));
        QTRY_VERIFY(candidateBatchDialog()->property("opened").toBool());
        const QDeadlineTimer dialogDeadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(dialogDeadline));
        for (const auto *name : {"memoryCandidateBatchCount", "memoryCandidateBatchPinned", "memoryCandidateBatchExplanation",
                                 "memoryCandidateBatchCancel", "memoryCandidateBatchConfirm"}) {
            auto *item = batchControl(name, true);
            QVERIFY2(item && item->isVisible() && feedbackItemFullyVisible(item), name);
            if (item->property("wrapMode").isValid())
                QVERIFY2(item->height() + .5 >= item->property("contentHeight").toDouble(), name);
        }
        QVERIFY2(batchInput("memoryCandidateBatchCancel", true), qPrintable(m_profileDiagnostic));
        QCOMPARE(rendererCommandCount("memory:candidates:decide_many"), 0);
    }
    void candidateBatchPagingUsesProductionControlsAndStableIds() {
        QVERIFY2(loadCandidatePanel({"memoryCandidateNext", {}}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidateConfirmed(initialListId);
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.page2"), initialCandidateId);
        QTRY_VERIFY(profileItemState("memoryCandidateNext", ProfileScope::Page)["readable"].toBool());
        auto firstRow = MemoryActionProbe::findRow(m_panel, candidateId(1));
        QVERIFY(firstRow.valid());
        QCOMPARE(firstRow.index, 0);
        QVERIFY(MemoryActionProbe::rowControl(firstRow, "memoryCandidateConfirm"));
        CandidateInput nextInput;
        QVERIFY2(clickCandidateInput({"memoryCandidateNext", {}}, "memory:candidates:list", nextInput),
                 qPrintable(m_candidateDiagnostic));
        m_candidateLayer = "disabled-guard";
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 2);
        auto *next = profileItem("memoryCandidateNext", ProfileScope::Page);
        QVERIFY(next && !next->isEnabled());
        QSignalSpy synthetic(next, SIGNAL(clicked()));
        QVERIFY(synthetic.isValid());
        QVERIFY(QMetaObject::invokeMethod(next, "clicked"));
        m_candidateSyntheticSignals += synthetic.count();
        QCOMPARE(synthetic.count(), 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 2);
        QCOMPARE(nextInput.envelope["payload"].toObject()["cursor"].toString(), QString("mc1.page2"));
        m_candidateLayer = "page-result";
        deliverCandidate(candidatePage(candidateRows(3, 2)), nextInput.requestId);
        QTRY_VERIFY(MemoryActionProbe::findRow(m_panel, candidateId(3)).valid());
        QVERIFY(!MemoryActionProbe::findRow(m_panel, candidateId(1)).valid());
        QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), 2);
        QCOMPARE(profileItem("memoryCandidatePageInfo", ProfileScope::Page)->property("text").toString(), QString("待确认 · 第2批 · 本批2条"));
        QCOMPARE(profileItem("memoryCandidateFeedback", ProfileScope::Page)->property("text").toString(), QString("没有更早的候选"));
        QVERIFY(!profileItem("memoryCandidateFirst", ProfileScope::Page)->hasActiveFocus());
        QVERIFY(!profileItem("memoryCandidateNext", ProfileScope::Page)->isVisible());
        const auto before = rendererCommandCount("memory:candidates:list");
        armCandidateTrace({"memoryCandidateFirst", {}});
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        QVERIFY(tabs && tabs->setProperty("currentIndex", 4));
        QVERIFY(tabs->setProperty("currentIndex", 0));
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 2);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), before);
        CandidateInput firstInput;
        QVERIFY2(clickCandidateInput({"memoryCandidateFirst", {}}, "memory:candidates:list", firstInput),
                 qPrintable(m_candidateDiagnostic));
        m_candidateLayer = "command-correlation";
        QCOMPARE(rendererCommandCount("memory:candidates:list"), before + 1);
        QVERIFY(!firstInput.requestId.isEmpty() && firstInput.requestId != nextInput.requestId);
        QVERIFY(!firstInput.envelope["payload"].toObject().contains("cursor"));
        candidateFixedStage("readback");
        deliverCandidate(candidatePage({}), firstInput.requestId);
        m_candidateLayer = "page-result";
        QTRY_COMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 1);
        QVERIFY(!profileItem("memoryCandidateFirst", ProfileScope::Page)->isVisible());
        QCOMPARE(profileItem("memoryCandidateFeedback", ProfileScope::Page)->property("text").toString(), QString("没有待确认的候选"));
        QCOMPARE(rendererCommandCount("memory:candidates:list"), before + 1);
        candidateFixedStage("settled");
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void candidateDecisionReadsItsBatchAndOnlyEmptyTailMayMoveFocus_data() {
        QTest::addColumn<QString>("focusCase");
        QTest::addColumn<bool>("emptyTail");
        QTest::addColumn<bool>("confirm");
        QTest::newRow("confirm-empty-tail-candidate-focus") << QString("candidate") << true << true;
        QTest::newRow("reject-empty-tail-candidate-focus") << QString("candidate") << true << false;
        QTest::newRow("empty-tail-other-input") << QString("field") << true << true;
        QTest::newRow("empty-tail-inactive-tab") << QString("tab") << true << true;
        QTest::newRow("empty-tail-inactive-page") << QString("page") << true << true;
        QTest::newRow("empty-tail-inactive-window") << QString("window") << true << true;
        QTest::newRow("nonempty-reread-keeps-focus") << QString("candidate") << false << true;
        QTest::newRow("empty-tail-same-scroll-blank-press") << QString("scroll-blank") << true << true;
        QTest::newRow("empty-tail-tab-navigation") << QString("key-tab") << true << true;
        QTest::newRow("empty-tail-backtab-navigation") << QString("key-backtab") << true << true;
        QTest::newRow("empty-tail-user-focus-return-cannot-revive") << QString("field-return") << true << true;
        QTest::newRow("empty-tail-window-reactivated-cannot-revive") << QString("window-return") << true << true;
        QTest::newRow("empty-tail-segment-return-cannot-revive") << QString("tab-return") << true << true;
        QTest::newRow("empty-tail-page-return-cannot-revive") << QString("page-return") << true << true;
        QTest::newRow("empty-tail-target-ready-later-transfers-once") << QString("target-not-ready") << true << true;
        QTest::newRow("keyboard-confirm-empty-tail-same-entry") << QString("keyboard") << true << true;
    }
    void candidateDecisionReadsItsBatchAndOnlyEmptyTailMayMoveFocus() {
        QFETCH(QString, focusCase);
        QFETCH(bool, emptyTail);
        QFETCH(bool, confirm);
        QVERIFY2(loadCandidatePanel({confirm ? QString("memoryCandidateConfirm") : QString("memoryCandidateReject"),
                                    candidateId(4)}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        const auto command = confirm ? QString("memory:candidates:confirm") : QString("memory:candidates:reject");
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidateConfirmed(initialListId);
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.sameStart"), initialCandidateId);
        m_bridge->loadNextMemoryCandidates();
        const auto secondCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidate(candidatePage(candidateRows(3, 2)), secondCandidateId);
        armCandidateTrace({confirm ? QString("memoryCandidateConfirm") : QString("memoryCandidateReject"), candidateId(4)}, command);
        setCandidateFocusWindow(m_window.get());
        QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        QTRY_VERIFY(MemoryActionProbe::findRow(m_panel, candidateId(4)).valid());
        const auto row = MemoryActionProbe::findRow(m_panel, candidateId(4));
        auto *decide = MemoryActionProbe::rowControl(row, confirm ? "memoryCandidateConfirm" : "memoryCandidateReject");
        QVERIFY(decide);
        decide->forceActiveFocus();
        QVERIFY(decide->hasActiveFocus());
        CandidateInput decision;
        if (focusCase == "keyboard")
            QVERIFY2(clickCandidateInput(m_candidateTarget, command, decision, true), qPrintable(m_candidateDiagnostic));
        else
            QVERIFY2(clickCandidateInput(m_candidateTarget, command, decision), qPrintable(m_candidateDiagnostic));
        const auto kind = confirm ? QString("confirm") : QString("reject");
        QTRY_COMPARE(candidateFocusContext().value("actionRequestId").toString(), decision.requestId);
        QVERIFY2(candidateFocusBoundTo(decision, kind), qPrintable(m_candidateDiagnostic));
        const auto committedSerial = m_panel->property("candidateFocusSerial").toULongLong();
        QCOMPARE(m_candidatePhysicalClicks - m_candidatePreArmClicks, focusCase == "keyboard" ? 0 : 1);
        QCOMPARE(m_candidatePhysicalKeys - m_candidatePreArmKeys, focusCase == "keyboard" ? 1 : 0);
        QCOMPARE(m_candidatePhysicalSignals - m_candidatePreArmSignals, 1);
        m_candidateLayer = "disabled-guard";
        QCOMPARE(rendererCommandCount(command), 1);
        const auto action = decision.requestId;
        QVERIFY(m_bridge->memoryCandidatePage().value("busy").toBool());
        QVERIFY(!profileItem("memoryCandidateFirst", ProfileScope::Page)->isEnabled());
        const auto disabledRow = MemoryActionProbe::findRow(m_panel, candidateId(4));
        decide = MemoryActionProbe::rowControl(disabledRow,
            confirm ? QString("memoryCandidateConfirm") : QString("memoryCandidateReject"));
        QVERIFY(disabledRow.valid() && disabledRow.id == candidateId(4) && decide && !decide->isEnabled());
        // The synthetic signal is a separate disabled-handler probe. It never
        // contributes to the physical click receipt above.
        QSignalSpy synthetic(decide, SIGNAL(clicked()));
        QVERIFY(synthetic.isValid());
        QVERIFY(QMetaObject::invokeMethod(decide, "clicked"));
        m_candidateSyntheticSignals += synthetic.count();
        QCOMPARE(synthetic.count(), 1);
        QCOMPARE(rendererCommandCount(command), 1);
        m_candidateLayer = "focus-fixture";
        auto *field = profileItem("memoryFilterField", ProfileScope::Page);
        QVERIFY(field);
        const bool intentExpected = focusCase == "candidate" || focusCase == "keyboard" || focusCase == "target-not-ready";
        if (focusCase == "field") {
            QVERIFY(field->setProperty("text", "未提交的筛选草稿"));
            field->forceActiveFocus();
        } else if (focusCase == "tab") {
            QVERIFY(profileItem("memoryTabs", ProfileScope::Page)->setProperty("currentIndex", 1));
        } else if (focusCase == "page") {
            QVERIFY(m_panel->setProperty("page", "settings"));
        } else if (focusCase == "window") {
            setCandidateFocusWindow(nullptr);
            QTRY_VERIFY(m_window->isVisible() && !QGuiApplication::focusWindow() && !m_window->isActive());
        } else if (focusCase == "scroll-blank") {
            auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
            auto *content = scroll ? scroll->property("contentItem").value<QQuickItem *>() : nullptr;
            QVERIFY(scroll && content);
            QTRY_VERIFY(m_window->activeFocusItem() == scroll || m_window->activeFocusItem() == content);
            const auto alreadyFocused = QPointer<QQuickItem>(m_window->activeFocusItem());
            QVERIFY(m_panel->property("candidateFocusEligible").toBool());
            QVERIFY2(clickCandidateScrollBlank(decision, kind), qPrintable(m_candidateDiagnostic));
            QCOMPARE(m_window->activeFocusItem(), alreadyFocused.data());
        } else if (focusCase == "key-tab" || focusCase == "key-backtab") {
            const auto beforeKey = QPointer<QQuickItem>(m_window->activeFocusItem());
            QTest::keyClick(m_window.get(), focusCase == "key-tab" ? Qt::Key_Tab : Qt::Key_Backtab, Qt::NoModifier, 0);
            QTRY_VERIFY(m_window->activeFocusItem() != beforeKey.data());
        } else if (focusCase == "field-return") {
            field->forceActiveFocus(Qt::TabFocusReason);
            QVERIFY(field->hasActiveFocus());
            QTRY_VERIFY(!m_panel->property("candidateFocusEligible").toBool());
            auto *region = profileItem("memoryCandidateRegion", ProfileScope::Page);
            QVERIFY(region);
            // This is a deliberate user-focus fixture transition after the
            // cancellation, never a repair of the product handoff target.
            region->forceActiveFocus(Qt::BacktabFocusReason);
            QVERIFY(region->hasActiveFocus());
        } else if (focusCase == "window-return") {
            setCandidateFocusWindow(nullptr);
            QTRY_VERIFY(m_window->isVisible() && !QGuiApplication::focusWindow() && !m_window->isActive());
            QTRY_VERIFY(!m_panel->property("candidateFocusEligible").toBool());
            setCandidateFocusWindow(m_window.get());
            QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        } else if (focusCase == "tab-return") {
            auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
            QVERIFY(tabs && tabs->setProperty("currentIndex", 1));
            QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
            QVERIFY(tabs->setProperty("currentIndex", 0));
        } else if (focusCase == "page-return") {
            QVERIFY(m_panel->setProperty("page", "settings"));
            QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
            QVERIFY(m_panel->setProperty("page", "memory"));
        } else if (focusCase == "target-not-ready") {
            auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
            // QQmlProperty removes the enabled binding for this fixture row,
            // so the later decisionBusy transition cannot undo the hold.
            QVERIFY(first && QQmlProperty(first, "enabled").write(false));
            QVERIFY(!first->isEnabled());
        }
        if (!intentExpected) {
            QTRY_VERIFY(!m_panel->property("candidateFocusEligible").toBool());
            QVERIFY(!m_panel->property("candidateFocusPending").toBool());
            QVERIFY(candidateFocusContext().isEmpty());
            QVERIFY(m_panel->property("candidateFocusSerial").toULongLong() > committedSerial);
        }
        if (focusCase != "window")
            QVERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        CandidateReads reads;
        QVERIFY2(acknowledgeCandidate(decision, reads), qPrintable(m_candidateDiagnostic));
        if (intentExpected) {
            QTRY_COMPARE(candidateFocusContext().value("listReadId").toString(), reads.listId);
            QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), reads.candidateId);
            QVERIFY2(candidateFocusOwnReads(decision, reads, kind), qPrintable(m_candidateDiagnostic));
        }
        QCOMPARE(rendererCommandAt("memory:candidates:list", decision.before.candidateCount)["payload"].toObject()["cursor"].toString(), QString("mc1.sameStart"));
        m_candidateLayer = "readback-result";
        if (focusCase == "field") {
            deliverCandidateConfirmed(reads.listId);
            QVERIFY(m_bridge->memoryCandidatePage().value("busy").toBool());
            QVERIFY(m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
            QVERIFY(m_bridge->memoryCandidatePage().value("blocked").toBool());
            QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("requestId").toString(), reads.listId);
            QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("success"));
            QVERIFY(!profileItem("memoryFilterApply", ProfileScope::Page)->isEnabled());
            QVERIFY(!profileItem("memoryFilterClear", ProfileScope::Page)->isEnabled());
            QVERIFY(field->isEnabled());
            const int reads = rendererCommandCount("memory:list");
            QTest::keyClick(m_window.get(), Qt::Key_Return);
            QCOMPARE(rendererCommandCount("memory:list"), reads);
        }
        deliverCandidate(candidatePage(emptyTail ? QJsonArray{} : candidateRows(3, 1)), reads.candidateId);
        if (focusCase != "field") {
            QVERIFY(m_bridge->memoryCandidatePage().value("busy").toBool());
            QVERIFY(m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
            QVERIFY(m_bridge->memoryCandidatePage().value("blocked").toBool());
            QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), reads.candidateId);
            QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
            if (intentExpected) {
                QVERIFY2(candidateFocusOwnReads(decision, reads, kind), qPrintable(m_candidateDiagnostic));
                QVERIFY(m_panel->property("candidateFocusPending").toBool());
            }
            deliverCandidateConfirmed(reads.listId);
        }
        QTRY_VERIFY(!m_bridge->memoryCandidatePage().value("busy").toBool());
        // Both successful reads must be the action's own fresh requests before
        // any focus assertion is allowed to attribute a product handoff.
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("requestId").toString(), action);
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status").toString(), QString("success"));
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("subjectId").toString(), candidateId(4));
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("verb").toString(),
                 confirm ? QString("记住这条") : QString("不记这条"));
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("requestId").toString(), reads.listId);
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("success"));
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), reads.candidateId);
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
        QVERIFY(m_bridge->memoryCandidatePage().value("live").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("blocked").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("needsRefresh").toBool());
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 2);
        QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), emptyTail ? 0 : 1);
        QVERIFY(!m_bridge->memoryCandidatePage().value("hasMore").toBool());
        QCOMPARE(rendererCommandCount(command), decision.before.actionCount + 1);
        QCOMPARE(rendererCommandCount("memory:list"), decision.before.listCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), decision.before.candidateCount + 1);
        QCOMPARE(profileItem("memoryCandidatePageInfo", ProfileScope::Page)->property("text").toString(),
                 QString("待确认 · 第2批 · 本批%1条").arg(emptyTail ? 0 : 1));
        QCOMPARE(profileItem("memoryCandidateFeedback", ProfileScope::Page)->property("text").toString(),
                 emptyTail ? QString("这一批已处理完，没有更早的候选") : QString("没有更早的候选"));
        candidateFixedStage("settled");
        m_candidateLayer = "focus-result";
        auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
        QVERIFY(first);
        const bool focusExpected = intentExpected && emptyTail;
        if (focusCase == "target-not-ready") {
            QVERIFY(!first->isEnabled());
            QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
            QVERIFY(!first->hasActiveFocus());
            QVERIFY2(candidateFocusOwnReads(decision, reads, kind), qPrintable(m_candidateDiagnostic));
            QCOMPARE(m_candidateFocusTransfers, 0);
            QVERIFY(QQmlProperty(first, "enabled").write(true));
        }
        if (focusExpected)
            QTRY_VERIFY(first->hasActiveFocus());
        else {
            QVERIFY2(waitForCandidateDeferredFocus(first), qPrintable(m_candidateDiagnostic));
            QCoreApplication::processEvents();
            QVERIFY(!first->hasActiveFocus());
        }
        QCOMPARE(m_candidateFocusTransfers, focusExpected ? 1 : 0);
        if (focusExpected) {
            QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
            QCOMPARE(m_candidateFocusTransfers, 1);
            QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        }
        if (focusCase == "field") {
            QVERIFY(field->hasActiveFocus());
            QCOMPARE(field->property("text").toString(), QString("未提交的筛选草稿"));
        }
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 2);
        QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), emptyTail ? 0 : 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 3);
        if (emptyTail)
            QCOMPARE(profileItem("memoryCandidateFeedback", ProfileScope::Page)->property("text").toString(), QString("这一批已处理完，没有更早的候选"));
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void candidateReadFailureAndRefreshKeepPositionAndIgnoreTheOldPage() {
        QVERIFY2(loadCandidatePanel({"memoryRefresh", {}}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidateConfirmed(initialListId);
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.old"), initialCandidateId);
        auto *field = profileItem("memoryFilterField", ProfileScope::Page);
        QVERIFY(field && field->setProperty("text", "草稿保持"));
        field->forceActiveFocus();
        m_bridge->loadNextMemoryCandidates();
        const auto stale = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        armCandidateTrace({"memoryRefresh", {}});
        auto *refresh = profileItem("memoryRefresh", ProfileScope::Page);
        QVERIFY(refresh && refresh->isEnabled());
        CandidateInput refreshInput;
        QVERIFY2(clickCandidateInput({"memoryRefresh", {}}, "memory:candidates:list", refreshInput),
                 qPrintable(m_candidateDiagnostic));
        const auto fresh = refreshInput.requestId;
        QVERIFY(fresh != stale);
        candidateFixedStage("readback");
        m_candidateLayer = "page-result";
        deliverCandidate(candidatePage(candidateRows(8, 1)), fresh);
        deliverCandidate(candidatePage(candidateRows(3, 1)), stale);
        QTRY_VERIFY(MemoryActionProbe::findRow(m_panel, candidateId(8)).valid());
        QVERIFY(!MemoryActionProbe::findRow(m_panel, candidateId(3)).valid());
        QCOMPARE(field->property("text").toString(), QString("草稿保持"));
        const auto rows = m_bridge->state().value("candidates");
        m_bridge->firstMemoryCandidates();
        const auto failed = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        m_bridge->event({{"type", "error"}, {"request_id", failed}, {"payload", QJsonObject{{"message", "read failed"}}}});
        QCOMPARE(m_bridge->state().value("candidates"), rows);
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), 4);
        candidateFixedStage("settled");
    }
    void candidateReadbackErrorAfterOneSuccessCannotMoveFocus_data() {
        QTest::addColumn<bool>("candidateFirst");
        QTest::newRow("candidate-empty-tail-success-then-confirmed-error") << true;
        QTest::newRow("confirmed-success-then-candidate-error") << false;
    }
    void candidateReadbackErrorAfterOneSuccessCannotMoveFocus() {
        QFETCH(bool, candidateFirst);
        QVERIFY2(loadCandidatePanel({"memoryCandidateConfirm", candidateId(4)}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        const QString command = "memory:candidates:confirm";
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidateConfirmed(initialListId);
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.sameStart"), initialCandidateId);
        m_bridge->loadNextMemoryCandidates();
        const auto secondCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidate(candidatePage(candidateRows(3, 2)), secondCandidateId);
        armCandidateTrace({"memoryCandidateConfirm", candidateId(4)}, command);
        setCandidateFocusWindow(m_window.get());
        QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        QTRY_VERIFY(MemoryActionProbe::findRow(m_panel, candidateId(4)).valid());
        const auto row = MemoryActionProbe::findRow(m_panel, candidateId(4));
        auto *decide = MemoryActionProbe::rowControl(row, "memoryCandidateConfirm");
        auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
        QVERIFY(decide && first);
        QVERIFY(!first->hasActiveFocus());
        decide->forceActiveFocus();
        QVERIFY(decide->hasActiveFocus());
        CandidateInput decision;
        QVERIFY2(clickCandidateInput(m_candidateTarget, command, decision), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("actionRequestId").toString(), decision.requestId);
        QVERIFY2(candidateFocusBoundTo(decision, "confirm"), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_candidatePhysicalClicks - m_candidatePreArmClicks, 1);
        QCOMPARE(m_candidatePhysicalSignals - m_candidatePreArmSignals, 1);
        const auto disabled = MemoryActionProbe::findRow(m_panel, candidateId(4));
        decide = MemoryActionProbe::rowControl(disabled, "memoryCandidateConfirm");
        QVERIFY(disabled.valid() && disabled.id == candidateId(4) && decide && !decide->isEnabled());
        QSignalSpy synthetic(decide, SIGNAL(clicked()));
        QVERIFY(synthetic.isValid());
        QVERIFY(QMetaObject::invokeMethod(decide, "clicked"));
        m_candidateSyntheticSignals += synthetic.count();
        QCOMPARE(synthetic.count(), 1);
        QCOMPARE(rendererCommandCount(command), decision.before.actionCount + 1);
        CandidateReads reads;
        QVERIFY2(acknowledgeCandidate(decision, reads), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("listReadId").toString(), reads.listId);
        QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), reads.candidateId);
        QVERIFY2(candidateFocusOwnReads(decision, reads, "confirm"), qPrintable(m_candidateDiagnostic));
        const auto framesAfterAck = m_frames.size();
        m_candidateLayer = "partial-read-result";
        if (candidateFirst) {
            deliverCandidate(candidatePage({}), reads.candidateId);
            QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), reads.candidateId);
            QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
            QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), 0);
        } else {
            deliverCandidateConfirmed(reads.listId);
            QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("requestId").toString(), reads.listId);
            QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("success"));
        }
        QVERIFY(m_bridge->memoryCandidatePage().value("busy").toBool());
        QVERIFY(m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
        QVERIFY(m_bridge->memoryCandidatePage().value("blocked").toBool());
        QVERIFY(!first->hasActiveFocus());
        // A failed read is meaningful only while this action still owns a
        // live focus intent. In particular the empty candidate read alone
        // must not consume it before the confirmed read has settled.
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QVERIFY2(candidateFocusOwnReads(decision, reads, "confirm"), qPrintable(m_candidateDiagnostic));
        QVERIFY(m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(m_panel->property("candidateFocusPending").toBool());
        QCOMPARE(m_candidateFocusTransfers, 0);
        const auto failedReadId = candidateFirst ? reads.listId : reads.candidateId;
        m_bridge->event({{"type", "error"}, {"request_id", failedReadId},
            {"payload", QJsonObject{{"message", "fixture read failure"}}}});
        m_candidateLayer = "failed-readback-result";
        QTRY_VERIFY(!m_bridge->memoryCandidatePage().value("busy").toBool());
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("requestId").toString(), decision.requestId);
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status").toString(), QString("unknown"));
        QCOMPARE(m_bridge->m_candidateDecision.value("status").toString(), QString("unknown"));
        const auto failedReceipt = m_bridge->memoryFeedback().value(candidateFirst ? "list" : "candidates").toMap();
        QCOMPARE(failedReceipt.value("requestId").toString(), failedReadId);
        QCOMPARE(failedReceipt.value("status").toString(), QString("error"));
        QVERIFY(m_bridge->memoryCandidatePage().value("blocked").toBool());
        QVERIFY(m_bridge->memoryCandidatePage().value("needsRefresh").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("decisionBusy").toBool());
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 2);
        QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), candidateFirst ? 0 : 2);
        QVERIFY(!m_bridge->memoryCandidatePage().value("hasMore").toBool());
        QCOMPARE(rendererCommandCount(command), decision.before.actionCount + 1);
        QCOMPARE(rendererCommandCount("memory:list"), decision.before.listCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), decision.before.candidateCount + 1);
        QCOMPARE(m_frames.size(), framesAfterAck);
        candidateFixedStage("settled");
        m_candidateLayer = "failed-readback-focus";
        // Let the production deferred focus handler finish before asserting
        // the negative result; no focus repair is made after the action.
        QVERIFY2(waitForCandidateDeferredFocus(first), qPrintable(m_candidateDiagnostic));
        QVERIFY(!first->hasActiveFocus());
        QCOMPARE(m_candidateFocusTransfers, 0);
        QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QCOMPARE(rendererCommandCount(command), decision.before.actionCount + 1);
        QCOMPARE(rendererCommandCount("memory:list"), decision.before.listCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), decision.before.candidateCount + 1);
        QCOMPARE(m_frames.size(), framesAfterAck);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void candidateNavigationUsesOnlyItsOwnReadReceipt_data() {
        QTest::addColumn<QString>("kind");
        QTest::newRow("first-without-action-or-confirmed-success") << QString("first");
        QTest::newRow("next-without-action-or-confirmed-success") << QString("next");
    }
    void candidateNavigationUsesOnlyItsOwnReadReceipt() {
        QFETCH(QString, kind);
        const auto target = kind == "first" ? QString("memoryCandidateFirst") : QString("memoryCandidateNext");
        QVERIFY2(loadCandidatePanel({target, {}}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        // Leave the confirmed read pending and never create an action receipt.
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.navigation"), initialCandidateId);
        if (kind == "first") {
            m_bridge->loadNextMemoryCandidates();
            const auto secondId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
            deliverCandidate(candidatePage(candidateRows(3, 2)), secondId);
        }
        setCandidateFocusWindow(m_window.get());
        QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        QTRY_VERIFY(observeCandidateTarget({target, {}}).eligible);
        auto *source = profileItem(target, ProfileScope::Page);
        QVERIFY(source);
        source->forceActiveFocus(Qt::TabFocusReason);
        QVERIFY(source->hasActiveFocus());
        const QPointer<QQuickItem> sourceFocus = m_window->activeFocusItem();
        armCandidateTrace({target, {}});
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status", "none").toString(), QString("none"));
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("requestId").toString(), initialListId);
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("pending"));
        CandidateInput navigation;
        QVERIFY2(clickCandidateInput({target, {}}, "memory:candidates:list", navigation), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), navigation.requestId);
        QVERIFY2(candidateFocusBoundTo(navigation, kind), qPrintable(m_candidateDiagnostic));
        QVERIFY(candidateFocusContext().value("actionRequestId").toString().isEmpty());
        QVERIFY(candidateFocusContext().value("listReadId").toString().isEmpty());
        QCOMPARE(m_candidatePhysicalClicks - m_candidatePreArmClicks, 1);
        QCOMPARE(m_candidatePhysicalSignals - m_candidatePreArmSignals, 1);
        if (kind == "first")
            QVERIFY(!navigation.envelope["payload"].toObject().contains("cursor"));
        else
            QCOMPARE(navigation.envelope["payload"].toObject()["cursor"].toString(), QString("mc1.navigation"));
        m_candidateLayer = "navigation-readback";
        if (kind == "first")
            QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
        candidateFixedStage("readback");
        deliverCandidate(candidatePage({}), navigation.requestId);
        m_candidateLayer = "navigation-readback-result";
        QTRY_VERIFY(!m_bridge->memoryCandidatePage().value("busy").toBool());
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), navigation.requestId);
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("pending"));
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status", "none").toString(), QString("none"));
        auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
        QVERIFY(first);
        m_candidateLayer = "navigation-focus-result";
        if (kind == "next")
            QTRY_VERIFY(first->hasActiveFocus());
        else {
            QVERIFY2(waitForCandidateDeferredFocus(first), qPrintable(m_candidateDiagnostic));
            QVERIFY(!first->isVisible());
            QCOMPARE(first, sourceFocus.data());
            QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
            QCOMPARE(m_candidateFocusTransfers, 0);
        }
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), kind == "next" ? 2 : 1);
        QVERIFY(m_bridge->memoryCandidatePage().value("live").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(rendererCommandCount("memory:list"), navigation.before.listCount);
        QCOMPARE(rendererCommandCount("memory:candidates:confirm"), 0);
        QCOMPARE(rendererCommandCount("memory:candidates:reject"), 0);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), navigation.before.candidateCount + 1);
        QCOMPARE(m_candidateFocusTransfers, kind == "next" ? 1 : 0);
        const auto framesBeforeOldRead = m_frames.size();
        m_candidateLayer = "navigation-late-confirmed-read";
        deliverCandidateConfirmed(initialListId);
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_frames.size(), framesBeforeOldRead);
        QCOMPARE(m_candidateFocusTransfers, kind == "next" ? 1 : 0);
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        candidateFixedStage("settled");
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void candidateHiddenFirstKeyboardCannotDispatch_data() {
        QTest::addColumn<QString>("sourceName");
        QTest::newRow("hidden-first-keyboard-zero-rpc") << QString("memoryCandidateFirst");
    }
    void candidateHiddenFirstKeyboardCannotDispatch() {
        QFETCH(QString, sourceName);
        QVERIFY2(loadCandidatePanel({sourceName, {}}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.hiddenFirst"), initialCandidateId);
        m_bridge->loadNextMemoryCandidates();
        const auto secondId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidate(candidatePage(candidateRows(3, 2)), secondId);
        setCandidateFocusWindow(m_window.get());
        QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        QTRY_VERIFY(observeCandidateTarget({sourceName, {}}).eligible);
        auto *source = profileItem(sourceName, ProfileScope::Page);
        QVERIFY(source && source->isVisible());
        // Establish the visible source before arming. No hidden target is
        // force-focused before or after the ordinary first-page result.
        source->forceActiveFocus(Qt::TabFocusReason);
        QVERIFY(source->hasActiveFocus());
        const QPointer<QQuickItem> sourceFocus = m_window->activeFocusItem();
        armCandidateTrace({sourceName, {}});
        CandidateInput navigation;
        QVERIFY2(clickCandidateInput({sourceName, {}}, "memory:candidates:list", navigation), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), navigation.requestId);
        QVERIFY2(candidateFocusBoundTo(navigation, "first"), qPrintable(m_candidateDiagnostic));
        QVERIFY(candidateFocusContext().value("actionRequestId").toString().isEmpty());
        QVERIFY(candidateFocusContext().value("listReadId").toString().isEmpty());
        QVERIFY(!navigation.envelope["payload"].toObject().contains("cursor"));
        QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
        m_candidateLayer = "hidden-first-readback";
        candidateFixedStage("readback");
        deliverCandidate(candidatePage({}), navigation.requestId);
        QTRY_VERIFY(!m_bridge->memoryCandidatePage().value("busy").toBool());
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), navigation.requestId);
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("requestId").toString(), initialListId);
        QCOMPARE(m_bridge->memoryFeedback().value("list").toMap().value("status").toString(), QString("pending"));
        QCOMPARE(m_bridge->memoryFeedback().value("action").toMap().value("status", "none").toString(), QString("none"));
        auto *first = profileItem(sourceName, ProfileScope::Page);
        m_candidateLayer = "hidden-first-focus-result";
        QVERIFY2(waitForCandidateDeferredFocus(first), qPrintable(m_candidateDiagnostic));
        QVERIFY(first && !first->isVisible() && first->isEnabled());
        QCOMPARE(first, sourceFocus.data());
        QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
        QVERIFY(first->hasActiveFocus());
        QCOMPARE(m_candidateFocusTransfers, 0);
        QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 1);
        QCOMPARE(m_bridge->memoryCandidatePage().value("count").toInt(), 0);
        QVERIFY(m_bridge->memoryCandidatePage().value("live").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(rendererCommandCount("memory:list"), navigation.before.listCount);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), navigation.before.candidateCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:confirm"), 0);
        QCOMPARE(rendererCommandCount("memory:candidates:reject"), 0);
        QSignalSpy clicked(first, SIGNAL(clicked()));
        QVERIFY(clicked.isValid());
        QJsonArray keys;
        for (const auto &[name, key] : QList<QPair<QString, Qt::Key>>{
                 {"Space", Qt::Key_Space}, {"Return", Qt::Key_Return}, {"Enter", Qt::Key_Enter}}) {
            m_candidateLayer = "hidden-first-keyboard-input";
            QVERIFY(!first->isVisible() && first->isEnabled() && first->hasActiveFocus());
            QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
            const auto framesBefore = m_frames.size();
            const auto before = candidateBaseline("memory:candidates:confirm");
            const auto rejectsBefore = rendererCommandCount("memory:candidates:reject");
            const auto clickedBefore = clicked.count();
            ++m_candidatePhysicalKeys;
            QTest::keyClick(m_window.get(), key, Qt::NoModifier, 0);
            const auto clickedDelta = clicked.count() - clickedBefore;
            m_candidatePhysicalSignals += int(clickedDelta);
            keys.append(QJsonObject{{"key", name}, {"physicalKeyClicks", 1}, {"clickedSignals", int(clickedDelta)},
                {"framesDelta", qint64(m_frames.size() - framesBefore)},
                {"listDelta", rendererCommandCount("memory:list") - before.listCount},
                {"candidateReadDelta", rendererCommandCount("memory:candidates:list") - before.candidateCount},
                {"confirmDelta", rendererCommandCount("memory:candidates:confirm") - before.actionCount},
                {"rejectDelta", rendererCommandCount("memory:candidates:reject") - rejectsBefore}});
            m_candidateHiddenKeyInput = {{"keys", keys}, {"syntheticClickedSignals", 0}};
            candidateObserveChange();
            m_candidateLayer = "hidden-first-keyboard-result";
            QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
            const auto settledClickedDelta = clicked.count() - clickedBefore;
            m_candidatePhysicalSignals += int(settledClickedDelta - clickedDelta);
            auto settledKey = keys.last().toObject();
            settledKey["clickedSignals"] = int(settledClickedDelta);
            settledKey["framesDelta"] = qint64(m_frames.size() - framesBefore);
            settledKey["listDelta"] = rendererCommandCount("memory:list") - before.listCount;
            settledKey["candidateReadDelta"] = rendererCommandCount("memory:candidates:list") - before.candidateCount;
            settledKey["confirmDelta"] = rendererCommandCount("memory:candidates:confirm") - before.actionCount;
            settledKey["rejectDelta"] = rendererCommandCount("memory:candidates:reject") - rejectsBefore;
            settledKey["barrierCompleted"] = true;
            settledKey["phase"] = "after-frame-posted-barrier";
            settledKey["sourceHidden"] = !first->isVisible();
            settledKey["sourceEnabled"] = first->isEnabled();
            settledKey["sameFocusIdentity"] = m_window->activeFocusItem() == sourceFocus.data();
            settledKey["focusTransfers"] = m_candidateFocusTransfers;
            settledKey["focusEligible"] = m_panel->property("candidateFocusEligible").toBool();
            settledKey["focusPending"] = m_panel->property("candidateFocusPending").toBool();
            settledKey["contextEmpty"] = candidateFocusContext().isEmpty();
            keys.replace(keys.size() - 1, settledKey);
            m_candidateHiddenKeyInput["keys"] = keys;
            candidateObserveChange();
            // clicked() is diagnostic: the visible guard may reject a signal
            // that the control emits while it retains its earlier focus.
            QCOMPARE(rendererCommandCount("memory:list"), before.listCount);
            QCOMPARE(rendererCommandCount("memory:candidates:list"), before.candidateCount);
            QCOMPARE(rendererCommandCount("memory:candidates:confirm"), before.actionCount);
            QCOMPARE(rendererCommandCount("memory:candidates:reject"), rejectsBefore);
            QCOMPARE(m_frames.size(), framesBefore);
            QVERIFY(!first->isVisible() && first->isEnabled() && first->hasActiveFocus());
            QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
            QCOMPARE(m_candidateFocusTransfers, 0);
        }
        QCOMPARE(m_candidatePhysicalKeys - m_candidatePreArmKeys, 3);
        QCOMPARE(m_candidatePhysicalClicks - m_candidatePreArmClicks, 1);
        QCOMPARE(m_candidateSyntheticSignals - m_candidatePreArmSynthetic, 0);
        const auto framesBeforeOldRead = m_frames.size();
        m_candidateLayer = "hidden-first-late-confirmed-read";
        deliverCandidateConfirmed(initialListId);
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_frames.size(), framesBeforeOldRead);
        QCOMPARE(m_candidateFocusTransfers, 0);
        QCOMPARE(m_window->activeFocusItem(), sourceFocus.data());
        QVERIFY(!first->isVisible() && first->isEnabled());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 1);
        QCOMPARE(rendererCommandCount("memory:list"), navigation.before.listCount);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), navigation.before.candidateCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:confirm"), 0);
        QCOMPARE(rendererCommandCount("memory:candidates:reject"), 0);
        candidateFixedStage("settled");
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void candidateReconnectAndNewOperationCannotReviveQueuedOldIntent() {
        const QString command = "memory:candidates:confirm";
        QVERIFY2(loadCandidatePanel({"memoryCandidateConfirm", candidateId(4)}), qPrintable(m_candidateDiagnostic));
        QVERIFY(selectMemoryCandidatesPage());
        m_bridge->refreshMemories();
        const auto initialListId = lastRendererCommand("memory:list")["request_id"].toString();
        const auto initialCandidateId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidateConfirmed(initialListId);
        deliverCandidate(candidatePage(candidateRows(1, 2), true, "mc1.sameStart"), initialCandidateId);
        m_bridge->loadNextMemoryCandidates();
        const auto secondId = lastRendererCommand("memory:candidates:list")["request_id"].toString();
        deliverCandidate(candidatePage(candidateRows(3, 2)), secondId);
        armCandidateTrace({"memoryCandidateConfirm", candidateId(4)}, command);
        setCandidateFocusWindow(m_window.get());
        QTRY_VERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        QTRY_VERIFY(MemoryActionProbe::findRow(m_panel, candidateId(4)).valid());
        auto *source = MemoryActionProbe::rowControl(MemoryActionProbe::findRow(m_panel, candidateId(4)), "memoryCandidateConfirm");
        QVERIFY(source);
        source->forceActiveFocus();
        QVERIFY(source->hasActiveFocus());
        CandidateInput oldDecision;
        QVERIFY2(clickCandidateInput(m_candidateTarget, command, oldDecision), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("actionRequestId").toString(), oldDecision.requestId);
        QVERIFY2(candidateFocusBoundTo(oldDecision, "confirm"), qPrintable(m_candidateDiagnostic));
        CandidateReads oldReads;
        QVERIFY2(acknowledgeCandidate(oldDecision, oldReads), qPrintable(m_candidateDiagnostic));
        QTRY_COMPARE(candidateFocusContext().value("listReadId").toString(), oldReads.listId);
        QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), oldReads.candidateId);
        QVERIFY2(candidateFocusOwnReads(oldDecision, oldReads, "confirm"), qPrintable(m_candidateDiagnostic));
        const auto oldSerial = m_panel->property("candidateFocusSerial").toULongLong();
        deliverCandidate(candidatePage({}), oldReads.candidateId);
        QVERIFY2(candidateFocusOwnReads(oldDecision, oldReads, "confirm"), qPrintable(m_candidateDiagnostic));
        deliverCandidateConfirmed(oldReads.listId);
        QVERIFY(!m_bridge->memoryCandidatePage().value("busy").toBool());
        QVERIFY(m_panel->property("candidateFocusPending").toBool());
        QCOMPARE(m_panel->property("candidateFocusQueuedSerial").toULongLong(), oldSerial);
        QCOMPARE(m_candidateFocusTransfers, 0);
        const auto sameScope = m_bridge->scopeKey();
        const auto oldGeneration = m_bridge->m_generation;
        // Use the bridge's real lost-connection boundary. Qt receives its
        // changed notification; the candidate live flag is invalidated too.
        m_bridge->m_process.finished(1, QProcess::CrashExit);
        QVERIFY(!m_bridge->connected());
        QVERIFY(!m_bridge->memoryCandidatePage().value("live").toBool());
        QCOMPARE(m_bridge->scopeKey(), sameScope);
        QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QVERIFY(m_panel->property("candidateFocusSerial").toULongLong() > oldSerial);
        m_bridge->m_generation = oldGeneration + 1;
        m_bridge->m_connected = true;
        m_bridge->m_runtimeWritable = true;
        m_bridge->m_recoveryState = "clean";
        emit m_bridge->changed();
        QVERIFY(m_bridge->connected());
        QVERIFY(!m_bridge->memoryCandidatePage().value("live").toBool());
        QCOMPARE(m_bridge->scopeKey(), sameScope);
        const auto noAutomaticRequests = m_frames.size();
        deliverCandidate(candidatePage({}), oldReads.candidateId);
        deliverCandidateConfirmed(oldReads.listId);
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_frames.size(), noAutomaticRequests);
        QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QCOMPARE(m_candidateFocusTransfers, 0);
        CandidateInput recovery;
        QVERIFY2(clickCandidateInput({"memoryCandidateFirst", {}}, "memory:candidates:list", recovery), qPrintable(m_candidateDiagnostic));
        QVERIFY(recovery.requestId != oldReads.candidateId && recovery.requestId != secondId);
        QVERIFY(!recovery.envelope["payload"].toObject().contains("cursor"));
        deliverCandidate(candidatePage(candidateRows(5, 2), true, "mc1.reconnected"), recovery.requestId);
        QTRY_VERIFY(m_bridge->memoryCandidatePage().value("live").toBool());
        QVERIFY(!m_panel->property("candidateFocusEligible").toBool());
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        QTRY_VERIFY(observeCandidateTarget({"memoryCandidateNext", {}}).eligible);
        auto *next = profileItem("memoryCandidateNext", ProfileScope::Page);
        QVERIFY(next);
        next->forceActiveFocus(Qt::TabFocusReason);
        QVERIFY(next->hasActiveFocus());
        CandidateInput current;
        QVERIFY2(clickCandidateInput({"memoryCandidateNext", {}}, "memory:candidates:list", current), qPrintable(m_candidateDiagnostic));
        QVERIFY(current.requestId != recovery.requestId && current.requestId != oldReads.candidateId);
        QTRY_COMPARE(candidateFocusContext().value("candidateReadId").toString(), current.requestId);
        QVERIFY2(candidateFocusBoundTo(current, "next"), qPrintable(m_candidateDiagnostic));
        QVERIFY(m_panel->property("candidateFocusSerial").toULongLong() > oldSerial);
        const auto currentSerial = m_panel->property("candidateFocusSerial").toULongLong();
        const auto framesBeforeOldReplies = m_frames.size();
        deliverCandidate(candidatePage({}), oldReads.candidateId);
        deliverCandidateConfirmed(oldReads.listId);
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QVERIFY2(candidateFocusBoundTo(current, "next"), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_panel->property("candidateFocusSerial").toULongLong(), currentSerial);
        QCOMPARE(m_frames.size(), framesBeforeOldReplies);
        QCOMPARE(m_candidateFocusTransfers, 0);
        deliverCandidate(candidatePage({}), current.requestId);
        auto *first = profileItem("memoryCandidateFirst", ProfileScope::Page);
        QVERIFY(first);
        QTRY_VERIFY(first->hasActiveFocus());
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("requestId").toString(), current.requestId);
        QCOMPARE(m_bridge->memoryFeedback().value("candidates").toMap().value("status").toString(), QString("success"));
        QCOMPARE(m_bridge->memoryCandidatePage().value("pageNumber").toInt(), 2);
        QVERIFY(m_bridge->memoryCandidatePage().value("live").toBool());
        QVERIFY(!m_bridge->memoryCandidatePage().value("blocked").toBool());
        QCOMPARE(rendererCommandCount(command), oldDecision.before.actionCount + 1);
        QCOMPARE(rendererCommandCount("memory:list"), oldDecision.before.listCount + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), oldDecision.before.candidateCount + 3);
        QCOMPARE(m_candidateFocusTransfers, 1);
        QVERIFY2(waitForCandidateFrameAndPostedEvent(), qPrintable(m_candidateDiagnostic));
        QCOMPARE(m_candidateFocusTransfers, 1);
        QVERIFY(!m_panel->property("candidateFocusPending").toBool());
        QVERIFY(candidateFocusContext().isEmpty());
        candidateFixedStage("settled");
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void relatedMemoryFiveTabsKeepTheirLabelsAtNarrowWidths_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("760x650") << 760 << 650;
        QTest::newRow("1000x900") << 1000 << 900;
    }
    void relatedMemoryFiveTabsKeepTheirLabelsAtNarrowWidths() {
        QFETCH(int, width);
        QFETCH(int, height);
        loadPanel();
        QVERIFY(m_panel && m_window);
        m_window->resize(width, height);
        QVERIFY(selectMemoryRecallPage());
        const QStringList names{"memories", "summary", "profile", "backup", "recall"};
        const QStringList labels{"记忆", "摘要", "你的资料", "备份", "关联回忆"};
        auto *tabs = m_panel->findChild<QQuickItem *>("memoryTabs");
        QVERIFY(tabs);
        qreal previousRight = -1;
        for (int index = 0; index < names.size(); ++index) {
            const auto name = names[index];
            QTRY_VERIFY(profileItemState("memoryTab-" + name, ProfileScope::Page)["readable"].toBool());
            auto *button = profileItem("memoryTab-" + name, ProfileScope::Page);
            auto *label = profileItem("memoryTabLabel-" + name, ProfileScope::Page);
            QVERIFY(button && label);
            QCOMPARE(button->property("index").toInt(), index);
            QCOMPARE(button->property("text").toString(), labels[index]);
            QCOMPARE(label->property("text").toString(), labels[index]);
            QCOMPARE(label->property("textFormat").toInt(), 0);
            QCOMPARE(label->property("maximumLineCount").toInt(), 2);
            QCOMPARE(label->property("elide").toInt(), int(Qt::ElideNone));
            QTRY_VERIFY(!label->property("truncated").toBool());
            QTRY_VERIFY(label->property("lineCount").toInt() >= 1 && label->property("lineCount").toInt() <= 2);
            const auto rect = button->mapRectToScene(QRectF(0, 0, button->width(), button->height()));
            QVERIFY(rect.left() > previousRight);
            QVERIFY(rect.right() <= m_window->width());
            previousRight = rect.right();
        }
        QCOMPARE(tabs->property("currentIndex").toInt(), 4);
        QCOMPARE(m_frames.size(), 0);
    }
    void relatedMemoryUsesOneSubmitAndReadOnlyPlainTextResults_data() {
        QTest::addColumn<bool>("viaReturn");
        QTest::newRow("production-button") << false;
        QTest::newRow("return-key") << true;
    }
    void relatedMemoryUsesOneSubmitAndReadOnlyPlainTextResults() {
        QFETCH(bool, viaReturn);
        loadPanel();
        QVERIFY(selectMemoryRecallPage());
        m_bridge->m_draft = "聊天草稿";
        m_bridge->m_state["memory"] = QVariantMap{{"memories", QVariantList{QVariantMap{{"id", "managed-id"}, {"text", "已确认记忆"}}}}, {"hasMore", true}};
        m_bridge->m_memoryQuery = "原文字筛选";
        m_bridge->m_memoryCursor = "managed-cursor";
        m_bridge->m_memoryListLive = true;
        emit m_bridge->changed();
        const auto state = m_bridge->state(), feedback = m_bridge->memoryFeedback();
        const auto messages = m_bridge->messages();
        auto *query = profileItem("memoryRecallQuery", ProfileScope::Page);
        QVERIFY(query);
        QVERIFY(query->setProperty("text", "  一起看月亮  "));
        if (viaReturn) {
            query->forceActiveFocus();
            QTest::keyClick(m_window.get(), Qt::Key_Return);
        } else {
            QTRY_VERIFY(profileItemState("memoryRecallSubmit", ProfileScope::Page)["readable"].toBool());
            QVERIFY2(clickProfileItem("memoryRecallSubmit", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        }
        QCOMPARE(rendererCommandCount("memory:query"), 1);
        const auto envelope = lastRendererCommand("memory:query");
        QCOMPARE(envelope["payload"].toObject()["query"].toString(), QString("一起看月亮"));
        QCOMPARE(envelope["payload"].toObject()["top_k"].toInt(), 10);
        auto *submit = profileItem("memoryRecallSubmit", ProfileScope::Page);
        QVERIFY(submit && !submit->isEnabled());
        QVERIFY(query->isEnabled());
        QVERIFY(query->setProperty("text", "下一次查询草稿"));
        query->forceActiveFocus();
        QTest::keyClick(m_window.get(), Qt::Key_Return);
        QCOMPARE(rendererCommandCount("memory:query"), 1);
        deliverRecall(envelope["request_id"].toString(), QJsonArray{"<b>作为纯文本显示</b>", "仍生效的观察"}, "hybrid", "vector_search_completed", 2);
        QTRY_VERIFY(profileItem("memoryRecallText0", ProfileScope::Page) != nullptr);
        auto *result = profileItem("memoryRecallText0", ProfileScope::Page);
        QVERIFY(result && result->property("readOnly").toBool());
        QCOMPARE(result->property("textFormat").toInt(), 0);
        QCOMPARE(result->property("text").toString(), QString("<b>作为纯文本显示</b>"));
        QVERIFY(profileItem("memoryRecallText1", ProfileScope::Page));
        QCOMPARE(profileItem("memoryRecallMode", ProfileScope::Page)->property("text").toString(), QString("本地混合检索"));
        QVERIFY(profileItem("memoryRecallIndexPending", ProfileScope::Page)->isVisible());
        QVERIFY(profileItem("memoryRecallIndexPending", ProfileScope::Page)->property("text").toString().contains("索引尚不完整"));
        QVERIFY(profileItem("memoryRecallSubmittedQuery", ProfileScope::Page)->property("text").toString().contains("一起看月亮"));
        QCOMPARE(query->property("text").toString(), QString("下一次查询草稿"));
        for (const auto &name : {"memoryEdit0", "memoryDelete0", "memoryPin0", "memoryCandidateConfirm0", "memoryLoadMore"}) {
            const auto *control = profileItem(name, ProfileScope::Page);
            QVERIFY(!control || !control->isVisible());
        }
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        QVERIFY(tabs && tabs->setProperty("currentIndex", 0));
        QCOMPARE(m_bridge->state(), state);
        QCOMPARE(m_bridge->memoryFeedback(), feedback);
        QCOMPARE(m_bridge->messages(), messages);
        QCOMPARE(m_bridge->draft(), QString("聊天草稿"));
        QCOMPARE(m_bridge->memoryQuery(), QString("原文字筛选"));
        QCOMPARE(m_bridge->m_memoryCursor, QString("managed-cursor"));
        QVERIFY(m_bridge->m_memoryListLive);
        QVERIFY(tabs->setProperty("currentIndex", 4));
        QVERIFY(m_panel->setProperty("page", "settings"));
        QVERIFY(m_panel->setProperty("page", "memory"));
        QCOMPARE(query->property("text").toString(), QString("下一次查询草稿"));
        QCOMPARE(m_bridge->memoryRecallState().value("results").toStringList().size(), 2);
        m_bridge->clearMemoryRecall();
        QTRY_COMPARE(query->property("text").toString(), QString());
        QTRY_VERIFY(!profileItem("memoryRecallText0", ProfileScope::Page));
        QCOMPARE(rendererCommandCount("memory:query"), 1);
        QCOMPARE(m_bridge->state(), state);
        QCOMPARE(m_bridge->draft(), QString("聊天草稿"));
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void relatedMemorySyntheticCompositionCannotSubmit() {
        loadPanel();
        QVERIFY(selectMemoryRecallPage());
        auto *query = profileItem("memoryRecallQuery", ProfileScope::Page);
        QVERIFY(query && query->setProperty("text", "已有输入"));
        query->forceActiveFocus();
        QInputMethodEvent preedit("正在组合", {});
        QCoreApplication::sendEvent(m_window.get(), &preedit);
        QTRY_VERIFY(query->property("inputMethodComposing").toBool());
        // This is a synthetic Qt preedit assertion, not physical IME acceptance.
        QVERIFY(QMetaObject::invokeMethod(m_panel, "submitMemoryRecall"));
        QCOMPARE(rendererCommandCount("memory:query"), 0);
        const auto *submit = profileItem("memoryRecallSubmit", ProfileScope::Page);
        QVERIFY(submit && !submit->isEnabled());
        QInputMethodEvent commit;
        commit.setCommitString("已提交输入");
        QCoreApplication::sendEvent(m_window.get(), &commit);
        QTRY_VERIFY(!query->property("inputMethodComposing").toBool());
        QVERIFY(QMetaObject::invokeMethod(m_panel, "submitMemoryRecall"));
        QCOMPARE(rendererCommandCount("memory:query"), 1);
    }
    void relatedMemoryModeAndEmptyResultAreVisible_data() {
        QTest::addColumn<QString>("mode");
        QTest::addColumn<QString>("reason");
        QTest::addColumn<QString>("label");
        QTest::newRow("hybrid-empty-vector") << QString("hybrid") << QString("vector_search_completed") << QString("本地混合检索");
        QTest::newRow("lexical-fallback") << QString("lexical_fallback") << QString("model_unavailable") << QString("词法回退");
        QTest::newRow("unknown-path") << QString("unknown") << QString("vector_search_failed") << QString("检索方式未确认");
    }
    void relatedMemoryModeAndEmptyResultAreVisible() {
        QFETCH(QString, mode);
        QFETCH(QString, reason);
        QFETCH(QString, label);
        loadPanel();
        QVERIFY(selectMemoryRecallPage());
        auto *query = profileItem("memoryRecallQuery", ProfileScope::Page);
        QVERIFY(query && query->setProperty("text", "输入仍然保留"));
        QVERIFY(QMetaObject::invokeMethod(m_panel, "submitMemoryRecall"));
        const auto id = m_bridge->memoryRecallState().value("requestId").toString();
        deliverRecall(id, {}, mode, reason, QJsonValue::Null);
        QTRY_COMPARE(m_bridge->memoryRecallState().value("status").toString(), QString("empty"));
        const auto *modeItem = profileItem("memoryRecallMode", ProfileScope::Page);
        const auto *feedback = profileItem("memoryRecallFeedback", ProfileScope::Page);
        QVERIFY(modeItem && feedback);
        QTRY_VERIFY(modeItem->isVisible());
        QCOMPARE(modeItem->property("text").toString(), label);
        QCOMPARE(modeItem->property("textFormat").toInt(), 0);
        QVERIFY(feedback->property("text").toString().contains("没有返回关联回忆"));
        QVERIFY(!profileItem("memoryRecallText0", ProfileScope::Page));
        QCOMPARE(query->property("text").toString(), QString("输入仍然保留"));
        m_bridge->queryRelatedMemories("失败查询");
        m_bridge->event({{"type", "memory:result"},
            {"request_id", m_bridge->memoryRecallState().value("requestId").toString()},
            {"payload", QJsonObject{{"ok", false}, {"error", "needs_restart"}, {"memories", QJsonArray{}}}}});
        QTRY_COMPARE(m_bridge->memoryRecallState().value("status").toString(), QString("error"));
        QVERIFY(!modeItem->isVisible());
        QVERIFY(feedback->property("text").toString().contains("读取失败"));
        QVERIFY(!feedback->property("text").toString().contains("没有返回关联回忆"));
        QCOMPARE(query->property("text").toString(), QString("输入仍然保留"));
        QCOMPARE(rendererCommandCount("memory:query"), 2);
    }
    void relatedMemoryInputIsClearedOnlyAtItsLocalBoundary_data() {
        QTest::addColumn<QString>("boundary");
        QTest::addColumn<bool>("clearInput");
        QTest::newRow("explicit-clear") << QString("clear") << true;
        QTest::newRow("disconnect-retains-input") << QString("disconnect") << false;
        QTest::newRow("identity-change-clears-input") << QString("persona") << true;
    }
    void relatedMemoryInputIsClearedOnlyAtItsLocalBoundary() {
        QFETCH(QString, boundary);
        QFETCH(bool, clearInput);
        loadPanel();
        QVERIFY(selectMemoryRecallPage());
        auto *query = profileItem("memoryRecallQuery", ProfileScope::Page);
        QVERIFY(query && query->setProperty("text", "本页输入"));
        QVERIFY(QMetaObject::invokeMethod(m_panel, "submitMemoryRecall"));
        const auto id = m_bridge->memoryRecallState().value("requestId").toString();
        if (boundary == "clear") {
            QTRY_VERIFY(profileItemState("memoryRecallClear", ProfileScope::Page)["readable"].toBool());
            QVERIFY2(clickProfileItem("memoryRecallClear", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        } else if (boundary == "disconnect") {
            m_bridge->m_process.finished(1, QProcess::CrashExit);
        } else {
            m_bridge->event({{"type", "persona:scope"}, {"payload", QJsonObject{
                {"persona_id", "next-persona"}, {"epoch", 9}, {"fingerprint", "next-fingerprint"}}}});
        }
        QTRY_COMPARE(query->property("text").toString(), clearInput ? QString() : QString("本页输入"));
        QVERIFY(m_bridge->memoryRecallState().value("results").toStringList().isEmpty());
        QVERIFY(m_bridge->memoryRecallState().value("requestId").toString().isEmpty());
        deliverRecall(id, QJsonArray{"晚到的结果"});
        QVERIFY(m_bridge->memoryRecallState().value("results").toStringList().isEmpty());
        QCOMPARE(rendererCommandCount("memory:query"), 1);
    }
    void profileClearCancelUsesTheProductionControls_data() {
        QTest::addColumn<bool>("selectField");
        QTest::newRow("none-selected") << false;
        QTest::newRow("selection-cancelled") << true;
    }
    void profileClearCancelUsesTheProductionControls() {
        QFETCH(bool, selectField);
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        {
            const auto *confirm = profileItem("profileClearConfirm", ProfileScope::Dialog);
            QVERIFY(confirm && !confirm->isEnabled());
        }
        int fields = 0;
        for (const auto &key : profileClearKeys()) {
            auto *field = profileItem("profileClearField-" + key, ProfileScope::Dialog);
            QVERIFY(field && field->isVisible());
            QVERIFY(!field->property("checked").toBool());
            ++fields;
        }
        QCOMPARE(fields, 11);
        {
            const auto *birthday = profileItem("profileClearField-birthday", ProfileScope::Dialog);
            QVERIFY(birthday && !birthday->isEnabled());
        }
        auto *explanation = profileItem("profileClearExplanation", ProfileScope::Dialog);
        QVERIFY(explanation);
        const auto text = explanation->property("text").toString();
        for (const auto &scope : {"清空会作用于所有人格共用的资料", "你选中的已保存字段", "当前人格", "资料事实", "其他人格已有的资料派生记忆不保证立即同步", "聊天历史", "情绪记忆", "独立确认的记忆", "日记", "世界书"})
            QVERIFY(text.contains(QString::fromUtf8(scope)));
        QVERIFY(!text.contains("其他人格的资料都不在清空范围内"));
        if (selectField) {
            QVERIFY2(clickProfileItem("profileClearField-nickname", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
            QTRY_VERIFY(profileItem("profileClearConfirm", ProfileScope::Dialog) &&
                        profileItem("profileClearConfirm", ProfileScope::Dialog)->isEnabled());
        }
        QCOMPARE(profileUpdateCount(), 0);
        QVERIFY2(clickProfileItem("profileClearCancel", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("cancelled"));
        QCOMPARE(profileUpdateCount(), 0);
        QCOMPARE(m_frames.size(), 0);
        QCOMPARE(m_panel->findChild<QQuickItem *>("profileNickname")->property("text").toString(), QString("测试称呼"));
    }
    void profileClearDirtyDraftMustBeSavedBeforeSelectingFields() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        const QString draft = "保留未保存的称呼编辑";
        QVERIFY2(editProfileField("profileNickname", draft), qPrintable(m_profileDiagnostic));
        auto *clear = m_panel->findChild<QQuickItem *>("profileClear");
        QVERIFY(clear && !clear->isEnabled());
        // Even an explicit signal invocation cannot bypass the bridge's dirty
        // guard; the production handler passes the current dirty value.
        QVERIFY(QMetaObject::invokeMethod(clear, "clicked"));
        QCoreApplication::processEvents();
        QVERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(profileUpdateCount(), 0);
        QCOMPARE(m_frames.size(), 0);
        QCOMPARE(m_panel->findChild<QQuickItem *>("profileNickname")->property("text").toString(), draft);
        QVERIFY(m_panel->property("profileDirty").toBool());
        auto *hint = m_panel->findChild<QQuickItem *>("profileClearDirtyHint");
        QVERIFY(hint && hint->property("text").toString().contains("请先保存"));
    }
    void profileClearReadbackPreservesEditsTypedWhilePending_data() {
        QTest::addColumn<QString>("field");
        QTest::newRow("edited-selected-field") << QString("profileNickname");
        QTest::newRow("edited-other-field") << QString("profileName");
    }
    void profileClearReadbackPreservesEditsTypedWhilePending() {
        QFETCH(QString, field);
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearField-nickname", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearField-interests", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearConfirm", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("pending"));
        QCOMPARE(profileUpdateCount(), 1);
        const QString draft = "清空等待期间输入的新编辑";
        QVERIFY2(editProfileField(field, draft), qPrintable(m_profileDiagnostic));
        const auto revision = m_panel->property("profileEditRevision").toInt();
        auto receipt = profileSnapshot('b', true);
        receipt["operation"] = "clear";
        receipt["cleared_fields"] = QJsonArray{"nickname", "interests"};
        deliverProfile(m_bridge->profileClearState().value("requestId").toString(), receipt);
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("pending"));
        deliverProfile(m_bridge->m_profileReadId, profileSnapshot('b', true));
        QTRY_COMPARE(m_bridge->profileClearState().value("status").toString(), QString("success"));
        auto *edited = m_panel->findChild<QQuickItem *>(field);
        QCOMPARE(edited->property("text").toString(), draft);
        QVERIFY(m_panel->property("profileDirty").toBool());
        QCOMPARE(m_panel->property("profileEditRevision").toInt(), revision);
        QVERIFY(m_panel->findChild<QQuickItem *>("profileSave")->isEnabled());
        QVERIFY(m_bridge->memoryFeedback().value("profile").toMap().isEmpty());
        QCOMPARE(profileUpdateCount(), 1);
        QCOMPARE(m_panel->findChild<QQuickItem *>("profileInterests")->property("text").toString(), QString());
        if (field == "profileName")
            QCOMPARE(m_panel->findChild<QQuickItem *>("profileNickname")->property("text").toString(), QString());
        // Saving the retained draft must not restore untouched values from
        // before the clear. Only a field actually edited while pending may
        // deliberately supply a new value for one of the cleared fields.
        QVERIFY2(clickProfileItem("profileSave", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileUpdateCount(), 2);
        const auto saved = m_frames.last()["envelope"].toObject()["payload"].toObject()["profile"].toObject();
        QVERIFY(!saved.contains("interests"));
        if (field == "profileNickname")
            QCOMPARE(saved["nickname"].toString(), draft);
        else {
            QVERIFY(!saved.contains("nickname"));
            QCOMPARE(saved["name"].toString(), draft);
        }
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void profileExtendedFieldsReadBackAndSaveInTheContractShape() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(deliverFilledProfile('d', profileAllFieldsFilled(), "30"), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileItem("profileFavoriteGames", ProfileScope::Page)->property("text").toString(),
                 QString("测试游戏甲，测试游戏乙"));
        QCOMPARE(profileItem("profileFavoriteAnime", ProfileScope::Page)->property("text").toString(), QString("测试动漫"));
        QVERIFY2(editProfileField("profileFavoriteGames", "新游戏一、新游戏二"), qPrintable(m_profileDiagnostic));
        QVERIFY2(editProfileField("profileAge", "45"), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileSave", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileUpdateCount(), 1);
        const auto saved = m_frames.last()["envelope"].toObject()["payload"].toObject()["profile"].toObject();
        QVERIFY2(saved["favorite_games"].toArray() == (QJsonArray{"新游戏一", "新游戏二"}),
                 qPrintable(compactDiagnostic(saved)));
        QVERIFY(saved["favorite_anime"].toArray() == QJsonArray{"测试动漫"});
        QVERIFY(saved["age"].isDouble());
        QCOMPARE(saved["age"].toInt(), 45);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void profileStoredAgeOutsideTheRangeIsShownAndBlocksSave() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(deliverFilledProfile('d', {{"age", 17}}, "17"), qPrintable(m_profileDiagnostic));
        QVERIFY2(editProfileField("profileNickname", "另一个称呼"), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileSave", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileUpdateCount(), 0);
        const auto feedback = m_bridge->memoryFeedback().value("profile").toMap();
        QCOMPARE(feedback.value("status").toString(), QString("error"));
        QCOMPARE(feedback.value("text").toString(), QString("年龄请填写 18 到 120 之间的整数，资料没有保存。"));
        QCOMPARE(profileItem("profileAge", ProfileScope::Page)->property("text").toString(), QString("17"));
        QCOMPARE(profileItem("profileNickname", ProfileScope::Page)->property("text").toString(), QString("另一个称呼"));
        QVERIFY(m_panel->property("profileDirty").toBool());
    }
    void profileClearElevenChoicesAreReachableInEachWindowSize_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("1000x900") << 1000 << 900;
        QTest::newRow("760x650-narrow") << 760 << 650;
    }
    void profileClearElevenChoicesAreReachableInEachWindowSize() {
        QFETCH(int, width); QFETCH(int, height);
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(deliverFilledProfile('d', profileAllFieldsFilled(), "30"), qPrintable(m_profileDiagnostic));
        m_window->resize(width, height);
        QTRY_COMPARE(m_window->size(), QSize(width, height));
        QVERIFY2(revealProfileEntry("profileClear"), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        QStringList names;
        for (const auto &key : profileClearKeys())
            names << "profileClearField-" + key;
        names << "profileClearCancel" << "profileClearConfirm";
        for (const auto &name : names) {
            const auto state = profileItemState(name, ProfileScope::Dialog);
            const QVariantMap observed = state.toVariantMap();
            // Fully visible: the clipped rectangle is the whole control.
            const bool whole = state["readable"].toBool() && state["pointInsideClip"].toBool() &&
                qAbs(state["clipWidth"].toDouble() - state["width"].toDouble()) <= .5 &&
                qAbs(state["clipHeight"].toDouble() - state["height"].toDouble()) <= .5;
            QVERIFY2(whole, qPrintable(NativeCheck::describe("PROFILE_CLEAR_CHOICE_CLIPPED", observed)));
            auto *item = profileItem(name, ProfileScope::Dialog);
            if (name == "profileClearConfirm") {
                QVERIFY(item && !item->isEnabled());
                continue;
            }
            QVERIFY2(item && item->isEnabled(), qPrintable(NativeCheck::describe("PROFILE_CLEAR_CHOICE_DISABLED", observed)));
            const auto hit = NativeCheck::hitTest(m_window.get(), QPointF(state["pointX"].toInt(), state["pointY"].toInt()), item);
            QVERIFY2(hit.accepted(), qPrintable(NativeCheck::describe("PROFILE_CLEAR_CHOICE_HIT", hit.metadata())));
        }
        QVERIFY2(clickProfileItem("profileClearCancel", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(profileUpdateCount(), 0);
    }
    void profileClearEmptyFieldLabelsStayReadable() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        // The dialog glass behind the labels as sampled from the profile
        // fields r1 formal capture. The GUI check reads rendered pixels.
        const QColor glass("#2f4346");
        QColor enabledColor, disabledColor;
        for (const auto &key : profileClearKeys()) {
            auto *field = profileItem("profileClearField-" + key, ProfileScope::Dialog);
            auto *label = profileItem("profileClearFieldLabel-" + key, ProfileScope::Dialog);
            QVERIFY2(field && label, qPrintable(key));
            QCOMPARE(field->property("contentItem").value<QQuickItem *>(), label);
            QVERIFY(label->isVisible());
            QVERIFY(!field->property("text").toString().isEmpty());
            QCOMPARE(label->property("text").toString(), field->property("text").toString());
            QVERIFY(!label->property("truncated").toBool());
            QVERIFY2(label->property("leftPadding").toDouble() + label->property("contentWidth").toDouble() <=
                     label->width() + .5, qPrintable(key));
            const auto color = label->property("color").value<QColor>();
            const double contrast = NativeCheck::contrastRatio(color, glass);
            QVERIFY2(contrast >= 4.5, qPrintable(key + " " + color.name() + " " + QString::number(contrast)));
            (field->isEnabled() ? enabledColor : disabledColor) = color;
        }
        // The default fixture has both saved and empty fields; empty ones read
        // as unavailable by being dimmer, not by disappearing.
        QVERIFY(enabledColor.isValid() && disabledColor.isValid());
        QVERIFY(NativeCheck::relativeLuminance(disabledColor) < NativeCheck::relativeLuminance(enabledColor));
        QVERIFY2(clickProfileItem("profileClearCancel", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(profileUpdateCount(), 0);
    }
    void profileActionBarStaysVisibleAtEveryScrollOffset_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<bool>("mustScroll");
        QTest::newRow("1000x900") << 1000 << 900 << false;
        QTest::newRow("760x650-narrow") << 760 << 650 << true;
    }
    void profileActionBarStaysVisibleAtEveryScrollOffset() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(bool, mustScroll);
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        // A stored out-of-range age makes the save answer locally, so the
        // receipt's visibility is read without a backend reply.
        QVERIFY2(deliverFilledProfile('d', {{"age", 17}}, "17"), qPrintable(m_profileDiagnostic));
        m_window->resize(width, height);
        QTRY_COMPARE(m_window->size(), QSize(width, height));
        const QDeadlineTimer deadline(QTest::defaultTryTimeout.load(std::memory_order_relaxed), Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *scroll = profileItem("memoryPageScroll", ProfileScope::Page);
        auto *content = feedbackScrollContent();
        auto *bar = profileItem("profileActionBar", ProfileScope::Page);
        QVERIFY(scroll && content && bar && bar->isVisible());
        for (auto *ancestor = bar->parentItem(); ancestor; ancestor = ancestor->parentItem())
            QVERIFY2(ancestor != scroll, "PROFILE_ACTION_BAR_INSIDE_PAGE_SCROLL");
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        const QVariantMap range{{"minimum", minimum}, {"maximum", maximum}, {"viewportHeight", content->height()}};
        // The narrow window must really scroll, or the offsets below prove nothing.
        QVERIFY2(!mustScroll || maximum - minimum > 40, qPrintable(NativeCheck::describe("PROFILE_FORM_DOES_NOT_SCROLL", range)));
        for (const double offset : {minimum, maximum}) {
            QVERIFY(content->setProperty("contentY", offset));
            QVERIFY(feedbackLayoutSettled(deadline));
            QVERIFY2(qAbs(content->property("contentY").toDouble() - offset) <= .5,
                     qPrintable(NativeCheck::describe("PROFILE_FORM_OFFSET_NOT_APPLIED", range)));
            for (const auto *name : {"profileSave", "profileClear", "profileClearRefresh"}) {
                auto *item = profileItem(name, ProfileScope::Page);
                auto observed = profileItemState(name, ProfileScope::Page).toVariantMap();
                observed.insert({{"contentY", offset}, {"maximum", maximum}});
                QVERIFY2(item && feedbackItemFullyVisible(item) && observed.value("readable").toBool() &&
                         observed.value("pointInsideClip").toBool(),
                         qPrintable(NativeCheck::describe("PROFILE_ACTION_NOT_FULLY_VISIBLE", observed)));
                if (!item->isEnabled())
                    continue;
                const auto hit = NativeCheck::hitTest(m_window.get(),
                    QPointF(observed.value("pointX").toInt(), observed.value("pointY").toInt()), item);
                QVERIFY2(hit.accepted(), qPrintable(NativeCheck::describe("PROFILE_ACTION_HIT", hit.metadata())));
            }
        }
        // Still at the bottom offset: edit the last field, which that offset
        // shows, then one save through the bar and its receipt, with no
        // scrolling in between. 16 stays outside the range, so the save is
        // still answered locally.
        QVERIFY2(editProfileField("profileAge", "16"), qPrintable(m_profileDiagnostic));
        QVERIFY(feedbackLayoutSettled(deadline));
        QVERIFY2(clickProfileItem("profileSave", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileUpdateCount(), 0);
        const QString expected = "年龄请填写 18 到 120 之间的整数，资料没有保存。";
        QTRY_COMPARE(m_bridge->memoryFeedback().value("profile").toMap().value("text").toString(), expected);
        QVERIFY(feedbackLayoutSettled(deadline));
        auto *feedback = profileItem("profileFeedback", ProfileScope::Page);
        auto shown = profileItemState("profileFeedback", ProfileScope::Page).toVariantMap();
        shown.insert({{"contentY", content->property("contentY").toDouble()}, {"maximum", maximum}});
        QVERIFY2(feedback && feedback->property("text").toString() == expected && feedbackItemFullyVisible(feedback) &&
                 shown.value("readable").toBool(), qPrintable(NativeCheck::describe("PROFILE_RECEIPT_NOT_VISIBLE", shown)));
        QVERIFY(m_panel->property("profileDirty").toBool());
    }
    void profileClearSelectsTheNewFieldsAndReadsThemBackEmpty() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(deliverFilledProfile('d', profileAllFieldsFilled(), "30"), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        for (const auto *name : {"profileClearField-favorite_games", "profileClearField-favorite_anime", "profileClearField-age"})
            QVERIFY2(clickProfileItem(name, ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(profileItem("profileClearConfirm", ProfileScope::Dialog) &&
                    profileItem("profileClearConfirm", ProfileScope::Dialog)->isEnabled());
        QVERIFY2(clickProfileItem("profileClearConfirm", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(profileUpdateCount(), 1);
        const auto body = m_frames.last()["envelope"].toObject()["payload"].toObject();
        QVERIFY2(body["clear_fields"].toArray() == (QJsonArray{"favorite_games", "favorite_anime", "age"}),
                 qPrintable(compactDiagnostic(body)));
        QCOMPARE(body["expected_profile_snapshot"].toString(), QString(64, 'd'));
        auto cleared = profileAllFieldsFilled();
        cleared["favorite_games"] = QJsonArray{};
        cleared["favorite_anime"] = QJsonArray{};
        cleared["age"] = QJsonValue(QJsonValue::Null);
        auto receipt = profileSnapshot('e', false, cleared);
        receipt["operation"] = "clear";
        receipt["cleared_fields"] = QJsonArray{"favorite_games", "favorite_anime", "age"};
        deliverProfile(m_bridge->profileClearState().value("requestId").toString(), receipt);
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("pending"));
        deliverProfile(m_bridge->m_profileReadId, profileSnapshot('e', false, cleared));
        QTRY_COMPARE(m_bridge->profileClearState().value("status").toString(), QString("success"));
        QVERIFY(m_bridge->profileClearState().value("text").toString().contains("喜欢的游戏、喜欢的动漫、年龄"));
        for (const auto *name : {"profileFavoriteGames", "profileFavoriteAnime", "profileAge"})
            QTRY_COMPARE(profileItem(name, ProfileScope::Page)->property("text").toString(), QString());
        QCOMPARE(profileItem("profileHobbies", ProfileScope::Page)->property("text").toString(), QString("测试爱好"));
        QCOMPARE(profileUpdateCount(), 1);
    }
    void profileNewFieldDraftSurvivesTheClearReadback() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(deliverFilledProfile('d', profileAllFieldsFilled(), "30"), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearField-nickname", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearConfirm", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("pending"));
        const QString draft = "等待期间的新动漫";
        QVERIFY2(editProfileField("profileFavoriteAnime", draft), qPrintable(m_profileDiagnostic));
        auto cleared = profileAllFieldsFilled();
        cleared["nickname"] = "";
        auto receipt = profileSnapshot('e', false, cleared);
        receipt["operation"] = "clear";
        receipt["cleared_fields"] = QJsonArray{"nickname"};
        deliverProfile(m_bridge->profileClearState().value("requestId").toString(), receipt);
        deliverProfile(m_bridge->m_profileReadId, profileSnapshot('e', false, cleared));
        QTRY_COMPARE(m_bridge->profileClearState().value("status").toString(), QString("success"));
        QCOMPARE(profileItem("profileFavoriteAnime", ProfileScope::Page)->property("text").toString(), draft);
        QCOMPARE(profileItem("profileNickname", ProfileScope::Page)->property("text").toString(), QString());
        QVERIFY(m_panel->property("profileDirty").toBool());
        QVERIFY2(clickProfileItem("profileSave", ProfileScope::Page), qPrintable(m_profileDiagnostic));
        QCOMPARE(profileUpdateCount(), 2);
        const auto saved = m_frames.last()["envelope"].toObject()["payload"].toObject()["profile"].toObject();
        QVERIFY2(!saved.contains("nickname"), qPrintable(compactDiagnostic(saved)));
        QVERIFY(saved["favorite_anime"].toArray() == QJsonArray{draft});
        QCOMPARE(saved["age"].toInt(), 30);
    }
    void profileClearSnapshotChangeClosesTheProductionConfirmation() {
        QVERIFY2(loadProfilePanel(), qPrintable(m_profileDiagnostic));
        QVERIFY2(openProfileClear(), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickProfileItem("profileClearField-nickname", ProfileScope::Dialog), qPrintable(m_profileDiagnostic));
        {
            const auto *confirm = profileItem("profileClearConfirm", ProfileScope::Dialog);
            QVERIFY(confirm && confirm->isEnabled());
        }
        deliverProfile(m_bridge->request("user:profile:get"), profileSnapshot('c'));
        QTRY_VERIFY(!m_dialog->property("visible").toBool());
        {
            const auto *confirm = profileItem("profileClearConfirm", ProfileScope::Dialog);
            QVERIFY(confirm && !confirm->isEnabled());
        }
        QCOMPARE(m_bridge->profileClearState().value("status").toString(), QString("stale"));
        QCOMPARE(profileUpdateCount(), 0);
    }
    void summaryReadUsesTheProductionDirectoryAndSelectablePlainText_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::newRow("591x546") << 591 << 546;
        QTest::newRow("760x650") << 760 << 650;
    }
    void summaryReadUsesTheProductionDirectoryAndSelectablePlainText() {
        QFETCH(int, width);
        QFETCH(int, height);
        const auto clearFocus = qScopeGuard([] { RuntimeBridgeTest::setCandidateFocusWindow(nullptr); });
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(2), width, height), qPrintable(m_profileDiagnostic));
        setCandidateFocusWindow(m_window.get());
        const auto *scope = profileItem("summaryReadScope", ProfileScope::Page);
        auto *list = profileItem("summaryDirectoryList", ProfileScope::Page);
        auto *body = profileItem("summaryDetailText", ProfileScope::Page);
        QVERIFY(scope && list && body);
        QCOMPARE(list->property("count").toInt(), 2);
        QVERIFY(scope->property("text").toString().contains("当前人格"));
        QVERIFY(scope->property("text").toString().contains("当前会话"));
        QVERIFY(!scope->property("text").toString().contains("dream-room"));
        QVERIFY(scope->property("text").toString().contains("不是原始消息"));
        QCOMPARE(scope->property("textFormat").toInt(), 0);
        const auto id = summaryReadId(0);
        const auto name = "summaryDirectoryEntry-" + id;
        QTRY_VERIFY(profileItem(name, ProfileScope::Page));
        auto *entry = profileItem(name, ProfileScope::Page);
        QCOMPARE(entry->property("text").toString(), QString("摘要 1 · 来源消息 2 条"));
        QVERIFY(!entry->property("text").toString().contains(id));
        QSignalSpy clicks(entry, SIGNAL(clicked()));
        QVERIFY(clicks.isValid());
        QVERIFY2(clickSummaryReadControl(name), qPrintable(m_profileDiagnostic));
        QCOMPARE(clicks.size(), 1);
        QCOMPARE(rendererCommandCount("summary:get"), 1);
        const auto envelope = lastRendererCommand("summary:get");
        QCOMPARE(envelope["payload"].toObject()["summary_id"].toString(), id);
        QCOMPARE(envelope["payload"].toObject()["conversation_id"].toString(), QString("dream-room"));
        QCOMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("pending"));
        QVERIFY(!profileItem(name, ProfileScope::Page)->isEnabled());
        QVERIFY(!body->isVisible());
        QCOMPARE(body->property("text").toString(), QString());

        QQuickItem sentinel(m_window->contentItem());
        sentinel.setObjectName("summaryReadFocusSentinel");
        sentinel.forceActiveFocus();
        QTRY_COMPARE(m_window->activeFocusItem(), &sentinel);
        const auto text = QString("<b>AI 摘要仍是纯文本</b>\n") + QString(260, QChar(0x957f));
        deliverSummaryDetail(envelope["request_id"].toString(), 0, text);
        QTRY_COMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("success"));
        QTRY_VERIFY(body->isVisible());
        QCOMPARE(m_window->activeFocusItem(), &sentinel);
        QCOMPARE(body->property("text").toString(), text);
        QCOMPARE(body->property("textFormat").toInt(), 0);
        QVERIFY(body->property("readOnly").toBool());
        QVERIFY(body->property("selectByMouse").toBool());
        QVERIFY(body->property("wrapMode").toInt() != 0);
        QTRY_VERIFY(body->property("lineCount").toInt() > 2);
        QVERIFY(body->width() <= list->width() + .5);
        QVERIFY(body->property("contentWidth").toDouble() <= body->width() + .5);
        QVERIFY(QMetaObject::invokeMethod(body, "selectAll"));
        auto selectedText = body->property("selectedText").toString();
        selectedText.replace(QChar(0x2029), QChar('\n'));
        QCOMPARE(selectedText, text);
        body->forceActiveFocus();
        QTest::keyClick(m_window.get(), Qt::Key_Backspace);
        QCOMPARE(body->property("text").toString(), text);
        QVERIFY(profileItem(name, ProfileScope::Page)->property("accented").toBool());
        const auto selected = QQmlProperty(profileItem(name, ProfileScope::Page),
            "Accessible.selected", qmlContext(profileItem(name, ProfileScope::Page)));
        QVERIFY(selected.isValid() && selected.read().toBool());
        QCOMPARE(rendererCommandCount("settings:update"), 0);
        QCOMPARE(rendererCommandCount("summary:status"), 1);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void summaryReadDirectoryMakesTheRecentHundredLimitExplicit() {
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(100), 591, 546, 143, true), qPrintable(m_profileDiagnostic));
        const auto *list = profileItem("summaryDirectoryList", ProfileScope::Page);
        const auto *limit = profileItem("summaryDirectoryLimit", ProfileScope::Page);
        const auto *status = profileItem("summaryDirectoryStatus", ProfileScope::Page);
        QVERIFY(list && limit && status);
        QCOMPARE(list->property("count").toInt(), 100);
        auto model = list->property("model");
        if (model.metaType() == QMetaType::fromType<QJSValue>())
            model = model.value<QJSValue>().toVariant();
        const auto modelRows = model.toList();
        QCOMPARE(modelRows.size(), 100);
        QCOMPARE(modelRows.at(99).toMap().value("summary_id").toString(), summaryReadId(99));
        QVERIFY(list->height() <= 168.5);
        QVERIFY(status->property("text").toString().contains("100"));
        QVERIFY(status->property("text").toString().contains("143"));
        QVERIFY(limit->property("text").toString().contains("还有更早"));
        QVERIFY(limit->property("text").toString().contains("最近 100"));
        QVERIFY(limit->property("text").toString().contains("不支持翻页"));
        QVERIFY(!profileItem("summaryDirectoryLoadMore", ProfileScope::Page));
        QVERIFY(!profileItem("summaryDirectoryEntry-" + summaryReadId(100), ProfileScope::Page));
        QCOMPARE(rendererCommandCount("summary:get"), 0);
        QCOMPARE(rendererCommandCount("summary:status"), 1);
    }
    void summaryReadDirectorySeparatesEmptyInvalidAndError_data() {
        QTest::addColumn<QString>("result");
        QTest::newRow("empty-success") << QString("empty");
        QTest::newRow("invalid-catalog") << QString("invalid");
        QTest::newRow("read-error") << QString("error");
    }
    void summaryReadDirectorySeparatesEmptyInvalidAndError() {
        QFETCH(QString, result);
        QVERIFY2(prepareSummaryReadPanel({}), qPrintable(m_profileDiagnostic));
        if (result != "empty") {
            auto read = summaryReadDirectoryBaseline();
            QVERIFY2(clickSummaryReadControl("summaryDirectoryRefresh"), qPrintable(m_profileDiagnostic));
            QVERIFY2(correlateSummaryReadDirectory(read), qPrintable(m_profileDiagnostic));
            auto payload = summaryReadPayload(QJsonArray{QJsonObject{{"summary_id", "invalid"}}});
            if (result == "error") {
                payload = summaryReadPayload({});
                payload["ok"] = false;
                payload["error"] = "synthetic-unavailable";
            }
            m_bridge->event({{"type", "summary:result"},
                {"request_id", read.requestId}, {"payload", payload}});
            QVERIFY2(acceptSummaryReadDirectory(read, {}, false, result != "error"), qPrintable(m_profileDiagnostic));
        }
        const auto *status = profileItem("summaryDirectoryStatus", ProfileScope::Page);
        const auto *list = profileItem("summaryDirectoryList", ProfileScope::Page);
        QVERIFY(status && list);
        QTRY_COMPARE(status->property("text").toString().contains("尚无可用"), result == "empty");
        QVERIFY(!status->property("text").toString().isEmpty());
        QCOMPARE(status->property("textFormat").toInt(), 0);
        QCOMPARE(list->property("count").toInt(), 0);
        QVERIFY(!list->isVisible());
        QVERIFY(!profileItem("summaryDetailText", ProfileScope::Page)->isVisible());
        QCOMPARE(rendererCommandCount("summary:get"), 0);
    }
    void summaryReadPendingAndFailureNeverShowAnEmptySuccess_data() {
        QTest::addColumn<QString>("result");
        QTest::newRow("unavailable") << QString("unavailable");
        QTest::newRow("empty-body") << QString("empty-body");
        QTest::newRow("other-summary-id") << QString("other-id");
    }
    void summaryReadPendingAndFailureNeverShowAnEmptySuccess() {
        QFETCH(QString, result);
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(2)), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(0)), qPrintable(m_profileDiagnostic));
        auto *body = profileItem("summaryDetailText", ProfileScope::Page);
        auto *feedback = profileItem("summaryDetailFeedback", ProfileScope::Page);
        QVERIFY(body && feedback);
        QCOMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("pending"));
        QVERIFY(!feedback->property("text").toString().isEmpty());
        QVERIFY(!body->isVisible());
        QCOMPARE(body->property("text").toString(), QString());
        const auto requestId = lastRendererCommand("summary:get")["request_id"].toString();
        auto payload = summaryReadDetailPayload(result == "other-id" ? 1 : 0, "");
        if (result == "other-id") payload = summaryReadDetailPayload(1, "其他摘要正文");
        if (result == "unavailable")
            payload = {{"ok", false}, {"operation", "detail"}, {"conversation_id", "dream-room"},
                {"code", "summary_unavailable"}, {"error", "Conversation summary is unavailable"},
                {"persona_id", m_bridge->m_persona["persona_id"]},
                {"persona_epoch", m_bridge->m_persona["epoch"]},
                {"persona_fingerprint", m_bridge->m_persona["fingerprint"]}};
        m_bridge->event({{"type", "summary:result"}, {"request_id", requestId}, {"payload", payload}});
        QTRY_COMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("error"));
        QVERIFY(!feedback->property("text").toString().isEmpty());
        QVERIFY(!feedback->property("text").toString().contains("尚无可用"));
        QVERIFY(!body->isVisible());
        QCOMPARE(body->property("text").toString(), QString());
        QCOMPARE(rendererCommandCount("summary:get"), 1);
    }
    void summaryReadSelectionUsesIdsAndSuppressesAnOlderReply() {
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(2)), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(0)), qPrintable(m_profileDiagnostic));
        const auto first = lastRendererCommand("summary:get")["request_id"].toString();
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(1)), qPrintable(m_profileDiagnostic));
        const auto second = lastRendererCommand("summary:get")["request_id"].toString();
        QVERIFY(first != second);
        QCOMPARE(m_bridge->summaryDetailState().value("summaryId").toString(), summaryReadId(1));
        deliverSummaryDetail(first, 0, "旧请求不应显示");
        QCOMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("pending"));
        QCOMPARE(profileItem("summaryDetailText", ProfileScope::Page)->property("text").toString(), QString());
        deliverSummaryDetail(second, 1, "当前选中的正文");
        QTRY_COMPARE(profileItem("summaryDetailText", ProfileScope::Page)->property("text").toString(), QString("当前选中的正文"));
        QVERIFY(profileItem("summaryDirectoryEntry-" + summaryReadId(1), ProfileScope::Page)->property("accented").toBool());
        QVERIFY(!profileItem("summaryDirectoryEntry-" + summaryReadId(0), ProfileScope::Page)->property("accented").toBool());
        QCOMPARE(rendererCommandCount("summary:get"), 2);
    }
    void summaryReadSameIdInANewPersonaCannotReviveTheOldBody() {
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(1)), qPrintable(m_profileDiagnostic));
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(0)), qPrintable(m_profileDiagnostic));
        const auto oldRequest = lastRendererCommand("summary:get")["request_id"].toString();
        const auto oldPayload = summaryReadDetailPayload(0, "旧人格正文");
        m_bridge->event({{"type", "persona:scope"}, {"payload", QJsonObject{
            {"persona_id", "summary-next-persona"}, {"epoch", 9}, {"fingerprint", "summary-next-fingerprint"}}}});
        auto *body = profileItem("summaryDetailText", ProfileScope::Page);
        QVERIFY(body);
        QTRY_VERIFY(!body->isVisible());
        QCOMPARE(body->property("text").toString(), QString());
        QVERIFY2(clickSummaryReadControl("summaryDirectoryRefresh"), qPrintable(m_profileDiagnostic));
        deliverSummaryDirectory(lastRendererCommand("summary:status")["request_id"].toString(), summaryReadRows(1));
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(0)), qPrintable(m_profileDiagnostic));
        const auto newRequest = lastRendererCommand("summary:get")["request_id"].toString();
        QVERIFY(oldRequest != newRequest);
        m_bridge->event({{"type", "summary:result"}, {"request_id", oldRequest}, {"payload", oldPayload}});
        QCOMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("pending"));
        QCOMPARE(body->property("text").toString(), QString());
        deliverSummaryDetail(newRequest, 0, "新人格正文");
        QTRY_COMPARE(body->property("text").toString(), QString("新人格正文"));
        QCOMPARE(rendererCommandCount("summary:get"), 2);
    }
    void summaryReadRemainsAvailableDuringWriteLockAndLocalPause() {
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(1)), qPrintable(m_profileDiagnostic));
        m_bridge->m_runtimeWritable = false;
        m_bridge->m_offline = true;
        emit m_bridge->changed();
        auto *entry = profileItem("summaryDirectoryEntry-" + summaryReadId(0), ProfileScope::Page);
        auto *refresh = profileItem("summaryDirectoryRefresh", ProfileScope::Page);
        auto *toggle = profileItem("summaryEnabled", ProfileScope::Page);
        QVERIFY(entry && refresh && toggle);
        QTRY_VERIFY(entry->isEnabled());
        QVERIFY(refresh->isEnabled());
        QVERIFY(!toggle->isEnabled());
        QVERIFY2(clickSummaryReadControl(entry->objectName()), qPrintable(m_profileDiagnostic));
        const auto requestId = lastRendererCommand("summary:get")["request_id"].toString();
        QVERIFY(!requestId.isEmpty());
        deliverSummaryDetail(requestId, 0, "暂停时仍可读取本机正文");
        QTRY_VERIFY(profileItem("summaryDetailText", ProfileScope::Page)->isVisible());
        QVERIFY(profileItem("summaryDetailText", ProfileScope::Page)->isEnabled());
        QVERIFY2(clickSummaryReadControl("summaryDirectoryRefresh"), qPrintable(m_profileDiagnostic));
        QCOMPARE(rendererCommandCount("summary:status"), 2);
        QCOMPARE(rendererCommandCount("summary:get"), 1);
        QCOMPARE(rendererCommandCount("settings:update"), 0);
        QCOMPARE(m_frames.size(), 3);
    }
    void summaryReadClearingAndTabChangesPreserveTheOtherPageStateAndOldControls() {
        QVERIFY2(prepareSummaryReadPanel(summaryReadRows(1)), qPrintable(m_profileDiagnostic));
        m_bridge->setDraft("独立的聊天草稿");
        m_bridge->m_memoryQuery = "原有文字筛选";
        m_bridge->m_memoryCursor = "preserved-summary-read-cursor";
        m_bridge->m_memoryListLive = true;
        m_bridge->m_state["memory"] = QVariantMap{{"memories", QVariantList{
            QVariantMap{{"id", "fact-summary-preserved"}, {"text", "现有记忆"}, {"pinned", true}, {"revision", 1}}}},
            {"hasMore", true}};
        emit m_bridge->changed();
        QVERIFY(m_panel->setProperty("profileDirty", true));
        const QDeadlineTimer initialLayout(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(initialLayout));
        const auto state = m_bridge->state();
        const auto feedback = m_bridge->memoryFeedback();
        const auto messages = m_bridge->messages();
        const QStringList oldNames{"summaryEnabled", "summaryStatus", "summaryFeedback",
            "summaryLegacyChoose", "summaryLegacyFeedback", "summaryLegacyConfirm"};
        QList<QPointer<QQuickItem>> oldItems;
        QList<QRectF> oldGeometry;
        for (const auto &name : oldNames) {
            auto *item = profileItem(name, ProfileScope::Page);
            QVERIFY(item);
            oldItems.append(item);
            oldGeometry.append(QRectF(item->position(), item->size()));
        }
        QVERIFY2(clickSummaryReadControl("summaryDirectoryEntry-" + summaryReadId(0)), qPrintable(m_profileDiagnostic));
        deliverSummaryDetail(lastRendererCommand("summary:get")["request_id"].toString(), 0, "只读摘要正文");
        QTRY_COMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("success"));
        auto *tabs = profileItem("memoryTabs", ProfileScope::Page);
        QVERIFY(tabs && tabs->setProperty("currentIndex", 4));
        QVERIFY(tabs->setProperty("currentIndex", 0));
        QVERIFY(tabs->setProperty("currentIndex", 1));
        QVERIFY(m_panel->setProperty("page", "settings"));
        QVERIFY(m_panel->setProperty("page", "memory"));
        QCOMPARE(profileItem("summaryDetailText", ProfileScope::Page)->property("text").toString(), QString("只读摘要正文"));
        QVERIFY2(clickSummaryReadControl("summaryDetailClear"), qPrintable(m_profileDiagnostic));
        QTRY_COMPARE(m_bridge->summaryDetailState().value("status").toString(), QString("idle"));
        QVERIFY(!profileItem("summaryDetailText", ProfileScope::Page)->isVisible());
        QCOMPARE(profileItem("summaryDetailText", ProfileScope::Page)->property("text").toString(), QString());
        QCOMPARE(m_bridge->state(), state);
        QCOMPARE(m_bridge->memoryFeedback(), feedback);
        QCOMPARE(m_bridge->messages(), messages);
        QCOMPARE(m_bridge->draft(), QString("独立的聊天草稿"));
        QCOMPARE(m_bridge->memoryQuery(), QString("原有文字筛选"));
        QCOMPARE(m_bridge->m_memoryCursor, QString("preserved-summary-read-cursor"));
        QVERIFY(m_bridge->m_memoryListLive);
        QVERIFY(m_panel->property("profileDirty").toBool());
        const QDeadlineTimer settled(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(settled));
        for (int index = 0; index < oldNames.size(); ++index) {
            auto *item = profileItem(oldNames[index], ProfileScope::Page);
            QCOMPARE(item, oldItems[index].data());
            const auto geometry = QRectF(item->position(), item->size());
            QVERIFY(qAbs(geometry.x() - oldGeometry[index].x()) <= .5);
            QVERIFY(qAbs(geometry.y() - oldGeometry[index].y()) <= .5);
            QVERIFY(qAbs(geometry.width() - oldGeometry[index].width()) <= .5);
            QVERIFY(qAbs(geometry.height() - oldGeometry[index].height()) <= .5);
        }
        QCOMPARE(rendererCommandCount("summary:get"), 1);
        QCOMPARE(rendererCommandCount("summary:status"), 1);
        QCOMPARE(rendererCommandCount("settings:update"), 0);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void summaryDeepListTransitionUsesRealControlsAndOwnReadbacks_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<bool>("initiallyEnabled");
        QTest::newRow("591x626-initially-off") << 591 << 626 << false;
        QTest::newRow("591x546-initially-on") << 591 << 546 << true;
        QTest::newRow("760x650-initially-off") << 760 << 650 << false;
    }
    void summaryDeepListTransitionUsesRealControlsAndOwnReadbacks() {
        QFETCH(int, width);
        QFETCH(int, height);
        QFETCH(bool, initiallyEnabled);
        const auto clearFocus = qScopeGuard([] { RuntimeBridgeTest::setCandidateFocusWindow(nullptr); });
        QVERIFY2(prepareSummaryPanel(width, height, initiallyEnabled), qPrintable(m_summaryDiagnostic));
        const int framesBeforeTab = m_frames.size();
        const int savesBeforeTab = rendererCommandCount("settings:update");
        const int readsBeforeTab = rendererCommandCount("summary:status");
        QElapsedTimer transitionClock; transitionClock.start();
        const QDeadlineTimer transitionDeadline(4000, Qt::PreciseTimer);
        SummaryInput tab;
        QVERIFY2(clickSummaryControl("memoryTab-summary", transitionClock, transitionDeadline, tab),
            qPrintable(m_summaryDiagnostic));
        QCOMPARE(tab.clicks, 1);
        QCOMPARE(tab.item.data(), profileItem("memoryTab-summary", ProfileScope::Page));
        QVERIFY(tab.layout.value("ready").toBool());
        QVERIFY(tab.layout.value("last").toMap().value("layoutStable").toBool());
        QVERIFY(summarySelected());
        const QQmlProperty selected(tab.item, "Accessible.checked", qmlContext(tab.item));
        QVERIFY(selected.isValid() && selected.read().toBool());
        QCOMPARE(m_frames.size(), framesBeforeTab);
        QCOMPARE(rendererCommandCount("settings:update"), savesBeforeTab);
        QCOMPARE(rendererCommandCount("summary:status"), readsBeforeTab);
        QVERIFY(summaryShownFromStatus(initiallyEnabled));

        SummaryRound first;
        QVERIFY(armSummaryRound(first, !initiallyEnabled));
        SummaryInput firstToggle;
        // The tab reveal, its real click and this first switch share the same
        // absolute four-second deadline. No per-control clock is restarted.
        QVERIFY2(clickSummaryControl("summaryEnabled", transitionClock, transitionDeadline, firstToggle, &first),
            qPrintable(m_summaryDiagnostic));
        QCOMPARE(firstToggle.clicks, 1);
        QVERIFY(firstToggle.elapsedMs >= tab.elapsedMs && firstToggle.elapsedMs < 4000);
        QVERIFY(firstToggle.layout.value("last").toMap().value("layoutStable").toBool());
        QVERIFY2(summarySaveWasDispatched(first), qPrintable(m_summaryDiagnostic));
        QCOMPARE(firstToggle.item->property("checked").toBool(), !initiallyEnabled);
        QVERIFY(!firstToggle.item->isEnabled());
        const QDeadlineTimer firstReadback = firstToggle.readbackDeadline;
        QVERIFY2(acknowledgeSummaryRound(first, !initiallyEnabled, firstReadback), qPrintable(m_summaryDiagnostic));
        QVERIFY(first.receipt.complete() && !first.receipt.failed());
        QCOMPARE(first.receipt.metadata().value("newSaveCount").toInt(), 1);
        QCOMPARE(first.receipt.metadata().value("newReadCount").toInt(), 1);
        QVERIFY(!m_bridge->memoryFeedback().value("summary").toMap().contains("enabled"));

        SummaryRound restore;
        QVERIFY(armSummaryRound(restore, initiallyEnabled, "restore"));
        QElapsedTimer restoreClock; restoreClock.start();
        const QDeadlineTimer restoreDeadline(4000, Qt::PreciseTimer);
        SummaryInput restoreToggle;
        QVERIFY2(clickSummaryControl("summaryEnabled", restoreClock, restoreDeadline, restoreToggle, &restore),
            qPrintable(m_summaryDiagnostic));
        QCOMPARE(restoreToggle.clicks, 1);
        QVERIFY(restoreToggle.elapsedMs < 4000);
        QVERIFY2(summarySaveWasDispatched(restore), qPrintable(m_summaryDiagnostic));
        QVERIFY(restore.saveId != first.saveId);
        const QDeadlineTimer restoreReadback = restoreToggle.readbackDeadline;
        QVERIFY2(acknowledgeSummaryRound(restore, initiallyEnabled, restoreReadback), qPrintable(m_summaryDiagnostic));
        QVERIFY(restore.receipt.complete() && !restore.receipt.failed());
        QVERIFY(restore.readId != first.readId && restore.readId != restore.saveId);
        QVERIFY(summaryShownFromStatus(initiallyEnabled));
        QCOMPARE(rendererCommandCount("settings:update"), savesBeforeTab + 2);
        QCOMPARE(rendererCommandCount("summary:status"), readsBeforeTab + 2);
        QCOMPARE(m_frames.size(), framesBeforeTab + 4);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void summaryReadbackMismatchCannotPassAfterSuccessfulSave_data() {
        QTest::addColumn<bool>("initiallyEnabled");
        QTest::newRow("initially-off") << false;
        QTest::newRow("initially-on") << true;
    }
    void summaryReadbackMismatchCannotPassAfterSuccessfulSave() {
        QFETCH(bool, initiallyEnabled);
        const auto clearFocus = qScopeGuard([] { RuntimeBridgeTest::setCandidateFocusWindow(nullptr); });
        QVERIFY2(prepareSummaryPanel(591, 546, initiallyEnabled), qPrintable(m_summaryDiagnostic));
        const int framesBeforeTab = m_frames.size();
        QElapsedTimer clock; clock.start();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        SummaryInput tab, toggle;
        QVERIFY2(clickSummaryControl("memoryTab-summary", clock, deadline, tab), qPrintable(m_summaryDiagnostic));
        QCOMPARE(tab.clicks, 1);
        QVERIFY(summarySelected());
        QCOMPARE(m_frames.size(), framesBeforeTab);
        SummaryRound round;
        QVERIFY(armSummaryRound(round, !initiallyEnabled));
        QVERIFY2(clickSummaryControl("summaryEnabled", clock, deadline, toggle, &round), qPrintable(m_summaryDiagnostic));
        QCOMPARE(toggle.clicks, 1);
        QVERIFY2(summarySaveWasDispatched(round), qPrintable(m_summaryDiagnostic));
        const QDeadlineTimer readback = toggle.readbackDeadline;
        // The save ACK succeeds, while its own fresh runtime read returns the
        // old value. A saved request value must not stand in for that read.
        QVERIFY2(acknowledgeSummaryRound(round, initiallyEnabled, readback), qPrintable(m_summaryDiagnostic));
        QVERIFY(round.receipt.failed() && !round.receipt.complete());
        QCOMPARE(round.receipt.failureReason(), QString("readback-value-mismatch"));
        QVERIFY(!round.receipt.matchesComplete(m_bridge->scopeKey(), m_bridge->m_generation,
            m_bridge->memoryFeedback().value("summary").toMap(), round.read,
            m_bridge->state().value("summary").toMap()));
        QCOMPARE(m_bridge->memoryFeedback().value("summary").toMap().value("status").toString(), QString("success"));
        QVERIFY(summaryShownFromStatus(initiallyEnabled));
        QVERIFY(!summaryShownFromStatus(!initiallyEnabled));
        QCOMPARE(m_frames.size(), framesBeforeTab + 2);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void summaryOldStatusCannotSubstituteForSelectingTheTab() {
        const auto clearFocus = qScopeGuard([] { RuntimeBridgeTest::setCandidateFocusWindow(nullptr); });
        QVERIFY2(prepareSummaryPanel(591, 546, false), qPrintable(m_summaryDiagnostic));
        const auto state = m_bridge->state().value("summary").toMap();
        const int frames = m_frames.size();
        QVERIFY(state.value("ok").toBool() && state.contains("status"));
        QCOMPARE(state.value("enabled"), QVariant(false));
        QCOMPARE(profileItem("memoryTabs", ProfileScope::Page)->property("currentIndex").toInt(), 0);
        QVERIFY(!summarySelected());
        QVERIFY(!summaryShownFromStatus(false));
        auto *toggle = profileItem("summaryEnabled", ProfileScope::Page);
        QVERIFY(toggle && toggle->property("checked").toBool() == state.value("enabled").toBool());
        const auto current = SummaryInteractionProbe::inspect(toggle, m_window.get(),
            summarySelected(), m_bridge->scopeKey());
        QVERIFY(!current.eligible);
        SummaryInteractionProbe::StableGate layout;
        QVERIFY(!layout.observe(current, 0, 1).value("ready").toBool());
        QVERIFY(!layout.observe(current, 100, 2).value("ready").toBool());
        SummaryRound round;
        QVERIFY(armSummaryRound(round, false));
        const QVariantMap oldRead{{"requestId", round.oldReadId}, {"status", "success"},
            {"sourceSaveId", round.oldSaveId}, {"command", "summary:status"}};
        QCOMPARE(round.receipt.observe(m_bridge->scopeKey(), m_bridge->m_generation,
            m_bridge->memoryFeedback().value("summary").toMap(), oldRead, state),
            SummaryInteractionProbe::ReceiptTracker::WaitingForSave);
        QVERIFY(!round.receipt.complete());
        QCOMPARE(m_frames.size(), frames);
        QCOMPARE(rendererCommandCount("settings:update"), 0);
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryAdjustmentButtonsAndImportanceRemainWholeAtNarrowWidths_data() {
        QTest::addColumn<int>("width");
        QTest::addColumn<int>("height");
        QTest::addColumn<QString>("op");
        QTest::addColumn<QString>("button");
        for (const auto &size : {QSize(591, 546), QSize(591, 626), QSize(760, 650)}) {
            for (const auto &op : QStringList{"strengthen", "weaken", "reactivate"}) {
                const auto button = op == "strengthen" ? QString("memoryStrengthen0")
                    : op == "weaken" ? QString("memoryWeaken0") : QString("memoryReactivate0");
                QTest::newRow(qPrintable(QString("%1x%2-%3").arg(size.width()).arg(size.height()).arg(op)))
                    << size.width() << size.height() << op << button;
            }
        }
    }
    void memoryAdjustmentButtonsAndImportanceRemainWholeAtNarrowWidths() {
        QFETCH(int, width); QFETCH(int, height); QFETCH(QString, op); QFETCH(QString, button);
        auto rows = batchMemoryRows(0, 1);
        auto row = rows.first().toObject();
        row["importance"] = .5;
        rows[0] = row;
        QVERIFY(prepareBatchPanel(rows, false, {}, width, height));
        auto *importance = batchControl("memoryImportance0");
        auto *flow = batchControl(button) ? batchControl(button)->parentItem() : nullptr;
        auto *content = feedbackScrollContent();
        QVERIFY(importance && flow && content);
        const auto target = importance->mapRectToScene(QRectF(QPointF(), importance->size())).united(
            flow->mapRectToScene(QRectF(QPointF(), flow->size())));
        const auto viewport = content->mapRectToScene(QRectF(QPointF(), content->size()));
        const auto origin = content->property("originY").toDouble();
        const auto minimum = origin - content->property("topMargin").toDouble();
        const auto maximum = std::max(minimum, origin + content->property("contentHeight").toDouble() -
            content->height() + content->property("bottomMargin").toDouble());
        QVERIFY(content->setProperty("contentY", qBound(minimum,
            content->property("contentY").toDouble() + target.center().y() - viewport.center().y(), maximum)));
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        QCOMPARE(importance->property("text").toString(), QString("重要度 0.5"));
        QVERIFY(feedbackItemFullyVisible(importance));
        const QStringList controls{"memoryPin0", "memoryEdit0", "memoryDelete0", "memoryStrengthen0", "memoryWeaken0", "memoryReactivate0"};
        const QStringList labels{"取消固定", "修改", "删除", "强化", "弱化", "重温"};
        for (int index = 0; index < controls.size(); ++index) {
            auto *item = batchControl(controls[index]);
            QVERIFY2(item && item->isVisible() && item->isEnabled() && feedbackItemFullyVisible(item), qPrintable(controls[index]));
            QCOMPARE(item->property("text").toString(), labels[index]);
            auto *label = item->property("contentItem").value<QQuickItem *>();
            QVERIFY(label && !label->property("truncated").toBool());
            const auto point = item->mapToScene(QPointF(item->width() / 2, item->height() / 2));
            const auto hit = NativeCheck::hitTest(m_window.get(), point.toPoint(), item);
            QVERIFY2(hit.accepted(), qPrintable(NativeCheck::describe("MEMORY_ADJUSTMENT_BUTTON_HIT", hit.metadata())));
        }
        const int listBefore = rendererCommandCount("memory:list");
        const int candidateBefore = rendererCommandCount("memory:candidates:list");
        QVERIFY2(batchInput(button), qPrintable(m_profileDiagnostic));
        QCOMPARE(rendererCommandCount("memory:reinforce"), 1);
        const auto sent = lastRendererCommand("memory:reinforce");
        QCOMPARE(sent["payload"].toObject(), (QJsonObject{{"memory_id", batchMemoryId(0)}, {"op", op}}));
        for (const auto &name : controls) QVERIFY2(batchControl(name) && !batchControl(name)->isEnabled(), qPrintable(name));
        const auto after = op == "strengthen" ? .6 : op == "weaken" ? .4 : .65;
        m_bridge->event({{"type", "memory:result"}, {"request_id", sent["request_id"]},
            {"payload", QJsonObject{{"ok", true}, {"memory_id", batchMemoryId(0)}, {"op", op},
                {"changed", true}, {"importance_before", .5}, {"importance_after", after}}}});
        QCOMPARE(rendererCommandCount("memory:list"), listBefore + 1);
        QCOMPARE(rendererCommandCount("memory:candidates:list"), candidateBefore + 1);
        row["importance"] = after;
        rows[0] = row;
        deliverBatchMemories(lastRendererCommand("memory:list")["request_id"].toString(), rows);
        deliverCandidate(candidatePage({}));
        QTRY_VERIFY(batchControl("memoryImportance0"));
        QTRY_COMPARE(batchControl("memoryImportance0")->property("text").toString(),
            op == "reactivate" ? QString("重要度 0.65") : op == "strengthen" ? QString("重要度 0.6") : QString("重要度 0.4"));
        for (const auto &name : controls) QTRY_VERIFY(batchControl(name) && batchControl(name)->isEnabled());
        QCOMPARE(m_bridge->m_process.state(), QProcess::NotRunning);
    }
    void memoryAdjustmentImportanceUsesTwoDecimalsAndTrimsZeros_data() {
        QTest::addColumn<double>("importance");
        QTest::addColumn<QString>("display");
        QTest::newRow("zero") << 0.0 << QString("0");
        QTest::newRow("one-decimal") << .6 << QString("0.6");
        QTest::newRow("reactivate-step") << .65 << QString("0.65");
        QTest::newRow("maximum") << 1.0 << QString("1");
        QTest::newRow("six-decimal-source") << .123456 << QString("0.12");
        QTest::newRow("half-cent") << .125 << QString("0.13");
    }
    void memoryAdjustmentImportanceUsesTwoDecimalsAndTrimsZeros() {
        QFETCH(double, importance); QFETCH(QString, display);
        auto rows = batchMemoryRows(0, 1);
        auto row = rows.first().toObject();
        row["importance"] = importance;
        rows[0] = row;
        QVERIFY(prepareBatchPanel(rows));
        QTRY_VERIFY(batchControl("memoryImportance0"));
        QCOMPARE(batchControl("memoryImportance0")->property("text").toString(), "重要度 " + display);
        QCOMPARE(batchControl("memoryImportance0")->property("textFormat").toInt(), 0);
        QCOMPARE(rendererCommandCount("memory:reinforce"), 0);
    }
    void memoryAdjustmentButtonsFollowExistingSingleActionLocks_data() {
        QTest::addColumn<QString>("lock");
        for (const auto &lock : QStringList{"disconnected", "readonly", "single-action", "delete-batch", "pin-batch", "candidate-batch", "selection", "editing", "deleting"})
            QTest::newRow(qPrintable(lock)) << lock;
    }
    void memoryAdjustmentButtonsFollowExistingSingleActionLocks() {
        QFETCH(QString, lock);
        auto rows = batchMemoryRows(0, 1);
        auto row = rows.first().toObject();
        row["importance"] = .5;
        rows[0] = row;
        QVERIFY(prepareBatchPanel(rows));
        if (lock == "disconnected") m_bridge->m_connected = false;
        else if (lock == "readonly") m_bridge->m_runtimeWritable = false;
        else if (lock == "single-action") m_bridge->setMemoryPinned(batchMemoryId(0), false);
        else if (lock == "delete-batch") m_bridge->m_memoryBatchDelete = {{"status", "pending"}};
        else if (lock == "pin-batch") m_bridge->m_memoryBatchPin = {{"status", "pending"}};
        else if (lock == "candidate-batch") m_bridge->m_candidateBatch = {{"status", "pending"}};
        else if (lock == "selection") QVERIFY2(batchInput("memorySelectMode"), qPrintable(m_profileDiagnostic));
        else if (lock == "editing") QVERIFY2(batchInput("memoryEdit0"), qPrintable(m_profileDiagnostic));
        else if (lock == "deleting") QVERIFY2(batchInput("memoryDelete0"), qPrintable(m_profileDiagnostic));
        emit m_bridge->changed();
        const QDeadlineTimer deadline(4000, Qt::PreciseTimer);
        QVERIFY(feedbackLayoutSettled(deadline));
        const auto *existing = batchControl("memoryPin0");
        QVERIFY(existing);
        const bool hidden = lock == "editing" || lock == "deleting";
        QCOMPARE(existing->isVisible(), !hidden);
        for (const auto *name : {"memoryStrengthen0", "memoryWeaken0", "memoryReactivate0"}) {
            auto *item = batchControl(name);
            QVERIFY2(item, name);
            QCOMPARE(item->isVisible(), existing->isVisible());
            QCOMPARE(item->isEnabled(), existing->isEnabled());
            if (!hidden) QVERIFY2(!item->isEnabled(), name);
        }
        QCOMPARE(batchControl("memoryImportance0")->isVisible(), lock != "editing");
        QCOMPARE(rendererCommandCount("memory:reinforce"), lock == "single-action" ? 1 : 0);
    }
    void cardExportControlsDefaultSelectionAndNarrowLayout_data() {
        QTest::addColumn<QString>("kind");
        QTest::addColumn<int>("width");
        for (const auto &kind : QStringList{"imported", "no-default", "builtin"})
            for (int width : {360, 760})
                QTest::newRow(qPrintable(kind + QString::number(width))) << kind << width;
    }
    void cardExportControlsDefaultSelectionAndNarrowLayout() {
        QFETCH(QString, kind);
        QFETCH(int, width);
        const auto active = kind == "builtin" ? QString("default") : QString("persona-current");
        m_bridge->m_persona["persona_id"] = kind == "builtin" ? "builtin_hoshino_yumetsuki" : active;
        QJsonObject list{{"ok", true}, {"active_id", active}, {"profiles", QJsonArray{QJsonObject{
            {"id", active}, {"name", "测试角色"}, {"active", true},
            {"source_format", kind == "builtin" ? "builtin" : "chara_card_v2"}}}}};
        list["persona_id"] = m_bridge->m_persona["persona_id"];
        list["persona_epoch"] = m_bridge->m_persona["epoch"];
        list["persona_fingerprint"] = m_bridge->m_persona["fingerprint"];
        m_bridge->event({{"type", "persona:list:result"}, {"request_id", m_bridge->request("persona:list")}, {"payload", list}});
        const QJsonObject archive{{"ok", true}, {"revision", 4}, {"archive", QJsonObject{{"worldBooks", QJsonArray{
            QJsonObject{{"id", "other"}, {"name", "另一本书"}, {"entries", QJsonArray{}}},
            QJsonObject{{"id", "main"}, {"name", kind == "no-default" ? "其他名称" : "测试角色的世界书"}, {"entries", QJsonArray{}}}}}}}};
        m_bridge->event({{"type", "archive:result"}, {"request_id", m_bridge->request("archive:get")}, {"payload", archive}});
        loadPanel();
        QVERIFY(m_panel && m_window);
        m_window->resize(width, 650);
        auto *button = m_panel->findChild<QQuickItem *>("personaCardExport");
        auto *importButton = m_panel->findChild<QQuickItem *>("personaImportCard");
        auto *notice = m_panel->findChild<QQuickItem *>("personaCardExportBuiltinNotice");
        auto *dialog = m_panel->findChild<QObject *>("personaCardExportConfirmation");
        auto *choice = m_panel->findChild<QQuickItem *>("personaCardExportBook");
        QVERIFY(button && importButton && notice && dialog && choice);
        QVERIFY(revealPriorityControl(button));
        for (auto *control : {button, importButton}) {
            const auto rectangle = control->mapRectToScene(QRectF(QPointF(), control->size()));
            QVERIFY(rectangle.left() >= 0);
            QVERIFY(rectangle.right() <= width);
            QVERIFY(control->width() >= control->implicitWidth());
        }
        QCOMPARE(button->isEnabled(), kind != "builtin");
        QCOMPARE(notice->isVisible(), kind == "builtin");
        QCOMPARE(notice->property("text").toString(), QString("内置人格不能导出角色卡"));
        const int before = m_frames.size();
        if (kind == "builtin") {
            QVERIFY(!dialog->property("visible").toBool());
            m_bridge->exportPersonaCard(QUrl::fromLocalFile(m_data->filePath("builtin.json")), "");
            QCOMPARE(m_frames.size(), before);
            QVERIFY(!QFile::exists(m_data->filePath("builtin.json")));
            return;
        }
        const auto center = button->mapToScene(QPointF(button->width() / 2, button->height() / 2)).toPoint();
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, center);
        QTRY_VERIFY(dialog->property("opened").toBool());
        QCOMPARE(choice->property("currentIndex").toInt(), kind == "no-default" ? 0 : 2);
        QCOMPARE(choice->property("currentValue").toString(), kind == "no-default" ? QString() : QString("main"));
        const auto *saved = m_panel->findChild<QQuickItem *>("personaCardExportSavedNotice");
        QVERIFY(saved && saved->isVisible());
        QCOMPARE(saved->property("text").toString(), QString("只导出已保存的内容"));
        QCOMPARE(m_frames.size(), before);
        // Read both explicit alternatives from the real ComboBox before sending
        // its selected ID through the production bridge, without an OS dialog.
        QVERIFY(choice->setProperty("currentIndex", 0));
        QCOMPARE(choice->property("currentValue").toString(), QString());
        QVERIFY(choice->setProperty("currentIndex", 1));
        QCOMPARE(choice->property("currentValue").toString(), QString("other"));
        m_bridge->exportPersonaCard(QUrl::fromLocalFile(m_data->filePath("selected.json")),
                                    choice->property("currentValue").toString());
        QTRY_VERIFY(!dialog->property("visible").toBool());
        QTRY_VERIFY(!button->isEnabled());
        QTRY_VERIFY(!importButton->isEnabled());
        QCOMPARE(m_frames.size(), before + 1);
        const auto sent = m_frames.last();
        QCOMPARE(sent["kind"].toString(), QString("control"));
        QCOMPARE(sent["type"].toString(), QString("persona:card:export"));
        QCOMPARE(sent["world_book_id"].toString(), QString("other"));
        const auto id = sent["requestId"].toString();
        m_bridge->expirePending(id);
        const auto *feedback = m_panel->findChild<QQuickItem *>("personaCardExportFeedback");
        QVERIFY(feedback);
        QTRY_COMPARE(feedback->property("text").toString(), QString("导出结果未知，请检查目标文件。"));
        QCOMPARE(importCount(), 0);
    }
    void cardExportDialogClosesOnIdentityChange() {
        m_bridge->m_state["personas"] = QVariantMap{{"ok", true}, {"persona_id", "persona-current"},
            {"persona_epoch", 3}, {"persona_fingerprint", "fingerprint-current"}, {"active_id", "persona-current"}, {"profiles", QVariantList{
            QVariantMap{{"id", "persona-current"}, {"name", "当前角色"}, {"active", true}, {"source_format", "chara_card_v2"}}}}};
        m_bridge->m_personaCardExportProfilesGeneration = m_bridge->generation();
        m_bridge->m_archive = {{"ok", true}, {"revision", 0}, {"archive", QVariantMap{{"worldBooks", QVariantList{}}}}};
        m_bridge->m_personaCardExportArchivePersona = m_bridge->m_persona;
        m_bridge->m_personaCardExportArchiveGeneration = m_bridge->generation();
        loadPanel();
        QVERIFY(m_panel && m_window);
        auto *button = m_panel->findChild<QQuickItem *>("personaCardExport");
        auto *dialog = m_panel->findChild<QObject *>("personaCardExportConfirmation");
        QVERIFY(button && dialog && button->isEnabled());
        QVERIFY(revealPriorityControl(button));
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier,
            button->mapToScene(QPointF(button->width() / 2, button->height() / 2)).toPoint());
        QTRY_VERIFY(dialog->property("opened").toBool());
        m_bridge->event({{"type", "persona:scope"}, {"request_id", ""},
            {"payload", QJsonObject{{"persona_id", "persona-next"}, {"epoch", 4}, {"fingerprint", "next"}}}});
        QTRY_VERIFY(!dialog->property("visible").toBool());
        for (const auto &frame : m_frames)
            QVERIFY(frame["type"].toString() != "persona:card:export");
    }
private:
    static QJsonObject nativeEditFields() {
        return {{"description", "<b>按纯文本显示的档案</b>"}, {"personality_traits", QJsonArray{"耐心细致", "喜欢观星"}},
            {"tone", "温和清晰"}, {"first_message", "你好"}, {"alternate_greetings", QJsonArray{"晚上好"}},
            {"message_example", "用户：你好\n角色：你好"}};
    }
    QVariantList nativeEditRows(bool builtinCurrent = false) const {
        return {QVariantMap{{"id", "default"}, {"name", "星野幻月"}, {"active", builtinCurrent}, {"source_format", "builtin"}},
            QVariantMap{{"id", "persona-current"}, {"name", "使用中人格"}, {"active", !builtinCurrent}, {"source_format", "chara_card_v2"}},
            QVariantMap{{"id", "st_edit"}, {"name", "待编辑人格"}, {"active", false}, {"source_format", "chara_card_v2"}}};
    }
    void publishNativeEditRows(bool builtinCurrent = false) {
        m_bridge->m_state["personas"] = QVariantMap{{"ok", true}, {"active_id", builtinCurrent ? "default" : "persona-current"},
            {"profiles", nativeEditRows(builtinCurrent)}};
        emit m_bridge->changed();
    }
    void openNativeEditPanel() {
        publishNativeEditRows(); loadPanel();
        QVERIFY(m_panel && m_window);
        m_bridge->loadPersonaProfile("st_edit");
        const auto id = m_bridge->personaProfileState().value("requestId").toString();
        QVERIFY(!id.isEmpty());
        m_bridge->event({{"type", "persona:profile:get:result"}, {"request_id", id}, {"payload", QJsonObject{
            {"ok", true}, {"profile_id", "st_edit"}, {"identity_version", 1},
            {"identity_fingerprint", QString(64, 'a')}, {"active", false}, {"source_format", "chara_card_v2"},
            {"fields", nativeEditFields()}}}});
        auto *dialog = m_panel->findChild<QObject *>("personaProfilePanel");
        QVERIFY(dialog); QTRY_VERIFY(dialog->property("opened").toBool());
    }
    // Repeater delegates belong to the visual tree, while popup content is
    // reparented to the overlay. QObject::findChild(panel) cannot cover both.
    // Search only this fixture's panel and its three editor popup surfaces;
    // multiple distinct controls with one name remain an error.
    QSet<QQuickItem *> nativeEditMatches(const QString &name) const {
        QList<QQuickItem *> found;
        visualMatches(m_panel, name, found);
        for (const auto *dialogName : {"personaProfilePanel", "personaProfileSaveDialog", "personaProfileDiscardDialog"}) {
            auto *dialog = m_panel ? m_panel->findChild<QObject *>(QString::fromLatin1(dialogName)) : nullptr;
            if (!dialog) continue;
            for (const auto *surface : {"header", "contentItem", "footer"})
                visualMatches(dialog->property(surface).value<QQuickItem *>(), name, found);
        }
        QSet<QQuickItem *> unique;
        for (auto *item : found) unique.insert(item);
        return unique;
    }
    QQuickItem *nativeEditItem(const QString &name) const {
        const auto unique = nativeEditMatches(name);
        return unique.size() == 1 ? *unique.cbegin() : nullptr;
    }
    void clickNativeEditControl(const QString &name) {
        auto *control = nativeEditItem(name);
        QVERIFY(control); QVERIFY(control->isEnabled());
        QVERIFY(QMetaObject::invokeMethod(control, "clicked"));
    }
private slots:
    void nativePersonaEditRowsExplainCurrentAndBuiltin_data() {
        QTest::addColumn<bool>("builtinCurrent"); QTest::addColumn<int>("width");
        QTest::newRow("builtin-current-narrow") << true << 480;
        QTest::newRow("imported-current-narrow") << false << 480;
        QTest::newRow("imported-current-wide") << false << 760;
    }
    void nativePersonaEditRowsExplainCurrentAndBuiltin() {
        QFETCH(bool, builtinCurrent); QFETCH(int, width);
        publishNativeEditRows(builtinCurrent); loadPanel(); QVERIFY(m_panel && m_window);
        m_window->resize(width, 650);
        auto *builtin = nativeEditItem("personaEdit_0");
        auto *current = nativeEditItem("personaEdit_1");
        auto *other = nativeEditItem("personaEdit_2");
        auto *builtinHint = nativeEditItem("personaEditDisabledHint_0");
        auto *currentHint = nativeEditItem("personaEditDisabledHint_1");
        QVERIFY(builtin && current && other && builtinHint && currentHint);
        QVERIFY(!builtin->isEnabled()); QCOMPARE(current->isEnabled(), builtinCurrent); QVERIFY(other->isEnabled());
        QCOMPARE(builtinHint->property("text").toString(), QString("内置人格不能编辑"));
        QCOMPARE(currentHint->property("text").toString(), builtinCurrent ? QString() : QString("使用中的人格不能编辑，请先切换到其他人格"));
        for (auto *button : {builtin, current, other}) {
            QVERIFY(revealPriorityControl(button));
            const auto rectangle = button->mapRectToScene(QRectF(QPointF(), button->size()));
            QVERIFY(rectangle.left() >= 0 && rectangle.right() <= width);
            QVERIFY(button->width() >= button->implicitWidth());
        }
        const int before = m_frames.size();
        clickNativeEditControl("personaEdit_2");
        QTRY_VERIFY(m_bridge->personaProfilePending());
        QVERIFY(!other->isEnabled());
        auto *import = nativeEditItem("personaImportCard"); QVERIFY(import && !import->isEnabled());
        QCOMPARE(m_frames.size(), before + 1);
    }
    void nativePersonaEditSharedStateOpensOnlyTheCharacterTaskPanel() {
        publishNativeEditRows(); loadPanel(); QVERIFY(m_panel && m_window);
        QQmlComponent component(m_engine.get(), QUrl("qrc:/persona-card-confirmation/ui/TaskPanel.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        std::unique_ptr<QQuickItem> memory(qobject_cast<QQuickItem *>(component.createWithInitialProperties({
            {"parent", QVariant::fromValue(m_window->contentItem())}, {"page", "memory"}, {"visible", false},
            {"width", m_panel->width()}, {"height", m_panel->height()}})));
        QVERIFY2(memory, qPrintable(component.errorString()));
        std::unique_ptr<QQuickItem> settings(qobject_cast<QQuickItem *>(component.createWithInitialProperties({
            {"parent", QVariant::fromValue(m_window->contentItem())}, {"page", "settings"}, {"visible", false},
            {"width", m_panel->width()}, {"height", m_panel->height()}})));
        QVERIFY2(settings, qPrintable(component.errorString()));
        auto *characterDialog = m_panel->findChild<QObject *>("personaProfilePanel");
        auto *memoryDialog = memory->findChild<QObject *>("personaProfilePanel");
        auto *settingsDialog = settings->findChild<QObject *>("personaProfilePanel");
        QVERIFY(characterDialog && memoryDialog && settingsDialog);
        m_bridge->loadPersonaProfile("st_edit");
        const auto readId = m_bridge->personaProfileState().value("requestId").toString(); QVERIFY(!readId.isEmpty());
        m_bridge->event({{"type", "persona:profile:get:result"}, {"request_id", readId}, {"payload", QJsonObject{
            {"ok", true}, {"profile_id", "st_edit"}, {"identity_version", 1},
            {"identity_fingerprint", QString(64, 'a')}, {"active", false}, {"source_format", "chara_card_v2"},
            {"fields", nativeEditFields()}}}});
        QTRY_VERIFY(characterDialog->property("opened").toBool());
        QVERIFY(!memoryDialog->property("visible").toBool()); QVERIFY(!settingsDialog->property("visible").toBool());
        QVERIFY(!memory->property("personaProfileOpen").toBool()); QVERIFY(!settings->property("personaProfileOpen").toBool());
        QCOMPARE(NativeCheck::findVisual(m_window->contentItem(), "personaProfileDescription", true).matches, 1);
        m_bridge->savePersonaProfile({{"tone", "共享状态保存后的新语气"}}, true);
        const auto writeId = m_bridge->personaProfileState().value("requestId").toString(); QVERIFY(!writeId.isEmpty());
        auto fields = nativeEditFields(); fields["tone"] = "共享状态保存后的新语气";
        m_bridge->event({{"type", "persona:profile:update:result"}, {"request_id", writeId},
            {"payload", QJsonObject{{"ok", true}, {"profile_id", "st_edit"}, {"identity_version", 2},
                {"identity_fingerprint", QString(64, 'b')}, {"active", false}, {"fields", fields}}}});
        QTRY_COMPARE(m_bridge->personaProfileState().value("status").toString(), QString("success"));
        QVERIFY(characterDialog->property("visible").toBool());
        QVERIFY(!memoryDialog->property("visible").toBool()); QVERIFY(!settingsDialog->property("visible").toBool());
        QCOMPARE(NativeCheck::findVisual(m_window->contentItem(), "personaProfileDescription", true).matches, 1);
        m_bridge->closePersonaProfile();
        QTRY_VERIFY(!characterDialog->property("visible").toBool());
        QVERIFY(!memoryDialog->property("visible").toBool()); QVERIFY(!settingsDialog->property("visible").toBool());
    }
    void nativePersonaEditEntryWaitsForEveryConflictingOperation_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"disconnected", "read-only", "importing", "switching", "restoring", "exporting", "loading", "saving"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void nativePersonaEditEntryWaitsForEveryConflictingOperation() {
        QFETCH(QString, condition);
        if (condition == "saving") {
            openNativeEditPanel();
            m_bridge->savePersonaProfile({{"tone", "等待保存的新语气"}}, true);
        } else {
            publishNativeEditRows(); loadPanel(); QVERIFY(m_panel && m_window);
            if (condition == "disconnected") m_bridge->m_connected = false;
            if (condition == "read-only") m_bridge->m_runtimeWritable = false;
            if (condition == "importing") m_bridge->m_personaImport = {{"requestId", "pending-import"}};
            if (condition == "switching") m_bridge->m_personaSwitch = {{"requestId", "pending-switch"}};
            if (condition == "restoring") m_bridge->m_backupRestoring = true;
            if (condition == "exporting") m_bridge->m_personaCardExportState = {{"status", "pending"}};
            if (condition == "loading") m_bridge->loadPersonaProfile("st_edit");
            emit m_bridge->changed();
        }
        auto *entry = nativeEditItem("personaEdit_2"); QVERIFY(entry);
        QTRY_VERIFY(!entry->isEnabled());
        const int before = m_frames.size();
        m_bridge->loadPersonaProfile("st_edit");
        QCOMPARE(m_frames.size(), before);
    }
    void nativePersonaEditFieldsCountAndGreetingListBlockInvalidSave() {
        openNativeEditPanel(); QVERIFY(m_panel && m_window);
        auto *description = nativeEditItem("personaProfileDescription");
        auto *traits = nativeEditItem("personaProfileTraits");
        auto *tone = nativeEditItem("personaProfileTone");
        auto *save = nativeEditItem("personaProfileSave");
        QVERIFY(description && traits && tone && save);
        QCOMPARE(description->property("text").toString(), nativeEditFields()["description"].toString());
        QCOMPARE(description->property("textFormat").toInt(), 0);
        for (const auto &pair : {qMakePair(QString("personaProfileDescriptionCount"), QString("24000")),
                 qMakePair(QString("personaProfileToneCount"), QString("2000")),
                 qMakePair(QString("personaProfileFirstMessageCount"), QString("4000")),
                 qMakePair(QString("personaProfileMessageExampleCount"), QString("8000")),
                 qMakePair(QString("personaProfileGreeting_0Count"), QString("4000")),
                 qMakePair(QString("personaProfileTraitsCount"), QString("2–160"))}) {
            auto *count = nativeEditItem(pair.first); QVERIFY(count);
            QVERIFY(count->property("text").toString().contains(pair.second));
            QCOMPARE(count->property("textFormat").toInt(), 0);
        }
        QVERIFY(!save->isEnabled());
        QVERIFY(description->setProperty("text", QString(24001, 'x')));
        QTRY_VERIFY(!m_panel->property("personaProfileDraftValid").toBool()); QVERIFY(!save->isEnabled());
        QVERIFY(description->setProperty("text", "新的档案正文"));
        QTRY_VERIFY(save->isEnabled());
        QVERIFY(traits->setProperty("text", "短")); QTRY_VERIFY(!save->isEnabled());
        QVERIFY(traits->setProperty("text", "第一条特征\n第二条特征")); QTRY_VERIFY(save->isEnabled());
        QVERIFY(tone->setProperty("text", QString(2001, 'x'))); QTRY_VERIFY(!save->isEnabled());
        QVERIFY(tone->setProperty("text", "新的语气")); QTRY_VERIFY(save->isEnabled());
        clickNativeEditControl("personaProfileAddGreeting");
        auto *greeting = nativeEditItem("personaProfileGreeting_1");
        QVERIFY(greeting); QTRY_VERIFY(!save->isEnabled());
        QVERIFY(greeting->setProperty("text", "新增备选问候")); QTRY_VERIFY(save->isEnabled());
        auto draft = m_panel->property("personaProfileDraft");
        if (draft.metaType() == QMetaType::fromType<QJSValue>()) draft = draft.value<QJSValue>().toVariant();
        QCOMPARE(draft.toMap().value("alternate_greetings").toList().size(), 2);
        clickNativeEditControl("personaProfileRemoveGreeting_1"); QTRY_VERIFY(save->isEnabled());
        QTRY_VERIFY(nativeEditMatches("personaProfileGreeting_1").isEmpty());
    }
    void nativePersonaEditConfirmationUsesNoncurrentVersionWarningAndCanonicalSuccess() {
        openNativeEditPanel(); QVERIFY(m_panel && m_window);
        auto *description = nativeEditItem("personaProfileDescription");
        QVERIFY(description && description->setProperty("text", " 新档案 "));
        auto *save = nativeEditItem("personaProfileSave"); QVERIFY(save);
        QTRY_VERIFY(save->isEnabled());
        clickNativeEditControl("personaProfileSave");
        auto *confirmation = m_panel->findChild<QObject *>("personaProfileSaveDialog");
        auto *explanation = nativeEditItem("personaProfileSaveExplanation");
        QVERIFY(confirmation && explanation); QTRY_VERIFY(confirmation->property("opened").toBool());
        const auto text = explanation->property("text").toString();
        QVERIFY(text.contains("档案正文")); QVERIFY(text.contains("保存后成为第 2 版，旧版本保留在本机"));
        QVERIFY(text.contains("这个人格在本次编辑之前的备份，将不能再恢复"));
        QVERIFY(text.contains("切换到这个人格后生效")); QVERIFY(!text.contains("重新载入"));
        const int before = m_frames.size(); clickNativeEditControl("personaProfileConfirmSave");
        QTRY_COMPARE(m_bridge->personaProfileState().value("status").toString(), QString("saving"));
        QCOMPARE(m_frames.size(), before + 1);
        const auto sent = m_frames.last()["envelope"].toObject();
        QCOMPARE(sent["command"].toString(), QString("persona:profile:update"));
        const auto payload = sent["payload"].toObject();
        QCOMPARE(payload["fields"].toObject(), (QJsonObject{{"description", " 新档案 "}}));
        QCOMPARE(payload["expected_identity_version"].toInt(), 1);
        QCOMPARE(sent["persona"].toObject()["epoch"].toInt(), 3);
        QCOMPARE(sent["persona"].toObject(), m_bridge->m_persona);
        auto fields = nativeEditFields(); fields["description"] = "新档案";
        m_bridge->event({{"type", "persona:profile:update:result"}, {"request_id", sent["request_id"]},
            {"payload", QJsonObject{{"ok", true}, {"profile_id", "st_edit"}, {"identity_version", 2},
                {"identity_fingerprint", QString(64, 'b')}, {"active", false}, {"fields", fields}}}});
        QTRY_COMPARE(description->property("text").toString(), QString("新档案"));
        QTRY_VERIFY(!m_panel->property("personaProfileDirty").toBool());
        auto *dialog = m_panel->findChild<QObject *>("personaProfilePanel"); QVERIFY(dialog && dialog->property("visible").toBool());
        auto *title = nativeEditItem("personaProfileTitle"); QVERIFY(title);
        QVERIFY(title->property("text").toString().contains("第 2 版"));
        clickNativeEditControl("personaProfileCancel"); QTRY_VERIFY(!dialog->property("visible").toBool());
    }
    void nativePersonaEditCancelRequiresDiscardAndScopeClosesBothLayers() {
        openNativeEditPanel(); QVERIFY(m_panel && m_window);
        auto *description = nativeEditItem("personaProfileDescription"); QVERIFY(description);
        QVERIFY(description->setProperty("text", "未保存的档案"));
        clickNativeEditControl("personaProfileCancel");
        auto *discard = m_panel->findChild<QObject *>("personaProfileDiscardDialog");
        auto *editor = m_panel->findChild<QObject *>("personaProfilePanel");
        QVERIFY(discard && editor); QTRY_VERIFY(discard->property("opened").toBool());
        clickNativeEditControl("personaProfileKeepEditing"); QTRY_VERIFY(!discard->property("visible").toBool());
        QVERIFY(editor->property("visible").toBool());
        clickNativeEditControl("personaProfileSave");
        auto *saveDialog = m_panel->findChild<QObject *>("personaProfileSaveDialog"); QVERIFY(saveDialog);
        QTRY_VERIFY(saveDialog->property("opened").toBool());
        m_bridge->event({{"type", "persona:scope"}, {"request_id", ""},
            {"payload", QJsonObject{{"persona_id", "st_edit"}, {"epoch", 4}, {"fingerprint", "new-profile"}}}});
        QTRY_VERIFY(!editor->property("visible").toBool());
        QVERIFY(!discard->property("visible").toBool()); QVERIFY(!saveDialog->property("visible").toBool());
        QCOMPARE(m_bridge->personaProfileState().value("text").toString(), QString("人格已变化，未保存的编辑已丢弃。"));
        QCOMPARE(description->property("text").toString(), QString());
    }
    void nativePersonaEditRejectionPreservesDraftAndUnknownNeverShowsLateSuccess_data() {
        QTest::addColumn<QString>("condition");
        for (const auto &condition : QStringList{"field_invalid", "identity_conflict", "timeout", "disconnect"})
            QTest::newRow(qPrintable(condition)) << condition;
    }
    void nativePersonaEditRejectionPreservesDraftAndUnknownNeverShowsLateSuccess() {
        QFETCH(QString, condition);
        openNativeEditPanel(); QVERIFY(m_panel && m_window);
        auto *description = nativeEditItem("personaProfileDescription"); QVERIFY(description);
        QVERIFY(description->setProperty("text", "需要保留的草稿"));
        clickNativeEditControl("personaProfileSave");
        auto *confirm = m_panel->findChild<QObject *>("personaProfileSaveDialog"); QVERIFY(confirm);
        QTRY_VERIFY(confirm->property("opened").toBool());
        clickNativeEditControl("personaProfileConfirmSave");
        const auto id = m_bridge->personaProfileState().value("requestId").toString(); QVERIFY(!id.isEmpty());
        auto *editor = m_panel->findChild<QObject *>("personaProfilePanel"); QVERIFY(editor);
        if (condition == "timeout") m_bridge->expirePending(id);
        else if (condition == "disconnect") m_bridge->m_process.finished(1, QProcess::NormalExit);
        else m_bridge->event({{"type", "persona:profile:update:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", false}, {"code", condition}, {"error", "拒绝保存"}, {"field", "description"}}}});
        const bool unknown = condition == "timeout" || condition == "disconnect";
        if (unknown) {
            QTRY_VERIFY(!editor->property("visible").toBool());
            QCOMPARE(m_bridge->personaProfileState().value("text").toString(), QString("保存结果未知，请重新打开查看。"));
            QCOMPARE(description->property("text").toString(), QString());
        } else {
            QVERIFY(editor->property("visible").toBool());
            QCOMPARE(description->property("text").toString(), QString("需要保留的草稿"));
            QVERIFY(m_panel->property("personaProfileDirty").toBool());
            if (condition == "identity_conflict") {
                auto *save = nativeEditItem("personaProfileSave"); QVERIFY(save && !save->isEnabled());
                QVERIFY(m_bridge->personaProfileState().value("text").toString().contains("这个人格已在别处更改，请重新打开编辑。"));
            }
        }
        m_bridge->event({{"type", "persona:profile:update:result"}, {"request_id", id},
            {"payload", QJsonObject{{"ok", true}, {"profile_id", "st_edit"}, {"identity_version", 2},
                {"identity_fingerprint", QString(64, 'b')}, {"active", false}, {"fields", nativeEditFields()}}}});
        QVERIFY(m_bridge->personaProfileState().value("status").toString() != "success");
    }
    void nativePersonaEditTextReplacementUsesRealFieldAndPrecommitGuards_data() {
        QTest::addColumn<QString>("fieldName");
        QTest::addColumn<QString>("replacement");
        QTest::addColumn<QString>("guardFailure");
        QTest::newRow("replace-prefilled-description") << QString("personaProfileDescription")
            << QString("替换后的档案正文\n这是新的一行。") << QString();
        QTest::newRow("replace-prefilled-tone") << QString("personaProfileTone")
            << QString("温和自然，使用新的表达。") << QString();
        QTest::newRow("scope-change-before-commit") << QString("personaProfileDescription")
            << QString("这段内容不能提交") << QString("scope");
        QTest::newRow("deadline-before-commit") << QString("personaProfileTone")
            << QString("这段语气不能提交") << QString("deadline");
    }
    void nativePersonaEditTextReplacementUsesRealFieldAndPrecommitGuards() {
        QFETCH(QString, fieldName); QFETCH(QString, replacement); QFETCH(QString, guardFailure);
        openNativeEditPanel(); QVERIFY(m_panel && m_window);
        QPointer<QQuickItem> target = nativeEditItem(fieldName); QVERIFY(target);
        const auto original = target->property("text").toString(); QVERIFY(!original.isEmpty());
        QVERIFY(original != replacement);
        setCandidateFocusWindow(m_window.get());
        const auto clearFocus = qScopeGuard([this] { setCandidateFocusWindow(nullptr); });
        QVERIFY(QGuiApplication::focusWindow() == m_window.get() && m_window->isActive());
        const auto scope = m_bridge->scopeKey();
        const int generation = m_bridge->generation();
        QElapsedTimer inputClock; inputClock.start();
        const QDeadlineTimer inputDeadline(4000, Qt::PreciseTimer);
        trackCandidateFrames();
        SummaryInteractionProbe::StableGate stable;
        QVERIFY(QTest::qWaitFor([&] {
            NativeControlReadiness::revealWholeItem(target, [&] { return inputClock.elapsed(); }, 4000);
            auto observation = SummaryInteractionProbe::inspect(target, m_window.get(), true, scope);
            const auto whole = NativeControlReadiness::wholeVisibility(target, m_window.get());
            observation.eligible = observation.eligible && whole.value("fullyVisible").toBool();
            observation.state["fullyVisible"] = whole.value("fullyVisible");
            const auto layout = stable.observe(observation, inputClock.elapsed(), m_candidateFrameSerial);
            m_window->update();
            return layout.value("ready").toBool();
        }, inputDeadline));
        QVERIFY(inputClock.elapsed() < 4000);
        const auto acquired = SummaryInteractionProbe::inspect(target, m_window.get(), true, scope);
        QVERIFY(stable.matches(acquired));
        QVERIFY(NativeCheck::hitTest(m_window.get(), acquired.point, target).accepted());
        QTest::mouseClick(m_window.get(), Qt::LeftButton, Qt::NoModifier, acquired.point, 0);
        QVERIFY(ArchiveInputProbe::keyboardFocusMatches(target, m_window.get(), false));
        QSignalSpy textChanges(target, SIGNAL(textChanged())); QVERIFY(textChanges.isValid());
        int checkpoints = 0, checkedGeneration = generation;
        qint64 checkedElapsed = 0;
        QString errorCode;
        try {
            PersonaProfileEditInput::replace(m_window.get(), target, replacement, [&] {
                ++checkpoints;
                if (checkpoints == 3 && guardFailure == "scope") ++checkedGeneration;
                if (checkpoints == 3 && guardFailure == "deadline") checkedElapsed = 4000;
                NativeCheck::require(inputClock.elapsed() < 4000 && checkedElapsed < 4000, "CARD_EDIT_INPUT_DEADLINE", {});
                NativeCheck::require(m_bridge->scopeKey() == scope && m_bridge->generation() == generation &&
                    checkedGeneration == generation, "CARD_EDIT_INPUT_SCOPE_CHANGED", {});
                NativeCheck::require(target && nativeEditItem(fieldName) == target, "CARD_EDIT_TEXT_TARGET_CHANGED", {});
            });
        } catch (const std::exception &error) { errorCode = QString::fromUtf8(error.what()); }
        if (guardFailure.isEmpty()) {
            QVERIFY2(errorCode.isEmpty(), qPrintable(errorCode));
            QCOMPARE(checkpoints, 4);
            QCOMPARE(target->property("text").toString(), replacement);
            QVERIFY(target->property("text").toString() != original + replacement);
            QVERIFY(textChanges.count() > 0);
            QVERIFY(m_panel->property("personaProfileDirty").toBool());
        } else {
            QCOMPARE(checkpoints, 3);
            QVERIFY(errorCode.contains(guardFailure == "scope" ? "CARD_EDIT_INPUT_SCOPE_CHANGED" : "CARD_EDIT_INPUT_DEADLINE"));
            QCOMPARE(target->property("text").toString(), original);
            QCOMPARE(target->property("selectedText").toString(), original);
            QCOMPARE(textChanges.count(), 0);
            QVERIFY(!m_panel->property("personaProfileDirty").toBool());
        }
        QCOMPARE(rendererCommandCount("persona:profile:update"), 0);
    }
    void nativePersonaEditFooterFitsNarrowWindow() {
        openNativeEditPanel(); QVERIFY(m_panel && m_window); m_window->resize(480, 650);
        auto *description = nativeEditItem("personaProfileDescription"); QVERIFY(description);
        QVERIFY(description->setProperty("text", "更改后的内容"));
        auto *dialog = m_panel->findChild<QObject *>("personaProfilePanel"); QVERIFY(dialog);
        QTRY_VERIFY(dialog->property("opened").toBool());
        QTest::qWait(40);
        for (const auto &name : {QString("personaProfileSave"), QString("personaProfileCancel")}) {
            auto *button = nativeEditItem(name); QVERIFY(button && button->isVisible());
            const auto rect = button->mapRectToScene(QRectF(QPointF(), button->size()));
            QVERIFY(rect.left() >= 0 && rect.right() <= m_window->width());
            QVERIFY(rect.top() >= 0 && rect.bottom() <= m_window->height());
            QVERIFY(button->width() >= button->implicitWidth());
        }
    }
};

QTEST_MAIN(RuntimeBridgeTest)
#include "PersonaCardConfirmationTest.moc"
