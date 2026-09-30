import type { ReactNode } from 'react'
import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ExpertDef } from '../expert-types.js'
import { EXPERT_MINE_PREFIX } from '../expert-types.js'

/** 卡片操作入口（「我的专家」专属：编辑/删除小按钮）。 */
export interface ExpertCardActions {
  readonly onEdit?: (expert: ExpertDef) => void
  readonly onDelete?: (expert: ExpertDef) => void
}

/** 角标文案：显示层按 id 前缀判「我的」，badge 仅为展示兜底。 */
export function expertBadgeText(expert: ExpertDef): string {
  const isMine = expert.id.startsWith(EXPERT_MINE_PREFIX)
  return expert.badge === null ? (isMine ? '我的' : '官方') : expert.badge
}

/** 专家卡片：icon/名称/角标/描述/费用黄字/chips/开始对话；
 *  「我的专家」额外渲染 hover 显示的 编辑/删除 小按钮。 */
export function ExpertCard({ expert, starting, onStart, actions }: {
  expert: ExpertDef
  starting: boolean
  onStart: (expert: ExpertDef, initialDraft?: string) => void
  actions?: ExpertCardActions
}): ReactNode {
  const isMine = expert.id.startsWith(EXPERT_MINE_PREFIX)
  // 提升为 const 局部：回调闭包里保留 undefined 收窄（参数收窄不进闭包）。
  const onEdit = actions?.onEdit
  const onDelete = actions?.onDelete
  const hasActions = onEdit !== undefined || onDelete !== undefined
  return (
    <article className="chengziExpertCard" data-mine={isMine} data-starting={starting}>
      {hasActions && (
        <div className="chengziExpertCardActions">
          {onEdit !== undefined && (
            <Tooltip label="编辑">
              <button type="button" className="chengziExpertCardAction" aria-label={`编辑「${expert.name}」`} onClick={() => { onEdit(expert) }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M11.3 2.1a1.7 1.7 0 0 1 2.4 2.4L5 13.2l-3.2.8.8-3.2 8.7-8.7Z" stroke="currentColor" strokeWidth="1.3" strokeLinejoin="round" />
                </svg>
              </button>
            </Tooltip>
          )}
          {onDelete !== undefined && (
            <Tooltip label="删除">
              <button type="button" className="chengziExpertCardAction" aria-label={`删除「${expert.name}」`} onClick={() => { onDelete(expert) }}>
                <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                  <path d="M3 4.5h10M6.5 4.5V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.5M4.5 4.5l.7 8.2a1.3 1.3 0 0 0 1.3 1.2h3a1.3 1.3 0 0 0 1.3-1.2l.7-8.2" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            </Tooltip>
          )}
        </div>
      )}
      <header className="chengziExpertCardHead">
        <span className="chengziExpertCardIcon" aria-hidden="true">{expert.icon}</span>
        <div className="chengziExpertCardTitle">
          <h2>{expert.name}</h2>
          <span className="chengziExpertCardBadge" data-mine={isMine}>{expertBadgeText(expert)}</span>
        </div>
      </header>
      <p className="chengziExpertCardDesc">{expert.description}</p>
      {expert.cost_hint === null || expert.cost_hint.length === 0 ? null : (
        <p className="chengziExpertCardCost">{expert.cost_hint}</p>
      )}
      {expert.starter_prompts.length === 0 ? null : (
        <div className="chengziExpertCardChips">
          {expert.starter_prompts.map(prompt => (
            <button
              key={prompt}
              type="button"
              className="chengziExpertCardChip"
              onClick={() => { onStart(expert, prompt) }}
            >
              {prompt}
            </button>
          ))}
        </div>
      )}
      <footer className="chengziExpertCardFoot">
        <Button
          variant="primary"
          size="sm"
          disabled={starting}
          onClick={() => { onStart(expert) }}
        >
          {starting ? '正在开局…' : '开始对话'}
        </Button>
      </footer>
    </article>
  )
}
