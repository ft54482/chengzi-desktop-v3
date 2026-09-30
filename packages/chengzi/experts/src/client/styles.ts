/** 专家功能 client 样式：全局 CSS 字符串 + `<style data-plugin>` 注入。
 *  全部走 --dsw-alias-* 主题变量（深色友好）；费用提示用品牌亮橙黄 #F5A623 系。
 *  全屏专家页是 main keyed 面板（0.2 形态）：撑满主列、自带滚动。 */

const STYLE_ID = 'dsh-plugin-chengzi-experts/styles'

const css = `
/* ── 侧栏 footer 动作条改纵排（补上游历史缺口）──
 * 上游 .footerActions 是固定 50px 高的横排容器，只装得下一个宽按钮；
 * 专家入口加入后插件市场被挤出裁切。有专家入口在场时（:has 锚定 +
 * 类名段匹配，避免混淆 hash 漂移）把它改纵排并放开容器高度。 */
[class*="footerActions"]:has(.chengziExpertsLauncher) {
  flex-direction: column !important;
  height: auto !important;
  gap: 2px;
}
[class*="footArea"]:has(.chengziExpertsLauncher) {
  height: auto !important;
  min-height: 100px;
}

/* ── 侧栏 footer「专家」入口按钮（尺寸规范与插件市场一致） ── */
.chengziExpertsLauncher {
  flex: none;
  box-sizing: border-box;
  width: calc(100% + 4px);
  height: 42px;
  margin: 4px -2px;
  padding: 0 10px 0 8px;
  gap: 8px;
  justify-content: flex-start;
}
.chengziExpertsLauncher[data-wide='false'] {
  width: 36px;
  height: 36px;
  margin: 8px 0 10px;
  justify-content: center;
  gap: 0;
  padding: 0;
  border-radius: 50%;
}

/* ── 全屏「专家」页面（main keyed 面板，撑满主列） ── */
.chengziExpertsPage {
  display: flex;
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  padding: 16px;
  box-sizing: border-box;
}
.chengziExpertsOverlayPanel {
  display: flex;
  flex-direction: column;
  flex: 1;
  width: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  border: 1px solid var(--dsw-alias-border-inverted);
  border-radius: 24px;
  background: var(--dsw-alias-bg-layer-2);
  box-shadow: var(--dsw-shadow-lv3);
}
.chengziExpertsOverlayHeader {
  flex: none;
  display: flex;
  align-items: flex-start;
  gap: 12px;
  padding: 20px 18px 14px 24px;
  border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.chengziExpertsOverlayHeader > div {
  min-width: 0;
  flex: 1;
}
.chengziExpertsOverlayHeader h1 {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.chengziExpertsOverlayHeader p {
  margin: 4px 0 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.chengziExpertsOverlayBody {
  min-width: 0;
  min-height: 0;
  flex: 1;
  overflow: auto;
  padding: 20px 24px 24px;
}
.chengziExpertsEmpty {
  margin: 0;
  padding: 32px 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}
@media (max-width: 680px) {
  .chengziExpertsPage {
    padding: 0;
  }
  .chengziExpertsOverlayPanel {
    border-radius: 0;
  }
}

/* ── 专家卡片网格 ── */
.chengziExpertsGrid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 14px;
}
.chengziExpertCard {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 16px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.05));
}
.chengziExpertCardHead {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}
.chengziExpertCardIcon {
  flex: none;
  font-size: 26px;
  line-height: 1;
}
.chengziExpertCardTitle {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.chengziExpertCardTitle h2 {
  margin: 0;
  font-size: 15px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chengziExpertCardBadge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid rgba(91, 141, 239, 0.45);
  background: rgba(91, 141, 239, 0.14);
  color: var(--dsw-alias-label-secondary);
  font-size: 11px;
  line-height: 16px;
}
.chengziExpertCardDesc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.chengziExpertCardCost {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #f5a623;
}
.chengziExpertCardChips {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 2px;
}
.chengziExpertCardChip {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: left;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.08));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.chengziExpertCardChip:hover:not(:disabled),
.chengziExpertCardChip:focus-visible {
  color: var(--dsw-alias-label-primary);
  border-color: rgba(245, 166, 35, 0.55);
}
.chengziExpertCardFoot {
  margin-top: auto;
  display: flex;
  justify-content: flex-end;
}

/* ── 官方 / 我的 分区 ── */
.chengziExpertsSection {
  min-width: 0;
}
.chengziExpertsSection + .chengziExpertsSection {
  margin-top: 24px;
}
.chengziExpertsSectionHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.chengziExpertsSectionTitle {
  margin: 0 0 10px;
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-secondary);
}
.chengziExpertsSectionHead .chengziExpertsSectionTitle {
  margin: 0;
  flex: 1;
  min-width: 0;
}
.chengziExpertsSectionTools {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.chengziExpertsNotice {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}

/* ── 卡片操作按钮（「我的专家」编辑/删除，hover 显示） ── */
.chengziExpertCard {
  position: relative;
}
.chengziExpertCardActions {
  position: absolute;
  top: 8px;
  right: 8px;
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
}
.chengziExpertCard:hover .chengziExpertCardActions,
.chengziExpertCard:focus-within .chengziExpertCardActions {
  opacity: 1;
}
.chengziExpertCardAction {
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 6px;
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  cursor: pointer;
}
.chengziExpertCardAction:hover {
  color: var(--dsw-alias-label-primary);
  border-color: rgba(245, 166, 35, 0.55);
}
.chengziExpertCardBadge[data-mine='true'] {
  border-color: rgba(245, 166, 35, 0.5);
  background: rgba(245, 166, 35, 0.12);
}

/* ── 「+ 创建我的专家」虚线卡 ── */
.chengziExpertCreateCard {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 150px;
  padding: 16px;
  border: 1.5px dashed var(--dsw-alias-border-l1);
  border-radius: 14px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  cursor: pointer;
}
.chengziExpertCreateCard:hover,
.chengziExpertCreateCard:focus-visible {
  border-color: rgba(245, 166, 35, 0.55);
  color: var(--dsw-alias-label-primary);
}
.chengziExpertCreatePlus {
  font-size: 22px;
  line-height: 1;
}

/* ── 我的专家表单 Modal ── */
.chengziMineForm {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.chengziMineField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.chengziMineLabel {
  font-size: 13px;
  font-weight: 500;
  color: var(--dsw-alias-label-primary);
}
.chengziMineRequired {
  color: #f5a623;
}
.chengziMineInput {
  width: 100%;
}
.chengziMineTextarea {
  box-sizing: border-box;
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.06));
  color: var(--dsw-alias-label-primary);
  font: inherit;
  font-size: 13px;
  line-height: 1.5;
  resize: vertical;
}
.chengziMineTextarea:focus-visible {
  outline: none;
  border-color: rgba(245, 166, 35, 0.55);
}
.chengziMineHint {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-tertiary);
}
.chengziMineFieldError,
.chengziMineFormError {
  margin: 0;
  font-size: 12px;
  color: var(--dsw-alias-label-danger, #e5645a);
}
.chengziMineFormError {
  flex: 1;
  min-width: 0;
}
.chengziMineIcons {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.chengziMineIcon {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  font-size: 18px;
  line-height: 1;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 8px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.06));
  cursor: pointer;
}
.chengziMineIcon:hover,
.chengziMineIcon:focus-visible {
  border-color: rgba(245, 166, 35, 0.55);
}
.chengziMineIcon[data-active='true'] {
  border-color: #f5a623;
  background: rgba(245, 166, 35, 0.14);
}
.chengziMineTools {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 16px;
}
.chengziMineTool {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
}
.chengziMineTool input {
  accent-color: #e8732a;
}
.chengziMineStarterRow {
  display: flex;
  align-items: center;
  gap: 6px;
}
.chengziMineStarterRow .chengziMineInput {
  flex: 1;
  min-width: 0;
}
.chengziMineStarterRemove {
  flex: none;
  width: 24px;
  height: 24px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.chengziMineStarterRemove:hover {
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-primary);
}
.chengziMineConfirmText {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}

/* ── conversation.input.dock 专家身份卡 ──
 * 位置：输入条下方（用户指定）。dock 与输入条同在 composerStack 纵排容器里、
 * dock 在 DOM 序上位于输入条之前，用 flex order 把输入条提到前面——
 * 只作用我们自己的类，零上游依赖。 */
.chengziExpertsDock {
  order: 3;
  box-sizing: border-box;
  /* 与输入条同宽对齐：上游 composer 卡宽 = min(composer-card-max-width, 100%-两侧留白) */
  width: calc(100% - var(--dsh-composer-side-clearance, 16px) * 2);
  max-width: var(--dsh-composer-card-max-width, 720px);
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px 16px;
  border: 1px solid rgba(245, 166, 35, 0.35);
  border-radius: 12px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.06));
}
.chengziExpertsDockHead {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.chengziExpertsDockIcon {
  font-size: 18px;
  line-height: 1;
}
.chengziExpertsDockName {
  font-size: 14px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}
.chengziExpertsDockBadge {
  flex: none;
  padding: 1px 8px;
  border-radius: 999px;
  border: 1px solid rgba(91, 141, 239, 0.45);
  background: rgba(91, 141, 239, 0.14);
  font-size: 11px;
  line-height: 16px;
  color: var(--dsw-alias-label-secondary);
}
.chengziExpertsDockClose {
  margin-left: auto;
  flex: none;
  width: 22px;
  height: 22px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-tertiary);
  cursor: pointer;
}
.chengziExpertsDockClose:hover {
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16));
  color: var(--dsw-alias-label-primary);
}
.chengziExpertsDockDesc {
  margin: 0;
  font-size: 13px;
  line-height: 1.5;
  color: var(--dsw-alias-label-secondary);
}
.chengziExpertsCostHint {
  margin: 0;
  font-size: 12px;
  line-height: 1.5;
  color: #f5a623;
}
.chengziExpertsChips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-top: 2px;
}
.chengziExpertsChip {
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  padding: 3px 10px;
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 999px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.08));
  color: var(--dsw-alias-label-secondary);
  font-size: 12px;
  line-height: 18px;
  cursor: pointer;
}
.chengziExpertsChip:hover:not(:disabled),
.chengziExpertsChip:focus-visible {
  color: var(--dsw-alias-label-primary);
  border-color: rgba(245, 166, 35, 0.55);
}
`

export function installChengziExpertsStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = STYLE_ID
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
