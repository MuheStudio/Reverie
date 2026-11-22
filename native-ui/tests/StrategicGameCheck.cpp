#include "StrategicGameCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QDateTime>
#include <QElapsedTimer>
#include <QHash>
#include <QJsonDocument>
#include <QJsonObject>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <algorithm>
#include <utility>

namespace {
const QString Read = "game_state:get";
const QString Save = "game_state:put";
const QString LocalPractice = "本地练习";
constexpr int TrafficLimit = 9;

struct GameSpec {
    QString id;
    QString search;
    QStringList moves;
    QString turn;
    int squares;
};

const GameSpec Chess{"chess", "chess", {"-e2", "-e4"}, "轮到你执白走棋", 64};
const GameSpec Go{"go", "weiqi", {"-40"}, "轮到你执黑落子 · 提子 黑 0：白 0", 81};

bool portalReady(const QQuickItem *target) {
    for (auto *item = target; item; item = item->parentItem()) {
        const auto ready = item->property("inputReady");
        if (ready.isValid() && !ready.toBool())
            return false;
    }
    return target != nullptr;
}

class Check final : public QObject {
    enum Phase { Palette, Search, Entry, Load, FirstMove, FirstReply, Undo, UndoSettled,
                 SecondMove, SecondReply, Reset, ResetChoice, Final };

    QQuickWindow *window;
    RuntimeBridge *session;
    const GameSpec &game;
    const bool restart;
    const QString reportPath;
    const QString scope;
    const int generation;
    const int deadline;
    std::function<void(QVariantMap)> completion;
    QElapsedTimer clock;
    QTimer timer;
    Phase phase = Palette;
    qsizetype moveInput = 0;
    qint64 startedEpochMs = 0, phaseAt = 0, searchAt = -1;
    quint64 frame = 0;
    bool polling = false, finished = false, requestFailed = false;
    QVariantList inputs, commands, receipts;
    QVariantMap archiveBefore, observed, lastObservation;
    QHash<QString, QVariantMap> dispatchedFields;
    SummaryInteractionProbe::StableGate inputReady;

    QVariantMap archiveSnapshot() const {
        const auto archive = session->state().value("archive").toMap();
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(archive)).toJson(QJsonDocument::Compact);
        return {{"revision", archive.value("revision")},
                {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}};
    }

    void require(bool ok, const QString &code, QVariantMap details = {}) const {
        details.insert({{"phase", int(phase)}, {"elapsedMs", clock.elapsed()},
                        {"commands", commands.size()}, {"receipts", receipts.size()}});
        NativeCheck::require(ok, "STRATEGIC_GAME_" + code, details);
    }

    QQuickItem *item(const QString &name) const {
        return NativeCheck::findVisual(window->contentItem(), name, true).item;
    }

    void next(Phase value) {
        phase = value;
        moveInput = 0;
        phaseAt = clock.elapsed();
        inputReady.reset();
    }

    bool reveal(QQuickItem *target) {
        const bool ready = portalReady(target);
        const auto result = ready
            ? NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, deadline)
            : QVariantMap{};
        const auto visibility = NativeControlReadiness::wholeVisibility(target, window);
        lastObservation.insert({{"portalReady", ready}, {"reveal", NativeControlReadiness::revealSummary(result)},
                                {"visibility", visibility}});
        return ready && !result.value("expired").toBool() && visibility.value("fullyVisible").toBool();
    }

    bool click(const QString &name) {
        auto *target = item(name);
        const bool shown = reveal(target);
        auto sample = SummaryInteractionProbe::inspect(target, window, portalReady(target), scope);
        sample.eligible = sample.eligible && shown;
        const auto layout = inputReady.observe(sample, clock.elapsed(), frame);
        const bool stable = layout.value("ready").toBool();
        lastObservation.insert({{"control", name}, {"layoutReady", stable}});
        if (!stable) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        lastObservation["hitAccepted"] = hit.accepted();
        require(hit.accepted(), "INPUT_HIT", hit.metadata());
        QSignalSpy spy(target, SIGNAL(clicked()));
        require(spy.isValid(), "INPUT_SIGNAL");
        require(clock.elapsed() < deadline, "DEADLINE");
        const auto at = clock.elapsed();
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        inputs.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
                                  {"clickedSignals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }

    bool playMove() {
        if (!click(game.id + game.moves.at(moveInput)))
            return false;
        inputReady.reset();
        return ++moveInput == game.moves.size();
    }

    int expectedCommands() const {
        if (phase < Load) return 0;
        if (restart) return phase == Final ? 2 : 1;
        if (phase < FirstReply) return 2;
        if (phase < UndoSettled) return 4;
        if (phase < SecondReply) return 5;
        return 7;
    }

    void checkTraffic() const {
        require(!requestFailed, "REQUEST_FAILED");
        require(commands.size() <= expectedCommands() && receipts.size() <= commands.size(), "UNEXPECTED_TRAFFIC");
        for (qsizetype i = 0; i < commands.size(); ++i) {
            const auto command = commands.at(i).toMap();
            const auto id = command.value("id").toString();
            require(command.value("command") == (i == 0 ? Read : Save), "UNEXPECTED_COMMAND", command);
            require(!id.isEmpty() && command.value("scope") == scope && command.value("generation") == generation,
                    "COMMAND_BINDING", command);
            const auto fields = dispatchedFields.value(id);
            require(fields.value("game_id") == game.id && (i == 0 ? fields.size() == 1 :
                    fields.keys() == QStringList{"expected_revision", "game_id", "state"}), "COMMAND_FIELDS", command);
            if (i >= receipts.size())
                continue;
            const auto receipt = receipts.at(i).toMap();
            require(receipt.value("id") == id && receipt.value("command") == command.value("command") &&
                    receipt.value("scope") == scope && receipt.value("generation") == generation, "RECEIPT_BINDING");
            require(receipt.value("ok") == QVariant(true), i == 0 ? "READ_FAILED" : "WRITE_FAILED",
                    {{"reason", receipt.value("code")}});
        }
    }

    QVariantList recordMoves(const QVariant &record) const {
        if (game.id == "go")
            return record.toMap().value("moves").toList();
        return record.toList();
    }

    bool settled(const QString &name, int exchanges, int plies) {
        auto *panel = item(game.id + "Panel");
        auto *status = item(game.id + "Status");
        const bool statusVisible = reveal(status);
        const auto moves = session->gameMoves();
        const auto revision = session->gameRevision();
        const bool ready = session->gameReady();
        lastObservation.insert({{"gameReady", ready}, {"revision", revision}, {"plies", moves.size()},
                                {"expectedExchanges", exchanges}});
        if (!panel || !statusVisible || !ready || receipts.size() < exchanges)
            return false;
        const auto receipt = receipts.at(exchanges - 1).toMap();
        require(session->panel() == game.id && !session->gameCompanion() && moves.size() == plies &&
                receipt.value("revision") == revision && recordMoves(receipt.value("state")) == moves,
                "POSITION_RECEIPT");
        require(status->property("text").toString() == game.turn, "TURN_DISPLAY");
        require(panel->property("resetOpen") == QVariant(false), "RESET_STILL_OPEN");

        const auto board = session->gameBoard();
        require(board.size() == game.squares && item(game.id + "Board"), "BOARD");
        QVariantList stones, last;
        for (qsizetype i = 0; i < board.size(); ++i) {
            const auto square = board.at(i).toMap();
            const auto color = square.value("color").toString();
            require(color.isEmpty() || color == "black" || color == "white", "PIECE_COLOR");
            if (!color.isEmpty()) stones.append(QVariantMap{{"index", i}, {"color", color}});
            if (square.value("last").toBool()) last.append(i);
        }
        observed[name] = QVariantMap{{"atMs", clock.elapsed()}, {"revision", revision}, {"moves", moves},
            {"boardSize", board.size()}, {"stones", stones}, {"last", last}, {"status", game.turn}, {"ready", ready}};
        return true;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        const auto archiveAfter = archiveSnapshot();
        const auto elapsed = clock.elapsed();
        const auto endedEpochMs = QDateTime::currentMSecsSinceEpoch();
        if (error.isEmpty() && archiveAfter != archiveBefore) error = "STRATEGIC_GAME_ARCHIVE_CHANGED";
        if (error.isEmpty() && elapsed >= deadline) error = "STRATEGIC_GAME_DEADLINE";
        for (auto &value : commands) {
            auto command = value.toMap();
            command["fields"] = dispatchedFields.value(command.value("id").toString());
            value = command;
        }
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1},
              {"deadlineMs", deadline}, {"elapsedMs", elapsed},
              {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", endedEpochMs},
              {"scopeBefore", scope}, {"scopeAfter", session->scopeKey()},
              {"generationBefore", generation}, {"generationAfter", session->generation()},
              {"inputs", inputs}, {"searchAtMs", searchAt}, {"commands", commands}, {"receipts", receipts},
              {"observed", observed}, {"archiveBefore", archiveBefore}, {"archiveAfter", archiveAfter},
              {"lastObservation", lastObservation}});
        deleteLater();
    }

    void tick() {
        // Keep the last geometry sample if this tick reaches the deadline.
        require(clock.elapsed() < deadline, "DEADLINE");
        lastObservation = {{"phase", int(phase)}, {"phaseElapsedMs", clock.elapsed() - phaseAt},
                           {"viewportWidth", window->width()}, {"viewportHeight", window->height()},
                           {"frame", QVariant::fromValue(frame)}};
        require(session->connected() && session->scopeKey() == scope && session->generation() == generation,
                "SCOPE_CHANGED");
        checkTraffic();
        switch (phase) {
        case Palette:
            if (click("scene-navigation-search")) next(Search);
            return;
        case Search: {
            auto *search = item("scene-search");
            if (!reveal(search) || !search->hasActiveFocus()) return;
            searchAt = clock.elapsed();
            for (const char letter : game.search.toLatin1())
                QTest::keyClick(window, Qt::Key(Qt::Key_A + letter - 'a'));
            require(search->property("text").toString() == game.search, "SEARCH_TEXT");
            next(Entry);
            return;
        }
        case Entry:
            if (click("search-result-activities-" + game.id)) next(Load);
            return;
        case Load: {
            if (!settled("loaded", restart ? 1 : 2, restart ? 2 : 0)) return;
            auto *mode = item(game.id + "Mode");
            if (!reveal(mode)) return;
            require(mode->property("currentText").toString() == LocalPractice, "MODE_DISPLAY");
            observed["mode"] = LocalPractice;
            next(restart ? Reset : FirstMove);
            return;
        }
        case FirstMove:
            if (playMove()) next(FirstReply);
            return;
        case FirstReply:
            if (settled("first", 4, 2)) next(Undo);
            return;
        case Undo:
            if (click(game.id + "Undo")) next(UndoSettled);
            return;
        case UndoSettled:
            if (settled("undo", 5, 0)) next(SecondMove);
            return;
        case SecondMove:
            if (playMove()) next(SecondReply);
            return;
        case SecondReply:
            if (settled("second", 7, 2)) next(Reset);
            return;
        case Reset:
            if (click(game.id + "Reset")) next(ResetChoice);
            return;
        case ResetChoice: {
            auto *panel = item(game.id + "Panel");
            if (panel && panel->property("resetReady").toBool() &&
                click(game.id + (restart ? "ResetConfirm" : "ResetCancel"))) next(Final);
            return;
        }
        case Final: {
            auto *panel = item(game.id + "Panel");
            if (panel && !panel->property("resetOpen").toBool() &&
                settled("final", restart ? 2 : 7, restart ? 0 : 2)) {
                if (!restart && game.id == "chess")
                    require(window->grabWindow().save(reportPath + "." + game.id + ".png"), "SCREENSHOT");
                finish({});
            }
            return;
        }
        }
    }

  public:
    Check(QQuickWindow *w, RuntimeBridge *s, const GameSpec &spec, bool second, const QString &report,
          std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), game(spec), restart(second), reportPath(report), scope(s->scopeKey()),
          generation(s->generation()), deadline(restart ? 15000 : 60000), completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        archiveBefore = archiveSnapshot();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this,
            [this](const QString &id, const QString &command, const QString &requestScope, int gen) {
                if (!finished && commands.size() < TrafficLimit)
                    commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", requestScope},
                                                {"generation", gen}, {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::gameStateDispatched, this, [this](const QString &id, const QVariantMap &fields) {
            if (!finished && dispatchedFields.size() < TrafficLimit)
                dispatchedFields.insert(id, fields);
        });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (finished || (command != Read && command != Save) || receipts.size() >= TrafficLimit)
                    return;
                receipts.append(QVariantMap{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                    {"generation", gen}, {"atMs", clock.elapsed()}, {"ok", payload.value("ok")},
                    {"exists", payload.value("exists")}, {"revision", payload.value("revision")},
                    {"state", payload.value("state")}, {"code", payload.value("code").toString().left(80)}});
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &, int gen) {
            if (!finished && gen == generation && std::any_of(commands.begin(), commands.end(), [&](const QVariant &row) {
                    return row.toMap().value("id") == id;
                }))
                requestFailed = true;
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
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

void StrategicGameCheck::run(QQuickWindow *window, RuntimeBridge *session, Kind kind, bool restart,
                             const QString &reportPath, std::function<void(QVariantMap)> done) {
    switch (kind) {
    case Kind::Chess:
        new Check(window, session, Chess, restart, reportPath, std::move(done));
        return;
    case Kind::Go:
        new Check(window, session, Go, restart, reportPath, std::move(done));
        return;
    }
}
