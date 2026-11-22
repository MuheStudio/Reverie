import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: game
    objectName: "chessPanel"
    readonly property real unit: Math.max(0, Math.min(36, Math.floor((width - 16) / 8)))
    readonly property alias resetOpen: resetConfirm.visible
    readonly property alias resetReady: resetConfirm.opened
    readonly property alias firstFocusItem: mode

    Layout.fillWidth: true
    Layout.minimumWidth: 0
    spacing: 12
    onVisibleChanged: if (!visible) resetConfirm.close()

    ComboBox {
        id: mode
        objectName: "chessMode"
        model: ["本地练习", "角色对手"]
        currentIndex: session.gameCompanion ? 1 : 0
        enabled: session.gameReady || session.gameCanUndo
        onActivated: session.gameModeChanged(currentIndex === 1)
    }
    Text {
        visible: session.gameCompanion
        textFormat: Text.PlainText
        text: "角色对手每走一步调用一次回复服务（走法不合法时再补问一次），和聊天回复一样计入授权和预算。"
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Text {
        objectName: "chessStatus"
        textFormat: Text.PlainText
        text: session.gameStatus
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Text {
        objectName: "chessFeedback"
        visible: text !== ""
        textFormat: Text.PlainText
        text: session.gameFeedback
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Item {
        objectName: "chessBoard"
        Layout.preferredWidth: game.unit * 8
        Layout.preferredHeight: game.unit * 8
        Layout.alignment: Qt.AlignHCenter

        Repeater {
            model: 64
            Button {
                id: square
                required property int index
                readonly property int row: Math.floor(index / 8)
                readonly property int column: index % 8
                readonly property string coordinate: "abcdefgh"[column] + (8 - row)
                readonly property var piece: session.gameBoard[index] || ({})
                objectName: "chess-" + coordinate
                x: column * game.unit
                y: row * game.unit
                width: game.unit
                height: game.unit
                enabled: session.gameReady
                Accessible.name: coordinate + " " + (piece.label || "空格")
                onClicked: session.gameClick(index)
                background: Rectangle {
                    color: square.piece.check ? "#d2765d"
                        : square.piece.selected ? "#bfd097"
                        : square.piece.last ? "#c8b079"
                        : (square.row + square.column) % 2 ? "#8d7360" : "#e5d1ae"
                    border.width: square.activeFocus ? 2 : 0
                    border.color: "#323428"
                    Rectangle {
                        anchors.centerIn: parent
                        visible: !!square.piece.destination && !square.piece.color
                        width: game.unit * .24
                        height: width
                        radius: width / 2
                        color: "#425140"
                    }
                    Rectangle {
                        anchors.fill: parent
                        anchors.margins: 2
                        visible: !!square.piece.destination && !!square.piece.color
                        color: "transparent"
                        border.width: 2
                        border.color: "#425140"
                        radius: 3
                    }
                }
                contentItem: Text {
                    text: square.piece.glyph || ""
                    textFormat: Text.PlainText
                    color: square.piece.color === "white" ? "#fbf7e8" : "#232320"
                    style: square.piece.color === "white" ? Text.Outline : Text.Normal
                    styleColor: "#3d342d"
                    font.pixelSize: Math.floor(game.unit * .77)
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                }
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        GlassButton {
            objectName: "chessUndo"
            text: "悔一回合"
            enabled: session.gameCanUndo
            onClicked: session.gameUndo()
        }
        GlassButton {
            objectName: "chessReset"
            text: "重新开始"
            enabled: session.gameCanReset
            onClicked: resetConfirm.open()
        }
        GlassButton {
            objectName: "chessRead"
            visible: session.gameCanRead
            text: "重新读取"
            onClicked: session.gameRead()
        }
        Item { Layout.fillWidth: true }
    }
    Dialog {
        id: resetConfirm
        objectName: "chessResetDialog"
        title: "重新开始棋局？"
        modal: true
        closePolicy: Popup.CloseOnEscape
        width: 320
        anchors.centerIn: Overlay.overlay
        padding: 18
        property string openedScope
        property int openedGeneration
        onOpened: {
            openedScope = session.scopeKey;
            openedGeneration = session.connectionGeneration;
        }
        contentItem: RowLayout {
            GlassButton {
                objectName: "chessResetCancel"
                text: "取消"
                onClicked: resetConfirm.close()
            }
            Item { Layout.fillWidth: true }
            GlassButton {
                objectName: "chessResetConfirm"
                text: "重新开始"
                enabled: session.gameCanReset
                onClicked: {
                    const current = resetConfirm.openedScope === session.scopeKey
                        && resetConfirm.openedGeneration === session.connectionGeneration;
                    resetConfirm.close();
                    if (current)
                        session.gameReset();
                }
            }
        }
    }
}
