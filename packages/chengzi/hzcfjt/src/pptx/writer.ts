/** 海珠城发模板 → OOXML 渲染器。
 *
 *  把 {@link SlideSpec} 页面数组渲染为最小可用但观感规范的 .pptx 包：
 *  每页由绝对定位文本框与色块构成（标题条/金色饰线/大数字卡片/章节满版底色），
 *  16:9，微软雅黑，品牌色取自客户模板主题。
 */

import { buildZip, type ZipEntry } from './zip.js'
import { HEAD_SLIDE_COUNT, headPayloadEntries, headSlideParts, loadHeadEntries } from './head.js'
import {
  BRAND,
  projectOrdinal,
  resolveSectionOrdinal,
  SLIDE_HEIGHT_EMU,
  SLIDE_WIDTH_EMU,
  type ResolvedSlide,
} from '../template/haizhu.js'

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

function emu(cm: number): number {
  return Math.round(cm * 360_000)
}

interface TextRun {
  readonly text: string
  readonly sizePt: number
  readonly color: string
  readonly bold?: boolean
}

/** 一个绝对定位文本框（支持多段落）。 */
function textBox(id: number, xCm: number, yCm: number, wCm: number, hCm: number, paragraphs: readonly TextRun[][], align: 'l' | 'ctr' = 'l', lineSpacingPt?: number): string {
  const paraXml = paragraphs.map((runs) => {
    const runXml = runs.map(run => `<a:r><a:rPr lang="zh-CN" sz="${Math.round(run.sizePt * 100)}" b="${run.bold === true ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${run.color}"/></a:solidFill><a:latin typeface="${BRAND.font}"/><a:ea typeface="${BRAND.font}"/></a:rPr><a:t>${escapeXml(run.text)}</a:t></a:r>`).join('')
    const spacing = lineSpacingPt === undefined ? '' : `<a:spcBef><a:spcPts val="${Math.round(lineSpacingPt * 100)}"/></a:spcBef>`
    return `<a:p><a:pPr algn="${align}">${spacing}</a:pPr>${runXml}</a:p>`
  }).join('')
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="文本框 ${String(id)}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(emu(xCm))}" y="${String(emu(yCm))}"/><a:ext cx="${String(emu(wCm))}" cy="${String(emu(hCm))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:noFill/></p:spPr><p:txBody><a:bodyPr wrap="square" rtlCol="0"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paraXml}</p:txBody></p:sp>`
}

/** 色块矩形。 */
function rect(id: number, xCm: number, yCm: number, wCm: number, hCm: number, color: string): string {
  return `<p:sp><p:nvSpPr><p:cNvPr id="${String(id)}" name="形状 ${String(id)}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${String(emu(xCm))}" y="${String(emu(yCm))}"/><a:ext cx="${String(emu(wCm))}" cy="${String(emu(hCm))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom><a:solidFill><a:srgbClr val="${color}"/></a:solidFill><a:ln><a:noFill/></a:ln></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="zh-CN"/></a:p></p:txBody></p:sp>`
}

function slideWrap(shapes: readonly string[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes.join('')}</p:spTree></p:cSld><p:clrMapOvr><a:overrideClrMapping bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/></p:clrMapOvr></p:sld>`
}

/** 标题条：左金饰线 + 主蓝标题（内容页通用页头）。 */
function titleHeader(shapes: string[], nextId: () => number, title: string): void {
  shapes.push(rect(nextId(), 1.0, 0.7, 0.18, 1.1, BRAND.gold))
  shapes.push(textBox(nextId(), 1.4, 0.55, 30, 1.4, [[{ text: title, sizePt: 26, color: BRAND.primary, bold: true }]]))
}

let autoId = 100
function nextId(): number {
  autoId += 1
  return autoId
}

/** 从字节流嗅探像素尺寸（PNG IHDR / JPEG SOF）。 */
export function imageSize(bytes: Buffer, ext: 'png' | 'jpg'): { readonly w: number; readonly h: number } {
  if (ext === 'png' && bytes.length >= 24 && bytes.subarray(12, 16).toString('latin1') === 'IHDR') {
    return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) }
  }
  if (ext === 'jpg') {
    let off = 2
    while (off + 9 < bytes.length) {
      if (bytes[off] !== 0xff) {
        off += 1
        continue
      }
      const marker = bytes[off + 1]
      if (marker === undefined) break
      if (marker === 0xd8 || (marker >= 0xd0 && marker <= 0xd9)) {
        off += 2
        continue
      }
      const len = bytes.readUInt16BE(off + 2)
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        return { w: bytes.readUInt16BE(off + 7), h: bytes.readUInt16BE(off + 5) }
      }
      off += 2 + len
    }
  }
  return { w: 0, h: 0 }
}

/** contain-fit：把像素图按比例放进厘米盒内并居中。 */
function fitImage(
  boxXCm: number,
  boxYCm: number,
  boxWCm: number,
  boxHCm: number,
  wPx: number,
  hPx: number,
): { x: number; y: number; w: number; h: number } {
  if (wPx <= 0 || hPx <= 0) return { x: boxXCm, y: boxYCm, w: boxWCm, h: boxHCm }
  const imgWCm = (wPx / 96) * 2.54
  const imgHCm = (hPx / 96) * 2.54
  const scale = Math.min(boxWCm / imgWCm, boxHCm / imgHCm)
  const w = imgWCm * scale
  const h = imgHCm * scale
  return { x: boxXCm + (boxWCm - w) / 2, y: boxYCm + (boxHCm - h) / 2, w, h }
}

/** 嵌入图片（p:pic）；rId 由调用方按该 slide 的 rels 分配。 */
function picture(
  id: number,
  image: { readonly rId: string; readonly w: number; readonly h: number },
  boxXCm: number,
  boxYCm: number,
  boxWCm: number,
  boxHCm: number,
): string {
  const fit = fitImage(boxXCm, boxYCm, boxWCm, boxHCm, image.w, image.h)
  return `<p:pic><p:nvPicPr><p:cNvPr id="${String(id)}" name="图片 ${String(id)}"/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${image.rId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr><a:xfrm><a:off x="${String(emu(fit.x))}" y="${String(emu(fit.y))}"/><a:ext cx="${String(emu(fit.w))}" cy="${String(emu(fit.h))}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`
}

/** 渲染单页为 slide XML 字符串。image 为该页已注册的媒体引用（可选）。 */
export function renderSlide(
  page: ResolvedSlide,
  sectionIndex: number,
  projectIndex: number,
  image?: { readonly rId: string; readonly w: number; readonly h: number },
): string {
  const shapes: string[] = []
  switch (page.type) {
    case 'cover': {
      shapes.push(rect(nextId(), 0, 0, 33.87, 19.05, BRAND.primary))
      if (image !== undefined) {
        shapes.push(picture(nextId(), image, 20.9, 0, 12.97, 19.05))
        shapes.push(rect(nextId(), 0, 12.2, 20.4, 0.25, BRAND.gold))
        shapes.push(textBox(nextId(), 1.2, 7.6, 18.2, 3.2, [[{ text: page.title, sizePt: 38, color: BRAND.white, bold: true }]], 'ctr'))
        if (page.subtitle !== undefined) {
          shapes.push(textBox(nextId(), 1.2, 11.0, 18.2, 1.6, [[{ text: page.subtitle, sizePt: 16, color: BRAND.lightBlue }]], 'ctr'))
        }
      } else {
        shapes.push(rect(nextId(), 0, 12.2, 33.87, 0.25, BRAND.gold))
        shapes.push(textBox(nextId(), 2.5, 7.2, 28.8, 3.2, [[{ text: page.title, sizePt: 44, color: BRAND.white, bold: true }]], 'ctr'))
        if (page.subtitle !== undefined) {
          shapes.push(textBox(nextId(), 2.5, 10.8, 28.8, 1.6, [[{ text: page.subtitle, sizePt: 18, color: BRAND.lightBlue }]], 'ctr'))
        }
      }
      break
    }
    case 'section': {
      shapes.push(rect(nextId(), 0, 0, 33.87, 19.05, BRAND.primary))
      shapes.push(rect(nextId(), 4.2, 8.4, 0.3, 2.4, BRAND.gold))
      shapes.push(textBox(nextId(), 4.9, 7.6, 25, 3.6, [
        [{ text: `${resolveSectionOrdinal(page.title, sectionIndex)}${page.title}`, sizePt: 40, color: BRAND.white, bold: true }],
        ...(page.subtitle === undefined ? [] : [[{ text: page.subtitle, sizePt: 16, color: BRAND.lightBlue }]] as readonly TextRun[][]),
      ]))
      break
    }
    case 'bullets': {
      titleHeader(shapes, nextId, page.title)
      let y = 2.6
      for (const bullet of page.bullets) {
        shapes.push(rect(nextId(), 1.2, y + 0.25, 0.12, 0.5, BRAND.gold))
        if (bullet.head !== undefined) {
          shapes.push(textBox(nextId(), 1.7, y, 30.5, 1.0, [[{ text: bullet.head, sizePt: 15, color: BRAND.primary, bold: true }]]))
          shapes.push(textBox(nextId(), 1.7, y + 0.85, 30.5, 2.6, [[{ text: bullet.text, sizePt: 12.5, color: BRAND.text }]]))
          y += 1.1 + Math.min(2.6, Math.ceil(bullet.text.length / 55) * 0.75)
        } else {
          shapes.push(textBox(nextId(), 1.7, y, 30.5, 1.4, [[{ text: bullet.text, sizePt: 13.5, color: BRAND.text }]]))
          y += 1.5
        }
        if (y > 17.5) break
      }
      break
    }
    case 'stats': {
      titleHeader(shapes, nextId, page.title)
      const columns = page.stats.length <= 3 ? page.stats.length : page.stats.length <= 6 ? 3 : 4
      const rows = Math.ceil(page.stats.length / columns)
      const cardW = 30.5 / columns
      const cardH = Math.min(5.2, 15.2 / rows)
      for (const [index, stat] of page.stats.entries()) {
        const col = index % columns
        const row = Math.floor(index / columns)
        const x = 1.7 + col * (cardW + 0.5)
        const y = 3.0 + row * (cardH + 0.6)
        shapes.push(rect(nextId(), x, y, cardW, cardH, BRAND.lightBlue))
        shapes.push(textBox(nextId(), x + 0.3, y + cardH * 0.14, cardW - 0.6, cardH * 0.5, [[{ text: stat.value, sizePt: 30, color: BRAND.primary, bold: true }]], 'ctr'))
        shapes.push(textBox(nextId(), x + 0.3, y + cardH * 0.62, cardW - 0.6, cardH * 0.34, [[{ text: stat.label, sizePt: 12, color: BRAND.text }]], 'ctr'))
      }
      break
    }
    case 'table': {
      titleHeader(shapes, nextId, page.title)
      if (page.note !== undefined) {
        shapes.push(textBox(nextId(), 1.4, 1.85, 30, 0.7, [[{ text: page.note, sizePt: 11, color: BRAND.text }]]))
      }
      const lines: TextRun[][] = [
        page.headers.map(head => ({ text: head, sizePt: 13, color: BRAND.white, bold: true })),
        ...page.rows.map(row => row.map(cell => ({ text: cell, sizePt: 12, color: BRAND.text }))),
      ]
      let y = 2.7
      for (const [index, line] of lines.entries()) {
        if (index % 2 === 0) shapes.push(rect(nextId(), 1.4, y - 0.08, 31, 0.85, index === 0 ? BRAND.primary : BRAND.lightBlue))
        shapes.push(textBox(nextId(), 1.6, y, 30.6, 0.75, [line]))
        y += 0.92
        if (y > 18.3) break
      }
      break
    }
    case 'company': {
      titleHeader(shapes, nextId, `${page.track}：${page.name}`)
      const textW = image !== undefined ? 19.5 : 30.5
      let y = 2.4
      const blocks: readonly { readonly head: string; readonly body: readonly string[] }[] = [
        { head: '企业简介', body: [page.profile] },
        { head: '亮点优势', body: page.highlights },
        { head: '主要产品', body: page.products.map(product => `${product.name}：${product.text}`) },
        ...(page.progress === undefined ? [] : [{
          head: '项目进度',
          body: [
            ...(page.progress.zhaoshang === undefined ? [] : [`招商进展：${page.progress.zhaoshang}`]),
            ...(page.progress.touzi === undefined ? [] : [`投资进展：${page.progress.touzi}`]),
          ],
        }]),
        { head: '财务情况', body: page.finance },
      ]
      for (const block of blocks) {
        if (block.body.length === 0) continue
        shapes.push(rect(nextId(), 1.2, y + 0.18, 0.12, 0.5, BRAND.gold))
        shapes.push(textBox(nextId(), 1.7, y, textW, 0.85, [[{ text: block.head, sizePt: 15, color: BRAND.primary, bold: true }]]))
        y += 0.85
        for (const line of block.body) {
          const lineCm = Math.min(3.4, Math.max(0.7, Math.ceil(line.length / (textW > 20 ? 58 : 38)) * 0.68))
          shapes.push(textBox(nextId(), 1.7, y, textW, lineCm, [[{ text: line, sizePt: 11.5, color: BRAND.text }]]))
          y += lineCm + 0.18
        }
        y += 0.3
        if (y > 17.6) break
      }
      if (image !== undefined) {
        shapes.push(rect(nextId(), 22.2, 2.4, 10.2, 14.8, BRAND.lightBlue))
        shapes.push(picture(nextId(), image, 22.4, 2.7, 9.8, 14.2))
      }
      break
    }
    case 'image': {
      if (page.title !== undefined) titleHeader(shapes, nextId, page.title)
      const boxY = page.title === undefined ? 1.6 : 2.6
      const boxH = page.title === undefined ? 16.2 : 15.2
      if (image !== undefined) {
        shapes.push(picture(nextId(), image, 1.7, boxY, 30.5, boxH))
      }
      if (page.caption !== undefined) {
        shapes.push(textBox(nextId(), 1.7, boxY + boxH + 0.3, 30.5, 0.9, [[{ text: page.caption, sizePt: 11.5, color: BRAND.text }]], 'ctr'))
      }
      break
    }
    case 'project': {
      titleHeader(shapes, nextId, `${projectOrdinal(projectIndex)} ${page.name}`)
      const textW = image !== undefined ? 19.5 : 30.5
      shapes.push(textBox(nextId(), 1.7, 2.4, textW, 0.9, [[{ text: '项目概况', sizePt: 15, color: BRAND.primary, bold: true }]]))
      const fields: readonly { readonly label: string; readonly value: string }[] = [
        { label: '地理位置', value: page.overview.location },
        { label: '地块情况', value: page.overview.plot },
        { label: '项目规划', value: page.overview.plan },
        { label: '建设计划', value: page.overview.schedule },
      ]
      let y = 3.3
      for (const field of fields) {
        shapes.push(rect(nextId(), 1.7, y + 0.06, 2.6, 0.62, BRAND.lightBlue))
        shapes.push(textBox(nextId(), 1.78, y + 0.08, 2.5, 0.6, [[{ text: field.label, sizePt: 11, color: BRAND.primary, bold: true }]], 'ctr'))
        const valueCm = Math.min(2.7, Math.max(0.68, Math.ceil(field.value.length / (textW > 20 ? 55 : 36)) * 0.66))
        shapes.push(textBox(nextId(), 4.6, y, textW - 2.9, valueCm, [[{ text: field.value, sizePt: 11.5, color: BRAND.text }]]))
        y += Math.max(0.95, valueCm + 0.24)
      }
      shapes.push(textBox(nextId(), 1.7, y + 0.35, textW, 0.9, [[{ text: '产业定位', sizePt: 15, color: BRAND.primary, bold: true }]]))
      const positioningCm = Math.min(4.2, Math.max(1.4, Math.ceil(page.positioning.length / (textW > 20 ? 58 : 38)) * 0.68))
      shapes.push(textBox(nextId(), 1.7, y + 1.25, textW, positioningCm, [[{ text: page.positioning, sizePt: 11.5, color: BRAND.text }]]))
      if (image !== undefined) {
        shapes.push(rect(nextId(), 22.2, 3.3, 10.2, 13.6, BRAND.lightBlue))
        shapes.push(picture(nextId(), image, 22.4, 3.6, 9.8, 13.0))
      }
      break
    }
    case 'timeline': {
      titleHeader(shapes, nextId, page.title)
      let y = 2.6
      for (const item of page.items) {
        shapes.push(rect(nextId(), 1.2, y + 0.18, 3.1, 0.62, BRAND.lightBlue))
        shapes.push(textBox(nextId(), 1.28, y + 0.2, 3.0, 0.6, [[{ text: item.date, sizePt: 10.5, color: BRAND.primary, bold: true }]], 'ctr'))
        shapes.push(textBox(nextId(), 4.6, y, 27.6, 1.2, [[{ text: item.event, sizePt: 12, color: BRAND.text }]]))
        y += Math.max(1.35, Math.ceil(item.event.length / 55) * 0.75 + 0.6)
        if (y > 17.6) break
      }
      break
    }
    case 'end': {
      shapes.push(rect(nextId(), 0, 0, 33.87, 19.05, BRAND.primary))
      shapes.push(textBox(nextId(), 2.5, 8.2, 28.8, 2.6, [[{ text: page.title ?? '感谢聆听', sizePt: 40, color: BRAND.white, bold: true }]], 'ctr'))
      break
    }
  }
  return slideWrap(shapes)
}

const THEME_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" name="hzcfjt"><a:themeElements><a:clrScheme name="hzcfjt"><a:dk1><a:srgbClr val="2D3847"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1><a:dk2><a:srgbClr val="2B579A"/></a:dk2><a:lt2><a:srgbClr val="BBD8F6"/></a:lt2><a:accent1><a:srgbClr val="2B579A"/></a:accent1><a:accent2><a:srgbClr val="296EB1"/></a:accent2><a:accent3><a:srgbClr val="5C8CBA"/></a:accent3><a:accent4><a:srgbClr val="64A1D7"/></a:accent4><a:accent5><a:srgbClr val="BBD8F6"/></a:accent5><a:accent6><a:srgbClr val="D1B15A"/></a:accent6><a:hlink><a:srgbClr val="4BD1FB"/></a:hlink><a:folHlink><a:srgbClr val="800080"/></a:folHlink></a:clrScheme><a:fontScheme name="hzcfjt"><a:majorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:majorFont><a:minorFont><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/><a:cs typeface=""/></a:minorFont></a:fontScheme><a:fmtScheme name="hzcfjt"><a:fillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:fillStyleLst><a:lnStyleLst><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln><a:ln><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln></a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:bgFillStyleLst></a:fmtScheme></a:themeElements></a:theme>'

const SLIDE_MASTER_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldMaster xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main"><p:cSld><p:bg><p:bgPr><a:solidFill><a:srgbClr val="FFFFFF"/></a:solidFill><a:effectLst/></p:bgPr></p:bg><p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree></p:cSld><p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/><p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle><a:lvl1pPr><a:defRPr sz="2600" b="1"><a:solidFill><a:srgbClr val="2B579A"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:defRPr></a:lvl1pPr></p:titleStyle><p:bodyStyle><a:lvl1pPr><a:defRPr sz="1300"><a:solidFill><a:srgbClr val="2D3847"/></a:solidFill><a:latin typeface="微软雅黑"/><a:ea typeface="微软雅黑"/></a:defRPr></a:lvl1pPr></p:bodyStyle><p:otherStyle><a:lvl1pPr><a:defRPr/></a:lvl1pPr></p:otherStyle></p:txStyles></p:sldMaster>'

const SLIDE_LAYOUT_XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:sldLayout xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" type="blank" preserve="1"><p:cSld name="空白"/><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>'

/**
 * 渲染整份 deck 为 pptx 字节流：前 6 页（封面 + 一、整体概况）为客户审定原版部件
 * 逐字节注入（logo 完全一致），动态章节从第 7 页追加，挂自有母版 slideMaster90。
 * @param topic - 报告主题（进入文档属性 title）。
 * @param pages - 经校验的动态页面数组（第 7 页起，可携带 __img 配图数据）。
 */
export function renderDeck(topic: string, pages: readonly ResolvedSlide[]): Buffer {
  const media: { readonly name: string; readonly data: Buffer; readonly ext: string }[] = []
  const mediaByPath = new Map<string, { readonly rId: string; readonly w: number; readonly h: number; readonly file: string }>()
  const perSlideImages: ({ readonly rId: string; readonly w: number; readonly h: number; readonly file: string } | undefined)[] = []
  const slideXmls = pages.map((page, index) => {
    const sectionIndex = pages.slice(0, index).filter(candidate => candidate.type === 'section').length
    const projectIndex = pages.slice(0, index).filter(candidate => candidate.type === 'project').length
    let image: { readonly rId: string; readonly w: number; readonly h: number; readonly file: string } | undefined
    if (page.__img !== undefined && typeof page.__img.source === 'string' && page.__img.source.length > 0) {
      const existing = mediaByPath.get(page.__img.source)
      if (existing !== undefined) {
        image = existing
      } else {
        // 自有配图用 gen-image 前缀，避开头部资产原样的 ppt/media/imageN.*
        const file = `gen-image${String(media.length + 1)}.${page.__img.ext}`
        media.push({ name: `ppt/media/${file}`, data: page.__img.bytes, ext: page.__img.ext })
        const rId = 'rIdImg' + String(media.length)
        const size = imageSize(page.__img.bytes, page.__img.ext)
        const registered = { rId, w: size.w, h: size.h, file }
        mediaByPath.set(page.__img.source, registered)
        image = registered
      }
    }
    perSlideImages.push(image)
    return renderSlide(page, sectionIndex, projectIndex, image)
  })
  const totalSlides = HEAD_SLIDE_COUNT + slideXmls.length
  const headSlides = headSlideParts()

  // ── 头部资产：原样部件 + [Content_Types] 的 Default/Override 底料 + 包级 rels ──
  const headEntries = headPayloadEntries()
  const headAll = loadHeadEntries()
  const headContentTypes = headAll.find(entry => entry.name === '[Content_Types].xml')?.data.toString('utf8') ?? ''
  const headDefaults = [...headContentTypes.matchAll(/<Default\s[^>]*\/>/g)].map(m => m[0])
  // 头部部件的 Override 原样保留（presentation/masters/layouts/themes/notes 等），动态件再追加
  const headOverrides = [...headContentTypes.matchAll(/<Override\s[^>]*\/>/g)].map(m => m[0])
    .filter(tag => !tag.includes('/ppt/slides/slide'))
  const headRels = headAll.find(entry => entry.name === '_rels/.rels')?.data
  if (headRels === undefined) throw new Error('head asset missing _rels/.rels')

  const slideOverrides = slideXmls
    .map((_xml, index) => `<Override PartName="/ppt/slides/slide${String(HEAD_SLIDE_COUNT + index + 1)}.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('')
  const headSlideOverrides = headSlides
    .map(part => `<Override PartName="/${part}" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>`)
    .join('')
  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${headDefaults.join('')}${headOverrides.join('')}${headSlideOverrides}${slideOverrides}<Override PartName="/ppt/slideMasters/slideMaster90.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"/><Override PartName="/ppt/slideLayouts/slideLayout90.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"/><Override PartName="/ppt/theme/theme90.xml" ContentType="application/vnd.openxmlformats-officedocument.theme+xml"/></Types>`

  const entries: ZipEntry[] = []
  entries.push({ name: '[Content_Types].xml', data: Buffer.from(contentTypes) })
  entries.push({ name: '_rels/.rels', data: headRels })
  entries.push({ name: 'docProps/core.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${escapeXml(topic)}</dc:title><dc:creator>橙子PRO</dc:creator><cp:lastModifiedBy>橙子PRO</cp:lastModifiedBy></cp:coreProperties>`) })
  entries.push({ name: 'docProps/app.xml', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>橙子PRO</Application><Slides>${String(totalSlides)}</Slides><Company>海珠城发集团</Company></Properties>`) })

  // ── presentation.xml：头部两个母版 + 自有母版 90；sldIdLst = 前 6 原版 + 动态 ──
  const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
  const relEntries = [
    { id: 'rId1', type: `${R}/slideMaster`, target: 'slideMasters/slideMaster1.xml' },
    { id: 'rId2', type: `${R}/slideMaster`, target: 'slideMasters/slideMaster3.xml' },
    { id: 'rId3', type: `${R}/slideMaster`, target: 'slideMasters/slideMaster90.xml' },
    { id: 'rId4', type: `${R}/notesMaster`, target: 'notesMasters/notesMaster1.xml' },
    { id: 'rId5', type: `${R}/handoutMaster`, target: 'handoutMasters/handoutMaster1.xml' },
    { id: 'rId6', type: `${R}/theme`, target: 'theme/theme1.xml' },
    { id: 'rId7', type: `${R}/theme`, target: 'theme/theme3.xml' },
    { id: 'rId8', type: `${R}/theme`, target: 'theme/theme90.xml' },
    { id: 'rId9', type: `${R}/presProps`, target: 'presProps.xml' },
    { id: 'rId10', type: `${R}/viewProps`, target: 'viewProps.xml' },
    { id: 'rId11', type: `${R}/tableStyles`, target: 'tableStyles.xml' },
    { id: 'rId12', type: `${R}/commentAuthors`, target: 'commentAuthors.xml' },
    { id: 'rId13', type: `${R}/tags`, target: 'tags/tag279.xml' },
    ...headSlides.map((part, index) => ({ id: `rId${String(30 + index)}`, type: `${R}/slide`, target: part.replace(/^ppt\//, '') })),
    ...slideXmls.map((_xml, index) => ({ id: `rId${String(30 + HEAD_SLIDE_COUNT + index)}`, type: `${R}/slide`, target: `slides/slide${String(HEAD_SLIDE_COUNT + index + 1)}.xml` })),
  ]
  const sldIds = [...Array(totalSlides).keys()]
    .map(index => `<p:sldId id="${String(256 + index)}" r:id="rId${String(30 + index)}"/>`)
    .join('')
  entries.push({
    name: 'ppt/presentation.xml',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><p:presentation xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" saveSpecialPlsOnTitleSld="0"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/><p:sldMasterId id="2147483671" r:id="rId2"/><p:sldMasterId id="2147483690" r:id="rId3"/></p:sldMasterIdLst><p:notesMasterIdLst><p:notesMasterId r:id="rId4"/></p:notesMasterIdLst><p:handoutMasterIdLst><p:handoutMasterId r:id="rId5"/></p:handoutMasterIdLst><p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${String(SLIDE_WIDTH_EMU)}" cy="${String(SLIDE_HEIGHT_EMU)}"/><p:notesSz cx="${String(SLIDE_HEIGHT_EMU)}" cy="${String(SLIDE_WIDTH_EMU)}"/><p:defaultTextStyle/></p:presentation>`),
  })
  entries.push({
    name: 'ppt/_rels/presentation.xml.rels',
    data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${relEntries.map(e => `<Relationship Id="${e.id}" Type="${e.type}" Target="${e.target}"/>`).join('')}</Relationships>`),
  })

  // ── 自有母版三件套（编号 90 避开头部资产的原名） ──
  entries.push({ name: 'ppt/slideMasters/slideMaster90.xml', data: Buffer.from(SLIDE_MASTER_XML) })
  entries.push({ name: 'ppt/slideMasters/_rels/slideMaster90.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout90.xml"/><Relationship Id="rId2" Type="${R}/theme" Target="../theme/theme90.xml"/></Relationships>`) })
  entries.push({ name: 'ppt/slideLayouts/slideLayout90.xml', data: Buffer.from(SLIDE_LAYOUT_XML) })
  entries.push({ name: 'ppt/slideLayouts/_rels/slideLayout90.xml.rels', data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideMaster" Target="../slideMasters/slideMaster90.xml"/></Relationships>`) })
  entries.push({ name: 'ppt/theme/theme90.xml', data: Buffer.from(THEME_XML) })

  // ── 头部原样部件（slides/media/layouts/masters/themes/...）与动态页 ──
  for (const entry of headEntries) entries.push(entry)
  for (const medium of media) {
    entries.push({ name: medium.name, data: medium.data })
  }
  for (const [index, xml] of slideXmls.entries()) {
    const slideNo = HEAD_SLIDE_COUNT + index + 1
    entries.push({ name: `ppt/slides/slide${String(slideNo)}.xml`, data: Buffer.from(xml) })
    // 每张 slide 必须自带 rels 绑定版式与配图——缺失会被 python-pptx/PowerPoint 判「布局引用损坏」。
    const image = perSlideImages[index]
    const imageRel = image === undefined
      ? ''
      : `<Relationship Id="${image.rId}" Type="${R}/image" Target="../media/${image.file}"/>`
    entries.push({ name: `ppt/slides/_rels/slide${String(slideNo)}.xml.rels`, data: Buffer.from(`<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/slideLayout" Target="../slideLayouts/slideLayout90.xml"/>${imageRel}</Relationships>`) })
  }
  return buildZip(entries)
}
