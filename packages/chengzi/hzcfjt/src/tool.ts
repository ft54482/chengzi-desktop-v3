/** Model-facing `generate_hzcfjt_ppt` tool: bespoke report decks for
 *  广州市海珠城市建设发展集团有限公司（海珠城发集团）.
 *
 *  激活：客户在对话里说「按海珠城发的模板做总结 PPT / 帮城发出一版汇报」
 *  等自然语言时，agent 调用本工具。工具按客户五章节汇报模板校验并渲染
 *  slides[]（页面类型白名单见 template/haizhu.ts），生成真实 .pptx 落到
 *  会话工作区，模型按 present 惯例交付。
 * @module dsh-plugin-chengzi-hzcfjt/tool
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type GenericCallView, type GenericResultView, type ToolDefinition, type ToolResult } from '@deepseek-ai/dsh-tools'
import { renderDeck } from './pptx/writer.js'
import { validateSlides, type ResolvedImage, type ResolvedSlide } from './template/haizhu.js'

/** Tool registration inputs the Host entry supplies. */
export interface HzcfjtPptToolConfig {
  /** Maximum slides per generated deck. */
  readonly maxSlides: number
}

/** Model-facing result payload; `file_path` is workspace-relative for `present`. */
export interface HzcfjtPptResult {
  readonly status: 'generated'
  readonly file_path: string
  readonly slide_count: number
  readonly note: string
}

const MAX_TOPIC_CHARS = 120
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

function sanitizeFilename(topic: string): string {
  const cleaned = topic.replace(/[\\/:*?"<>|\r\n]/gu, '').trim()
  return (cleaned.length > 0 ? cleaned : '海珠城发汇报').slice(0, 60)
}

function sniffImage(bytes: Buffer): 'png' | 'jpg' | undefined {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return 'png'
  return undefined
}

/** resolveImages 的产出：带配图数据的页面序列与收集到的校验错误。 */
interface ResolvedImages {
  readonly resolved: ResolvedSlide[]
  readonly errors: readonly string[]
}

/** 收集页面里声明的配图：从工作区读字节、嗅探格式、按路径去重。 */
async function resolveImages(pages: readonly unknown[], cwd: string): Promise<ResolvedImages> {
  const byPath = new Map<string, ResolvedImage>()
  const errors: string[] = []
  const resolved: ResolvedSlide[] = []
  for (const [index, raw] of pages.entries()) {
    const page: Record<string, unknown> = raw !== null && typeof raw === 'object' && !Array.isArray(raw)
      ? raw as Record<string, unknown>
      : {}
    const path = typeof page.image === 'string' && page.image.trim().length > 0 ? page.image.trim() : undefined
    if (path === undefined) {
      resolved.push(page as ResolvedSlide)
      continue
    }
    if (/(?:^|[\\/])\.\.(?:[\\/]|$)/u.test(path)) {
      errors.push(`slides[${String(index)}].image 不得包含父级穿越（..）：${path}`)
      resolved.push(page as ResolvedSlide)
      continue
    }
    let image = byPath.get(path)
    if (image === undefined) {
      let bytes: Buffer
      try {
        bytes = await readFile(join(cwd, path))
      } catch {
        errors.push(`slides[${String(index)}].image 不存在或不可读：${path}（可先用 generate_image 生成，再填其返回路径）`)
        resolved.push(page as ResolvedSlide)
        continue
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) {
        errors.push(`slides[${String(index)}].image 超过 20MB 上限：${path}`)
        resolved.push(page as ResolvedSlide)
        continue
      }
      const ext = sniffImage(bytes)
      if (ext === undefined) {
        errors.push(`slides[${String(index)}].image 格式不支持（仅 PNG/JPEG）：${path}`)
        resolved.push(page as ResolvedSlide)
        continue
      }
      image = { source: path, bytes, ext }
      byPath.set(path, image)
    }
    resolved.push({ ...page, __img: image } as ResolvedSlide)
  }
  return { resolved, errors }
}

/** Presentation payload persisted beside the result for replay-safe presenters. */
interface HzcfjtPptMeta {
  status?: string
  filePath?: string
  slideCount?: number
}

/** Narrow the persisted meta defensively; obsolete or malformed meta declines to undefined. */
function readMeta(result: ToolResult): HzcfjtPptMeta | undefined {
  const meta = result.meta
  if (typeof meta !== 'object' || meta === null || Array.isArray(meta)) return undefined
  const candidate = meta as Record<string, unknown>
  if (candidate.status !== 'generated') return undefined
  return {
    status: candidate.status,
    ...typeof candidate.filePath === 'string' ? { filePath: candidate.filePath } : {},
    ...typeof candidate.slideCount === 'number' ? { slideCount: candidate.slideCount } : {},
  }
}

/**
 * Build the `generate_hzcfjt_ppt` tool definition against the given policy.
 * Split from {@link registerHzcfjtPptTool} so tests can reach the present
 * hooks on the definition itself.
 * @param config - validated tool policy from the Host entry.
 * @returns the registry-ready definition.
 */
export function defineHzcfjtPptTool(config: HzcfjtPptToolConfig): ToolDefinition {
  return defineTool({
    name: 'generate_hzcfjt_ppt',
    description: '为广州市海珠城市建设发展集团有限公司（海珠城发集团）定制的工作汇报 PPT 生成器。触发场景：用户提到海珠城发/城发集团并需要 PPT、汇报、总结材料，或要求「按海珠城发的模板」产出。只要决定为用户产出海珠城发格式的 PPT，就必须首先调用本工具——不要用 python-pptx、PowerPoint 或任何手工方式自行拼装：本工具内置该客户审定的汇报模板与品牌视觉，一次调用即产出可交付的 .pptx。**固定头部**：成品前 6 页（封面 + 一、整体概况章节：集团简介/战略地图/数说城发）固定使用客户审定的原版页面，其中全部 logo 与图片与原版逐字节一致，不可也不会被修改——**不要为封面或「一、整体概况」传 slides，直接从「二、产业投资」开始**；若传了 cover 或整体概况章节页会被自动忽略。**配图联动**：需要配图时，先调用 generate_image 生成图片（可多次），再把每次返回的 file_path 填入 slides 对应页的 image 字段，本工具会把图片嵌入 PPT——支持配图的页面：company（企业单页右侧配图/产品图）、project（载体项目右侧效果图）、image（独立图片展示页）。动态章节结构：二、产业投资（战略招引+财务投资，企业单页）→ 三、培优育新（琶洲模方）→ 四、产业载体（重点项目单页）→ 五、其他业务（低空经济/贸易/城市更新/生态景观）→ 结束页。调用前先与用户确认报告主题与各章节实质内容（数据、项目、进展），把内容组织为 slides 数组传入。页面类型白名单：section(title,subtitle)/bullets(title,bullets[{head,text}])/stats(title,stats[{value,label}] 大数字卡片)/table(title,note,headers,rows)/company(track,name,profile,highlights[],products[{name,text}],progress{zhaoshang,touzi},finance[],image 投研企业单页：栏目顺序固定 企业简介→亮点优势→主要产品→项目进度→财务情况)/project(name,overview{location,plot,plan,schedule},positioning,image 重点项目单页：自动编两位序号)/image(title,image,caption 独立配图页)/timeline(title,items[{date,event}])/end(title)。生成后调用 present 交付 file_path。',
    parameters: {
      topic: {
        type: 'string',
        required: true,
        description: '报告主题，如「2026年上半年工作总结」「集团简介汇报」；同时作为默认文件名。',
      },
      slides: {
        type: 'array',
        required: true,
        description: '页面数组，按模板五章节结构组织；每页的 type 必须在白名单内。先给封面与各章节页，再填内容页；企业单页用 company 类型、载体项目用 project 类型。',
        items: {
          type: 'object',
          additionalProperties: true,
          properties: {
            type: { type: 'string', required: true, description: '页面类型：cover/section/bullets/stats/table/company/project/timeline/end。' },
          },
        },
      },
      filename: {
        type: 'string',
        description: '输出文件名（可不含 .pptx 后缀）；缺省用 topic。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', required: true },
          file_path: { type: 'string' },
          slide_count: { type: 'number' },
          warnings: { type: 'string' },
          note: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const text = value.status === 'generated'
          ? `Generated ${value.file_path ?? ''} (${String(value.slide_count ?? 0)} slides，海珠城发模板). Call present on file_path now so the user can open the deck.`
          : 'PPT generation failed. Do not present anything.'
        return [{ type: 'text', text }]
      },
      // Persist the outcome facts a result card needs across replay; the raw
      // canonical value is not on the wire, only the model-facing text.
      presentationMeta: (_args, value) => ({
        status: value.status,
        ...value.file_path === undefined ? {} : { filePath: value.file_path },
        ...value.slide_count === undefined ? {} : { slideCount: value.slide_count },
      }),
    },
    timeoutMs: 300_000,
    async execute(args, exec) {
      const topic = args.topic.trim()
      if (topic.length === 0 || topic.length > MAX_TOPIC_CHARS) {
        throw new Error(`topic 必须为 1~${String(MAX_TOPIC_CHARS)} 字符。`)
      }
      const { spec: uncheckedSpec, errors: validationErrors } = validateSlides(args.slides)
      const cwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd
      if (cwd === undefined || cwd.length === 0) {
        throw new Error('generate_hzcfjt_ppt requires a session workspace; run inside an agent session with a working directory.')
      }
      const { resolved, errors: imageErrors } = await resolveImages(args.slides, cwd)
      const errors = [...validationErrors, ...imageErrors]
      if (errors.length === 0 && uncheckedSpec.length > config.maxSlides) {
        errors.push(`slides 单次最多 ${String(config.maxSlides)} 页。`)
      }
      if (errors.length > 0) {
        throw new Error(`slides 校验失败：${errors.slice(0, 6).join(' ')}（页面类型白名单：cover/section/bullets/stats/table/company/project/image/timeline/end）`)
      }
      // 前 6 页（封面 + 一、整体概况）固定使用客户审定原版（含 logo 逐字节一致）：
      // 丢弃模型仍传入的 cover 与「整体概况」章节页，动态章节从二、产业投资开始。
      const fixedHeadTypes = new Set(['cover'])
      const isOverviewSection = (page: unknown): boolean => {
        if (page === null || typeof page !== 'object') return false
        const candidate = page as Record<string, unknown>
        if (candidate.type !== 'section') return false
        const title = typeof candidate.title === 'string' ? candidate.title : ''
        return title.replace(/[一二三四五、\s]/gu, '').includes('整体概况')
      }
      const dropped = resolved.filter(page => fixedHeadTypes.has(page.type) || isOverviewSection(page)).length
      const spec = uncheckedSpec.filter((_page, index) => {
        const resolvedPage = resolved[index]
        return resolvedPage !== undefined && !fixedHeadTypes.has(resolvedPage.type) && !isOverviewSection(resolvedPage)
      })
      const dynamicPages = resolved.filter(page => !fixedHeadTypes.has(page.type) && !isOverviewSection(page))
      const bytes = renderDeck(topic, dynamicPages)
      const requestedName = args.filename !== undefined && args.filename.trim().length > 0 ? args.filename.trim() : topic
      const fileName = `${sanitizeFilename(requestedName)}.pptx`
      const directory = join(cwd, 'chengzi-ppt')
      await mkdir(directory, { recursive: true })
      const absolutePath = join(directory, fileName)
      await writeFile(absolutePath, bytes)
      return {
        status: 'generated',
        file_path: `chengzi-ppt/${fileName}`,
        slide_count: 6 + spec.length,
        note: dropped > 0 ? `前 6 页（封面+一、整体概况）固定为客户审定原版，已忽略传入的 ${String(dropped)} 页 cover/整体概况页。` : '前 6 页（封面+一、整体概况）为客户审定原版。',
      } satisfies HzcfjtPptResult
    },
    // Pure display: a generic pending card; the salient input is the topic.
    presentCall(args): GenericCallView {
      return {
        card: 'generic',
        title: '生成海珠城发汇报 PPT',
        kind: 'other',
        rawInput: args.topic,
      }
    },
    // Result-time display: settle the card as generated; a failed call or
    // obsolete replay meta declines to undefined (the generic fallback).
    presentResult(_args, result: ToolResult): GenericResultView | undefined {
      if (result.isError) return undefined
      const meta = readMeta(result)
      if (meta === undefined || meta.filePath === undefined) return undefined
      return {
        card: 'generic',
        title: meta.slideCount === undefined
          ? `PPT 已生成 ${meta.filePath}`
          : `PPT 已生成 ${meta.filePath}（${String(meta.slideCount)} 页）`,
      }
    },
  })
}

/**
 * Register the `generate_hzcfjt_ppt` tool on the global tools service.
 * @param ctx - Host context carrying tools.
 * @param config - validated tool policy from the Host entry.
 * @returns a disposer unregistering the tool.
 */
export function registerHzcfjtPptTool(ctx: Context, config: HzcfjtPptToolConfig): () => void {
  return ctx.tools.register(defineHzcfjtPptTool(config))
}
