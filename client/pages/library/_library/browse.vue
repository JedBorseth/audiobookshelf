<template>
  <div class="page" :class="streamLibraryItem ? 'streaming' : ''">
    <app-book-shelf-toolbar page="browse" />

    <div id="bookshelf" class="w-full overflow-y-auto px-2 py-6 sm:px-4 md:p-12 relative">
      <div class="w-full max-w-4xl mx-auto flex flex-col">
        <form class="flex flex-col sm:flex-row gap-2 mb-6" @submit.prevent="submitSearch">
          <ui-text-input
            v-model="searchInput"
            type="search"
            :disabled="listLoading"
            :placeholder="$strings.MessageBrowseAbbSearchPlaceholder"
            class="grow text-sm md:text-base"
          />
          <ui-btn type="submit" :disabled="listLoading">{{ $strings.ButtonSearch }}</ui-btn>
        </form>

        <div v-if="selectedDetail" class="mb-8 p-4 bg-primary/20 border border-white/10 rounded-md">
          <div class="flex flex-col md:flex-row gap-4">
            <div v-if="selectedDetail.coverUrl" class="w-32 min-w-32 h-48 md:w-40 md:min-w-40 md:h-60 bg-primary shrink-0">
              <img :src="selectedDetail.coverUrl" class="h-full w-full object-cover" alt="" />
            </div>
            <div class="grow min-w-0">
              <h2 class="text-lg md:text-xl font-semibold text-gray-100">{{ selectedDetail.title }}</h2>
              <p v-if="selectedDetail.descriptionText" class="text-sm text-gray-300 mt-2 line-clamp-6">{{ selectedDetail.descriptionText }}</p>
              <div class="mt-4 flex flex-wrap gap-2">
                <ui-btn :loading="rdLoading" color="bg-success" @click="sendToRealDebrid">{{ $strings.ButtonAddToRealDebrid }}</ui-btn>
                <ui-btn color="bg-bg" small @click="clearDetail">{{ $strings.ButtonClose }}</ui-btn>
              </div>
            </div>
          </div>
        </div>

        <p v-if="!listLoading && !items.length" class="text-center text-xl text-gray-300 py-8">{{ $strings.MessageBrowseAbbEmpty }}</p>

        <template v-for="item in items">
          <div
            :key="item.path"
            class="flex p-2 mb-1 hover:bg-primary/25 cursor-pointer rounded"
            :class="selectedPath === item.path ? 'bg-primary/40' : ''"
            @click="openItem(item)"
          >
            <div class="w-16 min-w-16 h-24 md:w-20 md:min-w-20 md:h-28 bg-primary shrink-0">
              <img v-if="item.coverUrl" :src="item.coverUrl" class="h-full w-full object-cover" alt="" />
            </div>
            <div class="grow pl-3 min-w-0">
              <p class="text-base md:text-lg text-gray-100 leading-snug">{{ item.title }}</p>
              <p v-if="item.infoLine" class="text-xs md:text-sm text-gray-400 mt-1 line-clamp-2">{{ item.infoLine }}</p>
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
      rdLoading: false
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
    async sendToRealDebrid() {
      if (!this.selectedDetail?.path) return
      this.rdLoading = true
      try {
        await this.$axios.$post(`/api/libraries/${this.libraryId}/browse/real-debrid`, {
          path: this.selectedDetail.path
        })
        this.$toast.success(this.$strings.ToastRealDebridAddSuccess)
      } catch (error) {
        console.error('Real-Debrid add failed', error)
        const msg = error.response?.data || error.message
        this.$toast.error(typeof msg === 'string' ? msg : this.$strings.ToastRealDebridSaveFailed)
      } finally {
        this.rdLoading = false
      }
    }
  }
}
</script>
