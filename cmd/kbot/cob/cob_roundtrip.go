package cob

import (
	"bytes"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/coreprime/kbot/cmd/kbot/internal/cli"
	"github.com/coreprime/kbot-io/formats/scripting"
	"github.com/coreprime/kbot-io/formats/scripting/assembly"
	"github.com/coreprime/kbot-io/formats/scripting/compiler"
	"github.com/coreprime/kbot-io/formats/scripting/decompiler"
)

func newCobRoundtripCommand() *cobra.Command {
	var detailed bool

	cmd := &cobra.Command{
		Use:   "roundtrip [path]",
		Short: "Validate roundtrip fidelity for COB files",
		Long: `Scan a directory for .cob files and verify that both the
decompile→compile and disassemble→assemble pipelines produce
byte-identical output.

Path resolution: an explicit <path> wins; otherwise the active
kbot context is scanned (see 'kbot ctx'); otherwise the current
working directory.

Each file is tested entirely in memory.  Use --detailed to see
step-by-step output for every file.`,
		Args: cobra.MaximumNArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			path := ""
			if len(args) > 0 {
				path = args[0]
			}
			resolved, source, err := cli.ResolveVFSPath(path)
			if err != nil {
				return err
			}
			if resolved == "" {
				cwd, cwdErr := os.Getwd()
				if cwdErr != nil {
					return fmt.Errorf("no path, no active kbot context, and could not read the current directory: %w", cwdErr)
				}
				resolved = cwd
				source = "current directory"
			}
			cli.ReportContextSource(source)
			return runRoundtrip(resolved, detailed)
		},
	}

	cmd.Flags().BoolVarP(&detailed, "detailed", "d", false, "Show step-by-step output for every file")

	return cmd
}

// ── result ─────────────────────────────────────────────────────────────────

type roundtripResult struct {
	File     string
	OrigHash string
	OrigSize int

	BOSSize    int
	RecompSize int
	RecompHash string
	RecompOK   bool
	RecompErr  string

	COBASize  int
	ReasmSize int
	ReasmHash string
	ReasmOK   bool
	ReasmErr  string
}

// ── runner ─────────────────────────────────────────────────────────────────

func runRoundtrip(root string, detailed bool) error {
	// Collect .cob files.
	var cobFiles []string
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil {
			return nil // skip unreadable entries
		}
		if !info.IsDir() && strings.EqualFold(filepath.Ext(path), ".cob") {
			cobFiles = append(cobFiles, path)
		}
		return nil
	})
	if err != nil {
		return fmt.Errorf("failed to scan %s: %w", root, err)
	}

	sort.Strings(cobFiles)

	if len(cobFiles) == 0 {
		return fmt.Errorf("no .cob files found in %s", root)
	}

	fmt.Fprintf(os.Stderr, "\n  %s Scanning %s — %d file(s)\n\n",
		"🔍", root, len(cobFiles))

	// Process each file.
	results := make([]roundtripResult, 0, len(cobFiles))

	for _, path := range cobFiles {
		r := testOneFile(path, detailed)
		results = append(results, r)

		if !detailed {
			icon := "✅"
			if !r.RecompOK || !r.ReasmOK {
				icon = "❌"
			}
			status := ""
			if !r.RecompOK {
				status += " recomp"
				if r.RecompErr != "" {
					status += "(" + r.RecompErr + ")"
				}
			}
			if !r.ReasmOK {
				status += " reasm"
				if r.ReasmErr != "" {
					status += "(" + r.ReasmErr + ")"
				}
			}
			if status == "" {
				fmt.Fprintf(os.Stderr, "  %s %s\n", icon, filepath.Base(path))
			} else {
				fmt.Fprintf(os.Stderr, "  %s %s —%s\n", icon, filepath.Base(path), status)
			}
		}
	}

	// ── summary ────────────────────────────────────────────────────────
	totalFiles := len(results)
	recompPass, reasmPass := 0, 0
	for _, r := range results {
		if r.RecompOK {
			recompPass++
		}
		if r.ReasmOK {
			reasmPass++
		}
	}

	allPass := recompPass == totalFiles && reasmPass == totalFiles

	recompFrac := fmt.Sprintf("%d / %d", recompPass, totalFiles)
	reasmFrac := fmt.Sprintf("%d / %d", reasmPass, totalFiles)

	fmt.Fprintln(os.Stderr)
	fmt.Fprintln(os.Stderr, "  +----------------------------------------------+")
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Files scanned:            %d", totalFiles))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Decompile -> Compile:     %-11s %s", recompFrac, cli.PassFail(recompPass == totalFiles)))
	fmt.Fprintf(os.Stderr, "  | %-45s|\n", fmt.Sprintf("Disassemble -> Assemble:  %-11s %s", reasmFrac, cli.PassFail(reasmPass == totalFiles)))
	if allPass {
		fmt.Fprintln(os.Stderr, "  |                                              |")
		fmt.Fprintf(os.Stderr, "  | %-45s|\n", "All roundtrips passed!")
	}
	fmt.Fprintln(os.Stderr, "  +----------------------------------------------+")
	fmt.Fprintln(os.Stderr)

	if !allPass {
		return fmt.Errorf("%d recomp + %d reasm failures",
			totalFiles-recompPass, totalFiles-reasmPass)
	}
	return nil
}

// ── per-file test ──────────────────────────────────────────────────────────

func testOneFile(path string, detailed bool) roundtripResult {
	name := filepath.Base(path)
	r := roundtripResult{File: name}

	log := func(format string, a ...any) {
		if detailed {
			fmt.Fprintf(os.Stderr, format, a...)
		}
	}

	// Load original.
	origData, err := os.ReadFile(path)
	if err != nil {
		r.RecompErr = "read"
		r.ReasmErr = "read"
		log("  %s\n    ⚠️  read error: %v\n", name, err)
		return r
	}
	r.OrigSize = len(origData)
	r.OrigHash = cli.MD5Hex(origData)

	origCOB, err := scripting.LoadFromReader(bytes.NewReader(origData))
	if err != nil {
		r.RecompErr = "parse"
		r.ReasmErr = "parse"
		log("  %s\n    ⚠️  parse error: %v\n", name, err)
		return r
	}

	if detailed {
		fmt.Fprintf(os.Stderr, "  %s\n", name)
	}

	// ── decompile → compile ────────────────────────────────────────────
	log("    → Decompiling\n")
	dec := decompiler.NewDecompiler(origCOB)
	bosText, err := dec.Decompile()
	if err != nil {
		r.RecompErr = "decompile"
		log("    ⚠️  decompile error: %v\n", err)
	} else {
		r.BOSSize = len(bosText)
		log("    → Decompiled to %d bytes of BOS script\n", r.BOSSize)

		log("    → Recompiling\n")
		comp := compiler.NewCompiler(bosText)
		recompCOB, err := comp.Compile()
		if err != nil {
			r.RecompErr = "compile"
			log("    ⚠️  compile error: %v\n", err)
		} else {
			var buf bytes.Buffer
			_ = recompCOB.WriteToWriter(&buf)
			recompData := buf.Bytes()
			r.RecompSize = len(recompData)
			r.RecompHash = cli.MD5Hex(recompData)
			r.RecompOK = bytes.Equal(origData, recompData)
			log("    → Recompiled to %d bytes of COB\n", r.RecompSize)
		}
	}

	// ── disassemble → assemble ─────────────────────────────────────────
	// Reload COB to get a clean decompiler instance.
	origCOB2, _ := scripting.LoadFromReader(bytes.NewReader(origData))
	dec2 := decompiler.NewDecompiler(origCOB2)

	log("    → Disassembling\n")
	cobaText, err := dec2.Disassemble(assembly.Plain)
	if err != nil {
		r.ReasmErr = "disassemble"
		log("    ⚠️  disassemble error: %v\n", err)
	} else {
		r.COBASize = len(cobaText)
		log("    → Disassembled to %d bytes of COBA\n", r.COBASize)

		log("    → Reassembling\n")
		asm := assembly.NewAssembler()
		reasmCOB, err := asm.Assemble(cobaText)
		if err != nil {
			r.ReasmErr = "assemble"
			log("    ⚠️  assemble error: %v\n", err)
		} else {
			var buf bytes.Buffer
			_ = reasmCOB.WriteToWriter(&buf)
			reasmData := buf.Bytes()
			r.ReasmSize = len(reasmData)
			r.ReasmHash = cli.MD5Hex(reasmData)
			r.ReasmOK = bytes.Equal(origData, reasmData)
			log("    → Assembled to %d bytes of COB\n", r.ReasmSize)
		}
	}

	if detailed {
		log("    ─────────────────────────────────\n")
		log("    Original  MD5  %s  (%d bytes)\n", r.OrigHash, r.OrigSize)
		if r.RecompHash != "" {
			log("    Recomp    MD5  %s  (%d bytes)\n", r.RecompHash, r.RecompSize)
		}
		if r.ReasmHash != "" {
			log("    Reasm     MD5  %s  (%d bytes)\n", r.ReasmHash, r.ReasmSize)
		}

		icon := "✅"
		if !r.RecompOK || !r.ReasmOK {
			icon = "❌"
		}
		parts := []string{}
		if r.RecompOK {
			parts = append(parts, "recomp ✓")
		} else {
			parts = append(parts, "recomp ✗")
		}
		if r.ReasmOK {
			parts = append(parts, "reasm ✓")
		} else {
			parts = append(parts, "reasm ✗")
		}
		log("    %s  %s\n\n", icon, strings.Join(parts, "  "))
	}

	return r
}

// ── helpers ────────────────────────────────────────────────────────────────
