/** 客户审定的「固定头部」资产：原版 PPT 前 6 页（封面 + 一、整体概况）。
 *
 *  资产 `assets/hzcfjt-head.pptx` 由原版《20260703新-海珠城发集团企业简介详细.pptx》
 *  精简而来：slide1-6 及其引用的 layout/master/theme/media 逐字节保留（logo 完全一致），
 *  仅母版级 rels/presentation 做过手术。生成时这些部件原样注入产物，动态章节从第 7 页追加。
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readZip, type ZipEntry } from './zip.js'

/** 固定头部的页数。 */
export const HEAD_SLIDE_COUNT = 6

/** 头部资产里会被重新组装替代、不原样注入的部件。 */
const REBUILT_PARTS = new Set([
  '[Content_Types].xml',
  '_rels/.rels',
  'docProps/app.xml',
  'docProps/core.xml',
  'ppt/presentation.xml',
  'ppt/_rels/presentation.xml.rels',
])

/** 本模块编译产物所在目录（tsdown 打包为单文件 lib/index.js，故即 lib/；
 *  源码/测试直跑时为 src/pptx/）。 */
const MODULE_DIR = dirname(fileURLToPath(import.meta.url))

/** 逐级向上枚举祖先目录（含起点，封顶 8 级）——布局无关的资源定位用。 */
function* ancestors(from: string): Generator<string> {
  let current = from
  for (let depth = 0; depth < 8; depth++) {
    yield current
    const parent = dirname(current)
    if (parent === current) return
    current = parent
  }
}

/** 头部资产路径：从编译产物逐级向上找最近的 assets/hzcfjt-head.pptx。
 *  打包=包根 assets/（package.json files 随包携带），开发/测试=包根 assets/，
 *  两种布局同一套走查逻辑，与 chengzi-account 的 logo 资源定位同机制。 */
function resolveHeadAssetPath(): string {
  for (const dir of ancestors(MODULE_DIR)) {
    const candidate = join(dir, 'assets', 'hzcfjt-head.pptx')
    if (existsSync(candidate)) return candidate
  }
  return join(MODULE_DIR, 'assets', 'hzcfjt-head.pptx')
}

let cached: readonly ZipEntry[] | undefined

/** 读取并缓存头部资产包（原样部件，含 slides/media）。 */
export function loadHeadEntries(): readonly ZipEntry[] {
  if (cached === undefined) {
    const assetPath = resolveHeadAssetPath()
    try {
      cached = readZip(readFileSync(assetPath))
    } catch (cause) {
      throw new Error(`hzcfjt 固定头部资产缺失或不可读：${assetPath}`, { cause })
    }
  }
  return cached
}

/** 头部资产里原样注入的部件（排除重建件）。 */
export function headPayloadEntries(): readonly ZipEntry[] {
  return loadHeadEntries().filter(entry => !REBUILT_PARTS.has(entry.name))
}

/** 头部里固定不变的 6 张 slide 部件名（sldIdLst 顺序）。 */
export function headSlideParts(): readonly string[] {
  return Array.from({ length: HEAD_SLIDE_COUNT }, (_unused, index) => `ppt/slides/slide${String(index + 1)}.xml`)
}
