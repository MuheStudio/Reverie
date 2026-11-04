#version 440
layout(location = 0) in vec2 qt_TexCoord0;
layout(location = 0) out vec4 fragColor;
layout(std140, binding = 0) uniform buf {
    mat4 qt_Matrix; float qt_Opacity;
    vec2 surfaceOrigin; vec2 surfaceAxisX; vec2 surfaceAxisY; float surfaceOpacity;
};
layout(binding = 1) uniform sampler2D lowerSource;
layout(binding = 2) uniform sampler2D surfaceSource;
void main() {
    vec2 uv = surfaceOrigin + qt_TexCoord0.x * surfaceAxisX + qt_TexCoord0.y * surfaceAxisY;
    vec4 base = texture(lowerSource, qt_TexCoord0);
    float inside = step(0.0,uv.x)*step(0.0,uv.y)*step(uv.x,1.0)*step(uv.y,1.0);
    vec4 over = texture(surfaceSource, clamp(uv,vec2(0.0),vec2(1.0))) * inside * surfaceOpacity;
    fragColor = (over + base * (1.0-over.a)) * qt_Opacity;
}
