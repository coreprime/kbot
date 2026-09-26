package studio

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"

	"github.com/coreprime/kbot-engine/engine/fixed"
	"github.com/coreprime/kbot-engine/engine/sim"
	"github.com/coreprime/kbot-io/filesystem"
	"github.com/coreprime/kbot-io/testutil"
)

// unitMeta builds /api/studio/unit/{name} for a retail unit.
func unitMeta(t *testing.T, sess *Session, name string) *unitMetaJSON {
	t.Helper()
	m, err := sess.buildUnitMeta(name, [3]string{})
	if err != nil {
		t.Fatalf("buildUnitMeta(%s): %v", name, err)
	}
	return m
}

// TestUnitMetaStandingOrders: the game reads a missing standing order as 2
// and keeps an explicit value's low two bits, so the commanders start on Hold
// Position and the Lancet-style units on Hold Fire; the meta always sends both.
func TestUnitMetaStandingOrders(t *testing.T) {
	sess := mountVFSForTest(t)
	for _, tc := range []struct {
		unit       string
		move, fire int
	}{
		{"armcom", 0, 2},   // StandingMoveOrder=0: Hold Position
		{"corcom", 0, 2},   // likewise
		{"armvader", 1, 0}, // StandingFireOrder=0: Hold Fire
		{"armlance", 1, 0},
		{"armsolar", 2, 2}, // no keys: Roam / Fire at Will
	} {
		m := unitMeta(t, sess, tc.unit)
		if m.StandingMoveOrder == nil || m.StandingFireOrder == nil {
			t.Fatalf("%s: orders left out, want both sent", tc.unit)
		}
		if *m.StandingMoveOrder != tc.move || *m.StandingFireOrder != tc.fire {
			t.Errorf("%s: orders %d/%d, want %d/%d", tc.unit, *m.StandingMoveOrder, *m.StandingFireOrder, tc.move, tc.fire)
		}
	}
	body, err := json.Marshal(unitMeta(t, sess, "armcom"))
	if err != nil {
		t.Fatal(err)
	}
	for _, want := range []string{`"standingMoveOrder":0`, `"standingFireOrder":2`} {
		if !strings.Contains(string(body), want) {
			t.Errorf("armcom JSON lacks %s (an explicit Hold must not be omitted)", want)
		}
	}
}

// TestUnitMetaStandingOrdersTAK: TA: Kingdoms units keep the sim's spawn
// default for an order their FBI leaves out or sets to 0. The meta sends only
// a non-zero FBI value, so the sandbox's spawn Hold (which a TA meta's 0
// asks for) never reaches a Kingdoms unit.
func TestUnitMetaStandingOrdersTAK(t *testing.T) {
	sess := mountTAKForTest(t)
	arch := unitMeta(t, sess, "araarch")
	if arch.StandingMoveOrder != nil || arch.StandingFireOrder != nil {
		t.Errorf("araarch orders %v/%v, want both left out", arch.StandingMoveOrder, arch.StandingFireOrder)
	}
	body, err := json.Marshal(arch)
	if err != nil {
		t.Fatal(err)
	}
	for _, key := range []string{`"standingMoveOrder"`, `"standingFireOrder"`} {
		if strings.Contains(string(body), key) {
			t.Errorf("araarch JSON carries %s; a Kingdoms unit without the key must leave it out", key)
		}
	}
	// lifcow's FBI says standingmoveorder = 2: an explicit non-zero value is
	// sent as it stands.
	cow := unitMeta(t, sess, "lifcow")
	if cow.StandingMoveOrder == nil || *cow.StandingMoveOrder != 2 || cow.StandingFireOrder != nil {
		t.Errorf("lifcow orders %v/%v, want 2 and left out", cow.StandingMoveOrder, cow.StandingFireOrder)
	}
}

// mountTAKForTest opens a session on the TA: Kingdoms test install.
func mountTAKForTest(t *testing.T) *Session {
	t.Helper()
	v, err := filesystem.NewVirtualFileSystem(testutil.TAKUnpackedPath(t), studioFSConfig())
	if err != nil {
		t.Fatalf("mount TA:K VFS: %v", err)
	}
	t.Cleanup(func() { _ = v.Close() })
	sess := newSession("test", "test", v, t.TempDir())
	sess.game = "takingdoms"
	return sess
}

// TestUnitMetaMovementClass: a unit naming a movement class takes all of the
// class's footprint, depth and slope values, with the game's defaults for keys
// the class leaves out; a unit without one reads its own keys the same way.
func TestUnitMetaMovementClass(t *testing.T) {
	sess := mountVFSForTest(t)
	for _, tc := range []struct {
		unit               string
		fx, fz             int
		maxDepth, minDepth int
		maxSlope           int
	}{
		// TANKDS2: 2x2, MaxWaterDepth=100, MaxSlope=32 (the FBI's 35/20 lose).
		{"armcom", 2, 2, 100, -10000, 32},
		// TANKHOVER3 has no MaxWaterDepth: 10000, whatever the FBI's 0 says.
		{"armch", 3, 3, 10000, -10000, 12},
		{"corch", 3, 3, 10000, -10000, 12},
		// No class: the FBI's explicit MaxWaterDepth=0 keeps it on land.
		{"armsolar", 5, 5, 0, -10000, 10},
	} {
		m := unitMeta(t, sess, tc.unit)
		if m.FootprintX != tc.fx || m.FootprintZ != tc.fz || m.MaxWaterDepth != tc.maxDepth ||
			m.MinWaterDepth != tc.minDepth || m.MaxSlope != tc.maxSlope {
			t.Errorf("%s: footprint %dx%d depth %d..%d slope %d; want %dx%d depth %d..%d slope %d",
				tc.unit, m.FootprintX, m.FootprintZ, m.MinWaterDepth, m.MaxWaterDepth, m.MaxSlope,
				tc.fx, tc.fz, tc.minDepth, tc.maxDepth, tc.maxSlope)
		}
	}
	body, _ := json.Marshal(unitMeta(t, sess, "armsolar"))
	if !strings.Contains(string(body), `"maxWaterDepth":0`) {
		t.Errorf("armsolar JSON lacks an explicit maxWaterDepth 0")
	}
}

// TestUnitMetaMatchesHostMeta: the browser sim builds a unit from the
// /api/studio/unit JSON while the hosted match's authority builds it from the
// FBI; both must carry the same footprint, terrain limits, standing orders,
// reload ticks and splash box, or a hosted match drifts out of lockstep.
func TestUnitMetaMatchesHostMeta(t *testing.T) {
	sess := mountVFSForTest(t)
	spawn := sess.vfsSpawnFunc()
	for _, name := range []string{"armcom", "corcom", "armch", "armvader", "corpyro", "armsolar", "armpw", "armmh", "armaas"} {
		j := unitMeta(t, sess, name)
		h, _ := spawn(name)
		if h == nil {
			t.Fatalf("host meta for %s is nil", name)
		}
		if h.FootprintX != j.FootprintX || h.FootprintZ != j.FootprintZ || h.MaxWaterDepth != j.MaxWaterDepth ||
			h.MinWaterDepth != j.MinWaterDepth || h.MaxSlope != j.MaxSlope {
			t.Errorf("%s: host footprint %dx%d depth %d..%d slope %d; JSON %dx%d depth %d..%d slope %d", name,
				h.FootprintX, h.FootprintZ, h.MinWaterDepth, h.MaxWaterDepth, h.MaxSlope,
				j.FootprintX, j.FootprintZ, j.MinWaterDepth, j.MaxWaterDepth, j.MaxSlope)
		}
		if j.StandingMoveOrder == nil || j.StandingFireOrder == nil {
			t.Errorf("%s: JSON leaves out a standing order", name)
		} else if int(h.StandMove) != *j.StandingMoveOrder || int(h.StandFire) != *j.StandingFireOrder {
			t.Errorf("%s: host orders %d/%d, JSON %d/%d", name, h.StandMove, h.StandFire, *j.StandingMoveOrder, *j.StandingFireOrder)
		}
		if h.CombatBoxHalfX != fixed.FromInt(j.FootprintX*4) || h.CombatBoxHalfZ != fixed.FromInt(j.FootprintZ*4) {
			t.Errorf("%s: host splash box does not follow the JSON footprint", name)
		}
		if want := sim.ParseYardMap(j.YardMap, j.FootprintX, j.FootprintZ); !reflect.DeepEqual(h.Yard, want) {
			t.Errorf("%s: host yard grid differs from the one the JSON yields", name)
		}
		for i, w := range j.Weapons {
			if w.Name == "" || !h.Weapons[i].Present {
				continue
			}
			if h.Weapons[i].ReloadTicks != w.ReloadTicks {
				t.Errorf("%s slot %d: host reload %d ticks, JSON %d", name, i+1, h.Weapons[i].ReloadTicks, w.ReloadTicks)
			}
			if h.Weapons[i].Range != fixed.FromFloat(w.RangeWU) {
				t.Errorf("%s slot %d: host range differs from JSON rangeWU %v", name, i+1, w.RangeWU)
			}
		}
	}
}

// TestUnitMetaWeaponTable: weapons resolve through the game's ID table and
// carry resolved values.
func TestUnitMetaWeaponTable(t *testing.T) {
	sess := mountVFSForTest(t)
	com := unitMeta(t, sess, "armcom")
	laser := com.Weapons[0]
	if laser.Name != "ARMCOMLASER" || laser.WeaponID != 20 {
		t.Fatalf("armcom weapon1 = %s id %d, want ARMCOMLASER id 20", laser.Name, laser.WeaponID)
	}
	if want := int(laser.ReloadSec * 30); laser.ReloadTicks != want || want == 0 {
		t.Fatalf("ARMCOMLASER reload %d ticks, want %d (reloadtime*30 truncated)", laser.ReloadTicks, want)
	}
	if laser.MinBarrelAngle != -11.25 {
		t.Errorf("ARMCOMLASER minBarrelAngle %v, want the game's -11.25 for a weapon without the key", laser.MinBarrelAngle)
	}
	// Death blasts carry the per-unit [DAMAGE] entries: a Pyro takes 15 from
	// its own blast, not the default 60.
	pyro := unitMeta(t, sess, "corpyro")
	if pyro.ExplodeWeapon == nil || pyro.ExplodeWeapon.Damage != 60 || pyro.ExplodeWeapon.DamageTable["corpyro"] != 15 {
		t.Fatalf("corpyro explodeWeapon = %+v, want default 60 and corpyro 15", pyro.ExplodeWeapon)
	}

	list := sess.buildWeaponsList()
	seen := map[string]bool{}
	for _, w := range list {
		if seen[w.Name] {
			t.Fatalf("weapon catalogue lists %s twice", w.Name)
		}
		seen[w.Name] = true
		if w.WeaponID < 0 || w.WeaponID > 255 {
			t.Fatalf("%s has weapon id %d outside the table", w.Name, w.WeaponID)
		}
		if found, slot := sess.weaponTable().Find(w.Name); found == nil || slot != w.WeaponID {
			t.Fatalf("catalogue entry %s (id %d) is not the weapon the name resolves to (slot %d)", w.Name, w.WeaponID, slot)
		}
	}
	if !seen["ARMCOMLASER"] || !seen["EMG"] {
		t.Fatalf("catalogue lacks retail weapons (%d entries)", len(list))
	}
}

// TestUnitMetaSoundEvents: the unit viewer's sound map holds every event the
// game reads, the commanders' cloak, uncloak and capture included.
func TestUnitMetaSoundEvents(t *testing.T) {
	sess := mountVFSForTest(t)
	m := unitMeta(t, sess, "armcom")
	for _, key := range []string{"select1", "ok1", "cloak", "uncloak", "capture", "count0", "canceldestruct"} {
		if m.Sounds[key] == "" {
			t.Errorf("armcom sounds lack %s: %v", key, m.Sounds)
		}
	}
}

func TestGameSoundKeys(t *testing.T) {
	got := gameSoundKeys(map[string]string{
		"select": "Sel", "select1": "a", "select3": "skipped", // select2 missing: stop
		"ok1": "b", "ok2": "", // an empty value is a silent choice
		"load": "l", "unload1": "u", "cloak": "c", "uncloak": "d", "capture": "e",
		"arrived2":    "unreached", // no arrived1: nothing
		"select1text": "x", "weird": "y",
	})
	want := map[string]string{
		"select": "sel", "select1": "a", "ok1": "b", "ok2": "",
		"load": "l", "unload1": "u", "cloak": "c", "uncloak": "d", "capture": "e",
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("gameSoundKeys = %v\nwant %v", got, want)
	}
	if gameSoundKeys(map[string]string{"weird": "y"}) != nil || gameSoundKeys(nil) != nil {
		t.Fatalf("no playable keys should give nil")
	}
}
