// Packages
const retry = require('async-retry')
const ms = require('ms')

// Utilities
const checkPlatform = require('./platform')
const { parseStreamFromTag } = require('./streams')

// Keeps a slow GitHub from holding requests past the Lambda timeout
const requestTimeout = ms('5s')
const retryOptions = { retries: 2, minTimeout: 500 }

// Retries network errors and 5xx responses. A 4xx (bad token, rate limit)
// won't recover within the request, so it fails straight away.
const fetchWithRetry = (url, headers, description) =>
  retry(async bail => {
    const response = await fetch(url, {
      headers,
      signal: AbortSignal.timeout(requestTimeout)
    })

    if (response.status === 200) {
      return response
    }

    const error = new Error(
      `${description} responded with ${response.status} for url ${url}`
    )

    if (response.status < 500) {
      return bail(error)
    }

    throw error
  }, retryOptions)

module.exports = class Cache {
  constructor(config) {
    const { account, repository, token, url } = config
    this.config = config

    if (!account || !repository) {
      const error = new Error('Neither ACCOUNT, nor REPOSITORY are defined')
      error.code = 'missing_configuration_properties'
      throw error
    }

    // URL is optional - it will be auto-detected from request headers in routes.js
    // Only warn if token is set but URL is not
    if (token && !url) {
      console.warn(
        'TOKEN is set but URL is not defined. Private downloads will use auto-detected URL from request headers.'
      )
    }

    this.latest = {}
    this.latestByStream = {}
    this.lastUpdate = null
    this.refreshing = null

    this.cacheReleaseList = this.cacheReleaseList.bind(this)
    this.cacheRelease = this.cacheRelease.bind(this)
    this.refreshCache = this.refreshCache.bind(this)
    this.loadCache = this.loadCache.bind(this)
    this.loadCacheForStream = this.loadCacheForStream.bind(this)
    this.isOutdated = this.isOutdated.bind(this)
  }

  async cacheReleaseList(url, apiUrl) {
    const { token } = this.config
    const headers = { Accept: 'application/octet-stream' }

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    // Use API URL for private repos with token, browser_download_url for public
    const fetchUrl = token && apiUrl ? apiUrl : url

    const response = await fetchWithRetry(fetchUrl, headers, 'RELEASES')
    // Not response.text(): it drops the BOM that Squirrel writes at the start
    const content = Buffer.from(await response.arrayBuffer()).toString()
    const matches = content.match(/[^ ]*\.nupkg/gim)

    if (!matches || matches.length === 0) {
      throw new Error(
        `Tried to cache RELEASES, but failed. RELEASES content doesn't contain nupkg. Content: ${content}`
      )
    }

    // Don't replace URLs here - keep the original filenames
    // URL replacement will happen in routes.js based on whether we need to proxy
    return content
  }

  async refreshCache() {
    const { account, repository, pre, token } = this.config
    const repo = account + '/' + repository
    const headers = { Accept: 'application/vnd.github.preview' }
    const releases = []
    const perPage = 100
    let page = 1
    let shouldFetch = true

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    while (shouldFetch) {
      const url = `https://api.github.com/repos/${repo}/releases?per_page=${perPage}&page=${page}`
      const response = await fetchWithRetry(url, headers, 'GitHub API')
      const data = await response.json()

      if (!Array.isArray(data) || data.length === 0) {
        shouldFetch = false
      } else {
        releases.push(...data)
        shouldFetch = data.length === perPage
        page++
      }
    }

    if (releases.length === 0) {
      this.latestByStream = {}
      this.latest = {}
      this.lastUpdate = Date.now()
      return
    }

    const latestReleasesByStream = {}

    for (const release of releases) {
      const isPre = Boolean(pre) === Boolean(release.prerelease)

      if (release.draft || !isPre) {
        continue
      }

      if (!release.assets || !Array.isArray(release.assets)) {
        continue
      }

      const stream = parseStreamFromTag(release.tag_name)

      if (!stream) {
        console.warn(`Skipping release ${release.tag_name}: invalid stream tag`)
        continue
      }

      if (latestReleasesByStream[stream]) {
        continue
      }

      latestReleasesByStream[stream] = release
    }

    const latestByStream = {}

    for (const stream of Object.keys(latestReleasesByStream)) {
      latestByStream[stream] = await this.cacheRelease(
        stream,
        latestReleasesByStream[stream]
      )
    }

    this.latestByStream = latestByStream
    this.latest = this.latestByStream.production || {}
    this.lastUpdate = Date.now()
  }

  async cacheRelease(stream, release) {
    const { tag_name } = release
    const latest = {
      version: tag_name,
      notes: release.body,
      pub_date: release.published_at,
      platforms: {},
      assets: {}
    }

    console.log(`Caching ${stream} version ${tag_name}...`)

    for (const asset of release.assets) {
      const { name, browser_download_url, url, content_type, size } = asset

      if (name === 'RELEASES') {
        try {
          if (!latest.files) {
            latest.files = {}
          }

          latest.files.RELEASES = await this.cacheReleaseList(
            browser_download_url,
            url
          )
          console.log('Successfully cached RELEASES file')
        } catch (err) {
          console.error('Error caching RELEASES file:', err.message)
          console.error('Full error:', err)
        }

        continue
      }

      // Store all assets by filename for direct access
      latest.assets[name] = {
        name,
        api_url: url,
        url: browser_download_url,
        content_type,
        size: Math.round(size / 1000000 * 10) / 10
      }

      const platform = checkPlatform(name)

      if (!platform) {
        continue
      }

      latest.platforms[platform] = {
        name,
        api_url: url,
        url: browser_download_url,
        content_type,
        size: Math.round(size / 1000000 * 10) / 10
      }
    }

    console.log(`Finished caching ${stream} version ${tag_name}`)

    return latest
  }

  isOutdated() {
    const { lastUpdate, config } = this
    const { interval = 15 } = config

    if (lastUpdate && Date.now() - lastUpdate > ms(`${interval}m`)) {
      return true
    }

    return false
  }

  // This is a method returning the cache
  // because the cache would otherwise be loaded
  // only once when the index file is parsed
  async loadCache() {
    return this.loadCacheForStream('production')
  }

  async loadCacheForStream(stream = 'production') {
    if (!this.lastUpdate || this.isOutdated()) {
      await this.refresh()
    }

    return Object.assign({}, this.latestByStream[stream] || {})
  }

  // Concurrent callers share one in-flight refresh. If a refresh fails while
  // older data exists, keep serving it and wait a full interval to retry.
  refresh() {
    if (!this.refreshing) {
      this.refreshing = this.refreshCache()
        .catch(error => {
          if (!this.lastUpdate) {
            throw error
          }

          console.error('Cache refresh failed, serving stale data:', error)
          this.lastUpdate = Date.now()
        })
        .finally(() => {
          this.refreshing = null
        })
    }

    return this.refreshing
  }
}
