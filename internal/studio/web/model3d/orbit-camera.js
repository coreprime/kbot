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

  updateMatrices(aspect, near, far) {
    Mat4.perspective(this.projMatrix, this.fov, aspect, near, far)
    const cosP = Math.cos(this.pitch), sinP = Math.sin(this.pitch)
    const cosY = Math.cos(this.yaw), sinY = Math.sin(this.yaw)
    const ex = this.target[0] + this.distance * sinY * cosP
    const ey = this.target[1] + this.distance * sinP
    const ez = this.target[2] + this.distance * cosY * cosP
    this.eye[0] = ex; this.eye[1] = ey; this.eye[2] = ez
    Mat4.lookAt(this.viewMatrix, this.eye, this.target, [0, 1, 0])
  }
}
