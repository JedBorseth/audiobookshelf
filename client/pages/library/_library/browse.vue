<template>
  <div class="page" :class="streamLibraryItem ? 'streaming' : ''">
    <app-book-shelf-toolbar page="browse" />

    <div id="bookshelf" class="w-full overflow-y-auto px-2 py-6 sm:px-4 md:p-12 relative">
      <div class="w-full max-w-4xl mx-auto flex flex-col">
        <form class="flex flex-col sm:flex-row gap-2" :class="activeSearch ? 'mb-6' : 'mb-2'" @submit.prevent="submitSearch">
          <ui-text-input
            v-model="searchInput"
            type="search"
            :disabled="listLoading"
            :placeholder="$strings.MessageBrowseAbbSearchPlaceholder"
            class="grow text-sm md:text-base"
          />
          <ui-btn type="submit" :disabled="listLoading">{{ $strings.ButtonSearch }}</ui-btn>
        </form>
        <p v-if="!activeSearch" class="text-xs sm:text-sm text-gray-400 mb-6 leading-relaxed">{{ $strings.MessageBrowseAbbBestsellersBlurb }}</p>

        <div v-if="selectedDetail" class="mb-8 p-4 bg-primary/20 border border-white/10 rounded-md">
          <div class="flex flex-col md:flex-row gap-4">
            <div v-if="selectedDetail.coverUrl" class="w-32 min-w-32 h-48 md:w-40 md:min-w-40 md:h-60 bg-primary shrink-0 mx-auto md:mx-0">
              <img :src="selectedDetail.coverUrl" class="h-full w-full object-cover" alt="" />
            </div>
            <div class="grow min-w-0 text-center md:text-left">
              <h2 class="text-lg md:text-xl font-semibold text-gray-100">{{ selectedDetail.title }}</h2>
              <p v-if="selectedDetail.descriptionText" class="text-sm text-gray-300 mt-2 line-clamp-6">{{ selectedDetail.descriptionText }}</p>
              <div class="mt-4 flex flex-wrap gap-2 justify-center md:justify-start">
                <ui-btn :loading="isPathBusy(selectedDetail.path)" color="bg-success" @click="sendToRealDebridFromDetail">{{ $strings.ButtonAddToRealDebrid }}</ui-btn>
                <ui-btn color="bg-bg" small @click="clearDetail">{{ $strings.ButtonClose }}</ui-btn>
              </div>
              <div v-if="selectedDetail.path && rdProgressVisible(selectedDetail.path)" class="mt-4 max-w-md mx-auto md:mx-0">
                <div class="h-2 bg-primary/30 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-success transition-all duration-300 rounded-full min-w-[4%]"
                    :style="{ width: Math.max(4, rdProgressPercent(selectedDetail.path) || 0) + '%' }"
                  />
                </div>
                <p class="text-xs text-gray-400 mt-1.5 text-left">{{ rdProgressLabel(selectedDetail.path) }}</p>
              </div>
              <div v-else-if="selectedDetail.path && isPathLibraryLinking(selectedDetail.path)" class="mt-4 max-w-md mx-auto md:mx-0">
                <div class="h-2 bg-primary/30 rounded-full overflow-hidden">
                  <div class="h-full w-2/5 bg-yellow-500/90 rounded-full animate-pulse" />
                </div>
                <p class="text-xs text-gray-400 mt-1.5 text-left">{{ $strings.LabelBrowsePreparingLibrary }}</p>
              </div>
            </div>
          </div>
        </div>

        <p v-if="!listLoading && !items.length" class="text-center text-xl text-gray-300 py-8">{{ $strings.MessageBrowseAbbEmpty }}</p>

        <template v-for="item in items">
          <div
            :key="item.path"
            class="flex flex-col sm:flex-row gap-3 p-3 mb-2 rounded-lg border border-transparent hover:bg-primary/20 hover:border-white/5 transition-colors"
            :class="selectedPath === item.path ? 'bg-primary/25 border-white/10' : ''"
          >
            <div class="flex gap-3 min-w-0 grow cursor-pointer" @click="openItem(item)">
              <div class="w-16 min-w-16 h-24 sm:w-20 sm:min-w-20 sm:h-28 bg-primary shrink-0 rounded overflow-hidden">
                <img v-if="item.coverUrl" :src="item.coverUrl" class="h-full w-full object-cover" alt="" />
              </div>
              <div class="grow min-w-0 py-0.5">
                <p class="text-base sm:text-lg text-gray-100 leading-snug">{{ item.title }}</p>
                <p v-if="item.infoLine" class="text-xs sm:text-sm text-gray-400 mt-1 line-clamp-2">{{ item.infoLine }}</p>
              </div>
            </div>
            <div class="flex flex-col gap-2 shrink-0 w-full sm:w-44 sm:pt-1" @click.stop>
              <ui-btn
                color="bg-success"
                class="w-full text-sm"
                :padding-x="3"
                :loading="isPathBusy(item.path)"
                :disabled="listLoading"
                @click="addBookQuick(item)"
              >
                {{ $strings.ButtonAddBookQuick }}
              </ui-btn>
              <div v-if="rdProgressVisible(item.path)" class="w-full">
                <div class="h-2 bg-primary/30 rounded-full overflow-hidden">
                  <div
                    class="h-full bg-success transition-all duration-300 rounded-full min-w-[4%]"
                    :style="{ width: Math.max(4, rdProgressPercent(item.path) || 0) + '%' }"
                  />
                </div>
                <p class="text-[0.7rem] sm:text-xs text-gray-400 mt-1 leading-snug">{{ rdProgressLabel(item.path) }}</p>
              </div>
              <div v-else-if="isPathLibraryLinking(item.path)" class="w-full">
                <div class="h-2 bg-primary/30 rounded-full overflow-hidden">
                  <div class="h-full w-2/5 bg-yellow-500/90 rounded-full animate-pulse" />
                </div>
                <p class="text-[0.7rem] sm:text-xs text-gray-400 mt-1">{{ $strings.LabelBrowsePreparingLibrary }}</p>
              </div>
            </div>
          </div>
        </template>

        <div v-if="hasMore" class="flex justify-center py-6">
          <ui-btn :loading="listLoading" color="bg-primary" @click="loadMore">{{ $strings.ButtonLoadMore }}</ui-btn>
        </div>
      </div>

      <div v-show="listLoading && !items.length" class="absolute top-0 left-0 w-full h-full flex items-center justify-center bg-black/25 z-40">
        <ui-loading-indicator />
      </div>
    </div>
  </div>
</template>

<script>
const RD_ERROR_STATUSES = ['magnet_error', 'error', 'dead', 'virus']

export default {
  async asyncData({ params, store, app, redirect }) {
    const libraryId = params.library
    const libraryData = await store.dispatch('libraries/fetch', libraryId)
    if (!libraryData) {
      return redirect('/oops?message=Library not found')
    }
    if (libraryData.library.mediaType !== 'book') {
      return redirect(`/library/${libraryId}`)
    }

    const data = await app.$axios
      .$get(`/api/libraries/${libraryId}/browse/abb`, { params: { page: 1 } })
      .catch((err) => {
        console.error('Browse ABB initial load failed', err)
        return null
      })

    return {
      libraryId,
      items: data?.items || [],
      listPage: 1,
      hasMore: !!data?.hasMore,
      activeSearch: ''
    }
  },
  data() {
    return {
      searchInput: '',
      listLoading: false,
      selectedDetail: null,
      selectedPath: null,
      itemAddState: {}
    }
  },
  computed: {
    streamLibraryItem() {
      return this.$store.state.streamLibraryItem
    }
  },
  methods: {
    clearDetail() {
      this.selectedDetail = null
      this.selectedPath = null
    },
    isPathBusy(path) {
      if (!path) return false
      const s = this.itemAddState[path]
      if (!s) return false
      return s.phase === 'adding' || s.phase === 'rd_download' || s.phase === 'library_link'
    },
    rdProgressVisible(path) {
      const s = this.itemAddState[path]
      return !!(s && s.phase === 'rd_download')
    },
    rdProgressPercent(path) {
      const s = this.itemAddState[path]
      if (!s || s.phase !== 'rd_download') return null
      return s.progress != null ? s.progress : null
    },
    rdProgressLabel(path) {
      const s = this.itemAddState[path]
      if (!s || s.phase !== 'rd_download') return ''
      const st = (s.status || '').replace(/_/g, ' ').trim()
      const pct = s.progress != null ? `${s.progress}%` : ''
      if (st && pct) return `${st} · ${pct}`
      if (pct) return pct
      if (st) return st
      return this.$strings.LabelBrowseRdProgressUnknown
    },
    isPathLibraryLinking(path) {
      const s = this.itemAddState[path]
      return !!(s && s.phase === 'library_link')
    },
    async fetchList({ page, append }) {
      this.listLoading = true
      const params = { page }
      if (this.activeSearch) {
        params.q = this.activeSearch
      }
      try {
        const data = await this.$axios.$get(`/api/libraries/${this.libraryId}/browse/abb`, { params })
        if (append) {
          this.items = [...this.items, ...(data.items || [])]
        } else {
          this.items = data.items || []
        }
        this.hasMore = !!data.hasMore
        this.listPage = page
      } catch (error) {
        console.error('Browse ABB load failed', error)
        this.$toast.error(this.$strings.ToastBrowseAbbError)
      } finally {
        this.listLoading = false
      }
    },
    submitSearch() {
      this.activeSearch = (this.searchInput || '').trim()
      this.clearDetail()
      this.fetchList({ page: 1, append: false })
    },
    loadMore() {
      if (!this.hasMore || this.listLoading) return
      this.fetchList({ page: this.listPage + 1, append: true })
    },
    async openItem(item) {
      this.selectedPath = item.path
      this.listLoading = true
      try {
        const detail = await this.$axios.$get(`/api/libraries/${this.libraryId}/browse/abb/detail`, {
          params: { path: item.path }
        })
        this.selectedDetail = detail
      } catch (error) {
        console.error('ABB detail failed', error)
        const msg = error.response?.data || error.message
        this.$toast.error(typeof msg === 'string' ? msg : this.$strings.ToastBrowseAbbError)
        this.clearDetail()
      } finally {
        this.listLoading = false
      }
    },
    addBookQuick(item) {
      if (!item?.path || this.listLoading) return
      if (this.isPathBusy(item.path)) return
      return this.runRealDebridPipeline({ path: item.path, title: item.title || '' })
    },
    sendToRealDebridFromDetail() {
      if (!this.selectedDetail?.path) return
      if (this.isPathBusy(this.selectedDetail.path)) return
      return this.runRealDebridPipeline({
        path: this.selectedDetail.path,
        title: this.selectedDetail.title || ''
      })
    },
    async runRealDebridPipeline({ path, title }) {
      this.$set(this.itemAddState, path, { phase: 'adding', progress: null, status: '' })
      try {
        const data = await this.$axios.$post(`/api/libraries/${this.libraryId}/browse/real-debrid`, {
          path,
          title
        })
        const torrentId = data?.realDebridTorrentId
        if (!torrentId) {
          throw new Error('Missing torrent id')
        }

        this.$set(this.itemAddState, path, { phase: 'rd_download', progress: 0, status: '', torrentId })

        await this.pollRealDebridUntilDownloaded(torrentId, path)

        if (data.librarySymlinkConfigured) {
          this.$set(this.itemAddState, path, { phase: 'library_link', progress: null, status: '', torrentId })
          const fin = await this.$axios.$post(
            `/api/libraries/${this.libraryId}/browse/real-debrid/finalize`,
            { torrentId, title },
            { timeout: 25 * 60 * 1000 }
          )
          if (fin?.symlink?.created) {
            this.$toast.success(this.$strings.ToastRealDebridLibraryReady)
          } else if (fin?.symlink?.error) {
            this.$toast.warning(`${this.$strings.ToastRealDebridSymlinkFailed}: ${fin.symlink.error}`)
          } else {
            this.$toast.success(this.$strings.ToastRealDebridAddSuccess)
          }
        } else {
          this.$toast.success(this.$strings.ToastRealDebridAddSuccess)
        }
      } catch (error) {
        console.error('Real-Debrid pipeline failed', error)
        const msg = error.response?.data || error.message
        this.$toast.error(typeof msg === 'string' ? msg : this.$strings.ToastRealDebridSaveFailed)
      } finally {
        this.$delete(this.itemAddState, path)
      }
    },
    async pollRealDebridUntilDownloaded(torrentId, pathKey) {
      const deadline = Date.now() + 45 * 60 * 1000
      while (Date.now() < deadline) {
        const st = await this.$axios.$get(`/api/libraries/${this.libraryId}/browse/real-debrid/status`, {
          params: { torrentId }
        })
        const prev = this.itemAddState[pathKey] || {}
        this.$set(this.itemAddState, pathKey, {
          ...prev,
          phase: 'rd_download',
          progress: st.progress != null ? st.progress : prev.progress,
          status: st.status || '',
          torrentId
        })
        if (st.status && RD_ERROR_STATUSES.includes(st.status)) {
          throw new Error(st.message || `Torrent status: ${st.status}`)
        }
        if (st.status === 'downloaded') {
          return
        }
        await new Promise((r) => setTimeout(r, 1500))
      }
      throw new Error(this.$strings.ToastRealDebridTimeout)
    }
  }
}
</script>
