import QtQuick
import QtQuick.Controls
import QtQuick.Window
import "ui"

// Actual product navigation/portal/director/input context, with the real
// ArchiveEditor and RuntimeBridge supplied by the existing native target.
// No application, backend process, model request or avatar is launched.
ApplicationWindow {
    id: host
    width: 1380
    height: 900
    visible: false
    property alias navigation: sceneNavigation
    property alias portal: memorySurface
    property alias drawer: archiveDrawer
    property bool reducedMotion: true
    function belongsTo(item, ancestor) {
        for (let current = item; current; current = current.parent)
            if (current === ancestor) return true;
        return false;
    }
    onActiveFocusItemChanged: {
        if (belongsTo(activeFocusItem, archiveDrawer))
            sceneNavigation.rememberFeatureFocus("memory", activeFocusItem);
    }
    function openArchive() { sceneNavigation.open("memory", "worldbook", fallback); }
    function closeArchive() { sceneNavigation.close(); }
    function openPalette() { sceneNavigation.showPalette(host.activeFocusItem); }
    function chooseCurrentPaletteDestination() {
        commandPalette.activateEntry({feature: "memory", subentry: "worldbook", available: true});
    }
    function openMemoryPage() { sceneNavigation.open("memory", "memories"); }
    function cancelPalette() { sceneNavigation.dismissPalette(); }
    InputContext { id: inputPolicy; window: host }
    SceneNavigation {
        id: sceneNavigation
        activeFocusItem: host.activeFocusItem
        inputContext: inputPolicy
        fallbackFocusItem: fallback
        focusWindow: host
        focusScopeKey: session.scopeKey || ""
        focusGeneration: session.connectionGeneration
    }
    SceneDirector {
        id: sceneDirector
        navigation: sceneNavigation
        viewportWidth: host.width
        viewportHeight: host.height
        reducedMotion: host.reducedMotion
    }
    TextField { id: fallback; objectName: "focusHostFallback"; visible: !sceneNavigation.surfaceOpen }
    // Passive focus-scope handoff for a lifecycle guard positive. It has no
    // input handling, tab eligibility or focus assignment of its own.
    FocusScope { objectName: "focusHostLifecycleScope"; width: 1; height: 1 }
    SceneCommandPalette {
        id: commandPalette
        anchors.fill: parent
        navigation: sceneNavigation
        inputContext: inputPolicy
        sceneRoot: host.contentItem
    }
    ArchiveEntryPolicy {
        navigation: sceneNavigation
        portal: memorySurface
        drawer: archiveDrawer
    }
    ScenePortal {
        id: memorySurface
        objectName: "focusHostPortal"
        property string page: "worldbook"
        navigation: sceneNavigation
        director: sceneDirector
        destination: "memory"
        glyph: "▥"
        text: "资料匣"
        closedRect: sceneDirector.archiveAnchor
        expandedRect: sceneDirector.taskRect
        reducedMotion: host.reducedMotion
        readonly property Item firstFocusItem: page === "worldbook" ? archiveDrawer.firstFocusItem : fallback
        body: ArchiveDrawer {
            id: archiveDrawer
            objectName: "fixturePriorityDrawer"
            anchors.fill: parent
            visible: memorySurface.page === "worldbook"
            navigation: sceneNavigation
            onRequestClose: sceneNavigation.close()
        }
    }
}
