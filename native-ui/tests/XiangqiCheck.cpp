#include "XiangqiCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"
#include <QCryptographicHash>
#include <QElapsedTimer>
#include <QJsonDocument>
#include <QQuickWindow>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>

namespace {
class Check final : public QObject {
    enum Step { Palette, Search, Entry, Read, FirstFrom, FirstTo, FirstReply,
                Undo, Undone, SecondFrom, SecondTo, SecondReply, Reset, ResetChoice, ResetDone };

    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    const QString scope;
    const int generation;
    const QByteArray archiveBefore;
    std::function<void(QVariantMap)> completion;
    QTimer timer;
    QElapsedTimer clock;
    qint64 stepAt = 0;
    quint64 frame = 0;
    Step step = Palette;
    bool busy = false, finished = false;
    int archiveResults = 0;
    QString error;
    QVariantList clicks, commands, receipts;
    QVariantMap observed, inputState;
    SummaryInteractionProbe::StableGate stable;

    QByteArray archiveDigest() const {
        const auto archive = session->state().value("archive").toMap();
        return QCryptographicHash::hash(QJsonDocument(QJsonObject::fromVariantMap(archive)).toJson(QJsonDocument::Compact),
                                        QCryptographicHash::Sha256);
    }

    void require(bool condition, const QString &code) const {
        NativeCheck::require(condition, code, {{"step", int(step)}, {"elapsedMs", clock.elapsed()}});
    }

    int deadline() const { return restart ? 15000 : 60000; }

    QQuickItem *item(const QString &name) const {
        return NativeCheck::findVisual(window->contentItem(), name, true).item;
    }

    bool portalReady(QQuickItem *target) const {
        for (auto *current = target; current; current = current->parentItem()) {
            const auto ready = current->property("inputReady");
            if (ready.isValid() && !ready.toBool())
                return false;
        }
        return true;
    }

    void next(Step value) {
        step = value;
        stepAt = clock.elapsed();
        stable.reset();
        inputState.clear();
    }

    bool click(const QString &name) {
        auto elapsed = [this] { return clock.elapsed() - stepAt; };
        require(elapsed() < 4000, "XIANGQI_CONTROL_UNAVAILABLE:" + name);
        auto *target = item(name);
        const auto revealed = NativeControlReadiness::revealWholeItem(target, elapsed, 4000);
        require(!revealed.value("expired").toBool() && elapsed() < 4000 && clock.elapsed() < deadline(),
                "XIANGQI_CONTROL_UNAVAILABLE:" + name);
        const auto sample = SummaryInteractionProbe::inspect(target, window, portalReady(target), scope);
        const auto layout = stable.observe(sample, elapsed(), frame);
        inputState = {{"control", name}, {"found", target != nullptr},
                      {"ready", sample.eligible}, {"reason", sample.state.value("reason")},
                      {"visibleWidth", sample.state.value("visibleWidth")},
                      {"visibleHeight", sample.state.value("visibleHeight")},
                      {"layoutReady", layout.value("ready")}, {"frame", QVariant::fromValue(frame)}};
        if (!layout.value("ready").toBool()) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        require(hit.accepted(), "XIANGQI_INPUT_TARGET:" + name);
        QSignalSpy spy(target, SIGNAL(clicked()));
        require(spy.isValid(), "XIANGQI_INPUT_SIGNAL:" + name);
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        require(spy.count() == 1, "XIANGQI_INPUT_COUNT:" + name);
        clicks.append(QVariantMap{{"control", name}, {"mouseDispatchCount", 1},
                                 {"clickedSignals", spy.count()}, {"elapsedMs", elapsed()}});
        return true;
    }

    bool resetVisible() const {
        auto *panel = item("xiangqiPanel");
        return panel && panel->property("resetOpen").toBool();
    }

    int retiredControls() const {
        QList<QQuickItem *> pending{window->contentItem()};
        int count = 0;
        while (!pending.isEmpty()) {
            auto *current = pending.takeLast();
            if (!current->isVisible())
                continue;
            const auto text = current->property("text").toString();
            count += text == "读取今日手记" || text == "读取共同经历";
            pending.append(current->childItems());
        }
        return count;
    }

    bool settled(const QString &name, int exchanges, int plies) {
        require(commands.size() <= exchanges, "XIANGQI_EXTRA_COMMANDS");
        if (receipts.size() < exchanges || !session->gameReady())
            return false;
        require(commands.size() == exchanges && receipts.size() == exchanges &&
                session->gameMoves().size() == plies, "XIANGQI_UNEXPECTED_POSITION");
        observed[name] = QVariantMap{{"revision", session->gameRevision()}, {"moves", session->gameMoves()},
                                     {"redTurn", session->gameReady()}, {"exchanges", exchanges}};
        return true;
    }

    void finish(bool passed, const QString &failure = {}) {
        finished = true;
        timer.stop();
        auto callback = std::move(completion);
        callback({{"passed", passed}, {"error", failure}, {"cycle", restart ? 2 : 1},
                  {"elapsedMs", clock.elapsed()}, {"deadlineMs", deadline()}, {"step", int(step)},
                  {"clicks", clicks}, {"commands", commands}, {"receipts", receipts}, {"observed", observed},
                  {"archiveResults", archiveResults}, {"archiveUnchanged", archiveDigest() == archiveBefore},
                  {"lastInput", inputState}, {"resetVisible", resetVisible()}});
        deleteLater();
    }

    void tick() {
        require(error.isEmpty(), error);
        require(clock.elapsed() < deadline(), "XIANGQI_DEADLINE");
        require(session->scopeKey() == scope && session->generation() == generation, "XIANGQI_SCOPE_CHANGED");
        require(archiveResults == 0, "XIANGQI_ARCHIVE_REQUEST");
        switch (step) {
        case Palette:
            if (click("scene-navigation-search")) next(Search);
            return;
        case Search: {
            auto *field = item("scene-search");
            require(clock.elapsed() - stepAt < 4000, "XIANGQI_NAV_SEARCH_UNAVAILABLE");
            if (!field || !field->hasActiveFocus()) return;
            for (const auto letter : QByteArray("xiangqi"))
                QTest::keyClick(window, Qt::Key(Qt::Key_A + letter - 'a'));
            require(field->property("text").toString() == "xiangqi", "XIANGQI_NAV_SEARCH_TEXT");
            next(Entry);
            return;
        }
        case Entry:
            if (click("search-result-activities-xiangqi")) next(Read);
            return;
        case Read: {
            if (!settled("loaded", restart ? 1 : 2, restart ? 2 : 0)) return;
            auto *mode = item("xiangqiMode");
            // Storage can reply before the incoming portal has unfolded.
            if (!item("xiangqiBoard") || !mode || !portalReady(mode)) return;
            observed["mode"] = mode->property("currentText");
            observed["retiredControls"] = retiredControls();
            require(observed["mode"] == "本地练习" && observed["retiredControls"].toInt() == 0,
                    "XIANGQI_INITIAL_VIEW");
            next(restart ? Reset : FirstFrom);
            return;
        }
        case FirstFrom:
            if (click("xiangqi-25")) next(FirstTo);
            return;
        case FirstTo:
            if (click("xiangqi-22")) next(FirstReply);
            return;
        case FirstReply:
            if (settled("first", 4, 2)) next(Undo);
            return;
        case Undo:
            if (click("xiangqiUndo")) next(Undone);
            return;
        case Undone:
            if (settled("undo", 5, 0)) next(SecondFrom);
            return;
        case SecondFrom:
            if (click("xiangqi-25")) next(SecondTo);
            return;
        case SecondTo:
            if (click("xiangqi-22")) next(SecondReply);
            return;
        case SecondReply:
            if (settled("second", 7, 2)) next(Reset);
            return;
        case Reset:
            if (click("xiangqiReset")) next(ResetChoice);
            return;
        case ResetChoice:
            require(clock.elapsed() - stepAt < 4000, "XIANGQI_RESET_DIALOG_UNAVAILABLE");
            if (resetVisible() && click(restart ? "xiangqiResetConfirm" : "xiangqiResetCancel"))
                next(ResetDone);
            return;
        case ResetDone:
            if (resetVisible() || !settled("final", restart ? 2 : 7, restart ? 0 : 2)) return;
            require(archiveDigest() == archiveBefore, "XIANGQI_ARCHIVE_CHANGED");
            finish(true);
            return;
        }
    }

  public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool second, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), restart(second), scope(s->scopeKey()),
          generation(s->generation()), archiveBefore(archiveDigest()), completion(std::move(done)) {
        clock.start();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::gameCommandSent, this, [this](const QString &id, const QString &command) {
            if (commands.size() < 8)
                commands.append(QVariantMap{{"id", id}, {"command", command}});
            if (command == "game:move" && error.isEmpty())
                error = "XIANGQI_UNEXPECTED_MODEL_MOVE";
        });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (command.startsWith("archive:") || command.startsWith("worldbook:file:"))
                    ++archiveResults;
                if (command != "game_state:get" && command != "game_state:put")
                    return;
                if (receipts.size() < 8)
                    receipts.append(QVariantMap{{"id", id}, {"command", command}, {"generation", gen},
                        {"ok", payload.value("ok")}, {"exists", payload.value("exists")},
                        {"revision", payload.value("revision")}, {"moves", payload.value("state")}});
                if (payload.value("ok") != QVariant(true) && error.isEmpty()) {
                    const auto code = payload.value("code", "unconfirmed").toString().left(80);
                    error = (command == "game_state:get" ? "XIANGQI_READ_FAILED:" : "XIANGQI_WRITE_FAILED:") + code;
                }
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &code, int) {
            for (const auto &value : commands) {
                if (value.toMap().value("id") == id && error.isEmpty())
                    error = "XIANGQI_REQUEST_FAILED:" + code;
            }
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (busy || finished) return;
            busy = true;
            try {
                tick();
            } catch (const std::exception &failure) {
                finish(false, QString::fromUtf8(failure.what()));
            }
            busy = false;
        });
        timer.start(40);
    }
};
}

void XiangqiCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                       std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
