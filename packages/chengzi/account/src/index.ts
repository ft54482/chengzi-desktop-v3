/** Cordis Host plugin for the Chengzi Pro account: loopback routes over the account BFF. */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-settings'
import { CHENGZI_BFF_BASE_URL } from './bff-client.ts'
import { storePlatformApiKey, storePlatformGroupKeys, syncPlatformProvider } from './provider-sync.ts'
import { readPlatformApiKey, registerChengziAccountRoutes, type ChengziAccountRouteConfig } from './host/routes.ts'
import { loadSession } from './session.ts'

/** Stable Cordis plugin name; also the credential-record scope for the session grant. */
export const name = 'chengzi-account'

/** Host services required at activation: the loopback web server, its source check, the credential store, and the settings service. */
export const inject = ['webServer', 'connection', 'credentials', 'settings']

const MAX_TIMER_DELAY_MS = 2_147_483_647

/** 目录周期刷新间隔；与 BFF 官网倍率 worker 的 5min 节律对齐。 */
const CATALOG_REFRESH_MS = 5 * 60_000

/** Account plugin policy. */
export interface Config {
  /** Account BFF origin; defaults to the compiled-in production service. */
  bffBaseUrl: string
  /** Local minimum interval between sms-code requests for one phone number. */
  smsCodeMinIntervalMs: number
  /** Maximum duration of one BFF request before cancellation. */
  requestTimeoutMs: number
}

/** Validated account plugin policy. */
export const Config: z<Config> = z.object({
  bffBaseUrl: z.string().default(CHENGZI_BFF_BASE_URL),
  smsCodeMinIntervalMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(60_000),
  requestTimeoutMs: z.number().step(1).min(1_000).max(MAX_TIMER_DELAY_MS).default(15_000),
})

/**
 * Register effect-scoped account routes over the Host web server.
 * @param ctx - Host context carrying webServer, connection, credentials, and settings.
 * @param config - validated BFF origin and request policy.
 */
export function apply(ctx: Context, config: Config): void {
  const routeConfig: ChengziAccountRouteConfig = {
    bffBaseUrl: config.bffBaseUrl,
    smsCodeMinIntervalMs: config.smsCodeMinIntervalMs,
    requestTimeoutMs: config.requestTimeoutMs,
  }
  ctx.effect(
    () => registerChengziAccountRoutes(ctx, routeConfig),
    'chengzi-account: local account routes',
  )
  // The platform catalog is a public endpoint: sync it at startup without
  // requiring a session and refresh it periodically, so the selector's ratios
  // and grouping never depend on login timing. A failure here never blocks
  // the routes, and an empty catalog writes nothing (see provider-sync).
  const syncCatalog = (): void => {
    void syncPlatformProvider(
      { settings: ctx.settings, credentials: ctx.credentials },
      { bffBaseUrl: config.bffBaseUrl },
    ).catch((cause: unknown) => {
      ctx.logger.warn(`dsh-plugin-chengzi-account: platform catalog sync failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    })
  }
  syncCatalog()
  const catalogTimer = setInterval(syncCatalog, CATALOG_REFRESH_MS)
  ctx.effect(
    () => () => { clearInterval(catalogTimer) },
    'chengzi-account: periodic catalog refresh',
  )
  // While a session exists, mirror the provisioned platform API key beside the
  // catalog; fresh logins re-mirror through the login route.
  void loadSession(ctx).then(async (session) => {
    if (session === undefined) return
    const key = await readPlatformApiKey(
      ctx,
      { baseUrl: config.bffBaseUrl },
      AbortSignal.timeout(config.requestTimeoutMs),
    )
    await storePlatformApiKey({ settings: ctx.settings, credentials: ctx.credentials }, key.apiKey)
    await storePlatformGroupKeys({ settings: ctx.settings, credentials: ctx.credentials }, key.keys)
  }).catch((cause: unknown) => {
    ctx.logger.warn(`dsh-plugin-chengzi-account: platform api key mirror failed: ${cause instanceof Error ? cause.message : String(cause)}`)
  })
}

export { chengziAccountRoutes, readPlatformApiKey } from './host/routes.ts'
export { getCatalogSnapshot } from './provider-sync.ts'
export { CHENGZI_BFF_BASE_URL } from './bff-client.ts'
// 会话授权与 BFF 错误类型：供姊妹插件（chengzi-experts 云端备份）复用同一
// 凭据封印与 401 轮换机制；仅导出既有函数，无行为改动。
export { SESSION_CREDENTIAL_KEY, clearSession, loadSession, saveSession } from './session.ts'
export type { ChengziSession, ChengziSessionContext } from './session.ts'
export { ChengziBffError, refresh as refreshChengziBffTokens } from './bff-client.ts'
export {
  CHENGZI_PLATFORM_BASE_URL,
  CHENGZI_PROVIDER_CREDENTIAL_KEY,
  CHENGZI_PROVIDER_ROUTE,
  platformProviderProfile,
  storePlatformApiKey,
  syncPlatformProvider,
  syncPlatformProviderSettings,
} from './provider-sync.ts'
export type * from './api-types.ts'
