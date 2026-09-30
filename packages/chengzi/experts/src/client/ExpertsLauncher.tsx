import { Button, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { ExpertsLauncherFace } from './launcher.js'

/**
 * 侧栏底部「专家」入口按钮（点击打开专家面板）。`wide` 是 sidebar owner 在
 * renderSlot 传入的运行时 props（0.2 的槽位声明未把它写进 owner 类型，这里
 * 以可选 prop 对齐运行时形状）。
 */
export type ExpertsLauncherProps = PropsRuntime<'sidebar.footer.action'>
  & { wide?: boolean | undefined }
  & InjectFace<ExpertsLauncherFace>

export function ExpertsLauncher({ wide, openPanel }: ExpertsLauncherProps) {
  return (
    <Tooltip label="专家" delayMs={500} disabled={wide}>
      <Button
        variant="ghost"
        className="chengziExpertsLauncher"
        data-wide={wide}
        aria-label="专家"
        aria-haspopup="dialog"
        icon={<ExpertsIcon size={wide ? 16 : 18} />}
        onClick={openPanel}
      >
        {wide ? '专家' : null}
      </Button>
    </Tooltip>
  )
}

function ExpertsIcon({ size = 16 }: { readonly size?: number }) {
  return (
    <svg
      data-icon="chengzi-experts"
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
