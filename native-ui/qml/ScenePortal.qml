import QtQuick
import QtQuick.Controls
import QtQuick.Window

FocusScope {
    id: portal
    property var navigation
    property var director
    property string destination
    property string glyph
    property string text
    property string hint
    property bool closedVisible: true
    property rect closedRect: Qt.rect(0, 0, 220, 78)
    property rect expandedRect: Qt.rect(400, 94, 540, 650)
    property var sceneSource
    property var blurredSource
    property Item sceneRoot
    property bool reducedMotion: false
    property real progress: Math.max(0, Math.min(1, motion.value))
    property string transitionState: "closed"
    property bool dragging: false
    property real dragStartProgress: 0
    property point dragStartPoint: Qt.point(0, 0)
    property bool dragCanceled: false
    property bool gestureArmed: false
    property bool componentReady: false
    property int pressedRevision: -1
    property int transitionRevision: -1
    property int pendingMotionRevision: 0
    property int settleIntent: 0
    property int completedSettleIntent: -1
    property var settleFocusWindow
    property string settleFocusScope: ""
    property int settleFocusGeneration: 0
    property int settleFocusActivity: 0
    property real dragLastTime: 0
    property real dragLastProgress: 0
    property real dragVelocity: 0
    property alias body: contentHost.data
    readonly property bool desiredOpen: !!navigation && navigation.currentFeature === destination
    readonly property bool contentReady: desiredOpen && transitionState === "open" && motion.geometrySettled && !dragging && !motion.held && !handleMouse.pressed && progress >= 1
    readonly property bool inputReady: contentReady && !!navigation && !navigation.paletteOpen
    readonly property bool decorationsSettling: !reducedMotion && motion.decorationsSettling
    readonly property real settleEnergy: reducedMotion ? 0 : motion.settleEnergy
    readonly property real motionVelocity: motion.velocity
    readonly property string materialRole: progress > 0 ? "work" : "clear"
    readonly property bool selected: desiredOpen
    // Each drawer retains its own destination during a task-to-task handoff.
    // A resize recomputes the layout at the same physical spring progress.
    readonly property rect destinationRect: director && typeof director.taskRectFor === "function" ? director.taskRectFor(destination) : expandedRect
    readonly property real unfoldProgress: phaseWeight(.62, 1, progress)
    readonly property real horizontalProgress: phaseWeight(director && director.compact && destination !== "character" ? .30 : destination === "memory" ? .26 : 0, .62, progress)
    readonly property real transitY: director && destination === "memory" && !director.compact ? Math.max(closedRect.y, director.avatarReserveRect.y + director.avatarReserveRect.height + 18) : closedRect.y
    readonly property rect geometryRect: director && typeof director.portalRectFor === "function" ? director.portalRectFor(destination, progress, closedRect) : Qt.rect(closedRect.x + (destinationRect.x - closedRect.x) * horizontalProgress, closedRect.y + (destinationRect.y - closedRect.y) * unfoldProgress, closedRect.width + (destinationRect.width - closedRect.width) * unfoldProgress, closedRect.height + (destinationRect.height - closedRect.height) * unfoldProgress)
    readonly property real portalBodyOpacity: phaseWeight(.64, .93, progress) * (director ? director.taskBodyOpacity : 1)
    readonly property real headerHeight: closedRect.height + (64 - closedRect.height) * progress
    readonly property real gestureSpan: Math.max(120, Math.min(240, Math.sqrt(Math.pow(destinationRect.x - closedRect.x, 2) + Math.pow(destinationRect.y - closedRect.y, 2)) * .42))
    readonly property point gestureDirection: {
        const dx = destinationRect.x + destinationRect.width / 2 - closedRect.x - closedRect.width / 2;
        const dy = destinationRect.y + 32 - closedRect.y - closedRect.height / 2;
        const distance = Math.max(1, Math.sqrt(dx * dx + dy * dy));
        return Qt.point(dx / distance, dy / distance);
    }
    signal opened
    signal collapsed

    // One physical object; all rectangles use the parent/window coordinate space.
    x: geometryRect.x
    y: geometryRect.y
    width: geometryRect.width
    height: geometryRect.height
    visible: closedVisible || progress > 0
    z: dragging ? 120 : desiredOpen ? 110 : progress > 0 ? 100 : 10
    clip: false
    activeFocusOnTab: visible
    Accessible.role: Accessible.Pane
    Accessible.name: text
    Accessible.description: hint

    function phaseWeight(lo, hi, value) {
        const t = Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
        return t * t * (3 - 2 * t);
    }
    function navigationRevision() {
        return navigation && navigation.transitionRevision !== undefined ? navigation.transitionRevision : 0;
    }
    function observeDirector() {
        if (director && typeof director.observePortalMotion === "function")
            director.observePortalMotion(destination, progress, dragging, motion.velocity, motion.geometrySettled, transitionRevision);
        else if (director && typeof director.observePortal === "function")
            director.observePortal(destination, progress, dragging);
    }
    function rememberBodyFocus() {
        if (!navigation || typeof navigation.rememberFeatureFocus !== "function" || !Window.window)
            return;
        const focused = Window.window.activeFocusItem;
        for (let item = focused; item; item = item.parent) {
            if (item === contentHost) {
                navigation.rememberFeatureFocus(destination, focused);
                return;
            }
        }
    }
    function captureSettleFocusContext() {
        settleFocusWindow = navigation ? navigation.focusWindow : null;
        settleFocusScope = navigation && navigation.focusScopeKey !== undefined ? navigation.focusScopeKey : "";
        settleFocusGeneration = navigation && navigation.focusGeneration !== undefined ? navigation.focusGeneration : 0;
        settleFocusActivity = navigation && navigation.focusActivityRevision !== undefined ? navigation.focusActivityRevision : 0;
    }
    function settle(open) {
        const target = open ? 1 : 0;
        transitionRevision = navigationRevision();
        settleIntent += 1;
        captureSettleFocusContext();
        pendingMotionRevision = motion.revision + 1;
        transitionState = open ? "opening" : "closing";
        motion.retarget(target);
    }
    function finishTransition(completedRevision) {
        if (!componentReady || completedRevision !== pendingMotionRevision || completedRevision !== motion.revision
                || completedSettleIntent === settleIntent)
            return;
        transitionState = progress >= 1 ? "open" : "closed";
        // A previous destination's completion must never reclaim keyboard focus.
        if (transitionRevision !== navigationRevision() || dragging || motion.held || handleMouse.pressed || !navigation || navigation.paletteOpen || navigation.transitionCommitting)
            return;
        completedSettleIntent = settleIntent;
        if (settleFocusWindow !== navigation.focusWindow
                || settleFocusScope !== (navigation.focusScopeKey !== undefined ? navigation.focusScopeKey : "")
                || settleFocusGeneration !== (navigation.focusGeneration !== undefined ? navigation.focusGeneration : 0)
                || settleFocusActivity !== (navigation.focusActivityRevision !== undefined ? navigation.focusActivityRevision : 0))
            return;
        if (progress >= 1 && desiredOpen)
            opened();
        else if (progress <= 0) {
            collapsed();
            if (!navigation.surfaceOpen)
                navigation.restoreFocus(transitionRevision);
        }
    }
    function cancelDrag() {
        if (!dragging && !gestureArmed && !motion.held)
            return;
        gestureArmed = false;
        dragging = false;
        dragCanceled = true;
        settle(desiredOpen);
    }
    function focusEntrance() {
        activation.forceActiveFocus(Qt.OtherFocusReason);
    }
    function handlePress(point) {
        rememberBodyFocus();
        motion.hold(progress);
        gestureArmed = true;
        pressedRevision = navigationRevision();
        dragCanceled = false;
        dragStartPoint = point;
        dragStartProgress = progress;
        dragLastProgress = progress;
        dragLastTime = Date.now();
        dragVelocity = motion.velocity;
        handle.forceActiveFocus(Qt.MouseFocusReason);
    }
    function handleMove(point) {
        if (dragCanceled || !gestureArmed || pressedRevision !== navigationRevision())
            return;
        const dx = point.x - dragStartPoint.x;
        const dy = point.y - dragStartPoint.y;
        if (!dragging && Math.sqrt(dx * dx + dy * dy) < 6)
            return;
        if (!dragging) {
            dragging = true;
            transitionState = "dragging";
        }
        const distance = dx * gestureDirection.x + dy * gestureDirection.y;
        const nextProgress = Math.max(0, Math.min(1, dragStartProgress + distance / gestureSpan));
        const now = Date.now();
        const elapsed = Math.max(.008, (now - dragLastTime) / 1000);
        const pointerVelocity = Math.max(-6, Math.min(6, (nextProgress - dragLastProgress) / elapsed));
        dragVelocity = pointerVelocity * .75 + dragVelocity * .25;
        motion.follow(nextProgress, dragVelocity);
        dragLastProgress = nextProgress;
        dragLastTime = now;
    }
    function handleRelease() {
        if (dragCanceled || !gestureArmed || pressedRevision !== navigationRevision()) {
            gestureArmed = false;
            dragCanceled = false;
            if (motion.held) {
                dragging = false;
                settle(desiredOpen);
            }
            return;
        }
        gestureArmed = false;
        if (!dragging) {
            motion.held = false;
            navigation.toggle(destination, portal);
            return;
        }
        const open = progress >= .5;
        // A held pointer has no release momentum after the hand has stopped.
        if (Date.now() - dragLastTime > 100)
            motion.velocity = 0;
        motion.held = false;
        dragging = false;
        const beforeReleaseMotion = motion.revision;
        if (open)
            navigation.open(destination, "", portal);
        else if (desiredOpen)
            navigation.close();
        // A synchronous navigation can already retarget and finish in reduced
        // motion. A release only supplies the missing settle intent.
        if (motion.revision === beforeReleaseMotion)
            settle(open);
    }
    onDesiredOpenChanged: {
        if (!componentReady)
            return;
        if (dragging || gestureArmed)
            cancelDrag();
        else
            settle(desiredOpen);
    }
    onProgressChanged: observeDirector()
    onDraggingChanged: observeDirector()
    onDirectorChanged: observeDirector()
    onClosedRectChanged: if (dragging || gestureArmed)
        cancelDrag()
    onDestinationRectChanged: if (dragging || gestureArmed)
        cancelDrag()
    Component.onCompleted: {
        componentReady = true;
        if (desiredOpen)
            settle(true);
        observeDirector();
    }
    Keys.onEscapePressed: event => {
        if (navigation && navigation.inputContext && navigation.inputContext.composing) {
            event.accepted = false;
            return;
        }
        if (dragging || gestureArmed)
            cancelDrag();
        else if (desiredOpen)
            navigation.close();
        event.accepted = true;
    }
    Connections {
        target: portal.navigation
        ignoreUnknownSignals: true
        function onTransitionCommittingChanged() {
            if (portal.navigation && !portal.navigation.transitionCommitting
                    && portal.transitionRevision === portal.navigationRevision()) {
                // Only page-hiding focus belongs to this commit. Keep the
                // original window, scope and generation: a real reconnect or
                // reparent cannot refresh an obsolete completion into validity.
                portal.settleFocusActivity = portal.navigation.focusActivityRevision !== undefined
                        ? portal.navigation.focusActivityRevision : 0;
                if (motion.geometrySettled)
                    portal.finishTransition(motion.revision);
            }
        }
        function onCancelInteraction() {
            portal.cancelDrag();
        }
        function onCurrentFeatureChanged() {
            // Also cancel a drag begun on a closed, nonselected entrance.
            // Its desiredOpen may stay false while navigation changes elsewhere.
            if (portal.dragging || portal.gestureArmed)
                portal.cancelDrag();
        }
        function onTransitionRevisionChanged() {
            if (portal.gestureArmed && portal.pressedRevision !== portal.navigationRevision())
                portal.cancelDrag();
        }
    }
    RetargetMotion {
        id: motion
        reducedMotion: portal.reducedMotion
        onVelocityChanged: portal.observeDirector()
        onGeometrySettledChanged: portal.observeDirector()
        onSettled: completedRevision => portal.finishTransition(completedRevision)
    }
    GlassPane {
        id: surface
        anchors.fill: parent
        padding: 0
        sceneSource: portal.sceneSource
        blurredSource: portal.blurredSource
        sceneRoot: portal.sceneRoot
        materialRole: portal.materialRole
        settleEnergy: portal.settleEnergy
        cornerRadius: 18 + 6 * portal.progress
        surfaceProgress: portal.progress
        interactionHover: activation.hovered || handleMouse.containsMouse ? 1 : 0
        interactionPressed: activation.down || handleMouse.pressed ? 1 : 0
        focusHighlight: portal.activeFocus
        Button {
            id: activation
            objectName: "portal-" + portal.destination
            x: 0
            y: 0
            width: parent.width - 58
            height: portal.headerHeight
            padding: 0
            hoverEnabled: true
            focusPolicy: Qt.StrongFocus
            Accessible.name: portal.desiredOpen ? "收起" + portal.text : "打开" + portal.text
            Accessible.description: portal.hint
            onClicked: {
                portal.rememberBodyFocus();
                portal.navigation.toggle(portal.destination, portal);
            }
            background: Rectangle {
                radius: 18
                color: activation.down ? "#233b525a" : activation.hovered ? "#122f4756" : "transparent"
            }
            contentItem: Item {
                Text {
                    x: 14
                    anchors.verticalCenter: parent.verticalCenter
                    textFormat: Text.PlainText
                    text: portal.glyph
                    color: portal.selected ? "#c3f2e4" : "#b6d3de"
                    font.pixelSize: 24
                }
                Column {
                    x: 44
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: 4
                    width: Math.max(0, parent.width - 48)
                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: portal.text
                        color: "#edf7fa"
                        font.pixelSize: 14 + 4 * portal.progress
                        font.weight: Font.Medium
                        elide: Text.ElideRight
                    }
                    Text {
                        width: parent.width
                        textFormat: Text.PlainText
                        text: portal.hint
                        color: "#9bb5c6"
                        font.pixelSize: 10 + portal.progress
                        elide: Text.ElideRight
                    }
                }
            }
        }
        Item {
            id: handle
            objectName: portal.destination + "-drag-handle"
            x: (surface.width - 56) * (1 - portal.progress) + (surface.width / 2 - 21) * portal.progress
            y: 10
            width: 42
            height: 28
            activeFocusOnTab: true
            Accessible.role: Accessible.Button
            Accessible.name: portal.text + "拖动把手"
            Accessible.description: "向展开方向拖动打开，反向拖动收起；Escape 取消拖动"
            Keys.onReturnPressed: portal.navigation.toggle(portal.destination, portal)
            Keys.onSpacePressed: portal.navigation.toggle(portal.destination, portal)
            Keys.onEscapePressed: event => {
                if (portal.navigation && portal.navigation.inputContext && portal.navigation.inputContext.composing) {
                    event.accepted = false;
                    return;
                }
                if (portal.dragging || portal.gestureArmed)
                    portal.cancelDrag();
                else if (portal.desiredOpen)
                    portal.navigation.close();
                event.accepted = true;
            }
            Rectangle {
                anchors.fill: parent
                radius: 8
                color: handleMouse.pressed ? "#3f5a60" : handleMouse.containsMouse ? "#2b3f45" : "#16304348"
                border.color: handle.activeFocus ? "#c2f7e8" : "#3e5960"
                border.width: handle.activeFocus ? 2 : 1
                Column {
                    anchors.centerIn: parent
                    spacing: 3
                    Repeater {
                        model: 2
                        Rectangle {
                            width: 17
                            height: 1
                            color: "#bddbe1"
                        }
                    }
                }
            }
            MouseArea {
                id: handleMouse
                anchors.fill: parent
                hoverEnabled: true
                preventStealing: true
                acceptedButtons: Qt.LeftButton
                onPressed: mouse => portal.handlePress(mapToItem(portal.parent, mouse.x, mouse.y))
                onPositionChanged: mouse => {
                    if (pressed)
                        portal.handleMove(mapToItem(portal.parent, mouse.x, mouse.y));
                }
                onReleased: portal.handleRelease()
                onCanceled: portal.cancelDrag()
            }
        }
        Button {
            id: closeButton
            objectName: portal.destination + "-close"
            x: surface.width - 56
            y: 39
            width: 42
            height: 22
            visible: portal.progress > .15
            enabled: portal.desiredOpen && !portal.dragging
            text: "×"
            focusPolicy: Qt.StrongFocus
            Accessible.name: "收起" + portal.text
            onClicked: {
                portal.rememberBodyFocus();
                portal.navigation.close();
            }
            background: Rectangle {
                radius: 7
                color: closeButton.down ? "#3a5359" : closeButton.hovered ? "#2b3f45" : "transparent"
            }
            contentItem: Text {
                text: closeButton.text
                color: "#bcd4e3"
                horizontalAlignment: Text.AlignHCenter
                verticalAlignment: Text.AlignVCenter
                font.pixelSize: 19
            }
        }
        Rectangle {
            x: 20
            y: portal.headerHeight
            width: Math.max(0, parent.width - 40)
            height: 1
            color: "#3cb8d4d4"
            opacity: portal.progress
        }
        Item {
            id: contentHost
            x: 22
            y: portal.headerHeight + 12
            width: Math.max(0, surface.width - 44)
            height: Math.max(0, surface.height - y - 16)
            clip: true
            visible: portal.portalBodyOpacity > .001
            enabled: portal.inputReady
            opacity: portal.portalBodyOpacity
        }
    }
}
