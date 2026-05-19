package parser

// FunctionSignature defines the expected parameters for a well-known BOS function
type FunctionSignature struct {
	Name       string   // Function name (e.g., "AimPrimary")
	ParamNames []string // Parameter names in order (e.g., ["heading", "pitch"])
}

// WellKnownFunctions contains signatures for standard TA BOS functions plus
// TA: Kingdoms additions taken from Scriptor's [COMMON_FUNC] table. Entries
// register the widest known signature; the decompiler caps the rendered
// parameter count by the script's STACK_ALLOC count, so TA scripts using a
// narrower variant of a shared function (e.g. 2-arg Killed) still render
// correctly.
//
// This map is easily extensible - just add new entries for additional functions
var WellKnownFunctions = map[string]FunctionSignature{
	// Aiming functions
	"AimPrimary": {
		Name:       "AimPrimary",
		ParamNames: []string{"heading", "pitch"},
	},
	"AimSecondary": {
		Name:       "AimSecondary",
		ParamNames: []string{"heading", "pitch"},
	},
	"AimTertiary": {
		Name:       "AimTertiary",
		ParamNames: []string{"heading", "pitch"},
	},
	"AimFromPrimary": {
		Name:       "AimFromPrimary",
		ParamNames: []string{"piecenum"},
	},
	"AimFromSecondary": {
		Name:       "AimFromSecondary",
		ParamNames: []string{"piecenum"},
	},
	"AimFromTertiary": {
		Name:       "AimFromTertiary",
		ParamNames: []string{"piecenum"},
	},

	// Query functions
	"QueryPrimary": {
		Name:       "QueryPrimary",
		ParamNames: []string{"piecenum"},
	},
	"QuerySecondary": {
		Name:       "QuerySecondary",
		ParamNames: []string{"piecenum"},
	},
	"QueryTertiary": {
		Name:       "QueryTertiary",
		ParamNames: []string{"piecenum"},
	},

	// Special functions
	"SweetSpot": {
		Name:       "SweetSpot",
		ParamNames: []string{"piecenum"},
	},
	"Killed": {
		// TAK adds a third damagetype argument; TA's two-arg form is the
		// prefix of TAK's, so we register the wider TAK signature and let
		// the STACK_ALLOC cap drop the third entry for TA files.
		Name:       "Killed",
		ParamNames: []string{"severity", "corpsetype", "damagetype"},
	},
	"HitByWeapon": {
		Name:       "HitByWeapon",
		ParamNames: []string{"anglex", "anglez"},
	},
	"HitByWeaponId": {
		Name:       "HitByWeaponId",
		ParamNames: []string{"anglex", "anglez", "weaponid", "dmg"},
	},

	// Movement functions
	"StartMoving": {
		Name:       "StartMoving",
		ParamNames: []string{"reversing"},
	},
	"MoveRate": {
		Name:       "MoveRate",
		ParamNames: []string{"rate"},
	},
	"SetSpeed": {
		Name:       "SetSpeed",
		ParamNames: []string{"speed"},
	},
	"SetDirection": {
		Name:       "SetDirection",
		ParamNames: []string{"heading"},
	},

	// Building functions
	"StartBuilding": {
		Name:       "StartBuilding",
		ParamNames: []string{"heading", "pitch"},
	},
	"QueryBuildInfo": {
		Name:       "QueryBuildInfo",
		ParamNames: []string{"piecenum"},
	},
	"QueryNanoPiece": {
		Name:       "QueryNanoPiece",
		ParamNames: []string{"piecenum"},
	},

	// Transport functions
	"QueryTransport": {
		Name:       "QueryTransport",
		ParamNames: []string{"piecenum"},
	},
	"BeginTransport": {
		Name:       "BeginTransport",
		ParamNames: []string{"unitid"},
	},
	"TransportPickup": {
		Name:       "TransportPickup",
		ParamNames: []string{"unitid"},
	},
	"TransportDrop": {
		Name:       "TransportDrop",
		ParamNames: []string{"unitid", "position"},
	},

	// --- TA: Kingdoms additions --------------------------------------

	"smokeunit": {
		Name:       "smokeunit",
		ParamNames: []string{"healthpercent", "sleeptime", "smoketype"},
	},
	"smokecontrol": {
		// TAK reorders TA's smokeunit args.
		Name:       "smokecontrol",
		ParamNames: []string{"healthpercent", "smoketype", "sleeptime"},
	},
	"rockunit": {
		Name:       "rockunit",
		ParamNames: []string{"anglex", "anglez"},
	},
	"motioncontrol": {
		// TA takes (moving, aiming, justmoved); TAK uses the zero-arg
		// form. Register TA's widest signature — TAK scripts will cap to
		// zero locals via STACK_ALLOC.
		Name:       "motioncontrol",
		ParamNames: []string{"moving", "aiming", "justmoved"},
	},
	"attack1": {
		Name:       "attack1",
		ParamNames: []string{"weapon"},
	},
	"attack2": {
		Name:       "attack2",
		ParamNames: []string{"weapon"},
	},
	"attack3": {
		Name:       "attack3",
		ParamNames: []string{"weapon"},
	},
	"attack4": {
		Name:       "attack4",
		ParamNames: []string{"weapon"},
	},
	"turndirection": {
		Name:       "turndirection",
		ParamNames: []string{"dir"},
	},
	"setmaxreloadtime": {
		Name:       "setmaxreloadtime",
		ParamNames: []string{"time"},
	},
	"aimweapon": {
		Name:       "aimweapon",
		ParamNames: []string{"heading", "pitch", "weaponnum"},
	},
	"fireweapon": {
		Name:       "fireweapon",
		ParamNames: []string{"weaponnum"},
	},
	"targetcleared": {
		Name:       "targetcleared",
		ParamNames: []string{"weaponnum"},
	},
	"queryweapon": {
		Name:       "queryweapon",
		ParamNames: []string{"piecenum", "weaponnum"},
	},
	"queryblood": {
		Name:       "queryblood",
		ParamNames: []string{"piecenum"},
	},
	"dying": {
		Name:       "dying",
		ParamNames: []string{"damagetype"},
	},
	"setSFXoccupy": {
		Name:       "setSFXoccupy",
		ParamNames: []string{"state"},
	},
	"windchange": {
		Name:       "windchange",
		ParamNames: []string{"windspeed", "winddirection"},
	},
	"hitbyweapon": {
		Name:       "hitbyweapon",
		ParamNames: []string{"attacker", "pitch", "roll", "severity"},
	},
	"moverate": {
		Name:       "moverate",
		ParamNames: []string{"rate"},
	},
	"RequestState": {
		Name:       "RequestState",
		ParamNames: []string{"requestedstate", "currentstate"},
	},
	"TriggerHit": {
		Name:       "TriggerHit",
		ParamNames: []string{"Trigger_ID", "unitID", "Var_3"},
	},
	"UnitDestroyed": {
		Name:       "UnitDestroyed",
		ParamNames: []string{"unitID"},
	},
}

// GetFunctionSignature returns the signature for a well-known function, or nil if not found
func GetFunctionSignature(name string) *FunctionSignature {
	if sig, ok := WellKnownFunctions[name]; ok {
		return &sig
	}
	return nil
}

// GetParameterName returns the proper name for a parameter at the given index,
// or returns the default "local_N" name if no signature is defined
func GetParameterName(functionName string, paramIndex int) string {
	if sig := GetFunctionSignature(functionName); sig != nil {
		if paramIndex >= 0 && paramIndex < len(sig.ParamNames) {
			return sig.ParamNames[paramIndex]
		}
	}
	return ""
}
