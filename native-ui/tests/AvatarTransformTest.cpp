#include "../src/AvatarTransform.h"
#include <QtTest>
#include <limits>

using namespace ReverieAvatar;
class AvatarTransformTest : public QObject {
    Q_OBJECT
  private slots:
    void coordinateRoundTrip_data() {
        QTest::addColumn<double>("width");
        QTest::addColumn<double>("height");
        QTest::addColumn<double>("dpr");
        QTest::newRow("regular") << 500. << 700. << 1.;
        QTest::newRow("retina") << 210. << 310. << 2.;
        QTest::newRow("fractional") << 769.5 << 451.25 << 1.5;
    }
    void coordinateRoundTrip() {
        QFETCH(double, width);
        QFETCH(double, height);
        QFETCH(double, dpr);
        Transform layout;
        QVERIFY(layout.captureBaseline({-2, -3, 4, 5}));
        QVERIFY(layout.configure(width, height, 1.2, {24, -18}));
        const Point modelPoint{2.1, 1.7};
        const auto item = layout.modelToItem(modelPoint);
        const auto roundTrip = layout.itemToModel(item);
        QVERIFY(std::abs(roundTrip.x - modelPoint.x) < 1e-9);
        QVERIFY(std::abs(roundTrip.y - modelPoint.y) < 1e-9);
        const double pw = std::round(width * dpr), ph = std::round(height * dpr);
        const auto pixel = layout.itemToFramebuffer(item, pw, ph);
        const auto matrix = layout.matrix();
        QVERIFY(std::abs(pixel.x / pw * 2 - 1 - modelPoint.x * matrix[0] - matrix[12]) < 1e-5);
        QVERIFY(std::abs(pixel.y / ph * 2 - 1 - modelPoint.y * matrix[5] - matrix[13]) < 1e-5);
    }
    void resizeKeepsModelAnchor() {
        Transform layout;
        QVERIFY(layout.captureBaseline({-2, -3, 4, 5}));
        const auto revision = layout.revision();
        const auto anchor = layout.modelAnchor();
        for (const auto size : {Point{500, 700}, Point{210, 310}, Point{769.5, 451.25}}) {
            QVERIFY(layout.configure(size.x, size.y));
            QCOMPARE(layout.revision(), revision);
            QCOMPARE(layout.modelAnchor().x, anchor.x);
            QCOMPARE(layout.modelAnchor().y, anchor.y);
            QCOMPARE(layout.bounds().top, 5.);
        }
        QVERIFY(layout.captureBaseline({-3, -4, 6, 8}));
        QCOMPARE(layout.revision(), revision + 1);
        QCOMPARE(layout.modelAnchor().y, -4.);
    }
    void invalidLayoutAndMeshHits() {
        Transform layout;
        QVERIFY(!layout.configure(500, 700));
        QVERIFY(!layout.captureBaseline({0, 0, 0, 1}));
        QVERIFY(layout.captureBaseline({-2, -3, 4, 5}));
        QVERIFY(!layout.configure(0, 700));
        QVERIFY(!layout.configure(500, 700, -1));
        QVERIFY(triangleContains({.2, .2}, {0, 0}, {1, 0}, {0, 1}));
        QVERIFY(triangleContains({.2, .2}, {0, 1}, {1, 0}, {0, 0}));
        QVERIFY(!triangleContains({.9, .9}, {0, 0}, {1, 0}, {0, 1}));
        QVERIFY(!triangleContains({.2, .2}, {0, 0}, {1, 0}, {2, 0}));
        QVERIFY(!triangleContains({std::numeric_limits<double>::quiet_NaN(), .2}, {0, 0}, {1, 0},
                                  {0, 1}));
    }
};
QTEST_GUILESS_MAIN(AvatarTransformTest)
#include "AvatarTransformTest.moc"
