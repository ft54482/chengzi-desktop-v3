import { describe, expect, it } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  ChengziBffError,
  listModels,
  type BffRequest,
} from '../src/bff-client.ts'
import {
  CHENGZI_PLATFORM_API_KEY_REF,
  CHENGZI_PLATFORM_BASE_URL,
  CHENGZI_PROVIDER_CREDENTIAL_KEY,
  CHENGZI_PROVIDER_ROUTE,
  getCatalogSnapshot,
  platformProviderProfile,
  storePlatformApiKey,
  storePlatformGroupKey,
  syncPlatformProvider,
  syncPlatformProviderSettings,
  type ChengziProviderSyncContext,
} from '../src/provider-sync.ts'

const PLATFORM_MODEL_IDS = [
  'glm-5.3',
  'glm-5.3-free',
  'gpt-image-2',
  'gpt-image-2-4K',
  'z-ai/glm-5.3-free',
]

const BASE = 'https://bff.example.test'

function createSyncContext(): {
  ctx: ChengziProviderSyncContext
  updates: { namespace: string; patch: object }[]
  records: Map<string, CredentialRecord>
  refValues: Map<string, string>
} {
  const updates: { namespace: string; patch: object }[] = []
  const records = new Map<string, CredentialRecord>()
  const refValues = new Map<string, string>()
  const ctx: ChengziProviderSyncContext = {
    settings: {
      update: async (namespace, patch) => {
        updates.push({ namespace, patch })
      },
    },
    credentials: {
      set: async (ref, value) => {
        refValues.set(ref, value)
      },
      modifyRecord: async (key, mutate) => {
        const current = records.get(key)
        const next = await mutate(current)
        if (next === undefined) return current
        records.set(key, next)
        return next
      },
    },
  }
  return { ctx, updates, records, refValues }
}

/** Transport serving the platform catalog with injectable failure. */
function catalogRequest(failure?: Error): BffRequest {
  return async () => {
    if (failure !== undefined) throw failure
    return new Response(JSON.stringify({
      apiBaseUrl: 'https://pro.nat6.net/v1',
      models: PLATFORM_MODEL_IDS.map(id => ({ id, displayName: id, provider: '橙子Pro平台' })),
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
}

describe('chengzi platform provider sync', () => {
  it('names models by the internal-baseline discount (group ratio), hiding full-price and free models', () => {
    const nameOf = (model: {
      id: string
      displayName?: string
      modelRatio?: number
      discountRatio?: number
      groupRatio?: number
      quotaType?: number
    }): string =>
      platformProviderProfile([model]).models[0]?.name ?? ''

    // 内部基准口径（2026-09-22 拍板）：徽章=组倍率（实付=基准×组倍率），
    // 不随厂商官网价/外部倍率录入错误波动（deepseek-v4.1-flash 0.19x 事件）
    expect(nameOf({ id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash', modelRatio: 0.137, groupRatio: 0.38 }))
      .toBe('DeepSeek V4 Flash · 0.38x')
    // 官网口径的 discountRatio 不再参与徽章——外部倍率录错（如 0.19x 事件）不污染显示
    expect(nameOf({ id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 Flash', modelRatio: 0.0685, discountRatio: 0.19, groupRatio: 0.38 }))
      .toBe('DeepSeek V4.1 Flash · 0.38x')
    // 组倍率 = 1（原价）不加徽章
    expect(nameOf({ id: 'claude-opus-5', displayName: 'Claude Opus 5', modelRatio: 2.5, groupRatio: 1 }))
      .toBe('Claude Opus 5')
    // 免费（倍率 0）不加徽章
    expect(nameOf({ id: 'glm-5.3-free', displayName: 'GLM-5.3（免费）', modelRatio: 0, groupRatio: 0.38 }))
      .toBe('GLM-5.3（免费）')
    // 无组倍率数据（旧目录）不猜数，直接不加徽章——宁缺勿误导
    expect(nameOf({ id: 'legacy', displayName: 'Legacy', modelRatio: 0.5 }))
      .toBe('Legacy')
    // <0.1 保留三位（0.063 → 0.063x）
    expect(nameOf({ id: 'qwen-high', displayName: 'Qwen High', modelRatio: 0.82, groupRatio: 0.0630 }))
      .toBe('Qwen High · 0.063x')
    // 按次计费（生图等）无 token 倍率概念，倍率/折扣字段一概不进名字——单价由选择器徽章展示
    expect(nameOf({
      id: 'gpt-image-2',
      displayName: 'GPT-Image-2',
      modelRatio: 0.2,
      groupRatio: 0.38,
      quotaType: 1,
    })).toBe('GPT-Image-2')
  })

  it('writes the platform provider profile into the llm-pi-ai namespace', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, PLATFORM_MODEL_IDS.map(id => ({ id })))

    expect(updates).toHaveLength(2)
    expect(updates[0]!.namespace).toBe('llm-pi-ai')
    const patch = updates[0]!.patch as {
      providers: Record<string, ReturnType<typeof platformProviderProfile>>
    }
    const profile = patch.providers[CHENGZI_PROVIDER_ROUTE]
    expect(profile).toBeDefined()
    if (profile === undefined) throw new Error('platform provider profile missing')
    expect(profile.displayName).toBe('橙子Pro 平台')
    expect(profile.api).toBe('openai-completions')
    expect(profile.baseURL).toBe(CHENGZI_PLATFORM_BASE_URL)
    expect(profile.baseURL).toBe('https://pro.nat6.net/v1')
    expect(profile.apiKeyEnv).toBe('CHENGZI_PLATFORM_API_KEY')
    expect(profile.defaultContextWindow).toBe(131072)
    expect(profile.defaultMaxTokens).toBe(8192)
    expect(profile.models).toEqual(PLATFORM_MODEL_IDS.map(id => ({ id, name: id })))
    // 默认模型联动：目录无免费款时取首个
    expect(updates[1]!.namespace).toBe('agent-default-model')
    expect(updates[1]!.patch).toEqual({ provider: 'chengzi-platform', model: PLATFORM_MODEL_IDS[0] })
  })

  it('follows the first free model in the catalog as the default', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [
      { id: 'glm-5.3', displayName: 'GLM-5.3', free: false },
      { id: 'qwen3-32b-free', displayName: 'Qwen 3-32B（免费）', free: true },
      { id: 'z-ai/glm-5.3-free', displayName: 'GLM-5.3（免费）', free: true },
    ])

    const defaults = updates.find(u => u.namespace === 'agent-default-model')
    expect(defaults?.patch).toEqual({ provider: 'chengzi-platform', model: 'qwen3-32b-free' })
  })

  it('prefers the operationally pinned deepseek-v4.1-flash over free models', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [
      { id: 'qwen3-32b-free', displayName: 'Qwen 3-32B（免费）', free: true },
      { id: 'deepseek-v4.1-flash', displayName: 'DeepSeek V4.1 flash', free: false },
    ])

    const defaults = updates.find(u => u.namespace === 'agent-default-model')
    expect(defaults?.patch).toEqual({ provider: 'chengzi-platform', model: 'deepseek-v4.1-flash' })
  })

  it('falls back to first-free when the pinned model is absent from the catalog', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [
      { id: 'glm-5.3', displayName: 'GLM-5.3', free: false },
      { id: 'qwen3-32b-free', displayName: 'Qwen 3-32B（免费）', free: true },
    ])

    expect(updates.find(u => u.namespace === 'agent-default-model')?.patch)
      .toEqual({ provider: 'chengzi-platform', model: 'qwen3-32b-free' })
  })

  it('keeps image models in the catalog snapshot but out of chat registration', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [
      { id: 'glm-5.3', displayName: 'GLM-5.3', free: false },
      { id: 'gpt-image-2', displayName: 'GPT-Image-2', category: 'image', quotaType: 1, inputPriceCny: 0.2 },
      { id: 'gpt-image-2-4K', displayName: 'GPT-Image-2 4K', category: 'image', quotaType: 1, inputPriceCny: 0.6 },
      { id: 'qwen3-32b-free', displayName: 'Qwen 3-32B（免费）', free: true },
    ])

    const patch = updates[0]!.patch as {
      providers: Record<string, ReturnType<typeof platformProviderProfile>>
    }
    expect(patch.providers[CHENGZI_PROVIDER_ROUTE]!.models.map(model => model.id))
      .toEqual(['glm-5.3', 'qwen3-32b-free'])
    // 目录快照（host /catalog、分组 key 查询与 chengzi-image 生图插件同源）收全量，
    // image 模型的元数据供生图插件取分组与按次单价
    expect(getCatalogSnapshot().map(model => model.id))
      .toEqual(['glm-5.3', 'gpt-image-2', 'gpt-image-2-4K', 'qwen3-32b-free'])
    // 默认模型联动在排除 image 后的目录上取首个免费款
    expect(updates.find(u => u.namespace === 'agent-default-model')?.patch)
      .toEqual({ provider: 'chengzi-platform', model: 'qwen3-32b-free' })
  })

  it('writes an ApiKeyRecord under the pi-ai route credential key', async () => {
    const { ctx, records, refValues } = createSyncContext()
    await storePlatformApiKey(ctx, 'fake-platform-api-key')

    expect(String(CHENGZI_PROVIDER_CREDENTIAL_KEY)).toBe('llm-pi-ai/chengzi-platform')
    expect(records.get(String(CHENGZI_PROVIDER_CREDENTIAL_KEY))).toEqual({
      kind: 'api-key',
      key: 'fake-platform-api-key',
    })
    // ref 面（apiKeyEnv 引用名）是 pi-ai 逐请求解析的主路径
    expect(String(CHENGZI_PLATFORM_API_KEY_REF)).toBe('CHENGZI_PLATFORM_API_KEY')
    expect(refValues.get('CHENGZI_PLATFORM_API_KEY')).toBe('fake-platform-api-key')
  })

  it('rejects an empty platform API key without writing a record', async () => {
    const { ctx, records } = createSyncContext()
    await expect(storePlatformApiKey(ctx, '')).rejects.toThrow()
    expect(records.size).toBe(0)
  })

  it('splits the catalog into per-group provider profiles and routes the pinned default model to its group', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [
      { id: 'deepseek-v4.1-flash', group: 'deepseek' },
      { id: 'qwen3-32b-free', group: 'vip' },
      { id: 'glm-5.2', group: 'glm' },
      { id: 'gpt-image-2', group: 'vip', category: 'image' },
    ])

    const patch = updates[0]!.patch as {
      providers: Record<string, { apiKeyEnv: string; models: { id: string }[] }>
    }
    // vip 组沿用历史单路由（兼容既有默认模型设置与凭据），vip 模型落在此处
    expect(patch.providers[CHENGZI_PROVIDER_ROUTE]!.apiKeyEnv).toBe('CHENGZI_PLATFORM_API_KEY')
    expect(patch.providers[CHENGZI_PROVIDER_ROUTE]!.models.map(m => m.id)).toEqual(['qwen3-32b-free'])
    // deepseek 组独立 profile（默认模型所属组，独立 env 凭据）
    expect(patch.providers['chengzi-platform-deepseek']!.apiKeyEnv)
      .toBe('CHENGZI_PLATFORM_API_KEY_DEEPSEEK')
    expect(patch.providers['chengzi-platform-deepseek']!.models.map(m => m.id))
      .toEqual(['deepseek-v4.1-flash'])
    // glm 组独立 profile
    expect(patch.providers['chengzi-platform-glm']!.models.map(m => m.id)).toEqual(['glm-5.2'])
    // image 模型不进任何聊天 profile
    for (const route of Object.keys(patch.providers)) {
      expect(patch.providers[route]!.models.some(m => m.id === 'gpt-image-2')).toBe(false)
    }
    // 默认模型联动：provider 跟随所属组路由（09-24 默认模型 503 实案根治）
    expect(updates.find(u => u.namespace === 'agent-default-model')?.patch)
      .toEqual({ provider: 'chengzi-platform-deepseek', model: 'deepseek-v4.1-flash' })
  })

  it('stores per-group keys under per-group credential refs and records', async () => {
    const { ctx, records, refValues } = createSyncContext()
    await storePlatformGroupKey(ctx, 'deepseek', 'sk-deepseek-key')
    await storePlatformGroupKey(ctx, 'vip', 'sk-vip-key')

    expect(refValues.get('CHENGZI_PLATFORM_API_KEY_DEEPSEEK')).toBe('sk-deepseek-key')
    expect(refValues.get('CHENGZI_PLATFORM_API_KEY')).toBe('sk-vip-key')
    expect(records.get('llm-pi-ai/chengzi-platform-deepseek')).toEqual({
      kind: 'api-key',
      key: 'sk-deepseek-key',
    })
    expect(records.get('llm-pi-ai/chengzi-platform')).toEqual({ kind: 'api-key', key: 'sk-vip-key' })
  })

  it('stores every group key passed through the combined sync', async () => {
    const { ctx, refValues } = createSyncContext()
    await syncPlatformProvider(ctx, {
      bffBaseUrl: BASE,
      request: catalogRequest(),
      getApiKey: () => 'sk-vip-key',
      getKeys: () => ({ vip: 'sk-vip-key', deepseek: 'sk-deepseek-key', glm: 'sk-glm-key' }),
    })

    expect(refValues.get('CHENGZI_PLATFORM_API_KEY')).toBe('sk-vip-key')
    expect(refValues.get('CHENGZI_PLATFORM_API_KEY_DEEPSEEK')).toBe('sk-deepseek-key')
    expect(refValues.get('CHENGZI_PLATFORM_API_KEY_GLM')).toBe('sk-glm-key')
  })

  it('writes no provider profile for an empty catalog', async () => {
    const { ctx, updates } = createSyncContext()
    await syncPlatformProviderSettings(ctx, [])
    expect(updates).toHaveLength(0)
  })

  it('syncs the catalog and the key in one call', async () => {
    const { ctx, updates, records } = createSyncContext()
    await syncPlatformProvider(ctx, {
      bffBaseUrl: BASE,
      request: catalogRequest(),
      getApiKey: () => 'fake-platform-api-key',
    })

    expect(updates).toHaveLength(2)
    expect(updates[0]!.namespace).toBe('llm-pi-ai')
    expect(updates[1]!.namespace).toBe('agent-default-model')
    expect(records.get(String(CHENGZI_PROVIDER_CREDENTIAL_KEY))).toEqual({
      kind: 'api-key',
      key: 'fake-platform-api-key',
    })
  })

  it('keeps the catalog sync when the key source fails, and vice versa', async () => {
    const keyFailure = new Error('fake key source unavailable')
    const withKeyFailure = createSyncContext()
    await expect(syncPlatformProvider(withKeyFailure.ctx, {
      bffBaseUrl: BASE,
      request: catalogRequest(),
      getApiKey: () => { throw keyFailure },
    })).rejects.toThrow('fake key source unavailable')
    expect(withKeyFailure.updates).toHaveLength(2)
    expect(withKeyFailure.records.size).toBe(0)

    const withCatalogFailure = createSyncContext()
    await expect(syncPlatformProvider(withCatalogFailure.ctx, {
      bffBaseUrl: BASE,
      request: catalogRequest(new Error('fake network failure')),
      getApiKey: () => 'fake-platform-api-key',
    })).rejects.toBeInstanceOf(ChengziBffError)
    expect(withCatalogFailure.updates).toHaveLength(0)
    expect(withCatalogFailure.records.get(String(CHENGZI_PROVIDER_CREDENTIAL_KEY))).toEqual({
      kind: 'api-key',
      key: 'fake-platform-api-key',
    })
  })
})

describe('chengzi platform model catalog client', () => {
  function jsonResponse(value: unknown): Response {
    return new Response(JSON.stringify(value), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  }

  it('parses the public models response', async () => {
    const result = await listModels({
      baseUrl: BASE,
      request: async () => jsonResponse({
        apiBaseUrl: 'https://pro.nat6.net/v1',
        models: [
          { id: 'glm-5.3', displayName: 'GLM-5.3', description: '旗舰思考模型', provider: '橙子Pro平台' },
          { id: 'z-ai/glm-5.3-free', displayName: 'GLM-5.3 免费(z-ai)' },
        ],
      }),
    })

    expect(result.apiBaseUrl).toBe('https://pro.nat6.net/v1')
    expect(result.models).toHaveLength(2)
    expect(result.models[0]).toEqual({
      id: 'glm-5.3',
      displayName: 'GLM-5.3',
      description: '旗舰思考模型',
      provider: '橙子Pro平台',
    })
    expect(result.models[1]).toEqual({ id: 'z-ai/glm-5.3-free', displayName: 'GLM-5.3 免费(z-ai)' })
  })

  it('parses per-call billing fields on catalog entries', async () => {
    const result = await listModels({
      baseUrl: BASE,
      request: async () => jsonResponse({
        models: [
          { id: 'gpt-image-2', displayName: 'GPT-Image-2', quotaType: 1, inputPriceCny: 0.2 },
          { id: 'glm-5.3', displayName: 'GLM-5.3', quotaType: 0, inputPriceCny: null },
          { id: 'bad-price', displayName: 'Bad', quotaType: 1, inputPriceCny: '0.2' },
        ],
      }),
    })

    expect(result.models[0]).toEqual({
      id: 'gpt-image-2',
      displayName: 'GPT-Image-2',
      quotaType: 1,
      inputPriceCny: 0.2,
    })
    // 按 token 模型不带计费类型字段
    expect(result.models[1]).toEqual({ id: 'glm-5.3', displayName: 'GLM-5.3' })
    // 非法单价丢弃、计费类型保留——宁缺勿误导
    expect(result.models[2]).toEqual({ id: 'bad-price', displayName: 'Bad', quotaType: 1 })
  })

  it('rejects a non-JSON response', async () => {
    const failure = await listModels({
      baseUrl: BASE,
      request: async () => new Response('<html>oops</html>', {
        status: 200,
        headers: { 'content-type': 'text/html' },
      }),
    }).catch((cause: unknown) => cause)

    expect(failure).toBeInstanceOf(ChengziBffError)
    expect((failure as ChengziBffError).code).toBe('invalid-response')
    expect((failure as ChengziBffError).message).not.toContain('oops')
  })

  it('rejects catalog entries without a non-empty id', async () => {
    const missingId = await listModels({
      baseUrl: BASE,
      request: async () => jsonResponse({ models: [{ id: 'glm-5.3' }, { displayName: 'no id' }] }),
    }).catch((cause: unknown) => cause)
    expect(missingId).toBeInstanceOf(ChengziBffError)
    expect((missingId as ChengziBffError).code).toBe('invalid-response')

    const emptyId = await listModels({
      baseUrl: BASE,
      request: async () => jsonResponse({ models: [{ id: '' }] }),
    }).catch((cause: unknown) => cause)
    expect(emptyId).toBeInstanceOf(ChengziBffError)
    expect((emptyId as ChengziBffError).code).toBe('invalid-response')

    const notAnArray = await listModels({
      baseUrl: BASE,
      request: async () => jsonResponse({ models: { glm: true } }),
    }).catch((cause: unknown) => cause)
    expect(notAnArray).toBeInstanceOf(ChengziBffError)
    expect((notAnArray as ChengziBffError).code).toBe('invalid-response')
  })
})
