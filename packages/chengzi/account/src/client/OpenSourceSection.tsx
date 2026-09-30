/** 设置页「关于」节：开源来源声明 + MIT 文本 + 第三方清单入口。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Button, IconWarningOutlineRegular, StateDot } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { readOpenSource, type ChengziOpenSourceView } from './api.ts'

export type OpenSourceSectionProps = PropsRuntime<'settings.section'>
  & PropsLocale<'chengzi-account'>

export function OpenSourceSection({ t }: OpenSourceSectionProps) {
  const [data, setData] = useState<ChengziOpenSourceView>()
  const [expanded, setExpanded] = useState(false)
  const [notices, setNotices] = useState<string>()
  const [error, setError] = useState<string>()
  const loadRequest = useRef<AbortController>()

  const load = useCallback(async (): Promise<void> => {
    if (loadRequest.current !== undefined) return
    const request = new AbortController()
    loadRequest.current = request
    setError(undefined)
    try {
      const view = await readOpenSource(request.signal)
      if (request.signal.aborted || loadRequest.current !== request) return
      setData(view)
    } catch (cause) {
      if (request.signal.aborted || loadRequest.current !== request) return
      setError(cause instanceof Error && cause.message.trim().length > 0 ? cause.message : t('requestFailed'))
    } finally {
      if (loadRequest.current === request) loadRequest.current = undefined
    }
  }, [t])

  useEffect(() => {
    void load()
    return () => {
      loadRequest.current?.abort()
      loadRequest.current = undefined
    }
  }, [load])

  const toggleNotices = (): void => {
    const next = !expanded
    setExpanded(next)
    if (next && notices === undefined && data?.thirdPartyNotices != null) {
      setNotices(data.thirdPartyNotices)
    }
  }

  return (
    <section className="chengziAccountRoot" aria-label={t('aboutTitle')}>
      <header className="chengziAccountHeader">
        <div>
          <h2>{t('aboutTitle')}</h2>
          <p>{t('aboutSubtitle')}</p>
        </div>
      </header>
      {error !== undefined && (
        <div className="chengziAccountError" role="alert">
          <StateDot state="error" size={14} />
          <span>{error}</span>
        </div>
      )}
      {data === undefined && error === undefined && (
        <div className="chengziAccountBanner" role="status">
          <StateDot state="ongoing" size={16} />
          <span>{t('aboutLoading')}</span>
        </div>
      )}
      {data !== undefined && (
        <>
          <div className="chengziAccountFactRow">
            <span>{t('aboutVersionLabel')}</span>
            <span>{`v${data.version}`}</span>
          </div>
          <p className="chengziAboutStatement">{t('aboutSourceStatement')}</p>
          <p className="chengziAboutStatement">{t('aboutTrademarkStatement')}</p>
          <div className="chengziAboutBlock">
            <span className="chengziAboutBlockLabel">{t('aboutLicenseLabel')}</span>
            <pre className="chengziAboutPre">{data.licenseText}</pre>
          </div>
          <div className="chengziAboutBlock">
            <span className="chengziAboutBlockLabel">{t('aboutThirdPartyLabel')}</span>
            <p className="chengziAboutStatement">{t('aboutThirdPartySummary')}</p>
            {data.thirdPartyNotices == null && (
              <div className="chengziAccountBanner" role="status">
                <IconWarningOutlineRegular size={14} />
                <span>{t('aboutNoticesUnavailable')}</span>
              </div>
            )}
            {data.thirdPartyNotices != null && (
              <>
                <Button
                  type="button"
                  variant="outline"
                  disabled={false}
                  onClick={() => { toggleNotices() }}
                >
                  {expanded ? t('aboutHideNotices') : t('aboutViewNotices')}
                </Button>
                {expanded && notices !== undefined && (
                  <pre className="chengziAboutPre chengziAboutPreTall">{notices}</pre>
                )}
              </>
            )}
          </div>
        </>
      )}
    </section>
  )
}
