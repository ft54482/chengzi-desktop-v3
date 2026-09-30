/** Pure HTTP client for the platform's OpenAI-compatible image endpoint.
 *
 *  Every request is a pure function of its inputs: the transport is injectable
 *  (defaults to `globalThis.fetch`), cancellation belongs to the caller's
 *  AbortSignal, response bodies are read with a hard byte ceiling, and every
 *  failure is a typed {@link ChengziImagePlatformError} whose message never
 *  echoes credentials. Outbound origins are validated before any request:
 *  only http/https, plain HTTP only for loopback development origins, and
 *  never loopback/private/reserved hosts (SSRF discipline).
 */

/** Maximum accepted JSON response body bytes (base64 images inflate ~33%). */
export const MAX_IMAGE_RESPONSE_BYTES = 20 * 1024 * 1024

/** Maximum accepted image bytes when fetching back a URL-form result. */
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024

/** Maximum characters echoed from a platform error message. */
const MAX_ERROR_CHARS = 200

const IMAGE_MIME_PATTERN = /^image\/[a-z0-9.+-]+$/u

/** Failure raised for platform transport, status, and response-shape problems. */
export class ChengziImagePlatformError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly serverError?: string,
  ) {
    super(message)
    this.name = 'ChengziImagePlatformError'
  }
}

/** Fetch-compatible request boundary supplied by the Host or a test. */
export type ImageRequest = (url: string, init: RequestInit) => Promise<Response>

/** Shared request inputs: platform origin override, transport, and cancellation. */
export interface ImageClientOptions {
  /** Platform origin serving `/v1` (e.g. `https://host/v1`); required. */
  readonly baseUrl: string
  /** Request implementation for the Host or a test; defaults to `globalThis.fetch`. */
  readonly request?: ImageRequest
  /** Caller-owned cancellation signal; this client creates no timeout of its own. */
  readonly signal?: AbortSignal
}

/** One generation request against the images endpoint. */
export interface ImageGenerationInput {
  /** Bearer key of the model's billing group (resolved by the Host routes). */
  readonly key: string
  readonly model: string
  readonly prompt: string
  /** Optional OpenAI-style size (`<width>x<height>`); pass-through when set. */
  readonly size?: string
}

export interface ImageGenerationResult {
  readonly images: readonly { readonly mime: string; readonly base64: string }[]
  readonly revisedPrompt?: string
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost'
    || hostname.endsWith('.localhost')
    || hostname === '::1'
    || hostname === '[::1]'
    || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname)
}

function isPrivateIpv4(hostname: string): boolean {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/u.exec(hostname)
  if (match === null) return false
  const octets = [match[1], match[2], match[3], match[4]].map(part => Number(part))
  if (octets.some(octet => !Number.isInteger(octet) || octet < 0 || octet > 255)) return true
  const [a, b] = octets as [number, number, number, number]
  if (a === 0 || a === 10 || a === 127) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  if (a >= 224) return true
  return false
}

function isPrivateOrReservedHost(hostname: string): boolean {
  if (isPrivateIpv4(hostname)) return true
  const bare = hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/ui.exec(bare)
  if (mapped !== null) return isPrivateIpv4(mapped[1] ?? '')
  if (bare === '::' || bare === '::1') return true
  const lowered = bare.toLowerCase()
  return lowered.startsWith('fc') || lowered.startsWith('fd')
    || (lowered.startsWith('fe8') || lowered.startsWith('fe9') || lowered.startsWith('fea') || lowered.startsWith('feb'))
}

/**
 * Validate an outbound platform origin before any request is issued.
 * @throws a {@link ChengziImagePlatformError} for every disallowed shape.
 */
export function assertSafePlatformOrigin(raw: string): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new ChengziImagePlatformError('The platform origin is not a valid URL.', 0)
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new ChengziImagePlatformError('Only http/https platform origins are allowed.', 0)
  }
  const hostname = url.hostname.toLowerCase()
  if (url.protocol === 'http:' && !isLoopbackHost(hostname)) {
    throw new ChengziImagePlatformError('Plain HTTP is only allowed for loopback development origins.', 0)
  }
  if (url.protocol === 'https:' && (isLoopbackHost(hostname) || isPrivateOrReservedHost(hostname))) {
    throw new ChengziImagePlatformError('The platform origin must not point at a loopback, private, or reserved address.', 0)
  }
  return url
}

function imagesEndpoint(baseUrl: string): string {
  const base = assertSafePlatformOrigin(baseUrl)
  const path = base.pathname.replace(/\/+$/u, '')
  return `${base.origin}${path}/images/generations`
}

/** Read a response body with a hard byte ceiling; rejects oversize before buffering. */
async function readBoundedText(response: Response, maxBytes: number, signal?: AbortSignal): Promise<string> {
  const header = response.headers.get('content-length')
  if (header !== null && Number(header) > maxBytes) {
    throw new ChengziImagePlatformError('The platform response was too large.', 0)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) {
    const text = await response.text()
    if (text.length > maxBytes) throw new ChengziImagePlatformError('The platform response was too large.', 0)
    return text
  }
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined)
      throw new ChengziImagePlatformError('The platform response was too large.', 0)
    }
    if (signal?.aborted) {
      await reader.cancel().catch(() => undefined)
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return new TextDecoder().decode(merged)
}

async function readErrorResponse(response: Response): Promise<ChengziImagePlatformError> {
  let serverError: string | undefined
  try {
    const text = await readBoundedText(response, 64 * 1024)
    const parsed = JSON.parse(text) as { error?: unknown; message?: unknown }
    const raw = typeof parsed.error === 'string'
      ? parsed.error
      : typeof parsed.error === 'object' && parsed.error !== null && typeof (parsed.error as { message?: unknown }).message === 'string'
        ? (parsed.error as { message: string }).message
        : typeof parsed.message === 'string' ? parsed.message : undefined
    if (typeof raw === 'string' && raw.trim().length > 0) {
      serverError = raw.trim().slice(0, MAX_ERROR_CHARS)
    }
  } catch {
    // Error bodies are best-effort; the status code carries the failure either way.
  }
  return new ChengziImagePlatformError(
    serverError ?? `The platform rejected the generation request (${String(response.status)}).`,
    response.status,
    serverError,
  )
}

/** Fetch one URL-form result back to the Host; one guarded redirect hop is allowed. */
async function fetchImageBytes(rawUrl: string, options: ImageClientOptions): Promise<{ mime: string; base64: string }> {
  const first = assertSafePlatformOrigin(rawUrl)
  const request = options.request ?? ((url, init) => fetch(url, init))
  let response: Response
  try {
    response = await request(first.href, {
      headers: { accept: 'image/png,image/jpeg,image/webp' },
      redirect: 'manual',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    throw new ChengziImagePlatformError(`The image could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}`, 0)
  }
  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get('location')
    if (location === null) throw new ChengziImagePlatformError('The platform returned a redirect without a location.', 0)
    const second = assertSafePlatformOrigin(new URL(location, first).href)
    try {
      response = await request(second.href, {
        headers: { accept: 'image/png,image/jpeg,image/webp' },
        redirect: 'error',
        ...(options.signal === undefined ? {} : { signal: options.signal }),
      })
    } catch (cause) {
      throw new ChengziImagePlatformError(`The image could not be downloaded: ${cause instanceof Error ? cause.message : String(cause)}`, 0)
    }
  }
  if (!response.ok) throw await readErrorResponse(response)
  const contentType = response.headers.get('content-type')?.split(';')[0]?.trim().toLowerCase() ?? ''
  if (!IMAGE_MIME_PATTERN.test(contentType)) {
    throw new ChengziImagePlatformError('The platform returned an unexpected content type for the image.', 0)
  }
  const reader = response.body?.getReader()
  if (reader === undefined) throw new ChengziImagePlatformError('The platform returned an empty image.', 0)
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > MAX_IMAGE_BYTES) {
      await reader.cancel().catch(() => undefined)
      throw new ChengziImagePlatformError('The image exceeded the download size limit.', 0)
    }
    chunks.push(value)
  }
  const merged = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    merged.set(chunk, offset)
    offset += chunk.byteLength
  }
  return { mime: contentType, base64: Buffer.from(merged).toString('base64') }
}

interface PlatformImageData {
  readonly b64_json?: unknown
  readonly url?: unknown
  readonly revised_prompt?: unknown
}

/**
 * Run one image generation against the platform images endpoint.
 * @throws {@link ChengziImagePlatformError} for guard, transport, status, and shape failures.
 */
export async function generateImages(input: ImageGenerationInput, options: ImageClientOptions): Promise<ImageGenerationResult> {
  const endpoint = imagesEndpoint(options.baseUrl)
  const request = options.request ?? ((url, init) => fetch(url, init))
  const body = JSON.stringify({
    model: input.model,
    prompt: input.prompt,
    n: 1,
    ...(input.size === undefined ? {} : { size: input.size }),
  })
  let response: Response
  try {
    response = await request(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${input.key}`,
      },
      body,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
  } catch (cause) {
    if (cause instanceof Error && cause.name === 'AbortError') throw cause
    throw new ChengziImagePlatformError(`The platform could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, 0)
  }
  if (!response.ok) throw await readErrorResponse(response)
  let payload: { data?: unknown; revised_prompt?: unknown }
  try {
    payload = JSON.parse(await readBoundedText(response, MAX_IMAGE_RESPONSE_BYTES, options.signal)) as typeof payload
  } catch (cause) {
    if (cause instanceof ChengziImagePlatformError || cause instanceof Error && cause.name === 'AbortError') throw cause
    throw new ChengziImagePlatformError('The platform response was not valid JSON.', 0)
  }
  if (!Array.isArray(payload.data)) {
    throw new ChengziImagePlatformError('The platform response did not contain image data.', 0)
  }
  const revisedPrompt = typeof payload.revised_prompt === 'string' && payload.revised_prompt.trim().length > 0
    ? payload.revised_prompt.trim().slice(0, 2_000)
    : undefined
  const images: { mime: string; base64: string }[] = []
  for (const raw of payload.data as unknown[]) {
    if (typeof raw !== 'object' || raw === null) {
      throw new ChengziImagePlatformError('The platform returned an image entry without data.', 0)
    }
    const entry = raw as PlatformImageData
    if (typeof entry.b64_json === 'string' && entry.b64_json.length > 0) {
      images.push({ mime: 'image/png', base64: entry.b64_json })
      continue
    }
    if (typeof entry.url === 'string' && entry.url.length > 0) {
      images.push(await fetchImageBytes(entry.url, options))
      continue
    }
    throw new ChengziImagePlatformError('The platform returned an image entry without data.', 0)
  }
  if (images.length === 0) {
    throw new ChengziImagePlatformError('The platform returned no image data.', 0)
  }
  return {
    images,
    ...(revisedPrompt === undefined ? {} : { revisedPrompt }),
  }
}
