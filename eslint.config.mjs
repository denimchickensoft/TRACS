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
    ignores: ['**/dist/**', '**/build/**', 'dist-electron/**', 'electron/build-staging/**', 'resources/**', 'docs/**', 'server/state/**'],
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

  // Unit tests (root test/ tree, run by Vitest from vitest.config.mjs) — ESM,
  // Node.
  {
    files: ['test/**/*.js', 'vitest.config.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },

  // Shared workspace packages — plain ESM, consumed by both client (browser)
  // and server (Node dynamic import), so no environment-specific globals.
  {
    files: ['packages/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
    },
  },

  // Server + mock-olympus + relay + electron main process — CommonJS, Node.
  // relay/ was missing from this block entirely (a pre-existing gap, not
  // introduced by adding it here) — it's a standalone app excluded from the
  // npm workspace, but it's still plain CommonJS/Node code that deserves the
  // same globals/rules as everything else, not the browser-less default
  // eslint:recommended treatment that flagged every console/require/process
  // reference as undefined.
  {
    files: ['server/**/*.js', 'mock-olympus/**/*.js', 'relay/**/*.js', 'electron/**/*.js', 'scripts/**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': unusedVarsRule,
    },
  },
  // Scripts that run in a browser page, not in Node: the port-conflict
  // dialog's and the docs pages' Ctrl+F box.
  {
    files: ['electron/portConflict.js', 'server/src/docsFind.js'],
    languageOptions: {
      sourceType: 'script',
      globals: globals.browser,
    },
  },
]
