package studio

import (
	"bytes"
	"path"
	"sort"
	"strings"
	"sync"
	"sync/atomic"

	"github.com/coreprime/kbot-io/formats/gaf"
	"github.com/coreprime/kbot-io/formats/smacker"
	"github.com/coreprime/kbot/internal/assetrender"
)

// vfsWarmMaxBytes caps the file size the warmer will touch. Anything larger is
// left to lazy on-demand rendering so a single huge asset can't stall startup.
const vfsWarmMaxBytes = 64 * 1024 * 1024

// vfsWarmFile is one asset the warmer plans to pre-render.
type vfsWarmFile struct {
	path     string
	size     int64
	fileType string
}

// warmState tracks aggregate progress shared across warm jobs.
type warmState struct {
	total     atomic.Int64
	processed atomic.Int64
	cached    atomic.Int64
}

// startVFSWarm scans the mounted VFS for renderable assets and pre-generates
// their cached representations in the background, publishing progress over the
// vfs event hub. It returns immediately; the actual work runs on the shared
// asset queue so it competes politely with on-demand render requests.
func (sess *Session) startVFSWarm() {
	if sess.vfs == nil || sess.renderer == nil {
		return
	}
	go sess.runVFSWarm()
}

func (sess *Session) runVFSWarm() {
	files := sess.collectWarmFiles("")
	if len(files) == 0 {
		return
	}

	// Cheap, non-video assets first (and smallest within a group) so the UI
	// fills in quickly before the slow ffmpeg transcodes run.
	sort.Slice(files, func(i, j int) bool {
		iv, jv := files[i].fileType == "video", files[j].fileType == "video"
		if iv != jv {
			return !iv
		}
		return files[i].size < files[j].size
	})

	st := &warmState{}
	st.total.Store(int64(len(files)))
	sess.vfsEvents.publish(vfsWarmEvent{Type: "start", Total: st.total.Load()})

	q := sess.getAssetQueue()
	var wg sync.WaitGroup
	for _, f := range files {
		f := f
		wg.Add(1)
		q.Submit(priorityLow, func() {
			defer wg.Done()
			cached := sess.warmOne(f)
			st.cached.Add(cached)
			processed := st.processed.Add(1)
			sess.vfsEvents.publish(vfsWarmEvent{
				Type:      "progress",
				FileType:  f.fileType,
				FileName:  f.path,
				Processed: processed,
				Total:     st.total.Load(),
				Cached:    st.cached.Load(),
			})
		})
	}

	go func() {
		wg.Wait()
		sess.vfsEvents.publish(vfsWarmEvent{
			Type:      "done",
			Processed: st.processed.Load(),
			Total:     st.total.Load(),
			Cached:    st.cached.Load(),
		})
	}()
}

// collectWarmFiles walks the VFS from dir and returns every file whose
// extension maps to a render representation, skipping directories and anything
// over the size cap.
func (sess *Session) collectWarmFiles(dir string) []vfsWarmFile {
	names, err := sess.vfs.ListDir(dir)
	if err != nil {
		return nil
	}
	videoOK := smacker.FFmpegAvailable()

	var out []vfsWarmFile
	for _, name := range names {
		full := path.Join(dir, name)
		if sess.vfs.IsDir(full) {
			out = append(out, sess.collectWarmFiles(full)...)
			continue
		}
		ft := warmFileType(strings.ToLower(path.Ext(name)), videoOK)
		if ft == "" {
			continue
		}
		info, err := sess.vfs.Stat(full)
		if err != nil || info.Size > vfsWarmMaxBytes {
			continue
		}
		out = append(out, vfsWarmFile{path: full, size: info.Size, fileType: ft})
	}
	return out
}

// warmFileType classifies an extension into a warm category, or "" when the
// extension has no pre-renderable representation.
func warmFileType(ext string, videoOK bool) string {
	switch ext {
	case ".gaf":
		return "gaf"
	case ".pcx":
		return "pcx"
	case ".tnt":
		return "tnt"
	case ".sct":
		return "sct"
	case ".pal":
		return "pal"
	case ".fnt":
		return "fnt"
	case ".smk", ".zrb", ".bik":
		if videoOK {
			return "video"
		}
	}
	return ""
}

// warmOne renders and caches the representations for a single file, returning
// how many representations were successfully produced. Errors are swallowed:
// an asset that fails to warm simply stays available via on-demand rendering.
func (sess *Session) warmOne(f vfsWarmFile) int64 {
	data, err := sess.vfs.ReadFile(f.path)
	if err != nil {
		return 0
	}

	var reqs []assetrender.RenderRequest
	switch f.fileType {
	case "gaf":
		reqs = gafWarmRequests(data)
	case "pcx":
		reqs = []assetrender.RenderRequest{{Format: "png"}}
	case "pal":
		reqs = []assetrender.RenderRequest{{Format: "png"}}
	case "fnt":
		reqs = []assetrender.RenderRequest{{}} // default sheet
	case "tnt", "sct":
		reqs = []assetrender.RenderRequest{
			{View: "minimap"}, {View: "tilemap"}, {View: "heightmap"},
		}
	case "video":
		reqs = []assetrender.RenderRequest{{Format: "mp4"}, {Format: "apng"}}
	}

	var cached int64
	for _, req := range reqs {
		if _, err := sess.renderer.Render(f.path, data, req); err == nil {
			cached++
		}
	}
	return cached
}

// gafWarmRequests builds one whole-sequence APNG request per sequence so every
// animation in the file gets a ready preview. A parse failure yields no
// requests, leaving the file to lazy rendering.
func gafWarmRequests(data []byte) []assetrender.RenderRequest {
	reader, err := gaf.LoadFromReader(bytes.NewReader(data))
	if err != nil {
		return nil
	}
	defer func() { _ = reader.Close() }()
	sequences, err := reader.ReadSequences()
	if err != nil {
		return nil
	}
	reqs := make([]assetrender.RenderRequest, 0, len(sequences))
	for i := range sequences {
		reqs = append(reqs, assetrender.RenderRequest{Sequence: i, Frame: -1, Format: "apng"})
	}
	return reqs
}
