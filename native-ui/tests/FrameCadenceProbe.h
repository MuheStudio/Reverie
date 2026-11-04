#pragma once
#include <QMutex>
#include <QMutexLocker>
#include <QQuickWindow>
#include <QVariantMap>
#include <algorithm>
#include <chrono>
#include <cmath>
#include <memory>

class FrameCadenceProbe {
    struct Sample { double ms; QString phase; };
    struct State {
        QMutex mutex;
        QVector<Sample> samples;
        QString phase;
        std::chrono::steady_clock::time_point previous;
        bool havePrevious = false;
    };
    std::shared_ptr<State> state = std::make_shared<State>();
    QMetaObject::Connection connection;
    bool measured = false;
  public:
    ~FrameCadenceProbe() { QObject::disconnect(connection); }
    void start(QQuickWindow *window, QObject *owner, bool enabled) {
        measured = enabled;
        if (!enabled) return;
        connection = QObject::connect(window, &QQuickWindow::frameSwapped, owner, [s = state] {
            const auto now = std::chrono::steady_clock::now();
            QMutexLocker lock(&s->mutex);
            if (s->phase.isEmpty()) return;
            if (s->havePrevious && s->samples.size() < 12000)
                s->samples.append({std::chrono::duration<double, std::milli>(now - s->previous).count(), s->phase});
            s->previous = now;
            s->havePrevious = true;
        }, Qt::DirectConnection);
    }
    void phase(const QString &name) {
        QMutexLocker lock(&state->mutex);
        if (state->phase == name) return;
        state->phase = name;
        state->havePrevious = false;
    }
    QVariantMap report() {
        phase({});
        QObject::disconnect(connection);
        QMutexLocker lock(&state->mutex);
        QVariantList raw, phases;
        for (const auto &s : state->samples) raw.append(QVariantMap{{"ms", s.ms}, {"phase", s.phase}});
        for (const QString &name : {"reading-transition", "reading-scroll", "composer-growth", "resize"}) {
            QVector<double> values;
            for (const auto &s : state->samples) if (s.phase == name) values.append(s.ms);
            std::sort(values.begin(), values.end());
            auto pct = [&](double p) { return values.isEmpty() ? 0. : values[std::min(values.size() - 1, qsizetype(std::ceil(p * values.size()) - 1))]; };
            phases.append(QVariantMap{{"phase", name}, {"sampleCount", values.size()}, {"p50Ms", pct(.5)}, {"p95Ms", pct(.95)},
                {"maxMs", values.isEmpty() ? 0. : values.last()},
                {"over33Ms", std::count_if(values.begin(), values.end(), [](double ms) { return ms > 33; })},
                {"over50Ms", std::count_if(values.begin(), values.end(), [](double ms) { return ms > 50; })}});
        }
        return {{"measured", measured}, {"method", "steady_clock frameSwapped cadence, not GPU time or input latency; captures excluded"},
                {"scope", "r2 additional scenarios; not the r1/r2 common transition/drag comparison"}, {"phases", phases}, {"samples", raw}};
    }
};
