import QtQuick

QtObject {
    id: context
    property var window
    property var pendingAction: null
    readonly property var activeEditor: {
        let item = window ? window.activeFocusItem : null;
        while (item) {
            if (item.inputMethodComposing !== undefined)
                return item;
            item = item.parent;
        }
        return null;
    }
    readonly property bool composing: !!activeEditor && activeEditor.inputMethodComposing
    function commitBefore(action) {
        if (!composing) {
            action();
            return;
        }
        pendingAction = action;
        Qt.inputMethod.commit();
        Qt.callLater(flush);
    }
    function flush() {
        if (composing || !pendingAction)
            return;
        const action = pendingAction;
        pendingAction = null;
        action();
    }
    onComposingChanged: if (!composing)
        Qt.callLater(flush)
}
