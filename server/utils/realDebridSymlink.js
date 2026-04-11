const Path = require('path')
const fs = require('../libs/fsExtra')
const { SupportedAudioTypes } = require('./globals')
const { filePathToPOSIX, sanitizeFilename, isSameOrSubPath } = require('./fileUtils')

const AUDIO_EXT_SET = new Set(SupportedAudioTypes.map((ext) => `.${ext.toLowerCase()}`))

/** How often to recheck the mount while the torrent folder / file materializes */
const POLL_INTERVAL_MS = 2000
/** Real-Debrid downloads can take several minutes */
const MAX_WAIT_MS = 20 * 60 * 1000
const MAX_SCAN_DEPTH = 16

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Recursively list supported audio files under rootDir (does not follow symlinks).
 *
 * @param {string} rootDir
 * @param {number} maxDepth
 * @returns {Promise<string[]>}
 */
async function collectAudioFilesUnder(rootDir, maxDepth) {
  const results = []

  async function walk(dir, depth) {
    if (depth > maxDepth) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const ent of entries) {
      const joined = Path.join(dir, ent.name)
      const fullPath = filePathToPOSIX(joined)
      if (ent.isSymbolicLink()) continue
      if (ent.isDirectory()) {
        await walk(fullPath, depth + 1)
      } else if (ent.isFile()) {
        const ext = Path.extname(ent.name).toLowerCase()
        if (AUDIO_EXT_SET.has(ext)) results.push(fullPath)
      }
    }
  }

  await walk(rootDir, 0)
  return results
}

/**
 * Wait until the torrent directory exists and contains exactly one readable non-empty audio file,
 * then return that file path. Never returns a directory path.
 *
 * @param {string} mountResolved
 * @param {string} torrentFolderPath
 * @returns {Promise<string>}
 */
async function waitForSingleAudioFileTarget(mountResolved, torrentFolderPath) {
  const deadline = Date.now() + MAX_WAIT_MS
  let lastMultiError = false

  while (Date.now() < deadline) {
    if (!isSameOrSubPath(mountResolved, torrentFolderPath)) {
      throw new Error('Invalid torrent folder path under mount')
    }

    let dirStat
    try {
      dirStat = await fs.stat(torrentFolderPath)
    } catch {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    if (!dirStat.isDirectory()) {
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    const audioPaths = await collectAudioFilesUnder(torrentFolderPath, MAX_SCAN_DEPTH)

    if (audioPaths.length > 1) {
      throw new Error(
        'Real-Debrid torrent contains multiple audio files; automatic symlink only supports a single audio file'
      )
    }

    if (audioPaths.length === 1) {
      const filePath = audioPaths[0]
      if (!isSameOrSubPath(mountResolved, filePath)) {
        throw new Error('Invalid audio file path under mount')
      }
      try {
        const st = await fs.stat(filePath)
        if (st.isFile() && st.size > 0) {
          return filePath
        }
      } catch {
        // Still materializing
      }
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out after ${MAX_WAIT_MS / 60000} minutes waiting for a single audio file under the torrent folder`
  )
}

/**
 * @param {string} name
 * @param {string} fallback
 * @returns {string}
 */
function safeSanitizeSegment(name, fallback) {
  if (typeof name !== 'string' || !name.trim()) return fallback
  const s = sanitizeFilename(name.trim())
  if (typeof s !== 'string' || !s.trim()) return fallback
  return s.trim()
}

/**
 * Create a symlink: symlinkDir/sanitizedTitle -> single audio file under mountPath/sanitizedTorrentFolder
 * (polls until that file exists). Never symlinks to a directory.
 *
 * @param {object} params
 * @param {string} params.mountPath
 * @param {string} params.symlinkDir
 * @param {{ path: string }[]} params.libraryFolders
 * @param {string} params.abbTitle
 * @param {string} params.torrentFilename
 * @param {string} params.torrentId
 * @returns {Promise<{ created: true, linkPath: string, targetPath: string }>}
 */
async function createRealDebridLibrarySymlink(params) {
  const { mountPath, symlinkDir, libraryFolders, abbTitle, torrentFilename, torrentId } = params

  if (!mountPath?.trim() || !symlinkDir?.trim()) {
    throw new Error('Real-Debrid mount path and symlink directory must be configured')
  }
  if (!Array.isArray(libraryFolders) || !libraryFolders.length) {
    throw new Error('Library has no folders')
  }

  const mountResolved = filePathToPOSIX(Path.resolve(mountPath.trim()))
  const symlinkDirResolved = filePathToPOSIX(Path.resolve(symlinkDir.trim()))

  const symlinkInLibrary = libraryFolders.some((f) => {
    if (!f?.path) return false
    const lp = filePathToPOSIX(Path.resolve(f.path))
    return isSameOrSubPath(lp, symlinkDirResolved)
  })
  if (!symlinkInLibrary) {
    throw new Error('Real-Debrid symlink directory must be inside a folder of this library')
  }

  const folderSeg = safeSanitizeSegment(torrentFilename, 'torrent')
  const torrentFolderPath = filePathToPOSIX(Path.join(mountResolved, folderSeg))
  if (!isSameOrSubPath(mountResolved, torrentFolderPath)) {
    throw new Error('Invalid torrent folder path under mount')
  }

  const targetPath = await waitForSingleAudioFileTarget(mountResolved, torrentFolderPath)

  const titleSeg = safeSanitizeSegment(abbTitle, folderSeg)
  const idPart = String(torrentId || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
  const shortId = idPart || 'rd'

  await fs.ensureDir(symlinkDirResolved)

  let linkSeg = titleSeg
  let linkPath = filePathToPOSIX(Path.join(symlinkDirResolved, linkSeg))
  let n = 0
  while (await fs.pathExists(linkPath)) {
    n += 1
    const suffix = n === 1 ? `-${shortId}` : `-${shortId}-${n}`
    linkSeg = titleSeg + suffix
    linkPath = filePathToPOSIX(Path.join(symlinkDirResolved, linkSeg))
  }

  if (!isSameOrSubPath(symlinkDirResolved, linkPath)) {
    throw new Error('Invalid symlink path')
  }

  if (global.isWin) {
    await fs.symlink(targetPath, linkPath, 'file')
  } else {
    await fs.symlink(targetPath, linkPath)
  }

  return { created: true, linkPath, targetPath }
}

module.exports = {
  createRealDebridLibrarySymlink
}
