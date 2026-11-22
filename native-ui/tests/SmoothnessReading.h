#pragma once
// W20 diagnostic-only. No forceLayout, item mutation, text or message IDs.
#include <QCoreApplication>
#include <QElapsedTimer>
#include <QQuickItem>
#include <QThread>
#include <QVariantMap>
#include <algorithm>
#include <array>
#include <atomic>
#include <cmath>

namespace SmoothnessReading {
constexpr size_t Capacity=128;
struct Row { int index=-1; double y=0,height=0; };
struct Reading { int pairs=0, badPairs=0; int left=-1,right=-1; double gap=0; bool invalid=false; };
inline Reading classify(std::array<Row,Capacity> rows, size_t count, double spacing) {
    Reading result;
    if(count>Capacity || !std::isfinite(spacing)){result.invalid=true;return result;}
    std::sort(rows.begin(),rows.begin()+count,[](const Row&a,const Row&b){return a.index<b.index;});
    for(size_t i=0;i<count;++i) {
        if(rows[i].index<0 || !std::isfinite(rows[i].y) || !std::isfinite(rows[i].height) || rows[i].height<0)result.invalid=true;
        if(i && rows[i].index==rows[i-1].index)result.invalid=true;
        if(i && rows[i].index==rows[i-1].index+1) {
            ++result.pairs;
            const double gap=rows[i].y-(rows[i-1].y+rows[i-1].height+spacing);
            if(std::abs(gap)>=1){if(!result.badPairs){result.left=rows[i-1].index;result.right=rows[i].index;result.gap=gap;}++result.badPairs;}
        }
    }
    return result;
}
class Observer {
    QQuickItem *chat,*history;
    quint64 observed=0,consistent=0,inconsistent=0,unavailable=0,invalid=0,overflow=0;
    std::atomic<quint64> unsafeThread{0};
    qint64 costNs=0,maximumNs=0;
    QVariantMap first;
    bool enabled=false;
public:
    Observer(QQuickItem *c,QQuickItem *h):chat(c),history(h){}
    void setEnabled(bool value){enabled=value;}
    void sample() {
        // QQuickItem properties are never touched on a render worker.
        if(QThread::currentThread()!=QCoreApplication::instance()->thread()){++unsafeThread;return;}
        if(!enabled || !chat || !history || !chat->property("expandedHistory").toBool())return;
        QElapsedTimer timer;timer.start();
        auto *content=history->property("contentItem").value<QQuickItem *>();
        if(!content){++invalid;return;}
        std::array<Row,Capacity> rows{};size_t count=0;bool truncated=false;
        // Only direct instantiated delegates; no recursive discovery or text reads.
        for(auto *item:content->childItems()) {
            if(!item->objectName().startsWith("chatMessageRow-"))continue;
            if(count==Capacity){truncated=true;continue;}
            bool ok=false;const int index=item->property("index").toInt(&ok);
            if(!ok){++invalid;continue;}
            rows[count++]={index,item->y(),item->height()};
        }
        const auto spacing=history->property("spacing").toDouble();
        const auto reading=classify(rows,count,spacing);++observed;
        if(truncated)++overflow;
        if(reading.invalid)++invalid;
        else if(reading.badPairs) {
            ++inconsistent;
            if(first.isEmpty()) {
                QVariantList values;
                for(size_t i=0;i<count;++i)values.append(QVariantMap{{"index",rows[i].index},{"y",rows[i].y},{"height",rows[i].height}});
                first={{"observedFrame",qulonglong(observed)},{"rows",values},{"spacing",spacing},
                    {"firstLeft",reading.left},{"firstRight",reading.right},{"gap",reading.gap},
                    {"contentY",history->property("contentY")},{"restorePending",chat->property("layoutRestorePending")},
                    {"readingBodyOpacity",chat->property("readingBodyOpacity")}};
            }
        } else if(reading.pairs)++consistent;
        else ++unavailable;
        const auto elapsed=timer.nsecsElapsed();costNs+=elapsed;maximumNs=std::max(maximumNs,elapsed);
    }
    QVariantMap snapshot() const {
        return {{"stage","beforeRendering"},{"frames",qulonglong(observed)},
            {"consistent",qulonglong(consistent)},{"inconsistent",qulonglong(inconsistent)},
            {"unavailable",qulonglong(unavailable)},{"invalidReads",qulonglong(invalid)},
            {"rowCapacity",int(Capacity)},{"overflowFrames",qulonglong(overflow)},
            {"skippedUnsafeRenderThread",qulonglong(unsafeThread.load())},{"firstInconsistent",first},
            {"observerTotalNs",costNs},{"observerMaximumNs",maximumNs},
            {"scope","Adjacent instantiated indices only; a frame callback does not prove physical scanout. Threaded property traversal is skipped."}};
    }
};
}
