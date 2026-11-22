#include "KeepsakeCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QHash>
#include <QJsonArray>
#include <QJsonDocument>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <utility>

namespace {
constexpr int DeadlineMs = 20000;
const QString Collect = "keepsake:collect";
const QString Page = "keepsake:page";
const QString Remove = "keepsake:remove";

QString sha256(const QString &text) {
    return QString::fromLatin1(QCryptographicHash::hash(text.toUtf8(), QCryptographicHash::Sha256).toHex());
}

bool boolean(const QVariant &value, bool expected) {
    return value.metaType().id() == QMetaType::Bool && value.toBool() == expected;
}

bool portalReady(const QQuickItem *item) {
    for (auto *parent = item; parent; parent = parent->parentItem()) {
        const auto ready = parent->property("inputReady");
        if (ready.isValid() && !ready.toBool()) return false;
    }
    return item != nullptr;
}

QVariantMap itemRect(const QQuickItem *item) {
    if (!item) return {};
    const auto point = item->mapToScene(QPointF(0, 0));
    return {{"x", item->x()}, {"y", item->y()}, {"width", item->width()}, {"height", item->height()},
            {"sceneX", point.x()}, {"sceneY", point.y()}};
}

QVariantMap itemMetadata(const QVariantMap &item) {
    const auto content = item.value("content").toString();
    return {{"id", item.value("id")}, {"messageId", item.value("message_id")},
            {"role", item.value("role")}, {"originalTime", item.value("original_message_at_utc")},
            {"contentSha256", sha256(content)}, {"characters", content.toUcs4().size()},
            {"contentOffset", item.value("content_offset")}, {"contentNextOffset", item.value("content_next_offset")},
            {"contentTotalChars", item.value("content_total_chars")}};
}

class Check final : public QObject {
    enum Phase { OpenHistory, SelectMessage, CollectMessage, VerifyCollected, Palette, Search, OpenPage,
                 ReadPage, RemoveEntry, ConfirmRemoval, VerifyEmpty, ReturnHistory, VerifyRemoved };

    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    const QString scope;
    const int generation;
    std::function<void(QVariantMap)> completion;
    QElapsedTimer clock;
    QTimer timer;
    Phase phase = OpenHistory;
    qint64 startedEpochMs = 0, phaseAt = 0, searchAt = -1;
    quint64 frame = 0, changedAfterFrame = 0, rowSampleFrame = 0;
    bool finished = false, polling = false, failedRequest = false, overflow = false;
    int chatSendDispatches = 0;
    QString messageId, keepsakeId;
    QVariantList inputs, commands, receipts, historyBefore;
    QHash<QString, QVariantMap> fields;
    QVariantMap selected, rowBefore, rowAfter, rowSample, listView, emptyView, removalDialog, lastObservation;
    int filesBefore = -1;
    SummaryInteractionProbe::StableGate inputReady;

    void require(bool valid, const QString &reason) const {
        NativeCheck::require(valid, "KEEPSAKE_" + reason,
            {{"phase", int(phase)}, {"elapsedMs", clock.elapsed()}, {"messageId", messageId},
             {"commands", commands.size()}, {"receipts", receipts.size()}});
    }

    QQuickItem *item(const QString &name) const {
        return NativeCheck::findVisual(window->contentItem(), name, true).item;
    }

    QVariantList history() const {
        QVariantList result;
        for (const auto &value : session->messages()) {
            const auto message = value.toMap();
            result.append(QVariantMap{{"id", message.value("id")}, {"role", message.value("role")},
                {"contentSha256", sha256(message.value("content").toString())},
                {"originalTime", message.value("created_at_utc")}});
        }
        return result;
    }

    int keepsakeFiles() const {
        const auto root = session->dataRoot();
        require(QDir(root).exists("data"), "ISOLATION_MISSING");
        QDirIterator entries(root, QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System,
                             QDirIterator::Subdirectories);
        int count = 0;
        while (entries.hasNext()) {
            entries.next();
            const auto info = entries.fileInfo();
            if (info.fileName() == "keepsakes.json") ++count;
        }
        return count;
    }

    void next(Phase value) {
        phase = value;
        phaseAt = clock.elapsed();
        inputReady.reset();
        rowSample.clear();
    }

    bool reveal(QQuickItem *target) {
        const bool ready = portalReady(target);
        const auto result = ready
            ? NativeControlReadiness::revealWholeItem(target, [this] { return clock.elapsed(); }, DeadlineMs)
            : QVariantMap{};
        const auto visibility = NativeControlReadiness::wholeVisibility(target, window);
        lastObservation.insert({{"portalReady", ready}, {"reveal", NativeControlReadiness::revealSummary(result)},
                                {"visibility", visibility}});
        return ready && !result.value("expired").toBool() && visibility.value("fullyVisible").toBool();
    }

    bool click(const QString &name, bool captureRow = false) {
        auto *target = item(name);
        const bool shown = reveal(target);
        auto sample = SummaryInteractionProbe::inspect(target, window, portalReady(target), scope);
        sample.eligible = sample.eligible && shown;
        const auto stable = inputReady.observe(sample, clock.elapsed(), frame);
        lastObservation.insert({{"control", name}, {"layout", stable}});
        if (!stable.value("ready").toBool()) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, sample.point, target);
        lastObservation["hitAccepted"] = hit.accepted();
        require(hit.accepted(), "INPUT_HIT");
        QSignalSpy spy(target, SIGNAL(clicked()));
        require(spy.isValid(), "INPUT_SIGNAL");
        if (captureRow) rowBefore = rowView();
        const auto at = clock.elapsed();
        require(at < DeadlineMs, "DEADLINE");
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, sample.point, 0);
        inputs.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
                                  {"clickedSignals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }

    QVariantMap rowView() const {
        auto *row = item("chatMessageRow-" + messageId);
        auto *text = item("chatMessage-" + messageId);
        auto *button = item("keepsakeMessage-" + messageId);
        auto *box = text && text->parentItem() ? text->parentItem()->parentItem() : nullptr;
        require(row && text && button && box, "ROW_MISSING");
        return {{"atMs", clock.elapsed()}, {"label", button->property("text")}, {"enabled", button->isEnabled()},
                {"contentSha256", sha256(text->property("text").toString())},
                {"row", itemRect(row)}, {"box", itemRect(box)}, {"text", itemRect(text)}};
    }

    bool stableRow(const QString &label, bool enabled, QVariantMap &result) {
        auto *button = item("keepsakeMessage-" + messageId);
        if (!button || button->property("text") != label || button->isEnabled() != enabled) return false;
        auto sample = rowView();
        sample.remove("atMs");
        const bool stable = sample == rowSample && frame > rowSampleFrame;
        lastObservation.insert({{"rowStable", stable}, {"row", sample}});
        rowSample = sample;
        rowSampleFrame = frame;
        if (!stable) {
            window->update();
            return false;
        }
        result = sample;
        result["atMs"] = clock.elapsed();
        return true;
    }

    void selectMessage() {
        const auto messages = session->messages();
        for (auto index = messages.size(); index > 0; --index) {
            const auto message = messages.at(index - 1).toMap();
            const auto id = message.value("id").toString();
            const auto content = message.value("content").toString();
            if (message.value("role") != "user" || content.isEmpty() || !item("keepsakeMessage-" + id)) continue;
            messageId = id;
            selected = {{"messageId", id}, {"role", "user"}, {"originalTime", message.value("created_at_utc")},
                        {"contentSha256", sha256(content)}, {"characters", content.toUcs4().size()}};
            return;
        }
    }

    bool completeWrite(const QString &command) const {
        int sent = 0;
        for (const auto &value : commands) if (value.toMap().value("command") == command) ++sent;
        require(sent <= 1, "REPEATED_WRITE");
        if (!sent) return false;
        for (const auto &value : receipts) {
            const auto receipt = value.toMap();
            if (receipt.value("command") == command && boolean(receipt.value("ok"), true)) return true;
        }
        return false;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        int filesAfter = -1;
        const auto after = history();
        if (error.isEmpty()) {
            try {
                filesAfter = keepsakeFiles();
                require(filesBefore == 0 && filesAfter == 0, "PLAINTEXT_FILE");
                require(after == historyBefore && !historyBefore.isEmpty(), "HISTORY_CHANGED");
                require(chatSendDispatches == 0 && !overflow && !failedRequest, "TRAFFIC");
                require(clock.elapsed() < DeadlineMs, "DEADLINE");
                for (const auto &key : {"row", "box", "text", "contentSha256"})
                    require(rowBefore.value(key) == rowAfter.value(key), "ROW_GEOMETRY_CHANGED");
            } catch (const std::exception &failure) {
                error = QString::fromUtf8(failure.what());
            }
        }
        for (auto &value : commands) {
            auto command = value.toMap();
            command["fields"] = fields.value(command.value("id").toString());
            value = command;
        }
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1},
            {"deadlineMs", DeadlineMs}, {"elapsedMs", clock.elapsed()}, {"tailStartEpochMs", startedEpochMs},
            {"tailEndEpochMs", QDateTime::currentMSecsSinceEpoch()}, {"scopeBefore", scope},
            {"scopeAfter", session->scopeKey()}, {"generationBefore", generation}, {"generationAfter", session->generation()},
            {"inputs", inputs}, {"searchAtMs", searchAt}, {"commands", commands}, {"receipts", receipts},
            {"chatSendDispatches", chatSendDispatches}, {"historyBefore", historyBefore}, {"historyAfter", after},
            {"keepsakeFilesBefore", filesBefore}, {"keepsakeFilesAfter", filesAfter}, {"selected", selected},
            {"rowBefore", rowBefore}, {"rowAfter", rowAfter}, {"listView", listView}, {"emptyView", emptyView},
            {"removalDialog", removalDialog}, {"lastObservation", lastObservation}});
        deleteLater();
    }

    void tick() {
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        lastObservation = {{"phase", int(phase)}, {"phaseElapsedMs", clock.elapsed() - phaseAt},
            {"viewportWidth", window->width()}, {"viewportHeight", window->height()}, {"frame", QVariant::fromValue(frame)}};
        require(session->connected() && session->runtimeWritable() && !session->busy() &&
                session->scopeKey() == scope && session->generation() == generation, "SCOPE");
        require(!failedRequest && !overflow && chatSendDispatches == 0, "TRAFFIC");
        require(history() == historyBefore, "HISTORY_CHANGED");
        switch (phase) {
        case OpenHistory:
            if (click("nav-reading")) next(SelectMessage);
            return;
        case SelectMessage: {
            auto *chat = item("persistentChat");
            if (!chat || !chat->property("inputReady").toBool() || !chat->property("expandedHistory").toBool()) return;
            if (messageId.isEmpty()) selectMessage();
            if (messageId.isEmpty()) return;
            auto *button = item("keepsakeMessage-" + messageId);
            if (!reveal(button)) return;
            if (restart) {
                if (button->property("text") != "已收藏") return;
                require(!button->isEnabled(), "ALREADY_COLLECTED_ENABLED");
                if (!stableRow("已收藏", false, rowBefore)) return;
                next(Palette);
            } else {
                require(button->property("text") == "收藏", "INITIAL_BUTTON");
                if (button->isEnabled()) next(CollectMessage);
            }
            return;
        }
        case CollectMessage:
            if (click("keepsakeMessage-" + messageId, true)) {
                changedAfterFrame = frame;
                next(VerifyCollected);
            }
            return;
        case VerifyCollected: {
            auto *button = item("keepsakeMessage-" + messageId);
            if (!completeWrite(Collect) || !button || button->property("text") != "已收藏" || frame <= changedAfterFrame) return;
            require(!button->isEnabled(), "COLLECTED_BUTTON");
            if (!stableRow("已收藏", false, rowAfter)) return;
            next(Palette);
            return;
        }
        case Palette:
            if (click("scene-navigation-search")) next(Search);
            return;
        case Search: {
            auto *search = item("scene-search");
            if (!reveal(search) || !search->hasActiveFocus()) return;
            require(search->property("text").toString().isEmpty(), "SEARCH_INITIAL");
            searchAt = clock.elapsed();
            for (const char letter : QByteArray("keepsake")) QTest::keyClick(window, Qt::Key(Qt::Key_A + letter - 'a'));
            require(search->property("text") == "keepsake", "SEARCH_TEXT");
            next(OpenPage);
            return;
        }
        case OpenPage:
            if (click("search-result-keepsake-list")) next(ReadPage);
            return;
        case ReadPage: {
            const auto view = session->keepsakeView();
            if (view.value("listStatus") != "ready") return;
            const auto entries = view.value("entries").toList();
            require(entries.size() == 1, "LIST_COUNT");
            const auto entry = entries.first().toMap();
            keepsakeId = entry.value("id").toString();
            const auto metadata = itemMetadata(entry);
            require(!keepsakeId.isEmpty() && metadata.value("messageId") == messageId &&
                    metadata.value("contentSha256") == selected.value("contentSha256") &&
                    metadata.value("role") == selected.value("role") &&
                    metadata.value("originalTime") == selected.value("originalTime"), "LIST_IDENTITY");
            auto *body = item("keepsakeContent-" + keepsakeId);
            auto *remove = item("keepsakeRemove-" + keepsakeId);
            if (!body || !reveal(remove)) return;
            require(sha256(body->property("text").toString()) == selected.value("contentSha256"), "LIST_CONTENT");
            listView = {{"atMs", clock.elapsed()}, {"count", entries.size()}, {"item", metadata},
                        {"displayedContentSha256", sha256(body->property("text").toString())},
                        {"removeEnabled", remove->isEnabled()}};
            if (restart) next(RemoveEntry);
            else finish({});
            return;
        }
        case RemoveEntry:
            if (click("keepsakeRemove-" + keepsakeId)) next(ConfirmRemoval);
            return;
        case ConfirmRemoval: {
            auto *dialog = window->findChild<QObject *>("keepsakeRemoveDialog");
            auto *warning = item("keepsakeRemoveWarning");
            auto *cancel = item("keepsakeRemoveCancel");
            auto *confirm = item("keepsakeRemoveConfirm");
            if (!dialog || !warning || !cancel || !confirm || !reveal(confirm)) return;
            require(warning->property("text") == "移除后不能恢复" &&
                    cancel->property("text") == "取消" && confirm->property("text") == "移除", "REMOVAL_DIALOG");
            removalDialog = {{"atMs", clock.elapsed()}, {"cancelLabel", cancel->property("text")},
                             {"confirmLabel", confirm->property("text")}, {"warning", warning->property("text")},
                             {"visible", dialog->property("visible")}};
            if (click("keepsakeRemoveConfirm")) next(VerifyEmpty);
            return;
        }
        case VerifyEmpty: {
            if (!completeWrite(Remove)) return;
            const auto view = session->keepsakeView();
            if (view.value("listStatus") != "ready" || !view.value("entries").toList().isEmpty()) return;
            auto *empty = item("keepsakeEmpty");
            if (!reveal(empty)) return;
            require(empty->property("text") == "在完整聊天历史里点『收藏』，喜欢的话会留在这里。", "EMPTY_TEXT");
            emptyView = {{"atMs", clock.elapsed()}, {"count", 0}, {"visible", true}};
            next(ReturnHistory);
            return;
        }
        case ReturnHistory:
            if (click("nav-reading")) {
                changedAfterFrame = frame;
                next(VerifyRemoved);
            }
            return;
        case VerifyRemoved: {
            auto *button = item("keepsakeMessage-" + messageId);
            if (!button || !reveal(button) || frame <= changedAfterFrame) return;
            if (button->property("text") != "收藏" || !button->isEnabled()) return;
            if (!stableRow("收藏", true, rowAfter)) return;
            finish({});
            return;
        }
        }
    }

public:
    Check(QQuickWindow *w, RuntimeBridge *s, bool second, std::function<void(QVariantMap)> done)
        : QObject(w), window(w), session(s), restart(second), scope(s->scopeKey()), generation(s->generation()),
          completion(std::move(done)) {
        clock.start();
        startedEpochMs = QDateTime::currentMSecsSinceEpoch();
        historyBefore = history();
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frame; }, Qt::QueuedConnection);
        connect(s, &RuntimeBridge::commandSent, this,
            [this](const QString &id, const QString &command, const QString &requestScope, int gen) {
                if (finished) return;
                if (command == "chat:send") ++chatSendDispatches;
                if (commands.size() >= 16) { overflow = true; return; }
                commands.append(QVariantMap{{"id", id}, {"command", command}, {"scope", requestScope},
                                             {"generation", gen}, {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::keepsakeRequestDispatched, this, [this](const QString &id, const QVariantMap &payload) {
            if (!finished && fields.size() < 16) fields.insert(id, payload);
        });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &payload, int gen) {
                if (finished) return;
                if (receipts.size() >= 16) { overflow = true; return; }
                QVariantMap receipt{{"id", id}, {"command", command}, {"scope", session->scopeKey()},
                    {"generation", gen}, {"atMs", clock.elapsed()}, {"ok", boolean(payload.value("ok"), true)},
                    {"operation", payload.value("operation")}};
                if (command == Page) {
                    QVariantList items;
                    for (const auto &entry : payload.value("items").toList()) items.append(itemMetadata(entry.toMap()));
                    receipt.insert({{"mode", payload.value("mode")}, {"items", items},
                        {"total", payload.value("total")}, {"hasMore", payload.value("has_more")}});
                } else if (command == Collect) {
                    receipt.insert({{"item", itemMetadata(payload.value("item").toMap())}, {"created", payload.value("created")}});
                } else if (command == Remove) {
                    receipt.insert({{"keepsakeId", payload.value("keepsake_id")}, {"messageId", payload.value("message_id")},
                                    {"removed", payload.value("removed")}});
                }
                receipts.append(receipt);
            });
        connect(s, &RuntimeBridge::requestFailed, this, [this](const QString &, const QString &, int gen) {
            if (!finished && gen == generation) failedRequest = true;
        });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
            polling = true;
            try {
                if (filesBefore < 0) filesBefore = keepsakeFiles();
                tick();
            } catch (const std::exception &failure) {
                finish(QString::fromUtf8(failure.what()));
            }
            polling = false;
        });
        timer.start(40);
    }
};
}

void KeepsakeCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                        std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
