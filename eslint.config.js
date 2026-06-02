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
    ],
  },
  js.configs.recommended,
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
]
