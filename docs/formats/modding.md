# Modding a Unit, End-to-End

> This walkthrough takes you from a stock Total Annihilation install to
> a tiny mod that adds **one new variant of the Arm Flash tank** — a
> double-speed reskin. By the end you'll have a shippable `.ufo`
> archive that loads when dropped into the game folder and a working
> mental model of every format kbot supports.
>
> The whole exercise takes ~20 minutes and exercises [HPI](hpi.md),
> [FBI](tdf.md), [COB](cob.md), [3DO](3do.md), [PCX](pcx.md),
> [TDF](tdf.md), and [`sidedata.tdf`](gamedata.md).

> [!IMPORTANT]
> Steps assume a UNIX-like shell. The kbot CLI is identical on
> Windows; substitute `\` for `/` in paths if needed.

---

## 0. Prerequisites

- A complete TA install at `$TA` (GoG, Steam, or original CD).
- kbot installed:
  ```bash
  go install github.com/coreprime/kbot/cmd/kbot@latest
  kbot ctx add "$TA" --alias ta --game totala
  ```
- Disk space for a flattened working copy (~120 MB).

---

## 1. Flatten the install

You'll edit individual files; flatten the archives once so you can
read them with normal tools.

```bash
kbot mount "$TA" flatten --target ./ta-flat
```

Inspect what you got:

```bash
ls ta-flat/                # ai/  anims/  features/ ... weapons/
ls ta-flat/units/ | head   # ARMCOM.FBI, ARMFLASH.FBI, ...
```

The folder layout matches the VFS shape — see [HPI](hpi.md) for how
archives layer at runtime.

---

## 2. Create a mod scratch dir

Modding TA is **additive**: drop a `.ufo` next to the existing
archives, and its files override the base game. Build your mod in a
mirror tree:

```bash
mkdir -p mymod/{units,scripts,objects3d,unitpics,download}
```

> [!NOTE]
> **You only need to ship the files you change.** Don't copy the whole
> game into `mymod/` — that bloats the `.ufo` and risks shadowing
> things you didn't intend to. The `download/` directory is the
> conventional home for the build-menu registration we'll add in step 5.

---

## 3. Pick a unit to fork

We'll base our `MYFLASH` on the existing Arm Flash. Copy four files:

```bash
cp ta-flat/units/armflash.fbi      mymod/units/myflash.fbi
cp ta-flat/scripts/ARMFLASH.cob    mymod/scripts/MYFLASH.cob
cp ta-flat/objects3d/armflash.3do  mymod/objects3d/myflash.3do
cp ta-flat/unitpics/armflash.pcx   mymod/unitpics/myflash.pcx
```

Why these four? Every unit needs:

| File | Purpose | Page |
|------|---------|------|
| `units/X.fbi` | Stats and metadata | [FBI](tdf.md) |
| `scripts/X.cob` | Animation/behaviour bytecode | [COB](cob.md) |
| `objects3d/X.3do` | 3D mesh | [3DO](3do.md) |
| `unitpics/X.pcx` | 96×96 portrait for the build menu | [PCX](pcx.md) |
| `download/X.tdf` | Build-menu registration (added in step 5) | [TDF](tdf.md#menuentry--build-menu-extension) |

The filenames are conventionally the lowercased `Objectname` from the
FBI, with the `.fbi` itself sometimes uppercased. The engine is
case-insensitive throughout.

---

## 4. Rewire the FBI

Open `mymod/units/myflash.fbi`. The two critical fields to change are
`UnitName` (the lookup key) and `Objectname` (the file-base
reference):

```ini
[UNITINFO]
{
    UnitName=MYFLASH;             // ← was ARMFLASH
    Objectname=myflash;           // ← was armflash
    Side=ARM;
    Designation=ARM-MV;
    Name=Super Flash;             // ← display name
    Description=Twice-as-fast Flash variant;
    ...
}
```

Then crank a stat to prove the change works — double the speed:

```ini
    MaxVelocity=4.0;              // was 2.0
    Acceleration=0.30;            // was 0.15
```

See [FBI Appendix](tdf.md#appendix-a--fbi-field-dictionary) for the full
field catalogue. Anything unset is inherited from engine defaults.

> [!WARNING]
> **Every value needs a trailing `;`.** This is the #1 cause of "my
> change didn't apply" — a missing semicolon silently merges the value
> with the next line.

---

## 5. Register the unit with the build menu

A unit that exists but isn't reachable from any builder can't be
constructed. **The right way to add a build slot for a new unit is to
drop a `download/<UNITNAME>.tdf` file in your mod** — Cavedog's own
Core Contingency expansion ships its new units this way, and every
single-unit `.ufo` add-on you'll find (`AFark.ufo`, `AFlea.ufo`,
`CorNecro.ufo`, …) follows the same convention.

Create `mymod/download/MYFLASH.tdf`:

```ini
[MENUENTRY1]
{
    UNITMENU=ARMVP;       // The builder this unit appears under
    MENU=3;               // Build-menu page number (1-indexed)
    BUTTON=4;             // Slot within that page (0–5 in a 2×3 grid;
                          // 4 = bottom-left)
    UNITNAME=MYFLASH;     // The unit being placed (matches your FBI's UnitName)
}
```

TA's build menu is a **2-column × 3-row grid** per page, so `BUTTON`
takes values `0`–`5` mapped as:

```
┌─────┬─────┐
│  0  │  1  │   page N, top row
├─────┼─────┤
│  2  │  3  │   page N, middle row
├─────┼─────┤
│  4  │  5  │   page N, bottom row
└─────┴─────┘
```

Pick an empty slot in the target builder's existing layout — see the
[TA build tree reference](https://github.com/coreprime/reference-ta/blob/main/ta-buildtree.md)
for the full per-page layout of every base-game constructor.

The engine reads every `download/*.tdf` at boot, parses each
`[MENUENTRY<N>]`, and **merges** the entries into the build menus that
`sidedata.tdf` declared. No `sidedata.tdf` editing required.

### Why this is better than editing `sidedata.tdf`

| Approach | Pros | Cons |
|----------|------|------|
| Edit `sidedata.tdf` | Single source of truth | Overrides the entire (~50 KB) file; conflicts with any other mod that touches it; loses your additions next time the base game is patched |
| `download/*.tdf` | Additive, ~150 bytes, no conflicts with other mods, mod-friendly | One file per added unit (which is the natural unit-of-modding anyway) |

This is Cavedog's blessed extensibility hook — it exists precisely so
that single-unit add-ons don't have to fork `sidedata.tdf`.

### Building from multiple constructors

To make the unit buildable from several constructors, just add more
`[MENUENTRY<N>]` sections. Cavedog's own `download/Armfort.tdf` (Arm
Fortification Wall, shipped in `ccdata.ccx`) does exactly this:

```ini
[MENUENTRY1] { UNITMENU=ARMACK; MENU=3; BUTTON=4; UNITNAME=ARMFORT; }
[MENUENTRY2] { UNITMENU=ARMACV; MENU=3; BUTTON=4; UNITNAME=ARMFORT; }
[MENUENTRY3] { UNITMENU=ARMACA; MENU=3; BUTTON=4; UNITNAME=ARMFORT; }
```

— making ARMFORT buildable from the Advanced Construction Kbot,
Vehicle, and Aircraft. One entry per builder.

### Picking `MENU` and `BUTTON` values

Stock TA reserves the first two menu pages (`MENU=1`, `MENU=2`) for
base-game units. The community convention is to place downloadable
units on `MENU=3` (or higher) so they don't collide with anything
Cavedog ships. `BUTTON` is the slot within that page.

When in doubt, **copy the values from an existing `download/*.tdf`
that adds to the same builder**. Extract Cavedog's `Armfort.tdf`,
`Armmark.tdf`, `Cormort.tdf`, etc. for working references:

```bash
kbot hpi extract /path/to/ccdata.ccx "*.tdf" -t /tmp/cc-downloads
ls /tmp/cc-downloads/download/
```

> [!NOTE]
> **Two mods with the same `(UNITMENU, MENU, BUTTON)` triple collide
> in unpredictable ways** — whichever loads later wins the slot. Pick a
> high page number (`MENU=4` or `5`) when shipping a mod meant to
> coexist with others.

See [TDF: `[MENUENTRY]`](tdf.md#menuentry--build-menu-extension) for
the field reference.

---

## 6. Recompile the COB (optional)

`MYFLASH.cob` is a copy of `ARMFLASH.cob` — it will work as-is. If you
want to tweak the animation, decompile, edit, and recompile:

```bash
# Decompile to readable BOS
kbot cob decompile mymod/scripts/MYFLASH.cob -t mymod/scripts/MYFLASH.bos

# Edit MYFLASH.bos in any text editor
# (See cob.md for the BOS language reference.)

# Compile back to bytecode
kbot cob compile  mymod/scripts/MYFLASH.bos -t mymod/scripts/MYFLASH.cob

# Lint for common issues
kbot cob lint     mymod/scripts/MYFLASH.cob
```

The decompile→compile round-trip is byte-identical for every retail
Cavedog script — `kbot cob roundtrip` validates this across the whole
game catalogue.

---

## 7. (Optional) Re-skin the portrait

`unitpics/myflash.pcx` is a 96×96 paletted PCX. Edit it in any image
editor that handles 8-bit PCX (GIMP, Aseprite, Krita), preserving the
TA palette. To check the palette survived:

```bash
kbot pcx describe mymod/unitpics/myflash.pcx
# Expected: BitsPerPixel: 8, embedded palette present
```

If the palette got mangled, re-import the canonical TA palette
(`palettes/palette.pal`) before saving. See [PCX](pcx.md) for the
gotchas around `0x0C` markers and `BytesPerLine` padding.

---

## 8. (Optional) Re-skin the 3D model

`objects3d/myflash.3do` is a hierarchical mesh — vertices, primitives,
texture references. The Cavedog editor (3DO Builder) is still the most
practical 3DO editor, despite its age. kbot does not edit `.3do`
directly; the web UI renders them for inspection only:

```bash
kbot mount $(kbot ctx path) --server
# → browse to objects3d/myflash.3do for the piece tree and textures
```

See [3DO](3do.md) for the on-disk structure if you're building tooling.

---

## 9. Pack into a `.ufo`

```bash
kbot hpi pack ./mymod --target myflash.ufo
```

By default kbot uses ZLib chunked compression with the standard Cavedog
header key and the canonical trailer — i.e. the engine accepts it
without complaint. Confirm:

```bash
kbot hpi info  myflash.ufo
# Should show ~5–8 files, marker 0x49504148 (HAPI), decrypt key 0xBF.

kbot hpi list  myflash.ufo -v
# units/myflash.fbi, scripts/MYFLASH.cob, objects3d/myflash.3do, ...
```

---

## 10. Install and test

Drop the `.ufo` into the TA install root, alongside `totala1.hpi`:

```bash
cp myflash.ufo "$TA/"
```

Launch TA. Start a skirmish, build an Arm Vehicle Plant, and your
Super Flash should appear in the build menu — twice as fast as a
regular Flash.

> [!TIP]
> **Iterating quickly.** Instead of re-packing after every change, you
> can drop `mymod/` directly into a flattened install (where files take
> precedence over archive contents). Re-pack only when you're ready to
> ship.

---

## Troubleshooting

| Symptom | Likely cause |
|---------|--------------|
| Unit doesn't appear in the build menu. | Missing `download/<UNITNAME>.tdf`, wrong `UNITMENU=` (builder name typo), or `(MENU, BUTTON)` slot is already occupied by another unit. |
| Build menu shows the unit but clicking does nothing. | `UNITNAME=` in the download TDF doesn't match the FBI's `UnitName=`. Or, the unit's `Bmcode=` in the FBI is `0` (which means "not buildable"). |
| Game crashes on load. | Bad FBI value (missing `;`, malformed `[SECTION]`). Run `kbot mount mymod --server` and inspect the FBI under the web UI's TDF viewer — it'll highlight parse errors. |
| Unit appears as a magenta blob. | `Objectname` in the FBI points at a `.3do` filename that doesn't exist. Check `objects3d/<Objectname>.3do`. |
| Unit doesn't move. | `MovementClass` references a class not in `moveinfo.tdf`. Either add the class or use an existing one. |
| Unit moves but the mesh doesn't animate. | The COB script references a piece name not in the 3DO. Compare `kbot cob decompile myflash.cob | grep piece` against the 3DO's piece tree in the web UI. |
| Unit is the right speed but the wrong portrait. | `unitpics/<Objectname>.pcx` not present, or the engine is still seeing the stock `armflash.pcx` (mod loaded after the base archive?). |
| Build menu shows a blank icon. | PCX wasn't saved as 8-bit paletted. Run `kbot pcx describe` to confirm. |

---

## Where to go next

- **Add a new weapon** — copy a `.tdf` from `weapons/`, edit, reference
  it from your FBI's `Weapon1=`. See the [weapons.tdf reference](gamedata.md#weaponstdf--weapon-tdf-reference).
- **Add a new movement class** — append to `moveinfo.tdf`. See
  [Gamedata](gamedata.md#moveinfotdf--movement-classes).
- **Make a custom map** — assemble a `.tnt` from `.sct` sections (or
  hand-author the TNT directly with `kbot tnt pack`). See [TNT](tnt.md).
- **Add new sounds** — drop WAVs in `sounds/`, wire them in
  `gamedata/sound.tdf`. See [Sound](sound.md).
- **Tune the AI** — add `Weight`/`Limit` rules in `ai/default.txt` for
  your new unit. See [AI](ai.md).
- **Inspect an existing mod** — `kbot hpi list` plus `kbot hpi extract`
  works on third-party `.ufo`s too. Studying how others built their
  archives is the fastest way to internalise modding conventions.

---

## See also

- [HPI](hpi.md) — archive packing details.
- [FBI / TDF](tdf.md) — unit definition language with full field
  dictionary.
- [COB / BOS](cob.md) — scripting language.
- [3DO](3do.md) — mesh format.
- [Gamedata](gamedata.md) — `sidedata.tdf`, `moveinfo.tdf`,
  `weapons.tdf` references.
- [Glossary](glossary.md) — terminology reference.
