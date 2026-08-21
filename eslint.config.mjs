// Flat config for the whole npm-workspaces monorepo (client + server +
// mock-olympus). One config file at the root rather than one per workspace,
// since flat config lets each block scope its own languageOptions/rules by
// `files` glob — client is ESM/browser/React, server and mock-olympus are
// CommonJS/Node.
//
// Deliberately not pulling in eslint-plugin-react-hooks' full
// recommended/recommended-latest preset (v7+) — that ruleset targets React
// Compiler readiness (purity, immutability, set-state-in-render, etc.) and
// would flag a lot of this project's intentional imperative canvas code
// (direct ctx.* calls in effects, refs mutated outside render) as errors.
// Only the two classic, unambiguously-a-bug rules are enabled: hooks called
// out of order/conditionally, and effect dependency mismatches (the latter
// as a warning, not an error — exhaustive-deps has false positives, and this
// project has already hit a real dependency-array bug in the wild, so it's
// worth surfacing without being a hard gate).

import js from '@eslint/js'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import globals from 'globals'

const unusedVarsRule = ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }]

export default [
  {
    ignores: ['**/dist/**', '**/build/**', 'resources/**', 'docs/**', 'server/state/**'],
  },

  js.configs.recommended,

  // Empty catch blocks are a deliberate idiom throughout this codebase —
  // try { JSON.parse(...) } catch {} / try { decodeXBlob(...) } catch {}
  // swallowing a corrupt read/blob rather than treating it as fatal.
  {
    rules: {
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // Client — ESM, browser, React
  {
    files: ['client/src/**/*.{js,jsx}'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: globals.browser,
    },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'warn',
      'react-refresh/only-export-components': 'warn',
      'no-unused-vars': unusedVarsRule,
    },
  },

  // Client build config (vite.config.js) — ESM, runs under Node not the browser
  {
    files: ['client/*.config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
  },

  // Server + mock-olympus — CommonJS, Node
  {
    files: ['server/**/*.js', 'mock-olympus/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },
]
