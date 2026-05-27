// constants.js
//
// Map-editor-only literal values.  Pure data — no DOM, no state, no
// imports from studio.js — so this module is safe to import from
// either the legacy studio.js host or the React /ui/map-editor/ tree
// without risking a circular dependency.
//
// Nothing in this file is shared with the unit editor or sandbox
// views.  Constants that BOTH tabs needed (e.g. ribbon button labels,
// floating-panel ids) live in /ui/common/ instead.

// ── Canvas + tile geometry ──────────────────────────────────────────
// One map tile renders as TILE_PX × TILE_PX css pixels.  The TA engine
// itself uses 32 game-pixels per tile, so this happens to be 1:1 — but
// the unit conversion is *intentional* here (we could zoom-render at a
// different ratio in the future), so callers should always reach for
// TILE_PX rather than re-deriving 32.
export const TILE_PX = 32

// Background fill drawn behind unstamped cells.  Picked to be visibly
// distinct from any stock TA tile so the user can spot voids without
// having to toggle the grid overlay.
export const VOID_COLOR = '#1d3045'

// ── Schema + start positions ────────────────────────────────────────
// MAX_START_POSITIONS — the hard upper bound on how many StartPos
// entries a schema can hold.  TA caps multiplayer at 10 players so the
// editor never lets you place more than this.  Bump here if a future
// spinoff supports more than 10.
export const MAX_START_POSITIONS = 10

// ── Quality checker pacing ──────────────────────────────────────────
// The server can finish every check in tens of ms which makes the
// dialog feel like a placebo — the user clicks Save and the window
// flashes once.  These two minimums give every check visible breathing
// room (250ms of "running" before its result is revealed) and
// guarantee the window itself sticks around long enough to read
// (1.5s total).  Bump if the dialog still feels rushed.
export const QUALITY_CHECK_MIN_MS = 250
export const QUALITY_WINDOW_MIN_MS = 1500

// ── Buildable-area overlay tuning ───────────────────────────────────
// Matches TA's per-attribute-cell build-grid rules well enough for an
// editor preview:
//   - The cell can't be a void.
//   - The cell can't be submerged below sea level (land structures
//     are the common case; ship-pad cells light up only when the
//     map has no impassible water, which the editor doesn't model
//     here — close enough for a quick overlay).
//   - The slope into every cardinal neighbour must stay within
//     BUILDABLE_MAX_SLOPE height units.  12 is the middle of the
//     stock TA structure MaxSlope range (3 for tank pads, 25 for
//     KBot factories) and gives a generic "any builder could plant
//     a factory here" answer.
export const BUILDABLE_MAX_SLOPE = 12
export const BUILDABLE_FILL = 'rgba(96, 180, 255, 0.34)'

// ── Keyboard map navigation ─────────────────────────────────────────
// Held arrow keys pan continuously via a requestAnimationFrame loop
// with a linear acceleration ramp from 1× to MAP_PAN_ACCEL_MAX_MULT
// over MAP_PAN_ACCEL_TIME_MS — quick taps stay precise, long holds
// race across big maps.  Speed is in canvas-pixel space (i.e.
// pre-zoom) so the on-screen panning rate stays constant regardless
// of zoom level.  Zoom step matches the +/- toolbar buttons via
// state.settings.zoomStep.
export const MAP_PAN_RATE_PX_S = 720
export const MAP_PAN_ACCEL_MAX_MULT = 3
export const MAP_PAN_ACCEL_TIME_MS = 2000

// ── Worlds ──────────────────────────────────────────────────────────
// WORLDS is the single source of truth for the distinct worlds the
// editor recognises.  One entry per world — Mars and Moon are their
// own rows rather than being collapsed into "Mars / Desert" or
// "Moon / Lunar" pairs.  Used to populate the New-map + OTA
// Properties planet pickers AND to translate "Set as active" clicks
// on the sections drawer into a state.planet value.
//   slug:           matches the section drawer's world folder + the
//                   value stored in state.planet (lowercased).
//   label:          shown in pickers + drawer pills.
//   defaultTileset: the canonical value written to the .ota's planet
//                   field for this world (TA's stock OTAs use these
//                   display-cased names).
//   aliases:        additional strings (beyond slug + defaultTileset)
//                   that should still resolve to this world on read.
export const WORLDS = [
  { slug: 'greenworld',  label: 'Green',       defaultTileset: 'Green',  aliases: [] },
  { slug: 'metal',       label: 'Metal',       defaultTileset: 'Metal',  aliases: [] },
  { slug: 'mars',        label: 'Mars',        defaultTileset: 'Desert', aliases: [] },
  { slug: 'moon',        label: 'Moon',        defaultTileset: 'Lunar',  aliases: [] },
  { slug: 'archipelago', label: 'Archipelago', defaultTileset: 'Water',  aliases: [] },
  { slug: 'lava',        label: 'Lava',        defaultTileset: 'Lava',   aliases: [] },
  { slug: 'acid',        label: 'Acid',        defaultTileset: 'Acid',   aliases: [] },
  { slug: 'slate',       label: 'Slate',       defaultTileset: 'Slate',  aliases: [] },
]

// ── Drawer (sidebar) virtualisation ─────────────────────────────────
// Tile + feature drawers use IntersectionObserver to keep only the
// items near the viewport mounted.  DRAWER_ITEM_HEIGHT matches the css
// row height; DRAWER_OBSERVER_MARGIN expands the observer's hit
// region so rows materialise a screenful before they're scrolled
// into view (smoother scroll, no popping).
export const DRAWER_ITEM_HEIGHT = 60
export const DRAWER_OBSERVER_MARGIN = '400px 0px'

// ── Undo / redo ─────────────────────────────────────────────────────
// UNDO_MAX caps the stored history at a length that comfortably
// covers a session's worth of edits without ballooning memory on big
// maps (each snapshot holds the tile + height + void arrays).
// HISTORY_FLYOUT_N is how many entries each of the Undo / Redo hover
// flyouts surfaces — the menu is for spot-jumping, not full history
// review.
export const UNDO_MAX = 50
export const HISTORY_FLYOUT_N = 5

// ── System clipboard (Ctrl+C / Ctrl+V) ──────────────────────────────
// Magic prefix that tags KBot-Studio clipboard payloads so paste
// handlers can tell our JSON apart from arbitrary text in the OS
// clipboard.  Bump the V1 suffix if the payload schema changes.
export const CLIP_PREFIX = 'KBOTSTUDIO_CLIP_V1:'

// ── Feature picker ──────────────────────────────────────────────────
// How far from the click tile to search for candidate features.
// Sprites can extend off their anchor; this is the upper bound for
// typical TA sprites (~5 tiles ≈ 160 game pixels).
export const FEATURE_HIT_SEARCH_TILES = 6

// FEATURE_HIGHLIGHT_LIMIT disables the hover-highlight passes
// (canvas red outlines + minimap dots) on heavily populated maps.
// At thousands of features the outline pass becomes the dominant
// cost on each mouse-move; below the limit the visual cue is more
// useful than the cost.
export const FEATURE_HIGHLIGHT_LIMIT = 1000

// ── Start positions ─────────────────────────────────────────────────
// canvas-px hit radius when picking a start position.
export const START_POS_RADIUS = 26

// ── Heightmap brush ─────────────────────────────────────────────────
// Hold-to-repeat interval for raise / lower / smooth — the brush
// keeps firing while the user holds the mouse button still so big
// changes sculpt without the user having to wiggle the cursor.
export const HM_HOLD_INTERVAL_MS = 60

// ── Dice-face player-count picker (size dialog) ─────────────────────
// Lives inside #size-dialog.  Selecting multiple counts seeds that
// many Network N schemas when the editor starts.
export const DICE_PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10]

// PLAYER_COUNT_NAMES — used for both the dice picker caption and the
// schema row labels so the wording stays consistent everywhere.
export const PLAYER_COUNT_NAMES = {
  2: 'Two Players',
  3: 'Three Players',
  4: 'Four Players',
  5: 'Five Players',
  6: 'Six Players',
  7: 'Seven Players',
  8: 'Eight Players',
  9: 'Nine Players',
  10: 'Ten Players',
}

// DICE_PIP_POSITIONS — each entry is a list of [x, y] normalised to
// the pip area (0..1).  Faces 1..6 are the canonical d6 layouts; 7..10
// extend the pattern dominos-style (3-1-3, 3-2-3, 3-3-3, 4-2-4).  The
// arrays here are what's actually rendered, so the dot count matches
// the player count by construction.
export const DICE_PIP_POSITIONS = {
  1:  [[0.50, 0.50]],
  2:  [[0.25, 0.25], [0.75, 0.75]],
  3:  [[0.22, 0.22], [0.50, 0.50], [0.78, 0.78]],
  4:  [[0.25, 0.25], [0.75, 0.25], [0.25, 0.75], [0.75, 0.75]],
  5:  [[0.22, 0.22], [0.78, 0.22], [0.50, 0.50], [0.22, 0.78], [0.78, 0.78]],
  6:  [[0.25, 0.18], [0.75, 0.18], [0.25, 0.50], [0.75, 0.50], [0.25, 0.82], [0.75, 0.82]],
  7:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.50, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  8:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.22, 0.50], [0.78, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  9:  [[0.22, 0.18], [0.50, 0.18], [0.78, 0.18], [0.22, 0.50], [0.50, 0.50], [0.78, 0.50], [0.22, 0.82], [0.50, 0.82], [0.78, 0.82]],
  10: [[0.18, 0.18], [0.39, 0.18], [0.61, 0.18], [0.82, 0.18], [0.32, 0.50], [0.68, 0.50], [0.18, 0.82], [0.39, 0.82], [0.61, 0.82], [0.82, 0.82]],
}

// ── Schemas ─────────────────────────────────────────────────────────
// Schemas are addressed by their player count (the "Network N" the
// schema's Type ends in).  Treating count as the identity keeps the
// add-grid in sync — counts already present are disabled, the rest
// can be added with one click.
export const SCHEMA_PLAYER_COUNTS = [2, 3, 4, 5, 6, 7, 8, 9, 10]
