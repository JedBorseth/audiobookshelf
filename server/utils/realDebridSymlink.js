const Path = require('path')
const fs = require('../libs/fsExtra')
const { SupportedAudioTypes } = require('./globals')
const { filePathToPOSIX, sanitizeFilename, isSameOrSubPath } = require('./fileUtils')

const AUDIO_EXT_SET = new Set(SupportedAudioTypes.map((ext) => `.${ext.toLowerCase()}`))

/** How often to recheck the mount while the torrent folder / files materialize */
const POLL_INTERVAL_MS = 2000
/** Real-Debrid downloads can take several minutes */
const MAX_WAIT_MS = 20 * 60 * 1000
const MAX_SCAN_DEPTH = 16
/** Consecutive identical scans required before treating the file set as complete */
const STABLE_POLLS_REQUIRED = 2

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
 * @param {string} torrentFolderPath
 * @param {string} absoluteSourcePath
 * @returns {string}
 */
function sanitizedLinkFileName(torrentFolderPath, absoluteSourcePath) {
  const rel = Path.relative(torrentFolderPath, absoluteSourcePath)
  if (!rel || rel.startsWith('..')) {
    return 'track' + Path.extname(absoluteSourcePath).toLowerCase()
  }
  const posixRel = filePathToPOSIX(rel)
  const flat = posixRel.split('/').filter(Boolean).join('_')
  const ext = Path.extname(flat).toLowerCase()
  const stem = ext.length ? flat.slice(0, -ext.length) : flat
  const safeStem = sanitizeFilename(stem)
  const finalStem =
    typeof safeStem === 'string' && safeStem.trim() ? safeStem.trim() : 'track'
  return finalStem + ext
}

/**
 * @param {string} baseName
 * @param {Set<string>} used
 * @returns {string}
 */
function uniquifyLinkFileName(baseName, used) {
  const ext = Path.extname(baseName)
  const stem = ext.length ? baseName.slice(0, -ext.length) : baseName
  let candidate = baseName
  let n = 2
  while (used.has(candidate)) {
    candidate = `${stem}_${n}${ext}`
    n += 1
  }
  used.add(candidate)
  return candidate
}

/**
 * Wait until the torrent directory exists, lists at least one audio file, every listed file is
 * non-empty, and the list stays unchanged for STABLE_POLLS_REQUIRED polls (so new files are not
 * still appearing).
 *
 * @param {string} mountResolved
 * @param {string} torrentFolderPath
 * @returns {Promise<string[]>}
 */
async function waitForStableReadyAudioFiles(mountResolved, torrentFolderPath) {
  const deadline = Date.now() + MAX_WAIT_MS
  let prevKey = null
  let stableCount = 0

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

    const audioPaths = (await collectAudioFilesUnder(torrentFolderPath, MAX_SCAN_DEPTH)).sort()
    if (audioPaths.length === 0) {
      prevKey = null
      stableCount = 0
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    let allReady = true
    for (const p of audioPaths) {
      if (!isSameOrSubPath(mountResolved, p)) {
        allReady = false
        break
      }
      try {
        const st = await fs.stat(p)
        if (!st.isFile() || st.size === 0) {
          allReady = false
          break
        }
      } catch {
        allReady = false
        break
      }
    }

    if (!allReady) {
      prevKey = null
      stableCount = 0
      await sleep(POLL_INTERVAL_MS)
      continue
    }

    const key = audioPaths.join('\0')
    if (key === prevKey) {
      stableCount += 1
      if (stableCount >= STABLE_POLLS_REQUIRED) {
        return audioPaths
      }
    } else {
      prevKey = key
      stableCount = 1
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error(
    `Timed out after ${MAX_WAIT_MS / 60000} minutes waiting for audio files under the torrent folder`
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
 * Creates symlinkDir/bookTitle/file1.m4b, file2.mp3, … each pointing at the corresponding file
 * under the Real-Debrid mount (polls until files exist and the set is stable).
 *
 * @param {object} params
 * @param {string} params.mountPath
 * @param {string} params.symlinkDir
 * @param {{ path: string }[]} params.libraryFolders
 * @param {string} params.abbTitle
 * @param {string} params.torrentFilename
 * @param {string} params.torrentId
 * @returns {Promise<{ created: true, folderPath: string, linkPath: string, targetPath: string, links: { linkPath: string, targetPath: string }[] }>}
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

  const audioTargets = await waitForStableReadyAudioFiles(mountResolved, torrentFolderPath)

  const titleSeg = safeSanitizeSegment(abbTitle, folderSeg)
  const idPart = String(torrentId || '')
    .replace(/[^a-zA-Z0-9]/g, '')
    .slice(-8)
  const shortId = idPart || 'rd'

  await fs.ensureDir(symlinkDirResolved)

  let bookSeg = titleSeg
  let bookDir = filePathToPOSIX(Path.join(symlinkDirResolved, bookSeg))
  let n = 0
  while (await fs.pathExists(bookDir)) {
    n += 1
    const suffix = n === 1 ? `-${shortId}` : `-${shortId}-${n}`
    bookSeg = titleSeg + suffix
    bookDir = filePathToPOSIX(Path.join(symlinkDirResolved, bookSeg))
  }

  if (!isSameOrSubPath(symlinkDirResolved, bookDir)) {
    throw new Error('Invalid book folder path')
  }

  await fs.ensureDir(bookDir)

  const links = []
  const usedNames = new Set()

  try {
    for (const targetPath of audioTargets) {
      const base = sanitizedLinkFileName(torrentFolderPath, targetPath)
      const linkFile = uniquifyLinkFileName(base, usedNames)
      const linkPath = filePathToPOSIX(Path.join(bookDir, linkFile))

      if (!isSameOrSubPath(bookDir, linkPath)) {
        throw new Error('Invalid per-file symlink path')
      }

      if (global.isWin) {
        await fs.symlink(targetPath, linkPath, 'file')
      } else {
        await fs.symlink(targetPath, linkPath)
      }
      links.push({ linkPath, targetPath })
    }
  } catch (err) {
    await fs.remove(bookDir).catch(() => {})
    throw err
  }

  const firstTarget = links[0]?.targetPath || ''
  return {
    created: true,
    folderPath: bookDir,
    linkPath: bookDir,
    targetPath: firstTarget,
    links
  }
}

module.exports = {
  createRealDebridLibrarySymlink
}
