import QtQuick

Item {
    id: director
    objectName: "sceneDirector"
    property var navigation
    property real viewportWidth: 1380
    property real viewportHeight: 900
    property bool reducedMotion: false
    property real composerRequestedHeight: 68
    property real companionRequestedHeight: 250
    readonly property bool compact: viewportWidth < 1180
    readonly property string activeFeature: navigation ? navigation.currentFeature : "chat"
    readonly property bool taskRequested: !!navigation && navigation.surfaceOpen
    readonly property string chatState: navigation && navigation.surfaceOpen ? navigation.chatReturnSubentry : navigation ? navigation.currentSubentry : "companion"
    readonly property string mode: taskRequested || gestureActive || taskBlend > .002 ? "task" : chatState === "reading" ? "reading" : "companion"
    property real taskBlend: 0
    readonly property real readBlend: clamp(readMotion.value, 0, 1)
    readonly property real readVelocity: readMotion.velocity
    readonly property bool chatLayoutReading: readBlend >= .5
    readonly property bool portalsClosedSettled: {
        for (const feature of Object.keys(portalMotions)) {
            const portal = portalMotions[feature];
            if (portal.progress !== 0 || !portal.geometrySettled)
                return false;
        }
        return true;
    }
    readonly property bool chatGeometryReady: readMotion.geometrySettled && !readMotion.held && readMotion.target === (chatState === "reading" ? 1 : 0) && portalsClosedSettled && taskBlend < .001 && !taskRequested && !gestureActive
    readonly property bool chatInputReady: chatGeometryReady && (!navigation || !navigation.paletteOpen)
    readonly property real readBodyOpacity: 1 - phaseWeight(.20, .42, readBlend) + phaseWeight(.58, .82, readBlend)
    readonly property real chatBodyOpacity: readBodyOpacity * (1 - phaseWeight(0, .30, taskBlend))
    readonly property real companionBarOpacity: phaseWeight(.40, .90, taskBlend)
    readonly property real taskBodyOpacity: phaseWeight(.64, .93, taskBlend)
    property bool gestureActive: false
    property string gestureOwner: ""
    property int gestureRevision: 0
    property real archiveOpen: 0
    property real terminalOpen: 0
    property var portalMotions: ({})
    property bool taskLatched: false
    property real taskHandoffFloor: 0
    property string taskHandoffOwner: ""
    property int taskHandoffRevision: -1
    property string previousFeature: "chat"
    property string transitionSource: "companion"
    property string transitionTarget: "companion"
    property var transitionSourceLayout: ({})
    property int readRequestRevision: 0
    readonly property string requestedSceneState: activeFeature === "chat" ? chatState : activeFeature
    readonly property int transitionRevision: navigation && navigation.transitionRevision !== undefined ? navigation.transitionRevision : 0
    readonly property real horizonY: viewportHeight * .72
    readonly property vector2d lightDirection: Qt.vector2d(-.56, -.83)
    readonly property real readerWidth: compact ? viewportWidth - readerX - 32 : Math.min(790, viewportWidth * .46)
    readonly property real compactActorWidth: clamp(viewportWidth * .20, 148, 190)
    readonly property real readerX: compact ? 20 + compactActorWidth + 18 : viewportWidth - 32 - Math.min(790, viewportWidth * .46)
    readonly property real composerHeight: clamp(composerRequestedHeight, 68, 144)
    readonly property rect composerRect: Qt.rect(readerX, viewportHeight - 66 - composerHeight, readerWidth, composerHeight)
    readonly property rect readingRect: Qt.rect(readerX, 86, readerWidth, Math.max(100, composerRect.y - 104))
    // Wide layouts stack the companion preview on the composer as one
    // conversation column; compact layouts keep it above the terminal stand.
    readonly property rect recentRect: {
        const bottom = compact ? Math.min(readingRect.y + readingRect.height, terminalAnchor.y - 18) : readingRect.y + readingRect.height;
        const height = Math.min(bottom - readingRect.y, Math.max(154, companionRequestedHeight));
        const width = Math.min(520, readingRect.width * .94);
        const y = compact ? Math.max(readingRect.y, Math.min(viewportHeight * .29, bottom - height)) : bottom - height;
        return Qt.rect(readingRect.x + readingRect.width - width, y, width, height);
    }
    readonly property rect historyRect: mixRect(recentRect, readingRect, readBlend)
    // The shell stays continuous; the body reflows in the invisible handoff.
    readonly property real historyBodyWidth: chatLayoutReading ? readingRect.width : recentRect.width
    // AvatarTransform::configure stands the model's base at this share of the
    // actor viewport's height.
    readonly property real actorFootRatio: .965
    readonly property rect avatarRect: {
        const width = compact ? compactActorWidth : Math.min(386, viewportWidth * .30);
        const height = Math.max(260, viewportHeight - 294);
        // The astrolabe keeps its place on the floor; the viewport drops until
        // the model's base stands on its centre.
        const stageY = 79 + height;
        return Qt.rect(compact ? 20 : readerX - 24 - width, stageY - height * actorFootRatio, width, height);
    }
    // The astrolabe inlay in room.frag is an ellipse around this centre with a
    // vertical radius of 0.08 × the actor's width; the name plate sits clear
    // of its front ring. Short windows lift the actor above the floor line, so
    // the plate then drops below the lit skirting instead of straddling it.
    readonly property point stageCenter: Qt.point(avatarRect.x + avatarRect.width / 2, avatarRect.y + avatarRect.height * actorFootRatio)
    readonly property real stageFrontY: stageCenter.y + avatarRect.width * .08
    readonly property rect nameplateRect: {
        const y = stageFrontY + 10;
        const straddlesSkirting = y < horizonY + 4 && y + 18 > horizonY - 16;
        return Qt.rect(avatarRect.x, straddlesSkirting ? horizonY + 6 : y, avatarRect.width, 18);
    }
    // The entire actor viewport is reserved, including lower-body motion.
    readonly property rect avatarReserveRect: avatarRect
    readonly property rect avatarProtectedRect: Qt.rect(avatarRect.x + avatarRect.width * .18, avatarRect.y + avatarRect.height * .04, avatarRect.width * .64, avatarRect.height * .53)
    readonly property real fullTaskProgress: {
        let progress = 0;
        for (const feature of Object.keys(portalMotions))
            if (feature !== "character")
                progress = Math.max(progress, portalMotions[feature].progress);
        return progress;
    }
    readonly property real avatarVisibility: compact ? 1 - phaseWeight(.04, .25, fullTaskProgress) : 1
    // How much the closed portal faces rest in their room slots. Compact
    // layouts never dock them, and reading or working fades them out; the room
    // then draws its own closed drawer and standby screen.
    readonly property real portalDocked: compact ? 0 : 1 - Math.max(readBlend, taskBlend)
    readonly property rect archiveAnchor: Qt.rect(compact ? readerX : 28, viewportHeight * .66, 160, 66)
    // Wide layouts hang the terminal on the upper right wall; compact layouts
    // keep its stand beside the composer.
    readonly property rect terminalAnchor: compact ? Qt.rect(viewportWidth - 184, Math.min(viewportHeight - 224, composerRect.y - 84), 156, 66) : Qt.rect(viewportWidth - 32 - 184, 104, 184, 66)
    readonly property rect characterAnchor: Qt.rect(readerX + Math.max(0, (readerWidth - 180) / 2), 82, 180, 58)
    readonly property rect taskRect: taskRectFor(activeFeature)
    readonly property rect companionBarRect: compact ? Qt.rect(22, viewportHeight - 104, viewportWidth - 44, 48) : Qt.rect(avatarRect.x, viewportHeight - 156, avatarRect.width, 82)
    readonly property var layoutSnapshot: ({
        viewport: Qt.size(viewportWidth, viewportHeight),
        compact: compact,
        avatarReserve: avatarReserveRect,
        companion: recentRect,
        reading: readingRect,
        composer: composerRect,
        task: taskRect
    })
    readonly property var transitionSnapshot: ({
        revision: transitionRevision,
        source: transitionSource,
        target: transitionTarget,
        sourceLayout: transitionSourceLayout,
        readProgress: readBlend,
        readVelocity: readVelocity,
        taskProgress: taskBlend,
        taskOwner: gestureOwner || activeFeature,
        geometryReady: chatGeometryReady,
        layout: layoutSnapshot
    })

    function clamp(value, minimum, maximum) {
        return Math.max(minimum, Math.min(maximum, value));
    }
    function phaseWeight(lo, hi, value) {
        const t = clamp((value - lo) / (hi - lo), 0, 1);
        return t * t * (3 - 2 * t);
    }
    function mixRect(a, b, t) {
        return Qt.rect(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, a.width + (b.width - a.width) * t, a.height + (b.height - a.height) * t);
    }
    function taskRectFor(feature) {
        if (compact && feature !== "character")
            return Qt.rect(22, 76, viewportWidth - 44, viewportHeight - 194);
        return Qt.rect(readerX, 78, readerWidth, viewportHeight - 182);
    }
    function portalRectFor(feature, progress, closed) {
        const target = taskRectFor(feature);
        const unfolding = phaseWeight(.62, 1, progress);
        const horizontal = phaseWeight(compact && feature !== "character" ? .30 : feature === "memory" ? .26 : 0, .62, progress);
        const transitY = feature === "memory" && !compact ? Math.max(closed.y, avatarReserveRect.y + avatarReserveRect.height + 18) : closed.y;
        const y = feature === "memory" ? closed.y + (transitY - closed.y) * phaseWeight(0, .24, progress) + (target.y - transitY) * unfolding : closed.y + (target.y - closed.y) * unfolding;
        return Qt.rect(closed.x + (target.x - closed.x) * horizontal, y, closed.width + (target.width - closed.width) * unfolding, closed.height + (target.height - closed.height) * unfolding);
    }
    function scheduleReadTarget() {
        const request = ++readRequestRevision;
        Qt.callLater(function () {
            if (request !== readRequestRevision)
                return;
            const target = chatState === "reading" ? 1 : 0;
            if (readMotion.target !== target || readMotion.held)
                readMotion.retarget(target);
        });
    }
    function updateTaskPosture() {
        const selected = portalMotions[activeFeature];
        let progress = 0;
        for (const feature of Object.keys(portalMotions))
            progress = Math.max(progress, portalMotions[feature].progress);
        if (taskRequested && selected && selected.dragging) {
            taskLatched = false;
            taskHandoffFloor = 0;
            taskHandoffOwner = "";
            taskHandoffRevision = -1;
            progress = selected.progress;
        } else if (taskRequested && taskLatched)
            progress = 1;
        else if (taskRequested && taskHandoffOwner === activeFeature) {
            // The new drawer inherits the current posture. Its incoming progress
            // may raise that posture; a late outgoing update cannot lower it.
            taskHandoffFloor = Math.max(taskHandoffFloor, progress);
            progress = taskHandoffFloor;
        }
        taskBlend = clamp(progress, 0, 1);
        if (taskRequested && taskBlend >= .999 && (!selected || !selected.dragging)) {
            taskLatched = true;
            if (selected && selected.geometrySettled && selected.progress >= .999) {
                taskHandoffFloor = 0;
                taskHandoffOwner = "";
                taskHandoffRevision = -1;
            }
        }
        if (!taskRequested && taskBlend < .001)
            taskLatched = false;
    }
    function observePortalMotion(feature, progress, dragging, velocity, geometrySettled, revision) {
        const motions = Object.assign({}, portalMotions);
        motions[feature] = {
            progress: clamp(progress, 0, 1),
            dragging: dragging,
            velocity: velocity || 0,
            geometrySettled: geometrySettled,
            revision: revision === undefined ? transitionRevision : revision
        };
        portalMotions = motions;
        if (feature === "memory")
            archiveOpen = progress;
        if (feature === "settings")
            terminalOpen = progress;
        if (dragging) {
            gestureRevision++;
            gestureOwner = feature;
            gestureActive = true;
        } else if (gestureOwner === feature) {
            gestureActive = false;
            gestureOwner = "";
        }
        updateTaskPosture();
    }
    function observePortal(feature, progress, dragging) {
        observePortalMotion(feature, progress, dragging, 0, progress <= 0 || progress >= 1, transitionRevision);
    }
    onChatStateChanged: scheduleReadTarget()
    onRequestedSceneStateChanged: {
        transitionSource = transitionTarget;
        transitionTarget = requestedSceneState;
        transitionSourceLayout = { history: historyRect, composer: composerRect, avatarReserve: avatarReserveRect, readProgress: readBlend, taskProgress: taskBlend };
    }
    onTaskRequestedChanged: {
        if (!taskRequested) {
            taskLatched = false;
            taskHandoffFloor = 0;
            taskHandoffOwner = "";
            taskHandoffRevision = -1;
        }
        updateTaskPosture();
    }
    onActiveFeatureChanged: {
        if (activeFeature !== "chat" && previousFeature !== "chat") {
            taskHandoffFloor = taskBlend;
            taskHandoffOwner = activeFeature;
            taskHandoffRevision = transitionRevision;
            if (taskBlend >= .999)
                taskLatched = true;
        }
        previousFeature = activeFeature;
        updateTaskPosture();
    }
    Component.onCompleted: {
        previousFeature = activeFeature;
        scheduleReadTarget();
    }
    RetargetMotion {
        id: readMotion
        objectName: "sceneReadMotion"
        reducedMotion: director.reducedMotion
    }
}
