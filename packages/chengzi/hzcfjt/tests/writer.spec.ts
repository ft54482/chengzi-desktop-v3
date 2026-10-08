import { execFile } from 'node:child_process'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { renderDeck, renderSlide } from '../src/pptx/writer.js'
import { projectOrdinal, resolveSectionOrdinal, sectionOrdinal, validateSlides } from '../src/template/haizhu.js'
import type { SlideSpec } from '../src/template/haizhu.js'

const run = promisify(execFile)


const SAMPLE: readonly SlideSpec[] = [
  { type: 'cover', title: '2026年上半年工作总结', subtitle: '广州市海珠城市建设发展集团有限公司' },
  { type: 'section', title: '整体概况' },
  { type: 'stats', title: '数说城发', stats: [{ value: '超220亿元', label: '资产规模' }, { value: '超100万㎡', label: '在管载体' }] },
  { type: 'bullets', title: '业务战略地图', bullets: [{ head: '战略性', text: '具身智能、低空经济、智能制造' }, { text: '功能性业务稳步推进' }] },
  { type: 'table', title: '重点战略招引项目', note: '（单位：亿元）', headers: ['企业', '赛道', '投资额'], rows: [['联合飞机', '低空经济', '1.5']] },
  { type: 'company', track: '低空经济', name: '联合飞机', profile: '深圳联合飞机科技有限公司成立于2014年9月。', highlights: ['全国首张无人直升机TC', '已获超40亿元股权融资'], products: [{ name: 'Q20多旋翼无人机', text: '碳纤维一体成型' }], progress: { zhaoshang: '总部搬迁推进中', touzi: '已签署投资协议' }, finance: ['2024年营业收入2.58亿元，净利润-4.11亿元'] },
  { type: 'project', name: '琶洲算谷（633地块）', overview: { location: '琶洲南区', plot: '科研用地 16,582m²', plan: '4栋5层现代科技楼宇', schedule: '预计2026年7月竣工验收' }, positioning: '算力基石' },
  { type: 'timeline', title: '前哨站拓展', items: [{ date: '5月17日', event: '赴新加坡拜访能仁集团' }] },
  { type: 'end' },
]

describe('validateSlides', () => {
  it('accepts the template page types and reports precise errors', () => {
    const { spec, errors } = validateSlides(SAMPLE)
    expect(errors).toEqual([])
    expect(spec).toHaveLength(SAMPLE.length)
    const bad = validateSlides([{ type: 'unknown' as never }, { type: 'bullets', title: '', bullets: [] }])
    expect(bad.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('rejects empty and oversize decks', () => {
    expect(validateSlides([]).errors.length).toBeGreaterThan(0)
    expect(validateSlides(Array.from({ length: 121 }, () => ({ type: 'end' }))).errors.length).toBeGreaterThan(0)
  })
})

describe('section and project ordinals', () => {
  it('numbers sections in Chinese numerals and projects in two digits', () => {
    expect(sectionOrdinal(0)).toBe('一、')
    expect(sectionOrdinal(4)).toBe('五、')
    expect(projectOrdinal(0)).toBe('01.')
    expect(projectOrdinal(11)).toBe('12.')
  })

  it('resolves chapter ordinals by known chapter name, not deck position', () => {
    // 章节号属于章节本身：固定头部占「一、整体概况」，只做「培优育新」一章仍是「三、」
    expect(resolveSectionOrdinal('产业投资', 0)).toBe('二、')
    expect(resolveSectionOrdinal('培优育新专题', 0)).toBe('三、')
    expect(resolveSectionOrdinal('产业载体', 0)).toBe('四、')
    expect(resolveSectionOrdinal('其他业务', 0)).toBe('五、')
    // 自定义章节名：按位置 + 固定头部偏移兜底
    expect(resolveSectionOrdinal('专题总结', 0)).toBe('二、')
    expect(resolveSectionOrdinal('专题总结', 1)).toBe('三、')
  })
})

describe('renderSlide', () => {
  it('renders a company page with fixed section order and track:title header', () => {
    const xml = renderSlide(SAMPLE[5]!, 0, 0)
    expect(xml).toContain('低空经济：联合飞机')
    for (const head of ['企业简介', '亮点优势', '主要产品', '项目进度', '财务情况']) {
      expect(xml).toContain(head)
    }
    expect(xml).toContain('2B579A')
    expect(xml).toContain('微软雅黑')
  })

  it('renders a project page with the 0N. prefix and four overview fields', () => {
    const xml = renderSlide(SAMPLE[6]!, 0, 5)
    expect(xml).toContain('06. 琶洲算谷（633地块）')
    for (const field of ['地理位置', '地块情况', '项目规划', '建设计划', '产业定位']) {
      expect(xml).toContain(field)
    }
  })

  it('renders section pages with Chinese ordinal prefix', () => {
    const xml = renderSlide({ type: 'section', title: '产业投资' }, 1, 0)
    expect(xml).toContain('二、产业投资')
  })

  it('escapes XML-sensitive characters in user content', () => {
    const xml = renderSlide({ type: 'cover', title: 'A<B>&"C' }, 0, 0)
    expect(xml).toContain('A&lt;B&gt;&amp;&quot;C')
  })
})

describe('renderDeck', () => {
  it('builds a structurally complete OOXML package: 6 verbatim head slides + dynamic pages', async () => {
    const dynamic = SAMPLE.filter(page => page.type !== 'cover' && !(page.type === 'section' && page.title.includes('整体概况')))
    const bytes = renderDeck('2026年上半年工作总结', dynamic)
    expect(bytes.subarray(0, 2).toString('latin1')).toBe('PK')

    // 前 6 页与头部资产逐字节一致（客户原版，logo 不可变）
    const { createHash } = await import('node:crypto')
    const { readZip } = await import('../src/pptx/zip.js')
    const { loadHeadEntries, HEAD_SLIDE_COUNT } = await import('../src/pptx/head.js')
    const produced = new Map(readZip(bytes).map(entry => [entry.name, entry.data]))
    for (const entry of loadHeadEntries()) {
      if (!entry.name.startsWith('ppt/slides/slide') && !entry.name.startsWith('ppt/media/') && !entry.name.startsWith('ppt/slides/_rels/')) continue
      const same = produced.get(entry.name)
      expect(same, entry.name).toBeDefined()
      expect(createHash('sha256').update(same!).digest('hex')).toBe(createHash('sha256').update(entry.data).digest('hex'))
    }
    const total = HEAD_SLIDE_COUNT + dynamic.length
    expect(produced.has(`ppt/slides/slide${String(total)}.xml`)).toBe(true)
    expect(produced.has(`ppt/slides/slide${String(total + 1)}.xml`)).toBe(false)

    const dir = await mkdtemp(join(tmpdir(), 'hzcfjt-ppt-'))
    const path = join(dir, 'sample.pptx')
    await writeFile(path, bytes)
    const result = await run('python', ['-c', [
      'import zipfile,sys',
      'z=zipfile.ZipFile(sys.argv[1])',
      'assert z.testzip() is None',
      'names=set(z.namelist())',
      'for need in ["[Content_Types].xml","_rels/.rels","ppt/presentation.xml",',
      '  "ppt/slideMasters/slideMaster1.xml","ppt/slideMasters/slideMaster3.xml","ppt/slideMasters/slideMaster90.xml",',
      '  "ppt/slideLayouts/slideLayout90.xml","ppt/theme/theme90.xml",',
      '  "ppt/slides/slide1.xml","ppt/slides/slide7.xml",f"ppt/slides/slide{sys.argv[2]}.xml"]:',
      '    assert need in names, need',
      'from xml.etree import ElementTree as ET',
      'for n in names:',
      '    if n.endswith(".xml") or n.endswith(".rels"):',
      '        ET.fromstring(z.read(n))',
      'for i in list(range(1,7))+list(range(7,int(sys.argv[2])+1)):',
      '    rels=z.read(f"ppt/slides/_rels/slide{i}.xml.rels").decode("utf-8")',
      '    assert "slideLayout" in rels, i',
      'pres=z.read("ppt/presentation.xml").decode("utf-8")',
      'assert pres.count("<p:sldId ")==int(sys.argv[2]), pres.count("<p:sldId ")',
      'assert pres.count("<p:sldMasterId ")==3',
      'assert "12192000" in pres and "6858000" in pres',
      'print("pptx-ok")',
    ].join('\n'), path, String(total)])
    expect(result.stdout).toContain('pptx-ok')
  })
})
