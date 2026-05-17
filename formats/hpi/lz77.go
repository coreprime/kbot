package hpi

// compressLZ77 compresses data using the HPI sliding-window LZ77 format.
//
// Format per group of up to 8 items:
//   - 1 tag byte (8 flag bits, LSB first)
//   - For each bit (0 = literal, 1 = match):
//       literal: 1 raw byte
//       match:   2 bytes encoding (offset, length)
//                packed as (windowOffset << 4) | (matchLen - 2)
//                giving 12-bit offset (1–4095) and 4-bit length (2–17)
//
// The stream is terminated by a match with offset 0 (sentinel).
func compressLZ77(data []byte) []byte {
	const windowSize = 4096

	window := make([]byte, windowSize)
	windowPos := 1
	written := 0 // how many positions have been filled

	var out []byte
	pos := 0

	terminated := false
	for pos < len(data) {
		var tagByte byte
		var group []byte

		for bit := 0; bit < 8; bit++ {
			if pos >= len(data) {
				tagByte |= 1 << bit
				group = append(group, 0, 0)
				terminated = true
				break
			}

			bestLen, bestOff := findMatch(data, pos, window, windowPos, windowSize, written)

			if bestLen >= 2 {
				tagByte |= 1 << bit
				pair := (bestOff << 4) | (bestLen - 2)
				group = append(group, byte(pair&0xFF), byte(pair>>8))

				for i := 0; i < bestLen; i++ {
					window[windowPos] = data[pos]
					windowPos = (windowPos + 1) & 0xFFF
					written++
					pos++
				}
			} else {
				b := data[pos]
				group = append(group, b)
				window[windowPos] = b
				windowPos = (windowPos + 1) & 0xFFF
				written++
				pos++
			}
		}

		out = append(out, tagByte)
		out = append(out, group...)
	}

	if !terminated {
		out = append(out, 0x01, 0x00, 0x00)
	}

	return out
}

// findMatch searches the sliding window for the longest match starting at
// data[pos]. Returns (length, windowOffset) where windowOffset is the
// 0-based position within the 4096-byte window. Returns (0, 0) if no
// match of length ≥ 2 is found.
//
// The match validation must simulate the decompressor's overlapping-copy
// behaviour: during a match, the decompressor reads window[offset+k] while
// simultaneously writing each byte to window[windowPos+k]. If the source
// range overlaps the destination, later reads pick up the freshly written
// values rather than the original window contents.
func findMatch(data []byte, pos int, window []byte, windowPos int, windowSize int, written int) (int, int) {
	maxLen := 17 // 4-bit length field + 2
	remaining := len(data) - pos
	if remaining < maxLen {
		maxLen = remaining
	}
	if maxLen < 2 {
		return 0, 0
	}

	bestLen := 1
	bestOff := 0

	// Only search positions that have actually been written to.
	searchLimit := written
	if searchLimit > windowSize-1 {
		searchLimit = windowSize - 1
	}

	for i := 1; i <= searchLimit; i++ {
		wpos := (windowPos - i) & 0xFFF
		if wpos == 0 {
			continue
		}

		// Check the match while accounting for the decompressor's
		// overlapping-copy semantics: if a source byte falls on a position
		// that has already been written as part of *this* match, the
		// decompressor reads the newly written value.
		matchLen := 0
		srcOff := wpos
		dstOff := windowPos

		// Small buffer tracks bytes written by *this* match so we can
		// detect overlap without copying the whole window each time.
		type pending struct {
			pos int
			val byte
		}
		var written []pending

		for matchLen < maxLen {
			// Determine what the decompressor would read at srcOff.
			b := window[srcOff]
			for _, p := range written {
				if p.pos == srcOff {
					b = p.val
				}
			}
			if b != data[pos+matchLen] {
				break
			}
			written = append(written, pending{dstOff, b})
			srcOff = (srcOff + 1) & 0xFFF
			dstOff = (dstOff + 1) & 0xFFF
			matchLen++
		}

		if matchLen > bestLen {
			bestLen = matchLen
			bestOff = wpos
			if bestLen == maxLen {
				break
			}
		}
	}

	if bestLen < 2 {
		return 0, 0
	}
	return bestLen, bestOff
}
