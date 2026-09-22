'use strict'

const fs = require('fs')
const path = require('path')

// Copies srcPath to destPath only if destPath is missing or older (by mtime)
// than srcPath — so a newer bundled default (shipped in an update) refreshes
// an untouched copy, but never clobbers a file the operator has since edited.
function copyIfStaleOrMissing(srcPath, destPath) {
  if (!fs.existsSync(srcPath)) return
  const srcMtime = fs.statSync(srcPath).mtimeMs
  const destStat = fs.existsSync(destPath) ? fs.statSync(destPath) : null
  if (destStat && srcMtime <= destStat.mtimeMs) return
  fs.mkdirSync(path.dirname(destPath), { recursive: true })
  fs.copyFileSync(srcPath, destPath)
}

module.exports = { copyIfStaleOrMissing }
