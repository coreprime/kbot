// game-view3d.js
//
// Injects the active game's 3D-view configuration into @coreprime/kbot-game3d, which
// is game-agnostic machinery: it renders whatever team palette, projectile
// fallback hues, and LOD heuristics it is given. The tables live with each
// game's adapter package (view3d on the adapter object).
//
// Importing this module applies the TA baseline immediately — module-graph
// evaluation finishes before anything renders, so the first frame already
// has a team palette. applyGameView3D() re-applies once session-info
// publishes the real game id (a no-op delta for the shipped games, which
// share TA's tables, but the hook a custom game's overrides arrive through).

import { setTeamSides } from '@coreprime/kbot-game3d/team-colors'
import { setLodHidePatterns } from '@coreprime/kbot-game3d/model-loader'
import { setProjectileFallbackColors } from '@coreprime/kbot-game3d/weapon-driver'
import { activeGame } from './game-registry.js'

export function applyGameView3D() {
  const cfg = activeGame().view3d || {}
  setTeamSides(cfg.teamSides)
  setLodHidePatterns(cfg.lodHidePatterns)
  setProjectileFallbackColors(cfg.projectileFallbackColors)
}

applyGameView3D()
