import QtQuick
import QtQuick.Window
import Reverie.Native 1.0

Item {
    id: host
    property var director
    property bool windowActive: true
    property alias avatarItem: avatar
    readonly property bool presentationVisible: director.avatarVisibility > .01
    property int retainedRasterWidth: 1
    property int retainedRasterHeight: 1
    readonly property real pixelRatio: Screen.devicePixelRatio
    onPixelRatioChanged: retainRasterResolution()
    function retainRasterResolution() {
        retainedRasterWidth = Math.max(retainedRasterWidth, Math.ceil(avatar.width * Screen.devicePixelRatio));
        retainedRasterHeight = Math.max(retainedRasterHeight, Math.ceil(avatar.height * Screen.devicePixelRatio));
    }
    Component.onCompleted: retainRasterResolution()
    objectName: "avatarSurface"
    // Capture remains live when the narrow task view omits the actor. The
    // original object owns input at exactly the same logical display geometry.
    NativeAvatar {
        id: avatar
        objectName: "nativeAvatar"
        x: host.director.avatarRect.x
        y: host.director.avatarRect.y
        width: host.director.avatarRect.width
        height: host.director.avatarRect.height
        onWidthChanged: host.retainRasterResolution()
        onHeightChanged: host.retainRasterResolution()
        modelPath: session.avatarPath
        reloadToken: session.avatarReloadToken
        running: host.windowActive
        reducedMotion: session.reducedMotion
        enabled: host.presentationVisible
        activeFocusOnTab: enabled
        Accessible.role: Accessible.Button
        Accessible.name: "与当前形象互动"
        Keys.onReturnPressed: interact()
        Keys.onSpacePressed: interact()
        TapHandler {
            enabled: host.presentationVisible
            onTapped: point => avatar.interactAt(point.position.x, point.position.y)
        }
        onRendered: (ok, reason, path) => session.modelRendered(ok, reason, path)
    }
    ShaderEffectSource {
        id: actorSource
        sourceItem: avatar
        hideSource: true
        live: host.windowActive
        visible: false
        textureSize: Qt.size(host.retainedRasterWidth, host.retainedRasterHeight)
    }
    ShaderEffect {
        x: avatar.x
        y: avatar.y
        width: avatar.width
        height: avatar.height
        property var source: actorSource
        property real displayWeight: host.director.avatarVisibility
        fragmentShader: "qrc:/shaders/avatar-display.frag.qsb"
    }
    Column {
        x: host.director.avatarRect.x
        y: host.director.avatarRect.y + host.director.avatarRect.height * .33
        width: host.director.avatarRect.width
        opacity: host.director.avatarVisibility
        visible: session.avatarPath === "" && host.presentationVisible
        spacing: 10
        Text {
            anchors.horizontalCenter: parent.horizontalCenter
            text: "✧"
            color: "#d2e7e4"
            font.pixelSize: 56
        }
        Text {
            width: parent.width
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            text: "给喜欢的形象\n留一个月光下的位置"
            color: "#e4ecea"
            font.pixelSize: 20
        }
    }
}
