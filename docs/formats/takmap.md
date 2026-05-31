# TA: Kingdoms Maps — `.tnt` + `.ota` + `.crt` + `.kmp`

> *TA: Kingdoms* maps are **a TNT variant** (different IDVersion word)
> wrapped with one or two metadata files, plus an HPI v2 campaign-
> archive format for single-player missions. This is significantly
> closer to TA's map model than the older "BTM/heightmap-BMP" research
> notes suggested — looking at an actual GoG TA:K install, no `.btm`
> or sidecar BMPs are present at all.
>
> kbot's existing [HPI v2](hpi.md#ta-kingdoms--hpi-v2) reader handles
> `.kmp` archives transparently. kbot's TNT reader recognises the TA:K
> version word and decodes the header, the DataUnit heightmap, the
> texture-mapping grid (terrain-name + U/V offset tables), the feature
> placement grid + name table, and the embedded minimap — enough to
> render a complete map at full resolution by compositing the external
> terrain JPGs and feature GAF sprites. This page documents what's
> verifiable from the shipped install plus the remaining gaps.

> [!IMPORTANT]
> **Status update (vs. the original "research notes" version of this
> page).** The format file types this page used to discuss — `.btm`,
> sidecar BMPs, per-side palette PCXes — **are not actually present**
> in the shipped GoG TA: Kingdoms install. The real file types are
> documented below. For comparison-shopping against another open-source
> TA:K project, see
> [iiCompleteDestruction](https://github.com/btigi/iiCompleteDestruction/tree/main/src);
> their parser implementation is more complete than kbot's for some
> TA:K-specific structures.

---

## Files that make up a TA:K map

Counting across the maps directory of the GoG install:

| Extension | Count | Purpose |
|-----------|------:|---------|
| `.kmp` | 181 | **HPI v2** archive bundling a campaign mission's map + scripts + assets |
| `.tnt` | 55 | Map terrain data (TNT-shaped binary with a TA:K-specific IDVersion word) |
| `.ota` | 55 | Map metadata — TDF format, same shape as TA's `.ota` with TAK-specific fields |
| `.txt` | 55 | Free-text map description (a few words; shown in the lobby) |
| `.crt` | 33 | Small (≤256-byte) binary — probably camera/start-pos hints; not yet decoded |
| `.tdf` | 6 | Per-map gameplay tweak files (campaign-tuning, AI nudges) |

A typical multiplayer map ships as a `.tnt` + `.ota` + `.txt` triple,
sometimes with a `.crt` sidecar. Campaign missions are packed into
`.kmp` archives that bundle the same set with mission scripts.

> [!TIP]
> **List a TA:K map bundle without unpacking anything:**
> ```bash
> # The HPI v2 reader handles .kmp transparently
> kbot hpi list /path/to/tak/maps/adamantine\ gate.kmp -v
> kbot hpi info /path/to/tak/maps/adamantine\ gate.kmp
> ```

---

## `.tnt` — TA:K terrain (TNT v2)

TA:K reuses TA's TNT structure but **bumps the IDVersion word**. Hex
dump of `abnar's terrace.tnt`:

```
00000000: 00 40 00 00 20 01 00 00 e0 00 00 00 3a 00 00 00   .@.. .......:...
00000010: 34 00 00 00 34 fc 00 00 34 f4 02 00 16 00 00 00   4...4...4.......
```

The first uint32 is **`0x00004000`** — compare to TA's TNT which uses
`0x00002000`. The container is still a header followed by
pointer-addressed sections, but **TA:K is not a tile-mosaic format at
all.** Where TA stores a tile-index grid + a palette of 32×32 tile
graphics, TA:K stores terrain as a **texture-mapping grid** that
references external JPG textures, plus a separate **heightmap** and a
**feature placement grid**. All of the following is verified across the
55 shipped maps:

1. **`Width`/`Height` are counts of 16px _DataUnits_, not pixels.** A
   "15 × 15" map like `athri cay` stores `Width = Height = 480`
   DataUnits → `480 × 16 = 7680` px on a side. The heightmap and feature
   grid are sampled per DataUnit; the terrain is sampled on a coarser
   32px **Graphic Unit** grid, exactly half the DataUnit grid on each
   axis (`guW = Width/2`).
2. **The header is twelve sequential `uint32`s** of offsets and counts;
   the TA field names no longer describe the contents. The table below
   gives the TA:K meaning.
3. **Section pointers are absolute**, so each section is read by its own
   pointer + computed length.

| Offset | TA:K field | Section size | Notes |
|-------:|:-----------|:-------------|:------|
| `0x00` | `Version` | — | `0x4000` (TA writes `0x2000`) |
| `0x04` | `Width` | — | DataUnits; `×16` → pixels, `÷2` → Graphic Units |
| `0x08` | `Height` | — | DataUnits |
| `0x0C` | `SeaLevel` | — | height threshold for water |
| `0x10` | `HeightMapOffset` | `Width × Height` bytes | one height byte per DataUnit |
| `0x14` | `AttributesOffset` | `Width × Height` × 2 | feature grid: `uint16` index per DataUnit (`≥0xFF00` = none) |
| `0x18` | `FeatureNamesOffset` | `Count × 132` | feature name table (4-byte index + 128-byte name) |
| `0x1C` | `FeatureCount` | — | number of feature types |
| `0x20` | `TerrainNamesOffset` | `guW × guH` × 4 | per-GU texture name → `terrain/%08x.jpg` |
| `0x24` | `UMappingOffset` | `guW × guH` bytes | per-GU column offset into its texture (×32px) |
| `0x28` | `VMappingOffset` | `guW × guH` bytes | per-GU row offset into its texture (×32px) |
| `0x2C` | `MiniMapOffset` | `8 + 126×126` | `uint32 w`, `uint32 h`, then indices |

The **heightmap** (`0x10`) is one byte per DataUnit — a greyscale
elevation field, _not_ a colour bitmap. The **terrain** is reconstructed
by texture-mapping: for each Graphic Unit, the terrain-name table
(`0x20`) gives a texture file (`terrain/<name>.jpg`, the name formatted
as lowercase 8-digit hex), and the U/V tables (`0x24`/`0x28`) give the
32×32 sub-tile to copy from that JPG at `(u×32, v×32)`. The **feature
grid** (`0x14`) is the placement layer: a `Width × Height` array of
`uint16`, each cell either a feature index into the name table or a high
sentinel (`≥0xFF00`) meaning "no feature here"; a placement's DataUnit
cell `(x, y)` maps to terrain pixel `(x×16, y×16)`. The **name table**
(`0x18`) uses the same 132-byte entry layout as TA's TileAnim table.

The minimap block is **always 126 × 126** across the shipped corpus and
uses the **same `0x64` void byte** as TA for padding outside non-square
maps.

> [!NOTE]
> **What works on TA:K TNTs today.** `kbot tnt describe` reports the
> header, kingdom, heightmap/terrain dimensions and feature breakdown.
> `kbot tnt preview --vfs <root>` renders the **full-resolution
> texture-mapped terrain** and composites every feature's GAF sprite on
> top, anchored at its hotspot — the complete map as the game draws it.
> `kbot tnt image` renders the self-contained greyscale heightmap (no
> external textures needed; `--features` overlays category-coloured
> markers). `kbot tnt minimap` exports the embedded 126 × 126 preview.

### Minimap palette — one per kingdom

TA:K does **not** colour its minimap with a single global palette. Each
map bakes its 126 × 126 preview against the **texture palette of the
kingdom it belongs to** — the `kingdom=` field in the sibling `.ota`
(`aramon` / `taros` / `veruna` / `zhon` / `creon`). Rendering the same
indices with the wrong kingdom's palette (or with TA's `PALETTE.PAL`)
produces speckled noise; rendering with the right one yields natural
water, beaches and terrain.

`kbot tnt minimap` resolves the kingdom automatically from the sibling
`.ota`. When the `.ota` is absent (e.g. a loose `.tnt`), pass
`--kingdom <name>` explicitly:

```bash
kbot tnt minimap "athri cay.tnt" -t mini.png          # auto: veruna
kbot tnt minimap loose.tnt --kingdom aramon -t mini.png
```

---

## `.ota` — Map metadata (TDF, mostly familiar)

TA:K's `.ota` is the same TDF-shaped format as TA's, with several
TAK-specific fields. Full file from `abnar's terrace.ota`:

```ini
[GlobalHeader]
{
    Copyright=Copyright 1998 Cavedog Entertainment. All rights reserved.;
    missionname=Abnar's Terrace;
    missiondescription=9 x 7  4 Player  32MB;
    kingdom=veruna;          // ← TA:K-specific: the side the map "belongs" to
    numplayers=4;
    size=9 x 7;              // ← TA:K-specific: free-text size for the lobby
    memory=32 MB;            // ← TA:K-specific: ~RAM requirement for the lobby
    hasscenario=0;
    [Map Data]
    {
        Type=Network 1;
        aiprofile=DEFAULT;
        [specials]
        {
            [special0] { specialwhat=StartPos1; XPos=37;   ZPos=190; }
            [special1] { specialwhat=StartPos2; XPos=215;  ZPos=38;  }
            …
        }
    }
}
```

| Field | TA equivalent | Notes |
|-------|--------------|-------|
| `kingdom=` | none | Side affinity (`aramon` / `taros` / `veruna` / `zhon` / `creon`). Lobby filters by this; **also selects the terrain/minimap palette** the `.tnt`'s baked preview is coloured with. |
| `size=` | none | Human-readable map size for the lobby. |
| `memory=` | none | Suggested RAM. Cosmetic. |
| `hasscenario=` | none | `1` for campaign missions, `0` for skirmish maps. |
| `[Map Data]` | `[Schema N]` | Maps that the schema sub-section to a single block (TA:K only ever ships one schema per map). |

Everything else (StartPos1..N, `aiprofile=`, etc.) works identically
to TA — `kbot mount`'s OTA viewer handles both without modification.

---

## `.kmp` — Campaign-mission HPI v2 archives

`.kmp` is a renamed [HPI v2](hpi.md#ta-kingdoms--hpi-v2) archive. Hex
top of `adamantine gate.kmp`:

```
00000000: 48 41 50 49 00 00 02 00 57 32 02 00 77 00 00 00   HAPI....W2..w...
00000010: 15 32 02 00 42 00 00 00 20 00 00 00 00 00 00 00   .2..B... .......
00000020: 53 51 53 48 …                                     SQSH…
```

Exactly the v2 header shape (HAPI marker → 0x00020000 version →
24-byte v2 header → SQSH chunks). `kbot hpi list`, `info`, `extract`
all work directly. Each `.kmp` typically packages:

- The mission's `.tnt` and `.ota`
- A handful of cinematic / briefing GAFs
- **Mission-script COB files** — TA:K reuses the COB format
  (`VersionSignature == 6`) for mission scripts, not a separate
  scripting language. The 3,885 `MISSION_COMMAND` (`0x10073000`)
  opcode sites across the retail TAK install live here. See
  [TA: Kingdoms — COB v6 deltas](cob.md#ta-kingdoms--cob-v6-deltas)
  and [Appendix C](cob.md#appendix-c--ta-kingdoms-opcodes) in cob.md
  for the wire format and the per-COB sound-name string pool that
  mission commands index into.
- Sometimes per-mission unit overrides

---

## `.crt` — Small binary, purpose unclear

Every `.crt` in the install is between 56 and 256 bytes. Header bytes
of `abnar's terrace.crt`:

```
00000000: 00 00 80 3f 00 00 00 00 00 00 00 00 09 00 00 00
```

The leading `00 00 80 3f` is the IEEE-754 little-endian encoding of
`1.0f`, suggesting a transform matrix or camera position. The third
uint32 is `9`, which doesn't match anything obvious. Without a clear
hypothesis we just preserve the file verbatim when packing mods.

If you have a working `.crt` reverse-engineering — particularly
something tying it to camera angles, fog parameters, or scenario hints
— please open an issue.

---

## `.txt` — Free-text description

One-line ASCII string, used in the lobby. e.g.
`abnar's terrace.txt`: `9 x 7  4 Player  32MB` (same string the
`.ota`'s `missiondescription` carries). Authoring tools probably wrote
both during export; the game appears to display the `.ota` value.

---

## Working with TA:K maps today

Practical options, in increasing order of effort:

1. **Inspect freely** — `kbot hpi list/info/extract` against `.kmp`
   files works out of the box. `.ota` and `.txt` are plain text.
2. **Describe a map** — `kbot tnt describe <map.tnt>` reports the TA:K
   header, kingdom, heightmap/terrain dimensions and a feature breakdown.
3. **Render a minimap** — `kbot tnt minimap <map.tnt> -t mini.png`
   exports the embedded 126 × 126 preview in true colour, auto-selecting
   the kingdom palette from the sibling `.ota` (override with
   `--kingdom`; see the palette note above).
4. **Render the full textured map** — `kbot tnt preview <map.tnt> --vfs
   <flattened-tak-root> -t map.png` texture-maps the terrain from the
   install's `terrain/*.jpg` and composites every feature's GAF sprite,
   producing the map as the game renders it (athri cay → 7680 × 7680).
   The feature sprite palette is read from
   `palettes/<kingdom>_features.pcx`.
5. **Render the heightmap** — `kbot tnt image <map.tnt> -t height.png`
   needs no external assets; it emits the greyscale DataUnit heightmap
   (`--features` overlays category-coloured placement markers).
6. **Repack a campaign archive** — `kbot hpi pack` produces v1 only
   today, so a re-packed `.kmp` would fail to load. Hand-edit a
   `.kmp` by extracting it, modifying loose files, and using a v2-aware
   third-party packer until kbot ships v2 writing.

> [!WARNING]
> **TA: Kingdoms requires `-disablecavedogverification`** to load most
> modified files, including modified maps. Without it the engine
> rejects anything whose hash isn't on its allowlist. Document this in
> any mod's install instructions.

---

## What kbot can and cannot do for TA:K maps right now

| Operation | Status |
|-----------|--------|
| Read `.kmp` (HPI v2) headers + file list | ✅ |
| Extract files from `.kmp` | ✅ |
| Parse `.ota` (TDF format) | ✅ |
| Read TA:K `.tnt` header (`kbot tnt describe`) | ✅ |
| Export TA:K `.tnt` minimap (`kbot tnt minimap`) | ✅ (true colour — per-kingdom palette from `.ota`) |
| Render full textured TA:K map (`kbot tnt preview --vfs`) | ✅ (texture-mapped terrain + feature GAF sprites) |
| Render TA:K heightmap (`kbot tnt image`) | ✅ (self-contained greyscale; `--features` overlays markers) |
| Write a TA:K `.tnt` (`kbot tnt pack`) | ❌ |
| Write `.kmp` (HPI v2 pack) | ❌ |

Pull requests welcome on any of the ❌ items. With the heightmap,
texture-mapping grid, feature grid and feature table all decoded, the
terrain and features render at full resolution; the remaining gaps are
the writer path for round-tripping edited TA:K maps and v2 `.kmp`
packing.

---

## See also

- [HPI](hpi.md) — the v2 archive container (`.kmp` is an HPI v2 with a renamed extension).
- [TNT](tnt.md) — the TA TNT format; TA:K reuses the structure with a `0x4000` IDVersion.
- [TDF](tdf.md) — the format `.ota` parses as.
- [GAF](gaf.md) — `.taf` animation files used throughout TA:K (cinematics in `.kmp` archives).
- [TA: Kingdoms GUI](takgui.md) — the menu/HUD widget format.
- [Glossary](glossary.md) — *side*, *heightmap*.
