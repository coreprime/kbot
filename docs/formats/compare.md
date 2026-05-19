# TA vs TA: Kingdoms — Format Differences

A single page summarising what's the same, similar, or different
between Total Annihilation (1997) and TA: Kingdoms (1999). Useful
when porting work between the two games or deciding which game your
tool needs to support.

> [!TIP]
> **TL;DR.** TA:K kept most of TA's container formats (HPI, GAF,
> TDF, COB) but simplified the wrappers (no XOR in HPI v2, no
> separate weapons/ directory, no 2×3 build grid) and introduced
> entirely new things on top (4 sides, mogrium economy, spell-cast
> "weapons", per-mission `.kmp` archives).

---

## Quick-reference matrix

| Format | TA | TA: Kingdoms | Status in kbot |
|--------|----|--------------|----------------|
| **HPI / UFO / CCX / GP3** archive | v1 — XOR-encrypted, multi-chunk per file, ≤64 KiB chunks | v2 — plaintext envelope, single SQSH chunk per file, ~32-byte header | ✅ Read both; ✅ write v1; ❌ write v2 |
| **`.kmp` campaign archives** | N/A | HPI v2 with renamed extension; bundles per-mission map + scripts + GAFs | ✅ Read |
| **GAF / TAF** sprite animations | `.gaf`, palette comes from `palettes/palette.pal` | `.taf` (same binary format), palette from per-side `.pcx` | ✅ Read both; ✅ write GAF |
| **PCX** images | `unitpics/<name>.pcx` for unit portraits (96×96 paletted) | Used as 1×1 palette carrier next to `.taf` | ✅ Read/write |
| **PAL / ALP / LHT / SHD** | Global TA palette + lookup tables | Per-side palettes inside PCX carriers; no `.alp`/`.lht`/`.shd` tables observed in install | ✅ TA; N/A TA:K |
| **FNT** bitmap fonts | `fonts/*.fnt` 1bpp glyphs | Same format, larger glyph set typical | ✅ Read |
| **SCT** map sections | `sections/<biome>/*.sct` reusable tile blocks for the TAE editor | Not used — TA:K's tile system is different | ✅ TA; N/A TA:K |
| **TNT** map terrain | `IDVersion == 0x2000`, tile-grid + heightmap + features + minimap | `IDVersion == 0x4000` (variant); same overall structure, different tile decoder | ✅ TA; ⚠️ TA:K (header reads, tiles undecoded) |
| **TA:K map sidecars** | N/A | `.ota` (TDF metadata), `.txt` (description), `.crt` (binary, purpose unknown) | ✅ `.ota`; — `.crt`/`.txt` |
| **3DO** models | Hierarchical, palette-indexed faces or textured | Similar but skinning model differs; some additional per-primitive fields | ✅ TA; ⚠️ TA:K (loads but kinematics differ) |
| **COB / BOS** unit scripts | `scripts/*.cob`; stack-based bytecode | Same bytecode format and same opcodes; some `GET_UNIT_VALUE` ports added | ✅ Both |
| **TDF / FBI / OTA** text configs | Same INI-shaped grammar | Same grammar | ✅ Both |
| **Inline weapon defs** | No — weapons live in `weapons/*.tdf` referenced by name | **Yes** — `[WEAPON1]`/`[WEAPON2]`/`[WEAPON3]` sub-sections inside each unit's FBI | ✅ Both via documentor |
| **AI profiles** | `ai/*.txt` with `plan`/`weight`/`limit` directives | `ai/*.txt` with bare `weight`/`limit` (no `plan` block) | ✅ Both |
| **Build menus** | Static `gamedata/sidedata.tdf` `[CANBUILD]` + dynamic `download/*.tdf` `[MENUENTRY]` overlays | Per-builder directory `canbuild/<builder>/<unit>.tdf`, each with `[Menu].Priority` | ✅ Both |
| **Build-menu grid** | 2 columns × 3 rows per page (BUTTON 0–5) | Linear list per builder, ordered by Priority | — |
| **Sound bank wiring** | 3-layer: FBI `SoundCategory` → `gamedata/sound.tdf` → `sounds/*.wav` | `soundclass=` / `soundcategory=` fields with different resolution | ✅ TA wiring; ⚠️ TA:K wiring needs writing-up |
| **Smacker / ZRB video** | `data/*.zrb` (renamed `.smk`) | Same Smacker format under different extensions | ✅ Both |
| **GUI** menus | `.gui` (different format from TA:K) | `.gui` whitespace-delimited widget tree; see [takgui.md](takgui.md) | ⚠️ TAK only described; TA `.gui` not yet covered |

**Legend:** ✅ first-class · ⚠️ partial · ❌ not supported · — N/A or no plans

---

## Things genuinely shared

Same bytes, same parser, same Go types:

- **HPI marker** (`'HAPI'`) — every archive container starts with it.
- **TDF grammar** — both games parse FBI/OTA/weapon TDFs with the
  same parser. Field names differ but the syntax is identical.
- **COB bytecode** — opcodes, stack model, signal masks, every
  `0x10xxxxxx` value catalogued in
  [cob.md](cob.md#appendix-a--full-opcode-reference) work in both.
- **Smacker video** — `.smk` / `.zrb` are bit-identical; only the
  filename extension changes.
- **3DO hierarchy concept** — both games use parent/child/sibling
  trees of named pieces, fixed-point coordinates, and primitives that
  reference textures by name.

## Things subtly different (read carefully)

- **HPI header layout.** v1 = 20 bytes total (5 × uint32). v2 = 8
  bytes prologue + 24-byte sub-header. The first 8 bytes are
  identical in both (marker + version) so a v1-only reader will
  succeed at validating the magic before crashing on the rest.
  See [hpi.md HPI v2](hpi.md#ta-kingdoms--hpi-v2).
- **FBI economy fields.** TA: `BuildCostMetal=` + `BuildCostEnergy=`.
  TA:K: single `buildcost=` (mogrium). The documentor handles both
  via `Unit.BuildMetal`/`BuildEnergy` (TA) and `Unit.BuildCost`
  (TA:K) — see [types.go](../../internal/documentor/types.go).
- **Side codes.** TA: `ARM` / `CORE`. TA:K: `ARA` / `TAR` / `VER` /
  `ZON` + `CRE` (Iron Plague) + `MON` / `LIF` / `NPC`.
- **Weapon archetype.** TA: a *bag* of boolean fields
  (`ballistic=1`, `lineofsight=1`, `guidance=1`, `beamweapon=1`, …).
  TA:K: a single `type=Ballistic` / `Missile` / `Magical` / `Melee`
  string.
- **Damage modelling.** Both use a `[DAMAGE]` sub-section under a
  weapon with a `default=` plus per-target overrides. TA:K
  additionally uses `damagecategory=` on each unit (`Human`,
  `Building`, `Magical`) for broad-class resistance modelling.

## Things only TA has

- **Multi-chunk file payloads** in HPI archives (the `≤64 KiB chunks
  with size table` model).
- **HPI XOR encryption** (per-position seed + transformed key).
- **`download/*.tdf` `[MENUENTRY]` overlay** for adding build-menu
  entries without forking sidedata.tdf.
- **2×3 build-menu grid** with `BUTTON` 0–5 (top-left to bottom-right).
- **Separate `weapons/` directory** of TDFs referenced by name.
- **SCT (section) editor format** — TAE specific.
- **Global TA palette + ALP/LHT/SHD lookup tables.**

## Things only TA: Kingdoms has

- **HPI v2** with simplified single-chunk file payloads.
- **`canbuild/<builder>/<unit>.tdf` directory tree** for build-menu
  registration (linear, no grid).
- **Inline `[WEAPONn]` weapon definitions** inside FBIs.
- **Mogrium single-resource economy** (`buildcost=`, no
  metal/energy split).
- **Per-side palettes carried inside PCX 1×1 stubs** sitting alongside
  `.taf` animation files.
- **Magic / spell-cast units** (`arapries`, `vermage`, `zonsham`)
  whose weapons are spells.
- **Four (+1) sides:** Aramon, Taros, Veruna, Zhon — plus Creon from
  the *Iron Plague* expansion.
- **`anims/buildpic/*.jpg`** — unit portraits as 64×48 JPGs (TA uses
  PCX in `unitpics/`).
- **`.kmp` campaign-mission HPI v2 archives** bundling per-mission
  maps with mission scripts.
- **`-disablecavedogverification`** command-line requirement to load
  most modded files.

## Per-page deltas — where to find each game's coverage

Every format page that has TA:K specifics carries a clearly-marked
"TA: Kingdoms" section. Quick index:

| Page | TA:K section |
|------|--------------|
| [hpi.md](hpi.md) | [TA: Kingdoms HPI v2](hpi.md#ta-kingdoms--hpi-v2), full hex walk in [Appendix — `Jersey.hpi`](hpi.md#appendix--full-hex-walk-of-jerseyhpi-hpi-v2) |
| [ai.md](ai.md) | [TA: Kingdoms — plan-less profiles](ai.md#ta-kingdoms--plan-less-profiles) |
| [takgui.md](takgui.md) | Entire page is TA:K-only |
| [takmap.md](takmap.md) | Entire page is TA:K-only |

Reference catalogues live in separate repos:

- [`coreprime/reference-ta`](https://github.com/coreprime/reference-ta)
  — 278 units, 199 weapons, 45 builders.
- [`coreprime/reference-tak`](https://github.com/coreprime/reference-tak)
  — 203 units, 198 weapons, 32 builders.

---

## See also

- [`internal/documentor`](../../internal/documentor/) — the Go package
  that handles both games' extraction.
- [Pitfalls](pitfalls.md) — game-specific gotchas in one place.
- [Modding tutorial](modding.md) — currently TA only; TA:K coverage is
  a known gap.
- [Glossary](glossary.md) — cross-game terminology reference.
