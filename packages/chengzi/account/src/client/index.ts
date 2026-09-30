import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import { AccountLoginOverlay } from './AccountLoginOverlay.tsx'
import { AccountSettingsSection } from './AccountSettingsSection.tsx'
import { OpenSourceSection } from './OpenSourceSection.tsx'
import { applyModelPickerDirectExpand } from './model-picker.ts'
import { en, zh, type ChengziAccountLocaleKey } from './locales.ts'
import { installChengziAccountStyles } from './styles.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    'chengzi-account': ChengziAccountLocaleKey
  }
}

export const inject = ['slots', 'locale']
export const NS = 'chengzi-account'

export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'chengzi-account: dictionaries')
  ctx.effect(() => installChengziAccountStyles(), 'chengzi-account: styles')
  // 模型菜单直达：点一次徽标直接展开完整模型列表
  ctx.effect(() => applyModelPickerDirectExpand(), 'chengzi-account: model picker direct expand')
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'chengzi-account',
    order: 90,
    label: () => ctx.locale.bind(NS)('sectionLabel'),
    locale: NS,
  }, AccountSettingsSection))
  // 「关于」节：开源来源声明 + MIT 文本 + 第三方清单（order 低于账号，贴近列表尾部）
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section',
    id: 'chengzi-about',
    order: 95,
    label: () => ctx.locale.bind(NS)('aboutSectionLabel'),
    locale: NS,
  }, OpenSourceSection))
  // 登录强制门禁：无会话时全屏遮罩（order 高于市场 overlay）
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'chengzi-account-gate',
    order: 100,
    locale: NS,
  }, AccountLoginOverlay))
}
