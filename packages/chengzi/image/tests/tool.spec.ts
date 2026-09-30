import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import {
  CredentialProvider,
  type CredentialInfo,
  type CredentialKey,
  type CredentialRecord,
  type CredentialRecordEntry,
  type CredentialRecordInfo,
  type CredentialRef,
  type ResolvedCredential,
} from '@deepseek-ai/dsh-credentials'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import UserQuestionService, {
  UserQuestionError,
  type AskUserQuestionAnswer,
  type AskUserQuestionItem,
  type AskUserQuestionRequest,
} from '@deepseek-ai/dsh-user-questions'

import { assertSafePlatformOrigin, type ImageRequest } from '../src/image-client.js'
import { defineGenerateImageTool, registerGenerateImageTool } from '../src/tool.js'
import { CHENGZI_PLATFORM_API_KEY_REF } from '../src/index.js'

const CONFIRM_LABEL = '确认生成'

/** Transport that plays one JSON response and records the request. */
function fakeTransport(response: { status?: number; body?: unknown } = {}): {
  request: ImageRequest
  calls: Array<{ url: string; init: RequestInit }>
} {
  const calls: Array<{ url: string; init: RequestInit }> = []
  return {
    calls,
    request: vi.fn(async (url: string, init: RequestInit) => {
      calls.push({ url, init })
      return new Response(
        JSON.stringify(response.body ?? { data: [{ b64_json: 'iVBORw0KGgo=' }], created: 1 }),
        { status: response.status ?? 200, headers: { 'content-type': 'application/json' } },
      )
    }),
  }
}

/** In-memory credential provider stubbing the account plugin's stored key. */
class StubCredentialProvider extends CredentialProvider {
  readonly apiKey: string | undefined

  constructor(ctx: Context, apiKey: string | undefined) {
    super(ctx)
    this.apiKey = apiKey
  }

  override async resolve(_ref: CredentialRef): Promise<ResolvedCredential | undefined> {
    return this.apiKey === undefined ? undefined : { value: this.apiKey, source: 'test' }
  }

  override async describe(_ref: CredentialRef): Promise<CredentialInfo> {
    return {
      configured: this.apiKey !== undefined,
      ...this.apiKey === undefined ? {} : { source: 'test' },
      writable: true,
    }
  }

  override async set(_ref: CredentialRef, _value: string): Promise<void> {}

  override async unset(_ref: CredentialRef): Promise<void> {}

  override async readRecord(_key: CredentialKey): Promise<CredentialRecord | undefined> {
    return undefined
  }

  override async describeRecord(_key: CredentialKey): Promise<CredentialRecordInfo> {
    return { configured: false, writable: true }
  }

  override async listRecords(): Promise<readonly CredentialRecordEntry[]> {
    return []
  }

  override async modifyRecord(
    _key: CredentialKey,
    _mutate: (current: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>,
  ): Promise<CredentialRecord | undefined> {
    return undefined
  }

  override async deleteRecord(_key: CredentialKey): Promise<void> {}
}

/** An answerer's scripted behavior for one `user-questions/request` waterfall. */
type Answerer = (request: AskUserQuestionRequest) => Promise<AskUserQuestionAnswer>

function agentWithWorkspace(cwd: string): Agent {
  const agentId = SessionId('chengzi-image-agent')
  const agent: Agent = {
    id: agentId,
    options: {},
    session: Session.create(agentId, [], {
      version: SESSION_FORMAT_VERSION, id: agentId, createdAt: 0, isSeeded: false, cwd,
    }),
    inbox: {
      nextTurn: [], nextStep: [], clear() {}, append() {}, prepend() {},
      replace: () => false, remove: () => false, splice: () => [],
    },
    status: 'idle',
    ctx: new Context(),
    send() {}, followup() {}, steer() {}, inject() {}, cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

async function setup(options: {
  /** Configured platform key; `null` models an unconfigured reference. */
  credential?: string | null
  answerer?: Answerer
  transport?: ImageRequest
} = {}): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(UserQuestionService)
  new StubCredentialProvider(ctx, options.credential === null ? undefined : options.credential ?? 'sk-vip')
  const answerer = options.answerer ?? (async () => ({ answers: [] }))
  ctx.on('user-questions/request', request => answerer(request))
  registerGenerateImageTool(ctx, {
    platformBaseUrl: 'https://platform.example/v1',
    ...options.transport === undefined ? {} : { request: options.transport },
  })
  return ctx
}

function questionIds(request: AskUserQuestionRequest): string[] {
  return request.questions.map(question => question.id)
}

function confirmQuestion(request: AskUserQuestionRequest): AskUserQuestionItem {
  const question = request.questions.find(item => item.id === 'confirm')
  expect(question).toBeDefined()
  return question!
}

describe('generate_image tool', () => {
  it('registers under the stable global name with the dual-schema projection', async () => {
    const ctx = await setup()
    const schema = ctx.tools.schemas().find(tool => tool.name === 'generate_image')
    expect(schema).toBeDefined()
    expect(schema?.parameters).toMatchObject({
      type: 'object',
      properties: {
        prompt: { type: 'string' },
        resolution: { type: 'string', enum: ['standard', '4k'] },
      },
      required: ['prompt'],
    })
    await ctx.fiber.dispose()
  })

  it('asks resolution + confirmation, then generates into the workspace', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const transport = fakeTransport()
    const requests: AskUserQuestionRequest[] = []
    const ctx = await setup({
      transport: transport.request,
      answerer: async (request) => {
        requests.push(request)
        return { answers: [
          { id: 'resolution', selected: ['标准（¥0.20/张）'] },
          { id: 'confirm', selected: [CONFIRM_LABEL] },
        ] }
      },
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-1'),
        name: 'generate_image',
        arguments: { prompt: 'a cat' },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      // 未指明分辨率：确认卡同时问分辨率与确认，共两问。
      expect(requests).toHaveLength(1)
      expect([...questionIds(requests[0]!)].sort()).toEqual(['confirm', 'resolution'])
      // 费用确认是 intent 审批式：approve 必须是本问选项之一，并附 detail 供审阅。
      const confirm = confirmQuestion(requests[0]!)
      expect(confirm.intent).toMatchObject({ kind: 'plan-review', approve: CONFIRM_LABEL, callId: 'call-1' })
      expect(confirm.detail).toContain('¥0.20')
      expect(result.value).toMatchObject({
        status: 'generated',
        model: 'gpt-image-2',
        price_cny: 0.2,
      })
      const value = result.value as { file_path: string }
      expect(value.file_path).toMatch(/^chengzi-images\/image-\d{8}-\d{6}\.png$/u)
      const bytes = await readFile(join(workspace, value.file_path))
      expect(bytes.subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      // 平台 key 按次经 credentials.resolve 解析（vip 分组常量引用）。
      expect(transport.calls).toHaveLength(1)
      const init = transport.calls[0]?.init
      expect((init?.headers as Record<string, string>).authorization).toBe('Bearer sk-vip')
      expect(JSON.parse(init?.body as string)).toMatchObject({ model: 'gpt-image-2', prompt: 'a cat' })
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('skips the resolution question when the model states one and uses 4k', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const transport = fakeTransport()
    const requests: AskUserQuestionRequest[] = []
    const ctx = await setup({
      transport: transport.request,
      answerer: async (request) => {
        requests.push(request)
        return { answers: [{ id: 'confirm', selected: [CONFIRM_LABEL] }] }
      },
    })
    try {
      const resolve = vi.spyOn(ctx.credentials, 'resolve')
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-2'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: '4k' },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      expect(questionIds(requests[0]!)).toEqual(['confirm'])
      expect(confirmQuestion(requests[0]!).detail).toContain('¥0.60')
      expect(result.value).toMatchObject({ model: 'gpt-image-2-4K', price_cny: 0.6 })
      // 平台 key 按次经 credentials.resolve(CHENGZI_PLATFORM_API_KEY_REF) 解析。
      expect(JSON.parse(transport.calls[0]?.init.body as string)).toMatchObject({ model: 'gpt-image-2-4K' })
      expect(resolve).toHaveBeenCalledWith(CHENGZI_PLATFORM_API_KEY_REF)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('bills nothing when the user cancels the confirmation', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const transport = fakeTransport()
    const ctx = await setup({
      transport: transport.request,
      answerer: async () => ({ answers: [{ id: 'confirm', selected: ['取消，不生成'] }] }),
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-3'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      expect(result.value).toMatchObject({ status: 'cancelled' })
      expect(result.value).not.toHaveProperty('file_path')
      expect(transport.calls).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('settles a dismissed confirmation card as cancelled', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const transport = fakeTransport()
    const ctx = await setup({
      transport: transport.request,
      answerer: async () => {
        throw new UserQuestionError('the user cancelled the question card', 'ASK_CANCELLED')
      },
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-4'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      expect(result.value).toMatchObject({ status: 'cancelled' })
      expect(transport.calls).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('treats a missing confirm answer as cancelled', async () => {
    const ctx = await setup()
    const agent = agentWithWorkspace(await mkdtemp(join(tmpdir(), 'chengzi-image-')))
    try {
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-5'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(false)
      if (!result.isError) expect(result.value).toMatchObject({ status: 'cancelled' })
    } finally {
      await rm(agent.session.header.cwd ?? '', { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('refuses to run outside an agent workspace with an actionable error', async () => {
    const ctx = await setup({ answerer: async () => ({ answers: [{ id: 'confirm', selected: [CONFIRM_LABEL] }] }) })
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-6'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
      })
      expect(result.isError).toBe(true)
      if (result.isError) expect(result.error.message).toMatch(/session workspace/)
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('fails with an actionable error when no platform credential is configured', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const transport = fakeTransport()
    const ctx = await setup({
      credential: null,
      transport: transport.request,
      answerer: async () => ({ answers: [{ id: 'confirm', selected: [CONFIRM_LABEL] }] }),
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-7'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(true)
      if (result.isError) expect(result.error.message).toMatch(/平台凭据/)
      expect(transport.calls).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('rejects blank and oversize prompts before asking the user', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const requests: AskUserQuestionRequest[] = []
    const ctx = await setup({
      answerer: async (request) => {
        requests.push(request)
        return { answers: [] }
      },
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const blank = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-8'),
        name: 'generate_image',
        arguments: { prompt: '   ' },
        agent,
      })
      expect(blank.isError).toBe(true)
      if (blank.isError) expect(blank.error.message).toMatch(/prompt/)
      const oversize = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-9'),
        name: 'generate_image',
        arguments: { prompt: 'x'.repeat(4_001) },
        agent,
      })
      expect(oversize.isError).toBe(true)
      if (oversize.isError) expect(oversize.error.message).toMatch(/prompt/)
      expect(requests).toHaveLength(0)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('maps a 402 platform failure to an insufficient-balance tool error', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const ctx = await setup({
      transport: fakeTransport({ status: 402, body: { error: { message: '余额不足' } } }).request,
      answerer: async () => ({ answers: [{ id: 'confirm', selected: [CONFIRM_LABEL] }] }),
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-10'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(true)
      if (result.isError) expect(result.error.message).toContain('余额不足')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('keeps the workspace clean on write failure paths (dir created only on success)', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'chengzi-image-'))
    const ctx = await setup({
      transport: fakeTransport({ status: 500, body: { error: 'boom' } }).request,
      answerer: async () => ({ answers: [{ id: 'confirm', selected: [CONFIRM_LABEL] }] }),
    })
    try {
      const agent = agentWithWorkspace(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-11'),
        name: 'generate_image',
        arguments: { prompt: 'a cat', resolution: 'standard' },
        agent,
      })
      expect(result.isError).toBe(true)
      const entries = await import('node:fs/promises').then(fs => fs.readdir(workspace))
      expect(entries).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('renders pending and completed cards through the present hooks', async () => {
    const ctx = await setup()
    try {
      const definition = defineGenerateImageTool(ctx, { platformBaseUrl: 'https://platform.example/v1' })
      // present hooks soften on replay: args that fail the parameter schema
      // decline to undefined, so the assertions use real call args.
      const args = { prompt: 'a cat', resolution: '4k' as const }
      const call = definition.presentCall?.(args)
      expect(call).toMatchObject({ card: 'generic' })
      expect(JSON.stringify(call)).toContain('生成图片')

      const generated = definition.presentResult?.(args, {
        isError: false,
        content: [{ type: 'text', text: 'generated' }],
        meta: { status: 'generated', filePath: 'chengzi-images/image-1.png', model: 'gpt-image-2', priceCny: 0.2 },
      })
      expect(generated === undefined ? undefined : generated.title).toContain('chengzi-images/image-1.png')

      const cancelled = definition.presentResult?.(args, {
        isError: false,
        content: [{ type: 'text', text: 'cancelled' }],
        meta: { status: 'cancelled' },
      })
      expect(cancelled === undefined ? undefined : cancelled.title).toContain('未扣费')

      // 失败与来历不明的 meta 一律回退通用渲染。
      expect(definition.presentResult?.(args, { isError: true, content: [], meta: { status: 'generated' } })).toBeUndefined()
      expect(definition.presentResult?.(args, { isError: false, content: [], meta: { nonsense: true } })).toBeUndefined()
      // 非真实调用参数：软校验直接回退。
      expect(definition.presentResult?.({}, { isError: false, content: [], meta: { status: 'generated', filePath: 'x' } })).toBeUndefined()
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

/** Re-exported guard keeps the SSRF surface imported from the plugin entry exercised. */
describe('platform origin guard re-export', () => {
  it('accepts production-style https origins', () => {
    expect(assertSafePlatformOrigin('https://pro.nat6.net/v1').protocol).toBe('https:')
  })
})
