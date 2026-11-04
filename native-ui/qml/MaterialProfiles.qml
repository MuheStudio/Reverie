import QtQuick

// One material vocabulary for entrances, tools, and sustained reading.
// All dimensions are logical pixels; the compositor owns DPR-sized textures.
QtObject {
    property string role: "clear"
    property real progress: 1
    readonly property string resolvedRole: role === "reading" || role === "work" ? role : "clear"
    // A physical work object starts as clear glass in its scene socket. Its
    // optics settle continuously as the same object becomes a working surface.
    readonly property real workBlend: resolvedRole === "work" ? Math.max(0, Math.min(1, progress)) : 0
    // Clear entrances preserve the room through a light center. Work surfaces
    // settle into soft fog; only their perimeter keeps a small lens response.
    readonly property vector4d clearOptics: Qt.vector4d(1.10, 0.20, 0.045, 4.6)
    readonly property vector4d workOptics: Qt.vector4d(0.74, 0.92, 0.56, 2.3)
    readonly property vector4d clearEdge: Qt.vector4d(9.0, 0.34, 0.026, 0.8)
    readonly property vector4d workEdge: Qt.vector4d(6.5, 0.17, 0.018, 0.32)
    readonly property color clearTint: "#657975"
    readonly property color workTint: "#39484a"
    readonly property color clearOpaqueTop: "#425654"
    readonly property color workOpaqueTop: "#35494b"
    readonly property color clearOpaqueBottom: "#304545"
    readonly property color workOpaqueBottom: "#273b40"
    readonly property color clearOutline: "#879d99"
    readonly property color workOutline: "#617a7d"

    function vectorMix(a, b, t) {
        return Qt.vector4d(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.z + (b.z - a.z) * t, a.w + (b.w - a.w) * t);
    }
    function colorMix(a, b, t) {
        return Qt.rgba(a.r + (b.r - a.r) * t, a.g + (b.g - a.g) * t, a.b + (b.b - a.b) * t, a.a + (b.a - a.a) * t);
    }
    // sharp transmission, shared blur mix, body absorption, edge lens depth
    readonly property vector4d optics: resolvedRole === "reading" ? Qt.vector4d(0.64, 0.92, 0.56, 1.0) : vectorMix(clearOptics, workOptics, workBlend)
    // inward edge width, directional highlight, interior sheen, settle response
    readonly property vector4d edge: resolvedRole === "reading" ? Qt.vector4d(6.0, 0.15, 0.008, 0.04) : vectorMix(clearEdge, workEdge, workBlend)
    readonly property color tint: resolvedRole === "reading" ? "#1b2930" : colorMix(clearTint, workTint, workBlend)
    readonly property color opaqueTop: resolvedRole === "reading" ? "#253238" : colorMix(clearOpaqueTop, workOpaqueTop, workBlend)
    readonly property color opaqueBottom: resolvedRole === "reading" ? "#1c282e" : colorMix(clearOpaqueBottom, workOpaqueBottom, workBlend)
    readonly property color outline: resolvedRole === "reading" ? "#526970" : colorMix(clearOutline, workOutline, workBlend)
    readonly property real shadowExtent: resolvedRole === "reading" ? 22 : 18 + workBlend * 2
    readonly property real shadowOpacity: resolvedRole === "reading" ? 0.26 : 0.20 + workBlend * 0.055
}
