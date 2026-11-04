import QtQuick
import QtQuick.Controls

Button {
    id: control
    property bool accented: false
    property string materialRole: "work"
    property var sceneSource
    property var blurredSource: sceneSource
    property Item sceneRoot
    property vector2d lightDirection: Qt.vector2d(-0.56, -0.83)
    property bool reducedMotion: typeof session !== "undefined" && session.reducedMotion
    readonly property color accent: "#73dbd4"
    implicitHeight: 42
    implicitWidth: Math.max(42, contentItem.implicitWidth + 30)
    padding: 12
    font.pixelSize: 13
    hoverEnabled: true
    focusPolicy: Qt.StrongFocus
    Accessible.name: text
    contentItem: Text {
        textFormat: Text.PlainText
        text: control.text
        color: control.enabled ? (control.accented ? "#f2fbfa" : "#e0e9eb") : "#75858a"
        font: control.font
        horizontalAlignment: Text.AlignHCenter
        verticalAlignment: Text.AlignVCenter
        elide: Text.ElideRight
    }
    background: GlassPane {
        padding: 0
        sceneSource: control.sceneSource
        blurredSource: control.blurredSource
        sceneRoot: control.sceneRoot
        materialRole: control.materialRole
        lightDirection: control.lightDirection
        cornerRadius: 12
        castsShadow: false
        interactionHover: control.hovered ? 1 : 0
        interactionPressed: control.down ? 1 : 0
        focusHighlight: control.activeFocus && !control.accented
        outlineStrength: 0.62
        opacity: control.enabled ? 1 : 0.56
        Rectangle {
            anchors.fill: parent
            radius: 12
            visible: control.accented
            // Accent-lit glass: the scene stays visible through the active state.
            gradient: Gradient {
                GradientStop {
                    position: 0
                    color: Qt.rgba(control.accent.r, control.accent.g, control.accent.b, control.down ? 0.32 : control.hovered ? 0.27 : 0.22)
                }
                GradientStop {
                    position: 1
                    color: Qt.rgba(control.accent.r, control.accent.g, control.accent.b, 0.07)
                }
            }
            // The accent rim doubles as the focus indicator.
            border.color: Qt.rgba(control.accent.r, control.accent.g, control.accent.b, control.activeFocus ? 0.90 : 0.32)
            border.width: control.activeFocus ? 1.5 : 1
            Rectangle {
                anchors.horizontalCenter: parent.horizontalCenter
                anchors.bottom: parent.bottom
                anchors.bottomMargin: 3
                width: parent.width * 0.34
                height: 2
                radius: 1
                color: control.accent
                opacity: 0.85
            }
        }
        Rectangle {
            anchors.fill: parent
            radius: 12
            color: control.down ? "#12080e10" : control.hovered ? "#09edfaff" : "transparent"
            Behavior on color {
                ColorAnimation {
                    duration: control.reducedMotion ? 0 : 110
                }
            }
        }
    }
}
