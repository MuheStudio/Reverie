#include "RoomQualityCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"

#include <QDateTime>
#include <QElapsedTimer>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <memory>

namespace {
constexpr int DeadlineMs = 20000;
constexpr int QuietMs = 1000;

bool portalReady(const QQuickItem *item) {
    for (auto *parent = item; parent; parent = parent->parentItem()) {
        const auto ready = parent->property("inputReady");
        if (ready.isValid() && !ready.toBool()) return false;
    }
    return item != nullptr;
}

class Check final : public QObject {
    enum Phase { OpenSettings, OpenService, ReadInitial, ChooseQuality, ReadChosen };
    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    std::function<void(QVariantMap)> completion;
    QTimer timer;
    QElapsedTimer clock;
    Phase phase = OpenSettings;
    qint64 startedEpochMs = 0, quietSince = -1;
    quint64 frame = 0;
    bool polling = false, finished = false;
    int changingCount = 0;
    QPointer<QQuickItem> environment;
    std::unique_ptr<QSignalSpy> changingSignals;
    SummaryInteractionProbe::StableGate inputReady;
    QVariantList navigationInputs, inputs, readings;
    QVariantMap lastObservation;

    void require(bool valid, const QString &reason) const {
        NativeCheck::require(valid, "ROOM_QUALITY_" + reason,
            {{"phase", int(phase)}, {"elapsedMs", clock.elapsed()}});
    }
    QQuickItem *item(const QString &name) const {
        return NativeCheck::findVisual(window->contentItem(), name, true).item;
    }
    void next(Phase value) {
        phase = value;
        inputReady.reset();
        quietSince = -1;
    }
    bool click(const QString &name, QVariantList &records) {
        auto *target = item(name);
        const bool ready = portalReady(target);
        const auto revealed = ready
            ? NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, DeadlineMs)
            : QVariantMap{};
        const auto visible = NativeControlReadiness::wholeVisibility(target, window);
        auto sample = SummaryInteractionProbe::inspect(target, window, ready, session->scopeKey());
        sample.eligible = sample.eligible && visible.value("fullyVisible").toBool()
            && !revealed.value("expired").toBool();
        const auto stable = inputReady.observe(sample, clock.elapsed(), frame);
        lastObservation.insert({{"control", name}, {"layout", stable}, {"visibility", visible},
            {"reveal", NativeControlReadiness::revealSummary(revealed)}});
        if (!stable.value("ready").toBool()) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        require(hit.accepted(), "INPUT_HIT");
        QSignalSpy spy(target, SIGNAL(clicked()));
        require(spy.isValid(), "INPUT_SIGNAL");
        const auto at = clock.elapsed();
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        records.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
            {"clickedSignals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }
    bool readQuiet(const QString &quality) {
        require(environment && changingSignals && changingSignals->isValid(), "OBSERVER");
        const qint64 now = clock.elapsed();
        const auto changing = environment->property("changing");
        require(changing.metaType().id() == QMetaType::Bool, "CHANGING_FIELD");
        if (changing.toBool() || changingSignals->count() != changingCount) quietSince = -1;
        changingCount = changingSignals->count();
        if (!changing.toBool() && quietSince < 0) quietSince = now;
        const auto texture = QQmlProperty(environment, "layer.textureSize").read().toSize();
        QVariantMap highlighted;
        for (const auto *value : {"clear", "balanced", "smooth"}) {
            auto *button = item("roomQuality-" + QString(value));
            require(button, "BUTTON_MISSING");
            highlighted[value] = button->property("accented");
        }
        const QVariantMap reading{{"atMs", now}, {"quietSinceMs", quietSince},
            {"quietMs", quietSince < 0 ? 0 : now - quietSince}, {"changing", changing},
            {"quality", session->roomQuality()}, {"roomQuality", environment->parentItem()->property("roomQuality")},
            {"width", environment->width()}, {"height", environment->height()},
            {"textureWidth", texture.width()}, {"textureHeight", texture.height()},
            {"highlighted", highlighted}};
        lastObservation["reading"] = reading;
        if (quietSince < 0 || now - quietSince < QuietMs) return false;
        require(session->roomQuality() == quality && reading.value("roomQuality") == quality, "VALUE");
        for (const auto *value : {"clear", "balanced", "smooth"})
            require(highlighted.value(value).metaType().id() == QMetaType::Bool &&
                    highlighted.value(value).toBool() == (quality == value), "HIGHLIGHT");
        const qreal scale = quality == "smooth" ? qMax(1., window->devicePixelRatio() / 2.) : window->devicePixelRatio();
        require(environment->width() > 0 && environment->height() > 0 &&
                texture == QSize(qRound(environment->width() * scale), qRound(environment->height() * scale)),
                "TEXTURE_SIZE");
        readings.append(reading);
        return true;
    }
    void finish(const QString &error) {
        finished = true;
        timer.stop();
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1},
            {"deadlineMs", DeadlineMs}, {"elapsedMs", clock.elapsed()},
            {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", QDateTime::currentMSecsSinceEpoch()},
            {"devicePixelRatio", window->devicePixelRatio()}, {"navigationInputs", navigationInputs},
            {"inputs", inputs}, {"readings", readings}, {"lastObservation", lastObservation}});
        deleteLater();
    }
    void tick() {
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        require(window->devicePixelRatio() == 2., "DPR");
        lastObservation["phase"] = int(phase);
        lastObservation["elapsedMs"] = clock.elapsed();
        switch (phase) {
        case OpenSettings:
            if (click("nav-settings", navigationInputs)) next(OpenService);
            return;
        case OpenService:
            if (click("settingsTab-service", navigationInputs)) next(ReadInitial);
            return;
        case ReadInitial:
            if (readQuiet(restart ? "smooth" : "balanced")) next(ChooseQuality);
            return;
        case ChooseQuality:
            if (click(restart ? "roomQuality-balanced" : "roomQuality-smooth", inputs)) next(ReadChosen);
            return;
        case ReadChosen:
            if (readQuiet(restart ? "balanced" : "smooth")) finish({});
            return;
        }
    }
public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool second, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), restart(second), completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        environment = item("moonroomEnvironmentShader");
        if (environment) changingSignals = std::make_unique<QSignalSpy>(environment, SIGNAL(changingChanged()));
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
            polling = true;
            try { tick(); }
            catch (const std::exception &failure) { finish(QString::fromUtf8(failure.what())); }
            polling = false;
        });
        timer.start(40);
    }
};
}

void RoomQualityCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                           std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
