import { describe, expect, it } from 'vitest'
import { BUILTIN_EXPERTS } from '../src/builtin-experts.js'
import { EXPERT_ID_PATTERN } from '../src/expert-types.js'

describe('builtin experts catalog', () => {
  it('ships exactly the five phase-A experts', () => {
    expect(BUILTIN_EXPERTS.map(row => row.id)).toEqual([
      'expert-ppt',
      'expert-image',
      'expert-video',
      'expert-writing',
      'expert-code',
    ])
  })

  it('has complete, well-formed fields on every expert', () => {
    expect(BUILTIN_EXPERTS.length).toBe(5)
    const seen = new Set<string>()
    for (const expert of BUILTIN_EXPERTS) {
      expect(EXPERT_ID_PATTERN.test(expert.id), expert.id).toBe(true)
      expect(seen.has(expert.id)).toBe(false)
      seen.add(expert.id)

      expect(expert.name.length).toBeGreaterThan(0)
      expect(expert.name.length).toBeLessThanOrEqual(20)
      expect(expert.icon.length).toBeGreaterThan(0)
      expect(expert.description.length).toBeGreaterThan(0)

      expect(expert.persona.length).toBeGreaterThan(0)
      expect(expert.persona.length).toBeLessThanOrEqual(8000)
      // 折叠块量书写要求：无空行、无行首/行尾空白、无制表符。
      for (const line of expert.persona.split('\n')) {
        expect(line.length).toBeGreaterThan(0)
        expect(line).toBe(line.trim())
        expect(line.includes('\t')).toBe(false)
      }

      expect(Array.isArray(expert.tools)).toBe(true)
      for (const tool of expert.tools) {
        expect(typeof tool).toBe('string')
        expect(tool.length).toBeGreaterThan(0)
      }
      expect(Array.isArray(expert.skills)).toBe(true)

      expect(expert.guided_intro === null || typeof expert.guided_intro === 'string').toBe(true)
      expect(expert.starter_prompts.length).toBeLessThanOrEqual(3)
      for (const prompt of expert.starter_prompts) {
        expect(prompt.length).toBeGreaterThan(0)
      }
      expect(expert.cost_hint === null || expert.cost_hint.length > 0).toBe(true)
      expect(expert.model_hint).toBeNull()
      expect(expert.badge === null || (expert.badge.length > 0 && expert.badge.length <= 16)).toBe(true)
      expect(expert.enabled).toBe(true)
      // expert-ppt 升级咨询式工作流（四阶段+确认门）时随文案变更升到 v3；其余保持 v1。
      expect(expert.version).toBe(expert.id === 'expert-ppt' ? 3 : 1)
    }
  })

  it('matches the required copy verbatim for every expert', () => {
    const byId = new Map(BUILTIN_EXPERTS.map(row => [row.id, row]))
    const ppt = byId.get('expert-ppt')
    expect(ppt?.name).toBe('PPT 汇报专家')
    expect(ppt?.icon).toBe('📊')
    expect(ppt?.description).toBe('分析资料、规划结构，确认后按企业模板生成汇报 PPT')
    expect([...ppt?.tools ?? []]).toEqual(['generate_hzcfjt_ppt', 'generate_image'])
    expect([...ppt?.skills ?? []]).toEqual(['hzcfjt-report-kit'])
    expect(ppt?.cost_hint).toBe('本专家含付费能力：配图 ¥0.20/张（生成前确认）；PPT 生成免费')
    expect(ppt?.badge).toBe('官方定制')
    expect(byId.get('expert-image')?.badge).toBeNull()
    // v3 起 expert-ppt 开局不再提费用（付费口径回归工具确认卡），guided_intro 无 {cost_hint} 占位符。
    expect(ppt?.guided_intro?.includes('{cost_hint}')).toBe(false)
    expect(ppt?.guided_intro?.includes('结构规划单')).toBe(true)
    expect([...ppt?.starter_prompts ?? []]).toEqual([
      '我有一份材料，想按城发模板做成汇报 PPT',
      '帮我规划一份 10 页左右的上半年工作总结汇报',
      '把下面的材料整理成城发格式汇报 PPT',
    ])
    expect(ppt?.persona.startsWith('你是「PPT 汇报专家」')).toBe(true)
    expect(ppt?.persona.endsWith('语气专业、简洁，善用列表与表格。')).toBe(true)
    // 咨询式工作流的关键硬规则必须在 persona 中。
    expect(ppt?.persona.includes('未经用户确认前，禁止调用 generate_hzcfjt_ppt')).toBe(true)
    expect(ppt?.persona.includes('模板永不改写目标')).toBe(true)

    const image = byId.get('expert-image')
    expect(image?.name).toBe('绘图专家')
    expect(image?.icon).toBe('🎨')
    expect([...image?.tools ?? []]).toEqual(['generate_image'])
    expect([...image?.skills ?? []]).toEqual([])
    expect(image?.cost_hint).toBe('生图 ¥0.20/张起（生成前确认）')

    const video = byId.get('expert-video')
    expect(video?.name).toBe('视频创作专家')
    expect(video?.icon).toBe('🎬')
    expect([...video?.tools ?? []]).toEqual(['generate_video'])
    expect(video?.cost_hint).toBe('视频 ¥1.20/次起（生成前确认）')
    expect([...video?.starter_prompts ?? []]).toEqual([
      '做一段 5 秒的产品开场动画',
      '生成一段城市航拍风格的短视频',
    ])

    const writing = byId.get('expert-writing')
    expect(writing?.name).toBe('写作专家')
    expect(writing?.icon).toBe('✍️')
    expect([...writing?.tools ?? []]).toEqual([])
    expect(writing?.cost_hint).toBeNull()
    expect(writing?.guided_intro?.includes('{cost_hint}')).toBe(false)

    const code = byId.get('expert-code')
    expect(code?.name).toBe('代码助手')
    expect(code?.icon).toBe('💻')
    expect([...code?.tools ?? []]).toEqual([])
    expect(code?.cost_hint).toBeNull()
  })
})
