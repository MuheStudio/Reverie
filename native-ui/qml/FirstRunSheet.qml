pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Layouts

// First-run setup over the room. It owns no session state: the reply service is
// configured on the existing terminal page, the nickname is the profile save, and
// only the runtime's read-back of `onboarding_completed` ends it. Leaving midway
// keeps nothing; the next launch starts at the welcome step again.
FocusScope {
    id: sheet
    property var navigation
    property var sceneSource
    property var blurredSource
    property Item sceneRoot
    // 0 welcome, 1 reply service, 2 nickname, 3 finish.
    property int step: 0
    property string profileRequestId: ""
    signal openService(Item sourceItem)
    objectName: "firstRunSheet"
    // Hidden while another surface or the palette is in front; it comes back on return.
    readonly property bool active: session.firstRunPending && navigation.currentFeature === "chat" && !navigation.paletteOpen
    visible: active
    enabled: visible
    z: 210

    readonly property string gateStatus: session.chatSendGate?.status || ""
    readonly property bool serviceConfigured: !!session.state.provider?.model && !["provider_unconfigured", "provider_pending", "provider_saving"].includes(gateStatus)
    readonly property string serviceText: serviceConfigured ? "当前服务：" + session.state.provider.provider + " · " + session.state.provider.model : gateStatus === "provider_unconfigured" ? "还没有配置回复服务。" : "正在确认回复服务…"
    readonly property var profileReceipt: session.memoryFeedback?.profile || ({})
    readonly property bool profilePending: profileRequestId !== "" && profileReceipt.requestId === profileRequestId && profileReceipt.status === "pending"
    readonly property var finishReceipt: session.settingsFeedback?.onboarding || ({})
    readonly property bool finishPending: finishReceipt.status === "pending"
    readonly property string receiptText: step === 2 && profileReceipt.requestId === profileRequestId && profileReceipt.status === "error" ? (profileReceipt.text || "") : step === 3 && ["error", "unknown"].includes(finishReceipt.status) ? (finishReceipt.text || "") : ""

    function focusStep() {
        const item = [startButton, openServiceButton, nicknameField, finishButton][step];
        if (item && item.visible)
            item.forceActiveFocus(Qt.OtherFocusReason);
    }
    onVisibleChanged: if (visible)
        Qt.callLater(focusStep)
    onStepChanged: Qt.callLater(focusStep)
    onProfileReceiptChanged: {
        if (profileRequestId !== "" && profileReceipt.requestId === profileRequestId && profileReceipt.status === "success") {
            profileRequestId = "";
            step = 3;
        }
    }
    function saveNickname() {
        if (profilePending || nicknameField.text.trim().length === 0)
            return;
        session.saveProfile({
            nickname: nicknameField.text
        });
        const receipt = session.memoryFeedback?.profile || {};
        profileRequestId = receipt.status === "pending" ? receipt.requestId : "";
    }

    Rectangle {
        anchors.fill: parent
        color: "#99040c19"
    }
    // Modal: the room below takes no pointer input while the sheet is up.
    MouseArea {
        anchors.fill: parent
        acceptedButtons: Qt.AllButtons
        hoverEnabled: true
        onWheel: wheel => wheel.accepted = true
    }
    GlassPane {
        id: card
        objectName: "firstRunCard"
        x: (parent.width - width) / 2
        y: Math.max(70, (parent.height - height) / 2)
        width: Math.min(520, parent.width - 48)
        height: content.implicitHeight + 2 * padding
        padding: 26
        sceneSource: sheet.sceneSource
        blurredSource: sheet.blurredSource
        sceneRoot: sheet.sceneRoot
        materialRole: "work"
        cornerRadius: 24
        ColumnLayout {
            id: content
            anchors.left: parent.left
            anchors.right: parent.right
            spacing: 16
            Text {
                objectName: "firstRunStepLabel"
                textFormat: Text.PlainText
                text: ["欢迎", "回复服务", "你的称呼", "准备就绪"][sheet.step] + "  ·  " + (sheet.step + 1) + " / 4"
                color: "#8fb7b8"
                font.pixelSize: 12
            }
            // Welcome
            ColumnLayout {
                visible: sheet.step === 0
                Layout.fillWidth: true
                spacing: 12
                Text {
                    textFormat: Text.PlainText
                    text: "欢迎来到月光观景室"
                    color: "#e8f5f7"
                    font.pixelSize: 20
                }
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: "对话、记忆和设置都保存在这台电脑上。聊天内容只会发给你选择的回复服务，服务密钥存放在系统钥匙串中。\n接下来用一分钟完成两项设置，都可以之后在终端里修改。"
                    wrapMode: Text.Wrap
                    color: "#c3d5d8"
                    font.pixelSize: 13
                    lineHeight: 1.25
                }
                RowLayout {
                    Layout.fillWidth: true
                    Item {
                        Layout.fillWidth: true
                    }
                    GlassButton {
                        id: startButton
                        objectName: "firstRunStart"
                        text: "开始"
                        accented: true
                        onClicked: sheet.step = 1
                    }
                }
            }
            // Reply service: configured only on the terminal service page.
            ColumnLayout {
                visible: sheet.step === 1
                Layout.fillWidth: true
                spacing: 12
                Text {
                    textFormat: Text.PlainText
                    text: "选择回复服务"
                    color: "#e8f5f7"
                    font.pixelSize: 20
                }
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: "她的回复来自你选择的服务：本机服务或云端服务。在「服务与隐私」页测试通过后保存即可。"
                    wrapMode: Text.Wrap
                    color: "#c3d5d8"
                    font.pixelSize: 13
                }
                Text {
                    objectName: "firstRunServiceStatus"
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: sheet.serviceText
                    wrapMode: Text.Wrap
                    color: sheet.serviceConfigured ? "#aadcc9" : "#dbc39c"
                    font.pixelSize: 13
                    Accessible.role: Accessible.StaticText
                    Accessible.name: text
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    GlassButton {
                        id: openServiceButton
                        objectName: "firstRunOpenService"
                        text: "去设置回复服务"
                        onClicked: sheet.openService(openServiceButton)
                    }
                    Item {
                        Layout.fillWidth: true
                    }
                    GlassButton {
                        objectName: "firstRunSkipService"
                        visible: !sheet.serviceConfigured
                        text: "稍后设置"
                        onClicked: sheet.step = 2
                    }
                    GlassButton {
                        objectName: "firstRunServiceNext"
                        visible: sheet.serviceConfigured
                        text: "下一步"
                        accented: true
                        onClicked: sheet.step = 2
                    }
                }
            }
            // Nickname: the profile save; only its receipt moves on.
            ColumnLayout {
                visible: sheet.step === 2
                Layout.fillWidth: true
                spacing: 12
                Text {
                    textFormat: Text.PlainText
                    text: "她该怎么称呼你？"
                    color: "#e8f5f7"
                    font.pixelSize: 20
                }
                GlassField {
                    id: nicknameField
                    objectName: "firstRunNickname"
                    Layout.fillWidth: true
                    placeholderText: "你的称呼"
                    maximumLength: 80
                    enabled: !sheet.profilePending
                    sceneSource: sheet.sceneSource
                    blurredSource: sheet.blurredSource
                    sceneRoot: sheet.sceneRoot
                    Keys.onReturnPressed: event => {
                        if (nicknameField.inputMethodComposing) {
                            event.accepted = false;
                            return;
                        }
                        sheet.saveNickname();
                        event.accepted = true;
                    }
                }
                RowLayout {
                    Layout.fillWidth: true
                    spacing: 8
                    Item {
                        Layout.fillWidth: true
                    }
                    GlassButton {
                        objectName: "firstRunSkipNickname"
                        text: "跳过"
                        enabled: !sheet.profilePending
                        onClicked: sheet.step = 3
                    }
                    GlassButton {
                        objectName: "firstRunSaveNickname"
                        text: sheet.profilePending ? "正在保存…" : "保存并继续"
                        accented: true
                        enabled: !sheet.profilePending && nicknameField.text.trim().length > 0
                        onClicked: sheet.saveNickname()
                    }
                }
            }
            // Finish: hidden only by the runtime's read-back of the completed flag.
            ColumnLayout {
                visible: sheet.step === 3
                Layout.fillWidth: true
                spacing: 12
                Text {
                    textFormat: Text.PlainText
                    text: "一切就绪"
                    color: "#e8f5f7"
                    font.pixelSize: 20
                }
                Text {
                    Layout.fillWidth: true
                    textFormat: Text.PlainText
                    text: sheet.serviceConfigured ? "回复服务已经就绪，可以开始聊天了。" : "还没有配置回复服务，聊天会先保留在输入框里。随时可以在终端的「服务与隐私」页设置。"
                    wrapMode: Text.Wrap
                    color: "#c3d5d8"
                    font.pixelSize: 13
                }
                RowLayout {
                    Layout.fillWidth: true
                    Item {
                        Layout.fillWidth: true
                    }
                    GlassButton {
                        id: finishButton
                        objectName: "firstRunFinish"
                        text: sheet.finishPending ? "正在保存…" : "进入房间"
                        accented: true
                        enabled: !sheet.finishPending
                        onClicked: session.saveSettings("onboarding", {
                            completed: true
                        })
                    }
                }
            }
            Text {
                objectName: "firstRunReceipt"
                Layout.fillWidth: true
                visible: text.length > 0
                textFormat: Text.PlainText
                text: sheet.receiptText
                wrapMode: Text.Wrap
                color: "#e6b4a4"
                font.pixelSize: 12
                Accessible.role: Accessible.StaticText
                Accessible.name: text
            }
        }
    }
}
