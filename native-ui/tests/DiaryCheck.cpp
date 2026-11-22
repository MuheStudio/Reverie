#include "DiaryCheck.h"
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
constexpr int DeadlineMs = 15000;
const QString List = "diary:request";
const QString Save = "settings:update";
const QString EmptyText = "还没有日记。";
const QString AuthorizationText = "还需要授权这项费用";
const QString SwitchText = "让她写日记";
const QString WriteText = "现在写今天的日记";

bool boolean(const QVariant &value, bool expected) {
    return value.metaType().id() == QMetaType::Bool && value.toBool() == expected;
}

bool portalReady(const QQuickItem *item) {
    for (auto *parent = item; parent; parent = parent->parentItem()) {
        const auto ready = parent->property("inputReady");
        if (ready.isValid() && !ready.toBool())
            return false;
    }
    return item != nullptr;
}

class Check final : public QObject {
    enum Phase { Palette, Search, Entry, Initial, Toggle, Authorization, WriteDisabled };

    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    const QString scope;
    const int generation;
    std::function<void(QVariantMap)> completion;
    QElapsedTimer clock;
    QTimer timer;
    Phase phase = Palette;
    qint64 startedEpochMs = 0, phaseAt = 0, searchAt = -1;
    quint64 frame = 0;
    bool polling = false, finished = false, requestFailed = false;
    QVariantMap archiveBefore, initial, authorizedView, lastObservation;
    QVariantList inputs, commands, receipts;
    QHash<QString, QVariantMap> dispatchedFields;
    SummaryInteractionProbe::StableGate inputReady;

    QVariantMap archiveSnapshot() const {
        const auto archive = session->state().value("archive").toMap();
        const auto bytes = QJsonDocument(QJsonObject::fromVariantMap(archive)).toJson(QJsonDocument::Compact);
        return {{"revision", archive.value("revision")},
                {"sha256", QString::fromLatin1(QCryptographicHash::hash(bytes, QCryptographicHash::Sha256).toHex())}};
    }

    void require(bool condition, const QString &code) const {
        NativeCheck::require(condition, "DIARY_" + code,
                             {{"phase", int(phase)}, {"elapsedMs", clock.elapsed()},
                              {"commands", commands.size()}, {"receipts", receipts.size()}});
    }

    QQuickItem *item(const QString &name, QQuickItem *root) const {
        return NativeCheck::findVisual(root, name, true).item;
    }

    void next(Phase value) {
        phase = value;
        phaseAt = clock.elapsed();
        inputReady.reset();
    }

    bool reveal(QQuickItem *target) {
        const bool surfaceReady = portalReady(target);
        const auto result = surfaceReady
            ? NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, DeadlineMs)
            : QVariantMap{};
        const auto visibility = NativeControlReadiness::wholeVisibility(target, window);
        lastObservation.insert({{"portalReady", surfaceReady}, {"reveal", NativeControlReadiness::revealSummary(result)},
                                {"visibility", visibility}});
        return surfaceReady && !result.value("expired").toBool() && visibility.value("fullyVisible").toBool();
    }

    bool click(const QString &name, QQuickItem *target, const char *signal) {
        const bool shown = reveal(target);
        auto sample = SummaryInteractionProbe::inspect(target, window, portalReady(target), scope);
        sample.eligible = sample.eligible && shown;
        const auto layout = inputReady.observe(sample, clock.elapsed(), frame);
        const bool stable = layout.value("ready").toBool();
        lastObservation["layoutReady"] = stable;
        if (!stable) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        lastObservation["hitAccepted"] = hit.accepted();
        require(hit.accepted(), "INPUT_HIT");
        QSignalSpy spy(target, signal);
        require(spy.isValid(), "INPUT_SIGNAL");
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        const auto at = clock.elapsed();
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        inputs.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
                                  {"signals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }

    bool checked(QQuickItem *toggle, const QVariantMap &view, bool expected) const {
        return toggle && toggle->property("text").toString() == SwitchText &&
            boolean(toggle->property("checked"), expected) && boolean(view.value("enabled"), expected) &&
            boolean(view.value("switchPending"), false);
    }

    bool exchangeReady(int index, const QString &command, const QVariantMap &fields) {
        if (commands.size() <= index)
            return false;
        const auto sent = commands.at(index).toMap();
        const auto id = sent.value("id").toString();
        require(!id.isEmpty() && sent.value("scope") == scope && sent.value("generation") == generation,
                "COMMAND_BINDING");
        const auto observed = dispatchedFields.value(id);
        require(observed == fields && (command != Save || boolean(observed.value("diary_enabled"), true)),
                "COMMAND_FIELDS");
        if (receipts.size() <= index)
            return false;
        const auto receipt = receipts.at(index).toMap();
        require(receipt.value("id") == id && receipt.value("command") == command &&
                receipt.value("scope") == scope && receipt.value("generation") == generation, "RECEIPT_BINDING");
        require(boolean(receipt.value("ok"), true), "RECEIPT_FAILED");
        return true;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        const auto archiveAfter = archiveSnapshot();
        const auto elapsed = clock.elapsed();
        const auto endedEpochMs = QDateTime::currentMSecsSinceEpoch();
        if (error.isEmpty() && archiveAfter != archiveBefore)
            error = "DIARY_ARCHIVE_CHANGED";
        if (error.isEmpty() && elapsed >= DeadlineMs)
            error = "DIARY_DEADLINE";
        for (auto &value : commands) {
            auto command = value.toMap();
            command["fields"] = dispatchedFields.value(command.value("id").toString());
            value = command;
        }
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1},
              {"deadlineMs", DeadlineMs}, {"elapsedMs", elapsed},
              {"tailStartEpochMs", startedEpochMs}, {"tailEndEpochMs", endedEpochMs},
              {"scopeBefore", scope}, {"scopeAfter", session->scopeKey()},
              {"generationBefore", generation}, {"generationAfter", session->generation()},
              {"inputs", inputs}, {"searchAtMs", searchAt}, {"commands", commands}, {"receipts", receipts},
              {"initial", initial}, {"authorizedView", authorizedView},
              {"archiveBefore", archiveBefore}, {"archiveAfter", archiveAfter}, {"lastObservation", lastObservation}});
        deleteLater();
    }

    void tick() {
        lastObservation = {{"phase", int(phase)}, {"phaseElapsedMs", clock.elapsed() - phaseAt},
                           {"viewportWidth", window->width()}, {"viewportHeight", window->height()},
                           {"frame", QVariant::fromValue(frame)}};
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        require(session->connected() && session->scopeKey() == scope && session->generation() == generation,
                "SCOPE_CHANGED");
        require(!requestFailed, "REQUEST_FAILED");
        const bool entered = phase >= Initial;
        const bool toggled = !restart && phase >= Authorization;
        const int expected = int(entered) + int(toggled);
        require(commands.size() <= expected && receipts.size() <= commands.size(), "UNEXPECTED_TRAFFIC");
        for (int i = 0; i < commands.size(); ++i)
            require(commands.at(i).toMap().value("command") == (i == 0 ? List : Save), "UNEXPECTED_COMMAND");

        auto *root = window->contentItem();
        if (phase == Palette) {
            const QString name = "scene-navigation-search";
            if (click(name, item(name, root), SIGNAL(clicked()))) next(Search);
            return;
        }
        if (phase == Search) {
            auto *search = item("scene-search", root);
            if (!reveal(search) || !search->hasActiveFocus())
                return;
            searchAt = clock.elapsed();
            for (const char letter : QByteArray("diary"))
                QTest::keyClick(window, Qt::Key(Qt::Key_A + letter - 'a'));
            require(search->property("text").toString() == "diary", "SEARCH_TEXT");
            next(Entry);
            return;
        }
        if (phase == Entry) {
            const QString name = "search-result-activities-diary";
            if (click(name, item(name, root), SIGNAL(clicked()))) next(Initial);
            return;
        }

        auto *panel = item("diaryPanel", root);
        auto *toggle = item("diaryEnabled", panel);
        const auto view = session->diaryView();
        if (phase == Initial) {
            const bool listReady = exchangeReady(0, List, {{"action", "list"}}) && view.value("listStatus") == "ready";
            auto *empty = item("diaryEmpty", panel);
            if (!reveal(empty) || !reveal(toggle) || !listReady)
                return;
            const auto receipt = receipts.at(0).toMap();
            require(receipt.value("entryCount") == QVariant(0) && boolean(receipt.value("writing"), false) &&
                    receipt.value("id") == view.value("listRequestId"), "LIST_DISPLAY_BINDING");
            require(empty->property("text").toString() == EmptyText && checked(toggle, view, restart), "INITIAL_DISPLAY");
            initial = {{"atMs", clock.elapsed()}, {"checked", toggle->property("checked")},
                       {"enabled", view.value("enabled")}, {"emptyText", EmptyText},
                       {"listRequestId", view.value("listRequestId")}};
            next(restart ? Authorization : Toggle);
            return;
        }
        if (phase == Toggle) {
            if (click("diaryEnabled", toggle, SIGNAL(toggled()))) next(Authorization);
            return;
        }
        if (phase == Authorization) {
            const bool saved = restart || exchangeReady(1, Save, {{"section", "features"}, {"diary_enabled", true}});
            auto *authorization = item("diaryAuthorizationNeeded", panel);
            if (!reveal(authorization) || !reveal(toggle) || !saved)
                return;
            if (!restart)
                require(boolean(receipts.at(1).toMap().value("diaryEnabled"), true), "SAVE_RECEIPT_VALUE");
            require(checked(toggle, view, true) && boolean(view.value("authorized"), false) &&
                    authorization->property("text").toString() == AuthorizationText, "AUTHORIZATION_DISPLAY");
            authorizedView = {{"checked", toggle->property("checked")}, {"enabled", view.value("enabled")},
                              {"authorized", view.value("authorized")}, {"authorizationText", AuthorizationText}};
            next(WriteDisabled);
            return;
        }

        auto *write = item("diaryWrite", panel);
        if (!reveal(write))
            return;
        require(write->property("text").toString() == WriteText && !write->isEnabled(), "WRITE_BLOCKED_DISPLAY");
        authorizedView.insert({{"writeText", WriteText}, {"writeEnabled", write->isEnabled()}, {"atMs", clock.elapsed()}});
        finish({});
    }

  public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool second, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), restart(second), scope(s->scopeKey()), generation(s->generation()),
          completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        archiveBefore = archiveSnapshot();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this,
            [this](const QString &id, const QString &command, const QString &requestScope, int gen) {
                if (!finished && commands.size() < NativeCheck::ObservationLimit)
                    commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", requestScope},
                                                {"generation", gen}, {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::diaryRequestDispatched, this, [this](const QString &id, const QVariantMap &fields) {
            if (finished || dispatchedFields.size() >= NativeCheck::ObservationLimit)
                return;
            // Only the two known request shapes may appear in a report.
            if (fields == QVariantMap{{"action", "list"}} ||
                (fields.keys() == QStringList{"diary_enabled", "section"} && fields.value("section") == "features" &&
                 fields.value("diary_enabled").metaType().id() == QMetaType::Bool))
                dispatchedFields.insert(id, fields);
        });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (finished || (command != List && command != Save) || receipts.size() >= NativeCheck::ObservationLimit)
                    return;
                QVariantMap receipt{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                                    {"generation", gen}, {"atMs", clock.elapsed()},
                                    {"ok", boolean(payload.value("ok"), true) && !payload.contains("error")}};
                if (command == List) {
                    const auto entries = payload.value("entries");
                    receipt["entryCount"] = entries.metaType().id() == QMetaType::QVariantList ? entries.toList().size() : -1;
                    receipt["writing"] = boolean(payload.value("writing"), true);
                    if (payload.value("writing").metaType().id() != QMetaType::Bool) receipt["ok"] = false;
                } else {
                    receipt["diaryEnabled"] = boolean(payload.value("features").toMap().value("diary_enabled"), true);
                }
                receipts.append(receipt);
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &id, const QString &, int gen) {
            if (!finished && gen == generation && std::any_of(commands.begin(), commands.end(), [&](const QVariant &row) {
                    return row.toMap().value("id") == id;
                }))
                requestFailed = true;
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

void DiaryCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                     std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
