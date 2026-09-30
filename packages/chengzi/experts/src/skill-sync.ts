/** 云端技能包同步编排：拉目录 → 与本地状态 diff → 下载 → 五重校验 → 原子落盘。
 *
 *  领地规则：
 *  - 只写 `<DSH_HOME>/skills/` 下的 `<包id>/` 目录（skill-filesystem 的
 *    默认用户根，一层扫描即可发现）；
 *  - 领地内的运行痕迹（`.tmp-*`、`.trash-*`、状态文件）不进入技能扫描
 *    （非 `.md` 顶层文件与无 SKILL.md 的目录都被扫描器忽略）；
 *  - 远端下架（目录行消失）v1 不删本地（契约第五节），状态文件中的记录
 *    一并保留——远端重新上架且 version 更高时才重新下载。
 *
 *  同步语义（对齐云端契约）：
 *  - 目录拉取失败 → 静默放弃本轮（warn 日志，绝不弹错），本地一律不动；
 *  - 行 version > 本地状态 version → 下载；不变（含本地更高）→ 跳过；
 *  - 任一包校验/落盘失败 → 丢弃该包并 warn，不影响其余包，状态文件不记。
 *
 *  五重校验（任一失败整包拒收，绝不落盘部分文件）：
 *  ① zip 声明的总解压大小 ≤ 5 MiB（在解压任何字节之前按中央目录预算，
 *     防压缩炸弹）；
 *  ② 条目数 ≤ 50；
 *  ③ 条目名拒 `..` 段 / 绝对路径 / 反斜杠 / 盘符（另拒空段、NUL、
 *     Windows 保留设备名）；
 *  ④ zip 根第一层必须恰一个目录且目录名 == 包 id（顶层平文件不算目录）；
 *  ⑤ 该目录下 SKILL.md 存在，且 frontmatter 的 `name:` == 包 id
 *     （轻量正则解析，不引依赖）。
 */

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { dirname, join } from 'node:path'
import type { SkillPackageCatalog } from './skill-packages-client.js'
import { SKILL_PACKAGE_ID_PATTERN } from './skill-packages-client.js'
import { readZip, type ZipEntry } from './zip-read.js'

/** 云端技能包落点根：`<DSH_HOME>/skills`（skill-filesystem 的默认用户根）。
 *  包目录平铺在根下一层（`<DSH_HOME>/skills/<package-id>/SKILL.md`）——恰好
 *  是扫描器「只扫一层」的发现形态，无需壳层 patch 注册 customSkillDirs
 *  （曾试过 cloud/ 子目录 + customSkillDirs patch：`!!js dshHomePath(...)`
 *  表达式在部署版壳层的启动期求值会让 app 黑屏，已废弃该路线）。 */
export function cloudSkillRoot(dshHome: string): string {
  return join(dshHome, 'skills')
}

/** 本地同步状态文件名（`<skillRoot>/.chengzi-skill-sync.json`）。 */
export const SKILL_PACKAGE_STATE_FILE = '.chengzi-skill-sync.json'

/** 五重校验①：zip 声明总解压大小上限（契约包 ≤5MB）。 */
export const MAX_SKILL_PACKAGE_UNCOMPRESSED_BYTES = 5 * 1024 * 1024

/** 五重校验②：zip 条目数上限。 */
export const MAX_SKILL_PACKAGE_ENTRIES = 50

/** 领地内的临时目录前缀（本轮写入、次轮同步前清扫）。 */
const TMP_PREFIX = '.tmp-'

/** 领地内的旧版本退位目录前缀。 */
const TRASH_PREFIX = '.trash-'

/** Windows 保留设备名（大小写不敏感）：额外的 ③ 加固。 */
const WINDOWS_RESERVED_SEGMENT = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/iu

/** 校验失败的显式失败；同步器据此 warn 并丢弃该包。 */
export class SkillPackageValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SkillPackageValidationError'
  }
}

/** 一次同步的结果摘要（诊断与测试断言用）。 */
export interface SkillSyncOutcome {
  /** 目录来源：云端成功为 `cloud`，拉取失败为 `unreachable`。 */
  readonly catalog: 'cloud' | 'unreachable'
  /** 本次下载并落盘的包 id。 */
  readonly synced: readonly string[]
  /** version 未变化而跳过的包 id。 */
  readonly skipped: readonly string[]
  /** 校验/落盘失败被拒收的包 id。 */
  readonly rejected: readonly string[]
}

/** 同步依赖注入面（测试以临时目录+伪拉取注入）。 */
export interface SkillSyncDependencies {
  /** 云端技能包根目录（`<DSH_HOME>/skills/cloud`）。 */
  readonly root: string
  /** 远端目录拉取；reject 视为远端失败（本轮静默放弃）。 */
  readonly fetchCatalog: () => Promise<SkillPackageCatalog>
  /** 单包 zip 下载；reject 视为该包失败（warn 后继续其余包）。 */
  readonly downloadPackage: (id: string) => Promise<Buffer>
  /** 时间源（测试可固定）；用于 tmp/trash 目录名的时间戳。 */
  readonly now?: () => Date
  /** 诊断日志接收者。 */
  readonly warn?: (message: string) => void
}

/** 本地状态文件形状：`{packages: {id: version}}`。 */
interface SkillSyncStateFile {
  readonly packages: Readonly<Record<string, number>>
}

/** 读取本地状态；缺失/损坏/形状不符一律视为空状态（全体重新判定）。 */
async function readSyncState(root: string): Promise<Record<string, number>> {
  let text: string
  try {
    text = await readFile(join(root, SKILL_PACKAGE_STATE_FILE), 'utf8')
  } catch {
    return {}
  }
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return {}
  }
  const packages = isRecord(value) ? value.packages : undefined
  if (!isRecord(packages)) return {}
  const result: Record<string, number> = {}
  for (const [id, version] of Object.entries(packages)) {
    if (!SKILL_PACKAGE_ID_PATTERN.test(id)) continue
    if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) continue
    result[id] = version
  }
  return result
}

/** 原子写回本地状态（临时文件 + rename）。 */
async function writeSyncState(root: string, packages: Readonly<Record<string, number>>): Promise<void> {
  const state: SkillSyncStateFile = { packages }
  const target = join(root, SKILL_PACKAGE_STATE_FILE)
  const temp = join(root, `${SKILL_PACKAGE_STATE_FILE}.tmp`)
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await rename(temp, target)
}

/** 清扫上一轮遗留的 tmp/trash 目录（领地内、前缀匹配）。 */
async function sweepSyncScratch(root: string): Promise<void> {
  let entries: Dirent[]
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.name.startsWith(TMP_PREFIX) && !entry.name.startsWith(TRASH_PREFIX)) continue
    await rm(join(root, entry.name), { recursive: true, force: true }).catch((): undefined => undefined)
  }
}

/** ③：条目名安全检查；返回拒绝理由，安全则 undefined。 */
function unsafeEntryNameReason(name: string): string | undefined {
  if (name.length === 0) return 'empty entry name'
  if (name.includes('\0')) return 'NUL byte in entry name'
  if (name.includes('\\')) return 'backslash in entry name'
  if (name.startsWith('/')) return 'absolute entry path'
  if (/^[a-zA-Z]:/u.test(name)) return 'drive-letter entry path'
  const segments = name.split('/')
  const last = segments.length - 1
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index] ?? ''
    if (segment === '..') return 'parent traversal segment'
    if (WINDOWS_RESERVED_SEGMENT.test(segment)) return `reserved device name "${segment}"`
    if (segment.length === 0 && !(index === last && entryIsDirectory(name))) return 'empty path segment'
  }
  return undefined
}

function entryIsDirectory(name: string): boolean {
  return name.endsWith('/')
}

/** 轻量 frontmatter `name:` 解析（顶层无缩进行；不引 YAML 依赖）。
 *  返回裸值（去引号）；无 frontmatter 或无 name 行返回 undefined。 */
export function parseFrontmatterName(text: string): string | undefined {
  const opening = /^---[ \t]*\r?\n/u.exec(text)
  if (opening === null) return undefined
  const body = text.slice(opening[0].length)
  const closing = /^---[ \t]*(?:\r?\n|$)/mu.exec(body)
  if (closing === null) return undefined
  const frontmatter = body.slice(0, closing.index)
  const match = /^name:[ \t]*(.*?)[ \t]*$/mu.exec(frontmatter)
  if (match === null) return undefined
  let value = match[1] ?? ''
  if (value.length >= 2) {
    const quote = value[0]
    if ((quote === '\'' || quote === '"') && value.endsWith(quote)) value = value.slice(1, -1)
  }
  return value.length > 0 ? value : undefined
}

/** 执行五重校验；全部通过时返回待落盘的文件条目（目录条目已剔除）。 */
export function validateSkillPackage(id: string, archive: Buffer): readonly ZipEntry[] {
  // Windows 保留设备名不能做目录名（id 同时是顶层目录名与物化目录名）。
  if (WINDOWS_RESERVED_SEGMENT.test(id)) {
    throw new SkillPackageValidationError(`package id "${id}" is a reserved device name`)
  }
  let entries: readonly ZipEntry[]
  try {
    entries = readZip(archive)
  } catch (cause) {
    throw new SkillPackageValidationError(`zip parse failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  }

  // ② 条目数 ≤ 50。
  if (entries.length > MAX_SKILL_PACKAGE_ENTRIES) {
    throw new SkillPackageValidationError(`zip declares ${String(entries.length)} entries (max ${String(MAX_SKILL_PACKAGE_ENTRIES)})`)
  }

  // ③ 条目名安全。
  for (const entry of entries) {
    const reason = unsafeEntryNameReason(entry.name)
    if (reason !== undefined) {
      throw new SkillPackageValidationError(`unsafe entry name ${JSON.stringify(entry.name)}: ${reason}`)
    }
  }

  // ① 声明的总解压大小 ≤ 5 MiB（解压前预算，防压缩炸弹；惰性 data()
  //    保证到这一步为止没有解压过任何字节）。
  let totalBytes = 0
  for (const entry of entries) totalBytes += entry.declaredSize
  if (totalBytes > MAX_SKILL_PACKAGE_UNCOMPRESSED_BYTES) {
    throw new SkillPackageValidationError(`zip declares ${String(totalBytes)} uncompressed bytes (max ${String(MAX_SKILL_PACKAGE_UNCOMPRESSED_BYTES)})`)
  }

  // ④ 第一层恰一个目录且目录名 == 包 id（顶层平文件不算目录）。
  const topSegments = new Set<string>()
  for (const entry of entries) {
    const slash = entry.name.indexOf('/')
    if (slash < 0) {
      throw new SkillPackageValidationError(`entry outside the package directory: ${JSON.stringify(entry.name)}`)
    }
    topSegments.add(entry.name.slice(0, slash))
  }
  if (topSegments.size !== 1 || !topSegments.has(id)) {
    throw new SkillPackageValidationError(`zip root must contain exactly one directory named "${id}"`)
  }

  // ⑤ <id>/SKILL.md 存在且 frontmatter name == id。
  const skillEntry = entries.find(entry => entry.name === `${id}/SKILL.md` && !entry.isDirectory)
  if (skillEntry === undefined) {
    throw new SkillPackageValidationError(`missing ${id}/SKILL.md`)
  }
  const frontmatterName = parseFrontmatterName(skillEntry.data().toString('utf8'))
  if (frontmatterName !== id) {
    throw new SkillPackageValidationError(`SKILL.md frontmatter name must equal the package id "${id}"`)
  }

  return entries.filter(entry => !entry.isDirectory)
}

/** 原子落盘一个包：tmp 目录写全量 → 旧目录退位到 trash → rename 到位。 */
async function installSkillPackage(root: string, id: string, entries: readonly ZipEntry[], timestamp: number): Promise<void> {
  const temp = join(root, `${TMP_PREFIX}${id}-${String(timestamp)}`)
  await rm(temp, { recursive: true, force: true })
  await mkdir(temp, { recursive: true })
  try {
    for (const entry of entries) {
      const target = join(temp, entry.name)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, entry.data())
    }
    const final = join(root, id)
    if (await pathExists(final)) {
      const trash = join(root, `${TRASH_PREFIX}${id}-${String(timestamp)}`)
      await rename(final, trash)
      await rm(trash, { recursive: true, force: true })
    }
    // 同一卷内的目录 rename 是原子操作；观察者要么看到旧目录要么看到新目录。
    await rename(join(temp, id), final)
  } finally {
    await rm(temp, { recursive: true, force: true })
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/** 执行一次完整同步：拉目录（失败静默放弃）→ diff → 下载 → 校验 → 落盘 → 状态回写。 */
export async function syncSkillPackages(deps: SkillSyncDependencies): Promise<SkillSyncOutcome> {
  const warn = deps.warn ?? ((): void => {})
  let catalog: SkillPackageCatalog
  try {
    catalog = await deps.fetchCatalog()
  } catch (cause) {
    warn(`dsh-plugin-chengzi-experts: skill package catalog unreachable; keeping local packages: ${cause instanceof Error ? cause.message : String(cause)}`)
    return { catalog: 'unreachable', synced: [], skipped: [], rejected: [] }
  }

  await sweepSyncScratch(deps.root)
  const state = await readSyncState(deps.root)
  const next: Record<string, number> = { ...state }
  const synced: string[] = []
  const skipped: string[] = []
  const rejected: string[] = []
  const seen = new Set<string>()
  const timestamp = (deps.now ?? ((): Date => new Date()))().getTime()

  for (const row of catalog.packages) {
    if (seen.has(row.id)) continue
    seen.add(row.id)
    if ((state[row.id] ?? 0) >= row.version) {
      skipped.push(row.id)
      continue
    }
    let archive: Buffer
    try {
      archive = await deps.downloadPackage(row.id)
    } catch (cause) {
      warn(`dsh-plugin-chengzi-experts: skill package "${row.id}" download failed; skipped: ${cause instanceof Error ? cause.message : String(cause)}`)
      continue
    }
    try {
      const entries = validateSkillPackage(row.id, archive)
      await installSkillPackage(deps.root, row.id, entries, timestamp)
    } catch (cause) {
      rejected.push(row.id)
      warn(`dsh-plugin-chengzi-experts: skill package "${row.id}" rejected: ${cause instanceof Error ? cause.message : String(cause)}`)
      continue
    }
    next[row.id] = row.version
    synced.push(row.id)
  }

  await writeSyncState(deps.root, next)
  return { catalog: 'cloud', synced, skipped, rejected }
}

/** 技能包同步节律状态机：与专家目录同步同触发点（启动/周期/超龄）。 */
export interface SkillPackageSyncState {
  /** 立即同步一次（并发调用共享同一次在途 Promise；永不 reject——失败静默）。 */
  syncNow(): Promise<void>
  /** 超过 maxAgeMs 未同步则补一次（同样永不 reject）。 */
  syncIfStale(maxAgeMs: number): Promise<void>
}

/** 创建技能包同步状态机。
 * @param deps - 同步依赖（技能根目录、远端目录拉取、单包下载）。 */
type SkillSyncDeps = SkillSyncDependencies & { readonly warn?: (message: string) => void }

export function createSkillPackageSyncState(deps: SkillSyncDeps): SkillPackageSyncState {
  // -Infinity 表示「从未同步」：syncIfStale 的超龄判定对首次触发恒为真。
  let lastSyncAt = Number.NEGATIVE_INFINITY
  let inFlight: Promise<void> | undefined

  const run = (): Promise<void> => {
    if (inFlight !== undefined) return inFlight
    const attempt = syncSkillPackages(deps)
      .then((): void => {
        lastSyncAt = Date.now()
      })
      .catch((cause: unknown): void => {
        // 本地文件系统故障也要静默：记 warn，等下一轮。
        lastSyncAt = Date.now()
        deps.warn?.(`dsh-plugin-chengzi-experts: skill package sync failed: ${cause instanceof Error ? cause.message : String(cause)}`)
      })
      .finally((): void => {
        inFlight = undefined
      })
    inFlight = attempt
    return attempt
  }

  return {
    syncNow: run,
    syncIfStale: async (maxAgeMs: number): Promise<void> => {
      if (Date.now() - lastSyncAt > maxAgeMs) await run()
    },
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
