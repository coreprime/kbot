// Package objects3d implements reading of Total Annihilation 3DO model files.
//
// 3DO files contain hierarchical 3D objects with vertices, primitives
// (points, lines, triangles, quads), and texture references.
package objects3d

import (
	"encoding/binary"
	"fmt"
	"io"
)

// rawObject is the on-disk 52-byte object header.
type rawObject struct {
	VersionSignature       int32
	NumberOfVertexes       int32
	NumberOfPrimitives     int32
	OffsetToSelectionPrim  int32
	XFromParent            int32
	YFromParent            int32
	ZFromParent            int32
	OffsetToObjectName     int32
	Always0                int32
	OffsetToVertexArray    int32
	OffsetToPrimitiveArray int32
	OffsetToSiblingObject  int32
	OffsetToChildObject    int32
}

// rawPrimitive is the on-disk 32-byte primitive header.
type rawPrimitive struct {
	ColorIndex              int32
	NumberOfVertexIndexes   int32
	Always0                 int32
	OffsetToVertexIndexArray int32
	OffsetToTextureName     int32
	Unknown1                int32
	Unknown2                int32
	IsColored               int32
}

// Vertex is a 3D point (fixed-point integers).
type Vertex struct {
	X, Y, Z int32
}

// Primitive is a rendered face/line/point.
type Primitive struct {
	ColorIndex    int
	VertexIndices []int
	TextureName   string
	IsColored     bool
}

// Object is a node in the 3DO hierarchy.
type Object struct {
	Name          string
	Vertices      []Vertex
	Primitives    []Primitive
	XFromParent   int32
	YFromParent   int32
	ZFromParent   int32
	SelectionPrim int32
	Children      []*Object
}

// Model is the root of a parsed 3DO file.
type Model struct {
	Root       *Object
	AllObjects []*Object // flattened list of all objects
}

// TotalVertices returns the total vertex count across all objects.
func (m *Model) TotalVertices() int {
	n := 0
	for _, o := range m.AllObjects {
		n += len(o.Vertices)
	}
	return n
}

// TotalPrimitives returns the total primitive count across all objects.
func (m *Model) TotalPrimitives() int {
	n := 0
	for _, o := range m.AllObjects {
		n += len(o.Primitives)
	}
	return n
}

// Textures returns the unique texture names used across all objects.
func (m *Model) Textures() []string {
	seen := make(map[string]bool)
	var textures []string
	for _, o := range m.AllObjects {
		for _, p := range o.Primitives {
			if p.TextureName != "" && !seen[p.TextureName] {
				seen[p.TextureName] = true
				textures = append(textures, p.TextureName)
			}
		}
	}
	return textures
}

// LoadFromReader parses a 3DO file.
func LoadFromReader(r io.ReadSeeker) (*Model, error) {
	m := &Model{}

	// Read the root object at offset 0.
	if _, err := r.Seek(0, io.SeekStart); err != nil {
		return nil, err
	}
	var raw rawObject
	if err := binary.Read(r, binary.LittleEndian, &raw); err != nil {
		return nil, fmt.Errorf("read root object: %w", err)
	}
	root, err := readObjectAt(r, 0, &raw)
	if err != nil {
		return nil, err
	}
	m.Root = root

	// Flatten the tree.
	var flatten func(o *Object)
	flatten = func(o *Object) {
		m.AllObjects = append(m.AllObjects, o)
		for _, c := range o.Children {
			flatten(c)
		}
	}
	flatten(root)

	return m, nil
}

// readObjectChain reads an object and follows its sibling chain.
func readObjectChain(r io.ReadSeeker, offset int64) ([]*Object, error) {
	var objects []*Object
	visited := make(map[int64]bool)

	for offset > 0 && !visited[offset] {
		visited[offset] = true

		if _, err := r.Seek(offset, io.SeekStart); err != nil {
			break
		}

		var raw rawObject
		if err := binary.Read(r, binary.LittleEndian, &raw); err != nil {
			break
		}

		obj, err := readObjectAt(r, offset, &raw)
		if err != nil {
			break
		}
		objects = append(objects, obj)

		offset = int64(raw.OffsetToSiblingObject)
	}
	return objects, nil
}

// readObjectAt reads a single object given an already-read raw header.
func readObjectAt(r io.ReadSeeker, offset int64, raw *rawObject) (*Object, error) {
	obj := &Object{
		XFromParent:   raw.XFromParent,
		YFromParent:   raw.YFromParent,
		ZFromParent:   raw.ZFromParent,
		SelectionPrim: raw.OffsetToSelectionPrim,
	}

	if raw.OffsetToObjectName > 0 {
		obj.Name = readString(r, int64(raw.OffsetToObjectName))
	}

	// Read vertices.
	if raw.NumberOfVertexes > 0 && raw.OffsetToVertexArray > 0 {
		if _, err := r.Seek(int64(raw.OffsetToVertexArray), io.SeekStart); err == nil {
			obj.Vertices = make([]Vertex, raw.NumberOfVertexes)
			_ = binary.Read(r, binary.LittleEndian, obj.Vertices)
		}
	}

	// Read primitives.
	if raw.NumberOfPrimitives > 0 && raw.OffsetToPrimitiveArray > 0 {
		obj.Primitives = make([]Primitive, 0, raw.NumberOfPrimitives)
		for i := int32(0); i < raw.NumberOfPrimitives; i++ {
			primOffset := int64(raw.OffsetToPrimitiveArray) + int64(i)*32
			if _, err := r.Seek(primOffset, io.SeekStart); err != nil {
				break
			}
			var rp rawPrimitive
			if err := binary.Read(r, binary.LittleEndian, &rp); err != nil {
				break
			}

			p := Primitive{
				ColorIndex: int(rp.ColorIndex),
				IsColored:  rp.IsColored != 0,
			}

			if rp.OffsetToTextureName > 0 {
				p.TextureName = readString(r, int64(rp.OffsetToTextureName))
			}

			if rp.NumberOfVertexIndexes > 0 && rp.OffsetToVertexIndexArray > 0 {
				if _, err := r.Seek(int64(rp.OffsetToVertexIndexArray), io.SeekStart); err == nil {
					indices := make([]int16, rp.NumberOfVertexIndexes)
					if err := binary.Read(r, binary.LittleEndian, indices); err == nil {
						p.VertexIndices = make([]int, len(indices))
						for j, idx := range indices {
							p.VertexIndices[j] = int(idx)
						}
					}
				}
			}

			obj.Primitives = append(obj.Primitives, p)
		}
	}

	// Read children.
	if raw.OffsetToChildObject > 0 {
		children, err := readObjectChain(r, int64(raw.OffsetToChildObject))
		if err == nil {
			obj.Children = children
		}
	}

	return obj, nil
}

func readString(r io.ReadSeeker, offset int64) string {
	if _, err := r.Seek(offset, io.SeekStart); err != nil {
		return ""
	}
	var buf [256]byte
	n, _ := r.Read(buf[:])
	for i := 0; i < n; i++ {
		if buf[i] == 0 {
			return string(buf[:i])
		}
	}
	return string(buf[:n])
}
