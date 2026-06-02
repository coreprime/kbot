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
//   runningLights { blink, emit, fadeOut, gap, keyBright, keySat, keyBrightHi }
//                   — colour-keyed blinking status lights that glow (and bloom
//                   into the scene).  A CPU pre-pass (lamp-map.js) groups every
//                   proximal/touching lamp texel into one component carrying a
//                   single dominant colour, so the WHOLE lamp shares one colour
//                   / blink phase / intensity (no per-pixel drift splitting a
//                   blob into competing phases).
//                   `fadeOut` (0..1) is the dim-phase opacity: 0 keeps the
//                   original texture, 1 fades the lamp to black.
//                   `gap` (texels) is the grouping radius — a morphological
//                   close that merges areas within ~2·gap of each other into
//                   one lamp AND fills holes that wide so the middle of a spot
//                   lights, not just its rim; 0 keeps each blob separate.
//                   `keyBright` / `keySat` are the COLOURED-lamp thresholds
//                   (min brightness / relative saturation); `keyBrightHi` is a
//                   brightness cutoff above which colour is ignored so white /
//                   desaturated lamps still key.  Lower keyBright/keySat for
//                   dimmer coloured lamps, lower keyBrightHi for dimmer white
//                   lamps.                                                (LIVE)
//   bump          { generate, intensity, smooth, threshold, scale } — surface
//                   relief from the tile's luminance height field via parallax
//                   occlusion mapping (the UV is marched along the view ray so
//                   high detail OCCLUDES the lower detail behind it) plus a
//                   matching normal tilt.  `smooth` (texels) low-passes the
//                   height field so only LARGE features bump; `threshold` is a
//                   grain deadzone; `scale` is the SIGNED relief depth —
//                   positive protrudes, negative recesses/engraves.      (LIVE)
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
      // Detection: keyBright/keySat catch the COLOURED dots; keyBrightHi catches
      // white-hot lamps on brightness alone (defaults in applyResolvedHints).
      // gap 0 = no extra grouping; per-component dominant colour already keeps
      // a single painted blob reading as one lamp.
      runningLights: { blink: true, emit: 1.0, fadeOut: 0.2, gap: 0 },
    },
  },
  // ARM building running lights — Armpanel1.  Its top lamps are near-white
  // (low saturation), so detection leans on the brightness cutoff (keyBrightHi)
  // to pick them up rather than the colour key.
  'armbldg.gaf': {
    match: /^armpanel1$/i,
    defaults: {
      specular: { metallic: true, scale: METAL_SPEC_SCALE },
      runningLights: { blink: true, emit: 1.0, fadeOut: 0.2, gap: 0 },
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

// resolveBaseHints — the DETECTED hint block for a tile name, straight
// from the TEXTURE_HINTS table (no session edits).  Returns DEFAULT_HINTS
// when nothing matches (a plain painted surface).
export function resolveBaseHints(name) {
  if (!name) return DEFAULT_HINTS
  for (const group of Object.values(TEXTURE_HINTS)) {
    if (!_groupCovers(group, name)) continue
    let hints = _mergeHints(DEFAULT_HINTS, group.defaults)
    hints = _mergeHints(hints, _tileOverride(group, name))
    return hints
  }
  return DEFAULT_HINTS
}

// ── Session overrides ─────────────────────────────────────────────────
// In-memory, per-tile tweaks layered ON TOP of the detected hints so the
// Textures panel can experiment with specular / running-lights / bump
// parameters live.  Keyed by lower-cased tile name; each value is a
// partial hint block whose present sub-sections (specular / runningLights
// / bump / emissive) REPLACE the detected ones (same merge semantics as a
// group's per-tile override).  Never persisted — cleared on reload, so
// it's a scratch pad for this Kbot session only.
const _overrides = new Map()

// setTextureHintOverride — store the FULL sub-blocks the caller passes
// (the UI sends complete specular / runningLights / bump objects so the
// replace-merge below keeps every field).  Merges into any existing
// override for the tile rather than clobbering sibling sub-sections.
export function setTextureHintOverride(name, patch) {
  if (!name || !patch) return
  const k = name.toLowerCase()
  _overrides.set(k, _mergeHints(_overrides.get(k) || DEFAULT_HINTS, patch))
}

// clearTextureHintOverride — drop a tile's session tweaks (revert to
// detected).  With no name, clears every override at once.
export function clearTextureHintOverride(name) {
  if (!name) { _overrides.clear(); return }
  _overrides.delete(name.toLowerCase())
}

// hasTextureHintOverride — true when the tile currently carries session edits.
export function hasTextureHintOverride(name) {
  return !!(name && _overrides.has(name.toLowerCase()))
}

// resolveTextureHints — the EFFECTIVE hint block the renderer applies:
// detected hints with any live session override layered on top.
export function resolveTextureHints(name) {
  const base = resolveBaseHints(name)
  if (!name) return base
  const ov = _overrides.get(name.toLowerCase())
  return ov ? _mergeHints(base, ov) : base
}

// applyResolvedHints — copy the effective hint block for `name` onto a
// render group's flat fields (the form the draw loop reads as uniforms).
// Single source of truth shared by the model loader (at load) and the
// renderer's live re-apply (when a session override changes), so the two
// can never drift.
export function applyResolvedHints(group, name) {
  const h = resolveTextureHints(name)
  group.metallic = !!(h.specular && h.specular.metallic)
  group.specScale = (h.specular && h.specular.scale) || 1.0
  group.runningLights = !!(h.runningLights && h.runningLights.blink)
  group.rlEmit = h.runningLights ? (h.runningLights.emit != null ? h.runningLights.emit : 1.0) : 0.0
  group.rlFadeOut = (h.runningLights && h.runningLights.fadeOut != null) ? h.runningLights.fadeOut : 0.2
  group.rlKeyBright = (h.runningLights && h.runningLights.keyBright != null) ? h.runningLights.keyBright : 0.2
  group.rlKeySat = (h.runningLights && h.runningLights.keySat != null) ? h.runningLights.keySat : 0.50
  group.rlKeyBrightHi = (h.runningLights && h.runningLights.keyBrightHi != null) ? h.runningLights.keyBrightHi : 0.8
  group.rlMinRise = (h.runningLights && h.runningLights.minRise != null) ? h.runningLights.minRise : 0.12
  group.rlGap = (h.runningLights && h.runningLights.gap != null) ? h.runningLights.gap : 0
  group.bump = !!(h.bump && h.bump.generate)
  group.bumpIntensity = (h.bump && h.bump.intensity) || 0.0
  group.bumpSmooth = (h.bump && h.bump.smooth != null) ? h.bump.smooth : 1.5
  group.bumpThreshold = (h.bump && h.bump.threshold != null) ? h.bump.threshold : 0.12
  // Signed relief depth for parallax-occlusion mapping: + protrudes, − recesses.
  // Defaults to +1 so existing bump hints read as raised plating as before.
  group.bumpScale = (h.bump && h.bump.scale != null) ? h.bump.scale : 1.0
}
