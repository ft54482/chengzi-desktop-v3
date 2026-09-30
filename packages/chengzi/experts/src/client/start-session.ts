/** 以专家开局新会话：catalog 校验 → 建会话 → 切 preset → 打开会话 →
 *  预填开局引导草稿 → 记录 sessionId→expert 映射（dock 卡展示判定）。
 *
 *  开局引导走契约通道，不伪造 assistant 消息：
 *  - 草稿预填：`ctx.conversation.input.for(actx).setDraft(text)`（按会话持久化）；
 *  - 会话内卡片：conversation.input.dock 槽位（expert-dock.tsx）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { CatalogResponse, ExpertDef } from '../expert-types.js'

/** Client-facing catalog route path served by the Host web server. */
export const EXPERTS_CATALOG_ROUTE = '/plugins/chengzi-experts/catalog'

/** guided_intro 里费用占位符。 */
const COST_HINT_PLACEHOLDER = '{cost_hint}'

/** sessionId → 专家 的内存映射；dock 卡据此判定当前会话是否专家开局。 */
export const expertSessions = new Map<string, ExpertDef>()

/** 映射上限：会话关闭不回收，超限淘汰最旧条目。 */
const MAX_TRACKED_SESSIONS = 256

/** 目录缓存（host 路由 no-store，client 侧短缓存避免每次开菜单都拉取）。 */
const CATALOG_CACHE_MS = 60_000
let catalogCache: { readonly experts: readonly ExpertDef[]; readonly at: number } | undefined
let catalogPending: Promise<readonly ExpertDef[]> | undefined

function trackExpertSession(sessionId: string, expert: ExpertDef): void {
  if (expertSessions.size >= MAX_TRACKED_SESSIONS && !expertSessions.has(sessionId)) {
    const oldest = expertSessions.keys().next().value
    if (typeof oldest === 'string') expertSessions.delete(oldest)
  }
  expertSessions.set(sessionId, expert)
}

/** 渲染 guided_intro：删掉 `{cost_hint}` 占位符——开局草稿不提费用（用户反馈
 *  易劝退）；付费口径由工具确认卡在客户真正触发生成时提示。 */
export function guidedIntroText(expert: ExpertDef): string {
  const intro = expert.guided_intro ?? ''
  return intro.split(COST_HINT_PLACEHOLDER).join('').replace(/[ \t]+$/gm, '').trim()
}

function parseCatalogPayload(value: unknown): readonly ExpertDef[] {
  if (typeof value !== 'object' || value === null) return []
  const experts = (value as { experts?: unknown }).experts
  if (!Array.isArray(experts)) return []
  return experts.filter((row): row is ExpertDef =>
    typeof row === 'object' && row !== null && typeof (row as { id?: unknown }).id === 'string')
}

/** 读取专家目录（client 短缓存；失败时回落到上一次缓存，无缓存则抛错）。 */
export function readExpertCatalog(signal?: AbortSignal): Promise<readonly ExpertDef[]> {
  if (catalogCache !== undefined && Date.now() - catalogCache.at < CATALOG_CACHE_MS) {
    return Promise.resolve(catalogCache.experts)
  }
  if (catalogPending !== undefined) return catalogPending
  catalogPending = fetch(EXPERTS_CATALOG_ROUTE, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  })
    .then(async (response) => {
      if (!response.ok) throw new Error(`experts catalog request failed: ${String(response.status)}`)
      const experts = parseCatalogPayload(await response.json() as unknown)
      if (experts.length > 0) catalogCache = { experts, at: Date.now() }
      return experts
    })
    .finally(() => {
      catalogPending = undefined
    })
  return catalogPending
}

/** 使 client 目录短缓存失效；创建/编辑/删除「我的专家」后调用，
 *  下一次 readExpertCatalog 将重新拉取 host 路由。 */
export function invalidateExpertCatalog(): void {
  catalogCache = undefined
}

/**
 * 以指定专家开局一个新会话。
 *
 * 走 wire 原生：`remote.session.create({ cwd, agentPreset })`，host 在建 agent 时
 * 直接组合预设（composeAgent → mount），创建后 openSession 上台。
 *
 * 工作区解析（缺一不可，否则会话成为孤儿→UI 停在「选择工作区」，用户选完
 * 工作区后上游另建默认预设会话把专家顶掉）。注意：传 cwd 只设定会话目录、
 * **不**把会话挂进 UI 的工作区注册表，必须传 workspaceId：
 * 1. 当前会话所属的工作区；
 * 2. 工作区列表中「最近使用」的一个（有会话的排前，否则取 updatedAt 最新的）；
 * 3. 都没有（全新安装）才退回 cwd（此时 hero 的工作区选择属上游正常引导）。
 */
export async function startExpertSession(ctx: Context, expert: ExpertDef, initialDraft?: string): Promise<void> {
  const catalog = await readExpertCatalog().catch((): readonly ExpertDef[] => [])
  const resolved = catalog.find(row => row.id === expert.id) ?? expert

  const state = ctx.sessions.list.getSnapshot()
  // 0.2 的 list 快照不再携带 current：主视图保留（retainedBy.mainView）的
  // 行即当前展示会话（ui-agent-preset 用同一判定定位主视图会话）。
  const before = currentMainSessionId(state)
  const beforeRow = before === undefined ? undefined : state.byId[before]
  const workspaceId = pickWorkspaceId(ctx, before)
  const created = await ctx.remote.session.create({
    ...(workspaceId !== undefined
      ? { workspaceId }
      : beforeRow?.cwd !== undefined ? { cwd: beforeRow.cwd } : {}),
    agentPreset: resolved.id,
  })
  if (!created.ok) {
    throw new Error(`以专家开局失败：${created.error.message}`)
  }
  const sessionId = created.value.sessionId
  trackExpertSession(sessionId, resolved)
  ctx.uiWorkspace.openSession(sessionId)
  const actx = ctx.sessions.scope(sessionId)
  const draft = initialDraft ?? (resolved.guided_intro === null ? '' : guidedIntroText(resolved))
  if (actx !== undefined && draft.length > 0) {
    actx.conversation.input.for(actx).setDraft(draft)
  }
}

/** 主视图保留计数的最小形状（目录行的 retainedBy 切片）。 */
interface MainViewRow {
  readonly id: SessionId
  readonly retainedBy: { readonly mainView?: number }
}

/** 主视图当前展示的会话：唯一被 mainView 保留源持有的目录行。 */
function currentMainSessionId(state: { readonly byId: Readonly<Record<string, MainViewRow>> }): SessionId | undefined {
  for (const row of Object.values(state.byId)) {
    if ((row.retainedBy.mainView ?? 0) > 0) return row.id
  }
  return undefined
}

/** 从工作区列表选挂靠目标：当前会话所属者优先，其次「最近使用」（有会话的排前，
 *  否则 updatedAt 最新），返回 workspaceId；列表为空返回 undefined。 */
function pickWorkspaceId(ctx: Context, currentSessionId: SessionId | undefined) {
  const items = ctx.workspaces.list.getSnapshot().items
  if (items.length === 0) return undefined
  if (currentSessionId !== undefined) {
    const owning = items.find(item => item.sessionIds.includes(currentSessionId))
    if (owning !== undefined) return owning.workspaceId
  }
  const used = items.find(item => item.sessionIds.length > 0)
  if (used !== undefined) return used.workspaceId
  return [...items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0]?.workspaceId
}

/** Client 侧目录载荷（host 路由响应形状）。 */
export type { CatalogResponse }
