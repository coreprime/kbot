import js from '@eslint/js'
import globals from 'globals'

// Repo-wide ESLint flat config.  Covers the studio web app
// (internal/studio/web) plus the @kbot/* workspace packages
// (packages-js/*), which the studio bundles via Vite.
export default [
  {
    // node_modules is ignored by default.  The rest are third-party or
    // generated artifacts that fail any rule looking at code shape:
    //   - vendor: minified Preact / signals / htm bundles
    //   - engine/wasm_exec.js: Go's generated wasm loader (task build-wasm)
    //   - dist: the Vite bundle (minified output + copied vendor loader)
    //   - storybook-static: Storybook's static export
    ignores: [
      'internal/studio/web/vendor/**',
      'internal/studio/web/engine/wasm_exec.js',
      'internal/studio/web/dist/**',
      'packages-js/*/storybook-static/**',
      'packages-js/engine/wasm/**',
      'packages-js/engine/pack-verify/**',
    ],
  },
  js.configs.recommended,
  {
    // Node-side tooling and examples: the engine package's build/verify
    // scripts and the headless consume-proof run under Node, not a browser.
    files: ['packages-js/engine/scripts/**/*.mjs', 'examples/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.node },
    },
  },
  {
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      globals: { ...globals.browser },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_' }],
      'no-empty': ['warn', { allowEmptyCatch: true }],
    },
  },
  {
    // Decoupling guardrail: the type-agnostic shell, tab dispatcher and shared
    // chrome must not reach into any specific tab feature (map / unit / sandbox
    // / files / welcome). Per-type behaviour belongs in the tab descriptor.
    // (tab-bar.js is exempt — it's the composition root that wires the "+"
    // menu to each feature's opener.)
    files: [
      'internal/studio/web/ui/tab-registry.js',
      'internal/studio/web/ui/topbar.js',
      'internal/studio/web/ui/host-context.js',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [{
          group: [
            '**/map-editor/**', '**/unit-editor/**', '**/sandbox/**',
            '**/files-browser/**', '**/screens/**',
          ],
          message: 'Type-agnostic shell/dispatch/chrome must not import feature (tab) modules — move per-type behaviour into the tab descriptor.',
        }],
      }],
    },
  },
]
