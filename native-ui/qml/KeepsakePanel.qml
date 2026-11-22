import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

Item {
    id: keepsakes
    objectName: "keepsakePanel"
    readonly property var view: session.keepsakeView
    readonly property Item firstFocusItem: refresh
    readonly property bool modalOpen: removal.visible
    readonly property bool active: visible && session.panel === "keepsake"

    function syncRemoval() {
        if (active && view.removal?.id)
            removal.open();
        else
            removal.close();
    }
    onViewChanged: syncRemoval()
    onActiveChanged: syncRemoval()
    Component.onCompleted: syncRemoval()

    ColumnLayout {
        anchors.fill: parent
        spacing: 10
        RowLayout {
            Layout.fillWidth: true
            Text {
                objectName: "keepsakeTitle"
                Layout.fillWidth: true
                text: "收藏"
                textFormat: Text.PlainText
                color: "#e0eee7"
                font.pixelSize: 21
            }
            GlassButton {
                id: refresh
                objectName: "keepsakeRefresh"
                text: "刷新"
                enabled: session.connected && !session.personaChanging && keepsakes.view.listStatus !== "loading"
                onClicked: session.refreshKeepsakes()
            }
        }
        Text {
            objectName: "keepsakeNotice"
            Layout.fillWidth: true
            Layout.minimumWidth: 0
            visible: text.length > 0
            text: keepsakes.view.notice || (keepsakes.view.listStatus === "loading" ? "正在读取…" : "")
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            color: "#e6b4a4"
            font.pixelSize: 13
        }
        ScrollView {
            id: scroll
            objectName: "keepsakeScroll"
            Layout.fillWidth: true
            Layout.fillHeight: true
            clip: true
            contentWidth: availableWidth
            contentHeight: entriesColumn.implicitHeight + 16
            ScrollBar.horizontal.policy: ScrollBar.AlwaysOff
            ColumnLayout {
                id: entriesColumn
                width: scroll.availableWidth
                spacing: 12
                Text {
                    objectName: "keepsakeEmpty"
                    Layout.fillWidth: true
                    Layout.minimumWidth: 0
                    visible: keepsakes.view.listStatus === "ready" && (keepsakes.view.entries || []).length === 0
                    text: "在完整聊天历史里点『收藏』，喜欢的话会留在这里。"
                    textFormat: Text.PlainText
                    wrapMode: Text.Wrap
                    font.pixelSize: 14
                    color: "#bdd3df"
                }
                Repeater {
                    model: keepsakes.view.entries || []
                    Frame {
                        id: entry
                        required property var modelData
                        objectName: "keepsakeRow-" + modelData.id
                        Layout.fillWidth: true
                        Layout.minimumWidth: 0
                        padding: 12
                        background: Rectangle {
                            radius: 12
                            color: "#4a14232f"
                            border.color: "#286a8c90"
                        }
                        contentItem: ColumnLayout {
                            spacing: 8
                            RowLayout {
                                Layout.fillWidth: true
                                Text {
                                    objectName: "keepsakeSpeaker-" + entry.modelData.id
                                    Layout.fillWidth: true
                                    Layout.minimumWidth: 0
                                    text: entry.modelData.role === "user" ? "你" : (session.state.persona?.name || "她")
                                    textFormat: Text.PlainText
                                    elide: Text.ElideRight
                                    color: "#dce9e3"
                                    font.pixelSize: 14
                                }
                                GlassButton {
                                    objectName: "keepsakeRemove-" + entry.modelData.id
                                    text: "移除"
                                    implicitHeight: 30
                                    padding: 5
                                    enabled: keepsakes.view.writeAvailable === true
                                    onClicked: session.requestKeepsakeRemoval(entry.modelData.id)
                                }
                            }
                            Text {
                                objectName: "keepsakeTime-" + entry.modelData.id
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                text: entry.modelData.original_message_at_utc
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                color: "#91acbf"
                                font.pixelSize: 12
                            }
                            Text {
                                id: body
                                objectName: "keepsakeContent-" + entry.modelData.id
                                Layout.fillWidth: true
                                Layout.minimumWidth: 0
                                text: entry.modelData.content
                                textFormat: Text.PlainText
                                wrapMode: Text.Wrap
                                maximumLineCount: entry.modelData.expanded ? 2147483647 : 6
                                elide: entry.modelData.expanded ? Text.ElideNone : Text.ElideRight
                                color: "#e0eee7"
                                font.pixelSize: 15
                            }
                            GlassButton {
                                objectName: "keepsakeExpand-" + entry.modelData.id
                                visible: body.truncated || entry.modelData.expanded || entry.modelData.content_next_offset !== null
                                text: entry.modelData.expanded ? "收起" : "展开"
                                implicitHeight: 28
                                padding: 4
                                enabled: entry.modelData.contentLoading !== true
                                onClicked: session.toggleKeepsakeExpanded(entry.modelData.id)
                            }
                            Text {
                                visible: entry.modelData.contentLoading === true
                                text: "正在读取…"
                                textFormat: Text.PlainText
                                color: "#91acbf"
                                font.pixelSize: 12
                            }
                            Repeater {
                                model: entry.modelData.media_ids || []
                                Item {
                                    id: thumbnail
                                    required property string modelData
                                    readonly property var imageState: session.chatImageThumbnails[modelData] || ({})
                                    Layout.fillWidth: true
                                    Layout.preferredHeight: 100
                                    Image {
                                        objectName: "keepsakeImage-" + entry.modelData.id + "-" + thumbnail.modelData
                                        width: Math.min(parent.width, 180)
                                        height: parent.height
                                        source: thumbnail.imageState.source || ""
                                        cache: false
                                        fillMode: Image.PreserveAspectFit
                                        visible: status === Image.Ready
                                    }
                                    Text {
                                        objectName: "keepsakeImageError-" + entry.modelData.id
                                        visible: thumbnail.imageState.status === "error"
                                        text: "图片读不到"
                                        textFormat: Text.PlainText
                                        color: "#e6b4a4"
                                        font.pixelSize: 13
                                    }
                                }
                            }
                        }
                    }
                }
                GlassButton {
                    objectName: "keepsakeLoadMore"
                    visible: keepsakes.view.hasMore === true
                    enabled: keepsakes.view.listStatus === "ready"
                    text: "查看更多"
                    onClicked: session.loadMoreKeepsakes()
                }
            }
        }
    }
    Connections {
        target: scroll.contentItem
        function onMovementEnded() {
            if (scroll.contentItem.atYEnd && keepsakes.view.hasMore === true)
                session.loadMoreKeepsakes();
        }
    }
    Dialog {
        id: removal
        objectName: "keepsakeRemoveDialog"
        parent: Overlay.overlay
        anchors.centerIn: parent
        width: Math.min(360, parent ? parent.width - 40 : 360)
        modal: true
        title: "移除收藏"
        closePolicy: Popup.NoAutoClose
        contentItem: Text {
            objectName: "keepsakeRemoveWarning"
            text: "移除后不能恢复"
            textFormat: Text.PlainText
            wrapMode: Text.Wrap
            font.pixelSize: 15
            color: "#e0eee7"
        }
        background: Rectangle { radius: 16; color: "#182833"; border.color: "#526b78" }
        footer: RowLayout {
            spacing: 10
            Item { Layout.fillWidth: true }
            GlassButton {
                objectName: "keepsakeRemoveCancel"
                text: "取消"
                onClicked: session.cancelKeepsakeRemoval()
            }
            GlassButton {
                objectName: "keepsakeRemoveConfirm"
                text: "移除"
                enabled: keepsakes.view.writeAvailable === true
                onClicked: session.confirmKeepsakeRemoval()
            }
        }
    }
}
