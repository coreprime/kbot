// view3d.js — Total Annihilation's 3D-view configuration.
//
// @coreprime/kbot-game3d is game-agnostic machinery: it renders whatever models,
// teams, and projectiles it is configured with. The game-flavoured tables it
// needs — team palette, projectile fallback hues, LOD piece-name heuristics —
// live here with the rest of TA's adapter, and the studio injects them at
// boot (see /ui/common/game-view3d.js). TA:K inherits these unchanged; a
// custom game can override any of them.

// The TA team palette, indexed by `side` (0..7) so the engine + UI +
// renderer can all refer to a unit's faction by a single integer.
//
// The table itself is canonicalised in @coreprime/kbot-game3d (TA_TEAM_SIDES in
// team-colors.js) so pack-driven consumers — the replayer, headless render
// harnesses — can reach it without this private adapter package.  Re-export
// it here so the studio's per-game injection path keeps its shape.
import { TA_TEAM_SIDES } from '@coreprime/kbot-game3d/team-colors'

export const teamSides = TA_TEAM_SIDES

// Per-kind fallback hues for projectiles whose TDF omits a colour index
// (most non-laser weapons leave `color=` unset). Keys are the game3d
// projectile-kind names; values are 0..2 float RGB (the additive blend and
// bloom rely on >1 channels).
export const projectileFallbackColors = {
  laser:   [0.45, 1.80, 0.45],
  dgun:    [1.10, 0.30, 0.10],
  plasma:  [0.30, 1.00, 1.10],
  shell:   [1.00, 0.55, 0.20],
  missile: [1.00, 0.75, 0.20],
  bullet:  [1.00, 0.85, 0.20],
}

// Piece names matching any of these regexes are cosmetic-only sub-pixel
// detail the renderer's distance-LOD can skip at mid tier. TA modellers
// consistently follow these naming conventions:
//   flare*    muzzle-flash anchors (often hidden until the COB fires)
//   muzzle*   weapon-barrel tips
//   sleeve*   recoil sleeves / cylinder housings
//   exhaust*  engine exhausts (steady particle anchors)
//   smoke*    smoke-emit anchors
//   aim*      aim-query targets (geometry-less in many units)
//   emit*     generic SFX emit points
export const lodHidePatterns = [
  /^.*flare\d*$/i,
  /^.*muzzle\d*$/i,
  /^.*sleeve\d*$/i,
  /^.*exhaust\d*$/i,
  /^.*smoke\d*$/i,
  /^.*aim\d*$/i,
  /^emit\d*$/i,
]

export const view3d = { teamSides, projectileFallbackColors, lodHidePatterns }
