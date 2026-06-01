import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // Vendor is third-party minified bundles (Preact / signals / htm)
    // — they fail any lint rule that looks at code shape, so we skip.
    // engine/wasm_exec.js is Go's generated wasm loader (a build artifact
    // emitted by `task build-wasm`), not hand-written source.
    ignores: ['node_modules/**', 'vendor/**', 'engine/wasm_exec.js'],
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
