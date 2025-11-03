// Native
const urlHelpers = require('url')

// Packages
const { send } = require('micro')
const { valid, compare } = require('semver')
const { parse } = require('express-useragent')
const fetch = require('node-fetch')
const distanceInWordsToNow = require('date-fns/distance_in_words_to_now')

// Utilities
const checkAlias = require('./aliases')
const prepareView = require('./view')

module.exports = ({ cache, config }) => {
  const { loadCache } = cache
  const exports = {}
  const { token, url: configUrl } = config
  const shouldProxyPrivateDownload =
    token && typeof token === 'string' && token.length > 0

  // Helper to extract stream from query params
  const getStream = req => {
    const params = urlHelpers.parse(req.url, true).query
    const stream = params.stream || 'production'
    // Basic sanitization: alphanumeric, hyphens, underscores only
    if (!/^[a-zA-Z0-9_-]+$/.test(stream)) {
      console.warn(`Invalid stream name "${stream}", defaulting to production`)
      return 'production'
    }
    return stream
  }

  // Helper to get base URL from request or config
  const getBaseUrl = req => {
    // Use config URL if provided (for Vercel or explicit URL)
    if (configUrl) {
      return configUrl
    }

    // Auto-detect from request headers (for AWS Lambda/API Gateway)
    const host = req.headers['x-forwarded-host'] || req.headers.host
    const proto = req.headers['x-forwarded-proto'] || 'https'

    if (host) {
      return `${proto}://${host}`
    }

    // Fallback
    return ''
  }

  // Helpers
  const proxyPrivateDownload = (asset, req, res) => {
    const redirect = 'manual'
    const headers = { Accept: 'application/octet-stream' }
    const options = { headers, redirect }
    const { api_url: rawUrl } = asset
    const finalUrl = rawUrl.replace(
      'https://api.github.com/',
      `https://${token}@api.github.com/`
    )

    fetch(finalUrl, options).then(assetRes => {
      res.setHeader('Location', assetRes.headers.get('Location'))
      send(res, 302)
    })
  }

  exports.download = async (req, res) => {
    const userAgent = parse(req.headers['user-agent'])
    const params = urlHelpers.parse(req.url, true).query
    const isUpdate = params && params.update
    const stream = getStream(req)

    let platform

    if (userAgent.isMac && isUpdate) {
      platform = 'darwin'
    } else if (userAgent.isMac && !isUpdate) {
      platform = 'dmg'
    } else if (userAgent.isWindows) {
      platform = 'exe'
    }

    // Get the latest version from the cache
    const { platforms } = await cache.loadCacheForStream(stream)

    if (!platform || !platforms || !platforms[platform]) {
      send(res, 404, 'No download available for your platform!')
      return
    }

    if (shouldProxyPrivateDownload) {
      proxyPrivateDownload(platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: platforms[platform].url
    })

    res.end()
  }

  exports.downloadPlatform = async (req, res) => {
    const params = urlHelpers.parse(req.url, true).query
    const isUpdate = params && params.update
    const stream = getStream(req)

    let { platform } = req.params

    if (platform === 'mac' && !isUpdate) {
      platform = 'dmg'
    }

    if (platform === 'mac_arm64' && !isUpdate) {
      platform = 'dmg_arm64'
    }

    // Get the latest version from the cache
    const latest = await cache.loadCacheForStream(stream)

    // Check platform for appropiate aliases
    platform = checkAlias(platform)

    if (!platform) {
      send(res, 500, 'The specified platform is not valid')
      return
    }

    if (!latest.platforms || !latest.platforms[platform]) {
      send(res, 404, 'No download available for your platform')
      return
    }

    if (token && typeof token === 'string' && token.length > 0) {
      proxyPrivateDownload(latest.platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: latest.platforms[platform].url
    })

    res.end()
  }

  exports.downloadFile = async (req, res) => {
    const { filename } = req.params
    const stream = getStream(req)

    // Get the latest version from the cache
    const latest = await cache.loadCacheForStream(stream)

    if (!latest.version) {
      send(res, 404, 'No release available')
      return
    }

    // Find the asset by exact filename
    const asset = latest.assets && latest.assets[filename]

    if (!asset) {
      send(res, 404, 'File not found in latest release')
      return
    }

    if (shouldProxyPrivateDownload) {
      proxyPrivateDownload(asset, req, res)
      return
    }

    res.writeHead(302, {
      Location: asset.url
    })

    res.end()
  }

  exports.update = async (req, res) => {
    const { platform: platformName, version } = req.params
    const stream = getStream(req)

    if (!valid(version)) {
      send(res, 500, {
        error: 'version_invalid',
        message: 'The specified version is not SemVer-compatible'
      })

      return
    }

    const platform = checkAlias(platformName)

    if (!platform) {
      send(res, 500, {
        error: 'invalid_platform',
        message: 'The specified platform is not valid'
      })

      return
    }

    // Get the latest version from the cache
    const latest = await cache.loadCacheForStream(stream)

    if (!latest.platforms || !latest.platforms[platform]) {
      res.statusCode = 204
      res.end()

      return
    }

    // Previously, we were checking if the latest version is
    // greater than the one on the client. However, we
    // only need to compare if they're different (even if
    // lower) in order to trigger an update.

    // This allows developers to downgrade their users
    // to a lower version in the case that a major bug happens
    // that will take a long time to fix and release
    // a patch update.

    if (compare(latest.version, version) !== 0) {
      const { notes, pub_date } = latest

      send(res, 200, {
        name: latest.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `${getBaseUrl(req)}/download/${platformName}?update=true&stream=${stream}`
          : latest.platforms[platform].url
      })

      return
    }

    res.statusCode = 204
    res.end()
  }

  exports.releases = async (req, res) => {
    const stream = getStream(req)
    
    // Get the latest version from the cache
    const latest = await cache.loadCacheForStream(stream)

    if (!latest.files || !latest.files.RELEASES) {
      res.statusCode = 204
      res.end()

      return
    }

    let content = latest.files.RELEASES

    // For private repos with token, proxy .nupkg downloads through Hazel
    if (shouldProxyPrivateDownload) {
      const baseUrl = getBaseUrl(req)
      // Replace .nupkg filenames with proxied URLs
      content = content.replace(/([^\s]+\.nupkg)/gi, match => {
        return `${baseUrl}/download/file/${match}?stream=${stream}`
      })
    } else {
      // For public repos, replace with direct GitHub URLs
      const matches = content.match(/([^\s]+\.nupkg)/gi)
      if (matches) {
        for (const filename of matches) {
          const downloadUrl = `https://github.com/${config.account}/${
            config.repository
          }/releases/download/${latest.version}/${filename}`
          content = content.replace(filename, downloadUrl)
        }
      }
    }

    res.writeHead(200, {
      'content-length': Buffer.byteLength(content, 'utf8'),
      'content-type': 'application/octet-stream'
    })

    res.end(content)
  }

  exports.overview = async (req, res) => {
    const stream = getStream(req)
    const latest = await cache.loadCacheForStream(stream)
    const availableStreams = Object.keys(cache.latestByStream).sort()

    try {
      const render = await prepareView()

      const details = {
        account: config.account,
        repository: config.repository,
        date: distanceInWordsToNow(latest.pub_date, { addSuffix: true }),
        files: latest.platforms,
        version: latest.version,
        releaseNotes: `https://github.com/${config.account}/${
          config.repository
        }/releases/tag/${latest.version}`,
        allReleases: `https://github.com/${config.account}/${
          config.repository
        }/releases`,
        github: `https://github.com/${config.account}/${config.repository}`,
        currentStream: stream,
        availableStreams
      }

      send(res, 200, render(details))
    } catch (err) {
      console.error(err)
      send(res, 500, 'Error reading overview file')
    }
  }

  return exports
}
