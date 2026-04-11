const Path = require('path')
const fs = require('../libs/fsExtra')
const { SupportedAudioTypes } = require('./globals')
const { filePathToPOSIX, sanitizeFilename, isSameOrSubPath } = require('./fileUtils')

const AUDIO_EXT_SET = new Set(SupportedAudioTypes.map((ext) => `.${ext.toLowerCase()}`))

/**
 * When the torrent folder has exactly one audio file at its top level (typical single-m4b release),
 * return that file path so the library symlink points at media, not an extra directory.
 *
 * @param {string} folderPath
 * @returns {Promise<string|null>}
 */
async function getSingleTopLevelAudioFile(folderPath) {
  try {
    const entries = await fs.readdir(folderPath, { withFileTypes: true })
    const audioFiles = []
    for (const ent of entries) {
      if (!ent.isFile()) continue
      const ext = Path.extname(ent.name).toLowerCase()
      if (AUDIO_EXT_SET.has(ext)) {
        audioFiles.push(filePathToPOSIX(Path.join(folderPath, ent.name)))
      }
    }
    if (audioFiles.length === 1) return audioFiles[0]
  } catch {
    // Folder missing, not yet mounted, or unreadable — fall back to directory target
  }
  return null
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
 * Create a symlink: symlinkDir/sanitizedTitle -> mountPath/sanitizedTorrentFolder
 * (or -> single top-level audio file inside that folder when there is exactly one)
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

  const singleAudio = await getSingleTopLevelAudioFile(torrentFolderPath)
  const targetPath = singleAudio || torrentFolderPath
  if (!isSameOrSubPath(mountResolved, targetPath)) {
    throw new Error('Invalid symlink target path under mount')
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

  const targetIsDirectory = !singleAudio
  if (global.isWin) {
    await fs.symlink(targetPath, linkPath, targetIsDirectory ? 'dir' : 'file')
  } else {
    await fs.symlink(targetPath, linkPath)
  }

  return { created: true, linkPath, targetPath }
}

module.exports = {
  createRealDebridLibrarySymlink
}
