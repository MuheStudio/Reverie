#include "PersonaStateCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <utility>

namespace {
constexpr int DeadlineMs = 20000;
constexpr int CommandLimit = 64;
const QString Relationship = "relationship:get", Mood = "emotion:get", Switch = "persona:activate";
const QStringList SwitchLifecycle{"local_mode:set", "persona:get", "persona:list", "settings:get", "chat:history",
    "archive:get", "summary:status", "ai_usage:get", "api:budget:get", "user:profile:get", "module:list", "provider:get"};

class Check final : public QObject {
    enum Phase { Start, Read, Select, Confirm };

    QQuickWindow *window;
    RuntimeBridge *session;
    const int cycle, initialGeneration;
    const QString original, other;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock;
    const qint64 startedEpochMs = QDateTime::currentMSecsSinceEpoch();
    quint64 frame = 0;
    int visit = 0;
    Phase phase = Start;
    bool polling = false, finished = false, overflow = false, recording = false;
    QVariantList commands, receipts, inputs, snapshots;
    QVariantMap lastObservation;
    QString requestError;
    QVariantMap firstRelationship;
    SummaryInteractionProbe::StableGate stable;

    void require(bool condition, const QString &reason) const {
        NativeCheck::require(condition, "PERSONA_STATE_" + reason,
            {{"elapsedMs", clock.elapsed()}, {"phase", int(phase)}, {"visit", visit}});
    }

    QString active() const {
        return session->state().value("personas").toMap().value("active_id").toString();
    }

    QString expected() const { return visit == 1 ? other : original; }
    QString nextPersona() const { return visit == 0 ? other : original; }

    QQuickItem *item(const QString &name, QQuickItem *root = nullptr) const {
        return NativeCheck::findVisual(root ? root : window->contentItem(), name, true).item;
    }

    bool surfaceReady(const QQuickItem *target) const {
        for (auto *current = target; current; current = current->parentItem()) {
            const auto ready = current->property("inputReady");
            if (ready.isValid() && !ready.toBool()) return false;
        }
        return target != nullptr;
    }

    void next(Phase value) { phase = value; stable.reset(); }

    bool reveal(QQuickItem *target) {
        if (!surfaceReady(target)) return false;
        const auto reveal = NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, DeadlineMs);
        const auto visibility = NativeControlReadiness::wholeVisibility(target, window);
        lastObservation.insert({{"reveal", NativeControlReadiness::revealSummary(reveal)}, {"visibility", visibility}});
        return !reveal.value("expired").toBool() && visibility.value("fullyVisible").toBool();
    }

    bool click(const QString &control) {
        auto *target = item(control);
        const bool visible = reveal(target);
        auto observed = SummaryInteractionProbe::inspect(target, window, surfaceReady(target), session->scopeKey());
        observed.eligible = observed.eligible && visible;
        const auto layout = stable.observe(observed, clock.elapsed(), frame);
        lastObservation["control"] = control;
        lastObservation["layoutReady"] = layout.value("ready");
        if (!layout.value("ready").toBool()) { window->update(); return false; }
        require(NativeCheck::hitTest(window, observed.point, target).accepted(), "INPUT_HIT");
        QSignalSpy clicked(target, SIGNAL(clicked()));
        require(clicked.isValid(), "INPUT_SIGNAL");
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        const auto at = clock.elapsed();
        const auto scope = session->scopeKey();
        const auto generation = session->generation();
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, observed.point, 0);
        inputs.append(QVariantMap{{"control", control}, {"atMs", at}, {"scope", scope}, {"generation", generation},
            {"mouseDispatchCount", 1}, {"clickedSignals", clicked.count()}});
        require(clicked.count() == 1, "INPUT_COUNT");
        return true;
    }

    bool settled() const {
        return !session->personaChanging() && !session->busy() &&
            session->diagnostics().value("pendingCommands").toList().isEmpty();
    }

    QVariantMap archive() const {
        const auto state = session->state().value("archive").toMap();
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(state.value("archive").toMap())).toJson(QJsonDocument::Compact);
        return {{"revision", state.value("revision")}, {"sha256", QString::fromLatin1(
            QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}};
    }

    QVariantList history() const {
        QVariantList ids;
        for (const auto &value : session->messages()) {
            const auto row = value.toMap();
            ids.append(QVariantMap{{"id", row.value("id").toString()}, {"role", row.value("role").toString()}});
        }
        return ids;
    }

    QVariantMap receipt(const QString &command, const QString &id) const {
        if (id.isEmpty()) return {};
        for (const auto &value : receipts) {
            const auto row = value.toMap();
            if (row.value("id") == id && row.value("command") == command &&
                row.value("scope") == session->scopeKey() && row.value("generation") == session->generation())
                return row;
        }
        return {};
    }

    bool shown(QVariantMap &relationship, QVariantMap &mood) {
        auto *relationshipBlock = item("relationshipStatus");
        auto *moodBlock = item("moodStatus");
        if (!reveal(moodBlock) || !surfaceReady(relationshipBlock)) return false;
        if (!NativeControlReadiness::wholeVisibility(relationshipBlock, window).value("fullyVisible").toBool()) {
            if (!reveal(relationshipBlock)) return false;
            if (!NativeControlReadiness::wholeVisibility(moodBlock, window).value("fullyVisible").toBool()) return false;
        }
        const std::pair<const char *, const char *> labels[] = {{"stage", "relationshipStage"},
            {"detail", "relationshipDetail"}, {"intimacy", "relationshipIntimacy"}, {"note", "relationshipNote"},
            {"label", "moodLabel"}, {"dominant", "moodDominant"}};
        for (const auto &[field, name] : labels) {
            const bool isMood = QString::fromLatin1(name).startsWith("mood");
            auto *label = item(QString::fromLatin1(name), isMood ? moodBlock : relationshipBlock);
            if (!label) return false;
            (isMood ? mood : relationship)[QString::fromLatin1(field)] = label->property("text");
        }
        return true;
    }

    bool observe() {
        if (!settled() || active() != expected()) return false;
        require(session->generation() == initialGeneration + visit, "GENERATION");
        require(visit == 0 || session->personaFeedback().value("status") == "success", "SWITCH_NOT_CONFIRMED");
        const auto settings = session->state().value("settings").toMap().value("features").toMap();
        require(settings.value("emotion_system_enabled") == QVariant(true), "EMOTION_NOT_ENABLED");
        const auto relationship = session->relationshipStatus(), mood = session->moodStatus();
        const auto relationshipId = relationship.value("requestId").toString(), moodId = mood.value("requestId").toString();
        lastObservation.insert({{"relationshipStatus", relationship.value("status")}, {"moodStatus", mood.value("status")}});
        const auto relationshipReceipt = receipt(Relationship, relationshipId);
        if (relationship.value("status") != "ready" || mood.value("status") != "ready" ||
            relationshipReceipt.isEmpty() || receipt(Mood, moodId).isEmpty()) return false;
        QVariantMap relationshipShown, moodShown;
        if (!shown(relationshipShown, moodShown)) return false;
        for (const auto &[data, display] : {std::pair{relationship, relationshipShown}, std::pair{mood, moodShown}})
            for (auto field = display.cbegin(); field != display.cend(); ++field)
                require(data.value(field.key()) == field.value(), "DISPLAY_VALUE");
        snapshots.append(QVariantMap{{"personaId", active()}, {"scope", session->scopeKey()},
            {"generation", session->generation()}, {"atMs", clock.elapsed()}, {"emotionEnabled", true},
            {"relationshipId", relationshipId}, {"moodId", moodId}, {"relationshipShown", relationshipShown},
            {"moodShown", moodShown}, {"archive", archive()}, {"history", history()},
            {"switchRequestId", visit ? session->personaFeedback().value("requestId").toString() : QString()}});

        const auto payload = relationshipReceipt.value("payload").toMap();
        const int interactions = payload.value("interaction_count").toInt();
        require(interactions >= 1 && (cycle != 1 || visit != 0 || payload.value("intimacy").toInt() != 50),
            "INTERACTION_COUNTS");
        if (visit == 0) firstRelationship = payload;
        else if (visit == 1)
            require(interactions != firstRelationship.value("interaction_count").toInt(), "INTERACTION_COUNTS");
        else require(payload == firstRelationship, "RETURN_RELATIONSHIP");
        return true;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        const auto elapsed = clock.elapsed();
        if (error.isEmpty() && elapsed >= DeadlineMs) error = "PERSONA_STATE_DEADLINE";
        auto callback = std::move(done);
        callback({{"passed", error.isEmpty()}, {"error", error}, {"cycle", cycle}, {"deadlineMs", DeadlineMs},
            {"elapsedMs", elapsed}, {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", QDateTime::currentMSecsSinceEpoch()},
            {"initialPersonaId", original}, {"finalPersonaId", active()}, {"commands", commands}, {"receipts", receipts},
            {"inputs", inputs}, {"snapshots", snapshots}, {"lastObservation", lastObservation}});
        deleteLater();
    }

    void tick() {
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        require(session->connected() && session->runtimeWritable(), "RUNTIME");
        require(!overflow, "TRAFFIC_OVERFLOW");
        require(requestError.isEmpty(), "REQUEST_FAILED");
        lastObservation = {{"phase", int(phase)}, {"visit", visit}, {"personaId", active()},
            {"generation", session->generation()}, {"elapsedMs", clock.elapsed()},
            {"viewportWidth", window->width()}, {"viewportHeight", window->height()}};
        switch (phase) {
        case Start:
            if (!settled()) return;
            require(active() == original && original != other && !other.isEmpty(), "INITIAL_PERSONA");
            require(surfaceReady(item("relationshipStatus")) && surfaceReady(item("moodStatus")), "CHARACTER_NOT_READY");
            require(session->state().value("settings").toMap().value("features").toMap()
                .value("emotion_system_enabled") == QVariant(true), "EMOTION_NOT_ENABLED");
            recording = true;
            require(!session->request(Relationship).isEmpty() && !session->request(Mood).isEmpty(), "READ_NOT_SENT");
            next(Read);
            return;
        case Read:
            if (!observe()) return;
            if (visit == 2) { finish({}); return; }
            next(Select);
            return;
        case Select:
            if (click("personaSwitch-" + nextPersona())) next(Confirm);
            return;
        case Confirm:
            if (click("personaSwitchConfirm")) {
                require(session->personaFeedback().value("status") == "pending", "SWITCH_NOT_SENT");
                ++visit;
                next(Read);
            }
            return;
        }
    }

public:
    Check(QQuickWindow *w, RuntimeBridge *s, int round, const QString &moonId, std::function<void(QVariantMap)> completion)
        : QObject(w), window(w), session(s), cycle(round), initialGeneration(s->generation()),
          original(round == 1 ? moonId : QString("default")), other(round == 1 ? QString("default") : moonId),
          done(std::move(completion)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this, [this](const QString &id, const QString &command, const QString &scope, int gen) {
            if (finished || !recording) return;
            if (commands.size() >= CommandLimit) { overflow = true; return; }
            commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", scope},
                {"generation", gen}, {"atMs", clock.elapsed()}});
            if (command != Relationship && command != Mood && command != Switch && !SwitchLifecycle.contains(command))
                requestError = "unexpected-command";
        });
        connect(s, &RuntimeBridge::responseReceived, this, [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
            if (finished || !recording || (command != Relationship && command != Mood)) return;
            if (receipts.size() >= CommandLimit) { overflow = true; return; }
            receipts.append(QVariantMap{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                {"generation", gen}, {"atMs", clock.elapsed()}, {"payload", payload}});
        });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            for (const auto &value : commands) {
                const auto command = value.toMap();
                if (command.value("id") == id) requestError = code;
            }
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
            polling = true;
            try { tick(); } catch (const std::exception &error) { finish(QString::fromUtf8(error.what())); }
            polling = false;
        });
        timer.start(40);
    }
};
}

void PersonaStateCheck::run(QQuickWindow *window, RuntimeBridge *session, int cycle, const QString &moonId,
                            std::function<void(QVariantMap)> done) {
    new Check(window, session, cycle, moonId, std::move(done));
}
