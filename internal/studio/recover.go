package studio

import (
	"log"
	"runtime/debug"
)

// logAssetPanic reports an asset skipped after a panic. It is a variable so
// tests can capture the message.
var logAssetPanic = func(format string, args ...any) { log.Printf(format, args...) }

// recoverAsset runs fn and reports whether it returned normally. The studio's
// background work (map catalogue, section and feature thumbnails, VFS
// warm-up, queued renders) walks every file of the install and its mods; a
// malformed file that trips a decoder must cost only that file, not the
// whole studio. A panic inside fn is logged with what was being done and the
// asset's path, then swallowed, and recoverAsset returns false so the caller
// skips the asset.
func recoverAsset(what, path string, fn func()) (ok bool) {
	defer func() {
		if r := recover(); r != nil {
			logAssetPanic("studio: %s %s: skipped after a panic: %v\n%s", what, path, r, debug.Stack())
			ok = false
		}
	}()
	fn()
	return true
}

// recoverPreload ends the asset preload after a panic outside any one
// asset's work (listing features, sections, …): the map catalogue is marked
// ready with the maps read so far and the progress tracker finishes, so the
// UI stops waiting instead of the process exiting.
func (sess *Session) recoverPreload() {
	r := recover()
	if r == nil {
		return
	}
	logAssetPanic("studio: asset preload stopped after a panic: %v\n%s", r, debug.Stack())
	sess.mapCatalog.mu.Lock()
	sess.mapCatalog.ready = true
	sess.mapCatalog.mu.Unlock()
	sess.preloadProgress.finish()
}
