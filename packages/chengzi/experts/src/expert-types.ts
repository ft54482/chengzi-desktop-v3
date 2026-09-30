/** 专家目录契约：与云端 `GET /api/v1/experts` 行同构的字段名（snake_case），
 *  内置清单与远端行共用同一形状，两端逐字一致。
 *  @module dsh-plugin-chengzi-experts/expert-types */

/** 专家 id 命名空间：`expert-` 前缀 + 小写字母/数字/连字符。
 *  该前缀是同步器在 `<DSH_HOME>/.agent-presets/` 下的领地边界——
 *  不以 `expert-` 开头的目录一律不碰；`expert-mine-*` 是 Phase B 的
 *  用户自建命名空间，永不覆盖。 */
export const EXPERT_ID_PATTERN = /^expert-[a-z0-9-]+$/u

/** 用户自建专家（Phase B）的 id 前缀；同步器遇到即跳过，永不覆盖。 */
export const EXPERT_MINE_PREFIX = 'expert-mine-'

/** 一位专家的完整定义：人格提示词 + 展示与开局引导数据。 */
export interface ExpertDef {
  /** 稳定 id；同时是物化出的 preset 目录名与 preset id。 */
  readonly id: string
  /** 展示名（≤20 字符）。 */
  readonly name: string
  /** 展示图标（emoji）。 */
  readonly icon: string
  /** 一句话能力描述。 */
  readonly description: string
  /** 专家人格提示词；物化时替换 standard 组合 persona 行的 prefix。 */
  readonly persona: string
  /** 专家声明的工具名提示（Phase A 仅做透传记录，不据此裁剪组合）。 */
  readonly tools: readonly string[]
  /** 专家声明的 skill 名提示（Phase A 仅做透传记录）。 */
  readonly skills: readonly string[]
  /** 开局引导文案；`{cost_hint}` 占位符在 setDraft 前替换为 cost_hint。 */
  readonly guided_intro: string | null
  /** 开局示例问题（≤3 条）。 */
  readonly starter_prompts: readonly string[]
  /** 费用提示；为 null 表示无付费能力，画廊黄色标注仅非空时展示。 */
  readonly cost_hint: string | null
  /** 建议模型提示；Phase A 恒为 null。 */
  readonly model_hint: string | null
  /** 卡片角标文字（如「官方定制」）；null 显示默认「官方」。
   *  单客户定制专家用此字段与通用官方专家区分。 */
  readonly badge: string | null
  /** 是否上架；false 行参与 diff 以触发本地目录删除。 */
  readonly enabled: boolean
  /** 行版本；大于本地物化版本时重写目录。 */
  readonly version: number
}

/** `GET /api/v1/experts`（及本地 `/plugins/chengzi-experts/catalog`）的成功载荷。 */
export interface CatalogResponse {
  /** 生效专家清单（已剔除 enabled=false 行）。 */
  readonly experts: readonly ExpertDef[]
  /** 本次清单来源：云端成功为 `cloud`，失败降级为 `builtin`。 */
  readonly source: 'cloud' | 'builtin'
}
