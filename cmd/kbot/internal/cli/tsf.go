package cli

import "github.com/coreprime/kbot-io/filesystem"

// ResolveTSFInput locates a .tsf script the user named, mounting the active
// context's VFS so bare names under anims/ resolve. It returns the resolved
// input, the mounted VFS (for sibling lookups), and a cleanup function the
// caller must invoke.
func ResolveTSFInput(arg, vfsRoot string, quiet bool) (*VFSInputHit, *filesystem.VirtualFileSystem, func(), error) {
	vfs, vfsLabel, err := OpenContextVFS(vfsRoot)
	if err != nil {
		return nil, nil, func() {}, err
	}
	cleanup := func() {
		if vfs != nil {
			_ = vfs.Close()
		}
	}
	if vfs != nil && !quiet {
		ReportContextSource(vfsLabel)
	}
	hit, err := ResolveVFSInput(arg, vfs, ".tsf", []string{"anims/"})
	if err != nil {
		cleanup()
		return nil, nil, func() {}, err
	}
	return hit, vfs, cleanup, nil
}
