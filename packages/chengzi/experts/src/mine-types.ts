/** 「我的专家」（Phase B 用户自建）的共享契约：表单输入形状、工具白名单
 *  与云端备份/恢复结果。本模块保持零 Node 依赖，host 与 client 两端共用。
 *  @module dsh-plugin-chengzi-experts/mine-types */

import type { ExpertDef } from './expert-types.js'
import { EXPERT_MINE_PREFIX } from './expert-types.js'

/** 自定义专家可勾选的工具白名单（勾选子集，可空）。 */
export const MINE_ALLOWED_TOOLS: readonly string[] = Object.freeze([
  'generate_hzcfjt_ppt',
  'generate_image',
  'generate_video',
])

/** 「我的专家」的展示角标（显示层同时按 id 前缀 EXPERT_MINE_PREFIX 判定）。 */
export const MINE_BADGE = '我的'

/** 用户字段硬约束（表单行内校验与 host 侧校验共用同一张表）。 */
export const MINE_LIMITS = Object.freeze({
  /** 展示名上限。 */
  name: 20,
  /** 一句话描述上限。 */
  description: 60,
  /** 人格提示词上限。 */
  persona: 8000,
  /** 单条示例问题上限。 */
  starterPrompt: 60,
  /** 示例问题条数上限。 */
  starterPrompts: 3,
  /** 费用提示上限。 */
  costHint: 200,
})

/** 用户表单提交的自定义专家字段（host 校验归一后的形状）。
 *  `cost_hint` 为空串表示无费用提示（ExpertDef.cost_hint 落为 null）。 */
export interface MineExpertInput {
  /** 展示名（1~20 字符）。 */
  readonly name: string
  /** 展示图标（单个 emoji）。 */
  readonly icon: string
  /** 一句话描述（≤60 字符，可空）。 */
  readonly description: string
  /** 人格提示词（1~8000 字符）。 */
  readonly persona: string
  /** MINE_ALLOWED_TOOLS 的勾选子集（去重，可空）。 */
  readonly tools: readonly string[]
  /** 开局示例问题（0~3 条，每条 1~60 字符）。 */
  readonly starter_prompts: readonly string[]
  /** 费用提示（≤200 字符；空串=无）。 */
  readonly cost_hint: string
}

/** 云端备份/恢复中单个专家的失败记录（reason 为稳定短句，不回显响应体）。 */
export interface MineFailure {
  readonly id: string
  readonly reason: string
}

/** 一次「备份到云端」的结果。 */
export interface MineBackupResult {
  /** 成功写入云端的专家数。 */
  readonly backedUp: number
  /** 失败明细（未登录时整体失败，不进入此列表）。 */
  readonly failed: readonly MineFailure[]
}

/** 一次「从云端恢复」的结果（云端行直接覆盖本地同 id 目录）。 */
export interface MineRestoreResult {
  /** 成功落盘的专家数。 */
  readonly restored: number
  /** 失败明细。 */
  readonly failed: readonly MineFailure[]
}

/** 按 id 前缀把目录行分成 官方/我的 两段（官方在前、我的在后）。 */
export function partitionExperts(experts: readonly ExpertDef[]): {
  readonly official: readonly ExpertDef[]
  readonly mine: readonly ExpertDef[]
} {
  const official: ExpertDef[] = []
  const mine: ExpertDef[] = []
  for (const row of experts) {
    if (row.id.startsWith(EXPERT_MINE_PREFIX)) mine.push(row)
    else official.push(row)
  }
  return { official, mine }
}
