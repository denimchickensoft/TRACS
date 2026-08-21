'use strict'

const fs = require('fs')

// Minimal 24-bit BMP encoder — no deps. Simpler than pngEncoder.js's PNG
// output (no compression, no alpha): used for quick-preview thumbnails
// (buildMvaMap.js / buildReliefMap.js) where neither is worth the cost.
function writeBMP(filePath, width, height, rgbAt) {
  const rowSize  = (width * 3 + 3) & ~3
  const dataSize = rowSize * height
  const buf = Buffer.alloc(54 + dataSize)
  buf.write('BM', 0)
  buf.writeUInt32LE(54 + dataSize, 2)
  buf.writeUInt32LE(54, 10)
  buf.writeUInt32LE(40, 14)
  buf.writeInt32LE(width, 18)
  buf.writeInt32LE(height, 22)
  buf.writeUInt16LE(1, 26)
  buf.writeUInt16LE(24, 28)
  buf.writeUInt32LE(dataSize, 34)
  for (let y = 0; y < height; y++) {
    const fileRow = height - 1 - y
    let off = 54 + fileRow * rowSize
    for (let x = 0; x < width; x++) {
      const [r, g, b] = rgbAt(x, y)
      buf[off++] = b; buf[off++] = g; buf[off++] = r
    }
  }
  fs.writeFileSync(filePath, buf)
}

module.exports = { writeBMP }
