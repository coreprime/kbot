// Shadow-map vertex shader.  Just transforms vertices into the light's
// clip space and forwards UVs so the fragment shader can alpha-test
// against the unit texture (otherwise transparent texels would cast
// solid shadows).

attribute vec3 aPos;
attribute vec2 aUV;
uniform mat4 uLightSpace;
uniform mat4 uWorld;
varying vec2 vUV;
void main() {
  vUV = aUV;
  gl_Position = uLightSpace * uWorld * vec4(aPos, 1.0);
}
