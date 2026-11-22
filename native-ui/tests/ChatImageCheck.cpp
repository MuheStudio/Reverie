#include "ChatImageCheck.h"
#include "CheckContract.h"
#include "SummaryInteractionProbe.h"
#include "../src/RuntimeBridge.h"

#include <QCryptographicHash>
#include <QDateTime>
#include <QDir>
#include <QDirIterator>
#include <QElapsedTimer>
#include <QFile>
#include <QFileInfo>
#include <QImageReader>
#include <QJSValue>
#include <QQmlEngine>
#include <QSignalSpy>
#include <QTest>
#include <QTimer>
#include <QUrl>
#include <utility>

namespace {
constexpr int DeadlineMs = 15000;
const QString Choose = "chatImageChoose";
const QString Preview = "chatImagePreview";
const QString Disclosure = "chatImageDisclosure";
const QString Remove = "chatImageRemove";
const QString DisclosureText = "图片会发送给当前的模型服务。";
const QString Fixture = "native-ui/tests/fixtures/chat-image.png";

QString sha256(const QByteArray &value) {
    return QString::fromLatin1(QCryptographicHash::hash(value, QCryptographicHash::Sha256).toHex());
}

bool isImage(const QString &suffix, const QByteArray &prefix) {
    return QStringList{"png", "jpg", "jpeg", "webp", "gif"}.contains(suffix.toLower()) ||
        prefix.startsWith(QByteArray::fromHex("89504e470d0a1a0a")) ||
        prefix.startsWith(QByteArray::fromHex("ffd8ff")) ||
        prefix.startsWith("GIF87a") || prefix.startsWith("GIF89a") ||
        (prefix.startsWith("RIFF") && prefix.mid(8, 4) == "WEBP");
}

QVariantMap imageInventory(const QString &rootPath) {
    const QDir root(rootPath);
    NativeCheck::require(root.exists() && root.exists("data"), "CHAT_IMAGE_ISOLATION_MISSING", {});
    QDirIterator files(rootPath, QDir::AllEntries | QDir::NoDotAndDotDot | QDir::Hidden | QDir::System,
                       QDirIterator::Subdirectories);
    QMap<QString, QString> avatars;
    int runtimeImages = 0, otherImages = 0;
    while (files.hasNext()) {
        const auto path = files.next();
        const QFileInfo info = files.fileInfo();
        NativeCheck::require(!info.isSymLink(), "CHAT_IMAGE_ISOLATION_SCAN", {});
        if (info.isDir()) continue;
        QFile file(path);
        NativeCheck::require(info.isFile() && file.open(QIODevice::ReadOnly), "CHAT_IMAGE_ISOLATION_SCAN", {});
        if (!isImage(info.suffix(), file.peek(12))) continue;
        const auto relative = root.relativeFilePath(path);
        if (relative.startsWith("avatars/")) {
            QCryptographicHash hash(QCryptographicHash::Sha256);
            NativeCheck::require(hash.addData(&file), "CHAT_IMAGE_ISOLATION_SCAN", {});
            avatars.insert(relative, QString::fromLatin1(hash.result().toHex()));
        } else if (relative.startsWith("data/")) {
            ++runtimeImages;
        } else {
            ++otherImages;
        }
    }
    // Names distinguish existing files with identical bytes, but only the
    // digest of that inventory leaves the driver.
    QCryptographicHash inventory(QCryptographicHash::Sha256);
    for (auto it = avatars.cbegin(); it != avatars.cend(); ++it) {
        inventory.addData(it.key().toUtf8());
        inventory.addData(QByteArrayView("\0", 1));
        inventory.addData(it.value().toLatin1());
    }
    return {{"runtimeImages", runtimeImages}, {"otherImages", otherImages},
            {"avatarImages", avatars.size()}, {"avatarInventorySha256", QString::fromLatin1(inventory.result().toHex())}};
}

class Check final : public QObject {
    enum Phase { ReturnToChat, Initial, ChooseImage, VerifyPreview, RemoveImage, VerifyRemoval };

    QQuickWindow *window;
    RuntimeBridge *session;
    const bool restart;
    const QString scope;
    const int generation;
    std::function<void(QVariantMap)> completion;
    QTimer timer;
    QElapsedTimer clock;
    Phase phase = ReturnToChat;
    qint64 startedEpochMs = 0, handoffAt = -1;
    quint64 frame = 0;
    bool polling = false, finished = false, overrideInstalled = false;
    int sendDispatches = 0;
    QPointer<QQuickItem> panel;
    QVariantList inputs, historyBefore, commands, receipts;
    QVariantMap fixture, filesBefore, initial, withPreview, final, lastObservation;
    QUrl fixtureUrl;
    SummaryInteractionProbe::StableGate ready;

    QQuickItem *item(const QString &name, QQuickItem *root = nullptr) const {
        return NativeCheck::findVisual(root ? root : window->contentItem(), name, true).item;
    }

    void require(bool valid, const QString &reason) const {
        NativeCheck::require(valid, "CHAT_IMAGE_" + reason,
            {{"phase", int(phase)}, {"elapsedMs", clock.elapsed()}, {"chatSendDispatches", sendDispatches}});
    }

    QVariantList history() const {
        QVariantList ids;
        for (const auto &entry : session->messages()) ids.append(entry.toMap().value("id").toString());
        return ids;
    }

    void next(Phase step) {
        phase = step;
        ready.reset();
    }

    bool click(const QString &name, QQuickItem *target) {
        const auto observation = SummaryInteractionProbe::inspect(target, window, true, scope);
        const auto layout = ready.observe(observation, clock.elapsed(), frame);
        lastObservation.insert({{"control", name}, {"geometry", layout}});
        if (!layout.value("ready").toBool()) {
            window->update();
            return false;
        }
        const auto hit = NativeCheck::hitTest(window, observation.point, target);
        lastObservation["hitAccepted"] = hit.accepted();
        require(hit.accepted(), "INPUT_HIT");
        QSignalSpy spy(target, SIGNAL(clicked()));
        require(spy.isValid(), "INPUT_SIGNAL");
        const auto at = clock.elapsed();
        require(at < DeadlineMs, "DEADLINE");
        QTest::mouseClick(window, Qt::LeftButton, Qt::NoModifier, observation.point, 0);
        inputs.append(QVariantMap{{"control", name}, {"atMs", at}, {"mouseDispatchCount", 1},
                                  {"clickedSignals", spy.count()}, {"hitAccepted", hit.accepted()}});
        require(spy.count() == 1, "INPUT_COUNT");
        return true;
    }

    void prepareFixture() {
        const QFileInfo info(QDir(session->projectRoot()).filePath(Fixture));
        require(info.isFile() && !info.isSymLink() && info.size() > 0 && info.size() <= 4096, "FIXTURE");
        const auto path = info.canonicalFilePath();
        require(!path.isEmpty(), "FIXTURE");
        QFile file(path);
        require(file.open(QIODevice::ReadOnly), "FIXTURE");
        const auto bytes = file.readAll();
        QImageReader reader(path);
        const auto size = reader.size();
        require(reader.format() == "png" && size == QSize(24, 16), "FIXTURE");
        fixture = {{"sha256", sha256(bytes)}, {"width", size.width()}, {"height", size.height()}, {"bytes", bytes.size()}};
        fixtureUrl = QUrl::fromLocalFile(path);
        auto *engine = qmlEngine(panel.data());
        require(engine != nullptr, "PICKER");
        const auto suppressDialog = engine->evaluate("(function () {})");
        require(suppressDialog.isCallable() && panel->setProperty("imagePickerOverride", QVariant::fromValue(suppressDialog)),
                "PICKER");
        overrideInstalled = true;
    }

    bool observe(QVariantMap &view, bool staged) {
        auto *composer = item("chatComposer", panel);
        auto *send = item("sendChat", panel);
        auto *chooser = item(Choose, panel);
        if (!composer || !send || !chooser) return false;
        const auto *preview = item(Preview, panel);
        const auto *disclosure = item(Disclosure, panel);
        const auto *remove = item(Remove, panel);
        const bool bridgePreview = !session->property("chatImagePreview").toUrl().isEmpty();
        const bool previewVisible = NativeControlReadiness::wholeVisibility(preview, window).value("fullyVisible").toBool();
        const bool disclosureVisible = NativeControlReadiness::wholeVisibility(disclosure, window).value("fullyVisible").toBool();
        const bool removeVisible = NativeControlReadiness::wholeVisibility(remove, window).value("fullyVisible").toBool();
        const bool sendVisible = NativeControlReadiness::wholeVisibility(send, window).value("fullyVisible").toBool();
        const bool previewReady = preview && preview->property("status").toInt() == 1;
        const auto text = composer->property("text").toString();
        const auto disclosureText = disclosure ? disclosure->property("text").toString() : QString();
        lastObservation.insert({{"bridgePreview", bridgePreview}, {"previewVisible", previewVisible},
            {"previewReady", previewReady}, {"disclosureVisible", disclosureVisible}, {"removeVisible", removeVisible},
            {"sendVisible", sendVisible}, {"sendEnabled", send->isEnabled()}, {"chooserEnabled", chooser->isEnabled()}});
        if (staged) {
            require(session->property("chatImageFeedback").toString().isEmpty(), "PREVIEW_FEEDBACK");
            if (!bridgePreview || !previewVisible || !previewReady || !disclosureVisible || !removeVisible ||
                !sendVisible || !send->isEnabled())
                return false;
            require(disclosureText == DisclosureText, "DISCLOSURE");
        } else if (bridgePreview || preview || disclosure || remove) {
            return false;
        }
        if (!sendVisible) return false;
        require(chooser->isEnabled() && composer->isEnabled() && text == session->draft(), "COMPOSER");
        view = {{"atMs", clock.elapsed()}, {"previewVisible", previewVisible}, {"previewReady", previewReady},
                {"disclosure", disclosureText}, {"removeVisible", removeVisible}, {"sendVisible", sendVisible},
                {"sendEnabled", send->isEnabled()},
                {"composerEnabled", composer->isEnabled()}, {"draftEmpty", text.trimmed().isEmpty()},
                {"draftSha256", sha256(text.toUtf8())}};
        return true;
    }

    void finish(QString error) {
        finished = true;
        timer.stop();
        if (overrideInstalled && panel)
            panel->setProperty("imagePickerOverride", QVariant::fromValue(QJSValue(QJSValue::NullValue)));
        const auto after = history();
        QVariantMap filesAfter;
        if (error.isEmpty()) {
            try {
                filesAfter = imageInventory(session->dataRoot());
                require(filesAfter == filesBefore, "ISOLATION_CHANGED");
                require(after == historyBefore, "HISTORY_CHANGED");
                require(sendDispatches == 0, "SEND_DISPATCH");
                require(clock.elapsed() < DeadlineMs, "DEADLINE");
            } catch (const std::exception &failure) {
                error = QString::fromUtf8(failure.what());
            }
        }
        auto done = std::move(completion);
        done({{"passed", error.isEmpty()}, {"error", error}, {"cycle", restart ? 2 : 1}, {"deadlineMs", DeadlineMs},
              {"elapsedMs", clock.elapsed()}, {"tailStartEpochMs", startedEpochMs},
              {"tailEndEpochMs", QDateTime::currentMSecsSinceEpoch()}, {"scopeBefore", scope},
              {"scopeAfter", session->scopeKey()}, {"generationBefore", generation}, {"generationAfter", session->generation()},
              {"inputs", inputs}, {"selectionAtMs", handoffAt}, {"fixture", fixture}, {"chatSendDispatches", sendDispatches},
              {"commands", commands}, {"receipts", receipts},
              {"historyBefore", historyBefore}, {"historyAfter", after}, {"filesBefore", filesBefore}, {"filesAfter", filesAfter},
              {"initial", initial}, {"withPreview", withPreview}, {"final", final}, {"lastObservation", lastObservation}});
        deleteLater();
    }

    void tick() {
        require(clock.elapsed() < DeadlineMs, "DEADLINE");
        lastObservation = {{"phase", int(phase)}};
        require(session->connected() && session->runtimeWritable() && !session->busy() &&
                session->scopeKey() == scope && session->generation() == generation, "SCOPE");
        require(sendDispatches == 0, "SEND_DISPATCH");
        require(history() == historyBefore, "HISTORY_CHANGED");
        if (phase == ReturnToChat) {
            if (click("nav-chat", item("nav-chat"))) next(Initial);
            return;
        }
        panel = item("persistentChat");
        const bool chatReady = panel && panel->property("inputReady").toBool();
        lastObservation.insert({{"chatFound", !panel.isNull()}, {"chatReady", chatReady}});
        if (!chatReady) return;
        switch (phase) {
        case ReturnToChat:
            return;
        case Initial:
            if (!observe(initial, false)) return;
            require(initial.value("sendEnabled").toBool() != initial.value("draftEmpty").toBool(), "INITIAL_DRAFT");
            if (restart) {
                final = initial;
                finish({});
            } else {
                prepareFixture();
                next(ChooseImage);
            }
            return;
        case ChooseImage: {
            if (!click(Choose, item(Choose, panel))) return;
            handoffAt = clock.elapsed();
            QVariant accepted;
            require(QMetaObject::invokeMethod(panel.data(), "applyChatImage", Q_RETURN_ARG(QVariant, accepted),
                                             Q_ARG(QVariant, QVariant::fromValue(fixtureUrl))) &&
                    accepted.metaType().id() == QMetaType::Bool && accepted.toBool(), "SELECTION_HANDOFF");
            next(VerifyPreview);
            return;
        }
        case VerifyPreview:
            if (!observe(withPreview, true)) return;
            require(withPreview.value("draftSha256") == initial.value("draftSha256"), "PREVIEW_CHANGED_DRAFT");
            next(RemoveImage);
            return;
        case RemoveImage:
            if (click(Remove, item(Remove, panel))) next(VerifyRemoval);
            return;
        case VerifyRemoval:
            if (!observe(final, false)) return;
            require(final.value("draftSha256") == initial.value("draftSha256") &&
                    final.value("sendEnabled") == initial.value("sendEnabled"), "COMPOSER_NOT_RESTORED");
            finish({});
            return;
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
            [this](const QString &id, const QString &command, const QString &, int generation) {
                if (finished) return;
                if (command == "chat:send") ++sendDispatches;
                if (commands.size() < NativeCheck::ObservationLimit)
                    commands.append(QVariantMap{{"id", id}, {"command", command}, {"generation", generation},
                                                 {"atMs", clock.elapsed()}});
            });
        connect(s, &RuntimeBridge::responseReceived, this,
            [this](const QString &id, const QString &command, const QVariantMap &, int generation) {
                if (!finished && receipts.size() < NativeCheck::ObservationLimit)
                    receipts.append(QVariantMap{{"id", id}, {"command", command}, {"generation", generation},
                                                 {"atMs", clock.elapsed()}});
            });
        connect(&timer, &QTimer::timeout, this, [this] {
            if (polling || finished) return;
            polling = true;
            try {
                if (filesBefore.isEmpty()) {
                    filesBefore = imageInventory(session->dataRoot());
                    require(filesBefore.value("runtimeImages").toInt() == 0 &&
                            filesBefore.value("otherImages").toInt() == 0, "ISOLATION_IMAGES");
                }
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

void ChatImageCheck::run(QQuickWindow *window, RuntimeBridge *session, bool restart,
                         std::function<void(QVariantMap)> done) {
    new Check(window, session, restart, std::move(done));
}
