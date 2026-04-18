const Path = require('path')
const Logger = require('../Logger')
const Database = require('../Database')
const Watcher = require('../Watcher')
const TaskManager = require('../managers/TaskManager')
const LibraryScanner = require('../scanner/LibraryScanner')
const audiobookBay = require('../utils/audiobookBay')
const realDebridClient = require('../utils/realDebridClient')
const fileUtils = require('../utils/fileUtils')
const { createRealDebridLibrarySymlink } = require('../utils/realDebridSymlink')

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
   * body: { path?: string, magnet?: string, title?: string }
   * Adds the torrent to Real-Debrid and starts the download. Library symlink finalization is a separate
   * step (POST …/finalize) so the client can poll GET …/status for progress.
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
      const mountPath = Database.serverSettings.realDebridMountPath
      const symlinkDir = Database.serverSettings.realDebridSymlinkDir
      res.json({
        success: true,
        realDebridTorrentId: result.id,
        librarySymlinkConfigured: !!(mountPath?.trim() && symlinkDir?.trim())
      })
    } catch (error) {
      Logger.error(`[AudiobookBayController] Real-Debrid failed`, error)
      res.status(502).send(error.message || 'Real-Debrid request failed')
    }
  }

  /**
   * GET /api/libraries/:id/browse/real-debrid/status?torrentId=
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async realDebridTorrentStatus(req, res) {
    const token = Database.serverSettings.realDebridApiToken
    if (!token?.trim()) {
      return res.status(400).send('Real-Debrid API token is not configured')
    }
    const torrentId = req.query.torrentId !== undefined ? String(req.query.torrentId).trim() : ''
    if (!this.isValidRdTorrentId(torrentId)) {
      return res.status(400).send('Invalid torrent id')
    }
    try {
      const status = await realDebridClient.getTorrentStatus(token, torrentId)
      res.json(status)
    } catch (error) {
      Logger.error(`[AudiobookBayController] realDebridTorrentStatus failed`, error)
      res.status(502).send(error.message || 'Real-Debrid request failed')
    }
  }

  /**
   * POST /api/libraries/:id/browse/real-debrid/finalize
   * body: { torrentId: string, title?: string }
   *
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  async finalizeRealDebridSymlink(req, res) {
    const token = Database.serverSettings.realDebridApiToken
    if (!token?.trim()) {
      return res.status(400).send('Real-Debrid API token is not configured')
    }
    const torrentId = req.body?.torrentId !== undefined ? String(req.body.torrentId).trim() : ''
    let abbTitle = req.body?.title !== undefined ? String(req.body.title).trim() : ''
    if (!this.isValidRdTorrentId(torrentId)) {
      return res.status(400).send('Invalid torrent id')
    }

    const mountPath = Database.serverSettings.realDebridMountPath
    const symlinkDir = Database.serverSettings.realDebridSymlinkDir
    if (!mountPath?.trim() || !symlinkDir?.trim()) {
      return res.json({ success: true, skipped: true })
    }

    const payload = { success: true }

    try {
      const info = await realDebridClient.getTorrentInfo(token, torrentId)
      const titleForLink = abbTitle || info.filename
      try {
        const symlinkResult = await createRealDebridLibrarySymlink({
          mountPath,
          symlinkDir,
          libraryFolders: req.library.libraryFolders || [],
          abbTitle: titleForLink,
          torrentFilename: info.filename,
          torrentId
        })
        payload.symlink = {
          created: true,
          folderPath: symlinkResult.folderPath,
          linkPath: symlinkResult.linkPath,
          targetPath: symlinkResult.targetPath,
          links: symlinkResult.links
        }
        for (const link of symlinkResult.links) {
          if (link?.linkPath) {
            Watcher.onFileAdded(req.library.id, link.linkPath)
          }
        }
        setImmediate(() => {
          this.enqueueRealDebridLibraryScan(req.library, symlinkResult.links, symlinkResult.folderPath).catch((err) => {
            Logger.error(`[AudiobookBayController] enqueueRealDebridLibraryScan failed`, err)
          })
        })
      } catch (symlinkErr) {
        Logger.error(`[AudiobookBayController] Real-Debrid symlink failed`, symlinkErr)
        payload.symlink = {
          created: false,
          error: symlinkErr.message || String(symlinkErr)
        }
      }
      res.json(payload)
    } catch (error) {
      Logger.error(`[AudiobookBayController] finalizeRealDebridSymlink failed`, error)
      res.status(502).send(error.message || 'Real-Debrid request failed')
    }
  }

  /**
   * Mirrors the watcher-driven incremental scan so symlinked media is indexed without requiring a
   * full library scan (also covers cases where Watcher.addFileUpdate cannot resolve the folder).
   *
   * @param {import('../models/Library')} library
   * @param {{ linkPath?: string }[]} links
   * @param {string} [bookFolderPath] - title folder created under the symlink dir (clears all pending paths under it)
   */
  async enqueueRealDebridLibraryScan(library, links, bookFolderPath) {
    const paths = [
      ...new Set(
        (links || [])
          .map((l) => (l?.linkPath ? fileUtils.filePathToPOSIX(l.linkPath) : ''))
          .filter(Boolean)
      )
    ]
    if (!paths.length) return

    Watcher.releasePathsFromPendingScan(paths, bookFolderPath)

    const folder = library.libraryFolders?.find((f) => paths.some((p) => fileUtils.isSameOrSubPath(f.path, p)))
    if (!folder) {
      Logger.warn(`[AudiobookBayController] Real-Debrid finalize: could not match a library folder for new links — run a library scan`)
      return
    }

    const folderPath = fileUtils.filePathToPOSIX(folder.path)
    const fileUpdates = paths
      .map((abs) => {
        const rel = fileUtils.filePathToPOSIX(Path.relative(folderPath, abs))
        if (rel.startsWith('..')) {
          Logger.warn(`[AudiobookBayController] Real-Debrid link path is not under library folder "${folderPath}": ${abs}`)
          return null
        }
        return {
          path: abs,
          relPath: rel,
          folderId: folder.id,
          libraryId: library.id,
          type: 'added'
        }
      })
      .filter(Boolean)

    if (!fileUpdates.length) return

    const taskData = {
      libraryId: library.id,
      libraryName: library.name
    }
    const taskTitleString = {
      text: `Scanning file changes in "${library.name}"`,
      key: 'MessageTaskScanningFileChanges',
      subs: [library.name]
    }
    const pendingTask = TaskManager.createAndAddTask('watcher-scan', taskTitleString, null, true, taskData)
    await LibraryScanner.scanFilesChanged(fileUpdates, pendingTask)
  }

  /**
   * @param {string} id
   */
  isValidRdTorrentId(id) {
    if (!id || typeof id !== 'string') return false
    if (id.length > 80 || id.length < 2) return false
    return /^[A-Za-z0-9_-]+$/.test(id)
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
