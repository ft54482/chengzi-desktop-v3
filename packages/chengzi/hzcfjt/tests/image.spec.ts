import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId, SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'

import { renderDeck, renderSlide } from '../src/pptx/writer.js'
import { registerHzcfjtPptTool } from '../src/tool.js'

const run = promisify(execFile)

/** 1×1 红色像素的合法 PNG。 */
const TINY_PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

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

const SLIDES_WITH_IMAGES = [
  { type: 'cover', title: '测试封面', image: 'assets/cover.png' },
  { type: 'image', title: '效果图', image: 'assets/cover.png', caption: '设计示意' },
  { type: 'end' },
]

describe('配图嵌入（writer）', () => {
  it('把工作区图片作为 media 部件嵌入并挂上 slide rels（同路径去重）', async () => {
    const resolved = SLIDES_WITH_IMAGES.map(page => ({
      ...page,
      ...(typeof page.image === 'string'
        ? { __img: { source: page.image, bytes: TINY_PNG, ext: 'png' as const } }
        : {}),
    }))
    const bytes = renderDeck('配图测试', resolved as never)
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-img-'))
    const path = join(workspace, 'deck.pptx')
    await writeFile(path, bytes)
    try {
      const result = await run('python', ['-c', [
        'import zipfile,sys',
        'z=zipfile.ZipFile(sys.argv[1])',
        'media=[n for n in z.namelist() if n.startswith("ppt/media/gen-image")]',
        'assert len(media)==1, media',
        'assert media[0].endswith(".png"), media',
        'assert len(z.read(media[0]))==int(sys.argv[2]), "media bytes mismatch"',
        'rels=z.read("ppt/slides/_rels/slide7.xml.rels").decode("utf-8")',
        'assert "image" in rels and "rIdImg1" in rels, rels',
        's1=z.read("ppt/slides/slide7.xml").decode("utf-8")',
        'assert "<p:pic>" in s1 and "rIdImg1" in s1, "pic missing on slide7"',
        's2=z.read("ppt/slides/_rels/slide8.xml.rels").decode("utf-8")',
        'assert "rIdImg1" in s2, "dedupe by path failed"',
        'ct=z.read("[Content_Types].xml").decode("utf-8")',
        'assert "image/png" in ct',
        'print("img-ok")',
      ].join('\n'), path, TINY_PNG.length.toString()])
      expect(result.stdout).toContain('img-ok')
    } finally {
      await rm(workspace, { recursive: true, force: true })
    }
  })

  it('renders an image page with caption and contain-fit picture', () => {
    const page = { type: 'image', title: '效果图', image: 'assets/cover.png', caption: '示意图' }
    const xml = renderSlide(page as never, 0, 0, { rId: 'rIdImg1', w: 1024, h: 1024 })
    expect(xml).toContain('<p:pic>')
    expect(xml).toContain('效果图')
    expect(xml).toContain('示意图')
  })
})

describe('generate_hzcfjt_ppt 配图链路', () => {
  it('reads workspace images, dedupes, and embeds them in the deck', async () => {
    const ctx = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-tool-'))
    try {
      const assets = join(workspace, 'assets')
      await mkdir(assets)
      await writeFile(join(assets, 'cover.png'), TINY_PNG)
      const agent = agentWith(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-with-images'),
        name: 'generate_hzcfjt_ppt',
        arguments: { topic: '配图测试', slides: SLIDES_WITH_IMAGES },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      const value = result.value as { status?: string; file_path?: string }
      expect(value.status).toBe('generated')
      const deck = await readFile(join(workspace, value.file_path ?? ''))
      expect(deck.length).toBeGreaterThan(TINY_PNG.length)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })

  it('rejects missing and traversal image paths before rendering', async () => {
    const ctx = await boot()
    const workspace = await mkdtemp(join(tmpdir(), 'hzcfjt-tool-'))
    try {
      const missing = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-missing-image'),
        name: 'generate_hzcfjt_ppt',
        arguments: { topic: 'x', slides: [{ type: 'cover', title: 't', image: '不存在.png' }] },
        agent: agentWith(workspace),
      })
      expect(missing.isError).toBe(true)
      if (missing.isError) expect(missing.error.message).toMatch(/不存在/)
      const traversal = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-traversal-image'),
        name: 'generate_hzcfjt_ppt',
        arguments: { topic: 'x', slides: [{ type: 'cover', title: 't', image: '../x.png' }] },
        agent: agentWith(workspace),
      })
      expect(traversal.isError).toBe(true)
      if (traversal.isError) expect(traversal.error.message).toMatch(/父级穿越/)
    } finally {
      await rm(workspace, { recursive: true, force: true })
      await ctx.fiber.dispose()
    }
  })
})
