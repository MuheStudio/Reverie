#version 440

// The observatory room around the window: plaster and bronze ribs over an oak
// wainscot, the arch with its light channel and scale, observatory glazing,
// floor and astrolabe, terminal, archive, telescope and desk. None of it moves
// with time, so the scene caches this pass and redraws it only when geometry or
// a transition changes. The window view (room-sky.frag) is composited beneath:
// the output is premultiplied, and its alpha hides exactly the share of that
// view the single-pass room would have replaced. Distances are logical pixels
// rendered at the window DPR; no bitmap or reduced capture is involved.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 viewportSize;
    vec4 apertureRect;
    vec4 archiveAnchor;
    vec4 terminalAnchor;
    vec4 avatarRect;
    float horizonY;
    float taskBlend;
    float readBlend;
    float avatarVisibility;
    float archiveOpen;
    float terminalOpen;
    vec2 lightDirection;
    // 1 while the closed portal faces rest in their slots; 0 in compact
    // layouts and while reading or working, when the room shows its own faces.
    float portalDocked;
    // Where the actor stands: the astrolabe's centre and the model's base.
    vec2 stageCenter;
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
float boxSdf(vec2 p, vec4 rect, float radius) {
    vec2 q = abs(p - rect.xy - rect.zw * 0.5)
        - rect.zw * 0.5 + vec2(radius);
    return length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
}
float archSdf(vec2 p, vec4 rect, float dome) {
    vec2 q = p - vec2(rect.x + rect.z * 0.5, rect.y + dome);
    if (q.y < 0.0) {
        vec2 ellipse = q / vec2(rect.z * 0.5, dome);
        // The first-order ellipse distance preserves physical bevel widths.
        float k = length(ellipse);
        float grad = length(q / (vec2(rect.z * 0.5, dome) * vec2(rect.z * 0.5, dome)));
        return (k - 1.0) * k / max(grad, 0.0001);
    }
    return max(abs(q.x) - rect.z * 0.5, p.y - rect.y - rect.w);
}
float cover(float d) {
    float aa = max(fwidth(d), 0.45);
    return 1.0 - smoothstep(-aa, aa, d);
}
float band(float d, float at, float width) {
    return cover(abs(d - at) - width);
}
float ovalSdf(vec2 p, vec2 center, vec2 radii) {
    vec2 q = (p - center) / max(radii, vec2(1.0));
    return (length(q) - 1.0) * min(radii.x, radii.y);
}
float softOval(vec2 p, vec2 center, vec2 radii) {
    vec2 q = (p - center) / max(radii, vec2(1.0));
    return exp(-dot(q, q) * 2.0);
}
void paint(inout vec3 c, vec3 surface, float coverage) {
    c = mix(c, surface, clamp(coverage, 0.0, 1.0));
}
// Over the window view, colour is tracked as src + keep * view.
void paintOver(inout vec3 src, inout float keep, vec3 surface, float coverage) {
    float k = clamp(coverage, 0.0, 1.0);
    src = mix(src, surface, k);
    keep *= 1.0 - k;
}
void shade(inout vec3 src, inout float keep, float factor) {
    src *= factor;
    keep *= factor;
}
float segment(vec2 p, vec2 a, vec2 b, out float h) {
    vec2 pa = p - a, ba = b - a;
    h = clamp(dot(pa, ba) / max(dot(ba, ba), 0.0001), 0.0, 1.0);
    return length(pa - ba * h);
}
vec3 oak(vec2 p, vec3 base) {
    float fine = noise(vec2(p.x * 0.018, p.y * 0.39));
    float ring = sin(p.y * 0.47 + noise(vec2(p.x * 0.008, p.y * 0.037)) * 9.0);
    return base + (fine - 0.5) * 0.015 + ring * 0.005;
}
// Signed distance to a triangle, negative inside.
float triangleSdf(vec2 p, vec2 a, vec2 b, vec2 c) {
    vec2 e0 = b - a, e1 = c - b, e2 = a - c;
    vec2 v0 = p - a, v1 = p - b, v2 = p - c;
    vec2 pq0 = v0 - e0 * clamp(dot(v0, e0) / dot(e0, e0), 0.0, 1.0);
    vec2 pq1 = v1 - e1 * clamp(dot(v1, e1) / dot(e1, e1), 0.0, 1.0);
    vec2 pq2 = v2 - e2 * clamp(dot(v2, e2) / dot(e2, e2), 0.0, 1.0);
    float s = sign(e0.x * e2.y - e0.y * e2.x);
    vec2 d = min(min(vec2(dot(pq0, pq0), s * (v0.x * e0.y - v0.y * e0.x)),
                     vec2(dot(pq1, pq1), s * (v1.x * e1.y - v1.y * e1.x))),
                 vec2(dot(pq2, pq2), s * (v2.x * e2.y - v2.y * e2.x)));
    return -sqrt(d.x) * sign(d.y);
}
// A cylinder seen side-on: `side` runs -1..1 across it toward `axisNormal`.
// The room's key light wraps over it, the sconce adds warmth on the lit side,
// a gloss term gives lacquer or metal its highlight, and the window behind
// leaves a cool rim on edges that face it.
vec3 cylinderShade(vec3 base, float side, vec2 axisNormal, vec2 light, vec2 rimDir, float gloss, float warm) {
    float s = clamp(side, -1.0, 1.0);
    vec3 n = vec3(axisNormal * s, sqrt(max(1.0 - s * s, 0.0)));
    vec3 l = normalize(vec3(light, 0.70));
    float diffuse = max(dot(n, l), 0.0);
    float spec = pow(max(dot(n, normalize(l + vec3(0.0, 0.0, 1.0))), 0.0), 36.0) * gloss;
    float rim = pow(max(dot(n.xy, rimDir), 0.0), 6.0);
    return base * (0.50 + 0.80 * diffuse)
        + vec3(0.36, 0.22, 0.11) * diffuse * warm * 0.22
        + vec3(0.62, 0.70, 0.70) * spec
        + vec3(0.30, 0.46, 0.50) * rim * 0.38;
}
// A terminal at rest when its glass face is not docked: a dark screen with a
// sheen, a status line and a flat trace with one blip.
void standbyScreen(inout vec3 src, inout float keep, vec2 p, vec4 a, float weight) {
    vec4 s = vec4(a.x + 6.0, a.y + 6.0, a.z - 12.0, a.w - 12.0);
    float sd = boxSdf(p, s, 5.0);
    float screen = cover(sd) * weight;
    vec3 glass = mix(vec3(0.040, 0.092, 0.106), vec3(0.022, 0.060, 0.072), smoothstep(s.y, s.y + s.w, p.y));
    paintOver(src, keep, glass, screen);
    paintOver(src, keep, vec3(0.300, 0.420, 0.430), band(sd, -0.5, 0.5) * 0.35 * weight);
    src += vec3(0.62, 0.78, 0.80) * (1.0 - smoothstep(s.y, s.y + s.w * 0.42, p.y))
        * smoothstep(s.x + s.z * 0.15, s.x + s.z * 0.55, p.x + (p.y - s.y) * 1.4) * 0.030 * screen;
    float status = max(cover(boxSdf(p, vec4(s.x + 9.0, s.y + 8.0, 24.0, 2.0), 1.0)),
        cover(boxSdf(p, vec4(s.x + 37.0, s.y + 8.0, 11.0, 2.0), 1.0)) * 0.6);
    src += accent * status * 0.34 * weight;
    float traceY = s.y + s.w * 0.62;
    float blipX = s.x + s.z * 0.64;
    float curve = traceY - exp(-pow((p.x - blipX) / 4.5, 2.0)) * s.w * 0.22
        + exp(-pow((p.x - blipX - 7.0) / 3.5, 2.0)) * s.w * 0.08;
    float inTrace = step(s.x + 10.0, p.x) * step(p.x, s.x + s.z - 10.0);
    float traceD = abs(p.y - curve);
    src += accent * (cover(traceD - 0.55) * 0.55 + exp(-traceD / 3.5) * 0.10) * inTrace * screen;
}

// An archive at rest when its glass drawer is not docked: a raised oak front
// with a card holder and a brass pull.
void closedDrawer(inout vec3 src, inout float keep, vec2 p, vec4 a, float weight) {
    vec4 f = vec4(a.x + 2.0, a.y + 2.0, a.z - 4.0, a.w - 4.0);
    float fd = boxSdf(p, f, 6.0);
    vec3 front = oak(p, vec3(0.150, 0.152, 0.134));
    front += (1.0 - smoothstep(f.y, f.y + f.w, p.y)) * vec3(0.026, 0.028, 0.022);
    paintOver(src, keep, front, cover(fd) * weight);
    paintOver(src, keep, vec3(0.312, 0.320, 0.282), band(fd, -1.0, 0.60) * 0.42 * weight);
    float panel = boxSdf(p, vec4(f.x + 9.0, f.y + 8.0, f.z - 18.0, f.w - 16.0), 4.0);
    paintOver(src, keep, vec3(0.070, 0.080, 0.074), band(panel, 0.0, 0.55) * 0.55 * weight);
    paintOver(src, keep, vec3(0.250, 0.258, 0.226), band(panel, 1.2, 0.45) * 0.35 * weight);
    vec2 c = vec2(f.x + f.z * 0.5, f.y + f.w * 0.5);
    vec4 card = vec4(c.x - 15.0, c.y - 18.0, 30.0, 11.0);
    float cardD = boxSdf(p, card, 1.5);
    paintOver(src, keep, vec3(0.640, 0.620, 0.520), cover(cardD + 1.2) * 0.80 * weight);
    paintOver(src, keep, vec3(0.553, 0.526, 0.393), band(cardD, -0.4, 0.6) * 0.85 * weight);
    paintOver(src, keep, vec3(0.300, 0.290, 0.240), cover(boxSdf(p, vec4(card.x + 6.0, card.y + 4.5, 18.0, 1.2), 0.4)) * 0.70 * weight);
    vec4 pull = vec4(c.x - 17.0, c.y + 3.0, 34.0, 5.0);
    shade(src, keep, 1.0 - cover(boxSdf(p, pull + vec4(1.0, 2.5, 0.0, 0.0), 2.5)) * 0.45 * weight);
    vec3 brass = mix(vec3(0.700, 0.660, 0.500), vec3(0.430, 0.400, 0.300), smoothstep(pull.y, pull.y + pull.w, p.y));
    paintOver(src, keep, brass, cover(boxSdf(p, pull, 2.5)) * weight);
}

void main() {
    vec2 size = max(viewportSize, vec2(1.0));
    vec2 p = qt_TexCoord0 * size;
    vec2 n = qt_TexCoord0;
    float horizon = clamp(horizonY, 1.0, size.y - 1.0);
    float focus = clamp(readBlend * 0.70 + taskBlend * 0.35, 0.0, 1.0);
    vec2 light = lightDirection / max(length(lightDirection), 0.001);
    vec4 arch = apertureRect;
    float dome = min(arch.z * 0.43, size.y * 0.29);
    float frame = clamp(size.y * 0.025, 16.0, 25.0);
    float ad = archSdf(p, arch, dome);
    float inner = cover(ad + frame);
    vec2 moon = vec2(arch.x + arch.z * 0.66, arch.y + dome * 0.58);

    // Upper wall: smoked plaster between slim bronze ribs. Lower wall: warm oak
    // wainscot of raised panels under a moulded chair rail.
    float railY = horizon - size.y * 0.235;
    vec3 c = mix(vec3(0.056, 0.086, 0.102), vec3(0.108, 0.134, 0.142), smoothstep(0.0, railY, p.y));
    c += (noise(p * vec2(0.045, 0.060)) - 0.5) * 0.012 + (hash12(floor(p * 1.5)) - 0.5) * 0.004;
    float ribSigned = (fract(p.x / 156.0 + 0.5) - 0.5) * 156.0;
    float upperWall = 1.0 - smoothstep(railY - 1.0, railY + 1.0, p.y);
    paint(c, vec3(0.088, 0.112, 0.122), cover(abs(ribSigned) - 2.6) * upperWall);
    paint(c, vec3(0.250, 0.276, 0.262), cover(abs(ribSigned - 1.8) - 0.45) * upperWall * 0.55);
    float panelPitch = 124.0;
    vec2 panelLocal = vec2(fract(p.x / panelPitch) * panelPitch, p.y - railY);
    float raised = boxSdf(panelLocal, vec4(10.0, 14.0, panelPitch - 20.0, max(horizon - railY - 34.0, 1.0)), 3.0);
    vec3 wainscot = oak(p, vec3(0.146, 0.122, 0.098));
    wainscot *= (1.0 + cover(raised) * 0.07) * (1.0 - band(raised, 0.0, 1.2) * 0.32);
    wainscot += vec3(0.050, 0.044, 0.034) * band(raised, -1.6, 0.5) * 0.6;
    paint(c, wainscot, smoothstep(railY - 0.5, railY + 0.5, p.y));
    paint(c, oak(p, vec3(0.176, 0.152, 0.122)), cover(abs(p.y - railY) - 3.5));
    paint(c, vec3(0.400, 0.360, 0.300), cover(abs(p.y - railY + 3.0) - 0.45) * 0.70);
    // A light line tucked under the rail washes the panels below it.
    c += accent * (cover(abs(p.y - railY - 4.5) - 0.45) * 0.30
        + exp(-max(p.y - railY - 4.5, 0.0) / 24.0) * step(railY + 4.5, p.y) * 0.032);
    // The soft warm fill is deliberately neutral near the character; it never
    // recolors the avatar.
    vec2 warmFixture = vec2(arch.x - frame * 1.5, arch.y + arch.w * 0.56);
    c += vec3(0.155, 0.084, 0.041) * softOval(p, warmFixture, vec2(170.0, 205.0)) * (1.0 - focus * 0.25);
    c += vec3(0.090, 0.052, 0.026) * softOval(p, warmFixture - vec2(0.0, 44.0), vec2(22.0, 64.0)) * (1.0 - focus * 0.25);
    c += vec3(0.018, 0.038, 0.044) * softOval(p, vec2(size.x * 0.86, horizon * 0.45), size * vec2(0.30, 0.51));
    c *= 1.0 - exp(-p.y / 27.0) * 0.28;
    // Reveal and wall contact shadow give the arch real thickness before its
    // far landscape is inserted into the aperture.
    c *= 1.0 - exp(-pow(max(ad, 0.0) / 21.0, 2.0)) * 0.27 * (1.0 - cover(ad));
    // The window view shows through the aperture; everything below lies over it.
    vec3 src = c * (1.0 - inner);
    float keep = inner;
    // Glass presence: a faint diagonal sheen, the sconce's reflection and
    // cool condensation where the pane meets the sill.
    vec2 sheenAxis = normalize(vec2(1.0, -0.38));
    float sheen = exp(-pow((dot(p - arch.xy, sheenAxis) - arch.z * 0.50) / (arch.z * 0.050), 2.0));
    src += vec3(0.030, 0.038, 0.040) * sheen * inner;
    src += vec3(0.050, 0.030, 0.016) * softOval(p, vec2(arch.x + arch.z * 0.07, warmFixture.y - 10.0), vec2(42.0, 90.0)) * inner;
    float condensation = smoothstep(horizon - size.y * 0.075, horizon - 4.0, p.y)
        * smoothstep(0.42, 0.78, cloudNoise(p * vec2(0.05, 0.11) + 13.0));
    paintOver(src, keep, vec3(0.200, 0.262, 0.270), condensation * inner * 0.14);

    // Smoked bronze / ash reveal and a dark inside return. Occlusion stays
    // close to the reveal rather than dimming the entire far window view.
    vec2 archNormal = normalize(vec2(dFdx(ad), dFdy(ad)) + vec2(0.00001));
    float frameLight = max(dot(archNormal, light), 0.0);
    vec3 frameColor = oak(p, vec3(0.120, 0.152, 0.160))
        + frameLight * vec3(0.092, 0.111, 0.111);
    paintOver(src, keep, frameColor, cover(ad) - inner);
    paintOver(src, keep, vec3(0.334, 0.387, 0.384), band(ad, -2.0, 0.75) * 0.53);
    paintOver(src, keep, vec3(0.073, 0.108, 0.121), band(ad, -frame + 4.0, 3.0));
    paintOver(src, keep, vec3(0.402, 0.492, 0.508), band(ad, -frame + 1.0, 0.68) * (0.35 + frameLight * 0.48));
    // An inset light channel runs along the arch face and fades toward the sill.
    float archFace = cover(ad) - inner;
    float channelFade = smoothstep(horizon, horizon - arch.w * 0.55, p.y);
    src += accent * (band(ad, -frame * 0.52, 0.45) * 0.40 * archFace
        + exp(-abs(ad + frame * 0.52) / 5.0) * archFace * 0.05
        + exp(-max(ad, 0.0) / 14.0) * (1.0 - cover(ad)) * 0.018) * channelFade;
    // A graduated scale beside the channel over the dome, major every fifth.
    vec2 archCenter = vec2(arch.x + arch.z * 0.5, arch.y + dome);
    float archAngle = atan(p.y - archCenter.y, p.x - archCenter.x);
    float archRadius = length(p - archCenter);
    float minorTick = abs(fract(archAngle / 6.2831853 * 120.0 + 0.5) - 0.5) / 120.0 * 6.2831853 * archRadius;
    float majorTick = abs(fract(archAngle / 6.2831853 * 24.0 + 0.5) - 0.5) / 24.0 * 6.2831853 * archRadius;
    float overDome = step(p.y, archCenter.y) * archFace;
    src += accent * (cover(minorTick - 0.45) * band(ad, -frame * 0.80, 1.4)
        + cover(majorTick - 0.55) * band(ad, -frame * 0.82, 2.6)) * overDome * 0.32;
    vec2 keystone = vec2(arch.x + arch.z * 0.5, arch.y + frame * 0.48);
    src += accent * (cover(length(p - keystone) - 2.2) * 0.65 + exp(-length(p - keystone) / 9.0) * 0.07);
    float revealDepth = max(-ad - frame, 0.0);
    float returnShadow = exp(-revealDepth / 9.0) * inner;
    shade(src, keep, 1.0 - returnShadow * (0.14 + (1.0 - frameLight) * 0.10));
    // Observatory glazing: two meridian ribs converge toward the dome crown
    // above the arch and frame the moon; a ring rib crosses the lower view and
    // rises at the sides.
    float crownX = arch.x + arch.z * 0.5;
    float crownY = arch.y - dome * 0.9;
    float meridian = sqrt(clamp((p.y - crownY) / max(horizon - crownY, 1.0), 0.0, 1.0));
    float ribX1 = crownX - arch.z * 0.40 * meridian;
    float ribX2 = crownX + arch.z * 0.40 * meridian;
    // Rib feet at the sill, used by the floor's projected shadows.
    float mullionX1 = crownX - arch.z * 0.40;
    float mullionX2 = crownX + arch.z * 0.40;
    float ringBase = horizon - size.y * 0.20;
    float ringY = ringBase - pow((p.x - crownX) / (arch.z * 0.5), 2.0) * size.y * 0.045;
    float bars = cover(min(min(abs(p.x - ribX1), abs(p.x - ribX2)) - 3.4, abs(p.y - ringY) - 2.4)) * inner;
    paintOver(src, keep, vec3(0.082, 0.128, 0.146), bars);
    // Moon-facing faces catch light; the far faces stay in shade.
    paintOver(src, keep, vec3(0.380, 0.470, 0.470), cover(min(abs(p.x - ribX1 - 2.1), abs(p.x - ribX2 - 2.1)) - 0.5) * bars * 0.56);
    paintOver(src, keep, vec3(0.040, 0.070, 0.084), cover(min(abs(p.x - ribX1 + 2.3), abs(p.x - ribX2 + 2.3)) - 0.45) * bars * 0.65);
    paintOver(src, keep, vec3(0.330, 0.420, 0.430), cover(abs(p.y - ringY + 1.7) - 0.45) * bars * 0.45);
    // Bronze nodes where the ring meets the meridians.
    float nodeMeridian = sqrt(clamp((ringBase - crownY) / max(horizon - crownY, 1.0), 0.0, 1.0));
    for (int i = 0; i < 2; ++i) {
        float nodeX = crownX + (i == 0 ? -1.0 : 1.0) * arch.z * 0.40 * nodeMeridian;
        vec2 node = vec2(nodeX, ringBase - pow((nodeX - crownX) / (arch.z * 0.5), 2.0) * size.y * 0.045);
        float nodeDistance = length(p - node);
        paintOver(src, keep, vec3(0.300, 0.270, 0.210), cover(nodeDistance - 6.0) * inner);
        paintOver(src, keep, vec3(0.560, 0.500, 0.380), band(nodeDistance - 6.0, -1.0, 0.5) * inner * 0.6);
        src += accent * (cover(nodeDistance - 1.6) * 0.70 + exp(-nodeDistance / 7.0) * 0.06) * inner;
    }
    vec4 sill = vec4(arch.x - 16.0, horizon - 7.0, arch.z + 32.0, 20.0);
    float sillMask = cover(boxSdf(p, sill, 4.0));
    paintOver(src, keep, oak(p, vec3(0.159, 0.207, 0.212)), sillMask);
    paintOver(src, keep, vec3(0.416, 0.491, 0.475), cover(boxSdf(p, vec4(sill.x + 4.0, sill.y, sill.z - 8.0, 1.5), 0.5)) * 0.62);

    // The floor is one perspective plane, with low-contrast joined planks and
    // moonlight projected from the same world horizon as the exterior.
    float floorMask = smoothstep(horizon - 1.0, horizon + 1.0, p.y);
    float depth = clamp((p.y - horizon) / max(size.y - horizon, 1.0), 0.0, 1.0);
    float perspective = 0.15 + depth * 1.45;
    float floorX = (p.x - size.x * 0.52) / (67.0 * perspective);
    float floorZ = 1.0 / (0.21 + depth);
    vec3 floorColor = oak(vec2(p.x / perspective, floorZ * 120.0),
        mix(vec3(0.098, 0.106, 0.108), vec3(0.168, 0.150, 0.128), depth));
    float plankEdge = min(fract(floorX), 1.0 - fract(floorX));
    float plankSeam = 1.0 - smoothstep(0.0, 0.018 / perspective, plankEdge);
    float endSeam = 1.0 - smoothstep(0.0, 0.021, min(fract(floorZ * 3.0), 1.0 - fract(floorZ * 3.0)));
    floorColor *= 1.0 - plankSeam * 0.12 - endSeam * 0.035;
    floorColor *= 1.0 + (hash12(vec2(floor(floorX), floor(floorZ * 3.0))) - 0.5) * 0.07;
    float beamCenter = mix(moon.x, size.x * 0.27, depth);
    float beam = exp(-pow((p.x - beamCenter) / (30.0 + depth * 190.0), 2.0));
    // The mullions cast two soft bars in the same perspective as the floor.
    // These are architectural shadows, so they remain still during reading.
    float projectedBar1 = mix(mullionX1, mullionX1 - size.x * 0.24, depth);
    float projectedBar2 = mix(mullionX2, mullionX2 - size.x * 0.24, depth);
    float barWidth = 4.0 + depth * 13.0;
    float barShadow = max(exp(-pow((p.x - projectedBar1) / barWidth, 2.0)),
        exp(-pow((p.x - projectedBar2) / barWidth, 2.0)));
    floorColor += vec3(0.069, 0.096, 0.093) * beam
        * (1.0 - barShadow * 0.64) * (1.0 - focus * 0.55);
    // A satin finish reflects the aperture as a soft column, broken by mullions.
    float underWindow = smoothstep(arch.x + 10.0, arch.x + 60.0, p.x)
        * (1.0 - smoothstep(arch.x + arch.z - 60.0, arch.x + arch.z - 10.0, p.x));
    float mullionGap = 1.0 - max(exp(-pow((p.x - mullionX1) / (3.0 + depth * 6.0), 2.0)),
        exp(-pow((p.x - mullionX2) / (3.0 + depth * 6.0), 2.0))) * 0.7;
    floorColor += vec3(0.030, 0.045, 0.048) * underWindow * mullionGap * exp(-depth * 4.5) * (1.0 - focus * 0.45);
    floorColor *= 1.0 - exp(-depth * 20.0) * 0.26;
    float sillSpan = smoothstep(sill.x - 8.0, sill.x + 4.0, p.x)
        * (1.0 - smoothstep(sill.x + sill.z - 4.0, sill.x + sill.z + 8.0, p.x));
    floorColor *= 1.0 - exp(-pow((p.y - sill.y - sill.w) / 6.0, 2.0)) * sillSpan * 0.16;
    // Preserve the sill's visible front face below the world horizon.
    paintOver(src, keep, floorColor, floorMask * (1.0 - sillMask));
    paintOver(src, keep, vec3(0.051, 0.074, 0.080), cover(boxSdf(p, vec4(0.0, horizon - 3.0, size.x, 5.0), 0.0)) * (1.0 - sillMask));
    // A low skirting board with a lit top edge, outside the window opening.
    float skirtingArea = (1.0 - sillMask) * (1.0 - inner);
    paintOver(src, keep, oak(p, vec3(0.098, 0.122, 0.126)), cover(boxSdf(p, vec4(0.0, horizon - 15.0, size.x, 12.0), 0.0)) * skirtingArea);
    paintOver(src, keep, vec3(0.300, 0.350, 0.345), cover(abs(p.y - (horizon - 15.0)) - 0.45) * skirtingArea * 0.55);
    // A cove light in the skirting washes the wall and the first boards.
    float coveArea = (1.0 - sillMask) * (1.0 - inner);
    float coveLine = cover(abs(p.y - (horizon - 2.0)) - 0.5);
    src += accent * (coveLine * 0.32
        + exp(-max(horizon - 2.0 - p.y, 0.0) / 16.0) * step(p.y, horizon) * 0.030
        + exp(-max(p.y - horizon, 0.0) / 10.0) * step(horizon, p.y) * 0.035) * coveArea;

    // An astrolabe inlay marks the actor's place: brass rings, graduations and
    // a lit groove, in the same perspective as the boards.
    // SceneDirector.stageFrontY mirrors this ellipse to keep the name plate clear.
    if (avatarRect.z > 0.0 && avatarRect.w > 0.0) {
        vec2 stage = stageCenter;
        float stageRadius = avatarRect.z * 0.50;
        vec2 sq = (p - stage) / vec2(stageRadius, stageRadius * 0.16);
        float sr = length(sq);
        float sa = atan(sq.y, sq.x);
        shade(src, keep, 1.0 - cover((sr - 1.0) * stageRadius) * floorMask * 0.16);
        float rings = max(band((sr - 1.0) * stageRadius, 0.0, 1.8),
            max(band((sr - 0.86) * stageRadius, 0.0, 0.7), band((sr - 0.56) * stageRadius, 0.0, 0.9)));
        float fine = cover(abs(fract(sa / 6.2831853 * 72.0 + 0.5) - 0.5) / 72.0 * 6.2831853 * sr * stageRadius - 0.55)
            * step(0.90, sr) * step(sr, 0.985);
        float major = cover(abs(fract(sa / 6.2831853 * 8.0 + 0.5) - 0.5) / 8.0 * 6.2831853 * sr * stageRadius - 0.9)
            * step(0.62, sr) * step(sr, 0.985);
        float moonlit = 0.55 + 0.45 * exp(-pow((p.x - stage.x - stageRadius * 0.35) / (stageRadius * 0.9), 2.0));
        paintOver(src, keep, vec3(0.420, 0.385, 0.300) * moonlit, clamp(rings + fine * 0.8 + major, 0.0, 1.0) * floorMask * 0.85);
        float lightPoints = cover(abs(fract(sa / 6.2831853 * 36.0 + 0.5) - 0.5) / 36.0 * 6.2831853 * sr * stageRadius - 1.1)
            * band((sr - 0.93) * stageRadius, 0.0, 1.1);
        src += accent * (band((sr - 0.71) * stageRadius, 0.0, 0.6) * 0.55
            + exp(-abs(sr - 0.71) * stageRadius / 7.0) * 0.07 + lightPoints * 0.45) * floorMask;
    }

    // A small wall sconce supplies a warm bounce rather than a warm color cast.
    float sconce = cover(boxSdf(p, vec4(warmFixture - vec2(6.0, 20.0), 12.0, 40.0), 5.0));
    paintOver(src, keep, vec3(0.219, 0.190, 0.154), sconce);
    float sconceCore = cover(boxSdf(p, vec4(warmFixture - vec2(1.2, 14.0), 2.4, 28.0), 1.1));
    paintOver(src, keep, vec3(0.754, 0.591, 0.377), sconceCore);

    // Terminal: an actual recessed shell on a tapered stem and weighted foot.
    // Its glass face belongs to ScenePortal; the open face reveals its socket,
    // and a closed face that is not docked leaves the room's standby screen.
    if (terminalAnchor.z > 0.0 && terminalAnchor.w > 0.0 && terminalAnchor.y + terminalAnchor.w < horizon - 120.0) {
        // Wall-mounted instrument: a mounting rail, a recessed shell, status
        // lights and a screen glow spilling onto the plaster.
        vec4 a = terminalAnchor;
        vec4 housing = vec4(a.xy - vec2(9.0, 9.0), a.zw + vec2(18.0, 20.0));
        float shellD = boxSdf(p, housing, 14.0);
        paintOver(src, keep, vec3(0.110, 0.130, 0.136), cover(boxSdf(p, vec4(housing.x - 22.0, housing.y + housing.w * 0.5 - 2.5, housing.z + 44.0, 5.0), 2.0)));
        paintOver(src, keep, vec3(0.300, 0.330, 0.320), cover(abs(p.y - (housing.y + housing.w * 0.5 - 2.5)) - 0.45)
            * step(housing.x - 22.0, p.x) * step(p.x, housing.x + housing.z + 22.0) * 0.6);
        shade(src, keep, 1.0 - exp(-pow(max(shellD, 0.0) / 10.0, 2.0)) * (1.0 - cover(shellD)) * 0.30);
        vec3 shell = mix(vec3(0.120, 0.150, 0.162), vec3(0.070, 0.090, 0.100), smoothstep(housing.y, housing.y + housing.w, p.y));
        paintOver(src, keep, shell, cover(shellD));
        paintOver(src, keep, vec3(0.446, 0.539, 0.537), band(shellD, -1.0, 0.60) * 0.40);
        paintOver(src, keep, vec3(0.021, 0.055, 0.069) + terminalOpen * vec3(0.008, 0.029, 0.034), cover(boxSdf(p, a, 9.0)));
        standbyScreen(src, keep, p, a, (1.0 - portalDocked) * (1.0 - terminalOpen));
        src += accent * exp(-max(shellD, 0.0) / 26.0) * (1.0 - cover(shellD)) * 0.045;
        for (int i = 0; i < 3; ++i) {
            vec2 led = vec2(housing.x + housing.z - 16.0 - float(i) * 7.0, housing.y + 5.0);
            float ledDistance = length(p - led);
            vec3 ledColor = i == 2 ? vec3(0.86, 0.72, 0.50) : accent;
            src += ledColor * (exp(-pow(ledDistance / 1.3, 2.0)) * 0.55 + exp(-ledDistance / 4.0) * 0.05);
        }
        src += accent * band(boxSdf(p, a, 9.0), 1.5, 0.45) * 0.30;
    } else if (terminalAnchor.z > 0.0 && terminalAnchor.w > 0.0) {
        vec4 a = terminalAnchor;
        float baseY = max(horizon + 28.0, a.y + a.w + 43.0);
        vec2 foot = vec2(a.x + a.z * 0.5, baseY);
        shade(src, keep, 1.0 - softOval(p, foot + vec2(9.0, 7.0), vec2(a.z * 0.68, 18.0)) * 0.42);
        float stemWidth = max(17.0, a.z * 0.13);
        vec4 stem = vec4(foot.x - stemWidth * 0.5, a.y + a.w - 1.0, stemWidth, baseY - a.y - a.w);
        float stemMask = cover(boxSdf(p, stem, 4.0));
        vec3 metal = mix(vec3(0.069, 0.099, 0.114), vec3(0.175, 0.232, 0.241),
            1.0 - smoothstep(stem.x, stem.x + stem.z, p.x));
        paintOver(src, keep, metal, stemMask);
        paintOver(src, keep, vec3(0.060, 0.094, 0.108), cover(boxSdf(p, vec4(foot.x - a.z * 0.36, baseY - 8.0, a.z * 0.72, 13.0), 5.0)));
        paintOver(src, keep, vec3(0.223, 0.296, 0.298), cover(boxSdf(p, vec4(foot.x - a.z * 0.34, baseY - 8.0, a.z * 0.68, 2.0), 1.0)) * 0.73);
        vec4 housing = vec4(a.xy - vec2(9.0, 9.0), a.zw + vec2(18.0, 22.0));
        float shellD = boxSdf(p, housing, 14.0);
        shade(src, keep, 1.0 - exp(-pow(max(shellD, 0.0) / 8.0, 2.0)) * (1.0 - cover(shellD)) * 0.25);
        vec3 shell = oak(p, vec3(0.121, 0.170, 0.185));
        shell += (1.0 - smoothstep(housing.y, housing.y + housing.w, p.y)) * 0.057;
        paintOver(src, keep, shell, cover(shellD));
        paintOver(src, keep, vec3(0.446, 0.539, 0.537), band(shellD, -1.0, 0.60) * 0.49);
        float slot = cover(boxSdf(p, a, 9.0));
        paintOver(src, keep, vec3(0.021, 0.055, 0.069) + terminalOpen * vec3(0.008, 0.029, 0.034), slot);
        standbyScreen(src, keep, p, a, (1.0 - portalDocked) * (1.0 - terminalOpen));
        float socketLight = cover(boxSdf(p, vec4(a.x + a.z * 0.29, a.y + a.w + 5.0, a.z * 0.42, 1.0), 0.45));
        paintOver(src, keep, vec3(0.263, 0.532, 0.545), socketLight * (0.32 + terminalOpen * 0.48));
        // Instrument details: status lights, a socket rim and a faint halo.
        src += accent * exp(-max(shellD, 0.0) / 22.0) * (1.0 - cover(shellD)) * 0.030;
        for (int i = 0; i < 3; ++i) {
            vec2 led = vec2(housing.x + housing.z - 16.0 - float(i) * 7.0, housing.y + 5.0);
            float ledDistance = length(p - led);
            vec3 ledColor = i == 2 ? vec3(0.86, 0.72, 0.50) : accent;
            src += ledColor * (exp(-pow(ledDistance / 1.3, 2.0)) * 0.55 + exp(-ledDistance / 4.0) * 0.05);
        }
        src += accent * band(boxSdf(p, a, 9.0), 1.5, 0.45) * 0.30;
    }

    // Archive: real oak carcass, varied bound volumes, a pull-out glass front,
    // bottom joinery, and a visible docking cavity when the drawer is lifted;
    // a closed drawer that is not docked shows the room's own oak front.
    if (archiveAnchor.z > 0.0 && archiveAnchor.w > 0.0) {
        vec4 a = archiveAnchor;
        float bottom = max(horizon + 44.0, a.y + a.w + 30.0);
        vec4 body = vec4(a.x - 13.0, a.y - a.w * 0.91, a.z + 26.0, bottom - a.y + a.w * 0.91);
        vec2 contact = vec2(body.x + body.z * 0.5, bottom + 4.0);
        shade(src, keep, 1.0 - softOval(p, contact + vec2(7.0, 4.0), vec2(body.z * 0.66, 21.0)) * 0.46);
        float bd = boxSdf(p, body, 7.0);
        shade(src, keep, 1.0 - exp(-pow(max(bd, 0.0) / 9.0, 2.0)) * (1.0 - cover(bd)) * 0.25);
        vec3 wood = oak(p, vec3(0.151, 0.151, 0.133));
        wood += (1.0 - smoothstep(body.x, body.x + body.z, p.x)) * vec3(0.043, 0.048, 0.038);
        paintOver(src, keep, wood, cover(bd));
        paintOver(src, keep, vec3(0.312, 0.320, 0.282), band(bd, -1.0, 0.60) * 0.42);
        vec4 shelf = vec4(body.x + 12.0, body.y + 12.0, body.z - 24.0, a.y - body.y - 21.0);
        paintOver(src, keep, vec3(0.045, 0.071, 0.077), cover(boxSdf(p, shelf, 2.0)));
        for (int i = 0; i < 11; ++i) {
            float fi = float(i);
            float variation = hash12(vec2(fi, 13.0));
            float pitch = shelf.z / 11.0;
            float bookHeight = shelf.w * (0.61 + variation * 0.33);
            vec4 book = vec4(shelf.x + pitch * fi + 2.0, shelf.y + shelf.w - bookHeight - 2.0,
                pitch * (0.71 + variation * 0.13), bookHeight);
            vec3 bookColor = mix(vec3(0.243, 0.339, 0.348), vec3(0.441, 0.409, 0.311), variation);
            bookColor = mix(bookColor, vec3(0.206, 0.252, 0.302), step(0.74, variation) * 0.65);
            float bookMask = cover(boxSdf(p, book, 1.3));
            bookColor *= 0.85 + (1.0 - smoothstep(book.x, book.x + book.z, p.x)) * 0.20;
            paintOver(src, keep, bookColor, bookMask);
            float spineLine = cover(boxSdf(p, vec4(book.x + 1.5, book.y + 4.0, 0.8, book.w - 8.0), 0.2));
            paintOver(src, keep, bookColor + 0.085, spineLine * 0.50);
            float label = cover(boxSdf(p, vec4(book.x + 3.0, book.y + book.w * 0.21, max(book.z - 6.0, 1.0), 2.0), 0.3));
            paintOver(src, keep, vec3(0.615, 0.594, 0.458), label * 0.58);
            src += accent * label * 0.10;
        }
        // A light strip under the shelf lifts the spines from below.
        float shelfArea = cover(boxSdf(p, shelf, 2.0));
        float stripY = shelf.y + shelf.w - 1.0;
        src += accent * (cover(abs(p.y - stripY) - 0.6) * 0.42
            + exp(-max(stripY - p.y, 0.0) / 16.0) * step(p.y, stripY) * 0.10) * shelfArea;
        paintOver(src, keep, vec3(0.253, 0.265, 0.229), cover(boxSdf(p, vec4(body.x + 6.0, a.y - 9.0, body.z - 12.0, 5.0), 1.0)));
        float drawerSlot = cover(boxSdf(p, a, 8.0));
        paintOver(src, keep, vec3(0.031, 0.058, 0.067) + archiveOpen * vec3(0.018, 0.027, 0.024), drawerSlot);
        closedDrawer(src, keep, p, a, (1.0 - portalDocked) * (1.0 - archiveOpen));
        paintOver(src, keep, vec3(0.553, 0.526, 0.393), cover(boxSdf(p, vec4(a.x + 8.0, a.y + a.w + 4.0, a.z - 16.0, 1.0), 0.4)) * (0.23 + archiveOpen * 0.42));
        float lowerY = a.y + a.w + 12.0;
        paintOver(src, keep, oak(p, vec3(0.127, 0.136, 0.121)), cover(boxSdf(p, vec4(a.x, lowerY, a.z, max(bottom - lowerY - 9.0, 1.0)), 2.0)));
        paintOver(src, keep, vec3(0.057, 0.078, 0.077), cover(boxSdf(p, vec4(a.x + a.z * 0.5 - 0.5, lowerY, 1.0, max(bottom - lowerY - 8.0, 1.0)), 0.0)));
        paintOver(src, keep, vec3(0.327, 0.321, 0.254), cover(boxSdf(p, vec4(a.x + a.z * 0.5 - 15.0, lowerY + 6.0, 30.0, 1.5), 0.5)) * 0.60);
    }

    // A small refractor on a wooden tripod between the archive and the actor,
    // aimed at the moon. Each part is drawn in the tube's own frame and shaded
    // as a cylinder: the room's key light wraps over it, the sconce warms the
    // near side and the window behind leaves a cool upper rim. Wide layouts
    // only; the compact view gives this floor to the reader.
    if (size.x >= 1180.0 && archiveAnchor.z > 0.0 && avatarRect.z > 0.0) {
        vec2 plate = vec2(mix(archiveAnchor.x + archiveAnchor.z, avatarRect.x, 0.55), horizon - size.y * 0.165);
        // The tube balances above the mount head; u runs along the optical
        // axis toward the moon and v toward the tube's upper side.
        vec2 axisPoint = plate + vec2(-6.0, -33.0);
        vec2 aim = normalize(moon - axisPoint);
        vec2 up = vec2(aim.y, -aim.x);
        vec2 tq = vec2(dot(p - axisPoint, aim), dot(p - axisPoint, up));
        float warm = softOval(p, warmFixture, vec2(170.0, 205.0));
        vec2 rimDir = normalize(vec2(0.20, -0.98));
        float h;

        // A soft pool of occlusion under the tripod, then the legs: the rear
        // leg in shade, the accessory tray, and the two front legs.
        shade(src, keep, 1.0 - softOval(p, vec2(plate.x + 4.0, horizon + 58.0), vec2(70.0, 11.0)) * 0.22 * floorMask);
        vec2 hinges[3] = vec2[3](plate + vec2(-13.0, 3.0), plate + vec2(13.0, 3.0), plate + vec2(2.0, -1.0));
        vec2 feet[3] = vec2[3](vec2(plate.x - 58.0, horizon + 64.0), vec2(plate.x + 60.0, horizon + 68.0),
            vec2(plate.x + 4.0, horizon + 42.0));
        for (int k = 0; k < 3; ++k) {
            int i = k == 0 ? 2 : k - 1;
            bool rear = i == 2;
            if (k == 1) {
                vec2 ta = mix(hinges[0], feet[0], 0.50), tb = mix(hinges[1], feet[1], 0.50), tc = mix(hinges[2], feet[2], 0.50);
                float tray = triangleSdf(p, ta, tb, tc);
                paintOver(src, keep, oak(p, vec3(0.104, 0.093, 0.078)), cover(tray));
                paintOver(src, keep, vec3(0.300, 0.268, 0.214), cover(segment(p, ta, tb, h) - 0.7) * 0.75);
                vec2 trayCenter = (ta + tb + tc) / 3.0;
                for (int j = 0; j < 2; ++j) {
                    vec2 hole = trayCenter + vec2(j == 0 ? -9.0 : 7.0, 1.0);
                    paintOver(src, keep, vec3(0.300, 0.310, 0.300), cover(length((p - hole) * vec2(1.0, 2.2)) - 3.0));
                    paintOver(src, keep, vec3(0.040, 0.046, 0.050), cover(length((p - hole) * vec2(1.0, 2.2)) - 1.7));
                }
            }
            shade(src, keep, 1.0 - softOval(p, feet[i] + vec2(4.0, 2.0), vec2(11.0, 3.5)) * 0.42);
            float legDistance = segment(p, hinges[i], feet[i], h);
            float halfWidth = mix(rear ? 2.5 : 3.3, rear ? 1.6 : 2.1, h);
            vec2 along = normalize(feet[i] - hinges[i]);
            vec2 legNormal = vec2(-along.y, along.x);
            float across = dot(p - hinges[i], legNormal) / halfWidth;
            vec3 wood = oak(vec2(h * 220.0, across * 6.0), rear ? vec3(0.100, 0.086, 0.070) : vec3(0.190, 0.160, 0.124));
            wood = cylinderShade(wood, across, legNormal, light, rimDir, 0.12, warm * (rear ? 0.3 : 1.0));
            // A leg lock, a brass ferrule and a rubber tip.
            wood = mix(wood, vec3(0.110, 0.114, 0.118), step(0.55, h) * step(h, 0.58));
            wood = mix(wood, vec3(0.470, 0.420, 0.320) * (0.70 + 0.30 * clamp(across, 0.0, 1.0)), step(0.92, h) * step(h, 0.95));
            wood = mix(wood, vec3(0.046, 0.050, 0.054), step(0.95, h));
            float legCover = cover(legDistance - halfWidth - step(0.55, h) * step(h, 0.58) * 0.6);
            paintOver(src, keep, wood, legCover);
            paintOver(src, keep, vec3(0.120, 0.124, 0.128), cover(boxSdf(p, vec4(hinges[i] - vec2(3.5, 2.5), 7.0, 5.0), 1.0)));
        }
        // Top plate and alt-azimuth head with its clutch knob, slow-motion
        // cable and a status light.
        paintOver(src, keep, vec3(0.096, 0.102, 0.108), cover(boxSdf(p, vec4(plate.x - 17.0, plate.y, 34.0, 4.5), 1.0)));
        float plateTop = ovalSdf(p, plate, vec2(17.0, 4.5));
        paintOver(src, keep, vec3(0.170, 0.178, 0.184) + (1.0 - smoothstep(plate.y - 4.5, plate.y + 2.0, p.y)) * 0.05, cover(plateTop));
        vec2 head = axisPoint - up * 13.5;
        vec4 headBox = vec4(head.x - 12.0, head.y, 24.0, 17.0);
        vec3 headColor = vec3(0.150, 0.158, 0.164) + (1.0 - smoothstep(head.y, head.y + 5.0, p.y)) * 0.060
            + vec3(0.30, 0.19, 0.09) * warm * 0.06;
        headColor *= 0.82 + 0.18 * smoothstep(head.x + 12.0, head.x - 12.0, p.x);
        paintOver(src, keep, headColor, cover(boxSdf(p, headBox, 3.0)));
        float knob = length(p - vec2(head.x + 13.0, head.y + 6.5));
        paintOver(src, keep, vec3(0.470, 0.420, 0.320) * (0.80 + 0.35 * (1.0 - smoothstep(-4.0, 4.0, p.y - head.y - 6.5))), cover(knob - 4.3));
        paintOver(src, keep, vec3(0.080, 0.084, 0.088), cover(knob - 1.4));
        vec2 cableEnd = head + vec2(-23.0, 29.0);
        paintOver(src, keep, vec3(0.230, 0.238, 0.244), cover(segment(p, head + vec2(-9.0, 12.0), cableEnd, h) - 1.3));
        paintOver(src, keep, vec3(0.080, 0.086, 0.090), cover(length(p - cableEnd) - 2.8));
        paintOver(src, keep, vec3(0.300, 0.310, 0.315), cover(length(p - cableEnd + vec2(0.8, 0.9)) - 0.9) * 0.8);
        float led = length(p - head - vec2(-6.0, 5.0));
        src += accent * (cover(led - 1.1) * 0.85 + exp(-led / 4.0) * 0.06);

        // Dovetail bar on the mount head, joined to the tube by two ring feet.
        paintOver(src, keep, cylinderShade(vec3(0.150, 0.158, 0.165), (tq.y + 12.0) / 1.5, up, light, rimDir, 0.45, warm),
            cover(boxSdf(tq, vec4(-22.0, -13.5, 44.0, 3.0), 0.8)));
        for (int j = 0; j < 2; ++j) {
            float ringU = j == 0 ? -16.0 : 16.0;
            paintOver(src, keep, cylinderShade(vec3(0.210, 0.218, 0.222), 0.2, up, light, rimDir, 0.3, warm),
                cover(boxSdf(tq, vec4(ringU - 3.0, -11.0, 6.0, 4.0), 0.8)));
        }
        // Lacquered tube with a rear cell, a matte dew shield and a brass seam.
        vec3 lacquer = cylinderShade(vec3(0.072, 0.094, 0.108), tq.y / 8.0, up, light, rimDir, 0.35, warm);
        paintOver(src, keep, lacquer, cover(boxSdf(tq, vec4(-56.0, -8.0, 118.0, 16.0), 1.5)));
        paintOver(src, keep, cylinderShade(vec3(0.170, 0.178, 0.186), tq.y / 8.8, up, light, rimDir, 0.5, warm),
            cover(boxSdf(tq, vec4(-62.0, -8.8, 8.0, 17.6), 1.2)));
        paintOver(src, keep, cylinderShade(vec3(0.080, 0.102, 0.116), tq.y / 10.2, up, light, rimDir, 0.18, warm),
            cover(boxSdf(tq, vec4(58.0, -10.2, 42.0, 20.4), 1.6)));
        paintOver(src, keep, cylinderShade(vec3(0.440, 0.395, 0.300), tq.y / 10.6, up, light, rimDir, 0.6, warm),
            cover(boxSdf(tq, vec4(58.0, -10.6, 3.0, 21.2), 0.8)));
        paintOver(src, keep, cylinderShade(vec3(0.240, 0.250, 0.252), tq.y / 10.2, up, light, rimDir, 0.6, warm),
            cover(boxSdf(tq, vec4(98.0, -10.2, 2.0, 20.4), 0.6)));
        // Tube rings in satin metal.
        for (int j = 0; j < 2; ++j) {
            float ringU = j == 0 ? -16.0 : 16.0;
            paintOver(src, keep, cylinderShade(vec3(0.210, 0.218, 0.222), tq.y / 9.6, up, light, rimDir, 0.6, warm),
                cover(boxSdf(tq, vec4(ringU - 3.0, -9.6, 6.0, 19.2), 1.5)));
        }
        // Finder on two brackets.
        for (int j = 0; j < 2; ++j) {
            float postU = j == 0 ? -33.0 : -13.0;
            paintOver(src, keep, vec3(0.170, 0.176, 0.182), cover(boxSdf(tq, vec4(postU - 1.6, 7.5, 3.2, 6.0), 0.6)));
        }
        paintOver(src, keep, cylinderShade(vec3(0.064, 0.080, 0.090), (tq.y - 16.0) / 3.0, up, light, rimDir, 0.35, warm),
            cover(boxSdf(tq, vec4(-40.0, 13.0, 36.0, 6.0), 2.4)));
        paintOver(src, keep, vec3(0.230, 0.240, 0.244), cover(boxSdf(tq, vec4(-5.5, 12.6, 1.5, 6.8), 0.4)));
        // Focuser with a brass knob, a silver drawtube, a star diagonal and an
        // eyepiece turned up toward the observer.
        paintOver(src, keep, cylinderShade(vec3(0.098, 0.104, 0.110), tq.y / 5.4, up, light, rimDir, 0.4, warm),
            cover(boxSdf(tq, vec4(-76.0, -5.4, 14.0, 10.8), 1.0)));
        paintOver(src, keep, cylinderShade(vec3(0.470, 0.420, 0.320), (tq.y + 8.3) / 3.3, up, light, rimDir, 0.6, warm),
            cover(boxSdf(tq, vec4(-71.5, -11.6, 6.0, 6.6), 1.6)));
        paintOver(src, keep, cylinderShade(vec3(0.300, 0.308, 0.310), tq.y / 4.0, up, light, rimDir, 0.7, warm),
            cover(boxSdf(tq, vec4(-84.0, -4.0, 8.0, 8.0), 0.6)));
        paintOver(src, keep, cylinderShade(vec3(0.092, 0.098, 0.104), tq.y / 5.5, up, light, rimDir, 0.4, warm),
            cover(boxSdf(tq, vec4(-95.0, -5.0, 11.0, 11.0), 2.0)));
        paintOver(src, keep, cylinderShade(vec3(0.082, 0.088, 0.094), (tq.x + 89.0) / 4.0, aim, light, rimDir, 0.4, warm),
            cover(boxSdf(tq, vec4(-93.0, 6.0, 8.0, 12.0), 0.6)));
        paintOver(src, keep, vec3(0.300, 0.308, 0.310), cover(boxSdf(tq, vec4(-93.0, 6.0, 8.0, 1.6), 0.3)) * 0.85);
        paintOver(src, keep, cylinderShade(vec3(0.042, 0.046, 0.050), (tq.x + 89.0) / 5.0, aim, light, rimDir, 0.2, warm),
            cover(boxSdf(tq, vec4(-94.0, 17.0, 10.0, 6.0), 2.4)));
    }

    // Ground the avatar without baking character colors or a silhouette into
    // the scene. A broad penumbra and small contact core sit where the model's
    // base stands.
    if (avatarRect.z > 0.0 && avatarRect.w > 0.0) {
        vec2 feet = stageCenter;
        float visibility = clamp(avatarVisibility, 0.0, 1.0);
        float castShadow = softOval(p, feet + vec2(avatarRect.z * 0.14, 8.0),
            vec2(avatarRect.z * 0.40, max(15.0, avatarRect.w * 0.036)));
        float contact = softOval(p, feet, vec2(avatarRect.z * 0.16, 7.0));
        shade(src, keep, 1.0 - (castShadow * 0.26 + contact * 0.38) * visibility * floorMask);
    }

    // One curved near-field desk. Its rear edge stays below height-125, leaving
    // the director's character feet clear; joinery and reflected moonlight
    // distinguish the tabletop from a flat colored foreground rectangle.
    float deskTop = size.y - min(125.0, size.y * 0.145);
    vec2 deskCenter = vec2(size.x * 0.52, size.y + 96.0);
    vec2 deskRadii = vec2(size.x * 0.79, deskCenter.y - deskTop);
    float dd = ovalSdf(p, deskCenter, deskRadii);
    float deskMask = cover(dd);
    shade(src, keep, 1.0 - exp(-pow(max(dd, 0.0) / 19.0, 2.0)) * (1.0 - deskMask) * 0.25);
    float tabletopDepth = clamp((p.y - deskTop) / max(size.y - deskTop, 1.0), 0.0, 1.0);
    vec3 desk = oak(vec2(p.x * 0.8, p.y * 1.5),
        mix(vec3(0.190, 0.168, 0.142), vec3(0.090, 0.092, 0.092), tabletopDepth));
    desk += vec3(0.043, 0.064, 0.067) * softOval(p, vec2(size.x * 0.59, deskTop + 28.0), vec2(size.x * 0.28, 40.0));
    desk += vec3(0.037, 0.025, 0.012) * softOval(p, vec2(size.x * 0.17, deskTop + 37.0), vec2(size.x * 0.24, 47.0));
    paintOver(src, keep, desk, deskMask);
    paintOver(src, keep, vec3(0.075, 0.106, 0.117), band(dd, -5.0, 2.2) * deskMask * 0.58);
    paintOver(src, keep, vec3(0.360, 0.416, 0.405), band(dd, -0.65, 0.60) * deskMask * 0.67);
    // An inlaid light seam follows the desk's front curve.
    src += accent * (band(dd, -9.0, 0.45) * 0.26 + exp(-abs(dd + 9.0) / 6.0) * 0.025) * deskMask;

    // Mild corner falloff and deterministic fine grain unify the procedural
    // layers. This is spatial texture, never a time-dependent noise source.
    float vignette = dot((n - vec2(0.50, 0.47)) * vec2(0.90, 0.68),
        (n - vec2(0.50, 0.47)) * vec2(0.90, 0.68));
    shade(src, keep, 1.0 - vignette * 0.47);
    shade(src, keep, 1.0 - clamp(taskBlend, 0.0, 1.0) * 0.075 - clamp(readBlend, 0.0, 1.0) * 0.025);
    src += (hash12(floor(p * 1.2)) - 0.5) * 0.003;
    fragColor = vec4(max(src, vec3(0.0)), 1.0 - keep) * qt_Opacity;
}
