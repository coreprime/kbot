// 4×4 matrix helpers — just enough to drive the ModelRenderer's MVP
// chain. Matrices are flat Float32Array(16) in column-major order so they
// can be uploaded straight to a WebGL uniform.  Functions mutate the
// destination matrix in-place so we never allocate per frame.
//
// This module is deliberately framework-free so the same code can later
// drive the map renderer / full-game scene without dragging Three.js or
// gl-matrix along.

export class Mat4 {
  static create() {
    return new Float32Array(16)
  }

  static identity(out) {
    out[0] = 1; out[1] = 0; out[2] = 0; out[3] = 0
    out[4] = 0; out[5] = 1; out[6] = 0; out[7] = 0
    out[8] = 0; out[9] = 0; out[10] = 1; out[11] = 0
    out[12] = 0; out[13] = 0; out[14] = 0; out[15] = 1
    return out
  }

  static copy(out, src) {
    for (let i = 0; i < 16; i++) out[i] = src[i]
    return out
  }

  // ortho fills `out` with a right-handed orthographic projection
  // matching WebGL's clip space (z ∈ [-1, 1]).  Used for the
  // directional light's view in shadow mapping.
  static ortho(out, left, right, bottom, top, near, far) {
    const lr = 1 / (left - right)
    const bt = 1 / (bottom - top)
    const nf = 1 / (near - far)
    out[0] = -2 * lr; out[1] = 0; out[2] = 0; out[3] = 0
    out[4] = 0; out[5] = -2 * bt; out[6] = 0; out[7] = 0
    out[8] = 0; out[9] = 0; out[10] = 2 * nf; out[11] = 0
    out[12] = (left + right) * lr
    out[13] = (top + bottom) * bt
    out[14] = (far + near) * nf
    out[15] = 1
    return out
  }

  // perspective fills `out` with a right-handed perspective projection
  // matching WebGL's clip space (z ∈ [-1, 1]).
  static perspective(out, fovY, aspect, near, far) {
    const f = 1 / Math.tan(fovY / 2)
    const nf = 1 / (near - far)
    out[0] = f / aspect; out[1] = 0; out[2] = 0; out[3] = 0
    out[4] = 0; out[5] = f; out[6] = 0; out[7] = 0
    out[8] = 0; out[9] = 0; out[10] = (far + near) * nf; out[11] = -1
    out[12] = 0; out[13] = 0; out[14] = 2 * far * near * nf; out[15] = 0
    return out
  }

  // lookAt: right-handed view matrix from camera position + target + up.
  static lookAt(out, eye, target, up) {
    const ex = eye[0], ey = eye[1], ez = eye[2]
    const tx = target[0], ty = target[1], tz = target[2]
    let fx = tx - ex, fy = ty - ey, fz = tz - ez
    let fl = Math.hypot(fx, fy, fz)
    if (fl > 0) { fx /= fl; fy /= fl; fz /= fl }
    let sx = fy * up[2] - fz * up[1]
    let sy = fz * up[0] - fx * up[2]
    let sz = fx * up[1] - fy * up[0]
    let sl = Math.hypot(sx, sy, sz)
    if (sl > 0) { sx /= sl; sy /= sl; sz /= sl }
    const ux = sy * fz - sz * fy
    const uy = sz * fx - sx * fz
    const uz = sx * fy - sy * fx
    out[0] = sx; out[1] = ux; out[2] = -fx; out[3] = 0
    out[4] = sy; out[5] = uy; out[6] = -fy; out[7] = 0
    out[8] = sz; out[9] = uz; out[10] = -fz; out[11] = 0
    out[12] = -(sx * ex + sy * ey + sz * ez)
    out[13] = -(ux * ex + uy * ey + uz * ez)
    out[14] = fx * ex + fy * ey + fz * ez
    out[15] = 1
    return out
  }

  // multiply: out = a * b (column-major; effectively "apply b, then a"
  // when read left-to-right in math notation).
  static multiply(out, a, b) {
    const a00 = a[0], a01 = a[1], a02 = a[2], a03 = a[3]
    const a10 = a[4], a11 = a[5], a12 = a[6], a13 = a[7]
    const a20 = a[8], a21 = a[9], a22 = a[10], a23 = a[11]
    const a30 = a[12], a31 = a[13], a32 = a[14], a33 = a[15]
    for (let i = 0; i < 4; i++) {
      const b0 = b[i * 4], b1 = b[i * 4 + 1], b2 = b[i * 4 + 2], b3 = b[i * 4 + 3]
      out[i * 4] = b0 * a00 + b1 * a10 + b2 * a20 + b3 * a30
      out[i * 4 + 1] = b0 * a01 + b1 * a11 + b2 * a21 + b3 * a31
      out[i * 4 + 2] = b0 * a02 + b1 * a12 + b2 * a22 + b3 * a32
      out[i * 4 + 3] = b0 * a03 + b1 * a13 + b2 * a23 + b3 * a33
    }
    return out
  }

  // invert: out = m^-1.  Cofactor-expansion implementation that
  // returns null for singular matrices (caller should fall back to
  // identity if it cares).  Used by the skybox shader to project
  // NDC fragments back into world view directions.
  static invert(out, m) {
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
    const a30 = m[12], a31 = m[13], a32 = m[14], a33 = m[15]
    const b00 = a00 * a11 - a01 * a10
    const b01 = a00 * a12 - a02 * a10
    const b02 = a00 * a13 - a03 * a10
    const b03 = a01 * a12 - a02 * a11
    const b04 = a01 * a13 - a03 * a11
    const b05 = a02 * a13 - a03 * a12
    const b06 = a20 * a31 - a21 * a30
    const b07 = a20 * a32 - a22 * a30
    const b08 = a20 * a33 - a23 * a30
    const b09 = a21 * a32 - a22 * a31
    const b10 = a21 * a33 - a23 * a31
    const b11 = a22 * a33 - a23 * a32
    let det = b00 * b11 - b01 * b10 + b02 * b09 + b03 * b08 - b04 * b07 + b05 * b06
    if (!det) return null
    det = 1.0 / det
    out[0]  = (a11 * b11 - a12 * b10 + a13 * b09) * det
    out[1]  = (a02 * b10 - a01 * b11 - a03 * b09) * det
    out[2]  = (a31 * b05 - a32 * b04 + a33 * b03) * det
    out[3]  = (a22 * b04 - a21 * b05 - a23 * b03) * det
    out[4]  = (a12 * b08 - a10 * b11 - a13 * b07) * det
    out[5]  = (a00 * b11 - a02 * b08 + a03 * b07) * det
    out[6]  = (a32 * b02 - a30 * b05 - a33 * b01) * det
    out[7]  = (a20 * b05 - a22 * b02 + a23 * b01) * det
    out[8]  = (a10 * b10 - a11 * b08 + a13 * b06) * det
    out[9]  = (a01 * b08 - a00 * b10 - a03 * b06) * det
    out[10] = (a30 * b04 - a31 * b02 + a33 * b00) * det
    out[11] = (a21 * b02 - a20 * b04 - a23 * b00) * det
    out[12] = (a11 * b07 - a10 * b09 - a12 * b06) * det
    out[13] = (a00 * b09 - a01 * b07 + a02 * b06) * det
    out[14] = (a31 * b01 - a30 * b03 - a32 * b00) * det
    out[15] = (a20 * b03 - a21 * b01 + a22 * b00) * det
    return out
  }

  static translate(out, m, x, y, z) {
    if (out !== m) Mat4.copy(out, m)
    out[12] = m[0] * x + m[4] * y + m[8] * z + m[12]
    out[13] = m[1] * x + m[5] * y + m[9] * z + m[13]
    out[14] = m[2] * x + m[6] * y + m[10] * z + m[14]
    out[15] = m[3] * x + m[7] * y + m[11] * z + m[15]
    return out
  }

  // scale applies a UNIFORM scale k to the basis columns of m (equivalent
  // to m * scaleMatrix(k)).  Uniform-only so normals stay valid under the
  // renderer's normal-matrix assumption (rigid + uniform transforms).
  static scale(out, m, k) {
    if (out !== m) Mat4.copy(out, m)
    for (let i = 0; i < 12; i++) out[i] *= k
    return out
  }

  static rotateX(out, m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad)
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
    if (out !== m) {
      out[0] = m[0]; out[1] = m[1]; out[2] = m[2]; out[3] = m[3]
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15]
    }
    out[4] = a10 * c + a20 * s
    out[5] = a11 * c + a21 * s
    out[6] = a12 * c + a22 * s
    out[7] = a13 * c + a23 * s
    out[8] = a20 * c - a10 * s
    out[9] = a21 * c - a11 * s
    out[10] = a22 * c - a12 * s
    out[11] = a23 * c - a13 * s
    return out
  }

  static rotateY(out, m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad)
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
    const a20 = m[8], a21 = m[9], a22 = m[10], a23 = m[11]
    if (out !== m) {
      out[4] = m[4]; out[5] = m[5]; out[6] = m[6]; out[7] = m[7]
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15]
    }
    out[0] = a00 * c - a20 * s
    out[1] = a01 * c - a21 * s
    out[2] = a02 * c - a22 * s
    out[3] = a03 * c - a23 * s
    out[8] = a00 * s + a20 * c
    out[9] = a01 * s + a21 * c
    out[10] = a02 * s + a22 * c
    out[11] = a03 * s + a23 * c
    return out
  }

  static rotateZ(out, m, rad) {
    const s = Math.sin(rad), c = Math.cos(rad)
    const a00 = m[0], a01 = m[1], a02 = m[2], a03 = m[3]
    const a10 = m[4], a11 = m[5], a12 = m[6], a13 = m[7]
    if (out !== m) {
      out[8] = m[8]; out[9] = m[9]; out[10] = m[10]; out[11] = m[11]
      out[12] = m[12]; out[13] = m[13]; out[14] = m[14]; out[15] = m[15]
    }
    out[0] = a00 * c + a10 * s
    out[1] = a01 * c + a11 * s
    out[2] = a02 * c + a12 * s
    out[3] = a03 * c + a13 * s
    out[4] = a10 * c - a00 * s
    out[5] = a11 * c - a01 * s
    out[6] = a12 * c - a02 * s
    out[7] = a13 * c - a03 * s
    return out
  }
}
