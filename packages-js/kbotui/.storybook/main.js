import { resolve } from 'node:path'

// Storybook over @coreprime/kbot-ui.  The stories import the package's components
// directly (relative paths inside this package) and render them with the
// Preact + htm stack the studio uses.  The preview pulls in the studio's
// stylesheet so the chrome looks identical to the running app.
export default {
  stories: ['../stories/**/*.stories.js'],
  framework: {
    name: '@storybook/preact-vite',
    options: {},
  },
  async viteFinal(config) {
    // studio.css lives in the studio web app, outside this package root.
    // Allow Vite's dev/build server to read up to the repo root so the
    // preview can import it.
    config.server = config.server || {}
    config.server.fs = config.server.fs || {}
    const repoRoot = resolve(import.meta.dirname, '../../..')
    config.server.fs.allow = [...(config.server.fs.allow || []), repoRoot]
    return config
  },
}
