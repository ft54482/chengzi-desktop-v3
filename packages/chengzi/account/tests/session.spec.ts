import { describe, expect, it } from 'vitest'
import type { CredentialRecord } from '@deepseek-ai/dsh-credentials'
import {
  clearSession,
  loadSession,
  parseSessionPayload,
  saveSession,
  SESSION_CREDENTIAL_KEY,
  type ChengziSessionContext,
} from '../src/session.ts'

interface FakeStore {
  readonly ctx: ChengziSessionContext
  readonly records: Map<string, CredentialRecord>
}

function createFakeStore(): FakeStore {
  const records = new Map<string, CredentialRecord>()
  const ctx: ChengziSessionContext = {
    credentials: {
      readRecord: async key => records.get(key),
      modifyRecord: async (key, mutate) => {
        const current = records.get(key)
        const next = await mutate(current)
        if (next === undefined) return current
        records.set(key, next)
        return next
      },
      deleteRecord: async (key) => {
        records.delete(key)
      },
    },
  }
  return { ctx, records }
}

describe('chengzi-account session persistence', () => {
  it('stores the session grant under the plugin-scoped credential key', async () => {
    const { ctx, records } = createFakeStore()
    await saveSession(ctx, {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      phone: '13800138000',
    })

    expect(String(SESSION_CREDENTIAL_KEY)).toBe('chengzi-account/session')
    const record = records.get(String(SESSION_CREDENTIAL_KEY))
    expect(record?.kind).toBe('grant')
    const payload = record !== undefined && record.kind === 'grant' ? record.payload : undefined
    expect(payload).toBeDefined()
    expect(JSON.parse(JSON.stringify(payload))).toEqual({
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      phone: '13800138000',
      savedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/u) as string,
    })
  })

  it('round-trips a saved session', async () => {
    const { ctx } = createFakeStore()
    await saveSession(ctx, {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      phone: '13800138000',
    })

    const session = await loadSession(ctx)
    expect(session).toBeDefined()
    expect(session?.accessToken).toBe('fake-access-token')
    expect(session?.refreshToken).toBe('fake-refresh-token')
    expect(session?.phone).toBe('13800138000')
    expect(Number.isFinite(Date.parse(session?.savedAt ?? ''))).toBe(true)
  })

  it('replaces a previous session on save', async () => {
    const { ctx } = createFakeStore()
    await saveSession(ctx, {
      accessToken: 'fake-access-token-1',
      refreshToken: 'fake-refresh-token-1',
      phone: '13800138000',
    })
    await saveSession(ctx, {
      accessToken: 'fake-access-token-2',
      refreshToken: 'fake-refresh-token-2',
      phone: '13900139000',
    })

    const session = await loadSession(ctx)
    expect(session?.accessToken).toBe('fake-access-token-2')
    expect(session?.phone).toBe('13900139000')
  })

  it('clears the session and tolerates a repeated clear', async () => {
    const { ctx } = createFakeStore()
    await saveSession(ctx, {
      accessToken: 'fake-access-token',
      refreshToken: 'fake-refresh-token',
      phone: '13800138000',
    })
    await clearSession(ctx)
    expect(await loadSession(ctx)).toBeUndefined()
    await expect(clearSession(ctx)).resolves.toBeUndefined()
  })

  it('reads no session from a non-grant record', async () => {
    const { ctx, records } = createFakeStore()
    records.set(String(SESSION_CREDENTIAL_KEY), { kind: 'api-key', key: 'unrelated-key' })
    expect(await loadSession(ctx)).toBeUndefined()
  })

  it('reads no session from a corrupt grant payload', async () => {
    const { ctx, records } = createFakeStore()
    records.set(String(SESSION_CREDENTIAL_KEY), {
      kind: 'grant',
      payload: { accessToken: 42, refreshToken: null, phone: '', savedAt: 'not-a-date' },
    })
    expect(await loadSession(ctx)).toBeUndefined()
    expect(parseSessionPayload('json-string-payload')).toBeUndefined()
  })

  it('reads no session while nothing is stored', async () => {
    const { ctx } = createFakeStore()
    expect(await loadSession(ctx)).toBeUndefined()
  })
})
