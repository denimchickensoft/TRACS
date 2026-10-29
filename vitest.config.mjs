import os from 'node:os'
import path from 'node:path'
import { defineConfig } from 'vitest/config'

// Unit tests for the pure modules across the monorepo. Tests live in the
// root test/ tree (mirroring client/, server/, relay/, packages/) rather
// than next to the code, so nothing test-only lands in the Electron
// package's server/src/** glob or the relay folder.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
    // A config dir that never exists, so tests run on the built-in defaults
    // instead of a developer's local server/rateConfig.json and friends.
    env: { TRACS_CONFIG_DIR: path.join(os.tmpdir(), 'tracs-test-no-config') },
  },
})
