import QtQuick
import QtQuick.Window
import "ui"

// The production TaskPanel owns the dialog and both buttons. A window exists
// during component completion, including when a card was selected beforehand.
Window {
    width: 1000
    height: 900
    visible: false

    QtObject {
        id: fixtureNavigation
        function open(feature, subentry, sourceItem) {}
        function close() {}
    }

    TaskPanel {
        objectName: "fixtureTaskPanel"
        anchors.fill: parent
        page: "character"
        navigation: fixtureNavigation
    }
}
