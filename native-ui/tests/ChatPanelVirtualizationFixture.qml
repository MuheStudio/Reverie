import QtQuick
import "ui"

// Hosts the real ChatPanel with a scripted presentation director and an inert
// navigation. Geometry follows SceneDirector's companion/reading split; no
// scene capture is bound.
Item {
    id: stage
    width: 1380
    height: 900
    QtObject {
        id: director
        objectName: "fixtureDirector"
        property string mode: "companion"
        property real readBlend: 0
        property real taskBlend: 0
        property bool chatLayoutReading: false
        property bool chatInputReady: true
        property bool compact: false
        property real companionRequestedHeight: 250
        property real composerRequestedHeight: 68
        property real companionHeightLimit: 640
        property rect readingRect: Qt.rect(420, 80, 640, 640)
        readonly property rect recentRect: Qt.rect(760, 300, 420, Math.min(companionHeightLimit, Math.max(154, companionRequestedHeight)))
        readonly property rect historyRect: chatLayoutReading ? readingRect : recentRect
        readonly property real historyBodyWidth: historyRect.width
        property rect composerRect: Qt.rect(420, 760, 640, 100)
        property rect companionBarRect: Qt.rect(0, 0, 10, 10)
        property real readBodyOpacity: 1
        readonly property real chatBodyOpacity: readBodyOpacity
        property real companionBarOpacity: 0
        function phaseWeight(lo, hi, value) {
            const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
            return t * t * (3 - 2 * t);
        }
    }
    QtObject {
        id: navigation
        property bool paletteOpen: false
        property string currentFeature: "chat"
        property var inputContext: null
        signal cancelInteraction
        function open(feature, subentry, sourceItem) {
        }
        function close() {
        }
        function restoreFeatureFocus(feature, fallbackItem) {
            return false;
        }
    }
    ChatPanel {
        objectName: "fixtureChat"
        anchors.fill: parent
        director: director
        navigation: navigation
    }
}
