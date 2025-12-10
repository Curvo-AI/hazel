// Packages
const fetch = require('node-fetch')
const retry = require('async-retry')
const convertStream = require('stream-to-string')
const ms = require('ms')
const semver = require('semver')

// Utilities
const checkPlatform = require('./platform')

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
    this.streams = {}
    this.lastUpdate = null

    this.cacheReleaseList = this.cacheReleaseList.bind(this)
    this.refreshCache = this.refreshCache.bind(this)
    this.loadCache = this.loadCache.bind(this)
    this.isOutdated = this.isOutdated.bind(this)
  }

  parseTag(tag) {
    if (!tag || typeof tag !== 'string') {
      return null
    }

    const match = tag.match(/^v?(\d+\.\d+\.\d+)(?:-([A-Za-z0-9._-]+))?$/)

    if (!match) {
      return null
    }

    const baseVersion = match[1]
    const stream = (match[2] || 'production').toLowerCase()
    const normalisedStream = stream === 'production' ? 'production' : stream

    if (!semver.valid(baseVersion)) {
      return null
    }

    return { baseVersion, stream: normalisedStream, tag }
  }

  async fetchReleaseData(url, headers) {
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

    return response.json()
  }

  isBetterRelease(current, candidate) {
    if (!current) {
      return true
    }

    const versionCompare = semver.compare(
      candidate.parsedTag.baseVersion,
      current.parsedTag.baseVersion
    )

    if (versionCompare !== 0) {
      return versionCompare > 0
    }

    return (
      new Date(candidate.release.published_at) >
      new Date(current.release.published_at)
    )
  }

  selectLatestReleases(data) {
    const { pre } = this.config
    const selectLatestPerStream = {}

    for (const item of data) {
      const isPre = Boolean(pre) === Boolean(item.prerelease)

      if (item.draft || !isPre) {
        continue
      }

      const parsedTag = this.parseTag(item.tag_name)

      if (!parsedTag) {
        continue
      }

      const candidate = { parsedTag, release: item }
      const current = selectLatestPerStream[parsedTag.stream]

      if (this.isBetterRelease(current, candidate)) {
        selectLatestPerStream[parsedTag.stream] = candidate
      }
    }

    return selectLatestPerStream
  }

  async buildStreamsFromSelection(selection) {
    const streams = {}

    for (const stream of Object.keys(selection)) {
      const { release, parsedTag } = selection[stream]

      if (!release.assets || !Array.isArray(release.assets)) {
        continue
      }

      const streamEntry = {
        tag: parsedTag.tag,
        version: parsedTag.tag,
        baseVersion: parsedTag.baseVersion,
        stream,
        notes: release.body,
        pub_date: release.published_at,
        platforms: {},
        assets: {},
        files: {}
      }

      for (const asset of release.assets) {
        const {
          name,
          browser_download_url,
          url: apiUrl,
          content_type,
          size
        } = asset

        if (name === 'RELEASES') {
          try {
            streamEntry.files.RELEASES = await this.cacheReleaseList(
              browser_download_url,
              apiUrl
            )
            console.log(`Successfully cached RELEASES file for ${stream}`)
          } catch (err) {
            console.error(
              `Error caching RELEASES file for ${stream}:`,
              err.message
            )
            console.error('Full error:', err)
          }
          continue
        }

        streamEntry.assets[name] = {
          name,
          api_url: apiUrl,
          url: browser_download_url,
          content_type,
          size: Math.round(size / 1000000 * 10) / 10
        }

        const platform = checkPlatform(name)

        if (!platform) {
          continue
        }

        streamEntry.platforms[platform] = {
          name,
          api_url: apiUrl,
          url: browser_download_url,
          content_type,
          size: Math.round(size / 1000000 * 10) / 10
        }
      }

      streams[stream] = streamEntry
    }

    return streams
  }

  async cacheReleaseList(url, apiUrl) {
    const { token } = this.config
    const headers = { Accept: 'application/octet-stream' }

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

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

    return content
  }

  async refreshCache() {
    const { account, repository, token } = this.config
    const repo = account + '/' + repository
    const url = `https://api.github.com/repos/${repo}/releases?per_page=100`
    const headers = { Accept: 'application/vnd.github.preview' }

    if (token && typeof token === 'string' && token.length > 0) {
      headers.Authorization = `token ${token}`
    }

    const data = await this.fetchReleaseData(url, headers)

    if (!Array.isArray(data) || data.length === 0) {
      return
    }

    const selection = this.selectLatestReleases(data)
    const streams = await this.buildStreamsFromSelection(selection)

    if (Object.keys(streams).length === 0) {
      return
    }

    const defaultStreamName = streams.production
      ? 'production'
      : Object.keys(streams).sort((a, b) => {
          const compareResult = semver.compare(
            streams[b].baseVersion,
            streams[a].baseVersion
          )

          if (compareResult !== 0) {
            return compareResult
          }

          return (
            new Date(streams[b].pub_date).getTime() -
            new Date(streams[a].pub_date).getTime()
          )
        })[0]

    this.streams = streams
    this.latest = streams[defaultStreamName] || {}
    this.lastUpdate = Date.now()

    console.log(`Finished caching streams: ${Object.keys(streams).join(', ')}`)
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
    if (!this.lastUpdate || this.isOutdated()) {
      await this.refreshCache()
    }

    return Object.assign({ streams: this.streams }, this.latest)
  }
}
