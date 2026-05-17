package hpi

// compressLZ77 compresses data using the HPI sliding-window LZ77 format.
//
// Stream layout, per group of up to 8 items:
//   - 1 tag byte (8 flag bits, LSB first)
//   - For each bit (0 = literal, 1 = match):
//       literal: 1 raw byte
//       match:   2 bytes encoding (windowOffset << 4) | (matchLen - 2)
//                giving 12-bit offset (1–4095) and 4-bit length (2–17)
//
// A match with windowOffset == 0 terminates the stream.
//
// Matching uses a 2-byte hash chain over the input data. The decompressor
// reconstructs bytes by reading from a 4096-byte sliding window, so the
// emitted window offset is computed against a tracked windowPos that mirrors
// the decompressor's state — the window content itself isn't needed for
// matching since it always equals the corresponding bytes of the input.
func compressLZ77(data []byte) []byte {
	const (
		windowSize    = 4096
		maxDistance   = 4095
		maxMatchLen   = 17
		minMatchLen   = 2
		hashBits      = 13
		hashSize      = 1 << hashBits
		hashMask      = hashSize - 1
		maxChainDepth = 64
	)

	if len(data) == 0 {
		return []byte{0x01, 0x00, 0x00}
	}

	head := make([]int32, hashSize)
	for i := range head {
		head[i] = -1
	}
	prev := make([]int32, len(data))

	hashAt := func(p int) int {
		return (int(data[p])<<5 ^ int(data[p+1])) & hashMask
	}

	insertHash := func(p int) {
		if p+1 >= len(data) {
			return
		}
		h := hashAt(p)
		prev[p] = head[h]
		head[h] = int32(p)
	}

	windowPos := 1
	out := make([]byte, 0, len(data))
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

			bestLen := 1
			bestWpos := 0
			maxLen := maxMatchLen
			if remaining := len(data) - pos; remaining < maxLen {
				maxLen = remaining
			}

			if pos+1 < len(data) && maxLen >= minMatchLen {
				candidate := int(head[hashAt(pos)])
				chains := 0
				for candidate >= 0 && chains < maxChainDepth {
					dist := pos - candidate
					if dist > maxDistance {
						break
					}
					wpos := (windowPos - dist) & 0xFFF
					if wpos != 0 {
						ml := matchLengthAt(data, pos, dist, maxLen)
						if ml > bestLen {
							bestLen = ml
							bestWpos = wpos
							if bestLen == maxLen {
								break
							}
						}
					}
					candidate = int(prev[candidate])
					chains++
				}
			}

			if bestLen >= minMatchLen {
				tagByte |= 1 << bit
				pair := (bestWpos << 4) | (bestLen - 2)
				group = append(group, byte(pair&0xFF), byte(pair>>8))
				for k := 0; k < bestLen; k++ {
					insertHash(pos)
					windowPos = (windowPos + 1) & 0xFFF
					pos++
				}
			} else {
				insertHash(pos)
				group = append(group, data[pos])
				windowPos = (windowPos + 1) & 0xFFF
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

// matchLengthAt returns how many bytes starting at data[pos] match a back
// reference at distance dist, up to maxLen. The decompressor's
// overlapping-copy semantics are modelled by treating source indices that
// would fall at or past pos as a repetition of the source prefix with period
// dist — equivalently, data[pos+k] is compared against data[pos-dist+(k%dist)].
func matchLengthAt(data []byte, pos, dist, maxLen int) int {
	src := pos - dist
	n := 0
	for n < maxLen {
		idx := src + (n % dist)
		if data[idx] != data[pos+n] {
			break
		}
		n++
	}
	return n
}
