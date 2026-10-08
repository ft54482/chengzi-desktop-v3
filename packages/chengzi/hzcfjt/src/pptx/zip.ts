/** Minimal ZIP (store/deflate) writer+reader for OOXML packages — stdlib only.
 *
 *  A .pptx is a ZIP of XML parts. Node has no stdlib zip writer, so this
 *  module implements the minimum viable container: deflate-compressed local
 *  file headers, a central directory, and the end-of-central-directory
 *  record, with forward-slash entry names (required by OOXML consumers).
 *  `readZip` parses the same container (store+deflate, no zip64) to load
 *  binary asset packages such as the customer-approved head template.
 */

import { deflateRawSync, inflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n += 1) {
    let c = n
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

function crc32(data: Buffer): number {
  let crc = 0xffffffff
  for (let index = 0; index < data.length; index += 1) {
    const byte = data[index] ?? 0
    crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

export interface ZipEntry {
  /** Forward-slash path inside the archive (e.g. `ppt/slides/slide1.xml`). */
  readonly name: string
  readonly data: Buffer
}

/** Build a complete ZIP archive from ordered entries. */
export function buildZip(entries: readonly ZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    if (entry.name.includes('\\') || entry.name.startsWith('/')) {
      throw new Error(`invalid zip entry name: ${entry.name}`)
    }
    const crc = crc32(entry.data)
    const compressed = deflateRawSync(entry.data)
    const useDeflate = compressed.length < entry.data.length
    const payload = useDeflate ? compressed : entry.data
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(useDeflate ? 8 : 0, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0x21, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(entry.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    name.copy(local, 30)
    locals.push(local, payload)

    const central = Buffer.alloc(46 + name.length)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0, 8)
    central.writeUInt16LE(useDeflate ? 8 : 0, 10)
    central.writeUInt16LE(0, 12)
    central.writeUInt16LE(0x21, 14)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(entry.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(0, 38)
    central.writeUInt32LE(offset, 42)
    name.copy(central, 46)
    centrals.push(central)

    offset += local.length + payload.length
  }
  const centralDir = Buffer.concat(centrals)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(0x06054b50, 0)
  eocd.writeUInt16LE(0, 4)
  eocd.writeUInt16LE(0, 6)
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20)
  return Buffer.concat([...locals, centralDir, eocd])
}

/** Parse a ZIP built by the same constrained writer (store/deflate, no zip64). */
export function readZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  // End-of-central-directory 从尾部回扫（最多留 64KB 注释位）
  const minEocd = 22
  let eocdAt = -1
  for (let i = buffer.length - minEocd; i >= Math.max(0, buffer.length - 65557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) { eocdAt = i; break }
  }
  if (eocdAt < 0) throw new Error('readZip: EOCD not found')
  const count = buffer.readUInt16LE(eocdAt + 10)
  let ptr = buffer.readUInt32LE(eocdAt + 16)
  for (let index = 0; index < count; index += 1) {
    if (buffer.readUInt32LE(ptr) !== 0x02014b50) throw new Error(`readZip: bad central header at ${String(index)}`)
    const method = buffer.readUInt16LE(ptr + 10)
    const compressedSize = buffer.readUInt32LE(ptr + 20)
    const size = buffer.readUInt32LE(ptr + 24)
    const nameLen = buffer.readUInt16LE(ptr + 28)
    const extraLen = buffer.readUInt16LE(ptr + 30)
    const commentLen = buffer.readUInt16LE(ptr + 32)
    const localOffset = buffer.readUInt32LE(ptr + 42)
    const name = buffer.subarray(ptr + 46, ptr + 46 + nameLen).toString('utf8')
    // 本地头：跳过 name/extra 定位数据
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
    if (data.length !== size) throw new Error(`readZip: size mismatch for ${name}`)
    entries.push({ name, data })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
