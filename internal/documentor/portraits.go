package documentor

import (
	"fmt"
	"image/png"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/coreprime/kbot-io/formats/pcx"
)

// PortraitResult summarises a portrait batch conversion run.
type PortraitResult struct {
	Converted int
	Skipped   int // already present and Skip mode enabled
	Failed    int
}

// PortraitExt is the on-disk file extension portraits land at after a
// game's batch run. TA writes PNGs (converted from PCX); TA:K writes
// JPGs (copied verbatim from anims/buildpic/*.jpg).
func (g Game) PortraitExt() string {
	if g == GameTAKingdoms {
		return ".jpg"
	}
	return ".png"
}

// ConvertPortraits is a thin wrapper that dispatches to the right
// per-game pipeline. Use the game-typed entry point in new code.
func ConvertPortraits(flatRoot, outDir string, skipExisting bool) (PortraitResult, error) {
	return ConvertPortraitsForGame(flatRoot, outDir, skipExisting, GameTotalA)
}

// ConvertPortraitsForGame routes to the per-game portrait pipeline:
//   - GameTotalA      → unitpics/*.pcx, decoded and re-encoded as PNG
//   - GameTAKingdoms  → anims/buildpic/*.jpg, copied verbatim
//
// outDir is created if missing. If skipExisting is true, files already
// present at the destination are left alone (cheap reruns). Failures
// are logged to stderr and counted but do not abort the batch.
func ConvertPortraitsForGame(flatRoot, outDir string, skipExisting bool, game Game) (PortraitResult, error) {
	if err := os.MkdirAll(outDir, 0o755); err != nil {
		return PortraitResult{}, fmt.Errorf("create out dir: %w", err)
	}
	if game == GameTAKingdoms {
		return copyJPGPortraits(filepath.Join(flatRoot, "anims", "buildpic"), outDir, skipExisting)
	}
	return convertPCXPortraits(filepath.Join(flatRoot, "unitpics"), outDir, skipExisting)
}

// convertPCXPortraits handles TA's unitpics/*.pcx → outDir/*.png.
func convertPCXPortraits(src, outDir string, skipExisting bool) (PortraitResult, error) {
	res := PortraitResult{}
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, fmt.Errorf("read unitpics: %w", err)
	}
	for _, ent := range entries {
		if ent.IsDir() || !strings.EqualFold(filepath.Ext(ent.Name()), ".pcx") {
			continue
		}
		base := strings.ToLower(strings.TrimSuffix(ent.Name(), filepath.Ext(ent.Name())))
		dst := filepath.Join(outDir, base+".png")
		if skipExisting {
			if _, err := os.Stat(dst); err == nil {
				res.Skipped++
				continue
			}
		}
		if err := convertOnePCX(filepath.Join(src, ent.Name()), dst); err != nil {
			fmt.Fprintf(os.Stderr, "documentor: portrait %s: %v\n", ent.Name(), err)
			res.Failed++
			continue
		}
		res.Converted++
	}
	return res, nil
}

// copyJPGPortraits handles TA:K's anims/buildpic/*.jpg → outDir/*.jpg
// (verbatim — these are already real JPEGs and decoding/re-encoding
// would only lose quality).
func copyJPGPortraits(src, outDir string, skipExisting bool) (PortraitResult, error) {
	res := PortraitResult{}
	entries, err := os.ReadDir(src)
	if err != nil {
		if os.IsNotExist(err) {
			return res, nil
		}
		return res, fmt.Errorf("read buildpic: %w", err)
	}
	for _, ent := range entries {
		if ent.IsDir() || !strings.EqualFold(filepath.Ext(ent.Name()), ".jpg") {
			continue
		}
		base := strings.ToLower(strings.TrimSuffix(ent.Name(), filepath.Ext(ent.Name())))
		dst := filepath.Join(outDir, base+".jpg")
		if skipExisting {
			if _, err := os.Stat(dst); err == nil {
				res.Skipped++
				continue
			}
		}
		if err := copyFile(filepath.Join(src, ent.Name()), dst); err != nil {
			fmt.Fprintf(os.Stderr, "documentor: portrait %s: %v\n", ent.Name(), err)
			res.Failed++
			continue
		}
		res.Converted++
	}
	return res, nil
}

func convertOnePCX(srcPath, dstPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	reader, err := pcx.LoadFromReader(src)
	if err != nil {
		return fmt.Errorf("parse: %w", err)
	}
	img, err := reader.Decode()
	if err != nil {
		return fmt.Errorf("decode: %w", err)
	}
	out, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer func() { _ = out.Close() }()
	if err := png.Encode(out, img); err != nil {
		return fmt.Errorf("png encode: %w", err)
	}
	return nil
}

func copyFile(srcPath, dstPath string) error {
	src, err := os.Open(srcPath)
	if err != nil {
		return err
	}
	defer func() { _ = src.Close() }()
	dst, err := os.Create(dstPath)
	if err != nil {
		return err
	}
	defer func() { _ = dst.Close() }()
	if _, err := io.Copy(dst, src); err != nil {
		return fmt.Errorf("copy: %w", err)
	}
	return nil
}
