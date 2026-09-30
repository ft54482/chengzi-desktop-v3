/** Model-facing `generate_image` tool: one platform image per call, billed to
 *  the signed-in account.
 *
 *  The tool NEVER generates without an explicit human confirmation: it raises
 *  the platform's built-in question card covering intent + per-image cost
 *  (an approval-intent question, so a capable UI renders it as an approve or
 *  decline decision), and asks which resolution when the model didn't state
 *  one. The generated PNG lands in the session workspace (`chengzi-images/`);
 *  the tool result tells the model to call `present` so the image reaches the
 *  user.
 *
 *  The platform API key is read per call through the credential seam
 *  (`ctx.credentials.resolve`), so a re-login reaches the next generation
 *  without a plugin restart. The account plugin stores the key under
 *  {@link CHENGZI_PLATFORM_API_KEY_REF}.
 * @module dsh-plugin-chengzi-image/tool
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type GenericCallView, type GenericResultView, type ToolDefinition, type ToolResult } from '@deepseek-ai/dsh-tools'
import { UserQuestionError, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { generateImages, type ImageRequest } from './image-client.js'

/** Credential reference the platform API key resolves through (`ctx.credentials.resolve`).
 *  账号插件登录后经 `credentials.set` 写入；env 未设置时读托管存储。 */
export const CHENGZI_PLATFORM_API_KEY_REF = credentialRef('CHENGZI_PLATFORM_API_KEY')

/** Catalog projection inputs the tool needs from the Host entry. */
export interface ChengziImageToolConfig {
  /** Platform origin serving `/v1` (e.g. `https://host/v1`). */
  readonly platformBaseUrl: string
  /** Outbound transport override (tests); production uses `globalThis.fetch`. */
  readonly request?: ImageRequest
}

/** One image-model option surfaced to the confirmation card. */
interface ModelOption {
  readonly id: string
  readonly name: string
  readonly label: string
  readonly priceCny: number
}

const STANDARD_OPTION: ModelOption = { id: 'gpt-image-2', name: '标准', label: '标准（¥0.20/张）', priceCny: 0.2 }
const FOUR_K_OPTION: ModelOption = { id: 'gpt-image-2-4K', name: '4K 高清', label: '4K 高清（¥0.60/张）', priceCny: 0.6 }
const MODEL_OPTIONS: readonly ModelOption[] = [STANDARD_OPTION, FOUR_K_OPTION]

const CANCEL_LABEL = '取消，不生成'
const CONFIRM_LABEL = '确认生成'
const MAX_PROMPT_CHARS = 4_000

function timestamp(): string {
  const now = new Date()
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Model-facing result payload; `file_path` is workspace-relative for `present`. */
export interface GenerateImageResult {
  readonly status: 'generated' | 'cancelled'
  readonly file_path?: string
  readonly model?: string
  readonly price_cny?: number
  readonly revised_prompt?: string
  readonly note?: string
}

/** Presentation payload persisted beside the result for replay-safe presenters. */
interface ChengziImageMeta {
  status?: string
  filePath?: string
  model?: string
  priceCny?: number
}

/** Narrow the persisted meta defensively; obsolete or malformed meta declines to undefined. */
function readMeta(result: ToolResult): ChengziImageMeta | undefined {
  const meta = result.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const candidate = meta as Record<string, unknown>
  if (candidate.status !== 'generated' && candidate.status !== 'cancelled') return undefined
  return {
    status: candidate.status,
    ...typeof candidate.filePath === 'string' ? { filePath: candidate.filePath } : {},
    ...typeof candidate.model === 'string' ? { model: candidate.model } : {},
    ...typeof candidate.priceCny === 'number' ? { priceCny: candidate.priceCny } : {},
  }
}

function optionFor(resolution: 'standard' | '4k'): ModelOption {
  return resolution === '4k' ? FOUR_K_OPTION : STANDARD_OPTION
}

/**
 * Build the `generate_image` tool definition against the given context.
 * Split from {@link registerGenerateImageTool} so tests can reach the
 * present hooks on the definition itself.
 * @param ctx - Host context carrying userQuestions and credentials at execution time.
 * @param config - platform origin plus the transport override.
 * @returns the registry-ready definition.
 */
export function defineGenerateImageTool(ctx: Context, config: ChengziImageToolConfig): ToolDefinition {
  return defineTool({
    name: 'generate_image',
    description: 'Generate one image from a text prompt with the Chengzi Pro platform image models (GPT-Image-2 / GPT-Image-2 4K). Use it whenever the user asks to create, draw, or 生成 a picture, illustration, poster, slide artwork, or similar. The tool itself raises a confirmation card: it reminds the user about the per-image cost and asks which resolution when you did not state one, so state the intended resolution ("standard" or "4k") when the user already told you. Generation is billed per image to the signed-in account; a cancelled confirmation costs nothing. After a successful generation, call present on the returned file_path so the user actually sees the image, and reference that path if the file should be embedded in further artifacts.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Image description in natural language; keep the user\'s intent, enrich only with concrete visual details they stated.',
      },
      resolution: {
        type: 'string',
        enum: ['standard', '4k'],
        description: 'Either "standard" (GPT-Image-2, ¥0.20 per image) or "4k" (GPT-Image-2 4K, ¥0.60 per image). Optional: when omitted the confirmation card asks the user to choose.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['generated', 'cancelled'], required: true },
          file_path: { type: 'string' },
          model: { type: 'string' },
          price_cny: { type: 'number' },
          revised_prompt: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const text = value.status === 'cancelled'
          ? 'Image generation cancelled by the user; nothing was billed. Do not present anything.'
          : `Generated ${value.file_path ?? ''} with ${value.model ?? ''} (¥${(value.price_cny ?? 0).toFixed(2)}). Call present on file_path now so the user sees the image.`
        return [{ type: 'text', text }]
      },
      // Persist the outcome facts a result card needs across replay; the raw
      // canonical value is not on the wire, only the model-facing text.
      presentationMeta: (_args, value) => ({
        status: value.status,
        ...value.file_path === undefined ? {} : { filePath: value.file_path },
        ...value.model === undefined ? {} : { model: value.model },
        ...value.price_cny === undefined ? {} : { priceCny: value.price_cny },
      }),
    },
    // 确认卡的等待时间计入工具执行：超时必须覆盖「人的思考时间」，
    // 否则用户还没点完确认卡工具就被杀（240s 曾三次超时）。30min 上限，
    // 平台生图本身通常 ≤2min，取消/超时路径都不产生扣费。
    timeoutMs: 1_800_000,
    async execute(args, exec) {
      const prompt = args.prompt.trim()
      if (prompt.length === 0 || prompt.length > MAX_PROMPT_CHARS) {
        throw new Error(`prompt must be 1~${String(MAX_PROMPT_CHARS)} characters.`)
      }
      const resolution = args.resolution

      // 确认卡：意图 + 费用提醒；分辨率未指明时一并询问。
      const questions: AskUserQuestionItem[] = []
      if (resolution === undefined) {
        questions.push({
          id: 'resolution',
          question: '选择生图分辨率',
          header: '分辨率',
          options: MODEL_OPTIONS.map(option => ({
            label: option.label,
            description: option.id === 'gpt-image-2-4K' ? '4K 高清图像生成模型' : '图像生成模型，支持文生图',
          })),
        })
      }
      questions.push({
        id: 'confirm',
        question: '生成图片将按张计费并从账户余额扣除，确认生成？',
        header: '生图确认',
        detail: resolution === undefined
          ? '生图按张计费：标准 ¥0.20/张，4K 高清 ¥0.60/张；确认后按所选分辨率从账户余额扣除。'
          : `按${optionFor(resolution).name}生成一张图片，费用 ¥${optionFor(resolution).priceCny.toFixed(2)} 从账户余额扣除。`,
        options: [
          { label: CONFIRM_LABEL, description: '按所选分辨率生成一张图片并扣费' },
          { label: CANCEL_LABEL, description: '本次不生成、不扣费' },
        ],
        // Presentation only: a capable UI renders the card as an approve or
        // decline decision instead of a generic question, and answers with one
        // of the labels above either way. The approve label MUST name an
        // option of this question, and `detail` carries the reviewed cost.
        intent: { kind: 'plan-review', approve: CONFIRM_LABEL, callId: exec.callId },
      })
      let answer: { answers: Array<{ id: string; selected: string[] }> }
      try {
        answer = await ctx.userQuestions.ask({
          questions,
          ...exec.agent === undefined ? {} : { agent: exec.agent },
          signal: exec.signal,
        })
      } catch (cause) {
        // A dismissed confirmation card is not a failed one: nothing was
        // billed and there is nothing to retry, so settle as cancelled.
        if (cause instanceof UserQuestionError && cause.code === 'ASK_CANCELLED') {
          return { status: 'cancelled', note: '用户关闭了生图确认卡，未扣费。' } satisfies GenerateImageResult
        }
        throw cause
      }
      const byId = new Map(answer.answers.map(item => [item.id, item]))
      const confirmed = byId.get('confirm')?.selected.includes(CONFIRM_LABEL) === true
      if (!confirmed) {
        return { status: 'cancelled', note: '用户取消了本次生图，未扣费。' } satisfies GenerateImageResult
      }
      const chosen = resolution !== undefined
        ? optionFor(resolution)
        : MODEL_OPTIONS.find(option => byId.get('resolution')?.selected.includes(option.label)) ?? STANDARD_OPTION

      // 会话工作区：图片必须落盘才能 present / 被后续产物引用。
      const cwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd
      if (cwd === undefined || cwd.length === 0) {
        throw new Error('generate_image requires a session workspace; run inside an agent session with a working directory.')
      }

      // 平台凭据按次解析：重新登录后下一次生成即可用，无需重启插件。
      const resolved = await ctx.credentials.resolve(CHENGZI_PLATFORM_API_KEY_REF)
      const key = resolved?.value ?? ''
      if (key.length === 0) {
        throw new Error('暂无可用的平台凭据，请重新登录后再试。')
      }

      const generated = await generateImages(
        { key, model: chosen.id, prompt },
        { baseUrl: config.platformBaseUrl, signal: exec.signal, ...config.request === undefined ? {} : { request: config.request } },
      )
      const first = generated.images[0]
      if (first === undefined) {
        throw new Error('The platform returned no image data.')
      }
      const extension = first.mime === 'image/jpeg' ? '.jpg' : first.mime === 'image/webp' ? '.webp' : '.png'
      const directory = join(cwd, 'chengzi-images')
      await mkdir(directory, { recursive: true })
      const fileName = `image-${timestamp()}${extension}`
      const absolutePath = join(directory, fileName)
      await writeFile(absolutePath, Buffer.from(first.base64, 'base64'))

      return {
        status: 'generated',
        file_path: `chengzi-images/${fileName}`,
        model: chosen.id,
        price_cny: chosen.priceCny,
        ...generated.revisedPrompt === undefined ? {} : { revised_prompt: generated.revisedPrompt },
      } satisfies GenerateImageResult
    },
    // Pure display: a generic pending card; the salient input is the prompt.
    presentCall(args): GenericCallView {
      const resolutionLabel = args.resolution === '4k' ? '（4K 高清）' : args.resolution === 'standard' ? '（标准）' : ''
      return {
        card: 'generic',
        title: `生成图片${resolutionLabel}`,
        kind: 'other',
        rawInput: args.prompt.length <= 200 ? args.prompt : `${args.prompt.slice(0, 200)}…`,
      }
    },
    // Result-time display: settle the card as generated or cancelled; a failed
    // call or obsolete replay meta declines to undefined (the generic fallback).
    presentResult(_args, result: ToolResult): GenericResultView | undefined {
      if (result.isError) return undefined
      const meta = readMeta(result)
      if (meta === undefined) return undefined
      if (meta.status === 'cancelled') {
        return { card: 'generic', title: '已取消生图（未扣费）' }
      }
      if (meta.filePath === undefined) return undefined
      return {
        card: 'generic',
        title: meta.priceCny === undefined
          ? `图片已生成 ${meta.filePath}`
          : `图片已生成 ${meta.filePath}（¥${meta.priceCny.toFixed(2)}）`,
      }
    },
  })
}

/**
 * Register the `generate_image` tool on the global tools service.
 * @param ctx - Host context carrying tools, userQuestions, and credentials.
 * @param config - platform origin plus the transport override.
 * @returns a disposer unregistering the tool.
 */
export function registerGenerateImageTool(ctx: Context, config: ChengziImageToolConfig): () => void {
  return ctx.tools.register(defineGenerateImageTool(ctx, config))
}
