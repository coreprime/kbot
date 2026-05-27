import js from '@eslint/js'
import globals from 'globals'

export default [
  {
    // Vendor is third-party minified bundles (Preact / signals / htm)
    // — they fail any lint rule that looks at code shape, so we skip.
    ignores: ['node_modules/**', 'vendor/**'],
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
