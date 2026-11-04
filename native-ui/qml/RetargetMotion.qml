import QtQuick

// A single spring owns position and velocity until a pointer takes ownership.
// Retargeting changes only the destination; it never restarts an easing curve.
QtObject {
    id: motion

    property real value: 0
    property real velocity: 0
    property real target: 0
    property real settleEnergy: 0
    property bool reducedMotion: false
    property bool held: false
    property bool geometrySettled: true
    property int revision: 0
    property int completedRevision: -1
    property real lastTick: 0
    property real maxStepSeconds: .05
    readonly property bool running: ticker.running
    readonly property bool decorationsSettling: !held && settleEnergy > .006
    signal settled(int completedRevision)

    function completeRevision() {
        if (completedRevision === revision)
            return;
        completedRevision = revision;
        settled(revision);
    }

    function hold(position) {
        ticker.stop();
        held = true;
        value = position;
    }

    function follow(position, pointerVelocity) {
        held = true;
        value = position;
        velocity = pointerVelocity;
        geometrySettled = false;
        settleEnergy = reducedMotion ? 0 : Math.min(1, .12 + Math.abs(pointerVelocity) * .1);
    }

    function retarget(destination) {
        revision++;
        target = destination;
        held = false;
        const distance = Math.abs(target - value);
        if (reducedMotion || (distance < .0001 && Math.abs(velocity) < .01)) {
            value = target;
            velocity = 0;
            geometrySettled = true;
            settleEnergy = reducedMotion ? 0 : settleEnergy;
            completeRevision();
            if (settleEnergy > .006)
                startTicks();
            else
                ticker.stop();
            return revision;
        }
        geometrySettled = false;
        settleEnergy = Math.max(settleEnergy, Math.min(1, .28 + distance * .55 + Math.abs(velocity) * .06));
        startTicks();
        return revision;
    }

    function startTicks() {
        lastTick = Date.now();
        ticker.start();
    }

    function step(now) {
        const dt = Math.max(0, Math.min(maxStepSeconds, (now - lastTick) / 1000));
        lastTick = now;
        settleEnergy *= Math.exp(-7 * dt);
        if (!geometrySettled) {
            // Exact damped-spring advancement is stable across uneven GUI frames.
            // The small overshoot remains decoration: callers clamp geometry.
            const frequency = 24;
            const damping = .82;
            const decayRate = frequency * damping;
            const angularRate = frequency * Math.sqrt(1 - damping * damping);
            const decay = Math.exp(-decayRate * dt);
            const cosine = Math.cos(angularRate * dt);
            const sine = Math.sin(angularRate * dt);
            const error = value - target;
            const priorVelocity = velocity;
            value = target + decay * (error * cosine + (priorVelocity + decayRate * error) / angularRate * sine);
            velocity = decay * (priorVelocity * cosine - (decayRate * priorVelocity + frequency * frequency * error) / angularRate * sine);
            if (Math.abs(value - target) < .0015 && Math.abs(velocity) < .045) {
                value = target;
                velocity = 0;
                geometrySettled = true;
                // Geometry can accept input while the material continues to settle.
                settleEnergy = Math.max(settleEnergy, .16);
                completeRevision();
            }
        }
        if (geometrySettled && settleEnergy <= .006) {
            settleEnergy = 0;
            ticker.stop();
        }
    }

    onReducedMotionChanged: {
        if (reducedMotion) {
            settleEnergy = 0;
            if (!held) {
                ticker.stop();
                value = target;
                velocity = 0;
                geometrySettled = true;
                completeRevision();
            }
        }
    }
    property Timer ticker: Timer {
        interval: 16
        repeat: true
        onTriggered: motion.step(Date.now())
    }
}
