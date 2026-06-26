'use strict'

const fs     = require('fs')
const path   = require('path')
const crypto = require('crypto')

const CONFIG_DIR = path.join(__dirname, 'config')
const CACHE_DIR  = path.join(__dirname, 'cache')

const LNM_DB_PATH = path.resolve(__dirname, '..', '..', 'resources', 'littlenavmap', 'little_navmap_db', 'little_navmap_navigraph.sqlite')

// Files required in every theatre cache folder for the cache to be valid
const REQUIRED_THEATRE_FILES = [
  'fixes.json', 'navaids.json', 'airspace.json', 'ctrs.json',
  'holdings.json', 'airways.json', 'msa.json', 'mora.json',
]

async function buildCache() {
  if (!fs.existsSync(LNM_DB_PATH)) {
    console.log('[navdata] LNM database not found — run: npm run extract')
    return
  }

  const theatresRaw = fs.readFileSync(path.join(CONFIG_DIR, 'theatres.json'), 'utf8')
  const theatres    = JSON.parse(theatresRaw)
  const bboxHash    = crypto.createHash('sha256').update(theatresRaw).digest('hex').slice(0, 16)
  const lnmMtime    = fs.statSync(LNM_DB_PATH).mtime.toISOString()

  const manifestPath = path.join(CACHE_DIR, 'manifest.json')
  if (fs.existsSync(manifestPath)) {
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      if (m.lnmMtime === lnmMtime && m.bboxHash === bboxHash) {
        const allPresent = Object.values(theatres).every((tConf) =>
          REQUIRED_THEATRE_FILES.every((f) => fs.existsSync(path.join(CACHE_DIR, tConf.folder, f)))
        )
        if (allPresent) {
          console.log(`[navdata] cache hit — built ${m.builtAt}`)
          return
        }
        console.log('[navdata] cache incomplete — run: npm run extract')
        return
      }
      console.log('[navdata] LNM database changed — run: npm run extract')
    } catch {
      console.log('[navdata] manifest corrupt — run: npm run extract')
    }
  } else {
    console.log('[navdata] no cache — run: npm run extract')
  }
}

module.exports = { buildCache, CACHE_DIR, CONFIG_DIR }
