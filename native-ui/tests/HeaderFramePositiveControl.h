#pragma once

#include "HeaderFrameTiming.h"
#include "HeaderFrameThermal.h"
#include "../src/NativeAvatar.h"
#include "../src/RuntimeBridge.h"
#include <QElapsedTimer>
#include <QPointer>
#include <QQuickItem>
#include <QQuickWindow>
#include <QTimer>
#include <QVariantMap>
#include <algorithm>
#include <array>
#include <cmath>
#include <functional>
#include <memory>
#include <stdexcept>
#include <utility>
#include <vector>

// This calibration does not execute drawer-cycle or ordinary scene checks.
// Only the diagnostic observer may create/draw its own offscreen GPU workload.
namespace HeaderFramePositiveControl {
using Completion = std::function<void(QVariantMap)>;
inline constexpr std::array<int, 4> Draws{0, 64, 128, 256};
inline constexpr int WarmupFrames = 8;
inline constexpr int MeasuredFrames = 24;
inline constexpr qint64 LevelTimeoutNs = 45000000000LL;
inline constexpr qint64 TotalTimeoutNs = 210000000000LL;
inline void require(bool condition, const char *reason) {
    if (!condition) throw std::runtime_error(reason);
}
inline QQuickItem *find(QQuickItem *root, const QString &name) {
    if (!root) return nullptr;
    if (root->objectName() == name) return root;
    for (auto *child : root->childItems()) if (auto *found = find(child, name)) return found;
    return nullptr;
}
inline double percentile(std::vector<quint64> values, double fraction) {
    require(!values.empty(), "W4_POSITIVE_EMPTY_SAMPLE_SET");
    std::sort(values.begin(), values.end());
    const double position = double(values.size() - 1) * fraction;
    const auto low = size_t(std::floor(position)), high = size_t(std::ceil(position));
    return double(values[low]) + double(values[high] - values[low]) * (position - double(low));
}
struct Level {
    int draws = 0;
    qint64 requestNs = -1, endNs = -1;
    quint64 validBeforeRequest = 0;
    QVariantMap thermal;
    QVariantList warmupFrameIds, measuredFrameIds, samples;
    double p50Ns = 0, p90Ns = 0;
    bool completed = false;
};
class Runner final : public QObject {
public:
    Runner(QQuickWindow *window, RuntimeBridge *session, QString outputDirectory,
           QVariantMap localEvidence, Completion completion)
        : QObject(window), m_window(window), m_session(session), m_output(std::move(outputDirectory)),
          m_evidence(std::move(localEvidence)), m_completion(std::move(completion)) {
        m_clock.start();
        m_timer.setInterval(16);
        m_timer.setTimerType(Qt::PreciseTimer);
        connect(&m_timer, &QTimer::timeout, this, [this] { tick(); });
        if (window) connect(window, &QObject::destroyed, this, [this] { finish(false, "W4_POSITIVE_WINDOW_DESTROYED"); });
        QTimer::singleShot(0, this, [this] { m_timer.start(); tick(); });
    }
    ~Runner() override { if (m_observer) m_observer->stop(); }
private:
    QPointer<QQuickWindow> m_window;
    QPointer<RuntimeBridge> m_session;
    QString m_output;
    QVariantMap m_evidence, m_initialThermal, m_resolutionReadback;
    Completion m_completion;
    QElapsedTimer m_clock;
    QTimer m_timer;
    std::unique_ptr<HeaderFrameTiming::Observer> m_observer;
    std::array<Level, 4> m_levels;
    int m_level = -1;
    bool m_finished = false, m_inTick = false;
    qint64 now() const { return m_clock.nsecsElapsed(); }
    void initialize() {
        require(m_window && m_session && m_window->isVisible() && m_window->width() == 1380
                && m_window->height() == 900 && m_session->connected() && !m_session->busy()
                && !m_session->reducedMotion() && !m_session->reducedTransparency(),
                "W4_POSITIVE_BASELINE_WINDOW_REQUIRED");
        auto *avatar = qobject_cast<NativeAvatar *>(find(m_window->contentItem(), "nativeAvatar"));
        auto *compositor = find(m_window->contentItem(), "layerCompositor");
        m_resolutionReadback = {{"windowActualDevicePixelRatio", m_window->effectiveDevicePixelRatio()},
            {"compositorPixelRatio", compositor ? compositor->property("pixelRatio") : QVariant()}};
        require(avatar && avatar->running() && avatar->loads() > 0 && !avatar->modelPath().isEmpty()
                && compositor && compositor->property("effectsActive").toBool()
                && std::abs(m_resolutionReadback.value("windowActualDevicePixelRatio").toDouble() - 2.) < 1e-6
                && std::abs(m_resolutionReadback.value("compositorPixelRatio").toDouble() - 1.) < 1e-6,
                "W4_POSITIVE_MODEL_AND_HALF_RESOLUTION_SCENE_REQUIRED");
        m_initialThermal = HeaderFrameThermal::snapshot();
        m_observer = std::make_unique<HeaderFrameTiming::Observer>(m_window, [this] { return now(); },
            HeaderFrameTiming::Options{true, true});
    }
    void beginLevel(int index) {
        m_level = index;
        auto &level = m_levels[size_t(index)];
        level.draws = Draws[size_t(index)];
        level.thermal = HeaderFrameThermal::snapshot();
        level.validBeforeRequest = m_observer->validSampleCount(level.draws);
        level.requestNs = now();
        require(m_observer->setLoadDraws(level.draws), "W4_POSITIVE_LOAD_SELECTION_FAILED");
    }
    bool collectLevel() {
        auto &level = m_levels[size_t(m_level)];
        const auto count = m_observer->validSampleCount(level.draws);
        if (count < level.validBeforeRequest + WarmupFrames + MeasuredFrames) return false;
        // Copies occur only after enough ready samples exist. Selection still
        // uses the original frame start/load label, never readback arrival.
        const auto snapshot = m_observer->snapshot();
        require(snapshot.value("droppedFrames").toULongLong() == 0
                && snapshot.value("glCallOverflow").toULongLong() == 0,
                "W4_POSITIVE_BOUNDED_EVIDENCE_OVERFLOW");
        QVariantList selected;
        for (const auto &value : snapshot.value("frames").toList()) {
            const auto frame = value.toMap();
            if (frame.value("frameBeginNs").isNull()
                    || frame.value("frameBeginNs").toLongLong() < level.requestNs
                    || frame.value("loadDraws").toInt() != level.draws) continue;
            if (!frame.value("loadInitializedAtFrameStart").toBool()) continue;
            const auto status = frame.value("status").toString();
            if (status != "ready") {
                require(status == "pending" || status == "active" || status == "not-issued", "W4_POSITIVE_INVALID_GPU_FRAME");
                return false;
            }
            require(frame.value("valid").toBool() && !frame.value("gpuDurationNs").isNull()
                    && frame.value("actualLoadDraws").toInt() == level.draws,
                    "W4_POSITIVE_GPU_OR_EXECUTED_LOAD_INVALID");
            selected.append(frame);
            if (selected.size() == WarmupFrames + MeasuredFrames) break;
        }
        if (selected.size() < WarmupFrames + MeasuredFrames) return false;
        std::vector<quint64> durations;
        durations.reserve(MeasuredFrames);
        for (int index = 0; index < selected.size(); ++index) {
            const auto frame = selected[index].toMap();
            if (index < WarmupFrames) level.warmupFrameIds.append(frame.value("frameId"));
            else {
                level.measuredFrameIds.append(frame.value("frameId"));
                durations.push_back(frame.value("gpuDurationNs").toULongLong());
                level.samples.append(QVariantMap{{"frameId", frame.value("frameId")},
                    {"gpuDurationNs", frame.value("gpuDurationNs")}, {"actualLoadDraws", frame.value("actualLoadDraws")},
                    {"frameBeginNs", frame.value("frameBeginNs")}, {"frameEndNs", frame.value("frameEndNs")},
                    {"status", frame.value("status")}, {"valid", frame.value("valid")}});
            }
        }
        level.p50Ns = percentile(durations, .5);
        level.p90Ns = percentile(durations, .9);
        level.endNs = now();
        level.completed = true;
        return true;
    }
    QVariantMap criteria(bool allCompleted) const {
        QVariantList comparisons;
        bool passed = allCompleted;
        const auto &baseline = m_levels[0];
        for (int index = 1; index < 4; ++index) {
            const auto &level = m_levels[size_t(index)];
            const double p50Margin = std::max(100000., baseline.p50Ns * .1);
            const double p90Margin = std::max(100000., baseline.p90Ns * .1);
            const bool aboveBaseline = level.completed && baseline.completed
                && level.p50Ns > baseline.p50Ns + p50Margin
                && level.p90Ns > baseline.p90Ns + p90Margin;
            bool increasing = true;
            if (index > 1) {
                const auto &previous = m_levels[size_t(index - 1)];
                increasing = level.completed && previous.completed && level.p50Ns > previous.p50Ns
                    && level.p90Ns > previous.p90Ns && level.p50Ns - previous.p50Ns >= 100000.
                    && level.p90Ns - previous.p90Ns >= 100000.;
            }
            passed = passed && aboveBaseline && increasing;
            comparisons.append(QVariantMap{{"draws", level.draws}, {"aboveBaseline", aboveBaseline},
                {"baselineP50ThresholdNs", baseline.p50Ns + p50Margin},
                {"baselineP90ThresholdNs", baseline.p90Ns + p90Margin},
                {"adjacentLoadedLevelIncreasing", increasing}});
        }
        return {{"passed", passed}, {"baselineAbsoluteMarginNs", 100000}, {"baselineRelativeMargin", .1},
            {"adjacentMinimumIncreaseNs", 100000}, {"comparisons", comparisons},
            {"percentileMethod", "Linear interpolation at (n-1)*p on 24 original valid GPU durations after eight warmup frames"},
            {"rule", "Every loaded p50 and p90 must exceed baseline + max(0.1ms, baseline*10%); loaded levels must increase strictly with adjacent differences at least 0.1ms for both percentiles"}};
    }
    void tick() {
        if (m_finished || m_inTick) return;
        m_inTick = true;
        try {
            require(m_window && m_session && m_window->isVisible() && m_window->width() == 1380
                    && m_window->height() == 900, "W4_POSITIVE_OWNED_WINDOW_CHANGED");
            require(now() <= TotalTimeoutNs, "W4_POSITIVE_TOTAL_TIMEOUT");
            if (!m_observer) initialize();
            else if (m_level < 0) {
                require(now() <= 15000000000LL, "W4_POSITIVE_CAPABILITY_OR_LOAD_PREPARATION_TIMEOUT");
                if (m_observer->capabilityResolved()) {
                    require(m_observer->queriesAvailable(), "W4_POSITIVE_GPU_UNAVAILABLE");
                    if (m_observer->loadReady()) beginLevel(0);
                }
            } else {
                require(m_observer->queriesAvailable() && m_observer->loadReady(), "W4_POSITIVE_GPU_OR_LOAD_BECAME_UNAVAILABLE");
                require(now() - m_levels[size_t(m_level)].requestNs <= LevelTimeoutNs, "W4_POSITIVE_LEVEL_TIMEOUT");
                if (collectLevel()) {
                    if (m_level == 3) { m_inTick = false; finish(true); return; }
                    beginLevel(m_level + 1);
                }
            }
        } catch (const std::exception &error) {
            m_inTick = false;
            finish(false, QString::fromUtf8(error.what()));
            return;
        }
        m_inTick = false;
    }
    void finish(bool completed, QString error = {}) {
        if (m_finished) return;
        m_finished = true;
        m_timer.stop();
        QVariantMap timing;
        if (m_observer) {
            m_observer->setLoadDraws(0);
            m_observer->stop();
            timing = m_observer->snapshot();
        }
        const auto rules = criteria(completed);
        const bool collectorValid = timing.value("queriesAvailable").toBool()
            && timing.value("droppedFrames").toULongLong() == 0 && timing.value("glCallOverflow").toULongLong() == 0;
        const bool measurementValid = completed && collectorValid && rules.value("passed").toBool();
        if (completed && !measurementValid) error = collectorValid
            ? "W4_GPU_POSITIVE_CONTROL_CRITERIA_FAILED" : "W4_GPU_POSITIVE_CONTROL_COLLECTOR_INVALID";
        QVariantList levels;
        for (int index = 0; index < 4; ++index) {
            const auto &level = m_levels[size_t(index)];
            quint64 actualCalls = 0, executedFrames = 0, warmupCalls = 0, measuredCalls = 0;
            for (const auto &value : timing.value("frames").toList()) {
                const auto frame = value.toMap();
                if (frame.value("frameBeginNs").isNull() || level.requestNs < 0) continue;
                const auto time = frame.value("frameBeginNs").toLongLong();
                if (time < level.requestNs || (level.endNs >= 0 && time > level.endNs)
                        || frame.value("loadDraws").toInt() != level.draws
                        || !frame.value("loadInitializedAtFrameStart").toBool()) continue;
                const auto calls = frame.value("actualLoadDraws").toULongLong();
                actualCalls += calls;
                ++executedFrames;
                if (level.warmupFrameIds.contains(frame.value("frameId"))) warmupCalls += calls;
                if (level.measuredFrameIds.contains(frame.value("frameId"))) measuredCalls += calls;
            }
            levels.append(QVariantMap{{"draws", Draws[size_t(index)]}, {"requestNs", level.requestNs},
                {"endNs", level.endNs}, {"completed", level.completed}, {"thermalBeforeLevel", level.thermal},
                {"warmupFrameIds", level.warmupFrameIds}, {"measuredFrameIds", level.measuredFrameIds},
                {"samples", level.samples}, {"p50Ns", level.p50Ns}, {"p90Ns", level.p90Ns},
                {"actualDrawCalls", actualCalls}, {"executedFrameCount", executedFrames},
                {"warmupActualDrawCalls", warmupCalls}, {"measuredActualDrawCalls", measuredCalls}});
        }
        QVariantMap report{{"schema", "reverie.qt.header-frame-positive-control.v1"},
            {"scenario", "gpu-positive-control"}, {"package", "preview-header-frame-20261102"},
            {"variant", "gpu-positive-control"}, {"windowSize", "wide"},
            {"windowWidth", m_window ? m_window->width() : 0}, {"windowHeight", m_window ? m_window->height() : 0},
            {"windowActualDevicePixelRatio", m_resolutionReadback.value("windowActualDevicePixelRatio")},
            {"compositorPixelRatio", m_resolutionReadback.value("compositorPixelRatio")},
            {"outputDirectory", m_output}, {"acceptanceEligible", false}, {"performanceComparable", false},
            {"completed", completed}, {"passed", measurementValid}, {"measurementValid", measurementValid},
            {"error", error}, {"elapsedNs", now()}, {"levels", levels}, {"criteria", rules},
            {"headerFrameTiming", timing}, {"thermalAtStart", m_initialThermal}, {"localEvidence", m_evidence},
            {"screenshot", QVariantMap{{"requested", "none"}, {"performed", false}, {"timingStopped", true}}},
            {"constraints", QVariantMap{{"warmupFrames", WarmupFrames}, {"measuredFrames", MeasuredFrames},
                {"levelTimeoutNs", LevelTimeoutNs}, {"totalTimeoutNs", TotalTimeoutNs},
                {"scope", "Fixed predeclared load levels; no retries, adaptive load changes, forced GPU synchronization, or ordinary scene acceptance assertions"}}}};
        if (m_observer && !m_observer->queriesAvailable()) report["gpuUnavailableReason"] = m_observer->unavailableReason();
        auto completion = std::move(m_completion);
        if (completion) completion(report);
        deleteLater();
    }
};
inline void run(QQuickWindow *window, RuntimeBridge *session, QString outputDirectory,
                QVariantMap evidence, Completion completion) {
    new Runner(window, session, std::move(outputDirectory), std::move(evidence), std::move(completion));
}
} // namespace HeaderFramePositiveControl
