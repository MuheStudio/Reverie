import QtQuick
import QtQuick.Window
import QtQuick.Controls
import QtQuick.Layouts
import "ui"

// Design preview only. Mirrors the companion composition of
// native-ui/qml/Main.qml with the real scene, chat, portal and glass
// components. The Live2D actor is omitted, so its floor shadow is too.
Item {
    id: scene
    width: 1380
    height: 900
    property real pixelRatio: 2
    // "memory", "memory:reload", "settings" or "chat:reading" opens that
    // view after the companion composition has settled; "memory:reload" then
    // asks to reload over a draft, which shows the confirmation dialog.
    property string openTarget: ""
    function openRequested() {
        if (!openTarget)
            return;
        if (openTarget === "memory:reload") {
            sceneNavigation.open("memory", "");
            reloadRequest.start();
            return;
        }
        const parts = openTarget.split(":");
        sceneNavigation.open(parts[0], parts[1] || "");
    }
    Timer {
        id: reloadRequest
        interval: 1400
        onTriggered: {
            archiveEditor.dirty = true;
            previewArchiveDrawer.requestReload();
        }
    }

    InputContext {
        id: inputPolicy
        window: scene.Window.window
    }
    SceneNavigation {
        id: sceneNavigation
        focusWindow: scene.Window.window
        activeFocusItem: scene.Window.window ? scene.Window.window.activeFocusItem : null
        inputContext: inputPolicy
        fallbackFocusItem: chat.composerItem
    }
    SceneDirector {
        id: sceneDirector
        navigation: sceneNavigation
        viewportWidth: scene.width
        viewportHeight: scene.height
        reducedMotion: session.reducedMotion
    }
    // The backdrop's inputs from the director, without an actor.
    QtObject {
        id: backdropDirector
        readonly property vector2d lightDirection: sceneDirector.lightDirection
        readonly property real horizonY: sceneDirector.horizonY
        readonly property rect archiveAnchor: sceneDirector.archiveAnchor
        readonly property rect terminalAnchor: sceneDirector.terminalAnchor
        readonly property rect avatarRect: sceneDirector.avatarRect
        readonly property point stageCenter: sceneDirector.stageCenter
        readonly property real taskBlend: sceneDirector.taskBlend
        readonly property real readBlend: sceneDirector.readBlend
        readonly property real avatarVisibility: 0
        readonly property real archiveOpen: sceneDirector.archiveOpen
        readonly property real terminalOpen: sceneDirector.terminalOpen
        readonly property real portalDocked: sceneDirector.portalDocked
    }
    Rectangle {
        anchors.fill: parent
        color: "#15262f"
    }
    Item {
        id: lowerComposition
        anchors.fill: parent
        layer.enabled: true
        layer.textureSize: Qt.size(width * scene.pixelRatio, height * scene.pixelRatio)
        Item {
            id: roomWithAvatar
            anchors.fill: parent
            layer.enabled: true
            layer.textureSize: Qt.size(width * scene.pixelRatio, height * scene.pixelRatio)
            SceneBackdrop {
                anchors.fill: parent
                director: backdropDirector
                reducedMotion: session.reducedMotion
            }
            Text {
                x: sceneDirector.nameplateRect.x
                y: sceneDirector.nameplateRect.y
                width: sceneDirector.nameplateRect.width
                height: sceneDirector.nameplateRect.height
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                text: "与你，在月光下"
                color: "#cbd9d6"
                font.pixelSize: 13
            }
        }
        ChatPanel {
            id: chat
            objectName: "persistentChat"
            anchors.fill: parent
            director: sceneDirector
            navigation: sceneNavigation
            inputContext: inputPolicy
            sceneSource: compositor.baseTexture
            blurredSource: compositor.baseBlur
            sceneRoot: roomWithAvatar
        }
    }
    LayerCompositor {
        id: compositor
        anchors.fill: parent
        baseItem: roomWithAvatar
        lowerItem: lowerComposition
        surfaces: [memorySurface, settingsSurface]
        navigation: sceneNavigation
        effectsActive: !session.reducedTransparency
        pixelRatio: scene.pixelRatio
    }
    ScenePortal {
        id: memorySurface
        objectName: "drawer-memory"
        property int orderStamp: 0
        navigation: sceneNavigation
        director: sceneDirector
        destination: "memory"
        glyph: "▥"
        text: "资料匣"
        hint: "世界书 · 当前设定"
        closedVisible: !sceneDirector.compact && sceneDirector.readBlend < .999 && sceneDirector.taskBlend < .999
        opacity: progress > .002 || desiredOpen ? 1 : Math.max(0, 1 - Math.max(sceneDirector.readBlend, sceneDirector.taskBlend))
        closedRect: sceneDirector.archiveAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: session.reducedMotion
        sceneSource: compositor.sourceBefore(memorySurface)
        blurredSource: compositor.blurBefore(memorySurface)
        sceneRoot: lowerComposition
        z: compositor.orderOf(memorySurface)
        body: ArchiveDrawer {
            id: previewArchiveDrawer
            anchors.fill: parent
            navigation: sceneNavigation
        }
    }
    ScenePortal {
        id: settingsSurface
        objectName: "drawer-settings"
        property int orderStamp: 0
        navigation: sceneNavigation
        director: sceneDirector
        destination: "settings"
        glyph: "⌘"
        text: "终端"
        hint: "连接、偏好与空间设置"
        closedVisible: !sceneDirector.compact && sceneDirector.readBlend < .999 && sceneDirector.taskBlend < .999
        opacity: progress > .002 || desiredOpen ? 1 : Math.max(0, 1 - Math.max(sceneDirector.readBlend, sceneDirector.taskBlend))
        closedRect: sceneDirector.terminalAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: session.reducedMotion
        sceneSource: compositor.sourceBefore(settingsSurface)
        blurredSource: compositor.blurBefore(settingsSurface)
        sceneRoot: lowerComposition
        z: compositor.orderOf(settingsSurface)
        // A sample of the terminal's controls; TaskPanel itself needs the
        // runtime bridge.
        body: ColumnLayout {
            anchors.fill: parent
            spacing: 10
            Text {
                text: "回复服务"
                color: "#e4eef7"
                font.pixelSize: 18
            }
            GlassField {
                Layout.fillWidth: true
                text: "http://127.0.0.1:11434/v1"
            }
            Text {
                text: "空间与感官"
                color: "#e4eef7"
                font.pixelSize: 18
            }
            GlassSwitch {
                objectName: "previewSwitchOff"
                text: "减少动态效果"
            }
            GlassSwitch {
                objectName: "previewSwitchOn"
                text: "降低透明度"
                checked: true
            }
            GlassSwitch {
                objectName: "previewSwitchDisabled"
                text: "暂停网络模型调用"
                enabled: false
            }
            Item {
                Layout.fillHeight: true
            }
        }
    }
    RowLayout {
        x: 28
        y: 17
        width: parent.width - 56
        height: 40
        z: 150
        Text {
            text: "R E V E R I E"
            color: "#edf1e9"
            font.pixelSize: 16
            font.weight: Font.Medium
        }
        Rectangle {
            implicitWidth: 1
            implicitHeight: 14
            color: "#687f83"
            Layout.leftMargin: 14
            Layout.rightMargin: 14
        }
        Text {
            text: "月 光 观 景 室"
            color: "#aec4c5"
            font.pixelSize: 11
        }
        Item {
            Layout.fillWidth: true
        }
        Rectangle {
            implicitWidth: 5
            implicitHeight: 5
            radius: 3
            color: "#aadcc9"
        }
        Text {
            text: "已连接"
            color: "#b2c4cb"
            font.pixelSize: 11
        }
        GlassButton {
            text: "形象  ✧"
            implicitHeight: 34
        }
        GlassButton {
            text: "⌘ K"
            implicitHeight: 34
        }
    }
    GlassPane {
        objectName: "navigationRail"
        x: (scene.width - width) / 2
        y: scene.height - 48
        width: Math.min(scene.width - 44, 490)
        height: 36
        padding: 3
        cornerRadius: 18
        materialRole: "clear"
        z: 150
        sceneSource: compositor.finalTexture
        blurredSource: compositor.finalBlur
        sceneRoot: lowerComposition
        RowLayout {
            anchors.fill: parent
            spacing: 4
            Repeater {
                model: sceneNavigation.entries.filter(entry => entry.showInRail)
                GlassButton {
                    required property var modelData
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    text: modelData.shortLabel
                    implicitHeight: 30
                    padding: 4
                    accented: sceneNavigation.currentFeature === modelData.feature && sceneNavigation.currentSubentry === modelData.subentry
                }
            }
        }
    }
}
