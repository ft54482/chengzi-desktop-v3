import { describe, expect, it } from 'vitest'
import {
  ChengziBffError,
  createOrder,
  getApiKey,
  getOrderStatus,
  listPackages,
  login,
  loginWithPassword,
  MAX_BFF_RESPONSE_BYTES,
  sendSmsCode,
  type BffRequest,
} from '../src/bff-client.ts'

const BASE = 'https://bff.example.test'

function jsonResponse(status: number, value: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  })
}

function optionsWith(
  response: Response | ((url: string, init: RequestInit) => Response),
): { baseUrl: string; request: BffRequest } {
  return {
    baseUrl: BASE,
    request: async (_url: string, _init: RequestInit) =>
      typeof response === 'function' ? response(_url, _init) : response,
  }
}

describe('chengzi-account bff client', () => {
  it('accepts a successful sms-code response', async () => {
    await expect(
      sendSmsCode('13800138000', optionsWith(jsonResponse(200, { sent: true }))),
    ).resolves.toBeUndefined()
  })

  it('parses a successful login response', async () => {
    const result = await login('13800138000', '123456', optionsWith(jsonResponse(200, {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      user: { id: 'user-1', phone: '13800138000', nickname: '示例用户' },
      balance: { tokens: 12.5 },
      provisionState: 'ready',
    })))

    expect(result.accessToken).toBe('fake-access-token')
    expect(result.refreshToken).toBe('fake-refresh-token')
    expect(result.user.id).toBe('user-1')
    expect(result.user.phone).toBe('13800138000')
    expect(result.user.nickname).toBe('示例用户')
    expect(result.balance.tokens).toBe(12.5)
    expect(result.provisionState).toBe('ready')
  })

  it('accepts a login response with a null nickname (BFF contract)', async () => {
    const result = await login('13800138000', '123456', optionsWith(jsonResponse(200, {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      user: { id: 'user-1', phone: '13800138000', nickname: null },
      balance: { tokens: 0 },
      provisionState: 'pending',
    })))

    expect(result.user.nickname).toBeNull()
  })

  it('parses a successful password login response with a null phone (BFF contract)', async () => {
    let capturedInit: RequestInit | undefined
    const result = await loginWithPassword('official-user', 'secret-password', optionsWith(
      (_url: string, init: RequestInit) => {
        capturedInit = init
        return jsonResponse(200, {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          user: { id: 'user-9', phone: null, nickname: 'official-user' },
          balance: { tokens: 68493 },
          provisionState: 'ready',
        })
      },
    ))

    expect(result.accessToken).toBe('fake-access-token')
    expect(result.user.id).toBe('user-9')
    expect(result.user.phone).toBeNull()
    expect(result.user.nickname).toBe('official-user')
    expect(result.provisionState).toBe('ready')
    const rawBody = capturedInit?.body
    const body = JSON.parse(typeof rawBody === 'string' ? rawBody : 'null') as { username?: string; password?: string }
    expect(body.username).toBe('official-user')
    expect(body.password).toBe('secret-password')
  })

  it('rejects password login with a short password before any request', async () => {
    let requested = false
    const failure = await loginWithPassword('official-user', 'short', optionsWith(
      () => {
        requested = true
        return jsonResponse(200, {})
      },
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect(requested).toBe(false)
  })

  it('passes the server error field through on a 401 password login failure', async () => {
    const failure = await loginWithPassword('official-user', 'wrong-password-1', optionsWith(
      jsonResponse(401, { error: '账号或密码错误' }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).status).toBe(401)
    expect((failure as ChengziBffError).serverError).toBe('账号或密码错误')
  })

  it('keeps a path-bearing base URL prefix when joining request paths', async () => {
    let capturedUrl = ''
    const result = await loginWithPassword('official-user', 'secret-password', {
      baseUrl: 'https://pro.nat6.net/chengzi-api',
      request: async (url: string) => {
        capturedUrl = url
        return jsonResponse(200, {
          accessToken: 'fake-access-token',
          refreshToken: 'fake-refresh-token',
          user: { id: 'user-9', phone: null, nickname: 'official-user' },
          balance: { tokens: 0 },
          provisionState: 'ready',
        })
      },
    })

    expect(capturedUrl).toBe('https://pro.nat6.net/chengzi-api/api/v1/auth/login-password')
    expect(result.provisionState).toBe('ready')
  })

  it('passes the server error field through on a 4xx login failure', async () => {
    const failure = await login('13800138000', '123456', optionsWith(
      jsonResponse(400, { error: '手机号格式不正确' }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('http-status')
    expect((failure as ChengziBffError).status).toBe(400)
    expect((failure as ChengziBffError).serverError).toBe('手机号格式不正确')
  })

  it('passes the provisionState through on a 409 api-key response', async () => {
    const failure = await getApiKey('fake-access-token', optionsWith(
      jsonResponse(409, { error: 'provisioning in progress', provisionState: 'pending' }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('http-status')
    expect((failure as ChengziBffError).status).toBe(409)
    expect((failure as ChengziBffError).serverError).toBe('provisioning in progress')
    expect((failure as ChengziBffError).provisionState).toBe('pending')
  })

  it('fails safely on a non-JSON response without echoing the body', async () => {
    const failure = await login('13800138000', '123456', optionsWith(
      new Response('<html>not-json-boom</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('invalid-response')
    expect((failure as ChengziBffError).message).not.toContain('not-json-boom')
  })

  it('rejects an oversized declared response body', async () => {
    const failure = await sendSmsCode('13800138000', optionsWith(
      jsonResponse(200, { sent: true }, { 'content-length': String(MAX_BFF_RESPONSE_BYTES + 1) }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('response-too-large')
  })

  it('rejects an oversized streamed response body', async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const chunk = new Uint8Array(1024)
        for (let index = 0; index < MAX_BFF_RESPONSE_BYTES / 1024 + 8; index += 1) {
          controller.enqueue(chunk)
        }
        controller.close()
      },
    })
    const failure = await sendSmsCode('13800138000', optionsWith(
      new Response(stream, { status: 200 }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('response-too-large')
  })

  it('rejects a login response with a malformed payload', async () => {
    const failure = await login('13800138000', '123456', optionsWith(
      jsonResponse(200, { accessToken: 42, refreshToken: 'fake-refresh-token' }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('invalid-response')
  })

  it('rejects an invalid phone number before any request', async () => {
    let requested = false
    const failure = await sendSmsCode('12345', {
      baseUrl: BASE,
      request: async () => {
        requested = true
        return jsonResponse(200, { sent: true })
      },
    }).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('invalid-response')
    expect(requested).toBe(false)
  })

  it('parses a packages response', async () => {
    const packages = await listPackages('fake-access-token', optionsWith(jsonResponse(200, {
      packages: [
        { id: 'starter', name: '体验包', priceCents: 990, tokens: 1000000, bonusTokens: 0 },
        { id: 'standard', name: '标准包', priceCents: 2990, tokens: 3300000, bonusTokens: 300000 },
      ],
    })))

    expect(packages).toHaveLength(2)
    expect(packages[0]).toEqual({
      id: 'starter',
      name: '体验包',
      priceCents: 990,
      tokens: 1000000,
      bonusTokens: 0,
    })
    expect(packages[1]!.bonusTokens).toBe(300000)
  })

  it('parses an order creation response with the optional sandbox flag', async () => {
    const stubbed = await createOrder('starter', 'fake-access-token', optionsWith(jsonResponse(200, {
      orderNo: 'order-stub-1',
      amountCents: 990,
      qrCode: 'chengzipro-stub://order-stub-1',
      stub: true,
    })))

    expect(stubbed.orderNo).toBe('order-stub-1')
    expect(stubbed.amountCents).toBe(990)
    expect(stubbed.qrCode).toBe('chengzipro-stub://order-stub-1')
    expect(stubbed.stub).toBe(true)

    const plain = await createOrder('starter', 'fake-access-token', optionsWith(jsonResponse(200, {
      orderNo: 'order-live-2',
      amountCents: 2990,
      qrCode: 'https://qr.alipay.example/order-live-2',
    })))
    expect(plain.stub).toBeUndefined()
    expect(plain.qrCode).toBe('https://qr.alipay.example/order-live-2')
  })

  it('parses pending and paid order statuses', async () => {
    const pending = await getOrderStatus('order-3', 'fake-access-token', optionsWith(jsonResponse(200, {
      orderNo: 'order-3',
      status: 'pending',
      amountCents: 990,
      tokens: 1000000,
      createdAt: '2026-09-13T10:00:00.000Z',
      paidAt: null,
    })))
    expect(pending.status).toBe('pending')
    expect(pending.paidAt).toBeNull()

    const paid = await getOrderStatus('order-3', 'fake-access-token', optionsWith(jsonResponse(200, {
      orderNo: 'order-3',
      status: 'paid',
      amountCents: 990,
      tokens: 1000000,
      createdAt: '2026-09-13T10:00:00.000Z',
      paidAt: '2026-09-13T10:01:00.000Z',
    })))
    expect(paid.status).toBe('paid')
    expect(paid.paidAt).toBe('2026-09-13T10:01:00.000Z')
  })

  it('passes the server error field through on a 4xx order failure', async () => {
    const failure = await createOrder('missing', 'fake-access-token', optionsWith(
      jsonResponse(400, { error: '套餐不存在' }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('http-status')
    expect((failure as ChengziBffError).status).toBe(400)
    expect((failure as ChengziBffError).serverError).toBe('套餐不存在')
  })

  it('rejects an order status with an unknown lifecycle value', async () => {
    const failure = await getOrderStatus('order-4', 'fake-access-token', optionsWith(
      jsonResponse(200, {
        orderNo: 'order-4',
        status: 'refunded',
        amountCents: 990,
        tokens: 1000000,
        createdAt: '2026-09-13T10:00:00.000Z',
        paidAt: null,
      }),
    )).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('invalid-response')
  })
})
