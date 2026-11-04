#include "MemoryPageCheck.h"
#include "MemoryBatchDeleteCheck.h"
#include "../src/RuntimeBridge.h"
#include "ControlReadiness.h"
#include "CandidateHeaderProbe.h"
#include <QElapsedTimer>
#include <QInputMethodEvent>
#include <QQuickItem>
#include <QQuickWindow>
#include <QSet>
#include <QTest>
#include <QTimer>

namespace {
// The bootstrap confirms memories 1..130 in order, each strictly later than the
// one before, so the newest-first list is known before the run.
constexpr int seededCount = 130;
constexpr int editedNumber = 106;
const QString marker = "星图标记";
const QString editedText = "隔离记忆第106条：星图标记·已改";
const QString rejectedCandidate = "隔离候选：待拒绝的星图";

bool marked(int number) { return number % 11 == 7; }

QQuickItem *find(QQuickItem *root, const QString &name) {
    if (root->objectName() == name && root->isVisible())
        return root;
    for (auto *c : root->childItems())
        if (auto *f = find(c, name))
            return f;
    return nullptr;
}
QQuickItem *named(QQuickItem *root, const QString &name) {
    if (auto *visible = find(root, name))
        return visible;
    if (root->objectName() == name)
        return root;
    for (auto *c : root->childItems())
        if (auto *f = named(c, name))
            return f;
    return nullptr;
}
QStringList seeded(bool edited, bool markedOnly, bool afterBatchDelete = false) {
    QStringList texts;
    if (edited)
        texts << editedText;
    for (int n = seededCount; n >= 1; --n)
        if ((!edited || n != editedNumber) && (!markedOnly || marked(n)) &&
            (!afterBatchDelete || (n != 130 && n != 129 && n != 127)))
            texts << MemoryPageCheck::seededText(n);
    return texts;
}
class Check final : public QObject {
  public:
    QQuickWindow *w;
    RuntimeBridge *s;
    bool verifyOnly;
    bool keepOpen;
    bool afterBatchDelete;
    QString capturePrefix;
    std::function<void(QVariantMap)> done;
    QTimer timer;
    QElapsedTimer clock;
    int step = 0;
    qint64 at = 0;
    quint64 frameSerial = 0;
    bool executing = false;
    QString listRequest, candidateId, editedFromId;
    QVariantList cases, readiness, reveals;
    QVariantMap observed;
    CandidateHeaderProbe::StableRead headerStable;
    QVariantList candidateReadReceipts;
    QString headerReadBaseline, ownerScope;
    int ownerGeneration = -1;
    NativeControlReadiness::OnceGate gate;
    Check(QQuickWindow *window, RuntimeBridge *session, bool verify, QString prefix,
          std::function<void(QVariantMap)> callback, bool keep, bool batchDelete)
        : QObject(window), w(window), s(session), verifyOnly(verify), keepOpen(keep), afterBatchDelete(verify && batchDelete), capturePrefix(std::move(prefix)),
          done(std::move(callback)) {
        clock.start();
        ownerScope = s->scopeKey(); ownerGeneration = s->generation();
        connect(s, &RuntimeBridge::responseReceived, this, [this](const QString &id, const QString &command, const QVariantMap &payload, int generation) {
            if (command != "memory:candidates:list" || generation != ownerGeneration || s->scopeKey() != ownerScope) return;
            if (candidateReadReceipts.size() >= 24) { finish(false, "MEMORY_PAGE_CANDIDATE_RECEIPT_BOUND"); return; }
            candidateReadReceipts.append(QVariantMap{{"requestId", id}, {"command", command},
                {"scope", ownerScope}, {"generation", generation}, {"ok", payload.value("ok")},
                {"rowCount", payload.value("candidates").toList().size()}, {"observedStep", step}, {"elapsedMs", clock.elapsed()}});
            observed["candidateReadReceipts"] = candidateReadReceipts;
        });
        connect(w, &QQuickWindow::frameSwapped, this, [this] { ++frameSerial; }, Qt::QueuedConnection);
        timer.setInterval(40);
        connect(&timer, &QTimer::timeout, this, [this] {
            if (executing)
                return;
            executing = true;
            try {
                tick();
            } catch (const std::exception &ex) {
                finish(false, ex.what());
            }
            executing = false;
        });
        timer.start();
    }
    void next(int target) {
        step = target;
        at = clock.elapsed();
        headerStable.reset();
    }
    void require(bool value, const QString &message) {
        if (!value)
            throw std::runtime_error(message.toStdString());
    }
    void click(const QString &name) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "MEMORY_PAGE_CONTROL_UNAVAILABLE:" + name);
        auto p = i->mapToScene(QPointF(i->width() / 2, i->height() / 2));
        QTest::mouseClick(w, Qt::LeftButton, Qt::NoModifier, p.toPoint(), 0);
    }
    void type(const QString &name, const QString &text) {
        auto *i = find(w->contentItem(), name);
        require(i && i->isEnabled(), "MEMORY_PAGE_EDITOR_UNAVAILABLE:" + name);
        i->forceActiveFocus();
        QMetaObject::invokeMethod(i, "selectAll");
        QInputMethodEvent commit;
        commit.setCommitString(text);
        QCoreApplication::sendEvent(w, &commit);
        require(i->property("text").toString() == text, "MEMORY_PAGE_INPUT_NOT_COMMITTED:" + name);
    }
    bool opened() const {
        auto *i = find(w->contentItem(), "drawer-memory");
        return i && i->property("inputReady").toBool();
    }
    bool closed() const {
        auto *i = named(w->contentItem(), "drawer-memory");
        return !i || i->property("progress").toDouble() == 0;
    }
    bool surfacesClosed() const {
        for (const auto &name : {"drawer-memory", "drawer-settings", "taskSurface"}) {
            auto *i = named(w->contentItem(), name);
            if (i && i->property("progress").toDouble() > 0)
                return false;
        }
        return true;
    }
    QVariantMap receipt(const QString &key) const { return s->memoryFeedback().value(key).toMap(); }
    QVariantMap list() const { return s->state().value("memory").toMap(); }
    QVariantList memories() const { return list().value("memories").toList(); }
    QVariantList candidates() const { return s->state().value("candidates").toMap().value("candidates").toList(); }
    QStringList texts() const {
        QStringList out;
        for (const auto &value : memories())
            out << value.toMap().value("text").toString();
        return out;
    }
    QStringList ids() const {
        QStringList out;
        for (const auto &value : memories())
            out << value.toMap().value("id").toString();
        return out;
    }
    bool settled() const {
        return receipt("list").value("status") != "pending" && receipt("candidates").value("status") != "pending" &&
               receipt("action").value("status") != "pending";
    }
    QString shownText(const QString &name) const {
        auto *i = find(w->contentItem(), name);
        return i ? i->property("text").toString() : QString();
    }
    // The list as shown: exact rows, no repeated ID, the receipt and its text on the page.
    void requireList(const QStringList &expected, bool hasMore, const QString &query, const QString &text,
                     const QString &code) {
        require(receipt("list").value("status") == "success", code + "_NOT_READ:" + receipt("list").value("text").toString());
        const auto shown = texts();
        observed[code.toLower() + "Count"] = shown.size();
        require(shown == expected, code + "_ROWS_UNEXPECTED");
        const auto shownIds = ids();
        require(QSet<QString>(shownIds.begin(), shownIds.end()).size() == shown.size(), code + "_REPEATED_ID");
        require(list().value("hasMore").toBool() == hasMore && list().value("query").toString() == query &&
                    s->memoryQuery() == query && !list().value("capped").toBool(),
                code + "_STATE_UNEXPECTED");
        require(receipt("list").value("text").toString() == text && shownText("memoryListFeedback") == text,
                code + "_RECEIPT_NOT_SHOWN");
        require(bool(find(w->contentItem(), "memoryLoadMore")) == hasMore, code + "_LOAD_MORE_VISIBILITY");
        require(shownText("memoryFilterField") == query, code + "_FILTER_FIELD_UNEXPECTED");
    }
    // Same input-eligibility gate as the other checks: the step's own 4 s from the
    // step start; the control is first brought to the middle of its scrolled page.
    bool whenReady(const QString &name, bool surface, const std::function<void()> &action) {
        auto *item = named(w->contentItem(), name);
        QVariantMap reveal;
        if (item && item->isVisible()) {
            reveal = NativeControlReadiness::revealCenter(item, [this] { return clock.elapsed() - at; }, 4000);
            if (reveal.value("scrollCount").toInt() > 0 && reveals.size() < 24)
                reveals.append(QVariantMap{{"step", step}, {"control", name}, {"reveal", reveal}});
        }
        const auto result = gate.poll(clock.elapsed() - at, 4000, [&] {
            auto state = NativeControlReadiness::snapshot(named(w->contentItem(), name), w, surface);
            state["control"] = name;
            state["step"] = step;
            return state;
        }, action);
        if (result == NativeControlReadiness::OnceGate::Expired)
            observed["readinessTimeoutDiagnostic"] = QVariantMap{
                {"step", step}, {"control", name}, {"gate", gate.metadata()},
                {"reveal", NativeControlReadiness::revealSummary(reveal)},
                {"visibility", NativeControlReadiness::wholeVisibility(named(w->contentItem(), name), w)}};
        require(result != NativeControlReadiness::OnceGate::Expired, "MEMORY_PAGE_READINESS_DEADLINE:" + name);
        if (result != NativeControlReadiness::OnceGate::Performed)
            return false;
        readiness.append(QVariantMap{{"step", step}, {"control", name}, {"gate", gate.metadata()}});
        gate.resetForNextStep();
        return true;
    }
    void record(const QString &name, const QVariantMap &extra = {}) {
        auto entry = extra;
        entry.insert({{"name", name}, {"passed", true}});
        cases.append(entry);
    }
    bool observeCandidateHeader(const QString &phase) {
        const auto page = s->memoryCandidatePage();
        const auto readId = receipt("candidates").value("requestId").toString();
        const auto details = s->diagnostics().value("candidatePaging").toMap();
        require(s->scopeKey() == ownerScope && s->generation() == ownerGeneration &&
            !readId.isEmpty() && readId != headerReadBaseline && details.value("readRequestId") == readId,
            "MEMORY_PAGE_CANDIDATE_READ_ANCHOR_CHANGED");
        QVariantMap anchor; int matches = 0;
        for (const auto &value : candidateReadReceipts) if (value.toMap().value("requestId") == readId) {
            anchor = value.toMap(); ++matches;
        }
        require(matches == 1 && anchor.value("ok").metaType().id() == QMetaType::Bool && anchor.value("ok").toBool() &&
            anchor.value("rowCount").toInt() == candidates().size() &&
            (phase == "first-page" ? QList<int>{2,3} : QList<int>{13,14}).contains(anchor.value("observedStep").toInt()),
            "MEMORY_PAGE_CANDIDATE_RECEIPT_MISSING_OR_OLD");
        auto header = CandidateHeaderProbe::inspect(w, page, candidates().size(), readId,
                                                          s->scopeKey(), s->generation(), frameSerial);
        observed["lastCandidateHeader"] = header;
        const auto settled = headerStable.poll(header, true, clock.elapsed() - at, 10000);
        observed["candidateHeaderAcquisition"] = headerStable.evidence();
        require(settled != CandidateHeaderProbe::StableRead::Expired && settled != CandidateHeaderProbe::StableRead::Failed,
                "MEMORY_PAGE_CANDIDATE_HEADER_TEXT_OR_GEOMETRY");
        if (settled != CandidateHeaderProbe::StableRead::Ready) { w->update(); return false; }
        header["settling"] = headerStable.evidence();
        auto headers = observed.value("candidateHeaders").toList();
        require(headers.size() < 2, "MEMORY_PAGE_CANDIDATE_HEADER_BOUND");
        headers.append(QVariantMap{{"phase", phase}, {"pageNumber", page.value("pageNumber").toInt()},
            {"count", candidates().size()}, {"readRequestId", readId}, {"scope", s->scopeKey()},
            {"generation", s->generation()}, {"header", header}, {"readAnchor", anchor},
            {"previousReadId", headerReadBaseline}, {"readKind", details.value("readKind")}});
        observed["candidateHeaders"] = headers;
        return true;
    }
    void finish(bool passed, const QString &error = {}) {
        timer.stop();
        auto callback = std::move(done);
        if (callback)
            callback({{"passed", passed},
                      {"error", error},
                      {"mode", verifyOnly ? "restart-readback" : "page-filter-edit-reject"},
                      {"step", step},
                      {"checks", cases},
                      {"observed", observed},
                      {"readiness", readiness},
                      {"readinessCurrent", gate.metadata()},
                      {"reveals", reveals},
                      {"readinessPollIntervalMs", timer.interval()},
                      {"inputMethodScope", "synthetic QInputMethodEvent commits, not physical OS IME acceptance"}});
        deleteLater();
    }
    // Waits for this step's list read; anything later than 10 s is a failure.
    bool listSettled(const QString &code) {
        require(clock.elapsed() - at < 10000, code + "_READ_DEADLINE");
        return clock.elapsed() - at > 80 && settled();
    }
    void tick() {
        require(clock.elapsed() < (verifyOnly ? 30000 : 60000), "MEMORY_PAGE_TIMEOUT");
        const QString page = verifyOnly ? "RESTART_PAGE" : "FIRST_PAGE";
        if (step == 0) {
            if (whenReady("nav-memory", surfacesClosed(), [this] { click("nav-memory"); }))
                next(1);
            return;
        }
        if (step == 1) {
            if (whenReady("archive-open-memories", opened(), [this] { click("archive-open-memories"); }))
                next(2);
            return;
        }
        // Opening the page reads the first page; the refresh is the user's own read
        // of both lists, with a receipt this check owns. A refresh while the opening
        // candidate read is still in flight reuses that read, so both must settle first.
        if (step == 2) {
            if (!find(w->contentItem(), "memoryPage") || !settled())
                return;
            require(named(w->contentItem(), "memoryTabs")->property("currentIndex").toInt() == 0,
                    "MEMORY_PAGE_TAB_UNEXPECTED");
            if (whenReady("memoryRefresh", opened(), [this] {
                    headerReadBaseline = receipt("candidates").value("requestId").toString();
                    click("memoryRefresh");
                    listRequest = receipt("list").value("requestId").toString();
                    require(receipt("list").value("status") == "pending" && !listRequest.isEmpty(),
                            "MEMORY_PAGE_REFRESH_NOT_SENT");
                }))
                next(3);
            return;
        }
        if (step == 3) {
            if (!listSettled(page))
                return;
            require(receipt("list").value("requestId") == listRequest, page + "_RECEIPT_MISMATCH");
            require(receipt("candidates").value("status") == "success", page + "_CANDIDATES_NOT_READ");
            const auto expected = seeded(verifyOnly, false, afterBatchDelete).mid(0, 100);
            requireList(expected, true, {}, "已显示 100 条已确认的记忆，可以加载更多。", page);
            if (!observeCandidateHeader("first-page")) return;
            int candidate = -1;
            for (int i = 0; i < candidates().size(); ++i)
                if (candidates()[i].toMap().value("proposed_text") == rejectedCandidate)
                    candidate = i;
            if (verifyOnly) {
                require(candidate < 0, "RESTART_REJECTED_CANDIDATE_RETURNED");
            } else {
                require(candidate >= 0, "SEEDED_CANDIDATE_MISSING");
                candidateId = candidates()[candidate].toMap().value("id").toString();
                w->grabWindow().save(capturePrefix + ".memory-first-page.png");
                record("first-page-shows-newest-100", {{"rows", 100}});
            }
            next(4);
            return;
        }
        if (step == 4) {
            if (whenReady("memoryLoadMore", opened(), [this] {
                    click("memoryLoadMore");
                    listRequest = receipt("list").value("requestId").toString();
                    require(receipt("list").value("status") == "pending" && !listRequest.isEmpty(),
                            "MEMORY_PAGE_LOAD_MORE_NOT_SENT");
                }))
                next(5);
            return;
        }
        if (step == 5) {
            if (!listSettled(page + "_MORE"))
                return;
            require(receipt("list").value("requestId") == listRequest, page + "_MORE_RECEIPT_MISMATCH");
            requireList(seeded(verifyOnly, false, afterBatchDelete), false, {},
                        afterBatchDelete ? "共 127 条已确认的记忆。" : "共 130 条已确认的记忆。", page + "_MORE");
            if (verifyOnly) {
                observed["restartIds"] = ids();
                record("restart-pages-read-back", {{"rows", afterBatchDelete ? 127 : seededCount}});
            } else {
                record("load-more-appends-the-rest", {{"rows", seededCount}});
            }
            next(6);
            return;
        }
        if (step == 6) {
            if (whenReady("memoryFilterField", opened(), [this] { type("memoryFilterField", marker); }))
                next(7);
            return;
        }
        if (step == 7) {
            if (whenReady("memoryFilterApply", opened(), [this] {
                    click("memoryFilterApply");
                    listRequest = receipt("list").value("requestId").toString();
                    require(receipt("list").value("status") == "pending" && !listRequest.isEmpty(),
                            "MEMORY_PAGE_FILTER_NOT_SENT");
                }))
                next(8);
            return;
        }
        if (step == 8) {
            if (!listSettled("FILTER"))
                return;
            require(receipt("list").value("requestId") == listRequest, "FILTER_RECEIPT_MISMATCH");
            requireList(seeded(verifyOnly, true), false, marker, "找到 12 条包含“星图标记”的记忆。", "FILTER");
            if (verifyOnly) {
                record("restart-filter-reads-back", {{"rows", 12}});
                next(15);
                return;
            }
            w->grabWindow().save(capturePrefix + ".memory-filtered.png");
            record("filter-shows-literal-matches", {{"rows", 12}});
            editedFromId = ids().value(2);
            require(texts().value(2) == MemoryPageCheck::seededText(editedNumber), "FILTER_EDIT_TARGET_UNEXPECTED");
            next(9);
            return;
        }
        if (step == 9) {
            if (whenReady("memoryEdit2", opened(), [this] { click("memoryEdit2"); }))
                next(10);
            return;
        }
        if (step == 10) {
            if (whenReady("memoryEditField", opened(), [this] { type("memoryEditField", editedText); }))
                next(11);
            return;
        }
        if (step == 11) {
            if (whenReady("memoryEditSave", opened(), [this] { click("memoryEditSave"); }))
                next(12);
            return;
        }
        // The edit reads the list back from the first page of the same filter.
        if (step == 12) {
            if (!listSettled("FILTER_EDIT") || receipt("action").isEmpty())
                return;
            require(receipt("action").value("status") == "success" &&
                        shownText("memoryActionFeedback") == receipt("action").value("text").toString(),
                    "FILTER_EDIT_NOT_SAVED:" + receipt("action").value("text").toString());
            requireList(seeded(true, true), false, marker, "找到 12 条包含“星图标记”的记忆。", "FILTER_EDIT");
            require(!ids().contains(editedFromId) && !find(w->contentItem(), "memoryEditField"),
                    "FILTER_EDIT_LEFT_OLD_REVISION");
            record("edit-inside-filter-keeps-filter", {{"rows", 12}});
            next(13);
            return;
        }
        if (step == 13) {
            int index = -1;
            for (int i = 0; i < candidates().size(); ++i)
                if (candidates()[i].toMap().value("id") == candidateId)
                    index = i;
            require(index >= 0, "SEEDED_CANDIDATE_GONE_BEFORE_REJECT");
            const auto name = "memoryCandidateReject" + QString::number(index);
            if (whenReady(name, opened(), [this, name] {
                    headerReadBaseline = receipt("candidates").value("requestId").toString(); click(name); }))
                next(14);
            return;
        }
        if (step == 14) {
            if (!listSettled("REJECT") || receipt("action").value("verb") != "不记这条")
                return;
            require(receipt("action").value("status") == "success" &&
                        receipt("action").value("text") == "已放弃这条，不会记住。" &&
                        shownText("memoryActionFeedback") == "已放弃这条，不会记住。",
                    "CANDIDATE_REJECT_NOT_CONFIRMED:" + receipt("action").value("text").toString());
            for (const auto &value : candidates())
                require(value.toMap().value("id") != candidateId, "REJECTED_CANDIDATE_STILL_PENDING");
            requireList(seeded(true, true), false, marker, "找到 12 条包含“星图标记”的记忆。", "REJECT");
            require(!texts().join("\n").contains(rejectedCandidate), "REJECTED_CANDIDATE_BECAME_MEMORY");
            if (!observeCandidateHeader("after-reject")) return;
            record("candidate-reject-leaves-no-memory");
            next(15);
            return;
        }
        if (step == 15) {
            if (whenReady("memoryFilterClear", opened(), [this] {
                    click("memoryFilterClear");
                    listRequest = receipt("list").value("requestId").toString();
                    require(receipt("list").value("status") == "pending" && !listRequest.isEmpty(),
                            "MEMORY_PAGE_CLEAR_NOT_SENT");
                }))
                next(16);
            return;
        }
        if (step == 16) {
            if (!listSettled("CLEARED"))
                return;
            require(receipt("list").value("requestId") == listRequest, "CLEARED_RECEIPT_MISMATCH");
            requireList(seeded(true, false, afterBatchDelete).mid(0, 100), true, {}, "已显示 100 条已确认的记忆，可以加载更多。",
                        "CLEARED");
            next(verifyOnly ? 19 : 17);
            return;
        }
        if (step == 17) {
            if (whenReady("memoryLoadMore", opened(), [this] { click("memoryLoadMore"); }))
                next(18);
            return;
        }
        if (step == 18) {
            if (!listSettled("CLEARED_MORE"))
                return;
            requireList(seeded(true, false), false, {}, "共 130 条已确认的记忆。", "CLEARED_MORE");
            require(!texts().join("\n").contains(rejectedCandidate), "REJECTED_CANDIDATE_BECAME_MEMORY");
            observed["finalIds"] = ids();
            w->grabWindow().save(capturePrefix + ".memory-cleared.png");
            record("clearing-filter-restores-full-list", {{"rows", seededCount}});
            next(19);
            return;
        }
        if (step == 19) {
            if (verifyOnly)
                require(!s->memoryFeedback().contains("action"), "RESTART_CHECK_CHANGED_MEMORIES");
            // The registered recall segment starts from this exact list and
            // receipt; leaving and reentering would refresh its first page.
            if (keepOpen) {
                finish(true);
                return;
            }
            if (whenReady("memory-close", opened(), [this] { click("memory-close"); }))
                next(20);
            return;
        }
        if (step == 20) {
            require(clock.elapsed() - at < 4000, "MEMORY_PAGE_CLOSE_DEADLINE");
            if (surfacesClosed() && closed())
                finish(true);
        }
    }
};
} // namespace

namespace MemoryPageCheck {
QString seededText(int number) {
    const auto padded = QString("%1").arg(number, 3, 10, QChar('0'));
    return marked(number) ? QString("隔离记忆第%1条：星图标记第%2处").arg(padded).arg((number - 7) / 11 + 1)
                          : QString("隔离记忆第%1条：窗外的夜色").arg(padded);
}
void run(QQuickWindow *w, RuntimeBridge *s, bool verifyOnly, const QString &capturePrefix,
         std::function<void(QVariantMap)> completion, bool keepOpen, bool batchDelete) {
    new Check(w, s, verifyOnly, capturePrefix, std::move(completion), keepOpen, batchDelete);
}
} // namespace MemoryPageCheck
