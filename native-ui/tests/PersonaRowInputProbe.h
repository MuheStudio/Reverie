#pragma once
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include <QJSValue>
#include <QSignalSpy>
#include <QTest>

// The seven legacy persona-row inputs share this test-side acquisition path.
// It never changes the original step clock or the product's eligibility, and
// never resolves a button outside taskSurface -> characterTasks.
namespace PersonaRowInputProbe {
struct Context {
    QQuickWindow *window = nullptr;
    std::function<QString()> currentScope;
    std::function<int()> currentGeneration;
    std::function<QString()> currentPersonaId;
    std::function<QVariantList()> profiles;
    std::function<QVariantMap()> personaState;
    std::function<QVariantMap()> personasState;
    std::function<qint64()> nowMs;
    std::function<quint64()> frameSerial;
    std::function<void()> beforeDispatch;
    std::function<void(QQuickItem *, const QPoint &, const std::function<void()> &)> dispatch;
};

class Input {
public:
    enum Result { Waiting, Performed, Expired, Failed };
    bool bind(int step, const QString &targetId, const QString &scope, int generation,
              qint64 stepAtMs, const QString &sourcePersonaId = {}, const QString &livePersonaId = {}) {
        if (m_bound) return false;
        m_bound = true; m_step = step; m_targetId = targetId; m_scope = scope;
        m_generation = generation; m_stepAt = stepAtMs; m_sourcePersonaId = sourcePersonaId; m_livePersonaId = livePersonaId;
        if (step < 0 || targetId.isEmpty() || scope.isEmpty() || generation < 0 ||
            stepAtMs < 0 || sourcePersonaId.isEmpty() || targetId == sourcePersonaId || livePersonaId.isEmpty() ||
            (sourcePersonaId != "default" && sourcePersonaId != livePersonaId)) {
            seal(Failed, "invalid-binding"); return false;
        }
        return true;
    }
    Result poll(const Context &context) {
        if (m_busy) return Waiting;
        if (m_terminalSet) return m_result;
        m_busy = true;
        struct Guard { bool &busy; ~Guard() { busy = false; } } guard{m_busy};
        try {
            if (!m_bound || !context.window || !context.currentScope || !context.currentGeneration ||
                !context.currentPersonaId || !context.profiles || !context.personaState || !context.personasState || !context.nowMs ||
                !context.frameSerial || !context.dispatch)
                return seal(Failed, "invalid-context");
            ++m_polls;
            const auto now = context.nowMs();
            m_interval = m_previousPoll < 0 ? QVariant{} : QVariant(now - m_previousPoll);
            m_previousPoll = now;
            m_windowWidth = context.window->width(); m_windowHeight = context.window->height();
            if (now < m_stepAt) return seal(Failed, "clock-regressed");
            auto elapsed = [&] { return context.nowMs() - m_stepAt; };
            if (expired(elapsed())) return seal(Expired, "input-deadline");
            auto observation = observe(context);
            if (expired(elapsed())) { remember(observation.state); return seal(Expired, "input-deadline"); }
            if (!sameScope(observation.state)) { remember(observation.state); return seal(Failed, "scope-or-persona-changed"); }
            if (ambiguous(observation.state)) { remember(observation.state); return seal(Failed, "ambiguous-identity"); }
            if (observation.identityMatches) {
                m_reveal = NativeControlReadiness::revealWholeItem(observation.control.item, elapsed, DeadlineMs);
                if (expired(elapsed()) || m_reveal.value("expired").toBool()) {
                    auto state = observation.state; state["reveal"] = m_reveal;
                    remember(state); return seal(Expired, "input-deadline");
                }
                observation = observe(context); // contentY changes can rebuild the delegate synchronously.
            } else {
                m_reveal = {};
            }
            auto state = observation.state;
            state["reveal"] = m_reveal;
            if (expired(elapsed()) || m_reveal.value("expired").toBool()) {
                remember(state); return seal(Expired, "input-deadline");
            }
            if (!sameScope(state)) { remember(state); return seal(Failed, "scope-or-persona-changed"); }
            if (ambiguous(state)) { remember(state); return seal(Failed, "ambiguous-identity"); }
            const auto layout = observeLayout(observation, elapsed(), context.frameSerial());
            state["layout"] = layout;
            remember(state);
            if (expired(elapsed())) return seal(Expired, "input-deadline");
            if (!layout.value("layoutStable").toBool()) return waitForFrame(context.window);

            // The one historical list screenshot belongs to step 401. It can
            // consume time or process frames; it grants neither a new deadline
            // nor permission to click its now-stale item/point.
            if (!m_captureAttempted && context.beforeDispatch) {
                m_captureAttempted = true;
                context.beforeDispatch();
            }
            if (expired(elapsed())) return seal(Expired, "input-deadline");
            const auto fresh = observe(context);
            auto freshState = fresh.state;
            freshState["reveal"] = m_reveal;
            if (expired(elapsed())) { remember(freshState); return seal(Expired, "input-deadline"); }
            if (!sameScope(freshState)) { remember(freshState); return seal(Failed, "scope-or-persona-changed"); }
            if (ambiguous(freshState)) { remember(freshState); return seal(Failed, "ambiguous-identity"); }
            if (!m_layout.matches(fresh.control)) {
                freshState["layout"] = observeLayout(fresh, elapsed(), context.frameSerial());
                remember(freshState);
                if (expired(elapsed())) return seal(Expired, "input-deadline");
                return waitForFrame(context.window);
            }
            freshState["layout"] = m_layout.metadata().value("last");
            remember(freshState);

            // Keep the existing exception-latched once-only sequence gate.
            // Its revealCenter is a no-op after whole-item admission; every
            // callback still uses the caller's original 4-second clock.
            const auto result = m_sequence.poll(elapsed, DeadlineMs, {{controlName(),
                [&] { return observe(context).control.item.data(); },
                [&](QQuickItem *target) {
                    const auto current = observe(context);
                    auto report = current.state;
                    report["reveal"] = m_reveal;
                    report["layout"] = m_layout.metadata().value("last");
                    const bool matches = sameScope(report) && current.control.item == target &&
                                         m_layout.matches(current.control);
                    report["ready"] = matches;
                    remember(report);
                    return report;
                },
                [&](QQuickItem *target) {
                    const auto current = observe(context);
                    auto report = current.state;
                    report["reveal"] = m_reveal;
                    report["layout"] = m_layout.metadata().value("last");
                    remember(report);
                    if (expired(elapsed())) throw std::runtime_error("input-deadline");
                    if (!sameScope(report) || current.control.item != target || !m_layout.matches(current.control))
                        throw std::runtime_error("final-input-validation-changed");
                    QPointer<QQuickItem> qualified = current.control.item;
                    const auto signal = qualified->metaObject()->indexOfSignal("clicked()");
                    if (signal < 0) throw std::runtime_error("clicked-observer-unavailable");
                    QSignalSpy clicked(qualified, qualified->metaObject()->method(signal));
                    m_signalObserverValid = clicked.isValid();
                    if (!clicked.isValid()) throw std::runtime_error("clicked-observer-unavailable");
                    if (expired(elapsed())) throw std::runtime_error("input-deadline");
                    // Latch before the caller-owned dispatch. A synchronous
                    // reentry or exception must never cause a second click.
                    m_dispatchElapsed = elapsed();
                    m_dispatchFrame = context.frameSerial();
                    if (m_dispatchElapsed >= DeadlineMs) throw std::runtime_error("input-deadline");
                    ++m_dispatchCount;
                    const auto sendMouse = [&] {
                        if (m_mouseCount != 0) throw std::runtime_error("mouse-dispatch-repeated");
                        if (expired(elapsed())) throw std::runtime_error("input-deadline");
                        const auto actual = observe(context);
                        if (expired(elapsed())) throw std::runtime_error("input-deadline");
                        if (!qualified || actual.control.item != qualified || !sameScope(actual.state) ||
                            !m_layout.matches(actual.control)) throw std::runtime_error("actual-mouse-validation-changed");
                        m_mouse = actual.state;
                        m_mouse["layout"] = m_layout.metadata().value("last");
                        m_mouseElapsed = elapsed(); m_mouseFrame = context.frameSerial();
                        if (m_mouseElapsed >= DeadlineMs) throw std::runtime_error("input-deadline");
                        ++m_mouseCount;
                        QTest::mouseClick(context.window, Qt::LeftButton, Qt::NoModifier, actual.control.point, 0);
                    };
                    try { context.dispatch(qualified, current.control.point, sendMouse); }
                    catch (...) { m_clickedSignals = qint64(clicked.count()); throw; }
                    m_clickedSignals = qint64(clicked.count());
                    if (m_dispatchCount != 1 || m_mouseCount != 1 || clicked.count() != 1)
                        throw std::runtime_error("clicked-signal-count");
                }}});
            if (result == NativeControlReadiness::SequentialGate::Expired)
                return seal(Expired, "input-deadline");
            if (result == NativeControlReadiness::SequentialGate::Failed)
                return seal(Failed, "input-sequence-failed");
            if (result == NativeControlReadiness::SequentialGate::Performed)
                return seal(Performed, {});
            return waitForFrame(context.window);
        } catch (const std::exception &error) {
            return seal(QString::fromLatin1(error.what()) == "input-deadline" ? Expired : Failed,
                        QString::fromLatin1(error.what()).left(100));
        } catch (...) { return seal(Failed, "dispatch-exception"); }
    }
    void abort(const QString &reason, qint64 nowMs) {
        if (m_terminalSet) return;
        m_last["elapsedMs"] = nowMs >= m_stepAt ? QVariant(nowMs - m_stepAt) : QVariant{};
        seal(Failed, reason.left(100));
    }
    QVariantMap metadata() const {
        auto sequence = m_sequence.metadata();
        QVariantList actions;
        for (const auto &value : sequence.value("actions").toList()) {
            auto action = value.toMap();
            action.remove("samples"); action.remove("last");
            actions.append(action);
        }
        sequence["actions"] = actions;
        return {{"step", m_step}, {"targetId", m_targetId}, {"sourcePersonaId", m_sourcePersonaId}, {"livePersonaId", m_livePersonaId},
                {"control", controlName()}, {"root", "taskSurface"}, {"page", "characterTasks"},
                {"scope", m_scope}, {"generation", m_generation}, {"stepAtMs", m_stepAt},
                {"deadlineMs", DeadlineMs}, {"pollIntervalMs", 40}, {"minimumStableMs", 40},
                {"sampleLimit", NativeControlReadiness::ObservationLimit}, {"polls", m_polls},
                {"windowWidth", m_windowWidth}, {"windowHeight", m_windowHeight},
                {"dispatchCount", m_dispatchCount}, {"dispatchAttemptCount", m_dispatchCount},
                {"mouseDispatchCount", m_mouseCount}, {"clickedSignals", m_clickedSignals},
                {"status", status()}, {"failureReason", m_failure},
                {"terminalCount", m_terminalSet ? 1 : 0}, {"samples", m_samples}, {"terminal", m_terminal},
                {"sequence", sequence}};
    }
    QVariantMap readinessMetadata() const {
        return {{"polls", m_polls}, {"performed", m_result == Performed}, {"samples", m_samples},
                {"last", m_terminalSet ? m_terminal : m_last}, {"sampleLimit", 6}, {"pollIntervalMs", 40}};
    }
    bool terminal() const { return m_terminalSet; }
    QString failureReason() const { return m_failure; }
private:
    struct Observation {
        SummaryInteractionProbe::ControlObservation control;
        QVariantMap state;
        bool identityMatches = false;
    };
    static constexpr int DeadlineMs = 4000;
    static Result waitForFrame(QQuickWindow *window) {
        // A stationary, already-visible row may have no animation or scroll
        // update pending. Request presentation through the same path used by
        // the controlled test; this changes neither geometry nor the clock.
        if (window) window->update();
        return Waiting;
    }
    static void matches(QQuickItem *root, const QString &name, QList<QQuickItem *> &found) {
        if (!root) return;
        if (root->objectName() == name) found.append(root);
        for (auto *child : root->childItems()) matches(child, name, found);
    }
    static QVariantMap rowData(QQuickItem *row, QVariantMap &evidence) {
        evidence = {{"rowId", QVariant{}}, {"rowActive", QVariant{}}, {"rowIdKnown", false},
                    {"rowActiveKnown", false}, {"modelDataType", QVariant{}}, {"normalizedModelDataType", QVariant{}}};
        if (!row) return {};
        auto value = row->property("modelData");
        if (value.isValid()) evidence["modelDataType"] = QString::fromLatin1(value.metaType().name()).left(80);
        if (value.metaType() == QMetaType::fromType<QJSValue>()) value = value.value<QJSValue>().toVariant();
        if (value.isValid()) evidence["normalizedModelDataType"] = QString::fromLatin1(value.metaType().name()).left(80);
        if (value.metaType().id() != QMetaType::QVariantMap) return {};
        const auto data = value.toMap();
        const bool idKnown = data.value("id").metaType().id() == QMetaType::QString;
        const bool activeKnown = data.value("active").metaType().id() == QMetaType::Bool;
        evidence["rowIdKnown"] = idKnown; evidence["rowActiveKnown"] = activeKnown;
        if (idKnown) evidence["rowId"] = data.value("id").toString().left(160);
        if (activeKnown) evidence["rowActive"] = data.value("active");
        return data;
    }
    Observation observe(const Context &context) const {
        Observation out;
        // Read caller-owned sources before retaining visual objects. A source
        // callback can run synchronous QML work, including deleting a delegate.
        QPointer<QQuickWindow> window = context.window;
        const auto scope = context.currentScope();
        const auto generation = context.currentGeneration();
        const auto persona = context.currentPersonaId();
        const auto profiles = context.profiles();
        const auto get = context.personaState(), list = context.personasState();
        const auto getLive = get.value("persona_id"), listLive = list.value("persona_id"), listActive = list.value("active_id");
        const auto strictString = [](const QVariant &v) { return v.metaType().id() == QMetaType::QString && !v.toString().isEmpty(); };
        const auto scopeFor = [&](const QVariantMap &value) {
            const auto epoch = value.value("persona_epoch"); bool numeric = false;
            const auto integer = epoch.toLongLong(&numeric);
            const bool epochType = epoch.metaType().id() == QMetaType::Int || epoch.metaType().id() == QMetaType::LongLong ||
                (epoch.metaType().id() == QMetaType::Double && epoch.toDouble() == double(integer));
            return strictString(value.value("persona_id")) && strictString(value.value("persona_fingerprint")) && epochType && numeric && integer >= 0
                ? value.value("persona_id").toString() + ":" + QString::number(integer) + ":" + value.value("persona_fingerprint").toString() : QString();
        };
        const bool liveMatches = strictString(getLive) && strictString(listLive) && strictString(listActive) &&
            getLive.toString() == m_livePersonaId && listLive == getLive && listActive.toString() == m_sourcePersonaId &&
            scopeFor(get) == scope && scopeFor(list) == scope && list.value("profiles").toList() == profiles;
        const auto elapsed = context.nowMs() - m_stepAt;
        const auto frame = context.frameSerial();
        if (!window || elapsed >= DeadlineMs) {
            out.state = {{"elapsedMs", elapsed}, {"frameSerial", frame}, {"scope", scope}, {"generation", generation},
                         {"scopeMatches", scope == m_scope}, {"generationMatches", generation == m_generation},
                         {"personaMatches", persona == m_sourcePersonaId}, {"liveMatches", liveMatches}, {"ready", false}};
            return out;
        }
        QList<QQuickItem *> roots, pages, rows, controls;
        matches(window->contentItem(), "taskSurface", roots);
        QPointer<QQuickItem> root = roots.size() == 1 ? roots.first() : nullptr;
        matches(root, "characterTasks", pages);
        QPointer<QQuickItem> page = pages.size() == 1 ? pages.first() : nullptr;
        matches(page, "personaRow-" + m_targetId, rows);
        matches(page, controlName(), controls);
        QPointer<QQuickItem> row = rows.size() == 1 ? rows.first() : nullptr;
        QPointer<QQuickItem> target = controls.size() == 1 ? controls.first() : nullptr;
        QVariantMap rowEvidence;
        const auto data = rowData(row, rowEvidence);
        const auto rawActive = data.value("active");
        const bool rowInactive = rawActive.metaType().id() == QMetaType::Bool && !rawActive.toBool();
        int targetProfiles = 0, sourceProfiles = 0, activeProfiles = 0;
        bool profileInactive = false, profileActive = false;
        for (const auto &value : profiles) {
            if (value.metaType().id() != QMetaType::QVariantMap) continue;
            const auto profile = value.toMap();
            const auto active = profile.value("active");
            if (active.metaType().id() == QMetaType::Bool && active.toBool()) ++activeProfiles;
            if (profile.value("id").metaType().id() != QMetaType::QString) continue;
            if (profile.value("id").toString() == m_targetId) {
                ++targetProfiles; profileInactive = active.metaType().id() == QMetaType::Bool && !active.toBool();
            }
            if (profile.value("id").toString() == m_sourcePersonaId) {
                ++sourceProfiles; profileActive = active.metaType().id() == QMetaType::Bool && active.toBool();
            }
        }
        const bool scopeMatches = scope == m_scope;
        const bool generationMatches = generation == m_generation;
        const bool personaMatches = persona == m_sourcePersonaId;
        const auto ready = root ? root->property("inputReady") : QVariant{};
        const bool surfaceReady = root && root->isVisible() && root->isEnabled() &&
            ready.metaType().id() == QMetaType::Bool && ready.toBool();
        out.identityMatches = root && page && row && target && row->isAncestorOf(target) &&
            data.value("id").metaType().id() == QMetaType::QString && data.value("id").toString() == m_targetId &&
            rowInactive && targetProfiles == 1 && sourceProfiles == 1 && activeProfiles == 1 &&
            profileInactive && profileActive;
        out.control = SummaryInteractionProbe::inspect(target, window, surfaceReady, m_scope);
        const auto whole = NativeControlReadiness::wholeVisibility(target, window);
        const auto hit = NativeCheck::hitTest(window, out.control.point, target);
        out.control.eligible = out.control.eligible && out.identityMatches && scopeMatches && generationMatches &&
            personaMatches && liveMatches && whole.value("fullyVisible").toBool() && hit.accepted();
        out.control.state["ready"] = out.control.eligible;
        out.control.state["fullyVisible"] = whole.value("fullyVisible");
        out.state = {{"elapsedMs", elapsed}, {"frameSerial", frame},
            {"schedulingIntervalMs", m_interval}, {"taskSurfaceCount", roots.size()},
            {"characterTasksCount", pages.size()}, {"rowCount", rows.size()}, {"controlCount", controls.size()},
            {"targetProfileCount", targetProfiles}, {"sourceProfileCount", sourceProfiles}, {"activeProfileCount", activeProfiles},
            {"identityMatches", out.identityMatches}, {"rowInactive", rowInactive},
            {"scopeMatches", scopeMatches}, {"generationMatches", generationMatches}, {"personaMatches", personaMatches},
            {"liveMatches", liveMatches}, {"livePersonaId", getLive}, {"listPersonaId", listLive}, {"listActivePersonaId", listActive},
            {"personaEpoch", get.value("persona_epoch")}, {"listPersonaEpoch", list.value("persona_epoch")},
            {"personaFingerprint", get.value("persona_fingerprint")}, {"listPersonaFingerprint", list.value("persona_fingerprint")},
            {"surfaceReady", surfaceReady}, {"root", "taskSurface"}, {"page", "characterTasks"},
            {"targetId", m_targetId}, {"sourcePersonaId", m_sourcePersonaId}, {"scope", scope},
            {"generation", generation}, {"whole", whole}, {"control", out.control.state},
            {"hit", hit.metadata()}, {"effectiveOpacity", target ? QVariant(NativeControlReadiness::effectiveOpacity(target)) : QVariant{}},
            {"ready", out.control.eligible}};
        out.state.insert(rowEvidence);
        return out;
    }
    QVariantMap observeLayout(const Observation &observation, qint64 elapsed, quint64 frame) {
        const auto layout = m_layout.observe(observation.control, elapsed, frame);
        if (!observation.control.eligible || layout.value("stableSinceMs").toLongLong() < 0) {
            m_stableAnchor.clear();
        } else if (m_stableAnchor.isEmpty() ||
                   m_stableAnchor.value("elapsedMs") != layout.value("stableSinceMs") ||
                   m_stableAnchor.value("frameSerial") != layout.value("stableFrameSerial")) {
            m_stableAnchor = observation.state;
            m_stableAnchor["elapsedMs"] = layout.value("stableSinceMs");
            m_stableAnchor["frameSerial"] = layout.value("stableFrameSerial");
            m_stableAnchor["reveal"] = m_reveal;
        }
        return layout;
    }
    bool sameScope(const QVariantMap &state) const {
        return state.value("scopeMatches").toBool() && state.value("generationMatches").toBool() &&
               state.value("personaMatches").toBool() && state.value("liveMatches").toBool();
    }
    static bool ambiguous(const QVariantMap &state) {
        for (const auto *key : {"taskSurfaceCount", "characterTasksCount", "rowCount", "controlCount",
                                "targetProfileCount", "sourceProfileCount", "activeProfileCount"})
            if (state.value(key).toInt() > 1) return true;
        return false;
    }
    bool expired(qint64 elapsed) {
        if (elapsed < DeadlineMs) return false;
        m_last["elapsedMs"] = elapsed;
        return true;
    }
    void remember(const QVariantMap &state) {
        m_last = state;
        if (m_samples.size() < NativeControlReadiness::ObservationLimit) m_samples.append(state);
    }
    QString controlName() const { return "personaSwitch-" + m_targetId; }
    QString status() const {
        return m_result == Performed ? "performed" : m_result == Expired ? "expired" :
               m_result == Failed ? "failed" : "waiting";
    }
    Result seal(Result result, const QString &failure) {
        if (m_terminalSet) return m_result;
        m_result = result; m_failure = failure; m_terminal = m_last;
        m_terminal.insert({{"status", status()}, {"failureReason", m_failure}, {"dispatchCount", m_dispatchCount},
            {"dispatchAttemptCount", m_dispatchCount}, {"mouseDispatchCount", m_mouseCount}, {"mouse", m_mouse},
            {"mouseElapsedMs", m_mouseElapsed < 0 ? QVariant{} : QVariant(m_mouseElapsed)},
            {"mouseFrameSerial", m_mouseElapsed < 0 ? QVariant{} : QVariant::fromValue(m_mouseFrame)},
            {"clickedSignals", m_clickedSignals}, {"signalObserverValid", m_signalObserverValid},
            {"stableAnchor", m_stableAnchor},
            {"dispatchElapsedMs", m_dispatchElapsed < 0 ? QVariant{} : QVariant(m_dispatchElapsed)},
            {"dispatchFrameSerial", m_dispatchElapsed < 0 ? QVariant{} : QVariant::fromValue(m_dispatchFrame)}});
        m_terminalSet = true;
        return m_result;
    }
    bool m_bound = false, m_busy = false, m_terminalSet = false, m_captureAttempted = false;
    int m_step = -1, m_generation = -1, m_polls = 0, m_dispatchCount = 0, m_mouseCount = 0;
    int m_windowWidth = 0, m_windowHeight = 0;
    qint64 m_stepAt = -1, m_previousPoll = -1, m_dispatchElapsed = -1, m_mouseElapsed = -1;
    quint64 m_dispatchFrame = 0, m_mouseFrame = 0;
    QString m_targetId, m_scope, m_sourcePersonaId, m_livePersonaId, m_failure;
    QVariant m_interval, m_clickedSignals, m_signalObserverValid;
    QVariantList m_samples;
    QVariantMap m_last, m_terminal, m_reveal, m_stableAnchor, m_mouse;
    Result m_result = Waiting;
    SummaryInteractionProbe::StableGate m_layout;
    NativeControlReadiness::SequentialGate m_sequence;
};
} // namespace PersonaRowInputProbe
