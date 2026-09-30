/** Standard composition acquisition and expert preset definitions.
 *
 *  0.2 的 agent preset 只有一条装载路径：`agentPresets.register(PresetDefinition)`
 *  （shipped 组合经 composition 行声明；不再有 `.agent-presets` 文件扫描）。
 *  「专家 = standard 组合换 persona 行 prefix」的语义保留，因此本模块负责：
 *
 *  - 从 registry 读取 effective standard 组合（`readDocument('standard')`——
 *    比 0.1 读 shipped 文件更准：profile 后续 patch 层改写的行也包含在内）；
 *    preset-standard 行与插件行是同层兄弟，激活顺序无保证，所以带界轮询；
 *  - 把组合文本解析成 entry list（js-yaml + entryListSchema；`!!js` 表达式按
 *    loader 方言保真为表达式节点，挂载时由 prepareProfileEntries 求值）；
 *  - 生成专家的 `PresetDefinition`（对象域替换 persona 行的 prefix，其余行
 *    逐字保留；组合缺 persona 行时显式失败，宁可没有不能错）。
 * @module dsh-plugin-chengzi-experts/preset-composition
 */

import { load as loadYaml } from 'js-yaml'
import { entryListSchema } from '@deepseek-ai/cordis-plugin-include'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ExpertDef } from './expert-types.js'
import { EXPERT_PRESET_ORDER, MissingPersonaRowError } from './materialize.js'

/** One parsed composition row（loader entry options；`!!js` 标量解析为表达式节点）. */
export type CompositionRow = PresetDefinition['plugins'][number]

/** The document the registry returns for one declared preset. */
export interface PresetDocument {
  readonly agentPreset: string
  readonly content: string
}

/** Registry slice this module needs；tests substitute a structural fake. */
export interface AgentPresetReader {
  readDocument(agentPreset: string): Promise<PresetDocument>
}

/** 一次 standard 组合获取的结果：registry 的 dump 原文 + 解析后的 entry list. */
export interface StandardComposition {
  /** readDocument 返回的组合全文（同时是物化目录 agent.cordis.yml 的文本源）. */
  readonly text: string
  /** 解析后的顶层插件行（专家 preset 定义的对象域底稿）. */
  readonly rows: readonly CompositionRow[]
}

/** 解析一份组合文本为顶层插件行；非列表形状返回空列表（调用方按不可用处理）。 */
export function parseCompositionRows(text: string): readonly CompositionRow[] {
  let rows: unknown
  try {
    rows = loadYaml(text, { schema: entryListSchema })
  } catch {
    return []
  }
  return Array.isArray(rows) ? rows as readonly CompositionRow[] : []
}

/** 顶层 persona 行的 id（与 shipped standard 及 0.1 物化器同一锚点）。 */
const PERSONA_ROW_ID = 'persona'

function isPersonaRow(row: CompositionRow): boolean {
  return (row as { id?: unknown }).id === PERSONA_ROW_ID
}

function configOf(row: CompositionRow): Record<string, unknown> {
  const config = (row as { config?: unknown }).config
  return typeof config === 'object' && config !== null && !Array.isArray(config)
    ? config as Record<string, unknown>
    : {}
}

/** 把行列表的 persona 行 prefix 换成专家人格；其余行逐字保留（浅拷贝替换）。
 * @throws {MissingPersonaRowError} 行列表不携带 persona 行（宁可没有不能错）。 */
export function withPersonaPrefix(rows: readonly CompositionRow[], persona: string): readonly CompositionRow[] {
  if (!rows.some(isPersonaRow)) {
    throw new MissingPersonaRowError('The standard composition no longer carries a top-level persona row.')
  }
  return rows.map(row => isPersonaRow(row)
    ? { ...row, config: { ...configOf(row), prefix: persona } }
    : row)
}

/** standard 不可读时的兜底组合行：仅 persona 行（suffix 与 shipped standard 一致）。 */
export function personaOnlyRows(persona: string): readonly CompositionRow[] {
  return [
    {
      id: PERSONA_ROW_ID,
      name: '@deepseek-ai/dsh-persona',
      config: { suffix: 'Your working directory is {{cwd}}.', prefix: persona },
    },
  ]
}

/** 组装一位专家的 preset 定义（id 即 preset id；order 排在 shipped 之后）。
 * @throws {MissingPersonaRowError} 行列表不携带 persona 行。 */
export function expertPresetDefinition(expert: ExpertDef, rows: readonly CompositionRow[]): PresetDefinition {
  return {
    id: expert.id,
    name: expert.name,
    description: expert.description,
    order: EXPERT_PRESET_ORDER,
    plugins: withPersonaPrefix(rows, expert.persona),
  }
}

/** 轮询参数默认值：preset-standard 行通常与插件同批激活，数百毫秒内可得。 */
const DEFAULT_ATTEMPTS = 240
const DEFAULT_DELAY_MS = 500

/** 轮询等待参数。 */
export interface StandardReadOptions {
  /** 总尝试次数（含首次）；耗尽后返回 undefined。 */
  readonly attempts?: number
  /** 相邻两次尝试的间隔毫秒。 */
  readonly delayMs?: number
  /** 每次等待后的回调（诊断日志用）。 */
  readonly onWait?: (attempt: number, cause: unknown) => void
}

/**
 * 从 registry 读取 effective standard 组合；preset-standard 行尚未声明时按
 * 界轮询等待。永不 reject——耗尽后返回 undefined（调用方降级 persona-only）。
 * @param reader - registry 的 readDocument 切片。
 * @param options - 轮询参数。
 */
export async function readStandardComposition(
  reader: AgentPresetReader,
  options: StandardReadOptions = {},
): Promise<StandardComposition | undefined> {
  const attempts = options.attempts ?? DEFAULT_ATTEMPTS
  const delayMs = options.delayMs ?? DEFAULT_DELAY_MS
  let lastCause: unknown = new Error('the standard preset was never declared')
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (attempt > 0) {
      options.onWait?.(attempt, lastCause)
      await new Promise<void>((resolve) => { setTimeout(resolve, delayMs) })
    }
    try {
      const document = await reader.readDocument('standard')
      const text = document.content
      const rows = parseCompositionRows(text)
      if (rows.length === 0) {
        lastCause = new Error('the standard preset declared an empty composition')
        continue
      }
      return { text, rows }
    } catch (cause) {
      lastCause = cause
    }
  }
  return undefined
}
