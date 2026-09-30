/** 「我的专家」（expert-mine-*，Phase B）的落盘存储：表单校验、id 派生、
 *  ExpertDef 组装与目录增/改/删/列。
 *
 *  落盘复用 materialize.ts 的同一引擎：standard 组合文本级 persona 替换 →
 *  agent.cordis.yml + preset.yml + chengzi-expert.json（source: 'mine'）；
 *  standard 读不到时 persona-only 兜底，与云端物化同路径。领地上只读写
 *  `expert-mine-*` 目录（同步器永不触碰的命名空间）。
 */

import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ExpertDef } from './expert-types.js'
import { EXPERT_ID_PATTERN, EXPERT_MINE_PREFIX } from './expert-types.js'
import {
  EXPERT_METADATA_FILE,
  materializeExpertDirectory,
  parseExpertMetadata,
  readExpertMetadata,
  removeExpertDirectory,
} from './materialize.js'
import type { MineExpertInput } from './mine-types.js'
import { MINE_ALLOWED_TOOLS, MINE_BADGE, MINE_LIMITS } from './mine-types.js'
import { fallbackComposition } from './sync.js'

/** 表单校验失败；fields 携带未通过的字段名（行内红字展示用）。 */
export class MineExpertValidationError extends Error {
  /** 未通过校验的字段名列表。 */
  readonly fields: readonly string[]

  constructor(message: string, fields: readonly string[]) {
    super(message)
    this.name = 'MineExpertValidationError'
    this.fields = fields
  }
}

/** 用户字段硬约束（与表单行内校验同一张表）：见 {@link MINE_LIMITS}。 */

function bounded(value: unknown, min: number, max: number): string {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : ''
}

/** trim 后的有界字符串；越界（非空超限）返回 null 供调用方记入错误字段。 */
function boundedTrim(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > max ? null : trimmed
}

/**
 * 校验并归一化用户表单输入；任何字段不通过即抛 {@link MineExpertValidationError}。
 * @param value - Client 提交的 JSON 反序列化值。
 * @returns 归一化后的输入（字段已 trim；cost_hint 空串=无）。
 */
export function validateMineExpertInput(value: unknown): MineExpertInput {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new MineExpertValidationError('请求体必须是 JSON 对象。', [])
  }
  const row = value as Record<string, unknown>
  const fields: string[] = []

  const name = boundedTrim(row.name, MINE_LIMITS.name)
  if (name === null || name.length === 0) fields.push('name')

  // 图标：trim 后非空、至多 2 个码点（基础 emoji + 可选变体选择符）。
  const icon = bounded(row.icon, 1, 16).trim()
  const iconPoints = Array.from(icon)
  if (iconPoints.length === 0 || iconPoints.length > 2) fields.push('icon')

  const description = boundedTrim(row.description, MINE_LIMITS.description)
  if (description === null) fields.push('description')

  const persona = boundedTrim(row.persona, MINE_LIMITS.persona)
  if (persona === null || persona.length === 0) fields.push('persona')

  const tools = Array.isArray(row.tools)
    ? [...new Set(row.tools.filter((entry): entry is string => typeof entry === 'string'))]
    : []
  if (tools.some(tool => !MINE_ALLOWED_TOOLS.includes(tool))) fields.push('tools')

  const starter_prompts: string[] = []
  if (Array.isArray(row.starter_prompts)) {
    for (const entry of row.starter_prompts) {
      const prompt = typeof entry === 'string' ? entry.trim() : ''
      if (prompt.length === 0) continue
      if (prompt.length > MINE_LIMITS.starterPrompt) {
        fields.push('starter_prompts')
        break
      }
      starter_prompts.push(prompt)
    }
  } else {
    fields.push('starter_prompts')
  }
  if (starter_prompts.length > MINE_LIMITS.starterPrompts) fields.push('starter_prompts')

  const cost_hint = boundedTrim(row.cost_hint, MINE_LIMITS.costHint) ?? ''
  if (typeof row.cost_hint === 'string' && row.cost_hint.trim().length > MINE_LIMITS.costHint) {
    fields.push('cost_hint')
  }

  if (fields.length > 0) {
    throw new MineExpertValidationError(`以下字段未通过校验：${fields.join('、')}`, fields)
  }
  return {
    name: name ?? '',
    icon,
    description: description ?? '',
    persona: persona ?? '',
    tools,
    starter_prompts,
    cost_hint,
  }
}

/** 展示名 → kebab-case slug 段（非 [a-z0-9] 序列折叠为连字符；中文耗尽时回退 'expert'）。 */
export function slugifyMineName(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
    .replace(/-+$/gu, '')
  return slug.length > 0 ? slug : 'expert'
}

/** 列出领地内的「我的专家」目录名（expert-mine-* 且目录形如合法专家 id）。 */
export async function listMineExpertDirectories(root: string): Promise<string[]> {
  const entries = await readdir(root, { withFileTypes: true }).catch((): never[] => [])
  const names: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name.startsWith(EXPERT_MINE_PREFIX) && EXPERT_ID_PATTERN.test(entry.name)) {
      names.push(entry.name)
    }
  }
  return names
}

/** 由展示名 + 时间戳派生唯一 id（`expert-mine-<slug>-<base36 时间>`，撞名时追加序号）。 */
export async function deriveMineExpertId(root: string, name: string, now: Date): Promise<string> {
  const taken = new Set(await listMineExpertDirectories(root))
  const base = slugifyMineName(name)
  const stamp = now.getTime().toString(36)
  let candidate = `${EXPERT_MINE_PREFIX}${base}-${stamp}`
  let counter = 2
  while (taken.has(candidate)) {
    candidate = `${EXPERT_MINE_PREFIX}${base}-${stamp}-${String(counter)}`
    counter += 1
  }
  return candidate
}

/** 由归一化输入组装完整 ExpertDef（派生字段：guided_intro/badge/version 等）。 */
export function buildMineExpertDef(input: MineExpertInput, id: string, version: number): ExpertDef {
  const description = input.description
  const intro = `我是你创建的「${input.name}」专家。${description}`.trim()
    + (input.cost_hint.length > 0 ? ' {cost_hint}' : '')
  return {
    id,
    name: input.name,
    icon: input.icon,
    description,
    persona: input.persona,
    tools: [...input.tools],
    skills: [],
    guided_intro: intro.length > 0 ? intro : null,
    starter_prompts: [...input.starter_prompts],
    cost_hint: input.cost_hint.length > 0 ? input.cost_hint : null,
    model_hint: null,
    badge: MINE_BADGE,
    enabled: true,
    version,
  }
}

/**
 * 读取本地全部「我的专家」（读各目录的 chengzi-expert.json；坏文件跳过不致命）。
 * @param root - preset 根目录。
 * @returns 按名称排序（zh 拼音序，回退 id 序）的专家定义。
 */
export async function listMineExperts(root: string): Promise<ExpertDef[]> {
  const rows: ExpertDef[] = []
  for (const id of await listMineExpertDirectories(root)) {
    const meta = await readExpertMetadata(root, id).catch((): undefined => undefined)
    if (meta === undefined) continue
    const expert = meta.expert
    if (expert.id !== id || !expert.id.startsWith(EXPERT_MINE_PREFIX)) continue
    if (typeof expert.name !== 'string' || expert.name.length === 0 || expert.name.length > MINE_LIMITS.name) continue
    if (typeof expert.persona !== 'string' || expert.persona.length === 0) continue
    rows.push(expert)
  }
  return rows.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN') || a.id.localeCompare(b.id))
}

/** 列出目录中损坏（不可解析）的「我的专家」目录，诊断/测试用。 */
export async function listBrokenMineExperts(root: string): Promise<string[]> {
  const broken: string[] = []
  for (const id of await listMineExpertDirectories(root)) {
    let text: string
    try {
      text = await readFile(join(root, id, EXPERT_METADATA_FILE), 'utf8')
    } catch {
      broken.push(id)
      continue
    }
    if (parseExpertMetadata(text) === undefined) broken.push(id)
  }
  return broken
}

/**
 * 创建或更新一位「我的专家」并物化落盘。
 * @param root - preset 根目录。
 * @param input - 已归一化的表单输入。
 * @param options - id（缺省=新建并派生唯一 id）、standard 组合全文（缺省=persona-only 兜底）与时间。
 * @returns 落盘后的完整专家定义。
 * @throws {MineExpertValidationError} id 越出 expert-mine-* 领地时。
 */
export async function saveMineExpert(
  root: string,
  input: MineExpertInput,
  options: { readonly id?: string | undefined; readonly standardText?: string | undefined; readonly now: Date },
): Promise<ExpertDef> {
  const id = options.id ?? await deriveMineExpertId(root, input.name, options.now)
  if (!id.startsWith(EXPERT_MINE_PREFIX) || !EXPERT_ID_PATTERN.test(id)) {
    throw new MineExpertValidationError('专家 id 越出了「我的专家」命名空间。', ['id'])
  }
  const previous = options.id === undefined ? undefined : await readExpertMetadata(root, options.id).catch((): undefined => undefined)
  const version = (previous?.expert.version ?? 0) + 1
  const expert = buildMineExpertDef(input, id, version)
  await materializeExpertDirectory(root, expert, {
    standardText: options.standardText ?? fallbackComposition(expert.persona),
    source: 'mine',
    now: options.now,
  })
  return expert
}

/**
 * 删除一位「我的专家」目录；仅接受 expert-mine-* 领地内的 id。
 * @throws {MineExpertValidationError} id 越出领地时（防御性，防误删云端专家目录）。
 */
export async function deleteMineExpertDirectory(root: string, id: string): Promise<void> {
  if (!id.startsWith(EXPERT_MINE_PREFIX) || !EXPERT_ID_PATTERN.test(id)) {
    throw new MineExpertValidationError('只能删除「我的专家」。', ['id'])
  }
  await removeExpertDirectory(root, id)
}

/** 把「我的」专家并入目录清单：官方在前、我的在后，按 id 去重（官方行胜出）。 */
export function mergeCatalogWithMine(experts: readonly ExpertDef[], mine: readonly ExpertDef[]): ExpertDef[] {
  const merged = [...experts]
  for (const row of mine) {
    if (merged.some(existing => existing.id === row.id)) continue
    merged.push(row)
  }
  return merged
}
