import QtQuick
import QtQuick.Controls
import QtQuick.Layouts

ColumnLayout {
    id: game
    objectName: "goPanel"
    readonly property int side: 9
    readonly property real unit: Math.max(0, Math.min(38, (width - 16) / side))
    readonly property alias firstFocusItem: mode
    readonly property bool resetOpen: confirmation.visible && !confirmation.ending
    readonly property bool resetReady: confirmation.opened && !confirmation.ending
    readonly property bool endOpen: confirmation.visible && confirmation.ending

    Layout.fillWidth: true
    Layout.minimumWidth: 0
    spacing: 12
    onVisibleChanged: if (!visible) confirmation.close()

    ComboBox {
        id: mode
        objectName: "goMode"
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
        objectName: "goStatus"
        textFormat: Text.PlainText
        text: session.gameStatus
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Text {
        objectName: "goLastPass"
        visible: session.gameLastPass
        textFormat: Text.PlainText
        text: "对方停一手"
        color: "#a8cbbb"
        font.pixelSize: 12
        Layout.fillWidth: true
    }
    Text {
        objectName: "goFeedback"
        visible: text !== ""
        textFormat: Text.PlainText
        text: session.gameFeedback
        color: "#a8cbbb"
        font.pixelSize: 12
        wrapMode: Text.Wrap
        Layout.fillWidth: true
    }
    Item {
        objectName: "goBoard"
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
                ctx.beginPath();
                for (let line = 0; line < game.side; ++line) {
                    const point = game.unit * (line + .5);
                    ctx.moveTo(start, point);
                    ctx.lineTo(end, point);
                    ctx.moveTo(point, start);
                    ctx.lineTo(point, end);
                }
                ctx.stroke();
            }
        }
        Repeater {
            model: game.side * game.side
            Button {
                id: point
                required property int index
                readonly property int row: Math.floor(index / game.side)
                readonly property int column: index % game.side
                readonly property var piece: session.gameBoard[index] || ({})
                objectName: "go-" + index
                x: column * game.unit
                y: row * game.unit
                width: game.unit
                height: game.unit
                enabled: session.gameReady && !piece.color
                Accessible.name: (piece.label || "空位") + " 行" + row + " 列" + column
                onClicked: session.gameClick(index)
                background: Item {
                    Rectangle {
                        anchors.centerIn: parent
                        width: game.unit * .77
                        height: width
                        radius: width / 2
                        color: point.piece.color === "black" ? "#222830"
                            : point.piece.color === "white" ? "#f8f0df"
                            : point.hovered && point.enabled ? "#553d3221" : "transparent"
                        border.width: point.piece.last ? 2 : point.piece.color || point.activeFocus ? 1 : 0
                        border.color: point.piece.last ? "#b14437" : "#745d43"
                    }
                }
            }
        }
    }
    RowLayout {
        Layout.fillWidth: true
        GlassButton {
            objectName: "goPass"
            text: "停一手"
            enabled: session.gameReady
            onClicked: session.gamePass()
        }
        GlassButton {
            objectName: "goEnd"
            text: "结束并数目"
            enabled: session.gameCanEnd
            onClicked: {
                confirmation.ending = true;
                confirmation.open();
            }
        }
        GlassButton {
            objectName: "goUndo"
            text: "悔一回合"
            enabled: session.gameCanUndo
            onClicked: session.gameUndo()
        }
        GlassButton {
            objectName: "goReset"
            text: "重新开始"
            enabled: session.gameCanReset
            onClicked: {
                confirmation.ending = false;
                confirmation.open();
            }
        }
        GlassButton {
            objectName: "goRead"
            visible: session.gameCanRead
            text: "重新读取"
            onClicked: session.gameRead()
        }
        Item { Layout.fillWidth: true }
    }
    Dialog {
        id: confirmation
        objectName: ending ? "goEndDialog" : "goResetDialog"
        title: ending ? "结束棋局并数目？" : "重新开始棋局？"
        modal: true
        closePolicy: Popup.CloseOnEscape
        width: 320
        anchors.centerIn: Overlay.overlay
        padding: 18
        property bool ending: false
        property string openedScope
        property int openedGeneration
        onOpened: {
            openedScope = session.scopeKey;
            openedGeneration = session.connectionGeneration;
        }
        contentItem: RowLayout {
            GlassButton {
                objectName: confirmation.ending ? "goEndCancel" : "goResetCancel"
                text: "取消"
                onClicked: confirmation.close()
            }
            Item { Layout.fillWidth: true }
            GlassButton {
                objectName: confirmation.ending ? "goEndConfirm" : "goResetConfirm"
                text: confirmation.ending ? "结束并数目" : "重新开始"
                enabled: confirmation.ending ? session.gameCanEnd : session.gameCanReset
                onClicked: {
                    const current = confirmation.openedScope === session.scopeKey
                        && confirmation.openedGeneration === session.connectionGeneration;
                    confirmation.close();
                    if (!current)
                        return;
                    if (confirmation.ending)
                        session.gameEnd();
                    else
                        session.gameReset();
                }
            }
        }
    }
}
