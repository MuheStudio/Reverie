import QtQuick
import "ui"

Item {
    id: stage
    width: 640
    height: 480
    Item {
        id: scene
        objectName: "test-scene-root"
        x: 5
        y: 7
        width: 640
        height: 480
    }
    ShaderEffectSource {
        id: capture
        objectName: "test-scene-source"
        sourceItem: scene
        live: false
        hideSource: false
    }
    ShaderEffectSource {
        objectName: "test-scene-source-second"
        sourceItem: scene
        live: false
        hideSource: false
    }
    Item {
        id: first
        objectName: "test-ancestor-first"
        x: 20
        y: 30
        width: 300
        height: 260
        GlassPane {
            objectName: "test-pane"
            x: 11
            y: 13
            width: 180
            height: 140
            sceneSource: null
            sceneRoot: null
        }
    }
    Item {
        objectName: "test-ancestor-second"
        x: 130
        y: 90
        width: 320
        height: 280
    }
}
