/** Pure HTTP client for the Chengzi Pro account BFF.
 *
 *  Every function is a pure request: the transport is injectable (defaults to
 *  `globalThis.fetch`), timeouts belong to the caller's AbortSignal, response
 *  bodies are read with a 64 KiB ceiling, and every failure is a typed
 *  {@link ChengziBffError} whose message never echoes response content.
 */

/** Production BFF origin（ECS 常驻，nginx 挂在平台域名 /chengzi-api 路径下）。
 *  本地联调可用环境变量 CHENGZI_BFF_BASE_URL 覆盖（例如 http://127.0.0.1:8080）。 */
export const CHENGZI_BFF_BASE_URL = process.env.CHENGZI_BFF_BASE_URL
  ?? 'https://pro.nat6.net/chengzi-api'

/** Maximum accepted BFF response body bytes. */
export const MAX_BFF_RESPONSE_BYTES = 64 * 1024

/** Mainland China mobile phone number accepted by the account service. */
export const PHONE_PATTERN = /^1[3-9]\d{9}$/u

/** Six-digit SMS verification code. */
export const SMS_CODE_PATTERN = /^\d{6}$/u

/** Failure categories exposed to the Host routes. */
export type ChengziBffErrorCode =
  | 'aborted'
  | 'http-status'
  | 'invalid-response'
  | 'network'
  | 'response-too-large'

/** Account service provisioning lifecycle. */
export type ChengziProvisionState = 'none' | 'pending' | 'ready' | 'failed'

/** Fetch-compatible request boundary supplied by the Host or a test. */
export type BffRequest = (url: string, init: RequestInit) => Promise<Response>

/** Shared request inputs: transport, origin override, and caller-owned cancellation. */
export interface ChengziBffRequestOptions {
  /** BFF origin; defaults to {@link CHENGZI_BFF_BASE_URL}. */
  readonly baseUrl?: string
  /** Request implementation for an adapter or a test. */
  readonly request?: BffRequest
  /** Caller-owned cancellation signal; this client creates no timeout of its own. */
  readonly signal?: AbortSignal
}

/** Account identity returned by the BFF; nickname/phone are nullable in the BFF contract
 *  (账号密码登录的官网用户没有手机号). */
export interface ChengziUser {
  readonly id: string
  readonly phone: string | null
  readonly nickname: string | null
}

/** Account balance returned by the BFF. */
export interface ChengziBalance {
  readonly tokens: number
}

/** Successful `POST /api/v1/auth/login` payload. */
export interface ChengziBffLoginResult {
  readonly accessToken: string
  readonly refreshToken: string
  readonly user: ChengziUser
  readonly balance: ChengziBalance
  readonly provisionState: ChengziProvisionState
}

/** Successful `POST /api/v1/auth/refresh` payload. */
export interface ChengziBffTokenPair {
  readonly accessToken: string
  readonly refreshToken: string
}

/** Successful `GET /api/v1/me` payload. */
export interface ChengziBffAccountSnapshot {
  readonly user: ChengziUser
  readonly balance: ChengziBalance
}

/** Successful `GET /api/v1/account/api-key` payload. */
export interface ChengziBffApiKey {
  readonly apiKey: string
  readonly baseUrl: string
  readonly group: string
  /** 全组 key 映射（组名 → key）；按模型所属组切换凭据用。 */
  readonly keys: Record<string, string>
}

/** One model-catalog entry served by the public `GET /api/v1/models` route. */
export interface ChengziBffModelView {
  /** Model id sent to the platform endpoint. */
  readonly id: string
  /** Human-readable name; optional pass-through. */
  readonly displayName?: string
  /** Short description; optional pass-through. */
  readonly description?: string
  /** Provider label; optional pass-through. */
  readonly provider?: string
  /** 官网同源模型倍率（模型广场显示值）；0 表示免费。 */
  readonly modelRatio?: number
  /** 补全倍率（输出/输入价比）。 */
  readonly completionRatio?: number
  /** 相对官网目录价的折扣倍率（1=原价、0.38=3.8折）；平台官网口径，选择器徽章已改用组倍率口径（见 modelSelectorName），此字段保留透传。 */
  readonly discountRatio?: number
  /** 平台分组倍率（相对橙子Pro 内部原价基准的折扣：实付=模型倍率×14.6×groupRatio）；选择器徽章展示此值。 */
  readonly groupRatio?: number
  /** 免费标记（倍率为 0 的福利模型）。 */
  readonly free?: boolean
  /** 计费类型：1=按次计费（生图等，无 token 倍率概念）；缺省=按 token。 */
  readonly quotaType?: number
  /** 按次计费单价（元/次）；仅 quotaType=1 时存在。 */
  readonly inputPriceCny?: number
  /** 平台计费分组（vip/minimax/kimi/…）；选择该模型时应使用对应组的 key。 */
  readonly group?: string
  /** 分组折扣标签（如「3.8折」「独家优惠」）。 */
  readonly discountLabel?: string
  /** 选择器分组（free/domestic/international/image）。 */
  readonly category?: string
  /** 厂商标识（client 侧 logo 表的键）。 */
  readonly vendor?: string
}

/** Successful `GET /api/v1/models` payload. */
export interface ChengziBffModelsResponse {
  /** Platform API origin advertised beside the catalog; optional pass-through. */
  readonly apiBaseUrl?: string
  /** Catalog rows in server sort order. */
  readonly models: readonly ChengziBffModelView[]
}

/** One recharge package served by `GET /api/v1/packages`; `tokens` already includes the bonus. */
export interface ChengziBffPackage {
  readonly id: string
  readonly name: string
  readonly priceCents: number
  readonly tokens: number
  readonly bonusTokens: number
}

/** Order lifecycle reported by the order-status route. */
export type ChengziBffOrderStatusValue = 'pending' | 'paid'

/** Successful `POST /api/v1/orders` payload; `stub` marks the v1 sandbox demo code. */
export interface ChengziBffOrderCreation {
  readonly orderNo: string
  readonly amountCents: number
  readonly qrCode: string
  readonly stub?: true
}

/** Successful `GET /api/v1/orders/:orderNo` payload. */
export interface ChengziBffOrderStatus {
  readonly orderNo: string
  readonly status: ChengziBffOrderStatusValue
  readonly amountCents: number
  readonly tokens: number
  readonly createdAt: string
  readonly paidAt: string | null
}

/** Typed failure from any BFF request; the message never contains response content. */
export class ChengziBffError extends Error {
  /** Stable programmatic failure category. */
  readonly code: ChengziBffErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined
  /** Server-provided `error` text from an unsuccessful response. */
  readonly serverError: string | undefined
  /** Server-provided provisioning state from a 409 api-key response. */
  readonly provisionState: ChengziProvisionState | undefined

  constructor(
    code: ChengziBffErrorCode,
    message: string,
    options: {
      readonly status?: number
      readonly serverError?: string
      readonly provisionState?: ChengziProvisionState
      readonly cause?: unknown
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChengziBffError'
    this.code = code
    this.status = options.status
    this.serverError = options.serverError
    this.provisionState = options.provisionState
  }
}

/**
 * Request one SMS verification code for a phone number.
 * @param phone - validated mainland China mobile number.
 * @param options - transport and cancellation inputs.
 * @throws {ChengziBffError} On transport failure, non-200 status, or invalid payload.
 */
export async function sendSmsCode(phone: string, options: ChengziBffRequestOptions = {}): Promise<void> {
  assertValidPhone(phone)
  const value = await postJson('/api/v1/auth/sms-code', { phone }, options)
  if (!isRecord(value) || value.sent !== true) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid sms-code response.')
  }
}

/**
 * Exchange a phone number and SMS code for a session.
 * @param phone - validated mainland China mobile number.
 * @param code - six-digit SMS verification code.
 * @param options - transport and cancellation inputs.
 * @returns tokens, account snapshot, and provisioning state.
 * @throws {ChengziBffError} On transport failure, non-200 status, or invalid payload.
 */
export async function login(
  phone: string,
  code: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffLoginResult> {
  assertValidPhone(phone)
  assertValidSmsCode(code)
  const value = await postJson('/api/v1/auth/login', { phone, code }, options)
  if (
    !isRecord(value)
    || !nonEmptyString(value.accessToken, 8192)
    || !nonEmptyString(value.refreshToken, 8192)
    || !isUser(value.user)
    || !isBalance(value.balance)
    || !isProvisionState(value.provisionState)
  ) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid login response.')
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    user: value.user,
    balance: value.balance,
    provisionState: value.provisionState,
  }
}

/**
 * Exchange platform account credentials (pro.nat6.net 官网账号密码) for a session.
 * 响应与短信登录同构；`provisionState` 恒为 `ready`（attach 已直接签发全组 key）。
 * @param username - platform account name (3+ chars, enforced server-side as well).
 * @param password - platform password (8+ chars).
 * @param options - transport and cancellation inputs.
 * @returns the login result; user identity mirrors the SMS login shape (phone 可空).
 * @throws {ChengziBffError} With status 401 on bad credentials, 400 on malformed input,
 * 429 when rate limited.
 */
export async function loginWithPassword(
  username: string,
  password: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffLoginResult> {
  const name = username.trim()
  if (name.length < 3 || name.length > 256 || password.length < 8 || password.length > 256) {
    throw new ChengziBffError('invalid-response', '账号或密码格式不正确')
  }
  const value = await postJson('/api/v1/auth/login-password', { username: name, password }, options)
  if (
    !isRecord(value)
    || !nonEmptyString(value.accessToken, 8192)
    || !nonEmptyString(value.refreshToken, 8192)
    || !isUser(value.user)
    || !isBalance(value.balance)
    || !isProvisionState(value.provisionState)
  ) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid login response.')
  }
  return {
    accessToken: value.accessToken,
    refreshToken: value.refreshToken,
    user: value.user,
    balance: value.balance,
    provisionState: value.provisionState,
  }
}

/**
 * Rotate one session's tokens with a refresh token.
 * @param refreshToken - refresh token issued by login or a previous refresh.
 * @param options - transport and cancellation inputs.
 * @returns the replacement token pair.
 * @throws {ChengziBffError} With status 401 when the refresh token is no longer accepted.
 */
export async function refresh(refreshToken: string, options: ChengziBffRequestOptions = {}): Promise<ChengziBffTokenPair> {
  if (!nonEmptyString(refreshToken, 8192)) {
    throw new ChengziBffError('invalid-response', 'The refresh token is invalid.')
  }
  const value = await postJson('/api/v1/auth/refresh', { refreshToken }, options)
  if (!isRecord(value) || !nonEmptyString(value.accessToken, 8192) || !nonEmptyString(value.refreshToken, 8192)) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid refresh response.')
  }
  return { accessToken: value.accessToken, refreshToken: value.refreshToken }
}

/**
 * Revoke one refresh token server-side.
 * @param refreshToken - refresh token to revoke.
 * @param options - transport and cancellation inputs.
 * @throws {ChengziBffError} On transport failure or non-200 status.
 */
export async function logout(refreshToken: string, options: ChengziBffRequestOptions = {}): Promise<void> {
  if (!nonEmptyString(refreshToken, 8192)) {
    throw new ChengziBffError('invalid-response', 'The refresh token is invalid.')
  }
  const value = await postJson('/api/v1/auth/logout', { refreshToken }, options)
  if (!isRecord(value) || value.ok !== true) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid logout response.')
  }
}

/**
 * Read the current account snapshot with an access token.
 * @param accessToken - bearer token issued by login or refresh.
 * @param options - transport and cancellation inputs.
 * @returns account identity and balance.
 * @throws {ChengziBffError} With status 401 when the access token is no longer accepted.
 */
export async function getMe(
  accessToken: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffAccountSnapshot> {
  const value = await getJson('/api/v1/me', accessToken, options)
  if (!isRecord(value) || !isUser(value.user) || !isBalance(value.balance)) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid account response.')
  }
  return { user: value.user, balance: value.balance }
}

/**
 * Read the provisioned API key with an access token.
 * @param accessToken - bearer token issued by login or refresh.
 * @param options - transport and cancellation inputs.
 * @returns the provisioned API key view.
 * @throws {ChengziBffError} With status 409 and `provisionState` while provisioning is in progress.
 */
export async function getApiKey(
  accessToken: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffApiKey> {
  const value = await getJson('/api/v1/account/api-key', accessToken, options)
  const keys = isRecord(value) && isRecord(value.keys)
    ? Object.fromEntries(
      Object.entries(value.keys)
        .filter((entry): entry is [string, string] => typeof entry[0] === 'string' && entry[0].length > 0 && typeof entry[1] === 'string' && entry[1].length > 0 && entry[1].length <= 8192)
        .map(([k, v]) => [k.slice(0, 64), v]),
    )
    : {}
  if (
    !isRecord(value)
    || !nonEmptyString(value.apiKey, 8192)
    || !nonEmptyString(value.baseUrl, 2048)
    || typeof value.group !== 'string'
    || value.group.length > 256
  ) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid api-key response.')
  }
  return { apiKey: value.apiKey, baseUrl: value.baseUrl, group: value.group, keys }
}

/** Maximum catalog rows accepted from the public models route. */
export const MAX_BFF_MODEL_ROWS = 512

/**
 * Read the public model catalog. No authentication is required.
 *
 * Validation is deliberately lenient: `models` must be a bounded array and
 * every entry's `id` a non-empty string; all other fields pass through when
 * they are strings within their bounds and are omitted otherwise.
 * @param options - transport and cancellation inputs.
 * @returns the catalog with its advertised platform origin.
 * @throws {ChengziBffError} On transport failure, non-200 status, or invalid payload.
 */
export async function listModels(options: ChengziBffRequestOptions = {}): Promise<ChengziBffModelsResponse> {
  const value = await getPublicJson('/api/v1/models', options)
  if (!isRecord(value) || !Array.isArray(value.models) || value.models.length > MAX_BFF_MODEL_ROWS) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid models response.')
  }
  const models: ChengziBffModelView[] = []
  for (const entry of value.models) {
    if (!isRecord(entry) || !nonEmptyString(entry.id, 256)) {
      throw new ChengziBffError('invalid-response', 'The account service returned an invalid models response.')
    }
    models.push({
      id: entry.id,
      ...(nonEmptyString(entry.displayName, 256) ? { displayName: entry.displayName } : {}),
      ...(typeof entry.description === 'string' && entry.description.length <= 1024
        ? { description: entry.description }
        : {}),
      ...(nonEmptyString(entry.provider, 256) ? { provider: entry.provider } : {}),
      ...(isNonNegativeFinite(entry.modelRatio) ? { modelRatio: entry.modelRatio } : {}),
      ...(isNonNegativeFinite(entry.completionRatio) ? { completionRatio: entry.completionRatio } : {}),
      ...(isNonNegativeFinite(entry.discountRatio) ? { discountRatio: entry.discountRatio } : {}),
      ...(isNonNegativeFinite(entry.groupRatio) ? { groupRatio: entry.groupRatio } : {}),
      ...(entry.free === true ? { free: true } : {}),
      ...(entry.quotaType === 1 ? { quotaType: 1 } : {}),
      ...(entry.quotaType === 1 && isNonNegativeFinite(entry.inputPriceCny)
        ? { inputPriceCny: entry.inputPriceCny }
        : {}),
      ...(nonEmptyString(entry.discountLabel, 32) ? { discountLabel: entry.discountLabel } : {}),
      ...(nonEmptyString(entry.category, 32) ? { category: entry.category } : {}),
      ...(nonEmptyString(entry.group, 64) ? { group: entry.group } : {}),
      ...(nonEmptyString(entry.vendor, 32) ? { vendor: entry.vendor } : {}),
    })
  }
  return {
    models,
    ...(typeof value.apiBaseUrl === 'string' && value.apiBaseUrl.length <= 2048
      ? { apiBaseUrl: value.apiBaseUrl }
      : {}),
  }
}

/** Maximum package rows accepted from the packages route. */
export const MAX_BFF_PACKAGE_ROWS = 64

/** Maximum accepted order-number length on both sides of the wire. */
export const MAX_BFF_ORDER_NO_LENGTH = 64

/**
 * Read the recharge packages with an access token.
 * @param accessToken - bearer token issued by login or refresh.
 * @param options - transport and cancellation inputs.
 * @returns the package rows in server order; `tokens` already includes the bonus.
 * @throws {ChengziBffError} With status 401 when the access token is no longer accepted.
 */
export async function listPackages(
  accessToken: string,
  options: ChengziBffRequestOptions = {},
): Promise<readonly ChengziBffPackage[]> {
  const value = await getJson('/api/v1/packages', accessToken, options)
  if (!isRecord(value) || !Array.isArray(value.packages) || value.packages.length > MAX_BFF_PACKAGE_ROWS) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid packages response.')
  }
  const packages: ChengziBffPackage[] = []
  for (const entry of value.packages) {
    if (
      !isRecord(entry)
      || !nonEmptyString(entry.id, 64)
      || typeof entry.name !== 'string'
      || entry.name.length > 128
      || !isCount(entry.priceCents)
      || !isCount(entry.tokens)
      || !isCount(entry.bonusTokens)
    ) {
      throw new ChengziBffError('invalid-response', 'The account service returned an invalid packages response.')
    }
    packages.push({
      id: entry.id,
      name: entry.name,
      priceCents: entry.priceCents,
      tokens: entry.tokens,
      bonusTokens: entry.bonusTokens,
    })
  }
  return packages
}

/**
 * Create one recharge order for a package.
 * @param packageId - package id from {@link listPackages}.
 * @param accessToken - bearer token issued by login or refresh.
 * @param options - transport and cancellation inputs.
 * @returns the order number and its payment code; `stub` marks the v1 sandbox demo code.
 * @throws {ChengziBffError} With status 401 when the access token is no longer accepted.
 */
export async function createOrder(
  packageId: string,
  accessToken: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffOrderCreation> {
  if (!nonEmptyString(packageId, 64)) {
    throw new ChengziBffError('invalid-response', 'The package id is invalid.')
  }
  const value = await postAuthJson('/api/v1/orders', { packageId }, accessToken, options)
  if (
    !isRecord(value)
    || !nonEmptyString(value.orderNo, MAX_BFF_ORDER_NO_LENGTH)
    || !isCount(value.amountCents)
    || !nonEmptyString(value.qrCode, 2048)
    || (value.stub !== undefined && value.stub !== true)
  ) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid order response.')
  }
  return {
    orderNo: value.orderNo,
    amountCents: value.amountCents,
    qrCode: value.qrCode,
    ...(value.stub === true ? { stub: true } : {}),
  }
}

/**
 * Read one order's payment status.
 * @param orderNo - order number issued by {@link createOrder}.
 * @param accessToken - bearer token issued by login or refresh.
 * @param options - transport and cancellation inputs.
 * @returns the order lifecycle view; `status: 'paid'` means payment was received.
 * @throws {ChengziBffError} With status 401 when the access token is no longer accepted.
 */
export async function getOrderStatus(
  orderNo: string,
  accessToken: string,
  options: ChengziBffRequestOptions = {},
): Promise<ChengziBffOrderStatus> {
  if (typeof orderNo !== 'string' || orderNo.length === 0 || orderNo.length > MAX_BFF_ORDER_NO_LENGTH) {
    throw new ChengziBffError('invalid-response', 'The order number is invalid.')
  }
  const value = await getJson(`/api/v1/orders/${encodeURIComponent(orderNo)}`, accessToken, options)
  if (
    !isRecord(value)
    || !nonEmptyString(value.orderNo, MAX_BFF_ORDER_NO_LENGTH)
    || value.orderNo !== orderNo
    || !isOrderStatus(value.status)
    || !isCount(value.amountCents)
    || !isCount(value.tokens)
    || !nonEmptyString(value.createdAt, 64)
    || !(value.paidAt === null || nonEmptyString(value.paidAt, 64))
  ) {
    throw new ChengziBffError('invalid-response', 'The account service returned an invalid order status response.')
  }
  return {
    orderNo: value.orderNo,
    status: value.status,
    amountCents: value.amountCents,
    tokens: value.tokens,
    createdAt: value.createdAt,
    paidAt: value.paidAt,
  }
}

async function postJson(
  path: string,
  body: Record<string, string>,
  options: ChengziBffRequestOptions,
): Promise<unknown> {
  return await requestJson(path, {
    method: 'POST',
    headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(body),
  }, options)
}

async function postAuthJson(
  path: string,
  body: Record<string, string>,
  accessToken: string,
  options: ChengziBffRequestOptions,
): Promise<unknown> {
  return await requestJson(path, {
    method: 'POST',
    headers: {
      accept: 'application/json',
      'content-type': 'application/json',
      authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  }, options)
}

async function getJson(path: string, accessToken: string, options: ChengziBffRequestOptions): Promise<unknown> {
  return await requestJson(path, {
    method: 'GET',
    headers: { accept: 'application/json', authorization: `Bearer ${accessToken}` },
  }, options)
}

async function getPublicJson(path: string, options: ChengziBffRequestOptions): Promise<unknown> {
  return await requestJson(path, {
    method: 'GET',
    headers: { accept: 'application/json' },
  }, options)
}

async function requestJson(
  path: string,
  init: RequestInit,
  options: ChengziBffRequestOptions,
): Promise<unknown> {
  // 字符串拼接而非 `new URL(path, base)`：base 是路径式 origin（…/chengzi-api）时，
  // 以「/」开头的 path 会被 URL 语义当作绝对路径吃掉前缀。
  const base = (options.baseUrl ?? CHENGZI_BFF_BASE_URL).replace(/\/+$/u, '')
  let url: URL
  try {
    url = new URL(`${base}${path}`)
  } catch {
    throw new ChengziBffError('invalid-response', 'The account service base URL is invalid.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ChengziBffError('invalid-response', 'The account service base URL is invalid.')
  }

  const request = options.request ?? defaultRequest
  const fullInit: RequestInit = {
    ...init,
    cache: 'no-store',
    redirect: 'error',
    ...(options.signal === undefined ? {} : { signal: options.signal }),
  }
  let response: Response
  try {
    response = await request(url.href, fullInit)
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) {
      throw new ChengziBffError('aborted', 'The account service request was cancelled.', { cause })
    }
    // 运维诊断：网络失败的底层 cause（ENOTFOUND/ECONNREFUSED/ETIMEDOUT/证书错误）
    // 透出到错误文案，便于远程定位（不含任何用户数据）。
    const causeDetail = cause instanceof Error
      ? (() => {
        const code = (cause as Error & { code?: unknown }).code
        if (typeof code === 'string' && code.length > 0) return code
        const inner = cause.cause
        if (inner instanceof Error) {
          const innerCode = (inner as Error & { code?: unknown }).code
          if (typeof innerCode === 'string' && innerCode.length > 0) return innerCode
        }
        return undefined
      })()
      : undefined
    throw new ChengziBffError(
      'network',
      `The account service could not be reached.${causeDetail === undefined ? '' : ` (${causeDetail})`} [${url.href}]`,
      { cause },
    )
  }

  if (response.status !== 200) {
    throw await httpStatusError(response)
  }

  const value = await readLimitedJson(response)
  if (value === undefined) {
    throw new ChengziBffError('invalid-response', 'The account service returned an unreadable response.')
  }
  return value
}

async function httpStatusError(response: Response): Promise<ChengziBffError> {
  const body = await readLimitedJson(response)
  const serverError = isRecord(body) && typeof body.error === 'string' && body.error.trim().length > 0
    && body.error.length <= 512
    ? body.error
    : undefined
  const provisionState = isRecord(body) && isProvisionState(body.provisionState)
    ? body.provisionState
    : undefined
  return new ChengziBffError(
    'http-status',
    `The account service returned HTTP ${String(response.status)}.`,
    {
      status: response.status,
      ...(serverError === undefined ? {} : { serverError }),
      ...(provisionState === undefined ? {} : { provisionState }),
    },
  )
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

/** Read one JSON body with a hard byte ceiling; returns undefined for any unreadable body. */
async function readLimitedJson(response: Response): Promise<unknown> {
  let body: string
  try {
    body = await readLimitedBody(response)
  } catch (cause) {
    if (cause instanceof ChengziBffError) throw cause
    return undefined
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

async function readLimitedBody(response: Response): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(MAX_BFF_RESPONSE_BYTES)) {
    throw new ChengziBffError('response-too-large', 'The account service response is too large.')
  }

  if (response.body === null) return ''
  const reader = response.body.getReader()
  const decoder = new TextDecoder('utf-8', { fatal: true })
  let bytesRead = 0
  let body = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > MAX_BFF_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined)
        throw new ChengziBffError('response-too-large', 'The account service response is too large.')
      }
      body += decoder.decode(chunk.value, { stream: true })
    }
    return body + decoder.decode()
  } finally {
    reader.releaseLock()
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function isAbortFailure(value: unknown): boolean {
  return typeof value === 'object' && value !== null && 'name' in value && value.name === 'AbortError'
}

function assertValidPhone(phone: string): void {
  if (typeof phone !== 'string' || !PHONE_PATTERN.test(phone)) {
    throw new ChengziBffError('invalid-response', 'The phone number is invalid.')
  }
}

function assertValidSmsCode(code: string): void {
  if (typeof code !== 'string' || !SMS_CODE_PATTERN.test(code)) {
    throw new ChengziBffError('invalid-response', 'The SMS verification code is invalid.')
  }
}

function nonEmptyString(value: unknown, maxLength: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maxLength
}

/** 有限非负数字（倍率/价格字段的宽松校验）。 */
function isNonNegativeFinite(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/** Non-negative safe integer for cents and token counts. */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/** Order lifecycle accepted by the order-status route. */
function isOrderStatus(value: unknown): value is ChengziBffOrderStatusValue {
  return value === 'pending' || value === 'paid'
}

function isUser(value: unknown): value is ChengziUser {
  return isRecord(value)
    && nonEmptyString(value.id, 256)
    // 密码登录的官网用户没有手机号（phone 为 null）；有值时必须是合法手机号。
    && (value.phone === null
      || (typeof value.phone === 'string' && PHONE_PATTERN.test(value.phone)))
    && (value.nickname === null
      || (typeof value.nickname === 'string' && value.nickname.length <= 256))
}

function isBalance(value: unknown): value is ChengziBalance {
  return isRecord(value)
    && typeof value.tokens === 'number'
    && Number.isFinite(value.tokens)
    && value.tokens >= 0
}

function isProvisionState(value: unknown): value is ChengziProvisionState {
  return value === 'none' || value === 'pending' || value === 'ready' || value === 'failed'
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
