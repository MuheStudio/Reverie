#pragma once

#include <algorithm>
#include <array>
#include <cmath>

// Cubism model Y points up. Qt Quick input uses logical item pixels and Y
// points down. Framebuffer pixels affect rasterization, never model fitting.
namespace ReverieAvatar {
struct Point {
    double x = 0;
    double y = 0;
};
struct Bounds {
    double left = 0, bottom = 0, right = 0, top = 0;
    bool valid() const {
        return std::isfinite(left) && std::isfinite(bottom) && std::isfinite(right) &&
               std::isfinite(top) && right > left && top > bottom;
    }
};
class Transform {
  public:
    bool captureBaseline(Bounds bounds) {
        if (!bounds.valid())
            return false;
        m_bounds = bounds;
        m_anchor = {(bounds.left + bounds.right) / 2, bounds.bottom};
        ++m_revision;
        return true;
    }
    bool configure(double width, double height, double viewScale = 1, Point viewOffset = {}) {
        m_width = width;
        m_height = height;
        m_valid = m_bounds.valid() && std::isfinite(width) && width > 0 && std::isfinite(height) &&
                  height > 0 && std::isfinite(viewScale) && viewScale > 0 &&
                  std::isfinite(viewOffset.x) && std::isfinite(viewOffset.y);
        if (!m_valid)
            return false;
        m_scale = std::min(.93 * width / (m_bounds.right - m_bounds.left),
                           .93 * height / (m_bounds.top - m_bounds.bottom)) *
                  viewScale;
        // SceneDirector.actorFootRatio places the astrolabe at this base line.
        m_itemAnchor = {width / 2 + viewOffset.x, height * .965 + viewOffset.y};
        return true;
    }
    bool valid() const { return m_valid; }
    unsigned revision() const { return m_revision; }
    Bounds bounds() const { return m_bounds; }
    Point modelAnchor() const { return m_anchor; }
    Point itemAnchor() const { return m_itemAnchor; }
    double scale() const { return m_scale; }
    Point modelToItem(Point point) const {
        return {m_itemAnchor.x + (point.x - m_anchor.x) * m_scale,
                m_itemAnchor.y - (point.y - m_anchor.y) * m_scale};
    }
    Point itemToModel(Point point) const {
        return {m_anchor.x + (point.x - m_itemAnchor.x) / m_scale,
                m_anchor.y - (point.y - m_itemAnchor.y) / m_scale};
    }
    Point itemToFramebuffer(Point point, double pixelWidth, double pixelHeight) const {
        return {point.x * pixelWidth / m_width, (m_height - point.y) * pixelHeight / m_height};
    }
    std::array<float, 16> matrix() const {
        const double sx = 2 * m_scale / m_width, sy = 2 * m_scale / m_height;
        return {float(sx),
                0,
                0,
                0,
                0,
                float(sy),
                0,
                0,
                0,
                0,
                1,
                0,
                float(2 * m_itemAnchor.x / m_width - 1 - m_anchor.x * sx),
                float(1 - 2 * m_itemAnchor.y / m_height - m_anchor.y * sy),
                0,
                1};
    }

  private:
    Bounds m_bounds;
    Point m_anchor, m_itemAnchor;
    double m_width = 0, m_height = 0, m_scale = 1;
    unsigned m_revision = 0;
    bool m_valid = false;
};
inline bool triangleContains(Point p, Point a, Point b, Point c) {
    for (const auto point : {p, a, b, c})
        if (!std::isfinite(point.x) || !std::isfinite(point.y))
            return false;
    const auto cross = [](Point u, Point v, Point w) {
        return (v.x - u.x) * (w.y - u.y) - (v.y - u.y) * (w.x - u.x);
    };
    if (std::abs(cross(a, b, c)) < 1e-12)
        return false;
    const double ab = cross(a, b, p), bc = cross(b, c, p), ca = cross(c, a, p);
    return !((ab < -1e-9 || bc < -1e-9 || ca < -1e-9) && (ab > 1e-9 || bc > 1e-9 || ca > 1e-9));
}
} // namespace ReverieAvatar
