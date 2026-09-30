/** Chengzi Pro brand artwork: the orange-slice mark (brand orange #E8732A,
 *  white spokes — legible from 16 px tray size up to the 34 px hero) and the
 *  橙子PRO wordmark. Geometry derives from the workspace tray SVG (50-unit
 *  source scaled ×0.48), so every surface renders the same slice. */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Brand primary (橙) and the spoke separator carved out of the disc. */
const ORANGE = '#E8732A'
const SPOKE = '#FFFFFF'

/** Square edge of the mark's coordinate space. */
const VIEWBOX = 24

/**
 * The orange-slice glyph in its 24-unit coordinate space.
 * @returns the glyph svg element.
 */
export function OrangeSliceMark({ size, className }: {
  /** Square edge in pixels. */
  size: number
  /** Host class preserving the surrounding mark geometry. */
  className?: string | undefined
}) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox={`0 0 ${VIEWBOX} ${VIEWBOX}`}
      fill="none"
      aria-hidden="true"
    >
      <circle cx={12} cy={12} r={10.1} fill={ORANGE} />
      <g stroke={SPOKE} strokeWidth={1.15} strokeLinecap="round">
        <line x1={12} y1={3.12} x2={12} y2={10.32} />
        <line x1={12} y1={13.68} x2={12} y2={20.88} />
        <line x1={3.12} y1={12} x2={10.32} y2={12} />
        <line x1={13.68} y1={12} x2={20.88} y2={12} />
        <line x1={5.72} y1={5.72} x2={10.81} y2={10.81} />
        <line x1={13.19} y1={13.19} x2={18.28} y2={18.28} />
        <line x1={18.28} y1={5.72} x2={13.19} y2={10.81} />
        <line x1={10.81} y1={13.19} x2={5.72} y2={18.28} />
      </g>
      <circle cx={12} cy={12} r={1.25} fill={SPOKE} />
    </svg>
  )
}

/**
 * Sidebar brand-mark occupant: the orange slice at the size the brand row
 * requests (expanded row and collapsed rail share the slot).
 * @param props - Host-supplied mark presentation.
 * @returns the mark svg element.
 */
export function ChengziBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <OrangeSliceMark size={size} />
}

/**
 * Conversation hero brand-mark occupant: replaces the declaring package's
 * animated-fish fallback on the blank-session headline.
 * @param props - Host-supplied hero presentation.
 * @returns the mark svg element.
 */
export function ChengziHeroMark({ size, className }: HeroBrandMarkOwnerProps) {
  return <OrangeSliceMark size={size} className={className} />
}

/** Complete-build metadata badge, mirroring the shell's local brand badge:
 *  version plus commit suffix, present only on complete builds. */
function buildVersionBadge(): string | undefined {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return undefined
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  return version
    + (commit === undefined ? '' : `-${commit}`)
    + (process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : '')
}

/**
 * Sidebar brand-name occupant: the product wordmark; on complete builds a
 * build-metadata badge rides beneath it (the shell's fallback badge would be
 * shadowed by this occupant, so the occupant carries it forward).
 * @returns the name element.
 */
export function ChengziBrandName() {
  const version = buildVersionBadge()
  if (version === undefined) {
    return <span style={{ whiteSpace: 'nowrap' }}>橙子PRO</span>
  }
  return (
    <span style={{
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      justifyContent: 'center', gap: 1, height: 24, whiteSpace: 'nowrap',
    }}>
      <span style={{ fontSize: 12, lineHeight: '13px', letterSpacing: 0 }}>橙子PRO</span>
      <span style={{
        display: 'inline-flex', alignItems: 'center', height: 10, padding: '0 3px',
        borderRadius: 2, color: 'var(--dsw-alias-label-primary-inverted)',
        background: 'var(--dsw-alias-label-primary)',
        fontFamily: 'var(--ds-font-family-code)', fontSize: 6, fontWeight: 500,
        lineHeight: '10px', whiteSpace: 'nowrap',
      }}>{version}</span>
    </span>
  )
}
