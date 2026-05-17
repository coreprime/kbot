---
name: kbot
description: Toolkit for reverse-engineering and working with Total Annihilation game assets — COB/BOS unit scripts, HPI/UFO/CCX archives, GAF sprite animations, PCX images, Smacker (.smk/.zrb) video, PCX palettes, TDF/FBI/OTA configs, TNT maps, SCT sections, 3DO models, ALP/LHT/SHD lookup tables, and bitmap fonts. Use when the user mentions Total Annihilation, TA, Cavedog, Boneyards, or any of the listed file formats; when working with files under directories named like "totala", "ta-flattened", or with extensions .cob, .bos, .hpi, .ufo, .ccx, .gaf, .tnt, .sct, .3do, .fbi, .ota, .tdf, .smk, .zrb; or when asked to decompile/lint unit scripts, inspect or pack TA archives, or convert TA images and videos.
user-invocable: false
---

# kbot — Total Annihilation Toolkit Skill

`kbot` is a Go CLI that parses, inspects, transforms, and produces Total Annihilation (1997, Cavedog) game files. It is the canonical tooling for the Core Prime / Boneyards re-implementation project. There is one binary, `kbot`, with several format-specific subcommands plus an MCP server mode for AI assistants.

## When to use this skill

Trigger when the conversation involves:

- **Unit scripting**: `.cob` (compiled bytecode), `.bos` (source), `.coba` (assembly listing). Symptoms: animation hooks (`Create`, `MotionControl`, `QueryPrimary`), opcodes like `move`/`turn`/`spin`/`sleep`/`emit-sfx`, references to "piece", "static var", "signal mask".
- **Archive packaging**: `.hpi` (HAPI/Cavedog), `.ufo` (mod archives, same format), `.ccx` (commander campaign).
- **Graphics**: `.gaf` (multi-sequence sprite frames with palette indices + alpha), `.pcx` (paletted images, units' wireframes, GUI), TA's fixed 256-entry palette.
- **Maps**: `.tnt` (terrain), `.sct` (reusable section). Mention of "start positions", "feature overlays", "tile grid", "height maps".
- **Models**: `.3do` (object hierarchy with texture lists).
- **Config**: `.tdf`/`.fbi`/`.ota` (text data files — units, weapons, missions, side data).
- **Video/audio**: `.smk` / `.zrb` (Smacker movies), `.wav`, `.mp3`.
- **Misc**: bitmap fonts (1bpp MSB-first), `.alp`/`.lht`/`.shd` color lookup tables, AI opponent profiles.

If the user mentions Total Annihilation, "TA", Cavedog, Boneyards, Core Prime, or asks to inspect/convert/build any of the above, `kbot` is the right tool — prefer it over hand-written parsers.

## Two ways to invoke

### 1. CLI (default)

```bash
kbot <subcommand> [args]              # binary on PATH after `task install`
./bin/kbot <subcommand> [args]        # local dev build
```

All read commands accept `--stream` to read from stdin and `--target <path>` to write somewhere other than stdout.

### 2. MCP server (for AI agents like Claude Desktop / Cursor)

```bash
kbot mcp --mount ~/games/totala               # stdio transport, sandboxed
kbot mcp --http 127.0.0.1:8765 --mount ~/...  # streamable HTTP, multi-client
```

`--mount <dir>` is an allow-list; **any** path argument passed to a tool must resolve under one of the mounted roots. Multiple `--mount` flags are allowed. With no mounts the server runs permissively (every absolute path is accepted) — fine for local dev, unsafe for shared hosts. **Never write to `stdout`** when serving stdio: status logs go to `stderr`.

## CLI subcommand reference

### `kbot cob` — COB/BOS scripting

`COB` is compiled bytecode for unit AI/animation; `BOS` is the source language (Switech-era C-like). `kbot` is round-trip-perfect: decompile → compile and disassemble → assemble both produce byte-identical output.

| Sub-sub | Purpose |
|---|---|
| `decompile <file.cob>` | COB → BOS source |
| `compile <file.bos>` | BOS → COB |
| `disassemble <file.cob>` | COB → assembly listing. `-a` for annotated (flow arrows + hex opcodes); `-s <script>` for a single function. |
| `assemble <file.coba>` | assembly → COB |
| `lint <file-or-dir>` | static analysis (see rules below). `-q` for summary only. |
| `roundtrip <dir>` | validates byte-perfect round-trip across a tree. `--detailed` to enumerate failures. |

**Lint rules** (17 total; severities: ❌ error / ⚠️ warning / ℹ️ info):

`unused-piece`, `unused-static`, `unused-local`, `always-true` (`if(1)`, `while(1)`), `dead-code` (`if(0)`, `while(0)`), `long-function` (>100 instr), `high-complexity` (cyclomatic >15), `invalid-call` (❌ — call-script to missing function), `speed-zero` (move/turn with `speed <0>` — never completes), `empty-function`, `duplicate-animation`, `sleep-only-guard`, `duplicate-if`, `raw-signal`, `unnamed-global` (`global_N`), `signal-never-signalled`, `recursive-call`.

### `kbot hpi` — HPI/UFO/CCX archives

```bash
kbot hpi list <archive>          [-v] [-p "*.cob"]
kbot hpi info <archive>
kbot hpi extract <archive>       [-t outdir] [-p "sounds/*"]
kbot hpi pack <directory>        --target out.hpi
```

All read commands accept `--stream`.

### `kbot gaf` — sprite animations

```bash
kbot gaf list <file.gaf>
kbot gaf export <file.gaf> --format gif|png [--sequence N]
kbot gaf dump <file.gaf>   --target ./out [--format png]      # all sequences + frames.csv per folder
kbot gaf build <dump-dir>  --target rebuilt.gaf               # reads frames.csv for timing
```

`png` exports as APNG. `frames.csv` carries per-frame durations used by `build`.

### `kbot pcx` — PCX images

```bash
kbot pcx describe <file.pcx>
kbot pcx info <file.pcx>
kbot pcx convert <file.pcx> --format png|gif|bmp [--target out.png]
```

### `kbot zrb` — Smacker video

```bash
kbot zrb info <file.smk>
kbot zrb to-mp4   <file.smk> --target out.mp4
kbot zrb from-mp4 <in.mp4>   --target out.smk
```

Requires FFmpeg on `PATH` for conversions.

### `kbot mount` — virtual filesystem / explorer

```bash
kbot mount <root>                                 # interactive TTY browser
kbot mount <root> --server [--port 8080]          # web UI (rich previews)
kbot mount <root> flatten --target <out>          # extract every archive into a flat tree
```

The mount system **layers HPI/UFO archives over a directory** the same way the game's engine does (later archives override earlier ones). Use `flatten` to materialise the merged view onto disk — this is the canonical "give me an unpacked TA tree" command.

Interactive TTY commands: `ls`, `cd`, `pwd`, `cat`, `describe`, `archives`, `stats`, `exit`.

Web UI handles previews for COB, GAF, PCX, WAV/MP3, SMK/ZRB, TNT, SCT, 3DO, TDF/FBI/OTA, palettes (ALP/LHT/SHD), bitmap fonts, plus call-graph visualisation for scripts/signals.

### `kbot mcp` — MCP server

See the [Two ways to invoke](#two-ways-to-invoke) section. The MCP server exposes a curated subset of the CLI as JSON-schema'd tools (see next section).

## MCP tool reference

Exposed when running `kbot mcp`. All `path` and `output` arguments are validated against the configured `--mount` allow-list.

| Tool | Required args | Optional args | Returns |
|---|---|---|---|
| `cob_decompile` | `path` | — | BOS source text |
| `cob_disassemble` | `path` | `script` (single function name), `annotated` (bool, default false) | assembly listing text |
| `cob_lint` | `path` (file or dir) | — | JSON `{diagnostics: [{file, rule, severity, script, line, message}], summary: {rule: count}, files_linted, has_errors}` |
| `cob_info` | `path` | — | JSON `{path, version, num_scripts, num_pieces, num_statics, script_names, piece_names, code_bytes}` — fast, no decompile |
| `hpi_list` | `path` | `pattern` (glob, e.g. `'*.fbi'`) | file listing |
| `hpi_info` | `path` | — | header + content summary (version, file count, compression ratio) |
| `hpi_extract_file` | `path`, `entry` (in-archive path), `output` (on-disk dest) | — | bytes written + resolved output path |
| `gaf_list` | `path` | — | sequences with name, frame count, total duration |
| `gaf_export` | `path`, `output` | `sequence` (index, default 0), `format` (`gif` default, `png` = APNG) | path to rendered image |
| `pcx_describe` | `path` | — | version, encoding, dimensions, bit depth, plane count, DPI, colour-type |
| `pcx_convert` | `path`, `output` | `format` (`png`/`gif`/`bmp`; inferred from extension when omitted) | path to converted image |
| `tdf_parse` | `path` | — | structured JSON tree preserving section name case and field order |

Only these five format families are exposed via MCP today: COB, HPI, GAF, PCX, TDF. For everything else (SCT, TNT, 3DO, ZRB, FNT, mount/flatten), use the CLI.

## Source layout (when reading/extending the code)

```
kbot/
├── cmd/kbot/                  CLI entry points (one *.go per subcommand)
├── formats/                   Public format packages — import these directly from Go code
│   ├── ai/                    AI opponent profiles
│   ├── fnt/                   Bitmap fonts (1bpp, MSB-first)
│   ├── gaf/                   Sprite animations + writer
│   ├── hpi/                   HPI/UFO/CCX archives
│   ├── pcx/                   PCX images
│   ├── scripting/             COB/BOS bytecode
│   │   ├── assembly/             assembler + disassembler
│   │   ├── compiler/             BOS → COB
│   │   ├── decompiler/           COB → BOS
│   │   ├── linter/               17-rule static analysis
│   │   └── parser/               lexer, parser, preprocessor
│   ├── sct/                   map sections
│   ├── smacker/               Smacker video
│   ├── tdf/                   text data files
│   ├── tdo/                   3DO models
│   └── tnt/                   map terrain
├── filesystem/                virtual FS that layers archives over disk
└── internal/
    ├── assets/                embedded TA palette
    ├── cache/                 on-disk file cache
    ├── explorer/              web UI server + React app
    └── mcp/                   MCP server + tool handlers
```

When adding format support: parsers and writers live under `formats/<ext>/`; CLI wiring goes in `cmd/kbot/<ext>*.go`; MCP exposure (if any) goes in `internal/mcp/tools_<ext>.go` and must be registered in `internal/mcp/server.go`.

## Common workflows

### Inspect a unit's behaviour
```bash
kbot cob info  units/ARMCOM.cob          # quick metadata, no decompile
kbot cob decompile units/ARMCOM.cob      # full BOS source
kbot cob lint  units/ARMCOM.cob          # static analysis
```

### Get a flat working copy of a TA install
```bash
kbot mount ~/games/total-annihilation --flatten --target ./ta-flattened
```
This is what `TA_UNPACKED_PATH` in `.env.local` should point at; tests rely on it.

### Extract just the unit scripts from an archive
```bash
kbot hpi list   totala1.hpi -p "*.cob"
kbot hpi extract totala1.hpi -p "units/*.cob" -t ./scripts
```

### Convert TA artwork for external use
```bash
kbot pcx convert weapons.pcx --format png
kbot gaf export armcom.gaf --format png --sequence 0  # APNG for transparent frames
```

### Browse interactively
```bash
kbot mount ~/games/totala --server      # then open http://localhost:8080
```

