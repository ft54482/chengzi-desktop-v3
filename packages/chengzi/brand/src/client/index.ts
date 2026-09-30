/** Chengzi Pro client face: fill the browser brand slots — the sidebar brand
 *  row (mark + name) and the blank-session conversation hero mark — with the
 *  orange-slice artwork.
 *
 *  官方 ui-brand-official 仅在 DSH_CLIENT_BUILD_PROFILE === 'official' 时注册，
 *  且官方侧没有自带占位；本插件无条件注册。single 槽的 priority 是遮蔽秩
 *  （升序、最低者渲染、同 key 同 priority 抛错）：official 用默认 0，这里取
 *  -1，使官方 profile 下鲸鱼字标也被本插件稳定遮蔽，本地 profile 下则是
 *  唯一占位。 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: hero 槽位契约（HeroBrandMarkOwnerProps）。
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: renderer 槽位服务。
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: sidebar 槽位契约（SidebarBrandMarkOwnerProps）。
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { ChengziBrandMark, ChengziBrandName, ChengziHeroMark } from './Brand.js'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/** Shadowing rank that sits below every default (0) registration. */
const BRAND_PRIORITY = -1

/**
 * Contribute the Chengzi Pro brand occupants for the sidebar and hero slots.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark', priority: BRAND_PRIORITY }, ChengziBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name', priority: BRAND_PRIORITY }, ChengziBrandName)
    }))
  ctx.slots.inject('conversation.hero.brand.mark', () =>
    ctx.slots.register({ name: 'conversation.hero.brand.mark', priority: BRAND_PRIORITY }, ChengziHeroMark))
}
