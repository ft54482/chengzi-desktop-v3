import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import { ChengziExpertsError } from '../src/expert-client.js'
import type { ExpertDef } from '../src/expert-types.js'
import { COMPOSITION_FILE, EXPERT_METADATA_FILE, PRESET_METADATA_FILE, readExpertMetadata } from '../src/materialize.js'
import type { MineBackupResult, MineExpertInput } from '../src/mine-types.js'
import { MINE_ALLOWED_TOOLS } from '../src/mine-types.js'
import {
  backupMineExpertsToCloud,
  restoreMineExpertsFromCloud,
  SessionRequiredError,
  withChengziSession,
} from '../src/mine-cloud.js'
import {
  deleteMineExpertDirectory,
  deriveMineExpertId,
  listBrokenMineExperts,
  listMineExperts,
  mergeCatalogWithMine,
  MineExpertValidationError,
  saveMineExpert,
  slugifyMineName,
  validateMineExpertInput,
} from '../src/mine-experts.js'
import { listCustomExperts } from '../src/custom-experts-client.js'

/** 合成 standard 组合（含 persona 行与一个后续顶层行）。 */
const STANDARD = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '',
].join('\n')

const NOW = new Date('2026-09-23T00:00:00Z')

function input(overrides: Partial<MineExpertInput> = {}): MineExpertInput {
  return {
    name: '周报助手',
    icon: '🤖',
    description: '把零散记录整理成周报',
    persona: '你是「周报助手」，帮助用户整理周报。',
    tools: ['generate_image'],
    starter_prompts: ['帮我写本周周报'],
    cost_hint: '',
    ...overrides,
  }
}

/** 记录变更函数的形状（与凭据封印的 modifyRecord 一致）。 */
type RecordMutate = (record: CredentialRecord | undefined) => Promise<CredentialRecord | undefined>

/** ChengziSessionContext 的结构化伪凭据封印（记录 saveSession 的写入）。 */
function fakeCredentials(payload: unknown): {
  readonly ctx: { readonly credentials: unknown }
  readonly stored: () => unknown
} {
  let current: CredentialRecord | undefined = payload === undefined ? undefined : { kind: 'grant', payload }
  return {
    ctx: {
      credentials: {
        readRecord: async (): Promise<CredentialRecord | undefined> => current,
        modifyRecord: async (_key: unknown, mutate: RecordMutate): Promise<CredentialRecord | undefined> => {
          current = await mutate(current)
          return current
        },
        deleteRecord: async (): Promise<void> => { current = undefined },
      },
    },
    stored: () => current,
  }
}

const SESSION_PAYLOAD = {
  accessToken: 'token-a',
  refreshToken: 'refresh-1',
  phone: '13800000000',
  savedAt: new Date('2026-09-23T00:00:00Z').toISOString(),
}

/** 一次被记录的请求。 */
interface RecordedRequest {
  readonly url: string
  readonly method: string
  readonly auth: string | undefined
  readonly body: string | undefined
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

/** 记录请求并按注册的处理表回应。 */
interface FakeRoute {
  readonly match: (url: string, method: string) => boolean
  readonly reply: (url: string, method: string) => Response
}

function fakeTransport(
  handlers: readonly FakeRoute[],
  log: RecordedRequest[],
): (url: string, init: RequestInit) => Promise<Response> {
  return async (url, init) => {
    const method = String(init.method)
    const headers = (init.headers ?? {}) as Record<string, string>
    log.push({ url, method, auth: headers.authorization, body: typeof init.body === 'string' ? init.body : undefined })
    for (const handler of handlers) {
      if (handler.match(url, method)) return handler.reply(url, method)
    }
    return jsonResponse({ error: 'no route' }, 404)
  }
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chengzi-experts-mine-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('validateMineExpertInput', () => {
  it('normalizes trimmed fields and keeps whitelisted tools only', () => {
    const normalized = validateMineExpertInput(input({
      name: '  周报助手  ',
      tools: ['generate_image', 'generate_image', 'generate_video'],
      starter_prompts: [' 问题一 ', ''],
      cost_hint: '  配图 ¥0.20/张 ',
    }))
    expect(normalized.name).toBe('周报助手')
    expect(normalized.tools).toEqual(['generate_image', 'generate_video'])
    expect(normalized.starter_prompts).toEqual(['问题一'])
    expect(normalized.cost_hint).toBe('配图 ¥0.20/张')
  })

  it('rejects out-of-range or off-whitelist fields with field names', () => {
    expect(() => validateMineExpertInput(input({ name: '一'.repeat(21) }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ persona: '  ' }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ persona: '长'.repeat(8001) }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ tools: ['not-a-tool'] }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ starter_prompts: ['a', 'b', 'c', 'd'] }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ starter_prompts: ['长'.repeat(61)] }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ cost_hint: '长'.repeat(201) }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput(input({ description: '长'.repeat(61) }))).toThrow(MineExpertValidationError)
    expect(() => validateMineExpertInput('not-an-object')).toThrow(MineExpertValidationError)
    // 白名单本身不被改动：三个工具全勾合法。
    expect(validateMineExpertInput(input({ tools: [...MINE_ALLOWED_TOOLS] })).tools).toEqual([...MINE_ALLOWED_TOOLS])
  })
})

describe('saveMineExpert / listMineExperts / deleteMineExpertDirectory', () => {
  it('creates a materialized directory with mine metadata and derived fields', async () => {
    const expert = await saveMineExpert(root, input({ cost_hint: '配图 ¥0.20/张' }), { standardText: STANDARD, now: NOW })

    expect(expert.id).toMatch(/^expert-mine-[a-z0-9-]+$/u)
    expect(expert.id).toBe(`expert-mine-${slugifyMineName('周报助手')}-${NOW.getTime().toString(36)}`)
    expect(expert.badge).toBe('我的')
    expect(expert.enabled).toBe(true)
    expect(expert.model_hint).toBeNull()
    expect(expert.guided_intro).toContain(expert.name)
    expect(expert.guided_intro).toContain('{cost_hint}')

    const directory = join(root, expert.id)
    expect(existsSync(join(directory, COMPOSITION_FILE))).toBe(true)
    expect(existsSync(join(directory, PRESET_METADATA_FILE))).toBe(true)
    expect(existsSync(join(directory, EXPERT_METADATA_FILE))).toBe(true)

    const meta = await readExpertMetadata(root, expert.id)
    expect(meta?.source).toBe('mine')
    expect(meta?.expert.persona).toBe(input().persona)

    const composed = readFileSync(join(directory, COMPOSITION_FILE), 'utf8')
    expect(composed).toContain('你是「周报助手」，帮助用户整理周报。')
    // standard 组合的其他顶层行原样保留（文本级 persona 替换）。
    expect(composed).toContain('- id: agent-instructions')
    expect(readFileSync(join(directory, PRESET_METADATA_FILE), 'utf8')).toContain(expert.name)
  })

  it('keeps a second same-name creation unique (slug uniqueness)', async () => {
    const first = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    const second = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    expect(first.id).not.toBe(second.id)
    // 两次派生共享同一 slug 与时间戳，只以尾缀序号区分。
    const base = `expert-mine-${slugifyMineName('周报助手')}-${NOW.getTime().toString(36)}`
    expect(first.id.startsWith(`${base}-`)).toBe(true)
    expect(second.id.startsWith(`${base}-`)).toBe(true)
    expect(await listMineExperts(root)).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: first.id }),
      expect.objectContaining({ id: second.id }),
    ]))
  })

  it('falls back to a persona-only composition when standard is unreadable', async () => {
    const expert = await saveMineExpert(root, input(), { now: NOW })
    const composed = readFileSync(join(root, expert.id, COMPOSITION_FILE), 'utf8')
    expect(composed).toContain('你是「周报助手」，帮助用户整理周报。')
    expect(composed).not.toContain('{{model}}')
  })

  it('updates in place with a bumped version', async () => {
    const created = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    const updated = await saveMineExpert(root, input({ persona: '新的人格。' }), { id: created.id, standardText: STANDARD, now: NOW })
    expect(updated.id).toBe(created.id)
    expect(updated.version).toBe(created.version + 1)
    const meta = await readExpertMetadata(root, created.id)
    expect(meta?.expert.persona).toBe('新的人格。')
    expect(meta?.source).toBe('mine')
  })

  it('deletes only inside the mine namespace', async () => {
    const expert = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    await expect(deleteMineExpertDirectory(root, expert.id)).resolves.toBeUndefined()
    expect(existsSync(join(root, expert.id))).toBe(false)
    await expect(deleteMineExpertDirectory(root, 'expert-official')).rejects.toThrow(MineExpertValidationError)
    await expect(deleteMineExpertDirectory(root, 'standard')).rejects.toThrow(MineExpertValidationError)
  })

  it('lists saved experts and tolerates corrupted metadata files', async () => {
    const listed = await listMineExperts(root)
    expect(listed.length).toBeGreaterThanOrEqual(2)
    expect(listed.every(row => row.id.startsWith('expert-mine-'))).toBe(true)

    // 坏 JSON：直接写入垃圾元数据 → 列表跳过，不抛错；诊断接口能点名。
    mkdirSync(join(root, 'expert-mine-broken'), { recursive: true })
    writeFileSync(join(root, 'expert-mine-broken', EXPERT_METADATA_FILE), '{not-json')
    const after = await listMineExperts(root)
    expect(after.some(row => row.id === 'expert-mine-broken')).toBe(false)
    expect(await listBrokenMineExperts(root)).toContain('expert-mine-broken')
  })

  it('derives an ascii slug with an expert fallback for CJK-only names', () => {
    expect(slugifyMineName('My Expert!')).toBe('my-expert')
    expect(slugifyMineName('周报助手')).toBe('expert')
  })

  it('derives unique ids without writing anything', async () => {
    const first = await deriveMineExpertId(root, 'another one', NOW)
    expect(first).toBe(`expert-mine-another-one-${NOW.getTime().toString(36)}`)
    // 占位目录占用同一 id 时，派生结果让位。
    mkdirSync(join(root, first), { recursive: true })
    const second = await deriveMineExpertId(root, 'another one', NOW)
    expect(second).not.toBe(first)
  })
})

describe('mergeCatalogWithMine', () => {
  it('appends mine rows after official rows and drops duplicate ids', () => {
    const official = [
      { id: 'expert-a' },
      { id: 'expert-b' },
    ] as unknown as readonly ExpertDef[]
    const mine = [
      { id: 'expert-mine-x' },
      { id: 'expert-b' },
    ] as unknown as readonly ExpertDef[]
    const merged = mergeCatalogWithMine(official, mine)
    expect(merged.map(row => row.id)).toEqual(['expert-a', 'expert-b', 'expert-mine-x'])
  })
})

describe('backupMineExpertsToCloud', () => {
  it('puts every local row with the session token, rotating once on 401', async () => {
    const created = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    const { ctx, stored } = fakeCredentials(SESSION_PAYLOAD)
    const log: RecordedRequest[] = []
    let putCount = 0
    const request = fakeTransport([
      {
        match: (url, method) => method === 'PUT' && url.endsWith(`/api/v1/custom-experts/${created.id}`),
        reply: () => {
          putCount += 1
          return putCount === 1 ? jsonResponse({ error: 'expired' }, 401) : jsonResponse({ ok: true })
        },
      },
      {
        match: (url, method) => method === 'POST' && url.endsWith('/api/v1/auth/refresh'),
        reply: () => jsonResponse({ accessToken: 'token-b', refreshToken: 'refresh-2' }),
      },
    ], log)

    const result: MineBackupResult = await backupMineExpertsToCloud([created], {
      ctx: ctx as never,
      baseUrl: 'https://bff.example.com',
      request,
    })

    expect(result.backedUp).toBe(1)
    expect(result.failed).toEqual([])
    expect(putCount).toBe(2)
    // 请求序列：PUT(401, token-a) → POST refresh（无鉴权头）→ PUT 重放(token-b)。
    expect(log[0]?.auth).toBe('Bearer token-a')
    expect(log[1]?.url.endsWith('/api/v1/auth/refresh')).toBe(true)
    expect(log[1]?.auth).toBeUndefined()
    expect(log[2]?.auth).toBe('Bearer token-b')
    expect(log[2]?.body).toContain(created.id)
    // 轮换后的授权已持久化回凭据封印。
    expect(stored()).toMatchObject({ kind: 'grant', payload: { accessToken: 'token-b', refreshToken: 'refresh-2' } })
  })

  it('fails whole batch with SessionRequiredError and never calls the BFF while signed out', async () => {
    const { ctx } = fakeCredentials(undefined)
    const log: RecordedRequest[] = []
    const expert = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    await expect(backupMineExpertsToCloud([expert], {
      ctx: ctx as never,
      baseUrl: 'https://bff.example.com',
      request: fakeTransport([], log),
    })).rejects.toThrow(SessionRequiredError)
    expect(log).toEqual([])
  })

  it('records per-row failures without aborting the rest', async () => {
    const good = await saveMineExpert(root, input(), { standardText: STANDARD, now: NOW })
    const bad = { ...good, id: `${good.id}-bad` }
    const log: RecordedRequest[] = []
    const request = fakeTransport([
      {
        match: (url, method) => method === 'PUT' && url.endsWith(bad.id),
        reply: () => jsonResponse({ error: 'boom' }, 500),
      },
      {
        match: (url, method) => method === 'PUT' && url.endsWith(good.id),
        reply: () => jsonResponse({ ok: true }),
      },
    ], log)

    const result = await backupMineExpertsToCloud([bad, good], {
      ctx: fakeCredentials(SESSION_PAYLOAD).ctx as never,
      baseUrl: 'https://bff.example.com',
      request,
    })
    expect(result.backedUp).toBe(1)
    const [failure] = result.failed
    expect(failure?.id).toBe(bad.id)
    expect(failure?.reason).toContain('500')
  })
})

describe('restoreMineExpertsFromCloud', () => {
  it('materializes cloud rows locally with mine source, dropping non-mine ids', async () => {
    const cloudRow = {
      id: 'expert-mine-from-cloud',
      name: '云端专家',
      icon: '⚡',
      description: '来自云端',
      persona: '你是「云端专家」。',
      tools: [],
      skills: [],
      guided_intro: '我是你创建的「云端专家」专家。来自云端',
      starter_prompts: [],
      cost_hint: null,
      model_hint: null,
      badge: '我的',
      enabled: true,
      version: 3,
    }
    const log: RecordedRequest[] = []
    const request = fakeTransport([
      {
        match: (url, method) => method === 'GET' && url.endsWith('/api/v1/custom-experts'),
        reply: () => jsonResponse({ experts: [cloudRow, { ...cloudRow, id: 'expert-official' }, { id: 'junk' }] }),
      },
    ], log)

    const result = await restoreMineExpertsFromCloud({
      ctx: fakeCredentials(SESSION_PAYLOAD).ctx as never,
      baseUrl: 'https://bff.example.com',
      request,
      root,
      standardText: STANDARD,
      now: () => NOW,
    })

    expect(result.restored).toBe(1)
    expect(result.failed).toEqual([])
    expect(log[0]?.auth).toBe('Bearer token-a')
    const meta = await readExpertMetadata(root, 'expert-mine-from-cloud')
    expect(meta?.source).toBe('mine')
    expect(meta?.expert.version).toBe(3)
    expect(existsSync(join(root, 'expert-official'))).toBe(false)
  })

  it('rejects unauthenticated restores and unsafe base URLs', async () => {
    const { ctx } = fakeCredentials(undefined)
    await expect(restoreMineExpertsFromCloud({
      ctx: ctx as never,
      baseUrl: 'https://bff.example.com',
      request: fakeTransport([], []),
      root,
    })).rejects.toThrow(SessionRequiredError)

    await expect(withChengziSession(
      { ctx: fakeCredentials(SESSION_PAYLOAD).ctx as never, baseUrl: 'ftp://bff.example.com' },
      async () => await listCustomExperts({
        baseUrl: 'ftp://bff.example.com',
        accessToken: 'token-a',
        request: fakeTransport([], []),
      }),
    )).rejects.toThrow(ChengziExpertsError)
  })
})

describe('sync territory (regression guard)', () => {
  it('leaves expert-mine-* directories untouched by syncExpertPresets', async () => {
    const mineDir = join(root, 'expert-mine-territory')
    mkdirSync(mineDir, { recursive: true })
    writeFileSync(join(mineDir, COMPOSITION_FILE), STANDARD)
    const { syncExpertPresets } = await import('../src/sync.js')
    const outcome = await syncExpertPresets({
      root,
      fetchCatalog: async () => ({ experts: [], source: 'cloud' }),
      standardText: () => STANDARD,
      now: () => NOW,
      warn: vi.fn(),
    })
    expect(outcome.removed).toEqual([])
    expect(existsSync(mineDir)).toBe(true)
    expect(readFileSync(join(mineDir, COMPOSITION_FILE), 'utf8')).toBe(STANDARD)
  })
})
