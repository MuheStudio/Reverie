import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: game
    objectName: "xiangqiPanel"
    readonly property real unit: Math.max(0, Math.min(44, (width - 16) / 9))
    readonly property alias resetOpen: resetConfirm.visible
    readonly property alias firstFocusItem: mode

    Layout.fillWidth: true
    spacing: 12
    onVisibleChanged: if (!visible) resetConfirm.close()

    RowLayout {
        Layout.fillWidth: true
        ComboBox {
            id: mode
            objectName: "xiangqiMode"
            model: ["本地练习", "角色对手"]
            currentIndex: session.gameCompanion ? 1 : 0
            enabled: session.gameReady || session.gameCanUndo
            onActivated: session.gameModeChanged(currentIndex === 1)
        }
        Item { Layout.fillWidth: true }
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
        objectName: "xiangqiStatus"
        textFormat: Text.PlainText
        text: session.gameStatus
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Text {
        objectName: "xiangqiFeedback"
        visible: text !== ""
        textFormat: Text.PlainText
        text: session.gameFeedback
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Item {
        id: board
        objectName: "xiangqiBoard"
        Layout.preferredWidth: game.unit * 9
        Layout.preferredHeight: game.unit * 10
        Layout.alignment: Qt.AlignHCenter
        Rectangle {
            anchors.fill: parent
            color: "#b4b9a7"
            radius: 13
            border.color: "#dae1c8"
        }
        Canvas {
            anchors.fill: parent
            onWidthChanged: requestPaint()
            onPaint: {
                const c = getContext("2d");
                c.clearRect(0, 0, width, height);
                c.strokeStyle = "#536567";
                c.lineWidth = 1;
                for (let row = 0; row < 10; ++row) {
                    c.beginPath();
                    c.moveTo(game.unit / 2, game.unit * (row + .5));
                    c.lineTo(game.unit * 8.5, game.unit * (row + .5));
                    c.stroke();
                }
                for (let column = 0; column < 9; ++column) {
                    const x = game.unit * (column + .5);
                    c.beginPath();
                    c.moveTo(x, game.unit / 2);
                    c.lineTo(x, game.unit * 4.5);
                    c.moveTo(x, game.unit * 5.5);
                    c.lineTo(x, game.unit * 9.5);
                    c.stroke();
                }
            }
        }
        Repeater {
            model: 90
            Button {
                id: square
                required property int index
                readonly property int boardIndex: (9 - Math.floor(index / 9)) * 9 + index % 9
                readonly property var piece: session.gameBoard[boardIndex] || ({})
                objectName: "xiangqi-" + boardIndex
                x: (index % 9) * game.unit
                y: Math.floor(index / 9) * game.unit
                width: game.unit
                height: game.unit
                enabled: session.gameReady
                Accessible.name: (piece.label || "空位") + " x=" + (boardIndex % 9) + " y=" + Math.floor(boardIndex / 9)
                onClicked: session.gameClick(boardIndex)
                background: Rectangle {
                    anchors.centerIn: parent
                    width: game.unit * .78
                    height: width
                    radius: width / 2
                    color: square.piece.label ? "#e1deca" : square.piece.destination ? "#638b76" : "transparent"
                    border.width: square.piece.selected ? 3 : square.piece.destination ? 2 : square.piece.label ? 1 : 0
                    border.color: square.piece.selected || square.piece.destination ? "#158584" : "#748778"
                }
                contentItem: Text {
                    textFormat: Text.PlainText
                    text: square.piece.label || ""
                    horizontalAlignment: Text.AlignHCenter
                    verticalAlignment: Text.AlignVCenter
                    font.family: "Songti SC"
                    font.pixelSize: game.unit * .48
                    font.bold: true
                    color: square.piece.color === "red" ? "#9b4242" : "#19393e"
                }
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        GlassButton {
            objectName: "xiangqiUndo"
            text: "悔一回合"
            enabled: session.gameCanUndo
            onClicked: session.gameUndo()
        }
        GlassButton {
            objectName: "xiangqiReset"
            text: "重新开始"
            enabled: session.gameCanReset
            onClicked: resetConfirm.open()
        }
        GlassButton {
            objectName: "xiangqiRead"
            visible: session.gameCanRead
            text: "重新读取"
            onClicked: session.gameRead()
        }
        Item { Layout.fillWidth: true }
    }
    Dialog {
        id: resetConfirm
        objectName: "xiangqiResetDialog"
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
                objectName: "xiangqiResetCancel"
                text: "取消"
                onClicked: resetConfirm.close()
            }
            Item { Layout.fillWidth: true }
            GlassButton {
                objectName: "xiangqiResetConfirm"
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
