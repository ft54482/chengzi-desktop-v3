/**
 * 模型选择增强：
 * 1. 直达展开——DSH 原生交互是「点模型徽标 → 一级菜单(模型 <当前名>) → 二级列表」，
 *    本模块在一级菜单出现的瞬间自动点开二级，用户点一次徽标即见全部平台模型。
 * 2. 倍率右对齐——把行显示名尾缀「 · N.NNx」拆到行最右侧（WorkBuddy 式）。
 *    只依赖行内文本、不依赖目录缓存，目录未就绪时照样生效。
 * 3. 目录富化——按 /catalog 元数据注入分组标题、厂商 logo 方块、红色免费标、按次价徽章；
 *    目录未就绪时按节律重试，就绪后对已打开的列表即时补装饰。
 * 所有注入均幂等；React 重渲染恢复原内容后由 MutationObserver 重放。
 */

/** 一级菜单项文本前缀（「模型 <当前模型显示名>」）。 */
const MODEL_MENUITEM_PREFIX = '模型'

/** 行内倍率尾缀分隔符（` · `；倍率值跟随其后）。 */
const RATIO_SEPARATOR = ' · '

/** 行内倍率尾缀（与 provider-sync 的 modelSelectorName 一致：` · N.NNx`）。
 *  后随字符不得为数字/点/x，避免误切巧合文案。 */
const RATIO_IN_TEXT = new RegExp(`${RATIO_SEPARATOR}(\\d+(?:\\.\\d+)?x)(?![\\d.x])`, 'u')

/** 目录元数据为空时的重拉节律（ms）。 */
const CATALOG_RETRY_MS = 10_000

const PICKER_STYLE_ID = 'dsh-plugin-chengzi-account/model-picker'

const PICKER_CSS = `
.chengziPickerGroup{display:flex;align-items:center;gap:8px;padding:10px 12px 4px;
  font-size:12px;font-weight:600;letter-spacing:.5px;
  color:var(--dsw-alias-label-secondary,#9aa0a6)}
.chengziPickerGroupLine{flex:1;height:1px;background:var(--dsw-alias-separator,rgba(255,255,255,.12))}
[role="radio"].chengziPickerRow{display:flex;align-items:center;gap:8px}
.chengziVendorLogo{width:18px;height:18px;flex:none;display:inline-flex;align-items:center;
  justify-content:center;border-radius:5px;font-size:10px;font-weight:700;color:#fff;object-fit:contain}
.chengziFreeTag{flex:none;margin-left:2px;padding:0 4px;border-radius:4px;font-size:11px;
  color:#e85d5d;border:1px solid rgba(232,93,93,.55)}
.chengziRatioBadge{margin-left:auto;padding-left:12px;font-size:12px;white-space:nowrap;
  opacity:.72;font-variant-numeric:tabular-nums}
`

/** 厂商 logo 渲染表（品牌色 + 单字缩写；16px 下可辨）。 */
const VENDOR_LOGOS: Readonly<Record<string, { color: string; label: string }>> = Object.freeze({
  zhipu: { color: '#3B6EFF', label: '智' },
  moonshot: { color: '#16191E', label: 'K' },
  alibaba: { color: '#615CED', label: '通' },
  minimax: { color: '#F23F5D', label: 'M' },
  deepseek: { color: '#4D6BFE', label: 'D' },
  anthropic: { color: '#D97757', label: 'C' },
  openai: { color: '#10A37F', label: 'G' },
  google: { color: '#4285F4', label: 'G' },
})

/** 分组标题文案（渲染顺序由 BFF sort 决定，组边界按 category 变化切分）。 */
const CATEGORY_LABELS: Readonly<Record<string, string>> = Object.freeze({
  free: '免费模型',
  domestic: '国内模型',
  international: '国际模型',
  image: '图像模型',
})

/** 目录行元数据（client 侧缓存；来源 host /catalog，按显示名配对行）。 */
interface CatalogMeta {
  readonly id: string
  readonly category: string
  readonly vendor: string
  readonly free: boolean
  /** 按次计费单价（元/次）；仅按次模型存在，行尾徽章展示「¥N/次」。 */
  readonly perCallPriceCny?: number
}

let catalogByName = new Map<string, CatalogMeta>()
/** 上次已上报 select-model 的模型 id；变化时才上报。 */
let lastAppliedModelId: string | undefined
let catalogPending = false
let catalogAttemptedAt = 0
let queued = false

/** 从 host 拉一次目录元数据（失败静默保留上次缓存；有变化即刷新已打开列表）。 */
function refreshCatalog(): void {
  if (catalogPending) return
  catalogPending = true
  catalogAttemptedAt = Date.now()
  void fetch('/plugins/chengzi-account/catalog', { cache: 'no-store' })
    .then(async response => (response.ok ? ((await response.json()) as { models?: unknown }) : undefined))
    .then((payload) => {
      const models = (payload)?.models
      if (!Array.isArray(models)) return
      const next = new Map<string, CatalogMeta>()
      for (const entry of models) {
        if (typeof entry !== 'object' || entry === null) continue
        const record = entry as Record<string, unknown>
        if (typeof record.id !== 'string' || record.id.length === 0) continue
        const key = typeof record.displayName === 'string' && record.displayName.length > 0
          ? record.displayName
          : record.id
        // 按次模型（quotaType=1）没有 token 倍率，modelRatio=0 不等于免费——单价走「¥N/次」徽章。
        const perCallPrice = record.quotaType === 1
          && typeof record.inputPriceCny === 'number'
          && Number.isFinite(record.inputPriceCny)
          && record.inputPriceCny >= 0
          ? record.inputPriceCny
          : undefined
        next.set(key, {
          id: record.id,
          category: typeof record.category === 'string' ? record.category : 'domestic',
          vendor: typeof record.vendor === 'string' ? record.vendor : '',
          free: record.free === true || (record.quotaType !== 1 && record.modelRatio === 0),
          ...(perCallPrice === undefined ? {} : { perCallPriceCny: perCallPrice }),
        })
      }
      if (next.size === 0) return
      const changed = next.size !== catalogByName.size
        || [...next.keys()].some(key => !catalogByName.has(key))
      catalogByName = next
      if (changed) sweep()
    })
    .catch(() => undefined)
    .finally(() => { catalogPending = false })
}

/** 目录未就绪时按节律重试（就绪后停摆；失败只推迟下一次）。 */
function ensureCatalog(): void {
  if (catalogPending || catalogByName.size > 0) return
  if (Date.now() - catalogAttemptedAt < CATALOG_RETRY_MS) return
  refreshCatalog()
}

/** 一级「模型 …」菜单项出现即自动点击，直达二级完整列表。 */
function clickThroughModelMenu(): void {
  const items = document.querySelectorAll<HTMLElement>('[role="menuitem"]')
  for (const item of items) {
    const text = item.textContent.trim()
    const rect = item.getBoundingClientRect()
    if (text.startsWith(MODEL_MENUITEM_PREFIX) && rect.width > 80 && rect.height > 0) {
      item.click()
      return
    }
  }
}

/** 厂商 logo 静态路由（host 侧白名单 exact 路由，透明 PNG）。 */
const VENDOR_LOGO_ROUTE = '/plugins/chengzi-account/vendor-logo'

/** 厂商 logo（透明 PNG；加载失败回退品牌色单字块）。 */
function vendorLogo(vendor: string): HTMLElement | null {
  const brand = Object.hasOwn(VENDOR_LOGOS, vendor) ? VENDOR_LOGOS[vendor] : undefined
  if (brand === undefined) return null
  const img = document.createElement('img')
  img.className = 'chengziVendorLogo'
  img.src = `${VENDOR_LOGO_ROUTE}/${vendor}.png`
  img.alt = ''
  img.draggable = false
  img.addEventListener('error', () => {
    const block = document.createElement('span')
    block.className = 'chengziVendorLogo'
    block.style.background = brand.color
    block.textContent = brand.label
    img.replaceWith(block)
  }, { once: true })
  return img
}

/** 行的显示名：优先用拆分时缓存的 data 标记，否则剥掉倍率尾缀。 */
function rowName(row: HTMLElement): string {
  const text = row.textContent.trim()
  const cached = row.dataset.chengziName
  if (cached !== undefined && cached.length > 0 && text.startsWith(cached)) return cached
  const match = RATIO_IN_TEXT.exec(text)
  return (match === null ? text : text.slice(0, match.index)).trim()
}

/**
 * 把行内文本的倍率尾缀拆成行最右侧徽章；无尾缀或已拆过则不动（幂等）。
 * 只截掉尾缀文本、其余节点原样保留（选中勾等嵌套内容不受影响）；
 * 徽章必须挂为行直接子节点，flex 行内 margin-left:auto 才能推到最右。
 */
function splitRatioBadge(row: HTMLElement): void {
  if (row.querySelector('.chengziRatioBadge') !== null) return
  const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT)
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const text = node.textContent ?? ''
    const match = RATIO_IN_TEXT.exec(text)
    if (match === null) continue
    // 倍率值 = 全匹配剥掉分隔符（避免对可选捕获组的索引访问）
    const ratio = match[0].slice(RATIO_SEPARATOR.length)
    const name = text.slice(0, match.index).trim()
    if (name.length === 0) return
    const tail = text.slice(match.index + match[0].length)
    node.textContent = text.slice(0, match.index)
    if (tail.length > 0) {
      node.parentNode?.insertBefore(document.createTextNode(tail), node.nextSibling)
    }
    const badge = document.createElement('span')
    badge.className = 'chengziRatioBadge'
    badge.textContent = ratio
    row.appendChild(badge)
    row.dataset.chengziName = name
    return
  }
}

/** 按次单价显示格式：两位小数去尾零（0.2→0.2、0.25→0.25、2→2）。 */
function formatPerCallPrice(price: number): string {
  return price.toFixed(2).replace(/\.?0+$/u, '')
}

/** 装饰单个模型行：倍率右拆（无目录依赖）+ 厂商 logo、红色免费标（需目录，各自幂等）。 */
function decorateRow(row: HTMLElement, meta: CatalogMeta | undefined): void {
  row.classList.add('chengziPickerRow')
  splitRatioBadge(row)
  if (meta === undefined) return
  const brand = Object.hasOwn(VENDOR_LOGOS, meta.vendor) ? VENDOR_LOGOS[meta.vendor] : undefined
  if (brand !== undefined && row.querySelector('.chengziVendorLogo') === null) {
    const logo = vendorLogo(meta.vendor)
    if (logo !== null) row.insertBefore(logo, row.firstChild)
  }
  if (meta.free && row.querySelector('.chengziFreeTag') === null) {
    const tag = document.createElement('span')
    tag.className = 'chengziFreeTag'
    tag.textContent = '免费'
    row.insertBefore(tag, row.querySelector('.chengziRatioBadge'))
  }
  if (meta.perCallPriceCny !== undefined && row.querySelector('.chengziRatioBadge') === null) {
    const badge = document.createElement('span')
    badge.className = 'chengziRatioBadge'
    badge.textContent = `¥${formatPerCallPrice(meta.perCallPriceCny)}/次`
    row.appendChild(badge)
  }
}

/** 行装饰与分组标题（meta 按显示名配对；标题插入有幂等守卫，防 sweep 重放堆积）。 */
function sweep(): void {
  clickThroughModelMenu()
  ensureCatalog()
  // 行角色是 menuitemradio（AX 树显示为 radio）；保留 radio 兜底。
  const radios = [...document.querySelectorAll<HTMLElement>('[role="menuitemradio"],[role="radio"]')]
  if (radios.length === 0) return
  let prevCategory: string | undefined
  for (const row of radios) {
    const meta = catalogByName.get(rowName(row))
    decorateRow(row, meta)
    if (meta === undefined) continue
    if (meta.category !== prevCategory
      && (row.previousElementSibling as HTMLElement | null)?.dataset.chengziGroup !== meta.category) {
      const title = document.createElement('div')
      title.className = 'chengziPickerGroup'
      title.dataset.chengziGroup = meta.category
      title.textContent = CATEGORY_LABELS[meta.category] ?? meta.category
      row.parentElement?.insertBefore(title, row)
    }
    if (row.getAttribute('aria-checked') === 'true' && lastAppliedModelId !== meta.id) {
      lastAppliedModelId = meta.id
      void fetch('/plugins/chengzi-account/select-model', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ model: meta.id }),
        cache: 'no-store',
      }).catch(() => undefined)
    }
    prevCategory = meta.category
  }
}

/** 启用模型选择增强；返回清理函数。 */
export function applyModelPickerDirectExpand(): () => void {
  if (document.querySelector(`style[data-plugin="${PICKER_STYLE_ID}"]`) === null) {
    const style = document.createElement('style')
    style.dataset.plugin = PICKER_STYLE_ID
    style.textContent = PICKER_CSS
    document.head.append(style)
  }
  ensureCatalog()
  sweep()
  const observer = new MutationObserver(() => {
    if (queued) return
    queued = true
    queueMicrotask(() => {
      queued = false
      sweep()
    })
  })
  observer.observe(document.body, { subtree: true, childList: true })
  return () => {
    observer.disconnect()
  }
}
