import { mkdtempSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { type Agent } from '@deepseek-ai/dsh-agent'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { Session, SessionId, SESSION_FORMAT_VERSION, type Agent as SessionAgent } from '@deepseek-ai/dsh-session'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { apply, inject, name } from '../src/index.ts'
import { parseArticle } from '../src/tool.ts'

let agentSeq = 0

function agentWith(cwd: string): Agent {
  agentSeq += 1
  const agentId = SessionId(`chengzi-reader-agent-${String(agentSeq)}`)
  const agent: SessionAgent = {
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
    runMaintenance: (task: AbortSignal) => { void task },
    whenIdle: () => Promise.resolve(),
  }
  return agent
}

async function boot(): Promise<{ ctx: Context; tools: ToolRuntime }> {
  const ctx = new Context()
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt)
  const tools = new ToolRuntime(ctx)
  return { ctx, tools }
}

/** A minimal but structurally faithful WeChat article page. */
const SAMPLE_HTML = `<!doctype html><html><head>
<meta property="og:title" content="机遇之城聚合力，热气腾腾启新程"/>
<meta property="og:article:author" content="海珠城发"/>
<script>var publish_time = "2026-06-04 10:00"</script>
</head><body>
<div class="rich_media_title" id="activity-name">机遇之城聚合力</div>
<div id="js_name"> 海珠城发 </div>
<div id="js_content" class="rich_media_content">
  <p>6月3日，由广州市工业和信息化局主办的招商发布活动在琶洲会展中心隆重举行。</p>
  <section>汇聚产业链上下游180余名嘉宾共话产业未来。</section>
  <img data-src="https://mmbiz.qpic.cn/mmbiz_jpg/abc123/640?wx_fmt=jpeg"/>
  <img data-src="https://mmbiz.qpic.cn/mmbiz_png/def456/640?wx_fmt=png"/>
  <img src="https://mmbiz.qpic.cn/mmbiz_gif/inline/040" style="display:none"/>
</div>
<script>var msg_title = "x";</script>
</body></html>`

describe('chengzi-reader plugin', () => {
  it('declares the expected contract and registers the tool', async () => {
    expect(name).toBe('chengzi-reader')
    expect([...inject]).toEqual(['tools'])
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(tools.get('read_wechat_article')).toBeDefined()
  })

  it('registers nothing when disabled', async () => {
    const { ctx, tools } = await boot()
    await ctx.plugin({ inject: [...inject], apply }, { enabled: false }).await()
    expect(tools.get('read_wechat_article')).toBeUndefined()
  })

  it('refuses non-WeChat URLs before any network I/O', async () => {
    const { ctx } = await boot()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const agent = agentWith(process.cwd())
    ctx.agents.enter(agent, undefined)
    for (const url of ['https://example.com/s/abc', 'http://mp.weixin.qq.com/s/abc', 'https://mp.weixin.qq.com/s/../../etc', 'not-a-url']) {
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId(`call-refuse-${String(agentSeq)}`),
        name: 'read_wechat_article',
        arguments: { url },
        agent,
      })
      expect(result.isError).toBe(false)
      expect((result.value as { status: string }).status).toBe('error')
    }
    expect(fetchSpy).not.toHaveBeenCalled()
    fetchSpy.mockRestore()
  })
})

describe('parseArticle', () => {
  it('extracts title, author, publish time, body text, and data-src images', () => {
    const parsed = parseArticle(SAMPLE_HTML)
    expect(parsed.title).toBe('机遇之城聚合力，热气腾腾启新程')
    expect(parsed.author).toBe('海珠城发')
    expect(parsed.publishTime).toBe('2026-06-04 10:00')
    expect(parsed.text).toContain('招商发布活动在琶洲会展中心隆重举行')
    expect(parsed.text).toContain('180余名嘉宾')
    expect(parsed.text.length).toBeGreaterThan(20)
    // Only lazy-load data-src images; inline display-only gifs are excluded.
    expect(parsed.images).toHaveLength(2)
    expect(parsed.images?.[0]?.url).toContain('mmbiz.qpic.cn')
  })

  it('tolerates a page without js_content (non-article)', () => {
    const parsed = parseArticle('<html><head><title>x</title></head><body></body></html>')
    expect(parsed.text).toBe('')
    expect(parsed.images).toHaveLength(0)
  })
})

describe('read_wechat_article behaviour (network, guarded)', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('reads a real article end-to-end when network allows (skipped without live check)', async () => {
    // Live smoke: the desktop egress passes WeChat's anti-crawler (verified
    // 2026-10-11). Skipped in CI-like environments by the env guard.
    if (process.env.CHENGZI_READER_LIVE !== '1') return
    const workspace = mkdtempSync(join(tmpdir(), 'chengzi-reader-'))
    try {
      const { ctx } = await boot()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const agent = agentWith(workspace)
      ctx.agents.enter(agent, undefined)
      const result = await ctx.tools.execute({
        signal: new AbortController().signal,
        callId: ToolCallId('call-live'),
        name: 'read_wechat_article',
        arguments: { url: 'https://mp.weixin.qq.com/s/EgHfEaNsBDnOx4XmaypK1w', downloadImages: true },
        agent,
      })
      expect(result.isError).toBe(false)
      if (result.isError) return
      const value = result.value as { status: string; title?: string; text?: string; images?: { localPath?: string }[] }
      expect(value.status).toBe('ok')
      expect(value.title).toContain('机遇之城')
      expect((value.text?.length ?? 0)).toBeGreaterThan(500)
      expect((value.images?.length ?? 0)).toBeGreaterThan(3)
      const downloaded = (value.images ?? []).filter(image => image.localPath !== undefined)
      expect(downloaded.length).toBeGreaterThan(0)
      const firstLocal = downloaded[0]?.localPath
      if (firstLocal !== undefined) {
        expect(existsSync(join(workspace, firstLocal))).toBe(true)
      }
      expect(readdirSync(join(workspace, 'wechat-images')).length).toBe(downloaded.length)
    } finally {
      rmSync(workspace, { recursive: true, force: true })
    }
  })

  it('parses the saved live fixture for offline regression (fixture committed with the test)', async () => {
    // Offline guard: the fixture is a trimmed copy of a real 2026-06-04 article
    // page (title/author/body structure kept, scripts and base64 stripped).
    const fixture = join(__dirname, 'fixtures', 'wechat-article.html')
    const html = readFileSync(fixture, 'utf8')
    const parsed = parseArticle(html)
    expect(parsed.title).toContain('机遇之城')
    expect(parsed.author).toBe('海珠城发')
    expect((parsed.text?.length ?? 0)).toBeGreaterThan(300)
    expect((parsed.images?.length ?? 0)).toBeGreaterThan(3)
  })
})
