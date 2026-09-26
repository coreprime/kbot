// weapon-stats.js
//
// Weapon figures as the game uses them, from the /api/studio/unit and
// /api/studio/weapons weapon JSON. The game counts a weapon's reload in whole
// ticks (30 a second): reloadtime*30 truncated, so reloadtime=0.35 reloads
// after 10 ticks, 0.333 s. The server sends that as reloadTicks alongside the
// written reloadSec.

export const TICKS_PER_SECOND = 30

// reloadTicks returns the weapon's reload in whole game ticks: the server's
// reloadTicks, or reloadSec*30 truncated when a payload predates it.
export function reloadTicks(w) {
  if (w && Number.isInteger(w.reloadTicks) && w.reloadTicks > 0) return w.reloadTicks
  const sec = Number(w?.reloadSec) || 0
  return sec > 0 ? Math.trunc(sec * TICKS_PER_SECOND) : 0
}

// reloadSeconds is the reload the game applies, in seconds: whole ticks / 30.
export function reloadSeconds(w) {
  return reloadTicks(w) / TICKS_PER_SECOND
}

// reloadMs is reloadSeconds in milliseconds, for timing a reload bar.
export function reloadMs(w) {
  return (reloadTicks(w) * 1000) / TICKS_PER_SECOND
}

// formatReload renders a reload for display: "0.33 s (10 ticks)", or '—'
// when the weapon has none.
export function formatReload(w) {
  const ticks = reloadTicks(w)
  if (ticks <= 0) return '—'
  const sec = (ticks / TICKS_PER_SECOND).toFixed(2).replace(/\.?0+$/, '')
  return `${sec} s (${ticks} tick${ticks === 1 ? '' : 's'})`
}
