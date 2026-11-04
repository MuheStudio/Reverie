#pragma once

#include <QOpenGLFunctions>
#include <QSize>
#include <QVariantMap>
#include <array>

namespace HeaderFrameTiming::Detail {
// Check-only offscreen work. All GL calls go through the caller's bounded
// error recorder. No destructor issues GL calls or makes a context current.
struct GpuLoad {
    static constexpr int FragmentIterations = 64;
    static constexpr size_t LogCapacity = 1024;
    QSize size;
    GLuint program = 0, vertexShader = 0, fragmentShader = 0;
    GLuint buffer = 0, texture = 0, framebuffer = 0;
    GLint seedLocation = -1;
    bool initialized = false;
    GLint vertexCompileStatus = -1, fragmentCompileStatus = -1, programLinkStatus = -1;
    GLint vertexLogLength = -1, fragmentLogLength = -1, programLogLength = -1;
    GLsizei vertexLogWritten = -1, fragmentLogWritten = -1, programLogWritten = -1;
    std::array<GLchar, LogCapacity> vertexLog{}, fragmentLog{}, programLog{};

    struct Saved {
        GLint framebuffer = 0, viewport[4]{}, program = 0, buffer = 0, texture = 0;
        GLint blendSrcRgb = 0, blendDstRgb = 0, blendSrcAlpha = 0, blendDstAlpha = 0;
        GLint blendEquationRgb = 0, blendEquationAlpha = 0;
        GLint attribEnabled = 0, attribSize = 0, attribType = 0, attribNormalized = 0;
        GLint attribStride = 0, attribBuffer = 0;
        void *attribPointer = nullptr;
        GLboolean colorMask[4]{}, depth = false, stencil = false, scissor = false, cull = false, blend = false;
        GLfloat clearColor[4]{};
    };
    template<class Check> static bool save(QOpenGLFunctions *gl, Check &&check, Saved &s) {
        bool ok = true;
        const auto integer = [&](GLenum name, GLint *value) {
            ok = check("glGetIntegerv", [&] { gl->glGetIntegerv(name, value); }) && ok;
        };
        integer(GL_FRAMEBUFFER_BINDING, &s.framebuffer); integer(GL_VIEWPORT, s.viewport);
        integer(GL_CURRENT_PROGRAM, &s.program); integer(GL_ARRAY_BUFFER_BINDING, &s.buffer);
        integer(GL_TEXTURE_BINDING_2D, &s.texture);
        integer(GL_BLEND_SRC_RGB, &s.blendSrcRgb); integer(GL_BLEND_DST_RGB, &s.blendDstRgb);
        integer(GL_BLEND_SRC_ALPHA, &s.blendSrcAlpha); integer(GL_BLEND_DST_ALPHA, &s.blendDstAlpha);
        integer(GL_BLEND_EQUATION_RGB, &s.blendEquationRgb); integer(GL_BLEND_EQUATION_ALPHA, &s.blendEquationAlpha);
        const auto attribute = [&](GLenum name, GLint *value) {
            ok = check("glGetVertexAttribiv", [&] { gl->glGetVertexAttribiv(0, name, value); }) && ok;
        };
        attribute(GL_VERTEX_ATTRIB_ARRAY_ENABLED, &s.attribEnabled);
        attribute(GL_VERTEX_ATTRIB_ARRAY_SIZE, &s.attribSize);
        attribute(GL_VERTEX_ATTRIB_ARRAY_TYPE, &s.attribType);
        attribute(GL_VERTEX_ATTRIB_ARRAY_NORMALIZED, &s.attribNormalized);
        attribute(GL_VERTEX_ATTRIB_ARRAY_STRIDE, &s.attribStride);
        attribute(GL_VERTEX_ATTRIB_ARRAY_BUFFER_BINDING, &s.attribBuffer);
        ok = check("glGetVertexAttribPointerv", [&] { gl->glGetVertexAttribPointerv(0, GL_VERTEX_ATTRIB_ARRAY_POINTER, &s.attribPointer); }) && ok;
        ok = check("glGetBooleanv", [&] { gl->glGetBooleanv(GL_COLOR_WRITEMASK, s.colorMask); }) && ok;
        ok = check("glGetFloatv", [&] { gl->glGetFloatv(GL_COLOR_CLEAR_VALUE, s.clearColor); }) && ok;
        const auto enabled = [&](GLenum name, GLboolean &value) {
            ok = check("glIsEnabled", [&] { value = gl->glIsEnabled(name); }) && ok;
        };
        enabled(GL_DEPTH_TEST, s.depth); enabled(GL_STENCIL_TEST, s.stencil);
        enabled(GL_SCISSOR_TEST, s.scissor); enabled(GL_CULL_FACE, s.cull); enabled(GL_BLEND, s.blend);
        return ok;
    }
    template<class Check> static bool restore(QOpenGLFunctions *gl, Check &&check, const Saved &s) {
        bool ok = true;
        const auto run = [&](const char *name, auto &&fn) { ok = check(name, fn) && ok; };
        run("glBindFramebuffer", [&] { gl->glBindFramebuffer(GL_FRAMEBUFFER, GLuint(s.framebuffer)); });
        run("glViewport", [&] { gl->glViewport(s.viewport[0], s.viewport[1], s.viewport[2], s.viewport[3]); });
        run("glUseProgram", [&] { gl->glUseProgram(GLuint(s.program)); });
        run("glBindTexture", [&] { gl->glBindTexture(GL_TEXTURE_2D, GLuint(s.texture)); });
        run("glBindBuffer", [&] { gl->glBindBuffer(GL_ARRAY_BUFFER, GLuint(s.attribBuffer)); });
        run("glVertexAttribPointer", [&] { gl->glVertexAttribPointer(0, s.attribSize, GLenum(s.attribType), GLboolean(s.attribNormalized), s.attribStride, s.attribPointer); });
        if (s.attribEnabled) run("glEnableVertexAttribArray", [&] { gl->glEnableVertexAttribArray(0); });
        else run("glDisableVertexAttribArray", [&] { gl->glDisableVertexAttribArray(0); });
        run("glBindBuffer", [&] { gl->glBindBuffer(GL_ARRAY_BUFFER, GLuint(s.buffer)); });
        run("glBlendFuncSeparate", [&] { gl->glBlendFuncSeparate(GLenum(s.blendSrcRgb), GLenum(s.blendDstRgb), GLenum(s.blendSrcAlpha), GLenum(s.blendDstAlpha)); });
        run("glBlendEquationSeparate", [&] { gl->glBlendEquationSeparate(GLenum(s.blendEquationRgb), GLenum(s.blendEquationAlpha)); });
        run("glColorMask", [&] { gl->glColorMask(s.colorMask[0], s.colorMask[1], s.colorMask[2], s.colorMask[3]); });
        run("glClearColor", [&] { gl->glClearColor(s.clearColor[0], s.clearColor[1], s.clearColor[2], s.clearColor[3]); });
        const auto enable = [&](GLenum name, GLboolean value) {
            if (value) run("glEnable", [&] { gl->glEnable(name); });
            else run("glDisable", [&] { gl->glDisable(name); });
        };
        enable(GL_DEPTH_TEST, s.depth); enable(GL_STENCIL_TEST, s.stencil);
        enable(GL_SCISSOR_TEST, s.scissor); enable(GL_CULL_FACE, s.cull); enable(GL_BLEND, s.blend);
        return ok;
    }
    template<class Check> bool initialize(QOpenGLFunctions *gl, Check &&check) {
        Saved saved;
        if (!save(gl, check, saved)) return false;
        bool ok = true;
        const auto run = [&](const char *name, auto &&fn) { ok = check(name, fn) && ok; };
        static const char *vertexSource =
            "#version 120\nattribute vec2 position; varying vec2 uv;\n"
            "void main(){uv=position*0.5+0.5;gl_Position=vec4(position,0.0,1.0);}\n";
        static const char *fragmentSource =
            "#version 120\nuniform float seed; varying vec2 uv;\n"
            "void main(){vec3 v=vec3(uv,seed)*0.73+vec3(0.11,0.17,0.23);\n"
            "for(int i=0;i<64;++i){v=fract(v.yzx*vec3(1.61803,1.41421,1.73205)+v.zxy*0.03125+vec3(0.013,0.017,0.019));}\n"
            "gl_FragColor=vec4(v,0.5);}\n";
        run("glCreateShader", [&] { vertexShader = gl->glCreateShader(GL_VERTEX_SHADER); });
        run("glCreateShader", [&] { fragmentShader = gl->glCreateShader(GL_FRAGMENT_SHADER); });
        run("glShaderSource", [&] { gl->glShaderSource(vertexShader, 1, &vertexSource, nullptr); });
        run("glShaderSource", [&] { gl->glShaderSource(fragmentShader, 1, &fragmentSource, nullptr); });
        run("glCompileShader", [&] { gl->glCompileShader(vertexShader); });
        run("glCompileShader", [&] { gl->glCompileShader(fragmentShader); });
        run("glGetShaderiv", [&] { gl->glGetShaderiv(vertexShader, GL_COMPILE_STATUS, &vertexCompileStatus); });
        run("glGetShaderiv", [&] { gl->glGetShaderiv(fragmentShader, GL_COMPILE_STATUS, &fragmentCompileStatus); });
        run("glGetShaderiv", [&] { gl->glGetShaderiv(vertexShader, GL_INFO_LOG_LENGTH, &vertexLogLength); });
        run("glGetShaderiv", [&] { gl->glGetShaderiv(fragmentShader, GL_INFO_LOG_LENGTH, &fragmentLogLength); });
        run("glGetShaderInfoLog", [&] { gl->glGetShaderInfoLog(vertexShader, GLsizei(LogCapacity), &vertexLogWritten, vertexLog.data()); });
        run("glGetShaderInfoLog", [&] { gl->glGetShaderInfoLog(fragmentShader, GLsizei(LogCapacity), &fragmentLogWritten, fragmentLog.data()); });
        vertexLog.back() = fragmentLog.back() = '\0';
        ok = ok && vertexShader && fragmentShader && vertexCompileStatus == GL_TRUE && fragmentCompileStatus == GL_TRUE &&
            vertexLogLength >= 0 && fragmentLogLength >= 0 && vertexLogWritten >= 0 && fragmentLogWritten >= 0 &&
            size_t(vertexLogWritten) < LogCapacity && size_t(fragmentLogWritten) < LogCapacity;
        run("glCreateProgram", [&] { program = gl->glCreateProgram(); });
        run("glAttachShader", [&] { gl->glAttachShader(program, vertexShader); });
        run("glAttachShader", [&] { gl->glAttachShader(program, fragmentShader); });
        run("glBindAttribLocation", [&] { gl->glBindAttribLocation(program, 0, "position"); });
        run("glLinkProgram", [&] { gl->glLinkProgram(program); });
        run("glGetProgramiv", [&] { gl->glGetProgramiv(program, GL_LINK_STATUS, &programLinkStatus); });
        run("glGetProgramiv", [&] { gl->glGetProgramiv(program, GL_INFO_LOG_LENGTH, &programLogLength); });
        run("glGetProgramInfoLog", [&] { gl->glGetProgramInfoLog(program, GLsizei(LogCapacity), &programLogWritten, programLog.data()); });
        programLog.back() = '\0';
        run("glGetUniformLocation", [&] { seedLocation = gl->glGetUniformLocation(program, "seed"); });
        ok = ok && program && programLinkStatus == GL_TRUE && seedLocation >= 0 && programLogLength >= 0 &&
            programLogWritten >= 0 && size_t(programLogWritten) < LogCapacity;
        constexpr GLfloat vertices[] = {-1, -1, 3, -1, -1, 3};
        run("glGenBuffers", [&] { gl->glGenBuffers(1, &buffer); });
        run("glBindBuffer", [&] { gl->glBindBuffer(GL_ARRAY_BUFFER, buffer); });
        run("glBufferData", [&] { gl->glBufferData(GL_ARRAY_BUFFER, sizeof(vertices), vertices, GL_STATIC_DRAW); });
        run("glGenTextures", [&] { gl->glGenTextures(1, &texture); });
        run("glBindTexture", [&] { gl->glBindTexture(GL_TEXTURE_2D, texture); });
        run("glTexParameteri", [&] { gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_NEAREST); });
        run("glTexParameteri", [&] { gl->glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MAG_FILTER, GL_NEAREST); });
        run("glTexImage2D", [&] { gl->glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA, size.width(), size.height(), 0, GL_RGBA, GL_UNSIGNED_BYTE, nullptr); });
        run("glGenFramebuffers", [&] { gl->glGenFramebuffers(1, &framebuffer); });
        run("glBindFramebuffer", [&] { gl->glBindFramebuffer(GL_FRAMEBUFFER, framebuffer); });
        run("glFramebufferTexture2D", [&] { gl->glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, texture, 0); });
        GLenum status = 0;
        run("glCheckFramebufferStatus", [&] { status = gl->glCheckFramebufferStatus(GL_FRAMEBUFFER); });
        ok = ok && buffer && texture && framebuffer && status == GL_FRAMEBUFFER_COMPLETE;
        const bool restored = restore(gl, check, saved);
        initialized = ok && restored;
        return initialized;
    }
    template<class Check> int draw(QOpenGLFunctions *gl, Check &&check, int count) {
        if (!count) return 0;
        Saved saved;
        if (!initialized || !save(gl, check, saved)) return -1;
        bool ok = true;
        const auto run = [&](const char *name, auto &&fn) { ok = check(name, fn) && ok; };
        run("glBindFramebuffer", [&] { gl->glBindFramebuffer(GL_FRAMEBUFFER, framebuffer); });
        run("glViewport", [&] { gl->glViewport(0, 0, size.width(), size.height()); });
        run("glUseProgram", [&] { gl->glUseProgram(program); });
        run("glBindBuffer", [&] { gl->glBindBuffer(GL_ARRAY_BUFFER, buffer); });
        run("glEnableVertexAttribArray", [&] { gl->glEnableVertexAttribArray(0); });
        run("glVertexAttribPointer", [&] { gl->glVertexAttribPointer(0, 2, GL_FLOAT, GL_FALSE, 0, nullptr); });
        for (GLenum flag : {GL_DEPTH_TEST, GL_STENCIL_TEST, GL_SCISSOR_TEST, GL_CULL_FACE})
            run("glDisable", [&] { gl->glDisable(flag); });
        run("glEnable", [&] { gl->glEnable(GL_BLEND); });
        run("glBlendEquationSeparate", [&] { gl->glBlendEquationSeparate(GL_FUNC_ADD, GL_FUNC_ADD); });
        run("glBlendFuncSeparate", [&] { gl->glBlendFuncSeparate(GL_SRC_ALPHA, GL_ONE_MINUS_SRC_ALPHA, GL_ONE, GL_ONE_MINUS_SRC_ALPHA); });
        run("glColorMask", [&] { gl->glColorMask(GL_TRUE, GL_TRUE, GL_TRUE, GL_TRUE); });
        run("glClearColor", [&] { gl->glClearColor(0, 0, 0, 0); });
        run("glClear", [&] { gl->glClear(GL_COLOR_BUFFER_BIT); });
        int actual = 0;
        for (int i = 0; i < count && ok; ++i) {
            run("glUniform1f", [&] { gl->glUniform1f(seedLocation, GLfloat(i + 1) / 257.0f); });
            if (!ok) break;
            run("glDrawArrays", [&] { gl->glDrawArrays(GL_TRIANGLES, 0, 3); });
            if (ok) ++actual;
        }
        const bool restored = restore(gl, check, saved);
        return ok && restored ? actual : -1;
    }
    bool hasObjects() const { return program || vertexShader || fragmentShader || buffer || texture || framebuffer; }
    QVariantMap diagnostics() const {
        const auto log = [](GLint reported, GLsizei written, const std::array<GLchar, LogCapacity> &text) {
            return QVariantMap{{"reportedLength", reported}, {"writtenLength", written},
                {"text", QString::fromUtf8(text.data())}, {"truncated", reported > int(LogCapacity)},
                {"outputWritten", reported >= 0 && written >= 0 && size_t(written) < LogCapacity}};
        };
        return {{"vertexCompileStatus", vertexCompileStatus}, {"fragmentCompileStatus", fragmentCompileStatus},
            {"programLinkStatus", programLinkStatus}, {"logCapacityBytesEach", qulonglong(LogCapacity)},
            {"vertexLog", log(vertexLogLength, vertexLogWritten, vertexLog)},
            {"fragmentLog", log(fragmentLogLength, fragmentLogWritten, fragmentLog)},
            {"programLog", log(programLogLength, programLogWritten, programLog)},
            {"scope", "Bounded compiler/linker diagnostics for the fixed check-only GLSL sources. Raw status/log queries and GL errors are recorded during initialization outside sampled elapsed queries."}};
    }
    template<class Check> void release(QOpenGLFunctions *gl, Check &&check) {
        if (framebuffer) check("glDeleteFramebuffers", [&] { gl->glDeleteFramebuffers(1, &framebuffer); });
        if (texture) check("glDeleteTextures", [&] { gl->glDeleteTextures(1, &texture); });
        if (buffer) check("glDeleteBuffers", [&] { gl->glDeleteBuffers(1, &buffer); });
        if (program) check("glDeleteProgram", [&] { gl->glDeleteProgram(program); });
        if (vertexShader) check("glDeleteShader", [&] { gl->glDeleteShader(vertexShader); });
        if (fragmentShader) check("glDeleteShader", [&] { gl->glDeleteShader(fragmentShader); });
        abandon();
    }
    void abandon() {
        program = vertexShader = fragmentShader = buffer = texture = framebuffer = 0;
        initialized = false;
    }
};
}
