// helpers.js
//
// Pure map-editor helpers — no DOM access, no module-level state, no
// imports from studio.js.  Anything that needs the live `state` proxy
// or runtime-only globals stays in studio.js for now; this file is
// the safe-to-share slice that other /ui/map-editor/ modules can pull
// in without dragging the whole legacy host along.

import { WORLDS, PLAYER_COUNT_NAMES } from './constants.js'

// worldFor resolves a world string (a slug, a default-tileset name, or
// an alias) to its WORLDS entry.  Returns null when nothing matches.
// Normalises whitespace/dashes so "Green World" → "greenworld".
export function worldFor(name) {
  const w = (name || '').toLowerCase().replace(/[\s_-]+/g, '')
  if (!w) return null
  for (const t of WORLDS) {
    if (t.slug === w) return t
    if (t.defaultTileset.toLowerCase() === w) return t
    for (const a of t.aliases) if (a.toLowerCase() === w) return t
  }
  return null
}

// activeWorldsFor resolves a planet/tileset string to the list of
// section worlds that count as "matching".  state.planet can hold
// either a slug ("mars") or a default-tileset name ("Desert"); WORLDS
// covers both so we route through worldFor.
export function activeWorldsFor(planet) {
  const t = worldFor(planet)
  if (t) return [t.slug]
  const p = (planet || '').toLowerCase()
  return p ? [p] : []
}

// featureWorldMatches returns true when a feature's world string
// should count as part of the active tileset.  Feature TDFs use
// slightly different world names (e.g. "Green World", "All Worlds")
// than the section folder layout, so we normalise both sides before
// comparing and consult WORLDS for the default-tileset + alias
// spellings of each active slug.
export function featureWorldMatches(featureWorld, activeWorlds) {
  if (!activeWorlds.length) return true
  const w = (featureWorld || '').toLowerCase().replace(/[\s_-]+/g, '')
  if (w.includes('allworlds')) return true
  for (const a of activeWorlds) {
    const norm = a.toLowerCase().replace(/[\s_-]+/g, '')
    if (w.includes(norm)) return true
    const t = worldFor(norm)
    if (!t) continue
    if (w.includes(t.defaultTileset.toLowerCase())) return true
    for (const alias of t.aliases) {
      if (w.includes(alias.toLowerCase())) return true
    }
  }
  return false
}

// isWreckageFeature flags wreckage / corpse entries so the drawer can
// hide them by default — the user usually wants live scenery, not the
// hundreds of *_dead variants that ship in TA's feature catalog.
export function isWreckageFeature(f) {
  const cat = (f.category || '').toLowerCase()
  if (cat.includes('corpse') || cat.includes('wreck')) return true
  const desc = (f.description || '').toLowerCase()
  if (desc === 'wreckage' || desc.includes('wreckage')) return true
  const name = (f.name || '').toLowerCase()
  if (name.endsWith('_dead') || name.endsWith('dead')) return true
  return false
}

// normalizedRect canonicalises a drag-rect so x/y are the top-left
// and w/h are positive — callers (selection, paint, ruler) all need
// the same { x, y, w, h } convention regardless of which corner the
// drag started from.
export function normalizedRect(r) {
  const x = Math.min(r.x, r.x + r.w - 1)
  const y = Math.min(r.y, r.y + r.h - 1)
  return {
    x: Math.min(r.x, r.x + r.w - 1),
    y: Math.min(r.y, r.y + r.h - 1),
    w: Math.abs(r.w),
    h: Math.abs(r.h),
    _: x + y, // silence "unused" if linter quibbles
  }
}

// mulberry32 — tiny seeded PRNG so users can reproduce a scatter.
// Returns a function that yields uniform [0, 1) floats; same seed →
// same sequence.
export function mulberry32(a) {
  return function () {
    a = (a + 0x6D2B79F5) | 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ── OTA defaults ────────────────────────────────────────────────────
// The OTA (Online Total Annihilation map metadata) ships alongside
// the TNT in the saved .hpi.  We mirror the fields the in-game lobby
// reads (mission name + planet + multiplayer schemas + start
// positions) so the user has full control without hand-editing the
// file.

export function defaultOTAState(mapName, planet, tileW, tileH) {
  return {
    missionName: mapName || 'newmap',
    missionDescription: 'Created with KBot Studio.',
    missionHint: '',
    brief: '',
    narration: '',
    glamour: '',
    planet: planet || 'Green',
    numPlayers: '2, 3, 4',
    size: `${Math.max(1, Math.round(tileW / 16))} x ${Math.max(1, Math.round(tileH / 16))}`,
    memory: '8 mb',
    lineOfSight: 0,
    mapping: 0,
    tidalStrength: 20,
    solarStrength: 20,
    lavaWorld: planet?.toLowerCase() === 'lava' ? 1 : 0,
    killmul: 50,
    timemul: 0,
    minWindSpeed: 200,
    maxWindSpeed: 2500,
    gravity: 112,
    seaLevel: 63,
    impassibleWater: 0,
    waterDoesDamage: 0,
    schemas: [defaultSchema('Default', 'Network 1', tileW, tileH)],
  }
}

export function defaultSchema(name, type, tileW, tileH) {
  return {
    name,
    type,
    aiProfile: 'DEFAULT',
    surfaceMetal: 3,
    mohoMetal: 30,
    humanMetal: 1000,
    computerMetal: 1000,
    humanEnergy: 1000,
    computerEnergy: 1000,
    meteorWeapon: '',
    meteorRadius: 0,
    meteorDensity: 0,
    meteorDuration: 0,
    meteorInterval: 0,
    startPositions: defaultStartPositionsForSchema(tileW, tileH),
  }
}

// 10 default start spots spread around the map (corners → edge
// midpoints → centre fills).  Game pixel coords: 1 tile = 32 game-px.
export function defaultStartPositionsForSchema(tileW, tileH) {
  const px = tileW * 32
  const py = tileH * 32
  const margin = Math.max(64, Math.min(px, py) / 8)
  return [
    { number: 1, x: Math.round(margin), z: Math.round(margin) },
    { number: 2, x: Math.round(px - margin), z: Math.round(py - margin) },
    { number: 3, x: Math.round(px - margin), z: Math.round(margin) },
    { number: 4, x: Math.round(margin), z: Math.round(py - margin) },
    { number: 5, x: Math.round(px / 2), z: Math.round(margin) },
    { number: 6, x: Math.round(px / 2), z: Math.round(py - margin) },
    { number: 7, x: Math.round(margin), z: Math.round(py / 2) },
    { number: 8, x: Math.round(px - margin), z: Math.round(py / 2) },
    { number: 9, x: Math.round(px / 3), z: Math.round(py / 2) },
    { number: 10, x: Math.round(px * 2 / 3), z: Math.round(py / 2) },
  ]
}

// playerCountLabel — used for both the dice picker caption and the
// schema row labels so the wording stays consistent everywhere.  The
// fallback `${n} Players` covers off-list counts (e.g. data imported
// from a hand-edited OTA).
export function playerCountLabel(n) {
  return PLAYER_COUNT_NAMES[n] || `${n} Players`
}
