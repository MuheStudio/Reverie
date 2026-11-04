import QtQuick
import QtQuick.Window

Item {
    id: stage
    property Item surface
    property Item coordinateRoot
    property var previousSource
    property var previousBlur
    property bool active: !!surface
    property real pixelRatio: Screen.devicePixelRatio
    readonly property real capturePadding: 28
    readonly property var texture: active ? combined : previousSource
    readonly property var blurredTexture: active ? resultBlur.texture : previousBlur
    property vector2d surfaceOrigin: Qt.vector2d(0, 0)
    property vector2d surfaceAxisX: Qt.vector2d(1, 0)
    property vector2d surfaceAxisY: Qt.vector2d(0, 1)
    visible: false
    function updateMapping() {
        if (!surface || !coordinateRoot || surface.width <= 0 || surface.height <= 0)
            return;
        const o = surface.mapFromItem(coordinateRoot, 0, 0);
        const x = surface.mapFromItem(coordinateRoot, width, 0);
        const y = surface.mapFromItem(coordinateRoot, 0, height);
        const w = surface.width + 2 * capturePadding, h = surface.height + 2 * capturePadding;
        surfaceOrigin = Qt.vector2d((o.x + capturePadding) / w, (o.y + capturePadding) / h);
        surfaceAxisX = Qt.vector2d((x.x - o.x) / w, (x.y - o.y) / h);
        surfaceAxisY = Qt.vector2d((y.x - o.x) / w, (y.y - o.y) / h);
    }
    onSurfaceChanged: updateMapping()
    onWidthChanged: updateMapping()
    onHeightChanged: updateMapping()
    Connections {
        target: stage.surface
        function onXChanged() {
            stage.updateMapping();
        }
        function onYChanged() {
            stage.updateMapping();
        }
        function onWidthChanged() {
            stage.updateMapping();
        }
        function onHeightChanged() {
            stage.updateMapping();
        }
        function onScaleChanged() {
            stage.updateMapping();
        }
        function onRotationChanged() {
            stage.updateMapping();
        }
    }
    Connections {
        target: stage.Window.window
        function onAfterAnimating() {
            if (stage.active)
                stage.updateMapping();
        }
    }
    ShaderEffectSource {
        id: surfaceCapture
        sourceItem: stage.surface
        sourceRect: Qt.rect(-stage.capturePadding, -stage.capturePadding, stage.surface ? stage.surface.width + 2 * stage.capturePadding : 1, stage.surface ? stage.surface.height + 2 * stage.capturePadding : 1)
        live: stage.active
        hideSource: false
        visible: false
        textureSize: Qt.size(Math.max(1, sourceRect.width * stage.pixelRatio), Math.max(1, sourceRect.height * stage.pixelRatio))
    }
    ShaderEffect {
        id: mixSurface
        anchors.fill: parent
        property var lowerSource: stage.previousSource
        property var surfaceSource: surfaceCapture
        property vector2d surfaceOrigin: stage.surfaceOrigin
        property vector2d surfaceAxisX: stage.surfaceAxisX
        property vector2d surfaceAxisY: stage.surfaceAxisY
        property real surfaceOpacity: stage.surface && stage.surface.visible ? stage.surface.opacity : 0
        fragmentShader: "qrc:/shaders/composite.frag.qsb"
    }
    ShaderEffectSource {
        id: combined
        sourceItem: stage.active ? mixSurface : null
        live: stage.active
        hideSource: true
        visible: false
        textureSize: Qt.size(stage.width * stage.pixelRatio, stage.height * stage.pixelRatio)
    }
    SharedBlur {
        id: resultBlur
        anchors.fill: parent
        source: combined
        active: stage.active
        pixelRatio: stage.pixelRatio
    }
}
