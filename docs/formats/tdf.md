# TDF / FBI / OTA — Text Configuration Files

> **TDF** ("Text Data File"), **FBI** ("Feature/Building/Item"), and
> **OTA** ("Online Total Annihilation") files all share the same
> INI-like text format. They are the canonical way Cavedog declared
> *anything that wasn't binary* — unit stats, weapon parameters, feature
> definitions, mission metadata, sound categories, AI hints.

| Extension | Where you'll find it | Examples |
|-----------|----------------------|----------|
| `.fbi` | `units/` | `ARMCOM.FBI`, `CORRAID.FBI` — unit definitions |
| `.tdf` | `features/`, `weapons/`, `sounds/`, `gamedata/`, etc. | `armflak_weapon.tdf`, `treeb.tdf` |
| `.ota` | `maps/` | `metal heck.ota` — map metadata, start positions, AI brief |

These files are plain ASCII; you can open one in any text editor.

> [!TIP]
> **Try it yourself.**
> ```bash
> # The web UI renders FBI/TDF/OTA as collapsible section trees
> kbot mount ~/games/totala --server
> # → browse to units/ARMCOM.FBI
> ```
> See the CLI [`kbot mount` reference](../../README.md#kbot-mount--asset-explorer)
> for terminal-browser usage and flatten options.
>
> **From Go.** Use [`formats/tdf`](../../formats/tdf/tdf.go):
> ```go
> import "github.com/coreprime/kbot/formats/tdf"
>
> doc, _ := tdf.ParseFile("units/ARMCOM.FBI")
> info := doc.Section("UNITINFO")
> fmt.Println(info.String("UnitName"), info.Int("MaxDamage"))
> ```

---

## Syntax

A TDF file is a tree of **sections**. Each section has a name in square
brackets, then a `{ ... }` body containing **key=value** pairs and/or
nested sections.

```ini
[UNITINFO]
{
    UnitName=ARMCOM;
    Designation=Commander;
    Description=Commander, Arm;
    Side=ARM;
    Objectname=armcom;

    BuildCostEnergy=2500;
    BuildCostMetal=2500;
    MaxDamage=3000;

    [SOUNDS]
    {
        canselect=cmdsel1;
        select1=cmdok1;
    }
}
```

Rules:

- **Section names** are in square brackets; everything that follows
  until the matching `}` belongs to that section.
- **Values end with a semicolon `;`**. Multi-line values are not
  supported.
- **Keys are case-insensitive.** `UnitName`, `unitname` and `UNITNAME`
  all refer to the same field; tools commonly canonicalise to lowercase
  on read.
- **Values are strings** by default. Numeric values are decimal
  integers or floats; lists are comma-separated (e.g.
  `Category=NOTSUB COMMANDER NOTAIR ...`).
- **Comments** start with `//` and run to end-of-line.
- **Whitespace and blank lines are ignored.**

Nested sections (like `[SOUNDS]` inside `[UNITINFO]` above) are common
in FBI/OTA. The TDF spec doesn't fix a maximum depth; in practice you
won't see more than 3.

---

## FBI — unit definitions

An FBI is the **engine's complete view of a unit**. It pulls the unit's
3D model, the script, the weapon list, the sound bank, build costs, and
combat behaviour together in one place. A trimmed Arm Commander example:

```ini
[UNITINFO]
{
    // === Identification ===
    UnitName=ARMCOM;          // Internal lookup key
    Objectname=armcom;        // → objects3d/armcom.3do, scripts/armcom.cob
    Side=ARM;                 // ARM or CORE
    Designation=Commander;    // Mouseover label
    Description=Commander, Arm;

    // === Economy & build ===
    BuildCostMetal=2500;
    BuildCostEnergy=2500;
    BuildTime=89400;          // Build-power × seconds (engine units)
    WorkerTime=300;           // How fast it builds other things

    // === Combat ===
    MaxDamage=3000;           // Hit points
    Weapon1=COMMANDER_WEAPON; // → weapons/commander_weapon.tdf [COMMANDER_WEAPON]
    Weapon2=disintegrator;    // The dreaded D-gun
    candgun=1;                // Allowed to fire weapon2 on demand

    // === Movement ===
    MaxVelocity=1.15;
    Acceleration=0.075;
    BrakeRate=0.0825;
    TurnRate=510;
    MovementClass=COMMANDER_TANK3;  // → gamedata/movinfo.tdf

    // === Senses ===
    SightDistance=520;
    RadarDistance=585;

    // === Tags & categories ===
    Category=COMMANDER SURFACE MOBILE WEAPON ...;
    NoChaseCategory=AIR;

    [SOUNDS] {
        canselect=cmdsel1;
        select1=cmdok1;
        ...
    }
}
```

The 1998 community FBI guide (preserved in this repo's source materials)
documents over a hundred fields. Most are self-explanatory; the
non-obvious ones tend to be:

| Field | What it really controls |
|-------|------------------------|
| `Bmcode` | Build-menu page code — leave at `1` for normal units. |
| `Category` | Space-separated tag list used by weapon `BadTargetCategory`, `NoChaseCategory`, AI, and the build menus. |
| `MovementClass` | References a class in `gamedata/movinfo.tdf` defining acceptable terrain slopes, water depth, etc. |
| `YardMap` | ASCII picture (e.g. `oooo\noooo\n`) declaring the unit's footprint and water/land restrictions per cell. |
| `Corpse` | Name of a `[FEATURE]` (see below) used as the wreckage drop. |
| `SoundCategory` | Picks the audio bank in `gamedata/sound.tdf`. |
| `TEDClass` | Hint to the Cavedog editor; ignored at runtime. |

> [!IMPORTANT]
> **`UnitName` is the lookup key everywhere else** — the OTA references
> it, the AI references it, the build menu references it. If you rename
> an FBI you have to grep the entire mod for references.

---

## TDF — feature, weapon, sound definitions

`features/**/*.tdf` files contain `[FEATURE]` sections, one per static
map prop. The TNT format ([TNT](tnt.md)) references these by section
name:

```ini
[ArmTree01]
{
    description=Arm Tree;
    category=trees;
    object=arm_tree01;       // → objects3d/arm_tree01.3do
    footprintx=1;
    footprintz=1;
    height=20;
    blocking=1;              // Pathing obstacle
    flamable=1;
    burnmin=10;
    burnmax=20;
    burntime=30;
    feature_reclamate=ArmTree01_Heap; // Recursive: what's left when reclaimed
    damage=15;
    reclaimable=1;
    energy=0;
    metal=2;
    seqname=arm_tree01;      // GAF sequence to draw (for animated features)
}
```

`weapons/*.tdf` follow the same pattern, with `[WEAPON_NAME]` sections.
The FBI's `Weapon1=COMMANDER_WEAPON` field resolves to the
`[COMMANDER_WEAPON]` section in some TDF in `weapons/`. The community
weapons guide documents about 60 distinct fields; the meaty ones are
`ballistic`/`lineofsight`/`dropped` (the weapon archetype),
`weapontimer`, `weaponvelocity`, `areaofeffect`, `edgeeffectiveness`,
`burst`/`burstrate`, and the `[DAMAGE]` sub-section (per-category damage
modifiers).

```ini
[FLAMETHROWER] {
    ID=1;
    name=Flame Thrower;
    rendertype=5;
    ballistic=1;
    turret=1;
    range=160;
    reloadtime=1.2;
    weapontimer=1;
    weaponvelocity=188;
    areaofeffect=32;
    burst=17;
    burstrate=.04;
    [DAMAGE] {
        default=10;
        corpyro=2;          // Pyros are nearly fireproof
    }
}
```

---

## `[MENUENTRY]` — Build-menu extension

Files in `download/*.tdf` register a unit with the build menus of one
or more constructors **without modifying `sidedata.tdf`**. This is the
mechanism Cavedog's Core Contingency expansion uses to add its units,
and the convention every single-unit `.ufo` add-on follows.

```ini
[MENUENTRY1]
{
    UNITMENU=ARMVP;       // Builder's UnitName
    MENU=3;               // Menu page (row)
    BUTTON=4;             // Slot within the page
    UNITNAME=MYFLASH;     // Unit being placed
}

[MENUENTRY2]              // Additional builders for the same unit
{
    UNITMENU=ARMACV;
    MENU=3;
    BUTTON=4;
    UNITNAME=MYFLASH;
}
```

| Field | Type | Meaning |
|-------|------|---------|
| `UNITMENU` | str | `UnitName` of the constructor unit whose menu we're adding to. |
| `MENU` | int | Build-menu page number. `1`–`2` are reserved by Cavedog for stock units; community convention is to start at `3`. |
| `BUTTON` | int | Slot within the page (`0`–`5`, laid out as a **2-column × 3-row grid**: `0`=top-left, `1`=top-right, `2`=mid-left, `3`=mid-right, `4`=bottom-left, `5`=bottom-right). |
| `UNITNAME` | str | The unit *being added* — must match the `UnitName=` in your unit's FBI. |

**File-naming convention.** The file is conventionally
`download/<UNITNAME>.tdf` (matching the `UNITNAME=` of the first
entry), but the engine reads every `*.tdf` in `download/`, so the
filename is purely a hint to the modder. One unit per file is the
norm.

**Multiple entries.** A single file can hold any number of
`[MENUENTRY<N>]` sections — Cavedog's `download/Armfort.tdf` uses
three to make the Arm Fortification Wall buildable from ACK, ACV, and
ACA. Numbering starts at 1 and must be contiguous; gaps will cause
later entries to be silently dropped.

> [!IMPORTANT]
> **`download/*.tdf` adds to the build menu; it doesn't replace
> anything.** If the slot you pick collides with an existing entry,
> the engine's behaviour is unpredictable — usually the later-loaded
> entry wins, but `.ufo` load order isn't guaranteed across platforms.
> Pick a high `MENU` page (4 or 5) for mods meant to coexist.

This is the additive mod hook that lets you ship a single `.ufo`
without forking the 50 KB `sidedata.tdf`. See the [modding
tutorial](modding.md#5-register-the-unit-with-the-build-menu) for
end-to-end usage.

---

## OTA — map metadata

`.ota` ships alongside every `.tnt` and carries everything the engine
needs to *play* the map (as opposed to render its terrain):

```ini
[GlobalHeader]
{
    missionname=Metal Heck;
    missiondescription=A small, brutal metal map.
    planet=metal;
    tidalstrength=0;
    solarstrength=20;
    lavaworld=0;
    killmul=50;
    waterdoesdamage=0;
    minwindspeed=100;
    maxwindspeed=2500;
    gravity=112;
    numplayers=2,4,6,8,10;

    [Schema 0] {
        Type=Network 1;
        aiprofile=DEFAULT;
        SurfaceMetal=10;
        MohoMetal=125;
        HumanMetal=1000;
        ComputerMetal=1000;
        HumanEnergy=1000;
        ComputerEnergy=1000;
        [specials] {
            [special0] { specialwhat=StartPos1; XPos=464; ZPos=216; }
            [special1] { specialwhat=StartPos2; XPos=3408; ZPos=216; }
            ...
        }
    }
}
```

`kbot tnt preview` reads the matching `.ota` and draws numbered markers
at each `StartPosN` it finds.

> [!NOTE]
> **`Schema 0`, `Schema 1`, etc. are alternate setups for the same
> map** — usually different start-position layouts for different player
> counts. The game UI lets you pick a schema in the lobby; mods that
> add Schema 1+ should mirror the slot numbering convention used by
> Cavedog (`numplayers=2,4,6,8,10` ⇒ schemas 0..4).

---

## Worked example — minimal unit

A complete, working "fake" FBI for a stationary turret:

```ini
[UNITINFO]
{
    UnitName=MYTURRET;
    Objectname=myturret;
    Side=ARM;
    Designation=Test Turret;
    Description=Bare-minimum turret for format testing.

    BuildCostMetal=200;
    BuildCostEnergy=400;
    BuildTime=2400;
    MaxDamage=600;

    Category=NOTSUB SURFACE WEAPON NOTAIR;
    TEDClass=LASER;
    Builder=0;
    canattack=1;
    onoffable=0;
    ActivateWhenBuilt=1;

    Weapon1=LIGHTLASER;

    FootprintX=2;
    FootprintZ=2;
    YardMap=cccc;
    MaxSlope=15;
    MaxWaterDepth=0;
    SightDistance=300;

    Corpse=MyTurret_Dead;

    [SOUNDS] {
        select1=corselect1;
        ok1=corok1;
    }
}
```

To make this a complete unit add-on you'd ship:

```
mymod/
├── units/myturret.fbi
├── objects3d/myturret.3do
├── scripts/MYTURRET.cob
├── features/corpses/myturret.tdf       # contains [MyTurret_Dead]
└── unitpics/MYTURRET.PCX
```

…then HPI-pack the directory:

```bash
kbot hpi pack ./mymod --target myturret.ufo
```

---

## Gotchas

> [!WARNING]
> **Every value must end with `;`.** A missing semicolon doesn't error —
> the parser silently merges the value with the next line, producing
> baffling stats (a `MaxDamage=3000` followed by an unterminated
> `Description=...` produces a unit with 30,000 hit points and no
> tooltip).

- **Keys are case-insensitive, values are not.** `Side=arm` will match
  unit-classification logic for ARM, but mods that switch sides on the
  fly with `if (Side == "ARM")` against string-equality lookups will
  break.
- **List values are space-separated** (`Category=COMMANDER MOBILE WEAPON`)
  — not comma-separated. The engine splits on any whitespace.
- **Some OTA fields use commas**, however: `numplayers=2,4,6,8,10`. There
  isn't a single list-delimiter convention.
- **Nested sections have no formal depth limit**, but Cavedog never
  shipped anything more than 3 deep. Editors that assume 2-deep will
  fail on a handful of weapon TDFs with `[WEAPON][DAMAGE][category]`-
  style nesting.
- **Boolean fields are integers** (`canmove=1`, `canstop=0`), not
  `true`/`false`. The engine accepts `1`/`0` only.
- **`.ota` files routinely have UTF-8 mojibake** in mission descriptions
  (smart-quotes from Word, etc.). The engine renders them with the
  Windows-1252 codepage and will tofu anything outside it.

---

## Typical sizes

| Asset | Range observed in Cavedog content |
|-------|-----------------------------------|
| Unit FBI | 1–4 KB (commander: ~3 KB; light tank: ~1.5 KB) |
| Single-feature TDF | 200 B – 1 KB |
| Weapon TDF | 0.5–3 KB per `[WEAPON]` section |
| OTA file | 1–8 KB |
| `gamedata/sidedata.tdf` | ~50 KB (HUD layout dominates) |
| `gamedata/sound.tdf` | ~20 KB |
| Total FBIs in TA + CC | ~250 files |

---

## Appendix A — FBI field dictionary

Every field commonly found in `units/*.fbi`. Grouped by purpose.
**Type** column key: `str` = identifier/string; `int` = integer;
`float` = float; `bool` = `0`/`1`; `list` = whitespace-separated
tokens; `enum` = small integer with documented meanings.

Fields not listed here are either editor scratch (`UnitNumber`,
`Copyright`) or undocumented. The engine ignores unknown keys silently.

### Identity & display

| Field | Type | Notes |
|-------|------|-------|
| `UnitName` | str | **Primary lookup key.** Referenced by other configs, the AI, OTA, build menus. |
| `Side` | str | `ARM` or `CORE` (TA), `Aramon`/`Taros`/`Veruna`/`Zhon` (TA:K). Matches a `[SIDE<N>]` in `gamedata/sidedata.tdf`. |
| `Objectname` | str | Base name for the unit's `.3do` mesh, `.cob` script, and `unitpics/*.pcx` portrait. |
| `Designation` | str | The "type code" displayed in the unit info panel (e.g. `ARM-WM` for the Arm commander). |
| `Name` | str | Short display name shown over the unit. |
| `Description` | str | Tooltip text shown on the build button and unit info panel. |
| `GermanName` / `FrenchName` / `SpanishName` / `ItalianName` / `JapaneseName` / `PigLatinName` | str | Localised names. Used per shipped locale. |
| `GermanDescription` / `FrenchDescription` / `SpanishDescription` / `ItalianDescription` / `JapaneseDescription` / `PigLatinDescription` | str | Localised tooltip text. |
| `Version` | int | Editor-tracked schema version. Always `1` or `2` in retail content. |
| `UnitNumber` | int | Editor-only ID. Ignored at runtime. |
| `Copyright` | str | Free-form copyright string. Ignored. |
| `TEDClass` | str | TAE editor classification (`KBOT`, `TANK`, `COMMANDER`, …). Cosmetic only. |

### Economy & construction

| Field | Type | Notes |
|-------|------|-------|
| `BuildCostMetal` | int | Metal required to build this unit. |
| `BuildCostEnergy` | int | Energy required to build this unit. |
| `BuildTime` | int | Build-power × seconds. The engine divides by the constructor's `WorkerTime` to get real-world build time. |
| `WorkerTime` | int | Build-power emitted by *this* unit when it's a constructor. |
| `EnergyUse` | int | Energy drained per tick when active. |
| `EnergyMake` | int | Energy produced per tick when active. |
| `MetalUse` | int | Metal drained per tick. |
| `MetalMake` | int | Metal produced per tick. |
| `EnergyStorage` | int | Storage capacity. Blank for non-storage units. |
| `MetalStorage` | int | Storage capacity. Blank for non-storage units. |
| `MakesMetal` | int | Per-tick metal manufactured (different from `MetalMake` — used by metal-makers). |
| `ExtractsMetal` | int | Per-tick metal pulled from a deposit (metal extractors). |
| `TidalGenerator` | bool | This unit's energy output scales with the map's `tidalstrength`. |
| `WindGenerator` | bool | Output scales with the map's wind speed range. |
| `Builder` | bool | Can build other units. |
| `Builddistance` | int | Maximum nano-lathe distance, in 16-px cells. |
| `CanReclamate` | bool | Can reclaim wreckage/features. |
| `CanCapture` | bool | Can capture enemy units (commanders only). |
| `ActivateWhenBuilt` | bool | Defaults the "active" toggle to on when construction completes. |
| `onoffable` | bool | Has an on/off toggle the player can flip. |

### Combat & survivability

| Field | Type | Notes |
|-------|------|-------|
| `MaxDamage` | int | Hit points. |
| `Weapon1` / `Weapon2` / `Weapon3` | str | Names of weapon sections in `weapons/*.tdf`. Up to 3 weapons. |
| `wpri_badTargetCategory` | list | Categories the primary weapon does poorly against (deprioritised). |
| `wsec_badTargetCategory` | list | Same for secondary weapon. |
| `BadTargetCategory` | list | Targets the unit as a whole avoids. |
| `NoChaseCategory` | list | Targets the unit won't pursue (will fire only if in range). |
| `canattack` | bool | Can fire weapons at all. |
| `candgun` | bool | Can fire its 3rd weapon manually (the Commander's D-gun). |
| `commandfire` | bool | Forces every shot to be player-initiated. |
| `ExplodeAs` | str | Weapon name for the on-death explosion (in `weapons/*.tdf`). |
| `SelfDestructAs` | str | Weapon name for the self-destruct explosion. |
| `Corpse` | str | `[FEATURE]` section name in `features/**/*.tdf` for the wreckage drop. |
| `HealTime` | int | Seconds to fully heal at a repair pad. |
| `DamageModifier` | float | Multiplier applied to incoming damage. `<1` = resistant. |
| `ImmuneToParalyzer` | bool | Ignores stasis weapons. |
| `HideDamage` | bool | Hides the damage bar from the enemy. |
| `kamikaze` | bool | Detonates on contact instead of firing. |
| `firestandorders` | bool | Has the standing-fire-order toggle. |
| `StandingFireOrder` | enum | Default fire stance: `0` = hold, `1` = return, `2` = at will. |
| `mobilestandorders` | bool | Has the standing-move-order toggle. |
| `StandingMoveOrder` | enum | Default move stance: `0` = hold, `1` = manoeuvre, `2` = roam. |
| `ShootMe` | bool | Hint to AI/computer opponents: prioritise targeting this unit. |
| `Commander` | bool | Marks this as a commander unit (loses game when killed). |

### Movement

| Field | Type | Notes |
|-------|------|-------|
| `MaxVelocity` | float | Top speed in world units per tick. |
| `Acceleration` | float | Speed gained per tick. |
| `BrakeRate` | float | Speed lost per tick when stopping. |
| `TurnRate` | int | Rotation speed in `2π/65536` units per tick. |
| `MaxSlope` | int | Steepest land slope the unit can climb. |
| `MaxWaterDepth` | int | Deepest water the unit can enter. `0` = strictly land. |
| `MinWaterDepth` | int | Minimum water depth (boats only). |
| `MovementClass` | str | Class name in `gamedata/moveinfo.tdf`. Drives detailed pathing. |
| `SteeringMode` | enum | `0`/`1`/`2` — turn-then-move vs. arc vs. instant. |
| `Upright` | bool | Renders the unit standing (kbots) or flat (vehicles). |
| `BankScale` | float | How aggressively the unit rolls when turning (aircraft). |
| `PitchScale` | float | How aggressively the unit pitches when accelerating. |
| `Scale` | float | Visual scale multiplier (`1.0` = normal). |
| `CanFly` | bool | Aircraft flag. |
| `crusisealt` | int | Cruise altitude for fliers. |
| `attackrunlength` | int | Distance for VTOL/bomber strafe runs. |
| `HoverAttack` | bool | Aircraft hovers while attacking (gunships). |
| `floater` | bool | Floats on water surface. |
| `canmove` | bool | The unit can move at all. |
| `canpatrol` | bool | Patrol order is enabled. |
| `canstop` | bool | Stop order is enabled. |
| `canguard` | bool | Guard order is enabled. |
| `canload` | bool | Can load transported units. |
| `transportsize` | int | Size class for transport-load checks. |
| `transportmaxunits` / `TransMaxUnits` | int | Capacity for transport units. |
| `manuverleashlength` (also `maneuverleashlength`) | int | How far from its standing position the unit will manoeuvre. |
| `BadSlope` | int | Slope at which movement slows but isn't blocked. |
| `BuildAngle` | int | Maximum slope on which this unit can be *built*. |

### Senses

| Field | Type | Notes |
|-------|------|-------|
| `SightDistance` | int | LOS radius in 16-px cells. |
| `RadarDistance` | int | Radar coverage radius. `0` = no radar. |
| `SonarDistance` | int | Sonar coverage radius. |
| `RadarDistanceJam` | int | Radius the unit jams enemy radar. |
| `Stealth` | bool | Unit doesn't appear on enemy radar. |
| `CloakCost` | int | Energy per tick to remain cloaked while stationary. |
| `CloakCostMoving` | int | Energy per tick to remain cloaked while moving. |
| `mincloakdistance` | int | Cloak fails when an enemy is within this many cells. |

### Build menu & footprint

| Field | Type | Notes |
|-------|------|-------|
| `Bmcode` | int | Build-menu code. Leave at `1` for unit-buildable; `0` for buildings that don't appear. |
| `FootprintX` / `FootprintZ` | int | Footprint in 16-px cells. Must match the `MovementClass` footprint. |
| `YardMap` | str | Multi-line ASCII grid (`o`=open, `c`=closed, `w`=water, `g`=geothermal) defining per-cell restrictions. |
| `ThreeD` | bool | Renders as a 3D model. Always `1` for retail units. |
| `ZBuffer` | bool | Use Z-buffering. Always `1`. |
| `NoShadow` | bool | Skip shadow rendering. |
| `NoAutoFire` | bool | Disable automatic firing. |
| `norestrict` | bool | Skip restricted-zone enforcement. |
| `IsAirBase` | bool | Aircraft can land/repair here. |
| `IsFeature` | bool | Treat as a static feature, not a unit. |
| `Category` | list | **Critical.** Whitespace-separated tag list used by weapon targeting, AI weights, build menus. Standard tokens: `MOBILE`, `WEAPON`, `SURFACE`, `UNDERWATER`, `VTOL`, `KBOT`, `TANK`, `SHIP`, `LEVEL1`/`LEVEL2`/`LEVEL3`, `NOTSUB`, `NOTAIR`, `COMMANDER`, side names. |
| `WaterLine` | int | Depth at which a floating unit settles. |
| `altfromsealevel` | int | Aircraft altitude is measured from sealevel, not terrain. |

### Audio

| Field | Type | Notes |
|-------|------|-------|
| `SoundCategory` | str | Name of a section in `gamedata/sound.tdf` providing the unit's voice samples. |
| `[SOUNDS]` (nested section) | sub-section | Inline overrides for specific events (`canselect=…`, `select1=…`, etc.). |

### Misc / poorly-understood

| Field | Type | Notes |
|-------|------|-------|
| `DefaultMissionType` | str | Initial mission state (`Standby`, `Move`, etc.). |
| `sortbias` | int | Sorting weight in the build menu. |
| `teleporter` | bool | Marks as a teleport platform (Galactic Gate). |
| `IsAirBase` | bool | See "Build menu & footprint" — duplicated for completeness. |
| `Ovradjust` | bool | Triggers an undocumented engine override; only the commander uses it. |
| `ShowPlayerName` | bool | Shows the player's name above the unit (commander only). |
| `MoveRate1` / `MoveRate2` | int | Editor scratch. Not used at runtime. |
| `antiweapons` | bool | Used by anti-weapon platforms (Fortitude, anti-nuke). |

---

## Live examples in the reference catalogue

Field usage is best learned from real FBIs. The reference repos
catalogue every shipped unit:

- [TA — every FBI](https://github.com/coreprime/reference-ta/blob/main/ta-units.md):
  good "rich" examples are `ARMCOM` (commander with `Commander=1`,
  `CloakCost`, `MaxDamage=3000`), `ARMSAM` (turret with
  `Weapon1/2/3` filled), `ARMBRAWL` (aircraft with `CanFly`,
  `crusisealt`, `BankScale`), `ARMMEX` (metal extractor with
  `ExtractsMetal`).
- [TA — every weapon TDF](https://github.com/coreprime/reference-ta/blob/main/ta-weapons.md):
  `[FLAMETHROWER]` for `burst`/`burstrate`/`firestarter`,
  `[NUCLEAR_MISSILE]` for two-phase guided missiles,
  `[LIGHTNING]` for a beam weapon.
- [TA — feature & weapon build-tree](https://github.com/coreprime/reference-ta/blob/main/ta-buildtree.md)
  — every `[MENUENTRY]` registration in the install.
- [TA: Kingdoms units](https://github.com/coreprime/reference-tak/blob/main/tak-units.md)
  — the different field set (`buildcost=` single resource,
  `damagecategory=`, inline `[WEAPONn]`). `ARAKING` (Aramon's monarch
  Elsin) and `ARAARCH` (Archer) are good entry-points.

---

## See also

- [TNT](tnt.md) — references feature names that resolve to `[FEATURE]`
  TDF sections.
- [3DO](3do.md), [COB](cob.md) — referenced from FBI `Objectname`.
- [GAF](gaf.md) — referenced from feature `seqname` and weapon
  `explosiongaf`.
- [Gamedata TDFs](gamedata.md) — `moveinfo.tdf`, `sound.tdf`,
  `sidedata.tdf` referenced from FBI fields.
- [Sound](sound.md) — how `SoundCategory` resolves to WAV files.
- [Glossary](glossary.md) — *side*, *footprint*, *yardmap*, *schema*.
