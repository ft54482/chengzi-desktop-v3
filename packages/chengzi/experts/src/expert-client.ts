/** Pure HTTP client for the Chengzi Pro account BFF's public experts catalog.
 *
 *  与 chengzi-account 的 bff-client 同源同纪律：路径式 origin、
 *  `https:` 或（仅回环开发 origin 的）`http:`、传输可注入、超时归调用方的
 *  AbortSignal、响应体按 64 KiB 上限有界读取、一切失败都是类型化的
 *  {@link ChengziExpertsError}，错误文案不回显响应内容。
 */

import type { CatalogResponse, ExpertDef } from './expert-types.js'
import { EXPERT_ID_PATTERN } from './expert-types.js'

/** Maximum accepted catalog response body bytes. */
export const MAX_EXPERTS_RESPONSE_BYTES = 64 * 1024

/** Maximum accepted expert rows in one catalog response. */
export const MAX_EXPERT_ROWS = 64

/** Failure categories exposed to the Host sync and routes. */
export type ChengziExpertsErrorCode =
  | 'aborted'
  | 'http-status'
  | 'invalid-response'
  | 'network'
  | 'response-too-large'

/** Fetch-compatible request boundary supplied by the Host or a test. */
export type ExpertsRequest = (url: string, init: RequestInit) => Promise<Response>

/** Shared request inputs: origin override, transport, and caller-owned cancellation. */
export interface ExpertFetchRequestOptions {
  /** BFF origin; the Host entry validates and passes the account-sourced base. */
  readonly baseUrl: string
  /** Request implementation for a test or an adapter. */
  readonly request?: ExpertsRequest
  /** Caller-owned cancellation signal; this client creates no timeout of its own. */
  readonly signal?: AbortSignal
}

/** Typed failure from the experts catalog request. */
export class ChengziExpertsError extends Error {
  /** Stable programmatic failure category. */
  readonly code: ChengziExpertsErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined

  constructor(code: ChengziExpertsErrorCode, message: string, options: { readonly status?: number; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChengziExpertsError'
    this.code = code
    this.status = options.status
  }
}

/**
 * Read the public expert catalog from the BFF. No authentication is required.
 *
 * Validation mirrors the account client's catalog route: `experts` must be a
 * bounded array and every row's `id` a well-formed expert id; rows failing the
 * shape are dropped (never fatal to the rest of the list).
 * @param options - origin, transport, and cancellation inputs.
 * @returns the validated catalog rows in server order.
 * @throws {ChengziExpertsError} On transport failure, non-200 status, or invalid payload.
 */
export async function fetchExpertCatalog(options: ExpertFetchRequestOptions): Promise<CatalogResponse> {
  // 字符串拼接而非 `new URL(path, base)`：base 是路径式 origin（…/chengzi-api）时，
  // 以「/」开头的 path 会被 URL 语义当作绝对路径吃掉前缀。
  const base = options.baseUrl.replace(/\/+$/u, '')
  let url: URL
  try {
    url = new URL(`${base}/api/v1/experts`)
  } catch {
    throw new ChengziExpertsError('invalid-response', 'The experts service base URL is invalid.')
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ChengziExpertsError('invalid-response', 'The experts service base URL is invalid.')
  }

  const request = options.request ?? defaultRequest
  let response: Response
  try {
    response = await request(url.href, {
      method: 'GET',
      headers: { accept: 'application/json' },
      cache: 'no-store',
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) {
      throw new ChengziExpertsError('aborted', 'The experts service request was cancelled.', { cause })
    }
    throw new ChengziExpertsError('network', `The experts service could not be reached. [${url.href}]`, { cause })
  }

  if (response.status !== 200) {
    await drain(response)
    throw new ChengziExpertsError(
      'http-status',
      `The experts service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }

  const value = await readLimitedJson(response)
  if (!isRecord(value) || !Array.isArray(value.experts) || value.experts.length > MAX_EXPERT_ROWS) {
    throw new ChengziExpertsError('invalid-response', 'The experts service returned an invalid catalog response.')
  }
  const experts: ExpertDef[] = []
  for (const entry of value.experts) {
    const expert = parseExpertRow(entry)
    if (expert === undefined) continue
    if (experts.some(row => row.id === expert.id)) continue
    experts.push(expert)
  }
  return { experts, source: 'cloud' }
}

/** 校验并解析一行专家目录数据；形状不符返回 undefined（调用方跳过该行）。
 *  云端目录与自定义专家（expert-mine-*）两端共用同一行校验。 */
export function parseExpertRow(entry: unknown): ExpertDef | undefined {  if (!isRecord(entry)) return undefined
  if (typeof entry.id !== 'string' || !EXPERT_ID_PATTERN.test(entry.id)) return undefined
  if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 20) return undefined
  if (typeof entry.persona !== 'string' || entry.persona.length === 0 || entry.persona.length > 8000) return undefined
  if (typeof entry.description !== 'string' || entry.description.length > 200) return undefined
  const tools = parseStringArray(entry.tools, 64)
  const skills = parseStringArray(entry.skills, 64)
  const starterPrompts = parseStringArray(entry.starter_prompts, 3)
  if (tools === undefined || skills === undefined || starterPrompts === undefined) return undefined
  const guidedIntro = entry.guided_intro === null || entry.guided_intro === undefined
    ? null
    : typeof entry.guided_intro === 'string' && entry.guided_intro.length <= 4000
      ? entry.guided_intro
      : undefined
  const costHint = entry.cost_hint === null || entry.cost_hint === undefined
    ? null
    : typeof entry.cost_hint === 'string' && entry.cost_hint.length <= 400
      ? entry.cost_hint
      : undefined
  const modelHint = entry.model_hint === null || entry.model_hint === undefined
    ? null
    : typeof entry.model_hint === 'string' && entry.model_hint.length <= 128
      ? entry.model_hint
      : undefined
  const badge = entry.badge === null || entry.badge === undefined
    ? null
    : typeof entry.badge === 'string' && entry.badge.length > 0 && entry.badge.length <= 16
      ? entry.badge
      : undefined
  if (guidedIntro === undefined || costHint === undefined || modelHint === undefined || badge === undefined) return undefined
  if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean') return undefined
  if (typeof entry.version !== 'number' || !Number.isSafeInteger(entry.version) || entry.version < 1) return undefined
  const icon = typeof entry.icon === 'string' && entry.icon.length > 0 && entry.icon.length <= 16
    ? entry.icon
    : '🤖'
  return {
    id: entry.id,
    name: entry.name,
    icon,
    description: entry.description,
    persona: entry.persona,
    tools,
    skills,
    guided_intro: guidedIntro,
    starter_prompts: starterPrompts,
    cost_hint: costHint,
    model_hint: modelHint,
    badge,
    enabled: entry.enabled === undefined ? true : entry.enabled,
    version: entry.version,
  }
}

/** Bounded string-array field: absent → [], over-cap or wrong-typed → invalid (undefined). */
function parseStringArray(value: unknown, maxRows: number): readonly string[] | undefined {
  if (value === undefined || value === null) return []
  if (!Array.isArray(value) || value.length > maxRows) return undefined
  const rows: string[] = []
  for (const entry of value) {
    if (typeof entry !== 'string' || entry.length === 0 || entry.length > 400) return undefined
    rows.push(entry)
  }
  return rows
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

/** Best-effort bounded drain of an error body so the socket is reusable. */
async function drain(response: Response): Promise<void> {
  try {
    await readLimitedBody(response, MAX_EXPERTS_RESPONSE_BYTES)
  } catch {
    // Error bodies are best-effort; the status code carries the failure.
  }
}

/** Read one JSON body with a hard byte ceiling; returns undefined for any unreadable body. */
async function readLimitedJson(response: Response): Promise<unknown> {
  return readLimitedJsonWithLimit(response, MAX_EXPERTS_RESPONSE_BYTES)
}

/** Read one JSON body with a caller-supplied byte ceiling; undefined for any unreadable body.
 *  自定义专家清单（expert-mine-* 可达百余行）用更大的上限复用同一有界读取。 */
export async function readLimitedJsonWithLimit(response: Response, maxBytes: number): Promise<unknown> {
  let body: string
  try {
    body = await readLimitedBody(response, maxBytes)
  } catch (cause) {
    if (cause instanceof ChengziExpertsError) throw cause
    return undefined
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<string> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw new ChengziExpertsError('response-too-large', 'The experts service response is too large.')
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
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ChengziExpertsError('response-too-large', 'The experts service response is too large.')
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
