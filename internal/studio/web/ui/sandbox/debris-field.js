// debris-field.js
//
// Flying-polygon death debris for the sandbox pane, in the pane's own GL
// context. The deterministic sim reports a unit death; the scene forwards a
// death plan (severity → whether debris throws) and the killed unit's model,
// and this helper shatters that model into a shard cloud that scatters under
// gravity and settles on the terrain — TA's COB-EXPLODE debris look.
//
// It lives in the VIEW (not the scene) because building a shard mesh means
// uploading a VBO, which can only happen against this pane's GL context; the
// scene stays headless and merely emits the 'death' event that drives it. The
// shard geometry, burst velocities and settling physics all come from
// @coreprime/kbot-game3d's world-fx / debris-fragments modules, so the look
// matches the replayer's world driver.

import { Piece } from '@coreprime/kbot-game3d/piece'
import { Model } from '@coreprime/kbot-game3d/model'
import { fragmentGeometry, targetFragmentCount } from '@coreprime/kbot-game3d/debris-fragments'
import { debrisBurst, stepDebrisRecord } from '@coreprime/kbot-game3d/world-fx'
import { mulberry32, featureSeed } from '@coreprime/kbot-game3d/map-features'

// Debris record lifetime + fade window (ms) and a global piece cap so a
// wipe-out doesn't flood the shard budget — matching the world driver's caps.
const DEBRIS_LIFE_MS = 2600
const DEBRIS_FADE_MS = 420
const DEBRIS_MAX_PIECES = 1200

export class DebrisField {
  // gl        — the pane's WebGL context (world.gl), for shard VBO uploads.
  // heightAt  — (x,z) → terrain surface Y, so shards settle on the ground.
  constructor({ gl, heightAt = null } = {}) {
    this._gl = gl
    this._heightAt = typeof heightAt === 'function' ? heightAt : () => 0
    this._records = []
    this._seq = 0
  }

  // spawn shatters `model` (the killed unit's animated clone) at `pose`
  // ({x,y,z,headingRad}) into a shard cloud. severity scales the fragment
  // count; impactDir/impactMag bias the scatter away from the killing blow;
  // velocity is the unit's travel velocity at death (chunks inherit momentum).
  spawn(model, pose, { severity = 100, impactDir = null, impactMag = 0, velocity = null } = {}) {
    if (!model || !this._gl) return
    const id = ++this._seq
    const rng = mulberry32(featureSeed(String(id), Math.round(pose.x), Math.round(pose.z)))
    const radius = model.boundsRadius && model.boundsRadius > 0 ? model.boundsRadius : 24
    const count = targetFragmentCount(radius, severity)
    const shard = this._buildShardModel(model, count, rng)
    const flyModel = shard ? shard.model : model
    this._records.push({
      id,
      model: flyModel,
      shardVbo: shard ? shard.shardVbo : null,
      x: pose.x,
      y: pose.y,
      z: pose.z,
      headingRad: pose.headingRad || 0,
      pieces: debrisBurst(flyModel, { rng, impactDir, impactMag, headingRad: pose.headingRad || 0, velocity }),
      ageMs: 0,
      lifeMs: DEBRIS_LIFE_MS,
    })
  }

  // _buildShardModel fragments a source model's geometry into `count` chunks,
  // uploads them as one shared VBO, and wraps each chunk in a Piece so
  // debrisBurst can throw them independently. Mirrors the world driver's own
  // shard builder so the fragment look is identical.
  _buildShardModel(sourceModel, count, rng) {
    const gl = this._gl
    const geo = fragmentGeometry(sourceModel, { count, rng })
    if (!geo) return null
    const vbo = gl.createBuffer()
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo)
    gl.bufferData(gl.ARRAY_BUFFER, geo.floats, gl.STATIC_DRAW)
    const root = new Piece({ name: '__debris_root__' })
    for (const f of geo.fragments) {
      const p = new Piece({
        name: '__chunk__',
        originX: f.centroid[0],
        originY: f.centroid[1],
        originZ: f.centroid[2],
      })
      p.centroid = f.centroid
      const subs = Array.isArray(f.groups) && f.groups.length
        ? f.groups
        : [{ first: f.first, vertexCount: f.vertexCount, textureName: f.textureName, color: f.color, depthTier: f.depthTier || 0, isDecal: !!f.isDecal, synthetic: !!f.synthetic, specScale: f.specScale, runningLights: f.runningLights, bump: f.bump }]
      p.drawGroups = subs.map((sg) => {
        const group = {
          vbo,
          mode: gl.TRIANGLES,
          first: sg.first,
          vertexCount: sg.vertexCount,
          textureName: sg.textureName,
          color: sg.color,
          depthTier: sg.depthTier || 0,
          isDecal: !!sg.isDecal,
          synthetic: !!sg.synthetic,
        }
        if (sg.specScale != null) group.specScale = sg.specScale
        if (sg.runningLights != null) group.runningLights = sg.runningLights
        if (sg.bump != null) group.bump = sg.bump
        return group
      })
      root.addChild(p)
    }
    const model = new Model({ name: '__debris__', root, bounds: sourceModel.bounds })
    model.sharedVbo = vbo
    return { model, shardVbo: vbo }
  }

  // step ages every debris record by dtMs, advances the shard physics, trims
  // the oldest records early when the total piece count blows the budget, and
  // releases the VBO of any record that has faded out.
  step(dtMs) {
    if (!(dtMs > 0) || this._records.length === 0) return
    const recs = this._records
    let totalPieces = 0
    for (const d of recs) totalPieces += d.pieces.length
    if (totalPieces > DEBRIS_MAX_PIECES) {
      let excess = totalPieces - DEBRIS_MAX_PIECES
      for (const d of recs) {
        if (excess <= 0) break
        const remain = d.lifeMs - d.ageMs
        if (remain > DEBRIS_FADE_MS) {
          d.lifeMs = d.ageMs + DEBRIS_FADE_MS
          excess -= d.pieces.length
        }
      }
    }
    let w = 0
    for (const d of recs) {
      d.ageMs += dtMs
      if (d.ageMs >= d.lifeMs) {
        this._freeVbo(d)
        continue
      }
      stepDebrisRecord(d, dtMs, { heightAt: this._heightAt })
      recs[w++] = d
    }
    recs.length = w
  }

  // entities returns one renderer entity per live debris record: the shard
  // model at its record pose, fading over the last DEBRIS_FADE_MS via opacity
  // (buildFadeOnly = plain alpha fade, no wireframe build treatment).
  entities() {
    const out = []
    for (const d of this._records) {
      if (!d.model) continue
      const remain = d.lifeMs - d.ageMs
      const opacity = remain < DEBRIS_FADE_MS ? Math.max(0, remain / DEBRIS_FADE_MS) : 1
      out.push({
        model: d.model,
        transform: { x: d.x, y: d.y, z: d.z, headingRad: d.headingRad },
        opacity,
        buildFadeOnly: true,
      })
    }
    return out
  }

  _freeVbo(d) {
    if (d.shardVbo && this._gl) {
      try { this._gl.deleteBuffer(d.shardVbo) } catch { /* context may be lost */ }
      d.shardVbo = null
    }
  }

  clear() {
    for (const d of this._records) this._freeVbo(d)
    this._records.length = 0
  }
}
