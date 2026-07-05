// @coreprime/kbot-game-takingdoms
//
// TA: Kingdoms' game adapter — the JS twin of the Go games/takingdoms
// package. Composes over @coreprime/kbot-game-totala (the TA-format baseline) and
// overrides what Kingdoms does differently:
//
//   - Weapon scripts: one shared parameterized set (AimWeapon / FireWeapon /
//     QueryWeapon taking the weapon index) instead of per-slot triples. The
//     per-slot TA names stay in the probe lists because converted/early TA:K
//     COBs still ship them, and the row catalogue keeps both so the ribbon —
//     which filters to what the loaded COB exports — surfaces whichever
//     convention the unit uses.
//   - Lifecycle: Dying(damagetype) precedes Killed in the v6 death sequence.
//   - Welcome theme: arcane conjuration smoke instead of the green nanolathe.

import { game as totala } from '@coreprime/kbot-game-totala'

// The shared weapon entry points every retail TA:K COB exports.
const SHARED = { aim: 'AimWeapon', fire: 'FireWeapon', query: 'QueryWeapon' }

// isAimScript — TA:K's shared AimWeapon (and numbered AimWeaponN variants in
// some COBs) plus the TA per-slot names converted units carry.
function isAimScript(name) {
  return /^AimWeapon\d*$/i.test(name) || totala.weapons.isAimScript(name)
}

// entryArgs — the shared scripts dispatch on a weapon-index argument; the
// quick actions drive weapon 0. AimWeapon reports readiness through the
// WEAPON_READY port rather than its thread return value, but the stack shape
// is all the caller needs here.
function entryArgs(name, ctx = {}) {
  if (/^AimWeapon$/i.test(name)) return [ctx.heading | 0, ctx.pitch | 0, ctx.weapon | 0]
  if (/^FireWeapon$/i.test(name)) return [ctx.weapon | 0]
  if (isAimScript(name)) return [ctx.heading | 0, ctx.pitch | 0]
  return totala.weapons.entryArgs(name, ctx)
}

export const game = {
  ...totala,
  id: 'takingdoms',
  label: 'TA: Kingdoms',

  // Inherit TA's 3D-view tables but strip the ARM/CORE faction flavour from
  // the side labels — Kingdoms teams are just colours.
  view3d: {
    ...totala.view3d,
    teamSides: totala.view3d.teamSides.map((s) => ({
      ...s,
      label: s.label.replace(/ \((ARM|CORE)\)$/, ''),
    })),
  },

  branding: {
    headerLogo: '/branding/logos/kbot-header-tak.png',
    // Chip metadata + Kingdoms.exe's application icon (32x32 PNG data URI).
    chip: { short: 'TAK', color: '#3a9d7a' },
    icon: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACCUlEQVR4nK1XCw7DIAjFpvceO7kLregDsbq2JGYWnfwfmgiImfI5KYOIPh+i79fsaYP6uSdmSrRKTIcCx9B5zm0UBc91hn3c9le+GjOh5L7lj9Za8QIclVJxjnoJPKJeq/z+/CU3ZLGmWuS9gGtipduvXlsVlwJezQOMb80FjHOz1MS/zJes3yKl1J2jxFLZuGe0744CWa0eUQ01Wk3vUdb4Yqx9FWh+HAP4mC+aM1fC9tBCiH3Hrx+Wj79Cki8rubCF3FHcIwVAuCTqITz9l4ieTvdDiXkgikAnCNFtyogBXsBsDTDhvgKkh4HFIw9AojUwYn7JAxwL8lWCFQH/X6It5LoE8/ya9Tpg/wxDlqGYAd1yto1ImlPUlFDRe43opK7taggQbIbt+NUcIItul0mpSjTll2gPudpkSigE1RRkyvLh4OOeAHvr2h+9YR8pgAmVQbhRAtszKk3rtIXy6yUv/hPCsXjGVMMLbTFj/SsgaRJ2GKH54PjPFKC4xaJQg5Qeqp9WAZXSU0GqgLkLTGD5sQfowkLFhpGnnivA1trLd4HrCaAEPbqUcvmIktpd/895mQhEC26Awn8rkKflFF3N3RNNFJESnXlj686GA9UssUiuWWZPEe7vjzzwxpUSSH1sMe7B29FfXIK3oa8kQwk/SnbbRwaEI0K7IQL2LRmFD1u1sfKFMaUfoP53QdkEM4UAAAAASUVORK5CYII=',
  },

  // A sorcery-driven world rather than a nano-tech one: slow violet/gold
  // smoke wisps drift across the welcome card like conjured vapour.
  welcomeFx: {
    style: 'smoke',
    // Wisp gradient: warm gold-white core → violet body → transparent.
    smoke: (a) => [`rgba(255, 228, 170, ${a * 0.9})`, `rgba(186, 130, 255, ${a})`, 'rgba(90, 60, 160, 0)'],
  },

  // In-world construction effect — TA:K units are conjured, not lathed:
  // warm gold casting sparkles rather than TA's green nano spray. Colour
  // channels run 0..2 (additive bloom).
  buildFx: {
    name: 'casting',
    color: [1.8, 1.3, 0.5, 1.0],
  },

  // Economy resource: TA:K's units are conjured from mana alone (FBI
  // buildcost). Same HUD contract as TA's metal/energy pair.
  resources: [
    { key: 'mana', label: 'Mana', costField: 'costMana', color: '#ba82ff' },
  ],

  // Fallback selection hotkeys, mirroring the retail keys.tdf's [CUSTOMKEYS]
  // selection entries. TA:K ships the real file at the VFS root and that
  // always wins; this table only stands in when a stripped install or custom
  // game omits it. Tokens reference unit attributes — FBI Category tokens
  // (BALLISTIC, Monarch, ATTACK) and derived classes (BUILDER, FACTORY, FLY).
  defaultKeys: {
    CTRL_A: 'SelectAllUnits',
    CTRL_B: 'SelectUnits BUILDER',
    CTRL_E: 'SelectUnits MELEE',
    CTRL_F: 'SelectUnits FACTORY',
    CTRL_G: 'SelectUnits MAGIC',
    CTRL_M: 'SelectUnits Monarch, TrackUnit',
    CTRL_N: 'SelectUnits BOAT',
    CTRL_R: 'SelectUnits BALLISTIC',
    CTRL_T: 'SelectUnits TROOPS',
    CTRL_U: 'SelectUnitsOnScreen',
    CTRL_W: 'SelectUnits ATTACK',
    CTRL_Y: 'SelectUnits FLY',
    CTRL_Z: 'SelectAllUnitsSelectedType',
    CTRLSHIFT_B: 'SelectUnitsAdd BUILDER',
    CTRLSHIFT_E: 'SelectUnitsAdd MELEE',
    CTRLSHIFT_F: 'SelectUnitsAdd FACTORY',
    CTRLSHIFT_G: 'SelectUnitsAdd MAGIC',
    CTRLSHIFT_M: 'SelectUnitsAdd Monarch',
    CTRLSHIFT_N: 'SelectUnitsAdd NAVAL',
    CTRLSHIFT_R: 'SelectUnitsAdd BALLISTIC',
    CTRLSHIFT_T: 'SelectUnitsAdd TROOPS',
    CTRLSHIFT_W: 'SelectUnitsAdd ATTACK',
    CTRLSHIFT_Y: 'SelectUnitsAdd FLY',
  },

  weapons: {
    ...totala.weapons,
    shared: SHARED,
    // A slot is drivable through its own TA-style scripts or the shared set
    // (the FBI weapon declaration is what distinguishes the slots there).
    slotScripts(idx) {
      const own = totala.weapons.slotScripts(idx)
      return own.length ? [...own, SHARED.aim, SHARED.fire, SHARED.query] : own
    },
    isAimScript,
    entryArgs,
  },

  // Kingdoms-flavoured scene catalogue. The env keys reuse the shipped
  // world manifests (Darien's grasslands ride the greenworld scene, Taros'
  // wastes the lava one, …) so no new renderer assets are needed — the
  // menu just stops describing Aramon's homeland as "TA default".
  environments: [
    { env: 'greenworld', icon: '🌳', label: 'Aramon',
      title: 'Aramon — green heartlands, deep-blue coastal water' },
    { env: 'lava', icon: '🌋', label: 'Taros',
      title: 'Taros — scorched wastes, glowing molten rivers' },
    { env: 'archipelago', icon: '🏝️', label: 'Veruna',
      title: 'Veruna — island shallows, crystal-clear water' },
    { env: 'slate', icon: '⛰️', label: 'Zhon',
      title: 'Zhon — wild highlands under an overcast sky' },
    { env: 'metal', icon: '⚙️', label: 'Creon',
      title: 'Creon — the Iron Plague\u2019s industrial isle' },
    { env: 'marsh', icon: '🪷', label: 'Marsh',
      title: 'Marshland — hazy sky, tannin-stained swamp water' },
    { env: 'sunset', icon: '🌇', label: 'Dusk',
      title: 'Aramon at dusk — warm sky, muted water' },
    { env: 'night', icon: '🌌', label: 'Night',
      title: 'Aramon at night — dark sky, moonlit water' },
  ],

  cobEntries: totala.cobEntries.map((sec) => {
    if (sec.section === 'Lifecycle') {
      return { ...sec, rows: [...sec.rows,
        { name: 'Dying', icon: '💀', title: 'TA:K death animation — the fall sequence that ends with FINISHED_DYING.' },
      ] }
    }
    if (sec.section === 'Weapons') {
      return { ...sec, rows: [...sec.rows,
        { name: 'AimWeapon',  icon: '🎯', title: 'Aim weapon 0 at a random heading + elevation (TA:K shared aim entry).' },
        { name: 'FireWeapon', icon: '💥', title: 'Fire weapon 0 (TA:K shared fire entry).' },
      ] }
    }
    return sec
  }),
}
