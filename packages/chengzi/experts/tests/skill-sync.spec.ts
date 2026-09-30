import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { deflateRawSync } from 'node:zlib'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { SkillPackageCatalog, SkillPackageSummary } from '../src/skill-packages-client.js'
import {
  cloudSkillRoot,
  createSkillPackageSyncState,
  SKILL_PACKAGE_STATE_FILE,
  syncSkillPackages,
  type SkillSyncOutcome,
} from '../src/skill-sync.js'

// ─── 测试用 zip 构造器（宽松版：允许任意条目名，专供恶意包用例） ──────────────

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
    crc = CRC_TABLE[(crc ^ data[index]!) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

interface TestZipEntry {
  readonly name: string
  readonly data: Buffer
}

/** Build a complete ZIP archive；与 hzcfjt 的 buildZip 同构，但不校验条目名
 *  （穿越/反斜杠/盘符等恶意名字正是测试要造的输入）。目录条目以 `/` 结尾。 */
function buildZip(entries: readonly TestZipEntry[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const isDirectory = entry.name.endsWith('/')
    const compressed = isDirectory ? entry.data : deflateRawSync(entry.data)
    const useDeflate = !isDirectory && compressed.length < entry.data.length
    const payload = useDeflate ? compressed : entry.data
    const method = useDeflate ? 8 : 0
    const crc = crc32(entry.data)
    const local = Buffer.alloc(30 + name.length)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
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
    central.writeUInt16LE(method, 10)
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

// ─── 场景装配 ────────────────────────────────────────────────────────────────

const roots: string[] = []

afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true })
})

function pkg(id: string, version = 1): SkillPackageSummary {
  return { id, name: `技能包 ${id}`, description: '测试技能包', size_bytes: 0, version }
}

const catalogOf = (...rows: readonly SkillPackageSummary[]): () => Promise<SkillPackageCatalog> =>
  async () => ({ version: 1, packages: rows })

interface Scenario {
  readonly root: string
  readonly run: () => Promise<SkillSyncOutcome>
  readonly downloads: ReadonlyMap<string, number>
  readonly warn: ReturnType<typeof vi.fn>
}

function makeScenario(setup: {
  readonly catalog: () => Promise<SkillPackageCatalog>
  readonly archives: Readonly<Record<string, Buffer>>
}): Scenario {
  const root = mkdtempSync(join(tmpdir(), 'chengzi-skill-sync-'))
  roots.push(root)
  const downloads = new Map<string, number>()
  const warn = vi.fn()
  const run = async (): Promise<SkillSyncOutcome> => await syncSkillPackages({
    root,
    warn,
    now: () => new Date('2026-09-22T00:00:00Z'),
    fetchCatalog: setup.catalog,
    downloadPackage: async (id: string): Promise<Buffer> => {
      downloads.set(id, (downloads.get(id) ?? 0) + 1)
      const archive = setup.archives[id]
      if (archive === undefined) throw new Error(`no archive fixture for ${id}`)
      return archive
    },
  })
  return { root, run, downloads, warn }
}

function skillMd(id: string, name = id): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: 测试技能包 ${id}\n---\n\n# ${id}\n说明正文。\n`, 'utf8')
}

function validPackageZip(id: string, files: readonly TestZipEntry[] = []): Buffer {
  return buildZip([
    { name: `${id}/`, data: Buffer.alloc(0) },
    { name: `${id}/SKILL.md`, data: skillMd(id) },
    ...files,
  ])
}

function readState(root: string): Record<string, number> {
  const text = readFileSync(join(root, SKILL_PACKAGE_STATE_FILE), 'utf8')
  const value = JSON.parse(text) as { packages?: Record<string, number> }
  return value.packages ?? {}
}

// ─── 用例 ────────────────────────────────────────────────────────────────────

describe('cloudSkillRoot', () => {
  it('resolves the package root as the default skills dir (one-level scan shape)', () => {
    expect(cloudSkillRoot(join('home', '.dsh'))).toBe(join('home', '.dsh', 'skills'))
  })
})

describe('syncSkillPackages', () => {
  it('installs a valid package with the exact directory structure', async () => {
    const note = Buffer.from('笔记内容\n', 'utf8')
    const script = Buffer.from('console.log("run")\n', 'utf8')
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-a')),
      archives: {
        'pkg-a': validPackageZip('pkg-a', [
          { name: 'pkg-a/assets/note.txt', data: note },
          { name: 'pkg-a/scripts/run.mjs', data: script },
        ]),
      },
    })

    const outcome = await scenario.run()

    expect(outcome).toEqual({ catalog: 'cloud', synced: ['pkg-a'], skipped: [], rejected: [] })
    expect(readFileSync(join(scenario.root, 'pkg-a', 'SKILL.md'))).toEqual(skillMd('pkg-a'))
    expect(readFileSync(join(scenario.root, 'pkg-a', 'assets', 'note.txt'))).toEqual(note)
    expect(readFileSync(join(scenario.root, 'pkg-a', 'scripts', 'run.mjs'))).toEqual(script)
    expect(readState(scenario.root)).toEqual({ 'pkg-a': 1 })
    // 领地内不残留 tmp/trash 运行痕迹。
    expect(readdirSync(scenario.root).sort()).toEqual(['.chengzi-skill-sync.json', 'pkg-a'])
    expect(scenario.downloads.get('pkg-a')).toBe(1)
  })

  it('rejects traversal / backslash / drive-letter entry names without recording them (check 3)', async () => {
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-t'), pkg('pkg-bs'), pkg('pkg-dl')),
      archives: {
        'pkg-t': buildZip([
          { name: 'pkg-t/SKILL.md', data: skillMd('pkg-t') },
          { name: '../evil.txt', data: Buffer.from('pwned') },
        ]),
        'pkg-bs': buildZip([
          { name: 'pkg-bs/SKILL.md', data: skillMd('pkg-bs') },
          { name: 'pkg-bs/C:\\evil.txt', data: Buffer.from('pwned') },
        ]),
        'pkg-dl': buildZip([
          { name: 'pkg-dl/SKILL.md', data: skillMd('pkg-dl') },
          { name: 'D:/evil.txt', data: Buffer.from('pwned') },
        ]),
      },
    })

    const outcome = await scenario.run()

    expect(outcome.catalog).toBe('cloud')
    expect(outcome.synced).toEqual([])
    expect(outcome.rejected).toEqual(['pkg-t', 'pkg-bs', 'pkg-dl'])
    // 状态文件不记非法包，非法目录不落盘。
    expect(readState(scenario.root)).toEqual({})
    expect(existsSync(join(scenario.root, 'pkg-t'))).toBe(false)
    expect(existsSync(join(scenario.root, 'pkg-bs'))).toBe(false)
    expect(existsSync(join(scenario.root, 'pkg-dl'))).toBe(false)
    // 校验先于落盘：包外没有任何字节写出。
    expect(readdirSync(scenario.root).sort()).toEqual(['.chengzi-skill-sync.json'])
    expect(scenario.warn.mock.calls.some(call => String(call[0]).includes('rejected'))).toBe(true)
  })

  it('rejects a package with more than 50 entries (check 2)', async () => {
    const files: TestZipEntry[] = []
    for (let index = 0; index < 50; index += 1) {
      files.push({ name: `pkg-n/f-${String(index).padStart(2, '0')}.txt`, data: Buffer.from(`${index}\n`) })
    }
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-n')),
      archives: { 'pkg-n': validPackageZip('pkg-n', files) }, // 1 目录条目 + SKILL.md + 50 = 52 条
    })

    const outcome = await scenario.run()

    expect(outcome.rejected).toEqual(['pkg-n'])
    expect(readState(scenario.root)).toEqual({})
    expect(existsSync(join(scenario.root, 'pkg-n'))).toBe(false)
  })

  it('rejects a package whose zip root has two top-level entries (check 4)', async () => {
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-d'), pkg('pkg-flat')),
      archives: {
        'pkg-d': buildZip([
          { name: 'pkg-d/SKILL.md', data: skillMd('pkg-d') },
          { name: 'other/file.txt', data: Buffer.from('stray') },
        ]),
        'pkg-flat': buildZip([
          { name: 'pkg-flat/SKILL.md', data: skillMd('pkg-flat') },
          { name: 'pkg-flat.txt', data: Buffer.from('top-level flat file') },
        ]),
      },
    })

    const outcome = await scenario.run()

    expect(outcome.rejected).toEqual(['pkg-d', 'pkg-flat'])
    expect(readState(scenario.root)).toEqual({})
    expect(existsSync(join(scenario.root, 'pkg-d'))).toBe(false)
    expect(existsSync(join(scenario.root, 'pkg-flat'))).toBe(false)
  })

  it('rejects a package whose frontmatter name differs from its id, or whose SKILL.md is missing (check 5)', async () => {
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-m'), pkg('pkg-e'), pkg('pkg-garbage')),
      archives: {
        // frontmatter `name:` 与包 id 不一致。
        'pkg-m': buildZip([
          { name: 'pkg-m/', data: Buffer.alloc(0) },
          { name: 'pkg-m/SKILL.md', data: skillMd('pkg-m', 'totally-different-name') },
        ]),
        // 缺 SKILL.md。
        'pkg-e': buildZip([{ name: 'pkg-e/readme.txt', data: Buffer.from('no SKILL.md') }]),
        // 不是 zip。
        'pkg-garbage': Buffer.from('this is not a zip archive at all'),
      },
    })

    const outcome = await scenario.run()

    expect(outcome.rejected).toEqual(['pkg-m', 'pkg-e', 'pkg-garbage'])
    expect(readState(scenario.root)).toEqual({})
    for (const id of ['pkg-m', 'pkg-e', 'pkg-garbage']) {
      expect(existsSync(join(scenario.root, id))).toBe(false)
    }
  })

  it('rejects a package over the 5 MiB uncompressed budget (check 1)', async () => {
    const files: TestZipEntry[] = []
    // 49 × 110 KiB 随机数据（不可压缩）+ SKILL.md ≈ 5.27 MiB > 5 MiB；条目数 50 恰好不触发条目上限。
    for (let index = 0; index < 49; index += 1) {
      files.push({ name: `pkg-big/blob-${String(index).padStart(2, '0')}.bin`, data: randomBytes(110 * 1024) })
    }
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-big')),
      archives: { 'pkg-big': validPackageZip('pkg-big', files) },
    })

    const outcome = await scenario.run()

    expect(outcome.rejected).toEqual(['pkg-big'])
    expect(readState(scenario.root)).toEqual({})
    expect(existsSync(join(scenario.root, 'pkg-big'))).toBe(false)
  })

  it('does not redownload when the remote version is unchanged or lower', async () => {
    let rows: readonly SkillPackageSummary[] = [pkg('pkg-v', 2)]
    const scenario = makeScenario({
      catalog: async () => ({ version: 1, packages: rows }),
      archives: { 'pkg-v': validPackageZip('pkg-v') },
    })

    const first = await scenario.run()
    expect(first.synced).toEqual(['pkg-v'])

    // version 不变 → 不重复下载。
    const second = await scenario.run()
    expect(second.synced).toEqual([])
    expect(second.skipped).toEqual(['pkg-v'])

    // 远端 version 回落（本地更高）同样不动。
    rows = [pkg('pkg-v', 1)]
    const third = await scenario.run()
    expect(third.synced).toEqual([])
    expect(readState(scenario.root)).toEqual({ 'pkg-v': 2 })

    expect(scenario.downloads.get('pkg-v')).toBe(1)
  })

  it('installs a newer version and replaces the old directory without leftovers', async () => {
    const archives: Record<string, Buffer> = {
      'pkg-u': validPackageZip('pkg-u', [{ name: 'pkg-u/old-file.txt', data: Buffer.from('v1') }]),
    }
    let version = 1
    const scenario = makeScenario({
      catalog: async () => ({ version, packages: [pkg('pkg-u', version)] }),
      archives,
    })

    await scenario.run()
    expect(existsSync(join(scenario.root, 'pkg-u', 'old-file.txt'))).toBe(true)

    version = 2
    archives['pkg-u'] = validPackageZip('pkg-u', [{ name: 'pkg-u/new-file.txt', data: Buffer.from('v2') }])

    const outcome = await scenario.run()
    expect(outcome.synced).toEqual(['pkg-u'])
    // 旧文件不残留，新文件就位，版本记录更新。
    expect(existsSync(join(scenario.root, 'pkg-u', 'old-file.txt'))).toBe(false)
    expect(readFileSync(join(scenario.root, 'pkg-u', 'new-file.txt'), 'utf8')).toBe('v2')
    expect(readState(scenario.root)).toEqual({ 'pkg-u': 2 })
    expect(scenario.downloads.get('pkg-u')).toBe(2)
    expect(readdirSync(scenario.root).sort()).toEqual(['.chengzi-skill-sync.json', 'pkg-u'])
  })

  it('keeps local packages and state untouched when the catalog is unreachable', async () => {
    let fail = false
    const scenario = makeScenario({
      catalog: async () => {
        if (fail) throw new Error('network down')
        return { version: 1, packages: [pkg('pkg-k')] }
      },
      archives: { 'pkg-k': validPackageZip('pkg-k') },
    })

    await scenario.run()
    const stateBefore = readFileSync(join(scenario.root, SKILL_PACKAGE_STATE_FILE), 'utf8')

    fail = true
    const outcome = await scenario.run()

    expect(outcome.catalog).toBe('unreachable')
    expect(outcome.synced).toEqual([])
    expect(existsSync(join(scenario.root, 'pkg-k', 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(scenario.root, SKILL_PACKAGE_STATE_FILE), 'utf8')).toBe(stateBefore)
    expect(scenario.warn.mock.calls.some(call => String(call[0]).includes('unreachable'))).toBe(true)
  })

  it('keeps a package installed after it vanishes from the catalog (v1 keeps delisted packages)', async () => {
    let rows: readonly SkillPackageSummary[] = [pkg('pkg-x')]
    const scenario = makeScenario({
      catalog: async () => ({ version: 1, packages: rows }),
      archives: { 'pkg-x': validPackageZip('pkg-x') },
    })

    await scenario.run()
    rows = []

    const outcome = await scenario.run()

    expect(outcome.catalog).toBe('cloud')
    expect(existsSync(join(scenario.root, 'pkg-x', 'SKILL.md'))).toBe(true)
    expect(readState(scenario.root)).toEqual({ 'pkg-x': 1 })
  })

  it('warns and continues when a single download fails', async () => {
    const scenario = makeScenario({
      catalog: catalogOf(pkg('pkg-lost'), pkg('pkg-ok')),
      archives: { 'pkg-ok': validPackageZip('pkg-ok') }, // pkg-lost 无 fixture → 下载抛错
    })

    const outcome = await scenario.run()

    expect(outcome.catalog).toBe('cloud')
    expect(outcome.synced).toEqual(['pkg-ok'])
    expect(readState(scenario.root)).toEqual({ 'pkg-ok': 1 })
    expect(scenario.warn.mock.calls.some(call => String(call[0]).includes('"pkg-lost" download failed'))).toBe(true)
  })

  it('sweeps stale tmp and trash scratch directories left by crashed runs', async () => {
    const scenario = makeScenario({ catalog: catalogOf(), archives: {} })
    writeFileSync(join(scenario.root, '.tmp-pkg-z-123'), 'partial')
    writeFileSync(join(scenario.root, '.trash-pkg-z-122'), 'old')

    await scenario.run()

    expect(existsSync(join(scenario.root, '.tmp-pkg-z-123'))).toBe(false)
    expect(existsSync(join(scenario.root, '.trash-pkg-z-122'))).toBe(false)
  })
})

describe('createSkillPackageSyncState', () => {
  it('shares one in-flight sync, never rejects on failure, and respects the staleness threshold', async () => {
    let calls = 0
    let release: (() => void) | undefined
    const gate = new Promise<void>((resolve) => { release = resolve })
    const warn = vi.fn()
    const root = mkdtempSync(join(tmpdir(), 'chengzi-skill-sync-state-'))
    roots.push(root)
    const state = createSkillPackageSyncState({
      root,
      warn,
      fetchCatalog: async (): Promise<SkillPackageCatalog> => {
        calls += 1
        await gate
        throw new Error('network down')
      },
      downloadPackage: (id: string): Promise<Buffer> => Promise.reject(new Error(`unexpected download ${id}`)),
    })

    const first = state.syncNow()
    const second = state.syncNow()
    release?.()
    await Promise.all([first, second]) // 不得 reject

    expect(calls).toBe(1)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toContain('unreachable')

    // 刚同步过：阈值内不再触发。
    await state.syncIfStale(5 * 60_000)
    expect(calls).toBe(1)
  })
})
