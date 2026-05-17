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
	// Header fields (11 DWORDs)
	VersionSignature              uint32   // [0] Version (typically 4)
	NumScripts                    uint32   // [1] Number of scripts
	NumPieces                     uint32   // [2] Number of pieces
	Unknown0                      uint32   // [3] Unknown (possibly total code size?)
	Unknown1                      uint32   // [4] Unknown
	Unknown2                      uint32   // [5] Always 0?
	OffsetToScriptCodeIndexArray  uint32   // [6] Offset to script index array
	OffsetToScriptNameOffsetArray uint32   // [7] Offset to script name array (ABSOLUTE offsets)
	OffsetToPieceNameOffsetArray  uint32   // [8] Offset to piece name array (ABSOLUTE offsets)
	OffsetToScriptCode            uint32   // [9] Offset to script code
	Unknown3                      uint32   // [10] String pool base (seems to match first string location)
	
	// Parsed data
	Code               []byte
	ScriptCodeIndices  []uint32 // Indices from OffsetToScriptCodeIndexArray
	ScriptNames        []string
	PieceNames         []string
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
	cob.Unknown0 = binary.LittleEndian.Uint32(allData[12:16])
	cob.Unknown1 = binary.LittleEndian.Uint32(allData[16:20])
	cob.Unknown2 = binary.LittleEndian.Uint32(allData[20:24])
	cob.OffsetToScriptCodeIndexArray = binary.LittleEndian.Uint32(allData[24:28])
	cob.OffsetToScriptNameOffsetArray = binary.LittleEndian.Uint32(allData[28:32])
	cob.OffsetToPieceNameOffsetArray = binary.LittleEndian.Uint32(allData[32:36])
	cob.OffsetToScriptCode = binary.LittleEndian.Uint32(allData[36:40])
	cob.Unknown3 = binary.LittleEndian.Uint32(allData[40:44])

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

// WriteToWriter writes the COB to a writer
func (c *COB) WriteToWriter(w io.Writer) error {
	// Calculate offsets
	headerSize := 44 // 11 * 4 bytes
	codeSize := len(c.Code)
	codeOffset := headerSize
	
	// Calculate section offsets
	scriptCodeIndexOffset := codeOffset + codeSize
	scriptNameOffset := scriptCodeIndexOffset + int(c.NumScripts)*4
	pieceNameOffset := scriptNameOffset + int(c.NumScripts)*4
	
	// Write header (CORRECT FIELD ORDER!)
	header := make([]byte, headerSize)
	binary.LittleEndian.PutUint32(header[0:4], c.VersionSignature)
	binary.LittleEndian.PutUint32(header[4:8], c.NumScripts)
	binary.LittleEndian.PutUint32(header[8:12], c.NumPieces)
	binary.LittleEndian.PutUint32(header[12:16], c.Unknown0)     // Unknown field
	binary.LittleEndian.PutUint32(header[16:20], c.Unknown1)
	binary.LittleEndian.PutUint32(header[20:24], c.Unknown2)
	binary.LittleEndian.PutUint32(header[24:28], uint32(scriptCodeIndexOffset))  // [6]
	binary.LittleEndian.PutUint32(header[28:32], uint32(scriptNameOffset))       // [7]
	binary.LittleEndian.PutUint32(header[32:36], uint32(pieceNameOffset))        // [8]
	binary.LittleEndian.PutUint32(header[36:40], uint32(codeOffset))             // [9] Code offset
	binary.LittleEndian.PutUint32(header[40:44], c.Unknown3)
	
	if _, err := w.Write(header); err != nil {
		return err
	}
	
	// Write code section
	if _, err := w.Write(c.Code); err != nil {
		return err
	}
	
	// Write script code indices
	for _, idx := range c.ScriptCodeIndices {
		buf := make([]byte, 4)
		binary.LittleEndian.PutUint32(buf, idx)
		if _, err := w.Write(buf); err != nil {
			return err
		}
	}
	
	// Calculate where strings will start (after offset arrays)
	stringPoolStart := scriptNameOffset + int(c.NumScripts)*4 + int(c.NumPieces)*4
	
	// Write script name offset array
	currentStringOffset := stringPoolStart
	scriptNameOffsets := []uint32{}
	for _, name := range c.ScriptNames {
		scriptNameOffsets = append(scriptNameOffsets, uint32(currentStringOffset))
		currentStringOffset += len(name) + 1 // +1 for null terminator
	}
	for _, offset := range scriptNameOffsets {
		buf := make([]byte, 4)
		binary.LittleEndian.PutUint32(buf, offset)
		if _, err := w.Write(buf); err != nil {
			return err
		}
	}
	
	// Write piece name offset array
	pieceNameOffsets := []uint32{}
	for _, name := range c.PieceNames {
		pieceNameOffsets = append(pieceNameOffsets, uint32(currentStringOffset))
		currentStringOffset += len(name) + 1
	}
	for _, offset := range pieceNameOffsets {
		buf := make([]byte, 4)
		binary.LittleEndian.PutUint32(buf, offset)
		if _, err := w.Write(buf); err != nil {
			return err
		}
	}
	
	// Write script name strings
	for _, name := range c.ScriptNames {
		if _, err := w.Write([]byte(name)); err != nil {
			return err
		}
		if _, err := w.Write([]byte{0}); err != nil {
			return err
		}
	}
	
	// Write piece name strings
	for _, name := range c.PieceNames {
		if _, err := w.Write([]byte(name)); err != nil {
			return err
		}
		if _, err := w.Write([]byte{0}); err != nil {
			return err
		}
	}
	
	return nil
}
