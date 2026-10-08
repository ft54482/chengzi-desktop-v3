/** Cordis Host plugin for the Chengzi Pro hzcfjt PPT tool: registers the
 *  model-facing `generate_hzcfjt_ppt` tool on the global tools service, so
 *  every agent session can produce bespoke report decks for 广州市海珠城市
 *  建设发展集团有限公司（海珠城发集团）.
 *
 *  There is deliberately no client surface: the capability is invoked through
 *  natural language in conversation, validates slides against the customer's
 *  five-chapter reporting template, and delivers the .pptx through the
 *  workspace + `present` convention.
 *
 *  模板事实源：海珠城发《PPT 模板》文档（五大章节 + 企业单页/重点项目单页/
 *  数据大屏三类高复用页面），代码化于 template/haizhu.ts。
 * @module dsh-plugin-chengzi-hzcfjt
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { registerHzcfjtPptTool, type HzcfjtPptToolConfig } from './tool.js'

/** Stable Cordis plugin name. */
export const name = 'chengzi-hzcfjt'

/** Host services required at activation: the global tool registry. */
export const inject = ['tools']

/** Plugin policy (reserved for future template customization). */
export interface Config {
  /** Maximum slides per generated deck. */
  maxSlides: number
}

/** Validated plugin policy. */
export const Config: z<Config> = z.object({
  maxSlides: z.number().step(1).min(1).max(200).default(120),
})

/**
 * Register the effect-scoped `generate_hzcfjt_ppt` tool.
 * @param ctx - Host context carrying tools.
 * @param config - validated plugin policy.
 */
export function apply(ctx: Context, config: Config): void {
  const toolConfig: HzcfjtPptToolConfig = {
    maxSlides: config.maxSlides,
  }
  ctx.effect(
    () => registerHzcfjtPptTool(ctx, toolConfig),
    'chengzi-hzcfjt: generate_hzcfjt_ppt tool',
  )
}

export { defineHzcfjtPptTool, registerHzcfjtPptTool } from './tool.js'
export type { HzcfjtPptResult, HzcfjtPptToolConfig } from './tool.js'
export { validateSlides, DEFAULT_SKELETON_GUIDE, BRAND, sectionOrdinal, projectOrdinal } from './template/haizhu.js'
export { renderDeck, renderSlide } from './pptx/writer.js'
export { buildZip } from './pptx/zip.js'
