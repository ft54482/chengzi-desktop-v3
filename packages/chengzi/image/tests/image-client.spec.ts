import { describe, expect, it } from 'vitest'
import {
  assertSafePlatformOrigin,
  ChengziImagePlatformError,
  generateImages,
  type ImageRequest,
} from '../src/image-client.js'

function jsonResponse(body: string, init: { status?: number; contentType?: string; headers?: Record<string, string> } = {}): Response {
  return new Response(body, {
    status: init.status ?? 200,
    headers: {
      'content-type': init.contentType ?? 'application/json',
      ...init.headers,
    },
  })
}

/** Transport that plays a scripted sequence of responses and records calls. */
function scriptedTransport(responses: Array<() => Response>): {
  request: ImageRequest
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    request: (url, init) => {
      calls.push({ url, init })
      const next = responses.shift()
      if (next === undefined) return Promise.reject(new Error('no scripted response left'))
      return Promise.resolve(next())
    },
  }
}

describe('platform origin guard', () => {
  it('accepts production-style https origins', () => {
    const url = assertSafePlatformOrigin('https://pro.nat6.net/v1')
    expect(url.protocol).toBe('https:')
  })

  it('accepts plain HTTP only for loopback development origins', () => {
    expect(assertSafePlatformOrigin('http://127.0.0.1:8080/v1').hostname).toBe('127.0.0.1')
    expect(assertSafePlatformOrigin('http://localhost:9000/v1').hostname).toBe('localhost')
  })

  it('rejects non-http(s) schemes and loopback/private https targets', () => {
    expect(() => assertSafePlatformOrigin('ftp://pro.nat6.net/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('http://pro.nat6.net/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://localhost/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://127.0.0.1/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://10.1.2.3/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://172.16.0.9/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://192.168.1.4/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://169.254.169.254/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://[::1]/v1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('https://fd00::1')).toThrow(ChengziImagePlatformError)
    expect(() => assertSafePlatformOrigin('not a url')).toThrow(ChengziImagePlatformError)
  })
})

describe('generateImages', () => {
  const base = { baseUrl: 'https://platform.example/v1' }
  const input = { key: 'sk-test', model: 'gpt-image-2', prompt: 'a cat' }

  it('posts model/prompt/n with the bearer key to the images endpoint (b64 result)', async () => {
    const { request, calls } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ b64_json: 'QUJD' }], created: 1 })),
    ])
    const result = await generateImages(input, { ...base, request })
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe('https://platform.example/v1/images/generations')
    expect((calls[0]?.init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'gpt-image-2', prompt: 'a cat', n: 1 })
    expect(result.images).toEqual([{ mime: 'image/png', base64: 'QUJD' }])
    expect(result.revisedPrompt).toBeUndefined()
  })

  it('passes size through when provided', async () => {
    const { request, calls } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ b64_json: 'QQ' }] })),
    ])
    await generateImages({ ...input, size: '1024x1024' }, { ...base, request })
    expect(JSON.parse(calls[0]?.init.body as string)).toEqual({ model: 'gpt-image-2', prompt: 'a cat', n: 1, size: '1024x1024' })
  })

  it('downloads URL-form results with an image content type', async () => {
    const bytes = new Uint8Array([1, 2, 3, 4])
    const { request, calls } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ url: 'https://cdn.example/img/x' }] })),
      () => new Response(bytes, { status: 200, headers: { 'content-type': 'image/png' } }),
    ])
    const result = await generateImages(input, { ...base, request })
    expect(calls).toHaveLength(2)
    expect(calls[1]?.url).toBe('https://cdn.example/img/x')
    expect(result.images[0]).toEqual({ mime: 'image/png', base64: Buffer.from(bytes).toString('base64') })
  })

  it('follows exactly one guarded redirect hop when downloading', async () => {
    const { request, calls } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ url: 'https://cdn.example/old' }] })),
      () => new Response(null, { status: 302, headers: { location: 'https://cdn.example/new' } }),
      () => new Response(new Uint8Array([9]), { status: 200, headers: { 'content-type': 'image/jpeg' } }),
    ])
    const result = await generateImages(input, { ...base, request })
    expect(calls).toHaveLength(3)
    expect(calls[1]?.init.redirect).toBe('manual')
    expect(calls[2]?.url).toBe('https://cdn.example/new')
    expect(calls[2]?.init.redirect).toBe('error')
    expect(result.images[0]?.mime).toBe('image/jpeg')
  })

  it('refuses to download URL-form results pointing at private addresses', async () => {
    const { request, calls } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ url: 'https://10.0.0.5/secret' }] })),
    ])
    await expect(generateImages(input, { ...base, request })).rejects.toThrow(ChengziImagePlatformError)
    expect(calls).toHaveLength(1)
  })

  it('rejects non-image download content types', async () => {
    const { request } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ data: [{ url: 'https://cdn.example/x' }] })),
      () => new Response('<html/>', { status: 200, headers: { 'content-type': 'text/html' } }),
    ])
    await expect(generateImages(input, { ...base, request })).rejects.toThrow(/content type/)
  })

  it('maps platform errors to typed failures with the server message', async () => {
    const { request } = scriptedTransport([
      () => jsonResponse(JSON.stringify({ error: { message: '余额不足' } }), { status: 402 }),
    ])
    const failure = await generateImages(input, { ...base, request }).catch((cause: unknown) => cause) as ChengziImagePlatformError
    expect(failure).toBeInstanceOf(ChengziImagePlatformError)
    expect(failure.status).toBe(402)
    expect(failure.serverError).toBe('余额不足')
  })

  it('rejects malformed payloads', async () => {
    const noData = scriptedTransport([() => jsonResponse(JSON.stringify({ data: 'nope' }))])
    await expect(generateImages(input, { ...base, request: noData.request })).rejects.toThrow(/did not contain image data/)

    const emptyEntry = scriptedTransport([() => jsonResponse(JSON.stringify({ data: [{}] }))])
    await expect(generateImages(input, { ...base, request: emptyEntry.request })).rejects.toThrow(/without data/)

    const badJson = scriptedTransport([() => jsonResponse('<not json')])
    await expect(generateImages(input, { ...base, request: badJson.request })).rejects.toThrow(/not valid JSON/)
  })

  it('wraps transport failures without leaking the bearer key', async () => {
    const request: ImageRequest = () => Promise.reject(new Error('connect ECONNREFUSED platform.example:443'))
    const failure = await generateImages(input, { ...base, request }).catch((cause: unknown) => cause) as ChengziImagePlatformError
    expect(failure).toBeInstanceOf(ChengziImagePlatformError)
    expect(failure.status).toBe(0)
    expect(failure.message).toContain('could not be reached')
    expect(failure.message).not.toContain('Bearer ')
    expect(failure.message).not.toContain('sk-test')
  })
})
