/** 侧栏面板列表的「专家」入口图标；sidebar 拥有按钮、标签与选中态。 */

import type { ReactNode } from 'react'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

export function ExpertsPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return (
    <svg
      data-icon="chengzi-experts-panel"
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <path
        d="M8 1.75 9.55 5.4 13.5 5.85 10.6 8.5 11.4 12.4 8 10.45 4.6 12.4 5.4 8.5 2.5 5.85 6.45 5.4Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}
