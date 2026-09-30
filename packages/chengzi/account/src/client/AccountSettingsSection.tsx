import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconRefreshOutlineRegular,
  IconUserOutlineRegular,
  IconWarningOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChengziProvisionStateView } from '../api-types.ts'
import {
  ChengziAccountApiError,
  logoutAccount,
  notifySessionChanged,
  readAccount,
  readAccountApiKey,
} from './api.ts'
import { AccountLoginForm } from './AccountLoginForm.tsx'
import { RechargePanel } from './RechargePanel.tsx'

type AccountPhase = 'loading' | 'anonymous' | 'authenticated'

type AccountAction = 'signing-out' | 'refreshing'

interface AccountFacts {
  readonly phone: string | null
  readonly cny: number | undefined
  readonly provisionState: ChengziProvisionStateView | undefined
}

function withProvisionState(
  facts: AccountFacts,
  provisionState: ChengziProvisionStateView,
): AccountFacts {
  return { phone: facts.phone, cny: facts.cny, provisionState }
}

export type AccountSettingsSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'chengzi-account'>

function apiErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback
}

function provisionLabelKey(
  state: ChengziProvisionStateView,
): 'provisionNone' | 'provisionPending' | 'provisionReady' | 'provisionFailed' {
  if (state === 'pending') return 'provisionPending'
  if (state === 'ready') return 'provisionReady'
  if (state === 'failed') return 'provisionFailed'
  return 'provisionNone'
}

export function AccountSettingsSection({ t }: AccountSettingsSectionProps) {
  const [phase, setPhase] = useState<AccountPhase>('loading')
  const [facts, setFacts] = useState<AccountFacts>()
  const [action, setAction] = useState<AccountAction>()
  const [error, setError] = useState<string>()
  const [giftNotice, setGiftNotice] = useState<string>()
  const [rechargeOpen, setRechargeOpen] = useState(false)
  const loadRequest = useRef<AbortController>()
  const registeredRef = useRef(false)
  const pollBusyRef = useRef(false)
  const unmountedRef = useRef(false)
  // Runtime-mutable facts read through functions: the type-level control flow
  // sees a boolean, not the initializer's literal.
  const unmounted = (): boolean => unmountedRef.current
  const aborted = (request: AbortController): boolean => request.signal.aborted
  useEffect(() => () => { unmountedRef.current = true }, [])

  const loadAccount = useCallback(async (refreshing: boolean): Promise<void> => {
    if (loadRequest.current !== undefined) return
    const request = new AbortController()
    loadRequest.current = request
    if (refreshing) setAction('refreshing')
    setError(undefined)
    try {
      const account = await readAccount(request.signal)
      if (request.signal.aborted || loadRequest.current !== request) return
      if (!account.authenticated || account.user === undefined) {
        setPhase('anonymous')
        setFacts(undefined)
        return
      }
      const next: AccountFacts = {
        phone: account.user.phone,
        cny: account.balance?.cny,
        provisionState: undefined,
      }
      // Best effort: the api-key read also reports the provisioning state.
      let updated = next
      try {
        await readAccountApiKey(request.signal)
        if (!aborted(request)) updated = withProvisionState(next, 'ready')
      } catch (cause) {
        if (aborted(request) || loadRequest.current !== request) return
        if (cause instanceof ChengziAccountApiError) {
          if (cause.status === 401) {
            setPhase('anonymous')
            setFacts(undefined)
            return
          }
          if (cause.provisionState === 'none'
            || cause.provisionState === 'pending'
            || cause.provisionState === 'failed') {
            updated = withProvisionState(next, cause.provisionState)
          }
        }
      }
      if (aborted(request) || loadRequest.current !== request) return
      setFacts(updated)
      setPhase('authenticated')
    } catch (cause) {
      if (aborted(request) || loadRequest.current !== request) return
      setPhase('anonymous')
      setError(apiErrorMessage(cause, t('loadError')))
    } finally {
      if (loadRequest.current === request) {
        loadRequest.current = undefined
        if (refreshing) setAction(undefined)
      }
    }
  }, [t])

  useEffect(() => {
    void loadAccount(false)
    return () => {
      loadRequest.current?.abort()
      loadRequest.current = undefined
    }
  }, [loadAccount])

  // 注册链路（验证码首登）的开通轮询：409=pending 时每 5 秒重试，上限 60 秒；
  // ready 即刷新余额并提示新人体验金。仅注册会话触发（registeredRef）。
  const pollProvision = useCallback(async (): Promise<void> => {
    if (pollBusyRef.current) return
    pollBusyRef.current = true
    try {
      for (let attempt = 0; attempt < 12; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 5000))
        if (unmountedRef.current) return
        try {
          await readAccountApiKey()
          if (registeredRef.current) {
            registeredRef.current = false
            setGiftNotice(t('provisionGiftReady'))
          }
          await loadAccount(true)
          return
        } catch (cause) {
          if (unmounted()) return
          if (cause instanceof ChengziAccountApiError) {
            if (cause.status === 401) {
              setPhase('anonymous')
              setFacts(undefined)
              return
            }
            if (cause.provisionState === 'failed') {
              await loadAccount(true)
              return
            }
            // pending → 继续下一轮
          } else {
            return
          }
        }
      }
    } finally {
      pollBusyRef.current = false
    }
  }, [loadAccount, t])

  // 挂载时发现仍 pending（如重启用），同样进入自动轮询
  useEffect(() => {
    if (phase === 'authenticated' && facts?.provisionState === 'pending') void pollProvision()
  }, [phase, facts?.provisionState, pollProvision])

  const signOut = async (): Promise<void> => {
    if (action !== undefined) return
    setAction('signing-out')
    try {
      await logoutAccount()
    } catch {
      // The Host clears the local session even when the server call fails.
    } finally {
      setPhase('anonymous')
      setFacts(undefined)
      setAction(undefined)
      notifySessionChanged()
    }
  }

  const busy = action !== undefined

  return (
    <section className="chengziAccountRoot" aria-label={t('title')} aria-busy={busy}>
      <header className="chengziAccountHeader">
        <IconUserOutlineRegular size={20} />
        <div>
          <h2>{t('title')}</h2>
          <p>{t('subtitle')}</p>
        </div>
      </header>
      {error !== undefined && (
        <div className="chengziAccountError" role="alert">
          <StateDot state="error" size={14} />
          <span>{error}</span>
        </div>
      )}
      {giftNotice !== undefined && (
        <div className="chengziAccountBanner" role="status">
          <IconCheckOutlineRegular size={14} />
          <span>{giftNotice}</span>
        </div>
      )}
      {phase === 'loading' && (
        <div className="chengziAccountBanner" role="status">
          <StateDot state="ongoing" size={16} />
          <span>{t('loading')}</span>
        </div>
      )}
      {phase === 'anonymous' && (
        <AccountLoginForm
          t={t}
          lock={busy}
          onAuthenticated={(result) => {
            setFacts({
              phone: result.user.phone,
              cny: result.balance.cny,
              provisionState: result.provisionState,
            })
            setPhase('authenticated')
            if (result.provisionState === 'pending') {
              registeredRef.current = true
              void pollProvision()
            }
          }}
        />
      )}
      {phase === 'authenticated' && facts !== undefined && (
        <div className="chengziAccountFacts">
          <div className="chengziAccountFactRow">
            <span>{t('phoneLabel')}</span>
            <span>{facts.phone ?? '—'}</span>
          </div>
          <div className="chengziAccountFactRow">
            <span>{t('balanceLabel')}</span>
            <span>{facts.cny === undefined ? '—' : `¥${facts.cny.toFixed(2)}`}</span>
          </div>
          <div className="chengziAccountFactRow">
            <span>{t('provisionLabel')}</span>
            <span>{facts.provisionState === undefined ? '—' : t(provisionLabelKey(facts.provisionState))}</span>
          </div>
          {facts.provisionState === 'pending' && (
            <div className="chengziAccountBanner" role="status">
              <IconWarningOutlineRegular size={14} />
              <span>{t('provisionPending')}</span>
            </div>
          )}
          <div className="chengziAccountActions">
            <Button
              type="button"
              variant="primary"
              disabled={busy}
              onClick={() => { setRechargeOpen(true) }}
            >
              {t('recharge')}
            </Button>
            <Button
              type="button"
              variant="outline"
              icon={action === 'refreshing' ? undefined : <IconRefreshOutlineRegular />}
              disabled={busy}
              onClick={() => { void loadAccount(true) }}
            >
              {action === 'refreshing' ? t('refreshing') : t('refresh')}
            </Button>
            <Button
              type="button"
              variant="ghost"
              disabled={busy}
              onClick={() => { void signOut() }}
            >
              {action === 'signing-out' ? t('signingOut') : t('signOut')}
            </Button>
          </div>
        </div>
      )}
      {rechargeOpen && phase === 'authenticated' && (
        <RechargePanel
          t={t}
          onClose={() => { setRechargeOpen(false) }}
          onPaid={() => {
            setRechargeOpen(false)
            void loadAccount(true)
          }}
        />
      )}
    </section>
  )
}
