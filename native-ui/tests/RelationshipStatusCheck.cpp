#include "RelationshipStatusCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <utility>

namespace {
constexpr int DeadlineMs = 10000;
const QString Read = "relationship:get";

bool portalReady(const QQuickItem *item) {
    for (auto *parent = item; parent; parent = parent->parentItem()) {
        const auto ready = parent->property("inputReady");
        if (ready.isValid() && !ready.toBool())
            return false;
    }
    return true;
}

class Check final : public QObject {
    QQuickWindow *window;
    RuntimeBridge *session;
    const int cycle;
    const QString scope;
    const int generation;
    std::function<void(QVariantMap)> completion;
    QElapsedTimer clock;
    QTimer timer;
    qint64 startedEpochMs = 0;
    quint64 frame = 0;
    bool polling = false;
    QVariantMap archiveBefore, navigation, shown, displayLayout;
    QVariantList commands, receipts;
    QString shownRequestId, requestError;
    SummaryInteractionProbe::StableGate navigationReady, displayReady;

    QVariantMap archiveSnapshot() const {
        const auto archive = session->state().value("archive").toMap();
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(archive)).toJson(QJsonDocument::Compact);
        return {{"revision", archive.value("revision")},
                {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}};
    }

    void require(bool condition, const QString &code, const QVariantMap &details = {}) const {
        auto context = details;
        context["elapsedMs"] = clock.elapsed();
        NativeCheck::require(condition, code, context);
    }

    bool sameScope() const {
        return session->connected() && session->scopeKey() == scope && session->generation() == generation;
    }

    void clickCharacter() {
        const QString name = "nav-character";
        const auto match = NativeCheck::findVisual(window->contentItem(), name, true);
        const auto observation = SummaryInteractionProbe::inspect(match.item, window, portalReady(match.item), scope);
        const auto layout = navigationReady.observe(observation, clock.elapsed(), frame);
        if (!layout.value("ready").toBool()) {
            window->update();
            return;
        }
        const auto hit = NativeCheck::hitTest(window, observation.point, match.item);
        navigation = {{"control", name}, {"hit", hit.metadata()}, {"layout", layout}};
        require(hit.accepted(), "RELATIONSHIP_STATUS_NAVIGATION_HIT", hit.metadata());
        QSignalSpy clicked(match.item, SIGNAL(clicked()));
        require(clicked.isValid(), "RELATIONSHIP_STATUS_NAVIGATION_SIGNAL");
        require(sameScope(), "RELATIONSHIP_STATUS_SCOPE_CHANGED");
        require(clock.elapsed() < DeadlineMs, "RELATIONSHIP_STATUS_NAVIGATION_DEADLINE");
        navigation["atMs"] = clock.elapsed();
        navigation["mouseDispatchCount"] = 1;
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, observation.point, 0);
        navigation["clickedSignals"] = clicked.count();
        require(clicked.count() == 1, "RELATIONSHIP_STATUS_NAVIGATION_COUNT", navigation);
    }

    bool observeDisplay(bool snapshotReady) {
        const auto match = NativeCheck::findVisual(window->contentItem(), "relationshipStatus", true);
        if (snapshotReady && match.item && portalReady(match.item))
            NativeControlReadiness::revealWholeItem(match.item, [this] { return clock.elapsed(); }, DeadlineMs);

        auto *block = match.item.data();
        const bool surfaceReady = block && portalReady(block);
        shown.clear();
        const std::pair<const char *, const char *> labels[] = {
            {"stage", "relationshipStage"}, {"detail", "relationshipDetail"},
            {"intimacy", "relationshipIntimacy"}, {"note", "relationshipNote"}};
        for (const auto &[field, name] : labels) {
            const auto label = NativeCheck::findVisual(block, name, true);
            if (label.item) shown[field] = label.item->property("text");
        }
        auto observation = SummaryInteractionProbe::inspect(block, window, surfaceReady, scope);
        const auto visibility = NativeControlReadiness::wholeVisibility(block, window);
        observation.eligible = observation.eligible && snapshotReady && shown.size() == 4 &&
            visibility.value("fullyVisible").toBool();
        observation.state.insert({{"fullyVisible", visibility.value("fullyVisible")},
                                  {"snapshotReady", snapshotReady}, {"visibleLabels", shown.size()}});
        displayLayout = displayReady.observe(observation, clock.elapsed(), frame);
        if (displayLayout.value("ready").toBool())
            return true;
        window->update();
        return false;
    }

    void finish(QString error) {
        timer.stop();
        const auto archiveAfter = archiveSnapshot();
        const auto elapsed = clock.elapsed();
        const auto endedEpochMs = QDateTime::currentMSecsSinceEpoch();
        if (error.isEmpty() && archiveAfter != archiveBefore)
            error = "RELATIONSHIP_STATUS_ARCHIVE_CHANGED";
        if (error.isEmpty() && elapsed >= DeadlineMs)
            error = "RELATIONSHIP_STATUS_DEADLINE";
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", cycle},
              {"deadlineMs", DeadlineMs}, {"elapsedMs", elapsed},
              {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", endedEpochMs},
              {"scopeBefore", scope}, {"scopeAfter", session->scopeKey()},
              {"generationBefore", generation}, {"generationAfter", session->generation()},
              {"navigation", navigation}, {"commands", commands}, {"receipts", receipts},
              {"shownRequestId", shownRequestId}, {"shown", shown}, {"displayLayout", displayLayout},
              {"archiveBefore", archiveBefore}, {"archiveAfter", archiveAfter},
              {"navigationReadiness", navigationReady.metadata()}});
        deleteLater();
    }

    void tick() {
        const bool clicked = navigation.value("clickedSignals").toInt() == 1;
        require(clock.elapsed() < DeadlineMs, "RELATIONSHIP_STATUS_DEADLINE",
                {{"clicked", clicked}, {"commands", commands.size()}, {"receipts", receipts.size()}});
        require(sameScope(), "RELATIONSHIP_STATUS_SCOPE_CHANGED");
        require(commands.size() <= 1 && (commands.isEmpty() || commands.first().toMap().value("command") == Read),
                "RELATIONSHIP_STATUS_UNEXPECTED_COMMAND");
        if (!clicked) {
            require(commands.isEmpty(), "RELATIONSHIP_STATUS_COMMAND_BEFORE_NAVIGATION");
            clickCharacter();
            return;
        }

        const auto status = session->relationshipStatus();
        shownRequestId = status.value("requestId").toString();
        const bool received = !commands.isEmpty() && receipts.size() == 1;
        const auto requestId = commands.value(0).toMap().value("id").toString();
        const auto receipt = receipts.value(0).toMap();
        const bool readBound = received && !requestId.isEmpty() && receipt.value("id") == requestId &&
            shownRequestId == requestId;
        const bool ready = readBound && status.value("status") == "ready";
        const bool visible = observeDisplay(ready);
        require(requestError.isEmpty(), "RELATIONSHIP_STATUS_REQUEST_FAILED", {{"reason", requestError}});
        require(receipts.size() <= 1, "RELATIONSHIP_STATUS_EXTRA_RECEIPT");
        if (received) {
            const auto payload = receipt.value("payload").toMap();
            require(!payload.contains("error") && (!payload.contains("ok") || payload.value("ok") == QVariant(true)),
                    "RELATIONSHIP_STATUS_READ_FAILED", {{"reason", payload.value("code")}});
            // Stop this run before the host can launch a restart with an
            // initial-value snapshot. The receipt and visible text are saved.
            if (cycle == 1 && ready) {
                const auto interactions = payload.value("interaction_count");
                const auto intimacy = payload.value("intimacy");
                require(interactions != QVariant(0), "RELATIONSHIP_STATUS_NO_INTERACTIONS");
                require(intimacy != QVariant(50), "RELATIONSHIP_STATUS_INITIAL_INTIMACY");
            }
        }
        if (visible) finish({});
    }

  public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool restart, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), cycle(restart ? 2 : 1), scope(s->scopeKey()),
          generation(s->generation()), completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        archiveBefore = archiveSnapshot();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this,
            [this](const QString &id, const QString &command, const QString &requestScope, int gen) {
                if (commands.size() < NativeCheck::ObservationLimit)
                    commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", requestScope},
                                                {"generation", gen}, {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (command == Read && receipts.size() < NativeCheck::ObservationLimit)
                    receipts.append(QVariantMap{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                                                 {"generation", gen}, {"atMs", clock.elapsed()}, {"payload", payload}});
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int gen) {
            if (gen == generation && commands.value(0).toMap().value("id") == id)
                requestError = code;
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling) return;
            polling = true;
            try {
                tick();
            } catch (const std::exception &error) {
                finish(QString::fromUtf8(error.what()));
            }
            polling = false;
        });
        timer.start(40);
    }
};
}

void RelationshipStatusCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                                  std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
