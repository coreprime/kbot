// game-registry.js
//
// Resolves the session's game adapter. The per-game packages
// (@kbot/game-totala, @kbot/game-takingdoms) carry everything the UI varies
// by game — weapon-script conventions, COB quick actions, branding, welcome
// theming — and shared code reads it through here instead of testing game ids
// inline.
//
// The active game id is published on window.__KBOT_GAME__ by
// applySessionBrand() once /api/studio/session-info resolves at boot. Unknown
// ids — including custom games that haven't shipped their own adapter —
// resolve to Total Annihilation, the TA-format baseline (mirroring the Go
// games registry).

import { registerGameBranding } from '@kbot/ui/game-icon'
import { game as totala } from '@kbot/game-totala'
import { game as takingdoms } from '@kbot/game-takingdoms'

const REGISTRY = new Map([totala, takingdoms].map((g) => [g.id, g]))

// Push each adapter's chip metadata + application icon into @kbot/ui's
// branding registry at module load, so GameIcon/GameChip render the real
// per-game iconography without kbotui carrying any game data itself.
for (const g of REGISTRY.values()) {
  registerGameBranding(g.id, {
    short: g.branding?.chip?.short,
    name: g.label,
    color: g.branding?.chip?.color,
    icon: g.branding?.icon,
  })
}

// ALL_GAMES — every shipped adapter, in presentation order (the picker's
// filter tabs and header logos derive from this).
export const ALL_GAMES = [totala, takingdoms]

// gameById returns the adapter for a game id, falling back to TA for unknown
// or custom ids.
export function gameById(id) {
  return REGISTRY.get(id) || totala
}

// activeGame returns the adapter for the session's game. Safe to call before
// session-info resolves — it falls back to TA until the id is published.
export function activeGame() {
  return gameById(window.__KBOT_GAME__)
}
