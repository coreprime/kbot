package studio

import (
	"image"
	"net/http"
	"sync"

	"github.com/coreprime/kbot/filesystem"
	"github.com/coreprime/kbot/formats/gamedata/ta"
	"github.com/coreprime/kbot/formats/tnt"
	"github.com/coreprime/kbot/internal/assetrender"
	"github.com/coreprime/kbot/internal/gameserver"
)

// Session holds all per-workspace state for a Studio instance. Each open
// workspace (or read-only context) gets its own Session: its own VFS, renderer,
// game host, and the asset caches that are keyed by VFS path (and would
// otherwise collide between workspaces that share a path but differ in content).
//
// A Session was previously a set of package-level globals; it is now a value so
// the hub can serve many workspaces from one process.
type Session struct {
	id   string
	name string
	game string

	// workspace-only: the writable work folder + export format (empty for
	// read-only context sessions).
	workDir      string
	exportFormat string

	vfs      *filesystem.VirtualFileSystem
	renderer *assetrender.Renderer
	gameHost *gameserver.Server

	// map catalog + section/feature preview caches (api.go)
	mapCatalog          *mapCatalogState
	sectionPreviewMu    sync.RWMutex
	sectionPreviewCache map[string][]byte
	preloadProgress     *preloadTracker

	tntCacheMu    sync.Mutex
	tntCache      map[string]*tnt.Map
	tntCacheOrder []string

	featureCacheMu sync.Mutex
	featureCache   map[string][]byte
	featureCacheBy map[string]featureEntry

	// decoded GAF texture images per 3DO texture name, for object previews
	objTexMu sync.Mutex
	objTex   map[string]*image.RGBA

	// Game-aware palette resolver (palette.go). Chosen once from the game id;
	// rendering paths consult the interface and never special-case the game.
	paletteOnce     sync.Once
	paletteResolver paletteResolver

	// rendered + downscaled TA:K terrain PNGs per map path (takterrain.go)
	takTerrainMu  sync.Mutex
	takTerrainPNG map[string][]byte

	scanFeaturesCacheMu sync.Mutex
	scanFeaturesList    []featureEntry
	scanFeaturesByName  map[string]featureEntry

	featureOriginCacheMu sync.Mutex
	featureOriginCache   map[string][2]int

	// model + texture caches (models.go)
	modelIndexMu   sync.Mutex
	modelIndexOnce sync.Once
	modelIndex     []modelEntry
	modelIndexByID map[string]modelEntry

	textureIndexOnce  sync.Once
	textureIndexMu    sync.Mutex
	textureIndex      map[string]textureSource
	textureCacheMu    sync.Mutex
	textureCache      map[string][]byte
	textureDecalMu    sync.Mutex
	textureDecalCache map[string]bool

	// unit/weapon caches (unit.go)
	soundTDFMu      sync.Mutex
	soundTDFOnce    sync.Once
	soundTDFClasses []ta.SoundClass

	weaponsListMu    sync.Mutex
	weaponsListOnce  sync.Once
	weaponsListCache []unitWeaponJSON

	weaponBitmapMu    sync.Mutex
	weaponBitmapCache map[string][]byte

	weaponFxMu    sync.Mutex
	weaponFxCache map[string][]byte

	// asset warm queue + VFS warm event hub
	assetQueueOnce sync.Once
	assetQueue     *AssetQueue
	vfsEvents      *vfsEventHub

	// glamour splash caches (glamour.go)
	glamourListMu sync.Mutex
	glamourList   []string
	glamourPNGMu  sync.RWMutex
	glamourPNG    map[string][]byte

	muxOnce sync.Once
	mux     *http.ServeMux
}

// routes builds (once) and returns this session's API mux. Static assets and
// the picker are served by the hub, not here.
func (sess *Session) routes() *http.ServeMux {
	sess.muxOnce.Do(func() {
		mux := http.NewServeMux()
		sess.registerAPI(mux)
		sess.registerHostAPI(mux)
		sess.registerVFSAPI(mux)
		sess.registerVFSEvents(mux)
		sess.mux = mux
	})
	return sess.mux
}

// newSession builds a Session over an already-opened VFS, initialising the
// eager caches, renderer, and event hub. Lazily-populated caches (guarded by
// sync.Once) are left nil. Call start to kick off background warming.
func newSession(id, name string, vfs *filesystem.VirtualFileSystem, cacheDir string) *Session {
	sess := &Session{
		id:                  id,
		name:                name,
		vfs:                 vfs,
		mapCatalog:          &mapCatalogState{minimaps: map[string][]byte{}},
		sectionPreviewCache: map[string][]byte{},
		preloadProgress:     &preloadTracker{},
		tntCache:            map[string]*tnt.Map{},
		featureCache:        map[string][]byte{},
		featureOriginCache:  map[string][2]int{},
		textureCache:        map[string][]byte{},
		textureDecalCache:   map[string]bool{},
		weaponBitmapCache:   map[string][]byte{},
		weaponFxCache:       map[string][]byte{},
		glamourPNG:          map[string][]byte{},
		vfsEvents:           newVFSEventHub(),
	}
	sess.renderer = assetrender.New(vfs, assetrender.Options{CacheDir: cacheDir})
	return sess
}

// start launches the in-process game host and the background asset/VFS warming
// for this session.
func (sess *Session) start() {
	sess.startGameHost()
	go sess.startAssetPreload()
	sess.startVFSWarm()
}

// close releases the session's VFS.
func (sess *Session) close() error {
	if sess.vfs != nil {
		return sess.vfs.Close()
	}
	return nil
}
