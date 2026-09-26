// start-positions.js
//
// Player start positions from the /api/studio/sandbox-map JSON. The server
// numbers each schema's StartPos entries the way the game does (StartPosN is
// player slot N-1, StartPos0 slot 0, an unnumbered StartPos the next implicit
// number) and never invents positions; this picks a slot's position out of
// that list. Pure so it can be unit-tested without a view.

// playerStart returns the start position of a player slot (0 = player 1): the
// first entry numbered into that slot, or null when the schema gives the slot
// none.
export function playerStart(info, slot = 0) {
  const starts = Array.isArray(info?.startPositions) ? info.startPositions : []
  return starts.find((sp) => sp && Number.isInteger(sp.slot) && sp.slot === slot) || null
}
