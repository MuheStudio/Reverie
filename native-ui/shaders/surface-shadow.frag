#version 440

layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix;
    float qt_Opacity;
    vec2 panelSize;
    vec2 lightDirection;
    float cornerRadius;
    float shadowExtent;
    float shadowOpacity;
};

void main() {
    vec2 size = max(panelSize, vec2(1.0));
    vec2 p = qt_TexCoord0 * (size + vec2(shadowExtent * 2.0))
        - vec2(shadowExtent);
    vec2 light = lightDirection / max(length(lightDirection), 0.001);
    vec2 center = p - size * 0.5 + light * 6.0;
    float radius = clamp(cornerRadius, 0.0, min(size.x, size.y) * 0.5);
    vec2 q = abs(center) - (size * 0.5 - vec2(radius));
    float d = length(max(q, vec2(0.0)))
        + min(max(q.x, q.y), 0.0) - radius;
    float soft = exp(-max(d, 0.0) * max(d, 0.0) / 105.0);
    // Keep the shadow on its receiver rather than darkening the entire body.
    vec2 bodyQ = abs(p - size * 0.5) - (size * 0.5 - vec2(radius));
    float bodyD = length(max(bodyQ, vec2(0.0)))
        + min(max(bodyQ.x, bodyQ.y), 0.0) - radius;
    float outside = smoothstep(-1.0, 1.0, bodyD);
    float alpha = soft * outside * shadowOpacity;
    fragColor = vec4(vec3(0.006, 0.012, 0.016) * alpha, alpha) * qt_Opacity;
}
