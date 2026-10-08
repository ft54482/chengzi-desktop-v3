/** 海珠城发集团工作汇报 PPT 生成模板（事实源：docs/海珠城发PPT模板.md）。
 *
 *  模板 = 默认五章节骨架 + 页面类型白名单 + 视觉规范（主题色/字体/尺寸）。
 *  模型按本模板的页面类型产出 slides[]，渲染器负责落成 OOXML。
 */

/** 页面类型白名单（与 docs/海珠城发PPT模板.md 第五节一致）。
 *  cover/company/project/image 支持配图：image 为会话工作区相对路径
 *  （通常来自 generate_image 的产物 chengzi-images/*.png），由工具读入嵌入。 */
export type SlideSpec =
  | { readonly type: 'cover'; readonly title: string; readonly subtitle?: string; readonly image?: string }
  | { readonly type: 'section'; readonly title: string; readonly subtitle?: string }
  | { readonly type: 'bullets'; readonly title: string; readonly bullets: readonly { readonly head?: string; readonly text: string }[] }
  | { readonly type: 'stats'; readonly title: string; readonly stats: readonly { readonly value: string; readonly label: string }[] }
  | { readonly type: 'table'; readonly title: string; readonly note?: string; readonly headers: readonly string[]; readonly rows: readonly (readonly string[])[] }
  | {
    readonly type: 'company'
    readonly track: string
    readonly name: string
    readonly profile: string
    readonly highlights: readonly string[]
    readonly products: readonly { readonly name: string; readonly text: string }[]
    readonly progress?: { readonly zhaoshang?: string; readonly touzi?: string }
    readonly finance: readonly string[]
    readonly image?: string
  }
  | {
    readonly type: 'project'
    readonly name: string
    readonly overview: { readonly location: string; readonly plot: string; readonly plan: string; readonly schedule: string }
    readonly positioning: string
    readonly image?: string
  }
  | { readonly type: 'image'; readonly title?: string; readonly image: string; readonly caption?: string }
  | { readonly type: 'timeline'; readonly title: string; readonly items: readonly { readonly date: string; readonly event: string }[] }
  | { readonly type: 'end'; readonly title?: string }

/** 已解析的配图字节（工具从工作区读出后挂到页面上）。 */
export interface ResolvedImage {
  /** 工作区相对路径（同一图片多页复用时去重）。 */
  readonly source: string
  readonly bytes: Buffer
  readonly ext: 'png' | 'jpg'
}

/** 带可选配图数据的页面（工具内部形态）。 */
export type ResolvedSlide = SlideSpec & { readonly __img?: ResolvedImage }

/** 视觉规范（取自客户模板 theme 与正文用色）。 */
export const BRAND = Object.freeze({
  primary: '2B579A',
  primaryDark: '296EB1',
  text: '2D3847',
  gold: 'D1B15A',
  lightBlue: 'BBD8F6',
  white: 'FFFFFF',
  font: '微软雅黑',
})

/** 16:9 画布 EMU 尺寸。 */
export const SLIDE_WIDTH_EMU = 12_192_000
export const SLIDE_HEIGHT_EMU = 6_858_000

/** 章节中文序号（自动编号用）。 */
const CN_NUMERALS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十'] as const

/** 章节页自动编号：数前置 section 页序号，返回「一、」样式前缀。 */
export function sectionOrdinal(sectionIndex: number): string {
  const numeral = CN_NUMERALS[sectionIndex] ?? String(sectionIndex + 1)
  return `${numeral}、`
}

/** 固定头部占用的章节数（「一、整体概况」在原版前 6 页里，动态章节自此起编）。 */
export const HEAD_SECTION_COUNT = 1

/** 客户原版五大章节名 → 固定章节序号（0 起）。章节号属于章节本身，不随报告裁剪漂移。 */
const KNOWN_CHAPTERS: readonly string[] = ['整体概况', '产业投资', '培优育新', '产业载体', '其他业务']

/** 解析章节页序号：标题命中原版五大章节名 → 用其固定序号（如只做「培优育新」一章仍是「三、」）；
 *  未命中（自定义章节）→ 按位置 + 固定头部偏移兜底。 */
export function resolveSectionOrdinal(title: string, positionIndex: number): string {
  const known = KNOWN_CHAPTERS.findIndex(name => title.includes(name))
  if (known >= 0) return sectionOrdinal(known)
  return sectionOrdinal(positionIndex + HEAD_SECTION_COUNT)
}

/** 项目页自动编号：两位数字（01. 02. …）。 */
export function projectOrdinal(projectIndex: number): string {
  return `${String(projectIndex + 1).padStart(2, '0')}.`
}

/** 默认汇报骨架（前 6 页=封面+一、整体概况固定为客户原版，模型从第二章起生成）。 */
export const DEFAULT_SKELETON_GUIDE = [
  '（固定·原版）封面 + 一、整体概况（集团简介 / 战略地图 / 数说城发）——无需生成，工具自动注入客户审定原版',
  '二、产业投资（战略招引+财务投资：汇总表 + 企业单页）',
  '三、培优育新（琶洲模方：运营数据 stats / 应用场景 bullets / 重点项目）',
  '四、产业载体（重点项目单页：01. 02. …）',
  '五、其他业务（低空经济 / 贸易 / 城市更新 / 生态景观 bullets）',
  '结束页（致谢）',
] as const

/** 校验并归一模型给的 slides：类型白名单 + 必填字段；返回错误消息数组。 */
export function validateSlides(slides: unknown): { readonly spec: readonly SlideSpec[]; readonly errors: readonly string[] } {
  const errors: string[] = []
  if (!Array.isArray(slides) || slides.length === 0) {
    return { spec: [], errors: ['slides 必须为非空数组。'] }
  }
  if (slides.length > 120) {
    return { spec: [], errors: ['slides 单次最多 120 页。'] }
  }
  const spec: SlideSpec[] = []
  for (const [index, raw] of slides.entries()) {
    const where = `slides[${String(index)}]`
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      errors.push(`${where} 必须是对象。`)
      continue
    }
    const page = raw as Record<string, unknown>
    switch (page.type) {
      case 'cover':
      case 'section':
        if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`${where}.title 必填。`)
        else if (page.image !== undefined && typeof page.image !== 'string') errors.push(`${where}.image 必须为路径字符串。`)
        else spec.push(page as SlideSpec)
        break
      case 'image':
        if (typeof page.image !== 'string' || page.image.trim().length === 0) errors.push(`${where}.image 必填（工作区图片路径）。`)
        else spec.push(page as SlideSpec)
        break
      case 'bullets':
        if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`${where}.title 必填。`)
        else if (!Array.isArray(page.bullets) || page.bullets.length === 0) errors.push(`${where}.bullets 必须为非空数组。`)
        else spec.push(page as SlideSpec)
        break
      case 'stats':
        if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`${where}.title 必填。`)
        else if (!Array.isArray(page.stats) || page.stats.length === 0 || page.stats.length > 8) errors.push(`${where}.stats 需 1~8 条。`)
        else spec.push(page as SlideSpec)
        break
      case 'table':
        if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`${where}.title 必填。`)
        else if (!Array.isArray(page.headers) || !Array.isArray(page.rows) || page.headers.length === 0 || page.rows.length === 0) errors.push(`${where}.headers/rows 必填。`)
        else spec.push(page as SlideSpec)
        break
      case 'company':
        if (typeof page.name !== 'string' || page.name.trim().length === 0) errors.push(`${where}.name 必填。`)
        else if (typeof page.profile !== 'string' || page.profile.trim().length === 0) errors.push(`${where}.profile 必填。`)
        else spec.push(page as SlideSpec)
        break
      case 'project':
        if (typeof page.name !== 'string' || page.name.trim().length === 0) errors.push(`${where}.name 必填。`)
        else if (page.overview === null || typeof page.overview !== 'object') errors.push(`${where}.overview 必填。`)
        else spec.push(page as SlideSpec)
        break
      case 'timeline':
        if (typeof page.title !== 'string' || page.title.trim().length === 0) errors.push(`${where}.title 必填。`)
        else if (!Array.isArray(page.items) || page.items.length === 0) errors.push(`${where}.items 必填。`)
        else spec.push(page as SlideSpec)
        break
      case 'end':
        spec.push(page as SlideSpec)
        break
      default:
        errors.push(`${where}.type「${String(page.type)}」不在模板白名单（cover/section/bullets/stats/table/company/project/timeline/end）。`)
    }
  }
  return { spec, errors }
}
