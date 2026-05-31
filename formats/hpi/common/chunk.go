package common

import (
	"bytes"
	"compress/zlib"
	"encoding/binary"
	"fmt"
	"io"
)

// ChunkHeader describes the 19-byte SQSH header that precedes each compressed
// chunk payload.
type ChunkHeader struct {
	Magic            uint32
	Version          uint8
	CompressionType  uint8
	Encoded          uint8
	CompressedSize   uint32
	DecompressedSize uint32
	Checksum         uint32
}

// DecodeChunk parses a single SQSH chunk whose header starts at the front of
// buf and returns the decompressed payload. The bytes in buf are expected to be
// already decrypted (v2 stores chunks plaintext; v1 callers decrypt the region
// before invoking this). The verified checksum is computed on the stored
// payload before the optional add/XOR transform is reversed.
func DecodeChunk(buf []byte) ([]byte, error) {
	if len(buf) < SQSHHeaderSize {
		return nil, fmt.Errorf("chunk too small: %d bytes", len(buf))
	}
	if binary.LittleEndian.Uint32(buf[:4]) != ChunkMarker {
		return nil, fmt.Errorf("invalid SQSH marker: 0x%X", binary.LittleEndian.Uint32(buf[:4]))
	}
	compType := buf[5]
	encoded := buf[6]
	compSize := binary.LittleEndian.Uint32(buf[7:11])
	decompSize := binary.LittleEndian.Uint32(buf[11:15])
	checksum := binary.LittleEndian.Uint32(buf[15:19])

	if uint64(SQSHHeaderSize)+uint64(compSize) > uint64(len(buf)) {
		return nil, fmt.Errorf("compressed payload %d exceeds buffer (%d available)", compSize, len(buf)-SQSHHeaderSize)
	}
	payload := make([]byte, compSize)
	copy(payload, buf[SQSHHeaderSize:SQSHHeaderSize+compSize])

	if sum := Checksum(payload); sum != checksum {
		return nil, fmt.Errorf("SQSH checksum mismatch: expected 0x%X, got 0x%X", checksum, sum)
	}
	if encoded != 0 {
		DecodeChunkBuffer(payload)
	}

	return decompressChunkPayload(compType, payload, decompSize)
}

// decompressChunkPayload applies the chunk's compression algorithm to an
// already-decoded payload, validating the decompressed length against the
// header's stated size.
func decompressChunkPayload(compType uint8, payload []byte, decompSize uint32) ([]byte, error) {
	switch compType {
	case CompressionNone:
		if uint32(len(payload)) != decompSize {
			return nil, fmt.Errorf("stored chunk size mismatch: header says %d, payload has %d", decompSize, len(payload))
		}
		return payload, nil
	case CompressionZLib:
		zr, err := zlib.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, fmt.Errorf("zlib reader: %w", err)
		}
		defer func() { _ = zr.Close() }()
		out, err := io.ReadAll(zr)
		if err != nil {
			return nil, fmt.Errorf("zlib decode: %w", err)
		}
		if uint32(len(out)) != decompSize {
			return nil, fmt.Errorf("zlib chunk size mismatch: header says %d, decoded %d", decompSize, len(out))
		}
		return out, nil
	case CompressionLZ77:
		return DecompressLZ77(payload, int(decompSize))
	default:
		return nil, fmt.Errorf("unknown SQSH compression type: %d", compType)
	}
}
