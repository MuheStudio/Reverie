import QtQuick
import QtQuick.Window

Item {
    id: room
    objectName: "moonroomEnvironment"
    // The director owns the same closed rectangles used by ScenePortal. The
    // physical furniture grows from those slots, never from a second layout.
    property var director
    property bool reducedMotion: false
    property vector2d lightDirection: director && director.lightDirection !== undefined ? director.lightDirection : Qt.vector2d(-0.56, -0.83)
    // Optional event-driven drift of the window view's clouds.
    property real cloudPhase: 0
    readonly property real horizonY: director ? director.horizonY : height * 0.72
    readonly property rect archiveAnchor: director ? director.archiveAnchor : Qt.rect(0, 0, 0, 0)
    readonly property rect terminalAnchor: director ? director.terminalAnchor : Qt.rect(0, 0, 0, 0)
    readonly property rect avatarRect: director ? director.avatarRect : Qt.rect(width * 0.29, height * 0.16, width * 0.30, height * 0.63)
    readonly property point stageCenter: director && director.stageCenter !== undefined ? director.stageCenter : Qt.point(avatarRect.x + avatarRect.width / 2, avatarRect.y + avatarRect.height - 3)
    readonly property real taskBlend: director ? director.taskBlend : 0
    readonly property real readBlend: director ? director.readBlend : 0
    readonly property real avatarVisibility: director ? director.avatarVisibility : 0
    readonly property real archiveOpen: director && director.archiveOpen !== undefined ? director.archiveOpen : 0
    readonly property real terminalOpen: director && director.terminalOpen !== undefined ? director.terminalOpen : 0
    readonly property real portalDocked: director && director.portalDocked !== undefined ? director.portalDocked : 1
    // The arch opening shared by the window view and the cached room.
    readonly property real apertureBottom: Math.min(Math.max(horizonY, 1), height - 1)
    readonly property rect apertureRect: Qt.rect(width * 0.17, height * 0.052, width * 0.66, Math.max(1, apertureBottom - height * 0.052))
    readonly property bool environmentMaterialReady: environment.status !== ShaderEffect.Error && windowView.status !== ShaderEffect.Error
    clip: true

    Rectangle {
        anchors.fill: parent
        gradient: Gradient {
            GradientStop {
                position: 0
                color: "#162831"
            }
            GradientStop {
                position: 0.72
                color: "#344348"
            }
            GradientStop {
                position: 1
                color: "#303839"
            }
        }
    }
    // The window view is the only part of the room that moves with time. It
    // covers just the opening; the room composites over it.
    ShaderEffect {
        id: windowView
        objectName: "moonroomWindowShader"
        x: room.apertureRect.x
        y: room.apertureRect.y
        width: room.apertureRect.width
        height: room.apertureRect.height
        property vector2d viewportSize: Qt.vector2d(Math.max(1, room.width), Math.max(1, room.height))
        property vector4d apertureRect: Qt.vector4d(room.apertureRect.x, room.apertureRect.y, room.apertureRect.width, room.apertureRect.height)
        property real horizonY: room.horizonY
        property real taskBlend: room.taskBlend
        property real readBlend: room.readBlend
        property real cloudPhase: room.reducedMotion ? 0 : room.cloudPhase
        fragmentShader: "qrc:/shaders/room-sky.frag.qsb"
    }
    // Everything else holds still, so it renders once into a full-DPR layer and
    // again only when geometry, a transition or a portal changes.
    ShaderEffect {
        id: environment
        objectName: "moonroomEnvironmentShader"
        anchors.fill: parent
        layer.enabled: true
        layer.textureSize: Qt.size(width * Screen.devicePixelRatio, height * Screen.devicePixelRatio)
        property vector2d viewportSize: Qt.vector2d(Math.max(1, room.width), Math.max(1, room.height))
        property vector4d apertureRect: Qt.vector4d(room.apertureRect.x, room.apertureRect.y, room.apertureRect.width, room.apertureRect.height)
        property vector4d archiveAnchor: Qt.vector4d(room.archiveAnchor.x, room.archiveAnchor.y, room.archiveAnchor.width, room.archiveAnchor.height)
        property vector4d terminalAnchor: Qt.vector4d(room.terminalAnchor.x, room.terminalAnchor.y, room.terminalAnchor.width, room.terminalAnchor.height)
        property vector4d avatarRect: Qt.vector4d(room.avatarRect.x, room.avatarRect.y, room.avatarRect.width, room.avatarRect.height)
        property vector2d stageCenter: Qt.vector2d(room.stageCenter.x, room.stageCenter.y)
        property real horizonY: room.horizonY
        property real taskBlend: room.taskBlend
        property real readBlend: room.readBlend
        property real avatarVisibility: room.avatarVisibility
        property real archiveOpen: room.archiveOpen
        property real terminalOpen: room.terminalOpen
        property real portalDocked: room.portalDocked
        property vector2d lightDirection: room.lightDirection
        fragmentShader: "qrc:/shaders/room.frag.qsb"
    }
}
