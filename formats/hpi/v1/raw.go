package v1

import (
	"encoding/binary"
	"fmt"
	"io"

	"github.com/coreprime/kbot/formats/hpi/common"
)

// ReadRawFileData returns the raw on-disk bytes for a compressed file entry:
// the chunk size table followed by the SQSH chunk headers and their payloads.
// This is the exact byte sequence stored in the archive (after decryption),
// suitable for writing back verbatim into a new archive via AddRawEntry.
func (r *Reader) ReadRawFileData(entry *common.Entry) ([]byte, error) {
	if entry.IsDir {
		return nil, fmt.Errorf("cannot read raw data for a directory")
	}

	numChunks := entry.Size / chunkMaxDecomp
	if entry.Size%chunkMaxDecomp != 0 {
		numChunks++
	}

	if _, err := r.file.Seek(int64(entry.Offset), io.SeekStart); err != nil {
		return nil, err
	}

	sizeTableBytes, err := r.readDecryptBytes(int(numChunks) * 4)
	if err != nil {
		return nil, fmt.Errorf("reading chunk size table: %w", err)
	}

	totalChunkData := 0
	for i := uint32(0); i < numChunks; i++ {
		totalChunkData += int(binary.LittleEndian.Uint32(sizeTableBytes[i*4:]))
	}

	chunkPayload, err := r.readDecryptBytes(totalChunkData)
	if err != nil {
		return nil, fmt.Errorf("reading chunk data: %w", err)
	}

	raw := make([]byte, len(sizeTableBytes)+len(chunkPayload))
	copy(raw, sizeTableBytes)
	copy(raw[len(sizeTableBytes):], chunkPayload)
	return raw, nil
}

// ReadTrailer returns any bytes that follow the last file's chunk data up to
// the end of the archive. Returns nil if there is no trailing data.
func (r *Reader) ReadTrailer() ([]byte, error) {
	var maxEnd int64
	if r.root != nil {
		_ = r.root.Walk(func(e *common.Entry) error {
			if e.IsDir {
				return nil
			}
			numChunks := e.Size / chunkMaxDecomp
			if e.Size%chunkMaxDecomp != 0 {
				numChunks++
			}
			if _, err := r.file.Seek(int64(e.Offset), io.SeekStart); err != nil {
				return nil
			}
			sizeTable, err := r.readDecryptBytes(int(numChunks) * 4)
			if err != nil {
				return nil
			}
			total := int64(e.Offset) + int64(numChunks)*4
			for i := uint32(0); i < numChunks; i++ {
				total += int64(binary.LittleEndian.Uint32(sizeTable[i*4:]))
			}
			if total > maxEnd {
				maxEnd = total
			}
			return nil
		})
	}

	fileSize, err := r.file.Seek(0, io.SeekEnd)
	if err != nil {
		return nil, err
	}

	if maxEnd >= fileSize {
		return nil, nil
	}

	trailerLen := fileSize - maxEnd
	if _, err := r.file.Seek(maxEnd, io.SeekStart); err != nil {
		return nil, err
	}
	trailer := make([]byte, trailerLen)
	if _, err := io.ReadFull(r.file, trailer); err != nil {
		return nil, err
	}
	return trailer, nil
}
