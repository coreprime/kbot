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
    // Chip metadata + the real application icon (lifted from TotalA.exe's
    // PE resources, 32x32 PNG as a data URI) — registered into @kbot/ui's
    // game-icon registry at studio boot.
    chip: { short: 'TA', color: '#e0793a' },
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABK0lEQVR4nMVWAQ7DIAhE03/PvfwWXd1IBxYo20hNWpS7KypK9GcrkSCMRwRz45UQKc7RrGKKmZyR3veoG+RvpuAUv1rJO0lvhZFN3yTufdO3p0zLlc1ABIDQnkCjNacvLAJGoq+IgJM8VQSC5GkicADwkGsiVgK2lZjGVnt/t9oYO3eHpzSBKY/8+SoTpmkAC7hKLokwC4BjwXkWpisD5AB1jdcEILjVIlv0QwSS9nlYBIwA3lKcKqAlj3FNQ7s4RaaFCCUwoxSHBbQLBWm1WM11oL0DQs1yIFVVDRema3bHHO+JddX58hcqQ/reVqSz9RiL0E2SKB2jHFCbR410HutS7ybwl7Obi/XvJOyjr9KfrYpedtfPsI6lZa0q/KEUR6z+iihky6qVhPEAA3DLX1hqEg8AAAAASUVORK5CYII=',
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

  // In-world construction effect — the sandbox sprays these particles along
  // the builder→buildee line while a unit is under construction. TA's
  // signature green nanolathe. Colour channels run 0..2 (additive bloom).
  buildFx: {
    name: 'nanolathe',
    color: [0.5, 1.8, 0.6, 1.0],
  },

  // Economy resources, in HUD display order. Each names the unit-meta cost
  // field that prices a build in that resource; the sandbox drains it over
  // construction against an infinite pool.
  resources: [
    { key: 'metal', label: 'Metal', costField: 'costMetal', color: '#9fb4c7' },
    { key: 'energy', label: 'Energy', costField: 'costEnergy', color: '#f3d933' },
  ],

  // Selection hotkeys in keys.tdf grammar. TA ships no keys.tdf — the retail
  // executable hardcoded these bindings — so the adapter carries the table;
  // units opt into each class through literal CTRL_x tokens in their FBI
  // Category list (Category=ARM KBOT ... CTRL_B). A VFS keys.tdf, when a mod
  // ships one, overrides this wholesale.
  defaultKeys: {
    CTRL_A: 'SelectAllUnits',
    CTRL_B: 'SelectUnits CTRL_B', // construction units
    CTRL_C: 'SelectUnits CTRL_C, TrackUnit', // the commander
    CTRL_F: 'SelectUnits CTRL_F', // factories
    CTRL_P: 'SelectUnits CTRL_P', // aircraft
    CTRL_R: 'SelectUnits CTRL_R', // radar / sensor units
    CTRL_V: 'SelectUnits CTRL_V', // vehicles
    CTRL_W: 'SelectUnits CTRL_W', // armed units
    CTRL_S: 'SelectUnitsOnScreen',
    CTRL_Z: 'SelectAllUnitsSelectedType',
    CTRLSHIFT_B: 'SelectUnitsAdd CTRL_B',
    CTRLSHIFT_F: 'SelectUnitsAdd CTRL_F',
    CTRLSHIFT_P: 'SelectUnitsAdd CTRL_P',
    CTRLSHIFT_V: 'SelectUnitsAdd CTRL_V',
    CTRLSHIFT_W: 'SelectUnitsAdd CTRL_W',
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
