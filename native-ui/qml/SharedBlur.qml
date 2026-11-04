import QtQuick
import QtQuick.Window

Item {
    id: blur
    property var source
    property bool active: true
    property real pixelRatio: Screen.devicePixelRatio
    readonly property alias texture: verticalCapture
    readonly property vector2d sourceSize: Qt.vector2d(Math.max(1, width * pixelRatio), Math.max(1, height * pixelRatio))
    visible: false
    ShaderEffect {
        id: horizontal
        anchors.fill: parent
        property var source: blur.source
        property vector2d sourceSize: blur.sourceSize
        property vector2d blurDirection: Qt.vector2d(1, 0)
        property real blurRadiusPx: 18 * blur.pixelRatio
        fragmentShader: "qrc:/shaders/blur.frag.qsb"
    }
    ShaderEffectSource {
        id: horizontalCapture
        sourceItem: blur.active ? horizontal : null
        live: blur.active
        hideSource: true
        visible: false
        textureSize: Qt.size(blur.sourceSize.x, blur.sourceSize.y)
    }
    ShaderEffect {
        id: vertical
        anchors.fill: parent
        property var source: horizontalCapture
        property vector2d sourceSize: blur.sourceSize
        property vector2d blurDirection: Qt.vector2d(0, 1)
        property real blurRadiusPx: 18 * blur.pixelRatio
        fragmentShader: "qrc:/shaders/blur.frag.qsb"
    }
    ShaderEffectSource {
        id: verticalCapture
        sourceItem: blur.active ? vertical : null
        live: blur.active
        hideSource: true
        visible: false
        textureSize: Qt.size(blur.sourceSize.x, blur.sourceSize.y)
    }
}
