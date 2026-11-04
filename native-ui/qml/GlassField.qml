import QtQuick
import QtQuick.Controls

TextField {
    id: field
    property string materialRole: "reading"
    property var sceneSource
    property var blurredSource: sceneSource
    property Item sceneRoot
    property vector2d lightDirection: Qt.vector2d(-0.56, -0.83)
    color: enabled ? "#e8f0f0" : "#829498"
    placeholderTextColor: "#91a4aa"
    selectionColor: "#5b858f"
    selectedTextColor: "#ffffff"
    padding: 13
    font.pixelSize: 14
    implicitHeight: 46
    selectByMouse: true
    background: GlassPane {
        padding: 0
        materialRole: field.materialRole
        sceneSource: field.sceneSource
        blurredSource: field.blurredSource
        sceneRoot: field.sceneRoot
        lightDirection: field.lightDirection
        cornerRadius: 12
        castsShadow: false
        outlineStrength: 0.62
        interactionHover: field.hovered ? 1 : 0
        focusHighlight: field.activeFocus
        opacity: field.enabled ? 1 : 0.58
        Rectangle {
            anchors.fill: parent
            radius: 12
            color: "#16040e14"
        }
    }
}
