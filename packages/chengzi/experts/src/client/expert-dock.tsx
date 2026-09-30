/** conversation.input.dock 专家身份卡：仅当当前会话是专家开局且仍为空白
 *  （首轮未发，SessionSnapshot.blank）时渲染。含费用提示与开局示例 chips
 *  （点击 chip 经注入面预填草稿），以及「不在本次会话中显示」的关闭按钮。
 *
 *  0.2 适配：InputZone owner 只给 {session, input} 快照，不再带
 *  inputActions——草稿预填经注入面（client apply 闭包里的
 *  ctx.conversation.input.for(actx).setDraft）。
 */

import { useState, type ReactNode } from 'react'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ExpertDef } from '../expert-types.js'
import type { ExpertDockFace } from './launcher.js'
import { expertSessions } from './start-session.js'

export type ExpertDockProps = PropsRuntime<'conversation.input.dock'> & InjectFace<ExpertDockFace>

export function ExpertDock({ session, setDraft }: ExpertDockProps): ReactNode {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed || !session.blank) return null
  const expert: ExpertDef | undefined = expertSessions.get(session.sessionId)
  if (expert === undefined) return null

  return (
    <section className="chengziExpertsDock" data-chengzi-experts-dock={expert.id}>
      <div className="chengziExpertsDockHead">
        <span className="chengziExpertsDockIcon" aria-hidden="true">{expert.icon}</span>
        <span className="chengziExpertsDockName">{expert.name}</span>
        <span className="chengziExpertsDockBadge">{expert.badge === null ? '官方' : expert.badge}</span>
        <button
          type="button"
          className="chengziExpertsDockClose"
          aria-label="不在本次会话中显示"
          onClick={() => { setDismissed(true) }}
        >
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path d="M2 2l8 8M10 2l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
          </svg>
        </button>
      </div>
      <p className="chengziExpertsDockDesc">{expert.description}</p>
      {/* 费用提示不在开局展示（用户反馈易劝退）：付费口径由工具确认卡在客户真正
          触发生成时提示；cost_hint 数据保留给确认卡与未来场景。 */}
      {expert.starter_prompts.length > 0
        ? (
          <div className="chengziExpertsChips">
            {expert.starter_prompts.map(prompt => (
              <button
                key={prompt}
                type="button"
                className="chengziExpertsChip"
                onClick={() => { setDraft(prompt) }}
              >
                {prompt}
              </button>
            ))}
          </div>
        )
        : null}
    </section>
  )
}
