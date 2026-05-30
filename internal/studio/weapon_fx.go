package studio

import (
	"net/http"
	"net/url"
	"strings"
	"sync"

	"github.com/coreprime/kbot/formats/tdf"
)

// weapon_fx.go
//
// /api/studio/weapon-fx/{weapon}/{variant} — serves the real TA
// explosion animation for a named weapon as an APNG.  variant is one of
// "ground" / "water" / "lava"; the handler resolves the weapon TDF's
// matching ExplosionGaf+ExplosionArt (or the Water/Lava variant pair),
// then reuses renderFeatureAPNG to walk the GAF file and emit the
// frame sequence.
//
// The JS side hits this endpoint at projectile-impact time, picking the
// variant from the impact Y vs water plane.  When this endpoint 404s
// (weapon has no explosion art shipped, or the GAF resolves to nothing)
// the client falls back to its synthetic particle cluster.
//
// Death-FX path: a unit's FBI ExplodeAs / SelfDestructAs names ANOTHER
// weapon (typically a hidden "DEATH_EXPLOSION" weapon whose only job is
// to carry the explosion art).  The client passes that resolved name
// straight through — no special handling needed here; the same
// {weapon}/{variant} route serves both projectile impacts and unit
// deaths.

// Cache keyed by "WEAPON|VARIANT".  We don't expire — explosion APNGs
// are immutable assets, the server's lifetime caches them once.
var (
	weaponFxMu    sync.Mutex
	weaponFxCache = map[string][]byte{}
	// Sentinel value stored in the cache for keys we've tried to
	// resolve and confirmed have no shipped explosion art.  Avoids
	// re-walking the VFS on every miss.
	weaponFxMissSentinel = []byte{}
)

// handleWeaponFx serves the GAF animation as APNG.  Returns 404 when:
//   - the weapon name doesn't resolve to a known TDF section, or
//   - the weapon has no explosion gaf/art shipped for the requested
//     variant (and no ground fallback), or
//   - the GAF file or sequence isn't in the VFS.
// Caches both hits and misses so a flurry of explosions doesn't
// re-walk the weapon table 100×.
func handleWeaponFx(w http.ResponseWriter, r *http.Request) {
	rest := strings.TrimPrefix(r.URL.Path, "/api/studio/weapon-fx/")
	if rest == "" {
		http.Error(w, "missing weapon/variant", http.StatusBadRequest)
		return
	}
	parts := strings.SplitN(rest, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		http.Error(w, "expected /weapon-fx/{name}/{variant}", http.StatusBadRequest)
		return
	}
	name, err := url.PathUnescape(parts[0])
	if err != nil || name == "" {
		http.Error(w, "bad weapon name", http.StatusBadRequest)
		return
	}
	variant := strings.ToLower(strings.TrimSpace(parts[1]))
	switch variant {
	case "ground", "water", "lava":
		// ok
	default:
		http.Error(w, "variant must be ground|water|lava", http.StatusBadRequest)
		return
	}
	key := strings.ToUpper(strings.TrimSpace(name)) + "|" + variant

	// Cache check — both hits AND known-misses live here, so an
	// unresolvable weapon doesn't pay the lookup cost twice.
	weaponFxMu.Lock()
	if cached, ok := weaponFxCache[key]; ok {
		weaponFxMu.Unlock()
		if len(cached) == 0 {
			http.Error(w, "weapon has no explosion art", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "image/apng")
		w.Header().Set("Cache-Control", "public, max-age=86400")
		_, _ = w.Write(cached)
		return
	}
	weaponFxMu.Unlock()

	// Resolve the weapon's TDF section + the variant's GAF refs.
	sec := loadWeaponSection(name)
	if sec == nil {
		_cacheWeaponFxMiss(key)
		http.Error(w, "weapon not found", http.StatusNotFound)
		return
	}
	gafName, artName := weaponExplosionRefs(sec, variant)
	if gafName == "" || artName == "" {
		_cacheWeaponFxMiss(key)
		http.Error(w, "weapon has no explosion art for variant", http.StatusNotFound)
		return
	}

	// Reuse the feature renderer's GAF→APNG path.  Same palette, same
	// frame walk, same encoder — keeps every cinematic animation in
	// the project on one codepath.
	apng, err := renderFeatureAPNG(gafName, artName)
	if err != nil {
		_cacheWeaponFxMiss(key)
		http.Error(w, err.Error(), http.StatusNotFound)
		return
	}
	weaponFxMu.Lock()
	weaponFxCache[key] = apng
	weaponFxMu.Unlock()
	w.Header().Set("Content-Type", "image/apng")
	w.Header().Set("Cache-Control", "public, max-age=86400")
	_, _ = w.Write(apng)
}

// weaponExplosionRefs returns (gafFilename, sequenceName) for the named
// variant — falling back to the ground pair when the water/lava variant
// is unset on the weapon.  TA's stock weapons frequently only ship the
// ground explosion and let the engine reuse it everywhere; we copy that
// behaviour so a missile splashing into water still produces SOME
// animation rather than no-op.
func weaponExplosionRefs(sec *tdf.Section, variant string) (string, string) {
	gafKey := "explosiongaf"
	artKey := "explosionart"
	switch variant {
	case "water":
		gafKey = "waterexplosiongaf"
		artKey = "waterexplosionart"
	case "lava":
		gafKey = "lavaexplosiongaf"
		artKey = "lavaexplosionart"
	}
	gaf := strings.ToLower(strings.TrimSpace(sec.String(gafKey)))
	art := strings.ToLower(strings.TrimSpace(sec.String(artKey)))
	if (gaf == "" || art == "") && variant != "ground" {
		// Variant-specific art missing — fall back to the ground pair
		// so the impact still animates.  Matches TA's runtime
		// behaviour of "use ground if water/lava isn't set".
		gaf = strings.ToLower(strings.TrimSpace(sec.String("explosiongaf")))
		art = strings.ToLower(strings.TrimSpace(sec.String("explosionart")))
	}
	return gaf, art
}

func _cacheWeaponFxMiss(key string) {
	weaponFxMu.Lock()
	weaponFxCache[key] = weaponFxMissSentinel
	weaponFxMu.Unlock()
}
