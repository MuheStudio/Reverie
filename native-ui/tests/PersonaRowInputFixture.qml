import QtQuick
import QtQuick.Window
import "ui"

// Production portal geometry and TaskPanel delegates, with a bounded local
// navigation state. The two other panels intentionally retain identical IDs.
Window {
    id: fixtureWindow
    width: 900
    height: 760
    visible: false
    property bool blockInput: false
    property bool transparentShield: false
    QtObject {
        id: fixtureNavigation
        property string currentFeature: "character"
        property int transitionRevision: 1
        property bool paletteOpen: fixtureWindow.blockInput
        property bool surfaceOpen: true
        function open(feature, subentry, sourceItem) { currentFeature = feature; transitionRevision++; }
        function close() { currentFeature = "chat"; transitionRevision++; }
        function toggle(feature, sourceItem) { currentFeature = currentFeature === feature ? "chat" : feature; transitionRevision++; }
        function rememberFeatureFocus(feature, item) {}
        function restoreFocus(revision) {}
    }
    ScenePortal {
        objectName: "taskSurface"
        destination: "character"
        navigation: fixtureNavigation
        text: "人格行受控夹具"
        glyph: "✧"
        hint: "原生输入合同"
        reducedMotion: true
        closedVisible: false
        closedRect: Qt.rect(16, 16, 220, 78)
        expandedRect: Qt.rect(16, 16, fixtureWindow.width - 32, fixtureWindow.height - 32)
        body: TaskPanel {
            objectName: "characterTasks"
            anchors.fill: parent
            navigation: fixtureNavigation
            page: "character"
        }
    }
    MouseArea {
        objectName: "fixtureTransparentShield"
        anchors.fill: parent
        z: 1000
        visible: fixtureWindow.transparentShield
        opacity: 0
        acceptedButtons: Qt.LeftButton
        onPressed: mouse => mouse.accepted = true
    }
    TaskPanel {
        objectName: "memoryTasks"
        width: fixtureWindow.width
        height: fixtureWindow.height
        visible: false
        navigation: fixtureNavigation
        page: "memory"
    }
    TaskPanel {
        objectName: "terminalTasks"
        width: fixtureWindow.width
        height: fixtureWindow.height
        visible: false
        navigation: fixtureNavigation
        page: "settings"
    }
}
