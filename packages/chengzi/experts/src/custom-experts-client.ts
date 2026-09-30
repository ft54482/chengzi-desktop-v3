/** Pure HTTP client for the Chengzi Pro BFF's authenticated custom-experts store.
 *
 *  契约（与 BFF 侧对齐）：
 *  - `GET  /api/v1/custom-experts`          → `{ experts: [payload…] }`
 *  - `PUT  /api/v1/custom-experts/{id}`     body = payload（ExpertDef JSON）
 *  - `DELETE /api/v1/custom-experts/{id}`   （桌面 v1 备份/恢复不使用）
 *
 *  与 expert-client.ts 同源同纪律：路径式 origin、`https:` 或（仅回环开发
 *  origin 的）`http:`、传输可注入、超时归调用方的 AbortSignal、响应体有界
 *  读取、一切失败都是类型化的 {@link ChengziExpertsError}，错误文案不回显
 *  响应内容。所有行经 parseExpertRow 校验且 id 必须落在 expert-mine-*
 *  命名空间内——越界的行一律丢弃，绝不写进官方命名空间。
 */

import type { ExpertDef } from './expert-types.js'
import { EXPERT_MINE_PREFIX } from './expert-types.js'
import type { ExpertsRequest } from './expert-client.js'
import { ChengziExpertsError, parseExpertRow, readLimitedJsonWithLimit } from './expert-client.js'

/** Maximum accepted custom-experts response body bytes（行数上限的宽松裕量）。 */
export const MAX_CUSTOM_EXPERTS_RESPONSE_BYTES = 256 * 1024

/** Maximum accepted custom-expert rows in one cloud response. */
export const MAX_CUSTOM_EXPERT_ROWS = 128

/** Shared authenticated request inputs. */
export interface CustomExpertsRequestOptions {
  /** BFF origin（路径式 origin 允许）。 */
  readonly baseUrl: string
  /** Bearer access token issued by the account session. */
  readonly accessToken: string
  /** Request implementation for a test or an adapter. */
  readonly request?: ExpertsRequest
  /** Caller-owned cancellation signal. */
  readonly signal?: AbortSignal
}

function assertSafeBase(baseUrl: string): URL {
  // 字符串拼接而非 `new URL(path, base)`：base 是路径式 origin（…/chengzi-api）时，
  // 以「/」开头的 path 会被 URL 语义当作绝对路径吃掉前缀。
  const base = baseUrl.replace(/\/+$/u, '')
  let url: URL
  try {
    url = new URL(`${base}/api/v1/custom-experts`)
  } catch {
    throw new ChengziExpertsError('invalid-response', 'The experts service base URL is invalid.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ChengziExpertsError('invalid-response', 'The experts service base URL is invalid.')
  }
  return url
}

function assertMineId(id: string): string {
  if (!id.startsWith(EXPERT_MINE_PREFIX) || !/^[a-z0-9-]+$/u.test(id.slice(EXPERT_MINE_PREFIX.length))) {
    throw new ChengziExpertsError('invalid-response', 'The custom expert id is outside the mine namespace.')
  }
  return id
}

/**
 * Read every custom expert stored in the cloud for the signed-in user.
 * @param options - origin, bearer token, transport, and cancellation inputs.
 * @returns rows passing the shared expert-row validation and the mine-namespace
 * guard, in server order (invalid rows are dropped, never fatal).
 * @throws {ChengziExpertsError} On transport failure, non-200 status, or invalid payload.
 */
export async function listCustomExperts(options: CustomExpertsRequestOptions): Promise<readonly ExpertDef[]> {
  const url = assertSafeBase(options.baseUrl)
  const request = options.request ?? defaultRequest
  let response: Response
  try {
    response = await request(url.href, {
      method: 'GET',
      headers: { accept: 'application/json', authorization: `Bearer ${options.accessToken}` },
      cache: 'no-store',
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    throw transportFailure(url.href, options, cause)
  }
  if (response.status !== 200) {
    await drain(response)
    throw new ChengziExpertsError(
      'http-status',
      `The experts service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }
  const value = await readLimitedJsonWithLimit(response, MAX_CUSTOM_EXPERTS_RESPONSE_BYTES)
  if (typeof value !== 'object' || value === null || !Array.isArray((value as { experts?: unknown }).experts)
    || (value as { experts: unknown[] }).experts.length > MAX_CUSTOM_EXPERT_ROWS) {
    throw new ChengziExpertsError('invalid-response', 'The experts service returned an invalid custom-experts response.')
  }
  const experts: ExpertDef[] = []
  for (const entry of (value as { experts: unknown[] }).experts) {
    const expert = parseExpertRow(entry)
    if (expert === undefined || !expert.id.startsWith(EXPERT_MINE_PREFIX)) continue
    experts.push(expert)
  }
  return experts
}

/**
 * Upsert one custom expert into the cloud store (idempotent per id).
 * @param expert - the full definition to store; its id must sit in the mine namespace.
 * @param options - origin, bearer token, transport, and cancellation inputs.
 * @throws {ChengziExpertsError} On transport failure or a non-2xx status.
 */
export async function putCustomExpert(expert: ExpertDef, options: CustomExpertsRequestOptions): Promise<void> {
  assertMineId(expert.id)
  const url = assertSafeBase(options.baseUrl)
  const putUrl = `${url.href}/${encodeURIComponent(expert.id)}`
  const request = options.request ?? defaultRequest
  let response: Response
  try {
    response = await request(putUrl, {
      method: 'PUT',
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        authorization: `Bearer ${options.accessToken}`,
      },
      body: JSON.stringify(expert),
      cache: 'no-store',
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    throw transportFailure(putUrl, options, cause)
  }
  if (response.status < 200 || response.status > 299) {
    await drain(response)
    throw new ChengziExpertsError(
      'http-status',
      `The experts service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }
  await drain(response)
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

function transportFailure(href: string, options: CustomExpertsRequestOptions, cause: unknown): ChengziExpertsError {
  if (options.signal?.aborted === true || (typeof cause === 'object' && cause !== null && 'name' in cause && (cause).name === 'AbortError')) {
    return new ChengziExpertsError('aborted', 'The experts service request was cancelled.', { cause })
  }
  return new ChengziExpertsError('network', `The experts service could not be reached. [${href}]`, { cause })
}

/** Best-effort bounded drain so the socket is reusable; failures are swallowed. */
async function drain(response: Response): Promise<void> {
  try {
    await readLimitedJsonWithLimit(response, 4 * 1024)
  } catch {
    // Error bodies are best-effort; the status code carries the failure.
  }
}

function isLoopback(hostname: string): boolean {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}
