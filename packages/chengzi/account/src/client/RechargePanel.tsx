/** 充值面板：套餐选择 → 扫码/演示码支付 → 轮询到账。
 *  面板经 Portal 直接挂到 body（z-index 1050，低于登录门禁），关闭即停止轮询。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import {
  Button,
  IconCheckOutlineRegular,
  IconCloseOutlineRegular,
  StateDot,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChengziOrderCreationResponse, ChengziPackageView } from '../api-types.ts'
import { createRechargeOrder, fetchAccountPackages, pollOrderStatus } from './api.ts'

const POLL_INTERVAL_MS = 3_000
const PAID_CALLBACK_DELAY_MS = 2_000
const STUB_QR_PREFIX = 'chengzipro-stub://'

type RechargePhase = 'loading' | 'choose' | 'paying' | 'success' | 'error'

export interface RechargePanelProps {
  readonly t: PropsLocale<'chengzi-account'>['t']
  readonly onClose: () => void
  readonly onPaid: () => void
}

function apiErrorMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback
}

function formatCount(value: number): string {
  return new Intl.NumberFormat().format(Math.max(0, Math.trunc(value)))
}

function formatPrice(priceCents: number): string {
  return `¥${(priceCents / 100).toFixed(2)}`
}

export function RechargePanel({ t, onClose, onPaid }: RechargePanelProps) {
  const [phase, setPhase] = useState<RechargePhase>('loading')
  const [packages, setPackages] = useState<readonly ChengziPackageView[]>()
  const [order, setOrder] = useState<ChengziOrderCreationResponse>()
  const [error, setError] = useState<string>()
  const loadRequest = useRef<AbortController>()
  const orderRequest = useRef<AbortController>()
  const paidTimer = useRef<ReturnType<typeof setTimeout>>()
  // Keep the paid callback reachable from timers without re-arming the poll effect.
  const onPaidRef = useRef(onPaid)
  onPaidRef.current = onPaid

  const loadPackages = useCallback(async (): Promise<void> => {
    if (loadRequest.current !== undefined) return
    const request = new AbortController()
    loadRequest.current = request
    setPhase('loading')
    setError(undefined)
    try {
      const response = await fetchAccountPackages(request.signal)
      if (request.signal.aborted || loadRequest.current !== request) return
      setPackages(response.packages)
      setOrder(undefined)
      setPhase('choose')
    } catch (cause) {
      if (request.signal.aborted || loadRequest.current !== request) return
      setError(apiErrorMessage(cause, t('rechargeFailed')))
      setPhase('error')
    } finally {
      if (loadRequest.current === request) loadRequest.current = undefined
    }
  }, [t])

  const choosePackage = useCallback(async (packageId: string): Promise<void> => {
    if (orderRequest.current !== undefined) return
    const request = new AbortController()
    orderRequest.current = request
    setError(undefined)
    try {
      const created = await createRechargeOrder(packageId, request.signal)
      if (request.signal.aborted || orderRequest.current !== request) return
      setOrder(created)
      setPhase('paying')
    } catch (cause) {
      if (request.signal.aborted || orderRequest.current !== request) return
      setError(apiErrorMessage(cause, t('rechargeFailed')))
      setPhase('error')
    } finally {
      if (orderRequest.current === request) orderRequest.current = undefined
    }
  }, [t])

  useEffect(() => {
    void loadPackages()
  }, [loadPackages])

  // Poll the order every 3 seconds while paying; closing the panel tears the
  // interval down and the first poll runs immediately.
  useEffect(() => {
    if (phase !== 'paying' || order === undefined) return
    // Read through a function so the type-level flow cannot fold the flag to
    // its initializer's literal — `stop()` flips it from another closure.
    let stoppedState = false
    const stopped = (): boolean => stoppedState
    let inFlight = false
    const stop = (): void => {
      stoppedState = true
      clearInterval(timer)
    }
    const poll = async (): Promise<void> => {
      if (stopped() || inFlight) return
      inFlight = true
      try {
        const status = await pollOrderStatus(order.orderNo)
        if (stopped()) return
        if (status.status === 'paid') {
          stop()
          setPhase('success')
          paidTimer.current = setTimeout(() => { onPaidRef.current() }, PAID_CALLBACK_DELAY_MS)
        }
      } catch (cause) {
        if (stopped()) return
        stop()
        setError(apiErrorMessage(cause, t('rechargeFailed')))
        setPhase('error')
      } finally {
        inFlight = false
      }
    }
    const timer = setInterval(() => { void poll() }, POLL_INTERVAL_MS)
    void poll()
    return stop
  }, [phase, order, t])

  // Panel teardown: cancel outstanding requests and the paid callback timer.
  useEffect(() => () => {
    loadRequest.current?.abort()
    orderRequest.current?.abort()
    if (paidTimer.current !== undefined) clearTimeout(paidTimer.current)
  }, [])

  const stub = order !== undefined && order.qrCode.startsWith(STUB_QR_PREFIX)

  return createPortal(
    <div className="chengziAccountRechargeGate" role="dialog" aria-modal="true" aria-label={t('rechargeTitle')}>
      <section className="chengziAccountRechargeCard" aria-busy={phase === 'loading'}>
        <header className="chengziAccountRechargeHeader">
          <div>
            <h2>{t('rechargeTitle')}</h2>
            <p>{t('rechargeSubtitle')}</p>
          </div>
          <Button type="button" variant="ghost" aria-label={t('closeLabel')} onClick={onClose}>
            <IconCloseOutlineRegular />
          </Button>
        </header>
        {phase === 'loading' && (
          <div className="chengziAccountRechargeStatus" role="status">
            <StateDot state="ongoing" size={16} />
            <span>{t('pricePending')}</span>
          </div>
        )}
        {phase === 'choose' && packages !== undefined && (
          <div className="chengziAccountPackageGrid">
            {packages.map(value => (
              <button
                key={value.id}
                type="button"
                className="chengziAccountPackageCard"
                onClick={() => { void choosePackage(value.id) }}
              >
                <span className="chengziAccountPackageName">{value.name}</span>
                <span className="chengziAccountPackageTokens">
                  {formatCount(value.tokens)} {t('tokensUnit')}
                </span>
                {value.bonusTokens > 0 && (
                  <span className="chengziAccountPackageBonus">
                    {t('bonusLabel')} {formatCount(value.bonusTokens)}
                  </span>
                )}
                <span className="chengziAccountPackagePrice">{formatPrice(value.priceCents)}</span>
              </button>
            ))}
          </div>
        )}
        {phase === 'paying' && order !== undefined && (
          <div className="chengziAccountPay">
            <p className="chengziAccountPayAmount">{formatPrice(order.amountCents)}</p>
            <div className="chengziAccountQr">
              {stub && <span className="chengziAccountStubBadge">{t('stubBadge')}</span>}
              <code>{order.qrCode}</code>
            </div>
            {!stub && <p className="chengziAccountPayHint">{t('payTitle')}</p>}
            <div className="chengziAccountRechargeStatus" role="status">
              <StateDot state="ongoing" size={14} />
              <span>{t('orderPending')}</span>
            </div>
          </div>
        )}
        {phase === 'success' && (
          <div className="chengziAccountRechargeStatus chengziAccountRechargeSuccess" role="status">
            <IconCheckOutlineRegular size={16} />
            <span>{t('rechargeSuccess')}</span>
          </div>
        )}
        {phase === 'error' && (
          <>
            {error !== undefined && (
              <div className="chengziAccountError" role="alert">
                <StateDot state="error" size={14} />
                <span>{error}</span>
              </div>
            )}
            <div className="chengziAccountActions">
              <Button type="button" variant="outline" onClick={() => { void loadPackages() }}>
                {t('retry')}
              </Button>
            </div>
          </>
        )}
      </section>
    </div>,
    document.body,
  )
}
