/** Client-side calls into the Host's loopback「我的专家」routes.
 *
 *  全部走 host 回环路由（token 由 host 持有，Renderer 不经手）；
 *  失败统一抛 {@link MineApiError}，message 即界面可展示的中文文案
 *  （host 已保证不回显远端响应内容）。401 统一映射为登录引导文案。
 */

import type { ExpertDef } from '../expert-types.js'
import type { MineBackupResult, MineExpertInput, MineRestoreResult } from '../mine-types.js'

/** 「我的专家」CRUD 路由（host webServer exact 路由）。 */
export const MINE_ROUTE = '/plugins/chengzi-experts/mine'
/** 「我的专家」云端备份路由。 */
export const MINE_ROUTE_BACKUP = '/plugins/chengzi-experts/mine/backup'
/** 「我的专家」云端恢复路由。 */
export const MINE_ROUTE_RESTORE = '/plugins/chengzi-experts/mine/restore'

/** 未登录（host 401）时的统一引导文案。 */
export const SIGN_IN_REQUIRED_MESSAGE = '请先在设置中登录橙子Pro 账号'

/** mine 路由的失败；status 供调用方区分登录态与其他错误。 */
export class MineApiError extends Error {
  readonly status: number

  constructor(message: string, status: number) {
    super(message)
    this.name = 'MineApiError'
    this.status = status
  }
}

function parseExpertPayload(value: unknown): ExpertDef {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
    const expert = (value as { expert?: unknown }).expert
    if (typeof expert === 'object' && expert !== null && !Array.isArray(expert)
      && typeof (expert as { id?: unknown }).id === 'string') {
      return expert as ExpertDef
    }
  }
  throw new MineApiError('host 返回了无法识别的专家数据。', 500)
}

function parseFailureList(value: unknown): readonly { readonly id: string; readonly reason: string }[] {
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { failed?: unknown }).failed)) return []
  return (value as { failed: unknown[] }).failed
    .filter((row): row is { id: string; reason: string } =>
      typeof row === 'object' && row !== null
      && typeof (row as { id?: unknown }).id === 'string'
      && typeof (row as { reason?: unknown }).reason === 'string')
    .map(row => ({ id: row.id, reason: row.reason }))
}

async function requestMineJson(url: string, init: RequestInit): Promise<unknown> {
  let response: Response
  try {
    response = await fetch(url, { cache: 'no-store', ...init })
  } catch (cause) {
    console.warn('dsh-plugin-chengzi-experts: mine route unreachable', cause)
    throw new MineApiError('无法连接本地服务，请稍后重试。', 0)
  }
  let value: unknown
  try {
    value = await response.json() as unknown
  } catch (cause) {
    // 响应体不可解析：仅留诊断日志，用状态码生成文案。
    console.warn('dsh-plugin-chengzi-experts: mine route returned an unreadable body', cause)
    value = undefined
  }
  if (!response.ok) {
    const serverError = typeof value === 'object' && value !== null
      && typeof (value as { error?: unknown }).error === 'string'
      ? (value as { error: string }).error
      : undefined
    const message = response.status === 401
      ? SIGN_IN_REQUIRED_MESSAGE
      : serverError ?? `请求失败（${String(response.status)}）。`
    throw new MineApiError(message, response.status)
  }
  return value
}

/** 创建一位「我的专家」（host 校验表单、派生唯一 id 并落盘）。 */
export async function createMineExpert(input: MineExpertInput, signal?: AbortSignal): Promise<ExpertDef> {
  const value = await requestMineJson(MINE_ROUTE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(input),
    ...(signal === undefined ? {} : { signal }),
  })
  return parseExpertPayload(value)
}

/** 更新一位「我的专家」（同 id 重写；version 由 host 递增）。 */
export async function updateMineExpert(id: string, input: MineExpertInput, signal?: AbortSignal): Promise<ExpertDef> {
  const value = await requestMineJson(MINE_ROUTE, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...input, id }),
    ...(signal === undefined ? {} : { signal }),
  })
  return parseExpertPayload(value)
}

/** 删除一位「我的专家」目录。 */
export async function deleteMineExpert(id: string, signal?: AbortSignal): Promise<void> {
  await requestMineJson(`${MINE_ROUTE}?id=${encodeURIComponent(id)}`, {
    method: 'DELETE',
    ...(signal === undefined ? {} : { signal }),
  })
}

/** 把本地全部「我的专家」备份到云端（未登录时 reject 登录引导文案）。 */
export async function backupMineExperts(signal?: AbortSignal): Promise<MineBackupResult> {
  const value = await requestMineJson(MINE_ROUTE_BACKUP, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  })
  if (typeof value !== 'object' || value === null || typeof (value as { backedUp?: unknown }).backedUp !== 'number') {
    throw new MineApiError('host 返回了无法识别的备份结果。', 500)
  }
  const row = value as { backedUp: number; failed?: unknown }
  return { backedUp: row.backedUp, failed: parseFailureList(value) }
}

/** 从云端恢复「我的专家」（同 id 直接覆盖本地目录）。 */
export async function restoreMineExperts(signal?: AbortSignal): Promise<MineRestoreResult> {
  const value = await requestMineJson(MINE_ROUTE_RESTORE, {
    method: 'POST',
    ...(signal === undefined ? {} : { signal }),
  })
  if (typeof value !== 'object' || value === null || typeof (value as { restored?: unknown }).restored !== 'number') {
    throw new MineApiError('host 返回了无法识别的恢复结果。', 500)
  }
  const row = value as { restored: number; failed?: unknown }
  return { restored: row.restored, failed: parseFailureList(value) }
}
