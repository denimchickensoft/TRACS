import { defineConfig } from 'vitest/config'

// Unit tests for the pure modules across the monorepo. Tests live in the
// root test/ tree (mirroring client/, server/, relay/, packages/) rather
// than next to the code, so nothing test-only lands in the Electron
// package's server/src/** glob or the relay folder.
export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    environment: 'node',
  },
})
