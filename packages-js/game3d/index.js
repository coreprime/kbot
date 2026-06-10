// Public entry point for the game3d module.  Surfaces the classes the
// Studio wires through to its Modelling tab and keeps every internal
// file out of studio.js's import path.
//
// Reusable from anywhere — the same Piece / TextureCache / ModelRenderer
// classes will be picked up by the map renderer when it grows into a
// full-scene viewer, since none of them depend on the welcome dialog
// or any TA-specific UI.

export { Mat4 } from './mat4.js'
export { TAPalette } from './palette.js'
export { TextureCache } from './texture-cache.js'
export { Piece } from './piece.js'
export { Model } from './model.js'
export { ModelLoader } from './model-loader.js'
export { OrbitCamera } from './orbit-camera.js'
export { ModelRenderer } from './model-renderer.js'
export { ModelViewer } from './model-viewer.js'
x`x`