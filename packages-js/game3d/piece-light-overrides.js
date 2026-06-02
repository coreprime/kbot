// piece-light-overrides.js
//
// Per-piece glow overrides keyed by unit name → piece name.  Sits next
// to the texture-keyed running-lights system (lamp-map.js) but works
// the other way around: lamp-map can only paint pixels that the GAF
// artist textured a certain way, whereas this table targets pieces
// directly — including the UNTEXTURED ones (palette-coloured solid
// polygons, like the Peewee's lfire / rfire muzzle pieces) that the
// texture atlas cannot reach.
//
// Each entry:
//   { color:        [r, g, b]      — peak emissive colour, in HDR units (>1 trips bloom)
//     blinkHz:      Hz             — pulse frequency (full cycle); 0 = steady
//     intensityMin: 0..1           — pulse trough alpha
//     intensityMax: 0..1           — pulse peak alpha
//     phaseRad:     radians        — phase offset (use for alternating L/R lamps)
//     curve:        'sine' | 'square'  — defaults to 'sine'
//   }
//
// Pulse alpha = intensityMin + (intensityMax - intensityMin) *
//               envelope(blinkHz * t + phaseRad).
//
// The renderer pulls this table via pieceLightFor(unitName, pieceName)
// each per-piece draw call.  Lookup is O(1) (two Map gets), so a flat
// lit unit with no overrides pays only one extra null-check per piece.
//
// PoC: the Peewee (ARMPW) has yellow pulse-lamps on its arms, with
// the left + right arms in opposite phase so they alternate like
// status indicators.

// _build flattens the human-authored config into the internal
// Map<unitNameLC, Map<pieceNameLC, override>> shape the lookup uses.
// All keys are lowercased here once so the per-frame draw doesn't
// have to toLowerCase() on every piece.
function _build(authored) {
  const out = new Map()
  for (const [unit, pieces] of Object.entries(authored)) {
    const inner = new Map()
    for (const [piece, override] of Object.entries(pieces)) {
      inner.set(piece.toLowerCase(), {
        color:        override.color || [1, 1, 1],
        blinkHz:      +override.blinkHz || 0,
        intensityMin: +(override.intensityMin ?? 0),
        intensityMax: +(override.intensityMax ?? 1),
        phaseRad:     +(override.phaseRad || 0),
        curve:        override.curve || 'sine',
      })
    }
    out.set(unit.toLowerCase(), inner)
  }
  return out
}

// PoC table — Peewee arm-piece pulse glow.  The lower-arm pieces
// (lloarm / rloarm) carry the actual "tip" texture the user sees as
// the gun barrel; lfire / rfire are the muzzle-flash pieces that
// only become visible during firing animations.  Targeting both
// gives a pulse along the arm AND a brief flash at the muzzle when
// the script unhides those pieces.
//
// Yellow tuned warm-side ([1.0, 0.85, 0.30]) so it reads as "status
// lamp" rather than competing with the EMG's bright-yellow muzzle
// fire.  Slight peak intensity (0.55) — strong enough to bloom but
// not enough to bleach the silhouette.  L/R out of phase so the
// alternating sweep reads as deliberate signalling.
const _AUTHORED = {
  armpw: {
    // lloarm: { color: [1.0, 0.85, 0.30], blinkHz: 1.6, intensityMin: 0.05, intensityMax: 0.55, phaseRad: 0 },
    // rloarm: { color: [1.0, 0.85, 0.30], blinkHz: 1.6, intensityMin: 0.05, intensityMax: 0.55, phaseRad: Math.PI },
    // lfire:  { color: [1.0, 0.85, 0.30], blinkHz: 1.6, intensityMin: 0.15, intensityMax: 0.85, phaseRad: 0 },
    // rfire:  { color: [1.0, 0.85, 0.30], blinkHz: 1.6, intensityMin: 0.15, intensityMax: 0.85, phaseRad: Math.PI },
  },
}

const _TABLE = _build(_AUTHORED)

// pieceLightFor returns the override entry for a given (unitName,
// pieceName) pair, or null when no override applies.  Both names are
// matched case-insensitively so a 3DO piece called "LFire" lines up
// with the lowercased table key.
export function pieceLightFor(unitName, pieceName) {
  if (!unitName || !pieceName) return null
  const inner = _TABLE.get(String(unitName).toLowerCase())
  if (!inner) return null
  return inner.get(String(pieceName).toLowerCase()) || null
}

// hasOverridesFor reports whether ANY piece of this unit carries an
// override — used by the renderer to short-circuit the per-piece
// lookup loop for units that won't ever pulse.  Cheaper than calling
// pieceLightFor for every piece of every entity.
export function hasOverridesFor(unitName) {
  if (!unitName) return false
  const inner = _TABLE.get(String(unitName).toLowerCase())
  return !!(inner && inner.size > 0)
}

// pulseAlpha evaluates an override's pulse at the given elapsed
// seconds.  Sine curve uses the standard cos-based envelope
// ((1 - cos(2π·f·t + φ)) / 2 ∈ [0, 1]) so the lamp starts at trough
// when t = 0 — gives a clean "lighting up" feel on view-open.  Square
// curve toggles cleanly at the same frequency, useful for "blinking"
// status lamps that should snap on/off rather than fade.
export function pulseAlpha(override, elapsedSec) {
  if (!override) return 0
  const fHz = override.blinkHz
  if (fHz <= 0) return override.intensityMax
  const phase = 2 * Math.PI * fHz * elapsedSec + override.phaseRad
  let env
  if (override.curve === 'square') {
    env = Math.sin(phase) >= 0 ? 1 : 0
  } else {
    env = 0.5 - 0.5 * Math.cos(phase)
  }
  return override.intensityMin + (override.intensityMax - override.intensityMin) * env
}
