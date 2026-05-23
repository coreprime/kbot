// Wireframe vertex shader.  uPixelOffset jitters in NDC for the
// "fake-thick" wireframe (drawn multiple passes at different offsets).

attribute vec3 aPos;
uniform mat4 uProj;
uniform mat4 uView;
uniform mat4 uWorld;
uniform vec2 uPixelOffset; // NDC-space jitter for fake thick lines
void main() {
  vec4 p = uProj * uView * uWorld * vec4(aPos, 1.0);
  p.xy += uPixelOffset * p.w;
  gl_Position = p;
}
