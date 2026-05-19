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
| `FootprintX`, `FootprintZ` | int | Pathing footprint, in 16-px attribute cells. Must match the unit's FBI footprint. |
| `MaxWaterDepth` | int | Deepest water (in terrain-height units) the unit can enter. `0` = strictly land. |
| `MinWaterDepth` | int | Minimum water depth required (boats, submarines). Mutually exclusive with `MaxWaterDepth`. |
| `MaxSlope` | int | Steepest slope the unit can climb on land (units = `2π / 256` radians). |
| `BadSlope` | int | Slope at which the unit moves at reduced speed (slower but not blocked). Defaults to `MaxSlope`. |
| `MaxWaterSlope` | int | Same as `MaxSlope`, applied when underwater. `255` = no limit (used for hovercraft). |
| `BadWaterSlope` | int | Underwater equivalent of `BadSlope`. |

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
Cavedog's published reference for the weapon-TDF grammar. The actual
weapon definitions live in `weapons/*.tdf`, one section per weapon
(see [TDF](tdf.md)).

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

Keys in `[DAMAGE]` correspond to **`UnitName`s** (specific units) or
**category aliases** (any token from a unit's `Category=`). The engine
picks the most specific match.

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
  `[ARM_KBOT]` sections). Referenced by FBI `SoundCategory=`.
- **`allsound.tdf`** — global UI sound bindings (`[BIGBUTTON]`,
  `[SKIRMISH]`, `[BGM]`).

---

## Worked example — adding a movement class

To create a "boat that can ford very shallow water" class:

1. Append to `gamedata/moveinfo.tdf`:

   ```ini
   [CLASS99]
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
   FootprintX=3;
   FootprintZ=3;
   ```

3. Pack:

   ```bash
   kbot hpi pack ./mymod --target mymod.ufo
   ```

The unit will now traverse both land and water seamlessly.

> [!NOTE]
> **`[CLASS<N>]` section numbers don't have to be sequential or unique
> across mods.** The engine reads `Name=` and ignores the bracketed
> number — but mods commonly use high numbers (`CLASS100+`) to avoid
> colliding with stock classes.

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

- **Section numbering is not checked.** Numbers in `[CLASS5]` /
  `[CLASS99]` are labels; only `Name=` matters. Sequential numbering
  is a convention, not a requirement.
- **Comments use `//`, not `/*…*/`** in most files — but
  `weapons.tdf` uses both. Test parsers tolerate both; some
  third-party tools don't.
- **`sidedata.tdf` HUD coords are at 640×480 base** and scale up by
  the engine for higher resolutions. Don't write coordinates in
  modern resolutions.
- **`[CANBUILD]` slot numbers** beyond 12 add extra pages; the engine
  doesn't error if you go to 11 then 14 with a gap. The gap shows as
  a blank slot.
- **Each `MovementClass` must be declared in `moveinfo.tdf` before any
  FBI references it.** Loading an FBI with an undefined class
  silently makes the unit stationary.

---

## See also

- [TDF](tdf.md) — the parser-level grammar shared with FBI/OTA.
- [Sound](sound.md) — `sound.tdf` and `allsound.tdf` wiring.
- [FBI](tdf.md#fbi--unit-definitions) — units reference `MovementClass`,
  `SoundCategory`, weapon-TDF names.
- [Glossary](glossary.md) — *movement class*, *footprint*, *side*.
