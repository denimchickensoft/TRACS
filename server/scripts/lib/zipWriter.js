'use strict'

// Minimal ZIP archive writer — no deps beyond Node's built-in zlib (raw
// deflate, same compressor a real zip uses for method 8). Same spirit as
// pngEncoder.js: avoids pulling in an archiver/jszip dependency just to
// bundle a handful of small JSON files into one file for distribution.
// Store (uncompressed) is used per-entry whenever deflate doesn't actually
// win, so tiny files never pay a compression-container tax.

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

function dosDateTime(date) {
  const time = ((date.getHours() & 0x1F) << 11) | ((date.getMinutes() & 0x3F) << 5) | ((date.getSeconds() >> 1) & 0x1F)
  const dosDate = (((date.getFullYear() - 1980) & 0x7F) << 9) | (((date.getMonth() + 1) & 0xF) << 5) | (date.getDate() & 0x1F)
  return { time, dosDate }
}

/**
 * @param {{name: string, data: Buffer}[]} entries
 * @param {Date} [date]
 * @returns {Buffer}
 */
function buildZip(entries, date = new Date()) {
  const { time, dosDate } = dosDateTime(date)
  const localChunks   = []
  const centralChunks = []
  let offset = 0

  for (const { name, data } of entries) {
    const nameBuf     = Buffer.from(name.replace(/\\/g, '/'), 'utf8')
    const crc         = crc32(data)
    const deflated    = zlib.deflateRawSync(data)
    const useDeflate  = deflated.length < data.length
    const method      = useDeflate ? 8 : 0
    const payload     = useDeflate ? deflated : data

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(dosDate, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBuf.length, 26)
    local.writeUInt16LE(0, 28)
    localChunks.push(local, nameBuf, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(dosDate, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(data.length, 24)
    central.writeUInt16LE(nameBuf.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    centralChunks.push(central, nameBuf)

    offset += local.length + nameBuf.length + payload.length
  }

  const centralOffset = offset
  const centralSize   = centralChunks.reduce((n, b) => n + b.length, 0)

  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)

  return Buffer.concat([...localChunks, ...centralChunks, end])
}

module.exports = { buildZip }
