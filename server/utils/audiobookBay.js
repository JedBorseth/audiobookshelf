const axios = require('axios')
const Logger = require('../Logger')

const DEFAULT_UA = 'Mozilla/5.0 (compatible; Audiobookshelf/1.0; +https://github.com/advplyr/audiobookshelf)'

/**
 * @param {string} baseUrl origin e.g. https://audiobookbay.lu
 * @returns {URL}
 */
function parseBase(baseUrl) {
  return new URL(baseUrl)
}

/**
 * @param {string} baseUrl
 * @param {string} pathOrUrl path starting with / or full URL string
 * @returns {URL}
 */
function resolveAbbUrl(baseUrl, pathOrUrl) {
  const base = parseBase(baseUrl)
  let resolved
  if (pathOrUrl.startsWith('http://') || pathOrUrl.startsWith('https://')) {
    resolved = new URL(pathOrUrl)
  } else {
    const path = pathOrUrl.startsWith('/') ? pathOrUrl : `/${pathOrUrl}`
    resolved = new URL(path, base.origin)
  }
  if (resolved.protocol !== 'https:') {
    throw new Error('Invalid URL protocol')
  }
  if (resolved.hostname !== base.hostname) {
    throw new Error('URL host not allowed')
  }
  return resolved
}

/**
 * @param {string} baseUrl
 * @param {string} fetchUrl full https URL on same host as base
 */
async function fetchAbbHtml(baseUrl, fetchUrl) {
  const base = parseBase(baseUrl)
  const target = new URL(fetchUrl)
  if (target.hostname !== base.hostname) {
    throw new Error('Host not allowed')
  }
  const res = await axios.get(target.toString(), {
    timeout: 30000,
    headers: {
      'User-Agent': DEFAULT_UA,
      Accept: 'text/html,application/xhtml+xml'
    },
    validateStatus: (s) => s >= 200 && s < 400
  })
  if (typeof res.data !== 'string') {
    throw new Error('Unexpected response')
  }
  return res.data
}

/**
 * @param {string} html
 * @returns {{ path: string, title: string, infoLine?: string, coverUrl?: string }[]}
 */
function parseListings(html) {
  const items = []
  const parts = html.split(/<div class="post">/i)
  for (let i = 1; i < parts.length; i++) {
    const block = parts[i]
    const titleMatch = block.match(/<div class="postTitle">\s*<h2>\s*<a href="([^"]+)"[^>]*>([^<]*)<\/a>/i)
    if (!titleMatch) continue
    let path
    try {
      const u = new URL(titleMatch[1], 'https://example.com')
      path = u.pathname + (u.search || '')
    } catch {
      path = titleMatch[1].startsWith('/') ? titleMatch[1] : `/${titleMatch[1]}`
    }
    const title = decodeHtmlEntities(titleMatch[2].trim())
    const infoMatch = block.match(/<div class="postInfo">([\s\S]*?)<\/div>/i)
    const infoLine = infoMatch ? decodeHtmlEntities(stripTags(infoMatch[1]).replace(/\s+/g, ' ').trim()) : undefined
    const imgMatch = block.match(/<img[^>]+src="([^"]+)"/i)
    const coverUrl = imgMatch ? imgMatch[1] : undefined
    items.push({ path, title, infoLine, coverUrl })
  }
  return items
}

/**
 * @param {string} html
 * @param {number} page 1-based current page
 * @param {string} [searchQuery]
 */
function hasNextPage(html, page, searchQuery) {
  const next = page + 1
  if (searchQuery && String(searchQuery).trim()) {
    return new RegExp(`<a[^>]+href=["']/page/${next}/\\?s=`, 'i').test(html)
  }
  return new RegExp(`<a[^>]+href=["']/page/${next}/["']`, 'i').test(html)
}

function stripTags(s) {
  return s.replace(/<[^>]+>/g, ' ')
}

function decodeHtmlEntities(str) {
  return str
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
}

/**
 * @param {string} html
 * @returns {{ title: string, infoHash: string, magnet: string, coverUrl?: string, descriptionText?: string }}
 */
function parseDetail(html) {
  const titleMatch = html.match(/<div class="postTitle">\s*<h1[^>]*>([^<]+)<\/h1>/i)
  const title = titleMatch ? decodeHtmlEntities(titleMatch[1].trim()) : ''

  const hashMatch = html.match(/<td>Info Hash:<\/td>\s*<td>([a-f0-9]{40})<\/td>/i)
  if (!hashMatch) {
    Logger.warn(`[audiobookBay] No info hash in detail page`)
    throw new Error('Could not find torrent info hash on this page')
  }
  const infoHash = hashMatch[1].toLowerCase()

  const trackers = []
  const trRegex = /<td>Tracker:<\/td>\s*<td>([^<]+)<\/td>/gi
  let tm
  while ((tm = trRegex.exec(html)) !== null) {
    const tr = tm[1].trim()
    if (tr) trackers.push(tr)
  }

  const magnet = buildMagnetUri(infoHash, title, trackers)

  const imgMatch = html.match(/<div class="postContent"[^>]*>[\s\S]*?<img[^>]+src="([^"]+)"[^>]*itemprop="image"/i)
  const imgMatch2 = !imgMatch ? html.match(/<div class="postContent"[\s\S]*?<img[^>]+src="([^"]+)"/i) : null
  const coverUrl = imgMatch ? imgMatch[1] : imgMatch2 ? imgMatch2[1] : undefined

  const descMatch = html.match(/<div class="desc"[^>]*>([\s\S]*?)<\/div>/i)
  const descriptionText = descMatch ? stripTags(descMatch[1]).replace(/\s+/g, ' ').trim().slice(0, 2000) : undefined

  return { title, infoHash, magnet, coverUrl, descriptionText }
}

/**
 * @param {string} infoHash
 * @param {string} name
 * @param {string[]} trackers
 */
function buildMagnetUri(infoHash, name, trackers) {
  // Real-Debrid and most clients expect canonical magnets: xt=urn:btih:<hash> with
  // literal colons — not xt=urn%3Abtih%3A... (URLSearchParams encodes those).
  const parts = [`xt=urn:btih:${infoHash}`]
  if (name) {
    const dn = String(name).slice(0, 300)
    parts.push(`dn=${encodeURIComponent(dn)}`)
  }
  const maxTrackers = 16
  let n = 0
  for (const tr of trackers) {
    if (!tr || n >= maxTrackers) break
    parts.push(`tr=${encodeURIComponent(tr)}`)
    n++
  }
  return `magnet:?${parts.join('&')}`
}

/**
 * @param {string} baseUrl
 * @param {{ q?: string, page?: number }} opts
 */
function buildListPageUrl(baseUrl, opts) {
  const base = parseBase(baseUrl)
  const page = Math.max(1, Number(opts.page) || 1)
  const q = (opts.q || '').trim()

  if (q) {
    const s = encodeURIComponent(q)
    if (page <= 1) {
      return new URL(`/?s=${s}`, base.origin)
    }
    return new URL(`/page/${page}/?s=${s}`, base.origin)
  }

  if (page <= 1) {
    return new URL('/', base.origin)
  }
  return new URL(`/page/${page}/`, base.origin)
}

module.exports = {
  parseBase,
  resolveAbbUrl,
  fetchAbbHtml,
  parseListings,
  hasNextPage,
  parseDetail,
  buildListPageUrl,
  buildMagnetUri
}
