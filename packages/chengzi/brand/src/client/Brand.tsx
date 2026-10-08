/** Chengzi Pro brand artwork: the monochrome orange-slice mark (single-tone
 *  line art — the slice reads in whatever tone the surrounding text uses, so
 *  it stays quiet on any theme, matching the whale's monochrome treatment)
 *  and the 橙子PRO wordmark. Geometry derives from the workspace tray SVG
 *  (50-unit source scaled ×0.48), so every surface renders the same slice. */
import type { HeroBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/** Slice line art tone: inherits the host text color (light on the dark
 *  sidebar, dark on light surfaces) instead of a fixed brand fill. */
const TONE = 'currentColor'

/** Square edge of the mark's coordinate space. */
const VIEWBOX = 24

/**
 * The orange-slice glyph in its 24-unit coordinate space: an outlined disc,
 * eight spokes, and a center pip — all one tone, no fills.
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
      <circle cx={12} cy={12} r={10.1} stroke={TONE} strokeWidth={1.15} />
      <g stroke={TONE} strokeWidth={1.15} strokeLinecap="round">
        <line x1={12} y1={3.12} x2={12} y2={10.32} />
        <line x1={12} y1={13.68} x2={12} y2={20.88} />
        <line x1={3.12} y1={12} x2={10.32} y2={12} />
        <line x1={13.68} y1={12} x2={20.88} y2={12} />
        <line x1={5.72} y1={5.72} x2={10.81} y2={10.81} />
        <line x1={13.19} y1={13.19} x2={18.28} y2={18.28} />
        <line x1={18.28} y1={5.72} x2={13.19} y2={10.81} />
        <line x1={10.81} y1={13.19} x2={5.72} y2={18.28} />
      </g>
      <circle cx={12} cy={12} r={1.25} fill={TONE} />
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

/**
 * Sidebar brand-name occupant: the product wordmark alone. The complete-build
 * version badge that used to ride beneath it is gone on purpose — a pinned
 * light chip under the wordmark was unreadable and noisy (user decision
 * 2026-10-08); the version stays discoverable in settings/about instead.
 * @returns the name element.
 */
export function ChengziBrandName() {
  return <span style={{ whiteSpace: 'nowrap' }}>橙子PRO</span>
}
