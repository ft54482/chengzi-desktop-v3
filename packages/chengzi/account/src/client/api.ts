/** Client-side calls into the Host's loopback Chengzi Account routes. */

import type {
  ChengziAccountApiKeyView,
  ChengziAccountLoginResponse,
  ChengziAccountMeResponse,
  ChengziOrderCreationResponse,
  ChengziOrderStatusResponse,
  ChengziPackagesResponse,
} from '../api-types.ts'

/** Client-facing account route paths served by the Host web server. */
export const ACCOUNT_ROUTE_SMS_CODE = '/plugins/chengzi-account/sms-code'
export const ACCOUNT_ROUTE_LOGIN = '/plugins/chengzi-account/login'
export const ACCOUNT_ROUTE_LOGIN_PASSWORD = '/plugins/chengzi-account/login-password'
export const ACCOUNT_ROUTE_LOGOUT = '/plugins/chengzi-account/logout'
export const ACCOUNT_ROUTE_ME = '/plugins/chengzi-account/me'
export const ACCOUNT_ROUTE_API_KEY = '/plugins/chengzi-account/api-key'
export const ACCOUNT_ROUTE_PACKAGES = '/plugins/chengzi-account/packages'
export const ACCOUNT_ROUTE_ORDERS = '/plugins/chengzi-account/orders'
export const ACCOUNT_ROUTE_ORDER = '/plugins/chengzi-account/order'
export const ACCOUNT_ROUTE_OPEN_SOURCE = '/plugins/chengzi-account/open-source'

/** 登录/登出后广播，供登录门禁等界面即时响应会话变化。 */
export const SESSION_CHANGED_EVENT = 'chengzi-account-session-changed'

export function notifySessionChanged(): void {
  window.dispatchEvent(new CustomEvent(SESSION_CHANGED_EVENT))
}

/** HTTP facts used to present safe Client-facing account failures. */
export class ChengziAccountApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly provisionState?: string,
  ) {
    super(message)
    this.name = 'ChengziAccountApiError'
  }
}

async function readJson<T>(response: Response): Promise<T> {
  const value = await response.json() as T & { error?: unknown; provisionState?: unknown }
  if (!response.ok) {
    throw new ChengziAccountApiError(
      typeof value.error === 'string' && value.error.trim().length > 0
        ? value.error
        : `request failed: ${String(response.status)}`,
      response.status,
      typeof value.provisionState === 'string' ? value.provisionState : undefined,
    )
  }
  return value
}

/** Request one SMS verification code. */
export async function requestAccountSmsCode(phone: string, signal?: AbortSignal): Promise<void> {
  await readJson(await fetch(ACCOUNT_ROUTE_SMS_CODE, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone }),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Exchange a phone number and SMS code for a session. */
export async function loginAccount(
  phone: string,
  code: string,
  signal?: AbortSignal,
): Promise<ChengziAccountLoginResponse> {
  return await readJson(await fetch(ACCOUNT_ROUTE_LOGIN, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ phone, code }),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Exchange platform account credentials (官网账号密码) for a session; response mirrors the SMS login. */
export async function loginAccountWithPassword(
  username: string,
  password: string,
  signal?: AbortSignal,
): Promise<ChengziAccountLoginResponse> {
  return await readJson(await fetch(ACCOUNT_ROUTE_LOGIN_PASSWORD, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username, password }),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Sign out and clear the stored session. */
export async function logoutAccount(signal?: AbortSignal): Promise<void> {
  await readJson(await fetch(ACCOUNT_ROUTE_LOGOUT, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Read the signed-in state, phone number, and balance. */
export async function readAccount(signal?: AbortSignal): Promise<ChengziAccountMeResponse> {
  return await readJson(await fetch(ACCOUNT_ROUTE_ME, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Read the provisioned API key; a 409 carries `provisionState` while provisioning. */
export async function readAccountApiKey(signal?: AbortSignal): Promise<ChengziAccountApiKeyView> {
  return await readJson(await fetch(ACCOUNT_ROUTE_API_KEY, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Read the recharge packages; each entry's `tokens` already includes the bonus. */
export async function fetchAccountPackages(signal?: AbortSignal): Promise<ChengziPackagesResponse> {
  return await readJson(await fetch(ACCOUNT_ROUTE_PACKAGES, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Create one recharge order; `qrCode` carries the sandbox demo code in v1. */
export async function createRechargeOrder(
  packageId: string,
  signal?: AbortSignal,
): Promise<ChengziOrderCreationResponse> {
  return await readJson(await fetch(ACCOUNT_ROUTE_ORDERS, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ packageId }),
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Poll one order's payment status; `paid` means payment was received. */
export async function pollOrderStatus(
  orderNo: string,
  signal?: AbortSignal,
): Promise<ChengziOrderStatusResponse> {
  const url = new URL(ACCOUNT_ROUTE_ORDER, window.location.origin)
  url.searchParams.set('orderNo', orderNo)
  return await readJson(await fetch(url, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}

/** Open-source attribution payload: app version, MIT text, and third-party notices. */
export interface ChengziOpenSourceView {
  readonly version: string
  readonly licenseText: string
  readonly thirdPartyNotices: string | null
}

/** Read the open-source declaration (version, MIT text, third-party notices). */
export async function readOpenSource(signal?: AbortSignal): Promise<ChengziOpenSourceView> {
  return await readJson(await fetch(ACCOUNT_ROUTE_OPEN_SOURCE, {
    cache: 'no-store',
    ...(signal === undefined ? {} : { signal }),
  }))
}
