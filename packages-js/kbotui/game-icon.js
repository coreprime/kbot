// game-icon.js
//
// Per-game iconography for KBot Studio. A single GAME table maps the
// kbot game ids (totala / takingdoms / custom) to a short code, a full
// title, and an accent colour, so the icon, the chip, and (elsewhere)
// the welcome-background source can all key off one definition.
//
// GameIcon renders the real application icon extracted from the retail
// executable (TotalA.exe / Kingdoms.exe), embedded as a data URI so it
// works in the app and Storybook with no asset serving. Games without an
// extracted icon (e.g. "custom") fall back to a coloured letter badge.

import { htm as html } from '@kbot/ui/htm-bind'

// Application icons lifted from the games' PE resources (32x32 PNG).
const ICON = {
  totala: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAABK0lEQVR4nMVWAQ7DIAhE03/PvfwWXd1IBxYo20hNWpS7KypK9GcrkSCMRwRz45UQKc7RrGKKmZyR3veoG+RvpuAUv1rJO0lvhZFN3yTufdO3p0zLlc1ABIDQnkCjNacvLAJGoq+IgJM8VQSC5GkicADwkGsiVgK2lZjGVnt/t9oYO3eHpzSBKY/8+SoTpmkAC7hKLokwC4BjwXkWpisD5AB1jdcEILjVIlv0QwSS9nlYBIwA3lKcKqAlj3FNQ7s4RaaFCCUwoxSHBbQLBWm1WM11oL0DQs1yIFVVDRema3bHHO+JddX58hcqQ/reVqSz9RiL0E2SKB2jHFCbR410HutS7ybwl7Obi/XvJOyjr9KfrYpedtfPsI6lZa0q/KEUR6z+iihky6qVhPEAA3DLX1hqEg8AAAAASUVORK5CYII=',
  takingdoms: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAACCUlEQVR4nK1XCw7DIAjFpvceO7kLregDsbq2JGYWnfwfmgiImfI5KYOIPh+i79fsaYP6uSdmSrRKTIcCx9B5zm0UBc91hn3c9le+GjOh5L7lj9Za8QIclVJxjnoJPKJeq/z+/CU3ZLGmWuS9gGtipduvXlsVlwJezQOMb80FjHOz1MS/zJes3yKl1J2jxFLZuGe0744CWa0eUQ01Wk3vUdb4Yqx9FWh+HAP4mC+aM1fC9tBCiH3Hrx+Wj79Cki8rubCF3FHcIwVAuCTqITz9l4ieTvdDiXkgikAnCNFtyogBXsBsDTDhvgKkh4HFIw9AojUwYn7JAxwL8lWCFQH/X6It5LoE8/ya9Tpg/wxDlqGYAd1yto1ImlPUlFDRe43opK7taggQbIbt+NUcIItul0mpSjTll2gPudpkSigE1RRkyvLh4OOeAHvr2h+9YR8pgAmVQbhRAtszKk3rtIXy6yUv/hPCsXjGVMMLbTFj/SsgaRJ2GKH54PjPFKC4xaJQg5Qeqp9WAZXSU0GqgLkLTGD5sQfowkLFhpGnnivA1trLd4HrCaAEPbqUcvmIktpd/895mQhEC26Awn8rkKflFF3N3RNNFJESnXlj686GA9UssUiuWWZPEe7vjzzwxpUSSH1sMe7B29FfXIK3oa8kQwk/SnbbRwaEI0K7IQL2LRmFD1u1sfKFMaUfoP53QdkEM4UAAAAASUVORK5CYII=',
}

export const GAME = {
  totala: { short: 'TA', name: 'Total Annihilation', color: '#e0793a' },
  takingdoms: { short: 'TAK', name: 'TA: Kingdoms', color: '#3a9d7a' },
  custom: { short: '?', name: 'Custom', color: '#6b7488' },
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
