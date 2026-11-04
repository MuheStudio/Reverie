#version 440

// Shared separable Gaussian. sourceSize and blurRadiusPx are physical texture
// pixels; multiply logical dimensions/radius by DPR once in the compositor.
// Pass 1: blurDirection=(1,0). Pass 2: source=pass1, direction=(0,1).
// blurRadiusPx is the distance to the outermost tap, not a downsample factor.
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 sourceSize;
    vec2 blurDirection;
    float blurRadiusPx;
};
layout(binding = 1) uniform sampler2D source;

vec4 tap(vec2 uv) {
    return texture(source, clamp(uv, vec2(0.0), vec2(1.0)));
}
void main() {
    vec2 stepUv = blurDirection * max(blurRadiusPx, 0.0)
        / (max(sourceSize, vec2(1.0)) * 3.23076923);
    // Linear texture filtering joins neighboring Gaussian taps exactly; this
    // is five texture reads with the support of the original nine-tap kernel.
    vec4 color = tap(qt_TexCoord0) * 0.22702703;
    color += (tap(qt_TexCoord0 + stepUv * 1.38461538)
        + tap(qt_TexCoord0 - stepUv * 1.38461538)) * 0.31621622;
    color += (tap(qt_TexCoord0 + stepUv * 3.23076923)
        + tap(qt_TexCoord0 - stepUv * 3.23076923)) * 0.07027027;
    fragColor = color * qt_Opacity;
}
