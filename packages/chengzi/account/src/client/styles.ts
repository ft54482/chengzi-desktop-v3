const STYLE_ID = 'dsh-plugin-chengzi-account/styles'

const css = `
.chengziAccountRoot {
  display: flex;
  flex-direction: column;
  gap: 16px;
  min-width: 0;
  color: var(--dsw-alias-label-primary);
}

.chengziAccountHeader {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.chengziAccountHeader > div {
  min-width: 0;
  flex: 1;
}

.chengziAccountHeader h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.chengziAccountHeader p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}

.chengziAccountForm {
  display: flex;
  flex-direction: column;
  gap: 12px;
  max-width: 360px;
}

.chengziAccountTabs {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.16));
}

.chengziAccountTab {
  flex: 1;
  padding: 6px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--dsw-alias-label-secondary);
  font-size: 13px;
  cursor: pointer;
}

.chengziAccountTabActive {
  background: var(--dsw-alias-bg-primary, rgba(255, 255, 255, 0.12));
  color: var(--dsw-alias-label-primary);
  font-weight: 600;
}

.chengziAccountField {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.chengziAccountField label {
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}

.chengziAccountFieldRow {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.chengziAccountFieldRow > input {
  flex: 1;
  min-width: 0;
}

.chengziAccountActions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.chengziAccountFacts {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-width: 480px;
}

.chengziAccountFactRow {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 16px;
  padding: 8px 12px;
  border-radius: 8px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.08));
  font-size: 13px;
}

.chengziAccountFactRow > span:first-child {
  color: var(--dsw-alias-label-secondary);
}

.chengziAccountFactRow > span:last-child {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.chengziAccountBanner {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}

.chengziAccountNotice {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary);
}

.chengziAccountError {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--dsw-alias-status-danger, inherit);
}

.chengziAccountGate {
  position: fixed;
  inset: 0;
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--dsw-alias-bg-canvas, rgba(0, 0, 0, 0.72));
  color: var(--dsw-alias-label-primary);
}

.chengziAccountGateCard {
  width: min(380px, calc(100vw - 48px));
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 28px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-elevated, #1f2127);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
}

.chengziAccountGateCard h1 {
  margin: 0;
  font-size: 18px;
  line-height: 26px;
  font-weight: 600;
}

.chengziAccountRechargeGate {
  position: fixed;
  inset: 0;
  z-index: 1050;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(0, 0, 0, 0.45);
  color: var(--dsw-alias-label-primary, inherit);
}

.chengziAccountRechargeCard {
  width: min(480px, calc(100vw - 48px));
  max-height: calc(100vh - 48px);
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 16px;
  padding: 24px;
  border-radius: 14px;
  background: var(--dsw-alias-bg-elevated, #1f2127);
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.45);
}

.chengziAccountRechargeHeader {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.chengziAccountRechargeHeader > div {
  min-width: 0;
  flex: 1;
}

.chengziAccountRechargeHeader h2 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.chengziAccountRechargeHeader p {
  margin: 4px 0 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, inherit);
}

.chengziAccountPackageGrid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 12px;
}

.chengziAccountPackageCard {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 6px;
  padding: 14px;
  border: 1px solid var(--dsw-alias-stroke, rgba(127, 127, 127, 0.28));
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}

.chengziAccountPackageCard:hover:not(:disabled),
.chengziAccountPackageCard:focus-visible {
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.1));
  border-color: var(--dsw-alias-stroke-strong, rgba(127, 127, 127, 0.5));
}

.chengziAccountPackageName {
  font-size: 14px;
  font-weight: 600;
}

.chengziAccountPackageTokens {
  font-size: 15px;
  font-weight: 600;
}

.chengziAccountPackageBonus {
  font-size: 12px;
  color: var(--dsw-alias-label-secondary, inherit);
}

.chengziAccountPackagePrice {
  margin-top: 4px;
  font-size: 14px;
  font-weight: 700;
}

.chengziAccountPay {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 4px 0;
}

.chengziAccountPayAmount {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
}

.chengziAccountPayHint {
  margin: 0;
  font-size: 13px;
  color: var(--dsw-alias-label-secondary, inherit);
}

.chengziAccountQr {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 16px;
  border: 1px dashed var(--dsw-alias-stroke, rgba(127, 127, 127, 0.4));
  border-radius: 10px;
}

.chengziAccountQr code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 13px;
  overflow-wrap: anywhere;
  text-align: center;
}

.chengziAccountStubBadge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  border: 1px solid rgba(91, 141, 239, 0.45);
  background: rgba(91, 141, 239, 0.14);
  font-size: 12px;
  line-height: 18px;
}

.chengziAccountRechargeStatus {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  font-size: 13px;
}

.chengziAccountRechargeSuccess {
  font-weight: 600;
}

.chengziAboutStatement {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--dsw-alias-label-secondary);
}

.chengziAboutBlock {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.chengziAboutBlockLabel {
  font-size: 13px;
  font-weight: 600;
  color: var(--dsw-alias-label-primary);
}

.chengziAboutPre {
  margin: 0;
  padding: 10px 12px;
  max-height: 180px;
  overflow: auto;
  border-radius: 8px;
  background: var(--dsw-alias-fill-secondary, rgba(127, 127, 127, 0.12));
  font-size: 12px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--dsw-alias-label-secondary);
}

.chengziAboutPreTall {
  max-height: 320px;
}
`

export function installChengziAccountStyles(): () => void {
  const existing = document.querySelector<HTMLStyleElement>(`style[data-plugin="${STYLE_ID}"]`)
  if (existing !== null) return () => {}
  const style = document.createElement('style')
  style.dataset.plugin = STYLE_ID
  style.textContent = css
  document.head.append(style)
  return () => { style.remove() }
}
