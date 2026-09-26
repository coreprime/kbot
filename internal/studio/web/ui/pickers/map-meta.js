// map-meta.js
//
// The meta line under each map in the Open Map picker: dimensions,
// planet, player count, and a note for a map TA 3.1c does not read as a
// current TA map (the server's `format`: "kingdoms" for a TA: Kingdoms
// 0x4000 map, which only TA: Kingdoms loads; "legacy" for the older 0x1020
// TA layout, which TA reads and the editor saves as 0x2000).

export const MAP_FORMAT_NOTES = {
  kingdoms: 'TA: Kingdoms only',
  legacy: 'old TA format (0x1020)',
}

export function mapMetaLine(m) {
  return [
    m.tileW && m.tileH ? `${m.tileW}×${m.tileH}` : null,
    m.planet || null,
    m.numPlayers ? `${m.numPlayers} players` : null,
    MAP_FORMAT_NOTES[m.format] || null,
  ].filter(Boolean).join(' · ')
}
