/** Session persistence for the Chengzi Pro account plugin.
 *
 *  The session lives in the credential seam's record half: one GrantRecord at
 *  `chengzi-account/session`, written only through the serialized
 *  read-modify-write of `modifyRecord`, so two processes rotating one refresh
 *  token can never lose the first write. The payload survives a JSON round
 *  trip, which is the seam's single constraint, and nothing here logs a token.
 */

import { credentialKey, type CredentialProvider, type CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** Credential-record address holding the session grant: scope is this plugin's registered name. */
export const SESSION_CREDENTIAL_KEY = credentialKey('chengzi-account', 'session')

/** Stored session payload; `savedAt` is an ISO timestamp stamped by {@link saveSession}.
 *  `phone` 可为空串：账号密码登录的官网用户没有手机号。 */
export interface ChengziSession {
  readonly accessToken: string
  readonly refreshToken: string
  readonly phone: string
  readonly savedAt: string
}

/** Host-context slice this module needs; tests may substitute a structural fake. */
export interface ChengziSessionContext {
  readonly credentials: Pick<CredentialProvider, 'readRecord' | 'modifyRecord' | 'deleteRecord'>
}

/**
 * Read the stored session.
 * @param ctx - Host context carrying the credential provider.
 * @returns the stored session, or undefined while none (or an unreadable record) is stored.
 */
export async function loadSession(ctx: ChengziSessionContext): Promise<ChengziSession | undefined> {
  const record = await ctx.credentials.readRecord(SESSION_CREDENTIAL_KEY)
  if (record === undefined || record.kind !== 'grant') return undefined
  return parseSessionPayload(record.payload)
}

/**
 * Store one session, replacing any previous grant under the same key.
 * @param ctx - Host context carrying the credential provider.
 * @param session - tokens and phone number; `savedAt` is stamped by this call.
 */
export async function saveSession(
  ctx: ChengziSessionContext,
  session: Omit<ChengziSession, 'savedAt'>,
): Promise<void> {
  const value: ChengziSession = { ...session, savedAt: new Date().toISOString() }
  await ctx.credentials.modifyRecord(SESSION_CREDENTIAL_KEY, () => Promise.resolve(grantRecord(value)))
}

/**
 * Remove the stored session; removing an absent session is a no-op.
 * @param ctx - Host context carrying the credential provider.
 */
export async function clearSession(ctx: ChengziSessionContext): Promise<void> {
  await ctx.credentials.deleteRecord(SESSION_CREDENTIAL_KEY)
}

/** Build one JSON-round-trip-safe grant record for the seam. */
function grantRecord(value: ChengziSession): CredentialRecord {
  return { kind: 'grant', payload: JSON.parse(JSON.stringify(value)) as unknown }
}

/** Validate one stored payload; anything unexpected reads as "no session". */
export function parseSessionPayload(value: unknown): ChengziSession | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const record = value as Record<string, unknown>
  if (
    typeof record.accessToken !== 'string' || record.accessToken.length === 0 || record.accessToken.length > 8192
    || typeof record.refreshToken !== 'string' || record.refreshToken.length === 0 || record.refreshToken.length > 8192
    || typeof record.phone !== 'string' || record.phone.length > 32
    || typeof record.savedAt !== 'string' || !Number.isFinite(Date.parse(record.savedAt))
  ) return undefined
  return {
    accessToken: record.accessToken,
    refreshToken: record.refreshToken,
    phone: record.phone,
    savedAt: record.savedAt,
  }
}
