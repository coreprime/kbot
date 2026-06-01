package fixed

// Vec2 is a planar (X, Z) coordinate — the ground plane the simulation moves
// units across. Y (height) is tracked separately on units.
type Vec2 struct {
	X, Z Fixed
}

// Add returns a + b.
func (a Vec2) Add(b Vec2) Vec2 { return Vec2{a.X + b.X, a.Z + b.Z} }

// Sub returns a - b.
func (a Vec2) Sub(b Vec2) Vec2 { return Vec2{a.X - b.X, a.Z - b.Z} }

// Len returns the vector length.
func (a Vec2) Len() Fixed { return Hypot(a.X, a.Z) }

// DistTo returns the distance from a to b.
func (a Vec2) DistTo(b Vec2) Fixed { return a.Sub(b).Len() }

// Vec3 is a full world-space coordinate with Y pointing up.
type Vec3 struct {
	X, Y, Z Fixed
}

// XZ projects a Vec3 onto the ground plane.
func (a Vec3) XZ() Vec2 { return Vec2{a.X, a.Z} }
