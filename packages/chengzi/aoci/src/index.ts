/** Chengzi Pro aoci integration: exposes the `aoci` agent tool (a per-session
 *  workspace wrapper over the aoci-code CLI) and a system-prompt section that
 *  tells the agent to read, or propose building, the repository cognition
 *  index before it touches code in a project it has not seen before. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { defineAociTool } from './tool.ts'

export const name = 'chengzi-aoci'

export const inject = ['tools', 'systemPrompt'] as const

export interface Config {
  /** Register the `aoci` tool and the cognition-first prompt section. */
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

const SECTION_NAME = 'chengzi:aoci'

/** The cognition-first behavior rule shown to every agent session. */
export const AOCI_SECTION_TEXT = [
  '## 仓库认知优先（AOCI）',
  '',
  '在首次改动一个项目（或会话切到新工作区）之前，先建立对该仓库的整体认知：',
  '',
  '1. 首次接触工作区时先调用 `aoci` 工具执行 `status`，检查该仓库是否已有 AOCI 认知索引。',
  '2. 已有索引（status 显示 baseline/index 存在）：按项目 AGENTS.md 中 aoci 托管块的规则使用索引认知（该块已自动注入上下文），先用索引概览建立全局图景再定位具体代码，避免逐文件通读。',
  '3. 没有索引且项目包含实质性源代码：向客户简要说明 AOCI 的收益（一次构建索引，之后每次开发都带着对整个仓库的结构化认知开工，改错位置、漏改关联文件的情况会显著减少），询问是否初始化；客户同意后再执行 `init`（不带 --agent，写入通用 AGENTS.md 托管块）与 `scan`，并按索引构建引导完成首次索引。',
  '4. 客户暂不需要：正常开工，不要反复推销。',
  '',
  '`aoci` 是本地工具：索引是纯文本（aoci.txt）并随 Git 版本化，只在客户机器本地运行。',
  '工具严格按项目隔离：aoci 绑定当前会话工作区所属仓库（`--repo` 重定向会被剥离），一个项目的索引只服务本项目的会话，绝不要尝试读取或写入其他项目的索引。',
].join('\n')

export function apply(ctx: Context, config: Config = { enabled: true }): void {
  if (!config.enabled) return
  ctx.systemPrompt.section({
    name: SECTION_NAME,
    order: ctx.systemPrompt.getSectionOrder('PLAN_POLICY') - 10,
    text: AOCI_SECTION_TEXT,
  })
  ctx.tools.register(defineAociTool())
}
