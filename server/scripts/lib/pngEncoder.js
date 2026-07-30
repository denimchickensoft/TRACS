'use strict'

// Minimal 8-bit RGBA PNG encoder — no deps beyond Node's built-in zlib
// (PNG's IDAT compression is plain zlib/RFC1950, which is exactly what
// zlib.deflateSync produces). Same spirit as buildReliefMap.js's hand-rolled
// writeBMP: this project avoids native image-library deps (node-canvas etc.)
// for one-shot build-script output, and unlike BMP, PNG gives us an alpha
// channel and real compression, both needed for a translucent basemap wash.

const zlib = require('zlib')

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf) {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii')
  const body    = Buffer.concat([typeBuf, data])
  const out     = Buffer.alloc(4 + body.length + 4)
  out.writeUInt32BE(data.length, 0)
  body.copy(out, 4)
  out.writeUInt32BE(crc32(body), 4 + body.length)
  return out
}

/**
 * @param {number} width
 * @param {number} height
 * @param {Uint8Array|Buffer} rgba  width*height*4 bytes, row-major, top row first
 * @returns {Buffer} PNG file bytes
 */
function encodePNG(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = Buffer.alloc((stride + 1) * height)
  const src = Buffer.isBuffer(rgba) ? rgba : Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength)
  for (let y = 0; y < height; y++) {
    const rowOff = y * (stride + 1)
    raw[rowOff] = 0 // filter type "none" per scanline
    src.copy(raw, rowOff + 1, y * stride, y * stride + stride)
  }

  const idat = zlib.deflateSync(raw, { level: 9 })

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

module.exports = { encodePNG }
