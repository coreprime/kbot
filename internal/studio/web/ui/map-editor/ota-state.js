// ota-state.js
//
// Pure helpers for the map editor's .ota state (no DOM), shared by the
// Map properties and schema dialogs and the map loader, and covered by
// node --test.
//
// The server edits a loaded map's .ota in place on save: every schema and
// start position the load returned carries where it came from (`source`,
// `special`), and the state carries the file itself (`source`). A value
// the editor leaves alone is written back exactly as the file had it, so
// the dialogs must not rewrite fields the user did not touch.

// otaValueError returns why text cannot be written as an .ota value, or ''
// when it can.  These are the checks the server applies on save (kbot-io's
// tdf.CheckValue): the game ends a value at the first ';', treats "//" and
// "/*" as comments, stops reading at a NUL byte and trims spaces, tabs and
// line breaks from both ends.
export function otaValueError(text) {
  const s = String(text ?? '')
  if (s.includes('\u0000')) return 'contains a NUL character, which ends the file'
  if (s.includes('//') || s.includes('/*')) return 'contains a comment start (// or /*), which hides the rest of the line'
  if (s.includes(';')) return "contains ';', which ends the value"
  if (s !== cleanOTAText(s)) return 'starts or ends with a space or line break, which the game drops'
  return ''
}

// cleanOTAText trims the characters the game trims from both ends of a
// value (space, tab, CR, LF), so the state holds what the game reads.
export function cleanOTAText(text) {
  return String(text ?? '').replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '')
}

// firstOTAValueError checks named dialog fields ({ label: text }) and
// returns the first problem as "Label: reason", or ''.
export function firstOTAValueError(fields) {
  for (const [label, text] of Object.entries(fields)) {
    const err = otaValueError(text)
    if (err) return `${label}: ${err}`
  }
  return ''
}

// parseOTANumber reads a dialog number field: a fraction when `fraction`
// is set (the game reads tidalstrength, killmul, timemul and the meteor
// settings as fractions), otherwise a whole number.  Blank or invalid
// text reads as 0.
export function parseOTANumber(text, fraction = false) {
  const v = fraction ? parseFloat(text) : parseInt(text, 10)
  return Number.isFinite(v) ? v : 0
}

// editorOTAState turns the `ota` of a /api/studio/load response into the
// editor's state.  With no .ota the map gets `fallback` (a new file is
// written on save).  An .ota the server could not read keeps its source
// and error so the save leaves the file unchanged; the editor shows
// `fallback`'s settings without inventing start positions.
export function editorOTAState(ota, fallback) {
  if (!ota) return fallback
  if (!ota.error) return ota
  return {
    ...fallback,
    schemas: (fallback.schemas || []).map((s) => ({ ...s, startPositions: [] })),
    seaLevel: ota.seaLevel ?? fallback.seaLevel,
    source: ota.source,
    error: ota.error,
  }
}

// newSchemaFrom makes a new schema from an existing one's settings: the
// copy is new to the file, so it drops the source schema's identity, and
// `fields` (name, type, start positions) replace the copied values.
export function newSchemaFrom(proto, fields) {
  const copy = { ...(proto || {}), ...fields }
  delete copy.source
  return copy
}
