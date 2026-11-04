import QtQuick
import QtQuick.Window

Item {
    id: compositor
    objectName: "layerCompositor"
    property Item baseItem
    property Item lowerItem
    property var surfaces: []
    property var navigation
    property bool effectsActive: true
    property real pixelRatio: Math.max(1, Screen.devicePixelRatio / 2)
    property var orderedSurfaces: []
    property int readyRevision: 0
    readonly property alias baseTexture: baseCapture
    readonly property alias baseBlur: baseBlurPass.texture
    readonly property alias dialogueTexture: lowerCapture
    readonly property alias dialogueBlur: lowerBlurPass.texture
    readonly property int captureSurfaceCount: orderedSurfaces.length
    readonly property var captureDiagnostics: {
        const framePixels = Math.ceil(width * pixelRatio) * Math.ceil(height * pixelRatio);
        const surfacePixels = orderedSurfaces.reduce((sum, s) => sum + Math.ceil((s.width + 56) * pixelRatio) * Math.ceil((s.height + 56) * pixelRatio), 0);
        return {activeTaskSurfaces: orderedSurfaces.length, pixelRatio: pixelRatio,
            viewportWidth: width, viewportHeight: height,
            activeCapturePasses: effectsActive ? 6 + orderedSurfaces.length * 4 : 0,
            requestedTexturePixels: (6 + orderedSurfaces.length * 3) * framePixels + surfacePixels,
            scope: "compositor source/blur targets only; requested dimensions, not measured GPU allocation; excludes avatar FBO and Qt item layers"};
    }
    readonly property var finalTexture: textureAfter(orderedSurfaces.length - 1)
    readonly property var finalBlur: blurAfter(orderedSurfaces.length - 1)
    function updateOrder() {
        const moving = surfaces.filter(s => s.progress > .002);
        const next = surfaces.filter(s => s.progress > .002 || (s.visible && moving.some(front => front !== s && front.orderStamp >= s.orderStamp && front.x < s.x + s.width + 28 && front.x + front.width + 28 > s.x && front.y < s.y + s.height + 28 && front.y + front.height + 28 > s.y))).sort((a, b) => a.orderStamp - b.orderStamp);
        if (next.length !== orderedSurfaces.length || next.some((s, i) => orderedSurfaces[i] !== s))
            orderedSurfaces = next;
    }
    function textureAfter(index) {
        const revision = readyRevision;
        return index < 0 || !stages.itemAt(index) ? lowerCapture : stages.itemAt(index).texture;
    }
    function blurAfter(index) {
        const revision = readyRevision;
        return index < 0 || !stages.itemAt(index) ? lowerBlurPass.texture : stages.itemAt(index).blurredTexture;
    }
    function sourceBefore(surface) {
        return textureAfter(orderedSurfaces.indexOf(surface) - 1);
    }
    function blurBefore(surface) {
        return blurAfter(orderedSurfaces.indexOf(surface) - 1);
    }
    function orderOf(surface) {
        return 20 + Math.max(-1, orderedSurfaces.indexOf(surface));
    }
    onSurfacesChanged: updateOrder()
    ShaderEffectSource {
        id: baseCapture
        sourceItem: compositor.baseItem
        live: compositor.effectsActive
        hideSource: false
        visible: false
        textureSize: Qt.size(compositor.width * compositor.pixelRatio, compositor.height * compositor.pixelRatio)
    }
    SharedBlur {
        id: baseBlurPass
        anchors.fill: parent
        source: baseCapture
        active: compositor.effectsActive
        pixelRatio: compositor.pixelRatio
    }
    ShaderEffectSource {
        id: lowerCapture
        sourceItem: compositor.lowerItem
        live: compositor.effectsActive
        hideSource: false
        visible: false
        textureSize: Qt.size(compositor.width * compositor.pixelRatio, compositor.height * compositor.pixelRatio)
    }
    SharedBlur {
        id: lowerBlurPass
        anchors.fill: parent
        source: lowerCapture
        active: compositor.effectsActive
        pixelRatio: compositor.pixelRatio
    }
    Instantiator {
        model: compositor.surfaces
        delegate: Connections {
            required property var modelData
            target: modelData
            function onProgressChanged() {
                compositor.updateOrder();
            }
            function onOrderStampChanged() {
                compositor.updateOrder();
            }
            function onVisibleChanged() {
                compositor.updateOrder();
            }
        }
    }
    Repeater {
        id: stages
        model: 3
        onItemAdded: compositor.readyRevision++
        delegate: BackdropStage {
            required property int index
            anchors.fill: parent
            surface: compositor.orderedSurfaces[index] || null
            coordinateRoot: compositor.lowerItem
            active: !!surface && compositor.effectsActive
            previousSource: compositor.textureAfter(index - 1)
            previousBlur: compositor.blurAfter(index - 1)
            pixelRatio: compositor.pixelRatio
        }
    }
}
