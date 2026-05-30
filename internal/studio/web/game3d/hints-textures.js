// hints-textures.js
//
// Per-texture rendering "hints" — material metadata the renderer uses to
// give certain surfaces extra treatment beyond their flat albedo.  This
// is the single place that owns "what is this surface made of, and how
// should it render" so the model loader + renderer stay generic.
//
// Today it drives the specular ("Surface Hints" graphics option): tiles
// whose name reads as bare metal or faction hull plating get a sharper,
// stronger Blinn-Phong sheen.  The hint shape is intentionally open so we
// can layer on more material hints later WITHOUT touching the loader or
// renderer plumbing — only this file:
//
//   specular      { metallic, scale }                 — sheen boost   (LIVE)
//   runningLights { blink, emit, fade, minNeighbors } — colour-keyed blinking
//                   status lights that glow (and bloom into the scene).
//                   `fade` (0..1) is the faded-out floor as a fraction of the
//                   lit surface colour — 0.85 keeps the dim phase close to the
//                   original so the pulse-down doesn't show hard edges.
//                   `minNeighbors` (0..8) is the continuity filter: a lamp
//                   texel needs that many keyed 8-neighbours to count — 1
//                   rejects lone grain specks but keeps small dots; 0 keys
//                   every saturated pixel (use for sparse single-pixel lamps).
//                   (LIVE)
//   bump          { generate, intensity, smooth }      — derive a normal from
//                   the tile's luminance gradient for surface relief.
//                   `smooth` (texels) low-passes the height field first so a
//                   noisy/rough texture only bumps on its LARGE features, not
//                   every speckle (≈ desaturate + blur).                (LIVE)
//   emissive      { color: [r, g, b], strength }       — make the whole tile
//                   glow / cast a colour                            (planned)
//
// ── How matching works ────────────────────────────────────────────────
// TA stores unit skins as named tiles inside shared texture sheets
// (GAFs).  A 3DO primitive references the tile NAME, and that name is all
// the model loader sees — so hints are matched against the tile name.
//
// TEXTURE_HINTS is keyed by GAF / logical-group name (the key is purely
// organisational — group related tiles however reads clearest).  Each
// group declares which tile names it covers and the hints to apply:
//
//   "somefile.gaf": {
//     match:    /regex/i,            // tile names this group covers
//     defaults: { specular: {…} },   // applied to every covered tile
//     tiles: {                       // optional per-sub-texture overrides
//       "TileName": { specular: {…}, emissive: {…} },
//     },
//   }
//
// resolveTextureHints(name) returns the merged hint block:
//   DEFAULT_HINTS  ◅  group.defaults  ◅  group.tiles[name]
// (right-most wins, merged per sub-section).  The first group whose
// match/tiles covers the name supplies the defaults; an exact tile entry
// refines on top.

// METAL_SPEC_SCALE — how much sharper/brighter a metal-tagged surface's
// specular reads vs a painted one.  Owned here (not the renderer) so the
// whole "what's shiny, and how shiny" decision lives in one file.
export const METAL_SPEC_SCALE = 3.0

// DEFAULT_HINTS — the at-rest treatment for an untagged surface: a plain
// painted panel.  No metal boost, no generated bump, no glow.
export const DEFAULT_HINTS = Object.freeze({
  specular: Object.freeze({ metallic: false, scale: 1.0 }),
  runningLights: null,
  bump: null,
  emissive: null,
})

// TEXTURE_HINTS — edit here to retune what counts as shiny, add per-tile
// overrides, or (later) flag bump / emissive tiles.  Camo tiles
// (ArmCam* / Corcam*) are deliberately left unmatched so painted
// camouflage doesn't get chrome-plated; kbot tiles use camo / colour /
// metalN names and so fall through to the bare-metal group only on their
// genuinely metallic parts.
export const TEXTURE_HINTS = {
  // CORE vehicle running lights — CorV06a/b + CorV04c carry blue / green /
  // yellow status lights.  The running-lights shader (main.frag) keys those
  // saturated pixels, blinks them out of phase, and makes them emissive
  // so they glow (and bloom into the scene).  Still a metal hull
  // underneath.  Listed FIRST so this tile-specific hint wins over the
  // broad `^cor` faction group below.
  'corvehic.gaf': {
    match: /^corv0?6[ab]$|^corv04[bc]$/i,
    defaults: {
      specular: { metallic: true, scale: METAL_SPEC_SCALE },
      // minNeighbors 0 = no continuity filter: these tiles' lamps are sparse
      // single-pixel dots (the small yellow/purple ones especially), so the
      // colour-key alone decides — every saturated lamp pixel blinks.
      runningLights: { blink: true, emit: 1.0, fade: 0.85, minNeighbors: 0 },
    },
  },
  // ARM building running lights — Armpanel1.  Its lamps are sparse single
  // pixels too, so minNeighbors 0 (key every saturated dot, no erosion).
  'armbldg.gaf': {
    match: /^armpanel1$/i,
    defaults: {
      specular: { metallic: true, scale: METAL_SPEC_SCALE },
      runningLights: { blink: true, emit: 1.0, fade: 0.85, minNeighbors: 0 },
    },
  },
  // ARM building plating — ArmBui2b/c/d opt into auto bump mapping: the
  // shader derives a normal from the tile's luminance gradient so the
  // panels catch light with surface relief instead of reading flat.
  // `smooth` low-passes the height field and `threshold` is a grain
  // deadzone (gradients below it are dropped) so the relief reads smooth
  // yet still resolves small high-contrast detail like rivets.
  // Listed before the broad `^arm` group so this wins.
  'armvehic.gaf': {
    match: /^armbui2[bcd]$/i,
    defaults: {
      specular: { metallic: true, scale: METAL_SPEC_SCALE },
      bump: { generate: true, intensity: 1.0, smooth: 1.5, threshold: 0.12 },
    },
  },
  // ARM ship hull plating — Arm01b / Arm02b/c/d — bump mapped (steel plates
  // with rivets + seams) and metallic.
  'armships.gaf': {
    match: /^arm0(1b|2[bcd])$/i,
    defaults: {
      specular: { metallic: true, scale: METAL_SPEC_SCALE },
      bump: { generate: true, intensity: 1.0, smooth: 1.5, threshold: 0.12 },
    },
  },
  // ARM fine-detail noise overlays — Noise2a..d — bump only (no metal sheen);
  // a higher grain deadzone keeps just the coherent structure as micro-relief
  // rather than chasing every speckle.
  'armvehic.gaf noise': {
    match: /^noise2[abcd]$/i,
    defaults: {
      bump: { generate: true, intensity: 1.0, smooth: 1.5, threshold: 0.18 },
    },
  },
  // Bare-metal + raw plating tiles, shared across both factions.
  'metal-plating': {
    match: /metal|chrome|steel|iron|alloy|titan|gold|silver|brass|copper|plate|solid|solgrad/i,
    defaults: { specular: { metallic: true, scale: METAL_SPEC_SCALE } },
  },
  // ARM faction hull plating — Arm6a / Armpanel1 / ArmBui2b / ARMv02a …
  // (vehicles, ships and buildings all share the Arm* tile family).
  'arm-hull': {
    match: /^arm(?!cam)|armvehic|armship|armbldg/i,
    defaults: { specular: { metallic: true, scale: METAL_SPEC_SCALE } },
  },
  // CORE faction hull plating — CorV04b (vehicle), CorSea6a (ship),
  // CorBui* (building), Core32Dk …
  'core-hull': {
    match: /^cor(?!cam)|corvehic|corship|corbldg/i,
    defaults: { specular: { metallic: true, scale: METAL_SPEC_SCALE } },
  },
}

// _mergeHints — overlay a partial hint patch onto a base, per sub-section,
// so a group / tile can override just `specular.scale` (say) without
// dropping the rest of the block.
function _mergeHints(base, patch) {
  if (!patch) return base
  return {
    specular: { ...base.specular, ...(patch.specular || null) },
    runningLights: (patch.runningLights !== undefined) ? patch.runningLights : base.runningLights,
    bump: (patch.bump !== undefined) ? patch.bump : base.bump,
    emissive: (patch.emissive !== undefined) ? patch.emissive : base.emissive,
  }
}

// _tileOverride — case-insensitive lookup of a per-sub-texture override
// in a group's `tiles` map.  Returns undefined when none.
function _tileOverride(group, name) {
  if (!group.tiles) return undefined
  if (Object.prototype.hasOwnProperty.call(group.tiles, name)) return group.tiles[name]
  const lower = name.toLowerCase()
  for (const k of Object.keys(group.tiles)) {
    if (k.toLowerCase() === lower) return group.tiles[k]
  }
  return undefined
}

// _groupCovers — does this group's match / tiles cover the tile name?
function _groupCovers(group, name) {
  if (group.match && group.match.test(name)) return true
  return _tileOverride(group, name) !== undefined
}

// resolveTextureHints — merged hint block for a tile name.  Returns
// DEFAULT_HINTS when nothing matches (a plain painted surface).
export function resolveTextureHints(name) {
  if (!name) return DEFAULT_HINTS
  for (const group of Object.values(TEXTURE_HINTS)) {
    if (!_groupCovers(group, name)) continue
    let hints = _mergeHints(DEFAULT_HINTS, group.defaults)
    hints = _mergeHints(hints, _tileOverride(group, name))
    return hints
  }
  return DEFAULT_HINTS
}
