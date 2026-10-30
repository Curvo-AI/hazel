// Packages
const { send } = require('micro')
const { valid, compare, parse: parseVersion } = require('semver')
const { useragent } = require('express-useragent')
const ms = require('ms')
const distanceInWordsToNow = require('date-fns/distance_in_words_to_now')

// Utilities
const checkAlias = require('./aliases')
const { resolveStream, validateStream } = require('./streams')
const prepareView = require('./view')

module.exports = ({ cache, config }) => {
  const exports = {}
  const { token, url: configUrl } = config
  const shouldProxyPrivateDownload =
    token && typeof token === 'string' && token.length > 0
  const productionStream = 'production'

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
  const getQuery = req => {
    const query = {}
    const params = new URL(req.url, 'https://hazel.local').searchParams

    for (const key of params.keys()) {
      const values = params.getAll(key)
      query[key] = values.length > 1 ? values : values[0]
    }

    return query
  }

  const getQueryStream = req => {
    const query = getQuery(req)

    if (!Object.prototype.hasOwnProperty.call(query, 'stream')) {
      return
    }

    return query.stream
  }

  const sendInvalidStreamError = res => {
    send(res, 400, {
      error: 'stream_invalid',
      message: 'The specified stream is not valid'
    })
  }

  const getRequestStream = (req, version) => {
    const queryStream = getQueryStream(req)

    if (queryStream !== undefined && !validateStream(queryStream)) {
      return {
        error: 'stream_invalid'
      }
    }

    return {
      value: resolveStream({ queryStream, version })
    }
  }

  const getStreamQuerySuffix = stream => {
    if (stream.value === productionStream) {
      return ''
    }

    return `stream=${encodeURIComponent(stream.value)}`
  }

  const appendStreamQuery = (path, stream) => {
    const suffix = getStreamQuerySuffix(stream)

    if (!suffix) {
      return path
    }

    return `${path}${path.includes('?') ? '&' : '?'}${suffix}`
  }

  const getComparableVersion = version => {
    const parsed = parseVersion(version)

    if (!parsed) {
      return version
    }

    return `${parsed.major}.${parsed.minor}.${parsed.patch}`
  }

  const loadCacheForRequest = async (req, res, version) => {
    const stream = getRequestStream(req, version)

    if (stream.error) {
      sendInvalidStreamError(res)
      return {}
    }

    return {
      latest: await cache.loadCacheForStream(stream.value),
      stream
    }
  }

  // GitHub answers private asset requests with a redirect to a signed URL
  const proxyPrivateDownload = async (asset, req, res) => {
    let location = null

    try {
      const assetRes = await fetch(asset.api_url, {
        headers: {
          Accept: 'application/octet-stream',
          Authorization: `token ${token}`
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(ms('5s'))
      })

      location = assetRes.headers.get('Location')

      if (!location) {
        console.error(
          `GitHub responded with ${assetRes.status} for asset ${asset.api_url}`
        )
      }
    } catch (error) {
      console.error(`Fetching asset ${asset.api_url} failed:`, error)
    }

    if (!location) {
      send(res, 502, 'Could not get a download link from GitHub')
      return
    }

    res.setHeader('Location', location)
    send(res, 302)
  }

  exports.download = async (req, res) => {
    const userAgent = useragent.parse(req.headers['user-agent'])
    const params = getQuery(req)
    const isUpdate = params && params.update

    let platform

    if (userAgent.isMac && isUpdate) {
      platform = 'darwin'
    } else if (userAgent.isMac && !isUpdate) {
      platform = 'dmg'
    } else if (userAgent.isWindows) {
      platform = 'exe'
    }

    // Get the latest version from the cache
    const { latest } = await loadCacheForRequest(req, res)

    if (!latest) {
      return
    }

    const { platforms } = latest

    if (!platform || !platforms || !platforms[platform]) {
      send(res, 404, 'No download available for your platform!')
      return
    }

    if (shouldProxyPrivateDownload) {
      await proxyPrivateDownload(platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: platforms[platform].url
    })

    res.end()
  }

  exports.downloadPlatform = async (req, res) => {
    const params = getQuery(req)
    const isUpdate = params && params.update

    let { platform } = req.params

    if (platform === 'mac' && !isUpdate) {
      platform = 'dmg'
    }

    if (platform === 'mac_arm64' && !isUpdate) {
      platform = 'dmg_arm64'
    }

    // Get the latest version from the cache
    const { latest } = await loadCacheForRequest(req, res)

    if (!latest) {
      return
    }

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
      await proxyPrivateDownload(latest.platforms[platform], req, res)
      return
    }

    res.writeHead(302, {
      Location: latest.platforms[platform].url
    })

    res.end()
  }

  exports.downloadFile = async (req, res) => {
    const { filename } = req.params

    // Get the latest version from the cache
    const { latest } = await loadCacheForRequest(req, res)

    if (!latest) {
      return
    }

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
      await proxyPrivateDownload(asset, req, res)
      return
    }

    res.writeHead(302, {
      Location: asset.url
    })

    res.end()
  }

  exports.update = async (req, res) => {
    const { platform: platformName, version } = req.params

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
    const { latest, stream } = await loadCacheForRequest(req, res, version)

    if (!latest) {
      return
    }

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

    if (
      compare(
        getComparableVersion(latest.version),
        getComparableVersion(version)
      ) !== 0
    ) {
      const { notes, pub_date } = latest

      send(res, 200, {
        name: latest.version,
        notes,
        pub_date,
        url: shouldProxyPrivateDownload
          ? `${getBaseUrl(req)}${appendStreamQuery(
              `/download/${platformName}?update=true`,
              stream
            )}`
          : latest.platforms[platform].url
      })

      return
    }

    res.statusCode = 204
    res.end()
  }

  exports.releases = async (req, res) => {
    // Get the latest version from the cache
    const { latest, stream } = await loadCacheForRequest(
      req,
      res,
      req.params.version
    )

    if (!latest) {
      return
    }

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
        return `${baseUrl}${appendStreamQuery(
          `/download/file/${match}`,
          stream
        )}`
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
    const latest = await cache.loadCacheForStream(productionStream)

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
        github: `https://github.com/${config.account}/${config.repository}`
      }

      send(res, 200, render(details))
    } catch (err) {
      console.error(err)
      send(res, 500, 'Error reading overview file')
    }
  }

  return exports
}
