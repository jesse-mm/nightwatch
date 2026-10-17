// ESLint 10 flat config (eslintrc is gone in v10; this file is the only config).
// Note: v10 looks up config starting from each linted file's directory, so keep
// this single config at the repo root and don't add nested ones by accident.
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['**/build/**', 'server/target/**', 'server/data/**', 'node_modules/**', 'watchface/src/pkjs/catalog-data.js']),

  // Vendored libraries: not ours to restyle, but they must still parse as ES5.
  {
    files: ['watchface/src/pkjs/vendor/**/*.js'],
    languageOptions: { ecmaVersion: 5, sourceType: 'commonjs' },
    rules: {},
  },

  // PebbleKit JS: runs in the Pebble phone app's JS runtime. Keep it ES5 + CommonJS.
  {
    files: ['watchface/src/pkjs/**/*.js'],
    ignores: ['watchface/src/pkjs/vendor/**'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'commonjs',
      globals: {
        ...globals.commonjs,
        Pebble: 'readonly',
        localStorage: 'readonly',
        XMLHttpRequest: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        Float32Array: 'readonly',
        Uint8Array: 'readonly',
        Uint8ClampedArray: 'readonly',
        Uint32Array: 'readonly',
      },
    },
    rules: {
      'no-var': 'off',
      eqeqeq: 'error',
      // ES5 has no optional catch binding, so `catch (e)` may go unused.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },

  // The shared renderer runs in PebbleKit JS too, so it's held to ES5 (with the
  // typed arrays every runtime has). Loaded as CommonJS or a plain <script>.
  {
    files: ['server/static/config/render.js', 'server/static/config/looks.js', 'server/static/config/settings.js', 'server/static/config/catalog.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 5,
      sourceType: 'script',
      globals: {
        module: 'readonly',
        Float32Array: 'readonly',
        Uint8Array: 'readonly',
        Uint8ClampedArray: 'readonly',
        Uint32Array: 'readonly',
      },
    },
    rules: {
      'no-var': 'off',
      eqeqeq: 'error',
      // ES5 has no optional catch binding, so `catch (e)` may go unused.
      'no-unused-vars': ['error', { caughtErrors: 'none' }],
    },
  },

  // Settings page: a modern phone webview.
  {
    files: ['server/static/**/*.js'],
    ignores: ['server/static/config/render.js', 'server/static/config/looks.js', 'server/static/config/settings.js', 'server/static/config/catalog.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'script',
      globals: globals.browser,
    },
    rules: {
      eqeqeq: 'error',
      'prefer-const': 'error',
    },
  },

  // Node tests (npm test).
  {
    files: ['watchface/test/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },

  // This config file itself.
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
]);
