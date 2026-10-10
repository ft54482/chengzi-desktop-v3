/** Chengzi Pro `read_wechat_article` tool: fetches one mp.weixin.qq.com article
 *  with a real-browser header set from the DESKTOP's residential IP — WeChat's
 *  anti-crawler only challenges datacenter exits and malformed fingerprints, so
 *  the desktop path reads straight through (2026-10-11 verified: title, author,
 *  full body, and image list extracted with zero challenge pages). */

import { mkdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { defineTool } from '@deepseek-ai/dsh-tools'

/** Host allowlist: WeChat article pages only. Anything else is refused before
 *  any network I/O (SSRF discipline — the tool is a reader, not a proxy). */
const ARTICLE_HOST = 'mp.weixin.qq.com'

const MAX_RESPONSE_BYTES = 12 * 1024 * 1024
const MAX_TEXT_CHARS = 60_000
const MAX_IMAGE_BYTES = 20 * 1024 * 1024
const MAX_IMAGES = 30
const TIMEOUT_MS = 30_000

/** Real-browser header set: the UA + standard sec-ch headers are what separate
 *  a desktop read (200, full content) from a challenge page. */
function browserHeaders(): Record<string, string> {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.6',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'none',
    'Upgrade-Insecure-Requests': '1',
  }
}

/** One body image: source URL plus its workspace path when downloaded. */
interface ArticleImage {
  url: string
  localPath?: string
}

interface ParsedArticle {
  title?: string
  author?: string
  publishTime?: string
  text: string
  images: ArticleImage[]
}

/** 图片清单的行式文本（输出 schema 全标量：本工具的消费形态是展示与引用，
 *  行文本即够用且免去 DSL 数组推导的标量收敛）。 */
function imagesText(images: readonly ArticleImage[]): string {
  return images.map((image, index) =>
    `图${String(index + 1)}: ${image.localPath ?? image.url}`).join('\n')
}

function match1(html: string, pattern: RegExp): string | undefined {
  return pattern.exec(html)?.[1]?.trim() || undefined
}

/** Strip tags and collapse whitespace into plain text. */
function toText(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/giu, '')
    .replace(/<script[\s\S]*?<\/script>/giu, '')
    .replace(/<br\s*\/?>/giu, '\n')
    .replace(/<\/(p|section|div|h\d|li)>/giu, '\n')
    .replace(/<[^>]+>/gu, '')
    .replace(/&nbsp;/gu, ' ')
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/[ \t]+/gu, ' ')
    .replace(/\n{3,}/gu, '\n\n')
    .trim()
}

/** Parse one article page into structured content; image URLs come from
 *  data-src (WeChat lazy-loads every body image through it). */
export function parseArticle(html: string): ParsedArticle {
  const title = match1(html, /property="og:title" content="([^"]+)"/u)
    ?? (() => {
      const block = /<h1[^>]*rich_media_title[^>]*>([\s\S]*?)<\/h1>/u.exec(html)?.[1]
      return block === undefined ? undefined : toText(block).split('\n')[0]
    })()
  const author = match1(html, /property="og:article:author" content="([^"]+)"/u)
    ?? match1(html, /id="js_name"[^>]*>\s*([^<\s][^<]*?)\s*</u)
  const publishTime = match1(html, /var publish_time = "([^"]+)"/u)
    ?? match1(html, /property="article:published_time" content="([^"]+)"/u)
    ?? match1(html, /createTime = '([^']+)'/u)
    ?? match1(html, /"publish_time":"([^"]+)"/u)
    // WeChat embeds the publish timestamp URL-encoded inside a payload blob.
    ?? (() => {
      const unix = /publish_time%22%3A(\d{10})/u.exec(html)?.[1]
      if (unix === undefined) return undefined
      const date = new Date(Number(unix) * 1000)
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString().slice(0, 10)
    })()
  const body = /id="js_content"/u.exec(html)
  let text = ''
  const images: ArticleImage[] = []
  if (body?.index !== undefined) {
    const start = body.index
    const end = html.indexOf('</div>', html.indexOf('</div>', start) + 1)
    const segment = html.slice(start, end > start ? end : undefined)
    text = toText(segment).slice(0, MAX_TEXT_CHARS)
    for (const m of segment.matchAll(/data-src="(https:\/\/mmbiz\.qpic\.cn\/[^"]+)"/gu)) {
      if (images.length >= MAX_IMAGES) break
      const url = (m[1] ?? '').replace(/&amp;/gu, '&')
      if (url === '') continue
      if (!images.some(image => image.url === url)) images.push({ url })
    }
  }
  return {
    ...(title === undefined ? {} : { title }),
    ...(author === undefined ? {} : { author }),
    ...(publishTime === undefined ? {} : { publishTime }),
    text,
    images,
  }
}

function isArticleUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.hostname === ARTICLE_HOST && /^\/s[^/]*$/.test(url.pathname)
  } catch {
    return false
  }
}

export function defineReadWechatArticleTool() {
  return defineTool({
    name: 'read_wechat_article',
    description: [
      '读取一篇微信公众号文章（mp.weixin.qq.com）的完整内容：标题、公众号名、发布时间、正文纯文本与正文图片清单，',
      '可选把正文图片下载到会话工作区（供 PPT 配图、素材引用）。当用户粘贴公众号文章链接、要求「读一下这篇公众号文章」、',
      '或要把公众号内容作为 PPT/写作素材时调用。不支持其他站点；一次一篇。',
    ].join(''),
    parameters: {
      url: {
        type: 'string',
        required: true,
        description: '公众号文章链接（https://mp.weixin.qq.com/s/…）。',
      },
      downloadImages: {
        type: 'boolean',
        description: '是否把正文图片下载到会话工作区 wechat-images/（默认 false，只返回图片 URL 清单）。',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          status: { type: 'string', enum: ['ok', 'error'], required: true },
          url: { type: 'string', required: true },
          title: { type: 'string' },
          author: { type: 'string' },
          publishTime: { type: 'string' },
          text: { type: 'string' },
          imagesText: { type: 'string' },
          charCount: { type: 'number' },
          error: { type: 'string' },
        },
      },
      render: (_args, value) => {
        const result = value as {
          status?: string
          error?: string
          title?: string
          author?: string
          text?: string
          charCount?: number
          imagesText?: string
        }
        if (result.status === 'error') {
          return [{ type: 'text', text: `读取失败：${result.error ?? '未知错误'}` }]
        }
        const head = `${result.title ?? '（无标题）'}${result.author === undefined ? '' : ` — ${result.author}`}`
        return [{ type: 'text', text: `${head}\n\n${(result.text ?? '').slice(0, 4000)}\n\n[正文 ${String(result.charCount ?? 0)} 字]\n${result.imagesText ?? ''}` }]
      },
    },
    timeoutMs: 60_000,
    async execute(args, exec) {
      const url = typeof args.url === 'string' ? args.url.trim() : ''
      if (!isArticleUrl(url)) {
        return { status: 'error' as const, url, error: '只支持微信公众号文章链接（https://mp.weixin.qq.com/s/…）。' }
      }
      let response: Response
      try {
        response = await fetch(url, {
          headers: browserHeaders(),
          redirect: 'follow',
          signal: AbortSignal.timeout(TIMEOUT_MS),
        })
      } catch (cause) {
        return { status: 'error' as const, url, error: `网络请求失败：${cause instanceof Error ? cause.message : String(cause)}` }
      }
      if (!response.ok) {
        return { status: 'error' as const, url, error: `微信返回 HTTP ${String(response.status)}（链接可能已失效或被删除）。` }
      }
      const buffer = await response.arrayBuffer()
      if (buffer.byteLength > MAX_RESPONSE_BYTES) {
        return { status: 'error' as const, url, error: '响应超过 12MB 上限，异常页面。' }
      }
      const html = new TextDecoder('utf-8').decode(buffer)
      if (html.includes('环境异常') || html.includes('去验证')) {
        return { status: 'error' as const, url, error: '微信返回了验证页（环境异常）。请让用户在浏览器里打开该链接通过验证，或稍后重试。' }
      }
      const parsed = parseArticle(html)
      if (parsed.text.length === 0) {
        return { status: 'error' as const, url, error: '页面里没有找到正文（可能是非文章页或已被作者删除）。' }
      }
      let images: ArticleImage[] = parsed.images
      if (args.downloadImages === true && images.length > 0) {
        const cwd = exec.agent === undefined ? undefined : exec.agent.session.header.cwd
        if (cwd !== undefined && cwd.length > 0) {
          const directory = join(cwd, 'wechat-images')
          await mkdir(directory, { recursive: true })
          images = await Promise.all(images.map(async (image, index) => {
            try {
              const imageResponse = await fetch(image.url, {
                headers: { ...browserHeaders(), Referer: url },
                signal: AbortSignal.timeout(TIMEOUT_MS),
              })
              if (!imageResponse.ok) return image
              const bytes = await imageResponse.arrayBuffer()
              if (bytes.byteLength === 0 || bytes.byteLength > MAX_IMAGE_BYTES) return image
              const name = basename(new URL(image.url).pathname.split('?')[0] ?? '') || 'img'
              const localPath = join('wechat-images', `${String(index + 1).padStart(2, '0')}-${name}`)
              await writeFile(join(cwd, localPath), Buffer.from(bytes))
              return { url: image.url, localPath }
            } catch {
              return image
            }
          }))
        }
      }
      return {
        status: 'ok' as const,
        url,
        ...(parsed.title === undefined ? {} : { title: parsed.title }),
        ...(parsed.author === undefined ? {} : { author: parsed.author }),
        ...(parsed.publishTime === undefined ? {} : { publishTime: parsed.publishTime }),
        text: parsed.text,
        imagesText: imagesText(images),
        charCount: parsed.text.length,
      }
    },
  })
}
