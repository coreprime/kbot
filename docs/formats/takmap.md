# TA: Kingdoms Maps — `.tnt` + `.ota` + `.crt` + `.kmp`

> *TA: Kingdoms* maps are **a TNT variant** (different IDVersion word)
> wrapped with one or two metadata files, plus an HPI v2 campaign-
> archive format for single-player missions. This is significantly
> closer to TA's map model than the older "BTM/heightmap-BMP" research
> notes suggested — looking at an actual GoG TA:K install, no `.btm`
> or sidecar BMPs are present at all.
>
> kbot's existing [HPI v2](hpi.md#ta-kingdoms--hpi-v2) reader handles
> `.kmp` archives transparently; the TNT-shaped maps load partially
> but the TA:K-specific tile encoding has not been fully
> reverse-engineered. This page documents what's verifiable from the
> shipped install plus the gaps.

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
`0x00002000`. Otherwise the header layout looks very similar to TA's
([see TNT](tnt.md#header-64-bytes)):

| Offset | Bytes | Field | Value |
|-------:|:------|:------|:------|
| `0x00` | `00 40 00 00` | `IDVersion` | `0x4000` — TA:K marker (TA writes `0x2000`) |
| `0x04` | `20 01 00 00` | `Width`  (cells) | `0x120` = 288 |
| `0x08` | `e0 00 00 00` | `Height` (cells) | `0xE0` = 224 |
| `0x0C` | `3a 00 00 00` | `PtrMapData` | `0x3A` (right after the 64-byte header — surprisingly tight) |
| `0x10` | `34 00 00 00` | … | … |

The post-header sections appear in the same order as TA's (tile-index
grid → attribute grid → tile graphics → feature names → minimap), but
the **per-cell attribute size and the tile-graphics encoding differ**
in ways we have not fully mapped. `kbot tnt describe` will report the
header values but cannot yet render TA:K tiles into a finished image.

> [!NOTE]
> **What partially works on TA:K TNTs today.** Reading the header,
> tile-index grid, and minimap region works. Rendering the tile mosaic
> requires the TA:K-specific paletted tile decoder, which is unwritten;
> `kbot tnt image` produces a corrupted result against a TA:K TNT.

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
| `kingdom=` | none | Side affinity (`aramon` / `taros` / `veruna` / `zhon`). Lobby filters by this. |
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
2. **Render a minimap** — `kbot tnt minimap <map.tnt> -t mini.png`
   produces the embedded minimap correctly for TA:K TNTs (the minimap
   block sits at the same offset as in TA TNTs).
3. **Don't trust `kbot tnt image` on TA:K** — the full-tile render
   produces garbled output because the tile decoder assumes TA's
   palette layout. Producing a correct preview is a known gap.
4. **Repack a campaign archive** — `kbot hpi pack` produces v1 only
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
| Read TA:K `.tnt` header + minimap | ✅ |
| Render TA:K `.tnt` as a tile mosaic | ❌ (palette/tile decoder is TA-specific) |
| Heightmap of a TA:K `.tnt` | ⚠️ partial — height byte location may differ |
| Write a TA:K `.tnt` (`kbot tnt pack`) | ❌ |
| Write `.kmp` (HPI v2 pack) | ❌ |

Pull requests welcome on any of the ❌ items. The TA:K tile format is
the highest-leverage gap — once decoded, full TA:K map preview drops
out of the existing TNT renderer pipeline with minimal changes.

---

## See also

- [HPI](hpi.md) — the v2 archive container (`.kmp` is an HPI v2 with a renamed extension).
- [TNT](tnt.md) — the TA TNT format; TA:K reuses the structure with a `0x4000` IDVersion.
- [TDF](tdf.md) — the format `.ota` parses as.
- [GAF](gaf.md) — `.taf` animation files used throughout TA:K (cinematics in `.kmp` archives).
- [TA: Kingdoms GUI](takgui.md) — the menu/HUD widget format.
- [Glossary](glossary.md) — *side*, *heightmap*.
