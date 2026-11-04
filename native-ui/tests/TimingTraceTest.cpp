#include "../src/TimingTrace.h"
#include <QCoreApplication>
#include <QJsonArray>
#include <QJsonDocument>
#include <QTest>
#include <array>
#include <memory>
#include <stdexcept>
#include <thread>
#include <vector>
#ifdef REVERIE_TIMING_DIAGNOSTICS
#include <QInputMethodEvent>
#include <cerrno>
#include <cstring>
#include <fcntl.h>
#include <spawn.h>
#include <sys/socket.h>
#include <sys/wait.h>
#include <unistd.h>
extern char **environ;
namespace {
class UnknownMetaObject final : public QObject {
public:
    const QMetaObject *metaObject() const override { return nullptr; }
};
class ThrowingMetaObject final : public QObject {
public:
    const QMetaObject *metaObject() const override { throw std::runtime_error("metadata unavailable"); }
};
class MetaCallContextClassNameLongEnoughToExceedTheSeventyNineByteClassNameBufferAndRemainBounded final : public QObject {
    Q_OBJECT
};
class ReadingCounters final : public QObject {
    Q_OBJECT
    Q_PROPERTY(int restoreRequestCount READ requests NOTIFY requestsChanged)
    Q_PROPERTY(int restoreExecutionCount READ executions NOTIFY executionsChanged)
    Q_PROPERTY(int forceLayoutCount READ layouts NOTIFY layoutsChanged)
public:
    int requests() const { return 10; }
    int executions() const { return 8; }
    int layouts() const { return 12; }
    void notifyAll() { emit requestsChanged(); emit executionsChanged(); emit layoutsChanged(); }
signals:
    void requestsChanged();
    void executionsChanged();
    void layoutsChanged();
};
int waitChild(pid_t child) {
    int status = 0;
    while (::waitpid(child, &status, 0) < 0) {
        if (errno != EINTR) return -1;
    }
    return WIFEXITED(status) ? WEXITSTATUS(status) : -1;
}
int controlChild(QCoreApplication &application) {
    if (!TimingTrace::configureControl(&application, 4, "scroll-tail", "companion-transactions-v1", 300)) return 2;
    const auto descriptorFlags = ::fcntl(4, F_GETFD), statusFlags = ::fcntl(4, F_GETFL);
    if (descriptorFlags < 0 || statusFlags < 0 || !(descriptorFlags & FD_CLOEXEC)
            || !(statusFlags & O_NONBLOCK)) return 3;
    const auto executable = QCoreApplication::applicationFilePath().toLocal8Bit();
    char *arguments[]{const_cast<char *>(executable.constData()), const_cast<char *>("--timing-fd4-inheritance-child"), nullptr};
    pid_t child = 0;
    if (::posix_spawn(&child, executable.constData(), nullptr, nullptr, arguments, environ)) return 4;
    return waitChild(child) == 0 ? 0 : 5;
}
} // namespace
#endif

class TimingTraceTest final : public QObject {
    Q_OBJECT
private slots:
    void cleanup() { TimingTrace::stop(); TimingTrace::setMetaCallContextEnabled(false); }
    void disabledIsNoop() {
        TimingTrace::stop();
        QVERIFY(!TimingTrace::enabled());
        const auto before = TimingTrace::snapshot();
        { TimingTrace::Scope scope(TimingTrace::Kind::NotifyEvent, 7, 8);
          TimingTrace::point(TimingTrace::Kind::WorkTick, 1, 2); }
        QCOMPARE(TimingTrace::snapshot(), before);
        QVERIFY(TimingTrace::nowNs() > 0);
#ifndef REVERIE_TIMING_DIAGNOSTICS
        TimingTrace::start();
        QVERIFY(!TimingTrace::enabled());
        QVERIFY(!TimingTrace::snapshot().value("compiled").toBool());
#endif
    }
    void notificationForwardingIsTransparent() {
#ifdef REVERIE_TIMING_DIAGNOSTICS
        TimingTrace::start();
#endif
        int calls = 0;
        QVERIFY(TimingTrace::observeNotification(1, true, [&] { ++calls; return true; }));
        QVERIFY(!TimingTrace::observeNotification(2, false, [&] { ++calls; return false; }));
        bool caught = false;
        try {
            TimingTrace::observeNotification(3, true, [&]() -> bool { ++calls; throw std::runtime_error("transparent"); });
        } catch (const std::runtime_error &error) {
            caught = QByteArray(error.what()) == "transparent";
        }
        QVERIFY(caught);
        QCOMPARE(calls, 3);
#ifdef REVERIE_TIMING_DIAGNOSTICS
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCount").toInt(), 6);
        QCOMPARE(report.value("errorSpans").toInt(), 1);
        QVERIFY(!report.value("essentialFailure").toBool());
        const auto records = report.value("records").toArray();
        QCOMPARE(records[0].toObject().value("b").toInt(), 1);
        QCOMPARE(records[2].toObject().value("b").toInt(), 0);
#endif
    }
#ifdef REVERIE_TIMING_DIAGNOSTICS
    void metaCallContextSurvivesReceiverDeletionAndNestedDelivery() {
        QObject parent;
        auto *receiver = new QObject(&parent);
        const QString privateName = "PRIVATE_RECEIVER_OBJECT_NAME";
        receiver->setObjectName(privateName);
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        TimingTrace::setContext(0, 39);
        TimingTrace::setReceiverRole(TimingTrace::ReceiverRole::ChatPanel, &parent);
        int calls = 0;
        QVERIFY(!TimingTrace::observeNotification(receiver, int(QEvent::MetaCall), false, [&] {
            ++calls;
            return TimingTrace::observeNotification(receiver, int(QEvent::MetaCall), false, [&] {
                ++calls; delete receiver; receiver = nullptr; return false;
            });
        }));
        TimingTrace::stop();
        QCOMPARE(calls, 2);
        const auto report = TimingTrace::snapshot();
        QVERIFY(!QJsonDocument(report).toJson().contains(privateName.toUtf8()));
        const auto contexts = report.value("metaCallContext").toObject().value("records").toArray();
        const auto records = report.value("records").toArray();
        QCOMPARE(contexts.size(), 2);
        QCOMPARE(contexts[0].toObject().value("spanId"), records[0].toObject().value("spanId"));
        QCOMPARE(contexts[1].toObject().value("spanId"), records[1].toObject().value("spanId"));
        QCOMPARE(records[1].toObject().value("parentSpanId"), records[0].toObject().value("spanId"));
        QCOMPARE(contexts[0].toObject().value("phase").toInt(), 0);
        QCOMPARE(contexts[0].toObject().value("input").toInt(), 39);
        const auto chain = contexts[0].toObject().value("chain").toArray();
        QCOMPARE(chain.size(), 2);
        QCOMPARE(chain[0].toObject().value("className").toString(), "QObject");
        QCOMPARE(chain[0].toObject().value("role").toString(), "unknown");
        QVERIFY(!chain[0].toObject().value("roleKnown").toBool());
        QCOMPARE(chain[1].toObject().value("role").toString(), "chatPanel");
        QCOMPARE(report.value("incompleteSpans").toInt(), 0);
    }
    void metaCallContextPreservesExceptionAndUnknownMetadata() {
        UnknownMetaObject unknown;
        ThrowingMetaObject throwing;
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        int calls = 0;
        for (QObject *receiver : std::array<QObject *, 3>{&unknown, &throwing, nullptr}) {
            bool caught = false;
            try {
                TimingTrace::observeNotification(receiver, int(QEvent::MetaCall), false, [&]() -> bool {
                    ++calls; throw std::runtime_error("original delivery exception");
                });
            } catch (const std::runtime_error &error) {
                caught = QByteArray(error.what()) == "original delivery exception";
            }
            QVERIFY(caught);
        }
        TimingTrace::stop();
        QCOMPARE(calls, 3);
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("errorSpans").toInt(), 3);
        const auto contexts = report.value("metaCallContext").toObject().value("records").toArray();
        QVERIFY(contexts[0].toObject().value("chain").toArray()[0].toObject().value("className").isNull());
        QVERIFY(contexts[1].toObject().value("metadataError").toBool());
        QVERIFY(contexts[2].toObject().value("chain").toArray().isEmpty());
    }
    void metaCallMetadataIsBoundedAndOverflowIsUnknown() {
        QObject root, a(&root), b(&a), c(&b), d(&c), receiver(&d);
        MetaCallContextClassNameLongEnoughToExceedTheSeventyNineByteClassNameBufferAndRemainBounded longName;
        TimingTrace::setMetaCallContextEnabled(true, 2);
        TimingTrace::start();
        for (QObject *object : {static_cast<QObject *>(&receiver), static_cast<QObject *>(&longName), &root})
            QVERIFY(TimingTrace::observeNotification(object, int(QEvent::MetaCall), false, [] { return true; }));
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        const auto context = report.value("metaCallContext").toObject();
        QCOMPARE(context.value("recordCount").toInt(), 2);
        QCOMPARE(context.value("droppedContexts").toInt(), 1);
        QVERIFY(!context.value("complete").toBool());
        const auto rows = context.value("records").toArray();
        QVERIFY(rows[0].toObject().value("parentChainTruncated").toBool());
        QCOMPARE(rows[0].toObject().value("chain").toArray().size(), 5);
        const auto classNode = rows[1].toObject().value("chain").toArray()[0].toObject();
        QVERIFY(classNode.value("classNameTruncated").toBool());
        QCOMPARE(classNode.value("className").toString().toLatin1().size(), 79);
        QCOMPARE(report.value("recordCount").toInt(), 6); // Delivery spans remain complete.
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void metaCallContextOnlyObservesGuiMetaCallsAndOptIn() {
        QObject receiver;
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        QVERIFY(TimingTrace::observeNotification(&receiver, int(QEvent::User), false, [] { return true; }));
        std::thread other([&] {
            TimingTrace::observeNotification(&receiver, int(QEvent::MetaCall), false, [] { return true; });
        });
        other.join();
        TimingTrace::stop();
        QCOMPARE(TimingTrace::snapshot().value("metaCallContext").toObject().value("recordCount").toInt(), 0);
        TimingTrace::setMetaCallContextEnabled(false);
        TimingTrace::start();
        QVERIFY(TimingTrace::observeNotification(&receiver, int(QEvent::MetaCall), false, [] { return true; }));
        TimingTrace::stop();
        QVERIFY(!TimingTrace::snapshot().contains("metaCallContext"));
    }
    void metaCallContextMissingEndStaysUnknown() {
        QObject receiver;
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        QVERIFY(TimingTrace::observeNotification(&receiver, int(QEvent::MetaCall), false, [] {
            TimingTrace::setCutoffNs(TimingTrace::nowNs() - 1); return true;
        }));
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("incompleteSpans").toInt(), 1);
        QCOMPARE(report.value("recordCount").toInt(), 1);
        QCOMPARE(report.value("metaCallContext").toObject().value("recordCount").toInt(), 1);
        QVERIFY(!report.value("metaCallContext").toObject().value("records").toArray()[0].toObject().contains("durationNs"));
    }
    void readingCounterNotificationsKeepEnclosingSpan() {
        ReadingCounters counters;
        QObject owner;
        TimingTrace::setMetaCallContextEnabled(true);
        TimingTrace::start();
        QCOMPARE(TimingTrace::observeReadingRestoreCounters(&counters, &owner), quint8(7));
        QVERIFY(TimingTrace::observeNotification(&counters, int(QEvent::MetaCall), false, [&] {
            counters.notifyAll(); return true;
        }));
        TimingTrace::stop();
        const auto records = TimingTrace::snapshot().value("records").toArray();
        QCOMPARE(records.size(), 8);
        for (int i = 0; i < 3; ++i) {
            QCOMPARE(records[i].toObject().value("kind").toInt(), int(TimingTrace::Kind::ReadingRestoreCounter));
            QCOMPARE(records[4 + i].toObject().value("a").toInt(), i);
            QCOMPARE(records[4 + i].toObject().value("parentSpanId"), records[3].toObject().value("spanId"));
        }
        TimingTrace::setMetaCallContextEnabled(false);
        TimingTrace::start();
        QCOMPARE(TimingTrace::observeReadingRestoreCounters(&counters, &owner), quint8(0));
        counters.notifyAll();
        TimingTrace::stop();
        QCOMPARE(TimingTrace::snapshot().value("recordCount").toInt(), 0);
    }
    void fixedCapacityWithSmallSnapshots() {
        QCOMPARE(TimingTrace::RecordCapacity, std::size_t(524288));
        TimingTrace::start();
        TimingTrace::point(TimingTrace::Kind::WorkTick);
        TimingTrace::stop();
        auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCapacity").toInt(), 524288);
        QCOMPARE(report.value("records").toArray().size(), 1);
        TimingTrace::start(TimingTrace::RecordCapacity * 2);
        TimingTrace::point(TimingTrace::Kind::WorkTick);
        TimingTrace::stop();
        report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCapacity").toInt(), 524288);
        QCOMPARE(report.value("records").toArray().size(), 1);
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void eventPayloadStaysOpaque() {
        QInputMethodEvent event;
        const QString opaque = QStringLiteral("OPAQUE_TIMING_PAYLOAD_0123456789");
        event.setCommitString(opaque);
        TimingTrace::start();
        QVERIFY(TimingTrace::observeNotification(int(event.type()), false, [] { return true; }));
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        const auto serialized = QJsonDocument(report).toJson(QJsonDocument::Compact);
        QVERIFY(!serialized.contains(opaque.toUtf8()));
        QCOMPARE(report.value("eventTypeNames").toObject().value(QString::number(int(QEvent::InputMethod))).toString(), "InputMethod");
        QCOMPARE(report.value("recordCount").toInt(), 2);
    }
    void privateControlFdDoesNotSurviveExec() {
        int sockets[2]{-1, -1};
        QCOMPARE(::socketpair(AF_UNIX, SOCK_STREAM, 0, sockets), 0);
        for (int fd : sockets) {
            const auto flags = ::fcntl(fd, F_GETFD);
            QVERIFY(flags >= 0);
            QCOMPARE(::fcntl(fd, F_SETFD, flags | FD_CLOEXEC), 0);
        }
        posix_spawn_file_actions_t actions;
        QCOMPARE(::posix_spawn_file_actions_init(&actions), 0);
        QCOMPARE(::posix_spawn_file_actions_adddup2(&actions, sockets[0], 4), 0);
        if (sockets[0] != 4) QCOMPARE(::posix_spawn_file_actions_addclose(&actions, sockets[0]), 0);
        if (sockets[1] != 4) QCOMPARE(::posix_spawn_file_actions_addclose(&actions, sockets[1]), 0);
        const auto executable = QCoreApplication::applicationFilePath().toLocal8Bit();
        char *arguments[]{const_cast<char *>(executable.constData()), const_cast<char *>("--timing-fd4-child"), nullptr};
        pid_t child = 0;
        const auto spawned = ::posix_spawn(&child, executable.constData(), &actions, nullptr, arguments, environ);
        ::posix_spawn_file_actions_destroy(&actions);
        ::close(sockets[0]); ::close(sockets[1]);
        QCOMPARE(spawned, 0);
        QCOMPARE(waitChild(child), 0);
    }
    void pointsAndClockContext() {
        const auto first = TimingTrace::nowNs();
        TimingTrace::start();
        TimingTrace::setContext(2, 299);
        TimingTrace::point(TimingTrace::Kind::ClockAnchor, 123, 456);
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCount").toInt(), 1);
        const auto record = report.value("records").toArray().first().toObject();
        QCOMPARE(record.value("phase").toInt(), 2);
        QCOMPARE(record.value("input").toInt(), 299);
        QCOMPARE(record.value("a").toInt(), 123);
        QCOMPARE(record.value("b").toInt(), 456);
        QVERIFY(record.value("isGui").toBool());
        QCOMPARE(report.value("guiThreadId"), record.value("threadId"));
        QVERIFY(report.value("startedNs").toString().toLongLong() >= first);
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void nestedSpansAndReentry() {
        TimingTrace::start();
        {
            TimingTrace::Scope notify(TimingTrace::Kind::NotifyEvent, 1);
            TimingTrace::Scope tick(TimingTrace::Kind::WorkTick);
            {
                TimingTrace::Scope dispatch(TimingTrace::Kind::WheelEvent);
                TimingTrace::Scope reentry(TimingTrace::Kind::NotifyEvent, 2);
                TimingTrace::point(TimingTrace::Kind::TimeoutRejected);
            }
        }
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        const auto records = report.value("records").toArray();
        QCOMPARE(records.size(), 9);
        for (int index = 1; index <= 3; ++index)
            QCOMPARE(records[index].toObject().value("parentSpanId"), records[index - 1].toObject().value("spanId"));
        QCOMPARE(records[4].toObject().value("parentSpanId"), records[3].toObject().value("spanId"));
        QCOMPARE(report.value("incompleteSpans").toInt(), 0);
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void exceptionEndIsObserved() {
        TimingTrace::start();
        try {
            TimingTrace::Scope scope(TimingTrace::Kind::InputDispatch);
            throw std::runtime_error("synthetic");
        } catch (const std::runtime_error &) {}
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("errorSpans").toInt(), 1);
        QCOMPARE(report.value("observedExceptionSpans").toInt(), 1);
        QCOMPARE(report.value("incompleteSpans").toInt(), 0);
        QVERIFY(report.value("records").toArray().last().toObject().value("error").toBool());
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void boundedRecordOverflow() {
        TimingTrace::start(8);
        for (int index = 0; index < 20; ++index)
            TimingTrace::point(TimingTrace::Kind::WorkTick, index);
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCount").toInt(), 8);
        QCOMPARE(report.value("droppedRecords").toInt(), 12);
        QCOMPARE(report.value("recordCapacity").toInt(), 8);
        const auto serialized = QJsonDocument(report).toJson(QJsonDocument::Compact);
        const auto parsed = QJsonDocument::fromJson(serialized).object();
        QCOMPARE(parsed.value("records").toArray().size(), 8);
        QVERIFY(report.value("essentialFailure").toBool());
    }
    void boundedStackOverflow() {
        TimingTrace::start();
        std::vector<std::unique_ptr<TimingTrace::Scope>> scopes;
        for (int index = 0; index < 70; ++index)
            scopes.push_back(std::make_unique<TimingTrace::Scope>(TimingTrace::Kind::NotifyEvent, index));
        while (!scopes.empty()) scopes.pop_back();
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("stackOverflows").toInt(), 6);
        QCOMPARE(report.value("spanOrderErrors").toInt(), 0);
        QCOMPARE(report.value("incompleteSpans").toInt(), 0);
        QVERIFY(report.value("essentialFailure").toBool());
    }
    void cutoffLeavesUnknownEnd() {
        TimingTrace::start();
        {
            TimingTrace::Scope scope(TimingTrace::Kind::PhaseClose);
            TimingTrace::setCutoffNs(TimingTrace::nowNs() - 1);
            TimingTrace::point(TimingTrace::Kind::FrameSwapped);
            TimingTrace::Scope after(TimingTrace::Kind::NotifyEvent);
        }
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        QCOMPARE(report.value("recordCount").toInt(), 1);
        QCOMPARE(report.value("incompleteSpans").toInt(), 1);
        QCOMPARE(report.value("cutoffOmittedPoints").toInt(), 1);
        QCOMPARE(report.value("cutoffOmittedSpanStarts").toInt(), 1);
        QCOMPARE(report.value("cutoffOmittedSpanEnds").toInt(), 1);
        QVERIFY(!report.value("essentialFailure").toBool());
    }
    void boundarySnapshotPrecedesScopeFinalization() {
        for (bool cutoff : {false, true}) {
            TimingTrace::start();
            QJsonObject inside;
            {
                TimingTrace::Scope scope(TimingTrace::Kind::PhaseClose);
                if (cutoff) TimingTrace::setCutoffNs(TimingTrace::nowNs() - 1);
                TimingTrace::stop();
                inside = TimingTrace::snapshot();
                QCOMPARE(inside.value("incompleteSpans").toInt(), 1);
                QCOMPARE(inside.value("stoppedOmittedSpanEnds").toInt(), 0);
                QCOMPARE(inside.value("cutoffOmittedSpanEnds").toInt(), 0);
            }
            const auto finalized = TimingTrace::snapshot();
            QCOMPARE(finalized.value("stoppedOmittedSpanEnds").toInt(), cutoff ? 0 : 1);
            QCOMPARE(finalized.value("cutoffOmittedSpanEnds").toInt(), cutoff ? 1 : 0);
            QCOMPARE(finalized.value("incompleteSpans").toInt(), 1);
            QCOMPARE(finalized.value("records"), inside.value("records"));
            const auto records = finalized.value("records").toArray();
            QCOMPARE(records.size(), 1);
            QCOMPARE(records.first().toObject().value("edge").toInt(), 1); // Begin only.
            QVERIFY(!records.first().toObject().contains("durationNs"));
            QVERIFY(!records.first().toObject().contains("durationMs"));
            QCOMPARE(inside.value("stoppedOmittedSpanEnds").toInt(), 0);
            QCOMPARE(inside.value("cutoffOmittedSpanEnds").toInt(), 0);
            QVERIFY(!finalized.value("essentialFailure").toBool());
        }
    }
    void disabledScopeCannotParentNewCapture() {
        TimingTrace::stop();
        {
            TimingTrace::Scope disabled(TimingTrace::Kind::NotifyEvent);
            TimingTrace::start();
            { TimingTrace::Scope active(TimingTrace::Kind::WorkTick); }
        }
        TimingTrace::stop();
        const auto records = TimingTrace::snapshot().value("records").toArray();
        QCOMPARE(records.size(), 2);
        QCOMPARE(records.first().toObject().value("parentSpanId").toInt(), 0);
    }
    void threadStacksAreIndependent() {
        TimingTrace::start();
        {
            TimingTrace::Scope gui(TimingTrace::Kind::WorkTick);
            std::thread other([] { TimingTrace::Scope render(TimingTrace::Kind::BeforeRender); });
            other.join();
        }
        TimingTrace::stop();
        const auto report = TimingTrace::snapshot();
        const auto records = report.value("records").toArray();
        QCOMPARE(records.size(), 4);
        QCOMPARE(records[1].toObject().value("parentSpanId").toInt(), 0);
        QVERIFY(records[0].toObject().value("threadId") != records[1].toObject().value("threadId"));
        QVERIFY(records[0].toObject().value("isGui").toBool());
        QVERIFY(!records[1].toObject().value("isGui").toBool());
        QVERIFY(!report.value("essentialFailure").toBool());
    }
#endif
};
int main(int argc, char **argv) {
#ifdef REVERIE_TIMING_DIAGNOSTICS
    // This branch checks inheritance before any event dispatcher can reuse fd4.
    if (argc == 2 && std::strcmp(argv[1], "--timing-fd4-inheritance-child") == 0) {
        errno = 0;
        return ::fcntl(4, F_GETFD) == -1 && errno == EBADF ? 0 : 1;
    }
#endif
    QCoreApplication application(argc, argv);
#ifdef REVERIE_TIMING_DIAGNOSTICS
    if (argc == 2 && std::strcmp(argv[1], "--timing-fd4-child") == 0)
        return controlChild(application);
#endif
    TimingTraceTest test;
    return QTest::qExec(&test, argc, argv);
}
#include "TimingTraceTest.moc"
