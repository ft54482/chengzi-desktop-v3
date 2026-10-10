/** Chengzi Pro reader plugin: `read_wechat_article` — one-call reading of
 *  WeChat Official Account articles as customer material (PPT sources,
 *  writing references). Desktop reads pass WeChat's anti-crawler because the
 *  request leaves from the user's own broadband IP with a real-browser header
 *  set; no third-party crawler dependency is involved. */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import z from '@deepseek-ai/schemastery'
import { defineReadWechatArticleTool } from './tool.ts'

export const name = 'chengzi-reader'

export const inject = ['tools'] as const

export interface Config {
  /** Register the `read_wechat_article` tool. */
  enabled: boolean
}

export const Config = z.object({
  enabled: z.boolean().default(true),
})

export function apply(ctx: Context, config: Config = { enabled: true }): void {
  if (!config.enabled) return
  ctx.tools.register(defineReadWechatArticleTool())
}
