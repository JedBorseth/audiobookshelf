const axios = require('axios')
const Logger = require('../Logger')

const RD_BASE = 'https://api.real-debrid.com/rest/1.0'

/**
 * @param {string} token
 */
function createClient(token) {
  return axios.create({
    baseURL: RD_BASE,
    timeout: 60000,
    headers: {
      Authorization: `Bearer ${token}`
    }
  })
}

/**
 * @param {string} token
 * @param {string} magnet
 * @returns {Promise<{ id: string }>}
 */
async function addMagnet(token, magnet) {
  const client = createClient(token)
  const body = new URLSearchParams()
  body.append('magnet', magnet)
  const res = await client.post('/torrents/addMagnet', body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true
  })
  if (res.status !== 201 && res.status !== 200) {
    const msg = res.data?.error || `HTTP ${res.status}`
    throw new Error(msg)
  }
  if (!res.data?.id) {
    throw new Error('Real-Debrid: missing torrent id')
  }
  return { id: String(res.data.id) }
}

/**
 * @param {import('axios').AxiosInstance} client
 * @param {string} id
 */
async function waitForFilesSelection(client, id) {
  for (let i = 0; i < 45; i++) {
    const res = await client.get(`/torrents/info/${id}`, { validateStatus: () => true })
    if (res.status !== 200) {
      const msg = res.data?.error || `HTTP ${res.status}`
      throw new Error(msg)
    }
    const data = res.data
    const status = data.status
    if (status === 'magnet_error' || status === 'error' || status === 'dead') {
      throw new Error(data.message || `Torrent status: ${status}`)
    }
    if (status === 'waiting_files_selection') {
      return
    }
    if (data.files && Object.keys(data.files).length > 0) {
      return
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  throw new Error('Real-Debrid: timeout waiting for torrent metadata')
}

/**
 * @param {string} token
 * @param {string} id
 */
async function selectAllFiles(token, id) {
  const client = createClient(token)
  const body = new URLSearchParams()
  body.append('files', 'all')
  const res = await client.post(`/torrents/selectFiles/${id}`, body.toString(), {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    validateStatus: () => true
  })
  if (res.status !== 204 && res.status !== 200 && res.status !== 202) {
    const msg = res.data?.error || `HTTP ${res.status}`
    throw new Error(msg)
  }
}

/**
 * Add magnet to Real-Debrid and select all files to start download.
 *
 * @param {string} token
 * @param {string} magnet
 * @returns {Promise<{ id: string }>}
 */
async function addMagnetAndSelectAll(token, magnet) {
  if (!token?.trim()) {
    throw new Error('Real-Debrid API token is not configured')
  }
  const { id } = await addMagnet(token.trim(), magnet)
  Logger.info(`[realDebridClient] Added magnet, torrent id=${id}`)
  const client = createClient(token.trim())
  await waitForFilesSelection(client, id)
  await selectAllFiles(token.trim(), id)
  Logger.info(`[realDebridClient] Selected all files for torrent id=${id}`)
  return { id }
}

module.exports = {
  addMagnetAndSelectAll
}
