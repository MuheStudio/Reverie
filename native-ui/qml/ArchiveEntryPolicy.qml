import QtQuick

// Shared by Main and the real native host. Capturing before navigation is
// essential: reduced motion can open a portal in the same signal delivery.
QtObject {
    id: policy
    property var navigation
    property var portal
    property var drawer
    property var pending: null
    property int committedRevision: -1
    property int completedRevision: -1
    property int expectedActivity: -1
    property bool restoring: false
    property bool wasOpen: false
    property int openedRevision: -1
    property int openedSettleIntent: -1

    function prepare(context) {
        if (!navigation || !portal || !drawer)
            return;
        pending = context;
        committedRevision = -1;
        restoring = false;
        wasOpen = context.previousFeature === "memory" && portal.contentReady;
        openedRevision = -1;
        openedSettleIntent = -1;
        if (!context.changed && context.fromPalette)
            return;
        const resetTop = context.feature === "memory" && context.subentry !== "memories"
                && !wasOpen;
        drawer.beginNavigationFocus(context.revision, resetTop);
        if (context.feature === "memory")
            portal.page = context.subentry === "memories" ? "memories" : "worldbook";
    }
    function invalidatePending() {
        if (pending && drawer)
            drawer.finishNavigationFocus(pending.revision);
        pending = null;
        restoring = false;
        openedRevision = -1;
        openedSettleIntent = -1;
    }
    function committed() {
        if (!pending || !navigation || navigation.transitionCommitting)
            return;
        committedRevision = navigation.transitionRevision;
        expectedActivity = navigation.focusActivityRevision;
        if (pending.feature !== "memory") {
            drawer.finishNavigationFocus(pending.revision);
            return;
        }
        releaseWhenReady();
        restoreWhenReady();
    }
    function inputReady() {
        return !!pending && !!navigation && !!portal && !!drawer
            && !navigation.transitionCommitting && portal.inputReady && drawer.enabled
            && pending.revision === committedRevision;
    }
    function contextRejectCode(context) {
        if (context.revision !== navigation.transitionRevision) return 1;
        if (context.window !== navigation.focusWindow) return 2;
        if (context.scope !== navigation.focusScopeKey) return 3;
        if (context.generation !== navigation.focusGeneration) return 4;
        if (navigation.currentFeature !== "memory") return 5;
        if (navigation.currentSubentry !== context.subentry) return 6;
        if (expectedActivity !== navigation.focusActivityRevision) return 7;
        return 0;
    }
    function rejectContext(context, reason) {
        drawer.traceFocus("navigation-policy-rejected", {rejectCode: reason,
            revision: context.revision, currentRevision: navigation.transitionRevision,
            expectedActivity: expectedActivity, activity: navigation.focusActivityRevision});
        drawer.finishNavigationFocus(context.revision);
        completedRevision = context.revision;
    }
    function releaseWhenReady() {
        if (!inputReady() || restoring)
            return;
        // Ready notifications never select focus. In particular they cannot
        // change activity before ScenePortal validates its opened completion.
        drawer.finishNavigationFocus(pending.revision);
        if (completedRevision === pending.revision)
            return;
        const rejection = contextRejectCode(pending);
        if (rejection !== 0)
            rejectContext(pending, rejection);
    }
    function portalOpened() {
        if (!pending || !portal || portal.transitionRevision !== pending.revision)
            return;
        openedRevision = pending.revision;
        openedSettleIntent = portal.completedSettleIntent;
        restoreWhenReady();
    }
    function restoreWhenReady() {
        const context = pending;
        if (!inputReady() || restoring || completedRevision === context.revision)
            return;
        const rejection = contextRejectCode(context);
        if (rejection !== 0) {
            rejectContext(context, rejection);
            return;
        }
        // Same-destination palette dismissal has its own preferred return item.
        // It must not race another queued restore from this policy.
        if (!context.changed && context.fromPalette) {
            drawer.finishNavigationFocus(context.revision);
            completedRevision = context.revision;
            return;
        }
        // An already-open drawer has no new portal completion. New entrances
        // instead require the portal's validated opened revision/settle token.
        if (!wasOpen && (openedRevision !== context.revision
                || openedSettleIntent !== portal.completedSettleIntent))
            return;
        restoring = true;
        const fallback = portal.firstFocusItem !== undefined ? portal.firstFocusItem : drawer.firstFocusItem;
        drawer.beginNavigationFocus(context.revision, false);
        let restored = false;
        try {
            // Readiness and restoration are one synchronous boundary. Keep the
            // archive guard raised while OtherFocusReason restores the target,
            // so this lifecycle action cannot undo a closed-to-open top reset.
            restored = navigation.restoreFeatureFocusNow("memory", fallback, "", null);
        } finally {
            drawer.finishNavigationFocus(context.revision);
            if (policy.pending === context && restored)
                policy.completedRevision = context.revision;
            restoring = false;
        }
    }
    property Connections navigationConnections: Connections {
        target: policy.navigation
        function onAboutToNavigate(context) { policy.prepare(context); }
        function onTransitionRevisionChanged() {
            if (policy.pending && policy.pending.revision !== policy.navigation.transitionRevision)
                policy.invalidatePending();
        }
        function onFocusWindowChanged() { policy.invalidatePending(); }
        function onFocusScopeKeyChanged() { policy.invalidatePending(); }
        function onFocusGenerationChanged() { policy.invalidatePending(); }
        function onTransitionCommittingChanged() {
            if (!policy.navigation.transitionCommitting)
                policy.committed();
        }
    }
    property Connections portalConnections: Connections {
        target: policy.portal
        function onInputReadyChanged() { policy.releaseWhenReady(); }
        function onOpened() { policy.portalOpened(); }
    }
    property Connections drawerConnections: Connections {
        target: policy.drawer
        function onEnabledChanged() { policy.releaseWhenReady(); }
    }
}
