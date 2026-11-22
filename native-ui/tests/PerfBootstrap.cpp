#if defined(REVERIE_TIMING_DIAGNOSTICS) || defined(REVERIE_QML_PROFILER)
#include "SmoothnessCheck.h"
#endif
#include "PerfBootstrap.h"
#include "HeaderFrameLocalCheck.h"
#include "../src/RuntimeBridge.h"
#include "../src/ArchiveEditor.h"
#include "../src/NativeAvatar.h"
#include <QQuickWindow>
#include <QQuickItem>
#include <QTimer>
#include <QElapsedTimer>
#include <QPointer>
#include <QtTest>
#include <stdexcept>

namespace {
QString optionalW4Argument(const QString &name, const QString &fallback = {}) {
    const auto arguments = QCoreApplication::arguments();
    QString value = fallback;
    bool found = false;
    for (int index = 1; index < arguments.size(); ++index) {
        if (arguments[index] == name || arguments[index].startsWith(name + "=")) {
            HeaderFrameLocalCheck::require(!found, "W4_DUPLICATE_BOOTSTRAP_ARGUMENT");
            found = true;
            if (arguments[index] == name) {
                HeaderFrameLocalCheck::require(index + 1 < arguments.size(), "W4_BOOTSTRAP_ARGUMENT_MISSING_VALUE");
                value = arguments[++index];
            } else value = arguments[index].mid(name.size() + 1);
        }
    }
    return value;
}
HeaderFrameLocalCheck::Selection validateW4Bootstrap(int rows) {
    return HeaderFrameLocalCheck::validateSelection(
        HeaderFrameLocalCheck::argument("--perf-mode"), rows,
        HeaderFrameLocalCheck::argument("--perf-report"),
        optionalW4Argument("--perf-protocol", QStringLiteral("stress-v1")),
        optionalW4Argument("--diagnostic-case"));
}
QQuickItem *find(QQuickItem *root, const QString &name, bool usable=true) {
    if (!root) return nullptr;
    if (root->objectName() == name && (!usable || (root->isVisible() && root->isEnabled()))) return root;
    for (auto *child : root->childItems()) if (auto *x = find(child, name,usable)) return x;
    return nullptr;
}
class Bootstrap : public QObject {
    QQuickWindow *w;
    RuntimeBridge *s;
    ArchiveEditor *a;
    QString model, endpoint;
    int rows, step = 0;
    QTimer timer;
    QElapsedTimer elapsed;
    QVariantList stages;
    std::function<void(bool, QVariantMap)> done;
    bool ticking = false;
    bool w4Local = false;
    QVariantMap w4Evidence;
    QQuickItem *item(const QString &name) { auto *i=find(w->contentItem(),name); if (!i) throw std::runtime_error(("PERF_BOOTSTRAP_ITEM:"+name).toStdString()); return i; }
    bool open(const QString &name) { auto *p=find(w->contentItem(),name,false);return p && p->property("inputReady").toBool(); }
    void click(const QString &name) {
        auto *i=item(name); if (!i->isVisible()||!i->isEnabled()) throw std::runtime_error(("PERF_BOOTSTRAP_DISABLED:"+name).toStdString());
        auto p=i->mapToScene(QPointF(i->width()/2,i->height()/2));
        if (!QRectF(0,0,w->width(),w->height()).contains(p)) throw std::runtime_error("PERF_BOOTSTRAP_CLIPPED");
        QTest::mouseClick(w,Qt::LeftButton,Qt::NoModifier,p.toPoint(),0);
    }
    void stamp(const QString &name) { stages.append(QVariantMap{{"name",name},{"ms",elapsed.elapsed()}}); }
    void finish(bool ok,const QString &error={}) {
        timer.stop();auto callback=std::move(done);
        QVariantMap report{{"passed",ok},{"error",error},{"elapsedMs",elapsed.elapsed()},{"stages",stages},
            {"scope","new process and new isolated QML cache; model import/provider/archive bootstrap precedes timed phases; not shader disk cache warmup"}};
        if (w4Local) {
            report["scope"] = "W4 local: seeded nine-row history, provider and authorized model import precede measurement; memory drawer is not preopened; first measured memory title enters the ordinary archive initialization path; not cold application/model/shader-cache startup";
            if (w4Evidence.value("scenario").toString() == "gpu-positive-control")
                report["scope"] = "W4 GPU positive control: seeded nine-row history, provider and authorized model import retained; no memory preopen or drawer cycles; ordinary caller shutdown and isolated model/data cleanup retained";
            report["w4Local"] = w4Evidence;
            report["acceptanceEligible"] = false;
            report["performanceComparable"] = false;
        }
        callback(ok,report);deleteLater();
    }
    void tick() {
        if (ticking) return; ticking=true;
        try {
            if (elapsed.elapsed()>90000) throw std::runtime_error("PERF_BOOTSTRAP_TIMEOUT");
            if(step==0 && s->connected() && s->messages().size()==rows && !s->avatarBusy()) {
                stamp("handshake-and-seeded-history");s->testProvider(endpoint,"reverie-perf-test");step=1;
            } else if(step==1 && s->state()["providerTestReady"].toBool()) {
                s->saveProvider();click("nav-character");step=2;
            } else if(step==2 && open("taskSurface") && !s->avatarBusy()) {
                s->importModel(QUrl::fromLocalFile(model));step=3;
            } else if(step==3 && s->avatarCandidate()["previewReady"].toBool() && !s->avatarBusy() &&
                      open("taskSurface") && item("modelRights")->isVisible() && item("modelRights")->isEnabled()) {
                click("modelRights");if(!s->avatarCandidate()["warnings"].toList().isEmpty()) click("modelWarnings");click("confirmModel");step=4;
            } else if(step==4 && s->avatarCandidate().isEmpty() && s->avatarState().contains("就绪") && !s->avatarBusy()) {
                stamp("authorized-model-ready");
                if (w4Local) {
                    // Recheck the complete local selection immediately before
                    // taking the W4-only path. An arbitrary environment flag
                    // cannot bypass the ordinary archive preparation.
                    const auto selection = validateW4Bootstrap(rows);
                    auto *memory = find(w->contentItem(), "drawer-memory", false);
                    auto *settings = find(w->contentItem(), "drawer-settings", false);
                    HeaderFrameLocalCheck::require(memory && settings
                        && memory->property("transitionState").toString() == "closed"
                        && settings->property("transitionState").toString() == "closed"
                        && std::abs(memory->property("progress").toDouble()) < .001
                        && std::abs(settings->property("progress").toDouble()) < .001,
                        "W4_BOOTSTRAP_DRAWER_WAS_NOT_CLOSED");
                    w4Evidence = {{"contextValidated", true}, {"localEvidence", selection.evidence},
                        {"scenario", selection.variant == "gpu-positive-control" ? "gpu-positive-control" : "drawer-cycles"},
                        {"archivePreopenPerformed", false}, {"historyRows", rows},
                        {"archiveInitializedAtModelReady", a->initialized()},
                        {"modelLifecycleScope", "Ordinary provider/model import and rights confirmation retained; no model unload; caller RuntimeBridge shutdown and disposable host cleanup remain responsible for cleanup"}};
                    stamp("w4-return-chat-without-memory-preopen");
                    click("nav-chat");step=7;
                } else { click("nav-memory");step=5; }
            } else if(step==5 && a->initialized() && open("drawer-memory")) {
                stamp("archive-ready");click("nav-chat");step=6;
            } else if(step==6 && item("persistentChat")->property("inputReady").toBool()) {
                stamp("ready-for-scenario");finish(true);ticking=false;return;
            } else if(step==7 && item("persistentChat")->property("inputReady").toBool()) {
                w4Evidence["archiveInitializedAtScenarioStart"] = a->initialized();
                w4Evidence["archiveInitializationScope"] = "Observed actual ArchiveEditor state without setting initialized; first measured memory header naturally calls Main.onEnteredFeature and archiveEditor.load when needed";
                stamp("w4-ready-without-memory-preopen");finish(true);ticking=false;return;
            }
        } catch(const std::exception &e) {finish(false,QString::fromUtf8(e.what()));}
        ticking=false;
    }
public:
    Bootstrap(QQuickWindow *window,RuntimeBridge *session,ArchiveEditor *archive,QString path,QString url,int n,std::function<void(bool,QVariantMap)> cb,bool localW4 = false)
        :QObject(window),w(window),s(session),a(archive),model(std::move(path)),endpoint(std::move(url)),rows(n),done(std::move(cb)),w4Local(localW4) {
        timer.setInterval(25);connect(&timer,&QTimer::timeout,this,[this]{tick();});elapsed.start();w->requestActivate();timer.start();
    }
};
}
void PerfBootstrap::run(QQuickWindow *w,RuntimeBridge *s,ArchiveEditor *a,const QString &model,const QString &url,int rows,std::function<void(bool,QVariantMap)> cb) {
#if defined(REVERIE_TIMING_DIAGNOSTICS) || defined(REVERIE_QML_PROFILER)
    if (SmoothnessCheck::requested()) {
        SmoothnessCheck::bootstrap(w, s, a, model, url, rows, std::move(cb));
        return;
    }
#endif
    const bool w4Local = HeaderFrameLocalCheck::requested();
    if (w4Local) {
        try { validateW4Bootstrap(rows); }
        catch (const std::exception &error) {
            const QString reason = QString::fromUtf8(error.what());
            QTimer::singleShot(0, [cb=std::move(cb),reason] {
                cb(false, {{"passed",false},{"error",reason},{"acceptanceEligible",false},
                    {"performanceComparable",false},{"w4LocalContextValidated",false},
                    {"scope","Invalid W4 local context rejected before bootstrap; no archive-preopen shortcut and no stress fallback"}});
            });
            return;
        }
    }
    new Bootstrap(w,s,a,model,url,rows,std::move(cb),w4Local);
}
