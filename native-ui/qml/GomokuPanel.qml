import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: game
    objectName: "gomokuPanel"
    readonly property int side: 15
    readonly property real unit: Math.max(0, Math.min(28, (width - 16) / side))
    readonly property alias resetOpen: resetConfirm.visible
    readonly property alias firstFocusItem: mode

    Layout.fillWidth: true
    Layout.minimumWidth: 0
    spacing: 12
    onVisibleChanged: if (!visible) resetConfirm.close()

    ComboBox {
        id: mode
        objectName: "gomokuMode"
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
        objectName: "gomokuStatus"
        textFormat: Text.PlainText
        text: session.gameStatus
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Text {
        objectName: "gomokuFeedback"
        visible: text !== ""
        textFormat: Text.PlainText
        text: session.gameFeedback
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Item {
        objectName: "gomokuBoard"
        Layout.preferredWidth: game.unit * game.side
        Layout.preferredHeight: game.unit * game.side
        Layout.alignment: Qt.AlignHCenter
        Rectangle {
            anchors.fill: parent
            color: "#c4ab87"
            radius: 12
            border.color: "#e1c8a0"
        }
        Canvas {
            anchors.fill: parent
            onWidthChanged: requestPaint()
            onPaint: {
                const ctx = getContext("2d");
                ctx.clearRect(0, 0, width, height);
                ctx.strokeStyle = "#73614b";
                ctx.lineWidth = 1;
                const start = game.unit / 2;
                const end = game.unit * (game.side - .5);
                for (let n = 0; n < game.side; ++n) {
                    const point = game.unit * (n + .5);
                    ctx.beginPath();
                    ctx.moveTo(start, point);
                    ctx.lineTo(end, point);
                    ctx.moveTo(point, start);
                    ctx.lineTo(point, end);
                    ctx.stroke();
                }
            }
        }
        Repeater {
            model: game.side * game.side
            Button {
                id: square
                required property int index
                readonly property var piece: session.gameBoard[index] || ({})
                objectName: "gomoku-" + index
                x: (index % game.side) * game.unit
                y: Math.floor(index / game.side) * game.unit
                width: game.unit
                height: game.unit
                enabled: session.gameReady && !piece.color
                Accessible.name: (piece.label || "空位") + " 行" + Math.floor(index / game.side) + " 列" + index % game.side
                onClicked: session.gameClick(index)
                background: Item {
                    Rectangle {
                        anchors.centerIn: parent
                        width: game.unit * .77
                        height: width
                        radius: width / 2
                        color: square.piece.color === "black" ? "#293038"
                            : square.piece.color === "white" ? "#f4ead6"
                            : square.hovered && square.enabled ? "#52452f65" : "transparent"
                        border.width: square.piece.last ? 2 : square.piece.color ? 1 : square.activeFocus ? 1 : 0
                        border.color: square.piece.last ? "#b14437" : "#745d43"
                    }
                }
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        GlassButton {
            objectName: "gomokuUndo"
            text: "悔一回合"
            enabled: session.gameCanUndo
            onClicked: session.gameUndo()
        }
        GlassButton {
            objectName: "gomokuReset"
            text: "重新开始"
            enabled: session.gameCanReset
            onClicked: resetConfirm.open()
        }
        GlassButton {
            objectName: "gomokuRead"
            visible: session.gameCanRead
            text: "重新读取"
            onClicked: session.gameRead()
        }
        Item { Layout.fillWidth: true }
    }
    Dialog {
        id: resetConfirm
        objectName: "gomokuResetDialog"
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
                objectName: "gomokuResetCancel"
                text: "取消"
                onClicked: resetConfirm.close()
            }
            Item { Layout.fillWidth: true }
            GlassButton {
                objectName: "gomokuResetConfirm"
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
