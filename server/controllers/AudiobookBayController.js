const Logger = require('../Logger')
const Database = require('../Database')
const audiobookBay = require('../utils/audiobookBay')
const realDebridClient = require('../utils/realDebridClient')

class AudiobookBayController {
  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {import('express').NextFunction} next
   */
  middlewareBookLibrary(req, res, next) {
    if (req.library?.mediaType !== 'book') {
      return res.status(400).send('Browse is only available for book libraries')
    }
    next()
  }

  /**
   * GET /api/libraries/:id/browse/abb?q=&page=
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async list(req, res) {
    const baseUrl = Database.serverSettings.audioBookBayBaseUrl
    const q = req.query.q !== undefined ? String(req.query.q) : ''
    const page = !isNaN(req.query.page) ? Math.max(1, Number(req.query.page)) : 1

    try {
      const listUrl = audiobookBay.buildListPageUrl(baseUrl, { q, page })
      const html = await audiobookBay.fetchAbbHtml(baseUrl, listUrl.toString())
      const items = audiobookBay.parseListings(html)
      const more = audiobookBay.hasNextPage(html, page, q)
      res.json({
        items,
        page,
        hasMore: more
      })
    } catch (error) {
      Logger.error(`[AudiobookBayController] list failed`, error)
      res.status(502).send(error.message || 'Failed to load AudioBook Bay')
    }
  }

  /**
   * GET /api/libraries/:id/browse/abb/detail?path=
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async detail(req, res) {
    const path = req.query.path !== undefined ? String(req.query.path) : ''
    if (!this.isValidAbbPath(path)) {
      return res.status(400).send('Invalid path')
    }
    const baseUrl = Database.serverSettings.audioBookBayBaseUrl

    try {
      const resolved = audiobookBay.resolveAbbUrl(baseUrl, path)
      const html = await audiobookBay.fetchAbbHtml(baseUrl, resolved.toString())
      const detail = audiobookBay.parseDetail(html)
      res.json({
        path: resolved.pathname + (resolved.search || ''),
        ...detail
      })
    } catch (error) {
      Logger.error(`[AudiobookBayController] detail failed`, error)
      res.status(502).send(error.message || 'Failed to load detail')
    }
  }

  /**
   * POST /api/libraries/:id/browse/real-debrid
   * body: { path?: string, magnet?: string }
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async addToRealDebrid(req, res) {
    const token = Database.serverSettings.realDebridApiToken
    let magnet = req.body?.magnet !== undefined ? String(req.body.magnet).trim() : ''

    if (!magnet && req.body?.path) {
      const path = String(req.body.path)
      if (!this.isValidAbbPath(path)) {
        return res.status(400).send('Invalid path')
      }
      const baseUrl = Database.serverSettings.audioBookBayBaseUrl
      try {
        const resolved = audiobookBay.resolveAbbUrl(baseUrl, path)
        const html = await audiobookBay.fetchAbbHtml(baseUrl, resolved.toString())
        const detail = audiobookBay.parseDetail(html)
        magnet = detail.magnet
      } catch (error) {
        Logger.error(`[AudiobookBayController] addToRealDebrid fetch detail failed`, error)
        return res.status(502).send(error.message || 'Failed to resolve magnet')
      }
    }

    if (!magnet || !magnet.toLowerCase().startsWith('magnet:')) {
      return res.status(400).send('magnet link required')
    }

    try {
      const result = await realDebridClient.addMagnetAndSelectAll(token, magnet)
      res.json({
        success: true,
        realDebridTorrentId: result.id
      })
    } catch (error) {
      Logger.error(`[AudiobookBayController] Real-Debrid failed`, error)
      res.status(502).send(error.message || 'Real-Debrid request failed')
    }
  }

  /**
   * @param {string} path
   */
  isValidAbbPath(path) {
    if (!path || typeof path !== 'string') return false
    if (path.length > 2048 || path.length < 2) return false
    if (!path.startsWith('/')) return false
    if (path.includes('..')) return false
    if (/^javascript:/i.test(path)) return false
    return true
  }
}

module.exports = new AudiobookBayController()
