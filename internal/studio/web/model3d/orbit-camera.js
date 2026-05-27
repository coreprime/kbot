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

  // applyTracking pulls the camera target onto the tracked unit's
  // centre of mass for THIS frame.  Cheap — three vector adds — so
  // call it once per render frame from the view's onAfterFrame
  // hook.  No-op when nothing's tracked.
  applyTracking() {
    const t = this.trackedTarget
    if (!t) return
    // Tolerate refs that aren't laid out exactly the way the
    // single-unit / sandbox UnitInstance is — fall back to the unit
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
  // centre once the viewer's ground plane is in play (the legs no
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
  // zero.  Used for ctrl-drag in the viewer: drag-down advances the
  // camera in its facing direction (camera looks north → drag down
  // goes north), drag-right strafes east relative to facing.
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
    // (sandbox screen-to-ground) recomputes against the fresh
    // view/proj matrices.
    this._invViewProjDirty = true
  }

  // invViewProj returns the inverse of (proj * view) — used by the
  // sandbox to unproject a screen-space click into a world-space ray
  // for ground intersection.  Cached and recomputed only when
  // updateMatrices marks the cache dirty so we don't redo the 4x4
  // multiply + invert on every pointer event.
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
}
