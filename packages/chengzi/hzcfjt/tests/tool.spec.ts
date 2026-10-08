import { mkdtemp, readFile, readdir, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { defineHzcfjtPptTool, registerHzcfjtPptTool } from '../src/tool.js'

/** 同一 ctx 可能多次入池 agent（id 必须唯一），用自增序号区分。 */
let agentSeq = 0

function agentWith(cwd: string): Agent {
  agentSeq += 1
  const agentId = SessionId(`chengzi-hzcfjt-agent-${String(agentSeq)}`)
  return {
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
}

async function boot(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  registerHzcfjtPptTool(ctx, { maxSlides: 120 })
  return ctx
}

const SLIDES = [
  { type: 'cover', title: '2026年上半年工作总结', subtitle: '海珠城发集团' },
  { type: 'section', title: '整体概况' },
  { type: 'company', track: '低空经济', name: '联合飞机', profile: '简介正文', highlights: ['亮点一'], products: [{ name: 'Q20', text: '无人机' }], finance: ['2025年营业收入4.21亿元'] },
]

async function runTool(ctx: Context, workspace: string, args: Record<string, unknown>, callTag: string): Promise<
  { isError: true; error: { message: string } } | { isError: false; value: unknown }
> {
  const agent = agentWith(workspace)
  ctx.agents.enter(agent, undefined)
  return await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${callTag}`),
    name: 'generate_hzcfjt_ppt',
    arguments: args,
    agent,
  })
}

describe('chengzi-hzcfjt plugin tool registration', () => {
  it('registers the generate_hzcfjt_ppt tool under the stable global name', async () => {
    const ctx = await boot()
    try {
      const schema = ctx.tools.schemas().find(tool => tool.name === 'generate_hzcfjt_ppt')
      expect(schema).toBeDefined()
      expect(schema?.parameters).toMatchObject({
        type: 'object',
        properties: {
          topic: { type: 'string' },
          slides: { type: 'array' },
          filename: { type: 'string' },
        },
        required: ['topic', 'slides'],
      })
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('generate_hzcfjt_ppt tool behaviour', () => {
  it('generates a real pptx into the session workspace and reports the relative path', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-ppt-'))
    const ctx = await boot()
    try {
      const result = await runTool(ctx, workspace, { topic: '2026年上半年工作总结', slides: SLIDES }, 'generated')
      expect(result.isError).toBe(false)
      if (result.isError) return
      const value = result.value as { status?: string; file_path?: string; slide_count?: number; note?: string }
      expect(value.status).toBe('generated')
      // cover 与「整体概况」章节被固定头部替代：6 原版页 + 1 动态页（company）
      expect(value.slide_count).toBe(7)
      expect(value.note).toContain('已忽略传入的 2 页')
      expect(value.file_path).toBe('chengzi-ppt/2026年上半年工作总结.pptx')
      const info = await stat(join(workspace, value.file_path ?? ''))
      expect(info.size).toBeGreaterThan(4000)
      const bytes = await readFile(join(workspace, value.file_path ?? ''))
      expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('respects a custom filename', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-ppt-'))
    const ctx = await boot()
    try {
      const result = await runTool(ctx, workspace, { topic: '总结', filename: '城发-半年报', slides: SLIDES }, 'filename')
      expect(result.isError).toBe(false)
      if (result.isError) return
      expect((result.value as { file_path?: string }).file_path).toBe('chengzi-ppt/城发-半年报.pptx')
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('validates slides before touching the workspace and names the page-type whitelist', async () => {
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-ppt-'))
    const ctx = await boot()
    try {
      const badType = await runTool(ctx, workspace, { topic: 'x', slides: [{ type: 'nonsense' }] }, 'bad-type')
      expect(badType.isError).toBe(true)
      if (badType.isError) expect(badType.error.message).toMatch(/白名单/)
      const blankTopic = await runTool(ctx, workspace, { topic: '', slides: SLIDES }, 'blank-topic')
      expect(blankTopic.isError).toBe(true)
      if (blankTopic.isError) expect(blankTopic.error.message).toMatch(/topic/)
      expect(await readdir(workspace)).toEqual([])
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('requires a session workspace', async () => {
    const ctx = await boot()
    try {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-no-workspace'),
        name: 'generate_hzcfjt_ppt',
        arguments: { topic: 'x', slides: SLIDES },
      })
      expect(result.isError).toBe(true)
      if (result.isError) expect(result.error.message).toMatch(/session workspace/)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})

describe('generate_hzcfjt_ppt present hooks', () => {
  it('renders pending and completed cards through the present hooks', () => {
    const definition = defineHzcfjtPptTool({ maxSlides: 120 })
    // present hooks soften on replay: args that fail the parameter schema
    // decline to undefined, so the assertions use real call args.
    const args = { topic: '2026年上半年工作总结', slides: [] }
    const call = definition.presentCall?.(args)
    expect(call).toMatchObject({ card: 'generic' })
    expect(JSON.stringify(call)).toContain('生成海珠城发汇报 PPT')

    const generated = definition.presentResult?.(args, {
      isError: false,
      content: [{ type: 'text', text: 'generated' }],
      meta: { status: 'generated', filePath: 'chengzi-ppt/总结.pptx', slideCount: 7 },
    })
    expect(generated === undefined ? undefined : generated.title).toContain('chengzi-ppt/总结.pptx')
    expect(generated === undefined ? undefined : generated.title).toContain('7 页')

    // 失败与来历不明的 meta 一律回退通用渲染。
    expect(definition.presentResult?.(args, { isError: true, content: [], meta: { status: 'generated' } })).toBeUndefined()
    expect(definition.presentResult?.(args, { isError: false, content: [], meta: { nonsense: true } })).toBeUndefined()
    // 非真实调用参数：软校验直接回退。
    expect(definition.presentResult?.({}, { isError: false, content: [], meta: { status: 'generated', filePath: 'x' } })).toBeUndefined()
  })
})
