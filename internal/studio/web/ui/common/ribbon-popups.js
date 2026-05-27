// ribbon-popups.js
//
// Generic helpers for the legacy (pre-React) ribbon dropdown popups
// shared between the map editor, the unit editor, and the developer
// dialog wiring.  Both helpers operate purely on `.ribbon-dropdown-popup`
// DOM elements via getBoundingClientRect — they don't know which
// editor section opened the popup, so they live in /ui/common/ and
// are imported by every consumer (legacy-popups.js, wire-toolbar.js,
// schema-selector.js, wire-dialogs.js).
//
// Keeping them here avoids /ui/common/ reaching down into
// /ui/map-editor/ for what is really a generic chrome utility.

import { $$ } from '../host-context.js'

// closeAllRibbonDropdowns hides every `.ribbon-dropdown-popup` in the
// document except `except` (which the caller is about to open).  Used
// by every ribbon button click handler so dropdowns are mutually
// exclusive.
export function closeAllRibbonDropdowns(except) {
  $$('.ribbon-dropdown-popup').forEach((el) => {
    if (el !== except) el.classList.add('hidden')
  })
}

// positionRibbonPopup anchors a fixed-position popup directly below
// its triggering button, in viewport coordinates so it escapes the
// ribbon's overflow clipping.  Run on every open so subsequent
// toolbar resizes don't strand the popup.
export function positionRibbonPopup(button, popup) {
  if (!button || !popup) return
  const rect = button.getBoundingClientRect()
  popup.style.top = (rect.bottom + 4) + 'px'
  popup.style.left = rect.left + 'px'
}
