import QtQuick
import QtQuick.Layouts

ColumnLayout {
    id: diary
    objectName: "diaryPanel"
    readonly property var view: session.diaryView
    readonly property Item firstFocusItem: diarySwitch
    signal authorizationRequested()
    spacing: 8

    component DiaryLine: Text {
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        textFormat: Text.PlainText
        wrapMode: Text.Wrap
        color: "#bdd3df"
        font.pixelSize: 13
    }

    GlassSwitch {
        id: diarySwitch
        objectName: "diaryEnabled"
        text: "让她写日记"
        checked: diary.view.enabled === true
        enabled: diary.view.switchAvailable === true
        onToggled: {
            session.setDiaryEnabled(checked);
            // A user toggle moves the control before its reply. Restore the
            // binding so only a confirmed setting determines the displayed value.
            checked = Qt.binding(() => diary.view.enabled === true);
        }
    }
    DiaryLine {
        objectName: "diarySaveNotice"
        visible: text.length > 0
        text: diary.view.saveNotice || ""
    }
    DiaryLine {
        text: "打开后，当天和她聊满 6 条，她会在半小时内写一篇。每篇会调用两次回复服务（写一次、核对一次），可能产生费用。写日记时，人格说明、当时的情绪和当天的事件记忆会发给回复服务。"
    }
    DiaryLine {
        objectName: "diaryAuthorizationNeeded"
        visible: diary.view.enabled === true && diary.view.authorized !== true
        text: "还需要授权这项费用"
    }
    GlassButton {
        objectName: "diaryAuthorize"
        visible: diary.view.enabled === true && diary.view.authorized !== true
        enabled: session.runtimeWritable && !session.personaChanging && session.permissionsKnown &&
                 session.providerFeedback?.saving !== true &&
                 session.permissionFeedback?.diary_generation?.status !== "pending" &&
                 !!session.state.permissions?.features?.diary_generation?.consent_digest
        text: "授权当前服务"
        onClicked: diary.authorizationRequested()
    }
    DiaryLine {
        visible: text.length > 0
        text: session.permissionFeedback?.diary_generation?.text || ""
    }
    Flow {
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        spacing: 8
        GlassButton {
            objectName: "diaryWrite"
            text: "现在写今天的日记"
            enabled: diary.view.writeBlocker === ""
            onClicked: session.writeDiary()
        }
        Text {
            text: "会调用两次回复服务"
            textFormat: Text.PlainText
            font.pixelSize: 12
            color: "#bdd3df"
            height: 32
            verticalAlignment: Text.AlignVCenter
        }
    }
    DiaryLine {
        objectName: "diaryWriteNotice"
        visible: text.length > 0
        text: diary.view.writeNotice || diary.view.writeBlocker || ""
    }
    GlassButton {
        text: "刷新列表"
        enabled: session.connected && !session.personaChanging && diary.view.listStatus !== "loading"
        onClicked: session.refreshDiary()
    }
    DiaryLine {
        objectName: "diaryEmpty"
        visible: diary.view.listStatus === "ready" && (diary.view.entries || []).length === 0
        text: "还没有日记。"
    }
    DiaryLine {
        objectName: "diaryListNotice"
        visible: diary.view.listStatus !== "ready"
        text: diary.view.listStatus === "loading" ? "正在读取…" : "日记暂时读不到"
    }
    Repeater {
        model: diary.view.entries || []
        GlassButton {
            required property var modelData
            objectName: "diaryDate-" + modelData.date
            text: modelData.label
            onClicked: session.readDiary(modelData.date)
        }
    }
    DiaryLine {
        objectName: "diaryReadNotice"
        visible: text.length > 0
        text: diary.view.readNotice || ""
    }
    ColumnLayout {
        Layout.fillWidth: true
        Layout.minimumWidth: 0
        visible: !!diary.view.entry?.date
        DiaryLine {
            objectName: "diaryTitle"
            text: diary.view.entry?.title || ""
            font.pixelSize: 16
        }
        DiaryLine {
            objectName: "diaryCreatedAt"
            text: diary.view.entry?.createdAt || ""
        }
        DiaryLine {
            objectName: "diaryContent"
            text: diary.view.entry?.content || ""
        }
        DiaryLine {
            objectName: "diaryFallback"
            visible: diary.view.entry?.groundedFallback === true
            text: "这一篇核对没通过，只按已记下的事来写。"
        }
    }
}
