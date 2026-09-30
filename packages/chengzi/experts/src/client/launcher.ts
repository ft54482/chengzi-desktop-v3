/** 专家 client 面的共享契约：目录读取 + 以专家开局会话 + 「我的专家」增删改
 *  与云端备份/恢复的统一入口（ExpertLauncher），以及三个槽位条目的注入面。
 *  由 client apply 构造（闭包持有 Client 根上下文），供画廊面板与 dock 共用。 */

import type { ExpertDef } from '../expert-types.js'
import type { MineBackupResult, MineExpertInput, MineRestoreResult } from '../mine-types.js'

export interface ExpertLauncher {
  /** 读取专家目录（含 client 短缓存；官方 + 我的合并清单）。 */
  readCatalog(signal?: AbortSignal): Promise<readonly ExpertDef[]>
  /** 以专家开局新会话；initialDraft 非空时以该文本预填草稿。 */
  startExpert(expert: ExpertDef, initialDraft?: string): Promise<void>
  /** 创建一位「我的专家」（host 落盘并派生唯一 id）。 */
  createMine(input: MineExpertInput): Promise<ExpertDef>
  /** 更新一位「我的专家」（同 id 重写目录，version 递增）。 */
  updateMine(id: string, input: MineExpertInput): Promise<ExpertDef>
  /** 删除一位「我的专家」目录（不影响已开启的会话）。 */
  deleteMine(id: string): Promise<void>
  /** 把本地全部「我的专家」备份到云端（未登录时 reject 登录引导文案）。 */
  backupMine(): Promise<MineBackupResult>
  /** 从云端恢复「我的专家」（同 id 直接覆盖本地目录）。 */
  restoreMine(): Promise<MineRestoreResult>
}

/** 全屏专家页（main keyed 面板）的注入面。 */
export interface ExpertsPageFace {
  /** 目录与开局动作。 */
  launcher: ExpertLauncher
  /** 关闭面板（回到会话面板）。 */
  closePanel: () => void
}

/** 侧栏 footer「专家」入口的注入面。 */
export interface ExpertsLauncherFace {
  /** 打开专家面板。 */
  openPanel: () => void
}

/** conversation.input.dock 专家身份卡的注入面。 */
export interface ExpertDockFace {
  /** 把示例问题文本预填进当前会话草稿。 */
  setDraft: (text: string) => void
}
