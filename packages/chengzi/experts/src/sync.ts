/** 专家目录同步编排：拉远端（失败→内置清单兜底）→ 与本地物化状态 diff → 增/改/删。
 *
 *  领地规则（红线）：
 *  - 只读写 `<DSH_HOME>/.agent-presets/` 下以 `expert-` 开头的目录；
 *  - `expert-mine-*`（Phase B 用户自建命名空间）与一切不以 `expert-` 开头的
 *    用户目录一律不碰、永不覆盖；
 *  - 远端 GET 成功才用远端清单做删除判定（enabled=false / 远端消失 → 删目录）；
 *    降级到内置清单时只补缺失/过期项，不删除任何目录——瞬时网络故障
 *    不允许把云端已物化的专家撤走。
 *
 *  同步语义（对齐云端契约）：
 *  - 行 version > 本地 chengzi-expert.json.version，或本地无物化 → 重写目录；
 *  - version 不变（含本地更高）→ 不动；
 *  - 物化失败（如 standard 缺 persona 行）→ 跳过该专家并记日志，不影响其余行。
 */

import { readdir } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { CatalogResponse, ExpertDef } from './expert-types.js'
import { EXPERT_ID_PATTERN, EXPERT_MINE_PREFIX } from './expert-types.js'
import { BUILTIN_EXPERTS } from './builtin-experts.js'
import { ChengziExpertsError } from './expert-client.js'
import {
  materializeExpertDirectory,
  MissingPersonaRowError,
  readExpertMetadata,
  removeExpertDirectory,
} from './materialize.js'

/** Host 进程的 DSH home（桌面主进程已写入 process.env.DSH_HOME）。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME !== undefined && env.DSH_HOME.length > 0 ? env.DSH_HOME : join(homedir(), '.dsh')
}

/** 专家 preset 根目录：dsh-agent-presets 的用户可写根（`.agent-presets`）。 */
export function expertsPresetRoot(dshHome: string): string {
  return join(dshHome, '.agent-presets')
}

/** standard 不可读时的兜底组合：仅 persona 行（宿主组合仍供给基础注册表）。
 *  0.2 起 effective standard 组合经 `agentPresets.readDocument('standard')`
 *  获取（见 preset-composition.ts）；本文件级兜底仅供物化目录使用。 */
export function fallbackComposition(persona: string): string {
  const lines = persona.split(/\r?\n/u).map(line => line.trimEnd())
  return [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    suffix: Your working directory is {{cwd}}.',
    '    prefix: >-',
    ...lines.map(line => (line.length === 0 ? '' : `      ${line}`)),
  ].join('\n') + '\n'
}

/** 一次同步的结果摘要（诊断与测试断言用）。 */
export interface SyncOutcome {
  /** 本次生效清单来源。 */
  readonly source: 'cloud' | 'builtin'
  /** 生效（enabled）专家清单；降级时为内置表。 */
  readonly experts: readonly ExpertDef[]
  /** 本次（重）物化的目录名。 */
  readonly materialized: readonly string[]
  /** 本次删除的目录名。 */
  readonly removed: readonly string[]
}

/** 同步依赖注入面（测试以临时目录+伪 fetch 注入）。 */
export interface SyncDependencies {
  /** preset 根目录。 */
  readonly root: string
  /** 远端目录拉取；reject 视为远端失败（触发内置兜底）。 */
  readonly fetchCatalog: () => Promise<CatalogResponse>
  /** shipped standard 组合全文的读取器；undefined 时使用 persona-only 兜底组合。 */
  readonly standardText: () => string | undefined
  /** 物化时间源（测试可固定）。 */
  readonly now?: () => Date
  /** 诊断日志接收者。 */
  readonly warn?: (message: string) => void
}

/** 列出本地领地内的专家目录（expert-* 且非 expert-mine-*）。 */
async function listLocalExpertDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((): never[] => [])
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && EXPERT_ID_PATTERN.test(entry.name) && !entry.name.startsWith(EXPERT_MINE_PREFIX)) {
      names.push(entry.name)
    }
  }
  return names
}

/** 执行一次完整同步：拉清单（或兜底）→ diff → 增/改/删。 */
export async function syncExpertPresets(deps: SyncDependencies): Promise<SyncOutcome> {
  const warn = deps.warn ?? ((): void => {})
  let rows: readonly ExpertDef[]
  let source: 'cloud' | 'builtin'
  try {
    const catalog = await deps.fetchCatalog()
    rows = catalog.experts
    source = 'cloud'
  } catch (cause) {
    if (cause instanceof ChengziExpertsError && cause.code === 'invalid-response' && cause.message.includes('base URL')) {
      // 配置性失败（base URL 非法）与网络故障同路：兜底，但在日志里保留类别。
      warn('dsh-plugin-chengzi-experts: experts catalog unreachable (invalid base URL); falling back to builtin experts')
    } else {
      warn(`dsh-plugin-chengzi-experts: experts catalog unreachable; falling back to builtin experts: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    rows = BUILTIN_EXPERTS
    source = 'builtin'
  }

  // 期望集：合法 id、非用户命名空间、按 id 去重（首行胜出）。
  const desired = new Map<string, ExpertDef>()
  for (const row of rows) {
    if (!EXPERT_ID_PATTERN.test(row.id) || row.id.startsWith(EXPERT_MINE_PREFIX)) continue
    if (!desired.has(row.id)) desired.set(row.id, row)
  }

  const local = await listLocalExpertDirectories(deps.root)
  const materialized: string[] = []
  const removed: string[] = []
  const now = deps.now ?? ((): Date => new Date())

  for (const [id, expert] of desired) {
    if (!expert.enabled) {
      if (local.includes(id)) {
        await removeExpertDirectory(deps.root, id)
        removed.push(id)
      }
      continue
    }
    const meta = await readExpertMetadata(deps.root, id)
    if (meta !== undefined && meta.expert.version >= expert.version) continue
    const standardText = deps.standardText()
    if (standardText === undefined) {
      warn('dsh-plugin-chengzi-experts: shipped standard composition unreadable; materializing persona-only presets')
    }
    try {
      await materializeExpertDirectory(deps.root, expert, {
        standardText: standardText ?? fallbackComposition(expert.persona),
        source,
        now: now(),
      })
      materialized.push(id)
    } catch (cause) {
      if (cause instanceof MissingPersonaRowError) {
        warn(`dsh-plugin-chengzi-experts: skipped expert "${id}": ${cause.message}`)
        continue
      }
      throw cause
    }
  }

  // 领地内多余目录：仅云端清单权威时删除（远端下架）；降级模式保留。
  if (source === 'cloud') {
    for (const id of local) {
      if (desired.has(id)) continue
      await removeExpertDirectory(deps.root, id)
      removed.push(id)
    }
  }

  const experts = [...desired.values()].filter(row => row.enabled)
  return { source, experts, materialized, removed }
}

/** 目录同步节律状态机：启动同步 + 周期刷新 + 按需（超龄触发）同步。 */
export interface ExpertCatalogState {
  /** 立即同步一次（并发调用共享同一次在途 Promise）。 */
  syncNow(): Promise<SyncOutcome>
  /** 超过 maxAgeMs 未同步则先同步，再返回当前生效清单。 */
  serve(maxAgeMs: number): Promise<CatalogResponse>
}

/** 创建目录同步状态机。
 * @param deps - 同步依赖（根目录、远端拉取、standard 组合文本）。
 * @param initialFailureAsBuiltin - 首次同步失败时是否仍暴露内置清单（true：serve 永不 reject）。 */
export function createExpertCatalogState(deps: SyncDependencies & { readonly warn?: (message: string) => void }): ExpertCatalogState {
  // -Infinity 表示「从未同步」：serve 的超龄判定对首个请求恒为真。
  let lastSyncAt = Number.NEGATIVE_INFINITY
  let experts: readonly ExpertDef[] = BUILTIN_EXPERTS
  let source: 'cloud' | 'builtin' = 'builtin'
  let inFlight: Promise<SyncOutcome> | undefined

  const run = (): Promise<SyncOutcome> => {
    if (inFlight !== undefined) return inFlight
    const attempt = syncExpertPresets(deps)
      .then((outcome) => {
        lastSyncAt = Date.now()
        experts = outcome.experts
        source = outcome.source
        return outcome
      })
      .finally(() => {
        inFlight = undefined
      })
    inFlight = attempt
    return attempt
  }

  return {
    syncNow: run,
    serve: async (maxAgeMs: number): Promise<CatalogResponse> => {
      if (Date.now() - lastSyncAt > maxAgeMs) {
        try {
          await run()
        } catch (cause) {
          // 同步失败不阻断路由：回落到上一次（或内置初值）清单。
          deps.warn?.(`dsh-plugin-chengzi-experts: catalog sync failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
      }
      return { experts, source }
    },
  }
}
