#version 440

// Liquid glass for every scene surface: lens refraction through the shared
// scene capture, a rounded bevel, static frost, and an instrument edge whose
// light and corner glow follow the room's light. Material roles arrive
// through MaterialProfiles.

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 panelSize;
    vec2 sceneSize;
    vec2 sampleOrigin;
    vec2 sampleAxisX;
    vec2 sampleAxisY;
    float cornerRadius;
    float surfaceProgress;
    float interactionHover;
    float interactionPressed;
    float focusHighlight;
    vec4 profileOptics;
    vec4 profileEdge;
    vec4 materialTint;
    vec2 lightDirection;
    float settleEnergy;
};
layout(binding = 1) uniform sampler2D source;
layout(binding = 2) uniform sampler2D blurredSource;

const vec3 accent = vec3(0.45, 0.86, 0.83);

vec3 sharpColor(vec2 uv) {
    return texture(source, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}
vec3 softColor(vec2 uv) {
    return texture(blurredSource, clamp(uv, vec2(0.0), vec2(1.0))).rgb;
}

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

void main() {
    vec2 size = max(panelSize, vec2(1.0));
    vec2 p = qt_TexCoord0 * size;
    vec2 centered = p - size * 0.5;
    float radius = clamp(cornerRadius, 0.0, min(size.x, size.y) * 0.5);
    vec2 q = abs(centered) - (size * 0.5 - vec2(radius));
    float d = length(max(q, vec2(0.0)))
        + min(max(q.x, q.y), 0.0) - radius;
    vec2 radial = max(q, vec2(0.0));
    vec2 normal;
    if (length(radial) > 0.001)
        normal = normalize(radial) * sign(centered);
    else
        normal = q.x > q.y ? vec2(sign(centered.x), 0.0)
            : vec2(0.0, sign(centered.y));

    float energy = clamp(settleEnergy, -1.0, 1.0) * profileEdge.w;
    // A released object relaxes only at its perimeter. The UV affine basis
    // remains the exact pane-to-scene mapping, including ancestor transforms.
    d += energy * sin(qt_TexCoord0.x * 6.2831853)
        * exp(-abs(d) / 13.0) * normal.y * 0.75;
    float aa = max(fwidth(d), 0.35);
    float mask = 1.0 - smoothstep(-aa, aa, d);
    float inward = max(-d, 0.0);
    float edgeWidth = max(profileEdge.x, 1.0);
    float hover = clamp(interactionHover, 0.0, 1.0);
    float pressed = clamp(interactionPressed, 0.0, 1.0);
    float focus = clamp(focusHighlight, 0.0, 1.0);
    float lens = exp(-pow((inward - edgeWidth * 0.45) / (edgeWidth * 0.72), 2.0));
    lens *= 1.0 - smoothstep(edgeWidth * 1.8, edgeWidth * 3.0, inward);
    // A rounded bevel: its slope bends the scene more strongly at the rim.
    float bevel = 1.0 - smoothstep(0.0, max(edgeWidth * 2.6, 11.0), inward);

    vec2 uv = sampleOrigin + qt_TexCoord0.x * sampleAxisX
        + qt_TexCoord0.y * sampleAxisY;
    vec2 offset = normal * lens * profileOptics.w
        * (1.0 + energy * 0.35) * (1.0 - pressed * 0.22);
    offset += normal * bevel * bevel * profileOptics.w * 0.55 * (1.0 - pressed * 0.22);
    // Transform lens displacement through the same observed UV basis. No
    // screen-space shortcut, scale guess, or texture downsampling is involved.
    vec2 lensUv = sampleAxisX * (offset.x / size.x)
        + sampleAxisY * (offset.y / size.y);
    float blurMix = clamp(profileOptics.y, 0.0, 1.0);
    vec3 transmitted = mix(sharpColor(uv + lensUv), softColor(uv + lensUv), blurMix);
    // Dispersion is confined to the thick rim so native text above this shader
    // stays crisp and the reading profile never develops a shimmering center.
    vec3 edgeColor = vec3(sharpColor(uv + lensUv * 1.13).r,
        sharpColor(uv + lensUv).g, sharpColor(uv + lensUv * 0.88).b);
    transmitted = mix(transmitted, edgeColor, lens * (1.0 - blurMix * 0.5) * 0.45);

    float progress = clamp(surfaceProgress, 0.0, 1.0);
    float absorption = clamp(profileOptics.z + pressed * 0.045, 0.0, 0.94);
    vec3 ink = mix(transmitted * profileOptics.x, materialTint.rgb, absorption);
    // The perimeter catches the directed window light; the opposite face
    // carries a quiet warm bounce.
    vec2 light = lightDirection / max(length(lightDirection), 0.001);
    float facing = dot(normal, light);
    float lit = pow(max(facing, 0.0), 2.2);
    float bounce = pow(max(-facing, 0.0), 2.0);
    // The outer edge is lit rather than outlined: its light wraps around the
    // perimeter from the lit corner and fades smoothly on the far side, over a
    // profile a little softer than one device pixel. Hover and focus keep the
    // crisp line.
    float litWrap = pow(smoothstep(-0.55, 1.0, facing), 1.8);
    float rim = exp(-abs(d + aa * 0.6) / max(aa, 0.65));
    float softRim = exp(-abs(d + aa * 0.9) / max(aa * 1.9, 1.15));
    float projected = lens * bounce * 0.09 * (1.0 - blurMix * 0.5);
    ink *= 1.0 - projected;
    ink += softRim * (0.006 + litWrap * profileEdge.y * 0.42 * (1.0 - pressed * 0.45)) * vec3(0.85, 0.94, 0.92);
    ink += rim * (hover * 0.045 + focus * 0.27) * vec3(0.85, 0.94, 0.92);
    ink += softRim * bounce * 0.032 * vec3(0.86, 0.75, 0.61);
    // Broad lens sheen fades into the center instead of drawing a second line.
    ink += lens * lit * profileEdge.y * 0.032
        * (1.0 - pressed * 0.45) * vec3(0.76, 0.86, 0.84);
    float broadSheen = pow(max(1.0 - qt_TexCoord0.y, 0.0), 2.0)
        * (0.65 + qt_TexCoord0.x * 0.35);
    ink += broadSheen * profileEdge.z * (1.0 - pressed * 0.45)
        + hover * 0.006 * (1.0 - progress * 0.5);
    // Reading surfaces have a shallow lens; they get less grain and glow.
    float readingLike = 1.0 - smoothstep(0.5, 1.5, profileOptics.w);
    // The bevel catches the window light and shades its far side; a little
    // more light enters the top of the slab, and the lit corner glints.
    float bevelLit = pow(bevel, 2.2) * pow(max(dot(normal, light), 0.0), 2.0);
    float bevelShade = pow(bevel, 1.8) * pow(max(dot(normal, -light), 0.0), 1.6);
    ink *= 1.0 - bevelShade * 0.20 * (1.0 - blurMix * 0.3);
    ink += bevelLit * 0.15 * (1.0 - pressed * 0.45) * vec3(0.90, 0.97, 0.96);
    ink += (0.5 - qt_TexCoord0.y) * 0.014;
    vec2 litCorner = size * 0.5 + sign(light) * (size * 0.5 - vec2(radius * 0.62));
    float glint = exp(-pow(length(p - litCorner) / max(radius * 0.38, 2.0), 2.0)) * bevel;
    ink += glint * 0.06 * vec3(0.92, 0.98, 0.97);
    // Meniscus: light refracted into the slab just inside its upper edge.
    ink += exp(-inward / 5.0) * pow(max(-normal.y, 0.0), 1.5) * 0.050 * (1.0 - pressed * 0.45) * vec3(0.86, 0.95, 0.95);
    // Static frost: device-pixel grain and a soft veil, weaker for reading.
    float frost = blurMix * (1.0 - readingLike * 0.55);
    ink += (hash12(floor(p * 2.0)) - 0.5) * 0.012 * frost;
    ink += (noise(p / 38.0) - 0.5) * 0.010 * frost;
    // Instrument edge: a softened line of light inside the rim that follows
    // the same wrapped light; hover and focus draw the crisp hairline.
    float hairline = exp(-pow((d + 1.9) / 0.85, 2.0)) * 0.65;
    float crispHairline = exp(-pow((d + 1.7) / 0.55, 2.0));
    float glowLevel = 0.10 * (0.12 + 0.88 * litWrap) * (1.0 - readingLike * 0.6);
    ink += accent * (hairline * glowLevel + crispHairline * (hover * 0.18 + focus * 0.55)
        + exp(-inward / 12.0) * focus * 0.035);
    // Instrument corners: the line brightens where it turns the lit corner and
    // stays quiet at corners facing away from the light.
    vec2 fromEdges = size * 0.5 - abs(centered);
    float cornerZone = 1.0 - smoothstep(radius + 14.0, radius + 20.0, max(fromEdges.x, fromEdges.y));
    float cornerLight = smoothstep(-0.2, 0.95, dot(normalize(sign(centered) + vec2(0.0001)), light));
    ink += accent * hairline * cornerZone * (0.42 - readingLike * 0.22) * mix(0.12, 1.0, cornerLight);
    fragColor = vec4(ink * mask, mask) * qt_Opacity;
}
