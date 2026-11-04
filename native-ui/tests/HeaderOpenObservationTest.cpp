#include "HeaderOpenObservation.h"

#include <QJsonObject>
#include <QTest>
#include <memory>
#include <stdexcept>

class HeaderOpenSurface final : public QObject {
    Q_OBJECT
    Q_PROPERTY(double progress READ progress NOTIFY progressChanged)
    Q_PROPERTY(QString transitionState READ transitionState)
public:
    double progress() const { ++progressReads; return m_progress; }
    QString transitionState() const { ++stateReads; return m_state; }
    void publish(double progress, const QString &state) {
        m_progress = progress;
        m_state = state;
        ++publications;
        emit progressChanged();
    }
    int publications = 0;
    mutable int progressReads = 0, stateReads = 0;
signals:
    void progressChanged();
private:
    double m_progress = 0;
    QString m_state = "closed";
};

class HeaderOpenUnnotifiedSurface final : public QObject {
    Q_OBJECT
    Q_PROPERTY(double progress READ progress)
    Q_PROPERTY(QString transitionState READ transitionState)
public:
    double progress() const { return .5; }
    QString transitionState() const { return "opening"; }
};

class HeaderOpenObservationTest final : public QObject {
    Q_OBJECT
    static QVariantMap part(const HeaderOpenObservation &observation, const QString &name,
                            bool failure = false) {
        return observation.snapshot(failure).value(name).toMap();
    }
    static bool nullPart(const HeaderOpenObservation &observation, const QString &name,
                         bool failure = false) {
        return QJsonObject::fromVariantMap(observation.snapshot(failure)).value(name).isNull();
    }
    // Mirrors only the existing runner's unchanged require/state/error boundary.
    static void validateAsRunner(const HeaderOpenObservation &observation, const QString &feature) {
        if (observation.latchedState() != "opening")
            throw std::runtime_error(("DRAWER_NOT_OPENING:" + feature).toStdString());
    }

private slots:
    void intervalInsideClickHelperSurvivesItsReturn() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        qint64 elapsed = 0;
        QVERIFY(observation.begin(&surface, [&] { return elapsed; }));
        auto simulatedClick = [&] {
            auto scope = observation.clickScope();
            elapsed = 5;
            surface.publish(.1, "opening");
            elapsed = 17;
            surface.publish(.5, "opening");
            // No poll or event dispatch has occurred: this proves direct delivery.
            QCOMPARE(part(observation, "latched").value("progress").toDouble(), .5);
            QCOMPARE(part(observation, "latched").value("elapsedMs").toLongLong(), 17);
            elapsed = 35;
            surface.publish(1, "open");
        };
        simulatedClick();
        QCOMPARE(surface.progress(), 1.0);
        QCOMPARE(surface.transitionState(), QString("open"));
        QVERIFY(observation.poll(surface.progress(), surface.transitionState()));
        const auto latched = part(observation, "latched");
        QCOMPARE(latched.value("state").toString(), QString("opening"));
        QVERIFY(latched.value("inClickHelper").toBool());
        QCOMPARE(latched.value("notificationOrdinal").toLongLong(), 2);
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 3);
        const auto ready = part(observation, "readyPoll");
        QCOMPARE(ready.value("progress").toDouble(), 1.0);
        QCOMPARE(ready.value("state").toString(), QString("open"));
        QCOMPARE(ready.value("elapsedMs").toLongLong(), 35);
        QVERIFY(!ready.value("originalConstraintSatisfied").toBool());
        validateAsRunner(observation, "memory");
        QCOMPARE(surface.publications, 3);
    }

    void skippedIntervalDoesNotManufactureALatch() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 10; }));
        surface.publish(.1, "opening");
        surface.publish(1, "open");
        QVERIFY(!observation.poll(surface.progress(), surface.transitionState()));
        // Even an in-range poll cannot replace the absent property notification.
        QVERIFY(!observation.poll(.5, "opening"));
        QVERIFY(nullPart(observation, "latched"));
        QVERIFY(nullPart(observation, "readyPoll"));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 2);
        QCOMPARE(part(observation, "lastBelowLower", true).value("progress").toDouble(), .1);
        QCOMPARE(part(observation, "firstAtOrAboveUpper", true).value("progress").toDouble(), 1.0);
    }

    void boundariesRemainOutsideTheOpenInterval_data() {
        QTest::addColumn<double>("progress");
        QTest::newRow("lower") << .23;
        QTest::newRow("upper") << .96;
    }
    void boundariesRemainOutsideTheOpenInterval() {
        QFETCH(double, progress);
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 5; }));
        surface.publish(progress, "opening");
        QVERIFY(!observation.poll(progress, "opening"));
        QVERIFY(nullPart(observation, "latched"));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 1);
    }

    void firstIntervalClosingRemainsTheValidationState() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 10; }));
        surface.publish(.4, "closing");
        surface.publish(.6, "opening");
        QVERIFY(observation.poll(.6, "opening"));
        QVERIFY(part(observation, "readyPoll").value("originalConstraintSatisfied").toBool());
        observation.end();
        QCOMPARE(observation.latchedState(), QString("closing"));
        QCOMPARE(part(observation, "latched").value("progress").toDouble(), .4);
        bool rejected = false;
        try {
            validateAsRunner(observation, "memory");
        } catch (const std::runtime_error &error) {
            rejected = true;
            QCOMPARE(QString::fromUtf8(error.what()), QString("DRAWER_NOT_OPENING:memory"));
        }
        QVERIFY(rejected);
    }

    void laterNotificationsOnlyCountAndFirstReadyPollIsRetained() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        qint64 elapsed = 11;
        int clockReads = 0;
        QVERIFY(observation.begin(&surface, [&] { ++clockReads; return elapsed; }));
        surface.publish(.35, "opening");
        const auto first = part(observation, "latched");
        const int progressReads = surface.progressReads, stateReads = surface.stateReads;
        const int firstClockReads = clockReads;
        elapsed = 20;
        surface.publish(.7, "closing");
        surface.publish(1, "open");
        QCOMPARE(part(observation, "latched"), first);
        QCOMPARE(surface.progressReads, progressReads);
        QCOMPARE(surface.stateReads, stateReads);
        QCOMPARE(clockReads, firstClockReads);
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 3);
        QVERIFY(observation.poll(1, "open"));
        const auto ready = part(observation, "readyPoll");
        elapsed = 99;
        QVERIFY(observation.poll(.5, "opening"));
        QCOMPARE(part(observation, "readyPoll"), ready);
        QVERIFY(!ready.value("originalConstraintSatisfied").toBool());
    }

    void originalConstraintUsesTheReadyPollValues_data() {
        QTest::addColumn<double>("progress");
        QTest::addColumn<QString>("state");
        QTest::addColumn<bool>("satisfied");
        QTest::newRow("same-opening-poll") << .5 << QString("opening") << true;
        QTest::newRow("same-range-wrong-state") << .5 << QString("closing") << false;
        QTest::newRow("completed-before-poll") << 1.0 << QString("open") << false;
        QTest::newRow("lower-boundary") << .23 << QString("opening") << false;
        QTest::newRow("upper-boundary") << .96 << QString("opening") << false;
    }
    void originalConstraintUsesTheReadyPollValues() {
        QFETCH(double, progress);
        QFETCH(QString, state);
        QFETCH(bool, satisfied);
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 24; }));
        surface.publish(.5, "opening");
        QVERIFY(observation.poll(progress, state));
        const auto ready = part(observation, "readyPoll");
        QCOMPARE(ready.value("progress").toDouble(), progress);
        QCOMPARE(ready.value("state").toString(), state);
        QCOMPARE(ready.value("originalConstraintSatisfied").toBool(), satisfied);
        // The latch is identical in every row; only the actual ready-poll values vary.
        QCOMPARE(part(observation, "latched").value("progress").toDouble(), .5);
        QCOMPARE(observation.latchedState(), QString("opening"));
    }

    void subscriptionBoundariesAndSecondBeginResetAllEvidence() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        surface.publish(.5, "opening");
        QVERIFY(observation.begin(&surface, [] { return 7; }));
        QVERIFY(!observation.poll(.5, "opening"));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 0);
        surface.publish(.4, "opening");
        QVERIFY(observation.poll(.4, "opening"));
        observation.end();
        observation.recordReverse(1, "open");
        const auto completed = observation.snapshot(true);
        surface.publish(.6, "closing");
        observation.end();
        QVERIFY(observation.poll(1, "open"));
        QCOMPARE(observation.snapshot(true), completed);
        QVERIFY(observation.begin(&surface, [] { return 0; }));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 0);
        for (const auto *name : {"latched", "readyPoll", "beforeReverseClick", "lastBelowLower", "firstAtOrAboveUpper"})
            QVERIFY(nullPart(observation, name, true));
        surface.publish(.3, "opening");
        QVERIFY(observation.poll(.3, "opening"));
        QCOMPARE(part(observation, "latched").value("notificationOrdinal").toLongLong(), 1);
        QCOMPARE(part(observation, "latched").value("elapsedMs").toLongLong(), 0);
    }

    void failureEvidenceUsesObservedBoundsAndExplicitNulls() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        qint64 elapsed = 0;
        QVERIFY(observation.begin(&surface, [&] { return elapsed; }));
        for (const auto *name : {"latched", "readyPoll", "beforeReverseClick", "lastBelowLower", "firstAtOrAboveUpper"})
            QVERIFY(nullPart(observation, name, true));
        QVERIFY(!observation.snapshot().contains("lastBelowLower"));
        elapsed = 5;
        surface.publish(.1, "opening");
        elapsed = 12;
        surface.publish(.2, "opening");
        elapsed = 30;
        surface.publish(1, "open");
        elapsed = 2501;
        surface.publish(.98, "closing");
        QVERIFY(!observation.poll(.98, "closing"));
        const auto below = part(observation, "lastBelowLower", true);
        const auto above = part(observation, "firstAtOrAboveUpper", true);
        QCOMPARE(below.value("progress").toDouble(), .2);
        QCOMPARE(below.value("elapsedMs").toLongLong(), 12);
        QCOMPARE(below.value("notificationOrdinal").toLongLong(), 2);
        QCOMPARE(above.value("progress").toDouble(), 1.0);
        QCOMPARE(above.value("state").toString(), QString("open"));
        QCOMPARE(above.value("elapsedMs").toLongLong(), 30);
        QCOMPARE(above.value("notificationOrdinal").toLongLong(), 3);
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 4);
        QVERIFY(nullPart(observation, "latched", true));
        QVERIFY(nullPart(observation, "readyPoll", true));
    }

    void clickScopeUnwindsAfterAHelperException() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 10; }));
        bool interrupted = false;
        try {
            auto scope = observation.clickScope();
            surface.publish(.1, "opening");
            throw std::runtime_error("synthetic click helper failure");
        } catch (const std::runtime_error &) {
            interrupted = true;
        }
        QVERIFY(interrupted);
        surface.publish(.5, "opening");
        QVERIFY(observation.poll(.5, "opening"));
        QVERIFY(!part(observation, "latched").value("inClickHelper").toBool());
        QCOMPARE(part(observation, "latched").value("notificationOrdinal").toLongLong(), 2);
    }

    void anOldClickScopeCannotEndANewSubscriptionsClickMarker() {
        HeaderOpenSurface surface;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 10; }));
        auto oldScope = std::make_unique<HeaderOpenObservation::ClickScope>(&observation);
        QVERIFY(observation.begin(&surface, [] { return 20; }));
        {
            auto currentScope = observation.clickScope();
            oldScope.reset();
            surface.publish(.5, "opening");
        }
        QVERIFY(observation.poll(1, "open"));
        QVERIFY(part(observation, "latched").value("inClickHelper").toBool());
        QCOMPARE(part(observation, "latched").value("elapsedMs").toLongLong(), 20);
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 1);
    }

    void sourceDestructionDisconnectsAndReleasesItsClockCapture() {
        auto surface = std::make_unique<HeaderOpenSurface>();
        HeaderOpenObservation observation;
        auto lifetime = std::make_shared<int>(9);
        std::weak_ptr<int> clockLifetime = lifetime;
        QVERIFY(observation.begin(surface.get(), [lifetime] { return *lifetime; }));
        lifetime.reset();
        QVERIFY(!clockLifetime.expired());
        surface->publish(.1, "opening");
        const auto before = observation.snapshot(true);
        surface.reset();
        QVERIFY(clockLifetime.expired());
        QCOMPARE(observation.snapshot(true), before);
        HeaderOpenSurface replacement;
        QVERIFY(observation.begin(&replacement, [] { return 11; }));
        replacement.publish(.5, "opening");
        QVERIFY(observation.poll(.5, "opening"));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 1);
    }

    void observerDestructionDisconnectsAndAnOutstandingScopeIsSafe() {
        HeaderOpenSurface surface;
        int clockReads = 0;
        auto observation = std::make_unique<HeaderOpenObservation>();
        QVERIFY(observation->begin(&surface, [&] { return ++clockReads; }));
        auto scope = std::make_unique<HeaderOpenObservation::ClickScope>(observation.get());
        surface.publish(.1, "opening");
        QCOMPARE(clockReads, 1);
        observation.reset();
        scope.reset();
        surface.publish(.5, "opening");
        QCOMPARE(clockReads, 1);
    }

    void invalidSubscriptionCannotReuseAnEarlierLatch() {
        HeaderOpenSurface surface;
        HeaderOpenUnnotifiedSurface unnotified;
        HeaderOpenObservation observation;
        QVERIFY(observation.begin(&surface, [] { return 10; }));
        surface.publish(.5, "opening");
        QVERIFY(observation.poll(.5, "opening"));
        QVERIFY(!observation.begin(&unnotified, [] { return 11; }));
        surface.publish(.6, "opening");
        QVERIFY(!observation.poll(.5, "opening"));
        QCOMPARE(observation.snapshot().value("notificationCount").toLongLong(), 0);
        QVERIFY(nullPart(observation, "latched"));
        QVERIFY(!observation.begin(nullptr, [] { return 12; }));
        QVERIFY(!observation.begin(&surface, {}));
    }
};

QTEST_GUILESS_MAIN(HeaderOpenObservationTest)
#include "HeaderOpenObservationTest.moc"
