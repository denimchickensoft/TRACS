'use strict'

const fs = require('fs')
const path = require('path')

// Copies srcPath to destPath only if destPath is missing or older (by mtime)
// than srcPath — so newer bundled data (shipped in an update) replaces the
// old copy. Only for app-owned files like the bundled navdata cache: it WILL
// overwrite edits whenever the bundled file is newer. Operator-editable
// config uses seedConfigFiles.js's seedConfigFile() instead.
function copyIfStaleOrMissing(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return
  const srcMtime = fs.statSync(srcPath).mtimeMs
  const destStat = fs.existsSync(destPath) ? fs.statSync(destPath) : null
  if (destStat && srcMtime <= destStat.mtimeMs) return
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(srcPath, destPath)
}

module.exports = { copyIfStaleOrMissing }
