/** 登录强制门禁：无会话时全屏遮罩阻止使用，登录成功后自动揭除；监听会话变更即时响应。
 *  遮罩经 Portal 直接挂到 body（z-index 高于应用内弹层），确保置顶。 */
import { useCallback, useEffect, useState } from 'react'
import { createPortal } from 'react-dom'
import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readAccount, SESSION_CHANGED_EVENT } from './api.ts'
import { AccountLoginForm } from './AccountLoginForm.tsx'

export type AccountLoginOverlayProps = PropsRuntime<'shell.overlay'>
  & PropsLocale<'chengzi-account'>

type GateState = 'checking' | 'required' | 'passed'

export function AccountLoginOverlay({ t }: AccountLoginOverlayProps) {
  const [gate, setGate] = useState<GateState>('checking')

  const checkSession = useCallback((signal: AbortSignal): void => {
    void readAccount(signal)
      .then((account) => {
        if (!signal.aborted) setGate(account.authenticated ? 'passed' : 'required')
      })
      .catch(() => {
        if (!signal.aborted) setGate('required')
      })
  }, [])

  useEffect(() => {
    const controller = new AbortController()
    checkSession(controller.signal)
    const onSessionChanged = (): void => {
      controller.abort()
      const recheck = new AbortController()
      checkSession(recheck.signal)
    }
    window.addEventListener(SESSION_CHANGED_EVENT, onSessionChanged)
    return () => {
      controller.abort()
      window.removeEventListener(SESSION_CHANGED_EVENT, onSessionChanged)
    }
  }, [checkSession])

  if (gate !== 'required') return null
  return createPortal(
    <div className="chengziAccountGate" role="dialog" aria-modal="true" aria-label={t('gateTitle')}>
      <section className="chengziAccountGateCard">
        <header className="chengziAccountHeader">
          <IconUserOutlineRegular size={20} />
          <div>
            <h1>{t('gateTitle')}</h1>
            <p>{t('gateSubtitle')}</p>
          </div>
        </header>
        <AccountLoginForm t={t} onAuthenticated={() => { setGate('passed') }} />
      </section>
    </div>,
    document.body,
  )
}
