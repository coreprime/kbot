package parser

// FunctionSignature defines the expected parameters for a well-known BOS function
type FunctionSignature struct {
	Name       string   // Function name (e.g., "AimPrimary")
	ParamNames []string // Parameter names in order (e.g., ["heading", "pitch"])
}

// WellKnownFunctions contains signatures for standard TA BOS functions
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
		Name:       "Killed",
		ParamNames: []string{"severity", "corpsetype"},
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
