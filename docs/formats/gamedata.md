# Gamedata TDFs — Engine Configuration Tables

> The files in `gamedata/` are [TDF](tdf.md) text files that configure
> the engine itself: movement classes, weapon damage categories, side
> data (UI layout, build menus, starting units), sound bindings, and
> a handful of small lookup tables. Mods that change the *rules of the
> game* (vs. adding units) almost always live here.

This page documents the most useful gamedata files. They all use the
INI-shaped TDF grammar — see [TDF](tdf.md) for parser-level details.

> [!TIP]
> **Try it yourself.**
> ```bash
> ls $(kbot ctx path)/gamedata/
> # The web UI renders these as collapsible section trees
> kbot mount $(kbot ctx path) --server
> # → browse to gamedata/sidedata.tdf, then sidedata > [CANBUILD]
> ```

---

## Files at a glance

| File | What it controls |
|------|------------------|
| `sidedata.tdf` | Per-side UI layout, starting commander, build menus. The biggest file in `gamedata/`. |
| `moveinfo.tdf` | Movement classes — what terrain each "MovementClass" can traverse. |
| `weapons.tdf` | Reference doc on the weapon-TDF grammar (mostly comments — not a runtime table). |
| `category.tdf` | Human-readable descriptions for unit categories. Cosmetic only. |
| `sound.tdf` | Per-unit sound categories (referenced by FBI `SoundCategory=`). |
| `allsound.tdf` | UI / game-event sounds (button clicks, score-bar pings, BGM). |
| `los.tdf` | Line-of-sight tuning (sight radius modifiers per terrain). |
| `meteor.tdf` | Asteroid-storm parameters (used by some campaign maps). |
| `unitview.tdf` | Layout of the in-game unit info panel. |
| `buildinfo.tdf` | Build-menu hot-keys and tooltip text. |
| `version.tdf` | Game version string the lobby reports. |
| `translate.tdf` | Localisation lookup table for UI strings. |
| `help.tdf` | In-game help-system entries. |

The big three for modding are **`sidedata.tdf`** (build menus, sides),
**`moveinfo.tdf`** (movement classes), and **`weapons.tdf`** (which is
documentation, not data — actual weapons live in `weapons/*.tdf`).

---

## `moveinfo.tdf` — Movement Classes

A unit's [FBI](tdf.md) declares its `MovementClass=KBOTSS2` (or similar);
the engine looks up that class in `moveinfo.tdf` to decide which
terrain it can traverse.

TA 3.1c reads only the sections `[CLASS0]` to `[CLASS31]` (the first
section of each of those names) and finds a class by its `Name=`,
ignoring case, lowest slot first. When the unit's class resolves, the
class's values **replace** the unit's own `FootprintX`/`FootprintZ`,
`MaxWaterDepth`, `MinWaterDepth` and slope keys entirely — the commander's
`MaxSlope=20` gives way to `TANKDS2`'s 32 — and a key the class leaves out
takes the game's default below, not the FBI's value. A unit with no
class, or naming one the game cannot find, reads its own FBI keys with
the same defaults. KBot Studio's unit meta, sandbox and hosted matches
resolve movement this way.

```ini
[CLASS0]
{
    Name=KBOTSS2;        // Class name referenced from FBIs
    FootprintX=2;        // Cells wide (16-px units)
    FootprintZ=2;        // Cells deep
    MaxWaterDepth=12;    // Deepest water it can enter
    MaxSlope=32;         // Steepest land slope it can climb
}

[CLASS3]
{
    Name=TANKDH3;
    FootprintX=3;
    FootprintZ=3;
    MaxWaterDepth=100;   // Heavy tank — can ford deep water
    MaxWaterSlope=30;    // Slope limit *underwater* (separate from MaxSlope)
    MaxSlope=15;
}
```

### Fields

| Field | Type | Meaning |
|-------|------|---------|
| `Name` | string | Class identifier referenced from `MovementClass=` in unit FBIs. Case-insensitive. |
| `FootprintX`, `FootprintZ` | int | Pathing footprint, in 16-px attribute cells. Replaces the unit's FBI footprint; `0` when the class leaves it out. |
| `MaxWaterDepth` | int | Deepest water (in terrain-height units) the unit can enter. `0` = strictly land. Default `10000` (any depth) — hovercraft classes leave it out, so a hovercraft rides any water whatever its FBI says. |
| `MinWaterDepth` | int | Minimum water depth required (boats, submarines). Default `-10000` (no minimum). |
| `MaxSlope` | int | Steepest slope the unit can climb on land (units = `2π / 256` radians). Default `255`; capped by `MaxWaterSlope`. |
| `BadSlope` | int | Slope at which the unit moves at reduced speed (slower but not blocked). Defaults to half of `MaxSlope`; capped by `MaxSlope`. |
| `MaxWaterSlope` | int | Same as `MaxSlope`, applied when underwater. Default `255` (no limit, used for hovercraft). |
| `BadWaterSlope` | int | Underwater equivalent of `BadSlope`; defaults to half of `MaxWaterSlope`. |

### Naming conventions

The class name encodes its shape in a short tag — Cavedog's convention:

| Prefix | Meaning |
|--------|---------|
| `KBOT` | Bipedal kbot |
| `TANK` | Tracked/wheeled vehicle |
| `BOAT` | Surface watercraft |
| `SPID` | Spider / many-legged crawler |
| `HOVER` | Hovercraft |

Then a suffix `SS` / `SF` / `DS` / `DH` / `SH` (small/deep/heavy/etc.)
and a footprint digit. **The naming is convention only** — the engine
treats `Name=` as an opaque key.

> [!IMPORTANT]
> **Two units with the same `MovementClass=` share path-finding
> behaviour.** If you change `KBOTSS2` to `MaxWaterDepth=50`, every
> small kbot now wades through water. Add a new class instead if you
> want per-unit tuning.

---

## `sidedata.tdf` — Per-side configuration

This is the longest file in `gamedata/` because it bundles three
distinct concerns:

1. **Side declarations** — name, prefix, commander, fonts, colours.
2. **HUD layout** — pixel coordinates for every status bar, label, and
   button in the in-game UI.
3. **Build menus** — `[CANBUILD]` section listing what each
   constructor can build.

### Side block

```ini
[SIDE0]
{
    name=ARM;
    nameprefix=ARM;
    commander=ARMCOM;          // UnitName of the commander unit
    intgaf=ARMINT;             // GAF used for intro screen

    font=console;              // FNT for general text
    fontgui=armbutt;           // FNT for buttons
    energycolor=208;           // Palette index for energy bars
    metalcolor=224;            // Palette index for metal bars

    // …followed by ~60 HUD coordinate sub-sections
    [LOGO]      { x1=132; y1=5;   x2=152; y2=25; }
    [ENERGYBAR] { x1=471; y1=12;  x2=598; y2=14; }
    [METALBAR]  { x1=218; y1=12;  x2=345; y2=14; }
    ...
}

[SIDE1] { name=CORE; ... }
```

| Field | Meaning |
|-------|---------|
| `name` | Side display name (also used for category matching). |
| `nameprefix` | String prefix added to localisation lookups. |
| `commander` | `UnitName` of the side's commander unit. |
| `intgaf` | GAF sequence shown during faction selection. |
| `font` / `fontgui` | [FNT](fnt.md) files for HUD text and buttons. |
| `energycolor` / `metalcolor` | Palette indices for HUD bars (`palette.pal` indices). |

### HUD coordinate sub-sections

Every visible HUD element is a `[NAME]` block with `x1/y1/x2/y2` pixel
coordinates. These are relative to the 640×480 base resolution; higher
modes scale by the engine.

```ini
[ENERGYBAR] { x1=471; y1=12; x2=598; y2=14; }
```

To reposition the energy bar, edit the four numbers. To re-skin it,
swap the GAF the HUD uses to draw at that position (set in `unitview.tdf`).

### `[CANBUILD]` build menus

The **static** build-menu definition. Each constructor lists what it
can build at game-start:

```ini
[CANBUILD]
{
    [ARMCOM]
    {
        canbuild1=ARMSOLAR;    // Slot 1 on the build menu
        canbuild2=ARMWIN;
        canbuild3=ARMESTOR;
        canbuild4=ARMMSTOR;
        canbuild5=ARMMEX;
        ...
    }
    [ARMLAB]
    {
        canbuild1=ARMCK;
        canbuild2=ARMPW;
        ...
    }
}
```

The slot number is the position on the build menu page. TA's build
menu is a **2-column × 3-row grid**, so each page holds **6** slots:
`canbuild1`–`canbuild6` are page 1, `canbuild7`–`canbuild12` are
page 2, and so on. (Older documentation occasionally claimed 12 slots
per page; the actual in-game grid is 6.) See the
[TA build tree reference](https://github.com/coreprime/reference-ta/blob/main/ta-buildtree.md)
for the per-page layout of every constructor in the base game.

> [!IMPORTANT]
> **For mods, do NOT edit `sidedata.tdf` to add units.** The Cavedog-
> blessed pattern for adding a unit to the build menu is to ship a
> `download/<UNITNAME>.tdf` file alongside the rest of your mod —
> the engine merges every `download/*.tdf` over `sidedata.tdf`'s
> static `[CANBUILD]` table at boot.
>
> Editing `sidedata.tdf` is only appropriate if you're shipping a
> total conversion that rewrites the whole HUD/build-menu layout.
> Even Cavedog's own *Core Contingency* expansion adds its new units
> via `download/*.tdf`, not by modifying `sidedata.tdf`.
>
> See [TDF: `[MENUENTRY]`](tdf.md#menuentry--build-menu-extension)
> and the [modding tutorial](modding.md#5-register-the-unit-with-the-build-menu).

---

## `weapons.tdf` — Weapon TDF reference

Despite the name, `gamedata/weapons.tdf` is **mostly comments** — it's
Cavedog's published reference for the weapon-TDF grammar, and the game
never loads it. The actual weapon definitions live in `weapons/*.tdf`,
one section per weapon (see [TDF](tdf.md)).

### The weapon table

TA 3.1c builds a table of 256 weapon slots from the `.tdf` files
directly in `weapons/` (not its subdirectories), in the order it lists
them:

- A section goes into the slot its `ID=` names, `0`–`255`. A section
  with no `ID`, or one outside that range, is skipped.
- A later section with the same `ID` — in the same file or a later one —
  replaces the earlier one.
- A unit's `Weapon1`/`Weapon2`/`Weapon3`, `ExplodeAs` and
  `SelfDestructAs` name a section; the name (ignoring case) resolves to
  the **lowest** slot holding a section of that name.
- Values read as number prefixes: `weaponacceleration=13O;` is 13, and a
  bad value never drops the rest of the file.
- A missing `range` is `32767`; a missing `minbarrelangle` is `-11.25`
  degrees; `reloadtime` counts in whole ticks (30 a second,
  `reloadtime*30` truncated: `0.35` reloads after 10 ticks, 0.333 s);
  `turnrate` is in angle units per second (65536 = a full circle).

KBot Studio, packs and `kbot host` all resolve weapons through this
table. Sections the game skips or replaces are reported as warnings
(`kbot pack` prints them; the studio serves them at
`/api/studio/weapons/warnings`).

### `rendertype=4` sprites

A `rendertype=4` weapon flies a 2D sprite from `anims/fx.gaf`, and its
`color=` picks which: `0` cannonshell, `1` plasmasm, `2` plasmamd, `3`
ultrashell, `4` plasmasm again; any other value (such as EARTHQUAKE's
`color=255`) draws no sprite. The sprite steps one frame per game tick
from the moment the shot fires, whatever durations the GAF frames carry.

The reference comments document:

- **Three weapon archetypes**: `ballistic`, `lineofsight`, `dropped`.
  Every weapon TDF must set one of these to `1`.
- **Range, velocity, acceleration** — in pixels and pixels/sec.
- **Area-of-effect** — pixel radius, with `edgeeffectiveness` as
  drop-off fraction (e.g. `0.5` = half-damage at the edge).
- **Burst & spray** — `burst`, `burstrate`, `sprayangle`.
- **Two-phase weapons** — `twophase`, `weapontype2`, `flighttime` for
  starburst-style projectiles.
- **Render type** — `rendertype=N` picks 3D model, paletted bitmap,
  beam, etc.

The `[DAMAGE]` sub-section is where the **per-target-category damage
modifiers** live:

```ini
[FLAMETHROWER] {
    ...
    [DAMAGE]
    {
        default=10;     // Damage applied to anything not listed
        corpyro=2;      // Pyros are nearly fire-proof
    }
}
```

Keys in `[DAMAGE]` are **unit names**: a unit listed takes that damage
instead of `default=`, every other unit takes `default=`. Values are kept
to 16 bits. Death blasts (`ExplodeAs`, `SelfDestructAs`) use the same
table — `CORPYRO_BLAST` deals 60 by default but 15 to a Pyro.

---

## `category.tdf` — Unit category descriptions

A cosmetic flat list mapping category tokens to human-readable text.
The engine displays these in the unit info panel:

```ini
[Plant]      { description = Unit Creation plant; }
[KBOT]       { description = Some type of units; }
[Tank]       { description = Some type of units; }
[Metal]      { description = Some type of units; }
```

The dashes-instead-of-descriptions are unintentional Cavedog
boilerplate. Most mods leave this file alone; some replace the
descriptions with proper flavour text. Changing it won't affect
gameplay.

---

## `sound.tdf` and `allsound.tdf`

Covered in [WAV / Sound](sound.md). In summary:

- **`sound.tdf`** — per-unit-category sound bindings (the `[ARM_COM]`,
  `[ARM_KBOT]` sections). Referenced by FBI `SoundCategory=`. The game
  reads 23 events, each as `KEY` then `KEY1`, `KEY2`, … up to the first
  missing number.
- **`allsound.tdf`** — global UI sound bindings (`[BIGBUTTON]`,
  `[SKIRMISH]`, `[BGM]`).

---

## Worked example — adding a movement class

To create a "boat that can ford very shallow water" class:

1. Append to `gamedata/moveinfo.tdf`:

   ```ini
   [CLASS20]
   {
       Name=AMPHIB3;
       FootprintX=3;
       FootprintZ=3;
       MaxWaterDepth=100;    // Deep water OK
       MaxSlope=20;          // Reasonable land climbing
       MaxWaterSlope=200;    // Smooth underwater movement
   }
   ```

2. In your unit's FBI:

   ```ini
   MovementClass=AMPHIB3;
   ```

   The class's footprint and limits replace the FBI's own, so the unit's
   `FootprintX`/`FootprintZ`/`MaxWaterDepth` keys no longer matter.

3. Pack:

   ```bash
   kbot hpi pack ./mymod --target mymod.ufo
   ```

The unit will now traverse both land and water seamlessly.

> [!NOTE]
> **Only `[CLASS0]` to `[CLASS31]` are ever read.** A class in
> `[CLASS32]`, `[CLASS100]` or `[HOVERXL]` is never found, and units naming
> it fall back to their own FBI keys. Pick a free slot below 32 (retail
> uses `CLASS0` to `CLASS14`); a second section with the same slot name
> is ignored.

---

## Typical sizes

| File | Range observed in Cavedog `gamedata/` |
|------|---------------------------------------|
| `sidedata.tdf` | ~50 KB |
| `moveinfo.tdf` | ~3 KB (15–20 classes) |
| `sound.tdf` | ~20 KB (300+ categories) |
| `weapons.tdf` | ~2 KB (mostly comments) |
| `category.tdf` | ~1 KB |
| Other gamedata files | < 5 KB each |

---

## Gotchas

> [!WARNING]
> **Many gamedata files are loaded *once* at engine start**, not
> per-map. To test a change you have to restart the game — reloading
> the lobby is not enough. This catches a lot of modders out who think
> their change "didn't take".

- **Movement-class slots are fixed.** Only `[CLASS0]` to `[CLASS31]`
  are read; numbering gaps inside that range are fine.
- **Comments use `//`, not `/*…*/`** in most files — but
  `weapons.tdf` uses both. Test parsers tolerate both; some
  third-party tools don't.
- **`sidedata.tdf` HUD coords are at 640×480 base** and scale up by
  the engine for higher resolutions. Don't write coordinates in
  modern resolutions.
- **`[CANBUILD]` slot numbers** beyond 12 add extra pages; the engine
  doesn't error if you go to 11 then 14 with a gap. The gap shows as
  a blank slot.
- **A `MovementClass` the game cannot find is not an error.** The unit
  silently uses its own FBI keys, with the game's defaults for missing
  ones — a unit with no `MaxWaterDepth` then wades to depth 10000.

---

## See also

- [TDF](tdf.md) — the parser-level grammar shared with FBI/OTA.
- [Sound](sound.md) — `sound.tdf` and `allsound.tdf` wiring.
- [FBI](tdf.md#fbi--unit-definitions) — units reference `MovementClass`,
  `SoundCategory`, weapon-TDF names.
- [Glossary](glossary.md) — *movement class*, *footprint*, *side*.
