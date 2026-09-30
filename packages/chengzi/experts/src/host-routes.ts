/** Local web-server routes exposing the Chengzi Pro expert catalog to the Client.
 *
 *  路由只读部分：`GET /plugins/chengzi-experts/catalog` 返回当前生效专家清单
 *  （云端/内置 + 本地 expert-mine-* 合并；超龄自动先同步一次）。
 *  「我的专家」（Phase B）部分：
 *  - `POST|PUT|DELETE /plugins/chengzi-experts/mine` 增/改/删本地自建专家；
 *  - `POST /plugins/chengzi-experts/mine/backup|restore` 云端备份/恢复
 *    （host 持有登录会话，Renderer 不经手 token）。
 *  每个请求先过 Connection source check，响应 no-store；请求体有界，错误
 *  文案不回显远端响应内容。
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type { CatalogResponse, ExpertDef } from './expert-types.js'
import { EXPERT_MINE_PREFIX } from './expert-types.js'
import type { MineBackupResult, MineExpertInput, MineRestoreResult } from './mine-types.js'
import { isSessionRequiredError } from './mine-cloud.js'
import { mergeCatalogWithMine, MineExpertValidationError, validateMineExpertInput } from './mine-experts.js'

/** Client-facing catalog route path served by the Host web server. */
export const CHENGZI_EXPERTS_ROUTE_CATALOG = '/plugins/chengzi-experts/catalog'

/** 「我的专家」CRUD 路由（同一路径按方法分派）。 */
export const CHENGZI_EXPERTS_ROUTE_MINE = '/plugins/chengzi-experts/mine'

/** 「我的专家」云端备份路由。 */
export const CHENGZI_EXPERTS_ROUTE_MINE_BACKUP = '/plugins/chengzi-experts/mine/backup'

/** 「我的专家」云端恢复路由。 */
export const CHENGZI_EXPERTS_ROUTE_MINE_RESTORE = '/plugins/chengzi-experts/mine/restore'

/** 请求体上限（persona 8000 字符的 UTF-8 裕量取整）。 */
const MAX_MINE_BODY_BYTES = 64 * 1024

/** Route registration inputs; the Host entry validates the schema. */
export interface ChengziExpertsRouteConfig {
  /** 目录超龄阈值：超过该时长未同步，路由先触发一次同步。 */
  readonly catalogMaxAgeMs: number
  /** 目录提供者：按需同步并返回当前生效清单（不含 expert-mine-*）。 */
  readonly serveCatalog: (maxAgeMs: number) => Promise<CatalogResponse>
  /** 本地「我的专家」清单提供者（容错坏文件）。 */
  readonly listMine: () => Promise<readonly ExpertDef[]>
  /** 创建（id 缺省）或更新（带 id）一位「我的专家」。 */
  readonly saveMine: (input: MineExpertInput, id?: string) => Promise<ExpertDef>
  /** 删除一位「我的专家」目录。 */
  readonly deleteMine: (id: string) => Promise<void>
  /** 云端备份：本地全部 expert-mine-* 逐个 PUT。 */
  readonly backupMine: () => Promise<MineBackupResult>
  /** 云端恢复：云端清单逐个落盘（同 id 覆盖）。 */
  readonly restoreMine: () => Promise<MineRestoreResult>
}

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  const body = JSON.stringify(value)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.setHeader('x-content-type-options', 'nosniff')
  res.end(body)
}

/** Apply the Connection source check; returns true when the request may proceed. */
function sourceAllowed(ctx: Context, req: IncomingMessage, res: ServerResponse): boolean {
  const rejection = ctx.connection.requestRejection(req)
  if (rejection !== undefined) {
    sendJson(res, rejection, { error: rejection === 401 ? 'unauthorized' : 'forbidden' })
    return false
  }
  return true
}

/** Bounded JSON body reader（16KiB 级别的小请求体；超限/坏 JSON 抛带 status 的错误）。 */
class MineRouteRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'MineRouteRequestError'
    this.status = status
  }
}

function readBoundedJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const finish = (callback: () => void): void => {
      if (settled) return
      settled = true
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      callback()
    }
    const onData = (chunk: Buffer | string): void => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_MINE_BODY_BYTES) {
        finish(() => {
          reject(new MineRouteRequestError(400, '请求体过大。'))
        })
      } else {
        chunks.push(buffer)
      }
    }
    const onEnd = (): void => {
      try {
        finish(() => {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown)
        })
      } catch {
        finish(() => {
          reject(new MineRouteRequestError(400, '请求体不是合法 JSON。'))
        })
      }
    }
    const onError = (cause: Error): void => {
      finish(() => {
        reject(cause)
      })
    }
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
  })
}

/** 失败 → 安全 JSON 响应；401 引导登录，校验失败 400，其余记日志回 500。 */
function sendMineFailure(ctx: Context, res: ServerResponse, cause: unknown): void {
  if (res.writableEnded || res.destroyed) return
  if (isSessionRequiredError(cause)) {
    sendJson(res, 401, { error: cause.message })
    return
  }
  if (cause instanceof MineRouteRequestError) {
    sendJson(res, cause.status, { error: cause.message })
    return
  }
  if (cause instanceof MineExpertValidationError) {
    sendJson(res, 400, { error: cause.message })
    return
  }
  ctx.logger.error(`dsh-plugin-chengzi-experts: mine route failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  sendJson(res, 500, { error: '操作失败，请稍后重试。' })
}

/**
 * Register the Chengzi Experts loopback routes on the Host web server.
 * @param ctx - Host context carrying webServer and connection.
 * @param config - validated route configuration.
 * @returns a disposer removing every registered route.
 */
export function registerChengziExpertsRoutes(ctx: Context, config: ChengziExpertsRouteConfig): () => void {
  const disposers = [
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_EXPERTS_ROUTE_CATALOG, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The experts catalog request requires GET.' })
        return
      }
      try {
        const catalog = await config.serveCatalog(config.catalogMaxAgeMs)
        // 并入本地「我的专家」：官方在前、我的在后；云端/内置清单永不携带
        // expert-mine-*（同步器领地规则），merge 再按 id 去重兜底。
        const experts = mergeCatalogWithMine(catalog.experts, await config.listMine())
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { experts, source: catalog.source })
      } catch (cause) {
        ctx.logger.error(`dsh-plugin-chengzi-experts: catalog route failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        if (!res.writableEnded && !res.destroyed) sendJson(res, 500, { error: 'The experts catalog is unavailable.' })
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_EXPERTS_ROUTE_MINE, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      try {
        if (req.method === 'POST') {
          const input = validateMineExpertInput(await readBoundedJson(req))
          const expert = await config.saveMine(input)
          if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { expert })
          return
        }
        if (req.method === 'PUT') {
          const body = await readBoundedJson(req)
          const id = typeof body === 'object' && body !== null && !Array.isArray(body)
            && typeof (body as { id?: unknown }).id === 'string'
            ? (body as { id: string }).id
            : ''
          if (!id.startsWith(EXPERT_MINE_PREFIX)) {
            sendJson(res, 400, { error: '缺少合法的专家 id。' })
            return
          }
          const input = validateMineExpertInput(body)
          const expert = await config.saveMine(input, id)
          if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { expert })
          return
        }
        if (req.method === 'DELETE') {
          // Query parameter instead of a parameterized route: the web-server
          // route table matches exact paths only.
          const requestUrl = new URL(req.url ?? '/', 'http://localhost')
          const id = requestUrl.searchParams.get('id') ?? ''
          if (!id.startsWith(EXPERT_MINE_PREFIX)) {
            sendJson(res, 400, { error: '只能删除「我的专家」。' })
            return
          }
          await config.deleteMine(id)
          if (!res.writableEnded && !res.destroyed) sendJson(res, 200, { ok: true })
          return
        }
        sendJson(res, 405, { error: 'The mine experts request requires POST, PUT, or DELETE.' })
      } catch (cause) {
        sendMineFailure(ctx, res, cause)
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_EXPERTS_ROUTE_MINE_BACKUP, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The mine backup request requires POST.' })
        return
      }
      try {
        const result = await config.backupMine()
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result)
      } catch (cause) {
        sendMineFailure(ctx, res, cause)
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_EXPERTS_ROUTE_MINE_RESTORE, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The mine restore request requires POST.' })
        return
      }
      try {
        const result = await config.restoreMine()
        if (!res.writableEnded && !res.destroyed) sendJson(res, 200, result)
      } catch (cause) {
        sendMineFailure(ctx, res, cause)
      }
    } }),
  ]
  return () => { disposers.forEach((dispose) =>{  dispose() }) }
}
