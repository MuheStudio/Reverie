pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

FocusScope {
    id: commandPalette
    property var navigation
    property var sceneSource
    property var blurredSource
    property Item sceneRoot
    property var inputContext: navigation ? navigation.inputContext : null
    objectName: "sceneCommandPalette"
    visible: navigation.paletteOpen
    enabled: visible
    z: 200
    Keys.priority: Keys.AfterItem
    Keys.onEscapePressed: event => {
        if (commandPalette.inputContext && commandPalette.inputContext.composing) {
            event.accepted = false;
            return;
        }
        navigation.dismissPalette();
        event.accepted = true;
    }
    function activateEntry(entry) {
        if (entry && entry.available)
            navigation.open(entry.feature, entry.subentry);
    }
    function isComposing() {
        return search.inputMethodComposing || (inputContext && inputContext.composing);
    }
    Connections {
        target: commandPalette.navigation
        function onQueryChanged() {
            matches.currentIndex = 0;
        }
        function onPalettePresented() {
            // showPalette has committed its lifecycle changes. This explicit
            // user action can focus the live search field synchronously; no
            // queued callback can later override a newer user destination.
            commandPalette.navigation.focusItemNow(search, Qt.ShortcutFocusReason, true, "");
        }
    }
    Rectangle {
        anchors.fill: parent
        color: "#77040c19"
    }
    MouseArea {
        anchors.fill: parent
        onClicked: commandPalette.navigation.dismissPalette()
    }
    GlassPane {
        id: commandPaletteCard
        x: (parent.width - width) / 2
        y: Math.max(86, Math.min(130, parent.height * .14))
        width: Math.min(620, parent.width - 48)
        height: Math.min(parent.height - y - 110,
            topPadding + bottomPadding + paletteTitle.implicitHeight + search.implicitHeight +
            2 * paletteContent.spacing + Math.max(59, commandPalette.navigation.filteredEntries.length * 64 - 5))
        padding: 20
        sceneSource: commandPalette.sceneSource
        blurredSource: commandPalette.blurredSource
        sceneRoot: commandPalette.sceneRoot
        materialRole: "work"
        cornerRadius: 22
        focusHighlight: search.activeFocus
        MouseArea {
            anchors.fill: parent
            acceptedButtons: Qt.AllButtons
        }
        ColumnLayout {
            id: paletteContent
            anchors.fill: parent
            spacing: 14
            RowLayout {
                id: paletteTitle
                Layout.fillWidth: true
                Text {
                    textFormat: Text.PlainText
                    text: "前往哪里？"
                    color: "#e8f5f7"
                    font.pixelSize: 18
                }
                Item {
                    Layout.fillWidth: true
                }
                GlassButton {
                    objectName: "palette-close"
                    text: "Esc"
                    onClicked: commandPalette.navigation.dismissPalette()
                }
            }
            GlassField {
                id: search
                objectName: "scene-search"
                Layout.fillWidth: true
                placeholderText: "搜索对话历史、资料、终端或角色…"
                text: commandPalette.navigation.query
                onTextEdited: commandPalette.navigation.query = text
                Keys.onReturnPressed: event => {
                    if (commandPalette.isComposing()) {
                        event.accepted = false;
                        return;
                    }
                    commandPalette.activateEntry(commandPalette.navigation.filteredEntries.find(entry => entry.available));
                    event.accepted = true;
                }
                Keys.onDownPressed: event => {
                    if (commandPalette.isComposing()) {
                        event.accepted = false;
                        return;
                    }
                    matches.forceActiveFocus(Qt.TabFocusReason);
                    event.accepted = true;
                }
            }
            ListView {
                id: matches
                objectName: "scene-search-results"
                Layout.fillWidth: true
                Layout.fillHeight: true
                clip: true
                model: commandPalette.navigation.filteredEntries
                currentIndex: 0
                spacing: 5
                keyNavigationEnabled: true
                delegate: Button {
                    id: resultButton
                    required property var modelData
                    required property int index
                    objectName: "search-result-" + modelData.feature + "-" + modelData.subentry
                    width: matches.width
                    height: 59
                    hoverEnabled: true
                    enabled: modelData.available
                    Accessible.name: modelData.label
                    Accessible.description: modelData.detail
                    onClicked: commandPalette.activateEntry(modelData)
                    background: Rectangle {
                        radius: 10
                        color: resultButton.hovered || resultButton.activeFocus || (matches.activeFocus && matches.currentIndex === resultButton.index) ? "#2b4357" : "#112537"
                    }
                    contentItem: Column {
                        spacing: 5
                        Text {
                            textFormat: Text.PlainText
                            text: resultButton.modelData.glyph + "  " + resultButton.modelData.label
                            color: resultButton.enabled ? "#deedf3" : "#8096a5"
                            font.pixelSize: 14
                        }
                        Text {
                            textFormat: Text.PlainText
                            text: resultButton.modelData.detail
                            color: "#91acbf"
                            font.pixelSize: 11
                        }
                    }
                }
                Keys.onReturnPressed: event => {
                    if (commandPalette.isComposing()) {
                        event.accepted = false;
                        return;
                    }
                    const entry = commandPalette.navigation.filteredEntries[currentIndex];
                    commandPalette.activateEntry(entry);
                    event.accepted = true;
                }
                Text {
                    anchors.centerIn: parent
                    visible: matches.count === 0
                    textFormat: Text.PlainText
                    text: "没有匹配入口"
                    color: "#9bb2c4"
                    font.pixelSize: 13
                }
            }
        }
    }
}
