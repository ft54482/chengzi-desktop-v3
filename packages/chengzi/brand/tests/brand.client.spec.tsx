// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { apply, inject } from '../src/client/index.ts'
import { ChengziBrandMark, ChengziBrandName, ChengziHeroMark } from '../src/client/Brand.tsx'

afterEach(() => {
  cleanup()
})

const HOLES = [
  'sidebar.brand.mark',
  'sidebar.brand.name',
] as const

const HERO_HOLE = 'conversation.hero.brand.mark' as const

/** The declaring shell: root entry with the brand holes, as ui-sidebar and
 *  ui-conversation declare them at runtime. */
async function bench(declare = true) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const slots = ctx.get('slots') as SlotRegistry
  const declareHoles = () => slots.register({
    name: 'root',
    children: Object.fromEntries([...HOLES, HERO_HOLE].map(name => [name, { kind: 'single', scope: 'root' }])),
  } as never, () => null)
  const disposeHoles = declare ? declareHoles() : undefined
  return { ctx, slots, declareHoles, disposeHoles }
}

describe('chengzi browser-brand plugin', () => {
  it('declares only the slot service it uses', () => {
    expect(inject).toEqual(['slots'])
  })

  it('fills the brand slots before or after declarations and removes every occupant on teardown', async () => {
    const before = await bench()
    const fiber = before.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    for (const hole of HOLES) expect(before.slots.entries(hole)).toHaveLength(1)
    expect(before.slots.entries(HERO_HOLE)).toHaveLength(1)

    before.disposeHoles?.()
    for (const hole of [...HOLES, HERO_HOLE]) expect(before.slots.entries(hole)).toHaveLength(0)
    before.declareHoles()
    await Promise.resolve()
    for (const hole of [...HOLES, HERO_HOLE]) expect(before.slots.entries(hole)).toHaveLength(1)

    await fiber.dispose()
    for (const hole of [...HOLES, HERO_HOLE]) expect(before.slots.entries(hole)).toHaveLength(0)

    const after = await bench(false)
    await after.ctx.plugin({ inject: [...inject], apply }).await()
    for (const hole of [...HOLES, HERO_HOLE]) expect(after.slots.entries(hole)).toHaveLength(0)
    after.declareHoles()
    await Promise.resolve()
    for (const hole of [...HOLES, HERO_HOLE]) expect(after.slots.entries(hole)).toHaveLength(1)
  })

  it('shadows a default-priority occupant instead of clashing with it', async () => {
    const subject = await bench()
    // The official build profile registers the whale at the default rank 0;
    // the chengzi occupant must take the cell without throwing and win the
    // shadowing election (ascending rank, lowest renders).
    const official = subject.slots.register({ name: 'sidebar.brand.mark' }, () => null)
    await subject.ctx.plugin({ inject: [...inject], apply }).await()
    const ranks = subject.slots.entries('sidebar.brand.mark')
      .map(entry => entry.options.priority ?? 0).sort((left, right) => left - right)
    expect(ranks).toEqual([-1, 0])
    const winner = subject.slots.entriesOfSlot('sidebar.brand.mark')[0]
    expect(winner?.options.priority).toBe(-1)
    official()
  })

  it('renders the slice mark at every requested size and passes the hero class through', () => {
    const sidebar = render(<ChengziBrandMark size={24} />)
    const sidebarSvg = sidebar.container.querySelector('svg')
    expect(sidebarSvg?.getAttribute('width')).toBe('24')
    expect(sidebarSvg?.getAttribute('viewBox')).toBe('0 0 24 24')
    sidebar.rerender(<ChengziBrandMark size={16} />)
    expect(sidebar.container.querySelector('svg')?.getAttribute('width')).toBe('16')
    sidebar.unmount()

    const hero = render(<ChengziHeroMark size={34} className="hero-fish" />)
    const heroSvg = hero.container.querySelector('svg')
    expect(heroSvg?.getAttribute('width')).toBe('34')
    expect(heroSvg?.getAttribute('class')).toBe('hero-fish')
    hero.unmount()
  })

  it('renders the wordmark and the monochrome slice artwork', () => {
    const name = render(<ChengziBrandName />)
    expect(name.container.textContent).toBe('橙子PRO')
    name.unmount()

    const mark = render(<ChengziBrandMark size={24} />)
    // Monochrome line art: outlined disc (no brand fill), tone inherits the
    // host text color — no fixed brand orange anywhere in the mark.
    const disc = mark.container.querySelector('circle')
    expect(disc?.getAttribute('fill')).toBeNull()
    expect(disc?.getAttribute('stroke')).toBe('currentColor')
    expect(mark.container.innerHTML).not.toContain('#E8732A')
    mark.unmount()
  })

  it('never renders the complete-build version badge (removed: unreadable light chip)', () => {
    vi.stubEnv('DSH_CLIENT_VERSION', '3.0.0')
    vi.stubEnv('DSH_CLIENT_COMMIT_HASH', 'abc1234')
    const name = render(<ChengziBrandName />)
    expect(name.container.textContent).toBe('橙子PRO')
    name.unmount()
    vi.unstubAllEnvs()
  })
})
