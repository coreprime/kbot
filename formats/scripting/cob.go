package scripting

import (
	"bytes"
	"encoding/binary"
	"fmt"
	"io"
	"os"

	"github.com/coreprime/kbot/filesystem"
)

// COB represents a compiled BOS script (Total Annihilation format).
type COB struct {
	// Header fields (11 DWORDs for TA's VersionSignature=4 files; TA: Kingdoms
	// uses VersionSignature=6 and inserts an 8-byte sub-header before the code
	// section plus a per-COB sound-name table after the piece names — both
	// are reconstructed from the structured fields below, not preserved as
	// opaque bytes.)
	VersionSignature              uint32 // [0] Version (4 for TA, 6 for TA: Kingdoms)
	NumScripts                    uint32 // [1] Number of scripts
	NumPieces                     uint32 // [2] Number of pieces
	LengthOfScripts               uint32 // [3] Total code size in DWORDs
	NumberOfStaticVars            uint32 // [4] Number of static variables
	UKZero                        uint32 // [5] Always 0 in retail bytecode; purpose unknown
	OffsetToScriptCodeIndexArray  uint32 // [6] Offset to script index array
	OffsetToScriptNameOffsetArray uint32 // [7] Offset to script name array (ABSOLUTE offsets)
	OffsetToPieceNameOffsetArray  uint32 // [8] Offset to piece name array (ABSOLUTE offsets)
	OffsetToScriptCode            uint32 // [9] Offset to script code
	OffsetToNameArray             uint32 // [10] Start of the trailing offset/string region (begins at the sound-name offset table for v6, otherwise the script-name pool start)

	// Parsed data
	Code              []byte
	ScriptCodeIndices []uint32 // Indices from OffsetToScriptCodeIndexArray
	ScriptNames       []string
	PieceNames        []string

	// SoundNames is the TA: Kingdoms–only addendum to the string pool.
	// v6 .cob files insert a `len(SoundNames)` × uint32 offset table
	// after the piece-name offset array (pointed at by the 8-byte extra
	// sub-header at file offset 0x2C), followed by the actual strings in
	// order. The MISSION_COMMAND opcode (0x10073000) references them by
	// index via its first inline DWORD; the offset table and sub-header
	// are reconstructed from this slice on write — for TA's v4 .cob files
	// the slice is always nil and the wrapping pieces are omitted.
	SoundNames []string
}

// LoadFromFile reads a COB file from the local filesystem
func LoadFromFile(path string) (*COB, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer func() { _ = f.Close() }()

	return LoadFromReader(f)
}

// LoadFromFilesystem reads a COB file from a virtual filesystem
func LoadFromFilesystem(fs filesystem.FileSystem, path string) (*COB, error) {
	data, err := fs.ReadFile(path)
	if err != nil {
		return nil, err
	}

	return LoadFromReader(bytes.NewReader(data))
}

// LoadFromReader reads a COB from an io.Reader (streaming)
// Instruction represents a single disassembled COB instruction.
func LoadFromReader(r io.Reader) (*COB, error) {
	cob := &COB{}

	// Read entire file first (need random access)
	allData, err := io.ReadAll(r)
	if err != nil {
		return nil, fmt.Errorf("failed to read file: %w", err)
	}

	// Read header (11 uint32s = 44 bytes)
	if len(allData) < 44 {
		return nil, fmt.Errorf("file too small for header")
	}
	
	cob.VersionSignature = binary.LittleEndian.Uint32(allData[0:4])
	cob.NumScripts = binary.LittleEndian.Uint32(allData[4:8])
	cob.NumPieces = binary.LittleEndian.Uint32(allData[8:12])
	cob.LengthOfScripts = binary.LittleEndian.Uint32(allData[12:16])
	cob.NumberOfStaticVars = binary.LittleEndian.Uint32(allData[16:20])
	cob.UKZero = binary.LittleEndian.Uint32(allData[20:24])
	cob.OffsetToScriptCodeIndexArray = binary.LittleEndian.Uint32(allData[24:28])
	cob.OffsetToScriptNameOffsetArray = binary.LittleEndian.Uint32(allData[28:32])
	cob.OffsetToPieceNameOffsetArray = binary.LittleEndian.Uint32(allData[32:36])
	cob.OffsetToScriptCode = binary.LittleEndian.Uint32(allData[36:40])
	cob.OffsetToNameArray = binary.LittleEndian.Uint32(allData[40:44])

	// TA: Kingdoms .cob files (VersionSignature == 6) insert an 8-byte
	// sub-header at file offset 0x2C: two little-endian uint32s holding
	// the absolute offset of the sound-name offset table and the number
	// of sound names. Both values are redundant with the canonical
	// layout we reconstruct on write (the offset == start of the
	// trailing offset table, and the count == len(SoundNames)) so we
	// only consult the count here. For TA v4 .cob files this sub-header
	// is absent.
	var soundNameCount uint32
	if cob.OffsetToScriptCode > 44 && cob.VersionSignature == 6 {
		end := cob.OffsetToScriptCode
		if end > uint32(len(allData)) {
			end = uint32(len(allData))
		}
		if end >= 52 {
			soundNameCount = binary.LittleEndian.Uint32(allData[48:52])
		}
	}

	// Read code section (starts at OffsetToScriptCode)
	codeStart := cob.OffsetToScriptCode
	// Code ends at the first offset table
	codeEnd := cob.OffsetToScriptCodeIndexArray
	if codeEnd <= codeStart {
		return nil, fmt.Errorf("invalid code bounds")
	}
	cob.Code = allData[codeStart:codeEnd]

	// Read script code indices (NOT offsets!)
	// Per doc: "Offset to a script is calculated by: OffsetToScriptCode + (ScriptCodeIndexArray[ScriptNumber] * 4)"
	cob.ScriptCodeIndices = make([]uint32, cob.NumScripts)
	idxPos := cob.OffsetToScriptCodeIndexArray
	for i := uint32(0); i < cob.NumScripts; i++ {
		if idxPos+4 > uint32(len(allData)) {
			return nil, fmt.Errorf("script index %d out of bounds", i)
		}
		cob.ScriptCodeIndices[i] = binary.LittleEndian.Uint32(allData[idxPos : idxPos+4])
		idxPos += 4
	}

	// Read script names
	cob.ScriptNames = make([]string, cob.NumScripts)
	namePos := cob.OffsetToScriptNameOffsetArray
	for i := uint32(0); i < cob.NumScripts; i++ {
		if namePos+4 > uint32(len(allData)) {
			break
		}
		offset := binary.LittleEndian.Uint32(allData[namePos : namePos+4])
		if offset > 0 && offset < uint32(len(allData)) {
			cob.ScriptNames[i] = readCString(allData[offset:])
		}
		namePos += 4
	}

	// Read piece names
	cob.PieceNames = make([]string, cob.NumPieces)
	piecePos := cob.OffsetToPieceNameOffsetArray
	for i := uint32(0); i < cob.NumPieces; i++ {
		if piecePos+4 > uint32(len(allData)) {
			break
		}
		offset := binary.LittleEndian.Uint32(allData[piecePos : piecePos+4])
		if offset > 0 && offset < uint32(len(allData)) {
			cob.PieceNames[i] = readCString(allData[offset:])
		}
		piecePos += 4
	}

	// TA: Kingdoms v6 .cob files append an extra offset table immediately
	// after the piece-name offset array (entry count from the sub-header
	// captured above) followed by the strings those offsets point at. The
	// strings are referenced from the bytecode by index and carry things
	// like spawn-target unit codes ("ARROW10", "ARAPRIESDIE1") for unit
	// scripts and engine-command strings ("SetMission o 1, s") for the
	// mission COBs — picked up by the MISSION_COMMAND opcode.
	if soundNameCount > 0 {
		cob.SoundNames = make([]string, soundNameCount)
		cmdPos := cob.OffsetToPieceNameOffsetArray + cob.NumPieces*4
		for i := uint32(0); i < soundNameCount; i++ {
			if cmdPos+4 > uint32(len(allData)) {
				break
			}
			offset := binary.LittleEndian.Uint32(allData[cmdPos : cmdPos+4])
			if offset > 0 && offset < uint32(len(allData)) {
				cob.SoundNames[i] = readCString(allData[offset:])
			}
			cmdPos += 4
		}
	}

	return cob, nil
}

// readCString reads a null-terminated C string
func readCString(data []byte) string {
	for i, b := range data {
		if b == 0 {
			return string(data[:i])
		}
	}
	return string(data)
}

// Instruction represents a single COB bytecode instruction (nTA format)
type Instruction struct {
	Offset   uint32
	Opcode   uint32  // Full 32-bit nTA opcode
	Operand  int32   // First 32-bit parameter (for 1-param opcodes)
	Operand2 int32   // Second 32-bit parameter (for 2-param opcodes like TURN)
}

// Disassemble disassembles the bytecode into instructions
func (c *COB) Disassemble(scriptIndex int) ([]Instruction, error) {
	if scriptIndex < 0 || scriptIndex >= int(c.NumScripts) {
		return nil, fmt.Errorf("invalid script index %d", scriptIndex)
	}

	// Calculate script offset per doc: OffsetToScriptCode + (ScriptCodeIndexArray[ScriptNumber] * 4)
	// But since c.Code already starts at OffsetToScriptCode, we just use the index directly
	offset := c.ScriptCodeIndices[scriptIndex] * 4
	if offset >= uint32(len(c.Code)) {
		return nil, fmt.Errorf("invalid script offset 0x%X", offset)
	}

	var instructions []Instruction
	pos := offset

	// Find end offset (next script or end of code)
	endPos := uint32(len(c.Code))
	for i := scriptIndex + 1; i < int(c.NumScripts); i++ {
		nextOffset := c.ScriptCodeIndices[i] * 4
		if nextOffset > offset && nextOffset < endPos {
			endPos = nextOffset
			break
		}
	}

	// Decode instructions (TA COB format: 32-bit opcode, optional parameters)
	instCount := 0
	for pos < endPos && pos+4 <= uint32(len(c.Code)) {
		// Read 32-bit LITTLE-ENDIAN opcode (as documented in ta-cob-fmt.txt)
		opcode := uint32(c.Code[pos]) | (uint32(c.Code[pos+1]) << 8) | 
		          (uint32(c.Code[pos+2]) << 16) | (uint32(c.Code[pos+3]) << 24)
		// Check if this opcode expects inline parameters (Post Data)
		var operand, operand2 int32
		paramCount := OpcodeParamCount(opcode)
		
		if paramCount > 0 && pos+4+uint32(paramCount*4) <= uint32(len(c.Code)) {
			// Read first parameter as little-endian (TA format)
			operand = int32(uint32(c.Code[pos+4]) | (uint32(c.Code[pos+5]) << 8) | 
			               (uint32(c.Code[pos+6]) << 16) | (uint32(c.Code[pos+7]) << 24))
			
			// Read second parameter if present
			if paramCount >= 2 && pos+8+4 <= uint32(len(c.Code)) {
				operand2 = int32(uint32(c.Code[pos+8]) | (uint32(c.Code[pos+9]) << 8) | 
				                (uint32(c.Code[pos+10]) << 16) | (uint32(c.Code[pos+11]) << 24))
			}
		}

		instructions = append(instructions, Instruction{
			Offset:   pos,
			Opcode:   opcode,
			Operand:  operand,
			Operand2: operand2,
		})

		// Advance position (4 bytes for opcode + N*4 bytes for parameters)
		pos += 4 + uint32(paramCount*4)
		instCount++
	}

	return instructions, nil
}

// String returns a string representation of the instruction (TA COB format)
func (i Instruction) String() string {
	name := OpcodeName(i.Opcode)
	if name == "" {
		name = fmt.Sprintf("UNKNOWN_0x%08X", i.Opcode)
	}
	if i.Operand != 0 || OpcodeHasInlineParam(i.Opcode) {
		return fmt.Sprintf("%04X: %-20s %d (0x%X)", i.Offset, name, i.Operand, i.Operand)
	}
	return fmt.Sprintf("%04X: %s", i.Offset, name)
}

// SaveToFile writes the COB to a file
func (c *COB) SaveToFile(filename string) error {
	f, err := os.Create(filename)
	if err != nil {
		return err
	}
	defer func() { _ = f.Close() }()
	
	return c.WriteToWriter(f)
}

// WriteToWriter writes the COB to a writer.
//
// The on-disk layout is fully reconstructed from the structured fields —
// no opaque-byte preservation. For TA's v4 dialect:
//
//	header (44) · code · script-code-index array · script-name offsets
//	  · piece-name offsets · string pool
//
// For TA: Kingdoms v6 .cob files an 8-byte sub-header (sound-name
// offset-table location + count) is inserted between the canonical header
// and the code section, and the trailing layout grows a sound-name
// offset table immediately after the piece-name array. The string pool
// is laid out script names → piece names → sound names, in that order,
// with all offsets and the v6 sub-header reconstructed from the
// structured fields below.
func (c *COB) WriteToWriter(w io.Writer) error {
	headerSize := 44 // canonical TA 11-DWORD header
	subHeaderSize := 0
	if c.VersionSignature == 6 {
		subHeaderSize = 8 // [soundNameOffArr, len(SoundNames)]
	}
	codeOffset := headerSize + subHeaderSize
	codeSize := len(c.Code)

	scriptCodeIndexOffset := codeOffset + codeSize
	scriptNameOffArr := scriptCodeIndexOffset + int(c.NumScripts)*4
	pieceNameOffArr := scriptNameOffArr + int(c.NumScripts)*4
	soundNameOffArr := pieceNameOffArr + int(c.NumPieces)*4
	stringPoolStart := soundNameOffArr + len(c.SoundNames)*4

	// String offsets in pool order: scripts → pieces → sound names.
	cursor := uint32(stringPoolStart)
	scriptOffsets := make([]uint32, len(c.ScriptNames))
	for i, name := range c.ScriptNames {
		scriptOffsets[i] = cursor
		cursor += uint32(len(name)) + 1
	}
	pieceOffsets := make([]uint32, len(c.PieceNames))
	for i, name := range c.PieceNames {
		pieceOffsets[i] = cursor
		cursor += uint32(len(name)) + 1
	}
	soundOffsets := make([]uint32, len(c.SoundNames))
	for i, name := range c.SoundNames {
		soundOffsets[i] = cursor
		cursor += uint32(len(name)) + 1
	}

	header := make([]byte, headerSize)
	binary.LittleEndian.PutUint32(header[0:4], c.VersionSignature)
	binary.LittleEndian.PutUint32(header[4:8], c.NumScripts)
	binary.LittleEndian.PutUint32(header[8:12], c.NumPieces)
	binary.LittleEndian.PutUint32(header[12:16], c.LengthOfScripts)
	binary.LittleEndian.PutUint32(header[16:20], c.NumberOfStaticVars)
	binary.LittleEndian.PutUint32(header[20:24], c.UKZero)
	binary.LittleEndian.PutUint32(header[24:28], uint32(scriptCodeIndexOffset))
	binary.LittleEndian.PutUint32(header[28:32], uint32(scriptNameOffArr))
	binary.LittleEndian.PutUint32(header[32:36], uint32(pieceNameOffArr))
	binary.LittleEndian.PutUint32(header[36:40], uint32(codeOffset))
	// OffsetToNameArray always equals the byte just past the piece-name
	// offset array in retail TA + TAK files. For TA v4 that's the
	// string-pool start; for TA: Kingdoms v6 with sound names, it's the
	// start of the sound-name offset table (which only equals
	// stringPoolStart when len(SoundNames) == 0).
	binary.LittleEndian.PutUint32(header[40:44], uint32(soundNameOffArr))
	if _, err := w.Write(header); err != nil {
		return err
	}

	// TAK v6 sub-header: sound-name offset table location + count.
	if subHeaderSize > 0 {
		sub := make([]byte, subHeaderSize)
		binary.LittleEndian.PutUint32(sub[0:4], uint32(soundNameOffArr))
		binary.LittleEndian.PutUint32(sub[4:8], uint32(len(c.SoundNames)))
		if _, err := w.Write(sub); err != nil {
			return err
		}
	}

	if _, err := w.Write(c.Code); err != nil {
		return err
	}

	writeOffsets := func(offsets []uint32) error {
		for _, off := range offsets {
			buf := make([]byte, 4)
			binary.LittleEndian.PutUint32(buf, off)
			if _, err := w.Write(buf); err != nil {
				return err
			}
		}
		return nil
	}
	if err := writeOffsets(c.ScriptCodeIndices); err != nil {
		return err
	}
	if err := writeOffsets(scriptOffsets); err != nil {
		return err
	}
	if err := writeOffsets(pieceOffsets); err != nil {
		return err
	}
	if err := writeOffsets(soundOffsets); err != nil {
		return err
	}

	writeStrings := func(strs []string) error {
		for _, s := range strs {
			if _, err := w.Write([]byte(s)); err != nil {
				return err
			}
			if _, err := w.Write([]byte{0}); err != nil {
				return err
			}
		}
		return nil
	}
	if err := writeStrings(c.ScriptNames); err != nil {
		return err
	}
	if err := writeStrings(c.PieceNames); err != nil {
		return err
	}
	if err := writeStrings(c.SoundNames); err != nil {
		return err
	}

	return nil
}
