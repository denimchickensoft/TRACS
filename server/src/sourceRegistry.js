'use strict'

// Registry of primary unit-data sources. Each module exports the shared
// contract: { start(cfg, callbacks), stop(), isPolling(), getConfig(), probe(cfg) }.
// Mutually exclusive — routes/api.js stops every other source before starting
// a new one. See resources/specs/data-sources/pluggable-source-architecture-spec.md.

const SOURCE_TYPES = ['olympus']

function get(sourceType) {
  if (sourceType === 'olympus') return require('./olympus')
  return null
}

module.exports = { SOURCE_TYPES, get }
