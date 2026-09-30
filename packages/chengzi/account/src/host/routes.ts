/** Local web-server routes exposing the Chengzi Pro account service to the Client.
 *
 *  The Renderer never holds BFF tokens: it calls these loopback routes, the
 *  Host owns the session grant and the bearer headers. Every route applies the
 *  Connection source check before reading anything, request bodies are capped,
 *  and responses never contain a token.
 */

import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync, statSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-settings'
import {
  ChengziBffError,
  createOrder,
  getApiKey,
  getMe,
  getOrderStatus,
  listPackages,
  login as bffLogin,
  loginWithPassword as bffLoginPassword,
  logout as bffLogout,
  PHONE_PATTERN,
  refresh as bffRefresh,
  sendSmsCode,
  SMS_CODE_PATTERN,
  type ChengziBffApiKey,
  type ChengziBffRequestOptions,
} from '../bff-client.ts'
import { getCatalogModelGroup, getCatalogSnapshot, storePlatformApiKey, storePlatformGroupKeys, syncPlatformProvider } from '../provider-sync.ts'
import { clearSession, loadSession, saveSession } from '../session.ts'

export const CHENGZI_ACCOUNT_ROUTE_SMS_CODE = '/plugins/chengzi-account/sms-code'
export const CHENGZI_ACCOUNT_ROUTE_LOGIN = '/plugins/chengzi-account/login'
export const CHENGZI_ACCOUNT_ROUTE_LOGIN_PASSWORD = '/plugins/chengzi-account/login-password'
export const CHENGZI_ACCOUNT_ROUTE_LOGOUT = '/plugins/chengzi-account/logout'
export const CHENGZI_ACCOUNT_ROUTE_ME = '/plugins/chengzi-account/me'
export const CHENGZI_ACCOUNT_ROUTE_API_KEY = '/plugins/chengzi-account/api-key'
export const CHENGZI_ACCOUNT_ROUTE_CATALOG = '/plugins/chengzi-account/catalog'
export const CHENGZI_ACCOUNT_ROUTE_PACKAGES = '/plugins/chengzi-account/packages'
export const CHENGZI_ACCOUNT_ROUTE_ORDERS = '/plugins/chengzi-account/orders'
export const CHENGZI_ACCOUNT_ROUTE_ORDER = '/plugins/chengzi-account/order'
export const CHENGZI_ACCOUNT_ROUTE_OPEN_SOURCE = '/plugins/chengzi-account/open-source'
export const CHENGZI_ACCOUNT_ROUTE_SELECT_MODEL = '/plugins/chengzi-account/select-model'
export const CHENGZI_ACCOUNT_ROUTE_VENDOR_LOGO = '/plugins/chengzi-account/vendor-logo'

/** 厂商 logo 白名单（vendor key → lib/assets/logos 文件名；构建脚本从 assets/logos 复制）。
 *  exact 路由按白名单逐个注册，不存在用户输入拼路径的面。 */
const VENDOR_LOGO_FILES: Readonly<Record<string, string>> = Object.freeze({
  zhipu: 'zhipu.png',
  alibaba: 'alibaba.png',
  moonshot: 'moonshot.png',
  minimax: 'minimax.png',
  deepseek: 'deepseek.png',
  anthropic: 'anthropic.png',
  openai: 'openai.png',
  google: 'google.png',
})

/** 全组 key 映射缓存：api-key 路由成功后更新，select-model 优先读取（免 BFF 往返）。 */
let cachedGroupKeys: Record<string, string> | undefined

/** 本模块编译产物所在目录（tsdown 打包为单文件 lib/index.js，故即 lib/）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 逐级向上枚举祖先目录（含起点，封顶 8 级）——布局无关的资源定位用。 */
function* ancestors(from: string): Generator<string> {
  let current = from
  for (let depth = 0; depth < 8; depth++) {
    yield current
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** Logo 资源目录：从编译产物逐级向上找最近的 assets/logos（构建脚本把
 *  assets/logos 复制到 lib/assets/logos；打包=包内 lib/assets/logos，
 *  开发/测试=包根 assets/logos）。 */
const VENDOR_LOGO_DIR = (() => {
  for (const dir of ancestors(MODULE_DIR)) {
    if (existsSync(join(dir, 'assets', 'logos', 'zhipu.png'))) return join(dir, 'assets', 'logos')
  }
  return join(MODULE_DIR, 'assets', 'logos')
})()

/** 开源声明用的应用根：本模块所在包根（第一个带 package.json 的祖先）之上、
 *  再往上第一个带 package.json 的目录（打包=resources/app；开发=monorepo 根）。 */
const APP_ROOT = (() => {
  let seenOwnPackageRoot = false
  for (const dir of ancestors(MODULE_DIR)) {
    if (!existsSync(join(dir, 'package.json'))) continue
    if (!seenOwnPackageRoot) {
      seenOwnPackageRoot = true
      continue
    }
    return dir
  }
  return MODULE_DIR
})()

const MAX_NOTICES_BYTES = 512 * 1024

/** 在应用根下找文件；缺失返回 undefined（调用方展示兜底文案）。 */
function firstExisting(relativeName: string): string | undefined {
  const candidate = join(APP_ROOT, relativeName)
  return existsSync(candidate) ? candidate : undefined
}

function readBoundedText(path: string): string | null {
  try {
    const info = statSync(path)
    if (!info.isFile() || info.size > MAX_NOTICES_BYTES) return null
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

/** 开源声明载荷：桌面版本号（app package.json）+ MIT 文本 + 第三方清单全文。 */
export interface ChengziOpenSourceView {
  readonly version: string
  readonly licenseText: string
  readonly thirdPartyNotices: string | null
}

export function readOpenSourceView(): ChengziOpenSourceView {
  const pkgPath = firstExisting('package.json')
  let version = 'unknown'
  try {
    if (pkgPath !== undefined) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: unknown }
      if (typeof parsed.version === 'string' && parsed.version.length > 0) version = parsed.version
    }
  } catch {
    // 版本读取失败不阻断声明展示
  }
  const licenseFile = firstExisting('LICENSE')
  const licenseText = licenseFile === undefined
    ? STANDARD_MIT_TEXT
    : readBoundedText(licenseFile) ?? STANDARD_MIT_TEXT
  const noticesFile = firstExisting('THIRD_PARTY_NOTICES.md')
  const thirdPartyNotices = noticesFile === undefined ? null : readBoundedText(noticesFile)
  return { version, licenseText, thirdPartyNotices }
}

/** 标准 MIT 文本兜底（应用根缺少 LICENSE 文件时使用；与上游 LICENSE 保持一致）。 */
const STANDARD_MIT_TEXT = [
  'MIT License',
  '',
  'Copyright (c) 2026 Anywhere Labs',
  '',
  'Permission is hereby granted, free of charge, to any person obtaining a copy '
  + 'of this software and associated documentation files (the "Software"), to deal '
  + 'in the Software without restriction, including without limitation the rights '
  + 'to use, copy, modify, merge, publish, distribute, sublicense, and/or sell '
  + 'copies of the Software, and to permit persons to whom the Software is '
  + 'furnished to do so, subject to the following conditions:',
  '',
  'The above copyright notice and this permission notice shall be included in all '
  + 'copies or substantial portions of the Software.',
  '',
  'THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR '
  + 'IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, '
  + 'FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE '
  + 'AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER '
  + 'LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, '
  + 'OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE '
  + 'SOFTWARE.',
].join('\n')

const MAX_BODY_BYTES = 16 * 1024
const MAX_TRACKED_SMS_PHONES = 1024

/** Route registration inputs; the Host entry validates the schema. */
export interface ChengziAccountRouteConfig {
  readonly bffBaseUrl: string
  readonly smsCodeMinIntervalMs: number
  readonly requestTimeoutMs: number
}

/** Stable route-path map exported for diagnostics and tests. */
export const chengziAccountRoutes = {
  smsCode: CHENGZI_ACCOUNT_ROUTE_SMS_CODE,
  login: CHENGZI_ACCOUNT_ROUTE_LOGIN,
  logout: CHENGZI_ACCOUNT_ROUTE_LOGOUT,
  me: CHENGZI_ACCOUNT_ROUTE_ME,
  apiKey: CHENGZI_ACCOUNT_ROUTE_API_KEY,
  packages: CHENGZI_ACCOUNT_ROUTE_PACKAGES,
  orders: CHENGZI_ACCOUNT_ROUTE_ORDERS,
  order: CHENGZI_ACCOUNT_ROUTE_ORDER,
}

/** Request-scoped validation failure with its own HTTP status. */
class RouteRequestError extends Error {
  readonly status: number

  constructor(status: number, message: string) {
    super(message)
    this.name = 'RouteRequestError'
    this.status = status
  }
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

function requestAbort(
  req: IncomingMessage,
  res: ServerResponse,
  timeoutMs: number,
): { readonly signal: AbortSignal; readonly finish: () => void } {
  const controller = new AbortController()
  const timer = setTimeout(() => {
    controller.abort(new DOMException('The request timed out', 'TimeoutError'))
  }, timeoutMs)
  const abort = () => {
    controller.abort()
  }
  const abortIfUnfinished = () => {
    if (!res.writableEnded) controller.abort()
  }
  req.once('aborted', abort)
  res.once('close', abortIfUnfinished)
  return {
    signal: controller.signal,
    finish: () => {
      clearTimeout(timer)
      req.off('aborted', abort)
      res.off('close', abortIfUnfinished)
    },
  }
}

function abortReason(): DOMException {
  return new DOMException('The operation was aborted', 'AbortError')
}

function readJson(req: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) return Promise.reject(abortReason())
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    let settled = false
    const cleanup = () => {
      req.off('data', onData)
      req.off('end', onEnd)
      req.off('error', onError)
      req.off('aborted', onRequestAbort)
      signal.removeEventListener('abort', onSignalAbort)
    }
    const finish = (callback: () => void) => {
      if (settled) return
      settled = true
      cleanup()
      callback()
    }
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      size += buffer.length
      if (size > MAX_BODY_BYTES) {
        const cause = new RouteRequestError(400, 'The request body was too large.')
        finish(() => {
          req.destroy(cause)
          reject(cause)
        })
        return
      }
      chunks.push(buffer)
    }
    const onEnd = () => {
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown
        finish(() => {
          resolve(value)
        })
      } catch {
        finish(() => {
          reject(new RouteRequestError(400, 'The request body was not valid JSON.'))
        })
      }
    }
    const onError = (cause: Error) => {
      finish(() => {
        reject(cause)
      })
    }
    const onRequestAbort = (): void => {
      finish(() => {
        reject(abortReason())
      })
    }
    const onSignalAbort = onRequestAbort
    req.on('data', onData)
    req.once('end', onEnd)
    req.once('error', onError)
    req.once('aborted', onRequestAbort)
    signal.addEventListener('abort', onSignalAbort, { once: true })
  })
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new RouteRequestError(400, 'The request body must be a JSON object.')
  }
  return value as Record<string, unknown>
}

function requirePhone(value: unknown): string {
  if (typeof value !== 'string' || !PHONE_PATTERN.test(value)) {
    throw new RouteRequestError(400, 'A valid mainland China phone number is required.')
  }
  return value
}

function requireSmsCode(value: unknown): string {
  if (typeof value !== 'string' || !SMS_CODE_PATTERN.test(value)) {
    throw new RouteRequestError(400, 'A 6-digit SMS verification code is required.')
  }
  return value
}

function requireBoundedText(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64 || /[\0\r\n]/u.test(value)) {
    throw new RouteRequestError(400, `A ${label} is required.`)
  }
  return value
}

/**
 * Resolve the provisioned platform API key, rotating the session once on 401.
 * @param ctx - Host context carrying credentials.
 * @param bff - BFF origin.
 * @param signal - caller-owned cancellation signal.
 * @returns the provisioned API key view.
 * @throws with status 401 while unsigned in; rethrows transport and server failures.
 */
export async function readPlatformApiKey(
  ctx: Context,
  bff: { readonly baseUrl: string },
  signal: AbortSignal,
): Promise<ChengziBffApiKey> {
  const session = await loadSession(ctx)
  if (session === undefined) throw new RouteRequestError(401, 'Sign in before reading the API key.')
  try {
    return await getApiKey(session.accessToken, { ...bff, signal })
  } catch (cause) {
    if (!(cause instanceof ChengziBffError) || cause.status !== 401) throw cause
    const rotated = await refreshSession(ctx, session, bff, signal)
    return await getApiKey(rotated.accessToken, { ...bff, signal })
  }
}

/**
 * Run one authenticated BFF call with the stored session, rotating tokens once on 401.
 * @param ctx - Host context carrying credentials.
 * @param bff - BFF origin.
 * @param signal - caller-owned cancellation signal.
 * @param call - the BFF call, receiving the access token and request options.
 * @returns the call's result.
 * @throws with status 401 while unsigned in; rethrows transport and server failures.
 */
async function callWithSession<T>(
  ctx: Context,
  bff: { readonly baseUrl: string },
  signal: AbortSignal,
  call: (accessToken: string, options: ChengziBffRequestOptions) => Promise<T>,
): Promise<T> {
  const session = await loadSession(ctx)
  if (session === undefined) throw new RouteRequestError(401, 'Sign in first.')
  try {
    return await call(session.accessToken, { ...bff, signal })
  } catch (cause) {
    if (!(cause instanceof ChengziBffError) || cause.status !== 401) throw cause
    const rotated = await refreshSession(ctx, session, bff, signal)
    return await call(rotated.accessToken, { ...bff, signal })
  }
}

/** Map any failure to a safe JSON response; messages never echo response bodies or tokens. */
function sendFailure(ctx: Context, res: ServerResponse, cause: unknown): void {
  if (res.writableEnded || res.destroyed) return
  if (cause instanceof RouteRequestError) {
    sendJson(res, cause.status, { error: cause.message })
    return
  }
  if (cause instanceof ChengziBffError) {
    const status = cause.code === 'aborted'
      ? 504
      : cause.status === 400 || cause.status === 401 || cause.status === 409 || cause.status === 429
        ? cause.status
        : 502
    sendJson(res, status, {
      error: cause.serverError ?? cause.message,
      ...(cause.provisionState === undefined ? {} : { provisionState: cause.provisionState }),
    })
    return
  }
  ctx.logger.error(`dsh-plugin-chengzi-account: account route failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  sendJson(res, 500, { error: 'The account operation failed.' })
}

/** Bounded local sms-code throttle state, keyed by phone number. */
const smsSentAt = new Map<string, number>()

function markSmsSent(phone: string, minIntervalMs: number, now = Date.now()): void {
  if (smsSentAt.size >= MAX_TRACKED_SMS_PHONES) {
    for (const [key, at] of smsSentAt) {
      if (now - at >= minIntervalMs) smsSentAt.delete(key)
    }
    if (smsSentAt.size >= MAX_TRACKED_SMS_PHONES) {
      let oldestKey: string | undefined
      let oldestAt = Number.POSITIVE_INFINITY
      for (const [key, at] of smsSentAt) {
        if (at < oldestAt) {
          oldestAt = at
          oldestKey = key
        }
      }
      if (oldestKey !== undefined) smsSentAt.delete(oldestKey)
    }
  }
  smsSentAt.set(phone, now)
}

function smsRecentlySent(phone: string, minIntervalMs: number, now = Date.now()): boolean {
  const last = smsSentAt.get(phone)
  return last !== undefined && now - last < minIntervalMs
}

/**
 * Register every Chengzi Account loopback route on the Host web server.
 * @param ctx - Host context carrying webServer, connection, and credentials.
 * @param config - validated route configuration.
 * @returns a disposer removing every registered route.
 */
export function registerChengziAccountRoutes(ctx: Context, config: ChengziAccountRouteConfig): () => void {
  const bff = { baseUrl: config.bffBaseUrl }
  const routes = [
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_SMS_CODE, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The sms-code request requires POST.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const phone = requirePhone(requireObject(await readJson(req, signal)).phone)
        if (smsRecentlySent(phone, config.smsCodeMinIntervalMs)) {
          sendJson(res, 429, { error: 'Please wait before requesting another code.', code: 'rate-limited' })
          return
        }
        await sendSmsCode(phone, { ...bff, signal })
        markSmsSent(phone, config.smsCodeMinIntervalMs)
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { sent: true })
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_LOGIN, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The login request requires POST.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const body = requireObject(await readJson(req, signal))
        const phone = requirePhone(body.phone)
        const code = requireSmsCode(body.code)
        const result = await bffLogin(phone, code, { ...bff, signal })
        await saveSession(ctx, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          phone: result.user.phone ?? '',
        })
        if (!signal.aborted && !res.destroyed) {
          sendJson(res, 200, {
            user: result.user,
            balance: result.balance,
            provisionState: result.provisionState,
          })
          // Fire-and-forget: refresh the platform provider profile and its key
          // credential right after a fresh login.
          void syncPlatformProvider(
            { settings: ctx.settings, credentials: ctx.credentials },
            {
              bffBaseUrl: config.bffBaseUrl,
              getApiKey: async () => {
                const key = await readPlatformApiKey(ctx, bff, AbortSignal.timeout(config.requestTimeoutMs))
                return key.apiKey
              },
              getKeys: async () => {
                const key = await readPlatformApiKey(ctx, bff, AbortSignal.timeout(config.requestTimeoutMs))
                return key.keys
              },
            },
          ).catch((cause: unknown) => {
            ctx.logger.warn(`dsh-plugin-chengzi-account: platform provider sync after login failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_LOGIN_PASSWORD, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The login request requires POST.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const body = requireObject(await readJson(req, signal))
        const username = typeof body.username === 'string' ? body.username.trim() : ''
        const password = typeof body.password === 'string' ? body.password : ''
        if (username.length < 3 || username.length > 256 || password.length < 8 || password.length > 256) {
          sendJson(res, 400, { error: '请输入账号和密码' })
          return
        }
        const result = await bffLoginPassword(username, password, { ...bff, signal })
        await saveSession(ctx, {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
          phone: result.user.phone ?? '',
        })
        if (!signal.aborted && !res.destroyed) {
          sendJson(res, 200, {
            user: result.user,
            balance: result.balance,
            provisionState: result.provisionState,
          })
          // Fire-and-forget: refresh the platform provider profile and its key
          // credential right after a fresh login.
          void syncPlatformProvider(
            { settings: ctx.settings, credentials: ctx.credentials },
            {
              bffBaseUrl: config.bffBaseUrl,
              getApiKey: async () => {
                const key = await readPlatformApiKey(ctx, bff, AbortSignal.timeout(config.requestTimeoutMs))
                return key.apiKey
              },
              getKeys: async () => {
                const key = await readPlatformApiKey(ctx, bff, AbortSignal.timeout(config.requestTimeoutMs))
                return key.keys
              },
            },
          ).catch((cause: unknown) => {
            ctx.logger.warn(`dsh-plugin-chengzi-account: platform provider sync after login failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          })
        }
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_LOGOUT, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The logout request requires POST.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const session = await loadSession(ctx)
        if (session !== undefined) {
          try {
            await bffLogout(session.refreshToken, { ...bff, signal })
          } catch (cause) {
            // Best effort: the local session is cleared regardless, and the
            // message never contains a token.
            ctx.logger.warn(`dsh-plugin-chengzi-account: server logout failed: ${cause instanceof Error ? cause.message : String(cause)}`)
          }
          await clearSession(ctx)
        }
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { ok: true })
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_ME, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The account request requires GET.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const session = await loadSession(ctx)
        if (session === undefined) {
          if (!signal.aborted && !res.destroyed) sendJson(res, 200, { authenticated: false })
          return
        }
        try {
          const account = await getMe(session.accessToken, { ...bff, signal })
          if (!signal.aborted && !res.destroyed) {
            sendJson(res, 200, { authenticated: true, user: account.user, balance: account.balance })
          }
        } catch (cause) {
          if (!(cause instanceof ChengziBffError) || cause.status !== 401) throw cause
          // Access token expired: rotate once, then retry; a failed rotation
          // clears the session so the Client returns to the login form.
          const rotated = await refreshSession(ctx, session, bff, signal)
          const account = await getMe(rotated.accessToken, { ...bff, signal })
          if (!signal.aborted && !res.destroyed) {
            sendJson(res, 200, { authenticated: true, user: account.user, balance: account.balance })
          }
        }
      } catch (cause) {
        if (signal.aborted) return
        if (cause instanceof ChengziBffError && cause.status === 401) {
          await clearSession(ctx).catch(() => undefined)
          if (!res.writableEnded && !res.destroyed) {
            sendJson(res, 401, { authenticated: false, error: 'The session expired.' })
          }
          return
        }
        sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_CATALOG, handler: (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The catalog request requires GET.' })
        return
      }
      // 公开目录：模型元数据由 provider worker 同步进内存缓存（host 侧只读）。
      sendJson(res, 200, { models: getCatalogSnapshot() })
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_API_KEY, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The api-key request requires GET.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const key = await readPlatformApiKey(ctx, bff, signal)
        // 缓存全组 key 映射：select-model 按模型所属组切换凭据时优先使用（免一次 BFF 往返）。
        if (Object.keys(key.keys).length > 0) cachedGroupKeys = { ...key.keys }
        // Best effort: cache the key as the pi-ai route credential beside the
        // response; the record write never fails the API-key route itself.
        try {
          await storePlatformGroupKeys({ settings: ctx.settings, credentials: ctx.credentials }, key.keys)
          await storePlatformApiKey({ settings: ctx.settings, credentials: ctx.credentials }, key.apiKey)
        } catch (cause) {
          ctx.logger.warn(`dsh-plugin-chengzi-account: failed to cache the platform API key credential: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, key)
      } catch (cause) {
        if (signal.aborted) return
        if (cause instanceof ChengziBffError && cause.status === 401) {
          await clearSession(ctx).catch(() => undefined)
          if (!res.writableEnded && !res.destroyed) {
            sendJson(res, 401, { error: 'The session expired.' })
          }
          return
        }
        sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_PACKAGES, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The packages request requires GET.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const packages = await callWithSession(
          ctx, bff, signal,
          (accessToken, options) => listPackages(accessToken, options),
        )
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, { packages })
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_ORDERS, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'POST') {
        sendJson(res, 405, { error: 'The order request requires POST.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        const packageId = requireBoundedText(requireObject(await readJson(req, signal)).packageId, 'package id')
        const order = await callWithSession(
          ctx, bff, signal,
          (accessToken, options) => createOrder(packageId, accessToken, options),
        )
        if (!signal.aborted && !res.destroyed) {
          sendJson(res, 200, {
            orderNo: order.orderNo,
            amountCents: order.amountCents,
            qrCode: order.qrCode,
            ...(order.stub === undefined ? {} : { stub: order.stub }),
          })
        }
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
    ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_ORDER, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The order-status request requires GET.' })
        return
      }
      const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
      try {
        // Query parameter instead of a parameterized route: the web-server
        // route table matches exact paths only.
        const requestUrl = new URL(req.url ?? '/', 'http://localhost')
        const orderNoValues = requestUrl.searchParams.getAll('orderNo')
        if (orderNoValues.length !== 1) {
          throw new RouteRequestError(400, 'Exactly one orderNo query parameter is required.')
        }
        const orderNo = requireBoundedText(orderNoValues[0], 'order number')
        const status = await callWithSession(
          ctx, bff, signal,
          (accessToken, options) => getOrderStatus(orderNo, accessToken, options),
        )
        if (!signal.aborted && !res.destroyed) sendJson(res, 200, status)
      } catch (cause) {
        if (!signal.aborted) sendFailure(ctx, res, cause)
      } finally {
        finish()
      }
    } }),
  ]
  // 厂商 logo 静态资源：白名单 vendor 逐个注册 exact 路由，带 1 天客户端缓存。
  for (const [vendor, file] of Object.entries(VENDOR_LOGO_FILES)) {
    routes.push(ctx.webServer.register({ kind: 'exact', path: `${CHENGZI_ACCOUNT_ROUTE_VENDOR_LOGO}/${vendor}.png`, handler: async (req, res) => {
      if (!sourceAllowed(ctx, req, res)) return
      if (req.method !== 'GET') {
        sendJson(res, 405, { error: 'The logo request requires GET.' })
        return
      }
      try {
        const body = await readFile(join(VENDOR_LOGO_DIR, file))
        if (!res.writableEnded && !res.destroyed) {
          res.statusCode = 200
          res.setHeader('content-type', 'image/png')
          res.setHeader('cache-control', 'public, max-age=86400')
          res.end(body)
        }
      } catch {
        sendJson(res, 404, { error: 'The logo asset is unavailable.' })
      }
    } }))
  }
  // 开源声明：版本号 + MIT 文本 + 第三方清单（只读；文件缺失时客户端展示兜底文案）。
  routes.push(ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_OPEN_SOURCE, handler: (req, res) => {
    if (!sourceAllowed(ctx, req, res)) return
    if (req.method !== 'GET') {
      sendJson(res, 405, { error: 'The open-source request requires GET.' })
      return
    }
    sendJson(res, 200, readOpenSourceView())
  } }))
  // 选择模型 → 按模型所属平台分组切换 pi-ai 凭据（ref 面逐请求生效）。
  // 依赖：目录同步已缓存模型元数据（group），api-key 已缓存全组 keys。
  routes.push(ctx.webServer.register({ kind: 'exact', path: CHENGZI_ACCOUNT_ROUTE_SELECT_MODEL, handler: async (req, res) => {
    if (!sourceAllowed(ctx, req, res)) return
    if (req.method !== 'POST') {
      sendJson(res, 405, { error: 'The select-model request requires POST.' })
      return
    }
    const { signal, finish } = requestAbort(req, res, config.requestTimeoutMs)
    try {
      const session = await loadSession(ctx)
      if (session === undefined) {
        sendJson(res, 401, { error: 'Sign in before selecting a model.' })
        return
      }
      const body = requireObject(await readJson(req, signal))
      const model = typeof body.model === 'string' ? body.model.trim().slice(0, 256) : ''
      if (model.length === 0) {
        sendJson(res, 400, { error: 'A model id is required.' })
        return
      }
      const group = getCatalogModelGroup(model) ?? 'vip'
      let keys = cachedGroupKeys
      if (keys === undefined || keys[group] === undefined) {
        // 缓存缺失/组缺失：走一次 BFF api-key 刷新全组映射（401 时轮换重试）
        const key = await readPlatformApiKey(ctx, bff, signal)
        if (Object.keys(key.keys).length > 0) cachedGroupKeys = { ...key.keys }
        keys = cachedGroupKeys
      }
      const selected = keys?.[group] ?? keys?.vip
      if (selected === undefined) {
        sendJson(res, 502, { error: '该模型的分组暂无可用凭据，请稍后重试。' })
        return
      }
      await storePlatformApiKey({ settings: ctx.settings, credentials: ctx.credentials }, selected)
      ctx.logger.info('已按模型分组切换平台凭据 model=%s group=%s', model, group)
      if (!signal.aborted && !res.destroyed) sendJson(res, 200, { group, applied: true })
    } catch (cause) {
      if (signal.aborted) return
      if (cause instanceof ChengziBffError && cause.status === 401) {
        await clearSession(ctx).catch(() => undefined)
        if (!res.writableEnded && !res.destroyed) {
          sendJson(res, 401, { error: 'The session expired.' })
        }
        return
      }
      sendFailure(ctx, res, cause)
    } finally {
      finish()
    }
  } }))
  let disposed = false
  return () => {
    if (disposed) return
    disposed = true
    smsSentAt.clear()
    for (const dispose of routes) dispose()
  }
}

/** Rotate one session's tokens and persist the replacement grant atomically. */
async function refreshSession(
  ctx: Context,
  session: { readonly refreshToken: string; readonly phone: string },
  bff: { readonly baseUrl: string },
  signal: AbortSignal,
): Promise<{ readonly accessToken: string }> {
  const pair = await bffRefresh(session.refreshToken, { ...bff, signal })
  await saveSession(ctx, {
    accessToken: pair.accessToken,
    refreshToken: pair.refreshToken,
    phone: session.phone,
  })
  return { accessToken: pair.accessToken }
}
