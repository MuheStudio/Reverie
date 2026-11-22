#pragma once
#include <QQuickItem>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQmlProperty>
#include <QSize>
#include <QUrl>
#include <QVariantMap>
#include <cmath>
#include <stdexcept>

namespace SmoothnessEnvironment {
inline void require(bool value,const char *code){if(!value)throw std::runtime_error(code);}
inline QVariant property(QQuickItem *item,const QString &name) {
    QQmlProperty p(item,name,QQmlEngine::contextForObject(item));
    require(p.isValid()&&p.isProperty(),"ENVIRONMENT_PROPERTY_UNAVAILABLE");
    const auto value=p.read();require(value.isValid(),"ENVIRONMENT_PROPERTY_UNREADABLE");return value;
}
inline void write(QQuickItem *item,const QString &name,const QVariant &value) {
    QQmlProperty p(item,name,QQmlEngine::contextForObject(item));
    require(p.isValid()&&p.isWritable()&&p.write(value),"ENVIRONMENT_PROPERTY_WRITE_FAILED");
}
inline QVariantMap read(QQuickItem *item) {
    require(item&&item->objectName()=="moonroomEnvironmentShader","ENVIRONMENT_TARGET_REQUIRED");
    const auto texture=property(item,"layer.textureSize").toSize();
    return {{"objectName",item->objectName()},{"visible",item->isVisible()},
        {"x",item->x()},{"y",item->y()},{"width",item->width()},{"height",item->height()},
        {"layerEnabled",property(item,"layer.enabled")},{"textureWidth",texture.width()},
        {"textureHeight",texture.height()},{"smooth",property(item,"layer.smooth")},
        {"fragmentShader",property(item,"fragmentShader").toUrl().toString()}};
}
inline void validate(const QVariantMap &before,const QVariantMap &after,const QString &variant) {
    require(variant=="baseline"||variant=="environment-hidden"||variant=="environment-half","ENVIRONMENT_VARIANT");
    require(before.value("visible").toBool()&&before.value("layerEnabled").toBool()&&
        before.value("textureWidth").toInt()>0&&before.value("textureHeight").toInt()>0,
        "ENVIRONMENT_BASELINE_REQUIRED");
    const bool half=variant=="environment-half";
    if(half)require(before.value("textureWidth").toInt()%2==0&&before.value("textureHeight").toInt()%2==0,
        "ENVIRONMENT_EXACT_HALF_REQUIRED");
    require(after.value("visible").toBool()==(variant!="environment-hidden")&&
        after.value("textureWidth").toInt()==before.value("textureWidth").toInt()/(half?2:1)&&
        after.value("textureHeight").toInt()==before.value("textureHeight").toInt()/(half?2:1)&&
        after.value("smooth").toBool()==(half?true:before.value("smooth").toBool()),"ENVIRONMENT_VARIANT_READBACK");
    for(const char *key:{"objectName","x","y","width","height","layerEnabled","fragmentShader"})
        require(after.value(key)==before.value(key),"ENVIRONMENT_UNREQUESTED_PROPERTY_CHANGE");
}
inline QVariantMap apply(QQuickItem *item,const QString &variant) {
    const auto before=read(item);
    // Validate baseline and exact halving before the first write.
    validate(before,before,"baseline");
    require(variant=="baseline"||variant=="environment-hidden"||variant=="environment-half","ENVIRONMENT_VARIANT");
    if(variant=="environment-hidden")item->setVisible(false);
    else if(variant=="environment-half") {
        require(before["textureWidth"].toInt()%2==0&&before["textureHeight"].toInt()%2==0,"ENVIRONMENT_EXACT_HALF_REQUIRED");
        write(item,"layer.textureSize",QSize(before["textureWidth"].toInt()/2,before["textureHeight"].toInt()/2));
        write(item,"layer.smooth",true);
    }
    const auto applied=read(item);validate(before,applied,variant);
    return {{"variant",variant},{"before",before},{"applied",applied},
        {"writes",variant=="environment-hidden"?QStringList{"visible"}:variant=="environment-half"?QStringList{"layer.textureSize","layer.smooth"}:QStringList{}},
        {"scope","Only the named environment shader item is changed. Texture dimensions are requested property readbacks, not measured GPU allocation."}};
}
// Passive screenshot gate. It neither requests a frame nor waits synchronously.
class ScreenshotGate {
    qint64 stop=-1,stable=-1,first=-1,last=-1;
    int swaps=0;
    bool armed=false,consumed=false;
public:
    void arm(qint64 stopped,qint64 stableAt,bool recordsStopped) {
        require(!armed&&!consumed&&recordsStopped&&stopped>=0&&stableAt>=stopped,"ENVIRONMENT_CAPTURE_BEFORE_STOP");
        stop=stopped;stable=stableAt;armed=true;
    }
    void swapped(qint64 time) {
        if(!armed||consumed||time<stable||time<=last)return;
        if(!swaps)first=time;
        last=time;++swaps;
    }
    bool ready() const{return armed&&!consumed&&swaps>=2;}
    QVariantMap consume(qint64 begin,bool recordsStopped) {
        require(ready()&&recordsStopped&&begin>=last,"ENVIRONMENT_CAPTURE_NOT_READY");
        consumed=true;armed=false;
        return {{"timingStopped",true},{"recordsStopped",true},{"recordingStoppedNs",stop},
            {"companionStableNs",stable},{"firstNaturalSwapNs",first},{"lastNaturalSwapNs",last},
            {"naturalFramesAfterStable",swaps},{"grabBeginNs",begin}};
    }
};
}
