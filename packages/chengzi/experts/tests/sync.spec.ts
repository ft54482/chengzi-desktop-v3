import { existsSync, mkdtempSync, readFileSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { BUILTIN_EXPERTS } from '../src/builtin-experts.js'
import type { CatalogResponse, ExpertDef } from '../src/expert-types.js'
import { COMPOSITION_FILE, readExpertMetadata } from '../src/materialize.js'
import { createExpertCatalogState, syncExpertPresets } from '../src/sync.js'

/** 合成 standard 组合（含 persona 行与两个后续顶层行）。 */
const STANDARD = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '- id: tool-ask-user',
  "  name: '@deepseek-ai/dsh-tool-ask-user'",
  '',
].join('\n')

function expert(overrides: Partial<ExpertDef> & { readonly id: string }): ExpertDef {
  return {
    name: `测试专家 ${overrides.id}`,
    icon: '🧪',
    description: '测试用',
    persona: `你是测试专家 ${overrides.id}。`,
    tools: [],
    skills: [],
    guided_intro: '我是测试专家。{cost_hint}',
    starter_prompts: ['示例问题'],
    cost_hint: null,
    model_hint: null,
    badge: null,
    enabled: true,
    version: 1,
    ...overrides,
  }
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chengzi-experts-sync-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

function run(catalog: () => Promise<CatalogResponse>, options: { readonly standardText?: () => string | undefined } = {}) {
  const warn = vi.fn()
  return syncExpertPresets({
    root,
    fetchCatalog: catalog,
    standardText: options.standardText ?? ((): string | undefined => STANDARD),
    now: () => new Date('2026-09-22T00:00:00Z'),
    warn,
  })
}

const ok = (experts: readonly ExpertDef[]): () => Promise<CatalogResponse> =>
  async () => ({ experts, source: 'cloud' })

const fail = (): () => Promise<CatalogResponse> =>
  async () => { throw new Error('network down') }

describe('syncExpertPresets', () => {
  it('degrades to the builtin catalog when the remote fails and deletes nothing', async () => {
    mkdirSync(join(root, 'expert-keepme'), { recursive: true })
    writeFileSync(join(root, 'expert-keepme', COMPOSITION_FILE), STANDARD)

    const outcome = await run(fail())

    expect(outcome.source).toBe('builtin')
    expect(outcome.experts.map(row => row.id)).toEqual(BUILTIN_EXPERTS.map(row => row.id))
    expect(outcome.removed).toEqual([])
    // 降级不删除：既有的 expert-keepme 目录保留。
    expect(existsSync(join(root, 'expert-keepme'))).toBe(true)
  })

  it('materializes remote experts and re-materializes on higher version', async () => {
    const first = await run(ok([expert({ id: 'expert-demo', version: 1 })]))
    expect(first.materialized).toEqual(['expert-demo'])
    expect(existsSync(join(root, 'expert-demo', COMPOSITION_FILE))).toBe(true)

    // version 不变 → 不动（materializedAt 不变）。
    const before = (await readExpertMetadata(root, 'expert-demo'))?.materializedAt
    const second = await run(ok([expert({ id: 'expert-demo', version: 1 })]))
    expect(second.materialized).toEqual([])
    expect((await readExpertMetadata(root, 'expert-demo'))?.materializedAt).toBe(before)

    // version 提高 → 重写。
    const third = await run(ok([expert({ id: 'expert-demo', version: 2 })]))
    expect(third.materialized).toEqual(['expert-demo'])
    expect((await readExpertMetadata(root, 'expert-demo'))?.expert.version).toBe(2)
  })

  it('deletes directories for disabled or vanished remote rows (cloud mode only)', async () => {
    await run(ok([expert({ id: 'expert-a' }), expert({ id: 'expert-b' })]))
    expect(existsSync(join(root, 'expert-a'))).toBe(true)
    expect(existsSync(join(root, 'expert-b'))).toBe(true)

    // enabled=false 触发删除，且不出现在生效清单。
    const outcome = await run(ok([expert({ id: 'expert-a' }), expert({ id: 'expert-b', enabled: false })]))
    expect(outcome.removed).toEqual(['expert-b'])
    expect(existsSync(join(root, 'expert-b'))).toBe(false)
    expect(outcome.experts.map(row => row.id)).toEqual(['expert-a'])

    // 远端消失 → 删除（云端清单权威）。
    const outcome2 = await run(ok([expert({ id: 'expert-a' })]))
    expect(outcome2.removed).toEqual([])
    const outcome3 = await run(ok([]))
    expect(outcome3.removed).toEqual(['expert-a'])
    expect(existsSync(join(root, 'expert-a'))).toBe(false)
  })

  it('never touches directories outside the expert- namespace or in expert-mine-*', async () => {
    mkdirSync(join(root, 'standard'), { recursive: true })
    writeFileSync(join(root, 'standard', 'sentinel.txt'), 'user preset')
    mkdirSync(join(root, 'expert-mine-mine'), { recursive: true })
    writeFileSync(join(root, 'expert-mine-mine', COMPOSITION_FILE), STANDARD)

    await run(ok([expert({ id: 'expert-mine-mine', version: 99 }), expert({ id: 'expert-ok' })]))

    // expert-mine-* 行被忽略（未物化 version 99），用户目录原样。
    expect(await readExpertMetadata(root, 'expert-mine-mine')).toBeUndefined()
    expect(readFileSync(join(root, 'expert-mine-mine', COMPOSITION_FILE), 'utf8')).toBe(STANDARD)
    expect(readFileSync(join(root, 'standard', 'sentinel.txt'), 'utf8')).toBe('user preset')
    // 但 expert-mine-* 目录也不被当作「远端消失的孤儿」删除。
    expect(existsSync(join(root, 'expert-mine-mine'))).toBe(true)
    expect(existsSync(join(root, 'expert-ok'))).toBe(true)
  })

  it('falls back to persona-only composition when standard is unreadable', async () => {
    const outcome = await run(ok([expert({ id: 'expert-bare' })]), { standardText: () => undefined })
    expect(outcome.materialized).toEqual(['expert-bare'])
    const composed = readFileSync(join(root, 'expert-bare', COMPOSITION_FILE), 'utf8')
    expect(composed).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(composed).toContain('你是测试专家 expert-bare。')
    expect(composed).not.toContain('{{model}}')
  })

  it('skips invalid remote rows instead of failing the sync', async () => {
    const bad = { ...expert({ id: 'not-an-expert-id' }) }
    const outcome = await run(ok([bad, expert({ id: 'expert-good' })]))
    expect(outcome.experts.map(row => row.id)).toEqual(['expert-good'])
    expect(existsSync(join(root, 'not-an-expert-id'))).toBe(false)
  })
})

describe('createExpertCatalogState', () => {
  it('serves the last catalog within maxAge and resyncs after it', async () => {
    let clock = 0
    const spy = vi.spyOn(Date, 'now').mockImplementation(() => clock)
    try {
      let rows: readonly ExpertDef[] = [expert({ id: 'expert-state' })]
      const state = createExpertCatalogState({
        root,
        standardText: () => STANDARD,
        fetchCatalog: async () => ({ experts: rows, source: 'cloud' }),
      })
      const first = await state.serve(5 * 60_000)
      expect(first.experts.map(row => row.id)).toEqual(['expert-state'])

      // 时钟推进 1 分钟：未超龄，不再拉远端（改了返回值也不生效）。
      clock += 60_000
      rows = [expert({ id: 'expert-changed' })]
      const cached = await state.serve(5 * 60_000)
      expect(cached.experts.map(row => row.id)).toEqual(['expert-state'])

      // 时钟推进超过 5 分钟：重新拉取。
      clock += 5 * 60_000
      const fresh = await state.serve(5 * 60_000)
      expect(fresh.experts.map(row => row.id)).toEqual(['expert-changed'])
      expect(fresh.source).toBe('cloud')
    } finally {
      spy.mockRestore()
    }
  })
})
