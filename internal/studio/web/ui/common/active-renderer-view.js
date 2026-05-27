// active-renderer-view.js
//
// activeRendererView returns whichever view currently owns the canvas
// — the unit-editor's ModelViewer or the sandbox's SandboxView.  The
// React Renderer panel's Tracking + Auto-Rotate toggles route through
// the host bridge here so they hit the right view's setTracking /
// renderer.setAutoRotate, mirroring the legacy wireMvRendererPanel
// `activeView()` helper.
//
// Lives in /ui/common/ because both the unit-editor host bridge and
// the sandbox code path consult it — no peer import between the two
// section subfolders.  Reads the sandbox-mode tag off the shared
// model-viewer-dialog (sandbox tabs set the class on activate) so the
// helper stays cheap + stateless.

import { hostCallbacks } from '../host-context.js'
import { getActiveModelViewer } from '../unit-editor/host-state.js'

export function activeRendererView() {
  const dlg = document.getElementById('model-viewer-dialog')
  const sandboxActive = dlg && dlg.classList.contains('sandbox-mode')
  return sandboxActive
    ? (hostCallbacks.getActiveSandboxView?.() || null)
    : getActiveModelViewer()
}
