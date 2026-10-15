// ESLint 10 flat config (eslintrc is gone in v10; this file is the only config).
// Note: v10 looks up config starting from each linted file's directory, so keep
// this single config at the repo root and don't add nested ones by accident.
import js from '@eslint/js';
import globals from 'globals';
import { defineConfig, globalIgnores } from 'eslint/config';

export default defineConfig([
  globalIgnores(['**/build/**', 'server/target/**', 'server/data/**', 'node_modules/**']),

  // PebbleKit JS: runs in the Pebble phone app's JS runtime. Keep it ES5 + CommonJS.
  {
    files: ['watchface/src/pkjs/**/*.js'],
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
      },
    },
    rules: {
      'no-var': 'off',
      eqeqeq: 'error',
    },
  },

  // Settings page: a modern phone webview.
  {
    files: ['server/static/**/*.js'],
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

  // This config file itself.
  {
    files: ['eslint.config.js'],
    extends: [js.configs.recommended],
    languageOptions: { ecmaVersion: 'latest', sourceType: 'module', globals: globals.node },
  },
]);
