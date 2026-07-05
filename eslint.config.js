import js from '@eslint/js'
import globals from 'globals'

// Repo-wide ESLint flat config.  Covers the studio web app
// (internal/studio/web), which bundles the registry-published
// @coreprime/kbot-* packages via Vite.
export default [
  {
    // node_modules is ignored by default.  The rest are third-party or
    // generated artifacts that fail any rule looking at code shape:
    //   - vendor: minified Preact / signals / htm bundles
    //   - engine/wasm_exec.js: Go's generated wasm loader (staged by task build-wasm)
    //   - dist: the Vite bundle (minified output + copied vendor loader)
    ignores: [
      'internal/studio/web/vendor/**',
      'internal/studio/web/engine/wasm_exec.js',
      'internal/studio/web/dist/**',
    ],
  },
  js.configs.recommended,
  {
    // Node-side tooling and examples: the headless consume-proof runs that
    // install the published packages and exercise them under Node, not a
    // browser.
    files: ['examples/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2024,
      sourceType: 'module',
      // Examples mix Node-side harness code with browser-side snippets
      // (bundled page entries, page.evaluate closures) in one file set.
      globals: { ...globals.node, ...globals.browser },
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
