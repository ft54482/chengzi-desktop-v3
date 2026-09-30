/** Minimal ZIP reader for cloud skill packages — stdlib only.
 *
 *  解析函数复制自本仓 `hzcfjt-ppt-dsh/src/pptx/zip.ts` 的 `readZip`
 *  （跨 Yarn workspace 不能直接 import），并按「远端不可信输入」加固：
 *  - 惰性解压（`data()`）：中央目录先给出声明大小，校验器在解压任何
 *    字节之前先做总量预算（防 zip 炸弹在策略检查前展开）；
 *  - 本地头签名校验：中央目录被伪造时 `readUInt32LE` 越界抛错或签名
 *    不符，均在解压前失败；
 *  - 只支持 store(0)/deflate(8)，其余压缩方法在 `data()` 显式失败。
 */

import { inflateRawSync } from 'node:zlib'

/** One central-directory entry; bytes materialize lazily through `data()`. */
export interface ZipEntry {
  /** Entry path as stored in the archive（正斜杠；目录条目以 `/` 结尾）. */
  readonly name: string
  /** Compression method：0 = store，8 = deflate. */
  readonly method: number
  /** Declared uncompressed size from the central directory. */
  readonly declaredSize: number
  /** Declared compressed size from the central directory. */
  readonly compressedSize: number
  /** Directory-entry marker（`name` 以 `/` 结尾）. */
  readonly isDirectory: boolean
  /** Materialize the entry bytes; throws on unsupported method or size mismatch. */
  data(): Buffer
}

/** Parse a ZIP central directory（store/deflate，no zip64，最多 64 KiB 注释位）. */
export function readZip(buffer: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = []
  // End-of-central-directory 从尾部回扫
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
    // 本地头：签名校验后跳过 name/extra 定位数据（subarray 对越界钳制，不抛错）
    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) throw new Error(`readZip: bad local header for ${name}`)
    const localNameLen = buffer.readUInt16LE(localOffset + 26)
    const localExtraLen = buffer.readUInt16LE(localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const raw = buffer.subarray(dataStart, dataStart + compressedSize)
    entries.push({
      name,
      method,
      declaredSize: size,
      compressedSize,
      isDirectory: name.endsWith('/'),
      data: (): Buffer => {
        if (method !== 0 && method !== 8) {
          throw new Error(`readZip: unsupported compression method ${String(method)} for ${name}`)
        }
        const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw)
        if (data.length !== size) throw new Error(`readZip: size mismatch for ${name}`)
        return data
      },
    })
    ptr += 46 + nameLen + extraLen + commentLen
  }
  return entries
}
