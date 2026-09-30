import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { parse as parseYaml } from 'yaml'
import { BUILTIN_EXPERTS } from '../src/builtin-experts.js'
import type { ExpertDef } from '../src/expert-types.js'
import {
  COMPOSITION_FILE,
  materializeExpertDirectory,
  MissingPersonaRowError,
  PRESET_METADATA_FILE,
  readExpertMetadata,
  removeExpertDirectory,
  renderPresetMetadataFile,
  replacePersonaPrefix,
} from '../src/materialize.js'

/**
 * 合成 standard 组合（含 persona 行、嵌套组行与后续顶层行）。0.2 起组合文本
 * 来自 registry 的 readDocument dump（见 preset-composition.spec.ts 的解析
 * 路径），物化器只做文本级 persona 替换，形状与本 fixture 一致。
 */
const standardText = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: >-',
  '      You are a coding agent powered by the {{model}} model.',
  '- id: agent-instructions',
  "  name: '@deepseek-ai/dsh-agent-instructions'",
  '  config:',
  '    maxBytes: 65536',
  '- id: planning',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: plan-mode',
  "      name: '@deepseek-ai/dsh-plan-mode'",
  '    - id: compaction-basic',
  "      name: '@deepseek-ai/dsh-compaction-basic'",
  '- id: tool-ask-user',
  "  name: '@deepseek-ai/dsh-tool-ask-user'",
  '',
].join('\n')

/** standard 的顶层行（列首无缩进的行），用于逐行对比。 */
function topLines(text: string): string[] {
  return text.split(/\r?\n/u).filter(line => /^- /u.test(line))
}

let root: string

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'chengzi-experts-materialize-'))
})

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
})

const pptExpert = BUILTIN_EXPERTS.find(row => row.id === 'expert-ppt')
if (pptExpert === undefined) throw new Error('builtin expert-ppt missing')

describe('materialized expert preset', () => {
  it('writes the composition with only the persona prefix replaced (line-by-line vs standard)', async () => {
    const directory = await materializeExpertDirectory(root, pptExpert, { standardText, source: 'builtin', now: new Date('2026-09-22T00:00:00Z') })

    // 目录名 = 专家 id。
    expect(directory).toBe(join(root, pptExpert.id))

    const composed = readFileSync(join(directory, COMPOSITION_FILE), 'utf8')
    // 顶层行集合与 standard 完全一致（行的顺序与文本；persona 行本身就是顶层行）。
    expect(topLines(composed)).toEqual(topLines(standardText))

    // persona 块外逐行相同：去掉 persona 块后与 standard 去掉 persona 块后逐字节一致。
    const composedWithoutPersona = composed.replace(/^- id: persona\n(?:^(?!- id:).*\n?)*/mu, '')
    const standardWithoutPersona = standardText.replace(/^- id: persona\n(?:^(?!- id:).*\n?)*/mu, '')
    expect(composedWithoutPersona).toBe(standardWithoutPersona)

    // persona 行的 prefix 换成专家人格；suffix 原样保留。
    expect(composed).toContain("name: '@deepseek-ai/dsh-persona'")
    expect(composed).toContain('suffix: Your working directory is {{cwd}}.')
    expect(composed).not.toContain('You are a coding agent powered by the {{model}} model.')
    for (const line of pptExpert.persona.split('\n')) {
      expect(composed).toContain(line)
    }
  })

  it('parses as YAML with a folded single-line persona prefix', () => {
    const composed = replacePersonaPrefix(standardText, pptExpert.persona)
    const rows = parseYaml(composed) as unknown as { id?: string; config?: { prefix?: string; suffix?: string } }[]
    const personaRow = rows.find(row => row.id === 'persona')
    expect(personaRow).toBeDefined()
    expect(personaRow?.config?.suffix).toBe('Your working directory is {{cwd}}.')
    expect(personaRow?.config?.prefix).toBe(pptExpert.persona.split('\n').join(' '))
    // 顶层行顺序与 standard 完全一致（persona 仍是第一个顶层行）。
    expect(topLines(composed)).toEqual(topLines(standardText))
  })

  it('writes preset.yml with name/description/order', async () => {
    const directory = await materializeExpertDirectory(root, pptExpert, { standardText, source: 'cloud', now: new Date() })
    const metadata = readFileSync(join(directory, PRESET_METADATA_FILE), 'utf8')
    expect(metadata).toBe(renderPresetMetadataFile(pptExpert))
    expect(metadata).toBe(`name: ${pptExpert.name}\ndescription: ${pptExpert.description}\norder: 50\n`)
    const parsed = parseYaml(metadata) as { name?: string; description?: string; order?: number }
    expect(parsed.name).toBe(pptExpert.name)
    expect(parsed.description).toBe(pptExpert.description)
    expect(parsed.order).toBe(50)
  })

  it('writes the private chengzi-expert.json metadata readable back', async () => {
    const now = new Date('2026-09-22T08:00:00Z')
    await materializeExpertDirectory(root, pptExpert, { standardText, source: 'cloud', now })
    const meta = await readExpertMetadata(root, pptExpert.id)
    expect(meta?.source).toBe('cloud')
    expect(meta?.materializedAt).toBe(now.toISOString())
    expect(meta?.expert.id).toBe(pptExpert.id)
    expect(meta?.expert.version).toBe(pptExpert.version)
    expect(meta?.expert.persona).toBe(pptExpert.persona)
  })

  it('removes the directory on demand', async () => {
    const directory = await materializeExpertDirectory(root, pptExpert, { standardText, source: 'builtin', now: new Date() })
    expect(existsSync(directory)).toBe(true)
    await removeExpertDirectory(root, pptExpert.id)
    expect(existsSync(directory)).toBe(false)
  })

  it('keeps the original line-ending style outside the persona block', () => {
    const crlfStandard = standardText.split('\n').join('\r\n')
    const composed = replacePersonaPrefix(crlfStandard, pptExpert.persona)
    expect(composed.includes('\r\n')).toBe(true)
    const composedWithoutPersona = composed.replace(/^- id: persona\r?\n(?:^(?!- id:).*\r?\n?)*/mu, '')
    const standardWithoutPersona = crlfStandard.replace(/^- id: persona\r?\n(?:^(?!- id:).*\r?\n?)*/mu, '')
    expect(composedWithoutPersona).toBe(standardWithoutPersona)
    const rows = parseYaml(composed) as unknown as { id?: string; config?: { prefix?: string } }[]
    expect(rows.find(row => row.id === 'persona')?.config?.prefix).toBe(pptExpert.persona.split('\n').join(' '))
  })

  it('throws when the standard composition carries no persona row', () => {
    const personaless = standardText.replace(/^- id: persona\n(?:^(?!- id:).*\n?)*/mu, '')
    expect(() => { replacePersonaPrefix(personaless, pptExpert.persona) }).toThrow(MissingPersonaRowError)
  })

  it('does not mistake nested group rows for the next top-level row', () => {
    // standard 的 planning 组内有缩进的 `- id:` 行；persona 块的边界必须停在
    // 下一个顶层行（agent-instructions），不吞组内行。
    const composed = replacePersonaPrefix(standardText, pptExpert.persona)
    expect(composed).toContain('- id: agent-instructions')
    expect(composed).toContain('    - id: plan-mode')
    expect(composed).toContain('    - id: compaction-basic')
    expect(composed).toContain('- id: tool-ask-user')
  })
})

describe('replacePersonaPrefix on synthetic minimal compositions', () => {
  const minimal = [
    '- id: persona',
    "  name: '@deepseek-ai/dsh-persona'",
    '  config:',
    '    suffix: Your working directory is {{cwd}}.',
    '    prefix: >-',
    '      You are a coding agent powered by the {{model}} model.',
    '- id: tool-ask-user',
    "  name: '@deepseek-ai/dsh-tool-ask-user'",
    '',
  ].join('\n')

  it('replaces the block and keeps the trailing rows', () => {
    const expert: ExpertDef = { ...pptExpert, persona: '第一行\n第二行\n第三行' }
    const composed = replacePersonaPrefix(minimal, expert.persona)
    expect(composed).toBe([
      '- id: persona',
      "  name: '@deepseek-ai/dsh-persona'",
      '  config:',
      '    suffix: Your working directory is {{cwd}}.',
      '    prefix: >-',
      '      第一行',
      '      第二行',
      '      第三行',
      '- id: tool-ask-user',
      "  name: '@deepseek-ai/dsh-tool-ask-user'",
      '',
    ].join('\n'))
  })

  it('handles a persona block at end of file without a following row', () => {
    const onlyPersona = minimal.slice(0, minimal.indexOf('- id: tool-ask-user'))
    const composed = replacePersonaPrefix(onlyPersona, '唯一一行')
    expect(composed).toContain('    prefix: >-\n      唯一一行\n')
    expect(composed).not.toContain('{{model}}')
  })
})
