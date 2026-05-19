# AI — Computer Opponent Profiles

> The files in `ai/*.txt` are **plain-text computer-opponent profiles**.
> Each profile declares per-difficulty build-priorities and unit caps;
> the engine reads them when an AI player is configured for a map. The
> [OTA](tdf.md) `aiprofile=` key picks which profile a given map starts
> with, but the user can override it in the lobby.

> [!TIP]
> **Try it yourself.**
> ```bash
> # Plain-text — just read them
> ls $(kbot ctx path)/ai/
> head -40 $(kbot ctx path)/ai/default.txt
> ```
>
> **From Go.** Use [`formats/ai`](../../formats/ai/ai.go):
> ```go
> import "github.com/coreprime/kbot/formats/ai"
>
> raw, _ := os.ReadFile("ai/default.txt")
> profile, _ := ai.Parse(raw)
> for _, plan := range profile.Plans { /* plan.Name, plan.Weights, plan.Limits */ }
> ```

---

## At a glance

A profile is a sequence of **plans**, one per difficulty level. Each
plan contains `Weight` and `Limit` directives keyed by either a single
unit name (`ARMCOM`) or a category alias (`PLANT`, `LEVEL3`,
`SPECIAL`).

```text
plan easy

Weight ARM      0.2
Weight CORE     0.2
Weight PLANT    2
Weight CONSTR   3
Weight ARMACK   2
Weight CORACK   2

Limit  ARMSILO  1
Limit  CORSILO  1


plan medium

Weight ARM      1.0
Weight CORE     1.0
...
```

### Directives

| Directive | Syntax | Meaning |
|-----------|--------|---------|
| `plan <name>` | `plan easy` | Begins a new plan block. Subsequent `Weight`/`Limit` lines belong to it until the next `plan` or end of file. |
| `Weight <name> <float>` | `Weight ARMCK 2.5` | Multiplicative priority for building this unit/category. Higher = more likely to choose it. |
| `Limit <name> <int>` | `Limit ARMSILO 1` | Maximum number of this unit the AI will build at once. |

Notes from the parser ([`formats/ai/ai.go`](../../formats/ai/ai.go)):

- **Lines starting with `//` are comments.** Anything after `//` on a line
  is ignored.
- **Blank lines are skipped.**
- **Directive names are case-insensitive** (`plan`, `Plan`, `PLAN` all
  work). Unit names are normalised to uppercase when stored.
- **Weights are floating-point**, written either as `0.5` or `.5`. Mixed
  decimal/leading-dot styles appear in Cavedog's profiles.
- **Anything outside a `plan` block is silently skipped *for TA*.**
  A `Weight` before the first `plan` directive in a TA profile will
  not crash the file but won't apply anywhere either. *TA: Kingdoms*
  AI files don't use `plan` at all — see
  [TA: Kingdoms — plan-less profiles](#ta-kingdoms--plan-less-profiles)
  below.

### Difficulty levels

Stock profiles ship three plans named `easy`, `medium`, and `hard`. The
parser doesn't require those exact names — it'll happily read a file
with `plan brutal` or `plan tutorial`. But the engine's lobby UI only
exposes the standard three; non-standard names will not appear as
selectable difficulties.

---

## Unit names vs category aliases

Both `Weight` and `Limit` can target either:

- **A specific unit's `UnitName`** — e.g. `ARMCOM`, `CORRAID`. These are
  the keys from each unit's [FBI](tdf.md).
- **A unit-category alias** — group keywords (`ARM`, `CORE`, `PLANT`,
  `CONSTR`, `LEVEL3`, `SPECIAL`, `LEVEL10`, …) that match against the
  `Category=` field on each unit.

A `Weight ARM 0.5` lowers the priority of every Arm-side unit; a
`Weight ARMCOM 5.0` boosts the Arm commander specifically. The engine
multiplies stacking weights together when both apply, so the two
combined would yield a relative weight of `0.5 × 5.0 = 2.5` for the
commander.

> [!IMPORTANT]
> **Category aliases are matched against the unit's `Category=` token
> list, not against any taxonomy file.** A category alias only "exists"
> if at least one unit declares it. Misspell `LEVL3` and the directive
> silently does nothing.

---

## Worked example — fragment of `default.txt`

```
// DEFAULT PROFILE

//--------------------------- EASY

plan easy

Weight ARM 0.2          // Halve the priority for the whole Arm side
Weight CORE 0.2

Weight ARMRAD 0.25      // The AI rarely builds radar towers on easy
Weight CORRAD 0.25

Weight ARMMAKR .1       // …and almost never metal-makers
Weight CORMAKR .1

Weight PLANT 2          // But factories are double-priority
Weight CONSTR 3         // And constructors triple

// encourages advanced units
Weight ARMACK 2         // Advanced Construction Kbots
Weight CORACK 2
Weight ARMACV 2
Weight CORACV 2
Weight ARMACA 2
Weight CORACA 2
Weight SPECIAL 2
Weight LEVEL3 2
```

Reading this: on easy difficulty, the AI strongly prefers building
production buildings and advanced constructors, but builds very few
radar towers, metal makers, or units in general.

---

## Map-specific profiles

Cavedog ships a handful of map-tuned profiles:

| Profile | Used by |
|---------|---------|
| `default.txt` | Most generic maps |
| `metal.txt` | Metal-rich maps (Metal Heck and friends) |
| `airbattle.txt` | Air-focused maps |
| `seabattle.txt` | Naval-focused maps |
| `hover.txt` | Hover-heavy maps |
| `acid.txt` | Acid world maps |
| `urban.txt` | Urban maps |
| `waterwrld.txt` | Water-world maps |
| `krogoth.txt` | The Krogoth boss mission |
| `missions.txt` | Campaign missions |

The map's `.ota` selects which one via `aiprofile=`, e.g.
`aiprofile=metal`.

---

## TA: Kingdoms — plan-less profiles

> [!NOTE]
> **This section is the TA:K-only delta.** TAK uses the same
> `ai/*.txt` filename convention and the same `weight`/`limit`
> directive syntax, but treats the `plan` directive as optional.

Every retail TA: Kingdoms AI profile (`ai/default.txt`, the campaign
`ai/mission*.txt` set) lists `weight`/`limit` directives **without
any `plan` line at all** — there's just one implicit difficulty per
file. The structure is a long weights block followed by a long
limits block, side-grouped by unit-name prefix.

### Worked example — first 30 lines of `ai/default.txt`

```text
// Kingdoms Default AI Profile 3-28-99


weight araarch 5
weight araat 1
weight arabow 8
weight arabroad 5
weight arabuild 10
weight aracan 4
weight aracastl 10
weight araclay 5
weight aradrag 25      // Dragons: top priority
weight arafast 1
weight arakeep 10
weight araknigh 5
weight aralode 10
weight aramana 5
weight arangate 0      // 0 = never build
weight arapal 8
weight arapries 10
weight arapult 1
weight arasmith 8
weight araspy 4
weight arassh 1
weight arasword 5
weight aratre 1
weight arawall 0
weight arawar 1
```

A weight-bias scan of `default.txt` reveals Cavedog's priorities:

- **`aradrag 25`** — the Aramon Dragon is intentionally over-weighted;
  the AI will build dragons more eagerly than anything else.
- **`arabuild 10`**, **`aracastl 10`**, **`arakeep 10`**,
  **`arapries 10`** — every economy/builder type sits at weight 10.
- **`arawall 0`**, **`arangate 0`** — explicitly zero, never built.
- **`araat 1`**, **`arafast 1`**, **`arassh 1`** — base units that
  the AI deprioritises in favour of higher-tier alternatives.

The same pattern repeats for `tar*`, `ver*`, and `zon*` units further
down the file.

### Limits block

Below the weights block comes a parallel limits block:

```text
limit araarch 16
limit araat 8
limit arabow 16
limit arabroad 16
limit arabuild 10
limit aracan 3
limit aracastl 2       // Only 2 castles per game
limit araclay 3
limit aradrag 1        // ONE dragon, even though weight=25
limit arafast 4
limit arakeep 2
limit araknigh 16
…
```

Note the asymmetry: `aradrag` has weight `25` (high priority) but
limit `1` (never more than one). This is how TA:K's AI builds toward
a hero unit — high weight gets it built early, low limit keeps the
army composition reasonable.

### Profile statistics

`default.txt` and the campaign mission files all follow the same
shape:

| Profile | Weight lines | Limit lines | Plans |
|---------|------:|------:|------:|
| `ai/default.txt` | 104 | 104 | 0 |
| `ai/mission06.txt` | 104 | 104 | 0 |
| `ai/mission08.txt` (Iron Plague mission) | 161 | 162 | 0 |

Iron Plague mission files have richer weight/limit tables because
they cover Creon (CRE prefix) units that the base game's `default.txt`
omits.

### How kbot handles plan-less files

kbot's parser ([`formats/ai/ai.go`](../../formats/ai/ai.go)) opens a
synthetic `default` plan as soon as it sees a `weight` or `limit`
directive that isn't inside an explicit plan block. The viewer in
`kbot mount --server` recognises the single-plan case and drops the
per-plan header to keep the display clean.

This also means **`ai.IsAIFile()` accepts files that contain
`weight`/`limit` directives but no `plan`** — required to detect TAK
profiles as AI files in the first place. TA profiles continue to work
unchanged because they have *both* `plan` and `weight`/`limit`.

---

## Gotchas

> [!WARNING]
> **There is no validation.** The engine silently ignores typos in unit
> names, weights it can't parse, and lines outside any `plan` block.
> The first sign of a broken profile is usually "the AI is behaving
> strangely" — there's no error message.

- **`Limit 0`** effectively forbids the AI from building that unit. A
  more conservative limit (`Limit 1`) is preferable if you only want
  to discourage spam.
- **The parser strips comments with `//`.** Block comments (`/* */`)
  are **not** recognised; treat them as illegal even though weapons.tdf
  uses them elsewhere.
- **Weight values can exceed 1.0 freely.** They are relative, not a
  probability. A weight of `100` doesn't break anything.
- **Whitespace between tokens** is significant only as a separator —
  tabs, spaces, multiple spaces all work the same.
- **No support for nested or shared sections.** Each `plan` block must
  re-declare every weight/limit it cares about.

---

## Typical sizes

| Metric | Range observed in Cavedog profiles |
|--------|------------------------------------|
| File size | 1–4 KB |
| Plans per file | 3 (easy/medium/hard) |
| Weight directives per plan | 20–80 |
| Limit directives per plan | 0–10 |

---

## See also

- [TDF](tdf.md) — the `.ota` map metadata that selects an AI profile.
- [Glossary](glossary.md) — *side*, *category*.
