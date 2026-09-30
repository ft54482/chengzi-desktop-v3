/** 共享登录表单：设置页「账号」区与全屏登录门禁共用。
 *  双通道：账号密码（平台官网用户，默认）+ 手机验证码（新用户注册）。 */
import { useEffect, useState, type ReactElement } from 'react'
import {
  Button,
  IconCheckOutlineRegular,
  IconSendOutlineRegular,
  Input,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChengziAccountLoginResponse } from '../api-types.ts'
import {
  loginAccount,
  loginAccountWithPassword,
  notifySessionChanged,
  requestAccountSmsCode,
} from './api.ts'

const PHONE_PATTERN = /^1[3-9]\d{9}$/u
const CODE_PATTERN = /^\d{6}$/u
const RESEND_SECONDS = 60
const USERNAME_MIN = 3
const PASSWORD_MIN = 8

export type AccountLoginFormProps = {
  readonly t: PropsLocale<'chengzi-account'>['t']
  /** 登录成功回调；表单自身不感知外部视图切换。 */
  readonly onAuthenticated: (result: ChengziAccountLoginResponse) => void
  /** 外部互斥（如退出登录进行中）时禁用提交。 */
  readonly lock?: boolean
}

type LoginTab = 'password' | 'sms'

function apiErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback
}

export function AccountLoginForm({ t, onAuthenticated, lock = false }: AccountLoginFormProps) {
  const [tab, setTab] = useState<LoginTab>('password')
  // 账号密码通道
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  // 验证码通道
  const [phone, setPhone] = useState('')
  const [code, setCode] = useState('')
  const [countdown, setCountdown] = useState(0)
  const [sendingCode, setSendingCode] = useState(false)
  const [signingIn, setSigningIn] = useState(false)
  const [error, setError] = useState<string>()
  const [notice, setNotice] = useState<string>()

  const phoneValid = PHONE_PATTERN.test(phone)
  const codeValid = CODE_PATTERN.test(code)
  const accountValid = username.trim().length >= USERNAME_MIN
  const passwordValid = password.length >= PASSWORD_MIN
  const counting = countdown > 0
  const busy = sendingCode || signingIn || lock

  useEffect(() => {
    if (!counting) return
    const timer = setInterval(() => {
      setCountdown(value => Math.max(0, value - 1))
    }, 1000)
    return () => { clearInterval(timer) }
  }, [counting])

  const sendCode = async (): Promise<void> => {
    if (sendingCode || !phoneValid) return
    setSendingCode(true)
    setError(undefined)
    setNotice(undefined)
    try {
      await requestAccountSmsCode(phone)
      setCountdown(RESEND_SECONDS)
      setNotice(t('codeSent'))
    } catch (cause) {
      setError(apiErrorMessage(cause, t('requestFailed')))
    } finally {
      setSendingCode(false)
    }
  }

  const finishSignIn = (result: ChengziAccountLoginResponse): void => {
    setPassword('')
    setCode('')
    notifySessionChanged()
    onAuthenticated(result)
  }

  const signInWithPassword = async (): Promise<void> => {
    if (busy || !accountValid || !passwordValid) return
    setSigningIn(true)
    setError(undefined)
    setNotice(undefined)
    try {
      finishSignIn(await loginAccountWithPassword(username.trim(), password))
    } catch (cause) {
      setError(apiErrorMessage(cause, t('requestFailed')))
    } finally {
      setSigningIn(false)
    }
  }

  const signInWithSms = async (): Promise<void> => {
    if (busy || !phoneValid || !codeValid) return
    setSigningIn(true)
    setError(undefined)
    setNotice(undefined)
    try {
      finishSignIn(await loginAccount(phone, code))
    } catch (cause) {
      setError(apiErrorMessage(cause, t('requestFailed')))
    } finally {
      setSigningIn(false)
    }
  }

  const tabButton = (id: LoginTab, label: string): ReactElement => (
    <button
      key={id}
      type="button"
      role="tab"
      aria-selected={tab === id}
      className={tab === id ? 'chengziAccountTab chengziAccountTabActive' : 'chengziAccountTab'}
      onClick={() => { setTab(id); setError(undefined); setNotice(undefined) }}
    >
      {label}
    </button>
  )

  return (
    <form
      className="chengziAccountForm"
      onSubmit={(event) => {
        event.preventDefault()
        void (tab === 'password' ? signInWithPassword() : signInWithSms())
      }}
    >
      <div className="chengziAccountTabs" role="tablist">
        {tabButton('password', t('tabPassword'))}
        {tabButton('sms', t('tabSms'))}
      </div>
      {error !== undefined && (
        <div className="chengziAccountError" role="alert">
          <StateDot state="error" size={14} />
          <span>{error}</span>
        </div>
      )}
      {tab === 'password' ? (
        <>
          <div className="chengziAccountField">
            <label htmlFor="chengzi-account-username">{t('accountLabel')}</label>
            <Input
              id="chengzi-account-username"
              value={username}
              disabled={busy}
              autoComplete="username"
              placeholder={t('accountPlaceholder')}
              onChange={(event) => { setUsername(event.currentTarget.value.slice(0, 64)) }}
            />
          </div>
          <div className="chengziAccountField">
            <label htmlFor="chengzi-account-password">{t('passwordLabel')}</label>
            <Input
              id="chengzi-account-password"
              type="password"
              value={password}
              disabled={busy}
              autoComplete="current-password"
              placeholder={t('passwordPlaceholder')}
              onChange={(event) => { setPassword(event.currentTarget.value.slice(0, 128)) }}
            />
          </div>
        </>
      ) : (
        <>
          <div className="chengziAccountField">
            <label htmlFor="chengzi-account-phone">{t('phoneLabel')}</label>
            <Input
              id="chengzi-account-phone"
              value={phone}
              disabled={busy}
              inputMode="numeric"
              autoComplete="tel"
              placeholder={t('phonePlaceholder')}
              onChange={(event) => { setPhone(event.currentTarget.value.replace(/\D/gu, '').slice(0, 11)) }}
            />
          </div>
          <div className="chengziAccountField">
            <label htmlFor="chengzi-account-code">{t('codeLabel')}</label>
            <div className="chengziAccountFieldRow">
              <Input
                id="chengzi-account-code"
                value={code}
                disabled={busy}
                inputMode="numeric"
                autoComplete="one-time-code"
                placeholder={t('codePlaceholder')}
                onChange={(event) => { setCode(event.currentTarget.value.replace(/\D/gu, '').slice(0, 6)) }}
              />
              <Button
                type="button"
                variant="outline"
                icon={sendingCode ? undefined : <IconSendOutlineRegular />}
                aria-label={t('sendCode')}
                disabled={sendingCode || !phoneValid || counting}
                onClick={() => { void sendCode() }}
              >
                {sendingCode
                  ? t('sendingCode')
                  : counting
                    ? `${String(countdown)}${t('resendSuffix')}`
                    : t('sendCode')}
              </Button>
            </div>
          </div>
          <p className="chengziAboutStatement">{t('smsAutoRegisterHint')}</p>
        </>
      )}
      {notice !== undefined && (
        <div className="chengziAccountNotice" role="status">
          <IconCheckOutlineRegular size={14} />
          <span>{notice}</span>
        </div>
      )}
      <div className="chengziAccountActions">
        <Button
          type="submit"
          variant="primary"
          disabled={busy
            || (tab === 'password' ? !accountValid || !passwordValid : !phoneValid || !codeValid)}
        >
          {signingIn ? t('signingIn') : t('signIn')}
        </Button>
      </div>
    </form>
  )
}
