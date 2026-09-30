/** 「我的专家」云端备份/恢复编排：登录会话读取 + 401 轮换 + 逐行同步。
 *
 *  复用 chengzi-account 的凭据封印机制（Renderer 永不持有 token）：host 侧
 *  读 `chengzi-account/session` 授权记录，带着 Bearer 访问 BFF 的
 *  /api/v1/custom-experts*；访问 token 过期（401）时用 refresh token 轮换一次
 *  并持久化新授权，再重放原调用。未登录（无会话记录）抛
 *  {@link SessionRequiredError}，路由层映射为 401，Client 提示先登录。
 */

import {
  ChengziBffError,
  loadSession,
  refreshChengziBffTokens,
  saveSession,
  type ChengziSessionContext,
} from 'dsh-plugin-chengzi-account'
import type { ExpertDef } from './expert-types.js'
import { ChengziExpertsError } from './expert-client.js'
import type { ExpertsRequest } from './expert-client.js'
import type { CustomExpertsRequestOptions } from './custom-experts-client.js'
import { listCustomExperts, putCustomExpert } from './custom-experts-client.js'
import type { MineBackupResult, MineFailure, MineRestoreResult } from './mine-types.js'
import { fallbackComposition } from './sync.js'
import { materializeExpertDirectory } from './materialize.js'

/** 会话缺失（未登录）的显式失败；路由层映射为 401 + 登录引导文案。 */
export class SessionRequiredError extends Error {
  constructor(message = '请先在设置中登录橙子Pro 账号') {
    super(message)
    this.name = 'SessionRequiredError'
  }
}

/** 会话封印所需的 Host 上下文切片（与 chengzi-account 的会话上下文同构）。 */
export type MineCloudContext = ChengziSessionContext

/** 一次认证调用的依赖面（测试可注入伪凭据与伪传输）。 */
export interface MineCloudCallDeps {
  /** Host 上下文（credentials 封印）。 */
  readonly ctx: MineCloudContext
  /** BFF origin。 */
  readonly baseUrl: string
  /** 调用方取消信号。 */
  readonly signal?: AbortSignal
  /** Request implementation for a test or an adapter. */
  readonly request?: ExpertsRequest
}

/** 回调拿到的请求选项（access token 由会话封印供给）。 */
export type MineCloudCallOptions = Omit<CustomExpertsRequestOptions, 'accessToken'>

/**
 * 用存储的登录会话执行一次 BFF 调用；401 时轮换 token 一次并重放。
 * @throws {SessionRequiredError} 本机无登录会话。
 * @throws {ChengziBffError} 轮换失败（含 refresh token 失效的 401）。
 * @throws {ChengziExpertsError} 轮换后重放仍失败，或原失败与鉴权无关。
 */
export async function withChengziSession<T>(
  deps: MineCloudCallDeps,
  call: (accessToken: string, options: MineCloudCallOptions) => Promise<T>,
): Promise<T> {
  const session = await loadSession(deps.ctx)
  if (session === undefined) throw new SessionRequiredError()
  const options: MineCloudCallOptions = {
    baseUrl: deps.baseUrl,
    ...(deps.signal === undefined ? {} : { signal: deps.signal }),
    ...(deps.request === undefined ? {} : { request: deps.request }),
  }
  try {
    return await call(session.accessToken, options)
  } catch (cause) {
    if (!(cause instanceof ChengziExpertsError) || cause.status !== 401) throw cause
    const pair = await refreshChengziBffTokens(session.refreshToken, options)
    await saveSession(deps.ctx, {
      accessToken: pair.accessToken,
      refreshToken: pair.refreshToken,
      phone: session.phone,
    })
    return await call(pair.accessToken, options)
  }
}

/** 备份/恢复共享的依赖面。 */
export interface MineCloudSyncDeps extends MineCloudCallDeps {
  /** 诊断日志接收者（失败逐行记录，不抛出）。 */
  readonly warn?: (message: string) => void
}

/**
 * 把本地全部「我的专家」逐个 PUT 到云端；单行失败不中断整批。
 * @throws {SessionRequiredError} 未登录（整批失败，交由上层提示）。
 */
export async function backupMineExpertsToCloud(
  rows: readonly ExpertDef[],
  deps: MineCloudSyncDeps,
): Promise<MineBackupResult> {
  const failed: MineFailure[] = []
  let backedUp = 0
  for (const row of rows) {
    try {
      await withChengziSession(deps, (accessToken, options) => putCustomExpert(row, { ...options, accessToken }))
      backedUp += 1
    } catch (cause) {
      if (cause instanceof SessionRequiredError) throw cause
      const reason = cause instanceof Error ? cause.message : String(cause)
      deps.warn?.(`dsh-plugin-chengzi-experts: cloud backup failed for "${row.id}": ${reason}`)
      failed.push({ id: row.id, reason })
    }
  }
  return { backedUp, failed }
}

/** 恢复依赖面：恢复需要落盘根目录与 standard 组合文本。 */
export interface MineCloudRestoreDeps extends MineCloudSyncDeps {
  /** preset 根目录（`<DSH_HOME>/.agent-presets`）。 */
  readonly root: string
  /** shipped standard 组合全文；缺省时 persona-only 兜底。 */
  readonly standardText?: string | undefined
  /** 物化时间源（测试可固定）。 */
  readonly now?: () => Date
}

/**
 * 从云端拉取全部「我的专家」并逐个落盘（同 id 直接覆盖本地目录，合并式恢复：
 * 本地存在而云端没有的行保留不动）。单行失败不中断整批。
 * @throws {SessionRequiredError} 未登录。
 */
export async function restoreMineExpertsFromCloud(
  deps: MineCloudRestoreDeps,
): Promise<MineRestoreResult> {
  const rows = await withChengziSession(deps, (accessToken, options) => listCustomExperts({ ...options, accessToken }))
  const failed: MineFailure[] = []
  let restored = 0
  for (const row of rows) {
    try {
      await materializeExpertDirectory(deps.root, row, {
        standardText: deps.standardText ?? fallbackComposition(row.persona),
        source: 'mine',
        ...(deps.now === undefined ? {} : { now: deps.now() }),
      })
      restored += 1
    } catch (cause) {
      const reason = cause instanceof Error ? cause.message : String(cause)
      deps.warn?.(`dsh-plugin-chengzi-experts: cloud restore failed for "${row.id}": ${reason}`)
      failed.push({ id: row.id, reason })
    }
  }
  return { restored, failed }
}

/** 供路由层判定：是否为「未登录」类失败。 */
export function isSessionRequiredError(cause: unknown): cause is SessionRequiredError {
  return cause instanceof SessionRequiredError
}

/** 供路由层判定：account BFF 的 refresh 调用失败（轮换未成功）。 */
export function isChengziBffError(cause: unknown): cause is ChengziBffError {
  return cause instanceof ChengziBffError
}
