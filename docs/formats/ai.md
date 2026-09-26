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
> **In kbot.** The studio's asset explorer shows a profile on its
> *AI Profile* tab, and `kbot mount` prints it with `describe ai/<name>.txt`
> (see [What kbot shows](#what-kbot-shows)).
>
> **From Go.** Use kbot-io's [`formats/ai`](https://github.com/coreprime/kbot-io/blob/main/formats/ai/ai.go):
> ```go
> import "github.com/coreprime/kbot-io/formats/ai"
>
> raw, _ := os.ReadFile("ai/default.txt")
> profile, _ := ai.Parse(raw)
> // profile.Preamble: lines before the first plan; profile.Plans: plan.Name,
> // plan.Weights, plan.Limits; profile.Diagnostics: lines read unusually.
> settings := ai.NewResolver(units).Apply(profile, ai.Easy) // per-unit result
> ```

---

## At a glance

A profile is a sequence of **plans**, one per difficulty level. Each
plan contains `Weight` and `Limit` directives whose target is a single
unit name (`ARMCOM`), a category word (`PLANT`, `LEVEL3`, `SPECIAL`)
or `ALL`.

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
| `plan <word>…` | `plan easy` | Begins a new plan block. The `Weight`/`Limit` lines that follow apply only when the plan matches the game's difficulty, until the next `plan`. |
| `Weight <target> <value>` | `Weight ARMCK 0.5` | Multiplies the target's build priority (see [how weights combine](#unit-names-vs-category-words)). |
| `Limit <target> <value>` | `Limit ARMSILO 1` | Caps how many of the target a computer player owns: `-1` is unlimited, `0` or any other negative value forbids it. |

How TA 3.1c reads the text (kbot-io's
[`formats/ai`](https://github.com/coreprime/kbot-io/blob/main/formats/ai/ai.go)
follows it):

- **A line is split into words on any whitespace** — spaces, tabs, CR,
  VT, FF — and **`#` ends the line** wherever it appears, even inside a
  word.
- **The first word is the directive**, compared case-insensitively.
  A line whose first word is anything else is ignored; that is how the
  retail `// comment` lines are skipped. Words after the value are
  ignored too, so a trailing `// note` does no harm.
- **A value is the numeric prefix of the third word.** A weight is a
  decimal number (`0.5`, `.5`, `2`, `1e1`); a limit is an integer that
  wraps to 32 bits. A value word that is not a number reads as **0 and
  the directive still applies**: retail `krogoth.txt`'s `Limit CORFORT O`
  (a letter O) forbids CORFORT, and `Limit ARM DECOM 4` limits the whole
  ARM category to 0.
- **Lines before the first `plan` line are ignored when a game starts**,
  because no plan has matched yet. They may apply if the profile is
  reloaded during a game. Retail `krogoth.txt` starts with two such
  lines (`weight cormakr 0.2`, `weight armmakr 0.2`). *TA: Kingdoms* AI
  files don't use `plan` at all — see
  [TA: Kingdoms — plan-less profiles](#ta-kingdoms--plan-less-profiles)
  below.

### Difficulty levels

Stock profiles ship three plans named `easy`, `medium`, and `hard`. A
plan applies at a difficulty when one of its words (case-insensitive)
names that difficulty — `plan medium hard` covers both — or when its
first word is `any`. A plan whose words name no difficulty
(`plan brutal`, a bare `plan`) matches nothing: the lines under it are
ignored until the next `plan` line.

---

## Unit names vs category words

Both `Weight` and `Limit` can target:

- **A unit's `UnitName`** — e.g. `ARMCOM`, `CORRAID` (compared
  case-insensitively). The directive applies to that unit alone and
  **locks** it: later `Weight` lines (for a weight) or `Limit` lines
  (for a limit) no longer change it.
- **A category word** — `ARM`, `CORE`, `PLANT`, `CONSTR`, `LEVEL3`,
  `SPECIAL`, … — matched against the words of each unit's `Category=`
  field. It applies to every matching unit that is not locked.
- **`ALL`** — every unit that is not locked.

Every unit starts at **100 %** priority and **no limit**. A weight
multiplies the current percentage, truncates it to a whole number and
**clamps it to 0–100 %**, so a weight above 1 can restore a unit reduced
earlier but never raises it past 100 %. A limit replaces the current
one. In `default.txt`'s easy plan, `Weight ARM 0.2` leaves every Arm
unit at 20 %; the later `Weight ARMRAD 0.25` takes the Arm radar tower
to 5 % and locks it; `Weight PLANT 2` brings each Arm factory back from
20 % to 40 %.

> [!IMPORTANT]
> **Category aliases are matched against the unit's `Category=` token
> list, not against any taxonomy file.** A category alias only "exists"
> if at least one unit declares it. Misspell `LEVL3` and the directive
> silently does nothing (kbot's viewers mark it *matches no unit*).

---

## Worked example — fragment of `default.txt`

```
// DEFAULT PROFILE

//--------------------------- EASY

plan easy

Weight ARM 0.2          // Every Arm unit to 20%
Weight CORE 0.2

Weight ARMRAD 0.25      // Radar towers to 5%, locked
Weight CORRAD 0.25

Weight ARMMAKR .1       // …metal makers to 2%, locked
Weight CORMAKR .1

Weight PLANT 2          // Factories back up to 40%
Weight CONSTR 3         // Constructors to 60%

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

Reading this: on easy difficulty every Arm and Core unit drops to
20 % priority; radar towers drop to 5 % and metal makers to 2 % (both
then locked); factories (`PLANT`) and constructors (`CONSTR`) climb
back to 40 % and 60 %, and the advanced constructors' own lines double
their 60 % to the 100 % cap and lock them.

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

kbot-io's `ai.Parse` puts every line before the first `plan` line into
`AIFile.Preamble`, which is what TA does with them (see above); for a
TA: Kingdoms profile, `ai.ParseWith(data, ai.ParseOptions{DefaultPlan:
true})` reads them into one implicit plan that matches every
difficulty. kbot's viewers show them on their own *Before first plan*
tab and say both things: TA ignores them when a game starts, TA:
Kingdoms profiles, which have no plan lines, apply them at every
difficulty. kbot does not model how TA: Kingdoms applies weights
above 1.

**`ai.IsAIFile()` looks at each line's first word**: a file is a
profile when some line starts with a directive written the usual way
(a `plan` line naming `easy`, `medium`, `hard` or `any`, or a
`weight`/`limit` line whose value starts with a number). That detects
TAK profiles, which have no `plan`, and tab-separated ones, while a
`.txt` that merely mentions "weight" or "limit" in prose is not
mistaken for one.

---

## Gotchas

> [!WARNING]
> **The game reports nothing.** A misspelt unit name is read as a
> category that matches no unit and does nothing; a value that is not a
> number reads as 0 (so a limit forbids the target); lines before the
> first `plan` are ignored at game start. The first sign of a broken
> profile is usually "the AI is behaving strangely". kbot's viewers flag
> each of these (see below).

- **`Limit 0`, or any negative limit other than `-1`**, forbids the AI
  from building that target. `-1` lifts the cap.
- **`#` ends a line anywhere**, even inside a word; there are no block
  comments. `//` works only because a line whose first word is not a
  directive is ignored, and trailing words after the value are ignored.
- **A weight above 1 never raises a unit past 100 %.** It can only
  restore a unit a category weight reduced earlier.
- **The first line naming a unit locks it.** Put unit-specific lines
  after the category lines they should refine.
- **Whitespace between tokens** is significant only as a separator —
  tabs, spaces, multiple spaces all work the same.
- **No support for nested or shared sections.** Each `plan` block must
  re-declare every weight/limit it cares about.

---

## What kbot shows

The studio's asset explorer (*AI Profile* tab) and `kbot mount`'s
`describe` read the profile as the game does:

- **Before first plan** — the preamble lines, labelled as ignored when
  a game starts.
- **One tab per plan**, each target marked *unit*, *category* or *all
  units* against the install's `units/*.fbi` (name and `Category=`). A
  category no unit has, which is how a misspelt unit name reads, is
  marked *matches no unit*.
  Weights are shown as multipliers, with a bar for the percentage a unit
  at 100 % is left with; limits as *∞ Unlimited*, *Disabled* (0 or any
  negative value other than -1) or *Max: N*.
- **Lines the game reads differently** — kbot-io's diagnostics, such as
  a value word that is not a number (`O` reads as 0) or words after the
  value. A value word that is not the number the game reads is shown
  next to it (*written "O"*); another spelling of the same number, such
  as `.1` or `0.10`, is not.
- **At game start** (studio; `kbot mount` prints the counts) — for
  easy, medium and hard, every unit whose weight or limit the profile
  changes, with 🔒 on values a unit line locked.

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
