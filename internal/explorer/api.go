package explorer

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"go.uber.org/zap"

	"github.com/coreprime/kbot/internal/assets"
	"github.com/coreprime/kbot/formats/ai"
	"github.com/coreprime/kbot/formats/objects3d"
	"github.com/coreprime/kbot/formats/fnt"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/formats/sct"
	"github.com/coreprime/kbot/formats/gaf"
	"github.com/coreprime/kbot/formats/pcx"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/scripting/assembly"
	"github.com/coreprime/kbot/formats/scripting/compiler"
	"github.com/coreprime/kbot/formats/scripting/decompiler"
	"github.com/coreprime/kbot/formats/scripting/linter"
	"github.com/coreprime/kbot/formats/scripting/parser"
	"github.com/coreprime/kbot/formats/smacker"
	"github.com/coreprime/kbot/formats/tdf"
	"os"
)

// ── JSON helpers ───────────────────────────────────────────────────────────

func writeJSON(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	if err := json.NewEncoder(w).Encode(v); err != nil {
		logger.Error("json encode", zap.Error(err))
	}
}

func jsonError(w http.ResponseWriter, msg string, code int) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// ── /api/stats ─────────────────────────────────────────────────────────────

func handleAPISearch(w http.ResponseWriter, r *http.Request) {
	query := strings.ToLower(strings.TrimSpace(r.URL.Query().Get("q")))
	if query == "" || len(query) < 2 {
		writeJSON(w, map[string]any{"results": []any{}})
		return
	}

	type searchResult struct {
		Name  string `json:"name"`
		Path  string `json:"path"`
		IsDir bool   `json:"isDir"`
	}

	allFiles := vfs.List()
	var results []searchResult
	seen := make(map[string]bool)
	maxResults := 50

	for _, filePath := range allFiles {
		if len(results) >= maxResults {
			break
		}
		lower := strings.ToLower(filePath)
		if !strings.Contains(lower, query) {
			continue
		}

		// Add matching parent directories.
		dir := path.Dir(filePath)
		if dir != "." && dir != "" && !seen[dir] && strings.Contains(strings.ToLower(dir), query) {
			seen[dir] = true
			results = append(results, searchResult{
				Name:  path.Base(dir),
				Path:  dir,
				IsDir: true,
			})
		}

		// Add the file.
		if !seen[filePath] {
			seen[filePath] = true
			results = append(results, searchResult{
				Name:  path.Base(filePath),
				Path:  filePath,
				IsDir: false,
			})
		}
	}

	writeJSON(w, map[string]any{"results": results})
}

func handleAPIStats(w http.ResponseWriter, _ *http.Request) {
	stats := vfs.Stats()
	writeJSON(w, map[string]any{
		"basePath":         stats["base_path"],
		"archives":         stats["archives"],
		"totalFiles":       stats["total_files"],
		"directories":      stats["directories"],
		"unpackedSize":     stats["total_unpacked_size"],
		"unpackedSizeStr":  formatSize(stats["total_unpacked_size"].(int64)),
		"packedSize":       stats["total_packed_size"],
		"packedSizeStr":    formatSize(stats["total_packed_size"].(int64)),
		"compressionRatio": stats["compression_ratio"],
	})
}

// ── /api/browse/{path} ─────────────────────────────────────────────────────

type apiBrowseEntry struct {
	Name       string `json:"name"`
	Path       string `json:"path"`
	IsDir      bool   `json:"isDir"`
	Size       string `json:"size,omitempty"`
	DirFiles   int    `json:"dirFiles,omitempty"`
	DirFolders int    `json:"dirFolders,omitempty"`
	DirSize    string `json:"dirSize,omitempty"`
}

type apiBreadcrumb struct {
	Name string `json:"name"`
	Path string `json:"path"`
}

func handleAPIBrowse(w http.ResponseWriter, r *http.Request) {
	urlPath := strings.TrimPrefix(r.URL.Path, "/api/browse/")
	urlPath = strings.TrimSuffix(urlPath, "/")

	if metrics != nil {
		metrics.RecordBrowse(urlPath)
	}

	files, err := vfs.ListDir(urlPath)
	if err != nil {
		jsonError(w, fmt.Sprintf("directory not found: %v", err), http.StatusNotFound)
		return
	}

	var entries []apiBrowseEntry
	for _, filename := range files {
		entryPath := path.Join(urlPath, filename)
		isDir := vfs.IsDir(entryPath)

		if urlPath == "" && !isDir && vfs.ShouldExclude(filename, false) {
			continue
		}

		e := apiBrowseEntry{Name: filename, Path: entryPath, IsDir: isDir}

		if isDir {
			ds := vfs.RecursiveDirectoryStats(entryPath)
			if v, ok := ds["files"].(int); ok {
				e.DirFiles = v
			}
			if v, ok := ds["subdirectories"].(int); ok {
				e.DirFolders = v
			}
			if v, ok := ds["total_size"].(int64); ok {
				e.DirSize = formatSize(v)
			}
		} else {
			if info, err := vfs.Stat(entryPath); err == nil {
				e.Size = formatSize(info.Size)
			}
		}

		entries = append(entries, e)
	}

	sort.Slice(entries, func(i, j int) bool {
		if entries[i].IsDir != entries[j].IsDir {
			return entries[i].IsDir
		}
		return entries[i].Name < entries[j].Name
	})

	breadcrumbs := []apiBreadcrumb{{Name: "Root", Path: ""}}
	if urlPath != "" {
		parts := strings.Split(urlPath, "/")
		cur := ""
		for _, part := range parts {
			if part == "" {
				continue
			}
			cur = path.Join(cur, part)
			breadcrumbs = append(breadcrumbs, apiBreadcrumb{Name: part, Path: cur})
		}
	}

	dirStats := vfs.RecursiveDirectoryStats(urlPath)
	dirName := "Root"
	if len(breadcrumbs) > 1 {
		dirName = breadcrumbs[len(breadcrumbs)-1].Name
	}

	writeJSON(w, map[string]any{
		"path":        urlPath,
		"dirName":     dirName,
		"breadcrumbs": breadcrumbs,
		"entries":     entries,
		"fileCount":   dirStats["files"],
		"subdirCount": dirStats["subdirectories"],
		"totalSize":   formatSize(dirStats["total_size"].(int64)),
	})
}

// ── /api/describe/{path} ───────────────────────────────────────────────────

func handleAPIDescribe(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/api/describe/")

	info, err := vfs.Stat(filePath)
	if err != nil {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	data, err := vfs.ReadFile(filePath)
	if err != nil {
		jsonError(w, "cannot read file", http.StatusInternalServerError)
		return
	}

	result := map[string]any{
		"path":   filePath,
		"size":   formatSize(info.Size),
		"source": info.Source,
		"format": "",
	}

	ext := strings.ToLower(filepath.Ext(filePath))

	switch ext {
	case ".tdf", ".fbi", ".gui", ".ota":
		describeTDFAPI(data, ext, result)
	case ".gaf":
		describeGAFAPI(data, filePath, result)
	case ".cob":
		describeCOBAPI(data, result)
	case ".pcx":
		describePCXAPI(data, result)
	}

	if ext == ".ai" || (ext == ".txt" && ai.IsAIFile(data)) {
		describeAIAPI(data, result)
	}

	writeJSON(w, result)
}

func describeTDFAPI(data []byte, ext string, result map[string]any) {
	doc, err := tdf.ParseString(string(data))
	if err != nil {
		return
	}
	result["format"] = strings.ToUpper(ext[1:])

	type field struct {
		Key   string `json:"key"`
		Value string `json:"value"`
	}
	type section struct {
		Name     string    `json:"name"`
		Fields   []field   `json:"fields"`
		Children []section `json:"children,omitempty"`
	}

	var convert func(s *tdf.Section) section
	convert = func(s *tdf.Section) section {
		sec := section{Name: s.Name()}
		for _, f := range s.Fields() {
			sec.Fields = append(sec.Fields, field{Key: f.Key(), Value: f.Value()})
		}
		for _, child := range s.Sections() {
			sec.Children = append(sec.Children, convert(child))
		}
		return sec
	}

	var sections []section
	for _, s := range doc.Sections() {
		sections = append(sections, convert(s))
	}
	result["sections"] = sections
}

func describeGAFAPI(data []byte, filePath string, result map[string]any) {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		return
	}

	result["format"] = "GAF"

	type frame struct {
		Index        int    `json:"index"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		OriginX      int    `json:"originX"`
		OriginY      int    `json:"originY"`
		Transparency int    `json:"transparency"`
		Duration     string `json:"duration"`
	}
	type seq struct {
		Index  int     `json:"index"`
		Name   string  `json:"name"`
		Frames []frame `json:"frames"`
		PNGUrl string  `json:"pngUrl"`
		APNGUrl string `json:"apngUrl"`
		GIFUrl string  `json:"gifUrl"`
	}

	var seqs []seq
	for i, s := range sequences {
		sq := seq{
			Index:   i,
			Name:    s.Name,
			PNGUrl:  fmt.Sprintf("/png/%s/%d", filePath, i),
			APNGUrl: fmt.Sprintf("/apng/%s/%d", filePath, i),
			GIFUrl:  fmt.Sprintf("/gif/%s/%d", filePath, i),
		}
		for j, f := range s.Frames {
			sq.Frames = append(sq.Frames, frame{
				Index:        j,
				Width:        int(f.Width),
				Height:       int(f.Height),
				OriginX:      int(f.OriginX),
				OriginY:      int(f.OriginY),
				Transparency: int(f.TransparencyIndex),
				Duration:     fmt.Sprintf("%d ticks (%.2fs)", f.Duration, float64(f.Duration)/30.0),
			})
		}
		seqs = append(seqs, sq)
	}
	result["sequences"] = seqs
}

func describeCOBAPI(data []byte, result map[string]any) {
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	result["format"] = "COB"
	result["version"] = cob.VersionSignature
	result["scriptCount"] = cob.NumScripts
	result["pieceCount"] = cob.NumPieces
	result["codeLength"] = len(cob.Code)
	result["staticVars"] = cob.Unknown1
	result["scriptNames"] = cob.ScriptNames
	result["pieceNames"] = cob.PieceNames
}

func describePCXAPI(data []byte, result map[string]any) {
	pcxReader, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	result["format"] = "PCX"
	result["width"] = pcxReader.Width()
	result["height"] = pcxReader.Height()
	result["bitsPerPixel"] = pcxReader.BitsPerPixel()
	result["colorPlanes"] = pcxReader.Header().NumPlanes
}

func describeAIAPI(data []byte, result map[string]any) {
	aiFile, err := ai.Parse(data)
	if err != nil {
		return
	}
	result["format"] = "AI Profile"
	result["plans"] = aiFile.Plans
}

// ── /api/view/{path} ───────────────────────────────────────────────────────

func handleAPIView(w http.ResponseWriter, r *http.Request) {
	filePath := strings.TrimPrefix(r.URL.Path, "/api/view/")
	sourceParam := r.URL.Query().Get("source")

	if metrics != nil {
		ext := strings.ToLower(filepath.Ext(filePath))
		metrics.RecordFileView(ext)
	}

	info, err := vfs.Stat(filePath)
	if err != nil {
		jsonError(w, "file not found", http.StatusNotFound)
		return
	}

	var data []byte
	if sourceParam != "" {
		data, err = vfs.ReadFileFromSource(filePath, sourceParam)
	} else {
		data, err = vfs.ReadFile(filePath)
	}
	if err != nil {
		jsonError(w, "cannot read file", http.StatusInternalServerError)
		return
	}

	// Breadcrumbs
	breadcrumbs := []apiBreadcrumb{{Name: "Root", Path: ""}}
	if filePath != "" {
		dir := filepath.Dir(filePath)
		if dir != "." {
			parts := strings.Split(dir, "/")
			cur := ""
			for _, part := range parts {
				if part == "" {
					continue
				}
				cur = path.Join(cur, part)
				breadcrumbs = append(breadcrumbs, apiBreadcrumb{Name: part, Path: cur})
			}
		}
		breadcrumbs = append(breadcrumbs, apiBreadcrumb{Name: path.Base(filePath), Path: filePath})
	}

	layers := vfs.GetFileLayers(filePath)

	result := map[string]any{
		"fileName":     path.Base(filePath),
		"filePath":     filePath,
		"size":         formatSize(info.Size),
		"sizeBytes":    info.Size,
		"source":       info.Source,
		"breadcrumbs":  breadcrumbs,
		"layers":       layers,
		"activeSource": sourceParam,
		"hasContent":   false,
		"isText":       false,
	}

	ext := strings.ToLower(path.Ext(filePath))

	// Format-specific metadata
	switch ext {
	case ".smk", ".zrb":
		viewVideoAPI(data, result)
	case ".gaf":
		viewGAFAPI(data, filePath, result)
	case ".pcx":
		viewPCXAPI(data, filePath, result)
	case ".cob":
		viewCOBAPI(data, result)
	case ".bos", ".h":
		viewBOSAPI(data, ext, filePath, result)
	case ".tdf", ".fbi", ".gui", ".ota":
		viewTDFAPI(data, ext, result)
	case ".wav":
		viewWavAPI(data, filePath, result)
	case ".mp3":
		viewMP3API(data, filePath, result)
	case ".3do":
		view3DOAPI(data, result)
	case ".fnt":
		viewFontAPI(data, filePath, result)
	case ".pal":
		viewPaletteAPI(data, result)
	case ".sct":
		viewSCTAPI(data, filePath, result)
	case ".tnt":
		viewTNTAPI(data, filePath, result)
	case ".alp":
		viewAlphaTableAPI(data, result)
	case ".lht":
		viewLightingTableAPI(data, result)
	case ".shd":
		viewShadowTableAPI(data, result)
	}

	if ext == ".ai" || (ext == ".txt" && ai.IsAIFile(data)) {
		viewAIAPI(data, result)
	}

	// Text detection
	isText := isTextContent(data)
	if isText {
		result["isText"] = true
		result["textContent"] = string(data)
	}

	// Hex dump (max 200KB)
	maxBytes := 200 * 1024
	displayData := data
	truncated := false
	if len(data) > maxBytes {
		displayData = data[:maxBytes]
		truncated = true
	}
	result["hexDump"] = formatHexDump(displayData)
	result["truncated"] = truncated

	writeJSON(w, result)
}

func viewVideoAPI(data []byte, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "Smacker Video"

	tmpFile, err := os.CreateTemp("", "smk-*.smk")
	if err != nil {
		return
	}
	defer func() { _ = os.Remove(tmpFile.Name()) }()
	_, _ = tmpFile.Write(data)
	_ = tmpFile.Close()

	smkReader, err := smacker.OpenReader(tmpFile.Name())
	if err != nil {
		return
	}
	defer func() { _ = smkReader.Close() }()

	result["videoWidth"] = smkReader.Width()
	result["videoHeight"] = smkReader.Height()
	result["videoFrames"] = smkReader.FrameCount()
	result["videoFPS"] = fmt.Sprintf("%.2f", smkReader.FrameRate())
	result["videoDuration"] = fmt.Sprintf("%.2f", smkReader.Duration())
}

func viewGAFAPI(data []byte, filePath string, result map[string]any) {
	gafReader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	defer func() { _ = gafReader.Close() }()

	sequences, err := gafReader.ReadSequences()
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "GAF Animation"

	type frameInfo struct {
		Index        int    `json:"index"`
		Width        int    `json:"width"`
		Height       int    `json:"height"`
		OriginX      int    `json:"originX"`
		OriginY      int    `json:"originY"`
		Transparency int    `json:"transparency"`
		Duration     string `json:"duration"`
	}
	type seqInfo struct {
		Index   int         `json:"index"`
		Name    string      `json:"name"`
		PNGUrl  string      `json:"pngUrl"`
		APNGUrl string      `json:"apngUrl"`
		GIFUrl  string      `json:"gifUrl"`
		Frames  []frameInfo `json:"frames"`
	}

	var seqs []seqInfo
	for i, seq := range sequences {
		s := seqInfo{
			Index:   i,
			Name:    seq.Name,
			PNGUrl:  fmt.Sprintf("/png/%s/%d", filePath, i),
			APNGUrl: fmt.Sprintf("/apng/%s/%d", filePath, i),
			GIFUrl:  fmt.Sprintf("/gif/%s/%d", filePath, i),
		}
		for j, f := range seq.Frames {
			s.Frames = append(s.Frames, frameInfo{
				Index:        j,
				Width:        int(f.Width),
				Height:       int(f.Height),
				OriginX:      int(f.OriginX),
				OriginY:      int(f.OriginY),
				Transparency: int(f.TransparencyIndex),
				Duration:     fmt.Sprintf("%d ticks (%.2fs)", f.Duration, float64(f.Duration)/30.0),
			})
		}
		seqs = append(seqs, s)
	}
	result["gafSequences"] = seqs
}

func viewPCXAPI(data []byte, filePath string, result map[string]any) {
	pcxReader, err := pcx.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}
	result["hasContent"] = true
	result["format"] = "PCX Image"
	result["width"] = pcxReader.Width()
	result["height"] = pcxReader.Height()
	result["bitsPerPixel"] = pcxReader.BitsPerPixel()
	result["pcxUrl"] = fmt.Sprintf("/pcx/%s", filePath)
}

func viewCOBAPI(data []byte, result map[string]any) {
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "COB Script"
	result["cobVersion"] = cob.VersionSignature
	result["cobScriptCount"] = cob.NumScripts
	result["cobPieceCount"] = cob.NumPieces
	result["cobCodeLength"] = len(cob.Code)
	result["cobStaticVars"] = cob.Unknown1
	result["cobScriptNames"] = cob.ScriptNames
	result["cobPieceNames"] = cob.PieceNames

	// Disassembly
	dec := decompiler.NewDecompiler(cob)
	if disasm, err := dec.Disassemble(assembly.Plain); err == nil {
		result["disassembly"] = disasm
	}

	// Decompilation
	cob2, _ := scripting.LoadFromReader(bytes.NewReader(data))
	dec2 := decompiler.NewDecompiler(cob2)
	if decompiled, err := dec2.Decompile(); err == nil {
		result["decompiled"] = decompiled
	}

	// Call graph via linter analysis (uses decompiled source).
	cob5, _ := scripting.LoadFromReader(bytes.NewReader(data))
	if cob5 != nil {
		l2 := linter.New()
		graph := l2.GetCallGraph(cob5)
		if len(graph.Nodes) > 0 {
			result["callGraphNodes"] = graph.Nodes
			result["callGraphEdges"] = graph.Edges
		}
	}

	// Web disassembly JSON
	cob3, _ := scripting.LoadFromReader(bytes.NewReader(data))
	if webDisasm, err := assembly.GenerateWebDisassembly(cob3); err == nil {
		result["webDisassembly"] = webDisasm
	}

	// Lint
	cob4, _ := scripting.LoadFromReader(bytes.NewReader(data))
	if cob4 != nil {
		l := linter.New()
		diags := l.Lint(cob4)

		type lintDiag struct {
			Line     int    `json:"line"`
			Rule     string `json:"rule"`
			Severity string `json:"severity"`
			Script   string `json:"script"`
			Message  string `json:"message"`
		}

		lintResults := make([]lintDiag, 0, len(diags))
		for _, d := range diags {
			lintResults = append(lintResults, lintDiag{
				Rule:     d.Rule,
				Severity: d.Severity.String(),
				Script:   d.Script,
				Message:  d.Message,
				Line:     d.Line,
			})
		}
		result["lintResults"] = lintResults

		// Summary by rule
		summary := make(map[string]int)
		for _, d := range diags {
			summary[d.Rule]++
		}
		result["lintSummary"] = summary
	}
}

func viewBOSAPI(data []byte, ext string, filePath string, result map[string]any) {
	if !isTextContent(data) {
		return
	}
	result["hasContent"] = true
	result["format"] = "BOS Script"
	if ext == ".h" {
		result["format"] = "BOS Header"
	}

	lines := bytes.Split(data, []byte{'\n'})
	code, comments := 0, 0
	for _, line := range lines {
		trimmed := bytes.TrimSpace(line)
		if len(trimmed) == 0 {
			continue
		}
		if bytes.HasPrefix(trimmed, []byte("//")) {
			comments++
		} else {
			code++
		}
	}
	result["totalLines"] = len(lines)
	result["codeLines"] = code
	result["commentLines"] = comments

	// Call graph — try preprocessed + compiled path first, fall back to text scan.
	bosCallGraph(data, filePath, result)

	// Attempt to lint: preprocess → compile → lint.
	// Only for .bos files (not .h headers).
	if ext == ".bos" && vfs != nil {
		lintBOS(data, filePath, result)
	}
}

func lintBOS(data []byte, filePath string, result map[string]any) {
	// Use the preprocessor with VFS to resolve #include files.
	dir := path.Dir(filePath)
	prep := parser.NewPreprocessor(vfs, dir, "")
	processed, err := prep.ProcessContent(string(data), filePath)
	if err != nil {
		result["lintError"] = fmt.Sprintf("Preprocessing failed: %v — includes may not be available in the virtual filesystem", err)
		return
	}

	// Compile to COB.
	comp := compiler.NewCompiler(processed)
	cob, err := comp.Compile()
	if err != nil {
		result["lintError"] = fmt.Sprintf("Compilation failed: %v — linting requires successful compilation", err)
		return
	}

	// Lint the compiled COB.
	l := linter.New()
	diags := l.Lint(cob)

	type lintDiag struct {
			Line     int    `json:"line"`
		Rule     string `json:"rule"`
		Severity string `json:"severity"`
		Script   string `json:"script"`
		Message  string `json:"message"`
	}

	lintResults := make([]lintDiag, 0, len(diags))
	for _, d := range diags {
		lintResults = append(lintResults, lintDiag{
			Rule:     d.Rule,
			Severity: d.Severity.String(),
			Script:   d.Script,
			Message:  d.Message,
				Line:     d.Line,
		})
	}
	result["lintResults"] = lintResults

	summary := make(map[string]int)
	for _, d := range diags {
		summary[d.Rule]++
	}
	result["lintSummary"] = summary
}

func viewTDFAPI(data []byte, ext string, result map[string]any) {
	if _, err := tdf.ParseString(string(data)); err != nil {
		return
	}
	result["hasContent"] = true
	result["format"] = strings.ToUpper(ext[1:]) + " Config"
	describeTDFAPI(data, ext, result) // reuse describe logic for sections
}

func viewAIAPI(data []byte, result map[string]any) {
	aiFile, err := ai.Parse(data)
	if err != nil {
		return
	}
	result["hasContent"] = true
	result["format"] = "AI Profile"
	result["aiPlans"] = aiFile.Plans
}

func viewWavAPI(data []byte, filePath string, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "WAV Audio"
	result["audioUrl"] = fmt.Sprintf("/raw/%s", filePath)

	// Parse WAV header for metadata (minimum 44 bytes).
	if len(data) < 44 {
		return
	}
	// Bytes 22-23: number of channels (little-endian uint16)
	channels := int(data[22]) | int(data[23])<<8
	// Bytes 24-27: sample rate (little-endian uint32)
	sampleRate := int(data[24]) | int(data[25])<<8 | int(data[26])<<16 | int(data[27])<<24
	// Bytes 34-35: bits per sample
	bitsPerSample := int(data[34]) | int(data[35])<<8
	// Bytes 40-43: data chunk size
	dataSize := int(data[40]) | int(data[41])<<8 | int(data[42])<<16 | int(data[43])<<24

	result["audioChannels"] = channels
	result["audioSampleRate"] = sampleRate
	result["audioBitsPerSample"] = bitsPerSample

	if sampleRate > 0 && channels > 0 && bitsPerSample > 0 {
		bytesPerSample := bitsPerSample / 8
		totalSamples := dataSize / (channels * bytesPerSample)
		duration := float64(totalSamples) / float64(sampleRate)
		result["audioDuration"] = fmt.Sprintf("%.2f", duration)
	}
}

func viewMP3API(data []byte, filePath string, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "MP3 Audio"
	result["audioUrl"] = fmt.Sprintf("/raw/%s", filePath)

	// Skip ID3v2 header if present.
	offset := 0
	if len(data) >= 10 && string(data[0:3]) == "ID3" {
		// ID3v2 size is stored in 4 bytes of syncsafe integer (bytes 6-9).
		tagSize := (int(data[6]) << 21) | (int(data[7]) << 14) | (int(data[8]) << 7) | int(data[9])
		offset = 10 + tagSize
	}

	// Find first valid MPEG frame sync (0xFF 0xE0+).
	for offset < len(data)-4 {
		if data[offset] == 0xFF && (data[offset+1]&0xE0) == 0xE0 {
			break
		}
		offset++
	}

	if offset >= len(data)-4 {
		return
	}

	// Parse MPEG audio frame header (4 bytes).
	header := (uint32(data[offset]) << 24) | (uint32(data[offset+1]) << 16) |
		(uint32(data[offset+2]) << 8) | uint32(data[offset+3])

	mpegVersion := (header >> 19) & 0x03 // 00=2.5, 01=reserved, 10=2, 11=1
	layer := (header >> 17) & 0x03       // 01=III, 10=II, 11=I
	bitrateIdx := (header >> 12) & 0x0F
	srateIdx := (header >> 10) & 0x03
	channelMode := (header >> 6) & 0x03

	// Bitrate table for MPEG1 Layer III.
	bitrateTable := [16]int{0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0}
	srateTable := [4]int{44100, 48000, 32000, 0}

	bitrate := 0
	sampleRate := 0

	if mpegVersion == 3 && layer == 1 { // MPEG1 Layer III
		if bitrateIdx < 16 {
			bitrate = bitrateTable[bitrateIdx]
		}
		if srateIdx < 4 {
			sampleRate = srateTable[srateIdx]
		}
	} else if mpegVersion == 2 && layer == 1 { // MPEG2 Layer III
		mpeg2Bitrate := [16]int{0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0}
		if bitrateIdx < 16 {
			bitrate = mpeg2Bitrate[bitrateIdx]
		}
		mpeg2Srate := [4]int{22050, 24000, 16000, 0}
		if srateIdx < 4 {
			sampleRate = mpeg2Srate[srateIdx]
		}
	}

	channels := 2
	if channelMode == 3 {
		channels = 1
	}

	if bitrate > 0 {
		result["audioBitrate"] = fmt.Sprintf("%d kbps", bitrate)
	}
	if sampleRate > 0 {
		result["audioSampleRate"] = sampleRate
	}
	result["audioChannels"] = channels

	// Estimate duration from file size and bitrate (CBR approximation).
	if bitrate > 0 {
		audioBytes := len(data) - offset
		durationSecs := float64(audioBytes) * 8 / (float64(bitrate) * 1000)
		result["audioDuration"] = fmt.Sprintf("%.2f", durationSecs)

		minutes := int(durationSecs) / 60
		seconds := int(durationSecs) % 60
		result["audioDurationFormatted"] = fmt.Sprintf("%d:%02d", minutes, seconds)
	}
}

func viewPaletteAPI(data []byte, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "Palette"

	if len(data) < 4 {
		return
	}

	colorCount := len(data) / 4
	if colorCount > 256 {
		colorCount = 256
	}

	type paletteColor struct {
		Index int    `json:"index"`
		R     int    `json:"r"`
		G     int    `json:"g"`
		B     int    `json:"b"`
		A     int    `json:"a"`
		Hex   string `json:"hex"`
	}

	colors := make([]paletteColor, 0, colorCount)
	for i := 0; i < colorCount; i++ {
		off := i * 4
		r, g, b, a := int(data[off]), int(data[off+1]), int(data[off+2]), int(data[off+3])
		colors = append(colors, paletteColor{
			Index: i,
			R:     r,
			G:     g,
			B:     b,
			A:     a,
			Hex:   fmt.Sprintf("#%02X%02X%02X", r, g, b),
		})
	}

	result["paletteColors"] = colors
	result["paletteColorCount"] = colorCount
}

func viewSCTAPI(data []byte, filePath string, result map[string]any) {
	section, err := sct.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "SCT Section"
	result["sctWidth"] = section.Header.Width
	result["sctHeight"] = section.Header.Height
	result["sctNumTiles"] = section.Header.NumTiles
	result["sctPixelWidth"] = section.Header.Width * 32
	result["sctPixelHeight"] = section.Header.Height * 32
	result["sctHasMinimap"] = section.Minimap != nil
	result["sctHasHeightMap"] = section.HeightMap != nil
	result["sctTileMapUrl"] = fmt.Sprintf("/sct-tilemap/%s", filePath)
	result["sctHeightMapUrl"] = fmt.Sprintf("/sct-heightmap/%s", filePath)
	result["sctMinimapUrl"] = fmt.Sprintf("/sct-minimap/%s", filePath)
	result["sctTileBaseUrl"] = fmt.Sprintf("/sct-tile/%s", filePath)
}

func viewTNTAPI(data []byte, filePath string, result map[string]any) {
	m, err := tnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "TNT Map"
	result["tntWidth"] = m.Header.Width
	result["tntHeight"] = m.Header.Height
	result["tntTileW"] = m.TileW
	result["tntTileH"] = m.TileH
	result["tntPixelW"] = m.TileW * 32
	result["tntPixelH"] = m.TileH * 32
	result["tntNumTiles"] = len(m.Tiles)
	result["tntTileAnims"] = m.Header.TileAnims
	result["tntSeaLevel"] = m.Header.SeaLevel
	result["tntHasMinimap"] = m.Minimap != nil
	result["tntMinimapW"] = m.MinimapW
	result["tntMinimapH"] = m.MinimapH
	result["tntTileMapUrl"] = fmt.Sprintf("/tnt-tilemap/%s", filePath)
	result["tntMinimapUrl"] = fmt.Sprintf("/tnt-minimap/%s", filePath)
	result["tntHeightMapUrl"] = fmt.Sprintf("/tnt-heightmap/%s", filePath)
	result["tntTileBaseUrl"] = fmt.Sprintf("/tnt-tile/%s", filePath)

	// Load features.
	features, _ := m.LoadFeatures(bytes.NewReader(data))
	placements := m.GetFeaturePlacements()

	type featureInfo struct {
		Index       int    `json:"index"`
		Name        string `json:"name"`
		Description string `json:"description"`
		Category    string `json:"category"`
		Filename    string `json:"filename"`
		Seqname     string `json:"seqname"`
		FootprintX  int    `json:"footprintX"`
		FootprintZ  int    `json:"footprintZ"`
		Count       int    `json:"count"`
		GafUrl      string `json:"gafUrl,omitempty"`
	}

	type placementInfo struct {
		FeatureIdx int `json:"featureIdx"`
		PixelX     int `json:"pixelX"`
		PixelY     int `json:"pixelY"`
	}

	// Look up feature metadata from TDF files in the VFS.
	featureInfos := make([]featureInfo, len(features))
	featureCounts := make(map[int]int)
	for _, p := range placements {
		featureCounts[p.FeatureIdx]++
	}

	// Cache GAF sequence lookups to avoid re-reading the same file.
	gafSeqCache := make(map[string]map[string]int) // gaf filename → seqname → index

	for i, f := range features {
		fi := featureInfo{Index: f.Index, Name: f.Name, Count: featureCounts[i]}
		fi.Description, fi.Category, fi.Filename, fi.Seqname, fi.FootprintX, fi.FootprintZ = lookupFeatureTDF(f.Name)
		if fi.Filename != "" {
			seqIdx := resolveGAFSequence(fi.Filename, fi.Seqname, gafSeqCache)
			fi.GafUrl = fmt.Sprintf("/apng/anims/%s.gaf/%d", strings.ToLower(fi.Filename), seqIdx)
		}
		featureInfos[i] = fi
	}

	placementInfos := make([]placementInfo, len(placements))
	for i, p := range placements {
		placementInfos[i] = placementInfo{FeatureIdx: p.FeatureIdx, PixelX: p.PixelX, PixelY: p.PixelY}
	}

	result["tntFeatures"] = featureInfos
	result["tntPlacements"] = placementInfos

	// Report minimap content bounds for non-square maps.
	mmContentW, mmContentH := m.MinimapContentBounds()
	if mmContentW > 0 && mmContentH > 0 {
		result["tntMinimapContentW"] = mmContentW
		result["tntMinimapContentH"] = mmContentH
	}

	// Try to find matching OTA file for start positions.
	// Start positions are in pixel coords (Width*16 x Height*16 space).
	// Map them to minimap content area percentages.
	pixelW := m.TileW * 32
	pixelH := m.TileH * 32
	baseName := strings.TrimSuffix(filePath, path.Ext(filePath))
	otaPath := baseName + ".ota"
	if otaData, err := vfs.ReadFile(otaPath); err == nil {
		startPositions := extractStartPositions(string(otaData), pixelW, pixelH, mmContentW, mmContentH, m.MinimapW, m.MinimapH)
		if len(startPositions) > 0 {
			result["tntStartPositions"] = startPositions
		}
	}
}

// loadDefaultPalette loads the TA palette for color table lookups.
func loadDefaultPalette() []string {
	palData, err := vfs.ReadFile("palettes/palette.pal")
	if err != nil {
		// Fallback to embedded palette.
		pal, err := gaf.LoadPaletteFromBytes(assets.DefaultPalette)
		if err != nil {
			return nil
		}
		hexes := make([]string, 256)
		for i := 0; i < 256; i++ {
			c := pal.Colors[i]
			hexes[i] = fmt.Sprintf("#%02X%02X%02X", c.R, c.G, c.B)
		}
		return hexes
	}
	hexes := make([]string, 256)
	for i := 0; i < 256 && i*4+2 < len(palData); i++ {
		hexes[i] = fmt.Sprintf("#%02X%02X%02X", palData[i*4], palData[i*4+1], palData[i*4+2])
	}
	return hexes
}

func viewAlphaTableAPI(data []byte, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "Alpha Blending Table"
	result["tableType"] = "alpha"
	result["tableDescription"] = "256×256 lookup table for alpha blending. Each cell maps (source, destination) palette indices to the blended result palette index."
	result["tableWidth"] = 256
	result["tableHeight"] = 256

	// Provide a 16×16 sampled preview (every 16th row/col) with palette colors.
	palette := loadDefaultPalette()
	if palette == nil || len(data) < 65536 {
		return
	}

	type cell struct {
		SrcIdx int    `json:"srcIdx"`
		DstIdx int    `json:"dstIdx"`
		Result int    `json:"result"`
		Color  string `json:"color"`
	}
	preview := make([]cell, 0, 256)
	for sy := 0; sy < 256; sy += 16 {
		for sx := 0; sx < 256; sx += 16 {
			idx := int(data[sy*256+sx])
			color := ""
			if idx < len(palette) {
				color = palette[idx]
			}
			preview = append(preview, cell{SrcIdx: sx, DstIdx: sy, Result: idx, Color: color})
		}
	}
	result["tablePreview"] = preview
	result["tablePalette"] = palette
}

func viewLightingTableAPI(data []byte, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "Lighting Table"
	result["tableType"] = "lighting"
	result["tableDescription"] = "256×32 lookup table for lighting. Maps each palette color to 32 brightness levels (0=darkest, 31=brightest)."
	result["tableWidth"] = 32
	result["tableHeight"] = 256

	palette := loadDefaultPalette()
	if palette == nil || len(data) < 8192 {
		return
	}

	type row struct {
		ColorIdx int      `json:"colorIdx"`
		SrcColor string   `json:"srcColor"`
		Levels   []string `json:"levels"` // hex color at each light level
	}

	// Sample every 8th color for a manageable display.
	rows := make([]row, 0, 32)
	for ci := 0; ci < 256; ci += 8 {
		r := row{ColorIdx: ci}
		if ci < len(palette) {
			r.SrcColor = palette[ci]
		}
		for lv := 0; lv < 32; lv++ {
			idx := int(data[ci*32+lv])
			color := ""
			if idx < len(palette) {
				color = palette[idx]
			}
			r.Levels = append(r.Levels, color)
		}
		rows = append(rows, r)
	}
	result["tableRows"] = rows
}

func viewShadowTableAPI(data []byte, result map[string]any) {
	result["hasContent"] = true
	result["format"] = "Shadow Table"
	result["tableType"] = "shadow"
	result["tableDescription"] = "256×32 lookup table for shadows. Maps each palette color to 32 shadow intensity levels."
	result["tableWidth"] = 32
	result["tableHeight"] = 256

	palette := loadDefaultPalette()
	if palette == nil || len(data) < 8192 {
		return
	}

	type row struct {
		ColorIdx int      `json:"colorIdx"`
		SrcColor string   `json:"srcColor"`
		Levels   []string `json:"levels"`
	}

	rows := make([]row, 0, 32)
	for ci := 0; ci < 256; ci += 8 {
		r := row{ColorIdx: ci}
		if ci < len(palette) {
			r.SrcColor = palette[ci]
		}
		for lv := 0; lv < 32; lv++ {
			idx := int(data[ci*32+lv])
			color := ""
			if idx < len(palette) {
				color = palette[idx]
			}
			r.Levels = append(r.Levels, color)
		}
		rows = append(rows, r)
	}
	result["tableRows"] = rows
}

func viewFontAPI(data []byte, filePath string, result map[string]any) {
	font, err := fnt.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "TA Font"
	result["fntHeight"] = font.Height
	result["fntGlyphCount"] = font.GlyphCount()
	result["fntFlags"] = font.Flags
	result["fntSheetUrl"] = fmt.Sprintf("/fnt-sheet/%s", filePath)
	result["fntPreviewUrl"] = fmt.Sprintf("/fnt-preview/%s", filePath)

	type glyphInfo struct {
		Char  int `json:"char"`
		Width int `json:"width"`
	}
	var glyphs []glyphInfo
	for ch := 0; ch < 256; ch++ {
		g := font.Glyphs[ch]
		if g != nil {
			glyphs = append(glyphs, glyphInfo{Char: ch, Width: g.Width})
		}
	}
	result["fntGlyphs"] = glyphs
}

type startPosition struct {
	Number int     `json:"number"`
	X      int     `json:"x"`
	Y      int     `json:"y"`
	PctX   float64 `json:"pctX"` // 0-100 percentage for minimap positioning
	PctY   float64 `json:"pctY"`
}

func extractStartPositions(otaText string, mapPixelW, mapPixelH, mmContentW, mmContentH, mmTotalW, mmTotalH int) []startPosition {
	doc, err := tdf.ParseString(otaText)
	if err != nil {
		return nil
	}

	// Navigate: GlobalHeader > Schema 0 > specials
	globalHeader := doc.Section("GlobalHeader")
	if globalHeader == nil {
		return nil
	}
	var schema0 *tdf.Section
	for _, s := range globalHeader.Sections() {
		if s.Name() == "Schema 0" {
			schema0 = s
			break
		}
	}
	if schema0 == nil {
		return nil
	}
	var specials *tdf.Section
	for _, s := range schema0.Sections() {
		if s.Name() == "specials" {
			specials = s
			break
		}
	}
	if specials == nil {
		return nil
	}

	var positions []startPosition
	for _, special := range specials.Sections() {
		what := special.String("specialwhat")
		if !strings.HasPrefix(what, "StartPos") {
			continue
		}
		numStr := strings.TrimPrefix(what, "StartPos")
		num := 0
		_, _ = fmt.Sscanf(numStr, "%d", &num)

		x := special.Int("XPos")
		y := special.Int("ZPos")

		if mapPixelW > 0 && mapPixelH > 0 && mmTotalW > 0 && mmTotalH > 0 {
			// Map game pixel coords to minimap content area, then to full minimap %.
			// Game coord → fraction of map → position in minimap content → % of total minimap.
			mmX := (float64(x) / float64(mapPixelW)) * float64(mmContentW)
			mmY := (float64(y) / float64(mapPixelH)) * float64(mmContentH)
			positions = append(positions, startPosition{
				Number: num,
				X:      x,
				Y:      y,
				PctX:   mmX / float64(mmTotalW) * 100,
				PctY:   mmY / float64(mmTotalH) * 100,
			})
		}
	}

	return positions
}

// lookupFeatureTDF searches feature TDF files in the VFS for a named feature.
func lookupFeatureTDF(name string) (description, category, filename, seqname string, footprintX, footprintZ int) {
	// Scan all TDF files under features/
	allFiles := vfs.List()
	upperName := strings.ToUpper(name)

	for _, filePath := range allFiles {
		if !strings.HasPrefix(filePath, "features/") || !strings.HasSuffix(filePath, ".tdf") {
			continue
		}
		data, err := vfs.ReadFile(filePath)
		if err != nil {
			continue
		}
		doc, err := tdf.ParseString(string(data))
		if err != nil {
			continue
		}
		for _, sec := range doc.Sections() {
			if strings.ToUpper(sec.Name()) == upperName {
				description = sec.String("description")
				category = sec.String("category")
				filename = sec.String("filename")
				seqname = sec.String("seqname")
				footprintX = sec.Int("footprintx")
				footprintZ = sec.Int("footprintz")
				return
			}
		}
	}
	return
}

func view3DOAPI(data []byte, result map[string]any) {
	model, err := objects3d.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return
	}

	result["hasContent"] = true
	result["format"] = "3DO Model"
	result["tdoTotalObjects"] = len(model.AllObjects)
	result["tdoTotalVertices"] = model.TotalVertices()
	result["tdoTotalPrimitives"] = model.TotalPrimitives()
	result["tdoTextures"] = model.Textures()

	type objectInfo struct {
		Name       string `json:"name"`
		Vertices   int    `json:"vertices"`
		Primitives int    `json:"primitives"`
		Children   int    `json:"children"`
		Depth      int    `json:"depth"`
	}

	var objects []objectInfo
	var walk func(o *objects3d.Object, depth int)
	walk = func(o *objects3d.Object, depth int) {
		objects = append(objects, objectInfo{
			Name:       o.Name,
			Vertices:   len(o.Vertices),
			Primitives: len(o.Primitives),
			Children:   len(o.Children),
			Depth:      depth,
		})
		for _, c := range o.Children {
			walk(c, depth+1)
		}
	}
	walk(model.Root, 0)
	result["tdoObjects"] = objects
}

type callGraphEdge struct {
	From string `json:"from"`
	To   string `json:"to"`
	Type string `json:"type"` // "call", "start", "signal", "set-mask"
}

type callGraphNode struct {
	Name string `json:"name"`
	Type string `json:"type"` // "function", "signal"
}

func extractCallGraph(source string) ([]callGraphNode, []callGraphEdge) {
	lines := strings.Split(source, "\n")
	nodeSet := make(map[string]string) // name → type
	var edges []callGraphEdge
	currentFunc := ""

	for _, line := range lines {
		trimmed := strings.TrimSpace(line)

		// Detect function declarations.
		if idx := strings.Index(trimmed, "("); idx > 0 &&
			!strings.HasPrefix(trimmed, "if ") && !strings.HasPrefix(trimmed, "while ") &&
			!strings.HasPrefix(trimmed, "start-script ") && !strings.HasPrefix(trimmed, "call-script ") &&
			!strings.HasPrefix(trimmed, "//") {
			fnName := trimmed[:idx]
			if len(fnName) > 0 && fnName[0] != '#' && isIdentifier(fnName) {
				currentFunc = fnName
				nodeSet[fnName] = "function"
			}
		}

		if currentFunc == "" {
			continue
		}

		// call-script Name(...)
		if strings.HasPrefix(trimmed, "call-script ") {
			rest := strings.TrimPrefix(trimmed, "call-script ")
			if idx := strings.Index(rest, "("); idx > 0 {
				target := rest[:idx]
				nodeSet[target] = "function"
				edges = append(edges, callGraphEdge{From: currentFunc, To: target, Type: "call"})
			}
		}

		// start-script Name(...)
		if strings.HasPrefix(trimmed, "start-script ") {
			rest := strings.TrimPrefix(trimmed, "start-script ")
			if idx := strings.Index(rest, "("); idx > 0 {
				target := rest[:idx]
				nodeSet[target] = "function"
				edges = append(edges, callGraphEdge{From: currentFunc, To: target, Type: "start"})
			}
		}

		// signal N
		if strings.HasPrefix(trimmed, "signal ") {
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "signal "), ";")
			sigName := "SIG:" + val
			nodeSet[sigName] = "signal"
			edges = append(edges, callGraphEdge{From: currentFunc, To: sigName, Type: "signal"})
		}

		// set-signal-mask N
		if strings.HasPrefix(trimmed, "set-signal-mask ") {
			val := strings.TrimSuffix(strings.TrimPrefix(trimmed, "set-signal-mask "), ";")
			sigName := "SIG:" + val
			nodeSet[sigName] = "signal"
			edges = append(edges, callGraphEdge{From: currentFunc, To: sigName, Type: "set-mask"})
		}
	}

	// Deduplicate edges.
	type edgeKey struct{ from, to, typ string }
	seen := make(map[edgeKey]bool)
	var uniqueEdges []callGraphEdge
	for _, e := range edges {
		k := edgeKey{e.From, e.To, e.Type}
		if !seen[k] {
			seen[k] = true
			uniqueEdges = append(uniqueEdges, e)
		}
	}

	var nodes []callGraphNode
	for name, typ := range nodeSet {
		nodes = append(nodes, callGraphNode{Name: name, Type: typ})
	}

	return nodes, uniqueEdges
}

func isIdentifier(s string) bool {
	for _, ch := range s {
		if (ch < 'a' || ch > 'z') && (ch < 'A' || ch > 'Z') && (ch < '0' || ch > '9') && ch != '_' {
			return false
		}
	}
	return len(s) > 0
}

func bosCallGraph(data []byte, filePath string, result map[string]any) {
	sourceText := string(data)

	// Try to preprocess (resolve #includes, #defines) via VFS.
	if vfs != nil {
		dir := path.Dir(filePath)
		prep := parser.NewPreprocessor(vfs, dir, "")
		if processed, err := prep.ProcessContent(sourceText, filePath); err == nil {
			sourceText = processed
		}
		// On error, continue with unprocessed source — best effort.
	}

	// Try full compile path: preprocess → compile → get call graph from COB.
	comp := compiler.NewCompiler(sourceText)
	cob, err := comp.Compile()
	if err == nil {
		l := linter.New()
		graph := l.GetCallGraphFromSource(cob, sourceText)
		if len(graph.Nodes) > 0 {
			result["callGraphNodes"] = graph.Nodes
			result["callGraphEdges"] = graph.Edges
			return
		}
	}

	// Fall back to text-based extraction for incomplete/unparseable files.
	nodes, edges := extractCallGraph(sourceText)
	if len(nodes) > 0 {
		result["callGraphNodes"] = nodes
		result["callGraphEdges"] = edges
	}
}

// resolveGAFSequence finds the sequence index for a named sequence in a GAF file.
func resolveGAFSequence(gafFilename, seqName string, cache map[string]map[string]int) int {
	lowerGaf := strings.ToLower(gafFilename)

	// Check cache first.
	if seqMap, ok := cache[lowerGaf]; ok {
		if idx, ok := seqMap[strings.ToLower(seqName)]; ok {
			return idx
		}
		return 0
	}

	// Load GAF and build sequence name → index map.
	seqMap := make(map[string]int)
	cache[lowerGaf] = seqMap

	gafPath := fmt.Sprintf("anims/%s.gaf", lowerGaf)
	data, err := vfs.ReadFile(gafPath)
	if err != nil {
		return 0
	}

	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return 0
	}
	defer func() { _ = reader.Close() }()

	sequences, err := reader.ReadSequences()
	if err != nil {
		return 0
	}

	for i, seq := range sequences {
		seqMap[strings.ToLower(seq.Name)] = i
	}

	if idx, ok := seqMap[strings.ToLower(seqName)]; ok {
		return idx
	}
	return 0
}
