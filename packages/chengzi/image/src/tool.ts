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
 *
 *  生图档位目录驱动：平台 BFF 目录里 category=image 的按次模型即档位（名称与
 *  单价都是现成字段），账号插件周期刷新目录后本工具在下个执行周期自动跟随
 *  换模型/调价，无需发客户端版本；目录不可用/为空回落内置兜底清单。
 * @module dsh-plugin-chengzi-image/tool
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { defineTool, type GenericCallView, type GenericResultView, type ToolDefinition, type ToolResult } from '@deepseek-ai/dsh-tools'
import { UserQuestionError, type AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import { getCatalogSnapshot } from 'dsh-plugin-chengzi-account'
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

/** 兜底首项：目录异常时的最终落点（也是兜底清单的第一档）。 */
const FALLBACK_STANDARD: ModelOption = { id: 'gpt-image-2.5-flare', name: 'Flare 标准', label: 'Flare 标准（¥0.15/张）', priceCny: 0.15 }

/** 兜底清单：平台目录不可用/未就绪时使用（与平台现役 image 模型保持一致，随客户端版本更新）。 */
const FALLBACK_MODEL_OPTIONS: readonly ModelOption[] = [
  FALLBACK_STANDARD,
  { id: 'gpt-image-2.5-sunburst', name: 'Sunburst 标准', label: 'Sunburst 标准（¥0.15/张）', priceCny: 0.15 },
  { id: 'gpt-image-2.5-flare-4k', name: 'Flare 4K', label: 'Flare 4K（¥0.375/张）', priceCny: 0.375 },
  { id: 'gpt-image-2.5-sunburst-4k', name: 'Sunburst 4K', label: 'Sunburst 4K（¥0.45/张）', priceCny: 0.45 },
]

/** 目录条目的档位投影面：只声明本工具读取的字段（结构兼容账号插件的目录视图）。 */
interface CatalogImageModel {
  readonly id: string
  readonly displayName?: string
  readonly category?: string
  readonly inputPriceCny?: number
}

/** 生图模型的目录 id 前缀：image 类里只有它属于静态图生成。MiniMax-H3 系列
 *  是视频任务模型（按次计费被目录归入 image 类，2026-10-10 实案：确认卡把它
 *  当生图档位、Agent 以 ¥1.90/张误调）——按前缀排除；平台未来新增生图模型
 *  沿用 gpt-image-* 命名即自动进档位。 */
const IMAGE_MODEL_PREFIX = 'gpt-image-'

/** image 类按次计费条目：单价存在且为正的目录行（类型收口，免断言）。 */
type PricedImageModel = CatalogImageModel & { readonly inputPriceCny: number }

function isPricedImageModel(model: CatalogImageModel): model is PricedImageModel {
  return model.category === 'image' && typeof model.inputPriceCny === 'number' && model.inputPriceCny > 0
}

/** 目录行是否为静态生图档位：image 类且 id 走 gpt-image-* 命名（排除视频任务模型）。 */
function isImageGenerationTier(model: PricedImageModel): boolean {
  return model.id.startsWith(IMAGE_MODEL_PREFIX)
}

/** 目录驱动的生图档位（2026-10-10 拍板）：平台目录 image 类按次模型即档位——
 *  平台换模型/调价，桌面在下个目录刷新周期自动跟随，无需发客户端版本。
 *  名称后缀 `-4k` 约定为 4K 档；目录不可用/为空回落 {@link FALLBACK_MODEL_OPTIONS}。 */
export function resolveModelOptions(): readonly ModelOption[] {
  const fromCatalog = getCatalogSnapshot()
    .filter(isPricedImageModel)
    .filter(isImageGenerationTier)
    .map(model => ({
      id: model.id,
      name: model.displayName ?? model.id,
      label: `${model.displayName ?? model.id}（¥${String(model.inputPriceCny)}/张）`,
      priceCny: model.inputPriceCny,
    }))
  return fromCatalog.length > 0 ? fromCatalog : FALLBACK_MODEL_OPTIONS
}

/** 目录为空/异常时档位选取的最终落点：兜底清单首项。 */
function firstOption(options: readonly ModelOption[]): ModelOption {
  return options[0] ?? FALLBACK_STANDARD
}

/** 显式分辨率 → 档位：`-4k` 后缀匹配约定；无匹配回落首项。 */
function pickOption(resolution: 'standard' | '4k', options: readonly ModelOption[]): ModelOption {
  if (resolution === '4k') {
    return options.find(option => option.id.endsWith('-4k')) ?? firstOption(options)
  }
  return options.find(option => !option.id.endsWith('-4k')) ?? firstOption(options)
}

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
    description: 'Generate one image from a text prompt with the Chengzi Pro platform image models (GPT-Image-2.5: flare / sunburst, each in standard and 4K). Use it whenever the user asks to create, draw, or 生成 a picture, illustration, poster, slide artwork, or similar. The tool itself raises a confirmation card: it reminds the user about the per-image cost and asks which resolution when you did not state one, so state the intended resolution ("standard" or "4k") when the user already told you. Generation is billed per image to the signed-in account; a cancelled confirmation costs nothing. After a successful generation, call present on the returned file_path so the user actually sees the image, and reference that path if the file should be embedded in further artifacts.',
    parameters: {
      prompt: {
        type: 'string',
        required: true,
        description: 'Image description in natural language; keep the user\'s intent, enrich only with concrete visual details they stated.',
      },
      resolution: {
        type: 'string',
        enum: ['standard', '4k'],
        description: 'Either "standard" (gpt-image-2.5-flare, ¥0.15 per image) or "4k" (gpt-image-2.5-flare-4k, ¥0.375 per image); the confirmation card additionally offers the sunburst variants. Optional: when omitted the confirmation card asks the user to choose.',
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
      const modelOptions = resolveModelOptions()

      // 确认卡：意图 + 费用提醒；分辨率未指明时一并询问。
      const questions: AskUserQuestionItem[] = []
      if (resolution === undefined) {
        questions.push({
          id: 'resolution',
          question: '选择生图分辨率',
          header: '分辨率',
          options: modelOptions.map(option => ({
            label: option.label,
            description: option.id.endsWith('-4k') ? '4K 高清图像生成模型' : '图像生成模型，支持文生图',
          })),
        })
      }
      const stated = resolution === undefined ? undefined : pickOption(resolution, modelOptions)
      questions.push({
        id: 'confirm',
        question: '生成图片将按张计费并从账户余额扣除，确认生成？',
        header: '生图确认',
        detail: stated === undefined
          ? `生图按张计费：${modelOptions.map(option => `${option.name} ¥${option.priceCny.toFixed(2)}/张`).join('，')}；确认后按所选分辨率从账户余额扣除。`
          : `按${stated.name}生成一张图片，费用 ¥${stated.priceCny.toFixed(2)} 从账户余额扣除。`,
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
        ? pickOption(resolution, modelOptions)
        : modelOptions.find(option => byId.get('resolution')?.selected.includes(option.label)) ?? firstOption(modelOptions)

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
