# Common Modding & Parsing Pitfalls

A single-page cheat-sheet of the most-bitten gotchas spread across
the kbot format docs. If you're hitting a bug that makes no sense,
start here. Each item links to the deeper explanation on the
relevant format page.

> [!TIP]
> **Looking for "my mod doesn't load"?** The TDF semicolon rule
> ([#tdf--fbi--ota](#tdf--fbi--ota), first item) accounts for more
> "silent breakage" reports than every other gotcha combined.

---

## HPI / UFO / CCX / GP3

- **Loose files in the install root override every archive.** Drop
  `units/MYUNIT.fbi` on disk and the engine prefers it over anything
  in `totala1.hpi`. The
  [layering diagram in hpi.md](hpi.md#load-order-layering) shows the
  full priority stack.
- **HPI v1 pointers are absolute to file start, not to the directory
  start.** Subtract nothing. The canonical-parser trick is to allocate
  a `DirectorySize`-byte buffer and decrypt the directory into it at
  offset `Start` so pointers index the buffer directly. See
  [Directory tree](hpi.md#directory-tree).
- **HPI v1 cipher seed advances with file position.** You can't decrypt
  a buffer in isolation — you have to know which absolute file offset
  the buffer came from. See
  [Deriving the cipher key](hpi.md#deriving-the-cipher-key).
- **If `DecryptKey == 0`, don't apply the XOR cipher at all.** Some
  custom archives ship plaintext; running the cipher anyway scrambles
  what's already readable.
- **SQSH chunk checksum is computed over the *encrypted* bytes.**
  Verify before unscrambling. See
  [Compressed chunks (SQSH)](hpi.md#compressed-chunks-sqsh).
- **TA: Kingdoms uses HPI v2** (`Version == 0x00020000`) with a
  different layout — no XOR, single SQSH chunk per file. See the
  [TA: Kingdoms HPI v2](hpi.md#ta-kingdoms--hpi-v2) section before
  trying the v1 parser on a TAK archive.
- **`BANK`-marker save games are a different beast** — they reuse the
  HPI envelope but the contents are serialised game state, not a
  filesystem. kbot does not decode them.
- **`.gp3` requires the rev3.1 patch.** It's still HPI inside, but
  unpatched TA refuses to mount it.

## TDF / FBI / OTA

- **Every value must end with `;`.** Missing semicolons silently merge
  values across lines and produce wildly wrong stats. This is the #1
  cause of "my unit has weird HP / missing description / wrong cost".
- **Keys are case-insensitive, values are not.** `Side=arm` works for
  most lookups but breaks any mod code doing string-equality on
  `Side`.
- **List values are space-separated** (`Category=COMMANDER MOBILE
  WEAPON`) — not comma-separated. The exception is OTA's
  `numplayers=2,4,6,8,10` which uses commas.
- **Booleans are integer `1`/`0`**, not `true`/`false`. The engine
  accepts only the integer forms.
- **For mods, never edit `sidedata.tdf` to add units.** Use a
  `download/<UNITNAME>.tdf` `[MENUENTRY]` registration instead — the
  same mechanism Core Contingency uses. See
  [TDF: `[MENUENTRY]`](tdf.md#menuentry--build-menu-extension) and
  the [modding tutorial](modding.md).
- **`Bmcode=0` hides a unit from the build menu** even if everything
  else is valid. Almost always you want `Bmcode=1`.
- **A unit not listed under any constructor cannot be built**, even if
  its FBI is otherwise valid. The most common "my new unit exists but
  isn't buildable" bug. See
  [modding step 5](modding.md#5-register-the-unit-with-the-build-menu).
- **Nested-section depth is convention, not spec.** Some tooling
  assumes 2-deep; weapon TDFs go 3 deep (`[WEAPON][DAMAGE][category]`).

## TNT / SCT — map terrain

- **TNT `Width` and `Height` are 16-px attribute cells**, not tiles
  and not pixels. Divide by 2 for tile counts; multiply by 16 for
  pixel dimensions. See [TNT header](tnt.md#header-64-bytes).
- **`SeaLevel == 0` does NOT mean "no water"** — it means the
  smallest possible value is on the threshold, so nothing is
  underwater. Use `SeaLevel = 1` for genuinely-dry maps.
- **Two undocumented TNT feature sentinels exist in retail content:**
  `0xFFFE` (Lava Run, AC02) and `0xFFFD`. Treat anything > max
  features but < `0xFFFC` as "no feature" defensively.
- **TNT minimap padding uses palette index `0xDD`** (TA's canonical
  transparent blue). Strip it cosmetically; engine ignores it.
- **TA: Kingdoms `.tnt` uses `IDVersion == 0x4000`** instead of TA's
  `0x2000`. `kbot tnt image` produces garbage against TAK TNTs; the
  tile decoder is TA-specific. See [TA:K maps](takmap.md).
- **SCT sections must be a multiple of 4 in both dimensions** to load
  in TAE. The on-disk format permits other sizes but the editor
  rejects them with "section misaligned".
- **SCT V2 has 8-byte height cells**, V3 has 4-byte. kbot accepts
  both; mods built against the editor see only V3.

## 3DO — models

- **Y is up, not Z.** Importing a 3DO into a Z-up engine (Blender,
  modern Unreal) without swapping axes leaves every unit lying
  sideways.
- **Untextured primitives are invisible unless `IsColored != 0`** —
  the pseudocode `visible = (texture != "") || (IsColored != 0)`
  catches both cases. Most common 3DO rendering bug.
- **`OffsetToSelectionPrim` is only meaningful on the root object;**
  child objects must set it to `-1` (`0xFFFFFFFF`).
- **Fixed-point scale is `1 / 65536`.** A vertex written `0x00010000`
  = 1.0 world units; the low 16 bits are the fractional part.
- **Vertices are local to the object**, not global. Two objects can
  have identical vertex arrays — that's mirrored geometry, not shared
  data.

## COB / BOS — scripts

- **`call-script` opcode is `0x10062000`, NOT `0x10063000`** as some
  pre-3.1 docs claim. Old decompilers using `0x10063000` produce
  nonsense — see [the opcode reference](cob.md#appendix-a--full-opcode-reference).
- **Piece numbers in opcodes are indices into the piece name table**,
  not strings. The COB carries names as a string pool; the runtime
  uses indices for speed.
- **`SET_SIGNAL_MASK` only registers interest — it doesn't kill
  anything.** Sending `signal X` is what stops scripts whose mask has
  `X` set. The `signal-never-signalled` lint rule catches scripts
  that set a mask nobody ever signals.
- **Cavedog's Scriptor inlines `CURRENT_SPEED` as the literal `29`,**
  breaking `MoveWatcher`-style scripts after a round-trip. kbot's
  decompiler restores the symbolic name; if you must round-trip
  through Scriptor, parenthesise: `(get CURRENT_SPEED) > 5`.
- **Jump offsets are byte offsets relative to `OffsetToScriptCode`,**
  not relative to the current instruction. `JUMP 0x4C` means "jump
  to `OffsetToScriptCode + 0x4C`".
- **`GET_UNIT_VALUE` port numbers vary between TA and TA:K.** TA's
  catalogue (kbot decompiler labels ports 1–20) is documented in
  [Appendix B](cob.md#appendix-b--get_unit_value-port-table).

## GAF — sprite animations

- **Some sequences ship with frame durations of `0`** — intentional;
  the engine treats them as event-driven. Don't "fix" them to a
  default.
- **Compressed pixel rows can be shorter than `Width`.** The trailing
  pixels are implicitly transparent. Old GafBuilder Pro versions
  silently drop these rows entirely on resave; if a GAF lost frames
  after editing, that bug is the cause — use kbot's pipeline instead.
- **Sub-frame origins are absolute** (relative to the parent frame's
  origin), not deltas.
- **`anims/terrain.gaf` and `anims/vismasks.gaf` have `Version == 0`**
  in their headers. Accept zero as a valid synonym for `0x00010100`.
- **TA: Kingdoms `.taf` IS a GAF** — same on-disk format. Only
  difference: TAK pulls the palette from a per-side `.pcx` rather
  than the global TA palette.

## PCX — images

- **`BytesPerLine` is the encoded length, not the image width.** If
  `BytesPerLine > Width`, trailing bytes per row are padding — drop
  them. Mishandling produces a horizontally stretched image.
- **Literal bytes with the top two bits set must be RLE-escaped.** A
  bare byte of value `0xC0–0xFF` is illegal as a literal; emit it as
  a 1-count run (`0xC1, 0xFF` for a single `0xFF`). Mishandling
  desynchronises decode after one row.
- **Always check the `0x0C` marker before trusting the trailing 768
  bytes.** Files without it use the (almost useless) 16-colour
  header palette.

## PAL / ALP / LHT / SHD — palettes & lookup tables

- **The 4th byte per entry is NOT alpha.** It's an unused padding
  byte Cavedog always set to `0x00`. Open-source palette tools that
  treat it as alpha refuse to render the palette (alpha=0 → all
  transparent).
- **Index 0 is transparent everywhere.** Even though `palette.pal`
  contains plenty of other blacks, only index 0 is treated as
  alpha=0 by the renderer.
- **`.alp` / `.lht` / `.shd` are NOT RGB palettes** — they're 256×4
  lookup tables of palette indices. Rendering them with `kbot pal
  describe` shows garbage; use `kbot pal lookup` instead.
- **The TA palette has 13 duplicate RGB triplets.** If your editor
  deduplicates on import (some do), you lose entries and the palette
  silently becomes 243-entry.

## FNT — bitmap fonts

- **`Offsets[c] == 0` means "no glyph", not "glyph at offset 0".**
  Offset 0 lands in the middle of the header — Cavedog reuses zero
  as the sentinel.
- **Bit order is MSB-first** within each byte. LSB-first is more
  common in modern bitmap fonts; don't assume.
- **Bit stream is continuous between rows** — no padding at end of
  each scan line.

## AI profiles

- **TA: Kingdoms AI files have no `plan` directives** — just bare
  `weight`/`limit` lines. kbot's parser opens an implicit `default`
  plan; readers should tolerate the missing block. See
  [TA:K — plan-less profiles](ai.md#ta-kingdoms--plan-less-profiles).
- **No validation anywhere.** Misspelled unit names, broken weight
  values, lines outside `plan` — all silently ignored. First sign of
  a broken profile is "the AI behaves strangely", with no log
  message.
- **Category aliases (`PLANT`, `LEVEL3`) only "exist" if at least one
  unit declares them in `Category=`.** Misspell `LEVL3` and the
  directive silently does nothing.

## Sounds

- **A missing WAV is silent, not an error.** Misspell `select1=cmsdel1`
  (transposed letters) and the engine plays nothing — no log, no
  fallback.
- **The `.wav` extension is implied in TDF values** — never write it.
  `select1=cmdsel1.wav` becomes `sounds/cmdsel1.wav.wav` and finds
  nothing.

## TA: Kingdoms specifics

- **TAK requires `-disablecavedogverification`** as a command-line
  argument to load most modded files. Without it the engine rejects
  anything whose hash isn't on its allowlist.
- **TAK has 8 side codes in the data**, not 4: ARA / TAR / VER / ZON
  for the four playable sides, plus CRE (Creon, Iron Plague), MON
  (monsters), LIF (wildlife), NPC (campaign characters). Unit-list
  filtering needs to handle all of them.
- **TAK weapons live inline in each FBI** as `[WEAPON1]`–`[WEAPON3]`
  sub-sections, not in a separate `weapons/*.tdf` directory.
- **TAK build menus are linear**, not 2×3. Each builder has a
  directory `canbuild/<builder>/<unit>.tdf` with a single
  `[Menu] { Priority = N; }` block.

---

## See also

- [Modding tutorial](modding.md) — end-to-end TA unit-mod walkthrough.
- [Glossary](glossary.md) — definitions of every cross-format term
  referenced above.
- [Quickstart](quickstart.md) — five kbot commands to try first.
