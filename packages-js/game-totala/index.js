// @kbot/game-totala
//
// Total Annihilation's game adapter — the JS twin of the Go games/totala
// package. Everything the studio varies per game lives on this object:
// weapon-script conventions, COB quick-action catalogues, branding, and
// welcome-screen theming. Shared UI code resolves the active adapter through
// the studio's game registry and never tests game ids inline.
//
// TA is also the baseline for custom games built on the TA formats:
// @kbot/game-takingdoms composes over this adapter, and a custom game package
// can do the same — spread `game`, override the parts that differ, register.

import { view3d } from './view3d.js'

// Per-slot weapon entry points. TA COBs export one Aim/Fire/Query triple per
// weapon slot; a slot is drivable when the FBI declares a weapon there or the
// COB ships any of these scripts for it.
const WEAPON_SLOTS = [
  { aim: 'AimPrimary', fire: 'FirePrimary', query: 'QueryPrimary' },
  { aim: 'AimSecondary', fire: 'FireSecondary', query: 'QuerySecondary' },
  { aim: 'AimTertiary', fire: 'FireTertiary', query: 'QueryTertiary' },
]

// isAimScript — does this entry point take an aim target? Aim threads expect
// (heading, pitch) pushed in TA's fixed-point angle units (65536 = 360°).
function isAimScript(name) {
  return /^Aim(Primary|Secondary|Tertiary)$/i.test(name)
}

// entryArgs returns the stack arguments for starting a COB entry point by
// name, or null when the script takes none. ctx carries the aim target the
// caller computed: { heading, pitch } in COB angle units.
function entryArgs(name, ctx = {}) {
  if (isAimScript(name)) return [ctx.heading | 0, ctx.pitch | 0]
  return null
}

export const game = {
  id: 'totala',
  label: 'Total Annihilation',

  // 3D-view configuration injected into @kbot/game3d at boot: team palette,
  // projectile fallback hues, LOD piece-name heuristics.
  view3d,

  branding: {
    headerLogo: '/branding/logos/kbot-header-ta.png',
  },

  // Welcome-dialog particle theme: the classic green nanolathe — beam
  // emitters firing at the welcome card, sparking on impact.
  welcomeFx: {
    style: 'beam',
    core: 'rgba(220, 255, 200, 1)',
    body: 'rgba(127, 255, 102, 0.9)',
    tail: 'rgba(80, 220, 80, 0.0)',
    hot: (t) => [`rgba(220, 255, 200, ${0.85 * t})`, `rgba(127, 255, 102, ${0.55 * t})`, 'rgba(80, 220, 80, 0)'],
    edge: (t) => `rgba(180, 255, 150, ${0.7 * t})`,
    spark: (t) => `rgba(180, 255, 150, ${t * 0.95})`,
  },

  weapons: {
    slots: WEAPON_SLOTS,
    // TA has no shared parameterized weapon set — every slot has its own
    // scripts. (TA:K overrides this with AimWeapon/FireWeapon/QueryWeapon.)
    shared: null,
    // slotScripts lists the script names whose presence marks slot `idx` as
    // drivable — the enable probe used by the sandbox Controls panel and the
    // unit editor's Move/Fire buttons.
    slotScripts(idx) {
      const s = WEAPON_SLOTS[idx]
      return s ? [s.aim, s.fire, s.query] : []
    },
    isAimScript,
    entryArgs,
  },

  // Scene environments for the unit viewer / sandbox Scene menu. env keys
  // name @kbot/game3d world manifests (worlds/<env>.json); the labels carry
  // the game's flavour. First entry is the default scene.
  environments: [
    { env: 'greenworld', icon: '🌳', label: 'Greenworld',
      title: 'Greenworld — lush forest, deeper-blue ocean (TA default)' },
    { env: 'archipelago', icon: '🏝️', label: 'Archipelago',
      title: 'Archipelago — tropical white-sand seabed, crystal blue translucent water' },
    { env: 'metal', icon: '⚙️', label: 'Metal',
      title: 'Metal world — cloudless industrial sky, thick oily coolant' },
    { env: 'desert', icon: '🏜️', label: 'Desert',
      title: 'Desert — sandy terrain, acid-green lake' },
    { env: 'lava', icon: '🌋', label: 'Lava',
      title: 'Lava world — red sky, glowing molten lakes' },
    { env: 'marsh', icon: '🪷', label: 'Marsh',
      title: 'Marsh — hazy sky, tannin-stained swamp water' },
    { env: 'slate', icon: '⛰️', label: 'Slate',
      title: 'Slate — overcast sky, cold grey quarry water' },
    { env: 'moon', icon: '🌙', label: 'Lunar',
      title: 'Lunar — airless black sky, highly translucent water' },
    { env: 'mars', icon: '🔴', label: 'Mars',
      title: 'Mars — orange dusty sky, purple water' },
    { env: 'sunset', icon: '🌇', label: 'Sunset',
      title: 'Greenworld at sunset — warm sky, muted water' },
    { env: 'night', icon: '🌌', label: 'Night',
      title: 'Greenworld at night — dark sky, moonlit water' },
    { env: 'alienTwin', icon: '👽', label: 'Alien (twin suns)',
      title: 'Alien — twin suns, purple sky, bioluminescent water' },
  ],

  // COB quick actions for the unit editor's ribbon, filtered at render time
  // to the scripts the loaded COB actually exports.
  cobEntries: [
    { section: 'Lifecycle', rows: [
      { name: 'Create',      icon: '🪄', title: 'Initial setup script that runs on unit spawn (hides flares, sets piece offsets).' },
      { name: 'Activate',    icon: '⚡', title: 'Powers on the unit — radar dishes spin, hatches open, etc.' },
      { name: 'Deactivate',  icon: '🔌', title: 'Powers off — folds antennas, closes hatches.' },
      { name: 'Killed',      icon: '💀', title: 'Death animation — body parts fly off, smoke trails.' },
    ] },
    { section: 'Movement', rows: [
      { name: 'StartMoving',   icon: '🚶', title: 'Start walking / driving animation.' },
      { name: 'StopMoving',    icon: '🛑', title: 'Stop walking / driving animation.' },
      { name: 'StartBuilding', icon: '🏗️', title: 'Begin construction animation (cranes extending).' },
      { name: 'StopBuilding',  icon: '✋', title: 'End construction animation.' },
    ] },
    { section: 'Weapons', rows: [
      { name: 'AimPrimary',   icon: '🎯', title: 'Aim primary weapon at a random heading + elevation in the unit’s FOV.' },
      { name: 'FirePrimary',  icon: '💥', title: 'Fire primary weapon (recoil + muzzle flash).' },
      { name: 'AimSecondary', icon: '🎯', title: 'Aim secondary weapon at a random target.' },
      { name: 'FireSecondary', icon: '💥', title: 'Fire secondary weapon.' },
      { name: 'AimTertiary',  icon: '🎯', title: 'Aim tertiary weapon.' },
      { name: 'FireTertiary', icon: '💥', title: 'Fire tertiary weapon.' },
    ] },
  ],
}
