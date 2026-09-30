import { useEffect, useState, type ReactNode } from 'react'
import { Button, IconCloseOutlineRegular, Modal, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { ExpertDef } from '../expert-types.js'
import type { MineExpertInput } from '../mine-types.js'
import { partitionExperts } from '../mine-types.js'
import { ExpertCard } from './ExpertCard.js'
import type { ExpertsPageFace } from './launcher.js'
import { MineExpertFormModal } from './MineExpertFormModal.js'

/** 表单 Modal 的打开状态：创建，或编辑某位「我的专家」。 */
interface FormTarget {
  readonly expert?: ExpertDef
}

/** 全屏专家页面（main keyed 面板）：官方专家与「我的专家」两个分区的卡片
 *  网格，选择即以该专家开局新会话；「我的」分区支持创建/编辑/删除与云端
 *  备份/恢复。面板选中时挂载、切换即卸载——旧 overlay 的开关/Escape 逻辑
 *  由 panel 生命周期替代。 */
export type ExpertsPageProps = PropsRuntime<'main'>
  & InjectFace<ExpertsPageFace>

export function ExpertsPage({ launcher, closePanel }: ExpertsPageProps): ReactNode {
  const [experts, setExperts] = useState<readonly ExpertDef[] | undefined>(undefined)
  const [starting, setStarting] = useState<string | undefined>(undefined)
  const [form, setForm] = useState<FormTarget | undefined>(undefined)
  const [formBusy, setFormBusy] = useState(false)
  const [formError, setFormError] = useState<string | undefined>(undefined)
  const [pendingDelete, setPendingDelete] = useState<ExpertDef | undefined>(undefined)
  const [deleteBusy, setDeleteBusy] = useState(false)
  const [cloudBusy, setCloudBusy] = useState<'backup' | 'restore' | undefined>(undefined)
  const [notice, setNotice] = useState<string | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    void launcher.readCatalog(controller.signal)
      .then((rows) => { if (!controller.signal.aborted) setExperts(rows) })
      .catch(() => { if (!controller.signal.aborted) setExperts([]) })
    return () => { controller.abort() }
  }, [launcher])

  const reload = (): Promise<void> =>
    launcher.readCatalog()
      .then((rows) => { setExperts(rows) })
      .catch((cause: unknown) => {
        // 刷新失败保留旧清单并留日志；空清单仅在首次加载失败时出现。
        console.warn('dsh-plugin-chengzi-experts: catalog reload failed', cause)
      })

  const startWith = (expert: ExpertDef, initialDraft?: string): void => {
    setStarting(expert.id)
    // 先关面板再开局（与旧 overlay 同款交互）：会话创建异步进行，失败静默。
    closePanel()
    void launcher.startExpert(expert, initialDraft).catch((): undefined => undefined)
  }

  const submitForm = (input: MineExpertInput): void => {
    setFormBusy(true)
    setFormError(undefined)
    const saving = form?.expert === undefined
      ? launcher.createMine(input)
      : launcher.updateMine(form.expert.id, input)
    void saving
      .then(async () => {
        setForm(undefined)
        await reload()
      })
      .catch((cause: unknown) => {
        setFormError(cause instanceof Error ? cause.message : '保存失败，请稍后重试')
      })
      .finally(() => { setFormBusy(false) })
  }

  const confirmDelete = (): void => {
    const expert = pendingDelete
    if (expert === undefined) return
    setDeleteBusy(true)
    void launcher.deleteMine(expert.id)
      .then(async () => {
        setPendingDelete(undefined)
        await reload()
      })
      .catch((cause: unknown) => {
        setPendingDelete(undefined)
        setNotice(cause instanceof Error ? cause.message : '删除失败，请稍后重试')
      })
      .finally(() => { setDeleteBusy(false) })
  }

  const runCloud = (kind: 'backup' | 'restore'): void => {
    setCloudBusy(kind)
    setNotice(undefined)
    const failures = (failed: number): string => failed === 0 ? '' : `，${String(failed)} 位失败`
    const running = kind === 'backup'
      ? launcher.backupMine().then(result => `已备份 ${String(result.backedUp)} 位专家到云端${failures(result.failed.length)}`)
      : launcher.restoreMine().then(result => `已从云端恢复 ${String(result.restored)} 位专家（同名专家已覆盖本地）${failures(result.failed.length)}`)
    void running
      .then(async (message) => {
        setNotice(message)
        if (kind === 'restore') await reload()
      })
      .catch((cause: unknown) => {
        setNotice(cause instanceof Error ? cause.message : '云端操作失败，请稍后重试')
      })
      .finally(() => { setCloudBusy(undefined) })
  }

  const { official, mine } = experts === undefined ? { official: [], mine: [] } : partitionExperts(experts)

  const renderOfficialCard = (expert: ExpertDef): ReactNode => (
    <ExpertCard key={expert.id} expert={expert} starting={starting === expert.id} onStart={startWith} />
  )

  const renderMineCard = (expert: ExpertDef): ReactNode => (
    <ExpertCard
      key={expert.id}
      expert={expert}
      starting={starting === expert.id}
      onStart={startWith}
      actions={{
        onEdit: (row): void => {
          setFormError(undefined)
          setForm({ expert: row })
        },
        onDelete: (row): void => { setPendingDelete(row) },
      }}
    />
  )

  return (
    <div className="chengziExpertsPage" role="region" aria-label="专家">
      <section className="chengziExpertsOverlayPanel">
        <header className="chengziExpertsOverlayHeader">
          <div>
            <h1>专家</h1>
            <p>选一位专家开局，能力、风格与费用提示都已就位</p>
          </div>
          <Tooltip label="关闭">
            <Button
              variant="ghost"
              size="sm"
              aria-label="关闭专家页"
              icon={<IconCloseOutlineRegular size={16} />}
              onClick={closePanel}
            />
          </Tooltip>
        </header>
        <div className="chengziExpertsOverlayBody">
          {experts === undefined ? (
            <p className="chengziExpertsEmpty">正在加载专家目录…</p>
          ) : (
            <>
              <section className="chengziExpertsSection" aria-label="官方专家">
                <h2 className="chengziExpertsSectionTitle">官方</h2>
                {official.length === 0 ? (
                  <p className="chengziExpertsEmpty">暂无官方专家</p>
                ) : (
                  <div className="chengziExpertsGrid">{official.map(renderOfficialCard)}</div>
                )}
              </section>
              <section className="chengziExpertsSection" aria-label="我的专家">
                <div className="chengziExpertsSectionHead">
                  <h2 className="chengziExpertsSectionTitle">我的</h2>
                  <div className="chengziExpertsSectionTools">
                    {notice !== undefined && <span className="chengziExpertsNotice">{notice}</span>}
                    <Tooltip label="把本机全部自建专家存到云端账号">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={cloudBusy !== undefined}
                        onClick={() => { runCloud('backup') }}
                      >
                        {cloudBusy === 'backup' ? '正在备份…' : '备份到云端'}
                      </Button>
                    </Tooltip>
                    <Tooltip label="用云端备份覆盖本机同名专家">
                      <Button
                        variant="ghost"
                        size="sm"
                        disabled={cloudBusy !== undefined}
                        onClick={() => { runCloud('restore') }}
                      >
                        {cloudBusy === 'restore' ? '正在恢复…' : '从云端恢复'}
                      </Button>
                    </Tooltip>
                  </div>
                </div>
                {mine.length === 0 && (
                  <p className="chengziExpertsEmpty">还没有自建专家，点击下方虚线卡片创建一个</p>
                )}
                <div className="chengziExpertsGrid">
                  {mine.map(renderMineCard)}
                  <button
                    type="button"
                    className="chengziExpertCreateCard"
                    onClick={() => {
                      setFormError(undefined)
                      setForm({})
                    }}
                  >
                    <span className="chengziExpertCreatePlus" aria-hidden="true">+</span>
                    创建我的专家
                  </button>
                </div>
              </section>
            </>
          )}
        </div>
      </section>
      {form !== undefined && (
        <MineExpertFormModal
          expert={form.expert}
          busy={formBusy}
          error={formError}
          onCancel={() => { setForm(undefined) }}
          onSubmit={submitForm}
        />
      )}
      {pendingDelete !== undefined && (
        <Modal
          open
          onClose={() => { if (!deleteBusy) setPendingDelete(undefined) }}
          title={`删除「${pendingDelete.name}」`}
          closeLabel="关闭确认"
          contentClassName="chengziMineConfirm"
          footer={(
            <>
              <Button variant="outline" size="sm" disabled={deleteBusy} onClick={() => { setPendingDelete(undefined) }}>取消</Button>
              <Button variant="primary" size="sm" disabled={deleteBusy} onClick={confirmDelete}>
                {deleteBusy ? '正在删除…' : '删除'}
              </Button>
            </>
          )}
        >
          <p className="chengziMineConfirmText">
            删除后该专家将从「我的」分区移除，且无法撤销。正在使用该专家的会话不受影响。
          </p>
        </Modal>
      )}
    </div>
  )
}
