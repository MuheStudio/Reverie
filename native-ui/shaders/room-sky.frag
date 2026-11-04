#version 440

// The window view of the observatory: night sky, moon and reticle, drifting
// clouds, ranges, lake and shore. It covers only the arch opening and is the
// part of the room that animates; room.frag is cached above it and lets this
// view through its glazing. Distances are logical pixels at the window DPR.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 viewportSize;
    vec4 apertureRect;
    float horizonY;
    float taskBlend;
    float readBlend;
    float cloudPhase;
};

const vec3 accent = vec3(0.45, 0.86, 0.83);

float hash12(vec2 p) {
    vec3 p3 = fract(vec3(p.xyx) * 0.1031);
    p3 += dot(p3, p3.yzx + 33.33);
    return fract((p3.x + p3.y) * p3.z);
}
float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), f.x),
        mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0)), f.x), f.y);
}
float cloudNoise(vec2 p) {
    return noise(p) * 0.57 + noise(p * 2.07 + 3.2) * 0.28
        + noise(p * 4.13 + 7.1) * 0.15;
}
float cover(float d) {
    float aa = max(fwidth(d), 0.45);
    return 1.0 - smoothstep(-aa, aa, d);
}
float band(float d, float at, float width) {
    return cover(abs(d - at) - width);
}
void paint(inout vec3 c, vec3 surface, float coverage) {
    c = mix(c, surface, clamp(coverage, 0.0, 1.0));
}
float starLayer(vec2 p, float cellSize, float density, float radius, float seed) {
    vec2 cell = floor(p / cellSize);
    vec2 point = (cell + vec2(hash12(cell + seed), hash12(cell + seed + 19.8))) * cellSize;
    float magnitude = hash12(cell + seed + 4.7);
    float present = step(1.0 - density, hash12(cell + seed + 8.4));
    return exp(-pow(length(p - point) / radius, 2.0)) * present * (0.35 + magnitude * magnitude * 0.65);
}

void main() {
    vec2 size = max(viewportSize, vec2(1.0));
    vec4 arch = apertureRect;
    vec2 p = arch.xy + qt_TexCoord0 * arch.zw;
    vec2 n = p / size;
    float horizon = clamp(horizonY, 1.0, size.y - 1.0);
    float focus = clamp(readBlend * 0.70 + taskBlend * 0.35, 0.0, 1.0);
    float dome = min(arch.z * 0.43, size.y * 0.29);
    vec2 moon = vec2(arch.x + arch.z * 0.66, arch.y + dome * 0.58);
    float moonRadius = min(size.y * 0.053, size.x * 0.04);

    vec3 sky = mix(vec3(0.060, 0.116, 0.172), vec3(0.222, 0.360, 0.397),
        smoothstep(arch.y, horizon, p.y));
    float moonDistance = length(p - moon);
    sky += vec3(0.160, 0.205, 0.202) * exp(-pow(moonDistance / (moonRadius * 3.7), 2.0));
    sky += vec3(0.085, 0.113, 0.125) * exp(-pow(moonDistance / (moonRadius * 7.0), 2.0));
    // Stars are a sparse deterministic cell field, so there is no twinkle or
    // frame noise while the user is reading.
    vec2 starCell = floor(p / 43.0);
    vec2 starPoint = (starCell + vec2(hash12(starCell), hash12(starCell + 19.8))) * 43.0;
    float star = exp(-pow(length(p - starPoint) / 0.85, 2.0))
        * step(0.91, hash12(starCell + 8.4));
    sky += vec3(0.50, 0.59, 0.62) * star * (1.0 - smoothstep(size.y * 0.31, horizon, p.y));
    float skyTop = 1.0 - smoothstep(size.y * 0.31, horizon, p.y);
    float moonWash = smoothstep(moonRadius * 3.5, moonRadius * 9.0, moonDistance);
    // A faint galactic band with a dust lane, washed out near the moon.
    vec2 galaxyAxis = normalize(vec2(1.0, 0.34));
    vec2 galaxyOrigin = vec2(arch.x + arch.z * 0.40, arch.y + dome * 0.62);
    float across = dot(p - galaxyOrigin, vec2(-galaxyAxis.y, galaxyAxis.x));
    float along = dot(p - galaxyOrigin, galaxyAxis);
    float galaxyBand = exp(-pow(across / (size.y * 0.115), 2.0));
    float galaxyCloud = cloudNoise(vec2(along, across * 1.6) / (size.y * 0.11) + 11.0);
    float dustLane = smoothstep(0.50, 0.78, cloudNoise(vec2(along, across * 2.0) / (size.y * 0.09) + 23.0))
        * exp(-pow(across / (size.y * 0.045), 2.0));
    sky += vec3(0.050, 0.062, 0.078) * galaxyBand * (0.40 + galaxyCloud * 0.60)
        * (1.0 - dustLane * 0.28) * moonWash * skyTop;
    // Two finer, static star magnitudes, denser inside the band.
    float fineStars = starLayer(p, 17.0, 0.16 + galaxyBand * 0.20, 0.55, 3.0);
    float faintStars = starLayer(p, 9.0, 0.10 + galaxyBand * 0.25, 0.42, 7.0);
    vec3 starTint = mix(vec3(0.62, 0.70, 0.78), vec3(0.78, 0.72, 0.62), hash12(floor(p / 17.0) + 41.0));
    sky += starTint * (fineStars * 0.55 + faintStars * 0.30) * moonWash * skyTop;
    float md = moonDistance - moonRadius;
    float moonMask = cover(md);
    vec2 moonUv = (p - moon) / max(moonRadius, 1.0);
    float maria = cloudNoise(moonUv * 4.1 + 17.0);
    float crater = noise(moonUv * 15.0 + 31.0);
    vec3 moonSurface = vec3(0.865, 0.895, 0.833)
        * (0.88 + maria * 0.10 + crater * 0.025);
    moonSurface *= 1.0 - smoothstep(0.15, 1.0, moonUv.x) * 0.20;
    moonSurface *= 1.0 - pow(clamp(length(moonUv), 0.0, 1.0), 6.0) * 0.16;
    paint(sky, moonSurface, moonMask);
    sky += vec3(0.054, 0.064, 0.055) * exp(-max(md, 0.0) / 8.0) * (1.0 - moonMask);
    // A faint lunar corona: a bluish inner ring and a warmer outer one.
    float coronaRadius = moonDistance / max(moonRadius, 1.0);
    sky += (vec3(0.026, 0.036, 0.044) * exp(-pow((coronaRadius - 1.85) / 0.32, 2.0))
        + vec3(0.024, 0.019, 0.015) * exp(-pow((coronaRadius - 2.55) / 0.42, 2.0))) * (1.0 - moonMask);

    // Two stretched cloud strata cross the disc. A third low mist layer sits
    // in front of the distant ridge, making depth legible without camera motion.
    vec2 cloudUv = vec2(p.x / (size.x * 0.38) + cloudPhase * 0.03,
        p.y / (size.y * 0.13));
    float billow = cloudNoise(cloudUv + vec2(1.2, 4.0));
    float cloudBand = exp(-pow((p.y - (moon.y + moonRadius * 0.50)) / (size.y * 0.046), 2.0));
    float cloud = smoothstep(0.37, 0.72, billow) * cloudBand;
    paint(sky, vec3(0.213, 0.305, 0.345) + billow * 0.044, cloud * 0.70);
    // Cloud edges near the moon catch a thin silver lining.
    float lining = smoothstep(0.30, 0.40, billow) * (1.0 - smoothstep(0.40, 0.52, billow)) * cloudBand;
    sky += vec3(0.20, 0.24, 0.24) * lining * exp(-pow(moonDistance / (moonRadius * 6.0), 2.0));
    float highBillow = cloudNoise(cloudUv * vec2(0.76, 1.4) + vec2(7.0, 2.0));
    float highBand = exp(-pow((p.y - size.y * 0.31) / (size.y * 0.063), 2.0));
    paint(sky, vec3(0.157, 0.240, 0.285) + highBillow * 0.035,
        smoothstep(0.45, 0.73, highBillow) * highBand * 0.66);

    // The observatory tracks the moon: a graduated reticle on the glass and
    // the moon's dotted path, which sets behind the ranges.
    vec2 fromMoon = p - moon;
    float bearing = atan(fromMoon.y, fromMoon.x);
    float reticleRing = band(moonDistance - moonRadius * 1.55, 0.0, 0.45);
    float reticleTicks = cover(abs(fract(bearing / 6.2831853 * 48.0 + 0.5) - 0.5) / 48.0 * 6.2831853 * moonDistance - 0.45)
        * step(moonRadius * 1.55, moonDistance) * step(moonDistance, moonRadius * 1.72);
    float arcs = band(moonDistance - moonRadius * 2.35, 0.0, 0.5)
        * step(0.18, abs(fract(bearing / 6.2831853 * 4.0 + 0.125) - 0.5));
    float crossDistance = min(abs(fromMoon.x), abs(fromMoon.y));
    float crossReach = max(abs(fromMoon.x), abs(fromMoon.y));
    float crosshair = cover(crossDistance - 0.5) * step(moonRadius * 2.6, crossReach) * step(crossReach, moonRadius * 3.1);
    vec2 orbitCenter = vec2(moon.x - size.x * 0.06, moon.y + size.y * 1.15);
    float orbitRadius = length(moon - orbitCenter);
    float orbitBearing = atan(p.y - orbitCenter.y, p.x - orbitCenter.x);
    float orbitDots = band(length(p - orbitCenter) - orbitRadius, 0.0, 0.7)
        * step(0.62, fract(orbitBearing * orbitRadius / 9.0))
        * (1.0 - exp(-pow(moonDistance / (moonRadius * 3.0), 2.0)));
    sky += accent * (reticleRing * 0.38 + reticleTicks * 0.28 + arcs * 0.25 + crosshair * 0.34 + orbitDots * 0.24)
        * (1.0 - moonMask);
    float farRidge = horizon - size.y * (0.120 + sin(n.x * 9.4 + 0.8) * 0.031
        + sin(n.x * 21.0) * 0.014 + noise(vec2(n.x * 13.0, 3.0)) * 0.041);
    paint(sky, vec3(0.171, 0.267, 0.291), smoothstep(farRidge - 1.0, farRidge + 1.0, p.y));
    // Moonlit crest on the far range and a mist bank before the middle range.
    float crest = exp(-pow((p.y - farRidge - 1.2) / 1.1, 2.0));
    sky += vec3(0.055, 0.075, 0.076) * crest * (0.35 + 0.65 * exp(-pow((p.x - moon.x) / (size.x * 0.22), 2.0)));
    sky = mix(sky, vec3(0.180, 0.262, 0.282), exp(-pow((p.y - (horizon - size.y * 0.095)) / (size.y * 0.022), 2.0)) * 0.22);
    float middleRidge = horizon - size.y * (0.078 + sin(n.x * 12.8 + 1.9) * 0.020
        + noise(vec2(n.x * 23.0, 5.0)) * 0.028);
    paint(sky, vec3(0.102, 0.182, 0.207), smoothstep(middleRidge - 1.0, middleRidge + 1.0, p.y));
    // A few distant observatory beacons sit just below the middle crest.
    for (int i = 0; i < 4; ++i) {
        float fi = float(i);
        float bx = arch.x + arch.z * (0.10 + fi * 0.24 + hash12(vec2(fi, 3.0)) * 0.08);
        float bn = bx / size.x;
        float by = horizon - size.y * (0.078 + sin(bn * 12.8 + 1.9) * 0.020
            + noise(vec2(bn * 23.0, 5.0)) * 0.028) + 2.5 + hash12(vec2(fi, 7.0)) * 3.0;
        float beacon = length(p - vec2(bx, by));
        sky += accent * (exp(-pow(beacon / 0.9, 2.0)) * 0.55 + exp(-beacon / 5.0) * 0.05);
    }
    sky += vec3(0.060, 0.085, 0.082) * exp(-pow((p.y - horizon + size.y * 0.045) / (size.y * 0.044), 2.0));
    // A distant lake below the middle range carries the moon's glitter path.
    float lakeTop = horizon - size.y * 0.052;
    float lakeDepth = clamp((p.y - lakeTop) / max(horizon - lakeTop, 1.0), 0.0, 1.0);
    // Far water mirrors the dark range; nearer water mirrors the open sky.
    vec3 water = mix(vec3(0.088, 0.150, 0.170), vec3(0.150, 0.236, 0.262), smoothstep(0.05, 0.75, lakeDepth));
    float glitterPath = exp(-pow((p.x - moon.x) / (moonRadius * (0.9 + lakeDepth * 1.6)), 2.0));
    float glint = smoothstep(0.58, 0.86, noise(vec2(p.x * 0.30, p.y * 1.9) + 5.0));
    water += vec3(0.52, 0.57, 0.53) * glitterPath * (0.18 + glint * 0.82) * 0.50;
    water += (noise(vec2(p.x * 0.05, p.y * 0.9)) - 0.5) * 0.010;
    paint(sky, water, smoothstep(lakeTop - 0.6, lakeTop + 0.6, p.y));
    sky += vec3(0.050, 0.068, 0.066) * exp(-pow((p.y - lakeTop - 0.8) / 1.0, 2.0));
    float grove = smoothstep(0.38, 0.62, noise(vec2(n.x * 5.0, 2.0)));
    float forestRidge = horizon - size.y * (0.006 + grove * (0.020 + noise(vec2(n.x * 37.0, 8.0)) * 0.026));
    float trees = abs(fract(p.x / 17.0) - 0.5) * 13.0;
    paint(sky, vec3(0.047, 0.109, 0.129), smoothstep(forestRidge + trees - 0.7, forestRidge + trees + 0.7, p.y));
    sky *= 1.0 - focus * 0.12;
    fragColor = vec4(clamp(sky, vec3(0.0), vec3(1.0)), 1.0) * qt_Opacity;
}
