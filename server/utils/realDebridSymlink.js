const Path = require('path')
const fs = require('../libs/fsExtra')
const { filePathToPOSIX, sanitizeFilename, isSameOrSubPath } = require('./fileUtils')

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
 * Create a symlink: symlinkDir/sanitizedTitle -> mountPath/sanitizedTorrentFolder
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
  const targetPath = filePathToPOSIX(Path.join(mountResolved, folderSeg))
  if (!isSameOrSubPath(mountResolved, targetPath)) {
    throw new Error('Invalid torrent folder path under mount')
  }

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
    await fs.symlink(targetPath, linkPath, 'dir')
  } else {
    await fs.symlink(targetPath, linkPath)
  }

  return { created: true, linkPath, targetPath }
}

module.exports = {
  createRealDebridLibrarySymlink
}
