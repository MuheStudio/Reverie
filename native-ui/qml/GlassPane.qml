pragma ComponentBehavior: Bound

import QtQuick
import QtQuick.Controls
import QtQuick.Window

Pane {
    id: pane

    // The owner supplies one of the shared scene captures. A pane never captures
    // itself or any upper surface; content stays outside the material shader.
    property var sceneSource
    // A shared full-resolution blur belongs to the layer compositor, never to
    // this pane. Omitting it keeps the same source and mapping without capture.
    property var blurredSource: sceneSource
    property Item sceneRoot
    property rect sceneSampleRect: Qt.rect(0, 0, sceneRoot ? sceneRoot.width : 1, sceneRoot ? sceneRoot.height : 1)
    property real cornerRadius: 24
    property real surfaceProgress: 1
    property real interactionHover: 0
    property real interactionPressed: 0
    property string materialRole: "clear"
    property vector2d lightDirection: Qt.vector2d(-0.56, -0.83)
    property real settleEnergy: 0
    property bool focusHighlight: false
    // Receiver shadows belong to outer scene surfaces. Embedded controls use
    // the enclosing surface's contact shadow instead of stacking dark halos.
    property bool castsShadow: true
    // Embedded controls blend their resting outline toward the fill so a
    // panel's inner borders stay quieter than its own edge.
    property real outlineStrength: 1
    property bool reducedTransparency: typeof session !== "undefined" && session.reducedTransparency

    // Exposed for geometry assertions. The basis is in normalized source UVs,
    // not pane-local pixels, and includes all ancestor transforms.
    readonly property vector2d sampleOrigin: mapping.origin
    readonly property vector2d sampleAxisX: mapping.axisX
    readonly property vector2d sampleAxisY: mapping.axisY
    readonly property bool sampleMappingValid: mapping.valid
    readonly property bool materialUsesTexture: !reducedTransparency && !!sceneSource && !!sceneRoot && sampleMappingValid && glassShader.status !== ShaderEffect.Error
    readonly property bool samplingActive: materialUsesTexture && visible && opacity > 0 && width > 0 && height > 0 && !!Window.window && Window.window.visible && Window.window.visibility !== Window.Minimized
    readonly property var coordinateItems: {
        // Opaque embedded controls have no sampling coordinates to observe.
        // Keep these dependencies live so attaching either source later rebuilds
        // the same complete ancestor chain used by textured surfaces.
        if (!sceneSource || !sceneRoot)
            return [];
        const items = [];
        // Observe both coordinate chains. A pane can remain locally stationary
        // while its parent moves, or its sampled root can itself be transformed.
        for (let item = background; item; item = item.parent) {
            if (items.indexOf(item) < 0)
                items.push(item);
        }
        for (let item = sceneRoot; item; item = item.parent) {
            if (items.indexOf(item) < 0)
                items.push(item);
        }
        return items;
    }

    padding: 22

    MaterialProfiles {
        id: profile
        role: pane.materialRole
        progress: pane.surfaceProgress
    }

    function updateSampleMapping() {
        if (!mapping)
            return;
        if (!sceneRoot || !background || sceneSampleRect.width <= 0 || sceneSampleRect.height <= 0 || background.width <= 0 || background.height <= 0) {
            mapping.valid = false;
            return;
        }
        const captureRoot = sceneSource ? sceneSource.sourceItem : null;
        if (captureRoot) {
            for (let ancestor = pane; ancestor; ancestor = ancestor.parent) {
                if (ancestor === captureRoot) {
                    mapping.valid = false;
                    return;
                }
            }
        }
        const topLeft = background.mapToItem(sceneRoot, 0, 0);
        const topRight = background.mapToItem(sceneRoot, background.width, 0);
        const bottomLeft = background.mapToItem(sceneRoot, 0, background.height);
        const origin = Qt.vector2d((topLeft.x - sceneSampleRect.x) / sceneSampleRect.width, (topLeft.y - sceneSampleRect.y) / sceneSampleRect.height);
        const axisX = Qt.vector2d((topRight.x - topLeft.x) / sceneSampleRect.width, (topRight.y - topLeft.y) / sceneSampleRect.height);
        const axisY = Qt.vector2d((bottomLeft.x - topLeft.x) / sceneSampleRect.width, (bottomLeft.y - topLeft.y) / sceneSampleRect.height);
        if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y) || !Number.isFinite(axisX.x) || !Number.isFinite(axisX.y) || !Number.isFinite(axisY.x) || !Number.isFinite(axisY.y)) {
            mapping.valid = false;
            return;
        }
        // Unchanged mappings do not dirty the material's uniform buffer.
        if (mapping.origin.x !== origin.x || mapping.origin.y !== origin.y)
            mapping.origin = origin;
        if (mapping.axisX.x !== axisX.x || mapping.axisX.y !== axisX.y)
            mapping.axisX = axisX;
        if (mapping.axisY.x !== axisY.x || mapping.axisY.y !== axisY.y)
            mapping.axisY = axisY;
        mapping.valid = true;
    }

    onXChanged: updateSampleMapping()
    onYChanged: updateSampleMapping()
    onWidthChanged: updateSampleMapping()
    onHeightChanged: updateSampleMapping()
    onScaleChanged: updateSampleMapping()
    onRotationChanged: updateSampleMapping()
    onSceneSourceChanged: updateSampleMapping()
    onSceneRootChanged: updateSampleMapping()
    onSceneSampleRectChanged: updateSampleMapping()
    onParentChanged: updateSampleMapping()
    onReducedTransparencyChanged: if (!reducedTransparency)
        updateSampleMapping()
    onVisibleChanged: if (visible)
        updateSampleMapping()
    Component.onCompleted: updateSampleMapping()

    QtObject {
        id: mapping
        property vector2d origin: Qt.vector2d(0, 0)
        property vector2d axisX: Qt.vector2d(0, 0)
        property vector2d axisY: Qt.vector2d(0, 0)
        property bool valid: false
    }

    // mapToItem does not establish binding dependencies on ancestor transforms.
    // Geometry notifications keep the basis current even between render turns,
    // including a portal's last drag/release assignment and reparenting.
    Instantiator {
        model: pane.coordinateItems
        delegate: Connections {
            required property var modelData
            target: modelData
            enabled: !pane.reducedTransparency
            function onXChanged() {
                pane.updateSampleMapping();
            }
            function onYChanged() {
                pane.updateSampleMapping();
            }
            function onWidthChanged() {
                pane.updateSampleMapping();
            }
            function onHeightChanged() {
                pane.updateSampleMapping();
            }
            function onScaleChanged() {
                pane.updateSampleMapping();
            }
            function onRotationChanged() {
                pane.updateSampleMapping();
            }
            function onTransformOriginChanged() {
                pane.updateSampleMapping();
            }
            function onParentChanged() {
                pane.updateSampleMapping();
            }
        }
    }

    // afterAnimating is a GUI-thread boundary after animation advancement and
    // before scene-graph synchronization. It also covers custom Transform
    // objects, whose changes have no QQuickItem transformChanged signal.
    // Unlike an independent FrameAnimation, this does not drive idle frames.
    Connections {
        target: pane.Window.window
        function onAfterAnimating() {
            if (pane.samplingActive)
                pane.updateSampleMapping();
        }
    }
    Connections {
        target: pane.sceneSource || null
        ignoreUnknownSignals: true
        function onSourceItemChanged() {
            pane.updateSampleMapping();
        }
    }

    background: Item {
        id: material
        objectName: "glassMaterial"
        onWidthChanged: pane.updateSampleMapping()
        onHeightChanged: pane.updateSampleMapping()

        ShaderEffect {
            objectName: "glassReceiverShadow"
            anchors.fill: parent
            anchors.margins: -profile.shadowExtent
            visible: pane.castsShadow
            property vector2d panelSize: Qt.vector2d(material.width, material.height)
            property vector2d lightDirection: pane.lightDirection
            property real cornerRadius: pane.cornerRadius
            property real shadowExtent: profile.shadowExtent
            property real shadowOpacity: profile.shadowOpacity
            fragmentShader: "qrc:/shaders/surface-shadow.frag.qsb"
        }

        Rectangle {
            objectName: "glassOpaqueFallback"
            anchors.fill: parent
            visible: !pane.materialUsesTexture
            radius: Math.min(pane.cornerRadius, Math.min(width, height) / 2)
            gradient: Gradient {
                GradientStop {
                    position: 0
                    color: profile.opaqueTop
                }
                GradientStop {
                    position: 1
                    color: profile.opaqueBottom
                }
            }
            border.width: pane.focusHighlight ? 1.5 : 1
            border.color: pane.focusHighlight ? "#d0e7df" : pane.interactionHover > 0 ? "#a2b8b3" : profile.colorMix(profile.opaqueBottom, profile.outline, pane.outlineStrength)
            Rectangle {
                anchors.fill: parent
                radius: parent.radius
                color: pane.interactionPressed > 0 ? "#1804090c" : pane.interactionHover > 0 ? "#07f4f8f3" : "transparent"
            }
        }

        ShaderEffect {
            id: glassShader
            objectName: "glassShader"
            anchors.fill: parent
            visible: pane.materialUsesTexture
            property var source: pane.sceneSource
            property var blurredSource: pane.blurredSource || pane.sceneSource
            property vector2d panelSize: Qt.vector2d(width, height)
            property vector2d sceneSize: Qt.vector2d(Math.max(1, pane.sceneSampleRect.width), Math.max(1, pane.sceneSampleRect.height))
            property vector2d sampleOrigin: pane.sampleOrigin
            property vector2d sampleAxisX: pane.sampleAxisX
            property vector2d sampleAxisY: pane.sampleAxisY
            property real cornerRadius: pane.cornerRadius
            property real surfaceProgress: pane.surfaceProgress
            property real interactionHover: pane.interactionHover
            property real interactionPressed: pane.interactionPressed
            property real focusHighlight: pane.focusHighlight ? 1 : 0
            property vector4d profileOptics: profile.optics
            property vector4d profileEdge: profile.edge
            property color materialTint: profile.tint
            property vector2d lightDirection: pane.lightDirection
            property real settleEnergy: pane.settleEnergy
            fragmentShader: "qrc:/shaders/liquid.frag.qsb"
        }
    }
}
