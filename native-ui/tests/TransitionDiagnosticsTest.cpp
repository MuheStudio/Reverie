#include "../src/TransitionDiagnostics.h"
#include <QObject>
#include <QTest>
#include <cmath>
#include <stdexcept>

#ifdef REVERIE_TIMING_DIAGNOSTICS
class FakeSurface final : public QObject {
    Q_OBJECT
    Q_PROPERTY(double progress READ progress NOTIFY progressChanged)
    Q_PROPERTY(QString transitionState MEMBER state NOTIFY transitionStateChanged)
    Q_PROPERTY(int transitionRevision MEMBER revision NOTIFY transitionRevisionChanged)
    Q_PROPERTY(int pendingMotionRevision MEMBER motionRevision NOTIFY pendingMotionRevisionChanged)
    Q_PROPERTY(bool desiredOpen MEMBER desired NOTIFY eligibilityChanged)
    Q_PROPERTY(bool dragging MEMBER dragging NOTIFY eligibilityChanged)
    Q_PROPERTY(bool inputReady MEMBER ready NOTIFY eligibilityChanged)
  public:
    double value = 0;
    QString state = "closed";
    int revision = 1, motionRevision = 1;
    bool desired = false, dragging = false, ready = false;
    double progress() const { return value; }
    void setProgress(double next) { value = next; emit progressChanged(); }
    void transition(QString next, int nextRevision, int nextMotion) {
        revision = nextRevision; motionRevision = nextMotion; state = std::move(next);
        emit transitionRevisionChanged(); emit pendingMotionRevisionChanged(); emit transitionStateChanged();
    }
  signals:
    void progressChanged();
    void transitionStateChanged();
    void transitionRevisionChanged();
    void pendingMotionRevisionChanged();
    void eligibilityChanged();
};

class TransitionDiagnosticsTest final : public QObject {
    Q_OBJECT
  private:
    static QVariantList records() { return TransitionDiagnostics::snapshot().value("records").toList(); }
    static QVariantMap surface(const QVariantMap &record) {
        return record.value("surfaces").toMap().value("memory").toMap();
    }
    static QVariantList named(const char *event) {
        QVariantList result;
        for (const auto &item : records())
            if (item.toMap().value("event").toString() == QLatin1String(event))
                result.append(item);
        return result;
    }
  private slots:
    void cleanup() { TransitionDiagnostics::stop(); }
    void disabledDoesNotCollect() {
        TransitionDiagnostics::stop();
        const auto before = records().size();
        int deliveries = 0;
        const bool result = TransitionDiagnostics::observeHelper("disabled", [&] {
            ++deliveries; return false;
        });
        QVERIFY(!result);
        QCOMPARE(deliveries, 1);
        QCOMPARE(records().size(), before);
    }
    void nestedHelperNotificationsAreEvidenceOnly() {
        FakeSurface fake;
        QObject owner;
        TransitionDiagnostics::start(true);
        TransitionDiagnostics::attachSurface("memory", &fake, &owner);
        TransitionDiagnostics::setStep(2, "memory-header-open");
        int inputs = 0;
        TransitionDiagnostics::observeHelper("QTest::mouseClick", [&] {
            ++inputs;
            fake.transition("opening", 3, 7);
            TransitionDiagnostics::observeHelper("nested-events", [&] { fake.setProgress(.4); });
            fake.setProgress(1);
            fake.transition("open", 3, 7);
        });
        // The original predicate reads the current property after helper return.
        const bool ready = fake.progress() > .23 && fake.progress() < .96;
        TransitionDiagnostics::readyPoll(true, true, ready, 700);
        QCOMPARE(inputs, 1);
        QVERIFY(!ready);
        const auto progress = named("progress-notification");
        QCOMPARE(progress.size(), 2);
        const auto middle = progress[0].toMap();
        QCOMPARE(middle.value("helperDepth").toInt(), 2);
        QCOMPARE(surface(middle).value("progress").toDouble(), .4);
        QCOMPARE(surface(middle).value("transitionRevision").toInt(), 3);
        QCOMPARE(surface(middle).value("pendingMotionRevision").toInt(), 7);
        const auto poll = named("ready-poll").last().toMap();
        QCOMPARE(poll.value("helperDepth").toInt(), 0);
        QVERIFY(!poll.value("details").toMap().value("ready").toBool());
        QCOMPARE(surface(poll).value("progress").toDouble(), 1.);
    }
    void returnedStateCanExpireBeforeActualInput() {
        FakeSurface fake;
        QObject owner;
        TransitionDiagnostics::start(true);
        TransitionDiagnostics::attachSurface("memory", &fake, &owner);
        fake.transition("opening", 4, 9);
        fake.setProgress(.5);
        TransitionDiagnostics::readyPoll(true, true, true, 60);
        fake.setProgress(1);
        fake.transition("open", 4, 9);
        int delivered = 0;
        TransitionDiagnostics::observeHelper("QTest::mouseClick", [&] { ++delivered; }, {{"control", "memory-close"}});
        QCOMPARE(delivered, 1);
        QCOMPARE(surface(named("ready-poll").last().toMap()).value("progress").toDouble(), .5);
        QCOMPARE(surface(named("helper-enter").last().toMap()).value("progress").toDouble(), 1.);
        QVERIFY(!TransitionDiagnostics::snapshot().value("notificationsDriveInput").toBool());
    }
    void skippedIntervalDoesNotManufactureAnOpportunity() {
        FakeSurface fake;
        QObject owner;
        TransitionDiagnostics::start(true);
        TransitionDiagnostics::attachSurface("memory", &fake, &owner);
        fake.transition("opening", 1, 2);
        fake.setProgress(.1);
        fake.setProgress(1);
        TransitionDiagnostics::readyPoll(true, true, false, 500);
        for (const auto &item : named("progress-notification")) {
            const double value = surface(item.toMap()).value("progress").toDouble();
            QVERIFY(!(value > .23 && value < .96));
        }
        QVERIFY(!named("ready-poll").last().toMap().value("details").toMap().value("ready").toBool());
    }
    void oldObserverCannotDescribeCurrentTransition() {
        FakeSurface old, current;
        QObject owner;
        TransitionDiagnostics::start(false);
        TransitionDiagnostics::attachSurface("memory", &old, &owner);
        TransitionDiagnostics::stop();
        TransitionDiagnostics::start(false);
        TransitionDiagnostics::attachSurface("memory", &current, &owner);
        current.transition("opening", 10, 25);
        old.transition("open", 2, 3);
        old.setProgress(.5);
        TransitionDiagnostics::readyPoll(true, true, false, 10);
        QVERIFY(!named("stale-observer-notification").isEmpty());
        QCOMPARE(surface(named("ready-poll").last().toMap()).value("transitionRevision").toInt(), 10);
        QCOMPARE(surface(named("ready-poll").last().toMap()).value("pendingMotionRevision").toInt(), 25);
        QCOMPARE(surface(named("ready-poll").last().toMap()).value("progress").toDouble(), 0.);
        QVERIFY(named("progress-notification").isEmpty());
    }
    void destructionAndUnknownMetadataStayUnknown() {
        QObject owner;
        auto *fake = new FakeSurface;
        TransitionDiagnostics::start(false);
        TransitionDiagnostics::attachSurface("memory", fake, &owner);
        TransitionDiagnostics::observeHelper("destroying-events", [&] { delete fake; });
        const auto destroyed = surface(named("helper-exit").last().toMap());
        QVERIFY(!destroyed.value("known").toBool());
        QVERIFY(!destroyed.value("progressKnown").toBool());
        TransitionDiagnostics::stop();
        TransitionDiagnostics::start(false);
        QObject unclassified;
        TransitionDiagnostics::attachSurface("memory", &unclassified, &owner);
        const auto unknown = surface(named("surface-attached").last().toMap());
        QVERIFY(unknown.value("known").toBool());
        QVERIFY(!unknown.value("progressKnown").toBool());
        QVERIFY(!unknown.value("transitionIdentityKnown").toBool());
        QCOMPARE(named("notification-unavailable").size(), 7);
    }
    void deliveryReturnAndExceptionArePreserved() {
        TransitionDiagnostics::start(false);
        QCOMPARE(TransitionDiagnostics::observeHelper("value", [] { return 42; }), 42);
        bool caught = false;
        try {
            TransitionDiagnostics::observeHelper("throw", [] { throw std::runtime_error("sentinel"); });
        } catch (const std::runtime_error &error) {
            caught = std::string(error.what()) == "sentinel";
        }
        QVERIFY(caught);
        QVERIFY(named("helper-exit").last().toMap().value("details").toMap().value("exceptionUnwinding").toBool());
        TransitionDiagnostics::point("tick-enter");
        QCOMPARE(named("tick-enter").last().toMap().value("helperDepth").toInt(), 0);
    }
    void overflowAndMediaFramesRemainSeparate() {
        TransitionDiagnostics::start(true, 3);
        TransitionDiagnostics::captureBegin(1, 0);
        TransitionDiagnostics::captureEnd(1, 120, true);
        TransitionDiagnostics::frameAppended(1, 1, 120);
        TransitionDiagnostics::point("tick-enter");
        const auto report = TransitionDiagnostics::snapshot();
        QCOMPARE(report.value("records").toList().size(), 3);
        QCOMPARE(report.value("droppedRecords").toULongLong(), quint64(1));
        QVERIFY(!report.value("complete").toBool());
        QVERIFY(!report.value("renderBoundaryProvesRecordedState").toBool());
        QCOMPARE(named("capture-begin").size(), 1);
        QCOMPARE(named("capture-end").size(), 1);
        QCOMPARE(named("record-frame-appended").size(), 1);
        QCOMPARE(named("record-frame-appended").last().toMap().value("details").toMap().value("frame").toInt(), 1);
    }
    void absentEndsAndTerminalAreNeverComplete() {
        TransitionDiagnostics::start(true);
        TransitionDiagnostics::captureBegin(1, 0);
        TransitionDiagnostics::point("scene-surface-terminal", {{"passed", false}});
        TransitionDiagnostics::point("recording-terminal", {{"passed", false}});
        auto report = TransitionDiagnostics::snapshot();
        QVERIFY(!report.value("complete").toBool());
        QCOMPARE(report.value("openCaptures").toInt(), 1);
        TransitionDiagnostics::captureEnd(1, 20, false);
        report = TransitionDiagnostics::snapshot();
        QVERIFY(report.value("complete").toBool());
        TransitionDiagnostics::start(false);
        QVERIFY(!TransitionDiagnostics::snapshot().value("complete").toBool());
        TransitionDiagnostics::point("scene-surface-terminal", {{"passed", false}});
        QVERIFY(TransitionDiagnostics::snapshot().value("complete").toBool());
    }
};
#else
class TransitionDiagnosticsTest final : public QObject {
    Q_OBJECT
  private slots:
    void compiledOutForwardsOnly() {
        TransitionDiagnostics::start(true);
        QVERIFY(!TransitionDiagnostics::enabled());
        QCOMPARE(TransitionDiagnostics::observeHelper("off", [] { return 7; }), 7);
        QVERIFY_EXCEPTION_THROWN(TransitionDiagnostics::observeHelper("off-throw", [] {
            throw std::runtime_error("unchanged");
        }), std::runtime_error);
        const auto report = TransitionDiagnostics::snapshot();
        QVERIFY(!report.value("compiled").toBool());
        QVERIFY(!report.contains("records"));
    }
};
#endif
QTEST_GUILESS_MAIN(TransitionDiagnosticsTest)
#include "TransitionDiagnosticsTest.moc"
