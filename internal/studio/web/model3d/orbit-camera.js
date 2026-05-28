// OrbitCamera — spherical-coordinate camera that orbits around a target
// point.  Drag-to-rotate, wheel-to-zoom, right-drag to pan.  Pure model:
// it owns no DOM and emits no events; the ModelViewer wires pointer
// events through to the move* methods.

import { Mat4 } from './mat4.js'

const DEG2RAD = Math.PI / 180

export class OrbitCamera {
  constructor({ target = [0, 0, 0], distance = 100, yawDeg = 35, pitchDeg = 18, fovDeg = 35 } = {}) {
    this.target = [...target]
    this.distance = distance
    this.yaw = yawDeg * DEG2RAD
    this.pitch = pitchDeg * DEG2RAD
    this.fov = fovDeg * DEG2RAD
    this.minDistance = 0.5
    this.maxDistance = 5000
    this.minPitch = (-89.5) * DEG2RAD
    this.maxPitch = (89.5) * DEG2RAD
    this.viewMatrix = Mat4.identity(Mat4.create())
    this.projMatrix = Mat4.identity(Mat4.create())
    this.eye = [0, 0, 0]
    // Tracked target — a reference (anything with a `pos` + `model`
    // shape) the camera locks its `target` onto each frame.  Set via
    // setTrackedTarget(...); cleared with null.  `trackedName` is
    // exposed for the Renderer panel's "Following: ..." readout so
    // the UI doesn't have to peek inside the ref.
    this.trackedTarget = null
    this.trackedName = null
  }

  // setTrackedTarget locks the camera's target onto a unit.  Each
  // frame applyTracking() reads .pos + .model.bounds off the ref and
  // pulls the camera target to the unit's CENTRE OF MASS — the
  // model's bounding-box midpoint translated by the unit position —
  // so the camera frames the unit's silhouette rather than its
  // origin pivot (which for kbots is usually at the feet, leaving
  // the camera staring at empty air just above the ground).  Pass
  // null to clear.  `name` is purely cosmetic — surfaces in the
  // Renderer panel as "Following: <name>".
  setTrackedTarget(ref, name = null) {
    this.trackedTarget = ref || null
    this.trackedName = ref ? (name || (ref.name ?? null)) : null
  }

  // advanceTrackedTarget cycles the tracked target through an ordered
  // list of refs.  Used by hosts to wire a single hotkey (T) into a
  // "press to track, press again to advance, press past the end to
  // untrack" UX over whatever the host considers a selection.
  //
  // Behaviour matrix:
  //   - empty refs               → untrack, return null
  //   - not tracking / off-list  → track refs[0]
  //   - tracking refs[i]         → track refs[i + 1]
  //   - tracking refs[last]      → untrack
  //
  // `nameFn(ref)` is invoked to derive the cosmetic name passed to
  // setTrackedTarget — hosts use it to inject "Unit 17"-style labels
  // when the ref itself doesn't carry a human-readable name.  When
  // omitted the existing setTrackedTarget name fallback applies.
  //
  // Returns the ref that's now tracked (or null when untracked) so
  // the host can drive its own status text without re-reading the
  // camera state.
  advanceTrackedTarget(refs, nameFn = null) {
    if (!Array.isArray(refs) || refs.length === 0) {
      this.setTrackedTarget(null)
      return null
    }
    const cur = this.trackedTarget
    const idx = cur ? refs.indexOf(cur) : -1
    if (idx < 0) {
      const next = refs[0]
      this.setTrackedTarget(next, nameFn ? nameFn(next) : null)
      return next
    }
    if (idx >= refs.length - 1) {
      this.setTrackedTarget(null)
      return null
    }
    const next = refs[idx + 1]
    this.setTrackedTarget(next, nameFn ? nameFn(next) : null)
    return next
  }

  // applyTracking pulls the camera target onto the tracked unit's
  // centre of mass for THIS frame.  Cheap — three vector adds — so
  // call it once per render frame from the view's onAfterFrame
  // hook.  No-op when nothing's tracked.
  applyTracking() {
    const t = this.trackedTarget
    if (!t) return
    // Tolerate refs that aren't laid out exactly the way a
    // UnitInstance is — fall back to the unit
    // pos when bounds aren't available, fall back to origin when
    // pos is missing too.  Keeps the camera following SOMETHING
    // sensible even with weird refs (e.g. between model load and
    // first Create-script tick).
    const px = (t.pos && Number.isFinite(t.pos.x)) ? t.pos.x : 0
    const py = (t.pos && Number.isFinite(t.pos.y)) ? t.pos.y : 0
    const pz = (t.pos && Number.isFinite(t.pos.z)) ? t.pos.z : 0
    let cx = 0, cy = 0, cz = 0
    const m = t.model
    if (m && m.bounds) {
      cx = (m.bounds.min[0] + m.bounds.max[0]) * 0.5
      cy = (m.bounds.min[1] + m.bounds.max[1]) * 0.5
      cz = (m.bounds.min[2] + m.bounds.max[2]) * 0.5
    }
    this.target[0] = px + cx
    this.target[1] = py + cy
    this.target[2] = pz + cz
  }

  // frameBounds positions the camera so the given min/max box fills
  // most of the view.  Targets the bounding-box centroid directly —
  // the visual mass of TA units sits roughly at the geometric
  // centre once the scene's ground plane is in play (the legs no
  // longer dangle into empty space; the ground catches the eye).
  frameBounds(min, max, paddingFactor = 1.5) {
    const cx = (min[0] + max[0]) * 0.5
    const cy = (min[1] + max[1]) * 0.5
    const cz = (min[2] + max[2]) * 0.5
    this.target = [cx, cy, cz]
    const dx = max[0] - min[0]
    const dy = max[1] - min[1]
    const dz = max[2] - min[2]
    // Use the LARGEST extent (not the diagonal radius) so wide-but-
    // shallow units like buildings don't get framed too tight: the
    // diagonal-radius approach over-distances units that are short
    // and squat.
    const halfExtent = 0.5 * Math.max(dx, dy, dz, 4)
    const fitH = halfExtent / Math.tan(this.fov / 2)
    this.distance = Math.max(this.minDistance, fitH * paddingFactor)
  }

  rotateBy(dxDeg, dyDeg) {
    this.yaw += dxDeg * DEG2RAD
    this.pitch += dyDeg * DEG2RAD
    if (this.pitch < this.minPitch) this.pitch = this.minPitch
    if (this.pitch > this.maxPitch) this.pitch = this.maxPitch
  }

  zoomBy(factor) {
    this.distance *= factor
    if (this.distance < this.minDistance) this.distance = this.minDistance
    if (this.distance > this.maxDistance) this.distance = this.maxDistance
  }

  panBy(dx, dy) {
    // Move target along camera-relative right/up vectors so the pan feels
    // natural at any orbit angle.  Scaled by distance so the pan rate
    // matches the visible motion of the scene.
    const speed = this.distance * 0.0025
    const yaw = this.yaw, pitch = this.pitch
    const cosY = Math.cos(yaw), sinY = Math.sin(yaw)
    const cosP = Math.cos(pitch), sinP = Math.sin(pitch)
    // Forward (camera → target).
    const fx = -sinY * cosP, fy = sinP, fz = -cosY * cosP
    // Right = forward × world-up.
    let rx = fz, ry = 0, rz = -fx
    const rl = Math.hypot(rx, ry, rz) || 1
    rx /= rl; ry /= rl; rz /= rl
    // Up = right × forward.
    const ux = ry * fz - rz * fy
    const uy = rz * fx - rx * fz
    const uz = rx * fy - ry * fx
    this.target[0] -= (rx * dx - ux * dy) * speed
    this.target[1] -= (ry * dx - uy * dy) * speed
    this.target[2] -= (rz * dx - uz * dy) * speed
  }

  // panAlongGround moves the camera target across the ground plane
  // (y constant) using the camera's HEADING — the camera's forward
  // direction projected to the ground.  Unlike panBy, this ignores
  // pitch, so a top-down view doesn't make "forward" collapse to
  // zero.  Used for ctrl-drag: drag-down advances the camera in its
  // facing direction (camera looks north → drag down goes north),
  // drag-right strafes east relative to facing.
  panAlongGround(dx, dy) {
    // Speed scales with distance so the pan rate matches the visible
    // scene scale at any zoom level.
    const speed = this.distance * 0.0025
    const yaw = this.yaw
    const sinY = Math.sin(yaw)
    const cosY = Math.cos(yaw)
    // Camera's ground-projected forward (look-at direction with
    // y-component dropped + renormalised on XZ).  Looking north (yaw
    // such that -cosY is the dominant component) the forward vector
    // points +Z... actually with the renderer's convention
    // (target.x = target + dist*sinY, target.z = target + dist*cosY)
    // the camera sits at (+sinY, +cosY) relative to target, so the
    // camera-to-target vector is (-sinY, 0, -cosY).  Drag-down (dy>0)
    // should advance the camera, so we move the TARGET further along
    // that forward direction (target moves away, camera follows).
    const fx = -sinY
    const fz = -cosY
    // Ground-plane right = forward × world-up (-Y handedness fix).
    // For forward (-sinY, 0, -cosY) and up (0,1,0): right is
    // (-cosY, 0, sinY).  Drag-right (dx>0) strafes camera east of
    // facing → target moves in -right direction.
    const rx = -cosY
    const rz =  sinY
    this.target[0] += (fx * dy - rx * dx) * speed
    this.target[2] += (fz * dy - rz * dx) * speed
  }

  updateMatrices(aspect, near, far) {
    Mat4.perspective(this.projMatrix, this.fov, aspect, near, far)
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch)
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw)
    const ex = this.target[0] + this.distance * sinY * cosP
    const ey = this.target[1] + this.distance * sinP
    const ez = this.target[2] + this.distance * cosY * cosP
    this.eye[0] = ex; this.eye[1] = ey; this.eye[2] = ez
    Mat4.lookAt(this.viewMatrix, this.eye, this.target, [0, 1, 0])
    // Invalidate the cached inv-view-proj so the next caller
    // (screen-to-ground unprojection) recomputes against the fresh
    // view/proj matrices.
    this._invViewProjDirty = true
    // Refresh the world-space frustum planes for this frame.  The
    // renderer reads `frustumPlanes` per entity for the cull gate
    // (Phase 1) — extracting them once here is cheaper than redoing
    // the matrix multiply per entity.
    if (!this._viewProjFrustum) this._viewProjFrustum = Mat4.create()
    Mat4.multiply(this._viewProjFrustum, this.projMatrix, this.viewMatrix)
    this.frustumPlanes = _extractFrustumPlanes(this._viewProjFrustum, this.frustumPlanes)
    // tan(fov/2) cached for Phase 2's projected-pixel-radius formula
    // (constant per frame because the camera's fov doesn't change
    // mid-update).
    this.halfFovTan = Math.tan(this.fov * 0.5)
  }

  // invViewProj returns the inverse of (proj * view) — used to
  // unproject a screen-space click into a world-space ray for ground
  // intersection.  Cached and recomputed only when updateMatrices
  // marks the cache dirty so we don't redo the 4x4 multiply + invert
  // on every pointer event.
  invViewProj() {
    if (!this._invViewProj) this._invViewProj = Mat4.create()
    if (!this._viewProj) this._viewProj = Mat4.create()
    if (this._invViewProjDirty || !this._invViewProjValid) {
      Mat4.multiply(this._viewProj, this.projMatrix, this.viewMatrix)
      const ok = Mat4.invert(this._invViewProj, this._viewProj)
      this._invViewProjValid = !!ok
      this._invViewProjDirty = false
    }
    return this._invViewProjValid ? this._invViewProj : null
  }

  // sphereInFrustum tests a world-space bounding sphere against the
  // six camera-frustum planes computed in updateMatrices.  Returns
  // false when the sphere is fully outside ANY plane (cull); true
  // otherwise (visible or straddling — caller renders it).  Cheap:
  // six dot products + six compares; safe to call once per entity per
  // frame for thousands of entities.
  sphereInFrustum(cx, cy, cz, r) {
    const planes = this.frustumPlanes
    if (!planes) return true
    // Iterate the six planes (left, right, bottom, top, near, far).
    // Each plane stored as 4 floats: (a, b, c, d) with the plane
    // equation a·x + b·y + c·z + d = 0; the normal (a, b, c) points
    // INTO the frustum, so a positive signed distance means inside.
    for (let i = 0; i < 6; i++) {
      const o = i * 4
      const d = planes[o] * cx + planes[o + 1] * cy + planes[o + 2] * cz + planes[o + 3]
      if (d < -r) return false
    }
    return true
  }
}

// _extractFrustumPlanes pulls the six world-space frustum planes from
// the combined view-projection matrix using Gribb & Hartmann's row-
// extraction trick.  `m` is in column-major order (gl-matrix style:
// m[0..3] = column 0).  Each plane is stored as 4 consecutive floats
// (nx, ny, nz, d) with the normal pointing INTO the frustum so a
// positive signed distance means inside.  Normals are normalised so
// the caller can use the plane equation directly as a signed-distance
// test against a world-space point or sphere.
//
// Output order: left, right, bottom, top, near, far.
function _extractFrustumPlanes(m, out) {
  const o = out || new Float32Array(24)
  // Column-major indexing helpers — m00 = m[0], m10 = m[1], etc.
  const m00 = m[0],  m10 = m[1],  m20 = m[2],  m30 = m[3]
  const m01 = m[4],  m11 = m[5],  m21 = m[6],  m31 = m[7]
  const m02 = m[8],  m12 = m[9],  m22 = m[10], m32 = m[11]
  const m03 = m[12], m13 = m[13], m23 = m[14], m33 = m[15]
  // Left = row3 + row0;  Right = row3 - row0
  // Bottom = row3 + row1; Top = row3 - row1
  // Near = row3 + row2;  Far = row3 - row2
  // Row i in column-major is (m0i, m1i, m2i, m3i).
  // Six (a, b, c, d) tuples, written out for clarity.
  _setPlane(o,  0, m30 + m00, m31 + m01, m32 + m02, m33 + m03) // left
  _setPlane(o,  4, m30 - m00, m31 - m01, m32 - m02, m33 - m03) // right
  _setPlane(o,  8, m30 + m10, m31 + m11, m32 + m12, m33 + m13) // bottom
  _setPlane(o, 12, m30 - m10, m31 - m11, m32 - m12, m33 - m13) // top
  _setPlane(o, 16, m30 + m20, m31 + m21, m32 + m22, m33 + m23) // near
  _setPlane(o, 20, m30 - m20, m31 - m21, m32 - m22, m33 - m23) // far
  return o
}

function _setPlane(out, off, a, b, c, d) {
  const inv = 1 / Math.max(1e-12, Math.hypot(a, b, c))
  out[off]     = a * inv
  out[off + 1] = b * inv
  out[off + 2] = c * inv
  out[off + 3] = d * inv
}
