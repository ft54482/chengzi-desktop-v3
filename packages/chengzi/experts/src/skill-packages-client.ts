/** Pure HTTP client for the Chengzi Pro account BFF's public skill-package
 *  catalog and package archives.
 *
 *  与 expert-client.ts 同源同纪律：路径式 origin、`https:` 或（仅回环开发
 *  origin 的）`http:`、传输可注入、超时归调用方的 AbortSignal、响应体
 *  有界读取（目录 64 KiB / zip 正文 6 MiB——契约包 ≤5MB + 余量）、一切
 *  失败都是类型化的 {@link ChengziSkillPackagesError}，错误文案不回显
 *  响应内容。zip 正文字节直接返回 Buffer，结构校验归 skill-sync。
 */

/** Maximum accepted catalog response body bytes. */
export const MAX_SKILL_PACKAGES_RESPONSE_BYTES = 64 * 1024

/** Maximum accepted skill-package rows in one catalog response. */
export const MAX_SKILL_PACKAGE_ROWS = 128

/** Maximum accepted package archive body bytes（契约 ≤5MB + 传输余量）. */
export const MAX_SKILL_PACKAGE_ARCHIVE_BYTES = 6 * 1024 * 1024

/** 技能包 id 命名空间：与 dsh-skill 的技能名同构（kebab-case）。
 *  该 id 同时是 zip 内唯一顶层目录名、SKILL.md frontmatter 的 `name`、
 *  以及 `<DSH_HOME>/skills/cloud/` 下的物化目录名。 */
export const SKILL_PACKAGE_ID_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u

/** 目录行：`GET /api/v1/skill-packages` 的 `packages[]` 同构（snake_case）。 */
export interface SkillPackageSummary {
  /** 稳定 id；kebab-case，与物化目录名一致。 */
  readonly id: string
  /** 展示名（≤100 字符）。 */
  readonly name: string
  /** 一句话描述（≤400 字符）。 */
  readonly description: string
  /** 声明的 zip 字节数（仅展示/诊断用；真实上限由有界读与解压校验执行）。 */
  readonly size_bytes: number
  /** 行版本；大于本地记录版本时重新下载。 */
  readonly version: number
}

/** `GET /api/v1/skill-packages` 的成功载荷。 */
export interface SkillPackageCatalog {
  /** 目录整体版本号（BFF 维护，仅诊断用）。 */
  readonly version: number
  /** 上架中的技能包清单。 */
  readonly packages: readonly SkillPackageSummary[]
}

/** Failure categories exposed to the Host skill sync. */
export type ChengziSkillPackagesErrorCode =
  | 'aborted'
  | 'http-status'
  | 'invalid-response'
  | 'network'
  | 'response-too-large'

/** Fetch-compatible request boundary supplied by the Host or a test. */
export type SkillPackagesRequest = (url: string, init: RequestInit) => Promise<Response>

/** Shared request inputs: origin override, transport, and caller-owned cancellation. */
export interface SkillPackagesRequestOptions {
  /** BFF origin; the Host entry validates and passes the account-sourced base. */
  readonly baseUrl: string
  /** Request implementation for a test or an adapter. */
  readonly request?: SkillPackagesRequest
  /** Caller-owned cancellation signal; this client creates no timeout of its own. */
  readonly signal?: AbortSignal
}

/** Archive download inputs: the package id in addition to the shared origin. */
export interface SkillPackageArchiveOptions extends SkillPackagesRequestOptions {
  /** Package id from a validated catalog row. */
  readonly id: string
}

/** Typed failure from the skill-package requests. */
export class ChengziSkillPackagesError extends Error {
  /** Stable programmatic failure category. */
  readonly code: ChengziSkillPackagesErrorCode
  /** HTTP status for an unsuccessful response, otherwise undefined. */
  readonly status: number | undefined

  constructor(code: ChengziSkillPackagesErrorCode, message: string, options: { readonly status?: number; readonly cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause })
    this.name = 'ChengziSkillPackagesError'
    this.code = code
    this.status = options.status
  }
}

/** Resolve and protocol-check a BFF route URL from a path-style origin. */
function routeUrl(baseUrl: string, path: string): URL {
  // 字符串拼接而非 `new URL(path, base)`：base 是路径式 origin（…/chengzi-api）时，
  // 以「/」开头的 path 会被 URL 语义当作绝对路径吃掉前缀。
  const base = baseUrl.replace(/\/+$/u, '')
  try {
    return new URL(`${base}${path}`)
  } catch {
    throw new ChengziSkillPackagesError('invalid-response', 'The skill-package service base URL is invalid.')
  }
}

function assertRouteProtocol(url: URL): void {
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && isLoopback(url.hostname))) {
    throw new ChengziSkillPackagesError('invalid-response', 'The skill-package service base URL is invalid.')
  }
}

/**
 * Read the public skill-package catalog from the BFF. No authentication is
 * required. Rows failing the id/shape contract are dropped（与 expert 目录
 * 客户端同策略：坏行不拖垮整张目录）.
 * @param options - origin, transport, and cancellation inputs.
 * @returns the validated catalog rows in server order.
 * @throws {ChengziSkillPackagesError} On transport failure, non-200 status, or invalid payload.
 */
export async function fetchSkillPackageCatalog(options: SkillPackagesRequestOptions): Promise<SkillPackageCatalog> {
  const url = routeUrl(options.baseUrl, '/api/v1/skill-packages')
  assertRouteProtocol(url)

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
      throw new ChengziSkillPackagesError('aborted', 'The skill-package service request was cancelled.', { cause })
    }
    throw new ChengziSkillPackagesError('network', `The skill-package service could not be reached. [${url.href}]`, { cause })
  }

  if (response.status !== 200) {
    await drain(response)
    throw new ChengziSkillPackagesError(
      'http-status',
      `The skill-package service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }

  const value = await readLimitedJson(response)
  if (!isRecord(value)
    || typeof value.version !== 'number'
    || !Number.isSafeInteger(value.version)
    || value.version < 0
    || !Array.isArray(value.packages)
    || value.packages.length > MAX_SKILL_PACKAGE_ROWS) {
    throw new ChengziSkillPackagesError('invalid-response', 'The skill-package service returned an invalid catalog response.')
  }
  const packages: SkillPackageSummary[] = []
  for (const entry of value.packages) {
    const row = parsePackageRow(entry)
    if (row === undefined) continue
    if (packages.some(existing => existing.id === row.id)) continue
    packages.push(row)
  }
  return { version: value.version, packages }
}

/**
 * Download one package archive（zip 字节流）. The response body is read with a
 * hard 6 MiB ceiling and returned as-is; structure validation lives in the
 * sync layer（skill-sync 的五重校验）.
 * @param options - origin, package id, transport, and cancellation inputs.
 * @returns the raw archive bytes.
 * @throws {ChengziSkillPackagesError} On transport failure, non-200 status, or an oversized body.
 */
export async function fetchSkillPackageArchive(options: SkillPackageArchiveOptions): Promise<Buffer> {
  if (typeof options.id !== 'string' || !SKILL_PACKAGE_ID_PATTERN.test(options.id)) {
    throw new ChengziSkillPackagesError('invalid-response', 'The skill-package id is invalid.')
  }
  const url = routeUrl(options.baseUrl, `/api/v1/skill-packages/${encodeURIComponent(options.id)}`)
  assertRouteProtocol(url)

  const request = options.request ?? defaultRequest
  let response: Response
  try {
    response = await request(url.href, {
      method: 'GET',
      headers: { accept: 'application/zip' },
      cache: 'no-store',
      redirect: 'error',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (options.signal?.aborted === true || isAbortFailure(cause)) {
      throw new ChengziSkillPackagesError('aborted', 'The skill-package service request was cancelled.', { cause })
    }
    throw new ChengziSkillPackagesError('network', `The skill-package service could not be reached. [${url.href}]`, { cause })
  }

  if (response.status !== 200) {
    await drain(response)
    throw new ChengziSkillPackagesError(
      'http-status',
      `The skill-package service returned HTTP ${String(response.status)}.`,
      { status: response.status },
    )
  }

  try {
    return await readLimitedBytes(response)
  } catch (cause) {
    if (cause instanceof ChengziSkillPackagesError) throw cause
    if (options.signal?.aborted === true || isAbortFailure(cause)) {
      throw new ChengziSkillPackagesError('aborted', 'The skill-package service request was cancelled.', { cause })
    }
    throw new ChengziSkillPackagesError('network', 'The skill-package service response could not be read.', { cause })
  }
}

function parsePackageRow(entry: unknown): SkillPackageSummary | undefined {
  if (!isRecord(entry)) return undefined
  if (typeof entry.id !== 'string' || !SKILL_PACKAGE_ID_PATTERN.test(entry.id)) return undefined
  if (typeof entry.name !== 'string' || entry.name.length === 0 || entry.name.length > 100) return undefined
  if (entry.description !== undefined
    && (typeof entry.description !== 'string' || entry.description.length > 400)) return undefined
  if (typeof entry.size_bytes !== 'number' || !Number.isSafeInteger(entry.size_bytes) || entry.size_bytes < 0) return undefined
  if (typeof entry.version !== 'number' || !Number.isSafeInteger(entry.version) || entry.version < 1) return undefined
  return {
    id: entry.id,
    name: entry.name,
    description: typeof entry.description === 'string' ? entry.description : '',
    size_bytes: entry.size_bytes,
    version: entry.version,
  }
}

async function defaultRequest(url: string, init: RequestInit): Promise<Response> {
  return globalThis.fetch(url, init)
}

/** Best-effort bounded drain of an error body so the socket is reusable. */
async function drain(response: Response): Promise<void> {
  try {
    await readLimitedBytes(response, MAX_SKILL_PACKAGES_RESPONSE_BYTES)
  } catch {
    // Error bodies are best-effort; the status code carries the failure.
  }
}

/** Read one JSON body with a hard byte ceiling; returns undefined for any unreadable body. */
async function readLimitedJson(response: Response): Promise<unknown> {
  let body: string
  try {
    body = await readLimitedText(response)
  } catch (cause) {
    if (cause instanceof ChengziSkillPackagesError) throw cause
    return undefined
  }
  try {
    return JSON.parse(body) as unknown
  } catch {
    return undefined
  }
}

async function readLimitedText(response: Response): Promise<string> {
  const bytes = await readLimitedBytes(response, MAX_SKILL_PACKAGES_RESPONSE_BYTES)
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
}

/** Read one binary body with a hard byte ceiling（上限默认为 zip 正文 6 MiB）. */
async function readLimitedBytes(response: Response, maxBytes: number = MAX_SKILL_PACKAGE_ARCHIVE_BYTES): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null
    && /^[0-9]+$/u.test(declaredLength)
    && BigInt(declaredLength) > BigInt(maxBytes)) {
    throw new ChengziSkillPackagesError('response-too-large', 'The skill-package service response is too large.')
  }

  if (response.body === null) return Buffer.alloc(0)
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let bytesRead = 0
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      bytesRead += chunk.value.byteLength
      if (bytesRead > maxBytes) {
        await reader.cancel().catch(() => undefined)
        throw new ChengziSkillPackagesError('response-too-large', 'The skill-package service response is too large.')
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
  return Buffer.concat(chunks)
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
