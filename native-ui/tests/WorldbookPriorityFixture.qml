import QtQuick
import QtQuick.Window
import "ui"

// The production form and editor are used, including the SpinBox input path.
Window {
    width: 760
    height: 650
    visible: false
    ArchiveDrawer {
        objectName: "fixturePriorityDrawer"
        anchors.fill: parent
    }
}
