#include "../src/AvatarTransform.h"
#include <cstdlib>
#include <iostream>

using namespace ReverieAvatar;
static void require(bool value, const char *message) {
    if (!value) {
        std::cerr << message << '\n';
        std::exit(1);
    }
}
static bool near(double a, double b) { return std::abs(a - b) < 1e-5; }
int main() {
    Transform layout;
    require(!layout.configure(500, 700), "uncaptured layout was accepted");
    require(!layout.captureBaseline({0, 0, 0, 1}), "empty bounds were accepted");
    require(layout.captureBaseline({-2, -3, 4, 5}), "baseline capture failed");
    const auto baseline = layout.bounds();
    const auto anchor = layout.modelAnchor();
    const auto revision = layout.revision();
    for (const auto size : {Point{500, 700}, Point{210, 310}, Point{769.5, 451.25}}) {
        require(layout.configure(size.x, size.y), "logical layout failed");
        const Point modelPoint{2.1, 1.7};
        const auto itemPoint = layout.modelToItem(modelPoint);
        const auto roundTrip = layout.itemToModel(itemPoint);
        require(near(roundTrip.x, modelPoint.x) && near(roundTrip.y, modelPoint.y),
                "model-item round trip failed");
        for (double dpr : {1., 1.5, 2.}) {
            const double pw = std::round(size.x * dpr), ph = std::round(size.y * dpr);
            const auto pixel = layout.itemToFramebuffer(itemPoint, pw, ph);
            const auto matrix = layout.matrix();
            require(near(pixel.x / pw * 2 - 1, modelPoint.x * matrix[0] + matrix[12]) &&
                        near(pixel.y / ph * 2 - 1, modelPoint.y * matrix[5] + matrix[13]),
                    "render matrix disagrees with logical/pixel conversion");
        }
        require(layout.revision() == revision && layout.modelAnchor().x == anchor.x &&
                    layout.modelAnchor().y == anchor.y && layout.bounds().top == baseline.top,
                "resize changed model baseline or anchor");
    }
    require(layout.configure(500, 700, 1.2, {24, -18}), "view transform failed");
    const auto viewAnchor = layout.modelToItem(anchor);
    require(near(viewAnchor.x, 274) && near(viewAnchor.y, 657.5), "view anchor is wrong");
    require(!layout.configure(0, 700), "zero viewport was accepted");
    require(layout.captureBaseline({-4, -5, 3, 6}) && layout.revision() == revision + 1,
            "explicit refit did not advance baseline revision");
    require(triangleContains({.2, .2}, {0, 0}, {1, 0}, {0, 1}), "mesh hit missed");
    require(!triangleContains({.9, .9}, {0, 0}, {1, 0}, {0, 1}), "mesh hit overreached");
    require(!triangleContains({.2, .2}, {0, 0}, {1, 0}, {2, 0}), "degenerate mesh hit");
    std::cout << "AVATAR_TRANSFORM_PASS\n";
}
