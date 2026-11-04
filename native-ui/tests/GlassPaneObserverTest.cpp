#include <QGuiApplication>
#include <QJSValue>
#include <QLineF>
#include <QQmlComponent>
#include <QQmlEngine>
#include <QPointer>
#include <QQuickItem>
#include <QQuickStyle>
#include <QTest>
#include <QVector2D>
#include <memory>

class GlassPaneObserverTest final : public QObject {
    Q_OBJECT
    static QVariant value(QVariant v) {
        return v.metaType() == QMetaType::fromType<QJSValue>() ? v.value<QJSValue>().toVariant() : v;
    }
    static QObject *object(QVariant v) { return value(v).value<QObject *>(); }
    static bool mapped(QQuickItem *pane, QQuickItem *scene) {
        auto *material = qobject_cast<QQuickItem *>(object(pane->property("background")));
        if (!pane->property("sampleMappingValid").toBool() || !material || material->width() <= 0 || material->height() <= 0) return false;
        const auto rect = pane->property("sceneSampleRect").toRectF();
        const auto origin = pane->property("sampleOrigin").value<QVector2D>();
        const auto x = pane->property("sampleAxisX").value<QVector2D>();
        const auto y = pane->property("sampleAxisY").value<QVector2D>();
        for (const auto &corner : {QPointF(0, 0), QPointF(1, 0), QPointF(0, 1), QPointF(1, 1)}) {
            const auto actual = material->mapToItem(scene, QPointF(material->width() * corner.x(), material->height() * corner.y()));
            const QPointF reconstructed(rect.x() + (origin.x() + corner.x() * x.x() + corner.y() * y.x()) * rect.width(),
                                        rect.y() + (origin.y() + corner.x() * x.y() + corner.y() * y.y()) * rect.height());
            if (QLineF(actual, reconstructed).length() > .1) return false;
        }
        return true;
    }
private slots:
    void sourceGateAndRealMapping() {
        QQuickStyle::setStyle("Basic");
        QQmlEngine engine;
        QQmlComponent component(&engine, QUrl("qrc:/glass-observer/GlassPaneObserverFixture.qml"));
        QVERIFY2(!component.isError(), qPrintable(component.errorString()));
        std::unique_ptr<QObject> root(component.create());
        QVERIFY2(root, qPrintable(component.errorString()));
        auto *pane = root->findChild<QQuickItem *>("test-pane");
        auto *scene = root->findChild<QQuickItem *>("test-scene-root");
        auto *first = root->findChild<QQuickItem *>("test-ancestor-first");
        auto *second = root->findChild<QQuickItem *>("test-ancestor-second");
        auto *capture = root->findChild<QObject *>("test-scene-source");
        auto *otherCapture = root->findChild<QObject *>("test-scene-source-second");
        QVERIFY(pane && scene && first && second && capture && otherCapture);
        QVERIFY(!pane->window()); // No afterAnimating fallback exists in this fixture.
        QObject *observer = nullptr;
        for (auto *candidate : pane->findChildren<QObject *>()) {
            const auto *meta = candidate->metaObject();
            if (meta->indexOfProperty("count") >= 0 && meta->indexOfProperty("model") >= 0
                    && meta->indexOfMethod("objectAt(int)") >= 0) { observer = candidate; break; }
        }
        QVERIFY2(observer, "Existing Instantiator public count/objectAt interface unavailable");
        const auto count = [&] { return observer->property("count").toInt(); };
        const auto chain = [&] { return value(pane->property("coordinateItems")).toList(); };
        const auto contains = [&](QObject *item) { for (const auto &v : chain()) if (object(v) == item) return true; return false; };
        QTRY_COMPARE(count(), 0); // No source and no root: no ancestor observers.
        pane->setProperty("sceneSource", QVariant::fromValue(capture));
        QTRY_COMPARE(count(), 0); // A source without a root is also insufficient.
        pane->setProperty("sceneRoot", QVariant::fromValue(scene));
        QTRY_VERIFY(count() > 0);
        QTRY_COMPARE(count(), int(chain().size()));
        for (int i = 0; i < count(); ++i) {
            QObject *connection = nullptr;
            QVERIFY(QMetaObject::invokeMethod(observer, "objectAt", Q_RETURN_ARG(QObject *, connection), Q_ARG(int, i)));
            QVERIFY(connection);
            QCOMPARE(object(connection->property("target")), object(chain()[i]));
        }
        QTRY_VERIFY(mapped(pane, scene));
        pane->setProperty("sceneSource", QVariant::fromValue<QObject *>(nullptr));
        QTRY_COMPARE(count(), 0);
        pane->setProperty("sceneSource", QVariant::fromValue(capture));
        QTRY_VERIFY(count() > 0);
        pane->setProperty("sceneRoot", QVariant::fromValue<QQuickItem *>(nullptr));
        QTRY_COMPARE(count(), 0);
        pane->setProperty("sceneRoot", QVariant::fromValue(scene));
        QTRY_VERIFY(mapped(pane, scene));
        const auto before = pane->property("sampleOrigin").value<QVector2D>();
        first->setX(first->x() + 37); first->setY(first->y() + 19);
        QTRY_VERIFY(pane->property("sampleOrigin").value<QVector2D>() != before);
        first->setRotation(17); first->setScale(1.08);
        QTRY_VERIFY(mapped(pane, scene));
        scene->setX(scene->x() + 9); scene->setRotation(-6);
        QTRY_VERIFY(mapped(pane, scene));
        pane->setParentItem(second);
        QTRY_VERIFY(contains(second) && !contains(first));
        QTRY_VERIFY(mapped(pane, scene));
        const auto reparented = pane->property("sampleOrigin").value<QVector2D>();
        second->setX(second->x() + 23);
        QTRY_VERIFY(pane->property("sampleOrigin").value<QVector2D>() != reparented);
        QTRY_VERIFY(mapped(pane, scene));
        capture->setProperty("sourceItem", QVariant::fromValue<QQuickItem *>(pane));
        QTRY_VERIFY(!pane->property("sampleMappingValid").toBool());
        capture->setProperty("sourceItem", QVariant::fromValue<QQuickItem *>(second));
        QTRY_VERIFY(!pane->property("sampleMappingValid").toBool());
        capture->setProperty("sourceItem", QVariant::fromValue<QQuickItem *>(scene));
        QTRY_VERIFY(mapped(pane, scene));
        const auto validCount = count();
        pane->setVisible(false); pane->setOpacity(0);
        QCOMPARE(count(), validCount); // No added opacity/visibility gate.
        second->setY(second->y() + 11);
        QTRY_VERIFY(mapped(pane, scene));
        // Restore current geometry synchronously after either input was absent.
        for (bool missingSource : {true, false}) {
            pane->setProperty(missingSource ? "sceneSource" : "sceneRoot",
                              missingSource ? QVariant::fromValue<QObject *>(nullptr) : QVariant::fromValue<QQuickItem *>(nullptr));
            QTRY_COMPARE(count(), 0);
            auto *parent = missingSource ? first : second;
            pane->setParentItem(parent);
            parent->setX(parent->x() + 31); parent->setRotation(parent->rotation() + 9);
            pane->setProperty(missingSource ? "sceneSource" : "sceneRoot",
                              missingSource ? QVariant::fromValue(capture) : QVariant::fromValue(scene));
            QVERIFY(mapped(pane, scene)); // Assert before processing any events.
            QVERIFY(contains(parent));
            const auto restored = pane->property("sampleOrigin").value<QVector2D>();
            parent->setY(parent->y() + 17);
            QVERIFY(pane->property("sampleOrigin").value<QVector2D>() != restored);
            QVERIFY(mapped(pane, scene));
        }
        QList<QPointer<QObject>> oldConnections;
        for (int i = 0; i < count(); ++i) {
            QObject *connection = nullptr;
            QVERIFY(QMetaObject::invokeMethod(observer, "objectAt", Q_RETURN_ARG(QObject *, connection), Q_ARG(int, i)));
            oldConnections.append(connection);
        }
        const auto previousChain = chain();
        const int previousCount = count();
        pane->setProperty("sceneSource", QVariant::fromValue(otherCapture));
        QVERIFY(mapped(pane, scene)); // Both captures sample this same root.
        QCOMPARE(chain(), previousChain);
        QTRY_COMPARE(count(), previousCount);
        int retained = 0;
        for (int i = 0; i < count(); ++i) {
            QObject *connection = nullptr;
            QVERIFY(QMetaObject::invokeMethod(observer, "objectAt", Q_RETURN_ARG(QObject *, connection), Q_ARG(int, i)));
            QVERIFY(connection);
            QCOMPARE(object(connection->property("target")), object(chain()[i]));
            for (const auto &old : oldConnections) if (old.data() == connection) { ++retained; break; }
        }
        qInfo("valid-source swap: observers=%d retained=%d rebuilt=%d", count(), retained, count() - retained);
        const auto swapped = pane->property("sampleOrigin").value<QVector2D>();
        second->setX(second->x() + 13);
        QVERIFY(pane->property("sampleOrigin").value<QVector2D>() != swapped);
        QVERIFY(mapped(pane, scene));
    }
};
QTEST_MAIN(GlassPaneObserverTest)
#include "GlassPaneObserverTest.moc"
