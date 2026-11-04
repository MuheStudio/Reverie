import QtQuick
import QtQuick.Controls

// A switch in the instrument vocabulary: a recessed track in the reading
// material's tones, a moonlit knob, and the GlassButton accent when on.
Switch {
    id: control
    property bool reducedMotion: typeof session !== "undefined" && session.reducedMotion
    readonly property color accent: "#73dbd4"
    implicitHeight: 32
    padding: 0
    spacing: 12
    font.pixelSize: 14
    hoverEnabled: true
    Accessible.name: text
    indicator: Rectangle {
        x: control.leftPadding
        y: (control.height - height) / 2
        implicitWidth: 42
        implicitHeight: 24
        radius: height / 2
        opacity: control.enabled ? 1 : 0.5
        color: control.checked ? Qt.rgba(control.accent.r, control.accent.g, control.accent.b, control.down ? 0.44 : control.hovered ? 0.38 : 0.26) : control.down ? "#2e3e44" : control.hovered ? "#25343a" : "#1c282e"
        border.width: control.activeFocus ? 1.5 : 1
        border.color: control.activeFocus ? "#d0e7df" : control.checked ? Qt.rgba(control.accent.r, control.accent.g, control.accent.b, control.hovered ? 0.95 : 0.62) : control.hovered ? "#8aa2a6" : "#43585e"
        // Hover lights a soft halo around the knob in either state.
        Rectangle {
            width: 28
            height: 28
            radius: 14
            x: knob.x + (knob.width - width) / 2
            y: knob.y + (knob.height - height) / 2
            color: control.checked ? Qt.rgba(control.accent.r, control.accent.g, control.accent.b, 0.24) : "#2ec8dadc"
            visible: control.hovered && control.enabled
        }
        Rectangle {
            id: knob
            width: 18
            height: 18
            radius: 9
            y: 3
            x: control.checked ? parent.width - width - 3 : 3
            color: control.checked ? "#eafbf8" : control.hovered ? "#b6c7ca" : "#93a7ab"
            border.width: 1
            border.color: control.checked ? control.accent : control.hovered ? "#d6e2e4" : "#b5c5c8"
            Behavior on x {
                enabled: !control.reducedMotion
                NumberAnimation {
                    duration: 140
                    easing.type: Easing.OutCubic
                }
            }
        }
    }
    contentItem: Text {
        leftPadding: control.indicator.width + control.spacing
        text: control.text
        textFormat: Text.PlainText
        font: control.font
        color: !control.enabled ? "#75858a" : control.hovered ? "#eef6f9" : "#dce9f2"
        verticalAlignment: Text.AlignVCenter
    }
}
