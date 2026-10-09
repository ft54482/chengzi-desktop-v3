/** One-way sync of the Chengzi Pro platform LLM provider into user settings and credentials.
 *
 *  The pi-ai adapter registers the `llm-pi-ai` settings namespace with zero
 *  providers and resolves its routes from the settings user layer per request,
 *  so writing one provider profile here reaches the next request without a
 *  restart. The settings update is a recursive object merge (arrays replace
 *  wholesale), so the platform's own route is replaced field by field while
 *  every other provider under the namespace stays untouched.
 */

import { credentialKey, credentialRef, type CredentialKey, type CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { listModels, type BffRequest, type ChengziBffModelView } from './bff-client.ts'

/** pi-ai provider route owned by the Chengzi Pro platform. */
export const CHENGZI_PROVIDER_ROUTE = 'chengzi-platform'

/** Credential-record address the pi-ai adapter reads for the platform route (`recordKeyFor`). */
export const CHENGZI_PROVIDER_CREDENTIAL_KEY = credentialKey('llm-pi-ai', CHENGZI_PROVIDER_ROUTE)

/** 模型目录内存缓存（id→元数据），host 路由 `/catalog` 读取后下发 client 做分组/logo。 */
const catalogMeta = new Map<string, ChengziBffModelView>()

/** 读取当前目录缓存（只读视图）。 */
export function getCatalogSnapshot(): ChengziBffModelView[] {
  return [...catalogMeta.values()]
}

/** 查询模型所属的平台计费分组（未收录返回 undefined，调用方回退 vip）。 */
export function getCatalogModelGroup(modelId: string): string | undefined {
  return catalogMeta.get(modelId)?.group
}

/** Credential reference the provider profile resolves per request (`apiKeyEnv`).
 *  pi-ai 按此引用名经 credentials 服务的 ref 面解析（env 未设置时读托管存储）。 */
export const CHENGZI_PLATFORM_API_KEY_REF = credentialRef('CHENGZI_PLATFORM_API_KEY')

/** Platform OpenAI-compatible endpoint.
 *  橙子PRO fork：生产中转平台；可用环境变量 CHENGZI_PLATFORM_BASE_URL 覆盖。
 */
export const CHENGZI_PLATFORM_BASE_URL = process.env.CHENGZI_PLATFORM_BASE_URL
  ?? 'https://pro.nat6.net/v1'

/** 全局默认模型的 settings 命名空间（dsh-agent-default-model 的 section 键）。 */
const AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE = 'agent-default-model'

/** 平台运营钦定的默认模型（2026-09-23 用户拍板：别用 free 模型打底，默认
 *  DeepSeek V4.1 flash）。目录同步时若存在且上架则优先选它；否则退回
 *  「首个免费 → 首个」的既有规则。 */
const PREFERRED_DEFAULT_MODEL_ID = 'deepseek-v4.1-flash'

/** Credential-reference name the provider profile points at; the pi-ai adapter
 *  resolves this route's record per request through the credential seam. */
const CHENGZI_PLATFORM_API_KEY_ENV = 'CHENGZI_PLATFORM_API_KEY'

/** Settings namespace registered by the pi-ai adapter. */
const PIAI_SETTINGS_NAMESPACE = 'llm-pi-ai'

/** Wire protocol the platform endpoint speaks. */
const CHENGZI_PLATFORM_API = 'openai-completions'

/** 桌面开放组 → 路由/凭据 slug（pi-ai 路由名与 env 名只允许 ASCII 字母数字连字符下划线）。
 *  已知组显式映射（gemini官转 等非 ASCII 组名必须转写），未知组走消毒回退。 */
const GROUP_SLUGS: Readonly<Record<string, string>> = Object.freeze({
  vip: 'vip',
  default: 'default',
  deepseek: 'deepseek',
  glm: 'glm',
  kimi: 'kimi',
  qwen: 'qwen',
  minimax: 'minimax',
  'kimi-k3': 'kimi-k3',
  'qwen high': 'qwen-high',
  codex: 'codex',
  'gemini官转': 'gemini',
  'claude-enterprise': 'claude-enterprise',
  'Qwen3-32B-free': 'qwen3-32b-free',
})

function groupSlug(group: string): string {
  const known = GROUP_SLUGS[group]
  if (known !== undefined) return known
  const sanitized = group.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return sanitized === '' ? 'misc' : sanitized
}

/** 计费组 → pi-ai 路由名。vip 组沿用历史单路由名（兼容既有默认模型设置与凭据）。 */
export function chengziGroupProviderRoute(group: string): string {
  return group === 'vip' || group === ''
    ? CHENGZI_PROVIDER_ROUTE
    : `${CHENGZI_PROVIDER_ROUTE}-${groupSlug(group)}`
}

/** 计费组 → 凭据 ref 面/env 名（与该组 provider profile 的 apiKeyEnv 一致）。 */
export function chengziGroupApiKeyEnv(group: string): string {
  return group === 'vip' || group === ''
    ? CHENGZI_PLATFORM_API_KEY_ENV
    : `${CHENGZI_PLATFORM_API_KEY_ENV}_${groupSlug(group).replace(/-/g, '_').toUpperCase()}`
}

/** 计费组 → pi-ai CredentialStore 读取地址（record 面）。 */
function chengziGroupCredentialKey(group: string): CredentialKey {
  return group === 'vip' || group === ''
    ? CHENGZI_PROVIDER_CREDENTIAL_KEY
    : credentialKey('llm-pi-ai', chengziGroupProviderRoute(group))
}

/** 已实测的平台模型部署容量（条目级）。pi-ai 内置模型目录（models.dev 式
 *  快照）里 deepseek-v4.1-flash 的条目 maxTokens=2000 且条目级优先于一切
 *  （catalog 解析链 entry→base→route 默认），把专家会话的单轮输出钉死在
 *  恰好 2000；上游实测 max_tokens=131072 都被接受、上下文 1M 为报错回显
 *  口径。条目级显式声明即部署选择，压过内置目录（catalog.ts 注释明说
 *  "Only a value the profile named is a deployment choice"）。未知模型不写
 *  条目级，保持内置目录能力值与 route 默认兜底。 */
const MEASURED_MODEL_CAPACITY: Readonly<Record<string, {
  readonly contextWindow: number
  readonly maxTokens: number
}>> = {
  'deepseek-v4.1-flash': { contextWindow: 1_048_576, maxTokens: 65_536 },
}

/** Complete provider profile written for the platform route on every sync. */
export interface ChengziProviderProfile {
  readonly displayName: string
  readonly api: typeof CHENGZI_PLATFORM_API
  readonly baseURL: string
  readonly apiKeyEnv: string
  readonly defaultContextWindow: number
  readonly defaultMaxTokens: number
  readonly models: readonly {
    readonly id: string
    readonly name?: string
    readonly contextWindow?: number
    readonly maxTokens?: number
  }[]
}

/** 倍率展示格式：<0.1 保留三位、其余两位，去尾零（0.0548→0.055、0.5479→0.55、2.5→2.5）。 */
export function formatModelRatio(ratio: number): string {
  const rounded = ratio < 0.1 ? ratio.toFixed(3) : ratio.toFixed(2)
  return rounded.replace(/\.?0+$/u, '')
}

/**
 * 选择器显示名：显示名后缀相对橙子Pro 内部原价基准的折扣（组倍率口径，
 * WorkBuddy 式「名称 · N.NNx」；0.38 = 3.8 折）。实付 = 模型倍率×14.6×组倍率，
 * 基准即橙子Pro 原价表，故折扣恒等于组倍率——不随厂商官网价波动，
 * 外部倍率录入错误不再污染徽章（deepseek-v4.1-flash 0.19x 事件，2026-09-22）。
 * 组倍率缺失或为 1（无折扣）不加后缀；免费模型（倍率 0）不加后缀。
 * 按次计费模型（quotaType=1，生图等）没有 token 倍率概念，同样不加尾缀，
 * 单价由选择器目录徽章展示「¥N/次」。
 */
export function modelSelectorName(model: {
  readonly id: string
  readonly displayName?: string
  readonly modelRatio?: number
  readonly discountRatio?: number
  readonly groupRatio?: number
  readonly quotaType?: number
}): string {
  const base = model.displayName ?? model.id
  if (model.quotaType === 1) {
    return base
  }
  if (model.modelRatio !== undefined && (!Number.isFinite(model.modelRatio) || model.modelRatio <= 0)) {
    return base
  }
  // 折扣口径（2026-09-22 用户拍板）：相对橙子Pro 内部原价基准 = 组倍率
  // （实付 = 模型倍率×14.6×组倍率，基准即原价表）。不再用 discountRatio
  // 的厂商官网口径——外部倍率录入错误会污染徽章（deepseek-v4.1-flash
  // 0.19x 事件）。组倍率缺失或为 1（无折扣）不加尾缀。
  const discount = model.groupRatio
  if (typeof discount === 'number' && Number.isFinite(discount) && discount > 0 && discount !== 1) {
    return `${base} · ${formatModelRatio(discount)}x`
  }
  return base
}

/** Settings seam slice this module needs; tests may substitute a structural fake.
 *  写入两个命名空间：llm-pi-ai（provider profile）与 agent-default-model（默认模型联动）。 */
export interface ChengziProviderSettings {
  update(namespace: typeof PIAI_SETTINGS_NAMESPACE | typeof AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, patch: object): Promise<void>
}

/** Host-context slice carrying both seams; tests may substitute structural fakes. */
export interface ChengziProviderSyncContext {
  readonly settings: ChengziProviderSettings
  readonly credentials: Pick<CredentialProvider, 'modifyRecord' | 'set'>
}

/**
 * Build the complete platform provider profile for a catalog.
 * @param modelIds - platform model ids, in server sort order.
 * @returns the profile written under {@link CHENGZI_PROVIDER_ROUTE}.
 */
export function platformProviderProfile(
  models: readonly { readonly id: string; readonly displayName?: string }[],
  overrides: { readonly displayName?: string; readonly apiKeyEnv?: string } = {},
): ChengziProviderProfile {
  return {
    displayName: overrides.displayName ?? '橙子Pro 平台',
    api: CHENGZI_PLATFORM_API,
    baseURL: CHENGZI_PLATFORM_BASE_URL,
    apiKeyEnv: overrides.apiKeyEnv ?? CHENGZI_PLATFORM_API_KEY_ENV,
    defaultContextWindow: 131072,
    defaultMaxTokens: 8192,
    models: models.map((model) => {
      const capacity = MEASURED_MODEL_CAPACITY[model.id]
      return capacity === undefined
        ? { id: model.id, name: modelSelectorName(model) }
        : { id: model.id, name: modelSelectorName(model), ...capacity }
    }),
  }
}

/**
 * Write the platform provider profile into the pi-ai settings namespace.
 *
 * An empty catalog writes nothing: a server misconfiguration must not blank
 * the route's model list (the merge path cannot express removal anyway).
 * @param ctx - Host context carrying the settings seam.
 * @param models - platform catalog entries, in server sort order.
 */
export async function syncPlatformProviderSettings(
  ctx: ChengziProviderSyncContext,
  models: readonly ChengziBffModelView[],
): Promise<void> {
  if (models.length === 0) return
  // 目录缓存收全量（含 image）：select-model 的分组解析与 chengzi-image 生图
  // 插件都要按完整目录取元数据；图像类只是不进聊天 provider，不是不存在。
  catalogMeta.clear()
  for (const model of models) catalogMeta.set(model.id, model)
  // 图像类模型只走平台 /v1/images/generations（chengzi-image 插件代理调用）：
  // 注册成聊天模型用户选中必报错，聊天 provider 注入持续排除。
  const visible = models.filter(model => model.category !== 'image')
  if (visible.length === 0) return
  // 按计费组聚合：每组一个 provider profile（各自的 apiKeyEnv/凭据引用）。
  // 桌面请求按 (provider, model) 路由到所属组钥匙——模型切换钥匙自动跟随
  // （2026-09-24 deepseek-v4.1-flash 默认模型 503 实案根治：vip 钥匙调
  // deepseek 组模型必 503；分组=计费倍率，不能靠加渠道弥合）。
  const groups = new Map<string, ChengziBffModelView[]>()
  for (const model of visible) {
    const group = model.group ?? 'vip'
    const bucket = groups.get(group)
    if (bucket === undefined) groups.set(group, [model])
    else bucket.push(model)
  }
  const providers: Record<string, ChengziProviderProfile> = {
    // 旧单路由显式置空：历史安装的 settings 合并无法表达删除，留着会以
    // vip 钥匙影子暴露全量模型（错倍率计费）。空模型列表=选择器不可见。
    [CHENGZI_PROVIDER_ROUTE]: platformProviderProfile([]),
  }
  for (const [group, groupModels] of groups) {
    const route = chengziGroupProviderRoute(group)
    const isVip = route === CHENGZI_PROVIDER_ROUTE
    providers[route] = platformProviderProfile(groupModels, {
      displayName: isVip ? '橙子Pro 平台' : `橙子Pro 平台 · ${group}`,
      apiKeyEnv: chengziGroupApiKeyEnv(group),
    })
  }
  await ctx.settings.update(PIAI_SETTINGS_NAMESPACE, { providers })
  // 全局默认模型联动目录（平台运营调序/下架后自动跟随）：运营钦定模型
  // （deepseek-v4.1-flash，2026-09-23 用户拍板：默认别用 free 打底）优先；
  // 不在目录则退回「首个免费 → 首个」。provider 必须与模型所属组路由一致，
  // 否则默认会话拿 vip 钥匙调别组模型=503（本次实案根因）。
  const preferred = visible.find(model => model.id === PREFERRED_DEFAULT_MODEL_ID)
  const recommended = preferred ?? visible.find(model => model.free === true) ?? visible[0]
  if (recommended !== undefined) {
    await ctx.settings.update(AGENT_DEFAULT_MODEL_SETTINGS_NAMESPACE, {
      provider: chengziGroupProviderRoute(recommended.group ?? 'vip'),
      model: recommended.id,
    })
  }
}

/**
 * Store the provisioned platform API key for the pi-ai route.
 *
 * 双写：ref 面（`apiKeyEnv` 引用名，pi-ai 逐请求解析的主路径）+ record 面
 * （`llm-pi-ai/chengzi-platform`，pi-ai 自有 CredentialStore 的读取地址）。
 * @param ctx - Host context carrying the credential seam.
 * @param apiKey - non-empty platform API key; never logged.
 */
export async function storePlatformApiKey(
  ctx: ChengziProviderSyncContext,
  apiKey: string,
): Promise<void> {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 8192) {
    throw new Error('dsh-plugin-chengzi-account: the platform API key is invalid.')
  }
  await ctx.credentials.set(CHENGZI_PLATFORM_API_KEY_REF, apiKey)
  await ctx.credentials.modifyRecord(CHENGZI_PROVIDER_CREDENTIAL_KEY, () =>
    Promise.resolve({
      kind: 'api-key' as const,
      key: apiKey,
    }))
}

/** 存单组钥匙（ref 面 + record 面，与该组 provider profile 的 apiKeyEnv 对齐）。
 *  vip 组走 {@link storePlatformApiKey} 的历史常量；其余组各自独立凭据。 */
export async function storePlatformGroupKey(
  ctx: ChengziProviderSyncContext,
  group: string,
  apiKey: string,
): Promise<void> {
  if (typeof apiKey !== 'string' || apiKey.length === 0 || apiKey.length > 8192) {
    throw new Error(`dsh-plugin-chengzi-account: the ${group} group API key is invalid.`)
  }
  await ctx.credentials.set(credentialRef(chengziGroupApiKeyEnv(group)), apiKey)
  await ctx.credentials.modifyRecord(chengziGroupCredentialKey(group), () =>
    Promise.resolve({
      kind: 'api-key' as const,
      key: apiKey,
    }))
}

/** 批量存全组钥匙（登录/开通后一次喂齐；vip 组内部走历史函数保持兼容）。 */
export async function storePlatformGroupKeys(
  ctx: ChengziProviderSyncContext,
  keys: Readonly<Record<string, string>>,
): Promise<void> {
  for (const [group, apiKey] of Object.entries(keys)) {
    await storePlatformGroupKey(ctx, group, apiKey)
  }
}

/** Optional inputs for one combined platform sync. */
export interface ChengziProviderSyncOptions {
  /** Callback resolving the provisioned platform API key; resolved only when provided. */
  readonly getApiKey?: () => Promise<string | undefined> | string | undefined
  /** 全组钥匙映射（组名→key）；与 getApiKey 并行存储到各组凭据。 */
  readonly getKeys?: () => Promise<Record<string, string> | undefined> | Record<string, string> | undefined
  /** BFF origin override for the catalog request. */
  readonly bffBaseUrl?: string
  /** Request implementation override for the catalog request (adapter or test). */
  readonly request?: BffRequest
}

/**
 * Sync the platform provider end to end: fetch the public catalog and write the
 * provider profile, then resolve and store the platform API key.
 *
 * The two halves fail independently — both are always attempted — and the first
 * failure (after both settle) is rethrown for the caller's own catch.
 * @param ctx - Host context carrying the settings and credential seams.
 * @param options - optional key source and BFF origin override.
 */
export async function syncPlatformProvider(
  ctx: ChengziProviderSyncContext,
  options: ChengziProviderSyncOptions = {},
): Promise<void> {
  const catalog = (async () => {
    const response = await listModels({
      ...(options.bffBaseUrl === undefined ? {} : { baseUrl: options.bffBaseUrl }),
      ...(options.request === undefined ? {} : { request: options.request }),
    })
    await syncPlatformProviderSettings(ctx, response.models)
  })()
  const key = options.getApiKey === undefined && options.getKeys === undefined
    ? Promise.resolve(undefined)
    : (async () => {
      const apiKey = options.getApiKey === undefined ? undefined : await options.getApiKey()
      if (apiKey !== undefined) await storePlatformApiKey(ctx, apiKey)
      const keys = options.getKeys === undefined ? undefined : await options.getKeys()
      if (keys !== undefined) await storePlatformGroupKeys(ctx, keys)
    })()
  const [catalogOutcome, keyOutcome] = await Promise.allSettled([catalog, key])
  if (catalogOutcome.status === 'rejected') throw catalogOutcome.reason
  if (keyOutcome.status === 'rejected') throw keyOutcome.reason
}
