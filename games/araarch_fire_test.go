package games_test

import (
	"bytes"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/coreprime/kbot/engine/fixed"
	"github.com/coreprime/kbot/engine/frame"
	"github.com/coreprime/kbot/engine/order"
	"github.com/coreprime/kbot/engine/script"
	"github.com/coreprime/kbot/engine/sim"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/scripting"
	"github.com/coreprime/kbot/formats/tdf"
	"github.com/coreprime/kbot/games"
)

// TestTAKArcherFiresWithRealMeta reproduces the sandbox setup exactly: the
// archer's UnitMeta built from its real FBI (inline TA:K weapons) and its
// retail COB, attacking a target 40wu away.
func TestTAKArcherFiresWithRealMeta(t *testing.T) {
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("set TAK_UNPACKED_PATH")
	}
	fbi, err := os.ReadFile(filepath.Join(root, "units", "araarch.fbi"))
	if err != nil {
		t.Fatal(err)
	}
	resolve := func(ref string) (ta.Weapon, bool) {
		// TA:K has no weapons/*.tdf refs for these units; weapons are inline.
		entries, _ := os.ReadDir(filepath.Join(root, "weapons"))
		for _, e := range entries {
			if e.IsDir() || !strings.HasSuffix(strings.ToLower(e.Name()), ".tdf") {
				continue
			}
			data, err := os.ReadFile(filepath.Join(root, "weapons", e.Name()))
			if err != nil {
				continue
			}
			var ws []ta.Weapon
			if err := tdf.Unmarshal(data, &ws); err != nil {
				continue
			}
			for _, w := range ws {
				if strings.EqualFold(w.Key, ref) {
					return w, true
				}
			}
		}
		return ta.Weapon{}, false
	}
	meta, err := games.UnitMetaFromFBI("araarch", fbi, resolve)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("weapons[0]: %+v", meta.Weapons[0])

	rt := script.NewRuntime(41)
	data, err := os.ReadFile(filepath.Join(root, "scripts", "araarch.cob"))
	if err != nil {
		t.Fatal(err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatal(err)
	}
	bind := rt.NewUnit(prog, nil)

	w := sim.New(sim.Config{Seed: 41})
	atk := w.AddUnit("araarch", meta, bind, fixed.Vec2{}, 0, 0)
	defMeta := &sim.UnitMeta{Name: "def", CanMove: true, MaxVelocity: fixed.FromFloat(1.2), TurnRate: fixed.FromInt(600), Accel: fixed.FromFloat(0.1), BrakeRate: fixed.FromFloat(0.2)}
	def := w.AddUnit("def", defMeta, nil, fixed.Vec2{X: fixed.FromInt(40)}, 0, 1)
	w.ApplyOrder(order.Attack([]uint32{atk}, def))

	fires := 0
	for i := 0; i < 900; i++ {
		w.Step(rt)
		for _, ev := range w.Snapshot().Events {
			if ev.Kind == frame.EvFire && ev.UnitID == atk {
				fires++
			}
		}
	}
	t.Logf("fires=%d defHealth=%v", fires, w.UnitByID(def).Health)
	if fires == 0 {
		t.Fatal("archer never fired with real FBI meta")
	}
}

// TestTAKArcherForceFireAtPointSurvives drives two archers force-firing
// slot 0 at a ground point, with Move orders issued mid-aim — the order mix
// a sandbox session produces. The world must keep stepping without
// panicking.
func TestTAKArcherForceFireAtPointSurvives(t *testing.T) {
	root := os.Getenv("TAK_UNPACKED_PATH")
	if root == "" {
		t.Skip("set TAK_UNPACKED_PATH")
	}
	fbi, err := os.ReadFile(filepath.Join(root, "units", "araarch.fbi"))
	if err != nil {
		t.Fatal(err)
	}
	meta, err := games.UnitMetaFromFBI("araarch", fbi, func(string) (ta.Weapon, bool) { return ta.Weapon{}, false })
	if err != nil {
		t.Fatal(err)
	}

	rt := script.NewRuntime(43)
	data, err := os.ReadFile(filepath.Join(root, "scripts", "araarch.cob"))
	if err != nil {
		t.Fatal(err)
	}
	cob, err := scripting.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	prog, err := script.FromCOB(cob)
	if err != nil {
		t.Fatal(err)
	}

	w := sim.New(sim.Config{Seed: 43})
	a := w.AddUnit("araarch", meta, rt.NewUnit(prog, nil), fixed.Vec2{X: fixed.FromInt(17), Z: fixed.FromInt(-14)}, 0, 0)
	b := w.AddUnit("araarch", meta, rt.NewUnit(prog, nil), fixed.Vec2{X: fixed.FromInt(-57), Z: fixed.FromInt(16)}, 0, 1)

	pt := fixed.Vec2{X: fixed.FromInt(-52), Z: fixed.FromInt(45)}
	w.ApplyOrder(order.FireAtPoint(a, 0, pt))
	w.ApplyOrder(order.FireAtPoint(b, 0, pt))
	for i := 0; i < 300; i++ {
		w.Step(rt)
		w.Snapshot()
	}
	w.ApplyOrder(order.Move([]uint32{a, b}, fixed.Vec2{X: fixed.FromInt(-20), Z: fixed.FromInt(30)}))
	for i := 0; i < 600; i++ {
		w.Step(rt)
		w.Snapshot()
	}
	w.ApplyOrder(order.FireAtPoint(a, 0, fixed.Vec2{X: fixed.FromInt(-64), Z: fixed.FromInt(65)}))
	for i := 0; i < 600; i++ {
		w.Step(rt)
		w.Snapshot()
	}
}
