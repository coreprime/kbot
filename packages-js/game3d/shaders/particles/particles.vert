// Particle vertex shader.  Each particle is one GL_POINTS vertex
// carrying world position + per-instance colour + size.  The
// fragment shader fades the point into a soft round splat so the
// raw square-point sprites the GL_POINTS API gives us read as
// volumetric puffs rather than pixel art.

attribute vec3 aPos;     // world position
attribute vec4 aColor;   // rgba (alpha = current life fade)
attribute float aSize;   // pixel size at the canvas

uniform mat4 uProj;
uniform mat4 uView;
uniform vec2 uViewport; // for size scaling against distance

varying vec4 vColor;

#include "../lib/logdepth.glsl"

void main() {
  vec4 worldPos = vec4(aPos, 1.0);
  vec4 viewPos = uView * worldPos;
  gl_Position = uProj * viewPos;
  // Match the scene depth buffer, which the ground + unit passes fill with
  // LOGARITHMIC depth (gl_FragDepthEXT = log2(w+1)·…).  Without this the
  // particle pass writes plain perspective depth (~0.99 for anything past a
  // few wu), which loses the LEQUAL test against the terrain's much smaller
  // log-depth value — so every mote is depth-culled behind the ground and the
  // nanolathe stream (and other ground-level SFX) never draws.  logDepthVertex
  // carries w to the fragment stage; the frag shader writes the log depth.
  logDepthVertex();
  // Perspective-correct point sizing: a particle with aSize=4 wu at
  // 1 wu from camera should fill 4 pixels; same particle at 100 wu
  // away shrinks to ~0.04 px.  Without this, every particle would
  // be the same on-screen size and distant smoke would dominate.
  float dist = max(0.5, -viewPos.z);
  gl_PointSize = clamp(aSize * uViewport.y / (dist * 0.6), 1.0, 64.0);
  vColor = aColor;
}
