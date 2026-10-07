import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply, AOCI_SECTION_TEXT, inject, name } from '../src/index.ts'

function agentWith(cwd: string): Agent {
  const agentId = SessionId('chengzi-aoci-agent')
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

async function boot(): Promise<{ ctx: Context; tools: ToolRuntime }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const tools = new ToolRuntime(ctx)
  return { ctx, tools }
}

interface RunToolResult {
  isError: boolean
  value: {
    status?: string
    installGuide?: string
    stdout?: string
  }
}

async function runTool(ctx: Context, tools: ToolRuntime, work: string, subcommand: string): Promise<RunToolResult> {
  const agent = agentWith(work)
  ctx.agents.enter(agent, undefined)
  const result = await ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`call-${subcommand}`),
    name: 'aoci',
    arguments: { subcommand },
    agent,
  })
  return { isError: result.isError, value: result.value as RunToolResult['value'] }
}

describe('chengzi-aoci plugin registration', () => {
  it('declares the expected contract', () => {
    expect(name).toBe('chengzi-aoci')
    expect([...inject]).toEqual(['tools', 'systemPrompt'])
  })

  it('registers the prompt section and the aoci tool', async () => {
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(tools.get('aoci')).toBeDefined()
    expect(await renderedSection(ctx)).toContain(AOCI_SECTION_TEXT.split('\n')[0])
  })

  it('registers nothing when disabled', async () => {
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }, { enabled: false }).await()
    expect(tools.get('aoci')).toBeUndefined()
    expect(await renderedSection(ctx)).not.toContain('仓库认知优先')
  })

  it('the cognition-first section asks for aoci status before first edits and stays optional', () => {
    expect(AOCI_SECTION_TEXT).toContain('status')
    expect(AOCI_SECTION_TEXT).toContain('init')
    expect(AOCI_SECTION_TEXT).toContain('不要反复推销')
  })
})

describe('aoci tool behaviour', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('answers not-installed with an install guide when no binary is resolvable', async () => {
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }).await()
    vi.stubEnv('AOCI_PATH', join(tmpdir(), 'chengzi-aoci-missing.exe'))
    vi.stubEnv('PATH', '')
    const result = await runTool(ctx, tools, process.cwd(), 'status')
    expect(result.isError).toBe(false)
    expect(result.value.status).toBe('not-installed')
    expect(result.value.installGuide).toContain('aoci-spec/aoci-code')
  })

  it('rejects subcommands outside the whitelist at schema level', async () => {
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const result = await runTool(ctx, tools, process.cwd(), 'mcp')
    expect(result.isError).toBe(true)
  })

  it('runs the real binary when AOCI_PATH points at one (local smoke, skipped without env)', async () => {
    const real = process.env.CHENGZI_AOCI_TEST_BINARY
    if (real === undefined || real.length === 0) return
    const work = mkdtempSync(join(tmpdir(), 'chengzi-aoci-'))
    try {
      // aoci discovers the governed repository through .git and exits 3
      // without it; capabilities also needs an initialized project.
      execFileSync('git', ['init', '-q'], { cwd: work })
      execFileSync(real, ['init', '--locale', 'zh-CN'], { cwd: work, stdio: ['ignore', 'ignore', 'inherit'] })
      vi.stubEnv('AOCI_PATH', real)
      const { ctx, tools } = await boot()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const result = await runTool(ctx, tools, work, 'capabilities')
      expect(result.isError).toBe(false)
      expect(result.value.status).toBe('ok')
      expect(result.value.stdout).toContain('aoci-capability-manifest')
    } finally {
      rmSync(work, { recursive: true, force: true })
    }
  })
})

async function renderedSection(ctx: Context): Promise<string> {
  const assembly = await ctx.systemPrompt.assemble({})
  return renderPrompt(assembly)
}
