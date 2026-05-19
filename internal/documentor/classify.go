package documentor

import "strings"

// CategoryKey is a sortable group key. The numeric prefix orders sections
// deterministically; the second element is the human-readable label.
type CategoryKey struct {
	Sort  string // e.g. "00", "10", … (controls render order)
	Label string // section heading
}

// UnitCategory groups a unit into one of the high-level role buckets used
// by the ta-units.md table.
func UnitCategory(u Unit) CategoryKey {
	cat := strings.Fields(strings.ToUpper(u.Category))
	tokens := make(map[string]bool, len(cat))
	for _, t := range cat {
		tokens[t] = true
	}
	ted := strings.ToUpper(u.TEDClass)
	name := strings.ToUpper(u.UnitName)

	if u.Commander == "1" || tokens["COMMANDER"] || ted == "COMMANDER" {
		return CategoryKey{"00", "Commander"}
	}
	if ted == "CNSTR" || tokens["CONSTR"] {
		return CategoryKey{"10", "Construction units"}
	}
	if ted == "PLANT" || tokens["PLANT"] {
		return CategoryKey{"20", "Production buildings (plants, labs, shipyards)"}
	}
	if ted == "METAL" || ted == "ENERGY" || tokens["METAL"] || tokens["ENERGY"] {
		return CategoryKey{"30", "Resource & storage buildings"}
	}
	if ted == "FORT" || tokens["LASER"] || tokens["ANTIAIR"] || tokens["ANTILASER"] ||
		hasSuffix(name, "LT", "HLT", "GUARD", "RL", "TL", "AMD", "FMD", "SILO", "ANNI", "DOOM", "PUN", "INT", "BRTHA", "MART", "BERTHA") {
		return CategoryKey{"40", "Defensive structures (turrets, anti-nuke, big-bertha)"}
	}
	if ted == "RADAR" || ted == "SONAR" || ted == "JAMMER" ||
		tokens["RADAR"] || tokens["SONAR"] || tokens["JAMMER"] ||
		hasSuffix(name, "RAD", "SONAR", "JAM", "ARAD", "VRAD") {
		return CategoryKey{"50", "Sensors & jammers (radar, sonar)"}
	}
	if ted == "VTOL" || tokens["VTOL"] {
		return CategoryKey{"60", "Aircraft (VTOL, bombers, fighters)"}
	}
	if ted == "SHIP" || tokens["SHIP"] {
		return CategoryKey{"70", "Ships (surface)"}
	}
	if tokens["UNDERWATER"] || tokens["SUB"] || hasSuffix(name, "SUB", "SUBK") {
		return CategoryKey{"75", "Submarines & underwater units"}
	}
	if ted == "KBOT" || tokens["KBOT"] {
		return CategoryKey{"80", "Kbots (bipedal walkers)"}
	}
	if ted == "TANK" || tokens["TANK"] || tokens["MOBILE"] {
		return CategoryKey{"90", "Vehicles (tanks, hovercraft, jeeps)"}
	}
	if u.IsFeature == "1" || tokens["FEATURE"] {
		return CategoryKey{"99", "Features (decorations, gates, wrecks)"}
	}
	return CategoryKey{"95", "Misc / other"}
}

// BuilderTier categorises a builder for the build-tree page layout.
func BuilderTier(b string, units map[string]Unit) CategoryKey {
	b = strings.ToUpper(b)
	u := units[b]
	cat := strings.Fields(strings.ToUpper(u.Category))
	tokens := make(map[string]bool, len(cat))
	for _, t := range cat {
		tokens[t] = true
	}
	if u.Commander == "1" || tokens["COMMANDER"] || strings.HasSuffix(b, "COM") {
		return CategoryKey{"1", "Commander"}
	}
	if hasSuffix(b, "ACK", "ACV", "ACA", "ACSUB") {
		return CategoryKey{"4", "Advanced Construction (mobile, tier 2)"}
	}
	if hasSuffix(b, "CK", "CV", "CA", "CS", "CSA", "CH", "PLAT") {
		return CategoryKey{"3", "Construction units (mobile, tier 1)"}
	}
	if hasSuffix(b, "MLV", "HP") {
		return CategoryKey{"5", "Utility (mine layers, hover pads)"}
	}
	switch b {
	case "ARMALAB", "ARMAVP", "ARMAAP", "ARMASY",
		"CORALAB", "CORAVP", "CORAAP", "CORASY":
		return CategoryKey{"6", "Advanced factories (tier 2)"}
	case "ARMGANT", "CORGANT":
		return CategoryKey{"7", "Krogoth gantry"}
	}
	if hasSuffix(b, "LAB", "VP", "AP", "SY") {
		return CategoryKey{"2", "Basic factories (tier 1)"}
	}
	return CategoryKey{"8", "Other builders"}
}

// SideOf returns "ARM", "CORE", or "OTHER" based on a unit's name prefix.
// (TA convention — uses 3-char prefix.)
func SideOf(unitname string) string {
	u := strings.ToUpper(unitname)
	switch {
	case strings.HasPrefix(u, "ARM"):
		return "ARM"
	case strings.HasPrefix(u, "COR"):
		return "CORE"
	default:
		return "OTHER"
	}
}

// SideOfTAK maps a 3-char unit-name prefix to its TA: Kingdoms side
// short code. Accepts both internal codes (ARA, TAR, …) and unit-name
// prefixes; falls back to the literal prefix uppercased.
func SideOfTAK(unitname string) string {
	u := strings.ToUpper(unitname)
	if len(u) < 3 {
		return "OTHER"
	}
	switch u[:3] {
	case "ARA":
		return "ARA"
	case "TAR":
		return "TAR"
	case "VER":
		return "VER"
	case "ZON":
		return "ZON"
	case "CRE":
		return "CRE"
	case "MON":
		return "MON"
	case "LIF":
		return "LIF"
	case "NPC":
		return "NPC"
	}
	return "OTHER"
}

// TAKSideLabel returns the player-friendly side name for a TA:K code.
func TAKSideLabel(side string) string {
	switch strings.ToUpper(side) {
	case "ARA":
		return "Aramon"
	case "TAR":
		return "Taros"
	case "VER":
		return "Veruna"
	case "ZON":
		return "Zhon"
	case "CRE":
		return "Creon"
	case "MON":
		return "Monsters"
	case "LIF":
		return "Wildlife"
	case "NPC":
		return "NPCs"
	}
	return side
}

// UnitCategoryTAK groups a TA: Kingdoms unit into a role bucket.
// Heavily heuristic — TA:K's `tedclass` carries a side name rather than a
// role, so we lean on the category tokens and unit-name suffixes.
func UnitCategoryTAK(u Unit) CategoryKey {
	cat := strings.Fields(strings.ToUpper(u.Category))
	tokens := make(map[string]bool, len(cat))
	for _, t := range cat {
		tokens[t] = true
	}
	name := strings.ToUpper(u.UnitName)

	if tokens["MONARCH"] || tokens["KING"] || tokens["LEADER"] || tokens["COMMANDER"] ||
		strings.HasSuffix(name, "KING") || strings.HasSuffix(name, "LIEGE") ||
		strings.HasSuffix(name, "HAND") || strings.HasSuffix(name, "LORD") {
		return CategoryKey{"00", "Monarch / leader"}
	}
	if tokens["BUILDER"] || tokens["BUILD"] || strings.HasSuffix(name, "BUILD") ||
		strings.HasSuffix(name, "BUILDER") {
		return CategoryKey{"10", "Builder units"}
	}
	if tokens["CASTLE"] || tokens["KEEP"] || tokens["FORTRESS"] || tokens["BUILDING"] ||
		strings.HasSuffix(name, "CASTL") || strings.HasSuffix(name, "KEEP") ||
		strings.HasSuffix(name, "CADE") || strings.HasSuffix(name, "TOWER") ||
		strings.HasSuffix(name, "WALL") || strings.HasSuffix(name, "GATE") ||
		strings.HasSuffix(name, "LODE") {
		return CategoryKey{"20", "Buildings & fortifications"}
	}
	if tokens["MAGIC"] || tokens["MAGE"] || tokens["WIZARD"] || tokens["SPELL"] ||
		strings.HasSuffix(name, "MAGE") || strings.HasSuffix(name, "PRIES") ||
		strings.HasSuffix(name, "NECRO") || strings.HasSuffix(name, "SHAM") ||
		strings.HasSuffix(name, "WITCH") {
		return CategoryKey{"30", "Magic users (mages, priests, necromancers)"}
	}
	if tokens["SIEGE"] || tokens["CATAPULT"] || tokens["TREBUCHET"] ||
		strings.HasSuffix(name, "TRE") || strings.HasSuffix(name, "SSH") ||
		strings.HasSuffix(name, "CAT") {
		return CategoryKey{"40", "Siege weapons"}
	}
	if tokens["FLYING"] || tokens["DRAGON"] || tokens["FLY"] ||
		strings.HasSuffix(name, "DRAG") || strings.HasSuffix(name, "FLY") ||
		strings.HasSuffix(name, "WING") {
		return CategoryKey{"50", "Flying units"}
	}
	if tokens["NAVAL"] || tokens["BOAT"] || tokens["SHIP"] ||
		strings.HasSuffix(name, "NAVY") || strings.HasSuffix(name, "SHIP") ||
		strings.HasSuffix(name, "BOAT") {
		return CategoryKey{"60", "Naval units"}
	}
	if tokens["CAVALRY"] || tokens["MOUNTED"] || tokens["KNIGHT"] ||
		strings.HasSuffix(name, "KNIG") || strings.HasSuffix(name, "RIDE") ||
		strings.HasSuffix(name, "CAV") {
		return CategoryKey{"70", "Cavalry & mounted"}
	}
	if tokens["INFANTRY"] || tokens["MELEE"] || tokens["ATTACK"] ||
		tokens["BALLISTIC"] || tokens["MISSILE"] {
		return CategoryKey{"80", "Infantry & soldiers"}
	}
	if tokens["MONSTER"] || strings.HasPrefix(name, "MON") {
		return CategoryKey{"90", "Monsters & creatures"}
	}
	return CategoryKey{"95", "Other"}
}

// BuilderTierTAK is the build-tree tier for a TA:K builder.
// TA:K's build hierarchy is broadly: monarch → castle/keep → unit
// trainers (academies, churches, stables, etc.).
func BuilderTierTAK(b string, units map[string]Unit) CategoryKey {
	upper := strings.ToUpper(b)
	if strings.HasSuffix(upper, "KING") || strings.HasSuffix(upper, "LIEGE") ||
		strings.HasSuffix(upper, "HAND") || strings.HasSuffix(upper, "LORD") ||
		strings.HasSuffix(upper, "FLAG") {
		return CategoryKey{"1", "Monarch"}
	}
	if strings.HasSuffix(upper, "CASTL") || strings.HasSuffix(upper, "KEEP") {
		return CategoryKey{"2", "Castle & keep"}
	}
	if strings.HasSuffix(upper, "BUILD") {
		return CategoryKey{"3", "Builders"}
	}
	if strings.HasSuffix(upper, "PRIES") || strings.HasSuffix(upper, "PRIE2") ||
		strings.HasSuffix(upper, "MAGE") || strings.HasSuffix(upper, "NECRO") ||
		strings.HasSuffix(upper, "SHAM") || strings.HasSuffix(upper, "HURT") {
		return CategoryKey{"4", "Spellcaster trainers"}
	}
	if strings.HasSuffix(upper, "FLY") {
		return CategoryKey{"5", "Aerial trainers"}
	}
	return CategoryKey{"8", "Other trainers"}
}

func hasSuffix(s string, suffixes ...string) bool {
	for _, sfx := range suffixes {
		if strings.HasSuffix(s, sfx) {
			return true
		}
	}
	return false
}
