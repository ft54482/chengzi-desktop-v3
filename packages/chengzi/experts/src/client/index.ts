/** Client face: 专家功能的浏览器面——侧栏 footer「专家」入口 + 全屏专家页面
 *  （main keyed 面板，与插件管理页同款形态，经 sidebar.panellist 入口切换）
 *  + conversation.input.dock 专家身份卡。全部经 apply 闭包持有 Client 根
 *  上下文，开局流程见 start-session.ts。
 *
 *  0.2 形态迁移：旧 shell.overlay 弹层改为 main 面板（panel 生命周期替代
 *  overlay 的开关状态；打开 = ctx.layout.selectPanel，关闭 = selectPanel(null)），
 *  footer 入口与 panellist 图标两个入口指向同一面板。 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: ctx.remote（session create 等 generated Remote namespace）。
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: ctx.sessions 服务与 Session 快照形状。
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
// Type-only: conversation.input.dock 槽位契约与 ctx.conversation.input。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: main keyed 槽位与 ctx.layout。
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: renderer 槽位服务。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: ctx.workspaces 工作区列表。
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: sidebar.footer.action / sidebar.panellist 槽位契约。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ExpertDef } from '../expert-types.js'
import type { MineRestoreResult } from '../mine-types.js'
import { ExpertDock } from './expert-dock.js'
import { ExpertsLauncher } from './ExpertsLauncher.js'
import { ExpertsPage } from './ExpertsPage.js'
import { ExpertsPanelIcon } from './ExpertsPanelIcon.js'
import type { ExpertLauncher, ExpertDockFace, ExpertsLauncherFace, ExpertsPageFace } from './launcher.js'
import {
  backupMineExperts,
  createMineExpert,
  deleteMineExpert,
  restoreMineExperts,
  updateMineExpert,
} from './mine-api.js'
import { invalidateExpertCatalog, readExpertCatalog, startExpertSession } from './start-session.js'
import { installChengziExpertsStyles } from './styles.js'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'experts' as MainPanelId

/** Client services required at activation. cordis 的属性级 inject：remote 的
 *  namespace 访问（ctx.remote.session）必须逐个声明。 */
export const inject = ['slots', 'sessions', 'remote', 'remote.session', 'uiWorkspace', 'layout', 'conversation', 'workspaces']

/**
 * Contribute the experts surfaces: the footer entry, the main panel, the
 * sidebar panel-list icon, and the session dock card.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => installChengziExpertsStyles(), 'chengzi-experts: styles')

  const launcher: ExpertLauncher = {
    readCatalog: (signal?: AbortSignal): Promise<readonly ExpertDef[]> => readExpertCatalog(signal),
    startExpert: (expert: ExpertDef, initialDraft?: string): Promise<void> =>
      startExpertSession(ctx, expert, initialDraft),
    createMine: async (input): Promise<ExpertDef> => {
      const expert = await createMineExpert(input)
      invalidateExpertCatalog()
      return expert
    },
    updateMine: async (id, input): Promise<ExpertDef> => {
      const expert = await updateMineExpert(id, input)
      invalidateExpertCatalog()
      return expert
    },
    deleteMine: async (id): Promise<void> => {
      await deleteMineExpert(id)
      invalidateExpertCatalog()
    },
    backupMine: backupMineExperts,
    restoreMine: (): Promise<MineRestoreResult> => restoreMineExperts()
      .then((result) => {
        invalidateExpertCatalog()
        return result
      }),
  }

  // 侧栏底部「专家」入口（宽窄两种形态；点击打开专家面板）。
  ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
    name: 'sidebar.footer.action',
    id: 'chengzi-experts',
    order: 5,
    inject: (): ExpertsLauncherFace => ({
      openPanel: () => { ctx.layout.selectPanel(PANEL_ID) },
    }),
  }, ExpertsLauncher))

  // 全屏专家页面：main keyed 面板（选中该 key 时由 AppFrame 渲染，
  // selectPanel(null) 或切回会话即关闭——panel 生命周期替代旧 overlay 开关）。
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    inject: (): ExpertsPageFace => ({
      launcher,
      closePanel: () => { ctx.layout.selectPanel(null) },
    }),
  }, ExpertsPage))

  // 侧栏面板列表的「专家」图标（main 面板的官方切换入口）。
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: '专家',
  }, ExpertsPanelIcon))

  // composer 上方的专家身份卡（session 作用域 list 槽位）。
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'chengzi-experts',
    order: 40,
    inject: (sessionId): ExpertDockFace => ({
      setDraft: (text: string): void => {
        const actx = ctx.sessions.scope(sessionId)
        if (actx === undefined) return
        ctx.conversation.input.for(actx).setDraft(text)
      },
    }),
  }, ExpertDock))
}
