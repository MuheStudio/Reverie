import QtQuick

// Static stand-in for the RuntimeBridge properties the companion view reads.
// No backend, data directory or model is involved.
QtObject {
    readonly property int connectionGeneration: 0 // Preview has no backend connection.

    property var messages: [
        {
            id: "preview-1",
            role: "user",
            content: "晚上好。"
        },
        {
            id: "preview-2",
            role: "assistant",
            content: "晚上好，今晚的月色很安静。"
        },
        {
            id: "preview-3",
            role: "user",
            content: "你好，今天想一起看看星空。"
        },
        {
            id: "preview-4",
            role: "assistant",
            content: "一起看看这片星空"
        }
    ]
    property var state: ({})
    property bool busy: false
    property bool connected: true
    property string draft: ""
    property string notice: ""
    property var chatFeedback: ({})
    property string avatarPath: ""
    property bool reducedMotion: false
    property bool reducedTransparency: false
    signal changed
    function sendChat() {
    }
    function cancelChat() {
    }
}
