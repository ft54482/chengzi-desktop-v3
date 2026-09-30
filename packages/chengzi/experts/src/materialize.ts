/** 专家 preset 物化：把「standard 组合 + 专家 persona」写成
 *  `<DSH_HOME>/.agent-presets/<expert-id>/` 下的 preset 目录。
 *
 *  产物三件套：
 *  - `agent.cordis.yml`：与 standard 逐行一致、仅 persona 行的 prefix 换成
 *    专家人格提示词（suffix 原样保留）；
 *  - `preset.yml`：name/description/order 元数据（与 shipped presets 同构）；
 *  - `chengzi-expert.json`：私有元数据（完整 ExpertDef + 来源 + 物化时间），
 *    scanRoot 只认 agent.cordis.yml，多余文件无害，却是画廊与同步 diff 的数据源。
 *
 *  persona 替换是文本级的：不引 YAML 依赖，定位顶层 `- id: persona` 行到
 *  下一个顶层 `- id:` 行（嵌套组行有缩进，不会命中）为 persona 块，块外文本
 *  原样拼接。standard 若不再携带 persona 行（上游变更），物化抛
 *  {@link MissingPersonaRowError} 并由同步器跳过该专家——宁可没有不能错。
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExpertDef } from './expert-types.js'

/** dsh-agent-presets 的组合文件名（目录成为 preset 的判据）。 */
export const COMPOSITION_FILE = 'agent.cordis.yml'

/** dsh-agent-presets 的展示元数据文件名。 */
export const PRESET_METADATA_FILE = 'preset.yml'

/** 本插件的私有元数据文件名（完整 ExpertDef + 来源 + 物化时间）。 */
export const EXPERT_METADATA_FILE = 'chengzi-expert.json'

/** 物化出的 preset 在 preset 选择器里的排序值（shipped 1~3 之后、用户预设之前）。 */
export const EXPERT_PRESET_ORDER = 50

/** standard 变更（无 persona 行）时的显式失败；同步器据此跳过该专家。 */
export class MissingPersonaRowError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MissingPersonaRowError'
  }
}

/** 顶层 persona 行（列首无缩进；嵌套组行有 4 空格缩进，不会命中）。 */
const PERSONA_START_PATTERN = /^- id: persona[ \t]*$/m

/** 下一个顶层插件行（列首无缩进的 `- id:`）。 */
const NEXT_TOP_ROW_PATTERN = /^- id:/m

/** persona 块内的 suffix 行（原样保留）。 */
const SUFFIX_LINE_PATTERN = /^([ \t]+suffix:[^\n]*)$/m

/** 把 standard 组合文本的 persona 行 prefix 替换为专家人格提示词。
 *
 * 块外文本逐字节保留（含行尾风格）；新 persona 块沿用 standard 的行尾与
 * suffix 行，prefix 以折叠块量 `>-` 写出（指示符独占一行，全部内容行
 * 6 空格缩进——与 shipped standard 自身的写法一致；YAML 规范不允许
 * 折叠量内容与 `>-` 同行）。折叠后多行成为单行，与 standard persona 的
 * 实际解析结果一致。
 * @param standardText - shipped standard 组合全文。
 * @param persona - 专家人格提示词（多行文本）。
 * @returns 替换后的组合全文。
 * @throws {MissingPersonaRowError} standard 未携带顶层 persona 行。 */
export function replacePersonaPrefix(standardText: string, persona: string): string {
  const startMatch = PERSONA_START_PATTERN.exec(standardText)
  if (startMatch === null) {
    throw new MissingPersonaRowError('The standard composition no longer carries a top-level persona row.')
  }
  const start = startMatch.index
  const afterStart = start + startMatch[0].length
  const nextMatch = NEXT_TOP_ROW_PATTERN.exec(standardText.slice(afterStart))
  const end = nextMatch === null ? standardText.length : afterStart + nextMatch.index
  const block = standardText.slice(start, end)

  const suffixLine = SUFFIX_LINE_PATTERN.exec(block)?.[1]
  const eol = block.includes('\r\n') ? '\r\n' : '\n'
  const personaLines = persona.split(/\r?\n/u).map(line => line.trimEnd())

  const rows: string[] = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    ...(suffixLine === undefined ? [] : [suffixLine]),
    '    prefix: >-',
    ...personaLines.map(line => (line.length === 0 ? '' : `      ${line}`)),
  ]
  return standardText.slice(0, start) + rows.join(eol) + eol + standardText.slice(end)
}

/** 渲染 preset 展示元数据文件内容（preset.yml）。 */
export function renderPresetMetadataFile(expert: ExpertDef): string {
  return `name: ${expert.name}\ndescription: ${expert.description}\norder: ${EXPERT_PRESET_ORDER}\n`
}

/** 清单来源：云端、内置兜底，或用户自建（expert-mine-*，Phase B）。 */
export type ExpertSource = 'cloud' | 'builtin' | 'mine'

/** 物化目录内的私有元数据形状。 */
export interface MaterializedExpertMeta {
  /** 物化时的专家定义快照。 */
  readonly expert: ExpertDef
  /** 清单来源：云端、内置兜底或用户自建。 */
  readonly source: ExpertSource
  /** 物化时间（ISO 8601）。 */
  readonly materializedAt: string
}

/** 渲染私有元数据文件内容（chengzi-expert.json）。 */
export function renderExpertMetadataFile(expert: ExpertDef, source: ExpertSource, now: Date): string {
  const meta: MaterializedExpertMeta = { expert, source, materializedAt: now.toISOString() }
  return `${JSON.stringify(meta, null, 2)}\n`
}

/** 解析私有元数据；缺失/损坏/形状不符一律视为「version 0」（下次同步重写）。 */
export function parseExpertMetadata(text: string): MaterializedExpertMeta | undefined {
  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  const expert = record.expert
  if (typeof expert !== 'object' || expert === null || Array.isArray(expert)) return undefined
  const row = expert as Record<string, unknown>
  if (typeof row.id !== 'string' || typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) return undefined
  const source = record.source === 'cloud' || record.source === 'builtin' || record.source === 'mine' ? record.source : undefined
  if (source === undefined) return undefined
  return {
    expert: row as unknown as ExpertDef,
    source,
    materializedAt: typeof record.materializedAt === 'string' ? record.materializedAt : '',
  }
}

/** 物化一位专家的 preset 目录（已存在的目录整体重写）。
 * @param root - preset 根目录（`<DSH_HOME>/.agent-presets`）。
 * @param expert - 专家定义。
 * @param options - standard 组合全文、清单来源与物化时间。
 * @returns 物化出的目录绝对路径。 */
export async function materializeExpertDirectory(
  root: string,
  expert: ExpertDef,
  options: { readonly standardText: string; readonly source: ExpertSource; readonly now?: Date },
): Promise<string> {
  const directory = join(root, expert.id)
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, COMPOSITION_FILE), replacePersonaPrefix(options.standardText, expert.persona), 'utf8')
  await writeFile(join(directory, PRESET_METADATA_FILE), renderPresetMetadataFile(expert), 'utf8')
  await writeFile(join(directory, EXPERT_METADATA_FILE), renderExpertMetadataFile(expert, options.source, options.now ?? new Date()), 'utf8')
  return directory
}

/** 删除一位专家的物化目录（不存在时静默）。 */
export async function removeExpertDirectory(root: string, expertId: string): Promise<void> {
  await rm(join(root, expertId), { recursive: true, force: true })
}

/** 读取一位专家的私有元数据；目录缺失返回 undefined。 */
export async function readExpertMetadata(root: string, expertId: string): Promise<MaterializedExpertMeta | undefined> {
  let text: string
  try {
    text = await readFile(join(root, expertId, EXPERT_METADATA_FILE), 'utf8')
  } catch {
    return undefined
  }
  return parseExpertMetadata(text)
}
