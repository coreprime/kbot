// keyboard.js
//
// Welcome-screen keyboard navigation: Arrow keys move focus
// between the two welcome cards (New / Open), Enter activates the
// focused card (or the default New card when nothing's focused).
// Ctrl+Up / Ctrl+Left/Right are reserved for future tab switching
// (Mapping / Modelling / Scripting / Other) — not wired yet.
//
// Mounts on first call; observes #welcome-dialog's hidden class so
// the New card auto-focuses on every re-show (e.g. closing the
// last map tab pops the welcome dialog back).  No host state.

import { $ } from '../../host-context.js'

export function wireWelcomeKeyboard() {
  const wel = $('#welcome-dialog')
  const cards = [$('#welcome-new'), $('#welcome-open')]
  if (!wel || cards.some((c) => !c)) return
  const focusCard = (i) => {
    const idx = ((i % cards.length) + cards.length) % cards.length
    cards[idx].focus()
  }
  wel.addEventListener('keydown', (e) => {
    if (wel.classList.contains('hidden')) return
    const i = cards.indexOf(document.activeElement)
    if (e.key === 'ArrowLeft') {
      e.preventDefault()
      focusCard(i < 0 ? 0 : i - 1)
    } else if (e.key === 'ArrowRight') {
      e.preventDefault()
      focusCard(i < 0 ? 0 : i + 1)
    } else if (e.key === 'Enter') {
      // Enter is already native button activation when a card has
      // focus.  We only intercept when nothing's focused so the
      // user gets a sensible default (the New card).
      if (i < 0) {
        e.preventDefault()
        cards[0].click()
      }
    }
  })
  // Focus New on first show.  MutationObserver fires whenever the
  // welcome dialog's class list changes so re-shows (closing a
  // map back to welcome) re-focus too.
  const sync = () => {
    if (wel.classList.contains('hidden')) return
    // rAF defers the focus call until the dialog is actually
    // displayed — Chrome ignores focus() on a hidden ancestor.
    requestAnimationFrame(() => {
      if (!wel.classList.contains('hidden')) cards[0].focus()
    })
  }
  new MutationObserver(sync).observe(wel, { attributes: true, attributeFilter: ['class'] })
  sync()
}
