// @kbot/game-takingdoms
//
// TA: Kingdoms' game adapter — the JS twin of the Go games/takingdoms
// package. Composes over @kbot/game-totala (the TA-format baseline) and
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

import { game as totala } from '@kbot/game-totala'

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

  branding: {
    headerLogo: '/branding/logos/kbot-header-tak.png',
  },

  // A sorcery-driven world rather than a nano-tech one: slow violet/gold
  // smoke wisps drift across the welcome card like conjured vapour.
  welcomeFx: {
    style: 'smoke',
    // Wisp gradient: warm gold-white core → violet body → transparent.
    smoke: (a) => [`rgba(255, 228, 170, ${a * 0.9})`, `rgba(186, 130, 255, ${a})`, 'rgba(90, 60, 160, 0)'],
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
