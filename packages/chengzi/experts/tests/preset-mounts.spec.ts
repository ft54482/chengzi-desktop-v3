import { describe, expect, it, vi } from 'vitest'
import type { PresetDefinition } from '@deepseek-ai/dsh-agent-preset-registry'
import type { ExpertDef } from '../src/expert-types.js'
import { MissingPersonaRowError } from '../src/materialize.js'
import {
  expertPresetDefinition,
  parseCompositionRows,
  personaOnlyRows,
  readStandardComposition,
  withPersonaPrefix,
  type AgentPresetReader,
} from '../src/preset-composition.js'
import { createExpertPresetMounts, type AgentPresetRegistrar } from '../src/preset-mounts.js'

/** 合成 readDocument dump：与 registry 的 `dump(plugins, entryListSchema)` 同
 *  方言，含 persona 行、`!!js` 表达式行与嵌套组。 */
const STANDARD_DUMP = [
  '- id: persona',
  "  name: '@deepseek-ai/dsh-persona'",
  '  config:',
  '    suffix: Your working directory is {{cwd}}.',
  '    prefix: You are a coding agent powered by the {{model}} model.',
  '- id: tool-bash',
  "  name: '@deepseek-ai/dsh-tool-bash'",
  "  disabled: !!js process.platform === 'win32'",
  '- id: planning',
  '  name: cordis:group',
  '  group: true',
  '  config:',
  '    - id: plan-mode',
  "      name: '@deepseek-ai/dsh-plan-mode'",
  '',
].join('\n')

function expert(overrides: Partial<ExpertDef> & { readonly id: string }): ExpertDef {
  return {
    name: `测试专家 ${overrides.id}`,
    icon: '🧪',
    description: '测试用',
    persona: `你是测试专家 ${overrides.id}。`,
    tools: [],
    skills: [],
    guided_intro: null,
    starter_prompts: [],
    cost_hint: null,
    model_hint: null,
    badge: null,
    enabled: true,
    version: 1,
    ...overrides,
  }
}

describe('parseCompositionRows / withPersonaPrefix', () => {
  it('parses the loader dialect including !!js expression nodes and nested groups', () => {
    const rows = parseCompositionRows(STANDARD_DUMP)
    expect(rows.map(row => (row as { id?: string }).id)).toEqual(['persona', 'tool-bash', 'planning'])
    const disabled = (rows[1] as { disabled?: { __jsExpr?: string } }).disabled
    expect(disabled?.__jsExpr).toBe('process.platform === \'win32\'')
    const group = rows[2] as { group?: boolean; config?: unknown[] }
    expect(group.group).toBe(true)
    expect((group.config as { id?: string }[]).map(row => row.id)).toEqual(['plan-mode'])
  })

  it('returns an empty list for non-list text', () => {
    expect(parseCompositionRows('just: a map')).toEqual([])
    expect(parseCompositionRows('\tbroken: [')).toEqual([])
  })

  it('swaps only the persona prefix and keeps every other row verbatim', () => {
    const rows = parseCompositionRows(STANDARD_DUMP)
    const swapped = withPersonaPrefix(rows, '你是专家。')
    expect(swapped).toHaveLength(rows.length)
    expect(((swapped[0] as { config?: { prefix?: string } }).config)?.prefix).toBe('你是专家。')
    expect(((swapped[0] as { config?: { suffix?: string } }).config)?.suffix).toBe('Your working directory is {{cwd}}.')
    // 非 persona 行逐字保留（含表达式节点）。
    expect(swapped[1]).toEqual(rows[1])
    expect(swapped[2]).toEqual(rows[2])
  })

  it('throws the explicit missing-persona failure when the row is absent', () => {
    const rows = parseCompositionRows("- id: tool-fs\n  name: '@deepseek-ai/dsh-tool-fs'\n")
    expect(() => { withPersonaPrefix(rows, '你是专家。') }).toThrow(MissingPersonaRowError)
  })
})

describe('expertPresetDefinition / personaOnlyRows', () => {
  it('builds the registry definition with expert identity and order 50', () => {
    const rows = parseCompositionRows(STANDARD_DUMP)
    const definition = expertPresetDefinition(expert({ id: 'expert-demo' }), rows)
    expect(definition.id).toBe('expert-demo')
    expect(definition.name).toBe('测试专家 expert-demo')
    expect(definition.description).toBe('测试用')
    expect(definition.order).toBe(50)
    expect(((definition.plugins[0] as { config?: { prefix?: string } }).config)?.prefix).toBe('你是测试专家 expert-demo。')
    expect(definition.plugins).toHaveLength(rows.length)
  })

  it('falls back to a persona-only row set', () => {
    const rows = personaOnlyRows('兜底人格。')
    expect(rows).toEqual([
      {
        id: 'persona',
        name: '@deepseek-ai/dsh-persona',
        config: { suffix: 'Your working directory is {{cwd}}.', prefix: '兜底人格。' },
      },
    ])
    const definition = expertPresetDefinition(expert({ id: 'expert-bare' }), rows)
    expect(definition.plugins).toHaveLength(1)
    expect(((definition.plugins[0] as { config?: { prefix?: string } }).config)?.prefix).toBe('你是测试专家 expert-bare。')
  })
})

describe('readStandardComposition', () => {
  it('polls the registry until the standard preset is declared', async () => {
    let attempts = 0
    const reader: AgentPresetReader = {
      readDocument: async (agentPreset) => {
        attempts += 1
        if (attempts < 3) throw new Error(`Unknown agent preset: ${agentPreset}`)
        return { agentPreset: 'standard', content: STANDARD_DUMP }
      },
    }
    const onWait = vi.fn()
    const composition = await readStandardComposition(reader, { delayMs: 0, onWait })
    expect(composition?.text).toBe(STANDARD_DUMP)
    expect(composition?.rows).toHaveLength(3)
    expect(onWait).toHaveBeenCalledTimes(2)
  })

  it('resolves undefined after the attempt budget is exhausted', async () => {
    const reader: AgentPresetReader = {
      readDocument: async () => { throw new Error('never declared') },
    }
    const composition = await readStandardComposition(reader, { attempts: 3, delayMs: 0 })
    expect(composition).toBeUndefined()
  })

  it('rejects a declaration without plugin rows', async () => {
    const reader: AgentPresetReader = {
      readDocument: async () => ({ agentPreset: 'standard', content: 'not-a-list' }),
    }
    const composition = await readStandardComposition(reader, { attempts: 1 })
    expect(composition).toBeUndefined()
  })
})

/** 记录型伪 registry：register 收下定义并返回注销器。 */
function fakeRegistry(): AgentPresetRegistrar & {
  readonly definitions: Map<string, PresetDefinition>
  readonly unregistered: string[]
} {
  const definitions = new Map<string, PresetDefinition>()
  const unregistered: string[] = []
  return {
    definitions,
    unregistered,
    register: async (definition) => {
      if (definitions.has(definition.id)) throw new Error(`Duplicate agent preset: ${definition.id}`)
      definitions.set(definition.id, definition)
      return async () => {
        definitions.delete(definition.id)
        unregistered.push(definition.id)
      }
    },
  }
}

describe('createExpertPresetMounts', () => {
  it('applies experts as registry definitions', async () => {
    const registry = fakeRegistry()
    const mounts = createExpertPresetMounts(registry)
    const rows = parseCompositionRows(STANDARD_DUMP)
    await mounts.apply(expert({ id: 'expert-a' }), rows)
    await mounts.apply(expert({ id: 'expert-b' }), rows)
    expect(mounts.mountedIds()).toEqual(['expert-a', 'expert-b'])
    expect(registry.definitions.get('expert-a')?.order).toBe(50)
  })

  it('re-apply replaces the previous definition instead of duplicating', async () => {
    const registry = fakeRegistry()
    const mounts = createExpertPresetMounts(registry)
    const rows = parseCompositionRows(STANDARD_DUMP)
    await mounts.apply(expert({ id: 'expert-a', version: 1 }), rows)
    const first = registry.definitions.get('expert-a')
    await mounts.apply(expert({ id: 'expert-a', version: 2 }), rows)
    expect(registry.unregistered).toEqual(['expert-a'])
    expect(registry.definitions.get('expert-a')).not.toBe(first)
    expect(mounts.mountedIds()).toEqual(['expert-a'])
  })

  it('forget removes one mount and retain keeps only the desired set', async () => {
    const registry = fakeRegistry()
    const mounts = createExpertPresetMounts(registry)
    const rows = parseCompositionRows(STANDARD_DUMP)
    await mounts.apply(expert({ id: 'expert-a' }), rows)
    await mounts.apply(expert({ id: 'expert-b' }), rows)
    await mounts.forget('expert-a')
    expect(registry.unregistered).toEqual(['expert-a'])
    // 未挂载的 forget 是 no-op。
    await mounts.forget('expert-a')
    expect(registry.unregistered).toEqual(['expert-a'])

    await mounts.retain(['expert-b', 'expert-c'])
    expect(mounts.mountedIds()).toEqual(['expert-b'])
    // expert-b 在保留集内，retain 不再注销；unregistered 仍只有 expert-a。
    expect(registry.unregistered).toEqual(['expert-a'])
  })

  it('disposeAll unregisters everything', async () => {
    const registry = fakeRegistry()
    const mounts = createExpertPresetMounts(registry)
    const rows = parseCompositionRows(STANDARD_DUMP)
    await mounts.apply(expert({ id: 'expert-a' }), rows)
    await mounts.apply(expert({ id: 'expert-b' }), rows)
    await mounts.disposeAll()
    expect(mounts.mountedIds()).toEqual([])
    expect(registry.definitions.size).toBe(0)
    expect(registry.unregistered.sort()).toEqual(['expert-a', 'expert-b'])
  })
})
