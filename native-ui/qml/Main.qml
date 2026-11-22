pragma ComponentBehavior: Bound
import QtQuick
import QtQuick.Controls
import QtQuick.Layouts
import QtQuick.Window

ApplicationWindow {
    id: applicationWindow
    objectName: "sceneWindow"
    width: 1380
    height: 900
    minimumWidth: 760
    minimumHeight: 650
    visible: true
    title: typeof previewWorkspaceTitle !== "undefined" && previewWorkspaceTitle !== ""
            ? previewWorkspaceTitle
            : previewDisposable ? "Reverie · 月光观景室（隔离演示，退出清理）" : "Reverie · 月光观景室"
    color: "#15262f"
    readonly property bool windowActive: visible && visibility !== Window.Minimized
    readonly property bool compact: sceneDirector.compact
    property alias directorItem: sceneDirector
    property alias chatItem: chat
    property int stackingRevision: 0
    function raiseSurface(surface) {
        surface.orderStamp = ++stackingRevision;
    }
    function belongsTo(item, ancestor) {
        for (let current = item; current; current = current.parent)
            if (current === ancestor)
                return true;
        return false;
    }
    onActiveFocusItemChanged: {
        if (!activeFocusItem)
            return;
        if (belongsTo(activeFocusItem, archiveDrawer) || belongsTo(activeFocusItem, memoryTasks))
            sceneNavigation.rememberFeatureFocus("memory", activeFocusItem);
        else if (belongsTo(activeFocusItem, terminalTasks))
            sceneNavigation.rememberFeatureFocus("settings", activeFocusItem);
        else if (belongsTo(activeFocusItem, characterTasks))
            sceneNavigation.rememberFeatureFocus("character", activeFocusItem);
        else if (activitiesLoader.item && belongsTo(activeFocusItem, activitiesLoader.item))
            sceneNavigation.rememberFeatureFocus("activities", activeFocusItem);
        else if (keepsakeLoader.item && belongsTo(activeFocusItem, keepsakeLoader.item))
            sceneNavigation.rememberFeatureFocus("keepsake", activeFocusItem);
        else if (belongsTo(activeFocusItem, chat) && activeFocusItem.cursorPosition !== undefined)
            sceneNavigation.rememberFeatureFocus("chat", activeFocusItem);
    }
    onClosing: close => {
        close.accepted = false;
        session.quit();
    }
    InputContext {
        id: inputPolicy
        window: applicationWindow
    }
    SceneNavigation {
        id: sceneNavigation
        activeFocusItem: applicationWindow.activeFocusItem
        focusWindow: applicationWindow
        focusScopeKey: session.scopeKey || ""
        focusGeneration: session.connectionGeneration
        inputContext: inputPolicy
        fallbackFocusItem: chat.composerItem
        onCurrentFeatureChanged: {
            if (currentFeature !== "activities" &&
                    ["activities", "diary", "gomoku", "chess", "go"].includes(session.panel))
                session.openPanel("");
            if (currentFeature !== "keepsake" && session.panel === "keepsake")
                session.openPanel("");
            session.setRelationshipPageVisible(currentFeature === "character");
        }
        onEnteredFeature: (feature, subentry) => {
            if (feature === "memory" && !archiveEditor.initialized)
                archiveEditor.load();
            if (feature === "memory") {
                applicationWindow.raiseSurface(memorySurface);
                if (memorySurface.page === "memories") {
                    memoryTasks.showMemoryStart();
                    session.refreshMemories();
                    session.request("summary:status", {});
                    session.request("user:profile:get", {});
                }
            }
            if (feature === "settings")
                applicationWindow.raiseSurface(settingsSurface);
            if (feature === "character")
                applicationWindow.raiseSurface(characterSurface);
            if (feature === "keepsake") {
                keepsakeLoader.active = true;
                applicationWindow.raiseSurface(keepsakeLoader.item);
                session.openPanel("keepsake");
            }
            if (feature === "activities") {
                activitiesLoader.active = true;
                applicationWindow.raiseSurface(activitiesLoader.item);
                session.openPanel(["diary", "gomoku", "chess", "go"].includes(subentry) ? subentry : "activities");
            }
        }
    }
    ArchiveEntryPolicy {
        navigation: sceneNavigation
        portal: memorySurface
        drawer: archiveDrawer
    }
    SceneDirector {
        id: sceneDirector
        navigation: sceneNavigation
        viewportWidth: applicationWindow.width
        viewportHeight: applicationWindow.height
        reducedMotion: session.reducedMotion
    }
    Shortcut {
        sequence: "Meta+K"
        enabled: !inputPolicy.composing
        onActivated: sceneNavigation.showPalette(commandButton)
    }
    Shortcut {
        sequence: "Ctrl+K"
        enabled: !inputPolicy.composing
        onActivated: sceneNavigation.showPalette(commandButton)
    }
    Shortcut {
        sequences: ["Ctrl+1", "Meta+1"]
        enabled: !inputPolicy.composing
        onActivated: sceneNavigation.open("chat", "companion")
    }
    Shortcut {
        sequences: ["Ctrl+2", "Meta+2"]
        enabled: !inputPolicy.composing
        onActivated: sceneNavigation.open("memory", "worldbook", commandButton)
    }
    Shortcut {
        objectName: "shortcut-settings"
        sequences: ["Ctrl+3", "Meta+3"]
        enabled: !inputPolicy.composing
        onActivated: sceneNavigation.open("settings", "provider", commandButton)
    }
    Shortcut {
        sequence: "Escape"
        enabled: !inputPolicy.composing && !archiveDrawer.modalOpen && !memoryTasks.modalOpen && !terminalTasks.modalOpen && !characterTasks.modalOpen && !activitiesLoader.item?.modalOpen && !keepsakeLoader.item?.modalOpen
        onActivated: {
            if (memorySurface.dragging || settingsSurface.dragging || characterSurface.dragging || activitiesLoader.item?.dragging || keepsakeLoader.item?.dragging)
                sceneNavigation.cancelInteraction();
            else if (sceneNavigation.paletteOpen)
                sceneNavigation.dismissPalette();
            else if (sceneNavigation.surfaceOpen)
                sceneNavigation.close();
            else if (sceneNavigation.currentSubentry === "reading")
                sceneNavigation.open("chat", "companion");
        }
    }
    Item {
        id: lowerComposition
        objectName: "lowerComposition"
        anchors.fill: parent
        layer.enabled: true
        layer.textureSize: Qt.size(width * Screen.devicePixelRatio, height * Screen.devicePixelRatio)
        Item {
            id: roomWithAvatar
            objectName: "roomWithAvatar"
            anchors.fill: parent
            layer.enabled: true
            layer.textureSize: Qt.size(width * Screen.devicePixelRatio, height * Screen.devicePixelRatio)
            SceneBackdrop {
                id: room
                anchors.fill: parent
                director: sceneDirector
                reducedMotion: session.reducedMotion
                roomQuality: session.roomQuality
            }
            FrameAnimation {
                running: applicationWindow.windowActive && !session.reducedMotion
                onTriggered: room.cloudPhase += frameTime * .012
            }
            AvatarSurface {
                id: avatarSurface
                anchors.fill: parent
                director: sceneDirector
                windowActive: applicationWindow.windowActive
            }
            Text {
                x: sceneDirector.nameplateRect.x
                y: sceneDirector.nameplateRect.y
                width: sceneDirector.nameplateRect.width
                height: sceneDirector.nameplateRect.height
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                text: session.state.persona?.name || "与你，在月光下"
                textFormat: Text.PlainText
                color: "#cbd9d6"
                font.pixelSize: 13
                opacity: sceneDirector.avatarVisibility
                visible: session.avatarPath !== ""
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
        surfaces: [memorySurface, settingsSurface, characterSurface]
            .concat(activitiesLoader.item ? [activitiesLoader.item] : [])
            .concat(keepsakeLoader.item ? [keepsakeLoader.item] : [])
        navigation: sceneNavigation
        effectsActive: applicationWindow.windowActive && !session.reducedTransparency
    }
    ScenePortal {
        id: memorySurface
        objectName: "drawer-memory"
        property int orderStamp: 0
        // Kept while closing so the outgoing page does not swap mid-transition.
        property string page: "worldbook"
        readonly property Item firstFocusItem: page === "memories" ? memoryTasks.firstFocusItem : archiveDrawer.firstFocusItem
        navigation: sceneNavigation
        director: sceneDirector
        destination: "memory"
        glyph: "▥"
        text: "资料匣"
        hint: archiveEditor.status === "saving" ? "正在保存" : archiveEditor.dirty ? "草稿已保留" : page === "memories" ? "记忆与摘要" : "世界书 · 当前设定"
        closedVisible: !applicationWindow.compact && sceneDirector.readBlend < .999 && sceneDirector.taskBlend < .999
        opacity: progress > .002 || desiredOpen ? 1 : Math.max(0, 1 - Math.max(sceneDirector.readBlend, sceneDirector.taskBlend))
        enabled: progress > .002 || desiredOpen || opacity > .05
        closedRect: sceneDirector.archiveAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: session.reducedMotion
        sceneSource: compositor.sourceBefore(memorySurface)
        blurredSource: compositor.blurBefore(memorySurface)
        sceneRoot: lowerComposition
        z: compositor.orderOf(memorySurface)
        onDraggingChanged: if (dragging)
            applicationWindow.raiseSurface(memorySurface)
        body: [
            ArchiveDrawer {
                id: archiveDrawer
                objectName: "archiveDrawer"
                anchors.fill: parent
                visible: memorySurface.page === "worldbook"
                navigation: sceneNavigation
                onRequestClose: sceneNavigation.close()
            },
            TaskPanel {
                id: memoryTasks
                objectName: "memoryTasks"
                anchors.fill: parent
                visible: memorySurface.page === "memories"
                navigation: sceneNavigation
                avatarItem: avatarSurface.avatarItem
                page: "memory"
            }
        ]
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
        closedVisible: !applicationWindow.compact && sceneDirector.readBlend < .999 && sceneDirector.taskBlend < .999
        opacity: progress > .002 || desiredOpen ? 1 : Math.max(0, 1 - Math.max(sceneDirector.readBlend, sceneDirector.taskBlend))
        enabled: progress > .002 || desiredOpen || opacity > .05
        closedRect: sceneDirector.terminalAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: session.reducedMotion
        sceneSource: compositor.sourceBefore(settingsSurface)
        blurredSource: compositor.blurBefore(settingsSurface)
        sceneRoot: lowerComposition
        z: compositor.orderOf(settingsSurface)
        onDraggingChanged: if (dragging)
            applicationWindow.raiseSurface(settingsSurface)
        onOpened: if (desiredOpen && transitionRevision === sceneNavigation.transitionRevision)
            sceneNavigation.deferFeatureFocus("settings", terminalTasks.firstFocusItem, "", null, null)
        body: TaskPanel {
            id: terminalTasks
            objectName: "terminalTasks"
            anchors.fill: parent
            navigation: sceneNavigation
            avatarItem: avatarSurface.avatarItem
            page: sceneNavigation.currentFeature === "settings" && sceneNavigation.currentSubentry === "about" ? "about" : "settings"
        }
    }
    ScenePortal {
        id: characterSurface
        objectName: "taskSurface"
        property int orderStamp: 0
        navigation: sceneNavigation
        director: sceneDirector
        destination: "character"
        glyph: "✧"
        text: "角色与形象"
        hint: "一个形象，始终在场"
        closedVisible: false
        closedRect: sceneDirector.characterAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: session.reducedMotion
        sceneSource: compositor.sourceBefore(characterSurface)
        blurredSource: compositor.blurBefore(characterSurface)
        sceneRoot: lowerComposition
        z: compositor.orderOf(characterSurface)
        onDraggingChanged: if (dragging)
            applicationWindow.raiseSurface(characterSurface)
        body: TaskPanel {
            id: characterTasks
            objectName: "characterTasks"
            anchors.fill: parent
            navigation: sceneNavigation
            avatarItem: avatarSurface.avatarItem
            page: "character"
        }
    }
    Loader {
        id: activitiesLoader
        active: false
        z: item ? compositor.orderOf(item) : 0
        sourceComponent: ScenePortal {
            id: activitiesSurface
            objectName: "drawer-activities"
            property int orderStamp: 0
            readonly property bool modalOpen: activitiesTasks.modalOpen
            navigation: sceneNavigation
            director: sceneDirector
            destination: "activities"
            glyph: "◇"
            text: sceneNavigation.currentSubentry === "diary" ? "日记"
                : sceneNavigation.currentSubentry === "gomoku" ? "五子棋"
                : sceneNavigation.currentSubentry === "chess" ? "国际象棋"
                : sceneNavigation.currentSubentry === "go" ? "围棋" : "中国象棋"
            hint: sceneNavigation.currentSubentry === "diary" ? "读她每天写的日记"
                : ["chess", "go"].includes(sceneNavigation.currentSubentry) ? "和角色下一盘" : "和角色下一盘，或本地练习"
            closedVisible: false
            closedRect: sceneDirector.characterAnchor
            expandedRect: sceneDirector.taskRect
            reducedMotion: session.reducedMotion
            sceneSource: compositor.sourceBefore(activitiesSurface)
            blurredSource: compositor.blurBefore(activitiesSurface)
            sceneRoot: lowerComposition
            onDraggingChanged: if (dragging) applicationWindow.raiseSurface(activitiesSurface)
            onOpened: if (desiredOpen && transitionRevision === sceneNavigation.transitionRevision)
                sceneNavigation.deferFeatureFocus("activities", activitiesTasks.firstFocusItem, "", null, null)
            body: TaskPanel {
                id: activitiesTasks
                anchors.fill: parent
                navigation: sceneNavigation
                avatarItem: avatarSurface.avatarItem
                page: "activities"
            }
        }
    }
    Loader {
        id: keepsakeLoader
        active: false
        z: item ? compositor.orderOf(item) : 0
        sourceComponent: ScenePortal {
            id: keepsakeSurface
            objectName: "drawer-keepsake"
            property int orderStamp: 0
            readonly property bool modalOpen: keepsakePage.modalOpen
            navigation: sceneNavigation
            director: sceneDirector
            destination: "keepsake"
            glyph: "◇"
            text: "收藏"
            hint: "翻看留住的话与图片"
            closedVisible: false
            closedRect: sceneDirector.characterAnchor
            expandedRect: sceneDirector.taskRect
            reducedMotion: session.reducedMotion
            sceneSource: compositor.sourceBefore(keepsakeSurface)
            blurredSource: compositor.blurBefore(keepsakeSurface)
            sceneRoot: lowerComposition
            onDraggingChanged: if (dragging) applicationWindow.raiseSurface(keepsakeSurface)
            onOpened: if (desiredOpen && transitionRevision === sceneNavigation.transitionRevision)
                sceneNavigation.deferFeatureFocus("keepsake", keepsakePage.firstFocusItem, "", null, null)
            body: KeepsakePanel {
                id: keepsakePage
                anchors.fill: parent
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
        Text {
            visible: previewDisposable && !applicationWindow.compact
            text: "隔离演示 · 退出清理"
            color: "#cdbb99"
            font.pixelSize: 11
        }
        Rectangle {
            implicitWidth: 5
            implicitHeight: 5
            radius: 3
            color: session.connected ? "#aadcc9" : "#dbad92"
        }
        Text {
            text: session.connected ? "已连接" : "连接中"
            color: "#b2c4cb"
            font.pixelSize: 11
        }
        GlassButton {
            id: characterButton
            objectName: "nav-character"
            text: "形象  ✧"
            implicitHeight: 34
            onClicked: sceneNavigation.open("character", "", characterButton)
        }
        GlassButton {
            id: commandButton
            objectName: "scene-navigation-search"
            text: "⌘ K"
            implicitHeight: 34
            Accessible.name: "打开功能导航"
            onClicked: sceneNavigation.showPalette(commandButton)
        }
    }
    GlassPane {
        objectName: "navigationRail"
        x: (applicationWindow.width - width) / 2
        y: applicationWindow.height - 48
        width: Math.min(applicationWindow.width - 44, 490)
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
                    id: navButton
                    required property var modelData
                    objectName: modelData.subentry === "reading" ? "nav-reading" : "nav-" + modelData.feature
                    Layout.fillWidth: true
                    Layout.fillHeight: true
                    text: modelData.shortLabel
                    implicitHeight: 30
                    padding: 4
                    // Chat's two rail entries differ by subentry; other features
                    // keep their rail entry lit on every page they open.
                    accented: sceneNavigation.currentFeature === modelData.feature && (modelData.feature !== "chat" || sceneNavigation.currentSubentry === modelData.subentry)
                    onClicked: sceneNavigation.open(modelData.feature, modelData.subentry, navButton)
                }
            }
        }
    }
    Text {
        x: 30
        y: 61
        width: applicationWindow.width - 60
        visible: session.notice !== "" && !session.connected
        text: session.notice
        textFormat: Text.PlainText
        elide: Text.ElideRight
        color: "#d8bbaa"
        font.pixelSize: 11
        z: 150
    }
    FirstRunSheet {
        id: firstRunSheet
        anchors.fill: parent
        navigation: sceneNavigation
        sceneSource: compositor.finalTexture
        blurredSource: compositor.finalBlur
        sceneRoot: lowerComposition
        // The service page is the one place a key is typed; the sheet returns when it closes.
        onOpenService: sourceItem => {
            terminalTasks.showServicePage();
            sceneNavigation.open("settings", "provider", sourceItem);
        }
        onActiveChanged: if (!active && !session.firstRunPending)
            sceneNavigation.restoreFeatureFocus("chat", chat.composerItem)
    }
    SceneCommandPalette {
        anchors.fill: parent
        navigation: sceneNavigation
        sceneSource: compositor.finalTexture
        blurredSource: compositor.finalBlur
        sceneRoot: lowerComposition
    }
}
