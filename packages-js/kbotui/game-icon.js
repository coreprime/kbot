// game-icon.js
//
// Per-game iconography for KBot Studio. A registry maps kbot game ids to a
// short code, a full title, an accent colour, and the application icon, so
// the icon, the chip, and (elsewhere) the welcome-background source all key
// off one definition. The data comes from the game adapter packages via
// registerGameBranding; kbotui ships only the mechanism.
//
// GameIcon renders the real application icon extracted from the retail
// executable (TotalA.exe / Kingdoms.exe), embedded as a data URI so it
// works in the app and Storybook with no asset serving. Games without an
// extracted icon (e.g. "custom") fall back to a coloured letter badge.

import { htm as html } from '@kbot/ui/htm-bind'

// Branding registry. The game adapter packages own their iconography (the
// real application icons lifted from the retail PE resources, chip codes,
// accent colours); the studio registers each shipped game at boot via
// registerGameBranding. kbotui keeps only the mechanism plus the "custom"
// fallback, so this library carries no per-game data. Unregistered ids (a
// Storybook story, a custom game without branding) render the letter badge.
const ICON = {}

export const GAME = {
  custom: { short: '?', name: 'Custom', color: '#6b7488' },
}

// registerGameBranding installs one game's chip metadata + optional icon
// data URI under its registry id. Called by the studio's game registry for
// every adapter package at boot.
export function registerGameBranding(id, { short, name, color, icon } = {}) {
  if (!id) return
  GAME[id] = {
    short: short || id.slice(0, 3).toUpperCase(),
    name: name || id,
    color: color || GAME.custom.color,
  }
  if (icon) ICON[id] = icon
}

export function gameInfo(game) {
  return GAME[game] || GAME.custom
}

// gameIconDataUri — the game's real application-icon PNG as a data URI, or null
// when no extracted icon exists (e.g. "custom"). Lets non-Preact chrome (the
// editor topbar brand) show the same icon without serving an asset.
export function gameIconDataUri(game) {
  return ICON[game] || null
}

// GameIcon — the game's real application icon, or a coloured letter badge
// when no icon is available for that game id.
export function GameIcon({ game, size = 18 }) {
  const g = gameInfo(game)
  const src = ICON[game]
  if (src) {
    return html`<img class="kb-game-icon" width=${size} height=${size}
                     src=${src} alt=${g.name} title=${g.name} />`
  }
  const fontSize = g.short.length > 2 ? 8 : 11
  return html`
    <svg class="kb-game-icon" width=${size} height=${size} viewBox="0 0 24 24"
         role="img" aria-label=${g.name}>
      <rect x="1" y="1" width="22" height="22" rx="5" fill=${g.color} />
      <text x="12" y="12" text-anchor="middle" dominant-baseline="central"
            font-size=${fontSize} font-weight="700" fill="#fff"
            font-family="system-ui, sans-serif">${g.short}</text>
    </svg>
  `
}

// GameChip — icon + full title, for context/workspace rows and selectors.
export function GameChip({ game, size = 16 }) {
  const g = gameInfo(game)
  return html`<span class="kb-game-chip"><${GameIcon} game=${game} size=${size} />${g.name}</span>`
}
