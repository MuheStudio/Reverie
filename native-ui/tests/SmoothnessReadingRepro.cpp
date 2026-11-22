#include "SmoothnessReading.h"
#include "SmoothnessTargets.h"
#include "SmoothnessVariant.h"
#include "SmoothnessEnvironment.h"
#include <QGuiApplication>
#include <QFileInfo>
#include <QSurfaceFormat>
#include <stdexcept>
#include <QJsonDocument>
#include <QJsonArray>
#include <QQmlComponent>
#include <QQmlContext>
#include <QQmlEngine>
#include <QQuickStyle>
#include <QQuickWindow>
#include <QSaveFile>
#include <QTest>
#include <cstdio>
#include <memory>
class FixtureSession final : public QObject {
    Q_OBJECT
    Q_PROPERTY(QVariantList messages READ messages NOTIFY messagesChanged)
    Q_PROPERTY(QVariantMap state READ state NOTIFY changed)
    Q_PROPERTY(QVariantMap chatFeedback READ chatFeedback NOTIFY changed)
    Q_PROPERTY(bool busy READ busy NOTIFY changed)
    Q_PROPERTY(bool connected READ connected NOTIFY changed)
    Q_PROPERTY(QString draft READ draft WRITE setDraft NOTIFY changed)
    Q_PROPERTY(bool reducedMotion READ reducedMotion CONSTANT)
    Q_PROPERTY(bool reducedTransparency READ reducedTransparency CONSTANT)
public:
    QVariantList messages() const { return m_messages; }
    void setMessages(QVariantList messages) {
        m_messages = std::move(messages);
        emit messagesChanged();
    }
    QVariantMap state() const { return m_state; }
    void setOffline(bool value) { m_state["offline"] = value; emit changed(); }
    QVariantMap chatFeedback() const { return m_chatFeedback; }
    void setChatFeedback(const QVariantMap &feedback) {
        m_chatFeedback = feedback;
        emit changed();
    }
    bool busy() const { return m_busy; }
    void setBusy(bool value) { m_busy = value; emit changed(); }
    bool connected() const { return true; }
    QString draft() const { return m_draft; }
    void setDraft(const QString &draft) {
        if (draft == m_draft) return;
        m_draft = draft;
        emit changed();
    }
    bool reducedMotion() const { return false; }
    bool reducedTransparency() const { return false; }
    Q_INVOKABLE void sendChat() {}
    Q_INVOKABLE void cancelChat() {}
signals:
    void messagesChanged();
    void changed();

private:
    QVariantList m_messages;
    QString m_draft;
    QVariantMap m_chatFeedback;
    QVariantMap m_state;
    bool m_busy = false;
};


static QVariantList conversation(int count) {
    QVariantList rows;
    for(int i=0;i<count;++i) rows.append(QVariantMap{{"id",QString("w20-%1").arg(i)},
        {"role",i%2?"assistant":"user"},{"content",QString("固定诊断夹具 %1。用于排版，不来自用户数据。\n").arg(i).repeated(i%2?6:1)}});
    return rows;
}
static int unit() {
    using namespace SmoothnessReading;
    std::array<Row,Capacity> rows{};
    const auto check=[](bool ok){if(!ok)throw std::runtime_error("SMOOTHNESS_READING_UNIT");};
    rows[0]={0,0,50};rows[1]={1,55,50};rows[2]={2,110,50};
    check(classify(rows,3,5).badPairs==0&&classify(rows,3,5).pairs==2);
    rows[1].y=0;check(classify(rows,3,5).badPairs==2);
    rows[1].y=55.9;check(classify(rows,3,5).badPairs==0);
    rows[1].y=56;check(classify(rows,3,5).badPairs==2);
    rows[1]={4,0,50};check(classify(rows,2,5).pairs==0);
    rows[1]=rows[0];check(classify(rows,2,5).invalid);
    check(classify(rows,Capacity+1,5).invalid);
    QQuickItem root, hidden(&root), disabled(&root), active(&root);
    hidden.setVisible(false);disabled.setEnabled(false);
    QQuickItem h(&hidden),d(&disabled),a(&active);
    for(auto *item:{&h,&d,&a})item->setObjectName("duplicate");
    check(SmoothnessTargets::find(&root,"duplicate")==&h);
    check(SmoothnessTargets::find(&root,"duplicate",true)==&a);
    puts("{\"passed\":true,\"cases\":8}");return 0;
}

static int variantUnit() {
    QQmlEngine engine;
    QQmlComponent component(&engine);
    component.setData("import QtQuick\nQtObject { property var surfaces: [1, 2, 3] }", QUrl());
    std::unique_ptr<QObject> item(component.create());
    if(!item || SmoothnessVariant::surfaceCount(item.get())!=3)return 1;
    SmoothnessVariant::disableDrawerBackground(item.get());
    if(SmoothnessVariant::surfaceCount(item.get())!=0)return 1;
    item->setProperty("surfaces",QVariant::fromValue(engine.newObject()));
    bool refused=false;
    try{SmoothnessVariant::surfaceCount(item.get());}catch(const std::runtime_error &){refused=true;}
    if(!refused)return 1;
    QObject noContext;refused=false;
    try{SmoothnessVariant::disableDrawerBackground(&noContext);}catch(const std::runtime_error &){refused=true;}
    if(!refused)return 1;
    QQmlComponent fixed(&engine);
    fixed.setData("import QtQuick\nQtObject { readonly property var surfaces: [1, 2, 3] }", QUrl());
    std::unique_ptr<QObject> fixedItem(fixed.create());if(!fixedItem)return 1;
    refused=false;
    try{SmoothnessVariant::disableDrawerBackground(fixedItem.get());}catch(const std::runtime_error &){refused=true;}
    if(!refused)return 1;
    puts("{\"passed\":true,\"cases\":4}");return 0;
}

static int environmentUnit() {
    using namespace SmoothnessEnvironment;
    QQmlEngine engine;QQmlComponent component(&engine);
    component.setData("import QtQuick\nItem { objectName: 'moonroomEnvironmentShader'; width: 100; height: 60; layer.enabled: true; layer.textureSize: Qt.size(width * 2, height * 2); layer.smooth: false; property url fragmentShader: 'qrc:/fixture' }", QUrl());
    const auto make=[&] { return std::unique_ptr<QQuickItem>(qobject_cast<QQuickItem *>(component.create())); };
    int stage=0;
    const auto check=[&](bool ok){if(!ok)throw std::runtime_error("ENVIRONMENT_UNIT_STAGE_"+std::to_string(stage));};
    auto target=make(),other=make();check(target&&other);const auto original=read(target.get()),untouched=read(other.get());
    stage=1;auto proof=apply(target.get(),"baseline");check(proof["before"]==proof["applied"]);
    stage=2;proof=apply(target.get(),"environment-hidden");check(!target->isVisible());validate(original,read(target.get()),"environment-hidden");
    target=make();stage=3;proof=apply(target.get(),"environment-half");auto after=read(target.get());check(after["textureWidth"].toInt()==100&&after["textureHeight"].toInt()==60&&after["smooth"].toBool());
    stage=4;write(target.get(),"layer.textureSize",QSize(200,120));bool refused=false;try{validate(original,read(target.get()),"environment-half");}catch(...){refused=true;}check(refused);
    target=make();apply(target.get(),"environment-half");stage=5;write(target.get(),"layer.smooth",false);refused=false;try{validate(original,read(target.get()),"environment-half");}catch(...){refused=true;}check(refused);
    target=make();write(target.get(),"layer.textureSize",QSize(201,120));const auto odd=read(target.get());stage=6;refused=false;try{apply(target.get(),"environment-half");}catch(...){refused=true;}check(refused&&read(target.get())==odd);
    target=make();target->setObjectName("wrong-target");stage=7;refused=false;try{apply(target.get(),"baseline");}catch(...){refused=true;}check(refused);
    stage=8;check(read(other.get())==untouched);
    target=make();apply(target.get(),"environment-half");target->setX(1);stage=9;refused=false;try{validate(original,read(target.get()),"environment-half");}catch(...){refused=true;}check(refused);
    stage=10;ScreenshotGate gate;refused=false;try{gate.arm(10,10,false);}catch(...){refused=true;}check(refused);
    gate.arm(10,12,true);gate.swapped(11);check(!gate.ready());gate.swapped(13);check(!gate.ready());gate.swapped(13);check(!gate.ready());
    refused=false;try{gate.consume(14,true);}catch(...){refused=true;}check(refused);gate.swapped(15);check(gate.ready());
    const auto capture=gate.consume(16,true);check(capture["naturalFramesAfterStable"].toInt()==2&&capture["firstNaturalSwapNs"].toLongLong()==13);
    refused=false;try{gate.consume(17,true);}catch(...){refused=true;}check(refused);
    puts("{\"passed\":true,\"cases\":10}");return 0;
}
int main(int argc,char **argv) {
    if(argc==2&&QString::fromLocal8Bit(argv[1])=="--environment-unit") {
        QGuiApplication app(argc,argv);try{return environmentUnit();}catch(const std::exception &e){fprintf(stderr,"%s\n",e.what());return 1;}
    }
    if(argc==2&&QString::fromLocal8Bit(argv[1])=="--variant-unit") {
        QGuiApplication app(argc,argv);try{return variantUnit();}catch(...){return 1;}
    }
    if(argc==2&&QString::fromLocal8Bit(argv[1])=="--unit") {
        QGuiApplication app(argc,argv);try{return unit();}catch(...){return 1;}
    }
    QQuickStyle::setStyle("Basic");
    QQuickWindow::setGraphicsApi(QSGRendererInterface::OpenGL);
    QSurfaceFormat format;format.setVersion(2,1);format.setProfile(QSurfaceFormat::NoProfile);QSurfaceFormat::setDefaultFormat(format);
    QGuiApplication app(argc,argv);
    if(app.arguments().size()!=2)return 2;
    const auto output=app.arguments()[1];if(QFileInfo::exists(output))return 2;
    FixtureSession session;session.setMessages(conversation(300));
    QQmlEngine engine;engine.rootContext()->setContextProperty("session",&session);
    QQmlComponent component(&engine,QUrl("qrc:/chat-virtualization/ChatPanelVirtualizationFixture.qml"));
    QQuickWindow window;window.resize(1380,900);
    std::unique_ptr<QQuickItem> root(qobject_cast<QQuickItem *>(component.create()));
    if(!root){fprintf(stderr,"SMOOTHNESS_REPRO_COMPONENT\n");return 3;}
    root->setParentItem(window.contentItem());
    auto *chat=root->findChild<QQuickItem *>("fixtureChat"),*history=root->findChild<QQuickItem *>("chatHistory");
    auto *director=root->findChild<QObject *>("fixtureDirector");
    if(!chat||!history||!director)return 3;
    SmoothnessReading::Observer observer(chat,history);observer.setEnabled(true);
    QObject::connect(&window,&QQuickWindow::beforeRendering,&window,[&]{observer.sample();},Qt::DirectConnection);
    window.show();if(!QTest::qWaitForWindowExposed(&window))return 3;
    QVariantList paths;
    const auto transition=[&](bool expanded) {
        director->setProperty("chatInputReady",false);director->setProperty("readBodyOpacity",0.);
        director->setProperty("readBlend",.5);director->setProperty("mode",expanded?"reading":"companion");
        director->setProperty("chatLayoutReading",expanded);QTest::qWait(60);
        director->setProperty("readBlend",expanded?1.:0.);director->setProperty("readBodyOpacity",1.);
        director->setProperty("chatInputReady",true);
    };
    // Fixed sequence once. Every write is to the new fixture session/director,
    // never to a product delegate y/height or the list's contentY.
    transition(true);QTest::qWait(200);
    for(int round=0;round<4;++round) {
        for(int i=0;i<12;++i){QTest::wheelEvent(&window,history->mapToScene(QPointF(300,200)),QPoint(0,240));QTest::qWait(50);}
        auto rows=conversation(300);session.setMessages(rows);QTest::qWait(200);
        rows.append(QVariantMap{{"id",QString("w20-new-%1").arg(round)},{"role","assistant"},{"content","固定回复夹具。"}});
        session.setMessages(rows);QTest::qWait(200);
        transition(false);QTest::qWait(200);transition(true);QTest::qWait(200);
        paths.append(QVariantMap{{"round",round},{"modelReset",true},{"appendReply",true},{"readingReturn",true}});
    }
    QTest::qWait(300);observer.setEnabled(false);const auto reading=observer.snapshot();
    const QVariantMap report{{"schema","reverie.qt.smoothness.reading-reproduction.v1"},{"diagnostic",true},
        {"passed",true},{"acceptanceEligible",false},{"reproducedAtBeforeRendering",reading["inconsistent"].toULongLong()>0},
        {"readingAdjacency",reading},{"paths",paths},{"productMutation",false},
        {"scope","Synthetic inert session with the product ChatPanel, OpenGL basic; one fixed sequence, not the full backend or SceneDirector."}};
    QSaveFile file(output);if(!file.open(QIODevice::WriteOnly)||file.write(QJsonDocument::fromVariant(report).toJson())<0||!file.commit())return 4;
    window.close();return 0;
}
#include "SmoothnessReadingRepro.moc"
