import QtQuick
import QtQuick.Controls

// Mirrors Main.qml's settings Shortcut and ScenePortal's focused drag handle,
// which handles Escape through Keys rather than the shortcut map.
Item {
    id: stage
    width: 320
    height: 240
    property int settingsActivations: 0
    property int handleEscapes: 0
    Shortcut {
        objectName: "shortcut-settings"
        sequences: ["Ctrl+3", "Meta+3"]
        onActivated: stage.settingsActivations++
    }
    Item {
        objectName: "fixtureHandle"
        anchors.fill: parent
        activeFocusOnTab: true
        Keys.onEscapePressed: event => {
            stage.handleEscapes++;
            event.accepted = true;
        }
    }
}
