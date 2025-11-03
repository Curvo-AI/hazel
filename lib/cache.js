// Packages
const fetch = require('node-fetch')
const retry = require('async-retry')
const convertStream = require('stream-to-string')
const ms = require('ms')

// Utilities
const checkPlatform = require('./platform')

// Parse stream from tag name (e.g., "v1.0.0-uat" -> "uat")
function parseStream(tagName) {
  const parts = tagName.split('-')
  if (parts.length === 1) return 'production'
  return parts.slice(1).join('-')
}

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

    this.cacheReleaseList = this.cacheReleaseList.bind(this)
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

    const { body } = await retry(
      async () => {
        const response = await fetch(fetchUrl, { headers })

        if (response.status !== 200) {
          throw new Error(
            `Tried to cache RELEASES, but failed fetching ${fetchUrl}, status ${
              response.status
            }`
          )
        }

        return response
      },
      { retries: 3 }
    )

    const content = await convertStream(body)
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

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    // Fetch all releases with pagination to ensure we don't miss old stream releases
    let allReleases = []
    let page = 1
    const perPage = 100

    while (true) {
      const url = `https://api.github.com/repos/${repo}/releases?per_page=${perPage}&page=${page}`
      
      const response = await retry(
        async () => {
          const response = await fetch(url, { headers })

          if (response.status !== 200) {
            throw new Error(
              `GitHub API responded with ${response.status} for url ${url}`
            )
          }

          return response
        },
        { retries: 3 }
      )

      const data = await response.json()

      if (!Array.isArray(data) || data.length === 0) {
        break
      }

      allReleases = allReleases.concat(data)

      // If we got less than perPage results, we've reached the end
      if (data.length < perPage) {
        break
      }

      page++
    }

    if (allReleases.length === 0) {
      return
    }

    const data = allReleases

    // Group releases by stream, keeping only the latest for each
    const releasesByStream = {}
    
    for (const release of data) {
      if (release.draft) continue
      
      const stream = parseStream(release.tag_name)
      const isPre = Boolean(pre) === Boolean(release.prerelease)
      
      if (!isPre) continue
      
      // Keep only the latest for each stream (first occurrence due to API ordering)
      if (!releasesByStream[stream]) {
        releasesByStream[stream] = release
      }
    }

    // Cache each stream's release
    for (const [stream, release] of Object.entries(releasesByStream)) {
      await this.cacheRelease(stream, release)
    }

    // Maintain backward compatibility: set this.latest to production stream
    this.latest = this.latestByStream.production || {}
    
    console.log(`Cached ${Object.keys(releasesByStream).length} stream(s): ${Object.keys(releasesByStream).join(', ')}`)
    this.lastUpdate = Date.now()
  }

  async cacheRelease(stream, release) {
    const { tag_name } = release

    if (this.latestByStream[stream] && this.latestByStream[stream].version === tag_name) {
      console.log(`Cached version for ${stream} stream is the same as latest`)
      return
    }

    console.log(`Caching ${stream} stream version ${tag_name}...`)

    const streamCache = {
      version: tag_name,
      notes: release.body,
      pub_date: release.published_at,
      platforms: {},
      assets: {},
      files: {}
    }

    if (!release.assets || !Array.isArray(release.assets)) {
      this.latestByStream[stream] = streamCache
      return
    }

    for (const asset of release.assets) {
      const { name, browser_download_url, url, content_type, size } = asset

      if (name === 'RELEASES') {
        try {
          streamCache.files.RELEASES = await this.cacheReleaseList(
            browser_download_url,
            url
          )
          console.log(`Successfully cached RELEASES file for ${stream} stream`)
        } catch (err) {
          console.error(`Error caching RELEASES file for ${stream} stream:`, err.message)
        }
        continue
      }

      // Store all assets by filename for direct access
      streamCache.assets[name] = {
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

      streamCache.platforms[platform] = {
        name,
        api_url: url,
        url: browser_download_url,
        content_type,
        size: Math.round(size / 1000000 * 10) / 10
      }
    }

    this.latestByStream[stream] = streamCache
    console.log(`Finished caching ${stream} stream version ${tag_name}`)
  }

  isOutdated() {
    const { lastUpdate, config } = this
    const { interval = 15 } = config

    if (lastUpdate && Date.now() - lastUpdate > ms(`${interval}m`)) {
      return true
    }

    return false
  }

  // Backward compatibility: load cache without specifying stream
  async loadCache() {
    return this.loadCacheForStream('production')
  }

  // Load cache for a specific stream
  async loadCacheForStream(stream = 'production') {
    const { latestByStream, refreshCache, isOutdated, lastUpdate } = this

    if (!lastUpdate || isOutdated()) {
      await refreshCache()
    }

    return Object.assign({}, latestByStream[stream] || {})
  }
}
