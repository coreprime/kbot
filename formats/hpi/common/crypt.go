package common

// HPI uses a position-dependent XOR cipher for v1 directory and chunk regions,
// plus a separate per-position add/XOR transform applied to each compressed
// chunk payload. Both schemes are symmetric helpers shared by the readers and
// writer.

// DecryptBuffer decrypts data in place using HPI's position-dependent XOR.
// seed is the low byte of the file offset the buffer was read from. A key of 0
// leaves the data untouched (unencrypted archive).
func DecryptBuffer(key uint8, seed uint8, data []byte) {
	if key == 0 {
		return
	}
	for i := 0; i < len(data); i++ {
		pos := seed + uint8(i)
		data[i] ^= pos ^ key
	}
}

// EncryptInPlace XORs each byte of data with (uint8(startOffset+i) ^ key).
// This is the symmetric inverse of DecryptBuffer; applying it again with the
// same key and offset yields the original bytes.
func EncryptInPlace(key uint8, startOffset int64, data []byte) {
	if key == 0 {
		return
	}
	for i := range data {
		p := uint8(uint64(startOffset) + uint64(i))
		data[i] ^= p ^ key
	}
}

// TransformHeaderKey converts the raw HeaderKey value stored in the HPI header
// into the per-byte XOR key used to (de)scramble the directory and chunk
// regions. A HeaderKey of 0 disables encryption.
func TransformHeaderKey(headerKey uint8) uint8 {
	if headerKey == 0 {
		return 0
	}
	return (headerKey << 2) | (headerKey >> 6)
}

// DecodeChunkBuffer reverses the per-chunk add/XOR transform: for each byte at
// position i it computes (b - i) ^ i using uint8 arithmetic.
func DecodeChunkBuffer(data []byte) {
	for i := 0; i < len(data); i++ {
		pos := uint8(i)
		data[i] = (data[i] - pos) ^ pos
	}
}

// EncodeChunkBuffer applies the per-chunk add/XOR transform: for each byte at
// position i it computes (b ^ i) + i. It is the inverse of DecodeChunkBuffer.
func EncodeChunkBuffer(data []byte) {
	for i := range data {
		pos := uint8(i)
		data[i] = (data[i] ^ pos) + pos
	}
}

// Checksum computes the HPI chunk checksum (the 32-bit sum of all bytes).
func Checksum(data []byte) uint32 {
	var sum uint32
	for _, b := range data {
		sum += uint32(b)
	}
	return sum
}
