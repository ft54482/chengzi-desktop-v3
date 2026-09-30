/** Cordis Host plugin for the Chengzi Pro image tool: registers the
 *  model-facing `generate_image` tool on the global tools service, so every
 *  agent session can generate platform images on the signed-in account.
 *
 *  There is deliberately no client surface: the capability is invoked through
 *  natural language in conversation, confirms cost/resolution through the
 *  platform question card, and delivers the PNG through the workspace +
 *  `present` convention.
 *
 *  The platform API key is NOT fetched here: execution resolves it per call
 *  through the credential seam (`CHENGZI_PLATFORM_API_KEY` reference), which
 *  the account plugin keeps current after every login.
 * @module dsh-plugin-chengzi-image
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-questions'
import z from '@deepseek-ai/schemastery'
import { registerGenerateImageTool, type ChengziImageToolConfig } from './tool.js'

/** Stable Cordis plugin name. */
export const name = 'chengzi-image'

/** Host services required at activation: the global tool registry, the
 *  question-card seam (cost/resolution confirmation), and the credential
 *  seam (the platform API key resolves through it per call). */
export const inject = ['tools', 'userQuestions', 'credentials']

/** Platform OpenAI-compatible endpoint.
 *  生产中转平台；本地联调可用环境变量 CHENGZI_PLATFORM_BASE_URL 覆盖。 */
export const CHENGZI_PLATFORM_BASE_URL = process.env.CHENGZI_PLATFORM_BASE_URL
  ?? 'https://pro.nat6.net/v1'

/** Image tool plugin policy. */
export interface Config {
  /** Platform origin serving the OpenAI-compatible images endpoint. */
  platformBaseUrl: string
}

/** Validated image tool plugin policy. */
export const Config: z<Config> = z.object({
  platformBaseUrl: z.string().default(CHENGZI_PLATFORM_BASE_URL),
})

/**
 * Register the effect-scoped `generate_image` tool.
 * @param ctx - Host context carrying tools, userQuestions, and credentials.
 * @param config - validated plugin policy.
 */
export function apply(ctx: Context, config: Config): void {
  const toolConfig: ChengziImageToolConfig = {
    platformBaseUrl: config.platformBaseUrl,
  }
  ctx.effect(
    () => registerGenerateImageTool(ctx, toolConfig),
    'chengzi-image: generate_image tool',
  )
}

/** Credential reference execution resolves the billed platform key through. */
export { CHENGZI_PLATFORM_API_KEY_REF } from './tool.js'
export { assertSafePlatformOrigin, ChengziImagePlatformError, generateImages } from './image-client.js'
export { registerGenerateImageTool } from './tool.js'
export type { GenerateImageResult } from './tool.js'
