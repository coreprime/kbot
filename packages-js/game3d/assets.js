// assets.js — the AssetProvider seam.
//
// @kbot/game3d is a renderer: it draws models, textures, palettes and
// effects but performs NO network or filesystem I/O of its own.  Every
// asset it needs arrives through a single injected AssetProvider, so the
// same renderer runs against any asset source: the KBot Studio server, a
// static pre-extracted pack over HTTP, or an in-browser HPI reader.
//
// Configure the provider once per page — either directly:
//
//   import { setAssetProvider } from '@kbot/game3d'
//   setAssetProvider(myProvider)
//
// or through the top-level factory, which installs it for you:
//
//   const world = await createWorld(canvas, { assets: myProvider })
//
// ── The AssetProvider contract ─────────────────────────────────────────
//
// Required by the renderer:
//
/**
 * @typedef {Object} AssetProvider
 *
 * @property {() => Promise<Array<[number, number, number]>>} palette
 *   256-entry RGB palette used to resolve flat-coloured (untextured)
 *   primitives.
 *
 * @property {(name: string, opts?: {enhanceMesh?: boolean, query?: string}) => Promise<Object>} model
 *   Preprocessed model geometry for a unit/wreck/projectile model name
 *   (no extension).  Shape: { name, root: {name, origin:[x,y,z],
 *   vertices:[…], primitives:[{indices, texture?, isColored?,
 *   colorIndex?, colorRGB?}], selectionPrim?, isEmitterPoint?,
 *   children:[…]}, bounds?: {min:[…], max:[…]}, textures?: [names],
 *   decals?: [names], textureQuery?: string, textureSources?: {} }.
 *
 * @property {(name: string) => Promise<Blob|ImageBitmap|HTMLImageElement|HTMLCanvasElement>} texture
 *   Decoded texture image for a 3DO texture name.  `name` may carry a
 *   resolver query suffix ("armkbot4?side=ara") which the provider
 *   forwards to its lookup.
 *
 * Optional — the renderer degrades gracefully without them:
 *
 * @property {(name: string, opts?: {decompile?: boolean}) => Promise<Object|null>} [script]
 *   COB animation script for a model name (the studio's parsed JSON
 *   form).  null / rejection ⇒ the unit renders statically.
 *
 * @property {(tileset: string) => Promise<Blob|ImageBitmap|HTMLImageElement|HTMLCanvasElement>} [groundTile]
 *   Tileable flat-terrain texture for the active environment's tileset.
 *   Missing ⇒ the procedural ground fallback stays.
 *
 * @property {(stem: string) => (string|null)} [soundUrl]
 *   Fast path for streaming audio: a URL assignable to
 *   HTMLMediaElement.src.  Preferred over sound() when present.
 *
 * @property {(name: string) => Promise<Blob|ArrayBuffer>} [sound]
 *   Sound effect bytes for a file stem (no extension).  Used (via an
 *   object URL) when soundUrl is absent.  Neither ⇒ silence.
 *
 * @property {(name: string) => (string|null)} [cursorUrl]
 *   Fast path for the armed-cursor glyph <img> (an animated image URL).
 *
 * @property {(name: string) => Promise<Blob>} [cursor]
 *   Cursor glyph bytes when cursorUrl is absent.  Neither ⇒ the native
 *   pointer stays.
 *
 * @property {(weaponName: string) => Promise<Object|null>} [weaponBitmap]
 *   Animated bitmap-projectile sprite for a weapon: { sheet: base64 PNG,
 *   frameCount, frameWidth, frameHeight, sheetWidth, sheetHeight,
 *   frameDurationMs, originX, originY, sequence }.  null / missing ⇒
 *   the synthetic point-sprite fallback renders instead.
 *
 * Reserved for drivers built on top of the renderer (the replayer, a
 * lobby, a map viewer) — the renderer itself never calls these, but a
 * full provider implements them so one object serves the whole stack:
 *
 * @property {() => Promise<Object>} [manifest]  Game manifest: sides, palettes, unit list.
 * @property {() => Promise<Object>} [unitDB]    Parsed FBI/TDF unit database + movement classes.
 * @property {(name: string) => Promise<Object>} [map]  Map pack: heightmap + tiles + features + minimap.
 *
 * Known implementations:
 *   - StudioAssetProvider (KBot Studio web client) — wraps the studio
 *     server's /api/studio/* asset endpoints.
 *   - HttpPackProvider (planned) — static pre-extracted asset packs over
 *     plain HTTP; the Boneyards replayer's provider.
 *   - HpiProvider (planned) — reads HPI/UFO archives directly in the
 *     browser.
 */

let _provider = null

// setAssetProvider installs the page-wide provider.  Call before any
// renderer construction; createWorld() does it for you.
export function setAssetProvider(provider) {
  _provider = provider || null
}

// getAssetProvider returns the installed provider, or null.
export function getAssetProvider() {
  return _provider
}

// requireAssetProvider returns the installed provider or throws with a
// pointed setup hint — a missing provider is a wiring bug, and failing
// loud beats a renderer that silently draws fallback grey forever.
export function requireAssetProvider() {
  if (!_provider) {
    throw new Error(
      '@kbot/game3d: no AssetProvider configured — pass { assets } to createWorld() or call setAssetProvider() first',
    )
  }
  return _provider
}

// toTexImageSource normalises a provider's texture()/groundTile() result
// into something texImage2D + 2D-canvas drawImage both accept.  Blobs are
// decoded through an <img> + object URL (rather than createImageBitmap)
// so UNPACK_FLIP_Y_WEBGL keeps applying — ImageBitmap ignores that
// pixel-store flag per spec, and the whole upload path assumes it.
export async function toTexImageSource(result) {
  if (!result) throw new Error('asset provider returned no image')
  if (typeof Blob !== 'undefined' && result instanceof Blob) {
    const url = URL.createObjectURL(result)
    try {
      const img = new Image()
      img.src = url
      await new Promise((resolve, reject) => {
        img.addEventListener('load', resolve, { once: true })
        img.addEventListener('error', () => reject(new Error('image decode failed')), { once: true })
      })
      return img
    } finally {
      // Revoke on the next tick — the decoded pixels are already in the
      // element; revoking synchronously is also safe post-load but this
      // keeps Safari's lazier pipelines happy.
      setTimeout(() => URL.revokeObjectURL(url), 0)
    }
  }
  return result
}
